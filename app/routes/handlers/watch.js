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
    // 🔴 SC-07 §2：非 Shopify 品牌不再直接 400 丢掉用户意向。
    // 保存监控意向 + 触发/复用公开来源基线建立；状态是「正在建立监控来源」，
    // 绝不创建 WatchTarget（调度器不会调度它），也不显示「监控中」。
    const WIntent = require('../../services/watch-intent.js');
    const r0 = WIntent.requestIntent({
      tenantId: tid, projectId, competitorId,
      reasonCode: 'no_direct_source',
      reasonText: '该品牌没有可直接巡检的商品来源，正在建立公开商品页来源。',
      signals: ['price', 'launch'],
    });
    if (r0.error) { ctx.sendJSON(res, 400, { error: r0.error, message: '无法保存监控意向。' }); return true; }
    // SC-08 r4 §1/§3：promoted 重复提交 → 原样返回正式监控状态，**零副作用**：
    // 不安排探测、不跑 planForCompetitor、不新增 job/attempt、不改 WatchTarget/
    // 意向/基线/窗口/事件/时间线。
    if (r0.promoted) {
      const promotedIntent = WIntent.getIntent(tid, r0.intent.intentId);
      const promotedTargetId = promotedIntent && promotedIntent.promotedTargetId;
      const promotedTarget = promotedTargetId ? WS.getWatchTarget(tid, promotedTargetId) : null;
      ctx.sendJSON(res, 200, {
        existed: true,
        promoted: true,
        intent: WIntent.view(promotedIntent),
        // 前端若需要 target 字段则一并返回（不改既有响应字段）
        ...(promotedTarget ? { target: targetView(promotedTarget, WS.latestWindowFor(tid, promotedTarget.watchTargetId)) } : {}),
        message: '该品牌已在正式监控中。',
      });
      return true;
    }
    // SC-08 r3 §一 / r4 §3：handler 分支明确三分——
    //   新意向 / source_failed 重试 / cancelled 重新加入 → 安排首次探测 + 初始采集计划；
    //   establishing 重复提交 → 原样返回当前进度，不新增任何任务。
    let baseline = null;
    if (!r0.establishing) {
      // r2 §二：保存/重新激活意向后**安排第一次 public_site_products 探测**（持久化 next_probe_at，
      // 由 watch-intent 调度器执行；重启后仍能恢复）。scheduleFirstProbe 自身幂等。
      try { WIntent.scheduleFirstProbe({ tenantId: tid, projectId, competitorId }); } catch (e) { /* 调度安排失败不阻塞意向保存 */ }
      // 基线建立走统一采集链路（幂等/冷却/额度/attempt/worker fencing 全复用）
      try {
        const Plan = require('../../services/collection-plan.js');
        baseline = Plan.planForCompetitor({ tenantId: tid, projectId, competitorId: comp.id, comp, trigger: 'manual' });
      } catch (e) { baseline = null; }
    }
    let intent = WIntent.getIntent(tid, r0.intent.intentId);
    // 连官网都不可采（无 URL）→ 如实标来源失败，不制造「建立中」假象
    //（仅对未晋升的意向；promoted 已在上面零副作用分支返回）
    if (!r0.promoted && (comp.url == null || !/^https?:\/\//i.test(String(comp.url || '')))) {
      intent = WIntent.setFailed(tid, r0.intent.intentId, 'no_official_url', '该品牌没有可核验的官网地址，暂无法建立监控来源。');
    }
    ctx.sendJSON(res, r0.existed ? 200 : 202, {
      intent: WIntent.view(intent),
      existed: !!r0.existed,
      baseline: baseline ? baseline.decisions : [],
      message: intent && intent.state === 'source_failed'
        ? (intent.reasonText || '监控来源建立失败。')
        : (r0.establishing
          ? '来源建立进行中，已保留当前进度；无需重复操作。'
          : '已保存监控意向，正在建立可重复抓取的公开商品来源；建立并进行两次可比较采集后才会进入正式监控。'),
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
  // SC-07 §2：监控意向单列返回——前端据此显示「建立中/来源失败」，与 target（监控中）严格分开
  const WIntent = require('../../services/watch-intent.js');
  ctx.sendJSON(res, 200, {
    targets: targets.map(t => targetView(t, WS.latestWindowFor(tid, t.watchTargetId))),
    intents: (WIntent.listIntents(tid, projectId) || []).map(WIntent.view),
  });
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
  // SC-08 r3 §二：能力声明显式拒绝（不静默忽略——静默会让用户误以为改成功了）
  if (body.supportedSignals !== undefined) {
    const e = send400('CAPABILITY_NOT_PATCHABLE', '支持的信号由系统按真实采集能力决定，不能手动修改。');
    ctx.sendJSON(res, e.code, e.body); return true;
  }
  const r = WS.updateWatchTarget(tid, id, patch);
  if (!r) { ctx.sendJSON(res, 404, { error: 'WATCH_TARGET_NOT_FOUND', message: '监控对象不存在。' }); return true; }
  if (r && r.error) {
    // SC-08 r3 §二：每个错误码给明确的用户提示（不再笼统「状态值不合法」）
    const PATCH_ERR_MSG = {
      INVALID_TIMEZONE: '时区必须是合法 IANA 名称。',
      SIGNAL_NOT_SUPPORTED: '请求启用的信号不被该监控对象支持；可启用的信号以监控对象实际具备的来源能力为准。',
      ENABLED_SIGNALS_EMPTY: '至少要启用一个该监控对象支持的信号，不能为空。',
      INVALID_STATUS: '状态值不合法。',
    };
    const e = send400(r.error, PATCH_ERR_MSG[r.error] || '请求参数不合法。');
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

// ---------- DELETE /api/watch-intents/:id（退出监控意向，不再自动激活） ----------
async function deleteIntent(ctx, req, res, url, p) {
  const m = /^\/api\/watch-intents\/([^/]+)$/.exec(p);
  if (!m || req.method !== 'DELETE') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可操作监控意向。' }); return true; }
  const id = decodeURIComponent(m[1]).slice(0, 90);
  const WIntent = require('../../services/watch-intent.js');
  const r = WIntent.cancelIntent(tid, id);
  if (!r) { ctx.sendJSON(res, 404, { error: 'WATCH_INTENT_NOT_FOUND', message: '监控意向不存在。' }); return true; }
  if (r.error) {
    ctx.sendJSON(res, 409, { error: r.error, message: '该品牌已进入正式监控，请移出正式监控对象。' }); return true;
  }
  ctx.sendJSON(res, 200, { intent: WIntent.view(r), cancelled: true, message: '已退出监控意向，不会自动激活。' });
  return true;
}

// ---------- POST /api/watch-targets/:id/inspect（立即巡检，真实执行一次窗口） ----------
// 202 + 后台执行：采集历时可能十几秒，同步等待会超时。
// 只受理 active/degraded target；同一 target 在飞或 20s 内重复点击 → 409（不重复采集）。
async function inspectTarget(ctx, req, res, url, p) {
  const m = /^\/api\/watch-targets\/([^/]+)\/inspect$/.exec(p);
  if (!m || req.method !== 'POST') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可发起巡检。' }); return true; }
  const id = decodeURIComponent(m[1]).slice(0, 90);
  const Manual = require('../../services/watch-manual.js');
  const r = Manual.startInspect({ tenantId: tid, watchTargetId: id });
  if (!r.accepted) {
    if (r.reason === 'NOT_MONITORING') {
      ctx.sendJSON(res, 409, { error: 'NOT_MONITORING', message: '该品牌尚未加入正式监控（或已暂停），请先加入监控再巡检。' });
      return true;
    }
    if (r.reason === 'IN_PROGRESS') {
      ctx.sendJSON(res, 409, { error: 'IN_PROGRESS', message: '本次巡检正在执行，请稍候再试。', windowKey: r.windowKey });
      return true;
    }
    ctx.sendJSON(res, 400, { error: r.reason || 'INSPECT_REJECTED', message: '巡检请求未受理，请稍后重试。' });
    return true;
  }
  ctx.sendJSON(res, 202, {
    accepted: true,
    windowKey: r.windowKey,
    message: '已开始巡检，完成后这里会自动更新。',
  });
  return true;
}

// ---------- POST /api/monitoring/inspect-all（r4g §六.5：项目级巡检批次） ----------
// 一次对项目全部 active WatchTarget 排队；重复点击时 IN_PROGRESS 目标复用进行中
// 的窗口（幂等，不重复建批次）。单品牌巡检按钮只保留在竞品监控对应品牌行。
async function inspectAll(ctx, req, res, url, p) {
  if (p !== '/api/monitoring/inspect-all' || req.method !== 'POST') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可发起巡检。' }); return true; }
  let body = {};
  try { body = await ctx.readBody(req) || {}; } catch (e) { body = {}; }
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim().slice(0, 80) : '';
  if (!projectId) { const e = send400('EMPTY', '缺少 projectId。'); ctx.sendJSON(res, e.code, e.body); return true; }
  const WS = require('../../services/watch-store.js');
  const Manual = require('../../services/watch-manual.js');
  const targets = (WS.listWatchTargets(tid, projectId) || []).filter(t => t.monitoringStatus === 'active' || t.monitoringStatus === 'degraded');
  if (!targets.length) { ctx.sendJSON(res, 409, { error: 'NO_ACTIVE_TARGETS', message: '项目内还没有正式监控中的品牌，请先加入监控。' }); return true; }
  let accepted = 0, inProgress = 0, firstWindowKey = null;
  const windowKeys = [];
  for (const t of targets) {
    const r = Manual.startInspect({ tenantId: tid, watchTargetId: t.watchTargetId });
    if (r.accepted) { accepted++; windowKeys.push(r.windowKey); if (!firstWindowKey) firstWindowKey = r.windowKey; }
    else if (r.reason === 'IN_PROGRESS') { inProgress++; windowKeys.push(r.windowKey); if (!firstWindowKey) firstWindowKey = r.windowKey; }
  }
  ctx.sendJSON(res, 202, {
    accepted,
    inProgress,
    skipped: targets.length - accepted - inProgress,
    batchId: firstWindowKey || null,
    totalTargets: targets.length,
    message: accepted > 0
      ? `已开始巡检 ${accepted} 个监控品牌${inProgress ? `（${inProgress} 个正在巡检中，沿用同一批次）` : ''}；完成后这里会自动更新。`
      : '全部监控品牌正在巡检中（同一批次），请稍候。',
  });
  return true;
}

// ---------- POST /api/monitoring/plan-reconcile（r4g §六.1：监控覆盖计划收敛） ----------
// 对项目内全部竞品确保监控计划存在：已有目标/意向的跳过（不重复创建）；
// 未覆盖的按真实采集能力派信号（有价格/商品成功采集 → price/launch/stock；
// 否则走默认建立链，由来源建立过程决定降级），用户移除（inactive）的除外。
// 只写意向/目标记录，不做外部采集；真实建立由后台任务执行。
async function planReconcile(ctx, req, res, url, p) {
  if (p !== '/api/monitoring/plan-reconcile' || req.method !== 'POST') return false;
  const tid = tidOf(ctx, req);
  if (!tid) { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可操作。' }); return true; }
  let body = {};
  try { body = await ctx.readBody(req) || {}; } catch (e) { body = {}; }
  const projectId = typeof body.projectId === 'string' ? body.projectId.trim().slice(0, 80) : '';
  if (!projectId) { const e = send400('EMPTY', '缺少 projectId。'); ctx.sendJSON(res, e.code, e.body); return true; }
  const fs = require('fs');
  const { projFile } = require('../../core/state-store.js');
  const WS = require('../../services/watch-store.js');
  const WIntent = require('../../services/watch-intent.js');
  const SurfaceStore = require('../../services/surface-store.js');
  let comps = [];
  try {
    const f = projFile(projectId, tid);
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    comps = (st.competitors || []).filter(c => c && c.id && !c.removed);
  } catch (e) { comps = []; }
  if (!comps.length) { ctx.sendJSON(res, 409, { error: 'NO_COMPETITORS', message: '项目内还没有竞品。' }); return true; }
  const targets = WS.listWatchTargets(tid, projectId) || [];
  const targetByComp = new Map(targets.map(t => [t.competitorId, t]));
  const intents = WIntent.listIntents(tid, projectId) || [];
  const intentByComp = new Map();
  for (const i of intents) { if (i.state !== 'cancelled' && i.state !== 'promoted') intentByComp.set(i.competitorId, i); }
  const BRAND_LINKS = (() => { try { return require('../../services/brand-store.js').listBrandLinksForProject(tid, projectId) || []; } catch (e) { return []; } })();
  const brandIdOf = new Map(BRAND_LINKS.map(b => [b.competitorRef, b.brandId]));

  // 能力判定：以已有真实采集为准（不猜）
  const hasCapability = (cid, caps) => {
    try {
      const rows = SurfaceStore.listAttemptsByCompetitor(tid, projectId, cid, 30) || [];
      return caps.some(cap => rows.some(a => a.capability === cap && a.status === 'success' && (a.observations || []).length > 0));
    } catch (e) { return false; }
  };
  // r4g §五：动态 Shopify 平台识别——档案 isShopify=false 不再一票否决。
  // 实测教训：某项目 15 个品牌全部未判定（实为 13 个 Shopify 店，products.json
  // 返回真实价格），导致 shopify catalog 全被拒、全部降级 site_change。
  // 这里对未判定品牌轻量探测一次 /products.json?limit=1（12s 超时）；命中即
  // 写回品牌档案持久化——之后的采集调度（bootstrapProject）自然按 Shopify 入队，
  // 同一品牌不再重复探测。探测失败不阻断计划收敛（本次按非 Shopify 处理）。
  const Net = require('../../research/net.js');
  const fsMod = require('fs');
  let identified = 0;
  try {
    const statePath = projFile(projectId, tid);
    let stateDirty = false;
    for (const c of comps) {
      if (c.isShopify || !c.url) continue;
      const probe = await Net.probeShopifyCatalog(c.url, { tenantId: tid });
      if (probe && probe.ok && probe.shopify) {
        c.isShopify = true; stateDirty = true; identified += 1;
      }
    }
    if (stateDirty) {
      const st = JSON.parse(fsMod.readFileSync(statePath, 'utf8'));
      const byId = new Map(comps.map(c => [c.id, c]));
      for (const sc of (st.competitors || [])) {
        const m = byId.get(sc.id);
        if (m && m.isShopify && !sc.isShopify) sc.isShopify = true;
      }
      fsMod.writeFileSync(statePath, JSON.stringify(st));
    }
  } catch (e) { /* 识别失败不影响计划收敛；下次再探测 */ }

  const created = []; const skipped = []; let failed = 0;
  for (const c of comps) {
    const t = targetByComp.get(c.id);
    if (t) { skipped.push({ competitorId: c.id, reason: t.monitoringStatus === 'active' || t.monitoringStatus === 'degraded' ? 'already_active' : 'already_tracked' }); continue; }
    if (intentByComp.has(c.id)) { skipped.push({ competitorId: c.id, reason: 'intent_in_progress' }); continue; }
    const priceCapable = hasCapability(c.id, ['shopify_catalog', 'public_site_products']) || !!c.isShopify;
    const signals = priceCapable ? ['price', 'launch', 'stock'] : ['site_change'];
    try {
      const r = WIntent.requestIntent({
        tenantId: tid, projectId, competitorId: c.id, brandId: brandIdOf.get(c.id) || null,
        reasonCode: 'monitoring_plan_reconcile', reasonText: '监控计划收敛：把项目内竞品纳入正式监控',
        signals,
      });
      if (r && r.error) { failed++; continue; }
      created.push({ competitorId: c.id, signals });
    } catch (e) { failed++; }
  }
  ctx.sendJSON(res, 200, {
    ok: true,
    totalBrands: comps.length,
    shopifyIdentified: identified,
    createdCount: created.length,
    skippedCount: skipped.length,
    failed,
    created, skipped,
    message: (created.length || identified)
      ? `${identified ? `识别出 ${identified} 个 Shopify 店并已更新采集能力；` : ''}${created.length ? `已把 ${created.length} 个品牌加入监控建立计划，来源建立完成后自动转为正式监控。` : '监控计划已收敛。'}`
      : '全部竞品都已在监控计划中。',
  });
  return true;
}

module.exports = { createTarget, listTargets, patchTarget, deleteTarget, deleteIntent, dailyDigest, coverageDay, inspectTarget, inspectAll, planReconcile };
