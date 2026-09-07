'use strict';
// ============================================================
// 平台超管服务（v0.2，§6.1）—— 与租户通道完全隔离
//
// 能力（按架构 §6.1）：
//   · 全局租户列表 / 配额使用 / 异常标记 / 全局 Serper 池余量（聚合派生）/ 封禁降级
//   · Debug Mirror（P1-4）：默认开启的脱敏排障视图——可见数据结构层，
//     但竞品品牌名 / 价格数值替换为占位符（<Brand n> / <price>），永不出现可定位明文。
//   · 工单授权明文：仅当租户提交支持工单并授权（grantTicket）后，凭 ticket 临时看明文，且留审计。
//
// 安全边界：
//   · 超管凭证用独立密钥（auth.getAdminSecret），租户 JWT 验不过 → 结构上无法伪装。
//   · Debug Mirror 与明文是两条独立路径：默认走脱敏；明文必须持有效 ticket，且每次访问写审计。
//   · 审计轨迹持久化到 data/.admin-state.json（data/ 不进部署包，服务器侧持久）。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db.js');
const auth = require('./auth.js');
const { debugMirror } = require('../middleware/sanitize.js');

const ROOT = path.join(__dirname, '..');
// ZB_DATA_DIR 可覆盖数据目录（与 core/paths.js 同口径）
const DATA_DIR = process.env.ZB_DATA_DIR ? path.resolve(process.env.ZB_DATA_DIR) : path.join(ROOT, 'data');
const STATE_PATH = process.env.MT_ADMIN_STATE_PATH || path.join(DATA_DIR, '.admin-state.json');

const TICKET_MIN_MIN = 5;
const TICKET_MAX_MIN = 240;

function ensureState2() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function readState() {
  ensureState2();
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    s.tickets = s.tickets || {};
    s.audit = s.audit || [];
    return s;
  } catch { return { tickets: {}, audit: [] }; }
}
// 原子写（tmp+rename）：修复直接 writeFileSync 在崩溃时留下截断 JSON，
// 下次 readState 失败回空对象、写回即把全部审计与工单静默清零的缺陷。
function writeState(s) {
  ensureState2();
  // 顺带清理过期工单（只增不删会无限累积）
  const now = Date.now();
  for (const id of Object.keys(s.tickets || {})) {
    const tk = s.tickets[id];
    if (tk && tk.status !== 'revoked' && tk.expiresAt && tk.expiresAt < now - 7 * 86400000) delete s.tickets[id];
  }
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2));
  fs.renameSync(tmp, STATE_PATH);
}
function audit(s, entry) {
  s.audit.unshift(Object.assign({ at: new Date().toISOString() }, entry));
  if (s.audit.length > 500) s.audit.length = 500;
}

// ---------------- 超管登录（多账号 + 旧单密钥并存） ----------------
// 新：{ username, password } → 走多账号（到人、可审计）。
// 旧：{ key } → 走单一共享密钥（运维后门，向后兼容，sub='platform-admin'）。
function adminLogin(creds) {
  creds = creds || {};
  if (creds.username && creds.password) {
    const acct = auth.verifyAdminCredentials(creds.username, creds.password);
    if (!acct) return null;
    return auth.issueAdminToken(acct.username, acct.role || 'platform_admin');
  }
  if (creds.key) {
    if (!auth.verifyAdminKey(creds.key)) return null;
    return auth.issueAdminToken('platform-admin', 'platform_admin');
  }
  return null;
}

// ---------------- 全局总览 ----------------
function getGlobalOverview() {
  const tenants = db.listAllTenants();
  const rows = tenants.map(t => {
    const members = db.listUsers(t.id).length;
    const projects = db.listProjects(t.id).length;
    const m = db.getMetering(t.id) || {};
    const search = (m.search_calls && m.search_calls.billed) || 0;
    const enrich = (m.enrich_runs && m.enrich_runs.billed) || 0;
    return {
      id: t.id, name: t.name, email: t.email, plan: t.plan,
      status: t.status || 'active', createdAt: t.createdAt,
      members, projects, billed: { search_calls: search, enrich_runs: enrich }
    };
  });
  const totalBilledSearch = rows.reduce((a, r) => a + r.billed.search_calls, 0);
  const suspended = rows.filter(r => r.status === 'suspended').length;
  // 全局 Serper 池余量：本 JSON 起步实现无独立平台池计数器，此处聚合各租户已计费搜索调用
  // 作为"平台级总消耗"视角（真实池余量需结合订阅档位与 Stripe 额度，phase-2 接入）。
  return {
    tenants: rows,
    global: { tenantCount: rows.length, suspended, totalBilledSearchCalls: totalBilledSearch }
  };
}

// ---------------- Debug Mirror（脱敏排障视图，默认） ----------------
function getTenantDebugMirror(tenantId) {
  const t = db.getTenant(tenantId);
  if (!t) return { error: 'TENANT_NOT_FOUND' };
  // 项目内容过 debugMirror：品牌/价格明文 → <Brand n> / <price>，结构（字段/URL/状态机）保留
  const projects = db.listProjects(tenantId).map(p => debugMirror(p, { n: 0 }));
  return {
    tenant: { id: t.id, name: t.name, email: t.email, plan: t.plan, status: t.status || 'active', createdAt: t.createdAt },
    projects,
    note: 'DEBUG_MIRROR：竞品品牌名/价格已脱敏为占位符。需要明文请先 grantTicket 再走 /plaintext。'
  };
}
function getProjectDebugMirror(tenantId, projectId) {
  const t = db.getTenant(tenantId);
  if (!t) return { error: 'TENANT_NOT_FOUND' };
  const proj = db.getProjectById(projectId);
  if (!proj || proj.tenantId !== tenantId) return { error: 'PROJECT_NOT_FOUND' };
  return { project: debugMirror(proj, { n: 0 }) };
}

// ---------------- 工单授权明文 ----------------
function grantTicket({ tenantId, reason, ttlMin }, by) {
  if (!db.getTenant(tenantId)) return { error: 'TENANT_NOT_FOUND' };
  let ttl = parseInt(ttlMin, 10);
  if (!ttl || isNaN(ttl)) ttl = 30;
  ttl = Math.min(Math.max(ttl, TICKET_MIN_MIN), TICKET_MAX_MIN); // 5~240 分钟
  const id = 'tk:' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();
  const expiresAt = now + ttl * 60 * 1000;
  const s = readState();
  s.tickets[id] = {
    tenantId, reason: reason || '',
    grantedAt: new Date(now).toISOString(), expiresAt, status: 'active'
  };
  audit(s, { action: 'GRANT_TICKET', by: by || null, ticketId: id, tenantId, reason: reason || '', ttlMin: ttl });
  writeState(s);
  return { ticketId: id, tenantId, expiresAt: new Date(expiresAt).toISOString(), ttlMin: ttl };
}

function validateTicket(ticketId, tenantId) {
  const s = readState();
  const tk = s.tickets[ticketId];
  if (!tk) return { ok: false, reason: 'TICKET_UNKNOWN' };
  if (tk.tenantId !== tenantId) return { ok: false, reason: 'TICKET_TENANT_MISMATCH' };
  if (tk.status === 'revoked') return { ok: false, reason: 'TICKET_REVOKED' };
  if (tk.expiresAt < Date.now()) return { ok: false, reason: 'TICKET_EXPIRED' };
  return { ok: true, ticket: tk };
}

function getTenantPlaintext(tenantId, ticketId, by) {
  const v = validateTicket(ticketId, tenantId);
  if (!v.ok) return { error: v.reason };
  const t = db.getTenant(tenantId);
  if (!t) return { error: 'TENANT_NOT_FOUND' };
  const projects = db.listProjects(tenantId); // 明文（不过 debugMirror）
  const s = readState();
  audit(s, { action: 'VIEW_PLAINTEXT', by: by || null, ticketId, tenantId, scope: 'tenant' });
  writeState(s);
  return { tenant: { id: t.id, name: t.name, email: t.email, plan: t.plan, status: t.status || 'active' }, projects, ticketId };
}
function getProjectPlaintext(tenantId, projectId, ticketId, by) {
  const v = validateTicket(ticketId, tenantId);
  if (!v.ok) return { error: v.reason };
  const proj = db.getProjectById(projectId);
  if (!proj || proj.tenantId !== tenantId) return { error: 'PROJECT_NOT_FOUND' };
  const s = readState();
  audit(s, { action: 'VIEW_PLAINTEXT', by: by || null, ticketId, tenantId, scope: 'project', projectId });
  writeState(s);
  return { project: proj, ticketId };
}

function revokeTicket(ticketId, by) {
  const s = readState();
  if (!s.tickets[ticketId]) return { error: 'TICKET_UNKNOWN' };
  s.tickets[ticketId].status = 'revoked';
  audit(s, { action: 'REVOKE_TICKET', by: by || null, ticketId });
  writeState(s);
  return { ok: true };
}

// ---------------- 封禁 / 降级 ----------------
function setTenantStatus(tenantId, status, by) {
  if (!['active', 'suspended'].includes(status)) return { error: 'BAD_STATUS' };
  const t = db.setTenantStatus(tenantId, status);
  if (!t) return { error: 'TENANT_NOT_FOUND' };
  const s = readState();
  audit(s, { action: 'SET_STATUS', by: by || null, tenantId, status });
  writeState(s);
  return { tenant: { id: t.id, status: t.status } };
}

// ---------------- 审计 ----------------
function getAudit(limit) {
  const s = readState();
  let n = parseInt(limit, 10);
  if (!n || isNaN(n)) n = 50;
  n = Math.min(Math.max(n, 1), 500);
  return s.audit.slice(0, n);
}

// 测试/运维辅助：清空审计与工单（不影响租户业务数据）
function resetState() {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify({ tickets: {}, audit: [] }, null, 2)); } catch {}
}

module.exports = {
  adminLogin,
  getGlobalOverview,
  getTenantDebugMirror, getProjectDebugMirror,
  grantTicket, validateTicket, getTenantPlaintext, getProjectPlaintext, revokeTicket,
  setTenantStatus,
  getAudit,
  resetState
};
