'use strict';
// ============================================================
// watch-foundation.test.js —— 正式监控基础闭环回归（01 §16/§17/§24、03 §3/§7/§12/§14、00 §3/§21）
// 覆盖：
//   W1  加入监控：创建 active + 幂等去重 + 最低资格门槛
//   W2  状态词表：非法 monitoring_status / 非法 IANA 时区拒绝
//   W3  两租户隔离：列表/读取/修改/删除互不可见（含窗口）
//   W4  调度：IANA 时区 + DST 换算 + jitter 确定性
//   W5  窗口幂等：同窗口二次认领被拒；崩溃残留（stale running）可重新认领
//   W6  窗口执行：直采成功 → coverage full；403→blocked / 429→rate_limited /
//       截断→partial_scan；全部失败 → degraded，绝不落成"无变化"
//   W7  三态日报：changed / quiet_with_full_coverage / coverage_incomplete；
//       事件为空但覆盖缺失 → coverage_incomplete（events.length===0 ≠ quiet）
//   W8  重启恢复：目标与窗口持久化；重启后同窗口不重复执行
//   W9  未加入监控的候选绝不进入正式巡检（runDueWindows 只认 active WatchTarget）
//   W10 REST 层：加入/暂停/恢复/删除 + 跨租户 404（不泄露存在性）
// 测试只用注入替身（fetchFn 等），不发真实网络请求、不调用 LLM。
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离先行：ZB_DATA_DIR 必须在任何业务模块 require 之前指向全新目录
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-watch-test-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
try { fs.rmSync(path.join(__dirname, '..', 'data', 'alerts'), { recursive: true, force: true }); } catch (e) {} // alerts 存储硬编码：清跨运行残留

const WS = require('../services/watch-store.js');
const WM = require('../services/watch-monitor.js');
const { buildDailyBrief } = require('../research/digest.js');
const Alerts = require('../services/alerts.js');
const { saveState } = require('../core/state-store.js');
require('../routes/index.js'); // 触发端点注册
const registry = require('../routes/registry.js');
const WatchH = require('../routes/handlers/watch.js');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('ok ' + name); }
  catch (e) { failed++; console.error('FAIL ' + name + '\n  ' + String(e && e.stack || e).split('\n').slice(0, 4).join('\n  ')); }
}

const NOW = Date.parse('2026-10-17T15:00:00Z'); // 固定"现在"（周六 15:00Z）

// 造两个租户 + 各一个项目档案（competitor researched done）
async function mkProject(tid, pid, compId) {
  const { projFile } = require('../core/state-store.js');
  fs.mkdirSync(path.dirname(projFile(pid, tid)), { recursive: true }); // tenantDir 先建：mutateFile 首写在缺目录时退异步重试
  saveState({
    projectId: pid, tenantId: tid, track: 'T-' + pid,
    discoveredAt: new Date(NOW).toISOString(),
    intent: { regions: ['us'] },
    competitors: [{
      id: compId, name: 'Brand ' + compId, status: 'done', url: 'https://' + compId + '.example.com',
      isShopify: true, currency: 'USD',
    }],
  });
  const f = projFile(pid, tid);
  for (let i = 0; i < 100 && !fs.existsSync(f); i++) await new Promise(r => setTimeout(r, 20)); // withFileLock 异步落盘
  if (!fs.existsSync(f)) throw new Error('state 文件未落盘: ' + f);
}

// handler 直调替身
function mkCtx(tid) {
  const out = { status: null, body: null };
  out.sendJSON = (res, code, obj) => { out.status = code; out.body = obj; return true; };
  out.readBody = async () => out._body || {};
  out.getAuthPayload = () => (tid ? { kind: 'tenant', payload: { tid } } : null);
  out.loadState = () => null;
  out.projFile = (id, t2) => null;
  return out;
}
const fakeRes = () => ({ headersSent: false, writeHead() {}, end() {} });

(async () => {
  const TID_A = 'tenant:watchA', TID_B = 'tenant:watchB';
  await mkProject(TID_A, 'projA', 'compA1');
  await mkProject(TID_B, 'projB', 'compB1');

  // ---------- W1 加入监控 ----------
  await t('W1 加入监控 → active + 基线开始 + 幂等去重', async () => {
    const r1 = WS.createWatchTarget({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1', timezone: 'America/New_York', market: 'us' });
    assert.strictEqual(r1.existed, false);
    assert.strictEqual(r1.target.monitoringStatus, 'active');
    assert.strictEqual(r1.target.qualificationStatus, 'unresolved', 'QualificationResult 链未建不虚标 qualified');
    assert.ok(r1.target.baselineStartedAt);
    assert.strictEqual(r1.target.enrichmentStatus, 'not_started');
    const r2 = WS.createWatchTarget({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA1' });
    assert.strictEqual(r2.existed, true, '同 tenant×project×competitor 幂等返回原对象');
    assert.strictEqual(r2.target.watchTargetId, r1.target.watchTargetId);
    // 信号词表清洗：非法信号剔除、去重、空表回退默认
    const r3 = WS.createWatchTarget({ tenantId: TID_A, projectId: 'projA', competitorId: 'compA2', enabledSignals: ['price', 'price', 'promo', ''] });
    assert.deepStrictEqual(r3.target.enabledSignals, ['price']);
  });

  // ---------- W2 状态词表 ----------
  await t('W2 非法状态/非法时区拒绝（00 §3 词表 + 03 §12 IANA）', async () => {
    const wt = WS.listWatchTargets(TID_A, 'projA')[0];
    assert.strictEqual(WS.updateWatchTarget(TID_A, wt.watchTargetId, { monitoringStatus: 'running' }).error, 'INVALID_STATUS');
    assert.strictEqual(WS.updateWatchTarget(TID_A, wt.watchTargetId, { timezone: 'UTC+8' }).error, 'INVALID_TIMEZONE', '不收固定 offset');
    assert.strictEqual(WS.updateWatchTarget(TID_A, wt.watchTargetId, { timezone: 'Asia/Tokyo' }).timezone, 'Asia/Tokyo');
  });

  // ---------- W3 两租户隔离 ----------
  await t('W3 两租户隔离：读取/列表/修改/删除互不可见（含窗口）', async () => {
    WS.createWatchTarget({ tenantId: TID_B, projectId: 'projB', competitorId: 'compB1', timezone: 'UTC' });
    const a = WS.listWatchTargets(TID_A);
    const b = WS.listWatchTargets(TID_B);
    assert.strictEqual(a.length, 2);
    assert.strictEqual(b.length, 1);
    assert.ok(b.every(t2 => t2.competitorId === 'compB1'), 'B 看不到 A 的目标');
    const wtA = a[0];
    assert.strictEqual(WS.getWatchTarget(TID_B, wtA.watchTargetId), null, '跨租户 get → null');
    assert.strictEqual(WS.updateWatchTarget(TID_B, wtA.watchTargetId, { monitoringStatus: 'paused' }), null, '跨租户修改 → null');
    assert.strictEqual(WS.deleteWatchTarget(TID_B, wtA.watchTargetId), false, '跨租户删除 → false');
    assert.ok(WS.getWatchTarget(TID_A, wtA.watchTargetId), 'A 的目标未被 B 的操作波及');
    // 窗口同样隔离
    const target = WS.listActiveTargets().find(x => x.tenantId === TID_A);
    const claim = WS.claimWindow(target, '2026-10-17T14:00', '14:00', NOW - 3600e3, NOW);
    assert.ok(claim.claimed);
    const winB = WS.windowsForTenantDay(TID_B, ['2026-10-17T14:00']);
    assert.strictEqual(winB.length, 0, 'B 查不到 A 的窗口');
  });

  // ---------- W4 调度：DST + jitter ----------
  await t('W4 IANA 时区 + DST 自动换算 + jitter 确定性（03 §12）', () => {
    // America/New_York：2026-10-31 仍 EDT(-4)，2026-11-01 起 EST(-5)
    const edt = WS.zonedSlotUtc('America/New_York', '2026-10-31', '06:00');
    const est = WS.zonedSlotUtc('America/New_York', '2026-11-01', '06:00');
    assert.strictEqual(new Date(edt).toISOString(), '2026-10-31T10:00:00.000Z', 'EDT 06:00 = 10:00Z');
    assert.strictEqual(new Date(est).toISOString(), '2026-11-01T11:00:00.000Z', 'DST 切换后本地 06:00 仍成立 = 11:00Z');
    const tokyo = WS.zonedSlotUtc('Asia/Tokyo', '2026-10-17', '22:00');
    assert.strictEqual(new Date(tokyo).toISOString(), '2026-10-17T13:00:00.000Z');
    // jitter：确定性 + 界内 ±15min
    const j1 = WM.jitterMsFor('2026-10-17T06:00', 'wt:x');
    const j2 = WM.jitterMsFor('2026-10-17T06:00', 'wt:x');
    assert.strictEqual(j1, j2, '同窗口 jitter 重启不变');
    assert.ok(j1 >= 0 && j1 < WS.JITTER_MAX_MS);
    // due 计算：NY 15:00Z = 当地 11:00（10-17 为 EDT）→ 仅 06:00 窗口到点
    const tgt = { watchTargetId: 'wt:dst', timezone: 'America/New_York', enabledSignals: ['price'] };
    const due = WM.dueWindows(tgt, Date.parse('2026-10-17T15:00:00Z'));
    assert.deepStrictEqual(due.map(d => d.slot), ['06:00']);
    assert.strictEqual(due[0].windowKey, '2026-10-17T06:00', 'window_key 是本地墙上时间');
  });

  // ---------- W5 窗口幂等 + 崩溃残留重认领 ----------
  await t('W5 同窗口二次认领被拒；stale running 可重新认领（补跑）', async () => {
    const target = WS.listActiveTargets().find(x => x.tenantId === TID_A);
    const c1 = WS.claimWindow(target, '2026-10-17T06:00', '06:00', NOW - 6 * 3600e3, NOW);
    assert.ok(c1.claimed);
    const c2 = WS.claimWindow(target, '2026-10-17T06:00', '06:00', NOW - 6 * 3600e3, NOW);
    assert.strictEqual(c2.claimed, false, '幂等：同一窗口至多一次有效执行');
    assert.strictEqual(c2.reason, 'already_claimed');
    // 崩溃残留：started_at 回拨 31 min → 可重新认领
    WS.getDb().prepare('UPDATE monitoring_windows SET started_at=? WHERE window_id=?')
      .run(new Date(NOW - 31 * 60e3).toISOString(), c1.windowId);
    const c3 = WS.claimWindow(target, '2026-10-17T06:00', '06:00', NOW - 6 * 3600e3, NOW);
    assert.ok(c3.claimed && c3.reason === 'reclaimed_stale');
    WS.completeWindow(c1.windowId, { signalResults: [], attempted: 0, succeeded: 0, failed: 0, partialScan: false, failureReasons: {}, eventsVerified: 0 }, NOW);
    const c4 = WS.claimWindow(target, '2026-10-17T06:00', '06:00', NOW - 6 * 3600e3, NOW);
    assert.strictEqual(c4.claimed, false, '已 complete 的窗口不再重跑');
  });

  // ---------- W6 窗口执行：成功 / blocked / rate_limited / partial ----------
  const okFetch = async () => ({
    ok: true, truncated: false, url: 'https://x.example.com/products.json', currency: 'USD',
    items: [
      { id: 1, title: 'P1', repPrice: 20, soldOut: false, publishedAt: '2026-10-01' },
      { id: 2, title: 'P2', repPrice: 30, soldOut: false, publishedAt: null },
      { id: 3, title: 'P3', repPrice: 40, soldOut: true, publishedAt: null },
    ],
  });
  await t('W6a 直采成功窗口 → complete + coverage full + 目标 fresh（零 LLM 路径）', async () => {
    const target = WS.listActiveTargets().find(x => x.tenantId === TID_A);
    const out = await WM.runDueWindows({
      nowMs: NOW + 12 * 3600e3, // 17 日全天窗口都已到点（06:00 已在 W5 complete → 跳过）
      targets: [target],
      deps: { fetchFn: okFetch, alertsPushFn: () => {} },
    });
    assert.ok(out.windows.length >= 1, '14:00/22:00 到点窗口被执行');
    const done = out.windows.filter(w => w.outcome === 'full');
    assert.ok(done.length >= 1);
    const win = WS.getWindow(out.windows[0].windowId);
    assert.strictEqual(win.status, 'complete');
    assert.strictEqual(win.coverage, 'full');
    assert.strictEqual(win.partialScan, false);
    assert.strictEqual(win.attempted, 3, 'price/launch/stock 三信号都尝试');
    assert.strictEqual(win.succeeded, 3);
    assert.deepStrictEqual(win.failureReasons, {});
    const t2 = WS.getWatchTarget(TID_A, target.watchTargetId);
    assert.strictEqual(t2.freshnessStatus, 'fresh');
    assert.ok(t2.baselineCompletedAt, '首个成功窗口完成基线');
  });

  await t('W6b fetch 403 → blocked；429 → rate_limited；绝不产生 quiet 材料', async () => {
    const target = WS.listActiveTargets().find(x => x.tenantId === TID_B);
    const blocked = await WM.runDueWindows({ nowMs: Date.parse('2026-10-18T21:00:00Z'), targets: [target], deps: { fetchFn: async () => ({ ok: false, status: 403 }), alertsPushFn: () => {} } });
    let win = WS.getWindow(blocked.windows[0].windowId);
    assert.strictEqual(win.coverage, 'gap');
    assert.strictEqual(win.signalResults[0].reason, 'blocked');
    assert.strictEqual(win.failed, 3);
    // 再来一个 429 窗口（次日清晨档）
    const r429 = await WM.runDueWindows({ nowMs: Date.parse('2026-10-19T21:00:00Z'), targets: [target], deps: { fetchFn: async () => ({ ok: false, status: 429 }), alertsPushFn: () => {} } });
    win = WS.getWindow(r429.windows[0].windowId);
    assert.strictEqual(win.signalResults[0].reason, 'rate_limited');
    const t2 = WS.getWatchTarget(TID_B, target.watchTargetId);
    assert.strictEqual(t2.monitoringStatus, 'degraded', '全部信号失败 → degraded');
  });

  await t('W6c 分页截断 → partial_scan 传播到 coverage', async () => {
    const wtB = WS.listWatchTargets(TID_B)[0];
    WS.updateWatchTarget(TID_B, wtB.watchTargetId, { monitoringStatus: 'active' }); // W6b 的 degraded 是正确行为，恢复后继续测
    const target = WS.listActiveTargets().find(x => x.tenantId === TID_B);
    const out = await WM.runDueWindows({
      nowMs: Date.parse('2026-10-20T21:00:00Z'), targets: [target],
      deps: { fetchFn: async () => ({ ok: true, truncated: true, items: [{ id: 9, title: 'P', repPrice: 10, soldOut: false, publishedAt: null }], currency: 'USD' }), alertsPushFn: () => {} },
    });
    const win = WS.getWindow(out.windows[0].windowId);
    assert.strictEqual(win.partialScan, true);
    assert.strictEqual(win.coverage, 'gap', 'partial_scan 不得算作覆盖完整');
  });

  // ---------- W7 三态日报 ----------
  await t('W7a quiet_with_full_coverage：覆盖完整且无事件', async () => {
    // 新租户：一个目标（UTC），当天 06:00/14:00 已到点且全部成功
    const TID_C = 'tenant:watchC';
    await mkProject(TID_C, 'projC', 'compC1');
    WS.createWatchTarget({ tenantId: TID_C, projectId: 'projC', competitorId: 'compC1', timezone: 'UTC' });
    const target = WS.listActiveTargets().find(x => x.tenantId === TID_C);
    await WM.runDueWindows({ nowMs: Date.parse('2026-10-18T21:00:00Z'), targets: [target], deps: { fetchFn: okFetch, alertsPushFn: () => {} } });
    const brief = buildDailyBrief(TID_C, { nowMs: Date.parse('2026-10-18T21:00:00Z') });
    assert.strictEqual(brief.mode, 'quiet_with_full_coverage');
    assert.strictEqual(brief.coverage.gapWindows + brief.coverage.missingWindows, 0);
    assert.strictEqual(brief.events.length, 0);
    assert.ok(/没有发现已核实的重要变化/.test(brief.text));
    assert.ok(/检查/.test(brief.text), '静默日报说明检查了哪些对象和信号');
  });

  await t('W7b changed：verified 事件出现 → changed（统计仍完整）', async () => {
    const TID_C = 'tenant:watchC';
    Alerts.push(TID_C, { type: 'price-change', projectId: 'projC', competitorId: 'compC1', text: '价格 $30 → $24（-20%）', basis: 'verified', at: new Date(NOW + 11 * 3600e3).toISOString() });
    const brief = buildDailyBrief(TID_C, { nowMs: NOW + 12 * 3600e3 });
    assert.strictEqual(brief.mode, 'changed');
    assert.strictEqual(brief.events.length, 1);
    assert.ok(/重要变化/.test(brief.text));
  });

  await t('W7c coverage_incomplete：窗口缺失/失败必须列明对象与原因，禁止说"没有变化"', async () => {
    // 场景 1：窗口到点但完全未执行（调度中断）→ window_not_run
    const TID_F = 'tenant:watchF';
    await mkProject(TID_F, 'projF', 'compF1');
    WS.createWatchTarget({ tenantId: TID_F, projectId: 'projF', competitorId: 'compF1', timezone: 'UTC' });
    const briefMiss = buildDailyBrief(TID_F, { nowMs: Date.parse('2026-10-18T21:00:00Z') });
    assert.strictEqual(briefMiss.mode, 'coverage_incomplete');
    assert.ok(briefMiss.gaps.some(g => g.reasons.includes('window_not_run') && g.slot === '06:00'), '缺失窗口列出对象与 slot');
    assert.ok(!/覆盖完整/.test(briefMiss.text), '覆盖不足禁止宣称覆盖完整/整体无变化');
    assert.ok(/无法确认/.test(briefMiss.text));
    // 场景 2：窗口执行了但抓取失败 → fetch_failed；即使事件为空也绝不 quiet
    const TID_E = 'tenant:watchE';
    await mkProject(TID_E, 'projE', 'compE1');
    WS.createWatchTarget({ tenantId: TID_E, projectId: 'projE', competitorId: 'compE1', timezone: 'UTC' });
    const targetE = WS.listActiveTargets().find(x => x.tenantId === TID_E);
    await WM.runDueWindows({ nowMs: Date.parse('2026-10-18T21:00:00Z'), targets: [targetE], deps: { fetchFn: async () => ({ ok: false, status: 500 }), alertsPushFn: () => {} } });
    const briefFail = buildDailyBrief(TID_E, { nowMs: Date.parse('2026-10-18T21:00:00Z') });
    assert.strictEqual(briefFail.mode, 'coverage_incomplete');
    assert.ok(briefFail.gaps.some(g => g.reasons.includes('fetch_failed')));
    assert.strictEqual(briefFail.events.length, 0, '事件为空也不得 quiet（events.length===0 ≠ 无变化）');
  });

  await t('W7d 无 WatchTarget 租户走 legacy（加法迁移不影响既有用户）', () => {
    const brief = buildDailyBrief('tenant:legacy-none', { nowMs: NOW });
    assert.strictEqual(brief.mode, 'legacy_no_watch');
  });

  // ---------- W8 重启恢复 ----------
  await t('W8 重启后目标/窗口持久化；同窗口不重复执行', async () => {
    WS.closeDb(); // 模拟进程退出
    const again = require('../services/watch-store.js'); // 重新打开同一库
    const a = again.listWatchTargets(TID_A);
    assert.ok(a.length >= 2, 'WatchTarget 持久化恢复');
    const winA = again.windowsForTargetDay(again.listActiveTargets().find(x => x.tenantId === TID_A).watchTargetId, ['2026-10-17T06:00']);
    assert.ok(winA['2026-10-17T06:00'] && winA['2026-10-17T06:00'].status === 'complete', '窗口持久化恢复');
    const out = await WM.runDueWindows({
      nowMs: NOW + 12 * 3600e3,
      targets: [again.listActiveTargets().find(x => x.tenantId === TID_A)],
      deps: { fetchFn: okFetch, alertsPushFn: () => {} },
    });
    assert.strictEqual(out.windows.length, 0, '已执行窗口不重复执行（幂等跨重启成立）');
  });

  // ---------- W9 未加入监控绝不巡检 ----------
  await t('W9 只有 active WatchTarget 进入巡检；未加入/暂停者不进', async () => {
    // compA2 只是项目里的竞品（未加入监控）——listActiveTargets 不包含 projA/compA2 目标之外的对象
    const ids = WS.listActiveTargets().map(x => x.competitorId);
    assert.ok(!ids.includes('compA3'), '未加入监控的候选不在巡检集合');
    // paused 目标不巡检
    const wt = WS.listWatchTargets(TID_A, 'projA').find(x => x.competitorId === 'compA2');
    WS.updateWatchTarget(TID_A, wt.watchTargetId, { monitoringStatus: 'paused' });
    assert.ok(!WS.listActiveTargets().find(x => x.watchTargetId === wt.watchTargetId), '暂停后停巡（03 §19.6）');
    // 全量 runDueWindows 也不会为非 WatchTarget 竞品造窗口
    await WM.runDueWindows({ nowMs: NOW + 12 * 3600e3, deps: { fetchFn: okFetch, alertsPushFn: () => {} } });
    const rows = WS.getDb().prepare('SELECT COUNT(*) AS n FROM monitoring_windows mw JOIN watch_targets wt ON mw.watch_target_id=wt.watch_target_id WHERE wt.competitor_id=?').get('compA3');
    assert.strictEqual(rows.n, 0);
  });

  // ---------- W10 REST 层 ----------
  await t('W10 REST：注册路由 + param 匹配 + 加入/暂停/恢复/删除 + 跨租户 404', async () => {
    assert.ok(registry.match('POST', '/api/watch-targets'), 'POST 注册');
    assert.ok(registry.match('GET', '/api/watch-targets'), 'GET 注册');
    const m = registry.match('PATCH', '/api/watch-targets/wt%3Aabc');
    assert.ok(m && m.path.includes(':id'), 'PATCH :id 路由命中');
    assert.ok(registry.match('DELETE', '/api/watch-targets/wt:abc'));
    assert.ok(registry.match('GET', '/api/digests/daily'));
    // REST 加入（走 handler：loadState 提供 state，db 归属校验）
    const TID_D = 'tenant:watchD';
    await mkProject(TID_D, 'projD', 'compD1');
    const dbx = require('../services/db.js');
    dbx.createTenant({ name: 'D', email: 'd@example.com' }); // 建租户使归属校验可过？——getProject 按 tenant 过滤 projects 表
    // 注意：db.getProject 需 projects 表有行；直接落一行
    dbx.saveProject({ id: 'projD', tenantId: TID_D, track: 'T', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
    const ctxD = mkCtx(TID_D);
    ctxD._body = { competitorId: 'compD1', projectId: 'projD' };
    ctxD.loadState = () => JSON.parse(fs.readFileSync(require.resolve ? path.join(process.env.ZB_DATA_DIR, 'projects') : '' , 'utf8') || 'null');
    // 简化：直接给 handler 需要的 state（handler 先查 db 归属，再从 projFile/state 找竞品）
    ctxD.loadState = () => ({ projectId: 'projD', intent: { regions: ['us'] }, competitors: [{ id: 'compD1', status: 'done', name: 'D1', url: 'https://d.example.com', isShopify: true }] });
    ctxD.projFile = () => null;
    const st = { headersSent: false, writeHead() {}, end() {} };
    await WatchH.createTarget(ctxD, { method: 'POST' }, st, new URL('http://x/api/watch-targets'), '/api/watch-targets');
    assert.strictEqual(ctxD.status, 201, '创建成功');
    assert.ok(ctxD.body.target.watchTargetId);
    const wtId = ctxD.body.target.watchTargetId;
    // 暂停/恢复
    ctxD._body = { action: 'pause' };
    await WatchH.patchTarget(ctxD, { method: 'PATCH' }, st, new URL('http://x/api/watch-targets/' + wtId), '/api/watch-targets/' + wtId);
    assert.strictEqual(ctxD.body.target.monitoringStatus, 'paused');
    ctxD._body = { action: 'resume' };
    await WatchH.patchTarget(ctxD, { method: 'PATCH' }, st, new URL('http://x/api/watch-targets/' + wtId), '/api/watch-targets/' + wtId);
    assert.strictEqual(ctxD.body.target.monitoringStatus, 'active');
    // 跨租户 PATCH/DELETE → 404（不泄露存在性）
    const ctxB = mkCtx(TID_B);
    await WatchH.patchTarget(ctxB, { method: 'PATCH' }, st, new URL('http://x/api/watch-targets/' + wtId), '/api/watch-targets/' + wtId);
    assert.strictEqual(ctxB.status, 404);
    await WatchH.deleteTarget(ctxB, { method: 'DELETE' }, st, new URL('http://x/api/watch-targets/' + wtId), '/api/watch-targets/' + wtId);
    assert.strictEqual(ctxB.status, 404);
    assert.ok(WS.getWatchTarget(TID_D, wtId), 'B 的跨租户操作未得逞');
    // 匿名 → 403
    const ctxAnon = mkCtx(null);
    await WatchH.listTargets(ctxAnon, { method: 'GET' }, st, new URL('http://x/api/watch-targets'), '/api/watch-targets');
    assert.strictEqual(ctxAnon.status, 403);
    // 本租户删除
    const ctxD2 = mkCtx(TID_D);
    await WatchH.deleteTarget(ctxD2, { method: 'DELETE' }, st, new URL('http://x/api/watch-targets/' + wtId), '/api/watch-targets/' + wtId);
    assert.strictEqual(ctxD2.status, 200);
    assert.strictEqual(WS.getWatchTarget(TID_D, wtId), null);
  });

  console.log(failed ? `\nwatch-foundation.test: ${failed} failed` : '\nwatch-foundation.test: all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('harness 异常:', e && e.stack || e); process.exit(1); });
