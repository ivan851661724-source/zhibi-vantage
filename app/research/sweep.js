'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/sweep.js —— 导出: projectLastActivityAt, sweepProject, runSweep, startScheduler
// ============================================================

const { loadConfig } = require('../core/config.js');
const { projFile, saveState } = require('../core/state-store.js');
const { decorateState } = require('./decorate.js');
const { deepDiveField } = require('./deepdive.js');
const { llmApiKey } = require('./llm.js');
const { curSym } = require('./vocab.js');
const PH = require('../lib/price-history.js');
const priceStore = require('./price-store.js');
const Alerts = require('../services/alerts.js');
const Logger = require('../services/logger.js');
const M = require('../lib/metrics.js');
const Metrics = require('../services/metrics.js');
const Scheduler = require('../services/scheduler.js');
const { runDigest } = require('./digest.js');
const db = require('../services/db.js');
const fs = require('fs');


// ============ 模块 2-1：定时增量雷达（日 4 趟） ============
// 背景：「雷达」原为单次体检（radar.js 是变化检测算子但无时序数据喂）。
// sweep = 周期性重抓各活跃项目竞品的近期动作（recentMoves），
//   变化写入 state + events（timeline 序列），产出「Agent 在后台一直跑」的材料。
// 纪律：
//   · 僵尸项目（近 30 天无研究活动）零成本跳过 —— 预算池硬顶；
//   · 变化探测复用 deepDiveField（recentMoves 单字段重研，1 搜索 + 1 LLM/竞品）；
//   · serp-probe 7d 缓存兜住跨趟重复查询（命中免配额）；
//   · LLM 日预算（ZB_DAILY_BUDGET_YUAN）由 llm-gateway 熔断兜底。
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
// 对单个项目做一轮增量变化探测
async function sweepProject(proj, config) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(projFile(proj.id, proj.tenantId), 'utf8')); } catch (e) { return { ok: false, reason: 'no_state' }; }
  if (!state || !Array.isArray(state.competitors)) return { ok: false, reason: 'no_state' };
  const hasLlm = !!llmApiKey(config);
  const beforeMoves = new Map(state.competitors.map(c => [c.id, JSON.stringify(c.recentMoves || [])]));
  // 2026-09-05 预警推送：记录"谁变了、新增了什么动作"（不止计数），供站内信/Webhook
  const newMoves = [];
  let probed = 0, changed = 0;
  // R1 跟价闭环（PRD R1.1/R1.2）：本轮价格快照与变价事件
  const tid = state.tenantId || proj.tenantId;
  let priceList = priceStore.load(tid, proj.id);
  const priceEvents = [];
  for (const comp of state.competitors) {
    if (comp.status !== 'done' || comp.suppressed) continue;
    if (!hasLlm) break; // 无 LLM key：变化探测无法执行（搜索仅能带回原始片段）
    try {
      const r = await deepDiveField(state, comp, 'recentMoves', config);
      probed++;
      if (JSON.stringify(comp.recentMoves || []) !== beforeMoves.get(comp.id)) {
        changed++;
        // diff：after 中不在 before 的条目 = 新增动作（按 JSON 归一化匹配）
        let prev = [];
        try { prev = JSON.parse(beforeMoves.get(comp.id) || '[]'); } catch (e) {}
        const added = (comp.recentMoves || []).filter(x => !prev.some(y => JSON.stringify(y) === JSON.stringify(x)));
        if (added.length) newMoves.push({ competitorId: comp.id, name: comp.name, moves: added });
      }
    } catch (e) { /* 单家探测失败不阻断整轮 */ }
    // ---- R1：探价 → 快照 → 变价事件（1 搜索 + 1 LLM/竞品，成本由 LLM 日预算熔断兜底） ----
    try {
      await deepDiveField(state, comp, 'price', config);
      probed++; // 价格探测也计入探测数
      const price = priceStore.currentScalarPrice(comp);
      const res = PH.applySnapshot(priceList, {
        competitorId: comp.id,
        price,
        display: (comp.priceField && comp.priceField.display) || (price != null ? String(price) : null),
        currency: comp.currency || 'USD',
        url: (comp.priceField && (comp.priceField.sources || [])[0] && comp.priceField.sources[0].url) || comp.url || '',
        at: new Date().toISOString(),
        basis: (comp.priceField && comp.priceField.basis) || 'unverified',
      });
      priceList = res.list;
      if (res.event) {
        priceEvents.push({ comp, event: res.event });
        if (res.event.kind === 'changed') {
          // 变价进雷达动态（append 在 moves diff 之后，下一趟 beforeMoves 已含本条，不会误报）
          comp.recentMoves = Array.isArray(comp.recentMoves) ? comp.recentMoves : [];
          comp.recentMoves.push({ type: 'price', desc: PH.describeChange(res.event, curSym), when: res.event.at, basis: res.event.basis === 'verified' ? 'verified' : 'inferred' });
          if (comp.recentMoves.length > 8) comp.recentMoves = comp.recentMoves.slice(-8);
        }
      }
    } catch (e) { /* 单家探价失败不阻断整轮 */ }
  }
  if (priceList.length) priceStore.save(tid, proj.id, priceList);
  if (changed > 0) {
    // 变化：重新派生（domainVerdicts/materials 等）+ 记时序事件（timeline 数据源）
    try {
      decorateState(state);
      M.logEvent({ changeType: 'sweep_changes', source: 'sweep', from: String(probed), to: String(changed), confidence: null });
    } catch (e) { /* 派生/记账失败不影响落盘 */ }
    // 预警推送（技术债 §6 ⬜ 修复）：有新增动作 → 站内信落盘 + Webhook（若配置）
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
  // ---- R1.2：变价事件推送（独立于动作变化；格式对齐 PRD 验收「降价 12%（$29.99→$26.39）」） ----
  if (priceEvents.length) {
    const webhookUrl = (config.alerts && config.alerts.webhookUrl) || '';
    try {
      priceEvents.forEach(({ comp, event }) => {
        const text = PH.describeChange(event, curSym);
        Alerts.push(tid, {
          type: event.kind === 'changed' ? 'price-change' : 'price-discovered',
          projectId: proj.id, track: state.track,
          competitorId: comp.id, competitorName: comp.name,
          text,
          old: event.old != null ? event.old : null,
          new: event.price,
          deltaPct: event.deltaPct != null ? event.deltaPct : null,
          currency: event.currency,
          sourceUrl: event.url || null,
          basis: event.basis || 'unverified',
        }, webhookUrl);
        // 变价事件进时序记忆（timeline/北极星数据源）
        try { M.logEvent({ changeType: 'price_' + (event.kind === 'changed' ? 'changed' : 'discovered'), competitorId: comp.id, from: event.old != null ? String(event.old) : null, to: String(event.price), source: event.url || null, confidence: event.basis === 'verified' ? 'high' : 'medium', tenantId: tid }); } catch (e) {}
      });
    } catch (e) { /* 推送失败不影响落盘 */ }
    try { Logger.info('sweep 变价事件', { projectId: proj.id, count: priceEvents.length }); } catch (e) {}
  }
  saveState(state);
  // 更新 lastSweepAt（db 镜像表，scheduler/status 用）
  try {
    const dbProj = db.getProject(proj.tenantId, proj.id);
    if (dbProj) { dbProj.lastSweepAt = new Date().toISOString(); db.saveProject(dbProj); }
  } catch (e) { /* 非致命 */ }
  return { ok: true, probed, changed, priceChanges: priceEvents.length };
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
// 启动定时雷达（SCHEDULER_ENABLED=0 完整关闭）
function startScheduler() {
  if (process.env.SCHEDULER_ENABLED === '0') {
    try { Logger.info('scheduler 已禁用（SCHEDULER_ENABLED=0）'); } catch (e) {}
    return null;
  }
  const s = Scheduler.scheduleNext(runSweep, Logger);
  const d = Scheduler.scheduleDaily(runDigest, Logger); // R4.2：每日邮件摘要（未配置邮件通道则静默跳过）
  try { Logger.info('scheduler 已启动', { nextAt: s.nextAt.toISOString(), hours: s.hours, digestNextAt: d.nextAt.toISOString() }); } catch (e) {}
  return s;
}


module.exports = { projectLastActivityAt, sweepProject, runSweep, startScheduler };
