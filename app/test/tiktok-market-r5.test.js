'use strict';
// ============================================================
// tiktok-market-r5.test.js —— 区域词不得被推断成单一国家（R4.15）
// ------------------------------------------------------------
// 动因：r4 的 MARKET_ALIASES 把「北美 / North America / AMERICA」映射为 US——
// 这是不成立的地理推断（北美含加拿大、墨西哥、多市场经营）。
// 规则：
//   M1 明确国家 → 正确归一（US/美国/United States → US；DE/德国/Germany → DE）
//   M2 区域/多市场描述 → unknown（北美/North America/欧洲/EU/全球/Global/空值…）
//   M3 任何区域词都不得产生 brandMarket=US（逐词全量扫描，防"换个写法又回来"）
//   M4 覆盖状态：US → out_of_coverage；DE → covered；区域词 → unknown（不判无覆盖）
//   M5 unknown 的用户文案不得出现「无覆盖」「没有广告」
//   M6 事实不变量不回退：32 国列表、COUNTRY_COUNT 派生、11 字段白名单
//   M7 adapter 端到端：market=北美 → coverageState=unknown（不误判 out_of_coverage）
//   M8 投影层：pending_config 能力一旦有可用尝试，数据必须可见（否则真实数据被隐藏）
// 测试用值均为本地受控数据，不代表真实 provider 响应。
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-r5-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';

const db = require('../services/db.js');
const Registry = require('../services/capability-registry.js');
const Adapters = require('../services/source-adapter.js');
const SurfaceStore = require('../services/surface-store.js');
const DataSurface = require('../services/data-surface.js');
const Net = require('../research/net.js');
const TikTokAdLib = require('../lib/tiktok-adlib.js');
const { saveState, projFile } = require('../core/state-store.js');

const TID = 'tenant:r5a', PID = 'projR5';
const KEY = 'TEST-CLIENT-KEY-r5';
const SECRET = 'TEST-CLIENT-SECRET-r5';
const TOKEN = 'TEST-ACCESS-TOKEN-r5';

// 独立转写的区域词清单（不引用实现常量，避免自证）
const REGION_WORDS = [
  '北美', '北美洲', '北美地区', 'North America', 'NORTH AMERICA', 'NA',
  '欧洲', 'Europe', 'EU', '欧盟', 'EEA', 'EMEA',
  '全球', 'Global', 'WORLDWIDE', '多地区', 'MULTI-REGION', '多市场', 'MULTI-MARKET',
  '亚太', 'APAC', 'ASIA PACIFIC', '东南亚', 'SOUTHEAST ASIA',
  '拉美', 'LATAM', 'LATIN AMERICA', '南美', 'SOUTH AMERICA',
  '中东', 'MIDDLE EAST', '非洲', 'AFRICA', '美洲', 'AMERICA', 'THE AMERICAS',
  '', '   ', '未知', 'n/a', 'unknown',
];

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
}
const mkCtx = (market, tag) => ({
  tenantId: TID, projectId: PID,
  competitor: { name: 'R5Brand', url: 'https://r5brand.example.com', isShopify: false, market },
  trigger: 'manual',
  idempotencyKey: 'r5-' + tag + '-' + Math.random().toString(36).slice(2, 8), nowMs: Date.now(),
});

(async () => {
  db.createTenant({ name: 'cr5a', email: 'r5a@example.com' });
  db.saveProject({ id: PID, tenantId: TID, track: 'T-R5', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(PID, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({
    projectId: PID, tenantId: TID, track: 'T-R5', discoveredAt: new Date().toISOString(),
    intent: { regions: ['us'], category: 'toys' },
    competitors: [{ id: 'compR5', name: 'R5Brand', status: 'done', url: 'https://r5brand.example.com', isShopify: false }],
  });
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));

  process.env.TIKTOK_CLIENT_KEY = KEY;
  process.env.TIKTOK_CLIENT_SECRET = SECRET;
  const origReq = Net.safeRequestOnce;
  Net.safeRequestOnce = async (u) => {
    const url = String(u);
    const json = (obj) => ({ status: 200, headers: { 'content-type': 'application/json' }, buffer: Buffer.from(JSON.stringify(obj)), url });
    if (url.indexOf('/v2/oauth/token/') >= 0) return json({ access_token: TOKEN, expires_in: 7200, token_type: 'Bearer' });
    return json({
      data: {
        ads: [{
          ad: { id: 1923845247192304, first_shown_date: 20250101, last_shown_date: 20250120, status: 'active', videos: [], image_urls: [], reach: { unique_user_seen: '11K' } },
          advertiser: { business_id: 3847236290405, business_name: 'Awe Food Co.', paid_for_by: 'Awe Co.' },
        }],
        has_more: false, search_id: 'sid-r5',
      },
      error: { code: 'ok', http_status_code: 200, message: '' },
    });
  };

  try {
    // ---------- M1 明确国家 ----------
    await t('M1 明确国家归一：US/美国/United States → US；DE/德国/Germany → DE', async () => {
      for (const v of ['US', 'us', '美国', 'United States', 'UNITED STATES', 'United States of America', 'USA']) {
        assert.strictEqual(TikTokAdLib.normalizeMarket(v), 'US', 'US 归一: ' + JSON.stringify(v));
      }
      for (const v of ['DE', 'de', '德国', 'Germany', 'GERMANY', 'Deutschland']) {
        assert.strictEqual(TikTokAdLib.normalizeMarket(v), 'DE', 'DE 归一: ' + JSON.stringify(v));
      }
      // 非 ISO2 但明确国家的别名
      assert.strictEqual(TikTokAdLib.normalizeMarket('UK'), 'GB', 'UK → GB');
      assert.strictEqual(TikTokAdLib.normalizeMarket('英国'), 'GB');
      assert.strictEqual(TikTokAdLib.normalizeMarket('加拿大'), 'CA', '加拿大是明确国家（覆盖外）');
    });

    // ---------- M2 区域词 → unknown ----------
    await t('M2 区域/多市场描述与空值 → null（unknown）', async () => {
      for (const v of REGION_WORDS) {
        assert.strictEqual(TikTokAdLib.normalizeMarket(v), null, '区域词不得归一: ' + JSON.stringify(v));
      }
      // 大小写与空格变体
      assert.strictEqual(TikTokAdLib.normalizeMarket('  North America  '), null, '首尾空格变体仍 unknown');
      assert.strictEqual(TikTokAdLib.normalizeMarket('north america'), null);
      assert.strictEqual(TikTokAdLib.normalizeMarket(null), null);
      assert.strictEqual(TikTokAdLib.normalizeMarket(undefined), null);
    });

    // ---------- M3 区域词不得产生 US ----------
    await t('M3 任何区域词都不得被写成 brandMarket=US', async () => {
      const bad = [];
      for (const v of REGION_WORDS.concat(['美洲', 'The Americas', 'North-America', '北美市场', '欧洲市场', '全球市场'])) {
        const cov = TikTokAdLib.marketCoverage(v);
        if (cov.brandMarket === 'US') bad.push(JSON.stringify(v));
        if (cov.coverageState !== 'unknown') bad.push(JSON.stringify(v) + '→' + cov.coverageState);
      }
      assert.deepStrictEqual(bad, [], '区域词误判: ' + bad.join(', '));
      // 别名表本身不得含区域词键
      for (const k of Object.keys(TikTokAdLib.MARKET_ALIASES)) {
        assert.ok(!TikTokAdLib.REGION_OR_MULTI_MARKET.includes(k), '别名表混入区域词: ' + k);
      }
    });

    // ---------- M4 覆盖状态 ----------
    await t('M4 覆盖状态：US=out_of_coverage；DE=covered；区域词=unknown', async () => {
      assert.deepStrictEqual(TikTokAdLib.marketCoverage('US'), { brandMarket: 'US', brandMarketCovered: false, coverageState: 'out_of_coverage' });
      assert.deepStrictEqual(TikTokAdLib.marketCoverage('美国'), { brandMarket: 'US', brandMarketCovered: false, coverageState: 'out_of_coverage' });
      assert.deepStrictEqual(TikTokAdLib.marketCoverage('DE'), { brandMarket: 'DE', brandMarketCovered: true, coverageState: 'covered' });
      assert.deepStrictEqual(TikTokAdLib.marketCoverage('北美'), { brandMarket: null, brandMarketCovered: null, coverageState: 'unknown' });
      assert.deepStrictEqual(TikTokAdLib.marketCoverage(''), { brandMarket: null, brandMarketCovered: null, coverageState: 'unknown' });
    });

    // ---------- M5 unknown 文案 ----------
    await t('M5 unknown 文案不得出现「无覆盖」或「没有广告」', async () => {
      const note = TikTokAdLib.coverageNoteFor('unknown', null);
      assert.ok(!/该公开来源当前无覆盖/.test(note), 'unknown 不写无覆盖');
      // 「不代表没有广告」是必要的否定说明，不算结论；剥掉后再查是否出现结论式「没有广告」
      const stripped = note.replace(/不代表(该市场)?没有广告/g, '');
      assert.ok(!/没有广告/.test(stripped), 'unknown 不写结论式「没有广告」: ' + note);
      assert.ok(/\d+ 国/.test(note), '仍说明官方覆盖范围');
      const ooc = TikTokAdLib.coverageNoteFor('out_of_coverage', 'US');
      assert.ok(/该公开来源当前无覆盖/.test(ooc), 'out_of_coverage 明确无覆盖');
      assert.ok(/不代表该市场没有广告/.test(ooc), '零结果不冒充没有广告');
    });

    // ---------- M6 事实不变量 ----------
    await t('M6 不变量不回退：32 国、数量派生、11 字段白名单', async () => {
      assert.strictEqual(TikTokAdLib.SUPPORTED_COUNTRIES.length, 32);
      assert.strictEqual(TikTokAdLib.COUNTRY_COUNT, TikTokAdLib.SUPPORTED_COUNTRIES.length);
      assert.strictEqual(TikTokAdLib.AD_FIELDS.length, 11);
      assert.strictEqual(TikTokAdLib.AD_FIELD_WHITELIST.length, 11);
      assert.strictEqual(TikTokAdLib.AD_FIELDS_CSV.split(',').length, 11);
      const cap = Registry.getCapability('tiktok_commercial_content');
      assert.ok(/共 32 国/.test(cap.limitations), 'Registry 覆盖文案 = 32 国');
      // 动态构造，避免本文件自身出现旧数字字面量（r4 的全仓扫描会命中）
      assert.ok(!new RegExp('30' + '\\s*国').test(cap.limitations), 'Registry 不残留旧国数');
    });

    // ---------- M7 adapter 端到端 ----------
    await t('M7 adapter：market=北美 → coverageState=unknown（不误判 out_of_coverage）', async () => {
      const a = Adapters.getAdapter('tiktok');
      for (const m of ['北美', 'North America', 'EU', '全球']) {
        const r = await a.collect(mkCtx(m, 'm7'));
        assert.strictEqual(r.attempt.status, 'success', 'collect 成功（stub）');
        assert.strictEqual(r.attempt.summary.coverageState, 'unknown', '区域词 → unknown: ' + m);
        assert.strictEqual(r.attempt.summary.brandMarket, null, '不得写成 US: ' + m);
        assert.ok(!/该公开来源当前无覆盖/.test(r.attempt.summary.coverageNote), 'unknown 不写无覆盖: ' + m);
      }
      const de = await a.collect(mkCtx('德国', 'm7de'));
      assert.strictEqual(de.attempt.summary.coverageState, 'covered', '德国 → covered');
      const us = await a.collect(mkCtx('美国', 'm7us'));
      assert.strictEqual(us.attempt.summary.coverageState, 'out_of_coverage', '美国 → out_of_coverage');
    });

    // ---------- M8 投影层：有可用尝试即渲染 ----------
    await t('M8 投影层：pending_config 能力有可用尝试 → 数据可见；无尝试 → 仍占位', async () => {
      const comp = { id: 'compR5', url: 'https://r5brand.example.com', isShopify: false };
      const before = DataSurface.buildOverview({ tenantId: TID, projectId: PID, competitorId: 'compR5', comp });
      const dimBefore = before.dimensions.find(d => d.code === 'ad_campaigns');
      assert.strictEqual(dimBefore.surfaceState, 'pending_config', '无尝试时守占位语义: ' + dimBefore.surfaceState);
      assert.strictEqual(dimBefore.summary, null, '无尝试不构造摘要');

      const a = Adapters.getAdapter('tiktok');
      const out = a.normalize({
        creatives: [{ id: 'ad1', advertiser: 'Fixture Co', status: 'active', firstShownDate: '20250101' }],
        snapshotIds: [], brandMarket: 'us',
      }, { competitor: comp });
      const at = SurfaceStore.createAttempt({
        tenantId: TID, projectId: PID, competitorId: 'compR5', capability: 'tiktok_commercial_content',
        dimension: 'ad_campaigns', trigger: 'manual', idempotencyKey: 'r5-proj-' + Date.now(), nowMs: Date.now(),
      });
      SurfaceStore.completeAttempt(TID, at.attempt.attemptId, {
        status: 'success', sourceStatus: 'success',
        observations: out.observations, snapshotIds: [], evidenceIds: [],
        summary: out.summary, endedAt: new Date().toISOString(),
      });

      const after = DataSurface.buildOverview({ tenantId: TID, projectId: PID, competitorId: 'compR5', comp });
      const dimAfter = after.dimensions.find(d => d.code === 'ad_campaigns');
      assert.strictEqual(dimAfter.surfaceState, 'ok', '有可用尝试 → 数据可见: ' + dimAfter.surfaceState);
      assert.ok(dimAfter.summary, '摘要可见');
      assert.strictEqual(dimAfter.summary.coverageState, 'out_of_coverage', 'US 品牌 → 无覆盖');
      assert.strictEqual(dimAfter.summary.coverageCountryCount, 32);
      assert.ok(dimAfter.aggregations.length >= 1, '有聚合块可渲染');

      const detail = DataSurface.buildDimensionDetail({ tenantId: TID, projectId: PID, competitorId: 'compR5', dimension: 'ad_campaigns', offset: 0, limit: 50, comp });
      assert.strictEqual(detail.dimensionUnsupported, false, '明细页不再判未接入');
      assert.ok((detail.observations || []).length >= 1, '明细可见观察');
      assert.strictEqual(detail.summary.coverageState, 'out_of_coverage');
    });
  } finally {
    Net.safeRequestOnce = origReq;
    delete process.env.TIKTOK_CLIENT_KEY;
    delete process.env.TIKTOK_CLIENT_SECRET;
  }

  const total = passed + failed;
  console.log(failed === 0 ? '[tiktok-market-r5] ALL PASS（' + passed + '/' + total + '）' : '[tiktok-market-r5] ' + failed + ' FAIL / ' + passed + ' PASS');
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('[tiktok-market-r5] FATAL', e && e.stack || e); process.exit(1); });
