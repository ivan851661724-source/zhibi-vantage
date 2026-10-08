'use strict';
// ============================================================
// core/safe-id.js —— 存储对象 ID 安全校验（P0-1 最终代码审核修复）
//
// 背景：snapshot_id/evidence_id/fact_id/diff_id/event_id 由外部请求
//（/api/demo/*?id=）进入存储层读回函数，若直接 path.join 进文件路径，
// 攻击者可用 `../` 路径穿越跳出当前租户目录（已复现跨租户读取）。
//
// 规则（三层防御，任何一层独立成立）：
//   1) 格式白名单：ID 只允许 [A-Za-z0-9_.-]，且不允许 '..' 子串、
//      不允许以分隔符/盘符出现（'/'、'\'、':' 根本不在字符集内）——
//      现网全部合法 ID（ev_/fact_/diff_/evt_/ss_ 前缀 + 确定性哈希/时间戳）
//      均落在该字符集内，白名单不影响任何合法 ID。
//   2) 存储层独立防御：get*ById 在触碰文件系统前先校验 ID，非法 → null
//      （绝不让非法 ID 拼进任何路径）；存储层不依赖路由层校验。
//   3) 包含性检查（belt & suspenders）：解析后的绝对路径必须仍位于目标
//      租户目录内（path.relative 判定），否则按不存在处理。
// API 层约定：非法 ID → 400 INVALID_ID（用 isSafeId 在路由层先行判定）；
//             合法但不存在 → 404（存储层返回 null）。
// ============================================================
const path = require('path');

// 合法 ID 字符集白名单（首字符必须为字母/数字，长度 ≤ 128）
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

// 是否为安全的存储对象 ID：格式白名单 + 禁 '..' 子串（双点穿越）
function isSafeId(id) {
  if (typeof id !== 'string') return false;
  if (!SAFE_ID_RE.test(id)) return false;
  if (id.indexOf('..') !== -1) return false; // 禁 '..'（含 '...' 等变体）
  return true;
}

// 包含性检查：candidatePath 解析后必须位于 baseDir 内部（或恰为 baseDir 本身）。
// 返回 true/false。用于存储层写读前的最后防线（防 sanitizeNs 以外的路径拼接意外）。
function isWithinDir(baseDir, candidatePath) {
  const base = path.resolve(String(baseDir));
  const target = path.resolve(String(candidatePath));
  const rel = path.relative(base, target);
  if (rel === '') return true; // 恰为目录本身
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

module.exports = { isSafeId, isWithinDir, SAFE_ID_RE };
