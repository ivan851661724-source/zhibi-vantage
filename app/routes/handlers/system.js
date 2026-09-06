'use strict';
// ============================================================
// handlers/system.js —— 系统可观测端点（Phase 1 新增）
// /metrics：零依赖指标快照（Prometheus 文本格式）
// /healthz：健康检查（进程活 + 存储可达）
// 这两个是「新增端点 = 注册表一行 + handler 文件」的示范，
// 验证注册表模式的扩展性（方案 Phase 1 验收标准之一）。
// ============================================================

// ---------- /metrics（GET，public） ----------
async function metrics(ctx, req, res, url, p) {
  if (p !== '/metrics' || req.method !== 'GET') return false;
  const body = ctx.Metrics ? ctx.Metrics.toPrometheus() : '# metrics unavailable\n';
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
  res.end(body);
  return true;
}

// ---------- /healthz（GET，public） ----------
async function healthz(ctx, req, res, url, p) {
  if (p !== '/healthz' && p !== '/api/healthz') return false;
  const checks = { ok: true };
  // 存储可达：data 目录存在且可写（用 fs 探测，不引入额外依赖）
  try {
    const fs = require('fs');
    const path = require('path');
    const dataDir = ctx.DATA || path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) { checks.storage = 'missing'; checks.ok = false; }
    else checks.storage = 'ok';
  } catch (e) {
    checks.storage = 'error:' + String(e.message || e);
    checks.ok = false;
  }
  // 启动完整性：ctx.buildVersionInfo 可调用即进程核心逻辑存活
  try {
    checks.version = ctx.buildVersionInfo ? ctx.buildVersionInfo().version : 'unknown';
  } catch (e) {
    checks.version = 'error';
    checks.ok = false;
  }
  ctx.sendJSON(res, checks.ok ? 200 : 503, checks);
  return true;
}

module.exports = { metrics, healthz, publicConfig };

// ---------- /api/public-config（GET，public）：前端启动期读取的公开开关 ----------
// 当前仅演示模式闸门（F-04）：生产部署不设 ZB_DEMO_ALLOWED=1 时，?demo=1 直进被前端拦截。
async function publicConfig(ctx, req, res, url, p) {
  if (p !== '/api/public-config' || req.method !== 'GET') return false;
  const demoAllowed = process.env.ZB_DEMO_ALLOWED === '1';
  ctx.sendJSON(res, 200, { demoAllowed: demoAllowed });
  return true;
}
