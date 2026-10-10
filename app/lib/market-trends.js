'use strict';
// ============================================================
// lib/market-trends.js —— 市场热度聚合（算法规格 §5.6 · 纯函数零依赖）
// 输入：trends.interestOverTime 的 5 年周级时序（0-100 相对值）。
//   · 滑动 4 周窗口算斜率：近 4 点均值 / 前 8 点均值 - 1；
//     变化 <±10% 视为「平」（死区即滞回带，防抖）；> +10% 涨 / < -10% 跌
//   · 品牌词/赛道词热度比值 → 声量评级（≥0.5 高 / ≥0.15 中 / 其余低，初值）
// 全部 C 级置信：0-100 是 Google 归一化相对指数，禁止表述为绝对搜索量；
// 均值比值是量级参考，不构成任何准入裁决（裁决仍走 S2/S3 结构化规则）。
// ============================================================

function meanOf(arr) {
  const v = (arr || []).filter(x => typeof x === 'number' && !isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

// result: trends.interestOverTime 的 ok 结果；opts.track: 赛道词（在 terms 中）
function summarize(result, opts) {
  const o = opts || {};
  const series = (result && result.series) || [];
  if (!series.length) return null;
  const trackTerm = String(o.track || '').trim();
  let trackIdx = series.findIndex(s => s.term === trackTerm);
  if (trackIdx < 0) trackIdx = 0; // 未指明赛道词时以第一个词为基准
  const track = series[trackIdx];
  const trackMeanAll = meanOf(track.values);
  if (trackMeanAll == null || trackMeanAll === 0) {
    return { track: track.term, verdict: 'flat', slopePct: null, brandRatios: [], window: result.time || '5y', granularity: result.granularity || null, basis: 'C', fetchedAt: result.fetchedAt, note: '赛道词无有效热度数据（词太新或样本为 0），不判定' };
  }
  // 滑动窗口斜率：近 4 点 vs 前 8 点
  const recent = track.values.slice(-4);
  const prev = track.values.slice(-12, -4);
  const mRecent = meanOf(recent), mPrev = meanOf(prev);
  let verdict = 'flat', slopePct = null;
  if (mRecent != null && mPrev != null && mPrev > 0) {
    slopePct = Math.round((mRecent / mPrev - 1) * 1000) / 10; // 保留 1 位小数
    if (slopePct > 10) verdict = 'up';
    else if (slopePct < -10) verdict = 'down';
  }
  // 品牌词/赛道词声量比值（全窗口均值比；全 0 品牌词 → 0）
  const brandRatios = [];
  for (let i = 0; i < series.length; i++) {
    if (i === trackIdx) continue;
    const m = meanOf(series[i].values);
    const ratio = m == null ? null : Math.round((m / trackMeanAll) * 1000) / 1000;
    const level = ratio == null ? null : (ratio >= 0.5 ? 'high' : ratio >= 0.15 ? 'medium' : 'low');
    brandRatios.push({ term: series[i].term, ratio, level });
  }
  return {
    track: track.term,
    verdict, slopePct,
    brandRatios,
    window: result.time || '5y',
    granularity: result.granularity || null,
    basis: 'C',
    fetchedAt: result.fetchedAt,
    note: '热度为 Google Trends 0-100 归一化相对值（C 级佐证），禁止解读为绝对搜索量',
  };
}

module.exports = { summarize, meanOf };
