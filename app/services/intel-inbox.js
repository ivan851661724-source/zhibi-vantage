'use strict';
// ============================================================
// services/intel-inbox.js —— 每日变化收件箱真源（SC-08 §二）
// ------------------------------------------------------------
// 职责：只承载「基线建立之后，由两次可比较观察产生的确定性变化」。
//
// 硬规则（任务书 §二 字段规则）：
//   ① origin 只有 'monitoring' 进收件箱；'backfill' / 'history' 只进品牌时间线；
//   ② 首次采集建立 baseline，不生成 inbox event（由产生点保证：无前值时只写 baseline）；
//   ③ 无 Evidence 的事件只能是 pending——recordEvent 强制降级，不接受已核实样式；
//   ④ effectiveAt 无可靠来源必须 null；与 observedAt 完全相同的 effectiveAt 视为伪造 → 置 null；
//   ⑤ oldValue/newValue 保留真实类型（区间价格保留范围结构，不退化为标量）；
//   ⑥ 花费/ROI/GMV/转化率等不可直接观测字段禁止进入确定性 change（黑名单硬拦）；
//   ⑦ 维度白名单存在，但**未接入真实确定性 Diff 的维度不得写入**（见 DIMENSIONS_WITH_WRITERS）。
//
// 分页：cursor = base64(observed_at|event_id)，稳定排序 (observed_at DESC, event_id DESC)。
// ============================================================
const crypto = require('crypto');
const WatchStore = require('./watch-store.js');

const ORIGINS = new Set(['monitoring', 'backfill', 'history']);
const VERIFICATION = new Set(['verified', 'pending']);
const SOURCE_KINDS = new Set(['live_observation', 'derived_event']);
const DIMENSIONS = new Set(['price', 'product', 'stock', 'website', 'review', 'social', 'ads', 'search']);
const EVENT_TYPES = new Set([
  'price_changed', 'product_added', 'product_removed', 'stock_changed',
  'website_changed', 'review_changed', 'social_changed', 'ad_changed', 'search_interest_changed',
]);
// 维度 → 该维度允许的 event_type（防止错配）
const TYPE_BY_DIMENSION = {
  price: ['price_changed'],
  product: ['product_added', 'product_removed'],
  stock: ['stock_changed'],
  website: ['website_changed'],
  review: ['review_changed'],
  social: ['social_changed'],
  ads: ['ad_changed'],
  search: ['search_interest_changed'],
};
// 当前**真实存在**确定性 Diff 写入点的维度。其余维度结构上支持但不得写入占位事件。
const DIMENSIONS_WITH_WRITERS = new Set(['price', 'website']);
// 不可直接观测字段（禁入确定性 change）
const FORBIDDEN_CHANGE_KEYS = new Set(['spend', 'cost', 'roi', 'gmv', 'revenue', 'profit', 'margin', 'conversion', 'conversion_rate', 'ltv', 'cac', 'ad_spend']);

let _tableReady = false;
function ensureTable() {
  if (_tableReady) return;
  const db = WatchStore.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS intel_events (
    event_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    brand_id TEXT,
    brand_name TEXT,
    dimension TEXT NOT NULL,
    event_type TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    subject_id TEXT,
    observed_at TEXT NOT NULL,
    effective_at TEXT,
    verification_status TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    change_json TEXT,
    evidence_refs_json TEXT NOT NULL DEFAULT '[]',
    evidence_count INTEGER NOT NULL DEFAULT 0,
    window_key TEXT,
    dedupe_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, project_id, dedupe_key)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ie_scope ON intel_events(tenant_id, project_id, observed_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ie_brand ON intel_events(tenant_id, project_id, competitor_id, observed_at DESC)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_ie_origin ON intel_events(tenant_id, project_id, origin, observed_at DESC)');
  _tableReady = true;
}

function rid() { return 'evt_' + crypto.randomBytes(9).toString('hex'); }

// 校验/规范化 change：真实类型保留；禁不可观测字段；禁标量化区间
function normalizeChange(change) {
  if (change == null) return { ok: true, value: null, issues: [] };
  if (typeof change !== 'object' || Array.isArray(change)) return { ok: false, error: 'INVALID_CHANGE' };
  const issues = [];
  for (const k of Object.keys(change)) {
    if (FORBIDDEN_CHANGE_KEYS.has(String(k).toLowerCase())) {
      return { ok: false, error: 'FORBIDDEN_CHANGE_FIELD:' + k };
    }
  }
  const out = {};
  for (const [k, v] of Object.entries(change)) {
    // 保留真实类型：数字/布尔/字符串/对象/数组原样；undefined 丢弃
    if (v === undefined) continue;
    out[k] = v;
  }
  // 区间价格结构完整性：若声明了区间（oldValue/newValue 为 {min,max} 形态）则不得退化为标量
  const isRange = (x) => x && typeof x === 'object' && !Array.isArray(x)
    && (Object.prototype.hasOwnProperty.call(x, 'min') || Object.prototype.hasOwnProperty.call(x, 'max'));
  if (isRange(out.oldValue) !== isRange(out.newValue) && (isRange(out.oldValue) || isRange(out.newValue))) {
    issues.push('range_shape_mismatch');
  }
  return { ok: true, value: out, issues };
}

/**
 * 写入一条变化事件。
 * @param {object} input
 *   {tenantId, projectId, competitorId, brandId, brandName, dimension, eventType, title, summary,
 *    subjectId, observedAt, effectiveAt, sourceKind, origin, change, evidenceRefs, windowKey, dedupeKey}
 * @returns {{recorded:boolean, eventId?:string, reason?:string, downgraded?:string[]}}
 */
function recordEvent(input) {
  ensureTable();
  const o = input || {};
  const tid = String(o.tenantId || '');
  const pid = String(o.projectId || '');
  const cid = String(o.competitorId || '');
  if (!tid || !pid || !cid) return { recorded: false, reason: 'MISSING_SCOPE' };
  const dimension = String(o.dimension || '');
  const eventType = String(o.eventType || '');
  if (!DIMENSIONS.has(dimension)) return { recorded: false, reason: 'UNKNOWN_DIMENSION' };
  if (!EVENT_TYPES.has(eventType)) return { recorded: false, reason: 'UNKNOWN_EVENT_TYPE' };
  if (!(TYPE_BY_DIMENSION[dimension] || []).includes(eventType)) return { recorded: false, reason: 'TYPE_DIMENSION_MISMATCH' };
  if (!DIMENSIONS_WITH_WRITERS.has(dimension)) return { recorded: false, reason: 'DIMENSION_NOT_INTEGRATED:' + dimension };
  const origin = ORIGINS.has(o.origin) ? o.origin : 'monitoring';
  const sourceKind = SOURCE_KINDS.has(o.sourceKind) ? o.sourceKind : 'live_observation';
  const observedAt = String(o.observedAt || '');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(observedAt)) return { recorded: false, reason: 'INVALID_OBSERVED_AT' };
  const title = String(o.title || '').trim();
  if (!title) return { recorded: false, reason: 'MISSING_TITLE' };

  const ch = normalizeChange(o.change);
  if (!ch.ok) return { recorded: false, reason: ch.error };
  const downgraded = [];
  if (ch.issues && ch.issues.length) downgraded.push(...ch.issues);

  // effectiveAt：无可靠来源 → null；与 observedAt 相同视为伪造 → null
  let effectiveAt = o.effectiveAt == null ? null : String(o.effectiveAt);
  if (effectiveAt && effectiveAt === observedAt) { effectiveAt = null; downgraded.push('effective_at_mirrors_observed_at'); }
  if (effectiveAt && !/^\d{4}-\d{2}-\d{2}T/.test(effectiveAt)) { effectiveAt = null; downgraded.push('invalid_effective_at'); }

  // Evidence：无证据只能是 pending（不接受已核实样式）
  const refs = Array.isArray(o.evidenceRefs) ? o.evidenceRefs.filter(r => r && (r.evidenceId || r.snapshotId)) : [];
  let verificationStatus = VERIFICATION.has(o.verificationStatus) ? o.verificationStatus : 'pending';
  if (!refs.length && verificationStatus === 'verified') { verificationStatus = 'pending'; downgraded.push('no_evidence_downgraded_to_pending'); }

  const dedupeKey = String(o.dedupeKey
    || [cid, dimension, String(o.subjectId || ''), eventType, observedAt].join('|').slice(0, 400));
  const eventId = rid();
  try {
    const r = WatchStore.getDb().prepare(`INSERT INTO intel_events
      (event_id, tenant_id, project_id, competitor_id, brand_id, brand_name, dimension, event_type,
       title, summary, subject_id, observed_at, effective_at, verification_status, source_kind, origin,
       change_json, evidence_refs_json, evidence_count, window_key, dedupe_key, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      eventId, tid, pid, cid, o.brandId ? String(o.brandId) : null, o.brandName ? String(o.brandName) : null,
      dimension, eventType, title, o.summary ? String(o.summary) : null, o.subjectId ? String(o.subjectId) : null,
      observedAt, effectiveAt, verificationStatus, sourceKind, origin,
      ch.value ? JSON.stringify(ch.value) : null, JSON.stringify(refs), refs.length,
      o.windowKey ? String(o.windowKey) : null, dedupeKey, new Date().toISOString());
    return { recorded: true, eventId, verificationStatus, downgraded };
  } catch (e) {
    // 唯一键冲突 = 同一观察重复写入（幂等）
    if (/UNIQUE|constraint/i.test(String(e && e.message))) return { recorded: false, reason: 'DUPLICATE' };
    return { recorded: false, reason: 'WRITE_FAILED:' + String((e && e.message) || e).slice(0, 120) };
  }
}

function rowToEvent(r) {
  let change = null, refs = [];
  try { change = r.change_json ? JSON.parse(r.change_json) : null; } catch (e) { change = null; }
  try { refs = r.evidence_refs_json ? JSON.parse(r.evidence_refs_json) : []; } catch (e) { refs = []; }
  return {
    eventId: r.event_id,
    brandId: r.brand_id,
    competitorId: r.competitor_id,
    brandName: r.brand_name,
    dimension: r.dimension,
    eventType: r.event_type,
    title: r.title,
    summary: r.summary,
    subjectId: r.subject_id,
    observedAt: r.observed_at,
    effectiveAt: r.effective_at,
    verificationStatus: r.verification_status,
    sourceKind: r.source_kind,
    origin: r.origin,
    change,
    evidenceCount: r.evidence_count,
    evidenceRefs: refs,
    windowKey: r.window_key,
    links: {
      brand: r.brand_id ? '/brands/' + r.brand_id : (r.competitor_id ? '/brands?competitor=' + encodeURIComponent(r.competitor_id) : null),
      timeline: r.brand_id ? '/brands/' + r.brand_id + '?tab=timeline' : (r.competitor_id ? '/brands?competitor=' + encodeURIComponent(r.competitor_id) + '&tab=timeline' : null),
      evidence: refs[0] && refs[0].evidenceId ? '/api/evidence-detail?id=' + encodeURIComponent(refs[0].evidenceId) : null,
    },
  };
}

function encodeCursor(observedAt, eventId) {
  return Buffer.from(String(observedAt) + '|' + String(eventId)).toString('base64url');
}
function decodeCursor(cursor) {
  try {
    const raw = Buffer.from(String(cursor), 'base64url').toString('utf8');
    const i = raw.indexOf('|');
    if (i < 0) return null;
    const at = raw.slice(0, i), id = raw.slice(i + 1);
    if (!/^\d{4}-\d{2}-\d{2}T/.test(at) || !id) return null;
    return { at, id };
  } catch (e) { return null; }
}

// 今日（按调用方给定时区；默认 UTC+8 = 产品主市场口径可在调用处覆盖）
function localDateOf(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  } catch (e) { return String(iso).slice(0, 10); }
}

/**
 * 收件箱投影。
 * @param {object} q {tenantId, projectId, brandId?, dimension?, verificationStatus?, eventType?, from?, to?, cursor?, limit=30, timeZone?}
 * @returns {{summary:object, groups:Array, nextCursor:string|null, total:number, filters:object, limitations:string[]}}
 */
function listInbox(q) {
  ensureTable();
  const o = q || {};
  const tid = String(o.tenantId || '');
  const pid = String(o.projectId || '');
  if (!tid || !pid) return { summary: { today: 0, verified: 0, pending: 0, brandsChanged: 0 }, groups: [], nextCursor: null, total: 0, filters: {}, limitations: ['missing_scope'] };
  const tz = o.timeZone || 'Asia/Shanghai';
  const limit = Math.max(1, Math.min(Number(o.limit) || 30, 100));
  const where = ["tenant_id=?", 'project_id=?', "origin='monitoring'"]; // 回补/历史不进收件箱
  const params = [tid, pid];
  if (o.brandId) { where.push('(brand_id=? OR competitor_id=?)'); params.push(String(o.brandId), String(o.brandId)); }
  if (o.dimension && DIMENSIONS.has(String(o.dimension))) { where.push('dimension=?'); params.push(String(o.dimension)); }
  if (o.eventType && EVENT_TYPES.has(String(o.eventType))) { where.push('event_type=?'); params.push(String(o.eventType)); }
  if (o.verificationStatus && VERIFICATION.has(String(o.verificationStatus))) { where.push('verification_status=?'); params.push(String(o.verificationStatus)); }
  if (o.from) { where.push('observed_at>=?'); params.push(String(o.from)); }
  if (o.to) { where.push('observed_at<=?'); params.push(String(o.to)); }

  const db = WatchStore.getDb();
  // 顶部统计：项目今日口径（不受筛选影响）
  const today = localDateOf(new Date().toISOString(), tz);
  const dayStart = today + 'T00:00:00.000Z';
  // 用当日 00:00（本地）近似：改用区间 [今日本地 00:00 对应 UTC, 明日) 的精确计算
  const dayRange = (() => {
    try {
      const now = new Date();
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
      const d = fmt.format(now); // YYYY-MM-DD 本地
      // 本地 00:00 → UTC：用偏移逼近
      const base = new Date(d + 'T00:00:00Z');
      const offFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' });
      const part = offFmt.formatToParts(now).find(p => p.type === 'timeZoneName');
      const m = part && /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(part.value);
      const offsetMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 480;
      const start = new Date(base.getTime() - offsetMin * 60000).toISOString();
      const end = new Date(base.getTime() - offsetMin * 60000 + 24 * 3600 * 1000).toISOString();
      return { start, end, date: d };
    } catch (e) { return { start: dayStart, end: new Date(Date.parse(dayStart) + 24 * 3600 * 1000).toISOString(), date: today }; }
  })();
  const stat = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN verification_status='verified' THEN 1 ELSE 0 END) AS verified,
      SUM(CASE WHEN verification_status='pending' THEN 1 ELSE 0 END) AS pending,
      COUNT(DISTINCT COALESCE(brand_id, competitor_id)) AS brands
    FROM intel_events WHERE tenant_id=? AND project_id=? AND origin='monitoring' AND observed_at>=? AND observed_at<?`)
    .get(tid, pid, dayRange.start, dayRange.end) || {};
  const summary = {
    today: Number(stat.total || 0),
    verified: Number(stat.verified || 0),
    pending: Number(stat.pending || 0),
    brandsChanged: Number(stat.brands || 0),
  };

  // 游标分页（稳定排序：observed_at DESC, event_id DESC）
  const cur = o.cursor ? decodeCursor(o.cursor) : null;
  const limitations = [];
  if (o.cursor && !cur) limitations.push('invalid_cursor_ignored');
  const pageWhere = where.slice();
  const pageParams = params.slice();
  if (cur) {
    pageWhere.push('(observed_at < ? OR (observed_at = ? AND event_id < ?))');
    pageParams.push(cur.at, cur.at, cur.id);
  }
  const rows = db.prepare(`SELECT * FROM intel_events WHERE ${pageWhere.join(' AND ')}
    ORDER BY observed_at DESC, event_id DESC LIMIT ?`).all(...pageParams, limit + 1);
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const events = pageRows.map(rowToEvent);

  // 按自然日分组（日期倒序，日内时间倒序）
  const byDate = new Map();
  for (const ev of events) {
    const d = localDateOf(ev.observedAt, tz);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(ev);
  }
  const groups = [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([date, evs]) => ({ date, events: evs }));

  const counted = db.prepare(`SELECT COUNT(*) AS n FROM intel_events WHERE ${where.join(' AND ')}`).get(...params);
  // 轮询门控（§二 前端）：只在「存在 active 的正式监控目标」时允许前端轮询——
  // 没有监控目标就永远不会产生新变化，轮询只会制造无意义请求。
  let polling = { enabled: false, reason: 'no_active_monitoring', activeTargets: 0 };
  try {
    const at = db.prepare("SELECT COUNT(*) AS n FROM watch_targets WHERE tenant_id=? AND project_id=? AND monitoring_status='active'").get(tid, pid);
    const n = Number(at ? at.n : 0);
    polling = n > 0 ? { enabled: true, reason: 'active_monitoring', activeTargets: n } : polling;
  } catch (e) { /* watch_targets 未建表：视为无监控 */ }
  return {
    summary,
    groups,
    nextCursor: hasMore && pageRows.length ? encodeCursor(pageRows[pageRows.length - 1].observed_at, pageRows[pageRows.length - 1].event_id) : null,
    total: Number(counted ? counted.n : 0),
    polling,
    filters: {
      brandId: o.brandId || null, dimension: o.dimension || null, eventType: o.eventType || null,
      verificationStatus: o.verificationStatus || null, from: o.from || null, to: o.to || null,
    },
    timeZone: tz,
    limitations,
  };
}

function countForScope(tenantId, projectId) {
  ensureTable();
  const r = WatchStore.getDb().prepare("SELECT COUNT(*) AS n FROM intel_events WHERE tenant_id=? AND project_id=? AND origin='monitoring'").get(String(tenantId), String(projectId));
  return Number(r ? r.n : 0);
}

module.exports = {
  ORIGINS, VERIFICATION, SOURCE_KINDS, DIMENSIONS, EVENT_TYPES, DIMENSIONS_WITH_WRITERS, FORBIDDEN_CHANGE_KEYS,
  ensureTable, recordEvent, listInbox, countForScope, normalizeChange, encodeCursor, decodeCursor,
};
