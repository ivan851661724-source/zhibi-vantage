'use strict';
// M1 A: real append-only stores; only DNS/HTTP are mocked; no runtime data/config.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-price-context-'));
process.env.ZB_DATA_DIR = TMP;
process.env.MT_STORE_PATH = path.join(TMP, 'tenants.json');
process.env.CACHE_ENABLED = '0';
const Snapshot = require('../research/source-snapshot.js');
const Evidence = require('../research/evidence-store.js');
const Extract = require('../research/evidence-extract.js');
const Fact = require('../research/fact-store.js');
const Diff = require('../research/price-diff.js');
const Event = require('../research/domain-event.js');
const Net = require('../research/net.js');
const { sanitizeNs } = require('../core/state-store.js');
const logger = require('../services/logger.js');
for (const k of ['debug', 'info', 'warn', 'error']) logger[k] = () => {};
const TA = 'tenant:m1-context', TB = 'tenant:m1-other';
const WHEN = '2026-10-17T01:00:00.000Z';
const rawProducts = JSON.stringify({ products: [{ id: 1, title: 'Sample', variants: [
  { id: 11, price: '0.00', available: true },
  { id: 12, price: '29.00', available: false },
  { id: 13, price: '99.00' },
  { id: 14, price: '-1.00', available: 'true' },
] }] });
function snapshot(body, overrides = {}) {
  return Snapshot.record({ tenantId: TA, capability: 'product_catalog', provider: 'shopify_products_json',
    source_url: 'https://example.com/products.json?limit=250&page=1', source_status: 'success',
    observed_at: WHEN, fetched_at: WHEN, projectRef: 'project-one', bodyBytes: body == null ? null : Buffer.from(body), ...overrides }).meta;
}
function cart(overrides = {}, body = '{ "currency": "USD" }\n') {
  return snapshot(body, { provider: 'shopify_cart_js_json', capability: 'storefront_currency', source_url: 'https://example.com/cart.js', ...overrides });
}
function extract(s, c, extra = {}) {
  return Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: s.snapshot_id,
    ...(c ? { currencySnapshotId: c.snapshot_id } : {}), projectRef: 'project-one', ...extra });
}
function evOf(r) { assert.equal(r.ok, true, r.reason); return Evidence.getEvidenceById(TA, r.evidence_ids[0]); }
function factOf(r) { const f = Fact.recordPriceFactFromEvidence({ tenantId: TA, evidenceId: evOf(r).evidence_id }); assert.equal(f.recorded, true); return f.meta; }
const tests = [];
function t(name, fn) { tests.push([name, fn]); }
t('availability survives raw → Evidence → Fact without filtering any original numeric price', () => {
  const s = snapshot(rawProducts), r = extract(s), ev = evOf(r), fact = factOf(r);
  assert.deepEqual(ev.extracted_value.prices.map(p => p.available), [true, false, null, null]);
  assert.deepEqual(fact.value.prices.map(p => p.available), [true, false, null, null]);
  assert.deepEqual(fact.value.prices.map(p => p.price), [0, 29, 99, -1]);
  assert.equal(fact.value.price_min, -1); assert.equal(fact.value.price_max, 99);
  assert.equal(fact.fact_type, 'public_product_price');
  assert.equal(fact.claim.scope, 'public_price_observation');
});
t('same tenant/domain/batch/project cart raw proves currency with two resolvable snapshots', () => {
  const s = snapshot(rawProducts), c = cart(), ev = evOf(extract(s, c, { currency: 'EUR' }));
  assert.equal(ev.currency, 'USD'); assert.deepEqual(ev.source_snapshot_ids, [s.snapshot_id, c.snapshot_id]);
  assert.equal(ev.provenance.snapshots.length, 2);
  assert.equal(factOf(extract(s, c)).currency, 'USD');
});
t('legacy single-snapshot extraction never borrows caller currency', () => {
  const ev = evOf(extract(snapshot(rawProducts), null, { currency: 'USD', market: 'US' }));
  assert.equal(ev.currency, null); assert.equal(ev.source_snapshot_ids.length, 1);
});
t('paired snapshot project survives an omitted caller projectRef', () => {
  const s = snapshot(rawProducts), c = cart();
  const r = Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: s.snapshot_id, currencySnapshotId: c.snapshot_id });
  assert.equal(evOf(r).tenant.project_ref, 'project-one');
  assert.equal(factOf(r).tenant.project_ref, 'project-one');
});
t('wrong source/tenant/domain/batch/project references explicitly fail without creating Evidence', () => {
  const s = snapshot(rawProducts);
  const cases = [
    [cart({ provider: 'other' }), 'currency_snapshot_source_mismatch'],
    [cart({ capability: 'evidence_url' }), 'currency_snapshot_source_mismatch'],
    [cart({ source_url: 'https://elsewhere.com/cart.js' }), 'currency_snapshot_domain_mismatch'],
    [cart({ final_url: 'https://elsewhere.com/cart.js' }), 'currency_snapshot_domain_mismatch'],
    [cart({ source_url: 'https://example.com/welcome' }), 'currency_snapshot_source_mismatch'],
    [cart({ fetched_at: '2026-10-16T00:00:00Z' }), 'currency_snapshot_batch_mismatch'],
    [cart({ projectRef: 'project-two' }), 'currency_snapshot_project_mismatch'],
    [cart({ tenantId: TB }), 'currency_snapshot_not_found'],
  ];
  for (const [c, reason] of cases) {
    const r = extract(s, c); assert.equal(r.ok, false); assert.equal(r.reason, reason);
  }
  assert.equal(Evidence.findEvidenceBySnapshot(TA, s.snapshot_id).length, 0);
  assert.equal(extract(s, cart(), { projectRef: 'wrong-caller-project' }).reason, 'currency_snapshot_project_mismatch');
});
t('product redirect to another storefront cannot receive source-domain currency', () => {
  const s = snapshot(rawProducts, { final_url: 'https://elsewhere.com/products.json' });
  assert.equal(extract(s, cart()).reason, 'currency_snapshot_domain_mismatch');
});
t('same-domain redirect to a collection product path refuses pairing without creating Evidence', () => {
  const s = snapshot(rawProducts, { final_url: 'https://example.com/collections/discount/products.json' });
  const r = extract(s, cart());
  assert.equal(r.ok, false); assert.equal(r.reason, 'currency_snapshot_source_mismatch');
  assert.equal(Evidence.findEvidenceBySnapshot(TA, s.snapshot_id).length, 0);
});
t('same product endpoint with only final query changed still accepts paired currency', () => {
  const s = snapshot(rawProducts, { final_url: 'https://example.com/products.json?limit=250&page=1&locale=en' });
  const c = cart(), ev = evOf(extract(s, c));
  assert.equal(ev.currency, 'USD');
  assert.deepEqual(ev.source_snapshot_ids, [s.snapshot_id, c.snapshot_id]);
});
t('failed or malformed cart keeps price Evidence but never references unverifiable currency raw', () => {
  const cases = [
    [cart({ source_status: 'timeout' }, null), 'currency_source_unavailable'],
    [cart({ source_status: 'blocked' }, 'blocked'), 'currency_source_unavailable'],
    [cart({}, 'not JSON'), 'currency_raw_json_parse_failed'],
    [cart({}, '{}'), 'currency_missing'],
    [cart({}, '{"currency":true}'), 'currency_invalid'],
    [cart({}, null), 'currency_raw_unresolvable'],
  ];
  for (const [c, reason] of cases) {
    const s = snapshot(rawProducts), r = extract(s, c), ev = evOf(r);
    assert.equal(r.currency_reason, reason); assert.equal(ev.currency, null);
    assert.deepEqual(ev.source_snapshot_ids, [s.snapshot_id]);
    assert.ok(Snapshot.getById(TA, c.snapshot_id), 'failed cart remains stored');
  }
});
t('truncated cart raw is retained as a failed currency source, never treated as complete proof', () => {
  process.env.ZB_SNAPSHOT_MAX_BYTES = '10';
  let c;
  try { c = cart(); } finally { delete process.env.ZB_SNAPSHOT_MAX_BYTES; }
  const s = snapshot(rawProducts), r = extract(s, c);
  assert.equal(c.raw_truncated, true); assert.equal(r.currency_reason, 'currency_raw_truncated');
  assert.equal(evOf(r).currency, null); assert.deepEqual(evOf(r).source_snapshot_ids, [s.snapshot_id]);
});
t('new extraction versions append a new Fact while old missing-availability Fact remains byte identical and readable', () => {
  const s = snapshot(rawProducts);
  const legacyValue = { price_min: -1, price_max: 99, prices: [
    { variant_id: '11', title: null, price: 0 }, { variant_id: '12', title: null, price: 29 },
    { variant_id: '13', title: null, price: 99 }, { variant_id: '14', title: null, price: -1 },
  ] };
  const oldEv = Evidence.recordEvidence({ tenantId: TA, source_snapshot_ids: [s.snapshot_id],
    claim: { field: 'product.price', scope: 'public_price_observation' }, extracted_value: legacyValue,
    evidence_status: 'verified', source: 'shopify', provider: 'shopify_products_json', entity_key: 'shopify_product:1',
    parser_version: 'shopify-products-json-1', extractor_version: 'evidence-extract-1', projectRef: 'project-one' }).meta;
  const legacy = { fact_id: 'fact_legacy_context', derivation_version: 'fact-extract-1', value: legacyValue,
    evidence_ids: [oldEv.evidence_id], source_snapshot_ids: [s.snapshot_id] };
  const dir = path.join(TMP, 'facts', sanitizeNs(TA)); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, legacy.fact_id + '.json'), bytes = JSON.stringify(legacy);
  fs.writeFileSync(file, bytes);
  const r = extract(s), f = factOf(r);
  assert.notEqual(r.evidence_ids[0], oldEv.evidence_id, 'new version must not deduplicate to old missing fields');
  assert.notEqual(f.derivation_version, 'fact-extract-1');
  assert.equal(Fact.getFactById(TA, legacy.fact_id).value.prices[0].available, undefined);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(factOf(extract(s)).fact_id, f.fact_id, 'same-version replay still idempotent');
});
t('currency null → USD is unavailable comparison and creates no price event', () => {
  const a = factOf(extract(snapshot(rawProducts)));
  const b = factOf(extract(snapshot(rawProducts), cart()));
  const d = Diff.diffPriceFacts({ tenantId: TA, oldFactId: a.fact_id, newFactId: b.fact_id });
  assert.equal(d.meta.status, 'unavailable'); assert.equal(d.meta.reason, 'currency_mismatch');
  assert.equal(Event.recordPriceChangeEvent({ tenantId: TA, diffId: d.meta.diff_id }).recorded, false);
});
t('availability-only change keeps raw price comparison and generates no price event', () => {
  const a = factOf(extract(snapshot(rawProducts), cart()));
  const changed = rawProducts.replace('"available":true', '"available":false');
  const b = factOf(extract(snapshot(changed), cart()));
  assert.equal(b.value.prices[0].available, false);
  const d = Diff.diffPriceFacts({ tenantId: TA, oldFactId: a.fact_id, newFactId: b.fact_id });
  assert.equal(d.meta.status, 'no_meaningful_change');
  assert.equal(Event.recordPriceChangeEvent({ tenantId: TA, diffId: d.meta.diff_id }).recorded, false);
});
const originalLookup = dns.promises.lookup;
const httpsMod = require('node:https');
const { EventEmitter } = require('events');
const originalRequest = httpsMod.request;
// SC-02 r3：net.js 经 safeRequest（node:https 直连）抓取，打桩下沉到 https.request。
// respond(status, body, headers) 组装一次响应；不返回则按 200/空体处理。
function stubHttps(route) {
  httpsMod.request = function (opts, cb) {
    const req = new EventEmitter();
    req.setTimeout = () => {}; req.destroy = () => {};
    req.end = () => {
      const u = new URL('https://' + (opts.hostname || opts.host) + (opts.path || '/'));
      let r = null;
      try { r = route(u, req) || {}; } catch (e) { process.nextTick(() => req.emit('error', e)); return; }
      if (r.error) { process.nextTick(() => req.emit('error', r.error)); return; }
      const res = new EventEmitter();
      res.statusCode = r.status == null ? 200 : r.status;
      res.headers = Object.assign({ 'content-type': 'application/json' }, r.headers);
      process.nextTick(() => { cb(res); if (r.body != null) res.emit('data', Buffer.from(r.body)); res.emit('end'); });
    };
    return req;
  };
}
t('existing cart request stores exact raw and returns separate currencySnapshotId without extra HTTP calls', async () => {
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const cartRaw = '{  "currency" : "usd", "items": [] }\n'; const calls = [];
  stubHttps(u => { calls.push(u.pathname);
    return { body: u.pathname === '/cart.js' ? cartRaw : rawProducts }; });
  try {
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA, projectRef: 'network-project' });
    assert.equal(out.currency, 'USD'); assert.equal(calls.length, 2);
    assert.deepEqual(calls.slice().sort(), ['/cart.js', '/products.json']);
    assert.ok(out.currencySnapshotId); assert.deepEqual(out.snapshotIds, [out.snapshotId]);
    const c = Snapshot.getById(TA, out.currencySnapshotId), s = Snapshot.getById(TA, out.snapshotId);
    assert.equal(Snapshot.readRawPayload(c).toString(), cartRaw);
    assert.equal(c.fetched_at, s.fetched_at); assert.equal(c.tenant.project_ref, 'network-project');
    assert.equal(c.parser_version, null); assert.equal(c.source_status, 'success');
    assert.equal(evOf(Extract.extractShopifyPriceEvidence({ tenantId: TA, snapshotId: out.snapshotId,
      currencySnapshotId: out.currencySnapshotId, projectRef: 'network-project' })).currency, 'USD');
  } finally { httpsMod.request = originalRequest; }
});
t('HTTP/parse/network cart failure snapshots retain failure/raw and never provide fake currency', async () => {
  for (const kind of ['http', 'parse', 'network']) {
    stubHttps(u => {
      if (u.pathname !== '/cart.js') return { body: rawProducts };
      if (kind === 'network') return { error: new Error('cart_down') };
      return kind === 'parse' ? { body: 'broken JSON' } : { status: 403, body: 'blocked' };
    });
    try {
      const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA });
      assert.equal(out.currency, null); assert.ok(out.currencySnapshotId);
      const c = Snapshot.getById(TA, out.currencySnapshotId);
      assert.equal(c.source_status, { http: 'blocked', parse: 'parse_failed', network: 'internal_error' }[kind]);
      assert.equal(c.raw_payload_ref === null, kind === 'network');
      assert.equal(out.snapshotIds.length, 1);
    } finally { httpsMod.request = originalRequest; }
  }
});
t('product first-page parse failure still completes and exposes existing cart snapshot', async () => {
  stubHttps(u => ({ body: u.pathname === '/cart.js' ? '{"currency":"USD"}' : 'broken' }));
  try {
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA });
    assert.equal(out.ok, false); assert.ok(out.currencySnapshotId);
    assert.equal(Snapshot.getById(TA, out.currencySnapshotId).source_status, 'success');
  } finally { httpsMod.request = originalRequest; }
});
t('provenance stays pinned to validated request URLs; redirects are re-validated per hop', async () => {
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
  // 公网 302（cart → elsewhere 公网）：逐跳校验后跟随；快照 source_url 仍钉在请求 URL，
  // final_url 不伪造（SC-02 r3：无逐跳 final 记录时宁缺毋假）。
  let hop = 0;
  stubHttps(u => {
    if (u.pathname === '/cart.js' && hop === 0) { hop = 1; return { status: 302, headers: { location: 'https://elsewhere.com/cart.js' } }; }
    return { body: u.pathname === '/cart.js' ? '{"currency":"USD"}' : rawProducts };
  });
  try {
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA });
    const cm = Snapshot.getById(TA, out.currencySnapshotId);
    assert.equal(cm.source_url, 'https://example.com/cart.js');
    assert.equal(cm.final_url, null);
    assert.equal(out.currency, 'USD');
  } finally { httpsMod.request = originalRequest; hop = 0; }
  // 公网 302 → 私网：第二跳 assertPublicUrl 连接前拒绝（SSRF_BLOCKED 整体拒绝，不做 partial 收束）
  stubHttps(() => ({ status: 302, headers: { location: 'http://127.0.0.1/private' } }));
  try {
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA });
    assert.equal(out.ok, false);
    assert.ok(/SSRF_BLOCKED/.test(String(out.error)), '私网重定向被拒: ' + out.error);
  } finally { httpsMod.request = originalRequest; }
});
(async () => {
  let failed = 0;
  try { for (const [name, fn] of tests) { try { await fn(); console.log('ok - ' + name); }
    catch (e) { failed++; console.error('FAIL - ' + name + '\n' + e.stack); } } }
  finally { httpsMod.request = originalRequest; dns.promises.lookup = originalLookup; fs.rmSync(TMP, { recursive: true, force: true }); }
  console.log(`=== price-fact-context.test: ${tests.length - failed} passed, ${failed} failed ===`);
  process.exitCode = failed ? 1 : 0;
})();
