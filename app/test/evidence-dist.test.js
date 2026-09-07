'use strict';
// R6 诚实条单测：evidenceDistribution 三态统计（PRD 验收：空报告/全实查/混合三种情况）
const assert = require('node:assert');
const { evidenceDistribution } = require('../lib/evidence-dist.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

// 构造带 decorate 后字段的竞品
function comp(id, fields) {
  return Object.assign({ id, name: id, status: 'done' }, fields);
}

t('空报告：0 家完成 → total=0，占比全 0', () => {
  const d = evidenceDistribution({ competitors: [], excluded: [] });
  assert.equal(d.total, 0);
  assert.equal(d.pct.verified, 0);
  assert.equal(d.pct.inferred, 0);
  assert.equal(d.pct.unverified, 0);
  const d2 = evidenceDistribution(null);
  assert.equal(d2.total, 0);
});

t('全实查：所有字段 verified → 100% 实查', () => {
  const st = { competitors: [comp('a', {
    priceField: { basis: 'verified' },
    channelFields: { amazon: { basis: 'verified' }, etsy: { basis: 'verified' } },
    launchCadence: { basis: 'verified' },
    reviewField: { basis: 'verified' },
    estSize: '10-50人', estSizeBasis: 'verified',
    positioning: { valueProposition: 'x' }, positioningBasis: 'verified',
  })], excluded: [] };
  const d = evidenceDistribution(st);
  assert.equal(d.unverified, 0);
  assert.equal(d.verified, d.total);
  assert.equal(d.pct.verified, 100);
});

t('混合：实查/推测/未探测各占其位', () => {
  const st = { competitors: [comp('a', {
    priceField: { basis: 'verified' },                     // 实查
    channelFields: { amazon: { basis: 'inferred' } },      // 推测
    launchCadence: { basis: 'unverified' },                // 未探测
    // 口碑/规模/定位缺失 → 不计入（未研究字段不算证据）
  })], excluded: [] };
  const d = evidenceDistribution(st);
  assert.equal(d.total, 3);
  assert.equal(d.verified, 1);
  assert.equal(d.inferred, 1);
  assert.equal(d.unverified, 1);
  assert.equal(d.pct.verified, 33);
  assert.ok(d.byDim['价格']);
  assert.ok(d.byDim['渠道·amazon']);
});

t('排除卡不进分母（与聚合口径一致）', () => {
  const st = { competitors: [
    comp('a', { priceField: { basis: 'verified' } }),
    comp('b', { priceField: { basis: 'inferred' }, entityAmbiguous: true }),
  ], excluded: [] };
  const d = evidenceDistribution(st);
  assert.equal(d.total, 1); // b 被剔除
  assert.equal(d.verified, 1);
});

t('未知 basis 归"未探测"（不编造）', () => {
  const st = { competitors: [comp('a', { priceField: { basis: 'whatever' } })], excluded: [] };
  const d = evidenceDistribution(st);
  assert.equal(d.unverified, 1);
  assert.equal(d.verified, 0);
});

console.log('\n=== evidence-dist.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
