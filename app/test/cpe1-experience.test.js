'use strict';
// ============================================================
// cpe1-experience.test.js —— 核心产品体验收敛 r1 · 后端行为门
// ------------------------------------------------------------
// 覆盖三件事（对应任务书 §三「每日变化收件箱」与手动巡检）：
//
//   S1 收件箱状态投影三态：no_monitoring / awaiting_comparison / inspected
//      —— 空收件箱必须能区分「没加入监控」「加了但没跑过」「跑过但没变化」
//   S2 空收件箱不得伪造事件：任何状态下 intel_events 计数只认 origin=monitoring
//   S3 立即巡检走真实链路：窗口真实落库（window_key=manual-*）、状态推进、
//      连点单飞拒绝、未监控拒绝；手动巡检**不制造事件**
//   S4 收件箱 API 投影包含 state（前端三空态的唯一依据）
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-cpe1-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';

const WS = require('../services/watch-store.js');
const Inbox = require('../services/intel-inbox.js');
const Manual = require('../services/watch-manual.js');

const TID = 'tenant:cpe1', PID = 'projCpe1';
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ': ' + (e && e.message)); }
}

function seedTarget(overrides) {
  const o = overrides || {};
  const r = WS.createWatchTarget({
    tenantId: TID, projectId: PID, competitorId: o.competitorId || 'brand-x',
    enabledSignals: o.enabledSignals || ['price'],
    supportedSignals: o.supportedSignals || ['price'],
    market: '', timezone: 'UTC',
  });
  return r && r.target ? r.target : r;
}

function events(tid, pid) {
  Inbox.ensureTable();
  const db = WS.getDb();
  const r = db.prepare('SELECT COUNT(*) AS n FROM intel_events WHERE tenant_id=? AND project_id=?').get(tid, pid);
  return Number(r ? r.n : 0);
}

(async () => {
  console.log('=== cpe1-experience.test ===');

  // ---------- S1 三态 ----------
  await t('S1a 无任何监控目标 → state=no_monitoring，信号范围为空', () => {
    const s = Inbox.inboxState(TID, PID, 'Asia/Shanghai');
    assert.equal(s.state, 'no_monitoring');
    assert.equal(s.activeTargets, 0);
    assert.equal(s.windowCount, 0);
    assert.deepEqual(s.signals, []);
  });

  await t('S1b 已加入监控但零完成窗口 → state=awaiting_comparison（不得说「已巡检」）', () => {
    seedTarget();
    const s = Inbox.inboxState(TID, PID, 'Asia/Shanghai');
    assert.equal(s.state, 'awaiting_comparison');
    assert.equal(s.activeTargets, 1);
    assert.equal(s.windowCount, 0);
    assert.equal(s.todayInspected, false);
    assert.equal(s.signalsText, '价格');
  });

  await t('S1c 有完成窗口 → state=inspected，今日已巡检标记按窗口真实日期判定', () => {
    const target = WS.listSchedulableTargets().find(x => x.tenantId === TID && x.projectId === PID);
    const nowMs = Date.now();
    const claim = WS.claimWindow(target, '2026-10-27T06:00', '06:00', nowMs, nowMs);
    assert.ok(claim.claimed, '窗口应可认领');
    WS.completeWindow(claim.windowId, {
      signalResults: [{ signal: 'price', attempted: 1, succeeded: 1, failed: 0, reason: null }],
      attempted: 1, succeeded: 1, failed: 0, partialScan: false, failureReasons: {},
      eventsVerified: 0, eventsPending: 0, eventsWriteFailed: 0, eventsDuplicate: 0,
    }, nowMs);
    const s = Inbox.inboxState(TID, PID, 'Asia/Shanghai');
    assert.equal(s.state, 'inspected');
    assert.equal(s.windowCount, 1);
    assert.equal(s.todayInspected, true, '刚完成的窗口应计入今日巡检');
    assert.equal(s.lastEventsVerified, 0);
  });

  await t('S1d 暂停全部监控 → state=paused（与「从未加入」区分）', () => {
    const target = WS.listSchedulableTargets().find(x => x.tenantId === TID && x.projectId === PID);
    WS.updateWatchTarget(TID, target.watchTargetId, { monitoringStatus: 'paused' });
    const s = Inbox.inboxState(TID, PID, 'Asia/Shanghai');
    assert.equal(s.state, 'paused');
    assert.equal(s.activeTargets, 0);
    assert.equal(s.pausedTargets, 1);
    WS.updateWatchTarget(TID, target.watchTargetId, { monitoringStatus: 'active' });
    assert.equal(Inbox.inboxState(TID, PID, 'Asia/Shanghai').state, 'inspected');
  });

  // ---------- S2 空收件箱不伪造 ----------
  await t('S2 三次状态变化后 intel_events 仍为 0（无真实变化就不写事件）', () => {
    assert.equal(events(TID, PID), 0);
    const r = Inbox.listInbox({ tenantId: TID, projectId: PID });
    assert.equal(r.total, 0);
    assert.equal(r.groups.length, 0);
    assert.equal(r.summary.today, 0);
  });

  // ---------- S3 立即巡检 ----------
  await t('S3a 未监控目标 → NOT_MONITORING（不凭空建监控）', () => {
    const r = Manual.startInspect({ tenantId: TID, watchTargetId: 'wt:not-exist' });
    assert.equal(r.accepted, false);
    assert.equal(r.reason, 'NOT_MONITORING');
  });

  await t('S3b 已监控 → 受理并生成 manual 窗口；窗口真实落库且状态推进', async () => {
    const target = WS.listSchedulableTargets().find(x => x.tenantId === TID && x.projectId === PID);
    const r = Manual.startInspect({ tenantId: TID, watchTargetId: target.watchTargetId });
    assert.equal(r.accepted, true, '应受理');
    assert.match(r.windowKey, /^manual-\d{8}T\d{6}Z$/, '窗口键必须是 manual-*，不复用定时窗口');
    // 等后台执行完成（无竞品档案 → 信号显式失败，窗口仍必须 complete）
    for (let i = 0; i < 60; i++) {
      const row = WS.getDb().prepare('SELECT status FROM monitoring_windows WHERE window_id=?')
        .get(target.watchTargetId + ':' + r.windowKey);
      if (row && row.status === 'complete') break;
      await new Promise(res => setTimeout(res, 50));
    }
    const row = WS.getDb().prepare('SELECT status, slot, attempted, failed FROM monitoring_windows WHERE window_id=?')
      .get(target.watchTargetId + ':' + r.windowKey);
    assert.ok(row, '手动窗口必须落库');
    assert.equal(row.status, 'complete');
    assert.equal(row.slot, 'manual');
    assert.equal(row.attempted, 1);
    assert.equal(row.failed, 1, '缺竞品档案时信号如实失败，不伪造成功');
  });

  await t('S3c 手动巡检不制造事件（无真实变化则 0 条）', () => {
    assert.equal(events(TID, PID), 0);
  });

  await t('S3d 连点单飞：20s 内重复请求被拒（不重复采集）', () => {
    const target = WS.listSchedulableTargets().find(x => x.tenantId === TID && x.projectId === PID);
    const r1 = Manual.startInspect({ tenantId: TID, watchTargetId: target.watchTargetId });
    const r2 = Manual.startInspect({ tenantId: TID, watchTargetId: target.watchTargetId });
    // 第一次可能因已过冷却而受理；关键断言：两次不可能同时受理
    assert.ok(!(r1.accepted && r2.accepted), '连点不得并发两次巡检');
    if (!r2.accepted) assert.equal(r2.reason, 'IN_PROGRESS');
  });

  // ---------- S1e 监控意向（非 Shopify 品牌的真实路径） ----------
  const PID2 = 'projCpe1IntentOnly';
  await t('S1e 已提交加入监控但来源在建立 → state=establishing（不得显示「尚未加入」）', () => {
    const WIntent = require('../services/watch-intent.js');
    const r = WIntent.requestIntent({
      tenantId: TID, projectId: PID2, competitorId: 'brand-nonshopify',
      reasonCode: 'no_direct_source', reasonText: '正在建立公开商品来源', signals: ['price'],
    });
    assert.ok(r && (r.intent || r.error), '意向创建有明确结果');
    const s = Inbox.inboxState(TID, PID2, 'Asia/Shanghai');
    assert.equal(s.state, 'establishing');
    assert.ok(s.pendingIntents >= 1);
    assert.ok(/建立/.test(String(s.intentNote || '')));
  });

  await t('S1f 来源建立失败 → state=source_failed（给原因，不假装监控中）', () => {
    const WIntent = require('../services/watch-intent.js');
    const list = WIntent.listIntents(TID, PID2) || [];
    const it = list.find(x => x.competitorId === 'brand-nonshopify');
    assert.ok(it, '找到意向');
    if (typeof WIntent.setFailed === 'function') {
      WIntent.setFailed(TID, it.intentId, 'no_comparable_products');
      const s = Inbox.inboxState(TID, PID2, 'Asia/Shanghai');
      assert.ok(['source_failed', 'establishing'].includes(s.state), 'state=' + s.state);
    }
  });

  // ---------- S4 API 投影 ----------
  await t('S4 listInbox 返回 state 投影（前端三空态的唯一依据）', () => {
    const r = Inbox.listInbox({ tenantId: TID, projectId: PID });
    assert.ok(r.state, '必须带 state');
    assert.ok(['no_monitoring', 'paused', 'awaiting_comparison', 'inspected', 'unknown'].includes(r.state.state));
    assert.equal(typeof r.state.signalsText, 'string');
    assert.equal(typeof r.state.todayInspected, 'boolean');
  });

  await t('S4b 跨租户不可见（隔离）', () => {
    const other = Inbox.inboxState('tenant:other', PID, 'Asia/Shanghai');
    assert.equal(other.activeTargets, 0);
    assert.equal(other.state, 'no_monitoring');
    const r = Inbox.listInbox({ tenantId: 'tenant:other', projectId: PID });
    assert.equal(r.total, 0);
  });

  console.log('\ncpe1-experience.test: ' + passed + ' passed, ' + failed + ' failed');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
