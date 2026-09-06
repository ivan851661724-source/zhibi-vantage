'use strict';
// ============================================================
// alerts.js —— 主动推送预警通道（2026-09-05 技术债 §6 ⬜「仅检测无推送」修复）
// ------------------------------------------------------------
// 站内信：按租户落盘 data/alerts/<ns>/alerts.json（追加式，保留最近 MAX_PER_TENANT 条），
//         GET /api/alerts 供前端轮询/SSE 展示。
// Webhook：config.alerts.webhookUrl 配置后，push 同时 POST JSON（零依赖 fetch，超时 8s，失败静默）。
// 邮件：零依赖 SMTP 实现成本高 → 明确规划中（对外材料不得写"邮件提醒已上线"）。
// 触发源：scheduler sweep 检测竞品 recentMoves 变化 → server.js sweepProject 调 push。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA = path.join(__dirname, '..', 'data');
const ALERTS_DIR = path.join(DATA, 'alerts');
const MAX_PER_TENANT = 200;

function nsOf(tenantId) {
  return String(tenantId || '_legacy').replace(/[^a-zA-Z0-9_-]/g, '_');
}
function fileOf(tenantId) {
  const dir = path.join(ALERTS_DIR, nsOf(tenantId));
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return path.join(dir, 'alerts.json');
}
function readAll(tenantId) {
  try { return JSON.parse(fs.readFileSync(fileOf(tenantId), 'utf8')); } catch (e) { return []; }
}
function writeAll(tenantId, arr) {
  try { fs.writeFileSync(fileOf(tenantId), JSON.stringify(arr)); } catch (e) { /* 非致命 */ }
}

// 推送一条预警：落盘 + Webhook（webhookUrl 由调用方从 config 注入，避免本模块读含密钥的 config）
function push(tenantId, alert, webhookUrl) {
  const a = Object.assign({
    id: 'al_' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex'),
    at: new Date().toISOString(),
    read: false,
  }, alert || {});
  const arr = readAll(tenantId);
  arr.push(a);
  if (arr.length > MAX_PER_TENANT) arr.splice(0, arr.length - MAX_PER_TENANT);
  writeAll(tenantId, arr);
  if (webhookUrl) {
    try {
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'zhibi-alert', alert: a }),
        signal: AbortSignal.timeout(8000),
      }).catch(() => { /* webhook 失败静默（不阻断 sweep） */ });
    } catch (e) { /* 同步异常也不阻断 */ }
  }
  return a;
}

// 读取（新→旧）；limit 默认 50
function list(tenantId, limit) {
  const arr = readAll(tenantId);
  return arr.slice(-(limit || 50)).reverse();
}

// 标记已读（ids 命中数）
function markRead(tenantId, ids) {
  const arr = readAll(tenantId);
  const idSet = new Set(ids || []);
  arr.forEach(x => { if (idSet.has(x.id)) x.read = true; });
  writeAll(tenantId, arr);
  return arr.filter(x => idSet.has(x.id)).length;
}

module.exports = { push, list, markRead };
