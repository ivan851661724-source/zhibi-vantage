'use strict';
// ============================================================
// 会员额度与计量（v0.2）—— 计费裁决核心是 P0-2 修正
// 计费判定以"外部 HTTP 响应状态码"为准，杜绝成本黑洞：
//   · 2xx（成功）或 5xx（服务端错误） → 计 1（供应商按"到达其服务器即计费"，5xx 也扣）
//   · 4xx（客户端错误）或 网络超时/连接失败 → 不计
// 另：failover 多 key 重试去重，一次搜索只计一次（在调用方保证，此处只判单笔）。
//
// ⚠️ 配额开关（2026-08-11 产品决策：定价/收费落地前不卡用户）：
//   QUOTA_ENABLED=false（默认）→ withinQuota 恒 true，全量放行；
//   计量（recordCall/usage）照常记录——为将来恢复配额保留数据。
//   恢复方式：QUOTA_ENABLED=true（环境变量）即重新启用 PLAN_LIMITS。
// ============================================================
const db = require('./db.js');

const QUOTA_ENABLED = process.env.ZB_QUOTA_ENABLED === '1';

// 档位限额（第一版示例，待定价；Phase-2 接 Stripe 后由订阅态驱动）
const PLAN_LIMITS = {
  free:    { searchCalls: 50,  enrichRuns: 5,  projects: 1 },
  starter: { searchCalls: 500, enrichRuns: 50, projects: 5 },
  growth:  { searchCalls: 3000, enrichRuns: 300, projects: 20 },
  scale:   { searchCalls: 20000, enrichRuns: 2000, projects: 100 }
};

// 单笔外部调用是否计费
//   status: number（HTTP 状态码）| 或 {error:'timeout'|'network'|'dns'|...}（网络层失败）
function shouldBill(status) {
  if (status && typeof status === 'object') return false; // 网络层失败：超时/连接失败 → 不计
  const s = Number(status);
  if (!Number.isFinite(s)) return false;
  if (s >= 200 && s < 300) return true; // 成功
  if (s >= 500) return true;            // 服务端错误，供应商仍扣费
  return false;                         // 4xx 客户端错误 → 不计
}

// 把一次外部结果翻译成计费结论
function classifyExternal(result) {
  if (!result) return { billed: false };
  if (result.error) return { billed: false, reason: result.error }; // timeout/network
  return { billed: shouldBill(result.status), status: result.status };
}

// 在平台级出口调用：记一笔计量（billed 仅当供应商真扣费）
function recordCall(tenantId, kind, billed) {
  return db.bumpMetering(tenantId, kind, billed ? 1 : 0);
}

function usage(tenantId) { return db.getMetering(tenantId); }

function planOf(tenantId) {
  const t = db.getTenant(tenantId);
  return (t && t.plan) || 'free';
}

// 是否还在配额内（按 total 调用数比较）
// QUOTA_ENABLED=false（默认）→ 全量放行（定价前不卡用户体验）；计量照常记录。
function withinQuota(tenantId, kind) {
  if (!QUOTA_ENABLED) return true;
  const plan = planOf(tenantId);
  const limit = (PLAN_LIMITS[plan] && PLAN_LIMITS[plan][kind]);
  if (limit == null) return true; // 未定义限额的种类不卡
  const u = usage(tenantId);
  const used = (u[kind] && u[kind].total) || 0;
  return used < limit;
}

function quotaInfo(tenantId) {
  const plan = planOf(tenantId);
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
  const u = usage(tenantId);
  const out = { plan, limits: {}, used: {} };
  for (const k of Object.keys(limits)) {
    out.limits[k] = limits[k];
    out.used[k] = (u[k] && u[k].total) || 0;
  }
  return out;
}

module.exports = { QUOTA_ENABLED, PLAN_LIMITS, shouldBill, classifyExternal, recordCall, usage, withinQuota, quotaInfo, planOf };
