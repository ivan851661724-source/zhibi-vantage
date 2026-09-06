'use strict';
// ============================================================
// 主干契约统一（P0-0）：EvidencePack / Claim / Verdict 三层契约。
// 目的：所有字段裁决引擎(adjudication)的输出统一收敛为 Verdict，
//   由上游(server.js / 报告生成)以单一结构消费，避免各模块各造各的结构。
// 设计纪律（忠实助理）：Verdict 必须可溯源——保留 independentSources 与
//   轻量 sourceSummary，绝不丢证据链；但不在持久化里重复整份 claims
//   （原始证据已存于 provenance 链，避免 11MB 库翻倍）。
// ============================================================
const P = require('./provenance.js');
const A = require('./adjudication.js');
const SI = require('./source-identity.js');
const { SOURCE_KIND } = P;

// Verdict：裁决结论（统一契约）。由 adjudication 输出包裹而来。
function makeVerdict({ anchorId, field, adopted, records }) {
  const real = (records || []).filter((r) => r.sourceKind !== SOURCE_KIND.LLM_ENUM);
  const sourceSummary = real.map((r) => ({
    sourceKind: r.sourceKind,
    identity: SI.sourceIdentity(r),
    sourceId: r.sourceId != null ? r.sourceId : null,
  }));
  return {
    schema: 'Verdict@1',
    anchorId: anchorId || null,
    field: field || null,
    adoptedValue: adopted.adoptedValue,
    adoptedFrom: adopted.adoptedFrom,
    confidence: adopted.confidence,
    conflictFlag: !!adopted.conflictFlag,
    independentAgree: adopted.independentAgree,
    independentSources: adopted.independentSources || [],
    sourcesConsidered: adopted.sourcesConsidered,
    reason: adopted.reason,
    sourceSummary,
  };
}

// EvidencePack：一个锚点一个字段的完整证据包（证据集合 + 裁决结论）。
// 若调用方已裁决过(adopted 传入)则复用，避免重复裁决。
function makeEvidencePack({ anchorId, field, records, status, adopted }) {
  const a = adopted || A.adjudicate(records || []);
  const verdict = makeVerdict({ anchorId, field, adopted: a, records });
  return {
    schema: 'EvidencePack@1',
    anchorId: anchorId || null,
    field: field || null,
    status: status || null,
    verdict,
    evidenceCount: (records || []).length,
  };
}

// ------------------------------------------------------------
// 域级 Verdict / Evidence（架构总纲 v3 §8 模型，Phase B/C 预埋）
// 与上方字段级 Verdict@1 并存：字段级供裁决引擎内部，域级供 L3 材料引擎/KG 快照。
// Verdict 可变：重新裁决产生新 version（旧版保留供 diff/回滚，Phase C 落库）。
// Evidence 不可变：一次采集一条，append-only。
// ------------------------------------------------------------
function makeDomainVerdict({ domain, subjectId, claim, confidence, basis, evidenceIds, missingFields, version, sourceVerdictVersion }) {
  return {
    schema: 'Verdict@1',
    domain: domain || null,
    subjectId: subjectId || null,
    claim: claim || null,
    confidence: confidence || 'low',
    basis: basis || 'unverified',
    evidenceIds: Array.isArray(evidenceIds) ? evidenceIds : [],
    missingFields: Array.isArray(missingFields) ? missingFields : [],
    version: version || 1,
    createdAt: new Date().toISOString(),
    sourceVerdictVersion: sourceVerdictVersion || null,
  };
}

function makeEvidence({ domain, subjectId, source, rawExtract, compliance }) {
  return {
    id: 'evt_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
    domain: domain || null,
    subjectId: subjectId || null,
    source: source || null, // { type, site, url, capturedAt }
    rawExtract: rawExtract || null,
    compliance: compliance || null, // { robotsOk, rateOk }
  };
}

module.exports = { makeVerdict, makeEvidencePack, makeDomainVerdict, makeEvidence };
