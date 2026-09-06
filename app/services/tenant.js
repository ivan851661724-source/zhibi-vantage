'use strict';
// ============================================================
// 租户 / 用户 / 项目 业务层（v0.2）—— 建立在 services/db.js 之上
// 账号是租户骨架的根：注册即建 tenant（首注册人=owner），登录发 JWT。
// ============================================================
const db = require('./db.js');
const auth = require('./auth.js');

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, role: u.role, tenantId: u.tenantId };
}

// 注册：原子地建 tenant + owner + 初始化 free 配额
function register({ email, password, name }) {
  email = (email || '').toLowerCase().trim();
  if (!email || !password) return { error: 'EMAIL_PASSWORD_REQUIRED' };
  if (String(password).length < 8) return { error: 'PASSWORD_TOO_SHORT' };
  if (db.getTenantByEmail(email)) return { error: 'EMAIL_TAKEN' };
  const tenant = db.createTenant({ name: name || email.split('@')[0], email });
  const owner = db.createUser({ tenantId: tenant.id, email, passwordHash: auth.hashPassword(password), role: 'owner' });
  return { tenant, user: publicUser(owner) };
}

function login({ email, password }) {
  email = (email || '').toLowerCase().trim();
  const u = db.getUserByEmail(email);
  if (!u || !auth.verifyPassword(password, u.passwordHash)) return { error: 'INVALID_CREDENTIALS' };
  // 封禁裁决（§6.2）：suspended 租户连登录都拒绝，从源头掐断。
  const t = db.getTenant(u.tenantId);
  if (t && t.status === 'suspended') return { error: 'TENANT_SUSPENDED' };
  return { user: publicUser(u), tenantId: u.tenantId, role: u.role };
}

function getTenant(id) { return db.getTenant(id); }
function listUsers(tenantId) { return db.listUsers(tenantId).map(publicUser); }

module.exports = { register, login, getTenant, listUsers, publicUser };
