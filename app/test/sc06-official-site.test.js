'use strict';
// ============================================================
// test/sc06-official-site.test.js —— SC-06 行为测试
//   A 组：能力注册与语义（Shopify 不可用 ≠ 官网不支持）
//   B 组：site-profile 解析器（受控 fixture，明确标记，不作来源验收）
//   C 组：voice-unified 统一读模型（一套口径 / 无证据不标已核实 / 隔离）
//   D 组：buildOfficialSiteStatus（官网确认状态三态）
// 🔴 真实采集验收由 web/e2e/live-site-verify.cjs 承担（真实 HTTP + 真实来源），
//    本文件的 fixture 只用于确定性回归，不替代真实验收。
// ============================================================
const test = require('node:test');
const assert = require('node:assert');

// r3：测试隔离修复——旧实现用仓库外固定目录 + 模块内递增幂等键，
// 第二次运行会命中上一次的终态 attempt（createAttempt 去重 → completeAttempt 报
// 'attempt already terminal'），与本轮改动无关，是既有缺陷。改为每次运行独立临时目录。
const os = require('os');
const path = require('path');
process.env.ZB_DATA_DIR = process.env.ZB_DATA_DIR || fs_mkdtemp();
function fs_mkdtemp() { return require('fs').mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc06-')); }
const fs = require('fs');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });

const Registry = require('../services/capability-registry.js');
const Adapters = require('../services/source-adapter.js');
const SiteProfile = require('../research/site-profile.js');
const VoiceUnified = require('../services/voice-unified.js');
const BrandSvc = require('../services/brand-service.js');
const SurfaceStore = require('../services/surface-store.js');
const BrandStore = require('../services/brand-store.js');
const Db = require('../services/db.js');

const TID = 'tenant:sc06a';

// ---------- A 组：能力注册与语义 ----------
test('A1 registry 完整性 + 两个新能力已注册（官网资料 ga；公开商品待验证，无凭据）', () => {
  const ig = Registry.assertRegistryIntegrity();
  assert.ok(ig.ok, 'integrity: ' + ig.errors.join(';'));
  for (const code of ['official_site_profile', 'public_site_products']) {
    const cap = Registry.getCapability(code);
    assert.ok(cap, code + ' 已注册');
    assert.strictEqual(cap.dimension, 'website_products');
    assert.strictEqual(cap.requiresServerCredential, false, '公开网页抓取不需要凭据');
    assert.ok(!cap.configKeys, '无 configKeys（不需要用户配置任何 key）');
  }
  // SC-06 r2（评审 §二）：成熟度与真实验证分开——
  // official_site_profile 已有真实成功采集（VEJA）→ ga；
  // public_site_products 尚无真实商品观察闭环 → 不得 ga，只能是 pending_verification。
  assert.strictEqual(Registry.getCapability('official_site_profile').maturity, 'ga');
  assert.strictEqual(Registry.getCapability('public_site_products').maturity, 'pending_verification');
});

test('A2 非 Shopify 站：Shopify 目录不可用文案「Shopify 公开商品目录不可用」，官网资料仍支持', () => {
  const ctx = { url: 'https://www.example-nonshopify.com', isShopify: false };
  const shop = Adapters.getAdapter('shopify').supports(ctx);
  assert.strictEqual(shop.supported, false);
  assert.strictEqual(shop.reasonText, 'Shopify 公开商品目录不可用', '不写「官网不支持」');
  assert.ok(!/不支持/.test(shop.reasonText), '用户侧不出现「不支持」');
  for (const code of ['official_site_profile', 'public_site_products']) {
    // capability code → adapter chain（生产同语义：registry code ≠ adapter code）
    const chain = Adapters.resolveAdapterChain(code);
    assert.ok(chain.ok && chain.chain.length === 1, code + ' 有 adapter 链');
    const r = Adapters.getAdapter(chain.chain[0]).supports(ctx);
    assert.strictEqual(r.supported, true, code + ' 对非 Shopify 站支持');
  }
});

test('A3 无官网地址的品牌：两个能力 not_applicable，文案不写「官网不支持」', () => {
  const r = Adapters.getAdapter('official_site_profile').supports({ url: '', isShopify: false });
  assert.strictEqual(r.supported, false);
  assert.strictEqual(r.reasonCode, 'not_applicable');
  assert.ok(!/不支持/.test(r.reasonText));
});

// ---------- B 组：site-profile 解析器（受控 fixture） ----------
const FIXTURE_HTML = `<!doctype html><html><head>
<title>ACME &amp; Sons</title>
<link rel="canonical" href="https://www.example-nonshopify.com/home">
<meta name="description" content="We build widgets.">
<meta property="og:title" content="ACME">
<meta property="og:site_name" content="ACME Store">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"OnlineStore","name":"ACME","url":"https://www.example-nonshopify.com"}
</script>
<script type="application/ld+json">{broken json!!
</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Widget Pro","offers":{"price":19.9,"priceCurrency":"USD","availability":"https://schema.org/InStock"},"aggregateRating":{"ratingValue":4.5,"reviewCount":23},"url":"/products/widget-pro"}
</script>
</head><body>shop</body></html>`;

test('B1 parseSiteProfile：canonical/标题/实体解码/OG/OnlineStore→组织/JSON-LD Product', () => {
  const p = SiteProfile.parseSiteProfile(FIXTURE_HTML, 'https://www.example-nonshopify.com/');
  assert.strictEqual(p.canonical, 'https://www.example-nonshopify.com/home');
  assert.strictEqual(p.title, 'ACME & Sons', 'HTML 实体已解码');
  assert.strictEqual(p.siteName, 'ACME Store');
  assert.strictEqual(p.brandIntro, 'We build widgets.');
  assert.ok(p.organization, 'OnlineStore 识别为组织');
  assert.strictEqual(p.organization.name, 'ACME');
  assert.strictEqual(p.products.length, 1, '损坏 JSON-LD 块不影响其他块');
  const prod = p.products[0];
  assert.strictEqual(prod.name, 'Widget Pro');
  assert.strictEqual(prod.price, 19.9);
  assert.strictEqual(prod.currency, 'USD');
  assert.strictEqual(prod.rating, 4.5);
  assert.strictEqual(prod.reviewCount, 23);
  assert.strictEqual(prod.url, 'https://www.example-nonshopify.com/products/widget-pro', '相对 URL 绝对化');
  assert.strictEqual(p.observed.priceObservedCount, 1);
});

test('B2 sitemap / robots / 商品 URL 识别（受控 fixture）', () => {
  const robots = 'User-agent: *\nSitemap: https://www.example.com/sm/index.xml\nDisallow: /x';
  assert.deepStrictEqual(SiteProfile.parseSitemapsFromRobots(robots), ['https://www.example.com/sm/index.xml']);
  const xml = '<urlset><url><loc>https://www.example.com/products/a</loc></url><url><loc>https://www.example.com/about</loc></url><url><loc>https://www.example.com/products/b.html</loc></url></urlset>';
  const locs = SiteProfile.parseSitemapLocs(xml);
  assert.strictEqual(locs.length, 3);
  const urls = SiteProfile.sampleProductUrls(locs);
  assert.deepStrictEqual(urls, ['https://www.example.com/products/a', 'https://www.example.com/products/b.html']);
  assert.strictEqual(SiteProfile.isProductUrl('javascript:alert(1)'), false);
  assert.strictEqual(SiteProfile.absUrl('https://x.com/a', null), 'https://x.com/a');
});

// ---------- C 组：voice-unified 统一读模型 ----------
let seedSeq = 0;
function seedAttempt(tenantId, comp, capability, dimension, payload) {
  // 受控 fixture：走生产 createAttempt/completeAttempt 生命周期，数据为结构等价注入
  // （不伪造「已回补」类声明；仅供读模型/状态投影的确定性回归）
  seedSeq += 1;
  const mk = SurfaceStore.createAttempt({
    tenantId, projectId: 'projSC06', competitorId: comp.id,
    capability, dimension, trigger: 'manual', idempotencyKey: 'sc06-' + capability + '-' + seedSeq,
  });
  assert.ok(mk.attempt, 'createAttempt should create: ' + JSON.stringify(mk).slice(0, 120));
  return SurfaceStore.completeAttempt(tenantId, mk.attempt.attemptId, payload, null);
}

function seedReviewAttempt(tenantId, comp, opts) {
  const o = opts || {};
  const pages = o.pages || [
    { pageId: 'https://reviews.example.com/acme', url: 'https://reviews.example.com/acme', title: 'ACME reviews', rating: 3.2, reviewCount: 12, snippet: 'mixed reviews here', fetchedAt: new Date().toISOString() },
  ];
  const snapIds = o.evidenceIds && o.evidenceIds.length ? ['snap-voice-test-1'] : [];
  const out = Adapters.getAdapter('reviews').normalize({ ok: true, pages, snapshotIds: snapIds, partialScan: false, sourceUrl: pages[0].url }, { competitor: comp });
  return seedAttempt(tenantId, comp, 'public_reviews', 'reviews_reputation', {
    status: 'success', observations: out.observations, summary: out.summary,
    snapshotIds: snapIds, evidenceIds: o.evidenceIds || [],
  });
}

test('C1 无 Evidence/Snapshot 的评论观察不进 verified（不得标已核实）', () => {
  const comp = { id: 'compV1', name: 'VoiceBrand', url: 'https://www.voice-brand.com', isShopify: false };
  Db.saveProject({ id: 'projSC06', tenantId: TID, track: 'SC06 voice', competitors: [comp], createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  BrandStore.upsertBrand({ tenantId: TID, canonicalName: 'VoiceBrand', officialDomain: 'voice-brand.com', competitorRef: 'compV1' });
  BrandStore.linkProject({ tenantId: TID, brandId: BrandStore.brandIdForCompetitor(TID, 'projSC06', 'compV1') || 'br_v1', projectId: 'projSC06', competitorRef: 'compV1' });
  // 无 Evidence 引用的 attempt（evidenceIds 空）
  seedReviewAttempt(TID, comp, { evidenceIds: [] });
  const bid = BrandStore.brandIdForCompetitor(TID, 'projSC06', 'compV1');
  const u = VoiceUnified.buildUnifiedVoice({ tenantId: TID, projectId: 'projSC06', brandId: bid, comp });
  assert.strictEqual(u.status, 'insufficient');
  assert.strictEqual(u.insufficientText, '资料不足，暂不形成群体结论。');
  assert.strictEqual(u.verified.items.length, 0, '无 Evidence/Snapshot 引用的观察不进 verified');
  assert.ok(!/没有差评|用户满意|无口碑/.test(JSON.stringify(u)), '不写「没有差评/用户满意/无口碑」');
});

test('C2 voiceItems 是迁移投影：不进 verified、不算统计、有明确说明', () => {
  const comp = { id: 'compV1', name: 'VoiceBrand', url: 'https://www.voice-brand.com', isShopify: false, voiceItems: [{ platform: 'reddit', url: 'https://reddit.com/r/x', text: 'old voice item', date: '2026-01-01', sentiment: 'neg', tier: 'public' }] };
  const bid = BrandStore.brandIdForCompetitor(TID, 'projSC06', 'compV1');
  const u = VoiceUnified.buildUnifiedVoice({ tenantId: TID, projectId: 'projSC06', brandId: bid, comp });
  assert.strictEqual(u.verified.items.length, 0, 'voiceItems 不进 verified');
  assert.strictEqual(u.legacy.items.length, 1);
  assert.strictEqual(u.legacy.items[0].evidenceId, null);
  assert.ok(/迁移投影/.test(u.legacy.note));
  // 机会输入：insufficient → 空（不产生第二套分母）
  assert.deepStrictEqual(VoiceUnified.toOpportunityInput(u), []);
});

test('C3 跨租户隔离：另一租户看不到 VoiceBrand 的评论观察', () => {
  const comp = { id: 'compV1', name: 'VoiceBrand', url: 'https://www.voice-brand.com', isShopify: false };
  const TID_B = 'tenant:sc06b-other';
  const bid = BrandStore.brandIdForCompetitor(TID, 'projSC06', 'compV1');
  const u = VoiceUnified.buildUnifiedVoice({ tenantId: TID_B, projectId: 'projSC06', brandId: bid, comp });
  assert.strictEqual(u.verified.items.length, 0, '跨租户读取为空');
});

test('C4 project 投影：buildProjectVoiceSummary 输出统一口径字段', () => {
  const list = VoiceUnified.buildProjectVoiceSummary(TID, 'projSC06', {});
  assert.ok(Array.isArray(list));
  for (const v of list) {
    assert.ok('brandId' in v && 'status' in v && 'sampleSize' in v && 'sourceCount' in v && 'recentItems' in v);
  }
});

// ---------- D 组：官网确认状态三态 ----------
test('D1 buildOfficialSiteStatus：无 attempt → not_collected（未采集，非「不支持」）', () => {
  const st = BrandSvc.buildOfficialSiteStatus(TID, 'projSC06', { id: 'compV1' });
  assert.strictEqual(st.status, 'not_collected');
  assert.ok(!/不支持/.test(JSON.stringify(st)));
});

test('D2 buildOfficialSiteStatus：只有失败 → unavailable（来源暂不可达，非「官网不支持」）', () => {
  const comp = { id: 'compV1', name: 'VoiceBrand', url: 'https://www.voice-brand.com', isShopify: false };
  seedAttempt(TID, comp, 'official_site_profile', 'website_products', { status: 'failed', errorClass: 'unavailable', errorUserText: '来源暂不可达，稍后可重试。', observations: [], snapshotIds: [], evidenceIds: [] });
  const st = BrandSvc.buildOfficialSiteStatus(TID, 'projSC06', comp);
  assert.strictEqual(st.status, 'unavailable');
  assert.ok(!/不支持/.test(JSON.stringify(st)), '失败也不写「官网不支持」');
});

test('D3 buildOfficialSiteStatus：成功 → confirmed + canonical（官网已确认）', () => {
  const comp = { id: 'compV1', name: 'VoiceBrand', url: 'https://www.voice-brand.com', isShopify: false };
  seedAttempt(TID, comp, 'official_site_profile', 'website_products', {
    status: 'success',
    observations: [{ id: 'official_site_profile', title: 'VoiceBrand' }],
    summary: { kind: 'official_site_profile', canonical: 'https://www.voice-brand.com/', siteName: 'VoiceBrand', hasOrganization: true },
    snapshotIds: ['snap-site-1'], evidenceIds: ['ev-site-1'],
  });
  const st = BrandSvc.buildOfficialSiteStatus(TID, 'projSC06', comp);
  assert.strictEqual(st.status, 'confirmed');
  assert.strictEqual(st.statusText, '官网已确认');
  assert.strictEqual(st.canonical, 'https://www.voice-brand.com/');
});

test('D4 两个新 adapter 结构契约完整（五方法 + validator 通过）', () => {
  for (const code of ['official_site_profile', 'official_site_products']) {
    const ad = Adapters.getAdapter(code);
    assert.ok(ad, code + ' 已注册');
    for (const m of ['supports', 'resolveIdentity', 'collect', 'normalize', 'health']) {
      assert.strictEqual(typeof ad[m], 'function', code + '.' + m);
    }
    const out = ad.normalize({ ok: true, profile: { parserVersion: 'site-profile-1', canonical: 'https://x.com/', title: 'X', siteName: 'X', brandIntro: null, og: {}, organization: null, products: [], observed: {} }, products: [], snapshotIds: ['snap-x-1'], evidenceSnapshotIds: ['snap-x-1'], currencies: [] }, { competitor: { id: 'c1', url: 'https://x.com' } });
    const v = Adapters.validateOutput(out);
    assert.deepStrictEqual(v, { ok: true, errors: [] }, code + ' normalize 输出过 validator: ' + JSON.stringify(v.errors || []));
  }
});
