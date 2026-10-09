'use strict';
// ============================================================
// static-check.test.js —— B-8 防回归静态扫描的测试壳
// 真正的检查逻辑在 scripts/static-check.js（四道检查：语法 / 命名空间 /
// require-all / stub discover 冒烟），本套件负责把它挂进质量门。
// 历史事故对照（修复前本套件必红）：
//   · research/decorate.js FC.-型   → 命名空间启发式抓
//   · research/search.js curTenantId-型 → stub discover 冒烟抓
// Phase 1（Windows EBUSY 修复，2026-10-09）：
//   · 首选子进程路径（稳定 Node 路径 = process.execPath + 隔离临时目录 +
//     spawn 层瞬态 EBUSY 指数退避重试）；
//   · 子进程 spawn 被**持续性**拦截（受限环境连 execFileSync 都 EBUSY）时，
//     回退到**进程内等价执行**（static-check.runAll 内部同样带 spawn→进程内
//     降级链）——检查语义不放宽，不跳过、不降级为警告。
// ============================================================
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failed = 0;
function t(name, fn) {
  try { fn(); console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}

t('static-check 四道检查全绿（语法/命名空间/require-all/stub discover 冒烟）', () => {
  // 一次性隔离临时目录：壳进程与全部检查共享此根（Windows 与 Linux 同构）
  const runTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-staticcheck-test-'));
  try {
    // 路径 A：子进程执行（常规 Windows/Linux 环境）
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'static-check.js')], {
      encoding: 'utf8', timeout: 300000,
      env: Object.assign({}, process.env, {
        TMPDIR: runTmp, TEMP: runTmp, TMP: runTmp,
        ZB_DATA_DIR: path.join(runTmp, 'shell-data'),
      }),
    });
    process.stdout.write(out);
  } catch (e) {
    // 路径 B：受限环境对 node 子进程持续性 EBUSY → 进程内等价执行同一套检查
    const blocked = e && (e.code === 'EBUSY' || /EBUSY/.test(String(e.message || '')));
    if (!blocked) throw e;
    process.stdout.write('[static-check.test] 子进程 spawn 被持续拦截（EBUSY），切换进程内等价执行…\n');
    const sc = require('../scripts/static-check.js');
    const problems = sc.problems; // 共享数组：runAll 会填满
    problems.length = 0;
    return Promise.resolve(sc.runAll({ tmpRoot: path.join(runTmp, 'inprocess') })).then((all) => {
      if (all.length) throw new Error('static-check 进程内执行发现 ' + all.length + ' 处问题:\n' + all.join('\n'));
      console.log('ok - 进程内等价执行通过（spawn 阻断环境）');
    });
  }
});

if (failed) { console.error(`static-check.test: ${failed} failed`); process.exit(1); }
console.log('static-check.test: all passed');
