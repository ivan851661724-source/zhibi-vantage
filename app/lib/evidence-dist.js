'use strict';
// ============================================================
// evidence-dist.js —— 全字段证据分布统计（PRD R6 诚实条数据源 · 纯函数可单测）
//
// 口径：对每个完成深研的竞品，统计一组标准字段的 basis 三态：
//   verified → 实查 | inferred → 推测 | unverified（含缺失）→ 未探测
// 统计字段：价格带 / 渠道（逐平台）/ 品类 / 上新节奏 / 口碑 / 规模 / 定位。
// 输出：{ verified, inferred, unverified, total, pct:{...}, byDim:{维度:{...}} }
// 空报告（0 家完成）→ total=0，三态占比均为 0（前端显示"暂无可统计字段"）。
// ============================================================

const BASIS_BUCKET = { verified: 'verified', inferred: 'inferred' };

function bucketOf(basis) {
  return BASIS_BUCKET[basis] || 'unverified'; // 缺失/未知一律归"未探测"（不编造）
}

function newCounters() {
  return { verified: 0, inferred: 0, unverified: 0, total: 0 };
}
function bump(c, basis) {
  const b = bucketOf(basis);
  c[b]++;
  c.total++;
}
function finalize(c) {
  const pct = (n) => (c.total ? Math.round((n / c.total) * 100) : 0);
  return {
    verified: c.verified, inferred: c.inferred, unverified: c.unverified, total: c.total,
    pct: { verified: pct(c.verified), inferred: pct(c.inferred), unverified: pct(c.unverified) },
  };
}

// 每竞品统计的字段清单：[维度名, 取值函数 → basis 或 null（跳过）]
function fieldExtractors(c) {
  return [
    ['价格', () => (c.priceField ? c.priceField.basis : null)],
    ['渠道', () => {
      const ch = c.channelFields || {};
      const keys = Object.keys(ch);
      if (!keys.length) return null;
      // 逐平台各计一格（basis 取该渠道字段裁决）
      return keys.map(k => ({ dim: '渠道·' + k, basis: ch[k] ? ch[k].basis : null }));
    }],
    ['上新节奏', () => (c.launchCadence ? c.launchCadence.basis : null)],
    ['口碑', () => (c.reviewField ? c.reviewField.basis : null)],
    ['规模', () => (c.estSize ? (c.estSizeBasis || 'inferred') : null)],
    ['定位', () => (c.positioning ? (c.positioningBasis === 'verified' ? 'verified' : 'inferred') : null)],
  ];
}

/**
 * 统计全字段证据分布。
 * state 需是 decorateState 之后的（priceField/channelFields/... 已挂载）。
 */
function evidenceDistribution(state) {
  const overall = newCounters();
  const byDim = {};
  const comps = (state && Array.isArray(state.competitors) ? state.competitors : [])
    .filter(c => c && c.status === 'done');
  const excluded = new Set(state && state.excluded || []);
  comps.forEach(c => { if (c.entityAmbiguous || c.categoryTearing) excluded.add(c.id); });

  for (const c of comps) {
    if (excluded.has(c.id)) continue; // 错配/低置信卡不进分母（与聚合口径一致）
    for (const [dim, get] of fieldExtractors(c)) {
      const v = get();
      const list = Array.isArray(v) ? v : [{ dim, basis: v }];
      for (const item of list) {
        if (!item || item.basis == null) continue; // 未研究的字段不计入（不算"未探测"证据）
        byDim[item.dim] = byDim[item.dim] || newCounters();
        bump(overall, item.basis);
        bump(byDim[item.dim], item.basis);
      }
    }
  }
  const byDimOut = {};
  for (const k of Object.keys(byDim)) byDimOut[k] = finalize(byDim[k]);
  return Object.assign(finalize(overall), { byDim: byDimOut });
}

module.exports = { evidenceDistribution, bucketOf };
