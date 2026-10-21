'use strict';
// ============================================================
// archive-diagnose.cjs —— 存档回补通道诊断工具（r3）
// 用途：在任一可运行后端的机器上，真实复现 history-backfill 生产路径
//   （真实 HTTP 提交 → 持久任务 → worker → CDX/存档抓取），并打印失败分类/
//   计数/覆盖状态。用于判断「环境不可达」与「代码缺陷」。
// 用法：ZB_DATA_DIR=<后端数据目录> node archive-diagnose.cjs <backend> [domain]
// 🔴 仅诊断：不伪造任何快照/证据；结果如实反映来源可达性。
// ============================================================
// 环境诊断：真实复现生产回补路径，核验失败分类是否准确（排除代码缺陷）
// 路径：真实 /api/register → 服务层建项目/竞品 → 真实 HTTP POST /api/brands/:brandId/history-backfill
//      → worker 真实 CDX 请求 → 轮询终态 → 读 history-coverage 与 memory
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
process.chdir(ROOT);
const BASE = process.argv[2] || 'http://127.0.0.1:3321';
const DOMAIN = process.argv[3] || 'allbirds.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const email = 'arch-' + Math.random().toString(36).slice(2, 10) + '@example.com';
  const pass = 'arch-' + Math.random().toString(36).slice(2, 12) + 'P1';
  const reg = await (await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pass, name: 'Archive Probe' }) })).json();
  if (!reg.token) { console.error('register failed', reg); process.exit(1); }
  const TID = reg.tenantId;
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token };
  console.log('[probe] tenant =', TID);

  const Db = require(ROOT + '/app/services/db.js');
  const BrandStore = require(ROOT + '/app/services/brand-store.js');
  const projId = 'projarch' + Math.random().toString(36).slice(2, 8);
  Db.saveProject({ id: projId, tenantId: TID, track: '存档探测', competitors: [], createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const { projFile } = require(ROOT + '/app/core/state-store.js');
  const stPath = projFile(projId, TID);
  fs.mkdirSync(path.dirname(stPath), { recursive: true });
  for (let i = 0; i < 100 && !fs.existsSync(stPath); i++) await sleep(20);
  fs.writeFileSync(stPath, JSON.stringify({
    projectId: projId, tenantId: TID, track: '存档探测', discoveredAt: new Date().toISOString(),
    intent: { regions: ['us'], category: 'footwear', platforms: ['shopify'] },
    competitors: [{ id: 'compArch01', name: 'Allbirds', status: 'done', url: 'https://www.' + DOMAIN, isShopify: true, market: 'us' }],
  }));
  const b = BrandStore.upsertBrand({ tenantId: TID, canonicalName: 'Allbirds', officialDomain: DOMAIN, competitorRef: 'compArch01' });
  BrandStore.linkProject({ tenantId: TID, brandId: b.brand.brandId, projectId: projId, competitorRef: 'compArch01', market: 'us' });
  const brandId = b.brand.brandId;
  console.log('[probe] brandId =', brandId, 'projectId =', projId);

  const t0 = Date.now();
  const r = await fetch(BASE + '/api/brands/' + brandId + '/history-backfill', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ projectId: projId, from: '2024-01-01', to: '2024-12-31' }),
  });
  const j = await r.json().catch(() => ({}));
  console.log('[probe] submit status =', r.status, JSON.stringify(j).slice(0, 300));
  const jobId = j.job && (j.job.jobId || j.job.id) || j.jobId;
  if (!jobId) { console.error('no job id'); process.exit(1); }

  // 立即重复提交同范围 → 应幂等复用
  const r2 = await fetch(BASE + '/api/brands/' + brandId + '/history-backfill', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ projectId: projId, from: '2024-01-01', to: '2024-12-31' }),
  });
  const j2 = await r2.json().catch(() => ({}));
  const jobId2 = j2.job && (j2.job.jobId || j2.job.id) || j2.jobId;
  console.log('[probe] duplicate submit: same job?', jobId2 === jobId, 'jobId2 =', jobId2, 'deduped =', j2.deduped);

  let job = null, last = null;
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const q = await fetch(BASE + '/api/history-backfill/' + jobId, { headers: auth });
    job = await q.json().catch(() => null);
    const st = job && (job.job ? job.job.status : job.status);
    if (st !== last) { console.log('[probe]', ((Date.now() - t0) / 1000).toFixed(0) + 's', 'status =', st); last = st; }
    if (['done', 'partial', 'failed', 'dead', 'source_unavailable', 'no_archive_record'].includes(st)) break;
  }
  console.log('[probe] FINAL job =', JSON.stringify(job).slice(0, 900));

  const cov = await fetch(BASE + '/api/brands/' + brandId + '/history-coverage?projectId=' + projId, { headers: auth }).then(x => x.json()).catch(() => null);
  console.log('[probe] coverage.summary =', JSON.stringify(cov && cov.summary).slice(0, 400));
  console.log('[probe] coverage.months sample =', JSON.stringify((cov && (cov.months || cov.points) || []).slice(0, 3)).slice(0, 400));
  const mem = await fetch(BASE + '/api/brands/' + brandId + '/memory?projectId=' + projId, { headers: auth }).then(x => x.json()).catch(() => null);
  console.log('[probe] memory state =', mem && mem.state, 'coverage =', JSON.stringify(mem && mem.coverage).slice(0, 300));
  const tl = await fetch(BASE + '/api/brands/' + brandId + '/timeline?projectId=' + projId, { headers: auth }).then(x => x.json()).catch(() => null);
  console.log('[probe] timeline items =', tl && (tl.items || []).length, 'state =', tl && tl.state);
  console.log('[probe] SCOPE = ' + JSON.stringify({ TID, projId, brandId, jobId }));
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
