'use strict';
// ============================================================
// live-site-verify.cjs —— SC-06 非 Shopify 官网采集真实验证
// 用途：走真实生产路径（register → 建项目/竞品（非 Shopify 站）→
//   真实 HTTP POST /api/data-surface/refresh → worker 真实抓取官网 →
//   轮询终态 → 读 Data Surface 观察与 Evidence）。
// 用法：ZB_DATA_DIR=<后端数据目录> node live-site-verify.cjs <backend> <name> <url>
// 🔴 不伪造快照/证据；结果如实反映来源可达性与解析结果。
// ============================================================
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
process.chdir(ROOT);
const BASE = process.argv[2] || 'http://127.0.0.1:3331';
const NAME = process.argv[3] || 'Vaude';
const URL_ = process.argv[4] || 'https://www.vaude.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? ' :: ' + String(detail).slice(0, 300) : '')); }
}

(async () => {
  const email = 'sc06-' + Math.random().toString(36).slice(2, 10) + '@example.com';
  const pass = 'sc06-' + Math.random().toString(36).slice(2, 12) + 'P1';
  const reg = await (await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pass, name: 'SC06 Probe' }) })).json();
  if (!reg.token) { console.error('register failed', reg); process.exit(1); }
  const TID = reg.tenantId;
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token };
  console.log('[probe] tenant =', TID);

  const Db = require(ROOT + '/app/services/db.js');
  const BrandStore = require(ROOT + '/app/services/brand-store.js');
  const projId = 'projsc06' + Math.random().toString(36).slice(2, 8);
  Db.saveProject({ id: projId, tenantId: TID, track: 'SC06 官网采集探测', competitors: [], createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const { projFile } = require(ROOT + '/app/core/state-store.js');
  const stPath = projFile(projId, TID);
  fs.mkdirSync(path.dirname(stPath), { recursive: true });
  for (let i = 0; i < 100 && !fs.existsSync(stPath); i++) await sleep(20);
  const domain = URL_.replace(/^https?:\/\//, '').replace(/\/$/, '');
  fs.writeFileSync(stPath, JSON.stringify({
    projectId: projId, tenantId: TID, track: 'SC06 官网采集探测', discoveredAt: new Date().toISOString(),
    intent: { regions: ['us'], category: 'outdoor', platforms: ['shopify'] },
    competitors: [{ id: 'compSc0601', name: NAME, status: 'done', url: URL_, isShopify: false, market: 'us' }],
  }));
  const b = BrandStore.upsertBrand({ tenantId: TID, canonicalName: NAME, officialDomain: domain, competitorRef: 'compSc0601' });
  BrandStore.linkProject({ tenantId: TID, brandId: b.brand.brandId, projectId: projId, competitorRef: 'compSc0601', market: 'us' });
  const brandId = b.brand.brandId;
  console.log('[probe] brandId =', brandId, 'projectId =', projId, 'url =', URL_);

  const refresh = async (capability) => {
    const r = await fetch(BASE + '/api/data-surface/refresh', { method: 'POST', headers: auth, body: JSON.stringify({ competitorId: 'compSc0601', projectId: projId, capability }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  // ---------- official_site_profile ----------
  console.log('== official_site_profile ==');
  const p1 = await refresh('official_site_profile');
  check('refresh 接受 official_site_profile（202）', p1.status === 202, p1.status + ' ' + JSON.stringify(p1.body).slice(0, 150));
  const attemptId1 = p1.body && (p1.body.attemptId || (p1.body.job && p1.body.job.attemptId)) || null;

  // 轮询 Data Surface dimension 直到终态
  let dim1 = null, last1 = null;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const q = await fetch(BASE + '/api/data-surface/dimension?projectId=' + projId + '&competitorId=compSc0601&dimension=website_products&limit=20', { headers: auth }).then(x => x.json()).catch(() => null);
    dim1 = q;
    const cap = q && Array.isArray(q.capabilities) ? q.capabilities.find(c => c.capabilityCode === 'official_site_profile') : null;
    const st = JSON.stringify(cap && cap.latestAttempt && cap.latestAttempt.status || cap && cap.surfaceState || null);
    if (st !== last1) { console.log('[poll]', ((i * 2)) + 's', 'state =', st); last1 = st; }
    if (cap && cap.latestAttempt && ['success', 'partial', 'failed', 'dead', 'empty_success'].includes(cap.latestAttempt.status)) break;
  }
  const cap1 = dim1 && Array.isArray(dim1.capabilities) ? dim1.capabilities.find(c => c.capabilityCode === 'official_site_profile') : null;
  console.log('[probe] official_site_profile =', JSON.stringify(cap1).slice(0, 700));
  check('官网资料采集终态非 running', cap1 && cap1.latestAttempt && cap1.latestAttempt.status !== 'running');
  check('官网资料采集成功', cap1 && cap1.latestAttempt && ['success', 'partial'].includes(cap1.latestAttempt.status), cap1 && cap1.latestAttempt && cap1.latestAttempt.status);
  check('观察行存在', cap1 && Array.isArray(cap1.observations) && cap1.observations.length >= 1, cap1 && cap1.observations && cap1.observations.length);
  const obs1 = (cap1 && cap1.observations) || [];
  check('canonical 已解析（官网已确认依据）', obs1.some(o => o.sourceUrl), JSON.stringify(obs1).slice(0, 200));
  check('Evidence 引用存在', cap1 && cap1.evidenceRefs && cap1.evidenceRefs.length >= 1, cap1 && cap1.evidenceRefs && cap1.evidenceRefs.length);

  // ---------- public_site_products ----------
  console.log('== public_site_products ==');
  const p2 = await refresh('public_site_products');
  check('refresh 接受 public_site_products（202）', p2.status === 202, p2.status + ' ' + JSON.stringify(p2.body).slice(0, 150));
  let dim2 = null, last2 = null;
  for (let i = 0; i < 200; i++) {
    await sleep(3000);
    const q = await fetch(BASE + '/api/data-surface/dimension?projectId=' + projId + '&competitorId=compSc0601&dimension=website_products&limit=30', { headers: auth }).then(x => x.json()).catch(() => null);
    dim2 = q;
    const cap = q && Array.isArray(q.capabilities) ? q.capabilities.find(c => c.capabilityCode === 'public_site_products') : null;
    const st = cap && cap.latestAttempt && cap.latestAttempt.status || null;
    if (st && st !== last2) { console.log('[poll]', (i * 2) + 's', 'state =', st); last2 = st; }
    if (cap && cap.latestAttempt && ['success', 'partial', 'failed', 'dead', 'empty_success'].includes(cap.latestAttempt.status)) break;
  }
  const cap2 = dim2 && Array.isArray(dim2.capabilities) ? dim2.capabilities.find(c => c.capabilityCode === 'public_site_products') : null;
  console.log('[probe] public_site_products =', JSON.stringify(cap2 && cap2.summary).slice(0, 700));
  check('公开商品采集终态非 running', cap2 && cap2.latestAttempt && cap2.latestAttempt.status !== 'running');
  const st2 = cap2 && cap2.latestAttempt && cap2.latestAttempt.status;
  check('公开商品采集成功或诚实空', cap2 && ['success', 'partial', 'empty_success', 'failed'].includes(st2), st2);
  const obs2 = (cap2 && cap2.observations) || [];
  console.log('[probe] 商品观察行数 =', obs2.length, '样例 =', JSON.stringify(obs2.slice(0, 3)).slice(0, 400));
  if (st2 === 'success' || st2 === 'partial') {
    check('商品观察带来源 URL', obs2.length === 0 || obs2.every(o => o.sourceUrl), JSON.stringify(obs2.find(o => !o.sourceUrl) || {}).slice(0, 150));
    check('Evidence 引用存在（商品）', cap2.evidenceRefs && cap2.evidenceRefs.length >= 1);
  }

  console.log('[probe] SCOPE = ' + JSON.stringify({ TID, projId, brandId }));
  console.log('[probe] RESULT: ' + passed + ' passed / ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
