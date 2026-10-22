'use strict';
// ============================================================
// test/sc08-r2.test.js —— SC-08 r2：监控降级真实链路 + 竞品数据库/详情/覆盖投影
// ------------------------------------------------------------
// F1  从零数据、真实服务入口：加入监控 → 商品探测无可比价格 → 官网探测 ×2
//     → 自动晋升 site_change（两次 official_site_profile attempt 由系统自动产生）
//     → 调度窗口执行 → 官网变化 → 收件箱出现一条 website_changed
// F2  服务重启（子进程）后继续正确 capability/阶段
// F3  取消意向后不采集、不晋升
// F4  重复/并发调度不产生双任务
// F5  site_change 正确升级到 price（supportedSignals 含 price，基线/窗口/事件不丢）
// F6  事件写库失败：不提醒、不计数、不前移基线、窗口如实记录缺口；下次窗口重试成功
// F7  DUPLICATE：不重复提醒、不重复计数，可前移基线
// F8  origin fail-closed：缺失/非法拒收；history/backfill 不进收件箱
// F9  brandCoverage 唯一投影（维度总数来自 Registry；六态区分；列表与详情同源）
// F10 竞品数据库/品牌详情无重复覆盖区域（代码级约束）
// F11 两租户隔离（列表 / 详情 / 收件箱）
// F12 projectId 切换不带入旧品牌（API 层）+ 前端筛选随项目重置（代码级）
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc08r2-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.CACHE_ENABLED = '0';
process.env.ZB_FIRST_COLLECTION_AUTO = 'off'; // 既有用例不自动建首采批次（SC-09 有独立用例）
// 三次独立探测之间的最小间隔（测试压缩到 1s；生产默认 60min）
process.env.ZB_INTENT_PROBE_INTERVAL_MS = '1000';
try { fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true }); } catch (e) {}

const Net = require('../research/net.js');
const Snapshot = require('../research/source-snapshot.js');
const SurfaceStore = require('../services/surface-store.js');
const WS = require('../services/watch-store.js');
const WIntent = require('../services/watch-intent.js');
const CollectJobs = require('../services/collect-jobs.js');
const CollectReq = require('../services/collect-request.js');
const Inbox = require('../services/intel-inbox.js');
const WatchMonitor = require('../services/watch-monitor.js');
const BrandSvc = require('../services/brand-service.js');
const Registry = require('../services/capability-registry.js');
const CoreH = require('../routes/handlers/core-product.js');
const { projFile, mirrorProjectToDb } = require('../core/state-store.js');
const db = require('../services/db.js');

const SITE_HOST = 'acme-r2.example.com';

// ---------- 网络层替身（只替换 HTTP 取页；快照/证据/attempt 全部走真实链路） ----------
// 这是「模拟来源网站」，不是伪造业务数据：快照由 Snapshot.record 真实落盘，
// attempt 由 collect-jobs → adapter 真实产生。
let SITE_HTML = '';
function htmlNoProducts() {
  return `<!doctype html><html><head>
<title>Acme Outdoor — Trail Gear</title>
<meta name="description" content="Durable outdoor essentials">
<link rel="canonical" href="https://${SITE_HOST}/">
<script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://${SITE_HOST}/"}</script>
</head><body><h1>Acme Outdoor</h1><nav><a href="/shop">Shop</a><a href="/about">About</a></nav></body></html>`;
}
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
  const html = SITE_HTML || htmlNoProducts();
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
// 用例结束后恢复（避免影响同进程其它文件——单文件运行时无影响）
process.on('exit', () => { Net.fetchPage = realFetchPage; });

// ---------- 夹具 ----------
let seq = 0;
function uid(p) { seq += 1; return p + seq; }
function comp(id, url, isShopify) {
  return { id, name: 'Acme' + id.slice(-3), url, status: 'done', isShopify: !!isShopify, market: 'us', relation: 'competitor', category: 'outdoor' };
}
function seedProject(tenantId, projectId, compsArr) {
  // 项目登记（与生产同一入口：租户行 + 项目行），否则 handler 的 resolveProject 会 404
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
  try { mirrorProjectToDb(projectId, tenantId, 'SC08R2'); } catch (e) { /* 镜像失败不影响文件态读取 */ }
}
// 把队列里的任务真正跑完：requestCollection 会 setImmediate 触发一次 tick，
// 所以「tick 没认领到」可能是别的 tick 已在执行中——必须等到没有在途任务才算完成。
function activeJobs() {
  return CollectJobs.getDb().prepare(
    "SELECT COUNT(*) AS n FROM collection_jobs WHERE status IN ('pending','claimed','running')"
  ).get().n;
}
async function drain() {
  const deadline = Date.now() + 15000;
  for (;;) {
    const r = await CollectJobs.tick({ workerId: 'w-r2-' + Math.random().toString(36).slice(2, 8) });
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
const future = (ms) => Date.now() + (ms || 120000);

// ============================================================
// F1：完整真实链路
// ============================================================
test('F1 从零数据真实链路：点击加入监控 → 商品无可比价格 → 官网两次独立探测 → 自动晋升 site_change → 窗口发现官网变化 → 收件箱', async () => {
  const tid = 'tenant:r2flow';
  const pid = 'projR2Flow';
  const cid = 'c-r2-flow';
  seedProject(tid, pid, [comp(cid, 'https://' + SITE_HOST + '/', false)]);
  SITE_HTML = htmlNoProducts();

  // ① 用户点击「加入监控」→ 真实服务入口（与 HTTP handler 同一函数）
  const ri = WIntent.requestIntent({ tenantId: tid, projectId: pid, competitorId: cid, reasonCode: 'no_direct_source' });
  assert.ok(ri.intent, '意向已保存');
  assert.strictEqual(ri.intent.state, 'establishing');
  assert.strictEqual(ri.intent.nextProbeCapability, 'public_site_products', '第一阶段 = 商品探测');
  assert.strictEqual(ri.intent.probePhase, 'product_prime');
  assert.strictEqual(WS.listWatchTargets(tid, pid).length, 0, '此处绝不创建 WatchTarget');

  WIntent.scheduleFirstProbe({ tenantId: tid, projectId: pid, competitorId: cid });
  const run1 = WIntent.runDueProbes();
  assert.strictEqual(run1.enqueued, 1, '第一次探测入队: ' + JSON.stringify(run1.details));
  await drain();

  let intent = WIntent.findIntent(tid, pid, cid);
  const prodAttempts = attemptsOf(tid, pid, cid, 'public_site_products');
  assert.strictEqual(prodAttempts.length, 1, '商品探测产生 1 个真实 attempt');
  assert.strictEqual(prodAttempts[0].status, 'success', '商品页可访问（诚实空结果）: ' + JSON.stringify(prodAttempts[0].status));
  assert.strictEqual(WIntent.comparableItems(prodAttempts[0]).length, 0, '没有可比价格');
  assert.strictEqual(intent.nextProbeCapability, 'official_site_profile', '无可比价格 → 切官网来源');
  assert.strictEqual(intent.probePhase, 'site_prime');
  assert.strictEqual(WS.listWatchTargets(tid, pid).length, 0, '官网只观察一次时不得晋升');

  // ② 官网探测 1（独立 attempt）
  WIntent.runDueProbes(future(2000));
  await drain();
  let siteAttempts = attemptsOf(tid, pid, cid, 'official_site_profile');
  assert.strictEqual(siteAttempts.length, 1, '官网探测 1 已自动产生（非手工插入）: ' + siteAttempts.length);
  intent = WIntent.findIntent(tid, pid, cid);
  assert.strictEqual(intent.probePhase, 'site_confirm', '一次官网观察后进入第二次独立探测: ' + JSON.stringify(intent.probePhase));
  assert.strictEqual(intent.state, 'establishing');

  // ③ 官网探测 2（独立 attempt）→ 自动晋升
  WIntent.runDueProbes(future(120000));
  await drain();
  siteAttempts = attemptsOf(tid, pid, cid, 'official_site_profile');
  assert.strictEqual(siteAttempts.length, 2, '官网探测 2 已自动产生（两次独立 attempt）');
  assert.notStrictEqual(siteAttempts[0].attemptId, siteAttempts[1].attemptId, '两次是不同 attempt');
  assert.notStrictEqual(siteAttempts[0].startedAt, siteAttempts[1].startedAt, '两次独立观察时间');
  assert.ok(siteAttempts.every(a => a.status === 'success' || a.status === 'partial'));

  intent = WIntent.findIntent(tid, pid, cid);
  assert.strictEqual(intent.state, 'promoted', '两次同源可核实观察后自动晋升: ' + intent.state);
  const target = WS.getWatchTarget(tid, intent.promotedTargetId);
  assert.deepStrictEqual(target.supportedSignals, ['site_change'], 'site_change 是唯一被验证的能力');
  assert.deepStrictEqual(target.enabledSignals, ['site_change']);
  assert.ok(!/上新|库存/.test(String(intent.reasonText || '')), '不虚标上新/库存: ' + intent.reasonText);

  // ④ 调度窗口执行：官网内容发生变化
  SITE_HTML = htmlNoProducts().replace('<title>Acme Outdoor — Trail Gear</title>', '<title>Acme Outdoor — Alpine Series</title>');
  const res = await WatchMonitor.executeWindow(target, target.watchTargetId + ':w1', {}, Date.now());
  assert.strictEqual(res.succeeded, 1, '窗口采集成功: ' + JSON.stringify(res.signalResults));
  assert.strictEqual(res.eventsVerified, 1, '确定性变化计入已核实');

  const box = Inbox.listInbox({ tenantId: tid, projectId: pid });
  assert.strictEqual(box.total, 1, '收件箱出现 1 条变化');
  const ev = box.groups[0].events[0];
  assert.strictEqual(ev.eventType, 'website_changed');
  assert.strictEqual(ev.dimension, 'website');
  assert.strictEqual(ev.origin, 'monitoring');
  assert.strictEqual(ev.verificationStatus, 'verified', '有快照证据 → verified');
  assert.strictEqual(ev.effectiveAt, null);
  assert.ok((ev.evidenceCount || 0) > 0, '带证据引用');
});

// ============================================================
// F2：服务重启后续跑（子进程读同一数据目录）
// ============================================================
test('F2 服务重启后继续正确的 capability/阶段（子进程真实重启）', async () => {
  const tid = 'tenant:r2restart';
  const pid = 'projR2Restart';
  const cid = 'c-r2-restart';
  seedProject(tid, pid, [comp(cid, 'https://' + SITE_HOST + '/', false)]);
  SITE_HTML = htmlNoProducts();

  WIntent.requestIntent({ tenantId: tid, projectId: pid, competitorId: cid });
  WIntent.scheduleFirstProbe({ tenantId: tid, projectId: pid, competitorId: cid });
  WIntent.runDueProbes();
  await drain();

  const before = WIntent.findIntent(tid, pid, cid);
  assert.strictEqual(before.nextProbeCapability, 'official_site_profile');
  assert.strictEqual(before.probePhase, 'site_prime');

  // 子进程 = 真实「服务重启」：只读库内持久化状态并给出下一步计划
  const script = `
    process.env.ZB_DATA_DIR = ${JSON.stringify(TMP)};
    process.env.ZB_INTENT_SCHEDULER='0'; process.env.ZB_COLLECT_WORKER_DISABLED='1';
    process.env.WATCH_MONITOR_ENABLED='0'; process.env.SCHEDULER_ENABLED='0';
    const W = require(${JSON.stringify(path.join(__dirname, '..', 'services', 'watch-intent.js'))});
    const i = W.findIntent(${JSON.stringify(tid)}, ${JSON.stringify(pid)}, ${JSON.stringify(cid)});
    // 重启后：库内持久化的下一步能力/阶段必须原样可读，且下一步说明指向官网探测
    console.log(JSON.stringify({
      phase: i.probePhase, cap: i.nextProbeCapability, state: i.state,
      nextAt: i.nextProbeAt, step: W.view(i).nextStepText,
    }));
  `;
  const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }).trim().split('\n').pop();
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.cap, 'official_site_profile', '重启后仍按库内能力调度（不退回商品探测）');
  assert.strictEqual(parsed.phase, 'site_prime');
  assert.strictEqual(parsed.state, 'establishing');
  assert.ok(/官网/.test(String(parsed.step || '')), '重启后下一步说明指向官网探测: ' + parsed.step);

  // 父进程（重启后的服务）继续按持久化能力调度并推进阶段
  const r = WIntent.runDueProbes(future(60000));
  assert.strictEqual(r.enqueued, 1, '重启后到期探测照常入队: ' + JSON.stringify(r.details));
  await drain();
  const after = WIntent.findIntent(tid, pid, cid);
  assert.notStrictEqual(after.probePhase, 'site_prime', '重启后阶段继续推进: ' + after.probePhase);
  assert.strictEqual(attemptsOf(tid, pid, cid, 'official_site_profile').length, 1, '重启后只执行一次官网探测');
});

// ============================================================
// F3：取消后不采集、不晋升
// ============================================================
test('F3 取消意向后不再采集、不再晋升', async () => {
  const tid = 'tenant:r2cancel';
  const pid = 'projR2Cancel';
  const cid = 'c-r2-cancel';
  seedProject(tid, pid, [comp(cid, 'https://' + SITE_HOST + '/', false)]);
  SITE_HTML = htmlNoProducts();

  const ri = WIntent.requestIntent({ tenantId: tid, projectId: pid, competitorId: cid });
  WIntent.scheduleFirstProbe({ tenantId: tid, projectId: pid, competitorId: cid });
  WIntent.cancelIntent(tid, ri.intent.intentId);

  const run = WIntent.runDueProbes(future(60000));
  const mine = run.details.filter(d => d.intentId === ri.intent.intentId);
  assert.strictEqual(mine.length, 0, '取消后调度器不扫该意向: ' + JSON.stringify(run.details));
  assert.strictEqual(jobsOf(tid, pid, cid, 'public_site_products').length, 0);
  assert.strictEqual(WS.listWatchTargets(tid, pid).length, 0);

  // 即使有一次外部触发的真实采集完成，也不得晋升
  const compObj = CollectJobs.loadCompetitor({ tenantId: tid, projectId: pid, competitorId: cid });
  const r = CollectReq.requestCollection({ tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products', comp: compObj, trigger: 'manual', tickNow: false });
  assert.strictEqual(r.status, 'accepted');
  const r2 = WIntent.onProbeFinished({ tenantId: tid, projectId: pid, competitorId: cid, attempt: r.attempt });
  assert.strictEqual(r2.action, 'ignored_cancelled');
  assert.strictEqual(WIntent.findIntent(tid, pid, cid).state, 'cancelled');
  assert.strictEqual(WS.listWatchTargets(tid, pid).length, 0, '取消后绝不创建正式监控');
});

// ============================================================
// F4：重复/并发调度不产生双任务
// ============================================================
test('F4 重复点击 + 并发调度 + 重启不产生双任务', async () => {
  const tid = 'tenant:r2dup';
  const pid = 'projR2Dup';
  const cid = 'c-r2-dup';
  seedProject(tid, pid, [comp(cid, 'https://' + SITE_HOST + '/', false)]);
  SITE_HTML = htmlNoProducts();

  WIntent.requestIntent({ tenantId: tid, projectId: pid, competitorId: cid });
  // 重复点击（含并发）
  WIntent.scheduleFirstProbe({ tenantId: tid, projectId: pid, competitorId: cid });
  WIntent.requestIntent({ tenantId: tid, projectId: pid, competitorId: cid });
  WIntent.scheduleFirstProbe({ tenantId: tid, projectId: pid, competitorId: cid });
  const runs = await Promise.all([WIntent.runDueProbes(), WIntent.runDueProbes(), WIntent.runDueProbes()]);
  const enq = runs.reduce((n, r) => n + r.enqueued, 0);
  assert.strictEqual(enq, 1, '并发调度只入队一次: ' + JSON.stringify(runs.map(r => r.details)));
  const jobs1 = jobsOf(tid, pid, cid, 'public_site_products');
  assert.strictEqual(jobs1.length, 1, '只有一个采集任务');
  assert.strictEqual(new Set(jobs1.map(j => j.attempt_id)).size, 1, '一个 attempt');

  await drain();
  assert.strictEqual(attemptsOf(tid, pid, cid, 'public_site_products').length, 1, '只执行一次');

  // 下一阶段同样不得双任务
  await Promise.all([WIntent.runDueProbes(future(2000)), WIntent.runDueProbes(future(2000))]);
  assert.strictEqual(jobsOf(tid, pid, cid, 'official_site_profile').length, 1, '第二阶段也只有 1 个任务');
  await drain();
  assert.strictEqual(attemptsOf(tid, pid, cid, 'official_site_profile').length, 1);
});

// ============================================================
// F5：site_change → price 受控升级
// ============================================================
test('F5 site_change 在真实价格资格满足后升级到 price；基线/窗口/事件不丢；重复升级幂等', async () => {
  const tid = 'tenant:r2upgrade';
  const pid = 'projR2Upgrade';
  const cid = 'c-r2-upgrade';
  seedProject(tid, pid, [comp(cid, 'https://' + SITE_HOST + '/', false)]);
  SITE_HTML = htmlNoProducts();

  // 走真实链路晋升 site_change
  WIntent.requestIntent({ tenantId: tid, projectId: pid, competitorId: cid });
  WIntent.scheduleFirstProbe({ tenantId: tid, projectId: pid, competitorId: cid });
  WIntent.runDueProbes();
  await drain();
  WIntent.runDueProbes(future(2000));
  await drain();
  WIntent.runDueProbes(future(120000));
  await drain();
  const intent = WIntent.findIntent(tid, pid, cid);
  assert.strictEqual(intent.state, 'promoted');
  let target = WS.getWatchTarget(tid, intent.promotedTargetId);
  assert.deepStrictEqual(target.supportedSignals, ['site_change']);

  // 建一条官网基线 + 跑一个真实监控窗口（claim → execute → complete，与生产同序）
  SITE_HTML = htmlNoProducts();
  const wkey = target.watchTargetId + ':W0';
  const claim = WS.claimWindow(target, 'W0', '06:00', Date.now(), Date.now());
  assert.strictEqual(claim.claimed, true);
  const w0 = await WatchMonitor.executeWindow(target, wkey, {}, Date.now());
  WS.completeWindow(wkey, w0, Date.now());
  assert.strictEqual(w0.failed, 0);
  const baselineBefore = WS.getSiteBaseline(tid, pid, cid);
  assert.ok(baselineBefore && baselineBefore.fingerprint, '官网基线已存在');
  const windowsBefore = WS.latestWindowFor(tid, target.watchTargetId);
  assert.ok(windowsBefore, '监控窗口已落库');

  // 真实价格来源出现：两次独立商品探测（真实采集链路）
  SITE_HTML = htmlWithPrice(45);
  const compObj = CollectJobs.loadCompetitor({ tenantId: tid, projectId: pid, competitorId: cid });
  // 显式幂等键 = 用户明确发起的独立复采（绕开 capability 冷却，但不绕开 running 复用）
  const p1 = CollectReq.requestCollection({ tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products', comp: compObj, trigger: 'manual', tickNow: false, idempotencyKey: 'upgrade-probe-1' });
  assert.strictEqual(p1.status, 'accepted');
  await drain();
  const p2 = CollectReq.requestCollection({ tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products', comp: compObj, trigger: 'manual', tickNow: false, idempotencyKey: 'upgrade-probe-2' });
  assert.strictEqual(p2.status, 'accepted', '第二次商品探测入队: ' + JSON.stringify(p2));
  await drain();
  assert.ok(attemptsOf(tid, pid, cid, 'public_site_products').filter(a => a.status === 'success' || a.status === 'partial').length >= 2, '两次可比较商品观察');

  // 受控升级由真实采集完成事件自动触发（collect-jobs → notifyWatchIntent），
  // 不需要人工调用：此处先断言已经自动升级
  const auto = WS.getWatchTarget(tid, intent.promotedTargetId);
  assert.deepStrictEqual(auto.supportedSignals, ['site_change', 'price'], '两次真实商品观察后自动受控升级: ' + JSON.stringify(auto.supportedSignals));
  // 再显式调用一次同一入口验证幂等（不得重复升级/不得改动历史）
  const up = WIntent.tryUpgradeTargetToPrice({ tenantId: tid, projectId: pid, competitorId: cid });
  assert.ok(up.upgraded === false, '重复调用幂等（已支持则不重复升级）: ' + JSON.stringify(up.reason || ''));
  target = WS.getWatchTarget(tid, intent.promotedTargetId);
  assert.deepStrictEqual(target.supportedSignals, ['site_change', 'price'], 'price 已加入 supportedSignals（不是只保留 site_change）');
  assert.deepStrictEqual(target.enabledSignals, ['price'], 'enabledSignals 切换为 price');

  // 基数与历史保留
  const baselineAfter = WS.getSiteBaseline(tid, pid, cid);
  assert.ok(baselineAfter && baselineAfter.fingerprint, '官网基线未删除');
  const keptWindow = WS.getWindow(windowsBefore.windowId);
  assert.ok(keptWindow, '既有监控窗口未删除');
  assert.strictEqual(keptWindow.status, 'complete');

  // 幂等：再调一次不改变结果
  const up2 = WIntent.tryUpgradeTargetToPrice({ tenantId: tid, projectId: pid, competitorId: cid });
  assert.strictEqual(up2.upgraded, false);
  const t2 = WS.getWatchTarget(tid, intent.promotedTargetId);
  assert.deepStrictEqual(t2.supportedSignals, ['site_change', 'price']);
  assert.deepStrictEqual(t2.enabledSignals, ['price']);

  // 前端 PATCH 不得声明系统能力
  const bad = WS.updateWatchTarget(tid, target.watchTargetId, { supportedSignals: ['launch', 'stock'] });
  assert.ok(bad && bad.error === 'CAPABILITY_NOT_PATCHABLE', '普通 PATCH 不能改 supportedSignals: ' + JSON.stringify(bad));
  // 伪造依据同样被拒
  const forged = WS.upgradeWatchTargetCapabilities({
    tenantId: tid, watchTargetId: target.watchTargetId, addSupportedSignals: ['launch'],
    verifiedBasis: { ok: true, attemptIds: ['a', 'b'], signal: 'launch', competitorId: cid, evaluatedAt: new Date().toISOString() },
  });
  assert.ok(forged && forged.error === 'UNVERIFIED_CAPABILITY', '未署名/未验证依据被拒: ' + JSON.stringify(forged));
});

// ============================================================
// F6/F7：事件写入失败 / 重复事件
// ============================================================
const FP = require('../services/site-fingerprint.js');
const HTML_A = `<!doctype html><html><head><title>Acme — Outdoor Gear</title>
<link rel="canonical" href="https://acme-fail.example.com/">
<script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://acme-fail.example.com/"}</script>
</head><body><h1>Acme</h1><a href="/product/tent-a">Tent A</a></body></html>`;

function siteTarget(tid, pid, cid) {
  return WS.createWatchTarget({
    tenantId: tid, projectId: pid, competitorId: cid,
    market: 'us', timezone: 'UTC', enabledSignals: ['site_change'], supportedSignals: ['site_change'],
    enrichmentStatus: 'complete',
  }).target;
}
function fpResult(html) {
  const fp = FP.buildFingerprint(html, 'https://acme-fail.example.com/');
  return {
    ok: true, fingerprint: fp, stability: FP.stabilityOf(fp),
    sourceUrl: 'https://acme-fail.example.com/',
    evidenceRefs: [{ snapshotId: 'snap_f6', sourceUrl: 'https://acme-fail.example.com/', observedAt: new Date().toISOString() }],
    partialScan: false,
  };
}
function alertsCollector() {
  const items = [];
  const fn = (tid, payload) => { items.push(payload); };
  fn.items = items;
  return fn;
}

test('F6 事件写库失败：不提醒、不计数、不前移基线，窗口如实记录缺口；下个窗口重试成功', async () => {
  const tid = 'tenant:r2writefail';
  const pid = 'projR2WriteFail';
  const cid = 'c-r2-writefail';
  seedProject(tid, pid, [comp(cid, 'https://acme-fail.example.com/', false)]);
  const target = siteTarget(tid, pid, cid);

  // 首次窗口：建立基线
  await WatchMonitor.executeWindow(target, target.watchTargetId + ':B0', { siteFingerprintFn: async () => fpResult(HTML_A) }, Date.now());
  const base0 = WS.getSiteBaseline(tid, pid, cid);
  assert.ok(base0 && base0.fingerprint.title === 'Acme — Outdoor Gear');

  const changed = HTML_A.replace('<title>Acme — Outdoor Gear</title>', '<title>Acme — Alpine</title>');
  const alerts = alertsCollector();
  // 注入写库失败
  const res = await WatchMonitor.executeWindow(target, target.watchTargetId + ':W1', {
    siteFingerprintFn: async () => fpResult(changed),
    alertsPushFn: alerts,
    inboxFn: { recordEvent: () => ({ recorded: false, reason: 'WRITE_FAILED:disk full' }) },
  }, Date.now() + 1000);
  assert.strictEqual(res.eventsVerified, 0, '写失败不得计入已核实');
  assert.strictEqual(res.eventsWriteFailed, 1, '窗口记录了写库失败: ' + JSON.stringify(res));
  assert.strictEqual(res.failureReasons.event_write_failed, 1);
  assert.strictEqual(res.partialScan, true, '窗口不得显示完全成功');
  assert.strictEqual(alerts.items.length, 0, '写失败不得发提醒');
  const base1 = WS.getSiteBaseline(tid, pid, cid);
  assert.strictEqual(base1.fingerprint.title, 'Acme — Outdoor Gear', '写失败不得前移基线（下次必须能重试这次变化）');
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0);

  // 下个窗口（真实写库）→ 同一变化被重试并成功
  const alerts2 = alertsCollector();
  const res2 = await WatchMonitor.executeWindow(target, target.watchTargetId + ':W2', {
    siteFingerprintFn: async () => fpResult(changed), alertsPushFn: alerts2,
  }, Date.now() + 2000);
  assert.strictEqual(res2.eventsVerified, 1, '重试成功');
  assert.strictEqual(alerts2.items.length, 1, '成功写入后才提醒一次');
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 1);
  assert.strictEqual(WS.getSiteBaseline(tid, pid, cid).fingerprint.title, 'Acme — Alpine', '成功后基线前移');
});

test('F7 DUPLICATE：不重复提醒、不重复计数，可前移基线', async () => {
  const tid = 'tenant:r2dupev';
  const pid = 'projR2DupEv';
  const cid = 'c-r2-dupev';
  seedProject(tid, pid, [comp(cid, 'https://acme-fail.example.com/', false)]);
  const target = siteTarget(tid, pid, cid);
  await WatchMonitor.executeWindow(target, target.watchTargetId + ':B0', { siteFingerprintFn: async () => fpResult(HTML_A) }, Date.now());
  const changed = HTML_A.replace('<title>Acme — Outdoor Gear</title>', '<title>Acme — Alpine</title>');
  const alerts = alertsCollector();
  const res = await WatchMonitor.executeWindow(target, target.watchTargetId + ':W1', {
    siteFingerprintFn: async () => fpResult(changed),
    alertsPushFn: alerts,
    inboxFn: { recordEvent: () => ({ recorded: false, reason: 'DUPLICATE' }) },
  }, Date.now() + 1000);
  assert.strictEqual(res.eventsVerified, 0, '重复事件不计入已核实');
  assert.strictEqual(res.eventsDuplicate, 1, '窗口记录重复次数: ' + JSON.stringify(res));
  assert.strictEqual(alerts.items.length, 0, '重复事件不提醒');
  assert.strictEqual(WS.getSiteBaseline(tid, pid, cid).fingerprint.title, 'Acme — Alpine', '重复事件可以前移基线');
  assert.strictEqual(res.failed, 0, '重复不是采集失败');
});

// ============================================================
// F8：origin fail-closed
// ============================================================
test('F8 origin fail-closed：缺失/非法拒收；history/backfill 不进收件箱', () => {
  const tid = 'tenant:r2origin';
  const pid = 'projR2Origin';
  const now = new Date().toISOString();
  const base = { tenantId: tid, projectId: pid, competitorId: 'c-origin', dimension: 'price', eventType: 'price_changed', title: 'x', observedAt: now, change: { field: 'price', oldValue: 1, newValue: 2 } };

  const noOrigin = Inbox.recordEvent(Object.assign({}, base));
  assert.strictEqual(noOrigin.recorded, false, '缺 origin 必须拒收');
  assert.strictEqual(noOrigin.reason, 'ORIGIN_REQUIRED');

  const badOrigin = Inbox.recordEvent(Object.assign({}, base, { origin: 'cron' }));
  assert.strictEqual(badOrigin.recorded, false, '非法 origin 必须拒收');
  assert.ok(/INVALID_ORIGIN/.test(badOrigin.reason), badOrigin.reason);

  const hist = Inbox.recordEvent(Object.assign({}, base, { origin: 'history' }));
  assert.strictEqual(hist.recorded, true, 'history 可写入时间线');
  const back = Inbox.recordEvent(Object.assign({}, base, { origin: 'backfill', observedAt: new Date(Date.parse(now) + 1000).toISOString() }));
  assert.strictEqual(back.recorded, true, 'backfill 可写入');
  const mon = Inbox.recordEvent(Object.assign({}, base, { origin: 'monitoring', observedAt: new Date(Date.parse(now) + 2000).toISOString() }));
  assert.strictEqual(mon.recorded, true);

  const box = Inbox.listInbox({ tenantId: tid, projectId: pid });
  assert.strictEqual(box.total, 1, '只有 monitoring 进收件箱: ' + box.total);
  assert.ok(box.groups.flatMap(g => g.events).every(e => e.origin === 'monitoring'));
});

// ============================================================
// F9/F10：brandCoverage 唯一投影 + 无重复覆盖区域
// ============================================================
function mkCtx(tid, projectId) {
  const ctx = {
    getAuthPayload: () => (tid ? { kind: 'tenant', payload: { tid } } : null),
    getCurrentId: () => projectId,
    readBody: async () => ({}),
    sendJSON: (res, status, body) => { res.status = status; res.body = body; return true; },
  };
  return ctx;
}
async function callHandler(handler, method, pathname, search, tid) {
  const res = {};
  const url = new URL('http://local' + pathname + (search ? '?' + search : ''));
  await handler(mkCtx(tid, ''), { method, headers: {}, on: () => {}, }, res, url, pathname);
  return res;
}

test('F9 brandCoverage 唯一投影：维度总数来自 Registry，六态区分，列表与详情同源', async () => {
  const tid = 'tenant:r2cov';
  const pid = 'projR2Cov';
  const cid = 'c-r2-cov';
  seedProject(tid, pid, [comp(cid, 'https://' + SITE_HOST + '/', false)]);
  // 真实成功采集一次（提供 available 数据）
  const compObj = CollectJobs.loadCompetitor({ tenantId: tid, projectId: pid, competitorId: cid });
  SITE_HTML = htmlWithPrice(30);
  CollectReq.requestCollection({ tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products', comp: compObj, trigger: 'manual', tickNow: false });
  await drain();

  const list = await callHandler(CoreH.brandsList, 'GET', '/api/brands', 'projectId=' + pid, tid);
  assert.strictEqual(list.status, 200, JSON.stringify(list.body));
  const item = list.body.brands.find(b => b.competitorId === cid);
  assert.ok(item, '品牌在列表中');
  assert.ok(item.brandCoverage, '列表返回 brandCoverage');
  assert.strictEqual(item.brandCoverage.summary.total, Registry.listDimensions().length, '维度总数必须来自 Registry');
  assert.ok(item.stats === undefined);
  assert.strictEqual(list.body.stats.brands, 1, '项目统计同源');

  const detail = await callHandler(CoreH.brandDetail, 'GET', '/api/brands/' + item.brandId, 'projectId=' + pid, tid);
  assert.strictEqual(detail.status, 200);
  assert.ok(detail.body.brandCoverage, '详情返回 brandCoverage');
  assert.strictEqual(detail.body.coverage, undefined, '详情不得再返回第二套 coverage 投影');
  assert.deepStrictEqual(detail.body.brandCoverage.summary, item.brandCoverage.summary, '列表与详情同源同口径');

  const dims = detail.body.brandCoverage.dimensions;
  const byCode = Object.fromEntries(dims.map(d => [d.code, d]));
  assert.strictEqual(byCode.website_products.state, 'available', '有真实数据 → available: ' + JSON.stringify(byCode.website_products));
  assert.ok(byCode.website_products.evidenceCount > 0, '证据计数来自真实引用');
  assert.ok(byCode.website_products.observationCount > 0, '观察计数来自真实观察');
  for (const code of ['social_content', 'ad_campaigns', 'reviews_reputation', 'search_interest']) {
    assert.strictEqual(byCode[code].state, 'not_configured', code + ' 未配置 → not_configured: ' + byCode[code].state);
  }
  // 六态互斥且每个维度都有明确状态
  const allowed = new Set(['available', 'collecting', 'empty', 'failed', 'not_configured', 'not_started']);
  assert.ok(dims.every(d => allowed.has(d.state) && d.stateText));
  // summary 与维度逐一相符
  const sum = detail.body.brandCoverage.summary;
  assert.strictEqual(sum.available, dims.filter(d => d.state === 'available').length);
  assert.strictEqual(sum.notConfigured, dims.filter(d => d.state === 'not_configured').length);
  assert.strictEqual(sum.total, dims.length);
});

test('F10 竞品数据库/品牌详情无重复覆盖区域（代码级约束）', () => {
  const root = path.join(__dirname, '..', '..', 'web', 'src');
  const brandsPage = fs.readFileSync(path.join(root, 'app', '(panel)', 'brands', 'page.tsx'), 'utf8');
  const detailPage = fs.readFileSync(path.join(root, 'app', '(panel)', 'brands', '[brandId]', 'page.tsx'), 'utf8');
  assert.ok(!/CollectionCoverageStrip/.test(brandsPage), '首页不再渲染项目级覆盖条（重复覆盖区）');
  assert.ok(!/import\s*\{[^}]*DataSurfaceOverview|<DataSurfaceOverview/.test(detailPage), '品牌详情不得再挂 DataSurfaceOverview（同义重复组件）');
  assert.ok(!/import\s*\{[^}]*CoveragePanel|<CoveragePanel/.test(detailPage), '品牌详情不再使用旧 CoveragePanel');
  assert.ok(!/coverage\s*=\s*\{d\.coverage\}|d\.coverage\.dimensions/.test(detailPage), '详情不得再读第二套 coverage 投影');
  assert.ok(!/BuildingDims/.test(detailPage), '不再重复渲染「建设中维度」块（覆盖信息只在来源表出现一次）');
  assert.ok((detailPage.match(/brandCoverage/g) || []).length >= 1, '品牌详情消费唯一 brandCoverage 投影');
  assert.ok(!/五维|5 个维度|1\/5/.test(detailPage), '不得硬编码维度总数');
});

// ============================================================
// F11/F12：隔离与项目切换
// ============================================================
test('F11 两租户隔离：列表/详情/收件箱互不可见', async () => {
  const tidA = 'tenant:r2isoA';
  const tidB = 'tenant:r2isoB';
  const pidA = 'projR2IsoA';
  const pidB = 'projR2IsoB';
  seedProject(tidA, pidA, [comp('c-iso-a', 'https://' + SITE_HOST + '/', false)]);
  seedProject(tidB, pidB, []);
  Inbox.recordEvent({
    tenantId: tidA, projectId: pidA, competitorId: 'c-iso-a', dimension: 'price', eventType: 'price_changed',
    title: 'A 的价格变化', observedAt: new Date().toISOString(), origin: 'monitoring',
    change: { field: 'price', oldValue: 1, newValue: 2 },
  });

  const a = await callHandler(CoreH.brandsList, 'GET', '/api/brands', 'projectId=' + pidA, tidA);
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.body.brands.length, 1);
  const b = await callHandler(CoreH.brandsList, 'GET', '/api/brands', 'projectId=' + pidB, tidB);
  assert.strictEqual(b.status, 200);
  assert.strictEqual(b.body.brands.length, 0, 'B 看不到 A 的品牌');
  // 用别人的 projectId 直接访问 → 404（不泄露项目存在性）
  const crossProject = await callHandler(CoreH.brandsList, 'GET', '/api/brands', 'projectId=' + pidA, tidB);
  assert.strictEqual(crossProject.status, 404, '跨租户项目 404');

  const brandId = a.body.brands[0].brandId;
  const cross = await callHandler(CoreH.brandDetail, 'GET', '/api/brands/' + brandId, 'projectId=' + pidB, tidB);
  assert.strictEqual(cross.status, 404, '跨租户详情 404（不泄露存在性）');

  const inboxA = await callHandler(CoreH.intelInbox, 'GET', '/api/intel/inbox', 'projectId=' + pidA, tidA);
  const inboxB = await callHandler(CoreH.intelInbox, 'GET', '/api/intel/inbox', 'projectId=' + pidB, tidB);
  assert.strictEqual(inboxA.body.total, 1);
  assert.strictEqual(inboxB.body.total, 0, 'B 看不到 A 的收件箱事件');
  // 同一租户内跨项目也不得串数据
  const inboxB2 = await callHandler(CoreH.intelInbox, 'GET', '/api/intel/inbox', 'projectId=' + pidA, tidB);
  assert.strictEqual(inboxB2.status, 404);
});

test('F12 projectId 切换：品牌按项目隔离；前端筛选随项目重置', async () => {
  const tid = 'tenant:r2switch';
  const p1 = 'projR2SwitchA';
  const p2 = 'projR2SwitchB';
  seedProject(tid, p1, [comp('c-sw-a', 'https://' + SITE_HOST + '/', false)]);
  seedProject(tid, p2, [comp('c-sw-b', 'https://other-switch.example.com/', false)]);

  const r1 = await callHandler(CoreH.brandsList, 'GET', '/api/brands', 'projectId=' + p1, tid);
  const r2 = await callHandler(CoreH.brandsList, 'GET', '/api/brands', 'projectId=' + p2, tid);
  assert.strictEqual(r1.body.brands.length, 1);
  assert.strictEqual(r2.body.brands.length, 1);
  assert.notStrictEqual(r1.body.brands[0].brandId, r2.body.brands[0].brandId, '不同项目返回各自品牌');
  assert.ok(!r2.body.brands.some(b => b.competitorId === 'c-sw-a'), '切换项目不带入旧品牌');

  // 前端：筛选状态必须在 projectId 变化时重置（否则旧筛选造成假空结果）
  const pageSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'app', '(panel)', 'brands', 'page.tsx'), 'utf8');
  assert.ok(/prevPidRef|projectId\]\s*\)/.test(pageSrc), '存在项目切换的重置逻辑');
  assert.ok(/setKw\(''\)/.test(pageSrc) && /setCover\(''\)/.test(pageSrc), '切换项目清空搜索与筛选');
});

// ============================================================
// F13：价格窗口连续复采不得被 capability 冷却去重成旧观察
//（E2E 实测缺陷：deduped 时旧 attempt 的观察被当成本轮结果，价格变化被吞掉且窗口显示成功）
// ============================================================
test('F13 同一品牌连续两个价格窗口：第二次必须观察到新价格并产生事件（不吃冷却去重）', async () => {
  const tid = 'tenant:r2pricefresh';
  const pid = 'projR2PriceFresh';
  const cid = 'c-r2-pricefresh';
  seedProject(tid, pid, [comp(cid, 'https://' + SITE_HOST + '/', false)]);
  const target = WS.createWatchTarget({
    tenantId: tid, projectId: pid, competitorId: cid,
    market: 'us', timezone: 'UTC', enabledSignals: ['price'], supportedSignals: ['price'],
    enrichmentStatus: 'complete',
  }).target;

  SITE_HTML = htmlWithPrice(30);
  const r1 = await WatchMonitor.executeWindow(target, target.watchTargetId + ':P1', {}, Date.now());
  assert.strictEqual(r1.failed, 0, '首个窗口采集成功: ' + JSON.stringify(r1.signalResults));
  const afterFirst = WS.listProductPrices(tid, pid, cid);
  assert.ok(afterFirst.length >= 1, '首个窗口建立价格基线');

  // 同一品牌、相邻窗口（远小于 capability 冷却）：价格真实变化
  SITE_HTML = htmlWithPrice(41);
  const r2 = await WatchMonitor.executeWindow(target, target.watchTargetId + ':P2', {}, Date.now() + 1000);
  assert.strictEqual(r2.failed, 0);
  // 该页面含 2 个商品 → 2 条真实价格变化
  assert.strictEqual(r2.eventsVerified, 2, '第二次窗口必须观察到新价格并成事件: ' + JSON.stringify({ ev: r2.eventsVerified, pend: r2.eventsPending, wf: r2.eventsWriteFailed, dup: r2.eventsDuplicate }));
  const afterSecond = WS.listProductPrices(tid, pid, cid);
  assert.ok(afterSecond.every(p => p.price >= 41), '价格快照已更新为新价（不是旧观察）: ' + JSON.stringify(afterSecond.map(p => p.price)));
  const box = Inbox.listInbox({ tenantId: tid, projectId: pid });
  assert.strictEqual(box.total, 2, '收件箱出现 2 条价格变化');
  assert.ok(box.groups.flatMap(g => g.events).every(e => e.eventType === 'price_changed' && e.verificationStatus === 'verified'), '价格事件带快照证据 → verified');
});
