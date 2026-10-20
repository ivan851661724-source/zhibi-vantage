'use strict';
// ============================================================
// services/competitive-memory.js —— Competitive Memory（SC-05）写入与投影
//
// 职责边界：
//   · 只吃「已经落账的真值」：调用方必须传入既有 SourceSnapshot 与 Evidence 的 id，
//     本模块**不抓取、不重新序列化、不新建第二份原始快照**；
//   · 归一化载荷 → entity_versions（内容哈希去重）→ temporal_facts（每条回链证据）；
//   · 派生事件只做确定性投影（价格变化 / 首次观察 / 可售状态变化），不是新真值；
//   · 双时间语义：live 观察 effective_at=null（captured_only）；存档观察
//     effective_at=存档快照时间（day）；两者都写 observed_at 与 recorded_at。
//
// 降级纪律：partial 采集 / 币种未知 / 身份不稳定 → facts 标 comparable=false，
// 绝不产生价格或可售状态事件；证据缺失 → 整次写入拒绝（返回 skipped）。
// ============================================================
const crypto = require('crypto');
const Store = require('./competitive-memory-store.js');

const ALGO_VERSION = 'mem-derive-1';
const MEMORY_PARSER_VERSION = 'competitive-memory-1';

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
// 稳定序列化（键排序），保证同内容同哈希
function stable(v) {
  if (v == null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  const keys = Object.keys(v).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { return ''; }
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function round4(v) { return num(v) == null ? null : Math.round(v * 10000) / 10000; }

// 商品稳定键：真实 product id 优先，其次 handle；两者都无 → 身份不稳定（跳过）
function productEntityKey(domain, item) {
  const id = item && item.id != null && String(item.id).trim() ? String(item.id).trim() : '';
  if (id) return { key: domain + '|p:' + id, externalId: id, stable: true };
  const handle = item && item.handle ? String(item.handle).trim().toLowerCase() : '';
  if (handle) return { key: domain + '|h:' + handle, externalId: null, stable: true };
  return { key: null, externalId: null, stable: false };
}

// ============================================================
// 统一写入：一次目录观察 → 实体 / 版本 / 事实 / 派生事件
//   sourceKind: 'live_observation' | 'archived_observation'
//   effectiveAt: 存档快照时间（archived 必填）；live 必须为 null
// ============================================================
function ingestCatalogObservation(input) {
  const o = input || {};
  const tenantId = String(o.tenantId || '');
  const projectId = String(o.projectId || '');
  const competitorId = String(o.competitorId || '');
  if (!tenantId || !projectId || !competitorId) {
    return { ok: false, skipped: true, reason: 'scope_missing' };
  }
  const sourceKind = String(o.sourceKind || 'live_observation');
  if (!['live_observation', 'archived_observation'].includes(sourceKind)) {
    return { ok: false, skipped: true, reason: 'invalid_source_kind' };
  }
  const evidenceIds = (o.evidenceIds || []).filter(Boolean).map(String);
  const snapshotIds = (o.snapshotIds || []).filter(Boolean).map(String);
  // 🔴 已核实历史准入：无证据不写（不降级成「未核实历史」——宁可不写）
  if (!evidenceIds.length || !snapshotIds.length) {
    return { ok: false, skipped: true, reason: 'evidence_required' };
  }
  const items = Array.isArray(o.items) ? o.items : [];
  const summary = o.summary || {};
  const currency = summary.currency || o.currency || null;
  const partial = !!summary.partialScan || !!o.partialScan;
  const observedAt = String(o.observedAt || new Date().toISOString());
  const recordedAt = String(o.recordedAt || new Date().toISOString());
  const domain = String(o.domain || domainOf(o.sourceUrl || '')).toLowerCase();
  if (!domain) return { ok: false, skipped: true, reason: 'domain_unresolved' };
  const canonicalBrandKey = 'domain:' + domain;
  const sourceUrl = o.sourceUrl || ('https://' + domain + '/products.json');
  const finalUrl = o.finalUrl || null;
  const parserVersion = String(o.parserVersion || MEMORY_PARSER_VERSION);
  const measurementMethod = String(o.measurementMethod || (sourceKind === 'archived_observation' ? 'archived_observation' : 'direct_observation'));
  const effectiveAt = o.effectiveAt ? String(o.effectiveAt) : null;
  const timePrecision = String(o.timePrecision || (sourceKind === 'archived_observation' ? 'day' : 'captured_only'));
  if (sourceKind === 'archived_observation' && !effectiveAt) {
    return { ok: false, skipped: true, reason: 'archived_requires_effective_at' };
  }
  if (sourceKind === 'live_observation' && effectiveAt) {
    // live 采集不能声称「实际发生时间」——products.json 不提供价格变动时间
    return { ok: false, skipped: true, reason: 'live_must_not_claim_effective_at' };
  }

  const stats = {
    ok: true, sourceKind, observedAt, effectiveAt, timePrecision,
    entitiesCreated: 0, versionsCreated: 0, versionsDeduped: 0,
    factsCreated: 0, factsDeduped: 0, eventsCreated: 0,
    identityUnstable: 0, truncated: 0, currencyKnown: !!currency, partialScan: partial,
  };

  // ---------- 目录级事实 ----------
  const catalogKey = domain + '|catalog';
  const catEnt = Store.upsertEntity({
    tenantId, projectId, competitorId, entityType: 'brand_catalog', sourcePlatform: 'shopify',
    externalId: domain, entityKey: catalogKey, displayName: (o.brandName || domain) + ' 商品目录',
    canonicalBrandKey, seenAt: observedAt,
  });
  if (catEnt.created) stats.entitiesCreated++;
  const catPayload = {
    productCount: num(summary.count),
    onSaleCount: num(summary.onSaleCount),
    soldOutCount: num(summary.soldOutCount),
    priceMin: round4(summary.priceMin),
    priceMax: round4(summary.priceMax),
    priceMedian: round4(summary.priceMedian),
    currency: currency || null,
    partialScan: partial,
  };
  const catVer = Store.insertVersion({
    tenantId, projectId, competitorId, entityId: catEnt.entityId,
    sourceKind, effectiveAt, observedAt, recordedAt, timePrecision,
    normalizedPayload: catPayload, contentHash: 'sha256:' + sha256(stable(catPayload)),
    parserVersion, evidenceIds, sourceSnapshotIds: snapshotIds,
    sourceUrl, finalUrl,
  });
  if (catVer.deduped) stats.versionsDeduped++; else stats.versionsCreated++;

  const catalogFacts = [
    ['catalog.product_count', catPayload.productCount, null, null],
    ['catalog.price_min', catPayload.priceMin, currency, null],
    ['catalog.price_max', catPayload.priceMax, currency, null],
    ['catalog.price_median', catPayload.priceMedian, currency, null],
  ];
  for (const [type, value, cur, unit] of catalogFacts) {
    if (value == null) continue;
    const r = Store.insertFact({
      tenantId, projectId, competitorId, entityId: catEnt.entityId, entityVersionId: catVer.versionId,
      entityType: 'brand_catalog', factType: type, valueNum: value,
      unit, currency: cur, measurementMethod, sourceKind, sourceStatus: partial ? 'partial' : 'success',
      timePrecision, effectiveAt, observedAt, recordedAt,
      evidenceIds, snapshotIds,
      // 价格类目录事实：币种未知即不可比（不产生涨跌结论）
      comparable: type === 'catalog.product_count' ? !partial : (!partial && !!cur),
      quality: partial ? { partial_scan: true } : {},
    });
    if (r.deduped) stats.factsDeduped++; else stats.factsCreated++;
  }

  // ---------- 商品级 ----------
  for (const it of items) {
    const ident = productEntityKey(domain, it);
    if (!ident.stable) { stats.identityUnstable++; continue; }
    const price = round4(it.repPrice != null ? it.repPrice : it.minPrice);
    const available = it.soldOut === true ? false : (it.soldOut === false ? true : null);
    const variantCount = num(it.variantCount);
    const payload = {
      title: it.title == null ? null : String(it.title).slice(0, 200),
      price, minPrice: round4(it.minPrice), maxPrice: round4(it.maxPrice),
      currency: currency || null,
      available,
      variantCount,
      handle: it.handle ? String(it.handle).slice(0, 120) : null,
      publishedAt: it.publishedAt || null,
      type: it.type ? String(it.type).slice(0, 80) : null,
    };
    const ent = Store.upsertEntity({
      tenantId, projectId, competitorId, entityType: 'product', sourcePlatform: 'shopify',
      externalId: ident.externalId, entityKey: ident.key, displayName: payload.title,
      canonicalBrandKey, seenAt: observedAt,
    });
    if (ent.created) stats.entitiesCreated++;
    const ver = Store.insertVersion({
      tenantId, projectId, competitorId, entityId: ent.entityId,
      sourceKind, effectiveAt, observedAt, recordedAt, timePrecision,
      normalizedPayload: payload, contentHash: 'sha256:' + sha256(stable(payload)),
      parserVersion, evidenceIds, sourceSnapshotIds: snapshotIds,
      sourceUrl, finalUrl,
    });
    if (ver.deduped) { stats.versionsDeduped++; continue; } // 内容未变：不产生新版本、不产生新事实
    stats.versionsCreated++;

    const quality = {};
    if (partial) quality.partial_scan = true;
    if (!currency) quality.currency_unknown = true;
    if (available == null) quality.availability_unreported = true;
    // 规格签名：variantCount 已知才允许价格连线（规格不明 → 不可比）
    if (variantCount != null) quality.variant_count = variantCount;
    // 价格可比性：非 partial + 币种已确认 + 规格签名（variantCount）已知；否则只作观察值展示
    const priceComparable = !partial && !!currency && price != null && variantCount != null;
    const availComparable = !partial && available != null;

    const factRows = [
      ['product.price', price, null, currency, priceComparable],
      ['product.available', null, available == null ? null : (available ? 'in_stock' : 'sold_out'), null, availComparable],
      ['product.title', null, payload.title, null, !partial],
    ];
    if (currency) factRows.push(['product.currency', null, currency, null, !partial]);
    for (const [type, valueNum, valueText, cur, comparable] of factRows) {
      if (valueNum == null && valueText == null) continue;
      const r = Store.insertFact({
        tenantId, projectId, competitorId, entityId: ent.entityId, entityVersionId: ver.versionId,
        entityType: 'product', factType: type, valueNum, valueText,
        currency: cur, measurementMethod, sourceKind, sourceStatus: partial ? 'partial' : 'success',
        timePrecision, effectiveAt, observedAt, recordedAt,
        evidenceIds, snapshotIds, comparable, quality,
      });
      if (r.deduped) stats.factsDeduped++; else stats.factsCreated++;
    }
    // 派生事件（价格 / 可售 / 首次观察）
    try {
      const d = deriveEntityEvents({
        tenantId, projectId, competitorId, entityId: ent.entityId, entityType: 'product',
        createdNow: ent.created, parserVersion,
      });
      stats.eventsCreated += d.created;
    } catch (e) { /* 派生失败不影响事实写入：事件是投影，可重算 */ }
  }

  return stats;
}

// ============================================================
// 确定性派生：按时间锚点（effective_at 优先）升序比较相邻可比事实
//   · 价格：同币种 + 同 variantCount + 两侧 comparable
//   · 可售：两侧 comparable（不看币种）
//   · 首次观察：实体在本作用域首次出现
//   event_key 由事实 id 确定性组合 → 重复运行幂等
// ============================================================
function factsInOrder(tenantId, projectId, competitorId, entityId, factType) {
  const rows = Store.listFactsForEntity(tenantId, projectId, competitorId, entityId, factType);
  // 时间锚点排序：effective_at 优先，缺省用 observed_at；同锚点按 recorded_at 稳定
  return rows.slice().sort((a, b) => {
    const ka = a.at || '', kb = b.at || '';
    if (ka !== kb) return ka < kb ? -1 : 1;
    return String(a.factId) < String(b.factId) ? -1 : 1;
  });
}

function deriveEntityEvents({ tenantId, projectId, competitorId, entityId, entityType, createdNow, parserVersion }) {
  let created = 0;
  // 首次观察
  if (createdNow) {
    const firstFacts = Store.listFactsForEntity(tenantId, projectId, competitorId, entityId, 'product.price');
    const anchorFact = firstFacts[0] || null;
    if (anchorFact) {
      const r = Store.insertEvent({
        tenantId, projectId, competitorId, entityId, entityType, eventType: 'product_first_observed',
        eventKey: 'first:' + entityId,
        derivedFromFactIds: [anchorFact.factId],
        evidenceIds: anchorFact.evidenceIds, snapshotIds: anchorFact.snapshotIds,
        algorithmVersion: ALGO_VERSION,
        effectiveAt: anchorFact.effectiveAt, observedAt: anchorFact.observedAt,
        timePrecision: anchorFact.timePrecision,
        summary: '该商品首次进入 Vantage 观察范围（不等于该商品此时才上架）',
      });
      if (!r.deduped) created++;
    }
  }
  // 价格变化
  const prices = factsInOrder(tenantId, projectId, competitorId, entityId, 'product.price');
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1], cur = prices[i];
    if (!prev.comparable || !cur.comparable) continue;
    if (!prev.currency || !cur.currency || prev.currency !== cur.currency) continue;
    if (num(prev.valueNum) == null || num(cur.valueNum) == null) continue;
    // 规格签名：variantCount 必须一致且已知（规格不明不连线）
    const pv = prev.quality && prev.quality.variant_count != null ? prev.quality.variant_count : prev.quality.variantCount;
    const cv = cur.quality && cur.quality.variant_count != null ? cur.quality.variant_count : cur.quality.variantCount;
    if (pv == null || cv == null || Number(pv) !== Number(cv)) continue;
    if (Number(prev.valueNum) === Number(cur.valueNum)) continue;
    const r = Store.insertEvent({
      tenantId, projectId, competitorId, entityId, entityType, eventType: 'product_price_changed',
      eventKey: 'price:' + prev.factId + '->' + cur.factId,
      derivedFromFactIds: [prev.factId, cur.factId],
      evidenceIds: [...prev.evidenceIds, ...cur.evidenceIds],
      snapshotIds: [...prev.snapshotIds, ...cur.snapshotIds],
      algorithmVersion: ALGO_VERSION,
      fromValue: num(prev.valueNum), toValue: num(cur.valueNum),
      unit: null, currency: cur.currency,
      effectiveAt: cur.effectiveAt, observedAt: cur.observedAt, timePrecision: cur.timePrecision,
      summary: '价格由 ' + prev.valueNum + ' 变为 ' + cur.valueNum + ' ' + cur.currency,
    });
    if (!r.deduped) created++;
  }
  // 可售状态变化
  const stock = factsInOrder(tenantId, projectId, competitorId, entityId, 'product.available');
  for (let i = 1; i < stock.length; i++) {
    const prev = stock[i - 1], cur = stock[i];
    if (!prev.comparable || !cur.comparable) continue;
    if (prev.valueText == null || cur.valueText == null) continue;
    if (prev.valueText === cur.valueText) continue;
    const r = Store.insertEvent({
      tenantId, projectId, competitorId, entityId, entityType, eventType: 'product_availability_changed',
      eventKey: 'avail:' + prev.factId + '->' + cur.factId,
      derivedFromFactIds: [prev.factId, cur.factId],
      evidenceIds: [...prev.evidenceIds, ...cur.evidenceIds],
      snapshotIds: [...prev.snapshotIds, ...cur.snapshotIds],
      algorithmVersion: ALGO_VERSION,
      fromValue: null, toValue: null, unit: null, currency: null,
      effectiveAt: cur.effectiveAt, observedAt: cur.observedAt, timePrecision: cur.timePrecision,
      summary: prev.valueText === 'in_stock' ? '由在售变为不可售' : '由不可售恢复为在售',
    });
    if (!r.deduped) created++;
  }
  return { created };
}

// 供回补/重算使用：对整个作用域重跑派生（幂等，不产生重复事件）
function rebuildDerivedEvents(tenantId, projectId, competitorId) {
  let created = 0;
  const ents = Store.listEntities(tenantId, projectId, competitorId, { entityType: 'product', limit: 500 });
  for (const e of ents) {
    const d = deriveEntityEvents({
      tenantId, projectId, competitorId, entityId: e.entityId, entityType: 'product', createdNow: false,
    });
    created += d.created;
  }
  return { created, entities: ents.length };
}

module.exports = {
  ALGO_VERSION, MEMORY_PARSER_VERSION,
  productEntityKey, domainOf, stable, ingestCatalogObservation,
  deriveEntityEvents, rebuildDerivedEvents,
};
