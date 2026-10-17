'use strict';
// ============================================================
// price-stats-clean.test.js —— 基线 §19 / 算法规格 §6.3 回归：
// 用户参考价（目标价）只参与价格关系判定，绝不改变竞品原始价格统计。
// 只改变目标价时必须不变：竞品原始样本、dropList、median、band；
// 允许变化：最终竞争关系判定（verdict）。
// ============================================================
const assert = require('assert');
const { computePriceStats } = require('../lib/price-stats.js');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('ok ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n  ' + String(e && e.message || e)); }
}

const ITEMS = [
  { title: '引流小样', repPrice: 2.5, soldOut: false },
  { title: 'S1', repPrice: 18, soldOut: false },
  { title: 'S2', repPrice: 22, soldOut: false },
  { title: 'S3', repPrice: 25, soldOut: false },
  { title: 'S4', repPrice: 28, soldOut: false },
  { title: 'S5', repPrice: 32, soldOut: false },
  { title: 'S6', repPrice: 35, soldOut: false },
  { title: 'S7', repPrice: 45, soldOut: false },
  { title: 'S8', repPrice: 900, soldOut: false }, // 极端值：旧实现会被目标价×3 清洗掉
];

(async () => {

  await t('小样本：只改目标价 → 原始样本数与参与统计数不变', () => {
    const a = computePriceStats(ITEMS, { target: { min: 20, max: 40, currency: 'USD' }, currency: 'USD' });
    const b = computePriceStats(ITEMS, { target: { min: 200, max: 400, currency: 'USD' }, currency: 'USD' });
    assert.strictEqual(a.sample.total, b.sample.total);
    assert.strictEqual(a.sample.used, b.sample.used, '参与统计样本不得随目标价变化');
    assert.strictEqual(a.sample.dropped, b.sample.dropped, '剔除数不得随目标价变化');
    assert.strictEqual(a.sample.used, ITEMS.length, '小样本不再做目标价驱动的剔除（900 元极端值保留）');
  });

  await t('小样本：dropList / median / band 与目标价无关', () => {
    const a = computePriceStats(ITEMS, { target: { min: 20, max: 40, currency: 'USD' }, currency: 'USD' });
    const b = computePriceStats(ITEMS, { target: { min: 500, max: 800, currency: 'USD' }, currency: 'USD' });
    assert.deepStrictEqual(a.sample.dropList, b.sample.dropList, 'dropList 不得随目标价变化');
    assert.strictEqual(a.median, b.median);
    assert.deepStrictEqual(a.band, b.band);
    assert.strictEqual(a.basis, 'verified', '统计基面不再因先验清洗降级为 inferred');
  });

  await t('小样本：目标价驱动的 ×0.15/×3 清洗已移除（有目标价也不剔）', () => {
    // 目标价中点 30 → 旧规则会剔除 2.5（<4.5）与 900（>90）；现在必须全保留
    const r = computePriceStats(ITEMS, { target: { min: 20, max: 40, currency: 'USD' }, currency: 'USD' });
    assert.strictEqual(r.sample.dropped, 0);
    assert.strictEqual(r.truncatedBy, null);
    assert.strictEqual(r.sample.used, ITEMS.length);
  });

  await t('允许变化：目标价改变可改变竞争关系判定（verdict）', () => {
    const FLAT = [
      { title: 'A', repPrice: 26, soldOut: false },
      { title: 'B', repPrice: 28, soldOut: false },
      { title: 'C', repPrice: 30, soldOut: false },
      { title: 'D', repPrice: 32, soldOut: false },
    ];
    const lo = computePriceStats(FLAT, { target: { min: 100, max: 140, currency: 'USD' }, currency: 'USD' });
    const hi = computePriceStats(FLAT, { target: { min: 20, max: 40, currency: 'USD' }, currency: 'USD' });
    assert.strictEqual(hi.verdict.code, 'in_band');
    assert.strictEqual(lo.verdict.code, 'below', '参考价不同 → 关系判定允许不同（统计仍相同）');
    assert.strictEqual(lo.median, hi.median);
    assert.deepStrictEqual(lo.band, hi.band);
  });

  await t('≥20 样本：P5/P95 双截尾行为不回归（与目标价无关）', () => {
    const big = [];
    for (let i = 0; i < 40; i++) big.push({ title: 'X' + i, repPrice: 10 + i, soldOut: false });
    const a = computePriceStats(big, { target: { min: 20, max: 40, currency: 'USD' }, currency: 'USD' });
    const b = computePriceStats(big, { target: { min: 900, max: 1200, currency: 'USD' }, currency: 'USD' });
    assert.strictEqual(a.truncatedBy, 'p5p95');
    assert.strictEqual(a.sample.used, b.sample.used);
    assert.deepStrictEqual(a.sample.dropList, b.sample.dropList);
    assert.strictEqual(a.median, b.median);
  });

  await t('币种不匹配：不换算不裁决的 fail-closed 不回归', () => {
    const r = computePriceStats(ITEMS, { target: { min: 20, max: 40, currency: 'CNY' }, currency: 'USD' });
    assert.strictEqual(r.verdict.code, 'undetermined');
  });

  console.log(failed ? `\nprice-stats-clean.test: ${failed} failed` : '\nprice-stats-clean.test: all passed');
  process.exit(failed ? 1 : 0);
})();
