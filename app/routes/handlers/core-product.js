'use strict';
// ============================================================
// handlers/core-product.js —— 核心产品主闭环端点组（SC-04）
//   GET  /api/brands?projectId=                    竞品库列表（tenant）
//   GET  /api/brands/:brandId                      品牌详情（统一档案）
//   GET  /api/brands/:brandId/timeline             品牌时间线
//   GET  /api/brands/:brandId/coverage             数据覆盖与来源
//   GET  /api/intelligence?projectId=&brandId=&type=&from=&to=   情报库
//   GET  /api/opportunities?projectId=             机会视图
//   GET  /api/reports?projectId=                   报告列表
//   POST /api/reports                              生成报告（202 + 持久任务）
//   GET  /api/reports/:reportId                    报告详情（含引用）
// 纪律：
//   · 租户硬隔离：项目/品牌/报告必须属于当前租户；跨租户统一 404，不泄露存在性
//   · 响应剔除 provider/内部错误码/服务器路径/栈（04 §20）
//   · 未接入维度显式「未接入」，未采集显式「尚未采集」，零 mock、零估算填充
// ============================================================
const db = require('../../services/db.js');
const BrandStore = require('../../services/brand-store.js');
const BrandSvc = require('../../services/brand-service.js');
const ReportSvc = require('../../services/report-service.js');
const MemView = require('../../services/memory-view.js'); // SC-05：时序事件最小接入（只读投影）

function tidOf(ctx, req) {
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') return null;
  return (ap.payload && ap.payload.tid) || null;
}
function q(url, k) { const v = url.searchParams.get(k); return v == null ? null : String(v); }

// 解析并校验项目归属（显式 projectId 必须属于本租户；缺省 = 当前项目）
function resolveProject(ctx, tid, projectIdRaw) {
  let projectId = typeof projectIdRaw === 'string' ? projectIdRaw.trim().slice(0, 80) : '';
  if (!projectId) {
    try { projectId = ctx.getCurrentId ? (ctx.getCurrentId(tid) || '') : ''; } catch (e) { projectId = ''; }
  }
  if (!projectId) return { error: [400, 'PROJECT_REQUIRED', '请先选择或创建项目。'] };
  if (!db.getProject(tid, projectId)) return { error: [404, 'PROJECT_NOT_FOUND', '项目不存在或不属于当前租户。'] };
  return { projectId };
}
function brandInTenant(tid, brandId) {
  if (!brandId) return null;
  const b = BrandStore.getBrand(tid, String(brandId).slice(0, 80));
  return b || null; // 跨租户 → null → 404（不泄露存在性）
}

// ---------------- 竞品库 ----------------
async function brandsList(ctx, req, res, url) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const rp = resolveProject(ctx, tid, q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  const items = BrandSvc.listBrandViews(tid, rp.projectId);
  ctx.sendJSON(res, 200, { projectId: rp.projectId, brands: items, count: items.length });
  return true;
}

async function brandDetail(ctx, req, res, url, p) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const brandId = String(p.split('/')[3] || '');
  const brand = brandInTenant(tid, brandId);
  if (!brand) { ctx.sendJSON(res, 404, { error: 'BRAND_NOT_FOUND', message: '品牌不存在或不属于当前租户。' }); return true; }
  const rp = resolveProject(ctx, tid, q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  // 🔴 项目边界：品牌必须已关联该项目；竞品数据按该项目链接读取（同一品牌多项目各读各的）
  if (!BrandStore.getLink(tid, brand.brandId, rp.projectId)) {
    ctx.sendJSON(res, 404, { error: 'BRAND_NOT_IN_PROJECT', message: '该品牌未关联到当前项目。' }); return true;
  }
  const view = BrandSvc.getBrandView(tid, brand.brandId, rp.projectId);
  ctx.sendJSON(res, 200, view || { brandId: brand.brandId });
  return true;
}

async function brandCoverage(ctx, req, res, url, p) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const brandId = String(p.split('/')[3] || '');
  const brand = brandInTenant(tid, brandId);
  if (!brand) { ctx.sendJSON(res, 404, { error: 'BRAND_NOT_FOUND', message: '品牌不存在或不属于当前租户。' }); return true; }
  const rp = resolveProject(ctx, tid, q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  const link = BrandStore.getLink(tid, brand.brandId, rp.projectId);
  if (!link) { ctx.sendJSON(res, 404, { error: 'BRAND_NOT_IN_PROJECT', message: '该品牌未关联到当前项目。' }); return true; }
  let comp = null;
  if (link.competitorRef) {
    const st = BrandSvc.loadProjectState(tid, rp.projectId);
    comp = BrandSvc.findCompetitor(st, link.competitorRef);
  }
  const cov = BrandSvc.buildCoverage(tid, rp.projectId, comp || {});
  ctx.sendJSON(res, 200, { brandId: brand.brandId, projectId: rp.projectId, coverage: cov });
  return true;
}

// ---------------- 情报库 ----------------
async function intelligence(ctx, req, res, url) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const rp = resolveProject(ctx, tid, q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  const brandId = q(url, 'brandId');
  const selectedBrand = brandId ? brandInTenant(tid, brandId) : null;
  if (brandId && !selectedBrand) { ctx.sendJSON(res, 404, { error: 'BRAND_NOT_FOUND', message: '品牌不存在或不属于当前租户。' }); return true; }
  if (selectedBrand && !BrandStore.getLink(tid, selectedBrand.brandId, rp.projectId)) {
    ctx.sendJSON(res, 404, { error: 'BRAND_NOT_IN_PROJECT', message: '该品牌未关联到当前项目。' }); return true;
  }
  const items = BrandSvc.listIntelligence(tid, {
    projectId: rp.projectId, brandId, type: q(url, 'type'), from: q(url, 'from'), to: q(url, 'to'),
  });
  ctx.sendJSON(res, 200, {
    projectId: rp.projectId, items, count: items.length,
    // r4.10：项目级建设中维度（未接入维度不再混入 items，改由本字段独立承载）
    constructionDimensions: BrandSvc.constructionDimensions(tid, rp.projectId, selectedBrand ? selectedBrand.brandId : null),
    // SC-05：项目级「时序变化」事件（derived_timeline_events 投影）。
    // 独立字段承载：items 仍是采集观察（SC-04 语义不变），memory 事件是确定性派生，
    // 二者不混排——避免把「系统推导」伪装成「来源直接记录」。
    memoryEvents: MemView.buildProjectMemoryEvents(tid, rp.projectId, { brandId, from: q(url, 'from'), to: q(url, 'to') }),
    filters: { brandId: brandId || null, type: q(url, 'type') || null, from: q(url, 'from') || null, to: q(url, 'to') || null },
    legend: {
      natures: BrandSvc.NATURE_TEXT,
      statuses: BrandSvc.INTEL_STATUS_TEXT,
      types: BrandSvc.INTEL_TYPE_TEXT,
    },
  });
  return true;
}

// ---------------- 机会视图 ----------------
async function opportunities(ctx, req, res, url) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const rp = resolveProject(ctx, tid, q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  const view = ReportSvc.buildOpportunities(tid, rp.projectId);
  // SC-05：机会判断的数据基础补「可用历史跨度」与「本次使用的时间范围」
  let historyBasis = null;
  try { historyBasis = MemView.projectHistoryBasis(tid, rp.projectId); } catch (e) { historyBasis = null; }
  ctx.sendJSON(res, 200, Object.assign({ projectId: rp.projectId, historyBasis }, view));
  return true;
}

// ---------------- 调研报告 ----------------
async function reportsList(ctx, req, res, url) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const rp = resolveProject(ctx, tid, q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  ctx.sendJSON(res, 200, { projectId: rp.projectId, reports: ReportSvc.listReportViews(tid, rp.projectId) });
  return true;
}

async function reportsCreate(ctx, req, res, url) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  let body = {};
  try {
    const raw = await ctx.readBody(req);
    // ctx.readBody 可能返回：已解析对象（server.js readBody 内部 JSON.parse）/ Buffer / 原始字符串——三种形态都兼容
    let parsed = raw;
    if (Buffer.isBuffer(raw)) { try { parsed = JSON.parse(raw.toString('utf8')); } catch (e) { parsed = null; } }
    else if (typeof raw === 'string') { try { parsed = raw ? JSON.parse(raw) : {}; } catch (e) { parsed = null; } }
    body = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) { body = {}; }
  const rp = resolveProject(ctx, tid, body.projectId || q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  const brandIds = Array.isArray(body.brandIds) ? body.brandIds.map(String).slice(0, 50) : [];
  // 品牌归属校验（跨租户 404；跨项目/未同步由服务层抛 ScopeError → 400）
  for (const bid of brandIds) {
    if (!brandInTenant(tid, bid)) { ctx.sendJSON(res, 404, { error: 'BRAND_NOT_FOUND', message: '品牌不存在或不属于当前租户。' }); return true; }
  }
  let req2;
  try {
    req2 = ReportSvc.requestReport(tid, rp.projectId, {
      brandIds, from: body.from || null, to: body.to || null, sections: Array.isArray(body.sections) ? body.sections.slice(0, 10) : undefined,
    }, null);
  } catch (e) {
    if (e && e.status === 400) { ctx.sendJSON(res, 400, { error: e.code || 'INVALID_SCOPE', message: e.message }); return true; }
    throw e;
  }
  if (!req2) { ctx.sendJSON(res, 404, { error: 'PROJECT_STATE_NOT_FOUND', message: '项目档案不可用。' }); return true; }
  ctx.sendJSON(res, 202, {
    reportId: req2.report.reportId, jobId: req2.jobId, status: 'queued', version: req2.report.version,
    message: '报告生成已入队，可在报告列表查看进度（生成只由本次显式触发）。',
  });
  return true;
}

async function reportDetail(ctx, req, res, url, p) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const reportId = String(p.split('/')[3] || '');
  const view = ReportSvc.getReportView(tid, reportId); // 跨租户 → null
  if (!view) { ctx.sendJSON(res, 404, { error: 'REPORT_NOT_FOUND', message: '报告不存在或不属于当前租户。' }); return true; }
  ctx.sendJSON(res, 200, view);
  return true;
}

module.exports = {
  brandsList, brandDetail, brandCoverage,
  intelligence, opportunities,
  reportsList, reportsCreate, reportDetail,
};
