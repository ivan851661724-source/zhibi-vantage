'use strict';
// ============================================================
// services/intel-inbox.js —— 每日变化收件箱真源（SC-08 §二）
// ------------------------------------------------------------
// 职责：只承载「基线建立之后，由两次可比较观察产生的确定性变化」。
//
// 硬规则（任务书 §二 字段规则 + r2 §三）：
//   ① origin 必须显式给出且合法：只有 'monitoring' 进收件箱；缺失/非法/backfill/history
//      一律不得默认变成 monitoring（fail-closed，见 recordEvent）；回补/历史只进品牌时间线；
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
// SC-09：product/stock/review/social 也已有真实确定性 Diff 写入点（首采后的二次采集比较）：
//   商品价格/在售状态/商品增减、评论数量、公开内容条数。
// search/ads 仍无确定性可比值（估算/覆盖说明）→ 保持不可写入，绝不产生占位事件。
const DIMENSIONS_WITH_WRITERS = new Set(['price', 'website', 'product', 'stock', 'review', 'social']);
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
  // 🔴 SC-08 r2 §三.7：origin 必须显式声明且合法（fail-closed）。
  // 缺失/非法一律拒收——绝不允许「没写 origin」默认变成 monitoring 混进每日收件箱。
  const originRaw = o.origin == null ? '' : String(o.origin).trim().toLowerCase();
  if (!originRaw) return { recorded: false, reason: 'ORIGIN_REQUIRED' };
  if (!ORIGINS.has(originRaw)) return { recorded: false, reason: 'INVALID_ORIGIN:' + originRaw };
  const origin = originRaw;
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
    state: inboxState(tid, pid, tz),
    filters: {
      brandId: o.brandId || null, dimension: o.dimension || null, eventType: o.eventType || null,
      verificationStatus: o.verificationStatus || null, from: o.from || null, to: o.to || null,
    },
    timeZone: tz,
    limitations,
  };
}

// ---------- 收件箱真实状态投影（本轮新增） ----------
// 目的：空收件箱必须能区分三种完全不同的处境，用户才知道下一步该做什么：
//   ① no_monitoring          —— 还没有正式监控目标（含从未加入 / 已全部停用）
//   ② awaiting_comparison    —— 已加入监控，但还没有任何一次完成的巡检窗口
//                                （＝尚未完成第二次可比观察，结构上不可能有变化事件）
//   ③ inspected              —— 已按计划巡检；todayInspected 表示今日是否已巡
// 纪律：只读真实表（watch_targets / monitoring_windows），不推断、不补 0；
//       缺表视为能力未就绪（state=unknown），绝不伪造「已巡检」。
function inboxState(tenantId, projectId, timeZone) {
  const tid = String(tenantId || '');
  const pid = String(projectId || '');
  const tz = timeZone || 'Asia/Shanghai';
  const out = {
    state: 'no_monitoring',
    activeTargets: 0,
    pausedTargets: 0,
    pendingIntents: 0,
    failedIntents: 0,
    intentNote: null,
    signals: [],
    signalsText: '',
    baselineCompleted: 0,
    windowCount: 0,
    lastWindowAt: null,
    lastWindowStatus: null,
    lastSuccessAt: null,
    todayInspected: false,
    todayWindowCount: 0,
    lastEventsVerified: 0,
  };
  let db;
  try { db = WatchStore.getDb(); } catch (e) { out.state = 'unknown'; return out; }
  let targets = [];
  try {
    targets = db.prepare(`SELECT watch_target_id, monitoring_status, enabled_signals, baseline_completed_at, last_success_at
      FROM watch_targets WHERE tenant_id=? AND project_id=?`).all(tid, pid);
  } catch (e) { out.state = 'unknown'; return out; }
  const active = targets.filter(t => t.monitoring_status === 'active' || t.monitoring_status === 'degraded');
  const paused = targets.filter(t => t.monitoring_status === 'paused');
  out.activeTargets = active.length;
  out.pausedTargets = paused.length;
  out.baselineCompleted = active.filter(t => t.baseline_completed_at).length;
  // 信号范围：**只报真实 enabled_signals**（不把未实现的信号说成「监控中」）
  const sig = [];
  for (const t of active) {
    try {
      for (const s of (JSON.parse(t.enabled_signals || '[]') || [])) if (s && !sig.includes(s)) sig.push(s);
    } catch (e) { /* 脏数据忽略，不猜测 */ }
  }
  out.signals = sig;
  out.signalsText = sig.map(s => SIGNAL_TEXT[s] || s).join('、');
  // 最近成功观察（只认 target 自报的 last_success_at，不拿窗口时间冒充）
  const lastSuccess = active.map(t => t.last_success_at).filter(Boolean).sort().pop() || null;
  out.lastSuccessAt = lastSuccess;
  try {
    const w = db.prepare(`SELECT COUNT(*) AS n, MAX(ended_at) AS last_at, MAX(events_verified) AS ev
      FROM monitoring_windows WHERE tenant_id=? AND project_id=? AND status='complete'`).get(tid, pid) || {};
    out.windowCount = Number(w.n || 0);
    out.lastWindowAt = w.last_at || null;
    out.lastWindowStatus = out.windowCount ? 'complete' : null;
    out.lastEventsVerified = Number(w.ev || 0);
    // 今日（按产品时区）是否有完成的巡检窗口
    const today = localDateOf(new Date().toISOString(), tz);
    const rows = db.prepare(`SELECT ended_at FROM monitoring_windows
      WHERE tenant_id=? AND project_id=? AND status='complete' AND ended_at IS NOT NULL`).all(tid, pid);
    let todayN = 0;
    for (const r of rows) if (localDateOf(r.ended_at, tz) === today) todayN++;
    out.todayWindowCount = todayN;
    out.todayInspected = todayN > 0;
  } catch (e) { /* monitoring_windows 未建表：保持 windowCount=0，state 落到 awaiting_comparison */ }

  // 监控意向（非 Shopify 品牌「正在建立公开来源」）：必须与「尚未加入」区分，
  // 否则用户点了「加入监控」看不到任何变化，会重复提交。
  try {
    const intents = db.prepare(`SELECT state, reason_code, reason_text, probe_phase FROM watch_intents WHERE tenant_id=? AND project_id=?`).all(tid, pid);
    const establishing = intents.filter(i => i.state === 'establishing');
    const failed = intents.filter(i => i.state === 'source_failed');
    out.pendingIntents = establishing.length;
    out.failedIntents = failed.length;
    // r3：说明文字按真实阶段/原因给出，不用笼统的「来源建立失败」
    const sitePhase = establishing.some(i => String(i.probe_phase || '').indexOf('site') === 0);
    out.intentNote = establishing.length
      ? (sitePhase ? '正在建立官网观察基线，两次观察后自动转为正式监控' : '正在建立公开来源基线，完成后自动转为正式监控')
      : (failed.length ? (failed[0].reason_text || '来源暂时不可访问，系统会自动重试') : null);
  } catch (e) { /* watch_intents 未建表：保持 0，不推断 */ }

  // ---- r3：项目级来源结果聚合（唯一口径 = SourceHealth + 监控窗口） ----
  // 语义修正（对应本轮验收）：
  //   · 只有「本次监控窗口真实失败、可能造成数据缺口」的来源才进提示；
  //   · limited（官网内容监控）与 not_configured（数据服务未配置）**不得**列为巡检失败；
  //   · 「官网可访问但没有可比价格」不是巡检失败，只说明基线尚未建立；
  //   · 同一品牌 × 来源 × 窗口的失败只出现一次。
  out.sources = { total: 0, ok: 0, failed: 0, items: [], notes: [], latestAt: null };
  out.partialFailure = false;
  out.allFailed = false;
  out.historicalNote = null;
  try {
    const SourceHealth = require('./source-health.js');
    const names = competitorNames(tid, pid);
    const state = (() => { try { return require('./brand-service.js').loadProjectState(tid, pid); } catch (e) { return null; } })();
    const comps = (state && Array.isArray(state.competitors)) ? state.competitors : [];
    const compById = {};
    for (const c of comps) if (c && c.id) compById[c.id] = c;

    const targetRows = db.prepare(`SELECT watch_target_id, competitor_id, monitoring_status FROM watch_targets
      WHERE tenant_id=? AND project_id=?`).all(tid, pid);
    const compOfTarget = {};
    for (const t of targetRows) compOfTarget[t.watch_target_id] = t.competitor_id;

    const seen = new Set();
    let ok = 0, failed = 0;
    let activeNonLimited = 0;

    for (const t of targetRows) {
      if (t.monitoring_status !== 'active' && t.monitoring_status !== 'degraded') continue;
      const cid = t.competitor_id || '';
      const comp = compById[cid] || { id: cid };
      let h = null;
      try { h = SourceHealth.build(tid, pid, comp); } catch (e) { h = null; }
      const brand = names[cid] || comp.name || '未知品牌';
      if (h && h.state === 'limited') {
        // 降级到官网内容监控：不是巡检失败；仅在有失败时给一条非红色说明
        if (h.stale) out.sources.notes.push({ brandName: brand, text: '官网内容监控最近一次未完成，将在下一轮重试' });
        continue;
      }
      activeNonLimited += 1;
      const win = db.prepare(`SELECT attempted, succeeded, failed, failure_reasons, ended_at, window_key
        FROM monitoring_windows WHERE tenant_id=? AND project_id=? AND watch_target_id=? AND status='complete'
        ORDER BY ended_at DESC LIMIT 1`).get(tid, pid, t.watch_target_id);
      if (!win) continue;
      const att = Number(win.attempted || 0);
      const bad = Number(win.failed || 0);
      const key = cid + '|window|' + (win.window_key || win.ended_at || '');
      if (bad > 0 || (att > 0 && Number(win.succeeded || 0) === 0)) {
        if (seen.has(key)) continue;
        seen.add(key);
        const reasons = safeReasons(win.failure_reasons);
        failed += 1;
        out.sources.items.push({
          brandName: brand,
          source: '公开商品页',
          category: reasons[0].code,
          categoryText: reasons[0].text,
          action: reasons[0].action,
          actionText: reasons[0].actionText,
          windowAt: win.ended_at || null,
        });
      } else ok += 1;
    }

    // 监控意向：只有真实阻断/不可达才算来源未更新；
    // 「官网可访问但无可比字段」只记一条基线说明（不计失败、不进红色清单）。
    try {
      const intents = db.prepare(`SELECT competitor_id, state, reason_code, reason_text FROM watch_intents
        WHERE tenant_id=? AND project_id=?`).all(tid, pid);
      const blocking = new Set(['blocked', 'rate_limited', 'source_unavailable', 'parse_failed']);
      for (const i of intents) {
        if (i.state !== 'source_failed') continue;
        const brand = names[i.competitor_id] || (compById[i.competitor_id] && compById[i.competitor_id].name) || '未知品牌';
        const reason = String(i.reason_code || '');
        if (!blocking.has(reason)) {
          out.sources.notes.push({ brandName: brand, text: '官网可访问，正在建立可监控基线（暂无可比较字段）' });
          continue;
        }
        const key = i.competitor_id + '|intent|' + reason;
        if (seen.has(key)) continue;
        seen.add(key);
        failed += 1;
        out.sources.items.push({
          brandName: brand,
          source: '公开站点',
          category: reason === 'blocked' ? 'blocked' : (reason === 'rate_limited' ? 'rate_limited' : 'unavailable'),
          categoryText: reason === 'blocked' ? '来源拒绝访问（robots 或权限限制）'
            : (reason === 'rate_limited' ? '来源限制了访问频率，稍后自动重试' : '来源暂时不可达，稍后自动重试'),
          action: 'rejoin',
          actionText: '重新加入监控',
          windowAt: null,
        });
      }
    } catch (e) { /* watch_intents 未建表：跳过 */ }

    out.sources.total = ok + failed;
    out.sources.ok = ok;
    out.sources.failed = failed;
    out.sources.latestAt = out.lastWindowAt || null;
    out.partialFailure = failed > 0;
    out.allFailed = failed > 0 && ok === 0 && activeNonLimited > 0;
    if (out.allFailed) out.historicalNote = '使用历史数据，最近一次更新失败';
  } catch (e) {
    /* 聚合失败不改变既有状态语义：保持 sources 为空，不伪造成功 */
  }

  if (out.state === 'unknown') return out;
  if (!out.activeTargets) {
    if (out.pendingIntents > 0) out.state = 'establishing';
    else if (out.failedIntents > 0) out.state = 'source_failed';
    // inactive（用户主动移出监控）不显示「已暂停」——它与「从未加入」对用户是同一件事：
    // 当前没有在跑的正式监控，需要重新加入。只有真正 paused 才提示可恢复。
    else out.state = out.pausedTargets > 0 ? 'paused' : 'no_monitoring';
  }
  else if (out.windowCount === 0) out.state = 'awaiting_comparison';
  else if (out.allFailed) out.state = 'inspection_failed';
  else if (out.partialFailure) out.state = 'inspected_partial';
  else out.state = 'inspected';
  return out;
}

// 失败类别 → 用户可读（禁内部码/路径/栈；未知类别一律归「暂时无法访问」）
const FAILURE_CATEGORY_TEXT = Object.freeze({
  blocked: '对方官网拒绝访问',
  rate_limited: '对方官网限制访问频率',
  timeout: '对方官网响应超时',
  unavailable: '对方官网暂时不可用',
  parse_failed: '返回内容无法解析',
  event_write_failed: '变化记录写入失败',
  source_unavailable: '无法建立可核验的公开来源',
});
function safeReasons(raw) {
  let obj = null;
  try { obj = JSON.parse(raw || '{}'); } catch (e) { obj = null; }
  const keys = obj && typeof obj === 'object' ? Object.keys(obj).filter(k => Number(obj[k]) > 0) : [];
  if (!keys.length) return [{ code: 'unavailable', text: FAILURE_CATEGORY_TEXT.unavailable, action: 'retry', actionText: '重新巡检' }];
  return keys.map(k => ({
    code: FAILURE_CATEGORY_TEXT[k] ? k : 'unavailable',
    text: FAILURE_CATEGORY_TEXT[k] || FAILURE_CATEGORY_TEXT.unavailable,
    action: 'retry',
    actionText: '重新巡检',
  }));
}
function competitorNames(tenantId, projectId) {
  const map = {};
  try {
    const { projFile } = require('../core/state-store.js');
    const fs = require('fs');
    const f = projFile(projectId, tenantId);
    if (!f || !fs.existsSync(f)) return map;
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const c of (st && Array.isArray(st.competitors) ? st.competitors : [])) {
      if (c && c.id) map[c.id] = c.name || c.brand || '未知品牌';
    }
  } catch (e) { /* 名称缺失不阻断状态聚合 */ }
  return map;
}

// 信号 → 用户可读名（内部词表 price/launch/stock/site_change 不进页面）
const SIGNAL_TEXT = Object.freeze({
  price: '价格',
  launch: '上新',
  stock: '库存',
  site_change: '官网内容',
});

// ---------- 事件级纠错（本轮新增） ----------
// 为什么单独一张表：既有 /api/field-correct 面向旧 state.competitors 字段模型，
// 无法表达「这条变化记录有误」。事件纠错**不改写**已记录事实（忠实助理红线），
// 只登记用户质疑并进入复核队列，事件本身仍按原核验状态展示。
const CORRECTION_REASONS = new Set(['wrong_value', 'wrong_evidence', 'not_a_change', 'wrong_brand', 'other']);
function ensureCorrectionTable() {
  ensureTable();
  WatchStore.getDb().exec(`CREATE TABLE IF NOT EXISTS intel_event_corrections (
    correction_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    UNIQUE (tenant_id, event_id, reason)
  )`);
}
function submitCorrection(input) {
  ensureCorrectionTable();
  const o = input || {};
  const tid = String(o.tenantId || ''), pid = String(o.projectId || ''), eid = String(o.eventId || '');
  if (!tid || !pid || !eid) return { ok: false, reason: 'MISSING_SCOPE' };
  const reason = CORRECTION_REASONS.has(o.reason) ? o.reason : 'other';
  const note = o.note == null ? null : String(o.note).slice(0, 500);
  const db = WatchStore.getDb();
  // 事件必须属于本租户本项目（跨租户/不存在一律 404 语义，不泄露存在性）
  const ev = db.prepare('SELECT event_id FROM intel_events WHERE tenant_id=? AND project_id=? AND event_id=?').get(tid, pid, eid);
  if (!ev) return { ok: false, reason: 'EVENT_NOT_FOUND' };
  const id = 'corr_' + crypto.randomBytes(8).toString('hex');
  try {
    db.prepare(`INSERT INTO intel_event_corrections (correction_id, tenant_id, project_id, event_id, reason, note, status, created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(id, tid, pid, eid, reason, note, 'open', new Date().toISOString());
    return { ok: true, correctionId: id, status: 'open' };
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e && e.message))) {
      return { ok: true, duplicate: true, message: '这条反馈已记录，我们在复核中。' };
    }
    return { ok: false, reason: 'WRITE_FAILED' };
  }
}
function correctionCountFor(tenantId, projectId, eventId) {
  ensureCorrectionTable();
  const r = WatchStore.getDb().prepare('SELECT COUNT(*) AS n FROM intel_event_corrections WHERE tenant_id=? AND project_id=? AND event_id=?')
    .get(String(tenantId || ''), String(projectId || ''), String(eventId || ''));
  return Number(r ? r.n : 0);
}

// 某品牌的「可核验变化」统计（品牌档案第一屏摘要卡的唯一口径）：
// 只数 origin=monitoring 且 verification_status=verified 的真实变化，不带时间窗（全部已积累）。
function verifiedEventStats(tenantId, projectId, competitorId) {
  ensureTable();
  try {
    const r = WatchStore.getDb().prepare(`SELECT COUNT(*) AS n, MIN(observed_at) AS first_at, MAX(observed_at) AS last_at
      FROM intel_events WHERE tenant_id=? AND project_id=? AND competitor_id=? AND origin='monitoring' AND verification_status='verified'`)
      .get(String(tenantId || ''), String(projectId || ''), String(competitorId || ''));
    return { count: Number((r && r.n) || 0), firstAt: (r && r.first_at) || null, lastAt: (r && r.last_at) || null };
  } catch (e) {
    return { count: 0, firstAt: null, lastAt: null };
  }
}

function countForScope(tenantId, projectId) {
  ensureTable();
  const r = WatchStore.getDb().prepare("SELECT COUNT(*) AS n FROM intel_events WHERE tenant_id=? AND project_id=? AND origin='monitoring'").get(String(tenantId), String(projectId));
  return Number(r ? r.n : 0);
}

// 某品牌最近一条「已核实」的每日变化（竞品数据库卡片的「最近一次可核验变化」唯一口径）
function latestVerifiedEvent(tenantId, projectId, competitorId) {
  ensureTable();
  const r = WatchStore.getDb().prepare(`SELECT * FROM intel_events
    WHERE tenant_id=? AND project_id=? AND competitor_id=? AND origin='monitoring' AND verification_status='verified'
    ORDER BY observed_at DESC, event_id DESC LIMIT 1`)
    .get(String(tenantId || ''), String(projectId || ''), String(competitorId || ''));
  return r ? rowToEvent(r) : null;
}

module.exports = {
  ORIGINS, VERIFICATION, SOURCE_KINDS, DIMENSIONS, EVENT_TYPES, DIMENSIONS_WITH_WRITERS, FORBIDDEN_CHANGE_KEYS,
  SIGNAL_TEXT, inboxState, CORRECTION_REASONS, ensureCorrectionTable, submitCorrection, correctionCountFor,
  ensureTable, recordEvent, listInbox, countForScope, latestVerifiedEvent, verifiedEventStats, normalizeChange, encodeCursor, decodeCursor,
};
