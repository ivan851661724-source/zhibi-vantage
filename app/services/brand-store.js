'use strict';
// ============================================================
// services/brand-store.js —— 统一竞品数据库（SC-04）持久化
//   只读投影 + 用户产物，**不复制、不篡改真值链**
//   （SourceSnapshot → Evidence → Fact → Metric → DomainEvent → Judgment）。
//   本库存：Brand Record / Brand↔Project Link / Brand Timeline Index /
//   Research Report / Report Citation / Report Job（持久生成任务）。
//   第一版只做 Workspace（租户）内 Canonical Brand，不跨租户/跨 Workspace 合并。
//   所有读取显式 tenantId 硬过滤；跨租户一律 null（上层 404，不泄露存在性）。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 2;
// 自动重试上限（真实重试语义：回 pending 可再次领取；耗尽 → dead 终态）
const REPORT_JOB_MAX_RETRY = Math.max(1, Number(process.env.ZB_REPORT_MAX_RETRY) || 3);

function dataDir() {
  return String(process.env.ZB_DATA_DIR || path.join(__dirname, '..', 'data'));
}
function dbPath() {
  const d = path.join(dataDir(), 'brands.db');
  try { if (!fs.existsSync(dataDir())) fs.mkdirSync(dataDir(), { recursive: true }); } catch (e) {}
  return d;
}
function rid(prefix) {
  return prefix + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}
function nowIso() { return new Date().toISOString(); }

let _db = null;
function getDb() {
  if (_db) return _db;
  const db = new DatabaseSync(dbPath());
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS brand_records (
    brand_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    canonical_name TEXT NOT NULL,
    official_domain TEXT,
    market TEXT,
    category TEXT,
    relation TEXT,
    competitor_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_br_tenant ON brand_records(tenant_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_br_domain ON brand_records(tenant_id, official_domain)');
  db.exec(`CREATE TABLE IF NOT EXISTS brand_project_links (
    link_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    brand_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    market TEXT,
    category TEXT,
    relation TEXT,
    competitor_ref TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, brand_id, project_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_bpl_scope ON brand_project_links(tenant_id, project_id)');
  db.exec(`CREATE TABLE IF NOT EXISTS brand_timeline (
    event_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    brand_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at TEXT NOT NULL,
    nature TEXT NOT NULL,
    status TEXT,
    title TEXT,
    detail TEXT,
    ref_type TEXT,
    ref_id TEXT,
    payload TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_bt_scope ON brand_timeline(tenant_id, brand_id, at)');
  db.exec(`CREATE TABLE IF NOT EXISTS reports (
    report_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'queued',
    scope TEXT NOT NULL,
    markdown TEXT,
    fact_pack TEXT,
    coverage TEXT,
    gaps TEXT,
    opportunities TEXT,
    error_text TEXT,
    generated_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_rp_scope ON reports(tenant_id, project_id, created_at)');
  db.exec(`CREATE TABLE IF NOT EXISTS report_citations (
    citation_id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    section TEXT,
    fact_id TEXT,
    label TEXT,
    evidence_ids TEXT,
    snapshot_ids TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_rc_report ON report_citations(tenant_id, report_id)');
  // v2 迁移：引用来源 URL（事实无 Evidence/Snapshot 链时，引用自带可核验来源，不伪造证据 id）
  try { db.exec('ALTER TABLE report_citations ADD COLUMN source_url TEXT'); } catch (e) {}
  db.exec(`CREATE TABLE IF NOT EXISTS report_jobs (
    job_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    report_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    retry INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    claim_expires_at INTEGER,
    last_error TEXT,
    created_at TEXT NOT NULL,
    done_at TEXT
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_rj_claim ON report_jobs(status, claim_expires_at)');
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  _db = db;
  return db;
}
function closeDb() { try { if (_db) _db.close(); } catch (e) {} _db = null; }

// ---------------- Brand Record ----------------
function upsertBrand(input) {
  const db = getDb();
  const tid = String(input.tenantId || '');
  if (!tid) throw new Error('brand-store: tenantId required');
  const now = nowIso();
  const domain = input.officialDomain ? String(input.officialDomain).toLowerCase() : null;
  const ref = input.competitorRef || null;
  // 幂等键：租户 + 域名（有域名时）；无域名时用 competitor_ref
  let existing = null;
  if (domain) existing = db.prepare('SELECT * FROM brand_records WHERE tenant_id=? AND official_domain=?').get(tid, domain);
  if (!existing && ref) existing = db.prepare('SELECT * FROM brand_records WHERE tenant_id=? AND competitor_ref=?').get(tid, String(ref));
  if (existing) {
    // 🔴 竞品数据边界：competitor_ref 是【项目级】字段（brand_project_links 为准），
    // 全局记录只在首次创建时记录初见值，更新时不得被其他项目同步覆盖。
    db.prepare(`UPDATE brand_records SET canonical_name=?, official_domain=?, market=?, category=?, relation=?, competitor_ref=?, updated_at=?
      WHERE brand_id=?`)
      .run(input.canonicalName || existing.canonical_name, domain || existing.official_domain,
        input.market != null ? input.market : existing.market,
        input.category != null ? input.category : existing.category,
        input.relation != null ? input.relation : existing.relation,
        existing.competitor_ref || ref, now, existing.brand_id);
    return { brand: getBrand(tid, existing.brand_id), existed: true };
  }
  const id = rid('br');
  db.prepare(`INSERT INTO brand_records (brand_id, tenant_id, canonical_name, official_domain, market, category, relation, competitor_ref, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, tid, String(input.canonicalName || '未命名品牌'), domain,
      input.market || null, input.category || null, input.relation || null, ref, now, now);
  return { brand: getBrand(tid, id), existed: false };
}

function getBrand(tenantId, brandId) {
  const r = getDb().prepare('SELECT * FROM brand_records WHERE tenant_id=? AND brand_id=?')
    .get(String(tenantId || ''), String(brandId || ''));
  return r ? rowToBrand(r) : null;
}
function listBrands(tenantId, projectId) {
  const db = getDb();
  const rows = projectId
    ? db.prepare(`SELECT b.* FROM brand_records b
        INNER JOIN brand_project_links l ON l.brand_id=b.brand_id AND l.tenant_id=b.tenant_id
        WHERE b.tenant_id=? AND l.project_id=? ORDER BY b.canonical_name ASC`)
      .all(String(tenantId || ''), String(projectId))
    : db.prepare('SELECT * FROM brand_records WHERE tenant_id=? ORDER BY canonical_name ASC').all(String(tenantId || ''));
  return rows.map(rowToBrand);
}
function rowToBrand(r) {
  return {
    brandId: r.brand_id, canonicalName: r.canonical_name, officialDomain: r.official_domain,
    market: r.market, category: r.category, relation: r.relation, competitorRef: r.competitor_ref,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---------------- Brand ↔ Project Link ----------------
function linkProject(input) {
  const db = getDb();
  const tid = String(input.tenantId || '');
  const r = db.prepare('SELECT * FROM brand_project_links WHERE tenant_id=? AND brand_id=? AND project_id=?')
    .get(tid, String(input.brandId || ''), String(input.projectId || ''));
  const now = nowIso();
  if (r) {
    db.prepare('UPDATE brand_project_links SET market=?, category=?, relation=?, competitor_ref=? WHERE link_id=?')
      .run(input.market != null ? input.market : r.market, input.category != null ? input.category : r.category,
        input.relation != null ? input.relation : r.relation, input.competitorRef || r.competitor_ref, r.link_id);
    return { linkId: r.link_id, existed: true };
  }
  const id = rid('bpl');
  db.prepare(`INSERT INTO brand_project_links (link_id, tenant_id, brand_id, project_id, market, category, relation, competitor_ref, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, tid, String(input.brandId || ''), String(input.projectId || ''),
      input.market || null, input.category || null, input.relation || null, input.competitorRef || null, now);
  return { linkId: id, existed: false };
}
function brandIdForCompetitor(tenantId, projectId, competitorId) {
  const r = getDb().prepare('SELECT brand_id FROM brand_project_links WHERE tenant_id=? AND project_id=? AND competitor_ref=?')
    .get(String(tenantId || ''), String(projectId || ''), String(competitorId || ''));
  return r ? r.brand_id : null;
}
function linksForBrand(tenantId, brandId) {
  return getDb().prepare('SELECT * FROM brand_project_links WHERE tenant_id=? AND brand_id=?')
    .all(String(tenantId || ''), String(brandId || ''))
    .map(r => ({ linkId: r.link_id, projectId: r.project_id, market: r.market, category: r.category, relation: r.relation, competitorRef: r.competitor_ref }));
}
// 单链接读取：品牌是否关联到指定项目（项目边界校验的唯一事实源）
function getLink(tenantId, brandId, projectId) {
  const r = getDb().prepare('SELECT * FROM brand_project_links WHERE tenant_id=? AND brand_id=? AND project_id=?')
    .get(String(tenantId || ''), String(brandId || ''), String(projectId || ''));
  return r ? { linkId: r.link_id, projectId: r.project_id, market: r.market, category: r.category, relation: r.relation, competitorRef: r.competitor_ref } : null;
}
// 项目视角的品牌列表：项目级字段（market/category/relation/competitor_ref）以链接为准，全局记录只兜底
function listBrandLinksForProject(tenantId, projectId) {
  return getDb().prepare(`SELECT b.*, l.link_id AS l_link_id, l.project_id AS l_project, l.market AS l_market, l.category AS l_category, l.relation AS l_relation, l.competitor_ref AS l_ref
      FROM brand_project_links l INNER JOIN brand_records b ON b.brand_id=l.brand_id AND b.tenant_id=l.tenant_id
      WHERE l.tenant_id=? AND l.project_id=? ORDER BY b.canonical_name ASC`)
    .all(String(tenantId || ''), String(projectId || ''))
    .map(r => ({
      brandId: r.brand_id, canonicalName: r.canonical_name, officialDomain: r.official_domain,
      market: r.l_market != null ? r.l_market : r.market,
      category: r.l_category != null ? r.l_category : r.category,
      relation: r.l_relation != null ? r.l_relation : r.relation,
      competitorRef: r.l_ref || r.competitor_ref,
      createdAt: r.created_at, updatedAt: r.updated_at, linkId: r.l_link_id, projectId: r.l_project,
    }));
}

// ---------------- Brand Timeline Index ----------------
// kind: price | product | promo | channel | voice | gap | monitor | correction | report
// nature: observed（Vantage 当时观察到）| backfilled（后续补入的历史）|
//         computed（按已有数据计算）| summarized（根据公开内容归纳）| corrected（用户纠错与更正）
const TIMELINE_KINDS = Object.freeze(['price', 'product', 'promo', 'channel', 'voice', 'gap', 'monitor', 'correction', 'report']);
const TIMELINE_NATURES = Object.freeze(['observed', 'backfilled', 'computed', 'summarized', 'corrected']);

function appendTimeline(input) {
  const db = getDb();
  const tid = String(input.tenantId || '');
  if (!tid || !input.brandId) throw new Error('brand-store: tenantId/brandId required');
  // 幂等：(tenant, brand, kind, at, ref_id) 唯一——重放不产生重复索引
  const dup = db.prepare('SELECT event_id FROM brand_timeline WHERE tenant_id=? AND brand_id=? AND kind=? AND at=? AND IFNULL(ref_id,\'\')=?')
    .get(tid, String(input.brandId), String(input.kind), String(input.at), String(input.refId || ''));
  if (dup) return { eventId: dup.event_id, deduped: true };
  const id = rid('bt');
  db.prepare(`INSERT INTO brand_timeline (event_id, tenant_id, brand_id, kind, at, nature, status, title, detail, ref_type, ref_id, payload, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, tid, String(input.brandId), String(input.kind), String(input.at),
      TIMELINE_NATURES.includes(input.nature) ? input.nature : 'observed',
      input.status || null, input.title || null, input.detail || null,
      input.refType || null, input.refId || null,
      input.payload ? JSON.stringify(input.payload) : null, nowIso());
  return { eventId: id, deduped: false };
}
function listTimeline(tenantId, brandId, opts) {
  const o = opts || {};
  const db = getDb();
  let sql = 'SELECT * FROM brand_timeline WHERE tenant_id=? AND brand_id=?';
  const args = [String(tenantId || ''), String(brandId || '')];
  if (o.kind) { sql += ' AND kind=?'; args.push(String(o.kind)); }
  if (o.nature) { sql += ' AND nature=?'; args.push(String(o.nature)); }
  if (o.from) { sql += ' AND at>=?'; args.push(String(o.from)); }
  if (o.to) { sql += ' AND at<=?'; args.push(String(o.to)); }
  sql += ' ORDER BY at DESC LIMIT ?';
  args.push(Math.max(1, Math.min(Number(o.limit) || 50, 200)));
  return db.prepare(sql).all(...args).map(r => ({
    eventId: r.event_id, kind: r.kind, at: r.at, nature: r.nature, status: r.status,
    title: r.title, detail: r.detail, refType: r.ref_type, refId: r.ref_id,
    payload: parseJson(r.payload),
  }));
}

// ---------------- Research Report ----------------
function createReport(input) {
  const db = getDb();
  const tid = String(input.tenantId || '');
  const id = rid('rp');
  const now = nowIso();
  db.prepare(`INSERT INTO reports (report_id, tenant_id, project_id, version, status, scope, markdown, fact_pack, coverage, gaps, opportunities, error_text, generated_by, created_at, updated_at, finished_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, tid, String(input.projectId || ''), Number(input.version) || 1, input.status || 'queued',
      JSON.stringify(input.scope || {}), input.markdown || null,
      input.factPack != null ? JSON.stringify(input.factPack) : null,
      input.coverage != null ? JSON.stringify(input.coverage) : null,
      input.gaps != null ? JSON.stringify(input.gaps) : null,
      input.opportunities != null ? JSON.stringify(input.opportunities) : null,
      input.errorText || null, input.generatedBy || null, now, now, input.finishedAt || null);
  return getReport(tid, id);
}
function updateReport(tenantId, reportId, patch) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM reports WHERE tenant_id=? AND report_id=?').get(String(tenantId || ''), String(reportId || ''));
  if (!cur) return null;
  const now = nowIso();
  db.prepare(`UPDATE reports SET status=?, markdown=?, fact_pack=?, coverage=?, gaps=?, opportunities=?, error_text=?, generated_by=?, updated_at=?, finished_at=?
    WHERE tenant_id=? AND report_id=?`)
    .run(patch.status || cur.status,
      patch.markdown != null ? patch.markdown : cur.markdown,
      patch.factPack != null ? JSON.stringify(patch.factPack) : cur.fact_pack,
      patch.coverage != null ? JSON.stringify(patch.coverage) : cur.coverage,
      patch.gaps != null ? JSON.stringify(patch.gaps) : cur.gaps,
      patch.opportunities != null ? JSON.stringify(patch.opportunities) : cur.opportunities,
      patch.errorText != null ? patch.errorText : cur.error_text,
      patch.generatedBy != null ? patch.generatedBy : cur.generated_by,
      now, patch.finishedAt || cur.finished_at,
      String(tenantId || ''), String(reportId || ''));
  return getReport(tenantId, reportId);
}
function getReport(tenantId, reportId) {
  const r = getDb().prepare('SELECT * FROM reports WHERE tenant_id=? AND report_id=?').get(String(tenantId || ''), String(reportId || ''));
  return r ? rowToReport(r) : null;
}
function listReports(tenantId, projectId) {
  const db = getDb();
  const rows = projectId
    ? db.prepare('SELECT * FROM reports WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC LIMIT 100').all(String(tenantId || ''), String(projectId))
    : db.prepare('SELECT * FROM reports WHERE tenant_id=? ORDER BY created_at DESC LIMIT 100').all(String(tenantId || ''));
  return rows.map(rowToReport);
}
function rowToReport(r) {
  return {
    reportId: r.report_id, projectId: r.project_id, version: r.version, status: r.status,
    scope: parseJson(r.scope) || {}, markdown: r.markdown,
    factPack: parseJson(r.fact_pack), coverage: parseJson(r.coverage),
    gaps: parseJson(r.gaps), opportunities: parseJson(r.opportunities),
    errorText: r.error_text, generatedBy: r.generated_by,
    createdAt: r.created_at, updatedAt: r.updated_at, finishedAt: r.finished_at,
  };
}

function addCitation(input) {
  const db = getDb();
  const id = rid('rc');
  db.prepare(`INSERT INTO report_citations (citation_id, report_id, tenant_id, section, fact_id, label, evidence_ids, snapshot_ids, source_url, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, String(input.reportId || ''), String(input.tenantId || ''), input.section || null,
      input.factId || null, input.label || null,
      JSON.stringify(input.evidenceIds || []), JSON.stringify(input.snapshotIds || []),
      input.sourceUrl || null, nowIso());
  return id;
}
function listCitations(tenantId, reportId) {
  return getDb().prepare('SELECT * FROM report_citations WHERE tenant_id=? AND report_id=? ORDER BY created_at ASC')
    .all(String(tenantId || ''), String(reportId || ''))
    .map(r => ({
      citationId: r.citation_id, section: r.section, factId: r.fact_id, label: r.label,
      evidenceIds: parseJson(r.evidence_ids) || [], snapshotIds: parseJson(r.snapshot_ids) || [],
      sourceUrl: r.source_url || null,
    }));
}

// ---------------- Report Job（持久生成任务：租约/心跳/reclaim） ----------------
const REPORT_JOB_TTL_MS = Number(process.env.ZB_REPORT_CLAIM_TTL_MS) || 60000;
function enqueueReportJob(input) {
  const db = getDb();
  const id = rid('rj');
  db.prepare(`INSERT INTO report_jobs (job_id, tenant_id, report_id, status, retry, attempts, created_at)
    VALUES (?,?,?, 'pending', 0, 0, ?)`)
    .run(id, String(input.tenantId || ''), String(input.reportId || ''), nowIso());
  return { jobId: id };
}
function claimReportJob(workerId) {
  const db = getDb();
  const token = 'rt_' + crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  const r = db.prepare(`UPDATE report_jobs SET status='running', claim_token=?, claim_expires_at=?, attempts=attempts+1
      WHERE job_id = (SELECT job_id FROM report_jobs
        WHERE status='pending' OR (status='running' AND claim_expires_at < ?)
        ORDER BY created_at ASC LIMIT 1)
      RETURNING job_id, tenant_id, report_id, claim_token, retry, attempts`)
    .get(token, now + REPORT_JOB_TTL_MS, now);
  return r ? { jobId: r.job_id, tenantId: r.tenant_id, reportId: r.report_id, claimToken: r.claim_token, retry: r.retry, attempts: r.attempts } : null;
}
function heartbeatReportJob(jobId, token) {
  return getDb().prepare('UPDATE report_jobs SET claim_expires_at=? WHERE job_id=? AND claim_token=? AND status=\'running\'')
    .run(Date.now() + REPORT_JOB_TTL_MS, String(jobId), String(token)).changes > 0;
}
function finishReportJob(jobId, token, status, errorText) {
  getDb().prepare('UPDATE report_jobs SET status=?, claim_token=NULL, claim_expires_at=NULL, last_error=?, done_at=? WHERE job_id=? AND claim_token=?')
    .run(String(status), errorText || null, nowIso(), String(jobId), String(token));
}
// 真实重试语义：异常后回 pending（可再次领取），retry 计数 +1；受 REPORT_JOB_MAX_RETRY 约束
function requeueReportJob(jobId, token, retry, errorText) {
  return getDb().prepare("UPDATE report_jobs SET status='pending', retry=?, claim_token=NULL, claim_expires_at=NULL, last_error=? WHERE job_id=? AND claim_token=? AND status='running'")
    .run(Number(retry) || 0, errorText || null, String(jobId), String(token)).changes > 0;
}
function reclaimExpiredReportJobs(nowMs) {
  const db = getDb();
  const now = nowMs || Date.now();
  const rows = db.prepare("SELECT * FROM report_jobs WHERE status='running' AND claim_expires_at < ?").all(now);
  for (const r of rows) {
    const next = Number(r.retry || 0) + 1;
    if (next > REPORT_JOB_MAX_RETRY) {
      db.prepare("UPDATE report_jobs SET status='dead', claim_token=NULL, claim_expires_at=NULL, last_error='lease expired (retry exhausted)', done_at=? WHERE job_id=?")
        .run(nowIso(), r.job_id);
      // 诚实终止：报告落 failed，不留永久 running
      updateReport(r.tenant_id, r.report_id, { status: 'failed', errorText: '生成任务超时且重试耗尽，请重新生成。', finishedAt: nowIso() });
    } else {
      db.prepare("UPDATE report_jobs SET status='pending', retry=?, claim_token=NULL, claim_expires_at=NULL WHERE job_id=?").run(next, r.job_id);
    }
  }
  return { requeued: rows.filter(r => Number(r.retry || 0) + 1 <= REPORT_JOB_MAX_RETRY).length, dead: rows.filter(r => Number(r.retry || 0) + 1 > REPORT_JOB_MAX_RETRY).length };
}
function listReportJobs(tenantId, status) {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM report_jobs WHERE tenant_id=? AND status=? ORDER BY created_at DESC LIMIT 50').all(String(tenantId || ''), String(status))
    : db.prepare('SELECT * FROM report_jobs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 50').all(String(tenantId || ''));
  return rows.map(r => ({ jobId: r.job_id, reportId: r.report_id, status: r.status, retry: r.retry, attempts: r.attempts, lastError: r.last_error }));
}

function parseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

module.exports = {
  SCHEMA_VERSION, TIMELINE_KINDS, TIMELINE_NATURES, REPORT_JOB_TTL_MS, REPORT_JOB_MAX_RETRY,
  getDb, closeDb, rid,
  upsertBrand, getBrand, listBrands,
  linkProject, brandIdForCompetitor, linksForBrand, getLink, listBrandLinksForProject,
  appendTimeline, listTimeline,
  createReport, updateReport, getReport, listReports, addCitation, listCitations,
  enqueueReportJob, claimReportJob, heartbeatReportJob, finishReportJob, requeueReportJob, reclaimExpiredReportJobs, listReportJobs,
};
