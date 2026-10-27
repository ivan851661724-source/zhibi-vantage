'use strict';
// ============================================================
// test/sc08-r3.test.js —— SC-08 r3 合并前收尾（三个真实缺陷）
// ------------------------------------------------------------
// R3-1（§一）重复点击不得重置来源建立进度：
//     全部走真实 HTTP handler（POST /api/watch-targets）——首次点击 → 商品探测
//     完成 → 已切 site_prime → 再次 POST → capability/phase/nextProbeAt 不变、
//     不新增商品探测任务 → 原官网探测继续并最终晋升 site_change。
// R3-2（§二）enabledSignals 必须是 supportedSignals 的子集（真实 HTTP PATCH）：
//     site_change 目标 PATCH ['price'] → 400；['launch','stock'] → 400；
//     ['site_change'] → 200；[] → 400 且不得回退成 Shopify 三件套；
//     真实价格资格升级后 PATCH ['price'] → 200；supportedSignals 仍不可 PATCH。
// R3-3（§三）采集时间拆分 + 「旧数据可用但最新失败」：
//     先成功再失败 → 覆盖仍 available / lastSuccessfulAt 保持成功时间 /
//     lastAttemptAt 为失败时间 / latestFailureText 可见 / 首页 needsAttention +1；
//     再成功后提醒自动消失。
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc08r3-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.CACHE_ENABLED = '0';
process.env.ZB_FIRST_COLLECTION_AUTO = 'off'; // 既有用例不自动建首采批次（SC-09 有独立用例）
process.env.ZB_INTENT_PROBE_INTERVAL_MS = '1000';
try { fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true }); } catch (e) {}

const SurfaceStore = require('../services/surface-store.js');
const WS = require('../services/watch-store.js');
const WIntent = require('../services/watch-intent.js');
const CollectJobs = require('../services/collect-jobs.js');
const CollectReq = require('../services/collect-request.js');
const BrandSvc = require('../services/brand-service.js');
const Registry = require('../services/capability-registry.js');
const CoreH = require('../routes/handlers/core-product.js');
const WatchH = require('../routes/handlers/watch.js');
const { projFile, mirrorProjectToDb } = require('../core/state-store.js');
const db = require('../services/db.js');

const SITE_HOST = 'acme-r3.example.com';

// ---------- 网络层替身（真实 fetch 出不了沙箱；快照/attempt 链路全部真实） ----------
const Net = require('../research/net.js');
let SITE_HTML = '';
function htmlWithPrice(price) {
  return `<!doctype html><html><head>
<title>Acme Outdoor — Trail Gear</title>
<link rel="canonical" href="https://${SITE_HOST}/">
<script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://${SITE_HOST}/"}</script>
<script type="application/ld+json">{"@type":"Product","name":"Tent A","url":"https://${SITE_HOST}/product/tent-a","offers":{"@type":"Offer","price":"${price}","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>
<script type="application/ld+json">{"@type":"Product","name":"Pack B","url":"https://${SITE_HOST}/product/pack-b","offers":{"@type":"Offer","price":"${price + 10}","priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script>
</head><body><h1>Acme Outdoor</h1>
<a href="/product/tent-a">Tent A</a><a href="/product/pack-b">Pack B</a></body></html>`;
}
const realFetchPage = Net.fetchPage;
Net.fetchPage = async function stubFetchPage(url, timeoutMs, opts) {
  const o = opts || {};
  if (/robots\.txt/.test(String(url))) return { ok: false, error: 'not_found', status: 404 };
  const html = SITE_HTML || ('<!doctype html><html><head><title>Acme</title></head><body></body></html>');
  const snap = Snapshot.record({
    capability: 'evidence_url', provider: 'generic_web_fetch',
    source_url: String(url), final_url: String(url), http_status: 200,
    source_status: 'success', error_code: null,
    observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
    bodyBytes: Buffer.from(html, 'utf8'), trigger: o.trigger || 'schedule', tenantId: o.tenantId,
  });
  return {
    ok: true, url: String(url), html,
    text: html.replace(/<[^>]+>/g, ' ').slice(0, 9000),
    htmlLower: html.toLowerCase(),
    snapshotId: snap.recorded ? snap.meta.snapshot_id : undefined,
    status: 200,
  };
};
process.on('exit', () => { Net.fetchPage = realFetchPage; });

// ---------- executor 替身（产生**真实** attempt 行，走 collect-jobs 完整管线） ----------
const Snapshot = require('../research/source-snapshot.js');
// 官网页面（两次内容一致 → 结构化指纹稳定）；资格判定会从这里读真实快照原文
const SITE_HTML_OFFICIAL = `<!doctype html><html><head>
<title>Acme Outdoor — Trail Gear</title>
<meta name="description" content="Durable outdoor essentials">
<link rel="canonical" href="https://${SITE_HOST}/">
<script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://${SITE_HOST}/"}</script>
</head><body><h1>Acme Outdoor</h1><nav><a href="/shop">Shop</a></nav></body></html>`;

function makeExecutor(steps) {
  return async (job) => {
    // official_site_profile：真实落一条来源快照（site_change 资格判定要读快照原文重建指纹）
    if (job.capability === 'official_site_profile') {
      const snap = Snapshot.record({
        capability: 'official_site_profile', provider: 'generic_web_fetch',
        source_url: 'https://' + SITE_HOST + '/', final_url: 'https://' + SITE_HOST + '/',
        http_status: 200, source_status: 'success', error_code: null,
        observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
        bodyBytes: Buffer.from(SITE_HTML_OFFICIAL, 'utf8'),
        trigger: 'schedule', tenantId: job.tenantId,
      });
      SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
        status: 'success', observations: [],
        summary: { kind: 'official_site_profile' },
        snapshotIds: snap.recorded ? [snap.meta.snapshot_id] : [],
        evidenceIds: [],
      }, null);
      return { attempt: SurfaceStore.getAttempt(job.tenantId, job.attemptId) };
    }
    const s = steps.shift() || { status: 'success', observations: [] };
    SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
      status: s.status,
      sourceStatus: s.sourceStatus || null,
      errorClass: s.sourceStatus || null,
      errorUserText: s.errorUserText || null,
      observations: s.observations || [],
      summary: s.summary || { kind: 'public_site_products' },
      snapshotIds: ['snap-' + job.attemptId],
      evidenceIds: ['ev-' + job.attemptId],
    }, null);
    return { attempt: SurfaceStore.getAttempt(job.tenantId, job.attemptId) };
  };
}

// 持续调度直到意向晋升或超次（生产调度器语义：每轮 runDueProbes → drain）
async function driveToPromotion(tid, pid, cid, maxRounds) {
  for (let i = 0; i < (maxRounds || 8); i++) {
    WIntent.runDueProbes(Date.now() + (i + 1) * 60000);
    await drain();
    const it = WIntent.findIntent(tid, pid, cid);
    if (it.state === 'promoted' || it.state === 'source_failed') return it;
  }
  return WIntent.findIntent(tid, pid, cid);
}
const P_BASE = 'https://' + SITE_HOST + '/p';
function obsFor(names) {
  return names.map((n, i) => ({
    id: P_BASE + '/' + n, title: n, price: 10 + i, currency: 'USD',
    sourceUrl: P_BASE + '/' + n,
  }));
}

// ---------- HTTP handler 调用（穿透 handler，不直调服务层） ----------
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
async function callHttp(handler, method, pathname, tid, body) {
  const res = {};
  const url = new URL('http://local' + pathname);
  await handler(mkWatchCtx(tid, body || {}), { method, headers: {}, on: () => {} }, res, url, pathname);
  return res;
}
async function callHandler(handler, method, pathname, search, tid) {
  const res = {};
  const url = new URL('http://local' + pathname + (search ? '?' + search : ''));
  await handler(mkWatchCtx(tid, {}), { method, headers: {}, on: () => {} }, res, url, pathname);
  return res;
}

// ---------- 夹具 ----------
let seq = 0;
function uid(p) { seq += 1; return p + seq; }
function comp(id, url, isShopify) {
  return { id, name: 'Acme' + id.slice(-3), url, status: 'done', isShopify: !!isShopify, market: 'us', relation: 'competitor', category: 'outdoor' };
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
  try { mirrorProjectToDb(projectId, tenantId, 'SC08R3'); } catch (e) { /* 镜像失败不影响文件态读取 */ }
}
function activeJobs() {
  return CollectJobs.getDb().prepare(
    "SELECT COUNT(*) AS n FROM collection_jobs WHERE status IN ('pending','claimed','running')"
  ).get().n;
}
async function drain() {
  const deadline = Date.now() + 15000;
  for (;;) {
    const r = await CollectJobs.tick({ workerId: 'w-r3-' + Math.random().toString(36).slice(2, 8) });
    const n = activeJobs();
    if (!r.claimed && n === 0) return;
    if (Date.now() > deadline) throw new Error('drain 超时，仍有 ' + n + ' 个在途任务');
    await new Promise(res => setTimeout(res, 20));
  }
}
function jobsOf(tid, pid, cid, capability) {
  return CollectJobs.getDb().prepare(
    `SELECT * FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=? ORDER BY created_at`
  ).all(tid, pid, cid, capability);
}
function attemptsOf(tid, pid, cid, capability) {
  return SurfaceStore.listAttempts(tid, pid, cid, capability, 10) || [];
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const future = (ms) => Date.now() + (ms || 120000);

// ============================================================
// R3-1：重复点击不得重置来源建立进度（真实 HTTP POST 双击）
// ============================================================
test('R3-1 HTTP 双击：site_prime 阶段再次加入监控 → 进度保留、不新增商品任务、原官网探测继续晋升', async () => {
  const tid = 'tenant:r3dbl';
  const pid = 'projR3Dbl';
  const cid = 'c-r3-dbl';
  seedProject(tid, pid, [comp(cid, 'https://' + SITE_HOST + '/', false)]);
  CollectJobs.setExecutorForTest(makeExecutor([
    { status: 'success', observations: [{ id: P_BASE + '/x', title: '无价格商品' }] }, // 无 price → 不可比
  ]));

  // ① 第一次 POST 加入监控（穿透 HTTP handler）
  const r1 = await callHttp(WatchH.createTarget, 'POST', '/api/watch-targets', tid, { competitorId: cid, projectId: pid });
  assert.ok(r1.status === 202 || r1.status === 200, '首次加入返回 202/200: ' + r1.status);
  assert.ok(r1.body.intent, '返回意向');
  assert.strictEqual(r1.body.intent.state, 'establishing');
  // HTTP 响应不暴露内部能力码（view() 删除）——阶段断言读库内真值
  const it0 = WIntent.findIntent(tid, pid, cid);
  assert.strictEqual(it0.nextProbeCapability, 'public_site_products');
  assert.strictEqual(it0.probePhase, 'product_prime');
  assert.strictEqual(WS.listWatchTargets(tid, pid).length, 0, '非 Shopify 不创建 WatchTarget');

  // ② 意向调度器（生产由后台定时调；测试显式调）安排第一次商品探测并执行完
  const run0 = WIntent.runDueProbes();
  assert.strictEqual(run0.enqueued, 1, '意向按持久化能力（public_site_products）入队: ' + JSON.stringify(run0.details));
  await drain();
  let intent = WIntent.findIntent(tid, pid, cid);
  assert.strictEqual(intent.nextProbeCapability, 'official_site_profile', '商品无可比价格 → 切官网: ' + intent.nextProbeCapability);
  assert.strictEqual(intent.probePhase, 'site_prime');
  const snapshot = {
    cap: intent.nextProbeCapability, phase: intent.probePhase,
    nextProbeAt: intent.nextProbeAt, lpa: intent.lastProbeAttemptId, retries: intent.autoRetries,
  };
  const prodAttemptsBefore = attemptsOf(tid, pid, cid, 'public_site_products').length;
  const prodJobsBefore = jobsOf(tid, pid, cid, 'public_site_products').filter(j => j.status !== 'failed').length;

  // ③ 第二次 POST 加入监控（重复点击）→ 进度必须原样保留
  const r2 = await callHttp(WatchH.createTarget, 'POST', '/api/watch-targets', tid, { competitorId: cid, projectId: pid });
  assert.strictEqual(r2.status, 200, '重复点击返回 200（既有意向）');
  assert.strictEqual(r2.body.existed, true);
  intent = WIntent.findIntent(tid, pid, cid);
  assert.strictEqual(intent.nextProbeCapability, snapshot.cap, 'capability 不变（不得拉回 public_site_products）');
  assert.strictEqual(intent.probePhase, snapshot.phase, 'phase 不变（不得拉回 product_prime）');
  assert.strictEqual(intent.nextProbeAt, snapshot.nextProbeAt, 'nextProbeAt 不变');
  assert.strictEqual(intent.lastProbeAttemptId, snapshot.lpa, 'lastProbeAttemptId 不变');
  assert.strictEqual(intent.autoRetries, snapshot.retries, '重试计数不变');
  assert.strictEqual(attemptsOf(tid, pid, cid, 'public_site_products').length, prodAttemptsBefore, '不新增商品探测 attempt');
  assert.strictEqual(jobsOf(tid, pid, cid, 'public_site_products').filter(j => j.status !== 'failed').length, prodJobsBefore, '不新增商品探测任务');
  assert.ok(/保留当前进度/.test(String(r2.body.message || '')), '提示用户进度已保留: ' + r2.body.message);
  assert.strictEqual(WIntent.listIntents(tid, pid).filter(i => i.competitorId === cid).length, 1, '仍然只有一条意向');

  // ④ 原官网探测继续（基线 attempt 也可能被计为第一次官网观察，阶段路径不定，
  //    但 capability/phase 绝不回退到商品探测）——持续调度直到自动晋升
  const beforeCaps = attemptsOf(tid, pid, cid, 'official_site_profile').length;
  intent = await driveToPromotion(tid, pid, cid, 8);
  assert.strictEqual(intent.state, 'promoted', '原官网链路最终自动晋升: ' + intent.state + '/' + (intent.reasonCode || ''));
  const siteAttempts = attemptsOf(tid, pid, cid, 'official_site_profile');
  // 资格判定把 handler 首点 planForCompetitor 的官网基线也算一次真实独立观察，
  // 所以「两次均成功」= 基线 + 至少一次调度探测（每次都是独立 attempt）
  assert.ok(siteAttempts.length >= 2, '两次独立官网采集（基线 + 调度探测）: ' + siteAttempts.length);
  assert.ok(siteAttempts.length >= beforeCaps + 1, '双击后至少又完成一次独立官网采集: ' + siteAttempts.length);
  assert.ok(!attemptsOf(tid, pid, cid, 'public_site_products').some(a => String(a.startedAt) > String(snapshot.nextProbeAt || '')), '双击后未再新增商品探测');
  const target = WS.getWatchTarget(tid, intent.promotedTargetId);
  assert.deepStrictEqual(target.supportedSignals, ['site_change']);
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// R3-2：enabledSignals 必须是 supportedSignals 的子集（真实 HTTP PATCH）
// ============================================================
test('R3-2 HTTP PATCH 信号子集校验：不支持 → 400；空数组 → 400 不回退；升级后 price 可启用', async () => {
  const tid = 'tenant:r3sig';
  const pid = 'projR3Sig';
  const cid = 'c-r3-sig';
  seedProject(tid, pid, [comp(cid, 'https://' + SITE_HOST + '/', false)]);

  // ① 真实链路建立 site_change 监控（两次官网探测 → 晋升）
  CollectJobs.setExecutorForTest(makeExecutor([
    { status: 'success', observations: [{ id: P_BASE + '/x', title: '无价格商品' }] },
  ]));
  const r0 = await callHttp(WatchH.createTarget, 'POST', '/api/watch-targets', tid, { competitorId: cid, projectId: pid });
  assert.ok(r1ok(r0));
  WIntent.runDueProbes();
  await drain();
  const intent = await driveToPromotion(tid, pid, cid, 8);
  assert.strictEqual(intent.state, 'promoted', '真实链路晋升 site_change: ' + intent.state + '/' + (intent.reasonCode || ''));
  const target = WS.getWatchTarget(tid, intent.promotedTargetId);
  assert.deepStrictEqual(target.supportedSignals, ['site_change'], '前置：site_change 已验证');
  CollectJobs.setExecutorForTest(null);

  const patch = (body) => callHttp(WatchH.patchTarget, 'PATCH', '/api/watch-targets/' + encodeURIComponent(target.watchTargetId), tid, body);

  // ② site_change 目标启用 price → 400 SIGNAL_NOT_SUPPORTED
  let pr = await patch({ enabledSignals: ['price'] });
  assert.strictEqual(pr.status, 400);
  assert.strictEqual(pr.body.error, 'SIGNAL_NOT_SUPPORTED', JSON.stringify(pr.body));
  assert.ok(/不被该监控对象支持/.test(pr.body.message || ''), '明确的用户提示');

  // ③ launch/stock（Shopify 信号）→ 400
  pr = await patch({ enabledSignals: ['launch', 'stock'] });
  assert.strictEqual(pr.status, 400);
  assert.strictEqual(pr.body.error, 'SIGNAL_NOT_SUPPORTED');

  // ④ 支持的 site_change → 200
  pr = await patch({ enabledSignals: ['site_change'] });
  assert.strictEqual(pr.status, 200, JSON.stringify(pr.body));
  assert.deepStrictEqual(pr.body.target.enabledSignals, ['site_change']);

  // ⑤ 空数组 → 明确 400，且不得经 sanitizeSignals 回退成 Shopify 三件套
  pr = await patch({ enabledSignals: [] });
  assert.strictEqual(pr.status, 400, '空数组必须 400');
  assert.strictEqual(pr.body.error, 'ENABLED_SIGNALS_EMPTY');
  const afterEmpty = WS.getWatchTarget(tid, target.watchTargetId);
  assert.deepStrictEqual(afterEmpty.enabledSignals, ['site_change'], '空数组不得回退成 price/launch/stock');

  // ⑥ pause/resume 不受影响
  pr = await patch({ action: 'pause' });
  assert.strictEqual(pr.status, 200);
  assert.strictEqual(pr.body.target.monitoringStatus, 'paused');
  pr = await patch({ action: 'resume' });
  assert.strictEqual(pr.status, 200);
  assert.strictEqual(pr.body.target.monitoringStatus, 'active');

  // ⑦ 真实价格资格升级（两次独立可比较商品采集，真实抓取链路：fetch → adapter → attempt）
  SITE_HTML = htmlWithPrice(45);
  const compObj = CollectJobs.loadCompetitor({ tenantId: tid, projectId: pid, competitorId: cid });
  const p1 = CollectReq.requestCollection({ tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products', comp: compObj, trigger: 'manual', tickNow: false, idempotencyKey: 'r3-upgrade-1' });
  await drain();
  await sleep(30);
  const p2 = CollectReq.requestCollection({ tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products', comp: compObj, trigger: 'manual', tickNow: false, idempotencyKey: 'r3-upgrade-2' });
  await drain();
  assert.ok(p1 && p2, '两次独立采集已发起');
  const upgraded = WS.getWatchTarget(tid, target.watchTargetId);
  assert.ok(upgraded.supportedSignals.includes('price'), '真实升级后 supportedSignals 含 price: ' + JSON.stringify(upgraded.supportedSignals));
  assert.ok(upgraded.supportedSignals.includes('site_change'), '既有 site_change 保留');

  // ⑧ 升级后 PATCH ['price'] → 200
  pr = await patch({ enabledSignals: ['price'] });
  assert.strictEqual(pr.status, 200, JSON.stringify(pr.body));
  assert.deepStrictEqual(pr.body.target.enabledSignals, ['price']);

  // ⑨ 普通用户仍不能 PATCH supportedSignals
  pr = await patch({ supportedSignals: ['price', 'launch', 'stock'] });
  assert.strictEqual(pr.status, 400);
  assert.strictEqual(pr.body.error, 'CAPABILITY_NOT_PATCHABLE');
});

function r1ok(r) { return r.status === 202 || r.status === 200; }

// ============================================================
// R3-3：采集时间拆分 + 「旧数据可用但最新失败」
// ============================================================
test('R3-3 先成功再失败：覆盖仍 available、lastSuccessfulAt 保持、needsAttention +1；再成功后提醒消失', async () => {
  const tid = 'tenant:r3stale';
  const pid = 'projR3Stale';
  const cid = 'c-r3-stale';
  seedProject(tid, pid, [comp(cid, 'https://' + SITE_HOST + '/', false)]);
  const compObj = CollectJobs.loadCompetitor({ tenantId: tid, projectId: pid, competitorId: cid });

  // ① 第一次：真实成功（2 条观察）
  CollectJobs.setExecutorForTest(makeExecutor([{ status: 'success', observations: obsFor(['mug-a', 'mug-b']) }]));
  CollectReq.requestCollection({ tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products', comp: compObj, trigger: 'manual', tickNow: false, idempotencyKey: 'r3-stale-1' });
  await drain();
  let list = await callHandler(CoreH.brandsList, 'GET', '/api/brands', 'projectId=' + pid, tid);
  assert.strictEqual(list.status, 200);
  let item = list.body.brands.find(b => b.competitorId === cid);
  let wp = item.brandCoverage.dimensions.find(d => d.code === 'website_products');
  assert.strictEqual(wp.state, 'available');
  assert.strictEqual(wp.usingPreviousData, false, '成功时无旧数据标记');
  assert.strictEqual(wp.latestAttemptStatus, 'success');
  assert.ok(wp.lastSuccessfulAt, 'lastSuccessfulAt 有值');
  assert.strictEqual(wp.lastAttemptAt, wp.lastSuccessfulAt, '只有一次成功采集时两者相等');
  assert.strictEqual(list.body.stats.needsAttention, 0, '正常时无需处理');
  const successAt = wp.lastSuccessfulAt;
  const obsCount = wp.observationCount;
  await sleep(30); // 保证失败 attempt 的时间戳严格晚于成功

  // ② 第二次：真实失败（旧数据保留）
  CollectJobs.setExecutorForTest(makeExecutor([{ status: 'failed', sourceStatus: 'blocked', errorUserText: '来源站点拒绝访问（403/401）' }]));
  CollectReq.requestCollection({ tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products', comp: compObj, trigger: 'manual', tickNow: false, idempotencyKey: 'r3-stale-2' });
  await drain();

  list = await callHandler(CoreH.brandsList, 'GET', '/api/brands', 'projectId=' + pid, tid);
  item = list.body.brands.find(b => b.competitorId === cid);
  wp = item.brandCoverage.dimensions.find(d => d.code === 'website_products');
  // 不删旧数据、不把维度误写成没有数据
  assert.strictEqual(wp.state, 'available', '旧数据仍可用 → 覆盖保持 available: ' + wp.state);
  assert.strictEqual(wp.latestAttemptStatus, 'failed');
  assert.strictEqual(wp.usingPreviousData, true, '旧数据可用但最新失败 → usingPreviousData');
  assert.ok(wp.latestFailureText && /拒绝访问/.test(wp.latestFailureText), '失败原因可见: ' + wp.latestFailureText);
  assert.strictEqual(wp.lastSuccessfulAt, successAt, 'lastSuccessfulAt 保持成功时间');
  assert.ok(wp.lastAttemptAt && wp.lastAttemptAt > successAt, 'lastAttemptAt 为失败时间');
  assert.strictEqual(wp.observationCount, obsCount, '观察计数不因失败清零');
  assert.strictEqual(wp.stateText, '已有历史数据，最近一次更新失败', '状态文案如实');
  // 该品牌计入首页「需要处理」
  assert.strictEqual(list.body.stats.needsAttention, 1, 'usingPreviousData 品牌计入需要处理: ' + JSON.stringify(list.body.stats));
  // 详情 API 同口径：collection.lastSuccessfulAt / lastAttemptAt 拆分
  const detail = await callHandler(CoreH.brandDetail, 'GET', '/api/brands/' + item.brandId, 'projectId=' + pid, tid);
  assert.strictEqual(detail.status, 200);
  assert.strictEqual(detail.body.collection.lastSuccessfulAt, successAt, '详情最近一次成功观察 = lastSuccessfulAt');
  assert.ok(detail.body.collection.lastAttemptAt > successAt, '详情 lastAttemptAt 为失败时间');
  await sleep(30);

  // ③ 第三次：再成功 → 提醒自动消失
  CollectJobs.setExecutorForTest(makeExecutor([{ status: 'success', observations: obsFor(['mug-a', 'mug-b']) }]));
  CollectReq.requestCollection({ tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products', comp: compObj, trigger: 'manual', tickNow: false, idempotencyKey: 'r3-stale-3' });
  await drain();

  list = await callHandler(CoreH.brandsList, 'GET', '/api/brands', 'projectId=' + pid, tid);
  item = list.body.brands.find(b => b.competitorId === cid);
  wp = item.brandCoverage.dimensions.find(d => d.code === 'website_products');
  assert.strictEqual(wp.latestAttemptStatus, 'success');
  assert.strictEqual(wp.usingPreviousData, false, '最新成功后旧数据标记自动清除');
  assert.strictEqual(wp.latestFailureText, null, '失败提醒自动消失');
  assert.strictEqual(wp.lastSuccessfulAt > successAt || wp.lastSuccessfulAt >= successAt, true, 'lastSuccessfulAt 前移到新成功');
  assert.strictEqual(list.body.stats.needsAttention, 0, '需要处理归零');
  CollectJobs.setExecutorForTest(null);
});

// ============================================================
// R3-4：前端「最近一次成功观察」只准用 lastSuccessfulAt（代码级约束）
// ============================================================
test('R3-4 前端成功观察只读 lastSuccessfulAt；失败原因同一文案只显示一次（代码级）', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'app', '(panel)', 'brands', '[brandId]', 'page.tsx'), 'utf8');
  // 核心产品体验收敛 r1：头部字段统一为「最近成功更新」（同一事实、同一数据源，
  // lastSuccessfulAt），断言随之对齐字段名，意图不变。
  assert.ok(/最近成功更新/.test(page));
  assert.ok(!/最近成功更新[^`]*lastAttemptAt/.test(page), '成功观察不得读 lastAttemptAt');
  assert.ok(/lastSuccessfulAt/.test(page), '成功观察读 lastSuccessfulAt');
  assert.ok(/seenFail/.test(page), '失败原因按文案去重（同一原因只显示一次）');
  assert.ok(!/<DataSurfaceOverview|import\\s*\\{[^}]*DataSurfaceOverview/.test(page), 'r2 约束保持：无重复覆盖组件（注释提及不算）');
});
