'use strict';
// 金标集种子登记（P1-7 · A2）：从线上 state 的 fieldSources 抽取 tier1 真实来源 → data/accuracy_samples.json
// 2026-10-02 修订：样本以 correct=null / judge='seed-pending' 登记（待人工/独立抽检标注），
// 不再写 correct=true——「存在 tier1 来源」≠「抽取正确」，冒充已标注会把准确率冷启动成 100%、
// 令 applyAccuracyGate 的红线形同虚设。维度要过门禁，须积累足量真实已评估样本
//（人工抽检或 /field-review accept 的 C 回流纠错）。
// 用法：node scripts/seed-gold-standard.js [stateFile]
//   不传 stateFile → 自动读取 data/current.json 指向的在线项目文件。
const fs = require('fs');
const path = require('path');
const M = require('../lib/metrics.js');

const root = path.join(__dirname, '..');
M.setDataDir(path.join(root, 'data'));

const argFile = process.argv[2];
let stateFile;
if (argFile) {
  stateFile = path.resolve(argFile);
} else {
  const cur = JSON.parse(fs.readFileSync(path.join(root, 'data', 'current.json'), 'utf8'));
  stateFile = path.join(root, 'data', 'projects', cur.id + '.json');
}
if (!fs.existsSync(stateFile)) {
  console.error('FAIL: 找不到 state 文件：' + stateFile);
  process.exit(1);
}
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const r = M.seedAccuracyFromFieldSources(state, {});
console.log('金标种子登记：added=' + r.added + ' skipped=' + r.skipped + ' total=' + r.total);
console.log('各维度待评估样本（seed-pending 不进准确率分母；门禁在已评估样本达标前不放行）：');
for (const k in r.byDimension) {
  const d = r.byDimension[k];
  console.log('  ' + k + ': n=' + d.n + ' pending=' + (d.pending || 0) + ' accuracy=' + (d.accuracy == null ? 'n/a' : (d.accuracy * 100).toFixed(0) + '%'));
}
