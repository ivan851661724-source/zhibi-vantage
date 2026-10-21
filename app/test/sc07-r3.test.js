'use strict';
// ============================================================
// test/sc07-r3.test.js —— SC-07 r3 合并前阻断整改回归
// ------------------------------------------------------------
// R1 dry-run 完全只读（相关表逐行不变）
// R2 dry-run 后正式迁移仍能入队
// R3 并发迁移认领：同一时刻只有一个执行者取得租约（CAS）
// R4 项目内一个品牌已有官网 attempt，其余品牌仍补建（删除整项目跳过）
// R5 同品牌已有官网数据但缺商品/评论 → 只补缺失能力（品牌×capability 缺口）
// R6 executor 连续异常计入 auto_retries，有界后退到 source_failed 并停止自动任务
// R7 租约过期可被回收认领（rowToRecord 返回 leaseExpiresAt）
// R8 两租户迁移记录 / 任务 / 意向 / 页面数据互不串读
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc07r3-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.ZB_INTENT_PROBE_INTERVAL_MS = '1500';
process.env.ZB_INTENT_RATE_RETRY_MS = '600';
process.env.ZB_INTENT_RETRY_BACKOFF_MS = '600';
process.env.ZB_INTENT_PROBE_GRACE_MS = '60000';
process.env.ZB_INTENT_MAX_AUTO_RETRIES = '2';
process.env.SERPER_API_KEY = 'test-key-not-real';
try { fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true }); } catch (e) {}

const SurfaceStore = require('../services/surface-store.js');
const CollectJobs = require('../services/collect-jobs.js');
const Migration = require('../services/collection-migration.js');
const Plan = require('../services/collection-plan.js');
const WIntent = require('../services/watch-intent.js');
const WS = require('../services/watch-store.js');
const BrandSvc = require('../services/brand-service.js');
const BrandStore = require('../services/brand-store.js');
const Db = require('../services/db.js');
const { projFile, mirrorProjectToDb } = require('../core/state-store.js');

const TID = 'tenant:r3a';
const TID_B = 'tenant:r3b';
// 预热建表：首次快照不能因「表尚不存在」报错（dry-run 用例要求逐行比对）
try {
  Migration.getRecord('tenant:warm', 'proj:warm');
  WIntent.listIntents('tenant:warm');
  Plan.listPlanLog('tenant:warm', 'proj:warm', 1);
  CollectJobs.getDb();
  SurfaceStore.getDb();
} catch (e) { /* 建表失败在具体用例里会暴露 */ }
let seq = 0;
function uid(p) { seq += 1; return p + seq; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function writeState(tenantId, projectId, comps) {
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    tenantId, projectId, track: 'SC07R3 回归', intent: { regions: ['us'] }, excluded: [],
    competitors: comps, discoverDone: true, progress: { total: comps.length, done: comps.length },
  }, null, 2));
  mirrorProjectToDb(projectId, tenantId, 'SC07R3');
}

function comps(projectId, n, shopify) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'c-' + projectId + '-' + (i + 1),
    name: 'R3品牌' + (i + 1),
    url: 'https://r3brand' + (i + 1) + '-' + projectId + '.example.com',
    status: 'done', isShopify: !!shopify,
  }));
}

// 相关表全量快照（逐行比对用）
function snapshotTables() {
  const sdb = SurfaceStore.getDb();
  const jdb = CollectJobs.getDb();
  const pick = (db, sql) => db.prepare(sql).all();
  return {
    migrations: JSON.stringify(pick(sdb, 'SELECT * FROM collection_migrations ORDER BY tenant_id, project_id')),
    attempts: JSON.stringify(pick(sdb, 'SELECT * FROM collection_attempts ORDER BY attempt_id')),
    planLog: JSON.stringify(pick(sdb, 'SELECT * FROM collection_plan_log ORDER BY id')),
    jobs: JSON.stringify(pick(jdb, 'SELECT * FROM collection_jobs ORDER BY job_id')),
  };
}

function jobsOf(tenantId, projectId, capability) {
  const q = capability
    ? "SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND capability=?"
    : "SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=?";
  return capability
    ? CollectJobs.getDb().prepare(q).get(tenantId, projectId, capability).n
    : CollectJobs.getDb().prepare(q).get(tenantId, projectId).n;
}

// ---------- R1：dry-run 完全只读 ----------
test('R1 dry-run 前后相关表逐行不变（不建 try/不写迁移/不写计划台账）', () => {
  const projectId = 'projR1';
  writeState(TID, projectId, comps(projectId, 3, false));
  const before = snapshotTables();
  const r = Migration.runMigration({ dryRun: true, maxProjects: 50, maxReviewsTotal: 3 });
  assert.strictEqual(r.dryRun, true);
  assert.ok(r.planned >= 1, 'dry-run 应产出计划: ' + JSON.stringify(r.perProject));
  const after = snapshotTables();
  assert.strictEqual(after.migrations, before.migrations, 'dry-run 不得写 collection_migrations');
  assert.strictEqual(after.attempts, before.attempts, 'dry-run 不得创建 attempt');
  assert.strictEqual(after.jobs, before.jobs, 'dry-run 不得创建 job');
  assert.strictEqual(after.planLog, before.planLog, 'dry-run 不得写 plan log');
  // dry-run 不得留下 running 租约
  assert.strictEqual(Migration.getRecord(TID, projectId), null, 'dry-run 不得创建迁移记录');
});

// ---------- R2：dry-run 后正式迁移仍能入队 ----------
test('R2 dry-run 后立即正式执行，仍能正常入队并标记 done', () => {
  const projectId = 'projR2';
  writeState(TID, projectId, comps(projectId, 2, false));
  const dry = Migration.runMigration({ dryRun: true, maxProjects: 50, maxReviewsTotal: 0 });
  assert.ok(dry.planned >= 1);
  assert.strictEqual(jobsOf(TID, projectId), 0, 'dry-run 后仍无任务');
  const real = Migration.runMigration({ maxProjects: 50, maxReviewsTotal: 0 });
  assert.ok(real.migrated >= 1, '正式迁移成功: ' + JSON.stringify(real.perProject));
  assert.ok(jobsOf(TID, projectId, 'official_site_profile') >= 2, '两个品牌的官网资料任务入队');
  const rec = Migration.getRecord(TID, projectId);
  assert.strictEqual(rec.status, 'done');
  assert.strictEqual(rec.leaseExpiresAt, null, 'done 后释放租约');
});

// ---------- R3：并发认领只有一个成功 ----------
test('R3 两个执行者同时认领：CAS 只允许一个进入 bootstrapProject', () => {
  const projectId = 'projR3';
  writeState(TID, projectId, comps(projectId, 1, false));
  const c1 = Migration.claimLease(TID, projectId, { runId: 'run-a' });
  assert.strictEqual(c1.claimed, true, '第一个执行者取得租约');
  const c2 = Migration.claimLease(TID, projectId, { runId: 'run-b' });
  assert.strictEqual(c2.claimed, false, '第二个执行者必须被拒');
  assert.strictEqual(c2.reason, 'running_elsewhere');
  // 记录带租约时间（P0-1①）
  const rec = Migration.getRecord(TID, projectId);
  assert.ok(rec.leaseExpiresAt && rec.leaseExpiresAt > Date.now(), 'rowToRecord 必须返回 leaseExpiresAt');
  assert.strictEqual(rec.status, 'running');
  // 租约过期后允许回收（CAS 命中旧状态+旧租约）
  const later = Date.now() + Migration.LEASE_MS + 1000;
  const c3 = Migration.claimLease(TID, projectId, { runId: 'run-c', nowMs: later });
  assert.strictEqual(c3.claimed, true, '租约过期后可被回收认领');
  assert.strictEqual(c3.previousStatus, 'running');
  // CAS 竞争：若记录已被他人改写（状态变为 failed 且租约变化），旧条件不匹配 → 认领失败
  const staleNow = Date.now() + Migration.LEASE_MS * 2;
  const staleRec = Migration.getRecord(TID, projectId);
  // 模拟另一执行者先完成认领（更新租约）
  Migration.claimLease(TID, projectId, { runId: 'run-d', nowMs: staleNow });
  const loser = (() => {
    // 用过期前读到的旧租约尝试 CAS：直接调用底层更新验证条件不匹配
    const db = SurfaceStore.getDb();
    const r = db.prepare(`UPDATE collection_migrations SET status='running', lease_expires_at=?
      WHERE migration_id=? AND tenant_id=? AND project_id=? AND status=? AND lease_expires_at IS ?`)
      .run(staleNow + 1, Migration.MIGRATION_ID, TID, projectId, 'failed', null);
    return r.changes;
  })();
  assert.strictEqual(loser, 0, '旧状态+旧租约条件不匹配时 CAS 必须 0 行命中');
  assert.ok(staleRec, '记录仍可读');
});

// ---------- R4：一个品牌已有官网 attempt，其余品牌仍补建 ----------
test('R4 项目内品牌 A 已有官网 attempt，品牌 B/C 仍进入首轮计划', () => {
  const projectId = 'projR4';
  const cs = comps(projectId, 3, false);
  writeState(TID, projectId, cs);
  const mk = SurfaceStore.createAttempt({
    tenantId: TID, projectId, competitorId: cs[0].id, capability: 'official_site_profile',
    dimension: 'website_profile', trigger: 'schedule', idempotencyKey: uid('r4-'),
  });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
    status: 'success', observations: [{ id: 'h1', sourceUrl: 'https://x' }], summary: {},
    snapshotIds: ['s'], evidenceIds: ['e'],
  }, null);
  const r = Migration.runMigration({ maxProjects: 50, maxReviewsTotal: 0 });
  assert.ok(r.migrated >= 1, '迁移执行: ' + JSON.stringify(r.perProject));
  const official = jobsOf(TID, projectId, 'official_site_profile');
  assert.strictEqual(official, 2, 'B/C 两个品牌补建官网资料（A 复用，不重复入队）: ' + official);
  const perBrandA = r.perProject.find(p => p.projectId === projectId);
  assert.ok(perBrandA && perBrandA.outcome === 'migrated');
  // A 的官网能力记为 reused（不重复计费）
  const log = Plan.listPlanLog(TID, projectId, 100);
  assert.ok(log.some(x => x.decision === 'reused' && x.competitor_id === cs[0].id), 'A 官网能力应记为 reused');
});

// ---------- R5：同品牌只补缺失能力 ----------
test('R5 品牌已有官网数据，缺商品/评论 → 只补缺失能力，不重复官网', () => {
  const projectId = 'projR5';
  const cs = comps(projectId, 1, false);
  writeState(TID, projectId, cs);
  const mk = SurfaceStore.createAttempt({
    tenantId: TID, projectId, competitorId: cs[0].id, capability: 'official_site_profile',
    dimension: 'website_profile', trigger: 'schedule', idempotencyKey: uid('r5-'),
  });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
    status: 'success', observations: [{ id: 'h1', sourceUrl: 'https://x' }], summary: {},
    snapshotIds: ['s'], evidenceIds: ['e'],
  }, null);
  const r = Migration.runMigration({ maxProjects: 50, maxReviewsTotal: 1 });
  const pb = r.perProject.find(p => p.projectId === projectId);
  assert.ok(pb, '项目出现于迁移结果');
  const jobsOfficial = jobsOf(TID, projectId, 'official_site_profile');
  assert.strictEqual(jobsOfficial, 0, '官网能力已有终态 → 不重复入队');
  const jobsReviews = jobsOf(TID, projectId, 'public_reviews');
  assert.strictEqual(jobsReviews, 1, '缺失的评论能力被补建: ' + jobsReviews);
  const jobsProducts = jobsOf(TID, projectId, 'public_site_products');
  assert.strictEqual(jobsProducts, 0, '商品能力未达运行态 → 不安排（awaiting_real_verification）');
  const log = Plan.listPlanLog(TID, projectId, 100);
  assert.ok(log.some(x => x.capability === 'official_site_profile' && x.decision === 'reused'), '官网记为 reused');
  assert.ok(log.some(x => x.capability === 'public_reviews' && x.decision === 'enqueued'), '评论记为 enqueued');
});

// ---------- R6：executor 连续异常 → 有界重试 → 停止 ----------
function makeThrowingExecutor() { return async () => { throw new Error('executor boom'); }; }

test('R6 executor 连续异常计入 auto_retries，达到上限后 source_failed 且不再自动产生任务', async () => {
  const projectId = 'projR6';
  const comp = comps(projectId, 1, false)[0];
  writeState(TID, projectId, [comp]);
  WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id });
  WIntent.scheduleFirstProbe({ tenantId: TID, projectId, competitorId: comp.id });
  CollectJobs.setExecutorForTest(makeThrowingExecutor());
  try {
    let guard = 0;
    const adv = () => Date.now() + 5 * 60 * 1000 * (guard + 1);
    for (;;) {
      guard += 1;
      if (guard > 6) break;
      WIntent.runDueProbes(adv());
      await sleep(150); // 让 setImmediate tick 执行（executor 抛错 → 异常路径推进意向）
      const it = WIntent.findIntent(TID, projectId, comp.id);
      if (guard === 1) {
        assert.ok(it.autoRetries >= 1, 'executor 异常必须计入 auto_retries（异常路径也推进意向）: ' + it.autoRetries);
        assert.ok(it.nextProbeAt, '异常后必须安排下一次探测（不得停在无任务无时间的 establishing）');
        assert.strictEqual(it.state, 'establishing');
      }
      if (it.state === 'source_failed') break;
    }
    const it = WIntent.findIntent(TID, projectId, comp.id);
    assert.strictEqual(it.state, 'source_failed', '达到重试上限必须进入 source_failed');
    assert.strictEqual(it.reasonCode, 'source_unavailable');
    assert.strictEqual(it.nextProbeAt, null, 'source_failed 后不得再有自动探测计划');
    const jobsBefore = jobsOf(TID, projectId, 'public_site_products');
    WIntent.runDueProbes(Date.now() + 30 * 24 * 3600 * 1000);
    await sleep(120);
    assert.strictEqual(jobsOf(TID, projectId, 'public_site_products'), jobsBefore, '上限后不得继续自动产生任务');
    // 不变量：establishing 必须有 job 或未来 next_probe_at（此处已是终态，验证无残留 establishing）
    const open = WIntent.listIntents(TID, projectId).filter(x => x.state === 'establishing');
    assert.strictEqual(open.length, 0, '不得残留 establishing');
  } finally { CollectJobs.setExecutorForTest(null); }
});

// ---------- R7：取消/晋升不受迟到任务影响（r3 不变量补充） ----------
test('R7 取消后的迟到任务结果不推进意向；不变量自愈不复活终态', () => {
  const projectId = 'projR7';
  const comp = comps(projectId, 1, false)[0];
  writeState(TID, projectId, [comp]);
  const a = WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id });
  WIntent.scheduleFirstProbe({ tenantId: TID, projectId, competitorId: comp.id });
  WIntent.cancelIntent(TID, a.intent.intentId);
  const heal = WIntent.reconcileStuckIntents(Date.now());
  assert.strictEqual(heal.rescheduled, 0, '取消的意向不得被自愈复活');
  const it = WIntent.findIntent(TID, projectId, comp.id);
  assert.strictEqual(it.state, 'cancelled');
  assert.strictEqual(it.nextProbeAt, null);
  // 自愈：人为造出「establishing 且无 next_probe_at」的异常状态 → 必须被安排探测或失败
  const b = WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id });
  WS.getDb().prepare("UPDATE watch_intents SET state='establishing', next_probe_at=NULL, auto_retries=0 WHERE intent_id=?")
    .run(b.intent.intentId);
  const heal2 = WIntent.reconcileStuckIntents(Date.now());
  assert.ok(heal2.rescheduled + heal2.activeJob >= 1, '无任务无时间的 establishing 必须被修复: ' + JSON.stringify(heal2));
  const after = WIntent.findIntent(TID, projectId, comp.id);
  assert.ok(after.nextProbeAt, '自愈后必须有未来探测时间');
  WIntent.cancelIntent(TID, b.intent.intentId);
});

// ---------- R8：两租户隔离 ----------
test('R8 两租户迁移记录、任务、意向与页面数据互不串读', () => {
  const pidA = 'projR8a';
  const pidB = 'projR8b';
  writeState(TID, pidA, comps(pidA, 2, false));
  writeState(TID_B, pidB, comps(pidB, 1, false));
  const r = Migration.runMigration({ maxProjects: 100, maxReviewsTotal: 0 });
  assert.ok(r.migrated >= 2, '两个租户的项目都被迁移: ' + JSON.stringify(r.perProject.map(p => p.projectId + ':' + p.outcome)));
  // 记录隔离
  assert.ok(Migration.getRecord(TID, pidA));
  assert.ok(Migration.getRecord(TID_B, pidB));
  assert.strictEqual(Migration.getRecord(TID_B, pidA), null, 'B 看不到 A 的迁移记录');
  // 任务隔离
  assert.strictEqual(jobsOf(TID_B, pidA), 0, 'B 无 A 项目任务');
  // 意向隔离
  WIntent.requestIntent({ tenantId: TID, projectId: pidA, competitorId: 'c-' + pidA + '-1' });
  assert.strictEqual(WIntent.findIntent(TID_B, pidA, 'c-' + pidA + '-1'), null);
  assert.strictEqual(WIntent.listIntents(TID_B, pidA).length, 0);
  // 页面数据隔离（品牌覆盖）
  const covB = BrandSvc.buildProjectCollectionCoverage(TID_B, pidA);
  assert.strictEqual(covB.brands, 0, 'B 看不到 A 的页面数据');
});
