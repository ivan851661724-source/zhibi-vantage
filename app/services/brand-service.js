'use strict';
// ============================================================
// services/brand-service.js —— 统一竞品读模型（SC-04）
//   · 只读投影：真值链（SourceSnapshot→Evidence→Fact→Metric→DomainEvent→Judgment）
//     与 Data Surface attempts 只被读取，不复制为新的事实、不改原始真值；
//   · 未接入维度一律「未接入」，无数据一律「尚未采集」，绝不伪造或推测填充；
//   · 全部读取 tenantId 硬过滤，跨租户 → null（上层 404）。
//   用户语言：数据性质（来源直接记录 / 官方公开数据 / 数据服务估算 /
//   按已有数据计算 / 根据公开内容归纳）与状态（已核实 / 待核实 / 资料不足 /
//   来源冲突）在此统一映射。
// ============================================================
const path = require('path');
const fs = require('fs');

const BrandStore = require('./brand-store.js');
const Registry = require('./capability-registry.js');
const Surface = require('./data-surface.js');
const SurfaceStore = require('./surface-store.js');
const EvidenceStore = require('../research/evidence-store.js');
const DomainEvent = require('../research/domain-event.js');

// 数据性质（nature）→ 用户语言
const NATURE_TEXT = Object.freeze({
  observed: '来源直接记录',
  official: '官方公开数据',
  estimated: '数据服务估算',
  computed: '按已有数据计算',
  summarized: '根据公开内容归纳',
  backfilled: '后续补入的历史',
  corrected: '用户纠错与更正',
});
// 情报状态 → 用户语言
const INTEL_STATUS_TEXT = Object.freeze({
  verified: '已核实',
  pending: '待核实',
  insufficient: '资料不足',
  conflicted: '来源冲突',
});
// 情报类型（用户语言）
const INTEL_TYPE_TEXT = Object.freeze({
  price: '价格', product: '商品', promo: '促销', channel: '渠道',
  voice: '口碑', gap: '资料缺口', monitor: '监控状态',
});
// 覆盖状态 → 用户语言（§六状态表达）
// 🔴 诚实语义：failed = 最近一次采集失败且【没有】任何历史成功数据（data-surface 仅在
//    !lastUsable 时置 failed）——不得声称「保留旧数据」；「保留旧数据」只出现在
//    有上次成功数据（ok/partial/stale）且最近一次尝试失败的 notes 里。
const COVER_STATE_TEXT = Object.freeze({
  ok: '已采集且有数据',
  partial: '部分采集',
  empty: '已采集但无可提炼结果',
  stale: '数据过期',
  loading: '采集中',
  failed: '最近采集失败，尚无可展示数据',
  unsupported: '未接入',
  pending_config: '数据服务暂不可用',
  unknown: '尚未采集',
});

function loadProjectState(tenantId, projectId) {
  try {
    // 直接按 projectId 读档案（state-store 的 loadState 只认「当前项目」，不能用于指定项目）
    const { projFile } = require('../core/state-store.js');
    const f = projFile(projectId, tenantId);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) { return null; }
}
function findCompetitor(state, competitorId) {
  const list = (state && Array.isArray(state.competitors)) ? state.competitors : [];
  return list.find(c => c && c.id === competitorId) || null;
}
function domainOfUrl(u) {
  try { return new URL(String(u)).hostname.replace(/^www\./, ''); } catch (e) { return null; }
}

// ---------- 同步：项目状态 competitors → Brand Record + Link（幂等） ----------
function syncProjectBrands(tenantId, projectId, state) {
  const st = state || loadProjectState(tenantId, projectId);
  if (!st) return { synced: 0 };
  const list = Array.isArray(st.competitors) ? st.competitors : [];
  let n = 0;
  for (const c of list) {
    if (!c || !c.id) continue;
    const domain = domainOfUrl(c.url || '');
    const { brand } = BrandStore.upsertBrand({
      tenantId, canonicalName: c.name || domain || c.id,
      officialDomain: domain, market: (c.market || (st.intent && st.intent.regions && st.intent.regions[0]) || null),
      category: c.category || (st.intent && st.intent.category) || null,
      relation: c.relation || 'competitor', competitorRef: c.id,
    });
    BrandStore.linkProject({ tenantId, brandId: brand.brandId, projectId, competitorRef: c.id });
    n++;
  }
  return { synced: n };
}

// ---------- 覆盖：Registry 驱动，未接入 ≠ 未采集 ≠ 无数据 ----------
function buildCoverage(tenantId, projectId, competitor) {
  const comp = competitor || {};
  const compId = comp.id || null;
  const dims = [];
  for (const d of Registry.listDimensions()) {
    const caps = Registry.capabilitiesByDimension(d.code);
    const ga = caps.filter(c => c.maturity === 'ga');
    // P0-2 整改 r2：实现态（pending_config）与运行态（readiness）分离——用户侧
    // 只显示四种口径之一（此处=数据服务暂不可用）；凭据等技术细节仅管理员
    // 健康接口可见（GET /api/admin/data-surface/capabilities），不进用户投影。
    const pending = caps.filter(c => c.maturity === 'pending_config');
    // R4.15：maturity 未升级但已有真实可用尝试（success/partial）的能力，按「已采到数据」参与聚合——
    // 否则顶部覆盖面板会与下方数据面卡片自相矛盾（卡片有数据、面板说"暂不可用"）。
    const pendingActive = (!ga.length && compId)
      ? pending.filter(c => {
        try {
          return SurfaceStore.listAttempts(tenantId, projectId, compId, c.code, 10)
            .some(a => a.status === 'success' || a.status === 'partial');
        } catch (e) { return false; }
      })
      : [];
    if (!ga.length && pending.length && !pendingActive.length) {
      dims.push({
        code: d.code, displayName: d.displayName, state: 'pending_config', stateText: '数据服务暂不可用',
        capabilities: pending.map(c => ({ code: c.code, displayName: c.displayName, maturity: c.maturity, measurementMethod: c.measurementMethod || null })),
        lastObservedAt: null, reason: 'service_credential_required',
        note: '数据服务暂不可用，请稍后再试。当前不生成数据、估算或结论。',
      });
      continue;
    }
    if (!ga.length && !pendingActive.length) {
      dims.push({
        code: d.code, displayName: d.displayName, state: 'unsupported', stateText: '未接入',
        capabilities: caps.map(c => ({ code: c.code, displayName: c.displayName, maturity: c.maturity, limitations: c.limitations })),
        lastObservedAt: null, reason: 'source_not_integrated',
        note: '该数据源尚未接入，Vantage 不提供此维度的任何数据或估算。',
      });
      continue;
    }
    // 参与本维度聚合的能力：ga + 已采到数据的 pending
    const capsForAgg = ga.concat(pendingActive);
    if (!compId) {
      dims.push({ code: d.code, displayName: d.displayName, state: 'unknown', stateText: '尚未采集', capabilities: capsForAgg.map(c => ({ code: c.code, displayName: c.displayName })), lastObservedAt: null, reason: 'no_competitor' });
      continue;
    }
    let best = null; best = null;
    let aggregated = null;
    try {
      const ov = Surface.buildOverview({ tenantId, projectId, competitorId: compId, comp, nowMs: Date.now() });
      aggregated = (ov.dimensions || []).find(x => x.code === d.code) || null;
    } catch (e) { aggregated = null; }
    const state = aggregated ? (aggregated.surfaceState || 'unknown') : 'unknown';
    // 🔴 状态表达（§六）：「尚未采集」≠「已采集但无可提炼结果」。
    // 该维度下所有已接入能力都**没有任何 attempt** 时，一律「尚未采集」。
    let hasAttempt = false;
    let latestFailed = false;
    for (const c of capsForAgg) {
      const a = SurfaceStore.latestAttempt(tenantId, projectId, compId, c.code);
      if (a) {
        hasAttempt = true;
        if (a.status === 'failed') latestFailed = true;
      }
    }
    const finalState = hasAttempt ? state : 'unknown';
    let lastObservedAt = null;
    if (aggregated && Array.isArray(aggregated.aggregations)) {
      for (const a of aggregated.aggregations) {
        if (a.lastUsable && a.lastUsable.endedAt) {
          if (!lastObservedAt || String(a.lastUsable.endedAt) > lastObservedAt) lastObservedAt = a.lastUsable.endedAt;
        }
      }
    }
    // 🔴 诚实备注：「保留旧数据」只在确有上次成功数据（ok/partial/stale）时允许出现；
    //    首次采集失败（failed，无历史成功）只说失败，不声称保留任何数据。
    const notes = [];
    if (['ok', 'partial', 'stale'].includes(finalState) && latestFailed) {
      notes.push('最近一次更新失败，当前展示上次成功数据。');
    }
    if (aggregated && Array.isArray(aggregated.gaps)) {
      for (const g of aggregated.gaps) { if (g && g.text) notes.push(g.text); }
    }
    dims.push({
      code: d.code, displayName: d.displayName,
      state: finalState, stateText: COVER_STATE_TEXT[finalState] || '尚未采集',
      capabilities: capsForAgg.map(c => ({ code: c.code, displayName: c.displayName, maturity: c.maturity })),
      lastObservedAt,
      notes,
      reason: finalState === 'unsupported' ? 'not_supported_for_object' : (hasAttempt ? null : 'not_collected_yet'),
    });
  }
  // Wave 1：integrated 只计真正可采集的维度；pending_config 单列（不是已接入）
  const integrated = dims.filter(d => d.state !== 'unsupported' && d.state !== 'pending_config');
  const withData = integrated.filter(d => ['ok', 'partial', 'stale'].includes(d.state));
  return {
    dimensions: dims,
    summary: {
      totalDimensions: dims.length,
      integratedDimensions: integrated.length,
      notIntegrated: dims.filter(d => d.state === 'unsupported').map(d => d.code),
      pendingConfig: dims.filter(d => d.state === 'pending_config').map(d => d.code),
      dimensionsWithData: withData.length,
      notCollected: integrated.filter(d => d.state === 'unknown').map(d => d.code),
    },
  };
}

// ---------- 时间线：读取真值链与采集记录，写入可重建索引 ----------
function rebuildTimeline(tenantId, brandId, projectId, competitor) {
  const comp = competitor || {};
  const compId = comp.id || null;
  if (compId && projectId) {
    // 采集观察（Data Surface attempts）
    for (const cap of Registry.listCapabilities()) {
      if (cap.maturity !== 'ga') continue;
      const atts = SurfaceStore.listAttempts(tenantId, projectId, compId, cap.code, 10);
      for (const a of atts) {
        if (!a.endedAt && !a.startedAt) continue;
        // 🔴 核实状态诚实：有 Evidence/Snapshot 引用才可「已核实」，否则一律「待核实」
        const hasRefs = Array.isArray(a.evidenceIds) && a.evidenceIds.length > 0;
        const evStatus = hasRefs ? (a.status === 'failed' ? 'pending' : 'verified') : 'pending';
        BrandStore.appendTimeline({
          tenantId, brandId, kind: 'monitor', at: a.endedAt || a.startedAt, nature: 'observed',
          status: evStatus,
          title: '采集' + (a.status === 'success' ? '完成' : a.status === 'partial' ? '部分完成' : a.status === 'failed' ? '失败' : '进行中') + '：' + cap.displayName,
          detail: a.errorUserText || null, refType: 'collection_attempt', refId: a.attemptId,
          payload: { capability: cap.code, status: a.status, observationCount: a.observationCount || 0, evidenceIds: Array.isArray(a.evidenceIds) ? a.evidenceIds.slice(0, 20) : [] },
        });
      }
    }
    // 价格变化事件（DomainEvent 由 Fact 派生）——事件索引本身不带 Evidence 引用，
    try {
      const events = DomainEvent.listEvents(tenantId, { limit: 200 }) || [];
      for (const e of events) {
        if (e.entity_key && comp.url && !String(e.entity_key).includes(domainOfUrl(comp.url) || ' ')) continue;
        BrandStore.appendTimeline({
          tenantId, brandId, kind: 'price', at: e.occurred_at || e.created_at, nature: 'computed',
          status: 'pending', title: '价格变化事件', detail: e.summary || null,
          refType: 'domain_event', refId: e.event_id || null, payload: e.payload || null,
        });
      }
    } catch (e) { /* 事件目录不存在：无事件，不填充 */ }
  }
  return BrandStore.listTimeline(tenantId, brandId, { limit: 100 });
}

function timelineView(tenantId, brandId, opts) {
  return BrandStore.listTimeline(tenantId, brandId, opts).map(e => Object.assign({}, e, {
    natureText: NATURE_TEXT[e.nature] || '来源直接记录',
    statusText: INTEL_STATUS_TEXT[e.status] || '待核实',
    typeText: INTEL_TYPE_TEXT[e.kind] || e.kind,
  }));
}
// 最早观察时间（无历史接入时只展示「开始观察日期」，不暗示更早历史）
function firstObservedAt(tenantId, brandId) {
  const rows = BrandStore.listTimeline(tenantId, brandId, { limit: 200 });
  if (!rows.length) return null;
  return rows.map(r => r.at).sort()[0];
}

// ---------- 情报：按事实与变化组织 ----------
function listIntelligence(tenantId, opts) {
  const o = opts || {};
  const projectId = o.projectId || null;
  const state = projectId ? loadProjectState(tenantId, projectId) : null;
  const comps = (state && Array.isArray(state.competitors)) ? state.competitors : [];
  const out = [];
  for (const c of comps) {
    if (o.brandId) {
      const bid = BrandStore.brandIdForCompetitor(tenantId, projectId, c.id);
      if (bid !== o.brandId) continue;
    }
    const bid = BrandStore.brandIdForCompetitor(tenantId, projectId, c.id);
    const items = buildBrandIntelligence(tenantId, projectId, bid, c, o);
    out.push(...items);
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}

function buildBrandIntelligence(tenantId, projectId, brandId, comp, opts) {
  const o = opts || {};
  const items = [];
  const push = (it) => {
    if (o.type && it.type !== o.type) return;
    if (o.from && String(it.at) < String(o.from)) return;
    if (o.to && String(it.at) > String(o.to)) return;
    items.push(it);
  };
  // 采集观察 → 商品/价格情报（引用 Evidence/Snapshot）
  for (const cap of Registry.listCapabilities()) {
    if (cap.maturity !== 'ga') continue;
    const atts = SurfaceStore.listAttempts(tenantId, projectId, comp.id, cap.code, 5);
    for (const a of atts) {
      if (a.status === 'running') continue;
      const at = a.endedAt || a.startedAt;
      const evIds = Array.isArray(a.evidenceIds) ? a.evidenceIds : [];
      const evRefs = evIds.map(id => {
        const ev = EvidenceStore.getEvidenceById(tenantId, id);
        if (!ev) return null;
        return {
          evidenceId: ev.evidence_id, evidenceStatus: ev.evidence_status,
          observedAt: ev.observed_at || null, claim: ev.claim || null,
          snapshotIds: ev.source_snapshot_ids || [],
        };
      }).filter(Boolean);
      const hasEvidence = evRefs.length > 0;
      push({
        id: a.attemptId, brandId, brandName: comp.name || null, competitorId: comp.id || null,
        type: cap.code === 'shopify_catalog' ? 'product' : 'monitor',
        typeText: cap.code === 'shopify_catalog' ? '商品' : '监控状态',
        at, nature: 'observed', natureText: NATURE_TEXT.observed,
        status: hasEvidence ? (a.status === 'partial' ? 'pending' : 'verified') : (a.status === 'failed' ? 'insufficient' : 'insufficient'),
        statusText: INTEL_STATUS_TEXT[hasEvidence ? (a.status === 'partial' ? 'pending' : 'verified') : 'insufficient'],
        title: cap.displayName + '采集' + (a.status === 'success' ? '完成' : a.status === 'partial' ? '部分完成' : '失败'),
        detail: a.status === 'failed' ? (a.errorUserText || '采集失败') : `观察 ${a.observationCount || 0} 条`,
        evidence: evRefs,
        correctionEndpoint: '/api/field-correct',
        attemptId: a.attemptId, capability: cap.code,
      });
    }
  }
  // 价格变化事件（由 Fact 派生，属「按已有数据计算」）
  try {
    const events = DomainEvent.listEvents(tenantId, { limit: 100 }) || [];
    const dom = domainOfUrl(comp.url || '');
    for (const e of events) {
      if (dom && e.entity_key && !String(e.entity_key).includes(dom)) continue;
      push({
        id: e.event_id || ('ev_' + String(e.occurred_at || '')), brandId, brandName: comp.name || null, competitorId: comp.id || null,
        type: 'price', typeText: '价格', at: e.occurred_at || e.created_at,
        nature: 'computed', natureText: NATURE_TEXT.computed,
        status: 'pending', statusText: INTEL_STATUS_TEXT.pending,
        title: '价格变化', detail: e.summary || null,
        evidence: [], correctionEndpoint: '/api/field-correct', refType: 'domain_event', refId: e.event_id || null,
      });
    }
  } catch (e) { /* 无事件目录 */ }
  // r4.10：未接入维度不再生成情报事件。「XX：未接入」是项目级数据覆盖状态，
  // 不是某品牌在某时刻发生的竞争变化——带时间戳/状态徽章地混进时间线属于噪音，
  // 且随品牌数量成倍重复。建设中维度改由 constructionDimensions() 项目级
  // 独立字段承载（前端在情报库底部单一去重区域呈现）。
  // 真实采集失败 / 部分采集 / 已观察变化（上方两段）不受影响。
  return items;
}

// ---------- 项目级建设中维度（r4.10） ----------
// 未接入维度的唯一展示口径：与 buildCoverage 的 unsupported 判定同口径
// （该维度下无 ga 能力 → 未接入）；按 code 去重恰一条；纯静态投影——
// 不含品牌 ID、事件 ID、时间戳、Evidence/Snapshot 或任何模拟数据。
// 暴露路径在租户鉴权后的 /api/intelligence 内，天然 tenant/project scoped。
function constructionDimensions() {
  const out = [];
  for (const d of Registry.listDimensions()) {
    const caps = Registry.capabilitiesByDimension(d.code);
    const ga = caps.filter(c => c.maturity === 'ga');
    if (ga.length) continue;
    const pending = caps.filter(c => c.maturity === 'pending_config');
    // r2：维度下全部为 pending_config → 用户侧「数据服务暂不可用」；
    // 仍无任何真实能力 → 尚未接入。两种状态都不生成情报事件。
    if (pending.length) {
      // P0-2 整改 r2：用户侧口径收敛——「数据服务暂不可用」；configKeys 只进
      // 管理员健康接口，不进用户投影（任务书 r2 §P0-2）。
      out.push({
        code: d.code,
        displayName: d.displayName,
        state: 'pending_config',
        message: '数据服务暂不可用，请稍后再试。当前不生成数据、估算或结论。',
      });
    } else {
      out.push({
        code: d.code,
        displayName: d.displayName,
        state: 'not_integrated',
        message: '尚未接入，当前不生成数据、估算或结论。',
      });
    }
  }
  return out;
}

// ---------- 品牌视图 ----------
function listBrandViews(tenantId, projectId) {
  syncProjectBrands(tenantId, projectId);
  const state = loadProjectState(tenantId, projectId);
  // 🔴 项目级字段（competitor_ref/market/category/relation）以 brand_project_links 为准
  const brands = BrandStore.listBrandLinksForProject(tenantId, projectId);
  return brands.map((b) => {
    const comp = b.competitorRef ? findCompetitor(state, b.competitorRef) : null;
    const cov = buildCoverage(tenantId, projectId, comp || {});
    const tl = BrandStore.listTimeline(tenantId, b.brandId, { limit: 5 });
    const last = tl[0] || null;
    return {
      brandId: b.brandId, name: b.canonicalName, officialDomain: b.officialDomain,
      market: b.market, category: b.category, relation: b.relation,
      competitorId: b.competitorRef,
      coverageSummary: cov.summary,
      coverageDimensions: cov.dimensions,
      lastObservedAt: last ? last.at : null,
      lastChange: last ? { at: last.at, kind: last.kind, kindText: INTEL_TYPE_TEXT[last.kind] || last.kind, title: last.title } : null,
      gaps: cov.dimensions.filter(d => d.state === 'unsupported' || d.state === 'unknown')
        .map(d => ({ code: d.code, displayName: d.displayName, state: d.state, stateText: d.stateText })),
    };
  });
}

// 品牌详情：显式 projectId 边界。品牌必须已关联该项目（getLink 校验），
// 竞品数据按该项目的链接 competitor_ref 读取——同一品牌挂多项目时各读各的数据。
function getBrandView(tenantId, brandId, projectId) {
  const brand = BrandStore.getBrand(tenantId, brandId);
  if (!brand) return null;
  const link = projectId ? BrandStore.getLink(tenantId, brandId, projectId) : null;
  if (!link) return null; // 未关联该项目 / 未给项目 → 上层 404，不猜测项目
  const links = BrandStore.linksForBrand(tenantId, brandId);
  const competitorId = link.competitorRef || null;
  const state = loadProjectState(tenantId, projectId);
  const comp = competitorId ? findCompetitor(state, competitorId) : null;
  const cov = buildCoverage(tenantId, projectId, comp || {});
  // 商品与价格（来自 Data Surface 已采集 attempt，不复制真值）
  let products = { observations: [], summary: null, attemptId: null, collectedAt: null, evidenceRefs: [] };
  if (comp) {
    try {
      const det = Surface.buildDimensionDetail({ tenantId, projectId, competitorId: comp.id, dimension: 'website_products', offset: 0, limit: 50, comp });
      products = {
        observations: det.observations || [],
        summary: det.summary || null,
        attemptId: det.attemptId || null,
        collectedAt: det.collectedAt || null,
        evidenceRefs: (det.evidenceRefs || []).map(r => ({
          evidenceId: r.evidenceId || null, snapshotId: r.snapshotId || null,
          sourceUrl: r.sourceUrl || null, label: r.label || null,
        })),
      };
    } catch (e) { /* 维度不可读：保持空，不填充 */ }
  }
  return {
    brand: {
      brandId: brand.brandId, name: brand.canonicalName, officialDomain: brand.officialDomain,
      market: link.market != null ? link.market : brand.market,
      category: link.category != null ? link.category : brand.category,
      relation: link.relation != null ? link.relation : brand.relation,
      competitorId, firstObservedAt: firstObservedAt(tenantId, brandId),
    },
    projectId,
    links,
    coverage: cov,
    products,
    timeline: timelineView(tenantId, brandId, { limit: 100 }),
    intelligence: comp ? buildBrandIntelligence(tenantId, projectId, brandId, comp, {}) : [],
    reports: BrandStore.listReports(tenantId, projectId).filter(r => {
      const scope = r.scope || {};
      return !Array.isArray(scope.brandIds) || scope.brandIds.length === 0 || scope.brandIds.includes(brandId);
    }).map(r => ({ reportId: r.reportId, version: r.version, status: r.status, createdAt: r.createdAt, finishedAt: r.finishedAt, scope: r.scope })),
  };
}

module.exports = {
  NATURE_TEXT, INTEL_STATUS_TEXT, INTEL_TYPE_TEXT, COVER_STATE_TEXT,
  syncProjectBrands, loadProjectState, findCompetitor, domainOfUrl,
  buildCoverage, rebuildTimeline, timelineView, firstObservedAt,
  listIntelligence, buildBrandIntelligence, constructionDimensions,
  listBrandViews, getBrandView,
};
