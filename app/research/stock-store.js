'use strict';
// ============================================================
// stock-store.js —— 断货/上新滞回状态持久化（算法规格 5.2 事件规则的地基）
// 路径：data/stock_state/<tenantNs>/<projectId>.json
// 结构：{ competitorId: { productIds:[...最近400], soldOutStreak:n, updatedAt } }
// 事件规则（规格 5.2，滞回防单次噪声）：
//   · 断货 = 全变体 available=false 且 **连续 ≥2 趟** sweep 探测到（streak 计数在此累积）
//   · 上新 = 新增商品 ID 且上架时间字段佐证（published_at 由 mapShopifyItems 透传）
// 本模块只做读写与容量截断；判定逻辑在 sweep.js。
// ============================================================
const fs = require('fs');
const path = require('path');
const { DATA } = require('../core/paths.js');
const { atomicWrite } = require('../lib/fs-util.js');

const ROOT_DIR = path.join(DATA, 'stock_state');
const MAX_PER_PROJECT = 300; // 每项目最多跟踪 300 个竞品的滞回状态
const MAX_IDS_PER_COMP = 400; // 每竞品最多记录 400 个商品 ID（防大店撑爆文件）

function nsOf(tenantId) {
  return String(tenantId || '_legacy').replace(/[^a-zA-Z0-9_-]/g, '_');
}
function fileOf(tenantId, projectId) {
  const dir = path.join(ROOT_DIR, nsOf(tenantId));
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const safe = String(projectId || 'project').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'project';
  return path.join(dir, safe + '.json');
}

function load(tenantId, projectId) {
  try {
    const o = JSON.parse(fs.readFileSync(fileOf(tenantId, projectId), 'utf8'));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) { return {}; }
}

function save(tenantId, projectId, map) {
  const keys = Object.keys(map || {});
  // 超限裁掉最旧（按 updatedAt）
  const trimmed = {};
  keys.slice()
    .sort((a, b) => (map[a].updatedAt || 0) - (map[b].updatedAt || 0))
    .slice(-MAX_PER_PROJECT)
    .forEach(k => { trimmed[k] = map[k]; });
  try { atomicWrite(fileOf(tenantId, projectId), trimmed); } catch (e) { /* 非致命 */ }
  return trimmed;
}

function entryOf(map, competitorId) {
  return map[competitorId] || (map[competitorId] = { productIds: [], soldOutStreak: 0, updatedAt: null });
}

module.exports = { load, save, entryOf, fileOf, MAX_PER_PROJECT, MAX_IDS_PER_COMP };
