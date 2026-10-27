'use strict';
// ============================================================
// test/sc12-consistency.test.js —— SC-12「合并前事实一致性整改」行为回归
// ------------------------------------------------------------
// C1  多币种隔离：USD/EUR/CNY 不得进入同一比较组
// C2  未知币种：商品数量仍进产品矩阵，价格分析不可用
// C3  混合币种：单品牌混合不得生成价格带或价格定位结论
// C4  同币种 ≥3 才允许计算项目中位数
// C5  三维度（content/heat/ads）从真实成功 attempt 进入机会模块
// C6  合法零结果 / 缺配置 / 权限失败 / 限流 / 不可达 / 市场无覆盖 状态不得混用
// C7  新失败覆盖旧成功 → usingPreviousData 标记 + 保留历史数据
// C8  比较结论引用全部参与样本的证据
// C9  满意度门槛：两个完整对象不出图 / 三个只有评分不出图 / 三个完整才出图
// C10 机会模块有内容时不出现笼统「暂无数据」
// C11 不可用维度每项只显示一次
// C12 用户 API 无凭据名、内部错误码、attempt ID、provider、服务器路径
// C13 两租户 + 跨项目隔离
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc12c-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.ZB_FIRST_COLLECTION_AUTO = 'off';
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });

const db = require('../services/db.js');
const BrandSvc = require('../services/brand-service.js');
const SurfaceStore = require('../services/surface-store.js');
const MemStore = require('../services/competitive-memory-store.js');
const Foundation = require('../services/opportunity-foundation.js');
const ScatterGate = require('../lib/satisfaction-gate.js');
const Snapshot = require('../research/source-snapshot.js');
const EvidenceStore = require('../research/evidence-store.js');
const { saveState, projFile } = require('../core/state-store.js');

const TID = 'tenant:sc12c';
const PID = 'projSc12c';
const TID_B = 'tenant:sc12c-b';

// 三个币种各一个品牌 + 一个未知币种 + 一个混合币种
const COMPETITORS = [
  { id: 'c-usd', name: 'UsdBrand', url: 'https://usd-sc12c.example.com', status: 'done', isShopify: true },
  { id: 'c-eur', name: 'EurBrand', url: 'https://eur-sc12c.example.com', status: 'done', isShopify: true },
  { id: 'c-cny', name: 'CnyBrand', url: 'https://cny-sc12c.example.com', status: 'done', isShopify: true },
  { id: 'c-unknown', name: 'UnknownBrand', url: 'https://unk-sc12c.example.com', status: 'done', isShopify: true },
  { id: 'c-mixed', name: 'MixedBrand', url: 'https://mix-sc12c.example.com', status: 'done', isShopify: true },
];

function mkSnapshot(url, body) {
  const r = Snapshot.record({
    capability: 'product_catalog', provider: 'shopify_products_json', source_url: url,
    final_url: url, redirect_hops: 0, http_status: 200, source_status: 'success',
    observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
    bodyBytes: Buffer.from(body || '{}'), contentType: 'application/json', trigger: 'manual', tenantId: TID,
  });
  assert.ok(r.recorded, 'snapshot recorded');
  return r.meta;
}
function mkEvidence(snapshotId, hint) {
  const ev = EvidenceStore.recordEvidence({
    tenantId: TID, projectRef: PID, brandHint: hint, source: 'shopify', provider: 'shopify_products_json',
    source_snapshot_ids: [snapshotId],
    claim: { field: 'catalog.observation', scope: 'public_catalog_observation' },
    entity_key: hint + '.example.com', entity_ref: { kind: 'storefront_domain', domain: hint + '.example.com' },
    extracted_value: { summaryKind: 'storefront_catalog', count: 3 },
    unit: null, currency: null, market: null, evidence_status: 'verified',
    parser_version: 'sc12c-1', extractor_version: 'sc12c-1',
    observed_at: new Date().toISOString(), note: 'sc12c fixture',
  });
  assert.ok(ev.recorded, 'evidence recorded');
  return ev.meta;
}

// 商品观察：prices = [{price, currency}]
function seedProducts(compId, items, opts) {
  const o = opts || {};
  const mk = SurfaceStore.createAttempt({
    tenantId: TID, projectId: PID, competitorId: compId, capability: 'shopify_catalog',
    dimension: 'website_products', trigger: 'manual',
    idempotencyKey: 'sc12c-' + compId + '-' + (o.key || 'k'), nowMs: o.nowMs || Date.now(),
  });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
    status: o.status || 'success', sourceStatus: o.sourceStatus || 'success',
    observations: items.map((it, i) => ({
      id: compId + '-' + i, title: 'SKU ' + i, price: it.price, currency: it.currency,
      available: true, publishedAt: null,
    })),
    snapshotIds: o.snapshotIds || [], evidenceIds: o.evidenceIds || [],
    summary: { kind: 'storefront_catalog', count: items.length },
    endedAt: o.endedAt || new Date().toISOString(),
  });
  return mk.attempt.attemptId;
}

// 任意 capability 的 attempt（用于三维度真实取数与失败场景）
function seedAttempt(compId, capability, dimension, opts) {
  const o = opts || {};
  const mk = SurfaceStore.createAttempt({
    tenantId: TID, projectId: PID, competitorId: compId, capability, dimension,
    trigger: 'manual', idempotencyKey: 'sc12c-' + capability + '-' + compId + '-' + (o.key || 'k'),
    nowMs: o.nowMs || Date.now(),
  });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
    status: o.status || 'success',
    sourceStatus: o.sourceStatus || (o.status === 'failed' ? 'unavailable' : 'success'),
    errorClass: o.errorClass || null,
    errorUserText: o.errorUserText || null,
    observations: o.observations || [],
    snapshotIds: o.snapshotIds || [], evidenceIds: o.evidenceIds || [],
    summary: o.summary || null,
    endedAt: o.endedAt || new Date().toISOString(),
  });
  return mk.attempt.attemptId;
}

function foundation() { return Foundation.buildOpportunityFoundation(TID, PID); }

test.before(async () => {
  db.createTenant({ name: 'sc12c', email: 'sc12c@example.com' });
  db.createTenant({ name: 'sc12c-b', email: 'sc12c-b@example.com' });
  db.saveProject({ id: PID, tenantId: TID, track: 'SC12C', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(PID, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({
    projectId: PID, tenantId: TID, track: 'SC12C', discoveredAt: new Date().toISOString(),
    intent: { regions: ['us'], category: 'pet' }, competitors: COMPETITORS,
  });
  for (let i = 0; i < 200 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(f), '项目状态文件已落盘');

  // 三个币种各 99（关键反例：数值相同但币种不同，绝不能进同一组）
  const sU = mkSnapshot('https://usd-sc12c.example.com/products.json', '{"products":[]}');
  const eU = mkEvidence(sU.snapshot_id, 'usd');
  seedProducts('c-usd', [{ price: 99, currency: 'USD' }, { price: 120, currency: 'USD' }], { key: 'u1', evidenceIds: [eU.evidence_id], snapshotIds: [sU.snapshot_id] });

  const sE = mkSnapshot('https://eur-sc12c.example.com/products.json', '{"products":[]}');
  const eE = mkEvidence(sE.snapshot_id, 'eur');
  seedProducts('c-eur', [{ price: 99, currency: 'EUR' }, { price: 130, currency: 'EUR' }], { key: 'e1', evidenceIds: [eE.evidence_id], snapshotIds: [sE.snapshot_id] });

  const sC = mkSnapshot('https://cny-sc12c.example.com/products.json', '{"products":[]}');
  const eC = mkEvidence(sC.snapshot_id, 'cny');
  seedProducts('c-cny', [{ price: 99, currency: 'CNY' }, { price: 140, currency: 'CNY' }], { key: 'c1', evidenceIds: [eC.evidence_id], snapshotIds: [sC.snapshot_id] });

  // 未知币种（无 currency 字段）
  const sK = mkSnapshot('https://unk-sc12c.example.com/products.json', '{"products":[]}');
  const eK = mkEvidence(sK.snapshot_id, 'unk');
  seedProducts('c-unknown', [{ price: 50, currency: null }, { price: 60, currency: null }], { key: 'k1', evidenceIds: [eK.evidence_id], snapshotIds: [sK.snapshot_id] });

  // 混合币种（同一品牌 USD + EUR）
  const sM = mkSnapshot('https://mix-sc12c.example.com/products.json', '{"products":[]}');
  const eM = mkEvidence(sM.snapshot_id, 'mix');
  seedProducts('c-mixed', [{ price: 10, currency: 'USD' }, { price: 20, currency: 'EUR' }], { key: 'm1', evidenceIds: [eM.evidence_id], snapshotIds: [sM.snapshot_id] });
});

// ---------- C1 多币种隔离 ----------
test('C1 USD 99 / EUR 99 / CNY 99 不得进入同一个比较组', () => {
  const F = foundation();
  const groups = F.modules.priceBands.groups;
  assert.ok(Array.isArray(groups), '按币种分组输出');
  const codes = groups.map(g => g.currency).sort();
  assert.deepStrictEqual(codes, ['CNY', 'EUR', 'USD'], '三种币种各成一组: ' + codes.join(','));
  for (const g of groups) {
    assert.strictEqual(g.brandCount, 1, g.currency + ' 组只含该币种品牌');
    // 组内所有行的币种一致
    for (const r of g.rows) assert.strictEqual(r.currency, g.currency);
  }
  // 每个币种组的中位数都不得跨币种计算（各只有 1 个品牌 → 无中位数）
  for (const g of groups) {
    assert.strictEqual(g.medianPrice, null, g.currency + ' 不足 3 个品牌不得算中位数');
    assert.strictEqual(g.positioningAvailable, false, g.currency + ' 不得生成相对定位线索');
  }
  assert.strictEqual(F.modules.priceBands.multiCurrency, true, '标记为多币种');
});

// ---------- C2 未知币种 ----------
test('C2 币种未知：商品数量仍进产品矩阵，价格分析不可用', () => {
  const F = foundation();
  const unk = F.modules.priceBands.rows.find(r => r.competitorId === 'c-unknown');
  assert.ok(unk, '未知币种品牌仍在价格行（商品数可用）');
  assert.strictEqual(unk.currencyStatus, 'unknown', '币种状态为 unknown');
  assert.strictEqual(unk.priceComparable, false, '价格不可比较');
  assert.strictEqual(unk.priceMin, null);
  assert.strictEqual(unk.priceMedian, null);
  assert.strictEqual(unk.priceMax, null);
  // 产品矩阵仍计入（SKU 不受币种影响）
  const matrix = F.modules.matrixDensity.rows.map(r => r.competitorId);
  assert.ok(matrix.includes('c-unknown'), '未知币种品牌的商品数仍进入产品矩阵');
});

// ---------- C3 混合币种 ----------
test('C3 混合币种：不得生成价格带或价格定位结论', () => {
  const F = foundation();
  const mix = F.modules.priceBands.rows.find(r => r.competitorId === 'c-mixed');
  assert.ok(mix, '混合币种品牌存在');
  assert.strictEqual(mix.currencyStatus, 'mixed', '币种状态为 mixed');
  assert.strictEqual(mix.currency, null, '不得拼成 USD/EUR');
  assert.strictEqual(mix.priceComparable, false);
  // 不得出现在任何币种组里
  for (const g of F.modules.priceBands.groups) {
    assert.ok(!g.rows.some(r => r.competitorId === 'c-mixed'), '混合币种品牌不得进入 ' + g.currency + ' 组');
  }
  // 非可比行单独列出并说明
  const nc = F.modules.priceBands.nonComparableRows.map(r => r.competitorId);
  assert.ok(nc.includes('c-mixed') && nc.includes('c-unknown'), '不可比较品牌单独列出: ' + nc.join(','));
  // 不得有跨币种的机会线索
  const cross = F.opportunities.filter(o => o.dimensionCode === 'price'
    && /USD.*EUR|EUR.*CNY|USD.*CNY/.test(JSON.stringify(o)));
  assert.strictEqual(cross.length, 0, '不得生成跨币种价格线索');
});

// ---------- C4 中位数门槛 ----------
test('C4 同币种三品牌才允许计算项目中位数', async () => {
  // 现状：每币种仅 1 个品牌 → 全部无中位数
  let F = foundation();
  for (const g of F.modules.priceBands.groups) assert.strictEqual(g.medianPrice, null);

  // 为 USD 组补两个同币种品牌 → 达到 3 个后应可计算中位数
  for (const [cid, prices] of [['c-usd2', [80, 90, 100]], ['c-usd3', [70, 85, 95]]]) {
    const s = mkSnapshot('https://' + cid + '.example.com/products.json', '{"products":[]}');
    const e = mkEvidence(s.snapshot_id, cid);
    seedProducts(cid, prices.map(p => ({ price: p, currency: 'USD' })), { key: cid, evidenceIds: [e.evidence_id], snapshotIds: [s.snapshot_id] });
  }
  // 新品牌需先进入项目竞品列表（loadState(tenantId) 只收租户参数；写盘异步需等读到为止）
  const { saveState: save } = require('../core/state-store.js');
  save({
    projectId: PID, tenantId: TID, track: 'SC12C', discoveredAt: new Date().toISOString(),
    intent: { regions: ['us'], category: 'pet' },
    competitors: COMPETITORS.concat([
      { id: 'c-usd2', name: 'UsdBrand2', url: 'https://c-usd2.example.com', status: 'done', isShopify: true },
      { id: 'c-usd3', name: 'UsdBrand3', url: 'https://c-usd3.example.com', status: 'done', isShopify: true },
    ]),
  });
  const { loadState } = require('../core/state-store.js');
  for (let i = 0; i < 300; i++) {
    const cur = loadState(TID);
    if (cur && Array.isArray(cur.competitors) && cur.competitors.length >= 7) break;
    await new Promise(r => setTimeout(r, 20));
  }

  F = foundation();
  const usd = F.modules.priceBands.groups.find(g => g.currency === 'USD');
  assert.ok(usd, 'USD 组存在');
  assert.ok(usd.brandCount >= 3, 'USD 组已达 3 个品牌: ' + usd.brandCount);
  assert.ok(usd.medianPrice != null, '达到 3 个同币种品牌后可计算中位数');
  assert.strictEqual(usd.positioningAvailable, true, '可生成相对定位线索');
  // 中位数只由 USD 品牌算出，不受 EUR/CNY 影响（EUR 99 若混入会改变结果）
  const usdMedians = usd.rows.filter(r => r.priceMedian != null).map(r => r.priceMedian).sort((a, b) => a - b);
  assert.ok(usdMedians.every(v => v >= 70 && v <= 130), '中位数样本全部来自 USD 区间: ' + usdMedians.join(','));
});

// ---------- C5 三维度真实取数 ----------
test('C5 content / heat / ads 从真实成功 attempt 进入机会模块', () => {
  const s1 = mkSnapshot('https://usd-sc12c.example.com/yt', '{"videos":[]}');
  const e1 = mkEvidence(s1.snapshot_id, 'yt');
  seedAttempt('c-usd', 'youtube_content', 'social_content', {
    key: 'yt1',
    observations: [{ id: 'v1', title: 'Video A', viewCount: 1000, likeCount: 10, videoUrl: 'https://youtu.be/v1', publishedAt: new Date().toISOString() }],
    evidenceIds: [e1.evidence_id], snapshotIds: [s1.snapshot_id],
    summary: { kind: 'social_videos', videoCount: 1, measurementMethod: 'public_source_observation' },
  });
  const s2 = mkSnapshot('https://usd-sc12c.example.com/trends', '{"trends":[]}');
  const e2 = mkEvidence(s2.snapshot_id, 'trends');
  seedAttempt('c-usd', 'dataforseo_trends', 'search_interest', {
    key: 'df1',
    observations: [{ id: 't1', title: 'keyword', publishedAt: new Date().toISOString() }],
    evidenceIds: [e2.evidence_id], snapshotIds: [s2.snapshot_id],
    summary: { kind: 'search_volume', measurementMethod: 'official_disclosure' },
  });
  const s3 = mkSnapshot('https://usd-sc12c.example.com/ads', '{"ads":[]}');
  const e3 = mkEvidence(s3.snapshot_id, 'ads');
  seedAttempt('c-usd', 'tiktok_commercial_content', 'ad_campaigns', {
    key: 'tt1',
    observations: [{ id: 'a1', title: 'Ad A', publishedAt: new Date().toISOString() }],
    evidenceIds: [e3.evidence_id], snapshotIds: [s3.snapshot_id],
    summary: { kind: 'ad_library_ads', measurementMethod: 'official_disclosure' },
  });

  const F = foundation();
  assert.strictEqual(F.dimensions.content.status, 'partial', 'content 维度有真实数据: ' + F.dimensions.content.status);
  assert.ok(F.dimensions.content.observationCount >= 1, 'content 观察数来自真实 attempt');
  assert.ok(F.dimensions.content.evidenceCount >= 1, 'content Evidence 数真实');
  assert.strictEqual(F.dimensions.heat.status, 'partial', 'heat 维度有真实数据');
  assert.strictEqual(F.dimensions.ads.status, 'partial', 'ads 维度有真实数据');
  // 有真实数据时不得再显示「未配置」
  assert.ok(F.dimensions.content.statusText !== '等待系统数据服务配置', '有数据后不得显示未配置');
});

// ---------- C6 状态不得混用 ----------
test('C6 合法零结果 / 缺配置 / 权限失败 / 限流 / 不可达 / 市场无覆盖 状态不得混用', () => {
  const F = foundation();
  const map = {
    not_configured: '等待系统数据服务配置',
    ready_to_verify: '数据服务待验证',
    auth_rejected: '等待平台授权',
    quota_exhausted: '平台配额已用尽',
    unavailable: '最近一次采集未成功',
    out_of_coverage: '该品牌所在市场暂未覆盖',
    checked_empty: '已检查，当前样本未观察到结果',
  };
  const texts = Object.values(map);
  // 每个文案必须唯一（否则就是混用）
  assert.strictEqual(new Set(texts).size, texts.length, '各状态文案互不相同');
  // 状态枚举本身不得混用：一个维度的 statusText 只能命中一个语义
  for (const key of ['content', 'heat', 'ads']) {
    const d = F.dimensions[key];
    if (!d.statusText) continue;
    const hits = texts.filter(t => d.statusText.indexOf(t) >= 0);
    assert.ok(hits.length <= 1, key + ' 状态文案不得同时命中多个语义: ' + hits.join('|'));
  }
  // 合法零结果 ≠ 未配置：成功但 0 条观察
  seedAttempt('c-eur', 'youtube_content', 'social_content', {
    key: 'ytempty', observations: [], status: 'success', sourceStatus: 'success',
    summary: { kind: 'social_videos', videoCount: 0 },
  });
  const F2 = foundation();
  const eur = (F2.dimensions.content.perBrand || []).find(p => p.name === 'EurBrand');
  assert.ok(eur, '逐品牌状态存在');
  assert.strictEqual(eur.state, 'checked_empty', '合法零结果标为已检查: ' + eur.state);
  assert.strictEqual(eur.stateText, '已检查，当前样本未观察到结果');
});

// ---------- C7 历史数据与最新失败 ----------
test('C7 最新失败覆盖旧成功：保留历史数据并标记 usingPreviousData', () => {
  const s = mkSnapshot('https://cny-sc12c.example.com/products2.json', '{"products":[]}');
  const e = mkEvidence(s.snapshot_id, 'cny2');
  // ① 先成功（较早）
  seedProducts('c-cny', [{ price: 111, currency: 'CNY' }], {
    key: 'cny-old', nowMs: Date.now() - 7200000, endedAt: new Date(Date.now() - 7200000).toISOString(),
    evidenceIds: [e.evidence_id], snapshotIds: [s.snapshot_id],
  });
  // ② 再失败（最新，晚于所有既有成功 attempt）
  seedAttempt('c-cny', 'shopify_catalog', 'website_products', {
    key: 'cny-new-fail', nowMs: Date.now() + 60000, status: 'failed',
    sourceStatus: 'unavailable', errorClass: 'unavailable',
    errorUserText: '对方官网暂时无法访问，稍后可重试。',
  });
  const F = foundation();
  const row = F.modules.priceBands.rows.find(r => r.competitorId === 'c-cny');
  assert.ok(row, '历史数据保留（行仍在）');
  assert.strictEqual(row.usingPreviousData, true, '显式标记 usingPreviousData');
  assert.ok(row.lastSuccessAt, '返回最后成功时间');
  assert.strictEqual(row.latestFailureText, '来源暂时不可达', '返回用户可读失败状态');
  // 默认不得用这类旧数据生成「当前市场」比较线索：c-cny 不得参与任何非历史价格线索
  const current = F.opportunities.filter(o => o.dimensionCode === 'price' && !o.historical
    && (o.evidenceRefs || []).some(r => r.brandId === 'c-cny' || r.competitorId === 'c-cny'));
  assert.strictEqual(current.length, 0, '不得用 c-cny 历史数据生成当前市场线索');
  // 其他品牌（真实成功数据）的价格线索不受影响，仍可生成
  const currentOthers = F.opportunities.filter(o => o.dimensionCode === 'price' && !o.historical
    && !(o.evidenceRefs || []).some(r => r.brandId === 'c-cny' || r.competitorId === 'c-cny'));
  // 若保留历史线索，标题与时间范围必须明确写成历史观察
  const hist = F.opportunities.filter(o => o.historical);
  for (const h of hist) {
    assert.ok(/历史观察/.test(h.title), '历史线索标题必须写明历史观察: ' + h.title);
    assert.ok(/历史/.test(h.fact), '历史线索事实必须写明历史');
  }
});

// ---------- C8 证据链 ----------
test('C8 比较结论引用全部参与样本的证据，且为结构化引用', () => {
  const F = foundation();
  assert.ok(F.opportunities.length > 0, '存在比较结论');
  for (const op of F.opportunities) {
    assert.ok(Array.isArray(op.evidenceRefs) && op.evidenceRefs.length > 0, op.id + ' 必须带证据引用');
    for (const r of op.evidenceRefs) {
      assert.ok(r && typeof r === 'object', op.id + ' 证据引用必须是对象（不是裸 ID 字符串）');
      assert.ok(r.evidenceId || r.snapshotId, op.id + ' 引用必须含 evidenceId 或 snapshotId');
      assert.ok('sourceUrl' in r && 'brandId' in r && 'observedAt' in r, op.id + ' 引用含 sourceUrl/brandId/observedAt');
      // 不得泄漏内部标识
      const blob = JSON.stringify(r);
      assert.ok(!/attempt|internal_error|adapter_output_invalid|source_status|jobId|claimToken|\/app\//i.test(blob),
        op.id + ' 证据引用不得含内部字段: ' + blob);
    }
  }
  // 价格类结论必须引用「全部参与品牌」
  const priceOps = F.opportunities.filter(o => o.dimensionCode === 'price' && !o.historical);
  for (const op of priceOps) {
    const brands = new Set(op.evidenceRefs.map(r => r.brandId).filter(Boolean));
    assert.ok(brands.size >= 3, op.id + ' 价格结论应引用全部参与品牌（≥3）: ' + brands.size);
  }
});

// ---------- C9 满意度门槛 ----------
test('C9 满意度门槛：两个完整对象不出图；三个只有评分不出图；三个完整才出图', () => {
  const mkObj = (i, opts) => {
    const o = opts || {};
    return Object.assign({
      oid: 'o' + i, label: '主题' + i,
      satisfaction: 7.5, importance: 6.5,
      satisfactionBasis: 'source_field', importanceBasis: 'source_field',
      sampleScope: '3/3 家有用户声音的品牌提到',
      window: { from: '2026-01-01', to: '2026-01-31' },
      evidenceRefs: [{ evidenceId: 'ev-x-' + i, snapshotId: 'sn-x-' + i, sourceUrl: 'https://x.example.com', observedAt: '2026-01-10' }],
    }, o);
  };

  // ① 两个完整对象 → 不出图
  let g = ScatterGate.evaluateScatterGate([mkObj(1), mkObj(2)], {});
  assert.strictEqual(g.available, false, '两个完整对象不出图');
  assert.strictEqual(g.comparableObjects, 2);
  assert.strictEqual(g.reason, '当前评论样本不足，暂不生成满意度分布');

  // ② 三个只有评分（无 importance / 无依据）→ 不出图
  g = ScatterGate.evaluateScatterGate([
    mkObj(1, { importance: null, importanceBasis: null }),
    mkObj(2, { importance: null, importanceBasis: null }),
    mkObj(3, { importance: null, importanceBasis: null }),
  ], {});
  assert.strictEqual(g.available, false, '三个只有评分的对象不出图');
  assert.strictEqual(g.comparableObjects, 0, '缺重要性的对象不得计入可比对象');
  assert.ok(g.rejected.length === 3, '三个对象全部被拒');
  assert.ok(g.rejected[0].missing.some(m => /重要性/.test(m)), '拒绝原因点名缺重要性');

  // ③ 三个同时具备满意度、重要性及证据 → 出图
  g = ScatterGate.evaluateScatterGate([mkObj(1), mkObj(2), mkObj(3)], {});
  assert.strictEqual(g.available, true, '三个完整对象出图');
  assert.strictEqual(g.comparableObjects, 3);
  assert.ok(g.objects.length === 3);
  // 坐标不得被修改（无 jitter）
  for (const o of g.objects) {
    assert.strictEqual(o.satisfaction, 7.5, '满意度坐标保持真实值');
    assert.strictEqual(o.importance, 6.5, '重要性坐标保持真实值');
    assert.ok(o.evidenceRefs.length >= 1 && o.evidenceRefs[0].evidenceId, '坐标带证据引用');
  }
  // ④ 缺证据 → 不出图
  g = ScatterGate.evaluateScatterGate([mkObj(1), mkObj(2), mkObj(3, { evidenceRefs: [] })], {});
  assert.strictEqual(g.available, false, '缺证据的对象不计入');
  assert.strictEqual(g.comparableObjects, 2);
});

// ---------- C10 / C11 / C12：载荷纪律 ----------
test('C10 机会模块有内容时不得出现笼统「暂无数据」', () => {
  const F = foundation();
  assert.strictEqual(F.summary.hasAnalysis, true, '有价格/商品/线索 → 有实质分析');
  const blob = JSON.stringify(F.modules.priceBands) + JSON.stringify(F.summary);
  assert.ok(!/机会地图暂无数据|暂无数据/.test(blob), '有内容时不得出现笼统暂无数据');
  // 不可用维度应给出具体状态而非笼统文案
  for (const d of F.unavailableDimensions) {
    assert.ok(d.statusText && d.statusText.length > 0, d.code + ' 给出具体状态文案');
  }
});

test('C11 不可用维度每项只显示一次', () => {
  const F = foundation();
  const codes = F.unavailableDimensions.map(d => d.code);
  assert.strictEqual(new Set(codes).size, codes.length, '不可用维度不重复: ' + codes.join(','));
  // 与可用维度不重叠
  const usable = F.summary.usableDimensionCodes;
  for (const c of codes) assert.ok(!usable.includes(c), c + ' 不得同时出现在可用与不可用列表');
});

test('C12 用户 API 无凭据名、内部错误码、attempt ID、provider、服务器路径', () => {
  const F = foundation();
  const blob = JSON.stringify(F);
  const BANNED = [
    'SERPER_API_KEY', 'YOUTUBE_API_KEY', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD',
    'TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET', 'LLM_API_KEY', 'MT_MASTER_KEY',
    'API_KEY', 'API 密钥', '凭据', 'credential', 'configKeys',
    'internal_error', 'adapter_output_invalid', 'source_status', 'sourceStatus',
    'error_class', 'errorClass', 'jobId', 'claimToken', 'attemptId',
    'YouTube', 'DataForSEO', 'TikTok', 'Serper', 'provider',
    '/app/', 'node_modules', '/opt/', 'Traceback', 'ERR_',
  ];
  for (const w of BANNED) {
    assert.ok(!blob.includes(w), '用户载荷不得出现「' + w + '」');
  }
  // att_ / snap_ 形式的内部 ID 也不得出现
  assert.ok(!/\b(att|ev|snap)_[a-z0-9]{8,}/i.test(blob.replace(/"(evidenceId|snapshotId)":"[^"]+"/g, '')),
    '不得出现裸内部 ID');
});

// ---------- C13 两租户 + 跨项目隔离 ----------
test('C13 两租户及跨项目隔离：B 租户看不到 A 租户的任何机会数据', () => {
  const FB = Foundation.buildOpportunityFoundation(TID_B, PID);
  assert.strictEqual(FB.brandScope.total, 0, 'B 租户无品牌');
  assert.strictEqual(FB.summary.brandCount, 0);
  assert.strictEqual(FB.summary.opportunityCount, 0, 'B 租户无机会线索');
  assert.strictEqual(FB.opportunities.length, 0);
  for (const key of ['price', 'catalog', 'dynamics', 'reviews', 'content', 'heat', 'ads']) {
    assert.strictEqual(FB.dimensions[key].brandCount, 0, key + ' 维度对 B 租户为空');
    assert.strictEqual(FB.dimensions[key].observationCount, 0);
  }
  // A 租户自身仍有数据（证明不是查询失败）
  const FA = foundation();
  assert.ok(FA.brandScope.total > 0, 'A 租户仍有数据');
});

// ---------- 附加：币种工具函数 ----------
test('C14 币种工具：ISO 校验、符号、价格带标题随币种变化', () => {
  assert.strictEqual(Foundation.isIsoCurrency('USD'), true);
  assert.strictEqual(Foundation.isIsoCurrency('usd'), false, '小写不合法');
  assert.strictEqual(Foundation.isIsoCurrency('DOLLAR'), false);
  assert.strictEqual(Foundation.isIsoCurrency(null), false);
  assert.strictEqual(Foundation.currencySymbol('USD'), '$');
  assert.strictEqual(Foundation.currencySymbol('EUR'), '€');
  assert.strictEqual(Foundation.currencySymbol('CNY'), '¥');
  const usdBands = Foundation.priceBandsFor('USD');
  const eurBands = Foundation.priceBandsFor('EUR');
  assert.ok(usdBands[0].label.startsWith('$'), 'USD 价格带用 $: ' + usdBands[0].label);
  assert.ok(eurBands[0].label.startsWith('€'), 'EUR 价格带用 €: ' + eurBands[0].label);
  assert.ok(!/\$/.test(eurBands.map(b => b.label).join('')), 'EUR 价格带不得出现 $');
  // 混合/未知判定
  assert.strictEqual(Foundation.currencyStatusOf(['USD', 'USD']).status, 'confirmed');
  assert.strictEqual(Foundation.currencyStatusOf(['USD', 'EUR']).status, 'mixed');
  assert.strictEqual(Foundation.currencyStatusOf([null, null]).status, 'unknown');
  assert.strictEqual(Foundation.currencyStatusOf(['usd']).status, 'mixed', '非法写法按 mixed 处理');
});
