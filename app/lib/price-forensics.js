'use strict';
// =============================================================================
// 价格主动取证（PRD整改 P0 #2 · L2 取证器）
//
// 痛点：Shopify 站点能靠 products.json 结构化实抓（verified）；但非 Shopify 站
// （自研站 / WooCommerce / Squarespace / 官网单页）的价格通常只能靠 LLM 从证据
// 文本里"估"，basis=inferred，无来源 URL，不可核验。
//
// 本模块职责：当站点非 Shopify 但官网正文里出现了标价时，用正则主动把单价抠出来，
// 并**携带来源 URL**（官网正文页），使"非 Shopify 站有售价 → 必抓（带 URL）"成立。
//
// 设计红线：
//   1) 纯函数可单测，不依赖网络；网络抓取由调用方负责。
//   2) 只认"货币符号/代码 + 数字"形态，过滤 > 100 万 的异常值（营收/市值误命中）。
//   3) 默认把 ¥ 归为 CNY；若文本出现 JPY 代码则尊重之。跨币种不换算（信任红线）。
//   4) 提取出的价格是"候选"，最终是否采用由调用方结合 LLM 结论裁决（不强行覆盖）。
// =============================================================================

const SYMBOL_TO_CODE = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'CNY' };
const CODE_SET = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'AUD', 'CAD'];
// 货币符号/代码 与 数字 两种顺序都支持：符号前置（\$29.99）或后置（39,90 €）。
const PRICE_RE = /(?:(\$|€|£|¥|USD|EUR|GBP|JPY|CNY|AUD|CAD)\s?([\d][\d.,]*))|(([\d][\d.,]*)\s?(\$|€|£|¥|USD|EUR|GBP|JPY|CNY|AUD|CAD))/gi;
const MAX_UNIT_PRICE = 1_000_000; // 超过视为非单价（营收/市值/融资额），剔除

function round2(n) { return Math.round(n * 100) / 100; }

// 把含千分位/小数逗号的原始数字串规范为 JS number。
// 规则：逗号后置仅 1-2 位数字 → 视为小数点；否则逗号视为千分位。
function normalizeNumber(raw) {
  if (!raw) return NaN;
  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  if (hasComma && hasDot) {
    // 两种分隔符并存：最后一个出现的为小数位
    return parseFloat(raw.replace(/,/g, (m, off) => (off === raw.lastIndexOf(',') ? '.' : '')));
  }
  if (hasComma) {
    const after = raw.slice(raw.lastIndexOf(',') + 1);
    if (/^\d{1,2}$/.test(after)) return parseFloat(raw.replace(',', '.')); // 39,90 / 1,5 → 小数
    return parseFloat(raw.replace(/,/g, '')); // 1,000,000 → 千分位
  }
  return parseFloat(raw);
}

// 从一段文本提取价格候选（纯函数）。
// text: 抓取到的页面文本（stripHtml 后更佳）；preferCurrency: 可选，优先返回该币种。
// 返回 [{ value:number, currency:string, snippet:string }]，去重后按出现顺序。
function extractPrices(text, preferCurrency) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  let m;
  PRICE_RE.lastIndex = 0;
  while ((m = PRICE_RE.exec(text)) !== null) {
    const currency = m[1] ? (SYMBOL_TO_CODE[m[1].toUpperCase()] || (CODE_SET.includes(m[1].toUpperCase()) ? m[1].toUpperCase() : null))
                          : (SYMBOL_TO_CODE[m[5].toUpperCase()] || (CODE_SET.includes(m[5].toUpperCase()) ? m[5].toUpperCase() : null));
    const rawNum = m[2] != null ? m[2] : m[4];
    if (!currency || rawNum == null) continue;
    const num = normalizeNumber(rawNum);
    if (!(num > 0)) continue;
    if (num > MAX_UNIT_PRICE) continue; // 过滤营收/市值级误命中
    const key = currency + ':' + round2(num);
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet = text.slice(Math.max(0, m.index - 24), m.index + m[0].length + 24).replace(/\s+/g, ' ').trim();
    out.push({ value: round2(num), currency, snippet });
  }
  if (preferCurrency) {
    const pref = out.filter(p => p.currency === preferCurrency);
    return pref.length ? pref : out;
  }
  return out;
}

// 把提取结果收敛为单价点数组（去重、排序、截断），供 comp.pricePoints 复用。
function toPricePoints(prices, limit) {
  const nums = prices.map(p => p.value).filter(n => n > 0);
  const uniq = Array.from(new Set(nums.map(n => Math.round(n))));
  uniq.sort((a, b) => a - b);
  return limit ? uniq.slice(0, limit) : uniq;
}

module.exports = { extractPrices, toPricePoints, SYMBOL_TO_CODE, MAX_UNIT_PRICE };
