'use strict';
// ============================================================
// product-events.test.js —— 产品行为事件端点测试（handler 级，零网络）
// 覆盖：
//   A. POST /api/events/product：未登录 403、白名单校验、
//      请求体多余内容（note/body/text）与明文对象 id 不落库
//   B. GET /api/admin/observability/summary：无 token 401、
//      携带有效 platform_admin token → 200 且样本不足显式 insufficient_sample
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 数据目录隔离必须先于任何业务模块 require（paths.js 缓存陷阱）
process.env.ZB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-pe-test-'));
process.env.OBS_DB_PATH = path.join(process.env.ZB_DATA_DIR, 'obs.sqlite');
process.env.MT_STORE_PATH = path.join(process.env.ZB_DATA_DIR, 'mt.db');

const ObsH = require('../routes/handlers/observability.js');
const Telemetry = require('../observability/telemetry.js');
const auth = require('../services/auth.js');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}

// —— handler 级假 ctx/res：sendJSON 与原生 writeHead 统一捕获 ——
function makeRes() {
  const cap = { status: 0, json: null };
  cap.writeHead = (code) => { cap.status = code; };
  cap.end = (body) => { try { cap.json = JSON.parse(body); } catch { cap.raw = body; } };
  return cap;
}
function makeCtx(authPayload, body) {
  return {
    getAuthPayload: () => authPayload,
    readBody: async () => body,
    sendJSON: (res, code, obj) => { res.status = code; res.json = obj; },
  };
}
const URL_P = new URL('http://x/api/events/product');
const URL_S = new URL('http://x/api/admin/observability/summary?window_hours=24');

(async () => {

await t('A1 未登录 → 403，不落任何事件', async () => {
  const res = makeRes();
  const handled = await ObsH.productEvent(makeCtx(null, { eventType: 'intelligence_viewed' }),
    { method: 'POST' }, res, URL_P, '/api/events/product');
  assert.strictEqual(handled, true, '已处理');
  assert.strictEqual(res.status, 403, '403');
  const db = new (require('node:sqlite').DatabaseSync)(process.env.OBS_DB_PATH);
  const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_events'").get();
  const n = hasTable ? db.prepare('SELECT COUNT(*) AS n FROM product_events').get().n : 0;
  db.close();
  assert.strictEqual(n, 0, '未落任何事件');
});

await t('A2 白名单事件接收；projectId 归属校验通过；正文/备注与明文对象 id 不落库', async () => {
  // 审核整改 §三：projectId 需归属校验 → 先为该租户预置真实项目
  require('../services/db.js').saveProject({
    id: 'proj-1', tenantId: 'tenant:pe-user', track: '赛道A',
    competitors: [], brief: null, whiteSpace: null,
    createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString(),
  });
  const res = makeRes();
  const handled = await ObsH.productEvent(
    makeCtx({ kind: 'tenant', payload: { tid: 'tenant:pe-user' } }, {
      eventType: 'opportunity_viewed', objectType: 'page', objectId: 'opp_page_1', projectId: 'proj-1',
      note: 'USER-NOTE-XYZ', userInput: 'USER-INPUT-XYZ', evidenceText: 'USER-EVIDENCE-XYZ',
    }),
    { method: 'POST' }, res, URL_P, '/api/events/product');
  assert.strictEqual(handled, true);
  assert.strictEqual(res.status, 200, '200');
  assert.strictEqual(res.json.ok, true, '记录成功');
  const db = new (require('node:sqlite').DatabaseSync)(process.env.OBS_DB_PATH);
  const rows = db.prepare('SELECT * FROM product_events').all();
  db.close();
  const blob = JSON.stringify(rows);
  for (const bad of ['USER-NOTE-XYZ', 'USER-INPUT-XYZ', 'USER-EVIDENCE-XYZ', 'opp_page_1', 'pe-user']) {
    assert.ok(!blob.includes(bad), '不落用户内容/明文标识: ' + bad);
  }
  assert.ok(blob.includes('opportunity_viewed'), '事件类型（受控枚举）明文存在');
});

await t('A3 非白名单事件 → 400 UNSUPPORTED_EVENT', async () => {
  const res = makeRes();
  await ObsH.productEvent(makeCtx({ kind: 'tenant', payload: { tid: 'tenant:pe-user' } }, { eventType: 'keystroke_log', note: 'X' }),
    { method: 'POST' }, res, URL_P, '/api/events/product');
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.json.error, 'UNSUPPORTED_EVENT');
});

await t('A4 跨租户伪造 projectId → 404 拒绝且不写库（审核整改 §三）', async () => {
  // 预置另一个租户的项目；attacker 冒用其 projectId
  require('../services/db.js').saveProject({
    id: 'proj-victim', tenantId: 'tenant:victim', track: '别人赛道',
    competitors: [], brief: null, whiteSpace: null,
    createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString(),
  });
  const db = new (require('node:sqlite').DatabaseSync)(process.env.OBS_DB_PATH);
  const before = db.prepare('SELECT COUNT(*) AS n FROM product_events').get().n;
  db.close();
  const res = makeRes();
  const handled = await ObsH.productEvent(
    makeCtx({ kind: 'tenant', payload: { tid: 'tenant:attacker' } }, {
      eventType: 'intelligence_viewed', projectId: 'proj-victim',
    }),
    { method: 'POST' }, res, URL_P, '/api/events/product');
  assert.strictEqual(handled, true);
  assert.strictEqual(res.status, 404, '伪造 projectId 被拒绝');
  assert.strictEqual(res.json.error, 'PROJECT_NOT_FOUND', '受控错误码（不泄露存在性）');
  const db2 = new (require('node:sqlite').DatabaseSync)(process.env.OBS_DB_PATH);
  const after = db2.prepare('SELECT COUNT(*) AS n FROM product_events').get().n;
  db2.close();
  assert.strictEqual(after, before, '拒绝时不写库');
  // 不存在的 projectId 同样 404
  const res2 = makeRes();
  await ObsH.productEvent(makeCtx({ kind: 'tenant', payload: { tid: 'tenant:pe-user' } },
    { eventType: 'intelligence_viewed', projectId: 'proj-nonexistent' }),
    { method: 'POST' }, res2, URL_P, '/api/events/product');
  assert.strictEqual(res2.status, 404, '不存在的项目同样拒绝');
});

await t('B1 管理统计接口：无 token → 401', async () => {
  const res = makeRes();
  const handled = await ObsH.adminSummary(makeCtx(null, null), { method: 'GET', headers: {} }, res, URL_S, '/api/admin/observability/summary');
  assert.strictEqual(handled, true);
  assert.strictEqual(res.status, 401, '401');
});

await t('B2 platform_admin token → 200，样本不足显式 insufficient_sample', async () => {
  const token = auth.issueAdminToken('admin-tester', 'platform_admin');
  const res = makeRes();
  const handled = await ObsH.adminSummary(makeCtx(null, null),
    { method: 'GET', headers: { authorization: 'Bearer ' + token } }, res, URL_S, '/api/admin/observability/summary');
  assert.strictEqual(handled, true);
  assert.strictEqual(res.status, 200, '200');
  assert.strictEqual(res.json.status, 'insufficient_sample', '空库显式 insufficient_sample');
  assert.strictEqual(res.json.stages.translate, 'insufficient_sample', '阶段门控');
  assert.ok(res.json.sample && typeof res.json.sample.runs === 'number', 'sample 元信息');
});

console.log(failed ? `\nproduct-events.test: ${failed} failed` : '\nproduct-events.test: all passed');
if (failed) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
