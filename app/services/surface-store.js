'use strict';
// ============================================================
// services/surface-store.js —— 数据面持久化（SC-02 §5/§6）
//   表1 brand_source_identities：最小 BrandSourceIdentity
//   表2 collection_attempts：CollectionAttempt（幂等 + 终态不可变）
// ------------------------------------------------------------
// 规格依据（冻结语义）：
//   · 00 v1.2 §53 Identity Continuity：identity_status 冻结三值
//     resolved/unresolved/conflicted（候选来源语义 = unresolved，
//     不新增第四值；origin_note 仅作运维备注，非状态位）
//   · 00 v1.2 §42 多租户：identity 是 Workspace 私有关系数据，全部读取
//     显式 tenantId 硬过滤；跨租户一律 null（上层 404 不泄露存在性）
//   · 03 v0.3 §9 / 00 §37 幂等：同 tenant×project×competitor×capability
//     running 复用；同 idempotency_key 返回既有 attempt（deduped）
//   · 03 v0.3 §20 trigger 词表：manual / schedule（沿用，不新造）
//   · 00 v1.2 §56：attempt 终态后不可变（重试 = 新 attempt 行）
//   · SC-02 §5（2026-10-18 整改轮）：BrandSourceIdentity 允许同一平台多个
//     地区账号/主页/广告主体——唯一键由 (tenant,project,competitor,platform)
//     扩为 (…, platform, account_key)（C-03 迁移见 getDb()；旧行 account_key
//     回填 platform_account_id 或空串，非破坏性）
//   · 00 v1.2 §2.1 reason_code 词表复用
//   · 05 v0.4.0 §11 SourceStatus 八值冻结字面量（attempt.source_status 沿用）
//   · SC-02 §6.2（整改轮）：collection_attempts.snapshot_ids 上限由 20 提至
//     50——多页采集（products.json ≤4 页）+ cart.js 币种快照全部引用须可容纳；
//     全量可追溯优先于行宽（00 §56 append-only 语义不变）
// 存储：node:sqlite 单文件 ZB_DATA_DIR/data_surface.db（WAL），与
//   watch_targets.db 同口径，加法迁移互不影响。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const Registry = require('./capability-registry.js');

const SURFACE_DB = path.join(
  process.env.ZB_DATA_DIR ? path.resolve(process.env.ZB_DATA_DIR) : path.join(__dirname, '..', 'data'),
  'data_surface.db'
);

// ---- 冻结词表 ----
const IDENTITY_STATUSES = new Set(['resolved', 'unresolved', 'conflicted']); // 00 §53
const ATTEMPT_STATUSES = new Set(['running', 'success', 'partial', 'failed']); // 终态三值 + running
const TERMINAL_STATUSES = new Set(['success', 'partial', 'failed']);
const TRIGGERS = new Set(['manual', 'schedule']); // 03 §20（monitor/recheck 等归监控链路，不经此表）
const SOURCE_STATUSES = new Set(['success', 'partial', 'unavailable', 'blocked', 'rate_limited', 'parse_failed', 'timeout', 'internal_error']); // 05 §11

const SCHEMA_VERSION = 2;
const OBSERVATION_CAP = 1000;     // attempt 行内 observations 摘要上限（与采集分页预算对齐：net.js ≤1000 款；全量原始走 SourceSnapshot blob）
const RESOLUTION_DEDUPE_MS = 120 * 1000; // 手动刷新幂等时间桶（防双击双费用；SC-02 §6）

let _db = null;
function getDb() {
  if (_db) return _db;
  try { if (!fs.existsSync(path.dirname(SURFACE_DB))) fs.mkdirSync(path.dirname(SURFACE_DB), { recursive: true }); } catch (e) {}
  const db = new DatabaseSync(SURFACE_DB);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  // ---- schema 版本与迁移（user_version 持久化；加法迁移不覆盖历史 00 §56）----
  const schemaVer = Number((db.prepare('PRAGMA user_version').get() || {}).user_version || 0);
  const tableExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='brand_source_identities'").get();
  if (schemaVer >= 2 || !tableExists) {
    // v2（或全新库）：identity 唯一键含 account_key（同平台多账号共存）
    db.exec(`CREATE TABLE IF NOT EXISTS brand_source_identities (
      identity_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      competitor_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      platform_account_id TEXT,
      account_key TEXT NOT NULL DEFAULT '',
      official_domain TEXT,
      identity_status TEXT NOT NULL,
      origin_note TEXT,
      evidence_ids TEXT NOT NULL DEFAULT '[]',
      snapshot_ids TEXT NOT NULL DEFAULT '[]',
      resolver_version TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, project_id, competitor_id, platform, account_key)
    )`);
  } else {
    // v1 → v2 非破坏性迁移：旧行 account_key 回填 platform_account_id（或空串）；
    // 旧唯一键已保证 (tenant,project,competitor,platform) 不重复，回填不引入冲突。
    db.exec(`CREATE TABLE IF NOT EXISTS brand_source_identities_v2 (
      identity_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      competitor_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      platform_account_id TEXT,
      account_key TEXT NOT NULL DEFAULT '',
      official_domain TEXT,
      identity_status TEXT NOT NULL,
      origin_note TEXT,
      evidence_ids TEXT NOT NULL DEFAULT '[]',
      snapshot_ids TEXT NOT NULL DEFAULT '[]',
      resolver_version TEXT,
      resolved_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, project_id, competitor_id, platform, account_key)
    )`);
    db.exec(`INSERT INTO brand_source_identities_v2
      (identity_id, tenant_id, project_id, competitor_id, platform, platform_account_id, account_key,
       official_domain, identity_status, origin_note, evidence_ids, snapshot_ids, resolver_version,
       resolved_at, created_at, updated_at)
      SELECT identity_id, tenant_id, project_id, competitor_id, platform, platform_account_id,
       COALESCE(platform_account_id, ''), official_domain, identity_status, origin_note,
       evidence_ids, snapshot_ids, resolver_version, resolved_at, created_at, updated_at
      FROM brand_source_identities`);
    db.exec('DROP TABLE brand_source_identities');
    db.exec('ALTER TABLE brand_source_identities_v2 RENAME TO brand_source_identities');
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_bsi_tenant ON brand_source_identities(tenant_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS collection_attempts (
    attempt_id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    dimension TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,
    source_status TEXT,
    error_class TEXT,
    error_user_text TEXT,
    observation_count INTEGER NOT NULL DEFAULT 0,
    observations TEXT NOT NULL DEFAULT '[]',
    summary TEXT,
    snapshot_ids TEXT NOT NULL DEFAULT '[]',
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    cost_attribution_key TEXT,
    collector_version TEXT,
    parser_version TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    updated_at TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ca_tenant ON collection_attempts(tenant_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ca_scope ON collection_attempts(tenant_id, project_id, competitor_id, capability)`);
  if (schemaVer !== 2) db.exec('PRAGMA user_version = 2');
  _db = db;
  return db;
}
function closeDb() { if (_db) { try { _db.close(); } catch (e) {} _db = null; } }

function rid(prefix) { return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }
function nowIso() { return new Date().toISOString(); }

// 手动刷新幂等键（SC-02 §6）：语义身份 + 时间桶；桶宽 RESOLUTION_DEDUPE_MS
function buildRefreshKey(tenantId, projectId, competitorId, capability, nowMs) {
  const bucket = Math.floor((nowMs || Date.now()) / RESOLUTION_DEDUPE_MS);
  return crypto.createHash('sha256').update([
    String(tenantId || ''), String(projectId || ''), String(competitorId || ''), String(capability || ''), String(bucket),
  ].join('|')).digest('hex');
}

// ================= BrandSourceIdentity =================

// upsert（同 tenant×project×competitor×platform×account_key 唯一；SC-02 §5 整改：
// 同平台多账号（地区账号/主页/广告主体）经 account_key 共存。重解析覆盖旧值并
// 保留历史于 snapshot_ids 追加——身份不是 immutable 领域对象，但每次解析都留
// Evidence 溯源）
function upsertIdentity(input, fence) {
  const db = getDb();
  const status = input.identityStatus;
  if (!IDENTITY_STATUSES.has(status)) throw new Error('surface-store: invalid identity_status (00 §53 frozen): ' + String(status));
  const tid = String(input.tenantId || '');
  if (!tid) throw new Error('surface-store: tenantId required');
  // 🔴 复审 §三：resolved 升级是特权写入——必须持有效 claim fence（job running +
  // token 匹配 + 租约未过期）；失租/伪造 worker 不得把来源身份升级为 resolved。
  // unresolved/conflicted 为非特权默认/降级写，不强制 fence（幂等默认值）。
  if (status === 'resolved' && fence && fence.jobId && fence.token) {
    let job = null;
    try {
      job = db.prepare('SELECT status, claim_token, claim_expires_at FROM collection_jobs WHERE job_id=? AND tenant_id=?')
        .get(String(fence.jobId), String(tid));
    } catch (e) { job = null; }
    if (!job || job.status !== 'running' || String(job.claim_token) !== String(fence.token) || Number(job.claim_expires_at || 0) < Date.now()) {
      const err = new Error('surface-store: FENCED (identity resolved upgrade denied — job claim token invalid or lease expired)');
      err.fenced = true;
      throw err;
    }
  }
  const now = nowIso();
  const accountKey = input.platformAccountId == null ? '' : String(input.platformAccountId);
  const existing = db.prepare('SELECT * FROM brand_source_identities WHERE tenant_id=? AND project_id=? AND competitor_id=? AND platform=? AND account_key=?')
    .get(tid, String(input.projectId || ''), String(input.competitorId || ''), String(input.platform || ''), accountKey);
  if (existing) {
    const snapIds = JSON.parse(existing.snapshot_ids || '[]');
    for (const s of (input.snapshotIds || [])) if (!snapIds.includes(s)) snapIds.push(s);
    const evIds = JSON.parse(existing.evidence_ids || '[]');
    for (const e of (input.evidenceIds || [])) if (!evIds.includes(e)) evIds.push(e);
    db.prepare(`UPDATE brand_source_identities SET platform_account_id=?, account_key=?, official_domain=?, identity_status=?,
      origin_note=?, evidence_ids=?, snapshot_ids=?, resolver_version=?, resolved_at=?, updated_at=?
      WHERE identity_id=?`)
      .run(input.platformAccountId || null, accountKey, input.officialDomain || null, status,
        input.originNote || null, JSON.stringify(evIds.slice(-20)), JSON.stringify(snapIds.slice(-20)),
        input.resolverVersion || existing.resolver_version || null,
        status === 'resolved' ? (input.resolvedAt || now) : existing.resolved_at, now, existing.identity_id);
    return { identity: getIdentity(tid, input.projectId, input.competitorId, input.platform, accountKey), existed: true };
  }
  const id = rid('bsi');
  db.prepare(`INSERT INTO brand_source_identities
    (identity_id, tenant_id, project_id, competitor_id, platform, platform_account_id, account_key, official_domain,
     identity_status, origin_note, evidence_ids, snapshot_ids, resolver_version, resolved_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, tid, String(input.projectId || ''), String(input.competitorId || ''), String(input.platform || ''),
      input.platformAccountId || null, accountKey, input.officialDomain || null, status, input.originNote || null,
      JSON.stringify((input.evidenceIds || []).slice(-20)), JSON.stringify((input.snapshotIds || []).slice(-20)),
      input.resolverVersion || null, status === 'resolved' ? (input.resolvedAt || now) : null, now, now);
  return { identity: getIdentity(tid, input.projectId, input.competitorId, input.platform, accountKey), existed: false };
}

function rowToIdentity(r) {
  if (!r) return null;
  let evIds = [], snapIds = [];
  try { evIds = JSON.parse(r.evidence_ids || '[]'); } catch (e) {}
  try { snapIds = JSON.parse(r.snapshot_ids || '[]'); } catch (e) {}
  return {
    identityId: r.identity_id,
    projectId: r.project_id,
    competitorId: r.competitor_id,
    platform: r.platform,
    platformAccountId: r.platform_account_id,
    accountKey: r.account_key,
    officialDomain: r.official_domain,
    identityStatus: r.identity_status,
    originNote: r.origin_note,
    evidenceIds: evIds,
    snapshotIds: snapIds,
    resolverVersion: r.resolver_version,
    resolvedAt: r.resolved_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// 全部读取显式租户硬过滤（00 §42）；跨租户 → null（上层 404）。
// accountKey 省略 = 该 platform 首个账号（兼容 v0 单账号查询口径）。
function getIdentity(tenantId, projectId, competitorId, platform, accountKey) {
  if (accountKey == null) {
    // 同平台多账号时取最近更新的那一行（投影默认展示）；显式传 accountKey 精确命中
    const r = getDb().prepare('SELECT * FROM brand_source_identities WHERE tenant_id=? AND project_id=? AND competitor_id=? AND platform=? ORDER BY updated_at DESC LIMIT 1')
      .get(String(tenantId || ''), String(projectId || ''), String(competitorId || ''), String(platform || ''));
    return rowToIdentity(r);
  }
  const r = getDb().prepare('SELECT * FROM brand_source_identities WHERE tenant_id=? AND project_id=? AND competitor_id=? AND platform=? AND account_key=?')
    .get(String(tenantId || ''), String(projectId || ''), String(competitorId || ''), String(platform || ''), String(accountKey));
  return rowToIdentity(r);
}
function listIdentities(tenantId, projectId, competitorId) {
  return getDb().prepare('SELECT * FROM brand_source_identities WHERE tenant_id=? AND project_id=? AND competitor_id=? ORDER BY updated_at DESC')
    .all(String(tenantId || ''), String(projectId || ''), String(competitorId || '')).map(rowToIdentity);
}

// ================= CollectionAttempt =================

function rowToAttempt(r) {
  if (!r) return null;
  let obs = [], evIds = [], snapIds = [], summary = null;
  try { obs = JSON.parse(r.observations || '[]'); } catch (e) {}
  try { evIds = JSON.parse(r.evidence_ids || '[]'); } catch (e) {}
  try { snapIds = JSON.parse(r.snapshot_ids || '[]'); } catch (e) {}
  try { summary = r.summary ? JSON.parse(r.summary) : null; } catch (e) {}
  return {
    attemptId: r.attempt_id,
    idempotencyKey: r.idempotency_key,
    projectId: r.project_id,
    competitorId: r.competitor_id,
    capability: r.capability,
    dimension: r.dimension,
    trigger: r.trigger,
    status: r.status,
    sourceStatus: r.source_status,
    errorClass: r.error_class,
    errorUserText: r.error_user_text,
    observationCount: r.observation_count,
    observations: obs,
    summary,
    snapshotIds: snapIds,
    evidenceIds: evIds,
    costAttributionKey: r.cost_attribution_key,
    collectorVersion: r.collector_version,
    parserVersion: r.parser_version,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    updatedAt: r.updated_at,
  };
}

// 创建 attempt（幂等）。返回 { attempt, deduped }——deduped=true 表示复用既有
// running/近窗 attempt，调用方不得再次执行采集（防双击双任务双费用）。
function createAttempt(input) {
  const db = getDb();
  const tid = String(input.tenantId || '');
  if (!tid) throw new Error('surface-store: tenantId required');
  if (!TRIGGERS.has(input.trigger)) throw new Error('surface-store: invalid trigger (03 §20): ' + String(input.trigger));
  const cap = String(input.capability || '');
  const now = input.nowMs ? new Date(input.nowMs).toISOString() : nowIso(); // 时间手术：nowMs 覆盖（测试/回放）
  // 幂等零：capability 级刷新冷却 + 自然日额度（SC-02 §6.3 整改轮——
  // 付费来源不能被无限刷新；免费公开源同样防狂刷）。仅对自动生成的
  // 时间桶键（手动刷新）生效；显式 idempotencyKey（巡检/测试）由调用方自管。
  const useManagedKey = !input.idempotencyKey;
  if (useManagedKey) {
    const capDef = Registry.getCapability(cap);
    const rp = capDef && capDef.refreshPolicy;
    if (rp && rp.cooldownMinutes > 0) {
      const lastOk = db.prepare(`SELECT * FROM collection_attempts
        WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=? AND status IN ('success','partial')
        ORDER BY ended_at DESC LIMIT 1`)
        .get(tid, String(input.projectId || ''), String(input.competitorId || ''), cap);
      if (lastOk && lastOk.ended_at) {
        const elapsedMs = (input.nowMs || Date.now()) - Date.parse(lastOk.ended_at);
        if (elapsedMs < rp.cooldownMinutes * 60 * 1000) {
          return { attempt: rowToAttempt(lastOk), deduped: true, cooldown: true };
        }
      }
    }
    if (rp && rp.dailyQuota) {
      const d0 = new Date(input.nowMs || Date.now());
      d0.setUTCHours(0, 0, 0, 0);
      const n = db.prepare(`SELECT COUNT(*) AS n FROM collection_attempts
        WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=? AND started_at >= ?`)
        .get(tid, String(input.projectId || ''), String(input.competitorId || ''), cap, d0.toISOString()).n;
      if (n >= rp.dailyQuota) {
        return { attempt: null, deduped: false, quotaExceeded: true, quota: rp.dailyQuota };
      }
    }
  }
  // 幂等一：同 scope 的 running attempt 复用（无论时间桶）——并发双击不产生第二个采集。
  // 崩溃残留护栏：running 超 STALE_CLAIM_MS 视为弃管，不再复用（与 watch-store 同口径）。
  const cutoffIso = new Date((input.nowMs || Date.now()) - 30 * 60 * 1000).toISOString();
  const running = db.prepare(
    "SELECT * FROM collection_attempts WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=? AND status='running' AND started_at >= ? ORDER BY started_at DESC LIMIT 1")
    .get(tid, String(input.projectId || ''), String(input.competitorId || ''), cap, cutoffIso);
  if (running) return { attempt: rowToAttempt(running), deduped: true };
  // 幂等二：同 idempotency_key（时间桶）已有 attempt → 复用
  const key = input.idempotencyKey || buildRefreshKey(tid, input.projectId, input.competitorId, cap, input.nowMs);
  const byKey = db.prepare('SELECT * FROM collection_attempts WHERE idempotency_key=?').get(key);
  if (byKey) return { attempt: rowToAttempt(byKey), deduped: true };
  const id = rid('att');
  db.prepare(`INSERT INTO collection_attempts
    (attempt_id, idempotency_key, tenant_id, project_id, competitor_id, capability, dimension, trigger,
     status, cost_attribution_key, collector_version, parser_version, started_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, key, tid, String(input.projectId || ''), String(input.competitorId || ''), cap,
      String(input.dimension || ''), input.trigger, 'running',
      input.costAttributionKey || null, input.collectorVersion || null, input.parserVersion || null, now, now);
  return { attempt: getAttempt(tid, id), deduped: false };
}

// 终态落账（仅 running → 终态；终态后不可变——00 §56.2，二次调用显式拒绝）。
// fence（可选，复审 §五）：{ jobId, token } —— 校验该 job 仍 running 且 claimToken
// 匹配且租约未过期；不满足 → 抛 FENCED 错误（旧 worker 失租约后不得抢写）。
// 🔴 复审 §三.3：UPDATE 携带 status='running' 条件（原子 CAS）——跨进程竞态
// （worker1/worker2 各持连接）下「先读到 running、后覆盖终态」被条件写消除；
// changes=0 时重读区分「已终态（immutable 抛错）」与「行不存在」。
function completeAttempt(tenantId, attemptId, outcome, fence) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM collection_attempts WHERE tenant_id=? AND attempt_id=?')
    .get(String(tenantId || ''), String(attemptId || ''));
  if (!r) return null;
  if (TERMINAL_STATUSES.has(r.status)) {
    throw new Error('surface-store: attempt already terminal, immutable (00 §56.2): ' + attemptId);
  }
  if (fence && fence.jobId && fence.token) {
    let job = null;
    try {
      job = db.prepare('SELECT status, claim_token, claim_expires_at FROM collection_jobs WHERE job_id=? AND tenant_id=?')
        .get(String(fence.jobId), String(tenantId || ''));
    } catch (e) { job = null; } // 表不存在（未初始化队列）= 无有效 fencing 上下文
    if (!job || job.status !== 'running' || String(job.claim_token) !== String(fence.token) || Number(job.claim_expires_at || 0) < Date.now()) {
      const err = new Error('surface-store: FENCED (job claim token invalid or lease expired): ' + attemptId);
      err.fenced = true;
      throw err;
    }
  }
  const status = outcome.status;
  if (!TERMINAL_STATUSES.has(status)) throw new Error('surface-store: invalid terminal status: ' + String(status));
  const sourceStatus = outcome.sourceStatus || null;
  if (sourceStatus != null && !SOURCE_STATUSES.has(sourceStatus)) {
    throw new Error('surface-store: invalid source_status (05 §11): ' + String(sourceStatus));
  }
  const obs = (Array.isArray(outcome.observations) ? outcome.observations : []).slice(0, OBSERVATION_CAP);
  const upd = db.prepare(`UPDATE collection_attempts SET status=?, source_status=?, error_class=?, error_user_text=?,
    observation_count=?, observations=?, summary=?, snapshot_ids=?, evidence_ids=?, ended_at=?, updated_at=?
    WHERE tenant_id=? AND attempt_id=? AND status='running'`)
    .run(status, sourceStatus, outcome.errorClass || null, outcome.errorUserText || null,
      obs.length, JSON.stringify(obs), outcome.summary ? JSON.stringify(outcome.summary) : null,
      JSON.stringify((outcome.snapshotIds || []).slice(-50)),
      JSON.stringify((outcome.evidenceIds || []).slice(-50)),
      outcome.endedAt || nowIso(), nowIso(),
      String(tenantId), String(attemptId));
  if (upd.changes === 0) {
    const cur = db.prepare('SELECT status FROM collection_attempts WHERE tenant_id=? AND attempt_id=?')
      .get(String(tenantId || ''), String(attemptId || ''));
    if (!cur) return null;
    throw new Error('surface-store: attempt not running at CAS write (status=' + cur.status + ', immutable 00 §56.2): ' + attemptId);
  }
  return getAttempt(tenantId, attemptId);
}

function getAttempt(tenantId, attemptId) {
  const r = getDb().prepare('SELECT * FROM collection_attempts WHERE tenant_id=? AND attempt_id=?')
    .get(String(tenantId || ''), String(attemptId || ''));
  return rowToAttempt(r);
}
// 最近 N 次 attempt（租户硬过滤）
// 按竞品列出全部能力的 attempt（品牌级状态派生用；capability 不参与过滤）
function listAttemptsByCompetitor(tenantId, projectId, competitorId, limit) {
  const n = Math.max(1, Math.min(Number(limit) || 20, 100));
  return getDb().prepare(`SELECT * FROM collection_attempts WHERE tenant_id=? AND project_id=? AND competitor_id=?
    ORDER BY started_at DESC LIMIT ?`)
    .all(String(tenantId || ''), String(projectId || ''), String(competitorId || ''), n)
    .map(rowToAttempt);
}

function listAttempts(tenantId, projectId, competitorId, capability, limit) {
  const n = Math.max(1, Math.min(Number(limit) || 10, 50));
  return getDb().prepare(`SELECT * FROM collection_attempts WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=?
    ORDER BY started_at DESC LIMIT ?`)
    .all(String(tenantId || ''), String(projectId || ''), String(competitorId || ''), String(capability || ''), n)
    .map(rowToAttempt);
}
function latestAttempt(tenantId, projectId, competitorId, capability) {
  const rows = listAttempts(tenantId, projectId, competitorId, capability, 1);
  return rows.length ? rows[0] : null;
}

module.exports = {
  SCHEMA_VERSION, IDENTITY_STATUSES, ATTEMPT_STATUSES, TERMINAL_STATUSES, TRIGGERS, SOURCE_STATUSES,
  RESOLUTION_DEDUPE_MS, OBSERVATION_CAP,
  getDb, closeDb, buildRefreshKey,
  upsertIdentity, getIdentity, listIdentities,
  createAttempt, completeAttempt, getAttempt, listAttempts, listAttemptsByCompetitor, latestAttempt,
};
