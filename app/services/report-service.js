'use strict';
// ============================================================
// services/report-service.js —— 调研报告：冻结事实包 + 持久化生成任务（SC-04）
//   · 生成只由用户显式触发（POST /api/reports），页面加载绝不消耗模型额度；
//   · 使用**生成时刻冻结的事实包**（facts/coverage/gaps/opportunities/
//     whitespace/voiceOpp/positioning 全部深冻结），实时数据变化不改写已生成报告；
//   · 🔴 P0（评审轮 2）：执行期只读 report.factPack + report.scope，
//     **不读取项目实时状态**——正文、结构化回退、引用、覆盖、缺口、机会
//     全部来自冻结包（research/report.js 的 buildReportFromPack 适配层）；
//   · 任务持久化（report_jobs：claim 租约 / 心跳 / reclaim / 真实重试），
//     异常后回 pending 可再次领取（受 REPORT_JOB_MAX_RETRY 约束），
//     重试耗尽 → dead 终态 + 报告 failed（前端可重新生成），无虚假 retry 语义；
//   · LLM 只组织冻结包内的事实（buildReportFromPack 内保证强制引用与校验器）；
//     LLM 不可用时返回带事实清单/引用/资料缺口的结构化报告，不伪造完整分析。
// ============================================================
const BrandStore = require('./brand-store.js');
const BrandSvc = require('./brand-service.js');
const Report = require('../research/report.js');
const { computeWhiteSpace, assessPositioning } = require('../research/whitespace.js');
const { evidenceDistribution } = require('../lib/evidence-dist.js');
const { computeOpportunityMap } = require('../lib/opportunity.js');

let workerTimer = null;
let running = false;
const HEARTBEAT_MS = 10000;
const TICK_MS = 5000;

function loadConfigSafe() {
  try { return require('../core/config.js').loadConfig(); } catch (e) { return {}; }
}

// ---------- 范围参数错误（handler 映射为 400） ----------
class ScopeError extends Error {
  constructor(code, message) { super(message); this.code = code; this.status = 400; }
}

// ---------- 范围归一与校验（P1：brandIds/from/to/sections 必须真实生效） ----------
function normalizeScope(tenantId, projectId, scope) {
  const s = scope || {};
  // brandIds：每一个都必须是本租户且本项目已关联的品牌；跨项目/未同步 = 明确参数错误
  let brandIds = Array.isArray(s.brandIds) ? s.brandIds.map(x => String(x || '').trim()).filter(Boolean) : [];
  brandIds = [...new Set(brandIds)];
  for (const bid of brandIds) {
    if (!BrandStore.getLink(tenantId, bid, projectId)) {
      throw new ScopeError('BRAND_NOT_IN_PROJECT', '所选品牌未关联到当前项目，不能纳入报告范围。');
    }
  }
  // from/to：可选，YYYY-MM-DD（兼容 ISO 前缀）；非法格式 = 参数错误
  const normDate = (v, name) => {
    if (v == null || v === '') return null;
    const t = String(v).trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(t)) throw new ScopeError('INVALID_TIME_RANGE', name + ' 必须是 YYYY-MM-DD 日期。');
    return t.slice(0, 10);
  };
  const from = normDate(s.from, 'from');
  const to = normDate(s.to, 'to');
  if (from && to && from > to) throw new ScopeError('INVALID_TIME_RANGE', 'from 不能晚于 to。');
  // sections：必须是已知章节的子集
  let sections = Array.isArray(s.sections) ? s.sections.map(String) : null;
  if (sections) {
    sections = [...new Set(sections)];
    for (const x of sections) {
      if (!Report.REPORT_ALL_SECTIONS.includes(x)) throw new ScopeError('INVALID_SECTION', '未知的报告章节：' + x);
    }
    if (!sections.length) sections = null;
  }
  return { brandIds, from, to, sections };
}

// 时间窗口判定：无法判定时间（无时间/非日期格式）一律不算命中，绝不伪造
function dateSlice(v) { return v ? String(v).slice(0, 10) : null; }
function isDateString(v) { return !!v && /^\d{4}-\d{2}-\d{2}/.test(String(v)); }
function inWindow(when, from, to) {
  const d = dateSlice(when);
  if (!isDateString(d)) return false;
  if (from && d < dateSlice(from)) return false;
  if (to && d > dateSlice(to)) return false;
  return true;
}

// ---------- 冻结事实包（v2：冻结时点一次性算全报告原料） ----------
function buildFactPack(tenantId, projectId, state, scope) {
  const norm = normalizeScope(tenantId, projectId, scope);
  // 项目级品牌→竞品映射以 brand_project_links 为准（评审轮 2）
  const linkRefs = norm.brandIds.length
    ? norm.brandIds.map(bid => { const l = BrandStore.getLink(tenantId, bid, projectId); return { bid, ref: l ? l.competitorRef : null }; })
    : (BrandStore.listBrandLinksForProject(tenantId, projectId) || []).map(l => ({ bid: l.brandId, ref: l.competitorRef }));
  const refSet = new Set(linkRefs.map(x => x.ref).filter(Boolean));
  const brandNames = {};
  for (const x of linkRefs) {
    const b = BrandStore.getBrand(tenantId, x.bid);
    if (b) brandNames[x.bid] = b.canonicalName;
  }
  // 冻结时点的 scoped 视图：只用于**本次冻结计算**（纯函数），执行期不再触碰
  const scoped = norm.brandIds.length
    ? Object.assign({}, state, { competitors: (state.competitors || []).filter(c => c && refSet.has(c.id)) })
    : state;

  // —— 以下全部在冻结时点算好并深存入 pack（deepCopy 语义：后续 state 变化无关） ——
  const facts = Report.assembleFacts(scoped) || [];
  const dimCov = Report.dimensionCoverage(scoped) || { cov: {}, detected: [], undetected: [] };
  let ws = { opps: [], copyGaps: [], singleGaps: [], singleMode: false, total: (scoped.competitors || []).length };
  try {
    const w = computeWhiteSpace(scoped);
    if (w && !w.hidden) {
      const all = w.gaps || [];
      ws = {
        opps: all.filter(g => g && g.level === 'opportunity' && !g.copyGap),
        copyGaps: all.filter(g => g && g.copyGap),
        singleGaps: all.filter(g => g && g.singleCompetitor),
        singleMode: !!w.singleMode,
        total: w.total != null ? w.total : ws.total,
      };
    }
  } catch (e) { /* 空白分析不可用：机会材料为空，如实呈现 */ }
  // 依赖降级（flaggedOutlier）对手的机会 → 冻结时标记 suspect
  const flaggedNames = new Set((scoped.competitors || []).filter(c => c && c.flaggedOutlier).map(c => c.name));
  for (const g of ws.opps) {
    if ((g.sources || []).some(s => flaggedNames.has(s && s.name))) g.suspect = true;
  }
  // 用户声音机会（口碑驱动补充层）
  let voiceOpp = { hidden: true, themes: [], doneBrands: 0, brandsWithVoice: 0 };
  try {
    const _oppEx = new Set(scoped.excluded || []);
    (scoped.competitors || []).forEach(c => { if (c && (c.entityAmbiguous || c.categoryTearing)) _oppEx.add(c.id); });
    const _oppComps = (scoped.competitors || []).filter(c => c && c.status === 'done' && !_oppEx.has(c.id));
    const _voice = [];
    _oppComps.forEach(c => (c.voiceItems || []).forEach(v => { if (v) _voice.push(v); }));
    const m = computeOpportunityMap(_oppComps, { excluded: _oppEx, voiceItems: _voice });
    if (m) voiceOpp = m;
  } catch (e) { /* 不可用即隐藏，不填充 */ }
  const pos = (() => { try { return assessPositioning(scoped) || { hasProfile: false }; } catch (e) { return { hasProfile: false }; } })();
  const positioningText = Report.positioningTextOf(pos);
  const evidenceDist = (() => { try { return evidenceDistribution(scoped) || null; } catch (e) { return null; } })();

  // 时间范围过滤：带时间字段的事实按窗口保留；无法判定时间 → 不命中，如实登记
  const hasWindow = !!(norm.from || norm.to);
  const packFacts = [];
  const timeUnresolved = [];
  for (const f of facts) {
    if (hasWindow && !inWindow(f.when, norm.from, norm.to)) {
      timeUnresolved.push({ id: f.id, dim: f.dim || null, text: f.text || null, reason: isDateString(dateSlice(f.when)) ? '时间不在所选范围' : '无法判定时间' });
      continue;
    }
    packFacts.push({
      id: f.id, dim: f.dim || null, text: f.text || null, brand: f.brand || null, source: f.source || null,
      suspect: !!f.suspect, when: f.when || null,
      evidenceIds: f.evidenceIds || [], snapshotIds: f.snapshotIds || [],
    });
  }

  // 品牌级覆盖与缺口（读取自 Registry/Data Surface，只投影不复制）
  const coverage = [];
  const gaps = [];
  for (const x of linkRefs) {
    const brand = BrandStore.getBrand(tenantId, x.bid);
    if (!brand) continue;
    const comp = x.ref ? BrandSvc.findCompetitor(state, x.ref) : null;
    const cov = BrandSvc.buildCoverage(tenantId, projectId, comp || {});
    coverage.push({ brandId: x.bid, name: brand.canonicalName, summary: cov.summary, dimensions: cov.dimensions.map(d => ({ code: d.code, state: d.state, stateText: d.stateText, lastObservedAt: d.lastObservedAt })) });
    for (const d of cov.dimensions) {
      if (d.state === 'pending_config') gaps.push({ brandId: x.bid, dimension: d.code, displayName: d.displayName, kind: 'pending_config', text: '需要系统数据服务配置：当前不生成数据、估算或结论。' });
      else if (d.state === 'unsupported') gaps.push({ brandId: x.bid, dimension: d.code, displayName: d.displayName, kind: 'not_integrated', text: '该数据源尚未接入，不提供任何数据或估算。' });
      else if (d.state === 'unknown') gaps.push({ brandId: x.bid, dimension: d.code, displayName: d.displayName, kind: 'not_collected', text: '尚未采集（不等于未发现数据）。' });
      else if (d.state === 'failed') gaps.push({ brandId: x.bid, dimension: d.code, displayName: d.displayName, kind: 'collect_failed', text: '最近采集失败，尚无可展示数据。' });
      else if (d.state === 'partial') gaps.push({ brandId: x.bid, dimension: d.code, displayName: d.displayName, kind: 'partial', text: '部分采集，枚举不完整。' });
      // 「保留旧数据」只在确有上次成功数据时出现（ok/partial/stale + 最近尝试失败）
      else if (['ok', 'partial', 'stale'].includes(d.state) && Array.isArray(d.notes)) {
        for (const nt of d.notes) {
          if (/最近一次更新失败/.test(nt)) gaps.push({ brandId: x.bid, dimension: d.code, displayName: d.displayName, kind: 'latest_failure', text: nt });
        }
      }
    }
  }

  // 机会（保守边界：只是待验证线索；样本不足不输出结论；带时间字段的机会项按窗口过滤）
  let opportunities = [];
  let opportunityLimits = [];
  try {
    const oppView = buildOpportunities(tenantId, projectId, scoped, { brandIds: norm.brandIds, from: norm.from, to: norm.to });
    opportunityLimits = (oppView.limits || []).slice();
    if (oppView.status === 'ok') {
      let items = oppView.items || [];
      if (hasWindow) {
        items = items.filter(it => {
          const f = dateSlice(it.from), t = dateSlice(it.to);
          if (!f && !t) return false; // 无法判定时间 → 不命中
          const start = f || t, end = t || f;
          if (norm.from && end && end < norm.from) return false;
          if (norm.to && start && start > norm.to) return false;
          return true;
        });
      }
      opportunities = items;
    } else {
      if (oppView.note) opportunityLimits.push(oppView.note);
    }
  } catch (e) { opportunities = []; }

  return {
    generatedAt: new Date().toISOString(),
    scope: { brandIds: norm.brandIds, from: norm.from, to: norm.to, sections: norm.sections },
    brandIds: linkRefs.map(x => x.bid),
    brandNames,
    track: (state && state.track) || null,
    intent: (state && state.intent) || null,
    facts: packFacts,
    timeUnresolved,
    dimensionCoverage: { cov: dimCov.cov || {}, detected: dimCov.detected || [], undetected: dimCov.undetected || [] },
    whitespace: ws,
    voiceOpp: { hidden: !!voiceOpp.hidden, themes: voiceOpp.hidden ? [] : (voiceOpp.themes || []), doneBrands: voiceOpp.doneBrands || 0, brandsWithVoice: voiceOpp.brandsWithVoice || 0 },
    positioning: pos,
    positioningText,
    evidenceDist,
    coverage, gaps, opportunities, opportunityLimits,
  };
}

// ---------- 机会视图（接统一读模型，样本不足不输出结论） ----------
function buildOpportunities(tenantId, projectId, stateArg, opts) {
  const o = opts || {};
  const state = stateArg || BrandSvc.loadProjectState(tenantId, projectId);
  if (!state) {
    return { status: 'insufficient', statusText: '资料不足，暂不生成机会判断', items: [], sample: { brandCount: 0 }, limits: ['项目状态不可用'] };
  }
  if (!stateArg) BrandSvc.syncProjectBrands(tenantId, projectId);
  // 🔴 项目级 competitor_ref 以 brand_project_links 为准
  let comps = (state.competitors || []).filter(c => c && c.status === 'done');
  if (Array.isArray(o.brandIds) && o.brandIds.length) {
    const refSet = new Set(o.brandIds.map(bid => {
      const l = BrandStore.getLink(tenantId, bid, projectId);
      return l ? l.competitorRef : null;
    }).filter(Boolean));
    comps = comps.filter(c => refSet.has(c.id));
  }
  // 已具备数据支持的品牌数（Data Surface 有终态成功/部分成功）
  let withData = 0;
  const dimsWithData = new Set();
  for (const c of comps) {
    const cov = BrandSvc.buildCoverage(tenantId, projectId, c);
    if ((cov.summary.dimensionsWithData || 0) > 0) withData++;
    for (const d of (cov.dimensions || [])) {
      if (d.state === 'ok' || d.state === 'partial' || d.state === 'stale') dimsWithData.add(d.displayName);
    }
  }
  const MIN_BRANDS = 3;
  // 只读视图扩展（UI 轮）：机会页「数据基础」需要维度级构成——已接入 / 需要配置 / 未接入 / 实际有数据
  // Wave 1：pending_config 单列（需要系统数据服务配置 ≠ 未接入）
  const allDims = require('./capability-registry.js').listDimensions();
  const integratedNames = [];
  const pendingConfigNames = [];
  const notIntegratedNames = [];
  for (const d of allDims) {
    const caps = require('./capability-registry.js').capabilitiesByDimension(d.code);
    if (caps.some(c => c.maturity === 'ga')) integratedNames.push(d.displayName);
    else if (caps.some(c => c.maturity === 'pending_config')) pendingConfigNames.push(d.displayName);
    else notIntegratedNames.push(d.displayName);
  }
  const limits = [];
  for (const d of allDims) {
    const caps = require('./capability-registry.js').capabilitiesByDimension(d.code);
    if (!caps.some(c => c.maturity === 'ga')) {
      const isPending = caps.some(c => c.maturity === 'pending_config');
      limits.push(d.displayName + (isPending
        ? '：需要系统数据服务配置，配置并验证前不据此生成机会结论'
        : '：数据源未接入，本版不据此生成机会结论'));
    }
  }
  const dimensionBasis = {
    integrated: integratedNames,
    pendingConfig: pendingConfigNames,
    notIntegrated: notIntegratedNames,
    covered: [...dimsWithData],
  };
  if (!comps.length || withData < MIN_BRANDS) {
    return {
      status: 'insufficient',
      statusText: '资料不足，暂不生成机会判断',
      items: [],
      sample: { brandCount: comps.length, brandsWithData: withData, required: MIN_BRANDS },
      dimensionBasis,
      limits,
      note: '机会判断需要至少 ' + MIN_BRANDS + ' 个已具备真实数据覆盖的竞争品牌；当前不满足，Vantage 不给出机会结论（不做估算填充）。',
    };
  }
  let map = null;
  try {
    const excluded = new Set(state.excluded || []);
    const voiceItems = [];
    comps.forEach(c => (c.voiceItems || []).forEach(v => v && voiceItems.push(v)));
    map = computeOpportunityMap(comps, { excluded, voiceItems });
  } catch (e) { map = null; }
  let items = [];
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
  // 时间窗口：带时间字段的机会项按窗口过滤；无法判定时间 → 不命中
  if (o.from || o.to) {
    items = items.filter(it => {
      const f = dateSlice(it.from), t = dateSlice(it.to);
      if (!f && !t) return false;
      const start = f || t, end = t || f;
      if (o.from && end && end < dateSlice(o.from)) return false;
      if (o.to && start && start > dateSlice(o.to)) return false;
      return true;
    });
  }
  return {
    status: items.length ? 'ok' : 'insufficient',
    statusText: items.length ? '已基于现有数据生成机会线索' : '资料不足，暂不生成机会判断',
    items,
    sample: { brandCount: comps.length, brandsWithData: withData, required: MIN_BRANDS },
    dimensionBasis,
    limits,
    note: items.length ? '每条机会均标注事实依据、覆盖品牌数与限制；不含未接入维度的推断。' : '资料不足，暂不生成机会判断。',
  };
}

// ---------- 报告请求（用户显式触发 → 冻结事实包 → 入队） ----------
function requestReport(tenantId, projectId, scope, userRef) {
  BrandSvc.syncProjectBrands(tenantId, projectId); // 先同步链接（brandIds 校验依赖 link）
  const state = BrandSvc.loadProjectState(tenantId, projectId);
  if (!state) return null;
  const factPack = buildFactPack(tenantId, projectId, state, scope); // ScopeError 透传给 handler
  const existing = BrandStore.listReports(tenantId, projectId);
  const version = existing.length ? (existing[0].version || 0) + 1 : 1;
  const report = BrandStore.createReport({
    tenantId, projectId, version, status: 'queued',
    scope: factPack.scope,
    factPack, coverage: factPack.coverage, gaps: factPack.gaps, opportunities: factPack.opportunities,
    generatedBy: userRef || null,
  });
  const job = BrandStore.enqueueReportJob({ tenantId, reportId: report.reportId });
  // 事实引用落 citation 表：**只落冻结包最终保留的事实**（与正文同源），带可核验来源 URL
  for (const f of factPack.facts.slice(0, 300)) {
    BrandStore.addCitation({
      tenantId, reportId: report.reportId, section: 'facts', factId: f.id, label: f.text,
      sourceUrl: f.source || null, evidenceIds: f.evidenceIds || [], snapshotIds: f.snapshotIds || [],
    });
  }
  return { report, jobId: job.jobId };
}

// ---------- 任务执行（🔴 只吃冻结包，不读实时状态） ----------
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
    const pack = report0.factPack;
    if (!pack || !Array.isArray(pack.facts)) throw new Error('report frozen fact pack missing');
    const config = loadConfigSafe();
    const res = await Report.buildReportFromPack(pack, config);
    const markdown = (res && res.markdown) || null;
    if (!markdown) throw new Error('report produced no content');
    const finished = new Date().toISOString();
    BrandStore.updateReport(job.tenantId, job.reportId, {
      status: 'success', markdown,
      generatedBy: res.structured ? 'structured-fallback' : 'llm',
      finishedAt: finished,
    });
    // 报告生成进入品牌时间线（系统事件，无 Evidence 引用 → 待核实，不标已核实）
    const brandIds = (report0.scope && report0.scope.brandIds) || [];
    for (const bid of brandIds) {
      BrandStore.appendTimeline({
        tenantId: job.tenantId, brandId: bid, kind: 'report', at: finished, nature: 'summarized',
        status: 'pending', title: '调研报告生成（v' + report0.version + '）',
        detail: null, refType: 'report', refId: report0.reportId,
      });
    }
    BrandStore.finishReportJob(job.jobId, job.claimToken, 'done');
    return { status: 'done', reportId: job.reportId, structured: !!res.structured };
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 200);
    // 🔴 真实重试：回 pending（可再次领取），受 REPORT_JOB_MAX_RETRY 约束；耗尽 → 终态 failed
    const nextRetry = Number(job.retry || 0) + 1;
    if (nextRetry > BrandStore.REPORT_JOB_MAX_RETRY) {
      BrandStore.updateReport(job.tenantId, job.reportId, {
        status: 'failed', errorText: '报告生成失败（已自动重试 ' + BrandStore.REPORT_JOB_MAX_RETRY + ' 次），请重新生成。',
        finishedAt: new Date().toISOString(),
      });
      BrandStore.finishReportJob(job.jobId, job.claimToken, 'dead', msg);
    } else {
      BrandStore.updateReport(job.tenantId, job.reportId, { status: 'queued', errorText: '第 ' + nextRetry + ' 次生成失败，自动重试中。' });
      BrandStore.requeueReportJob(job.jobId, job.claimToken, nextRetry, msg);
    }
    return { status: 'failed', error: msg, retry: nextRetry };
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
      sourceUrl: c.sourceUrl || null,
      evidenceIds: c.evidenceIds, snapshotIds: c.snapshotIds,
    })),
    jobs,
  });
}
function listReportViews(tenantId, projectId) {
  const jobs = BrandStore.listReportJobs(tenantId);
  return BrandStore.listReports(tenantId, projectId).map(r => {
    // 只读视图扩展（UI 轮）：列表透出自动重试进度与最近失败说明（任务书 §六.1「自动重试中」）
    const rjobs = jobs.filter(j => j.reportId === r.reportId);
    const retryCount = rjobs.reduce((m, j) => Math.max(m, Number(j.retry || 0)), 0);
    return {
      reportId: r.reportId, projectId: r.projectId, version: r.version, status: r.status,
      scope: r.scope, createdAt: r.createdAt, finishedAt: r.finishedAt,
      factCount: (r.factPack && r.factPack.facts ? r.factPack.facts.length : 0),
      gapCount: (r.gaps ? r.gaps.length : 0),
      retryCount, errorText: r.errorText || null, generatedBy: r.generatedBy || null,
    };
  });
}

module.exports = {
  ScopeError, buildFactPack, normalizeScope, buildOpportunities,
  requestReport, executeJob, tick, startWorker, stopWorker,
  getReportView, listReportViews,
};
