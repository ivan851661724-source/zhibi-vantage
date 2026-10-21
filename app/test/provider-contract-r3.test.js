'use strict';
// ============================================================
// provider-contract-r3.test.js —— Wave 1 整改 r3 回归
//   T1 TikTok 请求构造：OAuth（form-urlencoded + client_credentials）与
//      Query Ads（/v2/research/adlib/ad/query/?fields= + Authorization: Bearer +
//      官方 body 形状）逐字段断言；旧契约（business-api / access-token /
//      {keyword,page,limit}）零残留
//   T2 零泄漏：client key / client secret / access token 不进入 URL、Snapshot、
//      Evidence、Verification、日志、attempt
//   T3 HTTP 200 + 业务错误对象（error.code 非 ok）→ 不得进入成功链 / 不得 operational
//   T4 合法零结果（error.code=ok + data.ads=[]）→ 成功 + 「本轮未观察到结果」语义
//   T5 P0-1：recordVerification 传未脱敏 sourceUrl → SQLite/admin 零密钥；文本脱敏兜底
//   T6 DataForSEO HTTP 200 + task 业务失败 → 不 operational
//   T7 YouTube HTTP 200 + error 对象 → 不进入成功链
// 测试用值为**测试标记**，非真实凭据。
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-r3-'));
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
const ProviderResponse = require('../lib/provider-response.js');
const UrlRedact = require('../lib/url-redact.js');
const TikTokAdLib = require('../lib/tiktok-adlib.js');
const { saveState, projFile } = require('../core/state-store.js');

const TID = 'tenant:r3a', PID = 'projR3';
const KEY = 'TEST-CLIENT-KEY-r3';
const SECRET = 'TEST-CLIENT-SECRET-r3';
const TOKEN = 'TEST-ACCESS-TOKEN-r3';
const SENTINEL = 'SECRET-TOKEN';
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
}
const BRAND = { name: 'R3Brand', url: 'https://r3brand.example.com', isShopify: false };
const mkCtx = (tag) => ({
  tenantId: TID, projectId: PID, competitor: BRAND, trigger: 'manual',
  idempotencyKey: 'r3-' + tag + '-' + Math.random().toString(36).slice(2, 8), nowMs: Date.now(),
});

(async () => {
  db.createTenant({ name: 'cr3a', email: 'r3a@example.com' });
  db.saveProject({ id: PID, tenantId: TID, track: 'T-R3', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(PID, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({ projectId: PID, tenantId: TID, track: 'T-R3', discoveredAt: new Date().toISOString(), intent: { regions: ['us'], category: 'toys' }, competitors: [{ id: 'compR3', name: BRAND.name, status: 'done', url: BRAND.url, isShopify: false }] });
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));

  process.env.TIKTOK_CLIENT_KEY = KEY;
  process.env.TIKTOK_CLIENT_SECRET = SECRET;

  const calls = [];
  const origReq = Net.safeRequestOnce;
  // 可切换的 stub：oauth 成功 + ad query 由 scenario 决定
  let adScenario = 'success';
  Net.safeRequestOnce = async (u, opt) => {
    const url = String(u);
    calls.push({ url, opt: opt || {} });
    const json = (obj, status) => ({ status: status || 200, headers: { 'content-type': 'application/json' }, buffer: Buffer.from(JSON.stringify(obj)), url });
    if (url.indexOf('/v2/oauth/token/') >= 0) return json({ access_token: TOKEN, expires_in: 7200, token_type: 'Bearer' });
    if (url.indexOf('/v2/research/adlib/ad/query/') >= 0) {
      if (adScenario === 'biz_error') return json({ error: { code: 'access_token_invalid', http_status_code: 200, message: 'invalid token' } });
      if (adScenario === 'empty_ok') return json({ data: { ads: [], has_more: false, search_id: 'sid-empty' }, error: { code: 'ok', http_status_code: 200, message: '' } });
      return json({
        data: {
          ads: [{
            ad: { id: 1923845247192304, first_shown_date: 20250101, last_shown_date: 20250120, status: 'active', videos: [{ url: 'https://cdn.example.com/v.mp4' }], image_urls: ['https://cdn.example.com/i.jpg'], reach: { unique_user_seen: '11K' } },
            advertiser: { business_id: 3847236290405, business_name: 'Awe Food Co.', paid_for_by: 'Awe Co.' },
          }],
          has_more: false, search_id: 'sid-ok',
        },
        error: { code: 'ok', http_status_code: 200, log_id: 'log-1', message: '' },
      });
    }
    return json({ error: { code: String(404) } }, 404);
  };

  try {
    await t('T1 TikTok 请求构造：OAuth form-urlencoded + Query Ads 官方契约（URL/Bearer/body 逐字段）', async () => {
      calls.length = 0;
      adScenario = 'success';
      const a = Adapters.getAdapter('tiktok');
      const r = await a.collect(mkCtx('t1'));
      assert.strictEqual(r.attempt.status, 'success', '真实成功 attempt：' + JSON.stringify(r.attempt && r.attempt.errorClass));
      const oauth = calls.find(c => c.url.indexOf('/v2/oauth/token/') >= 0);
      assert.ok(oauth, 'OAuth 请求已发出');
      assert.strictEqual(oauth.url, 'https://open.tiktokapis.com/v2/oauth/token/', 'OAuth 端点');
      assert.strictEqual(oauth.opt.method, 'POST');
      assert.strictEqual(oauth.opt.headers['Content-Type'], 'application/x-www-form-urlencoded');
      const form = new URLSearchParams(oauth.opt.body);
      assert.strictEqual(form.get('grant_type'), 'client_credentials');
      assert.strictEqual(form.get('client_key'), KEY);
      assert.strictEqual(form.get('client_secret'), SECRET);
      assert.ok(oauth.url.indexOf(KEY) < 0 && oauth.url.indexOf(SECRET) < 0, 'OAuth URL 无凭据');
      const ad = calls.find(c => c.url.indexOf('/v2/research/adlib/ad/query/') >= 0);
      assert.ok(ad, '广告查询请求已发出');
      assert.ok(ad.url.startsWith('https://open.tiktokapis.com/v2/research/adlib/ad/query/?fields='), 'Query Ads 端点: ' + ad.url.slice(0, 80));
      assert.strictEqual(ad.opt.method, 'POST');
      assert.strictEqual(ad.opt.headers.Authorization, 'Bearer ' + TOKEN, 'Authorization: Bearer');
      assert.strictEqual(ad.opt.headers['Content-Type'], 'application/json');
      assert.ok(!('access-token' in ad.opt.headers), '不得使用 access-token header');
      assert.ok(ad.url.indexOf(TOKEN) < 0, 'token 不进 URL');
      const fields = new URL(ad.url).searchParams.get('fields').split(',');
      const ALLOWED = ['ad.id', 'ad.first_shown_date', 'ad.last_shown_date', 'ad.status', 'ad.status_statement', 'ad.videos', 'ad.image_urls', 'ad.reach', 'advertiser.business_id', 'advertiser.business_name', 'advertiser.paid_for_by'];
      for (const fl of fields) assert.ok(ALLOWED.includes(fl), 'fields 白名单内: ' + fl);
      // R4.14：实际请求 = 官方白名单全量（11 项），不再是「白名单 11 而请求 10」
      assert.strictEqual(fields.length, TikTokAdLib.AD_FIELD_COUNT, 'URL fields 数 = 唯一事实源字段数');
      assert.strictEqual(fields.length, ALLOWED.length, 'URL fields 数 = 官方文档白名单数');
      assert.deepStrictEqual(fields, TikTokAdLib.AD_FIELDS.slice(), '请求字段顺序与事实源一致');
      const body = JSON.parse(ad.opt.body);
      assert.deepStrictEqual(Object.keys(body).sort(), ['filters', 'max_count', 'search_term'], 'body 只含官方字段');
      assert.ok(!('keyword' in body) && !('page' in body) && !('limit' in body), '旧 body 形状零残留');
      const range = body.filters.ad_published_date_range;
      assert.ok(/^\d{8}$/.test(range.min) && /^\d{8}$/.test(range.max), 'YYYYMMDD 日期');
      assert.ok(Number(range.min) > 20221001, 'min 晚于 2022-10-01（官方约束）');
      assert.strictEqual(body.search_term, BRAND.name);
      assert.ok(body.max_count <= 50, 'max_count ≤ 50');
      // 响应真实字段映射
      const obs = r.attempt.observations[0];
      assert.strictEqual(obs.id, '1923845247192304');
      assert.strictEqual(obs.advertiser, 'Awe Food Co.');
      assert.strictEqual(String(obs.publishedAt), '20250101');
      assert.strictEqual(obs.creativeUrl, 'https://cdn.example.com/i.jpg');
      assert.strictEqual(obs.reach, '11K', 'reach 用官方区间标签');
      assert.strictEqual(obs.price, null, '广告花费恒 null');
      assert.strictEqual(r.attempt.summary.measurementMethod, 'official_disclosure', '平台公开披露');
      assert.ok(new RegExp(TikTokAdLib.COUNTRY_COUNT + ' 国').test(r.attempt.summary.coverageNote), '覆盖范围数量与官方列表一致');
      assert.strictEqual(r.attempt.summary.coverageCountryCount, TikTokAdLib.COUNTRY_COUNT, '摘要投影国家数 = 唯一事实源');
    });

    await t('T2 零泄漏：client key / secret / token 不进 URL、Snapshot、Verification、attempt、日志', async () => {
      const blob = JSON.stringify({
        attempts: SurfaceStore.listAttempts(TID, { projectId: PID, limit: 50 }),
      });
      const verif = SurfaceStore.getDb().prepare('SELECT * FROM provider_verifications').all();
      const snaps = SurfaceStore.getDb().prepare('SELECT * FROM brand_source_identities').all();
      const all = blob + JSON.stringify(verif) + JSON.stringify(snaps);
      for (const marker of [KEY, SECRET, TOKEN]) {
        assert.ok(all.indexOf(marker) < 0, '数据面零泄漏: ' + marker);
      }
      // 快照元数据（source_url/final_url）同样零泄漏：按密钥标记检索全部快照元数据文件目录
      const snapDir = path.join(process.env.ZB_DATA_DIR, 'snapshots');
      let snapBlob = '';
      try {
        const walk = (d) => { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p2 = path.join(d, n.name); if (n.isDirectory()) walk(p2); else if (/\.json$/.test(n.name)) snapBlob += fs.readFileSync(p2, 'utf8'); } };
        if (fs.existsSync(snapDir)) walk(snapDir);
      } catch (e) { /* 目录可能不存在 */ }
      for (const marker of [KEY, SECRET, TOKEN]) assert.ok(snapBlob.indexOf(marker) < 0, '快照元数据零泄漏: ' + marker);
      const tableCheck = SurfaceStore.getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name);
      assert.ok(tableCheck.includes('provider_verifications'), 'verification 表存在');
    });

    await t('T3 HTTP 200 + 业务错误对象 → attempt failed（blocked）+ readiness auth_rejected，不写 success verification', async () => {
      calls.length = 0;
      adScenario = 'biz_error';
      const before = SurfaceStore.getDb().prepare("SELECT COUNT(*) c FROM provider_verifications WHERE capability='tiktok_commercial_content' AND status='success'").get().c;
      const a = Adapters.getAdapter('tiktok');
      const r = await a.collect(mkCtx('t3'));
      assert.strictEqual(r.attempt.status, 'failed', '业务错误不得进入成功链');
      assert.strictEqual(r.attempt.errorClass, 'blocked', 'auth 类业务错误 → blocked（05 §11 词表）');
      const after = SurfaceStore.getDb().prepare("SELECT COUNT(*) c FROM provider_verifications WHERE capability='tiktok_commercial_content' AND status='success'").get().c;
      assert.strictEqual(after, before, '未新增 success verification');
      const rd = Readiness.getReadiness('tiktok_commercial_content');
      assert.strictEqual(rd.state, 'auth_rejected', 'readiness 如实 auth_rejected: ' + rd.state);
      assert.ok(!/未观察到广告/.test(r.attempt.errorUserText || ''), '不伪装无结果');
      adScenario = 'success';
    });

    await t('T4 合法零结果（error.code=ok + ads=[]）→ 成功 + 零观察语义 + 覆盖范围保留', async () => {
      calls.length = 0;
      adScenario = 'empty_ok';
      const a = Adapters.getAdapter('tiktok');
      const r = await a.collect(mkCtx('t4'));
      assert.strictEqual(r.attempt.status, 'success', '合法零结果可成功');
      assert.strictEqual(r.attempt.observationCount || (r.attempt.observations || []).length, 0, '零广告');
      assert.strictEqual(r.attempt.summary.creativeCount, 0);
      assert.strictEqual(r.attempt.summary.measurementMethod, 'official_disclosure');
      assert.ok(new RegExp(TikTokAdLib.COUNTRY_COUNT + ' 国').test(r.attempt.summary.coverageNote || ''), '覆盖范围限制随零结果保留（不写「未观察到广告」）');
      adScenario = 'success';
    });

    await t('T5 P0-1：recordVerification 传未脱敏 sourceUrl → SQLite/admin 零密钥；文本脱敏兜底', async () => {
      Readiness.recordVerification({ capability: 'youtube_content', provider: 'youtube_data_api_v3', status: 'success', tenantId: TID, sourceUrl: 'https://api.example.com/x?access_token=' + SENTINEL + '&key=' + SENTINEL + '2&normal=keep' });
      const rows = SurfaceStore.getDb().prepare("SELECT source_url FROM provider_verifications WHERE capability='youtube_content' ORDER BY created_at DESC LIMIT 1").all();
      const stored = rows[0] && rows[0].source_url;
      assert.ok(stored && stored.indexOf(SENTINEL) < 0, 'SQLite 零 SECRET-TOKEN: ' + stored);
      assert.ok(stored.indexOf('REDACTED') >= 0, '已脱敏标记');
      assert.ok(stored.indexOf('normal=keep') >= 0, '非敏感参数保留');
      const adminBlob = JSON.stringify(Readiness.adminView());
      assert.ok(adminBlob.indexOf(SENTINEL) < 0, 'admin 投影零密钥');
      // 文本脱敏兜底（日志形态）
      const text = UrlRedact.redactUrlText('GET https://x/y?key=SECRET-TOKEN&token=SECRET-TOKEN failed');
      assert.ok(text.indexOf(SENTINEL) < 0, '文本兜底零密钥: ' + text);
      // 共享模块无循环依赖：单独 require 可用
      const fresh = require('../lib/url-redact.js');
      assert.strictEqual(typeof fresh.redactUrl, 'function');
      assert.strictEqual(fresh.redactUrl('https://a/b?Apikey=X&normal=1').indexOf('X'), -1, '大小写不敏感');
    });

    await t('T6 DataForSEO HTTP 200 + task 业务失败 → 不 operational（provider 级判定）', async () => {
      const chk = ProviderResponse.dataforseoOk({ status_code: 20000, status_message: 'Ok.', tasks: [{ status_code: 40000, status_message: 'You can set only one task at a time.', result: null }] });
      assert.strictEqual(chk.ok, false, 'task 级失败不得判成功');
      assert.strictEqual(chk.errorClass, 'unavailable');
      const okChk = ProviderResponse.dataforseoOk({ status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [] }] }] });
      assert.strictEqual(okChk.ok, true, '顶层+task 均 20000 才成功（合法零结果可成功）');
      const authChk = ProviderResponse.dataforseoOk({ status_code: 40104, tasks: [] });
      assert.strictEqual(authChk.errorClass, 'auth_rejected');
    });

    await t('T7 YouTube HTTP 200 + error 对象 → 不进入成功链；缺 items 也不成功', async () => {
      assert.strictEqual(ProviderResponse.youtubeOk({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }).errorClass, 'quota_exhausted');
      assert.strictEqual(ProviderResponse.youtubeOk({ error: { code: 403, message: 'forbidden' } }).errorClass, 'auth_rejected');
      assert.strictEqual(ProviderResponse.youtubeOk({}).ok, false, '缺 items 不成功');
      assert.strictEqual(ProviderResponse.youtubeOk({ items: [] }).ok, true, '空 items = 合法零结果');
    });
  } finally {
    Net.safeRequestOnce = origReq;
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
  }

  console.log(passed === 7 ? '[provider-contract-r3] ALL PASS（7/7）' : '[provider-contract-r3] ' + failed + ' FAIL / ' + passed + ' PASS');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('[provider-contract-r3] FATAL', e && e.stack || e); process.exit(1); });
