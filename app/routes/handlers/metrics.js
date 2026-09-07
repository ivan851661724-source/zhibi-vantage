'use strict';
// ============================================================
// handlers/metrics.js —— 度量层端点组（Phase 1 首批迁移）
// P0-2/3/4 度量层：快照 / 消费埋点 / 校准 / 准确率 / 北极星。
// 全部经 ctx.M（lib/metrics.js）落盘，handler 只做 HTTP 翻译。
// 租户隔离（评审 P2 修复）：
//   · 写入统一打 tenantId（来源可追溯，恶意污染可定位）；
//   · 消费/校准/准确率的租户读取按 tenantId 过滤；平台级汇总（全租户混合）
//     仅超管可见——堵"任意租户读跨租户聚合"的泄露面。
// ============================================================

// 当前请求租户（RAW id，如 'tenant:xxx'；后台/legacy 落 '_legacy'）
function tidOf(ctx) {
  return ctx.curTenantId ? ctx.curTenantId() : '_legacy';
}
function isAdmin(ap) { return !!(ap && ap.kind === 'admin'); }

// ---------- /api/snapshot（POST：空白快照，按天去重） ----------
async function snapshot(ctx, req, res, url, p) {
  if (p !== '/api/snapshot' || req.method !== 'POST') return false;
  const s = ctx.loadState();
  if (!s) { ctx.sendJSON(res, 404, { error: 'NO_STATE' }); return true; }
  const ws = ctx.computeWhiteSpace(s);
  if (ws.hidden) { ctx.sendJSON(res, 200, { ok: true, hidden: true, added: 0, total: 0 }); return true; }
  const added = ctx.M.recordGapSnapshotSet(s, ws);
  ctx.M.logEvent({ changeType: 'whitespace_snapshot', source: 'snapshot', from: null, to: String(ws.gaps.length), confidence: null, tenantId: tidOf(ctx) });
  ctx.sendJSON(res, 200, { ok: true, snapshotAt: new Date().toISOString(), added, total: ws.gaps.length });
  return true;
}

// ---------- /api/consume（POST：洞察消费埋点） ----------
async function consume(ctx, req, res, url, p) {
  if (p !== '/api/consume' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const r = ctx.M.recordConsumption(Object.assign({}, body, { tenantId: tidOf(ctx) }));
  if (!r.ok) { ctx.sendJSON(res, 400, { error: r.error }); return true; }
  ctx.sendJSON(res, 200, { ok: true });
  return true;
}

// ---------- /api/calibration（POST：三判制校准确认） ----------
async function calibration(ctx, req, res, url, p) {
  if (p !== '/api/calibration' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const r = ctx.M.recordCalibration(Object.assign({}, body, { tenantId: tidOf(ctx) }));
  if (!r.ok) { ctx.sendJSON(res, 400, { error: r.error }); return true; }
  ctx.sendJSON(res, 200, { ok: true, calibration: r.rec });
  return true;
}

// ---------- /api/calibration/summary（GET：平台级，仅超管） ----------
async function calibrationSummary(ctx, req, res, url, p) {
  if (p !== '/api/calibration/summary' || req.method !== 'GET') return false;
  if (!isAdmin(ctx.getAuthPayload(req))) {
    ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '平台级校准汇总仅超管可见。' });
    return true;
  }
  const summary = ctx.M.computeCalibration(ctx.M.readGapSnapshots(), ctx.M.readCalibrations(), Date.now(), 84);
  summary.computation = ctx.M.computeComputationCalibration(84);
  ctx.sendJSON(res, 200, summary);
  return true;
}

// ---------- /api/calibration/computation（POST：计算层判断解析） ----------
async function calibrationComputation(ctx, req, res, url, p) {
  if (p !== '/api/calibration/computation' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const r = ctx.M.resolveComputationJudgment(body.id, body.verdict);
  if (!r.ok) { ctx.sendJSON(res, 400, { error: r.error }); return true; }
  ctx.sendJSON(res, 200, { ok: true, rec: r.rec });
  return true;
}

// ---------- /api/accuracy/sample（POST：字段准确率抽检） ----------
async function accuracySample(ctx, req, res, url, p) {
  if (p !== '/api/accuracy/sample' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const r = ctx.M.recordAccuracySample(Object.assign({}, body, { tenantId: tidOf(ctx) }));
  if (!r.ok) { ctx.sendJSON(res, 400, { error: r.error }); return true; }
  ctx.sendJSON(res, 200, { ok: true, summary: r.summary });
  return true;
}

// ---------- /api/accuracy/summary（GET：平台级，仅超管） ----------
async function accuracySummary(ctx, req, res, url, p) {
  if (p !== '/api/accuracy/summary' || req.method !== 'GET') return false;
  if (!isAdmin(ctx.getAuthPayload(req))) {
    ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '平台级准确率汇总仅超管可见。' });
    return true;
  }
  ctx.sendJSON(res, 200, ctx.M.loadAccuracySummary());
  return true;
}

// ---------- /api/north-star（GET：北极星速览；租户只见本租户消费数据） ----------
async function northStar(ctx, req, res, url, p) {
  if (p !== '/api/north-star' || req.method !== 'GET') return false;
  const windowDays = Math.max(1, Math.min(90, parseInt((url.searchParams.get('window') || '7'), 10) || 7));
  const ap = ctx.getAuthPayload(req);
  const rows = ctx.M.readConsumptions();
  const scoped = isAdmin(ap) ? rows : rows.filter(r => r.tenantId === tidOf(ctx)); // 租户读按租户过滤
  ctx.sendJSON(res, 200, ctx.M.computeNorthStar(scoped, Date.now(), windowDays));
  return true;
}

module.exports = {
  snapshot, consume, calibration, calibrationSummary, calibrationComputation,
  accuracySample, accuracySummary, northStar,
};
