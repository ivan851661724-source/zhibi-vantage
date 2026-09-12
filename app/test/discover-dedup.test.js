'use strict';
// ============================================================
// discover-dedup.test.js —— B-6 D2 域级去重单测（2026-09-12 修订版回归）
// 初版 filter 写法三重错（任务书伪代码缺陷，实现方照抄踩中）：
//   1. seen.set(key, c) 替换后仍 return false → 被保留者误入 droppedDup →
//      brand_removed 广播还活着的品牌（前端删卡但数据还在，UI/数据不一致）；
//   2. 高分替换者被静默丢弃 → 最终永远留第一个，"保留 matchScore 最高"未发生；
//   3. 无 key（无 url 且无名）return true 放行——这条本来就对，锁定不回归。
// 修订版：先选最优建 map → 按 droppedIds 一次性过滤（research/dedupe.js）。
// keyFn 与 discover.js 调用点逐字一致：domainOf(url) || 归一化名。
// ============================================================
const assert = require('node:assert');
const { dedupeByDomain } = require('../research/dedupe.js');
const { domainOf } = require('../research/net.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

// 与 discover.js L319 完全相同的 keyFn
const keyFn = c => domainOf(c.url) || String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- 核心用例：3 家同域 ----------
t('3 家同域：只留 matchScore 最高者，dropped 恰为另两家（被保留者绝不进 dropped）', () => {
  const a = { id: 'a', name: 'BrandA', url: 'https://brand-a.com/about',  matchScore: 70 };
  const b = { id: 'b', name: 'BrandA Another', url: 'https://www.brand-a.com/shop', matchScore: 85 };
  const c = { id: 'c', name: 'BrandA Clone',  url: 'https://brand-a.com/blog', matchScore: 60 };
  const { kept, dropped } = dedupeByDomain([a, b, c], keyFn);
  // 三家 url 域名同为 brand-a.com（domainOf 剥 www），只能留一个，且必须是 85 分的 b
  assert.equal(kept.length, 1, 'kept 应只剩 1 家');
  assert.equal(kept[0].id, 'b', '留下的必须是 matchScore 最高的 b(85)，而非第一个 a(70)');
  assert.equal(dropped.length, 2, 'dropped 恰为 2 家');
  assert.deepEqual(dropped.map(d => d.id).sort(), ['a', 'c'], 'dropped = a + c');
  // 初版三重错之核心回归点：被保留者（b）绝不出现在 dropped 里
  assert.ok(!dropped.some(d => d.id === kept[0].id), '被保留者不得进入 dropped（否则 brand_removed 会广播活品牌）');
});

t('3 家同域：brand_removed 广播集合 = dropped，且kept id 不在广播中（UI/数据一致性）', () => {
  const a = { id: 'a', name: 'X', url: 'https://x.com', matchScore: 70 };
  const b = { id: 'b', name: 'X2', url: 'https://x.com', matchScore: 85 };
  const c = { id: 'c', name: 'X3', url: 'https://x.com', matchScore: 60 };
  const { kept, dropped } = dedupeByDomain([a, b, c], keyFn);
  const broadcastIds = dropped.map(d => d.id); // discover.js 按此集合发 brand_removed
  assert.equal(broadcastIds.length, 2);
  assert.ok(!broadcastIds.includes(kept[0].id), 'brand_removed 不得包含仍保留在数据里的品牌');
});

t('同域高分在中间出现：仍选最优，第一个(70)被换掉而非保留', () => {
  // 候选按 rankScore 降序 ≠ matchScore 降序 → 高分者可以出现在任意位置
  const a = { id: 'a', url: 'https://d.com', matchScore: 70 };
  const b = { id: 'b', url: 'https://d.com', matchScore: 95 };
  const { kept, dropped } = dedupeByDomain([a, b], keyFn);
  assert.equal(kept[0].id, 'b');
  assert.deepEqual(dropped.map(d => d.id), ['a']);
});

t('无 key（无 url 且无名）：原样保留，不参与去重', () => {
  const a = { id: 'a', name: '', url: '', matchScore: 70 };
  const b = { id: 'b', name: '', url: '', matchScore: 90 };
  const { kept, dropped } = dedupeByDomain([a, b], keyFn);
  assert.equal(kept.length, 2, '两家都放行');
  assert.equal(dropped.length, 0);
});

t('无 url 退化用归一化名：同名不同写法仍去重，异名不去重', () => {
  const a = { id: 'a', name: 'Nutra-Max!', url: '', matchScore: 70 };
  const b = { id: 'b', name: 'nutramax', url: '', matchScore: 85 }; // 归一化后同为 nutramax
  const c = { id: 'c', name: 'VetriScience', url: '', matchScore: 50 };
  const { kept, dropped } = dedupeByDomain([a, b, c], keyFn);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].id, 'b', '同归一化名留 85 分者');
  assert.deepEqual(dropped.map(d => d.id), ['a']);
});

t('不同域名互不影响，保序', () => {
  const a = { id: 'a', url: 'https://d1.com', matchScore: 40 };
  const b = { id: 'b', url: 'https://d2.com', matchScore: 95 };
  const c = { id: 'c', url: 'https://d3.com', matchScore: 60 };
  const { kept, dropped } = dedupeByDomain([a, b, c], keyFn);
  assert.deepEqual(kept.map(k => k.id), ['a', 'b', 'c'], '三个不同域全保留且保序');
  assert.equal(dropped.length, 0);
});

t('matchScore 缺失按 0 处理，不抛异常', () => {
  const a = { id: 'a', url: 'https://d.com' };          // 无 matchScore
  const b = { id: 'b', url: 'https://d.com', matchScore: 10 };
  const { kept, dropped } = dedupeByDomain([a, b], keyFn);
  assert.equal(kept[0].id, 'b');
  assert.deepEqual(dropped.map(d => d.id), ['a']);
});

t('空数组：kept/dropped 均为空', () => {
  const { kept, dropped } = dedupeByDomain([], keyFn);
  assert.equal(kept.length, 0);
  assert.equal(dropped.length, 0);
});

console.log(`discover-dedup.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
