'use strict';
// ============================================================
// 结构化日志（Phase 1 · L-可观测层）
// ------------------------------------------------------------
// 设计纪律（评审 P1：日志脱敏）：
//   默认只记「元数据 + 结果码」，绝不记业务载荷——材料摘要、搜索词、
//   竞品名称、用户纠错原文一律不进日志。如确需诊断，走 DEBUG 开关，
//   且对 source.url / email / apiKey 做脱敏替换。
// 验收标准：日志文件中 grep 不到任何一条用户输入的搜索词/纠错文本。
//   （文件行同样过 redact：任何一处把用户可控字段传进 fields 也不会明文落盘。）
// 并发修复：requestId 存 AsyncLocalStorage（原模块级单例被并发请求互踩）。
// 保留期：默认保留 14 天（ZB_LOG_RETENTION_DAYS 可调），每日首次写入时清理旧文件。
// 零依赖：仅用 Node 内置模块；写入 data/logs/<date>.log（按天分文件）。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');

const ROOT = path.join(__dirname, '..');
const LOG_DIR = process.env.ZB_LOG_DIR
  || (process.env.ZB_DATA_DIR ? path.join(path.resolve(process.env.ZB_DATA_DIR), 'logs') : path.join(ROOT, 'data', 'logs'));

// 脱敏规则：对字符串做模式替换，防密钥/URL/邮箱进日志
function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, 'sk-***')          // API key 形态
    .replace(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '***@***') // email
    .replace(/https?:\/\/[^\s"'<>]+/g, 'https://***');        // URL
}
// 深度脱敏：entry 里任何字符串字段都过 redact（防调用方漏判"元数据"）
function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = redactDeep(v[k]);
    return o;
  }
  return v;
}

// 级别阈值：debug(10) < info(20) < warn(30) < error(40)
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const levelEnabled = (lv) => (LEVELS[lv] || 20) >= (LEVELS[process.env.ZB_LOG_LEVEL || 'info'] || 20);

// requestId 上下文：并发请求各自隔离（原全局单例会让 A 的日志记到 B 名下）
const reqStore = new AsyncLocalStorage();

function ensureDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
}

function logFile() {
  const d = new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), dd = String(d.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `server-${y}-${m}-${dd}.log`);
}

// 保留期清理：每天最多执行一次；删除超过保留期的 server-*.log
let _lastCleanupDay = null;
function cleanupOldLogs() {
  const day = new Date().toISOString().slice(0, 10);
  if (day === _lastCleanupDay) return;
  _lastCleanupDay = day;
  const keepDays = Math.max(1, parseInt(process.env.ZB_LOG_RETENTION_DAYS || '14', 10) || 14);
  const cutoff = Date.now() - keepDays * 86400000;
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      if (!/^server-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const t = Date.parse(f.slice(7, 17) + 'T00:00:00Z');
      if (Number.isFinite(t) && t < cutoff) { try { fs.unlinkSync(path.join(LOG_DIR, f)); } catch (e) {} }
    }
  } catch (e) { /* 目录不存在等，忽略 */ }
}

function emit(level, action, fields) {
  if (!levelEnabled(level)) return;
  ensureDir();
  cleanupOldLogs();
  const entry = Object.assign(
    {
      ts: new Date().toISOString(),
      level,
      requestId: reqStore.getStore() || null,
      action,
    },
    fields || {}
  );
  const line = JSON.stringify(redactDeep(entry)) + '\n';
  try { fs.appendFileSync(logFile(), line); } catch (e) { /* 日志写失败不致命 */ }
  if (level === 'error' || level === 'warn' || process.env.ZB_LOG_CONSOLE === '1') {
    console[level === 'error' ? 'error' : 'log']('[' + level.toUpperCase() + ']', action, redact(JSON.stringify(fields || {})));
  }
}

// 请求入口：绑定 requestId 供整条链路复用（并发安全）。
// runWithRequestId 把整个请求处理闭包包进 ALS——后续任意深度异步链路内的
// emit() 都能取到本请求的 requestId；withRequestId/currentRequestId 保留兼容。
function runWithRequestId(req, fn) {
  const id = (req && req.headers && req.headers['x-request-id'])
    || ('req-' + crypto.randomBytes(6).toString('hex'));
  return reqStore.run(id, fn);
}
function withRequestId(req) {
  const id = (req && req.headers && req.headers['x-request-id'])
    || ('req-' + crypto.randomBytes(6).toString('hex'));
  return reqStore.run(id, () => id) || id;
}
function currentRequestId() { return reqStore.getStore() || null; }
function clearRequestId() { /* ALS 随请求上下文自动销毁；保留 API 兼容 */ }

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
  runWithRequestId,
  currentRequestId,
  clearRequestId,
  logRequest,
  redact,
  LOG_DIR,
};
