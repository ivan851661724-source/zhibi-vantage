'use strict';
// ============================================================
// research/domain-event.js —— M0-05 DomainEvent（price_change_observed）
// 事实链第五环：**DomainEvent**（00 v1.2 §5/§50：负责"什么变了"）。
// 本票只实现一种事件：price_change_observed（02 v0.3 §10.1）。
//
// 规格锚点（/spec，版本锁定）：
//   00 v1.2 §5/§26/§37（幂等）/§42（多租户）/§50（分层不越权：Event 只说
//     "什么变了"，不说"这意味着什么"——解读归 Judgment/AI 层）/§56
//   02 v0.3 §10.1（Diff → price_change_observed；confirmed/recheck 归后续票）
//   03 v0.3 §17；06 v0.3（Traceability：Event → Diff → Fact → Evidence →
//     SourceSnapshot 全链）
//
// 硬规则（任务书 Stage 3）：
//   · 只有 status=changed 的 Diff 产事件；no_meaningful_change /
//     unavailable Diff 一律不产事件（诚实拒绝，绝不静默）
//   · Event 必须关联：old/new Fact、Evidence、SourceSnapshot、old/new
//     price、timestamps——全链 id 落盘，缺链拒绝
//   · append-only + 幂等：event_id 确定性导出（幂等键 = tenant ‖ event_type
//     ‖ diff_id ‖ version）；同 Diff 重试 duplicate:true；调用方不可覆盖
//   · 零 LLM、零网络
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('../core/paths.js');
const { sanitizeNs } = require('../core/state-store.js');
const Diff = require('./price-diff.js');
const safeId = require('../core/safe-id.js');
const logger = require('../services/logger.js');

const SCHEMA_VERSION = 1;
const EVENT_TYPE = 'price_change_observed';
const DERIVATION_VERSION = 'domain-event-1';

function sha256hex(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function stableStringify(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(stableStringify).join(',') + ']';
  return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + stableStringify(x[k])).join(',') + '}';
}

// event_id 幂等键：tenant ‖ event_type ‖ diff_id ‖ derivation_version。
// diff_id 已确定（Diff 层幂等）→ 同一 Diff 重放必同事件；调用方不可覆盖。
function buildIdempotencyKey(o) {
  return sha256hex(stableStringify([
    String(o.tenantId || ''), String(o.eventType || ''),
    String(o.diffId || ''), String(o.derivationVersion || ''),
  ]));
}

function eventDirOf(tenantId) { return path.join(DATA, 'events', sanitizeNs(tenantId)); }

// 从一张已落盘 changed Diff 记录 price_change_observed 事件。
// 入参 { tenantId?, diffId, note? }
// 返回 { recorded:true, meta, duplicate:bool }
//   或 { recorded:false, reason } ∈ no_tenant_context | diff_not_found |
//     diff_not_changed | diff_unavailable
function recordPriceChangeEvent(input) {
  const tenantId = input.tenantId ? String(input.tenantId) : null;
  if (!tenantId) {
    logger.warn('event_record_skip', { reason: 'no_tenant_context', diff_id: input.diffId || null });
    return { recorded: false, reason: 'no_tenant_context' };
  }
  const d = Diff.getDiffById(tenantId, input.diffId);
  if (!d) return { recorded: false, reason: 'diff_not_found' };
  if (d.status === Diff.DIFF_STATUS.NO_MEANINGFUL_CHANGE) {
    return { recorded: false, reason: 'diff_not_changed' };
  }
  if (d.status === Diff.DIFF_STATUS.UNAVAILABLE) {
    // degraded 观察（含 fetch_failed）绝不当事件——也不当 no_change，到此为止
    return { recorded: false, reason: 'diff_unavailable' };
  }
  if (d.status !== Diff.DIFF_STATUS.CHANGED) {
    return { recorded: false, reason: 'diff_status_unknown' };
  }
  // 全链引用必须齐备（06 Traceability）
  if (!d.old_fact_id || !d.new_fact_id || !Array.isArray(d.old_evidence_ids) || !d.old_evidence_ids.length
    || !Array.isArray(d.new_evidence_ids) || !d.new_evidence_ids.length
    || !Array.isArray(d.old_snapshot_ids) || !d.old_snapshot_ids.length
    || !Array.isArray(d.new_snapshot_ids) || !d.new_snapshot_ids.length) {
    return { recorded: false, reason: 'diff_chain_incomplete' };
  }

  const idempotencyKey = buildIdempotencyKey({
    tenantId, eventType: EVENT_TYPE, diffId: d.diff_id, derivationVersion: DERIVATION_VERSION,
  });
  const nowIso = new Date().toISOString();
  const meta = {
    event_id: 'evt_' + idempotencyKey.slice(0, 20),
    event_type: EVENT_TYPE,
    schema_version: SCHEMA_VERSION,
    created_at: nowIso,
    occurred_at: d.computed_at || nowIso,   // 变化被判定发生的时间（Diff computed_at）
    tenant: { tenant_id: tenantId, project_ref: d.tenant && d.tenant.project_ref || null },
    entity_key: d.entity_key,
    entity_ref: d.entity_ref || null,
    // 价格语义（Demo/AI 只读这些字段；数字全部来自 Diff/Fact，非本层计算）
    old_price: d.old_value ? d.old_value.price_min : null,
    new_price: d.new_value ? d.new_value.price_min : null,
    old_value: d.old_value || null,
    new_value: d.new_value || null,
    direction: d.direction || null,         // decrease | increase
    delta: d.delta == null ? null : d.delta,
    pct: d.pct == null ? null : d.pct,
    currency: d.old_currency == null ? null : d.old_currency, // comparable check 保证 old==new
    // 全链 id（Event → Diff → Fact → Evidence → SourceSnapshot）
    diff_id: d.diff_id,
    old_fact_id: d.old_fact_id,
    new_fact_id: d.new_fact_id,
    old_evidence_ids: d.old_evidence_ids,
    new_evidence_ids: d.new_evidence_ids,
    old_snapshot_ids: d.old_snapshot_ids,
    new_snapshot_ids: d.new_snapshot_ids,
    observed_at_old: d.observed_at_old == null ? null : d.observed_at_old,
    observed_at_new: d.observed_at_new == null ? null : d.observed_at_new,
    source: 'shopify',
    provider: 'shopify_products_json',
    derivation_version: DERIVATION_VERSION,
    algorithm_version: null,
    config_version: null,
    provenance: { diff: { diff_id: d.diff_id, status: d.status, reason: d.reason || null } },
    idempotency_key: idempotencyKey,
    note: input.note || null,
  };

  const dir = eventDirOf(tenantId);
  const fPath = path.join(dir, meta.event_id + '.json');
  if (fs.existsSync(fPath)) {
    let existing = null;
    try { existing = JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch (e) { existing = null; }
    if (existing && existing.idempotency_key === idempotencyKey) {
      return { recorded: true, meta: existing, duplicate: true };
    }
    throw new Error('domain-event: event exists with different idempotency identity, append-only violation: ' + meta.event_id);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fPath, JSON.stringify(meta, null, 1), { flag: 'wx' });
  return { recorded: true, meta, duplicate: false };
}

// 装配辅助（供 enrich 接线与 Demo fixture 驱动）：新价格 Fact 落盘后，
// 自动找同 entity 的上一张 Fact → Diff → (changed 才) Event。
// 同步、零网络、零 LLM。
// 入参 { tenantId?, factId }
// 返回 { ok:bool, diff_id?, event_id?, status?, reason? }
function detectPriceChangeFromFact(input) {
  const tenantId = input.tenantId ? String(input.tenantId) : null;
  if (!tenantId) return { ok: false, reason: 'no_tenant_context' };
  const FactStore = require('./fact-store.js');
  const fact = FactStore.getFactById(tenantId, input.factId);
  if (!fact) return { ok: false, reason: 'fact_not_found' };
  const all = Diff.findPriceFactsByEntity(tenantId, fact.entity_key);
  // 上一观察：observed_at 严格早于当前（并列 created_at 兜底排序由 finder 保证）
  const prev = all.filter(f => f.fact_id !== fact.fact_id
    && String(f.observed_at || '') < String(fact.observed_at || '')).pop();
  if (!prev) return { ok: true, reason: 'no_previous_fact', diff_id: null, event_id: null };
  const dr = Diff.diffPriceFacts({ tenantId, oldFactId: prev.fact_id, newFactId: fact.fact_id });
  if (!dr.recorded) return { ok: false, reason: dr.reason };
  if (dr.meta.status !== Diff.DIFF_STATUS.CHANGED) {
    return { ok: true, diff_id: dr.meta.diff_id, status: dr.meta.status, event_id: null, reason: 'no_event_for_' + dr.meta.status };
  }
  const er = recordPriceChangeEvent({ tenantId, diffId: dr.meta.diff_id, note: input.note || null });
  if (!er.recorded) return { ok: false, diff_id: dr.meta.diff_id, reason: er.reason };
  return { ok: true, diff_id: dr.meta.diff_id, status: dr.meta.status, event_id: er.meta.event_id, duplicate: !!er.duplicate };
}

// 事件读回 / 近期列表（Demo REST 用；M0 量级全扫可接受，索引归后续票）。
// P0-1 安全：存储层独立防御——非法 ID（../ 穿越/盘符/绝对路径）不触盘返回 null；
// 包含性检查保证解析后路径仍在该租户 events 目录内。
function getEventById(tenantId, eventId) {
  if (!tenantId || !eventId) return null;
  if (!safeId.isSafeId(eventId)) return null;
  const dir = eventDirOf(tenantId);
  const fPath = path.join(dir, String(eventId) + '.json');
  if (!safeId.isWithinDir(dir, fPath)) return null;
  if (!fs.existsSync(fPath)) return null;
  try { return JSON.parse(fs.readFileSync(fPath, 'utf8')); } catch (e) { return null; }
}

function listEvents(tenantId, opts) {
  if (!tenantId) return [];
  const o = opts || {};
  const dir = eventDirOf(tenantId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (e) { /* 损坏跳过 */ }
  }
  out.sort((a, b) => String(b.occurred_at || b.created_at || '').localeCompare(String(a.occurred_at || a.created_at || '')));
  return o.limit ? out.slice(0, Number(o.limit)) : out;
}

module.exports = {
  SCHEMA_VERSION, EVENT_TYPE, DERIVATION_VERSION,
  recordPriceChangeEvent, detectPriceChangeFromFact, getEventById, listEvents,
};
