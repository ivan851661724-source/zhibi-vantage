'use strict';
// ============================================================
// 字段纠错「私有覆盖」层（T2-1 主权隔离）
// ------------------------------------------------------------
// 用途：让登录用户提交的字段纠错（价格/渠道/品类/上新节奏/口碑）只作用于
//       *该用户自己* 的视图，永不写入共享 state.s.fieldCorrections，永不改写
//       comp.*（忠实助理红线：纠错是用户主权，不污染他人与系统结论）。
//
// 隔离铁律（与 lib/user-notes.js 同构）：
//   1. 按 (tenantId × userId × competitorId) 三级隔离，永不跨用户、永不全局。
//      文件落在 data/research/<tenantId>/field-corrections.json，与 user-notes
//      同命名空间，租户间物理隔离（tenantId 取自登录 JWT 的 tid）。
//   2. userId 取自登录 JWT 的 sub —— 同一租户内不同成员各看各的纠错，互不可见。
//   3. competitorId 取自卡片；纠错只跟随该对手。
//   4. 本模块只做存储，不含任何推理/展示逻辑；它的存在是为了让用户主权生效，
//      算法/展示层通过 getXField(comp, 该用户私有纠错) 重算其私有值。
//
// 与 user-notes 的区别：user-notes 存自由文本备注；本模块存结构化纠错对象
// （{id,competitorId,field,type,value,currency,text,source,actor,status,...}），
// 以便 getXField 直接消费、review/revoke 可按 fcId 定位。
// ============================================================
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fs-util.js');

const ROOT = path.join(__dirname, '..');
// ZB_DATA_DIR 可覆盖数据目录（与 core/paths.js 同口径）
const DATA = process.env.ZB_DATA_DIR ? path.resolve(process.env.ZB_DATA_DIR) : path.join(ROOT, 'data');

// 必须与 user-notes.js / server.js 的 sanitizeNs 同算法，否则落盘目录对不上。
function sanitizeNs(x) { return String(x || '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || '_legacy'; }
function storePath(tenantId) { return path.join(DATA, 'research', sanitizeNs(tenantId), 'field-corrections.json'); }

// 对象键防护：__proto__/constructor/prototype 作为键会破坏原型链（纠错静默丢失/损坏）
function safeKey(x) {
  const k = String(x == null ? '' : x).slice(0, 80);
  return (k === '__proto__' || k === 'constructor' || k === 'prototype') ? '' : k;
}

function readAll(tenantId) {
  try {
    const o = JSON.parse(fs.readFileSync(storePath(tenantId), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

function writeAll(tenantId, obj) {
  const fp = storePath(tenantId);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWrite(fp, obj);
}

// 取某用户某对手的全部纠错（数组，按追加顺序；含 pending/accepted/rejected/revoked）
function getCorrections(tenantId, userId, competitorId) {
  const u = readAll(tenantId)[userId];
  if (!u) return [];
  const arr = u[competitorId];
  return Array.isArray(arr) ? arr : [];
}

// 追加一条纠错（私有层只增不改；状态变迁走 updateById）。键非法（如 __proto__）返回 null。
function setCorrection(tenantId, userId, corr) {
  const uid = safeKey(userId);
  const cid = safeKey(corr && corr.competitorId);
  if (!uid || !cid) return null;
  const all = readAll(tenantId);
  if (!all[uid]) all[uid] = {};
  if (!all[uid][cid]) all[uid][cid] = [];
  all[uid][cid].push(corr);
  writeAll(tenantId, all);
  return corr;
}

// 按 fcId 找某用户的单条纠错（全对手扫描）
function findById(tenantId, userId, fcId) {
  const u = readAll(tenantId)[userId];
  if (!u) return null;
  for (const cid of Object.keys(u)) {
    const arr = u[cid];
    if (!Array.isArray(arr)) continue;
    const hit = arr.find(x => x.id === fcId);
    if (hit) return hit;
  }
  return null;
}

// 更新某条纠错的状态/标记（review/revoke 用），返回更新后的对象或 null
function updateById(tenantId, userId, fcId, patch) {
  const all = readAll(tenantId);
  const u = all[userId];
  if (!u) return null;
  for (const cid of Object.keys(u)) {
    const arr = u[cid];
    if (!Array.isArray(arr)) continue;
    const hit = arr.find(x => x.id === fcId);
    if (hit) {
      Object.assign(hit, patch);
      writeAll(tenantId, all);
      return hit;
    }
  }
  return null;
}

// 列出某用户全部纠错（dashboard / 重载展示用）：{ competitorId: [corr,...], ... }
function listAll(tenantId, userId) {
  const u = readAll(tenantId)[userId];
  if (!u) return {};
  const out = {};
  for (const cid of Object.keys(u)) {
    const arr = u[cid];
    if (Array.isArray(arr) && arr.length) out[cid] = arr;
  }
  return out;
}

module.exports = { storePath, getCorrections, setCorrection, findById, updateById, listAll };
