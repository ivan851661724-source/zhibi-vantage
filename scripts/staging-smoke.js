'use strict';
// ============================================================
// scripts/staging-smoke.js —— 测试服真实用户链路冒烟（只走 HTTP，不碰数据库）
// ------------------------------------------------------------
// 用法：
//   node scripts/staging-smoke.js --api http://127.0.0.1:3300 --project projX
//   RESTART_CMD="sudo systemctl restart zhibi-backend zhibi-web" \
//     node scripts/staging-smoke.js --api http://127.0.0.1:3300 --project projX
//
// 检查项：
//   1 注册 / 2 登录 / 3 选择测试项目 / 4 进入竞品数据库触发自动首采 / 5 等待批次终态
//   6 竞品数据库有真实结果 / 7 品牌时间线 / 8 情报收件箱（首采后应为 0）
//   9 证据入口可打开 / 10 服务重启后数据仍在 / 11 两租户隔离
//
// 诚实纪律：任何一项不具备条件（如没有测试项目、没有重启命令）都打印 SKIPPED，
// 绝不用"通过"掩盖未执行。退出码：0 全部通过 / 1 有失败 / 2 有未执行项
// ============================================================
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const argOf = (k, def) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const API = argOf('api', process.env.API_BASE || 'http://127.0.0.1:3300');
const PROJECT = argOf('project', process.env.SMOKE_PROJECT_ID || '');
const EMAIL = argOf('email', process.env.SMOKE_EMAIL || ('smoke' + Date.now() + '@zhibi.test'));
const PASSWORD = argOf('password', process.env.SMOKE_PASSWORD || 'Smoke-passw0rd');
const RESTART_CMD = process.env.RESTART_CMD || '';
const OUT_DIR = argOf('out', path.join(__dirname, '..', '..', '.workbuddy', 'artifacts'));

const results = [];
function rec(name, status, detail) {
  results.push({ name, status, detail: detail == null ? null : String(detail).slice(0, 300) });
  const tag = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
  console.log('[' + tag + '] ' + name + (detail ? ' :: ' + String(detail).slice(0, 200) : ''));
}

async function call(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(API + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = { raw: (text || '').slice(0, 200) }; }
  return { status: r.status, body: json };
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  // 1 注册
  let reg = await call('POST', '/api/register', { email: EMAIL, password: PASSWORD, name: 'Smoke' });
  let tokenA = reg.body && reg.body.token;
  if (!tokenA) {
    // 已存在则直接登录
    const lg = await call('POST', '/api/login', { email: EMAIL, password: PASSWORD });
    tokenA = lg.body && lg.body.token;
    rec('1 注册/登录', tokenA ? 'pass' : 'fail', tokenA ? 'email=' + EMAIL : JSON.stringify(reg.body));
  } else {
    rec('1 注册', 'pass', 'email=' + EMAIL);
  }
  if (!tokenA) return finish();

  // 2 登录（独立确认；凭证绝不打印到日志）
  const lg2 = await call('POST', '/api/login', { email: EMAIL, password: PASSWORD });
  rec('2 登录', lg2.body && lg2.body.token ? 'pass' : 'fail', lg2.body && lg2.body.token ? '登录成功，token 已签发（不打印）' : JSON.stringify(lg2.body).slice(0, 120));

  // 3 选择测试项目
  const pr = await call('GET', '/api/projects', null, tokenA);
  const projects = (pr.body && pr.body.projects) || [];
  let projectId = PROJECT;
  if (!projectId) {
    if (projects.length) projectId = projects[0].id || projects[0].projectId || null;
  }
  if (!projectId) {
    rec('3 选择测试项目', 'skip', '未提供 --project 且该租户无项目；请先准备测试项目（见 runbook）');
    return finish();
  }
  rec('3 选择测试项目', 'pass', 'projectId=' + projectId + '（共 ' + projects.length + ' 个项目）');

  // 4 进入竞品数据库 → 自动首采
  const b1 = await call('GET', '/api/brands?projectId=' + encodeURIComponent(projectId), null, tokenA);
  const brandCount = (b1.body && b1.body.count) || ((b1.body && b1.body.brands) || []).length;
  rec('4 进入竞品数据库触发自动首采', b1.status === 200 ? 'pass' : 'fail', 'HTTP ' + b1.status + '，品牌 ' + brandCount + ' 个');

  // 5 等待批次终态
  let fc = null;
  let waited = 0;
  while (waited < 180000) {
    const s = await call('GET', '/api/first-collection?projectId=' + encodeURIComponent(projectId), null, tokenA);
    fc = (s.body && (s.body.firstCollection || s.body)) || null;
    if (fc && (fc.executionStatus === 'complete' || fc.status === 'complete' || fc.status === 'partial')) break;
    await sleep(3000);
    waited += 3000;
  }
  const terminal = fc && (fc.executionStatus === 'complete' || fc.status === 'complete' || fc.status === 'partial');
  rec('5 首采批次到终态', terminal ? 'pass' : 'fail', JSON.stringify(fc).slice(0, 260));

  // 6 竞品数据库有真实结果
  const b2 = await call('GET', '/api/brands?projectId=' + encodeURIComponent(projectId), null, tokenA);
  const brands = (b2.body && b2.body.brands) || [];
  const withObs = brands.filter(b => b && ((b.collectionDigest && (b.collectionDigest.products || b.collectionDigest.observedCount)) || b.observationCount));
  rec('6 竞品数据库显示真实结果', withObs.length > 0 ? 'pass' : 'fail',
    '品牌 ' + brands.length + ' 个，其中有真实观察 ' + withObs.length + ' 个');

  // 7 品牌时间线
  const brandId = brands.length ? (brands[0].brandId || brands[0].id) : null;
  let tlStatus = 'skip', tlDetail = '无品牌';
  if (brandId) {
    const t = await call('GET', '/api/brands/' + encodeURIComponent(brandId) + '/timeline?projectId=' + encodeURIComponent(projectId), null, tokenA);
    const items = (t.body && (t.body.items || t.body.timeline)) || [];
    tlStatus = t.status === 200 ? 'pass' : 'fail';
    tlDetail = 'HTTP ' + t.status + '，条目 ' + items.length + ' 条';
  }
  rec('7 品牌时间线可读', tlStatus, tlDetail);

  // 8 情报收件箱（首采后应为 0）
  const inbox = await call('GET', '/api/intel/inbox?projectId=' + encodeURIComponent(projectId), null, tokenA);
  const inboxTotal = inbox.body && (inbox.body.total != null ? inbox.body.total : ((inbox.body.groups || []).reduce((n, g) => n + ((g.events || []).length), 0)));
  rec('8 首采后情报收件箱', inboxTotal === 0 ? 'pass' : 'fail', '事件数 ' + inboxTotal + '（首采只建基线，应为 0）');

  // 9 证据入口（品牌列表 API 不暴露 evidence id：由 --evidence 或 SMOKE_EVIDENCE_ID 传入真实 id）
  let evStatus = 'skip', evDetail = '未提供证据 id（--evidence 或 SMOKE_EVIDENCE_ID），未执行';
  const evidenceId = argOf('evidence', process.env.SMOKE_EVIDENCE_ID || '')
    || ((brands[0] && brands[0].collectionDigest && brands[0].collectionDigest.evidenceId) || null);
  if (evidenceId) {
    const e = await call('GET', '/api/evidence-detail?id=' + encodeURIComponent(evidenceId), null, tokenA);
    evStatus = e.status === 200 ? 'pass' : 'fail';
    evDetail = 'HTTP ' + e.status + ' id=' + evidenceId + '，快照 ' + (((e.body && e.body.snapshots) || []).length) + ' 个';
  }
  rec('9 证据入口可打开', evStatus, evDetail);

  // 10 服务重启后数据仍在
  if (!RESTART_CMD) {
    rec('10 重启后数据仍在', 'skip', '未提供 RESTART_CMD 环境变量，本次未执行重启验证');
  } else {
    const { execSync } = require('child_process');
    try { execSync(RESTART_CMD, { stdio: 'ignore' }); } catch (e) { rec('10 重启后数据仍在', 'fail', 'RESTART_CMD 执行失败'); }
    let ok = false;
    for (let i = 0; i < 40; i++) {
      try { const h = await call('GET', '/healthz'); if (h.status === 200) { ok = true; break; } } catch (e) {}
      await sleep(3000);
    }
    if (!ok) rec('10 重启后数据仍在', 'fail', '重启后 /healthz 不可达');
    else {
      const b3 = await call('GET', '/api/brands?projectId=' + encodeURIComponent(projectId), null, tokenA);
      const after = ((b3.body && b3.body.brands) || []).length;
      rec('10 重启后数据仍在', after === brands.length ? 'pass' : 'fail', '重启前 ' + brands.length + ' 个品牌 → 重启后 ' + after + ' 个');
    }
  }

  // 11 两租户隔离
  const emailB = 'smokeb' + Date.now() + '@zhibi.test';
  const regB = await call('POST', '/api/register', { email: emailB, password: PASSWORD, name: 'SmokeB' });
  const tokenB = regB.body && regB.body.token;
  if (!tokenB) rec('11 两租户隔离', 'skip', '第二个租户注册失败');
  else {
    const cross = await call('GET', '/api/brands?projectId=' + encodeURIComponent(projectId), null, tokenB);
    const crossCount = ((cross.body && cross.body.brands) || []).length;
    const forbidden = cross.status === 403 || cross.status === 404 || crossCount === 0;
    rec('11 两租户隔离', forbidden ? 'pass' : 'fail', 'B 租户访问 A 项目：HTTP ' + cross.status + '，品牌 ' + crossCount + ' 个');
  }

  finish();
}

function finish() {
  const failed = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'staging-smoke-result.json'), JSON.stringify({ api: API, at: new Date().toISOString(), results }, null, 2));
  } catch (e) {}
  console.log('\n[smoke] 结果：' + results.length + ' 项，失败 ' + failed + '，未执行 ' + skipped);
  if (failed) process.exit(1);
  if (skipped) process.exit(2);
  process.exit(0);
}

main().catch(e => { console.error('[smoke] 异常：' + String((e && e.message) || e)); process.exit(1); });
