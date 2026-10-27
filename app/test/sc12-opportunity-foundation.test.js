'use strict';
// ============================================================
// test/sc12-opportunity-foundation.test.js —— SC-12 后端行为回归
//   O1 机会数据基础：维度字段完整（参与品牌数/观察数/时间范围/Evidence/状态/measurementMethod/限制）
//   O2 缺失不填 0：无价格品牌不进价格分布；未接通维度标 not_configured
//   O3 满意度×重要性门槛：样本不足不出图，且给出规定文案
//   O4 机会线索纪律：每条含事实/维度/样本量/时间范围/证据入口/限制/建议验证问题；禁经营结论词
//   O5 卡片短状态：历史失败→后续成功→已更新；有数据+最近失败→保留数据标 stale
//   O6 失败分类映射到短状态（来源拒绝/限流/不可达），且无内部词泄漏
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc12-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.ZB_FIRST_COLLECTION_AUTO = 'off';
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });

const db = require('../services/db.js');
const BrandStore = require('../services/brand-store.js');
const BrandSvc = require('../services/brand-service.js');
const SurfaceStore = require('../services/surface-store.js');
const MemStore = require('../services/competitive-memory-store.js');
const Foundation = require('../services/opportunity-foundation.js');
const Snapshot = require('../research/source-snapshot.js');
const EvidenceStore = require('../research/evidence-store.js');
const { saveState, projFile } = require('../core/state-store.js');

const TID = 'tenant:sc12';
const PID = 'projSc12';
const COMPETITORS = [
  { id: 'c-alpha', name: 'Alpha', url: 'https://alpha-sc12.example.com', status: 'done', isShopify: true },
  { id: 'c-beta', name: 'Beta', url: 'https://beta-sc12.example.com', status: 'done', isShopify: true },
  { id: 'c-gamma', name: 'Gamma', url: 'https://gamma-sc12.example.com', status: 'done', isShopify: false },
  // c-delta：带价品牌（与 alpha/beta 同币种 USD）——「同币种 ≥3 品牌才允许计算中位数」
  { id: 'c-delta', name: 'Delta', url: 'https://delta-sc12.example.com', status: 'done', isShopify: true },
];

function seedCatalog(compId, prices, opts) {
  const o = opts || {};
  const mk = SurfaceStore.createAttempt({
    tenantId: TID, projectId: PID, competitorId: compId, capability: 'shopify_catalog',
    dimension: 'website_products', trigger: 'manual', idempotencyKey: 'sc12-' + compId + '-' + (o.key || 'k'),
  });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
    status: 'success', sourceStatus: 'success',
    observations: prices.map((p, i) => ({ id: compId + '-' + i, title: 'SKU ' + i, price: p, currency: 'USD', available: i % 4 !== 3, publishedAt: null })),
    snapshotIds: [], evidenceIds: o.evidenceIds || [],
    summary: { kind: 'storefront_catalog', count: prices.length, priceMin: Math.min(...prices), priceMax: Math.max(...prices), currency: 'USD', currencyStatus: 'confirmed' },
    endedAt: o.endedAt || new Date().toISOString(),
  });
  return mk.attempt.attemptId;
}

function seedReviews(compId, opts) {
  const o = opts || {};
  const mk = SurfaceStore.createAttempt({
    tenantId: TID, projectId: PID, competitorId: compId, capability: 'public_reviews',
    dimension: 'reviews_reputation', trigger: 'manual', idempotencyKey: 'sc12-rev-' + compId + '-' + (o.key || 'k'),
    nowMs: o.nowMs || Date.now(),
  });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
    status: 'success', sourceStatus: 'success',
    observations: o.observations || [],
    snapshotIds: [], evidenceIds: o.evidenceIds || [],
    summary: { kind: 'reviews_digest', reviewCount: o.reviewCount == null ? 0 : o.reviewCount, sourceCount: (o.observations || []).length, measurementMethod: 'public_source_observation', emptyReason: o.emptyReason || null },
    endedAt: o.endedAt || new Date().toISOString(),
  });
  return mk.attempt.attemptId;
}

function seedFailure(compId, capability, dimension, sourceStatus, errorClass, key, nowMs) {
  const mk = SurfaceStore.createAttempt({
    tenantId: TID, projectId: PID, competitorId: compId, capability, dimension,
    trigger: 'manual', idempotencyKey: 'sc12-fail-' + compId + '-' + key, nowMs: nowMs || Date.now(),
  });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
    status: 'failed', sourceStatus, errorClass,
    errorUserText: '采集时发生内部问题，已记录，稍后可重试。',
    observations: [], snapshotIds: [], evidenceIds: [],
  });
  return mk.attempt.attemptId;
}

// 真实快照 + 证据（SC-05 §4.3：事实必须引用真实 evidence 与 snapshot）
function mkSnapshot(url, body) {
  const r = Snapshot.record({
    capability: 'product_catalog', provider: 'shopify_products_json', source_url: url,
    final_url: url, redirect_hops: 0, http_status: 200, source_status: 'success',
    observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
    bodyBytes: Buffer.from(body || '{}'), contentType: 'application/json', trigger: 'manual', tenantId: TID,
  });
  assert.ok(r.recorded, 'snapshot recorded: ' + url);
  return r.meta;
}
function mkEvidence(snapshotId, brandHint) {
  const ev = EvidenceStore.recordEvidence({
    tenantId: TID, projectRef: PID, brandHint: brandHint, source: 'shopify', provider: 'shopify_products_json',
    source_snapshot_ids: [snapshotId],
    claim: { field: 'catalog.observation', scope: 'public_catalog_observation' },
    entity_key: brandHint + '.example.com', entity_ref: { kind: 'storefront_domain', domain: brandHint + '.example.com' },
    extracted_value: { summaryKind: 'storefront_catalog', count: 4, priceMin: 9.99, priceMax: 39.99, priceMedian: 24.99, currency: 'USD' },
    unit: null, currency: 'USD', market: null, evidence_status: 'verified',
    parser_version: 'shopify-adapter-1', extractor_version: 'shopify-adapter-1',
    observed_at: new Date().toISOString(), note: 'sc12 fixture',
  });
  assert.ok(ev.recorded, 'evidence recorded');
  return ev.meta;
}

function foundation() { return Foundation.buildOpportunityFoundation(TID, PID); }
function views() { return BrandSvc.listBrandViews(TID, PID); }

test.before(async () => {
  db.createTenant({ name: 'sc12', email: 'sc12@example.com' });
  db.saveProject({ id: PID, tenantId: TID, track: 'SC12', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(PID, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({ projectId: PID, tenantId: TID, track: 'SC12', discoveredAt: new Date().toISOString(), intent: { regions: ['us'], category: 'pet' }, competitors: COMPETITORS });
  for (let i = 0; i < 200 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20)); // 状态文件异步落盘
  assert.ok(fs.existsSync(f), '项目状态文件已落盘');

  const snapA = mkSnapshot('https://alpha-sc12.example.com/products.json', JSON.stringify({ products: [{ id: 1, price: '9.99' }, { id: 2, price: '39.99' }] }));
  const evA = mkEvidence(snapA.snapshot_id, 'alpha');
  seedCatalog('c-alpha', [9.99, 19.99, 29.99, 39.99], { key: 'a1', evidenceIds: [evA.evidence_id] });
  const snapB = mkSnapshot('https://beta-sc12.example.com/products.json', JSON.stringify({ products: [{ id: 1, price: '89' }] }));
  const evB = mkEvidence(snapB.snapshot_id, 'beta');
  seedCatalog('c-beta', [89, 99, 109, 119], { key: 'b1', evidenceIds: [evB.evidence_id] });
  const snapD = mkSnapshot('https://delta-sc12.example.com/products.json', JSON.stringify({ products: [{ id: 1, price: '25' }] }));
  const evD = mkEvidence(snapD.snapshot_id, 'delta');
  seedCatalog('c-delta', [15, 25, 35], { key: 'd1', evidenceIds: [evD.evidence_id] });
  // c-gamma 无价格数据（缺失不得填 0）
  seedReviews('c-alpha', { key: 'r1', observations: [{ id: 'p1', title: 'Alpha review page', price: null, currency: null, available: true, publishedAt: null, rating: null, reviewCount: null, sourceUrl: 'https://alpha-sc12.example.com/reviews' }], evidenceIds: ['ev-alpha-rev-1'] });
  // 记忆事实：目录级聚合（price_min/median/max、product_count）
  try {
    const ent = MemStore.upsertEntity({
      tenantId: TID, projectId: PID, competitorId: 'c-alpha', canonicalBrandKey: 'domain:alpha-sc12.example.com',
      entityType: 'brand_catalog', sourcePlatform: 'shopify', externalId: 'alpha-sc12.example.com',
      entityKey: 'alpha-sc12.example.com|catalog', displayName: 'Alpha 商品目录',
    });
    for (const [type, val] of [['catalog.product_count', 4], ['catalog.price_min', 9.99], ['catalog.price_median', 24.99], ['catalog.price_max', 39.99]]) {
      const ver = MemStore.insertVersion({
        tenantId: TID, projectId: PID, competitorId: 'c-alpha', entityId: ent.entityId,
        versionKey: 'v-' + type, sourceKind: 'live_observation', timePrecision: 'captured_only',
        parserVersion: 'sc12-test-1', observedAt: new Date().toISOString(),
        sourceSnapshotIds: [], evidenceIds: [],
      });
      MemStore.insertFact({
        tenantId: TID, projectId: PID, competitorId: 'c-alpha', entityId: ent.entityId, entityVersionId: ver.versionId,
        entityType: 'brand_catalog', factType: type, valueNum: val, unit: null, currency: 'USD',
        measurementMethod: 'direct_observation', sourceKind: 'live_observation', sourceStatus: 'success',
        timePrecision: 'captured_only', observedAt: new Date().toISOString(), evidenceIds: [evA.evidence_id], snapshotIds: [snapA.snapshot_id],
      });
    }
  } catch (e) { /* 记忆事实缺失时价格维度仍应由 attempt 观察兜底 */ }
});

// ---------- O1 维度字段完整 ----------
test('O1 机会数据基础：每个维度带参与品牌数/观察数/时间范围/Evidence/状态/measurementMethod/限制', () => {
  const F = foundation();
  for (const key of ['price', 'catalog', 'dynamics', 'reviews', 'content', 'heat', 'ads']) {
    const d = F.dimensions[key];
    assert.ok(d, '维度存在: ' + key);
    assert.ok(typeof d.brandCount === 'number', key + ' 有参与品牌数');
    assert.ok(typeof d.observationCount === 'number', key + ' 有观察数量');
    assert.ok(typeof d.evidenceCount === 'number', key + ' 有 Evidence 数量');
    assert.ok(d.window && 'from' in d.window && 'to' in d.window, key + ' 有时间范围');
    assert.ok(typeof d.status === 'string' && d.status, key + ' 有状态');
    assert.ok(Array.isArray(d.limits), key + ' 有限制说明');
  }
  assert.strictEqual(F.dimensions.price.measurementMethod, 'direct_observation');
  assert.strictEqual(F.dimensions.reviews.measurementMethod, 'public_source_observation');
  assert.ok(F.dimensions.price.observationCount >= 8, '价格观察数来自真实采集: ' + F.dimensions.price.observationCount);
  assert.ok(F.dimensions.price.evidenceCount >= 2, 'Evidence 数真实: ' + F.dimensions.price.evidenceCount);
  assert.ok(F.dimensions.price.window.from && F.dimensions.price.window.to, '时间范围非空');
});

// ---------- O2 缺失不填 0 ----------
test('O2 缺失保持 null：无价格品牌不进价格分布；未接通维度标 not_configured', () => {
  const F = foundation();
  const rows = F.modules.priceBands.rows;
  const gamma = rows.find(r => r.competitorId === 'c-gamma');
  assert.ok(!gamma, '无价格品牌不进入价格行（不得以 0 价格参与分布）');
  const alpha = rows.find(r => r.competitorId === 'c-alpha');
  assert.strictEqual(alpha.priceMedian, 24.99, '有价格品牌中位数来自真实事实');
  for (const key of ['content', 'heat', 'ads']) {
    assert.strictEqual(F.dimensions[key].status, 'not_configured', key + ' 如实标未配置');
    assert.strictEqual(F.dimensions[key].observationCount, 0);
    assert.ok(F.dimensions[key].statusText, key + ' 有用户可读状态文案');
  }
  // 参与价格比较的品牌只含「币种已确认」的：alpha / beta / delta（gamma 无价格不进）
  assert.strictEqual(F.dimensions.price.brandCount, 3, '参与品牌数只算真有数据且币种已确认的品牌');
  assert.strictEqual(F.brandScope.total, 4, '品牌总数含无数据品牌');
});

// ---------- O3 满意度门槛 ----------
test('O3 满意度×重要性：样本不足不出图，且给出规定文案', () => {
  const s = foundation().modules.satisfactionScatter;
  assert.strictEqual(s.available, false, '无带评分样本 → 不出图');
  assert.strictEqual(s.reason, '当前评论样本不足，暂不生成满意度分布');
  assert.strictEqual(s.minObjects, 3);
  assert.strictEqual(s.comparableObjects, 0);
  assert.ok(Array.isArray(s.limits) && s.limits.length, '门槛说明随数据返回');
});

// ---------- O4 机会线索纪律 ----------
test('O4 机会线索：含事实/维度/样本量/时间范围/证据入口/限制/建议验证问题；禁经营结论词', () => {
  const F = foundation();
  assert.ok(F.opportunities.length > 0, '基于真实价格/商品事实生成线索');
  const FORBIDDEN = ['值得下注', '一定是机会', '无人满足', '市场空白', '保证', '必将'];
  for (const op of F.opportunities) {
    assert.ok(op.fact && op.fact.length > 10, '线索含事实');
    assert.ok(op.dimension, '线索含维度');
    assert.ok(op.sampleSize, '线索含样本量');
    assert.ok(op.window, '线索含时间范围');
    assert.ok(Array.isArray(op.evidenceRefs), '线索含证据入口数组');
    assert.ok(Array.isArray(op.limits) && op.limits.length, '线索含限制');
    assert.ok(op.question && op.question.length > 6, '线索含建议验证的问题');
    const blob = JSON.stringify(op);
    for (const w of FORBIDDEN) assert.ok(!blob.includes(w), '不得出现经营结论词: ' + w + ' in ' + op.title);
    assert.ok(!/\bGMV\b|ROI|转化率|用户画像/.test(blob), '不得出现无证据的经营指标');
  }
});

// ---------- O5 卡片短状态 ----------
test('O5 卡片短状态：历史失败→后续成功→已更新；有数据+最近失败→保留数据标 stale', () => {
  const byComp = {};
  for (const v of views()) byComp[v.competitorId] = v;
  assert.ok(byComp['c-alpha'], '品牌视图存在');
  assert.strictEqual(byComp['c-alpha'].status.code, 'updated', '成功采集 → 已更新');

  // c-beta：评论维度先失败（internal_error），同一维度后续成功 → 卡片回到已更新
  //（历史失败不得继续占据品牌卡片主状态 —— 测试服 native-pet/nulo 的真实场景）
  seedFailure('c-beta', 'public_reviews', 'reviews_reputation', 'internal_error', 'internal_error', 'old', Date.now() - 7200000);
  seedReviews('c-beta', { nowMs: Date.now() - 3600000, key: 'r2', observations: [{ id: 'bp1', title: 'Beta review page', price: null, currency: null, available: true, publishedAt: null, rating: null, reviewCount: null, sourceUrl: 'https://beta-sc12.example.com/reviews' }], evidenceIds: ['ev-beta-rev-1'] });
  const v2 = views().find(v => v.competitorId === 'c-beta');
  assert.strictEqual(v2.status.code, 'updated', '历史 internal_error + 后续成功 → 卡片为已更新');
  assert.ok(!/internal_error/.test(JSON.stringify(v2.status)), '卡片状态不泄漏内部码');

  // c-gamma：评论维度「先成功、后失败」→ 有历史数据但最近更新失败 → 数据保留 + 标 stale
  seedCatalog('c-gamma', [15, 25], { key: 'g1' });
  seedReviews('c-gamma', { nowMs: Date.now() - 7200000, key: 'r3', observations: [{ id: 'gp1', title: 'Gamma review page', price: null, currency: null, available: true, publishedAt: null, rating: null, reviewCount: null, sourceUrl: 'https://gamma-sc12.example.com/reviews' }], evidenceIds: ['ev-gamma-rev-1'], endedAt: new Date(Date.now() - 3600000).toISOString() });
  seedFailure('c-gamma', 'public_reviews', 'reviews_reputation', 'internal_error', 'internal_error', 'recent');
  const v3 = views().find(v => v.competitorId === 'c-gamma');
  assert.strictEqual(v3.status.code, 'stale', '有数据 + 最近失败 → 已有历史数据，最近更新失败');
  assert.strictEqual(v3.status.text, '已有历史数据，最近更新失败');
  const dim = v3.brandCoverage.dimensions.find(d => d.code === 'reviews_reputation');
  assert.strictEqual(dim.usingPreviousData, true, '维度标记保留历史数据');
});

// ---------- O6 失败分类映射（无内部词） ----------
test('O6 失败分类映射到短状态（来源拒绝/限流/不可达/解析失败），且无内部词', () => {
  for (const ss of ['blocked', 'rate_limited', 'unavailable', 'timeout', 'parse_failed', 'internal_error']) {
    seedFailure('c-gamma', 'official_site_profile', 'website_products', ss, ss, 'x-' + ss);
    const v = views().find(x => x.competitorId === 'c-gamma');
    const blob = JSON.stringify(v.status);
    assert.ok(!/internal_error|adapter_output_invalid|source_status|attempt/i.test(blob), '状态不含内部词: ' + blob);
    assert.ok(v.status.text && v.status.text.length <= 24, '状态文案短: ' + v.status.text);
  }
});

// ---------- O7 用户可见载荷不含内部失败码（SC-12 §三 红线） ----------
test('O7 品牌视图整份载荷不含 internal_error / adapter_output_invalid / source_status 等内部码', () => {
  seedFailure('c-delta', 'official_site_profile', 'website_products', 'internal_error', 'adapter_output_invalid', 'real-fail');
  seedFailure('c-epsilon', 'public_reviews', 'reviews_reputation', 'blocked', 'blocked', 'blocked-fail');
  const all = views();
  for (const v of all) {
    const blob = JSON.stringify(v);
    for (const w of ['internal_error', 'adapter_output_invalid', 'source_status', 'sourceStatus', 'error_class', 'errorClass', 'jobId', 'claimToken', 'attemptId']) {
      assert.ok(!blob.includes(w), '载荷不得出现内部码 ' + w + '：' + blob.slice(0, 200));
    }
    // 用户级失败种类仍必须存在（诊断需要），且取值必须是白名单
    for (const d of v.brandCoverage.dimensions) {
      if (d.failureKind) {
        assert.ok(['source_blocked', 'source_unreachable', 'source_rate_limited', 'source_parse_failed', 'source_output_incomplete', 'awaiting_config', 'needs_attention'].includes(d.failureKind),
          'failureKind 必须在用户级白名单内：' + d.failureKind);
      }
    }
    // attempt 内部标识不得出现（SC-12 §三 明令）
    assert.ok(!/'attemptId"/.test(blob), '载荷不得出现 attemptId 字段');
    assert.ok(!/\batt_[a-z0-9]{6,}/i.test(blob), '载荷不得出现 att_xxx 形式的 attempt 标识');
  }
});
