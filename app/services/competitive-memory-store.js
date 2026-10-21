'use strict';
// ============================================================
// services/competitive-memory-store.js —— Competitive Memory（SC-05）持久化
//   competitive_memory.db：对象 / 不可变版本 / 原子事实 / 派生事件 / 回补任务。
//
// 🔴 纪律：
//   · 独立库，不触碰 brands.db / data_surface.db / Snapshot / Evidence 目录；
//   · 所有表带 tenant_id + project_id + competitor_id 三列，读取一律三列硬过滤；
//     跨租户读取不存在「模糊命中」——查不到就是查不到（上层 404，不泄露存在性）；
//   · entity_versions 不可修改：只 INSERT，重复内容由 content_hash 唯一键挡回；
//   · temporal_facts 必须携带 evidence_ids 与 snapshot_ids（非空校验在写入函数内强制）；
//   · 只做加法迁移（PRAGMA user_version），WAL + busy_timeout，重启可恢复。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;
const FACT_TYPES = Object.freeze([
  'product.price', 'product.currency', 'product.available', 'product.title',
  'catalog.product_count', 'catalog.price_min', 'catalog.price_max', 'catalog.price_median',
]);
const FACT_TYPE_SET = new Set(FACT_TYPES);
const SOURCE_KINDS = Object.freeze(['live_observation', 'archived_observation', 'licensed_dataset', 'derived_event']);
const TIME_PRECISIONS = Object.freeze(['exact', 'day', 'month', 'captured_only', 'unknown']);
const ENTITY_TYPES = Object.freeze(['product', 'brand_catalog']);
const EVENT_TYPES = Object.freeze(['product_price_changed', 'product_first_observed', 'product_availability_changed']);
const BACKFILL_TERMINAL = Object.freeze(['done', 'partial', 'failed', 'source_unavailable', 'no_archive_record', 'dead']);

function dataDir() {
  return String(process.env.ZB_DATA_DIR || path.join(__dirname, '..', 'data'));
}
function dbPath() {
  const d = dataDir();
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch (e) {}
  return path.join(d, 'competitive_memory.db');
}
function rid(prefix) { return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }
function nowIso() { return new Date().toISOString(); }
function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function j(v) { try { return JSON.stringify(v == null ? null : v); } catch (e) { return 'null'; } }
function pj(s, dflt) { try { const v = JSON.parse(s); return v == null ? dflt : v; } catch (e) { return dflt; } }
function arr(v) { return Array.isArray(v) ? v.filter(Boolean).map(String) : []; }

let _db = null;
function getDb() {
  if (_db) return _db;
  const db = new DatabaseSync(dbPath());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');

  db.exec(`CREATE TABLE IF NOT EXISTS memory_entities (
    entity_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    canonical_brand_key TEXT,
    entity_type TEXT NOT NULL,
    source_platform TEXT,
    external_id TEXT,
    entity_key TEXT NOT NULL,
    display_name TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, project_id, competitor_id, entity_key)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_me_scope ON memory_entities(tenant_id, project_id, competitor_id, entity_type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_me_brandkey ON memory_entities(tenant_id, canonical_brand_key)');

  db.exec(`CREATE TABLE IF NOT EXISTS entity_versions (
    version_id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    source_snapshot_ids TEXT NOT NULL DEFAULT '[]',
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    source_url TEXT,
    final_url TEXT,
    source_kind TEXT NOT NULL,
    effective_at TEXT,
    observed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    time_precision TEXT NOT NULL,
    normalized_payload TEXT,
    content_hash TEXT NOT NULL,
    parser_version TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, project_id, competitor_id, entity_id, content_hash)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ev_scope ON entity_versions(tenant_id, project_id, competitor_id, observed_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ev_entity ON entity_versions(tenant_id, entity_id, observed_at)');

  db.exec(`CREATE TABLE IF NOT EXISTS temporal_facts (
    fact_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_version_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    fact_type TEXT NOT NULL,
    value_num REAL,
    value_text TEXT,
    value_hash TEXT NOT NULL,
    unit TEXT,
    currency TEXT,
    measurement_method TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    source_status TEXT NOT NULL,
    time_precision TEXT NOT NULL,
    effective_at TEXT,
    observed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    snapshot_ids TEXT NOT NULL DEFAULT '[]',
    comparable INTEGER NOT NULL DEFAULT 0,
    quality TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, project_id, competitor_id, entity_version_id, fact_type)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_tf_scope ON temporal_facts(tenant_id, project_id, competitor_id, fact_type, observed_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_tf_entity ON temporal_facts(tenant_id, project_id, competitor_id, entity_id, fact_type, observed_at)');

  db.exec(`CREATE TABLE IF NOT EXISTS derived_timeline_events (
    event_id TEXT PRIMARY KEY,
    event_key TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    event_type TEXT NOT NULL,
    derived_from_fact_ids TEXT NOT NULL DEFAULT '[]',
    evidence_ids TEXT NOT NULL DEFAULT '[]',
    snapshot_ids TEXT NOT NULL DEFAULT '[]',
    algorithm_version TEXT NOT NULL,
    from_value REAL,
    to_value REAL,
    unit TEXT,
    currency TEXT,
    effective_at TEXT,
    observed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    time_precision TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, project_id, competitor_id, event_key)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_de_scope ON derived_timeline_events(tenant_id, project_id, competitor_id, observed_at)');

  db.exec(`CREATE TABLE IF NOT EXISTS history_backfill_jobs (
    job_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    requested_from TEXT NOT NULL,
    requested_to TEXT NOT NULL,
    source_route TEXT NOT NULL,
    status TEXT NOT NULL,
    checkpoint TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    discovered_count INTEGER NOT NULL DEFAULT 0,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    imported_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    coverage_summary TEXT,
    failure_class TEXT,
    error_user_text TEXT,
    claim_token TEXT,
    claim_expires_at INTEGER,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_bj_scope ON history_backfill_jobs(tenant_id, project_id, competitor_id, created_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_bj_claim ON history_backfill_jobs(status, claim_expires_at)');

  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  _db = db;
  return db;
}
function closeDb() { try { if (_db) _db.close(); } catch (e) {} _db = null; }

// ---------------- memory_entities ----------------
function upsertEntity(input) {
  const db = getDb();
  const tid = String(input.tenantId || '');
  const pid = String(input.projectId || '');
  const cid = String(input.competitorId || '');
  if (!tid || !pid || !cid) throw new Error('competitive-memory-store: scope required (tenant/project/competitor)');
  const key = String(input.entityKey || '').trim();
  if (!key) throw new Error('competitive-memory-store: entityKey required');
  const type = String(input.entityType || '');
  if (!ENTITY_TYPES.includes(type)) throw new Error('competitive-memory-store: invalid entityType: ' + type);
  const seenAt = String(input.seenAt || nowIso());
  const now = nowIso();
  const existing = db.prepare('SELECT * FROM memory_entities WHERE tenant_id=? AND project_id=? AND competitor_id=? AND entity_key=?')
    .get(tid, pid, cid, key);
  if (existing) {
    db.prepare(`UPDATE memory_entities SET display_name=?, external_id=?, source_platform=?,
        canonical_brand_key=COALESCE(?, canonical_brand_key), last_seen_at=?, updated_at=?
      WHERE entity_id=?`)
      .run(input.displayName != null ? String(input.displayName).slice(0, 200) : existing.display_name,
        input.externalId != null ? String(input.externalId) : existing.external_id,
        input.sourcePlatform != null ? String(input.sourcePlatform) : existing.source_platform,
        input.canonicalBrandKey ? String(input.canonicalBrandKey) : null,
        existing.last_seen_at > seenAt ? existing.last_seen_at : seenAt,
        now, existing.entity_id);
    return { entityId: existing.entity_id, created: false, firstSeenAt: existing.first_seen_at };
  }
  const id = rid('me');
  db.prepare(`INSERT INTO memory_entities
      (entity_id, tenant_id, project_id, competitor_id, canonical_brand_key, entity_type, source_platform,
       external_id, entity_key, display_name, first_seen_at, last_seen_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, tid, pid, cid, input.canonicalBrandKey ? String(input.canonicalBrandKey) : null, type,
      input.sourcePlatform != null ? String(input.sourcePlatform) : null,
      input.externalId != null ? String(input.externalId) : null, key,
      input.displayName != null ? String(input.displayName).slice(0, 200) : null,
      seenAt, seenAt, now, now);
  return { entityId: id, created: true, firstSeenAt: seenAt };
}

function getEntity(tenantId, projectId, competitorId, entityId) {
  const r = getDb().prepare('SELECT * FROM memory_entities WHERE tenant_id=? AND project_id=? AND competitor_id=? AND entity_id=?')
    .get(String(tenantId), String(projectId), String(competitorId), String(entityId));
  return r ? rowToEntity(r) : null;
}
function rowToEntity(r) {
  return {
    entityId: r.entity_id, entityType: r.entity_type, entityKey: r.entity_key, externalId: r.external_id,
    displayName: r.display_name, sourcePlatform: r.source_platform, canonicalBrandKey: r.canonical_brand_key,
    firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at,
  };
}
function listEntities(tenantId, projectId, competitorId, opts) {
  const o = opts || {};
  const db = getDb();
  const params = [String(tenantId), String(projectId), String(competitorId)];
  let sql = 'SELECT * FROM memory_entities WHERE tenant_id=? AND project_id=? AND competitor_id=?';
  if (o.entityType) { sql += ' AND entity_type=?'; params.push(String(o.entityType)); }
  sql += ' ORDER BY last_seen_at DESC, entity_id DESC';
  if (o.limit) { sql += ' LIMIT ?'; params.push(Math.max(1, Math.min(Number(o.limit) || 50, 500))); }
  return db.prepare(sql).all(...params).map(rowToEntity);
}

// ---------------- entity_versions（不可变） ----------------
// contentHash 由调用方按归一化载荷计算；相同 (entity, hash) 不重复写入 → deduped=true。
function insertVersion(input) {
  const db = getDb();
  const tid = String(input.tenantId || '');
  const pid = String(input.projectId || '');
  const cid = String(input.competitorId || '');
  if (!tid || !pid || !cid) throw new Error('competitive-memory-store: scope required (tenant/project/competitor)');
  const entityId = String(input.entityId || '');
  if (!entityId) throw new Error('competitive-memory-store: entityId required');
  const sourceKind = String(input.sourceKind || '');
  if (!SOURCE_KINDS.includes(sourceKind) || sourceKind === 'derived_event') {
    throw new Error('competitive-memory-store: invalid sourceKind for version: ' + sourceKind);
  }
  const precision = String(input.timePrecision || 'captured_only');
  if (!TIME_PRECISIONS.includes(precision)) throw new Error('competitive-memory-store: invalid timePrecision: ' + precision);
  const observedAt = String(input.observedAt || nowIso());
  const recordedAt = String(input.recordedAt || nowIso());
  const effectiveAt = input.effectiveAt ? String(input.effectiveAt) : null;
  if (effectiveAt && precision === 'captured_only') throw new Error('competitive-memory-store: effective_at requires a real time precision');
  const payload = j(input.normalizedPayload == null ? null : input.normalizedPayload);
  const contentHash = String(input.contentHash || ('sha256:' + sha256hex(payload)));
  const parserVersion = String(input.parserVersion || '');
  if (!parserVersion) throw new Error('competitive-memory-store: parserVersion required (SC-01)');

  const dup = db.prepare('SELECT version_id FROM entity_versions WHERE tenant_id=? AND project_id=? AND competitor_id=? AND entity_id=? AND content_hash=?')
    .get(tid, pid, cid, entityId, contentHash);
  if (dup) return { versionId: dup.version_id, deduped: true, contentHash };

  const id = rid('ev');
  db.prepare(`INSERT INTO entity_versions
      (version_id, entity_id, tenant_id, project_id, competitor_id, source_snapshot_ids, evidence_ids,
       source_url, final_url, source_kind, effective_at, observed_at, recorded_at, time_precision,
       normalized_payload, content_hash, parser_version, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, entityId, tid, pid, cid, j(arr(input.sourceSnapshotIds)), j(arr(input.evidenceIds)),
      input.sourceUrl ? String(input.sourceUrl).slice(0, 900) : null,
      input.finalUrl ? String(input.finalUrl).slice(0, 900) : null,
      sourceKind, effectiveAt, observedAt, recordedAt, precision, payload, contentHash, parserVersion, nowIso());
  return { versionId: id, deduped: false, contentHash };
}

function rowToVersion(r) {
  return {
    versionId: r.version_id, entityId: r.entity_id,
    sourceSnapshotIds: pj(r.source_snapshot_ids, []), evidenceIds: pj(r.evidence_ids, []),
    sourceUrl: r.source_url, finalUrl: r.final_url, sourceKind: r.source_kind,
    effectiveAt: r.effective_at, observedAt: r.observed_at, recordedAt: r.recorded_at,
    timePrecision: r.time_precision, parserVersion: r.parser_version,
    contentHash: r.content_hash,
    payload: pj(r.normalized_payload, null),
  };
}
function getVersion(tenantId, projectId, competitorId, versionId) {
  const r = getDb().prepare('SELECT * FROM entity_versions WHERE tenant_id=? AND project_id=? AND competitor_id=? AND version_id=?')
    .get(String(tenantId), String(projectId), String(competitorId), String(versionId));
  return r ? rowToVersion(r) : null;
}
function listVersions(tenantId, projectId, competitorId, opts) {
  const o = opts || {};
  const params = [String(tenantId), String(projectId), String(competitorId)];
  let sql = 'SELECT * FROM entity_versions WHERE tenant_id=? AND project_id=? AND competitor_id=?';
  if (o.entityId) { sql += ' AND entity_id=?'; params.push(String(o.entityId)); }
  sql += ' ORDER BY observed_at DESC, version_id DESC LIMIT ?';
  params.push(Math.max(1, Math.min(Number(o.limit) || 100, 500)));
  return getDb().prepare(sql).all(...params).map(rowToVersion);
}

// ---------------- temporal_facts ----------------
function insertFact(input) {
  const db = getDb();
  const tid = String(input.tenantId || '');
  const pid = String(input.projectId || '');
  const cid = String(input.competitorId || '');
  if (!tid || !pid || !cid) throw new Error('competitive-memory-store: scope required (tenant/project/competitor)');
  const factType = String(input.factType || '');
  if (!FACT_TYPE_SET.has(factType)) throw new Error('competitive-memory-store: invalid factType: ' + factType);
  const versionId = String(input.entityVersionId || '');
  if (!versionId) throw new Error('competitive-memory-store: entityVersionId required');
  // 🔴 已核实历史准入：无 Evidence 或 无 SourceSnapshot 一律拒绝（不以「基础已完成」放行）
  const evidenceIds = arr(input.evidenceIds);
  const snapshotIds = arr(input.snapshotIds);
  if (!evidenceIds.length || !snapshotIds.length) {
    throw new Error('competitive-memory-store: fact requires >=1 evidence_id and >=1 snapshot_id (SC-05 §4.3)');
  }
  const precision = String(input.timePrecision || 'captured_only');
  if (!TIME_PRECISIONS.includes(precision)) throw new Error('competitive-memory-store: invalid timePrecision: ' + precision);
  const sourceKind = String(input.sourceKind || '');
  if (!SOURCE_KINDS.includes(sourceKind) || sourceKind === 'derived_event') throw new Error('competitive-memory-store: invalid sourceKind for fact: ' + sourceKind);
  const observedAt = String(input.observedAt || nowIso());
  const recordedAt = String(input.recordedAt || nowIso());
  const effectiveAt = input.effectiveAt ? String(input.effectiveAt) : null;

  const existing = db.prepare('SELECT fact_id FROM temporal_facts WHERE tenant_id=? AND project_id=? AND competitor_id=? AND entity_version_id=? AND fact_type=?')
    .get(tid, pid, cid, versionId, factType);
  if (existing) return { factId: existing.fact_id, deduped: true };

  const valueNum = typeof input.valueNum === 'number' && isFinite(input.valueNum) ? input.valueNum : null;
  const valueText = input.valueText == null ? null : String(input.valueText).slice(0, 400);
  const valueHash = 'sha256:' + sha256hex(valueNum != null ? ('n:' + valueNum) : ('t:' + (valueText == null ? '' : valueText)));
  const id = rid('tf');
  db.prepare(`INSERT INTO temporal_facts
      (fact_id, tenant_id, project_id, competitor_id, entity_id, entity_version_id, entity_type, fact_type,
       value_num, value_text, value_hash, unit, currency, measurement_method, source_kind, source_status,
       time_precision, effective_at, observed_at, recorded_at, evidence_ids, snapshot_ids, comparable, quality, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, tid, pid, cid, String(input.entityId || ''), versionId, String(input.entityType || 'product'), factType,
      valueNum, valueText, valueHash,
      input.unit == null ? null : String(input.unit),
      input.currency == null ? null : String(input.currency),
      String(input.measurementMethod || 'direct_observation'),
      sourceKind, String(input.sourceStatus || 'success'),
      precision, effectiveAt, observedAt, recordedAt,
      j(evidenceIds), j(snapshotIds),
      input.comparable === false ? 0 : 1,
      j(input.quality || {}), nowIso());
  return { factId: id, deduped: false };
}

function rowToFact(r) {
  return {
    factId: r.fact_id, entityId: r.entity_id, entityVersionId: r.entity_version_id,
    entityType: r.entity_type, factType: r.fact_type,
    value: r.value_num != null ? r.value_num : r.value_text,
    valueNum: r.value_num, valueText: r.value_text, valueHash: r.value_hash,
    unit: r.unit, currency: r.currency,
    measurementMethod: r.measurement_method, sourceKind: r.source_kind, sourceStatus: r.source_status,
    timePrecision: r.time_precision,
    effectiveAt: r.effective_at, observedAt: r.observed_at, recordedAt: r.recorded_at,
    // 时间轴锚点：有实际发生时间用 effective_at，否则用 observed_at（「Vantage 于某日观察到」）
    at: r.effective_at || r.observed_at,
    atBasis: r.effective_at ? 'effective_at' : 'observed_at',
    evidenceIds: pj(r.evidence_ids, []), snapshotIds: pj(r.snapshot_ids, []),
    comparable: !!r.comparable, quality: pj(r.quality, {}),
  };
}

// 游标：`${anchor}|${fact_id}`（base64url），按 anchor DESC + fact_id DESC 稳定翻页
function encodeCursor(anchor, id) { return Buffer.from(String(anchor) + '|' + String(id), 'utf8').toString('base64url'); }
function decodeCursor(c) {
  try {
    const s = Buffer.from(String(c), 'base64url').toString('utf8');
    const i = s.lastIndexOf('|');
    if (i < 0) return null;
    return { anchor: s.slice(0, i), id: s.slice(i + 1) };
  } catch (e) { return null; }
}

function listFacts(tenantId, projectId, competitorId, opts) {
  const o = opts || {};
  const db = getDb();
  const params = [String(tenantId), String(projectId), String(competitorId)];
  let sql = `SELECT * FROM temporal_facts WHERE tenant_id=? AND project_id=? AND competitor_id=?`;
  if (o.entityId) { sql += ' AND entity_id=?'; params.push(String(o.entityId)); }
  if (o.entityType) { sql += ' AND entity_type=?'; params.push(String(o.entityType)); }
  if (Array.isArray(o.factTypes) && o.factTypes.length) {
    sql += ' AND fact_type IN (' + o.factTypes.map(() => '?').join(',') + ')';
    for (const t of o.factTypes) params.push(String(t));
  }
  const from = o.from ? String(o.from).slice(0, 10) : null;
  const to = o.to ? String(o.to).slice(0, 10) : null;
  if (from) { sql += " AND substr(COALESCE(effective_at, observed_at),1,10) >= ?"; params.push(from); }
  if (to) { sql += " AND substr(COALESCE(effective_at, observed_at),1,10) <= ?"; params.push(to); }
  const cur = o.cursor ? decodeCursor(o.cursor) : null;
  if (cur) {
    sql += " AND (COALESCE(effective_at, observed_at) < ? OR (COALESCE(effective_at, observed_at) = ? AND fact_id < ?))";
    params.push(cur.anchor, cur.anchor, cur.id);
  }
  const limit = Math.max(1, Math.min(Number(o.limit) || 100, 500));
  sql += ' ORDER BY COALESCE(effective_at, observed_at) DESC, fact_id DESC LIMIT ?';
  params.push(limit + 1);
  const rows = db.prepare(sql).all(...params);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const out = page.map(rowToFact);
  const last = out[out.length - 1];
  return { facts: out, nextCursor: hasMore && last ? encodeCursor(last.at, last.factId) : null };
}

// 同一对象、同一事实类型的最近一条（用于派生事件比较）
function latestFact(tenantId, projectId, competitorId, entityId, factType) {
  const r = getDb().prepare(`SELECT * FROM temporal_facts
      WHERE tenant_id=? AND project_id=? AND competitor_id=? AND entity_id=? AND fact_type=?
      ORDER BY observed_at DESC, fact_id DESC LIMIT 1`)
    .get(String(tenantId), String(projectId), String(competitorId), String(entityId), String(factType));
  return r ? rowToFact(r) : null;
}
function listFactsForEntity(tenantId, projectId, competitorId, entityId, factType) {
  return getDb().prepare(`SELECT * FROM temporal_facts
      WHERE tenant_id=? AND project_id=? AND competitor_id=? AND entity_id=? AND fact_type=?
      ORDER BY observed_at ASC, fact_id ASC`)
    .all(String(tenantId), String(projectId), String(competitorId), String(entityId), String(factType))
    .map(rowToFact);
}
function countFacts(tenantId, projectId, competitorId) {
  const r = getDb().prepare('SELECT COUNT(*) AS n FROM temporal_facts WHERE tenant_id=? AND project_id=? AND competitor_id=?')
    .get(String(tenantId), String(projectId), String(competitorId));
  return r ? Number(r.n) : 0;
}

// ---------------- derived_timeline_events ----------------
function insertEvent(input) {
  const db = getDb();
  const tid = String(input.tenantId || '');
  const pid = String(input.projectId || '');
  const cid = String(input.competitorId || '');
  if (!tid || !pid || !cid) throw new Error('competitive-memory-store: scope required (tenant/project/competitor)');
  const eventType = String(input.eventType || '');
  if (!EVENT_TYPES.includes(eventType)) throw new Error('competitive-memory-store: invalid eventType: ' + eventType);
  const key = String(input.eventKey || '');
  if (!key) throw new Error('competitive-memory-store: eventKey required');
  const dup = db.prepare('SELECT event_id FROM derived_timeline_events WHERE tenant_id=? AND project_id=? AND competitor_id=? AND event_key=?')
    .get(tid, pid, cid, key);
  if (dup) return { eventId: dup.event_id, deduped: true };
  const id = rid('de');
  db.prepare(`INSERT INTO derived_timeline_events
      (event_id, event_key, tenant_id, project_id, competitor_id, entity_id, entity_type, event_type,
       derived_from_fact_ids, evidence_ids, snapshot_ids, algorithm_version, from_value, to_value,
       unit, currency, effective_at, observed_at, recorded_at, time_precision, summary, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, key, tid, pid, cid, String(input.entityId || ''), String(input.entityType || 'product'), eventType,
      j(arr(input.derivedFromFactIds)), j(arr(input.evidenceIds)), j(arr(input.snapshotIds)),
      String(input.algorithmVersion || 'mem-derive-1'),
      typeof input.fromValue === 'number' ? input.fromValue : null,
      typeof input.toValue === 'number' ? input.toValue : null,
      input.unit == null ? null : String(input.unit),
      input.currency == null ? null : String(input.currency),
      input.effectiveAt ? String(input.effectiveAt) : null,
      String(input.observedAt || nowIso()), String(input.recordedAt || nowIso()),
      String(input.timePrecision || 'captured_only'),
      input.summary == null ? null : String(input.summary).slice(0, 400), nowIso());
  return { eventId: id, deduped: false };
}
function rowToEvent(r) {
  return {
    eventId: r.event_id, entityId: r.entity_id, entityType: r.entity_type, eventType: r.event_type,
    derivedFromFactIds: pj(r.derived_from_fact_ids, []),
    evidenceIds: pj(r.evidence_ids, []), snapshotIds: pj(r.snapshot_ids, []),
    algorithmVersion: r.algorithm_version,
    fromValue: r.from_value, toValue: r.to_value, unit: r.unit, currency: r.currency,
    effectiveAt: r.effective_at, observedAt: r.observed_at, recordedAt: r.recorded_at,
    at: r.effective_at || r.observed_at,
    atBasis: r.effective_at ? 'effective_at' : 'observed_at',
    timePrecision: r.time_precision, summary: r.summary,
  };
}
function listEvents(tenantId, projectId, competitorId, opts) {
  const o = opts || {};
  const params = [String(tenantId), String(projectId), String(competitorId)];
  let sql = 'SELECT * FROM derived_timeline_events WHERE tenant_id=? AND project_id=? AND competitor_id=?';
  if (o.eventType) { sql += ' AND event_type=?'; params.push(String(o.eventType)); }
  if (Array.isArray(o.excludeTypes) && o.excludeTypes.length) {
    sql += ' AND event_type NOT IN (' + o.excludeTypes.map(() => '?').join(',') + ')';
    for (const t of o.excludeTypes) params.push(String(t));
  }
  const from = o.from ? String(o.from).slice(0, 10) : null;
  const to = o.to ? String(o.to).slice(0, 10) : null;
  if (from) { sql += " AND substr(COALESCE(effective_at, observed_at),1,10) >= ?"; params.push(from); }
  if (to) { sql += " AND substr(COALESCE(effective_at, observed_at),1,10) <= ?"; params.push(to); }
  sql += ' ORDER BY COALESCE(effective_at, observed_at) DESC, event_id DESC LIMIT ?';
  params.push(Math.max(1, Math.min(Number(o.limit) || 100, 5000)));
  return getDb().prepare(sql).all(...params).map(rowToEvent);
}

// 按天聚合的事件计数（时间线「当日首次观察到 N 个商品」的准确数字来源；
// 不依赖已加载的事件行数，避免分页上限把 N 说小）
function countEventDays(tenantId, projectId, competitorId, eventType, opts) {
  const o = opts || {};
  const params = [String(tenantId), String(projectId), String(competitorId), String(eventType)];
  let sql = `SELECT substr(COALESCE(effective_at, observed_at),1,10) AS day,
      COUNT(*) AS n, MIN(COALESCE(effective_at, observed_at)) AS first_at
    FROM derived_timeline_events
    WHERE tenant_id=? AND project_id=? AND competitor_id=? AND event_type=?`;
  if (o.from) { sql += " AND substr(COALESCE(effective_at, observed_at),1,10) >= ?"; params.push(String(o.from).slice(0, 10)); }
  if (o.to) { sql += " AND substr(COALESCE(effective_at, observed_at),1,10) <= ?"; params.push(String(o.to).slice(0, 10)); }
  sql += ' GROUP BY day ORDER BY day DESC';
  return getDb().prepare(sql).all(...params).map(r => ({ day: r.day, count: Number(r.n), firstAt: r.first_at }));
}

// ---------------- history_backfill_jobs ----------------
function createBackfillJob(input) {
  const db = getDb();
  const tid = String(input.tenantId || '');
  const pid = String(input.projectId || '');
  const cid = String(input.competitorId || '');
  const cap = String(input.capability || '');
  const from = String(input.from || '').slice(0, 10);
  const to = String(input.to || '').slice(0, 10);
  if (!tid || !pid || !cid || !cap || !from || !to) throw new Error('competitive-memory-store: backfill job requires scope + capability + from/to');
  // 幂等：同 scope + capability + 时间范围的「运行中/待执行」任务复用
  const active = db.prepare(`SELECT * FROM history_backfill_jobs
      WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=? AND requested_from=? AND requested_to=?
        AND status IN ('pending','running')
      ORDER BY created_at DESC LIMIT 1`).get(tid, pid, cid, cap, from, to);
  if (active) return { job: rowToJob(active), deduped: true };
  const id = rid('bfj');
  const now = nowIso();
  db.prepare(`INSERT INTO history_backfill_jobs
      (job_id, tenant_id, project_id, competitor_id, capability, requested_from, requested_to, source_route,
       status, checkpoint, attempts, discovered_count, fetched_count, imported_count, skipped_count,
       coverage_summary, failure_class, error_user_text, claim_token, claim_expires_at, created_at, started_at, finished_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, tid, pid, cid, cap, from, to, String(input.sourceRoute || 'web_archive'),
      'pending', null, 0, 0, 0, 0, 0, null, null, null, null, null, now, null, null, now);
  return { job: getBackfillJob(tid, id), deduped: false };
}
const JOB_STATUS_SET = new Set(['pending', 'running', 'done', 'partial', 'failed', 'source_unavailable', 'no_archive_record', 'dead']);
function rowToJob(r) {
  if (!r) return null;
  return {
    jobId: r.job_id, projectId: r.project_id, competitorId: r.competitor_id, capability: r.capability,
    requestedFrom: r.requested_from, requestedTo: r.requested_to, sourceRoute: r.source_route,
    status: r.status, checkpoint: r.checkpoint, attempts: r.attempts,
    counts: {
      discovered: r.discovered_count, fetched: r.fetched_count,
      imported: r.imported_count, skipped: r.skipped_count,
    },
    coverageSummary: pj(r.coverage_summary, null),
    failureClass: r.failure_class, errorUserText: r.error_user_text,
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at,
    claimToken: r.claim_token, claimExpiresAt: r.claim_expires_at,
  };
}
function getBackfillJob(tenantId, jobId) {
  const r = getDb().prepare('SELECT * FROM history_backfill_jobs WHERE tenant_id=? AND job_id=?')
    .get(String(tenantId), String(jobId));
  return rowToJob(r);
}
function latestBackfillJob(tenantId, projectId, competitorId, capability) {
  const r = getDb().prepare(`SELECT * FROM history_backfill_jobs
      WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=?
      ORDER BY created_at DESC LIMIT 1`)
    .get(String(tenantId), String(projectId), String(competitorId), String(capability));
  return rowToJob(r);
}
// 领取（租约 60s）：只认领 pending，或租约过期的 running（重启恢复语义）
function claimBackfillJob(tenantId, jobId, workerToken, nowMs) {
  const db = getDb();
  const now = nowMs != null ? nowMs : Date.now();
  const r = db.prepare('SELECT * FROM history_backfill_jobs WHERE tenant_id=? AND job_id=?').get(String(tenantId), String(jobId));
  if (!r) return null;
  if (BACKFILL_TERMINAL.includes(r.status)) return null; // 终态不可被覆盖
  const expired = r.status === 'running' && (!r.claim_expires_at || Number(r.claim_expires_at) < now);
  if (r.status !== 'pending' && !expired) return null;
  const info = db.prepare(`UPDATE history_backfill_jobs
      SET status='running', claim_token=?, claim_expires_at=?, started_at=COALESCE(started_at, ?),
          attempts=attempts+1, updated_at=?
      WHERE tenant_id=? AND job_id=? AND status=?`)
    .run(String(workerToken), now + 60000, new Date(now).toISOString(), new Date(now).toISOString(), String(tenantId), String(jobId), r.status);
  if (!info || Number(info.changes) !== 1) return null;
  return getBackfillJob(tenantId, jobId);
}
function heartbeatBackfillJob(tenantId, jobId, workerToken, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const info = getDb().prepare(`UPDATE history_backfill_jobs SET claim_expires_at=?, updated_at=?
      WHERE tenant_id=? AND job_id=? AND claim_token=? AND status='running'`)
    .run(now + 60000, new Date(now).toISOString(), String(tenantId), String(jobId), String(workerToken));
  return !!(info && Number(info.changes) === 1);
}
function saveBackfillProgress(tenantId, jobId, workerToken, patch) {
  const p = patch || {};
  const db = getDb();
  const cur = db.prepare('SELECT * FROM history_backfill_jobs WHERE tenant_id=? AND job_id=? AND claim_token=? AND status=\'running\'')
    .get(String(tenantId), String(jobId), String(workerToken));
  if (!cur) return false;
  const info = db.prepare(`UPDATE history_backfill_jobs
      SET checkpoint=?, discovered_count=?, fetched_count=?, imported_count=?, skipped_count=?,
          coverage_summary=?, updated_at=?
      WHERE tenant_id=? AND job_id=? AND claim_token=? AND status='running'`)
    .run(p.checkpoint != null ? String(p.checkpoint) : cur.checkpoint,
      p.discovered != null ? Number(p.discovered) : cur.discovered_count,
      p.fetched != null ? Number(p.fetched) : cur.fetched_count,
      p.imported != null ? Number(p.imported) : cur.imported_count,
      p.skipped != null ? Number(p.skipped) : cur.skipped_count,
      p.coverageSummary != null ? j(p.coverageSummary) : cur.coverage_summary,
      nowIso(), String(tenantId), String(jobId), String(workerToken));
  return !!(info && Number(info.changes) === 1);
}
// 终态写入：只允许 running（持租约）或 pending（未领取直接判定）→ 终态
function finishBackfillJob(tenantId, jobId, workerToken, outcome) {
  const o = outcome || {};
  const status = String(o.status || 'done');
  if (!BACKFILL_TERMINAL.includes(status)) throw new Error('competitive-memory-store: invalid terminal status: ' + status);
  const now = nowIso();
  const db = getDb();
  const cur = db.prepare('SELECT * FROM history_backfill_jobs WHERE tenant_id=? AND job_id=?').get(String(tenantId), String(jobId));
  if (!cur) return null;
  if (BACKFILL_TERMINAL.includes(cur.status)) return rowToJob(cur); // 终态不可覆盖
  if (cur.status === 'running' && workerToken && cur.claim_token && cur.claim_token !== String(workerToken)) {
    return rowToJob(cur); // 失租约：不改写别人的任务
  }
  db.prepare(`UPDATE history_backfill_jobs
      SET status=?, discovered_count=?, fetched_count=?, imported_count=?, skipped_count=?,
          coverage_summary=?, failure_class=?, error_user_text=?, claim_token=NULL, claim_expires_at=NULL,
          finished_at=?, updated_at=?
      WHERE tenant_id=? AND job_id=?`)
    .run(status,
      o.discovered != null ? Number(o.discovered) : cur.discovered_count,
      o.fetched != null ? Number(o.fetched) : cur.fetched_count,
      o.imported != null ? Number(o.imported) : cur.imported_count,
      o.skipped != null ? Number(o.skipped) : cur.skipped_count,
      o.coverageSummary != null ? j(o.coverageSummary) : cur.coverage_summary,
      o.failureClass != null ? String(o.failureClass) : null,
      o.errorUserText != null ? String(o.errorUserText).slice(0, 300) : null,
      now, now, String(tenantId), String(jobId));
  return getBackfillJob(tenantId, jobId);
}
// 重启恢复：running 且租约过期 → 回到 pending 重试；attempts 超限 → dead（不永久 running）
function reclaimExpiredBackfillJobs(nowMs, maxAttempts) {
  const now = nowMs != null ? nowMs : Date.now();
  const cap = Math.max(1, Number(maxAttempts) || 3);
  const db = getDb();
  const stale = db.prepare(`SELECT * FROM history_backfill_jobs WHERE status='running' AND (claim_expires_at IS NULL OR claim_expires_at < ?)`)
    .all(now);
  let requeued = 0, dead = 0;
  for (const r of stale) {
    if (Number(r.attempts) >= cap) {
      db.prepare(`UPDATE history_backfill_jobs SET status='dead', failure_class='attempts_exhausted',
          error_user_text='历史回补多次中断，已停止重试。可稍后重新发起。',
          claim_token=NULL, claim_expires_at=NULL, finished_at=?, updated_at=? WHERE tenant_id=? AND job_id=?`)
        .run(nowIso(), nowIso(), r.tenant_id, r.job_id);
      dead++;
    } else {
      db.prepare(`UPDATE history_backfill_jobs SET status='pending', claim_token=NULL, claim_expires_at=NULL, updated_at=?
          WHERE tenant_id=? AND job_id=?`).run(nowIso(), r.tenant_id, r.job_id);
      requeued++;
    }
  }
  return { requeued, dead };
}
function listBackfillJobs(tenantId, projectId, competitorId, limit) {
  return getDb().prepare(`SELECT * FROM history_backfill_jobs
      WHERE tenant_id=? AND project_id=? AND competitor_id=? ORDER BY created_at DESC LIMIT ?`)
    .all(String(tenantId), String(projectId), String(competitorId), Math.max(1, Math.min(Number(limit) || 10, 50)))
    .map(rowToJob);
}
function pendingBackfillJobs(limit) {
  return getDb().prepare("SELECT * FROM history_backfill_jobs WHERE status='pending' ORDER BY created_at ASC LIMIT ?")
    .all(Math.max(1, Math.min(Number(limit) || 5, 20))).map(rowToJob);
}

// ---------------- 覆盖统计（按维度 × 时间） ----------------
// 返回每维度的最早可用时间、最后成功采集时间、有证据的天数、来源计数。
function coverageStats(tenantId, projectId, competitorId) {
  const db = getDb();
  const rows = db.prepare(`SELECT entity_type, source_kind,
      MIN(COALESCE(effective_at, observed_at)) AS first_at,
      MAX(observed_at) AS last_at,
      COUNT(*) AS n,
      SUM(CASE WHEN comparable=1 THEN 1 ELSE 0 END) AS comparable_n
    FROM temporal_facts
    WHERE tenant_id=? AND project_id=? AND competitor_id=?
    GROUP BY entity_type, source_kind`)
    .all(String(tenantId), String(projectId), String(competitorId));
  const out = {};
  for (const r of rows) {
    const k = r.entity_type === 'brand_catalog' ? 'catalog' : 'product';
    const cur = out[k] || { entityType: r.entity_type, firstAt: null, lastAt: null, factCount: 0, comparableCount: 0, bySourceKind: {} };
    if (!cur.firstAt || String(r.first_at) < cur.firstAt) cur.firstAt = r.first_at;
    if (!cur.lastAt || String(r.last_at) > cur.lastAt) cur.lastAt = r.last_at;
    cur.factCount += Number(r.n);
    cur.comparableCount += Number(r.comparable_n);
    cur.bySourceKind[r.source_kind] = (cur.bySourceKind[r.source_kind] || 0) + Number(r.n);
    out[k] = cur;
  }
  return out;
}
// 有事实的日期集合（用于按天判定覆盖 vs 缺口）
function factDays(tenantId, projectId, competitorId, entityType) {
  const params = [String(tenantId), String(projectId), String(competitorId)];
  let sql = `SELECT DISTINCT substr(COALESCE(effective_at, observed_at),1,10) AS d FROM temporal_facts
    WHERE tenant_id=? AND project_id=? AND competitor_id=?`;
  if (entityType) { sql += ' AND entity_type=?'; params.push(String(entityType)); }
  sql += ' ORDER BY d ASC';
  return getDb().prepare(sql).all(...params).map(r => r.d);
}

module.exports = {
  SCHEMA_VERSION, FACT_TYPES, FACT_TYPE_SET, SOURCE_KINDS, TIME_PRECISIONS, ENTITY_TYPES, EVENT_TYPES, BACKFILL_TERMINAL,
  getDb, closeDb, dbPath, sha256hex, encodeCursor, decodeCursor,
  upsertEntity, getEntity, listEntities,
  insertVersion, getVersion, listVersions,
  insertFact, listFacts, latestFact, listFactsForEntity, countFacts,
  insertEvent, listEvents, countEventDays,
  createBackfillJob, getBackfillJob, latestBackfillJob, claimBackfillJob, heartbeatBackfillJob,
  saveBackfillProgress, finishBackfillJob, reclaimExpiredBackfillJobs, listBackfillJobs, pendingBackfillJobs,
  coverageStats, factDays, JOB_STATUS_SET,
};
