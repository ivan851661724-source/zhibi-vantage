'use strict';
// ============================================================
// llm-health.js —— LLM 配置状态分离与健康检查（2026-11 P0 整改 / r2 加固）
// ------------------------------------------------------------
// 口径铁律：Key 存在 ≠ 服务可用。
//   configured   密钥与接入点已配置（从未探测或缓存过期前的保守态）
//   operational  最近一次真实最小请求：HTTP 成功 + 模型有权限 + 返回可解析 + 结构符合规定
//   unavailable  已配置但最近一次真实请求失败（errorClass 说明原因）
//   not_configured  无任何可用密钥
//
// r2 追加：
//   · 配置指纹（Key/BaseURL/Model/ModelDeep）——任一变化立刻判定旧缓存失效，
//     防止「换了 Key 但设置页仍显示上一次的鉴权失败」这类误导（§六.1）。
//   · operational 要求返回内容「符合规定结构」（{"ok":true} 或含布尔 ok 的对象），
//     200 但非 JSON / 结构不符 → LLM_INVALID_RESPONSE（§六.3/§六.4）。
//   · 探测使用当前生效配置（config 优先，与运行链路同源），不再单读 env。
// 缓存：探测结果缓存 6 分钟（5–10 分钟窗口取中），缓存期内零外呼——
// 禁止每次用户搜索/设置页读取都发付费探测。显式 force=true 可立即重探。
// 载荷纪律：只返回 provider/baseHost/model/readiness/checkedAt/errorClass，
// 绝不返回 Key、带查询参数的完整 URL 或供应商原始错误正文。
// ============================================================

const crypto = require('crypto');

const CACHE_TTL_MS = 6 * 60 * 1000;
let _cache = null; // { provider, baseHost, model, readiness, checkedAt, errorClass, durationMs, fingerprint }

function providerOf(host) {
  if (!host) return 'unknown';
  if (/token-plan/.test(host)) return 'aliyun-bailian-token-plan';
  if (/dashscope/.test(host)) return 'aliyun-bailian';
  if (/deepseek/.test(host)) return 'deepseek';
  if (/bigmodel|zhipu/.test(host)) return 'zhipu';
  if (/moonshot/.test(host)) return 'moonshot';
  if (/minimax/.test(host)) return 'minimax';
  return host;
}

// 配置指纹：只做单向摘要，摘要本身也不含明文密钥（sha256 前 12 位）。
function configFingerprint(cfg) {
  const l = (cfg && cfg.llm) || {};
  const h = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex').slice(0, 12);
  return [
    'k=' + h(l.apiKey || process.env.LLM_API_KEY || ''),
    'b=' + h(l.baseUrl || process.env.LLM_BASE_URL || ''),
    'm=' + h(l.model || process.env.LLM_MODEL || ''),
    'd=' + h(l.modelDeep || process.env.LLM_MODEL_DEEP || ''),
  ].join(';');
}

function currentCfg() {
  try { return require('../core/config.js').loadConfig() || {}; } catch { return {}; }
}

// 结构校验：必须是 JSON 对象，且带布尔 ok=true（最小结构化契约）。
function validProbePayload(parsed) {
  return !!(parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.ok === true);
}

async function callProbe(endpoint, key, model, withFormat) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are a health probe. Reply with JSON only.' },
      { role: 'user', content: 'Reply with exactly: {"ok":true}' },
    ],
    max_tokens: 24,
    temperature: 0,
    enable_thinking: false,
  };
  if (withFormat) body.response_format = { type: 'json_object' };
  try {
    return await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
}

async function probe() {
  // 延迟 require：避免 services ← research 反向加载顺序问题（llm.js 依赖 core/config）
  const { llmApiKey, resolveModel, resolveBaseUrl } = require('../research/llm.js');
  const { normalizeBaseUrl } = require('./llm-gateway.js');
  const cfg = currentCfg();
  const key = llmApiKey(cfg);
  const model = resolveModel(null);
  const endpoint = normalizeBaseUrl(resolveBaseUrl(key, null) || process.env.LLM_BASE_URL || '');
  const fingerprint = configFingerprint(cfg);
  if (!key) {
    return { provider: 'none', baseHost: '', model: model || '', readiness: 'not_configured', checkedAt: new Date().toISOString(), errorClass: null, fingerprint };
  }
  let host = '';
  try { host = endpoint ? new URL(endpoint).host : ''; } catch { host = ''; }
  const base = {
    provider: providerOf(host),
    baseHost: host,
    model: model || '',
    checkedAt: new Date().toISOString(),
    fingerprint,
  };
  if (!endpoint) return Object.assign(base, { readiness: 'unavailable', errorClass: 'LLM_PROVIDER_UNAVAILABLE' });
  const t0 = Date.now();
  try {
    let r = await callProbe(endpoint, key, model, true);
    // 端点不接受 response_format 时（400 且错误体提到 response_format）降级重探一次：
    // 这属于「结构化参数不兼容」，不是密钥/模型问题，不应误判成服务不可用。
    if (r.status === 400) {
      let hint = '';
      try { hint = (await r.text()).slice(0, 400); } catch { /* 无 hint */ }
      if (/response_format|json_object|json mode/i.test(hint)) {
        return finish(await callProbe(endpoint, key, model, false), base, t0);
      }
      const { classifyLlmStatus } = require('./llm-gateway.js');
      const err = classifyLlmStatus(r.status, hint);
      return Object.assign(base, { readiness: 'unavailable', errorClass: err.code, durationMs: Date.now() - t0 });
    }
    return finish(r, base, t0);
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    return Object.assign(base, { readiness: 'unavailable', errorClass: isTimeout ? 'LLM_TIMEOUT' : 'LLM_PROVIDER_UNAVAILABLE', durationMs: Date.now() - t0 });
  }
}

async function finish(r, base, t0) {
  if (r.ok) {
    // 只验证结构，不读取/保存正文以外的任何内容
    let ok = false;
    try {
      const j = await r.json();
      const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      let parsed = null;
      try { parsed = JSON.parse(content); } catch { try { parsed = JSON.parse(String(content).replace(/```json|```/g, '').trim()); } catch { /* 非 JSON */ } }
      ok = validProbePayload(parsed);
    } catch { ok = false; }
    return Object.assign(base, { readiness: ok ? 'operational' : 'unavailable', errorClass: ok ? null : 'LLM_INVALID_RESPONSE', durationMs: Date.now() - t0 });
  }
  const { classifyLlmStatus } = require('./llm-gateway.js');
  let hint = '';
  try { hint = (await r.text()).slice(0, 500); } catch { /* 无 hint */ }
  const err = classifyLlmStatus(r.status, hint);
  return Object.assign(base, { readiness: 'unavailable', errorClass: err.code, durationMs: Date.now() - t0 });
}

// readiness 快照。probe=true 且缓存过期/为空/配置指纹变化 → 发起真实探测并缓存；否则只读缓存。
function getStatus(opts) {
  const o = opts || {};
  const fp = configFingerprint(currentCfg());
  const cacheValid = !!(_cache && _cache.fingerprint === fp && (Date.now() - new Date(_cache.checkedAt).getTime() < CACHE_TTL_MS));
  if (!cacheValid && _cache && _cache.fingerprint !== fp) _cache = null; // 配置已变：旧结论立即作废
  if (!o.probe) {
    if (_cache) return Promise.resolve(_cache);
    // 从未探测过：先给保守的 configured 快照（不发付费探测），并异步补一次真实探测
    const { llmApiKey } = require('../research/llm.js');
    const configured = !!llmApiKey(currentCfg());
    const snapshot = {
      provider: 'unknown', baseHost: '', model: '',
      readiness: configured ? 'configured' : 'not_configured',
      checkedAt: new Date().toISOString(), errorClass: null, fingerprint: fp,
    };
    void refreshAsync();
    return Promise.resolve(snapshot);
  }
  if (cacheValid) return Promise.resolve(_cache);
  return refreshAsync();
}

function refreshAsync() {
  return probe().then((r) => { _cache = r; return r; }).catch((e) => {
    // 探测自身异常：缓存为 unavailable，绝不让健康检查把调用方打挂
    _cache = { provider: 'unknown', baseHost: '', model: '', readiness: 'unavailable', checkedAt: new Date().toISOString(), errorClass: 'LLM_PROVIDER_UNAVAILABLE', fingerprint: configFingerprint(currentCfg()) };
    try { require('./logger.js').warn('llm-health-probe-failed', { error: String((e && e.message) || e).slice(0, 120) }); } catch { /* 日志不可用 */ }
    return _cache;
  });
}
// 配置保存后显式失效（指纹比对已能兜底，这里是双保险：保存即刻清缓存，下一次读取必重探）
function invalidate() { _cache = null; }
// 仅测试用：清空缓存
function _resetCache() { _cache = null; }

module.exports = { getStatus, invalidate, _resetCache, providerOf, configFingerprint, CACHE_TTL_MS };
