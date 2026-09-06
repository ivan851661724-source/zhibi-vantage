'use strict';
// ============================================================
// LLM 统一网关（模块 0-2）—— 超时/重试/熔断/字段级降级 + 成本归因（1-1）
// 零依赖：AbortController + 原生 fetch
// 行为契约：
//   · 超时 45s 有界返回（AbortSignal 计时器，无网络黑洞）
//   · 网络/5xx 重试 ×2（指数退避 1s→2s），连续 5 失败熔断 30s
//   · 配额类（ENRICH_QUOTA）→ 立即 throw（不该降级）
//   · 其余失败重试耗尽 → 字段级降级：json 返回 {} / 文本返回 ''（调用方按缺失处理，不整家作废）
//   · 成功路径记账：metering.enrichRuns + cost_telemetry 三级归因
// 开关：LLM_DEGRADE=0 关闭降级（失败即 throw，还原旧行为）
// ============================================================
const metering = require('./metering.js');
const cost = require('./cost.js');

const TIMEOUT_MS = 45000;          // 45s（评审纪律：任何外部调用必须有界）
const MAX_ATTEMPTS = 3;            // 首次 + 重试 2 次
const RETRY_BASE_MS = 1000;        // 指数退避：1s → 2s
const BREAK_THRESHOLD = 5;         // 连续 5 次失败 → 熔断
const BREAK_MS = 30000;            // 熔断 30s
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1/chat/completions';
const DEFAULT_MODEL = 'deepseek-v4-flash';

let failures = 0, openedAt = 0;

function circuitOpen() { return openedAt > 0 && Date.now() - openedAt < BREAK_MS; }
function degradeDisabled() { return process.env.LLM_DEGRADE === '0'; }

async function rawCall(messages, key, model, json, temperature, baseUrl, timeoutMs) {
  const body = { model, messages, temperature: temperature == null ? 0.2 : temperature };
  if (json) body.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
  try {
    return await fetch(baseUrl || DEFAULT_BASE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally { clearTimeout(timer); }
}

/**
 * llm.call(messages, opts) → Promise<object|string>
 * opts: { apiKey, model, json, temperature, tenantId, projectId, competitorId, fieldKey, baseUrl,
 *         timeoutMs, maxAttempts }
 *   json:true → 解析对象；失败字段级降级返回 {}（不 throw）
 *   timeoutMs：覆盖默认 45s（大输出调用如 discover 枚举/harvest 传 90000，避免接近阈值触发重试翻倍）
 *   maxAttempts：覆盖默认 3（大输出调用传 2，重试 1 次即可）
 * 错误分类：ENRICH_QUOTA / NO_LLM_KEY → 立即 throw；网络/5xx → 重试 → 熔断 → 降级
 */
async function call(messages, opts) {
  const o = opts || {};
  const model = o.model || DEFAULT_MODEL;
  const key = o.apiKey;
  const tid = o.tenantId || '';
  const timeoutMs = o.timeoutMs || TIMEOUT_MS;
  const maxAttempts = Math.max(1, o.maxAttempts || MAX_ATTEMPTS);
  if (!key) throw new Error('NO_LLM_KEY');
  if (circuitOpen()) return o.json ? {} : '';            // 熔断期：字段级降级，不 throw
  if (tid && !metering.withinQuota(tid, 'enrichRuns')) throw new Error('ENRICH_QUOTA'); // 配额不降级
  if (cost.overDailyBudget(tid)) {                        // 1-1 日预算熔断（独立于配额开关）
    cost.logBudgetAlert(tid);
    return o.json ? {} : '';
  }

  let lastErr = null;
  const _callStart = Date.now();
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)));
    try {
      const r = await rawCall(messages, key, model, o.json, o.temperature, o.baseUrl, timeoutMs);
      // 可观测性：记录每次 LLM 调用耗时（含 HTTP 阶段），供 discover/深研耗时排查
      try {
        const logger = require('./logger.js');
        logger && logger.info('llm-call', {
          fieldKey: o.fieldKey, competitorId: o.competitorId || null, model,
          attempt: attempt + 1, status: r.status, durationMs: Date.now() - _callStart,
        });
      } catch (e) { /* 日志不可用 */ }
      if (tid) metering.recordCall(tid, 'enrichRuns', metering.shouldBill(r.status) ? 1 : 0);
      if (!r.ok) throw new Error('DEEPSEEK_' + r.status);
      const _bodyT0 = Date.now();
      const j = await r.json();
      // 可观测性：body 读取耗时（排查 fetch headers 快但 body 挂起的问题）
      try {
        const logger = require('./logger.js');
        logger && logger.info('llm-body', { fieldKey: o.fieldKey, bodyMs: Date.now() - _bodyT0, totalMs: Date.now() - _callStart });
      } catch (e) { /* 日志不可用 */ }
      const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || (o.json ? '{}' : '');
      // 1-1 成本归因（usage 驱动，三级归因）
      if (j.usage && tid) {
        cost.record({
          tenantId: tid, projectId: o.projectId, competitorId: o.competitorId, fieldKey: o.fieldKey,
          kind: 'llm', tokensIn: j.usage.prompt_tokens || 0, tokensOut: j.usage.completion_tokens || 0,
          cached: j.usage.prompt_cache_hit_tokens || 0, calls: 1,
          costYuan: cost.costOf(j.usage),
        });
      }
      failures = 0; openedAt = 0;                         // 成功 → 复位熔断计数
      if (!o.json) return content;
      try { return JSON.parse(content); }
      catch { try { return JSON.parse(content.replace(/```json|```/g, '').trim()); } catch { return {}; } }
    } catch (e) {
      lastErr = e;
      if (e && (e.message === 'ENRICH_QUOTA' || e.message === 'NO_LLM_KEY')) throw e; // 配额/无 key 不重试
      if (++failures >= BREAK_THRESHOLD) { openedAt = Date.now(); failures = 0; }    // 熔断
    }
  }
  // 重试耗尽：LLM_DEGRADE=0 时还原抛错（测试/运维可用）；默认字段级降级
  if (degradeDisabled()) throw lastErr;
  try {
    const logger = require('./logger.js');
    logger && logger.warn('llm 调用失败已降级', { fieldKey: o.fieldKey, competitorId: o.competitorId, err: String(lastErr && lastErr.message) });
  } catch { /* 日志不可用时静默 */ }
  return o.json ? {} : '';
}

module.exports = { call, TIMEOUT_MS, MAX_ATTEMPTS, BREAK_THRESHOLD, BREAK_MS, DEFAULT_MODEL };
