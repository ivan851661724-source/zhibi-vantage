'use strict';
// Synthetic regression through real stores. This is not independent Golden data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-price-metric-'));
process.env.ZB_DATA_DIR = TMP;
process.env.MT_STORE_PATH = path.join(TMP, 'tenants.json');
process.env.OBS_DB_PATH = path.join(TMP, 'observability.db');
const Snapshot = require('../research/source-snapshot.js');
const Extract = require('../research/evidence-extract.js');
const Evidence = require('../research/evidence-store.js');
const Fact = require('../research/fact-store.js');
const { sanitizeNs } = require('../core/state-store.js');
const TA = 'tenant:metric', WHEN = '2026-10-17T01:00:00.000Z';
let Metric;
try { Metric = require('../research/price-metric.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const product = (id, prices, available = true) => ({ id, variants: prices.map((price, i) => ({ id: id * 100 + i, price: String(price), available })) });
function snap(products, overrides = {}) {
  return Snapshot.record({ tenantId: TA, capability: 'product_catalog', provider: 'shopify_products_json',
    projectRef: 'p1', source_url: 'https://example.com/products.json?page=1', source_status: 'success',
    fetched_at: WHEN, observed_at: WHEN, bodyBytes: Buffer.from(JSON.stringify({ products })), ...overrides }).meta;
}
function cart(overrides = {}) { return snap([], { provider: 'shopify_cart_js_json', capability: 'storefront_currency', source_url: 'https://example.com/cart.js', bodyBytes: Buffer.from('{"currency":"USD"}'), ...overrides }); }
function batch(products, opts = {}) {
  const s = snap(products, opts.snapshot), c = opts.noCurrency ? null : cart(opts.currency);
  const r = Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: s.snapshot_id, currencySnapshotId: c?.snapshot_id, projectRef: s.tenant.project_ref });
  assert.equal(r.ok, true, r.reason);
  const facts = r.evidence_ids.map(evidenceId => Fact.recordPriceFactFromEvidence({ tenantId: TA, evidenceId })).filter(r => r.recorded).map(r => r.meta);
  return { s, c, facts, input: { tenantId: TA, factIds: facts.map(f => f.fact_id), snapshotIds: [s.snapshot_id], ...(c ? { currencySnapshotId: c.snapshot_id } : {}) } };
}
function record(input) { assert.equal(typeof Metric?.recordPriceMetric, 'function', 'Metric writer must exist'); return Metric.recordPriceMetric(input); }
function overwrite(kind, id, value) { fs.writeFileSync(path.join(TMP, kind, sanitizeNs(TA), id + '.json'), JSON.stringify(value)); }
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('real Fact chain derives product medians, ranked quartiles and immutable retry identity independent of target', () => {
  const b = batch([product(1, [10, 20, 90]), product(2, [40]), product(3, [60])]);
  const r = record({ ...b.input, prices: [999], target: 1 });
  assert.equal(r.recorded, true, r.reason);
  assert.deepEqual(r.meta.value, { p25: 20, median: 40, p75: 40 });
  assert.equal(r.meta.sample_product_count, 3);
  assert.equal(r.meta.evidence_status, 'derived');
  assert.equal(r.meta.currency, 'USD');
  assert.ok(r.meta.algorithm_version && r.meta.config_version && r.meta.computed_at);
  assert.deepEqual(r.meta.config.count_units, {
    product_counts: 'products_containing_variant_non_exclusive',
    variant_counts: 'unique_variants_per_product',
  });
  assert.deepEqual(r.meta.fact_ids, [...b.input.factIds].sort());
  assert.equal(r.meta.source_snapshot_ids.length, 2);
  assert.equal(r.meta.collection_snapshot_ids.length, 1);
  const before = fs.readFileSync(path.join(TMP, 'metrics', sanitizeNs(TA), r.meta.metric_id + '.json'), 'utf8');
  const retry = record({ ...b.input, factIds: [...b.input.factIds, b.input.factIds[0]].reverse(), target: 900 });
  assert.equal(retry.duplicate, true); assert.deepEqual(retry.meta, r.meta);
  assert.equal(fs.readFileSync(path.join(TMP, 'metrics', sanitizeNs(TA), r.meta.metric_id + '.json'), 'utf8'), before);
  const newer = batch([product(1, [10, 20, 90]), product(2, [40]), product(3, [60])]);
  assert.notEqual(record(newer.input).meta.metric_id, r.meta.metric_id);
  assert.equal(Metric.getMetricById('tenant:other', r.meta.metric_id), null);
  assert.equal(Metric.getMetricById(TA, '../bad'), null);
});
test('unknown/sold-out/free/invalid variants do not supply active paid product samples; counts have explicit units', () => {
  const mixed = product(20, [0, 77]); delete mixed.variants[1].available;
  const b = batch([product(10, [10]), product(11, [99], false), product(12, [0]), product(13, [5], null), mixed,
    product(14, [-2, 'bad']), { id: 15, variants: [{ id: 1500, price: 'oops', available: true }] }]);
  const r = record(b.input); assert.equal(r.recorded, true, r.reason);
  assert.equal(r.meta.sample_product_count, 1);
  assert.deepEqual(r.meta.value, { p25: null, median: null, p75: null });
  assert.equal(r.meta.product_counts.observed, 7);
  assert.equal(r.meta.product_counts.active_paid, 1);
  assert.equal(r.meta.product_counts.free, 2);
  assert.equal(r.meta.product_counts.unknown_availability, 2);
  assert.equal(r.meta.product_counts.sold_out, 1);
  assert.equal(r.meta.product_counts.invalid, 2);
  assert.equal(r.meta.variant_counts.invalid, 3);
  assert.ok(r.meta.limitations.includes('insufficient_sample'));
});
test('old prices without availability remain unknown, and currency null is never filled from caller', () => {
  const b = batch([product(1, [25]), product(2, [30]), product(3, [40])], { noCurrency: true });
  for (const f of b.facts) {
    const ev = Evidence.getEvidenceById(TA, f.evidence_ids[0]);
    delete f.value.prices[0].available; delete ev.extracted_value.prices[0].available;
    overwrite('facts', f.fact_id, f); overwrite('evidence', ev.evidence_id, ev);
  }
  const r = record({ ...b.input, currency: 'USD' });
  assert.equal(r.recorded, true, r.reason); assert.equal(r.meta.currency, null);
  assert.equal(r.meta.sample_product_count, 0); assert.equal(r.meta.product_counts.unknown_availability, 3);
  assert.ok(r.meta.limitations.includes('currency_unknown'));
});
test('all failed/empty input creates no zero Metric, while partial collection includes failed and empty pages', () => {
  assert.equal(record({ tenantId: TA, factIds: [], snapshotIds: [] }).recorded, false);
  const b = batch([product(1, [20]), product(2, [40]), product(3, [60])], { snapshot: { partial_scan: true, source_status: 'partial', partial_scan_reason: 'page_2_blocked' } });
  const failed = snap([], { source_status: 'blocked', bodyBytes: null, observed_at: null });
  const empty = snap([]);
  const r = record({ ...b.input, snapshotIds: [...b.input.snapshotIds, failed.snapshot_id, empty.snapshot_id] });
  assert.equal(r.recorded, true, r.reason); assert.equal(r.meta.partial_scan, true);
  assert.equal(r.meta.collection_snapshot_ids.length, 3);
  assert.equal(r.meta.source_snapshot_ids.length, 2);
  assert.ok(r.meta.collection_issues.some(i => i.snapshot_id === failed.snapshot_id && i.source_status === 'blocked'));
  assert.ok(r.meta.collection_issues.some(i => i.snapshot_id === empty.snapshot_id && i.empty));
});
test('identical repeated products retain all references with one observation and variant order is irrelevant', () => {
  const p = product(1, [20, 40]); const b = batch([p, product(2, [60]), product(3, [80])]);
  const s2 = snap([{ ...p, variants: [...p.variants].reverse() }]);
  const r2 = Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: s2.snapshot_id, currencySnapshotId: b.c.snapshot_id });
  const f2 = Fact.recordPriceFactFromEvidence({ tenantId: TA, evidenceId: r2.evidence_ids[0] }).meta;
  const r = record({ ...b.input, factIds: [...b.input.factIds, f2.fact_id], snapshotIds: [...b.input.snapshotIds, s2.snapshot_id] });
  assert.equal(r.recorded, true, r.reason); assert.equal(r.meta.sample_product_count, 3);
  assert.equal(r.meta.fact_ids.length, 4); assert.deepEqual(r.meta.value, { p25: 30, median: 60, p75: 60 });
});
test('repeated product conflicting availability or price is rejected rather than selecting a page', () => {
  for (const changed of [product(1, [50]), product(1, [20], false)]) {
    const b = batch([product(1, [20])]); const s2 = snap([changed]);
    const er = Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: s2.snapshot_id, currencySnapshotId: b.c.snapshot_id });
    const f = Fact.recordPriceFactFromEvidence({ tenantId: TA, evidenceId: er.evidence_ids[0] }).meta;
    const r = record({ ...b.input, factIds: [...b.input.factIds, f.fact_id], snapshotIds: [...b.input.snapshotIds, s2.snapshot_id] });
    assert.equal(r.recorded, false); assert.match(r.reason, /conflict/);
  }
});
test('raw-native product identity and duplicate variant conflicts cannot be silently merged', () => {
  for (const products of [[{ title: 'Same', variants: [{ price: 20, available: true }] }],
    [{ id: 1, variants: [{ id: 11, price: 20, available: true }, { id: 11, price: 40, available: true }] }]]) {
    const r = record(batch(products).input); assert.equal(r.recorded, false); assert.match(r.reason, /identity|conflict/);
  }
});
test('explicit same-batch tenant/project/domain and raw replay chain are enforced', () => {
  for (const override of [{ fetched_at: '2026-10-16T00:00:00Z' }, { projectRef: 'p2' }, { source_url: 'https://other.com/products.json' }, { tenantId: 'tenant:other' }]) {
    const b = batch([product(1, [20])]); const wrong = snap([], override);
    const r = record({ ...b.input, snapshotIds: [...b.input.snapshotIds, wrong.snapshot_id] });
    assert.equal(r.recorded, false); assert.match(r.reason, /scope|snapshot/);
  }
  const b = batch([product(1, [20])]); const f = b.facts[0]; f.value.price_min = 999; overwrite('facts', f.fact_id, f);
  assert.match(record(b.input).reason, /value/);
  const b2 = batch([product(1, [20])]); fs.unlinkSync(path.join(TMP, b2.s.raw_payload_ref.path));
  assert.match(record(b2.input).reason, /raw/);
  const b3 = batch([product(1, [20])]); b3.facts[0].tenant.tenant_id = 'tenant:wrong'; overwrite('facts', b3.facts[0].fact_id, b3.facts[0]);
  assert.match(record(b3.input).reason, /tenant/);
});
test('Fact and Evidence values agreeing with each other but differing from raw are rejected', () => {
  const b = batch([product(1, [20])]); const f = b.facts[0], e = Evidence.getEvidenceById(TA, f.evidence_ids[0]);
  f.value.price_min = f.value.price_max = f.value.prices[0].price = 777;
  e.extracted_value = f.value; overwrite('facts', f.fact_id, f); overwrite('evidence', e.evidence_id, e);
  assert.match(record(b.input).reason, /raw|value/);
});
test('even product and variant sample medians average the middle pair; quartiles preserve existing rank convention', () => {
  const r = record(batch([product(1, [10, 20]), product(2, [20, 30, 40, 50]), product(3, [50]), product(4, [70])]).input);
  assert.equal(r.recorded, true, r.reason);
  assert.deepEqual(r.meta.value, { p25: 15, median: 42.5, p75: 50 });
  const six = record(batch([10, 20, 30, 40, 50, 60].map((price, i) => product(10 + i, [price]))).input);
  assert.deepEqual(six.meta.value, { p25: 20, median: 35, p75: 40 });
});
test('a successful caller cart reference cannot lend currency without an actual Evidence support reference', () => {
  const b = batch([product(1, [20])], { noCurrency: true }), c = cart();
  const f = b.facts[0], e = Evidence.getEvidenceById(TA, f.evidence_ids[0]);
  f.currency = e.currency = 'USD'; overwrite('facts', f.fact_id, f); overwrite('evidence', e.evidence_id, e);
  assert.equal(record({ ...b.input, currencySnapshotId: c.snapshot_id }).recorded, false);
});
test('anonymous repeated and conflicting variants cannot change a unique-variant Metric sample', () => {
  for (const variants of [
    [{ price: 10, available: true }, { price: 100, available: true }],
    [{ price: 10, available: true }, { price: 10, available: true }, { price: 100, available: true }],
    [{ id: null, price: 10, available: true }, { id: null, price: 100, available: false }],
    [{ id: '   ', price: 10, available: true }],
  ]) {
    const b = batch([{ id: 70, variants }, product(71, [20]), product(72, [100])]);
    const r = record(b.input);
    assert.equal(r.recorded, false);
    assert.equal(r.reason, 'variant_identity_missing');
    assert.equal(Fact.getFactById(TA, b.facts[0].fact_id).value.prices.length, variants.length, 'source Fact is preserved without identity invention');
  }
});
test('numeric observations require real parseable Fact and product-snapshot observation timestamps', () => {
  for (const source_status of ['success', 'partial']) for (const observed_at of [null, '', 'invalid-observed-time']) {
    const b = batch([product(80, [10]), product(81, [20]), product(82, [30])], { snapshot: { observed_at, source_status } });
    const r = record(b.input);
    assert.equal(r.recorded, false, `${source_status}/${observed_at}`);
    assert.match(r.reason, /observed_at/);
  }
  const b = batch([product(83, [10])]);
  const f = b.facts[0], e = Evidence.getEvidenceById(TA, f.evidence_ids[0]);
  f.observed_at = e.observed_at = 'invalid-fact-time';
  overwrite('facts', f.fact_id, f); overwrite('evidence', e.evidence_id, e);
  const r = record(b.input);
  assert.equal(r.recorded, false); assert.match(r.reason, /observed_at/);
});
test('successful currency proof requires its own parseable observed timestamp', () => {
  for (const observed_at of [null, '', 'invalid-currency-time']) {
    const b = batch([product(90, [10]), product(91, [20]), product(92, [30])], { currency: { observed_at } });
    const r = record(b.input);
    assert.equal(r.recorded, false); assert.match(r.reason, /observed_at/);
  }
});
test('valid cross-page observations preserve their actual range while a failed page retains null observed_at', () => {
  const b = batch([product(100, [10])], { snapshot: { observed_at: '2026-10-17T09:00:03+08:00' } });
  const later = snap([product(101, [20]), product(102, [30])], { observed_at: '2026-10-17T01:00:07Z' });
  const es = Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: later.snapshot_id, currencySnapshotId: b.c.snapshot_id });
  const laterIds = es.evidence_ids.map(evidenceId => Fact.recordPriceFactFromEvidence({ tenantId: TA, evidenceId }).meta.fact_id);
  const failed = snap([], { source_status: 'blocked', bodyBytes: null, observed_at: null });
  const r = record({ ...b.input, factIds: [...b.input.factIds, ...laterIds], snapshotIds: [...b.input.snapshotIds, later.snapshot_id, failed.snapshot_id] });
  assert.equal(r.recorded, true, r.reason);
  assert.equal(r.meta.observed_from, '2026-10-17T09:00:03+08:00');
  assert.equal(r.meta.observed_to, '2026-10-17T01:00:07Z');
  assert.equal(r.meta.partial_scan, true);
  assert.ok(r.meta.collection_issues.some(i => i.snapshot_id === failed.snapshot_id && i.source_status === 'blocked'));
  assert.equal(Snapshot.getById(TA, failed.snapshot_id).observed_at, null);
});
