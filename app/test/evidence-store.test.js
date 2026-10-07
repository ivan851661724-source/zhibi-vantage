'use strict';
// ============================================================
// M0-02 Evidence Foundation 单测（任务书 §13 要求映射，20 用例）
// 隔离：ZB_DATA_DIR 指向临时目录（必须在 require 业务模块前设置）
// 零网络：直接经 Snapshot.record 落快照（纯 fs），无 fetch/dns stub 需求
// 规格锚点：/spec 00 v1.2 §1.5/§2/§2.1/§26/§37/§38/§42；02 v0.3 §3；
//           05 v0.3.1 §10/§19.6（SC-01）；06 v0.3 Traceability
// ============================================================
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

// ---- 隔离沙箱：必须在 require 业务模块之前设置 ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-m0-02-'));
process.env.ZB_DATA_DIR = TMP;

const Snapshot = require('../research/source-snapshot.js');
const Store = require('../research/evidence-store.js');
const Extract = require('../research/evidence-extract.js');
const legacyEvidence = require('../research/evidence.js');
const logger = require('../services/logger.js');

for (const k of ['debug', 'info', 'warn', 'error']) logger[k] = () => {};

const TA = 'tenant:m0ev-a';
const TB = 'tenant:m0ev-b';
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}

// ---- 造数助手 ----
const PRODUCTS_JSON = JSON.stringify({
  products: [
    { id: 9001, handle: 'fig-zero', title: 'SnapFig Zero', product_type: 'Figures',
      variants: [{ id: 11, title: 'Standard', price: '29.00' }, { id: 12, title: 'Deluxe', price: '49.50' }, { id: 13, title: 'Freebie', price: '0.00' }] },
    { id: 9002, handle: 'dodo-plush', title: 'DodoWish Plush', product_type: 'Plush',
      variants: [{ id: 21, title: 'S', price: '19.9' }, { id: 22, title: 'L', price: '39.9' }] },
    { id: 9003, handle: 'no-price', title: 'No Price Item', product_type: 'Misc', variants: [{ id: 31, title: 'X', price: '0' }] },
  ],
});
function recSnapshot(tenantId, opts) {
  const o = opts || {};
  const r = Snapshot.record({
    tenantId,
    capability: 'product_catalog',
    provider: 'shopify_products_json',
    source_url: 'https://example-shop.com/products.json?limit=100',
    source_status: o.status || 'success',
    error_code: o.error_code || null,
    observed_at: o.observed_at === undefined ? '2026-10-07T03:00:00.000Z' : o.observed_at,
    bodyBytes: o.body === undefined ? Buffer.from(PRODUCTS_JSON) : o.body,
    partial_scan: o.partial_scan == null ? null : o.partial_scan,
    partial_scan_reason: o.partial_scan_reason || null,
    partial_scan_observed_count: o.partial_scan_observed_count == null ? null : o.partial_scan_observed_count,
    note: o.note || null,
  });
  assert.equal(r.recorded, true, 'fixture snapshot must record');
  return r.meta;
}
const EXTRACT_ARGS = (tenantId, sid) => ({ tenantId, snapshotId: sid, entityRef: { brand_name: 'SnapFig', domain: 'example-shop.com' }, projectRef: 'proj-1' });

// ============ 1. 合法快照 → verified Evidence 创建 ============
t('1. Evidence created from valid persisted SourceSnapshot (verified price observation)', () => {
  const snap = recSnapshot(TA);
  const r = Store.recordEvidence({
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { price_min: 19.9, price_max: 49.5, prices: [{ variant_id: '21', price: 19.9 }] },
    evidence_status: 'verified', source: 'shopify', provider: 'shopify_products_json',
    entity_key: 'shopify_product:9001', entity_ref: { product_id: '9001' },
    currency: 'USD', observed_at: snap.observed_at,
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
  });
  assert.equal(r.recorded, true);
  assert.equal(r.duplicate, false);
  assert.ok(r.meta.evidence_id.startsWith('ev_'));
  assert.equal(r.meta.evidence_status, 'verified');
});

// ============ 2. Evidence ↔ SourceSnapshot 双向可查 ============
t('2. Evidence -> SourceSnapshot lookup succeeds (getById + findEvidenceBySnapshot)', () => {
  const snap = recSnapshot(TA);
  const r = Extract.extractShopifyPriceEvidence(EXTRACT_ARGS(TA, snap.snapshot_id));
  assert.equal(r.ok, true);
  assert.ok(r.evidence_ids.length >= 2); // 两款有价产品
  const byId = Store.getEvidenceById(TA, r.evidence_ids[0]);
  assert.ok(byId && byId.source_snapshot_ids.includes(snap.snapshot_id));
  const bySnap = Store.findEvidenceBySnapshot(TA, snap.snapshot_id);
  assert.equal(bySnap.length, r.evidence_ids.length);
  assert.ok(bySnap.every(m => m.source_snapshot_ids.includes(snap.snapshot_id)));
});

// ============ 3. Evidence → Snapshot → raw 原始字节全程可解析 ============
t('3. Evidence -> snapshot -> raw payload remains resolvable (provenance chain)', () => {
  const snap = recSnapshot(TA);
  const r = Extract.extractShopifyPriceEvidence(EXTRACT_ARGS(TA, snap.snapshot_id));
  const meta = Store.getEvidenceById(TA, r.evidence_ids[0]);
  const p = meta.provenance.snapshots[0];
  assert.equal(p.raw_resolvable, true);
  assert.equal(p.content_hash, snap.content_hash);
  const raw = Snapshot.readRawPayload(Snapshot.getById(TA, p.snapshot_id));
  assert.ok(Buffer.isBuffer(raw) && raw.length > 0);
  assert.equal(JSON.parse(raw.toString('utf8')).products.length, 3); // 与原始捕获字节对账
});

// ============ 4. Evidence 租户隔离 ============
t('4. Evidence tenant isolation (B cannot read A evidence)', () => {
  const snap = recSnapshot(TA);
  const r = Extract.extractShopifyPriceEvidence(EXTRACT_ARGS(TA, snap.snapshot_id));
  assert.equal(Store.getEvidenceById(TB, r.evidence_ids[0]), null);
  assert.deepEqual(Store.findEvidenceBySnapshot(TB, snap.snapshot_id), []);
});

// ============ 5. 不得引用他租户快照 ============
t('5. Evidence cannot reference another tenant snapshot (cross-tenant refused)', () => {
  const snapA = recSnapshot(TA);
  assert.throws(() => Store.recordEvidence({
    tenantId: TB, source_snapshot_ids: [snapA.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { x: 1 }, evidence_status: 'verified',
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
  }), /not resolvable in tenant scope/);
});

// ============ 6. 不存在的快照不得产证据级 Evidence ============
t('6. Missing/nonexistent snapshot cannot produce evidence-grade Evidence', () => {
  assert.throws(() => Store.recordEvidence({
    tenantId: TA, source_snapshot_ids: ['ss_product_catalog_missing_000'],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { x: 1 }, evidence_status: 'verified',
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
  }), /not resolvable in tenant scope/);
});

// ============ 7. 快照 raw 持久化失败不得成为有效溯源 ============
t('7. Snapshot raw persistence failure cannot become valid Evidence provenance', () => {
  const snap = recSnapshot(TA);
  const blob = path.join(TMP, snap.raw_payload_ref.path.replace(/\//g, path.sep));
  fs.unlinkSync(blob); // 模拟 raw 丢失（存储损坏）
  assert.throws(() => Store.recordEvidence({
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { price_min: 1 }, evidence_status: 'verified',
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
  }), /raw payload unresolvable/);
  const ex = Extract.extractShopifyPriceEvidence(EXTRACT_ARGS(TA, snap.snapshot_id));
  assert.equal(ex.ok, false);
  assert.equal(ex.reason, 'raw_unresolvable');
  assert.equal(Store.findEvidenceBySnapshot(TA, snap.snapshot_id).length, 0); // 未产证
});

// ============ 8. 同一提取重试不产生重复 Evidence ============
t('8. Retry of identical extraction does not duplicate Evidence (idempotent)', () => {
  const snap = recSnapshot(TA);
  const args = EXTRACT_ARGS(TA, snap.snapshot_id);
  const r1 = Extract.extractShopifyPriceEvidence(args);
  const dir = path.join(TMP, 'evidence', TA.replace(/[^a-z0-9_-]/gi, '_'));
  const countBefore = fs.readdirSync(dir).length;
  const r2 = Extract.extractShopifyPriceEvidence(args);
  assert.equal(r2.ok, true);
  assert.equal(r2.duplicate_count, r1.evidence_ids.length); // 全部命中既有
  assert.deepEqual(r2.evidence_ids.slice().sort(), r1.evidence_ids.slice().sort());
  assert.equal(fs.readdirSync(dir).length, countBefore); // 零新增文件
  const single = Store.recordEvidence({
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { price_min: 29, price_max: 29 }, evidence_status: 'verified',
    source: 'shopify', provider: 'shopify_products_json', entity_key: 'shopify_product:9001',
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
    observed_at: snap.observed_at,
  });
  assert.equal(single.duplicate, false);
  const retry = Store.recordEvidence(Object.assign({}, {
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { price_min: 29, price_max: 29 }, evidence_status: 'verified',
    source: 'shopify', provider: 'shopify_products_json', entity_key: 'shopify_product:9001',
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
    observed_at: snap.observed_at,
  }));
  assert.equal(retry.duplicate, true);
  assert.equal(retry.meta.evidence_id, single.meta.evidence_id); // 确定性 id
});

// ============ 9. 不同 parser 版本 → 独立新记录，旧记录不可变 ============
t('9. Different parser version creates distinct Evidence; previous record untouched', () => {
  const snap = recSnapshot(TA);
  const base = {
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { price_min: 29, price_max: 29 }, evidence_status: 'verified',
    source: 'shopify', provider: 'shopify_products_json', entity_key: 'shopify_product:9001',
    extractor_version: Extract.EXTRACTOR_VERSION, observed_at: snap.observed_at,
  };
  const v1 = Store.recordEvidence(Object.assign({}, base, { parser_version: 'shopify-products-json-1' }));
  const v1Before = JSON.stringify(v1.meta);
  const v2 = Store.recordEvidence(Object.assign({}, base, { parser_version: 'shopify-products-json-2' }));
  assert.equal(v2.duplicate, false);
  assert.notEqual(v2.meta.evidence_id, v1.meta.evidence_id);
  assert.equal(JSON.stringify(Store.getEvidenceById(TA, v1.meta.evidence_id)), v1Before); // 旧记录逐字节不变
  assert.equal(v2.meta.parser_version, 'shopify-products-json-2');
});

// ============ 10. EvidenceStatus 只收冻结四值 ============
t('10. EvidenceStatus accepts only frozen values; unavailable requires frozen reason_code', () => {
  const snap = recSnapshot(TA);
  const base = {
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
  };
  assert.throws(() => Store.recordEvidence(Object.assign({}, base, { evidence_status: 'confirmed', extracted_value: { x: 1 } })), /invalid evidence_status/);
  assert.throws(() => Store.recordEvidence(Object.assign({}, base, { evidence_status: 'partially_verified', extracted_value: { x: 1 } })), /invalid evidence_status/);
  assert.throws(() => Store.recordEvidence(Object.assign({}, base, { evidence_status: 'unavailable' })), /requires frozen reason_code/); // 无 reason_code
  assert.throws(() => Store.recordEvidence(Object.assign({}, base, { evidence_status: 'unavailable', reason_code: 'kind_of_failed' })), /requires frozen reason_code/);
  assert.throws(() => Store.recordEvidence(Object.assign({}, base, { evidence_status: 'unavailable', reason_code: 'timeout' })), /requires frozen reason_code/);       // P0-3：未冻结枚举拒绝
  assert.throws(() => Store.recordEvidence(Object.assign({}, base, { evidence_status: 'unavailable', reason_code: 'internal_error' })), /requires frozen reason_code/); // P0-3：同上
  assert.throws(() => Store.recordEvidence(Object.assign({}, base, { evidence_status: 'verified', reason_code: 'fetch_failed', extracted_value: { x: 1 } })), /unavailable-only/);
});

// ============ 11. status / strength / quality 三正交 ============
t('11. evidence_status, evidence_strength, source_quality remain separate fields', () => {
  const snap = recSnapshot(TA);
  const r = Store.recordEvidence({
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { price_min: 29 }, evidence_status: 'verified',
    evidence_strength: 'high', source_quality: 'tier1_source',
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
    observed_at: snap.observed_at,
  });
  const meta = Store.getEvidenceById(TA, r.meta.evidence_id);
  assert.equal(meta.evidence_status, 'verified');          // 语义状态
  assert.equal(meta.evidence_strength, 'high');            // 独立维度，显式传才落值
  assert.equal(meta.source_quality, 'tier1_source');       // 独立维度
  const r2 = Store.recordEvidence({
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { price_min: 39 }, evidence_status: 'verified',
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
    observed_at: snap.observed_at,
  });
  const meta2 = Store.getEvidenceById(TA, r2.meta.evidence_id);
  assert.equal(meta2.evidence_strength, null);             // 不传不推导（≠ 从 status 派生）
  assert.equal(meta2.source_quality, null);
  assert.notEqual(meta2.evidence_status, meta2.evidence_strength);
  assert.notEqual(meta2.evidence_status, meta2.source_quality);
});

// ============ 12. 禁止 legacy basis → EvidenceStatus 机械映射 ============
t('12. No automatic legacy basis -> EvidenceStatus mapping', () => {
  const snap = recSnapshot(TA);
  const r = Store.recordEvidence({
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { price_min: 29 }, evidence_status: 'verified',
    basis: 'inferred',   // legacy 语义混入：必须被忽略，不得映射/不得改写 status
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
    observed_at: snap.observed_at,
  });
  const meta = Store.getEvidenceById(TA, r.meta.evidence_id);
  assert.equal(meta.evidence_status, 'verified');            // 未被 basis=inferred 改写为 derived
  assert.equal('basis' in meta, false);                       // 一级模型不收编 legacy basis
  // legacy 层语义原样保留（兼容不迁移）
  const d = legacyEvidence.deriveBasis([{ tier: 2, url: 'https://reddit.com/x' }]);
  assert.equal(d.basis, 'inferred');                          // legacy deriveBasis 行为不变
  assert.deepEqual(Object.keys(legacyEvidence).sort(), ['belongsToBrand', 'deriveBasis', 'sourceTier']);
});

// ============ 13. 失败态快照 → unavailable Evidence（≠ verified 业务值） ============
t('13. Failed SourceStatus produces unavailable Evidence, never a verified business value (P0-3: timeout/internal_error -> fetch_failed, detail kept in provenance)', () => {
  const cases = [
    { status: 'unavailable', reason: 'fetch_failed' },
    { status: 'blocked', reason: 'blocked' },
    { status: 'rate_limited', reason: 'rate_limited' },
    { status: 'timeout', reason: 'fetch_failed' },          // P0-3：枚举收口，不私自扩充
    { status: 'internal_error', reason: 'fetch_failed' },   // P0-3：同上
    { status: 'parse_failed', reason: 'parse_failed' },
  ];
  for (const c of cases) {
    const snap = recSnapshot(TA, { status: c.status, observed_at: null, body: null, error_code: 'http:' + c.status });
    const r = Extract.extractShopifyPriceEvidence(EXTRACT_ARGS(TA, snap.snapshot_id));
    assert.equal(r.ok, true, c.status);
    assert.equal(r.unavailable, true, c.status);
    const meta = Store.getEvidenceById(TA, r.evidence_ids[0]);
    assert.equal(meta.evidence_status, 'unavailable', c.status);
    assert.equal(meta.reason_code, c.reason, c.status);
    assert.equal(meta.extracted_value, null, c.status);        // 绝不从失败编造值
    assert.equal(meta.observed_at, null, c.status);            // retrieval 前失败如实 null
    // P0-3：底层失败细节经 provenance 保留（不丢失 timeout/internal_error 事实）
    assert.equal(meta.provenance.snapshots[0].source_status, c.status, c.status + ' detail preserved in provenance');
    assert.ok(/source_status=/.test(meta.note) && /error_code|error=/.test(meta.note), c.status + ' error detail in note');
  }
});

// ============ 14. Shopify 公开价格观察：$0 如实保留、币种诚实缺失、禁 AOV 语义 ============
t('14. Price Evidence preserves source-observed values incl. $0; currency null without snapshot backing (P0-1); never AOV', () => {
  const snap = recSnapshot(TA);
  const r = Extract.extractShopifyPriceEvidence(EXTRACT_ARGS(TA, snap.snapshot_id));
  assert.equal(r.ok, true);
  const all = r.evidence_ids.map(id => Store.getEvidenceById(TA, id));
  const fig = all.find(m => m.entity_ref.product_id === '9001');
  // P1-1：$0 变体（variant 13 免费品）如实保留——业务过滤归后续阶段
  assert.equal(fig.extracted_value.prices.length, 3);
  assert.equal(fig.extracted_value.prices[2].variant_id, '13');
  assert.equal(fig.extracted_value.prices[2].price, 0);
  assert.equal(fig.extracted_value.price_min, 0);      // 含 $0 的真实观察下限
  assert.equal(fig.extracted_value.price_max, 49.5);
  assert.equal(fig.currency, null);                     // P0-1：cart.js 币种无快照背书 → 诚实缺失
  assert.equal(fig.claim.scope, 'public_price_observation');
  assert.equal(fig.claim.field, 'product.price');
  assert.equal(fig.entity_ref.handle, 'fig-zero');      // 来源原生标识保留
  assert.equal(fig.source, 'shopify');
  const plush = all.find(m => m.entity_ref.product_id === '9002');
  assert.equal(plush.extracted_value.price_min, 19.9);
  const noPrice = all.find(m => m.entity_ref.product_id === '9003'); // P1-1：仅 $0 变体的产品也产证
  assert.ok(noPrice, 'zero-only product must still produce observation');
  assert.equal(noPrice.extracted_value.price_min, 0);
  assert.equal(noPrice.extracted_value.price_max, 0);
  assert.equal(noPrice.extracted_value.prices.length, 1);
  for (const m of all) assert.equal(/aov/i.test(JSON.stringify(m)), false); // 禁 AOV 语义
});

// ============ 15. SC-01：结构化 Evidence 层版本必填且不冒充 ============
t('15. parser/extractor version non-null for structured Evidence, never copies collector_version', () => {
  const snap = recSnapshot(TA);
  const r = Extract.extractShopifyPriceEvidence(EXTRACT_ARGS(TA, snap.snapshot_id));
  const meta = Store.getEvidenceById(TA, r.evidence_ids[0]);
  assert.ok(meta.parser_version && typeof meta.parser_version === 'string');
  assert.ok(meta.extractor_version && typeof meta.extractor_version === 'string');
  assert.equal(meta.parser_version, 'shopify-products-json-1');
  assert.equal(meta.extractor_version, 'evidence-extract-1');
  assert.notEqual(meta.parser_version, meta.collector_version);   // 不复制 collector_version
  assert.equal(meta.collector_version, 'net-1');                  // 溯源透传
  assert.throws(() => Store.recordEvidence({                     // 显式冒充 → 拒绝
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { x: 1 }, evidence_status: 'verified',
    parser_version: 'net-1', extractor_version: Extract.EXTRACTOR_VERSION,
  }), /must not copy collector_version/);
  assert.throws(() => Store.recordEvidence({                     // 缺 parser_version → 拒绝
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { x: 1 }, evidence_status: 'verified',
    extractor_version: Extract.EXTRACTOR_VERSION,
  }), /parser_version is required/);
});

// ============ 16. partial_scan 快照仍可产 per-product 价格观察（诚实标注） ============
t('16. partial_scan snapshot yields verified per-product observation with honest provenance', () => {
  const snap = recSnapshot(TA, { status: 'partial', partial_scan: true, partial_scan_reason: 'products_json_first_page_limit_100_pagination_pending_m0_04', partial_scan_observed_count: 100 });
  const r = Extract.extractShopifyPriceEvidence(EXTRACT_ARGS(TA, snap.snapshot_id));
  assert.equal(r.ok, true);
  const meta = Store.getEvidenceById(TA, r.evidence_ids[0]);
  assert.equal(meta.evidence_status, 'verified');               // 单品价格观察本身为真
  assert.equal(meta.provenance.snapshots[0].source_status, 'partial');
  assert.equal(meta.provenance.snapshots[0].partial_scan, true); // 枚举不完整如实入 provenance
  assert.ok(/partial_scan/.test(meta.note));
});

// ============ 17. legacy evidence 层兼容（零改动、零迁移） ============
t('17. Legacy evidence helpers remain compatible and untouched', () => {
  assert.equal(legacyEvidence.sourceTier('https://example.com', 'example.com'), 1);
  assert.equal(legacyEvidence.sourceTier('https://pinterest.com/x', ''), 3);
  assert.equal(legacyEvidence.belongsToBrand({ url: 'https://example.com/a' }, 'any', 'example.com'), true);
  const hi = legacyEvidence.deriveBasis([{ tier: 1, url: 'https://x.com' }]);
  assert.deepEqual(hi, { basis: 'verified', confidence: 'high' });
  assert.equal(fs.existsSync(path.join(TMP, 'evidence', TA.replace(/[^a-z0-9_-]/gi, '_'))), true); // 新旧并存互不干扰
});

// ============ 18. 零 LLM / 零网络引入 ============
t('18. No new LLM call or network call introduced in Evidence layer', () => {
  for (const f of ['evidence-store.js', 'evidence-extract.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'research', f), 'utf8');
    assert.equal(/require\([^)]*llm/i.test(src), false, f + ' must not require llm');
    assert.equal(/\bfetch\s*\(/.test(src), false, f + ' must not call fetch');
    assert.equal(/https?:\/\//.test(src.replace(/\/\/[^\n]*/g, '')), false, f + ' must not embed endpoint URLs');
  }
});

// ============ 19. 多快照引用 + algorithm/config_version 字段 ============
t('19. Multi-snapshot reference supported; algorithm_version/config_version retained as explicit nulls', () => {
  const s1 = recSnapshot(TA);
  const s2 = recSnapshot(TA, { body: Buffer.from(PRODUCTS_JSON.replace('49.50', '45.00')) });
  const r = Store.recordEvidence({
    tenantId: TA, source_snapshot_ids: [s1.snapshot_id, s2.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { price_min: 29 }, evidence_status: 'verified',
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
    observed_at: s1.observed_at,
  });
  const meta = Store.getEvidenceById(TA, r.meta.evidence_id);
  assert.equal(meta.provenance.snapshots.length, 2);
  assert.equal(meta.collector_version, null); // 多快照不归属单一 collector（不伪造归属）
  assert.equal(meta.algorithm_version, null); // M0-02 无算法层，显式 null
  assert.equal(meta.config_version, null);
});

// ============ 20. 缺租户上下文拒绝产证 + 提取层快照缺失诚实报因 ============
t('20. No tenant context refuses evidence; missing snapshot reports honestly', () => {
  const r = Store.recordEvidence({
    source_snapshot_ids: ['ss_x'], claim: { field: 'product.price', scope: 's' },
    extracted_value: { x: 1 }, evidence_status: 'verified',
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
  }); // 无显式租户 + 无 ALS
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'no_tenant_context');
  const ex = Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: 'ss_product_catalog_ghost_1' });
  assert.equal(ex.ok, false);
  assert.equal(ex.reason, 'snapshot_not_found');
  const exBad = Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: 'ss_x', currency: 'USD' });
  assert.equal(exBad.ok, false); // 非法快照 id 同样诚实报因
});

// ============ 21. P0-2：完整语义身份幂等——语义不同绝不坍缩 ============
t('21. Canonical semantic idempotency: identical->duplicate; currency/scope/status-reason/version differences->distinct', () => {
  const snap = recSnapshot(TA);
  const base = {
    tenantId: TA, source_snapshot_ids: [snap.snapshot_id],
    source: 'shopify', provider: 'shopify_products_json',
    claim: { field: 'product.price', scope: 'public_price_observation' },
    extracted_value: { price_min: 29, price_max: 29 }, evidence_status: 'verified',
    entity_key: 'shopify_product:9001',
    parser_version: Extract.PARSER_VERSION, extractor_version: Extract.EXTRACTOR_VERSION,
    observed_at: snap.observed_at,
  };
  const first = Store.recordEvidence(base);
  assert.equal(first.duplicate, false);
  // 同语义重试 → duplicate（完整身份一致）
  assert.equal(Store.recordEvidence(Object.assign({}, base)).duplicate, true);
  // USD vs EUR → 不同身份（P0-2 要求；币种差异不得坍缩）
  const eur = Store.recordEvidence(Object.assign({}, base, { currency: 'EUR' }));
  assert.equal(eur.duplicate, false);
  assert.notEqual(eur.meta.evidence_id, first.meta.evidence_id);
  // claim.scope 不同 → 不同身份
  const scoped = Store.recordEvidence(Object.assign({}, base, { claim: { field: 'product.price', scope: 'promo_price_observation' } }));
  assert.equal(scoped.duplicate, false);
  assert.notEqual(scoped.meta.evidence_id, first.meta.evidence_id);
  // EvidenceStatus / reason 语义不同 → 不同身份
  const unavail = Store.recordEvidence(Object.assign({}, base, { evidence_status: 'unavailable', reason_code: 'fetch_failed', extracted_value: null }));
  assert.equal(unavail.duplicate, false);
  assert.notEqual(unavail.meta.evidence_id, first.meta.evidence_id);
  // parser/extractor 版本不同 → 不同身份（回归 T9 语义，纳入统一身份断言）
  const v2 = Store.recordEvidence(Object.assign({}, base, { parser_version: 'shopify-products-json-2' }));
  assert.equal(v2.duplicate, false);
  assert.notEqual(v2.meta.evidence_id, first.meta.evidence_id);
  // market / unit / source / provider 差异同样进身份
  const mk = Store.recordEvidence(Object.assign({}, base, { market: 'US' }));
  assert.notEqual(mk.meta.evidence_id, first.meta.evidence_id);
  const src = Store.recordEvidence(Object.assign({}, base, { source: 'other' }));
  assert.notEqual(src.meta.evidence_id, first.meta.evidence_id);
  // 禁止任意覆盖身份：meta.idempotency_key 必与规范导出一致（无 override 通道）
  const canonical = Store.buildIdempotencyKey({
    tenantId: TA, sourceSnapshotIds: [snap.snapshot_id], source: 'shopify', provider: 'shopify_products_json',
    claim: base.claim, entityKey: base.entity_key,
    valueDigest: Store.stableStringify(base.extracted_value), // 直接以稳定串作摘要输入与内部 sha256 口径一致性不跨越——此处仅验证导出存在
    unit: null, currency: null, market: null,
    evidenceStatus: 'verified', reasonCode: null,
    parserVersion: Extract.PARSER_VERSION, extractorVersion: Extract.EXTRACTOR_VERSION,
  });
  assert.ok(/^[0-9a-f]{64}$/.test(canonical));
  const dupAgain = Store.recordEvidence(Object.assign({}, base, { idempotency_key: 'attacker-chosen-key' }));
  assert.equal(dupAgain.duplicate, true); // 传入未知键不影响身份：仍按语义命中既有记录
  assert.equal(dupAgain.meta.idempotency_key, first.meta.idempotency_key); // 身份未被覆盖
});

// ============ 22. P1-2：快照集合身份校验——非 Shopify 快照不得产 Shopify 价格证据 ============
t('22. Non-Shopify snapshot must not produce Shopify price Evidence (snapshot_source_mismatch)', () => {
  const webSnap = Snapshot.record({
    tenantId: TA, capability: 'evidence_url', provider: 'generic_web_fetch',
    source_url: 'https://example-shop.com/', source_status: 'success',
    observed_at: '2026-10-07T03:00:00.000Z', bodyBytes: Buffer.from('<html>not a products.json</html>'),
  });
  assert.equal(webSnap.recorded, true);
  const r = Extract.extractShopifyPriceEvidence(EXTRACT_ARGS(TA, webSnap.meta.snapshot_id));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'snapshot_source_mismatch');   // 内部提取失败，非新 EvidenceStatus/reason_code
  assert.equal(Store.findEvidenceBySnapshot(TA, webSnap.meta.snapshot_id).length, 0); // 零 Evidence 产出
});

// ============ 23. P1-3：computed_at 必填且为合法 ISO（00 §8 可回算要求） ============
t('23. computed_at present and valid ISO timestamp; algorithm/config_version remain explicit nulls', () => {
  const snap = recSnapshot(TA);
  const r = Extract.extractShopifyPriceEvidence(EXTRACT_ARGS(TA, snap.snapshot_id));
  const meta = Store.getEvidenceById(TA, r.evidence_ids[0]);
  assert.ok(typeof meta.computed_at === 'string' && meta.computed_at.length > 0, 'computed_at present');
  assert.ok(!isNaN(Date.parse(meta.computed_at)), 'computed_at is valid ISO');
  assert.equal(meta.algorithm_version, null); // M0-02 无算法层（00 §8 保留显式 null）
  assert.equal(meta.config_version, null);
});

// ============ 汇总 ============
console.log(`\nevidence-store.test: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
