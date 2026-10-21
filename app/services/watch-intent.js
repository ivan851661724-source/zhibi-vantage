'use strict';
// ============================================================
// services/watch-intent.js —— 「加入监控」的监控意向（SC-07 §2 / r2 整改 §二）
// ------------------------------------------------------------
// PRD 01 §16：用户明确点击「加入监控」才进入**正式持续监控**；自动首轮采集
// 绝不能偷偷创建 WatchTarget。
//
// r2 整改核心：意向必须有**持久化的来源建立流程**，不允许永久停在 establishing：
//   state:
//     establishing  已保存意向，正在建立可重复抓取的商品来源（不显示「监控中」）
//     source_failed 来源建立失败（拒访/限流/解析失败/无可比商品），保留原因
//     promoted      已升级为正式 WatchTarget（intent 关闭，指向 targetId）
//     cancelled     用户退出，不再自动采集、不再自动晋升
//
// 建立流程（全部落库，服务重启后可恢复）：
//   ① 用户点击 → requestIntent + scheduleFirstProbe（安排第一次 public_site_products 探测）
//   ② 第一次取得可比较商品 → evaluateIntentState 持久化 next_probe_at（下一次独立探测）
//   ③ 到期后 runDueProbes 自动执行第二次独立采集（新 attempt、真实观察时间）；
//      重启后 next_probe_at 在库里，调度器照常执行
//   ④ 两次采集必须不同 attempt、真实观察时间、可比较商品标识——晋升判定
//      promotionEligibility 直接按库里成功 attempt 重算，禁止凑数
//   ⑤ 满足条件才 tryPromote 创建正式 WatchTarget
//   ⑥ 不满足时始终有明确下一步（nextStepText）：已安排探测 / 限流后自动重试 /
//      等待用户重试——不存在无后续任务的永久 establishing
// 终态分类（§二）：
//   403/401 → source_failed/blocked；429 → source_failed/rate_limited（带有界重试时间）；
//   解析失败 → source_failed/parse_failed；成功但无可比商品 → source_failed/no_comparable_products
// 正式监控（晋升后）只支持 price：supportedSignals=['price']、enabledSignals=['price']，
// 不宣称上新/库存（公开商品页无发布时间与库存字段可核验）。
//
// 调度器仍只认 watch_targets.monitoring_status='active'（正式监控唯一资格边界）。
// ============================================================

const WS = require('./watch-store.js');
const SurfaceStore = require('./surface-store.js');

const INTENT_STATES = Object.freeze(['establishing', 'source_failed', 'promoted', 'cancelled']);

// 非 Shopify 商品来源可比较字段：商品标识（URL）+ 价格 + 币种
const SOURCE_CAPABILITY = 'public_site_products';

// ---- 有界探测参数（env 可覆盖；全部有上界，防无限重试/无限计费） ----
// 两次独立探测的最小间隔（第一次成功后到下一次探测）：默认 60 分钟
const PROBE_INTERVAL_MS = Math.max(1000, Number(process.env.ZB_INTENT_PROBE_INTERVAL_MS) || 60 * 60 * 1000);
// 限流后的自动重试等待（带有界）：默认 30 分钟
const RATE_RETRY_MS = Math.max(1000, Number(process.env.ZB_INTENT_RATE_RETRY_MS) || 30 * 60 * 1000);
// 暂时性失败（超时/不可达）的退避：默认 10 分钟
const RETRY_BACKOFF_MS = Math.max(1000, Number(process.env.ZB_INTENT_RETRY_BACKOFF_MS) || 10 * 60 * 1000);
// 自动重试上限（限流 + 暂时性失败合并计数；超过后等待用户重试）
const MAX_AUTO_RETRIES = Math.max(1, Number(process.env.ZB_INTENT_MAX_AUTO_RETRIES) || 3);
// 探测入队后的看门狗宽限：超时未见到 attempt 终态 → 调度器可再入队（幂等兜底）
const PROBE_PENDING_GRACE_MS = Math.max(60 * 1000, Number(process.env.ZB_INTENT_PROBE_GRACE_MS) || 15 * 60 * 1000);

let _tableReady = false;
function ensureTable() {
  if (_tableReady) return;
  const db = WS.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS watch_intents (
    intent_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    brand_id TEXT,
    state TEXT NOT NULL DEFAULT 'establishing',
    reason_code TEXT,
    reason_text TEXT,
    source_capability TEXT,
    enabled_signals TEXT,
    promoted_target_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tenant_id, project_id, competitor_id)
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_wi_scope ON watch_intents(tenant_id, project_id, state)');
  // r2 §二：持久化建立流程列（加法迁移；老库补列）
  const addCol = (ddl) => { try { db.exec(ddl); } catch (e) { /* 列已存在 */ } };
  addCol('ALTER TABLE watch_intents ADD COLUMN next_probe_at TEXT');
  addCol('ALTER TABLE watch_intents ADD COLUMN probe_count INTEGER NOT NULL DEFAULT 0');
  addCol('ALTER TABLE watch_intents ADD COLUMN auto_retries INTEGER NOT NULL DEFAULT 0');
  addCol('ALTER TABLE watch_intents ADD COLUMN last_probe_attempt_id TEXT');
  _tableReady = true;
}

function rid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function rowToIntent(r) {
  if (!r) return null;
  return {
    intentId: r.intent_id,
    tenantId: r.tenant_id,
    projectId: r.project_id,
    competitorId: r.competitor_id,
    brandId: r.brand_id || null,
    state: r.state,
    reasonCode: r.reason_code || null,
    reasonText: r.reason_text || null,
    sourceCapability: r.source_capability || null,
    enabledSignals: r.enabled_signals ? JSON.parse(r.enabled_signals) : [],
    promotedTargetId: r.promoted_target_id || null,
    // r2 §二：持久化建立流程
    nextProbeAt: r.next_probe_at || null,
    probeCount: r.probe_count || 0,
    autoRetries: r.auto_retries || 0,
    lastProbeAttemptId: r.last_probe_attempt_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// 用户可见状态文案（不出现内部码）；「监控中」只在 promoted 且 target active 时由 target 提供
const STATE_TEXT = Object.freeze({
  establishing: '正在建立监控来源',
  source_failed: '监控来源建立失败',
  promoted: '已接入正式监控',
  cancelled: '已退出监控',
});

// 明确下一步（r2 §二.6：禁止无后续任务的永久 establishing）
function nextStepText(intent) {
  if (!intent) return null;
  if (intent.state === 'establishing') {
    if (intent.nextProbeAt) {
      return new Date(intent.nextProbeAt).getTime() <= Date.now()
        ? '正在安排下一次来源探测'
        : '已安排下一次来源探测（' + String(intent.nextProbeAt).slice(0, 16).replace('T', ' ') + '）';
    }
    return '正在等待当前采集结果';
  }
  if (intent.state === 'source_failed') {
    if (intent.reasonCode === 'rate_limited' && intent.nextProbeAt) {
      return '来源限流，将在 ' + String(intent.nextProbeAt).slice(0, 16).replace('T', ' ') + ' 自动重试';
    }
    return '等待你重试：可重新点击「加入监控」再试一次';
  }
  return null;
}

function view(intent) {
  if (!intent) return null;
  const v = Object.assign({}, intent);
  delete v.tenantId;
  v.stateText = STATE_TEXT[intent.state] || intent.state;
  // 重要：非 promoted 的意向不得对外表达「监控中 / 巡检成功 / 无变化」
  v.monitoring = intent.state === 'promoted';
  v.nextStepText = nextStepText(intent);
  return v;
}

// 幂等：同 tenant×project×competitor 只有一条；退出后（cancelled）再次加入会重新置 establishing
function requestIntent({ tenantId, projectId, competitorId, brandId, reasonCode, reasonText, signals }) {
  ensureTable();
  const tid = String(tenantId || ''); const pid = String(projectId || ''); const cid = String(competitorId || '');
  if (!tid || !pid || !cid) return { error: 'MISSING_CONTEXT' };
  const db = WS.getDb();
  const now = new Date().toISOString();
  const existed = db.prepare('SELECT * FROM watch_intents WHERE tenant_id=? AND project_id=? AND competitor_id=?').get(tid, pid, cid);
  if (existed) {
    if (existed.state === 'promoted') return { intent: rowToIntent(existed), existed: true, promoted: true };
    // 重新加入：清除旧的重试计数与失败原因，从头建立；next_probe_at 由 scheduleFirstProbe 重设
    db.prepare(`UPDATE watch_intents SET state='establishing', reason_code=?, reason_text=?, brand_id=COALESCE(?, brand_id),
                enabled_signals=COALESCE(?, enabled_signals), auto_retries=0, next_probe_at=NULL, updated_at=? WHERE intent_id=?`)
      .run(reasonCode || null, reasonText || null, brandId || null, signals ? JSON.stringify(signals) : null, now, existed.intent_id);
    return { intent: rowToIntent(db.prepare('SELECT * FROM watch_intents WHERE intent_id=?').get(existed.intent_id)), existed: true, reactivated: existed.state === 'cancelled' };
  }
  const id = rid('wi');
  db.prepare(`INSERT INTO watch_intents
    (intent_id, tenant_id, project_id, competitor_id, brand_id, state, reason_code, reason_text, source_capability, enabled_signals, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, tid, pid, cid, brandId || null, 'establishing', reasonCode || null, reasonText || null,
    SOURCE_CAPABILITY, signals ? JSON.stringify(signals) : JSON.stringify(['price']), now, now,
  );
  return { intent: rowToIntent(db.prepare('SELECT * FROM watch_intents WHERE intent_id=?').get(id)), existed: false };
}

function getIntent(tenantId, intentId) {
  ensureTable();
  return rowToIntent(WS.getDb().prepare('SELECT * FROM watch_intents WHERE tenant_id=? AND intent_id=?').get(String(tenantId || ''), String(intentId || '')));
}

function findIntent(tenantId, projectId, competitorId) {
  ensureTable();
  return rowToIntent(WS.getDb().prepare(
    'SELECT * FROM watch_intents WHERE tenant_id=? AND project_id=? AND competitor_id=?'
  ).get(String(tenantId || ''), String(projectId || ''), String(competitorId || '')));
}

function listIntents(tenantId, projectId) {
  ensureTable();
  const rows = projectId
    ? WS.getDb().prepare('SELECT * FROM watch_intents WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC').all(String(tenantId || ''), String(projectId))
    : WS.getDb().prepare('SELECT * FROM watch_intents WHERE tenant_id=? ORDER BY created_at DESC').all(String(tenantId || ''));
  return rows.map(rowToIntent);
}

function cancelIntent(tenantId, intentId) {
  ensureTable();
  const cur = getIntent(tenantId, intentId);
  if (!cur) return null;
  if (cur.state === 'promoted') return { error: 'ALREADY_PROMOTED' }; // 已正式监控 → 走 DELETE /watch-targets
  // r2 §二：取消后不得继续采集或自动晋升——清空下一次探测时间；调度器与
  // onProbeFinished 都只认 establishing（cancelled 意向的后续采集结果一律忽略）
  WS.getDb().prepare("UPDATE watch_intents SET state='cancelled', reason_code='user_cancelled', reason_text=NULL, next_probe_at=NULL, updated_at=? WHERE intent_id=?")
    .run(new Date().toISOString(), String(intentId));
  return getIntent(tenantId, intentId);
}

// setFailed：来源建立失败（可从 establishing 或限流恢复中的 source_failed 落入）。
// opts.keepRetryAt（可选 ISO）：限流类失败保留有界自动重试时间；否则清空（等待用户重试）。
function setFailed(tenantId, intentId, reasonCode, reasonText, opts) {
  ensureTable();
  const o = opts || {};
  WS.getDb().prepare(`UPDATE watch_intents SET state='source_failed', reason_code=?, reason_text=?, next_probe_at=?, updated_at=?
    WHERE tenant_id=? AND intent_id=? AND state IN ('establishing','source_failed')`)
    .run(reasonCode || 'source_unavailable', reasonText || null, o.keepRetryAt || null, new Date().toISOString(), String(tenantId || ''), String(intentId || ''));
  return getIntent(tenantId, intentId);
}

// ---------- 持久化探测调度（r2 §二） ----------

// 用户点击后安排第一次探测（立即；幂等：已有计划不覆盖）
function scheduleFirstProbe({ tenantId, projectId, competitorId }) {
  ensureTable();
  const intent = findIntent(tenantId, projectId, competitorId);
  if (!intent) return null;
  if (intent.state !== 'establishing') return intent;
  if (intent.nextProbeAt) return intent; // 已有计划（重复点击不覆盖）
  WS.getDb().prepare("UPDATE watch_intents SET next_probe_at=?, updated_at=? WHERE intent_id=?")
    .run(new Date().toISOString(), new Date().toISOString(), intent.intentId);
  return getIntent(tenantId, intent.intentId);
}

// 内部：设置探测计划与计数
function setProbeSchedule(intentId, { nextProbeAt, probeCount, autoRetries, lastProbeAttemptId, state }) {
  ensureTable();
  WS.getDb().prepare(`UPDATE watch_intents SET
      next_probe_at=COALESCE(?, next_probe_at),
      probe_count=COALESCE(?, probe_count),
      auto_retries=COALESCE(?, auto_retries),
      last_probe_attempt_id=COALESCE(?, last_probe_attempt_id),
      state=COALESCE(?, state),
      updated_at=? WHERE intent_id=?`)
    .run(nextProbeAt || null, probeCount == null ? null : probeCount, autoRetries == null ? null : autoRetries,
      lastProbeAttemptId || null, state || null, new Date().toISOString(), String(intentId));
}

// ---------- 可比较性判定（升级的硬条件 ②③） ----------
// 成功 attempt 的商品观察 → {subjectId, price, currency}
function comparableItems(attempt) {
  const obs = attempt && Array.isArray(attempt.observations) ? attempt.observations : [];
  const out = [];
  for (const o of obs) {
    const key = o && (o.sourceUrl || o.id);
    const price = o && typeof o.price === 'number' ? o.price : null;
    const currency = o && o.currency ? String(o.currency).toUpperCase() : null;
    if (!key || price == null || !currency) continue;
    out.push({ subjectId: String(key), price, currency });
  }
  return out;
}

// 两次观察之间的确定性 Diff：同商品同币种逐品比较（无同键 → 不可比较）
function deterministicDiff(prev, next) {
  if (!prev.length || !next.length) return { comparable: false, reason: 'empty_observation' };
  const byKey = new Map(prev.map(p => [p.subjectId + '|' + p.currency, p.price]));
  let compared = 0; const changes = [];
  for (const n of next) {
    const k = n.subjectId + '|' + n.currency;
    if (!byKey.has(k)) continue;
    compared += 1;
    const old = byKey.get(k);
    if (old !== n.price) changes.push({ subjectId: n.subjectId, currency: n.currency, old, new: n.price });
  }
  if (!compared) return { comparable: false, reason: 'no_common_subject' };
  return { comparable: true, compared, changes };
}

// 升级资格：真实成功 ≥2 次 + 可比较字段 + 确定性 Diff
// r3 真实验收暴露：公开商品页采集常见 partial（部分页面抓取失败，但已观察到的商品
// 价格是真实且可比较的）。旧实现只认 success，导致「每次都是 partial」的真实品牌
// 永远无法晋升——这是资格判定的缺口，不是来源失败。改为 success/partial 均可计入，
// 但必须带可比较商品（同商品标识 + 价格 + 币种），Diff 仍要求同键同币种。
function promotionEligibility(tenantId, projectId, competitorId) {
  const Readiness = require('./source-readiness.js');
  const rd = Readiness.getReadiness(SOURCE_CAPABILITY);
  const atts = (SurfaceStore.listAttempts(tenantId, projectId, competitorId, SOURCE_CAPABILITY, 10) || [])
    .filter(a => a && (a.status === 'success' || a.status === 'partial'));
  const withItems = atts.map(a => ({ attempt: a, items: comparableItems(a) })).filter(x => x.items.length > 0);
  const out = {
    readiness: rd.state,
    successfulAttempts: atts.length,
    comparableAttempts: withItems.length,
    partialAttempts: atts.filter(a => a.status === 'partial').length,
    eligible: false, reason: null, diff: null,
  };
  if (rd.state !== 'operational') { out.reason = 'source_not_verified'; return out; }
  if (withItems.length < 2) { out.reason = 'need_two_comparable_collections'; return out; }
  const diff = deterministicDiff(withItems[1].items, withItems[0].items);
  out.diff = diff;
  if (!diff.comparable) { out.reason = 'diff_not_computable:' + diff.reason; return out; }
  out.eligible = true;
  return out;
}

/**
 * 从库里重算意向状态并决定下一步（幂等；成功路径唯一入口）。
 * - 已可晋升 → tryPromote；
 * - 至少一次可比较成功且未晋升 → 持久化下一次探测时间（probe_count 同步库内真值）；
 * - 无可比较成功 → 交由失败分支处理（本函数不动）。
 */
function evaluateIntentState(tenantId, projectId, competitorId, opts) {
  ensureTable();
  const o = opts || {};
  const intent = findIntent(tenantId, projectId, competitorId);
  if (!intent) return { action: 'no_intent' };
  if (intent.state === 'cancelled' || intent.state === 'promoted') return { action: 'terminal_state:' + intent.state };
  const el = promotionEligibility(tenantId, projectId, competitorId);
  if (el.eligible) {
    const p = tryPromote({ tenantId, projectId, competitorId, timezone: o.timezone, market: o.market });
    return { action: p.promoted ? 'promoted' : 'promote_failed:' + (p.reason || ''), eligibility: el };
  }
  if (el.comparableAttempts >= 1) {
    // 至少一次可比较成功：持久化下一次独立探测时间（重启后调度器照常执行）
    setProbeSchedule(intent.intentId, {
      nextProbeAt: new Date(Date.now() + PROBE_INTERVAL_MS).toISOString(),
      probeCount: el.comparableAttempts,
      state: 'establishing',
    });
    return { action: 'scheduled_next_probe', probeCount: el.comparableAttempts, eligibility: el };
  }
  return { action: 'no_comparable_success', eligibility: el };
}

/**
 * 尝试把意向升级为正式监控（幂等；不满足条件则保持 establishing/failed）。
 * 只在该品牌刚完成一次公开商品采集后调用。
 */
function tryPromote({ tenantId, projectId, competitorId, timezone, market }) {
  ensureTable();
  const intent = findIntent(tenantId, projectId, competitorId);
  if (!intent || intent.state !== 'establishing') return { promoted: false, reason: 'no_open_intent' };
  const el = promotionEligibility(tenantId, projectId, competitorId);
  if (!el.eligible) {
    return { promoted: false, reason: el.reason, eligibility: el };
  }
  // r2 §二：非 Shopify 公开商品页只能核实「价格 + 商品标识」——supportedSignals
  // 只能是 ['price']，不宣称上新/库存（无发布时间与库存字段可核验）。
  const signals = ['price'];
  const r = WS.createWatchTarget({
    tenantId, projectId, competitorId,
    market: market || '',
    timezone: timezone || 'UTC',
    enabledSignals: signals,
    supportedSignals: signals,
    enrichmentStatus: 'complete',
    // 非 Shopify 来源不落额外列：执行器按 comp.isShopify 分支（见 watch-monitor）
  });
  WS.getDb().prepare("UPDATE watch_intents SET state='promoted', promoted_target_id=?, reason_code='promoted', reason_text=?, next_probe_at=NULL, updated_at=? WHERE tenant_id=? AND intent_id=?")
    .run(r.target.watchTargetId, '已完成两次可比较采集，升级为正式监控（当前支持价格信号）', new Date().toISOString(), String(tenantId), intent.intentId);
  return { promoted: true, target: r.target, intent: getIntent(tenantId, intent.intentId), eligibility: el };
}

// ---------- 采集完成后的意向推进（collect-jobs worker 调用） ----------
// 公开商品采集结束（任何触发方式）→ 若该品牌有未完结意向：
//   成功且可比 → 晋升或安排下一次探测；成功但零可比 → no_comparable_products；
//   失败按分类落终态（blocked / rate_limited带界重试 / parse_failed / 其他退避重试）。
// cancelled / promoted 的意向一律忽略（取消后不得继续采集或自动晋升）。
function onProbeFinished({ tenantId, projectId, competitorId, attempt }) {
  ensureTable();
  const tid = String(tenantId || ''); const pid = String(projectId || ''); const cid = String(competitorId || '');
  const intent = findIntent(tid, pid, cid);
  if (!intent) return { action: 'no_intent' };
  if (intent.state === 'cancelled') return { action: 'ignored_cancelled' };
  if (intent.state === 'promoted') return { action: 'ignored_promoted' };
  const att = attempt || (intent.lastProbeAttemptId ? SurfaceStore.getAttempt(tid, intent.lastProbeAttemptId) : null);
  if (!att) return { action: 'no_attempt' };
  const status = att.status;
  if (status === 'running') return { action: 'still_running' };

  if (status === 'success' || status === 'partial') {
    const items = comparableItems(att);
    if (!items.length) {
      // 成功但没有可比较商品（有页面、无商品/无价格）→ 终态：等用户重试
      setFailed(tid, intent.intentId, 'no_comparable_products', '来源可以访问，但没有采集到可比较的商品价格信息；可稍后重新加入监控。');
      setProbeSchedule(intent.intentId, { nextProbeAt: null });
      return { action: 'source_failed:no_comparable_products' };
    }
    const r = evaluateIntentState(tid, pid, cid, {});
    // 记录本次探测 attempt
    setProbeSchedule(intent.intentId, { lastProbeAttemptId: att.attemptId });
    return r;
  }

  // ---- 失败分类（r2 §二 终态处理） ----
  const cls = String(att.sourceStatus || att.errorClass || 'unavailable');
  if (cls === 'blocked') {
    // 403/401 → 来源拒绝：终态，等用户重试
    setFailed(tid, intent.intentId, 'blocked', '来源站点拒绝了公开页面访问（403/401），无法建立监控来源；可稍后重试。');
    setProbeSchedule(intent.intentId, { nextProbeAt: null });
    return { action: 'source_failed:blocked' };
  }
  if (cls === 'rate_limited') {
    // 429 → 限流：带**有界**自动重试时间；超过上限后等用户重试
    const retries = (intent.autoRetries || 0) + 1;
    if (retries <= MAX_AUTO_RETRIES) {
      const retryAt = new Date(Date.now() + RATE_RETRY_MS).toISOString();
      setFailed(tid, intent.intentId, 'rate_limited', '来源限流，稍后自动重试；无需你操作。', { keepRetryAt: retryAt });
      setProbeSchedule(intent.intentId, { nextProbeAt: retryAt, autoRetries: retries });
      return { action: 'retry_scheduled:rate_limited', retryAt };
    }
    setFailed(tid, intent.intentId, 'rate_limited', '来源多次限流，已暂停自动重试；可稍后重新加入监控。');
    setProbeSchedule(intent.intentId, { nextProbeAt: null });
    return { action: 'source_failed:rate_limited_exhausted' };
  }
  if (cls === 'parse_failed') {
    setFailed(tid, intent.intentId, 'parse_failed', '来源页面无法解析出商品信息，无法建立监控来源；可稍后重试。');
    setProbeSchedule(intent.intentId, { nextProbeAt: null });
    return { action: 'source_failed:parse_failed' };
  }
  // 暂时性失败（超时/不可达/内部错误）→ 退避重试（有界）
  const retries = (intent.autoRetries || 0) + 1;
  if (retries <= MAX_AUTO_RETRIES) {
    const retryAt = new Date(Date.now() + RETRY_BACKOFF_MS).toISOString();
    setProbeSchedule(intent.intentId, { nextProbeAt: retryAt, autoRetries: retries, state: 'establishing' });
    return { action: 'retry_scheduled:' + cls, retryAt };
  }
  setFailed(tid, intent.intentId, 'source_unavailable', '来源多次暂时不可达，已暂停自动重试；可稍后重新加入监控。');
  setProbeSchedule(intent.intentId, { nextProbeAt: null });
  return { action: 'source_failed:' + cls + '_exhausted' };
}

// ---------- 不变量自愈（r3 P0-2） ----------
// 每个 establishing 意向必须至少满足其一：存在进行中的 job，或存在未来的 next_probe_at。
// 任何失败路径（包括 executor 异常、worker 崩溃、意向推进失败）都不得留下
// 「无任务、无下次时间」的 establishing——本函数在每次调度 tick 兜底修复：
//   · 已有 pending/running job 或 running attempt → 只看门狗时间（缺失则补上）
//   · 否则安排退避探测（计入 auto_retries），超过上限直接 source_failed（等用户重试）
function reconcileStuckIntents(nowMs) {
  ensureTable();
  const now = nowMs || Date.now();
  const nowIso = new Date(now).toISOString();
  const db = WS.getDb();
  const rows = db.prepare(
    `SELECT * FROM watch_intents WHERE state='establishing' AND (next_probe_at IS NULL OR next_probe_at <= ?) LIMIT 100`
  ).all(nowIso);
  const out = { checked: rows.length, rescheduled: 0, failed: 0, activeJob: 0 };
  for (const row of rows) {
    const intent = rowToIntent(row);
    const tid = intent.tenantId, pid = intent.projectId, cid = intent.competitorId;
    let activeJob = 0;
    try {
      activeJob = require('./collect-jobs.js').getDb().prepare(
        `SELECT COUNT(*) AS n FROM collection_jobs
         WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=? AND status IN ('pending','running')`
      ).get(tid, pid, cid, SOURCE_CAPABILITY).n;
    } catch (e) { activeJob = 0; }
    let runningAttempt = 0;
    try {
      const last = SurfaceStore.latestAttempt(tid, pid, cid, SOURCE_CAPABILITY);
      runningAttempt = (last && last.status === 'running') ? 1 : 0;
    } catch (e) { runningAttempt = 0; }
    if (activeJob > 0 || runningAttempt > 0) {
      // 有任务在管：补看门狗时间（有进度的证明），不消耗重试次数
      setProbeSchedule(intent.intentId, { nextProbeAt: new Date(now + PROBE_PENDING_GRACE_MS).toISOString() });
      out.activeJob++;
      continue;
    }
    const retries = (intent.autoRetries || 0) + 1;
    if (retries <= MAX_AUTO_RETRIES) {
      setProbeSchedule(intent.intentId, { nextProbeAt: new Date(now + RETRY_BACKOFF_MS).toISOString(), autoRetries: retries });
      out.rescheduled++;
    } else {
      setFailed(tid, intent.intentId, 'source_unavailable', '多次未能完成来源探测，已暂停自动重试；可稍后重新加入监控。');
      setProbeSchedule(intent.intentId, { nextProbeAt: null });
      out.failed++;
    }
  }
  return out;
}

// ---------- 到期探测执行（持久化建立流程的调度入口） ----------
// 扫描 next_probe_at 到期的未完结意向，重新入队 public_site_products 采集。
// 幂等由 collect-request 链路保证（running 复用 / 冷却 / 日额度）；服务重启后
// next_probe_at 仍在库内，到期照常执行——两次探测之间重启可恢复（§六.4）。
// @returns {{due:number, enqueued:number, deferred:number, failed:number, promoted:number, details:Array}}
function runDueProbes(nowMs) {
  ensureTable();
  const now = nowMs || Date.now();
  const nowIso = new Date(now).toISOString();
  const rows = WS.getDb().prepare(
    `SELECT * FROM watch_intents
     WHERE state IN ('establishing','source_failed') AND next_probe_at IS NOT NULL AND next_probe_at <= ?
     ORDER BY next_probe_at ASC LIMIT 50`
  ).all(nowIso);
  const out = { due: rows.length, enqueued: 0, deferred: 0, failed: 0, promoted: 0, healed: null, details: [] };
  const CollectReq = require('./collect-request.js');
  for (const row of rows) {
    const intent = rowToIntent(row);
    const tid = intent.tenantId, pid = intent.projectId, cid = intent.competitorId;
    // 限流恢复：重试前把状态拉回 establishing（真实重试进行中）
    if (intent.state === 'source_failed' && intent.reasonCode === 'rate_limited') {
      setProbeSchedule(intent.intentId, { state: 'establishing' });
    }
    // 竞品档案解析（worker 脱离请求上下文，与采集执行器同口径）
    const CollectJobs = require('./collect-jobs.js');
    const comp = CollectJobs.loadCompetitor({ tenantId: tid, projectId: pid, competitorId: cid });
    if (!comp) {
      setFailed(tid, intent.intentId, 'competitor_missing', '该品牌已不在项目中，无法继续建立监控来源。');
      setProbeSchedule(intent.intentId, { nextProbeAt: null });
      out.failed++; out.details.push({ intentId: intent.intentId, outcome: 'competitor_missing' });
      continue;
    }
    let r = null;
    try {
      r = CollectReq.requestCollection({
        tenantId: tid, projectId: pid, competitorId: cid,
        capability: SOURCE_CAPABILITY, comp, trigger: 'schedule',
        // 显式幂等键：意向探测的间隔由持久化 next_probe_at 调度保证（≥ PROBE_INTERVAL_MS），
        // 不吃 capability 冷却（冷却 30min 会挡住「两次可比较采集」的第二次独立探测）；
        // 幂等一（running attempt 复用）仍然生效——并发/重复触发不会双跑双计费。
        // 键 = 意向 + 上一次探测 attempt + 15 分钟时间桶：同一探测窗口内重复触发去重，
        // 每次新探测（上次 attempt 已变）生成新 attempt。
        idempotencyKey: 'intent_probe:' + intent.intentId + ':' + (intent.lastProbeAttemptId || 'first') + ':' + Math.floor(now / 900000),
      });
    } catch (e) {
      r = { status: 'failed', code: 'EXCEPTION' };
    }
    if (r.status === 'accepted') {
      // 看门狗：若宽限内未见 attempt 终态，调度器可再入队（幂等兜底，不会双跑）
      setProbeSchedule(intent.intentId, {
        nextProbeAt: new Date(now + PROBE_PENDING_GRACE_MS).toISOString(),
        lastProbeAttemptId: (r.attempt && r.attempt.attemptId) || null,
      });
      out.enqueued++;
      out.details.push({ intentId: intent.intentId, outcome: 'enqueued', attemptId: (r.attempt && r.attempt.attemptId) || null });
      continue;
    }
    if (r.status === 'deduped') {
      if (r.reason === 'cooldown') {
        // 冷却去重 = 最近一次成功还很新：直接按库内真值重算（可能直接晋升）
        const ev = evaluateIntentState(tid, pid, cid, {});
        if (ev.action === 'promoted') { out.promoted++; out.details.push({ intentId: intent.intentId, outcome: 'promoted' }); continue; }
        if (ev.action === 'scheduled_next_probe') { out.enqueued++; out.details.push({ intentId: intent.intentId, outcome: 'scheduled_next' }); continue; }
      }
      // 有进行中的采集：等待其完成（onProbeFinished 会推进）；看门狗兜底
      setProbeSchedule(intent.intentId, { nextProbeAt: new Date(now + PROBE_PENDING_GRACE_MS).toISOString() });
      out.deferred++;
      out.details.push({ intentId: intent.intentId, outcome: 'deferred:' + (r.reason || 'deduped') });
      continue;
    }
    if (r.status === 'quota') {
      // 平台日额度：有界推迟（不产生费用）
      setProbeSchedule(intent.intentId, { nextProbeAt: new Date(now + RATE_RETRY_MS).toISOString() });
      out.deferred++;
      out.details.push({ intentId: intent.intentId, outcome: 'quota_deferred' });
      continue;
    }
    // not_supported / not_configured / failed → 来源失败终态（等用户重试）
    setFailed(tid, intent.intentId, 'source_unavailable', '公开商品来源暂时无法采集；可稍后重新加入监控。');
    setProbeSchedule(intent.intentId, { nextProbeAt: null });
    out.failed++;
    out.details.push({ intentId: intent.intentId, outcome: 'failed:' + r.status });
  }
  // r3 P0-2：处理完到期项后自愈「无任务、无下次时间」的 establishing
  //（enqueued/deferred 的看门狗时间在未来，不会被误判；取消/晋升不在扫描范围）
  out.healed = reconcileStuckIntents(now);
  return out;
}

// ---------- 常驻调度（server.js 启动接线；tick 频率默认 60s） ----------
let _probeTimer = null;
function startScheduler(logger) {
  if (process.env.ZB_INTENT_SCHEDULER === '0') return null;
  if (_probeTimer) return null;
  const seconds = Math.max(10, parseInt(process.env.ZB_INTENT_TICK_SECONDS || '60', 10) || 60);
  const run = () => { try { runDueProbes(); } catch (e) { /* 调度失败不影响主服务 */ } };
  const boot = setTimeout(run, 20 * 1000); // 启动即扫一次（恢复重启前到期的探测）
  if (boot.unref) boot.unref();
  _probeTimer = setInterval(run, seconds * 1000);
  if (_probeTimer.unref) _probeTimer.unref();
  try { logger && logger.info && logger.info('watch intent scheduler 已启动', { tickSeconds: seconds, probeIntervalMs: PROBE_INTERVAL_MS, maxAutoRetries: MAX_AUTO_RETRIES }); } catch (e) {}
  return { tickSeconds: seconds };
}
function stopScheduler() { if (_probeTimer) { clearInterval(_probeTimer); _probeTimer = null; } }

module.exports = {
  INTENT_STATES, SOURCE_CAPABILITY, STATE_TEXT,
  PROBE_INTERVAL_MS, RATE_RETRY_MS, RETRY_BACKOFF_MS, MAX_AUTO_RETRIES, PROBE_PENDING_GRACE_MS,
  requestIntent, getIntent, findIntent, listIntents, cancelIntent, setFailed,
  scheduleFirstProbe, runDueProbes, onProbeFinished, evaluateIntentState, reconcileStuckIntents,
  view, comparableItems, deterministicDiff, promotionEligibility, tryPromote,
  startScheduler, stopScheduler,
};
