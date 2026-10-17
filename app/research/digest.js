'use strict';
// ============================================================
// digest.js —— 每日摘要（PRD R4 / §24 每日 Brief / 静默日报）
// ------------------------------------------------------------
// 三态结果（01 v1.3.3 §24 + 00 v1.2 §21 quiet 规则）：
//   · changed                  —— 有 verified/actionable 事件（附 Coverage 计数）
//   · quiet_with_full_coverage —— 窗口全部 complete 且无失败/partial、无事件 →
//                                 允许说"没有发现已核实的重要变化"
//   · coverage_incomplete      —— 任一窗口缺失/失败/partial_scan：必须列明对象、
//                                 信号与原因，禁止输出"没有变化"
// Coverage 事实来源 = monitoring_windows 持久层（03 §14：读表，不重新猜）；
// events.length===0 绝不单独构成 quiet。
// 兼容：租户没有任何 WatchTarget 时沿用旧 alerts 摘要行为（加法迁移，不改变既有用户）。
// ============================================================
const db = require('../services/db.js');
const Alerts = require('../services/alerts.js');
const mailer = require('../services/mailer.js');
const WS = require('../services/watch-store.js');
const WM = require('../services/watch-monitor.js');

const DIGEST_WINDOW_MS = 24 * 3600 * 1000;

// 汇总一个租户近 24h 的预警为纯文本正文（无变化返回 null）——旧行为，租户无监控对象时仍用
function buildDigestText(alerts, trackNames) {
  const cutoff = Date.now() - DIGEST_WINDOW_MS;
  const recent = (alerts || []).filter(a => a && a.at && Date.parse(a.at) >= cutoff);
  if (!recent.length) return null;
  const lines = recent.slice(0, 30).map(a => {
    const track = (trackNames && (trackNames[a.projectId])) || a.track || '';
    const prefix = track ? '【' + track + '】' : '';
    if (a.type === 'price-change' || a.type === 'price-discovered') {
      return '- ' + prefix + (a.competitorName || a.competitorId || '竞争品牌') + ' ' + (a.text || '价格变动');
    }
    const moves = Array.isArray(a.moves) ? a.moves.join('；') : '';
    return '- ' + prefix + (a.competitorName || a.competitorId || '竞争品牌') + ' ' + (a.text || moves || '出现新的竞争动态').slice(0, 120);
  });
  const head = '知彼 Vantage · 每日竞品动态摘要（' + new Date().toISOString().slice(0, 10) + '）';
  return head + '\n\n' + lines.join('\n') + '\n\n共 ' + recent.length + ' 条变化。打开工作台查看详情与来源。';
}

// ---------- 三态日报（WatchTarget 租户专用） ----------
// opts.nowMs 可注入（测试）；返回统一 JSON 结构 + 人类可读 text
function buildDailyBrief(tenantId, opts) {
  const o = opts || {};
  const nowMs = o.nowMs || Date.now();
  const targets = WS.listWatchTargets(tenantId);
  const brief = {
    generatedAt: new Date(nowMs).toISOString(),
    policyVersion: WS.POLICY_VERSION,
    targets: targets.length,
    mode: null,                     // changed | quiet_with_full_coverage | coverage_incomplete
    coverage: { expectedWindows: 0, completedWindows: 0, fullWindows: 0, gapWindows: 0, missingWindows: 0 },
    events: [],
    gaps: [],                       // [{watchTargetId, competitorId, slot, windowKey?, reasons}]
    text: '',
  };
  if (!targets.length) { brief.mode = 'legacy_no_watch'; return brief; }

  // 1) 事件面：近 24h 已核实事件（verified/actionable 才参与 changed 判定）
  const cutoff = nowMs - DIGEST_WINDOW_MS;
  const monitoredIds = new Set(targets.map(t => t.competitorId));
  let alerts = [];
  try { alerts = Alerts.list(tenantId, 200) || []; } catch (e) { alerts = []; }
  brief.events = alerts.filter(a => a && a.at && Date.parse(a.at) >= cutoff
    && a.basis === 'verified' && monitoredIds.has(a.competitorId));

  // 2) Coverage 面：逐目标取其时区下"今天"已到点的窗口（到点即预期；未到点不计）
  for (const t of targets) {
    const due = WM.dueWindows(t, nowMs); // 已到点 slot（含 jitter 语义）
    for (const d of due) {
      brief.coverage.expectedWindows++;
      const win = WS.getWindow(t.watchTargetId + ':' + d.windowKey);
      if (!win) { brief.coverage.missingWindows++; brief.gaps.push({ watchTargetId: t.watchTargetId, competitorId: t.competitorId, slot: d.slot, windowKey: d.windowKey, reasons: ['window_not_run'] }); continue; }
      if (win.status !== 'complete') { brief.coverage.missingWindows++; brief.gaps.push({ watchTargetId: t.watchTargetId, competitorId: t.competitorId, slot: d.slot, windowKey: d.windowKey, reasons: ['window_incomplete'] }); continue; }
      brief.coverage.completedWindows++;
      if (win.coverage === 'full') { brief.coverage.fullWindows++; continue; }
      brief.coverage.gapWindows++;
      const reasons = Object.keys(win.failureReasons || {});
      if (win.partialScan) reasons.push('partial_scan');
      brief.gaps.push({ watchTargetId: t.watchTargetId, competitorId: t.competitorId, slot: d.slot, windowKey: d.windowKey, reasons: reasons.length ? reasons : ['unknown'] });
    }
  }

  // 3) 三态裁决（00 §21：window complete + coverage 达标 + 无 verified 事件才允许 quiet）
  if (brief.gaps.length) {
    brief.mode = 'coverage_incomplete';
  } else if (brief.events.length) {
    brief.mode = 'changed';
  } else {
    brief.mode = 'quiet_with_full_coverage';
  }

  // 4) 人类可读文案（01 §24 三种样例口径）
  const nameOf = (id) => { const t = targets.find(x => x.watchTargetId === id); return t ? t.competitorId : id; };
  if (brief.mode === 'changed') {
    const lines = brief.events.slice(0, 10).map(a => '- ' + (a.competitorName || a.competitorId || '竞争品牌') + ' ' + (a.text || '出现新的竞争动态'));
    brief.text = '今日 ' + brief.events.length + ' 个重要变化\n' + lines.join('\n')
      + '\n今日覆盖 ' + brief.coverage.fullWindows + '/' + brief.coverage.expectedWindows + '（已到点窗口）';
  } else if (brief.mode === 'quiet_with_full_coverage') {
    brief.text = '今日关键巡检已完成。\n没有发现已核实的重要变化。\n'
      + '已检查 ' + targets.length + ' 个监控对象的信号：' + targets.map(t => t.competitorId + '（' + t.enabledSignals.join('/') + '）').join('、')
      + '，覆盖 ' + brief.coverage.fullWindows + '/' + brief.coverage.expectedWindows + ' 个窗口。';
  } else {
    const lines = brief.gaps.slice(0, 10).map(g => '- ' + nameOf(g.watchTargetId) + ' @' + g.slot + '：' + g.reasons.join(', '));
    brief.text = '今日完成 ' + brief.coverage.completedWindows + '/' + brief.coverage.expectedWindows + ' 个巡检窗口。\n'
      + '已完成部分' + (brief.events.length ? '发现 ' + brief.events.length + ' 条已核实变化' : '没有发现已核实变化')
      + '；以下对象/信号访问异常，无法确认是否无变化：\n' + lines.join('\n');
  }
  return brief;
}

async function runDigest(now) {
  const out = { tenants: 0, sent: 0, noChange: 0, noRecipient: 0, failed: 0, skipped: false, briefs: 0 };
  if (!mailer.isConfigured()) { out.skipped = true; return out; } // 未配置邮件通道：整体静默跳过
  let tenants = [];
  try { tenants = db.listAllTenants(); } catch (e) { return Object.assign(out, { error: 'db_err' }); }
  for (const t of tenants) {
    if (t.status === 'suspended') continue;
    out.tenants++;
    // 有正式监控对象的租户 → 三态日报（quiet 也发：静默日报本身就是产品承诺）
    let brief = null;
    try { brief = buildDailyBrief(t.id, { nowMs: now ? Date.parse(now) || Date.now() : Date.now() }); } catch (e) { brief = null; }
    if (brief && brief.targets > 0) {
      out.briefs++;
      const settings = Alerts.getSettings(t.id);
      const to = (settings && settings.mailTo) || t.email || '';
      if (!to) { out.noRecipient++; continue; }
      const subject = brief.mode === 'coverage_incomplete' ? '知彼 Vantage · 每日简报（覆盖不完整）'
        : brief.mode === 'changed' ? '知彼 Vantage · 每日竞品动态' : '知彼 Vantage · 每日简报（无变化，覆盖完整）';
      const r = await mailer.sendMail({ to, subject, text: brief.text });
      if (r.ok) out.sent++; else out.failed++;
      continue;
    }
    // 无监控对象：旧行为（无变化不发）
    const alerts = Alerts.list(t.id, 200);
    const text = buildDigestText(alerts);
    if (!text) { out.noChange++; continue; } // R4.2：无变化不发
    const settings = Alerts.getSettings(t.id);
    const to = (settings && settings.mailTo) || t.email || '';
    if (!to) { out.noRecipient++; continue; }
    const r = await mailer.sendMail({ to, subject: '知彼 Vantage · 每日竞品动态', text });
    if (r.ok) out.sent++; else out.failed++;
  }
  return out;
}

module.exports = { runDigest, buildDigestText, buildDailyBrief };
