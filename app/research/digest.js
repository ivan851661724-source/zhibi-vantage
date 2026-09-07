'use strict';
// ============================================================
// digest.js —— 每日邮件摘要（PRD R4）
// R4.2 每日一封：汇总近 24h 各租户预警（竞品动作 + 变价事件），无变化不发；
// R4.3 收件人：租户级 mailTo（alerts settings）> 租户账号邮箱；都没有 → 跳过该租户。
// 通道：services/mailer.js（HTTP API；未配置则整体 skipped，静默）。
// 失败不影响系统落盘（alerts 数据本就先落盘，邮件只是通知层）。
// ============================================================
const db = require('../services/db.js');
const Alerts = require('../services/alerts.js');
const mailer = require('../services/mailer.js');

const DIGEST_WINDOW_MS = 24 * 3600 * 1000;

// 汇总一个租户近 24h 的预警为纯文本正文（无变化返回 null）
function buildDigestText(alerts, trackNames) {
  const cutoff = Date.now() - DIGEST_WINDOW_MS;
  const recent = (alerts || []).filter(a => a && a.at && Date.parse(a.at) >= cutoff);
  if (!recent.length) return null;
  const lines = recent.slice(0, 30).map(a => {
    const track = (trackNames && (trackNames[a.projectId])) || a.track || '';
    const prefix = track ? '【' + track + '】' : '';
    if (a.type === 'price-change' || a.type === 'price-discovered') {
      return '- ' + prefix + (a.competitorName || a.competitorId || '对手') + ' ' + (a.text || '价格变动');
    }
    const moves = Array.isArray(a.moves) ? a.moves.join('；') : '';
    return '- ' + prefix + (a.competitorName || a.competitorId || '对手') + ' ' + (a.text || moves || '有新动作').slice(0, 120);
  });
  const head = '知彼 Vantage · 每日竞品动态摘要（' + new Date().toISOString().slice(0, 10) + '）';
  return head + '\n\n' + lines.join('\n') + '\n\n共 ' + recent.length + ' 条变化。打开工作台查看详情与来源。';
}

async function runDigest(now) {
  const out = { tenants: 0, sent: 0, noChange: 0, noRecipient: 0, failed: 0, skipped: false };
  if (!mailer.isConfigured()) { out.skipped = true; return out; } // 未配置邮件通道：整体静默跳过
  let tenants = [];
  try { tenants = db.listAllTenants(); } catch (e) { return Object.assign(out, { error: 'db_err' }); }
  for (const t of tenants) {
    if (t.status === 'suspended') continue;
    out.tenants++;
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

module.exports = { runDigest, buildDigestText };
