'use strict';
// ============================================================
// 结构化日志（Phase 1 · L-可观测层）
// ------------------------------------------------------------
// 设计纪律（评审 P1：日志脱敏）：
//   默认只记「元数据 + 结果码」，绝不记业务载荷——材料摘要、搜索词、
//   竞品名称、用户纠错原文一律不进日志。如确需诊断，走 DEBUG 开关，
//   且对 source.url / email / apiKey 做脱敏替换。
// 验收标准：日志文件中 grep 不到任何一条用户输入的搜索词/纠错文本。
// 零依赖：仅用 Node 内置模块；写入 data/logs/<date>.log（自动轮转）。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = process.env.ZB_LOG_DIR || path.join(ROOT, 'data', 'logs');

// 脱敏规则：对字符串做模式替换，防密钥/URL/邮箱进日志
function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, 'sk-***')          // API key 形态
    .replace(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '***@***') // email
    .replace(/https?:\/\/[^\s"'<>]+/g, 'https://***');        // URL
}

// 级别阈值：debug(10) < info(20) < warn(30) < error(40)
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const levelEnabled = (lv) => (LEVELS[lv] || 20) >= (LEVELS[process.env.ZB_LOG_LEVEL || 'info'] || 20);

let currentRequestId = null;

function ensureDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
}

function logFile() {
  const d = new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `server-${y}-${m}-${dd}.log`);
}

function emit(level, action, fields) {
  if (!levelEnabled(level)) return;
  ensureDir();
  const entry = Object.assign(
    {
      ts: new Date().toISOString(),
      level,
      requestId: currentRequestId || null,
      action,
    },
    fields || {}
  );
  const line = JSON.stringify(entry) + '\n';
  try { fs.appendFileSync(logFile(), line); } catch (e) { /* 日志写失败不致命 */ }
  if (level === 'error' || level === 'warn' || process.env.ZB_LOG_CONSOLE === '1') {
    console[level === 'error' ? 'error' : 'log']('[' + level.toUpperCase() + ']', action, redact(JSON.stringify(fields || {})));
  }
}

// 请求入口：绑定 requestId 供整条链路复用
function withRequestId(req) {
  currentRequestId = (req && req.headers && req.headers['x-request-id'])
    || ('req-' + crypto.randomBytes(6).toString('hex'));
  return currentRequestId;
}

function clearRequestId() { currentRequestId = null; }

// 请求完成日志：只记方法/路径/状态/耗时/租户，不记 body
function logRequest(req, pathname, status, durationMs, tenantId) {
  emit('info', 'http_request', {
    method: req && req.method,
    path: pathname || '/',
    status,
    durationMs: Math.round(durationMs || 0),
    tenantId: tenantId || null,
    ip: req && req.headers ? redact(String(req.headers['x-forwarded-for'] || req.socket && req.socket.remoteAddress || '').slice(0, 45)) : null,
  });
}

module.exports = {
  LEVELS,
  emit,
  debug: (action, fields) => emit('debug', action, fields),
  info: (action, fields) => emit('info', action, fields),
  warn: (action, fields) => emit('warn', action, fields),
  error: (action, fields) => emit('error', action, fields),
  withRequestId,
  clearRequestId,
  logRequest,
  redact,
  LOG_DIR,
};
