'use strict';
// ============================================================
// services/site-fingerprint.js —— 官网内容稳定指纹与确定性 Diff（SC-08 §三 C）
// ------------------------------------------------------------
// 只比较**稳定结构化字段**，绝不比较完整 HTML hash：
//   title / meta description / canonical / JSON-LD Organization+Product /
//   稳定商品 URL 集合 / 稳定产品名称集合 / 清洗后的关键页面结构摘要。
//
// 清洗（必须在取证前剥离）：script/style/noscript/svg/iframe、HTML 注释、
//   cookie / consent / GDPR 横幅、nonce、当前时间与日期串、随机 ID（长 hex/uuid）、
//   追踪参数（utm_* / gclid / fbclid / ref…）、动态推荐区（related/recommend/carousel…）、
//   明显会话化内容（session id、cart token、csrf）。
//
// 纯函数、无 IO、无网络：可单测、可回放。
// ============================================================
const crypto = require('crypto');

const MAX_URLS = 200;
const MAX_NAMES = 200;

// ---------- 清洗 ----------
// 需要整块移除的标签（内容不可作为稳定信号）
const DROP_TAGS = ['script', 'style', 'noscript', 'svg', 'iframe', 'canvas', 'link', 'meta'];
// 会话化/动态区块的 class/id 关键词（命中即整块移除）
const DYNAMIC_BLOCK_RE = /(cookie|consent|gdpr|ccpa|newsletter-?popup|popup|modal|toast|banner|recommend|related|carousel|you-?may-?also|recently-?viewed|recently-?bought|upsell|cross-?sell|session|csrf|cart-?drawer|chat-?widget|live-?chat|announcement)/i;
// 追踪参数
const TRACKING_PARAM_RE = /^(utm_|gclid|fbclid|msclkid|dclid|yclid|mc_cid|mc_eid|ref|referrer|source|_ga|_gl|igshid|srsltid)/i;
// 随机标识形态
const RANDOM_TOKEN_RE = /\b(?:[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{10,13})\b/gi;
// 时间/日期串（会每天变化，绝不能进指纹）
const TIME_STR_RE = /\b(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?|\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi;

function stripTags(html) {
  let s = String(html || '');
  // 整块移除的标签（含内容）
  for (const tag of ['script', 'style', 'noscript', 'svg', 'canvas', 'iframe']) {
    s = s.replace(new RegExp('<' + tag + '\\b[\\s\\S]*?<\\/' + tag + '>', 'gi'), ' ');
    // 自闭合/未闭合
    s = s.replace(new RegExp('<' + tag + '\\b[^>]*\\/?>', 'gi'), ' ');
  }
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  return s;
}

function dropDynamicBlocks(html) {
  // 简化而稳健的处理：按标签扫描，命中动态关键词的开标签→找到对应闭合，删除整段。
  // 不引入 HTML 解析依赖（零依赖原则）：用栈式扫描处理同名标签嵌套。
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  const marks = [];
  let m;
  while ((m = tagRe.exec(html))) {
    const [full, closing, name, attrs] = m;
    marks.push({ start: m.index, end: m.index + full.length, closing: !!closing, name: name.toLowerCase(), attrs });
  }
  const dropRanges = [];
  for (let i = 0; i < marks.length; i++) {
    const mk = marks[i];
    if (mk.closing) continue;
    if (!DYNAMIC_BLOCK_RE.test(mk.attrs || '')) continue;
    // 找同名标签闭合（考虑嵌套深度）
    let depth = 1, j = i + 1;
    for (; j < marks.length; j++) {
      if (marks[j].name !== mk.name) continue;
      if (!marks[j].closing) depth += 1;
      else { depth -= 1; if (depth === 0) break; }
    }
    const endPos = (j < marks.length) ? marks[j].end : mk.end;
    dropRanges.push([mk.start, endPos]);
  }
  if (!dropRanges.length) return html;
  // 合并重叠区间
  dropRanges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of dropRanges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let out = '', pos = 0;
  for (const [a, b] of merged) { out += html.slice(pos, a); pos = b; }
  out += html.slice(pos);
  return out;
}

function normalizeUrl(raw, base) {
  try {
    const u = new URL(String(raw), base);
    u.hash = '';
    // 去追踪参数与排序噪声
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams.entries()) {
      if (TRACKING_PARAM_RE.test(k)) continue;
      keep.append(k, v);
    }
    const qs = keep.toString();
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return u.origin.toLowerCase() + path + (qs ? '?' + qs : '');
  } catch (e) { return null; }
}

function cleanText(s) {
  return String(s || '')
    .replace(RANDOM_TOKEN_RE, ' ')
    .replace(TIME_STR_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- 结构化字段抽取 ----------
function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1].trim();
    try {
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed && typeof parsed === 'object') {
        if (Array.isArray(parsed['@graph'])) out.push(...parsed['@graph']);
        else out.push(parsed);
      }
    } catch (e) { /* 非法 JSON-LD 忽略（不猜测） */ }
  }
  return out;
}

function pickOrg(blocks) {
  const org = blocks.find(b => b && typeof b === 'object' && ['Organization', 'Corporation', 'LocalBusiness', 'OnlineStore'].includes(String(b['@type'])));
  if (!org) return null;
  const out = {};
  if (org.name) out.name = cleanText(org.name);
  if (org.url) out.url = normalizeUrl(org.url);
  if (org.logo) out.logo = typeof org.logo === 'string' ? normalizeUrl(org.logo) : (org.logo && org.logo.url ? normalizeUrl(org.logo.url) : null);
  if (org.description) out.description = cleanText(org.description).slice(0, 300);
  if (org.sameAs) out.sameAs = (Array.isArray(org.sameAs) ? org.sameAs : [org.sameAs]).map(x => normalizeUrl(x)).filter(Boolean).slice(0, 10).sort();
  return Object.keys(out).length ? out : null;
}

function pickProducts(blocks) {
  const items = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    const t = String(b['@type'] || '');
    if (t === 'Product') items.push(b);
    else if (t === 'ItemList' && Array.isArray(b.itemListElement)) {
      for (const el of b.itemListElement) {
        const it = el && (el.item || el);
        if (it && String(it['@type'] || '') === 'Product') items.push(it);
      }
    }
  }
  const urls = new Set(), names = new Set();
  for (const p of items) {
    const u = p.url ? normalizeUrl(p.url) : null;
    if (u) urls.add(u);
    const n = p.name ? cleanText(p.name).slice(0, 160) : null;
    if (n) names.add(n);
  }
  return { urls, names };
}

// 商品链接候选（去噪后的 a[href]）
const PRODUCT_PATH_RE = /\/(?:product|products|p|item|items|shop|collections)\//i;
function productLinks(html, base) {
  const urls = new Set(), names = new Set();
  const re = /<a\b([^>]*)>([\s\S]{0,300}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '', inner = m[2] || '';
    const hrefM = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    if (!hrefM) continue;
    const href = hrefM[2] || hrefM[3] || hrefM[4] || '';
    if (!href || /^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    if (!PRODUCT_PATH_RE.test(href)) continue;
    const u = normalizeUrl(href, base);
    if (!u) continue;
    // 同域限定（避免把外站推荐算进来）
    try { if (new URL(u).origin !== new URL(base).origin) continue; } catch (e) { continue; }
    urls.add(u);
    const txt = cleanText(stripTags(inner).replace(/\s+/g, ' '));
    if (txt && txt.length <= 160) names.add(txt);
  }
  return { urls, names };
}

function metaOf(html) {
  const out = { description: null, ogTitle: null, ogDescription: null, ogSiteName: null };
  const metaRe = /<meta\b([^>]*)>/gi;
  let m;
  while ((m = metaRe.exec(html))) {
    const attrs = m[1] || '';
    const get = (name) => {
      const r = new RegExp(name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(attrs);
      return r ? (r[2] || r[3] || r[4] || '') : null;
    };
    const prop = (get('property') || get('name') || '').toLowerCase();
    const content = get('content');
    if (!content) continue;
    if (prop === 'description') out.description = cleanText(content).slice(0, 300);
    else if (prop === 'og:title') out.ogTitle = cleanText(content).slice(0, 200);
    else if (prop === 'og:description') out.ogDescription = cleanText(content).slice(0, 300);
    else if (prop === 'og:site_name') out.ogSiteName = cleanText(content).slice(0, 120);
  }
  return out;
}

function titleOf(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? cleanText(stripTags(m[1])).slice(0, 300) || null : null;
}

function canonicalOf(html, base) {
  const m = /<link[^>]+rel=["']canonical["'][^>]*>/i.exec(html);
  if (!m) return null;
  const h = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[0]);
  const raw = h ? (h[2] || h[3] || h[4] || '') : '';
  return raw ? normalizeUrl(raw, base) : null;
}

// 关键页面结构摘要：清洗后 h1/h2/h3 序列 + 主导航文本（都经过去时间/随机串处理）
function structureDigest(cleanHtml, html) {
  const headings = [];
  const hRe = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = hRe.exec(html))) {
    const t = cleanText(stripTags(m[2]));
    if (t) headings.push('h' + m[1] + ':' + t.slice(0, 120));
    if (headings.length >= 60) break;
  }
  const navs = [];
  const navRe = /<nav\b[^>]*>([\s\S]*?)<\/nav>/gi;
  while ((m = navRe.exec(html))) {
    const t = cleanText(stripTags(m[1]));
    if (t) navs.push(t.slice(0, 240));
    if (navs.length >= 5) break;
  }
  const payload = JSON.stringify({ headings, navs });
  const digest = 'sha256:' + crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
  return { digest, headings, navs };
}

/**
 * 构建稳定指纹。
 * @param {string} html 原始 HTML（含 script/style，函数内部清洗）
 * @param {string} url 页面最终 URL（作相对链接基址 + 同域限定）
 */
function buildFingerprint(html, url) {
  const raw = String(html || '');
  const base = String(url || '');
  const ld = jsonLdBlocks(raw);
  const org = pickOrg(ld);
  const ldProducts = pickProducts(ld);
  const links = productLinks(dropDynamicBlocks(stripTags(raw)), base);
  const noDynamic = dropDynamicBlocks(raw);
  const cleaned = stripTags(noDynamic);
  const meta = metaOf(raw);
  const title = titleOf(raw);
  const canonical = canonicalOf(raw, base);
  const structure = structureDigest(cleaned, noDynamic);

  const urlSet = new Set([...ldProducts.urls, ...links.urls]);
  const nameSet = new Set([...ldProducts.names, ...links.names]);
  const productUrls = [...urlSet].sort().slice(0, MAX_URLS);
  const productNames = [...nameSet].sort().slice(0, MAX_NAMES);

  const fp = {
    version: 1,
    url: base ? normalizeUrl(base) : null,
    title,
    metaDescription: meta.description,
    ogTitle: meta.ogTitle,
    ogDescription: meta.ogDescription,
    ogSiteName: meta.ogSiteName,
    canonical,
    organization: org,
    productUrls,
    productNames,
    structureDigest: structure.digest,
    structureHeadings: structure.headings.length,
    textLength: cleaned.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length,
  };
  return fp;
}

/**
 * 稳定性判定：是否足够支撑 site_change 监控（有稳定结构化字段才可晋升）。
 * 达标条件（任一具备即可，但必须是**结构化**字段，不是纯文本长度）：
 *   title 或 canonical 或 organization 或 (productUrls ≥ 1) 或 (productNames ≥ 1) 或 结构摘要含 ≥2 个标题
 */
function stabilityOf(fp) {
  if (!fp) return { stable: false, signals: [], reason: 'no_fingerprint' };
  const signals = [];
  if (fp.title) signals.push('title');
  if (fp.canonical) signals.push('canonical');
  if (fp.organization && (fp.organization.name || fp.organization.url)) signals.push('organization');
  if ((fp.productUrls || []).length >= 1) signals.push('product_urls');
  if ((fp.productNames || []).length >= 1) signals.push('product_names');
  if (fp.structureHeadings >= 2) signals.push('structure');
  if (fp.metaDescription) signals.push('meta_description');
  const stable = signals.length >= 2;
  return { stable, signals, reason: stable ? null : 'insufficient_structured_fields' };
}

function setDelta(prev, next) {
  const p = new Set(prev || []), n = new Set(next || []);
  const added = [...n].filter(x => !p.has(x)).sort();
  const removed = [...p].filter(x => !n.has(x)).sort();
  return { added, removed, changed: added.length > 0 || removed.length > 0 };
}

/**
 * 确定性 Diff：只比较稳定结构化字段。
 * @returns {{comparable:boolean, changes:Array<{field,oldValue,newValue,kind}>, limitations:string[]}}
 */
function diffFingerprints(prev, next) {
  const limitations = [];
  if (!prev || !next) return { comparable: false, changes: [], limitations: ['missing_fingerprint'] };
  if (prev.version !== next.version) limitations.push('version_changed');
  const changes = [];
  const scalarFields = [
    ['title', 'title'], ['canonical', 'canonical'], ['metaDescription', 'meta_description'],
    ['ogTitle', 'og_title'], ['ogDescription', 'og_description'], ['ogSiteName', 'og_site_name'],
  ];
  for (const [key, label] of scalarFields) {
    const a = prev[key] == null ? null : prev[key];
    const b = next[key] == null ? null : next[key];
    if (a !== b) changes.push({ field: label, oldValue: a, newValue: b, kind: a == null ? 'added' : b == null ? 'removed' : 'changed' });
  }
  // organization：逐子字段比较（name/url/logo/description/sameAs）
  const oa = prev.organization || null, ob = next.organization || null;
  if (JSON.stringify(oa) !== JSON.stringify(ob)) {
    const sub = ['name', 'url', 'logo', 'description', 'sameAs'];
    for (const k of sub) {
      const a = oa ? oa[k] : null, b = ob ? ob[k] : null;
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        changes.push({ field: 'organization.' + k, oldValue: a == null ? null : a, newValue: b == null ? null : b, kind: a == null ? 'added' : b == null ? 'removed' : 'changed' });
      }
    }
    if (!changes.length) changes.push({ field: 'organization', oldValue: oa, newValue: ob, kind: 'changed' });
  }
  // 稳定商品 URL / 名称集合
  const urls = setDelta(prev.productUrls, next.productUrls);
  if (urls.added.length || urls.removed.length) {
    changes.push({ field: 'product_urls', oldValue: (prev.productUrls || []).length, newValue: (next.productUrls || []).length, kind: 'changed', added: urls.added.slice(0, 20), removed: urls.removed.slice(0, 20) });
  }
  const names = setDelta(prev.productNames, next.productNames);
  if (names.added.length || names.removed.length) {
    changes.push({ field: 'product_names', oldValue: (prev.productNames || []).length, newValue: (next.productNames || []).length, kind: 'changed', added: names.added.slice(0, 20), removed: names.removed.slice(0, 20) });
  }
  // 结构摘要（只比 digest，不比原文）
  if (prev.structureDigest && next.structureDigest && prev.structureDigest !== next.structureDigest) {
    changes.push({ field: 'structure', oldValue: prev.structureDigest, newValue: next.structureDigest, kind: 'changed' });
  }
  return { comparable: true, changes, limitations };
}

// 人类可读的变化说明（一句话）
const FIELD_TEXT = {
  title: '官网标题', canonical: '规范地址', meta_description: '页面描述', og_title: '分享标题',
  og_description: '分享描述', og_site_name: '站点名称', organization: '结构化组织信息',
  product_urls: '商品链接集合', product_names: '商品名称集合', structure: '页面结构',
};
function describeChanges(changes) {
  if (!changes || !changes.length) return '官网内容发生更新';
  const parts = changes.slice(0, 3).map(c => {
    const label = FIELD_TEXT[c.field] || (String(c.field).startsWith('organization.') ? '组织信息（' + c.field.split('.')[1] + '）' : c.field);
    if (c.field === 'product_urls' || c.field === 'product_names') {
      const add = (c.added || []).length, del = (c.removed || []).length;
      return label + (add ? '新增 ' + add : '') + (add && del ? '、' : '') + (del ? '移除 ' + del : '');
    }
    if (c.kind === 'added') return label + '新增';
    if (c.kind === 'removed') return label + '移除';
    return label + '变更';
  });
  return parts.join('；') + (changes.length > 3 ? '；等 ' + changes.length + ' 项' : '');
}

module.exports = {
  buildFingerprint, diffFingerprints, stabilityOf, describeChanges,
  cleanText, stripTags, dropDynamicBlocks, normalizeUrl, jsonLdBlocks,
  FIELD_TEXT, MAX_URLS, MAX_NAMES,
};
