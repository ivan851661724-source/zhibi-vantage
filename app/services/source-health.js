'use strict';
// ============================================================
// services/source-health.js —— 用户侧来源状态唯一投影（r3 收口）
// ------------------------------------------------------------
// 为什么需要它：
//   工作台 / 竞品雷达 / 竞品数据库 / 情报库此前各自从 attempt、job、
//   readiness、intent、window 里现算一套「这家品牌现在什么状态」，
//   于是同一个底层事实在不同页面被翻译成互相矛盾的话术：
//     · 官网可访问、只是没有可比价格 → 一处说「来源建立失败」
//     · 15 个品牌的「口碑与评论」采集内部报错 → 全部卡片说「采集未完成，需要重试」
//     · 45 条「数据服务未配置」被算进「需要处理」
//   本模块是这四个页面唯一的读模型：一次性把事实归并成用户可理解的
//   十个状态，其余地方只允许读这里的结论，禁止再自算。
//
// 纪律：
//   · 纯读：只读 attempt / job / readiness / intent / target / window，
//     绝不写库、绝不触发采集（触发采集在 collection-plan / watch-intent）。
//   · 只做用户投影，不改写领域终态词表（attempt.status / error_class 原样保留）。
//   · 合法空结果（checked_no_displayable_data）不是失败；
//     not_configured / out_of_coverage / unsupported 不进「需要处理」。
//   · 内部码（internal_error / adapter_output_invalid / 文件路径 / 栈）不出现在返回值。
// ============================================================

const SurfaceStore = require('./surface-store.js');
const Registry = require('./capability-registry.js');

// 用户侧状态（冻结十值；顺序即优先级，便于阅读）
const STATES = Object.freeze([
  'not_started',      // 尚未执行过采集
  'probing',          // 正在探测 / 建立基线
  'available',        // 已有可核验数据
  'monitoring',       // 已进入正式持续监控
  'limited',          // 来源可访问，但当前只能监控部分信号
  'retryable',        // 本次因网络/限流/临时错误失败，可自动重试
  'blocked',          // robots/权限/持续拒访等明确阻断
  'not_configured',   // 系统数据服务尚未配置
  'out_of_coverage',  // 来源明确不覆盖当前市场
  'unsupported',      // 当前产品确实没有对应采集能力
]);

const TEXT = Object.freeze({
  not_started: '尚未开始采集',
  probing: '正在建立基线',
  available: '已有可核验数据',
  monitoring: '正式监控中',
  limited: '仅能监控部分信号',
  retryable: '来源暂时不可访问，系统将自动重试',
  blocked: '来源拒绝访问',
  not_configured: '数据服务暂不可用',
  out_of_coverage: '来源不覆盖该市场',
  unsupported: '暂不支持该来源',
});

// 主来源能力：决定「这家品牌到底有没有东西可看」
const PRIMARY_CAPS = Object.freeze(['public_site_products', 'shopify_catalog', 'official_site_profile']);

// 失败分类 → 用户侧种类（owner=user 表示需要用户动作；system 表示系统自动重试）
function classifyFailure(att) {
  const ss = String((att && (att.sourceStatus || att.source_status)) || '');
  const ec = String((att && (att.errorClass || att.error_class)) || '');
  if (ss === 'blocked') {
    return { kind: 'blocked', owner: 'user', retryable: false, text: '来源拒绝访问（robots 或权限限制）' };
  }
  if (ss === 'rate_limited') {
    return { kind: 'rate_limited', owner: 'system', retryable: true, text: '来源限制了访问频率，稍后自动重试' };
  }
  if (ss === 'unavailable' || ss === 'timeout') {
    return { kind: 'unreachable', owner: 'system', retryable: true, text: '来源暂时不可达，稍后自动重试' };
  }
  if (ss === 'parse_failed') {
    return { kind: 'parse_failed', owner: 'system', retryable: true, text: '返回内容暂时无法解析，稍后重试' };
  }
  if (ss === 'not_configured') {
    return { kind: 'not_configured', owner: 'system', retryable: false, text: TEXT.not_configured };
  }
  if (ss === 'internal_error' || ec === 'internal_error' || ec === 'adapter_output_invalid') {
    // 系统侧问题：用户无法处理，但会由系统重试——不计入「需要你处理」
    return { kind: 'system_error', owner: 'system', retryable: true, text: '采集在系统侧未完成，会自动重试' };
  }
  return { kind: 'unknown', owner: 'system', retryable: true, text: '本次未完成，稍后自动重试' };
}

// 能力级 stale：该能力此前有可用观察、且最近一次采集失败
function anyCapabilityStale(atts) {
  const byCap = new Map();
  for (const a of atts) {
    if (!a || !a.capability) continue;
    if (!byCap.has(a.capability)) byCap.set(a.capability, []);
    byCap.get(a.capability).push(a); // 已按 started_at DESC
  }
  for (const list of byCap.values()) {
    const latest = list[0];
    if (!latest || latest.status !== 'failed') continue;
    if (list.slice(1).some(isUsableAtt)) return true;
  }
  return false;
}

function isUsableAtt(a) {
  return !!a && (a.status === 'success' || a.status === 'partial')
    && Array.isArray(a.observations) && a.observations.length > 0;
}

function safeListAttempts(tid, pid, cid) {
  try { return SurfaceStore.listAttemptsByCompetitor(tid, pid, cid, 100) || []; } catch (e) { return []; }
}

function safeJobs(tid, pid, cid) {
  try {
    return require('./collect-jobs.js').getDb().prepare(
      `SELECT capability FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=?
       AND status IN ('pending','claimed','running')`
    ).all(String(tid), String(pid), String(cid)).map(r => r.capability);
  } catch (e) { return []; }
}

function readinessOf(capCode) {
  try {
    const r = require('./source-readiness.js').getReadiness(capCode);
    return r && r.state ? r.state : 'unknown';
  } catch (e) { return 'unknown'; }
}

function safeWatch(tid, pid, cid) {
  try {
    const WS = require('./watch-store.js');
    const rows = WS.getDb().prepare(
      'SELECT * FROM watch_targets WHERE tenant_id=? AND project_id=? AND competitor_id=? AND deactivated_at IS NULL'
    ).all(String(tid), String(pid), String(cid));
    return rows[0] || null;
  } catch (e) { return null; }
}

function safeIntent(tid, pid, cid) {
  try {
    return require('./watch-intent.js').findIntent(String(tid), String(pid), String(cid));
  } catch (e) { return null; }
}

function safeLatestWindow(tid, targetId) {
  try {
    const WS = require('./watch-store.js');
    return WS.latestWindowFor(String(tid), String(targetId)) || null;
  } catch (e) { return null; }
}

function parseSignals(raw) {
  try { const a = JSON.parse(raw || '[]'); return Array.isArray(a) ? a.filter(Boolean) : []; } catch (e) { return []; }
}

/**
 * 品牌级用户侧来源状态。
 * @param {string} tenantId
 * @param {string} projectId
 * @param {object} comp 竞品对象（需 id / url / isShopify）
 * @param {object} [opts] { coverage }  传入 brand-service 已算好的覆盖投影可省一次读
 * @returns {object} health
 */
function build(tenantId, projectId, comp, opts) {
  const tid = String(tenantId || ''); const pid = String(projectId || '');
  const c = comp || {};
  const cid = String(c.id || '');
  const o = opts || {};
  const health = {
    state: 'not_started',
    stateText: TEXT.not_started,
    tone: 'muted',
    note: null,
    action: { kind: 'none', text: null },
    // 四个派生布尔：供各页面做统计（禁止各页面自己再判一遍）
    hasData: false,       // 有可用观察
    started: false,       // 有过任何 attempt（→ 绝不能再显示「未探测」）
    needsHandling: false, // 只有 retryable/blocked 且无可用数据
    limited: false,
    stale: false,         // 有历史数据但最近一次更新失败
    watching: 'none',     // none | probing | monitoring | limited
    signals: [],
    lastSuccessAt: null,
    lastAttemptAt: null,
    issue: null,          // { kind, owner, retryable, text }
    limits: [],           // 覆盖限制（not_configured / unsupported / out_of_coverage）
    gaps: [],             // 维度级明细（数据覆盖与来源 Tab 用）
  };
  if (!cid) return health;

  const atts = safeListAttempts(tid, pid, cid);
  const running = safeJobs(tid, pid, cid);
  const coverage = o.coverage || null;
  health.lastAttemptAt = atts.length ? (atts[0].endedAt || atts[0].startedAt || null) : null;
  health.started = atts.length > 0;

  // ---- 维度明细（优先用调用方已算好的 coverage，避免重复读）----
  const dims = (coverage && Array.isArray(coverage.dimensions)) ? coverage.dimensions : [];
  let primaryAvailable = false;
  let anyAvailable = false;
  let primaryFailed = null;   // 主来源最近一次失败
  let collecting = false;
  let allNotConfigured = dims.length > 0;

  for (const d of dims) {
    const caps = (Registry.capabilitiesByDimension(d.code) || []).map(x => x.code);
    const isPrimary = caps.some(x => PRIMARY_CAPS.includes(x));
    if (d.state === 'available') { anyAvailable = true; if (isPrimary) primaryAvailable = true; }
    if (d.state === 'collecting') collecting = true;
    if (d.state !== 'not_configured') allNotConfigured = false;
    if (d.state === 'failed') {
      const att = atts.find(a => a && caps.includes(a.capability) && a.status === 'failed') || null;
      const kind = classifyFailure(att);
      if (isPrimary && !primaryFailed) primaryFailed = Object.assign({ dimension: d.label, capability: att && att.capability }, kind);
      health.gaps.push({ dimension: d.label, state: 'failed', kind: kind.kind, text: kind.text, owner: kind.owner });
    } else if (d.state === 'not_configured') {
      health.limits.push({ dimension: d.label, state: 'not_configured', text: d.note || TEXT.not_configured });
      health.gaps.push({ dimension: d.label, state: 'not_configured', text: d.note || TEXT.not_configured });
    } else if (d.state === 'collecting') {
      health.gaps.push({ dimension: d.label, state: 'collecting', text: '正在采集' });
    } else if (d.state === 'available') {
      health.gaps.push({ dimension: d.label, state: 'available', text: '已有数据' });
    } else if (d.state === 'empty') {
      health.gaps.push({ dimension: d.label, state: 'empty', text: '检查完成，未发现可核验数据' });
    }
  }
  // 没有 coverage 时（调用方未传）退回 attempt 直判，保证不误报「未探测」
  if (!dims.length && atts.length) {
    anyAvailable = atts.some(isUsableAtt);
    primaryAvailable = atts.some(a => isUsableAtt(a) && PRIMARY_CAPS.includes(a.capability));
    collecting = atts.some(a => a.status === 'running') || running.length > 0;
    const lastPrimaryFail = atts.find(a => a.status === 'failed' && PRIMARY_CAPS.includes(a.capability));
    if (lastPrimaryFail) primaryFailed = Object.assign({ dimension: '官网与商品', capability: lastPrimaryFail.capability }, classifyFailure(lastPrimaryFail));
  }
  if (running.length && !collecting) collecting = true;

  const usableAtts = atts.filter(isUsableAtt);
  health.hasData = anyAvailable || usableAtts.length > 0;
  if (usableAtts.length) {
    health.lastSuccessAt = usableAtts[0].endedAt || usableAtts[0].startedAt || null;
    // 「最近更新失败」按**能力**判定（SC-08 §三 usingPreviousData 口径）：
    // 某个能力此前有可用观察、最近一次采集却失败 → 旧数据保留但要标「最近更新失败」。
    // 从未成功过的能力（例如评论采集一直是系统内部错误）不算 stale，
    // 否则「官网数据好端端」的品牌会被整卡判红——这正是本轮要修的错。
    health.stale = anyCapabilityStale(atts);
  }

  // ---- 正式监控 / 监控意向（优先级最高：已经进入的链路优先于历史采集状态）----
  const target = safeWatch(tid, pid, cid);
  const intent = safeIntent(tid, pid, cid);

  function finish(state, extra) {
    health.state = state;
    health.stateText = (extra && extra.text) || TEXT[state] || state;
    health.tone = (extra && extra.tone) || toneOf(state);
    health.note = (extra && extra.note) || null;
    if (extra && extra.action) health.action = extra.action;
    // 「需要处理」= 真实可恢复失败（retryable/blocked），或「有数据但最近一次更新失败」（stale）。
    // not_configured / out_of_coverage / unsupported / limited 一律不计入。
    health.needsHandling = state === 'retryable' || state === 'blocked' || health.stale;
    health.limited = state === 'limited';
    return health;
  }

  if (target && (target.monitoring_status === 'active' || target.monitoring_status === 'degraded')) {
    const sig = parseSignals(target.enabled_signals);
    health.signals = sig;
    const win = safeLatestWindow(tid, target.watch_target_id);
    const lastBad = win && Number(win.failed || 0) > 0;
    if (sig.includes('price')) {
      return finish('monitoring', {
        text: '正式监控中（价格）',
        note: lastBad ? '最近一次巡检部分未完成，已在下一轮自动重试' : null,
        action: { kind: 'none', text: null },
      });
    }
    if (sig.includes('site_change')) {
      return finish('limited', {
        text: '已加入监控，目前监控官网内容变化',
        note: '该来源没有可持续比较的商品价格，已降级为官网内容变化监控',
        action: { kind: 'none', text: null },
      });
    }
    return finish('limited', { text: '已加入监控', note: null });
  }
  if (target && target.monitoring_status === 'paused') {
    return finish('limited', { text: '已暂停监控', note: '恢复后继续按原信号巡检', action: { kind: 'resume', text: '恢复监控' } });
  }

  if (intent && intent.state === 'establishing') {
    health.watching = 'probing';
    const phase = intent.probePhase || '';
    const txt = phase.indexOf('site') === 0
      ? '正在建立官网观察基线'
      : '正在建立公开来源基线';
    return finish('probing', { text: txt, note: intent.probePhaseText || null, action: { kind: 'none', text: null } });
  }
  if (intent && intent.state === 'source_failed') {
    const reason = String(intent.reasonCode || '');
    if (reason === 'blocked') {
      return finish('blocked', {
        text: '来源拒绝访问',
        note: '官网公开页面返回 403/401，无法建立可核验来源',
        action: { kind: 'rejoin', text: '重新加入监控' },
      });
    }
    if (reason === 'no_official_url') {
      return finish('unsupported', {
        text: '缺少可核验官网',
        note: '该品牌没有可核验的官网地址，补齐后才能建立来源',
        action: { kind: 'fill_url', text: '补充官网地址' },
      });
    }
    if (reason === 'no_comparable_products' || reason === 'insufficient_structured_fields') {
      // 官网可访问但没有可比较字段：不得说「来源建立失败」，应表达为「可访问、尚未建立可监控基线」
      return finish('retryable', {
        text: '官网可访问，尚未建立可监控基线',
        note: '当前未发现可持续比较的商品价格或结构化字段，可继续尝试官网内容监控',
        action: { kind: 'resume', text: '继续建立监控' },
      });
    }
    if (reason === 'rate_limited') {
      return finish('retryable', {
        text: '来源暂时限制访问',
        note: intent.nextProbeAt ? '系统将在稍后自动重试' : '可稍后重新加入监控',
        action: { kind: 'none', text: null },
      });
    }
    return finish('retryable', {
      text: '来源暂时不可访问',
      note: '系统将在稍后自动重试',
      action: { kind: 'resume', text: '重新加入监控' },
    });
  }

  // ---- 没有监控链路：按真实采集事实判定 ----
  if (primaryAvailable || (anyAvailable && !primaryFailed)) {
    if (collecting) return finish('probing', { text: '正在补查部分维度' });
    if (primaryFailed) {
      return finish('limited', {
        text: '已有数据，最近一次更新失败',
        note: primaryFailed.text,
        action: { kind: 'retry', text: '重新检查失败项' },
      });
    }
    const limitedSignals = health.limits.length > 0 && !health.hasData ? true : false;
    if (limitedSignals) return finish('limited', { text: '仅能查看部分维度' });
    return finish('available', { text: health.stale ? '已有数据，最近一次更新失败' : '已有可核验数据' });
  }
  if (collecting) return finish('probing', { text: '正在采集' });
  if (allNotConfigured && !health.started) {
    return finish('not_configured', {
      text: '数据服务暂不可用',
      note: '当前不生成数据、估算或结论',
      action: { kind: 'none', text: null },
    });
  }
  if (primaryFailed) {
    if (primaryFailed.kind === 'blocked') {
      return finish('blocked', {
        text: '来源拒绝访问',
        note: '官网公开页面返回 403/401',
        action: { kind: 'retry', text: '重新检查' },
      });
    }
    if (primaryFailed.kind === 'not_configured') {
      return finish('not_configured', { text: '数据服务暂不可用', note: null });
    }
    return finish('retryable', {
      text: health.started ? '本次采集未完成，会自动重试' : '尚未开始采集',
      note: primaryFailed.text,
      action: { kind: 'retry', text: '重新检查失败项' },
    });
  }
  if (health.started) {
    // 有 attempt 但没有任何可用观察：合法的「查过没有」≠ 失败
    return finish('limited', {
      text: '已检查，暂未发现可核验数据',
      note: '公开页面可访问，但没有可安全识别的结构化字段',
      action: { kind: 'none', text: null },
    });
  }
  return finish('not_started', {
    text: '尚未开始采集',
    note: '首轮采集计划会在进入工作台时自动创建',
    action: { kind: 'none', text: null },
  });
}

function toneOf(state) {
  if (state === 'monitoring' || state === 'available') return 'ok';
  if (state === 'probing' || state === 'limited' || state === 'not_started') return 'info';
  if (state === 'retryable' || state === 'blocked') return 'warn';
  return 'muted';
}

// 项目级汇总：竞品数据库 / 工作台顶部的四类计数（去重品牌，不按维度累加）
function summarize(healths) {
  const list = Array.isArray(healths) ? healths.filter(Boolean) : [];
  const out = {
    brands: list.length,
    established: 0,   // 已建立数据
    collecting: 0,    // 正在采集
    limited: 0,       // 有限覆盖（含只监控官网内容）
    needsHandling: 0, // 真实需要处理（retryable / blocked 且无数据）
    notStarted: 0,
    limits: 0,        // 兼容别名 = partialSignalBrands（r4g §七 拆分前旧字段）
    partialSignalBrands: 0,      // 部分信号品牌数（品牌口径，去重）
    notIntegratedDimensions: 0,  // 尚未接入维度数（维度口径，Σ limits）
    byState: {},
  };
  for (const h of list) {
    out.byState[h.state] = (out.byState[h.state] || 0) + 1;
    if (h.stale) out.needsHandling += 1; // 有数据但最近一次更新失败：可重新检查，算需要处理
    else if (h.state === 'monitoring' || h.state === 'available') out.established += 1;
    else if (h.state === 'probing' || h.state === 'not_started') out.collecting += 1;
    else if (h.state === 'limited') out.limited += 1;
    else if (h.state === 'retryable' || h.state === 'blocked') out.needsHandling += 1;
    else out.partialSignalBrands += 1; // not_configured/out_of_coverage/unsupported：按品牌计入「部分信号」
    if (h.state === 'not_started') out.notStarted += 1;
    // r4g §七：覆盖限制拆成品牌数与维度数两个口径，不得混用——
    //   partialSignalBrands = 受限品牌数（去重，每品牌计一次）；
    //   notIntegratedDimensions = 尚未接入的维度条目数（Σ 每品牌 limits 长度）。
    if (!h.stale && Array.isArray(h.limits)) {
      if (h.limits.length > 0) {
        out.partialSignalBrands += 0; // 已在上面按品牌计过，这里不重复加品牌数
      }
      out.notIntegratedDimensions += h.limits.length;
    }
  }
  // limits 保留为兼容别名（= 部分信号品牌数），新代码请用拆分后的两个字段
  out.limits = out.partialSignalBrands;
  return out;
}

module.exports = { STATES, TEXT, build, summarize, classifyFailure, PRIMARY_CAPS };
