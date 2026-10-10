'use strict';
// ============================================================
// scripts/lib/spawn-node.js —— Windows 稳定的 node 子进程封装
// ------------------------------------------------------------
// 根因（2026-10-09 排查）：static-check 在 Windows 上对 node.exe 连续
// spawnSync 数百次（语法检查 ×N + require-all ×M + 冒烟），部分调用返回
// { error: EBUSY, status: null }——Defender/AV 在进程镜像刚被映射时短暂
// 持有 exe 文件锁，属瞬态错误。旧脚本把 status!==0 一律判失败，且此时
// stderr 为空 → 产生大量空报错的幽灵 [SYNTAX]/[REQ] 行（与代码无关）。
//
// 修复（不得跳过/降级/告警化）：
//   1) 稳定可执行文件路径：一律用 process.execPath（当前运行中的 node 绝对
//      路径，不依赖 PATH 解析，Windows/Linux 同构）；
//   2) 瞬态错误重试：EBUSY/EAGAIN 指数退避重试（50ms→100→200→400ms），
//      重试耗尽才算失败——失败仍是失败，语义不放宽；
//   3) 隔离临时目录：调用方传入 tmpRoot（一次性 mkdtemp），本模块把它注入
//      子进程 TMPDIR/TEMP/TMP + ZB_DATA_DIR，杜绝子进程共享/污染全局临时区。
//
// 可测试性：spawnFn 可注入（单测注入假 spawn 验证重试与失败语义）。
// ============================================================
const DEFAULT_RETRYABLE = new Set(['EBUSY', 'EAGAIN']);
const RETRY_DELAYS_MS = [50, 100, 200, 400];
const path = require('path');

function sleepSync(ms) {
  const { spawnSync } = require('child_process');
  // 零依赖同步等待：用 Atomics.wait 阻塞当前线程（比再 spawn 一次 node 更轻）
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
  } catch { spawnSync(process.execPath, ['-e', ''], { timeout: Math.min(ms + 50, 500) }); }
}

/**
 * spawnNode(args, opts) → spawnSync 结果
 * opts: { encoding, timeout, env, input, spawnFn, tmpRoot, cwd }
 * 返回值附带 .attempts（实际尝试次数）。
 */
function spawnNode(args, opts) {
  const o = opts || {};
  const spawnFn = o.spawnFn || require('child_process').spawnSync;
  const file = process.execPath; // 稳定路径：绝不走 PATH 解析
  const baseEnv = Object.assign({}, process.env, o.env || {});
  // 第三轮整改 §一：调用方传入自定义 ZB_DATA_DIR 时必须确保目录存在——
  // node:sqlite 打开数据库不建父目录，目录缺失直接 "unable to open database file"
  //（全新源码副本无 gitignored data 目录时必现）。创建失败让错误自然抛出，不吞。
  if (baseEnv.ZB_DATA_DIR) {
    require('fs').mkdirSync(path.resolve(baseEnv.ZB_DATA_DIR), { recursive: true });
  }
  // 隔离临时目录：注入到子进程三个标准临时目录变量 + 数据目录
  if (o.tmpRoot) {
    baseEnv.TMPDIR = o.tmpRoot;
    baseEnv.TEMP = o.tmpRoot;
    baseEnv.TMP = o.tmpRoot;
    if (!baseEnv.ZB_DATA_DIR) baseEnv.ZB_DATA_DIR = o.tmpRoot;
  }
  let lastResult = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) sleepSync(RETRY_DELAYS_MS[attempt - 1]);
    const env = Object.assign({}, baseEnv);
    if (o.tmpRoot) {
      // 每次尝试给独立子目录，避免上一次尝试的残留锁/文件干扰
      try { require('fs').mkdirSync(o.tmpRoot, { recursive: true }); } catch { /* 已存在 */ }
    }
    lastResult = spawnFn(file, args, {
      encoding: o.encoding || 'utf8',
      timeout: o.timeout,
      env,
      input: o.input,
      cwd: o.cwd,
      windowsHide: true,
    });
    const errCode = lastResult && lastResult.error && lastResult.error.code;
    const transient = lastResult && lastResult.error && DEFAULT_RETRYABLE.has(errCode);
    if (!transient) break;
  }
  if (lastResult && lastResult.error) lastResult.attempts = RETRY_DELAYS_MS.length + 1;
  else if (lastResult) lastResult.attempts = (lastResult.attempts || 1);
  return lastResult;
}

module.exports = { spawnNode, DEFAULT_RETRYABLE, RETRY_DELAYS_MS };
