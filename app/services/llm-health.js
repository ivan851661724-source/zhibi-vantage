'use strict';
// ============================================================
// llm-health.js —— LLM 配置状态分离与健康检查（2026-11 P0 整改）
// ------------------------------------------------------------
// 口径铁律：Key 存在 ≠ 服务可用。
//   configured   密钥与接入点已配置（从未探测或缓存过期前的保守态）
//   operational  最近一次真实最小请求成功
//   unavailable  已配置但最近一次真实请求失败（errorClass 说明原因）
//   not_configured  无任何可用密钥
// 缓存：探测结果缓存 6 分钟（5–10 分钟窗口取中），缓存期内零外呼——
// 禁止每次用户搜索/设置页读取都发付费探测。显式 force=true 可立即重探。
// 载荷纪律：只返回 provider/baseHost/model/readiness/checkedAt/errorClass，
// 绝不返回 Key、带查询参数的完整 URL 或供应商原始错误正文。
// ============================================================

const CACHE_TTL_MS = 6 * 60 * 1000;
let _cache = null; // { provider, baseHost, model, readiness, checkedAt, errorClass, durationMs }

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

async function probe() {
  // 延迟 require：避免 services ← research 反向加载顺序问题（llm.js 依赖 core/config）
  const { llmApiKey, resolveModel, resolveBaseUrl } = require('../research/llm.js');
  const { loadConfig } = require('../core/config.js');
  const { normalizeBaseUrl } = require('./llm-gateway.js');
  const cfg = loadConfig() || {};
  const key = llmApiKey(cfg);
  const model = resolveModel(null);
  const endpoint = normalizeBaseUrl(resolveBaseUrl(key, null) || process.env.LLM_BASE_URL || '');
  if (!key) {
    return { provider: 'none', baseHost: '', model: model || '', readiness: 'not_configured', checkedAt: new Date().toISOString(), errorClass: null };
  }
  let host = '';
  try { host = endpoint ? new URL(endpoint).host : ''; } catch { host = ''; }
  const base = {
    provider: providerOf(host),
    baseHost: host,
    model: model || '',
    checkedAt: new Date().toISOString(),
  };
  if (!endpoint) return Object.assign(base, { readiness: 'unavailable', errorClass: 'LLM_PROVIDER_UNAVAILABLE' });
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with JSON only: {"ok":true}' }],
        response_format: { type: 'json_object' },
        max_tokens: 16,
        enable_thinking: false,
      }),
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timer));
    if (r.ok) {
      // 只验证结构可解析，不读取/保存正文以外的任何内容
      let ok = false;
      try {
        const j = await r.json();
        const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        let parsed = null;
        try { parsed = JSON.parse(content); } catch { try { parsed = JSON.parse(content.replace(/```json|```/g, '').trim()); } catch {} }
        ok = !!(parsed && typeof parsed === 'object');
      } catch { ok = false; }
      return Object.assign(base, { readiness: ok ? 'operational' : 'unavailable', errorClass: ok ? null : 'LLM_INVALID_RESPONSE', durationMs: Date.now() - t0 });
    }
    const { classifyLlmStatus } = require('./llm-gateway.js');
    let hint = '';
    try { hint = (await r.text()).slice(0, 500); } catch { /* 无 hint */ }
    const err = classifyLlmStatus(r.status, hint);
    return Object.assign(base, { readiness: 'unavailable', errorClass: err.code, durationMs: Date.now() - t0 });
  } catch (e) {
    const isTimeout = e && e.name === 'AbortError';
    return Object.assign(base, { readiness: 'unavailable', errorClass: isTimeout ? 'LLM_TIMEOUT' : 'LLM_PROVIDER_UNAVAILABLE', durationMs: Date.now() - t0 });
  }
}

// readiness 快照。probe=true 且缓存过期/为空 → 发起真实探测并缓存；否则只读缓存。
function getStatus(opts) {
  const o = opts || {};
  const fresh = _cache && (Date.now() - new Date(_cache.checkedAt).getTime() < CACHE_TTL_MS);
  if (!o.probe) {
    if (_cache) return Promise.resolve(_cache);
    // 从未探测过：先给保守的 configured 快照（不发付费探测），并异步补一次真实探测
    const { llmApiKey } = require('../research/llm.js');
    const configured = !!llmApiKey(loadCfgSafe());
    const snapshot = {
      provider: 'unknown', baseHost: '', model: '',
      readiness: configured ? 'configured' : 'not_configured',
      checkedAt: new Date().toISOString(), errorClass: null,
    };
    void refreshAsync();
    return Promise.resolve(snapshot);
  }
  if (fresh) return Promise.resolve(_cache);
  return refreshAsync();
}

function loadCfgSafe() { try { return require('../core/config.js').loadConfig() || {}; } catch { return {}; } }
function refreshAsync() {
  return probe().then((r) => { _cache = r; return r; }).catch((e) => {
    // 探测自身异常：缓存为 unavailable，绝不让健康检查把调用方打挂
    _cache = { provider: 'unknown', baseHost: '', model: '', readiness: 'unavailable', checkedAt: new Date().toISOString(), errorClass: 'LLM_PROVIDER_UNAVAILABLE' };
    try { require('./logger.js').warn('llm-health-probe-failed', { error: String((e && e.message) || e).slice(0, 120) }); } catch { /* 日志不可用 */ }
    return _cache;
  });
}
// 仅测试用：清空缓存
function _resetCache() { _cache = null; }

module.exports = { getStatus, _resetCache, providerOf, CACHE_TTL_MS };
