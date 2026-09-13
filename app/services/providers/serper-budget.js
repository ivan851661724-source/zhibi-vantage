'use strict';
// ============================================================
// serper-budget.js —— Serper key 总额度预算（2026-09-13）
// ------------------------------------------------------------
// 口径铁律：总额度（lifetime），绝不按月重置——Serper 免费档是一次性赠送
// （如 2500 credits 总量，用完即止），不是每月刷新。
// 运营口径：每把 key 独享额度（独享保真），多 key 时各自独立扣减
// （used 按完整 key 记账，新增 key 自动从 0 起算）。
// 计数口径与 metering.shouldBill 对齐：2xx/5xx 扣 1（供应商「到达即计费」），
// 4xx / 网络失败不扣（无真实消耗）。
// 持久化：DATA/serper-budget.json（独立文件 + mutateFile 锁内 RMW）——
// 刻意不写进 config.json，避免与设置页的整对象 LWW 回写互相滚掉。
// 精度边界：并发在途请求各自通过 canSpend 后同时落账，超支上限 = 并发数。
// total 来源：config.search.serperBudget（数字 / {total} / {limit}）；
// 未配置或非法 → Infinity（不设限，退回纯被动失效检测）。
// ============================================================
const fs = require('fs');
const path = require('path');
const { mutateFile } = require('../../lib/fs-util.js');

function budgetFile() {
  const { DATA } = require('../../core/paths.js'); // 延迟 require：测试可重置 ZB_DATA_DIR 后清缓存
  return path.join(DATA, 'serper-budget.json');
}

// 总额度（次）：2500 / {total:2500} / {limit:2500} 均可；未配置或非法 → Infinity
function budgetTotal(searchCfg) {
  const b = searchCfg ? searchCfg.serperBudget : undefined;
  if (b == null || b === '') return Infinity;
  const n = Number(typeof b === 'object' ? (b.total != null ? b.total : b.limit) : b);
  return (Number.isFinite(n) && n > 0) ? n : Infinity;
}

function _readUsed() {
  try {
    const j = JSON.parse(fs.readFileSync(budgetFile(), 'utf8'));
    return (j && j.used && typeof j.used === 'object') ? j.used : {};
  } catch { return {}; }
}

// 该 key 剩余额度是否还够一笔（used < total 即可花；未配置额度恒真）
function canSpend(key, total) {
  if (!(total > 0)) return true; // Infinity / 未配置
  const keyStr = String(key || '');
  if (!keyStr) return true;
  return (_readUsed()[keyStr] || 0) < total;
}

// 记一笔消耗（锁内 RMW，n 默认 1）。调用方应 await：保证下一次 canSpend 读到最新账。
// ⚠️ mergeFn 必须返回全新对象：mutateFile 以 `next === cur` 判定「无变更」跳过写入，
// 若取 cur 原地改再返回，引用相同会被判无变更 → 除首次外全部静默丢账。
function recordSpend(key, n) {
  const keyStr = String(key || '');
  if (!keyStr) return Promise.resolve();
  const inc = Number(n) > 0 ? Number(n) : 1;
  return mutateFile(budgetFile(), (cur) => {
    const src = (cur && cur.used && typeof cur.used === 'object') ? cur.used : {};
    return {
      used: Object.assign({}, src, { [keyStr]: (src[keyStr] || 0) + inc }),
      updatedAt: new Date().toISOString()
    };
  }, false);
}

// 状态回显（key 只出前 6 位掩码，完整密钥永不回传）
function status(searchCfg) {
  const total = budgetTotal(searchCfg);
  const used = _readUsed();
  const keys = (searchCfg && Array.isArray(searchCfg.serperKeys)) ? searchCfg.serperKeys
    : (searchCfg && searchCfg.serperKey ? [searchCfg.serperKey] : []);
  return {
    total: Number.isFinite(total) ? total : null,
    keys: keys.map(k => {
      const u = used[k] || 0;
      return { mask: String(k).slice(0, 6) + '…', used: u, remaining: Number.isFinite(total) ? Math.max(0, total - u) : null };
    })
  };
}

module.exports = { budgetTotal, canSpend, recordSpend, status };
