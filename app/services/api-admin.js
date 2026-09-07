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
const ProviderHealth = require('./providers/health.js');
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

// 超管凭证闸门：无 token / token 非法 / 非 platform_admin → 拒（已响应）；
// 通过则返回 payload（调用方直接用，避免二次验签的每请求双倍 HMAC+读密钥开销）。
function requireAdmin(req, res) {
  const token = extractToken(req);
  if (!token) { sendJSON(res, 401, { error: 'ADMIN_AUTH_REQUIRED' }); return null; }
  const payload = auth.verifyAdminToken(token);
  if (!payload || payload.role !== 'platform_admin') { sendJSON(res, 401, { error: 'BAD_ADMIN_TOKEN' }); return null; }
  return payload;
}

// 工单读取：优先 x-admin-ticket 头（不进 URL/反代日志/浏览器历史），兼容 ?ticket= 查询参数
function ticketOf(req, url) {
  const h = req.headers && req.headers['x-admin-ticket'];
  if (h) return String(h).trim();
  return url ? url.searchParams.get('ticket') : null;
}

// 路径段安全解码：畸形百分号编码回 400 而不是炸成 500
function safeDecode(seg, res) {
  try { return decodeURIComponent(seg); }
  catch (e) { sendJSON(res, 400, { error: 'BAD_PATH_ENCODING' }); return null; }
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
  const adminPayload = requireAdmin(req, res);
  if (!adminPayload) return true;
  // 操作者身份（token.sub = 具体管理员账号），写入审计，区分到人。
  const by = adminPayload.sub || null;

  // 全局总览
  if (p === '/api/admin/overview' && req.method === 'GET') {
    return sendJSON(res, 200, admin.getGlobalOverview());
  }

  // R5.4：搜索源健康状态（管理面板数据源）
  if (p === '/api/admin/source-health' && req.method === 'GET') {
    let serper = { keys: 0, disabled: 0 };
    try {
      const { loadConfig } = require('../core/config.js');
      const { getSerperPool } = require('./providers/search.js');
      const pool = getSerperPool(loadConfig() || {});
      serper = { keys: pool.keys.length, disabled: pool.disabled.size };
    } catch (e) { /* 配置不可读时只报健康快照 */ }
    return sendJSON(res, 200, { providers: ProviderHealth.snapshot(), serper });
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
    const tid = safeDecode(tm[1], res);
    if (!tid) return true;
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
    const tid = safeDecode(tp[1], res);
    if (!tid) return true;
    const u = new URL(req.url, 'http://localhost');
    const ticket = ticketOf(req, u);
    if (!ticket) return sendJSON(res, 400, { error: 'TICKET_REQUIRED' });
    const r = admin.getTenantPlaintext(tid, ticket, by); // by：审计"哪个管理员看了明文"
    if (r.error) return sendJSON(res, 403, { error: r.error });
    return sendJSON(res, 200, r);
  }

  // 单项目路由：/api/admin/tenant/:id/project/:pid
  const pm = p.match(/^\/api\/admin\/tenant\/([^/]+)\/project\/([^/]+)$/);
  if (pm) {
    const tid = safeDecode(pm[1], res);
    if (!tid) return true;
    const pid = safeDecode(pm[2], res);
    if (!pid) return true;
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
    const tid = safeDecode(pp[1], res);
    if (!tid) return true;
    const pid = safeDecode(pp[2], res);
    if (!pid) return true;
    const u = new URL(req.url, 'http://localhost');
    const ticket = ticketOf(req, u);
    if (!ticket) return sendJSON(res, 400, { error: 'TICKET_REQUIRED' });
    const r = admin.getProjectPlaintext(tid, pid, ticket, by);
    if (r.error) return sendJSON(res, 403, { error: r.error });
    return sendJSON(res, 200, r);
  }

  // 未命中超管路由 → 交还旧路由
  return false;
}

module.exports = { handleAdminRoutes };
