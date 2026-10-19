'use strict';
// E2E 数据准备编排（真实 tenant API + 真实 SQLite 数据，零 mock）：
//   1. 等后端就绪 → 注册/登录（真实 /api/register、/api/login）
//   2. 直插两个项目行（A=3 品牌 / B=1 品牌，node:sqlite 写真实 multitenant.db）
//   3. 子进程服务层直插品牌/证据/时间线（走真值链，见 seed-svc.cjs）
//   4. 项目 A：真实 API 创建报告（POST /api/reports → 202 → 轮询终态），
//      然后把该报告置为 failed（模拟生成失败现场，供「重新生成」用例使用）
//   5. 输出 seed.json（账号 / token / 项目 A、B / 品牌 id / failed 报告 id）
// 用法：node seed.cjs --data-dir <后端 ZB_DATA_DIR> [--backend http://127.0.0.1:3300] [--out seed.json]
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const argv = process.argv.slice(2);
function arg(name, dflt) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; }
const BACKEND_DIR = path.resolve(__dirname, '..', '..');
const DATA_DIR = arg('--data-dir', '');
const BASE = arg('--backend', 'http://127.0.0.1:3300');
const OUT = arg('--out', path.join(__dirname, '.e2e-seed.json'));
if (!DATA_DIR) { console.error('usage: node seed.cjs --data-dir <ZB_DATA_DIR> [--backend url] [--out file]'); process.exit(1); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function api(method, url, body, token) {
  const r = await fetch(url, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { 'Authorization': 'Bearer ' + token } : {}),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
}
function sanitizeNs(x) { return String(x || '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || '_legacy'; }
function projFileName(id) { return String(id).replace(/[^a-z0-9\u4e00-\u9fff-]/gi, '') + '.json'; }
function seedProjectRow(tenantId, projectId, track) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DATA_DIR, 'multitenant.db'));
  const now = new Date().toISOString();
  db.prepare('INSERT INTO projects (id, tenantId, track, competitors, brief, whiteSpace, createdAt, discoveredAt) VALUES (?,?,?,?,?,?,?,?)')
    .run(projectId, tenantId, track, '[]', null, null, now, now);
  db.close();
}

(async () => {
  // 0) 等 server
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(500); try { const r = await fetch(BASE + '/api/version'); up = r.ok; } catch (e) {} }
  if (!up) throw new Error('backend 未就绪: ' + BASE + '（先用 ZB_DATA_DIR 启动 node app/server.js）');

  // 1) 注册（重复运行：随机后缀，天然幂等）
  const EMAIL = 'e2e-ui-' + Date.now().toString(36) + '@example.com', PASSWORD = 'e2e-ui-pass1';
  let reg = await api('POST', BASE + '/api/register', { email: EMAIL, password: PASSWORD, name: 'E2E UI' });
  if (reg.status !== 201) reg = await api('POST', BASE + '/api/login', { email: EMAIL, password: PASSWORD });
  if (!reg.json || !reg.json.token) throw new Error('注册/登录失败: ' + JSON.stringify(reg.json).slice(0, 200));
  const token = reg.json.token, tenantId = reg.json.tenantId;
  console.log('[seed] tenant =', tenantId);

  // 2) 两个项目（A 潮玩手办出海 / B 家居香氛出海——顶部选择器与深链接用例需要可区分的项目）
  const projA = 'proje2a' + Date.now().toString(36);
  const projB = 'proje2b' + Date.now().toString(36);
  seedProjectRow(tenantId, projA, '潮玩手办出海');
  seedProjectRow(tenantId, projB, '家居香氛出海');
  for (const [pid, track] of [[projA, '潮玩手办出海'], [projB, '家居香氛出海']]) {
    const dir = path.join(DATA_DIR, 'research', sanitizeNs(tenantId));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, projFileName(pid)), JSON.stringify({ projectId: pid, tenantId, track, discoveredAt: new Date().toISOString(), intent: { regions: ['us'] }, competitors: [] }), 'utf8');
  }

  // 3) 服务层直插（子进程；WAL 并发安全）
  for (const [pid, flavor] of [[projA, 'full'], [projB, 'minimal']]) {
    const code = await new Promise((res) => {
      const p = spawn(process.execPath, [path.join(__dirname, 'seed-svc.cjs'), BACKEND_DIR, DATA_DIR, tenantId, pid, flavor], { stdio: 'inherit' });
      p.on('exit', res);
    });
    if (code !== 0) throw new Error('seed-svc 失败 exit=' + code + ' pid=' + pid);
  }

  // 4) 项目 A 真实链路校验 + 报告创建 → 终态 → 置 failed
  const brands = await api('GET', BASE + '/api/brands?projectId=' + encodeURIComponent(projA), null, token);
  if (brands.status !== 200 || (brands.json.brands || []).length !== 3) throw new Error('brands API: ' + JSON.stringify(brands.json).slice(0, 200));
  const intel = await api('GET', BASE + '/api/intelligence?projectId=' + encodeURIComponent(projA), null, token);
  if (intel.status !== 200) throw new Error('intelligence API 失败');
  console.log('[seed] 项目A brands=3 intel=' + (intel.json.items || []).length);

  const cr = await api('POST', BASE + '/api/reports', { projectId: projA }, token);
  if (cr.status !== 202 || !cr.json.reportId) throw new Error('报告创建失败: ' + JSON.stringify(cr.json).slice(0, 200));
  const reportId = cr.json.reportId;
  let final = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const r = await api('GET', BASE + '/api/reports/' + encodeURIComponent(reportId), null, token);
    if (r.status === 200 && ['success', 'failed'].includes(r.json.status)) { final = r.json; break; }
  }
  if (!final || final.status !== 'success') throw new Error('报告未达 success 终态: ' + JSON.stringify(final || {}).slice(0, 200));
  console.log('[seed] 报告终态 = success（generatedBy=' + final.generatedBy + ' citations=' + (final.citations || []).length + '）→ 置 failed 演示现场');

  // 置 failed（reports + report_jobs 同步；注入文案注明 e2e 场景，不伪装真实故障）
  // 注意：reports/report_jobs 在 brands.db（R4.5 六表读模型），项目行在 multitenant.db
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(DATA_DIR, 'brands.db'));
  const now = new Date().toISOString();
  db.prepare("UPDATE reports SET status='failed', error_text=?, generated_by=NULL, updated_at=?, finished_at=? WHERE report_id=? AND tenant_id=?")
    .run('e2e 注入失败现场：模拟生成失败，供「重新生成」用例使用', now, now, reportId, tenantId);
  db.prepare("UPDATE report_jobs SET status='dead', last_error='e2e 注入失败现场', done_at=? WHERE report_id=? AND tenant_id=?")
    .run(now, reportId, tenantId);
  const chk = db.prepare('SELECT status FROM reports WHERE report_id=?').get(reportId);
  db.close();
  if (!chk || chk.status !== 'failed') throw new Error('置 failed 失败');
  const brandsB = await api('GET', BASE + '/api/brands?projectId=' + encodeURIComponent(projB), null, token);
  const brandB = (brandsB.json.brands || [])[0] || {};
  if (!brandB.brandId) throw new Error('项目B 品牌缺失');

  // 5) seed.json
  const seed = {
    email: EMAIL, password: PASSWORD, token, tenantId,
    projectA: projA, projectB: projB, trackA: '潮玩手办出海', trackB: '家居香氛出海',
    brandA: brands.json.brands[0].brandId, brandAName: brands.json.brands[0].name,
    brandB: brandB.brandId, failedReportId: reportId,
    generatedBy: final.generatedBy || null,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(seed, null, 2), 'utf8');
  console.log('[seed] seed.json →', OUT);
})().catch(e => { console.error('[seed] FATAL', e && e.stack || e); process.exit(1); });
