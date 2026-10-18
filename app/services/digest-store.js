'use strict';
// ============================================================
// services/digest-store.js —— 每日日报发送状态（整改 §10：每租户本地日期最多一次）
// ------------------------------------------------------------
// 存储：node:sqlite 单文件（ZB_DATA_DIR/digest_state.db），与 watch_targets.db 同口径。
// 幂等键 = (tenant_id, local_date)：local_date 是租户 Workspace 时区下的本地墙上日期
//（YYYY-MM-DD）。服务重启补发靠"启动后首个 tick 即检查"实现：只要本地日期已过
// 08:00 且无本行 → 发送并落行；DST 由 IANA 时区换算自动处理（见 watch-store.localParts）。
// ============================================================
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DIGEST_DB = path.join(
  process.env.ZB_DATA_DIR ? path.resolve(process.env.ZB_DATA_DIR) : path.join(__dirname, '..', 'data'),
  'digest_state.db'
);

let _db = null;
function getDb() {
  if (_db) return _db;
  try { if (!fs.existsSync(path.dirname(DIGEST_DB))) fs.mkdirSync(path.dirname(DIGEST_DB), { recursive: true }); } catch (e) {}
  const db = new DatabaseSync(DIGEST_DB);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS daily_digest_log (
    tenant_id TEXT NOT NULL,
    local_date TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    mode TEXT,
    PRIMARY KEY (tenant_id, local_date)
  )`);
  _db = db;
  return db;
}
function closeDb() { if (_db) { try { _db.close(); } catch (e) {} _db = null; } }

// 该租户在该本地日期是否已发送过（幂等判定）
function hasSent(tenantId, localDate) {
  return !!getDb().prepare('SELECT 1 FROM daily_digest_log WHERE tenant_id=? AND local_date=?')
    .get(String(tenantId || ''), String(localDate || ''));
}

// 记录一次发送（幂等写入：同键重复写为 no-op）
function recordSent(tenantId, localDate, mode, atIso) {
  try {
    getDb().prepare('INSERT OR IGNORE INTO daily_digest_log (tenant_id, local_date, sent_at, mode) VALUES (?,?,?,?)')
      .run(String(tenantId || ''), String(localDate || ''), String(atIso || new Date().toISOString()), String(mode || ''));
  } catch (e) { /* 幂等冲突视为已发送 */ }
}

module.exports = { getDb, closeDb, hasSent, recordSent };
