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

// 时序防枚举：用户不存在时也执行一次等价 scrypt，抹平"存在用户多一次哈希"的响应时间差
const DUMMY_HASH = auth.hashPassword('timing-equalizer-dummy-password');
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 注册：原子地建 tenant + owner + 初始化 free 配额
function register({ email, password, name }) {
  email = (email || '').toLowerCase().trim();
  if (!email || !password) return { error: 'EMAIL_PASSWORD_REQUIRED' };
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: 'EMAIL_INVALID' };
  if (String(password).length < 8) return { error: 'PASSWORD_TOO_SHORT' };
  if (name && String(name).length > 60) return { error: 'NAME_TOO_LONG' };
  if (db.getTenantByEmail(email)) return { error: 'EMAIL_TAKEN' };
  const tenant = db.createTenant({ name: name || email.split('@')[0], email });
  const owner = db.createUser({ tenantId: tenant.id, email, passwordHash: auth.hashPassword(password), role: 'owner' });
  return { tenant, user: publicUser(owner) };
}

function login({ email, password }) {
  email = (email || '').toLowerCase().trim();
  const u = db.getUserByEmail(email);
  if (!u) {
    auth.verifyPassword(password || '', DUMMY_HASH); // 等耗时假比较，防用户名枚举
    return { error: 'INVALID_CREDENTIALS' };
  }
  if (!auth.verifyPassword(password, u.passwordHash)) return { error: 'INVALID_CREDENTIALS' };
  // 封禁裁决（§6.2）：suspended 租户连登录都拒绝，从源头掐断。
  const t = db.getTenant(u.tenantId);
  if (t && t.status === 'suspended') return { error: 'TENANT_SUSPENDED' };
  return { user: publicUser(u), tenantId: u.tenantId, role: u.role };
}

function getTenant(id) { return db.getTenant(id); }
function listUsers(tenantId) { return db.listUsers(tenantId).map(publicUser); }

// ---------------- r4 §十：账户资料 / 用户名 / 密码 ----------------
// displayName 读取优先级：用户显式设置 > 邮箱 @ 前缀（回退）。租户名不冒充用户名。
function displayNameOf(u) {
  if (!u) return '';
  const d = (u.displayName || '').trim();
  if (d) return d;
  return String(u.email || '').split('@')[0] || '用户';
}
function accountView(tenantId, userId) {
  const u = db.getUser(userId);
  if (!u || u.tenantId !== tenantId) return null; // 跨租户/不存在：null（不泄露存在性）
  const t = db.getTenant(tenantId) || {};
  let usage = null;
  try {
    const metering = require('./metering.js');
    const daily = metering.dailyDiscoverUsage(tenantId);
    usage = {
      plan: t.plan || 'free',
      dailyDiscover: daily,
      // 额度按 UTC 日统计，UTC 00:00（北京时间 08:00）重置
      resetsAtText: '每日 UTC 00:00（北京时间 08:00）重置',
      note: '当前额度由系统分配', // r4 §十：无真实支付能力，不放「充值/升级」按钮
    };
  } catch (e) { usage = null; }
  return {
    user: { id: u.id, email: u.email, role: u.role, createdAt: u.createdAt, displayName: displayNameOf(u), displayNameSet: !!(u.displayName || '').trim() },
    tenant: { id: t.id, name: t.name || '', plan: t.plan || 'free', createdAt: t.createdAt || null },
    usage,
  };
}
function updateDisplayName(tenantId, userId, displayName) {
  const u = db.getUser(userId);
  if (!u || u.tenantId !== tenantId) return { error: 'NOT_FOUND' };
  const d = String(displayName == null ? '' : displayName).trim();
  if (!d) return { error: 'NAME_REQUIRED' };
  if (d.length > 40) return { error: 'NAME_TOO_LONG' };
  const updated = db.updateUserProfile(userId, { displayName: d });
  return { ok: true, user: { id: updated.id, email: updated.email, role: updated.role, createdAt: updated.createdAt, displayName: displayNameOf(updated), displayNameSet: true } };
}
// 修改密码：校验当前密码 + 新密码强度；成功后凭证版本 +1（其他会话失效）。
// 错误信息不泄露账户状态；密码本身不出现在任何返回值/日志中。
function changePassword({ tenantId, userId, currentPassword, newPassword }) {
  const u = db.getUser(userId);
  if (!u || u.tenantId !== tenantId) return { error: 'NOT_FOUND' };
  if (!auth.verifyPassword(String(currentPassword || ''), u.passwordHash)) {
    auth.verifyPassword(String(newPassword || ''), DUMMY_HASH); // 等耗时假比较
    return { error: 'INVALID_CREDENTIALS' };
  }
  const np = String(newPassword || '');
  if (np.length < 8) return { error: 'PASSWORD_TOO_SHORT' };
  if (!/[A-Za-z]/.test(np) || !/[0-9]/.test(np)) return { error: 'PASSWORD_WEAK' };
  if (np.length > 128) return { error: 'PASSWORD_TOO_LONG' };
  db.updateUserPassword(userId, auth.hashPassword(np));
  const updated = db.bumpUserTokenVersion(userId);
  return { ok: true, tokenVersion: Number(updated.tokenVersion || 0) };
}

module.exports = { register, login, getTenant, listUsers, publicUser, accountView, updateDisplayName, changePassword, displayNameOf };
