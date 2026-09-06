'use strict';
// ============================================================
// 三层缓存（模块 0-3）—— node:sqlite，零依赖
// kind: 'serp-discover'(24h) | 'serp-probe'(7d) | 'fetch-page'(72h)
// 键规则：kind + ':' + 规范化 query（+地区 gl）+ ':' + url（fetch 用）
// 命中 = 免配额（调用方在搜索入口 if(hit) return hit 即天然不 recordCall）
// 开关：CACHE_ENABLED=0 完整关闭（行为与今日一致）
// ============================================================
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const CACHE_DB = path.join(__dirname, '..', 'data', 'cache.sqlite');
const TTL = { 'serp-discover': 86400, 'serp-probe': 604800, 'fetch-page': 259200 };

let db;
function init() {
  if (db) return db;
  db = new DatabaseSync(CACHE_DB);
  db.exec('PRAGMA journal_mode = WAL');
  // WAL 卫生（2026-08-12 排查）：autocheckpoint 默认 1000 页(~4MB)，临界时同步写卡顿 → 收紧到 200 页(~800KB)
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA wal_autocheckpoint = 200');
  db.exec(`CREATE TABLE IF NOT EXISTS cache (
    kind TEXT NOT NULL, ckey TEXT NOT NULL PRIMARY KEY,
    payload TEXT NOT NULL, expiresAt INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cache_exp ON cache(expiresAt)');
  return db;
}

// 键规范化：小写 + 压缩空白（保留地域 gl 与 url，防美/英串数据）
function normKey(kind, raw) {
  return kind + ':' + String(raw).trim().toLowerCase().replace(/\s+/g, ' ');
}

function get(kind, key) {
  if (process.env.CACHE_ENABLED === '0') return null;
  const ck = normKey(kind, key);
  const row = init().prepare('SELECT payload, expiresAt FROM cache WHERE kind=? AND ckey=?').get(kind, ck);
  if (!row) return null;
  if (Date.now() > row.expiresAt) {
    init().prepare('DELETE FROM cache WHERE kind=? AND ckey=?').run(kind, ck);
    return null;
  }
  try { return JSON.parse(row.payload); } catch { return null; }
}

function set(kind, key, payload, ttlSec) {
  if (process.env.CACHE_ENABLED === '0') return;
  const ttl = ttlSec || TTL[kind] || 86400;
  const ck = normKey(kind, key);
  init().prepare(`INSERT INTO cache (kind, ckey, payload, expiresAt) VALUES (?,?,?,?)
    ON CONFLICT(ckey) DO UPDATE SET payload=excluded.payload, expiresAt=excluded.expiresAt`)
    .run(kind, ck, JSON.stringify(payload), Date.now() + ttl * 1000);
  // 懒清理：每次 set 顺带清过期行（量小，够用）
  init().prepare('DELETE FROM cache WHERE expiresAt < ?').run(Date.now());
}

module.exports = { get, set, init, TTL, normKey };
