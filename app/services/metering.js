'use strict';
// ============================================================
// 会员额度与计量（v0.2）—— 计费裁决核心是 P0-2 修正
// 计费判定以"外部 HTTP 响应状态码"为准，杜绝成本黑洞：
//   · 2xx（成功）或 5xx（服务端错误） → 计 1（供应商按"到达其服务器即计费"，5xx 也扣）
//   · 4xx（客户端错误）或 网络超时/连接失败 → 不计
// 另：failover 多 key 重试去重，一次搜索只计一次（在调用方保证，此处只判单笔）。
//
// ⚠️ 配额开关（2026-08-11 产品决策：定价/收费落地前不卡用户）：
//   ZB_QUOTA_ENABLED 未设 '1'（默认）→ withinQuota 恒 true，全量放行；
//   计量（recordCall/usage）照常记录——为将来恢复配额保留数据。
//   恢复方式：ZB_QUOTA_ENABLED=1 即重新启用 PLAN_LIMITS。
// 配额口径：按 billed（供应商真扣费）计数比较——4xx 免费调用不吃用户配额，
// 防止异常流量把免费档额度刷满而平台零成本方向。
// ============================================================
const db = require('./db.js');

const QUOTA_ENABLED = process.env.ZB_QUOTA_ENABLED === '1';

// 档位限额（R5.1 收敛：MVP 统一免费档——单一 free，外加每租户每日全景调研次数上限，
// 见下方 withinDailyDiscover。历史 starter/growth/scale 档已按 PRD 移除；恢复付费档时
// 在此加行并把 planOf 接回订阅态即可）
const PLAN_LIMITS = {
  free:    { searchCalls: 50,  enrichRuns: 5,  projects: 1 }
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
  const p = (t && t.plan) || 'free';
  return PLAN_LIMITS[p] ? p : 'free'; // 单档收敛：任何非 free 存量档一律按 free 计
}

// 是否还在配额内（按 billed 计数比较；4xx 不计费不占配额）
// ZB_QUOTA_ENABLED 未设 '1'（默认）→ 全量放行（定价前不卡用户体验）；计量照常记录。
function withinQuota(tenantId, kind) {
  if (!QUOTA_ENABLED) return true;
  const plan = planOf(tenantId);
  const limit = (PLAN_LIMITS[plan] && PLAN_LIMITS[plan][kind]);
  if (limit == null) return true; // 未定义限额的种类不卡
  const u = usage(tenantId);
  const used = (u[kind] && (u[kind].billed != null ? u[kind].billed : u[kind].total)) || 0;
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

// ---------------- R5.1：单免费档·每租户每日 N 次全景调研（防滥用上限，默认启用） ----------------
// 值可配置：ZB_FREE_DAILY_DISCOVERS（默认 3）；总开关 ZB_DAILY_QUOTA_ENABLED=0 关闭（默认开）。
const DAILY_ENABLED = process.env.ZB_DAILY_QUOTA_ENABLED !== '0';
function dailyDiscoverLimit() {
  const n = parseInt(process.env.ZB_FREE_DAILY_DISCOVERS || '3', 10);
  return Number.isFinite(n) && n > 0 ? n : 3;
}
function withinDailyDiscover(tenantId) {
  if (!DAILY_ENABLED) return true;
  if (!tenantId || tenantId === '_legacy') return true; // 遗留通道不卡（ghost 无租户配额概念）
  return db.getDaily(tenantId, 'discover') < dailyDiscoverLimit();
}
function recordDailyDiscover(tenantId) {
  if (!tenantId || tenantId === '_legacy') return;
  db.bumpDaily(tenantId, 'discover', 1);
}
function dailyDiscoverUsage(tenantId) {
  return { used: db.getDaily(tenantId, 'discover'), limit: dailyDiscoverLimit(), enabled: DAILY_ENABLED };
}

module.exports = { QUOTA_ENABLED, PLAN_LIMITS, shouldBill, classifyExternal, recordCall, usage, withinQuota, quotaInfo, planOf, dailyDiscoverLimit, withinDailyDiscover, recordDailyDiscover, dailyDiscoverUsage };
