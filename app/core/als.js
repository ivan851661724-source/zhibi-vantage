'use strict';
// ============================================================
// core/als.js —— 请求级租户上下文（AsyncLocalStorage）
// 在 http.createServer 入口把请求解出的 tenantId 注入 ALS，供
// loadState / getCurrentId / metering 等在请求内（无显式 tenantId）时取用。
// 后台队列脱离请求上下文时，靠 state.tenantId 兜底（见 state-store.saveState）。
// ============================================================
const { AsyncLocalStorage } = require('async_hooks');

const requestScope = new AsyncLocalStorage();

// 当前租户标识：请求内走 ALS；脱离请求（后台队列）由调用方显式传 tenantId，
// 均无则 '_legacy'。
// ⚠️ 必须用 RAW tid（如 'tenant:8cf0aebaebd1'），不能 sanitizeNs：metering/db 的租户键
// 是原始 id（带冒号），一旦 sanitize（冒号→下划线）会导致配额检查与计费落到幽灵键。
// 文件目录才用 sanitizeNs（见 state-store.tenantDir）。
function curTenantId() {
  const fromCtx = requestScope.getStore();
  return fromCtx || '_legacy';
}

// 供 SSE 等无法显式传参的链路取当前租户（可能为 null）
function getTenantCtx() {
  return requestScope.getStore() || null;
}

module.exports = { requestScope, curTenantId, getTenantCtx };
