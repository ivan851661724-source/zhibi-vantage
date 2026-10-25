'use strict';
// ============================================================
// test/sc11-staging-p0.test.js —— SC-11 测试服真实复现 P0 的行为回归
// ------------------------------------------------------------
// 背景（2026-10-25 测试服 47.254.35.254 真实复现，37/37 public_reviews job 全灭）：
//   根因1 reviewsAdapter 把 fanoutSearch 的返回当 {results} 对象消费，而真实契约是
//         「每查询一个结果」的数组（discover.js 同款）→ 候选恒为 0 → 每次评论采集
//         都走「无候选」分支，产出 outcome=success 但零快照的输出；
//   根因2 该输出被 validateOutput「evidence-grade provenance requires >=1 snapshot」
//         拒绝 → errorClass=adapter_output_invalid；
//   根因3 执行器链耗尽把 errorClass 直接当 sourceStatus 传给 completeAttempt →
//         抛 invalid source_status → 外层 catch 把真实失败抹成 internal_error。
//   漏测原因：sc07 替身按错误契约打桩（{results} 单对象），与错误消费方式互锁。
// 本文件三条回归（对应三个根因）+ 两条既有口径复核，全部走真实 attempt 生命周期
// （真实 SQLite + 真实 executor 路径 executeJob），不伪造「真实来源采集成功」。
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc11p0-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.SERPER_API_KEY = 'test-key-not-real'; // 搜索链「已配置」（等价单 provider 部署）

const SurfaceStore = require('../services/surface-store.js');
const CollectJobs = require('../services/collect-jobs.js');
const Adapters = require('../services/source-adapter.js');
const Net = require('../research/net.js');
const Search = require('../research/search.js');
const { projFile } = require('../core/state-store.js');

const TID = 'tenant:sc11p0';
let seq = 0;
function uid(p) { seq += 1; return p + seq; }

function writeState(tenantId, projectId, comps) {
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    tenantId, projectId, track: 'SC11P0 回归', intent: { regions: ['us'] }, excluded: [],
    competitors: comps, discoverDone: true, progress: { total: comps.length, done: comps.length },
  }, null, 2));
}

function mkAttempt(projectId, comp, key) {
  return SurfaceStore.createAttempt({
    tenantId: TID, projectId, competitorId: comp.id, capability: 'public_reviews',
    dimension: 'reviews_reputation', trigger: 'manual', idempotencyKey: uid(key),
  }).attempt;
}

// 真实 executor 路径：入队 → 认领（running + claimToken + 租约）→ executeJob
function claimJob(projectId, comp, attemptId) {
  const enq = CollectJobs.enqueue({
    tenantId: TID, projectId, competitorId: comp.id, capability: 'public_reviews',
    attemptId, trigger: 'manual', collectionPurpose: 'manual_refresh',
  });
  const job = CollectJobs.claim('sc11p0-worker');
  assert.ok(job, 'job 必须能被认领');
  assert.strictEqual(job.jobId, enq.jobId);
  return job;
}

// ---------- T1：候选解析契约定死（根因1） ----------
test('T1 评论候选发现按 fanoutSearch 真实契约（数组）解析；跨查询去重；全失败仍如实失败', async () => {
  const projectId = 'projT1';
  const comp = { id: 'c-t1', name: 'ReviewBrand', url: 'https://reviewbrand-t1.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, [comp]);
  const origFanout = Search.fanoutSearch;
  const origFetch = Net.fetchPage;
  // 真实契约：每查询一个 {results}；同一 URL 命中两个查询（去重）；第三个查询无结果
  Search.fanoutSearch = async () => [
    { results: [
      { url: 'https://reviewbrand-t1.example.com/reviews', title: 'ReviewBrand reviews' },
      { url: 'https://trustpilot.example.com/reviewbrand-t1', title: 'ReviewBrand reviews' },
    ] },
    { results: [
      { url: 'https://reviewbrand-t1.example.com/reviews', title: 'dup' }, // 跨查询重复 → 只采一次
      { link: 'https://reddit.example.com/r/x/reviewbrand', title: 'reddit' }, // link 字段兼容
    ] },
    { results: [] },
  ];
  let fetchCalls = 0;
  Net.fetchPage = async (url) => { fetchCalls += 1; return { ok: false, status: 429, error: 'http:429' }; };
  try {
    const mk = mkAttempt(projectId, comp, 't1a-');
    const r = await Adapters.getAdapter('reviews').collect({
      tenantId: TID, projectId, competitor: comp, trigger: 'manual', attemptId: mk.attemptId,
    });
    // 候选非空（旧代码恒为 0 会落 success-empty）→ 逐页 429 → 如实 failed/rate_limited
    assert.strictEqual(r.attempt.status, 'failed', '候选页全部受限必须失败，不能伪装成功零评论');
    assert.strictEqual(r.attempt.sourceStatus || r.attempt.source_status, 'rate_limited', '按限流如实分类');
    assert.strictEqual(fetchCalls, 3, '去重后 3 个唯一候选各抓一次: ' + fetchCalls);
  } finally {
    Search.fanoutSearch = origFanout;
    Net.fetchPage = origFetch;
  }
});

// ---------- T2：零候选 = 成功零观察（根因1的下游：不再撞校验、不再崩） ----------
test('T2 评论零候选：legacy 采集落 success 零观察（带成因），不抛错、不伪装失败', async () => {
  const projectId = 'projT2';
  const comp = { id: 'c-t2', name: 'ObscureBrand', url: 'https://obscure-t2.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, [comp]);
  const origFanout = Search.fanoutSearch;
  Search.fanoutSearch = async () => [{ results: [] }, { results: [] }, { results: [] }]; // 搜索完成、零候选
  try {
    const mk = mkAttempt(projectId, comp, 't2a-');
    const r = await Adapters.getAdapter('reviews').collect({
      tenantId: TID, projectId, competitor: comp, trigger: 'manual', attemptId: mk.attemptId,
    });
    assert.strictEqual(r.attempt.status, 'success', '检查完成但无候选 = 成功零观察（≠ 失败 ≠ 未接入）');
    assert.strictEqual(r.attempt.sourceStatus || r.attempt.source_status, 'success');
    const obs = Array.isArray(r.attempt.observations) ? r.attempt.observations : [];
    assert.strictEqual(obs.length, 0, '零观察');
    const sum = r.attempt.summary || {};
    assert.strictEqual(sum.kind, 'reviews_digest');
    assert.strictEqual(sum.reviewCount, 0);
    assert.strictEqual(sum.sourceCount, 0);
    assert.strictEqual(sum.emptyReason, 'no_candidate_pages', '零结果必须带成因（05 §11：无记录≠没有变化）');
    // identity 不因零观察升级（无 Evidence 不得 resolved）
    const ids = SurfaceStore.listIdentities
      ? SurfaceStore.listIdentities(TID, projectId, comp.id)
      : [];
    assert.ok(!ids.some(x => x.identityStatus === 'resolved'), '零观察不得升级 identity');
  } finally {
    Search.fanoutSearch = origFanout;
  }
});

// ---------- T3：零候选走真实 executor（suppress → empty 形态 → commitProviderEmpty） ----------
test('T3 评论零候选：provider 运行模式返 empty 形态，executor 落 success 且 job 可正常终结', async () => {
  const projectId = 'projT3';
  const comp = { id: 'c-t3', name: 'ObscureBrand3', url: 'https://obscure-t3.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, [comp]);
  const origFanout = Search.fanoutSearch;
  Search.fanoutSearch = async () => [{ results: [] }];
  try {
    // ① suppress 模式：adapter 只产出结构化 empty 结果，不写终态
    const mk = mkAttempt(projectId, comp, 't3a-');
    const r = await Adapters.getAdapter('reviews').collect({
      tenantId: TID, projectId, competitor: comp, trigger: 'manual', attemptId: mk.attemptId, suppressTerminal: true,
    });
    assert.strictEqual(r.providerOk, true);
    assert.strictEqual(r.empty, true, '零候选必须走 empty 形态（shopify_catalog 同款），不得走 validate 路径');
    assert.strictEqual(r.capability, 'public_reviews');
    assert.deepStrictEqual(r.snapshotIds, []);
    assert.strictEqual(r.summary.emptyReason, 'no_candidate_pages');
    // suppress 模式不得写 attempt 终态（终态写入权唯一归属 executor）
    const att = SurfaceStore.getAttempt(TID, mk.attemptId);
    assert.strictEqual(att.status, 'running', 'suppress 模式禁写终态');

    // ② 真实 executor：executeJob 走完链耗尽以外的正常分支 → success + finish
    const mk2 = mkAttempt(projectId, comp, 't3b-');
    const job = claimJob(projectId, comp, mk2.attemptId);
    const out = await CollectJobs.executeJob(job);
    assert.ok(out && out.attempt, 'executor 必须返回 attempt');
    assert.strictEqual(out.attempt.status, 'success', 'executor 对 empty 形态落 success 零观察');
    const fin = CollectJobs.finish(job.jobId, job.claimToken, 'done');
    assert.ok(fin, 'job 可正常终结');
    const att2 = SurfaceStore.getAttempt(TID, mk2.attemptId);
    assert.strictEqual(att2.status, 'success');
    assert.strictEqual((att2.summary || {}).sourceCount, 0);
  } finally {
    Search.fanoutSearch = origFanout;
  }
});

// ---------- T4：链耗尽 errorClass→sourceStatus 归一（根因3，测试服崩溃点） ----------
test('T4 链耗尽：adapter_output_invalid 不再当 source_status 抛错；attempt 落 failed/internal_error 且 errorClass 保真', async () => {
  const projectId = 'projT4';
  const comp = { id: 'c-t4', name: 'InvalidOutBrand', url: 'https://invalidout-t4.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, [comp]);
  const rev = Adapters.getAdapter('reviews');
  const origCollect = rev.collect;
  // 复刻测试服现场：adapter 产出 providerOk 但输出过不了完整性校验（零快照的 success）
  rev.collect = async (ctx) => ({
    providerOk: true,
    ident: { platform: 'public_web', officialDomain: 'invalidout-t4.example.com', platformAccountId: 'invalidout-t4.example.com', identityStatus: 'unresolved', resolverVersion: 'sc11-test' },
    raw: { snapshotIds: [] },
    out: {
      capability: 'public_reviews', dimension: 'reviews_reputation', outcome: 'success',
      observations: [], summary: { kind: 'reviews_digest', reviewCount: 0, sourceCount: 0 },
      snapshotIds: [], evidenceSnapshotIds: [], currency: null, currencyStatus: 'unknown',
      identityStatus: 'unresolved', parserVersion: 'sc11-test',
    },
  });
  try {
    const mk = mkAttempt(projectId, comp, 't4a-');
    const job = claimJob(projectId, comp, mk.attemptId);
    // 旧行为：completeAttempt 抛 'surface-store: invalid source_status (05 §11): adapter_output_invalid'
    const out = await CollectJobs.executeJob(job);
    assert.ok(out && out.attempt, '链耗尽必须正常返回（不得把异常甩给外层 catch）');
    assert.strictEqual(out.attempt.status, 'failed');
    assert.strictEqual(out.attempt.sourceStatus, 'internal_error', '非法 errorClass 归一到 internal_error（管线故障，不冤枉来源）');
    assert.strictEqual(out.attempt.errorClass, 'adapter_output_invalid', 'errorClass 保真（内部分类不丢失）');
    assert.ok(/完整性校验/.test(String(out.attempt.errorUserText || '')), '用户文案走 adapter_output_invalid 口径: ' + out.attempt.errorUserText);
    assert.ok(out.chainExhausted === true, '标记链耗尽');
  } finally {
    rev.collect = origCollect;
  }
});

// ---------- T6：候选抓到但全部不可归属 = 成功零结果（不得用非本品牌页面当证据） ----------
test('T6 评论无可归属页：成功零观察（no_attributable_pages），快照不被引用为证据，identity 不升级', async () => {
  const projectId = 'projT6';
  const comp = { id: 'c-t6', name: 'AttrBrand', url: 'https://attrbrand-t6.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, [comp]);
  const origFanout = Search.fanoutSearch;
  const origFetch = Net.fetchPage;
  // 候选存在（修复后候选解析真实生效），但 URL/标题都不含品牌名或域名 → 全部不可归属
  Search.fanoutSearch = async () => [{ results: [
    { url: 'https://listicle.example.com/best-supplements-2026', title: 'Best supplements 2026' },
    { url: 'https://forum.example.com/thread/123', title: 'Which supplement brand?' },
  ] }];
  const snapshotRows = [];
  Net.fetchPage = async (url) => {
    snapshotRows.push(url);
    // 返回带 snapshotId 的成功抓取（不可归属页；其快照不得被 attempt 引用为证据）
    return { ok: true, status: 200, snapshotId: 'snap-t6-' + snapshotRows.length, html: '<html><body>generic listicle</body></html>' };
  };
  try {
    const mk = mkAttempt(projectId, comp, 't6a-');
    const r = await Adapters.getAdapter('reviews').collect({
      tenantId: TID, projectId, competitor: comp, trigger: 'manual', attemptId: mk.attemptId,
    });
    assert.strictEqual(r.attempt.status, 'success', '检查完成但无可归属页 = 成功零结果（≠ 失败）');
    assert.strictEqual(r.attempt.sourceStatus || r.attempt.source_status, 'success');
    assert.strictEqual((r.attempt.summary || {}).emptyReason, 'no_attributable_pages', '零结果带成因');
    assert.strictEqual((r.attempt.summary || {}).sourceCount, 0);
    const evIds = Array.isArray(r.attempt.evidenceIds) ? r.attempt.evidenceIds : [];
    assert.strictEqual(evIds.length, 0, '不可归属页不得产出 Evidence');
    const snapRefs = Array.isArray(r.attempt.snapshotIds) ? r.attempt.snapshotIds : [];
    assert.strictEqual(snapRefs.length, 0, '不可归属页的快照不被 attempt 引用');
    // identity 不得因零观察升级
    const ids = SurfaceStore.listIdentities(TID, projectId, comp.id);
    assert.ok(!ids.some(x => x.identityStatus === 'resolved'), '零观察不得升级 identity');
  } finally {
    Search.fanoutSearch = origFanout;
    Net.fetchPage = origFetch;
  }
});

// ---------- T7：词表纪律复核（completeAttempt 对非法 source_status 必须拒绝） ----------
test('T5 词表纪律：completeAttempt 仍拒绝 05 §11 之外的 source_status（防线不回退）', () => {
  const projectId = 'projT5';
  const comp = { id: 'c-t5', name: 'VocabBrand', url: 'https://vocab-t5.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, [comp]);
  const mk = mkAttempt(projectId, comp, 't5a-');
  assert.throws(() => SurfaceStore.completeAttempt(TID, mk.attemptId, {
    status: 'failed', sourceStatus: 'adapter_output_invalid', errorClass: 'adapter_output_invalid',
    observations: [], snapshotIds: [], evidenceIds: [],
  }, null), /invalid source_status/, 'surface-store 防线必须保持：归一化发生在执行器，不是放松校验');
  // 合法值照常放行
  const done = SurfaceStore.completeAttempt(TID, mk.attemptId, {
    status: 'failed', sourceStatus: 'internal_error', errorClass: 'adapter_output_invalid',
    observations: [], snapshotIds: [], evidenceIds: [],
  }, null);
  assert.strictEqual(done.status, 'failed');
});
