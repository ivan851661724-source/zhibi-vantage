'use strict';
// ============================================================
// state-summary.js —— 工作台首屏摘要投影片（2026-11 r3 §四）
// ------------------------------------------------------------
// 背景：完整 /api/state 响应 1,137,527 字节（20 个品牌），单品牌 51KB，
// 其中 attempts 20.4KB / evidenceList 8.9KB / fieldSources 7.9KB 合计占 73%，
// 公网下载 9.6–30.2 秒 → 首屏与失败横幅都要等十几秒。摘要只投影首屏真正需要的字段。
//
// 铁律：
//   1. 只读投影。**绝不**原地删除/改写传入的完整 state 对象
//      （历史事故：trimEvidenceRefs 原地裁剪污染了 OPP_CACHE，导致 scope=full 失效）。
//   2. 不重算业务口径。摘要取自**同一份已 decorate 的真值**，
//      禁止在这里另算一套 relationship / status / phase。
//   3. 品牌集合、顺序、当前状态、错误分类必须与完整接口逐项一致（§四.6）。
//   4. 不出现 attempts / evidenceList / fieldSources / Snapshot 正文 / 报告正文 / 大时间线。
// ============================================================

// 单个品牌摘要字段（§四.3 规定的最多 9 项 + 用于一致性校验的已核验条数）
// evidenceCount 是「已核验变化数量」的载体：§四.6 要求 summary 与 full 的
// 「已核验变化数量一致」，没有这个数值就无法校验，故保留一个标量。
const COMPETITOR_SUMMARY_KEYS = [
  'competitorId',
  'brandName',
  'officialUrl',
  'relationship',
  'currentStatus',
  'latestVerifiedChange',
  'coverageSummary',
  'monitoringSummary',
  'updatedAt',
  'evidenceCount',
];

// 最近一条已核验动作：只投影已有事实（recentActions.action / recentMoves[0]），不新造判断
function latestVerifiedChangeOf(c) {
  if (!c || typeof c !== 'object') return null;
  const ra = c.recentActions;
  if (ra && typeof ra === 'object' && ra.hasAction !== false && ra.action && typeof ra.action === 'object') {
    const a = ra.action;
    return {
      type: a.type || null,
      summary: a.desc || a.label || null,
      at: a.when || null,
      basis: a.basis || (ra.kind === 'verified' ? 'verified' : null),
    };
  }
  const rm = Array.isArray(c.recentMoves) ? c.recentMoves[0] : null;
  if (rm && typeof rm === 'object') {
    return {
      type: rm.type || null,
      summary: rm.desc || null,
      at: rm.when || null,
      basis: rm.basis || null,
    };
  }
  return null;
}

// 覆盖摘要：只用已有的标量/计数，不做覆盖率推算（覆盖率口径在 /api/brands 的 healthSummary）
function coverageSummaryOf(c) {
  if (!c || typeof c !== 'object') return null;
  const cats = Array.isArray(c.categoryCoverage) ? c.categoryCoverage.length : null;
  return {
    productCount: Number.isFinite(c.productCount) ? c.productCount : null,
    categories: cats,
    priceVerified: c.priceVerified === true,
    probeRate: (c.probeHealth && Number.isFinite(c.probeHealth.rate)) ? c.probeHealth.rate : null,
  };
}

function evidenceCountOf(c) {
  if (!c || typeof c !== 'object') return 0;
  if (Number.isFinite(c.evidenceCount)) return c.evidenceCount;
  if (Array.isArray(c.evidence)) return c.evidence.length;
  return 0;
}

// 单个品牌 → 摘要（新对象；不引用原对象的可变结构以外的字段）
function projectCompetitor(c) {
  if (!c || typeof c !== 'object') return null;
  return {
    competitorId: c.id || null,
    brandName: c.name || null,
    officialUrl: c.url || null,
    relationship: c.relationship || null,
    currentStatus: c.status || null,
    latestVerifiedChange: latestVerifiedChangeOf(c),
    coverageSummary: coverageSummaryOf(c),
    // 正式监控口径由 /api/monitoring/summary 单独提供，这里不重复第二套统计
    monitoringSummary: null,
    updatedAt: c.researchedAt || null,
    evidenceCount: evidenceCountOf(c),
  };
}

// 完整 state → 首屏摘要（全新对象，调用方仍可安全使用原 state）
function buildStateSummary(s) {
  if (!s || typeof s !== 'object') return s;
  const comps = Array.isArray(s.competitors) ? s.competitors : [];
  const out = {
    scope: 'summary',
    projectId: s.projectId || null,
    track: s.track || null,
    intent: s.intent || null,
    competitors: comps.map(projectCompetitor).filter(Boolean),
    // 工作台每日变化的真实内容：材料列表本身（体积小、首屏必需）
    materials: Array.isArray(s.materials) ? s.materials : [],
    progress: s.progress || null,
    evidenceDist: s.evidenceDist || null,
    marketCurrency: s.marketCurrency || null,
    // 发现状态：与 /api/discover/status、/api/projects 同一口径（decorateState 已写入）
    discoverState: s.discoverState || null,
    discoverPhase: s.discoverPhase || null,
    discoverRun: s.discoverRun || null,
    discoverError: s.discoverError || null,
    discoverDone: s.discoverDone === true,
    discoverEmpty: s.discoverEmpty === true,
    discovering: s.discovering === true,
    // 工作台三动作裁决（小对象；Provider 需要它做水合）
    decisions: s.decisions || {},
    excluded: Array.isArray(s.excluded) ? s.excluded : [],
    excludedReasons: s.excludedReasons || {},
    suppressed: Array.isArray(s.suppressed) ? s.suppressed : [],
    // 报告正文不进摘要（§四.4）：只给「有没有 / 状态如何」
    hasBrief: !!s.brief,
    briefStatus: s.briefStatus || null,
    briefStartedAt: s.briefStartedAt || null,
  };
  return out;
}

// 摘要与完整接口的一致性自检（测试与运维探针用；不参与业务流程）
function summaryConsistency(full, summary) {
  const f = Array.isArray(full && full.competitors) ? full.competitors : [];
  const g = Array.isArray(summary && summary.competitors) ? summary.competitors : [];
  const ids = (arr, key) => arr.map((x) => String((x && x[key]) || '')).sort();
  const fid = ids(f, 'id');
  const gid = ids(g, 'competitorId');
  const statusOf = (arr, key) => arr.map((x) => String((x && x[key]) || '')).sort();
  return {
    countEqual: f.length === g.length,
    idsEqual: JSON.stringify(fid) === JSON.stringify(gid),
    statusEqual: JSON.stringify(statusOf(f, 'status')) === JSON.stringify(statusOf(g, 'currentStatus')),
    phaseEqual: String((full && full.discoverPhase) || '') === String((summary && summary.discoverPhase) || ''),
    errorEqual: String((full && full.discoverError && full.discoverError.errorCode) || '')
      === String((summary && summary.discoverError && summary.discoverError.errorCode) || ''),
    evidenceCountEqual: JSON.stringify(f.map(evidenceCountOf)) === JSON.stringify(g.map((x) => Number(x.evidenceCount) || 0)),
  };
}

module.exports = {
  buildStateSummary,
  projectCompetitor,
  summaryConsistency,
  COMPETITOR_SUMMARY_KEYS,
};
