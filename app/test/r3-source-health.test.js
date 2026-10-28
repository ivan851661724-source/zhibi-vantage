'use strict';
// ============================================================
// test/r3-source-health.test.js —— CPE1 r3「采集状态收口」行为回归
// ------------------------------------------------------------
// 覆盖（对应任务书 §七）：
//   R1 官网可访问、无价格/无结构化商品 → 两次官网观察后晋升 site_change（不是失败）
//   R2 只有一次观察 → 仍是 establishing，收件箱零事件（基线不进收件箱）
//   R3 已有 attempt 的品牌 → 不再显示「未探测 / 尚未开始采集」
//   R4 limited（只监控官网内容）不计入「需要处理」
//   R5 not_configured 计入「覆盖限制」，不计入重试数
//   R6 真实阻断（blocked）才计入「需要处理」，且两页（竞品库/情报库）语义一致
//   R7 官网可访问但无可比字段的意向 → 收件箱只给说明，不列失败、不改成功态
//   R8 同一品牌 × 来源 × 窗口的失败只出现一次
//   R9 resumeSiteProbe 续跑不重置进度、不新建意向
//   R10 两租户隔离
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-r3sh-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.ZB_FIRST_COLLECTION_AUTO = 'off';
process.env.ZB_INTENT_PROBE_INTERVAL_MS = '1000';
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });

const db = require('../services/db.js');
const BrandSvc = require('../services/brand-service.js');
const SurfaceStore = require('../services/surface-store.js');
const Snapshot = require('../research/source-snapshot.js');
const WS = require('../services/watch-store.js');
const WIntent = require('../services/watch-intent.js');
const SourceHealth = require('../services/source-health.js');
const IntelInbox = require('../services/intel-inbox.js');
const { saveState, projFile } = require('../core/state-store.js');

const TID = 'tenant:r3sh';
const PID = 'projR3sh';
const TID2 = 'tenant:r3sh2';
const PID2 = 'projR3sh2';
const HOST = 'acme-r3sh.example.com';

const COMPS = [
  { id: 'c-site', name: 'SiteOnly', url: 'https://' + HOST, status: 'done', isShopify: false },
  { id: 'c-blocked', name: 'BlockedBrand', url: 'https://blocked-r3sh.example.com', status: 'done', isShopify: false },
  { id: 'c-config', name: 'ConfigGap', url: 'https://config-r3sh.example.com', status: 'done', isShopify: false },
];

const HTML = (title, extra) => `<!doctype html><html><head>
<title>${title}</title>
<meta name="description" content="durable goods">
<link rel="canonical" href="https://${HOST}/">
<script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://${HOST}/"}</script>
</head><body><h1>${title}</h1><p>${extra || 'stable body text'}</p></body></html>`;

function mkSnapshot(html, url) {
  const snap = Snapshot.record({
    capability: 'official_site_profile', provider: 'generic_web_fetch',
    source_url: url || ('https://' + HOST + '/'), final_url: url || ('https://' + HOST + '/'),
    http_status: 200, source_status: 'success', error_code: null,
    observed_at: new Date().toISOString(), fetched_at: new Date().toISOString(),
    bodyBytes: Buffer.from(html, 'utf8'), trigger: 'manual', tenantId: TID,
  });
  return snap;
}

// 真实 attempt：官网资料（site_change 资格只认这个能力）
function seedSiteAttempt(compId, key, opts) {
  const o = opts || {};
  const html = o.html || HTML('Acme Outdoor', 'stable');
  const snap = mkSnapshot(html, o.url);
  const att = SurfaceStore.createAttempt({
    tenantId: TID, projectId: PID, competitorId: compId, capability: 'official_site_profile',
    dimension: 'website_products', trigger: 'manual', idempotencyKey: 'r3sh-site-' + compId + '-' + key,
  });
  SurfaceStore.completeAttempt(TID, att.attempt.attemptId, {
    status: o.status || 'success',
    sourceStatus: o.sourceStatus || null,
    errorClass: o.errorClass || null,
    observations: [{
      id: 'official_site_profile', title: 'Acme Outdoor', price: null, currency: null,
      available: true, publishedAt: null, sourceUrl: o.url || ('https://' + HOST + '/'),
    }],
    summary: { kind: 'official_site_profile' },
    snapshotIds: snap && snap.recorded ? [snap.meta.snapshot_id] : [],
    evidenceIds: [],
  }, o.endedAt ? new Date(o.endedAt) : null);
  return att.attempt.attemptId;
}

function seedProductAttempt(compId, key, opts) {
  const o = opts || {};
  const att = SurfaceStore.createAttempt({
    tenantId: TID, projectId: PID, competitorId: compId, capability: 'public_site_products',
    dimension: 'website_products', trigger: 'manual', idempotencyKey: 'r3sh-prod-' + compId + '-' + key,
  });
  if (o.status === 'failed') {
    SurfaceStore.completeAttempt(TID, att.attempt.attemptId, {
      status: 'failed', sourceStatus: o.sourceStatus || 'blocked', errorClass: o.errorClass || o.sourceStatus || 'blocked',
      observations: [], summary: null, snapshotIds: [], evidenceIds: [],
    }, null);
  } else {
    SurfaceStore.completeAttempt(TID, att.attempt.attemptId, {
      status: 'partial', observations: [], summary: { kind: 'official_site_products', productCount: 0 },
      snapshotIds: [], evidenceIds: [],
    }, null);
  }
  return att.attempt.attemptId;
}

function healthOf(compId) {
  const comp = COMPS.find(c => c.id === compId) || { id: compId };
  return SourceHealth.build(TID, PID, comp);
}

test.before(async () => {
  db.createTenant({ name: 'r3sh', email: 'r3sh@example.com' });
  db.saveProject({ id: PID, tenantId: TID, track: 'R3 来源收口', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const f = projFile(PID, TID);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  saveState({ projectId: PID, tenantId: TID, track: 'R3 来源收口', discoveredAt: new Date().toISOString(), intent: { regions: ['us'], category: 'gear' }, competitors: COMPS });
  for (let i = 0; i < 200 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(fs.existsSync(f), '项目状态已落盘');
  BrandSvc.syncProjectBrands(TID, PID);
});

// ---------- R1 / R2：降级链 ----------
test('R1 一次官网观察不构成 site_change 资格；两次独立观察才晋升', () => {
  seedSiteAttempt('c-site', 'k1');
  const once = WIntent.siteChangeEligibility(TID, PID, 'c-site');
  assert.strictEqual(once.attempts, 1, '只数到 1 次官网观察');
  assert.strictEqual(once.eligible, false, '一次观察不得晋升');
  assert.strictEqual(once.reason, 'need_two_site_collections');

  seedSiteAttempt('c-site', 'k2');
  const twice = WIntent.siteChangeEligibility(TID, PID, 'c-site');
  assert.strictEqual(twice.attempts, 2, '两次独立观察');
  assert.strictEqual(twice.eligible, true, '两次稳定观察 → 可晋升 site_change');
  assert.ok(twice.signals.length >= 1, '指纹稳定依据存在');
});

test('R2 首采基线不进收件箱：只有官网观察、无监控窗口时收件箱零事件', () => {
  const box = IntelInbox.listInbox({ tenantId: TID, projectId: PID });
  assert.strictEqual(box.total, 0, '没有任何 intel_event');
  assert.strictEqual(box.groups.length, 0, '没有日期分组');
});

// ---------- R3：未探测消除 ----------
test('R3 已有 attempt 的品牌不得显示「未探测 / 尚未开始采集」', () => {
  const views = BrandSvc.listBrandViews(TID, PID);
  const v = views.find(x => x.competitorId === 'c-site');
  assert.ok(v, '品牌视图存在');
  assert.strictEqual(v.sourceHealth.started, true, '已开始采集');
  assert.notStrictEqual(v.status.code, 'not_started', '不得是未探测');
  assert.notStrictEqual(v.sourceHealth.state, 'not_started', '状态不得是 not_started');
  assert.ok(v.status.text && v.status.text.length <= 24, '卡片文案短');
});

// ---------- R4/R5/R6：四类计数口径 ----------
test('R4 limited（只监控官网内容）不计入「需要处理」', () => {
  const intent = WIntent.requestIntent({
    tenantId: TID, projectId: PID, competitorId: 'c-site',
    reasonCode: 'no_comparable_products', reasonText: '官网可访问，但没有可比较的商品价格。', signals: ['price', 'launch'],
  });
  assert.ok(intent.intent && intent.intent.intentId, '意向已创建');
  const promoted = WIntent.tryPromote({ tenantId: TID, projectId: PID, competitorId: 'c-site' });
  assert.strictEqual(promoted.promoted, true, '两次官网观察后晋升');
  const target = WS.getWatchTarget(TID, promoted.target.watchTargetId);
  const sigs = target.supportedSignals || JSON.parse(target.supported_signals || '[]');
  assert.deepStrictEqual(sigs, ['site_change'], '降级为官网内容监控');

  const h = healthOf('c-site');
  assert.strictEqual(h.state, 'limited', '只监控官网内容 = limited');
  assert.strictEqual(h.needsHandling, false, 'limited 不得计入需要处理');
  assert.ok(/官网内容/.test(h.stateText), '文案说明监控的是官网内容：' + h.stateText);
});

test('R5 not_configured 进「覆盖限制」，不进重试数', () => {
  const h = healthOf('c-config');
  assert.strictEqual(h.needsHandling, false, '未配置不得计入需要处理');
  assert.ok(['not_started', 'not_configured', 'limited'].includes(h.state), '状态必须是无数据类：' + h.state);
  const sum = SourceHealth.summarize([h]);
  assert.strictEqual(sum.needsHandling, 0, '汇总里 needsHandling = 0');
});

test('R6 真实阻断才计入「需要处理」，且竞品库与情报库语义一致', () => {
  // 真实链路形态：商品页被拒 → 切官网仍失败 → 意向落 blocked（不是「无法建立来源」这种笼统话）
  seedProductAttempt('c-blocked', 'b1', { status: 'failed', sourceStatus: 'blocked' });
  const created = WIntent.requestIntent({
    tenantId: TID, projectId: PID, competitorId: 'c-blocked',
    reasonCode: 'blocked', reasonText: '来源站点拒绝了公开页面访问（403/401）。', signals: ['price'],
  });
  WIntent.setFailed(TID, created.intent.intentId, 'blocked', '来源站点拒绝了公开页面访问（403/401）。');
  const h = healthOf('c-blocked');
  assert.strictEqual(h.state, 'blocked', 'blocked → 来源拒绝访问');
  assert.strictEqual(h.needsHandling, true, '真实阻断进需要处理');

  const views = BrandSvc.listBrandViews(TID, PID);
  const v = views.find(x => x.competitorId === 'c-blocked');
  assert.strictEqual(v.status.code, 'blocked', '竞品库卡片 = blocked');

  const box = IntelInbox.listInbox({ tenantId: TID, projectId: PID });
  const item = (box.state.sources.items || []).find(i => i.brandName === 'BlockedBrand');
  assert.ok(item, '情报库能看到该品牌的来源问题');
  assert.strictEqual(item.category, 'blocked', '情报库分类与竞品库一致（blocked）');
  assert.ok(!/无法建立可核验的公开来源/.test(item.categoryText), '不再用笼统「无法建立来源」');
});

// ---------- R7/R8：收件箱语义 ----------
test('R7 「官网可访问但无可比字段」只给说明，不列失败、不改成功态', () => {
  seedSiteAttempt('c-config', 's1');
  WIntent.requestIntent({
    tenantId: TID, projectId: PID, competitorId: 'c-config',
    reasonCode: 'no_comparable_products', reasonText: '官网可访问，但没有可比较的商品价格。', signals: ['price'],
  });
  // 人为把它标记成失败态（模拟老数据：卡在 source_failed）
  WIntent.setFailed(TID, WIntent.findIntent(TID, PID, 'c-config').intentId, 'no_comparable_products', '官网可访问，但没有可比较的商品价格。');

  const box = IntelInbox.listInbox({ tenantId: TID, projectId: PID });
  const itemNames = (box.state.sources.items || []).map(i => i.brandName);
  assert.ok(!itemNames.includes('ConfigGap'), '不得把「官网可访问但无价格」列为失败');
  const notes = (box.state.sources.notes || []).map(n => n.brandName);
  assert.ok(notes.includes('ConfigGap'), '只给一条基线说明');
  assert.notStrictEqual(box.state.state, 'inspection_failed', '不得显示全部失败');
});

test('R8 同一品牌 × 来源 × 窗口的失败只出现一次', () => {
  const box = IntelInbox.listInbox({ tenantId: TID, projectId: PID });
  const names = (box.state.sources.items || []).map(i => i.brandName);
  const dup = names.filter(n => n === 'BlockedBrand').length;
  assert.strictEqual(dup, 1, '同一失败不重复列出');
});

// ---------- R9：续跑不重置进度 ----------
test('R9 resumeSiteProbe 续跑卡住的意向：不新建意向、不重置已有观察', () => {
  const before = WIntent.listIntents(TID, PID).length;
  const siteAtts = (SurfaceStore.listAttempts(TID, PID, 'c-config', 'official_site_profile', 10) || [])
    .filter(a => a.status === 'success' || a.status === 'partial').length;
  assert.ok(siteAtts >= 1, '该品牌已有官网观察');

  const r = WIntent.resumeSiteProbe(TID, PID, 'c-config');
  assert.strictEqual(r.resumed, true, '应当续跑');
  const intents = WIntent.listIntents(TID, PID);
  assert.strictEqual(intents.length, before, '不得新建第二条意向');
  const it = WIntent.findIntent(TID, PID, 'c-config');
  assert.strictEqual(it.state, 'establishing', '回到建立中');
  assert.strictEqual(String(it.nextProbeCapability), 'official_site_profile', '从官网能力续跑，不回退商品页');
});

// ---------- R10：两租户隔离 ----------
test('R10 跨租户不可见：另一租户读不到本项目的状态与事件', () => {
  db.createTenant({ name: 'r3sh2', email: 'r3sh2@example.com' });
  db.saveProject({ id: PID2, tenantId: TID2, track: 'other', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const otherViews = BrandSvc.listBrandViews(TID2, PID2);
  assert.strictEqual(otherViews.length, 0, '另一租户没有这些品牌');
  const otherBox = IntelInbox.listInbox({ tenantId: TID2, projectId: PID2 });
  assert.strictEqual(otherBox.total, 0, '另一租户没有事件');
  const h = SourceHealth.build(TID2, PID2, COMPS[0]);
  assert.strictEqual(h.started, false, '另一租户读不到本项目 attempt');
});
