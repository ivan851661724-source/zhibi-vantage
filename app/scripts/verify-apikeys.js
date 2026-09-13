'use strict';
// =============================================================================
// verify-apikeys.js —— 平台外部密钥直连实测（零 LLM 参与）
//
// 原则：密钥有效性只能用「对供应商的真实 HTTP 调用」验证——拿去问大模型/肉眼
// 看格式都不算数（不准）。本脚本与运行时走完全相同的取 key 口径：
//   · Serper ← config.search.serperKeys（settings 页配置，支持多 key 池）
//   · LLM    ← config.llm.apiKey 优先，回落环境变量 LLM_API_KEY；
//              接入点 config.llm.baseUrl（自定义）优先，回落 LLM_BASE_URL，再回落内置 DeepSeek
// 实测项：
//   1) Serper：真实搜索一次（POST /search）。2xx=有效（展示首条结果证明真返回）；
//      401/403=key 失效；402/429=额度耗尽/限流；5xx=服务端错误（不作为 key 失效证据）。
//   2) LLM：GET /models（零 token 消耗）；网关不支持该端点时回退 1-token chat 探测。
// 用法：node scripts/verify-apikeys.js    退出码 0=全绿 / 1=有红
// 注意：每次运行消耗 1 次 Serper 额度（会经 serper-budget 记账吗？——不会，
// 本脚本直连验证、绕过预算记账层，避免「验证本身吃掉正式额度」的计数污染）。
// =============================================================================
const Gateway = require('../services/llm-gateway.js');
const { normalizeSerperKeys } = require('../services/providers/search.js');
const { llmApiKey, resolveBaseUrl, resolveModel } = require('../research/llm.js');
const Config = require('../core/config.js');
const fs = require('fs');
const path = require('path');

// 与部署链路对齐：容器内 env 由 docker compose 注入（读仓库根 .env）；本机直跑没有这一步，这里补齐。
// 只补缺，不覆盖真实环境变量。
function loadDotEnv() {
  try {
    for (const ln of String(fs.readFileSync(path.join(__dirname, '..', '..', '.env'), 'utf8')).split(/\r?\n/)) {
      const m = ln.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] !== '' && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 无 .env 即跳过（容器内场景） */ }
}
loadDotEnv();

function mask(k) { return String(k || '').slice(0, 8) + '…' + String(k || '').slice(-4); }
function line(ok, name, detail) { console.log((ok ? 'PASS' : 'FAIL') + ' - ' + name + (detail ? ' :: ' + detail : '')); return ok; }

// Serper：真实搜索一次（与 providers/search.js serperSearch 同参）
async function verifySerper(key) {
  const t0 = Date.now();
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: 'zhibi vantage apikey check', num: 3, gl: 'us', hl: 'en' }),
    signal: AbortSignal.timeout(15000)
  });
  const ms = Date.now() - t0;
  if (r.ok) {
    const j = await r.json();
    const organic = Array.isArray(j.organic) ? j.organic : [];
    const first = organic[0] || {};
    return { ok: true, detail: `HTTP ${r.status} · ${ms}ms · 返回 ${organic.length} 条 · 首条「${String(first.title || '(空)').slice(0, 50)}」` };
  }
  const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 100);
  const verdict = (r.status === 402 || r.status === 429) ? '额度耗尽/限流'
    : (r.status === 401 || r.status === 403) ? 'key 无效'
    : '服务端错误（不能证明 key 无效，稍后复测）';
  return { ok: false, detail: `HTTP ${r.status} · ${ms}ms · ${verdict} · ${body}` };
}

// LLM：GET /models（零 token）；404/405 → 回退 1-token chat 探测
// 接入点解析与 rawCall 同口径：baseUrl 入参为空 → env LLM_BASE_URL → 内置 DeepSeek 默认
// （Gateway.DEFAULT_BASE_URL 未导出，这里按同规则现算）。
const BUILTIN_BASE = 'https://api.deepseek.com/v1/chat/completions';
async function verifyLLM(key, baseUrl, model) {
  const base = (Gateway.normalizeBaseUrl(baseUrl || '') || Gateway.normalizeBaseUrl(process.env.LLM_BASE_URL || '') || BUILTIN_BASE).replace(/\/chat\/completions$/, '');
  const t0 = Date.now();
  const r = await fetch(base + '/models', {
    headers: { Authorization: 'Bearer ' + key },
    signal: AbortSignal.timeout(15000)
  });
  const ms = Date.now() - t0;
  if (r.ok) {
    const j = await r.json().catch(() => ({}));
    const ids = (Array.isArray(j.data) ? j.data : []).map(x => x.id);
    const hit = ids.includes(model);
    return { ok: true, detail: `HTTP ${r.status} · ${ms}ms · 实际接入点 ${base} · ${ids.length} 个模型${hit ? ` · 目标模型 ${model} 在列` : ` · ⚠ 目标模型 ${model} 不在列表（首用时报错为准）`}` };
  }
  if (r.status === 404 || r.status === 405) {
    // 网关无 /models 端点 → 1-token 真实对话探测（最小成本拿确定结论）
    const t1 = Date.now();
    const c = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(20000)
    });
    const ms1 = Date.now() - t1;
    const body = (await c.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
    return { ok: c.ok, detail: `/models HTTP ${r.status} → 1-token 探测 HTTP ${c.status} · ${ms1}ms · ${c.ok ? '对话通' : body}` };
  }
  const body = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 120);
  const verdict = (r.status === 401 || r.status === 403) ? 'key 无效或无权限' : '服务端/网关错误（不能证明 key 无效）';
  return { ok: false, detail: `HTTP ${r.status} · ${ms}ms · ${verdict} · ${body}` };
}

(async () => {
  const config = Config.loadConfig();
  let fails = 0;

  console.log('=== Serper 搜索 key（真实搜索 × 每把 key） ===');
  const keys = normalizeSerperKeys(config && config.search);
  if (!keys.length) { fails += !line(false, 'serper', 'config.json 未配置任何 serper key'); }
  for (const k of keys) {
    try {
      const v = await verifySerper(k);
      fails += !line(v.ok, 'serper ' + mask(k), v.detail);
    } catch (e) {
      fails += !line(false, 'serper ' + mask(k), '网络层失败: ' + String(e && e.message || e).slice(0, 100));
    }
  }

  console.log('\n=== LLM key（GET /models，零 token；不支持则 1-token 探测） ===');
  const cfgKey = llmApiKey(config);
  if (!cfgKey) {
    fails += !line(false, 'llm', 'config.json 与环境变量均无 LLM key');
  } else {
    const src = (config && config.llm && config.llm.apiKey) ? 'config.json' : '环境变量 LLM_API_KEY';
    const base = resolveBaseUrl(cfgKey, {}) || ''; // '' = 走网关默认（含 env LLM_BASE_URL）
    const model = resolveModel(null);
    try {
      const v = await verifyLLM(cfgKey, base, model);
      fails += !line(v.ok, `llm ${mask(cfgKey)}（${src} · ${base || '内置默认接入点'} · ${model}）`, v.detail);
    } catch (e) {
      fails += !line(false, 'llm ' + mask(cfgKey), '网络层失败: ' + String(e && e.message || e).slice(0, 100));
    }
  }

  console.log('\n' + (fails ? `❌ ${fails} 项未通过` : '✅ 全部密钥实测通过'));
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('verify-apikeys 运行异常:', e); process.exit(1); });
