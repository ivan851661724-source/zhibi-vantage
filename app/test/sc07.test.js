'use strict';
// ============================================================
// test/sc07.test.js —— SC-07「采集启动、监控资格与情报库修复」行为回归
// ------------------------------------------------------------
// 覆盖三类已观察现象（不是文案问题）：
//   S1/S2 已有项目首轮采集：有计划、有界、可重复、幂等（不重复产生任务）
//   S3    搜索凭据「任选其一」：只配一个 provider 不再被判未配置
//   S4    公开评论：候选页全失败 ≠ 成功零结果
//   S5/S6 监控意向：不偷偷建 WatchTarget；调度器不调度意向；未验证不得升级
//   S7/S8 情报库去噪：无观察的品牌不生成评论卡；失败可查
//   S9    品牌采集状态由真实 attempt 派生
// 说明：全部走受控 fixture（真实 attempt 生命周期 + 真实 SQLite），
//      不伪造「真实来源采集成功」；真实站点验收在测试服执行并单独记录。
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc07-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';

const Registry = require('../services/capability-registry.js');
const Readiness = require('../services/source-readiness.js');
const SurfaceStore = require('../services/surface-store.js');
const CollectJobs = require('../services/collect-jobs.js');
const Adapters = require('../services/source-adapter.js');
const Plan = require('../services/collection-plan.js');
const WIntent = require('../services/watch-intent.js');
const WS = require('../services/watch-store.js');
const BrandSvc = require('../services/brand-service.js');
const BrandStore = require('../services/brand-store.js');
const VoiceUnified = require('../services/voice-unified.js');
const Net = require('../research/net.js');
const Search = require('../research/search.js');
const { projFile } = require('../core/state-store.js');

const TID = 'tenant:sc07';
const TID_B = 'tenant:sc07-other';
let seq = 0;
function uid(p) { seq += 1; return p + seq; }

function writeState(tenantId, projectId, comps) {
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    tenantId, projectId, track: 'SC07 回归', intent: { regions: ['us'] }, excluded: [],
    competitors: comps, discoverDone: true, progress: { total: comps.length, done: comps.length },
  }, null, 2));
}

function compsOf(projectId, n, shopify) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'c-' + projectId + '-' + (i + 1),
    name: '品牌' + (i + 1),
    url: 'https://brand' + (i + 1) + '-' + projectId + '.example.com',
    status: 'done',
    isShopify: !!shopify,
  }));
}

function jobsFor(projectId, capability) {
  const q = capability
    ? "SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND capability=?"
    : "SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=?";
  return capability
    ? CollectJobs.getDb().prepare(q).get(TID, projectId, capability).n
    : CollectJobs.getDb().prepare(q).get(TID, projectId).n;
}

function clearJobs(projectId) {
  CollectJobs.getDb().prepare('DELETE FROM collection_jobs WHERE tenant_id=? AND project_id=?').run(TID, projectId);
}

// ---------- S1：已有项目补建真正入队，逐项留决策 ----------
test('S1 bootstrap：已有品牌全部进入首轮计划，逐品牌逐能力留决策（入队/跳过+原因）', () => {
  const projectId = 'projS1';
  const comps = compsOf(projectId, 3, false);
  writeState(TID, projectId, comps);

  const out = Plan.bootstrapProject({ tenantId: TID, projectId, limit: 10, maxReviews: 0 });
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.brands, 3, '三个已完成品牌都进计划');
  assert.ok(out.counts.enqueued >= 3, '每个品牌至少安排官网资料采集: ' + JSON.stringify(out.counts));
  assert.strictEqual(out.counts.planned || 0, 0);

  // 官网资料：3 个任务都入队（系统发起 schedule）
  assert.strictEqual(jobsFor(projectId, 'official_site_profile'), 3, '三个官网资料任务已入队');
  const rows = CollectJobs.getDb().prepare(
    "SELECT trigger, status FROM collection_jobs WHERE tenant_id=? AND project_id=? AND capability='official_site_profile'"
  ).all(TID, projectId);
  rows.forEach((r) => {
    assert.strictEqual(r.trigger, 'schedule', '自动首采是系统发起，不是用户点击');
    assert.strictEqual(r.status, 'pending', '进入正常队列等 worker 消费');
  });

  // 逐品牌决策齐全：非 Shopify 不安排目录、未验证能力不安排商品页、无搜索配置不安排评论
  const b0 = out.perBrand[0];
  const byCap = {};
  b0.decisions.forEach(d => { byCap[d.capability] = d; });
  assert.strictEqual(byCap.official_site_profile.decision, 'enqueued');
  assert.strictEqual(byCap.shopify_catalog.reason, 'not_shopify_site');
  assert.strictEqual(byCap.public_site_products.reason, 'awaiting_real_verification');
  assert.strictEqual(byCap.public_reviews.reason, 'source_not_configured');
  // 决策落库（可审计「为什么没采」）
  const log = Plan.listPlanLog(TID, projectId, 50);
  assert.ok(log.length >= 12, '逐品牌逐能力都有审计记录: ' + log.length);
  assert.ok(log.some(x => x.decision === 'skipped' && x.reason === 'not_shopify_site'));
});

// ---------- S2：重复执行不重复产生任务 ----------
test('S2 重复补建不重复收费：第二次全部去重，任务数不增', () => {
  const projectId = 'projS2';
  writeState(TID, projectId, compsOf(projectId, 2, false));
  const first = Plan.bootstrapProject({ tenantId: TID, projectId, maxReviews: 0 });
  const n1 = jobsFor(projectId);
  assert.ok(first.counts.enqueued >= 2, '首次入队: ' + JSON.stringify(first.counts));

  const second = Plan.bootstrapProject({ tenantId: TID, projectId, maxReviews: 0 });
  const n2 = jobsFor(projectId);
  assert.strictEqual(second.counts.enqueued, 0, '第二次不应再产生新任务: ' + JSON.stringify(second.counts));
  assert.ok(second.counts.deduped >= 2, '应为去重: ' + JSON.stringify(second.counts));
  assert.strictEqual(n2, n1, '任务总数不增（不重复收费）');
});

// ---------- S3：搜索凭据任选其一 ----------
test('S3 只配置一个搜索 provider 时，公开评论不被误判「未配置」', () => {
  const cap = Registry.getCapability('public_reviews');
  assert.strictEqual(cap.credentialMode, 'any_of', '搜索链是任选其一，不是四个全配');
  // 基线：没有任何搜索凭据 → not_configured
  const before = Readiness.getReadiness('public_reviews');
  assert.strictEqual(before.state, 'not_configured', '无凭据时应为未配置');

  // 只给 Serper 一个 key
  const prev = process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY = 'test-key-not-real';
  try {
    const after = Readiness.getReadiness('public_reviews');
    assert.notStrictEqual(after.state, 'not_configured', '仅一个 provider 也算已配置: ' + after.state);
    assert.strictEqual(after.credentialMode, 'any_of');
    assert.deepStrictEqual(after.configKeysPresent.SERPER_API_KEY, true);
    assert.strictEqual(after.configKeysPresent.TAVILY_API_KEY, false, '未配置的备选通道如实显示缺失');
  } finally {
    if (prev === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = prev;
  }
});

// ---------- S4：候选页全失败 ≠ 成功零结果 ----------
test('S4 公开评论：候选页全部受限 → failed；真正检查完但无可归属页 → 成功零结果', async () => {
  const projectId = 'projS4';
  const comp = { id: 'compS4', name: 'ReviewBrand', url: 'https://reviewbrand-s4.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, [comp]);

  const origFetch = Net.fetchPage;
  const origFanout = Search.fanoutSearch;
  // 搜索链可用（等价于部署只配了一个 provider）：采集才不会被 CONFIG_MISSING 挡在门外
  const prevKey = process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY = 'test-key-not-real';
  // 搜索链「可用」：直接注入候选（不打真实搜索）。
  // 🔴 SC-11：fanoutSearch 真实契约是「每查询一个 searchProvider 结果」的**数组**
  // （discover.js 同款）；旧替身返回 {results} 单对象，恰好与 reviewsAdapter 的
  // 错误消费方式互锁，测试永远绿而线上 37/37 全灭。替身必须对齐真实契约。
  Search.fanoutSearch = async () => [
    { results: [
      { url: 'https://reviewbrand-s4.example.com/reviews', title: 'ReviewBrand reviews' },
      { url: 'https://trustpilot.example.com/reviewbrand-s4', title: 'ReviewBrand reviews' },
    ] },
    { results: [] },
    { results: [] },
  ];

  try {
    // ① 全部限流 → failed / rate_limited，不得落成 success 0
    Net.fetchPage = async () => ({ ok: false, status: 429, error: 'http:429' });
    const mk1 = SurfaceStore.createAttempt({
      tenantId: TID, projectId, competitorId: comp.id, capability: 'public_reviews',
      dimension: 'reviews_reputation', trigger: 'manual', idempotencyKey: uid('s4a-'),
    });
    const r1 = await Adapters.getAdapter('reviews').collect({
      tenantId: TID, projectId, competitor: comp, trigger: 'manual', attemptId: mk1.attempt.attemptId,
    });
    assert.strictEqual(r1.attempt.status, 'failed', '全部受限必须失败，不能伪装成功零评论');
    assert.strictEqual(r1.attempt.sourceStatus || r1.attempt.source_status, 'rate_limited', '按限流如实分类');
    assert.ok(/限流|访问频率/.test(String(r1.attempt.errorUserText || '')), '用户文案说明限流: ' + r1.attempt.errorUserText);

    // ② 判定口径（纯函数）：抓到页面但都不可归属 → 成功零结果；无候选 → 成功零结果
    //    （真实 attempt 的 success 落定需要真实快照/证据，此处只验证分类口径，
    //     避免用假 snapshot 伪造证据链）
    assert.deepStrictEqual(
      Adapters.classifyReviewPages({ pages: [], candidates: 2, pageAttempts: 2, pageFetchFailed: 0, pageUnattributed: 2 }),
      { kind: 'empty', emptyReason: 'no_attributable_pages' },
      '检查完成但无可归属页 → 成功零结果（带成因）');
    assert.deepStrictEqual(
      Adapters.classifyReviewPages({ pages: [], candidates: 0 }),
      { kind: 'empty', emptyReason: 'no_candidate_pages' },
      '搜索完成无候选 → 成功零结果');
    assert.deepStrictEqual(
      Adapters.classifyReviewPages({ pages: [], candidates: 2, pageAttempts: 2, pageFetchFailed: 2, lastStatus: 429 }),
      { kind: 'failed', sourceStatus: 'rate_limited' },
      '全限流 → 失败（不是零结果）');
    assert.deepStrictEqual(
      Adapters.classifyReviewPages({ pages: [{ id: 'p' }], candidates: 2, pageAttempts: 2, pageFetchFailed: 0 }),
      { kind: 'ok', emptyReason: null },
      '有可归属页 → 正常成功');
  } finally {
    Net.fetchPage = origFetch;
    Search.fanoutSearch = origFanout;
    if (prevKey === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = prevKey;
  }
});

// ---------- S5：监控意向幂等且不被调度 ----------
test('S5 非 Shopify「加入监控」= 监控意向：幂等、不进正式巡检、未验证不得升级', () => {
  const projectId = 'projS5';
  const comp = { id: 'compS5', name: 'IntentBrand', url: 'https://intentbrand-s5.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, [comp]);

  const a = WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id, reasonCode: 'no_direct_source', reasonText: '正在建立公开商品页来源' });
  assert.ok(a.intent && a.intent.intentId);
  assert.strictEqual(a.intent.state, 'establishing');
  const b = WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id, reasonCode: 'no_direct_source' });
  assert.strictEqual(b.intent.intentId, a.intent.intentId, '同租户同项目同品牌幂等');
  assert.strictEqual(b.existed, true);

  // 关键：意向不进正式巡检集合（调度器只看 watch_targets）
  const sched = WS.listSchedulableTargets().filter(t => t.tenantId === TID && t.competitorId === comp.id);
  assert.strictEqual(sched.length, 0, '意向不得被调度器当作 active 目标');
  const view = WIntent.view(b.intent);
  assert.strictEqual(view.monitoring, false, '对外不得声称「监控中」');
  assert.strictEqual(view.stateText, '正在建立监控来源');

  // 未通过真实验证 → 不得升级
  const p1 = WIntent.tryPromote({ tenantId: TID, projectId, competitorId: comp.id });
  assert.strictEqual(p1.promoted, false);
  assert.strictEqual(p1.reason, 'source_not_verified', '未验证来源不得升级: ' + p1.reason);

  // 退出 → 不再自动激活
  const c = WIntent.cancelIntent(TID, a.intent.intentId);
  assert.strictEqual(c.state, 'cancelled');
  const after = WIntent.listIntents(TID, projectId).filter(x => x.competitorId === comp.id);
  assert.strictEqual(after.length, 1);
  assert.strictEqual(after[0].state, 'cancelled');
});

// ---------- S6：两次可比较采集 + 真实成功才升级 ----------
test('S6 升级门槛：真实验证 + 两次可比较采集 + 可计算 Diff，缺一不可', () => {
  const projectId = 'projS6';
  const comp = { id: 'compS6', name: 'PromoteBrand', url: 'https://promotebrand-s6.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, [comp]);
  WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id, reasonCode: 'no_direct_source' });

  const mkAttempt = (obs, idem) => {
    const mk = SurfaceStore.createAttempt({
      tenantId: TID, projectId, competitorId: comp.id, capability: 'public_site_products',
      dimension: 'website_products', trigger: 'schedule', idempotencyKey: uid(idem),
    });
    SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
      status: 'success', observations: obs,
      summary: { kind: 'public_site_products', productCount: obs.length },
      snapshotIds: ['snap-' + idem], evidenceIds: ['ev-' + idem],
    }, null);
    return mk.attempt.attemptId;
  };
  const obsA = [{ id: 'https://promotebrand-s6.example.com/p/a', title: 'A', price: 10, currency: 'USD' }];
  const obsB = [{ id: 'https://promotebrand-s6.example.com/p/a', title: 'A', price: 12, currency: 'USD' }];

  // 只有一次采集 → 不足以升级
  mkAttempt(obsA, 's6a-');
  let el = WIntent.promotionEligibility(TID, projectId, comp.id);
  assert.strictEqual(el.eligible, false);
  assert.ok(/source_not_verified|need_two/.test(el.reason), '原因可解释: ' + el.reason);

  // 记录一次真实成功 → operational，但只有一次可比较采集
  Readiness.recordVerification({ capability: 'public_site_products', provider: 'public_site_products_fetch', status: 'success', tenantId: TID });
  mkAttempt(obsB, 's6b-');
  el = WIntent.promotionEligibility(TID, projectId, comp.id);
  assert.strictEqual(el.readiness, 'operational');
  assert.strictEqual(el.comparableAttempts, 2);
  assert.strictEqual(el.eligible, true, '两次可比较采集 + 可计算 Diff → 允许升级: ' + JSON.stringify(el));
  assert.strictEqual(el.diff.comparable, true);
  assert.strictEqual(el.diff.changes.length, 1, '确定性能算出 10 → 12');
  assert.strictEqual(el.diff.changes[0].old, 10);
  assert.strictEqual(el.diff.changes[0].new, 12);

  const p = WIntent.tryPromote({ tenantId: TID, projectId, competitorId: comp.id, timezone: 'America/New_York', market: 'us' });
  assert.strictEqual(p.promoted, true, '满足全部硬条件才升级: ' + JSON.stringify(p).slice(0, 200));
  assert.strictEqual(p.intent.state, 'promoted');
  // 升级后目标进入正式巡检集合，且执行器支持该来源（price 信号）
  const sched = WS.listSchedulableTargets().filter(t => t.tenantId === TID && t.competitorId === comp.id);
  assert.strictEqual(sched.length, 1, '正式监控对象进入巡检集合');
  assert.deepStrictEqual(sched[0].enabledSignals, ['price'], '非 Shopify 只启用可核实的价格信号');
});

// ---------- S7：情报库去噪 ----------
test('S7 情报库：无公开评论观察的品牌不生成评论卡；覆盖摘要计零结果与失败', () => {
  const projectId = 'projS7';
  const comps = compsOf(projectId, 3, false);
  writeState(TID, projectId, comps);
  // 三个品牌都登记进品牌库（模拟真实 18 品牌项目）
  comps.forEach((c) => {
    const up = BrandStore.upsertBrand({ tenantId: TID, canonicalName: 'SC07-' + c.id, officialDomain: c.id + '.example.com', competitorRef: c.id });
    BrandStore.linkProject({ tenantId: TID, brandId: up.brand.brandId, projectId, competitorRef: c.id });
  });
  // 只有第一个品牌有一条带证据的评论观察
  const mk = SurfaceStore.createAttempt({
    tenantId: TID, projectId, competitorId: comps[0].id, capability: 'public_reviews',
    dimension: 'reviews_reputation', trigger: 'manual', idempotencyKey: uid('s7-'),
  });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
    status: 'success',
    observations: [{ id: 'rv1', title: 'Review page', snippet: 'delivery slow', sourceUrl: 'https://reviews.example.com/1', rating: 2, reviewCount: 8, publishedAt: '2026-10-01T00:00:00.000Z' }],
    summary: { kind: 'reviews_digest', reviewCount: 8, sourceCount: 1 },
    snapshotIds: ['snap-s7'], evidenceIds: ['ev-s7'],
  }, null);

  const summary = VoiceUnified.buildProjectVoiceSummary(TID, projectId, {});
  assert.strictEqual(summary.length, 1, '只有有观察的品牌生成卡片，其余不出卡: ' + summary.length);
  assert.ok((summary[0].recentItems || []).length >= 1);

  const cov = VoiceUnified.buildProjectVoiceCoverage(TID, projectId);
  assert.strictEqual(cov.brands, 3);
  assert.strictEqual(cov.withObservations, 1);
  assert.strictEqual(cov.notCollected, 2, '没有采集记录的品牌计入未采集，而不是空评论卡');
});

// ---------- S8：品牌采集状态由真实 attempt 派生 ----------
test('S8 品牌采集状态：未采/有数据/失败分别表达，不再统一「尚未开始」', () => {
  const projectId = 'projS8';
  const comps = compsOf(projectId, 3, false);
  writeState(TID, projectId, comps);

  // ① 从未采集
  const s0 = BrandSvc.buildCollectionState(TID, projectId, comps[0]);
  assert.ok(['not_started', 'source_pending'].indexOf(s0.state) !== -1, '未采集状态: ' + s0.state);
  assert.ok(!/尚未开始采集/.test(s0.stateText) || s0.state === 'not_started');

  // ② 成功且有观察 → 有证据数据
  const mk = SurfaceStore.createAttempt({
    tenantId: TID, projectId, competitorId: comps[1].id, capability: 'official_site_profile',
    dimension: 'website_products', trigger: 'schedule', idempotencyKey: uid('s8a-'),
  });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
    status: 'success', observations: [{ id: 'p1', title: 'Home', sourceUrl: 'https://x.example.com' }],
    summary: { kind: 'official_site_profile' }, snapshotIds: ['s'], evidenceIds: ['e'],
  }, null);
  const s1 = BrandSvc.buildCollectionState(TID, projectId, comps[1]);
  assert.strictEqual(s1.state, 'has_data', '有观察 → 有证据数据');
  assert.strictEqual(s1.stateText, '有证据数据');

  // ③ 只有失败 → 失败（带原因）
  const mk2 = SurfaceStore.createAttempt({
    tenantId: TID, projectId, competitorId: comps[2].id, capability: 'official_site_profile',
    dimension: 'website_products', trigger: 'schedule', idempotencyKey: uid('s8b-'),
  });
  SurfaceStore.completeAttempt(TID, mk2.attempt.attemptId, {
    status: 'failed', sourceStatus: 'blocked', errorClass: 'blocked',
    errorUserText: '对方站点拒绝了公开页面访问，稍后可重试。', observations: [], snapshotIds: [], evidenceIds: [],
  }, null);
  const s2 = BrandSvc.buildCollectionState(TID, projectId, comps[2]);
  assert.strictEqual(s2.state, 'failed');
  assert.ok(/拒绝|失败/.test(String(s2.reason)), '失败原因可查: ' + s2.reason);

  // ④ 项目级覆盖计数
  const cov = BrandSvc.buildProjectCollectionCoverage(TID, projectId);
  assert.strictEqual(cov.brands, 3);
  assert.strictEqual(cov.counts.has_data, 1);
  assert.strictEqual(cov.counts.failed, 1);
  assert.ok(cov.failures.length >= 1 && cov.failures[0].brandName, '失败明细可查品牌');
});

// ---------- S9：租户隔离 ----------
test('S9 跨租户隔离：意向、采集状态、补建决策都按租户硬过滤', () => {
  const projectId = 'projS9';
  const comp = { id: 'compS9', name: 'Isolated', url: 'https://isolated-s9.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, [comp]);
  WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id });

  assert.strictEqual(WIntent.listIntents(TID_B, projectId).length, 0, '另一租户看不到意向');
  assert.strictEqual(WIntent.findIntent(TID_B, projectId, comp.id), null);
  assert.strictEqual(Plan.listPlanLog(TID_B, projectId, 10).length, 0, '另一租户看不到补建决策');
  const covB = BrandSvc.buildProjectCollectionCoverage(TID_B, projectId);
  assert.strictEqual(covB.brands, 0, '另一租户看不到品牌覆盖');
  // 清理本用例遗留任务，避免影响后续用例的 claim 顺序
  clearJobs(projectId);
});
