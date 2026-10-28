'use strict';
// ============================================================
// routes/handlers/account.js —— 账户资料 / 用户名 / 修改密码（r4 §十）
//   GET   /api/account           当前登录账号的资料与用量
//   PATCH /api/account           修改用户名（displayName；邮箱默认只读）
//   POST  /api/account/password  修改密码（限流 + 其他会话失效）
// 纪律：
//   · 邮箱未提供验证/换绑流程前，不提供任何「修改邮箱」入口；
//   · 无真实支付能力时用量区只说明「额度由系统分配」，不放无效按钮；
//   · 密码不出现在任何响应/日志中；错误信息不泄露账户存在性。
// ============================================================
const tenant = require('../../services/tenant.js');
const auth = require('../../services/auth.js');

// 修改密码限流（内存实现；进程重启即清零——限流目标是拖慢暴力尝试，不是审计）
const PW_LIMIT = { windowMs: 15 * 60 * 1000, max: 5 };
const pwTries = new Map(); // userId -> { windowStart, count }
function pwRateLimited(userId) {
  const now = Date.now();
  const rec = pwTries.get(userId);
  if (!rec || now - rec.windowStart > PW_LIMIT.windowMs) {
    pwTries.set(userId, { windowStart: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > PW_LIMIT.max;
}
function pwRateClear(userId) { pwTries.delete(userId); }

function me(ctx, req, res) {
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant' || !ap.payload) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录。' }); return null; }
  const tid = ap.payload.tid;
  const uid = ap.payload.sub;
  if (!tid || !uid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录。' }); return null; }
  return { tid, uid };
}

async function accountGet(ctx, req, res, url, p) {
  if (p !== '/api/account' || req.method !== 'GET') return false;
  const id = me(ctx, req, res);
  if (!id) return true;
  const view = tenant.accountView(id.tid, id.uid);
  if (!view) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录。' }); return true; }
  ctx.sendJSON(res, 200, view);
  return true;
}

async function accountPatch(ctx, req, res, url, p) {
  if (p !== '/api/account' || req.method !== 'PATCH') return false;
  const id = me(ctx, req, res);
  if (!id) return true;
  let body = {};
  try { body = (await ctx.readBody(req)) || {}; } catch (e) { body = {}; }
  // 只接受 displayName；email 等字段显式拒绝（只读），不做静默忽略
  const keys = Object.keys(body || {});
  if (keys.some(k => k !== 'displayName')) {
    ctx.sendJSON(res, 400, { error: 'READ_ONLY_FIELD', message: '当前只能修改用户名；邮箱暂不支持修改。' });
    return true;
  }
  const r = tenant.updateDisplayName(id.tid, id.uid, body.displayName);
  if (r.error) {
    const map = {
      NAME_REQUIRED: [400, '请输入用户名。'],
      NAME_TOO_LONG: [400, '用户名最长 40 个字符。'],
      NOT_FOUND: [401, '请先登录。'],
    };
    const m = map[r.error] || [400, '修改未生效，请稍后再试。'];
    ctx.sendJSON(res, m[0], { error: r.error, message: m[1] });
    return true;
  }
  ctx.sendJSON(res, 200, r);
  return true;
}

const ERR_TEXT = {
  INVALID_CREDENTIALS: '当前密码不正确。',
  PASSWORD_TOO_SHORT: '新密码至少 8 位。',
  PASSWORD_WEAK: '新密码需同时包含字母和数字。',
  PASSWORD_TOO_LONG: '新密码最长 128 位。',
  NOT_FOUND: '请先登录。',
  RATE_LIMITED: '尝试次数过多，请 15 分钟后再试。',
};

async function passwordChange(ctx, req, res, url, p) {
  if (p !== '/api/account/password' || req.method !== 'POST') return false;
  const id = me(ctx, req, res);
  if (!id) return true;
  if (pwRateLimited(id.uid)) {
    ctx.sendJSON(res, 429, { error: 'RATE_LIMITED', message: ERR_TEXT.RATE_LIMITED });
    return true;
  }
  let body = {};
  try { body = (await ctx.readBody(req)) || {}; } catch (e) { body = {}; }
  const currentPassword = body.currentPassword;
  const newPassword = body.newPassword;
  const confirmPassword = body.confirmPassword;
  if (confirmPassword != null && confirmPassword !== newPassword) {
    ctx.sendJSON(res, 400, { error: 'CONFIRM_MISMATCH', message: '两次输入的新密码不一致。' });
    return true;
  }
  const r = tenant.changePassword({ tenantId: id.tid, userId: id.uid, currentPassword, newPassword });
  if (r.error) {
    if (r.error === 'INVALID_CREDENTIALS') pwRateLimited(id.uid); // 计入限流窗口
    const code = r.error === 'RATE_LIMITED' ? 429 : (r.error === 'NOT_FOUND' ? 401 : 400);
    ctx.sendJSON(res, code, { error: r.error, message: ERR_TEXT[r.error] || '修改未生效，请稍后再试。' });
    return true;
  }
  pwRateClear(id.uid);
  // 其他会话已随凭证版本提升失效；当前会话签发新 token（产品规则：当前会话续签）
  const ap = ctx.getAuthPayload(req);
  const token = auth.issueToken({ userId: id.uid, tenantId: id.tid, role: ap.payload.role, tv: r.tokenVersion });
  ctx.sendJSON(res, 200, { ok: true, token, message: '密码已修改。其他设备的登录已失效，本次会话已自动续签。' });
  return true;
}

module.exports = { accountGet, accountPatch, passwordChange };
