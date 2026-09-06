'use strict';
// 知彼 Vantage —— 零依赖 Node 后端（仅用内置模块，无需 npm install）
// 功能：/api 发现引擎（扇出搜索 + 两阶段 harvest + 后台逐家深研 + 空白推理 + 行业调研报告）
// Phase 5 起为纯 API 服务：静态前端已删除，Web 入口由 zhibi-web（Next.js 容器）反代提供。
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(DATA, 'config.json');
const STATE_PATH = path.join(DATA, 'state.json'); // 旧版单档案（仅迁移用）
const PROJ_DIR = path.join(DATA, 'projects');      // 多调研档案目录
const CURRENT_PATH = path.join(DATA, 'current.json'); // 当前档案指针

// 价格字段值级裁决树（护城河本体，纯模块，可单测）
const { buildPriceField, parsePriceRange } = require('./lib/pricefield.js');
const PF = require('./lib/price-forensics.js'); // P0 #2 · L2 价格主动取证（非 Shopify 站带 URL 抓取）
// 渠道字段值级裁决树（与价格同构；统一契约 + 值级交叉验证 + 可纠错闭环）
const { buildChannelField } = require('./lib/channelfield.js');
// 品类字段值级裁决树（与渠道同构；复用通用集合引擎 lib/setfield.js）
const { buildCategoryField } = require('./lib/categoryfield.js');
// 标量字段值级裁决树（上新节奏 / 口碑 复用；统一契约 + 值级交叉验证 + 可纠错闭环）
const { buildScalarField } = require('./lib/scalarfield.js');
// 口碑复合字段值级裁决树（rating/trend 标量 + neg/pos 主题列表；与价格/渠道同构）
const { buildReviewField } = require('./lib/reviewfield.js');
const FC = require('./lib/field-confidence.js'); // P1-7 · A1：四态 + 独立来源数上卷
// 度量与持久化层（评审 P0-2/3/4 地基）：三表落盘 + 校准协议 + 字段准确率门禁
const M = require('./lib/metrics.js');
const { applyAccuracyGate, loadAccuracySummary } = M;
const { AsyncLocalStorage } = require('async_hooks');
// 研究链路请求级租户上下文（P0-2.1）：在 createServer 处把请求解出的 tenantId 注入 ALS，
// 供 loadState / getCurrentId 等在请求内（无显式 tenantId）时取用。后台队列脱离请求上下文，
// 故 saveState 同时依赖 state.tenantId（在 discover / lookupBrand 创建时写入）。
const requestScope = new AsyncLocalStorage();
const FU = require('./lib/fs-util.js');
const { safeWrite, verifyStartupIntegrity, bestEffortWrite, mutateFile } = FU;
// 密钥加密 at rest（P0-4.1）：config.json 中的搜索源 / LLM 密钥加密存储，主密钥取自 MT_MASTER_KEY
const secret = require('./lib/secret.js');
// IP 管控（P1-4.3）：封禁 / 白名单
const ipguard = require('./lib/ipguard.js');

// 多租户骨架（v0.2）：账号 / 租户 / 额度 / 隔离 / 脱敏。零依赖，仅用内置 crypto。
const { handleTenantRoutes } = require('./services/api-tenant.js');
const { handleAdminRoutes } = require('./services/api-admin.js');

// T1-1：研究成本计量 —— 复用已存在的 services/metering.js（绝对不重写它，它是新底座、自洽）。
const metering = require('./services/metering.js');

// T3-1：存储统一（最小做）—— 复用已存在的 services/db.js，把文件态研究档案镜像进 db 项目清单。
// 不重写 db.js（新底座、自洽）；只借它的 saveProject/getProject 做 upsert。
const db = require('./services/db.js');

// T1-2：旧研究端点身份统一（堵封禁绕过 R2）。
// 在 server 入口用 resolveIdentity 替换 getAuthPayload，统一执行 suspended 封禁裁决。
// 旧 getAuthPayload 不查 suspended，会让被封禁租户仍可调 discover/enrich/lookup/timeline/field-correct/state 等旧端点。
// 注意：resolveIdentity 仅用于入口层"是否放行"；admin/ghost 角色判定仍由各端点内部 getAuthPayload 处理（见 3432/3443/3448/3578/3741），不删。
const { resolveIdentity } = require('./middleware/tenantScope.js');
const config0 = loadConfig(); // tenantScope 的 legacyKey 分支需要；一次性捕获即可（SOP 指定，loadConfig 为函数声明已 hoist）

// 平台鉴权（v0.2）：租户 JWT + 超管 token 复用 services/auth.js
const Auth = require('./services/auth.js');

// ============ Phase 1 · L-可观测层 + L-接入层（注册表路由） ============
// 结构化日志 / 指标计数：零依赖，JSON lines 落盘 data/logs/，/metrics 端点输出
const Logger = require('./services/logger.js');
const Metrics = require('./services/metrics.js');
// 声明式路由注册表：加端点 = routes/index.js 一行 + routes/handlers/ 一个文件。
// 渐进式接管：handleRequest 先查注册表，命中走 handler，未命中走下方旧路由（行为不变）。
const Routes = require('./routes/index.js');
// 外部搜索源统一封装（L-外部依赖层）：serper 多 key failover / tavily / brave / bocha
const SearchProviders = require('./services/providers/search.js');
const {
  tavilySearch, serperSearch, normalizeSerperKeys, classifySerperError,
  serperSearchWithFailover, getSerperPool, braveSearch, bochaSearch, glFromRegions,
} = SearchProviders;
// 模块 2-2：跨 provider 健康度路由（Serper→Brave→Bocha→Tavily 备用源切换）
const ProviderHealth = require('./services/providers/health.js');
// ============ 数据自动化（A12 实施）：LLM 网关 / 三层缓存 / 任务队列 / 成本归因 ============
// 模块 0-2：LLM 统一网关（45s 超时 / 重试×2 / 熔断 / 字段级降级）+ 1-1 成本归因
const LLMGateway = require('./services/llm-gateway.js');
// 模块 0-3：SERP 24h / 探测 7d / 页面 72h 三层缓存（命中免配额）
const Cache = require('./services/cache.js');
// 模块 0-4：research_tasks 表（claimToken 三步协议 + 回收，断点续跑）
const Tasks = require('./services/tasks.js');
// 模块 1-1：成本归因（cost_telemetry 表 / 日预算熔断）—— 经 LLMGateway 自动记账
const Cost = require('./services/cost.js');
// 模块 2-1：定时增量雷达调度（日 4 趟，runSweep 由本文件注入）
const Scheduler = require('./services/scheduler.js');
// =====================================================================

// ---------- 生产止血：鉴权 / 限流 / 并发护栏 ----------
// 解析请求身份：租户 JWT 或平台超管 token，任一有效即通过。
function getAuthPayload(req) {
  const h = req.headers && req.headers['authorization'];
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  const t = Auth.verifyToken(token);
  if (t) return { kind: 'tenant', payload: t };
  const a = Auth.verifyAdminToken(token);
  if (a) return { kind: 'admin', payload: a };
  return null;
}
// 客户端 IP（兼容反向代理 x-forwarded-for）
function clientIp(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) { const f = String(xff).split(',')[0].trim(); if (f) return f; }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
// 简单内存固定窗口限流（止血用；生产应换 Redis 等集中式）
const rateBuckets = new Map();
function rateLimited(ip, key, max, windowMs) {
  const now = Date.now();
  const full = key + '|' + ip;
  let b = rateBuckets.get(full);
  if (!b || now - b.ts > windowMs) { b = { ts: now, count: 0 }; rateBuckets.set(full, b); }
  b.count++;
  return b.count > max;
}
// 定期清理过期限流桶，避免内存泄漏（审计 P0 内存项）
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now - b.ts > 600000) rateBuckets.delete(k);
}, 300000).unref();

// 全局研究任务并发护栏：避免同时发起过多 LLM/搜索任务拖垮服务或失控扣费
let activeDiscovers = 0;
const MAX_DISCOVERS = 3;
// 并发护栏闭包门：activeDiscovers 是 server.js 的 let 标量，handler 无法直接读写，
// 经此闭包保持计数在 server 进程内唯一（enter 失败=满负荷 429，leave 在异步管线结束释放）。
// 提为模块级：discoverLaunch 在请求上下文之外（setImmediate）也能释放闸门。
const discoverGate = {
  enter: () => { if (activeDiscovers >= MAX_DISCOVERS) return false; activeDiscovers++; return true; },
  leave: () => { activeDiscovers = Math.max(0, activeDiscovers - 1); },
};

const PORT0 = parseInt(process.env.PORT || '3300', 10);

// ---- 启动完整性自检（§5-1）：版本/commit/启动时间，供体验报告版本锚定（#310） ----
let _pkgVer = '0.0.0';
try { _pkgVer = (JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) || {}).version || '0.0.0'; } catch (e) {}
const APP_VERSION = process.env.APP_VERSION || _pkgVer;
// 无 git 仓库时回退 'n/a'；部署流水线可用 APP_COMMIT 注入真实 commit。
const APP_COMMIT = process.env.APP_COMMIT || 'n/a';
const STARTED_AT = new Date().toISOString();
function buildVersionInfo() {
  return {
    name: '知彼 Vantage',
    version: APP_VERSION,
    commit: APP_COMMIT,
    startedAt: STARTED_AT,
    pid: process.pid,
    node: process.version
  };
}
// #310 体验报告版本锚定：在报告末尾附一行生成元数据（版本/commit/启动时间），便于追溯「这份报告是哪版知彼产出的」
function reportProvenance(version, commit, startedAt) {
  return `\n\n---\n> 本报告由 知彼 Vantage v${version}（commit ${commit}）生成 · 服务启动于 ${startedAt}`;
}

function ensureData() { if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true }); }
// ---------- 配置密钥加密（P0-4.1） ----------
// 落盘时抽取的密钥字段（非空白才抽）；加载时解密回填到内存态，内存中始终为明文可用。
const SECRET_PATHS = [
  ['search', 'serperKey'], ['search', 'serperKeys'], ['search', 'apiKey'],
  ['search', 'tavilyKey'], ['search', 'braveKey'], ['search', 'bochaKey'],
  ['llm', 'apiKey']
];
function extractSecrets(cfg) {
  const sec = { search: {}, llm: {} };
  let any = false;
  for (const [s, key] of SECRET_PATHS) {
    if (cfg[s] && cfg[s][key] !== undefined && cfg[s][key] !== '') { sec[s][key] = cfg[s][key]; any = true; }
  }
  return any ? sec : null;
}
function applySecrets(cfg, sec) {
  if (!sec) return;
  for (const [s, key] of SECRET_PATHS) {
    if (sec[s] && sec[s][key] !== undefined) { cfg[s] = cfg[s] || {}; cfg[s][key] = sec[s][key]; }
  }
}
function loadConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return null; }
  if (raw && raw.secrets) {
    try { applySecrets(raw, secret.decrypt(raw.secrets)); delete raw.secrets; }
    catch (e) { console.error('[config] 密钥解密失败（主密钥不符或未设置 MT_MASTER_KEY）：' + e.message); }
  }
  return raw;
}
async function saveConfig(next) {
  const out = JSON.parse(JSON.stringify(next));
  const sec = extractSecrets(out);
  let encrypted = false;
  if (sec) {
    const bundle = secret.encrypt(sec);
    if (bundle) {
      out.secrets = bundle;
      encrypted = true;
      for (const [s, key] of SECRET_PATHS) { if (out[s]) delete out[s][key]; } // 从明文层移除密钥
    }
  }
  if (!encrypted) {
    console.error('[config] 警告：MT_MASTER_KEY 未设置，密钥将以明文写入 config.json！请设置 64 位 hex 主密钥后重启以启用加密。');
  }
  out._secretsEncrypted = encrypted;
  await safeWrite(CONFIG_PATH, out, true);
  return out;
}
// 启动迁移：若已设置主密钥且 config 仍为明文密钥，则一次性加密落盘（幂等）。
function migrateConfigSecrets() {
  if (!secret.getMasterKey()) return;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return; }
  if (!raw || raw.secrets) return;
  const sec = extractSecrets(raw);
  if (!sec) return;
  const bundle = secret.encrypt(sec);
  if (!bundle) return;
  const out = JSON.parse(JSON.stringify(raw));
  out.secrets = bundle;
  for (const [s, key] of SECRET_PATHS) { if (out[s]) delete out[s][key]; }
  out._secretsEncrypted = true;
  safeWrite(CONFIG_PATH, out, true);
  console.log('[config] 已将明文密钥迁移为加密存储（MT_MASTER_KEY 已启用）。');
}
// ---------- 多调研档案存储：换赛道自动归档，不再覆盖 ----------
// 研究链路多租户隔离（P0-2.1）：每个租户的研究档案独立命名空间 data/research/<tenantId>/。
// 文件名净化避免租户 id 注入路径（如 ../）；tenantId 解析顺序：显式传入 > 请求上下文(ALS) > _legacy。
function sanitizeNs(x) { return String(x || '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || '_legacy'; }
function tenantDir(tenantId) { return path.join(DATA, 'research', sanitizeNs(tenantId || '_legacy')); }
function resolveTenantId(explicit) {
  if (explicit) return sanitizeNs(explicit);
  const fromCtx = requestScope.getStore(); // 请求内由 createServer 注入
  if (fromCtx) return sanitizeNs(fromCtx);
  return '_legacy';
}
// 用户纠错报告（P1-7）：随研究档案一起按租户命名空间隔离，杜绝跨租户泄露。
function reportsFile(tenantId) { return path.join(tenantDir(resolveTenantId(tenantId)), 'reports.json'); }
function ensureProj(tenantId) {
  const d = tenantDir(tenantId || resolveTenantId());
  ensureData();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function projFile(id, tenantId) {
  const d = tenantDir(tenantId || resolveTenantId());
  return path.join(d, String(id).replace(/[^a-z0-9\u4e00-\u9fff-]/gi, '') + '.json');
}
function newProjectId(track) {
  const base = String(track || 'project').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
  return base + '-' + Date.now().toString(36);
}
function getCurrentPath(tenantId) { return path.join(tenantDir(tenantId), 'current.json'); }
function getCurrentId(tenantId) {
  const tid = resolveTenantId(tenantId);
  try { return JSON.parse(fs.readFileSync(getCurrentPath(tid), 'utf8')).id || null; } catch { return null; }
}
// 当前指针写入：非致命。外部进程瞬时占锁时绝不 500——转后台异步重试，锁释放后自动落盘。
function setCurrentId(id, tenantId) {
  const tid = resolveTenantId(tenantId);
  ensureProj(tid);
  bestEffortWrite(getCurrentPath(tid), { id: id || null }, true);
  // T3-1：切换/创建档案时把文件态项目镜像进 db。
  // 用 RAW tenantId（requestScope）对齐 db.listProjects 的过滤键（db 用原始 tenantId，文件命名空间用 sanitizeNs 后的）；
  // 文件已存在时读 track，新建档案文件尚未落盘则交给创建点的镜像补齐。
  if (id) {
    const rawTid = requestScope.getStore() || tid;
    try {
      const _s = JSON.parse(fs.readFileSync(projFile(id, tid), 'utf8'));
      mirrorProjectToDb(id, rawTid, _s.track);
    } catch { /* 文件尚无（saveState 之前）：忽略，创建点会镜像 */ }
  }
}
// 首个真实租户 id（用于把升级前的扁平档案归属到正确租户）。无租户则落 _legacy。
// Phase 2：存储换底后经 db 接口读取（不再直接读 multitenant.json 文件）。
function primaryTenantId() {
  try {
    const tenants = db.listAllTenants();
    const t = tenants && tenants[0];
    return t && t.id ? t.id : null;
  } catch { return null; }
}
// 启动迁移（P0-2.1）：把升级前扁平的 data/projects/* 与 data/current.json 迁入首个真实租户的
// 命名空间 data/research/<tenantId>/，保证既有研究数据不丢且归属正确。幂等：用 .migrated 标记防重复。
function migrateResearchNamespaces() {
  const target = primaryTenantId() || '_legacy';
  const dest = tenantDir(target);
  const marker = path.join(dest, '.migrated');
  if (fs.existsSync(marker)) return; // 已迁移完成
  ensureData();
  let moved = false;
  // 极旧单档案 state.json（比 projects 更老的格式）
  if (fs.existsSync(STATE_PATH)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      if (s && s.track) {
        ensureProj(target);
        s.tenantId = target;
        s.projectId = s.projectId || newProjectId(s.track);
        safeWrite(projFile(s.projectId, target), s, true);
        safeWrite(getCurrentPath(target), { id: s.projectId }, true);
        moved = true;
      }
      fs.renameSync(STATE_PATH, STATE_PATH + '.migrated');
    } catch {}
  }
  // 扁平 projects 目录
  if (fs.existsSync(PROJ_DIR)) {
    ensureProj(target);
    for (const f of fs.readdirSync(PROJ_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const src = path.join(PROJ_DIR, f);
        const dst = path.join(dest, f);
        if (!fs.existsSync(dst)) { fs.renameSync(src, dst); moved = true; }
      } catch {}
    }
    if (fs.existsSync(CURRENT_PATH)) {
      try { fs.renameSync(CURRENT_PATH, path.join(dest, 'current.json')); moved = true; } catch {}
    }
  }
  if (moved) {
    fs.writeFileSync(marker, new Date().toISOString());
    console.log('[migrate] 已将旧版单租户研究档案迁入命名空间: ' + target);
  }
}
// 向后兼容：旧调用点保留 migrateLegacy 名（幂等，标记防重复）
function migrateLegacy() { migrateResearchNamespaces(); }
function loadState(tenantId) {
  migrateLegacy();
  const tid = resolveTenantId(tenantId);
  const id = getCurrentId(tid);
  if (!id) return null;
  try { return JSON.parse(fs.readFileSync(projFile(id, tid), 'utf8')); } catch { return null; }
}
// 并发 RMW 合并（P1-1.2）：以磁盘最新为基底，本态覆盖其标量字段；competitors 按 id 合并
// （并集，本态同 id 胜出），避免后台队列新增的竞品被请求态覆盖丢失（last-writer-wins 丢更新）。
function mergeState(cur, s) {
  if (!cur) return s;
  if (!s || !s.projectId) return cur;
  const merged = Object.assign({}, cur);
  for (const k of Object.keys(s)) {
    if (k === 'competitors') continue;
    if (s[k] !== undefined) merged[k] = s[k];
  }
  const byId = new Map();
  (cur.competitors || []).forEach(c => { if (c && c.id) byId.set(c.id, c); });
  (s.competitors || []).forEach(c => { if (c && c.id) byId.set(c.id, Object.assign({}, byId.get(c.id) || {}, c)); });
  merged.competitors = [...byId.values()];
  return merged;
}
// 注意：saveState 只写档案文件，不改当前指针（后台深研写入归档中的旧档案时不会抢占前台）。
// tenantId 解析：优先用 state.tenantId（创建时写入，后台队列脱离请求上下文也带得上），否则回退 ALS/_legacy。
// ---------- SSE 变化推送（F12：轮询 → 变化检测推送） ----------
// 所有状态变更都经 saveState 落盘；在此统一广播，前端免轮询。
const sseClients = new Set();
// ▶ 加固（0812 体验报告）：缓存最近发现事件，SSE 新连客户端回放，消除 discover_error 被错过竞态
const DISCOVER_REPLAY_MAX = 50;
const discoverReplay = new Map();   // projectId -> [{ type, payload }, ...]
let lastDiscoverProjectId = null;
function broadcastChange() {
  if (!sseClients.size) return;
  const payload = 'data: ' + JSON.stringify({ type: 'change', ts: Date.now() }) + '\n\n';
  sseClients.forEach(c => { try { c.write(payload); } catch { sseClients.delete(c); } });
}
// 渐进式发现：携带业务 type 的 typed 事件，供前端按事件分发（复用 sseClients）。
function emitSSE(type, payload) {
  // 记录发现类事件供回放（无论是否有在线客户端都要记）
  if (type === 'discover_stage' || type === 'brand_found' || type === 'brand_removed'
      || type === 'discover_complete' || type === 'discover_error') {
    const pid = (payload && payload.projectId) || lastDiscoverProjectId;
    if (pid) {
      let buf = discoverReplay.get(pid); if (!buf) { buf = []; discoverReplay.set(pid, buf); }
      buf.push({ type, payload });
      if (buf.length > DISCOVER_REPLAY_MAX) buf.shift();
      lastDiscoverProjectId = pid;
    }
  }
  if (!sseClients.size) return;
  const data = 'data: ' + JSON.stringify(Object.assign({ type }, payload || {})) + '\n\n';
  sseClients.forEach(c => { try { c.write(data); } catch { sseClients.delete(c); } });
}

function saveState(s) {
  if (!s.projectId) { s.projectId = newProjectId(s.track); if (!getCurrentId(s.tenantId)) setCurrentId(s.projectId, s.tenantId); }
  const tid = resolveTenantId(s.tenantId);
  const fp = projFile(s.projectId, tid);
  try {
    mutateFile(fp, (cur) => mergeState(cur, s), true);
  } catch (e) {
    // 极端持久锁：退化为原非致命写（不抛，避免 500）；锁释放后下次写入自愈
    bestEffortWrite(fp, s, true);
  }
  broadcastChange(); // ▶ F12：落盘即推送，前端据此做变化检测（仅变更时重渲染）
}
function listProjects(tenantId) {
  migrateLegacy();
  const tid = resolveTenantId(tenantId);
  const dir = tenantDir(tid);
  if (!fs.existsSync(dir)) return [];
  const cur = getCurrentId(tid);
  const out = [];
  fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'current.json').forEach(f => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // 内容裁决：只认「项目档案」（对象且含 competitors 数组或有 projectId）。
      // 同目录的 user-notes / field-corrections / reports 等数据文件（按 user 键的对象或数组）
      // 不是调研档案，不得混入历史调研清单。
      if (!s || typeof s !== 'object' || Array.isArray(s) || (!Array.isArray(s.competitors) && !s.projectId)) return;
      const comps = s.competitors || [];
      out.push({
        id: s.projectId || f.replace(/\.json$/, ''),
        track: s.track || '(未命名)',
        discoveredAt: s.discoveredAt || null,
        total: comps.length,
        done: comps.filter(c => c.status === 'done').length,
        hasBrief: !!s.brief,
        current: (s.projectId || f.replace(/\.json$/, '')) === cur
      });
    } catch {}
  });
  out.sort((a, b) => String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')));
  return out;
}

// T3-1：文件态研究档案 → db 项目清单镜像（最小融合，不搬研究数据进 db）。
// 让 /api/projects（db）与 /api/state（文件）在「项目清单」层汇合：旧端点创建/切换的档案
// 也以「同 projectId + tenantId」落 db，前端按 tenantId+id 桥接回文件态详情。
// 幂等：同 (tenantId,projectId) 仅首次写 db；重启后 Set 清空会再 upsert（无害）。
// 非致命：db 镜像失败绝不影响研究主链路。
const _mirroredProjects = new Set();
function mirrorProjectToDb(projectId, tenantId, track) {
  if (!projectId || !tenantId) return;
  const key = tenantId + '::' + projectId;
  if (_mirroredProjects.has(key)) return;
  try {
    const existing = db.getProject(tenantId, projectId);
    if (existing) {
      // 已存在：仅补 track（若缺失），保留原 createdAt/discoveredAt，不覆盖研究字段
      if (!existing.track && track) { existing.track = track; db.saveProject(existing); }
      _mirroredProjects.add(key);
      return;
    }
    db.saveProject({
      id: projectId, tenantId,
      track: track || 'project',
      competitors: [], brief: null, whiteSpace: null,
      createdAt: new Date().toISOString(),
      discoveredAt: new Date().toISOString()
    });
    _mirroredProjects.add(key);
  } catch (e) { /* 非致命：db 镜像失败不影响研究主链路 */ }
}
// 返回当前搜索源的 key（按 provider 选择），无则 null
function activeSearchKey(config) {
  if (!config || !config.search) return null;
  const p = config.search.provider || 'tavily';
  if (p === 'serper') return normalizeSerperKeys(config.search)[0] || null;
  if (p === 'brave') return config.search.braveKey || null;
  if (p === 'bocha') return config.search.bochaKey || null;
  return config.search.tavilyKey || config.search.apiKey || null;
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
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
      } catch (e) { reject(e); }
    });
  });
}

// ---------- 外部 API ----------
// 搜索源实现（tavilySearch / serperSearch / normalizeSerperKeys / classifySerperError /
// serperSearchWithFailover / getSerperPool / braveSearch / bochaSearch / glFromRegions）
// 已抽至 services/providers/search.js（Phase 1 · L-外部依赖层），此处经顶部解构引用。
const FETCH_OPTS = { headers: { 'User-Agent': 'Mozilla/5.0' } };
// 区域 -> Google 地理码（北美默认 us）经 providers 解构（glFromRegions）
// T1-1：取当前租户标识 —— 请求内走 ALS(requestScope)，后台 detached 队列回退 state.tenantId，均无则 '_legacy'。
// ⚠️ 必须用 RAW tid（如 'tenant:8cf0aebaebd1'），不能 sanitizeNs：metering/db 的租户键是原始 id（带冒号），
// 一旦 sanitize（冒号→下划线）会导致配额检查与计费落到幽灵键（tenant_8cf...），使计量彻底失效。文件目录才用 sanitizeNs。
function curTenantId() {
  const fromCtx = requestScope.getStore();
  if (fromCtx) return fromCtx;
  if (typeof state !== 'undefined' && state && state.tenantId) return state.tenantId;
  return '_legacy';
}

// 搜索适配层：根据 config.search.provider 选择搜索源，统一返回 {results:[{title,url,content}]}
// T1-1：每次外部搜索都经 metering 闸门并计费。searchProvider 委托给各 provider（tavily/serper/brave/bocha），
// provider 内部不直接暴露统一 status，故在此层统一计费（一次搜索只计一次，含 serper 多 key failover）；
// 失败时从抛错 message 解析状态码（TAVILY_500/SERPER_403/...），按 shouldBill 决定是否计费
// （5xx 计、4xx/网络失败/无 key 不计），与 metering.js 计费裁决口径一致。
// kind: 'serp-discover'(24h) | 'serp-probe'(7d，默认) | 'off'(禁用缓存)
// 模块 0-3：命中缓存直接返回（不 recordCall —— 天然免配额）；缓存键含地域 gl 防美/英串数据
// 模块 2-2：跨 provider 健康度路由 —— 主 provider（config 指定）失败时按序尝试有 key 的备用源；
//           serper 内部多 key failover（serperSearchWithFailover）原样保留，本层在其外层叠加。
const PROVIDER_ORDER = ['serper', 'brave', 'bocha', 'tavily'];
const PROVIDER_ALIAS = { serper: 'serper', google: 'serper', brave: 'brave', bocha: 'bocha', tavily: 'tavily' };
function providerMain(config) {
  const p = String(((config && config.search && config.search.provider) || 'tavily')).toLowerCase();
  return PROVIDER_ALIAS[p] || 'tavily';
}
function providerConfigured(config, name) {
  const sc = (config && config.search) || {};
  if (name === 'serper') return normalizeSerperKeys(sc).length > 0;
  if (name === 'brave') return !!sc.braveKey;
  if (name === 'bocha') return !!sc.bochaKey;
  if (name === 'tavily') return !!(sc.tavilyKey || sc.apiKey);
  return false;
}
async function providerCall(name, query, config, gl) {
  if (name === 'serper') {
    const { keys, disabled } = getSerperPool(config);
    if (!keys.length) throw new Error('NO_SERPER_KEY');
    return serperSearchWithFailover(query, keys, gl, { disabled });
  }
  if (name === 'brave') {
    const k = config.search.braveKey;
    if (!k) throw new Error('NO_BRAVE_KEY');
    return braveSearch(query, k, gl);
  }
  if (name === 'bocha') {
    const k = config.search.bochaKey;
    if (!k) throw new Error('NO_BOCHA_KEY');
    return bochaSearch(query, k);
  }
  const k = config.search.tavilyKey || config.search.apiKey;
  if (!k) throw new Error('NO_TAVILY_KEY');
  return tavilySearch(query, k);
}
async function searchProvider(query, config, gl, kind) {
  const ckind = kind || 'serp-probe';
  const cacheKey = gl ? (query + ' [gl:' + gl + ']') : query;
  if (ckind !== 'off') {
    const hit = Cache.get(ckind, cacheKey);
    if (hit) return hit;
  }
  const tid = curTenantId();
  if (!metering.withinQuota(tid, 'searchCalls')) {
    return { results: [], error: 'quota', note: 'SEARCH_QUOTA' };
  }
  // 候选顺序：主 provider 在前，其余按健康度（不健康者垫底）
  const main = providerMain(config);
  const rest = PROVIDER_ORDER.filter(p => p !== main)
    .sort((a, b) => (ProviderHealth.isHealthy(b) ? 1 : 0) - (ProviderHealth.isHealthy(a) ? 1 : 0));
  const candidates = [main, ...rest].filter(p => providerConfigured(config, p));
  let lastErr = null;
  const _s0 = Date.now();
  for (const name of candidates) {
    try {
      const result = await providerCall(name, query, config, gl);
      ProviderHealth.recordOk(name);
      // 可观测性：记录搜索耗时（供 discover 耗时排查）
      try { Logger.info('search-call', { provider: name, kind: ckind, status: 'ok', durationMs: Date.now() - _s0, q: String(query).slice(0, 60) }); } catch (e) {}
      // 成功路径：写缓存（后续同 query 命中免配额）+ 本次搜索到达供应商即计费 1
      if (ckind !== 'off') Cache.set(ckind, cacheKey, result);
      metering.recordCall(tid, 'searchCalls', 1);
      return result;
    } catch (e) {
      lastErr = e;
      ProviderHealth.recordFail(name, e);
      try { Logger.info('search-call', { provider: name, kind: ckind, status: 'fail', durationMs: Date.now() - _s0, err: String(e.message || '').slice(0, 80), q: String(query).slice(0, 60) }); } catch (e2) {}
      // 无 key（配置缺失）与真实失败都继续尝试下一候选
    }
  }
  // 全失败：按原计费口径（5xx 计、网络失败/无 key 不计）并抛最后错误
  const msg = (lastErr && lastErr.message) || '';
  const m = /_(\d{3})$/.exec(msg);
  const status = m ? Number(m[1]) : null;
  const billed = status != null ? metering.shouldBill(status) : false;
  metering.recordCall(tid, 'searchCalls', billed ? 1 : 0);
  throw lastErr;
}

// ---- 定向探测健康度（失败可见性，§5-2）：不再静默吞掉探测失败 ----
// 跨进程生命周期累计近 7 天探测失败率，超过 30% 直接告警，便于区分
// "代码没修" 与 "搜索 API 配额/连通性出问题"。
const probeHealth = { runs: [] };
function recordProbeHealth(failed, total) {
  if (!total) return;
  const ts = Date.now();
  probeHealth.runs.push({ ts, failed, total });
  const cutoff = ts - 7 * 24 * 3600 * 1000;
  probeHealth.runs = probeHealth.runs.filter(r => r.ts >= cutoff);
  const tot = probeHealth.runs.reduce((a, r) => a + r.total, 0);
  const fail = probeHealth.runs.reduce((a, r) => a + r.failed, 0);
  const rate = tot ? fail / tot : 0;
  if (rate > 0.30) {
    console.warn(`[探针健康告警] 近7天定向探测失败率 ${(rate * 100).toFixed(1)}% (${fail}/${tot})，超过 30% 阈值 —— 请检查搜索 API 配额/连通性`);
  }
  return { failed, total, rate };
}

// ============ 数据自动化 0-1/0-2：LLM 调用统一走网关 ============
// 模型名迁移：deepseek-chat → deepseek-v4-flash（官方 2026-07-24 弃用旧名，兼容期随时结束）。
// 网关能力：45s 超时 / 重试×2 指数退避 / 连续 5 失败熔断 30s / 字段级降级（单次 5xx 不再整家作废）。
// 计量：enrichRuns 照旧（5xx 也计，网络失败不计）；成本归因经网关自动写 cost_telemetry（1-1）。
const LEGACY_LLM_MODELS = new Set(['deepseek-chat', 'deepseek-reasoner']);
const _warnedLegacyModel = new Set();
function _warnLegacyModel(model) {
  if (LEGACY_LLM_MODELS.has(model) && !_warnedLegacyModel.has(model)) {
    _warnedLegacyModel.add(model);
    try { Logger.warn('llm.model 使用已弃用模型名 ' + model + '，建议迁移至 deepseek-v4-flash'); } catch { /* 日志不可用 */ }
  }
}
// opts: { projectId, competitorId, fieldKey } —— 三级归因地基（1-1）；tenantId 由 curTenantId() 兜底
async function deepseekJSON(messages, key, model, opts) {
  const m = model || 'deepseek-v4-flash';
  _warnLegacyModel(m);
  return LLMGateway.call(messages, {
    apiKey: key, model: m, json: true, temperature: 0.2,
    tenantId: curTenantId(), ...(opts || {}),
  });
}

// 纯文本接口（用于叙事型简报，避免 DeepSeek json_object 必须含 'json' 字样的限制）
async function deepseekText(messages, key, model, opts) {
  const m = model || 'deepseek-v4-flash';
  _warnLegacyModel(m);
  return LLMGateway.call(messages, {
    apiKey: key, model: m, json: false, temperature: 0.4,
    tenantId: curTenantId(), ...(opts || {}),
  });
}

// ============================================================
// L3 证据获取层：snippet 不可信 —— 一级证据必须抓正文/结构化数据
// ============================================================
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&quot;|&#\d+;|&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// 抓页面正文（超时保护 + 大小限制），失败返回 {ok:false}
// 模块 0-3：fetch-page 72h 缓存（同官网反复重抓免网络开销）
async function fetchPage(url, timeoutMs) {
  const hit = Cache.get('fetch-page', url);
  if (hit) return hit;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.8' }, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) return { ok: false, status: r.status };
    const html = await r.text();
    const out = { ok: true, url: r.url || url, text: stripHtml(html).slice(0, 9000), htmlLower: html.toLowerCase().slice(0, 200000) };
    Cache.set('fetch-page', url, out);
    return out;
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  finally { clearTimeout(timer); }
}
// Shopify 站结构化价格：/products.json 公开端点，零 LLM，verified 级
async function fetchShopifyProducts(siteUrl) {
  const d = domainOf(siteUrl);
  if (!d) return { ok: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`https://${d}/products.json?limit=100`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: ctrl.signal });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    const products = Array.isArray(j.products) ? j.products : [];
    if (!products.length) return { ok: false, empty: true };
    const items = products.slice(0, 60).map(p => {
      const prices = (p.variants || []).map(v => parseFloat(v.price)).filter(n => !isNaN(n) && n > 0);
      return { title: p.title, type: p.product_type || '', minPrice: prices.length ? Math.min(...prices) : null, maxPrice: prices.length ? Math.max(...prices) : null };
    }).filter(x => x.minPrice != null);
    return { ok: items.length > 0, items, url: `https://${d}/products.json` };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  finally { clearTimeout(timer); }
}

// ============================================================
// L5 采信裁决层：来源分级写死在代码里，置信度由证据类型推导，不由 LLM 拍脑袋
// ============================================================
// 一级=平台店铺页/官方账号/官网正文；二级=社区口碑/媒体；三级=SEO聚合站（不入库）
const TIER1_PATTERNS = [/etsy\.com\/shop\//i, /amazon\.[a-z.]+\/stores?\//i, /tiktok\.com\/@/i, /instagram\.com\/[^/]+\/?$/i, /youtube\.com\/(@|channel\/)/i, /facebook\.com\/[^/]+\/?$/i];
const TIER2_DOMAINS = ['reddit.com', 'trustpilot.com', 'sitejabber.com', 'bbb.org', 'forbes.com', 'businessinsider.com', 'techcrunch.com', 'nytimes.com', 'wired.com', 'theverge.com', 'cnn.com', 'npr.org', 'retaildive.com', 'modernretail.co', 'glossy.co'];
const TIER3_PATTERNS = [/pinterest\./i, /top10/i, /best-?products/i, /rank(er|ings)/i, /coupon/i, /promo-?codes/i, /10best/i, /buyersguide/i, /\.blogspot\./i, /listicle/i];
function sourceTier(url, officialDomain) {
  const d = domainOf(url);
  if (!d) return 3;
  if (officialDomain && (d === officialDomain || d.endsWith('.' + officialDomain))) return 1;
  if (TIER1_PATTERNS.some(p => p.test(url))) return 1;
  if (TIER3_PATTERNS.some(p => p.test(url))) return 3;
  if (TIER2_DOMAINS.some(t => d === t || d.endsWith('.' + t))) return 2;
  return 2; // 未知域名默认二级（媒体/博客），靠交叉验证升降
}
// 由引用的证据推导 basis+confidence：一级→verified/high；≥2独立二级域→inferred/medium；单二级→inferred/low；无→unverified/low
function deriveBasis(cited) {
  if (!cited || !cited.length) return { basis: 'unverified', confidence: 'low' };
  const t1 = cited.filter(s => s.tier === 1);
  if (t1.length) return { basis: 'verified', confidence: 'high' };
  const t2domains = new Set(cited.filter(s => s.tier === 2).map(s => domainOf(s.url)));
  if (t2domains.size >= 2) return { basis: 'inferred', confidence: 'medium' };
  if (t2domains.size === 1) return { basis: 'inferred', confidence: 'low' };
  return { basis: 'unverified', confidence: 'low' };
}
// L4 归属裁决：一条结果属于该品牌 ⇔ 域名匹配锚点 或 文本含品牌名
function belongsToBrand(item, brandName, anchorDomain) {
  const url = item.url || '';
  if (anchorDomain && domainOf(url) === anchorDomain) return true;
  const name = (brandName || '').toLowerCase().trim();
  if (!name) return false;
  const hay = ((item.title || '') + ' ' + (item.content || '') + ' ' + url).toLowerCase();
  return hay.includes(name);
}

// ---------- 维度词表（与前端推理共用） ----------
const CHANNELS = ['tiktokShop', 'amazon', 'shopifyDTC', 'xiaohongshu', 'instagramShop', 'etsy', 'offlineRetail', 'tmallJD'];
// 需"具体店铺/账号证据"的平台型渠道：深研时做品牌×渠道定向探测，避免泛搜索漏判为缺席
const DIRECT_PROBE = { tiktokShop: 'TikTok Shop', etsy: 'Etsy', amazon: 'Amazon' };
// 目标人群：全赛道自由文本（不再写死潮玩人群词表）；AI 按赛道抽取，渲染层兜底展示
const AUDIENCES = [];
const REGIONS = ['us', 'uk', 'eu', 'cn', 'jp', 'sea'];
// 平台分组：供前端"调研平台"多选 + 后端按平台集收缩研究/显示范围
const OVERSEAS_PLATFORMS = ['amazon', 'shopifyDTC', 'tiktokShop', 'instagramShop', 'etsy'];
const CN_PLATFORMS = ['tmallJD', 'xiaohongshu'];
const GLOBAL_PLATFORMS = ['offlineRetail'];
// 由地域推导默认平台集：PRD 目标=海外 Shopify → 无地域或含任一海外地域⇒海外平台；含 cn⇒加国内平台。
function platformsFromRegions(regions) {
  const set = new Set(GLOBAL_PLATFORMS);
  const hasOverseas = (regions || []).some(r => ['us', 'uk', 'eu', 'jp', 'sea'].includes(r));
  if (!regions || !regions.length || hasOverseas) OVERSEAS_PLATFORMS.forEach(p => set.add(p));
  if ((regions || []).includes('cn')) CN_PLATFORMS.forEach(p => set.add(p));
  return Array.from(set).filter(p => CHANNELS.includes(p));
}
// 解析平台集：显式勾选优先；否则由地域推导。保证只含合法渠道键。
function resolvePlatforms(intentLike) {
  const i = intentLike || {};
  if (Array.isArray(i.platforms) && i.platforms.length) return i.platforms.filter(p => CHANNELS.includes(p));
  return platformsFromRegions(i.regions);
}
// 种草声量中文标签（content/hybrid 渠道展示用）
function seedingLabel(v) { return ({ high: '高', medium: '中', low: '低', none: '无' })[v] || (v || '未知'); }
const PRICE_BANDS = ['mass', 'mid', 'premium', 'ultra'];
// 细粒度维度（空白推理用，解决"一搜就都在做"的粗粒度问题）
const CONTENT_FORMS = ['shortVideo', 'livestream', 'ugc', 'tutorial', 'unboxing', 'meme'];
const COLLAB_TYPES = ['ipCollab', 'artistCollab', 'brandCollab', 'celebrity'];
const FULFILLMENT = ['dropship', 'madeToOrder', 'printOnDemand', 'localWarehouse', 'selfFactory'];
// 受控词表：卖点 / 销售策略（LLM 只能多选，不许自由文本 —— 否则矩阵对不齐）
const Rel = require('./lib/relationship.js');
const { computeOpportunityMap } = require('./lib/opportunity.js');
const { computeWhiteSpaceGrid } = require('./lib/whitespace-grid.js');
const { autoExcludeOwnBrands } = require('./lib/own-brand.js'); // ▶ 数据卫生②：自列竞品排除
const { computeBlueOceanCurve, channelTypeOf, computeSeedingPercentiles } = require('./lib/blue-ocean.js');
const Guard = require('./lib/inference-guard.js'); // 推理纪律 v2：供需不混淆（三道闸）
const TR = require('./lib/trend.js'); // 优化三：时间趋势维度（Tier B）+ 趋势检验点、趋势检验点（buildTrendInferences）
const { computeTrendView, GROWTH_VALUES } = TR;
const VC = require('./lib/voice-collector.js');   // 第一部分：社媒/用户评论采集统一接口
const Tier = require('./lib/tiering.js');          // 第二部分算子①：分层器
const Sizing = require('./lib/sizing.js');        // 第二部分算子②：体量估算器
const Agg = require('./lib/aggregator.js');        // 第二部分算子③：聚合器 + Sector 模型
const SW = require('./lib/sector-whitespace.js');  // 第二部分算子⑥：赛道级空白
const TL = require('./lib/timeline.js');           // 第二部分算子④：时间线器
const { gapConfidence } = require('./lib/confidence.js'); // ▶ 空白视图整改·架构#1+规范A：群体空白统一置信收敛（纯函数，可单测）
const HeroProduct = require('./lib/hero-product.js');   // S1-① 主推产品推理器（两信号：verified=准 / inferred=推，禁空）
const Radar = require('./lib/radar.js');                // S1-② 雷达变化检测 + 群体异动
const UN = require('./lib/user-notes.js');              // S3-④ 用户私有记录（按 user×competitor 隔离，永不全局）
const correctionOverlay = require('./lib/correction-overlay.js'); // T2-1 字段纠错私有覆盖层（按 user×competitor 隔离，永不全局/不写 comp.*）
const QD = require('./lib/quadrant.js');                // S3-⑤ 竞争强度×机会大小 象限（派生，不落盘）
const DomainReg = require('./lib/domain-registry.js');  // Phase A：域注册表（承重声明，enabled 开关）
const DomainRunner = require('./lib/domain-runner.js'); // Phase A：域调度器（按注册表遍历产出 verdict 快照）
const MatEngine = require('./lib/material-engine.js');  // Phase B：L3 材料引擎（跟价材料配方，仅消费 enabled 域 verdict）
const { SELLING_POINTS, SP_LABEL, TACTICS, CURRENCY_BY_REGION, CURRENCY_SYMBOL, marketCurrency, SP_MAX, SP_CUSTOM_MAX, normalizeProfile, normalizeIntent, priceRangeOf, computeRelationship, curSym, fmtMoney, CURRENCY_PATTERNS, detectCurrency, LADDER_THRESHOLDS, priceLadder } = Rel;
function decorateState(s) {
  if (!s || !Array.isArray(s.competitors)) return s;
  // 平台集：每次读态实时重算，保证与 intent.regions/platforms 一致（单一可信源）
  s.intent = s.intent || {};
  s.intent.platforms = resolvePlatforms(s.intent);
  const profile = s.intent && s.intent.profile;
  for (const c of s.competitors) {
    c.relationship = computeRelationship(c, profile);
    // P1-7 · A1+A3-L1：字段对象上卷四态 + 独立来源数（可见），并施加来源可信门禁（L1）。
    // 门禁仅附加 credible / gateReason 标注（数据层可见，前端暂未消费），不改写 basis/confidence。
    const enrich = (f, kind) => {
      const e = FC.enrichFieldProvenance(f, kind);
      const g = FC.provenanceGate(e);
      e.credible = g.credible;
      e.gateReason = g.reason;
      e.gateLevel = g.level;
      return e;
    };
    c.priceField = enrich(getPriceField(c, (s.fieldCorrections) || []), 'price');
    c.channelFields = {};
    // 只算选中平台的渠道字段（忠实助理：不展示用户不关心的平台）
    const chPlat = (s.intent && s.intent.platforms);
    const chKeys = (chPlat && chPlat.length) ? chPlat : CHANNELS;
    chKeys.forEach(k => { c.channelFields[k] = enrich(getChannelField(c, (s.fieldCorrections) || [], k), 'set'); });
    c.categoryFields = {};
    CATEGORIES.forEach(k => { c.categoryFields[k] = enrich(getCategoryField(c, (s.fieldCorrections) || [], k), 'set'); });
    c.launchCadence = enrich(getLaunchCadence(c, (s.fieldCorrections) || []), 'scalar');
    c.reviewField = enrich(getReviewField(c, (s.fieldCorrections) || []), 'review');
    c.pendingCorrections = (s.fieldCorrections || [])
      .filter(x => x.competitorId === c.id && x.status === 'pending')
      .map(x => ({ id: x.id, field: x.field, type: x.type, value: x.value, text: x.text, source: x.source, at: x.at }));
  }
  s.marketCurrency = marketCurrency(s.intent && s.intent.regions);
  // #305 聚合过滤集：错配/低置信卡不进任何聚合分母（UI 仍可见）
  const _aggEx = aggExcludedSet(s);
  const _aggComps = (s.competitors || []).filter(c => c.status === 'done' && !_aggEx.has(c.id));
  // ▶ PRD整改 §5.3 跨币种元认知闸门：聚合视图顶部 banner 所需（前端只渲染，不前端自检）
  s.crossCurrency = _aggComps
    .filter(c => {
      const cur = c.currency || s.marketCurrency;
      const hasPrice = (c.pricePoints || []).length || (c.priceBand && c.priceBand.range);
      return hasPrice && cur !== s.marketCurrency;
    })
    .map(c => `${c.name}(${c.currency || s.marketCurrency})`);
  // 机会地图（Ulwick ODI 改良）：派生产物，不落盘；与 priceField 同构，每次读态实时重算。
  s.opportunity = computeOpportunityMap(_aggComps, { excluded: s.excluded || [] });
  // 蓝海要素曲线（一维 · 全行业趋同处 vs 无人区）：派生产物，不落盘；与 whitespace-grid 同构。
  s.blueOcean = computeBlueOceanCurve(_aggComps, { minCoverage: 3 });
  // 推理纪律 v2：对派生视图施加供需交叉(闸A)/边界过滤(闸B)/单边降级(闸C) 三道闸（不落盘，实时重算）
  Guard.guardView(s);
  // 优化六：待复核时效仪表盘（顶层暴露，让用户看见队列积压与处理延迟）
  s.correctionDashboard = buildCorrectionDashboard(s.fieldCorrections || []);
  // 优化三：赛道时间趋势视图（fail-safe：多数 unknown → 趋势未知，不臆造）
  s.trendView = computeTrendView(_aggComps);
  // 优化四：种草声量相对百分位（组内排名，透明可核验；绝对值仍 LLM 估计，不臆造计数）
  const seedPct = computeSeedingPercentiles(_aggComps, s.intent && s.intent.platforms);
  s.competitors.forEach(c => {
    const pc = seedPct[c.id] || {};
    Object.keys(c.channelFields || {}).forEach(k => {
      if (pc[k]) {
        c.channelFields[k].seedingPercentile = pc[k].percentile;
        c.channelFields[k].seedingPercentileNote = pc[k].note;
        c.channelFields[k].seedingOrdinal = pc[k].ordinal;
      }
    });
  });
  // S1-① 主推产品推理（两信号：verified=准 / inferred=推，禁空）——挂在每个对手上，情报库/卡片墙引用
  s.competitors.forEach(c => { c.heroProduct = HeroProduct.heroProductInfer(c); });
  // S1-② 雷达变化检测 + 群体异动（群体异动进战略信号条；每对手最近动作挂 recentActions）
  s.radar = Radar.computeRadar(_aggComps, { excluded: s.excluded || [] });
  s.competitors.forEach(c => {
    c.recentActions = (s.radar && s.radar.perCompetitor && s.radar.perCompetitor[c.id]) ||
      { competitorId: c.id, competitorName: c.name, hasAction: false, kind: 'none', action: null, all: [] };
  });
  // Phase A（架构总纲 v3 §3/§4/§8）：域注册表驱动 —— 按 enabled 域遍历产出 verdict 快照。
  // 非破坏：不修改现有字段，仅附加 domainVerdicts（verdict 快照层，L3 材料引擎/Phase B 消费）。
  // 当前 Phase B 仅 price 域 enabled:true（跟价材料）；其余域已注册但不出材料（T4 护栏）。
  s.domainVerdicts = DomainRunner.runEnabledDomains(s, {
    price: (st) => {
      const exSet = aggExcludedSet(st);
      const doneComps = (st.competitors || []).filter(c => c.status === 'done' && !exSet.has(c.id));
      // P0-1：与用户定位锚点做带位比较 → 推算影响面（真实计算，非编造；无锚点则不推）
      const ub = (st.intent && st.intent.profile && st.intent.profile.priceBand) || null;
      const items = doneComps.map(c => {
        const pf = c.priceField || {};
        const band = pf.band || null;
        const cur = pf.currency || 'USD';
        const hasMin = band && band.min != null;
        const hasMax = band && band.max != null;
        const srcs = (pf.sources || []).filter(s => s && (s.url || s.text)).map(s => ({
          label: String((s.text || s.url || '')).slice(0, 48),
          url: s.url || '',
          tier: s.tier || 3,
        }));
        // 推算影响面：价格带与用户锚点带位比较（诚实：无锚点/无带位 → 不推）
        let inferText = null, inferWhy = null;
        if (hasMin && ub && ub.min != null) {
          const lo = band.min, hi = hasMax ? band.max : band.min;
          const uLo = ub.min, uHi = ub.max != null ? ub.max : ub.min;
          if (lo <= uHi && uLo <= hi) {
            inferText = `与你的价格带（${cur} ${uLo}–${uHi}）存在部分重叠，主要竞争区间重叠。`;
          } else if (lo > uHi) {
            inferText = `价格带（${cur} ${lo}${hasMax ? '–' + band.max : ''}）整体高于你的带位，主战场在更高价位细分。`;
          } else {
            inferText = `价格带（${cur} ${lo}${hasMax ? '–' + band.max : ''}）整体低于你的带位，走量打法，需留意价格锚定。`;
          }
          inferWhy = `价格带取自 ${(pf.sources || []).length} 条来源的带位裁决；你的锚点来自定位档案。推算项，供你判断。`;
        }
        return {
          subjectId: 'brand:' + ((c.name || c.id || '').toLowerCase().replace(/[^a-z0-9]/g, '') || c.id),
          brand: { name: c.name || c.id || '', url: c.url || '' },
          claim: pf.display ? `${c.name} 价格区间 ${pf.display}` : `${c.name} 价格未探测`,
          confidence: pf.confidence || 'low',
          basis: pf.basis || 'unverified',
          evidenceIds: srcs.map(s => s.url).filter(Boolean),
          sources: srcs,
          // P0-1：new 取价格带下限（可信值）；old/deltaPct 无历史数据 → 显式 null，不编造涨跌
          price: hasMin ? { new: band.min, currency: cur, range: hasMax ? { min: band.min, max: band.max } : null, old: null, deltaPct: null } : null,
          inference: inferText ? { text: inferText, why: inferWhy } : null,
          missingFields: pf.display ? [] : ['priceRange'],
          scope: pf.priceScope || 'list',
        };
      });
      return {
        subjectCount: items.length,
        items,
        basis: items.length ? (items.every(i => i.basis === 'verified') ? 'verified' : 'inferred') : 'unverified',
        confidence: items.length ? (items.some(i => i.confidence === 'high') ? 'medium' : 'low') : 'low',
      };
    },
  });
  // Phase B：L3 材料引擎 —— 消费 enabled 域 verdict 快照，产出待批材料（工作台 L4 消费）。
  // 当前仅 price 域 enabled → 只产出跟价材料（Phase B 验收：只有价格域材料上线）。
  s.materials = MatEngine.buildMaterials(s).materials;
  return s;
}
const CONF_NUM = { high: 85, medium: 60, low: 30 };
function confNum(c) { return CONF_NUM[c] != null ? CONF_NUM[c] : 40; }
// 忠实助理红线（P0-1）：用户纠错默认进「待复核」队列，不直接写库标 verified/high。
// 只有 confirm-correct（确认现值正确）或经复核 accept 的纠错才被编织进字段可信值。
const DISCLAIMER_TEXT = '此结论基于不足证据，仅供参考，不构成行动建议';
function stableHash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function activeCorrections(corrections) {
  // ▶ PRD v2.1 §0 数据主权：用户对全局库无写入权。已复核通过的纠错(accepted)仅作"复核触发信号"，
  //   不再覆盖展示值（展示值恒由系统采集推导）。仅 confirm-correct（确认系统值无误，非写入）与
  //   遗留 null 状态可参与——confirm-correct 不改变值，属安全强化。
  return (corrections || []).filter(x => (x.type === 'confirm-correct' && x.status !== 'rejected') || x.status == null);
}
// 优化六（2026-08-03，v2.1 修订）：待复核软隔离——pending 纠错在复核通过前不进 activeCorrections（零生效）；
// 提交即对该字段临时降级（值不变、置信降一级、标待复核）以反映"有人质疑"。复核通过后：accepted 不再改写全局，
// 仅标记 reverify（系统随后复采自修），降级随 pending 解除而恢复——展示值始终系统派生的，用户无写入权。
function softQuarantine(obj, pendingCount) {
  if (!obj || !pendingCount) return obj;
  const downBasis = { verified: 'inferred', inferred: 'unverified', unverified: 'unverified' };
  const downConf = { high: 'medium', medium: 'low', low: 'low' };
  if (obj.basis && downBasis[obj.basis]) obj.basis = downBasis[obj.basis];
  if (obj.confidence && downConf[obj.confidence]) obj.confidence = downConf[obj.confidence];
  obj.conflictNote = (obj.conflictNote ? obj.conflictNote + '；' : '') + `用户纠错待复核（已临时降级，复核通过后恢复；${pendingCount} 条待复核）`;
  obj.pendingQuarantine = true;
  return obj;
}
// 优化六：待复核时效仪表盘（顶层暴露，供用户看到队列积压与处理延迟）
function buildCorrectionDashboard(corrections) {
  const list = (corrections || []).filter(x => x.status === 'pending');
  const now = Date.now();
  const ages = list.map(x => { const t = new Date(x.at).getTime(); return isNaN(t) ? 0 : (now - t) / 3600000; });
  const avgAge = ages.length ? Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10 : 0;
  const oldest = list.length ? list.reduce((m, x) => { const t = new Date(x.at).getTime(); return isNaN(t) ? m : Math.min(m, t); }, now) : null;
  return {
    pendingCount: list.length,
    avgAgeHours: avgAge,
    oldestAt: (oldest && oldest !== now) ? new Date(oldest).toISOString() : null,
    items: list.slice(0, 30).map(x => ({ id: x.id, field: x.field, competitorId: x.competitorId, type: x.type, at: x.at }))
  };
}
// 候选/对手整体置信度：由来源证据数 + 字段置信度综合
function scoreConfidence(evidenceCount, fieldConfs) {
  let s = Math.min(evidenceCount, 5) * 8; // 来源交叉验证
  if (fieldConfs && fieldConfs.length) {
    const avg = fieldConfs.reduce((a, b) => a + confNum(b), 0) / fieldConfs.length;
    s = Math.round(s * 0.5 + avg * 0.5);
  }
  return Math.max(25, Math.min(95, s));
}

// ============================================================
// 步骤1：发现引擎（扇出 + 两阶段 + 排名）
// ============================================================
function isCJK(s) {
  s = s || '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3000 && c <= 0x303f)) return true;
  }
  return false;
}

// 多语言适配：用户可能用任意语言操作（中文/德语/日语…），检索前统一翻译成
// 目标市场语言（先英语/海外）。检索层本身固定 hl=en + gl=市场地区，所以把赛道翻成
// 市场语言再去搜，才能命中真实对手，而不是「中文词查美国英文 Google」得到 0 结果。
// 判定：输入含非 ASCII 字符（CJK/重音/西里尔等）才需要翻译；纯 ASCII 视为已是英文，
// 直接跳过以省一次 LLM 调用（覆盖海外商家主要用英文输入的常见路径）。
function needsTranslation(track) {
  return /[^\x00-\x7F]/.test(track || '');
}
async function translateToMarketLang(track, intent, targetLang, dsKey) {
  const langName = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', ja: 'Japanese', zh: 'Chinese' }[targetLang] || targetLang;
  const sys = `You are the localization layer of a competitive-intelligence tool that serves the ${langName}-speaking OVERSEAS e-commerce market (Shopify merchants etc.).
Task: rewrite the user's product category / niche into the most natural ${langName} phrase a local shopper or analyst would type into Google.
Rules:
- Output 1-5 words, commercial and precise. Example: "定制手办" -> "custom action figure"; "定制玩具" -> "custom toys".
- Preserve the exact product meaning; do NOT broaden to a vague generic category.
- Respond with JSON only: {"query":"<translated phrase>"}`;
  const user = `User input (may be any language): ${track}\nNiche/positioning context: ${JSON.stringify((intent && (intent.niche || intent.positioning)) || {})}`;
  try {
    const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'track-translate' });
    if (j && j.query && String(j.query).trim()) return String(j.query).trim();
  } catch (e) { /* 翻译失败，回落原文 */ }
  return null;
}
function buildFanoutQueries(track, intent) {
  const cjk = isCJK(track);
  // 覆盖全体量：头部大牌 / 腰部 / 独立小众 / 新兴，避免只出大牌或残缺小品牌
  let q;
  if (cjk) {
    q = [
      `${track} 品牌 推荐`,
      `${track} 独立品牌 小众`,
      `${track} 新兴 创业 公司`,
      `类似 ${track} 的品牌 竞品`,
      `${track} 淘宝 店铺 推荐`,
      `${track} 头部 品牌 排行榜`,
      `${track} 腰部 品牌`,
      `${track} 出海 品牌`
    ];
  } else {
    q = [
      `best ${track} brands market leaders`,
      `top ${track} companies 2025`,
      `${track} small independent boutique brands`,
      `${track} emerging startups 2024 2025`,
      `${track} niche indie DTC brands`,
      `${track} micro handmade brand etsy`,
      `${track} TikTok Shop growing sellers`,
      `alternatives to leading ${track} brand`
    ];
  }
  const regions = (intent && intent.regions && intent.regions.length) ? intent.regions : null;
  if (regions) regions.slice(0, 2).forEach(r => {
    const rname = { us: '美国', uk: '英国', eu: '欧洲', cn: '中国', jp: '日本', sea: '东南亚' }[r] || r;
    q.push(cjk ? `${track} ${rname} 市场 品牌` : `${track} brands market ${r}`);
  });
  return q.slice(0, 9);
}

async function fanoutSearch(queries, config, gl) {
  // 模块 0-3：discover 扇出查询用 24h 缓存（同赛道跨租户/跨时段复用，命中免配额）
  const results = await Promise.allSettled(queries.map(q => searchProvider(q, config, gl, 'serp-discover')));
  const ok = [];
  let quota = false;
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      // T1-1：searchProvider 在额度耗尽时返回 {error:'quota'}（非抛出，避免其它调用点崩）；此处汇聚信号并抛出，
      // 让 /api/discover 路由能向用户返回 429 配额错误（而非静默返回空结果）。
      if (r.value && r.value.error === 'quota') { quota = true; return; }
      ok.push(r.value);
    }
  });
  if (quota) throw new Error('SEARCH_QUOTA');
  return ok;
}

// 发现渠道①：LLM 内生知识枚举（免费候选生成器；铁律：每个名字必须过搜索验证才能入库）
// 性能（2026-08-12 诊断）：输出规模是 discover 慢的主因 → 候选 8-10、why 极简（输出 tokens 减半）
async function llmEnumerate(track, intent, dsKey) {
  const regions = (intent && intent.regions && intent.regions.length) ? intent.regions.join('/') : 'us(北美为主)';
  const sys = `你是资深消费品行业分析师。基于你的既有知识，枚举"${track}"赛道（主要市场：${regions}）真实存在的品牌。
要求（宁缺毋滥，控制在 8-10 个）：
- 头部(large) 2-3、腰部(mid) 2-3、小众(small) 1-2、新兴(emerging) 1-2。
- 每个给 name（品牌官方英文名优先）、url（官网域名，不确定就留空，绝不编造）、tier、matchScore(0-100 整数)、why（不超过 6 个字的极简短语，如"主流大牌"）。
- 只列你有把握真实存在的；宁缺毋滥。
- 只列独立品牌，绝不列平台/市场（Etsy、Amazon、Amazon Custom、TikTok Shop、eBay 等都是平台，不是品牌）。
输出 JSON：{"candidates":[{"name":"","url":"","tier":"","matchScore":0,"why":""}]}`;
  try {
    // 大输出调用：超时放宽到 90s、重试 1 次（避免 45s 阈值触发重试翻倍）
    const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: `赛道：${track}；意图：${JSON.stringify(intent || {})}` }], dsKey, null, { fieldKey: 'discover-enumerate', timeoutMs: 90000, maxAttempts: 2 });
    return (j.candidates || []).map(c => { c.src = 'llm'; return c; });
  } catch { return []; }
}

// 阶段一：只 harvest 候选名 + URL（减编造）；同时产出第二轮追加查询（两轮迭代搜索）
// 性能（2026-08-12 诊断）：snippets 每查询 6→4 条、截断 260→200（输入减负），候选 why 极简（输出减半）
async function harvestCandidates(track, intent, fanout, dsKey, labels) {
  const snippets = [];
  let idx = 0;
  fanout.forEach((tres, qi) => {
    const query = (labels && labels[qi]) || '';
    (tres.results || []).slice(0, 4).forEach(x => {
      idx++;
      snippets.push(`[${idx}] (query: ${query}) ${x.title} — ${x.url}\n${(x.content || '').slice(0, 200)}`);
    });
  });
  const sys = `你是"知彼 Vantage"。用户赛道："${track}"。用户意图：${JSON.stringify(intent || {})}.
从下面真实搜索结果中，只提取【真实存在、且在运营】的竞争对手【品牌名 + 官网URL】。
规则：
- 只列消费品牌/公司，不要列平台、媒体、泛指南、非竞品。【特别注意】Etsy / Amazon / "Amazon Custom" / "Amazon Handmade" / TikTok Shop / eBay / 速卖通 等是【销售平台/市场】，不是品牌，绝对不能作为候选输出；"某平台上的定制服务"也不算品牌，除非能给出独立的品牌名和官网。
- 【严格贴合赛道】只列真正属于"${track}"这个赛道（同类消费品牌）的玩家；若某角度搜回来多是 Apple/Nike/阿里 这类跨行业巨头或无关大牌，说明该角度无效，宁可少列、只保留强相关，也不要塞入无关品牌。matchScore<50 的除非有强证据否则不要输出。
- 【宁缺毋滥】总数控制在 8-12 个；头部大牌、腰部品牌、独立小众、新兴品牌都要有；优先列真实在运营、有公开痕迹的。
- 每个候选给 name、url（必须来自真实链接，不确定留空）、tier（"large"/"mid"/"small"/"emerging"）、matchScore(0-100 整数)、why（不超过 8 个字的极简短语）。
- 不要编造；不确定 url 就留空字符串。
- 另外：从结果里发现的【线索】（提到但信息不足的品牌名、别名、"also compare with X"），生成最多 3 条值得追加的搜索查询放入 moreQueries；没有就给空数组。
输出 JSON：{"candidates":[{"name":"","url":"","tier":"","matchScore":0,"why":""}],"moreQueries":["",""]}`;
  const user = `搜索结果：\n${snippets.join('\n\n')}`;
  // 大输出调用：超时放宽到 90s、重试 1 次（避免 45s 阈值触发重试翻倍）
  const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'discover-harvest', timeoutMs: 90000, maxAttempts: 2 });
  return { candidates: j.candidates || [], moreQueries: Array.isArray(j.moreQueries) ? j.moreQueries.slice(0, 3) : [] };
}
let queries_label = [];

// 候选合并去重（名字归一化后合并，保留信息更全者）
function normName(n) { return String(n || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, ''); }

// 平台/市场/社媒 ≠ 品牌：发现层硬过滤（代码裁决，不依赖 LLM 自觉）
const PLATFORM_NAMES = ['etsy', 'amazon', 'ebay', 'walmart', 'target', 'aliexpress', 'alibaba', 'taobao', 'tmall', 'temu', 'wish', 'shopify', 'tiktok', 'tiktokshop', 'instagram', 'facebook', 'pinterest', 'reddit', 'youtube', 'google', 'kickstarter', 'indiegogo', 'faire', 'wayfair', 'redbubble', 'zazzle', 'shein', '淘宝', '天猫', '拼多多', '京东', '亚马逊'];
const PLATFORM_SUFFIX = /^(custom|customs|handmade|merch|shop|store|marketplace|sellers?|finds|shops)$/;
// 闸门「移除」原因分类（用户反馈 taxonomy，喂养搜索算法迭代）
// isTractionBlind=true 表示这是信号缺口(无流量源)而非算法错误，路由到「是否接流量源」决策
const EXCLUDE_REASONS = {
  irrelevant:   { zh: '不相关（非竞品）', isTractionBlind: false },
  noTraction:   { zh: '无体量（没流量）', isTractionBlind: true },
  wrongSegment: { zh: '错品类（错位）', isTractionBlind: false },
  duplicate:    { zh: '重复（同名异写）', isTractionBlind: false },
  defunct:      { zh: '已退市 / 信息陈旧', isTractionBlind: false },
};
// 硬信号生效：剔除本赛道被用户移除过的品牌（按名字×赛道），零风险自动排除
function applySuppression(candidates, suppressed, track) {
  const supNames = (suppressed || []).filter(x => x.track === track).map(x => x.name);
  const before = candidates.length;
  const kept = candidates.filter(c => !supNames.includes((c.name || '').toLowerCase().trim()));
  return { kept, dropped: before - kept.length };
}
// 软信号提炼：从用户反馈(suppressed)中按原因聚类、找共性，提炼「候选规则」。
// 注意：这些规则只生成、不自动上线——每条需用户审(Q1 已定：每条先审)。
const RELEVANCE_KW = ['打印机', '3d打印', '打印', '工厂', '设备', '代工', 'oem', '原材料', 'supplier', 'manufactur', 'printer', 'factory'];
function extractCandidateRules(state) {
  const sup = state.suppressed || [];
  const rules = [];
  const byReason = {};
  sup.forEach(x => { (byReason[x.reason] = byReason[x.reason] || []).push(x); });
  // irrelevant：找共性关键词（设备/代工/原料商特征）
  const irrel = byReason.irrelevant || [];
  if (irrel.length >= 2) {
    const hitCount = {};
    irrel.forEach(x => {
      // 证据面：名字 + 域名 + 当初的入选理由/定位（噪音特征多藏在"工业级3D打印机厂商"这类描述里）
      const hay = [x.name, x.url, x.why, x.positioning].filter(Boolean).join(' ').toLowerCase();
      RELEVANCE_KW.forEach(k => { if (hay.includes(k.toLowerCase())) hitCount[k] = (hitCount[k] || 0) + 1; });
    });
    const common = Object.keys(hitCount).filter(k => hitCount[k] >= 2);
    if (common.length) {
      rules.push({ id: 'irrel-kw', reason: 'irrelevant', kind: 'relevance-keyword', isTractionBlind: false,
        keywords: common, enforceable: true,
        text: `被移除的无关品牌多命中关键词 [${common.join('/')}]，建议在相关性裁判中强化此类周边企业(设备/代工/原料)识别`,
        effect: `采纳后：下次搜索中，名称/简介命中 [${common.join('/')}] 的候选将被直接剔除。`,
        evidence: irrel.map(x => x.name), confidence: 'medium' });
    } else {
      rules.push({ id: 'irrel-generic', reason: 'irrelevant', kind: 'relevance-review', isTractionBlind: false,
        enforceable: false,
        text: `${irrel.length} 个品牌被标记为不相关，但暂未找到可执行的共性特征`,
        effect: '暂无法转成自动规则——需要更多样本，或你补一句"它们哪里像"。',
        evidence: irrel.map(x => x.name), confidence: 'low' });
    }
  }
  // noTraction：信号缺口，非算法可解
  const nt = byReason.noTraction || [];
  if (nt.length) {
    rules.push({ id: 'traction-gap', reason: 'noTraction', kind: 'signal-gap', isTractionBlind: true, enforceable: false,
      text: `${nt.length} 个品牌被标记为无体量(没流量)。这是信号缺口，不是算法判错`,
      effect: '我们目前没有流量数据源，算法看不见"有没有人访问"，学不会这条。它已被按名字硬排除，但同类新噪音还会再出现——除非接入流量源(Similarweb 类)。这是一个需要你拍板的决策，不是一条可采纳的规则。',
      evidence: nt.map(x => x.name), confidence: 'high' });
  }
  const seg = byReason.wrongSegment || [];
  if (seg.length) rules.push({ id: 'segment', reason: 'wrongSegment', kind: 'segment-mismatch', isTractionBlind: false, enforceable: false,
    text: `${seg.length} 个品牌错品类（与你的定位段位错位）`,
    effect: '需要你的定位信息更完整（价位段/核心卖点）才能转成降权规则，当前样本不足以自动执行。',
    evidence: seg.map(x => x.name), confidence: 'low' });
  const dup = byReason.duplicate || [];
  if (dup.length) rules.push({ id: 'dup', reason: 'duplicate', kind: 'alias-merge', isTractionBlind: false, enforceable: false,
    text: `${dup.length} 个重复项（同名异写）`, effect: '已按名字硬排除；别名合并规则待样本积累。', evidence: dup.map(x => x.name), confidence: 'low' });
  const def = byReason.defunct || [];
  if (def.length) rules.push({ id: 'defunct', reason: 'defunct', kind: 'recency-check', isTractionBlind: false, enforceable: false,
    text: `${def.length} 个已退市/信息陈旧`, effect: '已按名字硬排除；时效性校验需要"最近活跃"信号源。', evidence: def.map(x => x.name), confidence: 'low' });
  return rules;
}
// 采纳后的规则才生效（Q1 铁律：每条先审，不替用户改判定逻辑）
function approvedKeywords(ruleDecisions) {
  const out = [];
  Object.values(ruleDecisions || {}).forEach(d => {
    if (d && d.decision === 'approved' && Array.isArray(d.keywords)) out.push(...d.keywords);
  });
  return [...new Set(out.map(k => String(k).toLowerCase()))];
}
function applyApprovedRules(candidates, ruleDecisions) {
  const kws = approvedKeywords(ruleDecisions);
  if (!kws.length) return { kept: candidates, dropped: 0, hits: [] };
  const hits = [];
  const kept = candidates.filter(c => {
    const hay = [c.name, c.url, c.why, c.positioning].filter(Boolean).join(' ').toLowerCase();
    const hit = kws.find(k => hay.includes(k));
    if (hit) { hits.push({ name: c.name, kw: hit }); return false; }
    return true;
  });
  return { kept, dropped: candidates.length - kept.length, hits };
}
// 纠错报告：本轮移除(带原因) + 补对手 + 候选规则（供用户逐条审）
function constructFeedbackReport(state) {
  const sup = state.suppressed || [];
  const zh = k => (EXCLUDE_REASONS[k] || { zh: k }).zh;
  const dec = state.ruleDecisions || {};
  const rules = extractCandidateRules(state).map(r => ({
    ...r,
    decision: (dec[r.id] && dec[r.id].decision) || 'pending', // 未审即未生效
    decidedAt: (dec[r.id] && dec[r.id].at) || null,
  }));
  // 价格字段纠错（Pilot 1 闭环产物）：喂给"算法校准率"指标 + 复核面板
  const priceCorr = (state.fieldCorrections || []).filter(c => /^price/.test(c.field));
  const nameOf = id => { const c = (state.competitors || []).find(x => x.id === id); return c ? c.name : id; };
  const priceCorrections = priceCorr.map(c => ({ competitor: nameOf(c.competitorId), type: c.type, value: c.value, currency: c.currency, text: c.text, at: c.at }));
  // 软信号提炼：同类型纠错 ≥2 次 → 候选规则（每条需用户审，红线不变）
  const byType = {};
  priceCorr.forEach(c => { byType[c.type] = byType[c.type] || []; byType[c.type].push(c); });
  const priceRules = Object.keys(byType).filter(t => byType[t].length >= 2).map(t => ({
    id: 'price-' + t, reason: 'price', kind: 'field-pattern', isTractionBlind: false,
    text: `${byType[t].length} 次价格字段纠错类型「${t}」——可能存在系统性偏差，建议人工复核该字段的采集/裁决逻辑`,
    evidence: byType[t].map(c => nameOf(c.competitorId)), confidence: 'medium',
    enforceable: false, decision: (dec['price-' + t] && dec['price-' + t].decision) || 'pending', decidedAt: (dec['price-' + t] && dec['price-' + t].at) || null,
  }));
  // 空白视图（聚合产物）轻量纠错通道：用户反馈的"某空白判断不准"落在这里，逐条留痕供复核
  // P1-7：按本项目所属租户读取，杜绝跨租户泄露。
  let gapReports = [];
  try { gapReports = JSON.parse(fs.readFileSync(reportsFile(state && state.tenantId), 'utf8')).filter(r => r.gapId); } catch (e) {}
  return {
    removed: sup.map(x => ({ name: x.name, reason: x.reason, reasonZh: zh(x.reason), isTractionBlind: (EXCLUDE_REASONS[x.reason] || {}).isTractionBlind || false, at: x.at })),
    added: (state.addedCompetitors || []).map(x => ({ name: x.name, at: x.at })),
    rules: rules.concat(priceRules),
    priceCorrections,
    gapReports: gapReports.map(r => ({ at: r.at, gapLabel: r.gapLabel, description: r.description, source: r.source, status: r.status })),
    priceCalibration: { total: priceCorr.length, hardApplied: priceCorr.filter(c => ['wrong-value', 'wrong-currency', 'over-confident', 'confirm-correct'].includes(c.type)).length },
    pendingCount: rules.concat(priceRules).filter(r => r.enforceable && r.decision === 'pending').length,
    activeKeywords: approvedKeywords(dec),
  };
}
function isPlatformNotBrand(c) {
  const key = normName(c.name);
  if (!key) return false;
  if (PLATFORM_NAMES.includes(key)) return true;
  // "Amazon Custom" / "Etsy Handmade" / "TikTok Shop" 这类平台+泛词组合
  for (const pf of PLATFORM_NAMES) {
    if (key.startsWith(pf) && PLATFORM_SUFFIX.test(key.slice(pf.length))) return true;
  }
  return false;
}
function mergeCandidates(lists) {
  const map = new Map();
  lists.flat().forEach(c => {
    if (!c || !c.name) return;
    const key = normName(c.name);
    if (!key) return;
    const ex = map.get(key);
    if (!ex) {
      const e = Object.assign({}, c);
      e._domains = new Set(c.url ? [domainOf(c.url)] : []); // ▶ 数据卫生①：同名实体域名追踪
      map.set(key, e);
      return;
    }
    // 合并：url 取非空；matchScore 取大；tier 取已知；src 标记多源
    if (!ex.url && c.url) ex.url = c.url;
    if ((Number(c.matchScore) || 0) > (Number(ex.matchScore) || 0)) ex.matchScore = c.matchScore;
    if ((!ex.tier || ex.tier === 'unknown') && c.tier) ex.tier = c.tier;
    if (!ex.why && c.why) ex.why = c.why;
    if (c.src === 'llm') ex.llmKnown = true; else ex.serpKnown = true;
    if (ex.src === 'llm') ex.llmKnown = true;
    // ▶ 数据卫生①：实体消歧——同一归一化名映射到不同域名主页 → 同名多实体，标 entity-ambiguous 降级
    const d = c.url ? domainOf(c.url) : '';
    if (d) {
      if (ex._domains.size && !ex._domains.has(d)) ex.entityAmbiguous = true; // 冲突：同名不同域（如 Ursa Major 火箭 vs 护肤品）
      ex._domains.add(d);
    }
  });
  // 剥离内部追踪字段，避免污染下游；entityAmbiguous 透传供降级使用
  return Array.from(map.values()).map(e => { const { _domains, ...rest } = e; return rest; });
}

// 交叉验证：统计每个候选在全部原始结果中真实出现次数（天然去编造）
// 同时算 distinctHits = 命中了「几个不同的查询角度」（单次噪声 vs 真有体量的品牌）
function crossValidate(candidates, fanout) {
  const perQuery = fanout.map(t => (t.results || []).map(x => (x.title + ' ' + x.content + ' ' + x.url).toLowerCase()));
  candidates.forEach(c => {
    const name = (c.name || '').toLowerCase().trim();
    if (!name) { c.evidenceCount = 0; c.distinctHits = 0; return; }
    let count = 0, hits = 0;
    perQuery.forEach(q => {
      const n = q.filter(h => h.includes(name)).length;
      if (n > 0) { hits++; count += n; }
    });
    c.evidenceCount = count;
    c.distinctHits = hits;
  });
  // 保留：至少在来源出现 1 次 或 有 url
  return candidates.filter(c => c.evidenceCount >= 1 || (c.url && c.url.startsWith('http')));
}

function rankCandidates(candidates) {
  // 硬门槛1：平台/市场/社媒不是品牌（Etsy、Amazon Custom 之类），直接剔除
  candidates = candidates.filter(c => !isPlatformNotBrand(c));
  // 硬门槛2：matchScore<40 视为噪音（跨行业巨头/无关大牌），直接剔除
  candidates = candidates.filter(c => (Number(c.matchScore) || 0) >= 40);
  candidates.forEach(c => {
    // categoryFit 优先（相关性二次裁判给的贴合度），缺失时回落到 harvest 自报的 matchScore
    const fit = Math.max(0, Math.min(100, Number(c.categoryFit) || Number(c.matchScore) || 0));
    c.categoryFit = fit;
    const ev = Math.min(c.distinctHits || c.evidenceCount || 0, 5);
    const hasUrl = !!(c.url && c.url.startsWith('http'));
    // 排序：相关性主导；跨查询出现次数作存在度加成；有官网再轻加权
    c.rankScore = Math.round(fit + ev * 3 + (hasUrl ? 4 : 0));
    // 置信度：跨 ≥3 个查询且有官网 = high；跨 ≥2 或有官网 = medium；否则 low
    c.confidence = (c.distinctHits >= 3 && hasUrl) ? 'high' : ((c.distinctHits >= 2 || hasUrl) ? 'medium' : 'low');
    // ▶ 数据卫生①：同名多实体（entityAmbiguous）→ 置信不足，强制降级为 low（覆盖 ≠ 正确）
    if (c.entityAmbiguous) {
      c.confidence = 'low';
      c.ambiguousNote = '同名多实体：归一化名映射到不同域名主页，可能为不同而混淆的对手，已降级';
    }
  });
  candidates.sort((a, b) => b.rankScore - a.rankScore);
  return candidates;
}

// ============================================================
// 相关性二次裁判 + 市场存在度门槛（解决"搜定制手办却出设备商/零曝光品牌"）
// ============================================================

// 纯函数：把 LLM 裁判结果合并回候选（便于单元测试，无副作用之外的 LLM 依赖）
function applyRelevanceJudgments(candidates, judgments) {
  const map = new Map();
  (judgments || []).forEach(j => { if (j && j.name) map.set(normName(j.name), j); });
  candidates.forEach(c => {
    const j = map.get(normName(c.name));
    if (j) {
      c.relevant = j.relevant !== false;
      c.categoryFit = Number(j.categoryFit) || 0;
      c.relReason = j.reason || '';
    } else {
      // LLM 漏返回的候选：默认保留但用 harvest 自报分作拟合度，不误杀
      c.relevant = true;
      if (c.categoryFit == null) c.categoryFit = Number(c.matchScore) || 0;
    }
  });
  return candidates;
}

// 纯函数：市场存在度门槛——单次命中且无官网 ≈ 噪声（"基本没浏览/没曝光"）
function presenceGate(candidates) {
  return candidates.filter(c => {
    const hasUrl = !!(c.url && c.url.startsWith('http'));
    if ((c.distinctHits || 0) < 2 && !hasUrl) return false;
    return true;
  });
}

// 批量 LLM 复核：捕获"设备/打印机/OEM 代工/原材料供应商/平台"等周边企业
async function rejudgeRelevance(track, candidates, fanout, dsKey) {
  if (!candidates.length) return [];
  const snippetsByKey = {};
  fanout.forEach(t => (t.results || []).forEach(x => {
    const blob = (x.title + ' ' + x.content).toLowerCase();
    candidates.forEach(c => {
      const nm = (c.name || '').toLowerCase();
      if (nm && blob.includes(nm)) { (snippetsByKey[normName(c.name)] = snippetsByKey[normName(c.name)] || []).push((x.content || '').slice(0, 140)); }
    });
  }));
  const items = candidates.map(c => ({ name: c.name, tier: c.tier, why: c.why || '', url: c.url || '', snippet: (snippetsByKey[normName(c.name)] || [])[0] || '' }));
  const sys = `你是"知彼 Vantage"的相关性裁判。用户赛道："${track}"。
任务：逐一审视候选，判断它是否真的是该赛道【面向终端消费者的品牌 / 产品公司】，而不是平台、设备 / 3D打印机 / 模具 / OEM 代工厂、原材料供应商、或仅"服务于该行业"的周边企业。
判定铁律：
- 设备 / 3D打印机 / 打印工厂 / OEM代工 / 原材料供应商 = 不是该赛道的消费品牌（即使它给该行业供货），relevant=false。
- 平台 / 电商 / 社媒 = relevant=false。
- 只数"真正面向终端消费者售卖该品类产品"的品牌为 relevant=true。
输出 JSON：{"judgments":[{"name":"","relevant":true|false,"categoryFit":0-100,"reason":"一句话"}]}`;
  const user = `候选清单：\n` + items.map((it, i) => `[${i + 1}] ${it.name} | tier=${it.tier} | ${it.url || '(无官网)'} | ${it.why || ''} | 摘录：${it.snippet || ''}`).join('\n');
  try {
    const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'discover-crossvalidate' });
    return j.judgments || [];
  } catch { return []; }
}

function slug(name, i) {
  const base = (name || ('c' + i)).toLowerCase().replace(/[^a-z0-9一-鿿]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (base || 'c') + '-' + i;
}

// 步骤1 主流程：知识枚举 + 两轮迭代搜索 + 合并验证，返回骨架卡（不等待深研）
async function runDiscover(track, intent, config, emit, projectId) {
  const sKey = activeSearchKey(config);
  const dsKey = config.llm.apiKey;
  if (!sKey || !dsKey) throw new Error('NO_KEYS');
  const pid = projectId || newProjectId(track);
  const _t0 = Date.now();
  // ▶ 加固（0812 体验报告）：发现启动即落空状态——即使后续外部调用全失败（密钥失效等），
  // 项目也已落库、state.track 立即可见、/api/projects 立即可列出、轮询兜底恒有数据，杜绝「永久空白」。
  const _initState = {
    projectId: pid,
    track,
    intent: normalizeIntent(intent),
    competitors: [],
    discoveredAt: new Date().toISOString(),
    progress: { total: 0, done: 0 },
    excluded: [], excludedReasons: {}, suppressed: [], addedCompetitors: [],
    ruleDecisions: {}, fieldCorrections: [], signals: {}, whiteSpace: null, brief: null,
    discoverDone: false,
  };
  _initState.intent = _initState.intent || {};
  _initState.intent.platforms = resolvePlatforms({
    platforms: (intent && intent.platforms) || _initState.intent.platforms,
    regions: _initState.intent.regions,
  });
  _initState.tenantId = resolveTenantId();
  setCurrentId(pid, _initState.tenantId);
  saveState(_initState);                                  // ← 关键：首个外部 await 之前落盘
  // 关键：项目立即进 db 清单。tenantId 必须用 RAW（requestScope）对齐 db.listProjects 的过滤键——
  // resolveTenantId 返回 sanitizeNs 后的（tenant:xxx → tenant_xxx），而 db 存 RAW（tenant:xxx），
  // 用错键会导致 /api/projects 查不到（0812 加固实测发现，与原中部 mirrorProjectToDb 口径对齐）。
  mirrorProjectToDb(pid, requestScope.getStore() || _initState.tenantId, track);
  if (emit) emit('discover_stage', { projectId: pid, stage: 'translating', label: '正在理解你的赛道…', pct: 5, found: 0 });
  const _stage = (name) => { try { Logger.info('discover-stage', { stage: name, elapsedMs: Date.now() - _t0, track }); } catch (e) {} };
  // —— 多语言适配 + 第一轮并行（性能优化 ②）：翻译 ∥ LLM 枚举 ——
  // 翻译只喂搜索查询构造（buildFanoutQueries）；枚举用原文赛道（LLM 懂中文，品牌名是英文不依赖翻译）
  // 原串行：translate(2-4s) → 枚举(20-30s)；改并行：max(translate, 枚举)，省 translate 时间
  const marketLang = (config.search && config.search.marketLang) || 'en';
  let trackWork = track;
  let translatedFrom = null;
  const gl = glFromRegions(intent && intent.regions);
  const _tR1 = Date.now();
  const translateP = (marketLang && marketLang !== 'raw' && needsTranslation(track))
    ? translateToMarketLang(track, intent, marketLang, dsKey).then(tr => {
        if (tr) { trackWork = tr; translatedFrom = track; }
      })
    : Promise.resolve();
  const enumP = llmEnumerate(track, intent, dsKey).then(v => { _stage('llmEnumerate-done'); return v; });
  await Promise.all([translateP, enumP]);
  _stage('translate');
  // 承接上一轮的学习信号（用户反馈）：按名字×赛道记的 suppressed / 用户补的对手，跨次 discover 保留
  const prevState = loadState() || {};
  const carrySuppressed = Array.isArray(prevState.suppressed) ? prevState.suppressed : [];
  const carryAdded = Array.isArray(prevState.addedCompetitors) ? prevState.addedCompetitors : [];
  const carryRules = prevState.ruleDecisions && typeof prevState.ruleDecisions === 'object' ? prevState.ruleDecisions : {};

  // SERP 扇出（依赖翻译结果构造查询；与枚举已并行，这里单独跑）
  const queries = buildFanoutQueries(trackWork, intent);
  queries_label = queries;
  const fanout = await fanoutSearch(queries, config, gl).then(v => { _stage('fanout-done'); return v; });
  const llmCands = await enumP;
  if (emit) emit('discover_stage', { projectId: pid, stage: 'enumerating', label: '已枚举候选品牌，正在全网搜索…', pct: 15, found: llmCands.length });
  if (emit) emit('discover_stage', { projectId: pid, stage: 'searching', label: '正在多维度搜索对手（覆盖各体量）…', pct: 30, found: fanout.length });
  _stage('round1（total ' + ((Date.now() - _tR1) / 1000).toFixed(1) + 's）');
  if (!fanout.length && !llmCands.length) throw new Error('SEARCH_FAILED');

  const _tH = Date.now();
  const h1 = await harvestCandidates(trackWork, intent, fanout, dsKey, queries);
  _stage('harvest（total ' + ((Date.now() - _tH) / 1000).toFixed(1) + 's）');
  if (emit) emit('discover_stage', { projectId: pid, stage: 'harvesting', label: '已抓取到一批线索，正在校验…', pct: 45, found: h1.candidates.length });
  let allFanout = fanout.slice();
  let labels2 = [];

  // 第二轮：追加"线索查询" + 对 LLM 独有候选做存活验证（迭代搜索，复刻"多轮追问"机制）
  const llmOnlyNames = llmCands
    .filter(c => !h1.candidates.some(x => normName(x.name) === normName(c.name)))
    .slice(0, 8) // 上限控预算
    .map(c => `"${c.name}" official site ${trackWork}`);
  const round2 = h1.moreQueries.concat(llmOnlyNames);
  if (round2.length) {
    labels2 = round2;
    const fan2 = await fanoutSearch(round2, config, gl);
    allFanout = allFanout.concat(fan2);
  }
  _stage('round2');

  // 合并三路候选：SERP harvest + LLM 枚举；用全部原始结果交叉验证（LLM 候选无搜索痕迹则黜落）
  let candidates = mergeCandidates([h1.candidates, llmCands]);
  // 渐进式发现：先以 lead 线索卡广播，让用户尽早看到“在找”（最终被滤掉的线索卡会在收尾时 brand_removed）
  const _leadIds = [];
  for (const c of candidates.slice(0, 24)) {
    const _id = slug(c.name, _leadIds.length);
    _leadIds.push(_id);
    if (emit) emit('brand_found', { projectId: pid, tier: 'lead', card: {
      id: _id, name: c.name || ('线索' + (_leadIds.length)), url: c.url || '', tier: c.tier || 'unknown',
      matchScore: 0, why: c.why || '全网/维度命中线索', status: 'lead', evidenceCount: c.evidenceCount || 0, confidence: 'low' } });
  }
  const afterHarvest = candidates.slice();
  candidates = crossValidate(candidates, allFanout);
  // LLM 枚举且无任何搜索证据的候选 → 剔除（知识可能过时/幻觉，验证是铁律）
  candidates = candidates.filter(c => !(c.src === 'llm' && (c.evidenceCount || 0) === 0 && !c.serpKnown));
  const afterCross = candidates.slice();
  // 相关性二次裁判：捕获"设备/打印机/OEM代工/原材料供应商/平台"等周边企业（harvest 自报分漏判的无关项）
  const judgments = await rejudgeRelevance(trackWork, candidates, allFanout, dsKey);
  _stage('rejudge');
  candidates = applyRelevanceJudgments(candidates, judgments);
  candidates = candidates.filter(c => c.relevant && (Number(c.categoryFit) || 0) >= 60);
  // 市场存在度门槛：剔除"基本没浏览/没曝光"的单次噪声（跨 <2 个查询且无官网）
  candidates = presenceGate(candidates);
  const afterRelevance = candidates.slice();
  if (emit) emit('discover_stage', { projectId: pid, stage: 'validating', label: '正在校验对手相关性与市场存在度…', pct: 70, found: candidates.length });
  candidates = rankCandidates(candidates).slice(0, 18);
  // 硬信号生效：剔除上一轮用户在本赛道移除过的品牌（按名字×赛道），零风险自动排除
  const supRes = applySuppression(candidates, carrySuppressed, track);
  candidates = supRes.kept;
  const suppressedDropped = supRes.dropped;
  // 软信号生效：仅执行你已「采纳」的规则（未审的规则一律不生效）
  const ruleRes = applyApprovedRules(candidates, carryRules);
  candidates = ruleRes.kept;
  try { safeWrite(path.join(DATA, 'debug_discover.json'), JSON.stringify({
    trackReceived: track, translatedFrom, trackWork, marketLang, cjkResult: isCJK(trackWork), provider: (config.search && config.search.provider) || 'tavily', gl,
    queries, round2Queries: labels2, llmEnumerated: llmCands.map(c => c.name),
    fanoutCounts: allFanout.map(f => (f.results || []).length),
    afterHarvest: afterHarvest.map(c => ({ name: c.name, match: c.matchScore, ev: c.evidenceCount, dh: c.distinctHits, url: c.url, tier: c.tier, src: c.src || 'serp' })),
    afterCross: afterCross.map(c => ({ name: c.name, match: c.matchScore, ev: c.evidenceCount, dh: c.distinctHits, url: c.url })),
    rejudge: candidates.length ? null : judgments, // 仅当被全滤掉时保留裁判明细便于排查
    afterRelevance: afterRelevance.map(c => ({ name: c.name, match: c.matchScore, fit: c.categoryFit, dh: c.distinctHits, url: c.url, rel: c.relReason || '' })),
    suppressedDropped, approvedRuleHits: ruleRes.hits,
    final: candidates.map(c => ({ name: c.name, match: c.matchScore, fit: c.categoryFit, dh: c.distinctHits, ev: c.evidenceCount }))
  }, null, 1)); } catch {}

  const competitors = candidates.map((c, i) => ({
    id: slug(c.name, i),
    name: c.name || ('竞品' + (i + 1)),
    url: c.url || '',
    why: c.why || '',
    discoverWhy: c.why || '', // #304 保留发现阶段归类理由，供字段撕裂交叉校验
    categoryTearing: false, tearingNote: '', // #304 字段撕裂标记
    tier: c.tier || 'unknown', // large/mid/small/emerging/unknown
    matchScore: c.matchScore || 0,
    evidenceCount: c.evidenceCount || 0,
    confidence: c.confidence || 'low',
    entityAmbiguous: !!c.entityAmbiguous,
    ambiguousNote: c.ambiguousNote || '',
    rankScore: c.rankScore || 0,
    status: 'skeleton', // skeleton -> researching -> done | error
    manual: false,
    channels: {}, priceBand: null, pricePoints: [], freebies: [], audiences: [], regions: [],
    products: [], reviews: null, positioning: '', customization: null, estSize: null, techStack: null,
    recentMoves: [], contentForms: [], collabTypes: [], fulfillment: [],
    sellingPoints: [], tactics: [], painPoints: [], fieldSources: {},
    attempts: [],
    inferred: [], timeline: null, reviewSnippets: [], priceForensic: null,
    foundedYear: null, growth: 'unknown', demandAlignments: [],
    evidence: '', researchedAt: null
  }));

  // ▶ 数据卫生②：自动排除用户自有品牌（输入竞品集排除自有实体；空白视图分母只计外部竞品）
  // 不依赖 LLM，纯字符串/域名匹配；无 ownBrands 配置则零误伤。
  const ownEx = autoExcludeOwnBrands(competitors, (config && config.ownBrands) || []);

  // ▶ 加固（0812 体验报告）：复用顶部已落盘的 _initState（含 discoverDone:false），
  // 避免二次构建覆盖首次落库；以下赋值覆盖学习信号，幂等无害。
  const state = _initState;
  state.excluded = ownEx.excluded.slice(); // 闸门：用户标记为"不算对手"的竞品 id（零焦虑：默认全参与，移除可拉回）；自有品牌自动预填
  state.excludedReasons = Object.assign({}, ownEx.reasons); // id -> 移除原因（EXCLUDE_REASONS key / 'own-brand' 自动排除），喂养算法迭代
  state.suppressed = carrySuppressed.slice(); // 承接上一轮学习信号（按名字×赛道），discover 自动排除
  state.addedCompetitors = carryAdded.slice(); // 承接上一轮「补对手」正向信号
  state.ruleDecisions = JSON.parse(JSON.stringify(carryRules)); // 承接已审规则（采纳的持续生效，否决的不再复问）
  // 注：_initState 已含 intent.platforms / tenantId / setCurrentId / saveState / mirrorProjectToDb，
  // 此处不重复（避免二次 saveState 覆盖 discoverDone）。
  // 渐进式发现：把被最终过滤掉的 lead 线索卡移除，再逐张广播确认卡（skeleton）
  const finalIds = new Set(competitors.map(c => c.id));
  for (const lid of _leadIds) {
    if (!finalIds.has(lid)) { if (emit) emit('brand_removed', { projectId: pid, id: lid, reason: 'filtered' }); }
  }
  if (emit) emit('discover_stage', { projectId: pid, stage: 'ranking', label: '已确认对手，正在汇总…', pct: 90, found: competitors.length });
  for (const c of competitors) {
    state.competitors.push(c);
    state.progress.total = state.competitors.length;
    saveState(state); // 增量落盘（关键：刷新/轮询可恢复）
    if (emit) emit('brand_found', { projectId: pid, tier: 'skeleton', card: {
      id: c.id, name: c.name, url: c.url, tier: c.tier, matchScore: c.matchScore,
      why: c.why, status: 'skeleton', evidenceCount: c.evidenceCount, confidence: c.confidence } });
  }
  mirrorProjectToDb(pid, requestScope.getStore() || state.tenantId, state.track); // T3-1：镜像进 db 项目清单
  state.discoverDone = true; saveState(state); // 标记发现完成（供前端 SSE 断开时的轮询兜底判定收尾）
  if (emit) emit('discover_complete', { projectId: pid, total: state.competitors.length });
  // 后台逐家深研（不阻塞返回）
  enqueueResearch(state, config);
  return state;
}

// 异步启动发现（不阻塞 HTTP 响应）：同步返回 projectId 给 handler 组成 202；
// 管线在 setImmediate 里异步跑，结束（成功/失败）时释放并发闸。
function discoverLaunch(track, intent, config, gate) {
  const projectId = newProjectId(track);
  setImmediate(() => {
    runDiscover(track, intent, config, emitSSE, projectId)
      .catch(e => {
        const code = e.message === 'NO_KEYS' ? 'NO_KEYS'
                   : (e.message === 'SEARCH_QUOTA' || e.message === 'ENRICH_QUOTA') ? 'quota'
                   : 'DISCOVER_FAILED';
        try { Logger.error('discover-failed', { projectId, code, message: String(e.message || e), stack: String(e.stack || '').slice(0, 600) }); } catch {}
        emitSSE('discover_error', { projectId, code, message: String(e.message || e) });
      })
      .finally(() => { if (gate) gate.leave(); });
  });
  return { projectId };
}

// ============================================================
// 步骤2：逐家深研（后台队列 + 全字段）
// ============================================================
// 按项目隔离的研究队列（P0-1 修复）：每个 projectId 一份 {queue, running, researching}，
// 杜绝「全局队列被二次 discover 整体覆盖、抹掉前一次待深研任务」的缺陷。
const researchQueues = new Map(); // projectId -> { queue:[{id,priority}], running:bool, researching:Set }
const CONCURRENCY = 3;
function getQ(pid) {
  let q = researchQueues.get(pid);
  if (!q) { q = { queue: [], running: false, researching: new Set() }; researchQueues.set(pid, q); }
  return q;
}

// 仅构建本项目队列（不触发调度），便于隔离与测试
// 模块 0-4：同步落 research_tasks 表（幂等：同竞品已存在 pending/running 任务则跳过）——
// 深研中断重启后由 tasks 表自动续跑（断点续跑），不再只活在内存 Map。
function buildResearchQueue(state) {
  const sorted = state.competitors.slice().sort((a, b) => b.rankScore - a.rankScore);
  const topK = sorted.slice(0, 8);
  const rest = sorted.slice(8);
  const q = getQ(state.projectId);
  q.queue = [
    ...topK.map(c => ({ id: c.id, priority: 2 })),
    ...rest.map(c => ({ id: c.id, priority: 1 }))
  ];
  try {
    q.queue.forEach(job => Tasks.enqueue({
      tenantId: state.tenantId, projectId: state.projectId, type: 'deep-research',
      payload: { competitorId: job.id }, priority: job.priority,
    }));
  } catch (e) { /* 任务表不可用不影响研究主链路（非致命） */ }
  return q;
}

function enqueueResearch(state, config) {
  buildResearchQueue(state);
  runQueue(state, config);
}

function ensureQueue(state, config) { const q = getQ(state.projectId); if (!q.running) runQueue(state, config); }

async function runQueue(state, config) {
  const q = getQ(state.projectId);
  if (q.running) return;
  q.running = true;
  try {
    // 模块 0-4：先回收崩溃遗留（running 且租期过期 → pending，kill -9 后断点续跑）
    try { Tasks.reclaimExpired(Date.now()); } catch (e) { /* 非致命 */ }
    while (true) {
      // 从 tasks 表原子认领本项目任务（仅 pending 或过期 running；priority 高者先）
      let job = null;
      try { job = Tasks.claim(state.projectId, 'srv-' + state.projectId, Date.now()); } catch (e) { /* 非致命 */ }
      if (!job) break;
      let payload = {};
      try { payload = JSON.parse(job.payload || '{}'); } catch (e) { /* payload 解析失败按空处理 */ }
      if (q.researching.has(job.id)) continue;
      const comp = state.competitors.find(c => c.id === payload.competitorId);
      if (!comp || comp.status === 'done') {
        try { Tasks.finish(job.id, job.claimToken, 'done', 'skipped'); } catch (e) { /* 非致命 */ }
        continue;
      }
      q.researching.add(job.id);
      try {
        await deepResearchOne(comp, state, config);
        try { Tasks.finish(job.id, job.claimToken, 'done'); } catch (e) { /* 非致命 */ }
      } catch (e) {
        comp.status = 'error';
        comp.evidence = '深研失败：' + String(e.message || e);
        try { Tasks.finish(job.id, job.claimToken, 'error', String(e.message || e)); } catch (e2) { /* 非致命 */ }
      } finally {
        q.researching.delete(job.id);
        comp.researchedAt = new Date().toISOString();
        state.progress.done = state.competitors.filter(c => c.status === 'done').length;
        saveState(state);
      }
      await sleep(150);
    }
  } finally {
    q.running = false;
    q.queue = []; // 内存队列已被 tasks 表接管消费，消费完置空
    // 在研集空 → 回收 Map 条目，避免无限增长
    if (q.researching.size === 0) researchQueues.delete(state.projectId);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============ 模块 2-1：定时增量雷达（日 4 趟） ============
// 背景：「雷达」原为单次体检（radar.js 是变化检测算子但无时序数据喂）。
// sweep = 周期性重抓各活跃项目竞品的近期动作（recentMoves），
//   变化写入 state + events（timeline 序列），产出「Agent 在后台一直跑」的材料。
// 纪律：
//   · 僵尸项目（近 30 天无研究活动）零成本跳过 —— 预算池硬顶；
//   · 变化探测复用 deepDiveField（recentMoves 单字段重研，1 搜索 + 1 LLM/竞品）；
//   · serp-probe 7d 缓存兜住跨趟重复查询（命中免配额）；
//   · LLM 日预算（ZB_DAILY_BUDGET_YUAN）由 llm-gateway 熔断兜底。
// 项目活跃判定：档案内任一竞品 researchedAt 距今 < 30 天。
function projectLastActivityAt(state) {
  let latest = 0;
  (state.competitors || []).forEach(c => {
    const t = Date.parse(c.researchedAt || '');
    if (!isNaN(t) && t > latest) latest = t;
  });
  const d = Date.parse(state.discoveredAt || '');
  if (!isNaN(d) && d > latest) latest = d;
  return latest;
}
// 对单个项目做一轮增量变化探测
async function sweepProject(proj, config) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(projFile(proj.id, proj.tenantId), 'utf8')); } catch (e) { return { ok: false, reason: 'no_state' }; }
  if (!state || !Array.isArray(state.competitors)) return { ok: false, reason: 'no_state' };
  const hasLlm = !!(config && config.llm && config.llm.apiKey);
  const beforeMoves = new Map(state.competitors.map(c => [c.id, JSON.stringify(c.recentMoves || [])]));
  let probed = 0, changed = 0;
  for (const comp of state.competitors) {
    if (comp.status !== 'done' || comp.suppressed) continue;
    if (!hasLlm) break; // 无 LLM key：变化探测无法执行（搜索仅能带回原始片段）
    try {
      const r = await deepDiveField(state, comp, 'recentMoves', config);
      probed++;
      if (JSON.stringify(comp.recentMoves || []) !== beforeMoves.get(comp.id)) changed++;
    } catch (e) { /* 单家探测失败不阻断整轮 */ }
  }
  if (changed > 0) {
    // 变化：重新派生（domainVerdicts/materials 等）+ 记时序事件（timeline 数据源）
    try {
      decorateState(state);
      M.logEvent({ changeType: 'sweep_changes', source: 'sweep', from: String(probed), to: String(changed), confidence: null });
    } catch (e) { /* 派生/记账失败不影响落盘 */ }
  }
  saveState(state);
  // 更新 lastSweepAt（db 镜像表，scheduler/status 用）
  try {
    const dbProj = db.getProject(proj.tenantId, proj.id);
    if (dbProj) { dbProj.lastSweepAt = new Date().toISOString(); db.saveProject(dbProj); }
  } catch (e) { /* 非致命 */ }
  return { ok: true, probed, changed };
}
// 一轮完整 sweep：遍历所有租户项目 → 活跃者入队 + 消费
async function runSweep() {
  const config = loadConfig();
  if (!config) return { ok: false, reason: 'no_config' };
  let all = [];
  try { all = db.listAllProjects(); } catch (e) { return { ok: false, reason: 'db_err', error: String(e.message || e) }; }
  const out = { active: 0, zombie: 0, swept: 0, changed: 0, durationMs: 0 };
  const startedAt = Date.now();
  for (const proj of all) {
    let state = null;
    try { state = JSON.parse(fs.readFileSync(projFile(proj.id, proj.tenantId), 'utf8')); } catch (e) { /* 档案缺失视为僵尸 */ }
    const active = state && projectLastActivityAt(state) > Date.now() - 30 * 86400000;
    if (!active) { out.zombie++; continue; }
    out.active++;
    // 单进程内直接执行（sweep 由 scheduler 单实例调度，无并发认领问题）。
    // 说明：文档原设计「sweep 任务入 research_tasks 表由 worker 消费」属 Phase 3 worker 化后的形态；
    // 当前入队会积累无人消费的 pending（runQueue 只认领 deep-research 型），故先直接执行，worker 化时再接入。
    const r = await sweepProject(proj, config);
    if (r && r.ok) { out.swept++; out.changed += r.changed || 0; }
  }
  out.durationMs = Date.now() - startedAt;
  Scheduler.markSwept(startedAt);
  try { Logger.info('sweep 完成', out); } catch (e) { /* 日志不可用 */ }
  try { Metrics.inc && Metrics.inc('sweep_runs_total', 1); } catch (e) { /* 非致命 */ }
  return out;
}
// 启动定时雷达（SCHEDULER_ENABLED=0 完整关闭）
function startScheduler() {
  if (process.env.SCHEDULER_ENABLED === '0') {
    try { Logger.info('scheduler 已禁用（SCHEDULER_ENABLED=0）'); } catch (e) {}
    return null;
  }
  const s = Scheduler.scheduleNext(runSweep, Logger);
  try { Logger.info('scheduler 已启动', { nextAt: s.nextAt.toISOString(), hours: s.hours }); } catch (e) {}
  return s;
}

// 采集层 attempt 日志：记录每个字段/模块"查过什么、是否命中、为何没命中"。
// 这是空字段三态（unprobed / attempted_empty / unavailable）的地基，供 #51 渲染时区分。
// hit: true=命中, false=执行成功但零结果, null=探测失败（异常/超时，不等同于"查过没有"）。
function logAttempt(comp, field, query, source, hit, reason) {
  if (!comp) return;
  if (!Array.isArray(comp.attempts)) comp.attempts = [];
  comp.attempts.push({
    field: String(field || ''),
    query: String(query || ''),
    source: String(source || 'unknown'),
    hit: hit === true ? true : hit === false ? false : null,
    reason: String(reason || ''),
    time: new Date().toISOString()
  });
}
// 服务端镜像前端 attemptState：has / attempted_empty / unprobed
function fieldHasDataOnServer(comp, field) {
  switch (field) {
    case 'price': return !!(comp.pricePoints && comp.pricePoints.length) || !!comp.priceBand;
    case 'sellingPoints': return (comp.sellingPoints || []).length > 0;
    case 'positioning': return !!comp.positioning;
    case 'products': return (comp.products || []).length > 0;
    case 'audiences': return (comp.audiences || []).length > 0;
    case 'channels': return Object.keys(comp.channels || {}).some(k => comp.channels[k].present);
    case 'reviews': return !!(comp.reviews && (comp.reviews.rating != null || (comp.reviews.posThemes || []).length || (comp.reviews.negThemes || []).length));
    case 'painPoints': return (comp.painPoints || []).length > 0;
    case 'tactics': return (comp.tactics || []).length > 0;
    case 'contentForms': return (comp.contentForms || []).length > 0;
    case 'collabTypes': return (comp.collabTypes || []).length > 0;
    case 'fulfillment': return (comp.fulfillment || []).length > 0;
    case 'recentMoves': return (comp.recentMoves || []).length > 0;
    case 'estSize': return !!comp.estSize;
    case 'techStack': return !!comp.techStack;
    default: return false;
  }
}
function attemptStateOf(comp, field) {
  const a = ((comp && comp.attempts) || []).filter(x => x.field === field);
  if (!a.length) return fieldHasDataOnServer(comp, field) ? 'has' : 'unprobed';
  if (a.some(x => x.hit) || fieldHasDataOnServer(comp, field)) return 'has';
  return 'attempted_empty';
}
// 取某字段的全部 attempt 记录（按时间升序）
function attemptsFor(comp, field) {
  if (!comp || !Array.isArray(comp.attempts) || !field) return [];
  return comp.attempts.filter(a => a.field === field);
}

// 平台店铺链接特征（渠道判定用，代码裁决不交给 LLM）
const CHANNEL_LINK = {
  tiktokShop: /tiktok\.com\/@[\w.-]+/i,
  etsy: /etsy\.com\/shop\/[\w-]+/i,
  amazon: /amazon\.[a-z.]+\/(stores?|shops)\//i,
  xiaohongshu: /xiaohongshu\.com\/(user\/profile|shop)\/[\w]+/i,
  instagramShop: /instagram\.com\/[\w.]+/i,
  tmallJD: /(tmall\.com\/shop\/\d+|jd\.com\/(?:[\w-]+\/?))/i,
  shopifyDTC: /myshopify\.com/i
};

// 产品品类：全赛道自由文本（已废弃潮玩词表 CATEGORIES / CATEGORY_KEYWORDS 的写死判定）。
// 空数组表示品类不再走受控词表，由 AI 按赛道自由抽取，sanitizeVocab 进入自由文本模式。
const CATEGORIES = [];

// 深研 v2：证据链驱动 —— L2意图查询 + L3抓取正文/结构化价格 + L4锚点消歧 + L5置信度代码推导
async function deepResearchOne(comp, state, config) {
  const dsKey = config.llm.apiKey;
  comp.status = 'researching';
  saveState(state);
  const gl = glFromRegions(state.intent && state.intent.regions);
  const sProvider = (config.search && config.search.provider) || 'search';

  // ---- 本品牌证据库 ----
  const evidences = [];
  const addEv = (url, kind, title, excerpt, anchorDomain) => {
    if (!url || !/^https?:/i.test(url)) return null;
    const ex = evidences.find(e => e.url === url);
    if (ex) return ex;
    const tier = sourceTier(url, anchorDomain);
    if (tier === 3) return null; // 三级 SEO 聚合：不入库
    const e = { id: 'E' + (evidences.length + 1), url, tier, kind, title: String(title || '').slice(0, 120), excerpt: String(excerpt || '').slice(0, 280) };
    evidences.push(e);
    return e;
  };

  // ---- L4 锚点：先锁定官网域名 ----
  let anchorDomain = domainOf(comp.url);
  if (!anchorDomain) {
    try {
      const r0 = await searchProvider(`"${comp.name}" official website brand`, config, gl);
      const hit = (r0.results || []).find(x => belongsToBrand(x, comp.name, '') && sourceTier(x.url, '') !== 3 && !/reddit\.|wikipedia\.|facebook\.|instagram\.|tiktok\.|amazon\.|etsy\./i.test(x.url || ''));
      logAttempt(comp, 'anchor', `"${comp.name}" official website brand`, sProvider, !!hit, hit ? '命中官网候选' : '未命中官网候选');
      if (hit) { comp.url = hit.url; anchorDomain = domainOf(hit.url); }
    } catch (e) {
      logAttempt(comp, 'anchor', `"${comp.name}" official website brand`, sProvider, null, '锚点检索异常：' + String(e.message || e));
    }
  }

  // ---- L3 抓取层：官网正文 + Shopify 结构化价格（verified 级证据） ----
  let officialPage = { ok: false }, shopify = { ok: false }, officialEv = null;
  if (comp.url) {
    [officialPage, shopify] = await Promise.all([fetchPage(comp.url), fetchShopifyProducts(comp.url)]);
  }
  if (officialPage.ok) officialEv = addEv(comp.url, 'official', comp.name + ' 官网正文', officialPage.text.slice(0, 280), anchorDomain);
  logAttempt(comp, 'official', comp.url || '(无官网URL)', 'official', officialPage.ok, officialPage.ok ? '官网正文抓取成功' : (comp.url ? '官网抓取失败/不可达' : '无官网URL，跳过'));

  // ---- 币种裁决：优先探测该品牌站点自己的结算币种，探不到才按目标市场假定并明确标注 ----
  const mktCur = marketCurrency(state.intent && state.intent.regions);
  const detectedCur = officialPage.ok ? detectCurrency(officialPage.htmlLower) : null;
  comp.currency = detectedCur || mktCur;
  comp.currencyBasis = detectedCur ? 'detected' : 'assumed'; // assumed = 未探测到，按市场默认，前端须标出

  comp.priceVerified = false;
  let shopifyEv = null;
  if (shopify.ok) {
    // ▶ 报告-数据同源 §5：价格点前置过滤 $0 —— 免费品/赠品/错误条目不进价格点，
    // 单列 comp.freebies（不参与价格带聚合），避免 $0 脏值污染"全价格带覆盖"结论。
    const rawPts = shopify.items.map(x => x.minPrice).filter(n => n != null);
    comp.freebies = Array.from(new Set(shopify.items.filter(x => x.minPrice === 0).map(x => x.title || '免费/赠品').filter(Boolean))).slice(0, 20);
    comp.pricePoints = Array.from(new Set(rawPts.filter(n => n > 0).map(n => Math.round(n)))).sort((a, b) => a - b).slice(0, 40);
    comp.priceVerified = true;
    shopifyEv = addEv(shopify.url, 'shopify', '官网结构化价格数据', `共${shopify.items.length}款，${fmtMoney(Math.min(...rawPts.filter(n => n > 0)), comp.currency)}-${fmtMoney(Math.max(...rawPts.filter(n => n > 0)), comp.currency)}`, anchorDomain);
  }
  logAttempt(comp, 'shopify', comp.url || '(无官网URL)', 'shopify', shopify.ok, shopify.ok ? `Shopify 结构化数据 ${shopify.items.length} 款` : (comp.url ? '未检出 Shopify products.json' : '无官网URL，跳过'));

  // ---- L2 意图分型定向查询（渠道存在性 / 口碑 / 动作），并行 ----
  const probes = {
    etsy: `site:etsy.com/shop "${comp.name}"`,
    tiktokShop: `"${comp.name}" tiktok shop official`,
    amazon: `"${comp.name}" amazon official store`,
    xiaohongshu: `"${comp.name}" 小红书 官方`,
    instagramShop: `"${comp.name}" instagram official`,
    tmallJD: `"${comp.name}" 天猫 OR 京东 官方旗舰店`,
    offlineRetail: `"${comp.name}" 实体店 OR 线下门店 OR 百货`,
    reputation: `"${comp.name}" reviews reddit OR trustpilot complaints`,
    moves: `"${comp.name}" launch OR collab OR restock 2025 2026`
  };
  const probeRaw = {};
  const probeKeys = Object.keys(probes);
  const probeFails = []; // 探测失败的 key（异常/超时，已重试仍失败）
  // 信号量控制并发：复用 CONCURRENCY（原死变量）限制同时发起的搜索数，
  // 避免 9 路并发触发搜索 API 限流/超时导致批量失败（§1 根因）。
  let _pi = 0;
  const probeWorker = async () => {
    while (_pi < probeKeys.length) {
      const k = probeKeys[_pi++];
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) { // 失败重试 1 次
        try {
          probeRaw[k] = (await searchProvider(probes[k], config, gl)).results || [];
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt === 0) await new Promise(r => setTimeout(r, 300)); // 重试前短歇，错峰
        }
      }
      if (lastErr) { probeRaw[k] = null; probeFails.push(k); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, probeKeys.length) }, () => probeWorker()));
  // 记录每个定向探测的执行结果（hit 三态：true 命中 / false 零命中 / null 探测失败）
  probeKeys.forEach(k => {
    const raw = probeRaw[k];
    const hit = raw == null ? null : raw.length > 0;
    const reason = raw == null ? '定向探测失败（搜索异常/超时，已重试1次仍失败）' : (raw.length ? `命中 ${raw.length} 条` : '定向探测执行成功但零命中');
    logAttempt(comp, 'probe.' + k, probes[k], sProvider, hit, reason);
  });
  // 失败可见性：聚合本次探测失败率（不再静默）
  comp.probeHealth = recordProbeHealth(probeFails.length, probeKeys.length) || { failed: probeFails.length, total: probeKeys.length };
  if (probeFails.length) {
    console.warn(`[深研探测] ${comp.name}：定向探测失败 ${probeFails.length}/${probeKeys.length}（${probeFails.join(',')}）—— 渠道/口碑/雷达相关维度将缺证据`);
  }

  // 官方店铺硬标准：店铺 URL 路径或标题本身含品牌名（防止"第三方卖同款的店"被误判为品牌官方店）
  const brandKey = normName(comp.name);
  const isOwnShop = (x) => {
    if (!brandKey) return false;
    try {
      const u = new URL(x.url);
      if (normName(decodeURIComponent(u.pathname)).includes(brandKey)) return true;
    } catch {}
    return normName((x.title || '').split(/[-|–]/)[0]).includes(brandKey);
  };

  // ---- L4 消歧：只保留归属本品牌的结果，入证据库 ----
  const kept = {};
  Object.keys(probeRaw).forEach(k => {
    if (probeRaw[k] == null) { kept[k] = null; return; }
    kept[k] = probeRaw[k].filter(x => belongsToBrand(x, comp.name, anchorDomain));
    kept[k].slice(0, 4).forEach(x => {
      // 渠道探测命中的"店铺页"若非官方店（URL/标题不含品牌名）→ 第三方卖同款，不入证据库
      if (CHANNEL_LINK[k] && CHANNEL_LINK[k].test(x.url || '') && !isOwnShop(x)) return;
      addEv(x.url, k, x.title, x.content, anchorDomain);
    });
  });

  // ---- L5 平台渠道判定：正负证据两套规则，代码裁决 ----
  comp.fieldSources = {};
  const html = officialPage.ok ? officialPage.htmlLower : '';
  const judgeChannel = (chKey) => {
    // 线下零售：非 URL 渠道，靠门店页/检索命中，不能用链接特征判定
    if (chKey === 'offlineRetail') {
      const hits = (kept.offlineRetail || []).filter(x => isOwnShop(x) || /门店|实体店|线下|百货|线下店/i.test((x.title || '') + (x.content || '')));
      if (hits.length) {
        const ev = addEv(hits[0].url, 'offlineRetail', hits[0].title, hits[0].content, anchorDomain);
        if (ev) comp.fieldSources['channels.offlineRetail'] = [{ id: ev.id, url: ev.url, tier: ev.tier, kind: ev.kind, title: ev.title }];
        return { present: true, confidence: 'high', basis: 'verified', note: '检索命中官方线下门店信息', since: null };
      }
      if (html && /门店|实体店|线下|线下店|store locator|线下门店/i.test(html)) {
        if (officialEv) comp.fieldSources['channels.offlineRetail'] = [{ id: officialEv.id, url: officialEv.url, tier: 1, kind: 'official', title: officialEv.title }];
        return { present: true, confidence: 'high', basis: 'verified', note: '官网含门店/实体店信息', since: null };
      }
      if (kept.offlineRetail != null && officialPage.ok) {
        if (officialEv) comp.fieldSources['channels.offlineRetail'] = [{ id: officialEv.id, url: officialEv.url, tier: 1, kind: 'neg-check', title: '定向检索+官网双重核查' }];
        return { present: false, confidence: 'medium', basis: 'verified', note: '检索零命中且官网无门店信息 → 确认缺席', since: null };
      }
      return { present: false, confidence: 'low', basis: 'unverified', note: '未探测到线下布局（搜索失败或官网不可抓）', since: null };
    }
    const pat = CHANNEL_LINK[chKey];
    const hits = (kept[chKey] || []).filter(x => pat && pat.test(x.url || '') && isOwnShop(x));
    if (hits.length) { // 正证据1：定向检索命中官方店铺 URL
      const ev = addEv(hits[0].url, chKey, hits[0].title, hits[0].content, anchorDomain);
      if (ev) comp.fieldSources['channels.' + chKey] = [{ id: ev.id, url: ev.url, tier: ev.tier, kind: ev.kind, title: ev.title }];
      return { present: true, confidence: 'high', basis: 'verified', note: '定向检索命中官方店铺', since: null };
    }
    if (html && pat && pat.test(html)) { // 正证据2：官网页面含该平台入口链接
      if (officialEv) comp.fieldSources['channels.' + chKey] = [{ id: officialEv.id, url: officialEv.url, tier: 1, kind: 'official', title: officialEv.title }];
      return { present: true, confidence: 'high', basis: 'verified', note: '官网页面含该渠道入口链接', since: null };
    }
    // 负证据：定向查询成功执行且零命中 + 官网已抓取且无链接 → 才能标"确认缺席"
    if (kept[chKey] != null && officialPage.ok) {
      if (officialEv) comp.fieldSources['channels.' + chKey] = [{ id: officialEv.id, url: officialEv.url, tier: 1, kind: 'neg-check', title: '定向检索+官网双重核查' }];
      return { present: false, confidence: 'medium', basis: 'verified', note: '定向检索零命中且官网无该渠道入口 → 确认缺席', since: null };
    }
    // 探测失败或官网不可抓 → 只能标"未探测"
    return { present: false, confidence: 'low', basis: 'unverified', note: '定向探测未完成（搜索失败或官网不可抓），不等于确认不做', since: null };
  };
  const codedChannels = {};
  Object.keys(CHANNEL_LINK).forEach(chKey => { codedChannels[chKey] = judgeChannel(chKey); });
  // shopifyDTC：抓到 products.json 即为最强正证据（覆盖上面基于链接特征的推断）
  if (shopify.ok) {
    codedChannels.shopifyDTC = { present: true, confidence: 'high', basis: 'verified', note: 'Shopify 结构化商品数据可直接访问', since: null };
    if (shopifyEv) comp.fieldSources['channels.shopifyDTC'] = [{ id: shopifyEv.id, url: shopifyEv.url, tier: 1, kind: 'shopify', title: shopifyEv.title }];
  }
  // 线下零售：非 URL 渠道，单独裁决
  codedChannels.offlineRetail = judgeChannel('offlineRetail');

  // ---- LLM 只负责"从证据里抽值"，置信度由证据类型推导 ----
  const evText = evidences.length
    ? evidences.map(e => `[${e.id}] (tier${e.tier}·${e.kind}) ${e.title} — ${e.url}\n${e.excerpt}`).join('\n\n')
    : '(本轮未获得任何可用证据)';
  // 平台集收缩：只抽取用户勾选的平台；未被 L2 预填(codedChannels)的才进 LLM schema
  const platforms = resolvePlatforms(state.intent);
  const scopeChannels = CHANNELS.filter(c => platforms.includes(c));
  const codedChannelsKeys = Object.keys(codedChannels || {});
  const restChannels = scopeChannels.filter(c => !codedChannelsKeys.includes(c));
  const sys = `你是"知彼 Vantage"。赛道："${state.track}"。对手："${comp.name}"（官网：${comp.url || '未知'}）。
下面给你一组【已编号证据】。你的任务是从证据中【抽取】字段值；证据不足时可用你的知识【推算】，但推算的字段 cite 必须为空数组（系统据此自动降级置信度）。
铁律：
- cite 数组只能引用真实存在的证据编号（如 "E2"）；严禁编造编号。
- 关键字段不允许留空：无证据也要推算出最可能的值（cite 留空即可）。
- sellingPoints 优先从受控词表多选；若该品牌有词表未覆盖的明显卖点，可补充自由词（英文小驼峰，如 veganFormula），但尽量优先用受控词。tactics 仍从受控词表多选。
- 严格区分两个轴：① 供给轴=品牌做了/宣称什么（sellingPoints/channels/customization/tactics/products）；② 需求轴=用户真实声音（reviews.posThemes/negThemes/painPoints）。机会判断须供需双侧交叉引用，严禁仅用供给矩阵替代需求侧——这是"忠实助理"推理纪律的硬约束。
- 渠道口径（重要）：transaction 渠道（amazon/shopifyDTC/tmallJD/etsy/offlineRetail）以"是否在售/有官方店"为准；content 渠道（如 xiaohongshu 小红书）是种草平台，品牌多无官方店但靠 KOL/笔记/软文做声量——无官方店≠空白，须用 seedingVolume(种草声量) 判断；hybrid 渠道（tiktokShop/instagramShop）两者都要填。本次只研究以下平台：${scopeChannels.join(', ')}。
严格输出 JSON：
{
 "channels": { ${scopeChannels.map(k => {
   const t = channelTypeOf(k);
   let shape;
   if (t === 'content') shape = `{present:bool(有无官方旗舰店/店铺), seedingVolume:"high|medium|low|none"(种草声量:该品牌在${k}上的笔记/测评/软文及KOL数量级), note:"依据一句话", cite:["E#"]}`;
   else if (t === 'hybrid') shape = `{present:bool(官方店/店铺), seedingVolume:"high|medium|low|none"(种草声量), note:"依据一句话", cite:["E#"]}`;
   else shape = `{present:bool, note:"依据一句话", cite:["E#"]}`;
   return `"${k}": ${shape}`;
 }).join(', ')} },
 "priceBand": {band:"${PRICE_BANDS.join('"|"')}", range:"用${comp.currency}原币种书写，如 ${curSym(comp.currency)}20-${curSym(comp.currency)}80。严禁做汇率换算", reasoning:"一句话", cite:[]},
 "pricePoints": [数字，${comp.currency} 原币种，不换算。仅当证据中出现具体标价时才填，否则空数组],
 "audiences": [目标人群自由文本，中英文皆可，如 "年轻妈妈" / "健身人群" / "职场新人"，尽量贴合该品牌实际受众],
 "regions": [∈ ${REGIONS.join(', ')}],
 "products": [该品牌实际经营的品类/产品词，自由文本，中英文皆可，如 "面部精华" / "运动水壶" / "宠物零食"，按赛道抽取，不必受限], // 旧版扁平兜底词（仅当下方结构化字段缺失时前端回退），不再作为矩阵/布局唯一来源
 "productMatrix": {skuCount:数字或null(估算SKU总数), priceBandDist:"价格带分布简述,如 $20-50 为主、少数 $80+", heroSku:["1-2个代表性爆款/主打SKU名"], productLines:["产品线/系列名,如 基础款/联名款/节日限定"]}, // ▶ P2 #4 产品矩阵（纵向深度）：产品线内部结构，与品类布局数据源分离
 "categoryCoverage": [{"category":"市场品类(如 宠物服装)","subCategory":"子品类(如 雨衣)","count":数字或null(该品类下SKU数估算)}], // ▶ P2 #5 品类布局（横向广度）：跨品类覆盖，与产品矩阵数据源分离
 "reviews": {rating:数字或null, trend:"up"|"flat"|"down", posThemes:[], negThemes:[], reasoning:"", cite:[]}, // 需求轴：posThemes/negThemes 必须真实来自用户声音，严禁用品牌自述替代
 "reviewSnippets":[{"platform":"Trustpilot|Reddit|Amazon|Etsy|其他", "rating":数字或null, "sampleSize":数字或null, "url":"该条口碑/评论聚合页的原始链接(必须真实可点，无法确认则填空字符串)", "text":"一句代表性的用户原声(≤80字)", "sentiment":"pos"|"neg"|"neu"}], // ▶ P1 #7：每条带 url；无 url 不入库展示；评分带样本量
 "positioning": {valueProposition:"价值主张(一句话:它说自己是干嘛的)", targetAudience:"目标人群(面向谁)", pricePosition:"价格定位(高/中/低 + 与赛道均值对比,如 中端偏高)", differentiation:"差异化卖点(区别于对手的核心点)", cite:[]}, // ▶ P2 #8 定位战略（结构化·品牌自称 claim；basis=verified 仅当证据 tier-1 实抓）
 "customization": {score:数字(0-100，该品牌产品「可定制/按需定制/个性化」的程度：越高=越按需定制/个性化，越低=越标品化), note:"依据一句话", cite:[]},
 "estSize": {value:"估算规模区间，不留空", cite:[]},
 "tier": "large|mid|small|emerging",
 "techStack": "建站平台/技术栈（可推算）",
 "recentMoves": [{type:"launch"|"channel"|"price"|"collab", desc:"", when:"", cite:[]}],
 "contentForms": [∈ ${CONTENT_FORMS.join(', ')}],
 "collabTypes": [∈ ${COLLAB_TYPES.join(', ')}],
 "fulfillment": [∈ ${FULFILLMENT.join(', ')}],
 "sellingPoints": [该品牌实际主打的卖点，优先从受控词多选；如有明显卖点不在词表中，可补自由词。每项格式 {point:卖点词, basis:"claimed|verified", cite:["E#"]}：claimed=仅营销文案/官网宣称；verified=产品实测/用户证言/第三方评测确认实际具备],
 "tactics": [该品牌实际采用的销售打法，多选。每项格式 {tactic:打法词, demandEvidence:"present|absent|unknown", cite:["E#"]}：demandEvidence=用户是否表达想要该策略/竞品因缺它而流失；无任何需求侧证据时填 unknown],
 "painPoints": [{point:"用户抱怨点(中文短语,尽量通用化表述)", cite:[]}],
 "foundedYear": {year:数字或null(品牌成立年份，可推算，cite留空), cite:[]},
 "growth": {value:"rising|stable|declining|unknown"(基于公开信号推算的增长态势：rising=扩张/上新加速/声量上升；stable=平稳；declining=收缩/关店/声量下滑；unknown=无足够信号), cite:[]},
 "demandAlignments": [{theme:"需求主题(中文短语,来自 reviews.posThemes/negThemes/painPoints 中值得关注的一条)", buckets:[卖点key(从受控词表选: ${SELLING_POINTS.join(', ')}], reason:"一句话依据"}]（第三层语义召回：捕捉字面不匹配但语义相关的需求——如用户说"想要像我家狗那样的熊"→对应 customization；仅列确有语义关联的项；无则空数组）,
 "evidence": "来源摘要1-2句"
}`;
  const user = `【已编号证据】\n${evText}\n\n用户意图：${JSON.stringify(state.intent || {})}。请抽取并填表。`;
  const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'deep-research', competitorId: comp.id });

  // ---- 合并：置信度由 deriveBasis 从引用证据推导，LLM 无权自评 ----
  const citedEvs = (cites) => (Array.isArray(cites) ? cites : []).map(id => evidences.find(e => e.id === id)).filter(Boolean);
  const applyBasis = (obj, cites, fieldName) => {
    const evs = citedEvs(cites);
    const d = deriveBasis(evs);
    obj.basis = evs.length ? d.basis : 'inferred';
    obj.confidence = evs.length ? d.confidence : 'low';
    if (evs.length) comp.fieldSources[fieldName] = evs.map(e => ({ id: e.id, url: e.url, tier: e.tier, kind: e.kind, title: e.title }));
    return obj;
  };
  const fieldConfs = [];
  const ch = {};
  // 只解析用户勾选的平台；content/hybrid 渠道抓取种草声量 seedingVolume
  scopeChannels.forEach(k => {
    if (codedChannels[k]) { ch[k] = codedChannels[k]; fieldConfs.push(codedChannels[k].confidence); return; }
    if (j.channels && j.channels[k]) {
      const cc = j.channels[k];
      const rec = applyBasis({ present: !!cc.present, note: cc.note || '', since: null, seedingVolume: cc.seedingVolume || null }, cc.cite, 'channels.' + k);
      // LLM 推算的"缺席"永远只能是未探测，不能算确认缺席
      if (!rec.present && rec.basis !== 'verified') rec.basis = 'unverified';
      ch[k] = rec;
      fieldConfs.push(rec.confidence);
    }
  });
  comp.channels = ch;

  // ---- 品类布局（横向广度）兜底扁平词：仅当结构化 categoryCoverage 缺失时前端回退 ----
  // 注意：不再 comp.products = comp.categories —— 矩阵(纵向深度)与布局(横向广度)数据源分离（PRD整改 #5）。
  // #311：legacy 兜底数组 c.categories 不再从 j.products 复制——否则与产品矩阵(c.products)同源重复、前端双渲染。
  //        结构化布局以 comp.categoryCoverage 为准；legacy 兜底数组置空，避免数据冗余（同源只留其一）。
  comp.categories = [];

  comp.priceBand = j.priceBand ? applyBasis({ band: j.priceBand.band, range: j.priceBand.range || '', reasoning: j.priceBand.reasoning || '' }, j.priceBand.cite, 'priceBand') : null;
  // Shopify 实价覆盖：价格字段升级为 verified
  if (comp.priceVerified && comp.priceBand && shopifyEv) {
    comp.priceBand.basis = 'verified'; comp.priceBand.confidence = 'high';
    comp.priceBand.range = `${fmtMoney(Math.min(...comp.pricePoints), comp.currency)}-${fmtMoney(Math.max(...comp.pricePoints), comp.currency)}（实抓）`;
    comp.fieldSources.priceBand = [{ id: shopifyEv.id, url: shopifyEv.url, tier: 1, kind: 'shopify', title: shopifyEv.title }];
  } else if (!comp.priceVerified) {
    comp.pricePoints = (Array.isArray(j.pricePoints) ? j.pricePoints : []).filter(n => typeof n === 'number' && n > 0).slice(0, 40);
  }
  if (comp.priceBand) fieldConfs.push(comp.priceBand.confidence);

  // ---- 价格字段「值级交叉验证裁决」接入（护城河本体）----
  comp.priceClaims = [];
  if (comp.priceVerified && shopifyEv && comp.pricePoints.length) {
    comp.priceClaims.push({ tier: 1, kind: 'shopify', value: [Math.min(...comp.pricePoints), Math.max(...comp.pricePoints)], url: shopifyEv.url, text: `实抓 ${comp.pricePoints.length} 款`, points: comp.pricePoints.slice() });
  }
  if (j.priceBand && j.priceBand.range) {
    const pv = parsePriceRange(j.priceBand.range, comp.currency);
    const cited = Array.isArray(j.priceBand.cite) && j.priceBand.cite.length;
    const srcUrl = cited ? ((evidences.find(e => e.id === j.priceBand.cite[0]) || {}).url || null) : null;
    comp.priceClaims.push({ tier: cited ? 2 : 3, kind: cited ? 'llm-band' : 'llm-guess', value: pv, url: srcUrl, text: j.priceBand.range });
  }
  if (!comp.priceVerified && Array.isArray(j.pricePoints)) {
    const pts = j.pricePoints.filter(n => typeof n === 'number' && n > 0);
    if (pts.length) comp.priceClaims.push({ tier: 3, kind: 'llm-guess', value: [Math.min(...pts), Math.max(...pts)], url: null, text: 'LLM 价格点推算' });
  }
  const priceCorr = (state.fieldCorrections || []).filter(c => c.competitorId === comp.id && c.field === 'price');
  comp.priceField = buildPriceField(comp.priceClaims, { currency: comp.currency, corrections: priceCorr });

  // ▶ P0 #2 L2 取证：非 Shopify 站点，官网正文出现标价 → 主动抠出并携 URL（带源可核验）。
  // 仅在 LLM 未给价格点，或官网提取与 LLM 量级不冲突时采用，避免覆盖更可靠的 LLM 结论。
  if (!comp.priceVerified && officialPage && officialPage.ok) {
    try {
      const _fp = PF.extractPrices((officialPage.text || '') + ' ' + (officialPage.htmlLower || ''), comp.currency);
      if (_fp.length) {
        const _pts = PF.toPricePoints(_fp, 40);
        const _llm = (comp.pricePoints || []).filter(n => typeof n === 'number' && n > 0);
        const _use = _llm.length === 0
          || (_pts.length && Math.min.apply(null, _pts) <= Math.max.apply(null, _llm.concat([1])) * 50
                          && Math.max.apply(null, _pts) >= Math.min.apply(null, _llm.concat([1e9])) / 50);
        if (_use) {
          comp.pricePoints = _pts;
          comp.priceClaims.push({ tier: 1, kind: 'official-text', value: [Math.min.apply(null, _pts), Math.max.apply(null, _pts)], url: officialPage.url || comp.url, text: `官网正文提取 ${_pts.length} 个标价`, points: _pts.slice() });
          comp.priceForensic = 'official-text';
        }
        logAttempt(comp, 'priceForensic', officialPage.url || comp.url, 'official', true, `官网正文提取到 ${_fp.length} 个标价候选${_use ? '（已采用）' : '（与 LLM 量级冲突，未采用）'}`);
      } else {
        logAttempt(comp, 'priceForensic', officialPage.url || comp.url, 'official', false, '官网正文未检出明确标价');
      }
    } catch (e) {
      logAttempt(comp, 'priceForensic', officialPage.url || comp.url, 'official', false, '官网正文价格提取异常：' + (e && e.message || e));
    }
  }

  comp.audiences = Array.isArray(j.audiences) ? j.audiences : [];
  comp.regions = Array.isArray(j.regions) ? j.regions : [];
  comp.products = Array.isArray(j.products) ? j.products : [];
  // ▶ P2 #4 产品矩阵（纵向深度）：产品线内部结构（SKU 数 / 价格带分布 / 爆款 / 产品线），与品类布局数据源分离。
  const pm = (j.productMatrix && typeof j.productMatrix === 'object') ? j.productMatrix : null;
  comp.productMatrix = pm ? {
    skuCount: (typeof pm.skuCount === 'number' && pm.skuCount > 0) ? Math.round(pm.skuCount) : null,
    priceBandDist: String(pm.priceBandDist || '').slice(0, 200),
    heroSku: Array.isArray(pm.heroSku) ? pm.heroSku.map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 6) : [],
    productLines: Array.isArray(pm.productLines) ? pm.productLines.map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 12) : []
  } : null;
  // ▶ P2 #5 品类布局（横向广度）：跨品类覆盖；与产品矩阵数据源分离（PRD整改 #5）。
  comp.categoryCoverage = Array.isArray(j.categoryCoverage) ? j.categoryCoverage
    .map(x => ({ category: String(x.category || '').trim().slice(0, 60), subCategory: String(x.subCategory || '').trim().slice(0, 60), count: (typeof x.count === 'number' && x.count > 0) ? Math.round(x.count) : null }))
    .filter(x => x.category).slice(0, 16) : [];
  comp.reviews = j.reviews ? applyBasis({ rating: j.reviews.rating != null ? j.reviews.rating : null, trend: j.reviews.trend || 'flat', posThemes: j.reviews.posThemes || [], negThemes: j.reviews.negThemes || [], reasoning: j.reviews.reasoning || '' }, j.reviews.cite, 'reviews') : null;
  if (comp.reviews) fieldConfs.push(comp.reviews.confidence);
  // ▶ P1 #7：口碑 snippets——每条带 url；无 url 不入库展示（评分带样本量）
  comp.reviewSnippets = Array.isArray(j.reviewSnippets) ? j.reviewSnippets
    .map(s => ({
      platform: String(s.platform || '其他').slice(0, 40),
      rating: (s.rating != null && Number(s.rating) >= 0 && Number(s.rating) <= 5) ? Number(s.rating) : null,
      sampleSize: (s.sampleSize != null && Number(s.sampleSize) > 0) ? Number(s.sampleSize) : null,
      url: (s.url && /^https?:\/\//i.test(String(s.url))) ? String(s.url).slice(0, 500) : '',
      text: String(s.text || '').slice(0, 200),
      sentiment: ['pos', 'neg', 'neu'].includes(s.sentiment) ? s.sentiment : 'neu'
    }))
    .filter(s => s.url) // ▶ 无 url 不展示（信任红线：不可核验不呈现）
    : [];

  // ▶ P2 #8 定位战略（结构化）：价值主张 / 目标人群 / 价格定位 / 差异化卖点（品牌自称 claim）。
  // 两级视觉：basis='verified' → 官网实测（实测层）；否则归一为 'claimed' → 品牌自称（自述层）。
  const posObj = (j.positioning && typeof j.positioning === 'object') ? j.positioning : { valueProposition: j.positioning || '', cite: [] };
  const posB = applyBasis({ v: 1 }, posObj.cite, 'positioning');
  comp.positioning = {
    valueProposition: String(posObj.valueProposition || posObj.value || '').slice(0, 400),
    targetAudience: String(posObj.targetAudience || '').slice(0, 200),
    pricePosition: String(posObj.pricePosition || '').slice(0, 200),
    differentiation: String(posObj.differentiation || '').slice(0, 300)
  };
  comp.positioningBasis = (posB.basis === 'verified') ? 'verified' : 'claimed';

  // 定制化程度（0-100）：象限图 Y 轴来源，必须可溯源（applyBasis 由 cite 推导 basis + 写 fieldSources）
  const custNorm = normalizeCustomization(j.customization);
  if (custNorm) {
    const cB = applyBasis({ v: 1 }, (j.customization && j.customization.cite) || [], 'customization');
    comp.customization = { score: custNorm.score, note: custNorm.note, basis: cB.basis, confidence: cB.confidence };
  }

  const sizeObj = j.estSize && typeof j.estSize === 'object' ? j.estSize : { value: j.estSize || '', cite: [] };
  const sizeB = applyBasis({ v: 1 }, sizeObj.cite, 'estSize');
  comp.estSize = sizeObj.value || '';
  comp.estSizeBasis = sizeB.basis;

  if (j.tier) comp.tier = j.tier;
  comp.techStack = shopify.ok ? 'Shopify（实抓确认）' : (j.techStack || null);
  comp.recentMoves = (Array.isArray(j.recentMoves) ? j.recentMoves : []).map((m, i) => {
    const b = applyBasis({ type: m.type, desc: m.desc, when: m.when }, m.cite, 'recentMoves.' + i);
    return b;
  });
  comp.contentForms = Array.isArray(j.contentForms) ? j.contentForms : [];
  comp.collabTypes = Array.isArray(j.collabTypes) ? j.collabTypes : [];
  comp.fulfillment = Array.isArray(j.fulfillment) ? j.fulfillment : [];
  // 卖点（混合：受控词 + 自由词），每项带 basis（claimed/verified）；兼容旧字符串数组。副字段供 inference-guard 做"宣称=能力"降级。
  const _sp = parseGradedList(j.sellingPoints, null);
  comp.sellingPoints = _sp.points;
  comp.sellingPointBasis = _sp.meta;
  // 打法（受控词），每项带 demandEvidence（present/absent/unknown）；兼容旧字符串数组。副字段供 inference-guard 做"策略空白=想要"降级。
  const _tac = parseGradedList(j.tactics, TACTICS);
  comp.tactics = _tac.points;
  comp.tacticDemand = _tac.meta;
  comp.painPoints = (Array.isArray(j.painPoints) ? j.painPoints : []).map((p, i) => {
    const obj = typeof p === 'object' ? p : { point: String(p), cite: [] };
    const b = applyBasis({ point: obj.point || '' }, obj.cite, 'painPoints.' + i);
    return b;
  }).filter(p => p.point);
  // 优化三：时间趋势维度（foundedYear / growth）——fail-safe：缺则 unknown / null
  const fy = (j.foundedYear && typeof j.foundedYear === 'object') ? j.foundedYear
    : (typeof j.foundedYear === 'number' ? { year: j.foundedYear, cite: [] } : { year: null, cite: [] });
  comp.foundedYear = (typeof fy.year === 'number') ? fy.year : null;
  comp.foundedYearBasis = applyBasis({ v: 1 }, fy.cite || [], 'foundedYear').basis;
  const gr = (j.growth && typeof j.growth === 'object') ? j.growth
    : { value: (typeof j.growth === 'string' && GROWTH_VALUES.includes(j.growth)) ? j.growth : 'unknown', cite: [] };
  comp.growth = GROWTH_VALUES.includes(gr.value) ? gr.value : 'unknown';
  comp.growthBasis = applyBasis({ v: 1 }, gr.cite || [], 'growth').basis;
  // 优化五：LLM 语义召回层（第三层）——解析受控词过滤后的 demandAlignments
  comp.demandAlignments = Guard.parseDemandAlignments(j.demandAlignments, SELLING_POINTS);
  // 推算字段清单（自动生成，替代 LLM 自报）
  comp.inferred = [];
  if (comp.priceBand && comp.priceBand.basis !== 'verified') comp.inferred.push('价格带');
  if (comp.reviews && comp.reviews.basis !== 'verified') comp.inferred.push('口碑');
  if (comp.estSizeBasis !== 'verified') comp.inferred.push('估算规模');
  if (comp.positioningBasis !== 'verified') comp.inferred.push('定位');
  if (comp.customization && comp.customization.basis !== 'verified') comp.inferred.push('定制化程度');
  comp.evidence = j.evidence || '';
  comp.evidenceList = evidences; // 全量证据留档（前端可点开核验）
  // ▶ 数据卫生③：离谱值 sanity——量级声称与营收口径/微品牌自述矛盾 → flaggedOutlier 降级
  try {
    const sane = Sizing.sanityScaleVsTier(comp.tier, comp.estSize);
    if (sane && sane.flagged) { comp.flaggedOutlier = true; comp.outlierNote = sane.note || '量级离谱，已降级'; }
  } catch (e) { /* 不阻断主链路 */ }
  const _sc = scoreConfidence(Math.max(comp.evidenceCount || 0, evidences.length), fieldConfs);
  comp.confidence = comp.flaggedOutlier ? 'low' : (_sc >= 70 ? 'high' : (_sc >= 45 ? 'medium' : 'low'));
  // ▶ PRD整改 §1.3：分析层判断类型（分层/估算/趋势）注册进校准体系——
  // 每条推断产生一张计算层校准样本（带 id），后续由人工抽检标注（分层/估算）或事件回看（趋势）走三判。
  try {
    if (comp.tier) M.recordComputationJudgment({ judgmentType: 'tier', subjectId: comp.id, predicted: comp.tier, confidence: comp.confidence || 'medium', source: 'research' });
    if (comp.estSize) M.recordComputationJudgment({ judgmentType: 'scale', subjectId: comp.id, predicted: String(comp.estSize), confidence: comp.estSizeBasis || 'inferred', source: 'research' });
    if (comp.growth && comp.growth !== 'unknown') M.recordComputationJudgment({ judgmentType: 'trend', subjectId: comp.id, predicted: comp.growth, confidence: comp.growthBasis || 'inferred', source: 'research' });
  } catch (e) { /* 校准落地失败不阻断主链路 */ }

  // ---- #304 字段撕裂交叉校验（discover 归类推测 vs enrich 官网实抓事实）----
  try { crossValidateTearing(comp, state.track); } catch (e) { /* 不阻断主链路 */ }
  try { enforceBasisEvidence(comp); } catch (e) { /* 不阻断主链路 */ }

  comp.status = 'done';
}

// 用户直接指定品牌检索（绕过赛道发现，单独深研）
async function lookupBrand(name, url, config, bodyIntent) {
  let s = loadState();
  if (!s || !s.track) {
    const tk = '指定品牌 · ' + name;
    s = { projectId: newProjectId(tk), track: tk, intent: {}, competitors: [], discoveredAt: new Date().toISOString(), progress: { total: 0, done: 0 }, excluded: [], excludedReasons: {}, suppressed: [], addedCompetitors: [], ruleDecisions: {}, signals: {}, whiteSpace: null, brief: null };
    s.tenantId = resolveTenantId(); // 绑定租户（P0-2.1）
    setCurrentId(s.projectId, s.tenantId);
    mirrorProjectToDb(s.projectId, requestScope.getStore() || s.tenantId, s.track); // T3-1：镜像进 db 项目清单
  } else if (!s.tenantId) {
    s.tenantId = resolveTenantId(); // 既有档案补打租户标（升级后首次访问）
  }
  // 合并用户定位（含 profile）；与已有 intent 合并，归一化保证口径一致
  s.intent = Object.assign({}, normalizeIntent(s.intent), normalizeIntent(bodyIntent || {}));
  // 平台集接管：显式勾选优先，否则由地域推导
  s.intent = s.intent || {};
  s.intent.platforms = resolvePlatforms({ platforms: (bodyIntent && bodyIntent.platforms) || s.intent.platforms, regions: s.intent.regions });
  const id = slug(name, s.competitors.length + 1);
  if (s.competitors.some(c => c.id === id)) {
    const ex = s.competitors.find(c => c.id === id);
    ex.manual = true;
    // ▶ 数据卫生②：既有品牌若命中自有品牌，也确保排除（用户手动补录自家品牌时）
    if (autoExcludeOwnBrands([ex], (config && config.ownBrands) || []).excluded.length) {
      if (!s.excluded.includes(ex.id)) s.excluded.push(ex.id);
      s.excludedReasons[ex.id] = 'own-brand';
    }
    s.whiteSpace = computeWhiteSpace(s);
    return s;
  }
  const comp = {
    id, name, url: url || '', why: '用户指定检索', tier: 'unknown', manual: true,
    matchScore: 90, evidenceCount: url ? 1 : 0, confidence: 'low', rankScore: 90,
    status: 'researching',
    channels: {}, priceBand: null, pricePoints: [], freebies: [], audiences: [], regions: [],
    products: [], reviews: null, positioning: '', customization: null, estSize: null, techStack: null,
    recentMoves: [], contentForms: [], collabTypes: [], fulfillment: [],
    sellingPoints: [], tactics: [], painPoints: [], fieldSources: {},
    attempts: [],
    inferred: [], timeline: null, reviewSnippets: [], priceForensic: null, foundedYear: null, growth: 'unknown', demandAlignments: [], evidence: '', researchedAt: null
  };
  s.competitors.push(comp);
  // ▶ 数据卫生②：手动补录时也排除自有品牌（名字或域名命中 config.ownBrands）
  if (autoExcludeOwnBrands([comp], (config && config.ownBrands) || []).excluded.length) {
    if (!s.excluded.includes(comp.id)) s.excluded.push(comp.id);
    s.excludedReasons[comp.id] = 'own-brand';
  }
  s.progress = { total: s.competitors.length, done: s.competitors.filter(c => c.status === 'done').length };
  saveState(s);
  try { await deepResearchOne(comp, s, config); }
  catch (e) { comp.status = 'error'; comp.evidence = '检索失败：' + String(e.message || e); }
  finally { saveState(s); }
  s.whiteSpace = computeWhiteSpace(s);
  return s;
}

// 时间线深度检索：按时间梳理该品牌在做什么 + 战略/战术转变
async function deepTimelineOne(comp, state, config) {
  const dsKey = config.llm.apiKey;
  const sys = `你是"知彼 Vantage"。请基于公开信息，按【时间线】梳理竞争对手"${comp.name}"（官网：${comp.url || '未知'}）在做什么，以及战略(strategy)与战术(tactic)层面的转变。
严格输出 JSON：
{
 "events": [ { "period": "2022下半年"或"2023", "title": "短句动作名", "level": "strategy"|"tactic", "desc": "做了什么/怎么做的", "evidence": "来源或推算依据" } ],
 "summary": "一句话总括该品牌演进主线",
 "shifts": "战略/战术上的关键转折与当下重心（2-3句）"
}
要求：
- 按时间由早到晚；period 用可识别的时间段。
- level 区分：strategy=方向性/定位性决策（如切入新品类、品牌升级）；tactic=具体执行动作（如某渠道投放、某联名）。
- 若某时期无公开信息，基于可得信号【推算】并标 evidence 为"推算"。
- 不要多余文字，直接输出 JSON。`;
  const user = `品牌：${comp.name}（${comp.url || ''}）。赛道：${state.track}。已知：定位=${comp.positioning || '未知'}；渠道=${Object.keys(comp.channels || {}).filter(k => comp.channels[k].present).join('/') || '未知'}；近期动作=${(comp.recentMoves || []).map(m => m.desc).join('；') || '未知'}。请按时间线梳理其战略与战术演进。`;
  const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'timeline', competitorId: comp.id });
  const tl = {
    generatedAt: new Date().toISOString(),
    events: Array.isArray(j.events) ? j.events : [],
    summary: j.summary || '',
    shifts: j.shifts || ''
  };
  comp.timeline = tl;
  comp.researchedAt = new Date().toISOString();
  saveState(state);
  return tl;
}

// 点卡优先调研（P0-1 修复：操作本项目队列，不污染其他项目）
function enrichOne(id, state, config) {
  const comp = state.competitors.find(c => c.id === id);
  if (!comp) return false;
  // 提到队列最前（priority 最高）
  const q = getQ(state.projectId);
  q.queue = q.queue.filter(j => j.id !== id);
  q.queue.unshift({ id, priority: 3 });
  // 模块 0-4：同步落表（priority 3 优先被认领）
  try {
    Tasks.enqueue({ tenantId: state.tenantId, projectId: state.projectId, type: 'deep-research', payload: { competitorId: id }, priority: 3 });
  } catch (e) { /* 非致命 */ }
  ensureQueue(state, config);
  return true;
}

// ============================================================
// L2 单模块 / 单字段深挖（点击"未探测·点此深挖"触发）
//   忠实助理纪律：① 不重跑全卡 ② 每条结果必须带可追溯来源 URL
//   ③ LLM 提取的标 basis=inferred（非 verified）④ 无 Key 时如实标 attempted_empty，绝不编造
// ============================================================
const L2_PLAN = {
  price:         { mode: 'llm', q: n => `"${n}" price OR pricing OR cost shop`, ask: '该品牌的价格带/价格区间（保持原币种，禁止换算）；可给价格点数组 pricePoints 与价格带 priceBand{band,range}。若无法确定返回空。' },
  sellingPoints: { mode: 'llm-vocab', vocab: 'SELLING_POINTS', q: n => `"${n}" brand selling points features benefits`, ask: '该品牌的主打卖点，只能从给定词表选。输出对象数组，每项 {point:卖点词(受控词优先，可补自由词), basis:"claimed|verified", cite:["E#"]}：claimed=营销文案/官网宣称；verified=产品实测/用户证言/第三方评测确认实际具备。' },
  positioning:   { mode: 'llm', q: n => `"${n}" brand positioning tagline about us`, ask: '用一句话(<=200字)概括该品牌的定位语调，输出 positioning 字段。' },
  customization: { mode: 'llm', q: n => `"${n}" customizable made-to-order personalized product options bespoke`, ask: '该品牌产品的可定制/按需定制程度，输出 customization 对象 {score:0-100, note:"依据一句话", cite:[]}。score 越高代表越按需定制/个性化，越低越标品化。' },
  products:      { mode: 'llm', q: n => `"${n}" product collection lineup items`, ask: '列举该品牌的产品矩阵（产品线/系列名称），输出 products 字符串数组。' },
  audiences:     { mode: 'llm-vocab', vocab: 'AUDIENCES', q: n => `"${n}" target customer audience who buys`, ask: '该品牌的目标人群，只能从给定词表选，输出 items 数组。' },
  channels:      { mode: 'rule-channels', q: n => `"${n}" official instagram OR tiktok OR youtube OR shopify OR etsy OR amazon` },
  reviews:       { mode: 'llm', q: n => `"${n}" reviews rating complaints feedback`, ask: '提取口碑：rating(数字或null)、trend(up/down/stable)、posThemes[]、negThemes[]，包进 reviews 对象。' },
  painPoints:    { mode: 'llm', q: n => `"${n}" complaints problems reddit disappointed`, ask: '提取用户抱怨点（具体痛点），输出 painPoints 字符串数组。' },
  tactics:       { mode: 'llm-vocab', vocab: 'TACTICS', q: n => `"${n}" promotion marketing tactic discount`, ask: '该品牌的销售打法，只能从给定词表选。输出对象数组，每项 {tactic:打法词, demandEvidence:"present|absent|unknown", cite:["E#"]}：demandEvidence=用户是否表达想要该策略/竞品因缺它流失；无证据填 unknown。' },
  contentForms:  { mode: 'llm-vocab', vocab: 'CONTENT_FORMS', q: n => `"${n}" content marketing form video livestream`, ask: '该品牌的内容形态，只能从给定词表选，输出 items 数组。' },
  collabTypes:   { mode: 'llm-vocab', vocab: 'COLLAB_TYPES', q: n => `"${n}" collaboration IP联名 artist brand`, ask: '该品牌的联名方式，只能从给定词表选，输出 items 数组。' },
  fulfillment:   { mode: 'llm-vocab', vocab: 'FULFILLMENT', q: n => `"${n}" shipping fulfillment made to order`, ask: '该品牌的履约方式，只能从给定词表选，输出 items 数组。' },
  recentMoves:   { mode: 'llm', q: n => `"${n}" news launch partnership 2024 OR 2025`, ask: '提取近期动作，输出 recentMoves 数组（每项 {type,desc,when}）。' },
  estSize:       { mode: 'llm', q: n => `"${n}" company size revenue employees founded`, ask: '估算该品牌规模（员工/营收量级/是否融资），输出 estSize 字符串。' },
  techStack:     { mode: 'rule-techstack', q: n => `"${n}" powered by shopify wordpress magento` },
};
const L2_MODULE_FIELDS = {
  pricing: ['price'],
  positioning: ['sellingPoints', 'positioning', 'customization'],
  products: ['products', 'audiences'],
  channels: ['channels'],
  reviews: ['reviews', 'painPoints'],
  marketing: ['tactics', 'contentForms', 'collabTypes', 'fulfillment', 'recentMoves', 'estSize', 'techStack'],
};
function sanitizeVocab(arr, vocab) {
  if (!Array.isArray(arr)) return [];
  const clean = Array.from(new Set(arr.map(x => String(x).trim()).filter(Boolean)));
  if (!vocab || !vocab.length) return clean.slice(0, 12); // 自由文本模式（品类/人群）：不约束词表
  return clean.filter(x => vocab.includes(x)).slice(0, 12);
}
// 解析"分级列表"：兼容 字符串[]（旧格式）与 {point|tactic, basis|demandEvidence, cite}[]（供需分级格式）。
// vocab=null 表示混合模式（放行自由词）；否则按受控词过滤。返回 {points, meta}。
// 这是"情报推理纪律 v2：供需不混淆"的解析落点——basis/demandEvidence 在此落地到 comp 副字段，供 inference-guard 使用。
function parseGradedList(raw, vocab) {
  const arr = Array.isArray(raw) ? raw : [];
  const points = [];
  const meta = {};
  arr.forEach(x => {
    if (typeof x === 'string') { points.push(x); return; }
    if (x && typeof x === 'object') {
      const k = x.point || x.tactic;
      if (!k) return;
      points.push(k);
      if (x.basis) meta[k] = x.basis;                              // claimed | verified
      if (x.demandEvidence) meta[k + '::demand'] = x.demandEvidence; // present | absent | unknown
    }
  });
  const filtered = vocab ? points.filter(p => vocab.includes(p)) : points.slice(0, 12);
  const cleanMeta = {};
  filtered.forEach(p => {
    if (meta[p]) cleanMeta[p] = meta[p];
    if (meta[p + '::demand']) cleanMeta[p + '::demand'] = meta[p + '::demand'];
  });
  return { points: filtered, meta: cleanMeta };
}
const L2_TECH_PATTERNS = [
  [/shopify/, 'Shopify'], [/wordpress/, 'WordPress'], [/magento/, 'Magento'],
  [/squarespace/, 'Squarespace'], [/bigcommerce/, 'BigCommerce'],
  [/(shoplazza|店匠)/, 'Shoplazza(店匠)'], [/(shopyy|2cshop|ueeshop|shoplazza)/, '独立站SaaS'],
  [/(woocommerce)/, 'WooCommerce'], [/(sapo|haravan)/, 'Sapo/Haravan']
];
function applyL2Result(comp, fieldKey, j, srcs) {
  comp.fieldSources = comp.fieldSources || {};
  const setSrc = () => { comp.fieldSources[fieldKey] = srcs; };
  switch (fieldKey) {
    case 'price': {
      // ▶ 报告-数据同源 §5：merge 路径同样前置过滤 $0，免费品不污染价格点
      const pts = Array.isArray(j.pricePoints) ? j.pricePoints.map(Number).filter(n => !isNaN(n) && n > 0) : [];
      if (pts.length) { comp.pricePoints = Array.from(new Set(pts.map(n => Math.round(n)))).sort((a, b) => a - b).slice(0, 40); comp.priceVerified = false; }
      if (j.priceBand && j.priceBand.band) comp.priceBand = { band: j.priceBand.band, range: j.priceBand.range || '', confidence: 'medium', basis: 'inferred' };
      setSrc(); break;
    }
    case 'sellingPoints': { const p = parseGradedList(j.items || j.sellingPoints || [], null); comp.sellingPoints = p.points; comp.sellingPointBasis = p.meta; setSrc(); break; } // 混合：分级列表兼容对象/字符串
    case 'positioning': {
      const p = j.positioning;
      if (p) {
        // 兼容旧字符串与结构化对象；纠正入口提交的是"品牌自称"，basis 归一为 claimed（PRD整改 #4：自述层）
        const o = (typeof p === 'object' && p) ? p : { valueProposition: String(p) };
        comp.positioning = {
          valueProposition: String(o.valueProposition || o.value || '').slice(0, 400),
          targetAudience: String(o.targetAudience || '').slice(0, 200),
          pricePosition: String(o.pricePosition || '').slice(0, 200),
          differentiation: String(o.differentiation || '').slice(0, 300)
        };
        comp.positioningBasis = 'claimed';
      }
      setSrc(); break;
    }
    case 'customization': {
      const norm = normalizeCustomization(j.customization || j);
      if (norm) comp.customization = { score: norm.score, note: norm.note, basis: 'inferred', confidence: 'medium' };
      setSrc(); break;
    }
    case 'products': comp.products = Array.isArray(j.products) ? j.products.map(String).filter(Boolean).slice(0, 20) : (comp.products || []); setSrc(); break;
    case 'audiences': comp.audiences = sanitizeVocab(j.items || j.audiences || [], AUDIENCES); setSrc(); break;
    case 'reviews': {
      const rv = j.reviews || j;
      comp.reviews = {
        rating: rv.rating != null ? Number(rv.rating) : null,
        trend: ['up', 'down', 'stable'].includes(rv.trend) ? rv.trend : null,
        posThemes: Array.isArray(rv.posThemes) ? rv.posThemes : [],
        negThemes: Array.isArray(rv.negThemes) ? rv.negThemes : [],
        basis: 'inferred'
      };
      setSrc(); break;
    }
    case 'painPoints': comp.painPoints = Array.isArray(j.painPoints) ? j.painPoints.slice(0, 10).map(p => ({ point: String(p).slice(0, 120), basis: 'inferred' })) : (comp.painPoints || []); setSrc(); break;
    case 'tactics': { const p = parseGradedList(j.items || j.tactics || [], TACTICS); comp.tactics = p.points; comp.tacticDemand = p.meta; setSrc(); break; }
    case 'contentForms': comp.contentForms = sanitizeVocab(j.items || j.contentForms || [], CONTENT_FORMS); setSrc(); break;
    case 'collabTypes': comp.collabTypes = sanitizeVocab(j.items || j.collabTypes || [], COLLAB_TYPES); setSrc(); break;
    case 'fulfillment': comp.fulfillment = sanitizeVocab(j.items || j.fulfillment || [], FULFILLMENT); setSrc(); break;
    case 'recentMoves': comp.recentMoves = Array.isArray(j.recentMoves) ? j.recentMoves.slice(0, 8).map(m => ({ type: String(m.type || '其他'), desc: String(m.desc || '').slice(0, 160), when: m.when || null, basis: 'inferred' })) : (comp.recentMoves || []); setSrc(); break;
    case 'estSize': if (j.estSize) { comp.estSize = String(j.estSize).slice(0, 160); comp.estSizeBasis = 'inferred'; } setSrc(); break;
  }
}
// 单字段 L2 深挖；返回 { ok, reason }
async function deepDiveField(state, comp, fieldKey, config) {
  const plan = L2_PLAN[fieldKey];
  if (!plan) { logAttempt(comp, fieldKey, '', 'l2', false, '无对应深挖计划'); return { ok: false, reason: 'unknown_field' }; }
  const gl = glFromRegions(state.intent && state.intent.regions);
  const sProv = (config.search && config.search.provider) || 'search';
  const query = plan.q(comp.name);
  let results = [];
  try { results = (await searchProvider(query, config, gl)).results || []; }
  catch (e) { logAttempt(comp, fieldKey, query, sProv, null, '检索失败：' + String(e.message || e)); return { ok: false, reason: 'search_failed' }; }
  const srcs = results.slice(0, 5).filter(x => /^https?:/i.test(x.url || '')).map(x => ({ url: x.url, title: x.title, tier: sourceTier(x.url, domainOf(comp.url)), kind: 'l2-' + fieldKey, excerpt: String(x.content || '').slice(0, 200) }));
  const anchor = domainOf(comp.url);

  if (plan.mode === 'rule-channels') {
    const ptns = {
      tiktokShop: /tiktok\.com\/@[\w.\-]+/i, amazon: /amazon\.[a-z.]+\/(stores?|shops)\/[\w.\-]+/i,
      shopifyDTC: /(^|\.)myshopify\.com|\/store\/|shop\.[\w.-]+\.(com|co|shop)/i, xiaohongshu: /xiaohongshu\.com\/user\/profile/i,
      instagramShop: /instagram\.com\/[\w.\-]+/i, etsy: /etsy\.com\/shop\/[\w.\-]+/i,
      offlineRetail: /(store locator|实体店|线下门店|retail store|flagship store)/i, tmallJD: /(tmall\.com|jd\.com\/[\w.\-]+)/i
    };
    const found = {};
    const plat = (state.intent && state.intent.platforms);
    const scopedChannels = (plat && plat.length) ? plat : CHANNELS; // 只探用户勾选的平台，省 Serper 也避免越界噪声
    results.forEach(x => { for (const k of scopedChannels) { const p = ptns[k]; if (p && p.test(x.url || '') && belongsToBrand(x, comp.name, anchor)) found[k] = true; } });
    if (Object.keys(found).length) {
      comp.channels = comp.channels || {};
      Object.keys(found).forEach(k => { comp.channels[k] = { present: true, confidence: 'medium', basis: 'inferred', note: 'L2 定向检索命中平台页', since: null }; });
      comp.fieldSources = comp.fieldSources || {};
      comp.fieldSources['channels'] = srcs;
      logAttempt(comp, 'channels', query, sProv, true, '命中 ' + Object.keys(found).join('/'));
      saveState(state);
      return { ok: true };
    }
    logAttempt(comp, 'channels', query, sProv, false, '定向检索未命中官方平台页');
    saveState(state);
    return { ok: false, reason: 'no_hit' };
  }
  if (plan.mode === 'rule-techstack') {
    const lower = results.map(x => (x.url + ' ' + x.title + ' ' + x.content)).join(' ').toLowerCase();
    let tech = '';
    for (const [p, name] of L2_TECH_PATTERNS) if (p.test(lower)) tech += name + '; ';
    if (tech) {
      comp.techStack = tech.trim().replace(/;$/, '');
      comp.techStackBasis = 'inferred';
      comp.fieldSources = comp.fieldSources || {};
      comp.fieldSources['techStack'] = srcs;
      logAttempt(comp, 'techStack', query, sProv, true, tech);
      saveState(state);
      return { ok: true };
    }
    logAttempt(comp, 'techStack', query, sProv, false, '未识别到建站技术栈');
    saveState(state);
    return { ok: false, reason: 'no_hit' };
  }

  // LLM 提取（rule 之外的所有字段）
  const dsKey = config.llm && config.llm.apiKey;
  if (!dsKey) { logAttempt(comp, fieldKey, query, sProv, false, '需 LLM 解析，但未配置 Key'); saveState(state); return { ok: false, reason: 'no_llm_key' }; }
  let vocabText = '';
  if (plan.mode === 'llm-vocab') {
    const arr = plan.vocab === 'SELLING_POINTS' ? SELLING_POINTS : plan.vocab === 'TACTICS' ? TACTICS : plan.vocab === 'CONTENT_FORMS' ? CONTENT_FORMS : plan.vocab === 'COLLAB_TYPES' ? COLLAB_TYPES : plan.vocab === 'FULFILLMENT' ? FULFILLMENT : plan.vocab === 'AUDIENCES' ? AUDIENCES : [];
    vocabText = '\n只允许从以下词表选（输出 key 数组）：[' + arr.join(', ') + ']。不要自造词。';
  }
  const snippetText = results.slice(0, 6).map((x, i) => `【${i + 1}】${x.title || ''}\n${x.content || ''}`).join('\n---\n');
  const sys = `你是"知彼 Vantage"。只基于下面给出的检索片段，提取关于品牌"${comp.name}"的"${plan.ask}"。
严格输出 JSON。若片段不足以判断，返回空值（不要编造）。${vocabText}
禁止汇率换算，保持原币种。`;
  const user = `检索片段：\n${snippetText}\n\n赛道背景：${state.track}。请输出 JSON。`;
  let j;
  try { j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, config.llm.model, { fieldKey, competitorId: comp.id }); }
  catch (e) { logAttempt(comp, fieldKey, query, 'llm', false, 'LLM 解析失败：' + String(e.message || e)); saveState(state); return { ok: false, reason: 'llm_error' }; }
  applyL2Result(comp, fieldKey, j || {}, srcs);
  // 忠实助理：LLM 解析成功但无有效数据 → 记 hit=false（显示"已查未得"），不留空白间隙
  const got = fieldHasDataOnServer(comp, fieldKey);
  logAttempt(comp, fieldKey, query, 'llm', got, got ? 'L2 深挖命中' : 'L2 检索后无有效数据');
  saveState(state);
  return { ok: got, reason: got ? 'ok' : 'no_data' };
}

// ============================================================
// 步骤3b：定位校准引擎（#55）—— 以「用户填写的价格段 / 卖点」为原点，
// 反推"你选的方向里对手已占(红海) vs 对手没做(空白可占)"，并敢挑战用户假设。
// 这是忠实助理最锋利也最容易得罪人的部分：不顺着用户说，只给参照事实。
// 纯事实计算，不调 LLM（挑战信号由计数推导，避免编造）。
// ============================================================
// 定制化程度归一化：LLM 可能返回 {score,note,cite} 或纯数字；统一夹到 0-100，缺失返回 null。
// 该字段用于定位象限图 Y 轴（替代体量/梯队），必须可溯源（basis + 来源），缺失时前端回退体量。
function normalizeCustomization(jc) {
  if (jc == null) return null;
  let score, note = '';
  if (typeof jc === 'number') { score = jc; }
  else if (typeof jc === 'object') { score = jc.score; note = jc.note || ''; }
  else return null;
  const n = Number(score);
  if (isNaN(n)) return null;
  return { score: Math.max(0, Math.min(100, Math.round(n))), note: String(note).slice(0, 200) };
}

function assessPositioning(state) {
  const prof = (state.intent && state.intent.profile) || null;
  const excluded = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) excluded.add(c.id); }); // #305 错配/低置信卡一并剔除
  const comps = state.competitors.filter(c => c.status === 'done' && !excluded.has(c.id));
  const MKT_CUR = marketCurrency(state.intent && state.intent.regions);
  const out = { hasProfile: !!prof, price: null, sellingPoints: null, challenges: [] };

  // 价格段原点：只有与用户同币种的对手才进同一张比较（跨币种不换算，铁律）
  if (prof && prof.priceBand && prof.priceBand.min != null && prof.priceBand.max != null) {
    const cur = prof.priceBand.currency || MKT_CUR;
    const lo = +prof.priceBand.min, hi = +prof.priceBand.max;
    let overlap = 0; const names = [];
    comps.forEach(c => {
      const cCur = c.currency || MKT_CUR;
      if (cCur !== cur) return;
      const pts = (c.pricePoints || []).filter(n => typeof n === 'number' && n > 0);
      const range = c.priceBand && c.priceBand.range;
      let hit = false;
      if (pts.length) hit = pts.some(p => p >= lo && p <= hi);
      else if (range) { const m = String(range).match(/(\d+)\D+(\d+)/); if (m) { const a = +m[1], b = +m[2]; hit = hi > a && lo < b; } }
      if (hit) { overlap++; names.push(c.name); }
    });
    out.price = { band: { min: lo, max: hi, currency: cur }, contestedBy: overlap, contestedNames: names.slice(0, 6) };
    if (overlap >= 3) out.challenges.push({ type: 'price_crowded', text: `你定的 ${cur} ${fmtMoney(lo, cur)}–${fmtMoney(hi, cur)} 价格段已被 ${overlap} 家对手占据，属红海——要么找差异点，要么看相邻空档。` });
    else if (overlap === 0) out.challenges.push({ type: 'price_open', text: `你定的 ${cur} ${fmtMoney(lo, cur)}–${fmtMoney(hi, cur)} 价格段目前无人直接占据，是可守的空档（但仍看产品力）。` });
    else out.challenges.push({ type: 'price_partial', text: `你定的 ${cur} ${fmtMoney(lo, cur)}–${fmtMoney(hi, cur)} 价格段有 ${overlap} 家对手在打，不算拥挤但已有先入者。` });
  }

  // 卖点原点：你选的卖点里，哪些被对手占了、哪些还是空白
  if (prof && (prof.sellingPoints || []).length) {
    const spComps = comps.filter(c => (c.sellingPoints || []).length);
    out.sellingPoints = prof.sellingPoints.map(sp => {
      const claimed = spComps.filter(c => (c.sellingPoints || []).includes(sp)).map(c => c.name);
      return { sp, label: SP_LABEL[sp] || sp, claimedBy: claimed.length, claimedNames: claimed.slice(0, 6) };
    });
    out.sellingPoints.forEach(r => {
      if (r.claimedBy === 0) out.challenges.push({ type: 'sp_open', text: `你选的卖点「${r.label}」目前无对手主打，是空白可占。` });
      else if (r.claimedBy >= 3) out.challenges.push({ type: 'sp_crowded', text: `你选的卖点「${r.label}」已被 ${r.claimedBy} 家对手主打（${r.claimedNames.join('、')}），属拥挤方向。` });
    });
  }
  return out;
}

// ============================================================
// 步骤3：空白推理引擎（执行弱 + 邻接 + 细粒度）
// ============================================================

// 推理方法论标注（把 type+evidence 映射到统一「推理类别」标签，供前端透明展示"这条空位怎样推出来"）。
const GAP_METHOD = {
  'executionWeak': { key: 'execWeak', label: '执行弱探测（在售但被评执行弱）' },
  'absence:verified-neg': { key: 'verifiedAbsence', label: '已验证缺失（多家确证未入驻）' },
  'absence:partial-verified': { key: 'partialVerifiedAbsence', label: '部分验证缺失（部分确证、部分未探测）' },
  'absence:undetected': { key: 'undetectedAbsence', label: '未探测（仅未查到，非确认不做）' },
  'absence:neg': { key: 'regionAbsence', label: '地域缺席（无对手覆盖该市场）' },
  'priceGap:scraped-prices': { key: 'priceScraped', label: '价位阶梯空档（≥2家实抓价佐证）' },
  'priceGap:stated-prices': { key: 'priceStated', label: '价位阶梯空档（陈述价佐证）' },
  'priceGap:undetected': { key: 'priceLack', label: '价格数据不足（<3家同币种）' },
  'claimGap:matrix': { key: 'spMatrix', label: '卖点矩阵空缺（品牌×卖点无人认领）' },
  'tacticGap:matrix': { key: 'tacticMatrix', label: '策略矩阵空缺（品牌×打法无人使用）' },
  'demandGap:reviews': { key: 'painSpeculation', label: '口碑痛点推测（被抱怨但无人解决）' },
  'adjacency:struct': { key: 'adjacencyStruct', label: '邻接结构推理（相邻品类通用打法，无对手采用）' },
  'singleBlindSpot:struct': { key: 'singleBlindSpot', label: '单家盲点（同类对手在做/本对手价位复购，结构推理其留白）' }
};
const gapMethodOf = (type, evidence) => GAP_METHOD[type + ':' + evidence] || GAP_METHOD[type] || { key: 'other', label: '结构推理' };

// 销售策略中文标签（模块级复用）
const TACTIC_LABELS = { discount: '折扣促销', bundle: '捆绑销售', subscription: '订阅制', ugcCampaign: 'UGC征集', livestreamSelling: '直播带货', membership: '会员制', influencerSeeding: '达人种草', giveaway: '抽奖赠品', preorder: '预售', loyaltyProgram: '积分忠诚', seasonalDrop: '季节限定上新', communityBuilding: '社群运营' };

// ▶ #10 冷启动单家空白：当已研究对手 < 3 家时，不再整体隐藏空白视图，
// 改为产出「单家观察」空白——按结构推理"应做而未做"（如同类对手在做的渠道/打法本对手没做、复购价位却无订阅制）。
// 严格标注：非群体共识、低置信(unverified)、level=undetected、附免责声明；quality gate 仍生效（不冒充市场机会）。
function computeSingleCompetitorGaps(state, comps) {
  const MKT_CUR = marketCurrency(state.intent && state.intent.regions);
  const LADDER = priceLadder(MKT_CUR);
  const gaps = [];
  const pushSingle = (c, dim, value, type, note, src) => {
    const m = gapMethodOf(type, 'struct');
    gaps.push({
      dim, value, type,
      confidence: 'low', confidenceNum: confNum('low'), basis: 'unverified',
      evidence: 'struct', note, method: m.label, methodKey: m.key,
      sources: src || [], level: 'undetected',
      isGroup: false, singleCompetitor: true, copyGap: false,
      disclaimer: DISCLAIMER_TEXT,
      gid: 'G-' + stableHash(`${dim}|${value}|${type}|single|${c.id}`)
    });
  };
  comps.forEach(c => {
    const others = comps.filter(p => p.id !== c.id);
    // 1) 渠道盲点：同类对手在该渠道活跃、本对手未入驻（结构推理其留白）
    CHANNELS.forEach(ch => {
      const activePeers = others.filter(p => (p.channels || {})[ch] && (p.channels[ch].present === true));
      const cRec = (c.channels || {})[ch];
      const cPresent = cRec && cRec.present === true;
      if (activePeers.length && !cPresent) {
        pushSingle(c, '渠道', ch, 'singleBlindSpot',
          `「${c.name}」未在 ${ch} 布局（其同类对手 ${activePeers.map(p => p.name).join('/')} 在该渠道活跃，结构推测其留白）`,
          activePeers.map(p => ({ name: p.name, basis: 'inferred', detail: '在' + ch + '活跃' })));
      }
    });
    // 2) 打法盲点：同类对手采用该打法、本对手未采用
    TACTICS.forEach(tc => {
      const tcLabel = TACTIC_LABELS[tc] || tc;
      const usingPeers = others.filter(p => (p.tactics || []).includes(tc));
      const cUsing = (c.tactics || []).includes(tc);
      if (usingPeers.length && !cUsing) {
        pushSingle(c, '策略空缺', tcLabel, 'singleBlindSpot',
          `「${c.name}」未采用「${tcLabel}」打法（其同类对手 ${usingPeers.map(p => p.name).join('/')} 采用，结构推测其留白）`,
          usingPeers.map(p => ({ name: p.name, basis: 'inferred', detail: '采用' + tcLabel })));
      }
    });
    // 3) 复购价位却无订阅/会员（仅需本对手数据，结构推测其留白）
    const pts = (c.pricePoints || []).filter(n => typeof n === 'number' && n > 0);
    if (pts.length && LADDER.length) {
      const inLowBand = pts.some(p => p >= LADDER[0].min && p < LADDER[0].max);
      const hasSub = (c.tactics || []).some(t => ['subscription', 'membership', 'loyaltyProgram'].includes(t));
      if (inLowBand && !hasSub) {
        pushSingle(c, '策略空缺', '订阅/会员制', 'singleBlindSpot',
          `「${c.name}」定价含 ${MKT_CUR} ${Math.min(...pts)} 的复购价位却无订阅制/会员（复购型品类常见留白，结构推测）`,
          [{ name: c.name, basis: 'inferred', detail: '低位复购价' }]);
      }
    }
  });
  return gaps;
}

function computeWhiteSpace(state) {
  const excluded = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) excluded.add(c.id); }); // #305 错配/低置信卡一并剔除
  const comps = state.competitors.filter(c => c.status === 'done' && !excluded.has(c.id));
  const total = comps.length;
  // ▶ #10：<3 家不再整体隐藏——转单家观察模式（hidden:false + singleMode），产出结构推理的单家盲点。
  // 仅 0 家完成研究时才回退隐藏（无可推理对象）。
  if (total < 3) {
    if (total === 0) return { hidden: true, reason: 'add_more', total, excludedCount: excluded.size, positioning: assessPositioning(state) };
    const gaps = computeSingleCompetitorGaps(state, comps);
    const coverage = Math.round((comps.length / Math.max(1, state.competitors.length)) * 100);
    return { hidden: false, singleMode: true, total, coverage, dimCoverage: {}, gaps, positioning: assessPositioning(state) };
  }

  const gaps = [];
  // 统一 basis：high→verified（我们查实）、medium→inferred（部分/间接）、low→unverified（仅未探测/推测）。
  const gapBasis = (conf) => conf === 'high' ? 'verified' : conf === 'medium' ? 'inferred' : 'unverified';
  const pushGap = (dim, value, type, conf, evidence, note, sources, copyGap) => {
    const num = confNum(conf);
    const m = gapMethodOf(type, evidence);
    gaps.push({
      dim, value, type,
      confidence: conf, confidenceNum: num, basis: gapBasis(conf),
      evidence, note: note || '',
      method: m.label, methodKey: m.key,
      sources: Array.isArray(sources) ? sources : [],
      level: num < 40 ? 'undetected' : 'opportunity',
      // ▶ 报告-数据同源 原则4：卖点/策略矩阵空缺基于"官网文案比对"，属"文案空缺(观察级)"，
      // 非"市场空缺(需需求侧证据)"——前端/报告须区分，不拿"数量"撑机会场面。
      copyGap: !!copyGap
    });
  };

  // 1) 渠道：缺席 + 执行弱（区分"已验证缺失"与"未探测"，未探测不当作机会）
  CHANNELS.forEach(ch => {
    const recs = comps.map(c => ({ name: c.name, rec: (c.channels || {})[ch] })).filter(x => x.rec);
    const present = recs.filter(x => x.rec.present === true);
    const verifiedAbsent = recs.filter(x => x.rec.present === false && x.rec.basis === 'verified');
    const unverifiedAbsent = recs.filter(x => x.rec.present === false && x.rec.basis !== 'verified');
    const weak = recs.filter(x => x.rec.present === true && /弱|少|差|低|投诉|硬广|无内容|缺/.test(x.rec.note || ''));
    if (present.length > 0) {
      if (weak.length > 0) {
        const src = weak.map(x => ({ name: x.name, basis: x.rec.basis || 'inferred', detail: (x.rec.note || '').slice(0, 36) }));
        pushGap('渠道', ch, 'executionWeak', 'medium', 'present-but-weak', `${weak.length}/${present.length}家在做但执行弱`, src);
      }
      return;
    }
    // 无人 present：区分"已验证缺失"与"未探测"
    if (verifiedAbsent.length === recs.length && recs.length > 0) {
      const src = verifiedAbsent.map(x => ({ name: x.name, basis: 'verified', detail: '确认未入驻' }));
      pushGap('渠道', ch, 'absence', 'high', 'verified-neg', `行业普遍确认未进入该渠道（${verifiedAbsent.length}家均确认缺席）`, src);
    } else if (verifiedAbsent.length > 0) {
      const src = verifiedAbsent.map(x => ({ name: x.name, basis: 'verified', detail: '确认未入驻' }))
        .concat(unverifiedAbsent.map(x => ({ name: x.name, basis: 'unverified', detail: '未探测到' })));
      pushGap('渠道', ch, 'absence', 'medium', 'partial-verified', `${verifiedAbsent.length}家确认缺席，${unverifiedAbsent.length}家未探测到`, src);
    } else if (unverifiedAbsent.length > 0) {
      const src = unverifiedAbsent.map(x => ({ name: x.name, basis: 'unverified', detail: '未探测到' }));
      pushGap('渠道', ch, 'absence', 'low', 'undetected', `${unverifiedAbsent.length}家未探测到该渠道布局（可能只是没查到，非确认不做）`, src);
    }
  });

  // ==========================================================
  // PRD 四类空缺 —— ① 价位空缺（价格阶梯聚类，实价证据，置信度上限 high）
  // ==========================================================
  // 币种裁决：只有与目标市场同币种的对手才进同一张阶梯 —— 跨币种直接比数字是错的，且我们不做汇率换算
  const MKT_CUR = marketCurrency(state.intent && state.intent.regions);
  const LADDER = priceLadder(MKT_CUR);
  const ladderOcc = {}; // key -> [{name, verified}]
  LADDER.forEach(L => { ladderOcc[L.key] = []; });
  const pricedList = []; // 每家对手定价落在的阶梯（溯源用：空档由"对手均在其它档"反推）
  const crossCurrency = []; // 有价格但币种不同 → 不参与比较，但要如实告诉用户被排除了
  comps.forEach(c => {
    const cCur = c.currency || MKT_CUR;
    const hasPrice = (c.pricePoints || []).length || (c.priceBand && c.priceBand.range);
    if (hasPrice && cCur !== MKT_CUR) { crossCurrency.push(`${c.name}(${cCur})`); return; }
    const pts = (c.pricePoints || []).filter(n => typeof n === 'number' && n > 0);
    if (pts.length) {
      const hit = new Set();
      pts.forEach(p => { const L = LADDER.find(x => p >= x.min && p < x.max); if (L) hit.add(L.key); });
      hit.forEach(k => { const Lx = LADDER.find(x => x.key === k); ladderOcc[k].push({ name: c.name, verified: !!c.priceVerified }); pricedList.push({ name: c.name, ladder: Lx.label, verified: !!c.priceVerified }); });
    } else if (c.priceBand && c.priceBand.range) {
      // 无实价时用 band 文本区间粗略映射
      const m = String(c.priceBand.range).match(/(\d+)\D+(\d+)/);
      if (m) {
        const lo = +m[1], hi = +m[2];
        LADDER.forEach(L => { if (hi > L.min && lo < L.max) { ladderOcc[L.key].push({ name: c.name, verified: false }); pricedList.push({ name: c.name, ladder: L.label, verified: false }); } });
      }
    }
  });
  const pricedComps = comps.filter(c => (c.currency || MKT_CUR) === MKT_CUR && ((c.pricePoints || []).length || (c.priceBand && c.priceBand.range))).length;
  const xcNote = crossCurrency.length ? `（另有 ${crossCurrency.length} 家币种不同未纳入比较：${crossCurrency.slice(0, 4).join('、')}）` : '';
  const priceSrc = () => pricedList.map(p => ({ name: p.name, basis: p.verified ? 'verified' : 'inferred', detail: '定价落在' + p.ladder }));
  if (pricedComps >= 3) {
    LADDER.forEach(L => {
      const occ = ladderOcc[L.key];
      if (occ.length === 0) {
        // ▶ 空白视图整改 · 规范 B：verifiedCnt 按「品牌」去重（一家实抓只算 1，无论落几个档），
        // 避免 1 家 × N 档被误算成 N 家实抓、虚高 high 判定。
        const verifiedBrands = new Set(Object.values(ladderOcc).flat().filter(o => o.verified).map(o => o.name));
        const verifiedCnt = verifiedBrands.size;
        const conf = verifiedCnt >= 2 ? 'high' : 'medium'; // 有≥2家实抓价格佐证 → 高置信
        pushGap('价位空缺', L.label, 'priceGap', conf, verifiedCnt >= 2 ? 'scraped-prices' : 'stated-prices', `${pricedComps}家对手（均以 ${MKT_CUR} 计价）定价都不落在 ${L.label} 档（${verifiedCnt}家为实抓价格），该价位带无人占据${xcNote}`, priceSrc());
      }
    });
  } else {
    pushGap('价位空缺', '数据不足', 'priceGap', 'low', 'undetected', `仅${pricedComps}家有 ${MKT_CUR} 计价数据，不足以判断价位空档（需≥3家）${xcNote}`, priceSrc());
  }

  // ==========================================================
  // ② 卖点空缺（受控词表 × 品牌矩阵，置信度上限 medium：归类有主观性）
  // ==========================================================
  const spComps = comps.filter(c => (c.sellingPoints || []).length);
  if (spComps.length >= 3) {
    // ▶ 1.3：矩阵反推 gap 过度保守修复 —— 来源 basis 不再恒 'inferred'，
    // 改按"该对手卖点矩阵是否含查实(verified)证据"判定，与渠道 verified-neg 同口径。
    // 仅当对手确有 verified 级卖点时才标 verified，绝不为无据数据虚报 verified。
    const spSrc = spComps.map(c => {
      const sb = c.sellingPointBasis || {};
      const verified = (c.sellingPoints || []).some(p => sb[p] === 'verified');
      return { name: c.name, basis: verified ? 'verified' : 'inferred', detail: '已查卖点矩阵' };
    });
    SELLING_POINTS.forEach(sp => {
      const claimed = spComps.filter(c => (c.sellingPoints || []).includes(sp));
      if (claimed.length === 0) {
        pushGap('卖点空缺', SP_LABEL[sp] || sp, 'claimGap', 'medium', 'matrix', `${spComps.length}家对手无一主打「${SP_LABEL[sp] || sp}」，卖点矩阵该列空缺`, spSrc, true);
      }
    });
  }

  // ==========================================================
  // ③ 销售策略空缺（策略词表 × 品牌矩阵）
  // ==========================================================
  const tcComps = comps.filter(c => (c.tactics || []).length);
  if (tcComps.length >= 3) {
    // ▶ 1.3：策略矩阵来源 basis —— tactics 维度 schema 无 per-tactic verified basis（仅 demandEvidence），
    // 故用"该对手 tactics 来自真实一手证据(fieldSource tier=1)"作 verified 信号，与 verified-neg 同口径。
    const tcSrc = tcComps.map(c => {
      const ts = (c.fieldSources && c.fieldSources['tactics']) || [];
      const verified = ts.some(s => s.tier === 1);
      return { name: c.name, basis: verified ? 'verified' : 'inferred', detail: '已查打法矩阵' };
    });
    TACTICS.forEach(tc => {
      const used = tcComps.filter(c => (c.tactics || []).includes(tc));
      if (used.length === 0) {
        pushGap('策略空缺', TACTIC_LABELS[tc] || tc, 'tacticGap', 'medium', 'matrix', `${tcComps.length}家对手无一采用「${TACTIC_LABELS[tc] || tc}」打法`, tcSrc, true);
      }
    });
  }

  // ==========================================================
  // ④ 市场机会空缺（口碑痛点：被抱怨但没人解决 → 强制封顶 low·标推测）
  // ==========================================================
  const painMap = new Map(); // 归一化痛点 -> {point, brands:[], hasCite}
  comps.forEach(c => {
    (c.painPoints || []).forEach(p => {
      const key = normName(p.point).slice(0, 24);
      if (!key) return;
      const ex = painMap.get(key) || { point: p.point, brands: [], hasCite: false };
      if (!ex.brands.includes(c.name)) ex.brands.push(c.name);
      if (p.basis === 'verified' || p.basis === 'inferred') ex.hasCite = ex.hasCite || (p.confidence !== 'low');
      painMap.set(key, ex);
    });
    // 复用 reviews.negThemes 作为补充痛点源
    ((c.reviews || {}).negThemes || []).forEach(t => {
      const key = normName(t).slice(0, 24);
      if (!key) return;
      const ex = painMap.get(key) || { point: t, brands: [], hasCite: false };
      if (!ex.brands.includes(c.name)) ex.brands.push(c.name);
      painMap.set(key, ex);
    });
  });
  Array.from(painMap.values())
    .filter(p => p.brands.length >= 2) // 至少两家被抱怨同一点 → 行业级痛点
    .sort((a, b) => b.brands.length - a.brands.length)
    .slice(0, 6)
    .forEach(p => {
      const src = p.brands.map(b => ({ name: b, basis: 'inferred', detail: '抱怨：「' + p.point + '」' }));
      pushGap('市场机会', p.point, 'demandGap', 'low', 'reviews', `${p.brands.length}家对手（${p.brands.slice(0, 3).join('/')}）被用户抱怨「${p.point}」且无人宣称解决 —— 推测存在需求空档`, src);
      gaps[gaps.length - 1].speculative = true; // 强制标"推测"（低置信，按 PRD §7.1 归 undetected + 免责声明，不冒充机会）
    });

  // ▶ 空白视图整改 · 规范 E：邻接结构推理（联名/内容/履约）强制 low + 类比依据
  // ==========================================================
  // 原有邻接/细粒度维度（保留）
  // ==========================================================
  const allCollab = comps.flatMap(c => c.collabTypes || []);
  COLLAB_TYPES.forEach(ct => {
    if (!allCollab.includes(ct)) {
      // 规范 E：邻接结构推理（联名）置信度强制 low，level 恒 undetected，不得显示为机会
      pushGap('联名', ct, 'adjacency', 'low', 'struct', `无对手采用${ct}联名（类比依据：相邻品类普遍用联名拉新；无对手采用≠对手刻意不做，需核验）`);
    }
  });
  const allContent = comps.flatMap(c => c.contentForms || []);
  CONTENT_FORMS.forEach(cf => {
    if (!allContent.includes(cf)) {
      pushGap('内容', cf, 'adjacency', 'low', 'struct', `无对手主打${cf}内容形态（类比依据：相邻品类内容打法常规；无对手采用属结构推测，非确证缺失）`);
    }
  });
  REGIONS.forEach(rg => {
    const present = comps.filter(c => (c.regions || []).includes(rg)).length;
    if (present === 0) {
      // ▶ 1.3：地域矩阵来源 basis —— regions 来自主研究无独立 verified basis，
      // 故用"该对手 regions 来自真实一手证据(fieldSource tier=1)"作 verified 信号，与 verified-neg 同口径。
      const src = comps.map(c => {
        const rs = (c.fieldSources && c.fieldSources['regions']) || [];
        const verified = rs.some(s => s.tier === 1);
        return { name: c.name, basis: verified ? 'verified' : 'inferred', detail: '无该市场覆盖' };
      });
      pushGap('地域', rg, 'absence', 'medium', 'neg', `无对手覆盖${rg}市场`, src);
    }
  });
  FULFILLMENT.forEach(f => {
    const present = comps.filter(c => (c.fulfillment || []).includes(f)).length;
    if (present === 0) pushGap('履约', f, 'adjacency', 'low', 'struct', `无对手采用${f}履约（类比依据：相邻品类履约方式常规；无对手采用属结构推测，非确证缺失）`);
  });

  // 各维度采集覆盖率（PRD §8：覆盖率 <70% 严禁输出群体性空白）
  const cov = (arr) => { const n = (arr || []).filter(Boolean).length; return comps.length ? n / comps.length : 0; };
  const dimCov = {
    '渠道': cov(comps.map(c => c.channels && Object.keys(c.channels).length)),
    '价位空缺': cov(comps.map(c => (c.pricePoints || []).length || (c.priceBand && c.priceBand.range))),
    '卖点空缺': cov(comps.map(c => (c.sellingPoints || []).length)),
    '策略空缺': cov(comps.map(c => (c.tactics || []).length)),
    '地域': cov(comps.map(c => (c.regions || []).length))
  };
  const GROUP_DIMS = new Set(['渠道', '价位空缺', '卖点空缺', '策略空缺', '地域', '联名', '内容', '履约']); // ▶ 空白视图整改 · 规范 D：补全 3 条邻接维度，无绕过路径

  // ==========================================================
  // ▶ 空白视图整改 · 架构整改#1 + 规范 A：群体空白「统一置信收敛」闸门（坐在 gap 生成边界）
  // 闭合裂缝一·第三变体（字段层已收敛，gap 层此前 7 条路径各自手写）。
  // 规则（由「证据形态」决定，不按路径硬编码）：
  //   - 机会门槛 oppGate：维度覆盖率≥70% 且 存在「已查实(verified)」来源 → 才可作为可行动机会；
  //   - 置信度：已查实品牌≥2 → high；恰好 1 家已查实 → medium；否则 low；
  //   - 不满足 oppGate（覆盖率<70% 或 来源空/全推断）→ level 恒 undetected（不得显示为机会），并显式标注。
  //   - 所有 gap 均跨≥2 品牌聚合 → 一律标记 isGroup=true（供前端双保险过滤，规范 C）。
  // 收敛逻辑已抽离为 lib/confidence.js 的纯函数 gapConfidence（可单测，详见 test/gap-confidence.test.js）。
  // ==========================================================

  gaps.forEach(g => {
    g.isGroup = true; // ▶ 空白视图整改 · 规范 A/C：群体 gap 标记，供前端双保险过滤
    const tracked = dimCov.hasOwnProperty(g.dim);
    const covVal = tracked ? (dimCov[g.dim] || 0) : 1;
    const r = gapConfidence(g.sources, covVal, tracked);
    const prevNum = confNum(g.confidence);
    const demoted = (g.level === 'opportunity' && r.level === 'undetected') || (prevNum > r.confidenceNum);
    g.confidence = r.confidence; g.confidenceNum = r.confidenceNum; g.basis = r.basis; g.level = r.level;
    if (!r.covOk && tracked) g.coverageInsufficient = true;
    if (demoted) {
      const reasons = [];
      if (!r.covOk && tracked) reasons.push(`维度采集覆盖率 ${Math.round(covVal * 100)}% < 70%，群体性结论暂不可信`);
      if (r.verified === 0) reasons.push(`来源为空或全部为推断（无已查实交叉佐证），不得作为机会结论`);
      if (reasons.length) g.note += `（${reasons.join('；')}）`;
    }
  });
  // 低可信缺失项统一附免责声明（PRD §7.1 硬验收）
  gaps.forEach(g => { if (g.level === 'undetected') g.disclaimer = DISCLAIMER_TEXT; });
  // 空缺编号（稳定内容哈希，可跨时间引用，支撑校准率回溯与 /api/report 对齐）
  gaps.forEach(g => { g.gid = 'G-' + stableHash(`${g.dim}|${g.value}|${g.type}|${g.methodKey}`); });

  // P0-4 字段准确率 input 门禁：依赖维度抽取准确率不足（<红线80%）→ 该维空白推理退出，
  // 仅作未探测区域展示（不阻塞整体上线）。无抽检数据 → fail-open，不降级（冷启动不误杀）。
  applyAccuracyGate(gaps, loadAccuracySummary());

  // 覆盖率（竞品参与率，用于前端头部展示）
  const coverage = Math.round((comps.length / Math.max(1, state.competitors.length)) * 100);
  // 三态网格（真空位/未知/死区）：派生产物，不落盘；与 priceField/opportunity 同构，每次读态实时重算。
  const grid = computeWhiteSpaceGrid(state.competitors, { minCellCoverage: 3 });
  return { hidden: false, total, coverage, dimCoverage: dimCov, gaps, positioning: assessPositioning(state), grid };
}

// ============================================================
// 横向对比：点击某字段名 → 拉全品牌对比表（纯聚合，不调 LLM；忠实：价格不换算币种）
// ============================================================
// 取价格字段契约：优先用研究时算好的 priceField；旧数据无则按遗留字段重建。
// 支持用户纠错（硬信号零延迟生效）：wrong-value / wrong-currency / over-confident。
function getPriceField(c, corrections) {
  const corr = activeCorrections((corrections || []).filter(x => /^price/.test(x.field || '')));
  const curCorr = corr.find(x => x.type === 'wrong-currency' && x.currency);
  const cur = curCorr ? curCorr.currency : (c.currency || 'USD');
  // 无纠错且已算好 → 直接返回存储结果
  if (c.priceField && c.priceField.display && !corr.length) { if (!c.priceField.priceScope) c.priceField.priceScope = 'list'; return c.priceField; }
  const claims = (c.priceClaims && c.priceClaims.length) ? c.priceClaims
    : (() => {
        const pts = (c.pricePoints || []).filter(n => typeof n === 'number' && n > 0);
        const cl = [];
        if (c.priceVerified && pts.length) cl.push({ tier: 1, kind: 'shopify', value: [Math.min(...pts), Math.max(...pts)], url: null, text: '实抓价格点', points: c.pricePoints.slice() });
        else if (pts.length) cl.push({ tier: 3, kind: 'llm-guess', value: [Math.min(...pts), Math.max(...pts)], url: null, text: 'LLM 价格点' });
        if (c.priceBand && c.priceBand.range) {
          const pv = parsePriceRange(c.priceBand.range, cur);
          if (pv) cl.push({ tier: (c.priceBand.basis === 'verified') ? 1 : 2, kind: 'llm-band', value: pv, url: null, text: c.priceBand.range });
        }
        return cl;
      })();
  let pf = buildPriceField(claims, { currency: cur, corrections: corr });
  // ▶ PRD整改 §3.4 #3：价格口径——恒为官网挂牌标价（list），不含税运；前端恒标注，跨品牌只比同口径
  pf.priceScope = 'list';
  pf.includesShipping = false;
  // over-confident：用户认为当前置信度虚高 → 降级（用户对其自身数据的硬信号，可自动生效）
  if (corr.some(x => x.type === 'over-confident') && pf.basis !== 'unverified') {
    const down = { verified: 'inferred', inferred: 'unverified' };
    const downConf = { high: 'medium', medium: 'low', low: 'low' };
    pf = { ...pf, basis: down[pf.basis] || pf.basis, confidence: downConf[pf.confidence] || pf.confidence, conflictNote: (pf.conflictNote ? pf.conflictNote + '；' : '') + '用户反馈：原置信度偏高，已降级' };
  }
  const pricePend = (corrections || []).filter(x => x.status === 'pending' && /^price/.test(x.field || ''));
  if (pricePend.length) pf = softQuarantine(pf, pricePend.length);
  return pf;
}

// 取渠道字段契约：优先用研究时算好的 channelFields；旧数据无则按遗留 channels 重建。
// 支持用户纠错（硬信号零延迟生效）：wrong-state（在售/确认未入驻/未探测）覆盖一切；over-confident 降级。
// 与 getPriceField 同构：每次 decorateState 实时重算，不落盘（忠实、可迭代）。
// P0-1 url 桥接：重建 claim 时优先用 fieldSources['channels.'+chKey] 中带真实 url 的条目，
// 保留来源级粒度 → 多域渠道可触发独立来源去重（此前 url:null 导致去重休眠）。
function getChannelField(c, corrections, channelKey) {
  const corr = activeCorrections((corrections || []).filter(x => x.field === ('channels.' + channelKey)));
  const stored = (c.channels && c.channels[channelKey]) || null;
  const srcs = (c.fieldSources && c.fieldSources['channels.' + channelKey]) || [];
  const claims = [];
  if (srcs.length) {
    // 用证据级来源逐条还原（带 url/tier/kind），使独立来源身份判定可用
    const stance = (stored && stored.present === false) ? 'absent' : 'present';
    for (const e of srcs) {
      if (!e) continue;
      claims.push({ tier: e.tier || 2, kind: e.kind || 'third', stance, url: e.url || null, text: e.title || '' });
    }
  }
  if (!claims.length && stored) {
    if (stored.present === true) {
      const tier = stored.basis === 'verified' ? 1 : (stored.basis === 'inferred' ? 2 : 3);
      const kind = /shopify/i.test(stored.note || '') ? 'shopify' : (/官网/.test(stored.note || '') ? 'official' : 'probe');
      claims.push({ tier, kind, stance: 'present', url: null, text: stored.note || '' });
    } else {
      // present===false：basis=verified → 确认未入驻(tier1)；否则只是"未探测"(tier3，绝不能当确认缺席)
      if (stored.basis === 'verified') claims.push({ tier: 1, kind: 'neg-check', stance: 'absent', url: null, text: stored.note || '' });
      else claims.push({ tier: 3, kind: 'unprobed', stance: 'absent', url: null, text: stored.note || '未探测' });
    }
  }
  // over-confident 降级已在 buildChannelField 内统一处理（与价格同构，纯函数可单测）
  const chPend = (corrections || []).filter(x => x.status === 'pending' && x.field === ('channels.' + channelKey));
  const chBuilt = buildChannelField(claims, { corrections: corr });
  return chPend.length ? softQuarantine(chBuilt, chPend.length) : chBuilt;
}

// 取品类字段契约：优先用研究时算好的 categories；旧数据无则按遗留 categories 重建。
// 与 getChannelField 同构：每次 decorateState 实时重算，支持用户纠错（wrong-state 硬信号零延迟生效）。
function getCategoryField(c, corrections, catKey) {
  const corr = activeCorrections((corrections || []).filter(x => x.field === ('categories.' + catKey)));
  const stored = (c.categories && c.categories[catKey]) || null;
  const claims = [];
  if (stored) {
    if (stored.present === true) {
      const tier = stored.basis === 'verified' ? 1 : (stored.basis === 'inferred' ? 2 : 3);
      claims.push({ tier, kind: 'official', stance: 'present', url: null, text: stored.note || '' });
    } else {
      // present===false：verified → 确认缺席(tier1)；inferred → 推断缺席(tier2)；其余未探测(tier3)
      const tier = stored.basis === 'verified' ? 1 : (stored.basis === 'inferred' ? 2 : 3);
      const kind = stored.basis === 'verified' ? 'neg-check' : 'unprobed';
      claims.push({ tier, kind, stance: 'absent', url: null, text: stored.note || '未探测' });
    }
  }
  const catPend = (corrections || []).filter(x => x.status === 'pending' && x.field === ('categories.' + catKey));
  const catBuilt = buildCategoryField(claims, { corrections: corr });
  return catPend.length ? softQuarantine(catBuilt, catPend.length) : catBuilt;
}

// 取上新节奏字段契约：从近期动作(recentMoves)数量推导节奏标签；用户纠错(wrong-value)硬信号零延迟生效。
// 与价格/品类同构：每次 decorateState 实时重算。
// P0-1 url 桥接：每条 recentMove 按 fieldSources['recentMoves.'+i] 还原 claim（带 url），
// 多域多动作→独立来源≥2→high（此前合并单 claim + url:null 导致去重休眠）。
function getLaunchCadence(c, corrections) {
  const corr = activeCorrections((corrections || []).filter(x => x.field === 'launchCadence'));
  const claims = [];
  const moves = (c.recentMoves || []).filter(m => m && (m.desc || m.type));
  const n = moves.length;
  let label = null;
  if (n >= 3) label = '高频（月更及以上）';
  else if (n === 2) label = '中频（季更）';
  else if (n === 1) label = '低频（偶发）';
  if (label) {
    moves.forEach((m, i) => {
      const srcs = (c.fieldSources && c.fieldSources['recentMoves.' + i]) || [];
      // 多条动作共享同一节奏标签 → 一致值；不同域名来源→独立源计数
      if (srcs.length) {
        for (const e of srcs) {
          if (!e) continue;
          claims.push({ tier: e.tier || 3, kind: e.kind || 'moves', value: label, stance: 'present', url: e.url || null, text: e.title || m.desc || '' });
        }
      } else {
        const tier = (m.basis === 'verified') ? 1 : (m.basis === 'inferred' ? 2 : 3);
        claims.push({ tier, kind: 'moves', value: label, stance: 'present', url: null, text: m.desc || '' });
      }
    });
  }
  const cadPend = (corrections || []).filter(x => x.status === 'pending' && x.field === 'launchCadence');
  const cadBuilt = buildScalarField(claims, { corrections: corr, conflictNote: '来源对该品牌上新节奏给出不同判断' });
  return cadPend.length ? softQuarantine(cadBuilt, cadPend.length) : cadBuilt;
}

// 取口碑复合字段契约：rating/trend 标量 + neg/pos 主题列表，各自值级裁决；用户纠错零延迟生效。
// 与价格/渠道同构：每次 decorateState 实时重算。
function getReviewField(c, corrections) {
  const corr = activeCorrections((corrections || []).filter(x => x.field && x.field.startsWith('reviews')));
  const revPend = (corrections || []).filter(x => x.status === 'pending' && x.field && x.field.startsWith('reviews'));
  const revBuilt = buildReviewField(c.reviews || {}, corr, (c.fieldSources && c.fieldSources['reviews']) || null);
  return revPend.length ? softQuarantine(revBuilt, revPend.length) : revBuilt;
}

// ▶ P2 #8 定位战略：归一化摘要（兼容旧版字符串 positioning 与新版结构化对象），供对比/动力种子/快照复用。
function posSummary(c) {
  const p = c && c.positioning;
  if (!p) return '';
  if (typeof p === 'string') return p.slice(0, 200);
  return (p.valueProposition || p.differentiation || '').slice(0, 200);
}

function compareField(state, fieldKey) {
  const excluded = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) excluded.add(c.id); }); // #305 错配/低置信卡一并剔除
  const comps = state.competitors.filter(c => c.status === 'done' && !excluded.has(c.id));
  const MKT_CUR = marketCurrency(state.intent && state.intent.regions);
  const BAND_LABEL = { mass: '大众档', mid: '中端', premium: '高端', ultra: '超高端' };
  const srcOf = (c, key) => {
    const fs0 = (c.fieldSources || {})[key];
    return (fs0 && fs0.length) ? fs0.map(s => ({ url: s.url, title: s.title || (s.kind || '来源') })) : [];
  };
  const base = (c) => ({ id: c.id, name: c.name, tier: c.tier, confidence: c.confidence });
  // 跨币种提示：价格类尤其要如实说明"不换算"
  const crossNote = (arr) => {
    const diff = arr.filter(c => (c.currency || MKT_CUR) !== MKT_CUR).map(c => `${c.name}(${c.currency || MKT_CUR})`);
    return diff.length ? `各对手计价币种不一（${diff.slice(0, 6).join('、')}），下表不换算币种，请按各品牌原币种对照。` : '';
  };

  switch (fieldKey) {
    case 'price': {
      const corr = (state.fieldCorrections || []).filter(x => x.field === 'price');
      const rows = comps.map(c => {
        const cur = c.currency || MKT_CUR;
        const pf = getPriceField(c, corr.filter(x => x.competitorId === c.id));
        return { ...base(c), currency: cur, display: pf.display, basis: pf.basis, confidence: pf.confidence, method: pf.method, sources: pf.sources, conflictNote: pf.conflictNote, realScraped: pf.realScraped };
      });
      return { field: 'price', label: '价格带 / 价格点', kind: 'scalar', note: crossNote(comps), rows };
    }
    case 'sellingPoints': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.sellingPoints || []), display: (c.sellingPoints || []).join('/') || '—', sources: srcOf(c, 'sellingPoints') }));
      return { field: 'sellingPoints', label: '主打卖点', kind: 'scalar', rows };
    }
    case 'positioning': {
      const rows = comps.map(c => ({ ...base(c), display: posSummary(c) || '—', basis: c.positioningBasis === 'verified' ? 'verified' : (c.positioning ? 'claimed' : null), sources: srcOf(c, 'positioning') }));
      return { field: 'positioning', label: '定位战略', kind: 'scalar', rows };
    }
    case 'products': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.products || []), display: (c.products || []).join('、') || '—', sources: srcOf(c, 'products') }));
      return { field: 'products', label: '产品矩阵', kind: 'scalar', rows };
    }
    case 'launchCadence': {
      const rows = comps.map(c => {
        const lc = getLaunchCadence(c, state.fieldCorrections || []);
        return { ...base(c), display: lc.value || '—', basis: lc.basis, confidence: lc.confidence, method: lc.method, sources: lc.sources, conflictNote: lc.conflictNote };
      });
      return { field: 'launchCadence', label: '上新节奏', kind: 'scalar', rows };
    }
    case 'audiences': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.audiences || []), display: (c.audiences || []).join('、') || '—' }));
      return { field: 'audiences', label: '目标人群', kind: 'scalar', rows };
    }
    case 'channels': {
      // 只渲染用户勾选的平台（忠实助理：不展示用户不关心的平台）
      const plat = (state.intent && state.intent.platforms);
      const cols = (plat && plat.length) ? plat : CHANNELS;
      const columns = cols.map(ch => ({ key: ch, label: ch, type: channelTypeOf(ch) }));
      const rows = comps.map(c => {
        const cells = {};
        cols.forEach(ch => {
          const cf = getChannelField(c, state.fieldCorrections || [], ch);
          const seeding = (c.channels && c.channels[ch] && c.channels[ch].seedingVolume) || null;
          const t = channelTypeOf(ch);
          if (!cf || cf.state === 'undetected') cells[ch] = { state: 'unprobed' };
          else if (t === 'content' || t === 'hybrid') {
            // content/hybrid：以种草声量为主信号，无官店≠空白
            if (seeding && seeding !== 'none') cells[ch] = { state: 'seeding', seeding, present: !!cf.present, note: '种草声量' + seedingLabel(seeding) + (cf.present ? ' · 有官方店' : ''), basis: cf.basis, confidence: cf.confidence };
            else if (cf.present === true) cells[ch] = { state: 'present', note: cf.conflictNote || '', basis: cf.basis, confidence: cf.confidence };
            else cells[ch] = { state: 'low-seeding', seeding: seeding || 'none', note: '无官方店且种草声量' + seedingLabel(seeding || 'none'), basis: cf.basis, confidence: cf.confidence };
          } else if (cf.present === true) cells[ch] = { state: 'present', note: cf.conflictNote || '', basis: cf.basis, confidence: cf.confidence };
          else cells[ch] = { state: cf.basis === 'verified' ? 'absent-verified' : 'absent', note: cf.conflictNote || '', basis: cf.basis, confidence: cf.confidence };
        });
        return { ...base(c), cells };
      });
      return { field: 'channels', label: '渠道布局', kind: 'matrix', columns, rows };
    }
    case 'categories': {
      const columns = CATEGORIES.map(cat => ({ key: cat, label: cat }));
      const rows = comps.map(c => {
        const cells = {};
        CATEGORIES.forEach(cat => {
          const cf = getCategoryField(c, state.fieldCorrections || [], cat);
          if (!cf || cf.state === 'undetected') cells[cat] = { state: 'unprobed' };
          else if (cf.present === true) cells[cat] = { state: 'present', note: cf.conflictNote || '', basis: cf.basis, confidence: cf.confidence };
          else cells[cat] = { state: cf.basis === 'verified' ? 'absent-verified' : 'absent', note: cf.conflictNote || '', basis: cf.basis, confidence: cf.confidence };
        });
        return { ...base(c), cells };
      });
      return { field: 'categories', label: '品类布局', kind: 'matrix', columns, rows };
    }
    case 'regions': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.regions || []), display: (c.regions || []).join('、') || '—' }));
      return { field: 'regions', label: '覆盖地域', kind: 'scalar', rows };
    }
    case 'reviews': {
      const rows = comps.map(c => {
        const rf = c.reviewField || getReviewField(c, state.fieldCorrections || []);
        return {
          ...base(c),
          rating: rf.rating.value != null ? rf.rating.value : '—',
          trend: rf.trend.value || '',
          neg: (rf.negThemes.items || []).map(i => i.text),
          pos: (rf.posThemes.items || []).map(i => i.text),
          basis: rf.basis, confidence: rf.confidence, sources: srcOf(c, 'reviews')
        };
      });
      return { field: 'reviews', label: '口碑评分', kind: 'scalar', rows };
    }
    case 'painPoints': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.painPoints || []).map(p => p.point || p), display: (c.painPoints || []).map(p => p.point || p).join('、') || '—' }));
      return { field: 'painPoints', label: '用户抱怨点', kind: 'scalar', rows };
    }
    case 'tactics': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.tactics || []), display: (c.tactics || []).join('、') || '—', sources: srcOf(c, 'tactics') }));
      return { field: 'tactics', label: '销售打法', kind: 'scalar', rows };
    }
    case 'contentForms': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.contentForms || []), display: (c.contentForms || []).join('、') || '—' }));
      return { field: 'contentForms', label: '内容形态', kind: 'scalar', rows };
    }
    case 'collabTypes': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.collabTypes || []), display: (c.collabTypes || []).join('、') || '—' }));
      return { field: 'collabTypes', label: '联名方式', kind: 'scalar', rows };
    }
    case 'fulfillment': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.fulfillment || []), display: (c.fulfillment || []).join('、') || '—' }));
      return { field: 'fulfillment', label: '履约方式', kind: 'scalar', rows };
    }
    case 'estSize': {
      const rows = comps.map(c => ({ ...base(c), display: c.estSize || '—', basis: c.estSizeBasis === 'inferred' ? 'inferred' : (c.estSize ? 'stated' : null) }));
      return { field: 'estSize', label: '估算规模', kind: 'scalar', rows };
    }
    case 'techStack': {
      const rows = comps.map(c => ({ ...base(c), display: c.techStack || '—' }));
      return { field: 'techStack', label: '技术栈', kind: 'scalar', rows };
    }
    default:
      return { error: 'unknown-field', field: fieldKey };
  }
}

// ============================================================
// 步骤4：行业调研报告 v3 —— 8 章研究级装配（事实层不经 LLM 生成 + 强制引用 + 机器校验器 + 11 点 QC 门）
// ============================================================
// 事实层：直接从库里取带来源的事实，编号 F1、F2…（LLM 没有机会编造事实）
// ▶ 报告-数据同源 原则3：维度完整性闸门 —— 统计每个维度在 done 对手中的覆盖率；
// 覆盖率 < 50% 视为"未充分探测"，该维度不得进入报告原料（LLM 看不到），并计入"我们不知道"清单。
function dimensionCoverage(state) {
  const excluded = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) excluded.add(c.id); }); // #305 错配/低置信卡一并剔除
  const done = (state.competitors || []).filter(c => c.status === 'done' && !excluded.has(c.id));
  const total = done.length;
  const dims = {
    '渠道': c => Object.values(c.channels || {}).some(r => r && r.basis === 'verified'),
    '口碑': c => !!(c.reviews && c.reviews.rating != null && c.reviews.basis !== 'unverified'),
    '价格': c => (c.pricePoints || []).length > 0 || (c.priceBand && c.priceBand.basis !== 'unverified'),
    '卖点': c => (c.sellingPoints || []).length > 0,
    '打法': c => (c.tactics || []).length > 0,
    '动作': c => (c.recentMoves || []).some(m => m && m.basis === 'verified'),
    '定位': c => !!(typeof c.positioning === 'string' ? c.positioning : (c.positioning && (c.positioning.valueProposition || c.positioning.targetAudience || c.positioning.differentiation)))
  };
  const cov = {};
  const detected = [], undetected = [];
  for (const [name, fn] of Object.entries(dims)) {
    const present = done.filter(fn).length;
    const ratio = total ? present / total : 0;
    cov[name] = { present, total, ratio };
    (ratio < 0.5 ? undetected : detected).push(name);
  }
  return { cov, detected, undetected, total };
}
// ---- #304 字段撕裂交叉校验：discover 归类推测 vs enrich 官网实抓事实 ----
// 发现阶段按名字/赛道推测归类，深研抓到官网事实后应交叉校验；若两者明显不符，
// 标记 categoryTearing（不再让同卡 why/products/positioning 自相矛盾），
// 以事实为准、保留发现理由供用户裁决（忠实助理：不替用户下结论）。
function crossValidateTearing(comp, track) {
  const t = String(track || '').toLowerCase();
  const cats = (comp.categories || []).join(' ').toLowerCase();
  const pos = ((comp.positioning && comp.positioning.valueProposition) || '').toLowerCase();
  const why = String(comp.why || '').toLowerCase();
  if (!t || !cats) return; // 无赛道或无实抓品类 → 无法判定
  const trackTokens = t.split(/[\s/,&]+/).map(s => s.trim()).filter(s => s.length >= 2);
  if (!trackTokens.length) return;
  const hitTrack = trackTokens.some(tok => cats.includes(tok) || pos.includes(tok));
  const whyClaimsTrack = trackTokens.some(tok => why.includes(tok));
  if (whyClaimsTrack && !hitTrack) {
    comp.categoryTearing = true;
    comp.tearingNote = `发现阶段推测「${comp.discoverWhy || comp.why}」；官网事实主营「${(comp.categories || []).join('、') || '未知'}」，疑似非本赛道对手，请核实是否保留`;
  }
}

// ▶ #308：evidenceCount 与 basis 一致性 —— verified 卡须有实际捕获的证据，否则降级 inferred
// 深研阶段官网/Shopify 实抓得到的 basis=verified 字段是真实证据，但 comp.evidenceCount（发现期搜索命中数）
// 在深研时未被累加，导致"evidenceCount=0 却 basis=verified"的矛盾。此处：① 把实抓 verified 证据计入 evidenceCount；
// ② 防御性兜底：仍有字段标 verified 但整卡零证据（既无 sources 也非确认缺席）→ 降级 inferred 并补推理说明。
function enforceBasisEvidence(comp) {
  if (!comp || typeof comp !== 'object') return;
  let captured = 0;
  const verifiedFields = [];
  const stack = [comp];
  const seen = new Set();
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    if (seen.has(o)) continue; seen.add(o);
    if (o.basis === 'verified') { captured++; verifiedFields.push(o); }
    for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === 'object') stack.push(v); }
  }
  // ① 实抓 verified 证据计入 evidenceCount（取与发现期证据的最大值，不回退）
  const prev = Number(comp.evidenceCount) || 0;
  if (captured > prev) comp.evidenceCount = captured;
  // ② 防御性兜底：字段标 verified 但整卡零证据 → 降级 inferred + 推理说明
  if (Number(comp.evidenceCount) === 0) {
    verifiedFields.forEach(o => {
      const hasSrc = Array.isArray(o.sources) && o.sources.length > 0;
      const verifiedAbsent = o.present === false; // 确认缺席也是 verified 证据
      if (!hasSrc && !verifiedAbsent) {
        o.basis = 'inferred';
        if (o.confidence === 'high') o.confidence = 'medium';
        o.note = (o.note ? o.note + '；' : '') + '推理：原标注 verified 但无来源证据，已降级为推断';
      }
    });
  }
}

// ---- #305 聚合过滤：错配/低置信卡（entityAmbiguous / categoryTearing）不得进赛道统计、空白视图分母、brief 基数 ----
// 仍保留在 s.competitors（UI 可见，供用户裁决是否排除），仅从聚合派生中剔除。
function aggExcludedSet(state) {
  const ex = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) ex.add(c.id); });
  return ex;
}
function aggComps(state) {
  const ex = aggExcludedSet(state);
  return (state.competitors || []).filter(c => c.status === 'done' && !ex.has(c.id));
}

function assembleFacts(state) {
  const _ex = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) _ex.add(c.id); }); // #305 错配/低置信卡不进报告事实基数
  const done = (state.competitors || []).filter(c => c.status === 'done' && !_ex.has(c.id));
  const facts = [];
  // ▶ 报告-数据同源：suspect = 该事实来自被标 flaggedOutlier（量级离谱降级）的对手 → 决策链需标"数据存疑"
  const addFact = (text, source, suspect, dim) => {
    if (facts.length >= 60) return;
    facts.push({ id: 'F' + (facts.length + 1), text, source: source || null, suspect: !!suspect, dim: dim || null });
  };
  done.forEach(c => {
    const suspect = !!c.flaggedOutlier; // 该对手被数据卫生③降级 → 其事实默认存疑
    const src = (key) => {
      const fs0 = (c.fieldSources || {})[key];
      return fs0 && fs0.length ? fs0[0].url : (c.url || null);
    };
    // 渠道（只取 verified 的，事实层不收推测；只报选中平台）
    const plat = (state.intent && state.intent.platforms);
    Object.keys(c.channels || {}).forEach(k => {
      if (plat && plat.length && !plat.includes(k)) return; // 越界平台不进报告
      const r = c.channels[k];
      if (r.basis !== 'verified') return;
      const t = channelTypeOf(k);
      let txt;
      if (t === 'content') {
        // content 渠道：无官方店≠空白，以种草声量表述，绝不写"确认未进驻"
        if (r.seedingVolume && r.seedingVolume !== 'none') txt = `${c.name} 在 ${k} 种草声量${seedingLabel(r.seedingVolume)}（${r.note || '核查'}）`;
        else if (r.present) txt = `${c.name} 已进驻 ${k} 官方店（${r.note || '核查'}）`;
        else return;
      } else {
        txt = `${c.name} ${r.present ? '已进驻' : '确认未进驻'} ${k}（${r.note || '核查'}）`;
      }
      addFact(txt, src('channels.' + k), suspect, '渠道');
    });
    // #309：标签化区分价格带 / 单品价；单品价明确标注「非价格带锚点」，避免 ¥35 之类的单 SKU 价被当成品牌价位
    if (c.priceBand && c.priceBand.basis === 'verified') addFact(`${c.name} 价格带 ${c.priceBand.range}（${c.priceVerified ? '官网实抓' : '公开标价'}）`, src('priceBand'), suspect, '价格');
    if ((c.pricePoints || []).filter(n => typeof n === 'number' && n > 0).length && (!c.priceBand || c.priceBand.basis !== 'verified')) {
      const _pp = c.pricePoints.filter(n => typeof n === 'number' && n > 0);
      addFact(`${c.name} 单品价 ${fmtMoney(Math.min(..._pp), c.currency)} 起（共 ${_pp.length} 款在售标价，非价格带锚点）`, src('pricePoints'), suspect, '价格');
    }
    if (c.reviews && c.reviews.basis !== 'unverified' && c.reviews.rating != null) addFact(`${c.name} 口碑评分约 ${c.reviews.rating}，负面主题：${(c.reviews.negThemes || []).slice(0, 3).join('/') || '无'}`, src('reviews'), suspect, '口碑');
    (c.recentMoves || []).slice(0, 2).forEach((m, i) => { if (m.basis === 'verified') addFact(`${c.name} 近期动作：${m.desc}（${m.when || '时间不详'}）`, src('recentMoves.' + i), suspect, '动作'); });
    if ((c.sellingPoints || []).length) addFact(`${c.name} 主打卖点：${c.sellingPoints.join('/')}`, c.url || null, suspect, '卖点');
    if ((c.tactics || []).length) addFact(`${c.name} 销售打法：${c.tactics.join('/')}`, c.url || null, suspect, '打法');
  });
  // 优化二：受控词表互斥冲突摘要（让"桶间重叠品牌数"在报告中可见）
  const spDim = state.blueOcean && state.blueOcean.dimensions && state.blueOcean.dimensions.sellingPoints;
  if (spDim && spDim.exclusivity && spDim.exclusivity.conflictBrandCount) {
    const pairs = Object.entries(spDim.exclusivity.overlapByPair)
      .map(([pair, n]) => `${pair.replace('|', '+')} 冲突 ${n} 家`).join('；');
    addFact(`卖点互斥冲突提示：${spDim.exclusivity.conflictBrandCount} 家品牌同时被标入互斥卖点组（${pairs}）；红/蓝海已按净计数（剔除低优先级标签）计算，原始计数仍保留，请复核是否为 legit 价值定位。`, null, false, '卖点');
  }
  return facts;
}
// 机器校验器 + 质检门（C5 宪法）：句级查引用 + 程序化校验 LLM 产出结构，不靠模型自觉
// v2（报告-数据同源架构）：删编造编号句 + 删无编号裸句（段/条均删，仅保留坦诚陈述/不确定标注/结构行）；依赖降级数据不再打徽章，改在"我们不知道"清单诚实提示复核
// 返回 { markdown, removed, flagged, suspectSentences, qc:{ checks:[{name,desc,pass}], passed, total, allPass } }
function isClaimLine(t) {
  if (!t || t.length < 15) return false;            // 过短行（连接词/小标题）不当作论断
  if (/^#{1,4}\s/.test(t)) return false;             // 标题
  if (/^>\s/.test(t)) return false;                  // 引用块（信号卡/空白卡内部自引用）
  if (/^\|/.test(t) || /^\s*\|/.test(t)) return false; // 表格
  if (/[：:—-]\s*$/.test(t)) return false;           // 结尾是冒号/破折号（列表引导句，非论断）
  if (/^(【|\[)/.test(t)) return false;              // 章节/标注前缀
  if (/(我们不知道|未探测|未采集|暂无法确认|尚未覆盖|数据不足|无法确定|无法核实|未证实|暂无)/.test(t)) return false; // 坦诚陈述放行
  if (/\[推算\]|置信度|低置信|估算|推测/.test(t)) return false; // 已诚实标不确定，非裸编
  return true;
}
function validateReport(md, factIds, gapIds, opts) {
  opts = opts || {};
  const okIds = new Set([...factIds, ...gapIds]);
  const suspectFacts = new Set(opts.suspectFactIds || []);
  const suspectGaps = new Set(opts.suspectGapIds || []);
  const lines = String(md || '').split('\n');
  let removed = 0, flagged = 0, suspectSentences = 0;
  let inAppendix = false;
  const out = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (/^#{1,4}\s*.*(附录|证据编号对照)/.test(t)) inAppendix = true;
    if (inAppendix) { out.push(raw); continue; }     // 机器生成的附录/对照表原样保留
    if (!t || /^#{1,4}\s/.test(t) || /^[-*]?\s*$/.test(t)) { out.push(raw); continue; } // 标题/空行放行
    const cites = (t.match(/\[([FG]\d+|O\d+)\]/g) || []).map(x => x.slice(1, -1));
    const bad = cites.filter(id => !okIds.has(id));
    if (bad.length) { removed++; continue; }          // 编造编号 → 整句删除
    // ▶ v2：无编号裸句（脑补句）——段/条一律删除，无处藏身
    if (!cites.length && isClaimLine(t)) { removed++; continue; }
    out.push(raw);
  }
  const clean = out.join('\n');

  // ---- 残留复核：clean 中不得再有编造编号 / 裸论断句 ----
  const residualBad = (clean.match(/\[([FG]\d+|O\d+)\]/g) || []).map(x => x.slice(1, -1)).filter(id => !okIds.has(id));
  const residualBare = clean.split('\n').filter(l => { const tt = l.trim(); const c = (tt.match(/\[([FG]\d+|O\d+)\]/g) || []).map(x => x.slice(1, -1)); return c.length === 0 && isClaimLine(tt); });

  const checks = [];
  const add = (name, desc, pass) => checks.push({ name, desc, pass: !!pass });
  const hasAny = (...subs) => subs.some(s => clean.includes(s));

  // 1 判断收束：「我们的判断」段存在且带 ≥3 条可溯源 insight
  const judgeBlock = clean.match(/#{1,3}\s*.*我们的判断[\s\S]*?(?=\n#{1,3}\s|$)/i);
  const judgeText = judgeBlock ? judgeBlock[0] : '';
  const judgeCites = (judgeText.match(/\[[FG]\d+|O\d+\]/g) || []).length;
  add('判断收束', '「我们的判断」段先给结论，并带 ≥3 条可溯源 insight', judgeText.length > 0 && judgeCites >= 3);

  // 2 引用纪律：编造编号句与无编号裸句均被删净（残留=0）
  add('引用纪律', `编造编号句已删 ${removed} 句，无残留裸句`, residualBad.length === 0 && residualBare.length === 0);

  // 3 as-of + 来源可点：文末附证据编号对照（可核验）
  add('as-of · 来源可点', '文末附证据编号对照（可核验），含数据来源/as-of',
    hasAny('证据编号对照', '附录') && /as-of|数据来源|来源/.test(clean));

  // 4 现状含细分 MECE：现状段含细分/区域且声明占比/不重不漏
  add('现状·细分 MECE', '现状段含细分/区域，并声明占比或维度不重不漏',
    hasAny('现状') && /(细分|区域|MECE)/.test(clean) && /(占比|不重不漏|加总|份额)/.test(clean));

  // 5 问题解释 why：问题段含 why 类表述
  add('问题·解释 why', '问题段含「因为/源于/导致」等 why 解释',
    hasAny('问题') && /(为什么|因为|原因|源于|导致|why)/i.test(clean));

  // 6 空白视图：机会段含空白卡
  add('含空白视图', '机会段含空白卡（竞品全无，差异化核心）',
    hasAny('机会') && /空白卡|\[空白 G/.test(clean));

  // 7 敢标不确定
  add('敢标不确定', '估算/推断均标 [推算]/置信度/低置信，无伪装精确',
    /\[推算\]|置信度|低置信|未证实|估算/.test(clean));

  // 8 立场忠实：主动指出未知（不伪装全知）
  add('立场忠实', '主动列出"我们不知道/未探测/未采集"，不伪装全知',
    /(我们不知道|未探测|未采集|暂无法确认|尚未覆盖|数据不足)/.test(clean));

  // 9 红线：无"你应该做 X"
  const noImperative = !/(你应该做|建议你立即|必须购买|务必|理应马上)/.test(clean);
  add('红线自检', '全文无「你应该做 X」替结论表述，决策权归用户', noImperative);

  const passed = checks.filter(c => c.pass).length;
  return {
    markdown: clean,
    removed,
    flagged,
    suspectSentences,
    qc: { checks, passed, total: checks.length, allPass: passed === checks.length }
  };
}
async function buildReport(state, config) {
  const dsKey = config.llm.apiKey;
  state.whiteSpace = computeWhiteSpace(state);
  // ▶ #307：两套机会打通 —— brief §三 同时承接「用户声音机会（口碑驱动）」与「市场空缺（卖点空缺）」，单一来源 lib/opportunity.js
  const _oppEx = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) _oppEx.add(c.id); });
  const _oppComps = (state.competitors || []).filter(c => c.status === 'done' && !_oppEx.has(c.id));
  const voiceOpp = computeOpportunityMap(_oppComps, { excluded: _oppEx });
  const allFacts = assembleFacts(state);
  // ▶ 报告-数据同源 原则3：维度完整性闸门 —— 未充分探测（覆盖率<50%）的维度，其事实不进入报告原料
  const dimCov = dimensionCoverage(state);
  const facts = allFacts.filter(f => !f.dim || dimCov.detected.includes(f.dim));
  const undetectedDims = dimCov.undetected;

  const ws = state.whiteSpace && !state.whiteSpace.hidden ? state.whiteSpace.gaps : [];
  // 机会 = 市场空缺（非文案空缺）；文案空缺(copyGap)单列"观察级"，不撑机会场面（原则4）
  const opps = ws.filter(g => g.level === 'opportunity' && !g.copyGap);
  const copyGaps = ws.filter(g => g.copyGap);

  // ▶ 决策链 deps（原则6）：依赖被降级(flaggedOutlier)对手的数据 → 整条标"数据存疑"
  const flaggedNames = new Set((state.competitors || []).filter(c => c.flaggedOutlier).map(c => c.name));
  const suspectFactIds = facts.filter(f => f.suspect).map(f => f.id);
  const suspectGapIds = opps.filter(g => (g.sources || []).some(s => flaggedNames.has(s.name))).map(g => g.gid);

  const factText = facts.map(f => `[${f.id}] ${f.text}`).join('\n');
  const gapText = opps.map(g => `[${g.gid}] (${g.dim}·置信${g.confidence}${g.speculative ? '·推测' : ''}) ${g.value}：${g.note}`).join('\n');
  const copyGapText = copyGaps.map(g => `[${g.gid}] (文案空缺·观察级) ${g.dim}·${g.value}：${g.note}`).join('\n');
  // ▶ #10：单家观察空白（样本<3）作为低置信观察喂给报告，但明确非群体共识
  const singleGaps = ws.filter(g => g.singleCompetitor);
  const singleGapText = singleGaps.map(g => `[${g.gid}] (单家观察·推测·非群体共识) ${g.dim}·${g.value}：${g.note}`).join('\n');
  // ▶ #307：用户声音机会（口碑驱动）作为 brief §三 的补充层，与 G# 市场空缺并列
  const voiceOppText = voiceOpp.hidden
    ? `(用户声音机会暂不可比：样本不足（${voiceOpp.brandsWithVoice || 0}/${voiceOpp.doneBrands || 0} 家有用户声音），不单列；详见「我们不知道」清单)`
    : (voiceOpp.themes || []).map(t => `[O${t.onum}] (${t.zone}·机会分${t.opportunity}·重要性${t.importance}·满意度${t.satisfaction}) ${t.label}：${t.denominatorText}`).join('\n');
  const singleMode = !!(state.whiteSpace && state.whiteSpace.singleMode);

  // ▶ 报告-数据同源 原则3/原则4："我们不知道"清单（未探测维度 + 文案空缺观察 + 降级数据）
  const weDontKnow = [];
  undetectedDims.forEach(d => {
    const c = dimCov.cov[d];
    weDontKnow.push(`- ${d}维度：本赛道仅 ${c.present}/${c.total} 家对手有可靠数据（覆盖率 ${(c.ratio * 100).toFixed(0)}% < 50%），本报告未引用该维度结论。`);
  });
  if (copyGaps.length) weDontKnow.push(`- 文案空缺（非市场空缺）：以下卖点/打法空缺仅基于"官网文案比对"（${copyGaps.length} 项），未验证市场层面需求，属观察级，不构成已确认的市场机会。`);
  if (singleMode) weDontKnow.push(`- 当前仅 ${state.whiteSpace.total} 家对手完成研究（<3），空白分析处于"单家观察"模式：下方单家留白仅为结构推测、非群体共识，补充至 ≥3 家后才会给出赛道级群体空白。`);
  if (suspectFactIds.length || suspectGapIds.length) weDontKnow.push(`- 部分结论依赖被降级（量级存疑 flaggedOutlier）对手的数据，可信度相对更低，建议在「我们的判断」段结合原始来源复核。`);
  const weDontKnowText = weDontKnow.length ? weDontKnow.join('\n') : '- （本次各维度探测覆盖较充分，暂无重大未探测项）';


  // 用户定位（价格段/卖点）整理成可读原点，喂给 LLM 与附录校准块
  const pos = assessPositioning(state);
  let posText = '(未填写定位——空白分析以全赛道为参照，未以你为锚点)';
  if (pos && pos.hasProfile) {
    const lines = [];
    if (pos.price) lines.push(`价格段：${pos.price.band.currency} ${pos.price.band.min}-${pos.price.band.max}，被 ${pos.price.contestedBy} 家同币种对手占据${pos.price.contestedNames.length ? `（${pos.price.contestedNames.join('、')}）` : ''}。`);
    if (pos.sellingPoints) lines.push('卖点：' + pos.sellingPoints.map(r => `「${r.label}」${r.claimedBy ? `被${r.claimedBy}家主打` : '无人主打（空白可占）'}`).join('；') + '。');
    if (pos.challenges.length) lines.push('已识别信号：' + pos.challenges.map(c => c.text).join(' '));
    posText = lines.join('\n');
  }

  const sys = `你是"知彼 Vantage"，站在用户（品牌负责人）那一边。基于给定的【事实清单F#】与【空缺清单G#】装配一份**研究级行业调研报告**（对标 Euromonitor / Nielsen / Similarweb 的产出标准：完整、准确、清晰、客观、每条可溯源）。
【结构（markdown，必须严格按此 4 段顺序，段标题用 ## 一、现状 / ## 二、问题 / ## 三、机会 / ## 四、我们的判断）】
## 一、现状
- 赛道正在发生什么：市场规模与趋势、细分与区域（标注占比，声明维度内部不重不漏）、头部竞争格局（对头部 3-5 家各给 Strengths 与可趁软肋 Cautions）。
- 趋势列 2-4 条、格局每条挂 [F#]。
- 无可靠赛道级量化数据时，必须明确写"未采集到赛道级量化数据，以下为公开行业资料推算，置信度低，需你二次核实"，并标 [推算]。
## 二、问题
- 站在用户视角，指出"不顺耳但有用"的问题：用户未被满足的需求、对手的软肋、已知风险与制约（Restraints / Challenges 放这里）。
- 每条先讲 what，再用"因为/源于/导致"解释 why，挂 [F#]。
## 三、机会
- 逐条复述下方【空缺清单 G# 市场机会】，每条用**空白卡**格式（用 > 引用块）：
- 同时补充下方【用户声音机会 O#（口碑驱动 · 补充层）】：这些是"重要但对手普遍没做好的地方"（用户抱怨 / 痛点聚类），作为补充层与 G# 市场空缺并列呈现；逐条带 [O#] 引用与分母（N/M 家对手提到），不得脱离 O# 编号编造。
  > **[空白 Gx]** 空白：… ／ 证据类型：… ／ 推理逻辑：… ／ 置信度：高|中|低 ／ 可行性提示：…
- 文案空缺（观察级 G#）提及须注明"基于官网文案比对，未验证市场层面"，不得当作市场空白大做文章。
## 四、我们的判断
- 综合上述给出"我们的判断"——这是对局势的**有倾向的评估，不是替你下结论，也不列行动建议**。
- 用 3-5 条判断句收束，每条必须带明确倾向（不要只罗列两面、不要留"见仁见智"式尾巴），并挂证据编号 [F#]/[G#]：
  · **最锋利的空白在哪**：给出你（助理）最看好的 1-2 个空白，句式如"我们判断 X 是当前最值得盯的空白"；若处于单家观察模式（样本<3、无群体空白），则基于"单家观察"给初步倾向，并明确标注"单家观察·推测，群体共识待≥3家"。
  · **最大风险在哪**：最该警惕的对手软肋或已知制约，给出明确"我们判断风险在 Y"。
  · **你（用户）定位的相对位置是否成立**：给出明确结论——"成立 / 偏乐观 / 偏保守"，并给一句理由（挂 [F#]/[G#]）。
- 倾向性表达边界：可以说"我们判断……""我们倾向认为……"，但**绝不写"你应该做 X / 建议你立即"**这类替结论的句子——决策权始终归用户。
- 说明数据来源、as-of 时间，并主动列出"我们不知道 / 未探测 / 未采集"的事项（基于下方清单），不伪装全知。
【铁律】
1. 你**不能**引入清单之外的"事实"。每一句论断句末必须标注引用编号 [F#] 或 [G#]；编造编号或**无任何编号的裸句**都会被系统自动删除（脑补句无处藏身）。
2. 敢标不确定：任何估算 / 推断必须标 [推算] 或置信度分级，绝不伪装精确。
3. 立场忠实：主动指出"你想进的方向已有强对手"这类不顺耳事实；主动标"相关于你的目标"；**绝不写"你应该做 X / 建议你立即"这类替结论的句子**——决策权始终归用户。
4. 不堆免责、不写通用行业套话；直接、有据。
5. **禁止常识外推**：你收到的【事实清单F#】【空缺清单G#】是你唯一可引用的"事实"来源；不得引入品牌常识/行业常识做推理（如"大牌所以渠道强""品类火热所以必有机会"）。【你的定位】是合法锚点（用户自身资料），其余背景信息仅供理解语境，不得作为 [F#]/[G#] 之外的引用。
6. **文案空缺 ≠ 市场空缺**：标记为"文案空缺·观察级"的 G# 仅基于官网文案比对，是观察不是已确认机会；提及须注明"基于官网文案比对，未验证市场层面"，不得将其当作市场空白大做文章。
直接输出 markdown，不要外层 json。`;
  const user = `赛道：${state.track}
用户意图/目标：${JSON.stringify(state.intent || {})}

【你的定位（空白分析原点，作为参照事实，合法锚点）】
${posText}

【事实清单 F#】（你唯一可引用的"事实"来源，句末必须引用其中编号）
${factText || '(无 verified 事实——请在执行摘要如实说明证据不足)'}

【空缺清单 G# · 市场机会】（已剔除"文案空缺"，见下方观察级）
${gapText || '(无)'}

【文案空缺 · 观察级 G#】（仅基于官网文案比对，非已确认市场机会，提及须注明"未验证市场层面"）
${copyGapText || '(无)'}

【单家观察 · 推测 G#】（样本<3，仅结构推理"该对手应做而未做"，非群体共识，提及须注明"单家观察·推测"）
${singleGapText || '(无)'}

【用户声音机会 O#（口碑驱动 · 补充层）】
${voiceOppText || '(无)'}

【我们不知道 / 未探测维度】（在「我们的判断」段如实列出，不伪装全知）
${weDontKnowText}

【维度覆盖提示】已充分探测（进入报告原料）的维度：${dimCov.detected.join('、') || '无'}；未充分探测（<50% 覆盖率，已排除出报告原料）的维度：${undetectedDims.join('、') || '无'}。`;
  const raw = await deepseekText([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'report' });
  // ▶ #10：单家观察 gap 的 gid 也纳入合法引用集（否则 LLM 引用单家留白会被 validateReport 当编造编号删除）
  const citedGapIds = opps.map(g => g.gid).concat(singleGaps.map(g => g.gid)).concat(voiceOpp.hidden ? [] : (voiceOpp.themes || []).map(t => 'O' + t.onum));
  const v = validateReport(raw, facts.map(f => f.id), citedGapIds, { suspectFactIds, suspectGapIds });
  // 附录：编号对照表（可点开核验来源 URL —— "每条可验证"红线）
  const appendix = ['\n---\n### 附录 · 证据编号对照'];
  facts.forEach(f => appendix.push(`- **${f.id}** ${f.text}${f.source ? ` — [来源](${f.source})` : ''}`));
  opps.forEach(g => appendix.push(`- **${g.gid}** [${g.dim}] ${g.value}（置信度 ${g.confidence}${g.speculative ? '·推测' : ''}）`));
  singleGaps.forEach(g => appendix.push(`- **${g.gid}** [单家观察·推测] ${g.dim}·${g.value}（置信度 ${g.confidence}）`));
  (voiceOpp.hidden ? [] : (voiceOpp.themes || [])).forEach(t => appendix.push(`- **O${t.onum}** [${t.zone}] ${t.label}（机会分 ${t.opportunity} · 重要性 ${t.importance} · 满意度 ${t.satisfaction} · ${t.denominatorText}）`));
  // 机器生成的"定位校准"块（事实、不依赖 LLM，保证敢挑战的内容一定在、且不被模型改写）
  let calib = '';
  if (pos && pos.hasProfile) {
    calib = '\n\n---\n### 定位校准 · 基于你填写的价格段 / 卖点（机器核对，非模型生成）\n';
    if (pos.price) {
      calib += `- **价格段** ${pos.price.band.currency} ${pos.price.band.min}–${pos.price.band.max}：被 **${pos.price.contestedBy}** 家同币种对手占据${pos.price.contestedNames.length ? `（${pos.price.contestedNames.join('、')}）` : ''}。\n`;
    }
    if (pos.sellingPoints) {
      calib += '- **卖点对照**（你选的 vs 对手是否在做）：\n';
      pos.sellingPoints.forEach(r => {
        calib += `  - 「${r.label}」：${r.claimedBy ? `被 ${r.claimedBy} 家主打${r.claimedNames.length ? `（${r.claimedNames.join('、')}）` : ''} —— 红海方向` : '**无人主打 —— 空白可占**'}。\n`;
      });
    }
    if (pos.challenges.length) {
      calib += '- **值得正视的信号**（不顺耳但有用）：\n' + pos.challenges.map(c => `  - ${c.text}`).join('\n') + '\n';
    }
  }
  // #310 体验报告版本锚定：报告末尾附生成元数据，且对象层暴露 generatedBy 供前端复用
  const _genFooter = reportProvenance(APP_VERSION, APP_COMMIT, STARTED_AT);
  return {
    generatedAt: new Date().toISOString(),
    asOf: new Date().toISOString().slice(0, 10),
    markdown: (v.markdown || '（报告生成失败）') + calib + appendix.join('\n') + _genFooter,
    generatedBy: { version: APP_VERSION, commit: APP_COMMIT, startedAt: STARTED_AT },
    audit: { facts: facts.length, gaps: opps.length, removedSentences: v.removed, flaggedSentences: v.flagged, suspectSentences: v.suspectSentences },
    qc: v.qc
  };
}

// ============================================================
// 路由
// ============================================================
async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ---------- Phase 1 · L-可观测层：请求日志 + 指标（零侵入，不改行为） ----------
  const reqStart = Date.now();
  Logger.withRequestId(req);
  res.on('finish', () => {
    const status = res.statusCode || 200;
    Metrics.recordRequest(status, Date.now() - reqStart);
    Logger.logRequest(req, p, status, Date.now() - reqStart, null);
    Logger.clearRequestId();
  });

  // ---------- 多租户骨架路由（v0.2） ----------
  // 优先拦截新接口；未命中则交还下方旧路由（旧"单 key 无登录"接口保持原样）。
  try {
    const config = loadConfig(); // config 在各旧路由块内才声明，这里独立加载供身份解析用
    const handled = await handleTenantRoutes(req, res, { p, url, config });
    if (handled) return;
  } catch (e) {
    sendJSON(res, 500, { error: 'TENANT_ROUTE_ERROR', detail: String(e && e.message || e) });
    return;
  }

  // ---------- 平台超管路由（v0.2，§6.1） ----------
  // 独立 admin 凭证（与租户 JWT 不同密钥），绝不污染租户通道；未命中则交还下方旧路由。
  try {
    const config = loadConfig();
    const handledAdmin = await handleAdminRoutes(req, res, { p, url, config });
    if (handledAdmin) return;
  } catch (e) {
    sendJSON(res, 500, { error: 'ADMIN_ROUTE_ERROR', detail: String(e && e.message || e) });
    return;
  }

  // ---------- 鉴权门（生产止血 P0-1）：所有 /api/* 端点要求有效身份令牌 ----------
  // handleTenantRoutes / handleAdminRoutes 已处理的登录/注册/超管类不在此列；静态资源也不在。
  // 拒绝匿名调用，防止搜索/LLM 预算被任意刷爆（审计"API 鉴权缺失"致命项）。
  if (p.startsWith('/api/')) {
    // IP 管控（P1-4.3）：作为最外层边界，先于鉴权执行。封禁地址一律 403；
    // 白名单非空时仅放行显式允许的地址（含匿名请求也先过此关，否则白名单形同虚设）。
    if (!ipguard.evaluate(clientIp(req))) {
      return sendJSON(res, 403, { error: 'IP_BLOCKED', message: '你的访问地址已被禁止。' });
    }
    // 公开端点（版本锚定/登录/注册）：绕过鉴权，但 POST 仍限流（防刷/防暴力破解）。
    // 仍受外层 IP 管控约束。
    if (p === '/api/version' || p === '/api/login' || p === '/api/register') {
      // 落到下方路由处理（已绕过鉴权）
      if (req.method === 'POST' && rateLimited(clientIp(req), 'post', 60, 60000)) {
        return sendJSON(res, 429, { error: 'RATE_LIMIT', message: '请求过于频繁，请稍后再试。' });
      }
    } else {
      const authPayload = getAuthPayload(req);
      if (!authPayload) return sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' });
      // 全局 POST 限流（防刷/防账单失控）
      if (req.method === 'POST' && rateLimited(clientIp(req), 'post', 60, 60000)) {
        return sendJSON(res, 429, { error: 'RATE_LIMIT', message: '请求过于频繁，请稍后再试。' });
      }
    }
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

  // ---------- Phase 1 · L-接入层：注册表路由分发（声明式） ----------
  // 全部 /api 端点由 routes/index.js 注册表接管；未注册路径 → 404。
  // ctx = 依赖注入：handler 经 ctx 访问服务函数与常量，不直接 require server.js。
  {
    const routeCtx = {
      sendJSON, readBody, loadState, saveState, decorateState, computeWhiteSpace,
      marketCurrency, buildVersionInfo, getAuthPayload, rateLimited, clientIp,
      DomainRunner, DomainReg, MatEngine, M, QD, UN, VC, Agg, SW, TR,
      compareField, constructFeedbackReport, extractCandidateRules,
      Metrics, Logger, DATA,
      // 采集/研究组依赖
      sseClients, discoverGate, discoverFn: runDiscover, discoverLaunch, enrichOne, lookupBrand,
      // ▶ 加固（0812 体验报告）：暴露发现事件回放读取（无参→最近一次发现的事件）
      discoverReplay: (pid) => discoverReplay.get(pid || lastDiscoverProjectId) || [],
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

  // ---------- Phase 5 清理：旧静态前端（app/public）已删除 ----------
  // 服务转为纯 API 后端（HTTP 入口走 zhibi-web 容器反代）；未注册路径统一 404 JSON。
  sendJSON(res, 404, { error: 'NOT_FOUND', message: '接口不存在。Web 入口请走 :3000。' });
}

// 真正的 HTTP 服务入口：在请求进入时解出 tenantId 注入 AsyncLocalStorage（P0-2.1），
// 使 loadState / getCurrentId 等在无显式 tenantId 时也能取到正确命名空间；
// 后台 detached 队列（runQueue）脱离请求上下文，靠 state.tenantId 兜底。
const server = http.createServer((req, res) => {
  // T1-2：入口层统一身份解析 + suspended 封禁裁决（resolveIdentity 含 403 TENANT_SUSPENDED）。
  // 旧 getAuthPayload 不查 suspended，是 R2「封禁绕过」的真缺口；旧研究端点靠此入口注入 requestScope，
  // 故在此一处拦截即覆盖 discover/enrich/lookup/timeline/field-correct/state 全部旧端点。
  const id = resolveIdentity(req, config0);
  if (id.error === 403) {
    sendJSON(res, 403, { error: 'TENANT_SUSPENDED', message: '该租户已被暂停，请联系平台管理员。' });
    return;
  }
  // 401（无令牌/令牌失效）：保留旧行为 —— 交给 handleRequest 的 /api/* 鉴权门裁决（公开端点 /api/version 例外放行）。
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
