'use strict';
// S2 结构化匹配分单测（算法规格 5.1 / 抓取需求 §1.1）：
//   匹配分 = 目标类目商品占比×0.6 + 标题关键词命中占比×0.4（结构化，不靠 LLM 猜）
//   未分类>40% 标演算；杂货铺（类目≥3 且目标类目<40%）→ 剔除；目标类目零命中 → 不判杂货铺
const assert = require('node:assert');
const S2 = require('../lib/s2-match.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}
const it = (type, title) => ({ type: type || '', title: title || 'T' });

t('匹配分公式：typeRatio×0.6 + titleHit×0.4', () => {
  // 8 款美妆（type=Beauty 全命中，标题含 beauty）+ 2 款手机壳（type/title 均不命中）→ 双比率 0.8
  const items = [];
  for (let i = 0; i < 8; i++) items.push(it('Beauty', 'Beauty lipstick set ' + i));
  for (let i = 0; i < 2; i++) items.push(it('Phone Case', 'Shockproof cover ' + i));
  const r = S2.computeS2Match(items, 'beauty makeup');
  assert.equal(r.typeRatio, 0.8);
  assert.equal(r.titleHitRatio, 0.8);
  assert.equal(r.score, 0.8);
  assert.equal(r.basis, 'verified');
});

t('ASCII 词边界：类目 Carpet 不被赛道词 car 误命中（子串陷阱）', () => {
  const items = [it('Carpet', 'Carpet cleaner'), it('Carpet', 'Carpet shampoo')];
  const r = S2.computeS2Match(items, 'car phone holder');
  assert.equal(r.typeRatio, 0, 'carpet ≠ car（词边界）');
});

t('CJK 赛道词对英文类目：类目零命中不判杂货铺，未分类>40% 标演算', () => {
  const items = [it('Beauty', 'lip gloss'), it('', 'no type here')];
  const r = S2.computeS2Match(items, '美妆');
  assert.equal(r.typeRatio, 0, '量到的零（语言不通也一样），但不是杂货铺依据');
  assert.equal(r.groceryStore, null, '目标类目零命中 → 无法判定，不误杀');
  assert.equal(r.unclassifiedShare, 0.5);
  assert.equal(r.basis, 'inferred', '未分类 50% > 40% → 演算降权');
});

t('杂货铺：类目 ≥3 且目标类目占比 <40% → groceryStore=true（剔除信号）', () => {
  const items = [it('Beauty'), it('Toys'), it('Kitchen'), it('Kitchen'), it('Toys')];
  const r = S2.computeS2Match(items, 'beauty');
  assert.equal(r.distinctTypes, 3);
  assert.equal(r.typeRatio, 0.2);
  assert.equal(r.groceryStore, true);
});

t('目标类目零命中：无法判定目标类目 → groceryStore=null（不误杀）', () => {
  const items = [it('Toys'), it('Kitchen'), it('Garden')];
  const r = S2.computeS2Match(items, 'beauty');
  assert.equal(r.groceryStore, null);
});

t('类目 <3 个：不判杂货铺（专注店铺不适用该规则）', () => {
  const items = [it('Beauty'), it('Kitchen')];
  const r = S2.computeS2Match(items, 'beauty');
  assert.equal(r.groceryStore, false, 'distinctTypes<3 → 不判（false 而非 true/null）');
});

t('未分类占比 >40% → 标演算降权（规格 5.1）', () => {
  const items = [it('Beauty'), it('Beauty'), it(''), it(''), it(''), it('')];
  const r = S2.computeS2Match(items, 'beauty');
  assert.equal(r.unclassifiedShare, 0.667);
  assert.equal(r.basis, 'inferred');
});

t('空 items / 无赛道词 → null / 不可判定', () => {
  assert.equal(S2.computeS2Match([], 'beauty'), null);
  const r = S2.computeS2Match([it('Beauty')], '');
  assert.equal(r.score, null);
  assert.equal(r.basis, 'unverified');
});

console.log('\n=== s2-match.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
