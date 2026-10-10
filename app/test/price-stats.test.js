'use strict';
// price-stats 单测（算法规格 20261003 §三 落地）：
//   · 文档 3.2 A 品牌演算例：60→50 有效→P5/P95 剔 6→中位数 $28 / 主力带 $19–42 / 44 款计入
//   · 文档 3.0 泡泡玛特多峰例：三座价格山 → 无销量权重识别不出主力线 → 不裁决（pending）
//   · 先验截尾（<20 样本）标演算、判定降级待人工确认；样本 <3 不裁决；币种 fail-closed
const assert = require('node:assert');
const PS = require('../lib/price-stats.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}
const item = (price, extra) => Object.assign({ title: 'P' + price, repPrice: price, soldOut: false }, extra || {});

// 复刻文档 3.2：50 款（3 低尾 + 44 主体 + 3 高尾），目标价 $50
const aBrand = () => {
  const lows = [1.5, 2, 3.8];
  const used = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 28, 28,
    29, 30, 31, 32, 33, 34, 35, 36, 37, 42, 42, 43, 44, 45, 46, 47, 48, 49, 60, 75, 86];
  const highs = [120, 280, 500];
  return lows.concat(used, highs).map(p => item(p));
};

t('文档 3.2 A 品牌例：50→剔 6→44 计入，中位数 $28，主力带 $19–42', () => {
  const s = PS.computePriceStats(aBrand(), { currency: 'USD', target: { min: 50, max: 50, currency: 'USD' } });
  assert.equal(s.sample.total, 50);
  assert.equal(s.sample.used, 44);
  assert.equal(s.sample.dropped, 6);
  assert.equal(s.median, 28);
  assert.deepEqual(s.band, { min: 19, max: 42 });
  assert.equal(s.truncatedBy, 'p5p95');
  // 均值对照（文档：均值 ≈ $47 会被 $500 拉扯误放行）——中位数 $28 才是诚实客单价
  assert.equal(s.verdict.code, 'partial');
  // 注：文档 3.2 例写「$28 < $35 → below」，但 3.0.2/3.1 第 5 步 refined 规则明确
  // 「判定对象是主力带（不是全店中位数）」：主力带 [19,42] 骑跨下界 35 → 部分重叠 → 待人工确认。
  // 实现跟随 refined 规则（文中强调两次），宁待确认不误剔。
  assert.equal(s.verdict.pendingHuman, true);
  assert.equal(s.basis, 'verified');
  const prices = s.sample.dropList.map(d => d.price);
  assert.ok(prices.includes(1.5) && prices.includes(500), '剔除明细须含两端极值（可申诉）');
});

t('文档 3.0 泡泡玛特例：三座价格山 → 多峰不裁决（pending），不冒充主力带结论', () => {
  // 配件山 12 款 $10–25 / 大娃山 5 款 $59–79 / 套装山 3 款 $300–2000（缩样保留形态）
  const items = [10, 12, 14, 15, 16, 18, 19, 20, 22, 23, 24, 25, 60, 65, 70, 75, 79, 300, 400, 2000].map(p => item(p));
  const s = PS.computePriceStats(items, { currency: 'USD', target: { min: 69, max: 69, currency: 'USD' } });
  assert.equal(s.multiPeak, true, '应识别出多峰（线间断 > 中位价×2）');
  assert.equal(s.verdict.code, 'pending');
  assert.equal(s.verdict.pendingHuman, true, '多峰无销量权重 → 待人工确认，不自动裁决');
});

t('in_band：主力带中点落在目标价 ×0.7~1.3 → 价格带同构', () => {
  const s = PS.computePriceStats([28, 32, 35, 38, 42].map(p => item(p)), { currency: 'USD', target: { min: 35, max: 35, currency: 'USD' } });
  assert.equal(s.median, 35);
  assert.equal(s.verdict.code, 'in_band');
});

t('above/below 明确错位且非演算 → 可自动裁决（pendingHuman=false）', () => {
  // n≥20 走 P5/P95 路径（非演算降级），全店高于/低于目标区间
  const hiItems = []; for (let i = 0; i < 24; i++) hiItems.push(item(300 + i * 2));
  const hi = PS.computePriceStats(hiItems, { currency: 'USD', target: { min: 50, max: 50, currency: 'USD' } });
  assert.equal(hi.truncatedBy, 'p5p95');
  assert.equal(hi.verdict.code, 'above');
  assert.equal(hi.verdict.pendingHuman, false);
  const loItems = []; for (let i = 0; i < 24; i++) loItems.push(item(8 + i));
  const lo = PS.computePriceStats(loItems, { currency: 'USD', target: { min: 50, max: 50, currency: 'USD' } });
  assert.equal(lo.verdict.code, 'below');
  assert.equal(lo.verdict.pendingHuman, false);
});

t('部分重叠（中点在区间外但主力带骑跨）→ partial 待人工确认，不自动裁决', () => {
  // 目标 $50 → 区间 [35,65]；主力带 ~[57,97]：中点 77 > 65 但带下沿 57 < 65 → 骑跨 → partial
  const items = [];
  for (let i = 0; i < 24; i++) items.push(item(55 + (i % 4)));   // 低段 55-58
  for (let i = 0; i < 24; i++) items.push(item(96 + (i % 4)));   // 高段 96-99
  const s = PS.computePriceStats(items, { currency: 'USD', target: { min: 50, max: 50, currency: 'USD' } });
  assert.equal(s.multiPeak, false, '段间差距未超中位价×2，不算多峰');
  assert.equal(s.verdict.code, 'partial');
  assert.equal(s.verdict.pendingHuman, true);
});

t('先验截尾（样本<20 + 目标价）：×0.15/×3 剔除，标演算、判定降级 pendingHuman', () => {
  const s = PS.computePriceStats([5, 20, 30, 45, 180].map(p => item(p)), { currency: 'USD', target: { min: 50, max: 50, currency: 'USD' } });
  assert.equal(s.truncatedBy, 'prior');
  assert.equal(s.basis, 'inferred', '先验规则截尾 → 演算');
  assert.equal(s.sample.used, 3);
  assert.equal(s.median, 30);
  assert.equal(s.verdict.pendingHuman, true, '演算判定不得自动裁决');
  assert.ok(s.sample.dropList.some(d => d.price === 180) && s.sample.dropList.some(d => d.price === 5));
});

t('样本 <3 款：不裁决（insufficient），不凑数', () => {
  const s = PS.computePriceStats([20, 45].map(p => item(p)), { currency: 'USD', target: { min: 50, max: 50, currency: 'USD' } });
  assert.equal(s.verdict.code, 'insufficient');
  assert.equal(s.median, null, '<3 款不出中位数');
});

t('币种 fail-closed：目标价与实抓币种不一致 → undetermined，不换算不裁决', () => {
  const s = PS.computePriceStats([4000, 4200, 4500, 4800, 5000].map(p => item(p)), { currency: 'JPY', target: { min: 35, max: 35, currency: 'USD' } });
  assert.equal(s.verdict.code, 'undetermined');
  assert.equal(s.verdict.pendingHuman, true);
});

t('无目标价：只出统计不判定（no_target）', () => {
  const s = PS.computePriceStats([10, 20, 30, 40, 50].map(p => item(p)), { currency: 'USD', target: null });
  assert.equal(s.verdict.code, 'no_target');
  assert.equal(s.median, 30);
});

t('已下架（soldOut）与免费品不计入客单价样本，但计数单列', () => {
  const items = [
    item(20), item(25), item(30), item(35), item(40),
    item(50, { soldOut: true }),   // 断货在售价：不计入
    item(0, { title: 'Free' }),    // 免费品：单列
  ];
  const s = PS.computePriceStats(items, { currency: 'USD', target: { min: 30, max: 30, currency: 'USD' } });
  assert.equal(s.sample.soldOut, 1);
  assert.equal(s.sample.free, 1);
  assert.equal(s.sample.used, 5);
});

t('无目标价时不做先验截尾（没有锚就不猜）', () => {
  const s = PS.computePriceStats([5, 20, 30, 45, 180].map(p => item(p)), { currency: 'USD', target: null });
  assert.equal(s.truncatedBy, null);
  assert.equal(s.sample.used, 5);
});

console.log('\n=== price-stats.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
