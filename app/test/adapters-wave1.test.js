'use strict';
// ============================================================
// adapters-wave1.test.js —— Wave 1 四 adapter 契约与真值链回归
//   W1 契约：四 adapter 通过 validateAdapter + summaryKinds ↔ Registry 映射
//   W2 解析：youtube/dataforseo/tiktok/reviews normalize 独立摘要形状
//      （measurementMethod 必标；不复用 Shopify 价格卡模板）
//   W3 validateOutput：畸形输入零 TypeError；快照可追溯校验真实生效
//   W4 来源 URL 一致性：evidence sourceUrl = 快照精确 source_url（≠ 品牌主页 URL 回退）
//   W5 跨租户隔离 + 幂等刷新（新 capability 沿用既有真值链硬过滤）
//   W6 pending_config 采集门控：supports=false → 不得绕过契约采集
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-wave1-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';

const db = require('../services/db.js');
const Registry = require('../services/capability-registry.js');
const Adapters = require('../services/source-adapter.js');
const SurfaceStore = require('../services/surface-store.js');
const Snapshot = require('../research/source-snapshot.js');
const { saveState, projFile } = require('../core/state-store.js');

const TID = 'tenant:w1a', TID2 = 'tenant:w1b', PID = 'projW1';
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
}
function mkSnapshot(tid, url, body, extra) {
  const r = Snapshot.record(Object.assign({
    capability: 'youtube_content', provider: 'youtube_data_api_v3', source_url: url,
    final_url: url, redirect_hops: 0, http_status: 200, source_status: 'success',
    observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
    bodyBytes: Buffer.from(body), contentType: 'application/json', trigger: 'manual', tenantId: tid,
  }, extra || {}));
  assert.ok(r.recorded, 'snapshot recorded');
  return r.meta;
}

const BRAND = { name: 'WaveBrand', url: 'https://wavebrand.example.com', isShopify: false };
const NORM_CTX = { competitor: BRAND };

(async () => {
  db.createTenant({ name: 'cw1a', email: 'w1a@example.com' });
  db.createTenant({ name: 'cw1b', email: 'w1b@example.com' });
  db.saveProject({ id: PID, tenantId: TID, track: 'T-W1', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(PID, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({ projectId: PID, tenantId: TID, track: 'T-W1', discoveredAt: new Date().toISOString(), intent: { regions: ['us'], category: 'toys' }, competitors: [{ id: 'compW1', name: BRAND.name, status: 'done', url: BRAND.url, isShopify: false }] });
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));

  await t('W1 契约：四 adapter 通过 validateAdapter；summaryKinds 与 Registry 一一对应', async () => {
    const integ = Adapters.assertAdaptersIntegrity();
    assert.ok(integ.ok, 'adapters integrity: ' + integ.errors.join(';'));
    for (const code of ['youtube', 'dataforseo', 'tiktok', 'reviews']) {
      const a = Adapters.getAdapter(code);
      assert.ok(a, code + ' adapter 已注册');
      const v = Adapters.validateAdapter(a);
      assert.ok(v.ok, code + ' validateAdapter: ' + v.errors.join(';'));
      assert.ok(a.health().checkedAt, code + ' health 可用');
    }
    // Registry pending_config 能力的 adapter 字段必须指向已注册 adapter
    for (const cap of Registry.listCapabilities().filter(c => c.maturity === 'pending_config')) {
      assert.ok(Adapters.getAdapter(cap.adapter), cap.code + ' → adapter ' + cap.adapter + ' 已注册');
      assert.deepStrictEqual(Adapters.SUMMARY_KINDS[Object.keys(Adapters.SUMMARY_KINDS).find(k => Adapters.SUMMARY_KINDS[k].includes(cap.code))], [cap.code]);
    }
  });

  await t('W2 解析：youtube normalize 输出 social_videos 独立形状（公开来源观察）', async () => {
    const a = Adapters.getAdapter('youtube');
    const raw = {
      ok: true,
      videos: [{ videoId: 'v1', title: '新品展示视频', publishedAt: '2026-10-01T00:00:00Z', viewCount: 1234, likeCount: 56, commentCount: 7, thumbnailUrl: 'https://i.ytimg.com/vi/v1/mq.jpg', videoUrl: 'https://www.youtube.com/watch?v=v1' }],
      comments: [{ text: '价格多少？', videoId: 'v1', sourceUrl: 'https://www.youtube.com/watch?v=v1' }],
      snapshotIds: [], channelId: 'CHxyz', channelTitle: 'WaveBrand Official', matchReasons: ['频道名称包含品牌名「WaveBrand」'],
      partialScan: false, sourceUrl: 'https://www.googleapis.com/youtube/v3/search',
    };
    const out = a.normalize(raw, NORM_CTX);
    assert.strictEqual(out.summary.kind, 'social_videos');
    assert.strictEqual(out.summary.measurementMethod, 'public_source_observation', 'YouTube = 公开来源观察');
    assert.strictEqual(out.dimension, 'social_content');
    assert.strictEqual(out.observations[0].viewCount, 1234);
    assert.strictEqual(out.observations[0].price, null, '社媒观察无价格语义');
    assert.ok(out.summary.matchReasons.length >= 1, '归属依据可解释');
  });

  await t('W2 解析：dataforseo normalize 输出 trend_series（licensed_estimate）', async () => {
    const a = Adapters.getAdapter('dataforseo');
    const raw = {
      ok: true,
      points: [{ id: '2026-10-01', label: 'WaveBrand', periodStart: '2026-10-01', periodEnd: '2026-10-01', value: 42, region: 'United States' }],
      snapshotIds: [], keyword: 'WaveBrand', region: 'United States',
      periodStart: '2026-07-01', periodEnd: '2026-10-01', providerRecordId: 'task_123',
      partialScan: false, sourceUrl: 'https://api.dataforseo.com/v3/dataforseo_labs/google/trends/explore/live',
    };
    const out = a.normalize(raw, NORM_CTX);
    assert.strictEqual(out.summary.kind, 'trend_series');
    assert.strictEqual(out.summary.measurementMethod, 'licensed_estimate', 'DataForSEO = 数据服务估算');
    assert.strictEqual(out.observations[0].value, 42);
    assert.strictEqual(out.summary.providerRecordId, 'task_123', 'provider record ID 保存');
  });

  await t('W2 解析：tiktok normalize 输出 ad_creatives（r3：official_disclosure + 覆盖范围；花费/ROI 恒不可观测）', async () => {
    const a = Adapters.getAdapter('tiktok');
    const raw = {
      ok: true,
      creatives: [{ id: 'ad1', firstShownDate: '20250115', lastShownDate: '20250120', status: 'active', advertiser: 'WaveBrand Store', creativeUrl: 'https://example.com/creative.mp4', reachLabel: '11K' }],
      snapshotIds: [], providerRecordId: 'sid_abc', partialScan: false,
      periodStart: '20250101', periodEnd: '20250301', countryScope: 'ALL（官方支持国家范围）',
      sourceUrl: 'https://open.tiktokapis.com/v2/research/adlib/ad/query/?fields=ad.id',
    };
    const out = a.normalize(raw, NORM_CTX);
    assert.strictEqual(out.summary.kind, 'ad_creatives');
    // P0-3 整改 r3：平台公开披露，非数据服务估算
    assert.strictEqual(out.summary.measurementMethod, 'official_disclosure');
    assert.ok(/30 国/.test(out.summary.coverageNote || ''), '覆盖范围说明（不写未观察到广告）');
    const all = JSON.stringify(out);
    for (const banned of ['spend', 'cost', 'roi', 'conversion', 'cpc', 'cpm']) {
      assert.ok(!all.toLowerCase().includes(banned), '不得出现花费/转化字段：' + banned);
    }
    assert.strictEqual(out.observations[0].price, null, '广告观察无价格语义');
    assert.strictEqual(out.observations[0].reach, '11K', 'reach 用官方区间标签而非数值推算');
  });

  await t('W2 解析：reviews normalize 输出 reviews_digest（样本量/来源数/时间范围明示）', async () => {
    const a = Adapters.getAdapter('reviews');
    const raw = {
      ok: true,
      pages: [{ pageId: 'https://review-site.example.com/wavebrand', url: 'https://review-site.example.com/wavebrand', title: 'WaveBrand reviews', rating: 4.5, reviewCount: 12, snippet: 'Great quality…', fetchedAt: '2026-10-19T00:00:00Z' }],
      snapshotIds: [], partialScan: false,
      periodStart: '2026-09-19', periodEnd: '2026-10-19',
      sourceUrl: 'https://review-site.example.com/wavebrand',
    };
    const out = a.normalize(raw, NORM_CTX);
    assert.strictEqual(out.summary.kind, 'reviews_digest');
    assert.strictEqual(out.summary.measurementMethod, 'public_source_observation');
    assert.strictEqual(out.summary.reviewCount, 12);
    assert.strictEqual(out.summary.sourceCount, 1);
    assert.ok(out.summary.sampleNote && /不等于全网口碑/.test(out.summary.sampleNote), '样本口径如实声明');
    assert.strictEqual(out.observations[0].sourceUrl, 'https://review-site.example.com/wavebrand', '精确来源 URL');
  });

  await t('W3 validateOutput：畸形输入零 TypeError；快照可追溯校验真实生效', async () => {
    for (const bad of [null, undefined, 42, 'str', [], {}, { capability: 'nope' }]) {
      const r = Adapters.validateOutput(bad, { capability: 'youtube_content', dimension: 'social_content', tenantId: TID });
      assert.strictEqual(r.ok, false, '畸形输入必须拒绝');
    }
    // 合法输出 + 真实快照 → ok；伪造 snapshotId → 拒绝（真值链不放水）
    const snap = mkSnapshot(TID, 'https://www.googleapis.com/youtube/v3/search?part=snippet', '{"items":[]}', { capability: 'youtube_content', provider: 'youtube_data_api_v3' });
    const a = Adapters.getAdapter('youtube');
    const raw = { ok: true, videos: [{ videoId: 'v9', title: 'T', publishedAt: null, viewCount: 1, likeCount: null, commentCount: null, thumbnailUrl: null, videoUrl: null }], comments: [], snapshotIds: [snap.snapshot_id], channelId: 'CH', channelTitle: 'C', matchReasons: [], partialScan: false, sourceUrl: null };
    const out = a.normalize(raw, NORM_CTX);
    const ok1 = Adapters.validateOutput(out, { capability: 'youtube_content', dimension: 'social_content', tenantId: TID });
    assert.ok(ok1.ok, '合法输出应通过：' + (ok1.errors || []).join(';'));
    const forged = Object.assign({}, out, { snapshotIds: ['snap_does_not_exist'] });
    const ok2 = Adapters.validateOutput(forged, { capability: 'youtube_content', dimension: 'social_content', tenantId: TID });
    assert.strictEqual(ok2.ok, false, '伪造快照 ID 必须拒绝');
  });

  await t('W4 来源 URL 一致性：evidence sourceUrl = 快照精确 source_url（非品牌主页回退）', async () => {
    const DataSurface = require('../services/data-surface.js');
    // 精确来源 ≠ 品牌主页：多页采集第 2 页快照的 source_url 是分页 URL
    const precise = 'https://wavebrand.example.com/products.json?limit=250&page=2';
    const snap = mkSnapshot(TID, precise, JSON.stringify({ products: [{ id: 9, title: 'P9' }] }), { capability: 'shopify_catalog', provider: 'shopify_products_json' });
    const mk = SurfaceStore.createAttempt({ tenantId: TID, projectId: PID, competitorId: 'compW1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'w4-shop-1', nowMs: Date.now() });
    SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
      status: 'success', sourceStatus: 'success',
      observations: [{ id: '9', title: 'P9', price: 20, currency: 'USD', available: true, publishedAt: null }],
      snapshotIds: [snap.snapshot_id], evidenceIds: [],
      summary: { kind: 'storefront_catalog', count: 1, onSaleCount: 0, soldOutCount: 0, priceMin: 20, priceMax: 20, priceMedian: 20, currency: 'USD', currencyStatus: 'confirmed', partialScan: false, partialScanReason: null, successfullyFetchedPages: 1, failedPage: null },
      endedAt: new Date().toISOString(),
    });
    const ov = DataSurface.buildOverview({ tenantId: TID, projectId: PID, competitorId: 'compW1', comp: Object.assign({}, BRAND, { isShopify: true }), nowMs: Date.now() });
    const prodDim = ov.dimensions.find(d => d.code === 'website_products');
    assert.ok(prodDim.evidenceRefs && prodDim.evidenceRefs.length, '有 evidenceRefs');
    assert.strictEqual(prodDim.evidenceRefs[0].sourceUrl, precise, 'sourceUrl = 快照精确 source_url');
    assert.notStrictEqual(prodDim.evidenceRefs[0].sourceUrl, BRAND.url, '不得回退品牌主页 URL');
    // pending_config 维度（即使测试注入 attempt）不出现在 overview 采集视图——门控真实生效
    const revDim = ov.dimensions.find(d => d.code === 'reviews_reputation');
    assert.strictEqual(revDim.surfaceState, 'pending_config', 'pending_config 维度显式状态');
    assert.strictEqual((revDim.evidenceRefs || []).length, 0, 'pending_config 不产出 evidence 视图');
  });

  await t('W5 跨租户隔离 + 幂等：新 capability 沿用既有真值链硬过滤', async () => {
    const mk1 = SurfaceStore.createAttempt({ tenantId: TID, projectId: PID, competitorId: 'compW1', capability: 'youtube_content', dimension: 'social_content', trigger: 'manual', idempotencyKey: 'w1-yt-1', nowMs: Date.now() });
    assert.ok(mk1.attempt.attemptId, 'attempt 创建');
    // 幂等：同 idempotencyKey 重复创建 → deduped
    const mk1b = SurfaceStore.createAttempt({ tenantId: TID, projectId: PID, competitorId: 'compW1', capability: 'youtube_content', dimension: 'social_content', trigger: 'manual', idempotencyKey: 'w1-yt-1', nowMs: Date.now() + 10 });
    assert.strictEqual(mk1b.deduped, true, '同 key 幂等去重');
    // 隔离：租户 B 看不到租户 A 的 attempt
    const seen = SurfaceStore.listAttempts(TID2, PID, 'compW1', 'youtube_content', 10);
    assert.strictEqual(seen.length, 0, '跨租户 attempt 互不可见');
    const seenA = SurfaceStore.listAttempts(TID, PID, 'compW1', 'youtube_content', 10);
    assert.strictEqual(seenA.length, 1, '本租户可见自己的 attempt');
    // 快照隔离
    const snapB = (() => { try { return Snapshot.getById(TID2, mkSnapshot(TID, 'https://x.example.com/yt', '{}', { capability: 'youtube_content' }).snapshot_id); } catch (e) { return null; } })();
    assert.ok(!snapB || snapB.tenant_id === undefined || snapB.tenantId === TID2 || !snapB.source_url, '租户 B 反查租户 A 快照不可见或不含内容');
  });

  await t('W6 pending_config 门控（r2 新语义）：结构条件满足即支持采集（运行门控在 source-readiness），结构不足如实 not_applicable', async () => {
    for (const [adapterCode, capCode] of [['youtube', 'youtube_content'], ['dataforseo', 'dataforseo_trends'], ['tiktok', 'tiktok_commercial_content'], ['reviews', 'public_reviews']]) {
      const a = Adapters.getAdapter(adapterCode);
      // 结构条件满足（有 url）→ 允许发起真实采集；凭据门控由 readiness 在入口管理
      const chk = a.supports({ url: BRAND.url, isShopify: false });
      assert.strictEqual(chk.supported, true, capCode + ' pending_config 结构满足可发起采集');
      assert.strictEqual(chk.reasonCode, null, 'reasonCode null');
      // 结构条件不满足（无 url 无 name）→ not_applicable（不是 supported:false 的配置拒绝）
      const chk2 = a.supports({ url: '', isShopify: false });
      assert.strictEqual(chk2.supported, false, capCode + ' 结构不足不支持');
      assert.strictEqual(chk2.reasonCode, 'not_applicable', 'reasonCode=not_applicable');
    }
  });

  console.log(passed === 7 ? '[adapters-wave1] ALL PASS（7/7）' : '[adapters-wave1] ' + failed + ' FAIL / ' + passed + ' PASS');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('[adapters-wave1] FATAL', e && e.stack || e); process.exit(1); });
