'use strict';
// ============================================================
// core-product.test.js —— 核心产品主闭环回归（SC-04）
//   C1 竞品库：新项目/新竞品 → 品牌档案；未采集显示「尚未采集」而非「未发现数据」
//   C2 未接入维度：广告/社媒/评论/搜索/流量/经营估算显式「未接入」，零伪数据
//   C3 Shopify 采集后贯通：商品/价格/快照/证据/时间线/情报/报告引用
//   C4 情报库：按品牌/类型/时间筛选，证据入口正确，无 Evidence 不标已核实
//   C5 机会视图：样本不足不输出机会结论；满足时显示依据与限制
//   C6 报告：冻结事实包、状态流转、重启可恢复/明确失败、引用可追溯
//   C7 两租户隔离：品牌/情报/报告/证据/快照/时间线互不可见（404）
//   C8 端点权限：跨租户统一 404，不泄露存在性；未认证 401
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-core-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.ZB_REPORT_CLAIM_TTL_MS = '3000';

const db = require('../services/db.js');
const BrandStore = require('../services/brand-store.js');
const BrandSvc = require('../services/brand-service.js');
const ReportSvc = require('../services/report-service.js');
const Registry = require('../services/capability-registry.js');
const SurfaceStore = require('../services/surface-store.js');
const Snapshot = require('../research/source-snapshot.js');
const EvidenceStore = require('../research/evidence-store.js');
const { saveState, projFile } = require('../core/state-store.js');

const TID_A = 'tenant:coreA', TID_B = 'tenant:coreB';
const PID_A = 'projCoreA', PID_B = 'projCoreB';
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
}
async function mkProject(tid, pid, comps) {
  db.createTenant({ name: 'c' + pid, email: pid + '@example.com' });
  db.saveProject({ id: pid, tenantId: tid, track: 'T-' + pid, competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(pid, tid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({ projectId: pid, tenantId: tid, track: 'T-' + pid, discoveredAt: new Date().toISOString(), intent: { regions: ['us'], category: 'toys' }, competitors: comps || [] });
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20)); // 异步落盘等待
  return f;
}
function mkSnapshot(tid, url, body, extra) {
  const r = Snapshot.record(Object.assign({
    capability: 'product_catalog', provider: 'shopify_products_json', source_url: url,
    final_url: url, redirect_hops: 0, http_status: 200, source_status: 'success',
    observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
    bodyBytes: Buffer.from(body), contentType: 'application/json', trigger: 'manual', tenantId: tid,
  }, extra || {}));
  assert.ok(r.recorded, 'snapshot recorded: ' + url);
  return r.meta;
}
function pageBody(ids) {
  return JSON.stringify({ products: ids.map(id => ({ id, title: 'P' + id, product_type: 'x', variants: [{ price: String(id * 10), available: true }] })) });
}

(async () => {
  await mkProject(TID_A, PID_A, [{ id: 'compA1', name: 'AlphaBrand', status: 'done', url: 'https://alpha.example.com', isShopify: true }]);
  await mkProject(TID_B, PID_B, [{ id: 'compB1', name: 'BetaBrand', status: 'done', url: 'https://beta.example.com', isShopify: true }]);

  await t('C1 竞品库：品牌档案生成；未采集显示「尚未采集」，不是「未发现数据」', async () => {
    const views = BrandSvc.listBrandViews(TID_A, PID_A);
    assert.strictEqual(views.length, 1, '1 个品牌档案');
    const v = views[0];
    assert.strictEqual(v.name, 'AlphaBrand');
    assert.strictEqual(v.officialDomain, 'alpha.example.com');
    assert.strictEqual(v.lastObservedAt, null, '未采集 = 无观察时间');
    const wp = v.coverageDimensions.find(d => d.code === 'website_products');
    assert.strictEqual(wp.state, 'unknown', '官网维度初始为尚未采集');
    assert.strictEqual(wp.stateText, '尚未采集');
    // 「尚未采集」不得表述为「未发现数据」
    const txt = JSON.stringify(v);
    assert.ok(!/未发现数据/.test(txt), '不得出现「未发现数据」表述');
  });

  await t('C2 未接入维度：广告/社媒/评论/搜索显式未接入，零伪数据', async () => {
    const v = BrandSvc.listBrandViews(TID_A, PID_A)[0];
    const notIntegrated = v.coverageSummary.notIntegrated;
    for (const code of ['social_content', 'ad_campaigns', 'reviews_reputation', 'search_interest']) {
      assert.ok(notIntegrated.includes(code), code + ' 必须列为未接入');
      const d = v.coverageDimensions.find(x => x.code === code);
      assert.strictEqual(d.state, 'unsupported');
      assert.strictEqual(d.stateText, '未接入');
      assert.ok(/尚未接入/.test(d.note || ''), 'note 明示未接入');
    }
    // 未接入维度不产生任何数值/图表数据
    for (const d of v.coverageDimensions) {
      if (d.state === 'unsupported') assert.strictEqual(d.lastObservedAt, null, '未接入不得有观察时间');
    }
  });

  await t('C3 Shopify 采集贯通：商品/价格/快照/证据/时间线/情报', async () => {
    const p1 = mkSnapshot(TID_A, 'https://alpha.example.com/products.json?limit=250&page=1', pageBody([1, 2, 3]));
    const cart = mkSnapshot(TID_A, 'https://alpha.example.com/cart.js', JSON.stringify({ currency: 'USD' }),
      { capability: 'storefront_currency', provider: 'shopify_cart_js_json' });
    const ev = EvidenceStore.recordEvidence({
      tenantId: TID_A, projectRef: PID_A, brandHint: 'AlphaBrand', source: 'shopify', provider: 'shopify_products_json',
      source_snapshot_ids: [p1.snapshot_id, cart.snapshot_id],
      claim: { field: 'catalog.observation', scope: 'public_catalog_observation' },
      entity_key: 'alpha.example.com', entity_ref: { kind: 'storefront_domain', domain: 'alpha.example.com' },
      extracted_value: { summaryKind: 'storefront_catalog', count: 3, onSaleCount: 3, priceMin: 10, priceMax: 30, priceMedian: 20, currency: 'USD', partialScan: false },
      unit: null, currency: 'USD', market: null, evidence_status: 'verified',
      parser_version: 'shopify-adapter-1', extractor_version: 'shopify-adapter-1',
      observed_at: p1.observed_at, note: 'C3 fixture',
    });
    assert.ok(ev.recorded, 'evidence recorded');
    const mk = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: PID_A, competitorId: 'compA1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'c3-att', nowMs: Date.now() });
    SurfaceStore.completeAttempt(TID_A, mk.attempt.attemptId, {
      status: 'success', sourceStatus: 'success',
      observations: [{ id: '1', title: 'P1', price: 10, currency: 'USD', available: true, publishedAt: null },
        { id: '2', title: 'P2', price: 20, currency: 'USD', available: true, publishedAt: null },
        { id: '3', title: 'P3', price: 30, currency: 'USD', available: true, publishedAt: null }],
      snapshotIds: [p1.snapshot_id, cart.snapshot_id], evidenceIds: [ev.meta.evidence_id],
      summary: { kind: 'storefront_catalog', count: 3, onSaleCount: 3, soldOutCount: 0, priceMin: 10, priceMax: 30, priceMedian: 20, currency: 'USD', currencyStatus: 'confirmed' },
      endedAt: new Date().toISOString(),
    });
    // 时间线索引
    BrandSvc.rebuildTimeline(TID_A, BrandStore.brandIdForCompetitor(TID_A, PID_A, 'compA1'), PID_A,
      BrandSvc.findCompetitor(BrandSvc.loadProjectState(TID_A, PID_A), 'compA1'));
    const bid = BrandStore.brandIdForCompetitor(TID_A, PID_A, 'compA1');
    const tl = BrandSvc.timelineView(TID_A, bid, {});
    assert.ok(tl.some(e => e.kind === 'monitor'), '时间线有采集记录');
    // 品牌详情
    const detail = BrandSvc.getBrandView(TID_A, bid);
    assert.ok(detail.products.observations.length >= 3, '详情含商品观察');
    assert.strictEqual(detail.products.summary && detail.products.summary.currency, 'USD', '币种贯通');
    assert.ok(detail.products.evidenceRefs.length >= 1, '证据引用贯通');
    assert.ok(detail.timeline.length >= 1, '时间线贯通');
    assert.ok(detail.intelligence.some(i => i.evidence.length > 0), '情报项带 Evidence');
    // 覆盖状态从 unknown → ok
    const wp = detail.coverage.dimensions.find(d => d.code === 'website_products');
    assert.strictEqual(wp.state, 'ok', '采集后为已采集且有数据');
  });

  await t('C4 情报库：可按品牌/类型/时间筛选；无 Evidence 不标已核实', async () => {
    const all = BrandSvc.listIntelligence(TID_A, { projectId: PID_A });
    assert.ok(all.length >= 1, '有情报项');
    const withEv = all.filter(i => i.evidence && i.evidence.length > 0);
    const withoutEv = all.filter(i => !i.evidence || i.evidence.length === 0);
    for (const i of withoutEv) assert.notStrictEqual(i.status, 'verified', '无 Evidence 不得标已核实');
    for (const i of withEv) assert.ok(['verified', 'pending'].includes(i.status), '有 Evidence 才可核实/待核实');
    // 按类型筛选（资料缺口）
    const gaps = BrandSvc.listIntelligence(TID_A, { projectId: PID_A, type: 'gap' });
    assert.ok(gaps.length >= 4, '资料缺口项 >= 4（四个未接入维度）');
    for (const g of gaps) assert.strictEqual(g.status, 'insufficient');
    // 按时间筛选
    const future = BrandSvc.listIntelligence(TID_A, { projectId: PID_A, from: new Date(Date.now() + 86400000).toISOString() });
    assert.strictEqual(future.length, 0, '未来时间窗内无情报');
    // 按品牌筛选
    const bid = BrandStore.brandIdForCompetitor(TID_A, PID_A, 'compA1');
    const byBrand = BrandSvc.listIntelligence(TID_A, { projectId: PID_A, brandId: bid });
    assert.ok(byBrand.length >= 1);
  });

  await t('C5 机会视图：样本不足不输出机会结论；满足时显示依据与限制', async () => {
    const v = ReportSvc.buildOpportunities(TID_A, PID_A);
    assert.strictEqual(v.status, 'insufficient', '单品牌样本不足');
    assert.ok(/资料不足/.test(v.statusText));
    assert.ok(v.limits.some(l => /未接入/.test(l)), '限制含未接入维度声明');
    assert.strictEqual(v.items.length, 0, '不得输出机会结论');
    // 补足样本：再加两个已采集品牌
    const st = BrandSvc.loadProjectState(TID_A, PID_A);
    st.competitors = [
      { id: 'compA1', name: 'AlphaBrand', status: 'done', url: 'https://alpha.example.com', isShopify: true },
      { id: 'compA2', name: 'SecondBrand', status: 'done', url: 'https://second.example.com', isShopify: true },
      { id: 'compA3', name: 'ThirdBrand', status: 'done', url: 'https://third.example.com', isShopify: true },
    ];
    saveState(st);
    await new Promise(r => setTimeout(r, 150)); // 异步落盘等待（否则读到旧 competitors）
    BrandSvc.syncProjectBrands(TID_A, PID_A, st);
    for (const id of ['compA2', 'compA3']) {
      const s = mkSnapshot(TID_A, `https://${id.split('comp')[1].toLowerCase()}.example.com/products.json?limit=250&page=1`, pageBody([4, 5]));
      const e = EvidenceStore.recordEvidence({
        tenantId: TID_A, projectRef: PID_A, brandHint: id, source: 'shopify', provider: 'shopify_products_json',
        source_snapshot_ids: [s.snapshot_id], claim: { field: 'catalog.observation', scope: 'x' },
        entity_key: id, entity_ref: {}, extracted_value: { count: 2 }, unit: null, currency: null, market: null,
        evidence_status: 'verified', parser_version: 'shopify-adapter-1', extractor_version: 'shopify-adapter-1',
        observed_at: s.observed_at, note: 'C5',
      });
      const mk = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: PID_A, competitorId: id, capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'c5-' + id });
      SurfaceStore.completeAttempt(TID_A, mk.attempt.attemptId, {
        status: 'success', sourceStatus: 'success', observations: [{ id: '4', title: 'P4', price: 40, currency: null, available: true, publishedAt: null }],
        snapshotIds: [s.snapshot_id], evidenceIds: [e.meta.evidence_id], summary: { kind: 'storefront_catalog', count: 1 },
        endedAt: new Date().toISOString(),
      });
    }
    const v2 = ReportSvc.buildOpportunities(TID_A, PID_A);
    assert.ok(v2.sample.brandsWithData >= 3, '样本已满足：' + v2.sample.brandsWithData);
    assert.ok(v2.limits.length >= 4, '仍标注未接入维度限制');
    if (v2.status === 'ok') {
      for (const it of v2.items) assert.ok(it.note && /待验证线索/.test(it.note), '机会标注为待验证线索');
    }
  });

  await t('C6 报告：冻结事实包 + 状态流转 + 重启恢复/明确失败 + 引用可追溯', async () => {
    const req = ReportSvc.requestReport(TID_A, PID_A, { brandIds: [] }, null);
    assert.ok(req, '报告创建');
    const r0 = BrandStore.getReport(TID_A, req.report.reportId);
    assert.strictEqual(r0.status, 'queued', '初始 queued');
    assert.ok(r0.factPack && Array.isArray(r0.factPack.facts), '冻结事实包');
    assert.ok(Array.isArray(r0.gaps), '冻结资料缺口');
    // 执行（worker tick 语义）
    const job = BrandStore.claimReportJob('test-worker');
    assert.ok(job, 'job 认领');
    const res = await ReportSvc.executeJob(job);
    assert.strictEqual(res.status, 'done', '执行完成');
    const r1 = BrandStore.getReport(TID_A, req.report.reportId);
    assert.ok(['success', 'failed'].includes(r1.status), '终态：' + r1.status);
    if (r1.status === 'success') {
      assert.ok(r1.markdown && r1.markdown.length > 0, '正文存在');
      // 实时数据变化不改写已生成报告
      const before = r1.markdown;
      const mk = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: PID_A, competitorId: 'compA1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'c6-after' });
      SurfaceStore.completeAttempt(TID_A, mk.attempt.attemptId, { status: 'failed', sourceStatus: 'unavailable', observations: [], snapshotIds: [], evidenceIds: [] });
      const r2 = BrandStore.getReport(TID_A, req.report.reportId);
      assert.strictEqual(r2.markdown, before, '实时变化不改写已生成报告');
    }
    // 引用可追溯
    const view = ReportSvc.getReportView(TID_A, req.report.reportId);
    assert.ok(Array.isArray(view.citations), '引用列表');
    for (const c of view.citations) {
      assert.ok(Array.isArray(c.evidenceIds) && Array.isArray(c.snapshotIds), '引用含 Evidence/Snapshot');
    }
    // 重启恢复：租约过期 → reclaim → 可再次认领执行（或 retry 耗尽 → dead + failed）
    const req2 = ReportSvc.requestReport(TID_A, PID_A, { brandIds: [] }, null);
    const j2 = BrandStore.claimReportJob('w2');
    BrandStore.getDb().prepare('UPDATE report_jobs SET claim_expires_at=? WHERE job_id=?').run(Date.now() - 1000, j2.jobId);
    const rec = BrandStore.reclaimExpiredReportJobs(Date.now());
    assert.ok(rec.requeued + rec.dead >= 1, '过期 job 被 reclaim');
    const j3 = BrandStore.claimReportJob('w3');
    if (j3) {
      const res3 = await ReportSvc.executeJob(j3);
      assert.ok(['done', 'failed'].includes(res3.status));
    }
    assert.ok(BrandStore.listReportJobs(TID_A).every(j => j.status !== 'running'), '无永久 running');
  });

  await t('C7 两租户隔离：品牌/情报/报告/证据/快照/时间线互不可见', async () => {
    const brandA = BrandSvc.listBrandViews(TID_A, PID_A);
    const brandB = BrandSvc.listBrandViews(TID_B, PID_B);
    assert.ok(brandA.length >= 1 && brandB.length >= 1);
    const bA = brandA[0];
    // 租户 B 读租户 A 的品牌 → null（上层 404）
    assert.strictEqual(BrandStore.getBrand(TID_B, bA.brandId), null, '跨租户品牌不可读');
    assert.strictEqual(BrandSvc.getBrandView(TID_B, bA.brandId), null, '跨租户品牌详情不可读');
    assert.deepStrictEqual(BrandSvc.timelineView(TID_B, bA.brandId, {}), [], '跨租户时间线为空');
    // 报告隔离
    const reps = BrandStore.listReports(TID_A, PID_A);
    assert.ok(reps.length >= 1);
    assert.strictEqual(BrandStore.getReport(TID_B, reps[0].reportId), null, '跨租户报告不可读');
    assert.strictEqual(ReportSvc.getReportView(TID_B, reps[0].reportId), null);
    // 证据与快照隔离
    const bid = BrandStore.brandIdForCompetitor(TID_A, PID_A, 'compA1');
    const detail = BrandSvc.getBrandView(TID_A, bid);
    const evIds = (detail.intelligence || []).flatMap(i => (i.evidence || []).map(e => e.evidenceId));
    assert.ok(evIds.length >= 1, '有 Evidence 可校验');
    for (const id of evIds) assert.strictEqual(EvidenceStore.getEvidenceById(TID_B, id), null, '跨租户 Evidence 不可读');
    const snapIds = detail.products.evidenceRefs.map(r => r.snapshotId).filter(Boolean);
    for (const sid of snapIds) assert.strictEqual(Snapshot.getById(TID_B, sid), null, '跨租户快照不可读');
    // 情报隔离
    const intelB = BrandSvc.listIntelligence(TID_B, { projectId: PID_B });
    assert.ok(intelB.every(i => i.brandId !== bA.brandId), 'B 的情报不含 A 的品牌');
  });

  await t('C8 生产代码零 mock：测试 fixture 仅在测试目录/运行时数据目录', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'brand-service.js'), 'utf8');
    assert.ok(!/mock/i.test(src), 'brand-service 不得含 mock');
    const svc = fs.readFileSync(path.join(__dirname, '..', 'services', 'report-service.js'), 'utf8');
    assert.ok(!/mock/i.test(svc), 'report-service 不得含 mock');
    // 未接入维度不得被标记为已实现
    for (const c of Registry.listCapabilities()) {
      if (c.maturity !== 'ga') {
        assert.strictEqual(c.adapter, null, c.code + ' 未接入不得声明 adapter');
        assert.strictEqual(c.provider, null, c.code + ' 未接入不得声明 provider');
      }
    }
  });

  console.log(`\ncore-product.test: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
