'use strict';
// ============================================================
// cost-profile.js —— 成本口径登记表（M4 任务 C，05 §16/§19）
//
// 05 §19 纪律：价格/额度类字段禁止写死未经采购确认的数字，成本以 provider
// dashboard / contract 为运行时事实源，由 cost_profile_version 管理。
// 本表登记的 'cp-eng-v0' 是**工程估算口径（非采购确认）**，数字全部与既有代码
// 常量同源，无任何新造费率：
//   · LLM ¥/1M tokens：in=1.0 / 缓存命中 in=0.02 / out=2.0 —— 直接引用
//     services/cost.js 的 PRICE 常量（不改其值，单一事实源）；
//   · 搜索 0.002 元/次 —— 与 research/search.js 的 SEARCH_COST_YUAN 默认值同源
//     （不 require search.js：services→research 反向依赖会成环，数字以注释锚定，
//     换价时两处需同步）；
//   · shopify_products_json=0（公开免费端点）、wigolo=0（自托管，search.js 既有口径）。
//
// estimated_cost 只用于 ExternalCallLedger（03 §20）归因观测：不参与
// cost_telemetry 记账、不改日预算（overDailyBudget）/配额（withinQuota）语义。
// 采购确认后应登记新版本（如 cp-proc-v1），不改写历史账本行。
// 数据真值规则：无条目 / 无法计价（如 LLM 缺 in-out 拆分）→ estimatedCost=null，绝不为 0。
// ============================================================
const cost = require('./cost.js');

const VERSION = 'cp-eng-v0';
// 与 research/search.js SEARCH_COST_YUAN 同源（¥/次，工程估算口径）：
// 同读 ZB_SEARCH_COST_YUAN 环境变量（与 search.js 的 `Number(env) || 0.002`
// 语义一致），避免运维设价后 cost_telemetry 与账本 estimated_cost 分叉（复审 I-2）。
function searchCostYuanPerCall() {
  return Number(process.env.ZB_SEARCH_COST_YUAN) || 0.002;
}
// 付费搜索族（search.js PROVIDER_ORDER 既有集合；wigolo 自托管单列 0）
const PAID_SEARCH_PROVIDERS = ['serper', 'brave', 'bocha', 'tavily'];

/**
 * estimate({provider, operation, requestUnits?}) → {estimatedCost, costProfileVersion}
 * - provider 'llm'：requestUnits 传 usage 对象（prompt_tokens / completion_tokens /
 *   prompt_cache_hit_tokens）——只有拆分齐备才可计价，传总数字或缺失 → null；
 * - 付费搜索族：requestUnits=次数（默认 1），单价 0.002 元/次；
 * - wigolo / shopify_products_json：0（免费路径可按 profile 记 0）；
 * - 无条目：{estimatedCost: null, costProfileVersion}（Missing signal is not zero）。
 */
function estimate({ provider, operation, requestUnits } = {}) {
  void operation; // 口径按 provider 登记；operation 保留在签名里供未来分 operation 条目
  const p = String(provider || '').toLowerCase();
  if (p === 'llm') {
    const u = requestUnits;
    if (!u || typeof u !== 'object') return { estimatedCost: null, costProfileVersion: VERSION };
    const PRICE = cost.PRICE; // 同源：与 services/cost.js 完全一致的计价常量
    const miss = ((u.prompt_tokens || 0) - (u.prompt_cache_hit_tokens || 0)) / 1e6 * PRICE.inMiss;
    const hit = (u.prompt_cache_hit_tokens || 0) / 1e6 * PRICE.inHit;
    const out = (u.completion_tokens || 0) / 1e6 * PRICE.out;
    return { estimatedCost: miss + hit + out, costProfileVersion: VERSION };
  }
  if (p === 'wigolo' || p === 'shopify_products_json') {
    return { estimatedCost: 0, costProfileVersion: VERSION };
  }
  if (PAID_SEARCH_PROVIDERS.includes(p)) {
    const n = Number.isFinite(requestUnits) && requestUnits > 0 ? requestUnits : 1;
    return { estimatedCost: searchCostYuanPerCall() * n, costProfileVersion: VERSION };
  }
  return { estimatedCost: null, costProfileVersion: VERSION };
}

module.exports = { VERSION, estimate };
