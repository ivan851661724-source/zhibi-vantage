'use strict';
// ============================================================
// discover-state.js —— 品牌识别「运行状态口径」单一实现（2026-11 r2）
// ------------------------------------------------------------
// 背景：r1 之前，模型故障会被消化成 `discoverDone=true + competitors=[]` 的伪成功
// 空结果；历史档案里这类记录至今仍在。r2 起把「状态判定」收敛到本模块一处，
// 后端所有读态投影（/api/state、/api/projects、切换档案）与前端共用同一口径，
// 禁止各调用点自己拼 discoverDone/discoverEmpty 的组合判断。
//
// 口径（按优先级）：
//   failed      有 discoverError（本次运行明确失败；可能有上一次成功结果保留）
//   running     运行中（discoverRun.status=running 且未超时）
//   done        有品牌（discoverDone=true 且 competitors 非空）
//   empty       成功完成但确实没有已核验品牌（discoverDone=true + discoverEmpty=true）
//   incomplete  其余一切：discoverDone=false 的陈旧记录、以及
//               discoverDone=true + competitors=[] + 无 discoverEmpty 的历史伪空记录
//
// 文案纪律：
//   · incomplete 一律「上一次品牌识别未完整完成，请重新识别。」——绝不说「市场没有品牌」
//   · empty 才允许「未找到通过核验的竞争品牌」
//   · 不出现供应商名、错误原文、内部字段名
// ============================================================

const INCOMPLETE_MESSAGE = '上一次品牌识别未完整完成，请重新识别。';
const EMPTY_MESSAGE = '识别已完成：本次未找到通过核验的竞争品牌。';
const RUNNING_STALE_MS = 20 * 60 * 1000; // 运行标记超时：进程崩溃后不得永久显示「正在调研」

function compsOf(s) {
  return (s && Array.isArray(s.competitors)) ? s.competitors : [];
}

function runOf(s) {
  const r = s && s.discoverRun;
  return (r && typeof r === 'object') ? r : null;
}

function isRunStale(run) {
  if (!run) return true;
  const started = Date.parse(run.startedAt || '');
  if (!Number.isFinite(started)) return true;
  return Date.now() - started > RUNNING_STALE_MS;
}

// 唯一状态判定入口
function discoverPhase(s) {
  if (!s || typeof s !== 'object') return 'no_track';
  if (!s.track) return 'no_track';
  const comps = compsOf(s);
  const run = runOf(s);
  if (s.discoverError) return 'failed';
  const running = (run && run.status === 'running') || s.discovering === true;
  if (running && !isRunStale(run)) return 'running';
  if (s.discoverDone === true) {
    if (comps.length > 0) return 'done';
    if (s.discoverEmpty === true) return 'empty';
    return 'incomplete'; // 历史伪空：完成标记 + 空列表 + 无空市场标记
  }
  return comps.length > 0 ? 'done' : 'incomplete';
}

// 面向 UI / API 的统一投影（只放口径与用户可读文案，不放内部错误正文）
function describeDiscover(s) {
  const phase = discoverPhase(s);
  const comps = compsOf(s);
  const run = runOf(s);
  const err = (s && s.discoverError) || null;
  return {
    phase,
    hasBrands: comps.length > 0,
    brandCount: comps.length,
    incomplete: phase === 'incomplete',
    running: phase === 'running',
    // 失败但旧结果仍在（本次更新失败，上一次成功结果仍可查看）
    keptPrevious: !!(err && err.keptPrevious === true && comps.length > 0),
    message: phase === 'incomplete' ? INCOMPLETE_MESSAGE : (phase === 'empty' ? EMPTY_MESSAGE : null),
    runId: run ? (run.runId || null) : null,
    attemptNo: run ? (run.attemptNo || 1) : 1,
    errorCode: err ? (err.errorCode || null) : null,
    errorMessage: err ? (err.errorMessage || null) : null,
    previousProjectId: err ? (err.previousProjectId || null) : null,
  };
}

// 历史伪空记录不改写磁盘数据（不做破坏性删除/伪造），只在读态投影时按 above 口径渲染。

// 「同一项目 + 同一查询条件」判定（r2 §三.5）：
// 只有用户明确改了赛道 / 地区 / 核心诉求（goals）/ 平台 / 定位画像，才允许新建项目；
// 否则重新识别一律复用原 projectId。
function _normArr(a) {
  return (Array.isArray(a) ? a : []).map(x => String(x).trim().toLowerCase()).filter(Boolean).sort();
}
function _normObj(o) {
  if (!o || typeof o !== 'object') return '{}';
  const keys = Object.keys(o).sort();
  const out = {};
  for (const k of keys) out[k] = o[k];
  return JSON.stringify(out);
}
function sameDiscoveryConditions(prev, track, intent) {
  if (!prev || !prev.track) return false;
  const t1 = String(prev.track).trim().toLowerCase();
  const t2 = String(track || '').trim().toLowerCase();
  if (!t2 || t1 !== t2) return false;
  const pi = prev.intent || {};
  const ni = intent || {};
  if (JSON.stringify(_normArr(pi.regions)) !== JSON.stringify(_normArr(ni.regions))) return false;
  if (JSON.stringify(_normArr(pi.goals)) !== JSON.stringify(_normArr(ni.goals))) return false;
  // platforms 在档案里是 resolvePlatforms 后的结果；前端重试回传的是同一份 intent，正常一致
  if (JSON.stringify(_normArr(pi.platforms)) !== JSON.stringify(_normArr(ni.platforms))) return false;
  if (_normObj(pi.profile) !== _normObj(ni.profile)) return false;
  return true;
}

module.exports = { discoverPhase, describeDiscover, sameDiscoveryConditions, INCOMPLETE_MESSAGE, EMPTY_MESSAGE, RUNNING_STALE_MS };
