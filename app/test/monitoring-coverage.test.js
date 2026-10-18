'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
// Establish an isolated root before any application import, including fixtures.
const bootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-coverage-boot-'));
process.env.ZB_DATA_DIR = bootDir;
delete process.env.MT_STORE_PATH;
delete process.env.OBS_DB_PATH;
global.fetch = () => { throw new Error('network forbidden'); };
test.after(() => fs.rmSync(bootDir, { recursive: true, force: true }));
const { fixture } = require('./monitoring-store.test');
const { createMonitoringStore } = require('../services/monitoring-store');
const { createMonitoringQueue } = require('../services/monitoring-queue');
const coveragePath = path.join(__dirname, '../services/monitoring-coverage.js');
const implementation = fs.existsSync(coveragePath) ? require(coveragePath) : {};

function setup() {
  const f = fixture();
  const queue = createMonitoringQueue({ store: f.store });
  const workspace = f.workspace();
  f.store.updateWorkspace({ tenantId: f.tenantId, workspaceId: workspace.workspace_id, market: 'US', timeZone: 'UTC', now: 0 });
  const seed = f.seed(workspace);
  const target = f.store.createWatchTarget(seed.input);
  const service = implementation.createCoverageService({ store: f.store });
  function finish(patch = {}, window = '1969-12-31:22') {
    queue.enqueue({ tenantId: f.tenantId, watchTargetId: target.watch_target_id,
      trigger: 'monitor', scheduledAt: -7200000, windowKey: window, now: 0 });
    const job = queue.claim(1000);
    const result = { schema_version: 1, job_id: job.job_id, revision: target.revision,
      source_status: 'success', source_results: [], snapshot_ids: [seed.ss],
      fact_ids: [], diff_ids: [], event_ids: [], partial_scan: false, issues: [], completed_at: 1001, ...patch };
    assert.equal(queue.finish(job.job_id, job.claim_token, result, 1001).ok, true);
    return { job, target, result, now: 1001 };
  }
  return { ...f, queue, seedData: seed, target, service, finish };
}

test('coverage API is available', () => {
  assert.equal(typeof implementation.createCoverageService, 'function');
  assert.equal(typeof implementation.evaluateQuiet, 'function');
});

test('extension installation preserves v1 state and rolls back all DDL on failure', () => {
  const f = fixture();
  try {
    const workspace = f.workspace();
    assert.throws(() => f.store.transaction(() => {
      implementation.createCoverageService({ store: f.store });
      throw new Error('outer transaction fault');
    }), /outer transaction fault/);
    assert.equal(f.store.getDb().prepare("SELECT count(*) n FROM sqlite_master WHERE name='monitoring_coverage'").get().n, 0);
    implementation.createCoverageService({ store: f.store });
    assert.equal(f.store.getDb().prepare('PRAGMA user_version').get().user_version, 1);
    f.store.close(); f.store = createMonitoringStore({ dataDir: f.dir });
    implementation.createCoverageService({ store: f.store });
    assert.deepEqual(f.store.getWorkspace(f.tenantId, workspace.workspace_id), workspace);
    f.store.getDb().prepare("UPDATE monitoring_extension_schema SET version=2 WHERE name='coverage'").run();
    assert.throws(() => implementation.createCoverageService({ store: f.store }), { code: 'UNSUPPORTED_COVERAGE_SCHEMA' });
  } finally { f.cleanup(); }
});

test('completed observations stay unknown, immutable and idempotent across connections and restart', () => {
  const f = setup(); let second;
  try {
    const input = f.finish();
    const c = f.service.recordObservation(input);
    assert.equal(c.attempted_targets, 1);
    for (const key of ['expected_targets', 'successful_targets', 'qualified_successful_targets', 'required_capabilities', 'missing_capabilities', 'window_start', 'window_end', 'window_complete', 'policy_version', 'policy_provenance', 'freshness_status', 'actionability_complete']) assert.equal(c[key], null, key);
    assert.equal(c.quiet.allowed, false);
    for (const reason of ['policy_unknown', 'window_unknown', 'denominator_unknown', 'required_p0_unknown', 'freshness_unknown', 'actionability_unknown', 'source_results_unknown', 'comparison_unknown']) assert.ok(c.quiet.reasons.includes(reason), reason);
    assert.deepEqual(c.snapshot_ids, [f.seedData.ss]);
    second = createMonitoringStore({ dataDir: f.dir });
    const service2 = implementation.createCoverageService({ store: second });
    assert.deepEqual(service2.recordObservation({ ...input, now: 2000 }), c);
    assert.equal(service2.list(f.tenantId).total, 1);
    assert.throws(() => service2.recordObservation({ ...input, result: { ...input.result, source_status: 'blocked' } }), { code: 'COVERAGE_RESULT_MISMATCH' });
    f.store.getDb().prepare('UPDATE monitoring_jobs SET result=? WHERE job_id=?').run(JSON.stringify({ ...input.result, issues: ['changed'] }), input.job.job_id);
    assert.throws(() => service2.recordObservation({ ...input, result: { ...input.result, issues: ['changed'] } }), { code: 'COVERAGE_OBSERVATION_CONFLICT' });
    assert.deepEqual(service2.get(f.tenantId, c.coverage_id), c);
    assert.equal(service2.get('tenant?a', c.coverage_id), null);
    assert.equal(service2.list('tenant?a').total, 0);
    second.close(); second = null;
    f.store.close(); f.store = createMonitoringStore({ dataDir: f.dir });
    assert.deepEqual(implementation.createCoverageService({ store: f.store }).get(f.tenantId, c.coverage_id), c);
  } finally { second?.close(); f.cleanup(); }
});

test('caller claims cannot substitute job, attempt, result or raw owned scope', () => {
  const f = setup();
  try {
    const input = f.finish();
    for (const patch of [{ tenant_id: 'tenant?a' }, { target_id: 'missing' }, { revision: 2 }, { attempts: 2 }, { workspace_id: 'missing' }, { job_id: 'absent' }]) {
      assert.throws(() => f.service.recordObservation({ ...input, job: { ...input.job, ...patch } }));
    }
    for (const patch of [{ tenant_id: 'tenant?a' }, { project_id: 'other' }, { competitor_id: 'other' }, { workspace_id: 'other' }, { category_scope: 'bags' }, { market: 'CA' }, { revision: 2 }]) {
      assert.throws(() => f.service.recordObservation({ ...input, target: { ...input.target, ...patch } }), { code: 'COVERAGE_TARGET_MISMATCH' });
    }
    f.store.getDb().prepare("UPDATE monitoring_jobs SET status='running' WHERE job_id=?").run(input.job.job_id);
    assert.throws(() => f.service.recordObservation(input), { code: 'COVERAGE_JOB_NOT_COMPLETED' });
    f.store.getDb().prepare("UPDATE monitoring_jobs SET status='done' WHERE job_id=?").run(input.job.job_id);
    f.store.pauseWatchTarget(f.tenantId, f.target.watch_target_id, 2000);
    assert.throws(() => f.service.recordObservation(input), { code: 'COVERAGE_TARGET_MISMATCH' });
    assert.equal(f.service.list(f.tenantId).total, 0);
  } finally { f.cleanup(); }
});

test('actual failed sources survive sanitized projection and cannot become qualified success', () => {
  const f = setup();
  try {
    const snapshotPath = 'snapshots/' + f.ns + '/20261017/' + f.seedData.ss + '.json';
    const original = JSON.parse(fs.readFileSync(path.join(f.dir, snapshotPath), 'utf8'));
    const input = f.finish({ source_status: 'partial', partial_scan: true,
      source_results: [{ snapshot_id: f.seedData.ss, source_status: 'success', raw_payload_ref: { path: 'SECRET_PATH' } }],
      issues: ['partial_scan'] });
    f.write(snapshotPath, { ...original, source_status: 'blocked', http_status: 403 });
    const c = f.service.recordObservation(input);
    assert.equal(c.source_results[0].source_status, 'blocked');
    assert.equal(c.source_failures[0].source_status, 'blocked');
    assert.equal(c.failed_targets, 1);
    assert.equal(c.qualified_successful_targets, null);
    assert.ok(c.quiet.reasons.includes('source_failure'));
    assert.ok(c.quiet.reasons.includes('partial_scan'));
    assert.ok(!JSON.stringify(c).includes('SECRET_PATH'));
    assert.ok(!JSON.stringify(c).includes('raw_payload_ref'));
  } finally { f.cleanup(); }
});

test('missing, foreign and malformed reference IDs are excluded with explicit issues', () => {
  const f = setup();
  try {
    const input = f.finish({ snapshot_ids: [f.seedData.ss, 'absent', '../escape'], fact_ids: ['fake'], diff_ids: ['fake'], event_ids: ['fake'] });
    f.write('facts/' + f.ns + '/fake.json', { fact_id: 'fake', tenant: { tenant_id: 'tenant?a', project_ref: f.target.project_id } });
    const c = f.service.recordObservation(input);
    assert.deepEqual(c.snapshot_ids, [f.seedData.ss]);
    assert.deepEqual(c.fact_ids, []); assert.deepEqual(c.diff_ids, []); assert.deepEqual(c.event_ids, []);
    assert.ok(c.issues.includes('snapshot_reference_unverified'));
    assert.ok(c.issues.includes('fact_reference_unverified'));
    assert.ok(c.issues.includes('event_reference_unverified'));
    assert.equal(c.quiet.allowed, false);
  } finally { f.cleanup(); }
});

test('scope SQL filtering precedes pagination and never creates a historical denominator', () => {
  const f = setup();
  try {
    const input = f.finish(); f.service.recordObservation(input);
    const workspace = f.workspace('second');
    f.store.updateWorkspace({ tenantId: f.tenantId, workspaceId: workspace.workspace_id, market: 'US', timeZone: 'UTC', now: 0 });
    const other = f.seed(workspace, '2');
    const target = f.store.createWatchTarget(other.input);
    f.queue.enqueue({ tenantId: f.tenantId, watchTargetId: target.watch_target_id, trigger: 'monitor', scheduledAt: -7200000, windowKey: '1969-12-31:22', now: 0 });
    const job = f.queue.claim(3000), result = { source_status: 'blocked', event_ids: [] };
    f.queue.finish(job.job_id, job.claim_token, result, 3001);
    const c = f.service.recordObservation({ job, target, result, now: 3001 });
    const page = f.service.list(f.tenantId, { workspaceId: target.workspace_id, projectId: target.project_id, competitorId: target.competitor_id, offset: 0, limit: 1 });
    assert.equal(page.total, 1); assert.equal(page.coverage[0].coverage_id, c.coverage_id);
    assert.equal(page.coverage[0].expected_targets, null);
    assert.equal(f.service.list(f.tenantId, { workspaceId: target.workspace_id, offset: 1, limit: 1 }).coverage.length, 0);
    assert.equal(f.service.list(f.tenantId, { workspaceId: 'unknown' }).total, 0);
    assert.throws(() => f.service.list(f.tenantId, { projectId: target.project_id }), { code: 'INVALID_TARGET_FILTER' });
    for (const opts of [{ offset: -1 }, { offset: 0.1 }, { limit: 0 }, { limit: Infinity }, { limit: 101 }]) assert.throws(() => f.service.list(f.tenantId, opts), { code: 'INVALID_PAGINATION' });
  } finally { f.cleanup(); }
});

function seedComparison(f, status = 'no_meaningful_change') {
  const tenant = { tenant_id: f.tenantId, project_ref: f.target.project_id };
  const entity_ref = { domain: 'example.com' }, entity_key = 'fixture:product:1';
  const base = JSON.parse(fs.readFileSync(path.join(f.dir, 'snapshots/' + f.ns + '/20261017/' + f.seedData.ss + '.json'), 'utf8'));
  for (const side of ['old', 'new']) {
    const observed_at = side === 'old' ? '2026-10-16T00:00:00Z' : '2026-10-17T00:00:00Z';
    const price = side === 'new' && status === 'changed' ? 12 : 10;
    const value = { price_min: price, price_max: price, prices: [{ price }] };
    const raw = JSON.stringify({ products: [{ id: 1, handle: 'synthetic-shoe', variants: [{ id: 11, price: price.toFixed(2) }] }] });
    const rawPath = 'snapshots/' + f.ns + '/20261017/' + side + 'snapshot.raw';
    f.write(rawPath, raw);
    f.write('snapshots/' + f.ns + '/20261017/' + side + 'snapshot.json', { ...base, snapshot_id: side + 'snapshot', observed_at,
      raw_payload_ref: { path: rawPath }, raw_size: Buffer.byteLength(raw), content_hash: 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex') });
    const inherited = { schema_version: 1, tenant, entity_ref, entity_key, claim: { field: 'product.price', scope: 'public_price_observation' },
      currency: 'USD', unit: 'product', market: null, category_scope: 'shoes', source: 'shopify', provider: 'shopify_products_json', observed_at };
    f.write('evidence/' + f.ns + '/' + side + 'evidence.json', { ...inherited, evidence_id: side + 'evidence', extracted_value: value,
      evidence_status: 'verified', source_snapshot_ids: [side + 'snapshot'] });
    f.write('facts/' + f.ns + '/' + side + 'fact.json', { ...inherited, fact_id: side + 'fact', value,
      fact_type: 'public_product_price', evidence_ids: [side + 'evidence'], source_snapshot_ids: [side + 'snapshot'] });
  }
  const d = { schema_version: 1, diff_id: 'fixture-diff', tenant, entity_ref, entity_key, status,
    diff_type: 'product.price', claim: { field: 'product.price', scope: 'public_price_observation' },
    old_value: { price_min: 10, price_max: 10 }, new_value: { price_min: status === 'changed' ? 12 : 10, price_max: status === 'changed' ? 12 : 10 },
    old_currency: 'USD', new_currency: 'USD', direction: status === 'changed' ? 'increase' : null,
    delta: status === 'changed' ? 2 : null, pct: status === 'changed' ? 20 : null, reason: null, reason_detail: null, computed_at: '2026-10-17T00:00:01Z',
    old_fact_id: 'oldfact', new_fact_id: 'newfact', old_evidence_ids: ['oldevidence'], new_evidence_ids: ['newevidence'],
    old_snapshot_ids: ['oldsnapshot'], new_snapshot_ids: ['newsnapshot'], observed_at_old: '2026-10-16T00:00:00Z', observed_at_new: '2026-10-17T00:00:00Z' };
  f.write('diffs/' + f.ns + '/fixture-diff.json', d);
  f.write('events/' + f.ns + '/fixture-event.json', { ...d, event_id: 'fixture-event', event_type: 'price_change_observed',
    old_price: 10, new_price: status === 'changed' ? 12 : 10, currency: 'USD', source: 'shopify',
    provenance: { diff: { diff_id: d.diff_id, status: d.status, reason: null } }, provider: 'shopify_products_json', occurred_at: '2026-10-17T00:00:01Z' });
  return { snapshot_ids: ['newsnapshot'], source_results: [{ snapshot_id: 'newsnapshot', source_status: 'success' }],
    fact_ids: ['newfact'], diff_ids: ['fixture-diff'], event_ids: status === 'changed' ? ['fixture-event'] : [],
    comparisons: [{ fact_id: 'newfact', diff_id: 'fixture-diff', event_id: status === 'changed' ? 'fixture-event' : null, status,
      reason: status === 'changed' ? null : 'no_event_for_no_meaningful_change' }] };
}

const contentCorruptions = [
  ['fact-value', 'facts/newfact', { value: { price_min: 99999, price_max: 99999, prices: [{ price: 99999 }] } }],
  ['evidence-category', 'evidence/newevidence', { category_scope: 'bags' }],
  ['evidence-derived', 'evidence/newevidence', { evidence_status: 'derived' }],
  ['evidence-claim', 'evidence/newevidence', { claim: { field: 'product.inventory', scope: 'other' } }],
  ['evidence-entity', 'evidence/newevidence', { entity_key: 'other-product' }],
  ['evidence-currency', 'evidence/newevidence', { currency: 'JPY' }],
  ['diff-value', 'diffs/fixture-diff', { old_value: { price_min: 1000, price_max: 1000 } }],
  ['diff-currency', 'diffs/fixture-diff', { new_currency: 'JPY' }],
  ['event-value', 'events/fixture-event', { old_value: { price_min: 1000, price_max: 1000 }, old_price: 1000 }],
  ['event-direction', 'events/fixture-event', { direction: 'decrease', delta: -2, pct: -20 }],
  ['event-currency', 'events/fixture-event', { currency: 'JPY' }],
  ['fact-missing-value', 'facts/newfact', { value: null }],
  ['fact-claim', 'facts/newfact', { claim: { field: 'inventory', scope: 'other' } }],
  ['fact-type', 'facts/newfact', { fact_type: 'other' }],
  ['evidence-time', 'evidence/newevidence', { observed_at: '2026-10-16T00:00:00Z' }],
  ['evidence-unit', 'evidence/newevidence', { unit: 'case' }],
  ['evidence-market', 'evidence/newevidence', { market: 'US' }],
  ['evidence-entity-ref', 'evidence/newevidence', { entity_ref: { domain: 'example.com', product_id: 'other' } }],
  ['evidence-invalid-price', 'evidence/newevidence', { extracted_value: { price_min: 12, price_max: 12, prices: [] } }],
  ['diff-status', 'diffs/fixture-diff', { status: 'no_meaningful_change' }],
  ['diff-delta', 'diffs/fixture-diff', { delta: -2 }],
  ['diff-pct', 'diffs/fixture-diff', { pct: 21 }],
  ['diff-claim', 'diffs/fixture-diff', { claim: { field: 'inventory', scope: 'other' } }],
  ['diff-entity-ref', 'diffs/fixture-diff', { entity_ref: { domain: 'example.com', product_id: 'other' } }],
  ['event-scalar', 'events/fixture-event', { old_price: 11 }],
  ['event-entity-ref', 'events/fixture-event', { entity_ref: { domain: 'example.com', product_id: 'other' } }],
  ['event-time', 'events/fixture-event', { occurred_at: '2026-10-17T00:00:02Z' }],
  ['event-provenance', 'events/fixture-event', { provenance: { diff: { diff_id: 'other', status: 'changed', reason: null } } }],
];
for (const [name, location, mutation] of contentCorruptions) test('A-R1 rejects cross-layer content corruption: ' + name, () => {
  const f = setup();
  try {
    const input = f.finish(seedComparison(f, 'changed'));
    const [folder, id] = location.split('/'), rel = folder + '/' + f.ns + '/' + id + '.json';
    const record = JSON.parse(fs.readFileSync(path.join(f.dir, rel), 'utf8'));
    f.write(rel, { ...record, ...mutation });
    const c = f.service.recordObservation(input);
    if (['facts', 'evidence'].includes(folder)) {
      assert.deepEqual(c.fact_ids, []); assert.ok(c.issues.includes('fact_reference_unverified'));
    } else assert.deepEqual(c.fact_ids, ['newfact']);
    if (folder !== 'events') { assert.deepEqual(c.diff_ids, []); assert.ok(c.issues.includes('diff_reference_unverified')); }
    else assert.deepEqual(c.diff_ids, ['fixture-diff']);
    assert.deepEqual(c.event_ids, []); assert.deepEqual(c.comparisons, []);
    assert.ok(c.issues.includes('event_reference_unverified'));
  } finally { f.cleanup(); }
});

test('A-R1 preserves existing range arithmetic, nulls and unavailable currency comparison', () => {
  // Independent expected outputs from the frozen comparator's documented examples.
  const cases = [
    { name: 'mixed', old: [10, 20], fresh: [12, 15], direction: null, delta: null, pct: null, old_price: null, new_price: null },
    { name: 'max-only', old: [10, 20], fresh: [10, 15], direction: 'decrease', delta: -5, pct: -25, old_price: null, new_price: null },
    { name: 'zero-baseline', old: [0, 0], fresh: [12, 12], direction: 'increase', delta: 12, pct: null, old_price: 0, new_price: 12 },
    { name: 'unknown-currency', old: [10, 10], fresh: [12, 12], direction: 'increase', delta: 2, pct: 20, old_price: 10, new_price: 12, currency: null },
    { name: 'currency-unavailable', old: [10, 10], fresh: [12, 12], direction: null, delta: null, pct: null, old_price: 10, new_price: 12, new_currency: 'JPY', status: 'unavailable' },
  ];
  for (const scenario of cases) {
    const f = setup();
    try {
      const patch = seedComparison(f, 'changed');
      const update = (folder, id, values) => {
        const relative = folder + '/' + f.ns + '/' + id + '.json';
        const record = JSON.parse(fs.readFileSync(path.join(f.dir, relative), 'utf8'));
        f.write(relative, { ...record, ...values });
      };
      const currency = scenario.currency === undefined ? 'USD' : scenario.currency;
      for (const side of ['old', 'new']) {
        const [min, max] = side === 'old' ? scenario.old : scenario.fresh;
        const value = { price_min: min, price_max: max, prices: min === max ? [{ price: min }] : [{ price: min }, { price: max }] };
        const sideCurrency = side === 'new' ? scenario.new_currency ?? currency : currency;
        update('evidence', side + 'evidence', { extracted_value: value, currency: sideCurrency, unit: null, category_scope: null });
        update('facts', side + 'fact', { value, currency: sideCurrency, unit: null, category_scope: null });
        const relative = 'snapshots/' + f.ns + '/20261017/' + side + 'snapshot.json';
        const s = JSON.parse(fs.readFileSync(path.join(f.dir, relative), 'utf8'));
        const raw = JSON.stringify({ products: [{ id: 1, variants: value.prices.map((p, i) => ({ id: 11 + i, price: String(p.price) })) }] });
        f.write(s.raw_payload_ref.path, raw);
        f.write(relative, { ...s, raw_size: Buffer.byteLength(raw), content_hash: 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex') });
      }
      const status = scenario.status || 'changed', reason = status === 'unavailable' ? 'currency_mismatch' : null;
      const values = { old_value: { price_min: scenario.old[0], price_max: scenario.old[1] }, new_value: { price_min: scenario.fresh[0], price_max: scenario.fresh[1] },
        direction: scenario.direction, delta: scenario.delta, pct: scenario.pct };
      update('diffs', 'fixture-diff', { ...values, old_currency: currency, new_currency: scenario.new_currency ?? currency, status, reason });
      update('events', 'fixture-event', { ...values, currency, old_price: scenario.old_price, new_price: scenario.new_price });
      if (status === 'unavailable') {
        patch.event_ids = []; Object.assign(patch.comparisons[0], { event_id: null, status, reason: 'no_event_for_unavailable' });
      }
      const c = f.service.recordObservation(f.finish(patch));
      assert.deepEqual(c.fact_ids, ['newfact'], scenario.name); assert.deepEqual(c.diff_ids, ['fixture-diff'], scenario.name);
      assert.deepEqual(c.event_ids, patch.event_ids, scenario.name);
      assert.equal(c.comparisons[0].status, status, scenario.name);
      assert.equal(c.quiet.allowed, false);
      if (status === 'changed') assert.deepEqual(c.issues, [], scenario.name);
    } finally { f.cleanup(); }
  }
});

test('actual linked comparisons retain local no-change and changed results without promising quiet', () => {
  for (const status of ['no_meaningful_change', 'changed']) {
    const f = setup();
    try {
      const patch = seedComparison(f, status), input = f.finish(patch), c = f.service.recordObservation(input);
      assert.deepEqual(c.fact_ids, ['newfact']); assert.deepEqual(c.diff_ids, ['fixture-diff']);
      assert.deepEqual(c.event_ids, patch.event_ids);
      assert.equal(c.comparisons[0].status, status);
      assert.ok(!c.issues.includes('no_event_for_no_meaningful_change'));
      assert.equal(c.quiet.allowed, false);
      assert.equal(c.comparison_complete, null);
    } finally { f.cleanup(); }
  }
});

test('foreign evidence and substituted event proof cannot enter observed references', () => {
  for (const corruption of ['foreign-evidence', 'event-evidence', 'event-time', 'fact-snapshot-unlinked']) {
    const f = setup();
    try {
      const input = f.finish(seedComparison(f, 'changed'));
      const relative = corruption === 'foreign-evidence' ? 'evidence/' + f.ns + '/newevidence.json'
        : corruption === 'fact-snapshot-unlinked' ? 'facts/' + f.ns + '/newfact.json' : 'events/' + f.ns + '/fixture-event.json';
      const r = JSON.parse(fs.readFileSync(path.join(f.dir, relative), 'utf8'));
      if (corruption === 'foreign-evidence') r.tenant.tenant_id = 'tenant?a';
      if (corruption === 'event-evidence') r.new_evidence_ids = ['forged'];
      if (corruption === 'event-time') r.occurred_at = '2020-01-01T00:00:00Z';
      if (corruption === 'fact-snapshot-unlinked') r.source_snapshot_ids.push(f.seedData.ss);
      f.write(relative, r);
      const c = f.service.recordObservation(input);
      assert.deepEqual(c.event_ids, [], corruption);
      assert.ok(c.issues.includes('event_reference_unverified'));
      assert.equal(c.quiet.allowed, false);
    } finally { f.cleanup(); }
  }
});

test('a rejected outer commit rolls back coverage and queue completion together', () => {
  const f = setup();
  try {
    f.queue.enqueue({ tenantId: f.tenantId, watchTargetId: f.target.watch_target_id, trigger: 'monitor', scheduledAt: -7200000, windowKey: '1969-12-31:22', now: 0 });
    const job = f.queue.claim(1000), result = { source_status: 'blocked', event_ids: [], reason: 'blocked' };
    assert.throws(() => f.store.transaction(() => {
      assert.equal(f.queue.finish(job.job_id, job.claim_token, result, 1001).ok, true);
      f.service.recordObservation({ job, target: f.target, result, now: 1001 });
      throw new Error('projection fault');
    }), /projection fault/);
    assert.equal(f.service.list(f.tenantId).total, 0);
    assert.equal(f.store.getDb().prepare('SELECT status FROM monitoring_jobs WHERE job_id=?').get(job.job_id).status, 'running');
  } finally { f.cleanup(); }
});

test('comparison cannot cite an event while omitting its actual Diff association', () => {
  const f = setup();
  try {
    const patch = seedComparison(f, 'changed'); patch.comparisons[0].diff_id = null;
    const c = f.service.recordObservation(f.finish(patch));
    assert.deepEqual(c.event_ids, ['fixture-event']);
    assert.deepEqual(c.comparisons, []);
    assert.ok(c.issues.includes('comparison_reference_unverified'));
  } finally { f.cleanup(); }
});

test('snapshot partial scan survives a misleading aggregate success flag', () => {
  const f = setup();
  try {
    const input = f.finish(), relative = 'snapshots/' + f.ns + '/20261017/' + f.seedData.ss + '.json';
    const s = JSON.parse(fs.readFileSync(path.join(f.dir, relative), 'utf8'));
    f.write(relative, { ...s, partial_scan: true, partial_scan_reason: 'page_failed' });
    const c = f.service.recordObservation(input);
    assert.equal(c.partial_scan, true);
    assert.equal(c.source_results[0].partial_scan_reason, 'page_failed');
    assert.equal(c.failed_targets, 1);
    assert.ok(c.quiet.reasons.includes('partial_scan'));
    assert.equal(implementation.evaluateQuiet({ ...fullCoverage(), source_results: [{ source_status: 'success', partial_scan: true }] }).allowed, false);
  } finally { f.cleanup(); }
});

test('reference directory junction cannot escape this store root even with matching raw tenant', () => {
  const f = setup();
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-coverage-foreign-'));
  try {
    const patch = seedComparison(f, 'changed'), input = f.finish(patch);
    const own = path.join(f.dir, 'facts', f.ns);
    fs.cpSync(own, path.join(foreign, 'facts'), { recursive: true });
    fs.rmSync(own, { recursive: true });
    fs.symlinkSync(path.join(foreign, 'facts'), own, process.platform === 'win32' ? 'junction' : 'dir');
    const c = f.service.recordObservation(input);
    assert.deepEqual(c.fact_ids, []); assert.deepEqual(c.event_ids, []);
  } finally { f.cleanup(); fs.rmSync(foreign, { recursive: true, force: true }); }
});

// Complete objects below are invariant fixtures, NOT a policy producer or approved capability registry.
function fullCoverage() {
  const refs = [{ watch_target_id: 'fixture-target', revision: 1 }];
  return { expected_targets: 1, attempted_targets: 1, successful_targets: 1, qualified_successful_targets: 1, failed_targets: 0,
    expected_target_refs: refs, attempted_target_refs: refs, qualified_successful_target_refs: refs,
    required_capabilities: ['fixture-capability'], missing_capabilities: [],
    capability_results: [{ ...refs[0], capability: 'fixture-capability', complete: true, freshness_status: 'fresh', comparison_complete: true }],
    window_start: 10, window_end: 20, completed_at: 20, window_complete: true,
    policy_version: 'fixture-policy', policy_provenance: { policy_version: 'fixture-policy', approval_ref: 'fixture-only', membership_ref: 'fixture-membership', window_ref: 'fixture-window', required_capabilities: ['fixture-capability'] },
    freshness_status: 'fresh', freshness_policy_version: 'fixture-freshness', actionability_complete: true,
    actionability_policy_version: 'fixture-actionability', verified_actionable_events: 0, assessed_event_ids: [], event_ids: [],
    comparison_complete: true, partial_scan: false, source_status: 'success', source_results: [{ source_status: 'success' }], source_failures: [], issues: [] };
}

test('quiet requires finite nonempty 100% target sets and every required capability', () => {
  assert.deepEqual(implementation.evaluateQuiet(fullCoverage()), { allowed: true, reasons: [] });
  const patches = [
    { expected_targets: 100, qualified_successful_targets: 99 },
    { expected_targets: 0, attempted_targets: 0, successful_targets: 0, qualified_successful_targets: 0 },
    ...[null, undefined, NaN, Infinity, -1, 0.5, '1'].map(expected_targets => ({ expected_targets })),
    { expected_target_refs: [] }, { attempted_target_refs: [] }, { qualified_successful_target_refs: [{ watch_target_id: 'other', revision: 1 }] },
    { qualified_successful_target_refs: [{ watch_target_id: 'fixture-target', revision: 2 }] },
    { required_capabilities: null }, { required_capabilities: [] }, { missing_capabilities: null }, { missing_capabilities: ['fixture-capability'] },
    { capability_results: [] }, { capability_results: [{ watch_target_id: 'fixture-target', revision: 1, capability: 'fixture-capability', complete: true, freshness_status: 'fresh' }] },
    { failed_targets: -1 }, { failed_targets: NaN }, { attempted_targets: 2 }, { successful_targets: 2 }
  ];
  for (const patch of patches) assert.equal(implementation.evaluateQuiet({ ...fullCoverage(), ...patch }).allowed, false, JSON.stringify(patch));
});

test('quiet rejects unknown policy/window/freshness/actionability and incomplete observations', () => {
  const patches = [ { policy_version: null }, { policy_provenance: null }, { policy_provenance: { policy_version: 'other', approval_ref: 'fixture' } },
    { window_start: null }, { window_end: null }, { window_end: 5 }, { completed_at: 19 }, { window_complete: false },
    { freshness_status: null }, { freshness_status: 'stale' }, { freshness_policy_version: null },
    { actionability_complete: null }, { verified_actionable_events: 1 }, { verified_actionable_events: NaN }, { actionability_policy_version: null },
    { event_ids: ['unassessed'] }, { partial_scan: true }, { source_status: 'blocked' }, { source_results: [] }, { source_failures: null },
    { source_failures: [{ source_status: 'blocked' }] }, { issues: ['empty_catalog'] }, { issues: ['no_previous_fact'] }, { comparison_complete: null } ];
  for (const patch of patches) assert.equal(implementation.evaluateQuiet({ ...fullCoverage(), ...patch }).allowed, false, JSON.stringify(patch));
  for (const c of [null, undefined, {}, [], 1]) assert.equal(implementation.evaluateQuiet(c).allowed, false);
});
