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
// SC-08 §三 C：site_change = 官网内容结构化字段变化（非 Shopify、无可比价格时的正式降级信号）
const SIGNALS = new Set(['price', 'launch', 'stock', 'site_change']);
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
  // 加法迁移（老库升级）：supported_signals / deactivated_at —— 只加列，不改既有列
  const cols = db.prepare('PRAGMA table_info(watch_targets)').all().map(c => c.name);
  if (!cols.includes('supported_signals')) db.exec("ALTER TABLE watch_targets ADD COLUMN supported_signals TEXT NOT NULL DEFAULT '[]'");
  if (!cols.includes('deactivated_at')) db.exec('ALTER TABLE watch_targets ADD COLUMN deactivated_at TEXT');
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
  // SC-08 r2 §三：窗口必须如实记录「事件写库失败」与「待核实」——不能仍显示完全成功
  const wcols = db.prepare('PRAGMA table_info(monitoring_windows)').all().map(c => c.name);
  if (!wcols.includes('events_pending')) db.exec('ALTER TABLE monitoring_windows ADD COLUMN events_pending INTEGER NOT NULL DEFAULT 0');
  if (!wcols.includes('events_write_failed')) db.exec('ALTER TABLE monitoring_windows ADD COLUMN events_write_failed INTEGER NOT NULL DEFAULT 0');
  if (!wcols.includes('events_duplicate')) db.exec('ALTER TABLE monitoring_windows ADD COLUMN events_duplicate INTEGER NOT NULL DEFAULT 0');
  // 单品价格快照（整改 §6：正式价格事件按稳定商品身份比较，目录中位数不入此表）
  db.exec(`CREATE TABLE IF NOT EXISTS watch_price_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    subject_id TEXT NOT NULL,              -- 稳定商品身份（products.json 商品 id）
    currency TEXT NOT NULL,
    spec_signature TEXT NOT NULL DEFAULT '',-- 规格签名（变体数代理）；变化 → 不可比
    price REAL NOT NULL,
    display TEXT,
    title TEXT,
    at TEXT NOT NULL,
    UNIQUE (tenant_id, project_id, competitor_id, subject_id, currency)
  )`);
  // SC-08 §三 C：官网结构化指纹 baseline（首次成功观察只存 baseline，第二次确定性变化才成事件）
  db.exec(`CREATE TABLE IF NOT EXISTS watch_site_baselines (
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    fingerprint_json TEXT NOT NULL,
    stability_json TEXT NOT NULL DEFAULT '{}',
    url TEXT,
    at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, project_id, competitor_id)
  )`);
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
  // SC-08：显式只给了 site_change（非 Shopify 降级）时必须保留，不得回退成 Shopify 三件套
  return out.length ? out : ['price', 'launch', 'stock'];
}

// supported_signals 专用：只过滤词表 + 去重，允许空数组（空 = 无已实现直接源，§9）
function filterKnownSignals(list) {
  const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    const k = String(s || '').trim().toLowerCase();
    if (SIGNALS.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

function createWatchTarget({ tenantId, projectId, competitorId, market, timezone, enabledSignals, enrichmentStatus, supportedSignals }) {
  const db = getDb();
  const tid = String(tenantId || '');
  // 幂等（03 §9）：同 (tenant, project, competitor) 已存在 → 原对象返回；
  // 整改 §5：若该对象处于 inactive（曾退出监控）→ 重新加入 = 恢复原 WatchTarget
  // 并重新激活（不得因唯一键返回 inactive 对象却不重启巡检）；历史窗口全部保留。
  const existed = db.prepare('SELECT * FROM watch_targets WHERE tenant_id=? AND project_id=? AND competitor_id=?')
    .get(tid, String(projectId || ''), String(competitorId || ''));
  if (existed) {
    if (existed.monitoring_status === 'inactive') {
      let signals;
      try { signals = sanitizeSignals(enabledSignals || JSON.parse(existed.enabled_signals || '[]')); } catch (e) { signals = ['price', 'launch', 'stock']; }
      db.prepare(`UPDATE watch_targets SET monitoring_status='active', deactivated_at=NULL, updated_at=?,
        enabled_signals=?, market=COALESCE(NULLIF(?,''), market), timezone=CASE WHEN ? IS NOT NULL THEN ? ELSE timezone END
        WHERE tenant_id=? AND watch_target_id=?`)
        .run(nowIso(), JSON.stringify(signals),
          String(market || ''), timezone && validTimezone(timezone) ? timezone : null, timezone && validTimezone(timezone) ? timezone.trim() : null,
          tid, existed.watch_target_id);
      return { target: getWatchTarget(tid, existed.watch_target_id), existed: true, reactivated: true };
    }
    return { target: rowToTarget(existed), existed: true, reactivated: false };
  }
  const t = {
    watch_target_id: rid('wt'),
    market: String(market || '').slice(0, 40),
    timezone: validTimezone(timezone) ? timezone.trim() : 'UTC',
    enabled_signals: sanitizeSignals(enabledSignals),
    // 能力门槛（整改 §9）：supportedSignals 由 handler 按真实直接源计算，可为空数组
    //（无任何已实现直接源）——这里只做词表过滤 + 去重，不回退默认（空 = 明确不支持任何信号）
    supported_signals: JSON.stringify(filterKnownSignals(supportedSignals)),
    monitoring_status: 'active',            // 用户明确「加入监控」→ 进入正式巡检（01 §16）
    qualification_status: 'unresolved',     // 00 §3.1：QualificationResult 链未建前不得虚标 qualified
    enrichment_status: ENRICHMENT_STATUSES.has(enrichmentStatus) ? enrichmentStatus : 'not_started',
    freshness_status: 'unknown',
    created_at: nowIso(),
    updated_at: nowIso(),
    baseline_started_at: nowIso(),          // 基线观察期从加入时刻起算
    baseline_completed_at: null,
    last_success_at: null,
    deactivated_at: null,
  };
  db.prepare(`INSERT INTO watch_targets
    (watch_target_id, tenant_id, project_id, competitor_id, market, timezone, enabled_signals, supported_signals,
     monitoring_status, qualification_status, enrichment_status, freshness_status,
     created_at, updated_at, baseline_started_at, baseline_completed_at, last_success_at, deactivated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(t.watch_target_id, tid, String(projectId || ''), String(competitorId || ''), t.market, t.timezone,
      JSON.stringify(t.enabled_signals), t.supported_signals, t.monitoring_status, t.qualification_status, t.enrichment_status,
      t.freshness_status, t.created_at, t.updated_at, t.baseline_started_at, null, null, null);
  return { target: getWatchTarget(tid, t.watch_target_id), existed: false, reactivated: false };
}

function rowToTarget(r) {
  if (!r) return null;
  let signals = [], supported = [];
  try { signals = JSON.parse(r.enabled_signals || '[]'); } catch (e) {}
  try { supported = JSON.parse(r.supported_signals || '[]'); } catch (e) {}
  return {
    watchTargetId: r.watch_target_id,
    tenantId: r.tenant_id,
    projectId: r.project_id,
    competitorId: r.competitor_id,
    market: r.market,
    timezone: r.timezone,
    enabledSignals: signals,
    supportedSignals: supported, // §9 能力门槛：当前品牌真实可用的直接监控信号（可为空）
    monitoringStatus: r.monitoring_status,
    qualificationStatus: r.qualification_status,
    enrichmentStatus: r.enrichment_status,
    freshnessStatus: r.freshness_status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    baselineStartedAt: r.baseline_started_at,
    baselineCompletedAt: r.baseline_completed_at,
    lastSuccessAt: r.last_success_at,
    deactivatedAt: r.deactivated_at || null, // §5 软停用审计字段（不新增业务状态枚举）
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

// 正式巡检对象：全部租户的可调度目标（整改 §2：active + degraded 都继续巡检；
// degraded = 降级运行 ≠ 暂停，成功后由 markSuccess 恢复 active。调度器内部使用，非租户面）
function listSchedulableTargets() {
  return getDb().prepare("SELECT * FROM watch_targets WHERE monitoring_status IN ('active','degraded') ORDER BY created_at")
    .all().map(rowToTarget);
}

// 严格 active 集（保留给"只看正常态"的展示场景；调度一律走 listSchedulableTargets）
function listActiveTargets() {
  return getDb().prepare("SELECT * FROM watch_targets WHERE monitoring_status='active' ORDER BY created_at")
    .all().map(rowToTarget);
}

// PATCH：白名单字段（monitoring_status 仅在 baseline 词表内取值；timezone 校验 IANA）
// 🔴 SC-08 r2 §二：supportedSignals 不在白名单内——系统能力只能由内部受控的
// upgradeWatchTargetCapabilities（真实采集资格验证通过后）增加，普通 PATCH 不得声明。
const PATCHABLE = new Set(['market', 'timezone', 'enabledSignals', 'monitoringStatus']);
function updateWatchTarget(tenantId, watchTargetId, patch) {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM watch_targets WHERE tenant_id=? AND watch_target_id=?')
    .get(String(tenantId || ''), String(watchTargetId || ''));
  if (!cur) return null;
  // 显式拒绝：能力声明不得由前端 PATCH 写入（否则用户可自封「支持价格监控」）
  if (patch && patch.supportedSignals !== undefined) return { error: 'CAPABILITY_NOT_PATCHABLE' };
  const sets = [];
  const vals = [];
  if (patch && PATCHABLE.has('market') && patch.market !== undefined) { sets.push('market=?'); vals.push(String(patch.market || '').slice(0, 40)); }
  if (patch && patch.timezone !== undefined) {
    if (!validTimezone(patch.timezone)) return { error: 'INVALID_TIMEZONE' };
    sets.push('timezone=?'); vals.push(patch.timezone.trim());
  }
  if (patch && patch.enabledSignals !== undefined) {
    // SC-08 r3 §二：enabledSignals 必须是当前 supportedSignals 的子集。
    //   · 词表过滤但**不回退**：空数组就是空——不得经 sanitizeSignals 回退成 Shopify 三件套；
    //   · 非空但含不受支持的信号 → SIGNAL_NOT_SUPPORTED（handler 400），不部分生效；
    //   · pause/resume 等其它 PATCH 不受影响；受控升级 upgradeWatchTargetCapabilities
    //     不走本路径（直接写库且自带 verifiedBasis 校验），逻辑保持不变。
    let supportedNow = [];
    try { supportedNow = filterKnownSignals(JSON.parse(cur.supported_signals || '[]')); } catch (e) { supportedNow = []; }
    const requested = filterKnownSignals(patch.enabledSignals);
    if (!requested.length) return { error: 'ENABLED_SIGNALS_EMPTY' };
    const notSupported = requested.filter(s => !supportedNow.includes(s));
    if (notSupported.length) return { error: 'SIGNAL_NOT_SUPPORTED', notSupported };
    sets.push('enabled_signals=?'); vals.push(JSON.stringify(requested));
  }
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

/**
 * 内部受控的能力升级（SC-08 r2 §二）。
 *
 * 只允许「真实采集资格验证通过」后增加 supportedSignals：
 *   · verifiedBasis 必须由 watch-intent.buildVerifiedBasis 从库里真实 attempt 派生
 *     （含 issuedBy 署名 + 同品牌 competitorId + ≥2 个真实 attemptId + 评估时间）；
 *   · 本函数不接受前端自报字段，HTTP PATCH 也无法写 supportedSignals。
 *
 * 语义：supportedSignals 只增不减（能力升级不回退历史能力）；enabledSignals 必须是
 * supportedSignals 的子集。site_change → price 升级后为：
 *   supportedSignals: ['site_change','price']，enabledSignals: ['price']
 * 只更新这两列：既有官网 baseline、监控窗口、情报事件与时间线全部保留。
 * 重复升级幂等（无变化时 upgraded=false，不写库）。
 *
 * @returns {{target:object, upgraded:boolean, unchanged?:boolean}|{error:string}}
 */
function upgradeWatchTargetCapabilities(input) {
  const o = input || {};
  const db = getDb();
  const tid = String(o.tenantId || '');
  const cur = db.prepare('SELECT * FROM watch_targets WHERE tenant_id=? AND watch_target_id=?')
    .get(tid, String(o.watchTargetId || ''));
  if (!cur) return null;
  const t = rowToTarget(cur);
  const add = filterKnownSignals(o.addSupportedSignals);
  if (!add.length) return { error: 'NO_SIGNALS' };
  const b = o.verifiedBasis || null;
  const basisOk = !!b
    && b.issuedBy === 'watch-intent/buildVerifiedBasis'
    && b.ok === true
    && String(b.competitorId || '') === String(t.competitorId || '')
    && Array.isArray(b.attemptIds) && b.attemptIds.filter(Boolean).length >= 2
    && !!b.evaluatedAt
    && add.includes(String(b.signal || ''));
  if (!basisOk) return { error: 'UNVERIFIED_CAPABILITY' };

  const nextSupported = t.supportedSignals.slice();
  for (const s of add) if (!nextSupported.includes(s)) nextSupported.push(s);

  let nextEnabled = t.enabledSignals.slice();
  if (o.enabledSignals !== undefined) {
    const want = filterKnownSignals(o.enabledSignals);
    // enabledSignals 必须是（升级后的）supportedSignals 子集，否则拒绝而不是悄悄裁剪
    if (!want.length || want.some(s => !nextSupported.includes(s))) return { error: 'ENABLED_NOT_SUPPORTED' };
    nextEnabled = want;
  }

  const sameSupported = JSON.stringify(nextSupported) === JSON.stringify(t.supportedSignals);
  const sameEnabled = JSON.stringify(nextEnabled) === JSON.stringify(t.enabledSignals);
  if (sameSupported && sameEnabled) {
    return { target: t, upgraded: false, unchanged: true };
  }
  db.prepare(`UPDATE watch_targets SET supported_signals=?, enabled_signals=?, updated_at=?
    WHERE tenant_id=? AND watch_target_id=?`)
    .run(JSON.stringify(nextSupported), JSON.stringify(nextEnabled), nowIso(), tid, String(o.watchTargetId));
  return { target: getWatchTarget(tid, String(o.watchTargetId)), upgraded: true, unchanged: false };
}

// 整改 §5：移出监控 = 软停用（monitoring_status='inactive' + deactivated_at 审计），
// WatchTarget、MonitoringWindow、事件与历史全部保留；不新增业务状态枚举
//（inactive 是 00 §3 冻结词表既有值）。再次加入走 createWatchTarget 恢复原对象。
function deleteWatchTarget(tenantId, watchTargetId) {
  const db = getDb();
  const r = db.prepare(`UPDATE watch_targets SET monitoring_status='inactive', deactivated_at=?, updated_at=?
    WHERE tenant_id=? AND watch_target_id=? AND monitoring_status != 'inactive'`)
    .run(nowIso(), nowIso(), String(tenantId || ''), String(watchTargetId || ''));
  return r.changes > 0;
}

function markSuccess(tenantId, watchTargetId, atIso) {
  const db = getDb();
  const t = db.prepare('SELECT * FROM watch_targets WHERE tenant_id=? AND watch_target_id=?').get(String(tenantId), String(watchTargetId));
  if (!t) return;
  const last = t.last_success_at ? Date.parse(t.last_success_at) : 0;
  const at = Date.parse(atIso);
  const fresh = at - last > 0;
  // 整改 §2：degraded = 降级运行，任一信号成功即恢复 active + fresh
  //（paused/inactive 不在此列——它们本就不进入巡检，markSuccess 不会被调度器触发）
  db.prepare(`UPDATE watch_targets SET last_success_at=?, freshness_status='fresh',
    monitoring_status=CASE WHEN monitoring_status='degraded' THEN 'active' ELSE monitoring_status END,
    baseline_completed_at=COALESCE(baseline_completed_at, CASE WHEN ? THEN ? ELSE NULL END), updated_at=?
    WHERE tenant_id=? AND watch_target_id=?`)
    .run(atIso, fresh && !t.baseline_completed_at ? 1 : 0, atIso, nowIso(), String(tenantId), String(watchTargetId));
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
  // result: { signalResults:[{signal,attempted,succeeded,failed,reason}], attempted, succeeded, failed, partialScan, failureReasons, eventsVerified, eventsPending, eventsWriteFailed, eventsDuplicate }
  db.prepare(`UPDATE monitoring_windows SET status='complete', ended_at=?, signal_results=?, attempted=?, succeeded=?,
    failed=?, partial_scan=?, failure_reasons=?, events_verified=?, events_pending=?, events_write_failed=?, events_duplicate=?
    WHERE window_id=? AND status='running'`)
    .run(new Date(nowMs || Date.now()).toISOString(), JSON.stringify(result.signalResults || []),
      result.attempted || 0, result.succeeded || 0, result.failed || 0, result.partialScan ? 1 : 0,
      JSON.stringify(result.failureReasons || {}), result.eventsVerified || 0,
      result.eventsPending || 0, result.eventsWriteFailed || 0, result.eventsDuplicate || 0, windowId);
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
    eventsPending: r.events_pending || 0, eventsWriteFailed: r.events_write_failed || 0, eventsDuplicate: r.events_duplicate || 0,
    scheduleLagMs: r.schedule_lag_ms,
    // coverage 结论（只读派生，不落列）：任何失败/partial/未完成 → gap（00 §20/§21：不得把失败当无变化）
    // r2 §三.6：事件**写库失败**属覆盖缺口（这次变化没被记录，下个窗口要重试），
    // 不允许窗口仍显示完全成功。待核实(pending)不是缺口——事件已落库，只是缺证据，
    // 由 eventsPending 独立如实计数，不冒充已核实。
    coverage: r.status !== 'complete' ? 'incomplete'
      : (r.failed > 0 || r.partial_scan || (r.events_write_failed || 0) > 0 ? 'gap' : 'full'),
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

// ---------- 单品价格快照（整改 §6：稳定商品身份比较；每身份存最近一条） ----------
// ---------- 官网结构化指纹 baseline（SC-08 §三 C） ----------
// 首次成功观察只写 baseline（不入事件）；此后每次窗口与 baseline 做确定性 Diff。
function getSiteBaseline(tenantId, projectId, competitorId) {
  const row = getDb().prepare(
    'SELECT * FROM watch_site_baselines WHERE tenant_id=? AND project_id=? AND competitor_id=?'
  ).get(String(tenantId || ''), String(projectId || ''), String(competitorId || ''));
  if (!row) return null;
  let fingerprint = null, stability = null;
  try { fingerprint = JSON.parse(row.fingerprint_json); } catch (e) { fingerprint = null; }
  try { stability = row.stability_json ? JSON.parse(row.stability_json) : null; } catch (e) { stability = null; }
  return { fingerprint, stability, url: row.url || null, at: row.at, updatedAt: row.updated_at };
}

function saveSiteBaseline({ tenantId, projectId, competitorId, fingerprint, stability, url, at }) {
  const nowIso = at || new Date().toISOString();
  getDb().prepare(`INSERT INTO watch_site_baselines
      (tenant_id, project_id, competitor_id, fingerprint_json, stability_json, url, at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id, project_id, competitor_id) DO UPDATE SET
        fingerprint_json=excluded.fingerprint_json, stability_json=excluded.stability_json,
        url=excluded.url, at=excluded.at, updated_at=excluded.updated_at`)
    .run(String(tenantId || ''), String(projectId || ''), String(competitorId || ''),
      JSON.stringify(fingerprint || null), JSON.stringify(stability || {}), url ? String(url) : null, nowIso, nowIso);
  return getSiteBaseline(tenantId, projectId, competitorId);
}

function clearSiteBaseline(tenantId, projectId, competitorId) {
  return getDb().prepare('DELETE FROM watch_site_baselines WHERE tenant_id=? AND project_id=? AND competitor_id=?')
    .run(String(tenantId || ''), String(projectId || ''), String(competitorId || '')).changes;
}

function listProductPrices(tenantId, projectId, competitorId) {
  return getDb().prepare(`SELECT * FROM watch_price_snapshots
    WHERE tenant_id=? AND project_id=? AND competitor_id=?`)
    .all(String(tenantId || ''), String(projectId || ''), String(competitorId || ''))
    .map(r => ({
      subjectId: String(r.subject_id), currency: r.currency, specSignature: r.spec_signature || '',
      price: r.price, display: r.display || null, title: r.title || null, at: r.at,
    }));
}

// upsert 最近快照（调用方先 listProductPrices 取 prev，比较后再落新值）
function upsertProductPrice(tenantId, projectId, competitorId, snap) {
  const db = getDb();
  const s = snap || {};
  if (!s.subjectId || !Number.isFinite(Number(s.price)) || Number(s.price) <= 0) return false;
  db.prepare(`INSERT INTO watch_price_snapshots
    (snapshot_id, tenant_id, project_id, competitor_id, subject_id, currency, spec_signature, price, display, title, at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT (tenant_id, project_id, competitor_id, subject_id, currency)
    DO UPDATE SET spec_signature=excluded.spec_signature, price=excluded.price, display=excluded.display,
      title=excluded.title, at=excluded.at`)
    .run(rid('wps'), String(tenantId || ''), String(projectId || ''), String(competitorId || ''),
      String(s.subjectId), String(s.currency || 'USD').toUpperCase(), String(s.specSignature || ''),
      Number(s.price), s.display != null ? String(s.display) : null, s.title != null ? String(s.title) : null,
      String(s.at || nowIso()));
  return true;
}

module.exports = {
  MONITORING_STATUSES, QUALIFICATION_STATUSES, ENRICHMENT_STATUSES, FRESHNESS_STATUSES,
  SIGNALS, FAILURE_REASONS, WINDOW_SLOTS, POLICY_VERSION, JITTER_MAX_MS, STALE_CLAIM_MS,
  REGION_TZ, validTimezone, zonedSlotUtc, localParts, tzOffsetMs,
  getDb, closeDb,
  createWatchTarget, getWatchTarget, listWatchTargets, listActiveTargets, listSchedulableTargets, updateWatchTarget, deleteWatchTarget,
  upgradeWatchTargetCapabilities,
  markSuccess, markDegraded, refreshFreshness,
  listProductPrices, upsertProductPrice,
  getSiteBaseline, saveSiteBaseline, clearSiteBaseline,
  claimWindow, completeWindow, failWindow, getWindow, windowsForTargetDay, windowsForTenantDay, latestWindowFor,
};
