'use strict';
// ============================================================
// data-surface.test.js —— 五维数据面回归（SC-02 / 05 v0.4.0 §25）
// 2026-10-18 整改轮（独立审核 CHANGES REQUIRED）覆盖：
//   D1  Registry 唯一事实源（+ refreshPolicy/adapters 契约）
//   D2  Adapter Contract 结构自检（supports/resolveIdentity/collect/normalize/health）
//   D3  多页快照真值链：Evidence 引用全部页快照 + 汇总可复算（§一.1/§一.2）
//   D4  币种可追溯：无币种快照 → currency null；validator 拒绝有值无快照（§一.3）
//   D5  identity 门控：默认 unresolved；证据齐备才 resolved（§一.5）
//   D6  两租户完全隔离（§六.13）
//   D7  手动刷新幂等 + capability cooldown（§五.5）
//   D8  状态三拆：失败保留旧数据 + latest_failure gap；stale+partial 双 gap；
//       过期 running → interrupted 而非 empty（§三.1/§三.2/§三.3/§三.4）
//   D9  未接入维度零构造：social_content 明细绝不返回 Shopify 数据（§二.2）
//   D10 同维度双 capability 聚合（catalog + collections 判别联合摘要）（§二.5/§二.6）
//   D11 同平台多账号 identity 共存（§二.7）
//   D12 timeout 独立分类（§三.8）
//   D13 持久任务恢复：claim/heartbeat/reclaim/reconcile + retry 耗尽终态（§三.6/§三.7 单测级）
//   D14 refresh handler 真实路径：202 入队 / cooldown deduped / admin handler 401/403
//   D15 前端源码断言：币种 / 刷新中旧数据 / 最新失败 / 竞态与序号 / 时区 / 多 Evidence
//   D16 validator 静默接受禁止：缺字段/维度不匹配/引用不完整 → 显式失败
// 测试不发真实网络请求：net 采集函数用模块导出替换；快照用真实 Snapshot.record 落盘。
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离先行：ZB_DATA_DIR 必须在任何业务模块 require 之前指向全新目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-ds-test-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1'; // worker 常驻循环由 tick() 显式驱动
try { fs.rmSync(path.join(__dirname, '..', 'data', 'alerts'), { recursive: true, force: true }); } catch (e) {}

const Registry = require('../services/capability-registry.js');
const SurfaceStore = require('../services/surface-store.js');
const Adapters = require('../services/source-adapter.js');
const Surface = require('../services/data-surface.js');
const Snapshot = require('../research/source-snapshot.js');
const EvidenceStore = require('../research/evidence-store.js');
const Net = require('../research/net.js');
const CollectJobs = require('../services/collect-jobs.js');
const { saveState, projFile } = require('../core/state-store.js');
require('../routes/index.js');
const DataSurfaceH = require('../routes/handlers/data-surface.js');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('ok ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n  ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n  ')); }
}
const NOW = Date.parse('2026-10-18T06:00:00Z');

async function mkProject(tid, pid, compId, opts) {
  const o = opts || {};
  fs.mkdirSync(path.dirname(projFile(pid, tid)), { recursive: true });
  saveState({
    projectId: pid, tenantId: tid, track: 'T-' + pid,
    discoveredAt: new Date(NOW).toISOString(),
    intent: { regions: ['us'] },
    competitors: [{
      id: compId, name: 'Brand ' + compId, status: 'done',
      url: 'https://' + compId + '.' + (o.domain || 'example.com'),
      isShopify: o.isShopify !== false, currency: 'USD',
    }],
  });
  const f = projFile(pid, tid);
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));
  if (!fs.existsSync(f)) throw new Error('state 文件未落盘');
}
function readState(tid, pid) { return JSON.parse(fs.readFileSync(projFile(pid, tid), 'utf8')); }

function mkCtx(tid, kind) {
  const out = { status: null, body: null };
  out.sendJSON = (res, code, obj) => { out.status = code; out.body = obj; return true; };
  out.readBody = async () => out._body || {};
  out.getAuthPayload = () => {
    if (kind === 'admin') return { kind: 'admin', payload: { role: 'platform_admin' } };
    if (tid) return { kind: 'tenant', payload: { tid } };
    return null;
  };
  out.loadState = () => null;
  out.projFile = (id, t2) => projFile(id, t2 || tid);
  return out;
}
const fakeRes = () => ({ headersSent: false, writeHead() {}, end() {} });

// 真实 SourceSnapshot（Evidence 链需要租户内可解析的快照；页快照带 ?page=N）
function mkSnapshot(tid, url, body, opts) {
  const o = opts || {};
  const r = Snapshot.record({
    capability: o.capability || 'product_catalog', provider: o.provider || 'shopify_products_json',
    source_url: url, source_status: o.sourceStatus || 'success',
    observed_at: new Date(NOW).toISOString(), fetched_at: new Date(NOW).toISOString(),
    bodyBytes: Buffer.from(body), contentType: 'application/json',
    trigger: 'manual', tenantId: tid,
    partial_scan: o.partialScan == null ? null : o.partialScan,
  });
  assert.ok(r.recorded, 'snapshot recorded: ' + url);
  return r.meta;
}
// 页快照合集 + 币种快照（真实 blob，可复算）。🔴 复审 §四：**无聚合快照**——
// 原始字节只以页级快照存在（source_url 带 page=N），聚合统计只进 attempt summary。
// P3 断货与 stub items 的 soldOut 语义对齐——复算口径必须与采集归一口径逐字段一致。
function pageBody(ids) {
  return JSON.stringify({ products: ids.map(id => ({ id, title: 'P' + id, product_type: 'x', variants: [{ price: String(id * 10), available: id % 3 !== 0 }] })) });
}
function mkCatalogSnapshots(tid, base, opts) {
  const site = String(base).replace(/\/products\.json$/, ''); // 调用方可能带 /products.json 尾巴
  const page1 = pageBody([1, 2]);
  const page2 = pageBody([3]);
  const p1 = mkSnapshot(tid, site + '/products.json?limit=250&page=1', page1);
  const p2 = mkSnapshot(tid, site + '/products.json?limit=250&page=2', page2);
  const cart = mkSnapshot(tid, site + '/cart.js', JSON.stringify({ currency: 'USD' }), { capability: 'storefront_currency', provider: 'shopify_cart_js_json' });
  return { p1, p2, cart, snapshotIds: [p1.snapshot_id, p2.snapshot_id], pageBodies: [page1, page2] };
}

// collections 抓取结果（对齐 net.js 整改契约：net 层落原始字节快照并返回
// snapshotId/_prov/sourceObservedCount/storedCount/partialScan；adapter 不再自建快照）
function okCollectionsResult(tid, url, opts) {
  const o = opts || {};
  const cols = Array.isArray(o.collections) ? o.collections : [{ title: '新品', handle: 'new' }, { title: '热卖', handle: 'hot' }];
  const meta = mkSnapshot(tid, url + '?limit=250', JSON.stringify({ collections: cols }), {
    capability: 'storefront_collections', provider: 'shopify_collections_json',
    partialScan: !!o.partialScan,
  });
  const observed = cols.length;
  const stored = o.storedCount != null ? o.storedCount : observed;
  return {
    ok: true, collections: cols, url: url.replace(/\?.*$/, ''), sourceUrl: url + '?limit=250',
    snapshotId: meta.snapshot_id,
    _prov: { recorded: true, source_snapshot_id: meta.snapshot_id, observed_at: meta.observed_at, source_status: meta.source_status, content_hash: meta.content_hash, fetched_at: meta.fetched_at },
    partialScan: !!o.partialScan, partialScanReason: o.partialScan ? 'collections_store_cap_50' : null,
    sourceObservedCount: observed, storedCount: stored, successfullyFetchedPages: 1, failedPage: null,
  };
}
function stubFetch(fn) {
  const orig = Net.fetchShopifyProducts;
  let calls = 0;
  Net.fetchShopifyProducts = async (...args) => { calls++; return fn(...args); };
  return { restore() { Net.fetchShopifyProducts = orig; }, count() { return calls; } };
}
function stubCollections(fn) {
  const orig = Net.fetchShopifyCollections;
  let calls = 0;
  Net.fetchShopifyCollections = async (...args) => { calls++; return fn(...args); };
  return { restore() { Net.fetchShopifyCollections = orig; }, count() { return calls; } };
}
// 完整 ok 结果：多页快照 + 币种快照（currency 与 currencySnapshotId 必须并存或并存 null）
function okFetchResult(tid, url, opts) {
  const o = opts || {};
  const snaps = mkCatalogSnapshots(tid, url);
  const noCurrency = !!o.noCurrency;
  return {
    ok: true,
    items: [
      { id: 1, title: 'P1', repPrice: 10, soldOut: false, publishedAt: null },
      { id: 2, title: 'P2', repPrice: 20, soldOut: false, publishedAt: '2026-10-01' },
      { id: 3, title: 'P3', repPrice: 30, soldOut: true, publishedAt: null },
    ],
    total: 3, truncated: !!o.truncated, url: url + '/products.json',
    currency: noCurrency ? null : 'USD',
    snapshotIds: snaps.snapshotIds.concat(noCurrency ? [] : [snaps.cart.snapshot_id]),
    currencySnapshotId: noCurrency ? null : snaps.cart.snapshot_id,
    _prov: { recorded: true, observed_at: snaps.p1.observed_at }, // 元数据载体（非快照引用）
  };
}

(async () => {
  const TID_A = 'tenant:dsA', TID_B = 'tenant:dsB';
  const dbx = require('../services/db.js');
  dbx.createTenant({ name: 'dsA', email: 'dsA@example.com' });
  dbx.createTenant({ name: 'dsB', email: 'dsB@example.com' });
  for (const [tid, pid] of [[TID_A, 'projA'], [TID_B, 'projB'], [TID_A, 'projC'], [TID_A, 'projD'], [TID_A, 'projE'], [TID_A, 'projF'], [TID_A, 'projG'], [TID_A, 'projH'], [TID_A, 'projI']]) {
    dbx.saveProject({ id: pid, tenantId: tid, track: 'T-' + pid, competitors: '[]', createdAt: new Date(NOW).toISOString(), discoveredAt: new Date(NOW).toISOString() });
  }
  await mkProject(TID_A, 'projA', 'compA1');
  await mkProject(TID_B, 'projB', 'compB1');
  await mkProject(TID_A, 'projC', 'compC1', { isShopify: false }); // 非 Shopify → unsupported
  await mkProject(TID_A, 'projD', 'compD1'); // failed 态专用
  await mkProject(TID_A, 'projE', 'compE1'); // 幂等/cooldown 专用
  await mkProject(TID_A, 'projF', 'compF1'); // 多账号 identity 专用
  await mkProject(TID_A, 'projG', 'compG1'); // timeout 分类专用
  await mkProject(TID_A, 'projH', 'compH1'); // 无历史成功的隔离 scope（fencing/Evidence 失败）
  await mkProject(TID_A, 'projI', 'compI1'); // 分页 partial 端到端隔离 scope

  // ---------- D1 Registry ----------
  await t('D1 Registry 完整性 + 五维 + 双能力 + refreshPolicy 契约', async () => {
    const ig = Registry.assertRegistryIntegrity();
    assert.ok(ig.ok, 'registry integrity: ' + ig.errors.join(';'));
    assert.strictEqual(Registry.listDimensions().length, 5);
    assert.strictEqual(Registry.listCapabilities().length, 6, 'shopify_catalog + shopify_collections + 4 占位');
    const shop = Registry.getCapability('shopify_catalog');
    assert.strictEqual(shop.maturity, 'ga');
    assert.notStrictEqual(shop.parserVersion, shop.collectorVersion, 'SC-01：parser ≠ collector');
    assert.ok(shop.refreshPolicy.cooldownMinutes > 0, 'ga 能力必须有 cooldown 保护');
    const wpCaps = Registry.capabilitiesByDimension('website_products');
    assert.strictEqual(wpCaps.length, 2, 'website_products = catalog + collections 双能力');
    assert.deepStrictEqual(Registry.adaptersForCapability('shopify_catalog'), ['shopify']);
    assert.deepStrictEqual(Registry.adaptersForCapability('shopify_collections'), ['shopify_collections']);
    for (const code of ['social_content', 'ad_activity', 'review_rating', 'search_interest']) {
      const c = Registry.getCapability(code);
      assert.strictEqual(c.maturity, 'not_integrated');
      assert.strictEqual(c.manualRefresh, false);
      assert.strictEqual(c.adapter, null, '未接入能力不得虚设 adapter');
      assert.strictEqual(c.adapters.length, 0);
    }
  });

  // ---------- D2 Adapter Contract 结构 ----------
  await t('D2 Adapter Contract：五方法结构自检 + validator 拒绝残缺 adapter', async () => {
    const integ = Adapters.assertAdaptersIntegrity();
    assert.ok(integ.ok, 'adapters integrity: ' + integ.errors.join(';'));
    for (const code of ['shopify', 'shopify_collections']) {
      const ad = Adapters.getAdapter(code);
      assert.ok(ad, code + ' registered');
      for (const m of Adapters.ADAPTER_METHODS) assert.strictEqual(typeof ad[m], 'function', code + '.' + m);
      assert.ok(Adapters.validateAdapter(ad).ok);
    }
    // 残缺 adapter（缺 normalize）必须被结构自检拒绝
    const bad = { code: 'bad', version: '1', supports() {}, resolveIdentity() {}, collect() {}, health() {} };
    assert.strictEqual(Adapters.validateAdapter(bad).ok, false, '缺 normalize 必须失败');
    const badKind = { code: 'bad2', version: '1', supports() {}, resolveIdentity() {}, collect() {}, normalize() {}, health() {}, summaryKinds: ['not_a_kind'] };
    assert.strictEqual(Adapters.validateAdapter(badKind).ok, false, '未知 summary.kind 必须失败');
  });

  // ---------- D3/D4 真值链：多页快照 + 可复算 + 币种可追溯 ----------
  await t('D3 多页快照真值链：Evidence 引用全部页快照，汇总可由全部快照复算', async () => {
    const st = stubFetch(async () => okFetchResult(TID_A, 'https://compA1.example.com/products.json'));
    try {
      const comp = readState(TID_A, 'projA').competitors[0];
      const r = await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projA', competitor: comp, trigger: 'manual' });
      assert.strictEqual(r.deduped, false);
      assert.strictEqual(r.attempt.status, 'success');
      assert.strictEqual(r.attempt.snapshotIds.length, 3, '2 页 + 币种快照全部落账，无聚合伪装（实际 ' + r.attempt.snapshotIds.length + '）');
      // 🔴 复审 §四.4：每个 product_catalog 快照的 source_url 必须带 page=N（禁首页顶聚合 URL）
      for (const sid of r.attempt.snapshotIds) {
        const m = Snapshot.getById(TID_A, sid);
        if (m && m.capability === 'product_catalog') assert.ok(/page=[0-9]/.test(String(m.source_url || '')), '页快照 source_url 带 page=N: ' + m.source_url);
      }
      const ev = EvidenceStore.getEvidenceById(TID_A, r.attempt.evidenceIds[0]);
      assert.ok(ev, 'evidence 租户内可读');
      assert.strictEqual(ev.evidence_status, 'verified');
      assert.strictEqual(ev.parser_version, 'shopify-adapter-1');
      assert.notStrictEqual(ev.parser_version, 'net-1', 'SC-01');
      // 引用完整：attempt.snapshotIds ⊆ evidence.source_snapshot_ids（含币种快照）
      for (const sid of r.attempt.snapshotIds) assert.ok(ev.source_snapshot_ids.includes(sid), 'evidence 引用快照 ' + sid);
      const currencySnap = ev.source_snapshot_ids.find(sid => {
        const m = Snapshot.getById(TID_A, sid); return m && m.capability === 'storefront_currency';
      });
      assert.ok(currencySnap, '币种快照被 Evidence 引用');
      assert.strictEqual(ev.currency, 'USD');
      // 🔴 复算：从 Evidence 引用的页快照 blob 合并重算 = extracted_value
      const pageSnaps = ev.source_snapshot_ids
        .map(sid => Snapshot.getById(TID_A, sid))
        .filter(m => m && m.capability === 'product_catalog' && /page=/.test(String(m.source_url || '')));
      assert.strictEqual(pageSnaps.length, 2, '两张页快照被引用（禁首页顶全部）');
      let merged = [];
      for (const m of pageSnaps) {
        const raw = JSON.parse(Snapshot.readRawPayload(m).toString('utf8'));
        merged = merged.concat(Array.isArray(raw.products) ? raw.products : []);
      }
      const items = Net.mapShopifyItems(merged);
      const stats = Adapters.summarize(items);
      const ex = ev.extracted_value;
      assert.strictEqual(ex.count, stats.count, 'count 可由页快照复算');
      assert.strictEqual(ex.onSaleCount, stats.onSaleCount, 'onSaleCount 可复算');
      assert.strictEqual(ex.priceMin, stats.priceMin, 'priceMin 可复算');
      assert.strictEqual(ex.priceMax, stats.priceMax, 'priceMax 可复算');
      assert.strictEqual(ex.priceMedian, stats.priceMedian, 'priceMedian 可复算');
      // 币种复算：cart.js 快照 blob 的 currency = evidence.currency
      const cartMeta = Snapshot.getById(TID_A, currencySnap);
      const cartJson = JSON.parse(Snapshot.readRawPayload(cartMeta).toString('utf8'));
      assert.strictEqual(String(cartJson.currency).toUpperCase(), ev.currency, 'currency 可由币种快照复算');
      assert.ok(!/page=/.test(String(cartMeta.source_url || '')), '币种快照源是 cart.js');
      // 投影一致性：总览摘要与 Evidence 一致
      const ov = Surface.buildOverview({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', comp });
      const agg = ov.dimensions.find(d => d.code === 'website_products').aggregations.find(a => a.capability.code === 'shopify_catalog');
      assert.strictEqual(agg.summary.kind, 'storefront_catalog');
      assert.strictEqual(agg.summary.count, ex.count);
      assert.strictEqual(agg.summary.currency, 'USD');
      assert.strictEqual(agg.summary.currencyStatus, 'confirmed');
    } finally { st.restore(); }
  });

  await t('D4 无币种快照 → currency null；validator 拒绝「有值无快照」', async () => {
    const st = stubFetch(async () => okFetchResult(TID_A, 'https://compA1.example.com/products.json', { noCurrency: true }));
    try {
      const comp = readState(TID_A, 'projA').competitors[0];
      const r = await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projA', competitor: comp, trigger: 'manual', idempotencyKey: 'd4-nocur' });
      assert.strictEqual(r.attempt.status, 'success');
      const ev = EvidenceStore.getEvidenceById(TID_A, r.attempt.evidenceIds[0]);
      assert.strictEqual(ev.currency, null, '无币种快照 → Evidence.currency null');
      assert.strictEqual(ev.extracted_value.currency, null, '无币种快照 → extracted_value.currency null');
      const ov = Surface.buildOverview({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', comp });
      const agg = ov.dimensions.find(d => d.code === 'website_products').aggregations.find(a => a.capability.code === 'shopify_catalog');
      assert.strictEqual(agg.summary.currency, null);
      assert.strictEqual(agg.summary.currencyStatus, 'unknown');
      // validator：有 currency 无 currencySnapshotId → 必须失败（禁止静默接受）
      const badOut = Adapters.getAdapter('shopify').normalize({
        items: [{ id: 9, title: 'X', repPrice: 5, soldOut: false }],
        snapshotIds: ['snap_x'], truncated: false, currency: 'USD', currencySnapshotId: null, url: 'https://x/products.json',
        _prov: { recorded: true, observed_at: new Date().toISOString() },
      }, { competitor: comp });
      const v = Adapters.validateOutput(badOut, { capability: 'shopify_catalog' });
      assert.strictEqual(v.ok, false, '有 currency 无币种快照必须被 validator 拒绝');
      assert.ok(v.errors.some(e => /currency/.test(e)), '错误信息点名币种问题');
      // validator：dimension 不匹配 → 必须失败
      const badDim = Object.assign({}, badOut, { capability: 'shopify_catalog', dimension: 'social_content', currency: null, currencySnapshotId: null });
      assert.strictEqual(Adapters.validateOutput(badDim, { capability: 'shopify_catalog' }).ok, false);
      // validator：success 但无证据快照 → 必须失败
      const noEv = Object.assign({}, badOut, { currency: null, currencySnapshotId: null, evidenceSnapshotIds: [] });
      assert.strictEqual(Adapters.validateOutput(noEv, { capability: 'shopify_catalog' }).ok, false);
      // validator：summary.kind 与 capability 不匹配 → 必须失败
      const badKind = Object.assign({}, badOut, { currency: null, currencySnapshotId: null, summary: { kind: 'storefront_collections', collectionCount: 1, collections: [] } });
      assert.strictEqual(Adapters.validateOutput(badKind, { capability: 'shopify_catalog' }).ok, false);
    } finally { st.restore(); }
  });

  // ---------- D5 identity 门控 ----------
  await t('D5 identity：默认 unresolved；仅证据齐备才 resolved；失败不降级既有 resolved', async () => {
    const comp = readState(TID_A, 'projA').competitors[0];
    // 默认解析 = unresolved（00 §53 三值，无 candidate）
    const ident = Adapters.getAdapter('shopify').resolveIdentity({ url: comp.url, isShopify: true });
    assert.strictEqual(ident.identityStatus, 'unresolved');
    // 失败采集 → identity unresolved（projD 无历史）
    const stF = stubFetch(async () => ({ ok: false, status: 403 }));
    try {
      await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projD', competitor: readState(TID_A, 'projD').competitors[0], trigger: 'manual', idempotencyKey: 'd5-fail' });
    } finally { stF.restore(); }
    const identD = SurfaceStore.getIdentity(TID_A, 'projD', 'compD1', 'shopify');
    assert.ok(identD, 'identity 落库');
    assert.strictEqual(identD.identityStatus, 'unresolved', '失败后不得 resolved');
    assert.strictEqual(identD.evidenceIds.length, 0, '无证据');
    // 空目录（可访问 0 款）→ unresolved（无 Evidence 不满足 resolved 门控）
    const stE = stubFetch(async () => ({ ok: false, empty: true, snapshotIds: ['snap_empty_x'], currency: 'USD', currencySnapshotId: 'snap_cart_x' }));
    try {
      await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projD', competitor: readState(TID_A, 'projD').competitors[0], trigger: 'manual', idempotencyKey: 'd5-empty' });
    } finally { stE.restore(); }
    assert.strictEqual(SurfaceStore.getIdentity(TID_A, 'projD', 'compD1', 'shopify').identityStatus, 'unresolved', '空目录无 Evidence → 保持 unresolved');
    // 成功 + 证据 → resolved（projA 已有 D3 成功链路；重放确认不降级）
    const stS = stubFetch(async () => okFetchResult(TID_A, 'https://compA1.example.com/products.json'));
    try {
      await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projA', competitor: comp, trigger: 'manual', idempotencyKey: 'd5-ok' });
    } finally { stS.restore(); }
    const identA = SurfaceStore.getIdentity(TID_A, 'projA', 'compA1', 'shopify');
    assert.strictEqual(identA.identityStatus, 'resolved', '证据齐备 → resolved');
    assert.ok(identA.evidenceIds.length >= 1 && identA.snapshotIds.length >= 1, 'resolved 必须关联 Evidence/Snapshot');
  });

  // ---------- D6 两租户隔离 ----------
  await t('D6 两租户完全隔离：overview/dimension/refresh 跨租户 404；identity/attempt/job 互不可见', async () => {
    const ctxB = mkCtx(TID_B);
    ctxB._body = { competitorId: 'compA1', projectId: 'projA' };
    await DataSurfaceH.refresh(ctxB, { method: 'POST' }, fakeRes(), new URL('http://x/api/data-surface/refresh'), '/api/data-surface/refresh');
    assert.strictEqual(ctxB.status, 404, 'B 刷新 A 的竞品 → 404');
    await DataSurfaceH.overview(ctxB, { method: 'GET' }, fakeRes(), new URL('http://x/api/data-surface/overview?projectId=projA&competitorId=compA1'), '/api/data-surface/overview');
    assert.strictEqual(ctxB.status, 404);
    const compB = readState(TID_B, 'projB').competitors[0];
    const ovB = Surface.buildOverview({ tenantId: TID_B, projectId: 'projB', competitorId: 'compB1', comp: compB });
    assert.strictEqual(JSON.stringify(ovB).includes('compA1'), false, 'B 的数据面零 A 泄漏');
    assert.strictEqual(SurfaceStore.getIdentity(TID_B, 'projB', 'compA1', 'shopify'), null, '跨租户身份查询 → null');
    assert.strictEqual(SurfaceStore.listAttempts(TID_B, 'projB', 'compA1', 'shopify_catalog', 10).length, 0);
    assert.strictEqual(CollectJobs.enqueue({ tenantId: TID_B, projectId: 'projB', competitorId: 'compA1', capability: 'shopify_catalog', attemptId: 'att_x' }).deduped, false);
    const jobs = CollectJobs.list(TID_B, 'projB', null).filter(j => j.competitorId === 'compA1');
    assert.strictEqual(jobs.length, 1, 'B 自己的 job 落 B 命名空间');
    CollectJobs.finish(jobs[0].jobId, jobs[0].claimToken || 'ct_x', 'error', 'cleanup');
    // A 侧看不到 B 的 job
    assert.strictEqual(CollectJobs.list(TID_A, 'projA', null).filter(j => j.competitorId === 'compA1').length, 0);
  });

  // ---------- D7 幂等 + cooldown ----------
  await t('D7 刷新幂等：双击 deduped；成功后 5 分钟 cooldown 内不重复采集', async () => {
    // projE：先造一次成功 attempt，随后刷新应被 cooldown deduped
    const st = stubFetch(async () => okFetchResult(TID_A, 'https://compe1.example.com/products.json'));
    try {
      const compE = readState(TID_A, 'projE').competitors[0];
      const r1 = await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projE', competitor: compE, trigger: 'manual', nowMs: NOW });
      assert.strictEqual(r1.attempt.status, 'success');
      // cooldown 内再 createAttempt → deduped(cooldown)
      const mk2 = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projE', competitorId: 'compE1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', nowMs: NOW + 60 * 1000 });
      assert.strictEqual(mk2.deduped, true, 'cooldown 内复用');
      assert.strictEqual(mk2.cooldown, true);
      // 超过 cooldown（6 分钟后）→ 允许新 attempt
      const mk3 = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projE', competitorId: 'compE1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', nowMs: NOW + 6 * 60 * 1000 });
      assert.strictEqual(mk3.deduped, false, 'cooldown 外允许新采集');
      assert.strictEqual(mk3.attempt.status, 'running');
      // 直接收尾该 attempt（模拟 worker 完成后），避免 running 残留影响后续断言
      SurfaceStore.completeAttempt(TID_A, mk3.attempt.attemptId, { status: 'success', sourceStatus: 'success', observations: [], snapshotIds: [], evidenceIds: [] });
      // handler 级：cooldown 内再刷新 → running/cooldown deduped → 200（含 policy）
      const ctxE = mkCtx(TID_A);
      ctxE._body = { competitorId: 'compE1', projectId: 'projE' };
      await DataSurfaceH.refresh(ctxE, { method: 'POST' }, fakeRes(), new URL('http://x/api/data-surface/refresh'), '/api/data-surface/refresh');
      // 注意：此刻 running attempt 存在 → running 复用 deduped（in_progress 优先于 cooldown）
      assert.strictEqual(ctxE.status, 200);
      assert.strictEqual(ctxE.body.deduped, true);
      assert.ok(ctxE.body.policy, 'deduped 响应带 refresh policy');
      // refresh-policy 端点
      const ctxP = mkCtx(TID_A);
      await DataSurfaceH.refreshPolicy(ctxP, { method: 'GET' }, fakeRes(), new URL('http://x/api/data-surface/refresh-policy?projectId=projE&competitorId=compE1&capability=shopify_catalog'), '/api/data-surface/refresh-policy');
      assert.strictEqual(ctxP.status, 200);
      assert.strictEqual(ctxP.body.capability, 'shopify_catalog');
      assert.ok(ctxP.body.cooldownMinutes >= 5);
      // 等待后台 worker tick 收尾（D14 前的 projE attempt 终结）
      await CollectJobs.tick({ workerId: 'test-d7' });
      const atts = SurfaceStore.listAttempts(TID_A, 'projE', 'compE1', 'shopify_catalog', 20);
      assert.ok(atts.every(a => a.status !== 'running'), 'tick 后无 running 残留');
    } finally { st.restore(); }
  });

  // ---------- D8 状态三拆 ----------
  await t('D8a 成功后再失败：latestAttempt failed + latestUsable 旧数据仍在 + latest_failure gap', async () => {
    const comp = readState(TID_A, 'projA').competitors[0];
    const T8 = Date.now() + 3600e3; // 真实时间基准 +1h（与 D3/D4/D5 attempt 的真实 started_at 同底座）
    // projA 已有成功（D3/D4/D5）；现在注入一次失败（显式 idempotencyKey 强制新 attempt）
    const stF = stubFetch(async () => ({ ok: false, status: 503 }));
    try {
      await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projA', competitor: comp, trigger: 'manual', idempotencyKey: 'd8a-fail', nowMs: T8 });
    } finally { stF.restore(); }
    const ov = Surface.buildOverview({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', comp, nowMs: T8 });
    const agg = ov.dimensions.find(d => d.code === 'website_products').aggregations.find(a => a.capability.code === 'shopify_catalog');
    assert.strictEqual(agg.latestAttempt.status, 'failed', 'latestAttempt = 最近一次失败');
    assert.ok(agg.latestAttempt.errorText, '失败文案（用户面）');
    assert.ok(agg.summary, 'latestUsable 旧摘要仍在');
    assert.strictEqual(agg.surfaceState, 'ok', '主徽章仍展示旧数据状态（不吞）');
    assert.ok(agg.gaps.some(g => g.code === 'latest_failure'), 'latest_failure gap 明确');
    assert.ok(agg.gaps.find(g => g.code === 'latest_failure').text.includes('上次成功数据'), 'gap 文案：失败保留旧数据');
    assert.strictEqual(agg.isRefreshing, false);
  });

  await t('D8b stale + partial 双 gap 并存（主徽章 stale，partial 不被吞）', async () => {
    const comp = readState(TID_A, 'projA').competitors[0];
    // projA 最近终态改为「partial + 40h 前」→ 同时 stale 与 partial
    const rows = SurfaceStore.listAttempts(TID_A, 'projA', 'compA1', 'shopify_catalog', 20);
    const lastUsable = rows.find(a => a.status === 'success' || a.status === 'partial');
    const old = new Date(NOW - 40 * 3600e3).toISOString();
    SurfaceStore.getDb().prepare("UPDATE collection_attempts SET status='partial', source_status='partial', ended_at=?, updated_at=? WHERE tenant_id=? AND attempt_id=?")
      .run(old, old, TID_A, lastUsable.attemptId);
    const ov = Surface.buildOverview({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', comp, nowMs: NOW });
    const agg = ov.dimensions.find(d => d.code === 'website_products').aggregations.find(a => a.capability.code === 'shopify_catalog');
    assert.strictEqual(agg.surfaceState, 'stale', '主徽章 stale 优先（04 §12.2）');
    assert.ok(agg.gaps.some(g => g.code === 'insufficient_freshness'), 'stale gap');
    assert.ok(agg.gaps.some(g => g.code === 'partial_scan'), 'partial gap 同存不互吞');
  });

  await t('D8c 过期 running → interrupted gap；绝不显示为 empty/尚未采集', async () => {
    const comp = readState(TID_A, 'projA').competitors[0];
    // 造一个 40 分钟前启动的 running attempt（无活跃 job）
    const mk = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'd8c-expired-running', nowMs: NOW - 40 * 60 * 1000 });
    assert.strictEqual(mk.deduped, false);
    const ov = Surface.buildOverview({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', comp, nowMs: NOW });
    const agg = ov.dimensions.find(d => d.code === 'website_products').aggregations.find(a => a.capability.code === 'shopify_catalog');
    assert.notStrictEqual(agg.surfaceState, 'empty', '过期 running 不是「尚未采集」');
    assert.ok(agg.gaps.some(g => g.code === 'interrupted'), 'interrupted gap 明确');
    assert.strictEqual(agg.isRefreshing, false, '过期 running 不算 refreshing');
    // reconcile：弃管 attempt → failed/internal_error（落账，不再是 running）
    const rec = CollectJobs.reconcileAbandoned(NOW);
    assert.ok(rec.reconciled >= 1, '弃管 attempt 被 reconcile');
    const att = SurfaceStore.getAttempt(TID_A, mk.attempt.attemptId);
    assert.strictEqual(att.status, 'failed');
    assert.strictEqual(att.sourceStatus, 'internal_error');
  });

  // ---------- D9 未接入维度零构造 ----------
  await t('D9 social_content/ad/review/search 明细零 Shopify 数据；unsupported Registry 驱动', async () => {
    const comp = readState(TID_A, 'projA').competitors[0];
    for (const dim of ['social_content', 'ad_campaigns', 'reviews_reputation', 'search_interest']) {
      const det = Surface.buildDimensionDetail({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', dimension: dim, offset: 0, limit: 10, comp });
      assert.strictEqual(det.dimensionUnsupported, true, dim + ' 未接入');
      assert.strictEqual(det.surfaceState, 'unsupported');
      assert.strictEqual(det.observations.length, 0, dim + ' 零观察');
      assert.strictEqual(det.summary, null, dim + ' 零摘要');
      const s = JSON.stringify(det);
      assert.strictEqual(s.includes('shopify_catalog'), false, dim + ' 不得引用 Shopify capability');
      assert.strictEqual(s.includes('P1'), false, dim + ' 不得出现商品');
      assert.strictEqual(s.includes('products.json'), false, dim + ' 不得出现抓取 URL');
      // 刷新未接入 capability → 400
      const ctxX = mkCtx(TID_A);
      ctxX._body = { competitorId: 'compA1', projectId: 'projA', capability: 'social_content' };
      await DataSurfaceH.refresh(ctxX, { method: 'POST' }, fakeRes(), new URL('http://x/api/data-surface/refresh'), '/api/data-surface/refresh');
      assert.strictEqual(ctxX.status, 400);
      assert.strictEqual(ctxX.body.error, 'CAPABILITY_NOT_SUPPORTED');
    }
  });

  // ---------- D10 同维度双 capability 聚合 ----------
  await t('D10 同维度双 capability 同时聚合（catalog + collections；判别联合摘要各循其类）', async () => {
    const comp = readState(TID_A, 'projA').competitors[0];
    const stC = stubCollections(async () => okCollectionsResult(TID_A, 'https://compa1.example.com/collections.json'));
    try {
      const r = await Adapters.getAdapter('shopify_collections').collect({ tenantId: TID_A, projectId: 'projA', competitor: comp, trigger: 'manual', idempotencyKey: 'd10-cols' });
      assert.strictEqual(r.attempt.status, 'success');
      assert.strictEqual(r.summary.kind, 'storefront_collections');
      assert.strictEqual(r.summary.collectionCount, 2);
      const ev = EvidenceStore.getEvidenceById(TID_A, r.attempt.evidenceIds[0]);
      assert.ok(ev, 'collections Evidence 落账');
      assert.strictEqual(ev.extracted_value.collectionCount, 2);
      assert.strictEqual(ev.currency, null, 'collections 无币种字段');
    } finally { stC.restore(); }
    const ov = Surface.buildOverview({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', comp, nowMs: NOW + 3600e3 });
    const wp = ov.dimensions.find(d => d.code === 'website_products');
    assert.strictEqual(wp.aggregations.length, 2, '双能力聚合块');
    const codes = wp.aggregations.map(a => a.capability.code).sort();
    assert.deepStrictEqual(codes, ['shopify_catalog', 'shopify_collections']);
    const catAgg = wp.aggregations.find(a => a.capability.code === 'shopify_catalog');
    const colAgg = wp.aggregations.find(a => a.capability.code === 'shopify_collections');
    assert.strictEqual(catAgg.summary.kind, 'storefront_catalog');
    assert.strictEqual(colAgg.summary.kind, 'storefront_collections');
    assert.notStrictEqual(catAgg.summary.kind, colAgg.summary.kind, '摘要不共用固定模板');
    // 明细维度返回双 capability 视图
    const det = Surface.buildDimensionDetail({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', dimension: 'website_products', offset: 0, limit: 10, comp });
    assert.strictEqual(det.capabilities.length, 2);
    assert.ok(det.capabilities.every(c => c.capabilityCode), '明细按 capability 维度组织');
  });

  // ---------- D11 同平台多账号 identity ----------
  await t('D11 同平台多账号 identity 共存（account_key 唯一键 + 非破坏性迁移语义）', async () => {
    const r1 = SurfaceStore.upsertIdentity({ tenantId: TID_A, projectId: 'projF', competitorId: 'compF1', platform: 'shopify', platformAccountId: 'compa1.example.com', officialDomain: 'compa1.example.com', identityStatus: 'unresolved', resolverVersion: 'shopify-adapter-1' });
    assert.strictEqual(r1.existed, false);
    // 同平台、不同账号（地区账号/主页/广告主体）：第二行必须共存
    const r2 = SurfaceStore.upsertIdentity({ tenantId: TID_A, projectId: 'projF', competitorId: 'compF1', platform: 'shopify', platformAccountId: 'compa1.example.com#eu', officialDomain: 'compa1.example.com', identityStatus: 'unresolved', resolverVersion: 'shopify-adapter-1' });
    assert.strictEqual(r2.existed, false, '不同 account_key → 新行');
    const rows = SurfaceStore.listIdentities(TID_A, 'projF', 'compF1');
    assert.strictEqual(rows.length, 2, '同平台两账号共存');
    assert.notStrictEqual(rows[0].platformAccountId, rows[1].platformAccountId);
    // 同 account_key 再 upsert → 覆盖同一行（幂等）
    const r3 = SurfaceStore.upsertIdentity({ tenantId: TID_A, projectId: 'projF', competitorId: 'compF1', platform: 'shopify', platformAccountId: 'compa1.example.com', officialDomain: 'compa1.example.com', identityStatus: 'unresolved', resolverVersion: 'shopify-adapter-2' });
    assert.strictEqual(r3.existed, true, '同 account_key → 覆盖');
    assert.strictEqual(SurfaceStore.listIdentities(TID_A, 'projF', 'compF1').length, 2, '仍为两行');
    const exact = SurfaceStore.getIdentity(TID_A, 'projF', 'compF1', 'shopify', 'compa1.example.com#eu');
    assert.ok(exact && exact.platformAccountId === 'compa1.example.com#eu', '按 account_key 精确定位');
    // schema v2 落盘
    const ver = SurfaceStore.getDb().prepare('PRAGMA user_version').get().user_version;
    assert.strictEqual(Number(ver), 2, 'schema v2（account_key 唯一键）');
  });

  // ---------- D12 timeout 分类 ----------
  await t('D12 timeout 独立分类：abort/超时不得归 unavailable', async () => {
    const compG = readState(TID_A, 'projG').competitors[0];
    // 形态一：错误消息 abort
    const stA = stubFetch(async () => ({ ok: false, error: 'The operation was aborted due to timeout' }));
    try {
      const r = await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projG', competitor: compG, trigger: 'manual', idempotencyKey: 'd12-abort' });
      assert.strictEqual(r.attempt.sourceStatus, 'timeout', 'abort → timeout');
      assert.ok(/超时/.test(r.attempt.errorUserText), '用户文案为超时');
    } finally { stA.restore(); }
    // 形态二：失败快照自身 source_status = timeout（反查优先）
    const snap = mkSnapshot(TID_A, 'https://compg1.example.com/products.json', '{}', { sourceStatus: 'timeout' });
    const stB = stubFetch(async () => ({ ok: false, snapshotId: snap.snapshot_id, error: 'boom' }));
    try {
      const r = await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projG', competitor: compG, trigger: 'manual', idempotencyKey: 'd12-snap' });
      assert.strictEqual(r.attempt.sourceStatus, 'timeout', '快照反查 timeouts → timeout');
    } finally { stB.restore(); }
    // 对照：5xx 仍归 unavailable（不吃掉原有分类）
    const st5 = stubFetch(async () => ({ ok: false, status: 503 }));
    try {
      const r = await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projG', competitor: compG, trigger: 'manual', idempotencyKey: 'd12-5xx' });
      assert.strictEqual(r.attempt.sourceStatus, 'unavailable');
    } finally { st5.restore(); }
  });

  // ---------- D13 持久任务恢复 ----------
  await t('D13 持久任务：claim/heartbeat/finish；租约过期 reclaim 断点续跑；retry 耗尽 dead；reconcile 兜底', async () => {
    // 测试隔离：清掉队列，保证 claim 顺序确定
    CollectJobs.getDb().prepare('DELETE FROM collection_jobs WHERE tenant_id IN (?,?)').run(TID_A, TID_B);
    // 入队一个 projA 的 collections job（executor 注入替身，控制时序）
    const comp = readState(TID_A, 'projA').competitors[0];
    const mkAtt = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_collections', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'd13-att' });
    assert.strictEqual(mkAtt.deduped, false);
    const enq = CollectJobs.enqueue({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_collections', attemptId: mkAtt.attempt.attemptId, trigger: 'manual' });
    assert.strictEqual(enq.deduped, false);
    // 同 scope 再入队 → deduped（不双任务）
    assert.strictEqual(CollectJobs.enqueue({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_collections', attemptId: 'att_x', trigger: 'manual' }).deduped, true);
    let executeCount = 0;
    CollectJobs.setExecutorForTest(async (job) => {
      executeCount++;
      if (job.retry === 0 && executeCount === 1) throw new Error('simulated worker crash before finish'); // 第一次执行后「进程崩溃」
      return { attempt: { status: 'success' } };
    });
    try {
      // 正常 tick：claim → 执行（抛错模拟崩溃）→ error 终态 + attempt 落 failed
      const t1 = await CollectJobs.tick({ workerId: 'w-d13' });
      assert.strictEqual(t1.claimed, true);
      assert.strictEqual(t1.status, 'error');
      assert.strictEqual(executeCount, 1);
      const attAfter = SurfaceStore.getAttempt(TID_A, mkAtt.attempt.attemptId);
      assert.strictEqual(attAfter.status, 'failed', 'executor 失败 → attempt 立即落 failed（不留僵尸 running）');
    } finally { CollectJobs.setExecutorForTest(null); }
    // 租约过期 reclaim（模拟 kill -9：finish 未执行，job 留 running 且租约过期）→ 断点续跑
    CollectJobs.getDb().prepare(`UPDATE collection_jobs SET status='running', claim_token='ct_expired', claim_expires_at=?, heartbeat_at=?, retry=0, last_error=NULL WHERE job_id=?`)
      .run(Date.now() - 1000, Date.now() - 1000, enq.jobId);
    const rec = CollectJobs.reclaimExpired(Date.now());
    assert.ok(rec.requeued >= 1, '过期 running job 被 reclaim 回 pending（断点续跑）');
    const job = CollectJobs.list(TID_A, 'projA', null).find(j => j.jobId === enq.jobId);
    assert.strictEqual(job.status, 'pending', 'reclaim 后 pending');
    assert.strictEqual(job.retry, 1, 'retry 递增');
    // reclaim 后再执行：成功路径 → done
    CollectJobs.setExecutorForTest(async () => ({ attempt: { status: 'success' } }));
    try {
      const t2 = await CollectJobs.tick({ workerId: 'w-d13b' });
      assert.strictEqual(t2.claimed, true);
      assert.strictEqual(t2.status, 'done', 'reclaim 后重新执行 → done');
    } finally { CollectJobs.setExecutorForTest(null); }
    // retry 耗尽 → dead（maxRetry=3 上限护栏）
    CollectJobs.getDb().prepare(`UPDATE collection_jobs SET status='running', claim_token='ct_dead', claim_expires_at=?, retry=99 WHERE job_id=?`)
      .run(Date.now() - 1000, enq.jobId);
    const rec2 = CollectJobs.reclaimExpired(Date.now());
    const jobFinal = CollectJobs.list(TID_A, 'projA', null).find(j => j.jobId === enq.jobId);
    assert.strictEqual(jobFinal.status, 'dead', 'retry 耗尽 → dead');
    CollectJobs.finish(enq.jobId, 'ct_dead', 'dead', 'cleanup');
  });

  // ---------- D14 refresh handler 真实路径 + admin 鉴权 ----------
  await t('D14 refresh handler：202 入队 + worker tick 消费至终态；admin 401/403', async () => {
    const st = stubFetch(async () => okFetchResult(TID_A, 'https://compa1.example.com/products.json'));
    try {
      const ctx = mkCtx(TID_A);
      ctx._body = { competitorId: 'compA1', projectId: 'projA', capability: 'shopify_collections' };
      const stC = stubCollections(async () => ({ ok: true, collections: [{ title: 'N', handle: 'n' }], url: 'https://compa1.example.com/collections.json' }));
      await DataSurfaceH.refresh(ctx, { method: 'POST' }, fakeRes(), new URL('http://x/api/data-surface/refresh'), '/api/data-surface/refresh');
      // collections 刚采集过（D10）→ cooldown deduped
      assert.ok(ctx.status === 200 || ctx.status === 202, 'deduped(200) 或受理(202)，实际 ' + ctx.status);
      if (ctx.status === 200) {
        assert.strictEqual(ctx.body.deduped, true);
        assert.ok(ctx.body.reason === 'cooldown' || ctx.body.reason === 'in_progress_or_recent');
      } else {
        assert.ok(ctx.body.jobId, '202 带 jobId（持久任务）');
        const tick = await CollectJobs.tick({ workerId: 'w-d14' });
        assert.ok(tick.claimed, 'worker 消费到任务');
      }
      stC.restore();
    } finally { st.restore(); }
    // admin：无身份 → 401；租户 → 403；admin → 200（handler 级；真实 HTTP 见 http-auth-check）
    const ctxNo = mkCtx(null);
    await DataSurfaceH.adminCapabilities(ctxNo, { method: 'GET' }, fakeRes(), new URL('http://x/api/admin/data-surface/capabilities'), '/api/admin/data-surface/capabilities');
    assert.strictEqual(ctxNo.status, 401, '未认证 → 401');
    const ctxT = mkCtx(TID_A);
    await DataSurfaceH.adminCapabilities(ctxT, { method: 'GET' }, fakeRes(), new URL('http://x/api/admin/data-surface/capabilities'), '/api/admin/data-surface/capabilities');
    assert.strictEqual(ctxT.status, 403, '普通租户 → 403');
    const ctxAdm = mkCtx(null, 'admin');
    await DataSurfaceH.adminCapabilities(ctxAdm, { method: 'GET' }, fakeRes(), new URL('http://x/api/admin/data-surface/capabilities'), '/api/admin/data-surface/capabilities');
    assert.strictEqual(ctxAdm.status, 200);
    assert.ok(ctxAdm.body.integrity.ok);
    assert.ok(ctxAdm.body.adapterContracts.ok, 'adapter contract 自检通过');
    assert.ok(ctxAdm.body.capabilities.length >= 6);
    assert.ok(ctxAdm.body.adapters.some(a => a.code === 'shopify_collections'));
    // 用户响应零内部字段泄漏
    const s = JSON.stringify(Surface.buildOverview({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', comp: readState(TID_A, 'projA').competitors[0] }));
    assert.strictEqual(s.includes('shopify_products_json'), false, '用户响应不含内部 provider 名');
    assert.strictEqual(s.includes('raw_payload_ref'), false, '用户响应不含服务器路径');
  });

  // ---------- D15 前端源码断言 ----------
  await t('D15 前端源码：币种待确认 / 刷新中旧数据 / 最新失败提示 / 竞态序号 / 时区 / 多 Evidence', async () => {
    const dir = path.join(__dirname, '..', '..', 'web', 'src', 'components', 'data-surface');
    const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
    const card = read('dimension-card.tsx');
    const overview = read('data-surface-overview.tsx');
    const types = read('types.ts');
    const obs = read('observation-list.tsx');
    const drawer = read('evidence-drawer.tsx');
    // 币种待确认（无可靠币种不得只显示数字区间）
    assert.ok(card.includes('币种待确认'), '维度卡片：币种待确认文案');
    assert.ok(obs.includes('币种待确认') || card.includes('币种待确认'), '明细：币种待确认');
    // currencyStatus / currency 贯通
    assert.ok(types.includes('currencyStatus'), 'TS 类型含 currencyStatus');
    assert.ok(types.includes('currency'), 'TS 类型含 currency');
    // 刷新中旧数据 + 最新失败提示
    assert.ok(overview.includes('isRefreshing') || card.includes('isRefreshing'), '刷新中状态贯通');
    assert.ok(card.includes('latest_failure') || overview.includes('最近更新失败'), '最新失败提示');
    // 竞态消除：AbortController 或请求序号
    assert.ok(/AbortController|seqRef|requestSeq|seq\b/.test(overview), '总览含 AbortController/请求序号');
    assert.ok(/AbortController|seqRef|requestSeq|offset/.test(obs), '明细含竞态或分页保护');
    // 证据抽屉多 Evidence
    assert.ok(/refs.map|refs\.find|selected|list/.test(drawer), '抽屉支持多条 Evidence');
    // 时区：本地时区格式化
    assert.ok(/toLocaleString|toLocaleTimeString|本地时区/.test(card + overview + obs + drawer), '时间按用户本地时区');
    // 判别联合摘要
    assert.ok(types.includes('kind'), 'TS 类型含判别联合 kind');
  });

  // ---------- D16 validator 静默接受禁止（normalize 输出结构硬校验） ----------
  await t('D16 Adapter 输出 validator：维度不匹配/缺字段/引用不完整一律显式失败', async () => {
    const comp = readState(TID_A, 'projA').competitors[0];
    const good = Adapters.getAdapter('shopify').normalize(okFetchResult(TID_A, 'https://compA1.example.com/products.json'), { competitor: comp });
    assert.strictEqual(Adapters.validateOutput(good, { capability: 'shopify_catalog' }).ok, true, '正规输出通过');
    // dimension 与 capability 不匹配
    const badDim = Object.assign({}, good, { dimension: 'ad_campaigns' });
    assert.strictEqual(Adapters.validateOutput(badDim, { capability: 'shopify_catalog' }).ok, false);
    // observations 非数组
    const badObs = Object.assign({}, good, { observations: 'nope' });
    assert.strictEqual(Adapters.validateOutput(badObs, { capability: 'shopify_catalog' }).ok, false);
    // evidence 引用了不在 snapshotIds 的快照
    const badRef = Object.assign({}, good, { evidenceSnapshotIds: good.evidenceSnapshotIds.concat(['snap_ghost']) });
    assert.strictEqual(Adapters.validateOutput(badRef, { capability: 'shopify_catalog' }).ok, false);
    // summary kind 白名单外
    const badKind = Object.assign({}, good, { summary: { kind: 'social_posts' } });
    assert.strictEqual(Adapters.validateOutput(badKind, { capability: 'shopify_catalog' }).ok, false);
    // identityStatus 第四值
    const badId = Object.assign({}, good, { identityStatus: 'candidate' });
    assert.strictEqual(Adapters.validateOutput(badId, { capability: 'shopify_catalog' }).ok, false, '00 §53 三值冻结');
  });

  // ---------- D18 SSRF：私网目标真实零请求（§一.5） ----------
  await t('D18 SSRF 零请求：localhost/127.0.0.1/169.254.169.254/100.100.100.200 请求建立前即拒', async () => {
    const https = require('node:https');
    const http = require('node:http');
    const origH = https.request, origC = http.request;
    let hCount = 0, cCount = 0;
    https.request = function (...a) { hCount++; return origH.apply(this, a); };
    http.request = function (...a) { cCount++; return origC.apply(this, a); };
    try {
      for (const u of ['https://localhost/', 'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data/', 'https://100.100.100.200/latest/meta-data/']) {
        hCount = 0; cCount = 0;
        const r = await Net.fetchShopifyProducts(u, { trigger: 'manual', tenantId: TID_A });
        assert.strictEqual(r.ok, false, u + ' 必须失败');
        assert.strictEqual(hCount, 0, u + ' https 零请求（实际 ' + hCount + '）');
        assert.strictEqual(cCount, 0, u + ' http 零请求');
      }
      // cart.js 私网同样零请求（此前 cartProbe 在 assertPublicUrl 前启动——回归锁）
      hCount = 0;
      await Net.fetchShopifyProducts('https://127.0.0.1/x', { trigger: 'manual', tenantId: TID_A });
      assert.strictEqual(hCount, 0, 'cart.js 私网零请求');
      const cs = await Net.fetchShopifyCollections('https://169.254.169.254/', { tenantId: TID_A });
      assert.strictEqual(cs.ok, false, 'collections 私网拒绝');
    } finally { https.request = origH; http.request = origC; }
  });

  // ---------- D19 SSRF：公网 302 到私网 / 多跳中途入私网被拒（§一.5） ----------
  await t('D19 SSRF manual redirect：公网跳私网逐跳拒绝，绝不对私网发起真实请求', async () => {
    const https = require('node:https');
    const { EventEmitter } = require('events');
    const origH = https.request;
    let calls = 0;
    try {
      // 场景 1：公网第一跳 302 → 127.0.0.1（第二跳在 assertPublicUrl 拒绝，零连接）
      calls = 0;
      https.request = function (opts, cb) {
        calls++;
        const req = new EventEmitter();
        req.setTimeout = () => {}; req.destroy = () => {};
        req.end = () => {
          const res = new EventEmitter();
          res.statusCode = 302; res.headers = { location: 'http://127.0.0.1/evil' };
          process.nextTick(() => { cb(res); res.emit('end'); });
        };
        return req;
      };
      let err = null;
      try { await Net.safeRequest('https://allbirds.com/products.json?page=1', { timeoutMs: 3000 }); } catch (e) { err = e; }
      assert.ok(err && /SSRF_BLOCKED/.test(err.message), '公网→私网重定向被拒: ' + (err && err.message));
      assert.strictEqual(calls, 1, '只有第一跳发起（第二跳拒绝前零连接）');
      // 场景 2：多跳中途入私网（公网A → 公网B → 私网）：前两跳连接，第三跳拒绝
      let hop = 0;
      calls = 0;
      https.request = function (opts, cb) {
        calls++;
        const req = new EventEmitter();
        req.setTimeout = () => {}; req.destroy = () => {};
        req.end = () => {
          const res = new EventEmitter();
          if (hop === 0) { hop = 1; res.statusCode = 302; res.headers = { location: 'https://www.allbirds.com/next' }; }
          else { res.statusCode = 302; res.headers = { location: 'http://10.0.0.5/internal' }; }
          process.nextTick(() => { cb(res); res.emit('end'); });
        };
        return req;
      };
      err = null;
      try { await Net.safeRequest('https://allbirds.com/products.json', { timeoutMs: 3000 }); } catch (e) { err = e; }
      assert.ok(err && /SSRF_BLOCKED/.test(err.message), '多跳中途入私网被拒: ' + (err && err.message));
      assert.strictEqual(calls, 2, '两跳公网连接后拒绝（第三跳零连接）');
    } finally { https.request = origH; }
  });

  // ---------- D20 后续分页失败结构化 partial（§二） ----------
  await t('D20 后续分页失败全部 partial：HTTP500/解析失败/超时 + successfullyFetchedPages/failedPage', async () => {
    const https = require('node:https');
    const { EventEmitter } = require('events');
    const origH = https.request;
    const pageBody250 = (n) => JSON.stringify({ products: Array.from({ length: 250 }, (_v, i) => ({ id: String(n) + '_' + i, title: 'P' + i, product_type: 'x', variants: [{ price: String(10 + (i % 5)), available: true }] })) });
    const cartBody = JSON.stringify({ currency: 'USD' });
    const installStub = (page2Behavior) => {
      https.request = function (opts, cb) {
        const req = new EventEmitter();
        req.setTimeout = () => {}; req.destroy = () => {};
        req.end = () => {
          const p = String(opts.path || '');
          const res = new EventEmitter();
          let body = '{}', status = 200;
          if (/\/cart\.js/.test(p)) { body = cartBody; status = 200; }
          else if (/page=1/.test(p)) { body = pageBody250(1); status = 200; }
          else {
            if (page2Behavior.kind === 'timeout') { process.nextTick(() => req.emit('error', new Error('SAFE_FETCH_TIMEOUT'))); return; }
            status = page2Behavior.status || 500;
            body = page2Behavior.body || '{}';
          }
          res.statusCode = status; res.headers = { 'content-type': 'application/json' };
          process.nextTick(() => { cb(res); res.emit('data', Buffer.from(body)); res.emit('end'); });
        };
        return req;
      };
    };
    try {
      // DNS 抖动容忍：SSRF_BLOCKED:dns 是沙箱网络抖动，与 partial 语义无关，重试至多 3 次
      const fetchRetry = async () => {
        for (let n = 0; n < 3; n++) {
          const rr = await Net.fetchShopifyProducts('https://allbirds.com', { trigger: 'manual', tenantId: TID_A });
          if (!(rr.ok === false && /SSRF_BLOCKED/.test(String(rr.error || '')))) return rr;
          await new Promise(r2 => setTimeout(r2, 600));
        }
        return Net.fetchShopifyProducts('https://allbirds.com', { trigger: 'manual', tenantId: TID_A });
      };
      installStub({ kind: 'http', status: 500 });
      let r = await fetchRetry();
      assert.strictEqual(r.partialScan, true, '页2 HTTP500 → partial');
      assert.strictEqual(r.partialScanReason, 'products_json_page_2_http_500');
      assert.deepStrictEqual(r.successfullyFetchedPages, [1]);
      assert.deepStrictEqual(r.failedPage, { page: 2, reason: 'products_json_page_2_http_500' });
      installStub({ kind: 'http', status: 200, body: '<html>502</html>' });
      r = await fetchRetry();
      assert.strictEqual(r.partialScan, true, '页2 解析失败 → partial');
      assert.strictEqual(r.partialScanReason, 'products_json_page_2_parse_failed');
      installStub({ kind: 'timeout' });
      r = await fetchRetry();
      assert.strictEqual(r.partialScan, true, '页2 超时 → partial');
      assert.strictEqual(r.partialScanReason, 'products_json_page_2_timeout');
    } finally { https.request = origH; }
  });

  // ---------- D20b 「页1 250 成功 / 页2 500」端到端 → attempt 必须 partial（§二.5） ----------
  await t('D20b 第一页 250 成功第二页 500：attempt/summary/coverage/gap 一致 partial（禁 success）', async () => {
    const https = require('node:https');
    const { EventEmitter } = require('events');
    const origH = https.request;
    const pageBody250 = (n) => JSON.stringify({ products: Array.from({ length: 250 }, (_v, i) => ({ id: String(n) + '_' + i, title: 'P' + i, product_type: 'x', variants: [{ price: String(10 + (i % 5)), available: true }] })) });
    try {
      https.request = function (opts, cb) {
        const req = new EventEmitter();
        req.setTimeout = () => {}; req.destroy = () => {};
        req.end = () => {
          const p = String(opts.path || '');
          const res = new EventEmitter();
          let body = '{}', status = 200;
          if (/\/cart\.js/.test(p)) body = JSON.stringify({ currency: 'USD' });
          else if (/page=1/.test(p)) body = pageBody250(1);
          else status = 500;
          res.statusCode = status; res.headers = { 'content-type': 'application/json' };
          process.nextTick(() => { cb(res); res.emit('data', Buffer.from(body)); res.emit('end'); });
        };
        return req;
      };
      const comp = readState(TID_A, 'projI').competitors[0];
      // 用未被本进程高频查询的域名（请求全被 stub 拦截，DNS 仅过 assertPublicUrl 校验）
      comp.url = 'https://gymshark.com';
      let r = null;
      for (let attemptN = 0; attemptN < 3; attemptN++) {
        r = await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projI', competitor: comp, trigger: 'manual', idempotencyKey: 'd20b-partial-' + attemptN, nowMs: NOW });
        if (r.attempt.status !== 'failed' || r.attempt.sourceStatus !== 'blocked') break;
        await new Promise(r2 => setTimeout(r2, 800));
      }
      assert.strictEqual(r.attempt.status, 'partial', 'attempt = partial（不是 success）');
      assert.strictEqual(r.attempt.sourceStatus, 'partial');
      assert.strictEqual(r.summary.partialScan, true);
      assert.strictEqual(r.summary.partialScanReason, 'products_json_page_2_http_500');
      assert.strictEqual(r.summary.successfullyFetchedPages, 1);
      const ov = Surface.buildOverview({ tenantId: TID_A, projectId: 'projI', competitorId: 'compI1', comp, nowMs: NOW });
      const agg = ov.dimensions.find(d => d.code === 'website_products').aggregations.find(a => a.capability.code === 'shopify_catalog');
      assert.strictEqual(agg.summary.partialScan, true, '总览摘要一致 partial');
      assert.ok(agg.gaps.some(g => g.code === 'partial_scan' && /page_2_http_500/.test(g.text || '')), 'gap 带 partial reason');
      assert.ok(agg.evidenceRefs.length >= 1, 'partial 也有 Evidence（页1+币种快照）');
    } finally { https.request = origH; }
  });

  // ---------- D21 Collections 原始字节快照 + 截断 partial + source_url 带查询参数（§三） ----------
  await t('D21 Collections 快照=服务器原始字节（非重新序列化）；60 原始/50 预算 → partial', async () => {
    const comp = readState(TID_A, 'projA').competitors[0];
    const raw60 = JSON.stringify({ collections: Array.from({ length: 60 }, (_v, i) => ({ id: 1000 + i, title: 'C' + i, handle: 'c' + i })) });
    const meta = mkSnapshot(TID_A, 'https://compa1.example.com/collections.json?limit=250', raw60, { capability: 'storefront_collections', provider: 'shopify_collections_json', partialScan: true });
    const stC = stubCollections(async () => ({
      ok: true, collections: Array.from({ length: 50 }, (_v, i) => ({ title: 'C' + i, handle: 'c' + i })),
      url: 'https://compa1.example.com/collections.json', sourceUrl: 'https://compa1.example.com/collections.json?limit=250',
      snapshotId: meta.snapshot_id, _prov: { recorded: true, source_snapshot_id: meta.snapshot_id, observed_at: meta.observed_at },
      partialScan: true, partialScanReason: 'collections_store_cap_50_of_60', sourceObservedCount: 60, storedCount: 50, successfullyFetchedPages: 1, failedPage: null,
    }));
    try {
      const r = await Adapters.getAdapter('shopify_collections').collect({ tenantId: TID_A, projectId: 'projA', competitor: comp, trigger: 'manual', idempotencyKey: 'd21-raw' });
      assert.strictEqual(r.attempt.status, 'partial', '60 原始/50 预算 → partial（禁 success）');
      assert.strictEqual(r.summary.sourceObservedCount, 60);
      assert.strictEqual(r.summary.storedCount, 50);
      const raw = Snapshot.readRawPayload(Snapshot.getById(TID_A, r.attempt.snapshotIds[0]));
      assert.strictEqual(raw.toString('utf8'), raw60, '快照 raw === 服务器原始响应字节');
      assert.strictEqual(JSON.parse(raw.toString('utf8')).collections.length, 60, '原始快照含全部 60 条（截断只影响展示层）');
      const ev = EvidenceStore.getEvidenceById(TID_A, r.attempt.evidenceIds[0]);
      assert.ok(ev && ev.source_snapshot_ids.includes(r.attempt.snapshotIds[0]), 'Evidence 引用真实原始快照');
      const m = Snapshot.getById(TID_A, r.attempt.snapshotIds[0]);
      assert.strictEqual(m.source_url, 'https://compa1.example.com/collections.json?limit=250', 'source_url 含查询参数');
    } finally { stC.restore(); }
  });

  // ---------- D22 Evidence 落盘失败不能 success（§四：快照 meta 在、raw blob 缺） ----------
  await t('D22 Evidence 失败（raw blob 缺失）→ attempt failed、evidenceIds 空、identity 不 resolved、overview 失败', async () => {
    // 用无历史成功数据的隔离 scope（projH），保证 overview 主态=failed（无旧数据可展示）
    const comp = readState(TID_A, 'projH').competitors[0];
    const snaps = mkCatalogSnapshots(TID_A, 'https://comph1.example.com');
    const victim = Snapshot.getById(TID_A, snaps.p1.snapshot_id);
    const pathMod = require('path');
    const { DATA } = require('../core/paths.js');
    fs.unlinkSync(pathMod.join(DATA, victim.raw_payload_ref.path)); // meta 仍在、raw 缺
    const st = stubFetch(async () => ({
      ok: true,
      items: [{ id: 1, title: 'P1', repPrice: 10, soldOut: false, publishedAt: null }],
      total: 1, truncated: false, url: 'https://comph1.example.com/products.json',
      currency: 'USD', snapshotIds: snaps.snapshotIds.concat([snaps.cart.snapshot_id]), currencySnapshotId: snaps.cart.snapshot_id,
      _prov: { recorded: true, observed_at: snaps.p1.observed_at },
    }));
    try {
      const r = await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projH', competitor: comp, trigger: 'manual', idempotencyKey: 'd22-evfail' });
      // 经 validator（快照 raw 可解析校验）或 Evidence 落账两条路径之一失败，均如实标记
      assert.ok(r.evidenceFailed || r.invalid, 'Evidence/快照断链失败被如实标记');
      assert.strictEqual(r.attempt.status, 'failed', 'attempt 不得 success');
      assert.strictEqual(r.attempt.evidenceIds.length, 0, 'evidenceIds 空');
      assert.strictEqual(r.attempt.observations.length, 0, '不展示未核实数据');
      const ident = SurfaceStore.getIdentity(TID_A, 'projH', 'compH1', 'shopify');
      assert.notStrictEqual(ident && ident.identityStatus, 'resolved', 'identity 不得 resolved');
      const ov = Surface.buildOverview({ tenantId: TID_A, projectId: 'projH', competitorId: 'compH1', comp });
      const agg = ov.dimensions.find(d => d.code === 'website_products').aggregations.find(a => a.capability.code === 'shopify_catalog');
      assert.strictEqual(agg.surfaceState, 'failed', 'overview 明确失败');
      assert.strictEqual(agg.summary, null, '不展示该批数据为已核实结果');
    } finally { st.restore(); }
  });

  // ---------- D23 终态 attempt 恢复不重复访问来源（§五.1/§五.2） ----------
  await t('D23 attempt 已终态的 job 恢复：幂等完成、零外部请求、零重复 attempt', async () => {
    CollectJobs.getDb().prepare('DELETE FROM collection_jobs WHERE tenant_id=?').run(TID_A);
    const mk = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'd23-att', nowMs: NOW });
    SurfaceStore.completeAttempt(TID_A, mk.attempt.attemptId, { status: 'success', sourceStatus: 'success', observations: [], snapshotIds: [], evidenceIds: [], endedAt: new Date(NOW).toISOString() });
    const enq = CollectJobs.enqueue({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', attemptId: mk.attempt.attemptId, trigger: 'manual' });
    assert.strictEqual(enq.deduped, false);
    let executorCalls = 0;
    CollectJobs.setExecutorForTest(async () => { executorCalls++; return { attempt: { status: 'success' } }; });
    try {
      const t1 = await CollectJobs.tick({ workerId: 'w-d23' });
      assert.strictEqual(t1.claimed, true);
      assert.strictEqual(t1.status, 'done');
      assert.strictEqual(executorCalls, 0, 'attempt 终态 → executor 零调用（零外部请求）');
      assert.strictEqual(CollectJobs.list(TID_A, 'projA', null).length, 1, '不产生第二个 job');
      const atts = SurfaceStore.listAttempts(TID_A, 'projA', 'compA1', 'shopify_catalog', 50).filter(a => a.idempotencyKey === 'd23-att');
      assert.strictEqual(atts.length, 1, '不产生第二个 attempt');
    } finally { CollectJobs.setExecutorForTest(null); }
  });

  // ---------- D24 fencing：旧 worker 失租约不得写（§五.4） ----------
  await t('D24 fencing：错/过期 claimToken → collect 与 completeAttempt 双双拒绝写入', async () => {
    CollectJobs.getDb().prepare('DELETE FROM collection_jobs WHERE tenant_id=?').run(TID_A);
    // 用未 resolved 的隔离 scope（projG），避免「已有 resolved 不降级」连续性干扰断言
    await mkProject(TID_A, 'projH', 'compH1');
    const comp = readState(TID_A, 'projH').competitors[0];
    const mk = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projH', competitorId: 'compH1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'd24-att', nowMs: NOW });
    const st = stubFetch(async () => okFetchResult(TID_A, 'https://comph1.example.com/products.json'));
    try {
      const r = await Adapters.getAdapter('shopify').collect({
        tenantId: TID_A, projectId: 'projH', competitor: comp, trigger: 'manual', nowMs: NOW,
        attemptId: mk.attempt.attemptId, fence: { jobId: 'cj_nonexistent', token: 'ct_wrong' },
      });
      assert.strictEqual(r.fenced, true, '错 token → fenced');
      const att = SurfaceStore.getAttempt(TID_A, mk.attempt.attemptId);
      assert.strictEqual(att.status, 'running', '旧 worker 写不进终态');
      assert.strictEqual(att.evidenceIds.length, 0, '旧 worker 写不进 Evidence');
      const ident = SurfaceStore.getIdentity(TID_A, 'projH', 'compH1', 'shopify');
      assert.ok(ident, 'identity 行存在（unresolved）');
      assert.strictEqual(ident.identityStatus, 'unresolved', '旧 worker 不得升级 identity');
      let fenced = false;
      try {
        SurfaceStore.completeAttempt(TID_A, mk.attempt.attemptId, { status: 'success', sourceStatus: 'success', observations: [], snapshotIds: [], evidenceIds: [] }, { jobId: 'cj_nonexistent', token: 'ct_wrong' });
      } catch (e) { fenced = !!(e && e.fenced); }
      assert.ok(fenced, 'completeAttempt 坏 fence → FENCED 抛错');
      assert.strictEqual(SurfaceStore.getAttempt(TID_A, mk.attempt.attemptId).status, 'running', '写入被拒');
    } finally { st.restore(); }
  });

  // ---------- D25 崩溃窗口：来源调用前 + reclaim 重试不重复（§五.5 W1） ----------
  await t('D25 崩溃窗口：executor 来源调用前抛 → attempt failed 零外部残留；reclaim 重试单 attempt', async () => {
    CollectJobs.getDb().prepare('DELETE FROM collection_jobs WHERE tenant_id=?').run(TID_A);
    const mk = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'd25-att', nowMs: NOW });
    const enq = CollectJobs.enqueue({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', attemptId: mk.attempt.attemptId, trigger: 'manual' });
    let calls = 0;
    CollectJobs.setExecutorForTest(async () => { calls++; throw new Error('crash before source call'); });
    try {
      const t1 = await CollectJobs.tick({ workerId: 'w-d25' });
      assert.strictEqual(t1.status, 'error');
      const att = SurfaceStore.getAttempt(TID_A, mk.attempt.attemptId);
      assert.strictEqual(att.status, 'failed', '来源调用前崩溃 → attempt failed（不留僵尸 running）');
      assert.strictEqual(att.sourceStatus, 'internal_error');
      CollectJobs.getDb().prepare("UPDATE collection_jobs SET status='running', claim_token='ct_x', claim_expires_at=?, retry=0 WHERE job_id=?").run(Date.now() - 1000, enq.jobId);
      CollectJobs.setExecutorForTest(async () => { calls++; return { attempt: { status: 'success' } }; });
      const rec = CollectJobs.reclaimExpired(Date.now());
      assert.ok(rec.requeued >= 1);
      const t2 = await CollectJobs.tick({ workerId: 'w-d25b' });
      // attempt 已被前任落 failed（终态）→ reclaim 后幂等完成，不重复执行 executor（§五.1/§五.2）
      assert.strictEqual(t2.status, 'done');
      assert.strictEqual(calls, 1, 'attempt 终态 → 重试不再执行 executor（零重复外部调用）');
      const atts = SurfaceStore.listAttempts(TID_A, 'projA', 'compA1', 'shopify_catalog', 50).filter(a => a.idempotencyKey === 'd25-att');
      assert.strictEqual(atts.length, 1, '全程只有一个 attempt（无重复 attempt）');
      assert.strictEqual(atts[0].status, 'failed', ' W1 窗口：来源调用前崩溃 → failed 终态（不伪造 success）');
    } finally { CollectJobs.setExecutorForTest(null); }
  });

  // ---------- D26 validator 畸形输入不抛 TypeError（§七.1/§七.2） ----------
  await t('D26 validator：畸形输入全部 {ok:false, errors}，绝不抛 TypeError', async () => {
    const bads = [
      null, undefined, 'string', 42, true, [],
      { capability: 'shopify_catalog' },
      { capability: 'shopify_catalog', outcome: 'weird_status', observations: [], snapshotIds: [] },
      { capability: 'shopify_catalog', outcome: 'success', observations: 'not-array', snapshotIds: [] },
      { capability: 'shopify_catalog', outcome: 'success', observations: [], snapshotIds: 'not-array', evidenceSnapshotIds: 'x' },
      { capability: 'shopify_catalog', outcome: 'success', observations: [], snapshotIds: ['s1'], evidenceSnapshotIds: ['s1'], summary: [] },
      { capability: 'shopify_catalog', outcome: 'success', observations: [], snapshotIds: ['s1'], evidenceSnapshotIds: ['s1'], currency: 'USD', currencyStatus: 'unknown' },
      { capability: 'shopify_catalog', outcome: 'success', observations: [], snapshotIds: ['s1'], evidenceSnapshotIds: ['s1'], currency: null, currencyStatus: 'confirmed' },
      { capability: 'shopify_catalog', outcome: 'success', observations: [], snapshotIds: ['s1'], evidenceSnapshotIds: ['s1'], summary: { kind: 'storefront_catalog' } },
      { capability: 'nonexistent_cap', outcome: 'success', observations: [], snapshotIds: [] },
      { capability: 'shopify_catalog', outcome: 'success', observations: [], snapshotIds: ['snap_ghost_missing'], evidenceSnapshotIds: ['snap_ghost_missing'] },
    ];
    for (const [i, bad] of bads.entries()) {
      let threw = null, res = null;
      try { res = Adapters.validateOutput(bad, { capability: 'shopify_catalog', tenantId: TID_A }); }
      catch (e) { threw = e; }
      assert.strictEqual(threw, null, 'bad[' + i + '] 不得抛异常');
      assert.ok(res && typeof res.ok === 'boolean' && Array.isArray(res.errors), 'bad[' + i + '] 返回结构');
      assert.strictEqual(res.ok, false, 'bad[' + i + '] 必须 ok:false');
    }
    const comp = readState(TID_A, 'projA').competitors[0];
    const good = Adapters.getAdapter('shopify').normalize(okFetchResult(TID_A, 'https://compa1.example.com/products.json'), { competitor: comp });
    const g = Adapters.validateOutput(good, { capability: 'shopify_catalog', tenantId: TID_A });
    assert.strictEqual(g.ok, true, '正规输出通过: ' + g.errors.join(';'));
  });

  // ---------- D27 adapterStrategy：三策略链接解析 + worker fallback 真实切换（§七） ----------
  await t('D27 adapterStrategy：single/fallback/fanout 链接解析 + worker fallback 第二个 adapter 接管', async () => {
    const s1 = Adapters.resolveAdapterChain('shopify_catalog');
    assert.strictEqual(s1.ok, true); assert.strictEqual(s1.strategy, 'single'); assert.strictEqual(s1.chain.length, 1);
    const two = Adapters.resolveAdapterChain('shopify_catalog', { strategy: 'fallback', adapters: ['a1', 'a2'] });
    assert.deepStrictEqual(two.chain, ['a1', 'a2']);
    assert.deepStrictEqual(Adapters.resolveAdapterChain('shopify_catalog', { strategy: 'fanout', adapters: ['a1', 'a2'] }).chain, ['a1', 'a2']);
    assert.strictEqual(Adapters.resolveAdapterChain('shopify_catalog', { strategy: 'bogus' }).ok, false);
    CollectJobs.getDb().prepare('DELETE FROM collection_jobs WHERE tenant_id=?').run(TID_A);
    const mk = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'd27-att', nowMs: NOW });
    CollectJobs.enqueue({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', attemptId: mk.attempt.attemptId, trigger: 'manual' });
    const origResolve = Adapters.resolveAdapterChain;
    const origGet = Adapters.getAdapter;
    const order = [];
    Adapters.resolveAdapterChain = () => ({ ok: true, reason: null, strategy: 'fallback', chain: ['fake_a', 'fake_b'] });
    Adapters.getAdapter = (code) => {
      if (code === 'fake_a') return { code, supports: () => ({ supported: true }), resolveIdentity: () => ({}), collect: async () => { order.push('fake_a'); throw new Error('fake_a boom'); }, health: () => ({ ok: true }) };
      if (code === 'fake_b') return {
        code, supports: () => ({ supported: true }), resolveIdentity: () => ({}),
        collect: async (ctx) => {
          order.push('fake_b');
          SurfaceStore.completeAttempt(ctx.tenantId, ctx.attemptId, { status: 'success', sourceStatus: 'success', observations: [], snapshotIds: [], evidenceIds: [], summary: { kind: 'storefront_catalog', count: 0, onSaleCount: 0, soldOutCount: 0, priceMin: null, priceMax: null, priceMedian: null, currency: null, currencyStatus: 'unknown', partialScan: false, partialScanReason: null, successfullyFetchedPages: null, failedPage: null } }, ctx.fence);
          return { attempt: SurfaceStore.getAttempt(ctx.tenantId, ctx.attemptId) };
        }, health: () => ({ ok: true }),
      };
      return origGet(code);
    };
    try {
      const t1 = await CollectJobs.tick({ workerId: 'w-d27' });
      assert.deepStrictEqual(order, ['fake_a', 'fake_b'], 'fallback：第一个失败后第二个参与');
      assert.strictEqual(t1.status, 'done', '第二个 adapter 成功后 job done');
      assert.strictEqual(SurfaceStore.getAttempt(TID_A, mk.attempt.attemptId).status, 'success');
    } finally { Adapters.resolveAdapterChain = origResolve; Adapters.getAdapter = origGet; }
  });

  // ---------- D28 多 capability 分页不超 limit（§八） ----------
  await t('D28 分页契约：每 capability 独立分页，顶层 observations ≤ limit（禁 offset×N 拼接）', async () => {
    const comp = readState(TID_A, 'projA').competitors[0];
    const det = Surface.buildDimensionDetail({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', dimension: 'website_products', offset: 0, limit: 20, comp });
    assert.ok(Array.isArray(det.capabilities) && det.capabilities.length >= 1);
    for (const c of det.capabilities) {
      assert.ok(c.observations.length <= 20, c.capabilityCode + ' observations ≤ limit');
      assert.strictEqual(c.pagination.limit, 20, c.capabilityCode + ' 独立 limit');
      assert.strictEqual(typeof c.pagination.hasMore, 'boolean', c.capabilityCode + ' 独立 hasMore');
    }
    assert.ok(det.observations.length <= 20, '顶层 observations ≤ limit（实际 ' + det.observations.length + '）');
    assert.ok(det.activeCapability, '顶层带 activeCapability');
    const active = det.capabilities.find(c => c.capabilityCode === det.activeCapability);
    assert.ok(active && active.observations.length === det.observations.length, '顶层 observations = active capability 当前页');
  });

  // ---------- D29 前端：EvidenceDrawer 稳定 key / 多 snapshot-only（§八.4/§八.5） ----------
  await t('D29 前端源码：证据抽屉稳定 active key（evidenceId||snapshotId）+ refs 重置 + 取消旧请求', async () => {
    const dir = path.join(__dirname, '..', '..', 'web', 'src', 'components', 'data-surface');
    const drawer = fs.readFileSync(path.join(dir, 'evidence-drawer.tsx'), 'utf8');
    assert.ok(/evidenceId \|\| snapshotId/.test(drawer), 'active key = evidenceId || snapshotId');
    assert.ok(/refKey/.test(drawer) && /setActiveKey/.test(drawer), '稳定 key 函数与切换');
    assert.ok(/ctrl\.abort\(\)/.test(drawer), '旧请求取消（AbortController）');
    assert.ok(/setDetail\(null\)/.test(drawer), 'refs 改变清理旧 detail');
    assert.ok(/来源快照/.test(drawer) && /证据 /.test(drawer), '多 snapshot-only 标签可分别选择');
    const obs = fs.readFileSync(path.join(dir, 'observation-list.tsx'), 'utf8');
    assert.ok(/activeCapability/.test(obs), '明细按 activeCapability 渲染（≤ limit）');
  });

  // ---------- D17 重启恢复（存储层） ----------
  await t('D17 服务重启恢复：SQLite 重开后 attempt/identity/observations/jobs 完整', async () => {
    SurfaceStore.closeDb();
    const rows = SurfaceStore.listAttempts(TID_A, 'projA', 'compA1', 'shopify_catalog', 20);
    assert.ok(rows.some(a => a.status === 'success' || a.status === 'partial'), '重启后终态 attempt 可读');
    assert.ok(SurfaceStore.getIdentity(TID_A, 'projA', 'compA1', 'shopify'), '重启后身份可读');
    assert.ok(CollectJobs.list(TID_A, 'projA', null).length >= 1, '重启后任务队列可读');
    assert.strictEqual(SurfaceStore.listIdentities(TID_A, 'projF', 'compF1').length, 2, '重启后多账号身份完整（v2 迁移生效）');
  });

  // ============================================================
  // 复审整改轮 3（R3）：SSRF / fallback 终态 / fencing / raw 快照真值链
  // ============================================================

  // ---------- D30 SSRF：safeLookup 单 IP / 公网可达 / rebinding / 重定向私网零连接 ----------
  await t('D30 SSRF：safeLookup 单 IP+family；mock DNS 公网可达；fetchPage 连接阶段 rebinding 拒绝；302/多跳重定向进私网零连接', async () => {
    const dnsMod = require('dns');
    const nodeHttps = require('https');
    const FetchGate = require('../services/fetch-gate.js');
    const origLookup = dnsMod.lookup;
    const origPLookup = dnsMod.promises.lookup;
    const origReq = nodeHttps.request;
    const origRobots = FetchGate.robotsAllows;
    const PUB = { address: '93.184.216.34', family: 4 };
    const PRIV = { address: '10.9.9.9', family: 4 };
    let httpsCalls = 0; let responses = 0; // responses = 真实收到服务端响应的次数
    const mockDns = (map) => {
      dnsMod.promises.lookup = async (h, o) => { const r = map(h); if (!r) throw new Error('nxdomain'); return [r]; };
      dnsMod.lookup = function (h, o, cb) { if (typeof o === 'function') { cb = o; o = {}; } const r = map(h); if (!r) return cb(new Error('nxdomain')); if (o.all) return cb(null, [r]); cb(null, r.address, r.family); };
    };
    const mockHttps = (fn) => { nodeHttps.request = function (opts, cb) { httpsCalls++; return fn(opts, cb); }; };
    FetchGate.robotsAllows = async () => true;
    FetchGate.resetForTest();
    try {
      // a) safeLookup 回调交出【单个 IP + family】，不是数组（§1 最小复现修复）
      mockDns(() => PUB);
      await new Promise((res) => {
        Net.safeLookup('pub.example.com', {}, (err, addr, family) => {
          assert.strictEqual(err, null, 'safeLookup 无错');
          assert.strictEqual(typeof addr, 'string', 'addr 是单值字符串，非数组');
          assert.ok(!Array.isArray(addr), '不是数组');
          assert.strictEqual(family, 4, 'family 正确');
          res();
        });
      });
      // b) mock DNS 公网域名完成请求（正常路径）
      httpsCalls = 0; responses = 0;
      mockDns(() => PUB);
      mockHttps((opts, cb) => {
        const { EventEmitter } = require('events');
        const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
        req.end = () => { const r = new EventEmitter(); r.statusCode = 200; r.headers = { 'content-type': 'application/json' }; process.nextTick(() => { responses++; cb(r); r.emit('data', Buffer.from('{"ok":true}')); r.emit('end'); }); };
        return req;
      });
      const okRes = await Net.safeRequest('https://pub.example.com/api', { timeoutMs: 3000 });
      assert.strictEqual(okRes.status, 200, '公网 mock 请求完成');
      assert.strictEqual(JSON.parse(okRes.buffer.toString('utf8')).ok, true);
      assert.strictEqual(responses, 1);
      // c) 连接阶段 rebinding：assertPublicUrl（promises DNS）公网 → safeLookup（连接层）私网
      httpsCalls = 0; responses = 0;
      mockDns(() => PUB);
      dnsMod.lookup = function (h, o, cb) { if (typeof o === 'function') { cb = o; o = {}; } cb(null, PRIV.address, PRIV.family); }; // 仅连接层私有
      nodeHttps.request = function (opts, cb) { httpsCalls++; return origReq.apply(this, arguments); }; // 真实 https（无服务可连）
      let rebindErr = null;
      try { await Net.safeRequestOnce('https://pub.example.com/x', { timeoutMs: 2000 }); } catch (e) { rebindErr = e; }
      assert.ok(rebindErr && /SSRF_BLOCKED:private_dns_connect/.test(String(rebindErr.message)), '连接阶段 lookup 拒绝私网（实际 ' + (rebindErr && rebindErr.message) + '）');
      assert.strictEqual(responses, 0, '零服务端响应（连接未建立）');
      // d) 302 重定向到私网：hop1 响应 302，hop2 前拒绝（零连接、零响应）
      httpsCalls = 0; responses = 0;
      mockDns((h) => (h === 'pub.example.com' ? PUB : (h === '127.0.0.1' ? { address: '127.0.0.1', family: 4 } : null)));
      mockHttps((opts, cb) => {
        const { EventEmitter } = require('events');
        const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
        req.end = () => { const r = new EventEmitter(); r.statusCode = 302; r.headers = { location: 'http://127.0.0.1/evil' }; process.nextTick(() => { responses++; cb(r); r.emit('end'); }); };
        return req;
      });
      let redirErr = null;
      try { await Net.safeRequest('https://pub.example.com/products.json', { timeoutMs: 3000 }); } catch (e) { redirErr = e; }
      assert.ok(redirErr && /SSRF_BLOCKED/.test(String(redirErr.message)), '重定向到私网被拒');
      assert.strictEqual(httpsCalls, 1, '只有 hop1 发起请求（实际 ' + httpsCalls + '）');
      assert.strictEqual(responses, 1, '只有 hop1 有响应');
      // e) 多跳中途入私网：hop1→hop2 公网 302，hop3 私网——前两跳后零连接
      httpsCalls = 0; responses = 0;
      mockDns((h) => (h === 'priv.example.com' ? PRIV : PUB));
      mockHttps((opts, cb) => {
        const { EventEmitter } = require('events');
        const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
        req.end = () => { const r = new EventEmitter(); const n = responses; r.statusCode = 302; r.headers = { location: n === 0 ? 'https://mid.example.com/2' : 'https://priv.example.com/3' }; process.nextTick(() => { responses++; cb(r); r.emit('end'); }); };
        return req;
      });
      let multiErr = null;
      try { await Net.safeRequest('https://pub.example.com/a', { timeoutMs: 5000 }); } catch (e) { multiErr = e; }
      assert.ok(multiErr && /SSRF_BLOCKED/.test(String(multiErr.message)), '多跳中途入私网被拒');
      assert.strictEqual(httpsCalls, 2, '仅前两跳发起请求（实际 ' + httpsCalls + '）');
      assert.strictEqual(responses, 2, '仅前两跳有响应');
      // f) fetchPage 连接阶段 rebinding：DNS promises 公网 / 连接层私网 → ok:false + SSRF 错误
      httpsCalls = 0; responses = 0;
      mockDns(() => PUB);
      dnsMod.lookup = function (h, o, cb) { if (typeof o === 'function') { cb = o; o = {}; } cb(null, PRIV.address, PRIV.family); }; // 仅连接层私有（rebinding 模拟）
      nodeHttps.request = function (opts, cb) { httpsCalls++; return origReq.apply(this, arguments); };
      const fp = await Net.fetchPage('https://pub.example.com/rebind-' + Date.now(), 5000, { tenantId: TID_A });
      assert.strictEqual(fp.ok, false, 'fetchPage rebinding 失败');
      assert.ok(/^SSRF_BLOCKED/.test(String(fp.error)), 'SSRF 错误透出（实际 ' + fp.error + '）');
      assert.strictEqual(responses, 0, '零响应');
      // g) fetchPage 公网正常路径（连接走受控 lookup）
      httpsCalls = 0; responses = 0;
      mockHttps((opts, cb) => {
        const { EventEmitter } = require('events');
        const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
        req.end = () => { const r = new EventEmitter(); r.statusCode = 200; r.headers = { 'content-type': 'text/html' }; process.nextTick(() => { responses++; cb(r); r.emit('data', Buffer.from('<html>hello world</html>')); r.emit('end'); }); };
        return req;
      });
      const fpOk = await Net.fetchPage('https://pub.example.com/page-ok-' + Date.now(), 5000, { tenantId: TID_A });
      assert.strictEqual(fpOk.ok, true, 'fetchPage 公网正常');
      assert.ok(fpOk.text.includes('hello world'));
    } finally {
      dnsMod.lookup = origLookup;
      dnsMod.promises.lookup = origPLookup;
      nodeHttps.request = origReq;
      FetchGate.robotsAllows = origRobots;
    }
  });

  // ---------- D31 fallback 终态语义：首失败不固化父 attempt；fanout 全链真执行 ----------
  await t('D31 fallback：首 adapter 抛异常/正常 failed 后第二个接管；全败唯一最终失败；fanout 全链真执行首个可用者胜出', async () => {
    const comp = readState(TID_A, 'projA').competitors[0];
    const mkFake = (code, behavior, identDomain) => ({
      code,
      supports: () => ({ supported: true }),
      resolveIdentity: () => ({ platform: 'shopify', platformAccountId: null, officialDomain: identDomain || 'compa1.example.com', resolverVersion: code + '-1' }),
      health: () => ({ ok: true }),
      collect: behavior,
    });
    const validOut = (sid) => ({
      capability: 'shopify_catalog', dimension: 'website_products', outcome: 'success',
      observations: [],
      summary: { kind: 'storefront_catalog', count: 1, onSaleCount: 1, soldOutCount: 0, priceMin: 10, priceMax: 10, priceMedian: 10, currency: null, currencyStatus: 'unknown', partialScan: false, partialScanReason: null, successfullyFetchedPages: [1], failedPage: null },
      snapshotIds: [sid], evidenceSnapshotIds: [sid],
      currency: null, currencySnapshotId: null, currencyStatus: 'unknown',
      identityStatus: 'unresolved',
      evidenceSource: 'shopify', evidenceProvider: 'fake_provider',
      claimField: 'catalog.observation', claimScope: 'public_catalog_observation',
      entityKey: 'compa1.example.com', entityRef: { kind: 'storefront_domain', domain: 'compa1.example.com' },
      extractedValue: { summaryKind: 'storefront_catalog', count: 1, onSaleCount: 1, soldOutCount: 0, priceMin: 10, priceMax: 10, priceMedian: 10, currency: null, partialScan: false },
      parserVersion: 'fake-adapter-1', note: 'D31 provider output', sourceUrl: 'https://compa1.example.com/products.json?limit=250&page=1',
    });
    const origResolve = Adapters.resolveAdapterChain;
    const origGet = Adapters.getAdapter;
    const withChain = async (strategy, adapters, fn) => {
      Adapters.resolveAdapterChain = () => ({ ok: true, reason: null, strategy, chain: adapters.map(a => a.code) });
      Adapters.getAdapter = (c) => (adapters.find(a => a.code === c)) || origGet(c);
      try { return await fn(); } finally { Adapters.resolveAdapterChain = origResolve; Adapters.getAdapter = origGet; }
    };
    const runJob = async (key) => {
      const mk = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: key, nowMs: NOW });
      CollectJobs.getDb().prepare('DELETE FROM collection_jobs WHERE tenant_id=? AND competitor_id=? AND capability=?').run(TID_A, 'compA1', 'shopify_catalog');
      CollectJobs.enqueue({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', attemptId: mk.attempt.attemptId, trigger: 'manual' });
      const job = CollectJobs.claim('w-d31');
      const r = await CollectJobs.executeJob(job);
      CollectJobs.finish(job.jobId, job.claimToken, 'done');
      return { mk, r };
    };

    // a) 第一个 adapter 抛异常 → 第二个成功接管（同一次刷新、同一 attempt）
    {
      const sid = mkSnapshot(TID_A, 'https://compa1.example.com/products.json?limit=250&page=1', pageBody([7])).snapshot_id;
      const a = mkFake('d31a', async () => { throw new Error('d31a boom'); });
      const b = mkFake('d31b', async (ctx) => ({ providerOk: true, ident: ctx ? null : null, raw: {}, out: validOut(sid) }));
      b.collect = async (ctx) => ({ providerOk: true, ident: b.resolveIdentity({}), raw: {}, out: validOut(sid) });
      const { mk, r } = await withChain('fallback', [a, b], () => runJob('d31-a1'));
      assert.strictEqual(r.attempt.status, 'success', '第二个 adapter 接管成功');
      assert.strictEqual(r.adapterCode, 'd31b');
      assert.strictEqual(r.attempt.attemptId, mk.attempt.attemptId, '同一父 attempt');
      assert.ok(SurfaceStore.listAttempts(TID_A, 'projA', 'compA1', 'shopify_catalog', 50).filter(x => x.idempotencyKey === 'd31-a1').length === 1, '单 attempt');
    }
    // b) 第一个 adapter 正常返回 failed（providerFailed，无终态写入）→ 第二个成功
    {
      const sid = mkSnapshot(TID_A, 'https://compa1.example.com/products.json?limit=250&page=1', pageBody([8])).snapshot_id;
      const a = mkFake('d31c', async () => ({ providerFailed: true, errorClass: 'unavailable' }));
      const b = mkFake('d31d', async () => ({ providerOk: true, ident: b.resolveIdentity({}), raw: {}, out: validOut(sid) }));
      const { r } = await withChain('fallback', [a, b], () => runJob('d31-b1'));
      assert.strictEqual(r.attempt.status, 'success', '正常 failed 后第二个接管');
      assert.strictEqual(r.adapterCode, 'd31d');
      assert.ok(r.providerResults.some(p => p.code === 'd31c' && p.failed), '首 provider 失败被记录');
      const ident = SurfaceStore.getIdentity(TID_A, 'projA', 'compA1', 'shopify');
      assert.strictEqual(ident && ident.identityStatus, 'resolved', '接管成功后 identity resolved');
    }
    // c) 全部失败 → 只产生一个可解释的最终失败（不抛出、终态唯一）
    {
      const a = mkFake('d31e', async () => ({ providerFailed: true, errorClass: 'rate_limited' }));
      const b = mkFake('d31f', async () => { throw new Error('d31f boom'); });
      const { r } = await withChain('fallback', [a, b], () => runJob('d31-c1'));
      assert.strictEqual(r.chainExhausted, true, '链耗尽标记');
      assert.strictEqual(r.attempt.status, 'failed', '唯一最终失败');
      assert.strictEqual(r.attempt.sourceStatus, 'rate_limited', '错误分类取首个失败');
      assert.ok(r.providerResults.filter(p => p.failed).length === 2, '两个 provider 都记录失败');
      assert.strictEqual(SurfaceStore.listAttempts(TID_A, 'projA', 'compA1', 'shopify_catalog', 50).filter(x => x.idempotencyKey === 'd31-c1').length, 1, '单 attempt');
    }
    // d) fanout：全链真实执行，首个可用者胜出，其余 discarded
    {
      const sid = mkSnapshot(TID_A, 'https://compa1.example.com/products.json?limit=250&page=1', pageBody([9])).snapshot_id;
      const order = [];
      const a = mkFake('d31g', async () => { order.push('g'); return { providerOk: true, ident: a.resolveIdentity({}), raw: {}, out: validOut(sid) }; });
      const b = mkFake('d31h', async () => { order.push('h'); return { providerOk: true, ident: b.resolveIdentity({}), raw: {}, out: validOut(sid) }; });
      const c = mkFake('d31i', async () => { order.push('i'); return { providerFailed: true, errorClass: 'timeout' }; });
      const { r } = await withChain('fanout', [a, b, c], () => runJob('d31-d1'));
      assert.deepStrictEqual(order, ['g', 'h', 'i'], 'fanout 全链真实执行（外部调用都发生）');
      assert.strictEqual(r.attempt.status, 'success');
      assert.strictEqual(r.adapterCode, 'd31g', '首个可用 provider 胜出');
      assert.ok(r.providerResults.some(p => p.code === 'd31h' && p.discarded), '后续可用 provider 记 discarded');
      assert.ok(r.providerResults.some(p => p.code === 'd31i' && p.failed), '失败 provider 记录');
      assert.strictEqual(SurfaceStore.listAttempts(TID_A, 'projA', 'compA1', 'shopify_catalog', 50).filter(x => x.idempotencyKey === 'd31-d1').length, 1, '单 attempt');
    }
  });

  // ---------- D32 fencing：失租 worker 零写入；resolved 升级门控；双 worker CAS ----------
  await t('D32 fencing：旧 worker 失租约写 failed 被拒；identity resolved 升级被拒；双 worker 竞争只有有效 fence 落库', async () => {
    // a) 失租/伪造 fence 写 failed → FENCED，attempt 保持 running
    const mk = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'd32-a', nowMs: NOW });
    const attId = mk.attempt.attemptId;
    CollectJobs.getDb().prepare('DELETE FROM collection_jobs WHERE tenant_id=? AND competitor_id=? AND capability=?').run(TID_A, 'compA1', 'shopify_catalog');
    const enq = CollectJobs.enqueue({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', attemptId: attId, trigger: 'manual' });
    const jobA = CollectJobs.claim('w-d32a'); // 有效 fence 持有者
    assert.ok(jobA && jobA.claimToken, 'jobA claim');
    // 模拟旧 worker：持有过期 token（租约已过期）
    let fenced = false;
    try {
      SurfaceStore.completeAttempt(TID_A, attId, { status: 'failed', sourceStatus: 'unavailable', observations: [], snapshotIds: [], evidenceIds: [] }, { jobId: jobA.jobId, token: 'ct_stale_token' });
    } catch (e) { fenced = !!(e && e.fenced); }
    assert.ok(fenced, '错 token → FENCED');
    assert.strictEqual(SurfaceStore.getAttempt(TID_A, attId).status, 'running', '旧 worker 写不进终态');
    // 租约过期场景：把租约时间改到过去，原 token 也失效
    CollectJobs.getDb().prepare('UPDATE collection_jobs SET claim_expires_at=? WHERE job_id=?').run(Date.now() - 1000, jobA.jobId);
    fenced = false;
    try {
      SurfaceStore.completeAttempt(TID_A, attId, { status: 'failed', sourceStatus: 'unavailable', observations: [], snapshotIds: [], evidenceIds: [] }, { jobId: jobA.jobId, token: jobA.claimToken });
    } catch (e) { fenced = !!(e && e.fenced); }
    assert.ok(fenced, '租约过期 → 原 token 也 FENCED');
    // b) identity resolved 升级 fence 门控：失租 worker 不得升级
    const identBefore = SurfaceStore.getIdentity(TID_A, 'projA', 'compA1', 'shopify');
    const wasResolved = identBefore && identBefore.identityStatus === 'resolved';
    fenced = false;
    try {
      SurfaceStore.upsertIdentity({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', platform: 'shopify', platformAccountId: null, officialDomain: 'compa1.example.com', identityStatus: 'resolved', evidenceIds: ['ev_x'], snapshotIds: ['ss_x'], resolverVersion: 'd32' }, { jobId: jobA.jobId, token: 'ct_stale_token' });
    } catch (e) { fenced = !!(e && e.fenced); }
    assert.ok(fenced, '失租 worker identity resolved 升级 → FENCED');
    // 有效 fence 可以升级（把租约续上）
    CollectJobs.getDb().prepare('UPDATE collection_jobs SET status=?, claim_token=?, claim_expires_at=? WHERE job_id=?').run('running', jobA.claimToken, Date.now() + 60000, jobA.jobId);
    SurfaceStore.upsertIdentity({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', platform: 'shopify', platformAccountId: null, officialDomain: 'compa1.example.com', identityStatus: 'resolved', evidenceIds: ['ev_ok'], snapshotIds: ['ss_ok'], resolverVersion: 'd32' }, { jobId: jobA.jobId, token: jobA.claimToken });
    assert.strictEqual(SurfaceStore.getIdentity(TID_A, 'projA', 'compA1', 'shopify').identityStatus, 'resolved', '有效 fence 升级成功');
    // c) 双 worker 竞争完成同一 attempt：无效 fence 拒绝（attempt 仍 running）→
    //    有效 fence 落库 → 终态后任何人（含 fence=null 直调）不得覆盖（CAS/immutable）
    CollectJobs.getDb().prepare('UPDATE collection_jobs SET status=?, claim_token=?, claim_expires_at=? WHERE job_id=?').run('running', jobA.claimToken, Date.now() + 60000, jobA.jobId);
    fenced = false;
    try {
      SurfaceStore.completeAttempt(TID_A, attId, { status: 'failed', sourceStatus: 'unavailable', observations: [], snapshotIds: [], evidenceIds: [] }, { jobId: jobA.jobId, token: 'ct_worker_b' });
    } catch (e) { fenced = !!(e && e.fenced); }
    assert.ok(fenced, 'worker B 错 token → FENCED（attempt 仍 running）');
    assert.strictEqual(SurfaceStore.getAttempt(TID_A, attId).status, 'running', 'B 未落库');
    const doneA = SurfaceStore.completeAttempt(TID_A, attId, { status: 'success', sourceStatus: 'success', observations: [], snapshotIds: [], evidenceIds: [] }, { jobId: jobA.jobId, token: jobA.claimToken });
    assert.strictEqual(doneA.status, 'success', '有效 fence 落库');
    let immutable = false;
    try {
      // worker B 即使持「看似有效」的构造（fence=null 直调）也不得覆盖终态（CAS/immutable）
      SurfaceStore.completeAttempt(TID_A, attId, { status: 'failed', sourceStatus: 'unavailable', observations: [], snapshotIds: [], evidenceIds: [] });
    } catch (e) { immutable = /already terminal|not running/.test(String(e && e.message)); }
    assert.ok(immutable, '终态不可变（直调也被拒）');
    void enq; void wasResolved;
  });

  // ---------- D33 raw 快照真值链：损坏 JSON 失败；source_url↔body↔hash 对应；聚合不伪装 ----------
  await t('D33 raw 快照：损坏 JSON → attempt failed/identity 不升级/无 success evidence；每页 source_url↔body↔hash 对应；无聚合伪装', async () => {
    const comp = readState(TID_A, 'projH').competitors[0]; // projH 无历史成功（D22 同款隔离 scope）
    const crypto = require('crypto');
    // a) 页快照 JSON 损坏：直接 mode collect → validator 拒绝 → failed/internal_error
    {
      const bad = mkSnapshot(TID_A, 'https://comph1.example.com/products.json?limit=250&page=1', 'not-json{', { note: 'corrupt' });
      const cart = mkSnapshot(TID_A, 'https://comph1.example.com/cart.js', JSON.stringify({ currency: 'USD' }), { capability: 'storefront_currency', provider: 'shopify_cart_js_json' });
      const st = stubFetch(async () => ({
        ok: true, items: [{ id: 1, title: 'P1', repPrice: 10, soldOut: false, publishedAt: null }], total: 1, truncated: false,
        url: 'https://comph1.example.com/products.json', currency: 'USD',
        snapshotIds: [bad.snapshot_id, cart.snapshot_id], currencySnapshotId: cart.snapshot_id,
        _prov: { recorded: true, observed_at: bad.observed_at },
        partialScan: false, partialScanReason: null, successfullyFetchedPages: [1], failedPage: null,
      }));
      try {
        const mkP = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projH', competitorId: 'compH1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'd33-a', nowMs: NOW });
        const r = await Adapters.getAdapter('shopify').collect({ tenantId: TID_A, projectId: 'projH', competitor: comp, trigger: 'manual', attemptId: mkP.attempt.attemptId, idempotencyKey: 'd33-a' });
        assert.strictEqual(r.attempt.status, 'failed', 'attempt 不得 success');
        assert.strictEqual(r.attempt.evidenceIds.length, 0, '无 success evidence');
        const ident = SurfaceStore.getIdentity(TID_A, 'projH', 'compH1', 'shopify');
        assert.notStrictEqual(ident && ident.identityStatus, 'resolved', 'identity 不因损坏快照升级');
        const ov = Surface.buildOverview({ tenantId: TID_A, projectId: 'projH', competitorId: 'compH1', comp });
        const agg = ov.dimensions.find(d => d.code === 'website_products').aggregations.find(a => a.capability.code === 'shopify_catalog');
        assert.strictEqual(agg.surfaceState, 'failed', 'overview 明确失败');
        assert.strictEqual(agg.summary, null, '不展示未核实数据');
      } finally { st.restore(); }
    }
    // b) 多页 source_url↔body↔hash 对应（net 层真实落盘路径）
    {
      const sid = mkSnapshot(TID_A, 'https://compa1.example.com/products.json?limit=250&page=1', pageBody([11, 12])).snapshot_id;
      const meta = Snapshot.getById(TID_A, sid);
      const raw = Snapshot.readRawPayload(meta);
      assert.ok(raw && raw.length > 0, 'raw 可读');
      assert.strictEqual(meta.raw_payload_ref.byte_size, raw.length, 'byte_size 与 raw 一致');
      assert.strictEqual(meta.content_hash, 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex'), 'content_hash=sha256(raw)（同一次请求字节）');
      assert.ok(/page=1$/.test(meta.source_url), 'source_url 与页对应');
      const body = JSON.parse(raw.toString('utf8'));
      assert.strictEqual(body.products.length, 2, 'body 与该页一致');
    }
    // c) attempt summary 与引用页快照一致 + 无聚合伪装（provider 路径端到端）
    {
      const p1 = mkSnapshot(TID_A, 'https://compa1.example.com/products.json?limit=250&page=1', pageBody([21, 22, 23]));
      const cart = mkSnapshot(TID_A, 'https://compa1.example.com/cart.js', JSON.stringify({ currency: 'USD' }), { capability: 'storefront_currency', provider: 'shopify_cart_js_json' });
      const mkP = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'd33-c', nowMs: NOW });
      CollectJobs.getDb().prepare('DELETE FROM collection_jobs WHERE tenant_id=? AND competitor_id=? AND capability=?').run(TID_A, 'compA1', 'shopify_catalog');
      CollectJobs.enqueue({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', capability: 'shopify_catalog', attemptId: mkP.attempt.attemptId, trigger: 'manual' });
      const job = CollectJobs.claim('w-d33');
      const origResolve = Adapters.resolveAdapterChain;
      const origGet = Adapters.getAdapter;
      Adapters.resolveAdapterChain = () => ({ ok: true, reason: null, strategy: 'single', chain: ['d33fake'] });
      Adapters.getAdapter = (c) => (c === 'd33fake' ? {
        code: 'd33fake', supports: () => ({ supported: true }), resolveIdentity: () => ({ platform: 'shopify', platformAccountId: null, officialDomain: 'compa1.example.com', resolverVersion: 'd33-1' }), health: () => ({ ok: true }),
        collect: async () => ({ providerOk: true, ident: { platform: 'shopify', platformAccountId: null, officialDomain: 'compa1.example.com', resolverVersion: 'd33-1' }, raw: {}, out: {
          capability: 'shopify_catalog', dimension: 'website_products', outcome: 'success', observations: [],
          summary: { kind: 'storefront_catalog', count: 3, onSaleCount: 3, soldOutCount: 0, priceMin: 210, priceMax: 230, priceMedian: 220, currency: 'USD', currencyStatus: 'confirmed', partialScan: false, partialScanReason: null, successfullyFetchedPages: [1], failedPage: null },
          snapshotIds: [p1.snapshot_id, cart.snapshot_id], evidenceSnapshotIds: [p1.snapshot_id, cart.snapshot_id],
          currency: 'USD', currencySnapshotId: cart.snapshot_id, currencyStatus: 'confirmed', identityStatus: 'unresolved',
          evidenceSource: 'shopify', evidenceProvider: 'd33fake', claimField: 'catalog.observation', claimScope: 'public_catalog_observation',
          entityKey: 'compa1.example.com', entityRef: { kind: 'storefront_domain', domain: 'compa1.example.com' },
          extractedValue: { summaryKind: 'storefront_catalog', count: 3, onSaleCount: 3, soldOutCount: 0, priceMin: 210, priceMax: 230, priceMedian: 220, currency: 'USD', partialScan: false },
          parserVersion: 'd33-1', note: 'D33 aggregate-from-pages', sourceUrl: 'https://compa1.example.com/products.json?limit=250&page=1',
        } }),
      } : origGet(c));
      try {
        const r = await CollectJobs.executeJob(job);
        CollectJobs.finish(job.jobId, job.claimToken, 'done');
        assert.strictEqual(r.attempt.status, 'success');
        // 聚合 summary 可由引用页快照复算
        const pageMeta = r.attempt.snapshotIds.map(sid => Snapshot.getById(TID_A, sid)).filter(m => m && m.capability === 'product_catalog');
        let merged = [];
        for (const m of pageMeta) merged = merged.concat(JSON.parse(Snapshot.readRawPayload(m).toString('utf8')).products);
        assert.strictEqual(merged.length, r.attempt.summary.count, 'summary.count=页快照复算');
        const stats = Adapters.summarize(Net.mapShopifyItems(merged));
        assert.strictEqual(r.attempt.summary.priceMedian, stats.priceMedian, 'summary 中位价可复算');
        // 无聚合伪装：attempt 引用的 product_catalog 快照全部带 page=N
        for (const m of pageMeta) assert.ok(/page=\d/.test(String(m.source_url)), '无无参数聚合快照: ' + m.source_url);
        // summary 不单独伪装成原始快照：attempt.snapshotIds 里不存在「source_url 无查询参数」的 product_catalog 快照
        assert.ok(!r.attempt.snapshotIds.some(sid => { const m = Snapshot.getById(TID_A, sid); return m && m.capability === 'product_catalog' && !/page=/.test(String(m.source_url || '')); }), '聚合统计未伪装成快照');
      } finally {
        Adapters.resolveAdapterChain = origResolve;
        Adapters.getAdapter = origGet;
      }
    }
  });

  console.log(failed ? `\ndata-surface.test: ${failed} failed` : '\ndata-surface.test: all passed');
  process.exit(failed ? 1 : 0);
})();
