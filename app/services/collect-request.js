'use strict';
// ============================================================
// services/collect-request.js —— 采集请求的唯一装配入口（SC-06 r2 评审 §三.1）
// ------------------------------------------------------------
// 为什么存在：同一套「幂等 → 冷却 → 日额度 → attempt → 入队」链路此前只写在
// HTTP handler 里，自动采集（新建调研的品牌官网已确认后）无法复用，只能另写一份，
// 必然漂移。本模块把链路收成一处，HTTP 刷新与自动入队**走完全相同**的：
//   Registry 能力校验 → 运行态门控（仅 pending_config 需凭据检查）
//   → adapter 链解析 + 品牌支持预检 → SurfaceStore.createAttempt（幂等/冷却/额度）
//   → CollectJobs.enqueue（同 scope 去重）→ 可选立即 tick
// 安全链（SSRF / DNS rebinding / FetchGate / robots / 重定向 / 大小限制 / 脱敏 /
// Snapshot / Evidence / 租户隔离）由 Net.fetchPage 与 adapter 内部承担，本模块
// 不绕过任何一步，也不直接发网络请求。
// 触发枚举沿用 surface-store 的 manual/schedule（03 §20 冻结）：
// 用户点刷新 = manual；系统调研后自动采集 = schedule（系统发起，非用户点击）。
// ============================================================

const Registry = require('./capability-registry.js');
const Adapters = require('./source-adapter.js');
const SurfaceStore = require('./surface-store.js');
const CollectJobs = require('./collect-jobs.js');

/**
 * 发起一次真实采集（HTTP 与自动入队共用）。
 * @returns {{
 *   status: 'accepted'|'deduped'|'quota'|'not_supported'|'not_configured'|'unknown_capability',
 *   code?: string, message?: string,
 *   attempt?: object, job?: object, jobId?: string, reason?: string, quota?: number, deduped?: boolean
 * }}
 */
function requestCollection(input) {
  const o = input || {};
  const tenantId = String(o.tenantId || '');
  if (!tenantId) return { status: 'not_supported', code: 'AUTH_REQUIRED', message: '缺少租户上下文。' };
  const projectId = String(o.projectId || '');
  const competitorId = String(o.competitorId || '');
  const cap = Registry.getCapability(o.capability);
  if (!cap) return { status: 'unknown_capability', code: 'CAPABILITY_NOT_FOUND', message: '能力不存在。' };
  // 实现状态门控：not_integrated 拒绝；ga / pending_config / pending_verification 均可发起真实采集
  if (!cap.manualRefresh || cap.maturity === 'not_integrated') {
    return { status: 'not_supported', code: 'CAPABILITY_NOT_SUPPORTED', message: '该数据维度尚未接入，暂不支持刷新。' };
  }
  // 运行态门控（只对需要凭据的 pending_config 生效；公开来源无凭据，直接进入真实采集）
  if (cap.maturity === 'pending_config') {
    const Readiness = require('./source-readiness.js');
    const rd = Readiness.getReadiness(cap.code);
    if (rd.state === 'not_configured') {
      // 用户侧文案不出现环境变量名 / key 名（技术细节仅管理员健康接口可见）
      return { status: 'not_configured', code: 'SOURCE_NOT_CONFIGURED', message: '数据服务暂不可用，请稍后再试。' };
    }
    // ready_to_verify / operational / auth_rejected / quota_exhausted / unavailable → 允许真实采集
  }
  const comp = o.comp || {};
  // adapter 链（Registry 策略驱动：single/fallback/fanout，不硬编码 adapters[0]）
  const chain = Adapters.resolveAdapterChain(cap.code);
  if (!chain.ok) {
    return { status: 'not_supported', code: 'CAPABILITY_NOT_SUPPORTED', message: '该能力暂无可用采集器。' };
  }
  let adapter = null;
  for (const code of chain.chain) {
    const ad = Adapters.getAdapter(code);
    if (!ad) continue;
    const chk = ad.supports({ url: comp.url, isShopify: comp.isShopify });
    if (chk && chk.supported) { adapter = ad; break; }
  }
  if (!adapter) {
    const first = Adapters.getAdapter(chain.chain[0]);
    const chk0 = first ? first.supports({ url: comp.url, isShopify: comp.isShopify }) : null;
    return {
      status: 'not_supported', code: 'CAPABILITY_NOT_SUPPORTED',
      message: (chk0 && chk0.reasonText) || '当前品牌不支持该数据维度。',
    };
  }
  // 幂等预检（SC-02 §6/§6.3）：running 复用 / capability cooldown / 日额度
  const mk = SurfaceStore.createAttempt({
    tenantId, projectId, competitorId, capability: cap.code, dimension: cap.dimension,
    trigger: o.trigger === 'schedule' ? 'schedule' : 'manual', nowMs: o.nowMs || Date.now(),
    costAttributionKey: cap.costAttributionKey,
    collectorVersion: cap.collectorVersion, parserVersion: cap.parserVersion,
    idempotencyKey: o.idempotencyKey || undefined,
  });
  if (mk.quotaExceeded) {
    return { status: 'quota', code: 'REFRESH_QUOTA_EXCEEDED', message: '今日刷新次数已达上限，明天再来吧。', quota: mk.quota };
  }
  if (mk.deduped) {
    return {
      status: 'deduped', deduped: true,
      attempt: mk.attempt, reason: mk.cooldown ? 'cooldown' : 'in_progress_or_recent',
    };
  }
  const attemptId = mk.attempt.attemptId;
  const job = CollectJobs.enqueue({
    tenantId, projectId, competitorId, capability: cap.code,
    attemptId, trigger: o.trigger === 'schedule' ? 'schedule' : 'manual',
    // SC-09 r2 §一：采集用途随任务持久化（first_collection / manual_refresh / monitoring）。
    // 未显式给出时由 collect-jobs 取最保守默认值——绝不把 schedule 推断成 monitoring。
    collectionPurpose: o.collectionPurpose || null,
    windowKey: o.windowKey || null,
  });
  if (job.deduped) {
    return { status: 'deduped', deduped: true, attempt: mk.attempt, jobId: job.jobId, reason: 'in_progress_or_recent' };
  }
  // worker 可能处于 tick 间隙或未启动（测试/边缘部署）：入队后立即触发一次 tick，
  // 但执行体在持久任务内完成——不是 fire-and-forget，失败/重启可恢复。
  if (o.tickNow !== false) {
    setImmediate(() => { try { CollectJobs.tick({ workerId: 'w-req-' + process.pid }).catch(() => {}); } catch (e) { /* worker 未启动不影响入队 */ } });
  }
  return { status: 'accepted', attempt: mk.attempt, jobId: job.jobId, job };
}

/**
 * 调研完成后的首轮采集（SC-07 §1 扩展）。
 * 官方资料只是第一项：有 Shopify 目录就安排商品采集；公开商品页能力只有
 * 运行态 operational（真实验证过）才安排；公开评论只在搜索链实际可用时安排。
 * 逐项决策理由由 services/collection-plan.js 记录（不静默跳过）。
 * 任何异常都被吞掉——自动采集失败不能影响调研主链路。
 *
 * @returns {{enqueued: boolean, capability: string, reason: ?string, planned: Array}}
 */
function autoCollectAfterResearch({ tenantId, projectId, comp, who }) {
  const out = { enqueued: false, capability: 'official_site_profile', reason: null, planned: [] };
  try {
    if (!tenantId || !projectId || !comp || !comp.id) { out.reason = 'missing_context'; return out; }
    if (!comp.url || !/^https?:\/\//i.test(String(comp.url))) { out.reason = 'no_official_url'; return out; }
    // 延迟 require：collection-plan 依赖本模块，避免循环依赖在加载期互相卡住
    const Plan = require('./collection-plan.js');
    const planned = Plan.planForCompetitor({ tenantId, projectId, comp, trigger: 'schedule' });
    out.planned = planned.decisions || [];
    const site = out.planned.find(d => d.capability === 'official_site_profile') || null;
    const accepted = out.planned.filter(d => d.decision === 'enqueued');
    out.enqueued = accepted.length > 0;
    if (accepted.length) out.capability = accepted[0].capability;
    if (site) {
      out.result = site.decision;
      out.jobId = site.jobId || null;
      out.attemptId = site.attemptId || null;
      out.reason = site.decision === 'enqueued' ? null : (site.reason || site.decision);
    } else {
      out.result = 'skipped';
      out.reason = out.reason || 'no_official_url';
    }
    try {
      require('./logger.js').info('auto_collect_after_research', {
        who: who || 'research', tenantId, projectId, competitorId: comp.id,
        capability: out.capability, status: out.result || null, reason: out.reason || null,
        planned: out.planned.map(d => d.capability + ':' + d.decision).join(','),
      });
    } catch (e2) { /* 日志失败不影响主链路 */ }
    return out;
  } catch (e) {
    out.reason = 'exception:' + String((e && e.message) || e).slice(0, 120);
    return out;
  }
}

module.exports = { requestCollection, autoCollectAfterResearch };
