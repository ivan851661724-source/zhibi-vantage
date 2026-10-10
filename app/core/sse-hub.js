'use strict';
// ============================================================
// core/sse-hub.js —— SSE 推送中枢（按租户分通道）
// 修复（原 server.js 全局 sseClients 广播的跨租户泄露）：
//   · 连接按 tenantId 分桶，业务事件（discover_* / brand_*）只投递给所属租户；
//   · 回放缓冲按 (tenantId, projectId) 隔离，新连客户端只回放自己租户的事件；
//   · 通用 'change' 事件不含业务数据，保持全局广播；
//   · 解析不出租户的业务事件一律丢弃（fail-closed），绝不跨租户兜底。
// ============================================================
const { getTenantCtx } = require('./als.js');

// 租户通道键统一归一：emitSSE 携带的 tenantId（state-store.resolveTenantId，已 sanitize，
// 'tenant_8cf0…'）与 /api/stream 连接注册的 tid（ALS RAW，'tenant:8cf0…'）必须落进同一个桶——
// 此前两侧键格式不一致（冒号 vs 下划线），scoped 业务事件全部投进无人订阅的桶（实证：前端
// 进度只能靠轮询兜底，冒烟脚本 SSE 断言恒空）。
// ⚠️ 此处必须内联实现、不能 require state-store：server.js 经 research/discover.js 加载本模块时
// 存在加载环（state-store 完成时会整体替换 module.exports，环内捕获到的引用永远是空对象），
// 解构和延迟属性访问都已实证失败。逻辑与 state-store.sanitizeNs 逐字一致，由 sse-hub.test.js 锁定行为一致。
function normTid(tid) {
  if (!tid) return tid;
  return String(tid).replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || '_legacy';
}

// 每租户最大 SSE 连接数（防 FD/内存耗尽；超出返回 false 由调用方回 503）
const MAX_CLIENTS_PER_TENANT = 5;
// 每项目回放事件上限（防内存无界；新连客户端回放最近发现事件，消除 discover_error 错过竞态）
const DISCOVER_REPLAY_MAX = 50;
// 每租户回放项目数上限（防长期运行无界增长：项目数 × 50 条缓冲只增不减）。
// 回放只读 lastProjectByTenant 指向的最新项目，按插入序淘汰旧项目缓冲是安全的。
const MAX_REPLAY_PROJECTS = 8;

// 携带业务数据、必须按租户隔离的事件类型
const SCOPED_TYPES = new Set(['discover_stage', 'brand_found', 'brand_removed', 'discover_complete', 'discover_error']);

const clients = new Map();            // tenantId -> Set<res>
const replay = new Map();             // tenantId -> Map<projectId, [{type,payload}]>
const lastProjectByTenant = new Map(); // tenantId -> 最近发现的 projectId

function clientsOf(tid) {
  let s = clients.get(tid);
  if (!s) { s = new Set(); clients.set(tid, s); }
  return s;
}

// 通用变更信号（无业务数据）：全局广播
function broadcastChange() {
  const payload = 'data: ' + JSON.stringify({ type: 'change', ts: Date.now() }) + '\n\n';
  for (const set of clients.values()) {
    set.forEach(c => { try { c.write(payload); } catch { set.delete(c); } });
  }
}

// 渐进式发现：携带业务 type 的 typed 事件，按租户投递。
// tenantId 解析顺序：payload.tenantId（后台队列显式带上）> 请求上下文 ALS。
function emitSSE(type, payload) {
  const data = Object.assign({}, payload || {});
  const tid = normTid(data.tenantId || getTenantCtx());
  if (SCOPED_TYPES.has(type)) {
    const pid = data.projectId || (tid ? lastProjectByTenant.get(tid) : null);
    if (tid && pid) {
      let perTenant = replay.get(tid);
      if (!perTenant) { perTenant = new Map(); replay.set(tid, perTenant); }
      let buf = perTenant.get(pid);
      if (!buf) { buf = []; perTenant.set(pid, buf); }
      buf.push({ type, payload: data });
      if (buf.length > DISCOVER_REPLAY_MAX) buf.shift();
      lastProjectByTenant.set(tid, pid);
      // 淘汰超限的旧项目缓冲（插入序最旧者）；当前活跃项目 pid 永不在淘汰中
      while (perTenant.size > MAX_REPLAY_PROJECTS) {
        const oldest = perTenant.keys().next().value;
        if (oldest === pid) break;
        perTenant.delete(oldest);
      }
    } else if (!tid) {
      // fail-closed：解析不出租户的业务事件不投递、不入回放（杜绝跨租户兜底）
      try { console.warn('[sse] drop scoped event without tenantId:', type); } catch (e) {}
    }
  }
  if (!tid) return; // 无租户上下文：仅上面可能已记录，不广播
  const set = clients.get(tid);
  if (!set || !set.size) return;
  const wire = Object.assign({}, data);
  delete wire.tenantId; // 租户内部标识不下发
  const line = 'data: ' + JSON.stringify(Object.assign({ type }, wire)) + '\n\n';
  set.forEach(c => { try { c.write(line); } catch { set.delete(c); } });
}

// 建立 SSE 连接（res 已写好响应头）。tid 为该连接所属租户（调用方从鉴权态解出）。
// 返回 cleanup 函数；超出租户连接上限时返回 null（调用方回 503）。
function connect(res, tid) {
  const tidN = normTid(tid);
  const set = clientsOf(tidN);
  if (set.size >= MAX_CLIENTS_PER_TENANT) return null;
  set.add(res);
  res.write('retry: 3000\n\n');
  res.write(': connected\n\n');
  // 回放本租户最近一次发现的事件（晚连不错过 discover_error 等）
  try {
    const pid = lastProjectByTenant.get(tidN);
    const buf = pid && replay.get(tidN) && replay.get(tidN).get(pid);
    if (buf && buf.length) {
      for (const ev of buf) {
        const wire = Object.assign({}, ev.payload || {});
        delete wire.tenantId;
        try { res.write('data: ' + JSON.stringify(Object.assign({ type: ev.type }, wire)) + '\n\n'); } catch (e) {}
      }
    }
  } catch (e) {}
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    clearInterval(ping);
    const s = clients.get(tidN);
    if (s) { s.delete(res); if (!s.size) clients.delete(tidN); }
  };
}

// 可观测性：当前连接数/租户数
function stats() {
  let total = 0;
  for (const s of clients.values()) total += s.size;
  return { connections: total, tenants: clients.size };
}

module.exports = { broadcastChange, emitSSE, connect, stats, MAX_CLIENTS_PER_TENANT, MAX_REPLAY_PROJECTS };
