'use strict';
// ============================================================
// test/sc10.test.js —— SC-10 测试服真实数据闭环与监控引擎收敛（r1）
// ------------------------------------------------------------
// U1  正式监控的价格变化统一经 observation-diff（行为 + 事件字段）
// U2  源码级：watch-monitor 不再自算/自写价格变化（无第二套 Diff）
// U3  旧历史记录缺范围字段 → fail-closed（unknown+unknown ≠ 范围相同）
// U4  事件写库失败：不提醒、不计已核实、不推进监控基线，下个窗口可重试
// U5  币种变化不可直接比较（不跨币种换算）
// U6  两租户监控链路隔离
// U7  partial 监控：不下架结论；首采批次号不得充当监控窗口
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc10-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.ZB_FIRST_COLLECTION_DISABLED = '1';
process.env.CACHE_ENABLED = '0';

const WS = require('../services/watch-store.js');
const WatchMonitor = require('../services/watch-monitor.js');
const Inbox = require('../services/intel-inbox.js');
const Diff = require('../services/observation-diff.js');
const { projFile, mirrorProjectToDb } = require('../core/state-store.js');
const db = require('../services/db.js');

const HOST = 'sc10-acme';
function comp(id, n, isShopify) {
  return {
    id, name: 'Brand' + n, url: `https://${HOST}-${n}.example.com/`, status: 'done',
    isShopify: !!isShopify, market: 'us', relation: 'competitor', category: 'outdoor',
  };
}
function seedProject(tenantId, projectId, comps) {
  try { db.createTenant({ name: 't-' + tenantId, email: tenantId.replace(/[^a-z0-9]/gi, '') + '@example.com' }); } catch (e) {}
  try {
    db.saveProject({ id: projectId, tenantId, track: 'T-' + projectId, competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  } catch (e) {}
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    tenantId, projectId, intent: { regions: ['us'], category: 'outdoor' }, excluded: [],
    competitors: comps, discoverDone: true, progress: { total: comps.length, done: comps.length },
  }, null, 2));
  try { mirrorProjectToDb(projectId, tenantId, 'SC10'); } catch (e) {}
}
function target(tid, pid, cid, signals) {
  return WS.createWatchTarget({
    tenantId: tid, projectId: pid, competitorId: cid,
    market: 'us', timezone: 'UTC', enabledSignals: signals || ['price'], supportedSignals: signals || ['price'],
    enrichmentStatus: 'complete',
  }).target;
}
function publicSiteFnOf(items, opt) {
  const o = opt || {};
  return async (c) => ({
    ok: true, items,
    currency: o.currency || 'USD', partialScan: !!o.partialScan,
    snapshotIds: o.snapshotIds || ['snap-mon'], sourceUrl: c.url,
  });
}
const it = (id, price, extra) => Object.assign({ id, title: 'P' + id, repPrice: price, soldOut: false }, extra || {});

// ============================================================
// U1：正式监控价格变化统一经 observation-diff
// ============================================================
test('U1 正式监控价格变化：首窗只建基线，第二窗经统一 Diff 写事件（origin/windowKey 真实）', async () => {
  const tid = 'tenant:sc10u1', pid = 'projSC10U1', cid = 'c-u1';
  seedProject(tid, pid, [comp(cid, 1, false)]);
  const t = target(tid, pid, cid);

  const w1 = WS.claimWindow(t, 'U1-W1', '06:00', Date.now(), Date.now());
  const r1 = await WatchMonitor.executeWindow(t, w1.windowId, { publicSiteFn: publicSiteFnOf([it('p-1', 30)]) }, Date.now());
  assert.strictEqual(r1.failed, 0, '首窗采集成功');
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0, '首次观察只建基线');
  assert.strictEqual(WS.listProductPrices(tid, pid, cid).length, 1, '基线已落价格快照');

  const w2 = WS.claimWindow(t, 'U1-W2', '14:00', Date.now(), Date.now());
  const r2 = await WatchMonitor.executeWindow(t, w2.windowId, { publicSiteFn: publicSiteFnOf([it('p-1', 41)]) }, Date.now());
  assert.strictEqual(r2.eventsVerified, 1, '第二窗 1 条已核实变化: ' + JSON.stringify({ v: r2.eventsVerified, p: r2.eventsPending, f: r2.eventsWriteFailed }));
  const box = Inbox.listInbox({ tenantId: tid, projectId: pid });
  const ev = box.groups[0].events[0];
  assert.strictEqual(ev.eventType, 'price_changed');
  assert.strictEqual(ev.origin, 'monitoring', 'origin 恒为 monitoring');
  assert.strictEqual(ev.windowKey, w2.windowId, 'windowKey 来自真实监控窗口');
  assert.strictEqual(ev.change.oldValue, 30);
  assert.strictEqual(ev.change.newValue, 41);
  assert.ok((ev.evidenceRefs || []).some(r => r.snapshotId === 'snap-mon'), '证据引用本次真实快照');
  // 基线前移：价格快照更新为 41
  assert.strictEqual(WS.listProductPrices(tid, pid, cid)[0].price, 41, '基线前移到新价');
});

// ============================================================
// U2：源码级 —— 监控里只剩一套变化检测
// ============================================================
test('U2 源码级：watch-monitor 不得保留自算/自写价格变化的第二套实现', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'watch-monitor.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  // 监控可以 require 收件箱，但只能作为**注入给 observation-diff 的依赖**，
  // 绝不能自己调用 recordEvent（否则又变成第二套写入实现）
  assert.ok(!/\.recordEvent\s*\(/.test(code), '监控不得直接调用 recordEvent');
  assert.ok(!/applyProductSnapshot\s*\(/.test(code), '监控不得再自算单品涨跌');
  assert.ok(!/applyPriceChange/.test(code), '旧的自写价格事件函数必须删除');
  assert.ok(/Diff\.applyChanges|Diff\.recordMonitoringEvent/.test(code), '监控必须调用统一入口');
  assert.ok(/Diff\.classifyInboxResult/.test(code), '写入结果分类也必须复用统一口径');
  // 队列侧同样只允许经 observation-diff 写收件箱
  const jobs = fs.readFileSync(path.join(__dirname, '..', 'services', 'collect-jobs.js'), 'utf8');
  assert.ok(/observation-diff/.test(jobs), '队列侧也走 observation-diff');
});

// ============================================================
// U3：旧历史记录缺范围字段 → 默认不可比较
// ============================================================
test('U3 旧数据缺 discoveryPath / 方法 / 渠道：一律不可比，不产生下架或数量下降', () => {
  const mk = (status, obs, summary, capability) => ({
    attemptId: 'a-' + Math.random().toString(36).slice(2), capability, status,
    observations: obs, summary: summary || {}, snapshotIds: ['s'], evidenceIds: [],
  });
  const prods = (n) => Array.from({ length: n }, (_, i) => ({ id: 'p-' + i, title: 'I' + i, price: 100 + i, currency: 'USD', available: true }));
  // 旧 attempt：无 discoveryPath；本次：有 sitemap 且完整
  const oldP = mk('success', prods(10), { productCount: 10, measurementMethod: 'public_source_observation' }, 'public_site_products');
  const newP = mk('success', prods(3), { productCount: 3, discoveryPath: 'sitemap', measurementMethod: 'public_source_observation' }, 'public_site_products');
  const changes = Diff.computeChanges('public_site_products', oldP, newP);
  assert.strictEqual(changes.filter(c => c.eventType === 'product_removed').length, 0, '旧数据缺发现路径 → 不得推断下架');
  assert.strictEqual(Diff.sameComparisonScope(Diff.coverageProfile(oldP), Diff.coverageProfile(newP), 'public_site_products'), false, '一侧缺失 = 范围不一致');

  // unknown + unknown ≠ 相同
  const a = mk('success', [], { discoveryPath: 'unknown', measurementMethod: 'public_source_observation' }, 'public_site_products');
  const b = mk('success', [], { discoveryPath: 'unknown', measurementMethod: 'public_source_observation' }, 'public_site_products');
  assert.strictEqual(Diff.sameComparisonScope(Diff.coverageProfile(a), Diff.coverageProfile(b), 'public_site_products'), false, 'unknown+unknown 不等于范围相同');

  // YouTube 旧 attempt 无频道身份 → 不可比
  const v = (n) => Array.from({ length: n }, (_, i) => ({ id: 'v' + i, title: 'V' + i }));
  const oldV = mk('success', v(20), { videoCount: 20, measurementMethod: 'youtube_public_api' }, 'youtube_content');
  const newV = mk('success', v(10), { videoCount: 10, measurementMethod: 'youtube_public_api' }, 'youtube_content');
  assert.strictEqual(Diff.computeChanges('youtube_content', oldV, newV).length, 0, '缺频道身份 → 不下数量结论');
  // 补上同一频道身份 + 方法 → 可比（下降成立）
  const oldV2 = mk('success', v(20), { videoCount: 20, measurementMethod: 'youtube_public_api', channelId: 'UC-1' }, 'youtube_content');
  const newV2 = mk('success', v(10), { videoCount: 10, measurementMethod: 'youtube_public_api', channelId: 'UC-1' }, 'youtube_content');
  assert.strictEqual(Diff.computeChanges('youtube_content', oldV2, newV2).length, 1, '范围明确且一致 → 允许数量结论');
});

// ============================================================
// U4：事件写库失败 → 不提醒、不计已核实、不推进基线；下窗可重试
// ============================================================
test('U4 事件写库失败：基线不前移、不发提醒、窗口记缺口；恢复后下窗重试成功', async () => {
  const tid = 'tenant:sc10u4', pid = 'projSC10U4', cid = 'c-u4';
  seedProject(tid, pid, [comp(cid, 4, false)]);
  const t = target(tid, pid, cid);

  const w1 = WS.claimWindow(t, 'U4-W1', '06:00', Date.now(), Date.now());
  await WatchMonitor.executeWindow(t, w1.windowId, { publicSiteFn: publicSiteFnOf([it('p-1', 30)]) }, Date.now());
  assert.strictEqual(WS.listProductPrices(tid, pid, cid)[0].price, 30, '基线 30');

  // 第二窗：真实价格变化，但收件箱写入失败
  const alerts = [];
  const brokenInbox = { recordEvent: () => ({ recorded: false, reason: 'WRITE_FAILED:forced' }) };
  const w2 = WS.claimWindow(t, 'U4-W2', '14:00', Date.now(), Date.now());
  const r2 = await WatchMonitor.executeWindow(t, w2.windowId, {
    publicSiteFn: publicSiteFnOf([it('p-1', 41)]),
    inboxFn: brokenInbox,
    alertsPushFn: (tt, a) => alerts.push(a),
  }, Date.now());
  assert.strictEqual(r2.eventsWriteFailed, 1, '如实登记写失败: ' + JSON.stringify(r2));
  assert.strictEqual(r2.eventsVerified, 0, '写失败绝不计入已核实');
  assert.strictEqual(alerts.length, 0, '写失败不发提醒');
  assert.strictEqual(r2.partialScan, true, '窗口必须显示覆盖缺口，不得记为完全成功');
  assert.strictEqual(WS.listProductPrices(tid, pid, cid)[0].price, 30, '基线保持旧值 → 下窗可以重试这次变化');
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0);

  // 第三窗：写入恢复 → 同一变化必须能被重试出来
  const w3 = WS.claimWindow(t, 'U4-W3', '22:00', Date.now(), Date.now());
  const r3 = await WatchMonitor.executeWindow(t, w3.windowId, { publicSiteFn: publicSiteFnOf([it('p-1', 41)]) }, Date.now());
  assert.strictEqual(r3.eventsVerified, 1, '恢复后重试成功: ' + JSON.stringify(r3));
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 1);
  assert.strictEqual(WS.listProductPrices(tid, pid, cid)[0].price, 41, '成功后基线才前移');
});

// ============================================================
// U5：币种变化不可直接比较
// ============================================================
test('U5 币种变化不可直接比较：零涨跌事件、零提醒，不跨币种换算', async () => {
  const tid = 'tenant:sc10u5', pid = 'projSC10U5', cid = 'c-u5';
  seedProject(tid, pid, [comp(cid, 5, true)]);
  const t = target(tid, pid, cid);
  const fetchOf = (price, currency) => async () => ({
    ok: true, truncated: false, url: 'https://shop.example.com/products.json', currency,
    snapshotIds: ['snap-u5'], snapshotId: 'snap-u5',
    items: [it('p-1', price)],
  });
  const alerts = [];
  const deps = (f) => ({ fetchFn: f, alertsPushFn: (tt, a) => alerts.push(a) });

  const w1 = WS.claimWindow(t, 'U5-W1', '06:00', Date.now(), Date.now());
  await WatchMonitor.executeWindow(t, w1.windowId, deps(fetchOf(20, 'USD')), Date.now());
  // 币种改为 EUR 且价格数值变小：若跨币种比较会误报「降价」
  const w2 = WS.claimWindow(t, 'U5-W2', '14:00', Date.now(), Date.now());
  const r2 = await WatchMonitor.executeWindow(t, w2.windowId, deps(fetchOf(18, 'EUR')), Date.now());
  assert.strictEqual(r2.eventsVerified, 0, '跨币种不比较: ' + JSON.stringify(r2));
  assert.strictEqual(r2.eventsPending, 0);
  assert.strictEqual(alerts.filter(a => a.type === 'price-change').length, 0, '跨币种不发涨跌提醒');
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0);
  // 同币种真实变价仍然成立
  const w3 = WS.claimWindow(t, 'U5-W3', '22:00', Date.now(), Date.now());
  const r3 = await WatchMonitor.executeWindow(t, w3.windowId, deps(fetchOf(24, 'EUR')), Date.now());
  assert.strictEqual(r3.eventsVerified, 1, '同币种真实变价成事件: ' + JSON.stringify(r3));
});

// ============================================================
// U6：两租户监控链路隔离
// ============================================================
test('U6 两租户监控：事件、基线、窗口互不可见', async () => {
  const A = { tid: 'tenant:sc10u6a', pid: 'projU6A', cid: 'c-u6a' };
  const B = { tid: 'tenant:sc10u6b', pid: 'projU6B', cid: 'c-u6b' };
  seedProject(A.tid, A.pid, [comp(A.cid, 6, false)]);
  seedProject(B.tid, B.pid, [comp(B.cid, 7, false)]);
  const ta = target(A.tid, A.pid, A.cid), tb = target(B.tid, B.pid, B.cid);
  for (const [s, t] of [[A, ta], [B, tb]]) {
    const w1 = WS.claimWindow(t, 'U6-' + s.tid + '-W1', '06:00', Date.now(), Date.now());
    await WatchMonitor.executeWindow(t, w1.windowId, { publicSiteFn: publicSiteFnOf([it('p-1', 30)]) }, Date.now());
    const w2 = WS.claimWindow(t, 'U6-' + s.tid + '-W2', '14:00', Date.now(), Date.now());
    await WatchMonitor.executeWindow(t, w2.windowId, { publicSiteFn: publicSiteFnOf([it('p-1', 55)]) }, Date.now());
  }
  const boxA = Inbox.listInbox({ tenantId: A.tid, projectId: A.pid });
  const boxB = Inbox.listInbox({ tenantId: B.tid, projectId: B.pid });
  assert.strictEqual(boxA.total, 1);
  assert.strictEqual(boxB.total, 1);
  const evA = boxA.groups[0].events[0], evB = boxB.groups[0].events[0];
  assert.notStrictEqual(evA.eventId, evB.eventId);
  assert.strictEqual(evA.competitorId, A.cid);
  assert.strictEqual(evB.competitorId, B.cid);
  assert.strictEqual(WS.listProductPrices(A.tid, A.pid, A.cid).length, 1);
  assert.strictEqual(WS.listProductPrices(B.tid, B.pid, B.cid).length, 1);
  assert.strictEqual(WS.listProductPrices(A.tid, A.pid, B.cid).length, 0, 'A 租户读不到 B 的价格基线');
  // 跨租户用 B 的身份查 A 的事件 → 空
  assert.strictEqual(Inbox.listInbox({ tenantId: A.tid, projectId: B.pid }).total, 0);
});

// ============================================================
// U7：partial 监控不下架；首采批次号不得充当监控窗口
// ============================================================
test('U7 partial 监控零下架；first_collection:* 窗口被拒收', async () => {
  const tid = 'tenant:sc10u7', pid = 'projSC10U7', cid = 'c-u7';
  seedProject(tid, pid, [comp(cid, 7, false)]);
  const t = target(tid, pid, cid);
  const many = Array.from({ length: 6 }, (_, i) => it('p-' + i, 100 + i));
  const w1 = WS.claimWindow(t, 'U7-W1', '06:00', Date.now(), Date.now());
  await WatchMonitor.executeWindow(t, w1.windowId, { publicSiteFn: publicSiteFnOf(many) }, Date.now());
  // 第二次只抓到 2 件且标 partial：不得写「4 件下架」
  const w2 = WS.claimWindow(t, 'U7-W2', '14:00', Date.now(), Date.now());
  const r2 = await WatchMonitor.executeWindow(t, w2.windowId, {
    publicSiteFn: publicSiteFnOf([it('p-0', 100), it('p-1', 130)], { partialScan: true }),
  }, Date.now());
  const evs = Inbox.listInbox({ tenantId: tid, projectId: pid }).groups.flatMap(g => g.events);
  assert.strictEqual(evs.filter(e => e.eventType === 'product_removed').length, 0, 'partial 不产下架');
  assert.strictEqual(evs.filter(e => e.eventType === 'price_changed').length, 1, '同 ID 价格变化仍记录');
  assert.strictEqual(evs[0].change.scopeLimited, true, '事件标注范围受限');
  assert.ok(r2.eventsVerified >= 1);

  // 首采批次号不是监控窗口
  const res = Diff.applyChanges({
    tenantId: tid, projectId: pid, competitorId: cid, capability: 'public_site_products',
    collectionPurpose: 'monitoring', windowKey: 'first_collection:fcb_xxx',
    attempt: { attemptId: 'a1', status: 'success', observations: [{ id: 'p-0', price: 1, currency: 'USD' }], summary: {}, snapshotIds: [] },
    previousAttempt: { attemptId: 'a0', status: 'success', observations: [{ id: 'p-0', price: 2, currency: 'USD' }], summary: {}, snapshotIds: [] },
  });
  assert.strictEqual(res.reason, 'invalid_window_key', '首采批次号被拒收');
  assert.strictEqual(res.recorded, 0);
});
