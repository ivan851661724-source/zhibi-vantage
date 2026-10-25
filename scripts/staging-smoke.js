'use strict';
// ============================================================
// scripts/staging-smoke.js —— 测试服真实用户链路冒烟（只走 HTTP，不碰数据库）
// ------------------------------------------------------------
// 用法：
//   node scripts/staging-smoke.js --api http://127.0.0.1:3300 [--project <id>] [--email <e>] [--password <p>]
//   RESTART_CMD="sudo systemctl restart zhibi-backend zhibi-web" \
//     node scripts/staging-smoke.js --api http://127.0.0.1:3300 --project projX
//
// 环境变量（与命令行等价，命令行优先）：
//   SMOKE_EMAIL / SMOKE_PASSWORD / SMOKE_PROJECT_ID / RESTART_CMD
//   SMOKE_TRACK（未提供项目时，真实调研流程使用的赛道描述）
//   SMOKE_ALLOW_SKIP=1（仅本地排障；正式部署验收不得设置——任一 SKIP 即退出码 2）
//
// 检查项（正式模式：全部必检，任何一项不具备条件都判失败，绝不用 SKIP 掩盖）：
//   1 账号就绪（注册或登录；服务端返回 tenantId）
//   2 登录复核（token 可签发）
//   3 项目就绪：
//     · 显式 --project：必须能访问（HTTP 200）；403/404/其他 → 立即失败
//       （冒烟账号与测试项目必须属于同一租户）；
//     · 未提供：必须通过**真实 HTTP 调研流程**（POST /api/discover）创建项目，
//       禁止直接写数据库制造"用户链路通过"；创建失败 → 立即失败。
//   4 进入竞品数据库触发自动首采（GET /api/brands 200）
//   5 首采批次执行到终态（executionStatus=complete）
//   6 竞品数据库有真实结果（至少一个品牌有真实采集观察）
//   7 品牌时间线可读（HTTP 200）
//   8 首采后情报收件箱 = 0（首采只建基线，不得产生变化事件）
//   9 证据入口可打开：Evidence ID 必须从**真实 API 结果**解析（品牌详情的
//     evidenceRefs），不得人工传入；解析不到或打不开 → 失败
//   10 服务重启后数据仍在（RESTART_CMD 必填；未提供 → 失败）
//   11 两租户隔离：B 租户访问 A 项目，仅 403/404 通过；200（含空列表）→ 失败
//
// 诚实纪律：绝不用"通过"掩盖未执行。退出码：0 全部通过 / 1 有失败 / 2 有未执行项
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
const TRACK = argOf('track', process.env.SMOKE_TRACK || '冒烟测试赛道 ' + new Date().toISOString().slice(0, 10));
const RESTART_CMD = process.env.RESTART_CMD || '';
const ALLOW_SKIP = String(process.env.SMOKE_ALLOW_SKIP || '') === '1';
const OUT_DIR = argOf('out', path.join(__dirname, '..', '..', '.workbuddy', 'artifacts'));
const DISCOVER_TIMEOUT_MS = Math.max(30000, Number(process.env.SMOKE_DISCOVER_TIMEOUT_MS) || 300000);
const BATCH_TIMEOUT_MS = Math.max(30000, Number(process.env.SMOKE_BATCH_TIMEOUT_MS) || 180000);

const results = [];
function rec(name, status, detail) {
  results.push({ name, status, detail: detail == null ? null : String(detail).slice(0, 300) });
  const tag = status === 'pass' ? 'PASS' : status === 'skip' ? 'SKIP' : 'FAIL';
  console.log('[' + tag + '] ' + name + (detail ? ' :: ' + String(detail).slice(0, 200) : ''));
}

// 跨租户隔离判定（SC-10 r2 §三.5）：只有 403/404 算通过；
// 200（哪怕返回空列表）说明隔离失效，必须失败。
function classifyIsolation(httpStatus) {
  return httpStatus === 403 || httpStatus === 404;
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
  // 1 账号就绪（显式凭证或新注册；凭证绝不打印）
  let reg = await call('POST', '/api/register', { email: EMAIL, password: PASSWORD, name: 'Smoke' });
  let tokenA = reg.body && reg.body.token;
  let tenantA = (reg.body && reg.body.tenantId) || null;
  if (!tokenA) {
    // 已存在则直接登录（401 密码错误等真实失败绝不掩盖）
    const lg = await call('POST', '/api/login', { email: EMAIL, password: PASSWORD });
    tokenA = lg.body && lg.body.token;
    tenantA = (lg.body && lg.body.tenantId) || tenantA;
    rec('1 账号就绪（注册/登录）', tokenA ? 'pass' : 'fail',
      tokenA ? '登录既有账号成功（token 已签发，不打印）' : '注册与登录均失败：HTTP ' + lg.status + ' ' + JSON.stringify(lg.body).slice(0, 160));
  } else {
    rec('1 账号就绪（注册）', 'pass', '注册成功（token 已签发，不打印）');
  }
  if (!tokenA) return finish();

  // 2 登录复核
  const lg2 = await call('POST', '/api/login', { email: EMAIL, password: PASSWORD });
  rec('2 登录复核', lg2.body && lg2.body.token ? 'pass' : 'fail',
    lg2.body && lg2.body.token ? '登录成功，token 可重复签发（不打印）' : 'HTTP ' + lg2.status + ' ' + JSON.stringify(lg2.body).slice(0, 120));

  // 3 项目就绪
  let projectId = PROJECT;
  if (projectId) {
    // 显式项目：必须能访问（同租户）。403/404/其他一律立即失败。
    const access = await call('GET', '/api/brands?projectId=' + encodeURIComponent(projectId), null, tokenA);
    if (access.status !== 200) {
      rec('3 项目就绪（显式指定）', 'fail',
        '冒烟账号不能访问该项目（账号与项目须属同一租户）：HTTP ' + access.status + ' ' + JSON.stringify(access.body).slice(0, 160));
      return finish();
    }
    rec('3 项目就绪（显式指定）', 'pass', 'projectId=' + projectId + '，账号可访问（HTTP 200，tenantId=' + (tenantA || '?') + '）');
  } else {
    // 未提供项目：必须走真实 HTTP 调研流程创建（禁止直接写数据库）
    // 注意：/api/discover 在鉴权门后，必须带登录 token（早期版本漏带 → 401 被误报成「密钥未配置」）
    const dc = await call('POST', '/api/discover', { track: TRACK, intent: { regions: ['us'], category: 'general' } }, tokenA);
    const newId = dc.body && (dc.body.projectId || dc.body.sessionId);
    if (dc.status !== 202 || !newId) {
      rec('3 项目就绪（真实调研流程创建）', 'fail',
        '创建项目失败：HTTP ' + dc.status + ' ' + JSON.stringify(dc.body).slice(0, 200)
        + '（未提供 SMOKE_PROJECT_ID 时必须能通过 POST /api/discover 走真实调研流程；服务端可能未配置搜索/LLM 密钥）');
      return finish();
    }
    projectId = newId;
    rec('3 项目就绪（真实调研流程创建）', 'pass', 'POST /api/discover → 202，projectId=' + projectId + '（tenantId=' + (tenantA || '?') + '）');
    // 等待调研产出竞品（项目出现在清单且竞品库非空）
    const deadline = Date.now() + DISCOVER_TIMEOUT_MS;
    let ready = false, lastWhy = '';
    while (Date.now() < deadline) {
      const pr = await call('GET', '/api/projects', null, tokenA);
      const projects = (pr.body && pr.body.projects) || [];
      const mine = projects.find(p => (p.id || p.projectId) === projectId);
      const b = await call('GET', '/api/brands?projectId=' + encodeURIComponent(projectId), null, tokenA);
      const brandCount = (b.body && b.body.count) || ((b.body && b.body.brands) || []).length;
      if (b.status === 200 && brandCount > 0) { ready = true; break; }
      lastWhy = '项目在清单=' + (mine ? '是' : '否') + '，竞品数=' + brandCount;
      await sleep(5000);
    }
    if (!ready) {
      rec('3b 调研流程产出竞品', 'fail', '等待 ' + Math.round(DISCOVER_TIMEOUT_MS / 1000) + 's 后竞品库仍为空（' + lastWhy + '）');
      return finish();
    }
    rec('3b 调研流程产出竞品', 'pass', '竞品库已就绪（' + lastWhy + '）');
  }

  // 4 进入竞品数据库 → 自动首采
  const b1 = await call('GET', '/api/brands?projectId=' + encodeURIComponent(projectId), null, tokenA);
  const brandCount = (b1.body && b1.body.count) || ((b1.body && b1.body.brands) || []).length;
  rec('4 进入竞品数据库触发自动首采', b1.status === 200 ? 'pass' : 'fail', 'HTTP ' + b1.status + '，品牌 ' + brandCount + ' 个');

  // 5 等待首采批次执行终态
  let fc = null;
  const deadline = Date.now() + BATCH_TIMEOUT_MS;
  let sawBatch = false;
  while (Date.now() < deadline) {
    const s = await call('GET', '/api/first-collection?projectId=' + encodeURIComponent(projectId), null, tokenA);
    fc = (s.body && (s.body.firstCollection || s.body)) || null;
    if (fc && fc.batchId) sawBatch = true;
    if (fc && fc.executionStatus === 'complete') break;
    await sleep(3000);
  }
  if (!sawBatch) {
    rec('5 首采批次建立并执行到终态', 'fail', '进入竞品数据库后未建立首采批次（自动首采未生效）：' + JSON.stringify(fc).slice(0, 200));
  } else {
    rec('5 首采批次建立并执行到终态', fc && fc.executionStatus === 'complete' ? 'pass' : 'fail',
      JSON.stringify({ executionStatus: fc && fc.executionStatus, coverageStatus: fc && fc.coverageStatus, counts: fc && fc.counts }).slice(0, 260));
  }

  // 6 竞品数据库有真实结果（至少一个品牌存在真实采集观察）
  const b2 = await call('GET', '/api/brands?projectId=' + encodeURIComponent(projectId), null, tokenA);
  const brands = (b2.body && b2.body.brands) || [];
  const hasReal = (b) => {
    const d = b && b.collectionDigest;
    return !!(d && (d.products || d.reviews || d.social));
  };
  const withObs = brands.filter(hasReal);
  rec('6 竞品数据库显示真实结果', withObs.length > 0 ? 'pass' : 'fail',
    '品牌 ' + brands.length + ' 个，其中有真实采集观察 ' + withObs.length + ' 个（零系统凭据环境下允许部分来源 not_configured，但至少一个来源须真实成功）');

  // 7 品牌时间线可读
  const brandId = brands.length ? (brands[0].brandId || brands[0].id) : null;
  let tlStatus = 'fail', tlDetail = '无品牌可读时间线';
  if (brandId) {
    const t = await call('GET', '/api/brands/' + encodeURIComponent(brandId) + '/timeline?projectId=' + encodeURIComponent(projectId), null, tokenA);
    tlStatus = t.status === 200 ? 'pass' : 'fail';
    tlDetail = 'HTTP ' + t.status + '，state=' + ((t.body && t.body.state) || '?');
  }
  rec('7 品牌时间线可读', tlStatus, tlDetail);

  // 8 情报收件箱（首采后应为 0：首采只建基线，不产变化事件）
  const inbox = await call('GET', '/api/intel/inbox?projectId=' + encodeURIComponent(projectId), null, tokenA);
  const inboxTotal = inbox.body && (inbox.body.total != null ? inbox.body.total : ((inbox.body.groups || []).reduce((n, g) => n + ((g.events || []).length), 0)));
  rec('8 首采后情报收件箱', inbox.status === 200 && inboxTotal === 0 ? 'pass' : 'fail',
    'HTTP ' + inbox.status + '，事件数 ' + inboxTotal + '（首采只建基线，应为 0）');

  // 9 证据入口：Evidence ID 必须从真实 API 结果解析（品牌详情的 evidenceRefs）
  let evidenceId = null;
  if (brandId) {
    const det = await call('GET', '/api/brands/' + encodeURIComponent(brandId) + '?projectId=' + encodeURIComponent(projectId), null, tokenA);
    const body = det.body || {};
    const refs = []
      .concat((body.products && body.products.evidenceRefs) || []);
    for (const dim of Object.keys(body.dimensionDetails || {})) {
      const dd = body.dimensionDetails[dim] || {};
      for (const r of (dd.evidenceRefs || [])) refs.push(r);
    }
    for (const r of refs) { if (r && r.evidenceId) { evidenceId = r.evidenceId; break; } }
  }
  if (!evidenceId) {
    rec('9 证据入口可打开', 'fail', '无法从真实 API 结果解析 Evidence ID（品牌详情无 evidenceRefs；正式部署模式下不得跳过）');
  } else {
    const e = await call('GET', '/api/evidence-detail?id=' + encodeURIComponent(evidenceId), null, tokenA);
    rec('9 证据入口可打开', e.status === 200 ? 'pass' : 'fail',
      'HTTP ' + e.status + ' id=' + evidenceId + '（来自真实 API 解析），快照 ' + (((e.body && e.body.snapshots) || []).length) + ' 个');
  }

  // 10 服务重启后数据仍在（部署验收必检项）
  if (!RESTART_CMD) {
    rec('10 重启后数据仍在', ALLOW_SKIP ? 'skip' : 'fail', '未提供 RESTART_CMD 环境变量（部署验收必检项；正式模式不得跳过）');
  } else {
    const { execSync } = require('child_process');
    let restartOk = true;
    try { execSync(RESTART_CMD, { stdio: 'ignore' }); } catch (e) { restartOk = false; rec('10 重启后数据仍在', 'fail', 'RESTART_CMD 执行失败'); }
    if (restartOk) {
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
  }

  // 11 两租户隔离（新租户 B 访问 A 的项目）
  const emailB = 'smokeb' + Date.now() + '@zhibi.test';
  const regB = await call('POST', '/api/register', { email: emailB, password: PASSWORD, name: 'SmokeB' });
  const tokenB = regB.body && regB.body.token;
  if (!tokenB) rec('11 两租户隔离', 'fail', '第二个租户注册失败：HTTP ' + regB.status);
  else {
    const cross = await call('GET', '/api/brands?projectId=' + encodeURIComponent(projectId), null, tokenB);
    const crossCount = ((cross.body && cross.body.brands) || []).length;
    const isolated = classifyIsolation(cross.status);
    rec('11 两租户隔离', isolated ? 'pass' : 'fail',
      'B 租户访问 A 项目：HTTP ' + cross.status + '，品牌 ' + crossCount + ' 个'
      + (isolated ? '' : '（200 含空列表 = 隔离失效，必须失败）'));
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

module.exports = { classifyIsolation };

if (require.main === module) {
  main().catch(e => { console.error('[smoke] 异常：' + String((e && e.message) || e)); process.exit(1); });
}
