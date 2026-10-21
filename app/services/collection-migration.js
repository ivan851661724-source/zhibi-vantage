'use strict';
// ============================================================
// services/collection-migration.js —— 已有项目首轮采集一次性幂等迁移（SC-07 r3 整改）
// ------------------------------------------------------------
// 部署后由受控迁移命令（scripts/migration-collection-bootstrap.js）扫描现有项目，
// 逐项目按「品牌 × capability」缺口补齐首轮采集计划。
//
// r3 P0-1 整改（合并前阻断项）：
//   ① 记录必须带租约时间（rowToRecord.leaseExpiresAt）——避免「已过期但被当作执行中」；
//   ② 认领必须是**原子 CAS**：
//        · 无记录 → INSERT（主键冲突 = 竞争失败，不进 bootstrapProject）；
//        · running 且租约未过期 → 禁止认领；
//        · failed / 租约过期 → 带「旧状态 + 旧租约」条件的 UPDATE 认领，
//          changes!==1 即竞争失败。两个进程同时执行只有一个能进入 bootstrapProject。
//   ③ --dry-run **完全只读**：不创建/更新 collection_migrations，不产生 attempt / job /
//      plan log；dry-run 后立即正式执行仍能正常迁移。
//   ④ 删除「项目有任意 attempt 就整体跳过」——该判断会把「一个品牌采过」当成
//      「整个项目都采过」，导致 15 个品牌里只补了 1 个。
//   ⑤ 缺口按品牌 × capability 判断：已有终态（success/partial/failed）的能力复用，
//      缺失能力继续进入计划；一个品牌的官网 attempt 不影响其他品牌与评论/商品维度。
//   ⑥ 只有项目内**所有符合范围（研究完成）的品牌**都完成计划决策，才标记 done；
//      被上限截断时标记 failed（brands_remaining），下次执行继续补齐。
//   ⑦ 中途异常保留 failed，可重复执行，未完成部分由既有幂等链路继续。
//
// 状态语义：
//   done      全部品牌决策完成（幂等屏障，重复执行直接跳过）
//   running   执行中（lease_expires_at 未过期时其他执行者禁止认领）
//   failed    未完成/异常（可重复执行继续；已入队部分由既有幂等去重）
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

// r3 P0-1①：租约时间必须随记录返回（旧实现漏了 leaseExpiresAt，
// 导致「running 且租约过期」被误判为仍在执行，永远无法回收）。
function rowToRecord(r) {
  if (!r) return null;
  return {
    migrationId: r.migration_id, tenantId: r.tenant_id, projectId: r.project_id,
    status: r.status, reason: r.reason || null, runId: r.run_id || null,
    counts: r.counts ? JSON.parse(r.counts) : null,
    startedAt: r.started_at || null, finishedAt: r.finished_at || null,
    leaseExpiresAt: r.lease_expires_at == null ? null : Number(r.lease_expires_at),
  };
}

function getRecord(tenantId, projectId, opts) {
  const o = opts || {};
  // r4 §三：只读路径——dry-run 不得为了查询而建表。表不存在 → 视为「无迁移记录」。
  if (o.readOnly && !_tableReady) {
    const exists = SurfaceStore.getDb().prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='collection_migrations'"
    ).get();
    if (!exists) return null;
  } else {
    ensureTable();
  }
  return rowToRecord(SurfaceStore.getDb().prepare(
    'SELECT * FROM collection_migrations WHERE migration_id=? AND tenant_id=? AND project_id=?'
  ).get(MIGRATION_ID, String(tenantId || ''), String(projectId || '')));
}

function listRecords() {
  ensureTable();
  return SurfaceStore.getDb().prepare(
    'SELECT * FROM collection_migrations WHERE migration_id=? ORDER BY started_at DESC LIMIT 500'
  ).all(MIGRATION_ID).map(rowToRecord);
}

function jobCounts() {
  // r4 §三：dry-run 只读路径可能遇到尚未建表的全新目录——容错为全零，不建表。
  try {
    const exists = SurfaceStore.getDb().prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='collection_jobs'"
    ).get();
    if (!exists) return { total: 0, byStatus: {} };
  } catch (e) { return { total: 0, byStatus: {} }; }
  const db = require('./collect-jobs.js').getDb();
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM collection_jobs GROUP BY status').all();
  const out = { total: 0, byStatus: {} };
  for (const r of rows) { out.byStatus[r.status] = r.n; out.total += r.n; }
  return out;
}

/**
 * 原子 CAS 认领（r3 P0-1②）。
 * @returns {{claimed:boolean, reason?:string, runId?:string}}
 */
function claimLease(tenantId, projectId, opts) {
  ensureTable();
  const o = opts || {};
  const db = SurfaceStore.getDb();
  const now = o.nowMs || Date.now();
  const runId = o.runId || ('mig_' + now.toString(36) + '_' + Math.random().toString(36).slice(2, 8) + '_' + process.pid);
  const tid = String(tenantId || ''); const pid = String(projectId || '');
  const nowIso = new Date(now).toISOString();
  const rec = getRecord(tid, pid);
  if (!rec) {
    try {
      db.prepare(`INSERT INTO collection_migrations
        (migration_id, tenant_id, project_id, status, run_id, started_at, lease_expires_at)
        VALUES (?,?,?,?,?,?,?)`)
        .run(MIGRATION_ID, tid, pid, 'running', runId, nowIso, now + LEASE_MS);
      return { claimed: true, runId, phase: 'insert' };
    } catch (e) {
      // 主键冲突 = 另一执行者已先插入并认领
      return { claimed: false, reason: 'race_insert_conflict' };
    }
  }
  if (rec.status === 'done') return { claimed: false, reason: 'already_done' };
  if (rec.status === 'running' && rec.leaseExpiresAt != null && rec.leaseExpiresAt > now) {
    return { claimed: false, reason: 'running_elsewhere' };
  }
  // CAS：条件必须精确匹配读到的旧状态与旧租约；changes!==1 → 竞争失败（别人先改了）
  const r = db.prepare(`UPDATE collection_migrations
      SET status='running', reason=NULL, run_id=?, started_at=?, finished_at=NULL, lease_expires_at=?
      WHERE migration_id=? AND tenant_id=? AND project_id=? AND status=? AND lease_expires_at IS ?`)
    .run(runId, nowIso, now + LEASE_MS, MIGRATION_ID, tid, pid, rec.status, rec.leaseExpiresAt);
  if (!r || r.changes !== 1) return { claimed: false, reason: 'cas_lost' };
  return { claimed: true, runId, phase: 'cas', previousStatus: rec.status };
}

// r4 §二：release 必须校验租约所有权（migration_id + tenant_id + project_id +
// status='running' + run_id=<claim 的 runId>），changes!==1 → fenced 抛错，不静默成功。
// 防「租约过期被回收、旧执行器迟到覆盖新执行器状态」。
function assertLeaseUpdate(r, tenantId, projectId, runId, action) {
  if (!r || r.changes !== 1) {
    const err = new Error('MIGRATION_LEASE_FENCED: ' + action + ' rejected (tenant=' + tenantId + ' project=' + projectId + ' runId=' + runId + ' 不再持有租约)');
    err.fenced = true;
    err.action = action;
    throw err;
  }
}

function releaseDone(tenantId, projectId, { runId, counts, reason }) {
  const r = SurfaceStore.getDb().prepare(`UPDATE collection_migrations
      SET status='done', reason=?, run_id=?, counts=?, finished_at=?, lease_expires_at=NULL
      WHERE migration_id=? AND tenant_id=? AND project_id=? AND status='running' AND run_id=?`)
    .run(reason || null, runId || null, JSON.stringify(counts || {}), new Date().toISOString(), MIGRATION_ID, String(tenantId || ''), String(projectId || ''), runId || '');
  assertLeaseUpdate(r, tenantId, projectId, runId, 'releaseDone');
  return { ok: true };
}

function releaseFailed(tenantId, projectId, { runId, reason, counts }) {
  const r = SurfaceStore.getDb().prepare(`UPDATE collection_migrations
      SET status='failed', reason=?, counts=COALESCE(?, counts), finished_at=?, lease_expires_at=NULL
      WHERE migration_id=? AND tenant_id=? AND project_id=? AND status='running' AND run_id=?`)
    .run(reason || 'failed', counts ? JSON.stringify(counts) : null, new Date().toISOString(), MIGRATION_ID, String(tenantId || ''), String(projectId || ''), runId || '');
  assertLeaseUpdate(r, tenantId, projectId, runId, 'releaseFailed');
  return { ok: true };
}

// 模块内互斥（单进程双调用防线；跨进程由 CAS 租约保护）
let _inRun = false;

/**
 * 执行迁移（幂等，可重复调用；dryRun 完全只读）。
 * @param {object} opts {maxProjects=50, perProjectLimit=50, maxReviewsPerProject=5,
 *                       maxReviewsTotal=25, dryRun=false, nowMs}
 */
function runMigration(opts) {
  const o = opts || {};
  const dryRun = !!o.dryRun;
  if (_inRun && !dryRun) return { ok: false, error: 'MIGRATION_ALREADY_RUNNING', reason: '同一进程已有迁移在执行（并发上限 1）' };
  // r4 §三：dry-run 完全只读——连 collection_migrations 的建表都不允许。
  if (!dryRun) ensureTable();
  const Db = require('./db.js');
  const Plan = require('./collection-plan.js');
  const now = o.nowMs || Date.now();
  const maxProjects = Math.max(1, Math.min(Number(o.maxProjects) || 50, 500));
  const perProjectLimit = Math.max(1, Math.min(Number(o.perProjectLimit) || 50, 200));
  const maxReviewsPerProject = Math.max(0, Math.min(Number.isFinite(Number(o.maxReviewsPerProject)) ? Number(o.maxReviewsPerProject) : 5, 50));
  const maxReviewsTotal = Math.max(0, Math.min(Number.isFinite(Number(o.maxReviewsTotal)) ? Number(o.maxReviewsTotal) : 25, 200));

  if (!dryRun) _inRun = true;
  try {
    const projects = (Db.listAllProjects() || []);
    const knownProjects = new Set(projects.map(p => p.tenantId + '\u0000' + p.id));
    const out = {
      ok: true, dryRun,
      scanned: 0, migrated: 0, skippedDone: 0, skippedRunning: 0, casLost: 0,
      planned: 0, failed: 0, fenced: 0, missingProjectReleased: 0,
      budget: { maxProjects, perProjectLimit, maxReviewsPerProject, maxReviewsTotal, reviewsUsed: 0 },
      perProject: [],
    };
    // r4 §四：删除项目安全跳过——迁移记录指向已不存在的项目时不留 running：
    // running 且租约已过期的孤儿记录直接落 failed('project_missing')，可重复执行幂等。
    if (!dryRun) {
      const orphanCond = `WHERE migration_id=? AND status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?`;
      const orphans = SurfaceStore.getDb().prepare(
        'SELECT tenant_id, project_id FROM collection_migrations ' + orphanCond
      ).all(MIGRATION_ID, now);
      for (const orp of orphans) {
        if (!knownProjects.has(orp.tenant_id + '\u0000' + orp.project_id)) {
          SurfaceStore.getDb().prepare(
            `UPDATE collection_migrations SET status='failed', reason='project_missing', finished_at=?, lease_expires_at=NULL
             WHERE migration_id=? AND tenant_id=? AND project_id=? AND status='running'`
          ).run(new Date().toISOString(), MIGRATION_ID, orp.tenant_id, orp.project_id);
          out.missingProjectReleased++;
        }
      }
    }
    for (const p of projects) {
      if (out.scanned >= maxProjects) break;
      const tid = p.tenantId, pid = p.id;
      if (!tid || !pid) continue;
      out.scanned++;

      // r4 §三：dry-run 用只读查记录（表不存在视为无迁移记录，不建表）
      const rec = getRecord(tid, pid, { readOnly: dryRun });
      if (rec && rec.status === 'done') {
        out.skippedDone++;
        out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'already_done' });
        continue;
      }
      if (rec && rec.status === 'running' && rec.leaseExpiresAt != null && rec.leaseExpiresAt > now) {
        out.skippedRunning++;
        out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'running_elsewhere', leaseExpiresAt: rec.leaseExpiresAt });
        continue;
      }

      if (dryRun) {
        // r3 P0-1③ / r4 §三：只读——不认领、不写任何表（bootstrapProject 内部 dryRun 也不写）
        let summary = null;
        try {
          summary = Plan.bootstrapProject({
            tenantId: tid, projectId: pid, limit: perProjectLimit,
            maxReviews: Math.min(maxReviewsPerProject, maxReviewsTotal - out.budget.reviewsUsed),
            dryRun: true, trigger: 'schedule', skipTerminal: true,
          });
        } catch (e) { summary = null; }
        out.planned++;
        out.perProject.push({
          tenantId: tid, projectId: pid, outcome: 'planned',
          brands: summary && summary.brands, counts: summary && summary.counts,
          pending: summary && summary.pendingCompetitorIds,
        });
        continue;
      }

      const claim = claimLease(tid, pid, { nowMs: now });
      if (!claim.claimed) {
        if (claim.reason === 'already_done') out.skippedDone++;
        else if (claim.reason === 'running_elsewhere') out.skippedRunning++;
        else out.casLost++;
        out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'not_claimed:' + claim.reason });
        continue;
      }

      // r4 §二：release 只认 claim.runId（租约身份），禁止以 summary.runId 替代。
      // fenced（旧执行器迟到）不计 migrated/failed，不覆盖新执行器状态。
      let summary = null;
      try {
        summary = Plan.bootstrapProject({
          tenantId: tid, projectId: pid, limit: perProjectLimit,
          maxReviews: Math.min(maxReviewsPerProject, maxReviewsTotal - out.budget.reviewsUsed),
          dryRun: false, trigger: 'schedule', skipTerminal: true,
        });
      } catch (e) {
        try {
          releaseFailed(tid, pid, { runId: claim.runId, reason: 'exception:' + String((e && e.message) || e).slice(0, 120) });
          out.failed++;
          out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'failed', reason: String((e && e.message) || e).slice(0, 120) });
        } catch (e2) {
          if (e2 && e2.fenced) { out.fenced++; out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'fenced_release', action: e2.action }); }
          else throw e2;
        }
        continue;
      }
      if (!summary || !summary.ok) {
        try {
          releaseFailed(tid, pid, { runId: claim.runId, reason: 'bootstrap_not_ok' });
          out.failed++;
          out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'failed', reason: 'bootstrap_not_ok' });
        } catch (e2) {
          if (e2 && e2.fenced) { out.fenced++; out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'fenced_release', action: e2.action }); }
          else throw e2;
        }
        continue;
      }
      out.budget.reviewsUsed += (summary.budget && summary.budget.reviewsUsed) || 0;
      // r3 P0-1⑥：只有全部符合范围品牌都完成决策才算 done；被截断/有失败 → failed 可续跑
      const complete = !!summary.complete;
      if (complete) {
        try {
          releaseDone(tid, pid, { runId: claim.runId, counts: summary.counts, reason: null });
          out.migrated++;
          out.perProject.push({
            tenantId: tid, projectId: pid, outcome: 'migrated', runId: claim.runId,
            brands: summary.brands, counts: summary.counts,
          });
        } catch (e2) {
          if (e2 && e2.fenced) { out.fenced++; out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'fenced_release', action: e2.action }); }
          else throw e2;
        }
      } else {
        const reason = summary.pendingCompetitorIds && summary.pendingCompetitorIds.length
          ? 'brands_remaining:' + summary.pendingCompetitorIds.length
          : 'brand_failures';
        try {
          releaseFailed(tid, pid, { runId: claim.runId, reason, counts: summary.counts });
          out.failed++;
          out.perProject.push({
            tenantId: tid, projectId: pid, outcome: 'incomplete', reason,
            brands: summary.brands, counts: summary.counts, pending: summary.pendingCompetitorIds,
          });
        } catch (e2) {
          if (e2 && e2.fenced) { out.fenced++; out.perProject.push({ tenantId: tid, projectId: pid, outcome: 'fenced_release', action: e2.action }); }
          else throw e2;
        }
      }
    }
    out.jobCountsAfter = jobCounts();
    return out;
  } finally {
    if (!dryRun) _inRun = false;
  }
}

module.exports = {
  MIGRATION_ID, LEASE_MS,
  runMigration, claimLease, releaseDone, releaseFailed,
  getRecord, listRecords, jobCounts,
};
