'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// core/state-store.js —— 导出: sanitizeNs, tenantDir, resolveTenantId, reportsFile, projFile, newProjectId, getCurrentId, setCurrentId, loadState, saveState, listProjects, mirrorProjectToDb, migrateResearchNamespaces
// ============================================================

const { ensureData } = require('./config.js');
const { DATA, STATE_PATH, PROJ_DIR, CURRENT_PATH } = require('./paths.js');
const { requestScope } = require('./als.js');
const { broadcastChange } = require('./sse-hub.js');
const db = require('../services/db.js');
const { bestEffortWrite, mutateFile, safeWrite } = require('../lib/fs-util.js');
const fs = require('fs');
const path = require('path');

// ---------- 多调研档案存储：换赛道自动归档，不再覆盖 ----------
// 研究链路多租户隔离（P0-2.1）：每个租户的研究档案独立命名空间 data/research/<tenantId>/。
// 文件名净化避免租户 id 注入路径（如 ../）；tenantId 解析顺序：显式传入 > 请求上下文(ALS) > _legacy。
function sanitizeNs(x) { return String(x || '').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || '_legacy'; }
function tenantDir(tenantId) { return path.join(DATA, 'research', sanitizeNs(tenantId || '_legacy')); }
function resolveTenantId(explicit) {
  if (explicit) return sanitizeNs(explicit);
  const fromCtx = requestScope.getStore(); // 请求内由 createServer 注入
  if (fromCtx) return sanitizeNs(fromCtx);
  return '_legacy';
}
// 用户纠错报告（P1-7）：随研究档案一起按租户命名空间隔离，杜绝跨租户泄露。
function reportsFile(tenantId) { return path.join(tenantDir(resolveTenantId(tenantId)), 'reports.json'); }
function ensureProj(tenantId) {
  const d = tenantDir(tenantId || resolveTenantId());
  ensureData();
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
}
function projFile(id, tenantId) {
  const d = tenantDir(tenantId || resolveTenantId());
  return path.join(d, String(id).replace(/[^a-z0-9\u4e00-\u9fff-]/gi, '') + '.json');
}
function newProjectId(track) {
  const base = String(track || 'project').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'project';
  return base + '-' + Date.now().toString(36);
}
function getCurrentPath(tenantId) { return path.join(tenantDir(tenantId), 'current.json'); }
function getCurrentId(tenantId) {
  const tid = resolveTenantId(tenantId);
  try { return JSON.parse(fs.readFileSync(getCurrentPath(tid), 'utf8')).id || null; } catch { return null; }
}
// 当前指针写入：非致命。外部进程瞬时占锁时绝不 500——转后台异步重试，锁释放后自动落盘。
function setCurrentId(id, tenantId) {
  const tid = resolveTenantId(tenantId);
  ensureProj(tid);
  bestEffortWrite(getCurrentPath(tid), { id: id || null }, true);
  // T3-1：切换/创建档案时把文件态项目镜像进 db。
  // 用 RAW tenantId（requestScope）对齐 db.listProjects 的过滤键（db 用原始 tenantId，文件命名空间用 sanitizeNs 后的）；
  // 文件已存在时读 track，新建档案文件尚未落盘则交给创建点的镜像补齐。
  if (id) {
    const rawTid = requestScope.getStore() || tid;
    try {
      const _s = JSON.parse(fs.readFileSync(projFile(id, tid), 'utf8'));
      mirrorProjectToDb(id, rawTid, _s.track);
    } catch { /* 文件尚无（saveState 之前）：忽略，创建点会镜像 */ }
  }
}
// 首个真实租户 id（用于把升级前的扁平档案归属到正确租户）。无租户则落 _legacy。
// Phase 2：存储换底后经 db 接口读取（不再直接读 multitenant.json 文件）。
function primaryTenantId() {
  try {
    const tenants = db.listAllTenants();
    const t = tenants && tenants[0];
    return t && t.id ? t.id : null;
  } catch { return null; }
}
// 启动迁移（P0-2.1）：把升级前扁平的 data/projects/* 与 data/current.json 迁入首个真实租户的
// 命名空间 data/research/<tenantId>/，保证既有研究数据不丢且归属正确。幂等：用 .migrated 标记防重复。
function migrateResearchNamespaces() {
  const target = primaryTenantId() || '_legacy';
  const dest = tenantDir(target);
  const marker = path.join(dest, '.migrated');
  if (fs.existsSync(marker)) return; // 已迁移完成
  ensureData();
  let moved = false;
  // 极旧单档案 state.json（比 projects 更老的格式）
  if (fs.existsSync(STATE_PATH)) {
    try {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
      if (s && s.track) {
        ensureProj(target);
        s.tenantId = target;
        s.projectId = s.projectId || newProjectId(s.track);
        safeWrite(projFile(s.projectId, target), s, true);
        safeWrite(getCurrentPath(target), { id: s.projectId }, true);
        moved = true;
      }
      fs.renameSync(STATE_PATH, STATE_PATH + '.migrated');
    } catch {}
  }
  // 扁平 projects 目录
  if (fs.existsSync(PROJ_DIR)) {
    ensureProj(target);
    for (const f of fs.readdirSync(PROJ_DIR)) {
      if (!f.endsWith('.json')) continue;
      try {
        const src = path.join(PROJ_DIR, f);
        const dst = path.join(dest, f);
        if (!fs.existsSync(dst)) { fs.renameSync(src, dst); moved = true; }
      } catch {}
    }
    if (fs.existsSync(CURRENT_PATH)) {
      try { fs.renameSync(CURRENT_PATH, path.join(dest, 'current.json')); moved = true; } catch {}
    }
  }
  if (moved) {
    fs.writeFileSync(marker, new Date().toISOString());
    console.log('[migrate] 已将旧版单租户研究档案迁入命名空间: ' + target);
  }
}
// 向后兼容：旧调用点保留 migrateLegacy 名（幂等，标记防重复）
function migrateLegacy() { migrateResearchNamespaces(); }
function loadState(tenantId) {
  migrateLegacy();
  const tid = resolveTenantId(tenantId);
  const id = getCurrentId(tid);
  if (!id) return null;
  try { return JSON.parse(fs.readFileSync(projFile(id, tid), 'utf8')); } catch { return null; }
}
// 并发 RMW 合并（P1-1.2）：以磁盘最新为基底，本态覆盖其标量字段；competitors 按 id 合并
// （并集，本态同 id 胜出），避免后台队列新增的竞品被请求态覆盖丢失（last-writer-wins 丢更新）。
function mergeState(cur, s) {
  if (!cur) return s;
  if (!s || !s.projectId) return cur;
  const merged = Object.assign({}, cur);
  for (const k of Object.keys(s)) {
    if (k === 'competitors') continue;
    if (s[k] !== undefined) merged[k] = s[k];
  }
  const byId = new Map();
  (cur.competitors || []).forEach(c => { if (c && c.id) byId.set(c.id, c); });
  (s.competitors || []).forEach(c => { if (c && c.id) byId.set(c.id, Object.assign({}, byId.get(c.id) || {}, c)); });
  merged.competitors = [...byId.values()];
  return merged;
}
// 注意：saveState 只写档案文件，不改当前指针（后台深研写入归档中的旧档案时不会抢占前台）。
// tenantId 解析：优先用 state.tenantId（创建时写入，后台队列脱离请求上下文也带得上），否则回退 ALS/_legacy。
// ---------- SSE 变化推送（F12：轮询 → 变化检测推送） ----------
// 所有状态变更都经 saveState 落盘；在此统一广播，前端免轮询。
function saveState(s) {
  if (!s.projectId) { s.projectId = newProjectId(s.track); if (!getCurrentId(s.tenantId)) setCurrentId(s.projectId, s.tenantId); }
  const tid = resolveTenantId(s.tenantId);
  const fp = projFile(s.projectId, tid);
  try {
    mutateFile(fp, (cur) => mergeState(cur, s), true);
  } catch (e) {
    // 极端持久锁：退化为原非致命写（不抛，避免 500）；锁释放后下次写入自愈
    bestEffortWrite(fp, s, true);
  }
  broadcastChange(); // ▶ F12：落盘即推送，前端据此做变化检测（仅变更时重渲染）
}
function listProjects(tenantId) {
  migrateLegacy();
  const tid = resolveTenantId(tenantId);
  const dir = tenantDir(tid);
  if (!fs.existsSync(dir)) return [];
  const cur = getCurrentId(tid);
  const out = [];
  fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'current.json').forEach(f => {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      // 内容裁决：只认「项目档案」（对象且含 competitors 数组或有 projectId）。
      // 同目录的 user-notes / field-corrections / reports 等数据文件（按 user 键的对象或数组）
      // 不是调研档案，不得混入历史调研清单。
      if (!s || typeof s !== 'object' || Array.isArray(s) || (!Array.isArray(s.competitors) && !s.projectId)) return;
      const comps = s.competitors || [];
      out.push({
        id: s.projectId || f.replace(/\.json$/, ''),
        track: s.track || '(未命名)',
        discoveredAt: s.discoveredAt || null,
        total: comps.length,
        done: comps.filter(c => c.status === 'done').length,
        hasBrief: !!s.brief,
        current: (s.projectId || f.replace(/\.json$/, '')) === cur
      });
    } catch {}
  });
  out.sort((a, b) => String(b.discoveredAt || '').localeCompare(String(a.discoveredAt || '')));
  return out;
}

// T3-1：文件态研究档案 → db 项目清单镜像（最小融合，不搬研究数据进 db）。
// 让 /api/projects（db）与 /api/state（文件）在「项目清单」层汇合：旧端点创建/切换的档案
// 也以「同 projectId + tenantId」落 db，前端按 tenantId+id 桥接回文件态详情。
// 幂等：同 (tenantId,projectId) 仅首次写 db；重启后 Set 清空会再 upsert（无害）。
// 非致命：db 镜像失败绝不影响研究主链路。
const _mirroredProjects = new Set();
function mirrorProjectToDb(projectId, tenantId, track) {
  if (!projectId || !tenantId) return;
  const key = tenantId + '::' + projectId;
  if (_mirroredProjects.has(key)) return;
  try {
    const existing = db.getProject(tenantId, projectId);
    if (existing) {
      // 已存在：仅补 track（若缺失），保留原 createdAt/discoveredAt，不覆盖研究字段
      if (!existing.track && track) { existing.track = track; db.saveProject(existing); }
      _mirroredProjects.add(key);
      return;
    }
    db.saveProject({
      id: projectId, tenantId,
      track: track || 'project',
      competitors: [], brief: null, whiteSpace: null,
      createdAt: new Date().toISOString(),
      discoveredAt: new Date().toISOString()
    });
    _mirroredProjects.add(key);
  } catch (e) { /* 非致命：db 镜像失败不影响研究主链路 */ }
}


module.exports = { sanitizeNs, tenantDir, resolveTenantId, reportsFile, projFile, newProjectId, getCurrentId, setCurrentId, loadState, saveState, listProjects, mirrorProjectToDb, migrateResearchNamespaces };
