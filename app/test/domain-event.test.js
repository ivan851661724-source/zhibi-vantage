'use strict';
// ============================================================
// M0-05 DomainEvent + Demo REST 单测（Stage 3 验收映射）
//   price_change_observed：39→29 端到端（Snapshot→Evidence→Fact→Diff→Event）；
//   Event 全链关联；no_change/unavailable 不产事件；幂等/租户；handler 只读
// 隔离：ZB_DATA_DIR 临时目录；零网络
// 规格锚点：00 v1.2 §5/§37/§42/§50/§56；02 v0.3 §10.1；03 v0.3 §17；06 v0.3
// ============================================================
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-m0-05-'));
process.env.ZB_DATA_DIR = TMP;

const Snapshot = require('../research/source-snapshot.js');
const Extract = require('../research/evidence-extract.js');
const FactStore = require('../research/fact-store.js');
const EvidenceStore = require('../research/evidence-store.js');
const Diff = require('../research/price-diff.js');
const Events = require('../research/domain-event.js');
const logger = require('../services/logger.js');

for (const k of ['debug', 'info', 'warn', 'error']) logger[k] = () => {};

const TA = 'tenant:m0evt-a';
const TB = 'tenant:m0evt-b';
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}

const PRODUCTS = (price) => JSON.stringify({
  products: [{ id: 1, handle: 'demo-product', title: 'Demo Product', product_type: 'Figures',
    variants: [{ id: 11, title: 'Standard', price: String(price) }] }],
});
function factAt(tenantId, price, at) {
  const r = Snapshot.record({ tenantId, capability: 'product_catalog', provider: 'shopify_products_json',
    source_url: 'https://example-shop.com/products.json?limit=100', source_status: 'success', error_code: null,
    observed_at: at, bodyBytes: Buffer.from(PRODUCTS(price)), partial_scan: null, partial_scan_reason: null,
    partial_scan_observed_count: null, note: null });
  assert.equal(r.recorded, true);
  const ev = Extract.extractShopifyPriceEvidence({ tenantId, snapshotId: r.meta.snapshot_id });
  assert.equal(ev.ok && !ev.unavailable, true, 'verified evidence expected');
  const fr = FactStore.recordPriceFactFromEvidence({ tenantId, evidenceId: ev.evidence_ids[0] });
  assert.equal(fr.recorded, true);
  return fr.meta;
}

// ============ 1. 39→29 端到端：detect 产 changed Diff + price_change_observed 事件 ============
t('1. End-to-end 39->29: detect -> changed diff -> price_change_observed event', () => {
  factAt(TA, '39.00', '2026-10-07T09:00:00.000Z');
  const fB = factAt(TA, '29.00', '2026-10-07T11:00:00.000Z');
  const r = Events.detectPriceChangeFromFact({ tenantId: TA, factId: fB.fact_id });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'changed');
  assert.ok(r.diff_id && r.event_id);
  const evt = Events.getEventById(TA, r.event_id);
  assert.equal(evt.event_type, 'price_change_observed');
  assert.equal(evt.old_price, 39);
  assert.equal(evt.new_price, 29);
  assert.equal(evt.direction, 'decrease');
  assert.equal(evt.delta, -10);
  assert.equal(evt.pct, -25.641);
});

// ============ 2. Event 全链关联（old/new Fact/Evidence/Snapshot/timestamps） ============
t('2. Event links old/new Fact, Evidence, SourceSnapshot, prices, timestamps', () => {
  const events = Events.listEvents(TA);
  const evt = events[0];
  assert.ok(evt.old_fact_id && evt.new_fact_id);
  assert.ok(evt.old_evidence_ids.length >= 1 && evt.new_evidence_ids.length >= 1);
  assert.ok(evt.old_snapshot_ids.length >= 1 && evt.new_snapshot_ids.length >= 1);
  assert.equal(evt.observed_at_old, '2026-10-07T09:00:00.000Z');
  assert.equal(evt.observed_at_new, '2026-10-07T11:00:00.000Z');
  assert.ok(evt.diff_id);
  // 全链逐环可解析（06 Traceability）
  const diff = Diff.getDiffById(TA, evt.diff_id);
  assert.ok(diff && diff.status === 'changed');
  const fOld = FactStore.getFactById(TA, evt.old_fact_id);
  const fNew = FactStore.getFactById(TA, evt.new_fact_id);
  assert.equal(fOld.value.price_min, 39);
  assert.equal(fNew.value.price_min, 29);
  const evOld = EvidenceStore.getEvidenceById(TA, evt.old_evidence_ids[0]);
  const snapOld = Snapshot.getById(TA, evOld.source_snapshot_ids[0]);
  assert.ok(snapOld && snapOld.snapshot_id);
  const raw = Snapshot.readRawPayload(snapOld);
  assert.ok(JSON.parse(raw.toString('utf8')).products[0].variants[0].price === '39.00');
});

// ============ 3. no_meaningful_change Diff 不产事件 ============
t('3. no_meaningful_change diff -> NO event (diff_not_changed)', () => {
  factAt(TA, '39.00', '2026-10-07T12:00:00.000Z'); // 29 -> 39（涨）
  const fC = factAt(TA, '39.00', '2026-10-07T13:00:00.000Z'); // 39 -> 39
  const r = Events.detectPriceChangeFromFact({ tenantId: TA, factId: fC.fact_id });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'no_meaningful_change');
  assert.equal(r.event_id, null);
  // 直接以 changed 之外的 diff 调事件层：诚实拒绝
  const diffSame = Diff.diffPriceFacts({ tenantId: TA, oldFactId: fC.fact_id, newFactId: fC.fact_id });
  const er = Events.recordPriceChangeEvent({ tenantId: TA, diffId: diffSame.meta.diff_id });
  assert.equal(er.recorded, false);
  assert.equal(er.reason, 'diff_not_changed');
});

// ============ 4. unavailable Diff 不产事件（也绝不当 no_change） ============
t('4. unavailable diff -> NO event (diff_unavailable); fetch_failed never no_change', () => {
  const fA = factAt(TA, '39.00', '2026-10-07T14:00:00.000Z');
  // 手工造 unavailable diff（走 M0-04 入口 B）
  const dr = Diff.diffPriceFactWithUnavailableObservation({ tenantId: TA, oldFactId: fA.fact_id, newObservation: 'unavailable', reason: 'fetch_failed' });
  assert.equal(dr.meta.status, 'unavailable');
  const er = Events.recordPriceChangeEvent({ tenantId: TA, diffId: dr.meta.diff_id });
  assert.equal(er.recorded, false);
  assert.equal(er.reason, 'diff_unavailable');
  // 该失败观察绝没有被记成任何"无变化"事件：事件列表中不存在 new_price=null 的事件
  const all = Events.listEvents(TA);
  assert.ok(!all.some(e => e.new_price == null && e.old_price === 39));
});

// ============ 5. 首次观察：无上一 Fact → 不产 Diff 不产事件 ============
t('5. First observation -> no_previous_fact (no diff, no event)', () => {
  const TB1 = 'tenant:m0evt-first';
  const f = factAt(TB1, '39.00', '2026-10-07T09:00:00.000Z');
  const r = Events.detectPriceChangeFromFact({ tenantId: TB1, factId: f.fact_id });
  assert.equal(r.ok, true);
  assert.equal(r.reason, 'no_previous_fact');
  assert.equal(r.diff_id, null);
  assert.equal(r.event_id, null);
});

// ============ 6. 幂等重试零重复 ============
t('6. Idempotent retry: same diff -> duplicate event, zero new files', () => {
  const events = Events.listEvents(TA);
  const dir = path.join(TMP, 'events', 'tenant_m0evt-a');
  const before = fs.readdirSync(dir).length;
  const again = Events.recordPriceChangeEvent({ tenantId: TA, diffId: events[0].diff_id });
  assert.equal(again.recorded, true);
  assert.equal(again.duplicate, true);
  assert.equal(fs.readdirSync(dir).length, before);
});

// ============ 7. 租户隔离 ============
t('7. Tenant isolation: events per-tenant ns; cross-tenant invisible', () => {
  const evt = Events.listEvents(TA)[0];
  assert.equal(Events.getEventById(TB, evt.event_id), null);
  const erB = Events.recordPriceChangeEvent({ tenantId: TB, diffId: evt.diff_id });
  assert.equal(erB.recorded, false);
  assert.equal(erB.reason, 'diff_not_found');
  const noTenant = Events.recordPriceChangeEvent({ tenantId: null, diffId: evt.diff_id });
  assert.equal(noTenant.reason, 'no_tenant_context');
  assert.ok(fs.existsSync(path.join(TMP, 'events', 'tenant_m0evt-a')));
});

// ============ 8. listEvents 排序（occurred_at 降序）+ limit ============
t('8. listEvents sorted by occurred_at desc, limit honored', () => {
  const all = Events.listEvents(TA);
  for (let i = 1; i < all.length; i++) {
    const a = String(all[i - 1].occurred_at || '');
    const b = String(all[i].occurred_at || '');
    assert.ok(a >= b, 'desc order');
  }
  assert.equal(Events.listEvents(TA, { limit: 1 }).length, 1);
});

// ============ 9. Demo handler：recent-changes / event-detail / evidence-detail ============
async function t9() {
  const H = require('../routes/handlers/demo.js');
  const sent = [];
  const fakeRes = { writeHead() {}, end(s) { sent.push(s); } };
  const ctx = { sendJSON: (res, code, obj) => { sent.push({ code, obj }); return obj; } };
  // ALS 注入租户上下文（复用 requestScope）
  const als = require('../core/als.js');
  await als.requestScope.run(TA, async () => {
    const s = sent.length;
    await H.recentChanges(ctx, { method: 'GET' }, fakeRes, new URL('http://x/api/demo/recent-changes'), '/api/demo/recent-changes');
    const recent = sent[sent.length - 1];
    assert.equal(recent.code, 200);
    assert.ok(recent.obj.events.length >= 1);
    assert.ok(recent.obj.summary.total >= 1);
    const evt = recent.obj.events[0];
    // event-detail
    await H.eventDetail(ctx, { method: 'GET' }, fakeRes, new URL('http://x/api/demo/event-detail?id=' + evt.event_id), '/api/demo/event-detail');
    const detail = sent[sent.length - 1];
    assert.equal(detail.code, 200);
    assert.ok(detail.obj.event && detail.obj.diff && detail.obj.facts.old && detail.obj.facts.new);
    assert.ok(detail.obj.evidences.length >= 2);
    assert.ok(detail.obj.snapshots.length >= 2);
    // evidence-detail
    await H.evidenceDetail(ctx, { method: 'GET' }, fakeRes, new URL('http://x/api/demo/evidence-detail?id=' + evt.new_evidence_ids[0]), '/api/demo/evidence-detail');
    const evDetail = sent[sent.length - 1];
    assert.equal(evDetail.code, 200);
    assert.equal(evDetail.obj.evidence.evidence_status, 'verified');
    assert.ok(evDetail.obj.snapshots.length >= 1);
    // 404 诚实
    await H.eventDetail(ctx, { method: 'GET' }, fakeRes, new URL('http://x/api/demo/event-detail?id=evt_missing'), '/api/demo/event-detail');
    assert.equal(sent[sent.length - 1].code, 404);
  });
}

// ============ 10. 路由注册存在（防漏接） ============
t('10. Demo routes registered in registry', () => {
  const registry = require('../routes/registry.js');
  require('../routes/index.js'); // 加载即注册
  const list = registry.list();
  for (const p of ['/api/demo/recent-changes', '/api/demo/event-detail', '/api/demo/evidence-detail']) {
    assert.ok(list.some(r => r.path === p && r.auth === 'tenant'), 'missing route ' + p);
  }
});

// ============ 11. 零 LLM 零网络（静态断言） ============
t('11. No LLM / no network in event+handler layer (static assertion)', () => {
  for (const f of ['research/domain-event.js', 'routes/handlers/demo.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    assert.equal(/fetch\(|XMLHttpRequest|axios|node-fetch|openai|deepseek|dashscope|bailian/i.test(src), false, f);
  }
});

// ============ 12. Event 无业务判断语义（分层不越权） ============
t('12. Event carries no judgment language (what changed, not what it means)', () => {
  const evt = Events.listEvents(TA)[0];
  const s = JSON.stringify(evt);
  assert.equal(/建议|判断|竞争压力|解读|insight|judgment/i.test(s), false);
  assert.equal(evt.derivation_version, 'domain-event-1');
  assert.equal(evt.algorithm_version, null);
});

// ============ 汇总（T9 async 最后跑） ============
(async () => {
  try { await t9(); passed++; console.log('ok - 9. Demo REST handlers assemble full chain read-only'); }
  catch (e) { failed++; console.error('FAIL - 9. Demo REST handlers: ' + String(e.message || e).split('\n')[0]); }
  console.log('\ndomain-event.test: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
})();
