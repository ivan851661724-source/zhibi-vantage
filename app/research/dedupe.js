'use strict';
// ============================================================
// dedupe.js —— B-6 D2 域级去重（2026-09-12 任务书修订版写法）
// 初版 filter 写法三重错（9/12 评审复盘）：
//   1. seen.set(key, c) 替换后仍 return false → 被保留者误入 brand_removed
//      广播（前端删卡但数据还在，UI/数据不一致）；
//   2. 高分替换者被静默丢弃 → 最终永远留第一个；
//   3. 候选按 rankScore 降序 ≠ matchScore 降序，"第一个即最优"不成立。
// 修订版：先选最优建 map，再按 droppedIds 一次性过滤。
// 纯函数、无 IO——单测见 test/discover-dedup.test.js。
// ============================================================

/**
 * 同 key（域名 / 归一化名）只保留 matchScore 最高者。
 * @param {Array<{id:string, matchScore?:number}>} competitors 候选数组（会被读取，不被修改）
 * @param {(c:object)=>string} keyFn 取去重键；返回空串/falsy 表示无 key，不参与去重、原样保留
 * @returns {{kept: Array, dropped: Array}} kept 保序且留下的必是各 key 最优；dropped 严格只含真正被丢弃者
 */
function dedupeByDomain(competitors, keyFn) {
  const bestByKey = new Map();
  const dropped = [];
  for (const c of competitors) {
    const key = keyFn(c);
    if (!key) continue; // 无 key（无 url 且无名）者不参与去重，原样保留
    const prev = bestByKey.get(key);
    if (!prev) { bestByKey.set(key, c); continue; }
    if ((c.matchScore || 0) > (prev.matchScore || 0)) { bestByKey.set(key, c); dropped.push(prev); }
    else { dropped.push(c); }
  }
  const droppedIds = new Set(dropped.map(d => d.id));
  return { kept: competitors.filter(c => !droppedIds.has(c.id)), dropped };
}

module.exports = { dedupeByDomain };
