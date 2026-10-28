'use strict';
// ============================================================
// services/watch-intent.js —— 「加入监控」的监控意向（SC-07 §2 / SC-08 r2 §一）
// ------------------------------------------------------------
// PRD 01 §16：用户明确点击「加入监控」才进入**正式持续监控**；自动首轮采集
// 绝不能偷偷创建 WatchTarget。
//
// r2 整改核心：意向必须有**持久化的分阶段来源建立流程**，不允许永久停在 establishing，
// 也不允许「统计官网 attempt 却始终调度商品探测」这种调度与资格判定不同源的假闭环。
//   state:
//     establishing  已保存意向，正在建立可重复抓取的来源（不显示「监控中」）
//     source_failed 来源建立失败（拒访/限流/解析失败/无可核实字段），保留原因
//     promoted      已升级为正式 WatchTarget（intent 关闭，指向 targetId）
//     cancelled     用户退出，不再自动采集、不再自动晋升
//
// 分阶段流程（全部落库：next_probe_capability + probe_phase，服务重启后从库续跑）：
//   ① 用户点击 → requestIntent(source=public_site_products, phase=product_prime)
//      + scheduleFirstProbe（安排第一次商品探测）
//   ② 商品探测有稳定可比较价格 → 再安排**同一能力**的第二次独立探测（product_confirm）
//      → 两次同源可比观察 + 确定性 Diff → 建立 price 正式监控
//   ③ 商品探测没有可比价格（页面可访问但无稳定商品/价格）→ 切到官网来源：
//      next_probe_capability=official_site_profile, phase=site_prime（独立 attempt）
//   ④ 官网探测 1 成功且结构化字段稳定 → phase=site_confirm（第二次独立 attempt）
//   ⑤ 官网两次独立成功/部分成功且指纹稳定 → 建立 site_change 正式监控
//   ⑥ 官网也无法形成稳定指纹 → 有界重试后 source_failed（真实原因 + 可执行下一步）
// 硬约束：
//   · 每次探测都是**独立 attempt**（显式幂等键含 phase + 上一次 attempt + 时间桶）
//   · 重复点击 / 并发调度 / 重启不产生双任务（running attempt 复用 + 幂等键 + 看门狗）
//   · 一次商品探测 + 一次官网探测**不得**被拼成「两次同源观察」：
//     price 资格只数 public_site_products attempt；site_change 资格只数
//     official_site_profile attempt（promotionEligibility / siteChangeEligibility 各自独立重算）
//   · 取消后：调度器不扫 cancelled，onProbeFinished 对 cancelled 直接忽略，绝不晋升
// 终态分类：403/401 → blocked；429 → rate_limited（有界自动重试）；解析失败 → parse_failed；
//   成功但无可核实字段 → no_comparable_products / insufficient_structured_fields
// 正式监控（晋升后）只支持 price 或 site_change：不宣称上新/库存（公开页面无可核验字段）。
//
// 调度器仍只认 watch_targets.monitoring_status='active'（正式监控唯一资格边界）。
// ============================================================

const WS = require('./watch-store.js');
const SurfaceStore = require('./surface-store.js');

const INTENT_STATES = Object.freeze(['establishing', 'source_failed', 'promoted', 'cancelled']);

// 两个可建立的真实来源能力（都必须是 Registry 里的真实能力，不得虚构）
const CAP_PRODUCTS = 'public_site_products';
const CAP_SITE = 'official_site_profile';
const PROBE_CAPABILITIES = Object.freeze([CAP_PRODUCTS, CAP_SITE]);
// 兼容旧常量（既有调用方/测试引用）
const SOURCE_CAPABILITY = CAP_PRODUCTS;

// 阶段词表（持久化到 watch_intents.probe_phase）
//   product_prime   第一次商品探测（建立价格基线）
//   product_confirm 第二次商品探测（独立复采 → 可比较 → price）
//   site_prime      第一次官网探测（建立结构化指纹基线）
//   site_confirm    第二次官网探测（独立复采 → 指纹稳定 → site_change）
const PROBE_PHASES = Object.freeze([ 'product_prime', 'product_confirm', 'site_prime', 'site_confirm' ]);
const PHASE_TEXT = Object.freeze({
  product_prime: '正在检查官网公开商品页（第 1 次）',
  product_confirm: '正在复采官网公开商品页（第 2 次，用于建立价格基线）',
  site_prime: '正在读取官网公开资料（第 1 次）',
  site_confirm: '正在复采官网公开资料（第 2 次，用于建立官网变化基线）',
});

// ---- 有界探测参数（env 可覆盖；全部有上界，防无限重试/无限计费） ----
// 两次独立探测的最小间隔（第一次成功后到下一次探测）：默认 60 分钟
const PROBE_INTERVAL_MS = Math.max(1000, Number(process.env.ZB_INTENT_PROBE_INTERVAL_MS) || 60 * 60 * 1000);
// 限流后的自动重试等待（带有界）：默认 30 分钟
const RATE_RETRY_MS = Math.max(1000, Number(process.env.ZB_INTENT_RATE_RETRY_MS) || 30 * 60 * 1000);
// 暂时性失败（超时/不可达）的退避：默认 10 分钟
const RETRY_BACKOFF_MS = Math.max(1000, Number(process.env.ZB_INTENT_RETRY_BACKOFF_MS) || 10 * 60 * 1000);
// 自动重试上限（限流 + 暂时性失败 + 不稳定指纹合并计数；超过后等待用户重试）
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
  // 加法迁移（老库补列；只加列，不改既有列）
  const addCol = (ddl) => { try { db.exec(ddl); } catch (e) { /* 列已存在 */ } };
  addCol('ALTER TABLE watch_intents ADD COLUMN next_probe_at TEXT');
  addCol('ALTER TABLE watch_intents ADD COLUMN probe_count INTEGER NOT NULL DEFAULT 0');
  addCol('ALTER TABLE watch_intents ADD COLUMN auto_retries INTEGER NOT NULL DEFAULT 0');
  addCol('ALTER TABLE watch_intents ADD COLUMN last_probe_attempt_id TEXT');
  // SC-08 r2 §一：分阶段来源建立的持久化调度字段（重启后按库内能力续跑）
  addCol('ALTER TABLE watch_intents ADD COLUMN next_probe_capability TEXT');
  addCol('ALTER TABLE watch_intents ADD COLUMN probe_phase TEXT');
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
    // 持久化建立流程
    nextProbeAt: r.next_probe_at || null,
    probeCount: r.probe_count || 0,
    autoRetries: r.auto_retries || 0,
    lastProbeAttemptId: r.last_probe_attempt_id || null,
    // SC-08 r2 §一：下一步要调度的真实能力 + 阶段
    nextProbeCapability: r.next_probe_capability || CAP_PRODUCTS,
    probePhase: r.probe_phase || 'product_prime',
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

// r3 §一：source_failed 不能一律叫「来源建立失败」——官网明明可访问、
// 只是没有可比较价格时，那句话是错的。按原因给准确说法（仍是失败态，不改领域终态）。
const FAILED_STATE_TEXT = Object.freeze({
  no_comparable_products: '官网可访问，尚未建立可监控基线',
  insufficient_structured_fields: '官网可访问，页面结构不足以建立基线',
  blocked: '来源拒绝访问',
  rate_limited: '来源暂时限制访问',
  no_official_url: '缺少可核验官网',
  competitor_missing: '品牌已移出项目',
  source_unavailable: '来源暂时不可访问',
  parse_failed: '页面内容暂时无法解析',
});

function fmtAt(iso) { return String(iso).slice(0, 16).replace('T', ' '); }

// 明确下一步（§一.8：禁止无后续任务的永久 establishing；失败必须给可执行下一步）
function nextStepText(intent) {
  if (!intent) return null;
  if (intent.state === 'establishing') {
    if (intent.nextProbeAt) {
      return new Date(intent.nextProbeAt).getTime() <= Date.now()
        ? PHASE_TEXT[intent.probePhase] || '正在安排下一次来源探测'
        : '已安排下一次来源探测（' + fmtAt(intent.nextProbeAt) + '）：' + (PHASE_TEXT[intent.probePhase] || '来源探测');
    }
    return '正在等待当前采集结果';
  }
  if (intent.state === 'source_failed') {
    if (intent.reasonCode === 'rate_limited' && intent.nextProbeAt) {
      return '来源限流，将在 ' + fmtAt(intent.nextProbeAt) + ' 自动重试';
    }
    // 失败原因 + 可执行下一步（按原因给不同动作，不写「请稍后再试」这种空话）
    const byReason = {
      blocked: '官网拒绝了公开页面访问。可确认该品牌官网地址可正常打开后，重新点击「加入监控」。',
      parse_failed: '页面无法解析出可核实内容。可确认该官网是否为常规公开页面后，重新点击「加入监控」。',
      insufficient_structured_fields: '官网缺少稳定的结构化字段（标题/规范地址/组织信息/商品集合），无法建立可核实的变化基线。可补充更稳定的官网页（如品牌首页）后重新加入监控。',
      no_comparable_products: '官网可访问，但没有可核实的稳定字段（价格或结构化内容）。可补充商品页地址后重新加入监控。',
      no_official_url: '该品牌没有可核验的官网地址。请在品牌档案中补充官网后重新加入监控。',
      competitor_missing: '该品牌已不在当前项目中；重新在竞品雷达加入后再建立监控。',
      source_unavailable: '来源多次不可达。可在官网可正常打开时重新点击「加入监控」。',
    };
    return byReason[intent.reasonCode] || '等待你重试：可重新点击「加入监控」再试一次';
  }
  return null;
}

function view(intent) {
  if (!intent) return null;
  const v = Object.assign({}, intent);
  delete v.tenantId;
  v.stateText = intent.state === 'source_failed'
    ? (FAILED_STATE_TEXT[intent.reasonCode] || STATE_TEXT.source_failed)
    : (STATE_TEXT[intent.state] || intent.state);
  // 重要：非 promoted 的意向不得对外表达「监控中 / 巡检成功 / 无变化」
  v.monitoring = intent.state === 'promoted';
  v.nextStepText = nextStepText(intent);
  v.probePhaseText = PHASE_TEXT[intent.probePhase] || null;
  // 不向前端暴露内部能力码：只暴露阶段与下一步的人话
  delete v.nextProbeCapability;
  delete v.probePhase;
  return v;
}

// 幂等：同 tenant×project×competitor 只有一条；退出后（cancelled）再次加入会重新置 establishing
// 重新加入 = 从第一阶段重来（商品探测），但不删除既有 attempt 历史与时间线。
function requestIntent({ tenantId, projectId, competitorId, brandId, reasonCode, reasonText, signals }) {
  ensureTable();
  const tid = String(tenantId || ''); const pid = String(projectId || ''); const cid = String(competitorId || '');
  if (!tid || !pid || !cid) return { error: 'MISSING_CONTEXT' };
  const db = WS.getDb();
  const now = new Date().toISOString();
  const existed = db.prepare('SELECT * FROM watch_intents WHERE tenant_id=? AND project_id=? AND competitor_id=?').get(tid, pid, cid);
  if (existed) {
    if (existed.state === 'promoted') return { intent: rowToIntent(existed), existed: true, promoted: true };
    if (existed.state === 'establishing') {
      // SC-08 r3 §一：重复点击不得重置来源建立进度。capability/phase/nextProbeAt/
      // lastProbeAttemptId/重试计数全部保持原样，不重新建立任务；调用方（handler）
      // 据此跳过 scheduleFirstProbe / planForCompetitor，保证只有一条意向一个在途任务。
      return { intent: rowToIntent(existed), existed: true, establishing: true };
    }
    // source_failed / cancelled：用户**明确重新点击**才重新建立。
    // r3 §二：若该品牌已有官网成功采集（降级链的中间进度），从官网续跑而不是从商品页归零——
    // 「重复点击不得重置已有进度」。
    const prevReason = String(existed.reason_code || '');
    let resumeFromSite = false;
    let siteTries = 0;
    if (existed.state === 'source_failed' && (prevReason === 'no_comparable_products' || prevReason === 'insufficient_structured_fields')) {
      const sc = siteChangeEligibility(tid, pid, cid);
      siteTries = sc.attempts || 0;
      resumeFromSite = siteTries >= 1;
    }
    const nextCap = resumeFromSite ? CAP_SITE : CAP_PRODUCTS;
    const nextPhase = resumeFromSite ? 'site_confirm' : 'product_prime';
    db.prepare(`UPDATE watch_intents SET state='establishing', reason_code=?, reason_text=?, brand_id=COALESCE(?, brand_id),
                enabled_signals=COALESCE(?, enabled_signals), auto_retries=0, probe_count=?,
                next_probe_at=NULL, next_probe_capability=?, probe_phase=?,
                last_probe_attempt_id=NULL, updated_at=? WHERE intent_id=?`)
      .run(reasonCode || null, reasonText || null, brandId || null, signals ? JSON.stringify(signals) : null,
        resumeFromSite ? siteTries : 0, nextCap, nextPhase,
        now, existed.intent_id);
    return {
      intent: rowToIntent(db.prepare('SELECT * FROM watch_intents WHERE intent_id=?').get(existed.intent_id)),
      existed: true, reactivated: existed.state === 'cancelled', restarted: existed.state === 'source_failed',
      resumedFromSite: resumeFromSite,
    };
  }
  const id = rid('wi');
  try {
    db.prepare(`INSERT INTO watch_intents
      (intent_id, tenant_id, project_id, competitor_id, brand_id, state, reason_code, reason_text, source_capability,
       enabled_signals, next_probe_capability, probe_phase, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, tid, pid, cid, brandId || null, 'establishing', reasonCode || null, reasonText || null,
      CAP_PRODUCTS, signals ? JSON.stringify(signals) : JSON.stringify(['price']),
      CAP_PRODUCTS, 'product_prime', now, now,
    );
  } catch (e) {
    // SC-08 r3 §一：并发重复请求只能保留一条意向（UNIQUE 冲突 → 返回赢家的那一条，
    // 按与其状态一致的语义分支返回；绝不插入第二条）
    const winner = db.prepare('SELECT * FROM watch_intents WHERE tenant_id=? AND project_id=? AND competitor_id=?').get(tid, pid, cid);
    if (!winner) throw e;
    if (winner.state === 'promoted') return { intent: rowToIntent(winner), existed: true, promoted: true };
    if (winner.state === 'establishing') return { intent: rowToIntent(winner), existed: true, establishing: true };
    return { intent: rowToIntent(winner), existed: true };
  }
  return { intent: rowToIntent(db.prepare('SELECT * FROM watch_intents WHERE intent_id=?').get(id)), existed: false };
}

/**
 * r3 §二：把「官网可访问但停在 source_failed」的意向续跑回 establishing。
 * 只接受 no_comparable_products / insufficient_structured_fields 且已有官网成功采集；
 * 保留 probeCount / 已产生的 attempt（资格由库里真实 attempt 重算，不重置进度）。
 * 幂等：已 establishing/promoted 一律不动。
 * @returns {{resumed:boolean, reason?:string, nextProbeAt?:string}}
 */
function resumeSiteProbe(tenantId, projectId, competitorId) {
  ensureTable();
  const tid = String(tenantId || ''); const pid = String(projectId || ''); const cid = String(competitorId || '');
  const intent = findIntent(tid, pid, cid);
  if (!intent) return { resumed: false, reason: 'no_intent' };
  if (intent.state === 'promoted') return { resumed: false, reason: 'already_promoted' };
  if (intent.state === 'establishing') return { resumed: false, reason: 'already_establishing' };
  const reason = String(intent.reasonCode || '');
  if (reason !== 'no_comparable_products' && reason !== 'insufficient_structured_fields') {
    return { resumed: false, reason: 'not_resumable:' + (reason || 'unknown') };
  }
  const sc = siteChangeEligibility(tid, pid, cid);
  if (!sc.attempts) return { resumed: false, reason: 'no_site_attempt' };
  const now = new Date().toISOString();
  setProbeStep(intent.intentId, Object.assign(schedule(CAP_SITE, sc.attempts >= 2 ? 'site_confirm' : 'site_confirm', Date.now()), {
    state: 'establishing', probeCount: sc.attempts, autoRetries: 0,
  }));
  WS.getDb().prepare('UPDATE watch_intents SET reason_code=?, reason_text=?, updated_at=? WHERE intent_id=?')
    .run('resumed_site_probe', '官网可访问，继续建立官网内容监控基线', now, intent.intentId);
  return { resumed: true, siteAttempts: sc.attempts, nextProbeAt: new Date().toISOString() };
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
  // 取消后不得继续采集或自动晋升——清空下一次探测时间与下一步能力；
  // 调度器只扫 establishing/source_failed，onProbeFinished 对 cancelled 一律忽略。
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

// ---------- 持久化探测调度 ----------

// 用户点击后安排第一次探测（立即；幂等：已有计划不覆盖）
function scheduleFirstProbe({ tenantId, projectId, competitorId }) {
  ensureTable();
  const intent = findIntent(tenantId, projectId, competitorId);
  if (!intent) return null;
  if (intent.state !== 'establishing') return intent;
  if (intent.nextProbeAt) return intent; // 已有计划（重复点击不覆盖）
  WS.getDb().prepare("UPDATE watch_intents SET next_probe_at=?, next_probe_capability=COALESCE(next_probe_capability,?), probe_phase=COALESCE(probe_phase,'product_prime'), updated_at=? WHERE intent_id=?")
    .run(new Date().toISOString(), CAP_PRODUCTS, new Date().toISOString(), intent.intentId);
  return getIntent(tenantId, intent.intentId);
}

// 内部：设置探测计划与计数（只对显式给出的字段赋值；capability/phase 走 setProbeStep）
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

// 内部：推进到下一阶段（能力 + 阶段 + 下次时间 + 计数，一次原子写）
// 字段语义：只写显式出现的字段。
//   nextProbeAt: null = 清空（终态，等用户重试）；不传 = 保持原值。
function setProbeStep(intentId, step) {
  ensureTable();
  const s = step || {};
  const sets = [];
  const vals = [];
  if (PROBE_CAPABILITIES.includes(s.capability)) { sets.push('next_probe_capability=?'); vals.push(s.capability); }
  if (PROBE_PHASES.includes(s.phase)) { sets.push('probe_phase=?'); vals.push(s.phase); }
  if (Object.prototype.hasOwnProperty.call(s, 'nextProbeAt')) { sets.push('next_probe_at=?'); vals.push(s.nextProbeAt); }
  if (s.probeCount != null) { sets.push('probe_count=?'); vals.push(s.probeCount); }
  if (s.autoRetries != null) { sets.push('auto_retries=?'); vals.push(s.autoRetries); }
  if (s.lastProbeAttemptId) { sets.push('last_probe_attempt_id=?'); vals.push(s.lastProbeAttemptId); }
  if (s.state) { sets.push('state=?'); vals.push(s.state); }
  if (!sets.length) return getIntentByRawId(intentId);
  sets.push('updated_at=?'); vals.push(new Date().toISOString());
  vals.push(String(intentId));
  WS.getDb().prepare(`UPDATE watch_intents SET ${sets.join(', ')} WHERE intent_id=?`).run(...vals);
  return getIntentByRawId(intentId);
}

function getIntentByRawId(intentId) {
  const r = WS.getDb().prepare('SELECT * FROM watch_intents WHERE intent_id=?').get(String(intentId));
  return rowToIntent(r);
}

// ---------- 可比较性判定（price 升级的硬条件） ----------
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

// 升级资格（price 路径）：**只数 public_site_products** 的真实成功 attempt ≥2，
// 同商品标识 + 价格 + 币种且可算确定性 Diff。success/partial 均可计入（partial 的已观察
// 商品价格是真实可比较的），但必须带可比较商品。
function promotionEligibility(tenantId, projectId, competitorId) {
  const Readiness = require('./source-readiness.js');
  const rd = Readiness.getReadiness(CAP_PRODUCTS);
  const atts = (SurfaceStore.listAttempts(tenantId, projectId, competitorId, CAP_PRODUCTS, 10) || [])
    .filter(a => a && (a.status === 'success' || a.status === 'partial'));
  const withItems = atts.map(a => ({ attempt: a, items: comparableItems(a) })).filter(x => x.items.length > 0);
  const out = {
    readiness: rd.state,
    successfulAttempts: atts.length,
    comparableAttempts: withItems.length,
    partialAttempts: atts.filter(a => a.status === 'partial').length,
    eligible: false, reason: null, diff: null,
  };
  // 同时评估降级信号 site_change（官网可访问但无稳定价格时的正式信号）——独立口径，不交叉计数
  out.siteChange = siteChangeEligibility(tenantId, projectId, competitorId);
  if (rd.state !== 'operational') { out.reason = 'source_not_verified'; return out; }
  if (withItems.length < 2) {
    out.reason = 'need_two_comparable_collections';
    return out;
  }
  const diff = deterministicDiff(withItems[1].items, withItems[0].items);
  out.diff = diff;
  if (!diff.comparable) {
    out.reason = 'diff_not_computable:' + diff.reason;
    return out;
  }
  out.eligible = true;
  return out;
}

/**
 * site_change 晋升资格（SC-08 §三 C）：
 *   **只数 official_site_profile** 的独立真实采集：至少两次成功/部分成功，
 *   且最新一次的结构化指纹稳定（≥2 类结构化字段：title/canonical/organization/商品集合/结构摘要）。
 *   不要求「已有变化」——首次 baseline 本身就是可监控的稳定来源。
 *   商品探测的 attempt 不得计入本口径（禁止把一次商品探测 + 一次官网探测拼成两次同源观察）。
 */
function siteChangeEligibility(tenantId, projectId, competitorId) {
  const out = { eligible: false, attempts: 0, stable: false, signals: [], reason: null, sourceUrl: null, attemptIds: [] };
  try {
    const atts = (SurfaceStore.listAttempts(tenantId, projectId, competitorId, CAP_SITE, 10) || [])
      .filter(a => a && (a.status === 'success' || a.status === 'partial'));
    out.attempts = atts.length;
    out.attemptIds = atts.map(a => a.attemptId);
    if (atts.length < 2) { out.reason = 'need_two_site_collections'; return out; }
    const Snapshot = require('../research/source-snapshot.js');
    const FP = require('./site-fingerprint.js');
    // 用最新一次成功的页面重建指纹（不得用替身/猜测：拿不到原文就如实不达标准）
    let fp = null, url = null;
    for (const sid of (atts[0].snapshotIds || [])) {
      const meta = Snapshot.getById(tenantId, sid);
      if (!meta) continue;
      let raw = null;
      try { raw = Snapshot.readRawPayload(meta); } catch (e) { raw = null; }
      if (!raw) continue;
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      if (!/<html|<body|<title/i.test(text)) continue;
      fp = FP.buildFingerprint(text, meta.source_url || meta.final_url || '');
      url = meta.source_url || meta.final_url || null;
      break;
    }
    if (!fp) { out.reason = 'fingerprint_unavailable'; return out; }
    const st = FP.stabilityOf(fp);
    out.stable = !!st.stable;
    out.signals = st.signals || [];
    out.sourceUrl = url;
    if (!st.stable) { out.reason = 'insufficient_structured_fields'; return out; }
    out.eligible = true;
    return out;
  } catch (e) {
    out.reason = 'site_change_eval_failed';
    return out;
  }
}

/**
 * 可信升级依据（§二：只有真实采集资格验证通过后才能增加支持信号）。
 * 由本模块从库里真实 attempt 派生，不接受调用方自报字段。
 * @returns {{ok:boolean, reason?:string, capability?:string, attemptIds?:string[], evaluatedAt?:string, detail?:object}}
 */
function buildVerifiedBasis(tenantId, projectId, competitorId, signal) {
  const sig = String(signal || '');
  const stamp = { issuedBy: 'watch-intent/buildVerifiedBasis', competitorId: String(competitorId || ''), projectId: String(projectId || '') };
  if (sig === 'price') {
    const el = promotionEligibility(tenantId, projectId, competitorId);
    if (!el.eligible) return Object.assign({ ok: false, reason: el.reason || 'price_not_verified', detail: el }, stamp);
    const atts = (SurfaceStore.listAttempts(tenantId, projectId, competitorId, CAP_PRODUCTS, 10) || [])
      .filter(a => a && (a.status === 'success' || a.status === 'partial'))
      .map(a => a.attemptId);
    return Object.assign({
      ok: true, capability: CAP_PRODUCTS, signal: 'price', attemptIds: atts, evaluatedAt: new Date().toISOString(),
      detail: { comparableAttempts: el.comparableAttempts, compared: el.diff ? el.diff.compared : 0 },
    }, stamp);
  }
  if (sig === 'site_change') {
    const sc = siteChangeEligibility(tenantId, projectId, competitorId);
    if (!sc.eligible) return Object.assign({ ok: false, reason: sc.reason || 'site_change_not_verified', detail: sc }, stamp);
    return Object.assign({
      ok: true, capability: CAP_SITE, signal: 'site_change', attemptIds: sc.attemptIds, evaluatedAt: new Date().toISOString(),
      detail: { attempts: sc.attempts, signals: sc.signals },
    }, stamp);
  }
  return Object.assign({ ok: false, reason: 'UNKNOWN_SIGNAL' }, stamp);
}

/**
 * 受控能力升级：site_change → price（SC-08 r2 §二）。
 * 触发时机 = 该品牌刚完成一次真实商品来源探测（价格资格可能刚刚满足）。
 * 只对「已正式监控且当前只支持 site_change」的 Target 生效；资格由库里真实 attempt
 * 派生（buildVerifiedBasis），验证不通过一律不动——绝不因为「看起来有价格」就自封能力。
 * 幂等：重复调用无变化时不写库。
 */
function tryUpgradeTargetToPrice({ tenantId, projectId, competitorId }) {
  const tid = String(tenantId || ''); const pid = String(projectId || ''); const cid = String(competitorId || '');
  if (!tid || !pid || !cid) return { upgraded: false, reason: 'MISSING_CONTEXT' };
  const target = (WS.listWatchTargets(tid, pid) || []).find(t => t.competitorId === cid);
  if (!target) return { upgraded: false, reason: 'no_target' };
  const supported = target.supportedSignals || [];
  if (!supported.includes('site_change')) return { upgraded: false, reason: 'not_site_change_target' };
  if (supported.includes('price')) return { upgraded: false, reason: 'already_supported', target };
  const basis = buildVerifiedBasis(tid, pid, cid, 'price');
  if (!basis.ok) return { upgraded: false, reason: basis.reason || 'price_not_verified', target };
  const r = WS.upgradeWatchTargetCapabilities({
    tenantId: tid, watchTargetId: target.watchTargetId,
    addSupportedSignals: ['price'], enabledSignals: ['price'], verifiedBasis: basis,
  });
  if (r && r.error) return { upgraded: false, reason: r.error, target };
  return { upgraded: !!(r && r.upgraded), unchanged: !!(r && r.unchanged), target: r ? r.target : null, basis };
}

/**
 * 从库里重算意向状态并决定下一步（幂等；成功路径唯一入口）。
 * - 已可晋升（price / site_change）→ tryPromote；
 * - 当前阶段还差一次同源独立观察 → 持久化下一次探测（能力与阶段都不变）；
 * - 其他 → 交由失败分支处理（本函数不动）。
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
    // 至少一次可比较成功：同一能力的下一次独立探测（重启后调度器照常执行）
    const nextAt = new Date(Date.now() + PROBE_INTERVAL_MS).toISOString();
    setProbeStep(intent.intentId, {
      capability: CAP_PRODUCTS, phase: 'product_confirm', nextProbeAt: nextAt,
      probeCount: el.comparableAttempts, state: 'establishing',
    });
    return { action: 'scheduled_next_probe', probeCount: el.comparableAttempts, nextProbeAt: nextAt, eligibility: el };
  }
  return { action: 'no_comparable_success', eligibility: el };
}

/**
 * 用最新一次真实官网采集的快照建立 site_change 基线（晋升时调用）。
 * 语义：晋升依据就是这两次独立观察，基线应当是「最后一次观察」而不是「第一个监控窗口」——
 * 否则晋升到首个窗口之间的变化会被吞掉（首窗口只会重建基线）。
 * 拿不到原文快照时如实不建（首个监控窗口会重建基线，不猜测）。
 */
function seedSiteBaselineFromLatestAttempt(tenantId, projectId, competitorId) {
  try {
    const atts = (SurfaceStore.listAttempts(tenantId, projectId, competitorId, CAP_SITE, 10) || [])
      .filter(a => a && (a.status === 'success' || a.status === 'partial'));
    if (!atts.length) return null;
    const Snapshot = require('../research/source-snapshot.js');
    const FP = require('./site-fingerprint.js');
    for (const sid of (atts[0].snapshotIds || [])) {
      const meta = Snapshot.getById(tenantId, sid);
      if (!meta) continue;
      let raw = null;
      try { raw = Snapshot.readRawPayload(meta); } catch (e) { raw = null; }
      if (!raw) continue;
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      if (!/<html|<body|<title/i.test(text)) continue;
      const url = meta.source_url || meta.final_url || null;
      return WS.saveSiteBaseline({
        tenantId, projectId, competitorId,
        fingerprint: FP.buildFingerprint(text, url || ''),
        stability: FP.stabilityOf(FP.buildFingerprint(text, url || '')),
        url, at: atts[0].endedAt || new Date().toISOString(),
      });
    }
  } catch (e) { /* 基线建立失败不影响晋升（首窗口重建） */ }
  return null;
}

/**
 * 尝试把意向升级为正式监控（幂等；不满足条件则保持 establishing/failed）。
 * 价格路径优先；无稳定可比较价格但官网结构化字段稳定 → 降级为 site_change。
 */
function tryPromote({ tenantId, projectId, competitorId, timezone, market }) {
  ensureTable();
  const intent = findIntent(tenantId, projectId, competitorId);
  if (!intent || intent.state !== 'establishing') return { promoted: false, reason: 'no_open_intent' };
  const el = promotionEligibility(tenantId, projectId, competitorId);
  const useSiteChange = !el.eligible && el.siteChange && el.siteChange.eligible;
  if (!el.eligible && !useSiteChange) {
    return { promoted: false, reason: el.reason || (el.siteChange && el.siteChange.reason) || null, eligibility: el };
  }
  // 非 Shopify：supportedSignals 只能是真实可核实的信号——
  //   price（同商品同币种确定性涨跌）或 site_change（稳定结构化字段变化）；
  // 绝不宣称上新/库存（无发布时间与库存字段可核验）。
  const signals = useSiteChange ? ['site_change'] : ['price'];
  const r = WS.createWatchTarget({
    tenantId, projectId, competitorId,
    market: market || '',
    timezone: timezone || 'UTC',
    enabledSignals: signals,
    supportedSignals: signals,
    enrichmentStatus: 'complete',
    // 非 Shopify 来源不落额外列：执行器按 comp.isShopify 分支（见 watch-monitor）
  });
  // site_change：把「最后一次被验证的观察」落成监控基线（否则晋升到首窗口之间的
  // 变化会被首窗口的基线重建吞掉）；拿不到原文快照时如实不建。
  if (useSiteChange) seedSiteBaselineFromLatestAttempt(tenantId, projectId, competitorId);
  const reasonText = useSiteChange
    ? '已建立可重复的官网内容来源（两次独立采集，结构化字段稳定），升级为正式监控（当前信号：官网内容变化）'
    : '已完成两次可比较采集，升级为正式监控（当前支持价格信号）';
  WS.getDb().prepare("UPDATE watch_intents SET state='promoted', promoted_target_id=?, reason_code='promoted', reason_text=?, next_probe_at=NULL, updated_at=? WHERE tenant_id=? AND intent_id=?")
    .run(r.target.watchTargetId, reasonText, new Date().toISOString(), String(tenantId), intent.intentId);
  return { promoted: true, target: r.target, intent: getIntent(tenantId, intent.intentId), eligibility: el };
}

// ---------- 采集完成后的意向推进（collect-jobs worker 调用） ----------
// 只有本意向当前阶段对应的那个能力完成的 attempt 才能推进阶段（防止无关采集改写状态）。
// cancelled / promoted 的意向一律忽略（取消后不得继续采集或自动晋升）。

const FAIL_TEXT = Object.freeze({
  blocked: '来源站点拒绝了公开页面访问（403/401），无法建立监控来源。',
  parse_failed: '来源页面无法解析出可核实内容，无法建立监控来源。',
  rate_limited: '来源限流，稍后自动重试；无需你操作。',
  fetch_failed: '来源暂时不可达，将自动重试。',
});

function schedule(capability, phase, atMs) {
  return { capability, phase, nextProbeAt: new Date(atMs).toISOString() };
}

function onProbeFinished({ tenantId, projectId, competitorId, attempt }) {
  ensureTable();
  const tid = String(tenantId || ''); const pid = String(projectId || ''); const cid = String(competitorId || '');
  const intent = findIntent(tid, pid, cid);
  if (!intent) return { action: 'no_intent' };
  if (intent.state === 'cancelled') return { action: 'ignored_cancelled' };
  if (intent.state === 'promoted') return { action: 'ignored_promoted' };
  const att = attempt || (intent.lastProbeAttemptId ? SurfaceStore.getAttempt(tid, intent.lastProbeAttemptId) : null);
  if (!att) return { action: 'no_attempt' };
  if (att.status === 'running') return { action: 'still_running' };

  // 阶段对应能力：只接受「当前计划能力」的终态 attempt；旧阶段迟到的结果不得改写流程
  //（例外：没有任何计划能力时（老库）按 attempt 自身能力处理）
  const planned = intent.nextProbeCapability || CAP_PRODUCTS;
  const attCap = att.capability || planned;
  if (attCap !== planned) {
    return { action: 'ignored_stale_capability:' + attCap + '!=' + planned };
  }

  if (attCap === CAP_SITE) return handleSiteProbe(tid, pid, cid, intent, att);
  return handleProductProbe(tid, pid, cid, intent, att);
}

// 商品探测结果 → price 路径 / 切官网降级路径
function handleProductProbe(tid, pid, cid, intent, att) {
  const status = att.status;
  const lpa = att.attemptId;
  if (status === 'success' || status === 'partial') {
    const items = comparableItems(att);
    if (items.length) {
      const el = promotionEligibility(tid, pid, cid);
      if (el.eligible) {
        setProbeStep(intent.intentId, { lastProbeAttemptId: lpa });
        const p = tryPromote({ tenantId: tid, projectId: pid, competitorId: cid });
        return { action: p.promoted ? 'promoted' : 'promote_failed:' + (p.reason || ''), eligibility: p.eligibility, signal: 'price' };
      }
      // 只有一次可比较观察 / Diff 不可算：同一能力的第二次独立探测（不混入官网探测）
      const nextAt = Date.now() + PROBE_INTERVAL_MS;
      setProbeStep(intent.intentId, Object.assign(schedule(CAP_PRODUCTS, 'product_confirm', nextAt), {
        lastProbeAttemptId: lpa, probeCount: el.comparableAttempts, state: 'establishing',
      }));
      return { action: 'awaiting_second_product_collection', nextProbeAt: new Date(nextAt).toISOString(), eligibility: el };
    }
    // 商品路径没有可比价格 → 切官网来源（独立能力的独立 attempt）
    return switchToSite(tid, pid, cid, intent, att, 'no_comparable_products_on_site_products');
  }
  // 失败分类（§三 D：真实失败必须落到「官网也不可达/拒访/解析连续失败」之后）：
  //   · 429 限流 → 同一能力有界重试（不换来源，换来源等于把限流当"没有价格"）
  //   · 其它失败 → 若官网来源尚未尝试，先切官网（商品页可能无 JSON-LD/被拒，但官网首页可读）；
  //     切换消耗一次重试额度，超过上限即真实失败（不等用户无限等）
  const cls = String(att.sourceStatus || att.errorClass || 'unavailable');
  const phase = intent.probePhase || 'product_prime';
  if (cls === 'rate_limited') return failOrRetry(tid, pid, cid, intent, att, CAP_PRODUCTS, phase);
  const retries = (intent.autoRetries || 0) + 1;
  if (retries > MAX_AUTO_RETRIES) {
    setFailed(tid, intent.intentId, 'source_unavailable', '来源多次不可用，已暂停自动重试；可稍后重新加入监控。');
    setProbeStep(intent.intentId, { nextProbeAt: null, lastProbeAttemptId: att.attemptId });
    return { action: 'source_failed:' + cls + '_exhausted' };
  }
  const sc = siteChangeEligibility(tid, pid, cid);
  if (sc.attempts === 0) {
    return switchToSite(tid, pid, cid, intent, att, 'product_probe_' + cls, { autoRetries: retries });
  }
  return failOrRetry(tid, pid, cid, intent, att, CAP_PRODUCTS, phase);
}

// 切到官网来源建立（第一次官网探测立即到期）
function switchToSite(tid, pid, cid, intent, att, why, opts) {
  const nextAt = Date.now();
  const o = opts || {};
  setProbeStep(intent.intentId, Object.assign(schedule(CAP_SITE, 'site_prime', nextAt), {
    lastProbeAttemptId: att ? att.attemptId : null,
    autoRetries: o.autoRetries == null ? null : o.autoRetries,
    state: 'establishing',
  }));
  return { action: 'switched_to_site_source', reason: why, nextProbeAt: new Date(nextAt).toISOString(), nextCapability: CAP_SITE };
}

// 官网探测结果 → site_change 路径
function handleSiteProbe(tid, pid, cid, intent, att) {
  const lpa = att.attemptId;
  if (att.status === 'success' || att.status === 'partial') {
    const sc = siteChangeEligibility(tid, pid, cid);
    if (sc.eligible) {
      setProbeStep(intent.intentId, { lastProbeAttemptId: lpa });
      const p = tryPromote({ tenantId: tid, projectId: pid, competitorId: cid });
      return { action: p.promoted ? 'promoted' : 'promote_failed:' + (p.reason || ''), eligibility: p.eligibility, signal: 'site_change' };
    }
    if (sc.attempts < 2 && sc.reason === 'need_two_site_collections') {
      const nextAt = Date.now() + PROBE_INTERVAL_MS;
      setProbeStep(intent.intentId, Object.assign(schedule(CAP_SITE, 'site_confirm', nextAt), {
        lastProbeAttemptId: lpa, probeCount: sc.attempts, state: 'establishing',
      }));
      return { action: 'awaiting_second_site_collection', nextProbeAt: new Date(nextAt).toISOString(), siteChange: sc };
    }
    // 两次都读到页面但结构化字段不足 → 有界重试，仍不足则真实失败（§三 D）
    if (sc.reason === 'insufficient_structured_fields' || sc.reason === 'fingerprint_unavailable') {
      const retries = (intent.autoRetries || 0) + 1;
      if (retries <= MAX_AUTO_RETRIES) {
        const nextAt = Date.now() + RETRY_BACKOFF_MS;
        setProbeStep(intent.intentId, Object.assign(schedule(CAP_SITE, 'site_confirm', nextAt), {
          lastProbeAttemptId: lpa, autoRetries: retries, probeCount: sc.attempts, state: 'establishing',
        }));
        return { action: 'retry_scheduled:insufficient_structured_fields', retryAt: new Date(nextAt).toISOString() };
      }
      setFailed(tid, intent.intentId, 'insufficient_structured_fields',
        '官网页面可以访问，但缺少稳定的结构化字段（标题/规范地址/组织信息/商品集合），无法建立可核实的变化基线。');
      setProbeStep(intent.intentId, { nextProbeAt: null, lastProbeAttemptId: lpa });
      return { action: 'source_failed:insufficient_structured_fields' };
    }
    // 其他（如 site_change_eval_failed）→ 按暂时性失败处理
    return failOrRetry(tid, pid, cid, intent, att, CAP_SITE, 'site_confirm');
  }
  return failOrRetry(tid, pid, cid, intent, att, CAP_SITE, intent.probePhase || 'site_prime');
}

// 失败分类（对指定能力重试；超过上限 → source_failed + 可执行下一步）
function failOrRetry(tid, pid, cid, intent, att, capability, phase) {
  const lpa = att.attemptId;
  const cls = String(att.sourceStatus || att.errorClass || 'unavailable');
  if (cls === 'blocked') {
    setFailed(tid, intent.intentId, 'blocked', FAIL_TEXT.blocked);
    setProbeStep(intent.intentId, { nextProbeAt: null, lastProbeAttemptId: lpa });
    return { action: 'source_failed:blocked' };
  }
  if (cls === 'rate_limited') {
    const retries = (intent.autoRetries || 0) + 1;
    if (retries <= MAX_AUTO_RETRIES) {
      const nextAt = Date.now() + RATE_RETRY_MS;
      // 等待期状态 = source_failed + 保留有界重试时间（到期由 runDueProbes 拉回 establishing）
      setFailed(tid, intent.intentId, 'rate_limited', FAIL_TEXT.rate_limited, { keepRetryAt: new Date(nextAt).toISOString() });
      setProbeStep(intent.intentId, Object.assign(schedule(capability, phase, nextAt), {
        autoRetries: retries, lastProbeAttemptId: lpa,
      }));
      return { action: 'retry_scheduled:rate_limited', retryAt: new Date(nextAt).toISOString() };
    }
    setFailed(tid, intent.intentId, 'rate_limited', '来源多次限流，已暂停自动重试；可稍后重新加入监控。');
    setProbeStep(intent.intentId, { nextProbeAt: null, lastProbeAttemptId: lpa });
    return { action: 'source_failed:rate_limited_exhausted' };
  }
  if (cls === 'parse_failed') {
    setFailed(tid, intent.intentId, 'parse_failed', FAIL_TEXT.parse_failed);
    setProbeStep(intent.intentId, { nextProbeAt: null, lastProbeAttemptId: lpa });
    return { action: 'source_failed:parse_failed' };
  }
  // 暂时性失败（超时/不可达/内部错误）→ 退避重试（有界）
  const retries = (intent.autoRetries || 0) + 1;
  if (retries <= MAX_AUTO_RETRIES) {
    const nextAt = Date.now() + RETRY_BACKOFF_MS;
    setProbeStep(intent.intentId, Object.assign(schedule(capability, phase, nextAt), {
      autoRetries: retries, lastProbeAttemptId: lpa, state: 'establishing',
    }));
    return { action: 'retry_scheduled:' + cls, retryAt: new Date(nextAt).toISOString() };
  }
  setFailed(tid, intent.intentId, 'source_unavailable', '来源多次暂时不可达，已暂停自动重试；可稍后重新加入监控。');
  setProbeStep(intent.intentId, { nextProbeAt: null, lastProbeAttemptId: lpa });
  return { action: 'source_failed:' + cls + '_exhausted' };
}

// ---------- 不变量自愈 ----------
// 每个 establishing 意向必须至少满足其一：存在进行中的 job，或存在未来的 next_probe_at。
// 任何失败路径（包括 executor 异常、worker 崩溃、意向推进失败）都不得留下
// 「无任务、无下次时间」的 establishing——本函数在每次调度 tick 兜底修复：
//   · 已有 pending/running job 或 running attempt → 只看门狗时间（缺失则补上）
//   · 否则安排退避探测（计入 auto_retries），超过上限直接 source_failed（等用户重试）
// 注意：job/attempt 必须按**意向当前阶段的能力**查，不能固定 public_site_products。
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
    const cap = intent.nextProbeCapability || CAP_PRODUCTS;
    let activeJob = 0;
    try {
      activeJob = require('./collect-jobs.js').getDb().prepare(
        `SELECT COUNT(*) AS n FROM collection_jobs
         WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=? AND status IN ('pending','running')`
      ).get(tid, pid, cid, cap).n;
    } catch (e) { activeJob = 0; }
    let runningAttempt = 0;
    try {
      const last = SurfaceStore.latestAttempt(tid, pid, cid, cap);
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
      setProbeStep(intent.intentId, { nextProbeAt: null });
      out.failed++;
    }
  }
  return out;
}

// ---------- 到期探测执行（持久化分阶段建立流程的唯一调度入口） ----------
// 按意向里持久化的 next_probe_capability 调度——商品阶段调商品探测，官网阶段调官网探测。
// 幂等由三层保证：collect-request 的 running 复用 + 显式幂等键（phase + 上次 attempt + 时间桶）
// + 入队后的看门狗 next_probe_at；服务重启后 next_probe_at/能力/阶段都在库内，照常续跑。
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
    const capability = PROBE_CAPABILITIES.includes(intent.nextProbeCapability) ? intent.nextProbeCapability : CAP_PRODUCTS;
    const phase = PROBE_PHASES.includes(intent.probePhase) ? intent.probePhase : 'product_prime';
    // 限流恢复：重试前把状态拉回 establishing（真实重试进行中）
    if (intent.state === 'source_failed' && intent.reasonCode === 'rate_limited') {
      setProbeSchedule(intent.intentId, { state: 'establishing' });
    }
    // 竞品档案解析（worker 脱离请求上下文，与采集执行器同口径）
    const CollectJobs = require('./collect-jobs.js');
    const comp = CollectJobs.loadCompetitor({ tenantId: tid, projectId: pid, competitorId: cid });
    if (!comp) {
      setFailed(tid, intent.intentId, 'competitor_missing', '该品牌已不在项目中，无法继续建立监控来源。');
      setProbeStep(intent.intentId, { nextProbeAt: null });
      out.failed++; out.details.push({ intentId: intent.intentId, outcome: 'competitor_missing' });
      continue;
    }
    let r = null;
    try {
      r = CollectReq.requestCollection({
        tenantId: tid, projectId: pid, competitorId: cid,
        capability, comp, trigger: 'schedule',
        // 显式幂等键：探测间隔由持久化 next_probe_at 保证（≥ PROBE_INTERVAL_MS），
        // 不吃 capability 冷却（冷却会挡住「两次独立探测」的第二次）；键含
        // 意向 + 阶段 + 上一次 attempt + 15 分钟时间桶 → 同一探测窗口内重复触发去重，
        // 每次新探测（上次 attempt 已变）生成新 attempt；running attempt 复用仍然生效。
        idempotencyKey: 'intent_probe:' + intent.intentId + ':' + phase + ':' + (intent.lastProbeAttemptId || 'first') + ':' + Math.floor(now / 900000),
        // SC-09 r2：监控意向建立期的探测 = 基线探测，不是监控窗口，不写每日情报收件箱
        collectionPurpose: 'first_collection',
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
      out.details.push({ intentId: intent.intentId, capability, phase, outcome: 'enqueued', attemptId: (r.attempt && r.attempt.attemptId) || null });
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
      out.details.push({ intentId: intent.intentId, capability, phase, outcome: 'deferred:' + (r.reason || 'deduped') });
      continue;
    }
    if (r.status === 'quota') {
      // 平台日额度：有界推迟（不产生费用）
      setProbeSchedule(intent.intentId, { nextProbeAt: new Date(now + RATE_RETRY_MS).toISOString() });
      out.deferred++;
      out.details.push({ intentId: intent.intentId, outcome: 'quota_deferred' });
      continue;
    }
    // not_supported / not_configured / failed → 该能力不可用：商品阶段先尝试官网来源，
    // 官网阶段则按真实失败落终态（带可执行下一步）
    if (capability === CAP_PRODUCTS) {
      const sc = siteChangeEligibility(tid, pid, cid);
      if (sc.attempts === 0) {
        setProbeStep(intent.intentId, Object.assign(schedule(CAP_SITE, 'site_prime', now), { state: 'establishing' }));
        out.details.push({ intentId: intent.intentId, outcome: 'switched_to_site_source:' + r.status });
        continue;
      }
    }
    setFailed(tid, intent.intentId, 'source_unavailable', '公开来源暂时无法采集；可稍后重新加入监控。');
    setProbeStep(intent.intentId, { nextProbeAt: null });
    out.failed++;
    out.details.push({ intentId: intent.intentId, capability, outcome: 'failed:' + r.status });
  }
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
  INTENT_STATES, SOURCE_CAPABILITY, CAP_PRODUCTS, CAP_SITE, PROBE_CAPABILITIES, PROBE_PHASES, PHASE_TEXT, STATE_TEXT,
  PROBE_INTERVAL_MS, RATE_RETRY_MS, RETRY_BACKOFF_MS, MAX_AUTO_RETRIES, PROBE_PENDING_GRACE_MS,
  requestIntent, resumeSiteProbe, getIntent, findIntent, listIntents, cancelIntent, setFailed,
  scheduleFirstProbe, runDueProbes, onProbeFinished, evaluateIntentState, reconcileStuckIntents,
  view, comparableItems, deterministicDiff, promotionEligibility, siteChangeEligibility,
  buildVerifiedBasis, tryUpgradeTargetToPrice, seedSiteBaselineFromLatestAttempt, tryPromote,
  startScheduler, stopScheduler,
};
