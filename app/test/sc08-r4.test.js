'use strict';
// ============================================================
// test/sc08-r4.test.js —— SC-08 r4 最终幂等收尾
// ------------------------------------------------------------
// R4-1（真实 HTTP）：从零建立 site_change → 自动晋升 promoted →
//   快照全部持久化实体数量 → 连续 POST /api/watch-targets 两次 →
//   均返回 200 +「该品牌已在正式监控中。」→ 所有数量/字段逐项不变 →
//   drain 后仍无新增 job / attempt（证明 handler 不再跑 planForCompetitor）。
// R4-2（代码级）：概览下一步提示——staleDims > 0 时优先说失败，
//   不得再出现「数据正在按计划积累」。
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc08r4-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.CACHE_ENABLED = '0';
process.env.ZB_INTENT_PROBE_INTERVAL_MS = '1000';
try { fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true }); } catch (e) {}

const Snapshot = require('../research/source-snapshot.js');
const SurfaceStore = require('../services/surface-store.js');
const WS = require('../services/watch-store.js');
const WIntent = require('../services/watch-intent.js');
const CollectJobs = require('../services/collect-jobs.js');
const WatchH = require('../routes/handlers/watch.js');
const { projFile, mirrorProjectToDb } = require('../core/state-store.js');
const db = require('../services/db.js');

const SITE_HOST = 'acme-r4.example.com';
const OFFICIAL = `<!doctype html><html><head>
<title>Acme Outdoor — Trail Gear</title>
<meta name="description" content="Durable outdoor essentials">
<link rel="canonical" href="https://${SITE_HOST}/">
<script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://${SITE_HOST}/"}</script>
</head><body><h1>Acme Outdoor</h1><nav><a href="/shop">Shop</a></nav></body></html>`;

// executor 替身：官网能力落真实稳定快照；商品能力给「无可比价格」观察
CollectJobs.setExecutorForTest(async (job) => {
  if (job.capability === 'official_site_profile') {
    const snap = Snapshot.record({
      capability: 'official_site_profile', provider: 'generic_web_fetch',
      source_url: 'https://' + SITE_HOST + '/', final_url: 'https://' + SITE_HOST + '/',
      http_status: 200, source_status: 'success', error_code: null,
      observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
      bodyBytes: Buffer.from(OFFICIAL, 'utf8'), trigger: 'schedule', tenantId: job.tenantId,
    });
    SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
      status: 'success', observations: [], summary: { kind: 'official_site_profile' },
      snapshotIds: snap.recorded ? [snap.meta.snapshot_id] : [], evidenceIds: [],
    }, null);
    return { attempt: SurfaceStore.getAttempt(job.tenantId, job.attemptId) };
  }
  SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
    status: 'success',
    observations: [{ id: 'https://' + SITE_HOST + '/p/x', title: '无价格商品' }],
    summary: { kind: 'public_site_products' },
    snapshotIds: ['snap-' + job.attemptId], evidenceIds: ['ev-' + job.attemptId],
  }, null);
  return { attempt: SurfaceStore.getAttempt(job.tenantId, job.attemptId) };
});

// ---------- 夹具 ----------
function comp(id, url) {
  return { id, name: 'Acme' + id.slice(-3), url, status: 'done', isShopify: false, market: 'us', relation: 'competitor', category: 'outdoor' };
}
function seedProject(tenantId, projectId, compsArr) {
  try { db.createTenant({ name: 't-' + tenantId, email: tenantId.replace(/[^a-z0-9]/gi, '') + '@example.com' }); } catch (e) { /* 已存在 */ }
  try {
    db.saveProject({ id: projectId, tenantId, track: 'T-' + projectId, competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  } catch (e) { /* 已存在 */ }
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    tenantId, projectId, intent: { regions: ['us'], category: 'outdoor' }, excluded: [],
    competitors: compsArr, discoverDone: true, progress: { total: compsArr.length, done: compsArr.length },
  }, null, 2));
  try { mirrorProjectToDb(projectId, tenantId, 'SC08R4'); } catch (e) { /* 镜像失败不影响 */ }
}
function mkWatchCtx(tid, body) {
  return {
    getAuthPayload: () => (tid ? { kind: 'tenant', payload: { tid } } : null),
    getCurrentId: () => '',
    readBody: async () => body,
    sendJSON: (res, status, b) => { res.status = status; res.body = b; return true; },
    projFile: (pid, t) => projFile(pid, t),
    loadState: () => null,
  };
}
async function postTarget(tid, body) {
  const res = {};
  await WatchH.createTarget(mkWatchCtx(tid, body), { method: 'POST', headers: {}, on: () => {} }, res, new URL('http://local/api/watch-targets'), '/api/watch-targets');
  return res;
}
async function drain() {
  const deadline = Date.now() + 15000;
  for (;;) {
    const r = await CollectJobs.tick({ workerId: 'w-r4-' + Math.random().toString(36).slice(2, 8) });
    const n = CollectJobs.getDb().prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE status IN ('pending','claimed','running')").get().n;
    if (!r.claimed && n === 0) return;
    if (Date.now() > deadline) throw new Error('drain 超时');
    await new Promise(res => setTimeout(res, 20));
  }
}
// 全部持久化实体计数（一个快照函数，逐项可比；表未建时按 0 计——本轮链路确实可能不产生事件）
function snapshotCounts(tid, pid, cid) {
  const w = WS.getDb();
  const hasTable = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const count = (db, table, sql) => (hasTable(db, table) ? db.prepare(sql).get().n : 0);
  return {
    intents: count(w, 'watch_intents', `SELECT COUNT(*) AS n FROM watch_intents WHERE tenant_id='${tid}' AND project_id='${pid}' AND competitor_id='${cid}'`),
    targets: count(w, 'watch_targets', `SELECT COUNT(*) AS n FROM watch_targets WHERE tenant_id='${tid}' AND project_id='${pid}' AND competitor_id='${cid}'`),
    windows: count(w, 'monitoring_windows', `SELECT COUNT(*) AS n FROM monitoring_windows WHERE tenant_id='${tid}'`),
    baselines: count(w, 'watch_site_baselines', `SELECT COUNT(*) AS n FROM watch_site_baselines WHERE tenant_id='${tid}' AND project_id='${pid}' AND competitor_id='${cid}'`),
    events: count(w, 'intel_events', `SELECT COUNT(*) AS n FROM intel_events WHERE tenant_id='${tid}' AND project_id='${pid}' AND competitor_id='${cid}'`),
    jobs: count(CollectJobs.getDb(), 'collection_jobs', `SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id='${tid}' AND project_id='${pid}' AND competitor_id='${cid}'`),
    attempts: count(SurfaceStore.getDb(), 'collection_attempts', `SELECT COUNT(*) AS n FROM collection_attempts WHERE tenant_id='${tid}' AND project_id='${pid}' AND competitor_id='${cid}'`),
  };
}

// ============================================================
// R4-1：promoted 重复提交零副作用
// ============================================================
test('R4-1 promoted 重复 POST：两次均 200「已在正式监控中」，全部实体数量逐项不变，drain 后仍无新增', async () => {
  const tid = 'tenant:r4idem';
  const pid = 'projR4Idem';
  const cid = 'c-r4-idem';
  seedProject(tid, pid, [comp(cid, 'https://' + SITE_HOST + '/')]);

  // ① 真实 HTTP 首次加入 → 商品探测无可比价格 → 官网两次观察 → 自动晋升
  const r1 = await postTarget(tid, { competitorId: cid, projectId: pid });
  assert.ok(r1.status === 202 || r1.status === 200, '首次加入返回: ' + r1.status);
  for (let i = 0; i < 8; i++) {
    WIntent.runDueProbes(Date.now() + (i + 1) * 60000);
    await drain();
    if (WIntent.findIntent(tid, pid, cid).state === 'promoted') break;
  }
  const intent = WIntent.findIntent(tid, pid, cid);
  assert.strictEqual(intent.state, 'promoted', '前置：已自动晋升: ' + intent.state + '/' + (intent.reasonCode || ''));
  const target = WS.getWatchTarget(tid, intent.promotedTargetId);
  assert.deepStrictEqual(target.supportedSignals, ['site_change']);

  // ② 晋升后全量实体数量快照
  const before = snapshotCounts(tid, pid, cid);
  assert.ok(before.intents === 1 && before.targets === 1, '恰好一条意向一个 WatchTarget: ' + JSON.stringify(before));
  assert.ok(before.jobs > 0 && before.attempts > 0 && before.baselines >= 1, '建立期已产生真实 job/attempt/基线');

  // ③ 连续两次 POST（promoted 重复提交）
  const p1 = await postTarget(tid, { competitorId: cid, projectId: pid });
  const p2 = await postTarget(tid, { competitorId: cid, projectId: pid });
  for (const [i, r] of [[1, p1], [2, p2]]) {
    assert.strictEqual(r.status, 200, `第 ${i} 次重复 POST 返回 200`);
    assert.strictEqual(r.body.existed, true);
    assert.strictEqual(r.body.message, '该品牌已在正式监控中。', `第 ${i} 次提示: ` + r.body.message);
    assert.strictEqual(r.body.intent.state, 'promoted');
    assert.strictEqual(r.body.intent.monitoring, true, 'intent.monitoring = true');
    assert.ok(r.body.target, '返回对应 WatchTarget');
    assert.strictEqual(r.body.target.watchTargetId, target.watchTargetId, 'target 是既有正式监控对象');
    assert.strictEqual(r.body.baseline, undefined, 'promoted 分支不返回采集计划（没有执行计划）');
  }

  // ④ 数量逐项不变（立即）
  const after = snapshotCounts(tid, pid, cid);
  assert.deepStrictEqual(after, before, '重复 POST 后所有实体数量逐项不变: ' + JSON.stringify({ before, after }));

  // ⑤ 等 worker/drain 后仍无新增（证明 planForCompetitor 没有再跑）
  await drain();
  const afterDrain = snapshotCounts(tid, pid, cid);
  assert.deepStrictEqual(afterDrain, before, 'drain 后仍无新增 job/attempt: ' + JSON.stringify({ before, afterDrain }));

  // ⑥ 意向内容逐字段不变（不被改写）
  const intentAfter = WIntent.findIntent(tid, pid, cid);
  assert.strictEqual(intentAfter.state, 'promoted');
  assert.strictEqual(intentAfter.promotedTargetId, intent.promotedTargetId);
  assert.strictEqual(intentAfter.nextProbeCapability, intent.nextProbeCapability);
  assert.strictEqual(intentAfter.probePhase, intent.probePhase);
  assert.strictEqual(intentAfter.lastProbeAttemptId, intent.lastProbeAttemptId);
});

// ============================================================
// R4-2：概览下一步提示——staleDims > 0 优先说失败
// ============================================================
test('R4-2 前端 nextStep：staleDims 优先失败提示，不再与「正常积累」并存（代码级）', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'app', '(panel)', 'brands', '[brandId]', 'page.tsx'), 'utf8');
  const m = page.match(/const nextStep = \(\(\) => \{([\s\S]*?)\}\)\(\);/);
  assert.ok(m, '找到 nextStep 定义');
  const body = m[1];
  const staleIdx = body.indexOf('staleDims > 0');
  const failIdx = body.indexOf('部分维度已有历史数据，但最近一次更新失败');
  assert.ok(staleIdx !== -1 && failIdx !== -1, '存在 staleDims 优先分支');
  const normalIdx = body.indexOf('数据正在按计划积累');
  assert.ok(staleIdx < normalIdx && body.indexOf('return', staleIdx) < normalIdx, 'staleDims 分支先于「正常积累」返回');
  // 确认 staleDims 分支的文案不含「正常积累」且引导到覆盖明细页
  // （核心产品体验收敛 r1：该 Tab 已改名为「数据覆盖与来源」，引导目标未变）
  const branch = body.slice(staleIdx, body.indexOf(';', staleIdx));
  assert.ok(/数据覆盖与来源/.test(branch), '失败提示引导查看数据覆盖与来源: ' + branch.trim());
  assert.ok(!/正常积累|照常积累/.test(branch), '失败提示不得同时说积累正常');
});
