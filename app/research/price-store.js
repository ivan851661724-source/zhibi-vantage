'use strict';
// ============================================================
// price-store.js —— 价格快照持久化（PRD R1.1：只追加，按项目落盘）
// 路径：data/price_history/<tenantNs>/<projectId>.json
// 条目由 lib/price-history.js 产出；本模块只做读写与容量截断。
// ============================================================
const fs = require('fs');
const path = require('path');
const { DATA } = require('../core/paths.js');
const { atomicWrite } = require('../lib/fs-util.js');

const ROOT_DIR = path.join(DATA, 'price_history');
const MAX_PER_PROJECT = 500; // 每项目最多保留 500 条快照（超限裁掉最旧）

function nsOf(tenantId) {
  return String(tenantId || '_legacy').replace(/[^a-zA-Z0-9_-]/g, '_');
}
function fileOf(tenantId, projectId) {
  const dir = path.join(ROOT_DIR, nsOf(tenantId));
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  // projectId 已是 newProjectId 产物（[a-z0-9-]），仍做一次消毒防注入
  const safe = String(projectId || 'project').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'project';
  return path.join(dir, safe + '.json');
}

function load(tenantId, projectId) {
  try {
    const a = JSON.parse(fs.readFileSync(fileOf(tenantId, projectId), 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch (e) { return []; }
}

function save(tenantId, projectId, list) {
  const trimmed = (Array.isArray(list) ? list : []).slice(-MAX_PER_PROJECT);
  try { atomicWrite(fileOf(tenantId, projectId), trimmed); } catch (e) { /* 非致命 */ }
  return trimmed;
}

// 从竞品档案提取"当前标量价"（快照/diff/verdict old→new 对比的统一口径）。
// 优先 pricePoints 中位数；无点价时回退 priceField.display 解析出的区间下限。
function currentScalarPrice(comp) {
  if (!comp) return null;
  const pts = (comp.pricePoints || []).filter(n => typeof n === 'number' && n > 0).sort((a, b) => a - b);
  if (pts.length) return pts[Math.floor(pts.length / 2)];
  const cur = comp.currency || 'USD';
  const display = comp.priceField && comp.priceField.display;
  if (display && display !== '—') {
    try {
      const pv = require('../lib/pricefield.js').parsePriceRange(display, cur);
      if (pv && pv.min > 0) return pv.min;
    } catch (e) { /* 解析失败按缺价处理 */ }
  }
  return null;
}

module.exports = { load, save, fileOf, currentScalarPrice, MAX_PER_PROJECT };
