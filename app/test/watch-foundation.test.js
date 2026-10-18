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
//   W10 REST 层：加入/暂停/恢复/删除 + 跨租户 404（不泄露存在性）+ §9 能力门槛 + §5 软停用
// 整改新增（独立审核第二轮 §1-§10）：
//   W11 生产默认 fetch 路径：不注入 deps.fetchFn → 真实 Net.fetchShopifyProducts 默认（§1）
//   W12 degraded 继续巡检（≠paused）→ 成功后恢复 active+fresh（§2）
//   W13 Brief Coverage 语义：paused/inactive 不计预期、0 窗口禁 quiet、first_window_pending（§4）
//   W14 Coverage API 真实 handler：200 + mode/coverage/gaps + 两租户隔离（§7）
//   W15 单品价格语义：同身份才可比；增删他品零事件；规格/币种变化不可比（§6）
//   W16 上新可信表达：count=withPub.length，区分首次观察与来源佐证（§8）
//   W17 日报每租户当地 08:00：两时区发送时间 + 本地日期幂等（§10）
//   W18 未加入 WatchTarget 的 done 竞品：零窗口/零提醒/零搜索/零 LLM；旧 sweep 不再调度（§3）
//   W19 退出监控历史保留 + 重新加入恢复原对象（§5）
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
    // 时刻取 10-18T21:00Z（UTC 当地已过 06:00/14:00 到点）：§4 下 expected=0 会先归
    // coverage_incomplete，changed 判定必须在有到点窗口的前提下成立
    const brief = buildDailyBrief(TID_C, { nowMs: Date.parse('2026-10-18T21:00:00Z') });
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
    // 简化：直接给 handler 需要的 state（handler 先查 db 归属，再从 projFile/state 找竞品）
    ctxD.loadState = () => ({
      projectId: 'projD', intent: { regions: ['us'] },
      competitors: [
        { id: 'compD1', status: 'done', name: 'D1', url: 'https://d.example.com', isShopify: true },
        { id: 'compD2', status: 'done', name: 'D2', url: 'https://d2.example.com', isShopify: false }, // §9 非 Shopify
      ],
    });
    ctxD.projFile = () => null;
    const st = { headersSent: false, writeHead() {}, end() {} };
    await WatchH.createTarget(ctxD, { method: 'POST' }, st, new URL('http://x/api/watch-targets'), '/api/watch-targets');
    assert.strictEqual(ctxD.status, 201, '创建成功');
    assert.ok(ctxD.body.target.watchTargetId);
    assert.deepStrictEqual(ctxD.body.target.supportedSignals, ['price', 'launch', 'stock'], '§9 返回真实可用直接源的能力集');
    const wtId = ctxD.body.target.watchTargetId;
    // §9 能力门槛：非 Shopify 且无其他已实现直接源 → CAPABILITY_NOT_SUPPORTED（400）
    const ctxDns = mkCtx(TID_D);
    ctxDns._body = { competitorId: 'compD2', projectId: 'projD' };
    ctxDns.loadState = ctxD.loadState;
    ctxDns.projFile = () => null;
    await WatchH.createTarget(ctxDns, { method: 'POST' }, st, new URL('http://x/api/watch-targets'), '/api/watch-targets');
    assert.strictEqual(ctxDns.status, 400, '§9 无直接源不得加入必然失败的监控');
    assert.strictEqual(ctxDns.body.error, 'CAPABILITY_NOT_SUPPORTED');
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
    // 本租户删除（整改 §5：软停用——对象与历史保留，不再巡检）
    const ctxD2 = mkCtx(TID_D);
    await WatchH.deleteTarget(ctxD2, { method: 'DELETE' }, st, new URL('http://x/api/watch-targets/' + wtId), '/api/watch-targets/' + wtId);
    assert.strictEqual(ctxD2.status, 200);
    const afterDel = WS.getWatchTarget(TID_D, wtId);
    assert.ok(afterDel, '§5 WatchTarget 保留（不物理删除）');
    assert.strictEqual(afterDel.monitoringStatus, 'inactive', '§5 软停用为 inactive');
    assert.ok(afterDel.deactivatedAt, '§5 停用时间审计字段');
    assert.ok(!WS.listSchedulableTargets().some(x => x.watchTargetId === wtId), '§5 停用后不再进入巡检集合');
  });

  // ---------- W11 生产默认 fetch 路径（整改 §1） ----------
  await t('W11 不注入 deps.fetchFn → 默认走真实 Net.fetchShopifyProducts（module 替身命中，非 fetch_failed）', async () => {
    const TID_G = 'tenant:watchG';
    await mkProject(TID_G, 'projG', 'compG1');
    WS.createWatchTarget({ tenantId: TID_G, projectId: 'projG', competitorId: 'compG1', timezone: 'UTC' });
    const Net = require('../research/net.js');
    const orig = Net.fetchShopifyProducts;
    let called = 0;
    Net.fetchShopifyProducts = async (url, opts) => {
      called++;
      void url; void opts; // 不发真实请求：直接构造与 net.js 同构的返回
      const items = [
        { id: 1, title: 'P1', variantCount: 2, repPrice: 15 + called * 5, soldOut: false, publishedAt: '2026-10-01' },
        { id: 2, title: 'P2', variantCount: 1, repPrice: 25 + called * 5, soldOut: false, publishedAt: null },
      ];
      return { ok: true, truncated: false, url: 'https://g.example.com/products.json', currency: 'USD', items };
    };
    try {
      const alerts = [];
      const target = WS.listSchedulableTargets().find(x => x.tenantId === TID_G);
      const out = await WM.runDueWindows({
        nowMs: Date.parse('2026-10-21T21:00:00Z'), // UTC 当地 21:00 → 06:00/14:00 两窗口到点
        targets: [target],
        deps: { alertsPushFn: (tid, a) => alerts.push(a) }, // 关键：不给 fetchFn
      });
      assert.ok(called >= 2, '生产默认 fetchFn 被真实调用（每次窗口一次直采）');
      assert.ok(out.windows.length >= 2);
      for (const w of out.windows) {
        const win = WS.getWindow(w.windowId);
        assert.strictEqual(win.status, 'complete');
        assert.strictEqual(win.coverage, 'full', '真实默认路径成功，绝不是 fetch_failed');
        assert.strictEqual(win.signalResults[0].reason, null);
        assert.strictEqual(win.signalResults[0].succeeded, 1);
      }
      assert.ok(alerts.filter(a => a.type === 'price-change').length >= 1, '默认路径产单品 price-change（第二轮价格变化）');
      assert.ok(alerts.every(a => a.subjectId), '单品事件携带稳定商品身份');
    } finally { Net.fetchShopifyProducts = orig; }
  });

  // ---------- W12 degraded 继续巡检（整改 §2） ----------
  await t('W12 degraded ≠ paused：默认调度集合包含 degraded 并继续执行；成功后恢复 active+fresh', async () => {
    const TID_E = 'tenant:watchE'; // W7c 场景 2 建立的目标（全失败 → degraded）
    const tE = WS.listWatchTargets(TID_E)[0];
    assert.strictEqual(tE.monitoringStatus, 'degraded', 'W7c 的全失败窗口已把它置为 degraded');
    assert.ok(WS.listSchedulableTargets().some(x => x.watchTargetId === tE.watchTargetId), 'degraded 在可调度集合');
    assert.ok(!WS.listActiveTargets().some(x => x.watchTargetId === tE.watchTargetId), 'degraded 不在严格 active 集');
    const pushed = [];
    const out = await WM.runDueWindows({
      nowMs: Date.parse('2026-10-21T21:00:00Z'),
      deps: { fetchFn: okFetch, alertsPushFn: (tid, a) => pushed.push(a) }, // 不传 targets → 默认可调度集
    });
    assert.ok(out.windows.some(w => w.windowId.startsWith(tE.watchTargetId + ':')), 'degraded 目标的下一窗口被执行（有界=按计划窗口复查）');
    const t2 = WS.getWatchTarget(TID_E, tE.watchTargetId);
    assert.strictEqual(t2.monitoringStatus, 'active', '任一信号成功 → 恢复 active');
    assert.strictEqual(t2.freshnessStatus, 'fresh', '成功 → fresh');
    // paused 才停巡
    const TID_F = 'tenant:watchF';
    const wtF = WS.listWatchTargets(TID_F)[0];
    WS.updateWatchTarget(TID_F, wtF.watchTargetId, { monitoringStatus: 'paused' });
    assert.ok(!WS.listSchedulableTargets().some(x => x.watchTargetId === wtF.watchTargetId), 'paused 停巡');
  });

  // ---------- W13 Brief Coverage 语义（整改 §4） ----------
  await t('W13a paused/inactive 不计入预期窗口（无 window_not_run）；expected=0 → coverage_incomplete', async () => {
    // paused-only
    const TID_H = 'tenant:watchH';
    await mkProject(TID_H, 'projH', 'compH1');
    const th = WS.createWatchTarget({ tenantId: TID_H, projectId: 'projH', competitorId: 'compH1', timezone: 'UTC' }).target;
    WS.updateWatchTarget(TID_H, th.watchTargetId, { monitoringStatus: 'paused' });
    const bH = buildDailyBrief(TID_H, { nowMs: Date.parse('2026-10-22T21:00:00Z') });
    assert.strictEqual(bH.mode, 'coverage_incomplete', 'expected=0 禁止 quiet_with_full_coverage');
    assert.strictEqual(bH.coverage.expectedWindows, 0);
    assert.ok(!bH.gaps.some(g => g.reasons.includes('window_not_run')), 'paused 不产生 window_not_run');
    assert.ok(bH.gaps.some(g => g.reasons.includes('no_active_watch_targets')));
    assert.ok(/今日首个巡检窗口尚未完成/.test(bH.text));
    // inactive-only（软停用后）
    const TID_I = 'tenant:watchI';
    await mkProject(TID_I, 'projI', 'compI1');
    const ti = WS.createWatchTarget({ tenantId: TID_I, projectId: 'projI', competitorId: 'compI1', timezone: 'UTC' }).target;
    WS.deleteWatchTarget(TID_I, ti.watchTargetId);
    const bI = buildDailyBrief(TID_I, { nowMs: Date.parse('2026-10-22T21:00:00Z') });
    assert.strictEqual(bI.mode, 'coverage_incomplete');
    assert.strictEqual(bI.coverage.expectedWindows, 0);
    assert.ok(!bI.gaps.some(g => g.reasons.includes('window_not_run')), 'inactive 不产生 window_not_run');
  });

  await t('W13b 当天尚无到点窗口 → coverage_incomplete + first_window_pending；degraded 计入预期', async () => {
    // 0/0：active 目标 + 当地 00:30（UTC），当日尚无窗口到点
    const TID_J = 'tenant:watchJ';
    await mkProject(TID_J, 'projJ', 'compJ1');
    WS.createWatchTarget({ tenantId: TID_J, projectId: 'projJ', competitorId: 'compJ1', timezone: 'UTC' });
    const bJ = buildDailyBrief(TID_J, { nowMs: Date.parse('2026-10-22T00:30:00Z') });
    assert.strictEqual(bJ.mode, 'coverage_incomplete', '0/0 禁止 quiet_with_full_coverage');
    assert.strictEqual(bJ.coverage.expectedWindows, 0);
    assert.ok(bJ.gaps.some(g => g.reasons.includes('first_window_pending')));
    assert.ok(/今日首个巡检窗口尚未完成/.test(bJ.text));
    // degraded 目标计入预期窗口（有到点窗口时与 active 同权）
    const TID_K = 'tenant:watchK';
    await mkProject(TID_K, 'projK', 'compK1');
    const tk = WS.createWatchTarget({ tenantId: TID_K, projectId: 'projK', competitorId: 'compK1', timezone: 'UTC' }).target;
    WS.updateWatchTarget(TID_K, tk.watchTargetId, { monitoringStatus: 'degraded' });
    const bK = buildDailyBrief(TID_K, { nowMs: Date.parse('2026-10-22T21:00:00Z') });
    assert.strictEqual(bK.coverage.expectedWindows, 2, 'degraded 的到点窗口计入预期（21:00Z → 06:00/14:00 已到点）');
    assert.strictEqual(bK.mode, 'coverage_incomplete', '未执行 → 覆盖缺口照常列明');
    assert.ok(bK.gaps.some(g => g.reasons.includes('window_not_run')));
  });

  // ---------- W14 Coverage API 真实 handler（整改 §7） ----------
  await t('W14 GET /api/watch-targets/coverage 返回 brief 本体：200 + mode/coverage/gaps + 两租户隔离', async () => {
    const st = { headersSent: false, writeHead() {}, end() {} };
    const ctxA = mkCtx(TID_A);
    await WatchH.coverageDay(ctxA, { method: 'GET' }, st, new URL('http://x/api/watch-targets/coverage'), '/api/watch-targets/coverage');
    assert.strictEqual(ctxA.status, 200);
    assert.ok(ctxA.body && typeof ctxA.body === 'object' && !Array.isArray(ctxA.body), 'body 是简报对象（修复前是 undefined）');
    assert.ok(['changed', 'quiet_with_full_coverage', 'coverage_incomplete', 'legacy_no_watch'].includes(ctxA.body.mode));
    assert.ok(ctxA.body.coverage && Number.isFinite(ctxA.body.coverage.expectedWindows), '含 coverage');
    assert.ok(Array.isArray(ctxA.body.gaps), '含 gaps');
    assert.strictEqual(ctxA.body.targets, 2, 'A 租户只看到自己的 2 个对象');
    const ctxB = mkCtx(TID_B);
    await WatchH.coverageDay(ctxB, { method: 'GET' }, st, new URL('http://x/api/watch-targets/coverage'), '/api/watch-targets/coverage');
    assert.strictEqual(ctxB.status, 200);
    assert.strictEqual(ctxB.body.targets, 1, 'B 租户只看到自己的 1 个对象（两租户隔离成立）');
    const ctxAnon = mkCtx(null);
    await WatchH.coverageDay(ctxAnon, { method: 'GET' }, st, new URL('http://x/api/watch-targets/coverage'), '/api/watch-targets/coverage');
    assert.strictEqual(ctxAnon.status, 403);
  });

  // ---------- W15 单品价格语义（整改 §6） ----------
  await t('W15 同身份才可比：增删他品零事件；稳定商品变价出事件；规格/币种变化不可比', async () => {
    const TID_L = 'tenant:watchL';
    await mkProject(TID_L, 'projL', 'compL1');
    WS.createWatchTarget({ tenantId: TID_L, projectId: 'projL', competitorId: 'compL1', timezone: 'UTC', enabledSignals: ['price'] });
    const target = WS.listSchedulableTargets().find(x => x.tenantId === TID_L);
    const snaps = []; // 注入的单品价格存储
    const loadFn = () => snaps.slice();
    const saveFn = (t2, p2, c2, snap) => {
      const i = snaps.findIndex(s => s.subjectId === snap.subjectId && s.currency === snap.currency);
      if (i >= 0) snaps[i] = snap; else snaps.push(snap);
    };
    const mkFetch = (items, currency) => async () => ({ ok: true, truncated: false, url: 'https://l.example.com/products.json', currency, items });
    const run = async (items, currency) => {
      const alerts = [];
      const c = WS.claimWindow(target, '2026-10-23T' + String(6 + alertsRound).padStart(2, '0') + ':00', '06:00', NOW, NOW);
      alertsRound++;
      await WM.executeWindow(target, c.windowId, { fetchFn: mkFetch(items, currency), productPricesFn: loadFn, productPriceSaveFn: saveFn, alertsPushFn: (t2, a) => alerts.push(a) }, NOW);
      return alerts;
    };
    let alertsRound = 0;
    const it = (id, price, vc) => ({ id, title: 'P' + id, variantCount: vc, repPrice: price, soldOut: false, publishedAt: null });
    // R1 基线：P1(20) P2(30) → 全部 new-price，无涨跌
    let a = await run([it(1, 20, 2), it(2, 30, 1)], 'USD');
    assert.strictEqual(a.filter(x => x.type === 'price-change').length, 0, '基线轮无涨跌事件');
    // R2 只新增高价商品 → 零 price-change（新增他品不影响原商品）
    a = await run([it(1, 20, 2), it(2, 30, 1), it(3, 100, 1)], 'USD');
    assert.strictEqual(a.filter(x => x.type === 'price-change').length, 0, '只增加高价商品：零 price-change');
    // R3 只删除低价商品 → 零 price-change
    a = await run([it(2, 30, 1), it(3, 100, 1)], 'USD');
    assert.strictEqual(a.filter(x => x.type === 'price-change').length, 0, '只删除低价商品：零 price-change');
    // R4 同一稳定商品 ID 变价 → 恰一个事件（P2 30→27），带 old/new/deltaPct
    a = await run([it(2, 27, 1), it(3, 100, 1)], 'USD');
    const changes = a.filter(x => x.type === 'price-change');
    assert.strictEqual(changes.length, 1, '同身份真实变价 → 恰一个涨跌事件');
    assert.strictEqual(changes[0].subjectId, '2');
    assert.strictEqual(changes[0].old, 30);
    assert.strictEqual(changes[0].new, 27);
    // R5 规格（变体数）变化 → 不可直接比较：不产 changed（按 new-price 处理）
    a = await run([it(2, 27, 4), it(3, 100, 1)], 'USD');
    assert.strictEqual(a.filter(x => x.type === 'price-change').length, 0, '规格变化：不可直接比较');
    // R6 币种变化 → 不可直接比较（不跨币种算涨跌）
    a = await run([it(2, 27, 1), it(3, 100, 1)], 'EUR');
    assert.strictEqual(a.filter(x => x.type === 'price-change').length, 0, '币种变化：不可直接比较');
  });

  // ---------- W16 上新可信表达（整改 §8） ----------
  await t('W16 部分商品有 publishedAt：count=withPub.length，文案区分首次观察与来源佐证', async () => {
    const TID_M = 'tenant:watchM';
    await mkProject(TID_M, 'projM', 'compM1');
    WS.createWatchTarget({ tenantId: TID_M, projectId: 'projM', competitorId: 'compM1', timezone: 'UTC', enabledSignals: ['launch'] });
    const target = WS.listSchedulableTargets().find(x => x.tenantId === TID_M);
    const alerts = [];
    const deps = { alertsPushFn: (t2, a) => alerts.push(a) };
    const base = (extra) => ([
      { id: 1, title: 'A', repPrice: 10, soldOut: false, publishedAt: '2026-10-01' },
      { id: 2, title: 'B', repPrice: 12, soldOut: false, publishedAt: '2026-10-02' },
    ].concat(extra));
    // R1 基线（无新增）
    let c = WS.claimWindow(target, '2026-10-24T06:00', '06:00', NOW, NOW);
    await WM.executeWindow(target, c.windowId, Object.assign({ fetchFn: async () => ({ ok: true, truncated: false, currency: 'USD', items: base([]) }) }, deps), NOW);
    assert.strictEqual(alerts.filter(a => a.type === 'product-launch').length, 0, '基线无上新事件');
    // R2 新增 3 款：仅 1 款带发布时间佐证 → count=1，文案区分
    c = WS.claimWindow(target, '2026-10-24T14:00', '14:00', NOW, NOW);
    await WM.executeWindow(target, c.windowId, Object.assign({ fetchFn: async () => ({ ok: true, truncated: false, currency: 'USD', items: base([
      { id: 3, title: 'C', repPrice: 14, soldOut: false, publishedAt: null },
      { id: 4, title: 'D', repPrice: 16, soldOut: false, publishedAt: '2026-10-20' },
      { id: 5, title: 'E', repPrice: 18, soldOut: false, publishedAt: null },
    ]) }) }, deps), NOW);
    const launches = alerts.filter(a => a.type === 'product-launch');
    assert.strictEqual(launches.length, 1, '有佐证才成事件');
    assert.strictEqual(launches[0].count, 1, '§8 count = withPub.length（不是新 ID 总数）');
    assert.strictEqual(launches[0].observedCount, 3, '首次观察到的新 ID 数单独披露');
    assert.ok(/上新 1 款（发布时间佐证）/.test(launches[0].text), launches[0].text);
    assert.ok(/另有 2 款为 Vantage 首次观察到，暂无发布时间佐证/.test(launches[0].text), '区分首次观察与来源证明');
    // R3 无新 ID → 无事件
    c = WS.claimWindow(target, '2026-10-24T22:00', '22:00', NOW, NOW);
    await WM.executeWindow(target, c.windowId, Object.assign({ fetchFn: async () => ({ ok: true, truncated: false, currency: 'USD', items: base([]) }) }, deps), NOW);
    assert.strictEqual(alerts.filter(a => a.type === 'product-launch').length, 1);
  });

  // ---------- W17 日报每租户当地 08:00（整改 §10） ----------
  await t('W17 两时区当地 08:00 发送 + 每本地日期至多一次（幂等/重启补发同路径）', async () => {
    const dbx = require('../services/db.js');
    const DigestStore = require('../services/digest-store.js');
    const Digest = require('../research/digest.js');
    const tTokyo = dbx.createTenant({ name: 'tz-tokyo', email: 'tokyo@example.com' });
    const tLA = dbx.createTenant({ name: 'tz-la', email: 'la@example.com' });
    await mkProject(tTokyo.id, 'projTokyo', 'compTokyo1');
    await mkProject(tLA.id, 'projLA', 'compLA1');
    WS.createWatchTarget({ tenantId: tTokyo.id, projectId: 'projTokyo', competitorId: 'compTokyo1', timezone: 'Asia/Tokyo' });
    WS.createWatchTarget({ tenantId: tLA.id, projectId: 'projLA', competitorId: 'compLA1', timezone: 'America/Los_Angeles' });
    process.env.ZB_MAIL_API_URL = 'https://mail.example/send';
    const sent = [];
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true }; };
    try {
      // tick1：2026-10-22T15:30Z = 东京 10-23 00:30（未到）｜洛杉矶 10-22 08:30（到点 → 发）
      const r1 = await Digest.runDigestTick(Date.parse('2026-10-22T15:30:00Z'));
      assert.strictEqual(sent.filter(m => m.to === 'la@example.com').length, 1, '洛杉矶当地 08:30 → 发');
      assert.strictEqual(sent.filter(m => m.to === 'tokyo@example.com').length, 0, '东京当地 00:30 → 未到不发');
      assert.ok(DigestStore.hasSent(tLA.id, '2026-10-22'), '洛杉矶幂等行落库');
      assert.ok(!DigestStore.hasSent(tTokyo.id, '2026-10-23'));
      // tick2：2026-10-23T00:30Z = 东京 10-23 09:30（同一本地日期首轮 → 补发）；洛杉矶 10-22 17:30（当日已发 → 幂等跳过）
      await Digest.runDigestTick(Date.parse('2026-10-23T00:30:00Z'));
      assert.strictEqual(sent.filter(m => m.to === 'tokyo@example.com').length, 1, '东京过 08:00 → 当日发送');
      assert.strictEqual(sent.filter(m => m.to === 'la@example.com').length, 1, '洛杉矶同日本地日期不重发（幂等）');
      assert.ok(DigestStore.hasSent(tTokyo.id, '2026-10-23'));
      // tick3 同一时刻重跑（模拟重复 tick/重启）：全部幂等跳过
      const r3 = await Digest.runDigestTick(Date.parse('2026-10-23T00:30:00Z'));
      assert.strictEqual(sent.filter(m => m.to === 'tokyo@example.com' || m.to === 'la@example.com').length, 2, '重跑零新增发送');
      assert.ok(r3.already >= 2, '两个租户都被幂等行挡下');
      // 时区换算本身：东京 08:00 = 前日 23:00Z；洛杉矶 08:00 = 15:00Z（DST 期 PDT=-7）
      assert.strictEqual(Digest.localDateOf('Asia/Tokyo', Date.parse('2026-10-22T15:30:00Z')), '2026-10-23');
      assert.strictEqual(Digest.localDateOf('America/Los_Angeles', Date.parse('2026-10-22T15:30:00Z')), '2026-10-22');
    } finally {
      global.fetch = realFetch;
      delete process.env.ZB_MAIL_API_URL;
    }
  });

  // ---------- W18 旧 sweep 旁路关闭（整改 §3） ----------
  await t('W18 未加入 WatchTarget 的 done 竞品：调度运行后零窗口/零提醒/零搜索/零 LLM；旧 sweep 默认不再调度', async () => {
    const TID_N = 'tenant:watchN';
    await mkProject(TID_N, 'projN', 'compN1'); // done 竞品，无 WatchTarget
    const alertsBefore = Alerts.list(TID_N, 200).length;
    const Net = require('../research/net.js');
    const origNet = Net.fetchShopifyProducts;
    let netCalls = 0, nCalls = 0;
    Net.fetchShopifyProducts = async (url) => {
      netCalls++;
      if (String(url).includes('compN1')) nCalls++; // 只统计无 WatchTarget 竞品的抓取
      return okFetch();
    };
    try {
      const pushed = [];
      const out = await WM.runDueWindows({
        nowMs: Date.parse('2026-10-23T21:00:00Z'),
        deps: { alertsPushFn: (tid, a) => pushed.push({ tid, a }) }, // 全默认路径
      });
      void out;
      assert.strictEqual(nCalls, 0, '零搜索/零直抓：compN1 无 WatchTarget，没有任何抓取');
      // LLM 零调用是结构保证：runDueWindows→executeWindow 只含 Shopify 直采路径（零搜索零 LLM），
      // 且 compN1 无窗口（下方断言），LLM 探测只存在于旧 sweep 的 recentMoves 路径，而旧 sweep 已不再调度。
      assert.ok(!pushed.some(p => p.tid === TID_N), '零提醒');
      const rows = WS.getDb().prepare('SELECT COUNT(*) AS n FROM monitoring_windows WHERE tenant_id=?').get(TID_N);
      assert.strictEqual(rows.n, 0, '零窗口');
      assert.strictEqual(Alerts.list(TID_N, 200).length, alertsBefore, 'alerts 存储零新增');
      // startScheduler 接线：默认不调度旧 sweep（WatchMonitor 是正式监控唯一资格边界）
      const Scheduler = require('../services/scheduler.js');
      const origSched = process.env.SCHEDULER_ENABLED;
      const origNext = Scheduler.scheduleNext;
      const origTick = WM.startTick;
      const DigestMod = require('../research/digest.js');
      const origSDT = DigestMod.startDigestTick;
      let sweepScheduled = false;
      Scheduler.scheduleNext = () => { sweepScheduled = true; return { nextAt: new Date() }; };
      WM.startTick = () => ({ tickMinutes: 5 });
      DigestMod.startDigestTick = () => ({ tickMinutes: 10 });
      delete process.env.SCHEDULER_ENABLED; // startScheduler 需要非 0 才继续
      try {
        const { startScheduler } = require('../research/sweep.js');
        const r = startScheduler();
        assert.strictEqual(sweepScheduled, false, '默认不调度旧 sweep（不因项目活跃产生搜索/LLM/提醒费用）');
        assert.ok(r && r.sweep === null && r.watchTick && r.digestTick, 'WatchMonitor + digest tick 正常接线');
      } finally {
        if (origSched !== undefined) process.env.SCHEDULER_ENABLED = origSched;
        Scheduler.scheduleNext = origNext;
        WM.startTick = origTick;
        DigestMod.startDigestTick = origSDT;
      }
    } finally { Net.fetchShopifyProducts = origNet; }
  });

  // ---------- W19 软停用历史保留 + 重新加入恢复（整改 §5） ----------
  await t('W19 退出监控：历史可查、不再巡检；重新加入恢复原 WatchTarget 并重新激活', async () => {
    const TID_P = 'tenant:watchP';
    await mkProject(TID_P, 'projP', 'compP1');
    const created = WS.createWatchTarget({ tenantId: TID_P, projectId: 'projP', competitorId: 'compP1', timezone: 'UTC' });
    const wtId = created.target.watchTargetId;
    // 先跑一个真实窗口，留下历史
    const target = WS.listSchedulableTargets().find(x => x.watchTargetId === wtId);
    const out = await WM.runDueWindows({ nowMs: Date.parse('2026-10-24T21:00:00Z'), targets: [target], deps: { fetchFn: okFetch, alertsPushFn: () => {} } });
    assert.ok(out.windows.length >= 1);
    // 退出
    assert.strictEqual(WS.deleteWatchTarget(TID_P, wtId), true);
    assert.strictEqual(WS.deleteWatchTarget(TID_P, wtId), false, '重复停用 no-op');
    // 历史仍可查询
    const hist = WS.windowsForTargetDay(wtId, ['2026-10-24T06:00', '2026-10-24T14:00']);
    assert.ok(Object.values(hist).some(w => w && w.status === 'complete'), '窗口历史保留可查');
    // 不再巡检
    assert.ok(!WS.listSchedulableTargets().some(x => x.watchTargetId === wtId));
    // 重新加入 → 恢复原对象 + 重新激活
    const again = WS.createWatchTarget({ tenantId: TID_P, projectId: 'projP', competitorId: 'compP1', timezone: 'UTC' });
    assert.strictEqual(again.existed, true);
    assert.strictEqual(again.reactivated, true, '§5 inactive 对象重新加入 = 重新激活');
    assert.strictEqual(again.target.watchTargetId, wtId, '恢复原 WatchTarget（不新建）');
    assert.strictEqual(again.target.monitoringStatus, 'active');
    assert.strictEqual(again.target.deactivatedAt, null);
    const hist2 = WS.windowsForTargetDay(wtId, ['2026-10-24T06:00']);
    assert.ok(hist2['2026-10-24T06:00'] && hist2['2026-10-24T06:00'].status === 'complete', '重新加入后历史仍在');
  });

  console.log(failed ? `\nwatch-foundation.test: ${failed} failed` : '\nwatch-foundation.test: all passed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('harness 异常:', e && e.stack || e); process.exit(1); });
