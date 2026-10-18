'use strict';
// ============================================================
// services/report-service.js —— 调研报告：冻结事实包 + 持久化生成任务（SC-04）
//   · 生成只由用户显式触发（POST /api/reports），页面加载绝不消耗模型额度；
//   · 使用**生成时刻冻结的事实包**（facts/coverage/gaps/opportunities），
//     实时数据变化不改写已生成报告；
//   · 任务持久化（report_jobs：claim 租约 / 心跳 / reclaim / retry），
//     重启后可恢复或明确失败（retry 耗尽 → dead + report failed）；
//   · LLM 只组织已批准事实（buildReport 内部保证强制引用与校验器）；
//     LLM 不可用时返回带事实清单/引用/资料缺口的结构化报告，不伪造完整分析。
// ============================================================
const BrandStore = require('./brand-store.js');
const BrandSvc = require('./brand-service.js');
const Report = require('../research/report.js');

let workerTimer = null;
let running = false;
const HEARTBEAT_MS = 10000;
const TICK_MS = 5000;

function loadConfigSafe() {
  try { return require('../core/config.js').loadConfig(); } catch (e) { return {}; }
}

// ---------- 冻结事实包 ----------
function buildFactPack(tenantId, projectId, state, scope) {
  const facts = Report.assembleFacts(state) || [];
  const dimCov = Report.dimensionCoverage(state) || { detected: [], undetected: [] };
  const brandIds = (scope && Array.isArray(scope.brandIds) && scope.brandIds.length)
    ? scope.brandIds
    : (BrandStore.listBrands(tenantId, projectId) || []).map(b => b.brandId);
  const coverage = [];
  const gaps = [];
  for (const bid of brandIds) {
    const brand = BrandStore.getBrand(tenantId, bid);
    if (!brand) continue;
    const links = BrandStore.linksForBrand(tenantId, bid);
    const comp = brand.competitorRef && state ? BrandSvc.findCompetitor(state, brand.competitorRef) : null;
    const cov = BrandSvc.buildCoverage(tenantId, projectId, comp || {});
    coverage.push({ brandId: bid, name: brand.canonicalName, summary: cov.summary, dimensions: cov.dimensions.map(d => ({ code: d.code, state: d.state, stateText: d.stateText, lastObservedAt: d.lastObservedAt })) });
    for (const d of cov.dimensions) {
      if (d.state === 'unsupported') gaps.push({ brandId: bid, dimension: d.code, displayName: d.displayName, kind: 'not_integrated', text: '该数据源尚未接入，不提供任何数据或估算。' });
      else if (d.state === 'unknown') gaps.push({ brandId: bid, dimension: d.code, displayName: d.displayName, kind: 'not_collected', text: '尚未采集（不等于未发现数据）。' });
      else if (d.state === 'failed') gaps.push({ brandId: bid, dimension: d.code, displayName: d.displayName, kind: 'collect_failed', text: '最近采集失败，当前展示上次成功数据。' });
      else if (d.state === 'partial') gaps.push({ brandId: bid, dimension: d.code, displayName: d.displayName, kind: 'partial', text: '部分采集，枚举不完整。' });
    }
  }
  // 机会（保守边界：只是待验证线索）
  let opportunities = [];
  try {
    const oppView = buildOpportunities(tenantId, projectId, state);
    opportunities = oppView.items || [];
  } catch (e) { opportunities = []; }
  return {
    generatedAt: new Date().toISOString(),
    scope: scope || {},
    brandIds,
    facts: facts.map(f => ({
      id: f.id, dim: f.dim || null, text: f.text || null, brand: f.brand || null,
      suspect: !!f.suspect, evidenceIds: f.evidenceIds || [], snapshotIds: f.snapshotIds || [],
    })),
    dimensionCoverage: { detected: dimCov.detected, undetected: dimCov.undetected },
    coverage, gaps, opportunities,
  };
}

// ---------- 机会视图（接统一读模型，样本不足不输出结论） ----------
function buildOpportunities(tenantId, projectId, stateArg) {
  const state = stateArg || BrandSvc.loadProjectState(tenantId, projectId);
  const brands = BrandStore.listBrands(tenantId, projectId);
  if (!state) {
    return { status: 'insufficient', statusText: '资料不足，暂不生成机会判断', items: [], sample: { brandCount: 0 }, limits: ['项目状态不可用'] };
  }
  BrandSvc.syncProjectBrands(tenantId, projectId, state);
  const comps = (state.competitors || []).filter(c => c && c.status === 'done');
  // 已具备数据支持的品牌数（Data Surface 有终态成功/部分成功）
  let withData = 0;
  for (const c of comps) {
    const cov = BrandSvc.buildCoverage(tenantId, projectId, c);
    if ((cov.summary.dimensionsWithData || 0) > 0) withData++;
  }
  const MIN_BRANDS = 3;
  const limits = [];
  for (const d of (require('./capability-registry.js').listDimensions())) {
    const caps = require('./capability-registry.js').capabilitiesByDimension(d.code);
    if (!caps.some(c => c.maturity === 'ga')) limits.push(d.displayName + '：数据源未接入，本版不据此生成机会结论');
  }
  if (!comps.length || withData < MIN_BRANDS) {
    return {
      status: 'insufficient',
      statusText: '资料不足，暂不生成机会判断',
      items: [],
      sample: { brandCount: comps.length, brandsWithData: withData, required: MIN_BRANDS },
      limits,
      note: '机会判断需要至少 ' + MIN_BRANDS + ' 个已具备真实数据覆盖的竞争品牌；当前不满足，Vantage 不给出机会结论（不做估算填充）。',
    };
  }
  let map = null;
  try {
    const { computeOpportunityMap } = require('../lib/opportunity.js');
    const excluded = new Set(state.excluded || []);
    const voiceItems = [];
    comps.forEach(c => (c.voiceItems || []).forEach(v => v && voiceItems.push(v)));
    map = computeOpportunityMap(comps, { excluded, voiceItems });
  } catch (e) { map = null; }
  const items = [];
  const zones = (map && (map.zones || map.items || map.opportunities)) || [];
  for (const z of zones) {
    if (!z) continue;
    items.push({
      id: z.gid || z.id || null,
      theme: z.theme || z.label || z.title || null,
      level: z.level || null,
      basis: z.basis || z.evidence || null,
      brandCount: z.brandCount != null ? z.brandCount : (z.brands ? z.brands.length : null),
      from: z.from || null, to: z.to || null,
      caveats: (z.caveats || []).slice(0, 6),
      status: '线索（待验证）',
      note: '机会只是待验证线索，不是经营建议或确定结论。',
    });
  }
  return {
    status: items.length ? 'ok' : 'insufficient',
    statusText: items.length ? '已基于现有数据生成机会线索' : '资料不足，暂不生成机会判断',
    items,
    sample: { brandCount: comps.length, brandsWithData: withData, required: MIN_BRANDS },
    limits,
    note: items.length ? '每条机会均标注事实依据、覆盖品牌数与限制；不含未接入维度的推断。' : null,
  };
}

// ---------- 报告请求（用户显式触发 → 入队） ----------
function requestReport(tenantId, projectId, scope, userRef) {
  const state = BrandSvc.loadProjectState(tenantId, projectId);
  if (!state) return null;
  const existing = BrandStore.listReports(tenantId, projectId);
  const version = existing.length ? (existing[0].version || 0) + 1 : 1;
  const factPack = buildFactPack(tenantId, projectId, state, scope);
  const report = BrandStore.createReport({
    tenantId, projectId, version, status: 'queued',
    scope: { brandIds: factPack.brandIds, from: (scope && scope.from) || null, to: (scope && scope.to) || null, sections: (scope && scope.sections) || ['overview', 'facts', 'opportunities', 'gaps'] },
    factPack, coverage: factPack.coverage, gaps: factPack.gaps, opportunities: factPack.opportunities,
    generatedBy: userRef || null,
  });
  const job = BrandStore.enqueueReportJob({ tenantId, reportId: report.reportId });
  // 事实引用落 citation 表（每报告独立，供前端打开 Evidence/Snapshot）
  for (const f of factPack.facts.slice(0, 300)) {
    BrandStore.addCitation({
      tenantId, reportId: report.reportId, section: 'facts', factId: f.id, label: f.text,
      evidenceIds: f.evidenceIds || [], snapshotIds: f.snapshotIds || [],
    });
  }
  return { report, jobId: job.jobId };
}

// ---------- 任务执行 ----------
async function executeJob(job) {
  const report0 = BrandStore.getReport(job.tenantId, job.reportId);
  if (!report0) { BrandStore.finishReportJob(job.jobId, job.claimToken, 'dead', 'report missing'); return { status: 'dead' }; }
  if (report0.status === 'success' || report0.status === 'failed') {
    BrandStore.finishReportJob(job.jobId, job.claimToken, 'done');
    return { status: 'done', idempotent: true };
  }
  BrandStore.updateReport(job.tenantId, job.reportId, { status: 'running' });
  const hb = setInterval(() => { try { BrandStore.heartbeatReportJob(job.jobId, job.claimToken); } catch (e) {} }, HEARTBEAT_MS);
  try {
    const state = BrandSvc.loadProjectState(job.tenantId, report0.projectId);
    if (!state) throw new Error('project state unavailable');
    const config = loadConfigSafe();
    let res = null;
    try {
      res = await Report.buildReport(state, config);
    } catch (e) {
      // LLM 不可用/失败 → 不失败报告，改出**结构化报告**（事实清单 + 引用 + 资料缺口）
      res = null;
    }
    const md = (res && (res.markdown || res.text || res.report)) || null;
    const structured = !md;
    let markdown = md;
    if (!markdown) {
      // LLM 不可用/未产出 → 结构化报告（事实清单 + 引用 + 资料缺口），不伪造完整分析
      const fp = report0.factPack || {};
      const lines = [];
      lines.push('# 调研报告（结构化版本）');
      lines.push('');
      lines.push('- 生成时间：' + new Date().toISOString());
      lines.push('- 适用范围：' + (report0.scope && report0.scope.brandIds ? report0.scope.brandIds.length + ' 个品牌' : '全部品牌'));
      lines.push('- 说明：模型不可用或未产出文本，本版返回**已批准事实清单**，不含任何未引用推断。');
      lines.push('');
      lines.push('## 事实清单');
      for (const f of (fp.facts || []).slice(0, 100)) lines.push('- [F] ' + (f.text || '') + (f.dim ? '（维度：' + f.dim + '）' : ''));
      lines.push('');
      lines.push('## 资料缺口');
      for (const g of (fp.gaps || []).slice(0, 50)) lines.push('- ' + (g.displayName || g.dimension) + '：' + (g.text || ''));
      lines.push('');
      lines.push('## 机会与限制');
      const opp = fp.opportunities || [];
      if (!opp.length) lines.push('- 资料不足，暂不生成机会判断。');
      for (const o of opp.slice(0, 30)) lines.push('- ' + (o.theme || '') + '（覆盖品牌数：' + (o.brandCount != null ? o.brandCount : '—') + '）');
      markdown = lines.join('\n');
    }
    const finished = new Date().toISOString();
    BrandStore.updateReport(job.tenantId, job.reportId, {
      status: 'success', markdown,
      generatedBy: structured ? 'structured-fallback' : 'llm',
      finishedAt: finished,
    });
    // 报告生成进入品牌时间线
    const brandIds = (report0.scope && report0.scope.brandIds) || [];
    for (const bid of brandIds) {
      BrandStore.appendTimeline({
        tenantId: job.tenantId, brandId: bid, kind: 'report', at: finished, nature: 'summarized',
        status: 'verified', title: '调研报告生成（v' + report0.version + '）',
        detail: null, refType: 'report', refId: report0.reportId,
      });
    }
    BrandStore.finishReportJob(job.jobId, job.claimToken, 'done');
    return { status: 'done', reportId: job.reportId };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    BrandStore.updateReport(job.tenantId, job.reportId, { status: 'failed', errorText: '报告生成失败，可重新生成。', finishedAt: new Date().toISOString() });
    const retry = Number(job.retry || 0);
    if (retry >= 3) BrandStore.finishReportJob(job.jobId, job.claimToken, 'dead', msg);
    else BrandStore.finishReportJob(job.jobId, job.claimToken, 'error', msg);
    return { status: 'failed', error: msg };
  } finally { clearInterval(hb); }
}

async function tick() {
  if (running) return { skipped: true };
  running = true;
  try {
    BrandStore.reclaimExpiredReportJobs(Date.now());
    const job = BrandStore.claimReportJob('report-worker');
    if (!job) return { claimed: false };
    const r = await executeJob(job);
    return Object.assign({ claimed: true, jobId: job.jobId }, r);
  } finally { running = false; }
}

function startWorker() {
  if (workerTimer) return;
  try { BrandStore.reclaimExpiredReportJobs(Date.now()); } catch (e) {}
  workerTimer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (workerTimer.unref) workerTimer.unref();
}
function stopWorker() { if (workerTimer) { clearInterval(workerTimer); workerTimer = null; } }

// ---------- 读取视图 ----------
function getReportView(tenantId, reportId) {
  const r = BrandStore.getReport(tenantId, reportId);
  if (!r) return null;
  const citations = BrandStore.listCitations(tenantId, reportId);
  const jobs = BrandStore.listReportJobs(tenantId).filter(j => j.reportId === reportId);
  return Object.assign({}, r, {
    citations: citations.map(c => ({
      citationId: c.citationId, section: c.section, factId: c.factId, label: c.label,
      evidenceIds: c.evidenceIds, snapshotIds: c.snapshotIds,
    })),
    jobs,
  });
}
function listReportViews(tenantId, projectId) {
  return BrandStore.listReports(tenantId, projectId).map(r => ({
    reportId: r.reportId, projectId: r.projectId, version: r.version, status: r.status,
    scope: r.scope, createdAt: r.createdAt, finishedAt: r.finishedAt,
    factCount: (r.factPack && r.factPack.facts ? r.factPack.facts.length : 0),
    gapCount: (r.gaps ? r.gaps.length : 0),
  }));
}

module.exports = {
  buildFactPack, buildOpportunities,
  requestReport, executeJob, tick, startWorker, stopWorker,
  getReportView, listReportViews,
};
