'use strict';
// ============================================================
// handlers/core-product.js —— 核心产品主闭环端点组（SC-04）
//   GET  /api/brands?projectId=                    竞品库列表（tenant）
//   GET  /api/brands/:brandId                      品牌详情（统一档案）
//   GET  /api/brands/:brandId/timeline             品牌时间线
//   GET  /api/brands/:brandId/coverage             数据覆盖与来源
//   GET  /api/intel/inbox?projectId=&brandId=&dimension=&eventType=&verificationStatus=&from=&to=&cursor=&limit=
//                                                  每日变化收件箱（SC-08 §二：只含 monitoring 确定性变化）
//   GET  /api/intelligence?projectId=&brandId=&type=&from=&to=   情报库（历史口径，保留兼容）
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
const MemView = require('../../services/memory-view.js');
const VoiceUnified = require('../../services/voice-unified.js'); // SC-05：时序事件最小接入（只读投影）

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
  // SC-09 §二/§四：进入竞品数据库即自动建立（并对账）本项目首采批次——
  // 用户不需要逐个点击品牌；幂等：刷新/重复进入/重启都不会产生第二条批次或双任务。
  // ZB_FIRST_COLLECTION_AUTO=off 只关闭「进入页面自动建批次」（测试/运维场景）；
  // 显式调用 ensureBatch 与端点重试不受影响。
  let firstCollection = null;
  try {
    const FC = require('../../services/first-collection.js');
    if (String(process.env.ZB_FIRST_COLLECTION_AUTO || '') !== 'off') {
      FC.ensureBatch({ tenantId: tid, projectId: rp.projectId });
    }
    firstCollection = FC.summaryForProject(tid, rp.projectId);
  } catch (e) { firstCollection = null; }
  const items = BrandSvc.listBrandViews(tid, rp.projectId);
  // 品牌卡片的「首采」事实（逐品牌 × 逐能力真实状态；不含推断）
  let fcByBrand = {};
  try {
    const FC = require('../../services/first-collection.js');
    for (const b of items) {
      if (!b.competitorId) continue;
      const s = FC.brandSummary(tid, rp.projectId, b.competitorId);
      if (s) fcByBrand[b.competitorId] = s;
    }
  } catch (e) { fcByBrand = {}; }
  for (const b of items) {
    b.firstCollection = b.competitorId ? (fcByBrand[b.competitorId] || null) : null;
  }
  // r3 §四：品牌级四类计数（已建立数据 / 正在采集 / 有限覆盖 / 真实需要处理），
  // 由 SourceHealth 汇总，**去重品牌**；维度数量只出现在明细里。
  let healthSummary = null;
  try { healthSummary = require('../../services/source-health.js').summarize(items.map(b => b.sourceHealth)); }
  catch (e) { healthSummary = null; }
  ctx.sendJSON(res, 200, {
    projectId: rp.projectId, brands: items, count: items.length,
    firstCollection,
    healthSummary,
    // SC-08 r2 §四：首页四项统计（品牌总数 / 已开始积累 / 正在采集 / 需要处理），
    // 与卡片同源派生（后端算，禁止前端各算一套）
    stats: BrandSvc.buildBrandsProjectStats(items, { fcByBrand }),
    // 项目级采集覆盖（七态计数 + 失败明细）：只作为「需要处理」的下钻明细，
    // 不再在首页顶部重复铺一条覆盖条
    collectionCoverage: (() => {
      try { return BrandSvc.buildProjectCollectionCoverage(tid, rp.projectId); } catch (e) { return null; }
    })(),
  });
  return true;
}

// ---------- SC-09：项目级自动首采（状态轮询 / 失败项重试） ----------
async function firstCollectionStatus(ctx, req, res, url) {
  if (req.method !== 'GET') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const rp = resolveProject(ctx, tid, q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  const FC = require('../../services/first-collection.js');
  // 轮询入口做**幂等对账**（补齐缺失计划 / 回收移出品牌 / 重新评估可恢复项），
  // 绝不重跑已成功项、绝不重试仍未配置或覆盖外的来源；外部请求仍由持久任务执行，
  // 本请求不等待任何抓取。
  try {
    const b = FC.getBatch(tid, rp.projectId);
    if (b) FC.reconcileBatchPlan(b.batch_id);
  } catch (e) { /* 无批次则跳过 */ }
  const summary = FC.summaryForProject(tid, rp.projectId);
  ctx.sendJSON(res, 200, { projectId: rp.projectId, firstCollection: summary });
  return true;
}

async function firstCollectionRetry(ctx, req, res, url) {
  if (req.method !== 'POST') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  let body = {};
  try { body = await ctx.readBody(req) || {}; } catch (e) { body = {}; }
  const rp = resolveProject(ctx, tid, body.projectId || q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  const FC = require('../../services/first-collection.js');
  const r = FC.retryFailed(tid, rp.projectId);
  ctx.sendJSON(res, 200, {
    projectId: rp.projectId, retried: r.retried || 0, skipped: r.skipped || 0,
    firstCollection: FC.summaryForProject(tid, rp.projectId),
    message: (r.retried || 0) > 0
      ? '已重新安排可恢复的项，页面会自动更新。'
      : ((r.skipped || 0) > 0 ? '还有来源尚未完成配置，暂不重复请求。' : '当前没有需要重新检查的失败项。'),
  });
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
  const cov = BrandSvc.buildBrandCoverage(tid, rp.projectId, comp || {});
  // SC-08 r2 §六：唯一的 brandCoverage 投影（维度总数来自 Registry，六态严格区分）
  ctx.sendJSON(res, 200, { brandId: brand.brandId, projectId: rp.projectId, brandCoverage: cov });
  return true;
}

// ---------------- 情报库 ----------------
// ---------------- SC-08 §二：每日变化收件箱 ----------------
// 只回答「今天/最近系统新发现了哪些竞争变化」：
//   · 只含 origin='monitoring' 的确定性变化（首次 baseline / 回补历史 / 报告 / 缺口全部排除）；
//   · 顶部统计为项目今日口径（不随筛选变化）；正文按自然日倒序分组；
//   · cursor 稳定分页（默认 30，上限 100），绝不一次返回无限历史。
async function intelInbox(ctx, req, res, url) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' }); return true; }
  const rp = resolveProject(ctx, tid, q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  const Inbox = require('../../services/intel-inbox.js');
  const limitRaw = q(url, 'limit');
  if (limitRaw != null && !/^\d+$/.test(limitRaw)) {
    ctx.sendJSON(res, 400, { error: 'INVALID_LIMIT', message: 'limit 须为正整数。' }); return true;
  }
  const limit = limitRaw == null ? 30 : Math.max(1, Math.min(Number(limitRaw), 100));
  let data;
  try {
    data = Inbox.listInbox({
      tenantId: tid, projectId: rp.projectId,
      brandId: q(url, 'brandId') || undefined,
      dimension: q(url, 'dimension') || undefined,
      eventType: q(url, 'eventType') || undefined,
      verificationStatus: q(url, 'verificationStatus') || undefined,
      from: q(url, 'from') || undefined,
      to: q(url, 'to') || undefined,
      cursor: q(url, 'cursor') || undefined,
      limit,
      timeZone: q(url, 'timeZone') || undefined,
    });
  } catch (e) {
    ctx.sendJSON(res, 500, { error: 'INBOX_UNAVAILABLE', message: '收件箱暂不可用，请稍后重试。' }); return true;
  }
  ctx.sendJSON(res, 200, Object.assign({ projectId: rp.projectId }, data));
  return true;
}

// ---------------- 事件级纠错（收件箱「反馈有误」） ----------------
// 不改写已记录的观察事实，只登记质疑并进入复核队列（忠实助理红线）。
async function intelEventCorrection(ctx, req, res, url) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' }); return true; }
  let body = {};
  try { body = await ctx.readBody(req) || {}; } catch (e) { body = {}; }
  const rp = resolveProject(ctx, tid, body.projectId || q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  const Inbox = require('../../services/intel-inbox.js');
  const r = Inbox.submitCorrection({
    tenantId: tid, projectId: rp.projectId,
    eventId: body.eventId, reason: body.reason, note: body.note,
  });
  if (!r.ok) {
    if (r.reason === 'EVENT_NOT_FOUND') {
      ctx.sendJSON(res, 404, { error: 'EVENT_NOT_FOUND', message: '这条变化记录不存在或不属于当前项目。' });
      return true;
    }
    ctx.sendJSON(res, 400, { error: r.reason || 'CORRECTION_REJECTED', message: '反馈未提交，请稍后重试。' });
    return true;
  }
  ctx.sendJSON(res, 200, { ok: true, duplicate: !!r.duplicate, message: r.duplicate ? (r.message || '这条反馈已记录，我们在复核中。') : '已收到反馈，我们会复核这条记录。' });
  return true;
}

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
    // SC-06 三：评论变化统一读「用户声音与公开评论」读模型（一套口径；
    // 独立字段，不与采集观察 items 混排）
    voiceChanges: VoiceUnified.buildProjectVoiceSummary(tid, rp.projectId, { brandId }),
    // SC-07 §3：没有实际观察的品牌不再逐条出卡，改由项目级覆盖摘要承载
    //（零结果 / 失败 / 未采集分别计数；失败可查品牌与原因）
    voiceCoverage: VoiceUnified.buildProjectVoiceCoverage(tid, rp.projectId),
    collectionCoverage: (() => {
      try { return require('../../services/brand-service.js').buildProjectCollectionCoverage(tid, rp.projectId); } catch (e) { return null; }
    })(),
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
// r2 性能：机会视图三段聚合（view / historyBasis / foundation）在同一进程内复用，
// 短 TTL 内重复请求不再重算（页面一次加载会发两次请求，评测/刷新同样重复）；
// 每次响应带 phaseTimings（仅 ?debug=1 时返回，避免把内部耗时塞给所有用户）。
const OPP_CACHE = new Map(); // `${tid}:${pid}` -> { at, payload }
const OPP_TTL_MS = Math.max(0, Number(process.env.ZB_OPP_CACHE_MS || 20000));
const OPP_CACHE_MAX = 64;
function oppCacheGet(key) {
  if (!OPP_TTL_MS) return null;
  const e = OPP_CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.at > OPP_TTL_MS) { OPP_CACHE.delete(key); return null; }
  return e;
}
function oppCacheSet(key, payload) {
  if (!OPP_TTL_MS) return;
  if (OPP_CACHE.size >= OPP_CACHE_MAX) { const k0 = OPP_CACHE.keys().next().value; OPP_CACHE.delete(k0); }
  OPP_CACHE.set(key, { at: Date.now(), payload });
}

// r4 §九：载荷拆分 —— 默认 scope=summary 只保留每行/每条机会的第一条证据引用
//（其余折叠为 evidenceCount），把约 227KB 首屏压到几十 KB；完整引用按品牌用
// scope=detail 拉取（打开证据抽屉时才请求）。scope=full 保留旧行为（测试/审计用）。
function trimEvidenceRefs(payload) {
  // 🔴 不可原地修改：OPP_CACHE 命中路径与本次响应共享嵌套引用，原地裁剪会把
  // 缓存里的完整证据引用一并剪掉（scope=full/detail 永远拿不到完整数据）。
  // 这里按「复制被裁剪的列表」实现，其余子树保持共享引用。
  const trimRows = (rows) => rows.map((r) => {
    if (!r || !Array.isArray(r.evidenceRefs)) return r;
    return Object.assign({}, r, { evidenceCount: r.evidenceRefs.length, evidenceRefs: r.evidenceRefs.slice(0, 1) });
  });
  try {
    const f = payload.foundation;
    if (f && f.modules) {
      const modules = Object.assign({}, f.modules);
      for (const k of Object.keys(modules)) {
        const m = modules[k];
        if (!m) continue;
        if (Array.isArray(m.rows)) modules[k] = Object.assign({}, m, { rows: trimRows(m.rows) });
        if (Array.isArray(m.groups)) modules[k] = Object.assign({}, m, { groups: m.groups.map(g => (g && Array.isArray(g.rows)) ? Object.assign({}, g, { rows: trimRows(g.rows) }) : g) });
      }
      payload.foundation = Object.assign({}, f, { modules });
    }
    if (payload.foundation && Array.isArray(payload.foundation.opportunities)) {
      payload.foundation = Object.assign({}, payload.foundation, { opportunities: trimRows(payload.foundation.opportunities) });
    }
  } catch (e) { /* 裁剪失败按原样返回（宁可大也不坏） */ }
  return payload;
}

async function opportunities(ctx, req, res, url) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const rp = resolveProject(ctx, tid, q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  const debug = q(url, 'debug') === '1';
  const scope = q(url, 'scope') || 'summary'; // summary（默认）| detail | full
  const key = tid + ':' + rp.projectId;
  const hit = oppCacheGet(key);
  if (hit) {
    const payload = Object.assign({}, hit.payload);
    payload.meta = Object.assign({}, payload.meta, { cached: true, scope, cacheAgeMs: Date.now() - hit.at });
    ctx.sendJSON(res, 200, scope === 'summary' ? trimEvidenceRefs(payload) : payload);
    return true;
  }
  const t0 = process.hrtime.bigint();
  const view = ReportSvc.buildOpportunities(tid, rp.projectId);
  const t1 = process.hrtime.bigint();
  // SC-05：机会判断的数据基础补「可用历史跨度」与「本次使用的时间范围」
  let historyBasis = null;
  try { historyBasis = MemView.projectHistoryBasis(tid, rp.projectId); } catch (e) { historyBasis = null; }
  const t2 = process.hrtime.bigint();
  // SC-12 §六.1：机会数据基础——按可用维度独立工作（价格/商品/上新/评论独立成模块），
  // 缺失维度保持 null 并如实标注状态；不再因单个维度不可用而整页空白。
  let foundation = null;
  try { foundation = require('../../services/opportunity-foundation.js').buildOpportunityFoundation(tid, rp.projectId); }
  catch (e) { foundation = null; }
  const t3 = process.hrtime.bigint();
  const ms = (a, b) => Math.round(Number(b - a) / 1e6);
  const timings = { view: ms(t0, t1), historyBasis: ms(t1, t2), foundation: ms(t2, t3), total: ms(t0, t3) };
  const payload = Object.assign({ projectId: rp.projectId, historyBasis, foundation }, view);
  payload.meta = { cached: false, scope, timings: debug ? timings : undefined };
  oppCacheSet(key, Object.assign({ projectId: rp.projectId, historyBasis, foundation }, view));
  // r4 §九：默认摘要口径（证据引用折叠）；detail/full 才带完整引用
  ctx.sendJSON(res, 200, scope === 'summary' ? trimEvidenceRefs(payload) : payload);
  return true;
}

// ---------------- 工作台观察卡（r4 §三） ----------------
// 只消费真实观察（价格模块实抓），数据缺口进 coverage 不进行动卡。
async function workbenchCards(ctx, req, res, url) {
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const rp = resolveProject(ctx, tid, q(url, 'projectId'));
  if (rp.error) { ctx.sendJSON(res, rp.error[0], { error: rp.error[1], message: rp.error[2] }); return true; }
  const WB = require('../../services/workbench-cards.js');
  const data = WB.buildWorkbenchCards(tid, rp.projectId, { fresh: q(url, 'fresh') === '1' });
  ctx.sendJSON(res, 200, Object.assign({ projectId: rp.projectId }, data));
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
  firstCollectionStatus, firstCollectionRetry,
  intelInbox, intelEventCorrection, intelligence, opportunities, workbenchCards,
  reportsList, reportsCreate, reportDetail,
};
