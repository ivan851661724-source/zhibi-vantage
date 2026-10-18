'use strict';
// Shared public provenance projection. Storage retains replay paths; no public
// response may expose them, including nested Fact/Evidence provenance arrays.
const Snapshot = require('../../research/source-snapshot.js');
const Evidence = require('../../research/evidence-store.js');
const crypto = require('crypto');
function publicObject(value) {
  if (Array.isArray(value)) return value.map(publicObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'raw_payload_ref').map(([key, v]) => [key, publicObject(v)]));
}
function owned(value, tenantId) { return value && value.tenant?.tenant_id === tenantId ? value : null; }
function readSnapshot(tenantId, id, issues) {
  const s = owned(Snapshot.getById(tenantId, id), tenantId);
  if (!s) { issues.push({ kind: 'snapshot', id, reason: 'missing_or_inaccessible' }); return null; }
  let raw = null;
  try { raw = Snapshot.readRawPayload(s); } catch (_) {}
  const reason = !raw ? 'raw_unavailable' : s.raw_truncated ? 'raw_truncated'
    : s.content_hash !== 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex') ? 'raw_hash_mismatch' : null;
  if (reason) issues.push({ kind: 'raw', id, reason });
  return publicObject({ ...s, raw_resolvable: reason == null });
}
function evidenceDetailData(tenantId, id) {
  const e = owned(Evidence.getEvidenceById(tenantId, id), tenantId);
  if (!e) return null;
  const issues = [], snapshots = [];
  for (const sid of [...new Set(e.source_snapshot_ids || [])]) {
    const s = readSnapshot(tenantId, sid, issues); if (s) snapshots.push(s);
  }
  const evidence = publicObject(e);
  // Preserve demo provenance shape and resolve current source URL honestly.
  if (Array.isArray(evidence.provenance?.snapshots)) {
    evidence.provenance.snapshots = evidence.provenance.snapshots.map(s => {
      const current = snapshots.find(x => x.snapshot_id === s.snapshot_id);
      return { ...s, source_url: current?.source_url || null, raw_resolvable: current?.raw_resolvable === true };
    });
  }
  return { evidence, snapshots, issues };
}
module.exports = { publicObject, owned, readSnapshot, evidenceDetailData };
