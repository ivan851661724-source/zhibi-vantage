'use strict';
// ============================================================
// test/sc09-r3.test.js —— SC-09 最终合并阻断整改（r3）
// ------------------------------------------------------------
// C1  job/attempt 统一取消：pending / 已 claim / 重启 / 错误 token / 重新加入
// M1  市场解析唯一入口：competitor.market → intent.regions[0]，区域词仍 unknown
// M2  源码级断言：首采模块不得再出现独立市场判断旁路
// D1  complete/partial 比较矩阵：partial 不得制造下架或数量下降
// D2  事件证据必须来自本次真实 Snapshot/Evidence
// E1  removedBrandsCount 品牌口径（不是 item 口径）
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc09r3-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.ZB_FIRST_COLLECTION_DISABLED = '1';
process.env.CACHE_ENABLED = '0';
try { fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true }); } catch (e) {}

const SurfaceStore = require('../services/surface-store.js');
const CollectJobs = require('../services/collect-jobs.js');
const FC = require('../services/first-collection.js');
const Inbox = require('../services/intel-inbox.js');
const Diff = require('../services/observation-diff.js');
const BrandMarket = require('../lib/brand-market.js');
const BrandSvc = require('../services/brand-service.js');
const BrandStore = require('../services/brand-store.js');
const { projFile, mirrorProjectToDb } = require('../core/state-store.js');
const db = require('../services/db.js');

const HOST = 'acme-sc09r3';

// ---------- 夹具 ----------
function comp(id, n, market, isShopify) {
  return {
    id, name: 'Brand' + n, url: `https://${HOST}-${n}.example.com/`, status: 'done',
    isShopify: !!isShopify, market: market === undefined ? 'us' : market, relation: 'competitor', category: 'outdoor',
  };
}
function writeProject(tenantId, projectId, comps, regions) {
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    tenantId, projectId, intent: { regions: regions || ['us'], category: 'outdoor' }, excluded: [],
    competitors: comps, discoverDone: true, progress: { total: comps.length, done: comps.length },
  }, null, 2));
}
function seedProject(tenantId, projectId, comps, regions) {
  try { db.createTenant({ name: 't-' + tenantId, email: tenantId.replace(/[^a-z0-9]/gi, '') + '@example.com' }); } catch (e) {}
  try {
    db.saveProject({ id: projectId, tenantId, track: 'T-' + projectId, competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  } catch (e) {}
  writeProject(tenantId, projectId, comps, regions);
  try { mirrorProjectToDb(projectId, tenantId, 'SC09R3'); } catch (e) {}
}
function drain() {
  return (async () => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const r = await CollectJobs.tick({ workerId: 'w-r3-' + Math.random().toString(36).slice(2, 8) });
      const n = CollectJobs.getDb().prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE status IN ('pending','running')").get().n;
      if (!r.claimed && n === 0) return;
      if (Date.now() > deadline) throw new Error('drain 超时');
      await new Promise(res => setTimeout(res, 15));
    }
  })();
}
let executorCalls = 0;
function makeExecutor(plan) {
  const p = plan || {};
  return async (job) => {
    executorCalls++;
    const obs = (job.capability === 'public_site_products' || job.capability === 'shopify_catalog')
      ? (p.products || []).map(x => ({ id: x.id, title: x.title, price: x.price, currency: x.currency || 'USD', available: x.available !== false }))
      : [];
    SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
      status: 'success', observations: obs,
      summary: job.capability === 'public_reviews' ? { kind: 'reviews_digest', reviewCount: p.reviewCount == null ? 0 : p.reviewCount } : {},
      snapshotIds: ['snap-' + job.attemptId], evidenceIds: ['ev-' + job.attemptId],
    }, null);
    return { attempt: SurfaceStore.getAttempt(job.tenantId, job.attemptId) };
  };
}
function q1(sql, ...args) { return CollectJobs.getDb().prepare(sql).get(...args); }
function qa(sql, ...args) { return CollectJobs.getDb().prepare(sql).all(...args); }
function itemRow(tid, pid, cid, cap) {
  return q1('SELECT * FROM first_collection_items WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=?', tid, pid, cid, cap);
}
function jobRow(tid, pid, cid, cap) {
  return q1('SELECT * FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=? ORDER BY created_at DESC LIMIT 1', tid, pid, cid, cap);
}
function runningJobs(tid, pid, cid) {
  return q1("SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=? AND status='running'", tid, pid, cid).n;
}
function runningAttempts(tid, pid, cid) {
  return q1("SELECT COUNT(*) AS n FROM collection_attempts WHERE tenant_id=? AND project_id=? AND competitor_id=? AND status='running'", tid, pid, cid).n;
}
function nJobs(tid, pid, cid) {
  return q1('SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=?', tid, pid, cid).n;
}
function nAttempts(tid, pid, cid) {
  return q1('SELECT COUNT(*) AS n FROM collection_attempts WHERE tenant_id=? AND project_id=? AND competitor_id=?', tid, pid, cid).n;
}

// ============================================================
// C1-a：pending 时移除品牌 → job 与 attempt 同时终态
// ============================================================
test('C1 pending 任务时移除品牌：job 与 attempt 都进终态，item=cancelled，零外部请求', async () => {
  const tid = 'tenant:r3c1a', pid = 'projR3C1A', cid = 'c-c1a';
  seedProject(tid, pid, [comp(cid, 1)]);
  executorCalls = 0;
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  const job = jobRow(tid, pid, cid, 'public_site_products');
  assert.strictEqual(job.status, 'pending');
  assert.ok(runningAttempts(tid, pid, cid) >= 1, 'attempt 初始为 running');

  // 品牌移出项目 → 幂等对账
  writeProject(tid, pid, []);
  FC.ensureBatch({ tenantId: tid, projectId: pid });

  const j2 = jobRow(tid, pid, cid, 'public_site_products');
  const a2 = q1('SELECT * FROM collection_attempts WHERE attempt_id=?', job.attempt_id);
  assert.strictEqual(j2.status, 'done', 'job 进入明确终态');
  assert.strictEqual(j2.last_error, 'brand_removed_from_project', 'job 留下可审计原因');
  assert.strictEqual(a2.status, 'failed', 'attempt 同步进入终态');
  assert.strictEqual(a2.error_class, 'cancelled_scope');
  assert.strictEqual(a2.error_user_text, CollectJobs.CANCEL_TEXT, '用户可读原因：品牌已移出项目，采集已取消。');
  assert.ok(!/不可达|内部|internal/i.test(a2.error_user_text), '不得写成来源不可达/内部错误');
  assert.strictEqual(runningJobs(tid, pid, cid), 0, '无 running job');
  assert.strictEqual(runningAttempts(tid, pid, cid), 0, '无 running attempt');
  assert.strictEqual(itemRow(tid, pid, cid, 'public_site_products').state, 'cancelled');
  assert.strictEqual(Number(itemRow(tid, pid, cid, 'public_site_products').in_scope), 0);

  await drain();
  assert.strictEqual(executorCalls, 0, '零外部采集调用');
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0, '不生成变化事件');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// C1-b：job 已 claim、执行前移除 → 执行前 fencing 拦截并双终结
// ============================================================
test('C1 job 已 claim、执行前移除品牌：fencing 拦截，job/attempt 双终态，零外部请求', async () => {
  const tid = 'tenant:r3c1b', pid = 'projR3C1B', cid = 'c-c1b';
  seedProject(tid, pid, [comp(cid, 1)]);
  executorCalls = 0;
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  const job0 = jobRow(tid, pid, cid, 'public_site_products');

  // 另一条能力任务先由正常对账取消（模拟「同品牌其它任务已经取消」），
  // 只留下本测试要验的那条被 worker 认领、租约过期的任务
  const sibling = jobRow(tid, pid, cid, 'official_site_profile');
  CollectJobs.cancelCollectionJobAndAttempt({ tenantId: tid, jobId: sibling.job_id, attemptId: sibling.attempt_id });

  // 模拟 worker 已认领该任务（running + 租约过期），品牌在这一瞬间被移出、
  // 取消步骤尚未跑完（崩溃中间态）：item 已 in_scope=0，job/attempt 仍是 running
  writeProject(tid, pid, []);
  CollectJobs.getDb().prepare("UPDATE collection_jobs SET status='running', claim_token='ct_held', claim_expires_at=0 WHERE job_id=?")
    .run(job0.job_id);
  CollectJobs.getDb().prepare('UPDATE first_collection_items SET in_scope=0, state=?, cancel_reason=? WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=?')
    .run('cancelled', 'brand_removed_from_project', tid, pid, cid, 'public_site_products');
  assert.strictEqual(runningJobs(tid, pid, cid), 1, '前置：job 处于 running');
  assert.ok(runningAttempts(tid, pid, cid) >= 1, '前置：attempt 处于 running');

  // tick：reclaim 过期 → claim → 执行前 fencing 拦截
  const r = await CollectJobs.tick({ workerId: 'w-r3-fence' });
  assert.strictEqual(r.status, 'cancelled', '执行前被拦停: ' + JSON.stringify(r));
  assert.strictEqual(executorCalls, 0, '未执行任何外部采集');
  const job1 = q1('SELECT status FROM collection_jobs WHERE job_id=?', job0.job_id);
  assert.strictEqual(job1.status, 'done', '拦停后 job 进入终态');
  const a2 = q1('SELECT * FROM collection_attempts WHERE attempt_id=?', job0.attempt_id);
  assert.strictEqual(a2.status, 'failed', '拦停后 attempt 同步终态');
  assert.strictEqual(a2.error_class, 'cancelled_scope');
  assert.strictEqual(a2.error_user_text, CollectJobs.CANCEL_TEXT);

  // 正常对账把该品牌其余任务一并取消后：整品牌 0 running job / 0 running attempt
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  assert.strictEqual(runningJobs(tid, pid, cid), 0, '无 running job');
  assert.strictEqual(runningAttempts(tid, pid, cid), 0, '无 running attempt');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// C1-c：竞态 —— 错误 claimToken 不得改写终态；已完成 attempt 不被覆盖
// ============================================================
test('C1 错误 claimToken 不得修改终态；已完成的 attempt 不被取消覆盖', async () => {
  const tid = 'tenant:r3c1c', pid = 'projR3C1C', cid = 'c-c1c';
  seedProject(tid, pid, [comp(cid, 1)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  const job0 = jobRow(tid, pid, cid, 'public_site_products');
  // 拿错误 token 去 finish：必须无效
  const badFinish = CollectJobs.finish(job0.job_id, 'ct_wrong', 'done', 'should-not-apply');
  assert.strictEqual(badFinish, false, '错误 token 的 finish 被拒绝');
  assert.strictEqual(jobRow(tid, pid, cid, 'public_site_products').status, 'pending', 'job 未被错误 token 改写');

  // 正常跑完 → attempt 已是 success，此时再取消：不得覆盖成功结果
  await drain();
  const aDone = q1('SELECT * FROM collection_attempts WHERE attempt_id=?', job0.attempt_id);
  assert.strictEqual(aDone.status, 'success');
  const cx = CollectJobs.cancelCollectionJobAndAttempt({
    tenantId: tid, jobId: job0.job_id, attemptId: job0.attempt_id, reasonCode: 'brand_removed_from_project',
  });
  assert.strictEqual(cx.attemptCancelled, false, '终态 attempt 不被覆盖');
  const aAfter = q1('SELECT * FROM collection_attempts WHERE attempt_id=?', job0.attempt_id);
  assert.strictEqual(aAfter.status, 'success', '成功结果保持不可变');
  assert.strictEqual(aAfter.error_class, null, '未写入取消原因');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// C1-d：重新加入同一品牌 → 旧取消任务不复活，新代数键，只一个在途任务
// ============================================================
test('C1 重新加入品牌：旧取消任务不复活，新建一个 job/attempt，且在途只有一个', async () => {
  const tid = 'tenant:r3c1d', pid = 'projR3C1D', cid = 'c-c1d';
  const c = comp(cid, 1);
  seedProject(tid, pid, [c]);
  executorCalls = 0;
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  const oldJob = jobRow(tid, pid, cid, 'public_site_products');
  const oldAtt = oldJob.attempt_id;
  const gen0 = Number(itemRow(tid, pid, cid, 'public_site_products').enqueue_generation);

  writeProject(tid, pid, []);
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  assert.strictEqual(jobRow(tid, pid, cid, 'public_site_products').status, 'done');

  // 重新加入
  writeProject(tid, pid, [c]);
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  const jobs = qa("SELECT * FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability='public_site_products' ORDER BY created_at", tid, pid, cid);
  const active = jobs.filter(j => j.status === 'pending' || j.status === 'running');
  assert.strictEqual(active.length, 1, '只产生一个在途任务: ' + jobs.map(j => j.status).join(','));
  assert.notStrictEqual(active[0].job_id, oldJob.job_id, '旧取消任务没有被复活（是新任务）');
  assert.notStrictEqual(active[0].attempt_id, oldAtt, '新 attempt 与新 job 成对');
  const it = itemRow(tid, pid, cid, 'public_site_products');
  assert.strictEqual(Number(it.in_scope), 1, 'item 回到在册');
  assert.ok(Number(it.enqueue_generation) > gen0, '使用新代数幂等键: ' + gen0 + ' → ' + it.enqueue_generation);
  const oldAfter = q1('SELECT status, last_error FROM collection_jobs WHERE job_id=?', oldJob.job_id);
  assert.strictEqual(oldAfter.status, 'done', '旧任务保持终态');
  assert.strictEqual(oldAfter.last_error, 'brand_removed_from_project', '旧任务的取消原因保留（审计）');

  await drain();
  const att = q1('SELECT status FROM collection_attempts WHERE attempt_id=?', active[0].attempt_id);
  assert.strictEqual(att.status, 'success', '新任务真实执行完成');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// C1-e：服务重启后取消状态不反弹
// ============================================================
test('C1 服务重启后取消状态不反弹：仍无 running job/attempt，item 仍 cancelled', async () => {
  const tid = 'tenant:r3c1e', pid = 'projR3C1E', cid = 'c-c1e';
  seedProject(tid, pid, [comp(cid, 1)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  writeProject(tid, pid, []);
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  CollectJobs.setExecutorForTest(null);

  const script = `
    process.env.ZB_DATA_DIR = ${JSON.stringify(TMP)};
    process.env.ZB_FIRST_COLLECTION_DISABLED = '1';
    require(${JSON.stringify(require.resolve('../services/first-collection.js'))}).resumePending();
    const d = require(${JSON.stringify(require.resolve('../services/collect-jobs.js'))}).getDb();
    const jobs = d.prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND status='running'").get(${JSON.stringify(tid)}, ${JSON.stringify(pid)}).n;
    const atts = d.prepare("SELECT COUNT(*) AS n FROM collection_attempts WHERE tenant_id=? AND project_id=? AND status='running'").get(${JSON.stringify(tid)}, ${JSON.stringify(pid)}).n;
    const items = d.prepare("SELECT COUNT(*) AS n FROM first_collection_items WHERE tenant_id=? AND project_id=? AND state='cancelled' AND in_scope=0").get(${JSON.stringify(tid)}, ${JSON.stringify(pid)}).n;
    console.log(JSON.stringify({ jobs, atts, items }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim().split('\n').pop();
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.jobs, 0, '重启后无 running job: ' + out);
  assert.strictEqual(parsed.atts, 0, '重启后无 running attempt: ' + out);
  assert.strictEqual(parsed.items, 6, '6 个 item 仍为 cancelled: ' + out);
  assert.strictEqual(itemRow(tid, pid, cid, 'public_site_products').state, 'cancelled');
});

// ============================================================
// M1：市场解析矩阵
// ============================================================
test('M1 市场解析矩阵：项目地区回退 + 区域词仍 unknown（不得猜国家）', async () => {
  // ① 品牌 market 空 + 项目 US → out_of_coverage
  {
    const tid = 'tenant:r3m1a', pid = 'projR3M1A', cid = 'c-m1a';
    seedProject(tid, pid, [comp(cid, 1, '')], ['us']);
    FC.ensureBatch({ tenantId: tid, projectId: pid });
    const it = itemRow(tid, pid, cid, 'tiktok_commercial_content');
    assert.strictEqual(it.state, 'out_of_coverage', '空 market + 项目 US → 覆盖外: ' + it.state);
    assert.ok(/US/.test(it.failure_text), '覆盖说明包含归一后的市场: ' + it.failure_text);
    assert.ok(/零结果不代表该市场没有广告|未覆盖国家不代表没有广告/.test(it.failure_text), '覆盖外不得暗示没有广告');
    assert.strictEqual(q1("SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND capability='tiktok_commercial_content'", tid, pid).n, 0,
      '覆盖外不产生任务（不得显示 0 条广告）');
    const mk = BrandMarket.resolveBrandMarket({ market: '' }, { regions: ['us'] });
    assert.strictEqual(mk.source, 'project_intent');
    assert.strictEqual(mk.brandMarket, 'US');
  }
  // ② 品牌 market DE + 项目 US → covered
  {
    const tid = 'tenant:r3m1b', pid = 'projR3M1B', cid = 'c-m1b';
    seedProject(tid, pid, [comp(cid, 2, 'DE')], ['us']);
    const mk = BrandMarket.resolveBrandMarket({ market: 'DE' }, { regions: ['us'] });
    assert.strictEqual(mk.coverageState, 'covered', '品牌自身市场优先于项目地区');
    assert.strictEqual(mk.brandMarket, 'DE');
  }
  // ③ 品牌 market 空 + 项目「北美」→ unknown（不猜成 US）
  {
    const tid = 'tenant:r3m1c', pid = 'projR3M1C', cid = 'c-m1c';
    seedProject(tid, pid, [comp(cid, 3, '')], ['北美']);
    FC.ensureBatch({ tenantId: tid, projectId: pid });
    const it = itemRow(tid, pid, cid, 'tiktok_commercial_content');
    assert.strictEqual(it.state, 'not_configured', '区域词 → unknown，不判覆盖外: ' + it.state);
    assert.ok(/未确定/.test(it.failure_text));
    assert.ok(/不代表该市场没有广告/.test(it.failure_text), 'unknown 不得显示没有广告');
    const mk = BrandMarket.resolveBrandMarket({ market: '' }, { regions: ['北美'] });
    assert.strictEqual(mk.coverageState, 'unknown');
    assert.strictEqual(mk.brandMarket, null, '区域词不得被归一成国家');
  }
  // ④ 广告覆盖投影使用同一函数（品牌无 market 时回退项目地区）
  {
    const tid = 'tenant:r3m1d', pid = 'projR3M1D', cid = 'c-m1d';
    seedProject(tid, pid, [comp(cid, 4, '')], ['us']);
    const digest = BrandSvc.buildCollectionDigest(tid, pid, { id: cid, market: '' });
    assert.ok(digest.ads, '有广告覆盖投影');
    assert.strictEqual(digest.ads.coverage, 'out_of_coverage', '投影也走项目地区回退');
    assert.strictEqual(digest.ads.brandMarket, 'US');
    assert.strictEqual(digest.ads.marketSource, 'project_intent');
  }
});

test('M2 源码级断言：首采模块不得再出现独立市场判断旁路', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'first-collection.js'), 'utf8');
  // 去掉注释行，只看真实代码
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(/BrandMarket\.resolveBrandMarket\(/.test(code), '必须使用唯一市场解析入口');
  assert.ok(!/TikTokAdLib\.marketCoverage\(/.test(code), '不得在首采模块自行调用覆盖判定');
  assert.ok(!/comp\.market\b(?!\s*:)/.test(code), '不得直接读取未经回退的 comp.market');
  assert.ok(!/\.market\s*\|\|/.test(code), '不得自行写市场回退');
});

// ============================================================
// D1：complete / partial 比较矩阵
// ============================================================
function attemptOf(status, observations, summary, extra) {
  return Object.assign({
    attemptId: 'att_' + Math.random().toString(36).slice(2, 10),
    status, observations, summary: summary || {}, snapshotIds: ['snap_x'], evidenceIds: ['ev_x'],
  }, extra || {});
}
function products(n, priceOf) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'p-' + i, title: 'Item ' + i, price: priceOf ? priceOf(i) : 100 + i, currency: 'USD', available: true,
  }));
}
const FULL = { partialScan: false, discoveryPath: 'sitemap', measurementMethod: 'public_source_observation' };
const PARTIAL = { partialScan: true, partialScanReason: '后续分页失败', discoveryPath: 'sitemap', measurementMethod: 'public_source_observation' };

test('D1 完整 10 件 → partial 3 件：零 product_removed（没抓到不等于下架）', () => {
  const prev = attemptOf('success', products(10), Object.assign({ productCount: 10 }, FULL));
  const cur = attemptOf('partial', products(3), Object.assign({ productCount: 3 }, PARTIAL));
  const changes = Diff.computeChanges('public_site_products', prev, cur);
  assert.strictEqual(changes.filter(c => c.eventType === 'product_removed').length, 0, '零下架事件');
  assert.strictEqual(changes.length, 0, '没有其他可比值时不产事件: ' + JSON.stringify(changes.map(c => c.eventType)));
});

test('D1 完整 10 件 → 完整 9 件：恰好一条 product_removed', () => {
  const prev = attemptOf('success', products(10), Object.assign({ productCount: 10 }, FULL));
  const cur = attemptOf('success', products(9), Object.assign({ productCount: 9 }, FULL));
  const changes = Diff.computeChanges('public_site_products', prev, cur);
  const removed = changes.filter(c => c.eventType === 'product_removed');
  assert.strictEqual(removed.length, 1, '恰好一条下架');
  assert.strictEqual(removed[0].subjectId, 'p-9');
  assert.strictEqual(removed[0].change.scopeLimited, false);
});

test('D1 partial 中同一商品价格变化仍可记录，并标注范围受限', () => {
  const prev = attemptOf('success', products(10), Object.assign({ productCount: 10 }, FULL));
  const cur = attemptOf('partial', [{ id: 'p-0', title: 'Item 0', price: 130, currency: 'USD', available: true }],
    Object.assign({ productCount: 1 }, PARTIAL));
  const changes = Diff.computeChanges('public_site_products', prev, cur);
  const price = changes.filter(c => c.eventType === 'price_changed');
  assert.strictEqual(price.length, 1, '同 ID 价格变化可记录');
  assert.strictEqual(price[0].change.oldValue, 100);
  assert.strictEqual(price[0].change.newValue, 130);
  assert.strictEqual(price[0].change.scopeLimited, true, '必须标注本次采集范围受限');
  assert.ok(/范围受限/.test(price[0].summary), '文案说明只代表已抓取到的部分');
  assert.strictEqual(changes.filter(c => c.eventType === 'product_removed').length, 0, 'partial 不产下架');
});

test('D1 社媒第一页 20 条 → partial 10 条：零内容减少', () => {
  const mk = (n, extra) => attemptOf(extra.status, Array.from({ length: n }, (_, i) => ({ id: 'v-' + i, title: 'V' + i })),
    Object.assign({ videoCount: n, measurementMethod: 'public_source_observation', channelId: 'UC1', periodStart: '2026-01-01', periodEnd: '2026-10-01' },
      extra.status === 'partial' ? { partialScan: true } : { partialScan: false }));
  const prev = mk(20, { status: 'success' });
  const cur = mk(10, { status: 'partial' });
  const changes = Diff.computeChanges('youtube_content', prev, cur);
  assert.strictEqual(changes.filter(c => c.change && c.change.field === 'contentCount').length, 0, '零「内容减少」事件');
});

test('D1 查询范围或 discoveryPath 改变：零删除/数量下降事件', () => {
  // ① 发现路径从 sitemap 变 jsonld（样本集合完全不同）
  const prev = attemptOf('success', products(10), Object.assign({ productCount: 10 }, FULL));
  const cur = attemptOf('success', products(4), Object.assign({ productCount: 4 }, Object.assign({}, FULL, { discoveryPath: 'jsonld' })));
  const c1 = Diff.computeChanges('public_site_products', prev, cur);
  assert.strictEqual(c1.filter(c => c.eventType === 'product_removed').length, 0, '发现路径改变不判下架');

  // ② 社媒渠道范围改变
  const mkS = (n, ch) => attemptOf('success', Array.from({ length: n }, (_, i) => ({ id: 'v-' + i, title: 'V' })),
    { videoCount: n, measurementMethod: 'public_source_observation', channelId: ch, periodStart: '2026-01-01', periodEnd: '2026-10-01', partialScan: false });
  const c2 = Diff.computeChanges('youtube_content', mkS(20, 'UC1'), mkS(10, 'UC2'));
  assert.strictEqual(c2.length, 0, '查询范围改变 → 条数不可比，零事件: ' + JSON.stringify(c2.map(c => c.change)));

  // ③ 评论周期改变
  const mkR = (n, p) => attemptOf('success', [], { reviewCount: n, measurementMethod: 'public_source_observation', periodStart: p, periodEnd: p, partialScan: false });
  const c3 = Diff.computeChanges('public_reviews', mkR(100, '2026-01-01'), mkR(60, '2026-06-01'));
  assert.strictEqual(c3.length, 0, '周期不同 → 评论数不可比');
});

test('D1 评论完整 100 → complete 90 才算下降；partial 90 不算', () => {
  const mkR = (n, partial) => attemptOf(partial ? 'partial' : 'success', [],
    { reviewCount: n, measurementMethod: 'public_source_observation', periodStart: '2026-01-01', periodEnd: '2026-10-01', partialScan: partial });
  const declineComplete = Diff.computeChanges('public_reviews', mkR(100, false), mkR(90, false));
  assert.strictEqual(declineComplete.length, 1, '两次完整 → 允许下降事件');
  assert.strictEqual(declineComplete[0].change.oldValue, 100);
  const declinePartial = Diff.computeChanges('public_reviews', mkR(100, false), mkR(90, true));
  assert.strictEqual(declinePartial.length, 0, 'partial → 不判评论减少');
});

// ============================================================
// D2：事件证据必须来自本次真实 Snapshot/Evidence
// ============================================================
test('D2 监控用途事件：partial 不产下架，价格事件引用本次快照证据', async () => {
  const tid = 'tenant:r3d2', pid = 'projR3D2', cid = 'c-d2';
  seedProject(tid, pid, [comp(cid, 1)]);
  // 第一次完整观察（10 件）
  const mk1 = SurfaceStore.createAttempt({ tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products', dimension: 'website_products', trigger: 'schedule', idempotencyKey: 'r3-d2-1' });
  const a1 = mk1.attempt;
  SurfaceStore.completeAttempt(tid, a1.attemptId, {
    status: 'success', observations: products(10), summary: Object.assign({ productCount: 10 }, FULL),
    snapshotIds: ['snap-prev'], evidenceIds: ['ev-prev'],
  });
  const prev = SurfaceStore.getAttempt(tid, a1.attemptId);

  // 第二次 partial 观察（3 件，其中 p-0 涨价）
  const mk2 = SurfaceStore.createAttempt({ tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products', dimension: 'website_products', trigger: 'schedule', idempotencyKey: 'r3-d2-2' });
  const a2 = mk2.attempt;
  const obs = products(3);
  obs[0].price = 188;
  SurfaceStore.completeAttempt(tid, a2.attemptId, {
    status: 'partial', sourceStatus: 'partial',
    observations: obs, summary: Object.assign({ productCount: 3, partialScanReason: '后续分页失败' }, PARTIAL),
    snapshotIds: ['snap-cur-1', 'snap-cur-2'], evidenceIds: ['ev-cur'],
  });
  const cur = SurfaceStore.getAttempt(tid, a2.attemptId);

  const res = Diff.applyChanges({
    tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products',
    attempt: cur, previousAttempt: prev,
    collectionPurpose: 'monitoring', windowKey: 'wt_r3:W1', brandName: 'Brand1', sourceUrl: 'https://x.example.com/',
  });
  assert.strictEqual(res.purpose, 'monitoring');
  const box = Inbox.listInbox({ tenantId: tid, projectId: pid });
  assert.strictEqual(box.groups.flatMap(g => g.events).filter(e => e.eventType === 'product_removed').length, 0, 'partial 不产下架');
  const ev = box.groups.flatMap(g => g.events).find(e => e.eventType === 'price_changed');
  assert.ok(ev, '价格变化事件存在');
  assert.strictEqual(ev.windowKey, 'wt_r3:W1');
  const refs = (ev.evidenceRefs || []).map(r => r.snapshotId).filter(Boolean);
  assert.deepStrictEqual(refs, ['snap-cur-1', 'snap-cur-2'], '证据引用来自本次真实快照，不是上一次');
});

// ============================================================
// E1：removedBrandsCount 品牌口径
// ============================================================
test('E1 移除一个品牌（6 个能力 item）→ removedBrandsCount=1；移除两个 → 2', async () => {
  const tid = 'tenant:r3e1', pid = 'projR3E1';
  const a = comp('c-e1-a', 1), b = comp('c-e1-b', 2);
  seedProject(tid, pid, [a, b]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await drain();
  assert.strictEqual(itemRow(tid, pid, 'c-e1-a', 'public_site_products') ? 1 : 0, 1);

  // 移除 A
  writeProject(tid, pid, [b]);
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  let s = FC.summaryForProject(tid, pid);
  assert.strictEqual(s.removedBrandsCount, 1, '一个品牌 6 个 item 只计 1: ' + s.removedBrandsCount);
  assert.strictEqual(s.brandsTotal, 1, '移除品牌不计入当前品牌总数');
  assert.strictEqual(s.totalItems, 6, 'item 口径仍为 6（B 的 6 个能力项）');

  // 再移除 B
  writeProject(tid, pid, []);
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  s = FC.summaryForProject(tid, pid);
  assert.strictEqual(s.removedBrandsCount, 2, '两个品牌 → 2');
  assert.strictEqual(s.brandsTotal, 0);

  // 历史 item 保留（12 条，全部 in_scope=0），且租户隔离
  const all = q1('SELECT COUNT(*) AS n FROM first_collection_items WHERE tenant_id=? AND project_id=?', tid, pid).n;
  assert.strictEqual(all, 12, '历史 item 保留用于审计');
  const other = q1('SELECT COUNT(*) AS n FROM first_collection_items WHERE tenant_id=?', 'tenant:r3e1-other').n;
  assert.strictEqual(other, 0, '其它租户看不到');
  const otherSummary = FC.summaryForProject('tenant:r3e1-other', pid);
  assert.strictEqual(otherSummary, null, '跨租户无摘要');
  CollectJobs.setExecutorForTest(null);
});
