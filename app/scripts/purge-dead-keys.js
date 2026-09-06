#!/usr/bin/env node
'use strict';
/**
 * purge-dead-keys.js —— 探测并删除 config.json 中已失效（401/403 鉴权失败）的 API key
 *
 * 用法：
 *   node scripts/purge-dead-keys.js            # 探测 + 删除已失效 key（写回前自动备份）
 *   node scripts/purge-dead-keys.js --dry-run  # 仅预览，不写盘
 *
 * 判定口径（保守，避免误删好 key）：
 *   · 2xx                       → 有效，保留
 *   · 401 / 403                 → 鉴权失败（已失效）→ 删除
 *   · 402 / 429                 → 额度/限流耗尽（key 本身没坏）→ 保留，仅警告
 *   · 网络错误 / 超时 / 其他     → 无法验证 → 保留，仅警告
 *
 * 说明：
 *   · 直接复用 server.js 的 SECRET_PATHS / extractSecrets / applySecrets / loadConfig / saveConfig
 *     逻辑 + lib/secret.js，因此「明文」与「已加密（secrets 包）」两种 config 都能正确读写。
 *   · 写盘前会把原 config.json 备份为 config.json.bak-<时间戳>。
 *   · 假设：搜索源 / LLM 密钥统一存放在 data/config.json（与 server.js 一致）。
 *   · 建议运行前先停掉 3300 服务，避免服务端 saveConfig 覆盖本次改动。
 */

const fs = require('fs');
const path = require('path');
const secret = require('../lib/secret.js');

const ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'data', 'config.json');
const PROBE_TIMEOUT_MS = 12000;
const DRY_RUN = process.argv.includes('--dry-run');
const AGGRESSIVE = process.argv.includes('--aggressive'); // 额外把 HTTP 400 也视为失效（默认仅 401/403）

// ---------- 复刻 server.js 的密钥加密逻辑（P0-4.1） ----------
const SECRET_PATHS = [
  ['search', 'serperKey'], ['search', 'serperKeys'], ['search', 'apiKey'],
  ['search', 'tavilyKey'], ['search', 'braveKey'], ['search', 'bochaKey'],
  ['llm', 'apiKey'],
];
function extractSecrets(cfg) {
  const sec = { search: {}, llm: {} };
  let any = false;
  for (const [s, key] of SECRET_PATHS) {
    if (cfg[s] && cfg[s][key] !== undefined && cfg[s][key] !== '') { sec[s][key] = cfg[s][key]; any = true; }
  }
  return any ? sec : null;
}
function applySecrets(cfg, sec) {
  if (!sec) return;
  for (const [s, key] of SECRET_PATHS) {
    if (sec[s] && sec[s][key] !== undefined) { cfg[s] = cfg[s] || {}; cfg[s][key] = sec[s][key]; }
  }
}
function loadConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { throw new Error('读取 config.json 失败：' + e.message); }
  if (raw && raw.secrets) {
    try { applySecrets(raw, secret.decrypt(raw.secrets)); delete raw.secrets; }
    catch (e) { throw new Error('解密密钥失败（MT_MASTER_KEY 未设置或不符）：' + e.message); }
  }
  return raw;
}
function saveConfig(next) {
  const out = JSON.parse(JSON.stringify(next));
  const sec = extractSecrets(out);
  let encrypted = false;
  if (sec) {
    const bundle = secret.encrypt(sec);
    if (bundle) {
      out.secrets = bundle;
      encrypted = true;
      for (const [s, key] of SECRET_PATHS) { if (out[s]) delete out[s][key]; } // 明文层移除密钥
    }
  }
  if (!encrypted) console.error('[warn] MT_MASTER_KEY 未设置，密钥将以明文写回 config.json。');
  out._secretsEncrypted = encrypted;
  // 原子写：临时文件 + rename，避免半截文件
  const tmp = CONFIG_PATH + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
  return out;
}

// ---------- 探针 ----------
function classify(status) {
  if (status >= 200 && status < 300) return 'valid';
  const invalidCodes = AGGRESSIVE ? [401, 403, 400] : [401, 403]; // 默认仅鉴权失败=失效；--aggressive 额外含 400
  if (invalidCodes.includes(status)) return 'invalid';   // 鉴权失败 = 已失效
  if (status === 402 || status === 429) return 'exhausted'; // 额度/限流 = key 没坏
  return 'other';
}
async function probe(label, fn) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fn(ctrl.signal);
    return { status: r.status, cls: classify(r.status) };
  } catch (e) {
    const kind = (e && e.name === 'AbortError') ? 'timeout' : String((e && e.message) || e);
    return { status: 0, cls: 'other', err: kind };
  } finally { clearTimeout(t); }
}

const tinyMsg = [{ role: 'user', content: 'ping' }];
async function probeDeepSeek(key, model) {
  return probe('deepseek', (signal) => fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: model || 'deepseek-v4-flash', messages: tinyMsg, max_tokens: 1 }),
    signal,
  }));
}
async function probeSerper(key) {
  return probe('serper', (signal) => fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    // 与 server.js serperSearch 真实请求体对齐，排除「请求形状不对导致 400」的伪阳性
    body: JSON.stringify({ q: 'test', num: 10, gl: 'us', hl: 'en' }),
    signal,
  }));
}
async function probeTavily(key) {
  return probe('tavily', (signal) => fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query: 'test', max_results: 1 }),
    signal,
  }));
}
async function probeBrave(key) {
  return probe('brave', (signal) => fetch('https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent('test') + '&count=1', {
    headers: { 'Accept': 'application/json', 'X-Subscription-Token': key },
    signal,
  }));
}
async function probeBocha(key) {
  return probe('bocha', (signal) => fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ query: 'test', count: 1 }),
    signal,
  }));
}

function mask(k) { return k.length > 8 ? k.slice(0, 4) + '…' + k.slice(-4) : k; }

// ---------- 主流程 ----------
(async () => {
  console.log('读取配置：' + CONFIG_PATH);
  const cfg = loadConfig();
  if (!cfg) { console.error('config.json 不存在或为空，退出。'); process.exit(1); }
  if (!cfg.search) cfg.search = {};
  if (!cfg.llm) cfg.llm = {};

  // 收集非空候选 key
  const candidates = [];
  if (cfg.llm.apiKey) candidates.push({ group: 'llm', field: 'apiKey', key: cfg.llm.apiKey, provider: 'deepseek', probe: (k) => probeDeepSeek(k, cfg.llm.model) });

  const serperSingles = [];
  if (cfg.search.serperKey) serperSingles.push(cfg.search.serperKey);
  if (Array.isArray(cfg.search.serperKeys)) serperSingles.push(...cfg.search.serperKeys);
  const serperUnique = [...new Set(serperSingles.map((k) => (k || '').trim()).filter(Boolean))];
  for (const k of serperUnique) candidates.push({ group: 'search', field: 'serperKeys[]', key: k, provider: 'serper', probe: probeSerper });

  if (cfg.search.tavilyKey) candidates.push({ group: 'search', field: 'tavilyKey', key: cfg.search.tavilyKey, provider: 'tavily', probe: probeTavily });
  if (cfg.search.braveKey) candidates.push({ group: 'search', field: 'braveKey', key: cfg.search.braveKey, provider: 'brave', probe: probeBrave });
  if (cfg.search.bochaKey) candidates.push({ group: 'search', field: 'bochaKey', key: cfg.search.bochaKey, provider: 'bocha', probe: probeBocha });

  if (!candidates.length) { console.log('没有配置任何非空 key，无需处理。'); return; }

  console.log(`开始探测 ${candidates.length} 个 key（超时 ${PROBE_TIMEOUT_MS}ms）...\n`);

  const toDelete = [];
  for (const c of candidates) {
    const res = await c.probe(c.key);
    let line = `[${c.provider}] ${mask(c.key)} → `;
    if (res.cls === 'valid') line += '有效 ✓';
    else if (res.cls === 'invalid') { line += `失效(HTTP ${res.status}) ✗ 将删除`; toDelete.push(c); }
    else if (res.cls === 'exhausted') line += `额度耗尽(HTTP ${res.status}) · 保留(警告)`;
    else line += `无法验证(${res.err || ('HTTP ' + res.status)}) · 保留(警告)`;
    console.log(line);
  }

  console.log('');
  if (!toDelete.length) { console.log('未发现已失效 key，config 不变。'); return; }

  const cfgNext = JSON.parse(JSON.stringify(cfg));
  for (const d of toDelete) {
    if (d.group === 'llm' && d.field === 'apiKey') {
      cfgNext.llm.apiKey = '';
    } else if (d.field === 'serperKeys[]') {
      const k = (d.key || '').trim();
      if (cfgNext.search.serperKey && cfgNext.search.serperKey.trim() === k) cfgNext.search.serperKey = '';
      if (Array.isArray(cfgNext.search.serperKeys)) {
        cfgNext.search.serperKeys = cfgNext.search.serperKeys.filter((x) => (x || '').trim() !== k);
      }
    } else {
      cfgNext.search[d.field] = '';
    }
  }

  console.log('将删除以下已失效 key：');
  for (const d of toDelete) console.log(`  · ${d.provider}: ${mask(d.key)} (${d.field})`);

  if (DRY_RUN) {
    console.log('\n[dry-run] 未写盘。去掉 --dry-run 重新运行以真正删除。');
    return;
  }

  const bak = CONFIG_PATH + '.bak-' + Date.now();
  fs.copyFileSync(CONFIG_PATH, bak);
  console.log('\n已备份原配置 → ' + bak);

  saveConfig(cfgNext);
  console.log('已写回 config.json（已删除 ' + toDelete.length + ' 个失效 key）。');

  if (cfgNext.search.provider === 'serper') {
    const remaining = [...new Set([cfgNext.search.serperKey, ...(Array.isArray(cfgNext.search.serperKeys) ? cfgNext.search.serperKeys : [])].map((k) => (k || '').trim()).filter(Boolean))];
    if (!remaining.length) console.log('[warn] serper provider 下已无任何可用 key，发现功能将因 NO_SERPER_KEY 失败，请补充有效 key。');
  }
  console.log('\n提示：运行前建议先停掉 3300 服务，改完重启生效。');
})().catch((e) => { console.error('执行失败：' + (e && e.message)); process.exit(1); });
