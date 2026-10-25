'use strict';
// ============================================================
// services/opportunity-foundation.js —— 机会数据基础（SC-12 §六.1）
// ------------------------------------------------------------
// 目的：让「机会视图」不再只依赖满意度×重要性，改为「按可用维度独立工作」：
//   价格定位 / 商品数量与产品矩阵 / 上新·下架·库存 / 公开评论 / 内容 / 热度 / 广告
// 纪律（红线）：
//   1. 只用真实采集事实（collection_attempts 观察 + temporal_facts + derived_timeline_events），
//      不用 mock、不用推断值、不用文案里的数字；
//   2. 缺失保持 null —— 绝不用 0 填充（「没有数据」≠「数值为 0」）；
//   3. 每个维度必带：参与品牌数 / 观察数量 / 时间范围 / Evidence 数量 / 状态 /
//      measurementMethod / 限制说明；
//   4. 满意度×重要性的渲染门槛在服务端判定（§六.3）：样本不足直接不出图，
//      由前端显示「当前评论样本不足，暂不生成满意度分布」；
//   5. 机会线索只陈述「观察到的事实」，禁下经营结论（无「值得下注/一定是机会/
//      无人满足/市场空白」，无 GMV/ROI/转化率/用户画像）——由 red-lines 测试兜底。
// ============================================================
const Registry = require('./capability-registry.js');
const SurfaceStore = require('./surface-store.js');
const MemStore = require('./competitive-memory-store.js');

// 价格带（USD 口径；仅用于展示分布，不做定价建议）
const PRICE_BANDS = [
  { key: 'b0_10', label: '$0–10', min: 0, max: 10 },
  { key: 'b10_25', label: '$10–25', min: 10, max: 25 },
  { key: 'b25_50', label: '$25–50', min: 25, max: 50 },
  { key: 'b50_100', label: '$50–100', min: 50, max: 100 },
  { key: 'b100_200', label: '$100–200', min: 100, max: 200 },
  { key: 'b200p', label: '$200+', min: 200, max: Infinity },
];

// 维度 → 能力映射（缺能力 = 未接入，如实标注）
const DIMENSION_CAPS = {
  price: ['shopify_catalog', 'public_site_products'],
  catalog: ['shopify_catalog', 'public_site_products'],
  dynamics: ['shopify_catalog', 'public_site_products'],
  reviews: ['public_reviews'],
  content: ['youtube_content'],
  heat: ['dataforseo_trends'],
  ads: ['tiktok_commercial_content'],
};

// 满意度×重要性的最小可比对象数（§六.3 服务端门槛：不足即不出图）
const SATISFACTION_MIN_OBJECTS = 3;

function jparse(v, dflt) { try { const x = JSON.parse(v == null ? '' : v); return x == null ? dflt : x; } catch (e) { return dflt; } }
function arr(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }
function uniq(list) { return Array.from(new Set(list.filter(Boolean))); }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function round2(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null; }

// 单品牌维度事实：从真实 attempt 观察 + 记忆事实里取
function collectBrandFacts(tenantId, projectId, compId) {
  const out = {
    competitorId: compId,
    products: null,       // {count, available, soldOut, prices[], currency, observedAt, evidenceIds[]}
    catalog: null,        // {productCount, priceMin, priceMedian, priceMax, currency, observedAt, evidenceIds[]}
    reviews: null,        // {pageCount, reviewCount, ratedPages, pages[], observedAt, evidenceIds[]}
    events: { newItems: 0, newItemDays: [], firstSeenAt: null, lastSeenAt: null, evidenceIds: [] },
    attempts: [],         // 维度级 attempt 摘要（最新在前）
    capabilities: {},
  };
  if (!compId) return out;

  // 1) attempt 观察
  let atts = [];
  try { atts = SurfaceStore.listAttemptsByCompetitor(tenantId, projectId, compId, 100) || []; } catch (e) { atts = []; }
  out.attempts = atts.slice(0, 40).map(a => ({
    capability: a.capability, status: a.status, sourceStatus: a.sourceStatus || a.source_status || null,
    errorClass: a.errorClass || a.error_class || null,
    observationCount: Array.isArray(a.observations) ? a.observations.length : 0,
    evidenceCount: Array.isArray(a.evidenceIds) ? a.evidenceIds.length : 0,
    startedAt: a.startedAt || a.started_at || null, endedAt: a.endedAt || a.ended_at || null,
  }));

  const usableOf = (caps) => atts.find(a => caps.includes(a.capability)
    && (a.status === 'success' || a.status === 'partial')
    && (Array.isArray(a.observations) ? a.observations.length : 0) > 0) || null;

  // 2) 商品与价格（观察层：逐 SKU 的真实价格/库存）
  const pa = usableOf(DIMENSION_CAPS.price);
  if (pa) {
    const obs = Array.isArray(pa.observations) ? pa.observations : [];
    const prices = obs.map(o => num(o && o.price)).filter(v => v != null);
    const available = obs.filter(o => o && o.available === true).length;
    const soldOut = obs.filter(o => o && o.available === false).length;
    const currencies = uniq(obs.map(o => (o && o.currency) || null));
    out.products = {
      count: obs.length,
      available,
      soldOut,
      prices,
      currency: currencies.length === 1 ? currencies[0] : (currencies.length ? currencies.join('/') : null),
      observedAt: pa.endedAt || pa.startedAt || null,
      evidenceIds: arr(pa.evidenceIds),
      capability: pa.capability,
    };
  }

  // 3) 目录级事实（记忆层：product_count / price_min / price_median / price_max）
  try {
    const r = MemStore.listFacts(tenantId, projectId, compId, {
      entityType: 'brand_catalog',
      factTypes: ['catalog.product_count', 'catalog.price_min', 'catalog.price_median', 'catalog.price_max'],
      limit: 50,
    });
    const facts = (r && r.facts) || [];
    if (facts.length) {
      const pick = (t) => { const f = facts.find(x => x.factType === t); return f ? f.valueNum : null; };
      out.catalog = {
        productCount: pick('catalog.product_count'),
        priceMin: pick('catalog.price_min'),
        priceMedian: pick('catalog.price_median'),
        priceMax: pick('catalog.price_max'),
        currency: null,
        observedAt: facts.map(f => f.observedAt).filter(Boolean).sort().pop() || null,
        evidenceIds: uniq(facts.flatMap(f => arr(f.evidenceIds))),
        measurementMethod: facts[0].measurementMethod || null,
      };
    }
  } catch (e) { out.catalog = null; }

  // 4) 公开评论（页数 + 评分样本）
  const ra = usableOf(DIMENSION_CAPS.reviews);
  if (ra) {
    const obs = Array.isArray(ra.observations) ? ra.observations : [];
    const sum = ra.summary || jparse(ra.summary, null) || {};
    const rated = obs.filter(o => o && typeof o.rating === 'number');
    out.reviews = {
      pageCount: obs.length,
      reviewCount: typeof sum.reviewCount === 'number' ? sum.reviewCount : null,
      ratedPages: rated.length,
      sourceCount: typeof sum.sourceCount === 'number' ? sum.sourceCount : null,
      pages: obs.slice(0, 20).map(o => ({
        url: o && o.sourceUrl ? o.sourceUrl : null,
        title: o && o.title ? String(o.title).slice(0, 120) : null,
        rating: num(o && o.rating),
        reviewCount: num(o && o.reviewCount),
        observedAt: o && o.publishedAt ? o.publishedAt : null,
      })),
      observedAt: ra.endedAt || ra.startedAt || null,
      evidenceIds: arr(ra.evidenceIds),
      emptyReason: sum.emptyReason || null,
    };
  }

  // 5) 上新/首次观察事件（derived timeline）
  try {
    const evs = MemStore.listEvents(tenantId, projectId, compId, { eventType: 'product_first_observed', limit: 5000 });
    if (evs.length) {
      const days = MemStore.countEventDays(tenantId, projectId, compId, 'product_first_observed', {});
      out.events = {
        newItems: evs.length,
        newItemDays: days.map(d => ({ day: d.day, count: d.count, firstAt: d.firstAt })),
        firstSeenAt: evs.map(e => e.at).filter(Boolean).sort()[0] || null,
        lastSeenAt: evs.map(e => e.at).filter(Boolean).sort().pop() || null,
        evidenceIds: uniq(evs.flatMap(e => arr(e.evidenceIds))).slice(0, 50),
      };
    }
  } catch (e) { /* 无事件表 → 保持空 */ }

  return out;
}

// 维度基础（§六.1 必备字段）
function dimensionBasis(opts) {
  const o = opts || {};
  const brands = Array.isArray(o.brands) ? o.brands : [];
  const obs = brands.reduce((s, b) => s + (o.observationCount ? o.observationCount(b) : 0), 0);
  const ev = new Set();
  for (const b of brands) for (const e of (o.evidenceIds ? o.evidenceIds(b) : [])) ev.add(e);
  const times = brands.map(b => (o.observedAt ? o.observedAt(b) : null)).filter(Boolean).sort();
  return {
    code: o.code,
    label: o.label,
    status: o.status,                 // complete | partial | missing | not_covered | not_configured
    statusText: o.statusText || null,
    brandCount: brands.length,          // 参与品牌数
    observationCount: obs,              // 观察数量
    evidenceCount: ev.size,             // Evidence 数量
    window: { from: times[0] || null, to: times[times.length - 1] || null },
    measurementMethod: o.measurementMethod || null,
    limits: Array.isArray(o.limits) ? o.limits : [],
  };
}

// ============================================================
// 主入口
// ============================================================
function buildOpportunityFoundation(tenantId, projectId, opts) {
  const o = opts || {};
  const tid = String(tenantId || '');
  const pid = String(projectId || '');
  const BrandSvc = require('./brand-service.js');
  let views = [];
  try { views = BrandSvc.listBrandViews(tid, pid) || []; } catch (e) { views = []; }

  const brands = views.map(v => ({
    brandId: v.brandId, competitorId: v.competitorId, name: v.name, domain: v.officialDomain || null,
    relation: v.relation || null, market: v.market || null, category: v.category || null,
    facts: collectBrandFacts(tid, pid, v.competitorId),
  }));
  const withProducts = brands.filter(b => b.facts.products || b.facts.catalog);
  const withReviews = brands.filter(b => b.facts.reviews);

  // ---------- 价格维度 ----------
  const priceRows = brands.filter(b => b.facts.products || b.facts.catalog).map(b => {
    const p = b.facts.products || null; const c = b.facts.catalog || null;
    const prices = p ? p.prices : [];
    const min = c && c.priceMin != null ? c.priceMin : (prices.length ? Math.min(...prices) : null);
    const max = c && c.priceMax != null ? c.priceMax : (prices.length ? Math.max(...prices) : null);
    const median = c && c.priceMedian != null ? c.priceMedian
      : (prices.length ? prices.slice().sort((x, y) => x - y)[Math.floor(prices.length / 2)] : null);
    return {
      brandId: b.brandId, name: b.name, competitorId: b.competitorId,
      productCount: c && c.productCount != null ? c.productCount : (p ? p.count : null),
      available: p ? p.available : null,
      soldOut: p ? p.soldOut : null,
      priceMin: num(min), priceMedian: num(median), priceMax: num(max),
      currency: (p && p.currency) || (c && c.currency) || null,
      observedAt: (p && p.observedAt) || (c && c.observedAt) || null,
      evidenceIds: uniq([...(p ? p.evidenceIds : []), ...(c ? c.evidenceIds : [])]),
      observationCount: p ? p.count : 0,   // 观察数量 = 本次采集到的 SKU 观察数
    };
  }).filter(r => r.priceMin != null || r.productCount != null);

  const bands = PRICE_BANDS.map(band => {
    const inBand = priceRows.filter(r => {
      const lo = r.priceMin != null ? r.priceMin : r.priceMax;
      const hi = r.priceMax != null ? r.priceMax : r.priceMin;
      if (lo == null || hi == null) return false;
      return hi >= band.min && lo < band.max;
    });
    return {
      key: band.key, label: band.label, min: band.min, max: band.max === Infinity ? null : band.max,
      brandCount: inBand.length,
      brandIds: inBand.map(r => r.brandId),
      brandNames: inBand.map(r => r.name),
      // 缺价格带不等于「没有需求」——只陈述采集截面内的事实
      covered: inBand.length > 0,
    };
  });

  const priceDimension = dimensionBasis({
    code: 'price', label: '价格', status: priceRows.length ? (priceRows.length === brands.length ? 'complete' : 'partial') : 'missing',
    brands: priceRows,
    observationCount: b => b.observationCount,
    evidenceIds: b => b.evidenceIds,
    observedAt: b => b.observedAt,
    measurementMethod: 'direct_observation',
    limits: [
      '价格为采集时点的公开标价，不等于成交价或 GMV。',
      '未在售商品不计入价格区间；缺失品牌不计入覆盖数（不按 0 计入）。',
    ],
  });

  const catalogDimension = dimensionBasis({
    code: 'catalog', label: '商品与产品矩阵', status: priceRows.length ? 'partial' : 'missing',
    brands: priceRows,
    observationCount: b => b.observationCount,
    evidenceIds: b => b.evidenceIds,
    observedAt: b => b.observedAt,
    measurementMethod: 'direct_observation',
    limits: [
      '在售 SKU 数是公开目录的截面，不等于真实经营规模。',
      '缺货状态来自采集时点的公开可购买性，非库存系统数据。',
    ],
  });

  // ---------- 上新 / 库存动态 ----------
  const eventBrands = brands.filter(b => b.facts.events && b.facts.events.newItems > 0);
  const dynamicsDimension = dimensionBasis({
    code: 'dynamics', label: '上新与库存动态',
    status: eventBrands.length ? 'partial' : 'missing',
    brands: eventBrands,
    observationCount: b => (b.facts.events ? b.facts.events.newItems : 0),
    evidenceIds: b => (b.facts.events ? b.facts.events.evidenceIds : []),
    observedAt: b => (b.facts.events ? b.facts.events.firstSeenAt : null),
    measurementMethod: 'direct_observation',
    limits: [
      '当前只完成首轮基线采集，尚无第二个可比窗口，因此只能陈述「首次观察到的商品数」，不能判断上新或下架。',
    ],
  });

  // ---------- 公开评论 ----------
  const reviewRows = withReviews.map(b => ({
    brandId: b.brandId, name: b.name,
    pageCount: b.facts.reviews.pageCount,
    ratedPages: b.facts.reviews.ratedPages,
    reviewCount: b.facts.reviews.reviewCount,
    sourceCount: b.facts.reviews.sourceCount,
    observedAt: b.facts.reviews.observedAt,
    evidenceIds: b.facts.reviews.evidenceIds,
    pages: b.facts.reviews.pages,
  }));
  const reviewDimension = dimensionBasis({
    code: 'reviews', label: '公开评论与用户声音',
    status: reviewRows.length ? 'partial' : 'missing',
    brands: reviewRows,
    observationCount: b => b.pageCount,
    evidenceIds: b => b.evidenceIds,
    observedAt: b => b.observedAt,
    measurementMethod: 'public_source_observation',
    limits: [
      '样本是本次采集窗口内通过校验的公开页面，不等于全网口碑。',
      '页面未发布可核验评分时，评分样本为 0（不是评分为 0）。',
    ],
  });

  // ---------- 未接通维度（诚实状态，不写成功） ----------
  const configuredStatus = (capCode) => {
    try {
      const rd = require('./source-readiness.js').getReadiness(capCode);
      if (rd && rd.state === 'not_configured') return { status: 'not_configured', statusText: '等待系统数据服务配置' };
      return { status: 'not_covered', statusText: '暂未覆盖该市场' };
    } catch (e) { return { status: 'not_configured', statusText: '等待系统数据服务配置' }; }
  };
  const contentCfg = configuredStatus('youtube_content');
  const heatCfg = configuredStatus('dataforseo_trends');
  const adsCfg = configuredStatus('tiktok_commercial_content');

  const contentDimension = dimensionBasis({ code: 'content', label: '内容与互动', status: contentCfg.status, statusText: contentCfg.statusText, brands: [], limits: ['服务器未配置 YouTube 凭据，未产生任何内容观察。'] });
  const heatDimension = dimensionBasis({ code: 'heat', label: '搜索热度', status: heatCfg.status, statusText: heatCfg.statusText, brands: [], limits: ['服务器未配置 DataForSEO 凭据，未产生任何趋势序列。'] });
  const adsDimension = dimensionBasis({ code: 'ads', label: '广告素材与市场覆盖', status: adsCfg.status, statusText: adsCfg.statusText, brands: [], limits: ['服务器未配置 TikTok 凭据且未获平台研究权限，未产生任何广告观察。'] });

  // ---------- 满意度 × 重要性：服务端门槛（§六.3） ----------

  const comparableObjects = reviewRows.filter(r => r.ratedPages > 0 && r.pageCount > 0);
  const satisfactionScatter = {
    available: comparableObjects.length >= SATISFACTION_MIN_OBJECTS,
    minObjects: SATISFACTION_MIN_OBJECTS,
    comparableObjects: comparableObjects.length,
    objects: comparableObjects.map(r => ({
      brandId: r.brandId, name: r.name, pageCount: r.pageCount, ratedPages: r.ratedPages,
      reviewCount: r.reviewCount, observedAt: r.observedAt, evidenceIds: r.evidenceIds,
    })),
    reason: comparableObjects.length >= SATISFACTION_MIN_OBJECTS ? null : '当前评论样本不足，暂不生成满意度分布',
    limits: [
      '满意度与重要性都需可追溯依据（评分/主题分类证据），缺一即不出图。',
      '样本范围与时间范围不一致时必须标注差异，不得直接比较。',
    ],
  };

  // ---------- 机会线索（只陈述事实 + 建议验证的问题） ----------
  const opportunities = [];
  const priceMedianList = priceRows.filter(r => r.priceMedian != null).map(r => r.priceMedian).sort((a, b) => a - b);
  const medianOf = priceMedianList.length ? priceMedianList[Math.floor(priceMedianList.length / 2)] : null;

  // ① 价格带覆盖差异（事实：哪个价格带只有 1 个品牌在售 / 哪个价格带没有品牌在售）
  for (const band of bands) {
    if (band.brandCount === 1 && priceRows.length >= 3) {
      const r = priceRows.find(x => x.brandId === band.brandIds[0]);
      opportunities.push({
        id: 'priceband-' + band.key,
        title: band.label + ' 价格带仅 1 个品牌在售',
        fact: '本次采集截面内，' + band.label + ' 价格带只有 ' + band.brandNames.join('、') + ' 在售商品；其余 ' + (priceRows.length - 1) + ' 个品牌的公开价格区间未覆盖该价格带。',
        dimension: 'price',
        sampleSize: priceRows.length + ' 个品牌的价格区间',
        window: { from: priceDimension.window.from, to: priceDimension.window.to },
        evidenceRefs: r ? r.evidenceIds.slice(0, 5) : [],
        limits: ['价格为公开标价截面；未在售商品与未采集品牌都不计入，不等于该价格带无需求。'],
        question: '该价格带在竞品之外是否有实际成交？需要补充哪一类证据来验证？',
      });
    }
  }
  // ② 价格定位差异
  if (medianOf != null) {
    for (const r of priceRows.filter(x => x.priceMedian != null)) {
      const diff = round2((r.priceMedian - medianOf) / medianOf * 100);
      if (diff == null || Math.abs(diff) < 15) continue;
      opportunities.push({
        id: 'pricepos-' + r.brandId,
        title: r.name + ' 价格定位' + (diff > 0 ? '高于' : '低于') + '同项目品牌中位数 ' + Math.abs(diff) + '%',
        fact: r.name + ' 在售商品价格中位数为 ' + r.priceMedian + (r.currency ? ' ' + r.currency : '') + '，同项目 ' + priceRows.filter(x => x.priceMedian != null).length + ' 个品牌的中位数为 ' + medianOf + '，差异 ' + diff + '%。',
        dimension: 'price',
        sampleSize: priceRows.filter(x => x.priceMedian != null).length + ' 个品牌的价格中位数',
        window: { from: priceDimension.window.from, to: priceDimension.window.to },
        evidenceRefs: r.evidenceIds.slice(0, 5),
        limits: ['中位数来自公开标价截面；不同规格/装量不可直接比较。'],
        question: '该价格定位差异对应怎样的规格或装量结构？需要补充哪些竞品证据？',
      });
    }
  }
  // ③ 产品矩阵密度差异
  if (priceRows.filter(r => r.productCount != null).length >= 3) {
    const counts = priceRows.filter(r => r.productCount != null).map(r => r.productCount).sort((a, b) => a - b);
    const medCount = counts[Math.floor(counts.length / 2)];
    for (const r of priceRows.filter(x => x.productCount != null && x.productCount < medCount)) {
      opportunities.push({
        id: 'matrix-' + r.brandId,
        title: r.name + ' 在售 SKU 数低于同项目中位数',
        fact: r.name + ' 公开目录在售 ' + r.productCount + ' 款，同项目 ' + counts.length + ' 个品牌的中位数为 ' + medCount + ' 款。',
        dimension: 'catalog',
        sampleSize: counts.length + ' 个品牌的在售 SKU 数',
        window: { from: catalogDimension.window.from, to: catalogDimension.window.to },
        evidenceRefs: r.evidenceIds.slice(0, 5),
        limits: ['在售 SKU 数是公开目录截面；不同品类结构的品牌之间不可直接比较。'],
        question: 'SKU 差异来自品类结构还是覆盖范围？需要按品类分层后再看吗？',
      });
    }
  }
  // ④ 上新基线（诚实：只有首轮基线，不能判断上新）
  for (const b of eventBrands) {
    if (b.facts.events.newItems < 1) continue;
    opportunities.push({
      id: 'baseline-' + b.brandId,
      title: b.name + ' 已建立 ' + b.facts.events.newItems + ' 款商品的采集基线',
      fact: 'Vantage 于 ' + (b.facts.events.firstSeenAt || '').slice(0, 10) + ' 首次观察到 ' + b.name + ' 的 ' + b.facts.events.newItems + ' 款商品（基线建立）。',
      dimension: 'dynamics',
      sampleSize: b.facts.events.newItems + ' 款商品',
      window: { from: b.facts.events.firstSeenAt, to: b.facts.events.lastSeenAt },
      evidenceRefs: b.facts.events.evidenceIds.slice(0, 5),
      limits: ['当前只有首轮基线，尚未有第二个可比窗口，无法判断上新或下架；不可比记录不得当作变化。'],
      question: '需要等待多久的第二个窗口，才能判断真实的上新与下架节奏？',
    });
  }

  const usable = [priceDimension, catalogDimension, dynamicsDimension, reviewDimension]
    .filter(d => d.status === 'complete' || d.status === 'partial');
  const missing = [contentDimension, heatDimension, adsDimension];

  return {
    projectId: pid,
    generatedAt: new Date().toISOString(),
    brandScope: {
      total: brands.length,
      withData: withProducts.length,
      withReviews: withReviews.length,
      list: brands.map(b => ({
        brandId: b.brandId, competitorId: b.competitorId, name: b.name, domain: b.domain,
        relation: b.relation, market: b.market, category: b.category,
        hasPrice: !!(b.facts.products || b.facts.catalog),
        hasReviews: !!b.facts.reviews,
      })),
    },
    dimensions: {
      price: priceDimension, catalog: catalogDimension, dynamics: dynamicsDimension,
      reviews: reviewDimension, content: contentDimension, heat: heatDimension, ads: adsDimension,
    },
    modules: {
      priceBands: {
        available: priceRows.length > 0,
        bands,
        rows: priceRows,
        currency: uniq(priceRows.map(r => r.currency)).join('/') || null,
        limits: priceDimension.limits,
      },
      matrixDensity: {
        available: priceRows.filter(r => r.productCount != null).length > 0,
        rows: priceRows.filter(r => r.productCount != null),
        medianProductCount: (() => {
          const cs = priceRows.filter(r => r.productCount != null).map(r => r.productCount).sort((a, b) => a - b);
          return cs.length ? cs[Math.floor(cs.length / 2)] : null;
        })(),
        limits: catalogDimension.limits,
      },
      newItemDynamics: {
        available: eventBrands.length > 0,
        rows: eventBrands.map(b => ({
          brandId: b.brandId, name: b.name, baselineItems: b.facts.events.newItems,
          firstSeenAt: b.facts.events.firstSeenAt, lastSeenAt: b.facts.events.lastSeenAt,
          days: b.facts.events.newItemDays.slice(0, 14),
        })),
        comparableWindows: 1,
        limits: dynamicsDimension.limits,
      },
      reviewInsights: {
        available: reviewRows.length > 0,
        rows: reviewRows,
        ratedObjects: comparableObjects.length,
        limits: reviewDimension.limits,
      },
      satisfactionScatter,
    },
    opportunities: opportunities.slice(0, 24),
    summary: {
      usableDimensionCodes: usable.map(d => d.code),
      missingDimensionCodes: missing.map(d => d.code),
      usableDimensionCount: usable.length,
      missingDimensionCount: missing.length,
      brandCount: brands.length,
      brandsWithData: withProducts.length,
      opportunityCount: opportunities.length,
    },
  };
}

module.exports = { buildOpportunityFoundation, PRICE_BANDS, SATISFACTION_MIN_OBJECTS };
