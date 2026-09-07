'use strict';
// ============================================================
// LLM 统一网关（模块 0-2）—— 超时/重试/熔断/字段级降级 + 成本归因（1-1）
// 零依赖：AbortController + 原生 fetch
// 行为契约：
//   · 超时 45s 有界返回（AbortSignal 计时器，无网络黑洞）
//   · 仅网络错误/5xx/429 重试 ×2（指数退避 1s→2s）；400/401/403 等确定性 4xx 不重试
//   · 熔断按 apiKey 分桶（连续 5 失败熔断 30s）——单个失效 key 不再拖垮全部租户
//   · 配额类（ENRICH_QUOTA）→ 立即 throw（不该降级）
//   · 其余失败重试耗尽 → 字段级降级：json 返回 {} / 文本返回 ''（调用方按缺失处理，不整家作废）
//   · 计费在响应落地后：每次"供应商真正受理"的调用只记一次（5xx 计、网络失败不计、
//     200 后 body 解析失败不重试——避免同一次调用双计费）
//   · 成功路径记账：metering.enrichRuns + cost_telemetry 三级归因
// 开关：LLM_DEGRADE=0 关闭降级（失败即 throw，还原旧行为；对熔断/预算路径同样生效）
// ============================================================
const crypto = require('crypto');
const metering = require('./metering.js');
const cost = require('./cost.js');

const TIMEOUT_MS = 45000;          // 45s（评审纪律：任何外部调用必须有界）
const MAX_ATTEMPTS = 3;            // 首次 + 重试 2 次
const RETRY_BASE_MS = 1000;        // 指数退避：1s → 2s
const BREAK_THRESHOLD = 5;         // 连续 5 次失败 → 熔断（按 key 分桶）
const BREAK_MS = 30000;            // 熔断 30s
const BUILTIN_BASE_URL = 'https://api.deepseek.com/v1/chat/completions';
const BUILTIN_MODEL = 'deepseek-v4-flash';
// 供应商可通过环境变量整平台切换（任何 OpenAI 兼容 /chat/completions 服务均可），
// 例：阿里云百炼 Token Plan（专属基地址，须与专属 key 配套，勿用 dashscope 通用地址）：
//   LLM_BASE_URL=https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
// 优先级：调用方 opts > 平台配置(cfg.llm) > 环境变量 > 内置 DeepSeek 默认
// 兼容两种写法：完整端点（…/chat/completions）或 OpenAI 风格基地址（…/v1），后者自动补全端点
function normalizeBaseUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return /\/chat\/completions$/.test(s) ? s : s + '/chat/completions';
}
const DEFAULT_BASE_URL = normalizeBaseUrl(process.env.LLM_BASE_URL) || BUILTIN_BASE_URL;
const DEFAULT_MODEL = process.env.LLM_MODEL || BUILTIN_MODEL;
const ENV_API_KEY = String(process.env.LLM_API_KEY || '').trim();

// 熔断器按 key 哈希分桶：某个租户的失效 key 不再让全部租户的 LLM 调用静默降级
const breakers = new Map(); // keyHash -> { failures, openedAt }
function keyHashOf(key) { return crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16); }
function breakerOf(key) {
  const h = keyHashOf(key);
  let b = breakers.get(h);
  if (!b) { b = { failures: 0, openedAt: 0 }; breakers.set(h, b); }
  return b;
}
function circuitOpen(b) { return b.openedAt > 0 && Date.now() - b.openedAt < BREAK_MS; }
function degradeDisabled() { return process.env.LLM_DEGRADE === '0'; }

async function rawCall(messages, key, model, json, temperature, baseUrl, timeoutMs) {
  const body = { model, messages, temperature: temperature == null ? 0.2 : temperature };
  if (json) body.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
  try {
    return await fetch(normalizeBaseUrl(baseUrl) || DEFAULT_BASE_URL, {
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
 * 错误分类：ENRICH_QUOTA / NO_LLM_KEY → 立即 throw；网络/5xx/429 → 重试 → 熔断 → 降级；
 *           400/401/403 → 不重试（确定性失败，重试纯浪费）→ 降级
 */
async function call(messages, opts) {
  const o = opts || {};
  const model = o.model || DEFAULT_MODEL;
  const key = o.apiKey || ENV_API_KEY;
  const tid = o.tenantId || '';
  const timeoutMs = o.timeoutMs || TIMEOUT_MS;
  const maxAttempts = Math.max(1, o.maxAttempts || MAX_ATTEMPTS);
  if (!key) throw new Error('NO_LLM_KEY');
  const br = breakerOf(key);
  if (circuitOpen(br)) {
    if (degradeDisabled()) throw new Error('LLM_CIRCUIT_OPEN');
    return o.json ? {} : '';            // 熔断期：字段级降级，不 throw
  }
  if (tid && !metering.withinQuota(tid, 'enrichRuns')) throw new Error('ENRICH_QUOTA'); // 配额不降级
  if (cost.overDailyBudget(tid)) {                        // 1-1 日预算熔断（独立于配额开关）
    cost.logBudgetAlert(tid);
    if (degradeDisabled()) throw new Error('LLM_DAILY_BUDGET_EXCEEDED');
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
      if (!r.ok) {
        // 计费口径与 metering.shouldBill 一致：5xx 供应商已受理计费；4xx 不计
        if (tid) metering.recordCall(tid, 'enrichRuns', metering.shouldBill(r.status) ? 1 : 0);
        throw new Error('DEEPSEEK_' + r.status);
      }
      const _bodyT0 = Date.now();
      const j = await r.json(); // 200 已受理：本次调用必计费（解析失败也不重试，防双计费）
      // 可观测性：body 读取耗时（排查 fetch headers 快但 body 挂起的问题）
      try {
        const logger = require('./logger.js');
        logger && logger.info('llm-body', { fieldKey: o.fieldKey, bodyMs: Date.now() - _bodyT0, totalMs: Date.now() - _callStart });
      } catch (e) { /* 日志不可用 */ }
      if (tid) metering.recordCall(tid, 'enrichRuns', 1);
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
      br.failures = 0; br.openedAt = 0;                   // 成功 → 复位该 key 的熔断计数
      if (!o.json) return content;
      try { return JSON.parse(content); }
      catch { try { return JSON.parse(content.replace(/```json|```/g, '').trim()); } catch { return {}; } }
    } catch (e) {
      lastErr = e;
      if (e && (e.message === 'ENRICH_QUOTA' || e.message === 'NO_LLM_KEY')) throw e; // 配额/无 key 不重试
      const m = e && /^DEEPSEEK_(\d{3})$/.exec(e.message);
      if (m && m[1] !== '429' && m[1] !== '408' && m[1][0] === '4') {
        // 确定性 4xx（key 失效/参数错误）：重试必然复现，直接出局
        break;
      }
      if (m && m[1][0] !== '5' && m[1] !== '429' && m[1] !== '408') break; // 防御：未知状态码不重试
      if (++br.failures >= BREAK_THRESHOLD) { br.openedAt = Date.now(); br.failures = 0; } // 熔断（该 key）
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

module.exports = { call, normalizeBaseUrl, TIMEOUT_MS, MAX_ATTEMPTS, BREAK_THRESHOLD, BREAK_MS, DEFAULT_MODEL };
