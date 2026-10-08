'use strict';
// ============================================================
// research/fact-store.js —— M0-03 Minimal Fact（存储+派生层）
// 事实链第三环：SourceSnapshot → Evidence → **Fact**（00 v1.2 §5/§50）。
// 本票只支持一种 Fact：public_product_price（Shopify 商品公开价格）。
//
// 规格锚点（/spec，版本锁定）：
//   00 v1.2 §1.3（Fact=数据源直接观察、标准化与验证后的事实，不含业务判断）/
//     §5/§50（事实链分层：Fact 负责"真实发生什么"，不越权）/§8（computed_at）/
//     §26/§37（幂等去重）/§42（多租户）/§56（版本化；迁移不覆盖历史）
//   02 v0.3 §1（原则 1 Fact 与 Judgment 分离；原则 4 unavailable ≠ 0；原则 5
//     抓取失败 ≠ 无变化；原则 7 可回算对象带版本）/§2.1（Schema Gate：不合格
//     不进 Canonical Fact、保留 reason_code）
//   03 v0.3 §17（Multi-tenant）
//   06 v0.3（Traceability：Fact → Evidence → SourceSnapshot → raw 全链可解析）
//
// 硬规则：
//   · Fact 值只能从引用 Evidence 的 extracted_value **逐字继承**——调用方不可
//     注入/改写价格（"解释而非制造事实"在 Fact 层的前置：Fact 层也不制造）。
//     unavailable Evidence → 不生成有效价格 Fact（02 原则 4：unavailable ≠ 0，
//     绝不落一个 0 值 Fact 冒充观察）；verified 之外的状态一律拒绝
//   · $0 价格如实入 Fact（P1-1 同源继承；freebie/促销业务解读归后续阶段）
//   · 禁 AOV/销量/成交价语义（05 §19.6；claim.scope 冻结 public_price_observation）
//   · 零 LLM、零网络：纯确定性派生
//   · append-only + 幂等：fact_id 由幂等键确定性导出；同键重试返回既有记录
//     （duplicate:true）绝不覆盖（00 §37）；不同 Evidence → 不同键 → 新 Fact
//   · 租户隔离：Evidence 按租户 ns 解析，跨租户/不存在 → 拒绝；Fact 落盘在
//     租户 ns 内（与 snapshots/evidence 同规）
//   · Traceability：落 Fact 前复核每张 source_snapshot_id 在租户域内可解析
//     （Fact → Evidence → SourceSnapshot 全链，06）；断链拒绝
//   · 版本：derivation_version 必填非空（本层实际版本）；algorithm_version /
//     config_version 显式 null（M0-03 无算法层），不伪造
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('../core/paths.js');
const { sanitizeNs } = require('../core/state-store.js');
const als = require('../core/als.js');
const safeId = require('../core/safe-id.js');
const Snapshot = require('./source-snapshot.js');
const EvidenceStore = require('./evidence-store.js');
const logger = require('../services/logger.js');

const SCHEMA_VERSION = 1;

// 本票冻结的唯一 Fact 类型与 claim 语义（禁 AOV —— 05 §19.6）
const FACT_TYPE = 'public_product_price';
const CLAIM_FIELD = 'product.price';
const CLAIM_SCOPE = 'public_price_observation';
const DERIVATION_VERSION = 'fact-extract-1'; // 本层实际派生版本（02 原则 7）

function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// 稳定序列化（与 evidence-store 同实现，键排序 → 确定性摘要）
function stableStringify(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}';
}

// 幂等键（00 §37）：规范语义身份 = tenant ‖ fact_type ‖ claim.field ‖
// claim.scope ‖ entity_key ‖ value 摘要 ‖ evidence_ids(排序) ‖ derivation_version。
// evidence_id 本身已由 Evidence 层语义身份确定性导出 → 重试/重放同证据必同键；
// 新观察（新快照/新时间戳）→ 新 evidence_id → 新 Fact（历史事实不可变）。
// 调用方不可覆盖键值（与 Evidence 层同规，P0-2 纪律延续）。
function buildIdempotencyKey(o) {
  const parts = [
    String(o.tenantId || ''),
    String(o.factType || ''),
    String((o.claim && o.claim.field) || ''),
    String((o.claim && o.claim.scope) || ''),
    o.entityKey == null ? null : String(o.entityKey),
    o.valueDigest == null ? null : String(o.valueDigest),
    (o.evidenceIds || []).slice().sort(),
    String(o.derivationVersion || ''),
  ];
  return sha256hex(stableStringify(parts));
}

function factDirOf(tenantId) { return path.join(DATA, 'facts', sanitizeNs(tenantId)); }
function factPathOf(tenantId, factId) { return path.join(factDirOf(tenantId), String(factId) + '.json'); }

function resolveTenantId(explicit) {
  if (explicit) return String(explicit);
  const ctx = als.getTenantCtx();
  return ctx ? String(ctx) : null;
}

// 唯一派生入口：从一条已落盘 Evidence 派生 public_product_price Fact。
// 同步、零网络、零 LLM。Fact 值 = evidence.extracted_value 逐字继承，不可注入。
// 入参：{ tenantId?, evidenceId, note? }
// 返回 { recorded:true, meta, duplicate:bool }
//   或 { recorded:false, reason } —— reason ∈ no_tenant_context |
//     evidence_not_found | evidence_claim_mismatch | evidence_unavailable |
//     evidence_status_not_price_fact_eligible | evidence_value_invalid |
//     snapshot_unresolvable
function recordPriceFactFromEvidence(input) {
  const tenantId = resolveTenantId(input.tenantId);
  if (!tenantId) {
    logger.warn('fact_record_skip', { reason: 'no_tenant_context', evidence_id: input.evidenceId || null });
    return { recorded: false, reason: 'no_tenant_context' };
  }
  const ev = EvidenceStore.getEvidenceById(tenantId, input.evidenceId);
  if (!ev) {
    // 按租户 ns 解析不命中 = 不存在或跨租户，同规拒绝（03 §17）
    return { recorded: false, reason: 'evidence_not_found' };
  }
  // 本票仅 product.price / public_price_observation 可派生价格 Fact
  if (!ev.claim || ev.claim.field !== CLAIM_FIELD || ev.claim.scope !== CLAIM_SCOPE) {
    return { recorded: false, reason: 'evidence_claim_mismatch' };
  }
  // 02 原则 4：unavailable ≠ 0 —— unavailable Evidence 绝不生成有效价格 Fact
  if (ev.evidence_status === EvidenceStore.EVIDENCE_STATUS.UNAVAILABLE) {
    return { recorded: false, reason: 'evidence_unavailable' };
  }
  // M0-02 只产 verified/unavailable；derived/conflicted 目前无生产路径，
  // 显式拒绝（诚实能力边界，不静默放行）
  if (ev.evidence_status !== EvidenceStore.EVIDENCE_STATUS.VERIFIED) {
    return { recorded: false, reason: 'evidence_status_not_price_fact_eligible' };
  }
  // Schema Gate（02 §2.1，价格 Fact 最小校验）：值存在且为数值型价格观察
  const v = ev.extracted_value;
  const okValue = v && typeof v === 'object'
    && Number.isFinite(v.price_min) && Number.isFinite(v.price_max)
    && Array.isArray(v.prices) && v.prices.length > 0
    && v.prices.every(p => p && Number.isFinite(p.price));
  if (!okValue) {
    return { recorded: false, reason: 'evidence_value_invalid' };
  }
  // Traceability：Fact → Evidence → SourceSnapshot 全链复核（06）
  const snapshotIds = Array.isArray(ev.source_snapshot_ids) ? ev.source_snapshot_ids.map(String) : [];
  if (!snapshotIds.length) return { recorded: false, reason: 'snapshot_unresolvable' };
  for (const sid of snapshotIds) {
    if (!Snapshot.getById(tenantId, sid)) {
      return { recorded: false, reason: 'snapshot_unresolvable' };
    }
  }

  const value = {
    price_min: v.price_min,
    price_max: v.price_max,
    prices: v.prices, // 逐字继承（含 $0 变体——P1-1 同源；禁业务过滤）
  };
  const idempotencyKey = buildIdempotencyKey({
    tenantId,
    factType: FACT_TYPE,
    claim: ev.claim,
    entityKey: ev.entity_key,
    valueDigest: sha256hex(stableStringify(value)),
    evidenceIds: [ev.evidence_id],
    derivationVersion: DERIVATION_VERSION,
  });

  const nowIso = new Date().toISOString();
  const meta = {
    fact_id: 'fact_' + idempotencyKey.slice(0, 20), // 确定性导出，不接受调用方指定
    schema_version: SCHEMA_VERSION,
    fact_type: FACT_TYPE,
    created_at: nowIso,
    computed_at: nowIso, // 00 §8；M0-03 无算法层 → algorithm/config_version 恒 null（不伪造）
    tenant: {
      tenant_id: tenantId,
      project_ref: ev.tenant && ev.tenant.project_ref || null,
      brand_hint: ev.tenant && ev.tenant.brand_hint || null,
    },
    entity_key: ev.entity_key || null,
    entity_ref: ev.entity_ref || null,
    claim: { field: ev.claim.field, scope: ev.claim.scope },
    value,                                  // 真实发生什么（不含业务判断，00 §1.3）
    currency: ev.currency == null ? null : ev.currency, // 继承 Evidence 诚实缺失（P0-1 同源）
    unit: ev.unit == null ? null : ev.unit,
    market: ev.market == null ? null : ev.market,
    observed_at: ev.observed_at == null ? null : ev.observed_at,
    evidence_ids: [ev.evidence_id],         // Fact → Evidence（双向可查）
    source_snapshot_ids: snapshotIds,       // Fact → SourceSnapshot（全链溯源）
    source: ev.source || null,
    provider: ev.provider || null,
    derivation_version: DERIVATION_VERSION,
    algorithm_version: null,  // 显式 null：本层无算法计算（02 原则 7 版本化要求）
    config_version: null,     // 显式 null：同上
    provenance: {
      evidence: {
        evidence_id: ev.evidence_id,
        evidence_status: ev.evidence_status,
        parser_version: ev.parser_version,
        extractor_version: ev.extractor_version,
      },
      snapshots: ev.provenance && Array.isArray(ev.provenance.snapshots) ? ev.provenance.snapshots : [],
    },
    idempotency_key: idempotencyKey,
    note: input.note || null,
  };

  const dir = factDirOf(tenantId);
  const fPath = factPathOf(tenantId, meta.fact_id);
  if (fs.existsSync(fPath)) {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch (e) { existing = null; }
    if (existing && existing.idempotency_key === idempotencyKey) {
      return { recorded: true, meta: existing, duplicate: true };
    }
    throw new Error('fact-store: fact exists with different idempotency identity, append-only violation: ' + meta.fact_id);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fPath, JSON.stringify(meta, null, 1), { flag: 'wx' });
  return { recorded: true, meta, duplicate: false };
}

// 按 id 读回（租户命名空间隔离：B 租户查 A 的 fact_id → null）。
// P0-1 安全：存储层独立防御——非法 ID（../ 穿越/盘符/绝对路径）不触盘返回 null，
// 包含性检查保证解析后路径仍在该租户 facts 目录内。
function getFactById(tenantId, factId) {
  if (!tenantId || !factId) return null;
  if (!safeId.isSafeId(factId)) return null;
  const dir = factDirOf(tenantId);
  const fPath = factPathOf(tenantId, factId);
  if (!safeId.isWithinDir(dir, fPath)) return null;
  if (!fs.existsSync(fPath)) return null;
  try { return JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch (e) { return null; }
}

// 按 Evidence 反查该租户名下引用它的全部 Fact（Fact ↔ Evidence 双向）
function findFactsByEvidence(tenantId, evidenceId) {
  if (!tenantId || !evidenceId) return [];
  const dir = factDirOf(tenantId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (Array.isArray(meta.evidence_ids) && meta.evidence_ids.includes(String(evidenceId))) out.push(meta);
    } catch (e) { /* 单文件损坏不拖垮整查 */ }
  }
  out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return out;
}

// 按 SourceSnapshot 反查（Fact → SourceSnapshot 全链验证辅助）
function findFactsBySnapshot(tenantId, snapshotId) {
  if (!tenantId || !snapshotId) return [];
  const dir = factDirOf(tenantId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (Array.isArray(meta.source_snapshot_ids) && meta.source_snapshot_ids.includes(String(snapshotId))) out.push(meta);
    } catch (e) { /* 同上 */ }
  }
  out.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  return out;
}

module.exports = {
  SCHEMA_VERSION, FACT_TYPE, CLAIM_FIELD, CLAIM_SCOPE, DERIVATION_VERSION,
  stableStringify, recordPriceFactFromEvidence, getFactById, findFactsByEvidence, findFactsBySnapshot,
};
