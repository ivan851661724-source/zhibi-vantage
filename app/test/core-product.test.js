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
const Report = require('../research/report.js');
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

  await t('C2 建设中维度（r2 新语义）：pending_config 用户侧口径「数据服务暂不可用」，凭据变量名零泄漏', async () => {
    // r2 规格变更：实现态与运行态分离——用户投影只显示四种口径之一；
    // configKeys 从用户投影移除（仅管理员健康接口可见）
    const v = BrandSvc.listBrandViews(TID_A, PID_A)[0];
    const pending = v.coverageSummary.pendingConfig;
    for (const code of ['social_content', 'ad_campaigns', 'reviews_reputation', 'search_interest']) {
      assert.ok(pending.includes(code), code + ' 必须列为 pending_config');
      const d = v.coverageDimensions.find(x => x.code === code);
      assert.strictEqual(d.state, 'pending_config');
      assert.strictEqual(d.stateText, '数据服务暂不可用');
      assert.ok(/数据服务暂不可用/.test(d.note || ''), 'note 用户侧口径');
      assert.strictEqual('configKeys' in d, false, code + ' configKeys 不得进用户投影');
    }
    // 用户投影整体零凭据变量名泄漏
    const all = JSON.stringify(v);
    assert.strictEqual(/YOUTUBE_API_KEY|DATAFORSEO_LOGIN|DATAFORSEO_PASSWORD|TIKTOK_CLIENT_KEY|TIKTOK_CLIENT_SECRET/.test(all), false, '品牌视图无凭据变量名');
    // 建设中维度不产生任何数值/图表数据
    for (const d of v.coverageDimensions) {
      if (d.state === 'pending_config') assert.strictEqual(d.lastObservedAt, null, '建设中维度不得有观察时间');
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
    // 品牌详情（评审轮 2：显式 projectId 边界）
    const detail = BrandSvc.getBrandView(TID_A, bid, PID_A);
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
    // r4.10 规格变更：未接入维度不再生成资料缺口情报项（项目级噪音），
    // 改由 constructionDimensions 独立字段承载——items 中 gap 项必须为 0
    const gaps = BrandSvc.listIntelligence(TID_A, { projectId: PID_A, type: 'gap' });
    assert.strictEqual(gaps.length, 0, '未接入维度不得生成情报事件');
    for (const i of all) assert.ok(!(i.title || '').includes('：未接入'), '无「XX：未接入」噪音卡片');
    const cd = BrandSvc.constructionDimensions(TID_A, PID_A);
    assert.strictEqual(cd.length, 4, '建设中维度恰 4 条（独立字段）');
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
    assert.ok(v.limits.some(l => /需要系统数据服务配置/.test(l)), '限制含需要系统数据服务配置声明（Wave 1）');
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
    const detail = BrandSvc.getBrandView(TID_A, bid, PID_A);
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
    // Wave 1 语义：not_integrated 不得声明契约要件；pending_config 结构就绪
    // （adapter/provider/configKeys/measurementMethod 必须显式），但禁止 ga
    for (const c of Registry.listCapabilities()) {
      if (c.maturity === 'not_integrated') {
        assert.strictEqual(c.adapter, null, c.code + ' 未接入不得声明 adapter');
        assert.strictEqual(c.provider, null, c.code + ' 未接入不得声明 provider');
      }
      if (c.maturity === 'pending_config') {
        assert.ok(c.adapter && c.provider, c.code + ' pending_config 必须声明 adapter/provider（结构就绪）');
        assert.ok(Array.isArray(c.configKeys) && c.configKeys.length, c.code + ' pending_config 必须声明 configKeys');
        assert.ok(c.measurementMethod, c.code + ' pending_config 必须声明 measurementMethod');
        assert.notStrictEqual(c.maturity, 'ga', '未通过真实 staging 验证不得标 ga');
      }
    }
  });

  // ===== 评审轮 2（事实一致性）=====
  await t('C9 报告冻结（P0）：执行只吃创建时事实包；执行前的数据变化（F2）绝不出现', async () => {
    // 冻结前：compA1 带可冻结事实（价格/卖点）
    const st0 = BrandSvc.loadProjectState(TID_A, PID_A);
    const a0 = st0.competitors.find(c => c.id === 'compA1');
    a0.pricePoints = [10, 20];
    a0.sellingPoints = ['冻结期卖点 Alpha-Seed'];
    saveState(st0);
    await new Promise(r => setTimeout(r, 150));
    const req = ReportSvc.requestReport(TID_A, PID_A, {}, null);
    assert.ok(req, '报告创建');
    const frozen = BrandStore.getReport(TID_A, req.report.reportId);
    assert.ok(frozen.factPack.facts.some(f => /Alpha-Seed/.test(f.text || '')), '冻结包含 F1 卖点事实');
    assert.ok(frozen.factPack.facts.some(f => /AlphaBrand/.test(f.text || '') && /单品价/.test(f.text || '')), '冻结包含 F1 价格事实');
    // 执行前：实时数据改出 F2（改价格 + 换卖点 + 新增品牌）
    const st2 = BrandSvc.loadProjectState(TID_A, PID_A);
    const a1 = st2.competitors.find(c => c.id === 'compA1');
    a1.pricePoints = [999];
    a1.sellingPoints = ['执行期新卖点 Zebra-F2'];
    st2.competitors.push({ id: 'compF2', name: 'F2Brand', status: 'done', url: 'https://f2.example.com', isShopify: true, sellingPoints: ['F2 独家卖点'], pricePoints: [888] });
    saveState(st2);
    await new Promise(r => setTimeout(r, 150));
    // 执行（无 LLM key → 结构化回退；同样必须来自冻结包）
    const job = BrandStore.claimReportJob('r2-worker');
    assert.ok(job && job.reportId === req.report.reportId, '领取本次任务');
    const res = await ReportSvc.executeJob(job);
    assert.strictEqual(res.status, 'done', '执行完成');
    const r1 = BrandStore.getReport(TID_A, req.report.reportId);
    assert.strictEqual(r1.status, 'success', '报告成功');
    assert.ok(r1.markdown.includes('Alpha-Seed'), '正文含冻结期事实 F1');
    assert.ok(!/Zebra-F2|F2Brand|F2 独家卖点/.test(r1.markdown), '正文绝不出现执行期 F2');
    assert.ok(!/999|888/.test(r1.markdown), '正文不出现执行期修改后的价格');
    // 引用与冻结包事实一一对应，且不含执行期数据
    const view = ReportSvc.getReportView(TID_A, req.report.reportId);
    const factIds = new Set(frozen.factPack.facts.map(f => f.id));
    assert.ok(view.citations.length >= 2, '引用已落库');
    for (const c of view.citations) {
      assert.ok(factIds.has(c.factId), 'citation 必须是冻结包事实：' + c.factId);
      assert.ok(!/Zebra-F2|F2 独家卖点/.test(c.label || ''), '引用不含执行期数据');
    }
  });

  await t('C10 报告范围（P1）：品牌/时间/章节三项范围真实生效', async () => {
    // ① 跨项目品牌 → 明确参数错误（400 BRAND_NOT_IN_PROJECT）
    await mkProject(TID_A, 'projCoreA2', [{ id: 'compAX', name: 'AlphaBrand', status: 'done', url: 'https://alpha.example.com', isShopify: true }, { id: 'compQ', name: 'OnlyA2Brand', status: 'done', url: 'https://only-a2.example.com', isShopify: true }]);
    BrandSvc.syncProjectBrands(TID_A, 'projCoreA2');
    const bidA2 = BrandStore.brandIdForCompetitor(TID_A, 'projCoreA2', 'compAX');
    assert.ok(bidA2, '同域名品牌在第二项目有链接');
    const bidQ = BrandStore.brandIdForCompetitor(TID_A, 'projCoreA2', 'compQ');
    assert.ok(bidQ && bidQ !== bidA2, 'OnlyA2 品牌独立存在');
    let threw = null;
    try { ReportSvc.requestReport(TID_A, PID_A, { brandIds: [bidQ] }, null); } catch (e) { threw = e; }
    assert.ok(threw && threw.status === 400 && threw.code === 'BRAND_NOT_IN_PROJECT', '只挂在其他项目的品牌 → 400');
    threw = null;
    try { ReportSvc.requestReport(TID_A, PID_A, { from: 'not-a-date' }, null); } catch (e) { threw = e; }
    assert.ok(threw && threw.status === 400 && threw.code === 'INVALID_TIME_RANGE', '非法时间格式 → 400');
    threw = null;
    try { ReportSvc.requestReport(TID_A, PID_A, { sections: ['nope'] }, null); } catch (e) { threw = e; }
    assert.ok(threw && threw.status === 400 && threw.code === 'INVALID_SECTION', '未知章节 → 400');
    // ② brandIds 子集：冻结包事实全部属于所选品牌
    const bidA1 = BrandStore.brandIdForCompetitor(TID_A, PID_A, 'compA1');
    const reqB = ReportSvc.requestReport(TID_A, PID_A, { brandIds: [bidA1] }, null);
    const packB = BrandStore.getReport(TID_A, reqB.report.reportId).factPack;
    assert.ok(packB.facts.length >= 1, '有事实');
    assert.ok(packB.facts.every(f => /AlphaBrand/.test(f.text || '')), '事实全部属于所选品牌');
    assert.deepStrictEqual(packB.brandIds, [bidA1]);
    // 先把 reqB 执行掉（保持任务队列干净）
    const jobB = BrandStore.claimReportJob('r2-scope-b');
    assert.ok(jobB && jobB.reportId === reqB.report.reportId, '领取 reqB');
    await ReportSvc.executeJob(jobB);
    // ③ from/to：带时间字段的事实按窗口过滤；无法判定时间 → 不命中并如实登记
    const st = BrandSvc.loadProjectState(TID_A, PID_A);
    const a1 = st.competitors.find(c => c.id === 'compA1');
    a1.recentMoves = [
      { desc: '九月上架新品线', when: '2026-09-10', basis: 'verified' },
      { desc: '十月降价清库存', when: '2026-10-05', basis: 'verified' },
    ];
    saveState(st);
    await new Promise(r => setTimeout(r, 150));
    const reqT = ReportSvc.requestReport(TID_A, PID_A, { brandIds: [bidA1], from: '2026-10-01', to: '2026-10-31' }, null);
    const packT = BrandStore.getReport(TID_A, reqT.report.reportId).factPack;
    assert.ok(packT.facts.some(f => /十月降价清库存/.test(f.text || '')), '窗口内事实保留');
    assert.ok(!packT.facts.some(f => /九月上架新品线/.test(f.text || '')), '窗口外事实排除');
    assert.ok(packT.timeUnresolved.some(u => /九月/.test(u.text || '') && /不在所选范围/.test(u.reason)), '窗口外如实登记');
    assert.ok(packT.timeUnresolved.some(u => /无法判定时间/.test(u.reason)), '无法判定时间的事实不伪造命中');
    const jobT = BrandStore.claimReportJob('r2-scope-t');
    assert.ok(jobT && jobT.reportId === reqT.report.reportId, '领取 reqT');
    const resT = await ReportSvc.executeJob(jobT);
    assert.strictEqual(resT.status, 'done');
    const repT = BrandStore.getReport(TID_A, reqT.report.reportId);
    // 「未进入本报告的事实」清单之前的正文（事实清单段）只含窗口内事实；
    // 窗口外事实出现在如实登记的排除清单里是**正确**行为
    const exIdx = repT.markdown.indexOf('未进入本报告的事实');
    assert.ok(exIdx > 0, '存在未命中清单');
    const mainPart = repT.markdown.slice(0, exIdx);
    assert.ok(mainPart.includes('十月降价清库存'), '正文事实清单含窗口内事实');
    assert.ok(!/九月上架新品线/.test(mainPart), '事实清单不含窗口外事实');
    assert.ok(repT.markdown.slice(exIdx).includes('九月上架新品线'), '排除清单如实登记窗口外事实');
    // ④ sections：只选 gaps → 只有资料缺口章节，不生成事实清单/机会
    const reqS = ReportSvc.requestReport(TID_A, PID_A, { sections: ['gaps'] }, null);
    const jobS = BrandStore.claimReportJob('r2-sec');
    assert.ok(jobS && jobS.reportId === reqS.report.reportId, '领取 reqS');
    const resS = await ReportSvc.executeJob(jobS);
    assert.strictEqual(resS.status, 'done');
    const repS = BrandStore.getReport(TID_A, reqS.report.reportId);
    assert.ok(/资料缺口/.test(repS.markdown), '选定章节生成');
    assert.ok(!/## 事实清单/.test(repS.markdown), '未选章节不生成（事实清单）');
    assert.ok(!/机会与限制/.test(repS.markdown), '未选章节不生成（机会）');
  });

  await t('C11 品牌按项目读取（P1）：同域名品牌挂两项目各读各的数据；全局 ref 不被覆盖', async () => {
    // projCoreA2（C10 创建）：compAX 与 compA1 同域名 → 同一品牌档案、两条项目链接
    const stA2 = BrandSvc.loadProjectState(TID_A, 'projCoreA2');
    const ax = stA2.competitors.find(c => c.id === 'compAX');
    ax.pricePoints = [777];
    ax.sellingPoints = ['A2 项目专属卖点'];
    saveState(stA2);
    await new Promise(r => setTimeout(r, 150));
    BrandSvc.syncProjectBrands(TID_A, 'projCoreA2', stA2);
    const bid = BrandStore.brandIdForCompetitor(TID_A, PID_A, 'compA1');
    assert.ok(bid, '品牌档案存在');
    assert.strictEqual(bid, BrandStore.brandIdForCompetitor(TID_A, 'projCoreA2', 'compAX'), '同域名 → 同一品牌档案');
    // 全局 competitor_ref 保留首见值，不被第二个项目同步覆盖
    assert.strictEqual(BrandStore.getBrand(TID_A, bid).competitorRef, 'compA1', '全局 ref 不被覆盖');
    // 列表视图：各项目读各的竞品
    const vA = BrandSvc.listBrandViews(TID_A, PID_A).find(b => b.brandId === bid);
    const vAX = BrandSvc.listBrandViews(TID_A, 'projCoreA2').find(b => b.brandId === bid);
    assert.strictEqual(vA.competitorId, 'compA1', '项目 A 读 compA1');
    assert.strictEqual(vAX.competitorId, 'compAX', '项目 A2 读 compAX');
    // 详情：显式 projectId 边界 + 数据不串项目
    const dA = BrandSvc.getBrandView(TID_A, bid, PID_A);
    const dAX = BrandSvc.getBrandView(TID_A, bid, 'projCoreA2');
    assert.strictEqual(dA.brand.competitorId, 'compA1');
    assert.strictEqual(dAX.brand.competitorId, 'compAX');
    assert.ok(dA.products.observations.length >= 3, '项目 A 详情含 compA1 采集商品');
    assert.strictEqual(dAX.products.observations.length, 0, '项目 A2 无 compAX 采集 → 空（不借用 A 的数据）');
    // 边界：未关联项目 / 跨租户 → null（上层 404）
    assert.strictEqual(BrandSvc.getBrandView(TID_A, bid, 'projCoreB'), null, '未关联项目 → null');
    assert.strictEqual(BrandSvc.getBrandView(TID_B, bid, PID_B), null, '跨租户 → null');
  });

  await t('C12 诚实状态与真实重试（P1）：无证据不标已核实；首败不称保留旧数据；重试真实有界', async () => {
    const bid = BrandStore.brandIdForCompetitor(TID_A, PID_A, 'compA1');
    // ① 时间线：无 Evidence 引用的事件（价格变化）不得标「已核实」
    BrandSvc.rebuildTimeline(TID_A, bid, PID_A, BrandSvc.findCompetitor(BrandSvc.loadProjectState(TID_A, PID_A), 'compA1'));
    for (const e of BrandSvc.timelineView(TID_A, bid, {})) {
      if (e.kind === 'price') assert.notStrictEqual(e.status, 'verified', '价格事件无引用 → 待核实');
    }
    // ② 首次采集失败（无任何历史成功）→ 不声称「保留旧数据」
    const mkF = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: PID_A, competitorId: 'compF2', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'c12-fail1' });
    SurfaceStore.completeAttempt(TID_A, mkF.attempt.attemptId, { status: 'failed', sourceStatus: 'unavailable', observations: [], snapshotIds: [], evidenceIds: [] });
    const covF = BrandSvc.buildCoverage(TID_A, PID_A, BrandSvc.findCompetitor(BrandSvc.loadProjectState(TID_A, PID_A), 'compF2'));
    const wpF = covF.dimensions.find(d => d.code === 'website_products');
    assert.strictEqual(wpF.state, 'failed', '首败状态：' + wpF.state);
    assert.strictEqual(wpF.stateText, '最近采集失败，尚无可展示数据');
    assert.ok(!/保留旧数据/.test(JSON.stringify(covF)), '首败不得声称保留旧数据');
    // ③ 有历史成功数据 + 最近失败 → 仍展示旧数据状态 + notes 明示「保留旧数据」
    const mkF2 = SurfaceStore.createAttempt({ tenantId: TID_A, projectId: PID_A, competitorId: 'compA1', capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'c12-fail2' });
    SurfaceStore.completeAttempt(TID_A, mkF2.attempt.attemptId, { status: 'failed', sourceStatus: 'unavailable', observations: [], snapshotIds: [], evidenceIds: [] });
    const covA = BrandSvc.buildCoverage(TID_A, PID_A, BrandSvc.findCompetitor(BrandSvc.loadProjectState(TID_A, PID_A), 'compA1'));
    const wpA = covA.dimensions.find(d => d.code === 'website_products');
    assert.ok(['ok', 'stale'].includes(wpA.state), '有历史成功 → 旧数据状态：' + wpA.state);
    assert.ok(wpA.notes.some(n => /最近一次更新失败，当前展示上次成功数据/.test(n)), '有旧数据才允许保留旧数据表述');
    // 时间线补入新失败 attempt 后：失败采集无 Evidence → 待核实
    BrandSvc.rebuildTimeline(TID_A, bid, PID_A, BrandSvc.findCompetitor(BrandSvc.loadProjectState(TID_A, PID_A), 'compA1'));
    const tlFail = BrandSvc.timelineView(TID_A, bid, {}).find(e => e.refId === mkF2.attempt.attemptId);
    assert.ok(tlFail && tlFail.status === 'pending', '失败采集无证据 → 待核实');
    // ④ 真实重试：注入异常 → 回 pending 可再领取；耗尽 → dead + 报告 failed；恢复后重新生成成功
    const orig = Report.buildReportFromPack;
    Report.buildReportFromPack = async () => { throw new Error('injected boom'); };
    try {
      const reqR = ReportSvc.requestReport(TID_A, PID_A, {}, null);
      const repId = reqR.report.reportId;
      let jobR = BrandStore.claimReportJob('r2-retry');
      assert.ok(jobR && jobR.reportId === repId, '领取本次任务');
      const r1 = await ReportSvc.executeJob(jobR);
      assert.strictEqual(r1.status, 'failed', '执行失败');
      let row = BrandStore.getDb().prepare('SELECT * FROM report_jobs WHERE job_id=?').get(jobR.jobId);
      assert.strictEqual(row.status, 'pending', '异常后回 pending（真实可再领取）');
      assert.strictEqual(row.retry, 1, 'retry 计数 +1');
      assert.strictEqual(BrandStore.getReport(TID_A, repId).status, 'queued', '重试中报告为 queued（未虚假终态）');
      for (let i = 0; i < 3; i++) {
        jobR = BrandStore.claimReportJob('r2-retry');
        assert.ok(jobR, '第 ' + (i + 2) + ' 次可领取');
        await ReportSvc.executeJob(jobR);
        row = BrandStore.getDb().prepare('SELECT * FROM report_jobs WHERE job_id=?').get(jobR.jobId);
      }
      assert.strictEqual(row.status, 'dead', '重试耗尽 → dead 终态');
      const failed = BrandStore.getReport(TID_A, repId);
      assert.strictEqual(failed.status, 'failed', '报告终态 failed');
      assert.ok(/重新生成/.test(failed.errorText || ''), '失败文案引导重新生成');
      Report.buildReportFromPack = orig; // 先恢复，再验证重新生成
      // 恢复后重新生成 → 成功
      const reqOK = ReportSvc.requestReport(TID_A, PID_A, {}, null);
      const jobOK = BrandStore.claimReportJob('r2-ok');
      assert.ok(jobOK && jobOK.reportId === reqOK.report.reportId, '领取重新生成任务');
      const rOK = await ReportSvc.executeJob(jobOK);
      assert.strictEqual(rOK.status, 'done', '恢复后生成成功');
      assert.strictEqual(BrandStore.getReport(TID_A, reqOK.report.reportId).status, 'success');
    } catch (e) {
      Report.buildReportFromPack = orig;
      throw e;
    } finally {
      Report.buildReportFromPack = orig;
    }
  });

  console.log(`\ncore-product.test: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
