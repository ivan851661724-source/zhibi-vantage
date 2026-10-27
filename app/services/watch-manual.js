'use strict';
// ============================================================
// services/watch-manual.js —— 「立即巡检」真实执行器（核心产品体验收敛 r1）
// ------------------------------------------------------------
// 为什么需要它：
//   收件箱空的时候，用户唯一能做的正确动作是「让系统现在就看一次」。
//   但此前只有定时 tick，没有任何手动触发入口——用户只能等。
//
// 纪律（红线）：
//   ① 必须走**与定时巡检完全同一条链路**：claimWindow → executeWindow →
//      completeWindow → markSuccess/markDegraded，不另写一套采集/写库逻辑；
//   ② 窗口是真实窗口：window_key = `manual-<ISO>`，唯一、幂等、可审计，
//      绝不复用定时窗口（否则会污染「今日已巡检」口径）；
//   ③ 采集用途仍是 monitoring（因此可写 intel_events），但只有**真实发现变化**
//      才写事件——手动巡检绝不制造事件，也绝不把首采基线变成变化；
//   ④ 同一 target 在飞时只允许一次（单飞），避免连点造成重复采集与成本浪费；
//   ⑤ 无 active/degraded target 一律拒绝（不替用户凭空建立监控）。
// ============================================================
const WS = require('./watch-store.js');

// 单飞：key = tenantId + '|' + watchTargetId
const INFLIGHT = new Map();
// 冷却：同 target 两次手动巡检的最小间隔（真实采集有成本，防连点）
const MIN_GAP_MS = 20 * 1000;

function keyOf(tenantId, watchTargetId) { return String(tenantId) + '|' + String(watchTargetId); }

function manualWindowKey(nowMs) {
  // 2026-10-27T13:00:00.000Z → manual-20261027T130000Z（无冒号/点，作 window_key 安全）
  return 'manual-' + new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function findTarget(tenantId, watchTargetId) {
  const list = WS.listSchedulableTargets() || [];
  return list.find(t => t && String(t.tenantId) === String(tenantId) && String(t.watchTargetId) === String(watchTargetId)) || null;
}

/**
 * 启动一次手动巡检（异步执行，立即返回受理结果）。
 * @returns {{accepted:boolean, reason?:string, windowKey?:string, targetId?:string}}
 */
function startInspect(opts) {
  const o = opts || {};
  const tid = String(o.tenantId || '');
  const wtid = String(o.watchTargetId || '');
  if (!tid || !wtid) return { accepted: false, reason: 'MISSING_SCOPE' };
  const target = findTarget(tid, wtid);
  if (!target) return { accepted: false, reason: 'NOT_MONITORING' };
  const k = keyOf(tid, wtid);
  const cur = INFLIGHT.get(k);
  if (cur && Date.now() - cur.startedAt < MIN_GAP_MS) {
    return { accepted: false, reason: 'IN_PROGRESS', windowKey: cur.windowKey };
  }
  const nowMs = Date.now();
  const windowKey = manualWindowKey(nowMs);
  INFLIGHT.set(k, { startedAt: nowMs, windowKey });
  const deps = o.deps || {};
  // 后台执行：不阻塞 HTTP（采集可能十几秒）
  setImmediate(() => { runInspect(target, windowKey, nowMs, deps).catch(() => { /* 已记入窗口状态 */ }); });
  return { accepted: true, windowKey, targetId: wtid, signals: target.enabledSignals };
}

async function runInspect(target, windowKey, nowMs, deps) {
  // 延迟 require：避免与 watch-monitor 循环依赖
  const WM = require('./watch-monitor.js');
  const k = keyOf(target.tenantId, target.watchTargetId);
  const claim = WS.claimWindow(target, windowKey, 'manual', nowMs, nowMs);
  if (!claim.claimed) {
    INFLIGHT.delete(k);
    return { ok: false, reason: 'WINDOW_NOT_CLAIMED', windowKey };
  }
  let result = null;
  try {
    result = await WM.executeWindow(target, claim.windowId, deps || {}, nowMs);
  } catch (e) {
    // 窗口级异常 = 覆盖缺口，绝不落成「无变化」
    try { WS.failWindow(claim.windowId, nowMs); } catch (e2) { /* 忽略 */ }
    INFLIGHT.delete(k);
    return { ok: false, reason: 'WINDOW_FAILED', windowKey };
  }
  try {
    WS.completeWindow(claim.windowId, result, nowMs);
    if (result && result.anySuccess) WS.markSuccess(target.tenantId, target.watchTargetId, new Date(nowMs).toISOString());
    else WS.markDegraded(target.tenantId, target.watchTargetId);
    WS.refreshFreshness(nowMs);
  } catch (e) { /* 状态推进失败不影响已写入的事件 */ }
  INFLIGHT.delete(k);
  return {
    ok: !!(result && result.anySuccess),
    windowKey,
    eventsVerified: (result && result.eventsVerified) || 0,
    eventsPending: (result && result.eventsPending) || 0,
    anySuccess: !!(result && result.anySuccess),
  };
}

function inflightCount() { return INFLIGHT.size; }

module.exports = { startInspect, runInspect, findTarget, manualWindowKey, inflightCount, MIN_GAP_MS };
