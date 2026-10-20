'use strict';
// ============================================================
// handlers/data-surface.js —— 五维数据面端点组（SC-02 §8 / 03 §7 SC-02 扩展）
// ------------------------------------------------------------
// 端点：
//   GET  /api/data-surface/overview?projectId?&competitorId   五维总览（tenant）
//   GET  /api/data-surface/dimension?projectId?&competitorId&dimension&offset&limit
//   POST /api/data-surface/refresh   手动刷新（幂等：running 复用 + capability
//                                    级 cooldown + 日额度；202+持久任务入队，
//                                    常驻 worker 消费——禁止进程内 fire-and-forget）
//   GET  /api/data-surface/refresh-policy?capability= 刷新策略与剩余冷却/额度
//   GET  /api/admin/data-surface/capabilities   能力矩阵 + adapter 健康（admin only）
// 纪律：
//   · 租户硬隔离（03 §17）：项目归属 db.getProject 校验；竞品必须在项目档案内；
//     跨租户 404 不泄露存在性
//   · 用户响应剔除 provider/内部错误码/路径/栈（04 §20）；错误只给产品化文案
//   · 未接入能力显式 400 CAPABILITY_NOT_SUPPORTED（不让用户刷新必然失败的能力）
//   · handler 契约：处理并已发响应 → return true
// ============================================================
const db = require('../../services/db.js');
const fs = require('fs');
const Registry = require('../../services/capability-registry.js');
const Adapters = require('../../services/source-adapter.js');
const SurfaceStore = require('../../services/surface-store.js');
const CollectJobs = require('../../services/collect-jobs.js');
const Surface = require('../../services/data-surface.js');

function tidOf(ctx, req) {
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') return null;
  return (ap.payload && ap.payload.tid) || null;
}
function isAdmin(ap) { return !!(ap && ap.kind === 'admin'); }

// 解析项目与竞品（显式 projectId 必须属于本租户；缺省 = 当前项目）
function resolveComp(ctx, tid, projectIdRaw, competitorId) {
  let projectId = typeof projectIdRaw === 'string' ? projectIdRaw.trim().slice(0, 80) : '';
  let state = null;
  if (projectId) {
    if (!db.getProject(tid, projectId)) return { error: [404, 'PROJECT_NOT_FOUND', '项目不存在或不属于当前租户。'] };
    try {
      const f = ctx.projFile && ctx.projFile(projectId, tid);
      if (f) state = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { state = null; }
    if (!state) {
      state = ctx.loadState();
      if (state && state.projectId && state.projectId !== projectId) state = null;
    }
  } else {
    state = ctx.loadState();
    projectId = state && state.projectId ? state.projectId : '';
    if (!projectId) return { error: [404, 'PROJECT_NOT_FOUND', '没有当前调研项目。'] };
  }
  const comp = state && Array.isArray(state.competitors) ? state.competitors.find(c => c && c.id === competitorId) : null;
  if (!comp) return { error: [404, 'COMPETITOR_NOT_FOUND', '竞争品牌不存在于当前项目。'] };
  return { projectId, comp };
}

function attemptUserView(a) {
  if (!a) return null;
  return {
    attemptId: a.attemptId,
    status: a.status,
    errorText: a.errorUserText || null,
    observationCount: a.observationCount,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
  };
}

// ---------- GET /api/data-surface/overview ----------
async function overview(ctx, req, res, url, p) {
  if (p !== '/api/data-surface/overview' || req.method !== 'GET') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可查看数据面。' }); return true; }
  const competitorId = (url.searchParams.get('competitorId') || '').trim().slice(0, 80);
  if (!competitorId) { ctx.sendJSON(res, 400, { error: 'EMPTY', message: '缺少 competitorId。' }); return true; }
  const rc = resolveComp(ctx, tid, url.searchParams.get('projectId'), competitorId);
  if (rc.error) { ctx.sendJSON(res, rc.error[0], { error: rc.error[1], message: rc.error[2] }); return true; }
  const ov = Surface.buildOverview({ tenantId: tid, projectId: rc.projectId, competitorId, comp: rc.comp });
  ctx.sendJSON(res, 200, ov);
  return true;
}

// ---------- GET /api/data-surface/dimension ----------
async function dimension(ctx, req, res, url, p) {
  if (p !== '/api/data-surface/dimension' || req.method !== 'GET') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可查看数据面。' }); return true; }
  const competitorId = (url.searchParams.get('competitorId') || '').trim().slice(0, 80);
  const dim = (url.searchParams.get('dimension') || '').trim().slice(0, 40);
  if (!competitorId || !dim) { ctx.sendJSON(res, 400, { error: 'EMPTY', message: '缺少 competitorId 或 dimension。' }); return true; }
  const cap = Registry.capabilitiesByDimension(dim);
  if (!cap.length) { ctx.sendJSON(res, 404, { error: 'DIMENSION_NOT_FOUND', message: '数据维度不存在。' }); return true; }
  const rc = resolveComp(ctx, tid, url.searchParams.get('projectId'), competitorId);
  if (rc.error) { ctx.sendJSON(res, rc.error[0], { error: rc.error[1], message: rc.error[2] }); return true; }
  const detail = Surface.buildDimensionDetail({
    tenantId: tid, projectId: rc.projectId, competitorId, dimension: dim,
    offset: url.searchParams.get('offset'), limit: url.searchParams.get('limit'), comp: rc.comp,
  });
  ctx.sendJSON(res, 200, detail);
  return true;
}

// ---------- GET /api/data-surface/refresh-policy ----------
async function refreshPolicy(ctx, req, res, url, p) {
  if (p !== '/api/data-surface/refresh-policy' || req.method !== 'GET') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可查看刷新策略。' }); return true; }
  const competitorId = (url.searchParams.get('competitorId') || '').trim().slice(0, 80);
  const capability = (url.searchParams.get('capability') || '').trim().slice(0, 60);
  if (!competitorId || !capability) { ctx.sendJSON(res, 400, { error: 'EMPTY', message: '缺少 competitorId 或 capability。' }); return true; }
  if (!Registry.getCapability(capability)) { ctx.sendJSON(res, 404, { error: 'CAPABILITY_NOT_FOUND', message: '能力不存在。' }); return true; }
  const rc = resolveComp(ctx, tid, url.searchParams.get('projectId'), competitorId);
  if (rc.error) { ctx.sendJSON(res, rc.error[0], { error: rc.error[1], message: rc.error[2] }); return true; }
  ctx.sendJSON(res, 200, Surface.buildRefreshPolicy({ tenantId: tid, projectId: rc.projectId, competitorId, capability }));
  return true;
}

// ---------- POST /api/data-surface/refresh ----------
async function refresh(ctx, req, res, url, p) {
  if (p !== '/api/data-surface/refresh' || req.method !== 'POST') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可刷新数据。' }); return true; }
  let body = {};
  try { body = await ctx.readBody(req) || {}; } catch (e) { body = {}; }
  const competitorId = typeof body.competitorId === 'string' ? body.competitorId.trim().slice(0, 80) : '';
  if (!competitorId) { ctx.sendJSON(res, 400, { error: 'EMPTY', message: '缺少 competitorId。' }); return true; }
  const capabilityCode = typeof body.capability === 'string' && body.capability.trim() ? body.capability.trim().slice(0, 60) : 'shopify_catalog';
  const cap = Registry.getCapability(capabilityCode);
  if (!cap) { ctx.sendJSON(res, 404, { error: 'CAPABILITY_NOT_FOUND', message: '能力不存在。' }); return true; }
  // P0-2 整改 r2：实现状态（maturity）与运行状态（readiness）分离。
  // ga 与 pending_config 均可发起真实采集；not_integrated 仍拒绝。
  if (!cap.manualRefresh || cap.maturity === 'not_integrated') {
    ctx.sendJSON(res, 400, { error: 'CAPABILITY_NOT_SUPPORTED', message: '该数据维度尚未接入，暂不支持刷新。' });
    return true;
  }
  const Readiness = require('../../services/source-readiness.js');
  if (cap.maturity === 'pending_config') {
    const rd = Readiness.getReadiness(cap.code);
    if (rd.state === 'not_configured') {
      // 用户侧文案（任务书 r2 §P0-2）：不出现环境变量名 / key 名；技术细节仅管理员健康接口可见
      ctx.sendJSON(res, 400, { error: 'SOURCE_NOT_CONFIGURED', message: '数据服务暂不可用，请稍后再试。' });
      return true;
    }
    // ready_to_verify / operational / auth_rejected / quota_exhausted / unavailable → 允许真实采集；
    // 真实失败按分类落账（绝不伪装无结果），成功即持久化 provider verification。
  }
  const rc = resolveComp(ctx, tid, typeof body.projectId === 'string' ? body.projectId : '', competitorId);
  if (rc.error) { ctx.sendJSON(res, rc.error[0], { error: rc.error[1], message: rc.error[2] }); return true; }
  // 🔴 SC-06 r2：采集链路收口到 services/collect-request.js——
  // 用户手动刷新与「调研完成后自动采集」走完全相同的幂等/冷却/额度/attempt/入队链路。
  const CollectReq = require('../../services/collect-request.js');
  const r = CollectReq.requestCollection({
    tenantId: tid, projectId: rc.projectId, competitorId,
    capability: cap.code, comp: rc.comp, trigger: 'manual',
  });
  if (r.status === 'unknown_capability') {
    ctx.sendJSON(res, 404, { error: 'CAPABILITY_NOT_FOUND', message: '能力不存在。' }); return true;
  }
  if (r.status === 'not_supported') {
    ctx.sendJSON(res, 400, { error: 'CAPABILITY_NOT_SUPPORTED', message: r.message || '当前品牌不支持该数据维度。' }); return true;
  }
  if (r.status === 'not_configured') {
    // 用户侧文案（任务书 r2 §P0-2）：不出现环境变量名 / key 名；技术细节仅管理员健康接口可见
    ctx.sendJSON(res, 400, { error: 'SOURCE_NOT_CONFIGURED', message: '数据服务暂不可用，请稍后再试。' }); return true;
  }
  if (r.status === 'quota') {
    const rp = cap.refreshPolicy || {};
    ctx.sendJSON(res, 429, {
      error: 'REFRESH_QUOTA_EXCEEDED',
      message: '今日刷新次数已达上限，明天再来吧。',
      quota: { dailyQuota: rp.dailyQuota, scope: 'per_capability_per_competitor' },
    });
    return true;
  }
  if (r.status === 'deduped') {
    if (r.reason === 'cooldown') {
      const policy = Surface.buildRefreshPolicy({ tenantId: tid, projectId: rc.projectId, competitorId, capability: cap.code });
      ctx.sendJSON(res, 200, {
        attempt: attemptUserView(r.attempt), deduped: true, reason: 'cooldown',
        message: '该数据刚刚更新过，已按刷新间隔复用最近结果（不重复产生费用）。',
        policy,
      });
      return true;
    }
    // 同 scope 已有任务（竞态兜底）：仍返回 deduped，不产生第二个采集
    const payload = {
      attempt: attemptUserView(r.attempt), deduped: true, reason: 'in_progress_or_recent',
      message: '已有一次相同采集在进行或刚完成，已复用该次结果（不重复产生费用）。',
    };
    if (r.jobId) payload.jobId = r.jobId;
    ctx.sendJSON(res, 200, payload);
    return true;
  }
  // 202 + 持久任务入队（长任务契约 >10s；worker 常驻消费；前端轮询 overview）
  ctx.sendJSON(res, 202, { attempt: attemptUserView(r.attempt), deduped: false, jobId: r.jobId });
  return true;
}

// ---------- GET /api/admin/data-surface/capabilities（admin only） ----------
async function adminCapabilities(ctx, req, res, url, p) {
  if (p !== '/api/admin/data-surface/capabilities' || req.method !== 'GET') return false;
  const ap = ctx.getAuthPayload(req);
  if (!ap) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' }); return true; }
  if (!isAdmin(ap)) {
    ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅平台超管可查看能力矩阵。' });
    return true;
  }
  // P0-2 整改 r2：并入数据源就绪状态（readiness）——技术细节（哪些 key 已配置、
  // 失败分类）仅管理员可见；只显示配置存在性布尔，绝不显示密钥值。
  const Readiness = require('../../services/source-readiness.js');
  const matrix = Surface.buildAdminMatrix();
  matrix.sourceReadiness = Readiness.adminView();
  ctx.sendJSON(res, 200, matrix);
  return true;
}

module.exports = { overview, dimension, refresh, refreshPolicy, adminCapabilities };
