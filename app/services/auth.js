'use strict';
// ============================================================
// 鉴权服务（v0.2）—— 零依赖，全部用 Node 内置 crypto 实现
//   · 密码：scrypt + 随机盐 + timingSafeEqual（不引 bcrypt）
//   · 会话：HS256 JWT（HMAC-SHA256，base64url；不引 jsonwebtoken）
//   · 幽灵租户：旧"单 key 无登录"在过渡期绑定到固定的 tenant:legacy-migration，
//     只拥遗留数据、对新租户接口一律 403（见 ARCHITECTURE §3.1 / P0-1）。
// ============================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const SECRET_PATH = process.env.MT_SECRET_PATH || path.join(DATA, '.jwt-secret');

// 超管独立密钥：与租户 JWT 密钥**完全不同**，从根上杜绝"租户 token 伪装成超管"。
// 优先级：环境变量 MT_ADMIN_SECRET > 持久化文件 data/.admin-secret（首次自动生成）。
const ADMIN_SECRET_PATH = process.env.MT_ADMIN_SECRET_PATH || path.join(DATA, '.admin-secret');

const GHOST_TENANT_ID = 'tenant:legacy-migration';
const TOKEN_TTL_SEC = 60 * 60 * 24 * 7; // access token 7 天（第一版不做 refresh，phase-2）
const ADMIN_TOKEN_TTL_SEC = 60 * 60 * 12; // 超管 token 12 小时（短时效，降低泄露面）

// ---------------- 密码 ----------------
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(pw), salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}
function verifyPassword(pw, stored) {
  if (!stored || stored.indexOf(':') < 0) return false;
  const parts = stored.split(':');
  const salt = Buffer.from(parts[0], 'hex');
  const expected = Buffer.from(parts[1], 'hex');
  let actual;
  try { actual = crypto.scryptSync(String(pw), salt, 64); } catch { return false; }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ---------------- JWT（HS256） ----------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function signJWT(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', secret).update(h + '.' + p).digest());
  return h + '.' + p + '.' + sig;
}
function verifyJWT(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', secret).update(h + '.' + p).digest());
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null; // 签名不符 → 拒
  let payload;
  try { payload = JSON.parse(b64urlDecode(p).toString('utf8')); } catch { return null; }
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null; // 过期 → 拒
  return payload;
}

// ---------------- secret 持久化（重启不失效） ----------------
function getJwtSecret() {
  try { const s = fs.readFileSync(SECRET_PATH, 'utf8').trim(); if (s) return s; } catch {}
  try {
    if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_PATH, s, { mode: 0o600 });
    return s;
  } catch { return 'insecure-dev-secret-change-me'; } // 极端兜底（磁盘只读），仅开发可用
}

// ---------------- 会话签发/校验 ----------------
function issueToken({ userId, tenantId, role, ghost }) {
  const now = Math.floor(Date.now() / 1000);
  return signJWT(
    { sub: userId, tid: tenantId, role: role || 'member', ghost: !!ghost, iat: now, exp: now + TOKEN_TTL_SEC },
    getJwtSecret()
  );
}
function verifyToken(token) {
  return verifyJWT(token, getJwtSecret());
}

// ---------------- 平台超管凭证（§6.1，独立密钥） ----------------
function getAdminSecret() {
  if (process.env.MT_ADMIN_SECRET) return process.env.MT_ADMIN_SECRET;
  try { const s = fs.readFileSync(ADMIN_SECRET_PATH, 'utf8').trim(); if (s) return s; } catch {}
  try {
    if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(ADMIN_SECRET_PATH, s, { mode: 0o600 });
    return s;
  } catch { return 'insecure-dev-admin-secret'; }
}

// 常量时间比较，防时序侧信道
function verifyAdminKey(provided) {
  const real = getAdminSecret();
  if (!provided || !real) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(String(real));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// 超管 token：role=platform_admin（或 platform_auditor），用 admin 密钥签名 —— 租户 token 验不过（密钥不同）。
// sub 标识具体管理员账号（多账号模型下区分到人）；旧单密钥登录传 'platform-admin'。
function issueAdminToken(sub, role) {
  const now = Math.floor(Date.now() / 1000);
  return signJWT(
    { sub: sub || 'platform-admin', role: role || 'platform_admin', iat: now, exp: now + ADMIN_TOKEN_TTL_SEC },
    getAdminSecret()
  );
}

// ---------------- 平台超管多账号（§6.1 扩展） ----------------
// 与单密钥并存：单密钥(ADMIN_SECRET)作为运维后门保留，向后兼容；多账号提供"到人"的登录与审计。
// 账号存于 data/.admin-accounts.json（不进部署包）。密码用与租户一致的 scrypt 哈希，永不存明文。
const ADMIN_ACCOUNTS_PATH = process.env.MT_ADMIN_ACCOUNTS_PATH || path.join(DATA, '.admin-accounts.json');

function readAdminAccounts() {
  try { const a = JSON.parse(fs.readFileSync(ADMIN_ACCOUNTS_PATH, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeAdminAccounts(arr) {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(ADMIN_ACCOUNTS_PATH, JSON.stringify(arr, null, 2), { mode: 0o600 });
}
// 创建超管账号；username 唯一；密码 scrypt 哈希（不存明文）。返回去除密码的账号对象，或 { error }。
function createAdminAccount({ username, password, role, active }) {
  username = String(username || '').trim();
  if (!username) return { error: 'USERNAME_REQUIRED' };
  if (!password || String(password).length < 8) return { error: 'PASSWORD_TOO_WEAK' };
  const list = readAdminAccounts();
  if (list.some(a => a.username.toLowerCase() === username.toLowerCase())) return { error: 'USERNAME_TAKEN' };
  const acct = {
    id: 'adm:' + crypto.randomBytes(6).toString('hex'),
    username,
    pwHash: hashPassword(password),
    role: role === 'platform_auditor' ? 'platform_auditor' : 'platform_admin',
    active: active === false ? false : true,
    createdAt: new Date().toISOString()
  };
  list.push(acct);
  writeAdminAccounts(list);
  const { pwHash, ...safe } = acct;
  return safe;
}
// 校验管理员凭据；成功返回去除密码的账号，失败返回 null。
function verifyAdminCredentials(username, password) {
  if (!username || !password) return null;
  const acct = readAdminAccounts().find(a => a.username.toLowerCase() === String(username).trim().toLowerCase());
  if (!acct || acct.active === false) return null;
  if (!verifyPassword(password, acct.pwHash)) return null;
  const { pwHash, ...safe } = acct;
  return safe;
}
function verifyAdminToken(token) {
  return verifyJWT(token, getAdminSecret());
}

module.exports = {
  GHOST_TENANT_ID, TOKEN_TTL_SEC, ADMIN_TOKEN_TTL_SEC,
  hashPassword, verifyPassword,
  signJWT, verifyJWT,
  getJwtSecret, issueToken, verifyToken,
  getAdminSecret, verifyAdminKey, issueAdminToken, verifyAdminToken,
  readAdminAccounts, writeAdminAccounts, createAdminAccount, verifyAdminCredentials
};
