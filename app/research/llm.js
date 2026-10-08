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
// ============ 配置同源原则（2026-10-07，Key 决定配置源） ============
// apiKey/baseUrl/model/modelDeep 必须来自同一配置源，禁止混搭拼接：
//   config key 非空            → config 是主配置源（cfg.llm.*）
//   config key 为空 + env key 在 → env 是主配置源（LLM_* 全套）
// 背景：config-seed 里存在历史默认值（baseUrl=api.deepseek.com、model=deepseek-v4-flash），
// 若 model/baseUrl 各自独立取源，会产生「百炼 endpoint + 百炼 key + deepseek 模型」的错配。
function configKeySet(config) {
  return Boolean(config && config.llm && String(config.llm.apiKey || '').trim());
}
function envKeySet() {
  return Boolean(String(process.env.LLM_API_KEY || '').trim());
}
// 旧模型名（deepseek-chat 等）各供应商均已下线：自动改写为当前默认并告警一次（只告警不改写调用方认知）
function resolveModel(model) {
  let m = model;
  if (!m) {
    const cfgLlm = _loadCfg().llm || {};
    if (configKeySet(_loadCfg())) m = cfgLlm.model || '';
    else if (envKeySet()) m = String(process.env.LLM_MODEL || '').trim(); // env 为主配置源：config 历史 model 不得压住 env
    else m = cfgLlm.model || '';                                          // 无 key：保留旧解析行为
    m = m || LLMGateway.DEFAULT_MODEL;
  }
  if (LEGACY_LLM_MODELS.has(m)) {
    if (!_warnedLegacyModel.has(m)) {
      _warnedLegacyModel.add(m);
      try { Logger.warn('llm.model 使用已弃用模型名 ' + m + '，已自动迁移至 ' + LLMGateway.DEFAULT_MODEL); } catch { /* 日志不可用 */ }
    }
    m = LLMGateway.DEFAULT_MODEL;
  }
  return m;
}
// 模型分工（cfg.llm.modelDeep / env LLM_MODEL_DEEP，2026-09-12）：批量抽取类调用（translate/
// enumerate/harvest/crossvalidate/enrich 字段抽取）走 resolveModel()（轻快模型，如 qwen3.6-flash）；
// 深研裁决类（deepdive 字段裁决 / report 报告生成）走本函数（旗舰模型，如 qwen3.8-max）。
// deep 未配置时回落到 model——单模型部署行为不变。同源原则与 resolveModel 一致。
function resolveDeepModel() {
  const cfgLlm = _loadCfg().llm || {};
  let m = '';
  if (configKeySet(_loadCfg())) m = cfgLlm.modelDeep || '';
  else if (envKeySet()) m = String(process.env.LLM_MODEL_DEEP || '').trim(); // env 为主配置源
  else m = cfgLlm.modelDeep || '';
  return m || resolveModel(null);
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
// 接入点解析——「Key 决定整套配置源」的唯一实现点（P0-2 最终审核修复）：
//   1) opts.baseUrl：调用方显式传入的调用级配置（运维探针/工具明确指定端点），
//      最高优先级。显式配置 = 调用方自己保证 key 与端点配对，本函数不做混用拦截。
//   2) config key 非空 → 整套取 config：端点只认 cfg.llm 自定义接入点（legacy
//      DeepSeek 默认地址视为未设置 → 网关默认）。绝不落入 env LLM_BASE_URL
//      ——config 密钥禁止发往环境变量端点。
//   3) config key 为空 + env key 在 → 整套取 env：端点只取 env LLM_BASE_URL。
//      config 里的自定义接入点（可能是过期残留，如 stale-config.example）绝不
//      压过 env ——env 密钥绝不发往 config 端点（修复前 cfgCustomBase 会泄漏）。
//   4) 无 key（key 参数为空且两侧皆无 key）→ 维持旧行为（env LLM_BASE_URL 或
//      网关默认）；上层因无 key 诚实降级，不发起真实调用。
// 返回值只含端点 URL，绝不包含任何密钥材料。
function resolveBaseUrl(key, opts) {
  if (opts && opts.baseUrl) return opts.baseUrl; // 显式调用配置（最高优先级，见上 1)
  const cfg = _loadCfg();
  if (configKeySet(cfg)) return cfgCustomBase(cfg.llm);          // 2) config key → config 端点
  if (envKeySet()) return String(process.env.LLM_BASE_URL || '').trim(); // 3) env key → env 端点
  return key ? '' : String(process.env.LLM_BASE_URL || '').trim();       // 4) 无 key：旧行为
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
