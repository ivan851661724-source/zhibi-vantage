'use strict';
// ============================================================
// ui-framework.test.js —— UI 框架轮行为回归（SC-04 review/core-product-ui-framework）
//   U1 情报项带 competitorId（纠错弹窗定位依赖）
//   U2 时间线 monitor 事件透出 payload.evidenceIds（证据可追溯）
//   U3 机会视图 dimensionBasis：已接入/建设中/实际有数据维度构成，未接入四维必须如实
//   U4 报告列表透出 retryCount（自动重试中可见）；恢复后 generatedBy=llm
//   U5 结构化回退落库 generatedBy=structured-fallback（前端「结构化事实版本」标记依据）
//   U6 前后端契约：报告章节码集与覆盖状态枚举两端一致（防漂移）
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-ui-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.ZB_REPORT_CLAIM_TTL_MS = '3000';

const db = require('../services/db.js');
const BrandStore = require('../services/brand-store.js');
const BrandSvc = require('../services/brand-service.js');
const ReportSvc = require('../services/report-service.js');
const Report = require('../research/report.js');
const Registry = require('../services/capability-registry.js');
const SurfaceStore = require('../services/surface-store.js');
const Snapshot = require('../research/source-snapshot.js');
const EvidenceStore = require('../research/evidence-store.js');
const { saveState, projFile } = require('../core/state-store.js');

const TID = 'tenant:uiA', PID = 'projUiA';
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
}
function mkSnapshot(tid, url, body, extra) {
  const r = Snapshot.record(Object.assign({
    capability: 'product_catalog', provider: 'shopify_products_json', source_url: url,
    final_url: url, redirect_hops: 0, http_status: 200, source_status: 'success',
    observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
    bodyBytes: Buffer.from(body), contentType: 'application/json', trigger: 'manual', tenantId: tid,
  }, extra || {}));
  assert.ok(r.recorded, 'snapshot recorded');
  return r.meta;
}
function pageBody(ids) {
  return JSON.stringify({ products: ids.map(id => ({ id, title: 'P' + id, product_type: 'x', variants: [{ price: String(id * 10), available: true }] })) });
}

(async () => {
  // ---------- 环境搭建：项目 + 单品牌 + 一次成功采集 ----------
  db.createTenant({ name: 'cuiA', email: 'uiA@example.com' });
  db.saveProject({ id: PID, tenantId: TID, track: 'T-UI', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(PID, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({ projectId: PID, tenantId: TID, track: 'T-UI', discoveredAt: new Date().toISOString(), intent: { regions: ['us'], category: 'toys' }, competitors: [{ id: 'compU1', name: 'UiBrand', status: 'done', url: 'https://uiu.example.com', isShopify: true }] });
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));
  BrandSvc.syncProjectBrands(TID, PID);

  const bid = BrandStore.brandIdForCompetitor(TID, PID, 'compU1');
  assert.ok(bid, '品牌档案已生成');

  const p1 = mkSnapshot(TID, 'https://uiu.example.com/products.json?limit=250&page=1', pageBody([1, 2, 3]));
  const cart = mkSnapshot(TID, 'https://uiu.example.com/cart.js', JSON.stringify({ currency: 'USD' }),
    { capability: 'storefront_currency', provider: 'shopify_cart_js_json' });
  const ev = EvidenceStore.recordEvidence({
    tenantId: TID, projectRef: PID, brandHint: 'UiBrand', source: 'shopify', provider: 'shopify_products_json',
    source_snapshot_ids: [p1.snapshot_id, cart.snapshot_id],
    claim: { field: 'catalog.observation', scope: 'public_catalog_observation' },
    entity_key: 'uiu.example.com', entity_ref: { kind: 'storefront_domain', domain: 'uiu.example.com' },
    extracted_value: { summaryKind: 'storefront_catalog', count: 3, onSaleCount: 3, priceMin: 10, priceMax: 30, priceMedian: 20, currency: 'USD', partialScan: false },
    unit: null, currency: 'USD', market: null, evidence_status: 'verified',
    parser_version: 'shopify-adapter-1', extractor_version: 'shopify-adapter-1',
    observed_at: p1.observed_at, note: 'ui fixture',
  });
  const mk = SurfaceStore.createAttempt({ tenantId: TID, projectId: PID, competitorId: 'compU1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'ui-att-1', nowMs: Date.now() });
  SurfaceStore.completeAttempt(TID, mk.attempt.attemptId, {
    status: 'success', sourceStatus: 'success',
    observations: [{ id: '1', title: 'P1', price: 10, currency: 'USD', available: true, publishedAt: null }],
    snapshotIds: [p1.snapshot_id, cart.snapshot_id], evidenceIds: [ev.meta.evidence_id],
    summary: { kind: 'storefront_catalog', count: 3, onSaleCount: 3, soldOutCount: 0, priceMin: 10, priceMax: 30, priceMedian: 20, currency: 'USD', currencyStatus: 'confirmed' },
    endedAt: new Date().toISOString(),
  });
  BrandSvc.rebuildTimeline(TID, bid, PID, BrandSvc.findCompetitor(BrandSvc.loadProjectState(TID, PID), 'compU1'));

  await t('U1 情报项带 competitorId（纠错入口可定位品牌字段）', async () => {
    const items = BrandSvc.listIntelligence(TID, { projectId: PID }).filter(i => i.type !== 'gap');
    assert.ok(items.length >= 1, '有采集类情报项');
    for (const it of items) assert.strictEqual(it.competitorId, 'compU1', 'competitorId 透出');
  });

  await t('U2 时间线采集事件透出证据 ID（可追溯，不伪造「已核实」）', async () => {
    const tl = BrandSvc.timelineView(TID, bid, {});
    const mon = tl.find(e => e.kind === 'monitor' && e.status === 'verified');
    assert.ok(mon, '有已核实 monitor 事件');
    assert.ok(Array.isArray(mon.payload && mon.payload.evidenceIds) && mon.payload.evidenceIds.length >= 1, 'payload.evidenceIds 非空');
  });

  await t('U3 机会视图 dimensionBasis：已接入/建设中/实际有数据，未接入四维如实', async () => {
    const v = ReportSvc.buildOpportunities(TID, PID);
    assert.ok(v.dimensionBasis, 'dimensionBasis 透出');
    const db = v.dimensionBasis;
    assert.ok(db.integrated.length >= 1, '已接入维度非空');
    for (const name of ['社媒内容', '广告活动', '口碑与评论', '搜索与热度']) {
      // Wave 1：四维为 pending_config——「需要系统数据服务配置」单列（≠未接入）
      assert.ok((db.pendingConfig || []).includes(name), `「${name}」必须在需要配置名单`);
      assert.ok(!db.integrated.includes(name), `「${name}」不得出现在已接入名单`);
    }
    assert.ok(db.covered.includes('商品目录') || db.covered.length >= 1, '采集后有实际数据维度');
    // 建设中维度不得计入已接入（评审判据：不把未接入伪装成覆盖）
    assert.ok(v.limits.some(l => /需要系统数据服务配置/.test(l)), 'limits 保留需要配置声明（Wave 1 语义）');
  });

  await t('U4 报告自动重试进度透出（列表「自动重试中」依据）；恢复后 generatedBy=llm', async () => {
    const req = ReportSvc.requestReport(TID, PID, {}, null);
    assert.ok(req, '报告已受理');
    const orig = Report.buildReportFromPack;
    Report.buildReportFromPack = async () => { throw new Error('ui-test injected failure'); };
    try {
      await ReportSvc.tick(); // 第一次失败 → requeue retry=1
      const list1 = ReportSvc.listReportViews(TID, PID);
      const r1 = list1.find(x => x.reportId === req.report.reportId);
      assert.ok(r1, '列表含该报告');
      assert.strictEqual(r1.status, 'queued', '重试期间保持 queued');
      assert.ok((r1.retryCount || 0) >= 1, 'retryCount 透出（自动重试中依据）');
      assert.ok(/重试/.test(r1.errorText || ''), 'errorText 说明重试');
      // 恢复后第二次 tick 成功
      Report.buildReportFromPack = async () => ({ markdown: '# t', structured: false, audit: { source: 'frozen-pack' }, qc: null });
      await ReportSvc.tick();
      const v = ReportSvc.getReportView(TID, req.report.reportId);
      assert.strictEqual(v.status, 'success');
      assert.strictEqual(v.generatedBy, 'llm', 'LLM 路径标记 llm');
    } finally { Report.buildReportFromPack = orig; }
  });

  await t('U5 结构化回退落库 generatedBy=structured-fallback（诚实标记依据）', async () => {
    const req = ReportSvc.requestReport(TID, PID, {}, null);
    assert.ok(req, '报告已受理');
    const orig = Report.buildReportFromPack;
    Report.buildReportFromPack = async () => ({ markdown: '# s', structured: true, audit: { source: 'frozen-pack' }, qc: null });
    try {
      await ReportSvc.tick();
      const v = ReportSvc.getReportView(TID, req.report.reportId);
      assert.strictEqual(v.status, 'success');
      assert.strictEqual(v.generatedBy, 'structured-fallback', '结构化回退必须如实标记');
    } finally { Report.buildReportFromPack = orig; }
  });

  await t('U6 前后端契约：章节码集与覆盖状态枚举两端一致', async () => {
    const logicTs = fs.readFileSync(path.join(__dirname, '../../web/src/lib/core-logic.ts'), 'utf8');
    const apiTs = fs.readFileSync(path.join(__dirname, '../../web/src/lib/core-api.ts'), 'utf8');
    // 章节码集：后端 REPORT_ALL_SECTIONS === 前端 REPORT_SECTIONS
    const feSections = [...logicTs.matchAll(/code: '([a-z]+)'/g)].map(m => m[1]).sort();
    assert.deepStrictEqual(feSections, [...Report.REPORT_ALL_SECTIONS].sort(), '报告章节码集两端一致');
    // 覆盖状态枚举：后端 dimensionCoverage 可能产出的 state ⊆ 前端 COVER_STATE_TEXT 键
    const keys = ['ok', 'partial', 'empty', 'stale', 'loading', 'failed', 'unsupported', 'pending_config', 'unknown'];
    for (const k of keys) assert.ok(new RegExp(`${k}: '`).test(apiTs), `COVER_STATE_TEXT 缺少 ${k}`);
    const cov = BrandSvc.buildCoverage(TID, PID, BrandSvc.findCompetitor(BrandSvc.loadProjectState(TID, PID), 'compU1'));
    for (const d of cov.dimensions) assert.ok(keys.includes(d.state), `未知覆盖状态 ${d.state}`);
  });

  console.log(`\nUI-FRAMEWORK RESULT: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
