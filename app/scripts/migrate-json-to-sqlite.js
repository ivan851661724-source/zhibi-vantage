'use strict';
// ============================================================
// 迁移脚本：multitenant.json → SQLite（Phase 2 存储换底）
// ------------------------------------------------------------
// 用途：把 v0.2 JSON 存储的多租户数据（tenants/users/projects/
// quotas/metering）一次性导入 SQLite（data/multitenant.db）。
//
// 幂等性：SQLite 中已有 tenants 数据 → 跳过（不重复导入）；
// 旧 JSON 保留不动（可随时回滚），另存 .migrated 标记防重复。
//
// 用法：
//   node scripts/migrate-json-to-sqlite.js            # 默认 data/multitenant.json → data/multitenant.db
//   node scripts/migrate-json-to-sqlite.js --dry-run  # 只打印统计，不写入
//   MT_STORE_PATH=/tmp/x.db node scripts/migrate-json-to-sqlite.js  # 自定义目标
//
// 验收：迁移后行数与 JSON 一致；重跑为 no-op（幂等）。
// ============================================================
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const SRC = process.env.MT_SRC_PATH || path.join(ROOT, 'data', 'multitenant.json');
const DST = process.env.MT_STORE_PATH || path.join(ROOT, 'data', 'multitenant.db');
const DRY_RUN = process.argv.includes('--dry-run');

function fail(msg) { console.error('❌ ' + msg); process.exit(1); }

// 1. 源 JSON 必须存在且可解析
if (!fs.existsSync(SRC)) {
  console.log('✓ 无源 JSON（' + SRC + '）—— 全新环境或已迁移，跳过。');
  process.exit(0);
}
let src;
try { src = JSON.parse(fs.readFileSync(SRC, 'utf8')); }
catch (e) { fail('源 JSON 解析失败: ' + e.message); }

const tenants = Array.isArray(src.tenants) ? src.tenants : [];
const users = Array.isArray(src.users) ? src.users : [];
const projects = Array.isArray(src.projects) ? src.projects : [];
const quotas = src.quotas || {};
const metering = src.metering || {};

console.log(`[迁移] 源 ${SRC}：${tenants.length} 租户 / ${users.length} 用户 / ${projects.length} 项目 / ${Object.keys(quotas).length} 配额 / ${Object.keys(metering).length} 计量`);

if (DRY_RUN) { console.log('[dry-run] 不写入，以上为将迁移的数据。'); process.exit(0); }

// 2. 打开目标（与 db.js 同构的建表逻辑）
const db = new DatabaseSync(DST);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');
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
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    track TEXT NOT NULL DEFAULT 'project',
    competitors TEXT NOT NULL DEFAULT '[]',
    brief TEXT,
    whiteSpace TEXT,
    createdAt TEXT NOT NULL,
    discoveredAt TEXT NOT NULL
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

// 3. 幂等检查：目标已有 tenants 数据 → 跳过（保留迁移标记供追溯）
const existing = db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n;
if (existing > 0) {
  console.log('✓ 目标已含 ' + existing + ' 租户 —— 幂等跳过（不重复导入）。');
  db.close();
  process.exit(0);
}

// 4. 事务内导入
db.exec('BEGIN');
try {
  const insTenant = db.prepare('INSERT INTO tenants (id, name, email, plan, status, createdAt) VALUES (?,?,?,?,?,?)');
  for (const t of tenants) {
    insTenant.run(t.id, t.name || '', t.email || '', t.plan || 'free', t.status || null, t.createdAt || new Date().toISOString());
  }
  const insUser = db.prepare('INSERT INTO users (id, tenantId, email, passwordHash, role, createdAt) VALUES (?,?,?,?,?,?)');
  for (const u of users) {
    insUser.run(u.id, u.tenantId, u.email || '', u.passwordHash || '', u.role || 'member', u.createdAt || new Date().toISOString());
  }
  const insProj = db.prepare('INSERT INTO projects (id, tenantId, track, competitors, brief, whiteSpace, createdAt, discoveredAt) VALUES (?,?,?,?,?,?,?,?)');
  for (const p of projects) {
    insProj.run(
      p.id, p.tenantId, p.track || 'project',
      JSON.stringify(p.competitors || []),
      p.brief == null ? null : JSON.stringify(p.brief),
      p.whiteSpace == null ? null : JSON.stringify(p.whiteSpace),
      p.createdAt || new Date().toISOString(),
      p.discoveredAt || new Date().toISOString()
    );
  }
  const insQuota = db.prepare('INSERT INTO quotas (tenantId, plan, createdAt) VALUES (?,?,?)');
  for (const [tid, q] of Object.entries(quotas)) {
    insQuota.run(tid, (q && q.plan) || 'free', (q && q.createdAt) || new Date().toISOString());
  }
  const insMeter = db.prepare('INSERT INTO metering (tenantId, kind, total, billed) VALUES (?,?,?,?)');
  for (const [tid, kinds] of Object.entries(metering)) {
    for (const [kind, m] of Object.entries(kinds || {})) {
      insMeter.run(tid, kind, (m && m.total) || 0, (m && m.billed) || 0);
    }
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  db.close();
  fail('导入失败已回滚: ' + e.message);
}

// 5. 校验
const counts = {
  tenants: db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n,
  users: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
  projects: db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
};
db.close();

if (counts.tenants !== tenants.length) fail(`行数不一致: 目标 ${counts.tenants} vs 源 ${tenants.length}`);
if (counts.users !== users.length) fail(`用户数不一致: 目标 ${counts.users} vs 源 ${users.length}`);
if (counts.projects !== projects.length) fail(`项目数不一致: 目标 ${counts.projects} vs 源 ${projects.length}`);

// 6. 迁移标记（幂等追溯；同时保留源 JSON 供回滚）
try { fs.writeFileSync(SRC + '.migrated', new Date().toISOString()); } catch (e) {}

console.log(`✅ 迁移完成 → ${DST}（${counts.tenants} 租户 / ${counts.users} 用户 / ${counts.projects} 项目）`);
console.log('   源 JSON 保留（' + SRC + '），回滚可删除 .db 恢复 JSON 模式。');
