'use strict';
// ============================================================
// handlers/watch.js —— 正式监控基础端点组（WatchTarget + Coverage + 三态日报）
// ------------------------------------------------------------
// 规格依据：
//   · 03 v0.3 §7 REST：POST/PATCH/GET /api/watch-targets（v0 加 DELETE 停用）
//   · 01 v1.3.3 §16 加入监控：用户明确执行后才进正式巡检（发现/调研活跃 ≠ 已监控）
//   · 03 v0.3 §17 Multi-tenant：Workspace isolation / authz——全部读写按
//     登录租户硬过滤；跨租户 404（不泄露存在性）
//   · 03 v0.3 §9 Idempotency：创建去重（同 tenant×project×competitor 原样返回）
//   · 03 v0.3 §14：Daily Brief 读 Coverage 持久层，不重新猜
// handler 契约：处理并已发响应 → return true（registry 纪律，404/400 分支同样显式 true）
// ============================================================
const db = require('../../services/db.js');
const WS = require('../../services/watch-store.js');
const WM = require('../../services/watch-monitor.js');
const { buildDailyBrief } = require('../../research/digest.js');
const fs = require('fs');

function tidOf(ctx, req) {
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') return null;
  return (ap.payload && ap.payload.tid) || null;
}
function send400(error, message) { return { code: 400, body: { error, message } }; }

function targetView(t, latestWin) {
  const v = Object.assign({}, t);
  delete v.tenantId; // 租户不回显自身 id（内部标识）
  if (latestWin) {
    v.lastWindow = {
      windowKey: latestWin.windowKey, slot: latestWin.slot, endedAt: latestWin.endedAt,
      coverage: latestWin.coverage, partialScan: latestWin.partialScan,
      failureReasons: latestWin.failureReasons, attempted: latestWin.attempted, succeeded: latestWin.succeeded,
    };
  }
  return v;
}

// ---------- POST /api/watch-targets（加入监控） ----------
async function createTarget(ctx, req, res, url, p) {
  if (p !== '/api/watch-targets' || req.method !== 'POST') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可操作监控对象。' }); return true; }
  let body = {};
  try { body = await ctx.readBody(req) || {}; } catch (e) { body = {}; }
  const competitorId = typeof body.competitorId === 'string' ? body.competitorId.trim().slice(0, 80) : '';
  if (!competitorId) {
    const e = send400('EMPTY', '缺少 competitorId。'); ctx.sendJSON(res, e.code, e.body); return true;
  }
  // 项目归属：显式 projectId 必须属于本租户（db 硬过滤）；缺省 = 当前项目（ALS）
  let projectId = typeof body.projectId === 'string' ? body.projectId.trim().slice(0, 80) : '';
  let state = null;
  if (projectId) {
    if (!db.getProject(tid, projectId)) { ctx.sendJSON(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在或不属于当前租户。' }); return true; }
    try {
      const f = ctx.projFile && ctx.projFile(projectId, tid);
      if (f) state = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) { state = null; }
    if (!state) { // projFile 不可用时回退当前档案（仍须是同一项目，防跨项目误绑）
      state = ctx.loadState();
      if (state && state.projectId && state.projectId !== projectId) state = null;
    }
  } else {
    state = ctx.loadState();
    projectId = state && state.projectId ? state.projectId : '';
    if (!projectId) { ctx.sendJSON(res, 404, { error: 'PROJECT_NOT_FOUND', message: '没有当前调研项目。' }); return true; }
  }
  // 最低资格（04 §3.2：仅对已满足最低资格者开放「加入监控」）：竞品在档案中且研究已完成
  const comp = state && Array.isArray(state.competitors) ? state.competitors.find(c => c && c.id === competitorId) : null;
  if (!comp) { ctx.sendJSON(res, 404, { error: 'COMPETITOR_NOT_FOUND', message: '竞争品牌不存在于当前项目。' }); return true; }
  if (comp.status !== 'done') {
    const e = send400('COMPETITOR_NOT_READY', '该品牌研究尚未完成，暂不能加入监控。'); ctx.sendJSON(res, e.code, e.body); return true;
  }
  // Workspace 时区：intent.regions → 目标市场 IANA 映射（03 §12 不存固定 offset）；
  // 显式传入合法 IANA 名时优先
  let timezone = typeof body.timezone === 'string' ? body.timezone.trim() : '';
  if (!WS.validTimezone(timezone)) {
    const regions = (state && state.intent && Array.isArray(state.intent.regions)) ? state.intent.regions : [];
    timezone = WS.REGION_TZ[regions[0]] || 'UTC';
  }
  const market = typeof body.market === 'string' ? body.market : (regions0(state) || '');
  // 整改 §9 能力门槛：按当前品牌当前可用的直接源计算 supportedSignals。
  // 已实现直接源 = Shopify /products.json 公开端点（price/launch/stock 共用一次直抓，
  // 零 LLM 零搜索）；接入其他直接源时在此扩展。不因接入搜索 API 而宣称持续监控能力
  //（搜索是研究通道，不是持续直采通道）。一个支持信号都没有 → CAPABILITY_NOT_SUPPORTED，
  // 不让用户加入一个必然失败的监控。
  const shopifyCap = !!(comp.url && (comp.isShopify || /shopify/i.test(String(comp.url))));
  const supportedSignals = shopifyCap ? ['price', 'launch', 'stock'] : [];
  const requested = Array.isArray(body.enabledSignals) && body.enabledSignals.length
    ? body.enabledSignals.map(s => String(s || '').trim().toLowerCase()).filter(s => WS.SIGNALS.has(s))
    : null;
  if (!supportedSignals.length || (requested && !requested.some(s => supportedSignals.includes(s)))) {
    ctx.sendJSON(res, 400, {
      error: 'CAPABILITY_NOT_SUPPORTED',
      message: '当前品牌没有可用的直接监控源，暂不能加入持续监控（当前仅支持 Shopify 店铺的价格/上新/断货直采）。',
    });
    return true;
  }
  const enabledSignals = requested ? requested.filter(s => supportedSignals.includes(s)) : supportedSignals;
  const r = WS.createWatchTarget({
    tenantId: tid, projectId, competitorId, market, timezone,
    enabledSignals,
    supportedSignals,
    enrichmentStatus: comp.status === 'done' ? 'complete' : 'not_started', // 映射既有 enrichment 链产出，不虚标
  });
  ctx.sendJSON(res, r.existed ? 200 : 201, { target: targetView(r.target, WS.latestWindowFor(tid, r.target.watchTargetId)), existed: r.existed, reactivated: !!r.reactivated });
  return true;
}
function regions0(state) {
  const r = state && state.intent && Array.isArray(state.intent.regions) ? state.intent.regions : [];
  return r[0] || '';
}

// ---------- GET /api/watch-targets（本租户列表 + 最近窗口 Coverage） ----------
async function listTargets(ctx, req, res, url, p) {
  if (p !== '/api/watch-targets' || req.method !== 'GET') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可查看监控对象。' }); return true; }
  const projectId = url.searchParams.get('projectId');
  const targets = WS.listWatchTargets(tid, projectId);
  ctx.sendJSON(res, 200, { targets: targets.map(t => targetView(t, WS.latestWindowFor(tid, t.watchTargetId))) });
  return true;
}

// ---------- PATCH /api/watch-targets/:id（暂停/恢复/改信号/改时区） ----------
async function patchTarget(ctx, req, res, url, p) {
  const m = /^\/api\/watch-targets\/([^/]+)$/.exec(p);
  if (!m || req.method !== 'PATCH') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可操作监控对象。' }); return true; }
  const id = decodeURIComponent(m[1]).slice(0, 90);
  let body = {};
  try { body = await ctx.readBody(req) || {}; } catch (e) { body = {}; }
  const patch = {};
  if (body.action === 'pause') patch.monitoringStatus = 'paused';       // 00 §3.3 词表内
  else if (body.action === 'resume') patch.monitoringStatus = 'active';
  else if (body.monitoringStatus !== undefined) patch.monitoringStatus = body.monitoringStatus;
  if (body.enabledSignals !== undefined) patch.enabledSignals = body.enabledSignals;
  if (body.timezone !== undefined) patch.timezone = body.timezone;
  if (body.market !== undefined) patch.market = body.market;
  const r = WS.updateWatchTarget(tid, id, patch);
  if (!r) { ctx.sendJSON(res, 404, { error: 'WATCH_TARGET_NOT_FOUND', message: '监控对象不存在。' }); return true; }
  if (r && r.error) {
    const e = send400(r.error, r.error === 'INVALID_TIMEZONE' ? '时区必须是合法 IANA 名称。' : '状态值不合法。');
    ctx.sendJSON(res, e.code, e.body); return true;
  }
  ctx.sendJSON(res, 200, { target: targetView(r, WS.latestWindowFor(tid, id)) });
  return true;
}

// ---------- DELETE /api/watch-targets/:id（停用并移出正式巡检） ----------
// 整改 §5：软停用（monitoring_status='inactive'），WatchTarget、窗口、事件与历史
// 全部保留可查；再次加入同一对象由 createWatchTarget 恢复原目标并重新激活。
async function deleteTarget(ctx, req, res, url, p) {
  const m = /^\/api\/watch-targets\/([^/]+)$/.exec(p);
  if (!m || req.method !== 'DELETE') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可操作监控对象。' }); return true; }
  const id = decodeURIComponent(m[1]).slice(0, 90);
  const ok = WS.deleteWatchTarget(tid, id);
  if (!ok) { ctx.sendJSON(res, 404, { error: 'WATCH_TARGET_NOT_FOUND', message: '监控对象不存在。' }); return true; }
  ctx.sendJSON(res, 200, { ok: true, deactivated: true, message: '已移出正式巡检；历史与窗口保留，可再次加入恢复。' });
  return true;
}

// ---------- GET /api/digests/daily（三态日报：changed / quiet_with_full_coverage / coverage_incomplete） ----------
async function dailyDigest(ctx, req, res, url, p) {
  if (p !== '/api/digests/daily' || req.method !== 'GET') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可查看日报。' }); return true; }
  ctx.sendJSON(res, 200, buildDailyBrief(tid, { nowMs: Date.now() }));
  return true;
}

// ---------- GET /api/watch-targets/coverage（三态日报：调试/前端提示用） ----------
// 整改 §7：buildDailyBrief() 本身就返回简报对象——此处不得再解构 { brief }
//（那会把 undefined 发给前端）。直接返回简报，含 mode / coverage / gaps / events。
async function coverageDay(ctx, req, res, url, p) {
  if (p !== '/api/watch-targets/coverage' || req.method !== 'GET') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可查看覆盖明细。' }); return true; }
  const brief = buildDailyBrief(tid, { nowMs: Date.now() });
  ctx.sendJSON(res, 200, brief);
  return true;
}

module.exports = { createTarget, listTargets, patchTarget, deleteTarget, dailyDigest, coverageDay };
