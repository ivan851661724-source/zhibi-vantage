'use strict';
// market-trends 单测（算法规格 §5.6）：4 周窗口斜率 ±10% 死区 → 涨/跌/平；声量比评级；C 级纪律
const assert = require('node:assert');
const MT = require('../lib/market-trends.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}
// 构造周级时序：base 起伏 + 尾部 last4 序列
function series(terms, rows) {
  return { time: 'today 5-y', granularity: 'week', fetchedAt: '2026-10-04T00:00:00Z', series: terms.map((term, i) => ({ term, values: rows.map(r => r[i]) })) };
}

t('上涨：近 4 点均值显著高于前 8 点（> +10%）', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push([50]);
  for (let i = 0; i < 4; i++) rows.push([80]);
  const s = MT.summarize(series(['冷萃壶'], rows), { track: '冷萃壶' });
  assert.equal(s.verdict, 'up');
  assert.ok(s.slopePct > 10);
  assert.equal(s.basis, 'C');
  assert.match(s.note, /禁止解读为绝对搜索量/);
});

t('死区：±10% 以内视为平（滞回带防抖）', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push([50]);
  for (let i = 0; i < 4; i++) rows.push([53]); // +6%
  const s = MT.summarize(series(['冷萃壶'], rows), { track: '冷萃壶' });
  assert.equal(s.verdict, 'flat');
});

t('下跌：近 4 点均值显著低于前 8 点（< -10%）', () => {
  const rows = [];
  for (let i = 0; i < 8; i++) rows.push([60]);
  for (let i = 0; i < 4; i++) rows.push([30]);
  const s = MT.summarize(series(['冷萃壶'], rows), { track: '冷萃壶' });
  assert.equal(s.verdict, 'down');
});

t('声量比：品牌词/赛道词均值比 → high/medium/low（初值 0.5/0.15）', () => {
  // 赛道词均值 50；品牌 A 均值 50（ratio 1 → high）；B 均值 20（0.4 → medium）；C 均值 5（0.1 → low）
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push([50, 50, 20, 5]);
  const s = MT.summarize(series(['冷萃壶', 'BrandA', 'BrandB', 'BrandC'], rows), { track: '冷萃壶' });
  assert.deepEqual(s.brandRatios.map(b => b.level), ['high', 'medium', 'low']);
  assert.equal(s.brandRatios[0].ratio, 1);
});

t('赛道词全 0：不判定（词太新），不产生除零', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push([0, 10]);
  const s = MT.summarize(series(['新词赛道', 'BrandA'], rows), { track: '新词赛道' });
  assert.equal(s.verdict, 'flat');
  assert.equal(s.slopePct, null);
  assert.deepEqual(s.brandRatios, []);
});

t('空序列 → null（上游标未探测）', () => {
  assert.equal(MT.summarize({ series: [] }, { track: 'x' }), null);
  assert.equal(MT.summarize(null, { track: 'x' }), null);
});

console.log('\n=== market-trends.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
