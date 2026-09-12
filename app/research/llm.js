'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/llm.js —— 导出: deepseekJSON, deepseekText
// ============================================================

const LLMGateway = require('../services/llm-gateway.js');
const Logger = require('../services/logger.js');
const { loadConfig } = require('../core/config.js');
const { curTenantId } = require('../core/als.js'); // 拆分自 server.js 时遗漏的依赖：缺失则一切 LLM 调用 ReferenceError

// ============ 数据自动化 0-1/0-2：LLM 调用统一走网关 ============
// 供应商：任何 OpenAI 兼容 /chat/completions 服务（DeepSeek 官方 / 阿里云百炼 Token Plan 等）。
// 网关能力：45s 超时 / 重试×2 指数退避 / 连续 5 失败熔断 30s / 字段级降级（单次 5xx 不再整家作废）。
// 计量：enrichRuns 照旧（5xx 也计，网络失败不计）；成本归因经网关自动写 cost_telemetry（1-1）。
// 端点/模型/key 的优先级：调用方显式传入 > 平台配置(cfg.llm.*，超管在设置页保存) > 环境变量(LLM_*) > 内置默认。
const LEGACY_LLM_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner']);
const _warnedLegacyModel = new Set();
function _loadCfg() { try { return loadConfig() || {}; } catch { return {}; } }
// 旧模型名（deepseek-chat 等）各供应商均已下线：自动改写为当前默认并告警一次（只告警不改写调用方认知）
function resolveModel(model) {
  let m = model || (_loadCfg().llm && _loadCfg().llm.model) || LLMGateway.DEFAULT_MODEL;
  if (LEGACY_LLM_MODELS.has(m)) {
    if (!_warnedLegacyModel.has(m)) {
      _warnedLegacyModel.add(m);
      try { Logger.warn('llm.model 使用已弃用模型名 ' + m + '，已自动迁移至 ' + LLMGateway.DEFAULT_MODEL); } catch { /* 日志不可用 */ }
    }
    m = LLMGateway.DEFAULT_MODEL;
  }
  return m;
}
// 模型分工（cfg.llm.modelDeep，2026-09-12）：批量抽取类调用（translate/enumerate/harvest/
// crossvalidate/enrich 字段抽取）走 cfg.llm.model（轻快模型，如 qwen3.6-flash）；
// 深研裁决类（deepdive 字段裁决 / report 报告生成）走 cfg.llm.modelDeep（旗舰模型，如 qwen3.8-max）。
// modelDeep 未配置时回落到 model——单模型部署行为不变。
function resolveDeepModel() {
  const cfgLlm = _loadCfg().llm || {};
  return cfgLlm.modelDeep || resolveModel(null);
}
// 统一取 key：平台配置优先，其次环境变量（如 Token Plan 专属 key 走 .env 下发）
function llmApiKey(config) {
  return (config && config.llm && config.llm.apiKey) || process.env.LLM_API_KEY || '';
}
// 旧版 configPost 曾把 DeepSeek 官方地址硬编码为默认值落盘——视为「未设置」，
// 不让它压过环境变量/内置默认（否则 env 下发的专属接入点会被存量配置悄悄顶掉）。
function cfgCustomBase(cfgLlm) {
  const b = LLMGateway.normalizeBaseUrl((cfgLlm && cfgLlm.baseUrl) || '');
  return b && b !== LLMGateway.normalizeBaseUrl('https://api.deepseek.com/v1') ? b : '';
}
// 接入点解析：显式 opts > 配置里的自定义接入点（与 key 同源使用）> 环境变量（配 env key）> 网关默认。
// key 与 baseUrl 必须同源：配置 key 打配置接入点，env key 打 env 接入点，混搭必然 401。
function resolveBaseUrl(key, opts) {
  if (opts && opts.baseUrl) return opts.baseUrl;
  const custom = cfgCustomBase(_loadCfg().llm);
  if (custom) return custom;
  return key ? '' : String(process.env.LLM_BASE_URL || '').trim();
}
// opts: { projectId, competitorId, fieldKey } —— 三级归因地基（1-1）；tenantId 由 curTenantId() 兜底
async function deepseekJSON(messages, key, model, opts) {
  const o = opts || {};
  return LLMGateway.call(messages, {
    apiKey: key, model: resolveModel(model), baseUrl: resolveBaseUrl(key, o), json: true, temperature: 0.2,
    tenantId: curTenantId(), ...o,
  });
}

// 纯文本接口（用于叙事型简报，避免 DeepSeek json_object 必须含 'json' 字样的限制）
async function deepseekText(messages, key, model, opts) {
  const o = opts || {};
  return LLMGateway.call(messages, {
    apiKey: key, model: resolveModel(model), baseUrl: resolveBaseUrl(key, o), json: false, temperature: 0.4,
    tenantId: curTenantId(), ...o,
  });
}


module.exports = { deepseekJSON, deepseekText, llmApiKey, resolveModel, resolveDeepModel, resolveBaseUrl };
