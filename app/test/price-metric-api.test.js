'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-price-metric-api-'));
process.env.ZB_DATA_DIR = TMP;
process.env.MT_STORE_PATH = path.join(TMP, 'tenants.json');
process.env.OBS_DB_PATH = path.join(TMP, 'observability.db');
const Snapshot = require('../research/source-snapshot.js');
const Evidence = require('../research/evidence-store.js');
const Extract = require('../research/evidence-extract.js');
const Fact = require('../research/fact-store.js');
const Metric = require('../research/price-metric.js');
const { sanitizeNs } = require('../core/state-store.js');
const als = require('../core/als.js');
const Demo = require('../routes/handlers/demo.js');
let Intelligence;
try { Intelligence = require('../routes/handlers/intelligence.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const TA = 'tenant:metric-api', TB = 'tenant:other', WHEN = '2026-10-17T01:00:00Z';
const snap = (products, extra = {}) => Snapshot.record({ tenantId: TA, capability: 'product_catalog', provider: 'shopify_products_json',
  source_url: 'https://example.com/products.json', source_status: 'success', fetched_at: WHEN, observed_at: WHEN,
  projectRef: 'p1', bodyBytes: Buffer.from(JSON.stringify({ products })), ...extra }).meta;
const pages = [1, 2, 3, 4, 5].map(id => snap([{ id, variants: [{ id: id * 10, available: true, price: id * 10 }] }]));
const factIds = pages.flatMap(s => Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: s.snapshot_id }).evidence_ids)
  .map(evidenceId => Fact.recordPriceFactFromEvidence({ tenantId: TA, evidenceId }).meta.fact_id);
const failed = snap([], { source_status: 'blocked', bodyBytes: null, observed_at: null });
const empty = snap([]);
const metric = Metric.recordPriceMetric({ tenantId: TA, factIds, snapshotIds: [...pages, failed, empty].map(s => s.snapshot_id) }).meta;
async function call(endpoint, tenantId = TA, handler) {
  let status, body;
  const url = new URL(endpoint, 'http://localhost');
  if (!handler) { assert.equal(typeof Intelligence?.priceMetric, 'function', 'Metric HTTP handler must exist'); handler = url.pathname === '/api/price-metric' ? Intelligence.priceMetric : Intelligence.evidenceDetail; }
  const ctx = { sendJSON: (_res, s, b) => { status = s; body = b; return true; } };
  const handled = await als.requestScope.run(tenantId, () => handler(ctx, { method: 'GET' }, {}, url, url.pathname));
  assert.equal(handled, true); return { status, body };
}
test.after(() => { require('../observability/telemetry.js')._resetForTest(); require('../services/db.js').closeDb(); fs.rmSync(TMP, { recursive: true, force: true }); });
test('Metric API requires tenant identity and validates safe IDs and pagination bounds', async () => {
  assert.equal((await call('/api/price-metric?id=' + metric.metric_id, null)).status, 401);
  assert.equal((await call('/api/price-metric')).status, 400);
  assert.equal((await call('/api/price-metric?id=../bad')).status, 400);
  assert.equal((await call('/api/price-metric?id=metric_unknown')).status, 404);
  assert.equal((await call('/api/price-metric?id=' + metric.metric_id, TB)).status, 404);
  for (const q of ['offset=-1', 'offset=1.5', 'offset=NaN', 'offset=', 'limit=0', 'limit=51', 'limit=2.1', 'limit=1e1', 'limit=']) {
    assert.equal((await call('/api/price-metric?id=' + metric.metric_id + '&' + q)).status, 400, q);
  }
});
test('details have stable Fact-ID paging and only expand supporting objects for the requested page', async () => {
  const expected = [...factIds].sort();
  const a = await call('/api/price-metric?id=' + metric.metric_id + '&offset=0&limit=2');
  assert.equal(a.status, 200); assert.equal(a.body.total, 5); assert.equal(a.body.nextOffset, 2); assert.equal(a.body.hasMore, true);
  assert.deepEqual(a.body.facts.map(f => f.fact_id), expected.slice(0, 2));
  assert.equal(a.body.evidences.length, 2); assert.equal(a.body.snapshots.length, 2);
  assert.equal(a.body.metric.fact_ids.length, 5);
  assert.equal(a.body.collectionIssues.length, 2);
  assert.ok(!JSON.stringify(a.body).includes('raw_payload_ref'));
  const b = await call('/api/price-metric?id=' + metric.metric_id + '&offset=2&limit=2');
  assert.deepEqual(b.body.facts.map(f => f.fact_id), expected.slice(2, 4));
  const c = await call('/api/price-metric?id=' + metric.metric_id + '&offset=4&limit=2');
  assert.equal(c.body.hasMore, false); assert.equal(c.body.nextOffset, null);
  const d = await call('/api/price-metric?id=' + metric.metric_id + '&offset=99&limit=2');
  assert.deepEqual(d.body.facts, []); assert.deepEqual(d.body.evidences, []); assert.deepEqual(d.body.snapshots, []);
  assert.equal(d.body.total, 5); assert.equal(d.body.nextOffset, null);
});
test('shared evidence detail keeps demo alias compatible and recursively strips internal raw references', async () => {
  const f = Fact.getFactById(TA, factIds[0]), e = Evidence.getEvidenceById(TA, f.evidence_ids[0]);
  const secret = { raw_payload_ref: { path: 'private/internal.raw' } };
  e.provenance.nested = { child: [secret] }; e.raw_payload_ref = secret.raw_payload_ref;
  f.provenance.nested = { child: [secret] }; f.raw_payload_ref = secret.raw_payload_ref;
  fs.writeFileSync(path.join(TMP, 'evidence', sanitizeNs(TA), e.evidence_id + '.json'), JSON.stringify(e));
  fs.writeFileSync(path.join(TMP, 'facts', sanitizeNs(TA), f.fact_id + '.json'), JSON.stringify(f));
  const current = await call('/api/evidence-detail?id=' + e.evidence_id);
  const old = await call('/api/demo/evidence-detail?id=' + e.evidence_id, TA, Demo.evidenceDetail);
  assert.equal(current.status, 200); assert.deepEqual(current.body, old.body);
  assert.equal(current.body.snapshots[0].source_url, 'https://example.com/products.json');
  assert.ok(!JSON.stringify(current.body).includes('internal.raw'));
  const detail = await call('/api/price-metric?id=' + metric.metric_id);
  assert.ok(!JSON.stringify(detail.body).includes('raw_payload_ref'));
  assert.equal((await call('/api/evidence-detail?id=' + e.evidence_id, TB)).status, 404);
  assert.equal((await call('/api/evidence-detail?id=../bad')).status, 400);
});
test('objects missing after creation produce honest issues rather than fabricated detail', async () => {
  const sorted = [...factIds].sort(), f = Fact.getFactById(TA, sorted[0]);
  fs.unlinkSync(path.join(TMP, 'evidence', sanitizeNs(TA), f.evidence_ids[0] + '.json'));
  const a = await call('/api/price-metric?id=' + metric.metric_id + '&limit=1');
  assert.equal(a.status, 200); assert.deepEqual(a.body.evidences, []);
  assert.ok(a.body.issues.some(i => i.id === f.evidence_ids[0] && i.kind === 'evidence'));
  const f2 = Fact.getFactById(TA, sorted[1]);
  fs.unlinkSync(path.join(TMP, 'snapshots', sanitizeNs(TA), '20261017', f2.source_snapshot_ids[0] + '.json'));
  const e = await call('/api/evidence-detail?id=' + f2.evidence_ids[0]);
  assert.equal(e.status, 200); assert.deepEqual(e.body.snapshots, []);
  assert.ok(e.body.issues.some(i => i.kind === 'snapshot'));
  const f3 = Fact.getFactById(TA, sorted[2]), s3 = Snapshot.getById(TA, f3.source_snapshot_ids[0]);
  fs.unlinkSync(path.join(TMP, s3.raw_payload_ref.path));
  const rawMissing = await call('/api/evidence-detail?id=' + f3.evidence_ids[0]);
  assert.ok(rawMissing.body.issues.some(i => i.kind === 'raw' && i.id === s3.snapshot_id));
  const rawMissingPage = await call('/api/price-metric?id=' + metric.metric_id + '&offset=2&limit=1');
  assert.ok(rawMissingPage.body.issues.some(i => i.kind === 'raw' && i.id === s3.snapshot_id));
});
test('new read-only routes are tenant registered alongside compatible demo routes', () => {
  const Routes = require('../routes/index.js');
  assert.equal(Routes.match('GET', '/api/price-metric')?.auth, 'tenant');
  assert.equal(Routes.match('GET', '/api/evidence-detail')?.auth, 'tenant');
  assert.equal(Routes.match('GET', '/api/demo/evidence-detail')?.auth, 'tenant');
});
test('demo snapshot raw_resolvable compatibility reflects current raw integrity and missing raw honestly', async () => {
  const s = snap([{ id: 99, variants: [{ id: 990, price: 29, available: true }] }]);
  const eid = Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: s.snapshot_id }).evidence_ids[0];
  const old = () => call('/api/demo/evidence-detail?id=' + eid, TA, Demo.evidenceDetail);
  const initial = await old();
  assert.equal(initial.body.snapshots[0].raw_resolvable, true);
  assert.equal(initial.body.evidence.provenance.snapshots[0].raw_resolvable, true);
  assert.deepEqual(initial.body.issues, []);
  const rawPath = path.join(TMP, s.raw_payload_ref.path);
  fs.writeFileSync(rawPath, '{"products":[]}');
  const corrupt = await old();
  assert.equal(corrupt.body.snapshots[0].raw_resolvable, false);
  assert.equal(corrupt.body.evidence.provenance.snapshots[0].raw_resolvable, false);
  assert.ok(corrupt.body.issues.some(i => i.kind === 'raw' && i.id === s.snapshot_id && i.reason === 'raw_hash_mismatch'));
  assert.deepEqual((await call('/api/evidence-detail?id=' + eid)).body, corrupt.body);
  fs.unlinkSync(rawPath);
  const missing = await old();
  assert.equal(missing.body.snapshots[0].raw_resolvable, false);
  assert.equal(missing.body.evidence.provenance.snapshots[0].raw_resolvable, false);
  assert.ok(missing.body.issues.some(i => i.reason === 'raw_unavailable'));
  assert.ok(!JSON.stringify(missing.body).includes('raw_payload_ref'));
});
