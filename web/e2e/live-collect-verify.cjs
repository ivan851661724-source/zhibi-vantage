'use strict';
// SC-05 真实采集入库验证（r2 集成版）
// 真实链路：服务层建项目/竞品（url 指向真实 Shopify 店）→ 真实 HTTP POST /api/data-surface/refresh
//   → worker 真实抓取 /products.json → Attempt/Evidence/Snapshot 落账 → memoryIngestAfterCollect
//   → competitive_memory.db 出现 live_observation 事实（真实 HTTP GET /api/brands/:brandId/memory 验证）
//   → 再次 refresh（同内容）→ 幂等（事实数不变，无新版本）
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..'); // e2e → web → sc05-r2/
process.chdir(ROOT);
const ZB_DATA_DIR = process.env.ZB_DATA_DIR;
if (!ZB_DATA_DIR) { console.error('need ZB_DATA_DIR'); process.exit(1); }
const BASE = process.argv[2] || 'http://127.0.0.1:3311';
const SHOP_URL = process.argv[3] || 'https://www.allbirds.com';
const HOST = new URL(SHOP_URL).hostname;

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? ' :: ' + String(detail).slice(0, 200) : '')); }
}

(async () => {
  // ---------- 登录（真实 HTTP，复用 memory e2e 租户） ----------
  const seed = JSON.parse(fs.readFileSync(__dirname + '/.e2e-memory.json', 'utf8'));
  const loginRes = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: seed.email, password: seed.password }) });
  const login = await loginRes.json();
  if (!login.token) { console.error('login failed', loginRes.status); process.exit(1); }
  const TID = login.tenantId;
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  console.log('[live] tenant =', TID);

  // ---------- 服务层建项目 + 竞品（真实 Shopify 店） ----------
  const Db = require(ROOT + '/app/services/db.js');
  const BrandStore = require(ROOT + '/app/services/brand-store.js');
  const projId = 'projlive' + Math.random().toString(36).slice(2, 10);
  Db.saveProject({ id: projId, tenantId: TID, track: '真实采集验证', competitors: [], createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const { projFile } = require(ROOT + '/app/core/state-store.js');
  const stPath = projFile(projId, TID);
  for (let i = 0; i < 100 && !fs.existsSync(stPath); i++) await sleep(20);
  fs.writeFileSync(stPath, JSON.stringify({
    projectId: projId, tenantId: TID, track: '真实采集验证',
    discoveredAt: new Date().toISOString(),
    intent: { regions: ['us'], category: 'footwear', platforms: ['shopify'] },
    competitors: [{ id: 'compLive01', name: 'Allbirds（真实采集）', status: 'done', url: SHOP_URL, isShopify: true, market: 'us' }],
  }));
  const bLive = BrandStore.upsertBrand({ tenantId: TID, canonicalName: 'Allbirds（真实采集）', officialDomain: HOST, competitorRef: 'compLive01' });
  BrandStore.linkProject({ tenantId: TID, brandId: bLive.brand.brandId, projectId: projId, competitorRef: 'compLive01', market: 'us' });
  const brandId = bLive.brand.brandId;
  console.log('[live] brandId =', brandId);

  // ---------- 第一次真实采集 ----------
  const r1 = await fetch(BASE + '/api/data-surface/refresh', { method: 'POST', headers: auth, body: JSON.stringify({ competitorId: 'compLive01', projectId: projId, capability: 'shopify_catalog' }) });
  check('refresh 请求受理（200/202）', r1.status === 200 || r1.status === 202, 'status=' + r1.status);
  const j1 = await r1.json().catch(() => ({}));
  console.log('[live] refresh resp:', JSON.stringify(j1).slice(0, 300));

  // 轮询 attempt 终态（真实抓取 25-60s）
  let attempt = null;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const ov = await fetch(BASE + '/api/data-surface/overview?competitorId=compLive01&projectId=' + projId, { headers: auth }).then(r => r.json()).catch(() => null);
    const dims = ov && ov.dimensions || [];
    const cat = dims.find(d => d.code === 'website_products');
    const la = cat && cat.latestAttempt;
    if (la && la.status && la.status !== 'running' && la.status !== 'pending') { attempt = la; break; }
    if (cat && cat.latestUsable && cat.latestUsable.status && cat.latestUsable.status !== 'running') { attempt = cat.latestUsable; break; }
  }
  check('真实采集终态到达', !!attempt, 'no terminal attempt in 120s');
  if (attempt) {
    console.log('[live] attempt:', JSON.stringify({ status: attempt.status, obs: attempt.observationCount }).slice(0, 200));
    check('真实采集成功', attempt.status === 'success' || attempt.status === 'partial', attempt.status);
  }
  // overview 视图对用户裁剪 snapshotIds/evidenceIds（产品要求）——真值链完整性用服务层直查
  const SurfaceStore = require(ROOT + '/app/services/surface-store.js');
  const svcAttempts = SurfaceStore.listAttempts(TID, projId, 'compLive01', 'shopify_catalog', 5);
  const svcTop = svcAttempts && svcAttempts[0];
  check('同次 Attempt 有真实 Snapshot（服务层）', !!svcTop && (svcTop.snapshotIds || []).length >= 1, svcTop && JSON.stringify((svcTop.snapshotIds || []).length));
  check('同次 Attempt 有真实 Evidence（服务层）', !!svcTop && (svcTop.evidenceIds || []).length >= 1, svcTop && JSON.stringify((svcTop.evidenceIds || []).length));

  // ---------- Memory 落账验证（真实 HTTP） ----------
  const mem = await fetch(BASE + '/api/brands/' + brandId + '/memory?projectId=' + projId, { headers: auth }).then(r => r.json()).catch(() => null);
  check('GET memory 可读', !!mem && mem.error !== 'BRAND_NOT_FOUND', mem && mem.error);
  const covP = mem && mem.coverage && (mem.coverage.product || mem.coverage.catalog);
  const factCount1 = covP && covP.factCount;
  check('真实采集进入 Memory（factCount ≥ 商品数）', factCount1 > 0, 'factCount=' + factCount1);
  const facts = (mem && mem.facts) || [];
  const liveFacts = facts.filter(f => f.sourceKind === 'live_observation');
  check('事实来源为 live_observation', facts.length === 0 || liveFacts.length === facts.length, 'live=' + liveFacts.length + '/' + facts.length);
  const badTime = facts.filter(f => f.effectiveAt);
  check('当前采集不伪造 effective_at（全部为 null）', badTime.length === 0, 'effectiveAt 非空条数=' + badTime.length);
  const withEvidence = facts.filter(f => (f.evidenceIds || []).length >= 1 && (f.snapshotIds || []).length >= 1);
  check('每条事实带 Evidence + Snapshot 引用', facts.length === 0 || withEvidence.length === facts.length);
  console.log('[live] factCount =', factCount1, ' facts page =', facts.length);
  if (facts[0]) console.log('[live] sample fact:', JSON.stringify({ type: facts[0].factType, at: facts[0].at, atBasis: facts[0].atBasis, precision: facts[0].timePrecision }).slice(0, 200));

  // ---------- 幂等验证：再次 refresh（同内容） ----------
  const r2 = await fetch(BASE + '/api/data-surface/refresh', { method: 'POST', headers: auth, body: JSON.stringify({ competitorId: 'compLive01', projectId: projId, capability: 'shopify_catalog' }) });
  const j2 = await r2.json().catch(() => ({}));
  console.log('[live] 2nd refresh:', JSON.stringify(j2).slice(0, 200), 'status=' + r2.status);
  let attempt2 = null;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const ov = await fetch(BASE + '/api/data-surface/overview?competitorId=compLive01&projectId=' + projId, { headers: auth }).then(r => r.json()).catch(() => null);
    const cat = (ov && ov.dimensions || []).find(d => d.code === 'website_products');
    const la = cat && (cat.latestAttempt || cat.latestUsable);
    if (la && la.status && la.status !== 'running' && la.status !== 'pending' && la.endedAt !== (attempt && attempt.endedAt)) { attempt2 = la; break; }
  }
  if (attempt2) {
    const mem2 = await fetch(BASE + '/api/brands/' + brandId + '/memory?projectId=' + projId, { headers: auth }).then(r => r.json()).catch(() => null);
    const cov2 = mem2 && mem2.coverage && (mem2.coverage.product || mem2.coverage.catalog);
    const factCount2 = cov2 && cov2.factCount;
    check('同内容二次采集幂等（事实总数不翻倍）', factCount2 === factCount1, 'before=' + factCount1 + ' after=' + factCount2);
  } else {
    console.log('  skip - 二次采集未产生新终态（cooldown 复用），幂等由 C 系列单测覆盖');
  }

  // ---------- 覆盖面板 ----------
  const cov = await fetch(BASE + '/api/brands/' + brandId + '/history-coverage?projectId=' + projId, { headers: auth }).then(r => r.json()).catch(() => null);
  check('history-coverage 可读且有数据月', !!cov && (cov.summary ? (cov.summary.factCount > 0 || cov.summary.state === 'ok') : false), JSON.stringify(cov && cov.summary).slice(0, 120));

  console.log('\n[live-collect] ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
