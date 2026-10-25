'use strict';
// ============================================================
// services/brand-service.js —— 统一竞品读模型（SC-04）
//   · 只读投影：真值链（SourceSnapshot→Evidence→Fact→Metric→DomainEvent→Judgment）
//     与 Data Surface attempts 只被读取，不复制为新的事实、不改原始真值；
//   · 未接入维度一律「未接入」，无数据一律「尚未采集」，绝不伪造或推测填充；
//   · 全部读取 tenantId 硬过滤，跨租户 → null（上层 404）。
//   用户语言：数据性质（来源直接记录 / 官方公开数据 / 数据服务估算 /
//   按已有数据计算 / 根据公开内容归纳）与状态（已核实 / 待核实 / 资料不足 /
//   来源冲突）在此统一映射。
// ============================================================
const path = require('path');
const fs = require('fs');

const BrandStore = require('./brand-store.js');
const Registry = require('./capability-registry.js');
const Surface = require('./data-surface.js');
const SurfaceStore = require('./surface-store.js');
const Readiness = require('./source-readiness.js');
const EvidenceStore = require('../research/evidence-store.js');
const Snapshot = require('../research/source-snapshot.js');
const DomainEvent = require('../research/domain-event.js');
const VoiceUnified = require('./voice-unified.js');

// 数据性质（nature）→ 用户语言
const NATURE_TEXT = Object.freeze({
  observed: '来源直接记录',
  official: '官方公开数据',
  estimated: '数据服务估算',
  computed: '按已有数据计算',
  summarized: '根据公开内容归纳',
  backfilled: '后续补入的历史',
  corrected: '用户纠错与更正',
});
// 情报状态 → 用户语言
const INTEL_STATUS_TEXT = Object.freeze({
  verified: '已核实',
  pending: '待核实',
  insufficient: '资料不足',
  conflicted: '来源冲突',
});
// 情报类型（用户语言）
const INTEL_TYPE_TEXT = Object.freeze({
  price: '价格', product: '商品', promo: '促销', channel: '渠道',
  voice: '口碑', gap: '资料缺口', monitor: '监控状态',
});
// 覆盖状态 → 用户语言（§六状态表达）
// 🔴 诚实语义：failed = 最近一次采集失败且【没有】任何历史成功数据（data-surface 仅在
//    !lastUsable 时置 failed）——不得声称「保留旧数据」；「保留旧数据」只出现在
//    有上次成功数据（ok/partial/stale）且最近一次尝试失败的 notes 里。
const COVER_STATE_TEXT = Object.freeze({
  ok: '已采集且有数据',
  partial: '部分采集',
  empty: '已采集但无可提炼结果',
  stale: '数据过期',
  loading: '采集中',
  failed: '最近采集失败，尚无可展示数据',
  unsupported: '未接入',
  pending_config: '数据服务暂不可用',
  unknown: '尚未采集',
});

function loadProjectState(tenantId, projectId) {
  try {
    // 直接按 projectId 读档案（state-store 的 loadState 只认「当前项目」，不能用于指定项目）
    const { projFile } = require('../core/state-store.js');
    const f = projFile(projectId, tenantId);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { return null; }
}
function findCompetitor(state, competitorId) {
  const list = (state && Array.isArray(state.competitors)) ? state.competitors : [];
  return list.find(c => c && c.id === competitorId) || null;
}
function domainOfUrl(u) {
  try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch (e) { return null; }
}

// ---------- 同步：项目状态 competitors → Brand Record + Link（幂等） ----------
// SC-10 r2 §四：项目状态文件是竞品成员关系的**事实源**。每次同步同时做三件事：
//   ① 新增品牌链接（upsertBrand + linkProject，幂等）；
//   ② 保留仍在项目中的链接；
//   ③ 回收已不在项目中的 brand_project_links（只删链接，不删品牌历史/Snapshot/
//      Evidence/时间线，不碰其他项目对同一品牌的链接）。
// 回收后与首采/监控取消保持一致：该品牌在本项目的在途 job/attempt 双终结，
// 不留 running；首采 item 转 cancelled（由 reconcileBatchPlan 完成，历史保留审计）。
function syncProjectBrands(tenantId, projectId, state) {
  const st = state || loadProjectState(tenantId, projectId);
  if (!st) return { synced: 0 }; // 档案缺失：无法验证成员关系，绝不回收任何链接
  const list = Array.isArray(st.competitors) ? st.competitors : [];
  let n = 0;
  for (const c of list) {
    if (!c || !c.id) continue;
    const domain = domainOfUrl(c.url || '');
    const { brand } = BrandStore.upsertBrand({
      tenantId, canonicalName: c.name || domain || c.id,
      officialDomain: domain, market: (c.market || (st.intent && st.intent.regions && st.intent.regions[0]) || null),
      category: c.category || (st.intent && st.intent.category) || null,
      relation: c.relation || 'competitor', competitorRef: c.id,
    });
    BrandStore.linkProject({ tenantId, brandId: brand.brandId, projectId, competitorRef: c.id });
    n++;
  }
  // ③ 回收失效链接（可验证口径：competitor_ref 非空且不在当前成员列表）
  let reclaimed = 0, unverifiableKept = 0;
  try {
    const r = BrandStore.reclaimProjectLinks(tenantId, projectId, list.map(c => c && c.id).filter(Boolean));
    reclaimed = r.reclaimed;
    unverifiableKept = r.unverifiable;
    // ④ 与首取消除法一致：被移出品牌的在途任务双终结，不留 running
    if (reclaimed > 0) {
      try {
        const CollectJobs = require('./collect-jobs.js');
        for (const cid of (r.reclaimedRefs || [])) {
          CollectJobs.cancelCompetitorJobs(tenantId, projectId, cid, 'brand_removed_from_project');
        }
      } catch (e) { /* 取消失败不阻塞链接回收；下轮 reconcile/巡检兜底 */ }
      // ⑤ 首采批次对账：item 转 cancelled（不是失败），历史保留审计
      try {
        const FC = require('./first-collection.js');
        const batch = FC.getBatch(tenantId, projectId);
        if (batch) FC.reconcileBatchPlan(batch.batch_id);
      } catch (e) { /* 无批次：不存在首采任务，无需对账 */ }
    }
  } catch (e) { /* 回收失败不影响既有链接可读 */ }
  return { synced: n, reclaimed, unverifiableKept };
}

// ---------- 覆盖：Registry 驱动，未接入 ≠ 未采集 ≠ 无数据 ----------
function buildCoverage(tenantId, projectId, competitor) {
  const comp = competitor || {};
  const compId = comp.id || null;
  const dims = [];
  // SC-05：时序档案里已有的已核验事实也算「有数据」——否则顶部会写「有数据 0 个」，
  // 与下方时序覆盖的「有可核验证据」自相矛盾。只读投影，不写库。
  let memStats = null;
  try {
    if (compId) memStats = require('./competitive-memory-store.js').coverageStats(tenantId, projectId, compId);
  } catch (e) { memStats = null; }
  const memDimOf = (code) => (code === 'website_products' ? (memStats && (memStats.product || memStats.catalog)) : null);
  for (const d of Registry.listDimensions()) {
    const caps = Registry.capabilitiesByDimension(d.code);
    const ga = caps.filter(c => c.maturity === 'ga');
    // P0-2 整改 r2：实现态（pending_config）与运行态（readiness）分离——用户侧
    // 只显示四种口径之一（此处=数据服务暂不可用）；凭据等技术细节仅管理员
    // 健康接口可见（GET /api/admin/data-surface/capabilities），不进用户投影。
    const pending = caps.filter(c => c.maturity === 'pending_config');
    // R4.15：maturity 未升级但已有真实可用尝试（success/partial）的能力，按「已采到数据」参与聚合——
    // 否则顶部覆盖面板会与下方数据面卡片自相矛盾（卡片有数据、面板说"暂不可用"）。
    const pendingActive = (!ga.length && compId)
      ? pending.filter(c => {
        try {
          return SurfaceStore.listAttempts(tenantId, projectId, compId, c.code, 10)
            .some(a => a.status === 'success' || a.status === 'partial');
        } catch (e) { return false; }
      })
      : [];
    if (!ga.length && pending.length && !pendingActive.length) {
      dims.push({
        code: d.code, displayName: d.displayName, state: 'pending_config', stateText: '数据服务暂不可用',
        capabilities: pending.map(c => ({ code: c.code, displayName: c.displayName, maturity: c.maturity, measurementMethod: c.measurementMethod || null })),
        lastObservedAt: null, reason: 'service_credential_required',
        note: '数据服务暂不可用，请稍后再试。当前不生成数据、估算或结论。',
      });
      continue;
    }
    if (!ga.length && !pendingActive.length) {
      dims.push({
        code: d.code, displayName: d.displayName, state: 'unsupported', stateText: '未接入',
        capabilities: caps.map(c => ({ code: c.code, displayName: c.displayName, maturity: c.maturity, limitations: c.limitations })),
        lastObservedAt: null, reason: 'source_not_integrated',
        note: '该数据源尚未接入，Vantage 不提供此维度的任何数据或估算。',
      });
      continue;
    }
    // 参与本维度聚合的能力：ga + 已采到数据的 pending
    const capsForAgg = ga.concat(pendingActive);
    if (!compId) {
      dims.push({ code: d.code, displayName: d.displayName, state: 'unknown', stateText: '尚未采集', capabilities: capsForAgg.map(c => ({ code: c.code, displayName: c.displayName })), lastObservedAt: null, reason: 'no_competitor' });
      continue;
    }
    let best = null; best = null;
    let aggregated = null;
    try {
      const ov = Surface.buildOverview({ tenantId, projectId, competitorId: compId, comp, nowMs: Date.now() });
      aggregated = (ov.dimensions || []).find(x => x.code === d.code) || null;
    } catch (e) { aggregated = null; }
    const state = aggregated ? (aggregated.surfaceState || 'unknown') : 'unknown';
    // 🔴 状态表达（§六）：「尚未采集」≠「已采集但无可提炼结果」。
    // 该维度下所有已接入能力都**没有任何 attempt** 时，一律「尚未采集」。
    let hasAttempt = false;
    let latestFailed = false;
    for (const c of capsForAgg) {
      const a = SurfaceStore.latestAttempt(tenantId, projectId, compId, c.code);
      if (a) {
        hasAttempt = true;
        if (a.status === 'failed') latestFailed = true;
      }
    }
    let finalState = hasAttempt ? state : 'unknown';
    const memDim = memDimOf(d.code);
    // 没有任何采集 attempt，但时序档案里有已核验事实（历史采集/存档回补）→ 不能说「未采集」
    if (!hasAttempt && memDim && memDim.factCount > 0) finalState = 'ok';
    let lastObservedAt = null;
    if (aggregated && Array.isArray(aggregated.aggregations)) {
      for (const a of aggregated.aggregations) {
        if (a.lastUsable && a.lastUsable.endedAt) {
          if (!lastObservedAt || String(a.lastUsable.endedAt) > lastObservedAt) lastObservedAt = a.lastUsable.endedAt;
        }
      }
    }
    // 🔴 诚实备注：「保留旧数据」只在确有上次成功数据（ok/partial/stale）时允许出现；
    //    首次采集失败（failed，无历史成功）只说失败，不声称保留任何数据。
    const notes = [];
    if (!hasAttempt && memDim && memDim.factCount > 0) {
      notes.push('当前没有本次采集记录；展示的是时序档案中已核验的历史记录（最早 ' + String(memDim.firstAt).slice(0, 10) + '）。');
    }
    if (['ok', 'partial', 'stale'].includes(finalState) && latestFailed) {
      notes.push('最近一次更新失败，当前展示上次成功数据。');
    }
    if (aggregated && Array.isArray(aggregated.gaps)) {
      for (const g of aggregated.gaps) { if (g && g.text) notes.push(g.text); }
    }
    dims.push({
      code: d.code, displayName: d.displayName,
      state: finalState, stateText: COVER_STATE_TEXT[finalState] || '尚未采集',
      capabilities: capsForAgg.map(c => ({ code: c.code, displayName: c.displayName, maturity: c.maturity })),
      lastObservedAt,
      notes,
      reason: finalState === 'unsupported' ? 'not_supported_for_object' : (hasAttempt ? null : 'not_collected_yet'),
    });
  }
  // Wave 1：integrated 只计真正可采集的维度；pending_config 单列（不是已接入）
  const integrated = dims.filter(d => d.state !== 'unsupported' && d.state !== 'pending_config');
  const withData = integrated.filter(d => ['ok', 'partial', 'stale'].includes(d.state));
  return {
    dimensions: dims,
    summary: {
      totalDimensions: dims.length,
      integratedDimensions: integrated.length,
      notIntegrated: dims.filter(d => d.state === 'unsupported').map(d => d.code),
      pendingConfig: dims.filter(d => d.state === 'pending_config').map(d => d.code),
      dimensionsWithData: withData.length,
      notCollected: integrated.filter(d => d.state === 'unknown').map(d => d.code),
    },
  };
}

// ---------- 唯一覆盖投影 brandCoverage（SC-08 r2 §六） ----------
// 规则：
//   · 维度总数来自能力 Registry（禁止硬编码「1/5」）；
//   · 状态六态严格区分：available（有真实数据）/ collecting（正在进行）/ empty（查过但无可展示
//     结果）/ failed（最近失败且无可用数据）/ not_configured（来源未接入或缺凭据）/
//     not_started（已接入但从未采集）；
//   · 全部字段由真实 attempt / job / Snapshot / Evidence / 时序事实派生，前端不得硬编码；
//   · 同一失败原因每个维度最多展示一次（latestFailureText 单值）。
const BRAND_COVER_STATE_TEXT = Object.freeze({
  available: '已接入并有数据',
  collecting: '正在采集',
  empty: '已检查，暂无可展示数据',
  failed: '采集失败',
  not_configured: '来源未接入',
  not_started: '尚未开始采集',
});

function hostOf(u) {
  try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch (e) { return null; }
}

function buildBrandCoverage(tenantId, projectId, competitor) {
  const comp = competitor || {};
  const compId = comp.id || null;
  const tid = String(tenantId || ''); const pid = String(projectId || '');
  let atts = [];
  try { atts = compId ? (SurfaceStore.listAttemptsByCompetitor(tid, pid, compId, 100) || []) : []; } catch (e) { atts = []; }
  let jobs = [];
  if (compId) {
    try {
      jobs = require('./collect-jobs.js').getDb().prepare(
        `SELECT capability FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=? AND status IN ('pending','claimed','running')`
      ).all(tid, pid, compId).map(r => r.capability);
    } catch (e) { jobs = []; }
  }
  let memStats = null;
  try { if (compId) memStats = require('./competitive-memory-store.js').coverageStats(tid, pid, compId); } catch (e) { memStats = null; }
  const memOf = (dimCode) => {
    if (!memStats) return 0;
    if (dimCode === 'website_products') return (memStats.product ? memStats.product.factCount : 0) + (memStats.catalog ? memStats.catalog.factCount : 0);
    return 0;
  };

  const dimensions = [];
  for (const d of Registry.listDimensions()) {
    const caps = Registry.capabilitiesByDimension(d.code) || [];
    const integrated = caps.filter(c => c.maturity !== 'not_integrated');
    const capCodes = new Set(caps.map(c => c.code));
    const dimAtts = atts.filter(a => a && capCodes.has(a.capability));
    const usable = dimAtts.filter(a => (a.status === 'success' || a.status === 'partial')
      && (Array.isArray(a.observations) ? a.observations.length : 0) > 0);
    const running = dimAtts.some(a => a.status === 'running') || jobs.some(c => capCodes.has(c));
    const latest = dimAtts[0] || null; // listAttemptsByCompetitor 已按 started_at DESC
    const failedAtt = dimAtts.find(a => a.status === 'failed') || null;
    const memFacts = memOf(d.code);

    let observationCount = 0;
    let evidenceCount = 0;
    const evidenceSeen = new Set();
    const hosts = new Set();
    for (const a of usable) {
      observationCount += Array.isArray(a.observations) ? a.observations.length : 0;
      for (const eid of (a.evidenceIds || [])) evidenceSeen.add('e:' + eid);
      for (const sid of (a.snapshotIds || [])) evidenceSeen.add('s:' + sid);
      for (const o of (a.observations || [])) { const h = hostOf(o && o.sourceUrl); if (h) hosts.add(h); }
    }
    evidenceCount = evidenceSeen.size;
    // 来源数只在**真的有观察**时回退到品牌官网域名；未采集/未配置维度不得凭空显示「1 个来源」
    if (!hosts.size && usable.length && comp.url) { const h = hostOf(comp.url); if (h) hosts.add(h); }

    let lastObservedAt = null;
    let firstObservedAtOfDim = null;
    for (const a of usable) {
      const at = a.endedAt || a.startedAt || null;
      if (at && (!lastObservedAt || String(at) > lastObservedAt)) lastObservedAt = at;
      const st = a.startedAt || a.endedAt || null;
      if (st && (!firstObservedAtOfDim || String(st) < firstObservedAtOfDim)) firstObservedAtOfDim = st;
    }

    // 六态判定（顺序即优先级）
    let state = 'not_started';
    let reason = null;
    if (!integrated.length) { state = 'not_configured'; reason = 'source_not_integrated'; }
    else if (running) { state = 'collecting'; reason = 'attempt_or_job_in_flight'; }
    else if (usable.length || memFacts > 0) { state = 'available'; }
    else if (dimAtts.length && latest && latest.status === 'failed') { state = 'failed'; reason = 'latest_attempt_failed'; }
    else if (dimAtts.length) { state = 'empty'; reason = 'checked_no_displayable_data'; }
    else {
      // 从未采集：区分「未配置（缺凭据）」与「未开始」
      let anyConfigured = false;
      for (const c of integrated) {
        try { if (Readiness.getReadiness(c.code).state !== 'not_configured') anyConfigured = true; } catch (e) { anyConfigured = true; }
      }
      if (!anyConfigured) { state = 'not_configured'; reason = 'credential_required'; }
      else { state = 'not_started'; reason = 'not_collected_yet'; }
    }

    // 用户可见口径：「未配置」按原因分两种人话（缺凭据 vs 未接入），不出现技术细节
    const stateText = state === 'not_configured'
      ? (reason === 'source_not_integrated' ? '未接入' : '数据服务暂不可用')
      : BRAND_COVER_STATE_TEXT[state];
    const note = state === 'not_configured'
      ? (reason === 'source_not_integrated'
        ? '该数据源尚未接入，Vantage 不提供此维度的任何数据或估算。'
        : '数据服务暂不可用，请稍后再试。当前不生成数据、估算或结论。')
      : (state === 'not_started' ? '尚未开始采集；可在「来源与采集记录」发起首轮采集。' : null);
    // SC-08 r3 §三：时间拆分 + 「旧数据仍可用，但最新采集失败」的诚实表达。
    //   lastAttemptAt       = 最近一次**任意**采集（含失败/running）
    //   lastSuccessfulAt    = 最近一次 success/partial 且有可用观察的采集
    //   latestAttemptStatus = 最近一次采集的状态（success|partial|failed|running|null）
    //   usingPreviousData   = 有历史数据 且 最近一次采集失败（state 保持 available，不删旧数据）
    const latestAny = dimAtts[0] || null;
    const lastSuccessfulAtt = usable[0] || null; // usable 已按 started_at DESC
    const lastAttemptAt = latestAny ? (latestAny.endedAt || latestAny.startedAt || null) : null;
    const lastSuccessfulAt = lastSuccessfulAtt ? (lastSuccessfulAtt.endedAt || lastSuccessfulAtt.startedAt || null) : null;
    const latestAttemptStatus = latestAny ? latestAny.status : null;
    const usingPreviousData = state === 'available' && latestAttemptStatus === 'failed';
    dimensions.push({
      code: d.code,
      label: d.displayName,
      displayName: d.displayName, // 兼容既有组件字段名
      state,
      stateText: usingPreviousData ? '已有历史数据，最近一次更新失败' : stateText,
      reason,
      note: usingPreviousData ? '已有历史数据，最近一次更新失败。' : note,
      lastObservedAt,
      firstObservedAt: firstObservedAtOfDim,
      lastAttemptAt,
      lastSuccessfulAt,
      latestAttemptStatus,
      usingPreviousData,
      observationCount,
      evidenceCount,
      sourceCount: hosts.size,
      // 失败原因：维度真失败 或 旧数据可用但最新失败，都要如实可见
      latestFailureText: failedAtt && (state === 'failed' || usingPreviousData) ? (failedAtt.errorUserText || null) : null,
      // SC-12 §三.3：失败分类（source_status / error_class）只在后台与诊断区使用；
      // 用户卡片只展示由它派生出的短状态文案（禁止出现内部码）。
      latestFailureStatus: failedAtt ? (failedAtt.sourceStatus || failedAtt.source_status || null) : null,
      latestFailureClass: failedAtt ? (failedAtt.errorClass || failedAtt.error_class || null) : null,
      capabilities: caps.map(c => ({ code: c.code, label: c.displayName, displayName: c.displayName, maturity: c.maturity })),
    });
  }

  const countOf = (s) => dimensions.filter(x => x.state === s).length;
  const summary = {
    available: countOf('available'),
    total: dimensions.length, // 来自 Registry，不硬编码
    collecting: countOf('collecting'),
    failed: countOf('failed'),
    notConfigured: countOf('not_configured'),
    notStarted: countOf('not_started'),
    empty: countOf('empty'),
  };
  // 数据积累起点：所有维度里最早的**真实观察**时间（不猜、不用档案创建时间代替）
  const firstObserved = dimensions.reduce((acc, x) => (x.firstObservedAt && (!acc || x.firstObservedAt < acc) ? x.firstObservedAt : acc), null);
  return {
    summary,
    dimensions,
    firstObservedAt: firstObserved,
    // 卡片用：真正有数据的维度名（不含「未接入/未采集」）
    dataDimensions: dimensions.filter(x => x.state === 'available').map(x => ({ code: x.code, label: x.label })),
  };
}

// ---------- 时间线：读取真值链与采集记录，写入可重建索引 ----------
function rebuildTimeline(tenantId, brandId, projectId, competitor) {
  const comp = competitor || {};
  const compId = comp.id || null;
  if (compId && projectId) {
    // 采集观察（Data Surface attempts）
    for (const cap of Registry.listCapabilities()) {
      if (cap.maturity !== 'ga') continue;
      const atts = SurfaceStore.listAttempts(tenantId, projectId, compId, cap.code, 10);
      for (const a of atts) {
        if (!a.endedAt && !a.startedAt) continue;
        // 🔴 核实状态诚实：有 Evidence/Snapshot 引用才可「已核实」，否则一律「待核实」
        const hasRefs = Array.isArray(a.evidenceIds) && a.evidenceIds.length > 0;
        const evStatus = hasRefs ? (a.status === 'failed' ? 'pending' : 'verified') : 'pending';
        BrandStore.appendTimeline({
          tenantId, brandId, kind: 'monitor', at: a.endedAt || a.startedAt, nature: 'observed',
          status: evStatus,
          title: '采集' + (a.status === 'success' ? '完成' : a.status === 'partial' ? '部分完成' : a.status === 'failed' ? '失败' : '进行中') + '：' + cap.displayName,
          detail: a.errorUserText || null, refType: 'collection_attempt', refId: a.attemptId,
          payload: { capability: cap.code, status: a.status, observationCount: a.observationCount || 0, evidenceIds: Array.isArray(a.evidenceIds) ? a.evidenceIds.slice(0, 20) : [] },
        });
      }
    }
    // 价格变化事件（DomainEvent 由 Fact 派生）——事件索引本身不带 Evidence 引用，
    try {
      const events = DomainEvent.listEvents(tenantId, { limit: 200 }) || [];
      for (const e of events) {
        if (e.entity_key && comp.url && !String(e.entity_key).includes(domainOfUrl(comp.url) || ' ')) continue;
        BrandStore.appendTimeline({
          tenantId, brandId, kind: 'price', at: e.occurred_at || e.created_at, nature: 'computed',
          status: 'pending', title: '价格变化事件', detail: e.summary || null,
          refType: 'domain_event', refId: e.event_id || null, payload: e.payload || null,
        });
      }
    } catch (e) { /* 事件目录不存在：无事件，不填充 */ }
  }
  return BrandStore.listTimeline(tenantId, brandId, { limit: 100 });
}

function timelineView(tenantId, brandId, opts) {
  return BrandStore.listTimeline(tenantId, brandId, opts).map(e => Object.assign({}, e, {
    natureText: NATURE_TEXT[e.nature] || '来源直接记录',
    statusText: INTEL_STATUS_TEXT[e.status] || '待核实',
    typeText: INTEL_TYPE_TEXT[e.kind] || e.kind,
  }));
}
// 最早观察时间（无历史接入时只展示「开始观察日期」，不暗示更早历史）
function firstObservedAt(tenantId, brandId) {
  const rows = BrandStore.listTimeline(tenantId, brandId, { limit: 200 });
  if (!rows.length) return null;
  return rows.map(r => r.at).sort()[0];
}

// ---------- 情报：按事实与变化组织 ----------
function listIntelligence(tenantId, opts) {
  const o = opts || {};
  const projectId = o.projectId || null;
  const state = projectId ? loadProjectState(tenantId, projectId) : null;
  const comps = (state && Array.isArray(state.competitors)) ? state.competitors : [];
  const out = [];
  for (const c of comps) {
    if (o.brandId) {
      const bid = BrandStore.brandIdForCompetitor(tenantId, projectId, c.id);
      if (bid !== o.brandId) continue;
    }
    const bid = BrandStore.brandIdForCompetitor(tenantId, projectId, c.id);
    const items = buildBrandIntelligence(tenantId, projectId, bid, c, o);
    out.push(...items);
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}

function buildBrandIntelligence(tenantId, projectId, brandId, comp, opts) {
  const o = opts || {};
  const items = [];
  const push = (it) => {
    if (o.type && it.type !== o.type) return;
    if (o.from && String(it.at) < String(o.from)) return;
    if (o.to && String(it.at) > String(o.to)) return;
    items.push(it);
  };
  // 采集观察 → 商品/价格情报（引用 Evidence/Snapshot）
  for (const cap of Registry.listCapabilities()) {
    if (cap.maturity !== 'ga') continue;
    const atts = SurfaceStore.listAttempts(tenantId, projectId, comp.id, cap.code, 5);
    for (const a of atts) {
      if (a.status === 'running') continue;
      const at = a.endedAt || a.startedAt;
      const evIds = Array.isArray(a.evidenceIds) ? a.evidenceIds : [];
      const evRefs = evIds.map(id => {
        const ev = EvidenceStore.getEvidenceById(tenantId, id);
        if (!ev) return null;
        return {
          evidenceId: ev.evidence_id, evidenceStatus: ev.evidence_status,
          observedAt: ev.observed_at || null, claim: ev.claim || null,
          snapshotIds: ev.source_snapshot_ids || [],
        };
      }).filter(Boolean);
      const hasEvidence = evRefs.length > 0;
      push({
        id: a.attemptId, brandId, brandName: comp.name || null, competitorId: comp.id || null,
        type: cap.code === 'shopify_catalog' ? 'product' : 'monitor',
        typeText: cap.code === 'shopify_catalog' ? '商品' : '监控状态',
        at, nature: 'observed', natureText: NATURE_TEXT.observed,
        status: hasEvidence ? (a.status === 'partial' ? 'pending' : 'verified') : (a.status === 'failed' ? 'insufficient' : 'insufficient'),
        statusText: INTEL_STATUS_TEXT[hasEvidence ? (a.status === 'partial' ? 'pending' : 'verified') : 'insufficient'],
        title: cap.displayName + '采集' + (a.status === 'success' ? '完成' : a.status === 'partial' ? '部分完成' : '失败'),
        detail: a.status === 'failed' ? (a.errorUserText || '采集失败') : `观察 ${a.observationCount || 0} 条`,
        evidence: evRefs,
        correctionEndpoint: '/api/field-correct',
        attemptId: a.attemptId, capability: cap.code,
      });
    }
  }
  // 价格变化事件（由 Fact 派生，属「按已有数据计算」）
  try {
    const events = DomainEvent.listEvents(tenantId, { limit: 100 }) || [];
    const dom = domainOfUrl(comp.url || '');
    for (const e of events) {
      if (dom && e.entity_key && !String(e.entity_key).includes(dom)) continue;
      push({
        id: e.event_id || ('ev_' + String(e.occurred_at || '')), brandId, brandName: comp.name || null, competitorId: comp.id || null,
        type: 'price', typeText: '价格', at: e.occurred_at || e.created_at,
        nature: 'computed', natureText: NATURE_TEXT.computed,
        status: 'pending', statusText: INTEL_STATUS_TEXT.pending,
        title: '价格变化', detail: e.summary || null,
        evidence: [], correctionEndpoint: '/api/field-correct', refType: 'domain_event', refId: e.event_id || null,
      });
    }
  } catch (e) { /* 无事件目录 */ }
  // r4.10：未接入维度不再生成情报事件。「XX：未接入」是项目级数据覆盖状态，
  // 不是某品牌在某时刻发生的竞争变化——带时间戳/状态徽章地混进时间线属于噪音，
  // 且随品牌数量成倍重复。建设中维度改由 constructionDimensions() 项目级
  // 独立字段承载（前端在情报库底部单一去重区域呈现）。
  // 真实采集失败 / 部分采集 / 已观察变化（上方两段）不受影响。
  return items;
}

// ---------- 项目级建设中维度（r4.10） ----------
// 未接入维度的唯一展示口径：与 buildCoverage 的 unsupported 判定同口径
// （该维度下无 ga 能力 → 未接入）；按 code 去重恰一条；纯静态投影——
// 不含品牌 ID、事件 ID、时间戳、Evidence/Snapshot 或任何模拟数据。
// 暴露路径在租户鉴权后的 /api/intelligence 内，天然 tenant/project scoped。
function attemptHasEvidenceBackedData(tenantId, attempt) {
  if (!attempt || !['success', 'partial'].includes(attempt.status)) return false;
  const evidenceIds = Array.isArray(attempt.evidenceIds) ? attempt.evidenceIds : [];
  const attemptSnapshotIds = new Set(Array.isArray(attempt.snapshotIds) ? attempt.snapshotIds : []);
  if (!evidenceIds.length || !attemptSnapshotIds.size) return false;
  for (const evidenceId of evidenceIds) {
    let evidence = null;
    try { evidence = EvidenceStore.getEvidenceById(tenantId, evidenceId); } catch (e) { evidence = null; }
    if (!evidence || evidence.evidence_status !== 'verified') continue;
    const evidenceSnapshotIds = Array.isArray(evidence.source_snapshot_ids) ? evidence.source_snapshot_ids : [];
    for (const snapshotId of evidenceSnapshotIds) {
      if (!attemptSnapshotIds.has(snapshotId)) continue;
      let snapshot = null;
      try { snapshot = Snapshot.getById(tenantId, snapshotId); } catch (e) { snapshot = null; }
      if (snapshot && snapshot.raw_payload_ref && snapshot.raw_payload_ref.path) return true;
    }
  }
  return false;
}

// 某 capability 在 scope 内只有存在「成功/部分成功 + Evidence + 同 attempt Snapshot」
// 才算真正可展示数据。running、failed、无证据的测试或损坏记录均不能掩盖建设中状态。
function capabilityHasEvidenceBackedData(tenantId, projectId, competitorIds, capability) {
  for (const competitorId of competitorIds || []) {
    if (!competitorId) continue;
    let attempts = [];
    try { attempts = SurfaceStore.listAttempts(tenantId, projectId, competitorId, capability, 20); } catch (e) { attempts = []; }
    if (attempts.some(a => attemptHasEvidenceBackedData(tenantId, a))) return true;
  }
  return false;
}

// ---------- 项目/品牌范围建设中维度（r4.10 + r6） ----------
// 这仍是底部单一、去重的覆盖投影，不是情报事件。它必须与真实数据面一致：
// pending_config 能力一旦在当前 scope 有 Evidence 支持的可展示数据，就从建设中列表移除。
// 无 brandId 时按项目所有品牌判断；传 brandId 时只按该品牌在当前项目的 competitor 判断。
function constructionDimensions(tenantId, projectId, brandId) {
  if (!tenantId || !projectId) return [];
  const state = loadProjectState(tenantId, projectId);
  const allCompetitors = (state && Array.isArray(state.competitors)) ? state.competitors : [];
  let competitorIds = allCompetitors.map(c => c && c.id).filter(Boolean);
  if (brandId) {
    const link = BrandStore.getLink(tenantId, brandId, projectId);
    if (!link || !link.competitorRef) return [];
    competitorIds = [link.competitorRef];
  }
  const out = [];
  for (const d of Registry.listDimensions()) {
    const caps = Registry.capabilitiesByDimension(d.code);
    const ga = caps.filter(c => c.maturity === 'ga');
    if (ga.length) continue;
    // SC-06 r2：待验证（能力就绪、尚无真实成功）与需配置（缺凭据）分开报，不混成一类
    const pendingVerify = caps.filter(c => c.maturity === 'pending_verification');
    if (pendingVerify.some(c => capabilityHasEvidenceBackedData(tenantId, projectId, competitorIds, c.code))) continue;
    if (pendingVerify.length) {
      out.push({
        code: d.code,
        displayName: d.displayName,
        state: 'pending_verification',
        message: '能力已实现，但尚未完成一次真实采集验证；验证前不展示数据、估算或结论。',
      });
      continue;
    }
    const pending = caps.filter(c => c.maturity === 'pending_config');
    if (pending.some(c => capabilityHasEvidenceBackedData(tenantId, projectId, competitorIds, c.code))) continue;
    if (pending.length) {
      out.push({
        code: d.code,
        displayName: d.displayName,
        state: 'pending_config',
        message: '尚未采到可核验数据，当前不生成数据、估算或结论。',
      });
    } else {
      out.push({
        code: d.code,
        displayName: d.displayName,
        state: 'not_integrated',
        message: '尚未接入，当前不生成数据、估算或结论。',
      });
    }
  }
  return out;
}

// ---------- 官网确认状态（SC-06 二） ----------
// 语义：official_site_profile（通用官网公开资料）有真实成功采集 → 「官网已确认」；
// 只有失败无成功 → 「来源暂不可达」（不是「官网不支持」）；从未采集 → 「未采集」。
// Shopify 目录接口是否可用不影响本状态（两能力分离）。
function buildOfficialSiteStatus(tenantId, projectId, competitor) {
  const comp = competitor || {};
  if (!comp.id) return { status: 'not_collected', statusText: '未采集' };
  let atts = [];
  try { atts = SurfaceStore.listAttempts(tenantId, projectId, comp.id, 'official_site_profile', 10); } catch (e) { atts = []; }
  const usable = atts.find(a => a.status === 'success' || a.status === 'partial');
  if (usable) {
    const sum = usable.summary || {};
    return {
      status: 'confirmed', statusText: '官网已确认',
      lastCollectedAt: usable.endedAt || usable.startedAt || null,
      canonical: sum.canonical || null,
      siteName: sum.siteName || null,
      hasOrganization: !!sum.hasOrganization,
      sampleNote: '确认依据：公开页面成功采集（含快照与证据引用）',
    };
  }
  if (atts.length) return { status: 'unavailable', statusText: '来源暂不可达', lastAttemptAt: atts[0].startedAt || null };
  return { status: 'not_collected', statusText: '未采集' };
}

// ---------- 官网公开商品状态（SC-06 r2：成熟度与真实验证分开表达） ----------
// 第四层区分「当前品牌已有可展示证据」：只看本品牌本项目的 public_site_products attempt。
//   verified            已成功/部分成功采集 → 有可展示商品观察
//   unavailable         尝试过但失败（拒访/限流/不可达/无商品页可发现）→ 如实说明，不写「官网不支持」
//   not_collected       从未采集
// 与官方资料（official_site_profile）分离：Shopify 目录不可用不影响本状态。
function buildPublicProductsStatus(tenantId, projectId, competitor) {
  const comp = competitor || {};
  const cap = Registry.getCapability('public_site_products');
  const maturity = cap ? cap.maturity : null;
  if (!comp.id) return { status: 'not_collected', statusText: '未采集', maturity };
  let atts = [];
  try { atts = SurfaceStore.listAttempts(tenantId, projectId, comp.id, 'public_site_products', 10); } catch (e) { atts = []; }
  // 🔴 r2：只有「真的拿到了商品观察」才算已采集——partial 但 0 条观察（如商品页全被限流）
  // 不得显示为已采集；这类情况如实说明来源限制。
  const usable = atts.find(a => {
    if (a.status !== 'success' && a.status !== 'partial') return false;
    const observations = Array.isArray(a.observations) ? a.observations : [];
    const sum = a.summary || {};
    return observations.length > 0 || (typeof sum.productCount === 'number' && sum.productCount > 0);
  });
  if (usable) {
    const sum = usable.summary || {};
    const n = Array.isArray(usable.observations) ? usable.observations.length : (typeof sum.productCount === 'number' ? sum.productCount : null);
    return {
      status: 'verified', statusText: '已采集到公开商品页观察', maturity,
      lastCollectedAt: usable.endedAt || usable.startedAt || null,
      observedCount: n,
      discoveryPath: sum.discoveryPath || null,
      sampleNote: sum.sampleNote || '样本来自公开商品页（含快照与证据引用），受发现路径限制，不代表全量商品',
    };
  }
  if (atts.length) {
    const last = atts[0];
    // 诚实区分两种「没有商品可展示」：
    //   ① 页面读到了，但没有可识别的公开商品数据（不是失败）
    //   ② 页面根本没读到（拒访/不可达/解析失败）——这才是「采集未成功」
    const reachedPage = atts.some(a => a.status === 'success' || a.status === 'partial');
    return {
      status: 'unavailable',
      statusText: reachedPage ? '页面已读取，但未发现可展示的公开商品' : '最近一次公开商品页采集未成功',
      maturity,
      lastAttemptAt: last.startedAt || null,
      failureText: reachedPage
        ? '官网页面已成功读取，但没有可安全识别的公开商品信息（价格/结构化商品数据）。'
        : (last.errorUserText || '来源暂不可达，稍后可重试。'),
      note: '这不代表官网不支持或没有商品；可能没有可发现的商品页（无 sitemap / 无 JSON-LD Product）。',
    };
  }
  return {
    status: 'not_collected', statusText: '未采集', maturity,
    note: '该能力已实现但尚无一次真实成功采集验证；验证完成前不展示商品数据。',
  };
}

// ---------- 采集状态（SC-07 §1/§3） ----------
// 逐品牌表达「排队中 / 采集中 / 有证据数据 / 检查完成但无结果 / 失败 / 来源待配置」，
// 全部从真实 attempt / job / readiness 派生——不再用一句「尚未开始采集」盖住所有情况。
const COLLECTION_STATE_TEXT = Object.freeze({
  queued: '排队中',
  collecting: '采集中',
  has_data: '有证据数据',
  empty: '检查完成但无结果',
  failed: '采集失败',
  source_pending: '来源待配置',
  not_started: '尚未开始采集',
});

function buildCollectionState(tenantId, projectId, comp) {
  const c = comp || {};
  const out = { state: 'not_started', stateText: COLLECTION_STATE_TEXT.not_started, observedDimensions: 0, lastAttemptAt: null, reason: null };
  if (!c.id) return out;
  let atts = [];
  try { atts = (SurfaceStore.listAttemptsByCompetitor ? SurfaceStore.listAttemptsByCompetitor(tenantId, projectId, c.id, 50) : SurfaceStore.listAttempts(tenantId, projectId, c.id, 'official_site_profile', 20)) || []; } catch (e) { atts = []; }
  let pendingJobs = 0;
  try {
    const db = require('./collect-jobs.js').getDb();
    pendingJobs = db.prepare(
      "SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=? AND status IN ('pending','claimed')"
    ).get(tenantId, projectId, c.id).n;
  } catch (e) { pendingJobs = 0; }
  const running = atts.find(a => a.status === 'running') || null;
  const ok = atts.filter(a => a.status === 'success' || a.status === 'partial');
  const failed = atts.filter(a => a.status === 'failed');
  const obsCount = ok.reduce((n, a) => n + ((Array.isArray(a.observations) ? a.observations.length : 0)), 0);
  const last = atts[0] || null;
  // SC-08 r3 §三：拆分「最近一次任意采集」与「最近一次成功采集」——
  // atts 按 started_at DESC，ok 里第一个就是最近一次 success/partial
  const okWithData = ok.filter(a => (Array.isArray(a.observations) ? a.observations.length : 0) > 0);
  const lastSuccessful = okWithData[0] || null;
  const dims = new Set(okWithData.map(a => a.dimension));
  out.observedDimensions = dims.size;
  out.lastAttemptAt = last ? (last.endedAt || last.startedAt || null) : null;
  out.lastSuccessfulAt = lastSuccessful ? (lastSuccessful.endedAt || lastSuccessful.startedAt || null) : null;
  out.latestAttemptStatus = last ? last.status : null;
  if (running || pendingJobs > 0) {
    out.state = running ? 'collecting' : 'queued';
    out.stateText = COLLECTION_STATE_TEXT[out.state];
    return out;
  }
  if (ok.length && obsCount > 0) { out.state = 'has_data'; out.stateText = COLLECTION_STATE_TEXT.has_data; return out; }
  if (ok.length && obsCount === 0) {
    out.state = 'empty'; out.stateText = COLLECTION_STATE_TEXT.empty;
    out.reason = '本轮检查完成但未观察到可归属数据';
    return out;
  }
  if (failed.length) {
    out.state = 'failed'; out.stateText = COLLECTION_STATE_TEXT.failed;
    out.reason = (last && (last.errorUserText || last.errorClass)) || '采集失败';
    return out;
  }
  // 从未采集：区分「来源待配置」与「尚未开始」
  try {
    const Registry = require('./capability-registry.js');
    const Readiness = require('./source-readiness.js');
    const caps = Registry.listCapabilities().filter(x => x.maturity !== 'not_integrated');
    const anyConfigured = caps.some(x => Readiness.getReadiness(x.code).state !== 'not_configured');
    if (!anyConfigured) {
      out.state = 'source_pending'; out.stateText = COLLECTION_STATE_TEXT.source_pending;
      out.reason = '数据来源尚未配置，暂不能采集';
    }
  } catch (e) { /* 保持 not_started */ }
  return out;
}

// 项目级采集覆盖：按状态计数 + 失败明细（情报库/竞品数据库共用）
function buildProjectCollectionCoverage(tenantId, projectId) {
  syncProjectBrands(tenantId, projectId);
  const state = loadProjectState(tenantId, projectId);
  const brands = BrandStore.listBrandLinksForProject(tenantId, projectId) || [];
  const counts = { queued: 0, collecting: 0, has_data: 0, empty: 0, failed: 0, source_pending: 0, not_started: 0 };
  const failures = [];
  for (const b of brands) {
    const comp = b.competitorRef ? findCompetitor(state, b.competitorRef) : null;
    const cs = buildCollectionState(tenantId, projectId, comp || {});
    counts[cs.state] = (counts[cs.state] || 0) + 1;
    if (cs.state === 'failed' && failures.length < 20) {
      failures.push({ brandId: b.brandId, brandName: b.canonicalName || null, competitorId: b.competitorRef || null, reason: cs.reason, at: cs.lastAttemptAt });
    }
  }
  return {
    brands: brands.length, counts, failures,
    stateText: COLLECTION_STATE_TEXT,
    anyInFlight: counts.queued + counts.collecting > 0,
    note: '状态由真实采集任务与 attempt 派生，随任务进展更新。',
  };
}

// ---------- 正式监控状态（卡片「正式监控状态」列的唯一口径） ----------
// 只读 WatchTarget + 监控意向：意向在进行中 ≠ 监控中（01 §16 不得混淆）。
function buildMonitoringState(tenantId, projectId, competitor) {
  const comp = competitor || {};
  const out = { state: 'none', stateText: '未加入监控', signals: [], signalsText: null, sinceAt: null };
  if (!comp.id) return out;
  try {
    const WS = require('./watch-store.js');
    const t = (WS.listWatchTargets(tenantId, projectId) || []).find(x => x.competitorId === comp.id) || null;
    if (t && (t.monitoringStatus === 'active' || t.monitoringStatus === 'degraded')) {
      const SIG_TEXT = { price: '价格', site_change: '官网内容', launch: '上新', stock: '库存' };
      const sigs = (t.enabledSignals || []).map(s => SIG_TEXT[s] || s);
      return {
        state: t.monitoringStatus === 'degraded' ? 'degraded' : 'active',
        stateText: t.monitoringStatus === 'degraded' ? '监控降级运行' : '正式监控中',
        signals: t.enabledSignals || [],
        signalsText: sigs.length ? '信号：' + sigs.join('、') : null,
        sinceAt: t.baselineStartedAt || t.createdAt || null,
        lastSuccessAt: t.lastSuccessAt || null,
        freshness: t.freshnessStatus || 'unknown',
      };
    }
    if (t && t.monitoringStatus === 'paused') {
      return { state: 'paused', stateText: '监控已暂停', signals: t.enabledSignals || [], signalsText: null, sinceAt: t.createdAt || null };
    }
  } catch (e) { /* watch_targets 不可用：按未加入处理 */ }
  try {
    const WIntent = require('./watch-intent.js');
    const it = WIntent.findIntent(tenantId, projectId, comp.id);
    if (it) {
      if (it.state === 'establishing') return { state: 'establishing', stateText: '正在建立监控来源', signals: [], signalsText: null, sinceAt: it.createdAt || null, nextStepText: WIntent.nextStepText(it) };
      if (it.state === 'source_failed') return { state: 'source_failed', stateText: '监控来源建立失败', signals: [], signalsText: null, sinceAt: it.createdAt || null, nextStepText: WIntent.nextStepText(it) };
    }
  } catch (e) { /* 无意向 */ }
  return out;
}

// ---------- 最近一次可核验变化（只认收件箱真源的 verified 事件） ----------
function latestVerifiedChange(tenantId, projectId, competitorId) {
  if (!competitorId) return null;
  try {
    const Inbox = require('./intel-inbox.js');
    const ev = Inbox.latestVerifiedEvent(tenantId, projectId, competitorId);
    if (!ev) return null;
    return { at: ev.observedAt, dimension: ev.dimension, eventType: ev.eventType, title: ev.title, eventId: ev.eventId };
  } catch (e) { return null; }
}

// ---------- SC-09：商品视图（只聚合同一维度的两个**商品**能力） ----------
// 缺陷修复：website_products 维度同时含 official_site_profile，直接取维度 observations
// 会把「官网资料观察」当成商品展示（Grovemade 真实数据实测：只显示 1 条而非 10 件商品）。
function buildProductsView(tenantId, projectId, comp) {
  const out = { observations: [], summary: null, attemptId: null, collectedAt: null, evidenceRefs: [] };
  if (!comp || !comp.id) return out;
  const caps = ['shopify_catalog', 'public_site_products'];
  const seen = new Set();
  let latestAt = null, latestAttempt = null, discoveryPath = null;
  for (const cap of caps) {
    let atts = [];
    try { atts = SurfaceStore.listAttempts(tenantId, projectId, comp.id, cap, 5) || []; } catch (e) { atts = []; }
    const usable = atts.find(a => a && (a.status === 'success' || a.status === 'partial')
      && Array.isArray(a.observations) && a.observations.length > 0);
    if (!usable) continue;
    const at = usable.endedAt || usable.startedAt || null;
    if (at && (!latestAt || at > latestAt)) { latestAt = at; latestAttempt = usable; }
    if (!discoveryPath && usable.summary && usable.summary.discoveryPath) discoveryPath = usable.summary.discoveryPath;
    for (const o of usable.observations) {
      const key = String(o.id || o.sourceUrl || o.title || '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.observations.push(o);
    }
    // 证据入口：每条可用 attempt 的 Evidence（引用其快照集合）
    for (const eid of (usable.evidenceIds || [])) {
      out.evidenceRefs.push({
        evidenceId: eid,
        snapshotId: (usable.snapshotIds || [])[0] || null,
        sourceUrl: usable.sourceUrl || comp.url || null,
        label: cap === 'shopify_catalog' ? '官网商品目录采集' : '官网公开商品页采集',
      });
    }
  }
  if (out.observations.length) {
    const prices = out.observations.map(o => (o && typeof o.price === 'number' ? o.price : null)).filter(v => v != null);
    const currencies = Array.from(new Set(out.observations.map(o => (o && o.currency) || null).filter(Boolean)));
    out.summary = {
      productCount: out.observations.length,
      priceObservedCount: prices.length,
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      currencies,
      // 单币种时给出 currency（与既有口径/测试兼容）；多币种时留 null，逐商品币种仍保留
      currency: currencies.length === 1 ? currencies[0] : null,
      currencyStatus: currencies.length === 1 ? 'confirmed' : 'unknown',
      discoveryPath: discoveryPath,
      sampleNote: '样本为公开页面可安全识别的商品（发现路径受限），非全量商品清单，不推断销量',
    };
    out.attemptId = latestAttempt ? latestAttempt.attemptId : null;
    out.collectedAt = latestAt;
  }
  return out;
}

// ---------- SC-09 §四：品牌卡片的真实采集摘要（只读 attempt/summary，不推断、不补 0） ----------
// 与「覆盖投影」分工：brandCoverage 表达维度状态；本摘要表达用户能看懂的事实
//（商品数/价格区间/评论页数/内容数/热度与广告的覆盖状态/最近成功与最近失败）。
function buildCollectionDigest(tenantId, projectId, comp) {
  const c = comp || {};
  const out = {
    products: null, reviews: null, social: null, search: null, ads: null,
    lastSuccessAt: null, lastFailureText: null,
  };
  if (!c.id) return out;
  let atts = [];
  try { atts = SurfaceStore.listAttemptsByCompetitor(tenantId, projectId, c.id, 100) || []; } catch (e) { atts = []; }
  const usable = atts.filter(a => (a.status === 'success' || a.status === 'partial')
    && (Array.isArray(a.observations) ? a.observations.length : 0) > 0);

  // 最近成功（任意能力）
  for (const a of usable) {
    const at = a.endedAt || a.startedAt || null;
    if (at && (!out.lastSuccessAt || at > out.lastSuccessAt)) out.lastSuccessAt = at;
  }
  // 最近失败原因（最新一次失败 attempt；成功后不再作为当前提醒）
  const latest = atts[0] || null;
  if (latest && latest.status === 'failed') out.lastFailureText = latest.errorUserText || '最近一次采集失败，可稍后重试。';

  const firstOf = (caps) => usable.find(a => caps.includes(a.capability)) || null;

  // 商品与价格区间（website_products 两能力任一）
  const pa = firstOf(['shopify_catalog', 'public_site_products']);
  if (pa) {
    const obs = Array.isArray(pa.observations) ? pa.observations : [];
    const prices = obs.map(o => (o && typeof o.price === 'number' ? o.price : null)).filter(v => v != null);
    const currencies = Array.from(new Set(obs.map(o => (o && o.currency) || null).filter(Boolean)));
    out.products = {
      count: obs.length,
      priceMin: prices.length ? Math.min(...prices) : null,
      priceMax: prices.length ? Math.max(...prices) : null,
      currencies,
      collectedAt: pa.endedAt || pa.startedAt || null,
    };
  }
  // 公开评论页（页数 + 摘要里的评论总数）
  const ra = firstOf(['public_reviews']);
  if (ra) {
    const obs = Array.isArray(ra.observations) ? ra.observations : [];
    const sum = ra.summary || {};
    out.reviews = {
      pageCount: obs.length,
      reviewCount: typeof sum.reviewCount === 'number' ? sum.reviewCount : null,
      collectedAt: ra.endedAt || ra.startedAt || null,
    };
  }
  // 社媒内容
  const sa = firstOf(['youtube_content', 'tiktok_commercial_content']);
  if (sa) {
    const obs = Array.isArray(sa.observations) ? sa.observations : [];
    out.social = { count: obs.length, platform: sa.capability === 'youtube_content' ? 'youtube' : 'tiktok', collectedAt: sa.endedAt || sa.startedAt || null };
  }
  // 搜索热度：只有真实可用的 DataForSEO 观测才算；否则如实报 ready/not_configured
  const sea = firstOf(['dataforseo_trends']);
  if (sea) {
    out.search = { state: 'available', collectedAt: sea.endedAt || sea.startedAt || null, measurement: '数据服务估算' };
  } else {
    let st = 'not_started';
    try { if (Readiness.getReadiness('dataforseo_trends').state === 'not_configured') st = 'not_configured'; } catch (e) { st = 'not_started'; }
    out.search = { state: st, collectedAt: null, measurement: null };
  }
  // 广告覆盖：来源覆盖范围 × 品牌市场（未覆盖不等于 0 条广告）
  // SC-09 r3 §二：市场走唯一解析入口（competitor.market → project intent.regions[0]）
  try {
    const TikTok = require('../lib/tiktok-adlib.js');
    const intent = (loadProjectState(tenantId, projectId) || {}).intent || {};
    const mk = require('../lib/brand-market.js').resolveBrandMarket(c, intent);
    out.ads = {
      coverage: mk.coverageState, brandMarket: mk.brandMarket,
      marketSource: mk.source,
      note: TikTok.coverageNoteFor(mk.coverageState, mk.brandMarket),
    };
  } catch (e) { out.ads = { coverage: 'unknown', brandMarket: null, marketSource: null, note: null }; }
  return out;
}

// ---------- 品牌视图 ----------

// SC-12 §三.3：品牌卡片短状态（用户可见的唯一真源）
// 规则：
//   · 当前状态由最新一次有效 attempt 决定（历史 internal_error 不得继续占据卡片主状态）；
//   · 有历史数据 + 最近一次失败 → 数据保留 + 标「已有历史数据，最近更新失败」；
//   · 只输出短状态词与一句短提示；禁止出现 attempt / source_status / internal_error /
//     adapter_output_invalid / jobId 等内部细节（详细原因只在「数据覆盖与来源」）。
function cardStatusOf(coverage) {
  const dims = (coverage && coverage.dimensions) || [];
  const collecting = dims.filter(d => d.state === 'collecting');
  const stale = dims.filter(d => d.usingPreviousData);
  const failed = dims.filter(d => d.state === 'failed');
  const available = dims.filter(d => d.state === 'available');
  const notConfigured = dims.filter(d => d.state === 'not_configured');
  if (collecting.length) return { code: 'collecting', text: '正在采集', detail: null };
  if (stale.length) {
    return {
      code: 'stale', text: '已有历史数据，最近更新失败',
      detail: '数据保留，' + stale.length + ' 个维度可重新检查',
    };
  }
  if (failed.length) {
    const d0 = failed[0];
    const ss = d0.latestFailureStatus || '';
    if (ss === 'unavailable' || ss === 'timeout') return { code: 'source_unreachable', text: '来源暂时不可达', detail: '可稍后重新检查' };
    if (ss === 'blocked') return { code: 'source_blocked', text: '来源拒绝了本次访问', detail: '可在数据覆盖与来源查看' };
    if (ss === 'rate_limited') return { code: 'source_rate_limited', text: '来源访问频率受限', detail: '可稍后重新检查' };
    if (ss === 'parse_failed') return { code: 'source_parse_failed', text: '来源内容暂时无法解析', detail: '原始数据已保留' };
    return { code: 'needs_attention', text: '采集未完成，需要重试', detail: '可在数据覆盖与来源查看原因' };
  }
  if (available.length) {
    const partial = dims.some(d => d.state === 'available' && d.latestAttemptStatus === 'partial');
    return { code: partial ? 'partial' : 'updated', text: partial ? '部分数据待更新' : '已更新', detail: null };
  }
  if (notConfigured.length && notConfigured.length === dims.length) {
    return { code: 'awaiting_config', text: '等待系统数据服务配置', detail: null };
  }
  return { code: 'not_started', text: '尚未开始采集', detail: null };
}
function listBrandViews(tenantId, projectId) {
  syncProjectBrands(tenantId, projectId);
  const state = loadProjectState(tenantId, projectId);
  // 🔴 项目级字段（competitor_ref/market/category/relation）以 brand_project_links 为准
  const brands = BrandStore.listBrandLinksForProject(tenantId, projectId);
  return brands.map((b) => {
    const comp = b.competitorRef ? findCompetitor(state, b.competitorRef) : null;
    const bc = buildBrandCoverage(tenantId, projectId, comp || {});
    const tl = BrandStore.listTimeline(tenantId, b.brandId, { limit: 5 });
    const last = tl[0] || null;
    return {
      brandId: b.brandId, name: b.canonicalName, officialDomain: b.officialDomain,
      market: b.market, category: b.category, relation: b.relation,
      competitorId: b.competitorRef,
      // SC-08 r2 §六：唯一覆盖投影（列表与详情同源同口径）
      brandCoverage: bc,
      officialSite: buildOfficialSiteStatus(tenantId, projectId, comp || {}),
      publicProducts: buildPublicProductsStatus(tenantId, projectId, comp || {}),
      // SC-07 §3：逐品牌真实采集状态（排队/采集/有数据/空/失败/来源待配置）
      collection: buildCollectionState(tenantId, projectId, comp || {}),
      // SC-08 r2 §四：卡片必需的「正式监控状态」与「最近一次可核验变化」
      monitoring: buildMonitoringState(tenantId, projectId, comp || {}),
      lastVerifiedChange: latestVerifiedChange(tenantId, projectId, b.competitorRef),
      firstObservedAt: firstObservedAt(tenantId, b.brandId) || bc.firstObservedAt || null,
      lastObservedAt: last ? last.at : (bc.dimensions.reduce((acc, d) => (d.lastObservedAt && (!acc || d.lastObservedAt > acc) ? d.lastObservedAt : acc), null)),
      // SC-09 §四：卡片真实摘要（商品/价格区间/评论/社媒/热度/广告覆盖/最近成功与失败）
      collectionDigest: buildCollectionDigest(tenantId, projectId, comp || {}),
      // SC-12 §三.3：卡片短状态（首页卡片只显示这个，不显示长错误段落）
      status: cardStatusOf(bc),
    };
  });
}

// 竞品数据库首页统计（与卡片同源派生，禁止前端各自算一套）
function buildBrandsProjectStats(views, opts) {
  const list = Array.isArray(views) ? views : [];
  const o = opts || {};
  const accumulating = list.filter(b => b.brandCoverage && b.brandCoverage.summary.available > 0).length;
  const collecting = list.filter(b => b.collection && (b.collection.state === 'collecting' || b.collection.state === 'queued')).length;
  const needsAttention = list.filter(b => {
    const bc = b.brandCoverage || { summary: {} };
    const cs = b.collection || {};
    // SC-08 r3 §三：「旧数据仍可用但最新采集失败」（usingPreviousData）也要计入需要处理
    // SC-09：首采批次里任一能力失败（如公开商品页被拒）同样计入「需要处理」
    const fc = o.fcByBrand && b.competitorId ? o.fcByBrand[b.competitorId] : null;
    return cs.state === 'failed' || cs.state === 'source_pending' || (b.monitoring && b.monitoring.state === 'source_failed')
      || (bc.summary && bc.summary.failed > 0)
      || (Array.isArray(bc.dimensions) && bc.dimensions.some(d => d.usingPreviousData))
      || !!(fc && fc.hasFailure);
  }).length;
  return { brands: list.length, accumulating, collecting, needsAttention };
}

// 品牌详情：显式 projectId 边界。品牌必须已关联该项目（getLink 校验），
// 竞品数据按该项目的链接 competitor_ref 读取——同一品牌挂多项目时各读各的数据。
function getBrandView(tenantId, brandId, projectId) {
  const brand = BrandStore.getBrand(tenantId, brandId);
  if (!brand) return null;
  const link = projectId ? BrandStore.getLink(tenantId, brandId, projectId) : null;
  if (!link) return null; // 未关联该项目 / 未给项目 → 上层 404，不猜测项目
  const links = BrandStore.linksForBrand(tenantId, brandId);
  const competitorId = link.competitorRef || null;
  const state = loadProjectState(tenantId, projectId);
  const comp = competitorId ? findCompetitor(state, competitorId) : null;
  const bc = buildBrandCoverage(tenantId, projectId, comp || {});
  // 商品与价格（来自 Data Surface 已采集 attempt，不复制真值）
  // 商品视图：只聚合同维度的两个商品能力（不把官网资料观察当商品）
  let products = { observations: [], summary: null, attemptId: null, collectedAt: null, evidenceRefs: [] };
  if (comp) {
    try { products = buildProductsView(tenantId, projectId, comp); }
    catch (e) { /* 不可读：保持空，不填充 */ }
  }
  // SC-09 §四：详情 Tab 必须展示真实 observations + 证据入口（不得只报覆盖数字）
  const dimensionDetails = {};
  if (comp) {
    for (const dim of ['reviews_reputation', 'social_content', 'search_interest', 'ad_campaigns']) {
      try {
        const det = Surface.buildDimensionDetail({ tenantId, projectId, competitorId: comp.id, dimension: dim, offset: 0, limit: 30, comp });
        dimensionDetails[dim] = {
          observations: det.observations || [],
          summary: det.summary || null,
          attemptId: det.attemptId || null,
          collectedAt: det.collectedAt || null,
          surfaceState: det.surfaceState || null,
          evidenceRefs: (det.evidenceRefs || []).map(r => ({
            evidenceId: r.evidenceId || null, snapshotId: r.snapshotId || null,
            sourceUrl: r.sourceUrl || null, label: r.label || null,
          })),
        };
      } catch (e) { dimensionDetails[dim] = { observations: [], summary: null, attemptId: null, collectedAt: null, evidenceRefs: [] }; }
    }
  }
  const collection = buildCollectionState(tenantId, projectId, comp || {});
  const monitoring = buildMonitoringState(tenantId, projectId, comp || {});
  return {
    brand: {
      brandId: brand.brandId, name: brand.canonicalName, officialDomain: brand.officialDomain,
      market: link.market != null ? link.market : brand.market,
      category: link.category != null ? link.category : brand.category,
      relation: link.relation != null ? link.relation : brand.relation,
      competitorId,
      firstObservedAt: firstObservedAt(tenantId, brandId) || bc.firstObservedAt || null,
      dataAccumulationStart: bc.firstObservedAt || null,
    },
    projectId,
    links,
    // 🔴 唯一覆盖投影：用户侧不再有第二个「覆盖摘要」口径
    brandCoverage: bc,
    officialSite: buildOfficialSiteStatus(tenantId, projectId, comp || {}),
    publicProducts: buildPublicProductsStatus(tenantId, projectId, comp || {}),
    collection,
    monitoring,
    lastVerifiedChange: latestVerifiedChange(tenantId, projectId, competitorId),
    unifiedVoice: VoiceUnified.buildUnifiedVoice({ tenantId, projectId, brandId, competitorId: comp ? comp.id : null, comp: comp || {} }),
    products,
    dimensionDetails: dimensionDetails,
    collectionDigest: buildCollectionDigest(tenantId, projectId, comp || {}),
    timeline: timelineView(tenantId, brandId, { limit: 100 }),
    intelligence: comp ? buildBrandIntelligence(tenantId, projectId, brandId, comp, {}) : [],
    reports: BrandStore.listReports(tenantId, projectId).filter(r => {
      const scope = r.scope || {};
      return !Array.isArray(scope.brandIds) || scope.brandIds.length === 0 || scope.brandIds.includes(brandId);
    }).map(r => ({ reportId: r.reportId, version: r.version, status: r.status, createdAt: r.createdAt, finishedAt: r.finishedAt, scope: r.scope })),
  };
}

module.exports = {
  NATURE_TEXT, INTEL_STATUS_TEXT, INTEL_TYPE_TEXT, COVER_STATE_TEXT,
  syncProjectBrands, loadProjectState, findCompetitor, domainOfUrl,
  buildCoverage, rebuildTimeline, timelineView, firstObservedAt,
  listIntelligence, buildBrandIntelligence, constructionDimensions,
  listBrandViews, getBrandView, buildOfficialSiteStatus, buildPublicProductsStatus,
  buildCollectionState, buildProjectCollectionCoverage, COLLECTION_STATE_TEXT,
  buildBrandCoverage, BRAND_COVER_STATE_TEXT, buildMonitoringState, buildBrandsProjectStats, latestVerifiedChange, buildCollectionDigest, buildProductsView,
};
