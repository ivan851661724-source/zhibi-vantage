'use strict';
// ============================================================
// lib/brand-market.js —— 品牌主要市场的唯一解析入口（SC-09 r3 §二）
// ------------------------------------------------------------
// 为什么必须有这一个函数：
//   品牌自身的 `market` 经常是空的（调研阶段没填），而项目 intent.regions[0]
//   才是用户当时选的目标市场。r2 之前各模块各读各的：
//     · collect-jobs.loadCompetitor 做了回退；
//     · first-collection.initialItemState 直接读 comp.market（没有回退）；
//     · brand-service 的广告覆盖投影也直接读 c.market；
//     · HTTP 手动刷新用的 comp 完全没回退。
//   结果：品牌无 market + 项目 US 时，首采判成「未确定市场 / 未配置」——
//   实际上应该是 US → out_of_coverage（TikTok 官方覆盖不含美国）。
//
// 唯一口径：
//   ① competitor.market 优先；
//   ② 无值回退 project intent.regions[0]；
//   ③ 交给 lib/tiktok-adlib.js 既有的国家/区域归一（区域词 → unknown，绝不猜国家）；
//   ④ 归一不出来 → unknown，既不判「无覆盖」，也不判「没有广告」。
//
// 注意：本模块只做**解析与归一**，不做任何覆盖结论之外的推断。
// ============================================================
const TikTok = require('./tiktok-adlib.js');

function clean(v) {
  return v == null ? '' : String(v).trim();
}

/**
 * 解析品牌主要市场。
 * @param {object} comp 竞品（可含 market）
 * @param {object} intent 项目 intent（可含 regions[]）
 * @returns {{ raw: string, source: 'competitor'|'project_intent'|'none',
 *             brandMarket: string|null, coverageState: 'covered'|'out_of_coverage'|'unknown',
 *             brandMarketCovered: boolean|null }}
 */
function resolveBrandMarket(comp, intent) {
  const compMarket = clean(comp && comp.market);
  const intentMarket = intent && Array.isArray(intent.regions) && intent.regions.length
    ? clean(intent.regions[0]) : '';
  const raw = compMarket || intentMarket || '';
  const source = compMarket ? 'competitor' : (intentMarket ? 'project_intent' : 'none');
  const cov = TikTok.marketCoverage(raw); // 区域词/空值 → unknown
  return {
    raw,
    source,
    brandMarket: cov.brandMarket,
    coverageState: cov.coverageState,
    brandMarketCovered: cov.brandMarketCovered,
  };
}

// 采集上下文用：返回「原始市场词」——保留区域词原文，交给采集侧既有归一逻辑
// （adapter 内部仍走 marketCoverage，区域词照样是 unknown，不会被猜成国家）。
function resolveMarketValue(comp, intent) {
  return resolveBrandMarket(comp, intent).raw;
}

// 把解析结果写回竞品上下文的副本（不修改入参）：采集/适配器统一使用
function withResolvedMarket(comp, intent) {
  const c = Object.assign({}, comp || {});
  const r = resolveBrandMarket(comp, intent);
  if (r.raw) c.market = r.raw;
  c.marketSource = r.source;
  return c;
}

module.exports = { resolveBrandMarket, resolveMarketValue, withResolvedMarket };
