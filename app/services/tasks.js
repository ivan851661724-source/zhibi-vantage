'use strict';
// ============================================================
// 研究任务队列（模块 0-4）—— node:sqlite，零依赖
// 契约对齐《后端重构方案 v1.1》§4：claimToken / claimExpiresAt / heartbeatAt
//   · 入队 INSERT（幂等：同 project+type+competitorId 的未完成任务跳过）
//   · worker 认领：原子 UPDATE 抢锁（仅 pending 或过期 running 可被认领，RETURNING）
//   · 心跳续租：长任务每 30s 调用（校验 claimToken 防误续）
//   · 完成：claimToken 匹配才能落 done/error（防误提交）
//   · 回收：reclaimExpired 把 running 且 claimExpiresAt < now 的任务回 pending（kill -9 后断点续跑）
// ============================================================
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');

// ZB_DATA_DIR 可覆盖数据目录（与 core/paths.js 同口径）
const TASKS_DB = path.join(process.env.ZB_DATA_DIR ? path.resolve(process.env.ZB_DATA_DIR) : path.join(__dirname, '..', 'data'), 'research_tasks.db');
const CLAIM_TTL_MS = 60000;   // 认领租期 60s（心跳每 30s 续租）

let db;
function init() {
  if (db) return db;
  db = new DatabaseSync(TASKS_DB);
  db.exec('PRAGMA journal_mode = WAL');
  // WAL 卫生（2026-08-12 排查）：收紧 autocheckpoint 防大 WAL 同步写卡顿
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA wal_autocheckpoint = 200');
  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    tenantId TEXT NOT NULL,
    projectId TEXT NOT NULL,
    type TEXT NOT NULL,               -- 'deep-research' | 'discover' | 'report' | 'sweep'
    payload TEXT NOT NULL,            -- JSON：{ competitorId: 'x' } 等
    status TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|dead
    priority INTEGER NOT NULL DEFAULT 1,
    retry INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    claimToken TEXT, claimExpiresAt INTEGER, heartbeatAt INTEGER,
    createdAt INTEGER NOT NULL, doneAt INTEGER,
    lastError TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(status, claimExpiresAt)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_proj ON tasks(projectId, status)');
  return db;
}

// 入队（幂等：同 project+type+payload.competitorId 存在 pending/running 则跳过）
function enqueue(task) {
  if (process.env.TASKS_DISABLED === '1') return null;
  const dbh = init();
  const payload = task.payload || {};
  const dup = dbh.prepare(`SELECT id FROM tasks
    WHERE projectId=? AND type=? AND payload LIKE ? AND status IN ('pending','running') LIMIT 1`)
    .get(task.projectId, task.type, '%' + (payload.competitorId || '') + '%');
  if (dup) return null;
  const id = task.id || ('t_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8));
  dbh.prepare(`INSERT INTO tasks (id, tenantId, projectId, type, payload, status, priority, retry, attempts, createdAt)
    VALUES (?,?,?,?,?, 'pending', ?, 0, 0, ?)`)
    .run(id, task.tenantId, task.projectId, task.type, JSON.stringify(payload), task.priority || 1, Date.now());
  return id;
}

// 原子认领：仅 pending 或过期 running 可被认领。
// 每次认领生成随机 claimToken（修复：静态 token 会让「任务超时被回收后原执行仍能 finish」，
// 且新旧执行无法区分，防误提交护栏形同虚设）；RETURNING 带回 claimToken 供消费端心跳/finish。
function claim(projectId, workerToken, now) {
  const token = 'ct_' + crypto.randomBytes(12).toString('hex');
  const r = init().prepare(`UPDATE tasks SET status='running', claimToken=?, claimExpiresAt=?, heartbeatAt=?,
      attempts=attempts+1
    WHERE id = (SELECT id FROM tasks
      WHERE projectId=? AND (status='pending' OR (status='running' AND claimExpiresAt < ?))
      ORDER BY priority DESC, createdAt ASC LIMIT 1)
    RETURNING id, payload, tenantId, projectId, type, claimToken`).get(token, (now || Date.now()) + CLAIM_TTL_MS, now || Date.now(), projectId, now || Date.now());
  return r || null;
}

// 心跳续租（长任务每 30s 调用；校验 claimToken 防误续）
function heartbeat(id, token, now) {
  init().prepare(`UPDATE tasks SET heartbeatAt=?, claimExpiresAt=? WHERE id=? AND claimToken=?`)
    .run(now || Date.now(), (now || Date.now()) + CLAIM_TTL_MS, id, token);
}

// 完成（校验 token 防误提交）；status 白名单外一律落 error（防写入前端无法识别的状态）
function finish(id, token, status, err) {
  const s = ['done', 'error', 'dead'].includes(status) ? status : 'error';
  init().prepare(`UPDATE tasks SET status=?, doneAt=?, lastError=? WHERE id=? AND claimToken=?`)
    .run(s, Date.now(), err || null, id, token);
}

// 回收：running 且 claimExpiresAt < now → 回 pending（retry++；超过 maxRetry 置 dead）
function reclaimExpired(now, maxRetry) {
  const dbh = init();
  const t = now || Date.now();
  const max = maxRetry || 3;
  const expired = dbh.prepare(`SELECT id, retry FROM tasks WHERE status='running' AND claimExpiresAt < ?`).all(t);
  let n = 0;
  for (const row of expired) {
    if (row.retry >= max) {
      dbh.prepare(`UPDATE tasks SET status='dead', doneAt=?, lastError='retry_exhausted' WHERE id=?`).run(t, row.id);
    } else {
      dbh.prepare(`UPDATE tasks SET status='pending', retry=retry+1, claimToken=NULL, claimExpiresAt=NULL WHERE id=?`).run(row.id);
      n++;
    }
  }
  return n;
}

// 查询（供 /api/tasks 进度）；tenantId 可选（租户隔离校验）
function list(projectId, tenantId, status) {
  const dbh = init();
  if (tenantId && status) {
    return dbh.prepare(`SELECT id, type, payload, status, priority, retry, attempts, createdAt, doneAt, lastError
      FROM tasks WHERE projectId=? AND tenantId=? AND status=? ORDER BY createdAt ASC`).all(projectId, tenantId, status);
  }
  if (tenantId) {
    return dbh.prepare(`SELECT id, type, payload, status, priority, retry, attempts, createdAt, doneAt, lastError
      FROM tasks WHERE projectId=? AND tenantId=? ORDER BY createdAt ASC`).all(projectId, tenantId);
  }
  if (status) {
    return dbh.prepare(`SELECT id, type, payload, status, priority, retry, attempts, createdAt, doneAt, lastError
      FROM tasks WHERE projectId=? AND status=? ORDER BY createdAt ASC`).all(projectId, status);
  }
  return dbh.prepare(`SELECT id, type, payload, status, priority, retry, attempts, createdAt, doneAt, lastError
    FROM tasks WHERE projectId=? ORDER BY createdAt ASC`).all(projectId);
}

function counts(projectId, tenantId) {
  const dbh = init();
  let rows;
  if (tenantId) {
    rows = dbh.prepare(`SELECT status, COUNT(*) AS n FROM tasks WHERE projectId=? AND tenantId=? GROUP BY status`).all(projectId, tenantId);
  } else {
    rows = dbh.prepare(`SELECT status, COUNT(*) AS n FROM tasks WHERE projectId=? GROUP BY status`).all(projectId);
  }
  const out = { pending: 0, running: 0, done: 0, error: 0, dead: 0 };
  rows.forEach(r => { if (r.status in out) out[r.status] = r.n; });
  return out;
}

// 清理已完成任务（项目切换/删除时调用）
function purge(projectId) {
  init().prepare(`DELETE FROM tasks WHERE projectId=? AND status IN ('done','dead')`).run(projectId);
}

module.exports = { init, enqueue, claim, heartbeat, finish, reclaimExpired, list, counts, purge, CLAIM_TTL_MS };
