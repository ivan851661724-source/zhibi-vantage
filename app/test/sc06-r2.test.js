'use strict';
// ============================================================
// test/sc06-r2.test.js —— SC-06 评审整改 r2 行为回归
// ------------------------------------------------------------
// 覆盖评审确认的三组问题（不是文案问题，是功能未接通 / 状态不诚实 / 链路不通）：
//   G1 buildOpportunities() 只读统一评论事实链；旧 reviews/painPoints/voiceItems
//      不再能当独立统计来源（不进机会分母）
//   G2 仅有中性/未分类公开评论 → 不生成「满意度 × 重要性」散点，如实说
//      「用户声音已采集，但尚不足以形成满意度机会判断」
//   G3 带 Evidence/Snapshot 的正负分类 + sentimentBasis 才可进入机会算法输入
//   G4 旧字段绕过统一模型：直接喂 legacy comps → 机会图隐藏、分母为 0
//   G5 public_site_products 未真实验证 → 不得 operational / 已采集（四层区分）
//   G6 official_site_profile 随正常调研自动入队（与手动刷新同一链路）
//   G7 worker 超时会真正取消底层请求，且后续任务仍可执行
//   G8 两租户隔离：统一评论事实链不跨租户
// 说明：本文件用受控 fixture（attempt 落账）做确定性回归；真实来源验收由
//      web/e2e/live-site-verify.cjs 承担，不在此文件伪造「真实采集成功」。
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc06r2-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';

const Registry = require('../services/capability-registry.js');
const SurfaceStore = require('../services/surface-store.js');
const Surface = require('../services/data-surface.js');
const Adapters = require('../services/source-adapter.js');
const CollectJobs = require('../services/collect-jobs.js');
const CollectReq = require('../services/collect-request.js');
const Readiness = require('../services/source-readiness.js');
const VoiceUnified = require('../services/voice-unified.js');
const OPP = require('../lib/opportunity.js');
const ReportSvc = require('../services/report-service.js');
const BrandSvc = require('../services/brand-service.js');
const { projFile } = require('../core/state-store.js');

const TID = 'tenant:sc06r2';
const TID_B = 'tenant:sc06r2-other';

let seq = 0;
function uid(p) { seq += 1; return p + seq; }

function writeState(tenantId, projectId, state) {
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(state, null, 2));
}

function mkState(projectId, comps) {
  return {
    tenantId: TID, projectId, track: 'SC06 r2 回归',
    intent: { regions: ['us'] }, excluded: [],
    competitors: comps, discoverDone: true, progress: { total: comps.length, done: comps.length },
  };
}

// 受控 fixture：走生产 createAttempt/completeAttempt 生命周期落一条评论观察
function seedReviews(tenantId, projectId, compId, observations) {
  const mk = SurfaceStore.createAttempt({
    tenantId, projectId, competitorId: compId,
    capability: 'public_reviews', dimension: 'reviews_reputation',
    trigger: 'manual', idempotencyKey: uid('r2-rev-'),
  });
  assert.ok(mk.attempt, 'createAttempt 成功');
  const obs = observations || [{
    id: 'r1', title: 'Review page', snippet: 'public review snippet',
    sourceUrl: 'https://reviews.example.com/' + compId, rating: 4.1, reviewCount: 12,
    publishedAt: '2026-10-01T00:00:00.000Z',
  }];
  return SurfaceStore.completeAttempt(tenantId, mk.attempt.attemptId, {
    status: 'success',
    observations: obs,
    summary: { kind: 'reviews_digest', reviewCount: 12, sourceCount: 1, measurementMethod: 'public_source_observation' },
    snapshotIds: ['snap-' + compId], evidenceIds: ['ev-' + compId],
  }, null);
}

function reviewObs(compId, extra) {
  return Object.assign({
    id: 'r-' + compId, title: 'Review page ' + compId, snippet: '发货太慢，等了三个星期',
    sourceUrl: 'https://reviews.example.com/' + compId, rating: 2.0, reviewCount: 9,
    publishedAt: '2026-10-02T00:00:00.000Z',
  }, extra || {});
}

function threeDoneComps(projectId) {
  return ['c1', 'c2', 'c3'].map((id, i) => ({
    id, name: '品牌' + (i + 1), url: 'https://brand' + (i + 1) + '.example.com',
    status: 'done', isShopify: false,
  }));
}

// ---------- G1/G2：只有中性/未分类评论 → 不出满意度散点 ----------
test('G1 buildOpportunities：只读统一评论事实链；旧 reviews/painPoints/voiceItems 不进分母', () => {
  const projectId = 'projR2A';
  const comps = threeDoneComps(projectId);
  // 旧链路字段：如果它们还能进分母，这里必然出图
  comps.forEach((c) => {
    c.reviews = { negThemes: ['发货太慢', '客服不回'], posThemes: ['包装好看'], basis: 'inferred' };
    c.painPoints = [{ point: '价格太贵' }];
    c.voiceItems = [{ platform: 'reddit', polarity: 'neg', text: '旧链路口碑条目', url: 'https://reddit.com/r/x', date: '2026-01-01' }];
  });
  const state = mkState(projectId, comps);
  writeState(TID, projectId, state);
  comps.forEach(c => seedReviews(TID, projectId, c.id, [reviewObs(c.id)]));

  const view = ReportSvc.buildOpportunities(TID, projectId, state, {});
  assert.strictEqual(view.status, 'insufficient_voice',
    '拿不到带依据的正负分类 → 不生成机会（旧字段不得顶替）: ' + view.status);
  assert.deepStrictEqual(view.items, [], '旧 reviews/painPoints/voiceItems 不产生任何机会项');
  assert.ok(view.voiceBasis, '必须显式给出评论事实链资格状态');
  assert.strictEqual(view.voiceBasis.collected, 3, '已采集的可核验评论观察 = 3');
  assert.strictEqual(view.voiceBasis.qualified, 0, '合格输入 = 0（没有 sentimentBasis）');
  assert.strictEqual(view.voiceBasis.gate, 'no_evidence_backed_polarity');
  assert.ok(/尚不足以形成满意度机会判断/.test(view.statusText), '如实说明: ' + view.statusText);
  assert.ok(Array.isArray(view.nextSteps) && view.nextSteps.length, '保留下一步建议');
});

test('G2 中性/未分类评论不当作正面或负面：不进满意度分子分母，也不画散点', () => {
  const projectId = 'projR2B';
  const comps = threeDoneComps(projectId);
  const state = mkState(projectId, comps);
  writeState(TID, projectId, state);
  // 显式中性 + 未分类混在一起
  comps.forEach((c, i) => seedReviews(TID, projectId, c.id, [
    reviewObs(c.id, { sentiment: 'neu', polarity: 'neu' }),
    reviewObs(c.id + '-b', { snippet: '没有情绪判断的片段' }),
  ]));

  const view = ReportSvc.buildOpportunities(TID, projectId, state, {});
  assert.strictEqual(view.status, 'insufficient_voice');
  assert.deepStrictEqual(view.items, []);
  assert.strictEqual(view.voiceBasis.collected, 6, '六条观察都被采集到');
  assert.strictEqual(view.voiceBasis.qualified, 0, 'neu/未分类不计入合格输入');

  const map = OPP.computeOpportunityMap(
    comps.map(c => ({ id: c.id, name: c.name, status: 'done' })),
    { voiceItems: [], voiceCollected: 6 });
  assert.strictEqual(map.hidden, true, '没有合格输入 → 不出图');
  assert.strictEqual(map.mentionsTotal, 0, '中性评论不进提及总量（也就进不了满意度分母）');
  assert.deepStrictEqual(map.preliminaryThemes, [], '不拿旧主题撑「初步机会」');
  assert.strictEqual(map.voiceBasis.gate, 'no_evidence_backed_polarity');
});

// ---------- G3：合格分类才进入机会算法 ----------
test('G3 带 Evidence/Snapshot + sentimentBasis 的正负分类才可进入机会算法输入', () => {
  const base = {
    kind: 'review_page', title: 't', snippet: '发货太慢', sourceUrl: 'https://reviews.example.com/x',
    rating: 2, reviewCount: 9, observedAt: '2026-10-02T00:00:00.000Z',
    brandId: null, competitorId: 'c1', evidenceId: 'ev-1', snapshotId: 'snap-1',
  };
  const unified = (items) => ({ status: 'sufficient', verified: { items, summary: null }, legacy: { items: [], note: null } });

  // ① 只有 polarity，没有 sentimentBasis → 不合格
  const noBasis = VoiceUnified.buildOpportunityInput(unified([
    Object.assign({}, base, { polarity: 'neg' }),
    Object.assign({}, base, { polarity: 'neg' }),
    Object.assign({}, base, { polarity: 'neg' }),
  ]));
  assert.strictEqual(noBasis.eligible, false);
  assert.strictEqual(noBasis.reason, 'no_evidence_backed_polarity');

  // ② 有 basis 但没有可读依据说明 → 不合格（无法解释的分类不进算法）
  const noNote = VoiceUnified.buildOpportunityInput(unified([
    Object.assign({}, base, { polarity: 'neg', sentimentBasis: 'model_extraction', sentimentBasisNote: '' }),
    Object.assign({}, base, { polarity: 'neg', sentimentBasis: 'model_extraction' }),
    Object.assign({}, base, { polarity: 'neg', sentimentBasis: 'model_extraction' }),
  ]));
  assert.strictEqual(noNote.eligible, false);

  // ③ 有 basis 但缺 Evidence/Snapshot → 不合格
  const noEvidence = VoiceUnified.buildOpportunityInput(unified([
    Object.assign({}, base, { evidenceId: null, snapshotId: null, polarity: 'neg', sentimentBasis: 'source_field', sentimentBasisNote: '来源页面明示星级 2/5' }),
    Object.assign({}, base, { polarity: 'neg', sentimentBasis: 'source_field', sentimentBasisNote: '来源页面明示星级 2/5' }),
    Object.assign({}, base, { polarity: 'neg', sentimentBasis: 'source_field', sentimentBasisNote: '来源页面明示星级 2/5' }),
  ]));
  assert.strictEqual(noEvidence.eligible, false);

  // ④ 三类依据齐备 + 三条样本 → 合格，且条目带齐溯源字段
  const ok = VoiceUnified.buildOpportunityInput(unified([
    Object.assign({}, base, { competitorId: 'c1', polarity: 'neg', sentimentBasis: 'source_field', sentimentBasisNote: '来源页面明示星级 2/5' }),
    Object.assign({}, base, { competitorId: 'c2', polarity: 'neg', sentimentBasis: 'deterministic_rule', sentimentBasisNote: '固定词表命中「慢/等待」' }),
    Object.assign({}, base, { competitorId: 'c3', polarity: 'pos', sentimentBasis: 'model_extraction', sentimentBasisNote: '模型抽取：句子级极性 pos（可回溯 prompt v1）' }),
  ]));
  assert.strictEqual(ok.eligible, true, '三类依据齐备才合格: ' + ok.reason);
  assert.strictEqual(ok.items.length, 3);
  ok.items.forEach((it) => {
    assert.ok(it.polarity === 'pos' || it.polarity === 'neg');
    assert.ok(OPP.SENTIMENT_BASIS_KINDS.indexOf(it.sentimentBasis) !== -1);
    assert.ok(it.sentimentBasisNote, '依据说明必须保留');
    assert.ok(it.evidenceId && it.snapshotId && it.url && it.observedAt && (it.brandId || it.competitorId),
      'Evidence/Snapshot/来源 URL/观察时间/品牌归属缺一不可');
  });

  // ⑤ 合格输入进入机会图：3 家品牌各自有声音 → 出图，且满意度分母只算已分类提及
  const map = OPP.computeOpportunityMap(
    [{ id: 'c1', name: 'A', status: 'done' }, { id: 'c2', name: 'B', status: 'done' }, { id: 'c3', name: 'C', status: 'done' }],
    { voiceItems: ok.items, voiceCollected: 3 });
  assert.strictEqual(map.hidden, false, '合格输入 → 出图');
  const th = map.themes[0];
  assert.strictEqual(th.posMentions + th.negMentions, 3, '满意度分母=已分类提及数（中性不计）');
  assert.ok(th.brandsMentioned >= 1);
});

// ---------- G4：旧字段无法绕过统一模型 ----------
test('G4 旧 reviews/painPoints/voiceItems 直接喂机会算法 → 隐藏，分母为 0', () => {
  const comps = [1, 2, 3].map(i => ({
    id: 'c' + i, name: '品牌' + i, status: 'done',
    reviews: { negThemes: ['发货太慢'], posThemes: ['包装好看'], basis: 'verified' },
    painPoints: [{ point: '客服不回' }],
    voiceItems: [{ platform: 'reddit', polarity: 'neg', text: '旧条目', url: 'https://reddit.com/r/y', date: '2026-01-01' }],
  }));
  const map = OPP.computeOpportunityMap(comps, { voiceCollected: 0 });
  assert.strictEqual(map.hidden, true, '旧字段不能撑起机会图');
  assert.strictEqual(map.mentionsTotal, 0);
  assert.strictEqual(map.brandsWithVoice, 0);
  assert.deepStrictEqual(map.themes || [], []);
  assert.deepStrictEqual(OPP.collectUnifiedItems({ voiceItems: [{ text: 'x', polarity: 'neg', brandId: 'c1' }] }), [],
    '缺 sentimentBasis/来源/观察时间 → 条目被丢弃');
});

// ---------- G5：public_site_products 未验证不得显示已采集 ----------
test('G5 public_site_products：待验证（非 operational / 非已采集），真实验证后才可能升级', () => {
  // ① 能力成熟度：不得 ga
  const cap = Registry.getCapability('public_site_products');
  assert.strictEqual(cap.maturity, 'pending_verification');
  // ② 运行态：无凭据公开来源同样不能恒报 operational
  const rd = Readiness.getReadiness('public_site_products');
  assert.strictEqual(rd.state, 'ready_to_verify', '尚无真实成功 → ready_to_verify: ' + rd.state);
  assert.ok(/尚未完成真实采集验证/.test(rd.userText), '用户文案不许写「已采集/已接通」: ' + rd.userText);
  assert.ok(!/已采集|已接通|可用/.test(rd.userText));
  // ③ 品牌级：从未采集 → not_collected + 明确说明
  const st0 = BrandSvc.buildPublicProductsStatus(TID, 'projR2A', { id: 'c1' });
  assert.strictEqual(st0.status, 'not_collected');
  assert.ok(/尚无一次真实成功采集验证/.test(st0.note || ''), '不得暗示已采集');
  // ④ 数据面：website_products 聚合不含 public_site_products，只在 pendingVerification 出现
  const ov = Surface.buildOverview({
    tenantId: TID, projectId: 'projR2A', competitorId: 'c1',
    comp: { id: 'c1', name: 'A', url: 'https://brand1.example.com', isShopify: false },
  });
  const wp = ov.dimensions.find(d => d.code === 'website_products');
  assert.ok(!(wp.aggregations || []).some(a => a.capability.code === 'public_site_products'), '不得混进已采集块');
  assert.ok((wp.pendingVerification || []).some(x => x.code === 'public_site_products'), '必须以「待验证」单列');
  // ⑤ 真实成功验证落账后运行态才变 operational（验证语义真实存在，只是尚未发生）
  Readiness.recordVerification({ capability: 'public_site_products', provider: 'public_site_products_fetch', status: 'success', tenantId: TID });
  const rd2 = Readiness.getReadiness('public_site_products');
  assert.strictEqual(rd2.state, 'operational', '真实成功 → operational（能力可升级，不是永久停用）');
});

// ---------- G6：调研完成后自动入队官网资料采集 ----------
test('G6 official_site_profile 随正常调研自动入队；public_site_products 不自动抓取', () => {
  const projectId = 'projR2C';
  const comp = { id: 'compAuto1', name: 'AutoBrand', url: 'https://auto-brand.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, mkState(projectId, [comp]));

  const r = CollectReq.autoCollectAfterResearch({ tenantId: TID, projectId, comp, who: 'test' });
  assert.strictEqual(r.enqueued, true, '官网资料自动入队: ' + JSON.stringify(r));
  assert.strictEqual(r.capability, 'official_site_profile');

  const job = CollectJobs.getJob ? CollectJobs.getJob(r.jobId) : null;
  const row = CollectJobs.getDb().prepare('SELECT * FROM collection_jobs WHERE job_id=?').get(r.jobId);
  assert.ok(row, '任务行已落库');
  assert.strictEqual(row.capability, 'official_site_profile');
  assert.strictEqual(row.status, 'pending', '进入正常队列（等 worker 消费）');
  assert.strictEqual(row.trigger, 'schedule', '系统发起（03 §20 枚举内，不新增规格外触发值）');
  assert.ok(job === null || job.jobId === r.jobId);

  // 幂等：再调一次不会产生第二个任务（同 scope 去重）
  const again = CollectReq.autoCollectAfterResearch({ tenantId: TID, projectId, comp, who: 'test' });
  const n = CollectJobs.getDb().prepare(
    "SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND capability='official_site_profile'"
  ).get(TID, projectId).n;
  assert.strictEqual(n, 1, '不产生重复采集任务');
  assert.ok(again.enqueued === false || again.reason === 'in_progress_or_recent');

  // public_site_products（未验证）绝不被自动大规模抓取
  const nProducts = CollectJobs.getDb().prepare(
    "SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND capability='public_site_products'"
  ).get(TID, projectId).n;
  assert.strictEqual(nProducts, 0, '未验证能力不得自动抓取');

  // 没有官网地址 → 不入队（不猜）
  writeState(TID, 'projR2D', mkState('projR2D', [{ id: 'compAuto2', name: 'NoUrl', url: '', status: 'done' }]));
  const r2 = CollectReq.autoCollectAfterResearch({ tenantId: TID, projectId: 'projR2D', comp: { id: 'compAuto2', name: 'NoUrl', url: '', status: 'done' } });
  assert.strictEqual(r2.enqueued, false);
  assert.strictEqual(r2.reason, 'no_official_url');
});

// ---------- G7：超时真正取消底层请求，后续任务仍可执行 ----------
test('G7 worker 超时会 abort 底层请求（不是只让 Promise.race 返回），后续任务照常执行', async () => {
  // 测试隔离：清掉前面用例留下的 pending 任务，保证 claim 顺序确定（只删本租户本用例范围）
  CollectJobs.getDb().prepare("DELETE FROM collection_jobs WHERE tenant_id=? AND project_id IN ('projR2C','projR2D','projR2E')").run(TID);
  const projectId = 'projR2E';
  const comp = { id: 'compHang', name: 'HangBrand', url: 'https://hang-brand.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, mkState(projectId, [comp]));

  const origGetAdapter = Adapters.getAdapter;
  let aborted = false;
  const seenSignal = [];
  let callCount = 0;
  Adapters.getAdapter = function patched(code) {
    if (code !== 'shopify') return origGetAdapter.call(Adapters, code);
    callCount += 1;
    if (callCount === 1) {
      // 第一个任务：模拟「服务端慢速滴漏字节」——只有在 signal abort 时才结束
      return {
        code: 'shopify', version: 'test',
        supports: () => ({ supported: true }),
        async collect(ctx) {
          seenSignal.push(!!ctx.signal);
          await new Promise((resolve, reject) => {
            if (!ctx.signal) return resolve(); // 没有 signal 就永远挂不住，直接返回让断言失败可见
            if (ctx.signal.aborted) { aborted = true; return reject(new Error('SAFE_FETCH_ABORTED')); }
            ctx.signal.addEventListener('abort', () => { aborted = true; reject(new Error('SAFE_FETCH_ABORTED')); }, { once: true });
          });
          return { providerOk: true };
        },
      };
    }
    // 第二个任务：立即返回（证明 worker 没有被前一个任务卡死）
    return {
      code: 'shopify', version: 'test',
      supports: () => ({ supported: true }),
      async collect() {
        return { deduped: true, attempt: { status: 'success' } };
      },
    };
  };

  const prevTimeout = process.env.ZB_COLLECT_TIMEOUT_MS;
  process.env.ZB_COLLECT_TIMEOUT_MS = '400';
  try {
    const mk = SurfaceStore.createAttempt({ tenantId: TID, projectId, competitorId: 'compHang', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: uid('r2-timeout-') });
    const enq = CollectJobs.enqueue({ tenantId: TID, projectId, competitorId: 'compHang', capability: 'shopify_catalog', attemptId: mk.attempt.attemptId, trigger: 'manual' });
    const job = CollectJobs.claim('w-test-timeout');
    assert.ok(job, '认领到任务');
    assert.strictEqual(job.jobId, enq.jobId);

    const t0 = Date.now();
    const res = await CollectJobs.executeJob(job);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 10_000, '超时必须及时返回，不能挂死: ' + elapsed + 'ms');
    assert.strictEqual(aborted, true, '底层请求收到 abort（signal 贯穿 provider ctx）');
    assert.deepStrictEqual(seenSignal, [true], 'provider 能拿到 ctx.signal');
    assert.strictEqual(res.chainExhausted, true);
    const att = SurfaceStore.getAttempt(TID, mk.attempt.attemptId);
    assert.strictEqual(att.status, 'failed', '超时如实落 failed');
    assert.strictEqual(att.sourceStatus || att.source_status, 'timeout', '按 timeout 分类，不冒充 unavailable');
    assert.ok(!/collect_timeout|SAFE_FETCH_ABORTED/.test(JSON.stringify(att)), '不把内部错误码暴露到 attempt');

    // 后续任务仍可被执行（队列没被饿死）：先释放前一个 job，再入队同 scope 的新任务
    CollectJobs.finish(job.jobId, job.claimToken, 'done');
    const mk2 = SurfaceStore.createAttempt({ tenantId: TID, projectId, competitorId: 'compHang', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: uid('r2-after-') });
    const enq2 = CollectJobs.enqueue({ tenantId: TID, projectId, competitorId: 'compHang', capability: 'shopify_catalog', attemptId: mk2.attempt.attemptId, trigger: 'manual' });
    assert.strictEqual(enq2.deduped, false, '前一个 job 已完结，可入队新任务');
    const job2 = CollectJobs.claim('w-test-after');
    assert.ok(job2, '第二个任务可被认领');
    const res2 = await CollectJobs.executeJob(job2);
    assert.ok(res2, '第二个任务执行完成: ' + JSON.stringify(res2).slice(0, 120));
    assert.strictEqual(callCount >= 2, true, '后续任务确实走了 provider');
  } finally {
    Adapters.getAdapter = origGetAdapter;
    if (prevTimeout == null) delete process.env.ZB_COLLECT_TIMEOUT_MS;
    else process.env.ZB_COLLECT_TIMEOUT_MS = prevTimeout;
  }
});

// ---------- G8：两租户 / 跨项目隔离 ----------
test('G8 统一评论事实链按租户隔离：另一租户读不到本项目评论', () => {
  const projectId = 'projR2F';
  const comp = { id: 'compIso1', name: 'IsoBrand', url: 'https://iso-brand.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, mkState(projectId, [comp]));
  seedReviews(TID, projectId, comp.id, [reviewObs(comp.id)]);

  const selfVoice = VoiceUnified.buildUnifiedVoice({ tenantId: TID, projectId, brandId: 'br_x', competitorId: comp.id, comp });
  assert.strictEqual(selfVoice.verified.items.length, 1, '本租户可读');
  const otherVoice = VoiceUnified.buildUnifiedVoice({ tenantId: TID_B, projectId, brandId: 'br_x', competitorId: comp.id, comp });
  assert.strictEqual(otherVoice.verified.items.length, 0, '跨租户读不到');
  // 跨项目同样读不到（同租户不同 projectId）
  const otherProject = VoiceUnified.buildUnifiedVoice({ tenantId: TID, projectId: 'projR2Z', brandId: 'br_x', competitorId: comp.id, comp });
  assert.strictEqual(otherProject.verified.items.length, 0, '跨项目读不到');
});

// ---------- G9：站点发现链路的真实缺陷回归（r2 修复项） ----------
test('G9 robots 单行文本 & XML 实体 & 分片 sitemap URL：商品发现不再恒为 0', () => {
  const SiteProfile = require('../research/site-profile.js');
  // ① 真实站点实测：fetchPage 的 text 已被 stripHtml 压成单行，行首锚点必须兜底
  assert.deepStrictEqual(
    SiteProfile.parseSitemapsFromRobots('User-agent: * Disallow: /checkout/ Sitemap: https://www.vaude.com/media/sitemap/sitemap.xml'),
    ['https://www.vaude.com/media/sitemap/sitemap.xml'], '单行 robots 也要解析出 Sitemap');
  // ② 规范多行写法保持
  assert.deepStrictEqual(
    SiteProfile.parseSitemapsFromRobots('User-agent: *\nSitemap: https://a.com/s1.xml\nSitemap: https://a.com/s2.xml'),
    ['https://a.com/s1.xml', 'https://a.com/s2.xml']);
  // ③ 没有 Sitemap 指令 → 空（不猜）
  assert.deepStrictEqual(SiteProfile.parseSitemapsFromRobots('User-agent: *\nDisallow: /x'), []);
  // ④ <loc> 里的 &amp; 必须解码（Shopify 分片 sitemap URL 常见），否则抓错 URL
  const xml = '<sitemapindex><sitemap><loc>https://s.example.com/sitemap_products_1.xml?from=1&amp;to=2</loc></sitemap></sitemapindex>';
  const locs = SiteProfile.parseSitemapLocs(xml);
  assert.deepStrictEqual(locs, ['https://s.example.com/sitemap_products_1.xml?from=1&to=2']);
  // ⑤ 带查询串的 .xml 仍识别为 sitemap（旧实现 /\.xml$/ 会整批漏掉商品分片）
  assert.strictEqual(SiteProfile.isSitemapUrl('https://s.example.com/sitemap_products_1.xml?from=1&to=2'), true);
  assert.strictEqual(SiteProfile.isSitemapUrl('https://s.example.com/sitemap.xml'), true);
  assert.strictEqual(SiteProfile.isSitemapUrl('https://s.example.com/products/a'), false);
});

// ---------- G10：商品页全部不可读时不得伪装成「成功且 0 商品」 ----------
test('G10 候选商品页存在但一页都读不到（429）→ attempt failed + 限流文案，不写成空结果', async () => {
  const Net = require('../research/net.js');
  const projectId = 'projR2G';
  const comp = { id: 'compStub429', name: 'Stub429', url: 'https://stub429.example.com', status: 'done', isShopify: false };
  writeState(TID, projectId, mkState(projectId, [comp]));

  const origFetch = Net.fetchPage;
  Net.fetchPage = async (u) => {
    const url = String(u);
    if (/robots\.txt$/.test(url)) return { ok: true, url, text: 'Sitemap: https://stub429.example.com/sitemap.xml' };
    if (/sitemap\.xml$/.test(url)) return { ok: true, url, html: '<urlset><url><loc>https://stub429.example.com/products/a</loc></url><url><loc>https://stub429.example.com/products/b</loc></url></urlset>' };
    if (/\/products\//.test(url)) return { ok: false, status: 429, error: 'http:429' };
    return { ok: true, url, html: '<html><head><title>Stub429</title></head></html>' };
  };
  try {
    const mk = SurfaceStore.createAttempt({ tenantId: TID, projectId, competitorId: comp.id, capability: 'public_site_products', dimension: 'website_products', trigger: 'manual', idempotencyKey: uid('r2-429-') });
    const r = await Adapters.getAdapter('official_site_products').collect({
      tenantId: TID, projectId, competitor: comp, trigger: 'manual', attemptId: mk.attempt.attemptId,
    });
    assert.strictEqual(r.attempt.status, 'failed', '不能落成 success/empty');
    assert.strictEqual(r.attempt.sourceStatus || r.attempt.source_status, 'rate_limited', '限流如实分类');
    const text = JSON.stringify(r.attempt.errorUserText || '');
    assert.ok(/限流|访问频率/.test(text), '用户文案说明来源限流: ' + text);
    assert.ok(!/官网不支持|没有商品/.test(text), '不把访问限制写成「官网没有商品」');
    // 品牌级状态：不得显示为已采集
    const st = BrandSvc.buildPublicProductsStatus(TID, projectId, comp);
    assert.notStrictEqual(st.status, 'verified', '没有任何商品观察 → 不得显示已采集');
  } finally { Net.fetchPage = origFetch; }
});


// ---------- G11：品牌库 ID 与项目竞品 ID 不可混用 ----------
test('G11 机会输入按 competitorId 归属：brandId 不同仍统计，未知或缺失 competitorId 一律排除', () => {
  const comps = threeDoneComps('projR2H');
  const valid = comps.map((c, i) => ({
    brand: c.name,
    brandId: 'brand-record-' + c.id,       // 与项目内 c.id 明确不同
    competitorId: c.id,
    text: '发货太慢',
    polarity: i === 0 ? 'pos' : 'neg',
    sentimentBasis: 'deterministic_rule',
    sentimentBasisNote: '来源公开评分 + 固定规则',
    url: 'https://reviews.example.com/' + c.id,
    observedAt: '2026-10-02T00:00:00.000Z',
    evidenceId: 'ev-' + c.id,
    snapshotId: 'snap-' + c.id,
  }));
  const map = OPP.computeOpportunityMap(comps, { voiceItems: valid, voiceCollected: valid.length });
  assert.strictEqual(map.hidden, false, 'brandId 与 competitorId 不同的合格评论仍应进入机会图');
  assert.strictEqual(map.brandsWithVoice, 3, '分母按三个项目内 competitorId 去重');
  assert.deepStrictEqual(map.themes[0].brands.sort(), comps.map(c => c.name).sort(), '展示使用品牌名，不泄漏内部 ID');

  const unknown = Object.assign({}, valid[0], { competitorId: 'other-project-competitor' });
  const noCompetitor = Object.assign({}, valid[1], { competitorId: null });
  const rejected = OPP.computeOpportunityMap(comps, { voiceItems: [unknown, noCompetitor], voiceCollected: 2 });
  assert.strictEqual(rejected.hidden, true, '跨项目或无 competitorId 的条目不得进入机会计算');
  assert.strictEqual(rejected.brandsWithVoice, 0);
});
