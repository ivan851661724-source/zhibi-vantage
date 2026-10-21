'use strict';
// ============================================================
// test/sc08.test.js —— SC-08 竞品数据库 × 每日情报收件箱 × 监控降级
// ------------------------------------------------------------
// I1  收件箱字段规则：baseline 不入箱 / backfill 不入箱 / 无证据强制 pending /
//     effectiveAt 镜像 observedAt 被置 null / 花费类字段拒收 / 未接入维度拒收 / 类型保真
// I2  分组与分页：日期倒序、cursor 稳定、默认 30 上限、去重
// I3  两租户隔离
// S1  指纹清洗：script/style/cookie/nonce/时间/随机ID/utm 不污染指纹
// S2  确定性 Diff：结构字段变化被捕获；仅噪点变化不产生变化
// S3  首次 baseline 只存不发事件；第二次变化 → 事件（含证据 → verified）+ baseline 前移
// S4  非 Shopify 无可比价格但官网稳定 → 晋升 site_change（不落 source_failed）
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc08-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.ZB_INTENT_PROBE_INTERVAL_MS = '1500';
process.env.ZB_INTENT_PROBE_GRACE_MS = '60000';
process.env.ZB_INTENT_MAX_AUTO_RETRIES = '2';
process.env.SERPER_API_KEY = 'test-key-not-real';
try { fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true }); } catch (e) {}

const Inbox = require('../services/intel-inbox.js');
const FP = require('../services/site-fingerprint.js');
const WS = require('../services/watch-store.js');
const SurfaceStore = require('../services/surface-store.js');
const Snapshot = require('../research/source-snapshot.js');
const WIntent = require('../services/watch-intent.js');
const WatchMonitor = require('../services/watch-monitor.js');
const { projFile, mirrorProjectToDb } = require('../core/state-store.js');

const TID = 'tenant:sc08a';
const TID_B = 'tenant:sc08b';
const PID = 'projSC08';
const CID = 'c-sc08-brand';
let seq = 0;
function uid(p) { seq += 1; return p + seq; }

function seedProject(tenantId, projectId, compsArr) {
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    tenantId, projectId, intent: { regions: ['us'] }, excluded: [],
    competitors: compsArr, discoverDone: true, progress: { total: compsArr.length, done: compsArr.length },
  }, null, 2));
  mirrorProjectToDb(projectId, tenantId, 'SC08');
}
function comp(id, url, isShopify) {
  return { id, name: 'SC08品牌' + id.slice(-2), url, status: 'done', isShopify: !!isShopify, market: 'us' };
}

// ---------- I1：字段规则 ----------
test('I1 收件箱字段规则：baseline/backfill 不入箱，无证据只能 pending，effectiveAt 不得镜像', () => {
  Inbox.ensureTable();
  const now = new Date().toISOString();
  // 首次 baseline：产生点根本不写事件 → 收件箱为空（这里直接断言空态）
  const before = Inbox.listInbox({ tenantId: TID, projectId: PID });
  assert.strictEqual(before.total, 0, '初始收件箱为空');

  // 正常价格事件：有快照证据 → verified
  const ok = Inbox.recordEvent({
    tenantId: TID, projectId: PID, competitorId: CID, brandName: 'SC08品牌01',
    dimension: 'price', eventType: 'price_changed',
    title: '价格由 20 调整为 15', summary: '价格 20 → 15',
    subjectId: 'sku-1', observedAt: now,
    effectiveAt: now, // 与 observedAt 相同 = 伪造 → 必须置 null
    change: { field: 'price', oldValue: 20, newValue: 15, direction: 'decrease', delta: -5, pct: -25, currency: 'USD', basis: 'deterministic_diff' },
    evidenceRefs: [{ snapshotId: 'snap_x', sourceUrl: 'https://example.com/p/1', observedAt: now }],
    verificationStatus: 'verified',
  });
  assert.strictEqual(ok.recorded, true);
  assert.ok(ok.downgraded.includes('effective_at_mirrors_observed_at'), '镜像 observedAt 的 effectiveAt 被纠正: ' + JSON.stringify(ok));

  let data = Inbox.listInbox({ tenantId: TID, projectId: PID });
  assert.strictEqual(data.total, 1);
  const ev = data.groups[0].events[0];
  assert.strictEqual(ev.verificationStatus, 'verified', '有证据可为 verified');
  assert.strictEqual(ev.effectiveAt, null, 'effectiveAt 不得复制 observedAt');
  assert.strictEqual(ev.change.oldValue, 20, 'oldValue 保留数字类型');
  assert.strictEqual(ev.change.newValue, 15);
  // 证据入口：优先 evidenceId（可开 Evidence Drawer）；仅有快照时如实给 null，
  // 但 evidenceRefs / evidenceCount 必须反映「有来源快照」
  assert.strictEqual(ev.evidenceCount, 1, '快照证据计数');
  assert.strictEqual(ev.evidenceRefs.length, 1);
  assert.strictEqual(ev.links.evidence, null, '无 evidenceId 时不伪造 Drawer 入口');

  // 无证据 + 声称 verified → 强制 pending
  const noEv = Inbox.recordEvent({
    tenantId: TID, projectId: PID, competitorId: CID, dimension: 'website', eventType: 'website_changed',
    title: '官网内容变化：页面标题变更', observedAt: new Date(Date.now() + 1000).toISOString(),
    change: { field: 'title', oldValue: 'A', newValue: 'B', basis: 'deterministic_diff' },
    evidenceRefs: [], verificationStatus: 'verified',
  });
  assert.strictEqual(noEv.recorded, true);
  assert.strictEqual(noEv.verificationStatus, 'pending', '无证据必须降级 pending');
  assert.ok(noEv.downgraded.includes('no_evidence_downgraded_to_pending'));

  // 回补历史 → 允许写入但 origin=backfill，不进收件箱
  const bf = Inbox.recordEvent({
    tenantId: TID, projectId: PID, competitorId: CID, dimension: 'price', eventType: 'price_changed',
    title: '历史回补：2026-09 价格调整', observedAt: '2026-09-01T00:00:00.000Z',
    origin: 'backfill', change: { field: 'price', oldValue: 18, newValue: 20, basis: 'deterministic_diff' },
  });
  assert.strictEqual(bf.recorded, true);

  data = Inbox.listInbox({ tenantId: TID, projectId: PID });
  assert.strictEqual(data.total, 2, 'backfill 不进收件箱（仅 2 条 monitoring）');

  // 花费/ROI 等不可观测字段 → 拒收
  for (const bad of ['spend', 'roi', 'gmv', 'conversion_rate']) {
    const r = Inbox.recordEvent({
      tenantId: TID, projectId: PID, competitorId: CID, dimension: 'ads', eventType: 'ad_changed',
      title: 'x', observedAt: now, change: { [bad]: 1 },
    });
    assert.strictEqual(r.recorded, false);
    // 注意：ads 维度本身未接入写入点，理由可能是维度未接入——两者都属拒收
    assert.ok(/FORBIDDEN_CHANGE_FIELD|DIMENSION_NOT_INTEGRATED/.test(r.reason), bad + ' 拒收原因: ' + r.reason);
  }
  // 已接入维度 + 禁字段 → 明确按禁字段拒收
  const forbid = Inbox.recordEvent({
    tenantId: TID, projectId: PID, competitorId: CID, dimension: 'price', eventType: 'price_changed',
    title: 'x', observedAt: now, change: { field: 'price', oldValue: 20, newValue: 15, roi: 3.2 },
  });
  assert.strictEqual(forbid.recorded, false);
  assert.strictEqual(forbid.reason, 'FORBIDDEN_CHANGE_FIELD:roi');

  // 未接入维度（review）不得写入占位事件
  const notYet = Inbox.recordEvent({
    tenantId: TID, projectId: PID, competitorId: CID, dimension: 'review', eventType: 'review_changed',
    title: 'x', observedAt: now, change: { field: 'rating', oldValue: 4.5, newValue: 4.4 },
  });
  assert.strictEqual(notYet.recorded, false);
  assert.ok(/DIMENSION_NOT_INTEGRATED/.test(notYet.reason), '未接入维度拒收: ' + notYet.reason);

  // 区间价格结构保真
  const range = Inbox.recordEvent({
    tenantId: TID, projectId: PID, competitorId: CID, dimension: 'price', eventType: 'price_changed',
    title: '区间价格变化', observedAt: new Date(Date.now() + 2000).toISOString(),
    change: { field: 'price_range', oldValue: { min: 10, max: 20 }, newValue: { min: 10, max: 18 }, basis: 'deterministic_diff' },
  });
  assert.strictEqual(range.recorded, true);
  data = Inbox.listInbox({ tenantId: TID, projectId: PID });
  const rangeEv = data.groups.flatMap(g => g.events).find(e => e.title === '区间价格变化');
  assert.deepStrictEqual(rangeEv.change.oldValue, { min: 10, max: 20 }, '区间结构不退化为标量');
});

// ---------- I2：分组 / 分页 / 去重 ----------
test('I2 分页：默认 30、cursor 稳定、日期倒序分组、重复写入去重', () => {
  const tid = 'tenant:sc08page';
  const pid = 'projSC08page';
  Inbox.ensureTable();
  const base = Date.parse('2026-10-20T00:00:00.000Z');
  for (let i = 0; i < 35; i++) {
    const at = new Date(base + i * 3600 * 1000).toISOString();
    const r = Inbox.recordEvent({
      tenantId: tid, projectId: pid, competitorId: CID, dimension: 'price', eventType: 'price_changed',
      title: '事件 ' + i, subjectId: 's' + i, observedAt: at,
      change: { field: 'price', oldValue: 10 + i, newValue: 11 + i, basis: 'deterministic_diff' },
    });
    assert.strictEqual(r.recorded, true, '第 ' + i + ' 条写入: ' + JSON.stringify(r));
  }
  // 同 scope/同 subject/同 eventType/同 observedAt 再写 → 去重
  const dup = Inbox.recordEvent({
    tenantId: tid, projectId: pid, competitorId: CID, dimension: 'price', eventType: 'price_changed',
    title: '重复', subjectId: 's0', observedAt: new Date(base).toISOString(),
    change: { field: 'price', oldValue: 10, newValue: 11, basis: 'deterministic_diff' },
  });
  assert.strictEqual(dup.recorded, false);
  assert.strictEqual(dup.reason, 'DUPLICATE');

  const p1 = Inbox.listInbox({ tenantId: tid, projectId: pid });
  assert.strictEqual(p1.groups.reduce((n, g) => n + g.events.length, 0), 30, '默认每页 30 条');
  assert.ok(p1.nextCursor, '有下一页 cursor');
  assert.strictEqual(p1.total, 35);
  // 日期倒序
  const dates = p1.groups.map(g => g.date);
  const sorted = [...dates].sort().reverse();
  assert.deepStrictEqual(dates, sorted, '日期倒序分组');
  // 第二页
  const p2 = Inbox.listInbox({ tenantId: tid, projectId: pid, cursor: p1.nextCursor });
  const n2 = p2.groups.reduce((n, g) => n + g.events.length, 0);
  assert.strictEqual(n2, 5, '第二页剩余 5 条');
  assert.strictEqual(p2.nextCursor, null);
  // 两页 eventId 无重复
  const ids1 = p1.groups.flatMap(g => g.events).map(e => e.eventId);
  const ids2 = p2.groups.flatMap(g => g.events).map(e => e.eventId);
  assert.strictEqual(new Set([...ids1, ...ids2]).size, 35, '分页无重复无遗漏');
  // 非法 cursor：忽略并如实登记 limitation
  const bad = Inbox.listInbox({ tenantId: tid, projectId: pid, cursor: 'not-a-cursor' });
  assert.ok(bad.limitations.includes('invalid_cursor_ignored'));
});

// ---------- I3：两租户隔离 ----------
test('I3 收件箱两租户隔离：互不可见，统计各自计算', () => {
  Inbox.ensureTable();
  const now = new Date().toISOString();
  Inbox.recordEvent({ tenantId: TID_B, projectId: PID, competitorId: CID, dimension: 'price', eventType: 'price_changed', title: 'B 租户事件', observedAt: now, change: { field: 'price', oldValue: 1, newValue: 2, basis: 'deterministic_diff' } });
  const a = Inbox.listInbox({ tenantId: TID, projectId: PID });
  const b = Inbox.listInbox({ tenantId: TID_B, projectId: PID });
  assert.ok(!a.groups.flatMap(g => g.events).some(e => e.title === 'B 租户事件'), 'A 看不到 B 的事件');
  assert.strictEqual(b.groups.flatMap(g => g.events).filter(e => e.title === 'B 租户事件').length, 1);
});

// ---------- S1：指纹清洗 ----------
const HTML_A = `<!doctype html><html><head>
<title>Acme — Outdoor Gear</title>
<meta name="description" content="Durable outdoor essentials">
<link rel="canonical" href="https://acme.example.com/">
<script>window.__NUXT__={t:${Date.now()}};var nonce="${'a'.repeat(24)}";</script>
<style>.x{color:red}</style>
</head><body>
<div class="cookie-banner">We use cookies <a href="#" onclick="accept()">Accept</a></div>
<div id="recommend-carousel"><a href="/product/rec-1">Recommended Item</a></div>
<nav><a href="/shop">Shop</a><a href="/about">About</a></nav>
<h1>Acme Outdoor</h1><h2>Featured</h2>
<a href="/product/tent-a?utm_source=ads&gclid=xyz">Tent A</a>
<a href="/product/pack-b">Pack B</a>
<script type="application/ld+json">{"@type":"Organization","name":"Acme","url":"https://acme.example.com/","sameAs":["https://twitter.com/acme"]}</script>
<p>Updated ${new Date().toISOString()} build ${'f'.repeat(32)}</p>
</body></html>`;

test('S1 指纹清洗：噪点（脚本/样式/cookie/时间/随机ID/追踪参数/推荐区）不进入稳定字段', () => {
  const fp1 = FP.buildFingerprint(HTML_A, 'https://acme.example.com/');
  assert.strictEqual(fp1.title, 'Acme — Outdoor Gear');
  assert.strictEqual(fp1.canonical, 'https://acme.example.com/');
  assert.strictEqual(fp1.organization && fp1.organization.name, 'Acme');
  assert.ok(!fp1.productUrls.some(u => /rec-1/.test(u)), '推荐区商品不进集合');
  assert.ok(fp1.productUrls.some(u => /tent-a/.test(u)) && !fp1.productUrls.some(u => /utm_source|gclid/.test(u)), '追踪参数被剥离');
  const json = JSON.stringify(fp1);
  assert.ok(!/cookie/i.test(json) || !/Accept/.test(json), 'cookie banner 文本不进指纹');
  assert.ok(!/Recommend/i.test(json), '推荐区不进指纹');
  // 同一页面但时间/随机 ID/nonce 不同 → 指纹完全一致
  const html2 = HTML_A.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/, new Date(Date.now() + 86400000).toISOString())
    .replace(/"([a-f0-9]{32})"/g, '"' + '1'.repeat(32) + '"').replace(/nonce="[a-f0-9]+"/, 'nonce="' + 'b'.repeat(24) + '"');
  const fp2 = FP.buildFingerprint(html2, 'https://acme.example.com/');
  const diffNoise = FP.diffFingerprints(fp1, fp2);
  assert.strictEqual(diffNoise.changes.length, 0, '仅噪点变化不得产生变化: ' + JSON.stringify(diffNoise.changes));
  // 稳定性判定
  const st = FP.stabilityOf(fp1);
  assert.strictEqual(st.stable, true, '结构化字段充足: ' + JSON.stringify(st));
});

// ---------- S2：确定性 Diff ----------
test('S2 确定性 Diff：标题/组织/商品集合变化被捕获；区间不退化', () => {
  const fp1 = FP.buildFingerprint(HTML_A, 'https://acme.example.com/');
  const htmlTitleChanged = HTML_A.replace('<title>Acme — Outdoor Gear</title>', '<title>Acme — Trail Gear</title>');
  const fp3 = FP.buildFingerprint(htmlTitleChanged, 'https://acme.example.com/');
  const d3 = FP.diffFingerprints(fp1, fp3);
  assert.strictEqual(d3.comparable, true);
  assert.ok(d3.changes.some(c => c.field === 'title' && c.newValue === 'Acme — Trail Gear'), '标题变化被捕获: ' + JSON.stringify(d3.changes));
  // 新增商品
  const htmlNewProduct = HTML_A.replace('</body>', '<a href="/product/lamp-c">Lamp C</a></body>');
  const fp4 = FP.buildFingerprint(htmlNewProduct, 'https://acme.example.com/');
  const d4 = FP.diffFingerprints(fp1, fp4);
  assert.ok(d4.changes.some(c => c.field === 'product_urls' && (c.added || []).some(u => /lamp-c/.test(u))), '新增商品被捕获: ' + JSON.stringify(d4.changes));
  // 描述文字可读
  assert.ok(/官网|商品/.test(FP.describeChanges(d3.changes)));
});

// ---------- S3：首次 baseline 不发事件；第二次变化发事件 ----------
function makeSiteTarget(tid, pid, cid) {
  return WS.createWatchTarget({
    tenantId: tid, projectId: pid, competitorId: cid,
    market: 'us', timezone: 'UTC',
    enabledSignals: ['site_change'], supportedSignals: ['site_change'],
    enrichmentStatus: 'complete',
  }).target;
}
function fakeFingerprintResult(html) {
  const fp = FP.buildFingerprint(html, 'https://acme.example.com/');
  return {
    ok: true, fingerprint: fp, stability: FP.stabilityOf(fp),
    sourceUrl: 'https://acme.example.com/',
    evidenceRefs: [{ snapshotId: 'snap_fake_1', sourceUrl: 'https://acme.example.com/', observedAt: new Date().toISOString() }],
    partialScan: false,
  };
}

test('S3 site_change：首次只存 baseline 不发事件；第二次结构变化 → 事件 verified + baseline 前移', async () => {
  const tid = 'tenant:sc08site';
  const pid = 'projSC08Site';
  const cid = 'c-site-1';
  seedProject(tid, pid, [comp(cid, 'https://acme.example.com/', false)]);
  const target = makeSiteTarget(tid, pid, cid);
  assert.ok(target.watchTargetId);
  assert.deepStrictEqual(target.enabledSignals, ['site_change'], 'WatchTarget 接受 site_change');

  // 第一次窗口：只有 baseline
  const t1 = Date.now();
  let res = await WatchMonitor.executeWindow(target, 'w1', {
    siteFingerprintFn: async () => fakeFingerprintResult(HTML_A),
  }, t1);
  assert.strictEqual(res.succeeded, 1, '首次窗口成功: ' + JSON.stringify(res.signalResults));
  assert.strictEqual(res.eventsVerified, 0, '首次 baseline 不产事件');
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0, '收件箱仍为空');
  const bl = WS.getSiteBaseline(tid, pid, cid);
  assert.ok(bl && bl.fingerprint && bl.fingerprint.title, 'baseline 已存');

  // 第二次窗口：标题变化 → 事件
  res = await WatchMonitor.executeWindow(target, 'w2', {
    siteFingerprintFn: async () => fakeFingerprintResult(HTML_A.replace('<title>Acme — Outdoor Gear</title>', '<title>Acme — Trail Gear</title>')),
  }, t1 + 3600 * 1000);
  assert.strictEqual(res.eventsVerified, 1, '第二次确定性变化成事件');
  const data = Inbox.listInbox({ tenantId: tid, projectId: pid });
  assert.strictEqual(data.total, 1);
  const ev = data.groups[0].events[0];
  assert.strictEqual(ev.dimension, 'website');
  assert.strictEqual(ev.eventType, 'website_changed');
  assert.strictEqual(ev.verificationStatus, 'verified', '有快照证据 → verified');
  assert.strictEqual(ev.origin, 'monitoring');
  assert.strictEqual(ev.effectiveAt, null, 'effectiveAt 不得伪造');
  assert.ok(ev.change.basis === 'deterministic_diff');
  assert.strictEqual(ev.change.field, 'title');

  // 第三次窗口：内容与 baseline 相同 → 不重复报同一变化
  res = await WatchMonitor.executeWindow(target, 'w3', {
    siteFingerprintFn: async () => fakeFingerprintResult(HTML_A.replace('<title>Acme — Outdoor Gear</title>', '<title>Acme — Trail Gear</title>')),
  }, t1 + 7200 * 1000);
  assert.strictEqual(res.eventsVerified, 0, '同一变化不重复上报');
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 1);
});

test('S3b site_change 真实失败：官网不可达 → not_supported/fetch_failed，不静默成功', async () => {
  const tid = 'tenant:sc08sitefail';
  const pid = 'projSC08SiteFail';
  const cid = 'c-site-fail';
  seedProject(tid, pid, [comp(cid, 'https://unreachable.example.com/', false)]);
  const target = makeSiteTarget(tid, pid, cid);
  const res = await WatchMonitor.executeWindow(target, 'w1', {
    siteFingerprintFn: async () => ({ ok: false, reason: 'blocked', error: 'blocked' }),
  }, Date.now());
  assert.strictEqual(res.succeeded, 0);
  assert.strictEqual(res.failureReasons.blocked, 1, '如实记录失败分类: ' + JSON.stringify(res.failureReasons));
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0, '失败不产事件');
});

// ---------- S4：无可比价格但官网稳定 → 晋升 site_change ----------
test('S4 晋升降级：两次官网采集 + 稳定字段 + 无可比价格 → Target 信号 site_change（不落 source_failed）', () => {
  const tid = 'tenant:sc08promote';
  const pid = 'projSC08Promote';
  const cid = 'c-promote-1';
  seedProject(tid, pid, [comp(cid, 'https://acme.example.com/', false)]);

  // 造两次官网采集（真实快照：Snapshot.record 落盘）
  const mkSiteAttempt = (html, at) => {
    const snap = Snapshot.record({
      capability: 'evidence_url', provider: 'generic_web_fetch',
      source_url: 'https://acme.example.com/', final_url: 'https://acme.example.com/',
      http_status: 200, source_status: 'success', error_code: null,
      observed_at: at, fetched_at: at, bodyBytes: Buffer.from(html, 'utf8'),
      trigger: 'schedule', tenantId: tid,
    });
    assert.strictEqual(snap.recorded, true, '快照落盘');
    const mk = SurfaceStore.createAttempt({
      tenantId: tid, projectId: pid, competitorId: cid,
      capability: 'official_site_profile', dimension: 'website_profile',
      trigger: 'schedule', idempotencyKey: 'sc08-site-' + at,
    });
    SurfaceStore.completeAttempt(tid, mk.attempt.attemptId, {
      status: 'success', sourceStatus: 'success',
      observations: [{ id: 'https://acme.example.com/', kind: 'site_profile', title: 'Acme' }],
      snapshotIds: [snap.meta.snapshot_id], evidenceIds: [], endedAt: at,
    }, null);
    return mk.attempt.attemptId;
  };
  const a1 = mkSiteAttempt(HTML_A, '2026-10-20T10:00:00.000Z');
  const a2 = mkSiteAttempt(HTML_A, '2026-10-20T18:00:00.000Z');

  // 意向：建立中，lastProbeAttemptId 指向第二次
  WIntent.requestIntent({ tenantId: tid, projectId: pid, competitorId: cid, reasonCode: 'no_direct_source' });
  WIntent.scheduleFirstProbe({ tenantId: tid, projectId: pid, competitorId: cid });

  const sc = WIntent.siteChangeEligibility(tid, pid, cid);
  assert.strictEqual(sc.attempts, 2, '两次官网采集: ' + JSON.stringify(sc));
  assert.strictEqual(sc.stable, true, '结构化字段稳定: ' + JSON.stringify(sc));
  assert.strictEqual(sc.eligible, true, 'site_change 可晋升: ' + JSON.stringify(sc));

  // onProbeFinished：无可比价格 → 走降级晋升
  const att = SurfaceStore.getAttempt(tid, a2);
  const r = WIntent.onProbeFinished({ tenantId: tid, projectId: pid, competitorId: cid, attempt: att });
  assert.strictEqual(r.action, 'promoted', '晋升而非 source_failed: ' + JSON.stringify(r).slice(0, 300));

  const intent = WIntent.findIntent(tid, pid, cid);
  assert.strictEqual(intent.state, 'promoted');
  const tg = WS.listWatchTargets(tid, pid).find(t => t.watchTargetId === intent.promotedTargetId);
  assert.deepStrictEqual(tg.enabledSignals, ['site_change'], 'enabledSignals 只有 site_change');
  assert.deepStrictEqual(tg.supportedSignals, ['site_change'], 'supportedSignals 只有 site_change');
  assert.ok(!/上新|库存/.test(String(intent.reasonText || '')), '不宣称上新/库存: ' + intent.reasonText);
});

test('S4b 升级方向：site_change Target 在发现稳定价格后可升级为 price，baseline 与时间线不丢', () => {
  const tid = 'tenant:sc08upgrade';
  const pid = 'projSC08Upgrade';
  const cid = 'c-upgrade-1';
  seedProject(tid, pid, [comp(cid, 'https://acme.example.com/', false)]);
  const t1 = makeSiteTarget(tid, pid, cid);
  WS.saveSiteBaseline({ tenantId: tid, projectId: pid, competitorId: cid, fingerprint: FP.buildFingerprint(HTML_A, 'https://acme.example.com/'), stability: { stable: true }, url: 'https://acme.example.com/' });
  const upd = WS.updateWatchTarget(tid, t1.watchTargetId, { enabledSignals: ['price'], supportedSignals: ['price', 'site_change'] });
  assert.deepStrictEqual(upd.enabledSignals, ['price'], '可升级为 price');
  assert.ok((upd.supportedSignals || []).includes('site_change'), 'supportedSignals 保留历史能力');
  assert.ok(WS.getSiteBaseline(tid, pid, cid), 'baseline 未丢失（时间线依据保留）');
});
