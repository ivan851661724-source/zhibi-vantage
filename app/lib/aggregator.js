'use strict';
// =============================================================================
// 聚合器 + Sector 模型 (aggregator.js) — 推理·分析合并计算层 · 算子 ③
// 文档 v0.5 · 第二部分 · 2.6 施工顺序第 3 条（依赖算子①②的产物）
//
// 职责：把一组「品牌画像」(brand profiles) 聚合成「赛道事实」(sector facts)，
// 与 Report 解耦（Sector 模型独立、可单测、无外部依赖）。
//
// 设计铁律（红线 ① · 聚合不撒谎）：
//   赛道级数字的置信度，永远 ≤ 最弱贡献品牌样本的置信度。
//   即：任何一条赛道事实的 confidence = min(各贡献品牌对应维度的 confidence)。
//   绝不把「多数品牌高置信」平滑成「赛道高置信」而掩盖个别品牌是猜的。
//
// 其余红线：
//   ② 分层可复现（已在 tiering.js，本模块复用其输出）。
//   ③ 估算可审计（已在 sizing.js，本模块复用其 value/estimated/formula）。
//   ④ 时间线可溯源（timeline.js 负责；本模块不造时间线）。
//
// 确定性：纯函数，无网络/无时钟/无随机（generatedAt 由 API 层填，不进本模块）。
// =============================================================================

const T = require('./tiering.js');
const S = require('./sizing.js');

// 置信度排序（高→低）。用于「取最弱」：rank 越小越弱。
const CONF_RANK = { verified: 5, high: 4, medium: 3, low: 2, inferred: 1, unknown: 0, 'n/a': 0 };

function confRank(c) { return CONF_RANK[c] != null ? CONF_RANK[c] : 0; }
// 取一组置信度里「最弱」的那个（用于聚合不撒谎）。
function worstConf(list) {
  const arr = (Array.isArray(list) ? list : []).filter(c => c != null && c !== 'n/a');
  if (!arr.length) return 'unknown';
  return arr.slice().sort((a, b) => confRank(a) - confRank(b))[0];
}
function bestConf(list) {
  const arr = (Array.isArray(list) ? list : []).filter(c => c != null && c !== 'n/a');
  if (!arr.length) return 'unknown';
  return arr.slice().sort((a, b) => confRank(b) - confRank(a))[0];
}

// ---------------------------------------------------------------------------
// 品牌画像装配：brandProfileFromComp(comp)
// 把现有档案记录 + 分层器 + 体量估算器，组装成聚合器消费的标准画像。
// 每条维度都带 (value, confidence, basis)，贯彻「可溯源/不撒谎」。
// 现有 comp 缺结构化体量信号时，tiering/sizing 会诚实退化为 unknown/参考。
// ---------------------------------------------------------------------------
function brandProfileFromComp(comp) {
  if (!comp || typeof comp !== 'object') return null;
  const id = comp.id || comp.competitorId || comp.name;
  const name = comp.name || id;

  // 分层（算子①）
  const tierRes = T.classifyTier(T.signalsFromComp(comp));
  const tier = {
    value: tierRes.tier,
    confidence: tierRes.tier === 'unknown' ? 'unknown' : (comp._estimatedFromText ? 'low' : 'medium'),
    basis: tierRes.basis
  };

  // 体量估算（算子②）—— 需要流量/Shopify 信号，当前多缺，诚实退化为参考/无。
  const scaleSignals = {
    officialRevenue: comp.officialRevenue || null,
    monthlyVisits: comp.monthlyVisits || null,
    aov: comp.aov || null,
    conversionRate: comp.conversionRate || null,
    isShopify: !!comp.isShopify,
    priceBandMid: comp.priceBand && comp.priceBand.mid != null ? comp.priceBand.mid : null,
    productCount: comp.productCount || null,
    trafficTier: comp.trafficTier || (comp.channels && comp.channels.googleOrganic ? null : null)
  };
  const scale = S.estimateScale(scaleSignals);

  // 价格带
  const pb = comp.priceBand || {};
  const priceBand = {
    band: pb.band || null,
    mid: typeof pb.mid === 'number' ? pb.mid : null,
    confidence: pb.confidence || (pb.band ? 'medium' : 'unknown')
  };

  // 渠道矩阵（取 present 维度 + 其置信）
  const channels = {};
  const channelConfs = [];
  if (comp.channels && typeof comp.channels === 'object') {
    for (const k of Object.keys(comp.channels)) {
      const c = comp.channels[k] || {};
      const present = !!c.present;
      const conf = c.confidence || (present ? 'medium' : 'unknown');
      channels[k] = { present, confidence: conf };
      if (present) channelConfs.push(conf);
    }
  }

  // 口碑（若有评分）
  const reviewConf = comp.reviews && comp.reviews.rating != null ? 'medium' : 'unknown';

  // 品牌最弱样本置信（聚合不撒谎的「木桶短板」）
  const sampleConfidence = worstConf([
    tier.confidence, scale.confidence, priceBand.confidence, reviewConf,
    ...channelConfs, 'unknown'
  ]);

  return {
    id, name,
    tier, scale, priceBand, channels,
    sampleConfidence,
    _raw: comp
  };
}

// ---------------------------------------------------------------------------
// 核心：buildSector({ name, brands, marketCurrency })
// brands: brand profile 数组（可由 brandProfileFromComp 产出）。
// marketCurrency: 目标市场币种（如 'USD'，调用方从 relationship.marketCurrency(intent.regions) 取）。
//   传入时，detected 币种 ≠ 市场币种的品牌被剔除出集中度分母（永不做汇率换算，只剔除并计数）。
// 输出：Sector 模型（赛道事实，含集中度/价格带/渠道矩阵/覆盖率/规模/赛道置信）。
// ---------------------------------------------------------------------------
function buildSector({ name, brands, marketCurrency }) {
  const list = (Array.isArray(brands) ? brands : []).filter(Boolean);
  const brandCount = list.length;

  // ===== 集中度（CR3/CR5/HHI）=====
  // B-7a（2026-09-12 任务书）：币种过滤 + 覆盖门控。
  // 只剔 detected 且币种确证 ≠ 市场币种的（assumed 是按市场默认假定，不算污染）；
  // 模拟 S3 实证：1 家 CNY 混入可把 HHI 从 1846 抬到 7746。
  const eligible = marketCurrency
    ? list.filter(b => !(b._raw && b._raw.currencyBasis === 'detected' && b._raw.currency && b._raw.currency !== marketCurrency))
    : list;
  const currencyExcluded = list.length - eligible.length;
  const withScale = eligible.filter(b => b.scale && Number(b.scale.value) > 0);
  const scaleConfs = withScale.map(b => b.scale.confidence);
  const totalScale = withScale.reduce((s, b) => s + Number(b.scale.value), 0);
  let shares = [];
  if (totalScale > 0) {
    shares = withScale
      .map(b => ({ id: b.id, name: b.name, scale: Number(b.scale.value), share: Number(b.scale.value) / totalScale }))
      .sort((a, b) => b.share - a.share);
  }
  const topN = (n) => shares.slice(0, n).reduce((s, x) => s + x.share, 0);
  const hhi = shares.reduce((s, x) => s + Math.pow(x.share * 100, 2), 0); // 赫芬达尔指数（百分点平方）
  // 覆盖门控（模拟 S2 实证：低覆盖裸显示会产出 CR3=100% 假集中）：≥5 家有规模且覆盖 ≥60% 才 sufficient。
  // 前端显示判定一律用 sufficient，不得再用 HHI != null / hasData（那是"原始是否有数据"）。
  const sufficient = withScale.length >= 5 && withScale.length >= Math.ceil(0.6 * brandCount);
  const concentration = {
    hasData: withScale.length > 0,
    sufficient,
    currencyExcluded,
    basisNote: 'HHI 为建模代理口径（SKU 数 × 保守单量假设），非营收披露；仅反映相对份额',
    brandCountWithScale: withScale.length,
    brandCountNoScale: brandCount - withScale.length,
    shares,
    CR3: withScale.length >= 1 ? topN(3) : 0,
    CR5: withScale.length >= 1 ? topN(5) : 0,
    HHI: Math.round(hhi),
    hhiInterpretation: hhi > 2500 ? '高度集中' : hhi > 1500 ? '中等集中' : '分散',
    confidence: worstConf(scaleConfs),
    note: withScale.length < brandCount
      ? (brandCount - withScale.length) + ' 个品牌无规模信号，集中度仅反映已知 ' + withScale.length + ' 家，勿外推全覆盖。'
      : '全部品牌均有规模信号。'
  };

  // ===== 价格带分箱 =====
  const bandMap = {};
  for (const b of list) {
    const band = b.priceBand && b.priceBand.band ? b.priceBand.band : 'unknown';
    if (!bandMap[band]) bandMap[band] = { band, count: 0, brands: [], confs: [] };
    bandMap[band].count++;
    bandMap[band].brands.push(b.name);
    bandMap[band].confs.push(b.priceBand.confidence);
  }
  const priceBands = Object.keys(bandMap).sort().map(k => {
    const g = bandMap[k];
    return {
      band: g.band,
      count: g.count,
      share: brandCount ? g.count / brandCount : 0,
      brands: g.brands,
      confidence: worstConf(g.confs)
    };
  });

  // ===== 渠道 × 品牌矩阵 =====
  const channelKeys = new Set();
  for (const b of list) for (const k of Object.keys(b.channels || {})) channelKeys.add(k);
  const channelMatrix = {};
  for (const k of Array.from(channelKeys).sort()) {
    const present = [];
    const confs = [];
    for (const b of list) {
      const c = (b.channels || {})[k];
      if (c && c.present) { present.push(b.name); confs.push(c.confidence); }
    }
    channelMatrix[k] = {
      present,
      presentCount: present.length,
      coveragePct: brandCount ? present.length / brandCount : 0,
      confidence: worstConf(confs),
      note: present.length < brandCount ? (brandCount - present.length) + ' 家无该渠道数据。' : ''
    };
  }

  // ===== 覆盖率（各维度有多少品牌有可用数据）=====
  const coverage = {
    tier: pct(list.filter(b => b.tier && b.tier.value !== 'unknown').length, brandCount),
    scale: pct(withScale.length, brandCount),
    priceBand: pct(list.filter(b => b.priceBand && b.priceBand.band).length, brandCount),
    channels: pct(list.filter(b => Object.keys(b.channels || {}).length > 0).length, brandCount)
  };

  // ===== 赛道级规模估值 =====
  const scale = {
    total: totalScale,
    estimated: withScale.some(b => b.scale && b.scale.estimated),
    knownCount: withScale.length,
    unknownCount: brandCount - withScale.length,
    confidence: worstConf(scaleConfs),
    note: withScale.length < brandCount ? '赛道规模=已知品牌规模之和；缺规模信号的品牌未计入，下界偏保守。' : ''
  };

  // ===== 赛道置信（红线①：≤ 最弱品牌样本）=====
  const sectorConfidence = worstConf([
    concentration.confidence,
    ...priceBands.map(p => p.confidence),
    ...Object.keys(channelMatrix).map(k => channelMatrix[k].confidence),
    scale.confidence,
    ...list.map(b => b.sampleConfidence)
  ]);

  return {
    name: name || 'untitled-sector',
    brandCount,
    concentration,
    priceBands,
    channelMatrix,
    coverage,
    scale,
    sectorConfidence,
    // 诚实备注：哪些品牌 tier unknown（无法分层），单列出来不隐藏。
    unknownTierBrands: list.filter(b => !b.tier || b.tier.value === 'unknown').map(b => b.name)
  };
}

function pct(n, d) { return d ? n / d : 0; }

module.exports = {
  CONF_RANK,
  confRank,
  worstConf,
  bestConf,
  brandProfileFromComp,
  buildSector
};
