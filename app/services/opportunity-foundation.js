'use strict';
// ============================================================
// services/opportunity-foundation.js —— 机会数据基础（SC-12 §六.1）
// ------------------------------------------------------------
// 目的：让「机会视图」不再只依赖满意度×重要性，改为「按可用维度独立工作」：
//   价格定位 / 商品数量与产品矩阵 / 上新·下架·库存 / 公开评论 / 内容 / 热度 / 广告
//
// 纪律（红线）：
//   1. 只用真实采集事实（collection_attempts 观察 + temporal_facts + derived_timeline_events），
//      不用 mock、不用推断值、不用文案里的数字；
//   2. 缺失保持 null —— 绝不用 0 填充（「没有数据」≠「数值为 0」）；
//   3. 每个维度必带：参与品牌数 / 观察数量 / 时间范围 / Evidence 数量 / 状态 /
//      measurementMethod / 限制说明；
//   4. 满意度×重要性门槛只在服务端判定，且**新旧机会数据共用同一套判定**
//      （app/lib/satisfaction-gate.js），前端只消费结果；
//   5. 机会线索只陈述「观察到的事实」，禁下经营结论。
//
// SC-12「合并前事实一致性整改」新增纪律：
//   A. 跨币种：价格必须带明确 ISO 币种；不同币种不得混算价格带/中位数/百分比差异；
//      没有带时间与来源的汇率事实时禁止自动换算；按币种分组输出。
//   B. 七维度真正消费采集结果：content/heat/ads 读取真实 attempt，
//      合法零结果 ≠ 未配置 ≠ 市场无覆盖，三者不得混用。
//   C. 历史数据与最新失败：每个维度同时给出 latestAttempt 与 lastUsableAttempt，
//      usingPreviousData 显式标记；默认不用旧数据生成「当前市场」比较线索。
//   D. 比较结论必须引用全部参与样本的结构化证据；引用不足不生成结论。
//   E. 用户 API 不得出现环境变量名、凭据名、provider 名、内部错误码、attempt ID、
//      服务器路径——技术诊断只在管理员接口。
// ============================================================
const Registry = require('./capability-registry.js');
const SurfaceStore = require('./surface-store.js');
const MemStore = require('./competitive-memory-store.js');
const ScatterGate = require('../lib/satisfaction-gate.js');

// ---------------- 币种（§一） ----------------
// 只有符合 ISO 4217 三字母大写才认为「币种明确」
const ISO_CURRENCY_RE = /^[A-Z]{3}$/;
function isIsoCurrency(c) { return typeof c === 'string' && ISO_CURRENCY_RE.test(c); }

// 展示符号：仅用于金额前缀；不匹配的一律用「代码 + 空格」，绝不借用其他币种符号
const CURRENCY_SYMBOLS = Object.freeze({
  USD: '$', EUR: '€', GBP: '£', CNY: '¥', JPY: '¥', KRW: '₩', INR: '₹',
  RUB: '₽', BRL: 'R$', AUD: 'A$', CAD: 'C$', NZD: 'NZ$', CHF: 'CHF ',
  SEK: 'kr ', NOK: 'kr ', DKK: 'kr ', PLN: 'zł ', THB: '฿', VND: '₫',
  MXN: 'MX$', SGD: 'S$', HKD: 'HK$', TWD: 'NT$', ZAR: 'R ', TRY: '₺',
});
function currencySymbol(code) {
  if (!isIsoCurrency(code)) return null;
  return CURRENCY_SYMBOLS[code] != null ? CURRENCY_SYMBOLS[code] : code + ' ';
}
function moneyText(v, code) {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  const sym = currencySymbol(code);
  return sym ? sym + v : String(v);
}
// 价格带：按币种生成标题与单位（禁止非 USD 数据显示 '$'）
const BAND_EDGES = [
  { key: 'b0_10', min: 0, max: 10 },
  { key: 'b10_25', min: 10, max: 25 },
  { key: 'b25_50', min: 25, max: 50 },
  { key: 'b50_100', min: 50, max: 100 },
  { key: 'b100_200', min: 100, max: 200 },
  { key: 'b200p', min: 200, max: Infinity },
];
function priceBandsFor(currency) {
  const sym = currencySymbol(currency) || '';
  return BAND_EDGES.map(e => ({
    key: e.key,
    label: sym + e.min + '–' + (e.max === Infinity ? '以上' : e.max),
    min: e.min,
    max: e.max === Infinity ? null : e.max,
    currency: currency,
  }));
}

// 币种状态：confirmed（全部非空且为同一明确 ISO）/ mixed（多种或含非法值）/ unknown（全空）
function currencyStatusOf(list) {
  const any = (Array.isArray(list) ? list : []).filter(v => v != null && v !== '');
  if (!any.length) return { status: 'unknown', currency: null };
  const distinct = new Set(any);
  const valid = Array.from(new Set(any.filter(isIsoCurrency)));
  // 只有一个取值、且该取值是合法 ISO → 明确；否则一律 mixed（不允许拼成 "USD/EUR"）
  if (distinct.size === 1 && valid.length === 1) return { status: 'confirmed', currency: valid[0] };
  if (valid.length === 1) return { status: 'mixed', currency: null };  // 含大小写/空格等非法写法
  return { status: 'mixed', currency: null };
}

// 维度 → 能力映射
const DIMENSION_CAPS = {
  price: ['shopify_catalog', 'public_site_products'],
  catalog: ['shopify_catalog', 'public_site_products'],
  dynamics: ['shopify_catalog', 'public_site_products'],
  reviews: ['public_reviews'],
  content: ['youtube_content'],
  heat: ['dataforseo_trends'],
  ads: ['tiktok_commercial_content'],
};
// 需要真实消费采集结果的三个维度（§二）
const LIVE_DIMENSIONS = ['content', 'heat', 'ads'];

function jparse(v, dflt) { try { const x = JSON.parse(v == null ? '' : v); return x == null ? dflt : x; } catch (e) { return dflt; } }
function arr(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }
function uniq(list) { return Array.from(new Set(list.filter(Boolean))); }
function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function round2(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null; }
function medianOfSorted(sorted) {
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : round2((sorted[m - 1] + sorted[m]) / 2);
}

// user-safe：把内部失败分类映射为可展示短状态（不出现内部码）
const FAILURE_USER_TEXT = Object.freeze({
  blocked: '来源拒绝了本次访问',
  unavailable: '来源暂时不可达',
  timeout: '来源暂时不可达',
  rate_limited: '来源访问频率受限',
  parse_failed: '来源内容暂时无法解析',
  internal_error: '采集未完成，需要重试',
  adapter_output_invalid: '采集未完成，需要重试',
  not_configured: '数据服务暂不可用',
  auth_rejected: '平台授权未通过',
  quota_exhausted: '平台配额已用尽',
  out_of_coverage: '该品牌所在市场暂未覆盖',
});
function userFailureText(ss, ec) {
  if (ec === 'auth_rejected') return FAILURE_USER_TEXT.auth_rejected;
  if (ec === 'quota_exhausted') return FAILURE_USER_TEXT.quota_exhausted;
  if (ec === 'out_of_coverage') return FAILURE_USER_TEXT.out_of_coverage;
  if (ss && FAILURE_USER_TEXT[ss]) return FAILURE_USER_TEXT[ss];
  if (ec && FAILURE_USER_TEXT[ec]) return FAILURE_USER_TEXT[ec];
  return '采集未完成，需要重试';
}

// ============================================================
// 单维度 attempt 视图（§三）：最新 + 最近可用，显式区分
// ============================================================
function attemptPair(tenantId, projectId, compId, caps) {
  let atts = [];
  for (const cap of caps) {
    try {
      const list = SurfaceStore.listAttempts(tenantId, projectId, compId, cap, 20) || [];
      atts = atts.concat(list);
    } catch (e) { /* 单能力不可读不影响其他 */ }
  }
  atts.sort((a, b) => String(b.startedAt || b.started_at || '').localeCompare(String(a.startedAt || a.started_at || '')));
  const latest = atts[0] || null;
  const lastUsable = atts.find(a => (a.status === 'success' || a.status === 'partial')
    && (Array.isArray(a.observations) ? a.observations.length : 0) > 0) || null;
  // 合法零结果：真实成功/partial 但确实 0 条观察（≠ 未配置、≠ 市场无覆盖）
  const lastSuccessAny = atts.find(a => a.status === 'success' || a.status === 'partial') || null;
  const latestFailed = !!(latest && latest.status === 'failed');
  return {
    latest, lastUsable, lastSuccessAny,
    // 最新失败但历史成功仍存在 → 保留历史数据并显式标记
    usingPreviousData: latestFailed && !!lastUsable,
    // 有真实成功但零观察 → 已检查（不得显示未配置/市场无覆盖）
    checkedEmpty: !!lastSuccessAny && !lastUsable,
    lastSuccessAt: lastUsable ? (lastUsable.endedAt || lastUsable.ended_at || lastUsable.startedAt || lastUsable.started_at || null) : null,
    latestFailureText: latestFailed ? userFailureText(latest.sourceStatus || latest.source_status, latest.errorClass || latest.error_class) : null,
    latestStatus: latest ? latest.status : null,
  };
}

// 结构化证据引用（§五.2）：{ evidenceId, snapshotId, sourceUrl, brandId, observedAt }
function evidenceRefsOf(att, brandId, fallbackObservations) {
  if (!att) return [];
  const evIds = arr(att.evidenceIds);
  const snIds = arr(att.snapshotIds || att.snapshot_ids);
  const obs = Array.isArray(att.observations) ? att.observations : (fallbackObservations || []);
  const out = [];
  const n = Math.max(evIds.length, snIds.length, obs.length);
  for (let i = 0; i < n; i++) {
    const evId = evIds[i] || null;
    const snId = snIds[i] || null;
    if (!evId && !snId) continue;
    const o = obs[i] || null;
    out.push({
      evidenceId: evId,
      snapshotId: snId,
      sourceUrl: (o && (o.sourceUrl || o.url || o.videoUrl)) ? String(o.sourceUrl || o.url || o.videoUrl) : null,
      brandId: brandId || null,
      observedAt: (att.endedAt || att.ended_at || att.startedAt || att.started_at || (o && o.publishedAt) || null),
    });
  }
  return out;
}

// ---------------- 单品牌事实 ----------------
function collectBrandFacts(tenantId, projectId, compId, brandId) {
  const out = {
    competitorId: compId,
    products: null, catalog: null, reviews: null,
    content: null, heat: null, ads: null,
    events: { newItems: 0, newItemDays: [], firstSeenAt: null, lastSeenAt: null, evidenceIds: [] },
    attempts: [], capabilities: {},
  };
  if (!compId) return out;

  let atts = [];
  try { atts = SurfaceStore.listAttemptsByCompetitor(tenantId, projectId, compId, 100) || []; } catch (e) { atts = []; }
  out.attempts = atts.slice(0, 40).map(a => ({
    capability: a.capability, status: a.status,
    observationCount: Array.isArray(a.observations) ? a.observations.length : 0,
    evidenceCount: Array.isArray(a.evidenceIds) ? a.evidenceIds.length : 0,
    startedAt: a.startedAt || a.started_at || null, endedAt: a.endedAt || a.ended_at || null,
  }));

  // 1) 商品与价格（观察层）
  const pairP = attemptPair(tenantId, projectId, compId, DIMENSION_CAPS.price);
  const pa = pairP.lastUsable;
  if (pa) {
    const obs = Array.isArray(pa.observations) ? pa.observations : [];
    const prices = obs.map(o => num(o && o.price)).filter(v => v != null);
    // §一.1：价格必须保留并校验明确 ISO 币种；多币种/未知币种不拼成 "USD/EUR"
    const cs = currencyStatusOf(obs.map(o => (o && o.currency) || null));
    out.products = {
      count: obs.length,
      available: obs.filter(o => o && o.available === true).length,
      soldOut: obs.filter(o => o && o.available === false).length,
      prices: cs.status === 'confirmed' ? prices : [],   // 币种不明时不参与价格计算
      currency: cs.currency,
      currencyStatus: cs.status,
      observedAt: pa.endedAt || pa.startedAt || null,
      evidenceRefs: evidenceRefsOf(pa, brandId, obs),
      usingPreviousData: pairP.usingPreviousData,
      lastSuccessAt: pairP.lastSuccessAt,
      latestFailureText: pairP.latestFailureText,
      capability: pa.capability,
    };
  }

  // 2) 目录级事实（记忆层）—— §一.6：必须读取对应 currency
  try {
    const r = MemStore.listFacts(tenantId, projectId, compId, {
      entityType: 'brand_catalog',
      factTypes: ['catalog.product_count', 'catalog.price_min', 'catalog.price_median', 'catalog.price_max'],
      limit: 50,
    });
    const facts = (r && r.facts) || [];
    if (facts.length) {
      const pick = (t) => { const f = facts.find(x => x.factType === t); return f ? f : null; };
      const priceFacts = [pick('catalog.price_min'), pick('catalog.price_median'), pick('catalog.price_max')].filter(Boolean);
      // 四项（含 product_count 无币种）中，三个价格事实必须**币种一致且明确**才能用于价格比较
      const cs = currencyStatusOf(priceFacts.map(f => (f && f.currency) || null));
      const pc = pick('catalog.product_count');
      out.catalog = {
        productCount: pc ? num(pc.valueNum) : null,
        // 币种缺失或不一致 → 价格三值不参与比较（保留 null，不猜测）
        priceMin: cs.status === 'confirmed' && priceFacts[0] ? num(priceFacts[0].valueNum) : null,
        priceMedian: cs.status === 'confirmed' && priceFacts[1] ? num(priceFacts[1].valueNum) : null,
        priceMax: cs.status === 'confirmed' && priceFacts[2] ? num(priceFacts[2].valueNum) : null,
        currency: cs.currency,
        currencyStatus: cs.status,
        priceComparable: cs.status === 'confirmed',
        observedAt: facts.map(f => f.observedAt).filter(Boolean).sort().pop() || null,
        evidenceRefs: uniq(facts.flatMap(f => arr(f.evidenceIds))).map(id => ({
          evidenceId: id, snapshotId: null, sourceUrl: null, brandId: brandId || null,
          observedAt: facts.map(f => f.observedAt).filter(Boolean).sort().pop() || null,
        })),
        measurementMethod: facts[0].measurementMethod || null,
      };
    }
  } catch (e) { out.catalog = null; }

  // 3) 公开评论
  const pairR = attemptPair(tenantId, projectId, compId, DIMENSION_CAPS.reviews);
  const ra = pairR.lastUsable;
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
      evidenceRefs: evidenceRefsOf(ra, brandId, obs),
      usingPreviousData: pairR.usingPreviousData,
      lastSuccessAt: pairR.lastSuccessAt,
      latestFailureText: pairR.latestFailureText,
      emptyReason: sum.emptyReason || null,
    };
  }

  // 4) 上新/首次观察事件
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

// ============================================================
// §二：三个真实维度（content / heat / ads）——真正消费采集结果
// ============================================================
function readinessOf(capCode) {
  try {
    const rd = require('./source-readiness.js').getReadiness(capCode);
    return rd && rd.state ? rd : null;
  } catch (e) { return null; }
}

// 逐品牌：TikTok 市场覆盖（§二.5：按品牌明确市场分别判断）
function marketCoverageOf(capCode, brandMarket) {
  if (capCode !== 'tiktok_commercial_content') return { covered: true, outOfCoverage: false, note: null };
  try {
    const T = require('../lib/tiktok-adlib.js');
    const m = T.normalizeMarket ? T.normalizeMarket(brandMarket) : null;
    if (m == null) return { covered: null, outOfCoverage: false, note: '该品牌市场未标注，暂不判断是否覆盖' };
    const covered = typeof T.isCountryCovered === 'function' ? T.isCountryCovered(m) : null;
    if (covered === false) {
      return { covered: false, outOfCoverage: true, note: '该品牌所在市场暂未覆盖（' + T.COVERAGE_SCOPE_TEXT + '）' };
    }
    if (covered === true) return { covered: true, outOfCoverage: false, note: null };
    return { covered: null, outOfCoverage: false, note: '该品牌市场覆盖情况暂未确认' };
  } catch (e) {
    return { covered: null, outOfCoverage: false, note: null };
  }
}

function collectLiveDimensionFacts(tenantId, projectId, compId, brandId, capCode, brandMarket) {
  const pair = attemptPair(tenantId, projectId, compId, [capCode]);
  const latest = pair.latest;
  const usable = pair.lastUsable;
  const cov = marketCoverageOf(capCode, brandMarket);

  const base = {
    competitorId: compId, brandId: brandId || null, capability: capCode,
    latestStatus: pair.latestStatus,
    usingPreviousData: pair.usingPreviousData,
    lastSuccessAt: pair.lastSuccessAt,
    latestFailureText: pair.latestFailureText,
    outOfCoverage: cov.outOfCoverage,
    coverageNote: cov.note,
    observations: [], summary: null, observationCount: 0,
    evidenceRefs: [], observedAt: null,
    // 合法零结果：真实成功但确实没观察到内容（≠ 未配置、≠ 市场无覆盖）
    checkedEmpty: pair.checkedEmpty,
  };

  if (usable) {
    const obs = Array.isArray(usable.observations) ? usable.observations : [];
    base.observations = obs.slice(0, 30);
    base.observationCount = obs.length;
    base.summary = usable.summary || jparse(usable.summary, null) || null;
    base.evidenceRefs = evidenceRefsOf(usable, brandId, obs);
    base.observedAt = usable.endedAt || usable.startedAt || null;
    base.checkedEmpty = obs.length === 0;
    base.hasData = obs.length > 0;
    return base;
  }

  // 无可用数据 → 由「最近一次尝试」与「运行状态」共同决定占位状态，
  // 且各状态不得互相混用（§二.4）
  base.hasData = false;
  const ss = latest ? (latest.sourceStatus || latest.source_status || null) : null;
  const ec = latest ? (latest.errorClass || latest.error_class || null) : null;
  const rd = readinessOf(capCode);
  const rdState = rd ? rd.state : null;

  // 优先级（§二.4 不得混用 / §二.7 运行状态只在无可用 attempt 时决定占位）：
  //   ① attempt 显式失败（授权/配额）→ 最具体
  //   ② 来源已 operational 但该品牌市场未覆盖 → out_of_coverage
  //      （来源都没配好时不能拿「市场未覆盖」掩盖，故要求 rdState==='operational'）
  //   ③ 运行状态 not_configured / ready_to_verify
  //   ④ 最近一次失败 → unavailable
  if (ec === 'auth_rejected' || ss === 'auth_rejected') base.state = 'auth_rejected';
  else if (ec === 'quota_exhausted' || ss === 'quota_exhausted') base.state = 'quota_exhausted';
  else if (rdState === 'operational' && cov.outOfCoverage) base.state = 'out_of_coverage';
  else if (rdState === 'not_configured') base.state = 'not_configured';
  else if (rdState === 'ready_to_verify') base.state = 'ready_to_verify';
  else if (cov.outOfCoverage && (ec === 'out_of_coverage' || ss === 'out_of_coverage')) base.state = 'out_of_coverage';
  else if (latest && latest.status === 'failed') base.state = 'unavailable';
  else base.state = rdState || 'not_configured';

  return base;
}

const LIVE_STATE_TEXT = Object.freeze({
  not_configured: '等待系统数据服务配置',
  ready_to_verify: '数据服务待验证',
  auth_rejected: '等待平台授权',
  quota_exhausted: '平台配额已用尽',
  unavailable: '最近一次采集未成功',
  out_of_coverage: '该品牌所在市场暂未覆盖',
  checked_empty: '已检查，当前样本未观察到结果',
});

// ---------- C10 / §六：缺失维度的具体状态文案（不得用笼统「暂无数据」） ----------
const MISSING_STATUS_TEXT = Object.freeze({
  price: '价格数据来自公开商品标价；当前没有可比较的同币种价格观察。',
  catalog: '商品目录数据来自公开店铺页面；当前没有可统计的商品数观察。',
  dynamics: '上新与库存判断需要两个可比采集窗口；当前只有首轮基线，暂时无法判断变化。',
  reviews: '公开评论与用户声音尚未观察到可核验样本；样本充足后会单独展示。',
  content: '内容与互动数据来自平台公开接口；当前没有可展示的内容观察。',
  heat: '搜索热度为平台公开披露口径；当前没有可展示的热度观察。',
  ads: '广告素材与市场覆盖来自平台公开广告库；当前没有可展示的广告观察。',
});

function dimensionBasis(opts) {
  const o = opts || {};
  const brands = Array.isArray(o.brands) ? o.brands : [];
  const obs = brands.reduce((s, b) => s + (o.observationCount ? o.observationCount(b) : 0), 0);
  const ev = new Set();
  for (const b of brands) for (const e of (o.evidenceRefs ? o.evidenceRefs(b) : [])) {
    if (e && (e.evidenceId || e.snapshotId)) ev.add(e.evidenceId || e.snapshotId);
  }
  const times = brands.map(b => (o.observedAt ? o.observedAt(b) : null)).filter(Boolean).sort();
  const usable = o.status === 'complete' || o.status === 'partial';
  return {
    code: o.code,
    label: o.label,
    status: o.status,                 // complete | partial | missing | not_covered | not_configured | checked_empty
    statusText: o.statusText || (usable ? null : MISSING_STATUS_TEXT[o.code] || null),
    brandCount: brands.length,
    observationCount: obs,
    evidenceCount: ev.size,
    window: { from: times[0] || null, to: times[times.length - 1] || null },
    measurementMethod: o.measurementMethod || null,
    limits: Array.isArray(o.limits) ? o.limits : [],
    // §三：历史数据与最新失败
    usingPreviousData: !!o.usingPreviousData,
    lastSuccessAt: o.lastSuccessAt || null,
    latestFailureText: o.latestFailureText || null,
    // §二：逐品牌状态（UI 用于「每项只显示一次」+ 混合状态不混用）
    perBrand: Array.isArray(o._perBrand) ? o._perBrand : null,
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
    facts: collectBrandFacts(tid, pid, v.competitorId, v.brandId),
  }));

  // §二：三个真实维度取数（逐品牌）
  for (const b of brands) {
    if (!b.competitorId) continue;
    b.facts.content = collectLiveDimensionFacts(tid, pid, b.competitorId, b.brandId, 'youtube_content', b.market);
    b.facts.heat = collectLiveDimensionFacts(tid, pid, b.competitorId, b.brandId, 'dataforseo_trends', b.market);
    b.facts.ads = collectLiveDimensionFacts(tid, pid, b.competitorId, b.brandId, 'tiktok_commercial_content', b.market);
  }

  // ---------------- 价格行（§一） ----------------
  const priceRows = brands.map(b => {
    const p = b.facts.products || null;
    const c = b.facts.catalog || null;
    // 币种以 catalog 优先（时序档案口径），其次观察层
    let currency = null, currencyStatus = 'unknown';
    if (c && c.currencyStatus === 'confirmed') { currency = c.currency; currencyStatus = 'confirmed'; }
    else if (c && c.currencyStatus === 'mixed') { currencyStatus = 'mixed'; }
    else if (p && p.currencyStatus) { currency = p.currency; currencyStatus = p.currencyStatus; }

    const comparable = currencyStatus === 'confirmed' && isIsoCurrency(currency);
    const prices = p && p.currencyStatus === 'confirmed' ? p.prices : [];
    return {
      brandId: b.brandId, name: b.name, competitorId: b.competitorId,
      productCount: c && c.productCount != null ? c.productCount : (p ? p.count : null),
      available: p ? p.available : null,
      soldOut: p ? p.soldOut : null,
      // 币种不明确 → 价格三值一律 null（不猜测、不换算）
      priceMin: comparable ? (c && c.priceMin != null ? c.priceMin : (prices.length ? Math.min(...prices) : null)) : null,
      priceMedian: comparable ? (c && c.priceMedian != null ? c.priceMedian
        : (prices.length ? medianOfSorted(prices.slice().sort((x, y) => x - y)) : null)) : null,
      priceMax: comparable ? (c && c.priceMax != null ? c.priceMax : (prices.length ? Math.max(...prices) : null)) : null,
      currency: comparable ? currency : null,
      currencyStatus,
      priceComparable: comparable,
      observedAt: (p && p.observedAt) || (c && c.observedAt) || null,
      evidenceRefs: [...(p ? p.evidenceRefs : []), ...(c ? c.evidenceRefs : [])],
      observationCount: p ? p.count : 0,
      usingPreviousData: !!(p && p.usingPreviousData),
      lastSuccessAt: (p && p.lastSuccessAt) || null,
      latestFailureText: (p && p.latestFailureText) || null,
    };
  }).filter(r => r.productCount != null || r.priceMin != null || r.priceMax != null);

  // ---------------- 按币种分组（§一.5） ----------------
  const groupsByCurrency = {};
  for (const r of priceRows) {
    if (!r.priceComparable || !r.currency) continue;
    if (!groupsByCurrency[r.currency]) groupsByCurrency[r.currency] = [];
    groupsByCurrency[r.currency].push(r);
  }
  const priceGroups = Object.keys(groupsByCurrency).sort().map(currency => {
    const rows = groupsByCurrency[currency];
    const bands = priceBandsFor(currency).map(band => {
      const inBand = rows.filter(r => {
        const lo = r.priceMin != null ? r.priceMin : r.priceMax;
        const hi = r.priceMax != null ? r.priceMax : r.priceMin;
        if (lo == null || hi == null) return false;
        return hi >= band.min && lo < band.max;
      });
      return {
        key: band.key, label: band.label, min: band.min, max: band.max, currency,
        brandCount: inBand.length,
        brandIds: inBand.map(r => r.brandId),
        brandNames: inBand.map(r => r.name),
        covered: inBand.length > 0,
      };
    });
    const medians = rows.filter(r => r.priceMedian != null).map(r => r.priceMedian).sort((a, b) => a - b);
    // §一：只有**同币种**且 ≥3 个品牌才允许计算项目中位数
    const median = medians.length >= 3 ? medianOfSorted(medians) : null;
    return {
      currency, symbol: currencySymbol(currency),
      brandCount: rows.length,
      rows, bands,
      medianPrice: median,
      medianSampleSize: medians.length,
      // 中位数不足 3 个品牌 → 不生成相对定位线索，只展示原始价格范围
      positioningAvailable: median != null,
      bandsAvailable: rows.length >= 2,
    };
  });

  const nonComparableRows = priceRows.filter(r => !r.priceComparable);
  const anyPreviousData = priceRows.some(r => r.usingPreviousData);

  const priceDimension = dimensionBasis({
    code: 'price', label: '价格',
    status: priceGroups.length ? 'partial' : (nonComparableRows.length ? 'missing' : 'missing'),
    statusText: priceGroups.length ? '按币种分组展示' : '币种未确认，价格比较不可用',
    brands: priceRows,
    observationCount: b => b.observationCount,
    evidenceRefs: b => b.evidenceRefs,
    observedAt: b => b.observedAt,
    measurementMethod: 'direct_observation',
    usingPreviousData: anyPreviousData,
    limits: [
      '价格为采集时点的公开标价，不等于成交价或 GMV。',
      '不同币种不合并计算价格带、中位数或百分比差异；没有带时间与来源的汇率事实时不做换算。',
      '币种缺失或混合的品牌不参与价格比较（商品数量仍可用于产品矩阵）。',
    ],
  });

  const catalogDimension = dimensionBasis({
    code: 'catalog', label: '商品与产品矩阵',
    status: priceRows.filter(r => r.productCount != null).length ? 'partial' : 'missing',
    brands: priceRows,
    observationCount: b => b.observationCount,
    evidenceRefs: b => b.evidenceRefs,
    observedAt: b => b.observedAt,
    measurementMethod: 'direct_observation',
    limits: [
      '在售 SKU 数是公开目录的截面，不等于真实经营规模。',
      '缺货状态来自采集时点的公开可购买性，非库存系统数据。',
      'SKU 数不受币种影响：币种未知的品牌仍计入产品矩阵。',
    ],
  });

  const eventBrands = brands.filter(b => b.facts.events && b.facts.events.newItems > 0);
  const dynamicsDimension = dimensionBasis({
    code: 'dynamics', label: '上新与库存动态',
    status: eventBrands.length ? 'partial' : 'missing',
    brands: eventBrands,
    observationCount: b => (b.facts.events ? b.facts.events.newItems : 0),
    evidenceRefs: b => (b.facts.events ? b.facts.events.evidenceIds.map(id => ({ evidenceId: id })) : []),
    observedAt: b => (b.facts.events ? b.facts.events.firstSeenAt : null),
    measurementMethod: 'direct_observation',
    limits: [
      '当前只完成首轮基线采集，尚无第二个可比窗口，因此只能陈述「首次观察到的商品数」，不能判断上新或下架。',
    ],
  });

  const reviewRows = brands.filter(b => b.facts.reviews).map(b => ({
    brandId: b.brandId, name: b.name,
    pageCount: b.facts.reviews.pageCount,
    ratedPages: b.facts.reviews.ratedPages,
    reviewCount: b.facts.reviews.reviewCount,
    sourceCount: b.facts.reviews.sourceCount,
    observedAt: b.facts.reviews.observedAt,
    evidenceRefs: b.facts.reviews.evidenceRefs,
    pages: b.facts.reviews.pages,
    usingPreviousData: b.facts.reviews.usingPreviousData,
    latestFailureText: b.facts.reviews.latestFailureText,
  }));
  const reviewDimension = dimensionBasis({
    code: 'reviews', label: '公开评论与用户声音',
    status: reviewRows.length ? 'partial' : 'missing',
    brands: reviewRows,
    observationCount: b => b.pageCount,
    evidenceRefs: b => b.evidenceRefs,
    observedAt: b => b.observedAt,
    measurementMethod: 'public_source_observation',
    usingPreviousData: reviewRows.some(r => r.usingPreviousData),
    limits: [
      '样本是本次采集窗口内通过校验的公开页面，不等于全网口碑。',
      '页面未发布可核验评分时，评分样本为 0（不是评分为 0）。',
    ],
  });

  // ---------------- §二：content / heat / ads 真实维度 ----------------
  function liveDimension(code, label, caps, measurementMethod) {
    const dimBrands = [];
    const stateCounts = {};
    let usingPrev = false, lastSuccess = null, failText = null;
    for (const b of brands) {
      const f = b.facts[code];
      if (!f) continue;
      if (f.hasData) {
        dimBrands.push({
          brandId: b.brandId, name: b.name, competitorId: b.competitorId,
          observationCount: f.observationCount,
          summary: f.summary,
          observations: f.observations,
          evidenceRefs: f.evidenceRefs,
          observedAt: f.observedAt,
          outOfCoverage: f.outOfCoverage,
          coverageNote: f.coverageNote,
        });
      } else {
        const st = f.checkedEmpty ? 'checked_empty' : f.state;
        stateCounts[st] = (stateCounts[st] || 0) + 1;
      }
      if (f.usingPreviousData) { usingPrev = true; if (!lastSuccess) lastSuccess = f.lastSuccessAt; }
      if (f.latestFailureText && !failText) failText = f.latestFailureText;
    }

    // 状态判定优先级：有真实数据 → 优先展示数据（§二.6）
    let status, statusText;
    if (dimBrands.length) {
      status = dimBrands.length === brands.length ? 'complete' : 'partial';
      statusText = null;
    } else {
      const keys = Object.keys(stateCounts);
      // 不得互相混用：若各品牌状态不一致，取「最具体」的一个并说明存在混合
      const pick = keys.indexOf('out_of_coverage') >= 0 ? 'out_of_coverage'
        : keys.indexOf('auth_rejected') >= 0 ? 'auth_rejected'
          : keys.indexOf('quota_exhausted') >= 0 ? 'quota_exhausted'
            : keys.indexOf('checked_empty') >= 0 ? 'checked_empty'
              : keys.indexOf('unavailable') >= 0 ? 'unavailable'
                : keys.indexOf('ready_to_verify') >= 0 ? 'ready_to_verify'
                  : 'not_configured';
      status = pick === 'checked_empty' ? 'checked_empty' : (pick === 'out_of_coverage' ? 'not_covered' : 'not_configured');
      statusText = keys.length > 1
        ? LIVE_STATE_TEXT[pick] + '（各品牌状态不一致，按品牌分别标注）'
        : LIVE_STATE_TEXT[pick];
    }

    const perBrand = brands.map(b => {
      const f = b.facts[code];
      if (!f) return null;
      const st = f.hasData ? 'has_data' : (f.checkedEmpty ? 'checked_empty' : f.state);
      return {
        brandId: b.brandId, name: b.name,
        state: st,
        stateText: st === 'has_data' ? null : LIVE_STATE_TEXT[st],
        observationCount: f.observationCount,
        observedAt: f.observedAt,
        outOfCoverage: f.outOfCoverage,
        coverageNote: f.coverageNote,
        evidenceRefs: f.evidenceRefs,
      };
    }).filter(Boolean);

    return dimensionBasis({
      code, label,
      status, statusText,
      brands: dimBrands,
      observationCount: x => x.observationCount,
      evidenceRefs: x => x.evidenceRefs,
      observedAt: x => x.observedAt,
      measurementMethod,
      usingPreviousData: usingPrev,
      lastSuccessAt: lastSuccess,
      latestFailureText: failText,
      limits: [],   // 由调用方补齐（禁止出现凭据名 / provider 名）
      // 额外：逐品牌状态（UI 用来「每项只显示一次」+ 混合状态不混用）
      _perBrand: perBrand,
    });
  }

  const contentDimension = liveDimension('content', '内容与互动', DIMENSION_CAPS.content, 'public_source_observation');
  contentDimension.limits = [
    '数据来源为各平台公开接口；未采集到的平台不参与统计，也不按 0 计入。',
    '「已检查，当前样本未观察到结果」表示该来源已成功采集但确实没有可展示内容，不等于未配置或市场无覆盖。',
  ];
  const heatDimension = liveDimension('heat', '搜索热度', DIMENSION_CAPS.heat, 'official_disclosure');
  heatDimension.limits = [
    '搜索热度为平台公开披露口径的区间值，不是精确搜索量。',
    '未覆盖国家不参与统计，也不代表该市场没有搜索需求。',
  ];
  const adsDimension = liveDimension('ads', '广告素材与市场覆盖', DIMENSION_CAPS.ads, 'official_disclosure');
  adsDimension.limits = [
    '广告库覆盖范围按品牌所在市场分别判断；一个市场未覆盖不影响其他市场品牌。',
    '覆盖范围来自平台官方披露，未覆盖国家不代表该品牌没有投放广告。',
  ];

  // ---------------- §四：满意度 × 重要性（唯一门槛） ----------------
  // 对象 = 主题级（与旧 opportunity 同源：importance 提及广度 / satisfaction 正负提及比）
  let scatterObjects = [];
  try {
    const VoiceUnified = require('./voice-unified.js');
    const OppLib = require('../lib/opportunity.js');
    const comps = brands.filter(b => b.competitorId).map(b => ({ id: b.competitorId, name: b.name, status: 'done' }));
    const vi = VoiceUnified.buildOpportunityInputForComps({ tenantId: tid, projectId: pid, comps });
    const map = OppLib.computeOpportunityMap(comps, {
      voiceItems: vi.items, voiceCollected: vi.collected,
    });
    const themes = (map && Array.isArray(map.themes)) ? map.themes : [];
    scatterObjects = themes.map(t => {
      const stamps = (t.sources || []).map(x => x && x.observedAt).filter(Boolean).sort();
      return {
        oid: t.oid || null,
        label: t.label || null,
        satisfaction: num(t.satisfaction),
        importance: num(t.importance),
        // 计算依据：情绪分类依据种类（来源字段/确定性规则/模型提取）
        satisfactionBasis: (t.sources || []).map(s => s && s.basis).filter(b => b)[0] || null,
        importanceBasis: (t.sources || []).map(s => s && s.basis).filter(b => b)[0] || null,
        satisfactionBasisText: t.denominatorText || null,
        importanceBasisText: t.denominatorText || null,
        sampleScope: vi.brandsWithVoice ? (t.brandsMentioned + '/' + vi.brandsWithVoice + ' 家有用户声音的品牌提到') : null,
        window: { from: stamps[0] || null, to: stamps[stamps.length - 1] || null },
        brandsMentioned: num(t.brandsMentioned),
        brandsWithVoice: num(t.brandsWithVoice),
        posMentions: num(t.posMentions),
        negMentions: num(t.negMentions),
        confidence: t.confidence || null,
        evidenceRefs: (t.sources || []).map(s => ScatterGate.normalizeRef({
          evidenceId: s.evidenceId, snapshotId: s.snapshotId, sourceUrl: s.url, observedAt: s.observedAt,
        })).filter(Boolean),
      };
    });
  } catch (e) { scatterObjects = []; }

  const satisfactionScatter = ScatterGate.evaluateScatterGate(scatterObjects, {});

  // ---------------- 机会线索（§五：引用全部参与样本证据） ----------------
  const opportunities = [];
  const refsOf = (rows) => {
    const out = [];
    for (const r of rows) for (const e of (r.evidenceRefs || [])) {
      if (e && (e.evidenceId || e.snapshotId)) out.push(e);
    }
    return out.slice(0, 12);
  };
  // 参与样本证据必须齐全：每个参与品牌至少有一条可用引用，否则不生成比较结论
  const allBrandsHaveRefs = (rows) => rows.every(r => (r.evidenceRefs || []).some(e => e && (e.evidenceId || e.snapshotId)));

  // ① 价格带（按币种分组；同币种 ≥2 个品牌才生成）
  for (const g of priceGroups) {
    if (!g.bandsAvailable) continue;
    for (const band of g.bands) {
      if (band.brandCount !== 1 || g.rows.length < 3) continue;
      const r = g.rows.find(x => x.brandId === band.brandIds[0]);
      if (!r || !allBrandsHaveRefs(g.rows)) continue;
      opportunities.push({
        id: 'priceband-' + g.currency + '-' + band.key,
        title: band.label + ' 价格带仅 1 个品牌在售（' + g.currency + '）',
        fact: '本次采集截面内，' + band.label + ' 价格带只有 ' + band.brandNames.join('、') + ' 在售商品；同币种其余 ' + (g.rows.length - 1) + ' 个品牌的公开价格区间未覆盖该价格带。',
        dimension: '价格',
        dimensionCode: 'price',
        sampleSize: g.rows.length + ' 个同币种（' + g.currency + '）品牌的价格区间',
        window: { from: priceDimension.window.from, to: priceDimension.window.to },
        evidenceRefs: refsOf(g.rows),
        limits: ['价格为公开标价截面；未在售商品与未采集品牌都不计入，不等于该价格带无需求。',
          '仅在同一币种内比较，未做汇率换算。'],
        question: '该价格带在竞品之外是否有实际成交？需要补充哪一类证据来验证？',
      });
    }
  }

  // ② 价格定位差异（同币种 ≥3 且中位数可用）
  for (const g of priceGroups) {
    if (!g.positioningAvailable) continue;
    const withMedian = g.rows.filter(x => x.priceMedian != null);
    if (!allBrandsHaveRefs(g.rows)) continue;
    for (const r of withMedian) {
      const diff = round2((r.priceMedian - g.medianPrice) / g.medianPrice * 100);
      if (diff == null || Math.abs(diff) < 15) continue;
      opportunities.push({
        id: 'pricepos-' + g.currency + '-' + r.brandId,
        title: r.name + ' 价格定位' + (diff > 0 ? '高于' : '低于') + '同币种品牌中位数 ' + Math.abs(diff) + '%',
        fact: r.name + ' 在售商品价格中位数为 ' + moneyText(r.priceMedian, g.currency) + '，同币种 ' + withMedian.length + ' 个品牌的中位数为 ' + moneyText(g.medianPrice, g.currency) + '，差异 ' + diff + '%。',
        dimension: '价格',
        dimensionCode: 'price',
        sampleSize: withMedian.length + ' 个同币种（' + g.currency + '）品牌的价格中位数',
        window: { from: priceDimension.window.from, to: priceDimension.window.to },
        evidenceRefs: refsOf(g.rows),
        limits: ['中位数来自公开标价截面；不同规格/装量不可直接比较。', '仅在同一币种内比较，未做汇率换算。'],
        question: '该价格定位差异对应怎样的规格或装量结构？需要补充哪些竞品证据？',
      });
    }
  }

  // ③ 产品矩阵密度（SKU 不受币种影响）
  {
    const rows = priceRows.filter(r => r.productCount != null);
    if (rows.length >= 3 && allBrandsHaveRefs(rows)) {
      const counts = rows.map(r => r.productCount).sort((a, b) => a - b);
      const medCount = medianOfSorted(counts);
      for (const r of rows.filter(x => x.productCount < medCount)) {
        opportunities.push({
          id: 'matrix-' + r.brandId,
          title: r.name + ' 在售 SKU 数低于同项目中位数',
          fact: r.name + ' 公开目录在售 ' + r.productCount + ' 款，同项目 ' + counts.length + ' 个品牌的中位数为 ' + medCount + ' 款。',
          dimension: '商品与产品矩阵',
          dimensionCode: 'catalog',
          sampleSize: counts.length + ' 个品牌的在售 SKU 数',
          window: { from: catalogDimension.window.from, to: catalogDimension.window.to },
          evidenceRefs: refsOf(rows),
          limits: ['在售 SKU 数是公开目录截面；不同品类结构的品牌之间不可直接比较。', 'SKU 数不受币种影响，币种未知的品牌仍计入。'],
          question: 'SKU 差异来自品类结构还是覆盖范围？需要按品类分层后再看吗？',
        });
      }
    }
  }

  // ④ 上新基线（首轮基线，不能判断上新）
  for (const b of eventBrands) {
    if (b.facts.events.newItems < 1) continue;
    const evRefs = b.facts.events.evidenceIds.map(id => ({ evidenceId: id, snapshotId: null, sourceUrl: null, brandId: b.brandId, observedAt: b.facts.events.firstSeenAt }));
    if (!evRefs.length) continue;
    opportunities.push({
      id: 'baseline-' + b.brandId,
      title: b.name + ' 已建立 ' + b.facts.events.newItems + ' 款商品的采集基线',
      fact: 'Vantage 于 ' + (b.facts.events.firstSeenAt || '').slice(0, 10) + ' 首次观察到 ' + b.name + ' 的 ' + b.facts.events.newItems + ' 款商品（基线建立）。',
      dimension: '上新与库存动态',
      dimensionCode: 'dynamics',
      sampleSize: b.facts.events.newItems + ' 款商品',
      window: { from: b.facts.events.firstSeenAt, to: b.facts.events.lastSeenAt },
      evidenceRefs: evRefs.slice(0, 12),
      limits: ['当前只有首轮基线，尚未有第二个可比窗口，无法判断上新或下架；不可比记录不得当作变化。'],
      question: '需要等待多久的第二个窗口，才能判断真实的上新与下架节奏？',
    });
  }

  // ⑤ 历史观察线索（§三.3）：最新失败但历史成功时，标题与窗口必须明确写「历史观察」
  const historicalRows = priceRows.filter(r => r.usingPreviousData && r.priceComparable);
  if (historicalRows.length) {
    const g0 = historicalRows[0];
    opportunities.push({
      id: 'historical-price-' + (g0.currency || 'unknown'),
      title: '历史观察：' + historicalRows.length + ' 个品牌的价格数据来自上一次成功采集',
      fact: '这是历史观察：' + historicalRows.map(r => r.name + '（最近成功 ' + String(r.lastSuccessAt || '').slice(0, 10) + '）').join('、') + ' 的最近一次采集未成功，页面展示的是上一次成功采集的历史价格；这些数据不作为「当前市场」比较结论。',
      dimension: '价格',
      dimensionCode: 'price',
      sampleSize: historicalRows.length + ' 个品牌的历史价格观察',
      window: { from: null, to: null },
      evidenceRefs: refsOf(historicalRows),
      historical: true,
      limits: ['这是历史观察数据，不是当前市场截面；最近一次采集未成功后自动保留，不替代最新数据。',
        '不用于生成「当前市场」的价格定位或价格带结论。'],
      question: '重新采集成功后，需要用最新数据替换这些历史观察再做比较吗？',
    });
  }

  const allDimensions = [priceDimension, catalogDimension, dynamicsDimension, reviewDimension,
    contentDimension, heatDimension, adsDimension];
  const usable = allDimensions.filter(d => d.status === 'complete' || d.status === 'partial');
  const missing = allDimensions.filter(d => !['complete', 'partial'].includes(d.status));

  return {
    projectId: pid,
    generatedAt: new Date().toISOString(),
    brandScope: {
      total: brands.length,
      withData: brands.filter(b => b.facts.products || b.facts.catalog).length,
      withReviews: brands.filter(b => b.facts.reviews).length,
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
    // 每个维度只出现一次：不可用维度统一在此列出（§六.1）
    unavailableDimensions: missing.map(d => ({
      code: d.code, label: d.label, status: d.status, statusText: d.statusText,
      brandCount: d.brandCount, window: d.window,
      perBrand: d.perBrand || null,
      latestFailureText: d.latestFailureText || null,
      usingPreviousData: d.usingPreviousData,
      lastSuccessAt: d.lastSuccessAt || null,
    })),
    modules: {
      priceBands: {
        available: priceGroups.length > 0,
        // 按币种分组输出（§一.5）
        groups: priceGroups,
        // 兼容单币种展示：币种唯一时给扁平 bands
        bands: priceGroups.length ? priceGroups[0].bands : [],
        currency: priceGroups.length === 1 ? priceGroups[0].currency : null,
        multiCurrency: priceGroups.length > 1,
        rows: priceRows,
        // 币种不可比较的品牌（仍保留原始价格范围展示，但不参与比较）
        nonComparableRows: nonComparableRows.map(r => ({
          brandId: r.brandId, competitorId: r.competitorId, name: r.name, productCount: r.productCount,
          currencyStatus: r.currencyStatus,
          note: r.currencyStatus === 'mixed' ? '该品牌商品标注了多种币种，价格比较不可用' : '该品牌商品未标注明确币种，价格比较不可用',
        })),
        limits: priceDimension.limits,
      },
      matrixDensity: {
        available: priceRows.filter(r => r.productCount != null).length > 0,
        rows: priceRows.filter(r => r.productCount != null),
        medianProductCount: (() => {
          const cs = priceRows.filter(r => r.productCount != null).map(r => r.productCount).sort((a, b) => a - b);
          return medianOfSorted(cs);
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
        ratedObjects: reviewRows.filter(r => r.ratedPages > 0).length,
        limits: reviewDimension.limits,
      },
      satisfactionScatter,
    },
    opportunities: opportunities.slice(0, 24),
    summary: {
      usableDimensionCodes: usable.map(d => d.code),
      unavailableDimensionCodes: missing.map(d => d.code),
      missingDimensionCodes: missing.map(d => d.code),
      usableDimensionCount: usable.length,
      missingDimensionCount: missing.length,
      brandCount: brands.length,
      brandsWithData: brands.filter(b => b.facts.products || b.facts.catalog).length,
      opportunityCount: opportunities.length,
      // 前端据此判断是否有实质内容（避免笼统「暂无数据」）
      hasAnalysis: priceGroups.length > 0 || priceRows.some(r => r.productCount != null) || opportunities.length > 0,
    },
  };
}

module.exports = {
  buildOpportunityFoundation,
  SATISFACTION_MIN_OBJECTS: ScatterGate.MIN_OBJECTS,
  PRICE_BANDS: priceBandsFor('USD'),
  BAND_EDGES,
  CURRENCY_SYMBOLS,
  currencySymbol,
  isIsoCurrency,
  currencyStatusOf,
  priceBandsFor,
  LIVE_STATE_TEXT,
};
