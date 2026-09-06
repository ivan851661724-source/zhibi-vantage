'use strict';
// ============================================================
// 路由注册表（Phase 1 · L-接入层）
// ------------------------------------------------------------
// 声明式路由：加端点 = 注册表加一行 + handlers/ 一个文件。
// handler 签名：async (ctx, req, res, url, p) => boolean
//   - 处理并已发响应 → 返回 true（调用方停止后续分发）
//   - 未处理（不匹配）→ 返回 false（交还旧路由/静态服务）
// ctx 由 server.js 组装（依赖注入），含 handler 所需的全部
// 服务函数与常量（loadState/decorateState/sendJSON/...）。
//
// 渐进式接管纪律（Phase 1）：
//   server.js 的 handleRequest 先查本注册表，命中则走 handler；
//   未命中继续走旧 if/else（保证任一时刻行为不变，可逐步迁移）。
//   auth 字段为声明（public/tenant/admin），供中间件链参考；
//   现有端点内部原有的鉴权逻辑保持不变，不在此重复实现。
// ============================================================

const routes = [];

// 注册一个路由。path 支持精确串；method 为 'GET'|'POST'|'ALL'。
function register(method, path, auth, handler) {
  routes.push({ method: method === 'ALL' ? 'ALL' : method.toUpperCase(), path, auth: auth || 'public', handler });
}

// 按 method+path 精确匹配（可扩展为模式匹配：先精确，后续可加 :param）
function match(method, pathname) {
  const m = String(method || '').toUpperCase();
  for (const r of routes) {
    if (r.method !== 'ALL' && r.method !== m) continue;
    if (r.path === pathname) return r;
  }
  return null;
}

// 分发：命中则执行 handler，返回 true；未命中返回 false。
async function dispatch(ctx, req, res, url, p) {
  const r = match(req.method, p);
  if (!r) return false;
  try {
    const handled = await r.handler(ctx, req, res, url, p);
    return handled === false ? false : true;
  } catch (e) {
    // handler 异常统一出口：不裸 500（评审纪律）
    const sendJSON = (ctx && ctx.sendJSON) || ((_res, code, obj) => {
      _res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      _res.end(JSON.stringify(obj));
    });
    sendJSON(res, 500, { error: 'SERVER_ERROR', message: String(e && e.message || e) });
    return true;
  }
}

// 供健康检查/调试查看注册数量
function list() { return routes.map(r => ({ method: r.method, path: r.path, auth: r.auth })); }

module.exports = { register, match, dispatch, list };
