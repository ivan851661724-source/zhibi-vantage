'use strict';
// ============================================================
// handlers/demo.js —— M0-05 Demo 最小 REST（Stage 3）
// 真值链只读端点：recent changes / event detail / evidence detail。
// 数据全部来自事实链落盘对象（events/diffs/facts/evidence/snapshots），
// 本层零计算零装饰——数字即 Fact/Event 原值，不在此重算。
//
// 规格锚点：00 v1.2 §5/§32（Projection 只 render 不重算）/§42；
//           02 v0.3 §10.1；03 v0.3（API 契约：租户隔离）；06 v0.3 Traceability。
// 鉴权：注册为 'tenant'（走统一鉴权门；ALS 请求上下文解租户）。
// ============================================================
const als = require('../../core/als.js');
const DomainEvent = require('../../research/domain-event.js');
const Diff = require('../../research/price-diff.js');
const FactStore = require('../../research/fact-store.js');
const EvidenceStore = require('../../research/evidence-store.js');
const Snapshot = require('../../research/source-snapshot.js');

// ---------- GET /api/demo/recent-changes?limit=30 ----------
// 近期 price_change_observed 事件（工作台「今日竞争动态」数据源）。
async function recentChanges(ctx, req, res, url, p) {
  if (p !== '/api/demo/recent-changes' || req.method !== 'GET') return false;
  const tenantId = als.getTenantCtx();
  if (!tenantId) return ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' });
  const limit = Math.min(Number(url && url.searchParams && url.searchParams.get('limit')) || 30, 100);
  const events = DomainEvent.listEvents(tenantId, { limit });
  const all = DomainEvent.listEvents(tenantId);
  ctx.sendJSON(res, 200, {
    events,
    summary: {
      total: all.length,
      decrease: all.filter(e => e.direction === 'decrease').length,
      increase: all.filter(e => e.direction === 'increase').length,
    },
  });
  return true;
}

// ---------- GET /api/demo/event-detail?id=evt_xxx ----------
// 事件详情：Event → Diff → Fact(×2) → Evidence(×N) → Snapshot 全链装配。
// 任一环节缺失按诚实降级（该段返回 null + reason），绝不伪造补齐。
async function eventDetail(ctx, req, res, url, p) {
  if (p !== '/api/demo/event-detail' || req.method !== 'GET') return false;
  const tenantId = als.getTenantCtx();
  if (!tenantId) return ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' });
  const id = url && url.searchParams && url.searchParams.get('id');
  if (!id) return ctx.sendJSON(res, 400, { error: 'MISSING_ID', message: '缺少事件 id。' });
  const event = DomainEvent.getEventById(tenantId, id);
  if (!event) return ctx.sendJSON(res, 404, { error: 'NOT_FOUND', message: '事件不存在。' });
  const diff = Diff.getDiffById(tenantId, event.diff_id);
  const oldFact = FactStore.getFactById(tenantId, event.old_fact_id);
  const newFact = FactStore.getFactById(tenantId, event.new_fact_id);
  const evidences = [];
  for (const eid of [].concat(event.old_evidence_ids || [], event.new_evidence_ids || [])) {
    const ev = EvidenceStore.getEvidenceById(tenantId, eid);
    if (ev && !evidences.some(x => x.evidence_id === ev.evidence_id)) evidences.push(ev);
  }
  const snapshots = [];
  for (const sid of [].concat(event.old_snapshot_ids || [], event.new_snapshot_ids || [])) {
    const sm = Snapshot.getById(tenantId, sid);
    if (sm && !snapshots.some(x => x.snapshot_id === sm.snapshot_id)) {
      snapshots.push({
        snapshot_id: sm.snapshot_id, capability: sm.capability, provider: sm.provider,
        source_url: sm.source_url, source_status: sm.source_status, observed_at: sm.observed_at,
        partial_scan: sm.partial_scan == null ? null : Boolean(sm.partial_scan),
        content_hash: sm.content_hash, collector_version: sm.collector_version,
        raw_payload_ref: sm.raw_payload_ref || null,
      });
    }
  }
  ctx.sendJSON(res, 200, { event, diff, facts: { old: oldFact, new: newFact }, evidences, snapshots });
  return true;
}

// ---------- GET /api/demo/evidence-detail?id=ev_xxx ----------
// 证据详情（「查看证据」Modal 数据源）：Evidence + 快照 provenance。
async function evidenceDetail(ctx, req, res, url, p) {
  if (p !== '/api/demo/evidence-detail' || req.method !== 'GET') return false;
  const tenantId = als.getTenantCtx();
  if (!tenantId) return ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' });
  const id = url && url.searchParams && url.searchParams.get('id');
  if (!id) return ctx.sendJSON(res, 400, { error: 'MISSING_ID', message: '缺少证据 id。' });
  const ev = EvidenceStore.getEvidenceById(tenantId, id);
  if (!ev) return ctx.sendJSON(res, 404, { error: 'NOT_FOUND', message: '证据不存在。' });
  ctx.sendJSON(res, 200, { evidence: ev, snapshots: ev.provenance && ev.provenance.snapshots || [] });
  return true;
}

module.exports = { recentChanges, eventDetail, evidenceDetail };
