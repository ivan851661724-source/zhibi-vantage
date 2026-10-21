'use strict';
// ============================================================
// test/sc07-r2.test.js —— SC-07 评审整改轮（r2）行为回归
// ------------------------------------------------------------
// 六组整改的行为测试（全部真实 SQLite / 真实链路，不绕凭据解析）：
//   C1  搜索凭据统一解析：env-only / config-only / 未配置 / 就绪与真实调用同源
//   C2  非 Shopify 意向持久化建立流程：首探 → 持久化等待 → 二探 → 晋升（重启可恢复）
//   C3  意向失败终态：blocked / rate_limited(带界重试) / no_comparable_products / parse_failed
//   C4  取消语义：取消后不采集、不晋升
//   C5  旧项目一次性幂等迁移：自动入队、重复执行任务数与计费不增、上限生效
//   C6  评论失败门控：冷却 / 退避 / 手动受控检查
//   C7  项目级 collectionCoverage 真实派生 + 租户隔离 + 密钥不外泄
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc07r2-'));
process.env.ZB_DATA_DIR = TMP;
// cost.js 的 cost.sqlite 落在 app/data（仓库内固定路径，.gitignore 已忽略）；
// 全新工作副本该目录可能不存在，测试环境先补齐
try { fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true }); } catch (e) {}
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
// 测试缩短意向探测间隔（默认 60 分钟）：两次探测间隔 1.5 秒，重试等待 0.8 秒
process.env.ZB_INTENT_PROBE_INTERVAL_MS = '1500';
process.env.ZB_INTENT_RATE_RETRY_MS = '800';
process.env.ZB_INTENT_RETRY_BACKOFF_MS = '800';
process.env.ZB_INTENT_PROBE_GRACE_MS = '60000';

const SurfaceStore = require('../services/surface-store.js');
const CollectJobs = require('../services/collect-jobs.js');
const Readiness = require('../services/source-readiness.js');
const Plan = require('../services/collection-plan.js');
const WIntent = require('../services/watch-intent.js');
const WS = require('../services/watch-store.js');
const BrandSvc = require('../services/brand-service.js');
const BrandStore = require('../services/brand-store.js');
const Migration = require('../services/collection-migration.js');
const Db = require('../services/db.js');
const Search = require('../research/search.js');
const { projFile } = require('../core/state-store.js');

const TID = 'tenant:r2a';
const TID_B = 'tenant:r2b';
let seq = 0;
function uid(p) { seq += 1; return p + seq; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function writeState(tenantId, projectId, comps) {
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    tenantId, projectId, track: 'SC07R2 回归', intent: { regions: ['us'] }, excluded: [],
    competitors: comps, discoverDone: true, progress: { total: comps.length, done: comps.length },
  }, null, 2));
}

function nonShopifyComp(projectId, i) {
  return {
    id: 'c-' + projectId + '-' + i,
    name: 'R2品牌' + i,
    url: 'https://r2brand' + i + '-' + projectId + '.example.com',
    status: 'done', isShopify: false,
  };
}

// 轮询等待（worker tick 在 setImmediate/异步链上完成）
async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > (timeoutMs || 5000)) throw new Error('waitFor 超时: ' + (what || 'condition'));
    await sleep(25);
  }
}

// 受控执行器：按队列逐步完成 attempt（模拟真实 adapter 终态，不外发请求）
function makeExecutor(steps) {
  return async (job) => {
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

const P_BASE = 'https://probe-brand.example.com';
function obsFor(paths) {
  return paths.map((p, i) => ({
    id: P_BASE + '/p/' + p, title: 'P' + i, price: 10 + i, currency: 'USD',
    sourceUrl: P_BASE + '/p/' + p,
  }));
}

// ============================================================
// C1 搜索凭据统一解析
// ============================================================
test('C1.1 只配环境变量 Serper key：providerCall 真实把 key 交给受控请求替身', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), headers: Object.assign({}, (opts && opts.headers) || {}) });
    return new Response(JSON.stringify({ organic: [{ title: 't', link: 'https://x.example.com', snippet: 's' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const prevKey = process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY = 'sk-env-only-SECRET';
  try {
    // 就绪判断认 env
    assert.strictEqual(Search.providerConfigured({ search: {} }, 'serper'), true, 'env-only 必须判已配置');
    // 真实调用链（不替换 fanoutSearch/providerCall）：providerCall → failover → serperSearch → fetch
    const r = await Search.providerCall('serper', 'probe query', { search: { provider: 'serper' } }, 'us');
    assert.strictEqual(calls.length, 1, '真实发出一次请求');
    assert.strictEqual(calls[0].headers['X-API-KEY'], 'sk-env-only-SECRET', 'env key 穿透到真实请求头');
    assert.ok((r.results || []).length === 1);
    // 密钥不得进入错误信息（构造一次失败场景复核错误分类码不含 key）
    global.fetch = async () => { throw new Error('SERPER_500'); };
    await assert.rejects(() => Search.providerCall('serper', 'q2', { search: {} }, 'us'), /SERPER_500/);
  } finally {
    global.fetch = realFetch;
    if (prevKey === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = prevKey;
  }
});

test('C1.2 只配运行配置文件 key：同样穿透到真实请求；env+config 双配时 env 优先', async () => {
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(Object.assign({}, (opts && opts.headers) || {}));
    return new Response(JSON.stringify({ organic: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const prevKey = process.env.SERPER_API_KEY;
  delete process.env.SERPER_API_KEY;
  try {
    const cfg = { search: { provider: 'serper', serperKey: 'sk-cfg-file-SECRET', serperKeys: ['sk-cfg-pool-1'] } };
    assert.strictEqual(Search.providerConfigured(cfg, 'serper'), true);
    await Search.providerCall('serper', 'q', cfg, 'us');
    // 既有 Serper 多 key 池语义：serperKeys 数组在前、serperKey 在后（failover 顺序不变）
    assert.strictEqual(calls[0]['X-API-KEY'], 'sk-cfg-pool-1', '配置文件池第一个 key 穿透到真实请求');
    // 双配：env 在前，配置池随后（去重、保序）
    process.env.SERPER_API_KEY = 'sk-env-first';
    const Cred = require('../lib/search-credentials.js');
    const keys = Cred.resolveSearchCredentials(cfg).serper.keys;
    assert.deepStrictEqual(keys, ['sk-env-first', 'sk-cfg-pool-1', 'sk-cfg-file-SECRET']);
    // tavily/brave/bocha 同源
    const c2 = Cred.resolveSearchCredentials({ search: { braveKey: 'bk', bochaKey: 'ok', apiKey: 'tk' } });
    assert.strictEqual(c2.brave.key, 'bk');
    assert.strictEqual(c2.bocha.key, 'ok');
    assert.strictEqual(c2.tavily.key, 'tk', 'tavily 认历史别名 apiKey');
    process.env.BRAVE_API_KEY = 'env-bk';
    assert.strictEqual(Cred.resolveSearchCredentials({ search: { braveKey: 'bk' } }).brave.key, 'env-bk', 'env 优先于配置文件');
    delete process.env.BRAVE_API_KEY;
  } finally {
    global.fetch = realFetch;
    if (prevKey === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = prevKey;
  }
});

test('C1.3 未配置才 NO_SERPER_KEY；就绪可用时真实链不得抛 NO_SERPER_KEY（§六.1）', async () => {
  const prevKey = process.env.SERPER_API_KEY;
  delete process.env.SERPER_API_KEY;
  const realFetch = global.fetch;
  try {
    assert.strictEqual(Search.providerConfigured({ search: {} }, 'serper'), false, '未配置判否');
    await assert.rejects(() => Search.providerCall('serper', 'q', { search: {} }, 'us'), /NO_SERPER_KEY/);
    // 一致性：仅 env key 时——就绪可用（readiness 不再 not_configured），真实链打通（不得 NO_SERPER_KEY）
    process.env.SERPER_API_KEY = 'sk-env-ok';
    global.fetch = async () => new Response(JSON.stringify({ organic: [{ title: 't', link: 'https://y.example.com', snippet: 's' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    const rd = Readiness.getReadiness('public_reviews');
    assert.notStrictEqual(rd.state, 'not_configured', 'env-only：readiness 判可用');
    const r = await Search.searchProvider('consistency probe', { search: { provider: 'serper' } }, 'us', 'off');
    assert.ok((r.results || []).length >= 1, 'searchProvider 全链打通，无 NO_SERPER_KEY');
  } finally {
    global.fetch = realFetch;
    if (prevKey === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = prevKey;
  }
});

// ============================================================
// C2 非 Shopify 意向持久化建立流程（§六.2 + §六.4 重启恢复 + §六.5 price-only）
// ============================================================
test('C2 首探 → 持久化等待 → 二探 → 确定性 Diff → 正式监控（只声明 price）', async () => {
  const projectId = 'projC2';
  const comp = nonShopifyComp(projectId, 1);
  writeState(TID, projectId, [comp]);

  const a = WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id, reasonCode: 'no_direct_source' });
  assert.ok(a.intent.intentId);
  WIntent.scheduleFirstProbe({ tenantId: TID, projectId, competitorId: comp.id });
  let intent = WIntent.findIntent(TID, projectId, comp.id);
  assert.ok(intent.nextProbeAt, '第一次探测已安排（持久化）');

  // 第一次探测：runDueProbes → 真实入队 public_site_products → 执行器完成（可比商品）
  const steps = [{ status: 'success', observations: obsFor(['a']) }];
  CollectJobs.setExecutorForTest(makeExecutor(steps));
  try {
    const r1 = WIntent.runDueProbes();
    assert.strictEqual(r1.enqueued, 1, '首次探测真实入队');
    const firstAttemptId = r1.details[0].attemptId;
    await waitFor(() => {
      const it = WIntent.findIntent(TID, projectId, comp.id);
      return it.probeCount === 1 && it.nextProbeAt && new Date(it.nextProbeAt).getTime() > Date.now();
    }, 5000, '首探完成后持久化下一次探测时间');
    intent = WIntent.findIntent(TID, projectId, comp.id);
    assert.strictEqual(intent.state, 'establishing');
    assert.strictEqual(intent.lastProbeAttemptId, firstAttemptId, '真实 attempt 记录');
    assert.strictEqual(WIntent.view(intent).monitoring, false, '仍未正式监控');
    const step1 = WIntent.view(intent).nextStepText;
    assert.ok(/已安排下一次来源探测/.test(step1 || ''), '明确下一步: ' + step1);

    // 重启恢复（§六.4）：next_probe_at 在库里；模拟时间流逝后调度器照常执行第二次独立采集
    const now2 = Date.now() + WIntent.PROBE_INTERVAL_MS + 1000;
    Readiness.recordVerification({ capability: 'public_site_products', provider: 'public_site_products_fetch', status: 'success', tenantId: TID });
    steps.push({ status: 'success', observations: obsFor(['a']) }); // 同商品不同价格（10+i 相同价→改价验证 diff）
    steps[1] = { status: 'success', observations: obsFor(['a']).map((o, i) => ({ ...o, price: 12 })) };
    const r2 = WIntent.runDueProbes(now2);
    assert.strictEqual(r2.enqueued, 1, '第二次探测真实入队（重启后可恢复）');
    const secondAttemptId = r2.details[0].attemptId;
    assert.notStrictEqual(secondAttemptId, firstAttemptId, '两次采集不同 attempt');
    await waitFor(() => WIntent.findIntent(TID, projectId, comp.id).state === 'promoted', 5000, '第二次可比采集后晋升');

    intent = WIntent.findIntent(TID, projectId, comp.id);
    assert.strictEqual(intent.state, 'promoted');
    assert.ok(intent.promotedTargetId);
    assert.strictEqual(intent.nextProbeAt, null, '晋升后不再安排探测');
    // §六.5：正式非 Shopify Target 只声明并执行价格信号
    const target = WS.listWatchTargets(TID, projectId).find(t => t.watchTargetId === intent.promotedTargetId);
    assert.ok(target, '正式 WatchTarget 已创建');
    assert.deepStrictEqual(target.supportedSignals, ['price'], 'supportedSignals 只能是 price');
    assert.deepStrictEqual(target.enabledSignals, ['price'], 'enabledSignals 只含 price');
    const sched = WS.listSchedulableTargets().filter(t => t.competitorId === comp.id && t.tenantId === TID);
    assert.strictEqual(sched.length, 1, '正式目标进入调度器巡检集合');
    const v = WIntent.view(intent);
    assert.strictEqual(v.monitoring, true);
    assert.ok(/两次可比较采集/.test(v.reasonText || ''), '晋升原因可读');
  } finally {
    CollectJobs.setExecutorForTest(null);
  }
});

// ============================================================
// C3 意向失败终态（SC-08 r2 §一：商品来源失败先尝试官网来源，两源都不行才真实失败）
// ============================================================
async function advanceProbes(projectId, comp, rounds) {
  for (let i = 0; i < (rounds || 8); i++) {
    WIntent.runDueProbes(Date.now() + (i + 1) * 60 * 60 * 1000);
    await sleep(120);
    if (WIntent.findIntent(TID, projectId, comp.id).state === 'source_failed') return;
  }
}

test('C3.1 商品页 403 → 先尝试官网来源；官网也拒访 → source_failed/blocked，无后续自动采集', async () => {
  const projectId = 'projC3a';
  const comp = nonShopifyComp(projectId, 1);
  writeState(TID, projectId, [comp]);
  WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id });
  WIntent.scheduleFirstProbe({ tenantId: TID, projectId, competitorId: comp.id });
  CollectJobs.setExecutorForTest(makeExecutor([
    { status: 'failed', sourceStatus: 'blocked', errorUserText: '来源站点拒绝访问（403/401）' },
    { status: 'failed', sourceStatus: 'blocked', errorUserText: '来源站点拒绝访问（403/401）' },
  ]));
  try {
    const r = WIntent.runDueProbes();
    assert.strictEqual(r.enqueued, 1);
    await waitFor(() => {
      const cur = WIntent.findIntent(TID, projectId, comp.id);
      return cur.lastProbeAttemptId === r.details[0].attemptId && cur.nextProbeCapability === 'official_site_profile';
    }, 5000, '首探完成并切到官网来源');
    // 商品页被拒 ≠ 官网不可用：先切官网来源，并且真实失败要等官网也拒访
    let it = WIntent.findIntent(TID, projectId, comp.id);
    assert.strictEqual(it.state, 'establishing', '商品页失败不得直接判死');
    assert.strictEqual(it.nextProbeCapability, 'official_site_profile', '切换到官网来源继续建立');
    assert.ok(it.nextProbeAt, '仍有下一步任务');

    await advanceProbes(projectId, comp, 4);
    it = WIntent.findIntent(TID, projectId, comp.id);
    assert.strictEqual(it.state, 'source_failed', '两源都拒访后进入真实失败');
    assert.strictEqual(it.reasonCode, 'blocked');
    assert.strictEqual(it.nextProbeAt, null, 'blocked 无自动重试');
    assert.ok(/拒绝/.test(WIntent.view(it).reasonText || ''));
    // SC-08 r2 §一.8：失败必须给「可执行的下一步」，不是空泛的「稍后再试」
    assert.ok(/重新点击「加入监控」/.test(WIntent.view(it).nextStepText || ''), '明确下一步：可执行的重试动作: ' + WIntent.view(it).nextStepText);
    const jobsBefore = CollectJobs.getDb().prepare('SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=?').get(TID, projectId).n;
    WIntent.runDueProbes(Date.now() + 24 * 60 * 60 * 1000);
    await sleep(120);
    const jobsAfter = CollectJobs.getDb().prepare('SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=?').get(TID, projectId).n;
    assert.strictEqual(jobsAfter, jobsBefore, 'blocked 不自动重试');
    // 用户重新加入 → 重新建立
    WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id, reasonCode: 'no_direct_source' });
    WIntent.scheduleFirstProbe({ tenantId: TID, projectId, competitorId: comp.id });
    assert.strictEqual(WIntent.findIntent(TID, projectId, comp.id).state, 'establishing', '手动重试可重新建立');
    // 清场：取消遗留意向，避免其探测计划影响后续用例的 runDueProbes（全局扫描）
    WIntent.cancelIntent(TID, WIntent.findIntent(TID, projectId, comp.id).intentId);
  } finally { CollectJobs.setExecutorForTest(null); }
});

test('C3.2 429 → source_failed/rate_limited 且带有界重试时间；到期自动恢复重试', async () => {
  const projectId = 'projC3b';
  const comp = nonShopifyComp(projectId, 2);
  writeState(TID, projectId, [comp]);
  WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id });
  WIntent.scheduleFirstProbe({ tenantId: TID, projectId, competitorId: comp.id });
  CollectJobs.setExecutorForTest(makeExecutor([
    { status: 'failed', sourceStatus: 'rate_limited', errorUserText: '来源限流' },
  ]));
  try {
    const r = WIntent.runDueProbes();
    assert.strictEqual(r.enqueued, 1);
    await waitFor(() => WIntent.findIntent(TID, projectId, comp.id).state === 'source_failed', 5000, 'rate_limited 状态');
    const it = WIntent.findIntent(TID, projectId, comp.id);
    assert.strictEqual(it.reasonCode, 'rate_limited');
    assert.ok(it.nextProbeAt, '429 带有界重试时间（持久化）');
    assert.strictEqual(it.nextProbeCapability, 'public_site_products', '限流重试留在同一来源（不把限流当"没有价格"）');
    const v = WIntent.view(it);
    assert.ok(/自动重试/.test(v.nextStepText || ''), '明确下一步：已安排重试: ' + v.nextStepText);
    // 到期后自动恢复为 establishing 并重新探测
    const r2 = WIntent.runDueProbes(Date.now() + WIntent.RATE_RETRY_MS + 1000);
    assert.strictEqual(r2.enqueued, 1, '限流重试到期自动执行');
    assert.strictEqual(WIntent.findIntent(TID, projectId, comp.id).state, 'establishing');
    // 清场
  } finally {
    try { WIntent.cancelIntent(TID, WIntent.findIntent(TID, projectId, comp.id).intentId); } catch (e) { /* 无意向 */ }
    CollectJobs.setExecutorForTest(null);
  }
});

test('C3.3 商品页无可比价格 + 官网无可核实字段 → 有界重试后 source_failed（不是永久建立中）', async () => {
  const projectId = 'projC3c';
  const comp = nonShopifyComp(projectId, 3);
  writeState(TID, projectId, [comp]);
  WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id });
  WIntent.scheduleFirstProbe({ tenantId: TID, projectId, competitorId: comp.id });
  CollectJobs.setExecutorForTest(makeExecutor([
    { status: 'success', observations: [{ id: 'x', title: '无价格商品' }] }, // 无 price/currency → 不可比
  ]));
  try {
    WIntent.runDueProbes();
    await waitFor(() => {
      const it = WIntent.findIntent(TID, projectId, comp.id);
      return it.nextProbeCapability === 'official_site_profile';
    }, 5000, '无可比价格后切官网来源');
    // 之后官网采集同样拿不到可用结构化原文（测试执行器不落真实快照）→ 有界重试后真实失败
    await advanceProbes(projectId, comp, 10);
    const it = WIntent.findIntent(TID, projectId, comp.id);
    assert.strictEqual(it.state, 'source_failed', '不得永久停在 establishing: ' + it.state);
    assert.ok(['insufficient_structured_fields', 'no_comparable_products'].includes(it.reasonCode), '真实失败原因: ' + it.reasonCode);
    assert.strictEqual(it.nextProbeAt, null);
    assert.ok(WIntent.view(it).nextStepText, '失败必须给可执行下一步');
    WIntent.cancelIntent(TID, it.intentId);
  } finally { CollectJobs.setExecutorForTest(null); }
});

test('C3.4 商品页解析失败 → 先尝试官网；官网解析也失败 → source_failed/parse_failed', async () => {
  const projectId = 'projC3d';
  const comp = nonShopifyComp(projectId, 4);
  writeState(TID, projectId, [comp]);
  WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id });
  WIntent.scheduleFirstProbe({ tenantId: TID, projectId, competitorId: comp.id });
  CollectJobs.setExecutorForTest(makeExecutor([
    { status: 'failed', sourceStatus: 'parse_failed', errorUserText: '页面无法解析' },
    { status: 'failed', sourceStatus: 'parse_failed', errorUserText: '页面无法解析' },
  ]));
  try {
    WIntent.runDueProbes();
    await waitFor(() => WIntent.findIntent(TID, projectId, comp.id).nextProbeCapability === 'official_site_profile', 5000, '切官网');
    await advanceProbes(projectId, comp, 4);
    const it = WIntent.findIntent(TID, projectId, comp.id);
    assert.strictEqual(it.reasonCode, 'parse_failed');
    assert.strictEqual(it.nextProbeAt, null, '解析失败不自动重试');
    WIntent.cancelIntent(TID, it.intentId);
  } finally { CollectJobs.setExecutorForTest(null); }
});

// ============================================================
// C4 取消语义：取消后不得继续采集或自动晋升
// ============================================================
test('C4 取消意向：探测计划清空、调度器不再入队、迟到的采集结果不晋升', async () => {
  const projectId = 'projC4';
  const comp = nonShopifyComp(projectId, 5);
  writeState(TID, projectId, [comp]);
  const a = WIntent.requestIntent({ tenantId: TID, projectId, competitorId: comp.id });
  WIntent.scheduleFirstProbe({ tenantId: TID, projectId, competitorId: comp.id });
  const cancelled = WIntent.cancelIntent(TID, a.intent.intentId);
  assert.strictEqual(cancelled.state, 'cancelled');
  assert.strictEqual(cancelled.nextProbeAt, null, '取消清空探测计划');
  const due = WIntent.runDueProbes(Date.now() + WIntent.PROBE_INTERVAL_MS * 10);
  assert.strictEqual(due.enqueued, 0, '取消后调度器不再入队');
  // 即使有迟到的成功采集结果，也不得晋升
  const mk = SurfaceStore.createAttempt({
    tenantId: TID, projectId, competitorId: comp.id, capability: 'public_site_products',
    dimension: 'website_products', trigger: 'manual', idempotencyKey: uid('c4-'),
  });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
    status: 'success', observations: obsFor(['z']), summary: {}, snapshotIds: ['s'], evidenceIds: ['e'],
  }, null);
  const r = WIntent.onProbeFinished({ tenantId: TID, projectId, competitorId: comp.id, attempt: SurfaceStore.getAttempt(TID, mk.attempt.attemptId) });
  assert.strictEqual(r.action, 'ignored_cancelled');
  assert.strictEqual(WIntent.findIntent(TID, projectId, comp.id).state, 'cancelled');
  assert.strictEqual(WS.listWatchTargets(TID, projectId).length, 0, '取消后不得创建正式监控');
});

// ============================================================
// C5 旧项目一次性幂等迁移（§三 / §六.6）
// ============================================================
test('C5 迁移：无 attempt 项目自动入队；重复执行任务数不增；上限与租户隔离生效', () => {
  // 租户 A：projM1（无 attempt → 迁移）；租户 B：projM2（无 attempt → 迁移）
  const compsA = [nonShopifyComp('projM1', 1), nonShopifyComp('projM1', 2)];
  writeState(TID, 'projM1', compsA);
  writeState(TID_B, 'projM2', [nonShopifyComp('projM2', 1)]);
  // projM3 已有 attempt（真实调研过的项目）→ 不属于「尚无 attempt」迁移范围
  writeState(TID, 'projM3', [nonShopifyComp('projM3', 1)]);
  // 迁移扫描的是 db projects 表（真实部署里项目都在库内）：镜像档案行
  const { mirrorProjectToDb } = require('../core/state-store.js');
  mirrorProjectToDb('projM1', TID, 'C5');
  mirrorProjectToDb('projM2', TID_B, 'C5');
  mirrorProjectToDb('projM3', TID, 'C5');
  const mk = SurfaceStore.createAttempt({
    tenantId: TID, projectId: 'projM3', competitorId: 'c-projM3-1', capability: 'official_site_profile',
    dimension: 'website_profile', trigger: 'schedule', idempotencyKey: uid('c5-'),
  });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, { status: 'success', observations: [{ id: 'h1' }], summary: {}, snapshotIds: ['s'], evidenceIds: ['e'] }, null);

  const before = Migration.jobCounts();
  const r1 = Migration.runMigration({ maxProjects: 50, maxReviewsTotal: 5 });
  assert.strictEqual(r1.ok, true);
  // r3 契约更新：删除「项目有任意 attempt 就整体跳过」——已有 attempt 的项目也按
  // 品牌 × capability 缺口补齐（projM3 的唯一品牌官网已有终态 → 记 reused，不重复入队）
  assert.strictEqual(r1.migrated, 3, '三个项目都按缺口执行迁移: ' + JSON.stringify(r1.perProject));
  const perM3 = r1.perProject.find(p => p.projectId === 'projM3');
  assert.ok(perM3 && perM3.outcome === 'migrated' && perM3.counts.reused >= 1, 'projM3 官网能力复用已有终态: ' + JSON.stringify(perM3));
  const after1 = Migration.jobCounts();
  assert.ok(after1.total > before.total, '迁移真实入队');
  const perM1 = r1.perProject.find(p => p.projectId === 'projM1');
  assert.ok(perM1 && perM1.counts.enqueued >= 2, 'projM1 每品牌官网资料入队: ' + JSON.stringify(perM1));

  // 一次性幂等：重复执行 → 全部 skippedDone，任务数与迁移账目不增（§六.6）
  // skippedDone = 3 个项目都已完成迁移（含 projM3 的复用式迁移）
  const r2 = Migration.runMigration({ maxProjects: 50 });
  assert.strictEqual(r2.migrated, 0);
  assert.strictEqual(r2.skippedDone, 3);
  const after2 = Migration.jobCounts();
  assert.strictEqual(after2.total, after1.total, '重复执行任务数不增（不重复计费）');

  // 记录迁移版本与执行状态
  const rec = Migration.getRecord(TID, 'projM1');
  assert.strictEqual(rec.migrationId, Migration.MIGRATION_ID);
  assert.strictEqual(rec.status, 'done');
  assert.ok(rec.runId && rec.finishedAt, '执行状态可核');

  // 数量上限生效
  const r3 = Migration.runMigration({ maxProjects: 1, onlyWithoutAttempts: false, maxReviewsTotal: 0 });
  assert.ok(r3.scanned <= 1, 'maxProjects 上限生效');

  // 租户隔离：迁移按 (tenant, project) 各自记账，互不越界
  assert.ok(Migration.getRecord(TID, 'projM1'), 'A 记录存在');
  assert.ok(Migration.getRecord(TID_B, 'projM2'), 'B 记录存在');
  assert.strictEqual(Migration.getRecord(TID, 'projM2'), null, 'A 看不到 B 的项目迁移记录');
});

// ============================================================
// C6 public_reviews 失败门控（§五）
// ============================================================
function setLastVerification(capability, failureClass, ageMs) {
  // 只保留本次写入的失败行：否则旧行（更新时间）仍是「最近失败」，改时间无效
  SurfaceStore.getDb().prepare('DELETE FROM provider_verifications WHERE capability=? AND status=?').run(capability, 'failed');
  const r = Readiness.recordVerification({
    capability, provider: 'test', status: 'failed', failureClass, tenantId: TID,
  });
  if (ageMs) {
    SurfaceStore.getDb().prepare('UPDATE provider_verifications SET created_at=? WHERE id=?')
      .run(new Date(Date.now() - ageMs).toISOString(), r.id);
  }
  return r;
}

test('C6.1 quota_exhausted：冷却期内自动计划跳过；冷却到点放行；手动可触发受控检查', () => {
  const comp = { id: 'c-gate1', name: 'GateBrand', url: 'https://gate1.example.com', status: 'done', isShopify: false };
  writeState(TID, 'projGate1', [comp]);
  const prevKey = process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY = 'test-key-not-real'; // 凭据在位，失败记录才能反映为运行态（否则恒 not_configured）
  try {
    setLastVerification('public_reviews', 'rate_limited', 0); // 刚失败 → 冷却期内
    const gAuto = Plan.gate('public_reviews', comp, { trigger: 'schedule' });
    assert.strictEqual(gAuto.ok, false);
    assert.strictEqual(gAuto.reason, 'source_cooldown', '额度/限流冷却期内不重复创建任务');
    assert.ok(gAuto.retryAfterMs > 0, '有明确冷却剩余时间');
    const gManual = Plan.gate('public_reviews', comp, { trigger: 'manual' });
    assert.strictEqual(gManual.ok, true, '用户手动重试可触发一次受控检查');
    // 冷却到点（默认 6h 前的失败）→ 放行一次
    setLastVerification('public_reviews', 'rate_limited', 7 * 60 * 60 * 1000);
    const gAfter = Plan.gate('public_reviews', comp, { trigger: 'schedule' });
    assert.strictEqual(gAfter.ok, true, '冷却到点允许受控检查（仍受日额度/幂等约束）');
  } finally {
    if (prevKey === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = prevKey;
  }
});

test('C6.2 unavailable：退避期内跳过；退避到点放行', () => {
  const comp = { id: 'c-gate2', name: 'GateBrand2', url: 'https://gate2.example.com', status: 'done', isShopify: false };
  writeState(TID, 'projGate2', [comp]);
  const prevKey = process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY = 'test-key-not-real';
  try {
    setLastVerification('public_reviews', 'unavailable', 0);
    const gAuto = Plan.gate('public_reviews', comp, { trigger: 'schedule' });
    assert.strictEqual(gAuto.ok, false);
    assert.strictEqual(gAuto.reason, 'source_backoff', 'unavailable 按退避时间重试');
    setLastVerification('public_reviews', 'unavailable', 60 * 60 * 1000);
    assert.strictEqual(Plan.gate('public_reviews', comp, { trigger: 'schedule' }).ok, true, '退避到点放行');
  } finally {
    if (prevKey === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = prevKey;
  }
});

test('C6.3 auth_rejected/not_configured：配置恢复前不自动重试', () => {
  const comp = { id: 'c-gate3', name: 'GateBrand3', url: 'https://gate3.example.com', status: 'done', isShopify: false };
  writeState(TID, 'projGate3', [comp]);
  const prevKey = process.env.SERPER_API_KEY;
  process.env.SERPER_API_KEY = 'test-key-not-real';
  try {
    setLastVerification('public_reviews', 'auth_rejected', 24 * 60 * 60 * 1000);
    const gAuto = Plan.gate('public_reviews', comp, { trigger: 'schedule' });
    assert.strictEqual(gAuto.ok, false);
    assert.strictEqual(gAuto.reason, 'source_auth_rejected');
  } finally {
    if (prevKey === undefined) delete process.env.SERPER_API_KEY; else process.env.SERPER_API_KEY = prevKey;
  }
  // 未配置（无任何搜索凭据）
  const gNoKey = Plan.gate('public_reviews', comp, { trigger: 'schedule' });
  assert.strictEqual(gNoKey.ok, false);
  assert.strictEqual(gNoKey.reason, 'source_not_configured');
});

// ============================================================
// C7 collectionCoverage 真实派生 + 租户隔离 + 密钥不外泄
// ============================================================
test('C7 项目级 collectionCoverage：七态计数、失败明细、JSON 无密钥、租户隔离', async () => {
  const projectId = 'projC7';
  const comps = [nonShopifyComp(projectId, 1), nonShopifyComp(projectId, 2), nonShopifyComp(projectId, 3)];
  writeState(TID, projectId, comps);
  comps.forEach((c) => {
    const up = BrandStore.upsertBrand({ tenantId: TID, canonicalName: 'R2-' + c.id, officialDomain: c.id + '.example.com', competitorRef: c.id });
    BrandStore.linkProject({ tenantId: TID, brandId: up.brand.brandId, projectId, competitorRef: c.id });
  });
  // 品牌1：成功有数据；品牌2：失败（带原因）；品牌3：入队排队中
  const mk1 = SurfaceStore.createAttempt({ tenantId: TID, projectId, competitorId: comps[0].id, capability: 'official_site_profile', dimension: 'website_profile', trigger: 'schedule', idempotencyKey: uid('c7a-') });
  SurfaceStore.completeAttempt(TID, mk1.attempt.attemptId, { status: 'success', observations: [{ id: 'p', sourceUrl: 'https://x' }], summary: {}, snapshotIds: ['s'], evidenceIds: ['e'] }, null);
  const mk2 = SurfaceStore.createAttempt({ tenantId: TID, projectId, competitorId: comps[1].id, capability: 'official_site_profile', dimension: 'website_profile', trigger: 'schedule', idempotencyKey: uid('c7b-') });
  SurfaceStore.completeAttempt(TID, mk2.attempt.attemptId, { status: 'failed', sourceStatus: 'blocked', errorClass: 'blocked', errorUserText: '对方站点拒绝了公开页面访问', observations: [], snapshotIds: [], evidenceIds: [] }, null);
  const mk3 = SurfaceStore.createAttempt({ tenantId: TID, projectId, competitorId: comps[2].id, capability: 'official_site_profile', dimension: 'website_profile', trigger: 'schedule', idempotencyKey: uid('c7c-') });

  const cov = BrandSvc.buildProjectCollectionCoverage(TID, projectId);
  assert.strictEqual(cov.brands, 3);
  assert.strictEqual(cov.counts.has_data, 1);
  assert.strictEqual(cov.counts.failed, 1);
  assert.strictEqual(cov.counts.collecting, 1, 'running attempt → 采集中（不得写成尚未开始）');
  assert.ok(cov.failures.length >= 1 && cov.failures[0].brandName && /拒绝/.test(cov.failures[0].reason || ''), '失败明细保留品牌、原因');
  assert.ok(cov.failures[0].at, '失败明细带时间');

  // 密钥不外泄：coverage JSON 与意向视图不得含任何凭据值
  process.env.SERPER_API_KEY = 'sk-leak-canary-SECRET';
  try {
    const cov2 = BrandSvc.buildProjectCollectionCoverage(TID, projectId);
    assert.ok(!JSON.stringify(cov2).includes('sk-leak-canary'), 'coverage 不含密钥');
    const it = WIntent.findIntent(TID, projectId, comps[0].id) || WIntent.listIntents(TID, projectId)[0];
    if (it) assert.ok(!JSON.stringify(WIntent.view(it)).includes('sk-leak-canary'), '意向视图不含密钥');
    const mig = Migration.runMigration({ maxProjects: 1, onlyWithoutAttempts: false, maxReviewsTotal: 0 });
    assert.ok(!JSON.stringify(mig).includes('sk-leak-canary'), '迁移输出不含密钥');
  } finally {
    delete process.env.SERPER_API_KEY;
  }

  // 租户隔离（§六.8）：B 租户查不到 A 的品牌/覆盖
  const covB = BrandSvc.buildProjectCollectionCoverage(TID_B, projectId);
  assert.strictEqual(covB.brands, 0, '另一租户看不到品牌覆盖');
  assert.strictEqual(BrandStore.getBrand(TID_B, (BrandStore.upsertBrand({ tenantId: TID, canonicalName: 'R2-' + comps[0].id, officialDomain: comps[0].id + '.example.com', competitorRef: comps[0].id })).brand.brandId), null, '跨租户品牌不可读');
});

// 清理：避免遗留 pending job 影响其他测试文件（同进程内顺序执行时）
test.after?.(() => {
  try {
    CollectJobs.getDb().prepare("UPDATE collection_jobs SET status='dead' WHERE status IN ('pending','running')").run();
  } catch (e) { /* 无关紧要 */ }
});
