'use strict';
// ============================================================
// handlers/discover-status.js —— 轻量品牌识别状态（2026-11 r3 §三）
// ------------------------------------------------------------
// 为什么要有它：完整 /api/state 是 1.1MB，公网要 10–30 秒才能跑到前端，
// 失败横幅/运行中状态因此要等十几秒才出现。状态接口只回答「这次识别怎么样了」，
// 目标 <10KB、无缓存、不碰任何品牌正文，让横幅 2 秒内独立出现。
//
// 纪律：
//   · 只读本租户命名空间：跨租户与不存在都回 404，不泄漏项目存在性。
//   · 不返回品牌详情 / attempts / Evidence / Snapshot / fieldSources / Key / 供应商原文。
//   · 状态口径复用 services/discover-state.js（与 /api/state、/api/projects 同一实现）。
//   · Cache-Control: no-store —— 绝不让浏览器/中间层缓存上一次的失败态。
//   · 不跑 decorateState（那是 150–260ms 的重活），状态只需要原始标记 + 统一口径函数。
// ============================================================

const { describeDiscover } = require('../../services/discover-state.js');

async function discoverStatus(ctx, req, res, url, p) {
  if (p !== '/api/discover/status' || req.method !== 'GET') return false;
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const tid = ctx.resolveTenantId();
  const s = projectId ? ctx.readProject(projectId, tid) : ctx.loadState();
  if (!s) {
    ctx.sendJSON(res, 404, { error: 'NOT_FOUND', message: '项目不存在。' }, { 'Cache-Control': 'no-store' });
    return true;
  }
  const d = describeDiscover(s);
  const err = s.discoverError || null;
  const body = {
    projectId: s.projectId || projectId || null,
    track: s.track || null,
    runId: d.runId,
    attemptNo: d.attemptNo,
    running: d.running === true,
    discoverDone: s.discoverDone === true,
    discoverEmpty: s.discoverEmpty === true,
    // 只给用户可读的原因，不给内部 reason code / 供应商正文
    discoverError: err ? {
      errorCode: err.errorCode || null,
      errorMessage: err.errorMessage || null,
      failedAt: err.failedAt || null,
      // 同租户内的上一个项目指针：「查看上一次结果」按钮需要它（r2 行为保留）
      previousProjectId: err.previousProjectId || null,
      keptPrevious: err.keptPrevious === true,
    } : null,
    keptPrevious: d.keptPrevious === true,
    // 状态口径：failed / running / done / empty / incomplete / no_track
    phase: d.phase,
    incomplete: d.phase === 'incomplete',
    message: d.message || null,
    competitorCount: Array.isArray(s.competitors) ? s.competitors.length : 0,
    updatedAt: new Date().toISOString(),
  };
  ctx.sendJSON(res, 200, body, { 'Cache-Control': 'no-store' });
  return true;
}

module.exports = { discoverStatus };
