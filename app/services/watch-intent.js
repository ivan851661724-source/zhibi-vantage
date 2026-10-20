'use strict';
// ============================================================
// services/watch-intent.js —— 「加入监控」的监控意向（SC-07 §2）
// ------------------------------------------------------------
// PRD 01 §16：用户明确点击「加入监控」才进入**正式持续监控**；自动首轮采集
// 绝不能偷偷创建 WatchTarget。但当前实现对非 Shopify 品牌直接 400
// 「当前仅支持 Shopify」——把用户的意向丢掉了，且没有任何后续动作。
//
// 本模块把「意向」与「正式监控」分开：
//   intent.state:
//     establishing  已保存意向，正在建立可重复抓取的商品来源（不显示「监控中」）
//     source_failed 来源建立失败（拒访/限流/不可读），保留原因，不假装成功
//     promoted      已升级为正式 WatchTarget（intent 关闭，指向 targetId）
//     cancelled     用户退出，不再自动激活
//   正式监控仍只认 watch_targets.monitoring_status='active'（调度器只看那张表）。
//
// 升级（promote）的硬条件（缺一不可，代码里逐条校验）：
//   ① public_site_products 运行态 operational（发生过真实成功采集）
//   ② 至少两次成功 attempt 且都产出可比较商品观察（同商品标识 + 价格 + 币种）
//   ③ 两次观察之间能算出确定性 Diff（同键集合、同币种，逐品比较）
// 只有 ①②③ 都满足才创建 WatchTarget，且执行器必须真能跑该来源（见 watch-monitor）。
// 未满足时 intent 停在 establishing / source_failed —— 报告里写「非 Shopify
// 正式监控尚未接通」，不写「监控中」。
// ============================================================

const WS = require('./watch-store.js');
const SurfaceStore = require('./surface-store.js');
const Net = require('../research/net.js');

const INTENT_STATES = Object.freeze(['establishing', 'source_failed', 'promoted', 'cancelled']);

// 非 Shopify 商品来源可比较字段：商品标识（URL）+ 价格 + 币种
const SOURCE_CAPABILITY = 'public_site_products';

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

function view(intent) {
  if (!intent) return null;
  const v = Object.assign({}, intent);
  delete v.tenantId;
  v.stateText = STATE_TEXT[intent.state] || intent.state;
  // 重要：非 promoted 的意向不得对外表达「监控中 / 巡检成功 / 无变化」
  v.monitoring = intent.state === 'promoted';
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
    db.prepare(`UPDATE watch_intents SET state='establishing', reason_code=?, reason_text=?, brand_id=COALESCE(?, brand_id),
                enabled_signals=COALESCE(?, enabled_signals), updated_at=? WHERE intent_id=?`)
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
  WS.getDb().prepare("UPDATE watch_intents SET state='cancelled', updated_at=? WHERE intent_id=?").run(new Date().toISOString(), String(intentId));
  return getIntent(tenantId, intentId);
}

function setFailed(tenantId, intentId, reasonCode, reasonText) {
  ensureTable();
  WS.getDb().prepare("UPDATE watch_intents SET state='source_failed', reason_code=?, reason_text=?, updated_at=? WHERE tenant_id=? AND intent_id=? AND state='establishing'")
    .run(reasonCode || 'source_unavailable', reasonText || null, new Date().toISOString(), String(tenantId || ''), String(intentId || ''));
  return getIntent(tenantId, intentId);
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
function promotionEligibility(tenantId, projectId, competitorId) {
  const Readiness = require('./source-readiness.js');
  const rd = Readiness.getReadiness(SOURCE_CAPABILITY);
  const atts = (SurfaceStore.listAttempts(tenantId, projectId, competitorId, SOURCE_CAPABILITY, 10) || [])
    .filter(a => a && a.status === 'success');
  const withItems = atts.map(a => ({ attempt: a, items: comparableItems(a) })).filter(x => x.items.length > 0);
  const out = {
    readiness: rd.state,
    successfulAttempts: atts.length,
    comparableAttempts: withItems.length,
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
  // 非 Shopify 公开商品页只能核实「价格 + 商品标识」；发布时间无法佐证，
  // 因此只启用 price（上新仅作首次观察记录，不产已核实事件）
  const signals = Array.isArray(intent.enabledSignals) && intent.enabledSignals.length
    ? intent.enabledSignals.filter(s => s === 'price')
    : ['price'];
  if (!signals.length) signals.push('price');
  const r = WS.createWatchTarget({
    tenantId, projectId, competitorId,
    market: market || '',
    timezone: timezone || 'UTC',
    enabledSignals: signals,
    supportedSignals: ['price', 'launch'],
    enrichmentStatus: 'complete',
    // 非 Shopify 来源不落额外列：执行器按 comp.isShopify 分支（见 watch-monitor）
  });
  WS.getDb().prepare("UPDATE watch_intents SET state='promoted', promoted_target_id=?, reason_code='promoted', reason_text=?, updated_at=? WHERE tenant_id=? AND intent_id=?")
    .run(r.target.watchTargetId, '已完成两次可比较采集，升级为正式监控', new Date().toISOString(), String(tenantId), intent.intentId);
  return { promoted: true, target: r.target, intent: getIntent(tenantId, intent.intentId), eligibility: el };
}

module.exports = {
  INTENT_STATES, SOURCE_CAPABILITY, STATE_TEXT,
  requestIntent, getIntent, findIntent, listIntents, cancelIntent, setFailed,
  view, comparableItems, deterministicDiff, promotionEligibility, tryPromote,
};
