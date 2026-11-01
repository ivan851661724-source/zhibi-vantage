'use strict';
// ============================================================
// LLM 统一网关（模块 0-2）—— 超时/重试/熔断/字段级降级 + 成本归因（1-1）
// 零依赖：AbortController + 原生 fetch
// 行为契约：
//   · 超时 45s 有界返回（deadline 同时覆盖响应头与正文读取，无网络黑洞）
//   · 仅网络错误/5xx/429 重试 ×2（指数退避 1s→2s）；400/401/403 等确定性 4xx 不重试
//   · 熔断按 apiKey 分桶（连续 5 失败熔断 30s）——单个失效 key 不再拖垮全部租户
//   · 配额类（ENRICH_QUOTA）→ 立即 throw（不该降级）
//   · 其余失败重试耗尽 → 按 failureMode：'throw' 抛归一 LLMError（关键链路：品牌发现/
//     候选提取/交叉核验）；默认 'degrade' 字段级降级——json 返回 {} / 文本返回 ''
//     （调用方按缺失处理，不整家作废；仅限非关键文案润色/摘要类调用）
//   · 计费在响应落地后：每次"供应商真正受理"的调用只记一次（5xx 计、网络失败不计、
//     200 后 body 解析失败不重试——避免同一次调用双计费）
//   · 成功路径记账：metering.enrichRuns + cost_telemetry 三级归因
// 开关：LLM_DEGRADE=0 关闭降级（失败即 throw，还原旧行为；对熔断/预算路径同样生效）
// ============================================================
const crypto = require('crypto');
const metering = require('./metering.js');
const cost = require('./cost.js');
// M4 任务 C：ExternalCallLedger（03 §20）与成本口径（05 §16/§19）——只增不改既有语义
const CallLedger = require('./call-ledger.js');
const CostProfile = require('./cost-profile.js');

const TIMEOUT_MS = 45000;          // 45s（评审纪律：任何外部调用必须有界）
const MAX_ATTEMPTS = 3;            // 首次 + 重试 2 次
const RETRY_BASE_MS = 1000;        // 指数退避：1s → 2s
const BREAK_THRESHOLD = 5;         // 连续 5 次失败 → 熔断（按 key 分桶）
const BREAK_MS = 30000;            // 熔断 30s
// 内置默认仅作「完全未配置时」的最后回落（历史遗留；生产应由 env/设置页显式注入）。
// 纪律（2026-11 P0 整改）：运行逻辑与错误分类一律供应商中立——错误码/错误消息/账本
// 不再出现 DeepSeek 字样，供应商差异只存在于配置值（baseUrl/model/key）本身。
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

// ============================================================
// 供应商中立错误分类（2026-11 P0 整改）
// ------------------------------------------------------------
// 六类归一错误码（对外契约，调用方/前端按码渲染用户可读文案）：
//   LLM_AUTH_REJECTED       401/403 —— key 无效 / 未获模型授权
//   LLM_MODEL_UNAVAILABLE   404，或 400 且错误体指向模型名 —— 模型不存在/未开通
//   LLM_RATE_LIMITED        429，或平台日预算熔断
//   LLM_PROVIDER_UNAVAILABLE 5xx / 网络不可达 / 熔断开启
//   LLM_TIMEOUT             请求超时（abort / 408）
//   LLM_INVALID_RESPONSE    200 但正文不可解析，或 400 等确定性请求错误
// 错误载荷纪律：绝不携带 Key、Authorization 头、供应商响应正文、带敏感查询参数的
// URL。LLMError.message = 归一错误码（账本/日志/遥测安全）；userMessage = 用户可读
// 中文（SSE/前端直接展示，同样不含内部细节）。
// ============================================================
const LLM_ERROR_MESSAGES = {
  LLM_AUTH_REJECTED: '品牌识别服务鉴权失败（密钥无效或未获模型授权）',
  LLM_MODEL_UNAVAILABLE: '品牌识别服务当前模型不可用',
  LLM_RATE_LIMITED: '品牌识别服务额度受限',
  LLM_PROVIDER_UNAVAILABLE: '品牌识别服务暂不可用',
  LLM_TIMEOUT: '品牌识别服务响应超时',
  LLM_INVALID_RESPONSE: '品牌识别服务返回了无法解析的结果',
};
class LLMError extends Error {
  constructor(code, status, userMessage) {
    super(code);
    this.name = 'LLMError';
    this.code = LLM_ERROR_MESSAGES[code] ? code : 'LLM_PROVIDER_UNAVAILABLE';
    this.status = status || null;
    this.userMessage = userMessage || LLM_ERROR_MESSAGES[this.code] || this.code;
    // 重试策略：超时/限流/供应商故障可重试；鉴权/模型/解析类确定性失败重试无意义
    this.retryable = code === 'LLM_RATE_LIMITED' || code === 'LLM_PROVIDER_UNAVAILABLE' || code === 'LLM_TIMEOUT';
  }
}
// HTTP 状态 → 归一错误码（bodyHint 只用于辅助归类，绝不入错误载荷）
function classifyLlmStatus(status, bodyHint) {
  if (status === 401 || status === 403) return new LLMError('LLM_AUTH_REJECTED', status);
  if (status === 404) return new LLMError('LLM_MODEL_UNAVAILABLE', status);
  if (status === 429) return new LLMError('LLM_RATE_LIMITED', status);
  if (status === 408) return new LLMError('LLM_TIMEOUT', status);
  if (status >= 500) return new LLMError('LLM_PROVIDER_UNAVAILABLE', status);
  if (status === 400 || status === 422) {
    // 部分供应商对未知模型返回 400/422：错误体指向模型名时归类为模型不可用
    if (bodyHint && /model/i.test(bodyHint) && /not\s+(exist|found|support)|invalid|unknown|不存在|不支持|未开通/i.test(bodyHint)) {
      return new LLMError('LLM_MODEL_UNAVAILABLE', status);
    }
    return new LLMError('LLM_INVALID_RESPONSE', status);
  }
  return new LLMError('LLM_INVALID_RESPONSE', status);
}

// M4 任务 C（03 §20）：每次外部 LLM 尝试入账 ExternalCallLedger。旁路观测——账本校验/
// 存储失败只留 warn 日志，绝不影响主调用（07 §17 paid calls 100% 入账是目标，但账本
// 故障时宁可缺行也不阻断业务；失败留 warn 供运维发现）。tenant 未知（匿名调用）时
// 记账被拒（账本 tenant 非空），同样走此 warn 路径。
function _ledgerRecord(entry) {
  try {
    CallLedger.recordCall(entry);
  } catch (e) {
    try {
      const logger = require('./logger.js');
      logger && logger.warn('call_ledger_write_failed', { error: String((e && e.message) || e).slice(0, 120) });
    } catch (e2) { /* 日志不可用时静默（观测不阻断） */ }
  }
}

// deadline 计时器从发请求一直活着到调用方读完正文：fetch 返回 Response 只代表响应头到达，
// 正文可能仍在传输（llm-body 埋点即为此排查而设）。返回 { response, release }，
// release 必须在正文读取结束后调用；计时器触发 → ctrl.abort() → 未完成的正文读取以
// AbortError 失败，与网络超时同路径走重试/熔断。
function rawCall(messages, key, model, json, temperature, baseUrl, timeoutMs, thinking) {
  const body = { model, messages, temperature: temperature == null ? 0.2 : temperature };
  if (json) body.response_format = { type: 'json_object' };
  // 模型分工配套（2026-09-12）：批量抽取类调用传 thinking=false 关思考链
  // （qwen3 系列 enable_thinking，实测 JSON 小任务 5959ms → 371ms，completion_tokens 1286 → 35）
  if (thinking === false) body.enable_thinking = false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || TIMEOUT_MS);
  const release = () => clearTimeout(timer);
  return fetch(normalizeBaseUrl(baseUrl) || DEFAULT_BASE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  }).then(
    r => ({ response: r, release }),
    e => { release(); throw e; }
  );
}

/**
 * llm.call(messages, opts) → Promise<object|string>
 * opts: { apiKey, model, json, temperature, tenantId, projectId, competitorId, fieldKey, baseUrl,
 *         timeoutMs, maxAttempts, trigger, failureMode }
 *   trigger：ExternalCallLedger 归因（M4-C，可选；缺省记 'unknown'，不伪造触发来源）
 *   json:true → 解析对象；失败字段级降级返回 {}（不 throw）
 *   failureMode: 'throw' | 'degrade'（默认 'degrade'，保持既有行为）
 *     · 'throw'：失败即抛 LLMError（归一错误码 + 用户可读 userMessage，无敏感载荷）。
 *       品牌发现/候选提取/交叉核验等关键链路必须显式传 'throw'——不得把模型故障
 *       降级成"空结果"冒充"市场上没有品牌"。
 *     · 'degrade'：仅限非关键文案润色/摘要补充类调用。
 *   LLM_DEGRADE=0（全局）仍优先于 failureMode='degrade'（运维总闸，失败即 throw）。
 *   timeoutMs：覆盖默认 45s（大输出调用如 discover 枚举/harvest 传 90000，避免接近阈值触发重试翻倍）
 *   maxAttempts：覆盖默认 3（大输出调用传 2，重试 1 次即可）
 * 错误分类（供应商中立）：ENRICH_QUOTA / NO_LLM_KEY → 立即 throw；LLM_RATE_LIMITED /
 *           LLM_TIMEOUT / LLM_PROVIDER_UNAVAILABLE → 重试 → 熔断；LLM_AUTH_REJECTED /
 *           LLM_MODEL_UNAVAILABLE / LLM_INVALID_RESPONSE → 不重试（确定性失败，重试纯浪费）
 */
async function call(messages, opts) {
  const o = opts || {};
  const model = o.model || DEFAULT_MODEL;
  const key = o.apiKey || ENV_API_KEY;
  const tid = o.tenantId || '';
  const timeoutMs = o.timeoutMs || TIMEOUT_MS;
  const maxAttempts = Math.max(1, o.maxAttempts || MAX_ATTEMPTS);
  // 失败模式：显式 'throw' 优先；全局总闸 LLM_DEGRADE=0 时一律 throw（既有运维开关语义）
  const mustThrow = o.failureMode === 'throw' || degradeDisabled();
  if (!key) throw new Error('NO_LLM_KEY');
  const br = breakerOf(key);
  if (circuitOpen(br)) {
    if (mustThrow) throw new LLMError('LLM_PROVIDER_UNAVAILABLE'); // 熔断开启 = 供应商不可用
    return o.json ? {} : '';            // 熔断期：字段级降级，不 throw
  }
  if (tid && !metering.withinQuota(tid, 'enrichRuns')) throw new Error('ENRICH_QUOTA'); // 配额不降级
  if (cost.overDailyBudget(tid)) {                        // 1-1 日预算熔断（独立于配额开关）
    cost.logBudgetAlert(tid);
    if (mustThrow) throw new LLMError('LLM_RATE_LIMITED'); // 平台日预算 → 额度受限
    return o.json ? {} : '';
  }

  let lastErr = null;
  const _callStart = Date.now();
  // ---- Phase 1 可观测性：llm_header_wait / llm_body_read 阶段度量 ----
  // 每次尝试先攒在内存，调用结局（成功/降级/抛错）确定后统一落盘——这样 degraded
  // 标志能正确标注到整次调用的全部尝试行上。观测失败不影响调用本身（best-effort）。
  const _tObs = () => { try { return require('../observability/telemetry.js'); } catch { return null; } };
  const _attemptRows = []; // {kind:'header'|'body', durationMs, status, errorCode, cacheHit}
  const _flushObs = (degraded) => {
    const T = _tObs();
    if (!T) return;
    for (const r of _attemptRows) {
      T.recordStage({
        stage: r.kind === 'header' ? 'llm_header_wait' : 'llm_body_read',
        durationMs: r.durationMs, status: r.status, provider: 'llm', model,
        retryCount: r.attempt, cacheHit: !!r.cacheHit, degraded, errorCode: r.errorCode,
        tenantId: tid || 'anonymous', projectId: o.projectId, competitorId: undefined,
      });
    }
  };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, RETRY_BASE_MS * 2 ** (attempt - 1)));
    const _attemptStart = Date.now();
    let _headersArrived = false;
    let _bodyT0 = 0;
    try {
      const { response: r, release } = await rawCall(messages, key, model, o.json, o.temperature, o.baseUrl, timeoutMs, o.thinking);
      _headersArrived = true;
      if (!r.ok) {
        // 非OTA OK：读取错误体仅用于辅助归类（如 400+模型名 → LLM_MODEL_UNAVAILABLE），
        // 归类后立即丢弃——错误载荷绝不携带供应商响应正文。
        let _hint = '';
        try { _hint = (await r.text()).slice(0, 500); } catch { /* 正文不可读按无 hint 归类 */ }
        const err = classifyLlmStatus(r.status, _hint);
        _attemptRows.push({
          kind: 'header', attempt, durationMs: Date.now() - _attemptStart,
          status: 'http_' + r.status, errorCode: err.code,
        });
        try {
          // 可观测性：记录每次 LLM 调用耗时（含 HTTP 阶段），供 discover/深研耗时排查
          const logger = require('./logger.js');
          logger && logger.info('llm-call', {
            fieldKey: o.fieldKey, competitorId: o.competitorId || null, model,
            attempt: attempt + 1, status: r.status, durationMs: Date.now() - _callStart,
          });
        } catch (e) { /* 日志不可用 */ }
        // 计费口径与 metering.shouldBill 一致：5xx 供应商已受理计费；4xx 不计
        if (tid) metering.recordCall(tid, 'enrichRuns', metering.shouldBill(r.status) ? 1 : 0);
        throw err;
      }
      _attemptRows.push({
        kind: 'header', attempt, durationMs: Date.now() - _attemptStart,
        status: 'ok', errorCode: null,
      });
      try {
        _bodyT0 = Date.now();
        const j = await r.json(); // 200 已受理：解析失败不重试（防双计费）；body 挂起由同一 deadline abort 后按超时重试
        _attemptRows.push({
          kind: 'body', attempt, durationMs: Date.now() - _bodyT0, status: 'ok',
          cacheHit: !!(j.usage && (j.usage.prompt_cache_hit_tokens || 0) > 0),
        });        // 可观测性：body 读取耗时（排查 fetch headers 快但 body 挂起的问题）
        try {
          const logger = require('./logger.js');
          logger && logger.info('llm-body', { fieldKey: o.fieldKey, bodyMs: Date.now() - _bodyT0, totalMs: Date.now() - _callStart });
        } catch (e) { /* 日志不可用 */ }
        if (tid) metering.recordCall(tid, 'enrichRuns', 1);
        const content = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
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
        // M4-C 账本：成功 attempt 入账。request_units=usage tokens 总和、estimated 只来自
        // cost profile（cp-eng-v0，与 cost.js 同源）；usage 缺失 → 两者为 null 不为 0。
        _ledgerRecord({
          tenantId: tid || undefined, projectId: o.projectId || null,
          capability: 'llm_enrich', provider: 'llm', operation: 'chat_completions',
          trigger: o.trigger || 'unknown', costProfileVersion: CostProfile.VERSION,
          requestUnits: j.usage ? (j.usage.prompt_tokens || 0) + (j.usage.completion_tokens || 0) : null,
          estimatedCost: j.usage ? CostProfile.estimate({ provider: 'llm', operation: 'chat_completions', requestUnits: j.usage }).estimatedCost : null,
          cacheHit: !!(j.usage && (j.usage.prompt_cache_hit_tokens || 0) > 0),
          canonicalReuseHit: false, fallbackDepth: 0, attemptNo: attempt + 1,
          startedAt: _attemptStart, completedAt: Date.now(),
          outcome: 'success', errorCode: null,
        });
        _flushObs(0);                                        // 结局=成功：落盘本次全部尝试行（degraded=0）
        if (!o.json) return content;
        let parsed = null;
        try { parsed = JSON.parse(content); }
        catch { try { parsed = JSON.parse(content.replace(/```json|```/g, '').trim()); } catch { parsed = null; } }
        if (parsed == null || typeof parsed !== 'object') {
          // 200 但正文不可解析：确定性失败，不重试（防双计费）。throw 模式显式失败，
          // degrade 模式按字段缺失处理（返回空对象，行为不变）。
          if (mustThrow) throw new LLMError('LLM_INVALID_RESPONSE', 200);
          return {};
        }
        return parsed;
      } finally { release(); } // 正文读取完成/失败后统一解除 deadline（中间任何 return/throw 都会经过）
    } catch (e) {
      lastErr = e;
      // 响应头未到达即失败（连接拒绝/头等待超时 abort）→ 补 header 失败行
      if (!_headersArrived && !_attemptRows.some(x => x.kind === 'header' && x.attempt === attempt)) {
        _attemptRows.push({
          kind: 'header', attempt, durationMs: Date.now() - _attemptStart, status: 'error',
          errorCode: String((e && e.message) || e).slice(0, 64),
        });
      }
      // 正文读取阶段失败（headers 已到但 body 挂起/中断）→ 补 body 失败行（header 行已记）
      if (_headersArrived && !_attemptRows.some(x => x.kind === 'body' && x.attempt === attempt)) {
        _attemptRows.push({
          kind: 'body', attempt, durationMs: _bodyT0 ? Date.now() - _bodyT0 : Date.now() - _attemptStart,
          status: 'error',
          errorCode: String((e && e.message) || e).slice(0, 64),
        });
      }
      // M4-C 账本：失败/超时 attempt 同样入账（03 §20；07 §17）。usage 未知 →
      // request_units/estimated_cost 为 null（绝不伪造 0）；outcome 留真（timeout/failed）。
      _ledgerRecord({
        tenantId: tid || undefined, projectId: o.projectId || null,
        capability: 'llm_enrich', provider: 'llm', operation: 'chat_completions',
        trigger: o.trigger || 'unknown', costProfileVersion: CostProfile.VERSION,
        requestUnits: null, estimatedCost: null,
        cacheHit: false, canonicalReuseHit: false, fallbackDepth: 0, attemptNo: attempt + 1,
        startedAt: _attemptStart, completedAt: Date.now(),
        outcome: e && e.name === 'AbortError' ? 'timeout' : 'failed',
        errorCode: String((e && e.message) || e).slice(0, 64) || null,
      });
      if (e && (e.message === 'ENRICH_QUOTA' || e.message === 'NO_LLM_KEY')) { _flushObs(0); throw e; } // 配额/无 key 不重试
      if (e && e.name === 'LLMError' && e.retryable === false) {
        // 确定性失败（鉴权被拒/模型不可用/响应不可解析）：重试必然复现，直接出局
        break;
      }
      // 其余（限流/超时/供应商故障/网络错误）：退避重试 + 该 key 熔断计数
      if (++br.failures >= BREAK_THRESHOLD) { br.openedAt = Date.now(); br.failures = 0; }
    }
  }
  // 重试耗尽：throw 模式（显式 failureMode 或全局 LLM_DEGRADE=0）→ 抛归一 LLMError；
  // degrade 模式 → 字段级降级（既有行为不变）。
  if (mustThrow) {
    _flushObs(0);
    if (lastErr && lastErr.name === 'LLMError') throw lastErr;
    if (lastErr && lastErr.name === 'AbortError') throw new LLMError('LLM_TIMEOUT');
    throw new LLMError('LLM_PROVIDER_UNAVAILABLE');
  }
  _flushObs(1); // 结局=字段级降级：全部尝试行标 degraded=1
  try {
    const logger = require('./logger.js');
    logger && logger.warn('llm 调用失败已降级', { fieldKey: o.fieldKey, competitorId: o.competitorId, err: String(lastErr && lastErr.message) });
  } catch { /* 日志不可用时静默 */ }
  return o.json ? {} : '';
}

module.exports = { call, normalizeBaseUrl, TIMEOUT_MS, MAX_ATTEMPTS, BREAK_THRESHOLD, BREAK_MS, DEFAULT_MODEL, DEFAULT_BASE_URL, LLMError, classifyLlmStatus, LLM_ERROR_MESSAGES };
