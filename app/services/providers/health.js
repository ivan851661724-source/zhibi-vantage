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
  ST[p] = { ok: 0, fail: 0, lastFailAt: 0, lastErr: '', exhausted: false };
});

function recordOk(p) {
  if (ST[p]) { ST[p].ok++; ST[p].exhausted = false; } // 成功证明源恢复 → 清 exhausted
}

// 判定失败是否额度/配额类（402/429/额度耗尽/key 失效）→ 进程内早退信号
// 2026-09-06 B-01：全源 402/429 时不再每 query 把配置源全打一遍（额度结算周期内不会恢复，等同 serper 多 key 的 disabled 语义）
const EXHAUST_RE = /QUOTA|EXHAUST|_402|_429|_403/i;
function recordFail(p, err) {
  if (!ST[p]) return;
  ST[p].fail++;
  ST[p].lastFailAt = Date.now();
  const msg = String((err && err.message) || err || '');
  ST[p].lastErr = msg.slice(0, 120);
  if (EXHAUST_RE.test(msg)) ST[p].exhausted = true; // 额度类 → 进程内永久跳过（直到重启）
}

// 额度耗尽标记：比「不健康」更硬——exhausted 源进程内直接跳过候选，不再尝试
// 时间衰减：429 限流窗口 10 分钟，到期自动重试（若额度真耗尽会再次标记，每 10 分钟至多 1 次尝试）
function isExhausted(p) {
  const s = ST[p];
  if (!s || !s.exhausted) return false;
  if (Date.now() - s.lastFailAt > 600000) { s.exhausted = false; return false; }
  return true;
}

// 健康判定：exhausted → 不健康；10 分钟内有失败记录且失败率 ≥ 60% 且样本 ≥ 3 → 不健康
// 最小样本保护：偶发单次失败（样本 < 3）不裁决，避免网络抖动误判
function isHealthy(p) {
  const s = ST[p];
  if (!s || isExhausted(p)) return false;
  if (!s.fail) return true;
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
      exhausted: !!s.exhausted,
      lastFailAt: s.lastFailAt || null,
      lastErr: s.lastErr || null,
    };
  });
  return out;
}

module.exports = { PROVIDERS, recordOk, recordFail, isExhausted, isHealthy, snapshot };
