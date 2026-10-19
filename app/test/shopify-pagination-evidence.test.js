'use strict';
// T1：真实分页字节 → Evidence → Fact，所有外部I/O为mock、磁盘只用临时目录。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dns = require('node:dns');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-shopify-pages-'));
process.env.ZB_DATA_DIR = TMP;
delete process.env.MT_STORE_PATH; delete process.env.OBS_DB_PATH;
process.env.MT_STORE_PATH = path.join(TMP, 'tenants.json');
process.env.OBS_DB_PATH = path.join(TMP, 'observability.db');
process.env.CACHE_ENABLED = '0';
const originalLookup = dns.promises.lookup;
const originalTimeout = global.setTimeout;
dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
// 只加速既有页间等待；30s采集预算仍用原定时器。
global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, ms === 2000 ? 0 : ms, ...args);
const Net = require('../research/net.js');
const Snapshot = require('../research/source-snapshot.js');
const Evidence = require('../research/evidence-store.js');
const Fact = require('../research/fact-store.js');
const Metric = require('../research/price-metric.js');
const Enrich = require('../research/enrich.js');
const logger = require('../services/logger.js');
for (const key of ['debug', 'info', 'warn', 'error']) logger[key] = () => {};
const TA = 'tenant:t1-pages-a', TB = 'tenant:t1-pages-b';
const product = id => ({ id, title: 'Product ' + id, variants: [{ id: id * 10, price: '29.00', available: true }] });
// 250个目录实体触发分页；仅首个实体有公开价格，避免本票测试触发既有Fact全盘查找的O(n²)成本。
const firstPage = JSON.stringify({ products: Array.from({ length: 250 }, (_, i) => i === 0 ? product(1) : { id: i + 1, title: 'No public price ' + i, variants: [] }) });
const secondPage = '{ "products": [' + JSON.stringify(product(251)) + '] }\n';
let route;
// SC-02 r3：net.js 经 safeRequest（node:https 直连）抓取，打桩从 global.fetch 下沉到 https.request。
// route(page) 返回 { status?, body? }；error/Error 抛出该页网络异常。
const httpsMod = require('node:https');
const { EventEmitter } = require('events');
const routeStub = function (opts, cb) {
  const req = new EventEmitter();
  req.setTimeout = () => {}; req.destroy = () => {};
  req.end = () => {
    const url = new URL('https://' + (opts.hostname || opts.host) + (opts.path || '/'));
    let r;
    if (url.pathname === '/cart.js') r = { body: '{"currency":"USD"}' };
    else {
      assert.equal(url.hostname, 'example.com');
      assert.equal(url.pathname, '/products.json');
      r = route(Number(url.searchParams.get('page')));
    }
    if (r && r.error) { process.nextTick(() => req.emit('error', r.error)); return; }
    const res = new EventEmitter();
    res.statusCode = r && r.status != null ? r.status : 200;
    res.headers = { 'content-type': 'application/json' };
    process.nextTick(() => { cb(res); if (r && r.body != null) res.emit('data', Buffer.from(r.body)); res.emit('end'); });
  };
  return req;
};
httpsMod.request = routeStub;
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + e.message); }
}
(async () => {
  await t('旧单snapshotId装配入口依旧派生可追踪Fact且重复调用幂等', async () => {
    const s = Snapshot.record({ tenantId: TA, capability: 'product_catalog', provider: 'shopify_products_json',
      source_url: 'https://example.com/products.json', source_status: 'success',
      observed_at: '2026-10-17T00:00:00Z', bodyBytes: Buffer.from(secondPage) });
    const comp = { id: 'legacy', name: 'Legacy' };
    Enrich.persistShopifyPriceEvidence({ tenantId: TA }, comp, { snapshotId: s.meta.snapshot_id, _prov: { recorded: true } }, 'example.com');
    assert.equal(comp.factExtract.fact_count, 1);
    assert.equal(comp.factExtract.comparisons.length,1);assert.equal(comp.factExtract.comparisons[0].reason,'no_previous_fact');
    assert.ok(comp.priceMetric?.metric_id, 'legacy single-snapshot observation also produces an honest small-sample Metric');
    assert.equal(comp.priceMetric.currency, null);
    const metricId = comp.priceMetric.metric_id;
    Enrich.persistShopifyPriceEvidence({ tenantId: TA }, comp, { snapshotId: s.meta.snapshot_id, _prov: { recorded: true } }, 'example.com');
    assert.equal(comp.factExtract.fact_count, 0);
    assert.equal(comp.factExtract.comparisons.length,1);assert.equal(comp.factExtract.comparisons[0].reason,'not_replayed');assert.equal(comp.factExtract.comparisons[0].status,null);
    assert.equal(comp.priceMetric.metric_id, metricId, 'duplicate Facts still participate in Metric retry');
  });
  await t('251款两页均保留原始字节与SC-01，单snapshotId兼容首页', async () => {
    route = page => ({ body: page === 1 ? firstPage : secondPage });
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA, projectRef: 'p1' });
    assert.equal(out.total, 251);
    assert.equal(out.partialScan, false);
    assert.equal(out.partialScanReason, null);
    assert.equal(out.snapshotIds?.length, 2, '每个成功页都能回放');
    assert.equal(out.snapshotId, out.snapshotIds[0]);
    for (const [i, sid] of out.snapshotIds.entries()) {
      const meta = Snapshot.getById(TA, sid);
      assert.equal(meta.partial_scan, null, '页级快照不声明扫描级枚举状态（扫描级在返回值/summary）');
      assert.equal(meta.source_status, 'success');
      assert.equal(new URL(meta.source_url).searchParams.get('page'), String(i + 1));
      assert.equal(meta.collector_version, 'net-1');
      assert.equal(meta.parser_version, null);
      assert.equal(Snapshot.readRawPayload(meta).toString(), i === 0 ? firstPage : secondPage);
      assert.equal(Snapshot.getById(TB, sid), null, '不能跨租户读取');
    }
    const comp = { id: 'c1', name: 'Example' };
    Enrich.persistShopifyPriceEvidence({ tenantId: TA, projectId: 'p1' }, comp, out, 'example.com');
    assert.equal(comp.evidenceExtract.evidence_count, 2);
    assert.equal(comp.factExtract.fact_count, 2);
    const ev = Evidence.findEvidenceBySnapshot(TA, out.snapshotIds[1]);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].entity_key, 'shopify_product:251');
    const facts = Fact.findFactsBySnapshot(TA, out.snapshotIds[1]);
    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0].evidence_ids, [ev[0].evidence_id]);
    assert.equal(facts[0].currency, 'USD', '真实同批cart raw支持币种');
    assert.equal(comp.priceMetric.currency, 'USD');
    assert.equal(comp.priceMetric.sample_product_count, 2);
    assert.equal(comp.priceMetric.value.median, null);
    assert.equal(comp.priceMetric.fact_ids, undefined, '完整引用不塞入全局state');
    assert.equal(Metric.getMetricById(TA, comp.priceMetric.metric_id).collection_snapshot_ids.length, 2);
    const metricId = comp.priceMetric.metric_id;
    Enrich.persistShopifyPriceEvidence({ tenantId: TA, projectId: 'p1' }, comp, out, 'example.com');
    assert.equal(comp.factExtract.fact_count, 0, '相同页重放幂等');
    assert.equal(comp.priceMetric.metric_id, metricId);
    assert.equal(Fact.findFactsBySnapshot(TA, out.snapshotIds[1]).length, 1);
  });
  await t('后续页403保留成功页证据并标partial_scan，不当完整覆盖', async () => {
    route = page => page === 1 ? { body: firstPage } : { status: 403, body: 'blocked' };
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA });
    assert.equal(out.total, 250);
    assert.equal(out.partialScan, true);
    assert.equal(out.partialScanReason, 'products_json_page_2_http_403');
    assert.deepEqual(out.failedPage, { page: 2, reason: 'products_json_page_2_http_403' });
    assert.equal(out.snapshotIds?.length, 1, 'SC-02 r3：后续页失败不落页快照，结构化 failedPage 承载');
    const meta = Snapshot.getById(TA, out.snapshotId);
    assert.equal(meta.source_status, 'success', '页级快照=页事实；扫描级 partial 在返回值/summary/Metric');
    assert.equal(Snapshot.readRawPayload(meta).toString(), firstPage);
    assert.equal(out.currency, 'USD', 'cart 正常时币种仍可追溯');
    const comp = { id: 'partial', name: 'Partial' };
    Enrich.persistShopifyPriceEvidence({ tenantId: TA }, comp, out, 'example.com');
    assert.equal(comp.shopifyPartialScan, true);
    assert.equal(comp.shopifyPartialScanReason, 'products_json_page_2_http_403');
    assert.equal(comp.evidenceExtract.unavailable, false, '成功页证据不受失败页影响');
    const ev = Evidence.findEvidenceBySnapshot(TA, out.snapshotIds[0]);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].evidence_status, 'verified');
    assert.equal(Fact.findFactsBySnapshot(TA, out.snapshotIds[0]).length, 1);
    assert.equal(comp.priceMetric.partial_scan, true, '扫描级 partial 经 scanMeta 传入 Metric，不谎报完整覆盖');
    assert.equal(Metric.getMetricById(TA, comp.priceMetric.metric_id).collection_snapshot_ids.length, 1);
    Enrich.persistShopifyPriceEvidence({ tenantId: TA }, comp, { partialScan: false, partialScanReason: null }, 'example.com');
    assert.equal(comp.shopifyPartialScan, false, '重研不能残留上一轮partial标记');
    assert.equal(comp.shopifyPartialScanReason, null);
    assert.equal(comp.priceMetric, null, 'no new snapshots clears previous Metric reference');
  });
  await t('后续页JSON损坏保留成功页raw与Fact，失败页结构化不造数', async () => {
    const broken = '{ "products": [ invalid JSON';
    route = page => page === 1 ? { body: firstPage } : { body: broken };
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TB });
    assert.equal(out.total, 250);
    assert.equal(out.snapshotIds?.length, 1);
    assert.equal(out.partialScan, true);
    assert.equal(out.partialScanReason, 'products_json_page_2_parse_failed');
    assert.deepEqual(out.failedPage, { page: 2, reason: 'products_json_page_2_parse_failed' });
    const success = Snapshot.getById(TB, out.snapshotId);
    assert.equal(success.source_status, 'success');
    assert.equal(Snapshot.readRawPayload(success).toString(), firstPage);
    const comp = { id: 'bad-json', name: 'Bad JSON' };
    Enrich.persistShopifyPriceEvidence({ tenantId: TB }, comp, out, 'example.com');
    assert.equal(comp.evidenceExtract.unavailable, false);
    assert.equal(comp.factExtract.fact_count, 1, '仅成功页有可派生价格');
  });
  await t('四页预算耗尽每页都有raw且整轮维持partial_scan', async () => {
    route = page => ({ body: JSON.stringify({ products: Array.from({ length: 250 }, (_, i) => product(page * 1000 + i)) }) });
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA });
    assert.equal(out.total, 1000);
    assert.equal(out.truncated, true);
    assert.equal(out.partialScan, true);
    assert.equal(out.partialScanReason, 'products_json_pagination_budget_250x4_exhausted');
    assert.equal(out.snapshotIds?.length, 4);
    for (const sid of out.snapshotIds) {
      const meta = Snapshot.getById(TA, sid);
      assert.equal(meta.source_status, 'success');
      assert.ok(Snapshot.readRawPayload(meta));
    }
  });
  await t('首页失败保留单snapshotId与unavailable Evidence而不造Fact', async () => {
    route = () => ({ status: 403, body: 'blocked' });
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA });
    assert.equal(out.ok, false);
    assert.deepEqual(out.snapshotIds, [out.snapshotId]);
    const comp = { id: 'c2', name: 'Blocked', priceMetric: { metric_id: 'old' } };
    // 兼容旧调用者：只提供单snapshotId。
    Enrich.persistShopifyPriceEvidence({ tenantId: TA }, comp, { snapshotId: out.snapshotId, _prov: { recorded: true } }, 'example.com');
    assert.equal(comp.evidenceExtract.unavailable, true);
    assert.equal(comp.factExtract.fact_count, 0);
    assert.equal(comp.priceMetric, null, 'all-source failure clears old Metric reference');
  });
  await t('首页失败落元数据快照；后续页失败结构化failedPage且成功页证据完整', async () => {
    for (const pageNumber of [1, 2]) {
      for (const [status, sourceStatus] of [[403, 'blocked'], [429, 'rate_limited'], [500, 'unavailable']]) {
        const tid = `tenant:t1-http-${pageNumber}-${status}`;
        const body = `HTTP ${status} on page ${pageNumber}\n`;
        route = page => page === pageNumber ? { status, body } : { body: firstPage };
        const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: tid });
        if (pageNumber === 1) {
          // 首页失败：recFail 元数据快照（SC-02 r3：失败响应不保留 body raw），Evidence 诚实 unavailable。
          assert.equal(out.ok, false);
          assert.equal(out.snapshotIds.length, 1);
          assert.equal(out.snapshotId, out.snapshotIds[0]);
          const meta = Snapshot.getById(tid, out.snapshotIds[0]);
          assert.equal(meta.source_url, 'https://example.com/products.json?limit=250&page=1');
          assert.equal(meta.http_status, status);
          assert.equal(meta.source_status, sourceStatus);
          assert.equal(meta.raw_payload_ref, null, '元数据快照不保留失败响应 body');
          const comp = { id: 'http-error', name: 'HTTP error' };
          Enrich.persistShopifyPriceEvidence({ tenantId: tid }, comp, out, 'example.com');
          const ev = Evidence.findEvidenceBySnapshot(tid, out.snapshotIds[0]);
          assert.equal(ev.length, 1);
          assert.equal(ev[0].evidence_status, 'unavailable');
          assert.equal(Fact.findFactsBySnapshot(tid, out.snapshotIds[0]).length, 0);
          assert.equal(comp.factExtract.fact_count, 0);
        } else {
          // 后续页失败：已成功页证据/Fact 完整，失败页走结构化 failedPage。
          assert.equal(out.ok, true);
          assert.equal(out.total, 250);
          assert.equal(out.partialScan, true);
          assert.equal(out.partialScanReason, `products_json_page_2_http_${status}`);
          assert.deepEqual(out.failedPage, { page: 2, reason: `products_json_page_2_http_${status}` });
          assert.equal(out.snapshotIds.length, 1);
          const comp = { id: 'http-error', name: 'HTTP error' };
          Enrich.persistShopifyPriceEvidence({ tenantId: tid }, comp, out, 'example.com');
          assert.equal(comp.factExtract.fact_count, 1);
          assert.equal(Evidence.findEvidenceBySnapshot(tid, out.snapshotIds[0])[0].evidence_status, 'verified');
        }
      }
    }
  });
  await t('首页网络异常整体失败落元数据快照；后续页网络异常结构化failedPage', async () => {
    for (const pageNumber of [1, 2]) {
      const tid = `tenant:t1-net-${pageNumber}`;
      route = page => { if (page === pageNumber) return { error: new Error('network_down') }; return { body: firstPage }; };
      const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: tid });
      if (pageNumber === 1) {
        // 首页网络异常：整体失败路径，recFail 落基础 URL 元数据快照（无 page 查询参数）。
        assert.equal(out.ok, false);
        assert.equal(out.snapshotIds.length, 1);
        const meta = Snapshot.getById(tid, out.snapshotIds[0]);
        assert.equal(meta.source_url, 'https://example.com/products.json');
        assert.equal(meta.source_status, 'internal_error', '保留既有异常分类；Evidence层映射为unavailable');
        assert.equal(meta.http_status, null);
        assert.equal(meta.raw_payload_ref, null);
        assert.equal(meta.observed_at, null);
      } else {
        assert.equal(out.ok, true);
        assert.equal(out.partialScan, true);
        assert.equal(out.partialScanReason, 'products_json_page_2_error');
        assert.deepEqual(out.failedPage, { page: 2, reason: 'products_json_page_2_error' });
        assert.equal(out.snapshotIds.length, 1);
      }
      const comp = { id: 'network-error', name: 'Network error' };
      Enrich.persistShopifyPriceEvidence({ tenantId: tid }, comp, out, 'example.com');
      assert.equal(Evidence.findEvidenceBySnapshot(tid, out.snapshotIds[0])[0].evidence_status, pageNumber === 1 ? 'unavailable' : 'verified');
    }
  });
  await t('partial目录摘录及分析证据保留已观察范围和原因，完整目录文案兼容', async () => {
    const comp = { pricePoints: [10, 20], currency: 'USD', freebies: [] };
    const excerpt = Enrich.shopifyCatalogExcerpt({ total: 250, partialScan: true, partialScanReason: 'products_json_page_2_http_403' }, comp);
    assert.ok(excerpt.includes('本次已观察250款，扫描未完成'));
    assert.ok(excerpt.includes('products_json_page_2_http_403'));
    assert.ok(!excerpt.includes('共250款'));
    const input = Enrich.researchEvidenceText([{ id: 'E1', tier: 1, kind: 'shopify', title: '官网结构化价格数据', url: 'https://example.com/products.json', excerpt }]);
    assert.ok(input.includes('本次已观察250款，扫描未完成'));
    assert.ok(input.includes('products_json_page_2_http_403'));
    assert.equal(Enrich.shopifyCatalogExcerpt({ total: 250, partialScan: false }, comp), '共250款，$10-$20');
  });
  await t('重研开始即清旧Metric，抓取使用实际tenant/project；抓取抛错也不留旧引用', async () => {
    const comp = { id: 'restart', name: 'Restart', url: 'https://example.com', priceMetric: { metric_id: 'old' } };
    const state = { tenantId: TA, projectId: 'restart-project', competitors: [comp] };
    httpsMod.request = () => { throw new Error('all_sources_down'); };
    // Stop after the real fetch stage; search/LLM may fail, but no live network runs.
    try { await Enrich.deepResearchOne(comp, state, { search: { provider: 'none' }, llm: { apiKey: '' } }); } catch (_) {}
    finally { httpsMod.request = routeStub; }
    assert.equal(comp.priceMetric, null);
    const catalog = [];
    function visit(dir) { if (!fs.existsSync(dir)) return; for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name); if (f.isDirectory()) visit(full); else if (f.name.endsWith('.json')) {
        const m = JSON.parse(fs.readFileSync(full)); if (m.provider === 'shopify_products_json' && m.tenant?.project_ref === 'restart-project') catalog.push(m);
      }
    } }
    visit(path.join(TMP, 'snapshots'));
    assert.ok(catalog.length, 'enrich passes projectRef to real fetchShopifyProducts');
    assert.equal(catalog[0].tenant.tenant_id, TA);
  });
  await t('Metric存储异常不阻断原有Fact/Diff/Event检测', async () => {
    const snap = Snapshot.record({ tenantId: TA, capability: 'product_catalog', provider: 'shopify_products_json',
      source_url: 'https://example.com/products.json', source_status: 'success',
      observed_at: '2026-10-17T09:00:00Z', bodyBytes: Buffer.from(JSON.stringify({ products: [product(456)] })) }).meta;
    const original = Metric.recordPriceMetric;
    Metric.recordPriceMetric = () => { throw new Error('metric_disk_failure'); };
    const comp = { id: 'metric-io', name: 'Metric IO', priceMetric: { metric_id: 'old' } };
    try { Enrich.persistShopifyPriceEvidence({ tenantId: TA }, comp, { snapshotIds: [snap.snapshot_id] }, 'example.com'); }
    finally { Metric.recordPriceMetric = original; }
    assert.equal(comp.priceMetric, null);
    assert.equal(comp.factExtract.fact_count, 1, 'already-recorded Fact stays successful');
    assert.equal(comp.factExtract.detect_reason, 'no_previous_fact', 'original Event detector still runs');
    assert.equal(comp.factExtract.reason, null);
    assert.equal(comp.factExtract.metric_reason, 'error');
  });
  await t('逐Fact检测异常保留诊断并继续其他Fact，不重放duplicate', async () => {
    const snap=Snapshot.record({tenantId:TA,capability:'product_catalog',provider:'shopify_products_json',source_url:'https://example.com/products.json',source_status:'success',observed_at:'2026-10-17T10:00:00Z',bodyBytes:Buffer.from(JSON.stringify({products:[product(8101),product(8102)]}))}).meta;
    const domain=require('../research/domain-event'),original=domain.detectPriceChangeFromFact;
    let calls=0;domain.detectPriceChangeFromFact=(input)=>{if(++calls===1)throw Error('synthetic detector failure');return original(input);};
    const comp={id:'per-fact'};
    try{Enrich.persistShopifyPriceEvidence({tenantId:TA},comp,{snapshotId:snap.snapshot_id},'example.com');}finally{domain.detectPriceChangeFromFact=original;}
    assert.equal(comp.factExtract.comparisons.length,2);
    assert.equal(comp.factExtract.comparisons[0].reason,'comparison_failed');assert.equal(comp.factExtract.comparisons[0].status,null);
    assert.equal(comp.factExtract.comparisons[1].reason,'no_previous_fact');assert.equal(calls,2);
  });
})().catch(e => { failed++; console.error(e); }).finally(() => {
  httpsMod.request = routeStub;
  dns.promises.lookup = originalLookup;
  global.setTimeout = originalTimeout;
  require('../observability/telemetry.js')._resetForTest();
  require('../services/db.js').closeDb();
  // 无缓存SQLite句柄；其他持久化模块按需打开并关闭连接。
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`=== shopify-pagination-evidence.test: ${passed} passed, ${failed} failed ===`);
  process.exitCode = failed ? 1 : 0;
});
