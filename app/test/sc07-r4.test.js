'use strict';
// ============================================================
// test/sc07-r4.test.js —— SC-07 r4 合并前最终整改回归
// ------------------------------------------------------------
// F1  stale-owner fencing：A 租约过期 → B 回收取得新 runId →
//     A 的 releaseDone/releaseFailed 零行更新（抛 fenced）→ 记录保持 B 的
//     running/runId → B 正常 releaseDone → 最终只有 B 的结果生效
// F2  runMigration 全程只用 claim.runId 作为租约身份（F1 + D1 间接覆盖断言）
// D1  全新 ZB_DATA_DIR 子进程 dry-run：collection_migrations 表/索引不创建；
//     attempts/jobs/plan_log 零行；dry-run 后正式执行仍能认领入队
// G1  failed attempt 不被当作「已有覆盖」：官网 failed → 重入计划
// G2  running attempt 复用（防重复入队双计费）
// G3  partial 有可信数据 → 复用；partial 空手而归 → 重入计划
// G4  已删除项目不留 running migration（孤儿 running 过期 → failed:project_missing）
// G5  两租户迁移记录互不串读（补充：release 的 tenant 维度 fencing）
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc07r4-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.SERPER_API_KEY = 'test-key-not-real';
try { fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true }); } catch (e) {}

const SurfaceStore = require('../services/surface-store.js');
const CollectJobs = require('../services/collect-jobs.js');
const Migration = require('../services/collection-migration.js');
const Plan = require('../services/collection-plan.js');
const Db = require('../services/db.js');
const { projFile, mirrorProjectToDb } = require('../core/state-store.js');

const TID = 'tenant:r4a';
const TID_B = 'tenant:r4b';
let seq = 0;
function uid(p) { seq += 1; return p + seq; }

function writeState(tenantId, projectId, compsArr) {
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    tenantId, projectId, track: 'SC07R4 回归', intent: { regions: ['us'] }, excluded: [],
    competitors: compsArr, discoverDone: true, progress: { total: compsArr.length, done: compsArr.length },
  }, null, 2));
  mirrorProjectToDb(projectId, tenantId, 'SC07R4');
}
function comps(projectId, n) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'c-' + projectId + '-' + (i + 1),
    name: 'R4品牌' + (i + 1),
    url: 'https://r4brand' + (i + 1) + '-' + projectId + '.example.com',
    status: 'done', isShopify: false,
  }));
}

// ---------- F1：stale-owner fencing ----------
test('F1 stale owner 不能结束别人的租约：A 过期被 B 回收后，A 的 release 全部零行且被拒', () => {
  const projectId = 'projF1';
  writeState(TID, projectId, comps(projectId, 1));
  const tid = TID, pid = projectId;

  // 1) A 取得租约
  const a = Migration.claimLease(tid, pid, { nowMs: 1000000 });
  assert.ok(a.claimed, 'A 首次认领成功');
  assert.notStrictEqual(a.runId, undefined);
  let rec = Migration.getRecord(tid, pid);
  assert.strictEqual(rec.status, 'running');
  assert.strictEqual(rec.runId, a.runId);

  // 2) A 租约过期 → 3) B 回收并取得新 runId
  const b = Migration.claimLease(tid, pid, { nowMs: 1000000 + Migration.LEASE_MS + 1 });
  assert.ok(b.claimed, 'B 在 A 租约过期后回收认领');
  assert.notStrictEqual(b.runId, a.runId, 'B 持有不同 runId');

  // 4/5) A 迟到的 releaseDone / releaseFailed：零行更新 + 抛 fenced
  assert.throws(() => Migration.releaseDone(tid, pid, { runId: a.runId, counts: { fake: 1 } }),
    (e) => e.fenced === true && e.action === 'releaseDone', 'A 的 releaseDone 必须抛 fenced');
  assert.throws(() => Migration.releaseFailed(tid, pid, { runId: a.runId, reason: 'stale' }),
    (e) => e.fenced === true && e.action === 'releaseFailed', 'A 的 releaseFailed 必须抛 fenced');

  // 6) 记录仍保持 B 的 running/runId
  rec = Migration.getRecord(tid, pid);
  assert.strictEqual(rec.status, 'running', 'A 迟到释放不得改变状态');
  assert.strictEqual(rec.runId, b.runId, '记录仍为 B 的 runId');

  // 7) B 正常 releaseDone → 8) 只有 B 的结果生效
  Migration.releaseDone(tid, pid, { runId: b.runId, counts: { real: 1 }, reason: null });
  rec = Migration.getRecord(tid, pid);
  assert.strictEqual(rec.status, 'done');
  assert.strictEqual(rec.runId, b.runId);
  assert.deepStrictEqual(rec.counts, { real: 1 }, '最终只有 B 的 counts 生效');
  assert.strictEqual(rec.leaseExpiresAt, null, 'done 后租约清空');

  // 附：跨租户同名项目 id 也不得互相释放（tenant 维度 fencing）
  const a2 = Migration.claimLease(TID_B, projectId, { nowMs: 2000000 });
  assert.ok(a2.claimed);
  assert.throws(() => Migration.releaseDone(TID_B, '别的项目', { runId: a2.runId, counts: {} }),
    (e) => e.fenced === true, 'project 维度不匹配必须 fenced');
  Migration.releaseDone(TID_B, projectId, { runId: a2.runId, counts: {} });
});

// ---------- D1：全新目录子进程 dry-run 零写入 ----------
test('D1 全新 ZB_DATA_DIR 子进程：dry-run 不建 collection_migrations、零业务行，正式执行仍可迁移', () => {
  const freshDir = path.join(os.tmpdir(), 'zhibi-sc07r4-fresh-' + Date.now() + '-' + process.pid);
  fs.mkdirSync(freshDir, { recursive: true });
  const repoRoot = path.join(__dirname, '..', '..');
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('fs'), path = require('path'), os = require('os');
    const out = { fresh: true };
    try {
      // 种一个项目（主库 tenants/projects 是基础设施，dry-run 枚举项目必需）
      const { projFile, mirrorProjectToDb } = require('${repoRoot.replace(/\\/g, '/')}/app/core/state-store.js');
      const compsArr = [{ id: 'c-fresh-1', name: 'FreshBrand', url: 'https://fresh.example.com', status: 'done', isShopify: false }];
      const f = projFile('projFresh', 'tenant:fresh');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify({ tenantId: 'tenant:fresh', projectId: 'projFresh', intent: { regions: ['us'] }, excluded: [], competitors: compsArr, discoverDone: true, progress: { total: 1, done: 1 } }));
      mirrorProjectToDb('projFresh', 'tenant:fresh', 'D1');

      const Migration = require('${repoRoot.replace(/\\/g, '/')}/app/services/collection-migration.js');
      const sdb = require('${repoRoot.replace(/\\/g, '/')}/app/services/surface-store.js').getDb();
      const q = (sql) => { try { return sdb.prepare(sql).all(); } catch (e) { return { __missing: true }; } };
      const tableExists = (name) => !!sdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      const indexExists = (name) => !!sdb.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name);

      out.before = {
        migTable: tableExists('collection_migrations'),
        migIndex: indexExists('idx_cm_status'),
      };
      const r = Migration.runMigration({ dryRun: true, maxProjects: 10 });
      out.dryRun = { planned: r.planned, scanned: r.scanned, ok: r.ok };
      out.after = {
        migTable: tableExists('collection_migrations'),
        migIndex: indexExists('idx_cm_status'),
        attemptsRows: q('SELECT COUNT(*) AS n FROM collection_attempts').__missing ? -1 : q('SELECT COUNT(*) AS n FROM collection_attempts')[0].n,
        planLogRows: q('SELECT COUNT(*) AS n FROM collection_plan_log').__missing ? -1 : q('SELECT COUNT(*) AS n FROM collection_plan_log')[0].n,
        watchIntentTable: tableExists('watch_intents'),
        verifRows: q('SELECT COUNT(*) AS n FROM provider_verifications').__missing ? -1 : q('SELECT COUNT(*) AS n FROM provider_verifications')[0].n,
      };
      // 正式执行：dry-run 后仍能认领并迁移（不被 dry-run 破坏）
      const r2 = Migration.runMigration({ maxProjects: 10 });
      out.realRun = { migrated: r2.migrated, failed: r2.failed, casLost: r2.casLost, fenced: r2.fenced || 0 };
      out.afterReal = { migTable: tableExists('collection_migrations'), rec: Migration.getRecord('tenant:fresh', 'projFresh') };
      console.log('__RESULT__' + JSON.stringify(out));
    } catch (e) {
      console.log('__RESULT__' + JSON.stringify({ fatal: String((e && e.stack) || e) }));
    }
  `], { env: Object.assign({}, process.env, { ZB_DATA_DIR: freshDir }), encoding: 'utf8', timeout: 120000 });
  const line = (child.stdout || '').split('\n').filter(l => l.startsWith('__RESULT__'))[0];
  assert.ok(line, '子进程应输出结果 JSON：' + (child.stderr || '').slice(0, 400));
  const r = JSON.parse(line.slice('__RESULT__'.length));
  assert.ok(!r.fatal, '子进程无异常: ' + (r.fatal || ''));
  assert.strictEqual(r.before.migTable, false, 'dry-run 前 collection_migrations 不存在');
  assert.strictEqual(r.before.migIndex, false);
  assert.ok(r.dryRun.planned >= 1, 'dry-run 应产出计划');
  assert.strictEqual(r.after.migTable, false, 'dry-run 不得创建 collection_migrations 表');
  assert.strictEqual(r.after.migIndex, false, 'dry-run 不得创建 collection_migrations 索引');
  assert.ok(r.after.attemptsRows === -1 || r.after.attemptsRows === 0, 'attempts 零行或表未建: ' + r.after.attemptsRows);
  assert.ok(r.after.planLogRows === -1 || r.after.planLogRows === 0, 'plan log 零行或表未建: ' + r.after.planLogRows);
  assert.strictEqual(r.after.watchIntentTable, false, 'dry-run 不得建 watch_intents');
  assert.strictEqual(r.after.verifRows, 0, 'provider verification 零记录');
  assert.strictEqual(r.afterReal.migTable, true, '正式执行后迁移表存在');
  assert.strictEqual(r.afterReal.rec.status, 'done', 'dry-run 后正式执行完成迁移');
  assert.ok(r.realRun.migrated >= 1 && (r.realRun.fenced || 0) === 0, '正式执行迁移成功且无 fenced: ' + JSON.stringify(r.realRun));
});

// ---------- G1/G2/G3：品牌 × 能力缺口语义 ----------
test('G1 failed attempt 不被当作「已有覆盖」：官网 failed → 重入计划；G2 running → 复用', () => {
  const projectId = 'projG1';
  const cs = comps(projectId, 2);
  writeState(TID, projectId, cs);
  // 品牌1 官网 failed → 不算覆盖；品牌2 官网 running → 复用
  const f1 = SurfaceStore.createAttempt({ tenantId: TID, projectId, competitorId: cs[0].id, capability: 'official_site_profile', dimension: 'website_profile', trigger: 'schedule', idempotencyKey: 'r4g1-' + Date.now() });
  SurfaceStore.completeAttempt(TID, f1.attempt.attemptId, { status: 'failed', sourceStatus: 'unavailable', errorUserText: '源站不可达' }, null);
  const f2 = SurfaceStore.createAttempt({ tenantId: TID, projectId, competitorId: cs[1].id, capability: 'official_site_profile', dimension: 'website_profile', trigger: 'schedule', idempotencyKey: 'r4g2-' + Date.now() });

  const planned = Plan.bootstrapProject({ tenantId: TID, projectId, dryRun: true, skipTerminal: true });
  const d1 = planned.perBrand.find(b => b.competitorId === cs[0].id).decisions.find(d => d.capability === 'official_site_profile');
  const d2 = planned.perBrand.find(b => b.competitorId === cs[1].id).decisions.find(d => d.capability === 'official_site_profile');
  assert.strictEqual(d1.decision, 'planned', 'failed 的官网能力必须重入计划（不永久跳过）: ' + JSON.stringify(d1));
  assert.strictEqual(d2.decision, 'reused', 'running 的官网能力复用（防双计费）: ' + JSON.stringify(d2));

  // 正式迁移：failed 的官网重入有界处理（非 Shopify 官网 gate 需要 operational readiness——
  // 未验证时为 awaiting_real_verification → gate 不放行 → skipped(awaiting)，即「待人工/下次再试」，
  // 不会重复计费也不会被永久跳过；评论能力则正常入队）
  const r = Migration.runMigration({ maxProjects: 10 });
  const per = r.perProject.find(p => p.projectId === projectId);
  assert.ok(per, '项目被扫描: ' + JSON.stringify(r.perProject));
  assert.ok(r.fenced === 0 || r.fenced === undefined);
});

test('G3 partial 有可信数据 → 复用；partial 空手而归 → 重入计划', () => {
  const projectId = 'projG3';
  const cs = comps(projectId, 2);
  writeState(TID, projectId, cs);
  const withData = SurfaceStore.createAttempt({ tenantId: TID, projectId, competitorId: cs[0].id, capability: 'official_site_profile', dimension: 'website_profile', trigger: 'schedule', idempotencyKey: 'r4g3a-' + Date.now() });
  SurfaceStore.completeAttempt(TID, withData.attempt.attemptId, {
    status: 'partial', sourceStatus: 'partial',
    observations: [{ id: 'obs1', kind: 'site_profile' }], snapshotIds: ['snap1'], evidenceIds: [],
  }, null);
  const emptyPartial = SurfaceStore.createAttempt({ tenantId: TID, projectId, competitorId: cs[1].id, capability: 'official_site_profile', dimension: 'website_profile', trigger: 'schedule', idempotencyKey: 'r4g3b-' + Date.now() });
  SurfaceStore.completeAttempt(TID, emptyPartial.attempt.attemptId, { status: 'partial', sourceStatus: 'partial', observations: [], snapshotIds: [], evidenceIds: [] }, null);

  const planned = Plan.bootstrapProject({ tenantId: TID, projectId, dryRun: true, skipTerminal: true });
  const d1 = planned.perBrand.find(b => b.competitorId === cs[0].id).decisions.find(d => d.capability === 'official_site_profile');
  const d2 = planned.perBrand.find(b => b.competitorId === cs[1].id).decisions.find(d => d.capability === 'official_site_profile');
  assert.strictEqual(d1.decision, 'reused', 'partial+数据 复用: ' + JSON.stringify(d1));
  assert.strictEqual(d2.decision, 'planned', 'partial 空手 重入计划: ' + JSON.stringify(d2));
});

// ---------- G4：删除项目不留 running migration ----------
test('G4 已删除项目：孤儿 running（租约过期）被安全落 failed:project_missing', () => {
  const goneTenant = 'tenant:r4gone';
  const goneProject = 'projGone';
  // 直接造一条孤儿 running 过期记录（项目从未在 projects 表）
  const sdb = SurfaceStore.getDb();
  Migration.claimLease(goneTenant, goneProject, { nowMs: 3000000 });
  // 人为把租约拨到过去（模拟执行器消失）
  sdb.prepare('UPDATE collection_migrations SET lease_expires_at=? WHERE tenant_id=? AND project_id=?')
    .run(1, goneTenant, goneProject);
  const r = Migration.runMigration({ maxProjects: 50 });
  assert.ok((r.missingProjectReleased || 0) >= 1, '孤儿记录被回收: ' + JSON.stringify({ missing: r.missingProjectReleased }));
  const rec = Migration.getRecord(goneTenant, goneProject);
  assert.strictEqual(rec.status, 'failed', '不留 running');
  assert.strictEqual(rec.reason, 'project_missing');
  assert.strictEqual(rec.leaseExpiresAt, null);
});

// ---------- G5：跨租户 release fencing（tenant 维度） ----------
test('G5 同项目 id 不同租户：释放必须匹配 tenant_id，跨租户零行且 fenced', () => {
  const projectId = 'projG5';
  writeState(TID, projectId, comps(projectId, 1));
  writeState(TID_B, projectId, comps(projectId, 1));
  const a = Migration.claimLease(TID, projectId, { nowMs: 5000000 });
  const b = Migration.claimLease(TID_B, projectId, { nowMs: 5000000 });
  assert.ok(a.claimed && b.claimed, '两租户各自认领（迁移记录按 tenant 隔离）');
  assert.throws(() => Migration.releaseDone(TID, projectId, { runId: b.runId, counts: {} }),
    (e) => e.fenced === true, 'A 租户不能用 B 租户的 runId 释放自己——run_id 不匹配 fenced');
  assert.throws(() => Migration.releaseDone(TID_B, projectId, { runId: a.runId, counts: {} }),
    (e) => e.fenced === true, 'B 租户不能用 A 租户的 runId 释放自己');
  // 各自用自己的 runId 正常释放
  Migration.releaseDone(TID, projectId, { runId: a.runId, counts: { t: 'a' } });
  Migration.releaseDone(TID_B, projectId, { runId: b.runId, counts: { t: 'b' } });
  assert.strictEqual(Migration.getRecord(TID, projectId).counts.t, 'a');
  assert.strictEqual(Migration.getRecord(TID_B, projectId).counts.t, 'b', '两租户结果互不覆盖');
});
