'use strict';
// =============================================================================
// 赛道级空白 (sector-whitespace.js) — 推理·分析合并计算层 · 算子 ⑥（最后）
// 文档 v0.5 · 第二部分 · 2.6 施工顺序第 6 条
//
// 职责：把"单品牌空白网格"(whitespace-grid) 提升为"赛道级空白"——
//   在竞争前沿内的「真缺失」(vacant) 上，叠加相邻品牌的「分层 × 规模」，
//   给出战略价值排序（大品牌环绕却空缺 = 高价值窗口；小品牌环绕 = 价值待验）。
//
// 设计铁律：
//   - 复用 whitespace-grid 的三态判定（vacant/unknown/dead/occupied），不重造。
//   - unknown（覆盖不足）与 dead（偏离前沿）格子**绝不**列为机会（忠实纪律）。
//   - 战略价值是「推断」(confidence=medium)，明确标注：价值取决于相邻大品牌是否
//     刻意跳过，非事实结论；需求侧仍需核验。
//   - 纯函数、无时钟/无网络/无随机。
// =============================================================================

const WG = require('./whitespace-grid.js');
const A = require('./aggregator.js');
const T = require('./tiering.js');

const VALUE_RANK = { high: 3, mid: 2, low: 1 };

function computeSectorWhitespace({ competitors, brandProfiles }) {
  const grid = WG.computeWhiteSpaceGrid(competitors);

  // 品牌画像（name → {scale, tier}），供相邻体量叠加。
  const profByName = {};
  if (brandProfiles && typeof brandProfiles === 'object') {
    for (const k of Object.keys(brandProfiles)) profByName[k] = brandProfiles[k];
  } else {
    const comps = (competitors || []).filter(c => c && c.status === 'done');
    for (const c of comps) {
      const p = A.brandProfileFromComp(c);
      profByName[c.name] = { scale: Number(p.scale.value) || 0, tier: p.tier.value };
    }
  }

  // 仅 vacant（竞争前沿内真缺失）进入机会评估
  const vacants = grid.cells.filter(cell => cell.state === 'vacant');
  const whitespace = vacants.map(cell => {
    // 相邻品牌：同一行 i 或同一列 j 的 occupied 格子里的品牌（即竞争前沿邻居）
    const neighbors = [];
    for (const other of grid.cells) {
      if (other.state === 'occupied' && (other.i === cell.i || other.j === cell.j)) {
        neighbors.push.apply(neighbors, other.occupants);
      }
    }
    const uniqueNeighbors = Array.from(new Set(neighbors));
    let adjScale = 0, maxTier = 0;
    for (const n of uniqueNeighbors) {
      const p = profByName[n];
      if (p) { adjScale += Number(p.scale) || 0; maxTier = Math.max(maxTier, T.tierRank(p.tier)); }
    }
    // 战略价值：相邻大品牌(≥large)或大规模 → high；mid 量级 → mid；仅小品牌 → low
    let strategicValue = 'low';
    if (adjScale >= 10_000_000 || maxTier >= 3) strategicValue = 'high';
    else if (adjScale >= 1_000_000 || maxTier >= 2) strategicValue = 'mid';

    return {
      i: cell.i, j: cell.j, state: 'vacant',
      adjacentBrands: uniqueNeighbors,
      adjacentScaleTotal: adjScale,
      adjacentMaxTier: maxTier,
      strategicValue,
      confidence: 'medium',     // 推断，非事实
      note: strategicValue === 'high'
        ? '大品牌环绕却空缺——高价值窗口（头部刻意跳过或尚未察觉），优先验证需求是否真实。'
        : '真缺失，但相邻仅中小品牌；价值待验，须核验需求侧是否真实存在。'
    };
  });

  // 价值降序（high→mid→low），同值按相邻规模降序，确定性。
  whitespace.sort((a, b) => {
    if (VALUE_RANK[a.strategicValue] !== VALUE_RANK[b.strategicValue]) return VALUE_RANK[b.strategicValue] - VALUE_RANK[a.strategicValue];
    return b.adjacentScaleTotal - a.adjacentScaleTotal;
  });

  return {
    grid,
    eligibleTotal: grid.eligibleTotal,
    unknownCells: grid.cells.filter(c => c.state === 'unknown').length,
    deadCells: grid.cells.filter(c => c.state === 'dead').length,
    occupiedCells: grid.cells.filter(c => c.state === 'occupied').length,
    vacantCount: whitespace.length,
    whitespace,
    confidence: whitespace.length ? 'medium' : 'unknown',
    note: '赛道级空白 = 竞争前沿内真缺失(vacant) + 相邻品牌分层×规模叠加的战略价值。unknown/dead 不列为机会。'
  };
}

module.exports = { computeSectorWhitespace, VALUE_RANK };
