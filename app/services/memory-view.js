'use strict';
// ============================================================
// services/memory-view.js —— Competitive Memory 读取投影（SC-05 §6/§7）
//
// 只投影，不产生新事实。三条硬规则：
//   1. 用户可见条目绝不含 attempt id / snapshot 文件名 / 文件路径 / 技术状态名；
//   2. 「无记录」不等于「没有变化」——零事实区间一律表达为覆盖缺口，不写「无变化」；
//   3. 时间一律带精度与基准（effective_at = 实际发生；observed_at = Vantage 观察到）。
// ============================================================
const Store = require('./competitive-memory-store.js');

const SOURCE_KIND_TEXT = Object.freeze({
  live_observation: '直接观察',
  archived_observation: '历史存档观察',
  licensed_dataset: '授权数据服务',
  derived_event: '基于已核验数据的变化',
});
const PRECISION_TEXT = Object.freeze({
  exact: '精确到时刻',
  day: '精确到日',
  month: '精确到月',
  captured_only: '仅采集时可知',
  unknown: '时间无法确认',
});
const EVENT_TEXT = Object.freeze({
  product_price_changed: '价格变化',
  product_first_observed: '首次观察',
  product_availability_changed: '可售状态变化',
});
const COVERAGE_TEXT = Object.freeze({
  verified: '有可核验证据',
  partial: '部分覆盖',
  source_unavailable: '来源不可用',
  not_started: '未开始采集',
  unknown: '无法确认该时间区间',
});

function d10(v) { return v ? String(v).slice(0, 10) : null; }
function monthOf(v) { const s = d10(v); return s ? s.slice(0, 7) : null; }
function nowIso() { return new Date().toISOString(); }

function entityNameMap(tenantId, projectId, competitorId) {
  const map = {};
  for (const e of Store.listEntities(tenantId, projectId, competitorId, { limit: 500 })) {
    map[e.entityId] = e.displayName || e.entityKey;
  }
  return map;
}

// ---------------- GET /api/brands/:brandId/memory ----------------
function buildMemoryView(tenantId, projectId, competitorId, opts) {
  const o = opts || {};
  const page = Store.listFacts(tenantId, projectId, competitorId, {
    entityType: o.entityType || null, factTypes: o.factTypes || null,
    from: o.from || null, to: o.to || null, cursor: o.cursor || null, limit: o.limit || 100,
  });
  const names = entityNameMap(tenantId, projectId, competitorId);
  const facts = page.facts.map(f => ({
    factId: f.factId,
    entityId: f.entityId,
    entityName: names[f.entityId] || null,
    entityType: f.entityType,
    factType: f.factType,
    value: f.value,
    unit: f.unit,
    currency: f.currency,
    sourceKind: f.sourceKind,
    sourceKindText: SOURCE_KIND_TEXT[f.sourceKind] || f.sourceKind,
    measurementMethod: f.measurementMethod,
    sourceStatus: f.sourceStatus,
    comparable: f.comparable,
    timePrecision: f.timePrecision,
    timePrecisionText: PRECISION_TEXT[f.timePrecision] || f.timePrecision,
    effectiveAt: f.effectiveAt,
    observedAt: f.observedAt,
    recordedAt: f.recordedAt,
    at: f.at,
    atBasis: f.atBasis,
    atBasisText: f.atBasis === 'effective_at' ? '来源实际时间' : 'Vantage 观察时间',
    versionId: f.entityVersionId,
    evidenceIds: f.evidenceIds,
    snapshotIds: f.snapshotIds,
    quality: f.quality,
  }));
  const versionIds = [...new Set(facts.map(f => f.versionId))].slice(0, 200);
  const versions = versionIds
    .map(vid => Store.getVersion(tenantId, projectId, competitorId, vid))
    .filter(Boolean)
    .map(v => ({
      versionId: v.versionId, entityId: v.entityId, entityName: names[v.entityId] || null,
      sourceKind: v.sourceKind, sourceKindText: SOURCE_KIND_TEXT[v.sourceKind] || v.sourceKind,
      sourceUrl: v.sourceUrl, finalUrl: v.finalUrl,
      effectiveAt: v.effectiveAt, observedAt: v.observedAt, recordedAt: v.recordedAt,
      timePrecision: v.timePrecision, timePrecisionText: PRECISION_TEXT[v.timePrecision] || v.timePrecision,
      evidenceIds: v.evidenceIds, snapshotIds: v.snapshotIds,
    }));
  const cov = Store.coverageStats(tenantId, projectId, competitorId);
  return {
    facts, versions,
    nextCursor: page.nextCursor,
    coverage: {
      product: cov.product ? Object.assign({}, cov.product, { coverageText: COVERAGE_TEXT.verified }) : null,
      catalog: cov.catalog ? Object.assign({}, cov.catalog, { coverageText: COVERAGE_TEXT.verified }) : null,
    },
    legend: { sourceKinds: SOURCE_KIND_TEXT, timePrecisions: PRECISION_TEXT },
  };
}

// ---------------- GET /api/brands/:brandId/timeline ----------------
// 条目类型：live_observation / archived_observation / derived_event / coverage_gap
function buildTimeline(tenantId, projectId, competitorId, opts) {
  const o = opts || {};
  const from = d10(o.from) || null;
  const to = d10(o.to) || null;
  const limit = Math.max(1, Math.min(Number(o.limit) || 100, 300));
  const names = entityNameMap(tenantId, projectId, competitorId);
  const items = [];

  // 1) 目录级观察（live / archived）——商品级明细由事实与事件承载，避免逐条刷屏
  for (const v of Store.listVersions(tenantId, projectId, competitorId, { limit: 200 })) {
    const p = v.payload || {};
    const ent = Store.getEntity(tenantId, projectId, competitorId, v.entityId);
    if (!ent || ent.entityType !== 'brand_catalog') continue;
    const at = v.effectiveAt || v.observedAt;
    if (from && d10(at) < from) continue;
    if (to && d10(at) > to) continue;
    const isArchived = v.sourceKind === 'archived_observation';
    items.push({
      id: 'obs_' + v.versionId,
      type: isArchived ? 'archived_observation' : 'live_observation',
      sourceKind: v.sourceKind,
      sourceKindText: SOURCE_KIND_TEXT[v.sourceKind] || v.sourceKind,
      title: isArchived
        ? '存档快照：目录含 ' + (p.productCount == null ? '未知数量' : p.productCount) + ' 个商品'
        : 'Vantage 采集目录：' + (p.productCount == null ? '未返回数量' : p.productCount) + ' 个商品',
      detail: p.partialScan ? '本次枚举不完整（部分覆盖），不能据此判断商品增减。' : null,
      at, atBasis: v.effectiveAt ? 'effective_at' : 'observed_at',
      timePrecision: v.timePrecision, timePrecisionText: PRECISION_TEXT[v.timePrecision] || v.timePrecision,
      effectiveAt: v.effectiveAt, observedAt: v.observedAt,
      evidenceIds: v.evidenceIds, snapshotIds: v.snapshotIds,
      sourceUrl: v.sourceUrl,
      entityId: v.entityId, entityName: ent.displayName || null,
      counts: { productCount: p.productCount, onSaleCount: p.onSaleCount },
    });
  }

  // 2) 派生事件（确定性投影）
  // 价格/可售事件单独取（不把首次观察混进来，避免分页上限影响计数）
  const events = Store.listEvents(tenantId, projectId, competitorId, {
    from, to, limit: 300, excludeTypes: ['product_first_observed'],
  });
  const firstObservedSamples = Store.listEvents(tenantId, projectId, competitorId, {
    from, to, eventType: 'product_first_observed', limit: 600,
  });
  const firstCounts = Store.countEventDays(tenantId, projectId, competitorId, 'product_first_observed', { from, to });
  // 价格 / 可售状态变化：逐条呈现（每条都能打开自己的证据）
  for (const e of events) {
    const isPrice = e.eventType === 'product_price_changed';
    items.push({
      id: 'ev_' + e.eventId,
      type: 'derived_event',
      sourceKind: 'derived_event',
      sourceKindText: SOURCE_KIND_TEXT.derived_event,
      eventType: e.eventType,
      title: (EVENT_TEXT[e.eventType] || e.eventType) + (names[e.entityId] ? '：' + names[e.entityId] : ''),
      detail: isPrice
        ? e.fromValue + ' → ' + e.toValue + ' ' + (e.currency || '（币种未确认）')
        : (e.summary || null),
      at: e.at, atBasis: e.atBasis,
      timePrecision: e.timePrecision, timePrecisionText: PRECISION_TEXT[e.timePrecision] || e.timePrecision,
      effectiveAt: e.effectiveAt, observedAt: e.observedAt,
      evidenceIds: e.evidenceIds, snapshotIds: e.snapshotIds,
      derivedFromFactIds: e.derivedFromFactIds,
      entityId: e.entityId, entityName: names[e.entityId] || null,
    });
  }
  const sampleByDay = {};
  for (const e of firstObservedSamples) {
    const k = d10(e.at);
    (sampleByDay[k] = sampleByDay[k] || []).push(e);
  }
  // 首次观察按天聚合：数量来自 countEventDays（准确计数），样本只用于展示名称与证据入口
  for (const row of firstCounts) {
    const day = row.day;
    const list = sampleByDay[day] || [];
    const sample = list.slice(0, 3).map(e => names[e.entityId]).filter(Boolean);
    items.push({
      id: 'first_' + day,
      type: 'derived_event',
      sourceKind: 'derived_event',
      sourceKindText: SOURCE_KIND_TEXT.derived_event,
      eventType: 'product_first_observed',
      title: row.count > 1
        ? '首次观察到 ' + row.count + ' 个商品进入观察范围'
        : '首次观察：' + (sample[0] || '商品'),
      detail: row.count > 1
        ? (sample.length ? '例如：' + sample.join('、') + (row.count > sample.length ? ' 等' : '') : null)
        : '该商品进入 Vantage 观察范围，不等于此时才上架。',
      at: row.firstAt || (day + 'T00:00:00.000Z'), atBasis: list[0] ? list[0].atBasis : 'observed_at',
      timePrecision: list[0] ? list[0].timePrecision : 'captured_only',
      timePrecisionText: PRECISION_TEXT[list[0] ? list[0].timePrecision : 'captured_only'],
      effectiveAt: null, observedAt: list[0] ? list[0].observedAt : null,
      evidenceIds: [...new Set(list.flatMap(e => e.evidenceIds))],
      snapshotIds: [...new Set(list.flatMap(e => e.snapshotIds))],
      derivedFromFactIds: [...new Set(list.flatMap(e => e.derivedFromFactIds))],
      entityCount: row.count,
      entityId: null, entityName: null,
    });
  }

  // 3) 覆盖缺口（无记录 ≠ 没有变化）
  const cov = buildHistoryCoverage(tenantId, projectId, competitorId, { from, to });
  for (const gap of cov.gapsForTimeline) items.push(gap);

  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const limited = items.slice(0, limit);
  const firstRecorded = Store.listVersions(tenantId, projectId, competitorId, { limit: 500 })
    .map(v => v.recordedAt).sort()[0] || null;
  return {
    items: limited,
    total: items.length,
    truncated: items.length > limited.length,
    firstRecordedAt: firstRecorded,
    firstObservedAt: cov.dimensions.reduce((acc, d) => (!acc || (d.earliestAvailableAt && d.earliestAvailableAt < acc)) ? d.earliestAvailableAt : acc, null),
    coverageSummary: cov.summary,
    note: '只包含已核验的直接观察、历史存档观察、确定性变化事件与覆盖缺口；不含内部采集过程记录。无记录不等于没有变化。',
  };
}

// ---------------- GET /api/brands/:brandId/history-coverage ----------------
// 按月分桶判定覆盖：有事实且全部可比 = verified；有事实但存在 partial/不可比 = partial；
// 无事实 = unknown（若从未开始采集，则整段 not_started）。
function monthRange(from, to) {
  const start = from ? String(from).slice(0, 7) : null;
  const end = to ? String(to).slice(0, 7) : null;
  if (!start || !end) return [];
  const out = [];
  let [y, m] = start.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard < 240) {
    out.push(String(y) + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    guard++;
  }
  return out;
}

function buildHistoryCoverage(tenantId, projectId, competitorId, opts) {
  const o = opts || {};
  const stats = Store.coverageStats(tenantId, projectId, competitorId);
  const allDays = Store.factDays(tenantId, projectId, competitorId, null);
  const dimensions = [];
  for (const key of ['product', 'catalog']) {
    const entityType = key === 'product' ? 'product' : 'brand_catalog';
    const st = stats[key] || null;
    const days = Store.factDays(tenantId, projectId, competitorId, entityType);
    const dim = {
      key,
      displayName: key === 'product' ? '商品与价格' : '商品目录',
      entityType,
      state: !st ? 'not_started' : 'verified',
      stateText: !st ? COVERAGE_TEXT.not_started : COVERAGE_TEXT.verified,
      earliestAvailableAt: st ? st.firstAt : null,
      lastSuccessAt: st ? st.lastAt : null,
      factCount: st ? st.factCount : 0,
      comparableCount: st ? st.comparableCount : 0,
      evidenceCount: 0,
      snapshotCount: 0,
      coveredRanges: [],
      partialRanges: [],
      unknownRanges: [],
      bySourceKind: st ? st.bySourceKind : {},
    };
    // 证据/快照计数（去重）
    const evSet = new Set(), snSet = new Set();
    const facts = Store.listFacts(tenantId, projectId, competitorId, { entityType, limit: 500 }).facts;
    for (const f of facts) { f.evidenceIds.forEach(x => evSet.add(x)); f.snapshotIds.forEach(x => snSet.add(x)); }
    dim.evidenceCount = evSet.size;
    dim.snapshotCount = snSet.size;
    // 月级覆盖
    const months = monthRange(o.from, o.to);
    const dayMonths = new Set(days.map(d => d.slice(0, 7)));
    if (months.length) {
      // 月份判定口径（避免一次 partial 把整月降级）：
      //   covered = 该月至少有一条「可比」事实；partial = 有事实但全部不可比；unknown = 无事实
      const comparableByMonth = new Map();
      for (const f of facts) {
        if (!f.comparable) continue;
        const mo = monthOf(f.at);
        if (mo) comparableByMonth.set(mo, (comparableByMonth.get(mo) || 0) + 1);
      }
      const ranges = [];
      let cur = null;
      for (const mo of months) {
        const kind = dayMonths.has(mo)
          ? ((comparableByMonth.get(mo) || 0) > 0 ? 'covered' : 'partial')
          : 'unknown';
        if (cur && cur.kind === kind) cur.to = mo;
        else { cur = { from: mo, to: mo, kind }; ranges.push(cur); }
      }
      for (const r of ranges) {
        const target = r.kind === 'covered' ? dim.coveredRanges : (r.kind === 'partial' ? dim.partialRanges : dim.unknownRanges);
        target.push({ from: r.from, to: r.to });
      }
    }
    if (dim.partialRanges.length) { dim.state = 'partial'; dim.stateText = COVERAGE_TEXT.partial; }
    dimensions.push(dim);
  }
  const latestJob = Store.latestBackfillJob(tenantId, projectId, competitorId, 'shopify_catalog');
  const withData = dimensions.filter(d => d.factCount > 0);
  const summary = {
    state: withData.length ? (dimensions.some(d => d.state === 'partial') ? 'partial' : 'verified')
      : (dimensions.every(d => d.state === 'not_started') ? 'not_started' : 'unknown'),
    earliestAvailableAt: dimensions.reduce((acc, d) => (!acc || (d.earliestAvailableAt && d.earliestAvailableAt < acc)) ? d.earliestAvailableAt : acc, null),
    lastSuccessAt: dimensions.reduce((acc, d) => (!acc || (d.lastSuccessAt && d.lastSuccessAt > acc)) ? d.lastSuccessAt : acc, null),
    factCount: dimensions.reduce((n, d) => n + d.factCount, 0),
    evidenceCount: dimensions.reduce((n, d) => n + d.evidenceCount, 0),
  };
  summary.stateText = COVERAGE_TEXT[summary.state] || COVERAGE_TEXT.unknown;
  // 时间线用缺口条目（只在确实有采集起点时给，避免「从未采集」被说成「历史缺口」）
  const gapsForTimeline = [];
  if (summary.earliestAvailableAt) {
    const seen = new Set();
    for (const d of dimensions) {
      for (const r of d.unknownRanges) {
        const k = r.from + '|' + r.to;
        if (seen.has(k)) continue;
        seen.add(k);
        gapsForTimeline.push({
          id: 'gap_' + d.key + '_' + r.from + '_' + r.to,
          type: 'coverage_gap',
          sourceKind: null, sourceKindText: null,
          title: d.displayName + '：' + r.from + (r.to !== r.from ? ' ~ ' + r.to : '') + ' 无采集记录',
          detail: '该区间没有可核验证据。无记录不等于没有变化。',
          at: r.to + '-01' + 'T00:00:00.000Z',
          atBasis: 'coverage_window', timePrecision: 'month', timePrecisionText: PRECISION_TEXT.month,
          effectiveAt: null, observedAt: null, evidenceIds: [], snapshotIds: [],
          dimension: d.key,
        });
      }
    }
  }
  return {
    dimensions,
    summary,
    gapsForTimeline,
    backfill: latestJob,
    allDays: o.includeDays ? allDays : undefined,
    legend: { coverageStates: COVERAGE_TEXT },
    note: '覆盖范围只说明 Vantage 有哪些可核验证据；没有任何记录的时间区间不代表没有发生价格或商品变化。',
  };
}

// ---------------- 项目级投影（情报库 / 机会视图 / 报告冻结包最小接入） ----------------
// 情报库：把 derived_timeline_events 投影成可点击的条目（只读事实，不读 attempt）。
function buildProjectMemoryEvents(tenantId, projectId, opts) {
  const o = opts || {};
  let links = [];
  try { links = require('./brand-store.js').listBrandLinksForProject(tenantId, projectId) || []; } catch (e) { links = []; }
  if (o.brandId) links = links.filter(l => l.brandId === o.brandId);
  const out = [];
  for (const l of links) {
    if (!l.competitorRef) continue;
    let events = [];
    try {
      events = Store.listEvents(tenantId, projectId, l.competitorRef, { from: o.from || null, to: o.to || null, limit: 60 });
    } catch (e) { events = []; }
    for (const e of events) {
      if (e.eventType === 'product_first_observed') continue; // 首次观察属档案内部记录，不进情报流
      const ent = Store.getEntity(tenantId, projectId, l.competitorRef, e.entityId);
      out.push({
        id: e.eventId,
        brandId: l.brandId,
        brandName: l.canonicalName || null,
        competitorId: l.competitorRef,
        entityId: e.entityId,
        entityName: ent ? (ent.displayName || ent.entityKey) : null,
        eventType: e.eventType,
        eventText: EVENT_TEXT[e.eventType] || e.eventType,
        summary: e.summary || null,
        fromValue: e.fromValue, toValue: e.toValue, currency: e.currency, unit: e.unit,
        at: e.at,
        atBasis: e.atBasis,
        timePrecision: e.timePrecision,
        timePrecisionText: PRECISION_TEXT[e.timePrecision] || e.timePrecision,
        sourceKind: 'derived_event',
        sourceKindText: SOURCE_KIND_TEXT.derived_event,
        evidenceIds: e.evidenceIds,
        snapshotIds: e.snapshotIds,
        derivedFromFactIds: e.derivedFromFactIds,
        // 点击定位：品牌详情「商品与价格」按该时间点前后取窗
        link: { brandId: l.brandId, tab: 'products', from: e.at, to: e.at },
      });
    }
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}

// 机会视图：本次判断用到的历史跨度（事实层面，不是采集次数）
function projectHistoryBasis(tenantId, projectId) {
  let links = [];
  try { links = require('./brand-store.js').listBrandLinksForProject(tenantId, projectId) || []; } catch (e) { links = []; }
  let earliest = null, latest = null, factCount = 0, comparableCount = 0, brandsWithHistory = 0;
  for (const l of links) {
    if (!l.competitorRef) continue;
    const st = Store.coverageStats(tenantId, projectId, l.competitorRef);
    const dims = [st.product, st.catalog].filter(Boolean);
    if (!dims.length) continue;
    brandsWithHistory++;
    for (const d of dims) {
      if (d.firstAt && (!earliest || d.firstAt < earliest)) earliest = d.firstAt;
      if (d.lastAt && (!latest || d.lastAt > latest)) latest = d.lastAt;
      factCount += d.factCount;
      comparableCount += d.comparableCount;
    }
  }
  const days = earliest && latest ? Math.max(0, Math.round((Date.parse(latest) - Date.parse(earliest)) / 86400000)) : 0;
  return {
    brandsWithHistory,
    factCount,
    comparableCount,
    earliestAvailableAt: earliest,
    latestObservedAt: latest,
    availableHistoryDays: days,
    // 趋势判断需要「可比事实」而不是任意事实：存档/币种未知/partial 的观察不能拿来比涨跌
    enoughForTrend: days >= 30 && comparableCount >= 6,
    note: days >= 30 && comparableCount >= 6
      ? '可用历史跨度按已核验时序事实计算，不含采集失败或未覆盖区间。'
      : (days >= 30
        ? '历史跨度足够，但可比观察点不足 6 条，仍不对趋势类判断下结论。'
        : '可用历史跨度不足 30 天，不对趋势类判断下结论。'),
  };
}

// 报告冻结包：冻结事实 id / 版本 id / 时间范围 / 证据引用（含双时间字段）
function buildMemoryBasis(tenantId, projectId, refs, from, to, limit) {
  const facts = [];
  const seen = new Set();
  for (const ref of (refs || [])) {
    if (!ref || !ref.ref) continue;
    let rows = [];
    try {
      rows = Store.listFacts(tenantId, projectId, ref.ref, {
        from: from || null, to: to || null, limit: Math.min(Number(limit) || 120, 200),
      }).facts;
    } catch (e) { rows = []; }
    for (const f of rows.slice(0, 40)) {
      if (seen.has(f.factId)) continue;
      seen.add(f.factId);
      facts.push({
        factId: f.factId, versionId: f.entityVersionId, entityId: f.entityId,
        brandId: ref.bid, competitorId: ref.ref,
        factType: f.factType, value: f.value, unit: f.unit, currency: f.currency,
        sourceKind: f.sourceKind, measurementMethod: f.measurementMethod,
        timePrecision: f.timePrecision,
        effectiveAt: f.effectiveAt, observedAt: f.observedAt, at: f.at, atBasis: f.atBasis,
        evidenceIds: f.evidenceIds, snapshotIds: f.snapshotIds,
        comparable: f.comparable,
      });
    }
  }
  return {
    from: from || null, to: to || null,
    factCount: facts.length,
    facts,
    note: '时序事实在报告生成时冻结；effectiveAt 是来源实际时间，observedAt 是 Vantage 观察时间，二者不混用。',
  };
}

module.exports = {
  SOURCE_KIND_TEXT, PRECISION_TEXT, EVENT_TEXT, COVERAGE_TEXT,
  buildMemoryView, buildTimeline, buildHistoryCoverage, monthRange, entityNameMap,
  buildProjectMemoryEvents, projectHistoryBasis, buildMemoryBasis,
};
