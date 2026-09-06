'use strict';
// ============================================================
// handlers/feedback.js —— 反馈/规则/私有记录端点组（Phase 1 首批迁移）
// 数据主权红线（PRD v2.1）：用户对全局库无写入权——纠错只触发重采，
// 规则必须逐条经用户确认。handler 只做 HTTP 翻译。
// ============================================================

// ---------- /api/feedback-report（GET：反馈报告 + 候选规则） ----------
async function feedbackReport(ctx, req, res, url, p) {
  if (p !== '/api/feedback-report' || req.method !== 'GET') return false;
  const s = ctx.loadState();
  if (!s) { ctx.sendJSON(res, 404, { error: 'NO_STATE' }); return true; }
  ctx.sendJSON(res, 200, ctx.constructFeedbackReport(s));
  return true;
}

// ---------- /api/rule-review（POST：规则逐条审核） ----------
async function ruleReview(ctx, req, res, url, p) {
  if (p !== '/api/rule-review' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const rid = (body.id || '').trim();
  const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : '';
  if (!rid || !decision) { ctx.sendJSON(res, 400, { error: 'BAD_INPUT', message: '缺少规则 id 或裁决' }); return true; }
  const s = ctx.loadState();
  if (!s) { ctx.sendJSON(res, 404, { error: 'NO_STATE' }); return true; }
  const rule = ctx.extractCandidateRules(s).find(r => r.id === rid);
  if (!rule) { ctx.sendJSON(res, 404, { error: 'NO_RULE' }); return true; }
  if (!rule.enforceable && decision === 'approved') {
    ctx.sendJSON(res, 400, { error: 'NOT_ENFORCEABLE', message: '这条目前无法被算法执行，采纳它只会给你一个假开关。' });
    return true;
  }
  s.ruleDecisions = s.ruleDecisions || {};
  s.ruleDecisions[rid] = { decision, at: new Date().toISOString(), kind: rule.kind, keywords: rule.keywords || [], text: rule.text };
  ctx.saveState(s);
  ctx.sendJSON(res, 200, ctx.constructFeedbackReport(s));
  return true;
}

// ---------- /api/user-notes（GET/POST/DELETE：用户私有记录，按 user×competitor 隔离） ----------
async function userNotes(ctx, req, res, url, p) {
  if (p !== '/api/user-notes') return false;
  const ap = ctx.getAuthPayload(req);
  if (!ap || ap.kind !== 'tenant') { ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅登录用户可管理私有记录。' }); return true; }
  const uid = ap.payload.sub;
  const tid = ap.payload.tid;
  const competitorId = url.searchParams.get('competitorId');
  if (req.method === 'GET') {
    if (competitorId) { ctx.sendJSON(res, 200, { competitorId, note: ctx.UN.getNote(tid, uid, competitorId) }); return true; }
    ctx.sendJSON(res, 200, { notes: ctx.UN.listNotes(tid, uid) });
    return true;
  }
  if (req.method === 'POST') {
    const body = await ctx.readBody(req);
    const cid = (body.competitorId || '').trim();
    if (!cid) { ctx.sendJSON(res, 400, { error: 'EMPTY', message: '请指定 competitorId' }); return true; }
    const text = typeof body.text === 'string' ? body.text : '';
    const saved = ctx.UN.setNote(tid, uid, cid, text);
    ctx.sendJSON(res, 200, { competitorId: cid, note: saved, deleted: !saved });
    return true;
  }
  if (req.method === 'DELETE') {
    if (!competitorId) { ctx.sendJSON(res, 400, { error: 'EMPTY', message: '请指定 competitorId' }); return true; }
    ctx.UN.setNote(tid, uid, competitorId, '');
    ctx.sendJSON(res, 200, { competitorId, deleted: true });
    return true;
  }
  ctx.sendJSON(res, 405, { error: 'METHOD' });
  return true;
}

module.exports = { feedbackReport, ruleReview, userNotes, materialAction };

// ---------- /api/material-action（POST：工作台三动作裁决 keep/ignore/later，落盘到服务端 state.decisions） ----------
// 对应前端文档 §5「三动作：后端就绪后启用」。前端 wbSet 仍保留 localStorage 作为即时展示/离线兜底，
// 本端点负责把裁决持久化到服务端，跨设备/重登录后可由 state.decisions 还原。
async function materialAction(ctx, req, res, url, p) {
  if (p !== '/api/material-action' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const id = (body.id || '').trim();
  const action = body.action; // 'keep' | 'ignore' | 'later' | '' | null（空=撤销裁决）
  if (!id) { ctx.sendJSON(res, 400, { error: 'BAD_INPUT', message: '缺少材料 id' }); return true; }
  const OK = { keep: 1, ignore: 1, later: 1 };
  if (action != null && action !== '' && !OK[action]) {
    ctx.sendJSON(res, 400, { error: 'BAD_ACTION', message: '动作仅支持 keep / ignore / later' });
    return true;
  }
  const s = ctx.loadState();
  if (!s) { ctx.sendJSON(res, 404, { error: 'NO_STATE' }); return true; }
  s.decisions = s.decisions || {};
  if (!action || action === '') delete s.decisions[id];
  else s.decisions[id] = action;
  ctx.saveState(s);
  ctx.sendJSON(res, 200, { ok: true, id, action: s.decisions[id] || null, decisions: s.decisions });
  return true;
}
