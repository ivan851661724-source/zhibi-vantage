'use strict';
// ============================================================
// 多租户数据层（v0.3 · Phase 2 存储换底）
// ------------------------------------------------------------
// 底层：Node 22 内置 node:sqlite（DatabaseSync，同步 API）。
// 对外接口与 v0.2（JSON 文件版）**完全同构**——调用方（tenant.js /
// metering.js / api-tenant.js / api-admin.js / admin.js / server.js）
// 与测试（multitenant.test.js / admin.test.js）零改动。
//
// 隔离裁决（§2.2）：任何跨租户读取都必须显式带 tenantId 并在本层过滤；
// 不存在"不小心读到别人行"的函数——listProjects/getProject 均按 tenantId 硬过滤。
// 超管级跨租户读取（listAllTenants / listAllProjects / getProjectById）独立实现，
// 供 admin 路由专用，租户路由不得调用。
//
// 并发与崩溃安全（Phase 2）：
//   · node:sqlite 同步 API 天然串行化写（Node 单线程），无 read-modify-write 交错；
//   · WAL 模式 + busy_timeout=5000ms：并发读写不锁库，写冲突时等待而非报错；
//   · SQLite 事务原子性：多表更新（tenant+quotas+metering）一条事务完成，
//     进程崩溃不会留半截状态（替代 v0.2 的 tmp+rename JSON 原子写）。
//
// 存储路径：STORE_PATH 兼容——测试经 MT_STORE_PATH 指向临时文件；
// 生产默认 data/multitenant.db（v0.2 的 .json 由 scripts/migrate-json-to-sqlite.js 迁移）。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
// ZB_DATA_DIR 可覆盖数据目录（与 core/paths.js 同口径）
const DATA = process.env.ZB_DATA_DIR ? path.resolve(process.env.ZB_DATA_DIR) : path.join(ROOT, 'data');
// 测试隔离：允许用环境变量把存储重定向到临时文件（v0.2 同名变量，扩展名 .json 不影响 SQLite 使用）
const STORE_PATH = process.env.MT_STORE_PATH || path.join(DATA, 'multitenant.db');

let _db = null;
function getDb() {
  if (_db) return _db;
  ensureDir();
  const db = new DatabaseSync(STORE_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  // WAL 卫生（2026-08-12 排查：WAL 无限膨胀 → autocheckpoint 临界时同步写卡顿数十秒）
  // synchronous=NORMAL：WAL 模式崩溃安全且减少 fsync；wal_autocheckpoint=200：WAL ~800KB 即合并，避免大 WAL
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA wal_autocheckpoint = 200');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      plan TEXT NOT NULL DEFAULT 'free',
      status TEXT,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenantId TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      passwordHash TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'member',
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenantId);
    CREATE TABLE IF NOT EXISTS projects (      id TEXT PRIMARY KEY,
      tenantId TEXT NOT NULL,
      track TEXT NOT NULL DEFAULT 'project',
      competitors TEXT NOT NULL DEFAULT '[]',
      brief TEXT,
      whiteSpace TEXT,
      createdAt TEXT NOT NULL,
      discoveredAt TEXT NOT NULL,
      lastSweepAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_projects_tenant ON projects(tenantId);
    CREATE TABLE IF NOT EXISTS metering_daily (
      tenantId TEXT NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenantId, day, kind)
    );
    CREATE TABLE IF NOT EXISTS quotas (
      tenantId TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free',
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metering (
      tenantId TEXT NOT NULL,
      kind TEXT NOT NULL,
      total INTEGER NOT NULL DEFAULT 0,
      billed INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (tenantId, kind)
    );
  `);
  // 模块 2-1：存量库迁移 —— projects 表补 lastSweepAt 列（幂等：仅忽略"列已存在"类错误）
  try { db.exec('ALTER TABLE projects ADD COLUMN lastSweepAt TEXT'); } catch (e) {
    if (!/duplicate column|already exists/i.test(String(e && e.message))) {
      try { console.error('[db] projects.lastSweepAt 迁移失败:', e && e.message || e); } catch (e2) {}
    }
  }
  // users.email 唯一约束（未来"邀请成员"场景防同邮箱多账号致登录不可分辨；存量有重复时跳过不阻塞启动）
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_unique ON users(email)'); } catch (e) {
    try { console.warn('[db] users.email 唯一索引未建立（存量数据可能有重复邮箱）:', e && e.message || e); } catch (e2) {}
  }
  _db = db;
  return db;
}

function ensureDir() {
  const dir = path.dirname(STORE_PATH);
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
}

// 测试/运维辅助：关掉当前连接（便于测试重定向 STORE_PATH 后重开）
function closeDb() {
  if (_db) { try { _db.close(); } catch (e) {} _db = null; }
}

function rid(prefix) { return prefix + ':' + crypto.randomBytes(6).toString('hex'); }

// ---------------- tenants ----------------
function createTenant({ name, email }) {
  const db = getDb();
  const t = { id: rid('tenant'), name: name || '', email: (email || '').toLowerCase(), plan: 'free', createdAt: new Date().toISOString() };
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO tenants (id, name, email, plan, createdAt) VALUES (?,?,?,?,?)').run(t.id, t.name, t.email, t.plan, t.createdAt);
    db.prepare('INSERT INTO quotas (tenantId, plan, createdAt) VALUES (?,?,?)').run(t.id, t.plan, t.createdAt);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return t;
}
function getTenant(id) {
  if (!id) return null;
  const db = getDb();
  const r = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  return r || null;
}
function getTenantByEmail(email) {
  if (!email) return null;
  const e = String(email).toLowerCase();
  const db = getDb();
  const r = db.prepare('SELECT * FROM tenants WHERE email = ?').get(e);
  return r || null;
}
function setPlan(tenantId, plan) {
  const db = getDb();
  db.exec('BEGIN');
  try {
    const r = db.prepare('UPDATE tenants SET plan = ? WHERE id = ?').run(plan, tenantId);
    db.prepare('UPDATE quotas SET plan = ? WHERE tenantId = ?').run(plan, tenantId);
    db.exec('COMMIT');
    if (r.changes === 0) return null;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return getTenant(tenantId);
}

// ---------------- users ----------------
function createUser({ tenantId, email, passwordHash, role }) {
  const db = getDb();
  const u = { id: rid('user'), tenantId, email: (email || '').toLowerCase(), passwordHash: passwordHash || '', role: role || 'member', createdAt: new Date().toISOString() };
  db.prepare('INSERT INTO users (id, tenantId, email, passwordHash, role, createdAt) VALUES (?,?,?,?,?,?)').run(u.id, u.tenantId, u.email, u.passwordHash, u.role, u.createdAt);
  return u;
}
function getUser(id) {
  if (!id) return null;
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}
function getUserByEmail(email) {
  if (!email) return null;
  const e = String(email).toLowerCase();
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE email = ?').get(e) || null;
}
function listUsers(tenantId) {
  const db = getDb();
  return db.prepare('SELECT * FROM users WHERE tenantId = ?').all(tenantId);
}

// ---------------- projects（按 tenant 硬隔离） ----------------
function createProject({ tenantId, track }) {
  const db = getDb();
  const id = 'proj:' + (tenantId || 'x').replace(/[^a-z0-9]/gi, '').slice(0, 12) + ':' + crypto.randomBytes(4).toString('hex');
  const proj = {
    id, tenantId, track: track || 'project',
    competitors: [], brief: null, whiteSpace: null,
    createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString()
  };
  db.prepare('INSERT INTO projects (id, tenantId, track, competitors, brief, whiteSpace, createdAt, discoveredAt) VALUES (?,?,?,?,?,?,?,?)')
    .run(proj.id, proj.tenantId, proj.track, JSON.stringify(proj.competitors), null, null, proj.createdAt, proj.discoveredAt);
  return proj;
}
// 裁决点：只返回该 tenant 的项目，绝不跨租户。
function listProjects(tenantId) {
  const db = getDb();
  return db.prepare('SELECT * FROM projects WHERE tenantId = ?').all(tenantId).map(hydrateProject);
}
// 裁决点：必须在同 tenant 内匹配，否则 null（防止 /api/projects/<别人的id> 越权读）。
function getProject(tenantId, id) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM projects WHERE id = ? AND tenantId = ?').get(id, tenantId);
  return r ? hydrateProject(r) : null;
}
function saveProject(proj) {
  const db = getDb();
  // 归属保护：upsert 冲突时绝不改写 tenantId/createdAt（错误归主的 saveProject 会把项目
  // "迁移"到别的租户名下，且隔离层事后无法发现）。改名归主需走显式的超管迁移流程。
  db.prepare(`
    INSERT INTO projects (id, tenantId, track, competitors, brief, whiteSpace, createdAt, discoveredAt, lastSweepAt)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      track = excluded.track,
      competitors = excluded.competitors,
      brief = excluded.brief,
      whiteSpace = excluded.whiteSpace,
      discoveredAt = excluded.discoveredAt,
      lastSweepAt = excluded.lastSweepAt
  `).run(
    proj.id, proj.tenantId, proj.track || 'project',
    JSON.stringify(proj.competitors || []),
    proj.brief == null ? null : JSON.stringify(proj.brief),
    proj.whiteSpace == null ? null : JSON.stringify(proj.whiteSpace),
    proj.createdAt || new Date().toISOString(),
    proj.discoveredAt || new Date().toISOString(),
    proj.lastSweepAt || null
  );
  return proj;
}
function hydrateProject(r) {
  let competitors = [], brief = null, whiteSpace = null;
  try { competitors = JSON.parse(r.competitors || '[]'); } catch (e) {}
  try { brief = r.brief ? JSON.parse(r.brief) : null; } catch (e) {}
  try { whiteSpace = r.whiteSpace ? JSON.parse(r.whiteSpace) : null; } catch (e) {}
  return {
    id: r.id, tenantId: r.tenantId, track: r.track,
    competitors, brief, whiteSpace,
    createdAt: r.createdAt, discoveredAt: r.discoveredAt, lastSweepAt: r.lastSweepAt || null
  };
}

// ---------------- metering ----------------
function bumpMetering(tenantId, kind, billedCount) {
  const db = getDb();
  db.prepare(`
    INSERT INTO metering (tenantId, kind, total, billed) VALUES (?,?,1,?)
    ON CONFLICT(tenantId, kind) DO UPDATE SET
      total = total + 1,
      billed = billed + excluded.billed
  `).run(tenantId, kind, (billedCount || 0));
  return { total: currentMetering(tenantId, kind).total, billed: currentMetering(tenantId, kind).billed };
}
function currentMetering(tenantId, kind) {
  const db = getDb();
  const r = db.prepare('SELECT total, billed FROM metering WHERE tenantId = ? AND kind = ?').get(tenantId, kind);
  return r || { total: 0, billed: 0 };
}
function getMetering(tenantId) {
  const db = getDb();
  const rows = db.prepare('SELECT kind, total, billed FROM metering WHERE tenantId = ?').all(tenantId);
  const out = {};
  for (const r of rows) out[r.kind] = { total: r.total, billed: r.billed };
  return out;
}

// ---------------- 每日计量（R5.1：单免费档每租户每日 N 次全景调研） ----------------
function bumpDaily(tenantId, kind, n, day) {
  const d = day || new Date().toISOString().slice(0, 10);
  getDb().prepare(`
    INSERT INTO metering_daily (tenantId, day, kind, count) VALUES (?,?,?,?)
    ON CONFLICT(tenantId, day, kind) DO UPDATE SET count = count + excluded.count
  `).run(tenantId, d, kind, n || 1);
  return getDaily(tenantId, kind, d);
}
function getDaily(tenantId, kind, day) {
  const d = day || new Date().toISOString().slice(0, 10);
  const r = getDb().prepare('SELECT count FROM metering_daily WHERE tenantId = ? AND day = ? AND kind = ?').get(tenantId, d, kind);
  return r ? r.count : 0;
}

// ---------------- 超管级跨租户读取（§6.1，独立实现，tenant 路由不得调用） ----------------
function listAllTenants() {
  const db = getDb();
  return db.prepare('SELECT * FROM tenants').all();
}
function listAllProjects() {
  const db = getDb();
  return db.prepare('SELECT * FROM projects').all().map(hydrateProject);
}
// 跨租户按 id 查项目（供超管定位单个 project 的 Debug Mirror / 明文）；调用方需自行校验 tenant 归属。
function getProjectById(id) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  return r ? hydrateProject(r) : null;
}
// 封禁/降级：写 tenant.status（'active' | 'suspended'）。tenantScope 在身份层据此拒 suspended 租户。
function setTenantStatus(tenantId, status) {
  const db = getDb();
  const r = db.prepare('UPDATE tenants SET status = ? WHERE id = ?').run(status, tenantId);
  return r.changes > 0 ? getTenant(tenantId) : null;
}

// ---------------- 测试/运维辅助 ----------------
function reset() {
  const db = getDb();
  db.exec('DELETE FROM tenants; DELETE FROM users; DELETE FROM projects; DELETE FROM quotas; DELETE FROM metering;');
}

module.exports = {
  STORE_PATH,
  bumpDaily, getDaily,
  createTenant, getTenant, getTenantByEmail, setPlan,
  createUser, getUser, getUserByEmail, listUsers,
  createProject, listProjects, getProject, saveProject,
  bumpMetering, getMetering,
  listAllTenants, listAllProjects, getProjectById, setTenantStatus,
  reset, closeDb
};
