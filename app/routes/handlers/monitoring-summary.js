// 监控摘要（r4g §四）：竞品监控首页唯一首屏请求。
// 只读数据库现有投影，不做任何外部网页采集；summary 由服务端组装，
// 前端一次拿到行 + 覆盖 + 健康计数（载荷 ~8KB，替代此前的
// watch-targets + brands(122KB) + intel-inbox 三连请求）。
// 20s 硬超时：任何慢子查询都不能拖住页面——超时返回已有部分 + partial=true。
'use strict';

const fs = require('fs');
const path = require('path');

const SIGNAL_ZH = { price: '价格', launch: '上新', stock: '库存', site_change: '官网内容', reviews: '评论', social: '社媒', ads: '广告', trends: '搜索热度' };

function loadStateCompetitors(tenantId, projectId) {
  try {
    const { projFile } = require('../../core/state-store.js');
    const f = projFile(projectId, tenantId);
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    const list = Array.isArray(st.competitors) ? st.competitors : [];
    const out = new Map();
    for (const c of list) {
      if (c && c.id) out.set(String(c.id), { id: String(c.id), name: String(c.name || c.id), url: c.url || null, isShopify: !!c.isShopify, removed: !!c.removed });
    }
    return out;
  } catch (e) { return new Map(); }
}

async function buildSummary(ctx, tid, projectId) {
  const WS = require('../../services/watch-store.js');
  const WIntent = require('../../services/watch-intent.js');
  const Inbox = require('../../services/intel-inbox.js');
  const BrandService = require('../../services/brand-service.js');
  const Surface = require('../../services/surface-store.js');

  const comps = loadStateCompetitors(tid, projectId);
  const nameOf = (id) => (comps.get(String(id)) || {}).name || String(id);
  const targets = WS.listWatchTargets(tid, projectId) || [];
  const intents = (WIntent.listIntents(tid, projectId) || []).map(WIntent.view);

  // 行组装（与原前端同口径）：active 优先，意向单列「建立中/来源失败」
  const intentByComp = new Map();
  for (const i of intents) {
    if (i.state === 'cancelled') continue;
    const prev = intentByComp.get(i.competitorId);
    if (!prev || i.state === 'establishing') intentByComp.set(i.competitorId, i);
  }
  const inComp = new Set();
  const rows = [];
  for (const t of targets) {
    inComp.add(t.competitorId);
    const intent = intentByComp.get(t.competitorId);
    const st = t.monitoringStatus || t.monitoring_status;
    const state = (st === 'active' || st === 'degraded') ? 'active' : (st === 'paused' ? 'paused' : 'none');
    const signals = t.enabledSignals || t.enabled_signals || [];
    rows.push({
      competitorId: t.competitorId,
      name: nameOf(t.competitorId),
      state,
      signals,
      signalsText: signals.map(s => SIGNAL_ZH[s] || s).join('、') || '未启用',
      lastSuccessAt: t.lastSuccessAt || t.last_success_at || null,
      watchTargetId: t.watchTargetId,
      intentId: intent ? intent.intentId : null,
      note: null,
    });
  }
  for (const i of intents) {
    if (inComp.has(i.competitorId) || i.state === 'cancelled' || i.state === 'promoted') continue;
    rows.push({
      competitorId: i.competitorId,
      name: nameOf(i.competitorId),
      state: i.state === 'source_failed' ? 'source_failed' : 'establishing',
      signals: [],
      signalsText: '',
      lastSuccessAt: null,
      watchTargetId: null,
      intentId: i.intentId,
      note: i.reasonText || null,
    });
  }
  const rank = (r) => (r.state === 'active' ? 0 : r.state === 'establishing' ? 1 : r.state === 'source_failed' ? 2 : r.state === 'paused' ? 3 : 4);
  rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  // 巡检覆盖（复用收件箱状态里的最新窗口逻辑）
  let coverage = null;
  try {
    const st = Inbox.inboxState(tid, projectId, 'Asia/Shanghai');
    coverage = {
      activeTargets: st.activeTargets, pausedTargets: st.pausedTargets,
      signalsText: st.signalsText || '', lastWindowAt: st.lastWindowAt || null,
      todayInspected: !!st.todayInspected, todayWindowCount: st.todayWindowCount || 0,
      coverage: st.coverage || null,
      windowCount: st.windowCount || 0,
      // 来源异常简表（真实失败 + notes；limited/not_configured 不列失败）
      sources: st.sources || { total: 0, ok: 0, failed: 0, items: [], notes: [], latestAt: null },
    };
  } catch (e) { coverage = null; }

  // 健康计数（复用品牌库唯一投影口径；只要计数，不要档案）
  let healthSummary = null;
  try {
    const views = BrandService.listBrandViews(tid, projectId);
    const stats = BrandService.buildBrandsProjectStats ? BrandService.buildBrandsProjectStats(views) : null;
    // r4g §七：覆盖限制拆成「部分信号品牌 / 尚未接入维度」，品牌数与维度数不混用
    const limits = (stats && stats.coverageLimited) || {};
    healthSummary = stats ? {
      brands: stats.brands,
      accumulating: stats.accumulating,
      collecting: stats.collecting,
      needsAttention: stats.needsAttention,
      limited: stats.limited,
      partialSignalBrands: Number(limits.partialSignalBrands != null ? limits.partialSignalBrands : (limits.brands || 0)),
      notIntegratedDimensions: Number(limits.notIntegratedDimensions != null ? limits.notIntegratedDimensions : (limits.dimensions || 0)),
    } : null;
  } catch (e) { healthSummary = null; }

  // 每信号覆盖品牌数（§六.1 展示用）
  const signalCoverage = {};
  for (const t of targets) {
    if ((t.monitoringStatus || t.monitoring_status) !== 'active') continue;
    for (const s of (t.enabledSignals || t.enabled_signals || [])) {
      signalCoverage[s] = (signalCoverage[s] || 0) + 1;
    }
  }

  // §六.1：监控覆盖 reconcile 只能后台入队——这里仅返回「是否有品牌尚未在监控」，
  // 由前端在用户点击时才触发（页面加载绝不发起 reconcile/采集）。
  const unmonitored = [...comps.values()].filter(c => !c.removed && !inComp.has(c.id) && !intentByComp.has(c.id)).map(c => c.id);

  return {
    projectId,
    partial: false,
    totals: {
      projectBrands: comps.size,
      active: rows.filter(r => r.state === 'active').length,
      paused: rows.filter(r => r.state === 'paused').length,
      establishing: rows.filter(r => r.state === 'establishing').length,
      sourceFailed: rows.filter(r => r.state === 'source_failed').length,
      unmonitored: unmonitored.length,
      signalCoverage,
    },
    coverage,
    healthSummary,
    rows,
    unmonitored,
    generatedAt: new Date().toISOString(),
  };
}

async function summary(ctx, req, res, url) {
  const started = Date.now();
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant' || !ap.payload) { ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED' }); return true; }
  const tid = ap.payload.tid;
  const projectId = url.searchParams.get('projectId') || '';
  if (!projectId) { ctx.sendJSON(res, 400, { error: 'PROJECT_REQUIRED', message: '请先选择项目。' }); return true; }

  // 20s 硬超时：慢子查询只丢部分数据，不让浏览器等数分钟
  let timer = null;
  const partial = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timeout: true }), 20000);
  });
  let out;
  try {
    out = await Promise.race([buildSummary(ctx, tid, projectId), partial]);
  } catch (e) {
    out = { __error: String((e && e.message) || e) };
  } finally { if (timer) clearTimeout(timer); }

  if (out && out.__timeout) {
    ctx.sendJSON(res, 200, { projectId, partial: true, partialReason: 'summary_timeout', rows: [], totals: null, coverage: null, healthSummary: null, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - started });
    return true;
  }
  if (!out || out.__error) {
    ctx.sendJSON(res, 500, { error: 'SUMMARY_FAILED', message: '监控摘要暂时无法生成，请稍后重试。' });
    return true;
  }
  out.elapsedMs = Date.now() - started;
  ctx.sendJSON(res, 200, out);
  return true;
}

module.exports = { summary };
