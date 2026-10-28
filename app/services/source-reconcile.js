'use strict';
// ============================================================
// services/source-reconcile.js —— 轻量对账（r3 §三）
// ------------------------------------------------------------
// 解决的真实问题：
//   「工作台/竞品库里的品牌永久停在未探测」有四种成因，其中两种是产品缺陷：
//     ① 新项目 / 新增品牌没有自动首采计划（要用户点按钮才有 attempt）；
//     ② 老链路把「官网可访问但无可比字段」判成 source_failed 后，
//        再没有任何东西把它推回 establishing，于是永久停在失败。
//   本模块只做两件幂等的事：
//     · 对「从未有过任何 attempt」的品牌补一条首采计划（不碰已有成功的品牌）；
//     · 对「官网可访问但停在 source_failed」的意向，用已有 attempt 进度续跑官网探测。
//   绝不修改已有成功 attempt、绝不重置进度、绝不重复建意向。
//
// 节流：同一租户×项目 60s 内最多跑一次（页面轮询/多标签页不会放大外部请求）。
// ============================================================

const RECONCILE_MIN_INTERVAL_MS = Math.max(5000, Number(process.env.ZB_RECONCILE_MS || 60000));
const MAX_BRANDS_PER_RUN = 5;
const _lastRun = new Map();

function attemptsOf(tid, pid, cid) {
  try {
    return require('./surface-store.js').listAttemptsByCompetitor(tid, pid, cid, 8) || [];
  } catch (e) { return []; }
}

function siteAttemptsOf(tid, pid, cid) {
  return attemptsOf(tid, pid, cid)
    .filter(a => a && a.capability === 'official_site_profile' && (a.status === 'success' || a.status === 'partial'));
}

/**
 * 对账一个项目。
 * @param {object} input { tenantId, projectId, force, trigger }
 * @returns {object} 汇总（不含内部堆栈）
 */
function reconcileProject(input) {
  const o = input || {};
  const tid = String(o.tenantId || ''); const pid = String(o.projectId || '');
  if (!tid || !pid) return { ok: false, error: 'MISSING_CONTEXT' };
  const key = tid + ':' + pid;
  const now = Date.now();
  const prev = _lastRun.get(key);
  if (!o.force && prev && now - prev.at < RECONCILE_MIN_INTERVAL_MS) {
    return { ok: true, throttled: true, lastRunAt: new Date(prev.at).toISOString(), summary: prev.summary };
  }

  const BrandSvc = require('./brand-service.js');
  const Plan = require('./collection-plan.js');
  const WIntent = require('./watch-intent.js');
  const state = BrandSvc.loadProjectState(tid, pid);
  if (!state) return { ok: false, error: 'PROJECT_NOT_FOUND' };
  const comps = (state.competitors || []).filter(c => c && c.id && c.status === 'done');

  const out = {
    ok: true, projectId: pid,
    brands: comps.length,
    planned: [],      // 补了首采计划的品牌
    resumed: [],      // 续跑官网探测的品牌
    untouched: 0,     // 已有 attempt（不重复采集）
    enqueued: 0,
    at: new Date(now).toISOString(),
  };

  let plannedBrands = 0;
  for (const comp of comps) {
    const atts = attemptsOf(tid, pid, comp.id);
    const intent = (() => { try { return WIntent.findIntent(tid, pid, comp.id); } catch (e) { return null; } })();

    // ① 从未采集过 → 补首采计划（有界，每轮最多 N 个品牌）
    if (!atts.length && plannedBrands < MAX_BRANDS_PER_RUN) {
      try {
        const r = Plan.planForCompetitor({
          tenantId: tid, projectId: pid, comp,
          trigger: o.trigger || 'reconcile', runId: 'rc_' + now.toString(36),
          dryRun: false, reviewsAllowed: false, skipTerminal: true,
        });
        const queued = (r.decisions || []).filter(d => d.decision === 'enqueued').length;
        out.enqueued += queued;
        out.planned.push({ competitorId: comp.id, name: comp.name || null, enqueued: queued });
        plannedBrands += 1;
        continue;
      } catch (e) { /* 单个品牌计划失败不阻断其他品牌 */ }
    }

    // ② 官网可访问但停在 source_failed，且已有官网 attempt → 续跑（不重置进度）
    if (intent && intent.state === 'source_failed') {
      const reason = String(intent.reasonCode || '');
      const resumable = reason === 'no_comparable_products' || reason === 'insufficient_structured_fields';
      if (resumable && siteAttemptsOf(tid, pid, comp.id).length >= 1) {
        try {
          const r = WIntent.resumeSiteProbe(tid, pid, comp.id);
          if (r && r.resumed) out.resumed.push({ competitorId: comp.id, name: comp.name || null, siteAttempts: siteAttemptsOf(tid, pid, comp.id).length });
        } catch (e) { /* 续跑失败保持原状态，不伪造成功 */ }
        continue;
      }
    }
    out.untouched += 1;
  }

  _lastRun.set(key, { at: now, summary: { planned: out.planned.length, resumed: out.resumed.length, enqueued: out.enqueued } });
  return out;
}

function lastRunOf(tenantId, projectId) {
  const e = _lastRun.get(String(tenantId) + ':' + String(projectId));
  return e ? { at: new Date(e.at).toISOString(), summary: e.summary } : null;
}

module.exports = { reconcileProject, lastRunOf, RECONCILE_MIN_INTERVAL_MS };
