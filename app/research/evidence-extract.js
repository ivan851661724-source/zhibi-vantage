'use strict';
// ============================================================
// research/evidence-extract.js —— M0-02 Evidence Foundation（确定性提取层）
// 首条真实端到端 Evidence 链（Vertical Slice，任务书 §10）：
//   Shopify products.json SourceSnapshot（M0-01 已落盘）
//     → 确定性 parser/extractor（零 LLM，零网络）
//     → 产品公开价格观察 Evidence（verified）
//   失败态快照 → unavailable Evidence（source failure ≠ no_change，00 §38）
//
// 规格锚点（/spec，版本锁定）：
//   00 v1.2 §1.5/§2+§2.1/§5/§26/§37/§38/§42
//   02 v0.3 §3（EvidenceStatus 沿用 00）
//   05 v0.3.1 §10（Adapter Contract）/§11（SourceStatus ≠ EvidenceStatus）/
//     §19.6（Shopify Adapter：禁 AOV/真实销量/真实成交价）
//   06 v0.3（Evidence Traceability：断链不得产证）
//
// 硬规则：
//   · 只从快照 raw 原始字节重放解析——绝不消费业务层已裁剪的 items/pricePoints，
//     保证 Evidence 与原始捕获字节可对账（06 Traceability）
//   · verified 证据必须快照存在 + 同租户 + raw 可解析 + JSON 可重放，任一不满足
//     即拒绝产证并显式报因——绝不把断链/损坏伪装成证据
//   · 失败态快照（unavailable/blocked/rate_limited/timeout/parse_failed/
//     internal_error）→ unavailable Evidence + 冻结 reason_code，extracted_value
//     恒 null；绝不从失败观察编造业务值
//   · 公开商品价格只是 public price observation：claim.scope 冻结为
//     'public_price_observation'，禁 AOV/销量/成交价语义（05 §19.6）
//   · $0/负价变体不入价格观察（免费品/赠品/脏值，与 legacy 价格口径一致）
//   · SC-01：parser_version / extractor_version 为本层实际版本，恒非空，
//     不复制 collector_version
// ============================================================
const Snapshot = require('./source-snapshot.js');
const Store = require('./evidence-store.js');
const logger = require('../services/logger.js');

// 本层版本（05 v0.3.1 SC-01：结构化 Evidence 层必填实际版本）
const PARSER_VERSION = 'shopify-products-json-1';     // products.json 结构化解析器版本
const EXTRACTOR_VERSION = 'evidence-extract-1';       // 价格观察提取器版本
const SOURCE = 'shopify';
const PROVIDER = 'shopify_products_json';
// 冻结 claim 语义：公开价格观察（禁 AOV/销量/成交价——05 §19.6 Shopify 边界）
const CLAIM_FIELD = 'product.price';
const CLAIM_SCOPE = 'public_price_observation';

// 解析 products.json 原始字节 → 每产品价格观察候选（纯函数，便于单测）。
// 返回 { products: [...], empty: bool }；products[] 元素：
//   { entity_key, entity_ref:{product_id,handle,title,product_type,variant_count},
//     prices:[{variant_id,title,price}], price_min, price_max }
// 无有效价格变体的产品跳过（无主张不产证，不编造）。
function parseProductPriceObservations(rawText) {
  let j;
  try { j = JSON.parse(String(rawText)); } catch (e) { return { error: 'raw_json_parse_failed' }; }
  const products = Array.isArray(j.products) ? j.products : [];
  const out = [];
  for (const p of products) {
    if (!p || typeof p !== 'object') continue;
    const variants = Array.isArray(p.variants) ? p.variants : [];
    const prices = [];
    for (const v of variants) {
      const n = parseFloat(v && v.price);
      if (Number.isFinite(n) && n > 0) {
        prices.push({ variant_id: v.id == null ? null : String(v.id), title: v.title == null ? null : String(v.title).slice(0, 200), price: n });
      }
    }
    if (!prices.length) continue; // 全部变体无有效价 → 该产品不产价格主张
    const sorted = prices.map(x => x.price).sort((a, b) => a - b);
    out.push({
      entity_key: 'shopify_product:' + (p.id == null ? String(p.handle || p.title || '') : String(p.id)),
      entity_ref: {
        product_id: p.id == null ? null : String(p.id),
        handle: p.handle == null ? null : String(p.handle).slice(0, 200),
        title: p.title == null ? null : String(p.title).slice(0, 300),
        product_type: p.product_type == null ? null : String(p.product_type).slice(0, 120),
        variant_count: variants.length,
        variant_observed_count: prices.length,
      },
      prices,
      price_min: sorted[0],
      price_max: sorted[sorted.length - 1],
    });
  }
  return { products: out, empty: products.length === 0 };
}

// 从一张已落盘快照提取 Evidence。同步、零网络、零 LLM。
// 入参：{ tenantId?, snapshotId, currency?, market?, unit?, entityRef?, projectRef?, brandHint?, note? }
// 返回：{ ok:true, evidence_ids:[...], unavailable?:bool, duplicate_count?, empty? }
//    或 { ok:false, reason } —— reason ∈ snapshot_not_found | raw_unresolvable | raw_json_parse_failed
//    或 { recorded:false, reason:'no_tenant_context' }（存储层同规透传）
function extractShopifyPriceEvidence(input) {
  const tenantId = input.tenantId || undefined; // undefined → 存储层走 ALS 兜底
  const meta = Snapshot.getById(tenantId, input.snapshotId);
  if (!meta) {
    logger.warn('evidence_extract_skip', { reason: 'snapshot_not_found', snapshot_id: input.snapshotId || null });
    return { ok: false, reason: 'snapshot_not_found' };
  }
  // 快照归属租户必须与 Evidence 租户一致（getById 按租户 ns 解析已保证；
  // 此处显式复核，防御 getById 未来放宽）
  const snapTenant = meta.tenant && meta.tenant.tenant_id ? String(meta.tenant.tenant_id) : null;
  const effTenant = input.tenantId || null;
  if (effTenant && snapTenant && snapTenant !== effTenant) {
    return { ok: false, reason: 'snapshot_tenant_mismatch' };
  }

  // 失败态快照 → unavailable Evidence（extracted_value 恒 null，不编造业务值）
  const failReason = Store.SOURCE_FAILURE_REASON[meta.source_status];
  if (failReason) {
    const r = Store.recordEvidence({
      tenantId: input.tenantId,
      source_snapshot_ids: [meta.snapshot_id],
      claim: { field: CLAIM_FIELD, scope: CLAIM_SCOPE },
      extracted_value: null,
      evidence_status: Store.EVIDENCE_STATUS.UNAVAILABLE,
      reason_code: failReason,
      source: SOURCE,
      provider: PROVIDER,
      entity_ref: input.entityRef || null,
      entity_key: null,
      currency: input.currency || null,
      market: input.market || null,
      unit: null,
      observed_at: meta.observed_at,   // 失败观察 observed_at 可为 null（M0-01 语义），如实继承
      parser_version: PARSER_VERSION,
      extractor_version: EXTRACTOR_VERSION,
      projectRef: input.projectRef || null,
      brandHint: input.brandHint || null,
      note: input.note || ('source_failure_observation: source_status=' + meta.source_status + (meta.error_code ? ' error=' + meta.error_code : '')),
    });
    if (!r.recorded) return r;
    return { ok: true, evidence_ids: [r.meta.evidence_id], unavailable: true, duplicate_count: r.duplicate ? 1 : 0 };
  }

  // success / partial 快照：raw 原始字节必须可解析（断链不产证）
  const raw = Snapshot.readRawPayload(meta);
  if (!raw) {
    logger.error('evidence_extract_skip', { reason: 'raw_unresolvable', snapshot_id: meta.snapshot_id });
    return { ok: false, reason: 'raw_unresolvable' };
  }
  const parsed = parseProductPriceObservations(raw.toString('utf8'));
  if (parsed.error) {
    logger.error('evidence_extract_skip', { reason: parsed.error, snapshot_id: meta.snapshot_id });
    return { ok: false, reason: parsed.error };
  }
  if (parsed.empty) {
    // 空目录：无价格主张可建立 → 不产证（不伪造、也不把空目录当失败）
    return { ok: true, evidence_ids: [], empty: true };
  }

  const evidenceIds = [];
  let duplicateCount = 0;
  for (const obs of parsed.products) {
    const r = Store.recordEvidence({
      tenantId: input.tenantId,
      source_snapshot_ids: [meta.snapshot_id],
      claim: { field: CLAIM_FIELD, scope: CLAIM_SCOPE },
      extracted_value: {
        price_min: obs.price_min,
        price_max: obs.price_max,
        prices: obs.prices,               // 变体粒度价格明细（variant_id/title/price）
      },
      evidence_status: Store.EVIDENCE_STATUS.VERIFIED,
      source: SOURCE,
      provider: PROVIDER,
      entity_ref: Object.assign({}, input.entityRef || {}, obs.entity_ref),
      entity_key: obs.entity_key,
      currency: input.currency || null,   // 店铺结账币种（cart.js 探测），products.json 本身不带币种
      market: input.market || null,
      unit: null,
      observed_at: meta.observed_at,
      parser_version: PARSER_VERSION,
      extractor_version: EXTRACTOR_VERSION,
      projectRef: input.projectRef || null,
      brandHint: input.brandHint || null,
      note: meta.partial_scan ? 'partial_scan snapshot: catalog enumeration incomplete; price observation per observed product remains valid' : (input.note || null),
    });
    if (!r.recorded) return r; // 租户上下文丢失：与存储层同规透传
    if (r.duplicate) duplicateCount++;
    evidenceIds.push(r.meta.evidence_id);
  }
  return { ok: true, evidence_ids: evidenceIds, duplicate_count: duplicateCount };
}

module.exports = { PARSER_VERSION, EXTRACTOR_VERSION, SOURCE, PROVIDER, CLAIM_FIELD, CLAIM_SCOPE, parseProductPriceObservations, extractShopifyPriceEvidence };
