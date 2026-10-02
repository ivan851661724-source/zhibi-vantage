'use strict';
// 准确率门禁单测（2026-10-02 修订，v2 报告 P0-A#4）：
//   · seed-pending 样本不进准确率分母（「存在 tier1 来源」≠「抽取正确」）
//   · applyAccuracyGate 对「无样本/样本不足」维度不再 fail-open，标 accuracyUnverified
//   · accuracy < 红线 → accuracyInsufficient（原行为保留）；达标且样本足 → 不降级
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const M = require('../lib/metrics.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

// 每个测试文件独立进程跑（run-tests.js），用一次性临时数据目录，不污染真实 data/
M.setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'acc-gate-test-')));

t('seedAccuracyFromFieldSources：tier1 来源登记为 pending，不进准确率分母', () => {
  const state = { competitors: [{
    id: 'c1',
    fieldSources: { 'channels.amazon': [{ id: 'E1', url: 'https://www.amazon.com/stores/brand', tier: 1, kind: 'official', title: 'amazon 官方店' }] },
  }] };
  const r = M.seedAccuracyFromFieldSources(state, {});
  assert.equal(r.added, 1);
  const sum = M.recomputeAccuracySummary(30);
  const dim = sum.byDimension['channels'];
  assert.ok(dim, 'channels 维度应存在');
  assert.equal(dim.n, 0);            // 零已评估
  assert.equal(dim.pending, 1);      // 一条待标注
  assert.equal(dim.accuracy, null);  // 不冒充 100%
});

t('seedAccuracyFromFieldSources：幂等，重复运行不重复登记', () => {
  const state = { competitors: [{
    id: 'c1',
    fieldSources: { 'channels.amazon': [{ id: 'E1', url: 'https://www.amazon.com/stores/brand', tier: 1, kind: 'official', title: 'amazon 官方店' }] },
  }] };
  const r = M.seedAccuracyFromFieldSources(state, {});
  assert.equal(r.added, 0);
  assert.equal(r.skipped, 1);
});

t('applyAccuracyGate：无样本维度不再默认放行（accuracyUnverified）', () => {
  const gaps = [{ dim: 'channels', confidence: 'high', confidenceNum: 85, basis: 'verified', level: 'gap' }];
  const out = M.applyAccuracyGate(gaps, { byDimension: {} }, {});
  assert.equal(out[0].accuracyUnverified, true);
  assert.equal(out[0].confidence, 'low');
  assert.equal(out[0].basis, 'unverified');
  assert.equal(out[0].level, 'undetected');
});

t('applyAccuracyGate：已评估样本不足（n<最小样本数）同样退出空白推理', () => {
  const gaps = [{ dim: 'price', confidence: 'high', confidenceNum: 85, basis: 'verified', level: 'gap' }];
  const out = M.applyAccuracyGate(gaps, { byDimension: { price: { accuracy: 0.9, n: M.ACC_GATE_MIN_SAMPLES - 1, pending: 3 } } }, {});
  assert.equal(out[0].accuracyUnverified, true);
  assert.equal(out[0].confidence, 'low');
});

t('applyAccuracyGate：达标且样本足 → 不降级；低于红线 → accuracyInsufficient（原行为保留）', () => {
  const gaps = [
    { dim: 'ok', confidence: 'high', confidenceNum: 85, basis: 'verified', level: 'gap' },
    { dim: 'bad', confidence: 'high', confidenceNum: 85, basis: 'verified', level: 'gap' },
  ];
  const out = M.applyAccuracyGate(gaps, { byDimension: { ok: { accuracy: 0.9, n: 10 }, bad: { accuracy: 0.5, n: 10 } } }, {});
  assert.equal(out[0].accuracyUnverified, undefined);
  assert.equal(out[0].accuracyInsufficient, undefined);
  assert.equal(out[0].confidence, 'high');
  assert.equal(out[1].accuracyInsufficient, true);
  assert.equal(out[1].confidence, 'low');
});

t('recomputeAccuracySummary：真实已评估样本照常计入，pending 只单列', () => {
  M.recordAccuracySample({ dimension: 'price', fieldKey: 'priceBand', correct: true, judge: 'human', channel: 'shopify-scrape' });
  M.recordAccuracySample({ dimension: 'price', fieldKey: 'priceBand', correct: false, judge: 'human', channel: 'llm-band' });
  const sum = M.recomputeAccuracySummary(30);
  const dim = sum.byDimension['price'];
  assert.equal(dim.n, 2);
  assert.equal(dim.accuracy, 0.5);
});

console.log('\n=== accuracy-gate.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
