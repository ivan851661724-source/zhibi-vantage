'use strict';
// ============================================================
// services/capability-registry.js —— 数据能力唯一事实源（SC-02 §3）
// ------------------------------------------------------------
// 规格依据（冻结语义）：
//   · 05 v0.4.0 §25 / SC-02 §3：前后端一切"目前支持什么"的判断只读本
//     Registry；前端禁止自建能力清单（T10 生产路径不读 mock 的结构前提）
//   · 00 v1.2 §57 Capability Contract 七维（Accuracy/Freshness/Coverage/
//     Cost/Failure Mode/Fallback/Evidence Strength）——本 Registry 持有
//     产品面声明，七维运行时值由 05 §21 模板与各 provider 规格维护
//   · 00 v1.2 §14/§15：Tier 只表达"对某 capability 的依赖级别"，不把
//     Provider 永久写死；未接入能力不虚设 adapter/provider
//   · 00 v1.2 §17 Shopify 边界：公开商品数据 ≠ AOV/销量/GMV
//   · 05 §17 GA Gate：未达生产验收的能力 maturity 不得标 ga
//   · 04 §20：本文件不向前端暴露密钥/内部成本细节；成本仅持归因键
// 硬规则：纯数据模块（零 IO、零副作用）；每能力字段完整性由
//   assertRegistryIntegrity() 锁定（测试 T1）。
// ============================================================

const REGISTRY_VERSION = 'capreg-1';

// R4.14：TikTok 覆盖国家/字段的事实唯一源（纯数据零依赖模块）。
// 文案中的「共 N 国」必须由它派生——r3 曾在文案里手写 30，而列表实为 32。
const TikTokAdLib = require('../lib/tiktok-adlib.js');

// SC-02 §2：维度 = 产品层分组（冻结五值；映射 05 §1 Capability Map）
const DIMENSIONS = Object.freeze([
  { code: 'website_products', displayName: '官网与商品' },
  { code: 'social_content', displayName: '社媒内容' },
  { code: 'ad_campaigns', displayName: '广告活动' },
  { code: 'reviews_reputation', displayName: '口碑与评论' },
  { code: 'search_interest', displayName: '搜索与热度' },
]);
const DIMENSION_CODES = new Set(DIMENSIONS.map(d => d.code));

// maturity 词表（05 §17 GA Gate）：
//   ga                   = 已通过真实成功采集验证，可进入用户可见结论
//   pending_verification = 能力代码/适配器已就绪（无需凭据的公开来源），但**尚无一次
//                          真实成功采集**——不得显示「已采集/已接通」，也不得当作已接入
//   pending_config       = 结构就绪但缺系统凭据（需要配置）——与「待验证」是两件事
//   not_integrated       = 未接入，不得宣称能力
// 🔴 SC-06 r2（评审 §二）：新增 pending_verification 而不是把未验证能力塞进现有三态；
//    运行态（source-readiness）复用 ready_to_verify 语义，四层区分：
//    能力代码存在 / 来源已配置 / 已有真实成功采集 / 当前品牌已有可展示证据。
const MATURITY = new Set(['ga', 'not_integrated', 'pending_config', 'pending_verification']);

const CAPABILITIES = Object.freeze([
  {
    code: 'shopify_catalog',
    displayName: '官网商品目录与公开价格',
    dimension: 'website_products',
    adapter: 'shopify',
    adapters: ['shopify'],
    provider: 'shopify_products_json',
    supportedObjects: { objectTypes: ['official_domain'], platforms: ['shopify'], markets: 'storefront-domain' },
    access: 'public_storefront_json',
    requiresServerCredential: false,
    manualRefresh: true,
    autoInspect: true, // 自动巡检由 WatchMonitor 固定窗口承担（03 §12），不在本骨架重复调度
    freshnessSlaHours: 26, // 三窗口/天（06/14/22 + 容差）；字段级 SLA（00 §54），非全局阈值
    maturity: 'ga',
    limitations: '公开商品目录快照：当前公开价格/可售状态/新品观察；不含真实订单 AOV、销量、GMV（00 §17 冻结）',
    costAttributionKey: 'infra.shopify_catalog',
    collectorVersion: 'net-1',
    parserVersion: 'shopify-adapter-1',
    adapterStrategy: 'single', // SC-02 复审: single|fallback|fanout
    // SC-02 §6.3（整改轮）：capability 级刷新策略。cooldownMinutes = 两次成功
    // 采集间最小间隔（防无限刷新/防双费用）；dailyQuota = 自然日采集次数上限
    // （null = 本 capability 无日限，免费公开源靠 cooldown 保护；付费来源接入时
    // 必须显式设值，否则 assertRegistryIntegrity 拒绝 ga）。
    refreshPolicy: { cooldownMinutes: 5, dailyQuota: null },
  },
  {
    code: 'shopify_collections',
    displayName: '官网商品集合（Collections）',
    dimension: 'website_products',
    adapter: 'shopify_collections',
    adapters: ['shopify_collections'],
    provider: 'shopify_collections_json',
    supportedObjects: { objectTypes: ['official_domain'], platforms: ['shopify'], markets: 'storefront-domain' },
    access: 'public_storefront_json',
    requiresServerCredential: false,
    manualRefresh: true,
    autoInspect: false,
    freshnessSlaHours: 26,
    maturity: 'ga',
    limitations: '店铺集合名称与 handle 清单（类目结构信号）；不含集合内商品明细，不推断销量（00 §17 冻结）',
    costAttributionKey: 'infra.shopify_collections',
    collectorVersion: 'net-1',
    parserVersion: 'collections-adapter-1',
    adapterStrategy: 'single',
    refreshPolicy: { cooldownMinutes: 5, dailyQuota: null },
  },
  {
    // SC-06 二：通用官网公开资料（canonical/标题/简介/OpenGraph/JSON-LD
    // Organization），与 shopify_catalog 分离——Shopify 目录接口不可用时
    // 官网资料仍可独立采集与确认。公开网页抓取：无凭据，走同一安全门
    // （Net.fetchPage：SSRF/DNS rebinding/FetchGate/robots/逐跳重定向校验）。
    // maturity=ga 的依据：SC-06 r1 已对公开非 Shopify 官网完成一次真实
    // 成功采集（真实 Snapshot+Evidence，见 SC-06 交付报告 §真实采集验证）。
    code: 'official_site_profile',
    displayName: '官网资料（公开页面）',
    dimension: 'website_products',
    adapter: 'official_site_profile',
    adapters: ['official_site_profile'],
    provider: 'public_site_profile_fetch',
    supportedObjects: { objectTypes: ['official_domain'], platforms: ['public_web'], markets: 'public_web' },
    access: 'public_web_page',
    requiresServerCredential: false,
    measurementMethod: 'public_source_observation',
    manualRefresh: true,
    autoInspect: false,
    freshnessSlaHours: 72,
    maturity: 'ga',
    limitations: '仅展示公开页面真实出现的内容：canonical、站点标题、品牌简介、OpenGraph 与 JSON-LD 公开的组织信息；不从文案/结构推断销量、GMV、转化率、广告花费或用户画像（00 §17 冻结）',
    costAttributionKey: 'infra.official_site_profile',
    collectorVersion: 'net-1',
    parserVersion: 'site-profile-1',
    adapterStrategy: 'single',
    refreshPolicy: { cooldownMinutes: 30, dailyQuota: null },
  },
  {
    // SC-06 二：公开商品页发现与公开价格/评分观察（非 Shopify 目录接口）。
    // 发现路径：JSON-LD Product → robots 声明的 sitemap → 首页内链商品 URL；
    // 只记录公开页面实际出现的价格/币种/评分/评价数，每条带来源 URL 与快照。
    code: 'public_site_products',
    displayName: '官网公开商品（非目录接口）',
    dimension: 'website_products',
    adapter: 'official_site_products',
    adapters: ['official_site_products'],
    provider: 'public_site_products_fetch',
    supportedObjects: { objectTypes: ['official_domain'], platforms: ['public_web'], markets: 'public_web' },
    access: 'public_web_page',
    requiresServerCredential: false,
    measurementMethod: 'public_source_observation',
    manualRefresh: true,
    autoInspect: false,
    freshnessSlaHours: 72,
    // 🔴 SC-06 r2（评审 §二）：尚无一次真实公开商品页采集成功闭环
    // （Snapshot → Evidence → Attempt → 前端商品展示），因此不得标 ga。
    // 代码与受控 fixture 存在 ≠ 生产验证通过——升级 ga 必须由真实成功产生。
    maturity: 'pending_verification',
    limitations: '仅展示公开商品页实际出现的名称/价格/币种/评分/评价数（JSON-LD 公开字段）与可安全识别的商品 URL；样本受发现路径限制并明示；不推断销量与转化（00 §17 冻结）。当前状态：能力已实现，尚待一次真实公开商品页采集验证',
    costAttributionKey: 'infra.public_site_products',
    collectorVersion: 'net-1',
    parserVersion: 'site-profile-1',
    adapterStrategy: 'single',
    refreshPolicy: { cooldownMinutes: 30, dailyQuota: null },
  },
  {
    // Wave 1：YouTube 官方 Data API v3 公开内容（官方 REST 契约直连，零 npm 依赖）。
    // pending_config：结构/契约就绪，凭据（YOUTUBE_API_KEY）真实可用并完成一次
    // 真实 staging 成功请求前，禁止升级 ga（live-source-smoke 负责验证）。
    code: 'youtube_content',
    displayName: '社媒内容（YouTube 公开频道）',
    dimension: 'social_content',
    adapter: 'youtube',
    adapters: ['youtube'],
    provider: 'youtube_data_api_v3',
    supportedObjects: { objectTypes: ['official_domain', 'brand_channel'], platforms: ['youtube'], markets: 'public_api' },
    access: 'official_public_api',
    requiresServerCredential: true,
    configKeys: ['YOUTUBE_API_KEY'],
    measurementMethod: 'public_source_observation',
    manualRefresh: true,
    autoInspect: false,
    freshnessSlaHours: 48,
    maturity: 'pending_config',
    limitations: '仅展示 YouTube Data API 实际返回的公开视频与公开互动字段（标题/发布时间/链接/缩略图/公开计数/可用评论摘要）；广告花费、转化、私域数据不可观测，不推断（00 §17 冻结）',
    costAttributionKey: 'infra.youtube_content',
    collectorVersion: 'net-1',
    parserVersion: 'youtube-adapter-1',
    adapterStrategy: 'single',
    refreshPolicy: { cooldownMinutes: 30, dailyQuota: null },
  },
  {
    // Wave 1：TikTok 官方商业内容研究接口骨架。未获官方研究权限前保持
    // pending_config（「需要系统数据服务配置」），不得写成「未观察到广告」或「未接入」。
    code: 'tiktok_commercial_content',
    displayName: '广告活动（TikTok 商业内容）',
    dimension: 'ad_campaigns',
    adapter: 'tiktok',
    adapters: ['tiktok'],
    provider: 'tiktok_research_api',
    supportedObjects: { objectTypes: ['brand_channel', 'advertiser_name'], platforms: ['tiktok'], markets: 'public_api' },
    access: 'official_commercial_api',
    requiresServerCredential: true,
    configKeys: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
    measurementMethod: 'official_disclosure', // P0-3 整改 r3：平台公开披露，非数据服务估算
    manualRefresh: true,
    autoInspect: false,
    freshnessSlaHours: 72,
    maturity: 'pending_config',
    limitations: '仅展示 Commercial Content API 实际返回的公开广告字段（素材 URL/广告主/投放日期/状态/状态说明/reach 区间标签）；覆盖范围受官方支持国家限制（' + TikTokAdLib.COVERAGE_SCOPE_TEXT + '），未覆盖国家不代表没有广告、不得显示为「未观察到广告」；广告花费、获客成本、ROI、转化率、GMV 不可观测，不推算（00 §17 冻结）',
    costAttributionKey: 'infra.tiktok_commercial_content',
    collectorVersion: 'net-1',
    parserVersion: 'tiktok-adapter-1',
    adapterStrategy: 'single',
    refreshPolicy: { cooldownMinutes: 60, dailyQuota: null },
  },
  {
    // Wave 1：公开评论页发现与可验证采集（复用系统搜索链 + robots/SSRF 合规门）。
    // 不接无授权的封闭评论 API（Trustpilot 等商业 API 未来以独立 provider 接入）。
    code: 'public_reviews',
    displayName: '口碑与评论（公开页面）',
    dimension: 'reviews_reputation',
    adapter: 'reviews',
    adapters: ['reviews'],
    provider: 'public_web_reviews',
    supportedObjects: { objectTypes: ['official_domain', 'public_review_page'], platforms: ['public_web'], markets: 'public_web' },
    access: 'public_web_page',
    requiresServerCredential: false,
    configKeys: ['SERPER_API_KEY', 'TAVILY_API_KEY', 'BRAVE_API_KEY', 'BOCHA_API_KEY'],
    measurementMethod: 'public_source_observation',
    manualRefresh: true,
    autoInspect: false,
    freshnessSlaHours: 72,
    maturity: 'pending_config',
    limitations: '仅展示通过 robots/公开访问/品牌归属校验页面的评论片段、评分字段与来源；样本量与采集时间范围必须明示，不将页面样本表述为「全网口碑」（05 §9）',
    costAttributionKey: 'infra.public_reviews',
    collectorVersion: 'net-1',
    parserVersion: 'reviews-adapter-1',
    adapterStrategy: 'single',
    refreshPolicy: { cooldownMinutes: 60, dailyQuota: null },
  },
  {
    // Wave 1：DataForSEO Labs Trends（官方 REST 契约直连；CommonJS 零依赖架构
    // 下不引 TS SDK，按官方契约受控请求——Basic auth，凭据不进快照/日志）。
    // licensed_estimate：结果为数据服务估算，永不做平台原始事实表述。
    code: 'dataforseo_trends',
    displayName: '搜索与热度（DataForSEO Trends）',
    dimension: 'search_interest',
    adapter: 'dataforseo',
    adapters: ['dataforseo'],
    provider: 'dataforseo_labs_trends',
    supportedObjects: { objectTypes: ['keyword', 'official_domain'], platforms: ['dataforseo'], markets: 'licensed_api' },
    access: 'licensed_data_service',
    requiresServerCredential: true,
    configKeys: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'],
    measurementMethod: 'licensed_estimate',
    manualRefresh: true,
    autoInspect: false,
    freshnessSlaHours: 168,
    maturity: 'pending_config',
    limitations: '仅展示 DataForSEO 实际返回的趋势/地区/时间段字段，一律标注「数据服务估算」（licensed_estimate）；兴趣 ≠ 销量 ≠ 绝对搜索量，不把搜索摘要当作热度（05 §9）',
    costAttributionKey: 'infra.dataforseo_trends',
    collectorVersion: 'net-1',
    parserVersion: 'dataforseo-adapter-1',
    adapterStrategy: 'single',
    refreshPolicy: { cooldownMinutes: 360, dailyQuota: null },
  },
]);

const CAPABILITY_BY_CODE = new Map(CAPABILITIES.map(c => [c.code, c]));

function getCapability(code) { return CAPABILITY_BY_CODE.get(String(code || '')) || null; }
function listCapabilities() { return CAPABILITIES.slice(); }
function listDimensions() { return DIMENSIONS.slice(); }
function capabilitiesByDimension(dimension) {
  return CAPABILITIES.filter(c => c.dimension === dimension);
}
function dimensionOf(code) {
  const c = getCapability(code);
  return c ? c.dimension : null;
}

// 对象是否支持该能力。brandCtx: { url, isShopify }（由调用方从竞品档案派生）。
// 返回 { supported, reasonCode, reasonText }——reasonCode 沿用 00 §2.1 词表。
function supportsForBrand(capabilityCode, brandCtx) {
  const cap = getCapability(capabilityCode);
  if (!cap) return { supported: false, reasonCode: 'not_supported', reasonText: '能力不存在' };
  if (cap.maturity === 'not_integrated') {
    return { supported: false, reasonCode: 'source_not_integrated', reasonText: '数据源尚未接入，暂时无法采集该维度' };
  }
  if (cap.maturity === 'pending_config') {
    // P0-2 整改 r2：实现完成未验证——结构条件满足即允许发起真实采集；
    // 运行门控（凭据就绪/验证状态）由 source-readiness 在采集入口统一管理。
    const b2 = brandCtx || {};
    if (cap.code === 'youtube_content' || cap.code === 'dataforseo_trends' || cap.code === 'tiktok_commercial_content') {
      if (!b2.name && !b2.url) return { supported: false, reasonCode: 'not_applicable', reasonText: '该品牌缺少可用于查询的名称或官网地址' };
      return { supported: true, reasonCode: null, reasonText: null };
    }
    if (cap.code === 'public_reviews') {
      if (!b2.url) return { supported: false, reasonCode: 'not_applicable', reasonText: '该品牌没有可发现评论页的官网地址' };
      return { supported: true, reasonCode: null, reasonText: null };
    }
    return { supported: false, reasonCode: 'source_pending_config', reasonText: '数据服务暂不可用，请稍后再试。' };
  }
  const b = brandCtx || {};
  if (cap.code === 'shopify_catalog' || cap.code === 'shopify_collections') {
    if (!b.url) return { supported: false, reasonCode: 'not_applicable', reasonText: '该品牌没有可采集的官网地址' };
    if (!b.isShopify) {
      // SC-06：专项目录接口不可用 ≠「官网不支持」。官网资料能力独立存在，
      // 这里只如实说明 Shopify 公开商品目录接口这一专项能力当前不可用。
      return { supported: false, reasonCode: 'not_supported', reasonText: 'Shopify 公开商品目录不可用' };
    }
    return { supported: true, reasonCode: null, reasonText: null };
  }
  if (cap.code === 'official_site_profile' || cap.code === 'public_site_products') {
    // 通用官网公开页面能力：任何有官网地址的品牌都可尝试（不要求 Shopify）
    if (!b.url) return { supported: false, reasonCode: 'not_applicable', reasonText: '该品牌没有可采集的官网地址' };
    return { supported: true, reasonCode: null, reasonText: null };
  }
  return { supported: false, reasonCode: 'not_supported', reasonText: '该能力暂不支持此对象类型' };
}

// capability → adapters[]（SC-02 §3 整改：dimension → capabilities[] → adapters[]，
// 投影层不得只读 caps[0]，也不得假定一能力只有一个 adapter）
function adaptersForCapability(code) {
  const cap = getCapability(code);
  if (!cap || !Array.isArray(cap.adapters) || !cap.adapters.length) return [];
  return cap.adapters.slice();
}

// Registry 完整性自检（T1 锁定；调用方为测试与启动自检）
function assertRegistryIntegrity() {
  const errs = [];
  const seenCodes = new Set();
  for (const cap of CAPABILITIES) {
    const req = ['code', 'displayName', 'dimension', 'adapter', 'provider', 'supportedObjects',
      'access', 'requiresServerCredential', 'manualRefresh', 'autoInspect', 'freshnessSlaHours',
      'maturity', 'limitations', 'costAttributionKey', 'collectorVersion', 'parserVersion',
      'refreshPolicy', 'adapterStrategy'];
    for (const k of req) {
      if (!(k in cap)) errs.push(cap.code + ': missing field ' + k);
    }
    if (!DIMENSION_CODES.has(cap.dimension)) errs.push(cap.code + ': unknown dimension ' + cap.dimension);
    if (!MATURITY.has(cap.maturity)) errs.push(cap.code + ': unknown maturity ' + cap.maturity);
    if (cap.maturity === 'ga') {
      if (!cap.adapterStrategy) errs.push(cap.code + ': ga capability requires adapterStrategy');
    } else if (cap.maturity === 'pending_config') {
      // Wave 1：结构就绪但未通过真实 staging 验证——契约要件必须显式齐备，
      // 升级 ga 由 live-source-smoke 真实成功请求触发（人工改 Registry）。
      if (!cap.adapter || !cap.provider) errs.push(cap.code + ': pending_config capability requires adapter+provider');
      if (!Array.isArray(cap.adapters) || !cap.adapters.includes(cap.adapter)) {
        errs.push(cap.code + ': pending_config capability adapters[] must include primary adapter');
      }
      if (!cap.adapterStrategy) errs.push(cap.code + ': pending_config capability requires adapterStrategy');
      if (!Array.isArray(cap.configKeys) || !cap.configKeys.length || !cap.configKeys.every(k => typeof k === 'string' && k.length)) {
        errs.push(cap.code + ': pending_config capability requires configKeys（smoke 与状态展示依据）');
      }
      if (!cap.measurementMethod) errs.push(cap.code + ': pending_config capability requires measurementMethod');
      if (!cap.freshnessSlaHours) errs.push(cap.code + ': pending_config capability requires freshnessSlaHours');
      if (!cap.manualRefresh && !cap.autoInspect) errs.push(cap.code + ': pending_config capability must allow refresh or inspect');
      if (cap.refreshPolicy && !(cap.refreshPolicy.cooldownMinutes > 0)) {
        errs.push(cap.code + ': pending_config capability requires cooldownMinutes > 0');
      }
    } else if (cap.maturity === 'pending_verification') {
      // SC-06 r2：能力已实现但尚无真实验证——适配器与刷新策略必须就绪（否则连验证都跑不了），
      // 但不得要求凭据（公开来源），也不得据此宣称已接入。
      if (!cap.adapter || !cap.provider) errs.push(cap.code + ': pending_verification capability requires adapter+provider');
      if (!Array.isArray(cap.adapters) || !cap.adapters.includes(cap.adapter)) {
        errs.push(cap.code + ': pending_verification capability adapters[] must include primary adapter');
      }
      if (!cap.adapterStrategy) errs.push(cap.code + ': pending_verification capability requires adapterStrategy');
      if (cap.requiresServerCredential) errs.push(cap.code + ': pending_verification applies to credential-free public sources');
      if (!cap.manualRefresh && !cap.autoInspect) errs.push(cap.code + ': pending_verification capability must allow refresh or inspect');
      if (!cap.measurementMethod) errs.push(cap.code + ': pending_verification capability requires measurementMethod');
      if (!cap.freshnessSlaHours) errs.push(cap.code + ': pending_verification capability requires freshnessSlaHours');
      if (cap.refreshPolicy && !(cap.refreshPolicy.cooldownMinutes > 0)) {
        errs.push(cap.code + ': pending_verification capability requires cooldownMinutes > 0');
      }
    } else if (cap.adapterStrategy != null) errs.push(cap.code + ': not_integrated capability must not declare adapterStrategy');
    if (cap.maturity === 'ga') {
      if (!cap.adapter || !cap.provider) errs.push(cap.code + ': ga capability requires adapter+provider');
      if (!Array.isArray(cap.adapters) || !cap.adapters.includes(cap.adapter)) {
        errs.push(cap.code + ': ga capability adapters[] must include primary adapter');
      }
      if (!cap.manualRefresh && !cap.autoInspect) errs.push(cap.code + ': ga capability must allow refresh or inspect');
      if (!cap.freshnessSlaHours) errs.push(cap.code + ': ga capability requires freshnessSlaHours');
    } else if (cap.maturity !== 'pending_config' && cap.maturity !== 'pending_verification') {
      if (cap.adapter || cap.provider) errs.push(cap.code + ': not_integrated capability must not declare adapter/provider');
      if (Array.isArray(cap.adapters) && cap.adapters.length) errs.push(cap.code + ': not_integrated capability must not declare adapters[]');
      if (cap.manualRefresh || cap.autoInspect) errs.push(cap.code + ': not_integrated capability must not allow refresh/inspect');
      if (Array.isArray(cap.configKeys) && cap.configKeys.length) errs.push(cap.code + ': not_integrated capability must not declare configKeys');
    }
    // refreshPolicy：cooldownMinutes ≥ 0；ga 能力必须有冷却保护（>0），防无限刷新
    const rp = cap.refreshPolicy;
    if (!rp || typeof rp.cooldownMinutes !== 'number' || rp.cooldownMinutes < 0) {
      errs.push(cap.code + ': invalid refreshPolicy.cooldownMinutes');
    } else if (cap.maturity === 'ga' && rp.cooldownMinutes <= 0) {
      errs.push(cap.code + ': ga capability requires cooldownMinutes > 0');
    }
    if (rp && !(rp.dailyQuota == null || (Number.isInteger(rp.dailyQuota) && rp.dailyQuota > 0))) {
      errs.push(cap.code + ': invalid refreshPolicy.dailyQuota (null or positive integer)');
    }
    if (seenCodes.has(cap.code)) errs.push('duplicate capability code ' + cap.code);
    seenCodes.add(cap.code);
  }
  // 每个维度至少一个能力条目（含占位），保证五维总览恒可渲染
  for (const d of DIMENSIONS) {
    if (!CAPABILITIES.some(c => c.dimension === d.code)) errs.push('dimension ' + d.code + ' has no capability entry');
  }
  return { ok: errs.length === 0, errors: errs, registryVersion: REGISTRY_VERSION };
}

// 用户可见视图（剔除内部字段：provider 内部名/版本键/成本细节 → 04 §20 边界）
function userView(cap) {
  return {
    code: cap.code,
    displayName: cap.displayName,
    dimension: cap.dimension,
    supportedObjects: cap.supportedObjects,
    manualRefresh: cap.manualRefresh,
    autoInspect: cap.autoInspect,
    freshnessSlaHours: cap.freshnessSlaHours,
    maturity: cap.maturity,
    limitations: cap.limitations,
    refreshPolicy: cap.refreshPolicy,
    // Wave 1：产品面声明（非内部成本细节）——凭据要求与测量方法供状态展示与
    // 「数据服务估算/公开来源观察」标签
    configKeys: Array.isArray(cap.configKeys) ? cap.configKeys.slice() : null,
    measurementMethod: cap.measurementMethod || null,
  };
}
// 管理员视图（全字段）
function adminView(cap) { return Object.assign({}, cap); }

module.exports = {
  REGISTRY_VERSION, DIMENSIONS, DIMENSION_CODES,
  getCapability, listCapabilities, listDimensions, capabilitiesByDimension, dimensionOf,
  supportsForBrand, adaptersForCapability, assertRegistryIntegrity, userView, adminView,
};
