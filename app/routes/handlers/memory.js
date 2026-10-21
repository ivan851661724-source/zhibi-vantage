'use strict';
// ============================================================
// handlers/memory.js —— Competitive Memory 端点组（SC-05 §6）
//   GET  /api/brands/:brandId/memory              时序事实 + 版本 + 引用 + 覆盖 + 游标
//   GET  /api/brands/:brandId/timeline            直接观察 / 存档观察 / 派生事件 / 覆盖缺口
//   GET  /api/brands/:brandId/history-coverage    按维度时间覆盖
//   POST /api/brands/:brandId/history-backfill    发起历史回补（202 + 持久任务）
//   GET  /api/history-backfill/:jobId             任务进度与覆盖
// 纪律：
//   · tenant + project + brand 三重归属校验；跨项目/跨租户统一 404（不泄露存在性）；
//   · 响应不含 claimToken / 文件路径 / 存储文件名 / 密钥 / 调用栈 / 内部错误码；
//   · 「无记录」不得表达成「没有变化」——空态返回明确的状态与说明，不给 0 值曲线。
// ============================================================
const db = require('../../services/db.js');
const BrandStore = require('../../services/brand-store.js');
const BrandSvc = require('../../services/brand-service.js');
const Store = require('../../services/competitive-memory-store.js');
const View = require('../../services/memory-view.js');
const Backfill = require('../../services/backfill-service.js');

function tidOf(ctx, req) {
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') return null;
  return (ap.payload && ap.payload.tid) || null;
}
function q(url, k) { const v = url.searchParams.get(k); return v == null ? null : String(v); }
function isDate(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }

function resolveProject(ctx, tid, raw) {
  let projectId = typeof raw === 'string' ? raw.trim().slice(0, 80) : '';
  if (!projectId) {
    try { projectId = ctx.getCurrentId ? (ctx.getCurrentId(tid) || '') : ''; } catch (e) { projectId = ''; }
  }
  if (!projectId) return { error: [400, 'PROJECT_REQUIRED', '请先选择或创建项目。'] };
  if (!db.getProject(tid, projectId)) return { error: [404, 'PROJECT_NOT_FOUND', '项目不存在或不属于当前租户。'] };
  return { projectId };
}

// 品牌 + 项目归属一次性解析（memory 全部端点共用）
function resolveBrandScope(ctx, tid, brandId, projectIdRaw) {
  const brand = BrandStore.getBrand(tid, String(brandId || '').slice(0, 80));
  if (!brand) return { error: [404, 'BRAND_NOT_FOUND', '品牌不存在或不属于当前租户。'] };
  const rp = resolveProject(ctx, tid, projectIdRaw);
  if (rp.error) return { error: rp.error };
  const link = BrandStore.getLink(tid, brand.brandId, rp.projectId);
  if (!link) return { error: [404, 'BRAND_NOT_IN_PROJECT', '该品牌未关联到当前项目。'] };
  let comp = null;
  if (link.competitorRef) {
    const st = BrandSvc.loadProjectState(tid, rp.projectId);
    comp = BrandSvc.findCompetitor(st, link.competitorRef);
  }
  return { brand, projectId: rp.projectId, link, comp };
}

function parseRange(url) {
  const from = q(url, 'from'); const to = q(url, 'to');
  if (from && !isDate(from)) return { error: [400, 'INVALID_TIME_RANGE', 'from 必须是 YYYY-MM-DD 日期。'] };
  if (to && !isDate(to)) return { error: [400, 'INVALID_TIME_RANGE', 'to 必须是 YYYY-MM-DD 日期。'] };
  if (from && to && from > to) return { error: [400, 'INVALID_TIME_RANGE', 'from 不能晚于 to。'] };
  return { from: from || null, to: to || null };
}

function emptyMemory(scope) {
  return {
    brandId: scope.brand.brandId, projectId: scope.projectId,
    facts: [], versions: [], nextCursor: null,
    coverage: { product: null, catalog: null },
    state: 'not_started', stateText: '尚未开始积累',
    note: '该品牌还没有进入时序数据库。系统从首次成功采集开始积累，无法凭空补出更早历史。',
    legend: { sourceKinds: View.SOURCE_KIND_TEXT, timePrecisions: View.PRECISION_TEXT },
  };
}

// ---------------- GET /api/brands/:brandId/memory ----------------
async function memoryView(ctx, req, res, url, p) {
  if (req.method !== 'GET') return false;
  const tid = tidOf(ctx, req); if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const brandId = String(p.split('/')[3] || '');
  const scope = resolveBrandScope(ctx, tid, brandId, q(url, 'projectId'));
  if (scope.error) { ctx.sendJSON(res, scope.error[0], { error: scope.error[1], message: scope.error[2] }); return true; }
  const range = parseRange(url);
  if (range.error) { ctx.sendJSON(res, range.error[0], { error: range.error[1], message: range.error[2] }); return true; }
  const entityType = q(url, 'entityType');
  if (entityType && !Store.ENTITY_TYPES.includes(entityType)) {
    ctx.sendJSON(res, 400, { error: 'INVALID_ENTITY_TYPE', message: 'entityType 只支持 product 或 brand_catalog。' }); return true;
  }
  const rawTypes = (q(url, 'factTypes') || '').split(',').map(s => s.trim()).filter(Boolean);
  const badType = rawTypes.find(t => !Store.FACT_TYPE_SET.has(t));
  if (badType) {
    ctx.sendJSON(res, 400, { error: 'INVALID_FACT_TYPE', message: '不支持的事实类型：' + badType.slice(0, 40) }); return true;
  }
  const cursor = q(url, 'cursor');
  if (cursor && !Store.decodeCursor(cursor)) {
    ctx.sendJSON(res, 400, { error: 'INVALID_CURSOR', message: '分页游标无效，请重新加载。' }); return true;
  }
  const limit = Math.max(1, Math.min(Number(q(url, 'limit')) || 100, 500));
  if (!scope.comp || !scope.comp.id) return (ctx.sendJSON(res, 200, emptyMemory(scope)), true);
  const view = View.buildMemoryView(tid, scope.projectId, scope.comp.id, {
    entityType: entityType || null, factTypes: rawTypes.length ? rawTypes : null,
    from: range.from, to: range.to, cursor, limit,
  });
  const hasAny = view.facts.length > 0 || view.coverage.product || view.coverage.catalog;
  ctx.sendJSON(res, 200, Object.assign({
    brandId: scope.brand.brandId, projectId: scope.projectId,
    state: hasAny ? 'available' : 'not_started',
    stateText: hasAny ? '已开始积累' : '尚未开始积累',
  }, view));
  return true;
}

// ---------------- GET /api/brands/:brandId/timeline ----------------
async function timeline(ctx, req, res, url, p) {
  if (req.method !== 'GET') return false;
  const tid = tidOf(ctx, req); if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const brandId = String(p.split('/')[3] || '');
  const scope = resolveBrandScope(ctx, tid, brandId, q(url, 'projectId'));
  if (scope.error) { ctx.sendJSON(res, scope.error[0], { error: scope.error[1], message: scope.error[2] }); return true; }
  const range = parseRange(url);
  if (range.error) { ctx.sendJSON(res, range.error[0], { error: range.error[1], message: range.error[2] }); return true; }
  const limit = Math.max(1, Math.min(Number(q(url, 'limit')) || 100, 300));
  if (!scope.comp || !scope.comp.id) {
    ctx.sendJSON(res, 200, {
      brandId: scope.brand.brandId, projectId: scope.projectId, items: [], total: 0,
      firstRecordedAt: null, firstObservedAt: null, state: 'not_started',
      coverageSummary: { state: 'not_started', stateText: View.COVERAGE_TEXT.not_started },
      note: '尚未形成可核验历史记录；系统尚未对该品牌开始采集。',
      legend: { sourceKinds: View.SOURCE_KIND_TEXT, timePrecisions: View.PRECISION_TEXT },
    });
    return true;
  }
  const view = View.buildTimeline(tid, scope.projectId, scope.comp.id, { from: range.from, to: range.to, limit });
  const hasItems = view.items.length > 0;
  ctx.sendJSON(res, 200, Object.assign({
    brandId: scope.brand.brandId, projectId: scope.projectId,
    state: hasItems ? 'available' : 'not_started',
    stateText: hasItems ? '已形成可核验记录' : '尚未形成可核验历史记录',
  }, view, {
    emptyText: hasItems ? null : '尚未形成可核验历史记录；系统已从首次采集开始积累。',
    legend: { sourceKinds: View.SOURCE_KIND_TEXT, timePrecisions: View.PRECISION_TEXT, coverageStates: View.COVERAGE_TEXT },
  }));
  return true;
}

// ---------------- GET /api/brands/:brandId/history-coverage ----------------
async function historyCoverage(ctx, req, res, url, p) {
  if (req.method !== 'GET') return false;
  const tid = tidOf(ctx, req); if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const brandId = String(p.split('/')[3] || '');
  const scope = resolveBrandScope(ctx, tid, brandId, q(url, 'projectId'));
  if (scope.error) { ctx.sendJSON(res, scope.error[0], { error: scope.error[1], message: scope.error[2] }); return true; }
  const range = parseRange(url);
  if (range.error) { ctx.sendJSON(res, range.error[0], { error: range.error[1], message: range.error[2] }); return true; }
  // 默认窗口：近 12 个月（覆盖面板需要一个可读的区间；不伪造更早数据）
  const today = new Date();
  const defTo = today.toISOString().slice(0, 10);
  const defFrom = new Date(today.getTime() - 365 * 86400000).toISOString().slice(0, 10);
  const effFrom = range.from || defFrom;
  const effTo = range.to || defTo;
  if (!scope.comp || !scope.comp.id) {
    ctx.sendJSON(res, 200, {
      brandId: scope.brand.brandId, projectId: scope.projectId,
      window: { from: effFrom, to: effTo },
      dimensions: [], summary: { state: 'not_started', stateText: View.COVERAGE_TEXT.not_started, factCount: 0, evidenceCount: 0 },
      backfill: null,
      note: '该品牌尚未开始采集，没有可核验的时间覆盖。',
      legend: { coverageStates: View.COVERAGE_TEXT },
    });
    return true;
  }
  const cov = View.buildHistoryCoverage(tid, scope.projectId, scope.comp.id, { from: effFrom, to: effTo });
  const job = cov.backfill ? sanitizeJob(cov.backfill) : null;
  const note = cov.summary.state === 'not_started'
    ? '该品牌尚未开始采集，没有可核验的时间覆盖；系统从首次成功采集开始积累。'
    : cov.note;
  ctx.sendJSON(res, 200, {
    brandId: scope.brand.brandId, projectId: scope.projectId,
    window: { from: effFrom, to: effTo },
    dimensions: cov.dimensions, summary: cov.summary, backfill: job,
    note, legend: cov.legend,
  });
  return true;
}

function sanitizeJob(j) {
  if (!j) return null;
  return {
    jobId: j.jobId, capability: j.capability, sourceRoute: j.sourceRoute,
    status: j.status, statusText: JOB_STATUS_TEXT[j.status] || j.status,
    requested: { from: j.requestedFrom, to: j.requestedTo },
    counts: j.counts,
    coverageSummary: j.coverageSummary,
    failureClass: j.failureClass || null,
    errorUserText: j.errorUserText || null,
    createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
    progress: progressOf(j),
  };
}
const JOB_STATUS_TEXT = Object.freeze({
  pending: '排队中', running: '回补中', done: '已完成',
  partial: '部分完成', failed: '未完成',
  source_unavailable: '来源不可用', no_archive_record: '存档无记录', dead: '已停止',
});
function monthSpan(from, to) {
  const a = String(from || '').slice(0, 7), b = String(to || '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(a) || !/^\d{4}-\d{2}$/.test(b)) return 1;
  const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number);
  return Math.max(1, (by - ay) * 12 + (bm - am) + 1);
}
function progressOf(j) {
  const total = monthSpan(j.requestedFrom, j.requestedTo);
  // 进度只反映真实处理过的月份：失败/来源不可用时不得显示 100%
  const cp = j.checkpoint ? String(j.checkpoint).slice(0, 7) : null;
  let done = 0;
  if (cp && /^\d{4}-\d{2}$/.test(cp)) {
    const [fy, fm] = String(j.requestedFrom).slice(0, 7).split('-').map(Number);
    const [cy, cm] = cp.split('-').map(Number);
    done = Math.max(0, Math.min(total, (cy - fy) * 12 + (cm - fm) + 1));
  }
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  let text;
  if (j.status === 'pending') text = '等待执行';
  else if (j.status === 'running') text = done > 0 ? '已处理 ' + done + '/' + total + ' 个月' : '准备中';
  else text = JOB_STATUS_TEXT[j.status] || j.status;
  return { totalMonths: total, doneMonths: done, percent, text };
}

// ---------------- POST /api/brands/:brandId/history-backfill ----------------
async function historyBackfillCreate(ctx, req, res, url, p) {
  if (req.method !== 'POST') return false;
  const tid = tidOf(ctx, req); if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  let body = {};
  try {
    const raw = await ctx.readBody(req);
    let parsed = raw;
    if (Buffer.isBuffer(raw)) { try { parsed = JSON.parse(raw.toString('utf8')); } catch (e) { parsed = null; } }
    else if (typeof raw === 'string') { try { parsed = raw ? JSON.parse(raw) : {}; } catch (e) { parsed = null; } }
    body = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch (e) { body = {}; }
  const brandId = String(p.split('/')[3] || '');
  const scope = resolveBrandScope(ctx, tid, brandId, body.projectId || q(url, 'projectId'));
  if (scope.error) { ctx.sendJSON(res, scope.error[0], { error: scope.error[1], message: scope.error[2] }); return true; }
  const capability = String(body.capability || 'shopify_catalog').slice(0, 60);
  // 第一阶段只接受 Shopify 目录回补；其余能力明确拒绝，不静默排队
  if (capability !== 'shopify_catalog') {
    ctx.sendJSON(res, 400, {
      error: 'CAPABILITY_NOT_SUPPORTED',
      message: '第一阶段只支持 Shopify 公开商品目录的历史回补，其它维度尚未接入历史存档。',
    });
    return true;
  }
  if (!scope.comp || !scope.comp.id || !scope.comp.url) {
    ctx.sendJSON(res, 400, { error: 'COMPETITOR_UNRESOLVED', message: '该品牌还没有可核验的官网，暂不能回补历史。' }); return true;
  }
  if (scope.comp.isShopify !== true) {
    ctx.sendJSON(res, 400, { error: 'CAPABILITY_NOT_SUPPORTED', message: '该品牌尚未确认使用 Shopify 公开目录，暂不支持历史回补。' }); return true;
  }
  const from = String(body.from || '').slice(0, 10);
  const to = String(body.to || '').slice(0, 10);
  if (!isDate(from) || !isDate(to)) {
    ctx.sendJSON(res, 400, { error: 'INVALID_TIME_RANGE', message: 'from 与 to 必须是 YYYY-MM-DD 日期。' }); return true;
  }
  if (from > to) { ctx.sendJSON(res, 400, { error: 'INVALID_TIME_RANGE', message: 'from 不能晚于 to。' }); return true; }
  const spanMonths = monthSpan(from, to);
  if (spanMonths > 36) {
    ctx.sendJSON(res, 400, { error: 'TIME_RANGE_TOO_WIDE', message: '单次回补最多 36 个月，请缩小区间后重试。' }); return true;
  }
  const created = Store.createBackfillJob({
    tenantId: tid, projectId: scope.projectId, competitorId: scope.comp.id,
    capability, from, to, sourceRoute: 'web_archive',
  });
  if (!created.deduped) Backfill.kick(tid, created.job.jobId);
  ctx.sendJSON(res, created.deduped ? 200 : 202, {
    brandId: scope.brand.brandId, projectId: scope.projectId,
    jobId: created.job.jobId, deduped: created.deduped,
    job: sanitizeJob(created.job),
    message: created.deduped
      ? '已有相同范围的回补任务在进行，已复用该任务（不重复抓取、不重复产生费用）。'
      : '已开始回补历史：将按月查找公开网页存档并逐条核验来源。',
  });
  return true;
}

// ---------------- GET /api/history-backfill/:jobId ----------------
async function backfillJob(ctx, req, res, url, p) {
  if (req.method !== 'GET') return false;
  const tid = tidOf(ctx, req); if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const jobId = String(p.split('/')[3] || '').slice(0, 80);
  const job = Store.getBackfillJob(tid, jobId);
  // 跨租户/不存在统一 404（不泄露存在性）
  if (!job) { ctx.sendJSON(res, 404, { error: 'JOB_NOT_FOUND', message: '回补任务不存在。' }); return true; }
  // 项目归属校验：任务所属项目必须属于当前租户
  if (!db.getProject(tid, job.projectId)) {
    ctx.sendJSON(res, 404, { error: 'JOB_NOT_FOUND', message: '回补任务不存在。' }); return true;
  }
  ctx.sendJSON(res, 200, sanitizeJob(job));
  return true;
}

module.exports = { memoryView, timeline, historyCoverage, historyBackfillCreate, backfillJob, JOB_STATUS_TEXT, progressOf };
