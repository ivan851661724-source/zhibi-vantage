'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/evidence.js —— 导出: sourceTier, deriveBasis, belongsToBrand
// ============================================================

const { domainOf } = require('./net.js');

// ============================================================
// L5 采信裁决层：来源分级写死在代码里，置信度由证据类型推导，不由 LLM 拍脑袋
// ============================================================
// 一级=平台店铺页/官方账号/官网正文；二级=社区口碑/媒体；三级=SEO聚合站（不入库）
const TIER1_PATTERNS = [/etsy\.com\/shop\//i, /amazon\.[a-z.]+\/stores?\//i, /tiktok\.com\/@/i, /instagram\.com\/[^/]+\/?$/i, /youtube\.com\/(@|channel\/)/i, /facebook\.com\/[^/]+\/?$/i];
const TIER2_DOMAINS = ['reddit.com', 'trustpilot.com', 'sitejabber.com', 'bbb.org', 'forbes.com', 'businessinsider.com', 'techcrunch.com', 'nytimes.com', 'wired.com', 'theverge.com', 'cnn.com', 'npr.org', 'retaildive.com', 'modernretail.co', 'glossy.co'];
const TIER3_PATTERNS = [/pinterest\./i, /top10/i, /best-?products/i, /rank(er|ings)/i, /coupon/i, /promo-?codes/i, /10best/i, /buyersguide/i, /\.blogspot\./i, /listicle/i];
function sourceTier(url, officialDomain) {
  const d = domainOf(url);
  if (!d) return 3;
  if (officialDomain && (d === officialDomain || d.endsWith('.' + officialDomain))) return 1;
  if (TIER1_PATTERNS.some(p => p.test(url))) return 1;
  if (TIER3_PATTERNS.some(p => p.test(url))) return 3;
  if (TIER2_DOMAINS.some(t => d === t || d.endsWith('.' + t))) return 2;
  return 2; // 未知域名默认二级（媒体/博客），靠交叉验证升降
}
// 由引用的证据推导 basis+confidence：一级→verified/high；≥2独立二级域→inferred/medium；单二级→inferred/low；无→unverified/low
function deriveBasis(cited) {
  if (!cited || !cited.length) return { basis: 'unverified', confidence: 'low' };
  const t1 = cited.filter(s => s.tier === 1);
  if (t1.length) return { basis: 'verified', confidence: 'high' };
  const t2domains = new Set(cited.filter(s => s.tier === 2).map(s => domainOf(s.url)));
  if (t2domains.size >= 2) return { basis: 'inferred', confidence: 'medium' };
  if (t2domains.size === 1) return { basis: 'inferred', confidence: 'low' };
  return { basis: 'unverified', confidence: 'low' };
}
// L4 归属裁决：一条结果属于该品牌 ⇔ 域名匹配锚点 或 文本含品牌名
function belongsToBrand(item, brandName, anchorDomain) {
  const url = item.url || '';
  if (anchorDomain && domainOf(url) === anchorDomain) return true;
  const name = (brandName || '').toLowerCase().trim();
  if (!name) return false;
  const hay = ((item.title || '') + ' ' + (item.content || '') + ' ' + url).toLowerCase();
  return hay.includes(name);
}


module.exports = { sourceTier, deriveBasis, belongsToBrand };
