'use strict';
// ============================================================
// handlers/observability.js —— Phase 1「真实基线与可观测性」端点组
// ------------------------------------------------------------
// GET  /api/admin/observability/summary   管理员只读统计（platform_admin 专用）
// POST /api/events/product                产品行为事件上报（tenant 登录用户）
//
// 隐私契约（任务书 §二/§三）：
//   · 统计接口只读，不落任何请求参数到库；
//   · 事件上报只接受 eventType 白名单 + objectType/objectId（objectId 入库前
//     加盐哈希）；请求体里的任何其他内容（正文/备注/输入）在入口即丢弃。
// ============================================================
const apiAdmin = require('../../services/api-admin.js');
const Telemetry = require('../../observability/telemetry.js');

// ---------- GET /api/admin/observability/summary?window_hours=168 ----------
async function adminSummary(ctx, req, res, url, p) {
  if (p !== '/api/admin/observability/summary' || req.method !== 'GET') return false;
  const admin = apiAdmin.requireAdmin(req, res); // 无 token / 非 platform_admin → 已响应 401
  if (!admin) return true;
  const whRaw = Number(url && url.searchParams && url.searchParams.get('window_hours'));
  const windowHours = Number.isFinite(whRaw) && whRaw > 0 ? Math.min(Math.floor(whRaw), 24 * 90) : 24 * 7;
  let body;
  try { body = Telemetry.summary({ windowHours }); }
  catch (e) {
    return ctx.sendJSON(res, 500, { error: 'OBS_SUMMARY_FAILED', message: '统计聚合失败（不影响业务数据）。' });
  }
  ctx.sendJSON(res, 200, body);
  return true;
}

// ---------- POST /api/events/product ----------
// body: { eventType, objectType?, objectId?, projectId? } —— 其余字段一律忽略
async function productEvent(ctx, req, res, url, p) {
  if (p !== '/api/events/product' || req.method !== 'POST') return false;
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可上报行为事件。' }); return true; }
  let body = {};
  try { body = await ctx.readBody(req) || {}; } catch (e) { body = {}; }
  const eventType = String(body.eventType || '').trim();
  if (!Telemetry.EVENT_TYPES.has(eventType)) {
    return ctx.sendJSON(res, 400, { error: 'UNSUPPORTED_EVENT', message: '不支持的事件类型。' });
  }
  const tid = ap.payload && ap.payload.tid;
  const recorded = Telemetry.recordEvent({
    eventType,
    tenantId: tid,
    projectId: typeof body.projectId === 'string' ? body.projectId.slice(0, 80) : undefined,
    objectType: typeof body.objectType === 'string' ? body.objectType : undefined,
    objectId: typeof body.objectId === 'string' ? body.objectId.slice(0, 128) : undefined,
  });
  ctx.sendJSON(res, 200, { ok: recorded != null });
  return true;
}

module.exports = { adminSummary, productEvent };
