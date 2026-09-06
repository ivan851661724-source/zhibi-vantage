'use strict';
// ============================================================
// provider 健康度（模块 2-2）—— 跨 provider 路由的健康度记录
// 现有 serper 多 key failover 之上的外层：主 provider（config 指定）
// 失败时按序尝试备用源（Serper→Brave→Bocha→Tavily）。
// 本模块只做「记录 + 判定」，路由顺序由调用方（searchProvider）编排。
// ============================================================

const PROVIDERS = ['serper', 'brave', 'bocha', 'tavily'];

const ST = {};
PROVIDERS.forEach(p => {
  ST[p] = { ok: 0, fail: 0, lastFailAt: 0, lastErr: '' };
});

function recordOk(p) {
  if (ST[p]) { ST[p].ok++; }
}

function recordFail(p, err) {
  if (!ST[p]) return;
  ST[p].fail++;
  ST[p].lastFailAt = Date.now();
  ST[p].lastErr = String((err && err.message) || err || '').slice(0, 120);
}

// 健康判定：10 分钟内有失败记录且失败率 ≥ 60% 且样本 ≥ 3 → 不健康（路由时优先跳过）
// 最小样本保护：偶发单次失败（样本 < 3）不裁决，避免网络抖动误判
function isHealthy(p) {
  const s = ST[p];
  if (!s || !s.fail) return true;
  if (Date.now() - s.lastFailAt > 600000) return true; // 10 分钟无新失败 → 视为恢复
  if (s.ok + s.fail < 3) return true;                  // 样本太少不裁决
  const rate = s.fail / (s.ok + s.fail);
  return rate < 0.6;
}

function snapshot() {
  const out = {};
  PROVIDERS.forEach(p => {
    const s = ST[p];
    out[p] = {
      ok: s.ok, fail: s.fail,
      healthy: isHealthy(p),
      lastFailAt: s.lastFailAt || null,
      lastErr: s.lastErr || null,
    };
  });
  return out;
}

module.exports = { PROVIDERS, recordOk, recordFail, isHealthy, snapshot };
