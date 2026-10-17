'use strict';
// ============================================================
// services/watch-store.js —— 正式监控基础（WatchTarget + MonitoringWindow 持久化）
// ------------------------------------------------------------
// 规格依据（冻结语义，不得新造同义状态）：
//   · 00 v1.2 §3 正交状态模型：qualification_status / enrichment_status /
//     monitoring_status / freshness_status 四组正交，禁止压成一个 status
//   · 00 v1.2 §2.1 unavailable.reason_code：fetch_failed / blocked /
//     rate_limited / parse_failed / not_supported …（失败原因复用该词表）
//   · 01 v1.3.3 §16 加入监控：发现结果不自动进长期监控，用户明确执行后才
//     进入正式巡检 / 监控额度 / 当天警报 / 静默日报 coverage / 长期时间线
//   · 03 v0.3 §3 WatchTarget（建议键 workspace×brand×market；v0 落到
//     tenant×project×competitor，加法式迁移，不动既有表）
//   · 03 v0.3 §12 调度：IANA timezone（不存固定 UTC offset）+ DST 自动处理
//   · 03 v0.3 §14 Coverage Persistence：每个 monitoring window 落 Coverage，
//     Daily Brief 读 Coverage 而不是重新猜
//
// 存储：node:sqlite 单文件（ZB_DATA_DIR/watch_targets.db，WAL），与既有
// multitenant.db / research_tasks.db 同口径互不影响（加法迁移）。
// 隔离裁决（§2.2 同 db.js）：任何读取都显式带 tenantId 硬过滤，不存在
// "不小心读到别人行"的函数；跨租户 get/patch/delete 一律 null（上层转 404，
// 不区分"不存在"与"别人的"，不向外租户泄露存在性）。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const WATCH_DB = path.join(
  process.env.ZB_DATA_DIR ? path.resolve(process.env.ZB_DATA_DIR) : path.join(__dirname, '..', 'data'),
  'watch_targets.db'
);

// ---- 状态枚举（00 v1.2 §3 冻结，唯一词表） ----
const MONITORING_STATUSES = new Set(['inactive', 'active', 'degraded', 'paused']);
const QUALIFICATION_STATUSES = new Set(['qualified', 'unresolved', 'disqualified']);
const ENRICHMENT_STATUSES = new Set(['not_started', 'running', 'partial', 'complete', 'failed']);
const FRESHNESS_STATUSES = new Set(['fresh', 'stale', 'unknown']);
// 信号词表 = 当前监控链路真实具备的探测能力（sweep/net.js 已实现；不虚设未实现信号）
const SIGNALS = new Set(['price', 'launch', 'stock']);
// 失败原因（00 v1.2 §2.1 unavailable.reason_code 词表 + window 专属 partial_scan 传播标记）
const FAILURE_REASONS = new Set(['fetch_failed', 'blocked', 'rate_limited', 'parse_failed', 'not_supported', 'http_error']);
// 调度（03 v0.3 §12.1 唯一口径：目标市场时区 06:00 / 14:00 / 22:00 三窗口）
const WINDOW_SLOTS = ['06:00', '14:00', '22:00'];
const POLICY_VERSION = 'watch-v0'; // ops_policy_version（07 §3：阈值/策略变更必须换版本）
// 正常 jitter ±15 分钟（03 §12.2 v0 默认）；补跑只追当日（跨天缺失显式 coverage_gap，不无限回填）
const JITTER_MAX_MS = 15 * 60 * 1000;
const STALE_CLAIM_MS = 30 * 60 * 1000; // running 超过 30 min 视为崩溃残留，可重新认领
const FRESH_TTL_MS = 48 * 3600 * 1000; // 最后成功检查超过 48h → freshness_status=stale

let _db = null;
function getDb() {
  if (_db) return _db;
  try { if (!fs.existsSync(path.dirname(WATCH_DB))) fs.mkdirSync(path.dirname(WATCH_DB), { recursive: true }); } catch (e) {}
  const db = new DatabaseSync(WATCH_DB);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`CREATE TABLE IF NOT EXISTS watch_targets (
    watch_target_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    market TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT 'UTC',
    enabled_signals TEXT NOT NULL DEFAULT '["price","launch","stock"]',
    monitoring_status TEXT NOT NULL DEFAULT 'inactive',
    qualification_status TEXT NOT NULL DEFAULT 'unresolved',
    enrichment_status TEXT NOT NULL DEFAULT 'not_started',
    freshness_status TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    baseline_started_at TEXT,
    baseline_completed_at TEXT,
    last_success_at TEXT,
    UNIQUE (tenant_id, project_id, competitor_id)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_wt_tenant ON watch_targets(tenant_id)`);
  db.exec(`CREATE TABLE IF NOT EXISTS monitoring_windows (
    window_id TEXT PRIMARY KEY,            -- watch_target_id + ':' + window_key
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    watch_target_id TEXT NOT NULL,
    window_key TEXT NOT NULL,              -- 目标市场时区下的业务窗口标识 'YYYY-MM-DDTHH:mm'（本地墙上时间）
    slot TEXT NOT NULL,                    -- '06:00' | '14:00' | '22:00'
    scheduled_at TEXT NOT NULL,            -- 该本地墙上时间对应的 UTC 时刻（DST 换算后）
    started_at TEXT,
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'claimed',-- claimed | running | complete
    policy_version TEXT NOT NULL,
    expected_signals TEXT NOT NULL DEFAULT '[]',
    signal_results TEXT NOT NULL DEFAULT '[]',
    attempted INTEGER NOT NULL DEFAULT 0,
    succeeded INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    partial_scan INTEGER NOT NULL DEFAULT 0,
    failure_reasons TEXT NOT NULL DEFAULT '{}',
    events_verified INTEGER NOT NULL DEFAULT 0,
    schedule_lag_ms INTEGER,
    UNIQUE (watch_target_id, window_key)
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_mw_tenant ON monitoring_windows(tenant_id)`);
  _db = db;
  return db;
}

// 测试/运维：关闭连接（重定向 WATCH_DB 路径后重开）
function closeDb() { if (_db) { try { _db.close(); } catch (e) {} _db = null; } }

function rid(prefix) { return prefix + ':' + crypto.randomBytes(8).toString('hex'); }
function nowIso() { return new Date().toISOString(); }

// ---------- Workspace 时区（03 §12：IANA，不存固定 offset；DST 由换算自动处理） ----------
// 区域 → 目标市场 IANA 时区（v0 默认映射；Workspace 可经 PATCH 显式覆盖为任意合法 IANA 名）
const REGION_TZ = { us: 'America/New_York', uk: 'Europe/London', eu: 'Europe/Berlin', cn: 'Asia/Shanghai', jp: 'Asia/Tokyo', sea: 'Asia/Singapore' };
function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }); return true; } catch (e) { return false; }
}
function tzOffsetMs(tz, ts) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ts)).forEach(x => { p[x.type] = x.value; });
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUTC - Math.floor(ts / 1000) * 1000;
}
// 本地墙上时间 → UTC 时刻（两次逼近吸收 DST 跳变；DST 当日 06:00 仍为本地 06:00）
function zonedSlotUtc(tz, localDate, slot) {
  const [y, m, d] = localDate.split('-').map(Number);
  const [hh, mm] = slot.split(':').map(Number);
  let ts = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) ts = Date.UTC(y, m - 1, d, hh, mm) - tzOffsetMs(tz, ts);
  return ts;
}
// 时刻在时区下的本地日期 'YYYY-MM-DD' 与 'HH:mm'
function localParts(tz, ts) {
  const p = {};
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(ts)).forEach(x => { p[x.type] = x.value; });
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

// ---------- WatchTarget CRUD（tenant_id 硬过滤） ----------
function sanitizeSignals(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const k = String(s || '').trim().toLowerCase();
    if (SIGNALS.has(k) && !out.includes(k)) out.push(k);
  }
  return out.length ? out : ['price', 'launch', 'stock'];
}

function createWatchTarget({ tenantId, projectId, competitorId, market, timezone, enabledSignals, enrichmentStatus }) {
  const db = getDb();
  const tid = String(tenantId || '');
  // 幂等（03 §9：创建 WatchTarget 支持等价去重）：同 (tenant, project, competitor) 已存在 → 原样返回
  const existed = db.prepare('SELECT * FROM watch_targets WHERE tenant_id=? AND project_id=? AND competitor_id=?')
    .get(tid, String(projectId || ''), String(competitorId || ''));
  if (existed) return { target: rowToTarget(existed), existed: true };
  const t = {
    watch_target_id: rid('wt'),
    market: String(market || '').slice(0, 40),
    timezone: validTimezone(timezone) ? timezone.trim() : 'UTC',
    enabled_signals: sanitizeSignals(enabledSignals),
    monitoring_status: 'active',            // 用户明确「加入监控」→ 进入正式巡检（01 §16）
    qualification_status: 'unresolved',     // 00 §3.1：QualificationResult 链未建前不得虚标 qualified
    enrichment_status: ENRICHMENT_STATUSES.has(enrichmentStatus) ? enrichmentStatus : 'not_started',
    freshness_status: 'unknown',
    created_at: nowIso(),
    updated_at: nowIso(),
    baseline_started_at: nowIso(),          // 基线观察期从加入时刻起算
    baseline_completed_at: null,
    last_success_at: null,
  };
  db.prepare(`INSERT INTO watch_targets
    (watch_target_id, tenant_id, project_id, competitor_id, market, timezone, enabled_signals,
     monitoring_status, qualification_status, enrichment_status, freshness_status,
     created_at, updated_at, baseline_started_at, baseline_completed_at, last_success_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(t.watch_target_id, tid, String(projectId || ''), String(competitorId || ''), t.market, t.timezone,
      JSON.stringify(t.enabled_signals), t.monitoring_status, t.qualification_status, t.enrichment_status,
      t.freshness_status, t.created_at, t.updated_at, t.baseline_started_at, null, null);
  return { target: getWatchTarget(tid, t.watch_target_id), existed: false };
}

function rowToTarget(r) {
  if (!r) return null;
  let signals = [];
  try { signals = JSON.parse(r.enabled_signals || '[]'); } catch (e) {}
  return {
    watchTargetId: r.watch_target_id,
    tenantId: r.tenant_id,
    projectId: r.project_id,
    competitorId: r.competitor_id,
    market: r.market,
    timezone: r.timezone,
    enabledSignals: signals,
    monitoringStatus: r.monitoring_status,
    qualificationStatus: r.qualification_status,
    enrichmentStatus: r.enrichment_status,
    freshnessStatus: r.freshness_status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    baselineStartedAt: r.baseline_started_at,
    baselineCompletedAt: r.baseline_completed_at,
    lastSuccessAt: r.last_success_at,
  };
}

function getWatchTarget(tenantId, watchTargetId) {
  return rowToTarget(getDb().prepare('SELECT * FROM watch_targets WHERE tenant_id=? AND watch_target_id=?')
    .get(String(tenantId || ''), String(watchTargetId || '')));
}

function listWatchTargets(tenantId, projectId) {
  const db = getDb();
  const rows = projectId != null
    ? db.prepare('SELECT * FROM watch_targets WHERE tenant_id=? AND project_id=? ORDER BY created_at').all(String(tenantId || ''), String(projectId))
    : db.prepare('SELECT * FROM watch_targets WHERE tenant_id=? ORDER BY created_at').all(String(tenantId || ''));
  return rows.map(rowToTarget);
}

// 正式巡检对象：全部租户的 active 目标（调度器内部使用，非租户面）
function listActiveTargets() {
  return getDb().prepare("SELECT * FROM watch_targets WHERE monitoring_status='active' ORDER BY created_at")
    .all().map(rowToTarget);
}

// PATCH：白名单字段（monitoring_status 仅在 baseline 词表内取值；timezone 校验 IANA）
const PATCHABLE = new Set(['market', 'timezone', 'enabledSignals', 'monitoringStatus']);
function updateWatchTarget(tenantId, watchTargetId, patch) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM watch_targets WHERE tenant_id=? AND watch_target_id=?')
    .get(String(tenantId || ''), String(watchTargetId || ''));
  if (!cur) return null;
  const sets = [];
  const vals = [];
  if (patch && PATCHABLE.has('market') && patch.market !== undefined) { sets.push('market=?'); vals.push(String(patch.market || '').slice(0, 40)); }
  if (patch && patch.timezone !== undefined) {
    if (!validTimezone(patch.timezone)) return { error: 'INVALID_TIMEZONE' };
    sets.push('timezone=?'); vals.push(patch.timezone.trim());
  }
  if (patch && patch.enabledSignals !== undefined) { sets.push('enabled_signals=?'); vals.push(JSON.stringify(sanitizeSignals(patch.enabledSignals))); }
  if (patch && patch.monitoringStatus !== undefined) {
    if (!MONITORING_STATUSES.has(patch.monitoringStatus)) return { error: 'INVALID_STATUS' };
    sets.push('monitoring_status=?'); vals.push(patch.monitoringStatus);
  }
  if (!sets.length) return rowToTarget(cur);
  sets.push('updated_at=?'); vals.push(nowIso());
  vals.push(String(tenantId), String(watchTargetId));
  db.prepare(`UPDATE watch_targets SET ${sets.join(', ')} WHERE tenant_id=? AND watch_target_id=?`).run(...vals);
  return getWatchTarget(tenantId, watchTargetId);
}

function deleteWatchTarget(tenantId, watchTargetId) {
  const db = getDb();
  const r = db.prepare('DELETE FROM watch_targets WHERE tenant_id=? AND watch_target_id=?')
    .run(String(tenantId || ''), String(watchTargetId || ''));
  if (r.changes) { // 级联清窗口（目标删除后其窗口不再参与任何 coverage 判定）
    db.prepare('DELETE FROM monitoring_windows WHERE tenant_id=? AND watch_target_id=?').run(String(tenantId), String(watchTargetId));
  }
  return r.changes > 0;
}

function markSuccess(tenantId, watchTargetId, atIso) {
  const db = getDb();
  const t = db.prepare('SELECT * FROM watch_targets WHERE tenant_id=? AND watch_target_id=?').get(String(tenantId), String(watchTargetId));
  if (!t) return;
  const last = t.last_success_at ? Date.parse(t.last_success_at) : 0;
  const at = Date.parse(atIso);
  const fresh = at - last > 0;
  db.prepare(`UPDATE watch_targets SET last_success_at=?, freshness_status=?,
    baseline_completed_at=COALESCE(baseline_completed_at, CASE WHEN ? THEN ? ELSE NULL END), updated_at=?
    WHERE tenant_id=? AND watch_target_id=?`)
    .run(atIso, 'fresh', fresh && !t.baseline_completed_at ? 1 : 0, atIso, nowIso(), String(tenantId), String(watchTargetId));
}

function markDegraded(tenantId, watchTargetId) {
  const db = getDb();
  db.prepare("UPDATE watch_targets SET monitoring_status='degraded', updated_at=? WHERE tenant_id=? AND watch_target_id=? AND monitoring_status='active'")
    .run(nowIso(), String(tenantId), String(watchTargetId));
}

// freshness 兜底巡检（读时判定）：最后成功检查超 48h → stale
function refreshFreshness(nowMs) {
  const db = getDb();
  const cutoff = new Date((nowMs || Date.now()) - FRESH_TTL_MS).toISOString();
  db.prepare("UPDATE watch_targets SET freshness_status='stale' WHERE monitoring_status IN ('active','degraded') AND last_success_at IS NOT NULL AND last_success_at < ?").run(cutoff);
  db.prepare("UPDATE watch_targets SET freshness_status='unknown' WHERE monitoring_status IN ('active','degraded') AND last_success_at IS NULL").run();
}

// ---------- MonitoringWindow（03 §14：窗口落 Coverage，Brief 读表不重猜） ----------
// window_key = 目标市场时区下的业务窗口 'YYYY-MM-DDTHH:mm'（本地墙上时间）——
// 幂等与补跑都以它为唯一业务键：同一本地窗口无论重试/重启/多 worker 认领，
// UNIQUE(watch_target_id, window_key) 保证至多一行、至多一次有效执行。
function claimWindow(target, windowKey, slot, scheduledTs, nowMs) {
  const db = getDb();
  const windowId = target.watchTargetId + ':' + windowKey;
  const nowIsoS = new Date(nowMs || Date.now()).toISOString();
  try {
    db.prepare(`INSERT INTO monitoring_windows
      (window_id, tenant_id, project_id, watch_target_id, window_key, slot, scheduled_at, started_at, status, policy_version, expected_signals)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(windowId, target.tenantId, target.projectId, target.watchTargetId, windowKey, slot,
        new Date(scheduledTs).toISOString(), nowIsoS, 'running', POLICY_VERSION, JSON.stringify(target.enabledSignals));
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) {
      // 已被本进程/上次运行/另一 worker 认领。唯一例外：running 且心跳超时的崩溃残留 → 重新认领（补跑）
      const r = db.prepare(`UPDATE monitoring_windows SET started_at=?, status='running'
        WHERE window_id=? AND status='running' AND started_at < ?`)
        .run(nowIsoS, windowId, new Date((nowMs || Date.now()) - STALE_CLAIM_MS).toISOString());
      return { claimed: r.changes > 0, reason: r.changes > 0 ? 'reclaimed_stale' : 'already_claimed', windowId };
    }
    throw e;
  }
  const lagMs = Math.max(0, (nowMs || Date.now()) - scheduledTs);
  db.prepare('UPDATE monitoring_windows SET schedule_lag_ms=? WHERE window_id=?').run(lagMs, windowId);
  return { claimed: true, reason: 'new', windowId, lagMs };
}

function completeWindow(windowId, result, nowMs) {
  const db = getDb();
  // result: { signalResults:[{signal,attempted,succeeded,failed,reason}], attempted, succeeded, failed, partialScan, failureReasons, eventsVerified }
  db.prepare(`UPDATE monitoring_windows SET status='complete', ended_at=?, signal_results=?, attempted=?, succeeded=?,
    failed=?, partial_scan=?, failure_reasons=?, events_verified=? WHERE window_id=? AND status='running'`)
    .run(new Date(nowMs || Date.now()).toISOString(), JSON.stringify(result.signalResults || []),
      result.attempted || 0, result.succeeded || 0, result.failed || 0, result.partialScan ? 1 : 0,
      JSON.stringify(result.failureReasons || {}), result.eventsVerified || 0, windowId);
}

function failWindow(windowId, nowMs) {
  const db = getDb();
  db.prepare(`UPDATE monitoring_windows SET status='complete', ended_at=?, partial_scan=1,
    failure_reasons=JSON_SET(failure_reasons, '$.window_error', 'fetch_failed') WHERE window_id=? AND status='running'`)
    .run(new Date(nowMs || Date.now()).toISOString(), windowId);
}

function getWindow(windowId) {
  const r = getDb().prepare('SELECT * FROM monitoring_windows WHERE window_id=?').get(windowId);
  return r ? rowToWindow(r) : null;
}

function rowToWindow(r) {
  if (!r) return null;
  let signals = [], reasons = {};
  try { signals = JSON.parse(r.signal_results || '[]'); } catch (e) {}
  try { reasons = JSON.parse(r.failure_reasons || '{}'); } catch (e) {}
  let expected = [];
  try { expected = JSON.parse(r.expected_signals || '[]'); } catch (e) {}
  return {
    windowId: r.window_id, tenantId: r.tenant_id, projectId: r.project_id, watchTargetId: r.watch_target_id,
    windowKey: r.window_key, slot: r.slot, scheduledAt: r.scheduled_at, startedAt: r.started_at, endedAt: r.ended_at,
    status: r.status, policyVersion: r.policy_version, expectedSignals: expected, signalResults: signals,
    attempted: r.attempted, succeeded: r.succeeded, failed: r.failed,
    partialScan: !!r.partial_scan, failureReasons: reasons, eventsVerified: r.events_verified,
    scheduleLagMs: r.schedule_lag_ms,
    // coverage 结论（只读派生，不落列）：任何失败/partial/未完成 → gap（00 §20/§21：不得把失败当无变化）
    coverage: r.status !== 'complete' ? 'incomplete'
      : (r.failed > 0 || r.partial_scan ? 'gap' : 'full'),
  };
}

// 某目标某本地日已完成的窗口（按 slot 索引）
function windowsForTargetDay(watchTargetId, windowKeys) {
  const db = getDb();
  const out = {};
  for (const k of windowKeys) {
    const r = db.prepare('SELECT * FROM monitoring_windows WHERE watch_target_id=? AND window_key=?')
      .get(watchTargetId, k);
    out[k] = r ? rowToWindow(r) : null;
  }
  return out;
}

// 租户面窗口查询（Brief / API）
function windowsForTenantDay(tenantId, windowKeys, projectId) {
  const db = getDb();
  const rows = projectId != null
    ? db.prepare(`SELECT * FROM monitoring_windows WHERE tenant_id=? AND window_key IN (${windowKeys.map(() => '?').join(',')}) AND project_id=?`).all(String(tenantId), ...windowKeys, String(projectId))
    : db.prepare(`SELECT * FROM monitoring_windows WHERE tenant_id=? AND window_key IN (${windowKeys.map(() => '?').join(',')})`).all(String(tenantId), ...windowKeys);
  return rows.map(rowToWindow);
}

// 目标最近一个已结束窗口（卡片「最近成功检查 / Coverage 提示」数据源）
function latestWindowFor(tenantId, watchTargetId) {
  const r = getDb().prepare(`SELECT * FROM monitoring_windows
    WHERE tenant_id=? AND watch_target_id=? AND status='complete'
    ORDER BY scheduled_at DESC LIMIT 1`).get(String(tenantId), String(watchTargetId));
  return r ? rowToWindow(r) : null;
}

module.exports = {
  MONITORING_STATUSES, QUALIFICATION_STATUSES, ENRICHMENT_STATUSES, FRESHNESS_STATUSES,
  SIGNALS, FAILURE_REASONS, WINDOW_SLOTS, POLICY_VERSION, JITTER_MAX_MS, STALE_CLAIM_MS,
  REGION_TZ, validTimezone, zonedSlotUtc, localParts, tzOffsetMs,
  getDb, closeDb,
  createWatchTarget, getWatchTarget, listWatchTargets, listActiveTargets, updateWatchTarget, deleteWatchTarget,
  markSuccess, markDegraded, refreshFreshness,
  claimWindow, completeWindow, failWindow, getWindow, windowsForTargetDay, windowsForTenantDay, latestWindowFor,
};
