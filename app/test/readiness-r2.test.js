'use strict';
// ============================================================
// readiness-r2.test.js —— Wave 1 整改 r2 回归（任务书 §P0）
//   R1 零泄漏：fetchApiJson 快照 source_url/final_url/返回值/错误响应全链无测试密钥标记
//   R2 脱敏键表：key/api_key/apikey/access_token/token/client_secret/signature 默认覆盖，大小写不敏感
//   R3 readiness 状态机：not_configured → ready_to_verify → operational；失败分类映射
//   R4 refresh 门控：not_configured → 400 SOURCE_NOT_CONFIGURED（无凭据变量名）；凭据齐 → 202 真实发起
//   R5 TikTok：无凭据 CONFIG_MISSING；oauth 401 → attempt failed auth_rejected + readiness 记录；
//      client key 不再冒充 access token；secret 永不落快照
//   R6 用户投影白名单：coverage/constructionDimensions 全 JSON 无环境变量名
// 测试用密钥标记（SECRET-YT-KEY 等）为**测试标记**，非真实凭据。
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-r2-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';

const db = require('../services/db.js');
const Registry = require('../services/capability-registry.js');
const Adapters = require('../services/source-adapter.js');
const SurfaceStore = require('../services/surface-store.js');
const Snapshot = require('../research/source-snapshot.js');
const Net = require('../research/net.js');
const Readiness = require('../services/source-readiness.js');
const { saveState, projFile } = require('../core/state-store.js');

const TID = 'tenant:r2a', PID = 'projR2';
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
}
const MARK = 'SECRET-YT-KEY';

(async () => {
  db.createTenant({ name: 'cr2a', email: 'r2a@example.com' });
  db.saveProject({ id: PID, tenantId: TID, track: 'T-R2', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(PID, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({ projectId: PID, tenantId: TID, track: 'T-R2', discoveredAt: new Date().toISOString(), intent: { regions: ['us'], category: 'toys' }, competitors: [{ id: 'compR2', name: 'R2Brand', status: 'done', url: 'https://r2brand.example.com', isShopify: false }] });
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));

  await t('R2 脱敏键表：默认覆盖 key/api_key/apikey/access_token/token/client_secret/signature/secret/password，大小写不敏感', async () => {
    const u = 'https://api.example.com/x?Key=A&API_KEY=B&ApiKey=C&access_token=D&TOKEN=E&client_secret=F&Signature=G&SECRET=H&Password=I&normal=j';
    const r = Adapters.redactSecretParams(u, []);
    assert.ok(r.includes('normal=j'), '非敏感参数保留');
    for (const k of ['Key', 'API_KEY', 'ApiKey', 'access_token', 'TOKEN', 'client_secret', 'Signature', 'SECRET', 'Password']) {
      assert.ok(r.includes(k + '=%5BREDACTED%5D') || r.includes(k + '=[REDACTED]'), k + ' → [REDACTED]');
    }
    assert.strictEqual(r.split('%5BREDACTED%5D').length - 1, 9, '9 个敏感参数全部脱敏');
    assert.strictEqual(Adapters.SENSITIVE_QUERY_KEYS.includes('key') && Adapters.SENSITIVE_QUERY_KEYS.includes('client_secret') && Adapters.SENSITIVE_QUERY_KEYS.includes('signature'), true, '键表含任务书要求的键');
  });

  await t('R1 零泄漏：带 ?key=SECRET-YT-KEY 的真实形式 URL——快照 source_url/final_url/返回 finalUrl 全链无标记', async () => {
    const origReq = Net.safeRequestOnce;
    const origRecord = Snapshot.record;
    const captured = [];
    try {
      Net.safeRequestOnce = async () => ({
        status: 200, headers: { 'content-type': 'application/json' },
        buffer: Buffer.from('{"items":[]}'),
        url: 'https://www.googleapis.com/youtube/v3/search?part=snippet&key=' + MARK,
      });
      Snapshot.record = (o) => { captured.push(Object.assign({}, o)); return { recorded: true, meta: { snapshot_id: 'snap_r2t' } }; };
      const r = await Adapters.fetchApiJson({
        url: 'https://www.googleapis.com/youtube/v3/search?part=snippet&key=' + MARK,
        capability: 'youtube_content', provider: 'youtube_data_api_v3', secretParams: ['key'], tenantId: TID,
      });
      assert.ok(r.ok, 'fetch 成功');
      assert.ok(!JSON.stringify(r).includes(MARK), '返回对象（含 finalUrl）无标记: ' + r.finalUrl);
      assert.strictEqual(captured.length, 1, '快照已捕获');
      assert.ok(!captured[0].source_url.includes(MARK), 'source_url 脱敏: ' + captured[0].source_url);
      assert.ok(!captured[0].final_url.includes(MARK), 'final_url 脱敏（P0 修复点）: ' + captured[0].final_url);
      assert.ok(captured[0].source_url.includes('%5BREDACTED%5D') || captured[0].source_url.includes('[REDACTED]'), 'source_url 有 REDACTED 标记');
    } finally {
      Net.safeRequestOnce = origReq;
      Snapshot.record = origRecord;
    }
  });

  await t('R1b 错误响应零泄漏：401 路径 errorUserText 为产品化固定文案', async () => {
    const origReq = Net.safeRequestOnce;
    try {
      Net.safeRequestOnce = async () => ({ status: 401, headers: {}, buffer: Buffer.from('{"error":"key invalid ' + MARK + '"}'), url: 'https://www.googleapis.com/youtube/v3/x?key=' + MARK });
      const r = await Adapters.fetchApiJson({ url: 'https://www.googleapis.com/youtube/v3/x?key=' + MARK, capability: 'youtube_content', provider: 'youtube_data_api_v3', secretParams: ['key'], tenantId: TID });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, 'auth_rejected');
      assert.ok(!JSON.stringify(r).includes(MARK), '错误响应无标记');
      assert.ok(!/googleapis|youtube/.test(r.errorUserText), '错误文案不含内部 URL');
    } finally { Net.safeRequestOnce = origReq; }
  });

  await t('R3 readiness 状态机：not_configured → ready_to_verify → operational（verification 持久化、无密钥）', async () => {
    delete process.env.YOUTUBE_API_KEY;
    const r0 = Readiness.getReadiness('youtube_content');
    assert.strictEqual(r0.state, 'not_configured');
    assert.strictEqual(r0.configKeysPresent.YOUTUBE_API_KEY, false, '只显示存在性布尔');
    process.env.YOUTUBE_API_KEY = 'test-key-value-r2';
    const r1 = Readiness.getReadiness('youtube_content');
    assert.strictEqual(r1.state, 'ready_to_verify', '凭据齐 → ready_to_verify');
    Readiness.recordVerification({ capability: 'youtube_content', provider: 'youtube_data_api_v3', status: 'success', tenantId: TID });
    const r2 = Readiness.getReadiness('youtube_content');
    assert.strictEqual(r2.state, 'operational', '真实成功 → operational');
    assert.ok(r2.lastVerifiedAt, 'verification 时间已持久化');
    delete process.env.YOUTUBE_API_KEY;
  });

  await t('R3b 失败分类映射：auth_rejected / quota_exhausted 如实记录（凭据在但服务拒绝）', async () => {
    process.env.TIKTOK_CLIENT_KEY = 'k-r2'; process.env.TIKTOK_CLIENT_SECRET = 's-r2';
    Readiness.recordVerification({ capability: 'tiktok_commercial_content', provider: 'tiktok_research_api', status: 'failed', failureClass: 'quota_exhausted', tenantId: TID });
    const rq = Readiness.getReadiness('tiktok_commercial_content');
    assert.strictEqual(rq.state, 'quota_exhausted', 'quota → quota_exhausted');
    delete process.env.TIKTOK_CLIENT_KEY; delete process.env.TIKTOK_CLIENT_SECRET;
    const rn = Readiness.getReadiness('tiktok_commercial_content');
    assert.strictEqual(rn.state, 'not_configured', '凭据缺失优先（not_configured）');
  });

  await t('R4 refresh 门控：not_configured → 400 SOURCE_NOT_CONFIGURED 且无凭据变量名；用户文案口径', async () => {
    delete process.env.YOUTUBE_API_KEY;
    const H = require('../routes/handlers/data-surface.js');
    const fakeRes = () => { const o = { statusCode: 0, body: null }; o.json = (code, b) => { o.statusCode = code; o.body = b; return o; }; return o; };
    const mkCtx = () => ({ getAuthPayload: () => ({ kind: 'tenant', payload: { tid: TID } }), readBody: async () => ({ competitorId: 'compR2', projectId: PID, capability: 'youtube_content' }), sendJSON: (res, code, b) => res.json(code, b) });
    const resX = fakeRes();
    await H.refresh(mkCtx(), { method: 'POST' }, resX, new URL('http://x/api/data-surface/refresh'), '/api/data-surface/refresh');
    assert.strictEqual(resX.statusCode, 400);
    assert.strictEqual(resX.body.error, 'SOURCE_NOT_CONFIGURED');
    assert.ok(/数据服务暂不可用/.test(resX.body.message), '用户侧四种口径');
    assert.strictEqual(/YOUTUBE_API_KEY|API_KEY/.test(resX.body.message), false, '无凭据变量名');
  });

  await t('R5 TikTok：无凭据 → CONFIG_MISSING 文案无变量名；oauth 401 → attempt failed auth_rejected + readiness 记录', async () => {
    delete process.env.TIKTOK_CLIENT_KEY; delete process.env.TIKTOK_CLIENT_SECRET;
    const SurfaceStoreR = SurfaceStore;
    const BRAND = { name: 'R2Brand', url: 'https://r2brand.example.com', isShopify: false };
    const mkCollect = () => ({
      tenantId: TID, projectId: PID, competitor: BRAND, trigger: 'manual',
      idempotencyKey: 'r2-tt-' + Math.random().toString(36).slice(2, 8), nowMs: Date.now(),
    });
    // 无凭据（config_missing 不在 05 §11 冻结词表——按既有映射落 unavailable，
    // 用户文案如实「数据服务暂不可用」；readiness 查询时凭据缺失优先判 not_configured）
    const a = Adapters.getAdapter('tiktok');
    const c1 = await a.collect(mkCollect());
    assert.strictEqual(c1.attempt.status, 'failed');
    assert.ok(!/TIKTOK_/.test(c1.attempt.errorUserText || ''), '无凭据文案无变量名');
    assert.ok(/数据服务暂不可用/.test(c1.attempt.errorUserText || ''), '用户侧口径');
    // 有凭据 + oauth 401（monkey-patch safeRequestOnce；oauth 请求不落快照）
    process.env.TIKTOK_CLIENT_KEY = 'k-visible'; process.env.TIKTOK_CLIENT_SECRET = 's-secret-value';
    const origReq = Net.safeRequestOnce;
    const capturedUrls = [];
    try {
      Net.safeRequestOnce = async (u) => { capturedUrls.push(String(u)); return { status: 401, headers: {}, buffer: Buffer.from('{"error":"permission denied"}'), url: String(u) }; };
      const c2 = await a.collect(mkCollect());
      assert.strictEqual(c2.attempt.status, 'failed');
      // attempt.errorClass 用 source_status 词表（05 §11 冻结）：oauth 401 → 'blocked'；
      // readiness 层才映射为 auth_rejected（两态语义各自如实）
      assert.strictEqual(c2.attempt.errorClass, 'blocked', 'oauth 401 → blocked 词表');
      assert.ok(!/未观察到广告/.test(c2.attempt.errorUserText || ''), '不伪装无结果');
      const rd = Readiness.getReadiness('tiktok_commercial_content');
      assert.strictEqual(rd.state, 'auth_rejected', 'readiness 如实记录 auth_rejected');
      // 全链无 secret 泄漏（oauth URL 无凭据——凭据在 POST body；body 不进快照/URL）
      for (const u of capturedUrls) assert.ok(!u.includes('s-secret-value') && !u.includes('k-visible'), 'oauth URL 无凭据');
      assert.ok(capturedUrls.every(u => u.startsWith('https://open.tiktokapis.com/')), 'oauth 走官方端点');
    } finally {
      Net.safeRequestOnce = origReq;
      delete process.env.TIKTOK_CLIENT_KEY; delete process.env.TIKTOK_CLIENT_SECRET;
    }
    void SurfaceStoreR;
  });

  await t('R6 用户投影白名单：coverage 维度 / constructionDimensions / opportunity basis 全 JSON 无环境变量名', async () => {
    const BrandSvc = require('../services/brand-service.js');
    const views = BrandSvc.listBrandViews(TID, PID);
    const blob = JSON.stringify(views) + JSON.stringify(BrandSvc.constructionDimensions()) + JSON.stringify(BrandSvc.buildCoverage(TID, PID, views[0] && views[0].id ? views[0].id : views[0]));
    assert.strictEqual(/YOUTUBE_API_KEY|DATAFORSEO_LOGIN|DATAFORSEO_PASSWORD|TIKTOK_CLIENT_KEY|TIKTOK_CLIENT_SECRET|SERPER_API_KEY|TAVILY_API_KEY/.test(blob), false, '用户投影零凭据变量名');
    assert.strictEqual(blob.includes('需要系统数据服务配置'), false, '旧文案不在用户侧（收敛为四种口径）');
  });

  await t('R7 管理员健康接口投影：configKeys 只显存在性布尔，永不显密钥值', async () => {
    process.env.YOUTUBE_API_KEY = 'real-value-should-not-leak';
    const av = Readiness.adminView();
    const yt = av.find(x => x.capability === 'youtube_content');
    assert.ok(yt, 'youtube 在管理员视图');
    assert.strictEqual(yt.readiness, 'operational', '凭据+成功记录 → operational');
    assert.strictEqual(yt.configKeys[0].name, 'YOUTUBE_API_KEY');
    assert.strictEqual(yt.configKeys[0].present, true, '存在性布尔');
    assert.strictEqual(JSON.stringify(av).includes('real-value-should-not-leak'), false, '密钥值零出现');
    delete process.env.YOUTUBE_API_KEY;
  });

  console.log(passed === 8 ? '[readiness-r2] ALL PASS（8/8）' : '[readiness-r2] ' + failed + ' FAIL / ' + passed + ' PASS');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('[readiness-r2] FATAL', e && e.stack || e); process.exit(1); });
