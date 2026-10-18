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
const originalFetch = global.fetch;
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
global.fetch = async (input) => {
  const url = new URL(String(input));
  if (url.pathname === '/cart.js') return new Response('{"currency":"USD"}');
  assert.equal(url.hostname, 'example.com');
  assert.equal(url.pathname, '/products.json');
  return route(Number(url.searchParams.get('page')));
};
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
    route = page => new Response(page === 1 ? firstPage : secondPage);
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA, projectRef: 'p1' });
    assert.equal(out.total, 251);
    assert.equal(out.partialScan, false);
    assert.equal(out.partialScanReason, null);
    assert.equal(out.snapshotIds?.length, 2, '每个实际响应都能回放');
    assert.equal(out.snapshotId, out.snapshotIds[0]);
    for (const [i, sid] of out.snapshotIds.entries()) {
      const meta = Snapshot.getById(TA, sid);
      assert.equal(meta.partial_scan, false);
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
    route = page => page === 1 ? new Response(firstPage) : new Response('blocked', { status: 403 });
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA });
    assert.equal(out.total, 250);
    assert.equal(out.partialScan, true);
    assert.equal(out.partialScanReason, 'products_json_page_2_http_403');
    assert.equal(out.snapshotIds?.length, 2);
    const meta = Snapshot.getById(TA, out.snapshotId);
    assert.equal(meta.source_status, 'partial');
    assert.equal(meta.partial_scan, true);
    assert.equal(meta.partial_scan_reason, 'products_json_page_2_http_403');
    assert.equal(Snapshot.readRawPayload(meta).toString(), firstPage);
    const failure = Snapshot.getById(TA, out.snapshotIds[1]);
    assert.equal(failure.source_url, 'https://example.com/products.json?limit=250&page=2');
    assert.equal(failure.http_status, 403);
    assert.equal(failure.source_status, 'blocked');
    assert.equal(Snapshot.readRawPayload(failure).toString(), 'blocked');
    const comp = { id: 'partial', name: 'Partial' };
    Enrich.persistShopifyPriceEvidence({ tenantId: TA }, comp, out, 'example.com');
    assert.equal(comp.shopifyPartialScan, true);
    assert.equal(comp.shopifyPartialScanReason, 'products_json_page_2_http_403');
    assert.equal(comp.evidenceExtract.unavailable, true);
    const unavailable = Evidence.findEvidenceBySnapshot(TA, out.snapshotIds[1]);
    assert.equal(unavailable.length, 1);
    assert.equal(unavailable[0].evidence_status, 'unavailable');
    assert.equal(unavailable[0].extracted_value, null);
    assert.equal(Fact.findFactsBySnapshot(TA, out.snapshotIds[1]).length, 0);
    assert.equal(comp.priceMetric.partial_scan, true);
    assert.equal(Metric.getMetricById(TA, comp.priceMetric.metric_id).collection_snapshot_ids.length, 2);
    Enrich.persistShopifyPriceEvidence({ tenantId: TA }, comp, { partialScan: false, partialScanReason: null }, 'example.com');
    assert.equal(comp.shopifyPartialScan, false, '重研不能残留上一轮partial标记');
    assert.equal(comp.shopifyPartialScanReason, null);
    assert.equal(comp.priceMetric, null, 'no new snapshots clears previous Metric reference');
  });
  await t('后续页JSON损坏仍保留已接收raw，成功页可产Fact，坏页不造数', async () => {
    const broken = '{ "products": [ invalid JSON';
    route = page => new Response(page === 1 ? firstPage : broken);
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TB });
    assert.equal(out.total, 250);
    assert.equal(out.snapshotIds?.length, 2);
    const success = Snapshot.getById(TB, out.snapshotId);
    assert.equal(success.partial_scan, true);
    const failure = Snapshot.getById(TB, out.snapshotIds[1]);
    assert.equal(failure.source_status, 'parse_failed');
    assert.equal(Snapshot.readRawPayload(failure).toString(), broken);
    assert.ok(failure.observed_at, '已接收的内容确实被观察');
    const comp = { id: 'bad-json', name: 'Bad JSON' };
    Enrich.persistShopifyPriceEvidence({ tenantId: TB }, comp, out, 'example.com');
    assert.equal(comp.evidenceExtract.unavailable, true);
    assert.equal(comp.factExtract.fact_count, 1, '仅成功页有可派生价格');
    assert.equal(Fact.findFactsBySnapshot(TB, out.snapshotIds[1]).length, 0);
  });
  await t('四页预算耗尽每页都有raw且整轮维持partial_scan', async () => {
    route = page => new Response(JSON.stringify({ products: Array.from({ length: 250 }, (_, i) => product(page * 1000 + i)) }));
    const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: TA });
    assert.equal(out.total, 1000);
    assert.equal(out.snapshotIds?.length, 4);
    for (const sid of out.snapshotIds) {
      const meta = Snapshot.getById(TA, sid);
      assert.equal(meta.partial_scan, true);
      assert.equal(meta.partial_scan_reason, 'products_json_pagination_budget_250x4_exhausted');
      assert.ok(Snapshot.readRawPayload(meta));
    }
  });
  await t('首页失败保留单snapshotId与unavailable Evidence而不造Fact', async () => {
    route = () => new Response('blocked', { status: 403 });
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
  await t('首页与后续页403/429/500分别保留真实raw/status/页URL和失败Evidence', async () => {
    for (const pageNumber of [1, 2]) {
      for (const [status, sourceStatus] of [[403, 'blocked'], [429, 'rate_limited'], [500, 'unavailable']]) {
        const tid = `tenant:t1-http-${pageNumber}-${status}`;
        const body = `HTTP ${status} on page ${pageNumber}\n`;
        route = page => page === pageNumber ? new Response(body, { status }) : new Response(firstPage);
        const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: tid });
        assert.equal(out.snapshotIds.length, pageNumber);
        assert.equal(out.snapshotId, out.snapshotIds[0]);
        const failedId = out.snapshotIds[pageNumber - 1];
        const meta = Snapshot.getById(tid, failedId);
        assert.equal(meta.source_url, `https://example.com/products.json?limit=250&page=${pageNumber}`);
        assert.equal(meta.http_status, status);
        assert.equal(meta.source_status, sourceStatus);
        assert.equal(Snapshot.readRawPayload(meta)?.toString(), body);
        const comp = { id: 'http-error', name: 'HTTP error' };
        Enrich.persistShopifyPriceEvidence({ tenantId: tid }, comp, out, 'example.com');
        const ev = Evidence.findEvidenceBySnapshot(tid, failedId);
        assert.equal(ev.length, 1);
        assert.equal(ev[0].evidence_status, 'unavailable');
        assert.equal(Fact.findFactsBySnapshot(tid, failedId).length, 0);
        assert.equal(comp.factExtract.fact_count, pageNumber === 1 ? 0 : 1);
      }
    }
  });
  await t('首页与后续页网络异常无body仍保留该页失败metadata', async () => {
    for (const pageNumber of [1, 2]) {
      const tid = `tenant:t1-net-${pageNumber}`;
      route = page => { if (page === pageNumber) throw new Error('network_down'); return new Response(firstPage); };
      const out = await Net.fetchShopifyProducts('https://example.com', { tenantId: tid });
      assert.equal(out.snapshotIds.length, pageNumber);
      const failedId = out.snapshotIds[pageNumber - 1];
      const meta = Snapshot.getById(tid, failedId);
      assert.equal(meta.source_url, `https://example.com/products.json?limit=250&page=${pageNumber}`);
      assert.equal(meta.source_status, 'internal_error', '保留既有异常分类；Evidence层映射为unavailable');
      assert.equal(meta.http_status, null);
      assert.equal(meta.raw_payload_ref, null);
      assert.equal(meta.observed_at, null);
      const comp = { id: 'network-error', name: 'Network error' };
      Enrich.persistShopifyPriceEvidence({ tenantId: tid }, comp, out, 'example.com');
      assert.equal(Evidence.findEvidenceBySnapshot(tid, failedId)[0].evidence_status, 'unavailable');
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
    global.fetch = async () => { throw new Error('all_sources_down'); };
    // Stop after the real fetch stage; search/LLM may fail, but no live network runs.
    try { await Enrich.deepResearchOne(comp, state, { search: { provider: 'none' }, llm: { apiKey: '' } }); } catch (_) {}
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
  global.fetch = originalFetch;
  dns.promises.lookup = originalLookup;
  global.setTimeout = originalTimeout;
  require('../observability/telemetry.js')._resetForTest();
  require('../services/db.js').closeDb();
  // 无缓存SQLite句柄；其他持久化模块按需打开并关闭连接。
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`=== shopify-pagination-evidence.test: ${passed} passed, ${failed} failed ===`);
  process.exitCode = failed ? 1 : 0;
});
