'use strict';
// ============================================================
// research/vocab.js —— 维度词表与平台集解析（与前端推理共用）
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// ============================================================
const Rel = require('../lib/relationship.js');

// ---------- 维度词表（与前端推理共用） ----------
const CHANNELS = ['tiktokShop', 'amazon', 'shopifyDTC', 'xiaohongshu', 'instagramShop', 'etsy', 'offlineRetail', 'tmallJD'];
// 需"具体店铺/账号证据"的平台型渠道：深研时做品牌×渠道定向探测，避免泛搜索漏判为缺席
const DIRECT_PROBE = { tiktokShop: 'TikTok Shop', etsy: 'Etsy', amazon: 'Amazon' };
// 目标人群：全赛道自由文本（不再写死潮玩人群词表）；AI 按赛道抽取，渲染层兜底展示
const AUDIENCES = [];
const REGIONS = ['us', 'uk', 'eu', 'cn', 'jp', 'sea'];
// 平台分组：供前端"调研平台"多选 + 后端按平台集收缩研究/显示范围
const OVERSEAS_PLATFORMS = ['amazon', 'shopifyDTC', 'tiktokShop', 'instagramShop', 'etsy'];
const CN_PLATFORMS = ['tmallJD', 'xiaohongshu'];
const GLOBAL_PLATFORMS = ['offlineRetail'];
// 由地域推导默认平台集：PRD 目标=海外 Shopify → 无地域或含任一海外地域⇒海外平台；含 cn⇒加国内平台。
function platformsFromRegions(regions) {
  const set = new Set(GLOBAL_PLATFORMS);
  const hasOverseas = (regions || []).some(r => ['us', 'uk', 'eu', 'jp', 'sea'].includes(r));
  if (!regions || !regions.length || hasOverseas) OVERSEAS_PLATFORMS.forEach(p => set.add(p));
  if ((regions || []).includes('cn')) CN_PLATFORMS.forEach(p => set.add(p));
  return Array.from(set).filter(p => CHANNELS.includes(p));
}
// 解析平台集：显式勾选优先；否则由地域推导。保证只含合法渠道键。
function resolvePlatforms(intentLike) {
  const i = intentLike || {};
  if (Array.isArray(i.platforms) && i.platforms.length) return i.platforms.filter(p => CHANNELS.includes(p));
  return platformsFromRegions(i.regions);
}
// 种草声量中文标签（content/hybrid 渠道展示用）
function seedingLabel(v) { return ({ high: '高', medium: '中', low: '低', none: '无' })[v] || (v || '未知'); }
const PRICE_BANDS = ['mass', 'mid', 'premium', 'ultra'];
// 细粒度维度（空白推理用，解决"一搜就都在做"的粗粒度问题）
const CONTENT_FORMS = ['shortVideo', 'livestream', 'ugc', 'tutorial', 'unboxing', 'meme'];
const COLLAB_TYPES = ['ipCollab', 'artistCollab', 'brandCollab', 'celebrity'];
const FULFILLMENT = ['dropship', 'madeToOrder', 'printOnDemand', 'localWarehouse', 'selfFactory'];
// 受控词表：卖点 / 销售策略（LLM 只能多选，不许自由文本 —— 否则矩阵对不齐）
const { SELLING_POINTS, SP_LABEL, TACTICS, CURRENCY_BY_REGION, CURRENCY_SYMBOL, marketCurrency, SP_MAX, SP_CUSTOM_MAX, normalizeProfile, normalizeIntent, priceRangeOf, computeRelationship, curSym, fmtMoney, CURRENCY_PATTERNS, detectCurrency, LADDER_THRESHOLDS, priceLadder } = Rel;

// 产品品类：全赛道自由文本（已废弃潮玩词表 CATEGORIES / CATEGORY_KEYWORDS 的写死判定）。
// 空数组表示品类不再走受控词表，由 AI 按赛道自由抽取，深研层的词表消毒进入自由文本模式。
const CATEGORIES = [];

module.exports = { CHANNELS, DIRECT_PROBE, AUDIENCES, REGIONS, OVERSEAS_PLATFORMS, CN_PLATFORMS, GLOBAL_PLATFORMS, platformsFromRegions, resolvePlatforms, seedingLabel, PRICE_BANDS, CONTENT_FORMS, COLLAB_TYPES, FULFILLMENT, SELLING_POINTS, SP_LABEL, TACTICS, CURRENCY_BY_REGION, CURRENCY_SYMBOL, marketCurrency, SP_MAX, SP_CUSTOM_MAX, normalizeProfile, normalizeIntent, priceRangeOf, computeRelationship, curSym, fmtMoney, CURRENCY_PATTERNS, detectCurrency, LADDER_THRESHOLDS, priceLadder, CATEGORIES };
