'use strict';
const als = require('../../core/als.js');
const { isSafeId } = require('../../core/safe-id.js');
const Metric = require('../../research/price-metric.js');
const Fact = require('../../research/fact-store.js');
const Evidence = require('../../research/evidence-store.js');
const { publicObject, owned, readSnapshot, evidenceDetailData } = require('./intelligence-projection.js');
function respond(ctx, res, status, body) { ctx.sendJSON(res, status, body); return true; }
function identity(ctx, res, url) {
  const tenantId = als.getTenantCtx(), id = url?.searchParams?.get('id');
  if (!tenantId) { respond(ctx, res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' }); return null; }
  if (!id) { respond(ctx, res, 400, { error: 'MISSING_ID', message: '缺少 id。' }); return null; }
  if (!isSafeId(id)) { respond(ctx, res, 400, { error: 'INVALID_ID', message: '非法 id 格式。' }); return null; }
  return { tenantId, id };
}
function pageNumber(params, key, fallback, min, max) {
  if (!params.has(key)) return fallback;
  const raw = params.get(key);
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}
async function priceMetric(ctx, req, res, url, p) {
  if (p !== '/api/price-metric' || req.method !== 'GET') return false;
  const auth = identity(ctx, res, url); if (!auth) return true;
  const { tenantId, id } = auth;
  const offset = pageNumber(url.searchParams, 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = pageNumber(url.searchParams, 'limit', 20, 1, 50);
  if (offset == null || limit == null) return respond(ctx, res, 400, { error: 'INVALID_PAGINATION', message: 'offset须为非负整数，limit须为1–50整数。' });
  const metric = Metric.getMetricById(tenantId, id);
  if (!metric) return respond(ctx, res, 404, { error: 'NOT_FOUND', message: '指标不存在。' });
  const factIds = [...new Set(metric.fact_ids || [])].sort(), total = factIds.length;
  const facts = [], evidences = [], snapshots = [], issues = [], evidenceIds = new Set(), snapshotIds = new Set();
  for (const fid of factIds.slice(offset, offset + limit)) {
    const f = owned(Fact.getFactById(tenantId, fid), tenantId);
    if (!f) { issues.push({ kind: 'fact', id: fid, reason: 'missing_or_inaccessible' }); continue; }
    facts.push(publicObject(f));
    for (const sid of f.source_snapshot_ids || []) snapshotIds.add(sid);
    for (const eid of f.evidence_ids || []) evidenceIds.add(eid);
  }
  for (const eid of [...evidenceIds].sort()) {
    const e = owned(Evidence.getEvidenceById(tenantId, eid), tenantId);
    if (!e) { issues.push({ kind: 'evidence', id: eid, reason: 'missing_or_inaccessible' }); continue; }
    evidences.push(publicObject(e));
    for (const sid of e.source_snapshot_ids || []) snapshotIds.add(sid);
  }
  for (const sid of [...snapshotIds].sort()) { const s = readSnapshot(tenantId, sid, issues); if (s) snapshots.push(s); }
  const hasMore = offset + limit < total;
  return respond(ctx, res, 200, { metric: publicObject(metric), facts, evidences, snapshots, issues,
    collectionIssues: publicObject(metric.collection_issues || []), offset, limit, total, nextOffset: hasMore ? offset + limit : null, hasMore });
}
async function evidenceDetail(ctx, req, res, url, p) {
  if (!['/api/evidence-detail', '/api/demo/evidence-detail'].includes(p) || req.method !== 'GET') return false;
  const auth = identity(ctx, res, url); if (!auth) return true;
  const data = evidenceDetailData(auth.tenantId, auth.id);
  if (!data) return respond(ctx, res, 404, { error: 'NOT_FOUND', message: '证据不存在。' });
  try { require('../../observability/telemetry.js').recordEvent({ eventType: 'evidence_opened', tenantId: auth.tenantId, objectType: 'evidence', objectId: auth.id }); } catch (_) {}
  return respond(ctx, res, 200, data);
}
module.exports = { priceMetric, evidenceDetail };
