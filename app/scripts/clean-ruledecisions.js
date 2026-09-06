// 清理冒烟测试在 state 文件里留下的 ruleDecisions（AI 建议裁决状态），
// 不动 suppressed / addedCompetitors（那是用户真实信号）。
const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '..', 'data');
const targets = [path.join(dir, 'current.json')];
try {
  for (const f of fs.readdirSync(path.join(dir, 'projects'))) {
    if (f.endsWith('.json')) targets.push(path.join(dir, 'projects', f));
  }
} catch (e) { /* no projects dir */ }

let changed = 0;
for (const f of targets) {
  try {
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (s.ruleDecisions && Object.keys(s.ruleDecisions).length) {
      s.ruleDecisions = {};
      fs.writeFileSync(f, JSON.stringify(s, null, 1));
      console.log('已清理', path.basename(f));
      changed++;
    }
  } catch (e) {
    console.error('跳过', f, e.message);
  }
}
console.log(changed ? `完成，清理了 ${changed} 个文件` : '无需清理（已是干净状态）');
