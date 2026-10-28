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
//  3. 推算的写清"为什么这么推"（basis）；没有完整输入（输入事实/推断方法/适用范围/可信度/可打开证据）不得标「推算」；
//     数据缺口（如 60 天历史价未采集）绝不包装成判断卡（r4 §三）；
//  4. 材料里不出现"你应该降价/建议上新"——不替用户决定（PRD §六底线1）；
//  5. 只给竞品的数据，不收集用户成本/毛利（架构 v3 §10 R2：Me 层纯客户端）。
// ============================================================
const { makeDomainVerdict, makeEvidence } = require('./contract.js');
const registry = require('./domain-registry.js');

/** 材料统一契约 */
function material({ type, domain, subjectId, title, body, confidence, basis, evidenceIds, missingFields, at, brand, price, sources, inference }) {
  return {
    schema: 'Material@1',
    // r4 §三：id 不再使用 mat_* 内部前缀（用户页面与用户 API 禁止内部工程词）
    id: 'obs_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
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
 * 跟价/观察材料配方（r4 §三 收口）：
 * 只消费真实价格点，绝不把「数据缺口」包装成判断卡。
 *   · 没有任何真实价格点（price.new == null）→ 不产出材料（旧版会产出
 *     只有 LLM 区间 + missingFields=['history:60d'] 的伪「跟价推算」卡，已移除）；
 *   · ≥2 个可比价格点（同品牌、同口径、不同时间）→ 「价格变化」材料（old/new/涨跌）；
 *   · 只有 1 个价格点 → 「价格观察」材料（品牌/当前价与币种/观察时间/来源/证据）；
 *   · missingFields 只保留域级缺字段，history:60d 缺口不再进入用户载荷
 *     （数据缺口由 /api/workbench/cards 的 coverage 区承载，不进行动卡）；
 *   · inference（推算影响面）只有在调用方提供完整输入（marketContext：
 *     ≥2 家同币种实抓价 + 用户定位锚点）时才渲染，否则恒为 null——
 *     没有输入事实/推断方法/适用范围/可信度/可打开证据时不得标「推算」。
 */
function priceFollowRecipe(priceVerdict, opts) {
  if (!priceVerdict || priceVerdict.missing) return [];
  const prevPrices = (opts && opts.priceHistory) || {}; // { brandKey: [{at, display, confidence}] }
  const marketContext = (opts && opts.marketContext) || null; // { brandCount, currency, min, max } —— ≥2 家同币种实抓价才允许传入
  const materials = [];
  for (const item of (priceVerdict.items || [])) {
    const brandKey = String(item.subjectId || '');
    const price = item.price || null;
    const pointNow = price && price.new != null ? price.new : null;
    const history = (prevPrices[brandKey] || []).slice(-3);
    const prev = history.length ? history[history.length - 1] : null;
    const prevPoint = prev ? Number(prev.display) : null;
    const currency = (price && price.currency) || null;

    // ① 没有真实价格点：不产出任何材料（数据缺口不进行动卡）
    if (pointNow == null) continue;

    // ② 两个可比价格点（同币种、可解析数值、数值不同）→ 价格变化材料
    const comparable = prevPoint != null && currency && prev.currency === undefined ? true : !!prevPoint;
    if (prevPoint != null && !Number.isNaN(prevPoint) && prevPoint !== pointNow) {
      const deltaPct = prevPoint ? Math.round(((pointNow - prevPoint) / prevPoint) * 1000) / 10 : null;
      materials.push(material({
        type: 'price-change',
        domain: 'price',
        subjectId: item.subjectId,
        title: pointNow < prevPoint ? '竞争品牌降价' : '竞争品牌涨价',
        body: item.claim || '',
        confidence: item.confidence || 'low',
        basis: item.basis || 'unverified',
        evidenceIds: item.evidenceIds || [],
        missingFields: Array.isArray(item.missingFields) ? item.missingFields.filter(f => f !== 'history:60d') : [],
        brand: item.brand || null,
        price: Object.assign({}, price, { old: prevPoint, new: pointNow, deltaPct }),
        sources: item.sources || [],
        inference: null, // 影响面推算需完整输入（marketContext + 定位锚点），此处不臆测
        at: (item.observedAt) || undefined,
      }));
      continue;
    }

    // ③ 只有最新价格点 → 竞品价格观察（中性卡，不判断涨跌、不给区间）
    materials.push(material({
      type: 'price-observation',
      domain: 'price',
      subjectId: item.subjectId,
      title: '竞品价格观察',
      body: item.claim || '',
      confidence: item.confidence || 'low',
      basis: item.basis || 'unverified',
      evidenceIds: item.evidenceIds || [],
      missingFields: Array.isArray(item.missingFields) ? item.missingFields.filter(f => f !== 'history:60d') : [],
      brand: item.brand || null,
      price: Object.assign({}, price, { old: null, deltaPct: null, range: null }),
      sources: item.sources || [],
      inference: null,
      at: (item.observedAt) || undefined,
    }));
  }
  // ④ 市场区间：只在 ≥2 家同币种实抓价时随材料透传（由调用方 marketContext 保证），
  //    单品牌价格绝不生成市场区间。
  if (materials.length && marketContext && marketContext.brandCount >= 2) {
    for (const m of materials) {
      if (m.price && !m.price.range) m.price.range = { min: marketContext.min, max: marketContext.max, marketBrandCount: marketContext.brandCount };
    }
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
    out.materials = priceFollowRecipe(state.domainVerdicts.price, Object.assign({}, opts, { marketContext: (opts && opts.marketContext) || null }));
    out.domainsInUse.push('price');
  }
  // 未来：voice/channel/userReview/productMatrix 等域 enabled 后在此追加配方。
  return out;
}

module.exports = { buildMaterials, priceFollowRecipe, material };
