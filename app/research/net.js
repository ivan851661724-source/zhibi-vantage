'use strict';
// ============================================================
// research/net.js —— L3 证据获取层：snippet 不可信，一级证据必须抓正文/结构化数据
// SSRF 加固（修复：用户可控 URL 可让服务器抓取私网/云元数据地址）：
//   · 仅允许 http/https；拒绝 localhost/*.internal/*.local 主机名
//   · 每一跳重定向都重新做 DNS 解析并校验目标 IP（私网/环回/链路本地/CGNAT 元数据段全拒）
//   · fetchPage 改手动重定向循环（≤3 跳），自动跟随会被绕过逐跳校验
// ============================================================
const dns = require('dns').promises;
const net = require('net');

const Cache = require('../services/cache.js');

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&quot;|&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- SSRF 防护 ----------
const BLOCKED_HOST_RE = /^(localhost|metadata\.google\.internal)$/i;
const BLOCKED_HOST_SUFFIX = /\.(internal|local|lan|intranet)$/i;
function isPrivateIp(ip) {
  if (!ip) return true;
  if (/^::ffff:/i.test(ip)) return isPrivateIp(ip.replace(/^::ffff:/i, ''));
  if (ip === '::1' || ip === '::' || /^f[cd]/i.test(ip) || /^fe[89ab]/i.test(ip)) return true; // v6 环回/未指定/ULA(fc00::/7)/链路本地(fe80::/10)
  if (/^0\./.test(ip)) return true;
  if (/^127\./.test(ip)) return true;        // 环回
  if (/^10\./.test(ip)) return true;         // 私网
  if (/^192\.168\./.test(ip)) return true;   // 私网
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true; // 私网
  if (/^169\.254\./.test(ip)) return true;   // 链路本地（含 AWS 元数据 169.254.169.254）
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true; // CGNAT 100.64/10（含阿里云元数据 100.100.100.200）
  return false;
}
// 解析并校验 URL 可安全外抓；返回 URL 对象，不安全抛 SSRF_BLOCKED
async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); } catch (e) { throw new Error('SSRF_BLOCKED:invalid_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('SSRF_BLOCKED:protocol');
  const host = u.hostname;
  if (BLOCKED_HOST_RE.test(host) || BLOCKED_HOST_SUFFIX.test(host)) throw new Error('SSRF_BLOCKED:host');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('SSRF_BLOCKED:ip');
    return u;
  }
  let res;
  try { res = await dns.lookup(host, { all: true }); } catch (e) { throw new Error('SSRF_BLOCKED:dns'); }
  if (!res || !res.length) throw new Error('SSRF_BLOCKED:dns');
  for (const r of res) if (isPrivateIp(r.address)) throw new Error('SSRF_BLOCKED:private_dns');
  return u;
}

// 抓页面正文（超时保护 + 大小限制），失败返回 {ok:false}
// 模块 0-3：fetch-page 72h 缓存（同官网反复重抓免网络开销）
async function fetchPage(url, timeoutMs) {
  const hit = Cache.get('fetch-page', url);
  if (hit) return hit;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    let current = url, hops = 0, r = null;
    while (true) {
      const u = await assertPublicUrl(current); // 每跳校验（含 DNS 解析后的 IP 判定）
      r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.8' }, signal: ctrl.signal, redirect: 'manual' });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        hops++;
        if (hops > 3) { try { r.body && r.body.cancel(); } catch (e) {} return { ok: false, error: 'too_many_redirects' }; }
        current = new URL(r.headers.get('location'), u).href;
        try { r.body && r.body.cancel(); } catch (e) {}
        continue;
      }
      break;
    }
    if (!r.ok) return { ok: false, status: r.status };
    const html = await r.text();
    const out = { ok: true, url: r.url || url, text: stripHtml(html).slice(0, 9000), htmlLower: html.toLowerCase().slice(0, 200000) };
    Cache.set('fetch-page', url, out);
    return out;
  } catch (e) {
    if (e && String(e.message).startsWith('SSRF_BLOCKED')) return { ok: false, error: e.message };
    return { ok: false, error: String(e && e.message || e) };
  }
  finally { clearTimeout(timer); }
}
// Shopify 站结构化价格：/products.json 公开端点，零 LLM，verified 级
async function fetchShopifyProducts(siteUrl) {
  const d = domainOf(siteUrl);
  if (!d) return { ok: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const u = await assertPublicUrl(`https://${d}/products.json?limit=100`);
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    const products = Array.isArray(j.products) ? j.products : [];
    if (!products.length) return { ok: false, empty: true };
    const items = products.slice(0, 60).map(p => {
      const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(n => !isNaN(n) && n > 0);
      return { title: p.title, type: p.product_type || '', minPrice: prices.length ? Math.min(...prices) : null, maxPrice: prices.length ? Math.max(...prices) : null };
    }).filter(x => x.minPrice != null);
    // B-5a（2026-09-12 任务书）：total = 未截断的真实在售款数（products.length）。
    // items 被 .slice(0,60) 截断 + minPrice 有效过滤，不能当 SKU 数（模拟 S5 实证：
    // 用截断值会把 60 款目录型品牌算成 12，份额排名翻转 15%↔47%）。
    return { ok: items.length > 0, items, total: products.length, url: `https://${d}/products.json` };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  finally { clearTimeout(timer); }
}

module.exports = { domainOf, stripHtml, isPrivateIp, assertPublicUrl, fetchPage, fetchShopifyProducts };
