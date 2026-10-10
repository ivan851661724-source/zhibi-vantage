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
// 审核整改 §三：projectId 不可信——必须先验证该项目属于当前登录租户（db.getProject
// 按 tenantId 硬过滤），归属校验通过后才转 project_hash 入库；不存在/不属于当前租户
// → 404 受控错误且不写库（不区分"不存在"与"别人的"，不向外租户泄露存在性）。
async function productEvent(ctx, req, res, url, p) {
  if (p !== '/api/events/product' || req.method !== 'POST') return false;
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可上报行为事件。' }); return true; }
  let body = {};
  try { body = await ctx.readBody(req) || {}; } catch (e) { body = {}; }
  const eventType = String(body.eventType || '').trim();
  if (!Telemetry.EVENT_TYPES.has(eventType)) {
    ctx.sendJSON(res, 400, { error: 'UNSUPPORTED_EVENT', message: '不支持的事件类型。' });
    return true; // 注册表契约：显式 true 才算已处理（sendJSON 返回 undefined 不能透传）
  }
  const tid = ap.payload && ap.payload.tid;
  let projectId;
  if (typeof body.projectId === 'string' && body.projectId.trim()) {
    projectId = body.projectId.slice(0, 80);
    let owned = false;
    try { owned = !!require('../../services/db.js').getProject(tid, projectId); } catch (e) { owned = false; }
    if (!owned) {
      ctx.sendJSON(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在或不属于当前租户。' });
      return true; // 同上：显式 true
    }
  }
  const recorded = Telemetry.recordEvent({
    eventType,
    tenantId: tid,
    projectId, // 已验证归属 → telemetry 内加盐哈希为 project_hash 落库
    objectType: typeof body.objectType === 'string' ? body.objectType : undefined,
    objectId: typeof body.objectId === 'string' ? body.objectId.slice(0, 128) : undefined,
  });
  ctx.sendJSON(res, 200, { ok: recorded != null });
  return true;
}

module.exports = { adminSummary, productEvent };
