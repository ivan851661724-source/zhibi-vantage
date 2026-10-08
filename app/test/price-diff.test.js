'use strict';
// ============================================================
// M0-04 Minimal Diff 单测（Stage 2 验收映射）
//   product.price 比较两次 Fact：39→29=changed；39→39=no_meaningful_change；
//   39→unavailable=unavailable/degraded；fetch_failed 绝不 → no_change
// 隔离：ZB_DATA_DIR 临时目录；零网络
// 规格锚点：00 v1.2 §5/§37/§42/§50；02 v0.3 §10.1/§1 原则 5；03 v0.3 §17
// ============================================================
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-m0-04-'));
process.env.ZB_DATA_DIR = TMP;

const Snapshot = require('../research/source-snapshot.js');
const Extract = require('../research/evidence-extract.js');
const FactStore = require('../research/fact-store.js');
const Diff = require('../research/price-diff.js');
const logger = require('../services/logger.js');

for (const k of ['debug', 'info', 'warn', 'error']) logger[k] = () => {};

const TA = 'tenant:m0diff-a';
const TB = 'tenant:m0diff-b';
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}

// ---- 造数助手：两个观察窗口的 products.json（Demo Product 39 → 29）----
const PRODUCTS_A = JSON.stringify({
  products: [
    { id: 1, handle: 'demo-product', title: 'Demo Product', product_type: 'Figures',
      variants: [{ id: 11, title: 'Standard', price: '39.00' }] },
  ],
});
const PRODUCTS_B = JSON.stringify({
  products: [
    { id: 1, handle: 'demo-product', title: 'Demo Product', product_type: 'Figures',
      variants: [{ id: 11, title: 'Standard', price: '29.00' }] },
  ],
});
const PRODUCTS_SAME = PRODUCTS_A;

function recScan(tenantId, body, observedAt, status) {
  const r = Snapshot.record({
    tenantId,
    capability: 'product_catalog',
    provider: 'shopify_products_json',
    source_url: 'https://example-shop.com/products.json?limit=100',
    source_status: status || 'success',
    error_code: null,
    observed_at: observedAt,
    bodyBytes: body === undefined ? null : Buffer.from(body),
    partial_scan: null, partial_scan_reason: null, partial_scan_observed_count: null,
    note: null,
  });
  assert.equal(r.recorded, true, 'fixture snapshot must record');
  return r.meta;
}
function factFromScan(tenantId, body, observedAt) {
  const snap = recScan(tenantId, body, observedAt);
  const evRes = Extract.extractShopifyPriceEvidence({ tenantId, snapshotId: snap.snapshot_id });
  assert.equal(evRes.ok, true && !evRes.unavailable, 'verified evidence expected');
  const fr = FactStore.recordPriceFactFromEvidence({ tenantId, evidenceId: evRes.evidence_ids[0] });
  assert.equal(fr.recorded, true);
  return fr.meta;
}

// ============ 1. 39 → 29 = changed（降价，delta/pct 确定性） ============
t('1. 39 -> 29 = changed (decrease, delta=-10, pct=-25.64)', () => {
  const fA = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');
  const fB = factFromScan(TA, PRODUCTS_B, '2026-10-07T11:00:00.000Z');
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r.recorded, true);
  assert.equal(r.meta.status, 'changed');
  assert.equal(r.meta.direction, 'decrease');
  assert.equal(r.meta.old_value.price_min, 39);
  assert.equal(r.meta.new_value.price_min, 29);
  assert.equal(r.meta.delta, -10);
  assert.equal(r.meta.pct, -25.641);   // (29-39)/39*100 = -25.6410…，4 位小数
  assert.equal(r.meta.observed_at_old, '2026-10-07T09:00:00.000Z');
  assert.equal(r.meta.observed_at_new, '2026-10-07T11:00:00.000Z');
});

// ============ 2. 39 → 39 = no_meaningful_change ============
t('2. 39 -> 39 = no_meaningful_change (no event material)', () => {
  const fA = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');
  const fB = factFromScan(TA, PRODUCTS_SAME, '2026-10-07T11:00:00.000Z');
  assert.notEqual(fA.fact_id, fB.fact_id); // 不同观察 → 不同 Fact（历史不可变）
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r.recorded, true);
  assert.equal(r.meta.status, 'no_meaningful_change');
  assert.equal(r.meta.direction, null);
  assert.equal(r.meta.delta, null);
});

// ============ 3. 39 → unavailable = unavailable/degraded ============
t('3. 39 -> unavailable = unavailable diff (degraded, new_value null)', () => {
  const fA = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');
  // 新观察：快照失败态 → unavailable Evidence → 无价格 Fact
  const badSnap = recScan(TA, undefined, '2026-10-07T11:00:00.000Z', 'rate_limited');
  const evRes = Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: badSnap.snapshot_id });
  assert.equal(evRes.unavailable, true);
  const fr = FactStore.recordPriceFactFromEvidence({ tenantId: TA, evidenceId: evRes.evidence_ids[0] });
  assert.equal(fr.recorded, false);
  assert.equal(fr.reason, 'evidence_unavailable');
  // 正确路径：产 unavailable Diff，绝不做 no_change
  const r = Diff.diffPriceFactWithUnavailableObservation({ tenantId: TA, oldFactId: fA.fact_id, newObservation: 'unavailable', reason: 'evidence_unavailable' });
  assert.equal(r.recorded, true);
  assert.equal(r.meta.status, 'unavailable');
  assert.equal(r.meta.new_value, null);          // unavailable ≠ 0
  assert.equal(r.meta.old_value.price_min, 39);
  assert.equal(r.meta.reason, 'evidence_unavailable');
});

// ============ 4. fetch_failed 绝不 → no_change ============
t('4. fetch_failed detail preserved; NEVER no_meaningful_change', () => {
  const fA = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');
  const r = Diff.diffPriceFactWithUnavailableObservation({ tenantId: TA, oldFactId: fA.fact_id, newObservation: 'unavailable', reason: 'fetch_failed' });
  assert.equal(r.recorded, true);
  assert.equal(r.meta.status, 'unavailable');                  // 不是 no_meaningful_change
  assert.notEqual(r.meta.status, 'no_meaningful_change');
  assert.equal(r.meta.reason_detail, 'fetch_failed');          // 失败细节原样保留不吞
});

// ============ 5. 不可比 → unavailable + 显式 reason（不当 no_change） ============
t('5. Not comparable (entity/claim/currency mismatch) -> unavailable with explicit reason', () => {
  const fA = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');
  // currency 不同的另一张 Fact（手工造：真实路径 currency 恒 null）
  const fdir = path.join(TMP, 'facts', 'tenant_m0diff-a');
  const fCur = JSON.parse(JSON.stringify(fA));
  fCur.fact_id = 'fact_curnew0000000000test';
  fCur.currency = 'EUR';
  fCur.idempotency_key = 'test-currency';
  fs.writeFileSync(path.join(fdir, fCur.fact_id + '.json'), JSON.stringify(fCur));
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fCur.fact_id });
  assert.equal(r.recorded, true);
  assert.equal(r.meta.status, 'unavailable');                  // currency change 绝不当 price change
  assert.equal(r.meta.reason, 'currency_mismatch');
});

// ============ 6. 实体/claim 错配拒绝 ============
t('6. Entity/claim mismatch -> unavailable with explicit reason', () => {
  const fA = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');
  const fdir = path.join(TMP, 'facts', 'tenant_m0diff-a');
  const mk = (fid, patch) => {
    const m = JSON.parse(JSON.stringify(fA));
    m.fact_id = fid; m.idempotency_key = 'k-' + fid;
    Object.assign(m, patch);
    fs.writeFileSync(path.join(fdir, fid + '.json'), JSON.stringify(m));
    return fid;
  };
  const fEnt = mk('fact_entmis0000000test', { entity_key: 'shopify_product:999' });
  const rEnt = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fEnt });
  assert.equal(rEnt.meta.status, 'unavailable');
  assert.equal(rEnt.meta.reason, 'entity_key_mismatch');
  const fClm = mk('fact_clmmis0000000test', { claim: { field: 'product.rating', scope: 'other' } });
  const rClm = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fClm });
  assert.equal(rClm.meta.status, 'unavailable');
  assert.equal(rClm.meta.reason, 'claim_mismatch');
});

// ============ 7. 幂等重试零重复 ============
t('7. Idempotent retry: same fact pair -> duplicate:true, zero new files', () => {
  const fA = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');
  const fB = factFromScan(TA, PRODUCTS_B, '2026-10-07T11:00:00.000Z');
  const r1 = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  const dir = path.join(TMP, 'diffs', 'tenant_m0diff-a');
  const before = fs.readdirSync(dir).length;
  const r2 = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r2.duplicate, true);
  assert.equal(r2.meta.diff_id, r1.meta.diff_id);
  assert.equal(fs.readdirSync(dir).length, before);
});

// ============ 8. 租户隔离 ============
t('8. Tenant isolation: facts of A invisible to B', () => {
  const fA = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');
  const rB = Diff.diffPriceFacts({ tenantId: TB, oldFactId: fA.fact_id, newFactId: fA.fact_id });
  assert.equal(rB.recorded, false);
  assert.equal(rB.reason, 'fact_not_found');
  const fB = factFromScan(TB, PRODUCTS_B, '2026-10-07T11:00:00.000Z');
  const rNoTenant = Diff.diffPriceFacts({ tenantId: null, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(rNoTenant.reason, 'no_tenant_context');
});

// ============ 9. Diff → Fact → Evidence 全链引用完整 ============
t('9. Diff carries full traceability fields (fact/evidence/snapshot ids + timestamps)', () => {
  const fA = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');
  const fB = factFromScan(TA, PRODUCTS_B, '2026-10-07T11:00:00.000Z');
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  const m = r.meta;
  assert.equal(m.old_fact_id, fA.fact_id);
  assert.equal(m.new_fact_id, fB.fact_id);
  assert.deepEqual(m.old_evidence_ids, fA.evidence_ids);
  assert.deepEqual(m.new_evidence_ids, fB.evidence_ids);
  assert.deepEqual(m.old_snapshot_ids, fA.source_snapshot_ids);
  assert.deepEqual(m.new_snapshot_ids, fB.source_snapshot_ids);
  assert.ok(m.old_evidence_ids.length >= 1 && m.new_evidence_ids.length >= 1);
  assert.ok(m.diff_type === 'product.price' && m.derivation_version === 'price-diff-1');
  assert.equal(m.algorithm_version, null);
  assert.equal(m.config_version, null);
  assert.ok(m.computed_at && !Number.isNaN(Date.parse(m.computed_at)));
});

// ============ 10. 涨价方向 ============
t('10. 29 -> 39 = changed (increase)', () => {
  const fA = factFromScan(TA, PRODUCTS_B, '2026-10-07T09:00:00.000Z');
  const fB = factFromScan(TA, PRODUCTS_A, '2026-10-07T11:00:00.000Z');
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r.meta.status, 'changed');
  assert.equal(r.meta.direction, 'increase');
  assert.equal(r.meta.delta, 10);
  assert.equal(r.meta.pct, 34.4828);   // (39-29)/29*100，4 位小数
});

// ============ 11. 同 Fact 自比 = no_meaningful_change ============
t('11. Same fact compared with itself = no_meaningful_change', () => {
  const fA = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fA.fact_id });
  assert.equal(r.meta.status, 'no_meaningful_change');
});

// ============ 12. min 相同但 max 变 → changed（方向按 max，P1 修复后口径） ============
t('12. price_min equal, price_max up -> changed, direction by max (increase, delta=+10)', () => {
  const fA = factFromScan(TA, JSON.stringify({ products: [{ id: 1, handle: 'p', title: 'P', variants: [{ id: 1, title: 'a', price: '29' }, { id: 2, title: 'b', price: '49' }] }] }), '2026-10-07T09:00:00.000Z');
  const fB = factFromScan(TA, JSON.stringify({ products: [{ id: 1, handle: 'p', title: 'P', variants: [{ id: 1, title: 'a', price: '29' }, { id: 2, title: 'b', price: '59' }] }] }), '2026-10-07T11:00:00.000Z');
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r.meta.status, 'changed');
  assert.equal(r.meta.direction, 'increase');   // min 不变、max 上调 → increase（按 max 判定）
  assert.equal(r.meta.delta, 10);               // 变化边界差（max：59-49）
  assert.equal(r.meta.pct, 20.4082);            // 10/49*100 = 20.4082…（按 max 基准）
});

// ============ 12b-12h. P1 方向规则全场景（最终代码审核整改验收） ============
// 场景工厂：两观察窗口，变体价决定 price_min/price_max
function rangeFromScan(tenantId, lo, hi, observedAt) {
  const body = JSON.stringify({ products: [{ id: 1, handle: 'p', title: 'P', variants: [
    { id: 1, title: 'a', price: String(lo) }, { id: 2, title: 'b', price: String(hi) },
  ] }] });
  return factFromScan(tenantId, body, observedAt);
}
t('12b. 10-20 -> 10-15: min unchanged, max down -> decrease, delta=-5, pct=-25 (P0 repro, was "increase 0%")', () => {
  const fA = rangeFromScan(TA, 10, 20, '2026-10-07T09:00:00.000Z');
  const fB = rangeFromScan(TA, 10, 15, '2026-10-07T11:00:00.000Z');
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r.meta.status, 'changed');
  assert.equal(r.meta.direction, 'decrease');
  assert.equal(r.meta.delta, -5);
  assert.equal(r.meta.pct, -25);
  assert.notEqual(r.meta.direction + ' ' + r.meta.pct, 'increase 0', '绝不产生「上涨 0%」');
});
t('12c. 10-20 -> 10-25: min unchanged, max up -> increase, delta=+5, pct=+25', () => {
  const fA = rangeFromScan(TA, 10, 20, '2026-10-07T09:00:00.000Z');
  const fB = rangeFromScan(TA, 10, 25, '2026-10-07T11:00:00.000Z');
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r.meta.status, 'changed');
  assert.equal(r.meta.direction, 'increase');
  assert.equal(r.meta.delta, 5);
  assert.equal(r.meta.pct, 25);
});
t('12d. 10-20 -> 12-20: max unchanged, min up -> increase, delta=+2, pct=+20', () => {
  const fA = rangeFromScan(TA, 10, 20, '2026-10-07T09:00:00.000Z');
  const fB = rangeFromScan(TA, 12, 20, '2026-10-07T11:00:00.000Z');
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r.meta.direction, 'increase');
  assert.equal(r.meta.delta, 2);
  assert.equal(r.meta.pct, 20);
});
t('12e. 10-20 -> 8-20: max unchanged, min down -> decrease, delta=-2, pct=-20', () => {
  const fA = rangeFromScan(TA, 10, 20, '2026-10-07T09:00:00.000Z');
  const fB = rangeFromScan(TA, 8, 20, '2026-10-07T11:00:00.000Z');
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r.meta.direction, 'decrease');
  assert.equal(r.meta.delta, -2);
  assert.equal(r.meta.pct, -20);
});
t('12f. 10-20 -> 8-25: both bounds move in opposite directions -> mixed, direction/delta/pct all null (honest)', () => {
  const fA = rangeFromScan(TA, 10, 20, '2026-10-07T09:00:00.000Z');
  const fB = rangeFromScan(TA, 8, 25, '2026-10-07T11:00:00.000Z');
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r.meta.status, 'changed');        // 值确实变了
  assert.equal(r.meta.direction, null);          // 不伪造单一涨跌方向
  assert.equal(r.meta.delta, null);
  assert.equal(r.meta.pct, null);
});
t('12g. 10-20 -> 12-15: opposite directions (min up, max down) -> mixed, all null', () => {
  const fA = rangeFromScan(TA, 10, 20, '2026-10-07T09:00:00.000Z');
  const fB = rangeFromScan(TA, 12, 15, '2026-10-07T11:00:00.000Z');
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r.meta.status, 'changed');
  assert.equal(r.meta.direction, null);
  assert.equal(r.meta.delta, null);
  assert.equal(r.meta.pct, null);
});
t('12h. 39-39 -> 29-29: single price down, direction/delta/pct unchanged from original frozen rule', () => {
  const fA = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');   // 39 → min=max=39
  const fB = factFromScan(TA, PRODUCTS_B, '2026-10-07T11:00:00.000Z');   // 29 → min=max=29
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fA.fact_id, newFactId: fB.fact_id });
  assert.equal(r.meta.status, 'changed');
  assert.equal(r.meta.direction, 'decrease');
  assert.equal(r.meta.delta, -10);              // 原 price_min 基准口径不变
  assert.equal(r.meta.pct, -25.641);
});

// ============ 13. 零 LLM 零网络（静态断言） ============
t('13. No LLM / no network in diff layer (static assertion)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'research', 'price-diff.js'), 'utf8');
  assert.equal(/fetch\(|XMLHttpRequest|axios|node-fetch|openai|deepseek|dashscope|bailian/i.test(src), false);
});

// ============ 14. 缺 Fact 拒绝 ============
t('14. Missing fact rejected honestly (fact_not_found)', () => {
  const r = Diff.diffPriceFacts({ tenantId: TA, oldFactId: 'fact_missing', newFactId: 'fact_missing2' });
  assert.equal(r.recorded, false);
  assert.equal(r.reason, 'fact_not_found');
  const r2 = Diff.diffPriceFactWithUnavailableObservation({ tenantId: TA, oldFactId: 'fact_missing', newObservation: 'unavailable' });
  assert.equal(r2.recorded, false);
  assert.equal(r2.reason, 'fact_not_found');
  const r3 = Diff.diffPriceFactWithUnavailableObservation({ tenantId: TA, oldFactId: 'fact_missing', newObservation: 'whatever' });
  assert.equal(r3.reason, 'unsupported_observation');
});

// ============ 15. findPriceFactsByEntity（M0-05 装配辅助） ============
t('15. findPriceFactsByEntity returns facts ordered by observed_at', () => {
  const list = Diff.findPriceFactsByEntity(TA, 'shopify_product:1');
  assert.ok(list.length >= 2, 'expected >=2 facts for entity, got ' + list.length);
  const times = list.map(f => f.observed_at || '');
  assert.deepEqual(times, times.slice().sort());
  const tbList = Diff.findPriceFactsByEntity(TB, 'shopify_product:1');
  assert.ok(tbList.length >= 1);
  assert.ok(tbList.every(f => f.observed_at === '2026-10-07T11:00:00.000Z'));
});

// ============ 汇总 ============
console.log('\nprice-diff.test: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
