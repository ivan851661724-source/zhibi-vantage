'use strict';
// ============================================================
// research/net.js —— L3 证据获取层：snippet 不可信，一级证据必须抓正文/结构化数据
// SSRF 加固（修复：用户可控 URL 可让服务器抓取私网/云元数据地址）：
//   · 仅允许 http/https；拒绝 localhost/*.internal/*.local 主机名
//   · 每一跳重定向都重新做 DNS 解析并校验目标 IP（私网/环回/链路本地/CGNAT 元数据段全拒）
//   · fetchPage 改手动重定向循环（≤3 跳），自动跟随会被绕过逐跳校验
// 合规门（services/fetch-gate.js，抓取需求 §2.2）：robots.txt 尊重（fail-open）+
//   同域 ≥3s 节流 + 连续失败熔断。熔断/robots 退出属本地合规决策，非来源观察，
//   不产快照、不计入来源失败记账。
// M0-01：fetchPage / fetchShopifyProducts 成功/失败旁路产 SourceSnapshot
//   （metadata+blob，append-only）；快照落盘失败不破坏 legacy 调研路径（修正 9）。
// ============================================================
const dns = require('dns').promises;
const net = require('net');
const { Buffer } = require('buffer');

const Cache = require('../services/cache.js');
const als = require('../core/als.js');
const Snapshot = require('./source-snapshot.js');
const FetchGate = require('../services/fetch-gate.js');

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
  let lastHost = null; // 网络异常（超时等）也计入同域失败熔断
  try {
    let current = url, hops = 0, r = null;
    while (true) {
      const u = await assertPublicUrl(current); // 每跳校验（含 DNS 解析后的 IP 判定）
      lastHost = u.hostname;
      // 合规门：熔断中直接退出；robots 禁止=确定性合规退出（不算站点失败）；同域节流等待
      const gate = FetchGate.beforeRequest(u.hostname);
      if (!gate.allowed) return { ok: false, error: 'FETCH_CIRCUIT_OPEN' };
      if (gate.waitMs) await new Promise(r2 => setTimeout(r2, gate.waitMs));
      const robots = await FetchGate.robotsAllows(u.origin, u.pathname);
      if (robots === false) { FetchGate.recordResult(u.hostname, true); return { ok: false, error: 'ROBOTS_DISALLOWED' }; }
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
      FetchGate.recordResult(lastHost, false); // 计入同域失败熔断
      const st = Snapshot.mapHttpStatus(r.status);
      const sid = recFail(st, st === Snapshot.SOURCE_STATUS.RATE_LIMITED ? 'http:429' : ('http:' + r.status), r.status, current, hops);
      return { ok: false, status: r.status, snapshotId: sid };
    }
    FetchGate.recordResult(lastHost, true);
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
    try { if (lastHost) FetchGate.recordResult(lastHost, false); } catch (e2) { /* 熔断记账失败不影响返回 */ }
    return { ok: false, error: String(e && e.message || e), snapshotId: sid };
  }
  finally { clearTimeout(timer); }
}
// 变体价格中位数（商品代表价，规格 3.1 第 2 步：不用最低——引流小样拉低；不用最高——高配版不构成主流成交）
function variantMedian(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
// products.json 原始数组 → 价格条目（纯函数，供 net-shopify.test 单测）。
// repPrice = 变体中位价（商品代表价，客单价统计的样本单位）；minPrice/maxPrice 保留供区间展示。
// **全部变体为 0 元**的商品保留 minPrice=0 交给调用方单列 freebies（报告-数据同源 §5）——
// 此前在变体层就被 n>0 过滤整条丢失，comp.freebies 恒空。混合免费+付费变体的商品
// repPrice 取付费变体中位（免费变体不拉低真实价）。
// soldOut：至少一个变体上报过 available 且全部为 false（字段缺失≠断货，规格 5.2 禁推断）。
// publishedAt：上架时间透传（断点：上新事件的佐证字段，规格 5.2）。
function mapShopifyItems(products, cap) {
  const list = (Array.isArray(products) ? products : []).slice(0, cap || Infinity);
  return list.map(p => {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const nums = variants.map(v => parseFloat(v.price)).filter(n => !isNaN(n));
    const prices = nums.filter(n => n > 0);
    const avail = variants.map(v => v.available).filter(a => typeof a === 'boolean');
    const soldOut = variants.length > 0 && avail.length > 0 && avail.every(a => a === false);
    const minPrice = prices.length ? Math.min(...prices) : (nums.length ? 0 : null);
    return {
      title: p.title, type: p.product_type || '',
      id: p.id != null ? p.id : null,
      minPrice,
      maxPrice: prices.length ? Math.max(...prices) : (nums.length ? 0 : null),
      repPrice: prices.length ? variantMedian(prices) : (nums.length ? 0 : null),
      soldOut,
      publishedAt: p.published_at || null
    };
  }).filter(x => x.minPrice != null);
}
// Shopify 站结构化价格：/products.json 公开端点，零 LLM，verified 级。
// 分页拉全量（规格 2.3：limit=250 × ≤4 页，目录型大店 500+ 款必须拉全，S2 类目占比/S3 客单价才准；
// 页间 ≥2s 限速；首页失败=整体失败，后续页失败用已有数据）。total = 实抓款数（分页后趋近全量）。
// 同时探测 /cart.js 的店铺结账币种：products.json 价格以店铺币种计且 JSON 本身不带币种，
// 店铺币种 ≠ 调研市场币种时（如日销店 ¥800），调用方不得把数值直接当市场价入带。
// M0-01：products.json 响应原始字节旁路落快照（cart.js 币种探测为辅助请求，不产快照），
// blob 取首页字节；分页落地后 partial_scan 改按「枚举是否完整」判定——4×250 预算耗尽或
// 中途页失败提前收束 = partial；末页自然收束 = success（05 §5.2 冻结术语）。
// opts（可选）：{ trigger, tenantId }
const SHOPIFY_PAGE_LIMIT = 250;
const SHOPIFY_MAX_PAGES = 4;
const SHOPIFY_PAGE_DELAY_MS = 2000;
async function fetchShopifyProducts(siteUrl, opts) {
  const o = opts || {};
  const d = domainOf(siteUrl);
  if (!d) return { ok: false };
  const fetchedAt = new Date().toISOString();
  const recFail = (sourceStatus, errorCode, httpStatus) => {
    try {
      const s = Snapshot.record({ capability: 'product_catalog', provider: 'shopify_products_json', source_url: `https://${d}/products.json`, final_url: null, redirect_hops: 0, http_status: httpStatus == null ? null : httpStatus, source_status: sourceStatus, error_code: errorCode || null, observed_at: null, fetched_at: fetchedAt, bodyBytes: null, trigger: o.trigger, tenantId: o.tenantId });
      return s.recorded ? s.meta.snapshot_id : undefined;
    } catch (e) { loggerError('fetchShopifyProducts', e, d); return undefined; }
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000); // 总预算：分页 × 每页超时的上限
  try {
    await assertPublicUrl(`https://${d}/products.json`);
    // SSRF：cart.js 与分页各页同样过公网校验（d 来自用户可控 URL，hostname 直拼不过 DNS/私网检查
    // = 元数据端点探测向量；169.254.169.254 等 IP 形态 host 会被 products.json 拦但 cart.js 原先不拦）
    await assertPublicUrl(`https://${d}/cart.js`);
    const cartReq = fetch(`https://${d}/cart.js`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(j => (j && j.currency) ? String(j.currency).toUpperCase() : null)
      .catch(() => null);
    let products = [];
    let firstStatus = null;
    let incompleteReason = null; // 非预算耗尽的提前收束（后续页失败）：partial_scan 的原因
    let firstBuf = null, firstCt = null, firstLastMod = null, firstHttpStatus = null, firstObservedAt = null;
    for (let page = 1; page <= SHOPIFY_MAX_PAGES; page++) {
      let j = null;
      let buf = null, ct = null, lastMod = null, httpStatus = null;
      try {
        const pu = await assertPublicUrl(`https://${d}/products.json?limit=${SHOPIFY_PAGE_LIMIT}&page=${page}`); // 每跳重新校验（防 DNS rebinding）
        const r = await fetch(pu, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
        if (!r.ok) { if (page === 1) firstStatus = r.status; else incompleteReason = 'products_json_page_' + page + '_http_' + r.status; break; } // 首页失败=整体失败；后续页失败用已有数据
        buf = Buffer.from(await r.arrayBuffer());
        ct = r.headers.get('content-type');
        lastMod = r.headers.get('last-modified');
        httpStatus = r.status;
        try { j = JSON.parse(buf.toString('utf8')); } catch (pe) {
          if (page === 1) {
            // P1-1（PR#2 评审）：2XX body 已接收 = 来源内容已被真实观察 → observed_at 非空；
            // parse 失败时字节仍落 blob 供重放
            let psid;
            try {
              const s = Snapshot.record({ capability: 'product_catalog', provider: 'shopify_products_json', source_url: pu.href, final_url: null, redirect_hops: 0, http_status: httpStatus, source_status: Snapshot.SOURCE_STATUS.PARSE_FAILED, observed_at: new Date().toISOString(), fetched_at: fetchedAt, bodyBytes: buf, contentType: ct, trigger: o.trigger, tenantId: o.tenantId, note: 'json parse failed after body receipt; raw kept for replay' });
              if (s.recorded) psid = s.meta.snapshot_id;
            } catch (e) { loggerError('fetchShopifyProducts', e, d); }
            return { ok: false, error: 'parse_failed', snapshotId: psid };
          }
          incompleteReason = 'products_json_page_' + page + '_parse_failed';
          break; // 后续页 parse 失败用已有数据
        }
      } catch (e) {
        if (page === 1) throw e; // 首页网络异常上抛（保持原错误路径）
        incompleteReason = 'products_json_page_' + page + '_error';
        break; // 后续页用已有数据
      }
      if (page === 1) { firstBuf = buf; firstCt = ct; firstLastMod = lastMod; firstHttpStatus = httpStatus; firstObservedAt = new Date().toISOString(); }
      const arr = Array.isArray(j.products) ? j.products : [];
      products = products.concat(arr);
      if (arr.length < SHOPIFY_PAGE_LIMIT) break; // 末页
      if (page < SHOPIFY_MAX_PAGES) await new Promise(r2 => setTimeout(r2, SHOPIFY_PAGE_DELAY_MS));
    }
    if (firstStatus != null) {
      const st = Snapshot.mapHttpStatus(firstStatus);
      const fsid = recFail(st, st === Snapshot.SOURCE_STATUS.RATE_LIMITED ? 'http:429' : ('http:' + firstStatus), firstStatus);
      return { ok: false, status: firstStatus, snapshotId: fsid };
    }
    // B-5a：total = 实抓款数。分页后对 ≤1000 款的店趋近真实在售款数（旧版单页 limit=100 在 >100 款店上本就截断）。
    const truncated = products.length >= SHOPIFY_MAX_PAGES * SHOPIFY_PAGE_LIMIT;
    // P0-1/P0 终审：枚举不完整（预算耗尽或中途页失败）不得宣称完整枚举 → partial +
    // 冻结术语 partial_scan（05 §5.2）；末页自然收束 = success。业务返回值（items/total）契约不变。
    const partialScan = truncated || incompleteReason != null;
    const scanStatus = partialScan ? Snapshot.SOURCE_STATUS.PARTIAL : Snapshot.SOURCE_STATUS.SUCCESS;
    const partialScanReason = truncated ? 'products_json_pagination_budget_250x4_exhausted' : incompleteReason;
    let sid, prov = { recorded: false };
    const recordSuccess = (note) => {
      try {
        const s = Snapshot.record({ capability: 'product_catalog', provider: 'shopify_products_json', source_url: `https://${d}/products.json`, final_url: null, redirect_hops: 0, http_status: firstHttpStatus, source_status: scanStatus, observed_at: firstObservedAt, fetched_at: fetchedAt, bodyBytes: firstBuf, contentType: firstCt, source_updated_at: firstLastMod, trigger: o.trigger, tenantId: o.tenantId, partial_scan: partialScan, partial_scan_reason: partialScanReason, partial_scan_observed_count: products.length, note: note || null });
        if (s.recorded) { sid = s.meta.snapshot_id; prov = { recorded: true, source_snapshot_id: s.meta.snapshot_id, observed_at: s.meta.observed_at, source_status: s.meta.source_status, content_hash: s.meta.content_hash, fetched_at: s.meta.fetched_at }; }
      } catch (e) { loggerError('fetchShopifyProducts', e, d); }
    };
    if (!products.length) {
      recordSuccess('empty_catalog');
      return { ok: false, empty: true, snapshotId: sid, _prov: prov };
    }
    const items = mapShopifyItems(products); // 全量透传（截尾统计/类目占比需要全量；调用方自控上限）
    const currency = await cartReq;
    recordSuccess(null);
    return { ok: items.length > 0, items, total: products.length, truncated, url: `https://${d}/products.json`, currency, snapshotId: sid, _prov: prov };
  } catch (e) {
    const cls = Snapshot.classifyError(e);
    const csid = recFail(cls.source_status, cls.error_code, null);
    return { ok: false, error: String(e && e.message || e), snapshotId: csid };
  }
  finally { clearTimeout(timer); }
}
// Shopify /collections.json 店铺集合清单（S2 佐证：集合数/跨类目信号；规格 2.3 增强项的轻量版——
// 每 collection 的商品归属需逐集合再抓，成本高，留待 S2 全量接入时按需做）。
async function fetchShopifyCollections(siteUrl) {
  const d = domainOf(siteUrl);
  if (!d) return { ok: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const u = await assertPublicUrl(`https://${d}/collections.json?limit=250`);
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    const cols = Array.isArray(j.collections) ? j.collections : [];
    return {
      ok: cols.length > 0,
      collections: cols.map(c => ({ title: String(c.title || '').slice(0, 80), handle: String(c.handle || '').slice(0, 80) })).slice(0, 50),
      url: `https://${d}/collections.json`
    };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  finally { clearTimeout(timer); }
}

module.exports = { domainOf, stripHtml, isPrivateIp, assertPublicUrl, fetchPage, mapShopifyItems, variantMedian, fetchShopifyProducts, fetchShopifyCollections, COLLECTOR_VERSION };
