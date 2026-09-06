'use strict';
// ============================================================
// material-engine.js — L3 材料引擎（架构总纲 v3 §3 L3）
//
// 每类决策 = 一份"域 Verdict 组合配方"（非通用 LLM）。
// Phase B 第一个场景：跟价材料（PRD 阶段 2）——对手降价/调价事件。
//
// 纪律（架构 v3 §3 / §6 Phase B 验收）：
//  1. 配方只能消费 enabled:true 域的 verdict（T4 护栏），其余域不出材料；
//  2. 材料 = 谁 + 什么动作 + 什么时候 + 依据来源（PRD §三）；
//  3. 推算的写清"为什么这么推"（basis），关键信息抓不到 → 缺域标注，绝不编造（PRD §五/§六）；
//  4. 材料里不出现"你应该降价/建议上新"——不替用户决定（PRD §六底线1）；
//  5. 只给竞品的数据，不收集用户成本/毛利（架构 v3 §10 R2：Me 层纯客户端）。
// ============================================================
const { makeDomainVerdict, makeEvidence } = require('./contract.js');
const registry = require('./domain-registry.js');

/** 材料统一契约 */
function material({ type, domain, subjectId, title, body, confidence, basis, evidenceIds, missingFields, at, brand, price, sources, inference }) {
  return {
    schema: 'Material@1',
    id: 'mat_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    type, // 材料类型（跟价 price-follow / 上新 product-launch / 渠道 channel-move / 口碑危机 review-crisis …）
    domain, // 来源域（仅 enabled 域可产出）
    subjectId,
    title,
    body,
    confidence, // high/medium/low
    basis, // "为什么这么推"
    evidenceIds: Array.isArray(evidenceIds) ? evidenceIds : [],
    missingFields: Array.isArray(missingFields) ? missingFields : [], // 缺域标注（显式，不编造）
    // P0-1 补齐（PRD 阶段 2「跟价材料做透」五要素）：price/sources/inference/brand
    brand: brand || null, // { name, url }
    price: price || null, // { old, new, deltaPct, currency, range:{min,max} }——old/deltaPct 无历史数据时显式 null，绝不编造涨跌
    sources: Array.isArray(sources) ? sources : [], // [{ label, url, tier }]
    inference: inference || null, // { text, why }——推算影响面，诚实标注
    at: at || new Date().toISOString(),
  };
}

/**
 * 跟价材料配方（Phase B 第一个场景）：
 * 消费 price 域 verdict 快照 → 逐对手产出「跟价材料」。
 * 输入 state.domainVerdicts.price（由 domain-runner 产出，仅 enabled 域）。
 * 说明：历史价回溯（history:60d）当前未采集 → 显式 missingFields 标注，绝不编造
 * 历史趋势；Phase 0 的 historyRetentionRate 门槛达标后此处自动补历史对比。
 */
function priceFollowRecipe(priceVerdict, opts) {
  if (!priceVerdict || priceVerdict.missing) return [];
  const prevPrices = (opts && opts.priceHistory) || {}; // { brandKey: [{at, display, confidence}] }
  const materials = [];
  for (const item of (priceVerdict.items || [])) {
    const brandKey = String(item.subjectId || '');
    const history = (prevPrices[brandKey] || []).slice(-3);
    const prev = history.length ? history[history.length - 1] : null;
    const changed = prev && prev.display !== item.claim && (prev.display !== item.claim.replace(/^.+价格区间 /, ''));
    // missingFields = 域缺字段（如 priceRange）+ 历史价未回溯（history:60d）——显式标注，绝不编造
    const missingFields = Array.from(new Set([
      ...(Array.isArray(item.missingFields) ? item.missingFields : []),
      ...(history.length ? [] : ['history:60d']),
    ]));
    materials.push(material({
      type: 'price-follow',
      domain: 'price',
      subjectId: item.subjectId,
      title: changed ? '对手价格变动' : '对手当前价格',
      body: item.claim,
      confidence: item.confidence || 'low',
      basis: item.basis || 'unverified',
      evidenceIds: item.evidenceIds || [],
      missingFields,
      // P0-1：五要素透传（brand/price/sources/inference 由 price 域 verdict 提供，无则空——前端统一空态，不编造）
      brand: item.brand || null,
      price: item.price || null,
      sources: item.sources || [],
      inference: item.inference || null,
    }));
  }
  return materials;
}

/**
 * 材料引擎入口：遍历 enabled 域，按配方产出材料。
 * 当前仅 price 域 enabled → 只产出跟价材料（Phase B 验收：只有价格域材料上线）。
 */
function buildMaterials(state, opts) {
  const out = { materials: [], domainsInUse: [] };
  const enabled = registry.enabledDomains();
  if (enabled.includes('price') && state && state.domainVerdicts && state.domainVerdicts.price) {
    out.materials = priceFollowRecipe(state.domainVerdicts.price, opts);
    out.domainsInUse.push('price');
  }
  // 未来：voice/channel/userReview/productMatrix 等域 enabled 后在此追加配方。
  return out;
}

module.exports = { buildMaterials, priceFollowRecipe, material };
