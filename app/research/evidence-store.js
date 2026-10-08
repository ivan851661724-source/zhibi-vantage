'use strict';
// ============================================================
// research/evidence-store.js —— M0-02 Evidence Foundation（存储层）
// 一级 Evidence 对象：SourceSnapshot → Evidence 事实链第二环（00 v1.2 §5）。
//
// 规格锚点（/spec，版本锁定）：
//   00 v1.2 §1.5（Evidence 一级对象）/§2+§2.1（EvidenceStatus 四值冻结 +
//     unavailable.reason_code 九值）/§26/§37（幂等与去重）/§38（数据源失败
//     传播到 EvidenceStatus）/§42（多租户）/§56（版本化；迁移不覆盖历史）
//   02 v0.3 §3（EvidenceStatus 沿用 00，禁语义相同的平行状态）
//   03 v0.3 §17（Multi-tenant：租户私有数据不可跨租户泄漏）
//   05 v0.3.1 §10/§19.6（SC-01：结构化 Evidence 层必填实际 parser/extractor
//     版本；Shopify 边界：公开商品价格 ≠ AOV/销量/成交价）
//   06 v0.3（Evidence Traceability = 100%：有 evidence_id 但断链不计入）
//
// 硬规则：
//   · EvidenceStatus 冻结四值 verified/derived/conflicted/unavailable，禁别名；
//     unavailable 必带 reason_code（00 §2.1 冻结九值，实现层不私自扩充——
//     P0-3 PR#5 评审），非 unavailable 恒 null（不吞失败原因，也不伪造失败原因）
//   · evidence_status ≠ evidence_strength ≠ source_quality：三个正交字段，
//     互不派生；本层绝不从 status/strength/quality 任一字段推导另一字段
//   · 与 legacy research/evidence.js（sourceTier/deriveBasis 的 basis 语义）
//     完全正交：零读取、零映射、零迁移；禁止 basis→EvidenceStatus 机械映射
//   · append-only + 幂等：evidence_id 由幂等键确定性导出；同键重试返回既有
//     记录（duplicate:true），绝不覆盖、绝不重复建档（00 §37）；不同
//     parser/extractor 版本 → 不同键 → 新记录，旧记录不可变（00 §56.2）
//   · 租户隔离：显式 tenantId > ALS(getTenantCtx) > 皆缺 → 拒绝落盘 + 运营
//     告警（与 source-snapshot 同规）；引用校验时 SourceSnapshot 必须同租户
//     可解析——跨租户/不存在的快照一律拒绝产证（06 Traceability 断链即无效）
//   · SC-01：parser_version / extractor_version 必填非空（结构化解析层），
//     不得复制 collector_version 冒充；collector_version 仅作溯源透传
//   · provenance 诚实：verified/derived 证据引用的每张快照必须 raw payload
//     可解析；unavailable 证据不承载业务值（extracted_value 恒 null）
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('../core/paths.js');
const { sanitizeNs } = require('../core/state-store.js');
const als = require('../core/als.js');
const safeId = require('../core/safe-id.js');
const Snapshot = require('./source-snapshot.js');
const logger = require('../services/logger.js');

const SCHEMA_VERSION = 1;

// 00 v1.2 §2 冻结四值（禁别名、禁平行状态）
const EVIDENCE_STATUS = Object.freeze({
  VERIFIED: 'verified',
  DERIVED: 'derived',
  CONFLICTED: 'conflicted',
  UNAVAILABLE: 'unavailable',
});
const VALID_EVIDENCE_STATUS = new Set(Object.values(EVIDENCE_STATUS));

// 00 v1.2 §2.1 冻结九值（后续可扩展，但不得用 generic unavailable 吞失败原因）。
// 🔴 P0-3（PR#5 评审）：timeout/internal_error 不在本清单内——未经正式 Spec Change
// 不得在实现层私自扩充枚举。SourceStatus timeout/internal_error 统一映射
// fetch_failed，底层失败细节经 provenance.snapshots[].source_status + error_code
// 溯源保留（不丢失"曾超时/内部错误"这一事实）。若产品侧要升为一等 reason_code，
// 走正式 Spec Change。
const UNAVAILABLE_REASON_CODES = Object.freeze([
  'not_supported', 'source_not_integrated', 'fetch_failed', 'blocked',
  'rate_limited', 'parse_failed', 'insufficient_history', 'insufficient_sample',
  'not_applicable',
]);
const VALID_REASON_CODES = new Set(UNAVAILABLE_REASON_CODES);

// SourceStatus（05 §11 失败态）→ unavailable.reason_code 映射。仅用于
// evidence-extract 提取层；source failure ≠ no_change ≠ no_change（00 §38），
// 失败观察绝不转成 verified 业务主张。P0-3：timeout/internal_error → fetch_failed
// （枚举冻结收口），失败细节不丢——provenance 保留 source_status 原值。
const SOURCE_FAILURE_REASON = Object.freeze({
  unavailable: 'fetch_failed',
  blocked: 'blocked',
  rate_limited: 'rate_limited',
  timeout: 'fetch_failed',        // P0-3：枚举未冻结 timeout，细节走 provenance
  parse_failed: 'parse_failed',
  internal_error: 'fetch_failed', // P0-3：同上
});
const SOURCE_FAILURE_STATUSES = Object.freeze(Object.keys(SOURCE_FAILURE_REASON));

function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// 稳定序列化（键排序）——extracted_value 摘要与幂等键的确定性基础
function stableStringify(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}';
}

// 幂等键（00 §37，P0-2 PR#5 评审收口）：**完整规范语义身份**的组合，缺一不可——
//   tenant ‖ source_snapshot_ids(排序) ‖ source ‖ provider ‖
//   claim.field ‖ claim.scope ‖ entity_key ‖ extracted_value 摘要 ‖
//   unit ‖ currency ‖ market ‖ evidence_status ‖ reason_code ‖
//   parser_version ‖ extractor_version
// 同键重试 = 同一语义证据 → 复用既有记录；任一语义维度不同（含币种/market/
// claim.scope/status/reason/版本）→ 不同键 → 独立记录，语义不同的证据绝不坍缩。
// 🔴 P0-2：禁止调用方覆盖键值——身份只能由本函数从语义字段确定性导出。
function buildIdempotencyKey(o) {
  const parts = [
    String(o.tenantId || ''),
    (o.sourceSnapshotIds || []).slice().sort(),
    String(o.source || ''),
    String(o.provider || ''),
    String((o.claim && o.claim.field) || ''),
    String((o.claim && o.claim.scope) || ''),
    o.entityKey == null ? null : String(o.entityKey),
    o.valueDigest == null ? null : String(o.valueDigest),
    o.unit == null ? null : String(o.unit),
    o.currency == null ? null : String(o.currency),
    o.market == null ? null : String(o.market),
    String(o.evidenceStatus || ''),
    o.reasonCode == null ? null : String(o.reasonCode),
    String(o.parserVersion || ''),
    String(o.extractorVersion || ''),
  ];
  return sha256hex(stableStringify(parts));
}

function evidenceDirOf(tenantId) { return path.join(DATA, 'evidence', sanitizeNs(tenantId)); }
function evidencePathOf(tenantId, evidenceId) { return path.join(evidenceDirOf(tenantId), String(evidenceId) + '.json'); }

function resolveTenantId(explicit) {
  if (explicit) return String(explicit);
  const ctx = als.getTenantCtx();
  return ctx ? String(ctx) : null;
}

// 快照引用校验（06 Traceability：断链不得产证）。返回 per-snapshot provenance 数组；
// 任一快照跨租户/不存在 → 抛错（证据级溯源不存在就不能假装存在）。
function resolveSnapshotProvenance(tenantId, snapshotIds) {
  const out = [];
  for (const sid of snapshotIds) {
    const meta = Snapshot.getById(tenantId, sid); // getById 按租户命名空间解析 → 跨租户自然不命中
    if (!meta) throw new Error('evidence-store: source_snapshot not resolvable in tenant scope: ' + sid);
    const rawRef = meta.raw_payload_ref && meta.raw_payload_ref.path
      ? path.join(DATA, meta.raw_payload_ref.path) : null;
    // P0-1：raw ref 包含性防御——ref.path 必须仍在 DATA 内（防存储数据被篡改后外指）
    const rawResolvable = !!(rawRef && safeId.isWithinDir(DATA, rawRef) && fs.existsSync(rawRef));
    out.push({
      snapshot_id: meta.snapshot_id,
      capability: meta.capability,
      provider: meta.provider,
      source_status: meta.source_status,
      partial_scan: meta.partial_scan == null ? null : Boolean(meta.partial_scan),
      observed_at: meta.observed_at,
      content_hash: meta.content_hash,
      collector_version: meta.collector_version,
      raw_payload_ref: meta.raw_payload_ref,
      raw_resolvable: rawResolvable,
    });
  }
  return out;
}

// 唯一写入口（append-only + 幂等）。
// 返回 { recorded:true, meta, duplicate:false }（新建）
//    或 { recorded:true, meta, duplicate:true }（同幂等键重试，返回既有记录）
//    或 { recorded:false, reason:'no_tenant_context' }（运行态缺租户，与快照层同规）
// 抛错仅用于调用方传参违例（非法状态字面量 / 快照断链 / 同 id 不同键）。
function recordEvidence(input) {
  const status = input.evidence_status;
  if (!VALID_EVIDENCE_STATUS.has(status)) {
    throw new Error('evidence-store: invalid evidence_status literal: ' + String(status));
  }
  let reasonCode = input.reason_code || null;
  if (status === EVIDENCE_STATUS.UNAVAILABLE) {
    if (!reasonCode || !VALID_REASON_CODES.has(reasonCode)) {
      throw new Error('evidence-store: unavailable evidence requires frozen reason_code (00 §2.1), got: ' + String(reasonCode));
    }
  } else if (reasonCode) {
    throw new Error('evidence-store: reason_code is unavailable-only semantics, got on status ' + status + ': ' + String(reasonCode));
  }

  const tenantId = resolveTenantId(input.tenantId);
  if (!tenantId) {
    logger.warn('evidence_record_skip', { reason: 'no_tenant_context', provider: input.provider || null });
    return { recorded: false, reason: 'no_tenant_context' };
  }

  const snapshotIds = Array.isArray(input.source_snapshot_ids)
    ? input.source_snapshot_ids.filter(Boolean).map(String) : [];
  if (!snapshotIds.length) {
    throw new Error('evidence-store: evidence-grade provenance requires >=1 source_snapshot_id (06 Traceability)');
  }
  const provenance = resolveSnapshotProvenance(tenantId, snapshotIds);

  // SC-01：结构化 Evidence 层版本必填非空，且不得拿 collector_version 冒充
  const parserVersion = input.parser_version;
  const extractorVersion = input.extractor_version;
  if (!parserVersion || typeof parserVersion !== 'string') {
    throw new Error('evidence-store: parser_version is required and non-null at structured Evidence layer (05 v0.3.1 SC-01)');
  }
  if (!extractorVersion || typeof extractorVersion !== 'string') {
    throw new Error('evidence-store: extractor_version is required and non-null at structured Evidence layer (05 v0.3.1 SC-01)');
  }
  const collectorVersions = provenance.map(p => p.collector_version);
  if (collectorVersions.includes(parserVersion)) {
    throw new Error('evidence-store: parser_version must not copy collector_version (SC-01): ' + parserVersion);
  }

  // verified/derived：每张引用快照 raw payload 必须可解析（06：有 id 断链不计入）
  if (status !== EVIDENCE_STATUS.UNAVAILABLE) {
    const broken = provenance.filter(p => !p.raw_resolvable);
    if (broken.length) {
      throw new Error('evidence-store: raw payload unresolvable for evidence-grade status ' + status + ': ' + broken.map(p => p.snapshot_id).join(','));
    }
  }
  // unavailable：不承载业务值（不把失败伪装成值）
  const extractedValue = status === EVIDENCE_STATUS.UNAVAILABLE ? null
    : (input.extracted_value === undefined ? null : input.extracted_value);

  // P0-2：幂等键只由规范语义身份确定性导出，禁止调用方覆盖（input.idempotency_key
  // 已移除——任意覆盖会让语义不同的证据坍缩成 duplicate）
  const idempotencyKey = buildIdempotencyKey({
    tenantId,
    sourceSnapshotIds: snapshotIds,
    source: input.source,
    provider: input.provider,
    claim: input.claim,
    entityKey: input.entity_key,
    valueDigest: extractedValue == null ? null : sha256hex(stableStringify(extractedValue)),
    unit: input.unit,
    currency: input.currency,
    market: input.market,
    evidenceStatus: status,
    reasonCode,
    parserVersion,
    extractorVersion,
  });

  const observedAt = input.observed_at == null ? null : String(input.observed_at);
  const nowIso = new Date().toISOString();
  const meta = {
    evidence_id: 'ev_' + idempotencyKey.slice(0, 20), // 确定性导出，不接受调用方指定
    schema_version: SCHEMA_VERSION,
    created_at: nowIso,
    computed_at: nowIso, // 00 §8：Evidence 是 Snapshot+parser/extractor 的可回算输出；M0-02 无算法层，algorithm/config_version 恒 null
    tenant: {
      tenant_id: tenantId,
      project_ref: input.projectRef || null,
      brand_hint: input.brandHint || null,
    },
    entity_ref: input.entity_ref || null,   // 来源原生标识（product/variant/handle/domain），不造 Canonical 语义
    entity_key: input.entity_key == null ? null : String(input.entity_key), // 实体定位键（已参与幂等身份；M0-03/04 分组比较必需，补持久化）
    source: input.source || null,           // 00 §1.5（如 'shopify'）
    provider: input.provider || null,
    source_snapshot_ids: snapshotIds,
    claim: {
      field: (input.claim && input.claim.field) || null,   // 字段域（如 'product.price'）
      scope: (input.claim && input.claim.scope) || null,   // claim_scope（如 'public_price_observation'）
    },
    extracted_value: extractedValue,
    unit: input.unit == null ? null : String(input.unit),
    currency: input.currency == null ? null : String(input.currency),
    market: input.market == null ? null : String(input.market),
    evidence_status: status,
    reason_code: reasonCode,
    // 正交维度（≠ evidence_status）：本层不推导，缺省 null；调用方显式给才落值
    evidence_strength: input.evidence_strength === undefined ? null : input.evidence_strength,
    source_quality: input.source_quality === undefined ? null : input.source_quality,
    observed_at: observedAt,
    collector_version: provenance.length === 1 ? provenance[0].collector_version : null, // 多快照引用时不归属单一 collector
    parser_version: parserVersion,
    extractor_version: extractorVersion,
    algorithm_version: input.algorithm_version == null ? null : String(input.algorithm_version),
    config_version: input.config_version == null ? null : String(input.config_version),
    provenance: { snapshots: provenance },
    idempotency_key: idempotencyKey,
    note: input.note || null,
  };

  const dir = evidenceDirOf(tenantId);
  const fPath = evidencePathOf(tenantId, meta.evidence_id);
  if (fs.existsSync(fPath)) {
    // 幂等重试：同键 → 返回既有记录（duplicate:true），绝不覆盖（00 §37/§56.2）
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch (e) { existing = null; }
    if (existing && existing.idempotency_key === idempotencyKey) {
      return { recorded: true, meta: existing, duplicate: true };
    }
    // 同 id 不同键 = 确定性 id 派生被绕过/哈希碰撞，按 append-only 违例显式失败
    throw new Error('evidence-store: evidence exists with different idempotency identity, append-only violation: ' + meta.evidence_id);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fPath, JSON.stringify(meta, null, 1), { flag: 'wx' });
  return { recorded: true, meta, duplicate: false };
}

// 按 id 读回（租户命名空间隔离：B 租户查 A 的 evidence_id → null）。
// P0-1 安全：evidenceId 来自外部请求（/api/demo/evidence-detail?id=），
// 存储层独立防御——非法 ID（含 ../ 路径穿越/盘符/绝对路径）一律不触盘返回 null；
// 包含性检查保证解析后路径仍在该租户 evidence 目录内（双保险）。
function getEvidenceById(tenantId, evidenceId) {
  if (!tenantId || !evidenceId) return null;
  if (!safeId.isSafeId(evidenceId)) return null;
  const dir = evidenceDirOf(tenantId);
  const fPath = evidencePathOf(tenantId, evidenceId);
  if (!safeId.isWithinDir(dir, fPath)) return null;
  if (!fs.existsSync(fPath)) return null;
  try { return JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch (e) { return null; }
}

// 按快照反查该租户名下引用它的全部 Evidence（M0 量级：每租户数百条以内，全扫可接受；
// 体量增长后归后续索引票，不在本票引入二级索引复杂度）
function findEvidenceBySnapshot(tenantId, snapshotId) {
  if (!tenantId || !snapshotId) return [];
  const dir = evidenceDirOf(tenantId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (Array.isArray(meta.source_snapshot_ids) && meta.source_snapshot_ids.includes(String(snapshotId))) out.push(meta);
    } catch (e) { /* 单文件损坏不拖垮整查 */ }
  }
  out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return out;
}

module.exports = {
  SCHEMA_VERSION, EVIDENCE_STATUS, UNAVAILABLE_REASON_CODES, SOURCE_FAILURE_REASON, SOURCE_FAILURE_STATUSES,
  buildIdempotencyKey, stableStringify, recordEvidence, getEvidenceById, findEvidenceBySnapshot,
};
