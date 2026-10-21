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
const UrlRedact = require('../lib/url-redact.js');
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
  try { require('../services/logger.js').error('source_snapshot_error', { entry, url: url ? UrlRedact.redactUrlText(url) : null, error: String((e && e.message) || e).slice(0, 200) }); } catch (_) {}
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
  // 🔴 R3：URL.hostname 对 IPv6 字面量保留方括号（'[::1]'）——net.isIP 判 0 → 绕过 IP
  // 直判而下沉到 dns.lookup，形成私网/回环绕过。判定前统一剥离括号。
  const host = String(u.hostname || '').replace(/^\[/, '').replace(/\]$/, '');
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
  // SC-06：includeHtml 参与缓存键——先有普通缓存命中再要 HTML 会拿不到原始字节
  const ck = (tenant ? 't:' + tenant + '|' : '') + (o.includeHtml ? 'h1|' : '') + url;
  const hit = Cache.get('fetch-page', ck);
  if (hit) return Snapshot.decorateCacheHit(hit);
  const fetchedAt = new Date().toISOString();
  // 旁路记录失败观察（00 §38：fetch_failed ≠ no_change）；业务返回值原样
  const recFail = (sourceStatus, errorCode, httpStatus, finalUrl, hops) => {
    try {
      const s = Snapshot.record({ capability: 'evidence_url', provider: 'generic_web_fetch', source_url: UrlRedact.redactUrl(url), final_url: UrlRedact.redactUrl(finalUrl) || null, redirect_hops: hops || 0, http_status: httpStatus == null ? null : httpStatus, source_status: sourceStatus, error_code: errorCode || null, observed_at: null, fetched_at: fetchedAt, bodyBytes: null, trigger: o.trigger, tenantId: o.tenantId });
      return s.recorded ? s.meta.snapshot_id : undefined;
    } catch (e) { loggerError('fetchPage', e, url); return undefined; }
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  // 🔴 SC-06 r2（评审 §三.3）：外部取消信号（worker attempt 超时）必须能打断本次抓取。
  // 此前 fetchPage 只用自己的超时控制器，worker 侧 Promise.race 到点返回后，底层
  // socket 仍在读字节——「超时」只是不再等待，不是真的取消。这里把外部 signal
  // 级联到内部控制器，沿 safeRequestOnce → req.destroy 真正释放连接。
  let onOuterAbort = null;
  if (o.signal) {
    if (o.signal.aborted) ctrl.abort();
    else {
      onOuterAbort = () => { try { ctrl.abort(); } catch (e2) { /* 忽略重复 abort */ } };
      try { o.signal.addEventListener('abort', onOuterAbort, { once: true }); } catch (e2) { /* 非标准 signal：降级为仅自身超时 */ }
    }
  }
  let lastHost = null; // 网络异常（超时等）也计入同域失败熔断
  try {
    // 🔴 连接语义（复审 §一）：每跳 = safeRequestOnce（assertPublicUrl 先行 +
    // safeLookup 受控连接）——禁止经全局 fetch 绕过连接阶段 DNS 校验；
    // 重定向由本层手动逐跳处理，每一跳都重新过 FetchGate/robots/公网校验。
    let current = url, hops = 0, res = null;
    while (true) {
      const preU = new URL(current);
      lastHost = preU.hostname;
      // 合规门：熔断中直接退出；robots 禁止=确定性合规退出（不算站点失败）；同域节流等待
      const gate = FetchGate.beforeRequest(preU.hostname);
      if (!gate.allowed) return { ok: false, error: 'FETCH_CIRCUIT_OPEN' };
      if (gate.waitMs) await new Promise(r2 => setTimeout(r2, gate.waitMs));
      const robots = await FetchGate.robotsAllows(preU.origin, preU.pathname);
      if (robots === false) { FetchGate.recordResult(preU.hostname, true); return { ok: false, error: 'ROBOTS_DISALLOWED' }; }
      // Wave 1：受控自定义头（如 DataForSEO Basic auth）——仅合并进请求，
      // 绝不进快照/日志/错误信息（凭据红线）；method 支持 JSON API POST。
      const extraHeaders = (o.headers && typeof o.headers === 'object') ? o.headers : {};
      res = await safeRequestOnce(current, { timeoutMs: timeoutMs || 12000, signal: ctrl.signal, method: o.method || 'GET', body: o.body != null ? o.body : undefined, headers: Object.assign({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.8' }, extraHeaders) });
      if (res.status >= 300 && res.status < 400 && res.headers && res.headers.location) {
        hops++;
        if (hops > 3) { const sid = recFail(Snapshot.SOURCE_STATUS.UNAVAILABLE, 'too_many_redirects', res.status, current, hops); return { ok: false, error: 'too_many_redirects', snapshotId: sid }; }
        current = new URL(String(res.headers.location), res.url).href;
        continue;
      }
      break;
    }
    if (!(res.status >= 200 && res.status < 300)) {
      FetchGate.recordResult(lastHost, false); // 计入同域失败熔断
      const st = Snapshot.mapHttpStatus(res.status);
      const sid = recFail(st, st === Snapshot.SOURCE_STATUS.RATE_LIMITED ? 'http:429' : ('http:' + res.status), res.status, current, hops);
      return { ok: false, status: res.status, snapshotId: sid };
    }
    FetchGate.recordResult(lastHost, true);
    // 原始字节截获：hash/blob 基于「解析与规范化之前」的响应字节（修正 5）
    const buf = res.buffer;
    const observedAt = new Date().toISOString();
    const lastMod = res.headers && res.headers['last-modified'];
    const resCt = res.headers && res.headers['content-type'];
    let sid;
    let prov = { recorded: false };
    try {
      const s = Snapshot.record({ capability: 'evidence_url', provider: 'generic_web_fetch', source_url: UrlRedact.redactUrl(url), final_url: UrlRedact.redactUrl(current), redirect_hops: hops, http_status: res.status, source_status: Snapshot.SOURCE_STATUS.SUCCESS, observed_at: observedAt, fetched_at: fetchedAt, bodyBytes: buf, contentType: resCt, source_updated_at: lastMod, trigger: o.trigger, tenantId: o.tenantId });
      if (s.recorded) { sid = s.meta.snapshot_id; prov = { recorded: true, source_snapshot_id: s.meta.snapshot_id, observed_at: s.meta.observed_at, source_status: s.meta.source_status, content_hash: s.meta.content_hash, fetched_at: s.meta.fetched_at }; }
      else prov = s;
    } catch (e) { loggerError('fetchPage', e, url); }
    const html = buf.toString('utf8');
    // SC-06：需要原始 HTML 解析（JSON-LD/canonical 大小写敏感）的调用方显式
    // 声明 includeHtml；默认不返回（控制既有调用方的内存足迹）。上限 2MB。
    const out = { ok: true, url: current || url, text: stripHtml(html).slice(0, 9000), htmlLower: html.toLowerCase().slice(0, 200000), snapshotId: sid, _prov: prov };
    if (o.includeHtml) out.html = html.slice(0, 2 * 1024 * 1024);
    Cache.set('fetch-page', ck, out);
    return out;
  } catch (e) {
    const cls = Snapshot.classifyError(e);
    const sid = recFail(cls.source_status, cls.error_code, null, typeof current !== 'undefined' ? current : url, 0);
    if (e && String(e.message).startsWith('SSRF_BLOCKED')) return { ok: false, error: e.message, snapshotId: sid };
    try { if (lastHost) FetchGate.recordResult(lastHost, false); } catch (e2) { /* 熔断记账失败不影响返回 */ }
    return { ok: false, error: String(e && e.message || e), snapshotId: sid };
  }
  finally {
    clearTimeout(timer);
    if (onOuterAbort && o.signal && o.signal.removeEventListener) {
      try { o.signal.removeEventListener('abort', onOuterAbort); } catch (e2) { /* 清理失败无害 */ }
    }
  }
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
// repPrice = 商品代表价（02 §6.1，每商品一个观察点）；minPrice/maxPrice保留供区间展示。
// **全部变体为 0 元**的商品保留 minPrice=0 交给调用方单列 freebies（报告-数据同源 §5）——
// 此前在变体层就被 n>0 过滤整条丢失，comp.freebies 恒空。混合免费+付费变体的商品
// repPrice 取非明确缺货的付费变体中位（02 §6.1）；未知availability维持原有观察，
// 不编造断货。原始min/max仍覆盖所有价格，Fact提取不受展示代表价筛选影响。
// soldOut：全部变体明确 available=false 才断货（字段缺失≠断货，规格 5.2 禁推断）。
// publishedAt：上架时间透传（断点：上新事件的佐证字段，规格 5.2）。
function mapShopifyItems(products, cap) {
  const list = (Array.isArray(products) ? products : []).slice(0, cap || Infinity);
  return list.map(p => {
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const nums = variants.map(v => parseFloat(v.price)).filter(n => !isNaN(n));
    const prices = nums.filter(n => n > 0);
    const currentNums = variants.filter(v => v.available !== false)
      .map(v => parseFloat(v.price)).filter(Number.isFinite);
    const currentPrices = currentNums.filter(n => n > 0);
    const soldOut = variants.length > 0 && variants.every(v => v.available === false);
    const repPrice = currentPrices.length ? variantMedian(currentPrices)
      : (soldOut && prices.length ? variantMedian(prices) : (currentNums.includes(0) ? 0 : null));
    const minPrice = prices.length ? Math.min(...prices) : (nums.length ? 0 : null);
    return {
      title: p.title, type: p.product_type || '',
      id: p.id != null ? p.id : null,
      handle: p.handle || null, // SC-05：商品稳定键来源（id 缺失时用 handle + 已核验域名）
      variantCount: variants.length, // 规格签名代理：变体集变化 → 价格不可直接比较（lib/watch-price §6）
      minPrice,
      maxPrice: prices.length ? Math.max(...prices) : (nums.length ? 0 : null),
      repPrice,
      soldOut,
      publishedAt: p.published_at || null
    };
  }).filter(x => x.minPrice != null);
}
// Shopify 站结构化价格：/products.json 公开端点，零 LLM，verified 级。
// 分页观察目录（05 §5.2：limit=250 × ≤4页；超过预算显式partial_scan；
// 页间 ≥2s 限速；首页失败=整体失败，后续页失败用已有数据）。total = 实抓款数（分页后趋近全量）。
// 同时探测 /cart.js 的店铺结账币种：products.json 价格以店铺币种计且 JSON 本身不带币种，
// 店铺币种 ≠ 调研市场币种时（如日销店 ¥800），调用方不得把数值直接当市场价入带。
// 🔴 2026-10-18 整改（SC-02 §4/§9，独立审核真值链要求）：
//   · 每个参与汇总的页面各自落 SourceSnapshot（source_url 带 ?page=N），
//     Evidence 必须引用**全部**页面快照——不允许用首页快照证明全部页的
//     总数/最低/最高/中位（汇总可复算性）；
//   · /cart.js 币种为独立 SourceSnapshot（capability 'storefront_currency'）；
//     currency 值只有在币种快照成功落账时才非 null，否则一律 null——
//     「无可追溯快照的币种不得进入 Evidence/业务口径」。
// partial_scan 按「枚举是否完整」判定——4×250 预算耗尽或中途页失败提前
// 收束 = partial；末页自然收束 = success（05 §5.2 冻结术语）。
// M1–M4 增量（合流约定）：返回值 snapshotIds 仅含产品页快照（snapshotId
// 保留首页兼容），currencySnapshotId 单独引用 cart.js 币种快照——监控身份
// 边界按端点逐一校验；data-surface adapter 层负责把币种快照并入 Evidence
// 引用全集。rejectRedirects（正式监控）＝不跟随任何重定向 + host 精确身份
// + collectorVersion 'net-shopify-direct-2'。
// opts（可选）：{ trigger, tenantId }
const SHOPIFY_PAGE_LIMIT = 250;
const SHOPIFY_MAX_PAGES = 4;
const SHOPIFY_PAGE_DELAY_MS = 2000;
// ============================================================
// SSRF 安全抓取（2026-10-18 复审整改 §一）
//   · assertPublicUrl 先行：任何连接建立前完成协议/主机/DNS 解析/IP/私网校验；
//   · manual redirect：不自动跟随。逐跳解析 Location（相对→绝对），每跳重新
//     执行 assertPublicUrl（含重解析 DNS）——公网 302 到私网/多跳中途入私网
//     一律拒绝；
//   · 受控 lookup：连接阶段对 DNS 结果再过一次 isPrivateIp 黑名单，挡住
//     DNS rebinding（校验通过后 IP 被换成私网地址的连接尝试）。
//     注：IP 字面量 host 不经过 lookup（node 直连 IP 不回调），IP 形态已在
//     assertPublicUrl 逐跳判定；
//   · 超过 MAX_REDIRECT_HOPS 跳 = SAFE_FETCH_TOO_MANY_REDIRECTS（不跟随）。
// 返回 { status, headers, buffer }；拒绝/超时抛 Error（SSRF_BLOCKED:* 前缀）。
// ============================================================
const nodeHttp = require('node:http');
const nodeHttps = require('node:https');
const dnsMod = require('node:dns');
const MAX_REDIRECT_HOPS = 3;
const SAFE_FETCH_MAX_BYTES = 2 * 1024 * 1024; // shopify products.json 单页上限（防内存炸）

// 受控 DNS 解析：连接阶段第二道闸（rebinding 防线）
// 受控 DNS 解析：连接阶段第二道闸（rebinding 防线）。
// 🔴 整改（r3 §一）：Node 连接层自定义 lookup 回调必须返回**单个已验证公网 IP +
// 正确 address family**（address, family）——返回数组会触发 ERR_INVALID_IP_ADDRESS
// （真实最小复现：safeRequest('https://<公网域名>/…') 即崩）。
// DNS 解析、私网过滤、实际连接使用的地址必须是**同一份受控结果**：本函数完成
// 解析 → 私网过滤 → 选出首个公网 IP → 把该 IP 与 family 交给连接层，杜绝
// 「校验一份、连接另一份」的 rebinding 窗口。
// IP 字面量 host 不经过本函数（node 直连 IP 不回调 lookup），IP 形态已在
// assertPublicUrl 逐跳判定。
function safeLookup(hostname, options, cb) {
  // 🔴 Node ≥ 20 的 net 连接层可能以 { all: true } 调用 lookup，期望回调第二个参数是
  // **数组**；若只走 (err, address, family) 三参形式，Node 22 会因拿不到数组
  // 抛 "Invalid IP address: undefined" → 所有真实出站请求在连接阶段即失败。
  // 两种签名都支持：all:true 交数组，否则交单条（语义与 SSRF 校验完全不变）。
  const wantAll = !!(options && options.all === true);
  dnsMod.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) { cb(err); return; }
    const list = (Array.isArray(addrs) ? addrs : [addrs]).filter(Boolean);
    if (!list.length) { cb(new Error('SSRF_BLOCKED:dns_empty:' + hostname)); return; }
    // 私网过滤：任一解析结果为私网即拒（不挑公网放行——避免「混合记录」绕过）
    for (const a of list) {
      if (isPrivateIp(a && a.address)) { cb(new Error('SSRF_BLOCKED:private_dns_connect:' + hostname)); return; }
    }
    // 受控结果 = 首个公网条目（IP + family 成对交出）
    const first = list[0];
    const address = String(first.address);
    const family = first.family === 6 || (first.family == null && address.includes(':')) ? 6 : 4;
    if (wantAll) {
      cb(null, [{ address, family }]);
      return;
    }
    cb(null, address, family);
  });
}

// 单跳安全请求：assertPublicUrl 先行 → 受控 lookup（safeLookup：单 IP+family，
// 连接阶段二次私网校验）发起连接。不跟随重定向——由调用方决定逐跳语义。
// 返回 { status, headers, buffer, url }；url = 实际请求的已校验 URL。
async function safeRequestOnce(rawUrl, opts) {
  const o = opts || {};
  const u = await assertPublicUrl(rawUrl); // 连接前校验：协议/主机/DNS+私网
  const res = await new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? nodeHttps : nodeHttp;
    const req = mod.request({
      protocol: u.protocol,
      hostname: String(u.hostname || '').replace(/^\[/, '').replace(/\]$/, ''), // IPv6 字面量去括号（连接层期望裸地址）
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: o.method || 'GET',
      headers: Object.assign({ 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US;en;q=0.8' }, o.headers || {}),
      lookup: safeLookup,
      timeout: o.timeoutMs || 30000,
    }, (r) => {
      const chunks = [];
      let total = 0;
      r.on('data', (c) => {
        total += c.length;
        if (total > (o.maxBytes || SAFE_FETCH_MAX_BYTES)) { req.destroy(new Error('SAFE_FETCH_TOO_LARGE')); return; }
        chunks.push(c);
      });
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, buffer: Buffer.concat(chunks), url: u.href }));
      r.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('SAFE_FETCH_TIMEOUT')));
    req.on('error', reject);
    // SC-06 修复：上层 AbortController（fetchPage 总超时）必须能打断请求——
    // 否则对方服务器慢速滴漏字节时 socket timeout 永不触发，请求永久挂死
    // （SC-06 实测 VAUDE 复现：8s 超时设置下 30s 无返回）。
    if (o.signal) {
      const onAbort = () => req.destroy(new Error('SAFE_FETCH_ABORTED'));
      if (o.signal.aborted) onAbort();
      else o.signal.addEventListener('abort', onAbort, { once: true });
    }
    // Wave 1：受控请求体（JSON API POST；凭据在 Authorization 头，体不进快照/日志）
    if (o.body != null) req.write(o.body);
    req.end();
  });
  return res;
}

async function safeRequest(rawUrl, opts) {
  const o = opts || {};
  const maxHops = o.followRedirects === false ? 0 : MAX_REDIRECT_HOPS; // followRedirects:false = 调用方自行逐跳控制
  if (o.followRedirects === false) return safeRequestOnce(rawUrl, o); // 不跟随：单跳响应（含 3xx）原样交回调用方落账
  let current = String(rawUrl);
  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await safeRequestOnce(current, o);
    if (res.status >= 300 && res.status < 400 && res.headers && res.headers.location) {
      current = new URL(String(res.headers.location), res.url).href; // 相对/绝对 Location 归一
      continue; // 下一跳重新走 assertPublicUrl + safeLookup
    }
    return res;
  }
  throw new Error('SAFE_FETCH_TOO_MANY_REDIRECTS');
}
// Shopify collection 存储/展示预算（SC-02 整改 §三.4）：超出部分诚实标 partial，
// 不谎报完整枚举；原始字节仍在快照内可追溯。
const COLLECTIONS_STORE_CAP = 50;

// HTTP status → 05 §11 字面量（快照层 mapHttpStatus 未导出，此处同规则内联）
function cartHttpStatusToSourceStatus(status) {
  const s = Number(status);
  if (s === 429) return 'rate_limited';
  if (s === 401 || s === 403 || s === 407) return 'blocked';
  return 'unavailable';
}
async function fetchShopifyProducts(siteUrl, opts) {
  const o = opts || {};
  // Formal known-source monitoring refuses redirects entirely: the destination
  // has not been admitted or DNS-checked. Legacy callers retain their behavior.
  const noRedirect = o.rejectRedirects === true; // 正式监控：不跟随任何重定向
  const recordSnapshot = input => Snapshot.record({ ...input, collectorVersion: o.rejectRedirects === true ? 'net-shopify-direct-2' : COLLECTOR_VERSION });
  // The admitted hostname is an exact identity boundary. www/root aliases have
  // not been independently approved; normalization remains legacy-only.
  let d;
  if (o.rejectRedirects === true) { try { d = new URL(siteUrl).hostname.toLowerCase(); } catch { d = ''; } }
  else d = domainOf(siteUrl);
  if (!d) return { ok: false };
  const fetchedAt = new Date().toISOString();
  const recFail = (sourceStatus, errorCode, httpStatus, failUrl) => {
    try {
      const s = recordSnapshot({ capability: 'product_catalog', provider: 'shopify_products_json', source_url: failUrl || `https://${d}/products.json`, final_url: null, redirect_hops: 0, http_status: httpStatus == null ? null : httpStatus, source_status: sourceStatus, error_code: errorCode || null, observed_at: null, fetched_at: fetchedAt, bodyBytes: null, trigger: o.trigger, tenantId: o.tenantId, projectRef: o.projectRef });
      return s.recorded ? s.meta.snapshot_id : undefined;
    } catch (e) { loggerError('fetchShopifyProducts', e, d); return undefined; }
  };
  try {
    // 🔴 SSRF 纪律（复审 §一.1/§一.2）：全部校验先行于任何连接——products.json 与
    // cart.js 的 assertPublicUrl 都完成后才发起请求；之后所有请求走 safeRequest
    //（manual redirect + 逐跳重校验 + 受控 lookup）。
    await assertPublicUrl(`https://${d}/products.json`);
    await assertPublicUrl(`https://${d}/cart.js`);
    // 币种探测：cart.js 原始响应体落独立快照——currency 非 null ⟺ 币种快照可解析
    //（无快照的币种不得进入业务口径）。
    const cartProbe = (async () => {
      try {
        const r = await safeRequest(`https://${d}/cart.js`, noRedirect ? { timeoutMs: 15000, followRedirects: false } : { timeoutMs: 15000 });
        if (!r || (r.status < 200 || r.status >= 300)) {
          const st = cartHttpStatusToSourceStatus(r && r.status);
          let sid;
          try {
            const s = recordSnapshot({ capability: 'storefront_currency', provider: 'shopify_cart_js_json', source_url: `https://${d}/cart.js`, final_url: null, redirect_hops: 0, http_status: r && r.status, source_status: st, error_code: 'http:' + (r && r.status), observed_at: null, fetched_at: fetchedAt, bodyBytes: r && r.buffer, contentType: r && r.headers && r.headers['content-type'], trigger: o.trigger, tenantId: o.tenantId, projectRef: o.projectRef });
            if (s.recorded) sid = s.meta.snapshot_id;
          } catch (e) { loggerError('fetchShopifyProducts:cart', e, d); }
          return { currency: null, snapshotId: sid };
        }
        const buf = r.buffer || Buffer.alloc(0);
        const observedAt = new Date().toISOString();
        let cur = null, parseFailed = false;
        try { const j = JSON.parse(buf.toString('utf8')); if (j && j.currency) cur = String(j.currency).toUpperCase(); } catch (e) { parseFailed = true; }
        let sid;
        try {
          const s = recordSnapshot({ capability: 'storefront_currency', provider: 'shopify_cart_js_json', source_url: `https://${d}/cart.js`, final_url: null, redirect_hops: 0, http_status: r.status, source_status: parseFailed ? 'parse_failed' : 'success', error_code: parseFailed ? 'parse_failed' : null, observed_at: observedAt, fetched_at: fetchedAt, bodyBytes: buf, contentType: r.headers && r.headers['content-type'], trigger: o.trigger, tenantId: o.tenantId, projectRef: o.projectRef, note: parseFailed ? 'cart.js body not valid JSON' : (cur ? 'storefront checkout currency' : 'cart.js responded without currency field') });
          if (s.recorded) sid = s.meta.snapshot_id;
        } catch (e) { loggerError('fetchShopifyProducts:cart', e, d); }
        return { currency: sid && !parseFailed ? cur : null, snapshotId: sid };
      } catch (e) {
        const msg = String((e && e.message) || e);
        const isTimeout = /timeout/i.test(msg);
        let cls;
        try { cls = Snapshot.classifyError(e); } catch (e2) { cls = { source_status: 'unavailable', error_code: msg.slice(0, 120) }; }
        if (isTimeout) cls = { source_status: 'timeout', error_code: 'abort:timeout' };
        let sid;
        try {
          const s = recordSnapshot({ capability: 'storefront_currency', provider: 'shopify_cart_js_json', source_url: `https://${d}/cart.js`, final_url: null, redirect_hops: 0, http_status: null, source_status: cls.source_status, error_code: cls.error_code, observed_at: null, fetched_at: fetchedAt, bodyBytes: null, trigger: o.trigger, tenantId: o.tenantId, projectRef: o.projectRef });
          if (s.recorded) sid = s.meta.snapshot_id;
        } catch (e2) { loggerError('fetchShopifyProducts:cart', e2, d); }
        return { currency: null, snapshotId: sid };
      }
    })();
    let products = [];
    let firstStatus = null;
    let firstError = null;
    let incompleteReason = null; // 非预算耗尽的提前收束（后续页失败）：partial_scan 的原因
    let firstObservedAt = null; // 首页快照 observed_at（Evidence 观察时间载体；非快照引用）
    const pageSnapshotIds = []; // 每页原始响应快照（全部参与汇总复算）
    const successfullyFetchedPages = []; // 结构化的页级成功清单（复审 §二.1）
    let failedPage = null; // { page, reason } 结构化失败页（复审 §二.1）
    for (let page = 1; page <= SHOPIFY_MAX_PAGES; page++) {
      let j = null;
      let buf = null, ct = null, lastMod = null, httpStatus = null;
      const pageUrl = `https://${d}/products.json?limit=${SHOPIFY_PAGE_LIMIT}&page=${page}`;
      try {
        const r = await safeRequest(pageUrl, noRedirect ? { timeoutMs: 20000, followRedirects: false } : { timeoutMs: 20000 });
        httpStatus = r.status;
        ct = r.headers && r.headers['content-type'];
        lastMod = r.headers && r.headers['last-modified'];
        buf = r.buffer || Buffer.alloc(0);
        if (!r.status || r.status < 200 || r.status >= 300) {
          if (page === 1) { firstStatus = r.status; }
          else {
            incompleteReason = 'products_json_page_' + page + '_http_' + r.status;
            failedPage = { page, reason: incompleteReason };
          }
          break; // 首页失败=整体失败；后续页失败用已有数据（partial）
        }
        try { j = JSON.parse(buf.toString('utf8')); } catch (pe) {
          if (page === 1) {
            let psid;
            try {
              const s = recordSnapshot({ capability: 'product_catalog', provider: 'shopify_products_json', source_url: pageUrl, final_url: null, redirect_hops: 0, http_status: httpStatus, source_status: Snapshot.SOURCE_STATUS.PARSE_FAILED, observed_at: new Date().toISOString(), fetched_at: fetchedAt, bodyBytes: buf, contentType: ct, trigger: o.trigger, tenantId: o.tenantId, projectRef: o.projectRef, note: 'json parse failed after body receipt; raw kept for replay' });
              if (s.recorded) psid = s.meta.snapshot_id;
            } catch (e) { loggerError('fetchShopifyProducts', e, d); }
            const cart = await cartProbe;
            return { ok: false, error: 'parse_failed', snapshotId: psid, snapshotIds: psid ? [psid] : [], currency: cart.currency, currencySnapshotId: cart.snapshotId || null, partialScan: true, partialScanReason: 'products_json_page_1_parse_failed', successfullyFetchedPages: [], failedPage: { page: 1, reason: 'products_json_page_1_parse_failed' } };
          }
          incompleteReason = 'products_json_page_' + page + '_parse_failed';
          failedPage = { page, reason: incompleteReason };
          break; // 后续页 parse 失败用已有数据（partial）
        }
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (msg.indexOf('SSRF_BLOCKED') === 0) throw e; // SSRF 拒绝不做 partial 收束，整体拒绝
        if (page === 1) throw e; // 首页网络异常上抛（保持原错误路径）
        incompleteReason = /timeout/i.test(msg) ? 'products_json_page_' + page + '_timeout' : 'products_json_page_' + page + '_error';
        failedPage = { page, reason: incompleteReason };
        break; // 后续页超时/网络错误用已有数据（partial）
      }
      // 页级快照：本页 2XX + 解析成功的原始字节（source_url 唯一化到页）
      try {
        const s = recordSnapshot({ capability: 'product_catalog', provider: 'shopify_products_json', source_url: pageUrl, final_url: null, redirect_hops: 0, http_status: httpStatus, source_status: Snapshot.SOURCE_STATUS.SUCCESS, observed_at: new Date().toISOString(), fetched_at: fetchedAt, bodyBytes: buf, contentType: ct, source_updated_at: lastMod, trigger: o.trigger, tenantId: o.tenantId, projectRef: o.projectRef, note: 'products.json page ' + page });
        if (s.recorded) { pageSnapshotIds.push(s.meta.snapshot_id); if (page === 1) firstObservedAt = s.meta.observed_at || null; }
      } catch (e) { loggerError('fetchShopifyProducts:page' + page, e, d); }
      successfullyFetchedPages.push(page);
      const arr = Array.isArray(j.products) ? j.products : [];
      products = products.concat(arr);
      if (arr.length < SHOPIFY_PAGE_LIMIT) break; // 末页自然收束
      if (page < SHOPIFY_MAX_PAGES) await new Promise(r2 => setTimeout(r2, SHOPIFY_PAGE_DELAY_MS));
    }
    if (firstStatus != null) {
      const st = Snapshot.mapHttpStatus(firstStatus);
      const fsid = recFail(st, st === Snapshot.SOURCE_STATUS.RATE_LIMITED ? 'http:429' : ('http:' + firstStatus), firstStatus, `https://${d}/products.json?limit=${SHOPIFY_PAGE_LIMIT}&page=1`);
      const cart = await cartProbe;
      return { ok: false, status: firstStatus, snapshotId: fsid, snapshotIds: fsid ? [fsid] : [], currency: cart.currency, currencySnapshotId: cart.snapshotId || null, partialScan: false, partialScanReason: null, successfullyFetchedPages: [], failedPage: null };
    }
    // partial 语义结构化（复审 §二）：预算耗尽 / 后续页 HTTP 失败 / 解析失败 / 超时网络错误 → partial
    const budgetExhausted = successfullyFetchedPages.length >= SHOPIFY_MAX_PAGES
      && products.length >= SHOPIFY_MAX_PAGES * SHOPIFY_PAGE_LIMIT;
    const partialScan = budgetExhausted || incompleteReason != null;
    const partialScanReason = budgetExhausted
      ? 'products_json_pagination_budget_250x4_exhausted'
      : (incompleteReason || null);
    // 🔴 复审 §四：**无聚合快照**。聚合统计（count/中位价/partial 范围）只进
    // attempt summary；原始字节以页级快照存在（source_url 与真实请求逐页对应，
    // 含 ?limit=&page= 查询参数）。禁止把 page=1 的 body 标成无查询参数的聚合 URL。
    const currency = await cartProbe;
    const scanMeta = { partialScan, partialScanReason, successfullyFetchedPages: successfullyFetchedPages.slice(), failedPage };
    // snapshotIds 仅含产品页快照（监控身份边界逐端点校验）；currencySnapshotId
    // 单独携带——data-surface adapter 层负责并入 Evidence 引用全集（D3 真值链）。
    const prov = { recorded: pageSnapshotIds.length > 0, observed_at: firstObservedAt }; // 元数据载体（非快照引用）
    if (!products.length) {
      return { ok: false, empty: true, snapshotId: pageSnapshotIds[0], snapshotIds: pageSnapshotIds.slice(), currency: currency.currency, currencySnapshotId: currency.snapshotId || null, _prov: prov, ...scanMeta };
    }
    const items = mapShopifyItems(products); // 全量透传（截尾统计/类目占比需要全量；调用方自控上限）
    return { ok: items.length > 0, items, total: products.length, truncated: budgetExhausted, url: `https://${d}/products.json`, currency: currency.currency, snapshotId: pageSnapshotIds[0], snapshotIds: pageSnapshotIds.slice(), currencySnapshotId: currency.snapshotId || null, _prov: prov, ...scanMeta };
  } catch (e) {
    const cls = Snapshot.classifyError(e);
    const csid = recFail(cls.source_status, cls.error_code, null);
    return { ok: false, error: String(e && e.message || e), snapshotId: csid, snapshotIds: csid ? [csid] : [], partialScan: false, partialScanReason: null, successfullyFetchedPages: [], failedPage: null };
  }
}
// Shopify /collections.json 店铺集合清单（S2 佐证：集合数/跨类目信号；规格 2.3 增强项的轻量版——
// 每 collection 的商品归属需逐集合再抓，成本高，留待 S2 全量接入时按需做）。
// Shopify /collections.json 店铺集合清单（S2 佐证：集合数/跨类目信号）。
// 🔴 2026-10-18 复审整改 §三：原始响应字节由本函数直接落 SourceSnapshot
//（adapter 不得重新序列化冒充）；查询参数进 source_url（影响返回范围）；
// 存储预算 COLLECTIONS_STORE_CAP 截断时诚实标 partial（sourceObservedCount/
// storedCount/partialScan/partialScanReason）。
async function fetchShopifyCollections(siteUrl, opts) {
  const o = opts || {};
  const d = domainOf(siteUrl);
  if (!d) return { ok: false };
  const sourceUrl = `https://${d}/collections.json?limit=250`;
  const fetchedAt = new Date().toISOString();
  try {
    await assertPublicUrl(sourceUrl); // SSRF：校验先行于连接
    const r = await safeRequest(sourceUrl, { timeoutMs: 15000 });
    if (!r.status || r.status < 200 || r.status >= 300) {
      return { ok: false, status: r.status, sourceUrl, partialScan: false, successfullyFetchedPages: 0, failedPage: { page: 'collections', reason: 'http_' + r.status } };
    }
    const buf = r.buffer || Buffer.alloc(0);
    let cols = [];
    let parseOk = true;
    try { const j = JSON.parse(buf.toString('utf8')); cols = Array.isArray(j.collections) ? j.collections : []; }
    catch (pe) { parseOk = false; }
    if (!parseOk) {
      // 原始字节仍落盘（parse_failed 快照供重放），语义失败
      try {
        Snapshot.record({ capability: 'storefront_collections', provider: 'shopify_collections_json', source_url: sourceUrl, final_url: null, redirect_hops: 0, http_status: r.status, source_status: Snapshot.SOURCE_STATUS.PARSE_FAILED, observed_at: new Date().toISOString(), fetched_at: fetchedAt, bodyBytes: buf, contentType: r.headers && r.headers['content-type'], trigger: o.trigger, tenantId: o.tenantId, note: 'collections.json parse failed; raw kept for replay' });
      } catch (e) { loggerError('fetchShopifyCollections', e, d); }
      return { ok: false, error: 'parse_failed', sourceUrl, partialScan: true, partialScanReason: 'collections_json_parse_failed', successfullyFetchedPages: 0, failedPage: { page: 'collections', reason: 'parse_failed' } };
    }
    const sourceObservedCount = cols.length;
    const stored = cols.slice(0, COLLECTIONS_STORE_CAP);
    const truncatedByBudget = sourceObservedCount > COLLECTIONS_STORE_CAP;
    const collections = stored.map(c => ({ title: String(c.title || '').slice(0, 80), handle: String(c.handle || '').slice(0, 80) }));
    // 原始响应字节快照（真实服务器返回，非重新序列化）
    let snapshotId = null;
    const partialScan = truncatedByBudget;
    const partialScanReason = truncatedByBudget
      ? 'collections_store_cap_' + COLLECTIONS_STORE_CAP + '_of_' + sourceObservedCount
      : null;
    try {
      const s = Snapshot.record({
        capability: 'storefront_collections', provider: 'shopify_collections_json',
        source_url: sourceUrl, final_url: null, redirect_hops: 0, http_status: r.status,
        source_status: partialScan ? Snapshot.SOURCE_STATUS.PARTIAL : Snapshot.SOURCE_STATUS.SUCCESS,
        observed_at: new Date().toISOString(), fetched_at: fetchedAt,
        bodyBytes: buf, contentType: r.headers && r.headers['content-type'],
        trigger: o.trigger, tenantId: o.tenantId,
        partial_scan: partialScan, partial_scan_reason: partialScanReason,
        partial_scan_observed_count: sourceObservedCount,
        note: 'collections raw response bytes (query params preserved in source_url)',
      });
      if (s.recorded) {
        snapshotId = s.meta.snapshot_id;
        return {
          ok: collections.length > 0 || sourceObservedCount === 0,
          collections, url: `https://${d}/collections.json`, sourceUrl, snapshotId,
          _prov: { recorded: true, source_snapshot_id: s.meta.snapshot_id, observed_at: s.meta.observed_at, source_status: s.meta.source_status, content_hash: s.meta.content_hash, fetched_at: s.meta.fetched_at },
          partialScan, partialScanReason, sourceObservedCount, storedCount: collections.length,
          successfullyFetchedPages: 1, failedPage: null,
        };
      }
    } catch (e) { loggerError('fetchShopifyCollections', e, d); }
    // 快照落账失败：返回无快照结果（validator 会拒绝证据不完整的 success）
    return {
      ok: collections.length > 0 || sourceObservedCount === 0,
      collections, url: `https://${d}/collections.json`, sourceUrl, snapshotId: null,
      partialScan, partialScanReason, sourceObservedCount, storedCount: collections.length,
      successfullyFetchedPages: 1, failedPage: null,
    };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), sourceUrl, partialScan: false, successfullyFetchedPages: 0, failedPage: { page: 'collections', reason: 'error' } };
  }
}

// 🔴 R3 P0：把受控安全取回器注入 fetch-gate——robots.txt 从此与正文共用同一条
// 安全网络路径（assertPublicUrl 先行 + 受控 DNS 连接 + 手动逐跳重定向 + 超时/大小/跳数），
// 关闭「robots 阶段先于校验形成连接」的 SSRF 绕过（未注入时 fetch-gate 返回 null 即 fail-open）。
try { FetchGate.setRobotsFetcher(safeRequest); } catch (e) { /* 注入失败不阻断模块加载 */ }

module.exports = { domainOf, stripHtml, isPrivateIp, assertPublicUrl, safeLookup, safeRequest, safeRequestOnce, fetchPage, mapShopifyItems, variantMedian, fetchShopifyProducts, fetchShopifyCollections, COLLECTOR_VERSION, COLLECTIONS_STORE_CAP };
