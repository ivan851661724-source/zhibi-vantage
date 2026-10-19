'use strict';
// ============================================================
// lib/tiktok-adlib.js —— TikTok 官方广告库事实唯一源（R4.14）
// ------------------------------------------------------------
// 事实依据（2026-10-19 逐条核对官方文档）：
//   · Query Ads：https://developers.tiktok.com/doc/commercial-content-api-query-ads
//   · Supported Countries：https://developers.tiktok.com/doc/commercial-content-api-supported-countries
//   · OAuth（Client Access Token / grant_type=client_credentials，服务器到服务器）：
//     https://developers.tiktok.com/doc/client-access-token-management
//     （官方文档站 OAuth 分组下的「Client Access Token Management」页；
//      不使用 user authorization / authorization_code 文档——本实现没有用户授权环节）
//
// 🔴 硬规则（本轮整改动因）：
//   1. 覆盖国家数量**只能**由 SUPPORTED_COUNTRIES.length 派生。任何模块想显示
//      「共 N 国」必须读 COUNTRY_COUNT / COVERAGE_SCOPE_TEXT，禁止再手写数字
//      （r3 代码列表实为 32 项，文案却写成 30——手写常量与实际列表脱钩）。
//   2. 请求字段数只能由 AD_FIELDS.length 派生；AD_FIELDS ⊆ AD_FIELD_WHITELIST，
//      白名单逐字来自官方文档，不得为凑数量加入未确认字段。
//   3. 本模块零 IO / 零依赖 / 零副作用：Registry（纯数据）与 adapter、
//      smoke 脚本、前端投影共用同一份事实。
//   4. 市场归一**只认国家**：区域 / 多市场描述一律 unknown，禁止地理推断
//      （r4 曾把「北美」映射为 US）。
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
// 规则（R4.15 修正）：
//   ① 只接受 ISO-3166-1 alpha-2 **国家**代码，或明确的国家名称
//      （US / United States / 美国、DE / Germany / 德国 …）；
//   ② 区域 / 多市场描述（北美、North America、欧洲、EU、全球、Global、多地区 …）
//      一律返回 null（unknown）——「北美 ≠ 美国」，EU 也不是国家代码；
//   ③ 无法确定一律 null。unknown 既不判「无覆盖」，也不判「没有广告」。
// 历史缺陷（r4）：'北美' / 'North America' / 'AMERICA' 曾被映射为 US——
// 把区域推断成单一国家，会让多市场品牌的覆盖判断失真。
const REGION_OR_MULTI_MARKET = Object.freeze([
  // 中文区域 / 多市场
  '北美', '北美洲', '北美地区', '南美', '拉美', '拉丁美洲', '美洲', '中美', '中南美',
  '欧洲', '欧盟', '欧亚', '亚太', '亚太地区', '东南亚', '南亚', '东亚', '中东', '海湾地区',
  '非洲', '大洋洲', '全球', '国际化', '海外', '多地区', '多市场', '多国', '区域市场',
  // 英文区域 / 多市场
  'NORTH AMERICA', 'NORTHERN AMERICA', 'NA', 'AMERICA', 'THE AMERICAS', 'LATAM', 'LATIN AMERICA',
  'SOUTH AMERICA', 'CENTRAL AMERICA',
  'EUROPE', 'EU', 'EUROPEAN UNION', 'EEA', 'EMEA',
  'APAC', 'AP', 'ASIA PACIFIC', 'SOUTHEAST ASIA', 'SEA', 'ASIA', 'EAST ASIA', 'SOUTH ASIA',
  'MIDDLE EAST', 'MENA', 'AFRICA', 'OCEANIA',
  'GLOBAL', 'WORLDWIDE', 'WORLD', 'WW', 'INTERNATIONAL', 'MULTI-REGION', 'MULTIREGION',
  'MULTI-MARKET', 'MULTIMARKET', 'MULTIPLE MARKETS', 'REGIONAL',
]);
const REGION_SET = new Set(REGION_OR_MULTI_MARKET);

// 明确国家名称 → ISO2（只放国家；任何区域词都不得出现在这里）
const MARKET_ALIASES = Object.freeze({
  // 未覆盖但需要判 out_of_coverage 的主要市场
  'UNITED STATES': 'US', 'UNITED STATES OF AMERICA': 'US', USA: 'US', '美国': 'US',
  'CANADA': 'CA', '加拿大': 'CA', 'MEXICO': 'MX', '墨西哥': 'MX',
  'AUSTRALIA': 'AU', '澳大利亚': 'AU', 'JAPAN': 'JP', '日本': 'JP',
  'CHINA': 'CN', '中国': 'CN', 'SOUTH KOREA': 'KR', '韩国': 'KR',
  'INDIA': 'IN', '印度': 'IN', 'BRAZIL': 'BR', '巴西': 'BR', 'SINGAPORE': 'SG', '新加坡': 'SG',
  // 官方覆盖国家（EU27 + NO/IS/LI + GB/CH）
  'AUSTRIA': 'AT', '奥地利': 'AT',
  'BELGIUM': 'BE', '比利时': 'BE',
  'BULGARIA': 'BG', '保加利亚': 'BG',
  'CROATIA': 'HR', '克罗地亚': 'HR',
  'CYPRUS': 'CY', '塞浦路斯': 'CY',
  'CZECHIA': 'CZ', 'CZECH REPUBLIC': 'CZ', '捷克': 'CZ',
  'DENMARK': 'DK', '丹麦': 'DK',
  'ESTONIA': 'EE', '爱沙尼亚': 'EE',
  'FINLAND': 'FI', '芬兰': 'FI',
  'FRANCE': 'FR', '法国': 'FR',
  'GERMANY': 'DE', 'DEUTSCHLAND': 'DE', '德国': 'DE',
  'GREECE': 'GR', '希腊': 'GR',
  'HUNGARY': 'HU', '匈牙利': 'HU',
  'IRELAND': 'IE', '爱尔兰': 'IE',
  'ITALY': 'IT', '意大利': 'IT',
  'LATVIA': 'LV', '拉脱维亚': 'LV',
  'LITHUANIA': 'LT', '立陶宛': 'LT',
  'LUXEMBOURG': 'LU', '卢森堡': 'LU',
  'MALTA': 'MT', '马耳他': 'MT',
  'NETHERLANDS': 'NL', 'HOLLAND': 'NL', '荷兰': 'NL',
  'POLAND': 'PL', '波兰': 'PL',
  'PORTUGAL': 'PT', '葡萄牙': 'PT',
  'ROMANIA': 'RO', '罗马尼亚': 'RO',
  'SLOVAKIA': 'SK', '斯洛伐克': 'SK',
  'SLOVENIA': 'SI', '斯洛文尼亚': 'SI',
  'SPAIN': 'ES', '西班牙': 'ES',
  'SWEDEN': 'SE', '瑞典': 'SE',
  'NORWAY': 'NO', '挪威': 'NO',
  'ICELAND': 'IS', '冰岛': 'IS',
  'LIECHTENSTEIN': 'LI', '列支敦士登': 'LI',
  'UNITED KINGDOM': 'GB', UK: 'GB', 'GREAT BRITAIN': 'GB', '英国': 'GB',
  'SWITZERLAND': 'CH', '瑞士': 'CH',
});

// ISO-3166-1 alpha-2 国家码形态校验：两位大写字母，且不是区域/保留码
// （EU / NA / AP 等虽为两位字母，但不是国家代码 → 走 unknown）
function looksLikeIso2(up) {
  if (!/^[A-Z]{2}$/.test(up)) return false;
  if (REGION_SET.has(up)) return false;
  return true;
}

function normalizeMarket(market) {
  const raw = String(market == null ? '' : market).trim();
  if (!raw) return null; // 空值 → unknown（不猜）
  const up = raw.toUpperCase();
  // ① 区域 / 多市场描述优先判 unknown（防止 '北美'/'EU' 被当成国家）
  if (REGION_SET.has(up) || REGION_SET.has(raw)) return null;
  // ② 明确国家名称（含 UK → GB 这类非 ISO2 但明确指国家的别名）
  if (MARKET_ALIASES[up]) return MARKET_ALIASES[up];
  if (MARKET_ALIASES[raw]) return MARKET_ALIASES[raw];
  // ③ ISO2 国家码（两位大写字母且非区域保留码）
  if (looksLikeIso2(up)) return up;
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
  REGION_OR_MULTI_MARKET, MARKET_ALIASES, normalizeMarket, marketCoverage, coverageNoteFor,
};
