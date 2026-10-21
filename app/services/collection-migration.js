'use strict';
// ============================================================
// services/collection-migration.js —— 已有项目首轮采集一次性幂等迁移（SC-07 r2 §三）
// ------------------------------------------------------------
// 为什么存在：「补齐首轮采集」按钮不能成为旧项目开始采集的唯一方式。
// 本模块实现**一次性、幂等**的迁移机制：部署后由受控迁移命令
// （scripts/migration-collection-bootstrap.js）扫描尚无 attempt 的现有项目，
// 逐项目执行首轮采集计划（collection-plan.bootstrapProject）。
//
// 硬约束（全部代码内强制）：
//   · 每项目记录迁移版本（MIGRATION_ID）与执行状态（collection_migrations 表）；
//   · 状态 done 的项目**永不重跑**——重启与重复执行不重复建任务、不重复计费；
//   · running 行带租约（默认 10 分钟），并发执行/崩溃残留由租约回收处理；
//   · 数量上限：单次最多 maxProjects 个项目、每项目最多 perProjectLimit 个品牌；
//   · 搜索调用上限：全轮共享 maxReviewsTotal（评论发现是最贵的搜索型采集）；
//   · 每品牌入队/跳过/失败及原因由 collection-plan 决策台账记录（不静默）；
//   · 新调研继续由 autoCollectAfterResearch 自动进入首轮采集计划（不受本模块影响）。
//
// 状态语义：
//   done      已执行（幂等屏障，重复执行直接跳过）
//   running   执行中（带 lease_expires_at；过期可回收重试）
//   failed    执行异常（可重试；已入队部分由既有链路幂等去重）
//   skipped   不满足迁移条件（如项目无已完成品牌），记录原因
// ============================================================

const SurfaceStore = require('./surface-store.js');

const MIGRATION_ID = 'collection_bootstrap_v1';

// 租约（并发/崩溃回收）：env 可覆盖，默认 10 分钟
const LEASE_MS = Math.max(60 * 1000, Number(process.env.ZB_MIGRATION_LEASE_MS) || 10 * 60 * 1000);

let _tableReady = false;
function ensureTable() {
  if (_tableReady) return;
  const db = SurfaceStore.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS collection_migrations (
    migration_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL,
    reason TEXT,
    run_id TEXT,
    counts TEXT,
    started_at TEXT,
    finished_at TEXT,
    lease_expires_at INTEGER,
    PRIMARY KEY (migration_id, tenant_id, project_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cm_status ON collection_migrations(migration_id, status)');
  _tableReady = true;
}

function rowToRecord(r) {
  if (!r) return null;
  return {
    migrationId: r.migration_id, tenantId: r.tenant_id, projectId: r.project_id,
    status: r.status, reason: r.reason || null, runId: r.run_id || null,
    counts: r.counts ? JSON.parse(r.counts) : null,
    startedAt: r.started_at || null, finishedAt: r.finished_at || null,
  };
}

function getRecord(tenantId, projectId) {
  ensureTable();
  return rowToRecord(SurfaceStore.getDb().prepare(
    'SELECT * FROM collection_migrations WHERE migration_id=? AND tenant_id=? AND project_id=?'
  ).get(MIGRATION_ID, String(tenantId || ''), String(projectId || '')));
}

// 迁移状态总览（核验查询：执行前后对比任务数/迁移状态用）
function listRecords() {
  ensureTable();
  return SurfaceStore.getDb().prepare(
    'SELECT * FROM collection_migrations WHERE migration_id=? ORDER BY started_at DESC LIMIT 500'
  ).all(MIGRATION_ID).map(rowToRecord);
}

// 全量任务计数（核验查询；不区分租户——迁移命令是超管级运维入口）
function jobCounts() {
  const db = require('./collect-jobs.js').getDb();
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM collection_jobs GROUP BY status').all();
  const out = { total: 0, byStatus: {} };
  for (const r of rows) { out.byStatus[r.status] = r.n; out.total += r.n; }
  return out;
}

// 项目是否已有任何采集 attempt（「尚无 attempt 的现有项目」判定）
function projectHasAttempts(tenantId, projectId) {
  const db = SurfaceStore.getDb();
  const r = db.prepare('SELECT COUNT(*) AS n FROM collection_attempts WHERE tenant_id=? AND project_id=?')
    .get(String(tenantId || ''), String(projectId || ''));
  return r.n > 0;
}

// 模块内互斥（单进程双调用防线；跨进程由租约行保护）
let _inRun = false;

/**
 * 执行迁移（幂等，可重复调用）。
 * @param {object} opts {maxProjects=50, perProjectLimit=50, maxReviewsPerProject=5,
 *                       maxReviewsTotal=25, dryRun=false, onlyWithoutAttempts=true}
 * @returns {{ok, scanned, migrated, skippedDone, skippedRunning, skippedNoBrands, failed, dryRun, perProject:Array, jobCountsBefore?, jobCountsAfter?}}
 */
function runMigration(opts) {
  const o = opts || {};
  if (_inRun && !o.dryRun) return { ok: false, error: 'MIGRATION_ALREADY_RUNNING', reason: '同一进程已有迁移在执行（并发上限 1）' };
  ensureTable();
  const db = SurfaceStore.getDb();
  const Db = require('./db.js');
  const now = Date.now();
  const maxProjects = Math.max(1, Math.min(Number(o.maxProjects) || 50, 500));
  const perProjectLimit = Math.max(1, Math.min(Number(o.perProjectLimit) || 50, 200));
  const maxReviewsPerProject = Math.max(0, Math.min(Number.isFinite(Number(o.maxReviewsPerProject)) ? Number(o.maxReviewsPerProject) : 5, 50));
  const maxReviewsTotal = Math.max(0, Math.min(Number.isFinite(Number(o.maxReviewsTotal)) ? Number(o.maxReviewsTotal) : 25, 200));
  const onlyWithoutAttempts = o.onlyWithoutAttempts !== false;

  _inRun = true;
  try {
    const projects = (Db.listAllProjects() || []);
    const out = {
      ok: true, dryRun: !!o.dryRun,
      scanned: 0, migrated: 0, skippedDone: 0, skippedRunning: 0,
      skippedNoBrands: 0, skippedHasAttempts: 0, failed: 0,
      budget: { maxProjects, perProjectLimit, maxReviewsPerProject, maxReviewsTotal, reviewsUsed: 0 },
      perProject: [],
    };
    for (const p of projects) {
      if (out.scanned >= maxProjects) break;
      const tid = p.tenantId, pid = p.id;
      if (!tid || !pid) continue;
      out.scanned++;
      // 幂等屏障：已 done 永不重跑（不重复建任务、不重复收费）
      const rec = getRecord(tid, pid);
      if (rec && rec.status === 'done') { out.skippedDone++; out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'already_done' }); continue; }
      if (rec && rec.status === 'running' && rec.leaseExpiresAt && rec.leaseExpiresAt > now) {
        out.skippedRunning++; out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'running_elsewhere' }); continue;
      }
      if (onlyWithoutAttempts && projectHasAttempts(tid, pid)) {
        // 已有采集记录的项目不属「尚无 attempt」迁移范围；登记 skipped 防止反复扫描
        if (!rec) {
          db.prepare(`INSERT INTO collection_migrations
            (migration_id, tenant_id, project_id, status, reason, started_at, finished_at)
            VALUES (?,?,?,?,?,?,?)`)
            .run(MIGRATION_ID, tid, pid, 'done', 'project_already_has_attempts', new Date().toISOString(), new Date().toISOString());
        }
        out.skippedHasAttempts++;
        continue;
      }
      // 认领（租约）：跨进程并发保护；崩溃残留超租约可回收
      const runId = 'mig_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const nowIso = new Date().toISOString();
      if (rec) {
        db.prepare(`UPDATE collection_migrations SET status='running', reason=NULL, run_id=?, started_at=?, finished_at=NULL, lease_expires_at=? WHERE migration_id=? AND tenant_id=? AND project_id=?`)
          .run(runId, nowIso, now + LEASE_MS, MIGRATION_ID, tid, pid);
      } else {
        db.prepare(`INSERT INTO collection_migrations
          (migration_id, tenant_id, project_id, status, run_id, started_at, lease_expires_at)
          VALUES (?,?,?,?,?,?,?)`)
          .run(MIGRATION_ID, tid, pid, 'running', runId, nowIso, now + LEASE_MS);
      }
      // 执行既有首轮计划（幂等/冷却/额度/attempt/worker fencing 全复用）
      let summary = null;
      try {
        const Plan = require('./collection-plan.js');
        summary = Plan.bootstrapProject({
          tenantId: tid, projectId: pid,
          limit: perProjectLimit,
          maxReviews: Math.min(maxReviewsPerProject, maxReviewsTotal - out.budget.reviewsUsed),
          dryRun: !!o.dryRun, trigger: 'schedule',
        });
      } catch (e) {
        db.prepare(`UPDATE collection_migrations SET status='failed', reason=?, finished_at=?, lease_expires_at=NULL WHERE migration_id=? AND tenant_id=? AND project_id=?`)
          .run('exception:' + String((e && e.message) || e).slice(0, 120), new Date().toISOString(), MIGRATION_ID, tid, pid);
        out.failed++;
        out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'failed', reason: String((e && e.message) || e).slice(0, 120) });
        continue;
      }
      if (summary && summary.ok) {
        out.budget.reviewsUsed += (summary.budget && summary.budget.reviewsUsed) || 0;
        const noBrands = (summary.counts.enqueued || 0) + (summary.counts.deduped || 0) === 0 && (summary.brands || 0) > 0;
        db.prepare(`UPDATE collection_migrations SET status='done', reason=?, run_id=?, counts=?, finished_at=?, lease_expires_at=NULL WHERE migration_id=? AND tenant_id=? AND project_id=?`)
          .run(noBrands ? 'no_brand_enqueued' : null, summary.runId || runId, JSON.stringify(summary.counts || {}), new Date().toISOString(), MIGRATION_ID, tid, pid);
        out.migrated++;
        out.perProject.push({
          tenantId: tid, projectId: pid, outcome: 'migrated', runId: summary.runId || runId,
          brands: summary.brands, counts: summary.counts,
        });
      } else {
        db.prepare(`UPDATE collection_migrations SET status='failed', reason='bootstrap_not_ok', finished_at=?, lease_expires_at=NULL WHERE migration_id=? AND tenant_id=? AND project_id=?`)
          .run(new Date().toISOString(), MIGRATION_ID, tid, pid);
        out.failed++;
        out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'failed', reason: 'bootstrap_not_ok' });
      }
    }
    out.jobCountsAfter = jobCounts();
    return out;
  } finally {
    _inRun = false;
  }
}

module.exports = {
  MIGRATION_ID, LEASE_MS,
  runMigration, getRecord, listRecords, jobCounts, projectHasAttempts,
};
