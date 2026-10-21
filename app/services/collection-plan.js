'use strict';
// ============================================================
// services/collection-plan.js —— 首轮采集计划与项目基线补建（SC-07 §1）
// ------------------------------------------------------------
// 解决的现象：15+ 个已登记品牌在竞品数据库里永远是「尚未开始采集」。
// 根因不是部署落后、也不是执行失败——是**根本未入队**：调研完成后的自动采集
// 只安排了 official_site_profile 一项，且只对「之后新调研的品牌」生效，
// 已有项目从未被补建过。
//
// 本模块只做「决定采什么 + 走既有链路入队」，不新增采集实现：
//   · 全部复用 services/collect-request.requestCollection 的
//     幂等 / 冷却 / 日额度 / attempt / 持久任务 / worker fencing / 租户隔离；
//   · 计划本身有界：单次最多 N 个品牌、最多 M 次搜索型采集（评论发现），可重复执行；
//   · 每个品牌每一项都留决策记录（入队 / 去重 / 跳过 / 失败 + 原因），
//     不接受「静默没采」。
//
// 能力准入（不按代码存在就抓，按真实验证状态抓）：
//   official_site_profile   ga（已真实成功验证）→ 有官网即安排
//   shopify_catalog         仅 Shopify 站点；非 Shopify 不安排（不做无效任务）
//   public_site_products    运行态必须已 operational（完成过真实商品页成功采集），
//                           否则跳过并记 awaiting_real_verification——不自动大规模抓取
//   public_reviews          搜索链实际可用（任选其一即可）才安排；否则跳过并记
//                           source_not_configured，不产生无效任务、不无限重试
// ============================================================

const Registry = require('./capability-registry.js');
const Readiness = require('./source-readiness.js');
const SurfaceStore = require('./surface-store.js');
const CollectReq = require('./collect-request.js');

// 计划顺序：官网资料 → Shopify 目录 → 公开商品页 → 公开评论（搜索最贵，最后且限量）
const PLAN_ORDER = Object.freeze(['official_site_profile', 'shopify_catalog', 'public_site_products', 'public_reviews']);
const REVIEWS_CAP = 'public_reviews';

let _tableReady = false;
function ensureTable() {
  if (_tableReady) return;
  const db = SurfaceStore.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS collection_plan_log (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT,
    job_id TEXT,
    attempt_id TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_cpl_scope ON collection_plan_log(tenant_id, project_id, created_at)');
  _tableReady = true;
}

function rid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function logDecision(row) {
  try {
    ensureTable();
    SurfaceStore.getDb().prepare(`INSERT INTO collection_plan_log
      (id, tenant_id, project_id, competitor_id, capability, decision, reason, job_id, attempt_id, run_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
      rid('cpl'), row.tenantId, row.projectId, row.competitorId, row.capability, row.decision,
      row.reason || null, row.jobId || null, row.attemptId || null, row.runId || null,
      new Date().toISOString(),
    );
  } catch (e) { /* 记日志失败不影响采集决策 */ }
}

function capOf(code) { return Registry.getCapability(code) || null; }

function isShopifyComp(comp) {
  const c = comp || {};
  return !!(c.url && (c.isShopify || /shopify/i.test(String(c.url))));
}

// 单项准入判断（不发起采集，只回答「能不能安排、不能的原因」）
// r2 §五：public_reviews 失败门控补齐——注释声称「额度耗尽不会无限重试」，
// 实际只跳过 not_configured / auth_rejected。真实规则（自动计划 = trigger schedule）：
//   quota_exhausted/rate_limited → 有界冷却（ZB_REVIEW_FAILURE_COOLDOWN_MS，默认 6h），
//                                  冷却未到不重复创建任务；冷却到点允许一次受控检查；
//   unavailable                  → 退避（ZB_REVIEW_RETRY_BACKOFF_MS，默认 30min）后重试；
//   auth_rejected/not_configured → 配置恢复前不自动重试；
//   用户手动重试（trigger manual）→ 可触发一次受控检查，仍受冷却/额度/幂等约束
//                                  （requestCollection 链路强制），不在此处放行无限重试。
const REVIEW_COOLDOWN_MS = Math.max(60 * 1000, Number(process.env.ZB_REVIEW_FAILURE_COOLDOWN_MS) || 6 * 60 * 60 * 1000);
const REVIEW_BACKOFF_MS = Math.max(60 * 1000, Number(process.env.ZB_REVIEW_RETRY_BACKOFF_MS) || 30 * 60 * 1000);

function reviewsGate(rd, opts) {
  const o = opts || {};
  const manual = o.trigger === 'manual';
  if (rd.state === 'not_configured') {
    // 手动也不放行「未配置」：没有凭据时发起必然失败（仍是受控行为，但无意义）
    return { ok: false, reason: 'source_not_configured', readiness: rd.state };
  }
  if (rd.state === 'auth_rejected') {
    if (manual) return { ok: true, readiness: rd.state, manualCheck: true }; // 手动触发一次受控检查
    return { ok: false, reason: 'source_auth_rejected', readiness: rd.state };
  }
  if (rd.state === 'quota_exhausted') {
    const readyAt = rd.lastFailureAt ? Date.parse(rd.lastFailureAt) + REVIEW_COOLDOWN_MS : 0;
    if (manual) return { ok: true, readiness: rd.state, manualCheck: true };
    if (Date.now() < readyAt) return { ok: false, reason: 'source_cooldown', readiness: rd.state, retryAfterMs: readyAt - Date.now() };
    return { ok: true, readiness: rd.state }; // 冷却到点：允许一次受控检查（仍受日额度/幂等约束）
  }
  if (rd.state === 'unavailable') {
    const readyAt = rd.lastFailureAt ? Date.parse(rd.lastFailureAt) + REVIEW_BACKOFF_MS : 0;
    if (Date.now() < readyAt) {
      if (manual) return { ok: true, readiness: rd.state, manualCheck: true };
      return { ok: false, reason: 'source_backoff', readiness: rd.state, retryAfterMs: readyAt - Date.now() };
    }
    return { ok: true, readiness: rd.state };
  }
  return { ok: true, readiness: rd.state };
}

function gate(code, comp, opts) {
  const o = opts || {};
  const cap = capOf(code);
  if (!cap) return { ok: false, reason: 'capability_not_registered' };
  if (!cap.manualRefresh || cap.maturity === 'not_integrated') return { ok: false, reason: 'capability_not_integrated' };
  if (code === 'official_site_profile') {
    if (!comp.url || !/^https?:\/\//i.test(String(comp.url))) return { ok: false, reason: 'no_official_url' };
    if (cap.maturity !== 'ga') return { ok: false, reason: 'capability_not_verified' };
    return { ok: true };
  }
  if (code === 'shopify_catalog') {
    if (!isShopifyComp(comp)) return { ok: false, reason: 'not_shopify_site' };
    if (!comp.url) return { ok: false, reason: 'no_official_url' };
    return { ok: true };
  }
  if (code === 'public_site_products') {
    if (!comp.url) return { ok: false, reason: 'no_official_url' };
    // 运行态门控：必须已发生过一次真实成功（operational），否则不自动抓
    const rd = Readiness.getReadiness('public_site_products');
    if (rd.state !== 'operational') return { ok: false, reason: 'awaiting_real_verification', readiness: rd.state };
    return { ok: true };
  }
  if (code === REVIEWS_CAP) {
    if (!comp.url && !comp.name) return { ok: false, reason: 'missing_brand_identity' };
    const rd = Readiness.getReadiness(REVIEWS_CAP);
    const g = reviewsGate(rd, { trigger: o.trigger });
    if (!g.ok) return { ok: false, reason: g.reason, readiness: g.readiness, retryAfterMs: g.retryAfterMs || null };
    // 搜索型采集限量：达到本批预算后跳过（可重复执行，下轮继续），不无限打满搜索配额
    if (o.reviewsAllowed === false) return { ok: false, reason: 'search_budget_exhausted', readiness: g.readiness };
    return { ok: true, readiness: g.readiness };
  }
  return { ok: false, reason: 'unknown_capability' };
}

/**
 * 单品牌首轮计划。
 * @param {object} input {tenantId, projectId, comp, trigger, runId, dryRun, reviewsAllowed}
 * @returns {{competitorId, decisions: Array<{capability, decision, reason, jobId, attemptId}>}}
 */
function planForCompetitor(input) {
  const o = input || {};
  const tenantId = String(o.tenantId || '');
  const projectId = String(o.projectId || '');
  const comp = o.comp || {};
  const runId = o.runId || null;
  const trigger = o.trigger === 'manual' ? 'manual' : 'schedule';
  const out = { competitorId: comp.id || null, decisions: [] };
  if (!tenantId || !projectId || !comp.id) {
    out.decisions.push({ capability: null, decision: 'skipped', reason: 'missing_context' });
    return out;
  }
  if (comp.status !== 'done') {
    out.decisions.push({ capability: null, decision: 'skipped', reason: 'research_not_done' });
    logDecision({ tenantId, projectId, competitorId: comp.id, capability: '*', decision: 'skipped', reason: 'research_not_done', runId });
    return out;
  }
  for (const code of PLAN_ORDER) {
    const g = gate(code, comp, { reviewsAllowed: o.reviewsAllowed, trigger });
    if (!g.ok) {
      out.decisions.push({ capability: code, decision: 'skipped', reason: g.reason, readiness: g.readiness || null });
      if (!o.dryRun) logDecision({ tenantId, projectId, competitorId: comp.id, capability: code, decision: 'skipped', reason: g.reason, runId });
      continue;
    }
    if (o.dryRun) {
      out.decisions.push({ capability: code, decision: 'planned', reason: 'dry_run', readiness: g.readiness || null });
      continue;
    }
    let r = null;
    try {
      r = CollectReq.requestCollection({
        tenantId, projectId, competitorId: comp.id, capability: code,
        comp: { url: comp.url, isShopify: comp.isShopify, name: comp.name },
        trigger,
      });
    } catch (e) {
      r = { status: 'failed', code: 'EXCEPTION', message: String((e && e.message) || e).slice(0, 160) };
    }
    const decision = r.status === 'accepted' ? 'enqueued'
      : r.status === 'deduped' ? 'deduped'
        : (r.status === 'quota' ? 'quota' : (r.status === 'not_configured' ? 'skipped' : 'failed'));
    const reason = r.status === 'accepted' ? null : (r.reason || r.code || r.status || null);
    const rec = {
      capability: code, decision, reason,
      jobId: r.jobId || null,
      attemptId: (r.attempt && r.attempt.attemptId) || null,
      readiness: g.readiness || null,
    };
    out.decisions.push(rec);
    logDecision({
      tenantId, projectId, competitorId: comp.id, capability: code,
      decision, reason, jobId: rec.jobId, attemptId: rec.attemptId, runId,
    });
  }
  return out;
}

/**
 * 项目级基线补建（有界、可重复执行；服务重启后可再次运行，幂等由既有链路保证）。
 * @param {object} input {tenantId, projectId, limit, maxReviews, dryRun, trigger}
 * @returns {object} 汇总 + 逐品牌逐能力决策
 */
function bootstrapProject(input) {
  const o = input || {};
  const tenantId = String(o.tenantId || '');
  const projectId = String(o.projectId || '');
  const BrandSvc = require('./brand-service.js');
  const state = BrandSvc.loadProjectState(tenantId, projectId);
  if (!tenantId || !projectId || !state) {
    return { ok: false, error: 'PROJECT_NOT_FOUND', runId: null, decisions: [] };
  }
  const runId = rid('cpr');
  const limit = Math.max(1, Math.min(Number(o.limit) || 50, 200));
  const maxReviews = Math.max(0, Math.min(Number.isFinite(Number(o.maxReviews)) ? Number(o.maxReviews) : 5, 50));
  const comps = (state.competitors || []).filter(c => c && c.id && c.status === 'done').slice(0, limit);
  const counts = { enqueued: 0, deduped: 0, skipped: 0, failed: 0, quota: 0, planned: 0 };
  const perBrand = [];
  let reviewsUsed = 0;
  const t0 = Date.now();
  for (const comp of comps) {
    // 搜索型采集限量：达到预算后其余品牌本轮跳过（可重复执行，下轮继续），避免一次打满搜索配额
    const reviewsAllowed = reviewsUsed < maxReviews;
    const planned = planForCompetitor({
      tenantId, projectId, comp, trigger: o.trigger || 'schedule',
      runId, dryRun: !!o.dryRun, reviewsAllowed,
    });
    let usedHere = 0;
    planned.decisions.forEach((d) => {
      counts[d.decision] = (counts[d.decision] || 0) + 1;
      if (d.capability === REVIEWS_CAP && (d.decision === 'enqueued' || d.decision === 'planned')) usedHere += 1;
    });
    reviewsUsed += usedHere;
    const brandName = comp.name || comp.id;
    const reasons = planned.decisions
      .filter(d => d.decision === 'skipped' || d.decision === 'failed' || d.decision === 'quota')
      .map(d => (d.capability || 'general') + ':' + (d.reason || d.decision));
    perBrand.push({
      competitorId: comp.id,
      name: brandName,
      url: comp.url || null,
      isShopify: !!comp.isShopify,
      decisions: planned.decisions,
      // 一句话结论，供报告/接口直接展示
      headline: planned.decisions.some(d => d.decision === 'enqueued') ? '已入队'
        : (planned.decisions.some(d => d.decision === 'deduped') ? '已存在（去重）'
          : (planned.decisions.some(d => d.decision === 'planned') ? '可入队（dry-run）' : '未入队')),
      reasons,
    });
  }
  const summary = {
    ok: true, runId, tenantId, projectId,
    dryRun: !!o.dryRun,
    brands: comps.length,
    brandsInProject: (state.competitors || []).filter(c => c && c.id).length,
    counts,
    budget: { maxReviews, reviewsUsed, maxBrands: limit },
    elapsedMs: Date.now() - t0,
    perBrand,
  };
  try {
    require('./logger.js').info('collection_bootstrap', {
      tenantId, projectId, runId, brands: comps.length, counts, reviewsUsed,
    });
  } catch (e) { /* 日志失败不影响结果 */ }
  return summary;
}

// 最近一次补建/计划的决策（运维与报告用；按租户硬过滤）
function listPlanLog(tenantId, projectId, limit) {
  ensureTable();
  return SurfaceStore.getDb().prepare(
    `SELECT capability, decision, reason, competitor_id, job_id, run_id, created_at
     FROM collection_plan_log WHERE tenant_id=? AND project_id=?
     ORDER BY created_at DESC LIMIT ?`
  ).all(String(tenantId || ''), String(projectId || ''), Math.max(1, Math.min(Number(limit) || 100, 500)));
}

module.exports = {
  PLAN_ORDER, REVIEWS_CAP,
  gate, planForCompetitor, bootstrapProject, listPlanLog,
};
