'use strict';
// ============================================================
// 多租户 API 分发器（v0.2）
// 处理：/api/auth/register · /api/auth/login · /api/me · /api/projects（GET/POST/:id）
// 由 server.js 在路由起点拦截调用；返回 true 表示已处理（含已发响应），false 则交还旧路由。
// 旧"单 key 无登录"接口保持原样（操作 ghost 拥有的遗留全局数据），本分发器不影响它们。
// ============================================================
const auth = require('./auth.js');
const tenant = require('./tenant.js');
const metering = require('./metering.js');
const db = require('./db.js');
const { resolveIdentity } = require('../middleware/tenantScope.js');
const { sanitizeBriefing, debugMirror } = require('../middleware/sanitize.js');

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
  return true; // 关键：让调用处 `return sendJSON(...)` 得到真值，标识"已处理"，避免穿透到旧路由
}
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', c => { chunks.push(c); if (Buffer.concat(chunks).length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { const d = Buffer.concat(chunks).toString('utf8'); resolve(d ? JSON.parse(d) : {}); }
      catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

async function handleTenantRoutes(req, res, ctx) {
  const { p, config } = ctx;

  // ---- 注册 / 登录（无需先验身份） ----
  if (p === '/api/auth/register' && req.method === 'POST') {
    const body = await readBody(req);
    const r = tenant.register(body);
    if (r.error) return sendJSON(res, 400, { error: r.error });
    const token = auth.issueToken({ userId: r.user.id, tenantId: r.tenant.id, role: r.user.role });
    return sendJSON(res, 201, {
      token,
      tenant: { id: r.tenant.id, name: r.tenant.name, plan: r.tenant.plan },
      user: r.user
    });
  }
  if (p === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    const r = tenant.login(body);
    if (r.error) return sendJSON(res, 401, { error: r.error });
    const token = auth.issueToken({ userId: r.user.id, tenantId: r.tenantId, role: r.role });
    return sendJSON(res, 200, { token, user: r.user });
  }

  // ---- 仅处理本分发器管辖的租户接口；其余（含静态站点 '/'、'/api/state'、旧 API）一律交还旧路由 ----
  // 关键修复：此前对所有非注册/登录路径无条件调用 resolveIdentity，会把 '/' 与静态资源误判为
  // “未鉴权的租户接口”而返回 401，导致整个仪表盘（HTML/JS/CSS）打不开。
  // 修复（/history 空列表根因）：GET /api/projects 在此让路——它是旧端点（文件态研究档案清单，
  // Phase 1 已迁入 routes/ 注册表 misc.projectsList），本分发器的 db 版清单会遮蔽文件版，
  // 导致前端历史调研页永远拿到空列表。v0.2 仅保留 POST /api/projects 与 GET /api/projects/:id
  // （注册表未注册的端点）；文件态与 db 在清单层的汇合由 server.js 的 T3-1 镜像负责。
  const inTenantDomain = p === '/api/me'
    || (p === '/api/projects' && req.method !== 'GET')
    || /^\/api\/projects\/[^/]+$/.test(p);
  if (!inTenantDomain) return false;

  const id = resolveIdentity(req, config);
  if (id.error) return sendJSON(res, id.error, { error: id.reason || 'AUTH_REQUIRED' });

  // P0-1：幽灵租户（旧全局 Key）禁止访问任何新租户接口，否则 403
  // （第一版没有"遗留迁移专用端点"，故 ghost 在 new API 上一律 403；等迁移端点上线再放白名单）
  if (id.ghost) return sendJSON(res, 403, { error: 'GHOST_FORBIDDEN' });

  const c = { tenantId: id.tenantId, userId: id.userId, role: id.role, ghost: id.ghost };

  if (p === '/api/me' && req.method === 'GET') {
    const u = db.getUser(c.userId);
    return sendJSON(res, 200, {
      user: tenant.publicUser(u),
      tenant: db.getTenant(c.tenantId),
      quota: metering.quotaInfo(c.tenantId)
    });
  }

  if (p === '/api/projects' && req.method === 'POST') {
    if (!metering.withinQuota(c.tenantId, 'projects')) {
      return sendJSON(res, 429, { error: 'PROJECT_QUOTA', quota: metering.quotaInfo(c.tenantId) });
    }
    const body = await readBody(req);
    const proj = db.createProject({ tenantId: c.tenantId, track: body.track || body.name || 'project' });
    // 计量：建项目计一笔 projects（billed=0，项目创建不消耗外部额度，仅占配额）
    metering.recordCall(c.tenantId, 'projects', false);
    return sendJSON(res, 201, { project: sanitizeBriefing(proj) });
  }

  const m = p.match(/^\/api\/projects\/([^/]+)$/);
  if (m && req.method === 'GET') {
    const proj = db.getProject(c.tenantId, decodeURIComponent(m[1])); // 跨租户 id 返回 null（隔离裁决）
    if (!proj) return sendJSON(res, 404, { error: 'NOT_FOUND' });
    return sendJSON(res, 200, { project: sanitizeBriefing(proj) });
  }

  // 未命中多租户路由 → 交还旧路由
  return false;
}

// 供超管脱敏排障视图使用：把任意对象做 debugMirror（P1-4）
function adminDebugMirror(obj) { return debugMirror(obj); }

module.exports = { handleTenantRoutes, adminDebugMirror };
