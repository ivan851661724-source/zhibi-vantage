'use strict';
// ============================================================
// path-traversal.test.js —— P0-1 路径穿越 + P2 内部路径暴露 回归测试
//（最终代码审核整改验收）
//
// 覆盖：
//   · Evidence / Event / Fact / Diff / Snapshot 存储层路径穿越（../、..\、
//     绝对路径、盘符、URL 编码后的 ../）→ 一律 null，绝不触达目标文件
//   · 租户 A 无法读取租户 B 数据（跨租户 victim 文件不可达）
//   · 正常 ID 仍能读取（合法行为零回归）
//   · API 层：非法 id → 400 INVALID_ID；合法不存在 → 404；URL 编码穿越 → 400
//   · P2：Demo API 响应不出现 raw_payload_ref（服务器内部文件路径）
// 隔离：ZB_DATA_DIR 临时目录；零网络（LLM.call 打桩，被调用即失败）
// 规格锚点：00 v1.2 §42（多租户）；03 v0.3 §17（租户私有数据不可跨租户泄漏）
// ============================================================
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-p0trav-'));
process.env.ZB_DATA_DIR = TMP;

const Snapshot = require('../research/source-snapshot.js');
const Extract = require('../research/evidence-extract.js');
const EvidenceStore = require('../research/evidence-store.js');
const FactStore = require('../research/fact-store.js');
const Diff = require('../research/price-diff.js');
const DomainEvent = require('../research/domain-event.js');
const als = require('../core/als.js');
const logger = require('../services/logger.js');
for (const k of ['debug', 'info', 'warn', 'error']) logger[k] = () => {};

const { DATA } = require('../core/paths.js');
const TA = 'tenant:p0trav-a';
const TB = 'tenant:p0trav-b';
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}

// ---- 造数助手（与 price-diff.test.js 同一链路：快照→证据→事实→diff→事件）----
const PRODUCTS_A = JSON.stringify({
  products: [{ id: 1, handle: 'demo-product', title: 'Demo Product', product_type: 'Figures',
    variants: [{ id: 11, title: 'Standard', price: '39.00' }] }],
});
const PRODUCTS_B = JSON.stringify({
  products: [{ id: 1, handle: 'demo-product', title: 'Demo Product', product_type: 'Figures',
    variants: [{ id: 11, title: 'Standard', price: '29.00' }] }],
});
function recScan(tenantId, body, observedAt) {
  const r = Snapshot.record({
    tenantId, capability: 'product_catalog', provider: 'shopify_products_json',
    source_url: 'https://example-shop.com/products.json?limit=100',
    source_status: 'success', error_code: null, observed_at: observedAt,
    bodyBytes: Buffer.from(body), partial_scan: null, partial_scan_reason: null,
    partial_scan_observed_count: null, note: null,
  });
  assert.equal(r.recorded, true);
  return r.meta;
}
function factFromScan(tenantId, body, observedAt) {
  const snap = recScan(tenantId, body, observedAt);
  const evRes = Extract.extractShopifyPriceEvidence({ tenantId, snapshotId: snap.snapshot_id });
  assert.equal(evRes.ok, true && !evRes.unavailable);
  const fr = FactStore.recordPriceFactFromEvidence({ tenantId, evidenceId: evRes.evidence_ids[0] });
  assert.equal(fr.recorded, true);
  return { fact: fr.meta, snapshot: snap, evidenceId: evRes.evidence_ids[0] };
}

// 真值链种子（租户 A）：39 → 29 全链落盘
const chainA1 = factFromScan(TA, PRODUCTS_A, '2026-10-07T09:00:00.000Z');
const chainA2 = factFromScan(TA, PRODUCTS_B, '2026-10-07T11:00:00.000Z');
const diffRes = Diff.diffPriceFacts({ tenantId: TA, oldFactId: chainA1.fact.fact_id, newFactId: chainA2.fact.fact_id });
assert.equal(diffRes.recorded, true);
const evtRes = DomainEvent.recordPriceChangeEvent({ tenantId: TA, diffId: diffRes.meta.diff_id });
assert.equal(evtRes.recorded, true);
const LEGIT_EVENT_ID = evtRes.meta.event_id;
const LEGIT_EVIDENCE_ID = chainA1.evidenceId;

// ---- 跨租户 victim 文件（租户 B 目录下真实存在，含标记内容）----
const victimDir = path.join(DATA, 'evidence', 'tenant_p0trav-b');
fs.mkdirSync(victimDir, { recursive: true });
const VICTIM_MARKER = '{"secret":"tenant-b-victim"}';
fs.writeFileSync(path.join(victimDir, 'ev_victim.json'), VICTIM_MARKER);
// victim 的 8.3 / 变体位置（穿越目标均指向它）
const TRAVERSAL_TARGETS = [
  '../../evidence/tenant_p0trav-b/ev_victim',            // ../ 穿越（题面复现输入同型）
  '..%2F..%2Fevidence%2Ftenant_p0trav-b%2Fev_victim',    // URL 编码后的 ../（字面量——存储层按非法字符拒绝）
  '..\\..\\evidence\\tenant_p0trav-b\\ev_victim',        // Windows 反斜杠穿越
  'C:\\Windows\\ev_victim',                              // 盘符绝对路径
  '/etc/passwd',                                          // POSIX 绝对路径
  '....//....//evidence/tenant_p0trav-b/ev_victim',      // 双点+斜杠变体
  'ev_x/../../../evidence/tenant_p0trav-b/ev_victim',    // 混合合法前缀+穿越
];

// ============ 1. Evidence 存储层：全部穿越输入 → null，victim 文件绝不被读出 ============
t('1. Evidence store: all traversal ids -> null, victim file NOT readable', () => {
  for (const bad of TRAVERSAL_TARGETS) {
    const out = EvidenceStore.getEvidenceById(TA, bad);
    assert.equal(out, null, 'traversal id must return null: ' + bad);
    if (out) assert.equal(JSON.stringify(out).includes('tenant-b-victim'), false);
  }
});
t('1b. Evidence store: legal id still readable (zero regression)', () => {
  const ev = EvidenceStore.getEvidenceById(TA, LEGIT_EVIDENCE_ID);
  assert.ok(ev && ev.evidence_id === LEGIT_EVIDENCE_ID);
});

// ============ 2. Event 存储层路径穿越 ============
t('2. Event store: traversal ids -> null', () => {
  for (const bad of TRAVERSAL_TARGETS) {
    assert.equal(DomainEvent.getEventById(TA, bad), null, 'event traversal: ' + bad);
  }
  assert.ok(DomainEvent.getEventById(TA, LEGIT_EVENT_ID));
});

// ============ 3. Fact / Diff / Snapshot 存储层路径穿越 ============
t('3. Fact store: traversal ids -> null; legal id readable', () => {
  for (const bad of TRAVERSAL_TARGETS) {
    assert.equal(FactStore.getFactById(TA, bad), null, 'fact traversal: ' + bad);
  }
  assert.ok(FactStore.getFactById(TA, chainA1.fact.fact_id));
});
t('3b. Diff store: traversal ids -> null; legal id readable', () => {
  for (const bad of TRAVERSAL_TARGETS) {
    assert.equal(Diff.getDiffById(TA, bad), null, 'diff traversal: ' + bad);
  }
  assert.ok(Diff.getDiffById(TA, diffRes.meta.diff_id));
});
t('3c. Snapshot store: traversal ids -> null; legal id readable', () => {
  for (const bad of TRAVERSAL_TARGETS) {
    assert.equal(Snapshot.getById(TA, bad), null, 'snapshot traversal: ' + bad);
  }
  assert.ok(Snapshot.getById(TA, chainA1.snapshot.snapshot_id));
});

// ============ 4. URL 解码后的 ../（searchParams 自动解码场景） ============
t('4. URL-decoded ../ rejected at storage layer', () => {
  const decoded = decodeURIComponent('..%2F..%2Fevidence%2Ftenant_p0trav-b%2Fev_victim');
  assert.equal(decoded, '../../evidence/tenant_p0trav-b/ev_victim');
  assert.equal(EvidenceStore.getEvidenceById(TA, decoded), null);
  assert.equal(DomainEvent.getEventById(TA, decoded), null);
  assert.equal(FactStore.getFactById(TA, decoded), null);
  assert.equal(Diff.getDiffById(TA, decoded), null);
  assert.equal(Snapshot.getById(TA, decoded), null);
});

// ============ 5. 租户隔离：A 无法用合法 ID 读 B 的数据 ============
t('5. Tenant isolation: legal ids of A invisible to B', () => {
  assert.equal(EvidenceStore.getEvidenceById(TB, LEGIT_EVIDENCE_ID), null);
  assert.equal(DomainEvent.getEventById(TB, LEGIT_EVENT_ID), null);
  assert.equal(FactStore.getFactById(TB, chainA1.fact.fact_id), null);
  assert.equal(Diff.getDiffById(TB, diffRes.meta.diff_id), null);
  assert.equal(Snapshot.getById(TB, chainA1.snapshot.snapshot_id), null);
});

// ============ 6. API 层：非法 id → 400 INVALID_ID；合法不存在 → 404 ============
function mkCtx() {
  const sent = [];
  return { sent, ctx: { sendJSON: (res, code, obj) => { sent.push({ code, obj }); return obj; }, loadConfig: () => ({}) } };
}
async function callHandler(fn, id, query, method) {
  const { sent, ctx } = mkCtx();
  const u = new URL('http://x' + query + encodeURIComponent(id));
  await als.requestScope.run(TA, async () => { await fn(ctx, { method: method || 'GET' }, {}, u, new URL(u).pathname); });
  return sent[sent.length - 1];
}
const Demo = require('../routes/handlers/demo.js');
(async () => {
  // event-detail
  let r = await callHandler(Demo.eventDetail, '../../evidence/tenant_p0trav-b/ev_victim', '/api/demo/event-detail?id=');
  t('6a. API event-detail: traversal id -> 400 INVALID_ID', () => {
    assert.equal(r.code, 400);
    assert.equal(r.obj.error, 'INVALID_ID');
  });
  r = await callHandler(Demo.eventDetail, encodeURIComponent('../../evidence/tenant_p0trav-b/ev_victim'), '/api/demo/event-detail?id=');
  t('6b. API event-detail: URL-encoded traversal -> 400 INVALID_ID (searchParams auto-decodes)', () => {
    assert.equal(r.code, 400);
    assert.equal(r.obj.error, 'INVALID_ID');
  });
  r = await callHandler(Demo.eventDetail, 'C:\\Windows\\ev_victim', '/api/demo/event-detail?id=');
  t('6c. API event-detail: drive-letter absolute path -> 400 INVALID_ID', () => {
    assert.equal(r.code, 400);
    assert.equal(r.obj.error, 'INVALID_ID');
  });
  r = await callHandler(Demo.eventDetail, 'evt_missing0000000000xx', '/api/demo/event-detail?id=');
  t('6d. API event-detail: legal-but-missing id -> 404 (not 400)', () => {
    assert.equal(r.code, 404);
    assert.equal(r.obj.error, 'NOT_FOUND');
  });
  // evidence-detail
  r = await callHandler(Demo.evidenceDetail, '..\\..\\evidence\\tenant_p0trav-b\\ev_victim', '/api/demo/evidence-detail?id=');
  t('6e. API evidence-detail: Windows ..\\ traversal -> 400 INVALID_ID', () => {
    assert.equal(r.code, 400);
    assert.equal(r.obj.error, 'INVALID_ID');
  });
  // ai-interpretation：非法 id 必须 400，且绝不触发 LLM 调用
  {
    const LLM = require('../services/llm-gateway.js');
    const origCall = LLM.call;
    LLM.call = async () => { throw new Error('LLM must NOT be called for invalid id'); };
    try {
      r = await callHandler(Demo.aiInterpretation, '../../evidence/tenant_p0trav-b/ev_victim', '/api/demo/ai-interpretation?id=', 'POST');
    } finally { LLM.call = origCall; }
    t('6f. API ai-interpretation: traversal id -> 400 INVALID_ID, LLM never invoked', () => {
      assert.equal(r.code, 400);
      assert.equal(r.obj.error, 'INVALID_ID');
    });
  }
  // 合法 id 正常 200（零回归）
  {
    const { sent, ctx } = mkCtx();
    let code = 0, body = null;
    await als.requestScope.run(TA, async () => {
      await Demo.eventDetail(ctx, { method: 'GET' }, {}, new URL('http://x/api/demo/event-detail?id=' + LEGIT_EVENT_ID), '/api/demo/event-detail');
    });
    code = sent[sent.length - 1].code; body = sent[sent.length - 1].obj;
    t('6g. API event-detail: legal id -> 200 (zero regression)', () => {
      assert.equal(code, 200);
      assert.equal(body.event.event_id, LEGIT_EVENT_ID);
    });
    // ============ 7. P2：API 响应不暴露内部文件路径 ============
    t('7a. P2: event-detail response contains NO raw_payload_ref', () => {
      assert.equal(JSON.stringify(body).includes('raw_payload_ref'), false);
    });
    let code2 = 0, body2 = null;
    await als.requestScope.run(TA, async () => {
      await Demo.evidenceDetail(ctx, { method: 'GET' }, {}, new URL('http://x/api/demo/evidence-detail?id=' + LEGIT_EVIDENCE_ID), '/api/demo/evidence-detail');
    });
    code2 = sent[sent.length - 1].code; body2 = sent[sent.length - 1].obj;
    t('7b. P2: evidence-detail response contains NO raw_payload_ref, keeps traceability fields', () => {
      assert.equal(code2, 200);
      const s = JSON.stringify(body2);
      assert.equal(s.includes('raw_payload_ref'), false);
      assert.ok(s.includes('content_hash') && s.includes('collector_version') && s.includes('source_status'),
        'traceability fields (content_hash/collector_version/source_status) must survive');
      assert.ok(body2.evidence.evidence_id === LEGIT_EVIDENCE_ID);
    });
    // 存储层 raw_payload_ref 原样保留（仅 API 层过滤）
    t('7c. P2: storage layer still keeps raw_payload_ref internally', () => {
      const raw = EvidenceStore.getEvidenceById(TA, LEGIT_EVIDENCE_ID);
      assert.ok(raw.provenance && raw.provenance.snapshots.length >= 1);
      assert.ok(raw.provenance.snapshots[0].raw_payload_ref && raw.provenance.snapshots[0].raw_payload_ref.path);
    });
  }

  console.log('\npath-traversal.test: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL - ' + String(e.stack || e).split('\n').slice(0, 4).join('\n')); process.exit(1); });
