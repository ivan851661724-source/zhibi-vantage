'use strict';
// ============================================================
// watch-price.test.js —— 单品价格比较语义纯函数单测（整改 §6）
// 可比较三条件：同商品身份 / 同币种 / 同规格签名；同价不记；
// 目录级比较不在此模块（watch-monitor 只把中位数记 Metric）。
// ============================================================
const assert = require('node:assert');
const { applyProductSnapshot, specSignatureOf, deltaPctOf } = require('../lib/watch-price.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + (e && e.message)); }
}

const entry = (over) => Object.assign({ subjectId: '42', currency: 'USD', specSignature: 'v2', price: 20, display: '20', at: '2026-10-24T00:00:00Z' }, over);

t('首次见到 → new-price（新价格发现，不算涨跌）', () => {
  const r = applyProductSnapshot(null, entry({}));
  assert.strictEqual(r.comparable, false);
  assert.strictEqual(r.event.kind, 'new-price');
});

t('同身份同币种同规格 + 价格变化 → changed（old/new/deltaPct）', () => {
  const prev = entry({ price: 30 });
  const r = applyProductSnapshot(prev, entry({ price: 27 }));
  assert.strictEqual(r.comparable, true);
  assert.strictEqual(r.event.kind, 'changed');
  assert.strictEqual(r.event.old, 30);
  assert.strictEqual(r.event.new, 27);
  assert.strictEqual(r.event.deltaPct, -10);
});

t('同价不记 → event null', () => {
  const r = applyProductSnapshot(entry({ price: 20 }), entry({ price: 20 }));
  assert.strictEqual(r.comparable, true);
  assert.strictEqual(r.event, null);
});

t('币种变化 → new-price，绝不跨币种算涨跌', () => {
  const r = applyProductSnapshot(entry({ price: 20, currency: 'USD' }), entry({ price: 25, currency: 'EUR' }));
  assert.strictEqual(r.comparable, false);
  assert.strictEqual(r.event.kind, 'new-price');
  assert.ok(/币种/.test(r.event.note));
});

t('规格签名变化（变体集/规格档位）→ new-price 不可直接比较', () => {
  const r = applyProductSnapshot(entry({ price: 20, specSignature: 'v2' }), entry({ price: 26, specSignature: 'v4' }));
  assert.strictEqual(r.comparable, false);
  assert.strictEqual(r.event.kind, 'new-price');
  assert.ok(/规格/.test(r.event.note));
});

t('新增/删除其他商品不影响原商品比较（身份由 subjectId 圈定，天然逐品独立）', () => {
  const prevA = entry({ subjectId: 'A', price: 20 });
  const r = applyProductSnapshot(prevA, entry({ subjectId: 'A', price: 22 }));
  assert.strictEqual(r.event.kind, 'changed', 'A 自己变价照常成事件');
  const r2 = applyProductSnapshot(null, entry({ subjectId: 'B', price: 100 }));
  assert.strictEqual(r2.event.kind, 'new-price', '新商品只走新价发现');
});

t('deltaPctOf：降价为负、old=0 → null', () => {
  assert.strictEqual(deltaPctOf(30, 27), -10);
  assert.strictEqual(deltaPctOf(20, 25), 25);
  assert.strictEqual(deltaPctOf(0, 5), null);
});

t('specSignatureOf：variantCount 缺失 → 空签名（不虚设规格）', () => {
  assert.strictEqual(specSignatureOf({ variantCount: 3 }), 'v3');
  assert.strictEqual(specSignatureOf({}), '');
  assert.strictEqual(specSignatureOf(null), '');
});

t('非法入参：缺 subjectId / 非法价 → 不记快照不产事件', () => {
  assert.deepStrictEqual(applyProductSnapshot(null, { price: 10 }), { comparable: false, event: null });
  assert.deepStrictEqual(applyProductSnapshot(null, entry({ price: -1 })), { comparable: false, event: null });
});

console.log('\n=== watch-price.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
