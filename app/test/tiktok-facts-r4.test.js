'use strict';
// ============================================================
// tiktok-facts-r4.test.js —— TikTok 官方广告库事实一致性回归（R4.14）
// ------------------------------------------------------------
// 动因（r3 遗留的两处事实错误）：
//   · 覆盖范围：TT_SUPPORTED_COUNTRIES 实为 32 国（EU27 + NO/IS/LI + GB/CH），
//     但文案/测试/前端写「30 国」——手写数量与列表脱钩。
//   · 请求字段：官方 Query Ads 白名单 11 项（含 ad.status_statement），
//     代码只请求 10 项，却对外称「11 项白名单」。
// 本测试锁定「唯一事实源」：
//   C1  国家列表长度严格 32（去重后仍 32）
//   C2  EU27 + NO/IS/LI/GB/CH 全部在列，US 不在列
//   C3  用户投影（summary）国家数 = Registry 文案数量 = 列表长度
//   C4  仓库内不得残留「30 国」文案（app / web / docs / scripts）
//   C5  代码字段数 = 官方文档白名单数 = 请求 URL fields 数（三者一致）
//   C6  官方白名单逐字比对（test 内为文档独立转写，不引用实现常量）
//   C7  status_statement 仅在官方返回时映射；缺失即 null（不补猜）
//   C8  美国品牌 → out_of_coverage（该公开来源当前无覆盖），零结果不冒充「没有广告」
//   C9  覆盖国内品牌（DE）→ covered；市场未知 → unknown（不替平台下结论）
//   C10 job 载入竞品时市场回退 intent.regions[0]（与品牌读模型同口径）
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-r4-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';

const db = require('../services/db.js');
const Registry = require('../services/capability-registry.js');
const Adapters = require('../services/source-adapter.js');
const Net = require('../research/net.js');
const TikTokAdLib = require('../lib/tiktok-adlib.js');
const CollectJobs = require('../services/collect-jobs.js');
const { saveState, projFile } = require('../core/state-store.js');

const TID = 'tenant:r4a', PID = 'projR4';
const REPO = path.resolve(__dirname, '../..'); // 仓库根（app/test → app → 根）
const KEY = 'TEST-CLIENT-KEY-r4';
const SECRET = 'TEST-CLIENT-SECRET-r4';
const TOKEN = 'TEST-ACCESS-TOKEN-r4';

// 官方文档独立转写（Query Ads `fields` 白名单，逐字；不由实现常量派生）
const DOC_WHITELIST = [
  'ad.id', 'ad.first_shown_date', 'ad.last_shown_date', 'ad.status', 'ad.status_statement',
  'ad.videos', 'ad.image_urls', 'ad.reach',
  'advertiser.business_id', 'advertiser.business_name', 'advertiser.paid_for_by',
];
const DOC_EU_27 = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'];
const DOC_EXTRA = ['NO', 'IS', 'LI', 'GB', 'CH'];
const DOC_COUNTRY_COUNT = DOC_EU_27.length + DOC_EXTRA.length; // 32

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
}

const mkCtx = (market, tag) => ({
  tenantId: TID, projectId: PID,
  competitor: { name: 'R4Brand', url: 'https://r4brand.example.com', isShopify: false, market },
  trigger: 'manual',
  idempotencyKey: 'r4-' + tag + '-' + Math.random().toString(36).slice(2, 8), nowMs: Date.now(),
});

// 递归收集源码文件（跳过构建产物与数据目录）
function walkFiles(root, out) {
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return out; }
  for (const n of names) {
    if (n.name === 'node_modules' || n.name === '.next' || n.name === 'data' || n.name === '.git') continue;
    const p2 = path.join(root, n.name);
    if (n.isDirectory()) walkFiles(p2, out);
    else if (/\.(js|cjs|mjs|ts|tsx|md|json|css)$/.test(n.name)) out.push(p2);
  }
  return out;
}

(async () => {
  db.createTenant({ name: 'cr4a', email: 'r4a@example.com' });
  db.saveProject({ id: PID, tenantId: TID, track: 'T-R4', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(PID, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({
    projectId: PID, tenantId: TID, track: 'T-R4', discoveredAt: new Date().toISOString(),
    intent: { regions: ['us'], category: 'toys' },
    competitors: [{ id: 'compR4', name: 'R4Brand', status: 'done', url: 'https://r4brand.example.com', isShopify: false }],
  });
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));

  process.env.TIKTOK_CLIENT_KEY = KEY;
  process.env.TIKTOK_CLIENT_SECRET = SECRET;

  const calls = [];
  const origReq = Net.safeRequestOnce;
  Net.safeRequestOnce = async (u, opt) => {
    const url = String(u);
    calls.push({ url, opt: opt || {} });
    const json = (obj) => ({ status: 200, headers: { 'content-type': 'application/json' }, buffer: Buffer.from(JSON.stringify(obj)), url });
    if (url.indexOf('/v2/oauth/token/') >= 0) return json({ access_token: TOKEN, expires_in: 7200, token_type: 'Bearer' });
    if (url.indexOf('/v2/research/adlib/ad/query/') >= 0) {
      return json({
        data: {
          ads: [{
            ad: {
              id: 1923845247192304, first_shown_date: 20250101, last_shown_date: 20250120,
              status: 'inactive', status_statement: '该广告已停止展示',
              videos: [{ url: 'https://cdn.example.com/v.mp4' }], image_urls: [],
              reach: { unique_user_seen: '11K' },
            },
            advertiser: { business_id: 3847236290405, business_name: 'Awe Food Co.', paid_for_by: 'Awe Co.' },
          }],
          has_more: false, search_id: 'sid-r4',
        },
        error: { code: 'ok', http_status_code: 200, message: '' },
      });
    }
    return { status: 404, headers: {}, buffer: Buffer.from('{}'), url };
  };

  try {
    // ---------- C1 / C2 覆盖国家事实 ----------
    await t('C1 覆盖国家列表长度严格 32 且无重复', async () => {
      assert.strictEqual(TikTokAdLib.SUPPORTED_COUNTRIES.length, DOC_COUNTRY_COUNT, '列表长度 = 32');
      assert.strictEqual(TikTokAdLib.COUNTRY_COUNT, DOC_COUNTRY_COUNT, '派生数量 = 32');
      assert.strictEqual(new Set(TikTokAdLib.SUPPORTED_COUNTRIES).size, TikTokAdLib.SUPPORTED_COUNTRIES.length, '无重复国家');
      assert.ok(Object.isFrozen(TikTokAdLib.SUPPORTED_COUNTRIES), '列表不可变（防止运行中被改写）');
    });

    await t('C2 EU27 + NO/IS/LI/GB/CH 全在列表内，US 不在列表内', async () => {
      for (const c of DOC_EU_27) assert.ok(TikTokAdLib.SUPPORTED_COUNTRIES.includes(c), 'EU27 成员在列: ' + c);
      for (const c of DOC_EXTRA) assert.ok(TikTokAdLib.SUPPORTED_COUNTRIES.includes(c), 'EEA/欧洲补充在列: ' + c);
      assert.ok(!TikTokAdLib.SUPPORTED_COUNTRIES.includes('US'), '美国不在官方覆盖列表');
      assert.strictEqual(TikTokAdLib.isCountryCovered('us'), false, 'US 判覆盖=false');
      assert.strictEqual(TikTokAdLib.isCountryCovered('de'), true, 'DE 判覆盖=true（大小写不敏感）');
    });

    // ---------- C3 用户投影 vs Registry ----------
    await t('C3 用户投影国家数 = Registry 文案数量 = 列表长度', async () => {
      const a = Adapters.getAdapter('tiktok');
      const out = a.normalize({ creatives: [], snapshotIds: [], countryScope: 'ALL', brandMarket: 'DE' }, { competitor: { name: 'x', url: 'https://x.example.com' } });
      assert.strictEqual(out.summary.coverageCountryCount, TikTokAdLib.SUPPORTED_COUNTRIES.length, 'summary 国家数 = 列表长度');
      const cap = Registry.getCapability('tiktok_commercial_content');
      const m = String(cap.limitations || '').match(/共\s*(\d+)\s*国/);
      assert.ok(m, 'Registry limitation 含「共 N 国」: ' + cap.limitations.slice(0, 60));
      assert.strictEqual(Number(m[1]), TikTokAdLib.SUPPORTED_COUNTRIES.length, 'Registry 文案数量 = 列表长度');
      assert.ok(cap.limitations.includes('不含美国'), 'Registry 明示不含美国');
      assert.ok(!/30\s*国/.test(cap.limitations), 'Registry 不残留 30 国');
      // 前端不写死数字：卡片从 summary.coverageCountryCount 读
      const card = fs.readFileSync(path.join(REPO, 'web/src/components/data-surface/dimension-card.tsx'), 'utf8');
      assert.ok(card.includes('coverageCountryCount'), '前端读取后端投影的数量');
      assert.ok(!/[^a-zA-Z0-9_]30\s*国/.test(card), '前端不写死 30 国');
    });

    // ---------- C4 文案残留扫描 ----------
    await t('C4 仓库源码不得残留「30 国」文案', async () => {
      const roots = ['app', 'web/src', 'docs', 'scripts'].map(r => path.join(REPO, r));
      const files = [];
      for (const r of roots) walkFiles(r, files);
      const bad = [];
      const re = new RegExp('30' + '\\s*国'); // 动态构造，避免本文件自我命中
      for (const fp of files) {
        if (/tiktok-facts-r4\.test\.js$/.test(fp)) continue; // 本测试自身含字面量用于反向断言
        let txt = '';
        try { txt = fs.readFileSync(fp, 'utf8'); } catch (e) { continue; }
        if (re.test(txt)) bad.push(path.relative(REPO, fp));
      }
      assert.deepStrictEqual(bad, [], '残留「30 国」文件：' + bad.join(', '));
    });

    // ---------- C5 / C6 字段事实 ----------
    await t('C5 代码字段数 = 官方白名单数 = 请求 URL fields 数（三者一致）', async () => {
      assert.strictEqual(TikTokAdLib.AD_FIELDS.length, DOC_WHITELIST.length, '代码字段数 = 文档白名单数（11）');
      assert.strictEqual(TikTokAdLib.AD_FIELD_COUNT, TikTokAdLib.AD_FIELDS.length, '派生字段数一致');
      assert.strictEqual(TikTokAdLib.AD_FIELDS_CSV.split(',').length, TikTokAdLib.AD_FIELDS.length, 'CSV 字段数一致');
      calls.length = 0;
      const a = Adapters.getAdapter('tiktok');
      const r = await a.collect(mkCtx('de', 'c5'));
      assert.strictEqual(r.attempt.status, 'success', '采集成功（stub provider）');
      const ad = calls.find(c => c.url.indexOf('/v2/research/adlib/ad/query/') >= 0);
      const urlFields = new URL(ad.url).searchParams.get('fields').split(',');
      assert.strictEqual(urlFields.length, TikTokAdLib.AD_FIELDS.length, 'URL fields 数 = 代码字段数');
      assert.deepStrictEqual(urlFields, DOC_WHITELIST.slice(), 'URL 字段顺序 = 官方白名单顺序');
    });

    await t('C6 字段白名单逐字比对：白名单 = 文档转写，且请求字段全部在白名单内', async () => {
      assert.deepStrictEqual(TikTokAdLib.AD_FIELD_WHITELIST.slice(), DOC_WHITELIST, '白名单逐字一致（含 ad.status_statement）');
      for (const fl of TikTokAdLib.AD_FIELDS) assert.ok(TikTokAdLib.AD_FIELD_WHITELIST.includes(fl), '请求字段 ⊆ 白名单: ' + fl);
      assert.ok(Object.isFrozen(TikTokAdLib.AD_FIELDS), '请求字段不可变');
      // 不为凑数量引入未确认字段：不得出现 ad.ad_name / ad.download_url / 数值 reach 字段
      for (const banned of ['ad.ad_name', 'ad.download_url', 'reach.unique_user_seen', 'ad.external_url']) {
        assert.ok(!TikTokAdLib.AD_FIELDS.includes(banned), '不含未在白名单的字段: ' + banned);
      }
    });

    // ---------- C7 状态说明映射 ----------
    await t('C7 status_statement 仅在官方返回时映射；缺失即 null（不补猜）', async () => {
      assert.strictEqual(calls.length > 0, true, '已发生真实请求构造');
      const a = Adapters.getAdapter('tiktok');
      const withStmt = a.normalize({
        creatives: [{ id: 'a1', status: 'inactive', statusStatement: '该广告已停止展示', advertiser: 'X' }],
        snapshotIds: [], brandMarket: 'DE',
      }, { competitor: { name: 'x', url: 'https://x.example.com' } });
      assert.strictEqual(withStmt.observations[0].statusStatement, '该广告已停止展示', '有则映射');
      assert.strictEqual(withStmt.observations[0].status, 'inactive', '状态保留');
      const noStmt = a.normalize({
        creatives: [{ id: 'a2', status: 'active', advertiser: 'Y' }],
        snapshotIds: [], brandMarket: 'DE',
      }, { competitor: { name: 'x', url: 'https://x.example.com' } });
      assert.strictEqual(noStmt.observations[0].statusStatement, null, '缺失不补猜');
      assert.ok(!('undefined' === typeof noStmt.observations[0].statusStatement), '字段存在且为 null');
    });

    // ---------- C8 / C9 覆盖状态 ----------
    await t('C8 美国品牌 → out_of_coverage（该公开来源当前无覆盖），不冒充「没有广告」', async () => {
      calls.length = 0;
      const a = Adapters.getAdapter('tiktok');
      const r = await a.collect(mkCtx('us', 'c8'));
      const s = r.attempt.summary;
      assert.strictEqual(s.coverageState, 'out_of_coverage', 'US 判为官方无覆盖');
      assert.strictEqual(s.brandMarket, 'US', '市场归一为 ISO2');
      assert.strictEqual(s.brandMarketCovered, false);
      assert.ok(/该公开来源当前无覆盖/.test(s.coverageNote), '文案明确「该公开来源当前无覆盖」: ' + s.coverageNote);
      assert.ok(!/未观察到广告/.test(s.coverageNote), '不得写成「未观察到广告」');
      assert.ok(/不代表该市场没有广告/.test(s.coverageNote), '零结果不冒充没有广告');
      assert.strictEqual(s.coverageCountryCount, TikTokAdLib.COUNTRY_COUNT, '仍投影真实国家数');
      // 观察数据照常映射（官方覆盖国家内的真实公开广告），不因市场越界被丢弃
      assert.ok((r.attempt.observations || []).length >= 1, '覆盖外市场仍展示官方覆盖范围内的真实记录');
    });

    await t('C9 覆盖内市场 DE → covered；市场未知 → unknown（不替平台下结论）', async () => {
      const a = Adapters.getAdapter('tiktok');
      const de = await a.collect(mkCtx('de', 'c9a'));
      assert.strictEqual(de.attempt.summary.coverageState, 'covered', 'DE 在覆盖内');
      assert.ok(!/该公开来源当前无覆盖/.test(de.attempt.summary.coverageNote), '覆盖内不出现无覆盖文案');
      const unk = await a.collect(mkCtx(null, 'c9b'));
      assert.strictEqual(unk.attempt.summary.coverageState, 'unknown', '市场未知 → unknown');
      assert.strictEqual(unk.attempt.summary.brandMarket, null);
      assert.ok(!/该公开来源当前无覆盖/.test(unk.attempt.summary.coverageNote), '未知不等于无覆盖');
    });

    // ---------- C10 市场回退口径 ----------
    await t('C10 job 载入竞品时市场回退 intent.regions[0]（与品牌读模型同口径）', async () => {
      const comp = CollectJobs.loadCompetitor({ projectId: PID, tenantId: TID, competitorId: 'compR4' });
      assert.ok(comp, '竞品可解析');
      assert.strictEqual(comp.market, 'us', '缺 market 时回退项目 intent.regions[0]');
      assert.strictEqual(comp.id, 'compR4');
    });

    // ---------- 安全边界复核（不改动，仅复核仍成立） ----------
    await t('R1 安全边界复核：凭据不进入 summary/note/observation（r3 边界保持）', async () => {
      const a = Adapters.getAdapter('tiktok');
      const r = await a.collect(mkCtx('de', 'r1'));
      const blob = JSON.stringify({ summary: r.attempt.summary, note: r.attempt.note, obs: r.attempt.observations });
      for (const marker of [KEY, SECRET, TOKEN]) assert.ok(blob.indexOf(marker) < 0, '凭据零泄漏: ' + marker);
      assert.ok(!/TIKTOK_CLIENT_/.test(blob), '用户侧不暴露环境变量名');
      assert.ok(!/ad_name|download_url|conversion|roi|cpc|cpm/i.test(blob), '无未观测字段/花费语义');
    });
  } finally {
    Net.safeRequestOnce = origReq;
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
  }

  const total = passed + failed;
  console.log(failed === 0 ? '[tiktok-facts-r4] ALL PASS（' + passed + '/' + total + '）' : '[tiktok-facts-r4] ' + failed + ' FAIL / ' + passed + ' PASS');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('[tiktok-facts-r4] FATAL', e && e.stack || e); process.exit(1); });
