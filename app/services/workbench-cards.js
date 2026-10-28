'use strict';
// ============================================================
// workbench-cards.js —— 工作台「竞品价格观察」卡（r4 §三）
//
// 唯一数据源：opportunity-foundation 的价格模块（真实商品页实抓，
// 带Evidence/Snapshot/观察时间）。纪律：
//   · 只有真实价格点才出卡片——没有价格点 → 卡片数量 0，缺口进 coverage；
//   · 单点价格只有「观察」卡，绝不画历史曲线、绝不生成涨跌判断；
//   · 市场区间只在 ≥2 家同币种同口径实抓价时给出（group.brandCount≥2）；
//   · 「推算影响面」没有完整输入（输入事实/推断方法/适用范围/可信度/证据）
//     一律不渲染 —— 本模块根本不产出 inference；
//   · 数据缺口（未采集/无价格点/使用上次数据）全部进 coverage 区，不进行动卡。
// ============================================================

const CACHE = new Map(); // `${tid}:${pid}` -> { at, payload }
const CACHE_TTL_MS = Math.max(0, Number(process.env.ZB_WB_CARDS_CACHE_MS || 60000));
const CACHE_MAX = 64;

function cacheGet(key) {
  if (!CACHE_TTL_MS) return null;
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_MS) { CACHE.delete(key); return null; }
  return e.payload;
}
function cacheSet(key, payload) {
  if (!CACHE_TTL_MS) return;
  if (CACHE.size >= CACHE_MAX) { const k0 = CACHE.keys().next().value; CACHE.delete(k0); }
  CACHE.set(key, { at: Date.now(), payload });
}

function rid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/**
 * 构建工作台观察卡。
 * @returns {{cards:Array, market:object|null, coverage:object, generatedAt:string}}
 */
function buildWorkbenchCards(tenantId, projectId, opts) {
  const tid = String(tenantId || '');
  const pid = String(projectId || '');
  const key = tid + ':' + pid;
  const cached = cacheGet(key);
  if (cached && !(opts && opts.fresh)) return cached;

  let cards = [];
  let market = null;
  let coverage = { totalBrands: 0, observedBrands: 0, missingPriceBrands: [], usingPreviousDataBrands: [], note: null };
  let foundationError = null;
  try {
    const F = require('./opportunity-foundation.js');
    const f = F.buildOpportunityFoundation(tid, pid);
    const scope = (f && f.brandScope) || {};
    coverage.totalBrands = Number(scope.total || 0);
    const pb = (f && f.modules && f.modules.priceBands) || null;
    const groups = (pb && Array.isArray(pb.groups)) ? pb.groups : [];
    for (const g of groups) {
      const rows = Array.isArray(g.rows) ? g.rows : [];
      // 市场区间：同币种 ≥2 家实抓价才允许（同口径 = 同一价格模块的直接观察）
      if (g.brandCount >= 2) {
        const mins = rows.map(r => r.priceMin).filter(v => typeof v === 'number');
        const maxs = rows.map(r => r.priceMax).filter(v => typeof v === 'number');
        if (mins.length && maxs.length) {
          market = {
            currency: g.currency, symbol: g.symbol || g.currency,
            min: Math.min.apply(null, mins), max: Math.max.apply(null, maxs),
            brandCount: g.brandCount,
            basis: '同币种在售商品实抓价格范围',
          };
        }
      }
      for (const r of rows) {
        if (r.priceComparable !== true || r.priceMedian == null) continue;
        const ref = (r.evidenceRefs || []).find(x => x && (x.evidenceId || x.snapshotId)) || null;
        cards.push({
          cardId: rid('wob'),
          kind: 'price_observation',
          brandId: r.brandId || null,
          competitorId: r.competitorId || null,
          brandName: r.name || '未知品牌',
          currency: r.currency || (g.currency || null),
          currencyStatus: r.currencyStatus || null,
          price: {
            median: r.priceMedian,
            min: r.priceMin,
            max: r.priceMax,
          },
          productCount: Number(r.productCount || 0),
          availableCount: Number(r.available || 0),
          soldOutCount: Number(r.soldOut || 0),
          observedAt: r.observedAt || null,
          usingPreviousData: !!r.usingPreviousData,
          lastSuccessAt: r.lastSuccessAt || null,
          source: { label: '官网在售商品页实抓', measurementMethod: 'direct_observation' },
          evidence: {
            count: Number(r.observationCount || (r.evidenceRefs || []).length || 0),
            first: ref ? { evidenceId: ref.evidenceId || null, snapshotId: ref.snapshotId || null, sourceUrl: ref.sourceUrl || null, observedAt: ref.observedAt || r.observedAt || null } : null,
          },
        });
      }
    }
    const observedIds = new Set(cards.map(c => c.competitorId).filter(Boolean));
    const list = Array.isArray(scope.list) ? scope.list : [];
    coverage.missingPriceBrands = list
      .filter(b => b && b.competitorId && !observedIds.has(b.competitorId))
      .map(b => b.name || b.competitorId);
    coverage.usingPreviousDataBrands = cards.filter(c => c.usingPreviousData).map(c => c.brandName);
    coverage.observedBrands = cards.length;
    coverage.note = coverage.missingPriceBrands.length
      ? '以下品牌尚未抓到可比较的公开价格（≠ 确认没有），不生成价格判断：' + coverage.missingPriceBrands.join('、')
      : null;
  } catch (e) {
    foundationError = '价格数据暂时无法汇总，请稍后重试。';
  }

  const payload = {
    cards,
    market,
    coverage,
    ...(foundationError ? { error: foundationError } : {}),
    generatedAt: new Date().toISOString(),
  };
  cacheSet(key, payload);
  return payload;
}

module.exports = { buildWorkbenchCards };
