'use strict';
// ============================================================
// digest.js —— 每日摘要（PRD R4 / §24 每日 Brief / 静默日报）
// ------------------------------------------------------------
// 三态结果（01 v1.3.3 §24 + 00 v1.2 §21 quiet 规则；整改 §4 收紧 Coverage 语义）：
//   · changed                  —— 有 verified/actionable 事件（附 Coverage 计数）
//   · quiet_with_full_coverage —— 窗口全部 complete 且无失败/partial、无事件 →
//                                 允许说"没有发现已核实的重要变化"
//   · coverage_incomplete      —— 任一窗口缺失/失败/partial_scan：必须列明对象、
//                                 信号与原因，禁止输出"没有变化"
// 整改 §4 Coverage 语义：
//   · 只有 active/degraded 正式目标计入预期窗口；paused/inactive 不产生 window_not_run；
//   · expectedWindows=0 禁止返回 quiet_with_full_coverage（无到点窗口时连"无变化"
//     都无从谈起）→ coverage_incomplete，并明确"今日首个巡检窗口尚未完成"；
//   · changed / quiet / coverage_incomplete 三态冻结，不新增第四态。
// 整改 §10 调度：每租户 Workspace 当地时间 08:00 发送（IANA 时区，DST 自动处理），
// 每租户每本地日期至多一次（digest-store 幂等），服务重启后 tick 立即补发过点未发的。
// Coverage 事实来源 = monitoring_windows 持久层（03 §14：读表，不重新猜）；
// events.length===0 绝不单独构成 quiet。
// 兼容：租户没有任何 WatchTarget 时沿用旧 alerts 摘要行为（加法迁移，不改变既有用户）。
// ============================================================
const db = require('../services/db.js');
const Alerts = require('../services/alerts.js');
const mailer = require('../services/mailer.js');
const WS = require('../services/watch-store.js');
const WM = require('../services/watch-monitor.js');
const DigestStore = require('../services/digest-store.js');

const DIGEST_WINDOW_MS = 24 * 3600 * 1000;
const DIGEST_LOCAL_HOUR = 8; // Workspace 当地 08:00（整改 §10，禁用单一服务器 DIGEST_HOUR 冒充）

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

  // 整改 §4：只有 active/degraded 正式目标计入预期窗口与巡检覆盖；
  // paused/inactive 是"用户明确不巡检"，不产生 window_not_run 一类的覆盖缺口
  const monitored = targets.filter(t => t.monitoringStatus === 'active' || t.monitoringStatus === 'degraded');

  // 1) 事件面：近 24h 已核实事件（verified/actionable 才参与 changed 判定）
  const cutoff = nowMs - DIGEST_WINDOW_MS;
  const monitoredIds = new Set(targets.map(t => t.competitorId));
  let alerts = [];
  try { alerts = Alerts.list(tenantId, 200) || []; } catch (e) { alerts = []; }
  brief.events = alerts.filter(a => a && a.at && Date.parse(a.at) >= cutoff
    && a.basis === 'verified' && monitoredIds.has(a.competitorId));

  // 2) Coverage 面：逐目标取其时区下"今天"已到点的窗口（到点即预期；未到点不计）
  for (const t of monitored) {
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

  // 3) 三态裁决（00 §21：window complete + coverage 达标 + 无 verified 事件才允许 quiet；
  // 整改 §4：expectedWindows=0 → 禁止 quiet，归 coverage_incomplete）
  if (brief.coverage.expectedWindows === 0) {
    brief.gaps.push({
      watchTargetId: null, competitorId: null, slot: null,
      reasons: monitored.length ? ['first_window_pending'] : ['no_active_watch_targets', 'first_window_pending'],
    });
    brief.mode = 'coverage_incomplete';
  } else if (brief.gaps.length) {
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
      + '已检查 ' + monitored.length + ' 个监控对象的信号：' + monitored.map(t => t.competitorId + '（' + t.enabledSignals.join('/') + '）').join('、')
      + '，覆盖 ' + brief.coverage.fullWindows + '/' + brief.coverage.expectedWindows + ' 个窗口。';
  } else {
    const lines = brief.gaps.slice(0, 10).map(g => '- ' + (g.watchTargetId ? nameOf(g.watchTargetId) + ' @' + g.slot : '巡检计划') + '：' + g.reasons.join(', '));
    const pending = brief.gaps.some(g => g.reasons && g.reasons.includes('first_window_pending'));
    brief.text = '今日完成 ' + brief.coverage.completedWindows + '/' + brief.coverage.expectedWindows + ' 个巡检窗口。\n'
      + (pending ? '今日首个巡检窗口尚未完成，暂不能对任何对象下"无变化"结论。\n' : '')
      + '已完成部分' + (brief.events.length ? '发现 ' + brief.events.length + ' 条已核实变化' : '没有发现已核实变化')
      + '；以下对象/信号访问异常，无法确认是否无变化：\n' + lines.join('\n');
  }
  return brief;
}

// ---------- 整改 §10：每租户 Workspace 当地 08:00 ----------
// 时区来源：租户 WatchTarget 的 IANA timezone（active/degraded 优先，其余取第一个）；
// 无任何 WatchTarget 的 legacy 租户回退服务器本地时区（既有行为，加法迁移）。
function tenantTimezoneFor(tenantId) {
  try {
    const targets = WS.listWatchTargets(tenantId);
    const preferred = targets.find(t => t.monitoringStatus === 'active' || t.monitoringStatus === 'degraded') || targets[0];
    if (preferred && WS.validTimezone(preferred.timezone)) return preferred.timezone;
  } catch (e) { /* 库异常 → 回退 */ }
  return null;
}
function localDateOf(tz, nowMs) {
  if (tz) return WS.localParts(tz, nowMs).date;
  const d = new Date(nowMs);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function localMinuteOf(tz, nowMs) {
  if (tz) {
    const [h, m] = WS.localParts(tz, nowMs).time.split(':').map(Number);
    return h * 60 + m;
  }
  const d = new Date(nowMs);
  return d.getHours() * 60 + d.getMinutes();
}

// 组装一个租户此刻应发送的日报（返回 null = 无可发内容）
function composeForTenant(t, nowMs) {
  let brief = null;
  try { brief = buildDailyBrief(t.id, { nowMs }); } catch (e) { brief = null; }
  if (brief && brief.targets > 0) {
    const subject = brief.mode === 'coverage_incomplete' ? '知彼 Vantage · 每日简报（覆盖不完整）'
      : brief.mode === 'changed' ? '知彼 Vantage · 每日竞品动态' : '知彼 Vantage · 每日简报（无变化，覆盖完整）';
    return { subject, text: brief.text, mode: brief.mode, isBrief: true };
  }
  // 无监控对象：旧行为（R4.2：无变化不发）
  const alerts = Alerts.list(t.id, 200);
  const text = buildDigestText(alerts);
  if (!text) return null;
  return { subject: '知彼 Vantage · 每日竞品动态', text, mode: 'legacy_digest', isBrief: false };
}

async function sendToTenant(t, composed) {
  const settings = Alerts.getSettings(t.id);
  const to = (settings && settings.mailTo) || t.email || '';
  if (!to) return 'no_recipient';
  const r = await mailer.sendMail({ to, subject: composed.subject, text: composed.text });
  return r.ok ? 'sent' : 'failed';
}

// 手动/兼容入口（digest.test / 运维）：立即向所有租户发送应发内容（不做 08:00 门控），
// 但同样落幂等行，避免之后 tick 当日重发。
async function runDigest(now) {
  const out = { tenants: 0, sent: 0, noChange: 0, noRecipient: 0, failed: 0, skipped: false, briefs: 0 };
  if (!mailer.isConfigured()) { out.skipped = true; return out; } // 未配置邮件通道：整体静默跳过
  let tenants = [];
  try { tenants = db.listAllTenants(); } catch (e) { return Object.assign(out, { error: 'db_err' }); }
  const nowMs = now ? (Date.parse(now) || Date.now()) : Date.now();
  for (const t of tenants) {
    if (t.status === 'suspended') continue;
    out.tenants++;
    const composed = composeForTenant(t, nowMs);
    if (!composed) { out.noChange++; continue; }
    if (composed.isBrief) out.briefs++;
    const r = await sendToTenant(t, composed);
    if (r === 'sent') {
      out.sent++;
      const tz = tenantTimezoneFor(t.id);
      DigestStore.recordSent(t.id, localDateOf(tz, nowMs), composed.mode, new Date(nowMs).toISOString());
    } else if (r === 'no_recipient') out.noRecipient++;
    else out.failed++;
  }
  return out;
}

// 整改 §10：每租户当地 08:00 的一轮检查（由定时 tick 驱动；启动即跑一次 = 重启补发）
async function runDigestTick(nowMs) {
  const out = { tenants: 0, due: 0, sent: 0, waited: 0, already: 0, noChange: 0, noRecipient: 0, failed: 0, skipped: false };
  if (!mailer.isConfigured()) { out.skipped = true; return out; }
  let tenants = [];
  try { tenants = db.listAllTenants(); } catch (e) { return Object.assign(out, { error: 'db_err' }); }
  const ts = nowMs || Date.now();
  for (const t of tenants) {
    if (t.status === 'suspended') continue;
    out.tenants++;
    const tz = tenantTimezoneFor(t.id);
    const localDate = localDateOf(tz, ts);
    if (DigestStore.hasSent(t.id, localDate)) { out.already++; continue; } // 每本地日期至多一次（幂等）
    if (localMinuteOf(tz, ts) < DIGEST_LOCAL_HOUR * 60) { out.waited++; continue; } // 未到当地 08:00
    out.due++;
    const composed = composeForTenant(t, ts);
    if (!composed) {
      // 无变化/无对象也落幂等行：当日不再重试（明天自然开新窗口）
      DigestStore.recordSent(t.id, localDate, 'no_change', new Date(ts).toISOString());
      out.noChange++;
      continue;
    }
    const r = await sendToTenant(t, composed);
    if (r === 'sent') { out.sent++; DigestStore.recordSent(t.id, localDate, composed.mode, new Date(ts).toISOString()); }
    else if (r === 'no_recipient') { out.noRecipient++; DigestStore.recordSent(t.id, localDate, 'no_recipient', new Date(ts).toISOString()); }
    else out.failed++; // 失败不落行：下轮 tick 重试（仍受"至多一次成功发送"约束）
  }
  return out;
}

let _digestTimer = null;
const DIGEST_TICK_MINUTES = Math.max(1, parseInt(process.env.DIGEST_TICK_MINUTES || '10', 10) || 10);
function startDigestTick(logger) {
  if (process.env.DIGEST_ENABLED === '0') return null;
  if (_digestTimer) return null;
  // 重启补发：启动 45s 后先跑一轮（过当地 08:00 未发的当天补上；幂等行防重）
  const catchUp = setTimeout(() => { runDigestTick().catch(() => {}); }, 45 * 1000);
  if (catchUp.unref) catchUp.unref();
  _digestTimer = setInterval(() => { runDigestTick().catch(() => {}); }, DIGEST_TICK_MINUTES * 60 * 1000);
  if (_digestTimer.unref) _digestTimer.unref();
  try { logger && logger.info && logger.info('digest tick 已启动', { tickMinutes: DIGEST_TICK_MINUTES, localHour: DIGEST_LOCAL_HOUR }); } catch (e) {}
  return { tickMinutes: DIGEST_TICK_MINUTES };
}
function stopDigestTick() { if (_digestTimer) { clearInterval(_digestTimer); _digestTimer = null; } }

module.exports = {
  runDigest, buildDigestText, buildDailyBrief,
  runDigestTick, startDigestTick, stopDigestTick,
  tenantTimezoneFor, localDateOf, localMinuteOf, DIGEST_LOCAL_HOUR,
};
