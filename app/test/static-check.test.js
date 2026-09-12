'use strict';
// ============================================================
// static-check.test.js —— B-8 防回归静态扫描的测试壳
// 真正的检查逻辑在 scripts/static-check.js（四道检查：语法 / 命名空间 /
// require-all / stub discover 冒烟），本套件负责把它挂进质量门。
// 历史事故对照（修复前本套件必红）：
//   · research/decorate.js FC.-型   → 命名空间启发式抓
//   · research/search.js curTenantId-型 → stub discover 冒烟抓
// ============================================================
const { execFileSync } = require('child_process');
const path = require('path');

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}

t('static-check 四道检查全绿（语法/命名空间/require-all/stub discover 冒烟）', () => {
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'static-check.js')], {
    encoding: 'utf8', timeout: 120000,
  });
  process.stdout.write(out);
});

if (failed) { console.error(`static-check.test: ${failed} failed`); process.exit(1); }
console.log('static-check.test: all passed');
