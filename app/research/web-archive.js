'use strict';
// ============================================================
// research/web-archive.js —— 公开网页存档（Wayback）最小接入（SC-05 §5.2）
//
// 只做两件事：发现候选快照（CDX 索引）与取回历史原始字节（replay + `id_`）。
// 纪律：
//   · 全部出网走 net.assertPublicUrl + FetchGate（robots/熔断/同域节流）+ safeRequest
//     （逐跳重定向重新校验），不绕过 SSRF / 重定向 / 大小限制；
//   · 原始字节落 SourceSnapshot（capability product_catalog_archive，provider web_archive）；
//     快照的 source_url 是存档回放地址，note 里带原始 URL 与存档时间——
//     绝不把「存档抓取时间」当成「原始网页发生时间」；
//   · 失败如实返回分类（unreachable / rate_limited / blocked / parse_failed /
//     no_record），由调用方决定用户文案，本模块不产出面向用户的结论。
// ============================================================
const Snapshot = require('./source-snapshot.js');
const Net = require('./net.js');
const FetchGate = require('../services/fetch-gate.js');

const CDX_ENDPOINT = 'https://web.archive.org/cdx/search/cdx';
const REPLAY_HOST = 'web.archive.org';
const CDX_TIMEOUT_MS = 20000;
const REPLAY_TIMEOUT_MS = 30000;

function isArchiveUrl(u) {
  try { return new URL(String(u)).hostname.replace(/^www\./, '').toLowerCase() === REPLAY_HOST; } catch (e) { return false; }
}
// CDX timestamp（YYYYMMDDhhmmss）→ ISO；精度到日，故统一取当天 00:00Z 并标 day
function archiveTimestampToIso(ts) {
  const s = String(ts || '').replace(/\D/g, '');
  if (s.length < 8) return null;
  const y = s.slice(0, 4), m = s.slice(4, 6), d = s.slice(6, 8);
  const iso = y + '-' + m + '-' + d + 'T00:00:00.000Z';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? iso : null;
}
function compactDate(iso) { return String(iso || '').slice(0, 10).replace(/-/g, ''); }

// ---------------- ① 发现：CDX 索引 ----------------
// 返回 { ok, rows:[{timestamp, iso, original, statuscode, digest}], failureClass, httpStatus }
async function discoverSnapshots(input) {
  const o = input || {};
  const target = String(o.url || '');
  const from = compactDate(o.from);
  const to = compactDate(o.to);
  if (!target || !from || !to) return { ok: false, rows: [], failureClass: 'invalid_request' };
  const limit = Math.max(1, Math.min(Number(o.limit) || 200, 500));
  const qs = [
    'url=' + encodeURIComponent(target.replace(/^https?:\/\//, '')),
    'output=json',
    'fl=timestamp,original,statuscode,digest',
    'filter=statuscode:200',
    'collapse=digest',
    'from=' + from, 'to=' + to, 'limit=' + limit,
  ].join('&');
  const url = CDX_ENDPOINT + '?' + qs;
  try {
    await Net.assertPublicUrl(url);
    const gate = FetchGate.beforeRequest(REPLAY_HOST);
    if (!gate.allowed) return { ok: false, rows: [], failureClass: 'unreachable' };
    if (gate.waitMs) await new Promise(r => setTimeout(r, gate.waitMs));
    const robots = await FetchGate.robotsAllows('https://' + REPLAY_HOST, '/cdx/search/cdx');
    if (robots === false) return { ok: false, rows: [], failureClass: 'blocked' };
    const res = await Net.safeRequest(url, { timeoutMs: CDX_TIMEOUT_MS, maxBytes: 4 * 1024 * 1024 });
    if (!res || !res.status) return { ok: false, rows: [], failureClass: 'unreachable' };
    if (res.status === 429) { FetchGate.recordResult(REPLAY_HOST, false); return { ok: false, rows: [], failureClass: 'rate_limited', httpStatus: 429 }; }
    if (res.status < 200 || res.status >= 300) {
      FetchGate.recordResult(REPLAY_HOST, false);
      return { ok: false, rows: [], failureClass: res.status === 403 ? 'blocked' : 'unreachable', httpStatus: res.status };
    }
    FetchGate.recordResult(REPLAY_HOST, true);
    let arr = null;
    try { arr = JSON.parse((res.buffer || Buffer.alloc(0)).toString('utf8')); }
    catch (e) { return { ok: false, rows: [], failureClass: 'parse_failed', httpStatus: res.status }; }
    if (!Array.isArray(arr) || !arr.length) return { ok: true, rows: [], httpStatus: res.status };
    const header = arr[0];
    const idx = { ts: header.indexOf('timestamp'), orig: header.indexOf('original'), status: header.indexOf('statuscode'), digest: header.indexOf('digest') };
    const rows = arr.slice(1).map(r => ({
      timestamp: String(r[idx.ts] || ''),
      iso: archiveTimestampToIso(r[idx.ts]),
      original: String(r[idx.orig] || target),
      statuscode: Number(r[idx.status]),
      digest: String(r[idx.digest] || ''),
    })).filter(r => r.timestamp && r.iso);
    return { ok: true, rows, httpStatus: res.status };
  } catch (e) {
    const msg = String((e && e.message) || e);
    // 失败分类要诚实：本地设施故障（数据库/文件不可写）不是「来源不可用」，
    // 不能把自家问题写成对方不提供数据。
    const cls = /SSRF_BLOCKED/.test(msg) ? 'blocked'
      : /TOO_MANY_REDIRECTS|timeout|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|ECONNRESET|Failed to connect/i.test(msg) ? 'unreachable'
        : 'internal';
    FetchGate.recordResult(REPLAY_HOST, false);
    return { ok: false, rows: [], failureClass: cls, error: msg.slice(0, 160) };
  }
}

// ---------------- ② 取回：存档原始字节 ----------------
// `id_` 后缀返回未经 Wayback 改写的原始响应体，才能复用 Shopify 解析器。
async function fetchArchivedBody(input) {
  const o = input || {};
  const timestamp = String(o.timestamp || '').replace(/\D/g, '');
  const original = String(o.originalUrl || o.url || '');
  const tenantId = o.tenantId;
  const trigger = o.trigger || 'manual';
  if (!timestamp || !original) return { ok: false, failureClass: 'invalid_request' };
  const originalNorm = original.replace(/^https?:\/\//, '');
  const replayUrl = 'https://' + REPLAY_HOST + '/web/' + timestamp + 'id_/' + originalNorm;
  const fetchedAt = new Date().toISOString();
  const recFail = (sourceStatus, errorCode, httpStatus) => {
    try {
      const s = Snapshot.record({
        capability: 'product_catalog_archive', provider: 'web_archive',
        source_url: replayUrl, final_url: null, redirect_hops: 0,
        http_status: httpStatus == null ? null : httpStatus, source_status: sourceStatus,
        error_code: errorCode || null, observed_at: null, fetched_at: fetchedAt,
        bodyBytes: null, trigger, tenantId,
        note: 'archive replay failed; original=' + originalNorm + '; archive_ts=' + timestamp,
      });
      return s.recorded ? s.meta.snapshot_id : undefined;
    } catch (e) { return undefined; }
  };
  try {
    await Net.assertPublicUrl(replayUrl);
    const gate = FetchGate.beforeRequest(REPLAY_HOST);
    if (!gate.allowed) return { ok: false, failureClass: 'unreachable', replayUrl };
    if (gate.waitMs) await new Promise(r => setTimeout(r, gate.waitMs));
    const robots = await FetchGate.robotsAllows('https://' + REPLAY_HOST, '/web/' + timestamp + 'id_/' + originalNorm);
    if (robots === false) return { ok: false, failureClass: 'blocked', replayUrl, snapshotId: recFail(Snapshot.SOURCE_STATUS.BLOCKED, 'robots_disallowed', null) };
    const res = await Net.safeRequest(replayUrl, { timeoutMs: REPLAY_TIMEOUT_MS, maxBytes: Snapshot.maxBytes() });
    if (!res || !res.status) return { ok: false, failureClass: 'unreachable', replayUrl, snapshotId: recFail(Snapshot.SOURCE_STATUS.UNAVAILABLE, 'no_response', null) };
    if (res.status === 429) { FetchGate.recordResult(REPLAY_HOST, false); return { ok: false, failureClass: 'rate_limited', httpStatus: 429, replayUrl, snapshotId: recFail(Snapshot.SOURCE_STATUS.RATE_LIMITED, 'http:429', 429) }; }
    if (res.status < 200 || res.status >= 300) {
      FetchGate.recordResult(REPLAY_HOST, false);
      const st = Snapshot.mapHttpStatus(res.status);
      return { ok: false, failureClass: st === 'blocked' ? 'blocked' : 'unreachable', httpStatus: res.status, replayUrl, snapshotId: recFail(st, 'http:' + res.status, res.status) };
    }
    FetchGate.recordResult(REPLAY_HOST, true);
    const buf = res.buffer || Buffer.alloc(0);
    if (!buf.length) return { ok: false, failureClass: 'parse_failed', httpStatus: res.status, replayUrl, snapshotId: recFail(Snapshot.SOURCE_STATUS.PARSE_FAILED, 'empty_body', res.status) };
    let sid = null;
    let prov = { recorded: false };
    try {
      const s = Snapshot.record({
        capability: 'product_catalog_archive', provider: 'web_archive',
        source_url: replayUrl, final_url: null, redirect_hops: 0, http_status: res.status,
        source_status: Snapshot.SOURCE_STATUS.SUCCESS, observed_at: new Date().toISOString(),
        fetched_at: fetchedAt, bodyBytes: buf,
        contentType: res.headers && res.headers['content-type'], trigger, tenantId,
        note: 'web archive replay; original=' + originalNorm + '; archive_ts=' + timestamp + '; archive_precision=day',
      });
      if (s.recorded) { sid = s.meta.snapshot_id; prov = { recorded: true, observed_at: s.meta.observed_at, content_hash: s.meta.content_hash }; }
    } catch (e) { return { ok: false, failureClass: 'snapshot_failed', replayUrl }; }
    if (!sid) return { ok: false, failureClass: 'snapshot_failed', replayUrl };
    return {
      ok: true, replayUrl, snapshotId: sid, buffer: buf,
      httpStatus: res.status,
      effectiveAt: archiveTimestampToIso(timestamp),
      timePrecision: 'day',
      observedAt: prov.observed_at || new Date().toISOString(),
    };
  } catch (e) {
    const msg = String((e && e.message) || e);
    FetchGate.recordResult(REPLAY_HOST, false);
    const cls = /SSRF_BLOCKED/.test(msg) ? 'blocked' : 'unreachable';
    return { ok: false, failureClass: cls, replayUrl, snapshotId: recFail(Snapshot.SOURCE_STATUS.UNAVAILABLE, 'fetch_failed', null), error: msg.slice(0, 160) };
  }
}

// ---------------- ③ 分桶：每月最多一个有效快照 ----------------
// 同一 digest 视为同内容（去重）；每月取该月最早一条（稳定、可复现），
// 上限默认 24 点 —— 不把缺口补成连续趋势。
function bucketByMonth(rows, opts) {
  const o = opts || {};
  const cap = Math.max(1, Math.min(Number(o.maxPoints) || 24, 60));
  const seenDigest = new Set();
  const byMonth = new Map();
  for (const r of (rows || []).slice().sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)))) {
    if (r.digest && seenDigest.has(r.digest)) continue;
    const mo = String(r.iso || '').slice(0, 7);
    if (!mo) continue;
    if (byMonth.has(mo)) continue;
    if (r.digest) seenDigest.add(r.digest);
    byMonth.set(mo, r);
  }
  const picked = [...byMonth.values()].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
  const capped = picked.slice(-cap); // 保留最近 cap 个月（更早的先放弃，避免无限回补）
  return {
    points: capped,
    discoveredMonths: byMonth.size,
    droppedByCap: Math.max(0, picked.length - capped.length),
    cap,
  };
}

module.exports = {
  CDX_ENDPOINT, REPLAY_HOST, archiveTimestampToIso, compactDate, isArchiveUrl,
  discoverSnapshots, fetchArchivedBody, bucketByMonth,
};
