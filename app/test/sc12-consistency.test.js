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
    tenantId: TID, projectId: o.projectId || PID, competitorId: compId, capability: 'shopify_catalog',
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
    tenantId: TID, projectId: o.projectId || PID, competitorId: compId, capability, dimension,
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
function foundationOf(pid, opts) { return Foundation.buildOpportunityFoundation(TID, pid, opts || {}); }

// 新建独立项目（competitors 列表 + 状态落盘）——避免新夹具污染既有断言
async function makeProject(pid, competitors) {
  db.saveProject({ id: pid, tenantId: TID, track: 'SC12C', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(pid, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({
    projectId: pid, tenantId: TID, track: 'SC12C', discoveredAt: new Date().toISOString(),
    intent: { regions: ['us'], category: 'pet' }, competitors,
  });
  for (let i = 0; i < 200 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(f), '项目状态文件已落盘: ' + pid);
}

function brandIdOfProject(pid, competitorId) {
  const v = BrandSvc.listBrandViews(TID, pid).find(x => x.competitorId === competitorId);
  return v ? v.brandId : null;
}

// 目录级时序事实（catalog.*）——用于跨层币种一致性测试
function seedCatalogFacts(compId, pid, opts) {
  const o = opts || {};
  const snap = mkSnapshot('https://' + compId + '-cat.example.com/products.json', '{"products":[]}');
  const ev = mkEvidence(snap.snapshot_id, compId + '-cat');
  const ent = MemStore.upsertEntity({
    tenantId: TID, projectId: pid, competitorId: compId,
    canonicalBrandKey: 'domain:' + compId + '.example.com',
    entityType: 'brand_catalog', sourcePlatform: 'shopify', externalId: compId + '.example.com',
    entityKey: compId + '.example.com|catalog', displayName: compId + ' 目录',
  });
  const at = o.observedAt || new Date().toISOString();
  for (const [type, val] of [
    ['catalog.product_count', o.productCount != null ? o.productCount : 3],
    ['catalog.price_min', o.priceMin],
    ['catalog.price_median', o.priceMedian],
    ['catalog.price_max', o.priceMax],
  ]) {
    const ver = MemStore.insertVersion({
      tenantId: TID, projectId: pid, competitorId: compId, entityId: ent.entityId,
      versionKey: 'v-' + type + '-' + at, sourceKind: 'live_observation', timePrecision: 'captured_only',
      parserVersion: 'sc12c-r3', observedAt: at, sourceSnapshotIds: [], evidenceIds: [],
    });
    MemStore.insertFact({
      tenantId: TID, projectId: pid, competitorId: compId, entityId: ent.entityId,
      entityVersionId: ver.versionId, entityType: 'brand_catalog', factType: type,
      valueNum: val, unit: null, currency: o.currency || 'USD',
      measurementMethod: 'direct_observation', sourceKind: 'live_observation', sourceStatus: 'success',
      timePrecision: 'captured_only', observedAt: at,
      evidenceIds: [ev.evidence_id], snapshotIds: [snap.snapshot_id],
    });
  }
  return { snapshotId: snap.snapshot_id, evidenceId: ev.evidence_id };
}

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

// ---------- C7 历史数据与当前比较彻底隔离（§一） ----------
test('C7 三个 USD 品牌其中一个仅有历史成功 → 当前比较只剩两个，不得生成三品牌比较', async () => {
  const PID_H = 'projSc12c-hist';
  await makeProject(PID_H, [
    { id: 'c-h1', name: 'HistOne', url: 'https://h1-sc12c.example.com', status: 'done', isShopify: true },
    { id: 'c-h2', name: 'HistTwo', url: 'https://h2-sc12c.example.com', status: 'done', isShopify: true },
    { id: 'c-h3', name: 'HistThree', url: 'https://h3-sc12c.example.com', status: 'done', isShopify: true },
  ]);
  const seedOne = (cid, prices, o) => {
    const snap = mkSnapshot('https://' + cid + '-hist.example.com/products.json', '{"products":[]}');
    const ev = mkEvidence(snap.snapshot_id, cid + '-hist');
    return seedProducts(cid, prices.map(x => ({ price: x, currency: 'USD' })), Object.assign({
      projectId: PID_H, evidenceIds: [ev.evidence_id], snapshotIds: [snap.snapshot_id],
    }, o || {}));
  };
  // 两个新鲜品牌
  seedOne('c-h1', [10, 20, 30], { key: 'h1-a' });
  seedOne('c-h2', [40, 50, 60], { key: 'h2-a' });
  // 第三个：先成功（旧）→ 再失败（最新，仅历史成功）
  seedOne('c-h3', [70, 80, 90], { key: 'h3-old', nowMs: Date.now() - 7200000, endedAt: new Date(Date.now() - 7200000).toISOString() });
  seedAttempt('c-h3', 'shopify_catalog', 'website_products', {
    projectId: PID_H, key: 'h3-fail', nowMs: Date.now() + 60000, status: 'failed',
    sourceStatus: 'unavailable', errorClass: 'unavailable', errorUserText: '对方官网暂时无法访问，稍后可重试。',
  });

  const h3BrandId = brandIdOfProject(PID_H, 'c-h3');
  assert.ok(h3BrandId && h3BrandId.startsWith('br_'), '使用真实品牌档案 ID（不是 competitorId）: ' + h3BrandId);

  let F = foundationOf(PID_H);
  const usd = F.modules.priceBands.groups.find(g => g.currency === 'USD');
  assert.ok(usd, 'USD 组存在');
  assert.strictEqual(usd.brandCount, 2, '当前比较只剩两个新鲜品牌: ' + usd.brandCount);
  assert.strictEqual(usd.medianPrice, null, '不足三个新鲜品牌不得计算中位数');
  assert.strictEqual(usd.positioningAvailable, false, '不得生成价格定位结论');
  assert.ok(!usd.rows.some(r => r.brandId === h3BrandId), '历史品牌不得进入当前价格组');

  // 矩阵比较需要 ≥3 个新鲜品牌 → 不得生成
  const matrixOps = F.opportunities.filter(o => o.dimensionCode === 'catalog' && !o.historical);
  assert.strictEqual(matrixOps.length, 0, '两个新鲜品牌不得生成矩阵比较');

  // 任何当前线索的证据集都不得含历史品牌
  for (const op of F.opportunities.filter(o => !o.historical)) {
    assert.ok(!(op.evidenceRefs || []).some(r => r.brandId === h3BrandId),
      op.id + ' 不得把历史品牌放进当前比较证据集');
  }

  // 维度计数
  assert.strictEqual(F.dimensions.price.freshBrandCount, 2, 'freshBrandCount=2');
  assert.strictEqual(F.dimensions.price.historicalBrandCount, 1, 'historicalBrandCount=1');
  assert.strictEqual(F.dimensions.price.usingPreviousData, true);
  assert.ok(F.dimensions.price.lastSuccessAt, '返回最后成功时间');
  assert.strictEqual(F.dimensions.catalog.historicalBrandCount, 1, 'catalog 同样标历史计数');

  // 历史数据只出现在「历史观察」区域
  assert.ok(F.modules.priceBands.historicalRows.some(r => r.brandId === h3BrandId), '历史行独立成集');
  const histGroup = F.historicalObservations.find(g => g.dimensionCode === 'price');
  assert.ok(histGroup && histGroup.rows.some(r => r.brandId === h3BrandId), '历史观察独立区域含该品牌');
  const histLead = F.opportunities.find(o => o.historical);
  assert.ok(histLead && /历史观察/.test(histLead.title), '历史线索标题写明历史观察');
  assert.ok(histLead.historical === true);

  // 重新成功采集 → 自动重新进入当前比较
  seedOne('c-h3', [70, 80, 90], { key: 'h3-recover', nowMs: Date.now() + 180000, endedAt: new Date(Date.now() + 180000).toISOString() });
  F = foundationOf(PID_H);
  const usd2 = F.modules.priceBands.groups.find(g => g.currency === 'USD');
  assert.strictEqual(usd2.brandCount, 3, '重新成功后回到 3 个品牌: ' + usd2.brandCount);
  assert.ok(usd2.medianPrice != null, '三个新鲜品牌可算中位数');
  assert.strictEqual(F.dimensions.price.historicalBrandCount, 0, '历史计数清零');
  assert.strictEqual(F.modules.priceBands.historicalRows.length, 0, '历史行清空');
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

// ---------- C9 满意度门槛（字段 + scope/window + 依据分离） ----------
test('C9 满意度门槛：字段/依据/scope/window 四类断言与坐标一致性', () => {
  const mkObj = (i, opts) => {
    const o = opts || {};
    return Object.assign({
      oid: 'o' + i, label: '主题' + i,
      satisfaction: 7.5, importance: 6.5,
      satisfactionBasis: 'source_field',
      // §五.3：重要性依据必须是「提及品牌广度的确定性计算」
      importanceBasis: 'mention_breadth',
      sampleScope: '项目公开评论语料：3/3 家品牌有合格用户声音（共 30 条合格提及）',
      window: { from: '2026-01-01', to: '2026-01-31' },
      evidenceRefs: [{ evidenceId: 'ev-x-' + i, snapshotId: 'sn-x-' + i, sourceUrl: 'https://x.example.com', observedAt: '2026-01-10' }],
    }, o);
  };

  // ① 两个完整对象 → 不出图
  let g = ScatterGate.evaluateScatterGate([mkObj(1), mkObj(2)], {});
  assert.strictEqual(g.available, false, '两个完整对象不出图');
  assert.strictEqual(g.reason, '当前评论样本不足，暂不生成满意度分布');
  assert.strictEqual(g.objects.length, 0, '不出图时不得给坐标');

  // ② 三个只有评分（无重要性）→ 不出图
  g = ScatterGate.evaluateScatterGate([
    mkObj(1, { importance: null, importanceBasis: null }),
    mkObj(2, { importance: null, importanceBasis: null }),
    mkObj(3, { importance: null, importanceBasis: null }),
  ], {});
  assert.strictEqual(g.available, false, '三个只有评分的对象不出图');
  assert.strictEqual(g.comparableObjects, 0);
  assert.ok(g.rejected[0].missing.some(m => /重要性/.test(m)), '拒绝原因点名缺重要性');

  // ②b 重要性依据复用情绪分类依据 → 不合格（依据不得混用）
  g = ScatterGate.evaluateScatterGate([
    mkObj(1, { importanceBasis: 'source_field' }),
    mkObj(2, { importanceBasis: 'source_field' }),
    mkObj(3, { importanceBasis: 'source_field' }),
  ], {});
  assert.strictEqual(g.available, false, '重要性依据不得复用情绪分类依据');
  assert.ok(g.rejected[0].missing.some(m => /提及品牌广度/.test(m)));

  // ③ 三个对象样本范围不同 → 不出图
  g = ScatterGate.evaluateScatterGate([
    mkObj(1, { sampleScope: 'A 语料' }), mkObj(2, { sampleScope: 'B 语料' }), mkObj(3, { sampleScope: 'C 语料' }),
  ], {});
  assert.strictEqual(g.available, false, '样本范围不同的对象不得合并出图');
  assert.ok(g.groups.length >= 3, '按 scope 分组: ' + g.groups.length);

  // ④ 三个对象时间窗口无交集 → 不出图
  g = ScatterGate.evaluateScatterGate([
    mkObj(1, { window: { from: '2026-01-01', to: '2026-01-05' }, evidenceRefs: [{ evidenceId: 'e1', observedAt: '2026-01-02' }] }),
    mkObj(2, { window: { from: '2026-02-01', to: '2026-02-05' }, evidenceRefs: [{ evidenceId: 'e2', observedAt: '2026-02-02' }] }),
    mkObj(3, { window: { from: '2026-03-01', to: '2026-03-05' }, evidenceRefs: [{ evidenceId: 'e3', observedAt: '2026-03-02' }] }),
  ], {});
  assert.strictEqual(g.available, false, '时间窗口无交集的三个对象不出图');
  assert.ok(g.groups.every(x => x.count < 3), '每个分组都 <3');

  // ⑤ 三个对象范围一致、时间可比 → 出图，坐标逐项等于服务端返回值
  const objs = [mkObj(1), mkObj(2), mkObj(3)];
  g = ScatterGate.evaluateScatterGate(objs, {});
  assert.strictEqual(g.available, true, '三个可比对象出图');
  assert.strictEqual(g.comparableObjects, 3);
  assert.strictEqual(g.objects.length, 3);
  for (let i = 0; i < objs.length; i++) {
    const src = objs[i], out = g.objects.find(x => x.oid === src.oid);
    assert.ok(out, '对象存在: ' + src.oid);
    assert.strictEqual(out.satisfaction, src.satisfaction, '坐标 satisfaction 与服务端一致');
    assert.strictEqual(out.importance, src.importance, '坐标 importance 与服务端一致');
    assert.strictEqual(out.sampleScope, src.sampleScope, '样本范围一致');
    assert.ok(out.evidenceRefs.length >= 1 && out.evidenceRefs[0].evidenceId, '坐标带证据');
  }

  // ⑥ 证据观察时间不在窗口内 → 该对象不合格
  g = ScatterGate.evaluateScatterGate([
    mkObj(1), mkObj(2),
    mkObj(3, { evidenceRefs: [{ evidenceId: 'ev-out', observedAt: '2025-06-01' }] }),
  ], {});
  assert.strictEqual(g.available, false, '证据不在窗口内的对象不计入');
  assert.strictEqual(g.comparableObjects, 2);
  assert.ok(g.rejected.some(x => (x.missing || []).some(m => /Evidence/.test(m))));
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

// ---------- C15 跨层币种冲突（§二） ----------
test('C15 时序档案 USD + 最新商品观察 EUR → conflict，价格不可比较但商品数量仍展示', async () => {
  const PID_X = 'projSc12c-ccy';
  await makeProject(PID_X, [
    { id: 'c-x', name: 'ConflictBrand', url: 'https://x-ccy.example.com', status: 'done', isShopify: true },
    { id: 'c-y', name: 'SameCcyBrand', url: 'https://y-ccy.example.com', status: 'done', isShopify: true },
    { id: 'c-z', name: 'CatalogNewer', url: 'https://z-ccy.example.com', status: 'done', isShopify: true },
  ]);
  // c-x：目录档案 USD（较旧），最新商品观察 EUR
  seedCatalogFacts('c-x', PID_X, {
    currency: 'USD', observedAt: new Date(Date.now() - 86400000).toISOString(),
    productCount: 3, priceMin: 10, priceMedian: 20, priceMax: 30,
  });
  const sx = mkSnapshot('https://x-ccy.example.com/products.json', '{"products":[]}');
  const ex = mkEvidence(sx.snapshot_id, 'x-ccy');
  seedProducts('c-x', [{ price: 5, currency: 'EUR' }, { price: 15, currency: 'EUR' }], {
    projectId: PID_X, key: 'x-eur', evidenceIds: [ex.evidence_id], snapshotIds: [sx.snapshot_id],
  });

  // c-y：两层同为 USD，观察更新 → 取观察层数值/时间/证据（同一套事实）
  seedCatalogFacts('c-y', PID_X, {
    currency: 'USD', observedAt: new Date(Date.now() - 86400000).toISOString(),
    productCount: 9, priceMin: 100, priceMedian: 200, priceMax: 300,
  });
  const sy = mkSnapshot('https://y-ccy.example.com/products.json', '{"products":[]}');
  const ey = mkEvidence(sy.snapshot_id, 'y-ccy');
  seedProducts('c-y', [{ price: 41, currency: 'USD' }, { price: 59, currency: 'USD' }], {
    projectId: PID_X, key: 'y-usd', evidenceIds: [ey.evidence_id], snapshotIds: [sy.snapshot_id],
  });

  // c-z：两层同为 USD，档案更新 → 取档案层数值/时间/证据（同一套事实）
  seedCatalogFacts('c-z', PID_X, {
    currency: 'USD', observedAt: new Date().toISOString(),
    productCount: 7, priceMin: 11, priceMedian: 22, priceMax: 33,
  });
  seedProducts('c-z', [{ price: 5, currency: 'USD' }], {
    projectId: PID_X, key: 'z-usd', nowMs: Date.now() - 172800000,
    endedAt: new Date(Date.now() - 172800000).toISOString(),
  });

  const F = foundationOf(PID_X);
  const rows = F.modules.priceBands.rows;
  const x = rows.find(r => r.competitorId === 'c-x');
  assert.ok(x, '冲突品牌仍在价格行（商品数量可展示）');
  assert.strictEqual(x.currencyStatus, 'conflict', '币种状态为 conflict');
  assert.strictEqual(x.priceComparable, false, '价格不可比较');
  assert.strictEqual(x.priceMin, null, '冲突时不得采用任一层的价格数值');
  assert.strictEqual(x.priceMedian, null);
  assert.strictEqual(x.priceMax, null);
  assert.ok(x.productCount != null, '商品数量仍可展示: ' + x.productCount);
  assert.ok(!F.modules.priceBands.groups.some(g => g.rows.some(r => r.competitorId === 'c-x')),
    '冲突品牌不得进入任何币种组');
  const cf = (F.modules.priceBands.currencyConflicts || []).find(c => c.competitorId === 'c-x' || c.brandId === x.brandId);
  assert.ok(cf, '冲突品牌进入 currencyConflicts 清单');
  assert.strictEqual(cf.observationCurrency, 'EUR');
  assert.strictEqual(cf.catalogCurrency, 'USD');

  // 同币种：观察更新 → 用观察层，且时间/证据同源
  const y = rows.find(r => r.competitorId === 'c-y');
  assert.strictEqual(y.currencyStatus, 'confirmed');
  assert.strictEqual(y.priceSource, 'observation', '新观察优先');
  assert.strictEqual(y.priceMin, 41);
  assert.strictEqual(y.priceMax, 59);
  assert.ok(y.evidenceRefs.length >= 1 && y.evidenceRefs.every(r => r.brandId === y.brandId), '证据来自同一品牌同一套事实');

  // 同币种：档案更新 → 用档案层数值与时间（不得用旧观察数值配新档案时间）
  const z = rows.find(r => r.competitorId === 'c-z');
  assert.strictEqual(z.priceSource, 'catalog', '更新的档案优先');
  assert.strictEqual(z.priceMin, 11);
  assert.strictEqual(z.priceMedian, 22);
  assert.strictEqual(z.priceMax, 33);
  assert.ok(z.observedAt, '时间来自档案层');
});

// ---------- C16 比较证据覆盖全部参与品牌（§三） ----------
test('C16 18 品牌比较结论：证据覆盖 18 个不同 brandId；缺任一品牌证据则不生成', async () => {
  const PID_E = 'projSc12c-18';
  const comps = [];
  for (let i = 1; i <= 18; i++) {
    comps.push({ id: 'c-e' + i, name: 'Brand' + String(i).padStart(2, '0'), url: 'https://e' + i + '-18.example.com', status: 'done', isShopify: true });
  }
  await makeProject(PID_E, comps);
  const seedOne = (i, skuCount) => {
    const snap = mkSnapshot('https://e' + i + '-18.example.com/products.json', '{"products":[]}');
    const ev = mkEvidence(snap.snapshot_id, 'e' + i);
    const items = [];
    for (let k = 0; k < skuCount; k++) items.push({ price: 10 + k, currency: 'USD' });
    seedProducts('c-e' + i, items, {
      projectId: PID_E, key: 'e' + i, evidenceIds: [ev.evidence_id], snapshotIds: [snap.snapshot_id],
    });
  };
  // SKU 数：1..18 → 中位数 9.5，低于中位数的品牌可生成矩阵比较
  for (let i = 1; i <= 18; i++) seedOne(i, i);

  const F = foundationOf(PID_E);
  const matrixOps = F.opportunities.filter(o => o.dimensionCode === 'catalog' && !o.historical);
  assert.ok(matrixOps.length > 0, '18 品牌可生成矩阵比较');
  const op = matrixOps[0];
  assert.ok(/18 个品牌/.test(op.sampleSize), '样本量为 18 个品牌: ' + op.sampleSize);
  const covered = new Set(op.evidenceRefs.map(r => r.brandId).filter(Boolean));
  assert.strictEqual(covered.size, 18, '证据覆盖全部 18 个参与品牌: ' + covered.size);
  assert.ok(op.evidenceRefs.length >= 18, '引用数量不少于品牌数: ' + op.evidenceRefs.length);
  // 每个引用都是结构化对象且带齐字段
  for (const r of op.evidenceRefs) {
    assert.ok(r && typeof r === 'object');
    assert.ok(r.evidenceId || r.snapshotId);
    assert.ok('sourceUrl' in r && 'brandId' in r && 'observedAt' in r);
  }

  // 缺任一品牌证据 → 不得生成该比较结论
  const PID_E2 = 'projSc12c-18b';
  await makeProject(PID_E2, comps);
  for (let i = 1; i <= 18; i++) {
    const snap = mkSnapshot('https://e' + i + '-18b.example.com/products.json', '{"products":[]}');
    const ev = mkEvidence(snap.snapshot_id, 'e' + i + 'b');
    const items = [];
    for (let k = 0; k < i; k++) items.push({ price: 10 + k, currency: 'USD' });
    // 第 7 个品牌故意不带证据
    seedProducts('c-e' + i, items, i === 7
      ? { projectId: PID_E2, key: 'e' + i + 'b' }
      : { projectId: PID_E2, key: 'e' + i + 'b', evidenceIds: [ev.evidence_id], snapshotIds: [snap.snapshot_id] });
  }
  const F2 = foundationOf(PID_E2);
  const matrixOps2 = F2.opportunities.filter(o => o.dimensionCode === 'catalog' && !o.historical);
  assert.strictEqual(matrixOps2.length, 0, '缺任一品牌证据时不得生成矩阵比较');
});

// ---------- C17 内容 / 热度 / 广告 用户可见模块（§四） ----------
test('C17 modules.contentActivity / searchInterest / adActivity 结构完整且状态如实', () => {
  const F = foundation();
  for (const key of ['contentActivity', 'searchInterest', 'adActivity']) {
    const m = F.modules[key];
    assert.ok(m, '模块存在: ' + key);
    assert.ok(typeof m.available === 'boolean', key + ' 有 available');
    assert.ok(typeof m.status === 'string' && m.status, key + ' 有 status');
    assert.ok('statusText' in m, key + ' 有 statusText');
    assert.ok(typeof m.brandCount === 'number', key + ' 有品牌数');
    assert.ok(typeof m.observationCount === 'number', key + ' 有观察数');
    assert.ok(m.window && 'from' in m.window && 'to' in m.window, key + ' 有观察时间范围');
    assert.ok(typeof m.measurementMethod === 'string', key + ' 有 measurementMethod');
    assert.ok(Array.isArray(m.evidenceRefs), key + ' 有结构化证据引用');
    assert.ok(Array.isArray(m.perBrand) && m.perBrand.length > 0, key + ' 有逐品牌覆盖状态');
    assert.ok(typeof m.usingPreviousData === 'boolean', key + ' 有 usingPreviousData');
    assert.ok(Array.isArray(m.limits) && m.limits.length > 0, key + ' 有限制说明');
    assert.ok(Array.isArray(m.historicalRows), key + ' 有历史行');
    for (const r of m.evidenceRefs) assert.ok(r && typeof r === 'object' && (r.evidenceId || r.snapshotId));
    // 不允许「维度可用但页面没有内容」
    if (m.available) assert.ok(m.rows.length > 0, key + ' 可用时必须有可展示内容');
  }
  // c-usd 在 C5 中已有真实 content/heat/ads 成功观察 → 三个模块均可用
  assert.strictEqual(F.modules.contentActivity.available, true, 'content 有真实数据');
  assert.strictEqual(F.modules.searchInterest.available, true, 'heat 有真实数据');
  assert.strictEqual(F.modules.adActivity.available, true, 'ads 有真实数据');
  assert.ok(F.modules.contentActivity.rows.some(r => r.items.length > 0), 'content 模块展示真实观察条目');
  // 合法零结果（c-eur youtube 成功但 0 条）→ perBrand 标 checked_empty，不等于未配置
  const eurContent = (F.modules.contentActivity.perBrand || []).find(p => p.name === 'EurBrand');
  assert.ok(eurContent, 'EurBrand 在 content 模块逐品牌状态里');
  assert.strictEqual(eurContent.state, 'checked_empty', '合法零结果标 checked_empty: ' + eurContent.state);
  assert.strictEqual(eurContent.stateText, '已检查，当前样本未观察到结果');
  // 尚未分析的维度不产出机会结论
  assert.ok(/只陈述公开观察事实/.test(F.modules.contentActivity.analysisNote), '只陈述事实、不强行生成机会结论');
});

// ---------- C18 历史数据不参与当前机会判断（§四.4） ----------
test('C18 维度历史数据只进历史行，不参与当前模块与机会判断', async () => {
  const PID_G = 'projSc12c-g';
  await makeProject(PID_G, [
    { id: 'c-g1', name: 'GOne', url: 'https://g1.example.com', status: 'done', isShopify: true },
  ]);
  const s1 = mkSnapshot('https://g1.example.com/yt', '{"videos":[]}');
  const e1 = mkEvidence(s1.snapshot_id, 'g1-yt');
  // 先成功（旧），再失败（最新）→ 历史观察
  seedAttempt('c-g1', 'youtube_content', 'social_content', {
    projectId: PID_G, key: 'g1-yt-old', nowMs: Date.now() - 7200000,
    observations: [{ id: 'v1', title: 'Old Video', videoUrl: 'https://youtu.be/old', publishedAt: new Date(Date.now() - 7200000).toISOString() }],
    evidenceIds: [e1.evidence_id], snapshotIds: [s1.snapshot_id],
    summary: { kind: 'social_videos', videoCount: 1 },
  });
  seedAttempt('c-g1', 'youtube_content', 'social_content', {
    projectId: PID_G, key: 'g1-yt-fail', nowMs: Date.now() + 60000, status: 'failed',
    sourceStatus: 'unavailable', errorClass: 'unavailable',
  });

  const F = foundationOf(PID_G);
  const m = F.modules.contentActivity;
  assert.strictEqual(m.available, false, '历史数据不算当前可用');
  assert.strictEqual(m.brandCount, 0);
  assert.strictEqual(m.historicalBrandCount, 1, '历史品牌计数=1');
  assert.strictEqual(m.usingPreviousData, true);
  assert.strictEqual(m.historicalRows.length, 1, '历史行独立成集');
  assert.ok(m.historicalRows[0].items.length >= 1, '历史行展示原始观察');
  assert.strictEqual(F.dimensions.content.freshBrandCount, 0);
  assert.strictEqual(F.dimensions.content.historicalBrandCount, 1);
  const g = F.historicalObservations.find(x => x.dimensionCode === 'content');
  assert.ok(g && g.rows.length === 1, 'content 历史观察进入独立区域');
  // 历史数据不得产生当前机会线索
  assert.ok(!F.opportunities.some(o => !o.historical && o.dimensionCode === 'content'), '历史 content 不得生成当前线索');
});
