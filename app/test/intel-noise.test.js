'use strict';
// ============================================================
// intel-noise.test.js —— 情报库噪音修复回归（SC-04 review/intel-coverage-noise-fix）
//   产品规则：「XX：未接入」是项目级数据覆盖状态，不是情报事件。
//   N1 5 品牌 × 多次刷新后，items 中未接入维度项数量必须为 0
//   N2 真实状态不被误过滤：成功 / 部分采集 / 采集失败 的情报项保留
//   N3 constructionDimensions 恰 4 条、按维度 code 去重、字段极简
//      （无品牌 ID / 事件 ID / 时间戳 / Evidence / Snapshot / 模拟来源）
//   N4 四项建设中维度名称与统一文案正确
//   N5 constructionDimensions 与品牌数量、采集次数无关（项目级、不随品牌翻倍）
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-noise-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';

const db = require('../services/db.js');
const BrandStore = require('../services/brand-store.js');
const BrandSvc = require('../services/brand-service.js');
const Registry = require('../services/capability-registry.js');
const SurfaceStore = require('../services/surface-store.js');
const Snapshot = require('../research/source-snapshot.js');
const EvidenceStore = require('../research/evidence-store.js');
const { saveState, projFile } = require('../core/state-store.js');

const TID = 'tenant:noiseA', PID = 'projNoiseA';
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
}
function mkSnapshot(tid, url, body) {
  const r = Snapshot.record({
    capability: 'product_catalog', provider: 'shopify_products_json', source_url: url,
    final_url: url, redirect_hops: 0, http_status: 200, source_status: 'success',
    observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
    bodyBytes: Buffer.from(body), contentType: 'application/json', trigger: 'manual', tenantId: tid,
  });
  assert.ok(r.recorded, 'snapshot recorded');
  return r.meta;
}
function pageBody(ids) {
  return JSON.stringify({ products: ids.map(id => ({ id, title: 'P' + id, product_type: 'x', variants: [{ price: String(id * 10), available: true }] })) });
}

// 5 个品牌：N1 成功×2（多次刷新）/ N2 partial / N3 failed / N4 无 attempt（尚未采集）/ N5 成功+failed 混合
const COMPS = [
  { id: 'compN1', name: 'NoiseOk', url: 'https://noiseok.example.com' },
  { id: 'compN2', name: 'NoisePart', url: 'https://noisepart.example.com' },
  { id: 'compN3', name: 'NoiseFail', url: 'https://noisefail.example.com' },
  { id: 'compN4', name: 'NoiseNone', url: 'https://noisenone.example.com' },
  { id: 'compN5', name: 'NoiseMix', url: 'https://noisemix.example.com' },
];

(async () => {
  // ---------- 环境搭建 ----------
  db.createTenant({ name: 'cnoiseA', email: 'noiseA@example.com' });
  db.saveProject({ id: PID, tenantId: TID, track: 'T-Noise', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(PID, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({ projectId: PID, tenantId: TID, track: 'T-Noise', discoveredAt: new Date().toISOString(), intent: { regions: ['us'], category: 'toys' }, competitors: COMPS.map(c => Object.assign({ status: 'done', isShopify: true }, c)) });
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));
  BrandSvc.syncProjectBrands(TID, PID);

  function runAttempt(compId, key, status, withEvidence) {
    const url = COMPS.find(c => c.id === compId).url;
    const p1 = mkSnapshot(TID, url + '/products.json?limit=250&page=1', pageBody([1, 2, 3]));
    let evIds = [];
    if (withEvidence) {
      const ev = EvidenceStore.recordEvidence({
        tenantId: TID, projectRef: PID, brandHint: compId, source: 'shopify', provider: 'shopify_products_json',
        source_snapshot_ids: [p1.snapshot_id],
        claim: { field: 'catalog.observation', scope: 'public_catalog_observation' },
        entity_key: url.replace('https://', ''), entity_ref: { kind: 'storefront_domain', domain: url.replace('https://', '') },
        extracted_value: { summaryKind: 'storefront_catalog', count: 3, onSaleCount: 0, priceMin: 10, priceMax: 30, priceMedian: 20, currency: 'USD', partialScan: false },
        unit: null, currency: 'USD', market: null, evidence_status: 'verified',
        parser_version: 'shopify-adapter-1', extractor_version: 'shopify-adapter-1',
        observed_at: p1.observed_at, note: 'noise fixture',
      });
      evIds = [ev.meta.evidence_id];
    }
    const mk = SurfaceStore.createAttempt({ tenantId: TID, projectId: PID, competitorId: compId, capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: key, nowMs: Date.now() });
    SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
      status, sourceStatus: status === 'failed' ? 'internal_error' : status,
      partialScan: status === 'partial', partialScanReason: status === 'partial' ? 'PAGE_FETCH_FAILED' : null,
      observations: status === 'failed' ? [] : [{ id: '1', title: 'P1', price: 10, currency: 'USD', available: true, publishedAt: null }],
      snapshotIds: [p1.snapshot_id], evidenceIds: evIds,
      summary: status === 'failed' ? null : { kind: 'storefront_catalog', count: 3, onSaleCount: 0, soldOutCount: 0, priceMin: 10, priceMax: 30, priceMedian: 20, currency: 'USD', currencyStatus: 'confirmed' },
      errorUserText: status === 'failed' ? '采集失败（测试注入）' : null,
      endedAt: new Date().toISOString(),
    });
  }
  // 多次刷新：N1 两次成功（不同 idempotencyKey）
  runAttempt('compN1', 'noise-n1-a', 'success', true);
  runAttempt('compN1', 'noise-n1-b', 'success', true);
  runAttempt('compN2', 'noise-n2-a', 'partial', false);
  runAttempt('compN3', 'noise-n3-a', 'failed', false);
  runAttempt('compN5', 'noise-n5-a', 'success', true);
  runAttempt('compN5', 'noise-n5-b', 'failed', false);
  // N4 无任何 attempt（尚未采集）

  const items = BrandSvc.listIntelligence(TID, { projectId: PID });

  await t('N1 5 品牌多次刷新后，items 中未接入维度项 = 0（修复前为 4×N 条噪音）', async () => {
    const noise = items.filter(i => i.type === 'gap' || (i.title || '').includes('：未接入'));
    assert.strictEqual(noise.length, 0, '噪音项应为 0，实际 ' + noise.length + '：' + JSON.stringify(noise.slice(0, 3).map(i => i.title)));
    // 全量断言：不存在以未接入维度名开头的情报项
    for (const d of ['社媒内容', '广告活动', '口碑与评论', '搜索与热度']) {
      assert.ok(!items.some(i => (i.title || '').startsWith(d + '：')), '噪音「' + d + '：未接入」不应存在');
    }
  });

  await t('N2 真实状态不被误过滤：成功/部分/失败情报项保留', async () => {
    assert.ok(items.some(i => i.title === '官网商品目录与公开价格采集完成'), '成功采集项保留');
    assert.ok(items.some(i => i.title.includes('部分完成')), '部分采集项保留');
    assert.ok(items.some(i => i.title.includes('采集失败') && i.status === 'insufficient'), '失败项保留（真实资料不足）');
    // 多次刷新 = 多条真实记录（不合并、不误删）
    const okN1 = items.filter(i => i.brandName === 'NoiseOk' && i.title.includes('采集完成'));
    assert.strictEqual(okN1.length, 2, 'N1 两次成功刷新应有 2 条真实情报，实际 ' + okN1.length);
    // 尚未采集品牌（N4）：没有任何 attempt → 无情报项也不被误标
    const n4 = items.filter(i => i.brandName === 'NoiseNone');
    assert.strictEqual(n4.filter(i => (i.title || '').includes('未接入')).length, 0, 'N4 不产生未接入噪音');
  });

  await t('N3 constructionDimensions 恰 4 条、按 code 去重、字段极简', async () => {
    const cd = BrandSvc.constructionDimensions(TID, PID);
    assert.strictEqual(cd.length, 4, '恰 4 条，实际 ' + cd.length + '：' + JSON.stringify(cd));
    const codes = new Set(cd.map(d => d.code));
    assert.strictEqual(codes.size, 4, 'code 去重后恰 4');
    const allowed = new Set(['code', 'displayName', 'state', 'message', 'configKeys']);
    for (const d of cd) {
      for (const k of Object.keys(d)) assert.ok(allowed.has(k), '不允许字段 ' + k + '（不得含品牌 ID/事件 ID/时间戳/Evidence）');
      // Wave 1：四维升级为 pending_config——「需要系统数据服务配置」≠ 未接入
      assert.strictEqual(d.state, 'pending_config', d.code + ' 状态如实');
      if (d.configKeys != null) assert.ok(Array.isArray(d.configKeys) && d.configKeys.length, 'configKeys 非空');
    }
    // Registry 口径：全部维度中无 ga 能力的恰好这 4 个
    const gaDims = Registry.listDimensions().filter(d => Registry.capabilitiesByDimension(d.code).some(c => c.maturity === 'ga'));
    assert.strictEqual(gaDims.length, 1, '已接入维度恰 1 个（website_products）');
  });

  await t('N4 四项名称与统一文案正确（r2：用户侧口径，无凭据变量名）', async () => {
    const cd = BrandSvc.constructionDimensions(TID, PID);
    const names = cd.map(d => d.displayName).sort();
    assert.deepStrictEqual(names, ['广告活动', '搜索与热度', '社媒内容', '口碑与评论'].sort(), JSON.stringify(names));
    for (const d of cd) {
      assert.ok(/当前不生成数据、估算或结论。/.test(d.message), '统一文案骨架：' + d.message);
      assert.ok(/尚未采到可核验数据/.test(d.message), d.code + ' 建设中语义');
      assert.strictEqual(/YOUTUBE_API_KEY|DATAFORSEO|TIKTOK_CLIENT|SERPER_API_KEY/.test(d.message), false, '无凭据变量名');
      assert.strictEqual('configKeys' in d, false, 'configKeys 不进用户投影');
    }
  });

  await t('N5 建设中维度与品牌数量/采集次数无关（项目级、不随品牌翻倍）', async () => {
    // 再刷一次 N1（第 3 次采集）后，constructionDimensions 仍是恰好 4 条
    runAttempt('compN1', 'noise-n1-c', 'success', true);
    const cd = BrandSvc.constructionDimensions(TID, PID);
    assert.strictEqual(cd.length, 4, '采集次数增加不影响建设中维度数量');
    const items2 = BrandSvc.listIntelligence(TID, { projectId: PID });
    assert.strictEqual(items2.filter(i => i.type === 'gap' || (i.title || '').includes('：未接入')).length, 0, '新刷新后噪音仍为 0');
    // 带 brandId 过滤（如情报库品牌筛选）同样无噪音
    const bid1 = BrandStore.brandIdForCompetitor(TID, PID, 'compN1');
    const itemsB = BrandSvc.listIntelligence(TID, { projectId: PID, brandId: bid1 });
    assert.ok(itemsB.length >= 3, 'N1 品牌真实情报 ≥3 条');
    assert.strictEqual(itemsB.filter(i => (i.title || '').includes('未接入')).length, 0, '品牌过滤下无噪音');
  });


  await t('N6 建设中维度按项目或品牌真实证据投影，不与已采集数据矛盾', async () => {
    const snap = mkSnapshot(TID, 'https://ads.noiseok.example.com/ad.json', JSON.stringify({ ads: [{ id: 'ad-1' }] }));
    const ev = EvidenceStore.recordEvidence({
      tenantId: TID, projectRef: PID, brandHint: 'NoiseOk', source: 'tiktok_ad_library', provider: 'tiktok_commercial_content',
      source_snapshot_ids: [snap.snapshot_id],
      claim: { field: 'ad.observation', scope: 'public_ad_observation' },
      entity_key: 'noiseok.example.com', entity_ref: { kind: 'advertiser', id: 'noiseok' },
      extracted_value: { creativeCount: 1 }, unit: null, currency: null, market: null,
      evidence_status: 'verified', parser_version: 'tiktok-adapter-1', extractor_version: 'tiktok-adapter-1',
      observed_at: snap.observed_at, note: 'construction coverage fixture',
    });
    assert.ok(ev.recorded, '广告 Evidence 落账');
    const attempt = SurfaceStore.createAttempt({
      tenantId: TID, projectId: PID, competitorId: 'compN1', capability: 'tiktok_commercial_content',
      dimension: 'ad_campaigns', trigger: 'manual', idempotencyKey: 'noise-ad-evidence', nowMs: Date.now(),
    });
    SurfaceStore.completeAttempt(TID, attempt.attempt.attemptId, {
      status: 'success', sourceStatus: 'success', observations: [],
      snapshotIds: [snap.snapshot_id], evidenceIds: [ev.meta.evidence_id],
      summary: { kind: 'ad_creatives', creativeCount: 1, measurementMethod: 'official_disclosure', partialScan: false },
      endedAt: new Date().toISOString(),
    });
    const projectCoverage = BrandSvc.constructionDimensions(TID, PID);
    assert.ok(!projectCoverage.some(d => d.code === 'ad_campaigns'), '项目已有可核验广告数据，不再列为建设中');
    const noiseOkBrand = BrandStore.brandIdForCompetitor(TID, PID, 'compN1');
    const noisePartBrand = BrandStore.brandIdForCompetitor(TID, PID, 'compN2');
    assert.ok(!BrandSvc.constructionDimensions(TID, PID, noiseOkBrand).some(d => d.code === 'ad_campaigns'), '有广告数据的品牌不显示广告建设中项');
    const noAdForBrand = BrandSvc.constructionDimensions(TID, PID, noisePartBrand).find(d => d.code === 'ad_campaigns');
    assert.ok(noAdForBrand && noAdForBrand.state === 'pending_config', '无可核验广告数据的品牌如实保留建设中项');
    assert.ok(/尚未采到可核验数据/.test(noAdForBrand.message), '不再用“服务不可用”否定项目内已采到的数据');
  });

  console.log(passed === 6 ? '[intel-noise] ALL PASS（6/6）' : '[intel-noise] ' + failed + ' FAIL / ' + passed + ' PASS');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('[intel-noise] FATAL', e && e.stack || e); process.exit(1); });
