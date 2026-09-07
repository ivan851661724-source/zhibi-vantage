'use strict';
// §7 红线 2「不编数据」单测：单源永不查证 / 无引用强制降级 / 报告删编造句与裸句
const assert = require('node:assert');
const { deriveBasis } = require('../research/evidence.js');
const SourceFusion = require('../lib/source-fusion.js');
const FC = require('../lib/field-confidence.js');
const { validateReport } = require('../research/report.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

t('deriveBasis：无引用 → unverified/low（不编数据）', () => {
  const d = deriveBasis([]);
  assert.equal(d.basis, 'unverified');
  assert.equal(d.confidence, 'low');
});

t('deriveBasis：单个二级来源 → inferred/low（单源不升级查证）', () => {
  const d = deriveBasis([{ tier: 2, url: 'https://reddit.com/r/x/1' }]);
  assert.equal(d.basis, 'inferred');
  assert.equal(d.confidence, 'low');
});

t('deriveBasis：两个独立二级域 → inferred/medium（仍非查证）', () => {
  const d = deriveBasis([
    { tier: 2, url: 'https://reddit.com/r/x/1' },
    { tier: 2, url: 'https://trustpilot.com/review/y' },
  ]);
  assert.equal(d.basis, 'inferred');
  assert.equal(d.confidence, 'medium');
});

t('deriveBasis：tier1 官方来源 → verified/high', () => {
  const d = deriveBasis([{ tier: 1, url: 'https://brand.com' }]);
  assert.equal(d.basis, 'verified');
  assert.equal(d.confidence, 'high');
});

t('source-fusion：单源 basis 永不 verified', () => {
  const r = SourceFusion.fuse([{ name: 'serper', ok: true, results: [{ title: 'x', url: 'https://a.com', content: '' }] }]);
  assert.notEqual(r.basis, 'verified'); // 双源一致才查证
});

t('provenanceGate：单来源即便 confidence=high 也不得标「已查实」', () => {
  const g = FC.provenanceGate({ independentAgree: 1, confidence: 'high', basis: 'inferred' });
  assert.equal(g.credible, false);
});

t('validateReport：编造编号句删除 + 无编号裸句删除', () => {
  const v = validateReport(
    '## 一、现状\nA 品牌价格带 $20-80 [F1]。\nB 品牌已经倒闭 [F999]。\n这是一句没有任何引用的裸论断。\n',
    ['F1'], [],
  );
  assert.ok(v.markdown.includes('[F1]'));
  assert.ok(!v.markdown.includes('F999'));
  assert.ok(!v.markdown.includes('裸论断'));
  assert.equal(v.removed, 2);
});

t('红线自检：「你应该做X」式句子导致 QC 判红（决策权归用户）', () => {
  const md = '## 四、我们的判断\n我们判断 X 是当前最值得盯的空白 [G1]。\n你应该做 立即跟进这条线 [F1]。\n';
  const v = validateReport(md, ['F1'], ['G1']);
  const redline = v.qc.checks.find(c => c.name === '红线自检');
  assert.ok(redline, '存在红线自检项');
  assert.equal(redline.pass, false); // 清洗后仍含禁用表述 → 判红（QC 可见）
});

console.log('\n=== red-lines.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
