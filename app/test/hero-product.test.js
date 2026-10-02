'use strict';
// 主推产品赛道锚定单测（Ovalware/OXO 实证修复）：
// 大牌 heroSku 候选混入赛道外产品时，与赛道词相关的 SKU 必须排前；
// 无命中时保持原序（禁空纪律，不剔除）；无赛道词时不排序。
const assert = require('node:assert');
const HP = require('../lib/hero-product.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

const baseComp = () => ({
  id: 'c1', name: 'OXO',
  productMatrix: { heroSku: ['OXO Good Grips Salad Spinner', 'OXO Cold Brew Coffee Maker', 'OXO Steel Spoon Rest'] },
});

t('赛道锚定：cold brew 赛道词命中的 SKU 排到主推首位', () => {
  const r = HP.heroProductInfer(baseComp(), 'cold brew coffee maker');
  assert.equal(r.heroProducts[0].name, 'OXO Cold Brew Coffee Maker');
  assert.equal(r.kind, 'verified');
});

t('赛道锚定：多关键词命中数多者优先（coffee + maker 同命中加权）', () => {
  const comp = baseComp();
  comp.productMatrix.heroSku = ['Coffee Maker Carafe', 'Cold Brew Coffee Maker', 'Salad Spinner'];
  const r = HP.heroProductInfer(comp, 'cold brew coffee maker');
  assert.equal(r.heroProducts[0].name, 'Cold Brew Coffee Maker');
  assert.ok(r.heroProducts[1].name.includes('Coffee Maker Carafe'));
});

t('无命中：保持原序不剔除（禁空纪律）', () => {
  const comp = { id: 'c2', name: 'X', productMatrix: { heroSku: ['经典款', '豪华款'] } };
  const r = HP.heroProductInfer(comp, 'cold brew coffee maker');
  assert.deepEqual(r.heroProducts.map(h => h.name), ['经典款', '豪华款']);
});

t('无赛道词：不排序，保持原序（行为不变）', () => {
  const r = HP.heroProductInfer(baseComp(), '');
  assert.deepEqual(r.heroProducts.map(h => h.name), ['OXO Good Grips Salad Spinner', 'OXO Cold Brew Coffee Maker', 'OXO Steel Spoon Rest']);
});

t('CJK 赛道词同样锚定（中文字面量参与匹配）', () => {
  const comp = { id: 'c3', name: '某牌', productMatrix: { heroSku: ['便携榨汁杯', '智能宠物饮水机Pro'] } };
  const r = HP.heroProductInfer(comp, '智能宠物饮水机');
  assert.equal(r.heroProducts[0].name, '智能宠物饮水机Pro');
});

t('单候选：无需排序，直接输出（禁空）', () => {
  const comp = { id: 'c4', name: 'Y', productMatrix: { heroSku: ['Salad Spinner'] } };
  const r = HP.heroProductInfer(comp, 'cold brew coffee maker');
  assert.equal(r.heroProducts.length, 1);
  assert.equal(r.heroProducts[0].name, 'Salad Spinner');
});

console.log('\n=== hero-product.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
