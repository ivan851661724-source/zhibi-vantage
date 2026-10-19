'use strict';
// E2E 数据准备 · 服务层直插子进程（独占运行——server 已停止或以 WAL 并发安全共存）
// 用法：node seed-svc.cjs <backendDir> <dataDir> <tenantId> <projectId> <flavor>
//   flavor=full    → 3 品牌（成功采集含证据 / partial / 未采集）+ 时间线 + 情报
//   flavor=minimal → 1 品牌（成功采集含证据）+ 时间线 + 情报
// 说明：写入的是真实 SQLite（brand-store / surface-store / evidence-store 真值链），
//       不伪造 API 响应；功能验证在 core-ui-r2.cjs 中全部走真实 HTTP 与浏览器 UI。
const fs = require('fs');
const path = require('path');

const BACKEND = process.argv[2] || '';
const DATA_DIR = process.argv[3] || '';
const TID = process.argv[4] || '';
const PID = process.argv[5] || '';
const FLAVOR = process.argv[6] || 'full';
if (!BACKEND || !DATA_DIR || !TID || !PID) {
  console.error('usage: node seed-svc.cjs <backendDir> <dataDir> <tenantId> <projectId> [full|minimal]');
  process.exit(1);
}
process.env.ZB_DATA_DIR = DATA_DIR;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';

const db = require(path.join(BACKEND, 'app/services/db.js'));
const BrandStore = require(path.join(BACKEND, 'app/services/brand-store.js'));
const BrandSvc = require(path.join(BACKEND, 'app/services/brand-service.js'));
const SurfaceStore = require(path.join(BACKEND, 'app/services/surface-store.js'));
const Adapters = require(path.join(BACKEND, 'app/services/source-adapter.js'));
const Snapshot = require(path.join(BACKEND, 'app/research/source-snapshot.js'));
const EvidenceStore = require(path.join(BACKEND, 'app/research/evidence-store.js'));
const { saveState, projFile } = require(path.join(BACKEND, 'app/core/state-store.js'));

// TikTok 广告查询端点（与生产 adapter 同一常量；仅作快照 source_url，不含任何凭据）
const TT_ENDPOINT = 'https://open.tiktokapis.com/v2/research/adlib/ad/query/';

// 项目内唯一标识：PID 去掉 'proj' 前缀（含 'e2a'/'e2b' 段 + 时间戳，跨项目必不同）
const UTAG = PID.replace(/^proj/, '');
function mkSnapshot(tid, url, body, extra) {
  const r = Snapshot.record(Object.assign({
    capability: 'product_catalog', provider: 'shopify_products_json', source_url: url,
    final_url: url, redirect_hops: 0, http_status: 200, source_status: 'success',
    observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(), bodyBytes: Buffer.from(body),
    contentType: 'application/json', trigger: 'manual', tenantId: tid,
  }, extra || {}));
  if (!r.recorded) throw new Error('snapshot not recorded: ' + url);
  return r.meta;
}
function pageBody(ids) {
  return JSON.stringify({ products: ids.map(id => ({ id, title: '商品 ' + id, product_type: 'handpuppet', variants: [{ price: String(id * 10 + 9), available: id % 2 === 1 }] })) });
}
function recordCatalogEvidence(tid, host, snapIds, observedAt) {
  return EvidenceStore.recordEvidence({
    tenantId: tid, projectRef: PID, brandHint: host, source: 'shopify', provider: 'shopify_products_json',
    source_snapshot_ids: snapIds,
    claim: { field: 'catalog.observation', scope: 'public_catalog_observation' },
    entity_key: host, entity_ref: { kind: 'storefront_domain', domain: host },
    extracted_value: { summaryKind: 'storefront_catalog', count: 4, onSaleCount: 2, priceMin: 19, priceMax: 49, priceMedian: 29, currency: 'USD', partialScan: false },
    unit: null, currency: 'USD', market: null, evidence_status: 'verified',
    parser_version: 'shopify-adapter-1', extractor_version: 'shopify-adapter-1',
    observed_at: observedAt, note: 'e2e seed',
  });
}

// TikTok 广告摘要（R4.15 浏览器验证用 · 受控测试记录）
// 🔴 纪律：这不是真实 provider 响应，也不代表 TikTok 已接通。
//   · 原始响应体带 _e2e_fixture 标记，快照里可查来源；
//   · 摘要 / 观察 / Evidence 全部经生产 adapter.normalize 生成（同一套字段映射与覆盖判定，
//     不手写 coverageNote、不手写 32 国）；
//   · Attempt / Snapshot / Evidence 走生产真值链写入，页面通过真实 HTTP API 读取。
function seedTiktokAds({ tid, competitorId, brandName, host, market, creative }) {
  const adsBody = {
    _e2e_fixture: 'controlled e2e test record; NOT a real provider response',
    data: {
      ads: [{
        ad: {
          id: creative.id,
          first_shown_date: creative.firstShownDate || null,
          last_shown_date: creative.lastShownDate || null,
          status: creative.status || 'active',
          ...(creative.statusStatement ? { status_statement: creative.statusStatement } : {}),
          videos: [], image_urls: [],
          reach: { unique_user_seen: creative.reach || '10K' },
        },
        advertiser: { business_id: 9000000000001, business_name: brandName, paid_for_by: brandName },
      }],
      has_more: false,
      search_id: 'e2e-' + UTAG + '-sid',
    },
    error: { code: 'ok', http_status_code: 200, message: '' },
  };
  const snap = mkSnapshot(tid, TT_ENDPOINT + '?fields=ad.id', JSON.stringify(adsBody), {
    capability: 'tiktok_commercial_content', provider: 'tiktok_research_api',
    contentType: 'application/json',
  });
  const out = Adapters.getAdapter('tiktok').normalize({
    creatives: [{
      id: String(creative.id),
      firstShownDate: creative.firstShownDate || null,
      lastShownDate: creative.lastShownDate || null,
      status: creative.status || 'active',
      statusStatement: creative.statusStatement || null,
      advertiser: brandName,
      businessId: '9000000000001',
      paidForBy: brandName,
      creativeUrl: null,
      videoUrls: [],
      reachLabel: creative.reach || '10K',
      region: null,
    }],
    snapshotIds: [snap.snapshot_id],
    periodStart: '20250101', periodEnd: '20250331',
    countryScope: 'ALL（官方支持国家范围）',
    brandMarket: market, // 'us' / 'de' —— 覆盖判定由 adapter 内的唯一事实源派生
    providerRecordId: 'e2e-' + UTAG + '-sid',
    partialScan: false,
    sourceUrl: TT_ENDPOINT,
  }, { competitor: { name: brandName, url: 'https://' + host } });

  const ev = EvidenceStore.recordEvidence({
    tenantId: tid, projectRef: PID, brandHint: host,
    source: out.evidenceSource, provider: out.evidenceProvider,
    source_snapshot_ids: [snap.snapshot_id],
    claim: { field: out.claimField, scope: out.claimScope },
    entity_key: out.entityKey, entity_ref: out.entityRef,
    extracted_value: out.extractedValue,
    unit: null, currency: null, market: null, evidence_status: 'verified',
    parser_version: out.parserVersion, extractor_version: out.parserVersion,
    observed_at: snap.observed_at,
    note: 'e2e seed（受控测试记录，非真实 provider 响应）',
  });
  const at = SurfaceStore.createAttempt({
    tenantId: tid, projectId: PID, competitorId, capability: 'tiktok_commercial_content',
    dimension: 'ad_campaigns', trigger: 'manual', idempotencyKey: 'e2e-' + UTAG + '-ads-' + market + '-' + Date.now(),
    nowMs: Date.now(),
  });
  SurfaceStore.completeAttempt(tid, at.attempt.attemptId, {
    status: out.outcome === 'partial' ? 'partial' : 'success', sourceStatus: out.outcome === 'partial' ? 'partial' : 'success',
    observations: out.observations,
    snapshotIds: [snap.snapshot_id], evidenceIds: [ev.meta.evidence_id],
    summary: out.summary,
    endedAt: new Date().toISOString(),
  });
  return { attemptId: at.attempt.attemptId, snapshotId: snap.snapshot_id, coverageState: out.summary.coverageState, brandMarket: out.summary.brandMarket };
}

(async () => {
  // state 文件（真实 state-store 异步落盘 → 内容级轮询等待）
  const full = FLAVOR !== 'minimal';
  const competitors = full ? [
    { id: 'compU1_' + UTAG, name: 'PuppetLab', status: 'done', url: 'https://puppetlab.example.com', isShopify: true, pricePoints: [19, 29], sellingPoints: ['可换脸', 'petite 尺寸'] },
    { id: 'compU2_' + UTAG, name: 'DollForge', status: 'done', url: 'https://dollforge.example.com', isShopify: true, pricePoints: [39], sellingPoints: ['定制涂装'] },
    { id: 'compU3_' + UTAG, name: 'ToyHive', status: 'done', url: 'https://toyhive.example.com', isShopify: true, pricePoints: [49], sellingPoints: ['毛绒联名'], market: 'de' },
  ] : [
    { id: 'compB1_' + UTAG, name: 'AromaHouse', status: 'done', url: 'https://aromahouse.example.com', isShopify: true, pricePoints: [25, 45], sellingPoints: ['大豆蜡', '礼盒装'] },
  ];
  const f = projFile(PID, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({
    projectId: PID, tenantId: TID,
    track: full ? '潮玩手办出海' : '家居香氛出海',
    discoveredAt: new Date().toISOString(),
    intent: { regions: ['us'], category: full ? 'toys' : 'home-fragrance', platforms: ['shopify'] },
    competitors,
  });
  const want = competitors.length;
  for (let i = 0; i < 150; i++) {
    try {
      const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
      if ((cur.competitors || []).length >= want) break;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 20));
  }
  BrandSvc.syncProjectBrands(TID, PID);
  const okComp = full ? 'compU1_' + UTAG : 'compB1_' + UTAG;
  const partComp = full ? 'compU2_' + UTAG : null;
  const bidOk = BrandStore.brandIdForCompetitor(TID, PID, okComp);
  if (!bidOk) throw new Error('brand link missing for ' + okComp);

  // 成功采集品牌：快照 + 证据 + 成功 attempt（verified 证据链）
  const host = full ? 'puppetlab.example.com' : 'aromahouse.example.com';
  const p1 = mkSnapshot(TID, 'https://' + host + '/products.json?limit=250&page=1', pageBody([1, 2, 3, 4]));
  const cart = mkSnapshot(TID, 'https://' + host + '/cart.js', JSON.stringify({ currency: 'USD' }), { capability: 'storefront_currency', provider: 'shopify_cart_js_json' });
  const ev = recordCatalogEvidence(TID, host, [p1.snapshot_id, cart.snapshot_id], p1.observed_at);
  const a1 = SurfaceStore.createAttempt({ tenantId: TID, projectId: PID, competitorId: okComp, capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'e2e-' + UTAG + '-ok', nowMs: Date.now() });
  SurfaceStore.completeAttempt(TID, a1.attempt.attemptId, {
    status: 'success', sourceStatus: 'success',
    observations: [
      { id: '1', title: full ? '可换脸手办·基础款' : '大豆蜡香薰·基础款', price: 19, currency: 'USD', available: true, publishedAt: null },
      { id: '2', title: full ? '可换脸手办·豪华款' : '大豆蜡香薰·礼盒', price: 29, currency: 'USD', available: true, publishedAt: null },
      { id: '3', title: full ? 'petite 系列盲盒' : '车载香氛片', price: 39, currency: 'USD', available: false, publishedAt: null },
      { id: '4', title: full ? '宠物礼盒联名' : '香薰蜡烛补充装', price: 49, currency: 'USD', available: true, publishedAt: null },
    ],
    snapshotIds: [p1.snapshot_id, cart.snapshot_id], evidenceIds: [ev.meta.evidence_id],
    summary: { kind: 'storefront_catalog', count: 4, onSaleCount: 2, soldOutCount: 1, priceMin: 19, priceMax: 49, priceMedian: 29, currency: 'USD', currencyStatus: 'confirmed' },
    endedAt: new Date().toISOString(),
  });

  // TikTok 广告摘要（R4.15 浏览器验证；仅 full 项目 = 项目 A）
  //   · US 品牌（PuppetLab，intent.regions=[us]）→ coverageState=out_of_coverage
  //   · 德国品牌（ToyHive，market=de）→ covered，且带 status_statement（用于验证"有值才展示"）
  let adsUs = null, adsDe = null, bidDe = null;
  if (full) {
    adsUs = seedTiktokAds({
      tid: TID, competitorId: okComp, brandName: 'PuppetLab', host, market: 'us',
      creative: { id: 'e2e-ad-us-1', firstShownDate: '20250102', lastShownDate: '20250118', status: 'active', reach: '12K' },
    });
    const deComp = 'compU3_' + UTAG;
    bidDe = BrandStore.brandIdForCompetitor(TID, PID, deComp);
    adsDe = seedTiktokAds({
      tid: TID, competitorId: deComp, brandName: 'ToyHive', host: 'toyhive.example.com', market: 'de',
      creative: { id: 'e2e-ad-de-1', firstShownDate: '20250201', lastShownDate: '20250228', status: 'inactive', statusStatement: 'Ad is no longer active.', reach: '9K' },
    });
  }

  let bidPart = null;
  if (full) {
    // partial 品牌（部分完成 + 无证据）
    const p2 = mkSnapshot(TID, 'https://dollforge.example.com/products.json?limit=250&page=1', pageBody([7, 8]));
    const a2 = SurfaceStore.createAttempt({ tenantId: TID, projectId: PID, competitorId: partComp, capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'e2e-' + UTAG + '-part', nowMs: Date.now() });
    SurfaceStore.completeAttempt(TID, a2.attempt.attemptId, {
      status: 'partial', sourceStatus: 'partial', partialScan: true, partialScanReason: 'PAGE_FETCH_FAILED', failedPage: 2, successfullyFetchedPages: 1,
      observations: [{ id: '7', title: '定制涂装娃衣', price: 79, currency: 'USD', available: true, publishedAt: null }],
      snapshotIds: [p2.snapshot_id], evidenceIds: [],
      summary: { kind: 'storefront_catalog', count: 1, onSaleCount: 0, soldOutCount: 0, priceMin: 79, priceMax: 79, priceMedian: 79, currency: 'USD', currencyStatus: 'unconfirmed' },
      endedAt: new Date().toISOString(),
    });
    bidPart = BrandStore.brandIdForCompetitor(TID, PID, partComp);
  }

  // 时间线（成功 + partial 品牌）
  const st = BrandSvc.loadProjectState(TID, PID);
  for (const [bid, cid] of [[bidOk, okComp]].concat(bidPart ? [[bidPart, partComp]] : [])) {
    BrandSvc.rebuildTimeline(TID, bid, PID, BrandSvc.findCompetitor(st, cid));
  }

  const intel = BrandSvc.listIntelligence(TID, { projectId: PID });
  console.log('[seed-svc] done: okBrand=' + bidOk + (bidPart ? ' partBrand=' + bidPart : '') + ' intel=' + intel.length);
  console.log('[seed-svc] BIDS ' + JSON.stringify({ ok: bidOk, part: bidPart, de: bidDe }));
  console.log('[seed-svc] ADS ' + JSON.stringify({
    us: adsUs ? { brand: bidOk, coverageState: adsUs.coverageState, brandMarket: adsUs.brandMarket, attemptId: adsUs.attemptId } : null,
    de: adsDe ? { brand: bidDe, coverageState: adsDe.coverageState, brandMarket: adsDe.brandMarket, attemptId: adsDe.attemptId } : null,
  }));
  process.exit(0);
})().catch(e => { console.error('[seed-svc] FATAL', e && e.stack || e); process.exit(1); });
