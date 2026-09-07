'use strict';
// ============================================================
// 用户私有记录（S3-④）
// ------------------------------------------------------------
// 用途：让登录用户给「某个对手」写只有自己能看到的私有备注（如"这家老板我认识"
// "他们供应链好像在东莞"），永不进入任何共享/公开视图，也不影响报告与算法。
//
// 隔离铁律（忠实助理纪律）：
//   1. 按 (tenantId × userId × competitorId) 三级隔离，永不跨租户、永不全局。
//      文件落在 data/research/<tenantId>/user-notes.json，与项目档案同命名空间，
//      租户间物理隔离（tenantId 取自登录 JWT 的 tid，绝不读 ALS/legacy）。
//   2. userId 取自登录 JWT 的 sub —— 同一租户内不同成员各看各的，互不可见。
//   3. competitorId 取自卡片；备注只跟随该对手，绝不被其它用户读取。
//   4. 文本上限 5000 字符；空串 = 删除（置空即清除，不留空壳）。
//   5. 本模块只做存储，不含任何推理/展示逻辑；它是"用户私人物品"，算法绝不消费它。
// ============================================================
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fs-util.js');

const ROOT = path.join(__dirname, '..');
// ZB_DATA_DIR 可覆盖数据目录（与 core/paths.js 同口径）
const DATA = process.env.ZB_DATA_DIR ? path.resolve(process.env.ZB_DATA_DIR) : path.join(ROOT, 'data');
const MAX_LEN = 5000;

// 必须与 server.js 的 sanitizeNs 同算法，否则落盘目录与项目档案对不上。
function sanitizeNs(x) { return String(x || '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || '_legacy'; }
function notesPath(tenantId) { return path.join(DATA, 'research', sanitizeNs(tenantId), 'user-notes.json'); }

// 对象键防护：__proto__/constructor/prototype 作为键会破坏原型链（备注静默丢失/损坏）
function safeKey(x) {
  const k = String(x == null ? '' : x).slice(0, 80);
  return (k === '__proto__' || k === 'constructor' || k === 'prototype') ? '' : k;
}

function readAll(tenantId) {
  try {
    const o = JSON.parse(fs.readFileSync(notesPath(tenantId), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}

function writeAll(tenantId, obj) {
  const fp = notesPath(tenantId);
  const dir = path.dirname(fp);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  atomicWrite(fp, obj);
}

// 取单条；返回 { text, updatedAt } 或 null（不存在）。
function getNote(tenantId, userId, competitorId) {
  const u = readAll(tenantId)[userId];
  if (!u) return null;
  const n = u[competitorId];
  return (n && typeof n === 'object') ? n : null;
}

// 列出该用户全部备注：{ competitorId: { text, updatedAt }, ... }
function listNotes(tenantId, userId) {
  const u = readAll(tenantId)[userId];
  if (!u) return {};
  const out = {};
  for (const cid of Object.keys(u)) {
    const n = u[cid];
    if (n && typeof n === 'object' && n.text) out[cid] = n;
  }
  return out;
}

// 保存；text 为空串 → 删除该条。返回保存后的 {text, updatedAt} 或 null（已删除/键非法）。
function setNote(tenantId, userId, competitorId, text) {
  const t = String(text == null ? '' : text).slice(0, MAX_LEN);
  const uid = safeKey(userId);
  const cid = safeKey(competitorId);
  if (!uid || !cid) return null;
  const all = readAll(tenantId);
  if (!all[uid]) all[uid] = {};
  if (!t.trim()) {
    delete all[uid][cid];
  } else {
    all[uid][cid] = { text: t, updatedAt: new Date().toISOString() };
  }
  if (Object.keys(all[uid]).length === 0) delete all[uid];
  writeAll(tenantId, all);
  return t.trim() ? all[uid][cid] : null;
}

module.exports = { MAX_LEN, notesPath, safeKey, getNote, listNotes, setNote };
