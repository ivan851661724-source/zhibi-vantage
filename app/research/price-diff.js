'use strict';
// ============================================================
// research/price-diff.js —— M0-04 Minimal Diff
// 事实链第四环：**Diff**（00 v1.2 §5/§50：DomainEvent 负责"什么变了"，
// Diff 是其直接输入）。本票只实现 product.price：比较同一 entity 的两次
// public_product_price Fact。
//
// 规格锚点（/spec，版本锁定）：
//   00 v1.2 §1.3/§5/§26/§37（幂等）/§37/§42（多租户）/§50（分层不越权）/
//     §56（版本化）
//   02 v0.3 §10.1（Price Change：Price Fact(t-1) → Price Fact(t) → Normalize/
//     comparable check → Diff → price_change_observed；不得把 currency change /
//     variant mismatch 当 price change）/§1 原则 5（抓取失败 ≠ 无变化）
//   03 v0.3 §17（Multi-tenant）；06 v0.3（Traceability）
//
// 硬规则（任务书 Stage 2）：
//   · status 冻结三值：changed | no_meaningful_change | unavailable
//     —— 与 EvidenceStatus（00 §2）完全不同语义，互不映射
//   · 39→39 = no_meaningful_change（不产事件）；39→29 = changed
//   · 39→unavailable = unavailable（degraded 观察缺失）——🔴 不得
//     fetch_failed → no_change（02 原则 5）：新观察拿不到 Fact 就是
//     unavailable，绝不解释成"无变化"
//   · comparable check（02 §10.1）：entity_key / claim / currency 不一致
//     → 不可比 → unavailable + 显式 reason（绝不假装可比）
//   · 数值比较口径（冻结，文档化）：比较 value.price_min 与 value.price_max
//     二元组；两者相等 → no_meaningful_change；任一不同 → changed。
//     delta/pct 以 price_min 为基准（演示与 AI 解读的确定性口径）
//   · 值只来自 Fact（Fact 层已保证逐字继承 Evidence）——本层不碰价格数值，
//     只做算术（delta/pct = 纯算术，非业务判断）
//   · append-only + 幂等：diff_id 确定性导出；同键重试 duplicate:true
//   · 零 LLM、零网络
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('../core/paths.js');
const { sanitizeNs } = require('../core/state-store.js');
const FactStore = require('./fact-store.js');
const logger = require('../services/logger.js');

const SCHEMA_VERSION = 1;
const DIFF_TYPE = 'product.price';
const DERIVATION_VERSION = 'price-diff-1';

// 本票冻结三值（≠ EvidenceStatus，≠ SourceStatus——正交语义禁混用）
const DIFF_STATUS = Object.freeze({
  CHANGED: 'changed',
  NO_MEANINGFUL_CHANGE: 'no_meaningful_change',
  UNAVAILABLE: 'unavailable',
});
const VALID_STATUS = new Set(Object.values(DIFF_STATUS));

function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function stableStringify(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}';
}

// diff_id 幂等键：tenant ‖ diff_type ‖ old_fact_id ‖ new_fact_id|observation ‖
// status ‖ old/new value 摘要 ‖ derivation_version。两次 Fact 定了身份就定了
// diff 身份 → 重试/重放同对 Fact 必同键。调用方不可覆盖。
function buildIdempotencyKey(o) {
  const parts = [
    String(o.tenantId || ''),
    String(o.diffType || ''),
    String(o.oldFactId || ''),
    String(o.newFactId || ('obs:' + String(o.newObservation || ''))),
    String(o.status || ''),
    o.oldDigest == null ? null : String(o.oldDigest),
    o.newDigest == null ? null : String(o.newDigest),
    String(o.derivationVersion || ''),
  ];
  return sha256hex(stableStringify(parts));
}

function diffDirOf(tenantId) { return path.join(DATA, 'diffs', sanitizeNs(tenantId)); }

// 纯函数：两次 Fact 的可比性检查 + 状态判定（便于单测，不做 IO）
// 返回 { comparable:bool, status, reason?, direction?, delta?, pct? } 或 { notComparable, reason }
function judge(factOld, factNew) {
  // comparable check（02 §10.1）：实体/claim/币种不一致 → 不可比
  if (String(factOld.entity_key) !== String(factNew.entity_key)) {
    return { notComparable: true, reason: 'entity_key_mismatch' };
  }
  if (!factOld.claim || !factNew.claim
    || factOld.claim.field !== factNew.claim.field || factOld.claim.scope !== factNew.claim.scope) {
    return { notComparable: true, reason: 'claim_mismatch' };
  }
  if (String(factOld.currency || '') !== String(factNew.currency || '')) {
    // currency change 绝不当 price change（02 §10.1）——含 null vs 有值
    return { notComparable: true, reason: 'currency_mismatch' };
  }
  const o = factOld.value, n = factNew.value;
  if (!o || !n || !Number.isFinite(o.price_min) || !Number.isFinite(n.price_min)
    || !Number.isFinite(o.price_max) || !Number.isFinite(n.price_max)) {
    return { notComparable: true, reason: 'fact_value_invalid' };
  }
  if (o.price_min === n.price_min && o.price_max === n.price_max) {
    return { comparable: true, status: DIFF_STATUS.NO_MEANINGFUL_CHANGE };
  }
  // delta/pct 以 price_min 为基准（冻结口径）；方向按 price_min
  const delta = Number((n.price_min - o.price_min).toFixed(6));
  const pct = o.price_min === 0 ? null : Number(((n.price_min - o.price_min) / o.price_min * 100).toFixed(4));
  return {
    comparable: true,
    status: DIFF_STATUS.CHANGED,
    direction: delta < 0 ? 'decrease' : 'increase',
    delta,            // price_min 差（new - old，负=降价）
    pct,              // price_min 变化率（%）；old=0 时不定义（null），绝不除零编数
  };
}

// 唯一入口 A：比较两张已落盘 Fact（同租户）。
// 入参 { tenantId, oldFactId, newFactId }
// 返回 { recorded:true, meta, duplicate:bool }
//   或 { recorded:false, reason } ∈ no_tenant_context | fact_not_found |
//     fact_not_comparable
function diffPriceFacts(input) {
  return diffImpl(input, null);
}

// 唯一入口 B：旧 Fact vs 新观察缺失（unavailable/degraded）。
// 🔴 核心纪律：新观察拿不到价格 Fact（如证据 unavailable / fetch_failed）时
// 必须走本入口产 unavailable Diff——绝不允许解释成 no_meaningful_change。
// 入参 { tenantId, oldFactId, newObservation: 'unavailable', reason }
//   reason 建议传 Fact 层拒绝原因（如 evidence_unavailable）或失败细节
//   （如 fetch_failed），原样保留进 diff.reason_detail——失败原因不吞不改。
// 返回同 A。
function diffPriceFactWithUnavailableObservation(input) {
  if (input.newObservation !== 'unavailable') {
    return { recorded: false, reason: 'unsupported_observation' };
  }
  return diffImpl(input, { observation: 'unavailable', reason: input.reason || null });
}

function diffImpl(input, unavailableNew) {
  const tenantId = input.tenantId ? String(input.tenantId) : null;
  if (!tenantId) {
    logger.warn('diff_record_skip', { reason: 'no_tenant_context' });
    return { recorded: false, reason: 'no_tenant_context' };
  }
  const oldFact = FactStore.getFactById(tenantId, input.oldFactId);
  if (!oldFact) return { recorded: false, reason: 'fact_not_found' };
  let newFact = null;
  let judgeRes;
  if (unavailableNew) {
    judgeRes = { comparable: true, status: DIFF_STATUS.UNAVAILABLE };
  } else {
    newFact = FactStore.getFactById(tenantId, input.newFactId);
    if (!newFact) return { recorded: false, reason: 'fact_not_found' };
    judgeRes = judge(oldFact, newFact);
    if (judgeRes.notComparable) {
      // 不可比 ≠ no_change：产 unavailable Diff 并显式报因（02 §10.1 comparable check）
      judgeRes = { comparable: true, status: DIFF_STATUS.UNAVAILABLE, reason: judgeRes.reason };
    }
  }
  const status = judgeRes.status;
  if (!VALID_STATUS.has(status)) return { recorded: false, reason: 'invalid_status' };

  const oldValue = status === DIFF_STATUS.UNAVAILABLE && !unavailableNew && judgeRes.reason
    ? { price_min: oldFact.value.price_min, price_max: oldFact.value.price_max }
    : (oldFact.value ? { price_min: oldFact.value.price_min, price_max: oldFact.value.price_max } : null);
  const newValue = newFact ? { price_min: newFact.value.price_min, price_max: newFact.value.price_max } : null;

  const idempotencyKey = buildIdempotencyKey({
    tenantId,
    diffType: DIFF_TYPE,
    oldFactId: oldFact.fact_id,
    newFactId: newFact ? newFact.fact_id : null,
    newObservation: unavailableNew ? unavailableNew.observation : null,
    status,
    oldDigest: oldValue == null ? null : sha256hex(stableStringify(oldValue)),
    newDigest: newValue == null ? null : sha256hex(stableStringify(newValue)),
    derivationVersion: DERIVATION_VERSION,
  });

  const nowIso = new Date().toISOString();
  const meta = {
    diff_id: 'diff_' + idempotencyKey.slice(0, 20),
    schema_version: SCHEMA_VERSION,
    diff_type: DIFF_TYPE,
    status,                       // changed | no_meaningful_change | unavailable（冻结三值）
    created_at: nowIso,
    computed_at: nowIso,
    tenant: { tenant_id: tenantId, project_ref: oldFact.tenant && oldFact.tenant.project_ref || null },
    entity_key: oldFact.entity_key,
    entity_ref: oldFact.entity_ref || null,
    claim: { field: oldFact.claim && oldFact.claim.field, scope: oldFact.claim && oldFact.claim.scope },
    old_value: oldValue,
    new_value: newValue,          // unavailable 时恒 null（unavailable ≠ 0）
    direction: judgeRes.direction || null,       // decrease | increase | null
    delta: judgeRes.delta == null ? null : judgeRes.delta,
    pct: judgeRes.pct == null ? null : judgeRes.pct,
    old_fact_id: oldFact.fact_id,
    new_fact_id: newFact ? newFact.fact_id : null,
    old_evidence_ids: oldFact.evidence_ids || [],
    new_evidence_ids: newFact ? (newFact.evidence_ids || []) : [],
    old_snapshot_ids: oldFact.source_snapshot_ids || [],
    new_snapshot_ids: newFact ? (newFact.source_snapshot_ids || []) : [],
    observed_at_old: oldFact.observed_at == null ? null : oldFact.observed_at,
    observed_at_new: newFact ? (newFact.observed_at == null ? null : newFact.observed_at) : null,
    reason: (status === DIFF_STATUS.UNAVAILABLE ? (judgeRes.reason || (unavailableNew && unavailableNew.reason) || 'observation_unavailable') : null),
    reason_detail: unavailableNew ? (unavailableNew.reason || null) : null, // 失败细节原样保留（fetch_failed 等不吞不改）
    old_currency: oldFact.currency == null ? null : oldFact.currency,
    new_currency: newFact ? (newFact.currency == null ? null : newFact.currency) : null,
    derivation_version: DERIVATION_VERSION,
    algorithm_version: null,      // 显式 null：纯比较无算法层（不伪造）
    config_version: null,
    idempotency_key: idempotencyKey,
    note: input.note || null,
  };

  const dir = diffDirOf(tenantId);
  const fPath = path.join(dir, meta.diff_id + '.json');
  if (fs.existsSync(fPath)) {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch (e) { existing = null; }
    if (existing && existing.idempotency_key === idempotencyKey) {
      return { recorded: true, meta: existing, duplicate: true };
    }
    throw new Error('price-diff: diff exists with different idempotency identity, append-only violation: ' + meta.diff_id);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fPath, JSON.stringify(meta, null, 1), { flag: 'wx' });
  return { recorded: true, meta, duplicate: false };
}

// 按 entity 反查该租户名下全部价格 Fact（M0-05 事件装配辅助：找上一观察）。
// 按 observed_at 升序（缺失排前），稳定可回放。
function findPriceFactsByEntity(tenantId, entityKey) {
  if (!tenantId || !entityKey) return [];
  const dir = path.join(DATA, 'facts', sanitizeNs(tenantId));
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (meta.fact_type === FactStore.FACT_TYPE && String(meta.entity_key) === String(entityKey)) out.push(meta);
    } catch (e) { /* 单文件损坏不拖垮整查 */ }
  }
  out.sort((a, b) => String(a.observed_at || '').localeCompare(String(b.observed_at || ''))
    || String(a.created_at).localeCompare(String(b.created_at)));
  return out;
}

function getDiffById(tenantId, diffId) {
  if (!tenantId || !diffId) return null;
  const fPath = path.join(diffDirOf(tenantId), String(diffId) + '.json');
  if (!fs.existsSync(fPath)) return null;
  try { return JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch (e) { return null; }
}

module.exports = {
  SCHEMA_VERSION, DIFF_TYPE, DIFF_STATUS, DERIVATION_VERSION,
  judge, diffPriceFacts, diffPriceFactWithUnavailableObservation,
  findPriceFactsByEntity, getDiffById,
};
