'use strict';
// ============================================================
// voice-store.js —— 声音采集增量游标（PRD R2.1：增量防重复）
// 路径：data/voice_cursor/<tenantNs>/<projectId>.json
// 结构：{ [competitorId]: lastAtISO } —— 该对手上次成功采集的时间点，
//       下次采集作为 since 透传给各适配器（只取更新内容），配合 URL 去重双保险。
// ============================================================
const fs = require('fs');
const path = require('path');
const { DATA } = require('../core/paths.js');
const { atomicWrite } = require('../lib/fs-util.js');

const ROOT_DIR = path.join(DATA, 'voice_cursor');

function nsOf(tenantId) {
  return String(tenantId || '_legacy').replace(/[^a-zA-Z0-9_-]/g, '_');
}
function fileOf(tenantId, projectId) {
  const dir = path.join(ROOT_DIR, nsOf(tenantId));
  try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const safe = String(projectId || 'project').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'project';
  return path.join(dir, safe + '.json');
}

function loadCursor(tenantId, projectId) {
  try {
    const o = JSON.parse(fs.readFileSync(fileOf(tenantId, projectId), 'utf8'));
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  } catch (e) { return {}; }
}

function saveCursor(tenantId, projectId, obj) {
  try { atomicWrite(fileOf(tenantId, projectId), obj || {}); } catch (e) { /* 非致命 */ }
  return obj || {};
}

module.exports = { loadCursor, saveCursor, fileOf };
