'use strict';
// ============================================================
// IP 管控（P1-4.3 基础管控）：封禁 / 白名单
// ------------------------------------------------------------
// 零依赖，规则持久化到 data/ip-rules.json。
// 判定顺序：
//   1) 在封禁表 → 拒绝
//   2) 白名单非空 且 不在白名单 → 拒绝（白名单模式：仅放行显式允许的地址）
//   3) 否则放行
// 默认（白名单为空）即"仅封禁"模式，不影响正常用户；白名单仅在超管显式添加后生效，
// 避免误开白名单把自己挡在门外（P1-4.3 验收：封禁 IP → 403）。
// ============================================================
const fs = require('fs');
const path = require('path');
const FU = require('./fs-util.js');

const DATA = path.join(__dirname, '..', 'data');
const RULES_PATH = path.join(DATA, 'ip-rules.json');

let allow = new Set();
let block = new Set();

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    allow = new Set(Array.isArray(j.allow) ? j.allow : []);
    block = new Set(Array.isArray(j.block) ? j.block : []);
  } catch { /* 无规则文件则保持空集（放行全部，仅封禁模式） */ }
}

// 持久化：异步、失败不阻塞请求（IP 规则非关键路径，下次写入或重启会再落盘）
function persist() {
  try { FU.safeWrite(RULES_PATH, { allow: [...allow], block: [...block] }, true); } catch { /* 忽略瞬时写失败 */ }
}

function normalizeIp(ip) { return String(ip || '').trim(); }

// 判定：true=放行，false=拒绝
function evaluate(ip) {
  const n = normalizeIp(ip);
  if (!n || n === 'unknown') return true; // 无法识别来源时不误杀
  if (block.has(n)) return false;
  if (allow.size > 0 && !allow.has(n)) return false; // 白名单模式生效
  return true;
}

function blockIp(ip) {
  const n = normalizeIp(ip);
  if (!n) return false;
  block.add(n);
  allow.delete(n); // 封禁优先于白名单
  persist();
  return true;
}
function unblockIp(ip) {
  const n = normalizeIp(ip);
  block.delete(n);
  persist();
  return true;
}
function allowIp(ip) {
  const n = normalizeIp(ip);
  if (!n) return false;
  allow.add(n);
  block.delete(n); // 白名单优先于封禁
  persist();
  return true;
}
function removeAllow(ip) {
  const n = normalizeIp(ip);
  allow.delete(n);
  persist();
  return true;
}

function list() {
  return {
    allow: [...allow],
    block: [...block],
    mode: allow.size > 0 ? 'allowlist' : 'blocklist'
  };
}

load();

module.exports = { evaluate, blockIp, unblockIp, allowIp, removeAllow, list, load };
