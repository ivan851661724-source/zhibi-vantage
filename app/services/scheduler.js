'use strict';
// ============================================================
// 定时增量雷达调度（模块 2-1）—— 日 4 趟（默认 0/6/12/18 点）
// 纯调度器：不 require server.js（避免循环依赖），runSweep 由启动方注入。
// 开关：SCHEDULER_ENABLED=0 完整关闭；SWEEP_HOURS 可自定义（JSON 数组，如 '[2,8,14,20]'）。
// 到点执行 runSweep()（增量雷达：遍历活跃项目做变化探测，僵尸项目零成本跳过）。
// ============================================================

const DEFAULT_HOURS = [0, 6, 12, 18];

function hoursOf() {
  try {
    const h = JSON.parse(process.env.SWEEP_HOURS || '');
    if (Array.isArray(h) && h.length) {
      const clean = h.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 23);
      if (clean.length) return clean;
    }
  } catch (e) { /* 环境变量格式错误 → 用默认 */ }
  return DEFAULT_HOURS;
}

let _timer = null;
let _stopped = false;
let _nextAt = null;

function scheduleNext(runSweep, logger) {
  _stopped = false; // 重新调用即重新武装（修复：stop() 后无法重启）
  // 修复：自定义 SWEEP_HOURS 乱序（如 '[18,2]'）时，跨天兜底取 min(hour)，
  // 否则会固定跳过凌晨档（原来假设 hours[0] 是最早时刻）。
  const hours = hoursOf().slice().sort((a, b) => a - b);
  const now = new Date();
  let next = null;
  for (const h of hours) {
    const d = new Date(now); d.setHours(h, 0, 0, 0);
    if (d > now) { next = d; break; }
  }
  if (!next) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(hours[0], 0, 0, 0);
    next = d;
  }
  const delay = Math.max(1000, next - now);
  _nextAt = next;
  _timer = setTimeout(async () => {
    if (_stopped) return;
    try {
      if (runSweep) await runSweep();
    } catch (e) {
      try { logger && logger.error && logger.error('sweep 执行失败', e); } catch (e2) { console.error('[scheduler] sweep 失败:', e && e.message || e); }
    }
    if (!_stopped) scheduleNext(runSweep, logger); // 递归排下一趟（无论成败都继续）
  }, delay);
  if (_timer.unref) _timer.unref(); // 服务有 HTTP server 保活；测试时进程可退出
  return { nextAt: next, delayMs: delay, hours };
}

function stop() {
  _stopped = true;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  _nextAt = null;
}

function status() {
  return {
    enabled: process.env.SCHEDULER_ENABLED !== '0',
    hours: hoursOf(),
    nextAt: _nextAt ? _nextAt.toISOString() : null,
    lastSweepAt: _lastSweepAt || null,
  };
}

let _lastSweepAt = null;
function markSwept(at) { _lastSweepAt = at || new Date().toISOString(); }

// ---- R4.2：每日 digest 调度（默认每天 8 点；DIGEST_HOUR 可改） ----
let _digestTimer = null;
function scheduleDaily(fn, logger) {
  if (_digestTimer) { clearTimeout(_digestTimer); _digestTimer = null; }
  const hour = Math.max(0, Math.min(23, parseInt(process.env.DIGEST_HOUR || '8', 10) || 8));
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = Math.max(1000, next - now);
  _digestTimer = setTimeout(async () => {
    try { if (fn) await fn(); } catch (e) { try { logger && logger.error && logger.error('digest 执行失败', e); } catch (e2) {} }
    scheduleDaily(fn, logger); // 递归排明天
  }, delay);
  if (_digestTimer.unref) _digestTimer.unref();
  return { nextAt: next, delayMs: delay, hour };
}

module.exports = { scheduleNext, stop, status, markSwept, hoursOf, scheduleDaily };
