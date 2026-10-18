'use strict';
// Actual handler + actual file stores + ALS. Synthetic metadata only; no network/config/production DB.
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-event-detail-scope-'));
process.env.ZB_DATA_DIR = TMP;
delete process.env.MT_STORE_PATH;
delete process.env.OBS_DB_PATH;
let networkCalls = 0;
const noNetwork = () => { networkCalls++; throw new Error('Network forbidden in event-detail scope test'); };
global.fetch = noNetwork;
for (const name of ['node:http', 'node:https']) {
  const transport = require(name); transport.request = noNetwork; transport.get = noNetwork;
}
require('node:net').Socket.prototype.connect = noNetwork;
require('node:tls').connect = noNetwork;
const H = require('../routes/handlers/demo.js');
const als = require('../core/als.js');
const owner = 'tenant:review';
let rows;
function file(kind, id) {
  return path.join(TMP, kind, 'tenant_review', kind === 'snapshots' ? '2026-10-17' : '', id + '.json');
}
function save(kind, id, value) {
  const dest = file(kind, id); fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(value));
}
function fixture(project = 'project-a') {
  const tenant = { tenant_id: owner, project_ref: project };
  const refs = { old_fact_id: 'fact_old', new_fact_id: 'fact_new', old_evidence_ids: ['ev_old'],
    new_evidence_ids: ['ev_new'], old_snapshot_ids: ['ss_old'], new_snapshot_ids: ['ss_new'] };
  rows = {
    events: { evt_review: { event_id: 'evt_review', event_type: 'price_change_observed', tenant, diff_id: 'diff_review', ...refs,
      old_value: { price_min: 10, price_max: 10 }, new_value: { price_min: 12, price_max: 12 },
      direction: 'increase', pct: 20, currency: null, provenance: { diff: { diff_id: 'diff_review', status: 'changed', reason: null } } } },
    diffs: { diff_review: { diff_id: 'diff_review', tenant, ...refs, status: 'changed', reason: null } },
    facts: {}, evidence: {}, snapshots: {},
  };
  for (const side of ['old', 'new']) {
    rows.snapshots['ss_' + side] = { snapshot_id: 'ss_' + side, tenant, capability: 'product_catalog', provider: 'fixture',
      source_url: 'https://fixture.invalid/' + side, source_status: 'success', observed_at: '2026-10-17T00:00:00Z',
      content_hash: 'sha256:fixture', collector_version: 'fixture-1', raw_payload_ref: { path: '/server/private/' + side } };
    const snapshotRef = { ...rows.snapshots['ss_' + side] }; delete snapshotRef.tenant;
    rows.evidence['ev_' + side] = { evidence_id: 'ev_' + side, tenant, source_snapshot_ids: ['ss_' + side],
      evidence_status: 'verified', parser_version: 'fixture-1', extractor_version: 'fixture-1',
      provenance: { snapshots: [snapshotRef] } };
    rows.facts['fact_' + side] = { fact_id: 'fact_' + side, tenant, evidence_ids: ['ev_' + side], source_snapshot_ids: ['ss_' + side],
      value: { price_min: side === 'old' ? 10 : 12, price_max: side === 'old' ? 10 : 12 },
      provenance: { evidence: { evidence_id: 'ev_' + side, evidence_status: 'verified', parser_version: 'fixture-1', extractor_version: 'fixture-1' }, snapshots: [snapshotRef] } };
  }
  for (const [kind, values] of Object.entries(rows)) for (const [id, row] of Object.entries(values)) save(kind, id, row);
}
async function read(tenant = owner, id = 'evt_review') {
  let sent;
  await als.requestScope.run(tenant, () => H.eventDetail({ sendJSON(_res, status, body) { sent = { status, body }; } },
    { method: 'GET' }, {}, new URL('https://fixture.invalid/api/demo/event-detail' + (id == null ? '' : '?id=' + encodeURIComponent(id))), '/api/demo/event-detail'));
  assert.equal(networkCalls, 0);
  return sent;
}
function edit(kind, id, change) { change(rows[kind][id]); save(kind, id, rows[kind][id]); }
beforeEach(() => fixture());

test('valid owned full chain retains response and observed display without raw paths', async () => {
  const { status, body } = await read();
  assert.equal(status, 200); assert.equal(body.event.event_id, 'evt_review');
  assert.equal(body.diff.diff_id, 'diff_review'); assert.equal(body.facts.old.value.price_min, 10);
  assert.equal(body.facts.new.value.price_max, 12); assert.equal(body.event.display.change_label, '上升 20%');
  assert.equal(body.evidences.length, 2); assert.equal(body.snapshots.length, 2);
  assert.equal(body.facts.old.provenance.evidence.evidence_id, 'ev_old');
  assert.equal(body.facts.old.provenance.snapshots[0].snapshot_id, 'ss_old');
  assert.equal(JSON.stringify(body).includes('raw_payload_ref'), false);
  assert.equal('issues' in body, false); assert.equal('raw_resolvable' in body.snapshots[0], false);
});
test('historical null or missing project remains readable when the chain shares that scope', async () => {
  fixture(null); assert.equal((await read()).body.facts.old.fact_id, 'fact_old');
  for (const [kind, values] of Object.entries(rows)) for (const [id, row] of Object.entries(values)) {
    delete row.tenant.project_ref; save(kind, id, row);
  }
  const { body } = await read(); assert.equal(body.diff.diff_id, 'diff_review'); assert.equal(body.snapshots.length, 2);
});
test('missing child objects degrade to null/omission without losing owned Event', async () => {
  for (const [kind, id] of [['diffs', 'diff_review'], ['facts', 'fact_old'], ['evidence', 'ev_old'], ['snapshots', 'ss_old']]) fs.unlinkSync(file(kind, id));
  const { status, body } = await read(); assert.equal(status, 200); assert.equal(body.diff, null);
  assert.equal(body.facts.old, null); assert.equal(body.facts.new.fact_id, 'fact_new');
  assert.deepEqual(body.evidences.map(x => x.evidence_id), ['ev_new']);
  assert.deepEqual(body.snapshots.map(x => x.snapshot_id), ['ss_new']);
});
test('sanitized namespace alias cannot read the original tenant Event', async () => {
  const r = await read('tenant_review'); assert.equal(r.status, 404); assert.equal(r.body.event, undefined);
});
test('Event content ID must match requested filename ID', async () => {
  edit('events', 'evt_review', x => { x.event_id = 'evt_other'; }); assert.equal((await read()).status, 404);
});
for (const [kind, id, key, section] of [['diffs', 'diff_review', 'diff_id', 'diff'], ['facts', 'fact_old', 'fact_id', 'facts'],
  ['evidence', 'ev_old', 'evidence_id', 'evidences'], ['snapshots', 'ss_old', 'snapshot_id', 'snapshots']]) {
  for (const mode of ['foreign tenant', 'wrong project', 'wrong ID', 'missing tenant']) {
    test(kind + ' rejects ' + mode + ' without leaking embedded copies', async () => {
      edit(kind, id, x => {
        if (mode === 'foreign tenant') x.tenant = { tenant_id: 'tenant_review', project_ref: 'project-a' };
        if (mode === 'wrong project') x.tenant = { tenant_id: owner, project_ref: 'project-b' };
        if (mode === 'wrong ID') x[key] = id + '_other';
        if (mode === 'missing tenant') delete x.tenant;
        x.marker = 'FOREIGN_SECRET';
      });
      const { status, body } = await read(); assert.equal(status, 200);
      if (section === 'diff') assert.equal(body.diff, null);
      else if (section === 'facts') assert.equal(body.facts.old, null);
      else assert.equal(body[section].some(x => x[key] === id || x[key] === id + '_other'), false);
      assert.equal(JSON.stringify(body).includes('FOREIGN_SECRET'), false);
      if (kind === 'evidence') assert.equal(body.facts.old.provenance.evidence, null);
      if (kind === 'snapshots') {
        assert.deepEqual(body.facts.old.provenance.snapshots, []);
        assert.deepEqual(body.evidences.find(x => x.evidence_id === 'ev_old').provenance.snapshots, []);
      }
    });
  }
}
for (const [kind, id, field, value] of [['diffs', 'diff_review', 'old_fact_id', 'fact_new'],
  ['diffs', 'diff_review', 'old_evidence_ids', ['ev_new']], ['diffs', 'diff_review', 'old_snapshot_ids', ['ss_new']],
  ['facts', 'fact_old', 'evidence_ids', ['ev_new']], ['facts', 'fact_old', 'source_snapshot_ids', ['ss_new']],
  ['evidence', 'ev_old', 'source_snapshot_ids', ['ss_new']]]) {
  test(kind + ' with conflicting ' + field + ' binding is omitted', async () => {
    edit(kind, id, x => { x[field] = value; x.marker = 'WRONG_BINDING'; });
    assert.equal(JSON.stringify((await read()).body).includes('WRONG_BINDING'), false);
  });
}
test('embedded provenance cannot carry foreign metadata even under a valid referenced ID', async () => {
  const foreign = { tenant: { tenant_id: 'other', project_ref: 'other' }, marker: 'NESTED_FOREIGN', secret: { raw_payload_ref: { path: '/server/secret' } } };
  edit('facts', 'fact_old', x => { x.provenance.evidence = { evidence_id: 'ev_old', ...foreign }; x.provenance.snapshots = [{ snapshot_id: 'ss_old', ...foreign }]; });
  edit('evidence', 'ev_old', x => { x.provenance.snapshots = [{ snapshot_id: 'ss_old', ...foreign }]; });
  edit('events', 'evt_review', x => { x.provenance.diff = { diff_id: 'diff_review', ...foreign }; });
  const { body } = await read(); assert.equal(JSON.stringify(body).includes('NESTED_FOREIGN'), false);
  assert.equal(JSON.stringify(body).includes('/server/secret'), false);
  assert.equal(body.facts.old.provenance.evidence.evidence_id, 'ev_old');
});
test('unknown nested provenance and recursive raw fields cannot bypass the projection', async () => {
  for (const [kind, values] of Object.entries(rows)) for (const id of Object.keys(values)) edit(kind, id, x => {
    x.extra = { nested: [{ raw_payload_ref: { path: '/server/raw-secret' }, keep: true }] };
    x.provenance = { ...x.provenance, foreign: { marker: 'PROVENANCE_SECRET', tenant: { tenant_id: 'other' } } };
  });
  const { body } = await read(); const encoded = JSON.stringify(body);
  assert.equal(encoded.includes('raw_payload_ref'), false); assert.equal(encoded.includes('/server/raw-secret'), false);
  assert.equal(encoded.includes('PROVENANCE_SECRET'), false); assert.equal(body.event.extra.nested[0].keep, true);
});
test('anonymous, missing, malformed and absent IDs retain existing HTTP behavior', async () => {
  assert.equal((await read(null)).status, 401); assert.equal((await read(owner, null)).status, 400);
  assert.equal((await read(owner, '../evt_review')).status, 400); assert.equal((await read(owner, 'evt_missing')).status, 404);
});
