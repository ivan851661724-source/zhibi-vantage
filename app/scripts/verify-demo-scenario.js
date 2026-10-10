'use strict';
// Existing local demo data only. No database/schema/API creation and no fabricated AI.
// node [--env-file=.env] app/scripts/verify-demo-scenario.js --tenant <id> [--ai] [--refresh-ai]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Fixture = require('../research/demo-fixture');
const Events = require('../research/domain-event');
const Diff = require('../research/price-diff');
const Facts = require('../research/fact-store');
const Evidence = require('../research/evidence-store');
const Snapshot = require('../research/source-snapshot');
const { DATA } = require('../core/paths');
const { sanitizeNs } = require('../core/state-store');

const args = process.argv.slice(2);
const tenantId = args[args.indexOf('--tenant') + 1];
if (!args.includes('--tenant') || !tenantId || tenantId.startsWith('--')) {
  console.error('Use --tenant <existing local demo tenant ID>');
  process.exit(2);
}
function sha(b) { return crypto.createHash('sha256').update(b).digest('hex'); }
function fingerprint() {
  const files = {};
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else files[path.relative(DATA, p)] = sha(fs.readFileSync(p));
    }
  }
  for (const type of ['snapshots', 'evidence', 'facts', 'diffs', 'events']) walk(path.join(DATA, type, sanitizeNs(tenantId)));
  return files;
}

async function main() {
  const events = Events.listEvents(tenantId);
  assert.equal(events.length, 1, 'recording workspace must contain exactly one event');
  const event = events[0];
  assert.equal(event.entity_key, Fixture.DEMO_ENTITY_KEY);
  assert.equal(event.event_type, 'price_change_observed');
  assert.equal(event.entity_ref.brand_name, 'Demo Brand');
  assert.equal(event.entity_ref.title, 'Demo Product');
  assert.equal(event.old_price, 39);
  assert.equal(event.new_price, 29);
  assert.equal(event.direction, 'decrease');
  assert.equal(Math.abs(event.pct).toFixed(2), '25.64');
  assert.equal(event.observed_at_old, '2026-10-07T09:00:00.000Z');
  assert.equal(event.observed_at_new, '2026-10-07T11:00:00.000Z');
  assert.ok(event.observed_at_old < event.observed_at_new && event.observed_at_new < '2026-10-08T00:00:00.000Z');
  assert.ok(event.note.includes(Fixture.FIXTURE_TAG));
  const diff = Diff.getDiffById(tenantId, event.diff_id);
  assert.equal(diff.status, 'changed');
  assert.deepEqual(diff.old_value, { price_min: 39, price_max: 39 });
  assert.deepEqual(diff.new_value, { price_min: 29, price_max: 29 });
  assert.equal(diff.entity_ref.fixture_tag, Fixture.FIXTURE_TAG);
  const chain = [];
  for (const [side, price] of [['old', 39], ['new', 29]]) {
    const fact = Facts.getFactById(tenantId, event[side + '_fact_id']);
    assert.equal(fact.fact_type, 'public_product_price');
    assert.deepEqual({ price_min: fact.value.price_min, price_max: fact.value.price_max }, event[side + '_value']);
    assert.deepEqual(fact.evidence_ids, event[side + '_evidence_ids']);
    assert.deepEqual(fact.source_snapshot_ids, event[side + '_snapshot_ids']);
    assert.equal(fact.entity_ref.fixture_tag, Fixture.FIXTURE_TAG);
    assert.equal(diff[side + '_fact_id'], fact.fact_id);
    assert.equal(fact.evidence_ids.length, 1);
    const evidence = Evidence.getEvidenceById(tenantId, fact.evidence_ids[0]);
    assert.equal(evidence.evidence_status, 'verified');
    assert.equal(evidence.extracted_value.price_min, price);
    assert.equal(evidence.extracted_value.price_max, price);
    assert.equal(evidence.entity_ref.fixture_tag, Fixture.FIXTURE_TAG);
    assert.deepEqual(evidence.source_snapshot_ids, fact.source_snapshot_ids);
    assert.equal(fact.source_snapshot_ids.length, 1);
    const snapshot = Snapshot.getById(tenantId, fact.source_snapshot_ids[0]);
    assert.equal(snapshot.provider, 'shopify_products_json');
    assert.equal(snapshot.capability, 'product_catalog');
    assert.equal(snapshot.source_status, 'success');
    assert.equal(snapshot.source_url, 'https://demo-brand.example.com/products.json?limit=100');
    assert.equal(snapshot.observed_at, event['observed_at_' + side]);
    assert.equal(evidence.observed_at, snapshot.observed_at);
    assert.equal(fact.observed_at, snapshot.observed_at);
    assert.ok(snapshot.note.includes(Fixture.FIXTURE_TAG));
    const raw = Snapshot.readRawPayload(snapshot);
    assert.ok(raw && raw.length, 'raw snapshot must be readable');
    assert.equal('sha256:' + sha(raw), snapshot.content_hash);
    const products = JSON.parse(raw).products;
    assert.equal(products.length, 1);
    assert.equal(products[0].title, 'Demo Product');
    assert.equal(Number(products[0].variants[0].price), price);
    assert.equal(evidence.provenance.snapshots[0].snapshot_id, snapshot.snapshot_id);
    chain.push({ side, price, snapshot_id: snapshot.snapshot_id, evidence_id: evidence.evidence_id, fact_id: fact.fact_id, raw_payload: snapshot.raw_payload_ref.path });
  }
  const before = fingerprint();
  assert.ok(Object.keys(before).length >= 8, 'fingerprint must cover the stored chain');
  for (let i = 0; i < 2; i++) {
    const seed = Fixture.seedDemoScenario({ tenantId });
    assert.equal(seed.already, true);
    assert.equal(seed.event_id, event.event_id);
    assert.deepEqual(fingerprint(), before, 're-seed must not add or rewrite chain files');
  }
  const als = require('../core/als');
  const H = require('../routes/handlers/demo');
  async function call(handler, route, method) {
    let response;
    const ctx = { sendJSON: (_, status, body) => { response = { status, body }; return true; }, loadConfig: require('../core/config').loadConfig };
    await als.requestScope.run(tenantId, () => handler(ctx, { method }, {}, new URL('http://localhost' + route), route.split('?')[0]));
    assert.equal(response.status, 200, response.body.error || 'handler failed');
    return response.body;
  }
  const detail = await call(H.eventDetail, '/api/demo/event-detail?id=' + event.event_id, 'GET');
  assert.equal(detail.evidences.length, 2);
  assert.equal(detail.snapshots.length, 2);
  for (const link of chain) {
    const ev = await call(H.evidenceDetail, '/api/demo/evidence-detail?id=' + link.evidence_id, 'GET');
    assert.equal(ev.snapshots[0].snapshot_id, link.snapshot_id);
    assert.ok(ev.snapshots[0].source_url);
  }
  const report = { status: 'PASS', tenant_id: tenantId, demo_tag: Fixture.FIXTURE_TAG, chain, diff_id: diff.diff_id, event_id: event.event_id, decrease_pct: '25.64%', persistence: 'read from disk in a separate process', idempotency: 'two repeats, file hashes unchanged', detail_handlers: 'PASS', ai: { status: 'NOT_RUN' } };
  if (args.includes('--ai')) {
    const ai = await call(H.aiInterpretation, '/api/demo/ai-interpretation?id=' + event.event_id + (args.includes('--refresh-ai') ? '&refresh=1' : ''), 'POST');
    assert.equal(ai.event_id, event.event_id);
    assert.ok(ai.insight && ai.model);
    assert.match(ai.insight, /演示|Demo|Sample/i);
    assert.doesNotMatch(ai.insight, /(?:销量|GMV|用户流失).{0,12}\d/i);
    if (event.currency == null) assert.doesNotMatch(ai.insight, /\$|USD|美元|人民币|CNY|EUR|欧元|英镑|GBP|日元|JPY|[£€¥]/i, 'AI must not invent an unobserved currency');
    assert.deepEqual(fingerprint(), before, 'AI must not mutate the truth chain');
    report.ai = { status: 'PASS', insight: ai.insight, model: ai.model, cached: ai.cached };
  }
  fs.writeFileSync(path.join(DATA, 'demo-recording-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error('PARTIAL: ' + e.message); process.exitCode = 1; });
