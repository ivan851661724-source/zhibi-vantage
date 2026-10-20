'use strict';
// ============================================================
// research/site-profile.js —— 通用官网公开资料解析器（SC-06 二）
// ------------------------------------------------------------
// 规格依据：SC-06「非 Shopify 官网采集基础」：
//   · 只解析公开页面里实际出现的内容：canonical / title / 简介 /
//     OpenGraph / JSON-LD 公开的 Organization、Product、Offer、
//     AggregateRating / sitemap 与公开商品页 URL；
//   · 不从页面结构、文案、价格猜测销量、GMV、转化率、ROI、广告
//     花费或用户画像（00 §17 冻结；本模块只做「读出什么给什么」）；
//   · 零 IO、零副作用：网络由 source-adapter 经 Net.fetchPage（SSRF/
//     DNS rebinding/FetchGate/robots/重定向校验）完成后喂进来；
//   · 解析是尽力而为：单块 JSON-LD 损坏不影响其他块；所有输出字段
//     都来自页面真实字节，缺失即 null，不补猜。
// 大小纪律：输入在 adapter 层已限长；本模块内部再设各解析上限
//   （JSON-LD 总量 / 商品数 / sitemap loc 数），超限即截断并如实标记。
// ============================================================

const SITE_PROFILE_PARSER_VERSION = 'site-profile-1';

// 上限（防超大页面拖垮解析；均为防御性二次限制）
const LIMITS = Object.freeze({
  jsonLdBlocks: 12,          // 最多解析的 ld+json 块数
  jsonLdBytes: 512 * 1024,   // 单页 JSON-LD 总量上限
  jsonLdMaxDepth: 12,        // 遍历 @graph 的最大深度
  products: 200,             // JSON-LD Product 提取上限
  sitemapLocs: 2000,         // 单 sitemap 最多 loc
  productUrlSample: 60,      // sitemap 商品 URL 采样上限
});

// ---------- 基础工具 ----------

// HTML 实体解码（具名常见实体 + 数字实体；无 DOM 环境的安全实现）
const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß', ocirc: 'ô', ecirc: 'ê', laquo: '«', raquo: '»', deg: '°', euro: '€', pound: '£', copy: '©', reg: '®', trade: '™', middot: '·', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h) => { const c = parseInt(h, 16); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m; })
    .replace(/&#(\d+);/g, (m, d) => { const c = parseInt(d, 10); return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : m; })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] != null ? NAMED_ENTITIES[name.toLowerCase()] : m);
}

function cleanText(s, max) {
  const t = decodeEntities(String(s == null ? '' : s)).replace(/\s+/g, ' ').trim();
  return max ? t.slice(0, max) : t;
}

// 绝对化相对 URL；非法/非 http(s) 一律丢弃（不出协议相对漏洞）。
// 注意：Node 22 里 new URL(u, null) 会抛 Invalid URL——base 为空必须传 undefined。
function absUrl(u, base) {
  try {
    if (!u) return null;
    const s = String(u).trim();
    if (!s || s.startsWith('data:') || s.startsWith('javascript:')) return null;
    const b = base == null ? undefined : base;
    const url = new URL(s, b);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    return url.toString();
  } catch (e) { return null; }
}

// ---------- meta / link / OG 提取 ----------

// 单标签属性提取（属性顺序无关；引号可选——只服务公开静态页的真实写法）
function tagAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
  return attrs;
}

function extractHead(html, baseUrl) {
  const out = {
    canonical: null, title: null, metaDescription: null,
    ogTitle: null, ogDescription: null, ogImage: null, ogSiteName: null,
  };
  // title
  const tm = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(html);
  if (tm) out.title = cleanText(tm[1], 200) || null;
  // link[rel=canonical]
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(html))) {
    const a = tagAttrs(m[0]);
    if (String(a.rel || '').toLowerCase() === 'canonical' && a.href) {
      out.canonical = absUrl(a.href, baseUrl);
      break;
    }
  }
  // meta（description / og:*）
  const metaRe = /<meta\b[^>]*>/gi;
  while ((m = metaRe.exec(html))) {
    const a = tagAttrs(m[0]);
    const key = (a.property || a.name || '').toLowerCase();
    const content = a.content;
    if (!key || content == null) continue;
    if (key === 'description' && !out.metaDescription) out.metaDescription = cleanText(content, 300) || null;
    else if (key === 'og:title' && !out.ogTitle) out.ogTitle = cleanText(content, 200) || null;
    else if (key === 'og:description' && !out.ogDescription) out.ogDescription = cleanText(content, 300) || null;
    else if (key === 'og:image' && !out.ogImage) out.ogImage = absUrl(content, baseUrl);
    else if (key === 'og:site_name' && !out.ogSiteName) out.ogSiteName = cleanText(content, 120) || null;
  }
  return out;
}

// ---------- JSON-LD ----------

// 提取全部 ld+json 块的原始文本（不执行、不补全；截断块放弃解析）
function extractJsonLdScripts(html) {
  const blocks = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  let m; let total = 0;
  while ((m = re.exec(html)) && blocks.length < LIMITS.jsonLdBlocks) {
    const raw = (m[1] || '').trim();
    if (!raw) continue;
    total += raw.length;
    if (total > LIMITS.jsonLdBytes) break;
    blocks.push(raw);
  }
  return blocks;
}

// 深度受限展开 @graph / 数组 → 节点流
function flattenNodes(root, depth) {
  const d = depth == null ? 0 : depth;
  const out = [];
  if (d > LIMITS.jsonLdMaxDepth || root == null) return out;
  if (Array.isArray(root)) {
    for (const x of root) out.push.apply(out, flattenNodes(x, d + 1));
    return out;
  }
  if (typeof root !== 'object') return out;
  out.push(root);
  if (root['@graph']) out.push.apply(out, flattenNodes(root['@graph'], d + 1));
  return out;
}

// @type 判定（容错字符串/数组/大小写）
function hasType(node, type) {
  const t = node && node['@type'];
  if (!t) return false;
  const list = Array.isArray(t) ? t : [t];
  return list.some(x => String(x).toLowerCase() === String(type).toLowerCase());
}

function pickOrganization(nodes) {
  for (const n of nodes) {
    // OnlineStore = schema.org Store 子类（大量非 Shopify 电商用它声明站点身份）
    if (hasType(n, 'Organization') || hasType(n, 'WebSite') || hasType(n, 'LocalBusiness') || hasType(n, 'Store') || hasType(n, 'OnlineStore')) {
      return {
        name: cleanText(n.name, 200) || null,
        description: cleanText(n.description, 300) || null,
        logo: absUrl(typeof n.logo === 'object' && n.logo ? n.logo.url : n.logo, null),
        sameAs: Array.isArray(n.sameAs) ? n.sameAs.map(u => absUrl(u, null)).filter(Boolean).slice(0, 10) : [],
      };
    }
  }
  return null;
}

// 单个 Product 节点 → 规范化输出（只保留公开字段；价格/评分原样读取）
function normalizeProductNode(n, baseUrl) {
  const offersRaw = n.offers;
  const offersArr = Array.isArray(offersRaw) ? offersRaw : (offersRaw ? [offersRaw] : []);
  let price = null; let currency = null; let availability = null;
  for (const o of offersArr) {
    if (o == null || typeof o !== 'object') continue;
    const p = typeof o.price === 'object' && o.price ? (o.price.price != null ? o.price.price : o.price.value) : o.price;
    const num = Number(p);
    if (price == null && isFinite(num)) price = num;
    if (!currency && typeof o.priceCurrency === 'string') currency = o.priceCurrency;
    if (!availability && typeof o.availability === 'string') availability = String(o.availability).replace(/^https?:\/\/schema\.org\//i, '');
    if (price != null && currency) break;
  }
  const ar = n.aggregateRating;
  let rating = null; let reviewCount = null;
  if (ar && typeof ar === 'object') {
    const rv = Number(ar.ratingValue); const rc = Number(ar.reviewCount != null ? ar.reviewCount : ar.ratingCount);
    if (isFinite(rv)) rating = rv;
    if (isFinite(rc)) reviewCount = rc;
  }
  return {
    name: cleanText(n.name, 200) || null,
    url: absUrl(typeof n.url === 'string' ? n.url : (n['@id'] && typeof n['@id'] === 'string' ? n['@id'] : null), baseUrl),
    price: price != null && isFinite(price) ? price : null,
    currency: currency ? String(currency).toUpperCase().slice(0, 8) : null,
    availability: availability ? availability.slice(0, 40) : null,
    rating: rating,
    reviewCount: reviewCount,
    image: absUrl(Array.isArray(n.image) ? n.image[0] : (typeof n.image === 'object' && n.image ? n.image.url : n.image), baseUrl),
  };
}

function pickProducts(nodes, baseUrl) {
  const out = []; const seen = new Set();
  for (const n of nodes) {
    if (out.length >= LIMITS.products) break;
    if (!hasType(n, 'Product') || !n.name) continue;
    const p = normalizeProductNode(n, baseUrl);
    const key = (p.url || p.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// 解析单页：head + JSON-LD（Organization / Product）
// 返回结构固定字段；解析失败的部分如实 null/[]，不抛异常。
function parseSiteProfile(html, baseUrl) {
  const head = extractHead(String(html || ''), baseUrl);
  const nodes = [];
  for (const raw of extractJsonLdScripts(String(html || ''))) {
    try {
      const parsed = JSON.parse(raw);
      nodes.push.apply(nodes, flattenNodes(parsed, 0));
    } catch (e) { /* 单块损坏：跳过，不影响其他块 */ }
  }
  const org = pickOrganization(nodes);
  const products = pickProducts(nodes, baseUrl);
  const brandIntro = head.metaDescription || head.ogDescription || (org && org.description) || null;
  const siteName = head.ogSiteName || (org && org.name) || null;
  return {
    parserVersion: SITE_PROFILE_PARSER_VERSION,
    canonical: head.canonical,
    title: head.title || head.ogTitle || null,
    siteName,
    brandIntro,
    og: { title: head.ogTitle, description: head.ogDescription, image: head.ogImage, siteName: head.ogSiteName },
    organization: org,
    products,
    // 证据字段：页面真实出现过什么就登记什么（供摘要与 UI 判定「官网已确认」）
    observed: {
      hasCanonical: !!head.canonical,
      hasTitle: !!(head.title || head.ogTitle),
      hasIntro: !!brandIntro,
      hasOrganization: !!org,
      productCount: products.length,
      priceObservedCount: products.filter(p => p.price != null).length,
      currencyValues: Array.from(new Set(products.map(p => p.currency).filter(Boolean))),
      ratingObservedCount: products.filter(p => p.rating != null).length,
    },
  };
}

// ---------- sitemap / 商品 URL 识别 ----------

// robots.txt → Sitemap: 行（公开声明；无则空数组）
function parseSitemapsFromRobots(robotsTxt) {
  const src = String(robotsTxt || '');
  const out = [];
  const push = (raw) => {
    if (out.length >= 10) return;
    const u = absUrl(String(raw || '').replace(/[;,]+$/, ''), null);
    if (u && out.indexOf(u) === -1) out.push(u);
  };
  // ① 规范形式：Sitemap 指令独占一行（robots.txt 规范写法）
  const strict = /^\s*sitemap\s*:\s*(\S+)\s*$/gim;
  let m;
  while ((m = strict.exec(src))) push(m[1]);
  // ② 兜底：上游若把多行文本压成单行（HTML 抽取/去空白），行首锚点必然失配。
  //    Sitemap 是 robots.txt 的固定指令名，宽松匹配只恢复这种「排版被压平」的情况，
  //    不猜测其他字段（真实站点实测：VAUDE/Allbirds 单行文本下严格匹配为 0）。
  if (!out.length) {
    const loose = /(?:^|[\s;])sitemap\s*:\s*(\S+)/gi;
    while ((m = loose.exec(' ' + src)) && out.length < 10) push(m[1]);
  }
  return out;
}

// sitemap.xml → <loc> 列表（含 sitemap index 二次展开由 adapter 层决定）
// XML 实体归一（<loc> 内的 &amp; 必须还原）——真实站点实测：
// Shopify sitemap index 的分片 URL 形如 sitemap_products_1.xml?from=1&amp;to=2，
// 不解码会带着 "amp;" 去抓，等于抓到错误 URL（r2 修复）。
function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
}

// 是否 sitemap 文件 URL：允许 .xml 后带查询串（分片 sitemap 常见），也允许 .xml.gz
function isSitemapUrl(u) {
  try {
    const p = new URL(u);
    return /\.xml(\.gz)?$/i.test(p.pathname);
  } catch (e) { return false; }
}

function parseSitemapLocs(xml) {
  const out = [];
  const re = /<loc>\s*([^<\s]{1,2000})\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) && out.length < LIMITS.sitemapLocs) {
    const u = absUrl(decodeXmlEntities(m[1]), null);
    if (u) out.push(u);
  }
  return out;
}

// 公开商品页 URL 启发式（只做 URL 结构识别，不做内容猜测）
function isProductUrl(u) {
  try {
    const path = new URL(u).pathname.toLowerCase();
    return /\/products?\/[^/]+\/?$/.test(path) || /\/dp\/[A-Za-z0-9]{6,}/.test(path);
  } catch (e) { return false; }
}

// sitemap locs → 商品 URL 采样（保序去重；上限 LIMITS.productUrlSample）
function sampleProductUrls(locs) {
  const seen = new Set(); const out = [];
  for (const u of locs) {
    if (out.length >= LIMITS.productUrlSample) break;
    if (!isProductUrl(u)) continue;
    const key = u.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

module.exports = {
  SITE_PROFILE_PARSER_VERSION, LIMITS, isSitemapUrl, decodeXmlEntities,
  parseSiteProfile, extractJsonLdScripts,
  parseSitemapsFromRobots, parseSitemapLocs, isProductUrl, sampleProductUrls,
  absUrl, cleanText,
};
