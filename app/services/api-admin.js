'use strict';
// ============================================================
// 平台超管 API 分发器（v0.2，§6.1）
// 处理：/api/admin/login · /api/admin/overview · /api/admin/audit
//       /api/admin/ticket(POST) · /api/admin/tenant/:id(调试镜像/状态)
//       /api/admin/tenant/:id/plaintext · /api/admin/tenant/:id/project/:pid(调试镜像/明文)
// 由 server.js 在路由起点拦截调用；返回 true 表示已处理。
//
// 关键隔离：超管凭证与租户 JWT 用不同密钥（auth.verifyAdminToken vs verifyToken），
// 租户 token 在本分发器一律 BAD_ADMIN_TOKEN；反之亦然。两条通道互不可达。
// ============================================================
const auth = require('./auth.js');
const admin = require('./admin.js');
const db = require('./db.js');
const { extractToken } = require('../middleware/tenantScope.js');

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
  return true; // 让调用处 `return sendJSON(...)` 得到真值，标识"已处理"，避免穿透旧路由
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

// 超管凭证闸门：无 token / token 非法 / 非 platform_admin → 拒。返回 true（已响应）或 null（通过）。
function requireAdmin(req, res) {
  const token = extractToken(req);
  if (!token) return sendJSON(res, 401, { error: 'ADMIN_AUTH_REQUIRED' });
  const payload = auth.verifyAdminToken(token);
  if (!payload || payload.role !== 'platform_admin') return sendJSON(res, 401, { error: 'BAD_ADMIN_TOKEN' });
  return null;
}

async function handleAdminRoutes(req, res, ctx) {
  const { p } = ctx;

  // 仅处理超管域；其余（含静态站点 '/'、'/api/state'、旧 API）一律交还旧路由。
  // 关键修复：此前对所有 /api/admin/ 外路径无条件调用 requireAdmin，会把 '/' 与静态资源误判为
  // “未鉴权的超管接口”而返回 401。
  if (!p.startsWith('/api/admin/')) return false;

  // ---- 登录（无需先验） ----
  if (p === '/api/admin/login' && req.method === 'POST') {
    const body = await readBody(req);
    const token = admin.adminLogin(body); // 支持 {key}（旧单密钥）或 {username,password}（多账号）
    if (!token) return sendJSON(res, 401, { error: 'BAD_ADMIN_KEY' });
    const out = { token, role: 'platform_admin' };
    if (body && body.username) out.username = body.username; // 多账号登录回带用户名，便于前端展示
    return sendJSON(res, 200, out);
  }

  // ---- 其余全部需要超管凭证 ----
  const deny = requireAdmin(req, res);
  if (deny) return deny;
  // 取出操作者身份（token.sub = 具体管理员账号），写入审计，区分到人。
  const adminPayload = auth.verifyAdminToken(extractToken(req));
  const by = adminPayload ? adminPayload.sub : null;

  // 全局总览
  if (p === '/api/admin/overview' && req.method === 'GET') {
    return sendJSON(res, 200, admin.getGlobalOverview());
  }

  // 审计
  if (p === '/api/admin/audit' && req.method === 'GET') {
    const u = new URL(req.url, 'http://localhost');
    const limit = u.searchParams.get('limit');
    return sendJSON(res, 200, { audit: admin.getAudit(limit) });
  }

  // 发工单（授权临时明文）
  if (p === '/api/admin/ticket' && req.method === 'POST') {
    const body = await readBody(req);
    const r = admin.grantTicket({ tenantId: body.tenantId, reason: body.reason, ttlMin: body.ttlMin }, by);
    if (r.error) return sendJSON(res, 400, { error: r.error });
    return sendJSON(res, 201, r);
  }

  // 租户路由：/api/admin/tenant/:id
  const tm = p.match(/^\/api\/admin\/tenant\/([^/]+)$/);
  if (tm) {
    const tid = decodeURIComponent(tm[1]);
    if (req.method === 'GET') {
      const dm = admin.getTenantDebugMirror(tid);
      if (dm.error) return sendJSON(res, 404, { error: dm.error });
      return sendJSON(res, 200, dm);
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const r = admin.setTenantStatus(tid, body.status, by);
      if (r.error) return sendJSON(res, 400, { error: r.error });
      return sendJSON(res, 200, r);
    }
    return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  }

  // 租户全部明文（需 ticket）
  const tp = p.match(/^\/api\/admin\/tenant\/([^/]+)\/plaintext$/);
  if (tp && req.method === 'GET') {
    const tid = decodeURIComponent(tp[1]);
    const u = new URL(req.url, 'http://localhost');
    const ticket = u.searchParams.get('ticket');
    if (!ticket) return sendJSON(res, 400, { error: 'TICKET_REQUIRED' });
    const r = admin.getTenantPlaintext(tid, ticket);
    if (r.error) return sendJSON(res, 403, { error: r.error });
    return sendJSON(res, 200, r);
  }

  // 单项目路由：/api/admin/tenant/:id/project/:pid
  const pm = p.match(/^\/api\/admin\/tenant\/([^/]+)\/project\/([^/]+)$/);
  if (pm) {
    const tid = decodeURIComponent(pm[1]);
    const pid = decodeURIComponent(pm[2]);
    if (req.method === 'GET') {
      const r = admin.getProjectDebugMirror(tid, pid); // 默认脱敏
      if (r.error) return sendJSON(res, 404, { error: r.error });
      return sendJSON(res, 200, r);
    }
    return sendJSON(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  }

  // 单项目明文（需 ticket）
  const pp = p.match(/^\/api\/admin\/tenant\/([^/]+)\/project\/([^/]+)\/plaintext$/);
  if (pp && req.method === 'GET') {
    const tid = decodeURIComponent(pp[1]);
    const pid = decodeURIComponent(pp[2]);
    const u = new URL(req.url, 'http://localhost');
    const ticket = u.searchParams.get('ticket');
    if (!ticket) return sendJSON(res, 400, { error: 'TICKET_REQUIRED' });
    const r = admin.getProjectPlaintext(tid, pid, ticket);
    if (r.error) return sendJSON(res, 403, { error: r.error });
    return sendJSON(res, 200, r);
  }

  // 未命中超管路由 → 交还旧路由
  return false;
}

module.exports = { handleAdminRoutes };
