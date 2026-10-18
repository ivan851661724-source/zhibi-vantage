'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/sweep.js —— 导出: projectLastActivityAt, sweepProject, runSweep, startScheduler
// ============================================================

const { loadConfig } = require('../core/config.js');
const { projFile, saveState, sanitizeNs } = require('../core/state-store.js');
const { requestScope } = require('../core/als.js');
const { decorateState } = require('./decorate.js');
const { deepDiveField } = require('./deepdive.js');
const { llmApiKey } = require('./llm.js');
const Alerts = require('../services/alerts.js');
const Logger = require('../services/logger.js');
const M = require('../lib/metrics.js');
const Metrics = require('../services/metrics.js');
const Scheduler = require('../services/scheduler.js');
const { startDigestTick } = require('./digest.js');
const db = require('../services/db.js');
const WatchMonitor = require('../services/watch-monitor.js');
const fs = require('fs');


// ============ 模块 2-1：定时增量雷达（整改 §3 后的角色收缩） ============
// 整改 §3（正式监控唯一资格边界 = WatchMonitor / WatchTarget）：
//   · 未建立正式 WatchTarget 的对象不得产生正式价格、上新、断货提醒；
//   · 不得因项目近期活跃而产生持续监控费用（搜索/LLM/直抓）；
//   · 旧 sweep 的 Shopify 直抓与 WatchMonitor 巡检重复，已整体摘除
//     （价格 / 断货 / 上新三个正式监控信号全部移交 WatchMonitor）；
//   · 保留的 sweepProject 仅承担明确的非正式研究维护：LLM recentMoves 动作重研
//     与 competitor-move 研究动态提醒（非价格/上新/断货类正式监控信号）；
//   · 默认不调度（startScheduler 不再启动 runSweep）；ZB_SWEEP_ENABLED=1 为运维
//     显式逃生门，启用后也只运行上述收缩版。
// 项目活跃判定：档案内任一竞品 researchedAt 距今 < 30 天。
function projectLastActivityAt(state) {
  let latest = 0;
  (state.competitors || []).forEach(c => {
    const t = Date.parse(c.researchedAt || '');
    if (!isNaN(t) && t > latest) latest = t;
  });
  const d = Date.parse(state.discoveredAt || '');
  if (!isNaN(d) && d > latest) latest = d;
  return latest;
}
// 对单个项目做一轮收缩版增量研究维护（仅 recentMoves LLM 重研，无直抓、无正式监控事件）
async function sweepProject(proj, config) {
  // Background jobs have no request identity. Never borrow an unrelated caller's
  // ALS or infer a raw tenant ID from a persisted filesystem namespace.
  const tid = proj && typeof proj.tenantId === 'string' ? proj.tenantId : '';
  if (!tid.trim() || tid === '_legacy') return { ok: false, reason: 'no_tenant_context' };
  return requestScope.run(tid, () => sweepProjectInScope(proj, config));
}
async function sweepProjectInScope(proj, config) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(projFile(proj.id, proj.tenantId), 'utf8')); } catch (e) { return { ok: false, reason: 'no_state' }; }
  if (!state || !Array.isArray(state.competitors)) return { ok: false, reason: 'no_state' };
  // Older archives store the sanitized namespace. The project's raw tenant is
  // authoritative; accept its existing namespace spelling, reject other owners.
  const tid = proj.tenantId;
  if (state.tenantId && state.tenantId !== tid && state.tenantId !== sanitizeNs(tid)) {
    return { ok: false, reason: 'tenant_mismatch' };
  }
  if (state.projectId && state.projectId !== proj.id) return { ok: false, reason: 'project_mismatch' };
  state.tenantId = tid;
  state.projectId = proj.id;
  const hasLlm = !!llmApiKey(config);
  const beforeMoves = new Map(state.competitors.map(c => [c.id, JSON.stringify(c.recentMoves || [])]));
  const newMoves = [];
  let probed = 0, changed = 0;
  for (const comp of state.competitors) {
    if (comp.status !== 'done' || comp.suppressed) continue;
    if (!hasLlm) continue; // 无 LLM key 时本模块无事可做（正式监控信号在 WatchMonitor，零 LLM 路径）
    try {
      const r = await deepDiveField(state, comp, 'recentMoves', config);
      probed++;
      if (JSON.stringify(comp.recentMoves || []) !== beforeMoves.get(comp.id)) {
        changed++;
        let prev = [];
        try { prev = JSON.parse(beforeMoves.get(comp.id) || '[]'); } catch (e) {}
        const added = (comp.recentMoves || []).filter(x => !prev.some(y => JSON.stringify(y) === JSON.stringify(x)));
        if (added.length) newMoves.push({ competitorId: comp.id, name: comp.name, moves: added });
      }
    } catch (e) { /* 单家探测失败不阻断整轮 */ }
  }
  if (changed > 0) {
    // 变化（LLM 动作 diff）：重新派生（domainVerdicts/materials/雷达最近动作等）+ 记时序事件
    try {
      decorateState(state);
      M.logEvent({ changeType: 'sweep_changes', source: 'sweep', from: String(probed), to: String(changed), confidence: null });
    } catch (e) { /* 派生/记账失败不影响落盘 */ }
    // 研究动态推送（非正式监控信号：competitor-move 是 LLM 研究发现，非价格/上新/断货）
    if (newMoves.length) {
      const webhookUrl = (config.alerts && config.alerts.webhookUrl) || '';
      try {
        newMoves.forEach(nm => {
          Alerts.push(state.tenantId || proj.tenantId, {
            type: 'competitor-move', projectId: proj.id, track: state.track,
            competitorId: nm.competitorId, competitorName: nm.name,
            moves: nm.moves.slice(0, 3).map(m => (m && m.type ? m.type : '') + (m.what || m.title || m.url || '') || JSON.stringify(m).slice(0, 120)),
          }, webhookUrl);
        });
      } catch (e) { /* 推送失败不影响落盘 */ }
    }
  }
  saveState(state);
  // 更新 lastSweepAt（db 镜像表，scheduler/status 用）
  try {
    const dbProj = db.getProject(proj.tenantId, proj.id);
    if (dbProj) { dbProj.lastSweepAt = new Date().toISOString(); db.saveProject(dbProj); }
  } catch (e) { /* 非致命 */ }
  return { ok: true, probed, changed, priceChanges: 0 };
}
// 一轮完整 sweep：遍历所有租户项目 → 活跃者入队 + 消费
async function runSweep() {
  const config = loadConfig();
  if (!config) return { ok: false, reason: 'no_config' };
  let all = [];
  try { all = db.listAllProjects(); } catch (e) { return { ok: false, reason: 'db_err', error: String(e.message || e) }; }
  const out = { active: 0, zombie: 0, swept: 0, changed: 0, priceChanges: 0, durationMs: 0 };
  const startedAt = Date.now();
  for (const proj of all) {
    let state = null;
    try { state = JSON.parse(fs.readFileSync(projFile(proj.id, proj.tenantId), 'utf8')); } catch (e) { /* 档案缺失视为僵尸 */ }
    const active = state && projectLastActivityAt(state) > Date.now() - 30 * 86400000;
    if (!active) { out.zombie++; continue; }
    out.active++;
    // 单进程内直接执行（sweep 由 scheduler 单实例调度，无并发认领问题）。
    // 说明：文档原设计「sweep 任务入 research_tasks 表由 worker 消费」属 Phase 3 worker 化后的形态；
    // 当前入队会积累无人消费的 pending（runQueue 只认领 deep-research 型），故先直接执行，worker 化时再接入。
    const r = await sweepProject(proj, config);
    if (r && r.ok) { out.swept++; out.changed += r.changed || 0; out.priceChanges += r.priceChanges || 0; }
  }
  out.durationMs = Date.now() - startedAt;
  Scheduler.markSwept(startedAt);
  try { Logger.info('sweep 完成', out); } catch (e) { /* 日志不可用 */ }
  try { Metrics.inc && Metrics.inc('sweep_runs_total', 1); } catch (e) { /* 非致命 */ }
  return out;
}
// 启动后台调度（SCHEDULER_ENABLED=0 完整关闭）
// 整改 §3：旧 runSweep 不再作为常驻调度——正式监控的唯一资格边界是 WatchMonitor
//（用户明确「加入监控」的 WatchTarget），未建立 WatchTarget 的对象不得因项目近 30 天
// 活跃而产生搜索/LLM/正式监控提醒等持续费用。ZB_SWEEP_ENABLED=1 是运维显式逃生门，
// 启用的也只是上文收缩版（仅 recentMoves 研究维护，无直抓、无价格/上新/断货提醒）。
// 整改 §10：日报调度换成每租户 Workspace 当地 08:00 的 digest tick（幂等 + 重启补发）。
function startScheduler() {
  if (process.env.SCHEDULER_ENABLED === '0') {
    try { Logger.info('scheduler 已禁用（SCHEDULER_ENABLED=0）'); } catch (e) {}
    return null;
  }
  // M2 技术开关：显式选择新正式监控路径（research/monitoring.js 运行时）时，
  // 由其整体接管调度入口（不含旧 sweep / 旧 digest；02 §12 直采链路）。
  if (process.env.FORMAL_MONITORING_ENABLED === '1') {
    return require('./monitoring').getMonitoringRuntime().start();
  }
  const s = process.env.ZB_SWEEP_ENABLED === '1' ? Scheduler.scheduleNext(runSweep, Logger) : null;
  const d = startDigestTick(Logger);
  // 正式监控调度（03 §12 唯一口径：Workspace 时区 06:00/14:00/22:00，认领派发 + 当日补跑；
  // 只巡检用户明确「加入监控」的 WatchTarget，不使用项目近30天活跃作监控资格）
  const w = WatchMonitor.startTick(Logger);
  try {
    Logger.info('scheduler 已启动', {
      legacySweep: s ? s.nextAt.toISOString() : 'disabled（整改 §3：正式监控唯一边界=WatchTarget）',
      digestTickMinutes: d ? d.tickMinutes : null,
      watchTick: w ? w.tickMinutes : null,
    });
  } catch (e) {}
  return { sweep: s, digestTick: d, watchTick: w };
}


module.exports = { projectLastActivityAt, sweepProject, runSweep, startScheduler };
