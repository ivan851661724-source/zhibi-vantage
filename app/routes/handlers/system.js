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

// ---------- /api/waitlist（POST：候补名单，R5.2） ----------
// 超出每日免费额度时，用户留联系方式进候补（运营后续触达）。匿名可提交（登录前也可能超额提示）。
async function waitlist(ctx, req, res, url, p) {
  if (p !== '/api/waitlist' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const contact = String(body.contact || '').trim().slice(0, 120);
  if (!contact) { ctx.sendJSON(res, 400, { error: 'EMPTY', message: '请填写联系方式（邮箱/微信/手机）' }); return true; }
  const fsMod = require('fs');
  const pathMod = require('path');
  const dataDir = ctx.DATA;
  if (!fsMod.existsSync(dataDir)) fsMod.mkdirSync(dataDir, { recursive: true });
  const file = pathMod.join(dataDir, 'waitlist.json');
  let arr = [];
  try { arr = JSON.parse(fsMod.readFileSync(file, 'utf8')); if (!Array.isArray(arr)) arr = []; } catch (e) {}
  // 同联系方式去重（更新 note 即可，不重复占位）
  const dup = arr.find(x => x.contact === contact);
  if (!dup) {
    arr.push({ at: new Date().toISOString(), contact, note: String(body.note || '').slice(0, 200), source: 'quota-exceeded' });
    fsMod.writeFileSync(file, JSON.stringify(arr, null, 2));
  }
  ctx.sendJSON(res, 200, { ok: true, message: '已加入候补名单，我们会尽快联系你。' });
  return true;
}

// ---------- /api/sample（GET：真实调研数据示例，R7.2） ----------
// 数据源 = data/sample/sample-state.json（运维导入的一次**真实调研**导出——PRD 明确不用 mock）。
// 闸门与演示模式同源（ZB_DEMO_ALLOWED=1）；未导入样例或未开闸 → 404（前端回退提示，不喂 mock）。
async function sample(ctx, req, res, url, p) {
  if (p !== '/api/sample' || req.method !== 'GET') return false;
  if (process.env.ZB_DEMO_ALLOWED !== '1') { ctx.sendJSON(res, 404, { error: 'NO_SAMPLE' }); return true; }
  const fsMod = require('fs');
  const pathMod = require('path');
  const file = pathMod.join(ctx.DATA, 'sample', 'sample-state.json');
  try {
    const state = JSON.parse(fsMod.readFileSync(file, 'utf8'));
    ctx.sendJSON(res, 200, state);
  } catch (e) {
    ctx.sendJSON(res, 404, { error: 'NO_SAMPLE', message: '示例数据未导入（data/sample/sample-state.json）' });
  }
  return true;
}

module.exports = { metrics, healthz, publicConfig, waitlist, sample };

// ---------- /api/public-config（GET，public）：前端启动期读取的公开开关 ----------
// 当前仅演示模式闸门（F-04）：生产部署不设 ZB_DEMO_ALLOWED=1 时，?demo=1 直进被前端拦截。
async function publicConfig(ctx, req, res, url, p) {
  if (p !== '/api/public-config' || req.method !== 'GET') return false;
  const demoAllowed = process.env.ZB_DEMO_ALLOWED === '1';
  ctx.sendJSON(res, 200, { demoAllowed: demoAllowed });
  return true;
}
