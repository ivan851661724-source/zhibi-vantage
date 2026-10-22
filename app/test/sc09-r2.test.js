'use strict';
// ============================================================
// test/sc09-r2.test.js —— SC-09 合并前整改 r2
// ------------------------------------------------------------
// R1  首采任务身份：后续正式监控采集不改写首采 item/batch；监控事件窗口来自真实窗口
// R2  凭据恢复：not_configured → 配置就绪后自动恢复且只入队一次；重复轮询/重启不双任务
// R3  覆盖限制：美国广告 out_of_coverage 不重试；市场改为覆盖国后才重新评估
// R4  计划对账：新增品牌只补自己的任务；既有品牌零新增；重复进入无双任务
// R5  移出品牌：未执行任务取消、进度不再计算、不显示成采集失败
// R6  能力对账：缺失 item（Registry 新增能力）自动补齐
// R7  并发 GET：不产生双批次/双任务/双 item
// R8  服务重启：不产生双任务
// R9  两租户隔离
// R10 执行状态与覆盖状态分离
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc09r2-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.ZB_FIRST_COLLECTION_DISABLED = '1';
process.env.CACHE_ENABLED = '0';
try { fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true }); } catch (e) {}

const SurfaceStore = require('../services/surface-store.js');
const WS = require('../services/watch-store.js');
const CollectJobs = require('../services/collect-jobs.js');
const CollectReq = require('../services/collect-request.js');
const FC = require('../services/first-collection.js');
const Inbox = require('../services/intel-inbox.js');
const CoreH = require('../routes/handlers/core-product.js');
const { projFile, mirrorProjectToDb } = require('../core/state-store.js');
const db = require('../services/db.js');

const HOST_BASE = 'acme-sc09r2';

// ---------- 夹具 ----------
function comp(id, n, isShopify, market) {
  return {
    id, name: 'Brand' + n, url: `https://${HOST_BASE}-${n}.example.com/`, status: 'done',
    isShopify: !!isShopify, market: market || 'us', relation: 'competitor', category: 'outdoor',
  };
}
function writeProject(tenantId, projectId, compsArr) {
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    tenantId, projectId, intent: { regions: ['us'], category: 'outdoor' }, excluded: [],
    competitors: compsArr, discoverDone: true, progress: { total: compsArr.length, done: compsArr.length },
  }, null, 2));
}
function seedProject(tenantId, projectId, compsArr) {
  try { db.createTenant({ name: 't-' + tenantId, email: tenantId.replace(/[^a-z0-9]/gi, '') + '@example.com' }); } catch (e) {}
  try {
    db.saveProject({ id: projectId, tenantId, track: 'T-' + projectId, competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  } catch (e) {}
  writeProject(tenantId, projectId, compsArr);
  try { mirrorProjectToDb(projectId, tenantId, 'SC09R2'); } catch (e) {}
}
function mkCtx(tid, body) {
  return {
    getAuthPayload: () => (tid ? { kind: 'tenant', payload: { tid } } : null),
    getCurrentId: () => '',
    readBody: async () => body || {},
    sendJSON: (res, status, b) => { res.status = status; res.body = b; return true; },
    projFile: (pid, t) => projFile(pid, t),
    loadState: () => null,
  };
}
async function callBrands(tid, projectId) {
  const res = {};
  await CoreH.brandsList(mkCtx(tid), { method: 'GET', headers: {}, on: () => {} }, res, new URL('http://local/api/brands?projectId=' + projectId), '/api/brands');
  return res;
}
async function callStatus(tid, projectId) {
  const res = {};
  await CoreH.firstCollectionStatus(mkCtx(tid), { method: 'GET', headers: {}, on: () => {} }, res, new URL('http://local/api/first-collection?projectId=' + projectId), '/api/first-collection');
  return res;
}
async function callRetry(tid, projectId) {
  const res = {};
  await CoreH.firstCollectionRetry(mkCtx(tid, { projectId }), { method: 'POST', headers: {}, on: () => {} }, res, new URL('http://local/api/first-collection/retry-failed'), '/api/first-collection/retry-failed');
  return res;
}
function drain() {
  return (async () => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const r = await CollectJobs.tick({ workerId: 'w-sc09r2-' + Math.random().toString(36).slice(2, 8) });
      const n = CollectJobs.getDb().prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE status IN ('pending','running')").get().n;
      if (!r.claimed && n === 0) return;
      if (Date.now() > deadline) throw new Error('drain 超时');
      await new Promise(res => setTimeout(res, 15));
    }
  })();
}
function makeExecutor(plan) {
  const p = plan || {};
  return async (job) => {
    const byComp = p.byCompetitor && p.byCompetitor[job.competitorId];
    let status = 'success';
    let observations = [];
    if (job.capability === 'public_site_products' || job.capability === 'shopify_catalog') {
      observations = (p.products || []).map(x => ({
        id: x.id, title: x.title, price: x.price, currency: x.currency || 'USD',
        available: x.available !== false, sourceUrl: x.sourceUrl || null,
      }));
      status = observations.length ? 'success' : 'empty';
    }
    if (byComp === 'failed') {
      SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
        status: 'failed', sourceStatus: 'blocked', errorClass: 'blocked',
        errorUserText: '来源站点拒绝访问。', observations: [], snapshotIds: [], evidenceIds: [],
      }, null);
      return { attempt: SurfaceStore.getAttempt(job.tenantId, job.attemptId) };
    }
    SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
      status: 'success',
      observations,
      summary: job.capability === 'public_reviews' ? { kind: 'reviews_digest', reviewCount: p.reviewCount == null ? 0 : p.reviewCount } : {},
      snapshotIds: ['snap-' + job.attemptId],
      evidenceIds: ['ev-' + job.attemptId],
    }, null);
    return { attempt: SurfaceStore.getAttempt(job.tenantId, job.attemptId) };
  };
}
function jobCount(tid, pid, capability) {
  const sql = capability
    ? "SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND capability=?"
    : 'SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=?';
  const args = capability ? [tid, pid, capability] : [tid, pid];
  return CollectJobs.getDb().prepare(sql).get(...args).n;
}
function jobCountFor(tid, pid, cid) {
  return CollectJobs.getDb().prepare('SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=?').get(tid, pid, cid).n;
}
function itemCount(tid, pid) {
  return CollectJobs.getDb().prepare('SELECT COUNT(*) AS n FROM first_collection_items WHERE tenant_id=? AND project_id=?').get(tid, pid).n;
}
function rowOf(tid, pid, cid, cap) {
  return CollectJobs.getDb().prepare('SELECT * FROM first_collection_items WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=?')
    .get(tid, pid, cid, cap);
}
function withEnv(keys, fn) {
  return (async () => {
    const saved = {};
    for (const k of Object.keys(keys)) { saved[k] = process.env[k]; process.env[k] = keys[k]; }
    try { return await fn(); } finally {
      for (const k of Object.keys(keys)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    }
  })();
}

// ============================================================
// R1：后续正式监控采集不得改写首采 item / batch
// ============================================================
test('R1 正式监控采集不改写首采 item/batch；监控事件窗口来自真实窗口', async () => {
  const tid = 'tenant:sc09r2r1';
  const pid = 'projSc09R2R1';
  const cid = 'c-r1-a';
  seedProject(tid, pid, [comp(cid, 1, false)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await drain();
  const itemBefore = JSON.stringify(FC.listItems(tid, pid));
  const batchBefore = JSON.stringify(FC.getBatch(tid, pid));

  const target = WS.createWatchTarget({
    tenantId: tid, projectId: pid, competitorId: cid,
    market: 'us', timezone: 'UTC', enabledSignals: ['price'], supportedSignals: ['price'],
    enrichmentStatus: 'complete',
  }).target;
  const win = WS.claimWindow(target, 'W1', '06:00', Date.now(), Date.now());
  // 正式监控的一条采集任务：显式 collectionPurpose=monitoring + 真实窗口键
  const compObj = CollectJobs.loadCompetitor({ tenantId: tid, projectId: pid, competitorId: cid });
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 47 }] }));
  const r = CollectReq.requestCollection({
    tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products',
    comp: compObj, trigger: 'schedule', tickNow: false,
    idempotencyKey: 'sc09r2-monitor-1', collectionPurpose: 'monitoring', windowKey: win.windowId,
  });
  assert.strictEqual(r.status, 'accepted');
  await drain();

  // ① 首采事实完全未被改写
  assert.strictEqual(JSON.stringify(FC.listItems(tid, pid)), itemBefore, '首采 item 未被正式监控改写');
  assert.strictEqual(JSON.stringify(FC.getBatch(tid, pid)), batchBefore, '首采批次未被正式监控改写');
  // ② 监控事件用真实窗口键写入收件箱
  const box = Inbox.listInbox({ tenantId: tid, projectId: pid });
  assert.strictEqual(box.total, 1, '监控用途的变化写入收件箱: ' + box.total);
  const ev = box.groups[0].events[0];
  assert.strictEqual(ev.windowKey, win.windowId, 'windowKey = 真实监控窗口');
  assert.ok(!/first_collection:/.test(JSON.stringify(box)), '收件箱不含首采批次窗口');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// R2：凭据配置后的自动恢复
// ============================================================
test('R2 not_configured 在凭据就绪后自动恢复，且只入队一次（重复轮询/重启不双任务）', async () => {
  delete process.env.YOUTUBE_API_KEY;
  const tid = 'tenant:sc09r2r2';
  const pid = 'projSc09R2R2';
  const cid = 'c-r2-a';
  seedProject(tid, pid, [comp(cid, 1, false)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));

  FC.ensureBatch({ tenantId: tid, projectId: pid });
  const yt0 = rowOf(tid, pid, cid, 'youtube_content');
  assert.strictEqual(yt0.state, 'not_configured', '无 key → not_configured');
  assert.strictEqual(jobCount(tid, pid, 'youtube_content'), 0, '未配置时不发请求');
  const baseJobs = jobCount(tid, pid);

  // 重复进入 / 重复轮询：不得反复请求外部服务
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await callStatus(tid, pid);
  await callBrands(tid, pid);
  assert.strictEqual(jobCount(tid, pid, 'youtube_content'), 0, '仍无 key：不产生任务');
  assert.strictEqual(jobCount(tid, pid), baseJobs, '未配置项不产生任何新任务');

  // 配置就绪 → 重新对账：恰好新增一个任务
  await withEnv({ YOUTUBE_API_KEY: 'yt-test-key' }, async () => {
    await callStatus(tid, pid);
    assert.strictEqual(jobCount(tid, pid, 'youtube_content'), 1, '配置就绪后自动补 1 个任务');
    const yt1 = rowOf(tid, pid, cid, 'youtube_content');
    assert.ok(['queued', 'running'].includes(yt1.state), '恢复项进入待执行状态: ' + yt1.state);
    // 重复轮询不产生第二个任务
    await callStatus(tid, pid);
    await callStatus(tid, pid);
    await callBrands(tid, pid);
    assert.strictEqual(jobCount(tid, pid, 'youtube_content'), 1, '重复轮询不产生第二个任务');

    // 服务重启（子进程）仍只保留一个任务
    const script = `
      process.env.ZB_DATA_DIR = ${JSON.stringify(TMP)};
      process.env.ZB_FIRST_COLLECTION_DISABLED = '1';
      process.env.YOUTUBE_API_KEY = 'yt-test-key';
      const FC = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'first-collection.js'))});
      FC.resumePending();
      const n = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'collect-jobs.js'))}).getDb()
        .prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND capability='youtube_content'")
        .get(${JSON.stringify(tid)}, ${JSON.stringify(pid)}).n;
      console.log(JSON.stringify({ yt: n }));
    `;
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim().split('\n').pop();
    assert.strictEqual(JSON.parse(out).yt, 1, '重启对账后仍只有一个任务: ' + out);

    await drain();
    const ytDone = rowOf(tid, pid, cid, 'youtube_content').state;
    assert.ok(['success', 'empty'].includes(ytDone), '恢复的任务真实执行完成（无结果即 empty）: ' + ytDone);
  });

  // 配置再次缺失：已完成项不重跑，也不会再请求
  const jobsAfter = jobCount(tid, pid, 'youtube_content');
  const stateBefore = rowOf(tid, pid, cid, 'youtube_content').state;
  delete process.env.YOUTUBE_API_KEY;
  await callStatus(tid, pid);
  await callBrands(tid, pid);
  assert.strictEqual(jobCount(tid, pid, 'youtube_content'), jobsAfter, '配置再次缺失不产生新请求');
  assert.strictEqual(rowOf(tid, pid, cid, 'youtube_content').state, stateBefore, '已完成项保持真实结果');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// R3：覆盖限制（美国广告）
// ============================================================
test('R3 美国广告 out_of_coverage 不重试；市场改为覆盖国后才重新评估广告来源', async () => {
  const tid = 'tenant:sc09r2r3';
  const pid = 'projSc09R2R3';
  const cid = 'c-r3-a';
  const c1 = comp(cid, 1, false, 'us');
  seedProject(tid, pid, [c1]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));
  await withEnv({ TIKTOK_CLIENT_KEY: 'tt-key', TIKTOK_CLIENT_SECRET: 'tt-secret' }, async () => {
    FC.ensureBatch({ tenantId: tid, projectId: pid });
    const ad = rowOf(tid, pid, cid, 'tiktok_commercial_content');
    assert.strictEqual(ad.state, 'out_of_coverage', '美国市场：来源无覆盖');
    assert.strictEqual(jobCount(tid, pid, 'tiktok_commercial_content'), 0, '不覆盖就不发任务、不显示 0 条广告');

    // 重试按钮不得把 out_of_coverage 变成任务
    const retry = await callRetry(tid, pid);
    assert.strictEqual(retry.status, 200);
    assert.strictEqual(jobCount(tid, pid, 'tiktok_commercial_content'), 0, '覆盖外来源不重试');

    // 品牌市场改为覆盖国（DE）→ 重新评估 → 才产生一个任务
    c1.market = 'de';
    writeProject(tid, pid, [c1]);
    await callStatus(tid, pid);
    const ad2 = rowOf(tid, pid, cid, 'tiktok_commercial_content');
    assert.ok(['queued', 'running'].includes(ad2.state), '市场进入覆盖范围后才排队: ' + ad2.state);
    assert.strictEqual(jobCount(tid, pid, 'tiktok_commercial_content'), 1, '只补一个任务');
    await callStatus(tid, pid);
    assert.strictEqual(jobCount(tid, pid, 'tiktok_commercial_content'), 1, '重复轮询不重复入队');
  });
  await drain();
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// R4：新增品牌对账
// ============================================================
test('R4 项目新增第三品牌只补它的任务；前两品牌零新增；重复进入无双任务', async () => {
  const tid = 'tenant:sc09r2r4';
  const pid = 'projSc09R2R4';
  const a = comp('c-r4-a', 1, false);
  const b = comp('c-r4-b', 2, false);
  seedProject(tid, pid, [a, b]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await drain();
  const jobsA0 = jobCountFor(tid, pid, 'c-r4-a');
  const jobsB0 = jobCountFor(tid, pid, 'c-r4-b');
  const items0 = itemCount(tid, pid);

  // 项目后来新增第三品牌（真实状态文件变化）
  const c = comp('c-r4-c', 3, false);
  writeProject(tid, pid, [a, b, c]);
  const res = await callBrands(tid, pid);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(jobCountFor(tid, pid, 'c-r4-a'), jobsA0, '既有品牌 A 零新增任务');
  assert.strictEqual(jobCountFor(tid, pid, 'c-r4-b'), jobsB0, '既有品牌 B 零新增任务');
  assert.strictEqual(jobCountFor(tid, pid, 'c-r4-c'), 2, '只为第三品牌补 2 个可执行任务（官网 + 商品）');
  assert.strictEqual(itemCount(tid, pid), items0 + 6, '第三品牌补 6 个能力 item');
  const batch = FC.getBatch(tid, pid);
  assert.strictEqual(Number(batch.total_brands), 3, '批次品牌数已更新');
  assert.strictEqual(Number(batch.total_items), items0 + 6, '批次 item 数已更新');

  // 重复进入不产生双任务
  await callBrands(tid, pid);
  await callStatus(tid, pid);
  assert.strictEqual(jobCountFor(tid, pid, 'c-r4-c'), 2, '重复进入无双任务');
  await drain();
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// R5：移出品牌
// ============================================================
test('R5 品牌被移出项目：未执行任务取消、进度不再计算、不显示成采集失败', async () => {
  const tid = 'tenant:sc09r2r5';
  const pid = 'projSc09R2R5';
  const a = comp('c-r5-a', 1, false);
  const b = comp('c-r5-b', 2, false);
  seedProject(tid, pid, [a, b]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  assert.strictEqual(jobCountFor(tid, pid, 'c-r5-b'), 2, 'B 已排 2 个任务（尚未执行）');
  const attemptsB0 = SurfaceStore.listAttempts(tid, pid, 'c-r5-b', 'public_site_products', 5).length;

  // 用户把 B 移出项目
  writeProject(tid, pid, [a]);
  await callStatus(tid, pid);

  const rowsB = FC.listItems(tid, pid, 'c-r5-b', { includeOutOfScope: true });
  assert.ok(rowsB.length > 0, '历史记录保留（不删除）');
  assert.ok(rowsB.every(r => Number(r.in_scope) === 0), '全部转为不在范围内');
  assert.ok(rowsB.every(r => r.state === 'cancelled'), '状态为 cancelled（不是 failed）: ' + rowsB.map(r => r.state).join(','));
  const pendingB = CollectJobs.getDb().prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=? AND status='pending'")
    .get(tid, pid, 'c-r5-b').n;
  assert.strictEqual(pendingB, 0, 'B 的未执行任务已取消');

  const sum = FC.summaryForProject(tid, pid);
  assert.strictEqual(sum.brandsTotal, 1, '进度只计算仍在项目内的品牌');
  assert.strictEqual(sum.failedCount, 0, '移出品牌不计为采集失败');
  assert.strictEqual(sum.brandsNeedsAttention, 0, '移出品牌不进入「需要处理」');

  // 执行后：B 不会被采集（没有新 attempt）
  await drain();
  const attemptsB1 = SurfaceStore.listAttempts(tid, pid, 'c-r5-b', 'public_site_products', 5).length;
  assert.strictEqual(attemptsB1, attemptsB0, '移出品牌不再执行采集');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// R6：能力补齐（Registry 新增能力 → 缺失 item）
// ============================================================
test('R6 缺失的能力 item 在对账时自动补齐（只补缺失项，不重跑既有项）', async () => {
  const tid = 'tenant:sc09r2r6';
  const pid = 'projSc09R2R6';
  const cid = 'c-r6-a';
  seedProject(tid, pid, [comp(cid, 1, false)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await drain();
  const jobs0 = jobCount(tid, pid);
  // 模拟「批次建立后 Registry 新增了一个能力」：该能力的 item 缺失
  CollectJobs.getDb().prepare("DELETE FROM first_collection_items WHERE tenant_id=? AND project_id=? AND capability='dataforseo_trends'").run(tid, pid);
  assert.strictEqual(rowOf(tid, pid, cid, 'dataforseo_trends'), undefined, '能力 item 已缺失');

  await callStatus(tid, pid);
  const back = rowOf(tid, pid, cid, 'dataforseo_trends');
  assert.ok(back, '缺失 item 已补齐');
  assert.strictEqual(back.state, 'not_configured', '无凭据的新能力如实未配置');
  assert.strictEqual(jobCount(tid, pid, 'dataforseo_trends'), 0, '未配置的新能力不发请求');
  assert.strictEqual(jobCount(tid, pid), jobs0, '既有能力零新增任务');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// R7：并发 GET
// ============================================================
test('R7 并发进入 /api/brands：只有一条批次、每品牌每能力一个 item、无双任务', async () => {
  const tid = 'tenant:sc09r2r7';
  const pid = 'projSc09R2R7';
  seedProject(tid, pid, [comp('c-r7-a', 1, false), comp('c-r7-b', 2, false)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));
  const results = await Promise.all([1, 2, 3, 4, 5].map(() => callBrands(tid, pid)));
  assert.ok(results.every(r => r.status === 200));
  const batches = CollectJobs.getDb().prepare('SELECT COUNT(*) AS n FROM first_collection_batches WHERE tenant_id=? AND project_id=?').get(tid, pid).n;
  assert.strictEqual(batches, 1, '只有一条批次');
  assert.strictEqual(itemCount(tid, pid), 12, '两品牌 × 6 能力，无重复 item');
  assert.strictEqual(jobCount(tid, pid), 4, '两品牌 × (官网 + 商品)，无双任务');
  await drain();
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// R8：服务重启
// ============================================================
test('R8 服务重启对账不产生双任务（已成功项不重跑）', async () => {
  const tid = 'tenant:sc09r2r8';
  const pid = 'projSc09R2R8';
  seedProject(tid, pid, [comp('c-r8-a', 1, false), comp('c-r8-b', 2, false)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await drain();
  const jobs0 = jobCount(tid, pid);
  const items0 = itemCount(tid, pid);
  const script = `
    process.env.ZB_DATA_DIR = ${JSON.stringify(TMP)};
    process.env.ZB_FIRST_COLLECTION_DISABLED = '1';
    const FC = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'first-collection.js'))});
    FC.resumePending();
    const d = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'collect-jobs.js'))}).getDb();
    const jobs = d.prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=?").get(${JSON.stringify(tid)}, ${JSON.stringify(pid)}).n;
    const items = d.prepare("SELECT COUNT(*) AS n FROM first_collection_items WHERE tenant_id=? AND project_id=?").get(${JSON.stringify(tid)}, ${JSON.stringify(pid)}).n;
    console.log(JSON.stringify({ jobs, items }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim().split('\n').pop();
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.jobs, jobs0, '重启不产生双任务: ' + out);
  assert.strictEqual(parsed.items, items0, '重启不产生重复 item');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// R9：两租户隔离
// ============================================================
test('R9 两租户的项目对账与任务完全隔离', async () => {
  const tidA = 'tenant:sc09r2r9a';
  const tidB = 'tenant:sc09r2r9b';
  const pidA = 'projSc09R2R9A';
  const pidB = 'projSc09R2R9B';
  seedProject(tidA, pidA, [comp('c-r9-a1', 1, false), comp('c-r9-a2', 2, false)]);
  seedProject(tidB, pidB, [comp('c-r9-b1', 3, false)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tidA, projectId: pidA });
  FC.ensureBatch({ tenantId: tidB, projectId: pidB });
  assert.strictEqual(jobCount(tidA, pidA), 4, 'A 租户 2 品牌 × 2 任务');
  assert.strictEqual(jobCount(tidB, pidB), 2, 'B 租户 1 品牌 × 2 任务');
  assert.strictEqual(itemCount(tidA, pidA), 12);
  assert.strictEqual(itemCount(tidB, pidB), 6);
  // 跨租户访问 → 404，且不影响 A
  const cross = await callBrands(tidB, pidA);
  assert.strictEqual(cross.status, 404);
  assert.strictEqual(itemCount(tidA, pidA), 12);
  await drain();
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// R10：执行状态与覆盖状态分离
// ============================================================
test('R10 executionStatus 与 coverageStatus 分离：执行完成 ≠ 数据齐全', async () => {
  const tid = 'tenant:sc09r2r10';
  const pid = 'projSc09R2R10';
  const cid = 'c-r10-a';
  seedProject(tid, pid, [comp(cid, 1, false)]);
  // ① 无第三方凭据：执行能结束，但覆盖不完整（未配置 + 覆盖外）
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await drain();
  const s1 = FC.summaryForProject(tid, pid);
  assert.strictEqual(s1.executionStatus, 'complete', '所有 item 到终态 → 执行完成');
  assert.strictEqual(s1.coverageStatus, 'partial', '仍有未配置来源 → 覆盖不完整');
  assert.ok(s1.notConfiguredCount >= 1, '如实统计未配置来源: ' + s1.notConfiguredCount);
  assert.strictEqual(s1.outOfCoverageCount, 1, '美国广告单独计为覆盖外');
  assert.strictEqual(s1.failedCount, 0, '没有采集失败');

  // ② 全部凭据就绪：覆盖完整（out_of_coverage 不算失败）
  const pid2 = 'projSc09R2R10B';
  seedProject(tid, pid2, [comp('c-r10-b', 2, false)]);
  await withEnv({
    SERPER_API_KEY: 's-key', YOUTUBE_API_KEY: 'y-key',
    DATAFORSEO_LOGIN: 'df-login', DATAFORSEO_PASSWORD: 'df-pass',
    TIKTOK_CLIENT_KEY: 'tt-key', TIKTOK_CLIENT_SECRET: 'tt-secret',
  }, async () => {
    FC.ensureBatch({ tenantId: tid, projectId: pid2 });
    await drain();
    const s2 = FC.summaryForProject(tid, pid2);
    assert.strictEqual(s2.executionStatus, 'complete');
    assert.strictEqual(s2.coverageStatus, 'complete', '全部来源已配置且无失败 → 覆盖完整: ' + JSON.stringify(s2.items));
    assert.strictEqual(s2.notConfiguredCount, 0);
    assert.strictEqual(s2.outOfCoverageCount, 1, '覆盖外来源单独计数、不算失败');
    assert.strictEqual(s2.failedCount, 0);
  });
  CollectJobs.setExecutorForTest(null);
});
