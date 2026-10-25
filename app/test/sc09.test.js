'use strict';
// ============================================================
// test/sc09.test.js —— SC-09 真实数据覆盖与自动首采
// ------------------------------------------------------------
// S1  调研完成后只创建一条项目首采批次（重复触发幂等）
// S2  15 个品牌按能力生成任务；重复触发不产生双任务
// S3  服务重启后未完成任务继续执行（子进程 resumePending）
// S4  一个品牌失败不阻塞其他品牌
// S5  首采不创建 WatchTarget（自动首采 ≠ 正式监控）
// S6  Shopify 与非 Shopify 商品路径分别生成 shopify_catalog / public_site_products
// S7  评论：搜索发现与正文采集严格分离（代码级）
// S8  首次采集只建立基线，不生成变化事件
// S9  第二次可比观察才生成 inbox 事件（价格变化）
// S10 两租户隔离（任务 / 观察 / 事件）
// S11 前端能区分全部采集状态
// S12 页面不得出现密钥、服务器路径、调用栈、内部环境变量名
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc09-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.ZB_FIRST_COLLECTION_DISABLED = '1'; // 测试里显式驱动，不跑定时器
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

const HOST_BASE = 'acme-sc09';

// ---------- 夹具 ----------
function comp(id, n, isShopify, market) {
  return {
    id, name: 'Brand' + n, url: `https://${HOST_BASE}-${n}.example.com/`, status: 'done',
    isShopify: !!isShopify, market: market || 'us', relation: 'competitor', category: 'outdoor',
  };
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
  try { mirrorProjectToDb(projectId, tenantId, 'SC09'); } catch (e) { /* 镜像失败不影响 */ }
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
async function callRetry(tid, projectId) {
  const res = {};
  await CoreH.firstCollectionRetry(mkCtx(tid, { projectId }), { method: 'POST', headers: {}, on: () => {} }, res, new URL('http://local/api/first-collection/retry-failed'), '/api/first-collection/retry-failed');
  return res;
}
function drain() {
  return (async () => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const r = await CollectJobs.tick({ workerId: 'w-sc09-' + Math.random().toString(36).slice(2, 8) });
      const n = CollectJobs.getDb().prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE status IN ('pending','claimed','running')").get().n;
      if (!r.claimed && n === 0) return;
      if (Date.now() > deadline) throw new Error('drain 超时');
      await new Promise(res => setTimeout(res, 15));
    }
  })();
}
// 执行器：按能力/品牌给出可控但**真实落库**的结果（attempt 行由 surface-store 写入）
function makeExecutor(plan) {
  const p = plan || {};
  return async (job) => {
    const byComp = p.byCompetitor && p.byCompetitor[job.competitorId];
    const failComp = byComp === 'failed';
    let status = 'success';
    let observations = [];
    if (job.capability === 'official_site_profile') {
      observations = [];
      status = 'success';
    } else if (job.capability === 'public_site_products' || job.capability === 'shopify_catalog') {
      observations = (p.products || []).map(x => ({
        id: x.id, title: x.title, price: x.price, currency: x.currency || 'USD',
        available: x.available !== false, sourceUrl: x.sourceUrl || null,
      }));
      status = observations.length ? 'success' : 'empty';
    } else if (job.capability === 'public_reviews') {
      observations = [];
    }
    if (failComp) {
      SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
        status: 'failed', sourceStatus: 'blocked', errorClass: 'blocked',
        errorUserText: '来源站点拒绝访问。', observations: [], snapshotIds: [], evidenceIds: [],
      }, null);
      return { attempt: SurfaceStore.getAttempt(job.tenantId, job.attemptId) };
    }
    SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
      status: status === 'empty' ? 'success' : status,
      observations,
      summary: job.capability === 'public_reviews' ? { kind: 'reviews_digest', reviewCount: p.reviewCount == null ? 0 : p.reviewCount } : {},
      snapshotIds: ['snap-' + job.attemptId],
      evidenceIds: ['ev-' + job.attemptId],
    }, null);
    return { attempt: SurfaceStore.getAttempt(job.tenantId, job.attemptId) };
  };
}
function jobCount(tid, pid) {
  return CollectJobs.getDb().prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=?").get(tid, pid).n;
}
function batchCount(tid, pid) {
  return CollectJobs.getDb().prepare('SELECT COUNT(*) AS n FROM first_collection_batches WHERE tenant_id=? AND project_id=?').get(tid, pid).n;
}
function itemCount(tid, pid) {
  return CollectJobs.getDb().prepare('SELECT COUNT(*) AS n FROM first_collection_items WHERE tenant_id=? AND project_id=?').get(tid, pid).n;
}

// ============================================================
// S1：只创建一条批次
// ============================================================
test('S1 调研完成后只创建一条项目首采批次；重复 ensure/HTTP 进入都不新建', async () => {
  const tid = 'tenant:sc09s1';
  const pid = 'projSc09S1';
  const comps = [comp('c-s1-a', 1, false), comp('c-s1-b', 2, true)];
  seedProject(tid, pid, comps);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Tent', price: 20 }] }));

  const b1 = FC.ensureBatch({ tenantId: tid, projectId: pid });
  assert.ok(b1 && b1.batch_id, '创建批次');
  assert.strictEqual(batchCount(tid, pid), 1, '只有一条批次');
  const b2 = FC.ensureBatch({ tenantId: tid, projectId: pid });
  assert.strictEqual(b2.batch_id, b1.batch_id, '重复 ensure 返回同一批次');
  assert.strictEqual(batchCount(tid, pid), 1);
  // HTTP 入口（GET /api/brands 会自动 ensure）
  await callBrands(tid, pid);
  await callBrands(tid, pid);
  assert.strictEqual(batchCount(tid, pid), 1, 'HTTP 重复进入仍只有一条批次');
  await drain();
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// S2：15 品牌 × 能力；重复触发无双任务
// ============================================================
test('S2 15 个品牌按能力生成任务；重复触发不产生双任务（含 HTTP 重复）', async () => {
  const tid = 'tenant:sc09s2';
  const pid = 'projSc09S2';
  const comps = Array.from({ length: 15 }, (_, i) => comp('c-s2-' + i, i + 1, false));
  seedProject(tid, pid, comps);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Mug', price: 12 }] }));

  FC.ensureBatch({ tenantId: tid, projectId: pid });
  const items1 = itemCount(tid, pid);
  // 非 Shopify、无第三方凭据、市场 us：每品牌 = 官网 + 公开商品 + 评论 + 内容 + 热度 + 广告 = 6 项
  assert.strictEqual(items1, 15 * 6, '每品牌 6 个能力项: ' + items1);
  const jobs1 = jobCount(tid, pid);
  assert.strictEqual(jobs1, 15 * 2, '只有官网与商品可真实入队（其余无凭据/不覆盖不平白发任务）: ' + jobs1);

  // 重复触发（服务层 + HTTP + 重启对账）
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await callBrands(tid, pid);
  FC.resumePending();
  assert.strictEqual(itemCount(tid, pid), items1, '重复触发不新增 item');
  assert.strictEqual(jobCount(tid, pid), jobs1, '重复触发不新增任务');
  await drain();
  assert.strictEqual(jobCount(tid, pid), jobs1, '执行完成后任务数仍不变');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// S3：重启续跑
// ============================================================
test('S3 服务重启后未完成任务继续执行（子进程 resumePending 重新入队）', async () => {
  const tid = 'tenant:sc09s3';
  const pid = 'projSc09S3';
  seedProject(tid, pid, [comp('c-s3-a', 1, false)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Lamp', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  const before = jobCount(tid, pid);
  assert.ok(before >= 2, '首采已入队: ' + before);

  // 模拟「入队后、执行前」进程崩溃：任务行丢失，item 仍是 queued
  CollectJobs.getDb().prepare('DELETE FROM collection_jobs WHERE tenant_id=? AND project_id=?').run(tid, pid);
  assert.strictEqual(jobCount(tid, pid), 0, '模拟崩溃后没有任务');

  // 子进程 = 服务重启：只做 resumePending（不重复建批次）
  const script = `
    process.env.ZB_DATA_DIR = ${JSON.stringify(TMP)};
    process.env.ZB_FIRST_COLLECTION_DISABLED = '1';
    const FC = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'first-collection.js'))});
    const r = FC.resumePending();
    const n = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'collect-jobs.js'))}).getDb()
      .prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=?").get(${JSON.stringify(tid)}, ${JSON.stringify(pid)}).n;
    console.log(JSON.stringify({ batches: r.batches, jobs: n }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim().split('\n').pop();
  const parsed = JSON.parse(out);
  // r2 §二.1：启动对账覆盖**全部**批次（凭据可能在停机期间补齐），因此批次数 ≥ 1；
  // 关键是：本项目不产生双任务，其它已完成的批次也不会被重跑。
  assert.ok(parsed.batches >= 1, '重启对账过既有批次');
  assert.strictEqual(parsed.jobs, before, '重启后任务数回到崩溃前数量（不产生双任务）: ' + out);

  await drain();
  const items = FC.listItems(tid, pid);
  const productItem = items.find(x => x.capability === 'public_site_products');
  assert.strictEqual(productItem.state, 'success', '续跑后商品项已完成: ' + productItem.state);
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// S4：单品牌失败不阻塞
// ============================================================
test('S4 一个品牌失败不阻塞其他品牌；批次如实为部分完成', async () => {
  const tid = 'tenant:sc09s4';
  const pid = 'projSc09S4';
  const comps = [comp('c-s4-a', 1, false), comp('c-s4-b', 2, false), comp('c-s4-c', 3, false)];
  seedProject(tid, pid, comps);
  CollectJobs.setExecutorForTest(makeExecutor({
    products: [{ id: 'p1', title: 'Chair', price: 99 }],
    byCompetitor: { 'c-s4-b': 'failed' },
  }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await drain();
  const items = FC.listItems(tid, pid);
  const a = items.filter(x => x.competitor_id === 'c-s4-a' && x.capability === 'public_site_products')[0];
  const b = items.filter(x => x.competitor_id === 'c-s4-b' && x.capability === 'public_site_products')[0];
  const c = items.filter(x => x.competitor_id === 'c-s4-c' && x.capability === 'public_site_products')[0];
  assert.strictEqual(a.state, 'success', 'A 成功');
  assert.strictEqual(b.state, 'failed', 'B 失败且记录原因: ' + b.state);
  assert.ok(b.failure_text && /拒绝/.test(b.failure_text), 'B 有用户可读失败原因: ' + b.failure_text);
  assert.strictEqual(c.state, 'success', 'C 不受 B 影响');
  const sum = FC.summaryForProject(tid, pid);
  assert.strictEqual(sum.status, 'partial', '批次状态 = 部分完成');
  assert.strictEqual(sum.brandsNeedsAttention, 1, '需要处理品牌数 = 1');
  // 重试失败项：只重排失败项
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Chair', price: 99 }] }));
  const r = await callRetry(tid, pid);
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.retried >= 1, '失败项已重排: ' + r.body.retried);
  await drain();
  const b2 = FC.listItems(tid, pid).filter(x => x.competitor_id === 'c-s4-b' && x.capability === 'public_site_products')[0];
  assert.strictEqual(b2.state, 'success', '重试后 B 成功');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// S5：首采不创建 WatchTarget
// ============================================================
test('S5 首采不创建 WatchTarget / 监控意向（自动首采 ≠ 持续监控）', async () => {
  const tid = 'tenant:sc09s5';
  const pid = 'projSc09S5';
  seedProject(tid, pid, [comp('c-s5-a', 1, false)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Bed', price: 50 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await drain();
  assert.strictEqual(WS.listWatchTargets(tid, pid).length, 0, '首采不创建 WatchTarget');
  const intents = require('../services/watch-intent.js').listIntents(tid, pid);
  assert.strictEqual(intents.length, 0, '首采不创建监控意向: ' + intents.length);
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// S6：Shopify / 非 Shopify 商品路径
// ============================================================
test('S6 Shopify 品牌走 shopify_catalog；非 Shopify 走 public_site_products（互斥）', async () => {
  const tid = 'tenant:sc09s6';
  const pid = 'projSc09S6';
  seedProject(tid, pid, [comp('c-s6-shop', 1, true), comp('c-s6-site', 2, false)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'X', price: 10 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  const items = FC.listItems(tid, pid);
  const shopCaps = items.filter(x => x.competitor_id === 'c-s6-shop').map(x => x.capability);
  const siteCaps = items.filter(x => x.competitor_id === 'c-s6-site').map(x => x.capability);
  assert.ok(shopCaps.includes('shopify_catalog'), 'Shopify 品牌含 shopify_catalog');
  assert.ok(!shopCaps.includes('public_site_products'), 'Shopify 品牌不重复走公开商品页');
  assert.ok(siteCaps.includes('public_site_products'), '非 Shopify 走 public_site_products');
  assert.ok(!siteCaps.includes('shopify_catalog'), '非 Shopify 不假装有目录接口');
  await drain();
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// S7：评论发现与正文分离（代码级）
// ============================================================
test('S7 公开评论：搜索只用于发现，正文必须经 FetchGate/robots 抓取（代码级）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'source-adapter.js'), 'utf8');
  const start = src.indexOf('const reviewsAdapter');
  assert.ok(start > 0, '找到 reviewsAdapter');
  const block = src.slice(start, start + 9000);
  assert.ok(/fanoutSearch\(/.test(block), '发现阶段使用搜索链');
  // 🔴 SC-11：fanoutSearch 契约定死——「每查询一个 searchProvider 结果」的数组
  // （discover.js 同款）。旧消费方式（当 {results} 单对象）使候选恒为 0，
  // 测试服 37/37 public_reviews job 全灭；此处把契约钉在代码级断言里。
  assert.ok(/const fanoutRows = await Search\.fanoutSearch\(/.test(block) && /Array\.isArray\(fanoutRows\)/.test(block),
    'fanoutSearch 必须按真实契约（数组）消费');
  assert.ok(/const url = x\.url \|\| x\.link;/.test(block) && /title: x\.title \|\| null/.test(block),
    '搜索结果只取 url/title，不把摘要当正文');
  assert.ok(/Net\.fetchPage\(/.test(block), '正文阶段逐页真实抓取（FetchGate/robots 在 Net 内）');
  assert.ok(/snippet/.test(block), '评论片段来自页面抓取结果');
  // 不得把搜索摘要写入评论正文
  assert.ok(!/snippet:\s*String\(x\.(snippet|description)/.test(block), '不得把搜索摘要当评论正文');
});

// ============================================================
// S8 + S9（r2 重写）：首采只建基线 / 手动刷新不改写首采且不进收件箱 /
// 只有真实监控窗口的第二次可比观察才写收件箱
// ============================================================
const BrandStore = require('../services/brand-store.js');
const WatchMonitor = require('../services/watch-monitor.js');

function fcItemRow(tid, pid, cid, cap) {
  return CollectJobs.getDb().prepare('SELECT * FROM first_collection_items WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=?')
    .get(tid, pid, cid, cap) || null;
}
function fcBatchRow(tid, pid) {
  return CollectJobs.getDb().prepare('SELECT * FROM first_collection_batches WHERE tenant_id=? AND project_id=?').get(tid, pid) || null;
}
function linkBrand(tid, pid, cid, name, host) {
  const r = BrandStore.upsertBrand({ tenantId: tid, canonicalName: name, officialDomain: host, competitorRef: cid, market: 'us' });
  BrandStore.linkProject({ tenantId: tid, brandId: r.brand.brandId, projectId: pid, competitorRef: cid, market: 'us' });
  return r.brand.brandId;
}

test('S8 首采只建基线：完成后收件箱为空；item 只认自己那次 job/attempt', async () => {
  const tid = 'tenant:sc09r2s8';
  const pid = 'projSc09R2S8';
  const cid = 'c-s8r2-a';
  seedProject(tid, pid, [comp(cid, 1, false)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await drain();
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0, '首采不产生任何收件箱事件');
  const it = fcItemRow(tid, pid, cid, 'public_site_products');
  assert.strictEqual(it.state, 'success');
  assert.ok(it.job_id && it.attempt_id, 'item 记录了自己的 job/attempt 身份');
  // 用「别人的 attempt」补发通知：必须 ignored，不得改写 item
  const before = JSON.stringify(it);
  const foreign = FC.onJobFinished({
    tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products',
    jobId: it.job_id, attemptId: 'att_somebody_else',
  });
  assert.strictEqual(foreign.ignored, true, 'attempt 不匹配 → ignored');
  assert.strictEqual(JSON.stringify(fcItemRow(tid, pid, cid, 'public_site_products')), before, 'item 未被改写');
  CollectJobs.setExecutorForTest(null);
});

test('S9A 首采完成后的手动刷新：不改写首采 item/batch，不写每日情报收件箱（只进品牌时间线）', async () => {
  const tid = 'tenant:sc09r2s9a';
  const pid = 'projSc09R2S9A';
  const cid = 'c-s9a-a';
  seedProject(tid, pid, [comp(cid, 1, false)]);
  linkBrand(tid, pid, cid, 'Brand1', `${HOST_BASE}-1.example.com`);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 30 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await drain();

  const itemBefore = JSON.stringify(FC.listItems(tid, pid));
  const batchBefore = JSON.stringify(fcBatchRow(tid, pid));
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0, '首采后收件箱为空');

  // 手动刷新：价格 30 → 41（真实落库的新 attempt，但用途 = manual_refresh）
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p-1', title: 'Tent', price: 41 }] }));
  const compObj = CollectJobs.loadCompetitor({ tenantId: tid, projectId: pid, competitorId: cid });
  const r = CollectReq.requestCollection({
    tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products',
    comp: compObj, trigger: 'manual', tickNow: false, idempotencyKey: 'sc09r2-manual-1',
    collectionPurpose: 'manual_refresh',
  });
  assert.strictEqual(r.status, 'accepted');
  await drain();

  // ① 首采 item / batch 完全未被改写
  assert.strictEqual(JSON.stringify(FC.listItems(tid, pid)), itemBefore, '首采 item 未被后续任务改写');
  assert.strictEqual(JSON.stringify(fcBatchRow(tid, pid)), batchBefore, '首采批次状态与时间字段未被改写');
  // ② 手动刷新不写每日情报收件箱
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0, '手动刷新不冒充每日监控事件');
  // ③ 变化进了品牌时间线（nature=observed，标注 manual_refresh，明确不计入收件箱）
  const brandId = BrandStore.brandIdForCompetitor(tid, pid, cid);
  const tl = BrandStore.listTimeline(tid, brandId, { limit: 20 }).filter(x => x.payload && x.payload.collectionPurpose === 'manual_refresh');
  assert.ok(tl.length >= 1, '手动刷新变化已进入品牌时间线: ' + tl.length);
  assert.ok(tl[0].payload.inboxEligible === false, '时间线条目明确标注不进收件箱');
  assert.ok(/30/.test(tl[0].title) && /41/.test(tl[0].title), '时间线记录真实前值/后值: ' + tl[0].title);
  CollectJobs.setExecutorForTest(null);
});

test('S9B 正式监控窗口的第二次可比观察才写收件箱；windowKey 来自真实监控窗口', async () => {
  const tid = 'tenant:sc09r2s9b';
  const pid = 'projSc09R2S9B';
  const cid = 'c-s9b-a';
  seedProject(tid, pid, [comp(cid, 1, false)]);
  linkBrand(tid, pid, cid, 'Brand1', `${HOST_BASE}-1.example.com`);
  const target = WS.createWatchTarget({
    tenantId: tid, projectId: pid, competitorId: cid,
    market: 'us', timezone: 'UTC', enabledSignals: ['price'], supportedSignals: ['price'],
    enrichmentStatus: 'complete',
  }).target;
  let price = 30;
  const publicSiteFn = async (comp) => ({
    ok: true,
    items: [{ id: 'p-mon', repPrice: price, currency: 'USD', title: 'Tent', soldOut: false }],
    currency: 'USD', partialScan: false, snapshotIds: ['snap-mon'], sourceUrl: comp.url,
  });

  const c1 = WS.claimWindow(target, 'W1', '06:00', Date.now(), Date.now());
  assert.strictEqual(c1.claimed, true);
  const r1 = await WatchMonitor.executeWindow(target, c1.windowId, { publicSiteFn }, Date.now());
  WS.completeWindow(c1.windowId, r1, Date.now());
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0, '第一次观察只建基线');

  price = 41;
  const c2 = WS.claimWindow(target, 'W2', '14:00', Date.now(), Date.now());
  assert.strictEqual(c2.claimed, true);
  const r2 = await WatchMonitor.executeWindow(target, c2.windowId, { publicSiteFn }, Date.now());
  WS.completeWindow(c2.windowId, r2, Date.now());
  const box = Inbox.listInbox({ tenantId: tid, projectId: pid });
  assert.strictEqual(box.total, 1, '第二次可比观察写入 1 条事件: ' + box.total);
  const ev = box.groups[0].events[0];
  assert.strictEqual(ev.eventType, 'price_changed');
  assert.strictEqual(ev.windowKey, c2.windowId, 'windowKey 来自真实监控窗口');
  assert.ok(!String(ev.windowKey).startsWith('first_collection:'), '事件窗口绝不是首采批次号');
  assert.ok(!/first_collection:/.test(JSON.stringify(box)), '收件箱里没有任何首采批次窗口');
});

// ============================================================
// S10：两租户隔离
// ============================================================
test('S10 不同租户不能读取彼此首采任务 / 观察 / 证据 / 事件', async () => {
  const tidA = 'tenant:sc09s10a';
  const tidB = 'tenant:sc09s10b';
  // 项目 id 是全局主键：不同租户使用不同项目，跨租户访问 A 的项目应 404
  const pidA = 'projSc09S10A';
  const pidB = 'projSc09S10B';
  seedProject(tidA, pidA, [comp('c-s10-a', 1, false)]);
  seedProject(tidB, pidB, []);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Rug', price: 60 }] }));
  FC.ensureBatch({ tenantId: tidA, projectId: pidA });
  await drain();

  // B 租户读不到 A 的批次 / item / 事件
  assert.strictEqual(FC.getBatch(tidB, pidB), null, 'B 无批次');
  assert.strictEqual(FC.listItems(tidB, pidB).length, 0, 'B 无首采 item');
  assert.strictEqual(FC.summaryForProject(tidB, pidB), null, 'B 无首采摘要');
  assert.strictEqual(Inbox.listInbox({ tenantId: tidB, projectId: pidB }).total, 0, 'B 无事件');
  // B 用 A 的 projectId 直接访问 → 404（不泄露项目存在性）
  const cross = await callBrands(tidB, pidA);
  assert.strictEqual(cross.status, 404, '跨租户项目 404');
  // B 自己的项目：首采摘要为空、无品牌
  const rb = await callBrands(tidB, pidB);
  assert.strictEqual(rb.status, 200);
  assert.strictEqual(rb.body.firstCollection, null, 'B 的首采摘要为空');
  assert.strictEqual(rb.body.brands.length, 0, 'B 看不到 A 的品牌');
  // 跨租户重试不得影响 A
  const beforeA = FC.listItems(tidA, pidA).map(x => x.state).join(',');
  await callRetry(tidB, pidA); // 跨租户重试：应 404，不得动 A
  assert.strictEqual(FC.listItems(tidA, pidA).map(x => x.state).join(','), beforeA, 'B 的重试不影响 A');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// S11/S12：前端状态区分与禁泄漏（代码级）
// ============================================================
test('S11 前端能区分全部采集状态（尚未开始/正在采集/已检查无发现/失败但历史可用/未配置/不覆盖）', () => {
  const brands = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'app', '(panel)', 'brands', 'page.tsx'), 'utf8');
  const detail = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'app', '(panel)', 'brands', '[brandId]', 'page.tsx'), 'utf8');
  const both = brands + detail;
  // 首采进度：三态 + 完成品牌数
  assert.ok(/brandsDone/.test(brands) && /brandsTotal/.test(brands), '首采进度 = 已完成/总数');
  assert.ok(/正在采集/.test(brands) && /部分完成/.test(brands) && /需要处理/.test(brands), '首采三态文案');
  assert.ok(/重新检查失败项/.test(brands), '失败项重试入口');
  assert.ok(/setInterval/.test(brands), '页面轮询到终态');
  // SC-12 §三/§四：六类状态改为「首页短状态 + 详情完整诊断」两处分工
  //   · 首页卡片只给短状态词（不铺长错误段落、不铺逐维度重复行）
  //   · 完整六态（未配置/不覆盖/空/失败但历史可用）在详情「数据覆盖与来源」呈现
  const logic = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'lib', 'core-logic.ts'), 'utf8');
  assert.ok(/CARD_STATUS_TEXT/.test(brands) && /CARD_STATUS_TEXT/.test(logic), '首页短状态走统一词表');
  assert.ok(/已更新/.test(logic) && /部分数据待更新/.test(logic) && /正在采集/.test(logic), '短状态：已更新/部分数据待更新/正在采集');
  assert.ok(/来源暂时不可达/.test(logic) && /需要重试/.test(logic), '短状态：来源暂时不可达/需要重试');
  assert.ok(/等待系统数据服务配置/.test(logic), '短状态：等待系统数据服务配置');
  assert.ok(/尚未开始采集/.test(logic), '短状态：尚未开始采集');
  assert.ok(/已有历史数据，最近更新失败/.test(logic), '短状态：已有历史数据，最近更新失败');
  assert.ok(/数据服务暂不可用/.test(both), '未配置');
  assert.ok(/该来源不覆盖此市场/.test(both), '来源不覆盖');
  assert.ok(/最近一次更新失败/.test(detail), '失败但历史可用（失败提示）');
  assert.ok(/暂无可展示/.test(detail), '已检查但没有发现（空态文案）');
  // SC-12 §三.3：首页不得再铺长错误段落（详细原因只在详情诊断区）
  assert.ok(!/core-brand-warn/.test(brands), '首页卡片不得铺长错误段落');
  assert.ok(!/lastFailureText/.test(brands), '首页卡片不得直接渲染失败长文案');
  // 详情必须展示真实 observations 与证据入口
  assert.ok(/dimensionDetails/.test(detail) && /ObsList/.test(detail), '详情渲染真实观察');
  assert.ok(/查看证据/.test(detail), '详情有证据入口');
});

test('S12 页面/接口不暴露密钥、服务器路径、调用栈、内部环境变量名（代码级）', async () => {
  const files = [
    path.join(__dirname, '..', '..', 'web', 'src', 'app', '(panel)', 'brands', 'page.tsx'),
    path.join(__dirname, '..', '..', 'web', 'src', 'app', '(panel)', 'brands', '[brandId]', 'page.tsx'),
    path.join(__dirname, '..', '..', 'web', 'src', 'lib', 'core-api.ts'),
  ];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/process\.env/.test(s), '页面不得读环境变量: ' + path.basename(f));
    assert.ok(!/_API_KEY|API_SECRET|CLIENT_SECRET/.test(s), '页面不得出现密钥变量名: ' + path.basename(f));
    assert.ok(!/node_modules|\/app\/services|C:\\\\|stack trace/i.test(s), '页面不得出现服务器路径/堆栈: ' + path.basename(f));
  }
  // 接口响应不得含密钥/内部路径
  const tid = 'tenant:sc09s12';
  const pid = 'projSc09S12';
  seedProject(tid, pid, [comp('c-s12-a', 1, false)]);
  CollectJobs.setExecutorForTest(makeExecutor({ products: [{ id: 'p1', title: 'Mat', price: 15 }] }));
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  await drain();
  const res = await callBrands(tid, pid);
  const json = JSON.stringify(res.body);
  assert.ok(!/api[_-]?key|secret|process\.env|node_modules|\/app\/services/i.test(json), 'API 响应不含密钥/内部路径');
  CollectJobs.setExecutorForTest(null);
});
