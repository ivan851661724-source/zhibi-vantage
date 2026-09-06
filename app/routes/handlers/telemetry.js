'use strict';
// ============================================================
// handlers/telemetry.js —— 数据自动化新接口（A12 实施 §7 前端契约）
// GET /api/tasks?projectId=     项目任务队列状态（0-4：pending/running/done/dead + 进度）
// GET /api/cost/summary?days=7  三级归因成本汇总（1-1：tenant 口径，按 kind/project/competitor/field 分组）
// GET /api/scheduler/status     定时雷达状态（2-1：enabled/hours/nextAt/lastSweepAt）
// ============================================================
const Tasks = require('../../services/tasks.js');
const Cost = require('../../services/cost.js');
const Scheduler = require('../../services/scheduler.js');

// ---------- GET /api/tasks?projectId= （tenant） ----------
async function tasks(ctx, req, res, url, p) {
  if (p !== '/api/tasks' || req.method !== 'GET') return false;
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') return ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可查看任务状态。' });
  const tid = ap.payload.tid;
  const projectId = (url.searchParams.get('projectId') || '').trim();
  if (!projectId) return ctx.sendJSON(res, 400, { error: 'EMPTY', message: '请指定 projectId' });
  const rows = Tasks.list(projectId, tid);
  const counts = Tasks.counts(projectId, tid);
  return ctx.sendJSON(res, 200, {
    projectId, counts,
    tasks: rows.map(r => ({
      id: r.id, type: r.type, status: r.status, priority: r.priority,
      retry: r.retry, attempts: r.attempts, createdAt: r.createdAt, doneAt: r.doneAt, lastError: r.lastError,
    })),
  });
}

// ---------- GET /api/cost/summary?days=7 （tenant） ----------
async function costSummary(ctx, req, res, url, p) {
  if (p !== '/api/cost/summary' || req.method !== 'GET') return false;
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') return ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可查看成本。' });
  const tid = ap.payload.tid;
  const days = Math.max(1, Math.min(90, parseInt(url.searchParams.get('days') || '7', 10) || 7));
  const rows = Cost.summary(tid, days);
  const total = rows.reduce((a, r) => a + (r.costYuan || 0), 0);
  const byKind = rows.reduce((acc, r) => { acc[r.kind] = (acc[r.kind] || 0) + (r.costYuan || 0); return acc; }, {});
  return ctx.sendJSON(res, 200, {
    days, totalYuan: Number(total.toFixed(6)), byKind,
    details: rows.map(r => ({
      kind: r.kind, projectId: r.projectId, competitorId: r.competitorId, fieldKey: r.fieldKey,
      calls: r.calls, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costYuan: Number((r.costYuan || 0).toFixed(6)),
    })),
  });
}

// ---------- GET /api/scheduler/status （tenant） ----------
async function schedulerStatus(ctx, req, res, url, p) {
  if (p !== '/api/scheduler/status' || req.method !== 'GET') return false;
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') return ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可查看。' });
  return ctx.sendJSON(res, 200, Scheduler.status());
}

module.exports = { tasks, costSummary, schedulerStatus, alerts, alertsRead };

// ---------- GET /api/alerts （tenant：站内信预警列表） ----------
async function alerts(ctx, req, res, url, p) {
  if (p !== '/api/alerts' || req.method !== 'GET') return false;
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') return ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可查看。' });
  const tid = ap.payload.tid;
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const items = ctx.Alerts ? ctx.Alerts.list(tid, limit) : [];
  const unread = items.filter(x => !x.read).length;
  return ctx.sendJSON(res, 200, { alerts: items, unread });
}

// ---------- POST /api/alerts/read （tenant：标记已读） ----------
async function alertsRead(ctx, req, res, url, p) {
  if (p !== '/api/alerts/read' || req.method !== 'POST') return false;
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') return ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可操作。' });
  const tid = ap.payload.tid;
  const body = await ctx.readBody(req);
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return ctx.sendJSON(res, 400, { error: 'EMPTY', message: '请指定 ids' });
  const marked = ctx.Alerts ? ctx.Alerts.markRead(tid, ids) : 0;
  return ctx.sendJSON(res, 200, { marked });
}
