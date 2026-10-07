'use strict';
// ============================================================
// research/demo-fixture.js —— Demo Sprint Stage 4：确定性 Demo 场景播种器
// 固定场景（任务书 §四）：Demo Brand / Demo Product，两次观察 39 → 29，
// 完整走真实事实链：Snapshot A → Evidence A → Fact A；Snapshot B → Evidence B
// → Fact B → Diff → price_change_observed DomainEvent。
// 🔴 不在前端写死卡片冒充事件；本模块只是用固定输入驱动真实链路代码。
// 所有产物明确标记 'Demo / Sample Data'（note + fixture 标记字段），不冒充
// 当天真实竞品。
//
// 幂等：同一租户已存在 Demo 场景事件 → { already:true }（不重复播种）；
// append-only 纪律下绝不删除/重写任何已有链路对象。
// 零网络（快照体来自固定字节数组，非真实抓取）、零 LLM。
// ============================================================
const Snapshot = require('./source-snapshot.js');
const Extract = require('./evidence-extract.js');
const FactStore = require('./fact-store.js');
const DomainEvent = require('./domain-event.js');
const als = require('../core/als.js');

const FIXTURE_TAG = 'Demo / Sample Data';
const DEMO_BRAND = 'Demo Brand';
const DEMO_PRODUCT_ID = '1001';
const DEMO_ENTITY_KEY = 'shopify_product:' + DEMO_PRODUCT_ID;
// 固定观察时间（确定性；两次观察跨窗口）。
// 🔴 必须冻结在历史日期（比赛运行时刻之前），否则 UI 会"观察到未来的竞争变化"穿帮。
// 不要改成 new Date() 动态生成——幂等与测试稳定性依赖确定性。
const OBS_A = '2026-10-07T09:00:00.000Z';
const OBS_B = '2026-10-07T11:00:00.000Z';

function productsJson(price) {
  return JSON.stringify({
    products: [{
      id: Number(DEMO_PRODUCT_ID), handle: 'demo-product', title: 'Demo Product', product_type: 'Figures',
      variants: [{ id: 2001, title: 'Standard', price: price }], published_at: OBS_A.slice(0, 10),
    }],
  });
}

const ENTITY_REF = {
  brand_name: DEMO_BRAND,
  domain: 'demo-brand.example.com',
  source_url: 'https://demo-brand.example.com/products.json?limit=100',
  is_fixture: true,
  fixture_tag: FIXTURE_TAG,
};

function recFixtureSnapshot(tenantId, price, observedAt) {
  const r = Snapshot.record({
    tenantId,
    capability: 'product_catalog',
    provider: 'shopify_products_json',
    source_url: ENTITY_REF.source_url,
    source_status: 'success',
    error_code: null,
    observed_at: observedAt,
    bodyBytes: Buffer.from(productsJson(price)),
    partial_scan: null, partial_scan_reason: null, partial_scan_observed_count: null,
    note: FIXTURE_TAG + '（演示固定场景，非当日真实采集）',
  });
  if (!r.recorded) throw new Error('fixture snapshot record failed');
  return r.meta;
}

function extractAndFacts(tenantId, snapMeta) {
  const ev = Extract.extractShopifyPriceEvidence({
    tenantId, snapshotId: snapMeta.snapshot_id, entityRef: ENTITY_REF,
    note: FIXTURE_TAG,
  });
  if (!ev.ok || ev.unavailable || !ev.evidence_ids.length) {
    throw new Error('fixture evidence extract failed: ' + JSON.stringify(ev).slice(0, 200));
  }
  const facts = [];
  for (const eid of ev.evidence_ids) {
    const fr = FactStore.recordPriceFactFromEvidence({ tenantId, evidenceId: eid, note: FIXTURE_TAG });
    if (!fr.recorded) throw new Error('fixture fact record failed: ' + fr.reason);
    facts.push(fr.meta);
  }
  return { evRes: ev, facts };
}

// 播种 Demo 场景。入参 { tenantId }（显式必填；亦兼容 ALS 兜底）。
// 返回 { seeded:true, chain:{...}, demo_tag } 或 { already:true, event_id } 或 { recorded:false, reason }
function seedDemoScenario(input) {
  const tenantId = (input && input.tenantId) || als.getTenantCtx() || null;
  if (!tenantId) return { recorded: false, reason: 'no_tenant_context' };
  // 幂等闸：该租户已存在 Demo 实体的价格事件 → 不重复播种
  const existing = DomainEvent.listEvents(tenantId).find(e => e.entity_key === DEMO_ENTITY_KEY);
  if (existing) return { already: true, event_id: existing.event_id };

  // Scan A：$39
  const snapA = recFixtureSnapshot(tenantId, '39.00', OBS_A);
  const a = extractAndFacts(tenantId, snapA);
  // Scan B：$29
  const snapB = recFixtureSnapshot(tenantId, '29.00', OBS_B);
  const b = extractAndFacts(tenantId, snapB);
  // Diff + Event（经真实检测装配器）
  const factB = b.facts.find(f => f.entity_key === DEMO_ENTITY_KEY) || b.facts[0];
  const det = DomainEvent.detectPriceChangeFromFact({
    tenantId, factId: factB.fact_id, note: FIXTURE_TAG,
  });
  if (!det.ok || !det.event_id) {
    return { recorded: false, reason: 'fixture_detect_failed:' + (det.reason || 'unknown'), diff_id: det.diff_id || null };
  }
  const factA = a.facts.find(f => f.entity_key === DEMO_ENTITY_KEY) || a.facts[0];
  return {
    seeded: true,
    demo_tag: FIXTURE_TAG,
    chain: {
      snapshot_a: snapA.snapshot_id,
      snapshot_b: snapB.snapshot_id,
      evidence_a: a.evRes.evidence_ids,
      evidence_b: b.evRes.evidence_ids,
      fact_a: factA.fact_id,
      fact_b: factB.fact_id,
      diff_id: det.diff_id,
      event_id: det.event_id,
      old_price: 39, new_price: 29, direction: 'decrease', pct: -25.641,
    },
  };
}

module.exports = { FIXTURE_TAG, DEMO_BRAND, DEMO_ENTITY_KEY, seedDemoScenario };
