'use strict';
// ============================================================
// routes/handlers/auth.js —— 登录 / 注册端点（P0 恢复）
// ------------------------------------------------------------
// 背景：Phase 1 路由化迁移时 login/register 旧 if/else 被删、
//       未迁入注册表 → 新用户无法注册、老用户无法登录（AUTH_REQUIRED）。
// 修复：经 tenant.register/login + auth.issueToken 恢复两个公开端点。
// 注意：本 handler 直接 require services（无循环依赖：tenant→db/auth）。
// ============================================================
const tenant = require('../../services/tenant.js');
const auth = require('../../services/auth.js');

const ERR_MSG = {
  EMAIL_PASSWORD_REQUIRED: '请填写邮箱与密码',
  PASSWORD_TOO_SHORT: '密码至少 8 位',
  EMAIL_TAKEN: '该邮箱已注册，请直接登录',
  INVALID_CREDENTIALS: '邮箱或密码错误',
  TENANT_SUSPENDED: '该账号已被暂停',
};

async function login(ctx, req, res) {
  const body = (await ctx.readBody(req).catch(() => ({}))) || {};
  const email = String(body.email || '').toLowerCase().trim();
  const password = String(body.password || '');
  if (!email || !password) return ctx.sendJSON(res, 400, { error: 'EMAIL_PASSWORD_REQUIRED', message: ERR_MSG.EMAIL_PASSWORD_REQUIRED });
  const r = tenant.login({ email, password });
  if (r.error) {
    const code = r.error === 'TENANT_SUSPENDED' ? 403 : 401;
    return ctx.sendJSON(res, code, { error: r.error, message: ERR_MSG[r.error] || '登录失败' });
  }
  const token = auth.issueToken({ userId: r.user.id, tenantId: r.tenantId, role: r.role });
  return ctx.sendJSON(res, 200, { token, user: r.user, tenantId: r.tenantId });
}

async function register(ctx, req, res) {
  const body = (await ctx.readBody(req).catch(() => ({}))) || {};
  const r = tenant.register({ email: body.email, password: body.password, name: body.name });
  if (r.error) {
    const code = r.error === 'EMAIL_TAKEN' ? 409 : 400;
    return ctx.sendJSON(res, code, { error: r.error, message: ERR_MSG[r.error] || '注册失败' });
  }
  const token = auth.issueToken({ userId: r.user.id, tenantId: r.tenant.id, role: 'owner' });
  return ctx.sendJSON(res, 201, { token, user: r.user, tenantId: r.tenant.id });
}

module.exports = { login, register };
