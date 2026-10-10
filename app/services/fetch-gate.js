'use strict';
// ============================================================
// services/fetch-gate.js —— 抓取合规门（抓取需求 §2.2 验收项）
//   ① robots.txt：每域抓取并缓存 24h（Cache kind 'robots-txt'）；抓取失败 fail-open 放行
//     （RFC 9309：不可得 ≠ 禁止）；404 = 无 robots = 全允许（同样缓存，免重复探测）
//   ② 同域节流：同域两次请求 ≥3s 间隔（§2.2「per-domain 节流与退避」初值）
//   ③ 失败熔断：同域连续 ≥5 次失败 → 熔断 10 分钟（半开到期自动恢复），防同域反复撞墙
// 状态在进程内（内存 Map）；robots 文本跨进程走 Cache。
// 判定与计时不做 IO——beforeRequest/recordResult 注入 nowMs 供单测。
// ============================================================
const Cache = require('./cache.js');
const Robots = require('../lib/robots.js');

const DOMAIN_INTERVAL_MS = Number(process.env.ZB_FETCH_INTERVAL_MS) || 3000; // 同域间隔（§2.2 ≥3s）
const FAIL_THRESHOLD = 5;        // 连续失败熔断阈值
const CIRCUIT_MS = 10 * 60 * 1000; // 熔断 10 分钟

const lastRequestAt = new Map(); // host -> ts
const failures = new Map();      // host -> { n, openedAt }

function beforeRequest(host, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const f = failures.get(host);
  if (f && f.openedAt > 0) {
    if (now - f.openedAt < CIRCUIT_MS) return { allowed: false, waitMs: 0, reason: 'circuit-open' };
    failures.delete(host); // 半开：到期恢复（下一次成败照常记账）
  }
  const last = lastRequestAt.get(host) || 0;
  const waitMs = Math.max(0, last + DOMAIN_INTERVAL_MS - now);
  lastRequestAt.set(host, now + waitMs); // 占位（含等待后的生效时刻，保证并发调用也排队）
  return { allowed: true, waitMs, reason: null };
}

function recordResult(host, ok, nowMs) {
  const f = failures.get(host) || { n: 0, openedAt: 0 };
  if (ok) { failures.delete(host); return; }
  f.n += 1;
  if (f.n >= FAIL_THRESHOLD) { f.openedAt = nowMs != null ? nowMs : Date.now(); f.n = 0; }
  failures.set(host, f);
}

// robots.txt 判定：返回 true=允许 / false=禁止。fetchImpl 可注入（单测）。
// 抓取失败/非 2xx（除 404）→ null（调用方按 fail-open 处理，且本次结果不缓存）。
async function robotsAllows(origin, pathname, fetchImpl) {
  const key = origin;
  const cached = Cache.get('robots-txt', key);
  let rules = null;
  if (cached === 'none') return true;          // 404：无 robots → 全允许
  if (cached && cached.txt != null) rules = Robots.parse(cached.txt);
  if (!cached) {
    let txt = null, notFound = false;
    try {
      const f = fetchImpl || fetch;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      try {
        const r = await f(origin + '/robots.txt', { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ZhibiVantage/1.0; +compliance)' }, signal: ctrl.signal });
        if (r.status === 404) notFound = true;
        else if (r.ok) txt = await r.text();
        // 其它状态（403/5xx）→ txt 保持 null → fail-open 且不缓存
      } finally { clearTimeout(timer); }
    } catch (e) { /* 网络失败 → fail-open，不缓存 */ }
    if (notFound) { Cache.set('robots-txt', key, 'none', 86400); return true; }
    if (txt == null) return null; // 不可判定 → fail-open
    Cache.set('robots-txt', key, { txt }, 86400);
    rules = Robots.parse(txt);
  }
  return Robots.isAllowed(rules, pathname);
}

function resetForTest() { lastRequestAt.clear(); failures.clear(); }

module.exports = { beforeRequest, recordResult, robotsAllows, resetForTest, DOMAIN_INTERVAL_MS, FAIL_THRESHOLD, CIRCUIT_MS };
