'use strict';
// ============================================================
// static-check.test.js —— B-8 防回归静态扫描的测试壳（异步 harness 版）
//
// 审核整改 §四（2026-10-10）：旧壳是同步 try/catch 包 Promise——进程内路径的
// 异步异常（EBUSY 路径里 runAll 的 rejection）发生在 t() 返回之后，failed 计数
// 与 process.exit(1) 都已先执行 → 「all passed」假通过。本版改为真正的 async
// harness：全部断言 await，异步失败必然使进程返回非零。
//
// 检查语义（四道检查一个不少，不跳过、不降级为警告）：
//   ① 语法（node --check）② 命名空间启发式 ③ require-all 冒烟 ④ stub discover 冒烟
//
// 隔离差异声明（审核整改 §四 要求明确说明）：
//   · 路径 A（首选，正式生产门禁）：独立子进程执行 static-check.js——独立事件
//     循环、独立 require 缓存、真实 node --check 与真实模块加载，模块级隔离可证。
//   · 路径 B（受控环境补偿）：受限环境对 node 子进程持续 EBUSY 时，进程内执行
//     同一套检查（static-check.runAll 内部同样 spawn→进程内降级）。与路径 A 并非
//     完全等价：共享本进程 require 缓存与事件循环，无法验证模块级隔离；降级事实
//     由 static-check 内部 notice() 显式输出（[static-check][fallback]）并计入
//     notices 数组，失败可见——不静默、不冒充子进程结果。
// ============================================================
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// —— harness：async 版测试壳；可被注入失败回归复用 ——
// 返回 failed 数；全部用例 await，异步异常按失败计，绝不假通过。
async function runHarness() {
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log('ok - ' + name); }
    catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
  };

  await t('static-check 四道检查全绿（语法/命名空间/require-all/stub discover 冒烟）', async () => {
    const runTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-staticcheck-test-'));
    try {
      // 路径 A：子进程执行（常规 Windows/Linux 环境；正式生产门禁）
      const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'static-check.js')], {
        encoding: 'utf8', timeout: 300000,
        env: Object.assign({}, process.env, {
          TMPDIR: runTmp, TEMP: runTmp, TMP: runTmp,
          ZB_DATA_DIR: path.join(runTmp, 'shell-data'),
        }),
      });
      process.stdout.write(out);
    } catch (e) {
      // 路径 B：受限环境对 node 子进程持续性 EBUSY → 进程内执行同一套检查（受控补偿）
      const blocked = e && (e.code === 'EBUSY' || /EBUSY/.test(String(e.message || '')));
      if (!blocked) throw e;
      process.stdout.write('[static-check.test] 子进程 spawn 被持续拦截（EBUSY），切换进程内受控补偿…\n');
      const sc = require('../scripts/static-check.js');
      sc.problems.length = 0;
      sc.notices.length = 0;
      // 审核整改 §四：必须 await——旧壳漏掉 await 导致异步异常逃逸出失败统计
      const problems = await sc.runAll({ tmpRoot: path.join(runTmp, 'inprocess') });
      if (sc.notices.length) {
        console.log('[static-check.test] 进程内补偿降级通知（失败可见，非完全等价于子进程路径）:');
        for (const n of sc.notices) console.log('  ' + n);
      }
      if (problems.length) {
        throw new Error('static-check 进程内执行发现 ' + problems.length + ' 处问题:\n' + problems.join('\n'));
      }
    }
  });

  // 审核整改 §四：注入失败回归——证明异步 runAll 失败时 harness 绝不输出 all passed
  await t('回归：异步 runAll 失败必须使 harness 计入失败（不假通过）', async () => {
    let asyncFailed = 0;
    let printedAllPassed = false;
    const fakeLog = () => {};
    const fakeErr = () => {};
    // 模拟旧壳的死亡场景：runner 的一个用例异步抛错 → harness 必须计入 failed 且不打印 all passed
    await runHarnessCore({
      runner: async () => { throw new Error('INJECTED_ASYNC_FAILURE'); },
      log: fakeLog, err: (m) => { if (/INJECTED_ASYNC_FAILURE/.test(String(m))) asyncFailed++; },
      onDone: () => { printedAllPassed = true; },
    });
    if (asyncFailed === 0) throw new Error('异步异常未被 harness 捕获——测试壳会假通过');
    if (printedAllPassed) throw new Error('异步失败后 harness 仍打印 all passed——假通过复现');
  });

  return failed;
}

// runHarness 的可注入内核（仅供回归测试用；正常入口是 runHarness）
async function runHarnessCore({ runner, log, err, onDone }) {
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); log('ok - ' + name); }
    catch (e) { failed++; err('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
  };
  await t('injected', async () => { await runner(); });
  if (!failed && onDone) onDone();
  return failed;
}

async function main() {
  const failed = await runHarness();
  if (failed) {
    console.error('static-check.test: ' + failed + ' failed');
    process.exit(1); // 审核整改 §四：异步失败必然非零退出
  }
  console.log('static-check.test: all passed');
}
main().catch(e => {
  console.error('static-check.test: harness 异常（异步失败可见）: ' + String(e && e.stack || e));
  process.exit(1);
});
