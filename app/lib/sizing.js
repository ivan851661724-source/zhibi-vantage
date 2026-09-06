'use strict';
// =============================================================================
// 体量估算器 (sizing.js) — 推理·分析合并计算层 · 算子 ②
// 文档 v0.5 · 第二部分 · 2.6 施工顺序第 2 条（依赖算子①分层器的信号分级）
//
// 职责：把可用的「体量信号」交叉估值为品牌年化营收规模（USD）。
//
// 设计铁律（红线 3 · 估算可审计）：
//   1) 每条估值都必须能「展开」成 公式 + 输入信号，供用户复核（不黑箱）。
//   2) 多信号交叉 → 建模估值（basis=modeled）；单信号 → 只给参考（basis=reference）。
//   3) 无信号 → 不输出（value=null），绝不编造。
//   4) 凡是「算出来」而非「官方披露」的数字，系统自动打 estimated=true 标签，
//      输出层据此渲染「估算」角标，不伪装成事实。
//   5) 多模型交叉：当两种独立模型结果差距 > 2×，取较保守（低）者并标注冲突，
//      贯彻「聚合不撒谎」精神。
//
// 信号优先级（与分层器一致，营收估算语境）：
//   官方披露营收  >  流量×客单价×转化  >  Shopify端点×价格带  >  单弱信号(参考)
// =============================================================================

const DEFAULT_CONVERSION = 0.02; // 无转化信号时的保守默认（DTC 行业下限）

// 标准空信号（调用方按需填值）。
function emptyScaleSignals() {
  return {
    officialRevenue: null,   // 官方披露年化营收 (USD)
    monthlyVisits: null,     // 月访问量（Similarweb 类）
    aov: null,               // 平均客单价 (USD)
    conversionRate: null,    // 转化率 0..1
    isShopify: false,        // 是否 Shopify 自建站
    priceBandMid: null,      // 价格带中点 (USD)
    productCount: null,      // 在售 SKU 数
    trafficTier: null        // 'high'|'mid'|'low'|'none'（单弱信号参考用）
  };
}

// 流量模型：monthlyVisits × conversion × aov × 12
function trafficModel(s) {
  const visits = Number(s.monthlyVisits);
  if (!(visits > 0)) return null;
  const conv = Number(s.conversionRate) > 0 ? Number(s.conversionRate) : DEFAULT_CONVERSION;
  const aov = Number(s.aov);
  if (!(aov > 0)) return null; // 缺客单价则流量模型不完整
  const annual = visits * conv * aov * 12;
  return {
    value: Math.round(annual),
    formula: 'monthlyVisits(' + visits + ') × conversion(' + conv + ') × aov(' + aov + ') × 12',
    inputs: { monthlyVisits: visits, conversionRate: conv, aov: aov },
    complete: true
  };
}

// Shopify 模型：粗估月订单 = productCount 的某种活跃度 × 价格带中点
// 极简保守假设：月均订单 ≈ productCount × 8（长尾低频），年化 = ×价格带中点 ×12。
function shopifyModel(s) {
  if (!s.isShopify) return null;
  const pc = Number(s.productCount);
  const mid = Number(s.priceBandMid);
  if (!(pc > 0) || !(mid > 0)) return null;
  const monthlyOrders = pc * 8; // 保守：每 SKU 月均 8 单
  const annual = monthlyOrders * mid * 12;
  return {
    value: Math.round(annual),
    formula: 'productCount(' + pc + ') × 8(保守月单/SKU) × priceBandMid(' + mid + ') × 12',
    inputs: { productCount: pc, priceBandMid: mid, assumedMonthlyOrdersPerSku: 8 },
    complete: true
  };
}

// 单弱信号参考：只给粗略档位，不给精确点估。
function referenceBand(s) {
  // 仅流量档位 / 社媒等弱信号可用时，给 coarse 区间中点 + 明确 reference。
  const TIER_MID = { high: 20_000_000, mid: 8_000_000, low: 1_000_000 };
  if (s.trafficTier && TIER_MID[s.trafficTier]) {
    return {
      value: TIER_MID[s.trafficTier],
      formula: '单弱信号(trafficTier=' + s.trafficTier + ') → 粗略档位中点，仅参考',
      inputs: { trafficTier: s.trafficTier },
      complete: false
    };
  }
  return null;
}

// =============================================================================
// 核心：estimateScale(signals)
// 输出结构（可审计）：{ value, basis, method, formula, inputs, confidence,
//                      estimated, note }
//   value=null 表示「无信号，不输出」。
// =============================================================================
function estimateScale(signals) {
  const s = Object.assign(emptyScaleSignals(), signals || {});

  // 1) 官方披露 → 直接采用，非估算。
  if (Number(s.officialRevenue) > 0) {
    return {
      value: Math.round(Number(s.officialRevenue)),
      basis: 'official',
      method: 'official',
      formula: 'officialRevenue(直接披露)',
      inputs: { officialRevenue: Math.round(Number(s.officialRevenue)) },
      confidence: 'high',
      estimated: false,
      note: '官方披露营收，直接采用，非估算。'
    };
  }

  // 2) 建模：流量模型 与 Shopify 模型 独立计算。
  const tm = trafficModel(s);
  const sm = shopifyModel(s);
  const models = [];
  if (tm) models.push({ name: 'traffic', ...tm });
  if (sm) models.push({ name: 'shopify', ...sm });

  if (models.length >= 2) {
    // 交叉：差距 > 2× 取保守（低）值并标注冲突。
    const vals = models.map(m => m.value);
    const hi = Math.max.apply(null, vals), lo = Math.min.apply(null, vals);
    const conflict = hi > lo * 2;
    const chosen = conflict ? lo : Math.round((hi + lo) / 2);
    const usedNames = models.map(m => m.name).join('+');
    return {
      value: chosen,
      basis: 'modeled',
      method: 'cross(' + usedNames + ')',
      formula: models.map(m => '[' + m.name + '] ' + m.formula).join(' ; '),
      inputs: Object.assign({}, ...models.map(m => m.inputs)),
      confidence: conflict ? 'low' : 'medium',
      estimated: true,
      note: conflict
        ? '双模型结果差距 >2×（' + hi.toLocaleString('en-US') + ' vs ' + lo.toLocaleString('en-US') + '），取保守低值，置信降级。'
        : '双独立模型交叉估值，取均值。'
    };
  }

  if (models.length === 1) {
    const m = models[0];
    return {
      value: m.value,
      basis: 'modeled',
      method: m.name,
      formula: m.formula,
      inputs: m.inputs,
      confidence: m.complete ? 'medium' : 'low',
      estimated: true,
      note: '单模型估值（' + m.name + '），缺交叉信号，置信中等偏下。'
    };
  }

  // 3) 单弱信号 → 参考档位（basis=reference，明确非点估）。
  const rb = referenceBand(s);
  if (rb) {
    return {
      value: rb.value,
      basis: 'reference',
      method: 'reference',
      formula: rb.formula,
      inputs: rb.inputs,
      confidence: 'low',
      estimated: true,
      note: '仅单弱信号可用，给粗略参考档位，不可当点估。'
    };
  }

  // 4) 无任何信号 → 不输出。
  return {
    value: null,
    basis: 'none',
    method: 'none',
    formula: '',
    inputs: {},
    confidence: 'n/a',
    estimated: false,
    note: '无可用体量信号，不估算（不臆测）。'
  };
}

// 把规模估值映射到粗略档位（供分层器/聚合器复用描述）。
function scaleBand(value) {
  const v = Number(value);
  if (!(v > 0)) return 'unknown';
  if (v >= 50_000_000) return 'large';
  if (v >= 5_000_000) return 'mid';
  return 'small';
}

// =============================================================================
// 数据卫生③：离谱值 sanity —— 量级声称与营收口径 / 微品牌自述矛盾 → 降级
// 纯函数，可单测；保守策略：宁可漏判，不可误伤（误伤会错误降级真实数据）。
// =============================================================================

// 从自由文本估算规模描述中解析出 USD 量级数值（仅认 USD 语境，避免跨币种误判）。
// 返回 number(USD) 或 null。
function parseRevenueText(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.toLowerCase();
  // 必须出现明确的钱/量级语境，否则不解析（避免把"2k employees"当营收）
  const hasMoneyCtx = /\$|usd|dollar|revenue|sales|annual|turnover|million|billion|\bb\b/.test(t);
  if (!hasMoneyCtx) return null;
  const m = t.match(/([\d][\d.,]*)\s*(k|m|mm|million|b|bn|billion)?/);
  if (!m) return null;
  let num = parseFloat(m[1].replace(/,/g, ''));
  if (!(num > 0)) return null;
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'k') num *= 1e3;
  else if (unit === 'm' || unit === 'mm' || unit === 'million') num *= 1e6;
  else if (unit === 'b' || unit === 'bn' || unit === 'billion') num *= 1e9;
  // 无单位但带 $ 也按原值（已隐含美元）
  return num;
}

const TIER_BAND = { large: 2, mid: 1, small: 0, emerging: 0, unknown: -1 };
const BAND_TO_TIER = { large: 'large', mid: 'mid', small: 'small', unknown: 'unknown' };

// 返回 { flagged:bool, note:string }。tier∈{large,mid,small,emerging,unknown}，estSizeText 自由文本。
function sanityScaleVsTier(tier, estSizeText) {
  const usd = parseRevenueText(estSizeText);
  if (usd != null) {
    const band = scaleBand(usd); // large/mid/small/unknown
    const tb = TIER_BAND[tier];
    const bb = TIER_BAND[BAND_TO_TIER[band] || 'unknown'];
    // 仅当相差 ≥2 档（large↔small 两端）才判离谱，避免温和误差误伤
    if (tb != null && bb != null && tb >= 0 && bb >= 0 && Math.abs(tb - bb) >= 2) {
      return { flagged: true, note: `量级离谱：宣称 ${tier} 但营收口径约 ${band}（≈${usd.toLocaleString('en-US')} USD），已降级置信` };
    }
  }
  // 文本自述矛盾：tier 为 large/mid 却自称个人/夫妻店/无营收
  if (tier === 'large' || tier === 'mid') {
    if (/(个人|夫妻店|个体|sole proprietor|one person|single person|hobby|no revenue|not a (real )?company|freelance|just me|mom and pop)/i.test(estSizeText || '')) {
      return { flagged: true, note: `量级离谱：宣称 ${tier} 但自述为个人/小微，已降级置信` };
    }
  }
  return { flagged: false };
}

module.exports = {
  DEFAULT_CONVERSION,
  emptyScaleSignals,
  estimateScale,
  scaleBand,
  parseRevenueText,
  sanityScaleVsTier,
  trafficModel,
  shopifyModel
};
