'use strict';
// ============================================================
// lib/tiktok-adlib.js —— TikTok 官方广告库事实唯一源（R4.14）
// ------------------------------------------------------------
// 事实依据（2026-10-19 逐条核对官方文档）：
//   · Query Ads：https://developers.tiktok.com/doc/commercial-content-api-query-ads
//   · Supported Countries：https://developers.tiktok.com/doc/commercial-content-api-supported-countries
//   · OAuth（client_credentials）：https://developers.tiktok.com/doc/oauth-user-access-token-management
//
// 🔴 硬规则（本轮整改动因）：
//   1. 覆盖国家数量**只能**由 SUPPORTED_COUNTRIES.length 派生。任何模块想显示
//      「共 N 国」必须读 COUNTRY_COUNT / COVERAGE_SCOPE_TEXT，禁止再手写数字
//      （r3 代码列表实为 32 项，文案却写成 30——手写常量与实际列表脱钩）。
//   2. 请求字段数只能由 AD_FIELDS.length 派生；AD_FIELDS ⊆ AD_FIELD_WHITELIST，
//      白名单逐字来自官方文档，不得为凑数量加入未确认字段。
//   3. 本模块零 IO / 零依赖 / 零副作用：Registry（纯数据）与 adapter、
//      smoke 脚本、前端投影共用同一份事实。
// ============================================================

// ---------- 覆盖国家（官方 Supported Countries） ----------
// EU 27 国
const EU_27 = Object.freeze([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);
// EEA 补充 3 国（非 EU 成员）
const EEA_EXTRA = Object.freeze(['NO', 'IS', 'LI']);
// 欧洲其他 2 国
const EUROPE_EXTRA = Object.freeze(['GB', 'CH']);

const SUPPORTED_COUNTRIES = Object.freeze([].concat(EU_27, EEA_EXTRA, EUROPE_EXTRA));

// 唯一数量事实源：展示用的「共 N 国」一律拼这个常量
const COUNTRY_COUNT = SUPPORTED_COUNTRIES.length;

// 覆盖范围说明片段（Registry limitation / summary.coverageNote / 用户投影共用）
const COVERAGE_SCOPE_TEXT = 'EU 27 + NO/IS/LI + GB/CH，共 ' + COUNTRY_COUNT + ' 国，不含美国';

function isCountryCovered(code) {
  const c = String(code == null ? '' : code).trim().toUpperCase();
  if (!c) return false;
  return SUPPORTED_COUNTRIES.includes(c);
}

// ---------- 请求字段白名单（官方 Query Ads `fields` 参数，逐字） ----------
// 官方文档列出的完整白名单共 11 项（顺序同文档）：
//   ad.id / ad.first_shown_date / ad.last_shown_date / ad.status / ad.status_statement
//   ad.videos / ad.image_urls / ad.reach
//   advertiser.business_id / advertiser.business_name / advertiser.paid_for_by
const AD_FIELD_WHITELIST = Object.freeze([
  'ad.id',
  'ad.first_shown_date',
  'ad.last_shown_date',
  'ad.status',
  'ad.status_statement',
  'ad.videos',
  'ad.image_urls',
  'ad.reach',
  'advertiser.business_id',
  'advertiser.business_name',
  'advertiser.paid_for_by',
]);

// 本产品实际请求的字段：当前 = 官方白名单全覆盖。
// 若未来收敛字段，只允许从白名单内裁剪，且必须同步 SUMMARY 与前端渲染。
const AD_FIELDS = Object.freeze(AD_FIELD_WHITELIST.slice());

const AD_FIELDS_CSV = AD_FIELDS.join(',');
const AD_FIELD_COUNT = AD_FIELDS.length;

// ---------- 品牌市场归一（用于覆盖判定，不做地理猜测） ----------
// 只接受 ISO-3166-1 alpha-2 或明确别名；无法确定 → null（unknown，不判「无覆盖」）
const MARKET_ALIASES = Object.freeze({
  'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US', USA: 'US', AMERICA: 'US',
  '美国': 'US', '北美': 'US',
  'UNITED KINGDOM': 'GB', UK: 'GB', '英国': 'GB',
  'GERMANY': 'DE', DEUTSCHLAND: 'DE', '德国': 'DE',
  'FRANCE': 'FR', '法国': 'FR',
  'NETHERLANDS': 'NL', '荷兰': 'NL',
  'SPAIN': 'ES', '西班牙': 'ES',
  'ITALY': 'IT', '意大利': 'IT',
  'POLAND': 'PL', '波兰': 'PL',
  'SWEDEN': 'SE', '瑞典': 'SE',
  'CANADA': 'CA', '加拿大': 'CA',
  'AUSTRALIA': 'AU', '澳大利亚': 'AU',
  'JAPAN': 'JP', '日本': 'JP',
  'CHINA': 'CN', '中国': 'CN',
});

function normalizeMarket(market) {
  const raw = String(market == null ? '' : market).trim();
  if (!raw) return null;
  const up = raw.toUpperCase();
  if (/^[A-Z]{2}$/.test(up)) return up;
  if (MARKET_ALIASES[up]) return MARKET_ALIASES[up];
  if (MARKET_ALIASES[raw]) return MARKET_ALIASES[raw];
  return null;
}

// 品牌市场 × 官方覆盖 → 三态（covered / out_of_coverage / unknown）
// unknown 不等于无覆盖：信息不足时不替平台下结论。
function marketCoverage(market) {
  const code = normalizeMarket(market);
  if (!code) return { brandMarket: null, brandMarketCovered: null, coverageState: 'unknown' };
  const covered = isCountryCovered(code);
  return { brandMarket: code, brandMarketCovered: covered, coverageState: covered ? 'covered' : 'out_of_coverage' };
}

// 用户可见覆盖说明（唯一事实源拼装；不含内部码/凭据）
function coverageNoteFor(coverageState, brandMarket) {
  const base = 'TikTok 公开广告库（Commercial Content API）仅覆盖官方支持国家：' + COVERAGE_SCOPE_TEXT + '；未覆盖国家不代表没有广告。';
  if (coverageState === 'out_of_coverage') {
    return '该公开来源当前无覆盖：品牌主要市场 ' + String(brandMarket || '未知') +
      ' 不在 TikTok 官方支持国家范围内（当前覆盖 ' + COUNTRY_COUNT + ' 国，' + COVERAGE_SCOPE_TEXT + '）；'
      + '零结果不代表该市场没有广告。';
  }
  return base;
}

module.exports = {
  EU_27, EEA_EXTRA, EUROPE_EXTRA,
  SUPPORTED_COUNTRIES, COUNTRY_COUNT, COVERAGE_SCOPE_TEXT, isCountryCovered,
  AD_FIELD_WHITELIST, AD_FIELDS, AD_FIELDS_CSV, AD_FIELD_COUNT,
  MARKET_ALIASES, normalizeMarket, marketCoverage, coverageNoteFor,
};
