'use strict';
// ============================================================
// 空白地图 · 三态网格（真空位 / 未知 / 死区）
// ------------------------------------------------------------
// 它把「空白地图上的一块紫色阴影」拆成三件不同的事：
//   真空位 vacant   ：确认真的缺失——有对手占据相邻价位/定制化程度（在竞争前沿内），只是这个格子没人。可下注。
//   未知 unknown    ：覆盖不足——可定位对手（同时有价格+定制化程度）太少，无法确认这里到底有没有人。一律灰显，不可下注。
//   死区 dead       ：空白但偏离竞争前沿——其价位带与定制化程度带都无任何对手（结构性无机会，别人不在这玩有原因）。勿下注。
//   已占据 occupied ：有对手，不是空位。
//
// 忠实纪律：绝不让「没采到 / 偏离前沿」被涂成机会色；覆盖不足的格子灰显并标注分母。
// 纯函数、零外部依赖，可被单测直接 require。
// ============================================================

const MIN_CELL_COVERAGE = 3;          // 可定位对手 < 3 家 → 整张网格判为「未知·不可下注」
const GRID_N = 4;                      // 4×4 网格（价格 × 定制化程度）

function priceMidOf(c) {
  const pts = (c.pricePoints || []).filter(n => typeof n === 'number' && n > 0);
  if (pts.length) return pts.reduce((a, b) => a + b, 0) / pts.length;
  const r = c.priceBand && c.priceBand.range ? String(c.priceBand.range).match(/(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/) : null;
  if (r) return (+r[1] + +r[2]) / 2;
  return null;
}
function custScore(c) {
  return (c.customization && typeof c.customization.score === 'number') ? c.customization.score : null;
}
// 把 v 在 [lo,hi] 归一化后等分为 n 段，返回段下标 0..n-1
function bin(v, lo, hi, n) {
  if (hi <= lo) return Math.floor(n / 2);
  const t = (v - lo) / (hi - lo);
  return Math.max(0, Math.min(n - 1, Math.floor(t * n)));
}

function computeWhiteSpaceGrid(competitors, opts) {
  opts = opts || {};
  const minCell = opts.minCellCoverage != null ? opts.minCellCoverage : MIN_CELL_COVERAGE;
  const comps = (competitors || []).filter(c => c && c.status === 'done');
  // 可定位对手：同时有价格与定制化程度，才能放进 price×customization 的格子
  const elig = comps.filter(c => priceMidOf(c) != null && custScore(c) != null);
  const mids = elig.map(priceMidOf);
  const mn = mids.length ? Math.min(...mids) : 0;
  const mx = mids.length ? Math.max(...mids) : 1;
  // 每个可定位对手落格（与前端点位算法同归一化基准）
  const placed = elig.map(c => {
    const x = (mx > mn) ? (priceMidOf(c) - mn) / (mx - mn) * 100 : 50;
    const y = custScore(c);                 // 0–100，越高越定制
    return { name: c.name, i: bin(x, 0, 100, GRID_N), j: bin(100 - y, 0, 100, GRID_N), x, y };
  });
  const rowHas = new Array(GRID_N).fill(0), colHas = new Array(GRID_N).fill(0);
  placed.forEach(p => { rowHas[p.i]++; colHas[p.j]++; });

  const cells = [];
  for (let i = 0; i < GRID_N; i++) for (let j = 0; j < GRID_N; j++) {
    const occ = placed.filter(p => p.i === i && p.j === j).map(p => p.name);
    let state;
    if (occ.length > 0) state = 'occupied';
    else if (elig.length < minCell) state = 'unknown';
    else if (rowHas[i] > 0 || colHas[j] > 0) state = 'vacant';   // 在竞争前沿内 → 真缺失
    else state = 'dead';                                           // 价位带与定制带都无人 → 偏离前沿
    cells.push({ i, j, state, occupants: occ, eligibleTotal: elig.length, minCellCoverage: minCell });
  }
  return { cells, eligibleTotal: elig.length, minCellCoverage: minCell, priceMin: mn, priceMax: mx, gridN: GRID_N };
}

module.exports = { computeWhiteSpaceGrid, MIN_CELL_COVERAGE, GRID_N, priceMidOf, custScore, bin };
