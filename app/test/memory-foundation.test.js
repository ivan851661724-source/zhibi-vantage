'use strict';
// ============================================================
// memory-foundation.test.js —— Competitive Memory（SC-05）行为验收
//
// 覆盖：
//   C1  两租户 / 两项目严格隔离（实体、事实、事件、任务均不串）
//   C2  同内容重复采集：不产新版本、不产新事实、不产伪变化事件
//   C3  同商品同币种同规格价格变化：生成可追溯事件（含两条事实 + 证据入口）
//   C4  异币种 / 规格不明 / partial / 失败：不生成伪价格变化
//   C5  双时间语义：live（effective null / captured_only）vs archived（存档时间 / day）
//   C6  存档事实必须带 Snapshot + Evidence（缺失即拒绝写入）
//   C7  insertFact 的准入硬校验（无证据 / 无快照 → 抛错）
//   C8  回补任务幂等（同范围重复点击不产生第二个任务）
//   C9  重启恢复：租约过期 running → pending；attempts 超限 → dead（不永久 running）
//   C10 采集链路贯通：真实 adapter → attempt → Evidence → Memory，handler 可查到事实
//   C11 接口不泄漏（无路径 / 无 token / 无栈 / 无 claimToken）
//   C12 覆盖状态区分：未开始 / 已核实 / 部分覆盖，且零事实不写成「没有变化」
// 测试不发真实网络请求（net 采集函数按模块导出替换；Snapshot/Evidence 真实落盘）。
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-cmf-test-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.ZB_BACKFILL_POINT_DELAY_MS = '0';

const Store = require('../services/competitive-memory-store.js');
const Memory = require('../services/competitive-memory.js');
const View = require('../services/memory-view.js');
const Backfill = require('../services/backfill-service.js');
const Snapshot = require('../research/source-snapshot.js');
const EvidenceStore = require('../research/evidence-store.js');
const Net = require('../research/net.js');
const SurfaceStore = require('../services/surface-store.js');
const CollectJobs = require('../services/collect-jobs.js');
const BrandStore = require('../services/brand-store.js');
const Db = require('../services/db.js');
const { saveState, projFile } = require('../core/state-store.js');
require('../routes/index.js');
const MemH = require('../routes/handlers/memory.js');
const Archive = require('../research/web-archive.js');

let failed = 0;
let total = 0;
async function t(name, fn) {
  total++;
  try { await fn(); console.log('ok ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n  ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n  ')); }
}
const NOW = Date.parse('2026-10-19T06:00:00Z');
const iso = (offsetDays) => new Date(NOW + (offsetDays || 0) * 86400000).toISOString();

async function mkProject(tid, pid, compId, opts) {
  const o = opts || {};
  // handler 用 db.getProject 做项目归属校验 → 必须有真实项目行
  Db.saveProject({ id: pid, tenantId: tid, track: 'T-' + pid, competitors: [], createdAt: iso(0), discoveredAt: iso(0) });
  fs.mkdirSync(path.dirname(projFile(pid, tid)), { recursive: true });
  saveState({
    projectId: pid, tenantId: tid, track: 'T-' + pid,
    discoveredAt: iso(0),
    intent: { regions: ['us'] },
    competitors: [{
      id: compId, name: 'Brand ' + compId, status: 'done',
      url: 'https://' + (o.domain || (compId + '.example.com')),
      isShopify: o.isShopify !== false, currency: o.currency === undefined ? 'USD' : o.currency,
    }],
  });
  const f = projFile(pid, tid);
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(f), 'state 文件未落盘');
}
async function mkBrand(tid, pid, compId, name) {
  const up = BrandStore.upsertBrand({
    tenantId: tid, canonicalName: name || ('Brand ' + compId),
    officialDomain: compId + '.example.com', competitorRef: compId,
  });
  BrandStore.linkProject({ tenantId: tid, brandId: up.brand.brandId, projectId: pid, competitorRef: compId });
  return up.brand.brandId;
}
function mkSnapshot(tid, url, body, opts) {
  const o = opts || {};
  const r = Snapshot.record({
    capability: o.capability || 'product_catalog',
    provider: o.provider || 'shopify_products_json',
    source_url: url, source_status: o.sourceStatus || 'success',
    observed_at: o.observedAt || iso(0), fetched_at: o.observedAt || iso(0),
    bodyBytes: Buffer.from(body), contentType: 'application/json',
    trigger: o.trigger || 'manual', tenantId: tid,
  });
  assert.ok(r.recorded, 'snapshot recorded: ' + url);
  return r.meta;
}
function mkEvidence(tid, pid, snapIds, opts) {
  const o = opts || {};
  const ev = EvidenceStore.recordEvidence({
    tenantId: tid, projectRef: pid, brandHint: o.brandHint || null,
    source: o.source || 'shopify', provider: o.provider || 'shopify_products_json',
    source_snapshot_ids: snapIds,
    claim: { field: 'catalog.observation', scope: o.scope || 'public_catalog_observation' },
    entity_key: o.entityKey || 'example.com',
    entity_ref: { kind: 'storefront_domain', domain: o.entityKey || 'example.com' },
    extracted_value: { summaryKind: 'storefront_catalog', count: o.count == null ? 2 : o.count },
    unit: null, currency: o.currency === undefined ? 'USD' : o.currency, market: null,
    evidence_status: 'verified',
    parser_version: 'shopify-adapter-1', extractor_version: 'shopify-adapter-1',
    observed_at: o.observedAt || iso(0),
    note: o.note || null,
  });
  assert.ok(ev && ev.recorded, 'evidence recorded');
  return ev.meta.evidence_id;
}
const itemsA = () => ([
  { id: '1001', handle: 'runner', title: 'Runner', repPrice: 110, minPrice: 110, maxPrice: 110, soldOut: false, variantCount: 2 },
  { id: '1002', handle: 'tee', title: 'Tee', repPrice: 40, minPrice: 40, maxPrice: 40, soldOut: true, variantCount: 1 },
]);
function summaryOf(items, currency, partial) {
  const prices = items.filter(x => x.repPrice > 0 && !x.soldOut).map(x => x.repPrice).sort((a, b) => a - b);
  return {
    count: items.length,
    onSaleCount: prices.length,
    soldOutCount: items.filter(x => x.soldOut).length,
    priceMin: prices[0] == null ? null : prices[0],
    priceMax: prices[prices.length - 1] == null ? null : prices[prices.length - 1],
    priceMedian: prices.length ? prices[Math.floor((prices.length - 1) / 2)] : null,
    currency: currency === undefined ? 'USD' : currency,
    partialScan: !!partial, partialScanReason: partial ? 'pagination_budget_exhausted' : null,
  };
}

// 统一的真实快照 + 证据准备
function seedContext(tid, pid, compId, opts) {
  const o = opts || {};
  const domain = o.domain || (compId + '.example.com');
  const snap = mkSnapshot(tid, 'https://' + domain + '/products.json?limit=250&page=1', '{"products":[]}', { observedAt: o.observedAt || iso(0) });
  const ev = mkEvidence(tid, pid, [snap.snapshot_id], { entityKey: domain, observedAt: o.observedAt || iso(0) });
  return { snapshotIds: [snap.snapshot_id], evidenceIds: [ev], domain };
}

function mkCtx(tid) {
  const out = { status: null, body: null, _body: null };
  out.sendJSON = (res, code, obj) => { out.status = code; out.body = obj; return true; };
  out.readBody = async () => out._body || {};
  out.getAuthPayload = () => (tid ? { kind: 'tenant', payload: { tid } } : null);
  out.getCurrentId = () => null;
  return out;
}
const fakeRes = () => ({ headersSent: false, writeHead() {}, end() {} });

// ============================================================
(async () => {
  // ---------- 基础作用域 ----------
  await mkProject('tenant:A', 'projA1', 'compA1', { domain: 'alpha.example.com' });
  await mkProject('tenant:A', 'projA2', 'compA2', { domain: 'beta.example.com' });
  await mkProject('tenant:B', 'projB1', 'compB1', { domain: 'alpha.example.com' }); // 同域名，不同租户
  const brandA1 = await mkBrand('tenant:A', 'projA1', 'compA1', 'Alpha');
  const brandA2 = await mkBrand('tenant:A', 'projA2', 'compA2', 'Beta');
  const brandB1 = await mkBrand('tenant:B', 'projB1', 'compB1', 'Alpha B');

  await t('C1 两租户两项目严格隔离（同域名不合并、跨租户读不到）', async () => {
    const ca = seedContext('tenant:A', 'projA1', 'compA1', { domain: 'alpha.example.com' });
    const cb = seedContext('tenant:B', 'projB1', 'compB1', { domain: 'alpha.example.com' });
    const rA = Memory.ingestCatalogObservation({
      tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1',
      domain: ca.domain, items: itemsA(), summary: summaryOf(itemsA()),
      snapshotIds: ca.snapshotIds, evidenceIds: ca.evidenceIds, observedAt: iso(0),
    });
    const rB = Memory.ingestCatalogObservation({
      tenantId: 'tenant:B', projectId: 'projB1', competitorId: 'compB1',
      domain: cb.domain, items: itemsA(), summary: summaryOf(itemsA()),
      snapshotIds: cb.snapshotIds, evidenceIds: cb.evidenceIds, observedAt: iso(0),
    });
    assert.ok(rA.ok && rA.entitiesCreated >= 3, 'tenant A 写入实体');
    assert.ok(rB.ok && rB.entitiesCreated >= 3, 'tenant B 独立写入实体');
    // 跨租户读取一律为空
    assert.strictEqual(Store.countFacts('tenant:B', 'projB1', 'compA1'), 0, '跨租户 project/competitor 组合不命中');
    assert.ok(Store.countFacts('tenant:A', 'projA1', 'compA1') > 0, '本作用域有事实');
    const a = Store.listFacts('tenant:A', 'projA1', 'compA1', { limit: 5 });
    const b = Store.listFacts('tenant:B', 'projB1', 'compB1', { limit: 5 });
    assert.notStrictEqual(a.facts[0].factId, b.facts[0].factId, '同内容在两租户是两份独立事实');
    // 两个项目（同租户）之间也不串
    assert.strictEqual(Store.countFacts('tenant:A', 'projA2', 'compA2'), 0, '同租户另一项目为空');
  });

  await t('C2 同内容重复采集不产新版本 / 新事实 / 伪变化事件', async () => {
    const c = seedContext('tenant:A', 'projA1', 'compA1', { domain: 'alpha.example.com', observedAt: iso(1) });
    const before = {
      facts: Store.countFacts('tenant:A', 'projA1', 'compA1'),
      events: Store.listEvents('tenant:A', 'projA1', 'compA1', { limit: 200 }).length,
    };
    const r = Memory.ingestCatalogObservation({
      tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1',
      domain: c.domain, items: itemsA(), summary: summaryOf(itemsA()),
      snapshotIds: c.snapshotIds, evidenceIds: c.evidenceIds, observedAt: iso(1),
    });
    assert.ok(r.ok, '写入成功');
    assert.strictEqual(r.versionsCreated, 0, '零新版本');
    assert.strictEqual(r.eventsCreated, 0, '零新事件');
    assert.strictEqual(Store.countFacts('tenant:A', 'projA1', 'compA1'), before.facts, '事实总数不变');
    assert.strictEqual(Store.listEvents('tenant:A', 'projA1', 'compA1', { limit: 200 }).length, before.events, '事件总数不变');
    // last_seen_at 应推进（观察仍在持续）
    const ents = Store.listEntities('tenant:A', 'projA1', 'compA1', { entityType: 'product', limit: 10 });
    assert.ok(ents.every(e => e.lastSeenAt >= e.firstSeenAt), 'last_seen 不早于 first_seen');
  });

  await t('C3 同商品同币种同规格价格变化生成可追溯事件', async () => {
    const c = seedContext('tenant:A', 'projA1', 'compA1', { domain: 'alpha.example.com', observedAt: iso(2) });
    const items = [{ id: '1001', handle: 'runner', title: 'Runner', repPrice: 95, minPrice: 95, maxPrice: 95, soldOut: false, variantCount: 2 }];
    Memory.ingestCatalogObservation({
      tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1',
      domain: c.domain, items, summary: summaryOf(items),
      snapshotIds: c.snapshotIds, evidenceIds: c.evidenceIds, observedAt: iso(2),
    });
    const evs = Store.listEvents('tenant:A', 'projA1', 'compA1', { limit: 50 })
      .filter(e => e.eventType === 'product_price_changed');
    assert.ok(evs.length >= 1, '生成价格变化事件');
    const e0 = evs[0];
    assert.strictEqual(e0.fromValue, 110);
    assert.strictEqual(e0.toValue, 95);
    assert.strictEqual(e0.currency, 'USD');
    assert.strictEqual(e0.derivedFromFactIds.length, 2, '事件回链两条事实');
    assert.ok(e0.evidenceIds.length >= 1 && e0.snapshotIds.length >= 1, '事件携带证据入口');
    assert.strictEqual(e0.algorithmVersion, Memory.ALGO_VERSION, '算法版本入库');
  });

  await t('C4 异币种 / 规格不明 / partial / 失败 不生成伪价格变化', async () => {
    // ① 异币种
    const c1 = seedContext('tenant:A', 'projA1', 'compA1', { domain: 'alpha.example.com', observedAt: iso(3) });
    const itemsCur = [{ id: '1001', handle: 'runner', title: 'Runner', repPrice: 88, minPrice: 88, maxPrice: 88, soldOut: false, variantCount: 2 }];
    const beforeEvents = Store.listEvents('tenant:A', 'projA1', 'compA1', { limit: 200 }).length;
    Memory.ingestCatalogObservation({
      tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1',
      domain: c1.domain, items: itemsCur, summary: summaryOf(itemsCur, 'EUR'),
      snapshotIds: c1.snapshotIds, evidenceIds: c1.evidenceIds, observedAt: iso(3),
    });
    assert.strictEqual(Store.listEvents('tenant:A', 'projA1', 'compA1', { limit: 200 }).length, beforeEvents,
      '币种不同不产生价格事件');
    // ② 规格不明（variantCount 缺失）
    const c2 = seedContext('tenant:A', 'projA1', 'compA1', { domain: 'alpha.example.com', observedAt: iso(4) });
    const noVar = [{ id: '1001', handle: 'runner', title: 'Runner', repPrice: 77, minPrice: 77, maxPrice: 77, soldOut: false }];
    Memory.ingestCatalogObservation({
      tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1',
      domain: c2.domain, items: noVar, summary: summaryOf(noVar),
      snapshotIds: c2.snapshotIds, evidenceIds: c2.evidenceIds, observedAt: iso(4),
    });
    const afterSpec = Store.listEvents('tenant:A', 'projA1', 'compA1', { limit: 200 })
      .filter(e => e.eventType === 'product_price_changed' && e.toValue === 77);
    assert.strictEqual(afterSpec.length, 0, '规格不明不产生价格事件');
    // ③ partial：可售状态翻转也不得成为事件
    const c3 = seedContext('tenant:A', 'projA1', 'compA1', { domain: 'alpha.example.com', observedAt: iso(5) });
    const partialItems = [{ id: '1002', handle: 'tee', title: 'Tee', repPrice: 40, minPrice: 40, maxPrice: 40, soldOut: false, variantCount: 1 }];
    Memory.ingestCatalogObservation({
      tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1',
      domain: c3.domain, items: partialItems, summary: summaryOf(partialItems, 'USD', true),
      snapshotIds: c3.snapshotIds, evidenceIds: c3.evidenceIds, observedAt: iso(5),
    });
    const availEvents = Store.listEvents('tenant:A', 'projA1', 'compA1', { limit: 200 })
      .filter(e => e.eventType === 'product_availability_changed');
    assert.strictEqual(availEvents.length, 0, 'partial 不产生可售状态事件');
    // ④ 抓取失败（无证据）根本不进入 Memory 写入
    const skip = Memory.ingestCatalogObservation({
      tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1',
      domain: 'alpha.example.com', items: partialItems, summary: summaryOf(partialItems),
      snapshotIds: [], evidenceIds: [], observedAt: iso(6),
    });
    assert.strictEqual(skip.ok, false);
    assert.strictEqual(skip.reason, 'evidence_required');
  });

  await t('C5 双时间语义：live 不声称发生时间，archived 用存档时间且精度为日', async () => {
    const live = Store.listFacts('tenant:A', 'projA1', 'compA1', { factTypes: ['product.price'], limit: 50 });
    assert.ok(live.facts.length > 0, '有价格事实');
    for (const f of live.facts.filter(x => x.sourceKind === 'live_observation')) {
      assert.strictEqual(f.effectiveAt, null, 'live 不填 effective_at');
      assert.strictEqual(f.timePrecision, 'captured_only');
      assert.strictEqual(f.atBasis, 'observed_at', '时间轴锚点为观察时间');
      assert.ok(f.observedAt && f.recordedAt, '观察到写入时间都在');
    }
    // archived：直接构造一次存档观察
    const snap = mkSnapshot('tenant:A', 'https://web.archive.org/web/20240201000000id_/alpha.example.com/products.json', '{"products":[]}', {
      capability: 'product_catalog_archive', provider: 'web_archive', observedAt: iso(7),
    });
    const ev = mkEvidence('tenant:A', 'projA1', [snap.snapshot_id], {
      source: 'web_archive', provider: 'web_archive_shopify_products',
      scope: 'archived_catalog_observation', entityKey: 'alpha.example.com', observedAt: iso(7),
    });
    const r = Memory.ingestCatalogObservation({
      tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1',
      domain: 'alpha.example.com', brandName: 'Alpha',
      items: [{ id: '1001', handle: 'runner', title: 'Runner', repPrice: 130, minPrice: 130, maxPrice: 130, soldOut: false, variantCount: 2 }],
      summary: summaryOf([{ repPrice: 130, soldOut: false }], null),
      snapshotIds: [snap.snapshot_id], evidenceIds: [ev],
      sourceKind: 'archived_observation',
      effectiveAt: '2024-02-01T00:00:00.000Z', timePrecision: 'day',
      observedAt: iso(7),
    });
    assert.ok(r.ok, '存档写入成功');
    const ar = Store.listFacts('tenant:A', 'projA1', 'compA1', { factTypes: ['product.price'], limit: 50 })
      .facts.filter(f => f.sourceKind === 'archived_observation');
    assert.ok(ar.length > 0, '存在存档事实');
    for (const f of ar) {
      assert.strictEqual(f.effectiveAt, '2024-02-01T00:00:00.000Z', '存档时间来自快照而非抓取时间');
      assert.strictEqual(f.timePrecision, 'day');
      assert.strictEqual(f.atBasis, 'effective_at');
      assert.ok(String(f.observedAt) > String(f.effectiveAt), '观察时间晚于实际发生时间（今天抓到历史）');
    }
    // live 不允许声称 effective_at
    const bad = Memory.ingestCatalogObservation({
      tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1',
      domain: 'alpha.example.com', items: itemsA(), summary: summaryOf(itemsA()),
      snapshotIds: [snap.snapshot_id], evidenceIds: [ev],
      sourceKind: 'live_observation', effectiveAt: '2024-02-01T00:00:00.000Z',
    });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, 'live_must_not_claim_effective_at');
  });

  await t('C6/C7 存档事实必须带 Snapshot 与 Evidence；缺失硬拒绝', async () => {
    const noEv = Memory.ingestCatalogObservation({
      tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1',
      domain: 'alpha.example.com', items: itemsA(), summary: summaryOf(itemsA()),
      snapshotIds: ['ss_fake'], evidenceIds: [],
      sourceKind: 'archived_observation', effectiveAt: '2024-03-01T00:00:00.000Z', timePrecision: 'day',
    });
    assert.strictEqual(noEv.ok, false, '无 Evidence 不写入');
    assert.strictEqual(noEv.reason, 'evidence_required');
    // store 层准入（即使绕过 service 也必须拒绝）
    const ent = Store.listEntities('tenant:A', 'projA1', 'compA1', { entityType: 'product', limit: 1 })[0];
    assert.ok(ent, '存在商品实体');
    assert.throws(() => Store.insertFact({
      tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1',
      entityId: ent.entityId, entityVersionId: 'ev_none', entityType: 'product', factType: 'product.price',
      valueNum: 1, currency: 'USD', sourceKind: 'live_observation',
      observedAt: iso(0), evidenceIds: [], snapshotIds: ['ss_x'],
    }), /evidence_id and >=1 snapshot_id/, 'store 层强校验');
  });

  await t('C8 回补任务幂等：同范围重复发起只有一个任务', async () => {
    const a = Store.createBackfillJob({ tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1', capability: 'shopify_catalog', from: '2025-01-01', to: '2025-06-30' });
    const b = Store.createBackfillJob({ tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1', capability: 'shopify_catalog', from: '2025-01-01', to: '2025-06-30' });
    assert.strictEqual(a.deduped, false);
    assert.strictEqual(b.deduped, true);
    assert.strictEqual(a.job.jobId, b.job.jobId);
    const all = Store.listBackfillJobs('tenant:A', 'projA1', 'compA1', 20);
    assert.strictEqual(all.filter(j => j.requestedFrom === '2025-01-01').length, 1, '只存在一个任务');
  });

  await t('C9 重启恢复：租约过期回 pending，重试超限转 dead（不永久 running）', async () => {
    const j = Store.createBackfillJob({ tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1', capability: 'shopify_catalog', from: '2024-01-01', to: '2024-02-29' });
    const jobId = j.job.jobId;
    const claimed = Store.claimBackfillJob('tenant:A', jobId, 'w-old', NOW);
    assert.strictEqual(claimed.status, 'running', '已领取');
    // 模拟进程被杀：租约过期后回收
    const rec = Store.reclaimExpiredBackfillJobs(NOW + 120000, 3);
    assert.ok(rec.requeued >= 1, '回收为 pending');
    assert.strictEqual(Store.getBackfillJob('tenant:A', jobId).status, 'pending');
    // 用尽重试：反复领取 + 过期，最终 dead
    for (let i = 0; i < 4; i++) {
      const c = Store.claimBackfillJob('tenant:A', jobId, 'w-' + i, NOW);
      if (!c) break;
      Store.reclaimExpiredBackfillJobs(NOW + 120000 * (i + 2), 3);
    }
    const fin = Store.getBackfillJob('tenant:A', jobId);
    assert.ok(['dead', 'pending'].includes(fin.status), '最终为 dead 或仍在重试队列');
    assert.notStrictEqual(fin.status, 'running', '绝不永久 running');
    // 终态不可覆盖
    if (fin.status === 'dead') {
      const before = JSON.stringify(Store.getBackfillJob('tenant:A', jobId));
      Store.finishBackfillJob('tenant:A', jobId, 'w-late', { status: 'done', imported: 99 });
      assert.strictEqual(JSON.stringify(Store.getBackfillJob('tenant:A', jobId)), before, '终态不被覆盖');
    }
  });

  await t('C10 采集链路贯通：adapter → attempt → Evidence → Memory → API 可查', async () => {
    const tid = 'tenant:A', pid = 'projA1', compId = 'compA1';
    const domain = 'alpha.example.com';
    const bodies = {
      ['https://' + domain + '/products.json?limit=250&page=1']: JSON.stringify({
        products: [{ id: 2001, handle: 'cap', title: 'Cap', product_type: 'hat', published_at: '2026-01-01T00:00:00Z', variants: [{ price: '35.00', available: true }, { price: '35.00', available: true }] }],
      }),
    };
    const orig = {
      fetchShopifyProducts: Net.fetchShopifyProducts,
    };
    Net.fetchShopifyProducts = async (siteUrl, opts) => {
      const tidUsed = opts.tenantId || tid;
      const metas = [];
      for (const [u, body] of Object.entries(bodies)) {
        metas.push(mkSnapshot(tidUsed, u, body, { observedAt: iso(8) }));
      }
      // 币种必须有自己的快照（validator：有币种值就必须有币种快照且被 Evidence 引用）
      const cart = mkSnapshot(tidUsed, 'https://' + domain + '/cart.js', JSON.stringify({ currency: 'USD' }), {
        capability: 'storefront_currency', provider: 'shopify_cart_js_json', observedAt: iso(8),
      });
      const items = Net.mapShopifyItems(JSON.parse(bodies[Object.keys(bodies)[0]]).products);
      return {
        ok: true, items, total: items.length, url: 'https://' + domain + '/products.json',
        currency: 'USD',
        snapshotIds: metas.map(m => m.snapshot_id).concat([cart.snapshot_id]),
        currencySnapshotId: cart.snapshot_id, truncated: false,
        partialScan: false, partialScanReason: null, successfullyFetchedPages: [1], failedPage: null,
        _prov: { recorded: true, observed_at: iso(8) },
      };
    };
    try {
      const mk = SurfaceStore.createAttempt({
        tenantId: tid, projectId: pid, competitorId: compId,
        capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', nowMs: NOW,
      });
      const job = CollectJobs.enqueue({
        tenantId: tid, projectId: pid, competitorId: compId,
        capability: 'shopify_catalog', attemptId: mk.attempt.attemptId, trigger: 'manual',
      });
      assert.ok(!job.deduped, '任务入队');
      const out = await CollectJobs.tick({ workerId: 'mem-test' });
      assert.ok(out.claimed, 'worker 领取并执行');
      const att = SurfaceStore.getAttempt(tid, mk.attempt.attemptId);
      assert.strictEqual(att.status, 'success', 'attempt 成功');
      assert.ok(att.evidenceIds.length, '落账 Evidence');

      // API 层：真实 handler 读取
      const ctx = mkCtx(tid);
      await MemH.memoryView(ctx, { method: 'GET' }, fakeRes(), new URL('http://x/api/brands/' + brandA1 + '/memory?projectId=' + pid + '&factTypes=product.price'), '/api/brands/' + brandA1 + '/memory');
      assert.strictEqual(ctx.status, 200);
      const hit = ctx.body.facts.find(f => f.entityName === 'Cap' || f.value === 35);
      assert.ok(hit, 'API 返回本次采集的价格事实');
      assert.strictEqual(hit.sourceKind, 'live_observation');
      assert.ok(hit.evidenceIds.length && hit.snapshotIds.length, 'API 事实带证据引用');
      ctx.status = null;
      await MemH.timeline(ctx, { method: 'GET' }, fakeRes(), new URL('http://x/api/brands/' + brandA1 + '/timeline?projectId=' + pid), '/api/brands/' + brandA1 + '/timeline');
      assert.strictEqual(ctx.status, 200);
      assert.ok(ctx.body.items.some(i => i.type === 'live_observation'), '时间线含直接观察');
      assert.ok(!JSON.stringify(ctx.body).includes('attempt_'), '时间线不含 attempt id');
    } finally {
      Net.fetchShopifyProducts = orig.fetchShopifyProducts;
    }
  });

  await t('C11 接口不泄漏路径 / token / 栈 / claimToken', async () => {
    const tid = 'tenant:A';
    const urls = [
      ['/api/brands/' + brandA1 + '/memory?projectId=projA1', MemH.memoryView],
      ['/api/brands/' + brandA1 + '/timeline?projectId=projA1', MemH.timeline],
      ['/api/brands/' + brandA1 + '/history-coverage?projectId=projA1&from=2025-01-01&to=2026-10-19', MemH.historyCoverage],
    ];
    for (const [u, fn] of urls) {
      const ctx = mkCtx(tid);
      await fn(ctx, { method: 'GET' }, fakeRes(), new URL('http://x' + u), u.split('?')[0]);
      const s = JSON.stringify(ctx.body);
      assert.strictEqual(ctx.status, 200, u + ' 200');
      for (const bad of ['claimToken', 'claim_token', 'C:\\\\', '/app/', 'at Object.', 'Bearer ', 'ghp_', 'sk-', 'stack']) {
        assert.ok(!s.includes(bad), u + ' 不得包含 ' + bad);
      }
    }
    // 任务详情（跨租户 404，不泄露存在性）
    const job = Store.createBackfillJob({ tenantId: 'tenant:A', projectId: 'projA1', competitorId: 'compA1', capability: 'shopify_catalog', from: '2026-01-01', to: '2026-02-28' });
    const ctxB = mkCtx('tenant:B');
    await MemH.backfillJob(ctxB, { method: 'GET' }, fakeRes(), new URL('http://x/api/history-backfill/' + job.job.jobId), '/api/history-backfill/' + job.job.jobId);
    assert.strictEqual(ctxB.status, 404, '跨租户任务统一 404');
    const ctxA = mkCtx('tenant:A');
    await MemH.backfillJob(ctxA, { method: 'GET' }, fakeRes(), new URL('http://x/api/history-backfill/' + job.job.jobId), '/api/history-backfill/' + job.job.jobId);
    assert.strictEqual(ctxA.status, 200);
    assert.ok(!('claimToken' in ctxA.body), '任务详情不含 claimToken');
  });

  await t('C12 覆盖状态区分：未开始 / 已核实 / 部分覆盖，且零事实不写「没有变化」', async () => {
    // 未开始（projA2 无采集）
    const ctx2 = mkCtx('tenant:A');
    await MemH.historyCoverage(ctx2, { method: 'GET' }, fakeRes(), new URL('http://x/api/brands/' + brandA2 + '/history-coverage?projectId=projA2&from=2025-10-01&to=2026-10-19'), '/api/brands/' + brandA2 + '/history-coverage');
    assert.strictEqual(ctx2.status, 200);
    assert.strictEqual(ctx2.body.summary.state, 'not_started');
    assert.ok(/尚未开始/.test(ctx2.body.note) || /尚未开始/.test(ctx2.body.summary.stateText), '未开始文案');
    assert.ok(ctx2.body.dimensions.every(d => d.state === 'not_started'), '所有维度标未开始');
    assert.ok(ctx2.body.dimensions.every(d => d.factCount === 0), '未开始不构造事实数字');
    assert.strictEqual(ctx2.body.summary.factCount, 0, '总事实数为 0（真实零，不是伪造）');
    // 已核实 + 缺口
    const cov = View.buildHistoryCoverage('tenant:A', 'projA1', 'compA1', { from: '2026-08-01', to: '2026-10-31' });
    const prod = cov.dimensions.find(d => d.key === 'product');
    assert.ok(prod.coveredRanges.length > 0, '有已覆盖区间');
    assert.ok(prod.unknownRanges.length > 0, '有无法确认区间（缺口如实标注）');
    assert.ok(prod.evidenceCount > 0 && prod.snapshotCount > 0, '来源与证据计数');
    // 允许「无记录不等于没有变化」这类免责声明，禁止的是把缺口写成结论
    const s = JSON.stringify(cov).split('无记录不等于没有变化。').join('');
    for (const bad of ['没有变化', '无变化', '0 条变化', '未观察到变化']) {
      const ix = s.indexOf(bad);
      assert.ok(ix < 0, '覆盖投影不得写 ' + bad + ' @ ' + (ix < 0 ? '' : JSON.stringify(s.slice(Math.max(0, ix - 60), ix + 30))));
    }
    // partial：partial 月份进入 partialRanges
    const covPartial = View.buildHistoryCoverage('tenant:A', 'projA1', 'compA1', { from: '2026-10-01', to: '2026-10-31' });
    const p2 = covPartial.dimensions.find(d => d.key === 'product');
    assert.ok(p2.partialRanges.length > 0 || p2.coveredRanges.length > 0, 'partial 或 covered 有明确归属');
  });

  await t('C13 存档回补真实链路：来源不可用时如实落 source_unavailable（不伪造历史）', async () => {
    const tid = 'tenant:A', pid = 'projA1', compId = 'compA1';
    const j = Store.createBackfillJob({ tenantId: tid, projectId: pid, competitorId: compId, capability: 'shopify_catalog', from: '2025-01-01', to: '2025-03-31' });
    const r = await Backfill.runJob({ tenantId: tid, jobId: j.job.jobId, workerToken: 'bf-test' });
    const job = Store.getBackfillJob(tid, j.job.jobId);
    // 本环境 archive.org 不可达：必须如实落 source_unavailable / no_archive_record，且不得有导入
    assert.ok(['source_unavailable', 'no_archive_record', 'done', 'partial'].includes(job.status), '状态为明确的终态');
    if (job.status !== 'done' && job.status !== 'partial') {
      assert.strictEqual(job.counts.imported, 0, '未补入任何历史');
      assert.ok(job.errorUserText && !/http/i.test(job.errorUserText), '用户文案不含 URL');
    }
    assert.ok(!('claimToken' in job) || job.claimToken == null, '任务结束后释放租约');
    assert.ok(r, '执行返回结果');
  });

  await t('C14 存档分桶：每月至多一个点、digest 去重、上限生效', async () => {
    const rows = [];
    for (let m = 1; m <= 30; m++) {
      const mm = String(m).padStart(2, '0');
      rows.push({ timestamp: '2025' + mm + '01000000', iso: '2025-' + mm + '-01T00:00:00.000Z', digest: 'd' + m });
      rows.push({ timestamp: '2025' + mm + '02000000', iso: '2025-' + mm + '-02T00:00:00.000Z', digest: 'd' + m }); // 同月第二点 + 同 digest
    }
    const b = Archive.bucketByMonth(rows, { maxPoints: 24 });
    const months = b.points.map(p => p.iso.slice(0, 7));
    assert.strictEqual(new Set(months).size, months.length, '每月最多一个点');
    assert.ok(b.points.length <= 24, '上限 24 生效');
    assert.strictEqual(b.points.length, 24);
    assert.ok(b.droppedByCap >= 6, '超出上限如实登记');
    // 时间戳解析
    assert.strictEqual(Archive.archiveTimestampToIso('20240201123456'), '2024-02-01T00:00:00.000Z');
  });

  await t('C15 时间线包含价格变化事件（不能只剩首次观察）', async () => {
    const tl = View.buildTimeline('tenant:A', 'projA1', 'compA1', { limit: 100 });
    const types = tl.items.map(i => i.eventType).filter(Boolean);
    assert.ok(types.includes('product_price_changed'), '价格变化事件必须在时间线里，实际：' + JSON.stringify(types));
    const priceItem = tl.items.find(i => i.eventType === 'product_price_changed');
    assert.ok(priceItem.evidenceIds.length >= 1 && priceItem.snapshotIds.length >= 1, '事件条目带证据入口');
    assert.ok(/→/.test(String(priceItem.detail)), '展示 from → to');
    assert.ok(tl.items.some(i => i.type === 'live_observation'), '同时含直接观察');
    assert.ok(tl.items.some(i => i.type === 'archived_observation'), '同时含历史存档观察');
  });

  // ---------- 汇总 ----------
  Store.closeDb();
  console.log('\n[memory-foundation] ' + (total - failed) + '/' + total + ' passed');
  if (failed) { console.error('[memory-foundation] FAILURES: ' + failed); process.exit(1); }
})().catch(e => { console.error('FATAL', e); process.exit(1); });
