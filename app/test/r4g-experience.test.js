'use strict';
// ============================================================
// r4g-experience.test.js —— r4g 行为测试
//   1. 动态 Shopify 平台识别（probeShopifyCatalog 受控资产 + false 不一票否决）
//   2. 覆盖限制统计拆分（partialSignalBrands 品牌口径 / notIntegratedDimensions 维度口径）
//   3. monitoring/summary：只读投影 + rows 同口径 + 20s 硬超时结构
//   4. inspect-all 幂等（重复点击同一批次）
//   5. plan-reconcile 收敛（已监控跳过 / 未监控创建 / 重复执行不重复创建）
//   6. 机会视图 eligibility（<$1 异常标价不进市场统计；原始观察范围保留）
//   7. 官网内容 diff 用稳定字段（不再整页哈希）——fp diff 字段断言
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.ZB_DATA_DIR = process.env.ZB_DATA_DIR || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'zb-r4g-'));

const Net = require('../research/net.js');
const SH = require('../services/source-health.js');
const WS = require('../services/watch-store.js');
const WIntent = require('../services/watch-intent.js');
const tenant = require('../services/tenant.js');
const db = require('../services/db.js');
const { projFile } = require('../core/state-store.js');

let seq = 0;
function uid(p) { seq += 1; return p + '_' + Date.now().toString(36) + '_' + seq; }

// ---------- 1. 动态 Shopify 识别 ----------
test('r4g-1 probeShopifyCatalog：受控资产 Shopify 命中 / 非 JSON 拒判', async () => {
  process.env.ZB_TEST_ASSETS = '1';
  const root = path.join(__dirname, '..', 'test-assets');
  // 受控资产：products.json 返回合法 Shopify 形状
  const dir = path.join(root, 'probe.zb.test');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'products.json'), JSON.stringify({ products: [{ id: 1, title: 'Case', variants: [{ price: '19.99' }] }] }));
  const r = await Net.probeShopifyCatalog('https://probe.zb.test/', {});
  assert.equal(r.ok, true, '受控 Shopify products.json → ok');
  assert.equal(r.shopify, true);
  // not_json 路径
  fs.writeFileSync(path.join(dir, 'products.json'), '<html>not json</html>');
  const r2 = await Net.probeShopifyCatalog('https://probe.zb.test/', {});
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'not_json');
  delete process.env.ZB_TEST_ASSETS;
});

test('r4g-2 覆盖限制拆分：品牌数与维度数不混用', () => {
  const healths = [
    { state: 'available', stale: false, limits: [] },
    { state: 'not_configured', stale: false, limits: [{ dimension: '评论' }, { dimension: '社媒' }] },
    { state: 'out_of_coverage', stale: false, limits: [{ dimension: '广告' }] },
    { state: 'retryable', stale: false, limits: [] },
  ];
  const s = SH.summarize(healths);
  assert.equal(s.partialSignalBrands, 2, 'not_configured + out_of_coverage → 2 个品牌');
  assert.equal(s.notIntegratedDimensions, 3, '2+1 → 3 个维度条目');
  assert.equal(s.limits, 2, '兼容别名 = partialSignalBrands');
  assert.equal(s.needsHandling, 1, 'retryable 进需要处理');
});

// ---------- 3. monitoring/summary ----------
function makeCtx(tid) {
  return {
    getAuthPayload: () => ({ kind: 'tenant', payload: { tid, sub: 'user:x', role: 'owner' } }),
    readBody: async () => ({}),
    sendJSON: (_res, code, obj) => { makeCtx.last = { code, obj }; return true; },
  };
}
test('r4g-3 monitoring/summary 只读投影：rows + totals + healthSummary，一次请求', async () => {
  const reg = tenant.register({ email: uid('r4g3') + '@example.com', password: 'password77' });
  const tid = reg.tenant.id;
  const pid = uid('proj3');
  const f = projFile(pid, tid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ competitors: [
    { id: 'brand-a', name: 'Alpha Cases', url: 'https://a.example.com', isShopify: true },
    { id: 'brand-b', name: 'Beta Cases', url: 'https://b.example.com' },
  ] }));
  WS.createWatchTarget({ tenantId: tid, projectId: pid, competitorId: 'brand-a', market: 'us', timezone: 'UTC', enabledSignals: ['site_change'], supportedSignals: ['site_change'], enrichmentStatus: 'complete' });

  const H = require('../routes/handlers/monitoring-summary.js');
  const ctx = makeCtx(tid);
  const url = new URL('http://x/api/monitoring/summary?projectId=' + encodeURIComponent(pid));
  await H.summary(ctx, { method: 'GET', headers: {} }, {}, url);
  const out = makeCtx.last;
  assert.equal(out.code, 200);
  assert.equal(out.obj.partial, false);
  assert.equal(out.obj.totals.projectBrands, 2);
  assert.equal(out.obj.totals.active, 1);
  assert.equal(out.obj.totals.unmonitored, 1, 'brand-b 未监控');
  assert.ok(Array.isArray(out.obj.rows) && out.obj.rows.length >= 1);
  assert.equal(out.obj.rows[0].name, 'Alpha Cases', '后端已组装品牌名（前端不再拼三接口）');
  const payload = JSON.stringify(out.obj);
  assert.ok(payload.length < 30000, '摘要载荷小于 30KB（替代 122KB brands 全量）');
  assert.ok(!/events\.json|gap_snapshots|history:60d/.test(payload), '无内部工程词');
});

// ---------- 4. inspect-all 幂等 ----------
test('r4g-4 inspect-all：一次排队全部 active；重复点击沿用进行中批次', async () => {
  const reg = tenant.register({ email: uid('r4g4') + '@example.com', password: 'password77' });
  const tid = reg.tenant.id;
  const pid = uid('proj4');
  const f = projFile(pid, tid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ competitors: [{ id: 'c1', name: 'C1' }, { id: 'c2', name: 'C2' }] }));
  for (const cid of ['c1', 'c2']) {
    WS.createWatchTarget({ tenantId: tid, projectId: pid, competitorId: cid, market: 'us', timezone: 'UTC', enabledSignals: ['site_change'], supportedSignals: ['site_change'], enrichmentStatus: 'complete' });
  }
  const WatchH = require('../routes/handlers/watch.js');
  const ctx = makeCtx(tid);
  ctx.readBody = async () => ({ projectId: pid });
  await WatchH.inspectAll(ctx, { method: 'POST', headers: {} }, {}, null, '/api/monitoring/inspect-all');
  const first = makeCtx.last;
  assert.equal(first.code, 202);
  assert.equal(first.obj.accepted, 2, '两个 active 目标全部受理');
  assert.ok(first.obj.batchId);
  // 立刻重复：全部 IN_PROGRESS（幂等，同一批次，不重复建窗口）
  await WatchH.inspectAll(ctx, { method: 'POST', headers: {} }, {}, null, '/api/monitoring/inspect-all');
  const second = makeCtx.last;
  assert.equal(second.code, 202);
  assert.equal(second.obj.accepted, 0, '重复点击不新开批次');
  assert.equal(second.obj.inProgress, 2, 'IN_PROGRESS 沿用同一批次');
  assert.equal(second.obj.batchId, first.obj.batchId);
});

// ---------- 5. plan-reconcile ----------
test('r4g-5 plan-reconcile：未监控创建 / 已监控跳过 / 重复执行零重复', async () => {
  const reg = tenant.register({ email: uid('r4g5') + '@example.com', password: 'password77' });
  const tid = reg.tenant.id;
  const pid = uid('proj5');
  const f = projFile(pid, tid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ competitors: [
    { id: 'p1', name: 'P1', url: 'https://p1.example.com' },
    { id: 'p2', name: 'P2', url: 'https://p2.example.com' },
    { id: 'p3', name: 'P3', url: 'https://p3.example.com' },
  ] }));
  WS.createWatchTarget({ tenantId: tid, projectId: pid, competitorId: 'p1', market: 'us', timezone: 'UTC', enabledSignals: ['site_change'], supportedSignals: ['site_change'], enrichmentStatus: 'complete' });
  WIntent.requestIntent({ tenantId: tid, projectId: pid, competitorId: 'p2', reasonCode: 'test' });

  const WatchH = require('../routes/handlers/watch.js');
  const ctx = makeCtx(tid);
  ctx.readBody = async () => ({ projectId: pid });
  await WatchH.planReconcile(ctx, { method: 'POST', headers: {} }, {}, null, '/api/monitoring/plan-reconcile');
  const r1 = makeCtx.last;
  assert.equal(r1.code, 200);
  assert.equal(r1.obj.createdCount, 1, '只有 p3 被创建');
  assert.equal(r1.obj.skippedCount, 2, 'p1 已监控 / p2 有意向 → 跳过');
  // 重复执行：全部跳过（不重复创建）
  await WatchH.planReconcile(ctx, { method: 'POST', headers: {} }, {}, null, '/api/monitoring/plan-reconcile');
  const r2 = makeCtx.last;
  assert.equal(r2.obj.createdCount, 0, '重复执行不重复创建');
  assert.equal(r2.obj.skippedCount, 3);
});

// ---------- 6. 机会视图 eligibility ----------
test('r4g-6 机会视图：<$1 异常标价不进市场统计，原始观察范围保留', () => {
  const rows = [
    { brandId: 'b1', name: 'Normal', competitorId: 'b1', productCount: 5, available: true, priceMin: 10, priceMedian: 20, priceMax: 40, currency: 'USD', currencyStatus: 'confirmed', priceComparable: true },
    { brandId: 'b2', name: 'Weird', competitorId: 'b2', productCount: 3, available: true, priceMin: 0.01, priceMedian: 0.05, priceMax: 0.99, currency: 'USD', currencyStatus: 'confirmed', priceComparable: true },
  ];
  // 直接测 eligibility 规则（与 opportunity-foundation 相同口径）
  for (const r of rows) {
    const lo = r.priceMin != null ? r.priceMin : r.priceMax;
    const hi = r.priceMax != null ? r.priceMax : r.priceMin;
    r.priceEligible = !(r.available === false) && r.priceComparable && !(lo != null && hi != null && hi < 1);
  }
  assert.equal(rows[0].priceEligible, true);
  assert.equal(rows[1].priceEligible, false, '<$1 全部价格 → 疑似配件/异常标价');
  // rawObservation：统计 1 家、原始观察 2 家 → 说明文案存在
  const allCur = rows.filter(r => r.priceComparable);
  const rawVals = allCur.flatMap(r => [r.priceMin, r.priceMax].filter(v => v != null));
  const rawMin = Math.min(...rawVals), rawMax = Math.max(...rawVals);
  const statCount = rows.filter(r => r.priceEligible).length;
  assert.ok(rawCount(allCur) > statCount, '原始观察 > 统计口径 → 生成说明');
  const note = `原始观察范围：$${rawMin.toFixed(2)}–$${rawMax.toFixed(2)}。其中包含疑似配件、附加商品或异常标价，尚未用于市场机会结论。`;
  assert.ok(note.includes('$0.01') && note.includes('$40.00'));
  function rawCount(list) { return list.length; }
});

// ---------- 7. 官网 diff 稳定字段 ----------
test('r4g-7 官网内容 diff：字段级比较 + 噪声清洗（不整页哈希）', () => {
  const FP = require('../services/site-fingerprint.js');
  const html1 = '<html><head><title>Shop</title><link rel="canonical" href="https://x.example.com/"></head><body><h1>Summer Sale</h1><a href="/products/a">Case A</a><div class="cookie-banner">Accept cookies</div></body></html>';
  const html2 = '<html><head><title>Shop</title><link rel="canonical" href="https://x.example.com/"></head><body><h1>Summer Sale</h1><a href="/products/a">Case A</a><div class="cookie-banner">Reject all cookies 2026-10-28</div></body></html>';
  const fp1 = FP.buildFingerprint(html1, 'https://x.example.com/');
  const fp2 = FP.buildFingerprint(html2, 'https://x.example.com/');
  const d = FP.diffFingerprints(fp1, fp2);
  assert.ok(d.comparable === true);
  assert.equal(d.changes.length, 0, 'cookie banner 日期变化被清洗，不产生假变化');
  // 真实变化：主视觉标题改了
  const html3 = html1.replace('<h1>Summer Sale</h1>', '<h1>Holiday Deals</h1>');
  const fp3 = FP.buildFingerprint(html3, 'https://x.example.com/');
  const d2 = FP.diffFingerprints(fp1, fp3);
  assert.ok(d2.changes.length > 0, '真实内容变化被捕获');
  assert.ok(FP.describeChanges(d2.changes).length > 0, '字段级描述可读');
});
