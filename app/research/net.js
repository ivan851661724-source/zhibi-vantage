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
const { Buffer } = require('buffer');

const Cache = require('../services/cache.js');
const als = require('../core/als.js');
const Snapshot = require('./source-snapshot.js');

// 租户解析（P0-2，PR#2 评审）：显式参数 > ALS > null。fetch-page 缓存键按租户隔离——
// B 永不命中 A 的缓存条目、永不接收 A 的租户级快照溯源；Canonical 跨工作区复用归
// Canonical Brand / Collection track 显式实现（00 §52），不得借公共缓存模拟。
// 迁移说明：旧全局键条目随 72h TTL 自然淘汰，无清理动作。
function tenantOf(o) {
  const t = o && o.tenantId;
  if (t) return String(t);
  try { const c = als.getTenantCtx(); return c ? String(c) : null; } catch (_) { return null; }
}

// 修正 7：net-1 标识的是 fetch/采集实现版本（collector_version），不是 parser_version——
// 快照层 parser 未运行，不伪造 parser_version（Spec Change 候选 SC-01）
const COLLECTOR_VERSION = Snapshot.COLLECTOR_VERSION;

// 修正 9 兼容规则：快照落盘失败不得破坏 legacy 调研路径，但必须是可见运营错误（error 级，非静默）
function loggerError(entry, e, url) {
  try { require('../services/logger.js').error('source_snapshot_error', { entry, url: url || null, error: String((e && e.message) || e).slice(0, 200) }); } catch (_) {}
}

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
// M0-01：成功/失败旁路产 SourceSnapshot（metadata+blob，append-only）；缓存命中
// 不产新快照，返回 _prov 封存原始溯源并只推进 cache_served_at（05 v0.3 §13）
// opts（可选）：{ trigger, tenantId } —— 快照归因；业务返回值不受影响
async function fetchPage(url, timeoutMs, opts) {
  const o = opts || {};
  const tenant = tenantOf(o);
  const ck = tenant ? 't:' + tenant + '|' + url : url; // P0-2：缓存键租户隔离
  const hit = Cache.get('fetch-page', ck);
  if (hit) return Snapshot.decorateCacheHit(hit);
  const fetchedAt = new Date().toISOString();
  // 旁路记录失败观察（00 §38：fetch_failed ≠ no_change）；业务返回值原样
  const recFail = (sourceStatus, errorCode, httpStatus, finalUrl, hops) => {
    try {
      const s = Snapshot.record({ capability: 'evidence_url', provider: 'generic_web_fetch', source_url: url, final_url: finalUrl || null, redirect_hops: hops || 0, http_status: httpStatus == null ? null : httpStatus, source_status: sourceStatus, error_code: errorCode || null, observed_at: null, fetched_at: fetchedAt, bodyBytes: null, trigger: o.trigger, tenantId: o.tenantId });
      return s.recorded ? s.meta.snapshot_id : undefined;
    } catch (e) { loggerError('fetchPage', e, url); return undefined; }
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    let current = url, hops = 0, r = null;
    while (true) {
      const u = await assertPublicUrl(current); // 每跳校验（含 DNS 解析后的 IP 判定）
      r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.8' }, signal: ctrl.signal, redirect: 'manual' });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        hops++;
        if (hops > 3) { try { r.body && r.body.cancel(); } catch (e) {} const sid = recFail(Snapshot.SOURCE_STATUS.UNAVAILABLE, 'too_many_redirects', r.status, current, hops); return { ok: false, error: 'too_many_redirects', snapshotId: sid }; }
        current = new URL(r.headers.get('location'), u).href;
        try { r.body && r.body.cancel(); } catch (e) {}
        continue;
      }
      break;
    }
    if (!r.ok) {
      const st = Snapshot.mapHttpStatus(r.status);
      const sid = recFail(st, st === Snapshot.SOURCE_STATUS.RATE_LIMITED ? 'http:429' : ('http:' + r.status), r.status, current, hops);
      return { ok: false, status: r.status, snapshotId: sid };
    }
    // 原始字节截获：hash/blob 基于「解析与规范化之前」的响应字节（修正 5）
    const buf = Buffer.from(await r.arrayBuffer());
    const observedAt = new Date().toISOString();
    const lastMod = r.headers.get('last-modified');
    let sid;
    let prov = { recorded: false };
    try {
      const s = Snapshot.record({ capability: 'evidence_url', provider: 'generic_web_fetch', source_url: url, final_url: current, redirect_hops: hops, http_status: r.status, source_status: Snapshot.SOURCE_STATUS.SUCCESS, observed_at: observedAt, fetched_at: fetchedAt, bodyBytes: buf, contentType: r.headers.get('content-type'), source_updated_at: lastMod, trigger: o.trigger, tenantId: o.tenantId });
      if (s.recorded) { sid = s.meta.snapshot_id; prov = { recorded: true, source_snapshot_id: s.meta.snapshot_id, observed_at: s.meta.observed_at, source_status: s.meta.source_status, content_hash: s.meta.content_hash, fetched_at: s.meta.fetched_at }; }
      else prov = s;
    } catch (e) { loggerError('fetchPage', e, url); }
    const html = buf.toString('utf8');
    const out = { ok: true, url: r.url || url, text: stripHtml(html).slice(0, 9000), htmlLower: html.toLowerCase().slice(0, 200000), snapshotId: sid, _prov: prov };
    Cache.set('fetch-page', ck, out);
    return out;
  } catch (e) {
    const cls = Snapshot.classifyError(e);
    const sid = recFail(cls.source_status, cls.error_code, null, typeof current !== 'undefined' ? current : url, 0);
    if (e && String(e.message).startsWith('SSRF_BLOCKED')) return { ok: false, error: e.message, snapshotId: sid };
    return { ok: false, error: String(e && e.message || e), snapshotId: sid };
  }
  finally { clearTimeout(timer); }
}
// Shopify 站结构化价格：/products.json 公开端点，零 LLM，verified 级。
// 同时探测 /cart.js 的店铺结账币种：products.json 价格以店铺币种计且 JSON 本身不带币种，
// 店铺币种 ≠ 调研市场币种时（如日销店 ¥800），调用方不得把数值直接当市场价入带。
// M0-01：products.json 响应原始字节旁路落快照（cart.js 币种探测为辅助请求，不产快照）；
// opts（可选）：{ trigger, tenantId }
async function fetchShopifyProducts(siteUrl, opts) {
  const o = opts || {};
  const d = domainOf(siteUrl);
  if (!d) return { ok: false };
  const fetchedAt = new Date().toISOString();
  const recFail = (sourceStatus, errorCode, httpStatus) => {
    try {
      const s = Snapshot.record({ capability: 'product_catalog', provider: 'shopify_products_json', source_url: `https://${d}/products.json?limit=100`, final_url: null, redirect_hops: 0, http_status: httpStatus == null ? null : httpStatus, source_status: sourceStatus, error_code: errorCode || null, observed_at: null, fetched_at: fetchedAt, bodyBytes: null, trigger: o.trigger, tenantId: o.tenantId });
      return s.recorded ? s.meta.snapshot_id : undefined;
    } catch (e) { loggerError('fetchShopifyProducts', e, d); return undefined; }
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const u = await assertPublicUrl(`https://${d}/products.json?limit=100`);
    const cartReq = fetch(`https://${d}/cart.js`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(j => (j && j.currency) ? String(j.currency).toUpperCase() : null)
      .catch(() => null);
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    if (!r.ok) {
      const st = Snapshot.mapHttpStatus(r.status);
      const sid = recFail(st, 'http:' + r.status, r.status);
      return { ok: false, status: r.status, snapshotId: sid };
    }
    // 原始 JSON 字节截获（解析之前），再 JSON.parse——parse 失败时字节仍落 blob 供重放。
    // P1-1（PR#2 评审）：2XX body 已接收 = 来源内容已被真实观察 → observed_at 非空；
    // observed_at=null 仅保留给"内容从未被观察"的 retrieval 前失败（pre-body timeout/SSRF/blocked 等）
    const buf = Buffer.from(await r.arrayBuffer());
    const observedAt = new Date().toISOString();
    let j;
    try { j = JSON.parse(buf.toString('utf8')); } catch (pe) {
      let sid;
      try { const s = Snapshot.record({ capability: 'product_catalog', provider: 'shopify_products_json', source_url: u.href, final_url: null, redirect_hops: 0, http_status: r.status, source_status: Snapshot.SOURCE_STATUS.PARSE_FAILED, observed_at: observedAt, fetched_at: fetchedAt, bodyBytes: buf, contentType: r.headers.get('content-type'), trigger: o.trigger, tenantId: o.tenantId, note: 'json parse failed after body receipt; raw kept for replay' }); if (s.recorded) sid = s.meta.snapshot_id; } catch (e) { loggerError('fetchShopifyProducts', e, d); }
      return { ok: false, error: 'parse_failed', snapshotId: sid };
    }
    const products = Array.isArray(j.products) ? j.products : [];
    let sid, prov = { recorded: false };
    // P0-1（PR#2 评审）：M0-04 完整分页落地前，products.json?limit=100 首页即全部
    // （products.length < 100）才允许记完整目录观察（success）；≥100 视为已知不完整
    // 采集 → source_status=partial（05 §11 冻结字面量）+ scan.complete=false，
    // 绝不宣称 success + 完整目录。业务返回值（items/total）契约不变。
    const scanComplete = products.length < 100;
    const scanStatus = scanComplete ? Snapshot.SOURCE_STATUS.SUCCESS : Snapshot.SOURCE_STATUS.PARTIAL;
    const scan = { complete: scanComplete, reason: scanComplete ? null : 'products_json_first_page_limit_100_pagination_pending_m0_04', observed_first_page: products.length };
    const recordSuccess = (note) => {
      try {
        const s = Snapshot.record({ capability: 'product_catalog', provider: 'shopify_products_json', source_url: u.href, final_url: null, redirect_hops: 0, http_status: r.status, source_status: scanStatus, observed_at: observedAt, fetched_at: fetchedAt, bodyBytes: buf, contentType: r.headers.get('content-type'), source_updated_at: r.headers.get('last-modified'), trigger: o.trigger, tenantId: o.tenantId, scan: scan, note: note || null });
        if (s.recorded) { sid = s.meta.snapshot_id; prov = { recorded: true, source_snapshot_id: s.meta.snapshot_id, observed_at: s.meta.observed_at, source_status: s.meta.source_status, content_hash: s.meta.content_hash, fetched_at: s.meta.fetched_at }; }
      } catch (e) { loggerError('fetchShopifyProducts', e, d); }
    };
    if (!products.length) {
      recordSuccess('empty_catalog');
      return { ok: false, empty: true, snapshotId: sid, _prov: prov };
    }
    const items = products.slice(0, 60).map(p => {
      const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(n => !isNaN(n) && n > 0);
      return { title: p.title, type: p.product_type || '', minPrice: prices.length ? Math.min(...prices) : null, maxPrice: prices.length ? Math.max(...prices) : null };
    }).filter(x => x.minPrice != null);
    // B-5a（2026-09-12 任务书）：total = 未截断的真实在售款数（products.length）。
    // items 被 .slice(0,60) 截断 + minPrice 有效过滤，不能当 SKU 数（模拟 S5 实证：
    // 用截断值会把 60 款目录型品牌算成 12，份额排名翻转 15%↔47%）。
    const currency = await cartReq;
    recordSuccess(null);
    return { ok: items.length > 0, items, total: products.length, url: `https://${d}/products.json`, currency, snapshotId: sid, _prov: prov };
  } catch (e) {
    const cls = Snapshot.classifyError(e);
    const sid = recFail(cls.source_status, cls.error_code, null);
    return { ok: false, error: String(e && e.message || e), snapshotId: sid };
  }
  finally { clearTimeout(timer); }
}

module.exports = { domainOf, stripHtml, isPrivateIp, assertPublicUrl, fetchPage, fetchShopifyProducts, COLLECTOR_VERSION };
