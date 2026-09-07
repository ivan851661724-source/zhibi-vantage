'use strict';
// 零依赖 CI 测试运行器：跑 test/*.test.js 全量，任一非零退出即整体失败（质量门）。
// 用法：node scripts/run-tests.js  或  npm test
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NODE = process.execPath;
const testDir = path.join(__dirname, '..', 'test');
// 容错：test 目录缺失（如部署包裁剪）时提示并按通过退出，而非 ENOENT 崩溃
let files = [];
try {
  files = fs.readdirSync(testDir).filter(f => f.endsWith('.test.js')).sort();
} catch (e) {
  console.log('（未找到 ' + testDir + '，跳过测试；返回成功）');
  process.exit(0);
}

let failed = 0;
const failedFiles = [];
for (const f of files) {
  const full = path.join(testDir, f);
  process.stdout.write('\n=== ' + f + ' ===\n');
  try {
    const out = execFileSync(NODE, [full], { encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(out);
  } catch (e) {
    failed++;
    failedFiles.push(f);
    if (e.stdout) process.stdout.write(e.stdout);
    if (e.stderr) process.stderr.write(e.stderr);
    if (e.killed) process.stderr.write('(超时 60s 被杀)\n');
  }
}

process.stdout.write('\n========================================\n');
process.stdout.write('测试套件: ' + files.length + '，失败: ' + failed + (failedFiles.length ? ' (' + failedFiles.join(', ') + ')' : '') + '\n');
process.exit(failed ? 1 : 0);
