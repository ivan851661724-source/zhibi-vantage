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

// SC-02 §2：维度 = 产品层分组（冻结五值；映射 05 §1 Capability Map）
const DIMENSIONS = Object.freeze([
  { code: 'website_products', displayName: '官网与商品' },
  { code: 'social_content', displayName: '社媒内容' },
  { code: 'ad_campaigns', displayName: '广告活动' },
  { code: 'reviews_reputation', displayName: '口碑与评论' },
  { code: 'search_interest', displayName: '搜索与热度' },
]);
const DIMENSION_CODES = new Set(DIMENSIONS.map(d => d.code));

// maturity 词表（05 §17 GA Gate；not_integrated = 未接入，不得宣称能力）
const MATURITY = new Set(['ga', 'not_integrated']);

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
    code: 'social_content',
    displayName: '社媒内容',
    dimension: 'social_content',
    adapter: null,
    adapters: [],
    provider: null,
    supportedObjects: { objectTypes: [], platforms: [], markets: 'none' },
    access: null,
    requiresServerCredential: false,
    manualRefresh: false,
    autoInspect: false,
    freshnessSlaHours: null,
    maturity: 'not_integrated',
    limitations: '数据源尚未接入；本条目仅为维度占位，不宣称任何采集能力（05 §8 门槛）',
    costAttributionKey: null,
    collectorVersion: null,
    parserVersion: null,
    adapterStrategy: null,
    refreshPolicy: { cooldownMinutes: 0, dailyQuota: null },
  },
  {
    code: 'ad_activity',
    displayName: '广告活动',
    dimension: 'ad_campaigns',
    adapter: null,
    adapters: [],
    provider: null,
    supportedObjects: { objectTypes: [], platforms: [], markets: 'none' },
    access: null,
    requiresServerCredential: false,
    manualRefresh: false,
    autoInspect: false,
    freshnessSlaHours: null,
    maturity: 'not_integrated',
    limitations: '广告数据源尚未接入（05 §1 P1 Ad Activity 占位）',
    costAttributionKey: null,
    collectorVersion: null,
    parserVersion: null,
    adapterStrategy: null,
    refreshPolicy: { cooldownMinutes: 0, dailyQuota: null },
  },
  {
    code: 'review_rating',
    displayName: '口碑与评论',
    dimension: 'reviews_reputation',
    adapter: null,
    adapters: [],
    provider: null,
    supportedObjects: { objectTypes: [], platforms: [], markets: 'none' },
    access: null,
    requiresServerCredential: false,
    manualRefresh: false,
    autoInspect: false,
    freshnessSlaHours: null,
    maturity: 'not_integrated',
    limitations: '评论数据源尚未接入（05 §1 P1 Review/Rating 占位）',
    costAttributionKey: null,
    collectorVersion: null,
    parserVersion: null,
    adapterStrategy: null,
    refreshPolicy: { cooldownMinutes: 0, dailyQuota: null },
  },
  {
    code: 'search_interest',
    displayName: '搜索与热度',
    dimension: 'search_interest',
    adapter: null,
    adapters: [],
    provider: null,
    supportedObjects: { objectTypes: [], platforms: [], markets: 'none' },
    access: null,
    requiresServerCredential: false,
    manualRefresh: false,
    autoInspect: false,
    freshnessSlaHours: null,
    maturity: 'not_integrated',
    limitations: '搜索兴趣源尚未接入（05 §1 P2 Search Interest 占位）；兴趣 ≠ 销量 ≠ 绝对搜索量（05 §9）',
    costAttributionKey: null,
    collectorVersion: null,
    parserVersion: null,
    adapterStrategy: null,
    refreshPolicy: { cooldownMinutes: 0, dailyQuota: null },
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
  const b = brandCtx || {};
  if (cap.code === 'shopify_catalog' || cap.code === 'shopify_collections') {
    if (!b.url) return { supported: false, reasonCode: 'not_applicable', reasonText: '该品牌没有可采集的官网地址' };
    if (!b.isShopify) return { supported: false, reasonCode: 'not_supported', reasonText: '该官网暂未识别出 Shopify 公开目录接口，此维度暂不支持' };
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
    } else if (cap.adapterStrategy != null) errs.push(cap.code + ': not_integrated capability must not declare adapterStrategy');
    if (cap.maturity === 'ga') {
      if (!cap.adapter || !cap.provider) errs.push(cap.code + ': ga capability requires adapter+provider');
      if (!Array.isArray(cap.adapters) || !cap.adapters.includes(cap.adapter)) {
        errs.push(cap.code + ': ga capability adapters[] must include primary adapter');
      }
      if (!cap.manualRefresh && !cap.autoInspect) errs.push(cap.code + ': ga capability must allow refresh or inspect');
      if (!cap.freshnessSlaHours) errs.push(cap.code + ': ga capability requires freshnessSlaHours');
    } else {
      if (cap.adapter || cap.provider) errs.push(cap.code + ': not_integrated capability must not declare adapter/provider');
      if (Array.isArray(cap.adapters) && cap.adapters.length) errs.push(cap.code + ': not_integrated capability must not declare adapters[]');
      if (cap.manualRefresh || cap.autoInspect) errs.push(cap.code + ': not_integrated capability must not allow refresh/inspect');
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
  };
}
// 管理员视图（全字段）
function adminView(cap) { return Object.assign({}, cap); }

module.exports = {
  REGISTRY_VERSION, DIMENSIONS, DIMENSION_CODES,
  getCapability, listCapabilities, listDimensions, capabilitiesByDimension, dimensionOf,
  supportsForBrand, adaptersForCapability, assertRegistryIntegrity, userView, adminView,
};
