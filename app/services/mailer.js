'use strict';
// ============================================================
// mailer.js —— 邮件通道（PRD R4.1：HTTP API 方式，未配置则静默跳过）
//
// 配置（环境变量，避免改 config.json 的保存链路）：
//   ZB_MAIL_API_URL  邮件 HTTP API 地址（POST JSON：{ to, from, subject, text }）
//                    兼容大多数邮件服务商的 HTTP 入口 / 自建网关（如 listmonk、
//                    Mailgun messages API 代理、Server 酱类推送网关等）
//   ZB_MAIL_API_KEY  可选，作为 Bearer Token 附带
//   ZB_MAIL_FROM     可选，发件人标识
// 纪律：未配置 → skipped（调用方据此静默跳过）；发送失败只记日志，绝不阻断主链路。
// ============================================================

function isConfigured() {
  return !!process.env.ZB_MAIL_API_URL;
}

/**
 * 发一封邮件。返回 { ok:true } | { ok:false, skipped:true }（未配置）| { ok:false, error }。
 * text 为纯文本正文（digest 用，不引依赖做 HTML）。
 */
async function sendMail({ to, subject, text }) {
  const url = process.env.ZB_MAIL_API_URL;
  if (!url || !to) return { ok: false, skipped: true };
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.ZB_MAIL_API_KEY) headers.Authorization = 'Bearer ' + process.env.ZB_MAIL_API_KEY;
  const body = { to, subject: String(subject || '').slice(0, 200), text: String(text || '').slice(0, 20000) };
  if (process.env.ZB_MAIL_FROM) body.from = process.env.ZB_MAIL_FROM;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      try { require('./logger.js').warn('mail 发送失败', { status: r.status, to: '***' }); } catch (e) {}
      return { ok: false, error: 'MAIL_' + r.status };
    }
    return { ok: true };
  } catch (e) {
    try { require('./logger.js').warn('mail 发送异常', { err: String(e && e.message || e).slice(0, 120) }); } catch (e2) {}
    return { ok: false, error: String(e && e.message || e) };
  }
}

module.exports = { isConfigured, sendMail };
