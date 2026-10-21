'use strict';
// ============================================================
// call-ledger.js —— ExternalCallLedger 外部尝试账本（M4 任务 C，03 §20）
//
// 新库 DATA/call_ledger.db：schema_version=1 起步，WAL，事务安装，未知未来版本拒绝
// （00 §56 迁移合同：无旧数据迁移、无删除）。append-only：只插不改，触发器硬拒绝
// UPDATE/DELETE。与 cost.sqlite（cost_telemetry）/metering 并行旁路，不改其既有语义。
//
// 写入是旁路观测（尽力而为）：recordCall 的字段校验失败或存储故障会**抛错**，
// 由调用方 try/catch 捕获——接入点（llm-gateway/search/monitoring）均包 try/catch
// 并留 warn 日志，账本任何失败绝不阻断主业务。
//
// 字段按 03 §20 清单 + tenant_id/project_id 既有归因兼容列（tenant 非空；
// workspace/watch_target/brand 尽力透传可空）。estimated_cost 只能来自
// cost-profile 登记口径（cost_profile_version 标明已咨询的版本）；无条目/未知
// 成本为 null 不为 0（数据真值规则：Missing signal is not zero）。outcome 必填，
// 枚举不冻死——用既有真实形态（success/failed/timeout/partial 等）。
// 只读 list({tenantId?,provider?,capability?,trigger?,outcome?,offset,limit})
// 有界分页（limit 夹紧 ≤200）供运维按 07 §18 分解；无 HTTP 端点（04 §20 内部对象）。
// ============================================================
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');
const { DATA } = require('../core/paths.js');

const LEDGER_DB = path.join(DATA, 'call_ledger.db');
const SCHEMA_VERSION = 1;
const LIST_MAX_LIMIT = 200; // 有界分页上限（防全表拖取）

let db;

function init() {
  if (db) return db;
  const d = new DatabaseSync(LEDGER_DB);
  try {
    d.exec('PRAGMA journal_mode = WAL');
    d.exec('PRAGMA synchronous = NORMAL');
    // 事务安装：版本登记与 schema 原子生效；已存在但版本未知（未来/回退库）→ 拒绝。
    // 手动 BEGIN IMMEDIATE（与 services/monitoring-store.js 同款——本构建 node:sqlite
    // 无 DatabaseSync.transaction 包装，手动事务保证 schema 原子安装语义不变）。
    d.exec('BEGIN IMMEDIATE');
    try {
      d.exec('CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      const row = d.prepare(`SELECT value FROM ledger_meta WHERE key='schema_version'`).get();
      if (row && String(row.value) !== String(SCHEMA_VERSION)) {
        throw new Error('CALL_LEDGER_SCHEMA_VERSION_UNSUPPORTED:' + row.value);
      }
      d.exec(`CREATE TABLE IF NOT EXISTS call_ledger (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        project_id TEXT,
        workspace_id TEXT,
        watch_target_id TEXT,
        brand_id TEXT,
        capability TEXT NOT NULL,
        provider TEXT NOT NULL,
        operation TEXT NOT NULL,
        "trigger" TEXT NOT NULL,
        cost_profile_version TEXT NOT NULL,
        request_units INTEGER,
        estimated_cost REAL,
        cache_hit INTEGER NOT NULL DEFAULT 0,
        canonical_reuse_hit INTEGER NOT NULL DEFAULT 0,
        fallback_depth INTEGER NOT NULL DEFAULT 0,
        attempt_no INTEGER NOT NULL DEFAULT 1,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        error_code TEXT
      )`);
      d.exec('CREATE INDEX IF NOT EXISTS idx_cl_tenant_started ON call_ledger(tenant_id, started_at)');
      d.exec('CREATE INDEX IF NOT EXISTS idx_cl_provider ON call_ledger(provider, started_at)');
      // append-only 硬约束：账本行写入后不可改写/删除（纠错以新行追加，历史不重写）。
      // BEFORE INSERT 冲突拒绝补住 INSERT OR REPLACE 路径：默认 recursive_triggers=0
      // 时 REPLACE 的隐式 DELETE 不触发 DELETE 触发器（复审 I-1）。
      d.exec(`CREATE TRIGGER IF NOT EXISTS call_ledger_append_only_update BEFORE UPDATE ON call_ledger
        BEGIN SELECT RAISE(ABORT, 'call_ledger is append-only'); END`);
      d.exec(`CREATE TRIGGER IF NOT EXISTS call_ledger_append_only_delete BEFORE DELETE ON call_ledger
        BEGIN SELECT RAISE(ABORT, 'call_ledger is append-only'); END`);
      d.exec(`CREATE TRIGGER IF NOT EXISTS call_ledger_append_only_insert BEFORE INSERT ON call_ledger
        WHEN EXISTS(SELECT 1 FROM call_ledger WHERE call_id = NEW.call_id)
        BEGIN SELECT RAISE(ABORT, 'call_ledger is append-only'); END`);
      if (!row) {
        d.prepare(`INSERT INTO ledger_meta(key,value) VALUES('schema_version',?)`).run(String(SCHEMA_VERSION));
      }
      d.exec('COMMIT');
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  } catch (e) {
    try { d.close(); } catch (e2) { /* 保持原错误上抛 */ }
    throw e;
  }
  db = d;
  return db;
}

// ---- 校验 helpers（throw 由调用方捕获，旁路化）----
function reqStr(v, name) {
  const s = String(v == null ? '' : v).trim();
  if (!s) throw new Error('CALL_LEDGER_FIELD_REQUIRED:' + name);
  return s;
}
function optStr(v, name) {
  if (v == null) return null;
  const s = String(v);
  if (!s.trim()) return null;
  if (s.length > 256) throw new Error('CALL_LEDGER_FIELD_TOO_LONG:' + name);
  return s;
}
function optNum(v, name) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('CALL_LEDGER_FIELD_INVALID:' + name);
  return n;
}
function toIso(v, name) {
  if (v == null) return new Date().toISOString();
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  if (isNaN(d.getTime())) throw new Error('CALL_LEDGER_FIELD_INVALID:' + name);
  return d.toISOString();
}

/**
 * recordCall(entry) → callId。entry 字段（camelCase）：
 *   必填：tenantId, capability, provider, operation, trigger, costProfileVersion, outcome
 *   可空：projectId, workspaceId, watchTargetId, brandId, requestUnits, estimatedCost, errorCode
 *   布尔：cacheHit, canonicalReuseHit（默认 false）
 *   整数：fallbackDepth（默认 0，≥0）、attemptNo（默认 1，≥1）
 *   时间：startedAt/completedAt（ISO 字符串或 epoch ms；缺省=当前时刻）
 * 校验失败/存储故障 throw——调用方必须 try/catch 旁路化。
 */
function recordCall(entry) {
  if (!entry || typeof entry !== 'object') throw new Error('CALL_LEDGER_ENTRY_REQUIRED');
  const tenantId = reqStr(entry.tenantId, 'tenantId');
  const capability = reqStr(entry.capability, 'capability');
  const provider = reqStr(entry.provider, 'provider');
  const operation = reqStr(entry.operation, 'operation');
  const trigger = reqStr(entry.trigger, 'trigger');
  const costProfileVersion = reqStr(entry.costProfileVersion, 'costProfileVersion');
  const outcome = reqStr(entry.outcome, 'outcome');
  const requestUnits = optNum(entry.requestUnits, 'requestUnits');
  const estimatedCost = optNum(entry.estimatedCost, 'estimatedCost');
  const fallbackDepth = entry.fallbackDepth == null ? 0 : Number(entry.fallbackDepth);
  if (!Number.isInteger(fallbackDepth) || fallbackDepth < 0) throw new Error('CALL_LEDGER_FIELD_INVALID:fallbackDepth');
  const attemptNo = entry.attemptNo == null ? 1 : Number(entry.attemptNo);
  if (!Number.isInteger(attemptNo) || attemptNo < 1) throw new Error('CALL_LEDGER_FIELD_INVALID:attemptNo');
  const startedAt = toIso(entry.startedAt, 'startedAt');
  const completedAt = toIso(entry.completedAt, 'completedAt');
  const callId = 'cl_' + crypto.randomUUID();
  init().prepare(`INSERT INTO call_ledger (
      call_id, tenant_id, project_id, workspace_id, watch_target_id, brand_id,
      capability, provider, operation, "trigger", cost_profile_version,
      request_units, estimated_cost, cache_hit, canonical_reuse_hit,
      fallback_depth, attempt_no, started_at, completed_at, outcome, error_code
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      callId, tenantId,
      optStr(entry.projectId, 'projectId'), optStr(entry.workspaceId, 'workspaceId'),
      optStr(entry.watchTargetId, 'watchTargetId'), optStr(entry.brandId, 'brandId'),
      capability, provider, operation, trigger, costProfileVersion,
      requestUnits,
      estimatedCost,
      entry.cacheHit ? 1 : 0, entry.canonicalReuseHit ? 1 : 0,
      fallbackDepth, attemptNo, startedAt, completedAt, outcome,
      optStr(entry.errorCode, 'errorCode'),
    );
  return callId;
}

/**
 * 只读 list({tenantId?, provider?, capability?, trigger?, outcome?, offset?, limit?})
 * → {rows, total}。有界分页：limit 夹紧 [1,200]（默认 50），offset 夹紧 ≥0；
 * 按 started_at 倒序（同刻按 seq 稳定排序）。绝不写库。
 */
function list({ tenantId, projectId, workspaceId, watchTargetId, brandId, provider, capability, trigger, outcome, offset, limit } = {}) {
  const lim = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 50, 1), LIST_MAX_LIMIT);
  const off = Math.max(Number.isSafeInteger(offset) ? offset : 0, 0);
  const where = [];
  const params = [];
  const add = (col, v) => { if (v != null && String(v).trim() !== '') { where.push(col + '=?'); params.push(String(v)); } };
  add('tenant_id', tenantId);
  add('project_id', projectId);
  add('workspace_id', workspaceId);
  add('watch_target_id', watchTargetId);
  add('brand_id', brandId);
  add('provider', provider);
  add('capability', capability);
  add('"trigger"', trigger);
  add('outcome', outcome);
  const sql = 'FROM call_ledger' + (where.length ? ' WHERE ' + where.join(' AND ') : '');
  const total = init().prepare('SELECT COUNT(*) AS n ' + sql).get(...params).n;
  const rows = init().prepare('SELECT * ' + sql + ' ORDER BY started_at DESC, seq DESC LIMIT ? OFFSET ?')
    .all(...params, lim, off);
  return { rows, total };
}

// r4：测试/进程收尾用——关闭连接释放文件锁（Windows 下 rmSync 清理临时数据目录
// 时若连接未关会 EBUSY）。幂等：未初始化或已关闭时为 no-op。
function close() {
  if (!db) return;
  try { db.close(); } catch (e) { /* 幂等收尾，保持静默 */ }
  db = null;
}

module.exports = { init, recordCall, list, close, SCHEMA_VERSION, LIST_MAX_LIMIT };
