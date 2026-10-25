'use strict';
// ============================================================
// sc10-r2-http.test.js —— SC-10 r2 HTTP 集成测试（真实子进程服务 + 真实 HTTP）
// ------------------------------------------------------------
// 与 sc10-r2.test.js（服务层直调）互补：本文件起**真实后端进程**（独立端口 +
// 独立数据目录），全部断言走真实 HTTP，覆盖任务书两项硬性验收：
//
//   H1 两租户隔离：新注册租户 C 访问租户 A 的项目 → 仅 403/404 通过；
//      200（含空列表）= 隔离失效，必须失败。记录真实 HTTP 状态码。
//   H2 移出品牌不显示（HTTP 投影层）：
//      · 移除前：列表 2 个、详情 200、时间线 200 有 1 条历史；
//      · 移除后：列表剩 1（消失）、详情 404、时间线 404；
//      · 历史保留：品牌记录/时间线索引/竞争记忆仍在（DB 直读），
//        且同一租户另一项目仍可见该品牌与其历史（HTTP 200）；
//      · 重新加入：列表恢复 2、详情 200、时间线仍 1 条（不重复）。
//   H3 冒烟账号与项目租户不一致：staging-smoke.js 子进程退出码必须为 1
//      （显式指定别家租户项目 → 「冒烟账号不能访问该项目」立即失败，不 SKIP）。
//
// 夹具说明（诚实口径）：项目档案由夹具经应用自身模块预置（db.saveProject +
// saveState，与 core-product.test.js 同口径）；「移出品牌」通过改写**项目状态
// 文件**（成员关系事实源）模拟——saveState 的合并语义是并集不会删除成员，
// 故移除只能由事实源文件变更表达（运维/后续移除功能），同步层必须据此回收。
// 全部断言均为真实 HTTP；DB 直读仅用于证明「历史未被删除」。
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

// 数据目录隔离必须先于任何业务模块 require（paths.js 缓存陷阱）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-sc10r2-http-'));
const DATA_DIR = path.join(TMP, 'data');
process.env.ZB_DATA_DIR = DATA_DIR;
process.env.ZB_FIRST_COLLECTION_AUTO = 'off'; // 夹具不触发自动首采批次
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = require('../services/db.js');
const authSvc = require('../services/auth.js');
const BrandStore = require('../services/brand-store.js');
const MemStore = require('../services/competitive-memory-store.js');
const { saveState, projFile } = require('../core/state-store.js');

const ROOT = path.join(__dirname, '..', '..');
const PW_A = 'Passw0rd-tenantA';
const PW_B = 'Passw0rd-tenantB';
const EMAIL_A = 'httpa@zhibi.test';
const EMAIL_B = 'httpb@zhibi.test';

// 夹具竞品（两个项目共享 c1/c2；域名为 fixtures 用示例域，本测试不发起任何外部抓取）
const COMPS = [
  { id: 'cmp-allbirds', name: 'Allbirds', url: 'https://www.allbirds.com', market: 'us', category: 'footwear' },
  { id: 'cmp-tentree', name: 'tentree', url: 'https://www.tentree.com', market: 'us', category: 'apparel' },
];

let passed = 0, failed = 0;
const evidence = {}; // 真实状态码/结果留证（供交付报告引用）
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
}

// ---------------- 基础设施 ----------------
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}
let serverProc = null;
let API = '';
async function startServer() {
  const port = await freePort();
  API = 'http://127.0.0.1:' + port;
  serverProc = spawn(process.execPath, ['app/server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      ZB_DATA_DIR: DATA_DIR,
      SCHEDULER_ENABLED: '0',
      ZB_FIRST_COLLECTION_AUTO: 'off',
      ZB_COLLECT_WORKER_DISABLED: '1',
      ZB_INTENT_SCHEDULER: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  serverProc.stdout.on('data', d => { out += d; });
  serverProc.stderr.on('data', d => { out += d; });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (serverProc.exitCode != null) throw new Error('服务进程提前退出：' + out.slice(-800));
    try {
      const r = await fetch(API + '/healthz');
      if (r.status === 200) return;
    } catch (e) { /* 未起来：重试 */ }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('服务 60s 未就绪：' + out.slice(-800));
}
function stopServer() {
  if (!serverProc) return;
  try { serverProc.kill('SIGTERM'); } catch (e) {}
  serverProc = null;
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
function writeProjState(projectId, tenantId, comps) {
  const f = projFile(projectId, tenantId);
  const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
  cur.competitors = comps;
  fs.writeFileSync(f, JSON.stringify(cur, null, 1));
}

// ---------------- 夹具（服务启动前预置） ----------------
function seedFixture() {
  const tenantA = db.createTenant({ name: 'HttpA', email: EMAIL_A });
  const tenantB = db.createTenant({ name: 'HttpB', email: EMAIL_B });
  db.createUser({ tenantId: tenantA.id, email: EMAIL_A, passwordHash: authSvc.hashPassword(PW_A), role: 'owner' });
  db.createUser({ tenantId: tenantB.id, email: EMAIL_B, passwordHash: authSvc.hashPassword(PW_B), role: 'owner' });

  // 两个项目共享同一批竞品（同租户）：projA1 = 待移除方，projA2 = 保留方
  for (const pid of ['projHttpA1', 'projHttpA2']) {
    db.saveProject({
      id: pid, tenantId: tenantA.id, track: 'T-' + pid, competitors: [],
      brief: null, whiteSpace: null,
      createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString(),
    });
    saveState({
      projectId: pid, tenantId: tenantA.id, track: 'T-' + pid,
      discoveredAt: new Date().toISOString(),
      intent: { regions: ['us'], category: 'footwear' },
      competitors: COMPS.map(c => Object.assign({}, c, { status: 'skeleton', manual: false })),
    });
  }

  // 品牌记录 + 项目链接 + 时间线索引 + 竞争记忆（历史痕迹，移除后必须仍在）
  // 时间线用固定 at：appendTimeline 幂等键为 (tenant, brand, kind, at, ref_id)，
  // 两个项目循环写同一品牌必须去重成 1 条（同时验证索引幂等）。
  const FIXTURE_AT = '2026-10-20T00:00:00.000Z';
  for (const pid of ['projHttpA1', 'projHttpA2']) {
    for (const c of COMPS) {
      const domain = new URL(c.url).hostname.replace(/^www\./, '');
      const { brand } = BrandStore.upsertBrand({
        tenantId: tenantA.id, canonicalName: c.name, officialDomain: domain,
        market: c.market, category: c.category, relation: 'competitor', competitorRef: c.id,
      });
      BrandStore.linkProject({ tenantId: tenantA.id, brandId: brand.brandId, projectId: pid, competitorRef: c.id });
      BrandStore.appendTimeline({
        tenantId: tenantA.id, brandId: brand.brandId, kind: 'product',
        at: FIXTURE_AT, title: '夹具：目录观察', refId: 'fixture-' + c.id,
      });
      // 竞争记忆（timeline 端点的数据源）：每项目每品牌 1 条目录版本
      const ent = MemStore.upsertEntity({
        tenantId: tenantA.id, projectId: pid, competitorId: c.id,
        entityKey: 'catalog', entityType: 'brand_catalog', displayName: c.name,
      });
      MemStore.insertVersion({
        tenantId: tenantA.id, projectId: pid, competitorId: c.id, entityId: ent.entityId,
        sourceKind: 'live_observation', timePrecision: 'day',
        observedAt: new Date().toISOString(), effectiveAt: new Date().toISOString().slice(0, 10),
        normalizedPayload: { productCount: 3, onSaleCount: 3 }, parserVersion: 'fixture-1',
      });
    }
  }
  return { tenantA: tenantA.id, tenantB: tenantB.id };
}

(async () => {
  const ids = seedFixture();
  let tokenA = null, tokenB = null;
  let brandIdC1 = null, brandIdC2 = null;

  await t('H0 夹具预置 + 服务真实启动（独立端口/数据目录）', async () => {
    await startServer();
    assert.ok(API.startsWith('http://127.0.0.1:'), 'API 基址：' + API);
  });

  await t('H1 两租户隔离：新注册租户 C 访问 A 项目，真实 HTTP 状态码必须为 403/404', async () => {
    // 夹具账号登录（A/B）
    const la = await call('POST', '/api/login', { email: EMAIL_A, password: PW_A });
    assert.strictEqual(la.status, 200, 'A 登录失败：HTTP ' + la.status);
    tokenA = la.body.token;
    const lb = await call('POST', '/api/login', { email: EMAIL_B, password: PW_B });
    assert.strictEqual(lb.status, 200, 'B 登录失败：HTTP ' + lb.status);
    tokenB = lb.body.token;

    // 真实注册第三个租户 C（HTTP 注册，非夹具）
    const emailC = 'httpc' + Date.now() + '@zhibi.test';
    const rc = await call('POST', '/api/register', { email: emailC, password: 'Passw0rd-tenantC', name: 'HttpC' });
    assert.strictEqual(rc.status, 201, 'C 注册失败：HTTP ' + rc.status + ' ' + JSON.stringify(rc.body).slice(0, 120));
    const tokenC = rc.body.token;
    assert.ok(tokenC, 'C token 已签发');

    // C 访问 A 的项目（竞品库列表）
    const cross = await call('GET', '/api/brands?projectId=projHttpA1', null, tokenC);
    evidence.crossTenantStatus = cross.status;
    console.log('    [evidence] 跨租户 GET /api/brands 真实 HTTP 状态码 = ' + cross.status);
    assert.ok(cross.status === 403 || cross.status === 404,
      '跨租户访问必须 403/404，实测 ' + cross.status + '（200 含空列表 = 隔离失效）');
    assert.strictEqual(((cross.body && cross.body.brands) || []).length, 0, '跨租户不得返回任何品牌');

    // C 访问 A 的品牌详情（存在性不得泄露）
    const b1 = await call('GET', '/api/brands?projectId=projHttpA1', null, tokenA);
    assert.strictEqual(b1.status, 200, 'A 自己的项目必须 200：HTTP ' + b1.status);
    const firstBrandId = ((b1.body && b1.body.brands) || [])[0].brandId;
    const crossDetail = await call('GET', '/api/brands/' + encodeURIComponent(firstBrandId) + '?projectId=projHttpA1', null, tokenC);
    evidence.crossTenantDetailStatus = crossDetail.status;
    console.log('    [evidence] 跨租户 GET /api/brands/:id 真实 HTTP 状态码 = ' + crossDetail.status);
    assert.ok(crossDetail.status === 403 || crossDetail.status === 404,
      '跨租户品牌详情必须 403/404，实测 ' + crossDetail.status);

    // B（夹具第二租户）同样不得访问 A 的项目
    const crossB = await call('GET', '/api/brands?projectId=projHttpA1', null, tokenB);
    evidence.crossTenantBStatus = crossB.status;
    console.log('    [evidence] 租户 B 访问 A 项目真实 HTTP 状态码 = ' + crossB.status);
    assert.ok(crossB.status === 403 || crossB.status === 404, 'B 访问 A 项目必须 403/404，实测 ' + crossB.status);
  });

  await t('H2a 移除前基线：A 项目 2 品牌、详情 200、时间线 1 条历史', async () => {
    const b = await call('GET', '/api/brands?projectId=projHttpA1', null, tokenA);
    assert.strictEqual(b.status, 200, 'HTTP ' + b.status);
    const brands = b.body.brands || [];
    assert.strictEqual(brands.length, 2, '应 2 个品牌，实测 ' + brands.length);
    const c2 = brands.find(x => x.competitorId === 'cmp-tentree');
    assert.ok(c2, 'cmp-tentree 应在列表中');
    brandIdC2 = c2.brandId;
    brandIdC1 = (brands.find(x => x.competitorId === 'cmp-allbirds') || {}).brandId;

    const det = await call('GET', '/api/brands/' + encodeURIComponent(brandIdC2) + '?projectId=projHttpA1', null, tokenA);
    assert.strictEqual(det.status, 200, '移除前详情必须 200：HTTP ' + det.status);

    const tl = await call('GET', '/api/brands/' + encodeURIComponent(brandIdC2) + '/timeline?projectId=projHttpA1', null, tokenA);
    assert.strictEqual(tl.status, 200, '移除前时间线必须 200：HTTP ' + tl.status);
    assert.strictEqual((tl.body.items || []).length, 1, '移除前时间线应 1 条，实测 ' + (tl.body.items || []).length);
  });

  await t('H2b 移出品牌：列表消失 + 详情 404 + 时间线 404（真实 HTTP）', async () => {
    // 事实源（项目状态文件）中移出 cmp-tentree —— 模拟用户把品牌移出项目
    writeProjState('projHttpA1', ids.tenantA, COMPS.filter(c => c.id !== 'cmp-tentree')
      .map(c => Object.assign({}, c, { status: 'skeleton', manual: false })));

    const b = await call('GET', '/api/brands?projectId=projHttpA1', null, tokenA);
    assert.strictEqual(b.status, 200, 'HTTP ' + b.status);
    const brands = b.body.brands || [];
    evidence.afterRemoveCount = brands.length;
    console.log('    [evidence] 移除后 GET /api/brands 品牌数 = ' + brands.length + '（projectId=projHttpA1）');
    assert.strictEqual(brands.length, 1, '移除后应剩 1 个品牌，实测 ' + brands.length);
    assert.ok(!brands.some(x => x.competitorId === 'cmp-tentree'), 'cmp-tentree 必须从列表消失');

    const det = await call('GET', '/api/brands/' + encodeURIComponent(brandIdC2) + '?projectId=projHttpA1', null, tokenA);
    evidence.afterRemoveDetailStatus = det.status;
    console.log('    [evidence] 移除后品牌详情真实 HTTP 状态码 = ' + det.status);
    assert.strictEqual(det.status, 404, '移除后详情必须 404，实测 ' + det.status);

    const tl = await call('GET', '/api/brands/' + encodeURIComponent(brandIdC2) + '/timeline?projectId=projHttpA1', null, tokenA);
    evidence.afterRemoveTimelineStatus = tl.status;
    console.log('    [evidence] 移除后时间线真实 HTTP 状态码 = ' + tl.status);
    assert.strictEqual(tl.status, 404, '移除后时间线必须 404，实测 ' + tl.status);
  });

  await t('H2c 历史保留：品牌记录/时间线/竞争记忆仍在（DB 直读），其他项目仍可见（HTTP 200）', async () => {
    // DB 直读：品牌记录、时间线索引、竞争记忆均未被删除
    const rec = BrandStore.getBrand(ids.tenantA, brandIdC2);
    assert.ok(rec, '品牌记录必须保留（不得删品牌历史）');
    const tlIdx = BrandStore.listTimeline(ids.tenantA, brandIdC2, { limit: 50 });
    assert.strictEqual(tlIdx.length, 1, '时间线索引必须保留，实测 ' + tlIdx.length);
    const versions = MemStore.listVersions(ids.tenantA, 'projHttpA1', 'cmp-tentree', { limit: 50 });
    assert.strictEqual(versions.length, 1, '竞争记忆版本必须保留，实测 ' + versions.length);
    const links = BrandStore.linksForBrand(ids.tenantA, brandIdC2).map(l => l.projectId).sort();
    evidence.remainingLinks = links;
    console.log('    [evidence] 移除后该品牌剩余项目链接 = ' + JSON.stringify(links));
    assert.deepStrictEqual(links, ['projHttpA2'], '只应剩 projHttpA2 的链接（其他项目链接不得删）');

    // HTTP：另一项目仍可见该品牌及其历史
    const b2 = await call('GET', '/api/brands?projectId=projHttpA2', null, tokenA);
    assert.strictEqual(b2.status, 200, 'HTTP ' + b2.status);
    assert.ok((b2.body.brands || []).some(x => x.competitorId === 'cmp-tentree'), 'projHttpA2 必须仍显示该品牌');
    const tl2 = await call('GET', '/api/brands/' + encodeURIComponent(brandIdC2) + '/timeline?projectId=projHttpA2', null, tokenA);
    assert.strictEqual(tl2.status, 200, '其他项目时间线必须 200：HTTP ' + tl2.status);
    assert.strictEqual((tl2.body.items || []).length, 1, '其他项目历史必须保留，实测 ' + (tl2.body.items || []).length);

    // 未移出的品牌在 projHttpA1 不受影响
    const det1 = await call('GET', '/api/brands/' + encodeURIComponent(brandIdC1) + '?projectId=projHttpA1', null, tokenA);
    assert.strictEqual(det1.status, 200, '未移出品牌详情必须 200：HTTP ' + det1.status);
  });

  await t('H2d 重新加入：列表恢复 + 详情 200 + 历史不重复', async () => {
    // 事实源中重新加入 cmp-tentree
    writeProjState('projHttpA1', ids.tenantA, COMPS.map(c => Object.assign({}, c, { status: 'skeleton', manual: false })));

    const b = await call('GET', '/api/brands?projectId=projHttpA1', null, tokenA);
    assert.strictEqual(b.status, 200, 'HTTP ' + b.status);
    const brands = b.body.brands || [];
    evidence.afterRejoinCount = brands.length;
    console.log('    [evidence] 重新加入后品牌数 = ' + brands.length);
    assert.strictEqual(brands.length, 2, '重新加入后应恢复 2 个，实测 ' + brands.length);

    const det = await call('GET', '/api/brands/' + encodeURIComponent(brandIdC2) + '?projectId=projHttpA1', null, tokenA);
    assert.strictEqual(det.status, 200, '重新加入后详情必须 200：HTTP ' + det.status);

    const tl = await call('GET', '/api/brands/' + encodeURIComponent(brandIdC2) + '/timeline?projectId=projHttpA1', null, tokenA);
    assert.strictEqual(tl.status, 200, 'HTTP ' + tl.status);
    assert.strictEqual((tl.body.items || []).length, 1, '历史必须原样恢复（1 条，不得重复），实测 ' + (tl.body.items || []).length);
    const tlIdx = BrandStore.listTimeline(ids.tenantA, brandIdC2, { limit: 50 });
    assert.strictEqual(tlIdx.length, 1, '时间线索引仍 1 条（幂等），实测 ' + tlIdx.length);
  });

  await t('H3 冒烟账号与项目租户不一致：staging-smoke.js 子进程退出码 1（不 SKIP）', async () => {
    // 用租户 B 的账号冒烟 A 的项目 → 必须立即失败（退出码 1），不得静默跳过
    const outDir = path.join(TMP, 'smoke-out');
    fs.mkdirSync(outDir, { recursive: true });
    const smokePath = path.join(ROOT, 'scripts', 'staging-smoke.js');
    const r = await new Promise(resolve => {
      const p = spawn(process.execPath, [smokePath,
        '--api', API, '--project', 'projHttpA1',
        '--email', EMAIL_B, '--password', PW_B,
        '--out', outDir], { cwd: ROOT, env: process.env });
      let out = '';
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { out += d; });
      p.on('close', code => resolve({ code, out }));
    });
    evidence.smokeMismatchExit = r.code;
    console.log('    [evidence] 冒烟账号/项目租户不一致时子进程退出码 = ' + r.code);
    console.log('    [smoke 输出] ' + r.out.split('\n').filter(l => l.trim()).slice(0, 6).join(' | ').slice(0, 400));
    assert.strictEqual(r.code, 1, '退出码必须为 1（失败），实测 ' + r.code);
    assert.ok(r.out.includes('冒烟账号不能访问该项目'), '输出必须包含租户不一致失败原因');
    assert.ok(!r.out.includes('[SKIP]'), '正式模式不得出现 SKIP');
    // 结果留档（真实状态码进 JSON）
    try {
      const rj = JSON.parse(fs.readFileSync(path.join(outDir, 'staging-smoke-result.json'), 'utf8'));
      evidence.smokeMismatchResult = rj.results[0] || null;
    } catch (e) { /* 留档失败不影响判定 */ }
  });

  // ---------------- 收尾 ----------------
  stopServer();
  console.log('\n[sc10-r2-http] 结果：' + (passed + failed) + ' 项，通过 ' + passed + '，失败 ' + failed);
  console.log('[sc10-r2-http] 真实 HTTP 留证：' + JSON.stringify(evidence));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('[sc10-r2-http] 致命错误：' + String((e && e.stack) || e));
  stopServer();
  process.exit(1);
});
