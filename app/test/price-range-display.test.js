'use strict';
// ============================================================
// P1 下游整改集成测试（2026-10-08 最终审核）：价格区间变化的三层一致表达
//   Diff（judge v2）→ DomainEvent（old/new_value 完整区间；old_price/new_price
//   仅单一价承载）→ API projection（display 展示视图 + AI payload 区间字段）。
// 禁止回归：10–20 → 10–15 不得再产出「10 → 10，下降 25%」式自相矛盾数据；
// 单一价 39→29 行为完全不变；direction=null 时 delta/pct 为 null（绝不用 0 冒充）。
// 隔离：ZB_DATA_DIR 临时目录；零网络、零 LLM。
// ============================================================
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-p1-range-'));
process.env.ZB_DATA_DIR = TMP;

const Snapshot = require('../research/source-snapshot.js');
const Extract = require('../research/evidence-extract.js');
const FactStore = require('../research/fact-store.js');
const Diff = require('../research/price-diff.js');
const Events = require('../research/domain-event.js');
const Demo = require('../routes/handlers/demo.js');
const logger = require('../services/logger.js');

for (const k of ['debug', 'info', 'warn', 'error']) logger[k] = () => {};

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}

// 区间商品：两个变体价格 min/max
const RANGE_PRODUCTS = (lo, hi) => JSON.stringify({
  products: [{ id: 1, handle: 'range-product', title: 'Range Product', product_type: 'Figures',
    variants: [{ id: 11, title: 'Small', price: String(lo) }, { id: 12, title: 'Large', price: String(hi) }] }],
});
const SINGLE_PRODUCTS = (p) => JSON.stringify({
  products: [{ id: 1, handle: 'single-product', title: 'Single Product', product_type: 'Figures',
    variants: [{ id: 11, title: 'Standard', price: String(p) }] }],
});

function factFrom(tenantId, body, at) {
  const r = Snapshot.record({ tenantId, capability: 'product_catalog', provider: 'shopify_products_json',
    source_url: 'https://example-shop.com/products.json?limit=100', source_status: 'success', error_code: null,
    observed_at: at, bodyBytes: Buffer.from(body), partial_scan: null, partial_scan_reason: null,
    partial_scan_observed_count: null, note: null });
  assert.equal(r.recorded, true);
  const ev = Extract.extractShopifyPriceEvidence({ tenantId, snapshotId: r.meta.snapshot_id });
  assert.equal(ev.ok && !ev.unavailable, true, 'verified evidence expected');
  const fr = FactStore.recordPriceFactFromEvidence({ tenantId, evidenceId: ev.evidence_ids[0] });
  assert.equal(fr.recorded, true);
  return fr.meta;
}

// 场景装配：同租户两次观察 → detect → Diff + Event。返回事件 meta。
function scenario(tenantId, oldBody, newBody, atOld, atNew) {
  const fA = factFrom(tenantId, oldBody, atOld);
  const fB = factFrom(tenantId, newBody, atNew);
  const r = Events.detectPriceChangeFromFact({ tenantId, factId: fB.fact_id });
  assert.equal(r.ok, true, 'detect ok: ' + (r.reason || ''));
  assert.equal(r.status, 'changed');
  assert.ok(r.event_id);
  return Events.getEventById(tenantId, r.event_id);
}

// ============ 1. 区间事件：old/new_value 完整保留，绝无「10 → 10」 ============
t('1. Range event keeps full old/new_value; old_price/new_price null (no "10 -> 10")', () => {
  const evt = scenario('tenant:p1-maxdown', RANGE_PRODUCTS(10, 20), RANGE_PRODUCTS(10, 15),
    '2026-10-07T09:00:00.000Z', '2026-10-07T11:00:00.000Z');
  // 区间字段完整（整改要求 1）
  assert.deepStrictEqual(evt.old_value, { price_min: 10, price_max: 20 });
  assert.deepStrictEqual(evt.new_value, { price_min: 10, price_max: 15 });
  // 不再用 price_min 冒充区间（整改要求 2）：10–20→10–15 绝不产出 old_price=10/new_price=10
  assert.equal(evt.old_price, null, 'old_price must be null for range prices');
  assert.equal(evt.new_price, null, 'new_price must be null for range prices');
  // 方向语义与 Diff 一致（decrease，delta=-5，pct=-25）
  assert.equal(evt.direction, 'decrease');
  assert.equal(evt.delta, -5);
  assert.equal(evt.pct, -25);
  // 事件对象里不存在自相矛盾的「10 → 10」表达
  const s = JSON.stringify(evt);
  assert.equal(s.includes('"old_price":10'), false);
  assert.equal(s.includes('"new_price":10'), false);
});

// ============ 2. 单一价 39–39 → 29–29 兼容性完全不变 ============
t('2. Single price 39->29 unchanged: old_price=39, new_price=29, pct=-25.641', () => {
  const evt = scenario('tenant:p1-single', SINGLE_PRODUCTS('39.00'), SINGLE_PRODUCTS('29.00'),
    '2026-10-07T09:00:00.000Z', '2026-10-07T11:00:00.000Z');
  assert.equal(evt.old_price, 39);
  assert.equal(evt.new_price, 29);
  assert.equal(evt.direction, 'decrease');
  assert.equal(evt.delta, -10);
  assert.equal(evt.pct, -25.641);
  assert.deepStrictEqual(evt.old_value, { price_min: 39, price_max: 39 });
  assert.deepStrictEqual(evt.new_value, { price_min: 29, price_max: 29 });
});

// ============ 3. AI payload：完整区间 + changed_boundary，无自相矛盾 ============
t('3. AI payload carries full ranges + changed_boundary; no contradictory scalars', () => {
  const evt = scenario('tenant:p1-ai', RANGE_PRODUCTS(10, 20), RANGE_PRODUCTS(10, 15),
    '2026-10-07T09:00:00.000Z', '2026-10-07T11:00:00.000Z');
  const p = Demo.aiFactPayloadOf(evt);
  assert.deepStrictEqual(p.old_price_range, { min: 10, max: 20 });
  assert.deepStrictEqual(p.new_price_range, { min: 10, max: 15 });
  assert.equal(p.changed_boundary, 'price_max');
  assert.equal(p.direction, 'decrease');
  assert.equal(p.delta, -5);
  assert.equal(p.pct, -25);
  assert.equal(p.old_price, null);
  assert.equal(p.new_price, null);
  // AI 看到的数据内部一致：不含「区间 10–20→10–15」与「old_price=10」并存
  const s = JSON.stringify(p);
  assert.equal(s.includes('"old_price":10'), false);
  assert.equal(s.includes('"new_price":10'), false);
});

// ============ 4. direction=null（混合区间）：AI payload delta/pct 为 null，绝不用 0 ============
t('4. Mixed range 10-20 -> 12-15: direction null; AI payload delta/pct null (never 0)', () => {
  const evt = scenario('tenant:p1-mixed', RANGE_PRODUCTS(10, 20), RANGE_PRODUCTS(12, 15),
    '2026-10-07T09:00:00.000Z', '2026-10-07T11:00:00.000Z');
  assert.equal(evt.direction, null);
  assert.equal(evt.delta, null);
  assert.equal(evt.pct, null);
  const p = Demo.aiFactPayloadOf(evt);
  assert.equal(p.direction, null);
  assert.equal(p.delta, null, 'delta must stay null, never 0');
  assert.equal(p.pct, null, 'pct must stay null, never 0');
  assert.deepStrictEqual(p.old_price_range, { min: 10, max: 20 });
  assert.deepStrictEqual(p.new_price_range, { min: 12, max: 15 });
  assert.equal(p.changed_boundary, 'mixed');
});

// ============ 5. display 展示视图：任务书 5 类话术全覆盖 ============
t('5. priceChangeView covers all required phrasings (5 cases)', () => {
  const mk = (oldV, newV, extra) => Demo.priceChangeView(Object.assign({
    old_value: oldV, new_value: newV, currency: null,
  }, extra || {}));
  // 单一价格：39 → 29，下降 25.6%
  let v = mk({ price_min: 39, price_max: 39 }, { price_min: 29, price_max: 29 },
    { direction: 'decrease', delta: -10, pct: -25.641 });
  assert.equal(v.from, '39'); assert.equal(v.to, '29');
  assert.equal(v.change_label, '下降 25.6%');
  // 区间最高价下降：10–20 → 10–15，最高价下降 25%
  v = mk({ price_min: 10, price_max: 20 }, { price_min: 10, price_max: 15 },
    { direction: 'decrease', delta: -5, pct: -25 });
  assert.equal(v.from, '10 – 20'); assert.equal(v.to, '10 – 15');
  assert.equal(v.changed_boundary, 'price_max');
  assert.equal(v.change_label, '最高价下降 25%');
  // 区间最高价上涨：10–20 → 10–25
  v = mk({ price_min: 10, price_max: 20 }, { price_min: 10, price_max: 25 },
    { direction: 'increase', delta: 5, pct: 25 });
  assert.equal(v.change_label, '最高价上升 25%');
  // 区间最低价上升：10–20 → 12–20，最低价上升 20%
  v = mk({ price_min: 10, price_max: 20 }, { price_min: 12, price_max: 20 },
    { direction: 'increase', delta: 2, pct: 20 });
  assert.equal(v.changed_boundary, 'price_min');
  assert.equal(v.change_label, '最低价上升 20%');
  // 区间最低价下降：10–20 → 8–20
  v = mk({ price_min: 10, price_max: 20 }, { price_min: 8, price_max: 20 },
    { direction: 'decrease', delta: -2, pct: -20 });
  assert.equal(v.change_label, '最低价下降 20%');
  // 双边界同向：10–20 → 12–25，价格区间上移
  v = mk({ price_min: 10, price_max: 20 }, { price_min: 12, price_max: 25 },
    { direction: 'increase', delta: 2, pct: 20 });
  assert.equal(v.changed_boundary, 'both');
  assert.equal(v.change_label, '价格区间上移');
  // 双边界同向下移：10–20 → 8–15
  v = mk({ price_min: 10, price_max: 20 }, { price_min: 8, price_max: 15 },
    { direction: 'decrease', delta: -2, pct: -20 });
  assert.equal(v.change_label, '价格区间下移');
});

// ============ 6. direction=null 展示：中性话术，无箭头/无 0.0% ============
t('6. Mixed range display: neutral label, no arrow, no "0.0%"', () => {
  // 收窄：10–20 → 12–15
  let v = Demo.priceChangeView({ old_value: { price_min: 10, price_max: 20 }, new_value: { price_min: 12, price_max: 15 }, currency: null, direction: null, delta: null, pct: null });
  assert.equal(v.change_label, '价格区间收窄，无单一涨跌方向');
  // 扩大：10–20 → 8–25
  v = Demo.priceChangeView({ old_value: { price_min: 10, price_max: 20 }, new_value: { price_min: 8, price_max: 25 }, currency: null, direction: null, delta: null, pct: null });
  assert.equal(v.change_label, '价格区间扩大，无单一涨跌方向');
  const s = JSON.stringify(v);
  assert.equal(s.includes('0.0%'), false, 'no 0.0% in display');
  assert.equal(s.includes('↑'), false, 'no up arrow');
  assert.equal(s.includes('↓'), false, 'no down arrow');
});

// ============ 7. recent-changes 集成：events 携带 display，区间事件 old_price=null ============
async function t7() {
  const sent = [];
  const fakeRes = { writeHead() {}, end(s) { sent.push(s); } };
  const ctx = { sendJSON: (res, code, obj) => { sent.push({ code, obj }); return obj; } };
  const als = require('../core/als.js');
  await als.requestScope.run('tenant:p1-rest', async () => {
    // 在该租户下造一个区间事件（fresh 租户，事件唯一）
    scenario('tenant:p1-rest', RANGE_PRODUCTS(10, 20), RANGE_PRODUCTS(10, 15),
      '2026-10-07T09:00:00.000Z', '2026-10-07T11:00:00.000Z');
    await Demo.recentChanges(ctx, { method: 'GET' }, fakeRes, new URL('http://x/api/demo/recent-changes'), '/api/demo/recent-changes');
    const recent = sent[sent.length - 1];
    assert.equal(recent.code, 200);
    assert.ok(recent.obj.events.length >= 1);
    const evt = recent.obj.events.find(e => e.old_value && e.old_value.price_min === 10 && e.old_value.price_max === 20);
    assert.ok(evt, 'range event present in recent-changes');
    assert.equal(evt.old_price, null);
    assert.equal(evt.new_price, null);
    assert.ok(evt.display, 'display projection attached');
    assert.equal(evt.display.to, '10 – 15');
    assert.equal(evt.display.change_label, '最高价下降 25%');
    // event-detail 同样携带 display
    await Demo.eventDetail(ctx, { method: 'GET' }, fakeRes, new URL('http://x/api/demo/event-detail?id=' + evt.event_id), '/api/demo/event-detail');
    const detail = sent[sent.length - 1];
    assert.equal(detail.code, 200);
    assert.ok(detail.obj.event.display);
    assert.equal(detail.obj.event.display.change_label, '最高价下降 25%');
  });
}

// ============ 8. Demo fixture（39→29 真实链路）不回归 ============
t('8. Demo fixture 39->29 flow unchanged (old_price scalar preserved)', () => {
  const Fixture = require('../research/demo-fixture.js');
  const r = Fixture.seedDemoScenario({ tenantId: 'tenant:p1-fixture' });
  const eventId = r.event_id || (r.chain && r.chain.event_id) || null;
  assert.ok(eventId, 'seed produced event: ' + JSON.stringify(r).slice(0, 120));
  const evt = Events.getEventById('tenant:p1-fixture', eventId);
  assert.equal(evt.old_price, 39);
  assert.equal(evt.new_price, 29);
  const view = Demo.priceChangeView(evt);
  assert.equal(view.from, '39');
  assert.equal(view.to, '29');
  assert.equal(view.change_label, '下降 25.6%');
});

// ============ 汇总（T7 async 最后跑） ============
(async () => {
  try { await t7(); passed++; console.log('ok - 7. recent-changes/event-detail REST integration with display projection'); }
  catch (e) { failed++; console.error('FAIL - 7. REST integration: ' + String(e.message || e).split('\n')[0]); }
  console.log('\nprice-range-display.test: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
})();
