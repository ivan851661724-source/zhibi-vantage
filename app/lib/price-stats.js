'use strict';
// ============================================================
// lib/price-stats.js —— 价格类聚合算法（算法规格 20261003 §三 落地 · 纯函数零依赖）
// 客单价三件套：中位数 + 主力带(P25–P75) + 样本明细（参与/剔除/剔除清单）
// 铁律（规格 §三/§四）：
//   · 均值禁止用于客单价（$1 挂件 + $500 礼盒拉歪均值，中位数几乎不动）
//   · 双截尾 P5/P95，剔除明细逐条带原因（可申诉）
//   · 目标价不参与异常值清洗（基线 §19 / 算法规格 §6.3 冻结）：小样本不再使用
//     目标价×0.15 / ×3 先验剔除——用户参考价只参与后续价格关系判定，绝不改变
//     竞品原始价格统计、样本数量、异常剔除结果或价格带
//   · 已下架/全变体不可售不计入（不卖的东西不构成客单价）；免费品单列不计入
//   · 样本 <3 款：不裁决（价格带证据不足），不凑数（规格 3.1 第 5 步）
//   · 多峰分布（三座价格山）截尾救不了主体——按规格 3.0.2 第 1 步做线间断检测，
//     识别出多线且无销量权重时「主力线识别不出 = 不裁决」→ 待人工确认（规格 3.0.4 纪律）
//   · 币种 fail-closed：目标价与实抓币种不一致 → 不换算不裁决（换算制造精确假象）
// 判定（规格 3.0.2 第 5 步 / S3）：主力带中点 ∈ [目标价×0.7, ×1.3] → 同构；
//   带整体在上界外 → above（高端）；整体在下界外 → below（低端）；
//   其余（骑跨）→ partial（待人工确认，不自动裁决）。
// ============================================================

function medianOf(sorted) {
  const n = sorted.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
// 排序数组上的秩分位（0<=p<=1），确定性可复算（规格 5.1：禁用 K-means 等不稳定法）
function percentileOf(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

// items: mapShopifyItems 产物 [{title,type,minPrice,maxPrice,repPrice,soldOut}]
// opts.target: 用户目标价 {min,max,currency}（点值即 min=max；来自 intent.profile.priceBand）
// opts.currency: 本次实抓价格币种（竞品裁决币种）
function computePriceStats(items, opts) {
  opts = opts || {};
  const currency = opts.currency || null;
  const tb = (opts.target && typeof opts.target === 'object') ? opts.target : null;
  const tMin = tb && tb.min != null && isFinite(Number(tb.min)) && Number(tb.min) > 0 ? Number(tb.min) : null;
  const tMax = tb && tb.max != null && isFinite(Number(tb.max)) && Number(tb.max) > 0 ? Number(tb.max) : null;
  const target = (tMin != null || tMax != null) ? { min: tMin, max: tMax, currency: tb.currency || null } : null;
  const tMid = target ? ((target.min != null && target.max != null) ? (target.min + target.max) / 2 : (target.min != null ? target.min : target.max)) : null;
  // 币种不匹配预判：目标价锚（先验截尾/判定）对另一币种的数字无意义，一律不适用
  const currencyMismatch = !!(target && target.currency && currency
    && String(target.currency).toUpperCase() !== String(currency).toUpperCase());

  const all = (Array.isArray(items) ? items : []).filter(x => x && typeof x.repPrice === 'number' && !isNaN(x.repPrice));
  const free = all.filter(x => x.repPrice <= 0);                       // 免费品单列（不构成客单价）
  const onSale = all.filter(x => x.repPrice > 0 && !x.soldOut);        // 已下架/全变体不可售不计入
  const soldOut = all.filter(x => x.repPrice > 0 && !!x.soldOut);
  const dropList = [];

  let pool = onSale.slice().sort((a, b) => a.repPrice - b.repPrice);
  let truncatedBy = null;
  if (pool.length >= 20) {
    // 双截尾 P5/P95：各砍 5% 尾部（n=50 → 每侧 3 条，与规格 3.2 演算一致），逐条进剔除明细
    const k = Math.max(1, Math.round(pool.length * 0.05));
    for (let i = 0; i < k; i++) {
      const lo = pool[i], hi = pool[pool.length - 1 - i];
      if (lo) dropList.push({ title: String(lo.title || '').slice(0, 80), price: lo.repPrice, reason: 'P5 以下截尾' });
      if (hi && hi !== lo) dropList.push({ title: String(hi.title || '').slice(0, 80), price: hi.repPrice, reason: 'P95 以上截尾' });
    }
    pool = pool.slice(k, pool.length - k);
    truncatedBy = 'p5p95';
  }
  // 样本 <20：不做目标价驱动的异常剔除（基线 §19：目标价是比较对象，不是清洗规则）。
  // 描述性统计直接用全部在售样本（算法规格 §6.3：sample 3–19 谨慎使用极端值处理，
  // v0 一律不处理；「演算 / 待人工确认」降级随先验清洗一起移除）。

  const used = pool.map(x => x.repPrice);
  const enough = used.length >= 3;
  const median = enough ? medianOf(used) : null;
  const band = enough ? { min: percentileOf(used, 0.25), max: percentileOf(used, 0.75) } : null;

  // 多峰检测（规格 3.0.2 第 1 步）：相邻排序价差 > 中位价×2 视为线间断。
  // 无销量权重（S-A/S-B 未接入）时无法选主力线 → 不裁决（3.0.4：识别不出 = 不凑数）。
  let multiPeak = false;
  if (enough && used.length >= 6 && median > 0) {
    let lines = 1;
    for (let i = 1; i < used.length; i++) {
      if (used[i] - used[i - 1] > median * 2) lines++;
    }
    multiPeak = lines >= 2;
  }

  // ---- 判定 ----
  let verdict;
  if (!enough) {
    verdict = { code: 'insufficient', note: `有效价格样本 ${used.length} 款 < 3 款，价格带证据不足，不裁决（不凑数）`, pendingHuman: true };
  } else if (!target || tMid == null) {
    verdict = { code: 'no_target', note: '未提供目标价（intent.profile.priceBand），只出统计不判定', pendingHuman: false };
  } else if (currencyMismatch) {
    verdict = { code: 'undetermined', note: `目标价币种 ${target.currency} ≠ 实抓币种 ${currency}，不换算不裁决（fail-closed）`, pendingHuman: true };
  } else if (multiPeak) {
    verdict = { code: 'pending', note: '价格呈多峰分布（多条产品线），无销量权重识别不出主力线，按纪律不裁决、待人工确认', pendingHuman: true };
  } else {
    const mid = (band.min + band.max) / 2;
    const lo = tMid * 0.7, hi = tMid * 1.3;
    if (mid >= lo && mid <= hi) {
      verdict = { code: 'in_band', note: `主力带中点 ${mid} ∈ [${lo}, ${hi}]（目标价 ${tMid}×0.7~1.3）→ 价格带同构`, pendingHuman: false };
    } else if (band.min > hi) {
      verdict = { code: 'above', note: `主力带 [${band.min}, ${band.max}] 整体高于区间上界 ${hi} → 高端市场错位`, pendingHuman: false };
    } else if (band.max < lo) {
      verdict = { code: 'below', note: `主力带 [${band.min}, ${band.max}] 整体低于区间下界 ${lo} → 低端市场错位`, pendingHuman: false };
    } else {
      verdict = { code: 'partial', note: `主力带 [${band.min}, ${band.max}] 与目标区间 [${lo}, ${hi}] 部分重叠 → 待人工确认，不自动裁决`, pendingHuman: true };
    }
  }
  return {
    median,
    band,
    currency,
    basis: 'verified', // 无目标价驱动的清洗，统计基面一律 verified（截尾仅 P5/P95 均匀截尾）
    truncatedBy,                                              // null | 'p5p95'
    multiPeak,
    targetUsed: target ? { min: target.min, max: target.max, currency: target.currency } : null,
    sample: {
      total: all.length,        // 有 repPrice 的商品数
      onSale: onSale.length,    // 在售样本
      used: used.length,        // 截尾后参与统计
      dropped: dropList.length, // 剔除数（丢弃率 = 数据质量指标）
      soldOut: soldOut.length,  // 已下架/全变体不可售（不计入客单价）
      free: free.length,        // 免费品（单列）
      dropList                  // [{title, price, reason}] 可申诉明细
    },
    verdict
  };
}

module.exports = { computePriceStats, medianOf, percentileOf };
