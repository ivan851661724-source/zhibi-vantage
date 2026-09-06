'use strict';
// 金标集种子注入（P1-7 · A2）：从线上 state 的 fieldSources 抽取 tier≤2 真实来源 → data/accuracy_samples.json
// 使 P0-4 的准确率门禁（applyAccuracyGate）不再空转；随 /field-review accept（C 回流）纠错逐步收紧。
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
console.log('金标种子注入：added=' + r.added + ' skipped=' + r.skipped + ' total=' + r.total);
console.log('各维度抽检样本数（冷启动默认 correct，准确率 100%；待 C 回流纠错后收紧）：');
for (const k in r.byDimension) {
  const d = r.byDimension[k];
  console.log('  ' + k + ': n=' + d.n + ' accuracy=' + (d.accuracy == null ? 'n/a' : (d.accuracy * 100).toFixed(0) + '%'));
}
