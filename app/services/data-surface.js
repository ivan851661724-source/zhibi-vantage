'use strict';
// ============================================================
// services/data-surface.js —— 五维数据面投影（SC-02 §7）
// ------------------------------------------------------------
// 规格依据（冻结语义）：
//   · 00 v1.2 §32：投影只读拼装，不重算业务结论；Web 前端只 render
//   · 00 v1.2 §33 / 04 §12.1（SC-02 扩展行）：surface_state 是 UI 投影态，
//     由领域事实派生（Registry 支持性 × CollectionAttempt 终态 × 新鲜度），
//     不是新领域枚举；领域失败语义仍由 SourceStatus（05 §11）承载
//   · 04 §12.2 状态优先级：stale > partial（数据在但过期，优先于部分枚举展示）
//   · 00 v1.2 §54：字段级 freshness SLA（capability-registry.freshnessSlaHours）
//   · 00 v1.2 §38：failed ≠ empty ≠ 确认无数据；partial_scan ≠ full coverage
//   · 04 §20：用户面投影剔除 provider/内部错误码/路径（错误只给产品化文案）
// 🔴 2026-10-18 整改轮（独立审核 §三）：
//   · 状态三拆：latestAttempt（最近一次执行结果）/ latestUsable（最近一次
//     可展示数据）/ isRefreshing（是否正在更新）——刷新中继续展示旧数据
//   · 失败不吞旧：最近失败但存在 latestUsable → 保留旧数据 + 明确
//     「最近更新失败，当前展示上次成功数据」gap（latest_failure）
//   · stale 与 partial 可同时产生 gap：主徽章按优先级取一，其余 gap 不吞
//   · dimension → capabilities[] → adapters[] 聚合（不得只读 caps[0]）
//   · 明细按 Registry 驱动：未接入维度零构造，绝不返回 Shopify 数据
// ============================================================
const Registry = require('./capability-registry.js');
const Adapters = require('./source-adapter.js');
const SurfaceStore = require('./surface-store.js');
const Snapshot = require('../research/source-snapshot.js');

const STALE_CLAIM_MS = 30 * 60 * 1000; // 与 watch-store 同口径：running 超时视为崩溃残留（投影层只读标记）

// R4.15：能力是否已有「可展示的真实尝试」（success / partial）。
// 用途：maturity 仍为 pending_config 的能力一旦真的采到数据，数据必须可见——
// 否则真实采集结果会被 readiness 占位状态挡住（用户看不到已采到的数据）。
function hasUsableAttempt(tenantId, projectId, competitorId, capability) {
  try {
    return SurfaceStore.listAttempts(tenantId, projectId, competitorId, capability, 10)
      .some(a => a.status === 'success' || a.status === 'partial');
  } catch (e) { return false; }
}

// 可渲染能力集合：ga 能力，或 pending_config 且已有可用尝试。
// not_integrated 永不渲染（未接入不构造数据）。
function renderableCaps(allCaps, scope) {
  const ctx = scope || {};
  return allCaps.filter(c => {
    if (c.maturity === 'ga') return true;
    if (c.maturity === 'pending_config') {
      return hasUsableAttempt(ctx.tenantId, ctx.projectId, ctx.competitorId, c.code);
    }
    return false;
  });
}

// 单能力投影（SC-02 §7 规则 + 整改轮三拆状态）
// 返回 { surfaceState, latestAttempt, latestUsable, isRefreshing, gaps[] , ... }
function deriveCapabilityState({ tenantId, projectId, competitorId, capability, brandCtx, nowMs }) {
  const cap = Registry.getCapability(capability);
  const now = nowMs || Date.now();
  if (!cap) return { surfaceState: 'unsupported', reasonCode: 'capability_undefined', reasonText: '能力尚未定义', gaps: [{ code: 'source_not_integrated', text: '该数据维度尚未接入' }] };
  if (cap.maturity !== 'ga') {
    // R4.15：maturity 未升级但已有可用尝试 → 继续按数据推导（数据可见优先于占位）；
    // 无可用尝试时保持原语义（pending_config / not_integrated 占位，不构造数据）。
    if (!hasUsableAttempt(tenantId, projectId, competitorId, cap.code)) {
      return { surfaceState: 'unsupported', reasonCode: 'source_not_integrated', reasonText: '数据源尚未接入，暂时无法采集该维度', gaps: [{ code: 'source_not_integrated', text: '该数据维度尚未接入' }] };
    }
  }
  const chain = Adapters.resolveAdapterChain(cap.code);
  if (!chain.ok || !chain.chain.length) {
    return { surfaceState: 'unsupported', reasonCode: 'adapter_chain_unresolved', reasonText: '该能力暂未接入采集器', gaps: [{ code: 'source_not_integrated', text: '该数据能力暂未接入采集器' }] };
  }
  // 与 worker 执行语义一致：链上第一个 supports 当前品牌的 adapter（fallback 即首个可用者）
  let adapter = null;
  for (const code of chain.chain) {
    const ad = Adapters.getAdapter(code);
    if (ad && ad.supports(brandCtx) && ad.supports(brandCtx).supported) { adapter = ad; break; }
  }
  if (!adapter) {
    const first = Adapters.getAdapter(chain.chain[0]);
    const chk0 = first ? first.supports(brandCtx) : { supported: false, reasonCode: 'not_supported', reasonText: '该能力暂不支持当前品牌' };
    return { surfaceState: 'unsupported', reasonCode: chk0.reasonCode, reasonText: chk0.reasonText, gaps: [{ code: chk0.reasonCode || 'not_supported', text: chk0.reasonText || '当前品牌暂不支持该数据维度' }] };
  }
  const chk = adapter.supports(brandCtx);
  const attempts = SurfaceStore.listAttempts(tenantId, projectId, competitorId, cap.code, 10);
  const nowIsoStr = new Date(now).toISOString();
  const running = attempts.find(a => a.status === 'running');
  // 过期 running（超过崩溃宽限）不是「采集中」——标记为中断失败，不得显示为尚未采集
  const runningExpired = running && (Date.parse(running.startedAt) < now - STALE_CLAIM_MS);
  const liveRunning = running && !runningExpired;
  const isRefreshing = !!liveRunning;
  const lastAttempt = attempts.length ? attempts[0] : null;
  const lastUsable = attempts.find(a => a.status === 'success' || a.status === 'partial') || null;

  const gaps = [];
  if (lastUsable) {
    const ageMs = now - Date.parse(lastUsable.endedAt || lastUsable.startedAt);
    const slaMs = (cap.freshnessSlaHours || 24) * 3600 * 1000;
    if (ageMs > slaMs) gaps.push({ code: 'insufficient_freshness', text: '数据已超过新鲜度时限，建议刷新' });
    if (lastUsable.status === 'partial') {
      const reason = lastUsable.summary && lastUsable.summary.partialScanReason;
      gaps.push({ code: 'partial_scan', text: reason ? ('最近一次采集未完成全量枚举：' + reason) : '最近一次采集未完成全量枚举' });
    }
  }
  if (runningExpired) {
    gaps.push({ code: 'interrupted', text: '上次采集被中断（服务重启或任务超时），可重新刷新。' });
  } else if (lastAttempt && lastAttempt.status === 'failed' && lastUsable) {
    // 整改 §三.2：失败保留旧数据 + 明确提示（主徽章仍展示旧数据状态）
    gaps.push({ code: 'latest_failure', text: '最近一次更新失败，当前展示上次成功数据。' });
  }

  let surfaceState;
  if (liveRunning && !lastUsable) surfaceState = 'loading'; // 首次采集中（无旧数据可展示）
  else if (!lastUsable) {
    if (lastAttempt && lastAttempt.status === 'failed') surfaceState = 'failed';
    else surfaceState = 'empty'; // 受支持、从未成功采集（≠失败≠确认无数据）
  } else {
    // 有可展示数据：主徽章按 04 §12.2 优先级 stale > partial > ok；
    // 失败/isRefreshing 信息由 latestAttempt / gaps 承载，不降级旧数据可见性
    const ageMs = now - Date.parse(lastUsable.endedAt || lastUsable.startedAt);
    const slaMs = (cap.freshnessSlaHours || 24) * 3600 * 1000;
    if (ageMs > slaMs) surfaceState = 'stale';
    else if (lastUsable.status === 'partial') surfaceState = 'partial';
    else surfaceState = 'ok';
  }

  return {
    surfaceState, reasonCode: chk.reasonCode || null, reasonText: chk.reasonText || null,
    latestAttempt: lastAttempt || (running || null), // 最近一次执行（含 running/失败）
    latestUsable: lastUsable,
    isRefreshing,
    gaps,
    // 首失败且无旧数据：failed 徽章需要失败文案
    failureText: (!lastUsable && lastAttempt && lastAttempt.status === 'failed') ? (lastAttempt.errorUserText || '最近一次采集失败，可重试。') : null,
  };
}

// attempt → 用户可视图（剔除内部字段）
function attemptUserView(a) {
  if (!a) return null;
  return {
    attemptId: a.attemptId,
    status: a.status,
    sourceStatus: a.sourceStatus || null,
    errorText: a.errorUserText || null,
    observationCount: a.observationCount,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
  };
}

// 从 attempt 摘要重算目录级统计（纯投影；目录中位数只是目录摘要，非单品价格变化语义）
function summarizeObservations(observations) {
  return Adapters.summarizeObservations(observations);
}

// evidenceRefs：snapshot/证据成对；sourceUrl = 公开来源页（04 §11 用户可核对）。
// 多 Evidence 全量展开（整改 §四.6：抽屉支持多条）。
// 🔴 Wave 1 修复：sourceUrl 优先反查 SourceSnapshot 的精确 source_url/final_url，
// 品牌主页 URL（comp.url）只作最后回退——禁止把品牌主页 URL 当所有证据的来源。
function evidenceRefsOf(attempt, comp, tenantId) {
  const out = [];
  const evIds = (attempt && attempt.evidenceIds) || [];
  const snapIds = (attempt && attempt.snapshotIds) || [];
  const n = Math.max(evIds.length, snapIds.length);
  for (let i = 0; i < n; i++) {
    let preciseUrl = null;
    const sid = snapIds[i] || null;
    if (sid && tenantId) {
      try {
        const meta = Snapshot.getById(tenantId, sid);
        if (meta) preciseUrl = meta.final_url || meta.source_url || null;
      } catch (e) { /* 反查失败回退品牌主页 URL */ }
    }
    out.push({
      evidenceId: evIds[i] || null,
      snapshotId: sid,
      sourceUrl: preciseUrl || (comp && comp.url) || null,
    });
  }
  return out;
}

function freshnessOf(cap, derived) {
  const usable = derived.latestUsable;
  if (!usable) return { status: 'unknown', slaHours: cap.freshnessSlaHours, lastSuccessAt: null };
  const at = usable.endedAt || usable.startedAt;
  const ageMs = Date.now() - Date.parse(at);
  const slaMs = (cap.freshnessSlaHours || 24) * 3600 * 1000;
  return { status: ageMs > slaMs ? 'stale' : 'fresh', slaHours: cap.freshnessSlaHours, lastSuccessAt: at };
}

// 单能力聚合块（dimension → capabilities[] 的元素）
function capabilityBlock({ tenantId, projectId, competitorId, cap, comp, nowMs }) {
  const userCap = Registry.userView(cap);
  const derived = deriveCapabilityState({
    tenantId, projectId, competitorId, capability: cap.code,
    brandCtx: { url: (comp && comp.url) || '', isShopify: !!(comp && comp.isShopify) },
    nowMs,
  });
  const usable = derived.latestUsable;
  const observations = (usable && usable.observations) || [];
  // 优先用采集时落账的全量摘要（与 Evidence extracted_value 一致）；
  // 旧行无 summary 时回退按存量观察重算
  const summary = usable ? (usable.summary || summarizeObservations(observations)) : null;
  const gaps = derived.gaps.slice();
  const actions = [];
  // 刷新操作：仅 manualRefresh 能力；采集中（loading）不重复给按钮
  if (cap.manualRefresh && derived.surfaceState !== 'loading') {
    actions.push({ code: 'refresh', label: '刷新数据' });
  }
  return {
    capability: userCap,
    surfaceState: derived.surfaceState,
    reasonText: derived.reasonText || null,
    lastSuccessAt: freshnessOf(cap, derived).lastSuccessAt,
    lastAttemptAt: derived.latestAttempt ? derived.latestAttempt.startedAt : null,
    freshness: freshnessOf(cap, derived),
    summary,
    coverage: derived.latestAttempt
      ? { attempted: 1, partial: usable ? usable.status === 'partial' : false, sourceStatus: derived.latestAttempt.sourceStatus || null, observationCount: derived.latestAttempt.observationCount }
      : { attempted: 0 },
    isRefreshing: derived.isRefreshing,
    latestAttempt: attemptUserView(derived.latestAttempt),
    gaps,
    actions,
    evidenceRefs: evidenceRefsOf(usable, comp, tenantId),
    pagination: { total: (usable && usable.observationCount) || 0 },
  };
}

// 五维总览。comp 由 handler 从项目档案解析（租户硬过滤后传入）；可为 null（未知品牌）。
// dimension → capabilities[] → adapters[]：每维聚合全部能力块（整改 §二.5）。
function buildOverview({ tenantId, projectId, competitorId, comp, nowMs }) {
  const now = nowMs || Date.now();
  const identityRows = SurfaceStore.listIdentities(tenantId, projectId, competitorId);
  const identity = identityRows.length ? identityRows[0] : null;

  const dims = Registry.listDimensions().map(d => {
    const allCaps = Registry.capabilitiesByDimension(d.code);
    // R4.15：已采到真实数据的能力必须渲染（含 maturity=pending_config 的已成功采集）
    const caps = renderableCaps(allCaps, { tenantId, projectId, competitorId });
    if (!caps.length) {
      const placeholder = allCaps[0] || null;
      // P0-2 整改 r2：pending_config 维度用户侧口径收敛——「数据服务暂不可用」；
      // 凭据要求等技术细节仅管理员健康接口可见（不出现环境变量名/key 名）。
      const pending = allCaps.filter(c => c.maturity === 'pending_config');
      if (pending.length) {
        return {
          code: d.code, displayName: d.displayName, capability: null,
          surfaceState: 'pending_config', reasonText: '数据服务暂不可用，请稍后再试。',
          freshness: { status: 'unknown', slaHours: null, lastSuccessAt: null },
          summary: null, coverage: {},
          isRefreshing: false, latestAttempt: null,
          gaps: [{ code: 'service_credential_required', text: '数据服务暂不可用' }],
          actions: [], evidenceRefs: [],
          capabilityView: placeholder ? Registry.userView(placeholder) : null,
          aggregations: [], pagination: { total: 0 },
        };
      }
      return {
        code: d.code, displayName: d.displayName, capability: null,
        surfaceState: 'unsupported', reasonText: '数据源尚未接入，暂时无法采集该维度',
        freshness: { status: 'unknown', slaHours: null, lastSuccessAt: null },
        summary: null, coverage: {},
        isRefreshing: false, latestAttempt: null,
        gaps: [{ code: 'source_not_integrated', text: '该数据维度尚未接入' }],
        actions: [], evidenceRefs: [],
        // 兼容旧单块视图：未接入维度 capability 视图给占位条目（含 maturity 说明）
        capabilityView: placeholder ? Registry.userView(placeholder) : null,
        aggregations: [], pagination: { total: 0 },
      };
    }
    const aggregations = caps.map(cap => capabilityBlock({ tenantId, projectId, competitorId, cap, comp, nowMs: now }));
    // 主投影：能力块中优先级最高的表面态（stale > partial > ok > failed > loading > empty）
    const PRIORITY = ['stale', 'partial', 'ok', 'failed', 'loading', 'empty', 'unsupported'];
    const any = aggregations.find(b => b.surfaceState === 'loading');
    let surfaceState = 'empty';
    for (const s of PRIORITY) { if (aggregations.some(b => b.surfaceState === s)) { surfaceState = s; break; } }
    if (any && !aggregations.some(b => b.surfaceState === 'stale' || b.surfaceState === 'partial' || b.surfaceState === 'ok')) {
      surfaceState = 'loading'; // 仅当没有任何可用/降级旧数据时才显示纯 loading
    }
  // gaps 汇总：latest_failure/interrupted 在卡片专门提示区渲染，投影 gaps 去重（§八.7）
  const DEDUP_IN_CARD = new Set(['latest_failure', 'interrupted']);
  const gaps = [];
  for (const b of aggregations) for (const g of b.gaps) {
    if (DEDUP_IN_CARD.has(g.code)) continue;
    gaps.push(Object.assign({ capability: b.capability.code }, g));
  }
    const evidenceRefs = [];
    for (const b of aggregations) for (const e of b.evidenceRefs) evidenceRefs.push(e);
    const total = aggregations.reduce((s, b) => s + ((b.pagination && b.pagination.total) || 0), 0);
    return {
      code: d.code, displayName: d.displayName,
      capability: aggregations[0].capability, // 兼容旧字段（首能力）
      capabilityView: aggregations[0].capability,
      surfaceState,
      reasonText: aggregations.map(b => b.reasonText).filter(Boolean)[0] || null,
      lastSuccessAt: aggregations.map(b => b.lastSuccessAt).filter(Boolean).sort().pop() || null,
      lastAttemptAt: aggregations.map(b => b.lastAttemptAt).filter(Boolean).sort().pop() || null,
      freshness: aggregations.map(b => b.freshness).find(f => f.status !== 'unknown') || { status: 'unknown', slaHours: null, lastSuccessAt: null },
      summary: aggregations.map(b => b.summary).find(s => s) || null,
      coverage: aggregations[0].coverage,
      isRefreshing: aggregations.some(b => b.isRefreshing),
      latestAttempt: aggregations.map(b => b.latestAttempt).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null,
      gaps, actions: aggregations.flatMap(b => b.actions.map(a => Object.assign({}, a, { capability: b.capability.code }))),
      evidenceRefs, aggregations,
      pagination: { total },
    };
  });

  return {
    competitorId,
    identity: identity ? {
      officialDomain: identity.officialDomain,
      identityStatus: identity.identityStatus,
      originNote: identity.originNote,
      resolverVersion: identity.resolverVersion,
      updatedAt: identity.updatedAt,
    } : null,
    identities: identityRows.map(r => ({
      platform: r.platform, platformAccountId: r.platformAccountId || null,
      officialDomain: r.officialDomain, identityStatus: r.identityStatus,
      originNote: r.originNote, resolverVersion: r.resolverVersion, updatedAt: r.updatedAt,
    })),
    dimensions: dims,
    generatedAt: new Date(now).toISOString(),
  };
}

// 单维详情（观察列表分页）。 Registry 驱动：维度 → capabilities[]；
// 每个 ga capability 出 observations；未接入维度零构造（绝不返回 Shopify 数据）。
function buildDimensionDetail({ tenantId, projectId, competitorId, dimension, offset, limit, comp }) {
  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const allCaps = Registry.capabilitiesByDimension(dimension);
  // R4.15：与总览同口径——ga 能力 + 已有可用尝试的 pending_config 能力
  const gaCaps = renderableCaps(allCaps, { tenantId, projectId, competitorId });
  const caps = gaCaps.map(cap => {
    const derived = deriveCapabilityState({
      tenantId, projectId, competitorId, capability: cap.code,
      brandCtx: { url: (comp && comp.url) || '', isShopify: !!(comp && comp.isShopify) },
    });
    const usable = derived.latestUsable;
    const runningExpired = derived.gaps.some(g => g.code === 'interrupted');
    const observations = usable ? usable.observations : [];
    const page = observations.slice(off, off + lim);
    return {
      capability: Registry.userView(cap),
      capabilityCode: cap.code,
      surfaceState: derived.surfaceState,
      isRefreshing: derived.isRefreshing,
      latestAttempt: attemptUserView(derived.latestAttempt),
      attemptId: usable ? usable.attemptId : null,
      collectedAt: usable ? (usable.endedAt || usable.startedAt) : null,
      summary: usable ? (usable.summary || summarizeObservations(observations)) : null,
      observations: page,
      pagination: { offset: off, limit: lim, total: observations.length, hasMore: off + lim < observations.length },
      evidenceRefs: evidenceRefsOf(usable, comp, tenantId),
      gaps: derived.gaps,
      interrupted: runningExpired,
    };
  });
  const anyObs = caps.some(c => c.observations.length);
  const anyUsable = caps.some(c => c.attemptId);
  const anyLoading = caps.some(c => c.surfaceState === 'loading');
  const anyFailed = caps.some(c => c.surfaceState === 'failed');
  const anyUnsupported = caps.every(c => c.surfaceState === 'unsupported');
  // 维度主状态：明细页视角——有数据 ok/partial，否则 loading/failed/empty/unsupported
  let surfaceState = 'empty';
  if (anyUnsupported) surfaceState = 'unsupported';
  else if (caps.some(c => c.surfaceState === 'stale')) surfaceState = 'stale';
  else if (caps.some(c => c.surfaceState === 'partial')) surfaceState = 'partial';
  else if (anyObs) surfaceState = 'ok';
  else if (anyLoading) surfaceState = 'loading';
  else if (anyFailed) surfaceState = 'failed';
  else if (anyUsable) surfaceState = 'empty'; // 终态成功但零观察（空目录）
  const evidenceRefs = [];
  for (const c of caps) for (const e of c.evidenceRefs) evidenceRefs.push(e);
  // 🔴 分页契约（复审 §八）：**每个 capability 独立分页状态**（capabilities[].pagination）。
  // 顶层 observations = 首个有观察 capability 的当前页（兼容旧前端单数组视图）——
  // 绝不对各 capability 分别 slice 同 offset/limit 后拼接（那会返回 limit×N 条）。
  const firstObs = caps.find(c => c.observations.length) || null;
  return {
    dimension,
    dimensionUnsupported: gaCaps.length === 0,
    surfaceState,
    // §八.8：顶层 isRefreshing 聚合各 capability 的真实 isRefreshing（不是只看 loading）
    isRefreshing: caps.some(c => c.isRefreshing) || anyLoading,
    capabilities: caps,
    // 兼容旧单数组视图（单 capability 时与 capabilities[0] 完全一致）
    capability: firstObs ? firstObs.capability : (caps[0] ? caps[0].capability : null),
    attemptId: caps.map(c => c.attemptId).find(Boolean) || null,
    collectedAt: caps.map(c => c.collectedAt).filter(Boolean).sort().pop() || null,
    summary: firstObs ? firstObs.summary : (caps.map(c => c.summary).find(s => s) || null),
    observations: firstObs ? firstObs.observations : [],
    activeCapability: firstObs ? firstObs.capabilityCode : null,
    pagination: firstObs ? firstObs.pagination : { offset: off, limit: lim, total: 0, hasMore: false },
    evidenceRefs,
  };
}

// 管理员能力矩阵（全字段 + adapter 健康；普通用户不可达）
function buildAdminMatrix() {
  const integrity = Registry.assertRegistryIntegrity();
  const adapters = Adapters.listAdapters().map(a => {
    const ad = Adapters.getAdapter(a.code);
    const h = ad ? ad.health() : { ok: false };
    return Object.assign({}, a, { health: h });
  });
  const activeJobs = [];
  try {
    const CJ = require('./collect-jobs.js');
    for (const j of CJ.list(null, null, ['pending', 'running'])) {
      activeJobs.push({ jobId: j.jobId, tenantId: j.tenantId, projectId: j.projectId, competitorId: j.competitorId, capability: j.capability, attemptId: j.attemptId, status: j.status, createdAt: j.createdAt });
    }
  } catch (e) { /* 任务模块不可用时仅省略该视图 */ }
  return {
    registryVersion: Registry.REGISTRY_VERSION,
    integrity,
    capabilities: Registry.listCapabilities().map(Registry.adminView),
    adapters,
    adapterContracts: Adapters.assertAdaptersIntegrity(),
    activeJobs,
    generatedAt: new Date().toISOString(),
  };
}

// 刷新策略查询（SC-02 §6.3：capability 级 cooldown + 额度口径；前端展示剩余冷却）
function buildRefreshPolicy({ tenantId, projectId, competitorId, capability }) {
  const cap = Registry.getCapability(capability);
  if (!cap) return null;
  const rp = cap.refreshPolicy || { cooldownMinutes: 0, dailyQuota: null };
  const now = Date.now();
  const lastOk = SurfaceStore.listAttempts(tenantId, projectId, competitorId, cap.code, 10)
    .find(a => a.status === 'success' || a.status === 'partial');
  const cooldownMs = (rp.cooldownMinutes || 0) * 60 * 1000;
  let cooldownRemainingSec = 0;
  if (lastOk && cooldownMs > 0) {
    const elapsed = now - Date.parse(lastOk.endedAt || lastOk.startedAt);
    cooldownRemainingSec = Math.max(0, Math.ceil((cooldownMs - elapsed) / 1000));
  }
  let dailyUsed = 0;
  if (rp.dailyQuota != null) {
    const d0 = new Date(now); d0.setUTCHours(0, 0, 0, 0);
    dailyUsed = SurfaceStore.getDb().prepare(`SELECT COUNT(*) AS n FROM collection_attempts
      WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=? AND started_at >= ?`)
      .get(String(tenantId || ''), String(projectId || ''), String(competitorId || ''), cap.code, d0.toISOString()).n;
  }
  return {
    capability: cap.code,
    manualRefresh: !!cap.manualRefresh,
    cooldownMinutes: rp.cooldownMinutes || 0,
    cooldownRemainingSec,
    dailyQuota: rp.dailyQuota == null ? null : rp.dailyQuota,
    dailyUsed,
    dailyRemaining: rp.dailyQuota == null ? null : Math.max(0, rp.dailyQuota - dailyUsed),
  };
}

module.exports = {
  buildOverview, buildDimensionDetail, buildAdminMatrix, buildRefreshPolicy,
  deriveCapabilityState, summarizeObservations, attemptUserView, STALE_CLAIM_MS,
};
