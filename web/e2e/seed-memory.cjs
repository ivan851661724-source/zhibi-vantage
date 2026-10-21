'use strict';
// E2E 数据准备（SC-05 Competitive Memory）：真实数据链，零 mock。
//   1) 真实 /api/register 拿租户与 token
//   2) 项目行直插 multitenant.db + 项目档案（竞品：一个有两次价格、一个只有一个观察点）
//   3) 品牌档案与项目链接（BrandStore）
//   4) 三次目录观察写入 Memory：
//        · 2026-09-10 首次（两个商品）
//        · 2026-10-08 价格变化（商品 A 110 → 95）
//        · 2026-10-15 一次 archived_observation（存档快照，用于验证「历史存档观察」标签）
//      Snapshot / Evidence 全部真实落盘（走生产 record 接口），summary 由生产 adapter.normalize 生成。
//   5) 真实跑一次历史回补任务（本环境 archive.org 不可达 → 如实 source_unavailable）
//   6) 输出 seed.json（token / 项目 / 品牌 / 期望值）
//
// 用法：node seed-memory.cjs --data-dir <后端 ZB_DATA_DIR> --backend http://127.0.0.1:3301
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function arg(name, dflt) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; }
const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = arg('--data-dir', '');
const BASE = arg('--backend', 'http://127.0.0.1:3301');
const OUT = arg('--out', path.join(__dirname, '.e2e-memory.json'));
if (!DATA_DIR) { console.error('usage: node seed-memory.cjs --data-dir <ZB_DATA_DIR> [--backend url]'); process.exit(1); }
process.env.ZB_DATA_DIR = DATA_DIR;
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.ZB_BACKFILL_POINT_DELAY_MS = '0';

const App = (p) => require(path.join(BACKEND_DIR, 'app', p));
const Db = App('services/db.js');
const BrandStore = App('services/brand-store.js');
const Snapshot = App('research/source-snapshot.js');
const EvidenceStore = App('research/evidence-store.js');
const Memory = App('services/competitive-memory.js');
const Store = App('services/competitive-memory-store.js');
const Backfill = App('services/backfill-service.js');
const Adapters = App('services/source-adapter.js');
const { saveState, projFile } = App('core/state-store.js');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(method, url, body, token) {
  const r = await fetch(url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
}

// 与 net.mapShopifyItems 同形状的目录项（由生产 normalize 生成 summary）
function rawProduct(id, handle, title, price, soldOut, variants) {
  return {
    id, handle, title,
    variants: Array.from({ length: variants }, (_, i) => ({ price: String(price), available: !soldOut })),
  };
}

(async () => {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(500); try { const r = await fetch(BASE + '/api/version'); up = r.ok; } catch (e) {} }
  if (!up) throw new Error('backend 未就绪: ' + BASE);

  const EMAIL = 'mem-' + Date.now().toString(36) + '@example.com';
  const PASSWORD = 'mem-e2e-pass1';
  let reg = await api('POST', BASE + '/api/register', { email: EMAIL, password: PASSWORD, name: 'Memory E2E' });
  if (reg.status !== 201) reg = await api('POST', BASE + '/api/login', { email: EMAIL, password: PASSWORD });
  if (!reg.json || !reg.json.token) throw new Error('注册/登录失败: ' + JSON.stringify(reg.json).slice(0, 200));
  const token = reg.json.token, tenantId = reg.json.tenantId;
  console.log('[seed-mem] tenant =', tenantId);

  const projId = 'projmem' + Date.now().toString(36);
  const compMove = 'compmov' + Date.now().toString(36);   // 两次价格 → 画线
  const compFlat = 'compflt' + Date.now().toString(36);   // 单点 → 不画趋势
  const domainMove = 'memmove.example.com';
  const domainFlat = 'memflat.example.com';

  Db.saveProject({ id: projId, tenantId, track: '记忆地基', competitors: [], createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(projFile(projId, tenantId)), { recursive: true });
  saveState({
    projectId: projId, tenantId, track: '记忆地基',
    discoveredAt: new Date().toISOString(), intent: { regions: ['us'] },
    competitors: [
      { id: compMove, name: 'Puppet Lab', status: 'done', url: 'https://' + domainMove, isShopify: true, currency: 'USD' },
      { id: compFlat, name: 'Doll Forge', status: 'done', url: 'https://' + domainFlat, isShopify: true, currency: 'USD' },
    ],
  });
  for (let i = 0; i < 100 && !fs.existsSync(projFile(projId, tenantId)); i++) await sleep(20);
  const bMove = BrandStore.upsertBrand({ tenantId, canonicalName: 'Puppet Lab', officialDomain: domainMove, competitorRef: compMove });
  BrandStore.linkProject({ tenantId, brandId: bMove.brand.brandId, projectId: projId, competitorRef: compMove, market: 'us' });
  const bFlat = BrandStore.upsertBrand({ tenantId, canonicalName: 'Doll Forge', officialDomain: domainFlat, competitorRef: compFlat });
  BrandStore.linkProject({ tenantId, brandId: bFlat.brand.brandId, projectId: projId, competitorRef: compFlat, market: 'us' });

  function catalogFor(kind, price) {
    if (kind === 'move') {
      return {
        products: [
          rawProduct(9001, 'plush-fox', 'Plush Fox', price, false, 2),
          rawProduct(9002, 'keychain', 'Keychain', 18, false, 1),
        ],
      };
    }
    return { products: [rawProduct(9101, 'doll-classic', 'Classic Doll', 64, false, 3)] };
  }

  function writeObservation({ kind, compId, domain, brandName, price, observedAt, sourceKind, effectiveAt, sourceUrl }) {
    const cat = catalogFor(kind, price);
    const items = Adapters.summarize(require(path.join(BACKEND_DIR, 'app', 'research', 'net.js')).mapShopifyItems(cat.products));
    const mapped = require(path.join(BACKEND_DIR, 'app', 'research', 'net.js')).mapShopifyItems(cat.products);
    const snapUrl = sourceUrl || ('https://' + domain + '/products.json?limit=250&page=1');
    const snap = Snapshot.record({
      capability: sourceKind === 'archived_observation' ? 'product_catalog_archive' : 'product_catalog',
      provider: sourceKind === 'archived_observation' ? 'web_archive' : 'shopify_products_json',
      source_url: snapUrl, source_status: 'success',
      observed_at: observedAt, fetched_at: observedAt,
      bodyBytes: Buffer.from(JSON.stringify(cat)), contentType: 'application/json',
      trigger: 'manual', tenantId,
      note: sourceKind === 'archived_observation' ? 'e2e archive fixture (controlled test record)' : 'e2e live fixture (controlled test record)',
    });
    if (!snap.recorded) throw new Error('snapshot failed');
    const ev = EvidenceStore.recordEvidence({
      tenantId, projectRef: projId, brandHint: brandName,
      source: sourceKind === 'archived_observation' ? 'web_archive' : 'shopify',
      provider: sourceKind === 'archived_observation' ? 'web_archive_shopify_products' : 'shopify_products_json',
      source_snapshot_ids: [snap.meta.snapshot_id],
      claim: { field: 'catalog.observation', scope: sourceKind === 'archived_observation' ? 'archived_catalog_observation' : 'public_catalog_observation' },
      entity_key: domain, entity_ref: { kind: 'storefront_domain', domain },
      extracted_value: Object.assign({ summaryKind: 'storefront_catalog' }, items),
      unit: null, currency: 'USD', market: null,
      evidence_status: 'verified',
      parser_version: 'shopify-adapter-1', extractor_version: 'shopify-adapter-1',
      observed_at: observedAt, note: null,
    });
    if (!ev.recorded) throw new Error('evidence failed');
    const res = Memory.ingestCatalogObservation({
      tenantId, projectId: projId, competitorId: compId, domain, brandName,
      items: mapped,
      summary: Object.assign({}, items, { currency: sourceKind === 'archived_observation' ? null : 'USD', partialScan: false }),
      snapshotIds: [snap.meta.snapshot_id],
      evidenceIds: [ev.meta.evidence_id],
      sourceKind,
      effectiveAt: effectiveAt || null,
      timePrecision: sourceKind === 'archived_observation' ? 'day' : 'captured_only',
      observedAt,
      parserVersion: 'shopify-adapter-1',
      sourceUrl: snapUrl,
    });
    return { snap: snap.meta.snapshot_id, ev: ev.meta.evidence_id, res };
  }

  // ① 首次（两个商品，价格 110 / 18）
  const o1 = writeObservation({
    kind: 'move', compId: compMove, domain: domainMove, brandName: 'Puppet Lab', price: 110,
    observedAt: '2026-09-10T08:00:00.000Z', sourceKind: 'live_observation',
  });
  // ② 价格变化（110 → 95，同币种同规格）
  const o2 = writeObservation({
    kind: 'move', compId: compMove, domain: domainMove, brandName: 'Puppet Lab', price: 95,
    observedAt: '2026-10-08T08:00:00.000Z', sourceKind: 'live_observation',
  });
  // ③ 历史存档观察（存档时间 2026-06-01，抓取时间 2026-10-15）
  const o3 = writeObservation({
    kind: 'move', compId: compMove, domain: domainMove, brandName: 'Puppet Lab', price: 128,
    observedAt: '2026-10-15T08:00:00.000Z', sourceKind: 'archived_observation',
    effectiveAt: '2026-06-01T00:00:00.000Z',
    sourceUrl: 'https://web.archive.org/web/20260601000000id_/' + domainMove + '/products.json',
  });
  // ④ 单点品牌（只有一个观察点 → 前端不得画趋势）
  const o4 = writeObservation({
    kind: 'flat', compId: compFlat, domain: domainFlat, brandName: 'Doll Forge', price: 64,
    observedAt: '2026-10-10T08:00:00.000Z', sourceKind: 'live_observation',
  });

  // ⑤ 真实跑一次历史回补（archive.org 真实请求；本环境不可达 → 如实终态）
  const job = Store.createBackfillJob({
    tenantId, projectId: projId, competitorId: compMove,
    capability: 'shopify_catalog', from: '2025-10-01', to: '2026-09-30',
  });
  const run = await Backfill.runJob({ tenantId, jobId: job.job.jobId, workerToken: 'e2e-bf' });
  const jobAfter = Store.getBackfillJob(tenantId, job.job.jobId);

  const facts = Store.countFacts(tenantId, projId, compMove);
  const events = Store.listEvents(tenantId, projId, compMove, { limit: 50 });
  console.log('[seed-mem] move brand facts =', facts, 'events =', events.length,
    '(price_changed=' + events.filter(e => e.eventType === 'product_price_changed').length + ')');
  console.log('[seed-mem] flat brand facts =', Store.countFacts(tenantId, projId, compFlat));
  console.log('[seed-mem] backfill =', jobAfter.status, jobAfter.failureClass || '', JSON.stringify(run));

  const out = {
    email: EMAIL, password: PASSWORD, token, tenantId,
    projectId: projId,
    brandMove: bMove.brand.brandId,
    brandFlat: bFlat.brand.brandId,
    expect: {
      moveBrand: 'Puppet Lab',
      flatBrand: 'Doll Forge',
      priceFrom: 110, priceTo: 95,
      backfillStatus: jobAfter.status,
      backfillJobId: job.job.jobId,
    },
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('[seed-mem] wrote', OUT);
  Store.closeDb();
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
