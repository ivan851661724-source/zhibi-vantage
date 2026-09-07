'use strict';
// 知彼 Vantage —— 零依赖 Node 后端（薄入口：HTTP 服务 + 边界闸 + 路由组装）
// 架构（2026-09 按功能拆分）：
//   core/     基础设施：paths/als/sse-hub/http-gate/config/state-store/version
//   research/ 研究链路：search/llm/net/evidence/vocab/candidates/discover/enrich/
//             deepdive/whitespace/fields/report/sweep/decorate/corrections/attempts
//   services/ 业务服务：auth/tenant/db/llm-gateway/metering/cache/tasks/cost/scheduler/...
//   routes/   声明式路由（ctx 依赖注入）；lib/ 纯函数领域模块（可单测）
const { buildVersionInfo } = require('./core/version.js');
const { activeSearchKey, ensureData, loadConfig, migrateConfigSecrets, saveConfig } = require('./core/config.js');
const { getCurrentId, listProjects, loadState, migrateResearchNamespaces, projFile, reportsFile, resolveTenantId, saveState, setCurrentId } = require('./core/state-store.js');
const { CATEGORIES, CHANNELS, marketCurrency, normalizeIntent } = require('./research/vocab.js');
const { decorateState } = require('./research/decorate.js');
const { attemptStateOf } = require('./research/attempts.js');
const { EXCLUDE_REASONS, constructFeedbackReport, extractCandidateRules } = require('./research/candidates.js');
const { discoverLaunch, runDiscover } = require('./research/discover.js');
const { enrichOne, lookupBrand, runQueue } = require('./research/enrich.js');
const { L2_MODULE_FIELDS, deepDiveField, deepTimelineOne } = require('./research/deepdive.js');
const { computeWhiteSpace } = require('./research/whitespace.js');
const { compareField, getCategoryField, getChannelField, getLaunchCadence, getPriceField, getReviewField, posSummary } = require('./research/fields.js');
const { buildReport } = require('./research/report.js');
const { startScheduler } = require('./research/sweep.js');
const Agg = require('./lib/aggregator.js');
const Alerts = require('./services/alerts.js');
const DomainReg = require('./lib/domain-registry.js');
const DomainRunner = require('./lib/domain-runner.js');
const Logger = require('./services/logger.js');
const M = require('./lib/metrics.js');
const MatEngine = require('./lib/material-engine.js');
const Metrics = require('./services/metrics.js');
const QD = require('./lib/quadrant.js');
const Routes = require('./routes/index.js');
const SW = require('./lib/sector-whitespace.js');
const TR = require('./lib/trend.js');
const Tasks = require('./services/tasks.js');
const UN = require('./lib/user-notes.js');
const VC = require('./lib/voice-collector.js');
const correctionOverlay = require('./lib/correction-overlay.js');
const db = require('./services/db.js');
const ipguard = require('./lib/ipguard.js');
const metering = require('./services/metering.js');
const sseHub = require('./core/sse-hub.js');
const { safeWrite, verifyStartupIntegrity } = require('./lib/fs-util.js');
const { CONFIG_PATH, CURRENT_PATH, DATA, PROJ_DIR } = require('./core/paths.js');
const { curTenantId, requestScope } = require('./core/als.js');
const { clientIp, discoverGate, getAuthPayload, rateLimited } = require('./core/http-gate.js');
const { bochaSearch, braveSearch, getSerperPool, serperSearchWithFailover, tavilySearch } = require('./services/providers/search.js');
const { resolveIdentity } = require('./middleware/tenantScope.js');
const { handleTenantRoutes } = require('./services/api-tenant.js');
const { handleAdminRoutes } = require('./services/api-admin.js');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT0 = parseInt(process.env.PORT || '3300', 10);
const config0 = loadConfig(); // 启动期配置快照（tenantScope legacyKey 分支需要）

// 公开端点（匿名可达）：版本锚定 + 演示闸门配置（F-04）+ 注册表版登录/注册
// （/api/auth/* 与 /api/admin/login 走分发器、在鉴权门之前；registry 版 /api/login、
//   /api/register 在鉴权门之后，需显式放行。全部登录端点已受 LOGIN_PATHS 严格限流。）
const PUBLIC_PATHS = new Set(['/api/version', '/api/public-config', '/api/login', '/api/register', '/api/sample', '/api/waitlist']);
// 登录/注册/超管登录：独立严格限流（防在线爆破 + scrypt 同步阻塞放大为 DoS）
const LOGIN_PATHS = new Set(['/api/login', '/api/register', '/api/auth/login', '/api/auth/register', '/api/admin/login']);

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
  return true; // registry 契约（handled === true）：handler 'return ctx.sendJSON(...)' 即视为已处理
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let failed = false;
    const fail = (err) => { if (failed) return; failed = true; reject(err); };
    req.on('data', c => {
      chunks.push(c);
      // 超限：立即拒绝（附带明确错误码），并销毁请求，避免连接泄漏 / Promise 永挂。
      if (Buffer.concat(chunks).length > 5e6) {
        req.destroy();
        fail(Object.assign(new Error('PAYLOAD_TOO_LARGE'), { code: 'PAYLOAD_TOO_LARGE' }));
      }
    });
    // 客户端中止 / 传输错误：必须 reject，否则 Promise 永挂、连接泄漏（P0-2）。
    req.on('aborted', () => fail(Object.assign(new Error('REQUEST_ABORTED'), { code: 'REQUEST_ABORTED' })));
    req.on('error', (e) => fail(e));
    req.on('end', () => {
      if (failed) return; // 已在超限/中止/错误路径处理
      try {
        const data = Buffer.concat(chunks).toString('utf8');
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        // 非法 JSON：带明确错误码 reject（registry 统一出口映射为 400，而非泄露解析器细节的 500）
        fail(Object.assign(new Error('BAD_JSON'), { code: 'BAD_JSON' }));
      }
    });
  });
}

// ============================================================
// 请求分发（闸序重排）：
//   ① ipguard（最外层边界，先于鉴权） → ② 限流（登录端点 10/min/IP；其余 POST 60/min/IP）
//   → ③ 租户/超管分发器（登录/注册经 ② 保护） → ④ 鉴权门（公开端点例外）
//   → ⑤ /metrics /healthz 收敛（仅环回或超管） → ⑥ 注册表路由 → 404
// ============================================================
async function handleRequest(req, res) {
  // requestId 用 ALS 贯穿整条请求链路（并发请求互不串扰；原模块级单例会被并发覆盖）
  return Logger.runWithRequestId(req, () => handleRequestInner(req, res));
}

async function handleRequestInner(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ---------- Phase 1 · L-可观测层：请求日志 + 指标（零侵入） ----------
  const reqStart = Date.now();
  res.on('finish', () => {
    const status = res.statusCode || 200;
    Metrics.recordRequest(status, Date.now() - reqStart);
    Logger.logRequest(req, p, status, Date.now() - reqStart, null);
  });

  // ---------- 边界闸：ipguard + 限流（覆盖包括登录在内的全部 /api/*） ----------
  if (p.startsWith('/api/')) {
    if (!ipguard.evaluate(clientIp(req))) {
      return sendJSON(res, 403, { error: 'IP_BLOCKED', message: '你的访问地址已被禁止。' });
    }
    if (LOGIN_PATHS.has(p)) {
      if (rateLimited(clientIp(req), 'login', 10, 60000)) {
        return sendJSON(res, 429, { error: 'RATE_LIMIT', message: '尝试过于频繁，请一分钟后再试。' });
      }
    } else if (req.method === 'POST' && rateLimited(clientIp(req), 'post', 60, 60000)) {
      return sendJSON(res, 429, { error: 'RATE_LIMIT', message: '请求过于频繁，请稍后再试。' });
    }
  }

  // ---------- 多租户骨架路由（v0.2）：未命中交还后续链路 ----------
  try {
    const config = loadConfig();
    const handled = await handleTenantRoutes(req, res, { p, url, config });
    if (handled) return;
  } catch (e) {
    sendJSON(res, 500, { error: 'TENANT_ROUTE_ERROR', detail: String(e && e.message || e) });
    return;
  }

  // ---------- 平台超管路由（独立凭证，与租户 JWT 不同密钥） ----------
  try {
    const config = loadConfig();
    const handledAdmin = await handleAdminRoutes(req, res, { p, url, config });
    if (handledAdmin) return;
  } catch (e) {
    sendJSON(res, 500, { error: 'ADMIN_ROUTE_ERROR', detail: String(e && e.message || e) });
    return;
  }

  // ---------- 鉴权门：除公开端点外要求有效身份令牌 ----------
  if (p.startsWith('/api/') && !PUBLIC_PATHS.has(p)) {
    const authPayload = getAuthPayload(req, url, p);
    if (!authPayload) return sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' });
  }

  // ---------- IP 管控管理（平台超管，P1-4.3） ----------
  if (p === '/api/admin/ip-rules' && req.method === 'GET') {
    const ap = getAuthPayload(req);
    if (!(ap && ap.kind === 'admin')) return sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅平台超管可查看 IP 规则。' });
    return sendJSON(res, 200, ipguard.list());
  }
  if ((p === '/api/admin/ip-block' || p === '/api/admin/ip-allow') && req.method === 'POST') {
    const ap = getAuthPayload(req);
    if (!(ap && ap.kind === 'admin')) return sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅平台超管可管理 IP 规则。' });
    const body = await readBody(req);
    const ip = (body.ip || '').trim();
    if (!ip) return sendJSON(res, 400, { error: 'EMPTY', message: '请填写 IP' });
    let ok = false;
    if (p === '/api/admin/ip-block') ok = body.action === 'unblock' ? ipguard.unblockIp(ip) : ipguard.blockIp(ip);
    else ok = body.action === 'remove' ? ipguard.removeAllow(ip) : ipguard.allowIp(ip);
    return sendJSON(res, 200, { ok: !!ok, rules: ipguard.list() });
  }

  // ---------- Phase 1 · L-接入层：注册表路由分发（声明式，ctx 依赖注入） ----------
  {
    const routeCtx = {
      sendJSON, readBody, loadState, saveState, decorateState, computeWhiteSpace,
      marketCurrency, buildVersionInfo, getAuthPayload, rateLimited, clientIp,
      DomainRunner, DomainReg, MatEngine, M, QD, UN, VC, Agg, SW, TR,
      compareField, constructFeedbackReport, extractCandidateRules,
      Metrics, Logger, DATA,
      // 预警推送 + SSE 枢纽（按租户分通道）+ 采集/研究组
      Alerts, sseHub, discoverGate, discoverFn: runDiscover, discoverLaunch, enrichOne, lookupBrand,
      deepTimelineOne, buildReport, deepDiveField, attemptStateOf, L2_MODULE_FIELDS,
      // 纠错组依赖
      resolveIdentity, config0, curTenantId, correctionOverlay,
      CHANNELS, CATEGORIES, EXCLUDE_REASONS, posSummary, normalizeIntent,
      getPriceField, getChannelField, getCategoryField, getLaunchCadence, getReviewField,
      // 配置/档案组依赖
      loadConfig, saveConfig, ensureData, getSerperPool, activeSearchKey,
      tavilySearch, serperSearchWithFailover, braveSearch, bochaSearch,
      setCurrentId, getCurrentId, listProjects, resolveTenantId, projFile, reportsFile, safeWrite,
      fs,
    };
    const handled = await Routes.dispatch(routeCtx, req, res, url, p);
    if (handled) return;
  }

  // Phase 5：旧静态前端已删除；未注册路径统一 404 JSON。Web 入口走 :3000。
  sendJSON(res, 404, { error: 'NOT_FOUND', message: '接口不存在。Web 入口请走 :3000。' });
}

// 真正的 HTTP 服务入口：请求进入时解出 tenantId 注入 AsyncLocalStorage（P0-2.1），
// 使 loadState / getCurrentId 等在无显式 tenantId 时也能取到正确命名空间；
// 后台 detached 队列（runQueue）脱离请求上下文，靠 state.tenantId 兜底。
const server = http.createServer((req, res) => {
  let url = null;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { /* 畸形 URL 交下游 404 */ }
  const id = resolveIdentity(req, config0, url);
  if (id.error === 403) {
    sendJSON(res, 403, { error: 'TENANT_SUSPENDED', message: '该租户已被暂停，请联系平台管理员。' });
    return;
  }
  // 401（无令牌/令牌失效）：交给 handleRequest 的鉴权门裁决（公开端点例外放行）。
  const tid = id.tenantId || null;
  requestScope.run(tid, () => handleRequest(req, res));
});

// 单实例锁：同一数据目录只允许一个服务进程，避免多实例抢写 current.json 触发 EPERM。
// 旧版行为是「端口被占就 +1 继续跑」，导致同目录多个实例静默共存、互锁文件。
const LOCK_PATH = path.join(DATA, '.server-lock');
// 锁心跳过期阈值：运行中实例每 30s 刷新一次 at；超过该阈值视为僵尸锁（进程被强杀/PID 复用），自动清除放行
const LOCK_STALE_MS = 75 * 1000;
function acquireLock() {
  try {
    if (fs.existsSync(LOCK_PATH)) {
      const txt = fs.readFileSync(LOCK_PATH, 'utf8');
      const old = JSON.parse(txt || '{}');
      if (old.pid && old.pid !== process.pid) {
        let alive = false;
        try { process.kill(old.pid, 0); alive = true; } catch (e) { alive = false; }
        let stale = false;
        try { stale = !old.at || (Date.now() - new Date(old.at).getTime() > LOCK_STALE_MS); } catch (e) { stale = true; }
        if (alive && !stale) {
          console.error('启动中止：同数据目录已有实例在运行 (PID ' + old.pid +
            (old.port ? '，端口 ' + old.port : '') + ')。如需重启，请先结束该进程，或删除 ' + LOCK_PATH);
          process.exit(1);
        }
        if (stale) {
          const ageSec = old.at ? Math.round((Date.now() - new Date(old.at).getTime()) / 1000) : -1;
          console.error('检测到过期单实例锁（PID ' + old.pid + ' 心跳停滞约 ' + ageSec + 's），自动清除后继续启动');
          try { fs.unlinkSync(LOCK_PATH); } catch (e) {}
        }
      }
    }
  } catch (e) { /* 锁文件损坏则忽略，继续尝试获取 */ }
}
function writeLock(port) {
  try { fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, port, at: new Date().toISOString() })); } catch (e) {}
}
function startLockHeartbeat() {
  setInterval(() => {
    try {
      if (fs.existsSync(LOCK_PATH)) {
        const t = fs.readFileSync(LOCK_PATH, 'utf8');
        const o = JSON.parse(t || '{}');
        if (o.pid === process.pid) { o.at = new Date().toISOString(); fs.writeFileSync(LOCK_PATH, JSON.stringify(o)); }
      }
    } catch (e) {}
  }, 30 * 1000).unref();
}
function releaseLock() {
  try { if (fs.existsSync(LOCK_PATH)) { const t = fs.readFileSync(LOCK_PATH, 'utf8'); const o = JSON.parse(t || '{}'); if (!o.pid || o.pid === process.pid) fs.unlinkSync(LOCK_PATH); } } catch (e) {}
}
process.on('exit', releaseLock);
process.on('SIGINT', () => { releaseLock(); process.exit(0); });
process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

// 生产止血 P0：全局兜底——未捕获异常/未处理拒绝不再直接杀死进程（此前任一背景 async 报错即整站崩溃）。
// 仅记录到错误日志与控制台，保持服务可用；严重到需重启的情形由运维/编排层处理。
const ERR_LOG = path.join(DATA, 'server-error.log');
function logFatal(tag, err) {
  const detail = (err && err.stack) ? err.stack : String(err);
  const line = '[' + new Date().toISOString() + '] ' + tag + ': ' + detail + '\n';
  try { fs.appendFileSync(ERR_LOG, line); } catch (e) {}
  console.error(line);
}
process.on('uncaughtException', (e) => { logFatal('uncaughtException', e); });
process.on('unhandledRejection', (reason) => { logFatal('unhandledRejection', reason && (reason.stack || reason)); });
acquireLock();

// 端口固定（修复 P2 漂移反模式）：只绑定 PORT0，绝不自动 +1。
// 端口被占用时显式失败并给出可操作提示，避免「3000/3001 身份漂移」这类难排查问题。
function startServer(port) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('启动失败：端口 ' + port + ' 已被占用，且本服务不会自动换端口。');
      console.error('可能原因：① 另一个服务（如老看板 competitor-dashboard）占用了该端口；② 同数据目录另有实例在运行（见 ' + LOCK_PATH + '）。');
      console.error('解决：释放该端口后重启，或显式指定其他端口，例如：  PORT=3100 node server.js');
      process.exit(1);
    }
    console.error('启动失败:', e.message);
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => {
    const p = server.address().port;
    writeLock(p);
    startLockHeartbeat();
    const v = buildVersionInfo();
    console.log('知彼 Vantage已启动: http://localhost:' + p + '  (数据目录: ' + DATA + ')');
    console.log('[自检] 版本 v' + v.version + ' · commit ' + v.commit + ' · PID ' + v.pid + ' · 启动于 ' + v.startedAt + ' · node ' + v.node);
    // 护栏状态可见性（技术债 §7.2）：默认演示态宽松，上线需显式开启——启动日志直陈当前状态防误判
    console.log('[自检] 护栏状态: 配额 QUOTA_ENABLED=' + (process.env.ZB_QUOTA_ENABLED === '1' ? 'ON(限流生效)' : 'OFF(默认全量放行, 上线请设 ZB_QUOTA_ENABLED=1)') + ' · 日预算 ZB_DAILY_BUDGET_YUAN=' + (process.env.ZB_DAILY_BUDGET_YUAN || 'unset(不熔断)') + ' · 定时雷达 SCHEDULER_ENABLED=' + (process.env.SCHEDULER_ENABLED === '0' ? 'OFF' : 'ON'));
    // 模块 2-1：启动定时增量雷达（SCHEDULER_ENABLED=0 关闭）
    startScheduler();
    // 锁文件 PID 一致性校验（§5-1）：进程 PID 必须与落盘锁一致，否则说明旧实例未清理干净
    try {
      const lk = JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8') || '{}');
      if (lk.pid && lk.pid !== process.pid) {
        console.warn('[自检警告] 锁文件 PID (' + lk.pid + ') 与当前进程 (' + process.pid + ') 不一致 —— 疑似旧实例残留，请核查');
      } else {
        console.log('[自检] 锁文件 PID 一致 ✓');
      }
    } catch (e) {}
  });
  return server;
}
// P0-8 启动完整性校验：损坏的关键 JSON 尝试从 .bak 恢复，保证「中断留下半截文件」不至于起不来。
try {
  const crit = [CURRENT_PATH, CONFIG_PATH]; // reports.json 已改为按租户命名空间落盘（P1-7），不再全局校验
  if (fs.existsSync(PROJ_DIR)) {
    for (const f of fs.readdirSync(PROJ_DIR)) {
      if (f.endsWith('.json')) crit.push(path.join(PROJ_DIR, f));
    }
  }
  for (const n of ['gap_snapshots', 'events', 'insight_consumption', 'calibration', 'accuracy_samples', 'accuracy_summary']) {
    crit.push(path.join(DATA, n + '.json'));
  }
  const rep = verifyStartupIntegrity(crit);
  if (rep.corrupt.length) {
    console.error('[integrity] 启动校验：' + rep.checked + ' 个正常，' + rep.corrupt.length + ' 个损坏' +
      (rep.restored.length ? '（已从 .bak 恢复 ' + rep.restored.length + ' 个）' : '（无可用备份，下次合法写入将自愈）'));
  } else {
    console.log('[integrity] 启动校验通过：' + rep.checked + ' 个关键 JSON 文件均完整');
  }
} catch (e) {
  console.error('[integrity] 校验异常（忽略，继续启动）:', e.message);
}
// P0-4.1 启动迁移：已设 MT_MASTER_KEY 且 config 仍为明文密钥时，一次性加密落盘
migrateConfigSecrets();
// P0-2.1 启动迁移：把升级前扁平的研究档案迁入首个真实租户的命名空间（幂等，标记防重复）
migrateResearchNamespaces();
// 模块 0-4：启动回收崩溃遗留的 running 任务（claimExpiresAt 过期 → 回 pending，断点续跑）
try { Tasks.reclaimExpired(Date.now()); } catch (e) { /* 非致命 */ }
startServer(PORT0);

