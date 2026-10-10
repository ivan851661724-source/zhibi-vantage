'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/enrich.js —— 导出: getQ, buildResearchQueue, enqueueResearch, ensureQueue, runQueue, sleep, CHANNEL_LINK, deepResearchOne, lookupBrand, enrichOne, crossValidateTearing, enforceBasisEvidence, runTerminalStatus
// ============================================================

const { loadState, mirrorProjectToDb, newProjectId, resolveTenantId, saveState, setCurrentId } = require('../core/state-store.js');
const { requestScope } = require('../core/als.js');
const VC = require('../lib/voice-collector.js');
const voiceStore = require('./voice-store.js');
const { multiSourceSearch, recordProbeHealth, searchProvider } = require('./search.js');
const { deepseekJSON, llmApiKey } = require('./llm.js');
const { domainOf, fetchPage, fetchShopifyProducts, fetchShopifyCollections } = require('./net.js');
const S2Match = require('../lib/s2-match.js');
const { belongsToBrand, deriveBasis, sourceTier } = require('./evidence.js');
const { CHANNELS, COLLAB_TYPES, CONTENT_FORMS, FULFILLMENT, PRICE_BANDS, REGIONS, SELLING_POINTS, TACTICS, curSym, detectCurrency, fmtMoney, marketCurrency, normalizeIntent, resolvePlatforms } = require('./vocab.js');
const { scoreConfidence } = require('./corrections.js');
const { logAttempt } = require('./attempts.js');
const { normName, slug } = require('./candidates.js');
const { normalizeCustomization, parseGradedList } = require('./deepdive.js');
const { computeWhiteSpace } = require('./whitespace.js');
const Guard = require('../lib/inference-guard.js');
const M = require('../lib/metrics.js');
const PriceStats = require('../lib/price-stats.js');
const PF = require('../lib/price-forensics.js');
const Sizing = require('../lib/sizing.js');
const Tasks = require('../services/tasks.js');
const db = require('../services/db.js');
const { glFromRegions } = require('../services/providers/search.js');
const { buildPriceField, parsePriceRange } = require('../lib/pricefield.js');
const { autoExcludeOwnBrands } = require('../lib/own-brand.js');
const { channelTypeOf } = require('../lib/blue-ocean.js');
const { GROWTH_VALUES } = require('../lib/trend.js');
const Telemetry = require('../observability/telemetry.js'); // Phase 1 真实基线：阶段度量

// ============================================================
// 步骤2：逐家深研（后台队列 + 全字段）
// ============================================================
// 按项目隔离的研究队列（P0-1 修复）：每个 projectId 一份 {queue, running, researching}，
// 杜绝「全局队列被二次 discover 整体覆盖、抹掉前一次待深研任务」的缺陷。
const researchQueues = new Map(); // projectId -> { queue:[{id,priority}], running:bool, researching:Set }
const CONCURRENCY = 3;
function getQ(pid) {
  let q = researchQueues.get(pid);
  if (!q) { q = { queue: [], running: false, researching: new Set() }; researchQueues.set(pid, q); }
  return q;
}

// 仅构建本项目队列（不触发调度），便于隔离与测试
// 模块 0-4：同步落 research_tasks 表（幂等：同竞品已存在 pending/running 任务则跳过）——
// 深研中断重启后由 tasks 表自动续跑（断点续跑），不再只活在内存 Map。
function buildResearchQueue(state) {
  const sorted = state.competitors.slice().sort((a, b) => b.rankScore - a.rankScore);
  const topK = sorted.slice(0, 8);
  const rest = sorted.slice(8);
  const q = getQ(state.projectId);
  q.enqueuedAt = Date.now(); // Phase 1 可观测性：排队等待计时起点
  q.queue = [
    ...topK.map(c => ({ id: c.id, priority: 2 })),
    ...rest.map(c => ({ id: c.id, priority: 1 }))
  ];
  try {
    q.queue.forEach(job => Tasks.enqueue({
      tenantId: state.tenantId, projectId: state.projectId, type: 'deep-research',
      payload: { competitorId: job.id }, priority: job.priority,
    }));
  } catch (e) { /* 任务表不可用不影响研究主链路（非致命） */ }
  return q;
}

function enqueueResearch(state, config) {
  buildResearchQueue(state);
  runQueue(state, config);
}

function ensureQueue(state, config) { const q = getQ(state.projectId); if (!q.running) runQueue(state, config); }

// 第三轮整改 §二：一次 discover run 的终态聚合（纯函数，可测）。
// outcomes = 属于本次 runId 的每个任务的成功布尔（按完成顺序）。
//   全部成功（含空数组=本次无事可做）→ 'ok'；
//   部分成功 → 'degraded'（不计入成功率，产 milestone_all_processed 而非 all_done）；
//   全部失败 → 'error'。
// 铁律：只按属于当前 runId 的任务结果计算——项目里历史遗留的 error 品牌绝不参与；
//       用户点卡独立重研（payload.runId 独立）有自己的 begin/end，同样不参与。
function runTerminalStatus(outcomes) {
  const o = Array.isArray(outcomes) ? outcomes : [];
  if (o.length === 0) return 'ok';
  if (o.some(s => !s)) return o.some(Boolean) ? 'degraded' : 'error';
  return 'ok';
}

async function runQueue(state, config, opts) {
  const q = getQ(state.projectId);
  if (q.running) return;
  q.running = true;
  // 第三轮整改 §二：按属于本次 runId 的任务收集结局（成功=true/失败=false）；
  // _jobOwnRun（独立点卡重研）不收集——它有自己的 run 终态，绝不污染 discover run。
  const _outcomes = [];
  // 测试接缝（第三轮整改 §二）：可注入 deepResearchOne 替身，其余行为不变
  const _deepResearchOne = (opts && typeof opts.deepResearchOneFn === 'function') ? opts.deepResearchOneFn : deepResearchOne;
  try {
    // 模块 0-4：先回收崩溃遗留（running 且租期过期 → pending，kill -9 后断点续跑）
    try { Tasks.reclaimExpired(Date.now()); } catch (e) { /* 非致命 */ }
    while (true) {
      // 从 tasks 表原子认领本项目任务（仅 pending 或过期 running；priority 高者先）
      let job = null;
      try { job = Tasks.claim(state.projectId, 'srv-' + state.projectId, Date.now()); } catch (e) { /* 非致命 */ }
      if (!job) break;
      let payload = {};
      try { payload = JSON.parse(job.payload || '{}'); } catch (e) { /* payload 解析失败按空处理 */ }
      if (q.researching.has(job.id)) continue;
      const comp = state.competitors.find(c => c.id === payload.competitorId);
      if (!comp || comp.status === 'done') {
        try { Tasks.finish(job.id, job.claimToken, 'done', 'skipped'); } catch (e) { /* 非致命 */ }
        continue;
      }
      q.researching.add(job.id);
      const _queueWaitMs = Date.now() - (q.enqueuedAt || Date.now()); // Phase 1：入队 → 开始深研
      // 审核整改 §一：runId 归属——discover 后台深研沿用 state.runId（同一次完整调研）；
      // 用户点卡重新执行（payload.runId 独立生成）则按独立 run 记账（begin/end 全程同一 runId）
      const _jobOwnRun = typeof payload.runId === 'string' && payload.runId && payload.runId !== state.runId;
      const _jobRunId = _jobOwnRun ? payload.runId : (state.runId || null);
      if (_jobOwnRun) Telemetry.beginRun({ runId: _jobRunId, tenantId: state.tenantId, projectId: state.projectId });
      // 心跳续租（修复：此前 heartbeat 零调用，超过 60s 的任务会被 reclaimExpired 翻回
      // pending 被再次认领，与原执行并发重复跑、双倍 LLM/搜索扣费）
      const hb = setInterval(() => { try { Tasks.heartbeat(job.id, job.claimToken, Date.now()); } catch (e) { /* 非致命 */ } }, 20000);
      try {
        // Phase 1 可观测性：运行上下文包裹（深层 search/LLM 调用归因到本次运行）
        await Telemetry.withRun({ runId: _jobRunId, tenantId: state.tenantId, projectId: state.projectId },
          () => _deepResearchOne(comp, state, config, _jobRunId));
        try { Tasks.finish(job.id, job.claimToken, 'done'); } catch (e) { /* 非致命 */ }
      } catch (e) {
        comp.status = 'error';
        comp.evidence = '深研失败：' + String(e.message || e);
        try { Tasks.finish(job.id, job.claimToken, 'error', String(e.message || e)); } catch (e2) { /* 非致命 */ }
      } finally {
        clearInterval(hb);
        q.researching.delete(job.id);
        comp.researchedAt = new Date().toISOString();
        state.progress.done = state.competitors.filter(c => c.status === 'done').length;
        saveState(state);
        // Phase 1 可观测性：排队等待时长（每竞争品牌一行）+ 首批结果里程碑
        Telemetry.recordStage({ runId: _jobRunId, tenantId: state.tenantId, projectId: state.projectId,
          stage: 'competitor_queue_wait', durationMs: _queueWaitMs, status: comp.status === 'done' ? 'ok' : 'error' });
        if (comp.status === 'done' && state.progress.done === 1) {
          Telemetry.milestone(state.runId, 'milestone_first_batch', { tenantId: state.tenantId });
        }
        // 审核整改 §一/§二：独立重研 run 的终点（成功→ok；失败→error，绝不产生 all_done）
        if (_jobOwnRun) Telemetry.endRun(_jobRunId, comp.status === 'done' ? 'ok' : 'error', comp.status === 'done' ? undefined : 'RESEARCH_FAILED');
        // 第三轮整改 §二：仅统计属于 discover run（state.runId）的任务结局；独立重研不参与
        if (!_jobOwnRun) _outcomes.push(comp.status === 'done');
      }
      await sleep(150);
    }
  } finally {
    q.running = false;
    q.queue = []; // 内存队列已被 tasks 表接管消费，消费完置空
    // 第三轮整改 §二：discover run 终态按本次 runId 所属任务聚合——
    //   全部成功 → ok（milestone_all_done）；部分失败 → degraded（milestone_all_processed，
    //   不计入成功率）；全部失败 → error；任一非 ok 终态绝不产生 milestone_all_done。
    //   历史遗留 error 品牌（非本次 run 认领）绝不影响本判断；独立点卡重研不参与。
    if (state.runId) {
      const _terminal = runTerminalStatus(_outcomes);
      Telemetry.endRun(state.runId, _terminal, _terminal === 'error' ? 'RESEARCH_FAILED' : undefined);
    }
    // 在研集空 → 回收 Map 条目，避免无限增长
    if (q.researching.size === 0) researchQueues.delete(state.projectId);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// 平台店铺链接特征（渠道判定用，代码裁决不交给 LLM）
const CHANNEL_LINK = {
  tiktokShop: /tiktok\.com\/@[\w.-]+/i,
  etsy: /etsy\.com\/shop\/[\w-]+/i,
  amazon: /amazon\.[a-z.]+\/(stores?|shops)\//i,
  xiaohongshu: /xiaohongshu\.com\/(user\/profile|shop)\/[\w]+/i,
  instagramShop: /instagram\.com\/[\w.]+/i,
  tmallJD: /(tmall\.com\/shop\/\d+|jd\.com\/(?:[\w-]+\/?))/i,
  shopifyDTC: /myshopify\.com/i
};
// 深研 v2：证据链驱动 —— L2意图查询 + L3抓取正文/结构化价格 + L4锚点消歧 + L5置信度代码推导
async function deepResearchOne(comp, state, config, runIdOverride) {
  // 审核整改 §一：阶段度量归因 runId——用户点卡重新执行（enrichOne 独立 run）时用
  // 覆盖参数；否则沿用 state.runId（discover 创建的 run）。legacy state 无 runId → null。
  const _telemetryRunId = runIdOverride || state.runId || null;
  const dsKey = llmApiKey(config);
  comp.status = 'researching';
  saveState(state);
  const gl = glFromRegions(state.intent && state.intent.regions);
  const sProvider = (config.search && config.search.provider) || 'search';

  // ---- 本品牌证据库 ----
  const evidences = [];
  const addEv = (url, kind, title, excerpt, anchorDomain) => {
    if (!url || !/^https?:/i.test(url)) return null;
    const ex = evidences.find(e => e.url === url);
    if (ex) return ex;
    const tier = sourceTier(url, anchorDomain);
    if (tier === 3) return null; // 三级 SEO 聚合：不入库
    const e = { id: 'E' + (evidences.length + 1), url, tier, kind, title: String(title || '').slice(0, 120), excerpt: String(excerpt || '').slice(0, 280) };
    evidences.push(e);
    return e;
  };

  // ---- L4 锚点：先锁定官网域名 ----
  let anchorDomain = domainOf(comp.url);
  if (!anchorDomain) {
    try {
      const r0 = await multiSourceSearch(`"${comp.name}" official website brand`, config, gl);
      // 多源三角验证：≥2 源一致指向同一官网域名时，锚点 basis 升级为 verified（否则保持 inferred）
      comp.anchorBasis = r0._basis === 'verified' ? 'verified' : 'inferred';
      const hit = (r0.results || []).find(x => belongsToBrand(x, comp.name, '') && sourceTier(x.url, '') !== 3 && !/reddit\.|wikipedia\.|facebook\.|instagram\.|tiktok\.|amazon\.|etsy\./i.test(x.url || ''));
      logAttempt(comp, 'anchor', `"${comp.name}" official website brand`, sProvider, !!hit, hit ? '命中官网候选' : '未命中官网候选');
      if (hit) { comp.url = hit.url; anchorDomain = domainOf(hit.url); }
    } catch (e) {
      logAttempt(comp, 'anchor', `"${comp.name}" official website brand`, sProvider, null, '锚点检索异常：' + String(e.message || e));
    }
  }

  // ---- L3 抓取层：官网正文 + Shopify 结构化价格（verified 级证据） ----
  let officialPage = { ok: false }, shopify = { ok: false }, officialEv = null;
  if (comp.url) {
    const _tFetch = Date.now();
    [officialPage, shopify] = await Promise.all([fetchPage(comp.url), fetchShopifyProducts(comp.url)]);
    Telemetry.recordStage({ runId: _telemetryRunId, tenantId: state.tenantId, projectId: state.projectId,
      stage: 'site_shopify_fetch', durationMs: Date.now() - _tFetch,
      status: officialPage.ok || shopify.ok ? 'ok' : 'error', provider: 'official+shopify' });
  }
  if (officialPage.ok) officialEv = addEv(comp.url, 'official', comp.name + ' 官网正文', officialPage.text.slice(0, 280), anchorDomain);
  logAttempt(comp, 'official', comp.url || '(无官网URL)', 'official', officialPage.ok, officialPage.ok ? '官网正文抓取成功' : (comp.url ? '官网抓取失败/不可达' : '无官网URL，跳过'));

  // ---- 币种裁决：优先探测该品牌站点自己的结算币种，探不到才按目标市场假定并明确标注 ----
  const mktCur = marketCurrency(state.intent && state.intent.regions);
  const detectedCur = officialPage.ok ? detectCurrency(officialPage.htmlLower) : null;
  comp.currency = detectedCur || mktCur;
  comp.currencyBasis = detectedCur ? 'detected' : 'assumed'; // assumed = 未探测到，按市场默认，前端须标出

  comp.priceVerified = false;
  comp.freebies = [];        // 重研残留清除（shopify.ok 时下方重填；此前上一轮的免费品清单会跨轮残留）
  comp.priceStats = null;    // 同上：客单价三件套按本轮实抓重算
  comp.priceVerdict = null;  // S3 判定同步重算
  comp.soldOutCount = 0;     // 断货信号数据基础（规格 5.2；事件滞回逻辑后续接入）
  comp.typeDist = null;      // S2 类目占比数据基础（结构化，替代 LLM 猜的前置）
  comp.s2Match = null;       // S2 结构化匹配分（本轮实抓重算）
  comp.shopifyCollections = null;
  comp.shopCurrency = null;      // 重研残留清除：本轮 shopify 抓取失败时不得残留上一轮的店铺币种
  comp.shopifyTruncated = false; // 同上
  comp.adLibrary = null;     // Meta 广告库（本轮重取；token 未配置保持 null = 未探测）
  comp.adCreatives = null;   // S-D 广告主推信号（hero-product 消费），随广告库重取
  let shopifyEv = null;
  if (shopify.ok) {
    // ▶ 报告-数据同源 §5：价格点前置过滤 $0 —— 免费品/赠品/错误条目不进价格点，
    // 单列 comp.freebies（不参与价格带聚合），避免 $0 脏值污染"全价格带覆盖"结论。
    // 注意先取整再过滤：$0.49 这类小额价"先滤后取整"会归 0 漏进价格带下限。
    // 已下架/全变体不可售不计入客单价口径（规格 §四 #1：不卖的东西不构成客单价），单记 soldOutCount。
    const onSaleItems = shopify.items.filter(x => !x.soldOut);
    comp.soldOutCount = shopify.items.length - onSaleItems.length;
    const rawPts = onSaleItems.map(x => x.minPrice).filter(n => n != null);
    comp.freebies = Array.from(new Set(shopify.items.filter(x => x.minPrice === 0).map(x => x.title || '免费/赠品').filter(Boolean))).slice(0, 20);
    // ▶ 币种守卫（Ovalware 实证）：products.json 价格以店铺结账币种计且不带币种字段，
    // 店铺币种 ≠ 市场币种（如日销店 ¥800 被当 $800）时无汇率源不换算 → 实抓价格不入带，
    // 渠道证据（shopifyDTC 在售正证据）与款数保留，价格诚实降级回 LLM/官网正文路径。
    // compCur = 本竞品裁决币种（detected 优先，assumed 兜底），与外层市场币种 mktCur 语义不同。
    const shopCur = String(shopify.currency || '').toUpperCase();
    const compCur = String(comp.currency || '').toUpperCase();
    comp.shopCurrency = shopCur || null;
    if (shopCur && compCur && shopCur !== compCur) {
      comp.pricePoints = [];
      comp.currencyMismatch = shopCur;
      logAttempt(comp, 'shopify-currency', shopify.url, 'shopify', false, `店铺币种 ${shopCur} ≠ 市场币种 ${compCur}，实抓价格不换算不入带（价格降级回推断路径）`);
    } else {
      comp.currencyMismatch = null; // 重研残留清除：币种判定翻转时旧的不匹配标记不得残留
      comp.pricePoints = Array.from(new Set(rawPts.map(n => Math.round(n)).filter(n => n > 0))).sort((a, b) => a - b).slice(0, 40);
      if (!shopCur) {
        // 守卫盲区可见化：cart.js 不可达 → 店铺币种未探出，守卫失效（fail-open）。
        // 价格按 compCur 计（官网探测或市场假定），错币种风险靠 currencyBasis 标注兜底。
        logAttempt(comp, 'shopify-currency', shopify.url, 'shopify', null, `店铺币种未探出（cart.js 不可达），币种守卫盲区：价格按 ${compCur || '?'} 计（${comp.currencyBasis === 'detected' ? '官网探测' : '市场假定'}）`);
      }
    }
    comp.priceVerified = comp.pricePoints.length > 0;

    // ▶ 客单价三件套 + S3 价格带判定（算法规格 20261003 §三）：中位数 + 主力带(P25-P75) + 样本明细。
    // repPrice=变体中位价（商品代表价）；P5/P95 双截尾带剔除明细；多峰无销量权重不裁决。
    // 统计币种 = 实抓币种（shopCur；币种不匹配时 median 仍是原币真实数字，verdict 按币种不一致拒绝裁决）。
    // 目标价 = 用户画像 intent.profile.priceBand（min=max=点值；币种跟随目标市场）。
    const _profile = (state.intent && state.intent.profile) || null;
    comp.priceStats = PriceStats.computePriceStats(shopify.items, {
      currency: shopCur || comp.currency,
      target: _profile && _profile.priceBand ? _profile.priceBand : null,
    });
    comp.priceVerdict = comp.priceStats.verdict;
    // 币种守卫盲区（店铺币种未探出）时判定建立在假定币种上，不得用于自动排除（防 Ovalware 场景误踢）
    if (!shopCur && comp.priceVerdict) comp.priceVerdict.pendingHuman = true;
    const _st = comp.priceStats;
    logAttempt(comp, 'price-stats', shopify.url, 'shopify', true,
      `客单价样本 ${_st.sample.used}/${_st.sample.onSale} 计入（剔除 ${_st.sample.dropped}，断货 ${_st.sample.soldOut}，免费 ${_st.sample.free}），` +
      `中位数 ${_st.median != null ? fmtMoney(_st.median, _st.currency || comp.currency) : 'n/a'}，主力带 ${_st.band ? `${fmtMoney(_st.band.min, _st.currency || comp.currency)}-${fmtMoney(_st.band.max, _st.currency || comp.currency)}` : 'n/a'}，` +
      `判定 ${_st.verdict.code}${_st.truncatedBy ? `（截尾 ${_st.truncatedBy}）` : ''}`);

    // ▶ S3 自动排除（规格 §二 最高硬要求）：判定明确错位（above/below、非演算降级、非部分重叠）
    // 且非用户手输品牌、未被用户赦免 → 进已剔除清单附原因（可申诉拉回；拉回后 userPardoned 生效不再重剔，
    // 该标记同时赦免 S2 杂货铺排除——用户拉回 = 对一切自动排除的人工赦免）。
    if (comp.priceVerdict && (comp.priceVerdict.code === 'above' || comp.priceVerdict.code === 'below') && !comp.priceVerdict.pendingHuman
        && comp.manual !== true && !comp.userPardoned) {
      if (!Array.isArray(state.excluded)) state.excluded = [];
      if (!state.excluded.includes(comp.id)) state.excluded.push(comp.id);
      state.excludedReasons = state.excludedReasons || {};
      state.excludedReasons[comp.id] = 'priceMismatch';
      logAttempt(comp, 's3-price-gate', comp.url || '', 'shopify', false, `S3 价格带准入：${comp.priceVerdict.note} → 自动进已剔除清单（原因 priceMismatch，可拉回赦免）`);
    }

    // ▶ B-5b（2026-09-12 任务书）规模信号接线：products.json 实抓成功 = 最强 Shopify 正证据 +
    // 真实在售款数（分页后趋近全量）。sizing.estimateScale 三输入之一（productCount）此前全仓零写入 → HHI 恒 0。
    comp.isShopify = true;              // 替代链接特征推断（shopifyDTC），实抓判定为准
    comp.productCount = shopify.total;  // 实抓款数（≤1000，truncated 标注超限）
    comp.shopifyTruncated = !!shopify.truncated;
    // ▶ S2 类目占比数据基础（规格 2.3/5.1）：product_type 结构化计数 + 未分类数（杂货铺判定/匹配分的前置）
    const _tc = {};
    shopify.items.forEach(x => { const t = String(x.type || '').trim(); if (t) _tc[t] = (_tc[t] || 0) + 1; });
    comp.typeDist = {
      total: shopify.items.length,
      unclassified: shopify.items.length - Object.values(_tc).reduce((a, b) => a + b, 0),
      items: Object.entries(_tc).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([type, n]) => ({ type, n }))
    };
    // ▶ S2 结构化匹配分（规格 5.1/§1.1：结构化数据算匹配分，不靠 LLM 猜）：
    // typeRatio×0.6 + titleHit×0.4；未分类>40% 标演算；杂货铺（类目≥3 且目标类目<40%）→ 自动排除。
    comp.s2Match = S2Match.computeS2Match(shopify.items, state.track);
    if (comp.s2Match) logAttempt(comp, 's2-match', shopify.url, 'shopify', true, comp.s2Match.note);
    if (comp.s2Match && comp.s2Match.groceryStore === true && comp.manual !== true && !comp.userPardoned) {
      if (!Array.isArray(state.excluded)) state.excluded = [];
      if (!state.excluded.includes(comp.id)) state.excluded.push(comp.id);
      state.excludedReasons = state.excludedReasons || {};
      // S3/S2 双闸同触：合并原因不覆盖（保留「价格也错位」的审计线索；前端暂不消费此字段）
      const _prevReason = state.excludedReasons[comp.id];
      state.excludedReasons[comp.id] = (_prevReason && _prevReason !== 'wrongSegment')
        ? _prevReason + '+wrongSegment' : 'wrongSegment';
      logAttempt(comp, 's2-grocery-gate', comp.url || '', 'shopify', false, `S2 杂货铺判定：类目 ${comp.s2Match.distinctTypes} 个、目标类目占比 ${(comp.s2Match.typeRatio * 100).toFixed(0)}% < 40% → 自动进已剔除清单（原因 wrongSegment，可拉回赦免）`);
    }
    shopifyEv = addEv(shopify.url, 'shopify', '官网结构化价格数据',
      comp.pricePoints.length ? `共${shopify.total}款，${fmtMoney(comp.pricePoints[0], comp.currency)}-${fmtMoney(comp.pricePoints[comp.pricePoints.length - 1], comp.currency)}`
        : (comp.currencyMismatch ? `共${shopify.total}款（店铺币种 ${shopCur}，价格未入带）` : `共${shopify.total}款${comp.freebies.length ? `（免费品 ${comp.freebies.length}）` : ''}`),
      anchorDomain);
  }
  logAttempt(comp, 'shopify', comp.url || '(无官网URL)', 'shopify', shopify.ok, shopify.ok ? `Shopify 结构化数据 ${shopify.total} 款` : (comp.url ? '未检出 Shopify products.json' : '无官网URL，跳过'));
  // /collections.json 店铺集合（S2 跨类目佐证）：与定向探测/LLM 重叠抓取，不增加串行延迟
  const collectionsP = shopify.ok ? fetchShopifyCollections(comp.url).catch(() => null) : null;

  // ---- M0-02：Evidence 基础层接线（additive，不改 legacy 契约）----
  // 快照已落盘时，从快照 raw 原始字节确定性提取产品公开价格 Observation Evidence
  // （verified）；失败态快照 → unavailable Evidence（source failure ≠ no_change，
  // 00 §38）。best-effort：任何异常仅记运营错误，绝不影响 legacy 调研路径
  // （修正 9 兼容规则）。规格锚点：00 v1.2 §1.5/§2/§5/§26/§37/§38；05 v0.3.1 §10/§19.6；06 v0.3 Traceability。
  // P0-1（PR#5 评审）：不传 currency——cart.js 探测币种无快照背书，Evidence 币种
  // 恒 null（诚实缺失），cart.js 快照化属后续票。
  if (shopify.snapshotId && shopify._prov && shopify._prov.recorded) {
    try {
      const EvidenceExtract = require('./evidence-extract.js');
      const evRes = EvidenceExtract.extractShopifyPriceEvidence({
        tenantId: state.tenantId || undefined,   // 显式租户 > ALS 兜底（后台队列脱离请求上下文）
        snapshotId: shopify.snapshotId,
        entityRef: { brand_name: comp.name || null, domain: anchorDomain || null, source_url: shopify.url || null },
        projectRef: state.projectId || null,
      });
      if (evRes.ok) comp.evidenceExtract = { evidence_count: (evRes.evidence_ids || []).length, unavailable: !!evRes.unavailable, empty: !!evRes.empty, reason: null };
      else comp.evidenceExtract = { evidence_count: 0, unavailable: false, empty: false, reason: evRes.reason || null };
      // ---- M0-03：Fact 最小层接线（additive）----
      // verified 价格 Evidence → public_product_price Fact（值逐字继承自
      // Evidence，unavailable 不产 Fact——02 原则 4 unavailable≠0）。规格锚点：
      // 00 v1.2 §1.3/§5/§37/§50；02 v0.3 §1/§2.1；06 v0.3 Traceability。
      if (evRes.ok && evRes.evidence_ids && evRes.evidence_ids.length) {
        try {
          const FactStore = require('./fact-store.js');
          let factCount = 0;
          const newFactIds = [];
          for (const eid of evRes.evidence_ids) {
            const fr = FactStore.recordPriceFactFromEvidence({ tenantId: state.tenantId || undefined, evidenceId: eid });
            if (fr.recorded && !fr.duplicate) { factCount++; newFactIds.push(fr.meta.fact_id); }
          }
          // ---- M0-05：Diff → price_change_observed 检测接线（additive）----
          // 新 Fact 落盘后找同 entity 上一观察 → Diff；仅 changed Diff 产事件
          // （02 v0.3 §10.1）。规格锚点：00 v1.2 §37/§50；02 §10.1；06 Traceability。
          let eventCount = 0; let diffCount = 0; let detectReason = null;
          if (newFactIds.length) {
            try {
              const DomainEvent = require('./domain-event.js');
              for (const fid of newFactIds) {
                const dr = DomainEvent.detectPriceChangeFromFact({ tenantId: state.tenantId || undefined, factId: fid });
                if (dr.ok && dr.diff_id) diffCount++;
                if (dr.ok && dr.event_id) eventCount++;
                if (dr.ok && !dr.diff_id && dr.reason) detectReason = dr.reason; // no_previous_fact 等诚实记录
              }
            } catch (de) {
              try { require('../services/logger.js').error('event_detect_error', { competitor: comp.id, error: String((de && de.message) || de).slice(0, 200) }); } catch (_) {}
            }
          }
          comp.factExtract = { fact_count: factCount, evidence_count: evRes.evidence_ids.length, diff_count: diffCount, event_count: eventCount, detect_reason: detectReason, reason: null };
        } catch (fe) {
          comp.factExtract = { fact_count: 0, evidence_count: (evRes.evidence_ids || []).length, diff_count: 0, event_count: 0, detect_reason: null, reason: 'error' };
          try { require('../services/logger.js').error('fact_extract_error', { competitor: comp.id, error: String((fe && fe.message) || fe).slice(0, 200) }); } catch (_) {}
        }
      }
    } catch (e) {
      comp.evidenceExtract = { evidence_count: 0, unavailable: false, empty: false, reason: 'error' };
      logAttempt(comp, 'evidence', shopify.url || comp.url, 'shopify', false, 'Evidence 提取异常（不影响调研主链路）：' + String((e && e.message) || e).slice(0, 160));
      try { require('../services/logger.js').error('evidence_extract_error', { competitor: comp.id, snapshot_id: shopify.snapshotId, error: String((e && e.message) || e).slice(0, 200) }); } catch (_) {}
    }
  }

  // ---- L2 意图分型定向查询（渠道存在性 / 口碑 / 动作），并行 ----
  const probes = {
    etsy: `site:etsy.com/shop "${comp.name}"`,
    tiktokShop: `"${comp.name}" tiktok shop official`,
    amazon: `"${comp.name}" amazon official store`,
    xiaohongshu: `"${comp.name}" 小红书 官方`,
    instagramShop: `"${comp.name}" instagram official`,
    tmallJD: `"${comp.name}" 天猫 OR 京东 官方旗舰店`,
    offlineRetail: `"${comp.name}" 实体店 OR 线下门店 OR 百货`,
    reputation: `"${comp.name}" reviews reddit OR trustpilot complaints`,
    moves: `"${comp.name}" launch OR collab OR restock 2025 2026`
  };
  const probeRaw = {};
  const probeKeys = Object.keys(probes);
  const probeFails = []; // 探测失败的 key（异常/超时，已重试仍失败）
  const probeQuota = []; // 配额耗尽的 key（≠ 零命中：不得转成"确认缺席"负证据）
  // 信号量控制并发：复用 CONCURRENCY（原死变量）限制同时发起的搜索数，
  // 避免 9 路并发触发搜索 API 限流/超时导致批量失败（§1 根因）。
  let _pi = 0;
  const _tProbe = Date.now(); // Phase 1 可观测性：定向渠道探测段计时
  const probeWorker = async () => {
    while (_pi < probeKeys.length) {
      const k = probeKeys[_pi++];
      let lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) { // 失败重试 1 次
        try {
          const r = await searchProvider(probes[k], config, gl);
          if (r && r.error) {
            // error 哨兵（当前仅 quota，防御未来新增）≠ 搜索成功零命中：按"探测未完成"处理
            //（results 里的空数组会伪装成零命中，经负证据分支变成 verified 级"确认缺席"）。哨兵类不重试。
            probeRaw[k] = null; probeQuota.push(k);
            lastErr = null;
            break;
          }
          probeRaw[k] = (r && r.results) || [];
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt === 0) await new Promise(r => setTimeout(r, 300)); // 重试前短歇，错峰
        }
      }
      if (lastErr) { probeRaw[k] = null; probeFails.push(k); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, probeKeys.length) }, () => probeWorker()));
  Telemetry.recordStage({ runId: _telemetryRunId, tenantId: state.tenantId, projectId: state.projectId,
    stage: 'channel_probe', durationMs: Date.now() - _tProbe,
    status: probeFails.length ? 'partial' : 'ok', provider: (config.search && config.search.provider) || 'search' });
  // 记录每个定向探测的执行结果（hit 四态：true 命中 / false 真实零命中 / null 探测失败或 error 哨兵）
  probeKeys.forEach(k => {
    const raw = probeRaw[k];
    const hit = raw == null ? null : raw.length > 0;
    const reason = probeQuota.includes(k) ? '搜索返回错误哨兵（配额不足等），探测未执行（不等于零命中）'
      : raw == null ? '定向探测失败（搜索异常/超时，已重试1次仍失败）'
      : (raw.length ? `命中 ${raw.length} 条` : '定向探测执行成功但零命中');
    logAttempt(comp, 'probe.' + k, probes[k], sProvider, hit, reason);
  });
  // 失败可见性：聚合本次探测未完成率（失败+哨兵，不再静默）
  const probeIncomplete = probeFails.length + probeQuota.length;
  comp.probeHealth = recordProbeHealth(probeIncomplete, probeKeys.length) || { failed: probeIncomplete, total: probeKeys.length };
  if (probeFails.length) {
    console.warn(`[深研探测] ${comp.name}：定向探测失败 ${probeFails.length}/${probeKeys.length}（${probeFails.join(',')}）—— 渠道/口碑/雷达相关维度将缺证据`);
  }
  if (probeQuota.length) {
    console.warn(`[深研探测] ${comp.name}：${probeQuota.length} 路探测因搜索 error 哨兵未执行（${probeQuota.join(',')}，多为配额不足）—— 相关维度保持"未探测"，不会被判"确认缺席"`);
  }

  // 官方店铺硬标准：店铺 URL 路径或标题本身含品牌名（防止"第三方卖同款的店"被误判为品牌官方店）
  const brandKey = normName(comp.name);
  const isOwnShop = (x) => {
    if (!brandKey) return false;
    try {
      const u = new URL(x.url);
      if (normName(decodeURIComponent(u.pathname)).includes(brandKey)) return true;
    } catch {}
    return normName((x.title || '').split(/[-|–]/)[0]).includes(brandKey);
  };

  // ---- L4 消歧：只保留归属本品牌的结果，入证据库 ----
  const kept = {};
  Object.keys(probeRaw).forEach(k => {
    if (probeRaw[k] == null) { kept[k] = null; return; }
    kept[k] = probeRaw[k].filter(x => belongsToBrand(x, comp.name, anchorDomain));
    kept[k].slice(0, 4).forEach(x => {
      // 渠道探测命中的"店铺页"若非官方店（URL/标题不含品牌名）→ 第三方卖同款，不入证据库
      if (CHANNEL_LINK[k] && CHANNEL_LINK[k].test(x.url || '') && !isOwnShop(x)) return;
      addEv(x.url, k, x.title, x.content, anchorDomain);
    });
  });

  // ---- L5 平台渠道判定：正负证据两套规则，代码裁决 ----
  comp.fieldSources = {};
  const html = officialPage.ok ? officialPage.htmlLower : '';
  const judgeChannel = (chKey) => {
    // 线下零售：非 URL 渠道，靠门店页/检索命中，不能用链接特征判定
    if (chKey === 'offlineRetail') {
      const hits = (kept.offlineRetail || []).filter(x => isOwnShop(x) || /门店|实体店|线下|百货|线下店/i.test((x.title || '') + (x.content || '')));
      if (hits.length) {
        const ev = addEv(hits[0].url, 'offlineRetail', hits[0].title, hits[0].content, anchorDomain);
        if (ev) comp.fieldSources['channels.offlineRetail'] = [{ id: ev.id, url: ev.url, tier: ev.tier, kind: ev.kind, title: ev.title }];
        return { present: true, confidence: 'high', basis: 'verified', note: '检索命中官方线下门店信息', since: null };
      }
      if (html && /门店|实体店|线下|线下店|store locator|线下门店/i.test(html)) {
        if (officialEv) comp.fieldSources['channels.offlineRetail'] = [{ id: officialEv.id, url: officialEv.url, tier: 1, kind: 'official', title: officialEv.title }];
        return { present: true, confidence: 'high', basis: 'verified', note: '官网含门店/实体店信息', since: null };
      }
      if (kept.offlineRetail != null && officialPage.ok) {
        // 负证据必须建立在"真实执行且原始零命中"上：配额耗尽/失败已是 null 走不到这里；
        // 有结果但没匹配上门店特征 → 只是"未能识别"，不是"确认不存在"
        if ((probeRaw.offlineRetail || []).length > 0) {
          return { present: false, confidence: 'low', basis: 'unverified', note: '定向检索有结果但未命中官方门店信息，未能确认', since: null };
        }
        if (officialEv) comp.fieldSources['channels.offlineRetail'] = [{ id: officialEv.id, url: officialEv.url, tier: 1, kind: 'neg-check', title: '定向检索+官网双重核查' }];
        return { present: false, confidence: 'medium', basis: 'verified', note: '检索零命中且官网无门店信息 → 确认缺席', since: null };
      }
      // 两种"未完成"分开说（审计可辨）：搜索真实执行过但官网不可抓 vs 搜索本身失败/配额哨兵
      const searchedOffline = Array.isArray(probeRaw.offlineRetail);
      return { present: false, confidence: 'low', basis: 'unverified', note: searchedOffline
        ? '搜索已执行但官网不可抓，双重核查未完成，未能确认线下布局'
        : '未探测到线下布局（搜索失败或配额哨兵，或官网不可抓）', since: null };
    }
    const pat = CHANNEL_LINK[chKey];
    const hits = (kept[chKey] || []).filter(x => pat && pat.test(x.url || '') && isOwnShop(x));
    if (hits.length) { // 正证据1：定向检索命中官方店铺 URL
      const ev = addEv(hits[0].url, chKey, hits[0].title, hits[0].content, anchorDomain);
      if (ev) comp.fieldSources['channels.' + chKey] = [{ id: ev.id, url: ev.url, tier: ev.tier, kind: ev.kind, title: ev.title }];
      return { present: true, confidence: 'high', basis: 'verified', note: '定向检索命中官方店铺', since: null };
    }
    if (html && pat && pat.test(html)) { // 正证据2：官网页面含该平台入口链接
      if (officialEv) comp.fieldSources['channels.' + chKey] = [{ id: officialEv.id, url: officialEv.url, tier: 1, kind: 'official', title: officialEv.title }];
      return { present: true, confidence: 'high', basis: 'verified', note: '官网页面含该渠道入口链接', since: null };
    }
    // 负证据：定向查询真实执行（非配额/失败，那两类已是 null）且原始结果零命中 + 官网已抓取且无链接
    // → 才能标"确认缺席"。有结果但未见官方店 = 第三方售卖/命名差异，只是"未能识别"，不得确认缺席。
    if (kept[chKey] != null && officialPage.ok) {
      if ((probeRaw[chKey] || []).length > 0) {
        return { present: false, confidence: 'low', basis: 'unverified', note: '定向检索有结果但未见官方店铺/主页，未能确认（可能有第三方售卖或命名差异）', since: null };
      }
      if (officialEv) comp.fieldSources['channels.' + chKey] = [{ id: officialEv.id, url: officialEv.url, tier: 1, kind: 'neg-check', title: '定向检索+官网双重核查' }];
      return { present: false, confidence: 'medium', basis: 'verified', note: '定向检索零命中且官网无该渠道入口 → 确认缺席', since: null };
    }
    // 探测失败/配额哨兵或官网不可抓 → 只能标"未探测"（两种未完成原因分开说，审计可辨）
    const searched = Array.isArray(probeRaw[chKey]); // 搜索真实执行过（失败/哨兵时为 null）
    return { present: false, confidence: 'low', basis: 'unverified', note: searched
      ? `搜索已执行但官网不可抓，双重核查未完成（原始${(probeRaw[chKey] || []).length ? '有' : '零'}命中），不等于确认不做`
      : '定向探测未完成（搜索失败或配额哨兵），不等于确认不做', since: null };
  };
  const codedChannels = {};
  Object.keys(CHANNEL_LINK).forEach(chKey => { codedChannels[chKey] = judgeChannel(chKey); });
  // shopifyDTC：抓到 products.json 即为最强正证据（覆盖上面基于链接特征的推断）
  if (shopify.ok) {
    codedChannels.shopifyDTC = { present: true, confidence: 'high', basis: 'verified', note: 'Shopify 结构化商品数据可直接访问', since: null };
    if (shopifyEv) comp.fieldSources['channels.shopifyDTC'] = [{ id: shopifyEv.id, url: shopifyEv.url, tier: 1, kind: 'shopify', title: shopifyEv.title }];
  }
  // 线下零售：非 URL 渠道，单独裁决
  codedChannels.offlineRetail = judgeChannel('offlineRetail');

  // 收割集合清单（S2 佐证：集合数/跨类目信号）
  if (collectionsP) {
    try { const _col = await collectionsP; comp.shopifyCollections = (_col && _col.ok) ? _col.collections : null; } catch (e) { comp.shopifyCollections = null; }
  }

  // ▶ 广告投放情报（T0·Meta 广告库，抓取需求 §2.5 / 算法规格 §5.4）：官方 ads_archive，
  // token 未配置（NO_META_TOKEN）= 源未接入，静默保持未探测；检索失败记审计不阻断。
  // 命中时桥接 S-D 广告主推信号（§3.0.1）：在投创意的链接标题 = "广告在推的 SKU 名"。
  try {
    const MetaAds = require('../services/providers/meta-ads.js');
    const ads = await MetaAds.searchBrandAds(comp.name, config);
    if (ads.ok) {
      comp.adLibrary = ads;
      const titles = (ads.creatives || []).map(c => c.linkTitle).filter(Boolean);
      if (titles.length) comp.adCreatives = titles.slice(0, 4).map(n => ({ name: n }));
      logAttempt(comp, 'meta-ads', comp.url || '', 'meta', true, `广告库：在投 ${ads.activeCount}/${ads.totalInWindow} 条，最长 ${ads.longestDays} 天，平台 ${ads.platforms.length} 个，活跃度 ${ads.activityLevel}`);
    } else if (ads.error !== 'NO_META_TOKEN') {
      logAttempt(comp, 'meta-ads', comp.url || '', 'meta', false, '广告库检索失败：' + String(ads.error || '').slice(0, 120));
    }
  } catch (e) { /* 广告库失败不阻断深研主链路 */ }

  // ---- LLM 只负责"从证据里抽值"，置信度由证据类型推导 ----
  const evText = evidences.length
    ? evidences.map(e => `[${e.id}] (tier${e.tier}·${e.kind}) ${e.title} — ${e.url}\n${e.excerpt}`).join('\n\n')
    : '(本轮未获得任何可用证据)';
  // 平台集收缩：只抽取用户勾选的平台；未被 L2 预填(codedChannels)的才进 LLM schema
  const platforms = resolvePlatforms(state.intent);
  const scopeChannels = CHANNELS.filter(c => platforms.includes(c));
  const codedChannelsKeys = Object.keys(codedChannels || {});
  const restChannels = scopeChannels.filter(c => !codedChannelsKeys.includes(c));
  const sys = `你是"知彼 Vantage"。赛道："${state.track}"。对手："${comp.name}"（官网：${comp.url || '未知'}）。
下面给你一组【已编号证据】。你的任务是从证据中【抽取】字段值；证据不足时可用你的知识【推算】，但推算的字段 cite 必须为空数组（系统据此自动降级置信度）。
铁律：
- cite 数组只能引用真实存在的证据编号（如 "E2"）；严禁编造编号。
- 关键字段不允许留空：无证据也要推算出最可能的值（cite 留空即可）。
- sellingPoints 优先从受控词表多选；若该品牌有词表未覆盖的明显卖点，可补充自由词（英文小驼峰，如 veganFormula），但尽量优先用受控词。tactics 仍从受控词表多选。
- 严格区分两个轴：① 供给轴=品牌做了/宣称什么（sellingPoints/channels/customization/tactics/products）；② 需求轴=用户真实声音（reviews.posThemes/negThemes/painPoints）。机会判断须供需双侧交叉引用，严禁仅用供给矩阵替代需求侧——这是"忠实助理"推理纪律的硬约束。
- 渠道口径（重要）：transaction 渠道（amazon/shopifyDTC/tmallJD/etsy/offlineRetail）以"是否在售/有官方店"为准；content 渠道（如 xiaohongshu 小红书）是种草平台，品牌多无官方店但靠 KOL/笔记/软文做声量——无官方店≠空白，须用 seedingVolume(种草声量) 判断；hybrid 渠道（tiktokShop/instagramShop）两者都要填。本次只研究以下平台：${scopeChannels.join(', ')}。
严格输出 JSON：
{
 "channels": { ${scopeChannels.map(k => {
   const t = channelTypeOf(k);
   let shape;
   if (t === 'content') shape = `{present:bool(有无官方旗舰店/店铺), seedingVolume:"high|medium|low|none"(种草声量:该品牌在${k}上的笔记/测评/软文及KOL数量级), note:"依据一句话", cite:["E#"]}`;
   else if (t === 'hybrid') shape = `{present:bool(官方店/店铺), seedingVolume:"high|medium|low|none"(种草声量), note:"依据一句话", cite:["E#"]}`;
   else shape = `{present:bool, note:"依据一句话", cite:["E#"]}`;
   return `"${k}": ${shape}`;
 }).join(', ')} },
 "priceBand": {band:"${PRICE_BANDS.join('"|"')}", range:"用${comp.currency}原币种书写，如 ${curSym(comp.currency)}20-${curSym(comp.currency)}80。严禁做汇率换算", reasoning:"一句话", cite:[]},
 "pricePoints": [数字，${comp.currency} 原币种，不换算。仅当证据中出现具体标价时才填，否则空数组],
 "audiences": [目标人群自由文本，中英文皆可，如 "年轻妈妈" / "健身人群" / "职场新人"，尽量贴合该品牌实际受众],
 "regions": [∈ ${REGIONS.join(', ')}],
 "products": [该品牌实际经营的品类/产品词，自由文本，中英文皆可，如 "面部精华" / "运动水壶" / "宠物零食"，按赛道抽取，不必受限], // 旧版扁平兜底词（仅当下方结构化字段缺失时前端回退），不再作为矩阵/布局唯一来源
 "productMatrix": {skuCount:数字或null(估算SKU总数), priceBandDist:"价格带分布简述,如 $20-50 为主、少数 $80+", heroSku:["1-2个该品牌在当前赛道品类内的代表性爆款/主打SKU名，赛道外产品严禁选入（如赛道是冷萃壶就不选拌菜器）"], productLines:["产品线/系列名,如 基础款/联名款/节日限定"]}, // ▶ P2 #4 产品矩阵（纵向深度）：产品线内部结构，与品类布局数据源分离
 "categoryCoverage": [{"category":"市场品类(如 宠物服装)","subCategory":"子品类(如 雨衣)","count":数字或null(该品类下SKU数估算)}], // ▶ P2 #5 品类布局（横向广度）：跨品类覆盖，与产品矩阵数据源分离
 "reviews": {rating:数字或null, trend:"up"|"flat"|"down", posThemes:[], negThemes:[], reasoning:"", cite:[]}, // 需求轴：posThemes/negThemes 必须真实来自用户声音，严禁用品牌自述替代
 "reviewSnippets":[{"platform":"Trustpilot|Reddit|Amazon|Etsy|其他", "rating":数字或null, "sampleSize":数字或null, "url":"该条口碑/评论聚合页的原始链接(必须真实可点，无法确认则填空字符串)", "text":"一句代表性的用户原声(≤80字)", "sentiment":"pos"|"neg"|"neu"}], // ▶ P1 #7：每条带 url；无 url 不入库展示；评分带样本量
 "positioning": {valueProposition:"价值主张(一句话:它说自己是干嘛的)", targetAudience:"目标人群(面向谁)", pricePosition:"价格定位(高/中/低 + 与赛道均值对比,如 中端偏高)", differentiation:"差异化卖点(区别于对手的核心点)", cite:[]}, // ▶ P2 #8 定位战略（结构化·品牌自称 claim；basis=verified 仅当证据 tier-1 实抓）
 "customization": {score:数字(0-100，该品牌产品「可定制/按需定制/个性化」的程度：越高=越按需定制/个性化，越低=越标品化), note:"依据一句话", cite:[]},
 "estSize": {value:"估算规模区间，不留空", cite:[]},
 "tier": "large|mid|small|emerging",
 "techStack": "建站平台/技术栈（可推算）",
 "recentMoves": [{type:"launch"|"channel"|"price"|"collab", desc:"", when:"", cite:[]}],
 "contentForms": [∈ ${CONTENT_FORMS.join(', ')}],
 "collabTypes": [∈ ${COLLAB_TYPES.join(', ')}],
 "fulfillment": [∈ ${FULFILLMENT.join(', ')}],
 "sellingPoints": [该品牌实际主打的卖点，优先从受控词多选；如有明显卖点不在词表中，可补自由词。每项格式 {point:卖点词, basis:"claimed|verified", cite:["E#"]}：claimed=仅营销文案/官网宣称；verified=产品实测/用户证言/第三方评测确认实际具备],
 "tactics": [该品牌实际采用的销售打法，多选。每项格式 {tactic:打法词, demandEvidence:"present|absent|unknown", cite:["E#"]}：demandEvidence=用户是否表达想要该策略/竞品因缺它而流失；无任何需求侧证据时填 unknown],
 "painPoints": [{point:"用户抱怨点(中文短语,尽量通用化表述)", cite:[]}],
 "foundedYear": {year:数字或null(品牌成立年份，可推算，cite留空), cite:[]},
 "growth": {value:"rising|stable|declining|unknown"(基于公开信号推算的增长态势：rising=扩张/上新加速/声量上升；stable=平稳；declining=收缩/关店/声量下滑；unknown=无足够信号), cite:[]},
 "demandAlignments": [{theme:"需求主题(中文短语,来自 reviews.posThemes/negThemes/painPoints 中值得关注的一条)", buckets:[卖点key(从受控词表选: ${SELLING_POINTS.join(', ')}], reason:"一句话依据"}]（第三层语义召回：捕捉字面不匹配但语义相关的需求——如用户说"想要像我家狗那样的熊"→对应 customization；仅列确有语义关联的项；无则空数组）,
 "evidence": "来源摘要1-2句"
}`;
  const user = `【已编号证据】\n${evText}\n\n用户意图：${JSON.stringify(state.intent || {})}。请抽取并填表。`;
  const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'deep-research', competitorId: comp.id, thinking: false });

  // ---- 合并：置信度由 deriveBasis 从引用证据推导，LLM 无权自评 ----
  const _tMerge = Date.now(); // Phase 1 可观测性：字段合并 + 引用复核段计时（含复核 LLM 调用）
  const citedEvs = (cites) => (Array.isArray(cites) ? cites : []).map(id => evidences.find(e => e.id === id)).filter(Boolean);
  const citeAudit = []; // verified 字段的引用复核清单：值必须真出自所引证据（见下方批量复核）
  const applyBasis = (obj, cites, fieldName) => {
    const evs = citedEvs(cites);
    const d = deriveBasis(evs);
    obj.basis = evs.length ? d.basis : 'unverified'; // 无引用 = 未探测（对齐 deriveBasis 空值语义，纯猜测不再记为 inferred）
    obj.confidence = evs.length ? d.confidence : 'low';
    if (evs.length) comp.fieldSources[fieldName] = evs.map(e => ({ id: e.id, url: e.url, tier: e.tier, kind: e.kind, title: e.title }));
    // verified 字段登记引用复核；{v:1} 占位对象仅用于取 basis（positioning/customization 等），不承载值，跳过
    if (obj.basis === 'verified' && obj.v === undefined) citeAudit.push({ fieldName, obj, evs });
    return obj;
  };
  const fieldConfs = [];
  const ch = {};
  // 只解析用户勾选的平台；content/hybrid 渠道抓取种草声量 seedingVolume
  scopeChannels.forEach(k => {
    if (codedChannels[k]) { ch[k] = codedChannels[k]; fieldConfs.push(codedChannels[k].confidence); return; }
    if (j.channels && j.channels[k]) {
      const cc = j.channels[k];
      const rec = applyBasis({ present: !!cc.present, note: cc.note || '', since: null, seedingVolume: cc.seedingVolume || null }, cc.cite, 'channels.' + k);
      // LLM 推算的"缺席"永远只能是未探测，不能算确认缺席
      if (!rec.present && rec.basis !== 'verified') rec.basis = 'unverified';
      ch[k] = rec;
      fieldConfs.push(rec.confidence);
    }
  });
  comp.channels = ch;

  // ---- 品类布局（横向广度）兜底扁平词：仅当结构化 categoryCoverage 缺失时前端回退 ----
  // 注意：不再 comp.products = comp.categories —— 矩阵(纵向深度)与布局(横向广度)数据源分离（PRD整改 #5）。
  // #311：legacy 兜底数组 c.categories 不再从 j.products 复制——否则与产品矩阵(c.products)同源重复、前端双渲染。
  //        结构化布局以 comp.categoryCoverage 为准；legacy 兜底数组置空，避免数据冗余（同源只留其一）。
  comp.categories = [];

  comp.priceBand = j.priceBand ? applyBasis({ band: j.priceBand.band, range: j.priceBand.range || '', reasoning: j.priceBand.reasoning || '' }, j.priceBand.cite, 'priceBand') : null;
  // Shopify 实价覆盖：价格字段升级为 verified
  if (comp.priceVerified && comp.priceBand && shopifyEv) {
    comp.priceBand.basis = 'verified'; comp.priceBand.confidence = 'high';
    comp.priceBand.range = `${fmtMoney(Math.min(...comp.pricePoints), comp.currency)}-${fmtMoney(Math.max(...comp.pricePoints), comp.currency)}（实抓）`;
    // ▶ B-5c（2026-09-12 任务书）：verified 路径补数值 mid（客单价点值）。
    // 算法规格 §三：客单价 = 截尾后样本中位数（均值/minmax 均值都会被 $1 挂件与 $500 礼盒拉歪）；
    // priceStats 不可得时退化为 min-max 均值（诚实降级，仍有值）。
    // LLM inferred 路径不写 mid（诚实纪律：无实抓不算数）。
    if (comp.pricePoints.length) {
      comp.priceBand.mid = (comp.priceStats && comp.priceStats.median != null)
        ? comp.priceStats.median
        : (Math.min(...comp.pricePoints) + Math.max(...comp.pricePoints)) / 2;
    }
    comp.fieldSources.priceBand = [{ id: shopifyEv.id, url: shopifyEv.url, tier: 1, kind: 'shopify', title: shopifyEv.title }];
  } else if (!comp.priceVerified) {
    comp.pricePoints = (Array.isArray(j.pricePoints) ? j.pricePoints : []).filter(n => typeof n === 'number' && n > 0).slice(0, 40);
  }
  if (comp.priceBand) fieldConfs.push(comp.priceBand.confidence);

  // ---- 价格字段「值级交叉验证裁决」接入（护城河本体）----
  comp.priceClaims = [];
  if (comp.priceVerified && shopifyEv && comp.pricePoints.length) {
    comp.priceClaims.push({ tier: 1, kind: 'shopify', value: [Math.min(...comp.pricePoints), Math.max(...comp.pricePoints)], url: shopifyEv.url, text: `实抓 ${comp.pricePoints.length} 款`, points: comp.pricePoints.slice() });
  }
  if (j.priceBand && j.priceBand.range) {
    const pv = parsePriceRange(j.priceBand.range, comp.currency);
    const cited = Array.isArray(j.priceBand.cite) && j.priceBand.cite.length;
    const srcUrl = cited ? ((evidences.find(e => e.id === j.priceBand.cite[0]) || {}).url || null) : null;
    comp.priceClaims.push({ tier: cited ? 2 : 3, kind: cited ? 'llm-band' : 'llm-guess', value: pv, url: srcUrl, text: j.priceBand.range });
  }
  if (!comp.priceVerified && Array.isArray(j.pricePoints)) {
    const pts = j.pricePoints.filter(n => typeof n === 'number' && n > 0);
    if (pts.length) comp.priceClaims.push({ tier: 3, kind: 'llm-guess', value: [Math.min(...pts), Math.max(...pts)], url: null, text: 'LLM 价格点推算' });
  }
  const priceCorr = (state.fieldCorrections || []).filter(c => c.competitorId === comp.id && c.field === 'price');
  comp.priceField = buildPriceField(comp.priceClaims, { currency: comp.currency, corrections: priceCorr });

  // ▶ P0 #2 L2 取证：非 Shopify 站点，官网正文出现标价 → 主动抠出并携 URL（带源可核验）。
  // 仅在 LLM 未给价格点，或官网提取与 LLM 量级不冲突时采用，避免覆盖更可靠的 LLM 结论。
  if (!comp.priceVerified && officialPage && officialPage.ok) {
    try {
      const _fp = PF.extractPrices((officialPage.text || '') + ' ' + (officialPage.htmlLower || ''), comp.currency);
      if (_fp.length) {
        const _pts = PF.toPricePoints(_fp, 40);
        const _llm = (comp.pricePoints || []).filter(n => typeof n === 'number' && n > 0);
        const _use = _llm.length === 0
          || (_pts.length && Math.min.apply(null, _pts) <= Math.max.apply(null, _llm.concat([1])) * 50
                          && Math.max.apply(null, _pts) >= Math.min.apply(null, _llm.concat([1e9])) / 50);
        if (_use) {
          comp.pricePoints = _pts;
          comp.priceClaims.push({ tier: 1, kind: 'official-text', value: [Math.min.apply(null, _pts), Math.max.apply(null, _pts)], url: officialPage.url || comp.url, text: `官网正文提取 ${_pts.length} 个标价`, points: _pts.slice() });
          comp.priceForensic = 'official-text';
        }
        logAttempt(comp, 'priceForensic', officialPage.url || comp.url, 'official', true, `官网正文提取到 ${_fp.length} 个标价候选${_use ? '（已采用）' : '（与 LLM 量级冲突，未采用）'}`);
      } else {
        logAttempt(comp, 'priceForensic', officialPage.url || comp.url, 'official', false, '官网正文未检出明确标价');
      }
    } catch (e) {
      logAttempt(comp, 'priceForensic', officialPage.url || comp.url, 'official', false, '官网正文价格提取异常：' + (e && e.message || e));
    }
  }

  comp.audiences = Array.isArray(j.audiences) ? j.audiences : [];
  comp.regions = Array.isArray(j.regions) ? j.regions : [];
  comp.products = Array.isArray(j.products) ? j.products : [];
  // ▶ P2 #4 产品矩阵（纵向深度）：产品线内部结构（SKU 数 / 价格带分布 / 爆款 / 产品线），与品类布局数据源分离。
  const pm = (j.productMatrix && typeof j.productMatrix === 'object') ? j.productMatrix : null;
  comp.productMatrix = pm ? {
    skuCount: (typeof pm.skuCount === 'number' && pm.skuCount > 0) ? Math.round(pm.skuCount) : null,
    priceBandDist: String(pm.priceBandDist || '').slice(0, 200),
    heroSku: Array.isArray(pm.heroSku) ? pm.heroSku.map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 6) : [],
    productLines: Array.isArray(pm.productLines) ? pm.productLines.map(x => String(x).slice(0, 80)).filter(Boolean).slice(0, 12) : []
  } : null;
  // ▶ P2 #5 品类布局（横向广度）：跨品类覆盖；与产品矩阵数据源分离（PRD整改 #5）。
  comp.categoryCoverage = Array.isArray(j.categoryCoverage) ? j.categoryCoverage
    .map(x => ({ category: String(x.category || '').trim().slice(0, 60), subCategory: String(x.subCategory || '').trim().slice(0, 60), count: (typeof x.count === 'number' && x.count > 0) ? Math.round(x.count) : null }))
    .filter(x => x.category).slice(0, 16) : [];
  comp.reviews = j.reviews ? applyBasis({ rating: j.reviews.rating != null ? j.reviews.rating : null, trend: j.reviews.trend || 'flat', posThemes: j.reviews.posThemes || [], negThemes: j.reviews.negThemes || [], reasoning: j.reviews.reasoning || '' }, j.reviews.cite, 'reviews') : null;
  if (comp.reviews) fieldConfs.push(comp.reviews.confidence);
  // ▶ P1 #7：口碑 snippets——每条带 url；无 url 不入库展示（评分带样本量）
  comp.reviewSnippets = Array.isArray(j.reviewSnippets) ? j.reviewSnippets
    .map(s => ({
      platform: String(s.platform || '其他').slice(0, 40),
      rating: (s.rating != null && Number(s.rating) >= 0 && Number(s.rating) <= 5) ? Number(s.rating) : null,
      sampleSize: (s.sampleSize != null && Number(s.sampleSize) > 0) ? Number(s.sampleSize) : null,
      url: (s.url && /^https?:\/\//i.test(String(s.url))) ? String(s.url).slice(0, 500) : '',
      text: String(s.text || '').slice(0, 200),
      sentiment: ['pos', 'neg', 'neu'].includes(s.sentiment) ? s.sentiment : 'neu'
    }))
    .filter(s => s.url) // ▶ 无 url 不展示（信任红线：不可核验不呈现）
    : [];

  // ▶ P2 #8 定位战略（结构化）：价值主张 / 目标人群 / 价格定位 / 差异化卖点（品牌自称 claim）。
  // 两级视觉：basis='verified' → 官网实测（实测层）；否则归一为 'claimed' → 品牌自称（自述层）。
  const posObj = (j.positioning && typeof j.positioning === 'object') ? j.positioning : { valueProposition: j.positioning || '', cite: [] };
  const posB = applyBasis({ v: 1 }, posObj.cite, 'positioning');
  comp.positioning = {
    valueProposition: String(posObj.valueProposition || posObj.value || '').slice(0, 400),
    targetAudience: String(posObj.targetAudience || '').slice(0, 200),
    pricePosition: String(posObj.pricePosition || '').slice(0, 200),
    differentiation: String(posObj.differentiation || '').slice(0, 300)
  };
  comp.positioningBasis = (posB.basis === 'verified') ? 'verified' : 'claimed';

  // 定制化程度（0-100）：象限图 Y 轴来源，必须可溯源（applyBasis 由 cite 推导 basis + 写 fieldSources）
  const custNorm = normalizeCustomization(j.customization);
  if (custNorm) {
    const cB = applyBasis({ v: 1 }, (j.customization && j.customization.cite) || [], 'customization');
    comp.customization = { score: custNorm.score, note: custNorm.note, basis: cB.basis, confidence: cB.confidence };
  }

  const sizeObj = j.estSize && typeof j.estSize === 'object' ? j.estSize : { value: j.estSize || '', cite: [] };
  const sizeB = applyBasis({ v: 1 }, sizeObj.cite, 'estSize');
  comp.estSize = sizeObj.value || '';
  comp.estSizeBasis = sizeB.basis;

  if (j.tier) comp.tier = j.tier;
  comp.techStack = shopify.ok ? 'Shopify（实抓确认）' : (j.techStack || null);
  comp.recentMoves = (Array.isArray(j.recentMoves) ? j.recentMoves : []).map((m, i) => {
    const b = applyBasis({ type: m.type, desc: m.desc, when: m.when }, m.cite, 'recentMoves.' + i);
    return b;
  });
  comp.contentForms = Array.isArray(j.contentForms) ? j.contentForms : [];
  comp.collabTypes = Array.isArray(j.collabTypes) ? j.collabTypes : [];
  comp.fulfillment = Array.isArray(j.fulfillment) ? j.fulfillment : [];
  // 卖点（混合：受控词 + 自由词），每项带 basis（claimed/verified）；兼容旧字符串数组。副字段供 inference-guard 做"宣称=能力"降级。
  const _sp = parseGradedList(j.sellingPoints, null);
  comp.sellingPoints = _sp.points;
  comp.sellingPointBasis = _sp.meta;
  // 打法（受控词），每项带 demandEvidence（present/absent/unknown）；兼容旧字符串数组。副字段供 inference-guard 做"策略空白=想要"降级。
  const _tac = parseGradedList(j.tactics, TACTICS);
  comp.tactics = _tac.points;
  comp.tacticDemand = _tac.meta;
  comp.painPoints = (Array.isArray(j.painPoints) ? j.painPoints : []).map((p, i) => {
    const obj = typeof p === 'object' ? p : { point: String(p), cite: [] };
    const b = applyBasis({ point: obj.point || '' }, obj.cite, 'painPoints.' + i);
    return b;
  }).filter(p => p.point);
  // 优化三：时间趋势维度（foundedYear / growth）——fail-safe：缺则 unknown / null
  const fy = (j.foundedYear && typeof j.foundedYear === 'object') ? j.foundedYear
    : (typeof j.foundedYear === 'number' ? { year: j.foundedYear, cite: [] } : { year: null, cite: [] });
  comp.foundedYear = (typeof fy.year === 'number') ? fy.year : null;
  comp.foundedYearBasis = applyBasis({ v: 1 }, fy.cite || [], 'foundedYear').basis;
  const gr = (j.growth && typeof j.growth === 'object') ? j.growth
    : { value: (typeof j.growth === 'string' && GROWTH_VALUES.includes(j.growth)) ? j.growth : 'unknown', cite: [] };
  comp.growth = GROWTH_VALUES.includes(gr.value) ? gr.value : 'unknown';
  comp.growthBasis = applyBasis({ v: 1 }, gr.cite || [], 'growth').basis;
  // 优化五：LLM 语义召回层（第三层）——解析受控词过滤后的 demandAlignments
  comp.demandAlignments = Guard.parseDemandAlignments(j.demandAlignments, SELLING_POINTS);
  // 推算字段清单（自动生成，替代 LLM 自报）
  // ---- 引用支持性复核：verified 字段的值必须真出自所引证据文本，否则降级 ----
  // （此前 cite 只验"编号存在"，LLM 给猜测挂任意证据号即可升 verified/high）
  try {
    const audit = citeAudit.slice(0, 24); // 上限控 token，超出部分保持原判定
    if (audit.length && dsKey) {
      const items = audit.map((x, i) => {
        const val = Object.assign({}, x.obj);
        delete val.basis; delete val.confidence; delete val.cite; delete val.verifyNote;
        return {
          i,
          field: x.fieldName,
          value: JSON.stringify(val).slice(0, 400),
          ev: x.evs.map(e => `[${e.id}] ${e.title}：${e.excerpt}`).join(' ').slice(0, 600),
        };
      });
      const vr = await deepseekJSON([
        { role: 'system', content: '你是审计员。逐条判断「字段值」是否被「所引证据文本」支持：值的核心内容能从证据文本直接读出才算支持；证据无关、证据里没有该信息、或与证据矛盾都算不支持。只输出 JSON：{"results":[{"i":编号,"supported":true或false}]}' },
        { role: 'user', content: items.map(it => `#${it.i} 字段=${it.field}\n值=${it.value}\n证据=${it.ev}`).join('\n\n') },
      ], dsKey, null, { fieldKey: 'cite-verify', competitorId: comp.id, thinking: false, maxAttempts: 2 });
      const verdicts = new Map((Array.isArray(vr && vr.results) ? vr.results : []).map(v => [Number(v.i), v]));
      let bad = 0;
      audit.forEach((x, i) => {
        const v = verdicts.get(i);
        // 只有明确"不支持"才降级（字符串 'false' 同样采纳）；复核调用失败/降级返回 {} 时 fail-open
        if (v && (v.supported === false || v.supported === 'false')) {
          bad++;
          // 渠道缺席沿用既有纪律：LLM 参与的"缺席"最多到未探测，不落到 inferred
          const chanAbsent = x.fieldName.indexOf('channels.') === 0 && x.obj.present === false;
          x.obj.basis = chanAbsent ? 'unverified' : 'inferred';
          x.obj.confidence = 'low';
          x.obj.verifyNote = '引用复核：所引证据未支持该值，已降级';
        }
      });
      if (bad) logAttempt(comp, 'cite-verify', '', sProvider, false, `引用支持性复核：${bad}/${audit.length} 个 verified 字段因证据不支持降级`);
      // 降级后按原 push 顺序重建 fieldConfs（渠道→价格带→口碑），让卡片置信度吃到复核结果
      const rebuilt = [];
      scopeChannels.forEach(k => {
        if (codedChannels[k]) rebuilt.push(codedChannels[k].confidence);
        else if (j.channels && j.channels[k]) rebuilt.push(ch[k].confidence);
      });
      if (comp.priceBand) rebuilt.push(comp.priceBand.confidence);
      if (comp.reviews) rebuilt.push(comp.reviews.confidence);
      fieldConfs.length = 0;
      Array.prototype.push.apply(fieldConfs, rebuilt);
    }
  } catch (e) { /* 复核失败不阻断深研主链路（fail-open） */ }
  comp.inferred = [];
  if (comp.priceBand && comp.priceBand.basis !== 'verified') comp.inferred.push('价格带');
  if (comp.reviews && comp.reviews.basis !== 'verified') comp.inferred.push('口碑');
  if (comp.estSizeBasis !== 'verified') comp.inferred.push('估算规模');
  if (comp.positioningBasis !== 'verified') comp.inferred.push('定位');
  if (comp.customization && comp.customization.basis !== 'verified') comp.inferred.push('定制化程度');
  comp.evidence = j.evidence || '';
  comp.evidenceList = evidences; // 全量证据留档（前端可点开核验）
  // ▶ 数据卫生③：离谱值 sanity——量级声称与营收口径/微品牌自述矛盾 → flaggedOutlier 降级
  try {
    const sane = Sizing.sanityScaleVsTier(comp.tier, comp.estSize);
    if (sane && sane.flagged) { comp.flaggedOutlier = true; comp.outlierNote = sane.note || '量级离谱，已降级'; }
  } catch (e) { /* 不阻断主链路 */ }
  const _sc = scoreConfidence(Math.max(comp.evidenceCount || 0, evidences.length), fieldConfs);
  comp.confidence = comp.flaggedOutlier ? 'low' : (_sc >= 70 ? 'high' : (_sc >= 45 ? 'medium' : 'low'));
  // ▶ PRD整改 §1.3：分析层判断类型（分层/估算/趋势）注册进校准体系——
  // 每条推断产生一张计算层校准样本（带 id），后续由人工抽检标注（分层/估算）或事件回看（趋势）走三判。
  try {
    if (comp.tier) M.recordComputationJudgment({ judgmentType: 'tier', subjectId: comp.id, predicted: comp.tier, confidence: comp.confidence || 'medium', source: 'research' });
    if (comp.estSize) M.recordComputationJudgment({ judgmentType: 'scale', subjectId: comp.id, predicted: String(comp.estSize), confidence: comp.estSizeBasis || 'inferred', source: 'research' });
    if (comp.growth && comp.growth !== 'unknown') M.recordComputationJudgment({ judgmentType: 'trend', subjectId: comp.id, predicted: comp.growth, confidence: comp.growthBasis || 'inferred', source: 'research' });
  } catch (e) { /* 校准落地失败不阻断主链路 */ }

  // ---- #304 字段撕裂交叉校验（discover 归类推测 vs enrich 官网实抓事实）----
  try { crossValidateTearing(comp, state.track); } catch (e) { /* 不阻断主链路 */ }
  try { enforceBasisEvidence(comp); } catch (e) { /* 不阻断主链路 */ }
  Telemetry.recordStage({ runId: _telemetryRunId, tenantId: state.tenantId, projectId: state.projectId,
    stage: 'field_merge_citation_check', durationMs: Date.now() - _tMerge, status: 'ok' });

  // ---- R2：真实口碑采集（Reddit 公开端点 + 独立站评论页 + 已配 key 的平台）----
  // 失败/未配置静默返回空（voice-collector 纪律）；归一化带来源 URL，供机会视图/voice 域溯源。
  const _tVoice = Date.now(); // Phase 1 可观测性：口碑采集段计时
  try {
    // R2.1 增量：持久化游标按对手记住上次采集点，作为 since 只取更新内容（配合 URL 去重双保险）
    const _cursorAll = state.projectId ? voiceStore.loadCursor(state.tenantId, state.projectId) : {};
    const _since = _cursorAll[comp.id] || null;
    const voiceRaw = await VC.collectBrandVoice(comp.name, {
      config, // 密钥型适配器（Trustpilot/Etsy/YouTube）从 config 取 key，漏传 = 全部按未配置处理
      maxItems: 30,
      since: _since,
      adapterOpts: { siteUrl: comp.url || '' },
    });
    comp.voiceItems = VC.voiceItemsToNormalized(voiceRaw, { id: comp.id, name: comp.name });
    if (state.projectId) {
      // 采集成功 → 游标推进到本次最新条目时间（无新内容则推进到当前时刻，避免反复重抓旧窗口）
      let latest = _since || null;
      for (const it of (voiceRaw || [])) {
        const d = it && it.date ? String(it.date) : null;
        if (d && (!latest || d > latest)) latest = d;
      }
      _cursorAll[comp.id] = latest || new Date().toISOString();
      voiceStore.saveCursor(state.tenantId, state.projectId, _cursorAll);
    }
  } catch (e) { comp.voiceItems = []; } // 采声失败不阻断主链路（忠实：缺数据好过编数据；游标不推进）
  Telemetry.recordStage({ runId: _telemetryRunId, tenantId: state.tenantId, projectId: state.projectId,
    stage: 'voice_collection', durationMs: Date.now() - _tVoice, status: 'ok', provider: 'voice-collector' });

  comp.status = 'done';
}

// 用户直接指定品牌检索（绕过赛道发现，单独深研）
async function lookupBrand(name, url, config, bodyIntent) {
  let s = loadState();
  if (!s || !s.track) {
    const tk = '指定品牌 · ' + name;
    s = { projectId: newProjectId(tk), track: tk, intent: {}, competitors: [], discoveredAt: new Date().toISOString(), progress: { total: 0, done: 0 }, excluded: [], excludedReasons: {}, suppressed: [], addedCompetitors: [], ruleDecisions: {}, signals: {}, whiteSpace: null, brief: null };
    s.tenantId = resolveTenantId(); // 绑定租户（P0-2.1）
    setCurrentId(s.projectId, s.tenantId);
    mirrorProjectToDb(s.projectId, requestScope.getStore() || s.tenantId, s.track); // T3-1：镜像进 db 项目清单
  } else if (!s.tenantId) {
    s.tenantId = resolveTenantId(); // 既有档案补打租户标（升级后首次访问）
  }
  // 审核整改 §一：指定品牌调研也是独立 run——每次调用生成新 runId，全程（deepResearchOne/
  // derived_analysis）归因同一个 run，结束时 endRun（成功 ok / 失败 error，不产生 all_done 误标）
  const _lookupRunId = Telemetry.newRunId();
  s.runId = _lookupRunId; // 深层阶段行（deepResearchOne 读 state.runId）归因到本次调研
  Telemetry.beginRun({ runId: _lookupRunId, tenantId: s.tenantId, projectId: s.projectId });
  // 合并用户定位（含 profile）；与已有 intent 合并，归一化保证口径一致
  s.intent = Object.assign({}, normalizeIntent(s.intent), normalizeIntent(bodyIntent || {}));
  // 平台集接管：显式勾选优先，否则由地域推导
  s.intent = s.intent || {};
  s.intent.platforms = resolvePlatforms({ platforms: (bodyIntent && bodyIntent.platforms) || s.intent.platforms, regions: s.intent.regions });
  const id = slug(name, s.competitors.length + 1);
  if (s.competitors.some(c => c.id === id)) {
    const ex = s.competitors.find(c => c.id === id);
    ex.manual = true;
    // ▶ 数据卫生②：既有品牌若命中自有品牌，也确保排除（用户手动补录自家品牌时）
    if (autoExcludeOwnBrands([ex], (config && config.ownBrands) || []).excluded.length) {
      if (!s.excluded.includes(ex.id)) s.excluded.push(ex.id);
      s.excludedReasons[ex.id] = 'own-brand';
    }
    const _tDer0 = Date.now();
    s.whiteSpace = computeWhiteSpace(s);
    Telemetry.recordStage({ runId: _lookupRunId, tenantId: s.tenantId, projectId: s.projectId,
      stage: 'derived_analysis', durationMs: Date.now() - _tDer0, status: 'ok' });
    Telemetry.endRun(_lookupRunId, 'ok'); // 早退路径也终结本次指定品牌调研 run
    return s;
  }
  const comp = {
    id, name, url: url || '', why: '用户指定检索', tier: 'unknown', manual: true,
    matchScore: 90, evidenceCount: url ? 1 : 0, confidence: 'low', rankScore: 90,
    status: 'researching',
    channels: {}, priceBand: null, pricePoints: [], freebies: [], audiences: [], regions: [],
    priceStats: null, priceVerdict: null, soldOutCount: 0, typeDist: null,
    products: [], reviews: null, positioning: '', customization: null, estSize: null, techStack: null,
    recentMoves: [], contentForms: [], collabTypes: [], fulfillment: [],
    sellingPoints: [], tactics: [], painPoints: [], fieldSources: {},
    attempts: [],
    inferred: [], timeline: null, reviewSnippets: [], priceForensic: null, foundedYear: null, growth: 'unknown', demandAlignments: [], evidence: '', researchedAt: null
  };
  s.competitors.push(comp);
  // ▶ 数据卫生②：手动补录时也排除自有品牌（名字或域名命中 config.ownBrands）
  if (autoExcludeOwnBrands([comp], (config && config.ownBrands) || []).excluded.length) {
    if (!s.excluded.includes(comp.id)) s.excluded.push(comp.id);
    s.excludedReasons[comp.id] = 'own-brand';
  }
  s.progress = { total: s.competitors.length, done: s.competitors.filter(c => c.status === 'done').length };
  saveState(s);
  try { await deepResearchOne(comp, s, config, _lookupRunId); }
  catch (e) { comp.status = 'error'; comp.evidence = '检索失败：' + String(e.message || e); }
  finally { saveState(s); }
  const _tDer1 = Date.now();
  s.whiteSpace = computeWhiteSpace(s);
  Telemetry.recordStage({ runId: _lookupRunId, tenantId: s.tenantId, projectId: s.projectId,
    stage: 'derived_analysis', durationMs: Date.now() - _tDer1, status: 'ok' });
  // 审核整改 §二：失败重研按 error 终结（total.status=error + 受控 code，无 all_done）
  Telemetry.endRun(_lookupRunId, comp.status === 'error' ? 'error' : 'ok',
    comp.status === 'error' ? 'LOOKUP_FAILED' : undefined);
  return s;
}
// 点卡优先调研（P0-1 修复：操作本项目队列，不污染其他项目）
function enrichOne(id, state, config) {
  const comp = state.competitors.find(c => c.id === id);
  if (!comp) return false;
  // 提到队列最前（priority 最高）
  const q = getQ(state.projectId);
  q.queue = q.queue.filter(j => j.id !== id);
  q.queue.unshift({ id, priority: 3 });
  // 模块 0-4：同步落表（priority 3 优先被认领）
  // 审核整改 §一：重新执行是独立 run——每次点卡生成不可碰撞的新 runId，随 payload 进任务表
  try {
    Tasks.enqueue({ tenantId: state.tenantId, projectId: state.projectId, type: 'deep-research',
      payload: { competitorId: id, runId: Telemetry.newRunId() }, priority: 3 });
  } catch (e) { /* 非致命 */ }
  ensureQueue(state, config);
  return true;
}
// ---- #304 字段撕裂交叉校验：discover 归类推测 vs enrich 官网实抓事实 ----
// 发现阶段按名字/赛道推测归类，深研抓到官网事实后应交叉校验；若两者明显不符，
// 标记 categoryTearing（不再让同卡 why/products/positioning 自相矛盾），
// 以事实为准、保留发现理由供用户裁决（忠实助理：不替用户下结论）。
function crossValidateTearing(comp, track) {
  const t = String(track || '').toLowerCase();
  const cats = (comp.categories || []).join(' ').toLowerCase();
  const pos = ((comp.positioning && comp.positioning.valueProposition) || '').toLowerCase();
  const why = String(comp.why || '').toLowerCase();
  if (!t || !cats) return; // 无赛道或无实抓品类 → 无法判定
  const trackTokens = t.split(/[\s/,&]+/).map(s => s.trim()).filter(s => s.length >= 2);
  if (!trackTokens.length) return;
  const hitTrack = trackTokens.some(tok => cats.includes(tok) || pos.includes(tok));
  const whyClaimsTrack = trackTokens.some(tok => why.includes(tok));
  if (whyClaimsTrack && !hitTrack) {
    comp.categoryTearing = true;
    comp.tearingNote = `发现阶段推测「${comp.discoverWhy || comp.why}」；官网事实主营「${(comp.categories || []).join('、') || '未知'}」，疑似非本赛道对手，请核实是否保留`;
  }
}

// ▶ #308：evidenceCount 与 basis 一致性 —— verified 卡须有实际捕获的证据，否则降级 inferred
// 深研阶段官网/Shopify 实抓得到的 basis=verified 字段是真实证据，但 comp.evidenceCount（发现期搜索命中数）
// 在深研时未被累加，导致"evidenceCount=0 却 basis=verified"的矛盾。此处：① 把实抓 verified 证据计入 evidenceCount；
// ② 防御性兜底：仍有字段标 verified 但整卡零证据（既无 sources 也非确认缺席）→ 降级 inferred 并补推理说明。
function enforceBasisEvidence(comp) {
  if (!comp || typeof comp !== 'object') return;
  let captured = 0;
  const verifiedFields = [];
  const stack = [comp];
  const seen = new Set();
  while (stack.length) {
    const o = stack.pop();
    if (!o || typeof o !== 'object' || Array.isArray(o)) continue;
    if (seen.has(o)) continue; seen.add(o);
    if (o.basis === 'verified') { captured++; verifiedFields.push(o); }
    for (const k of Object.keys(o)) { const v = o[k]; if (v && typeof v === 'object') stack.push(v); }
  }
  // ① 实抓 verified 证据计入 evidenceCount（取与发现期证据的最大值，不回退）
  const prev = Number(comp.evidenceCount) || 0;
  if (captured > prev) comp.evidenceCount = captured;
  // ② 防御性兜底：字段标 verified 但整卡零证据 → 降级 inferred + 推理说明
  if (Number(comp.evidenceCount) === 0) {
    verifiedFields.forEach(o => {
      const hasSrc = Array.isArray(o.sources) && o.sources.length > 0;
      const verifiedAbsent = o.present === false; // 确认缺席也是 verified 证据
      if (!hasSrc && !verifiedAbsent) {
        o.basis = 'inferred';
        if (o.confidence === 'high') o.confidence = 'medium';
        o.note = (o.note ? o.note + '；' : '') + '推理：原标注 verified 但无来源证据，已降级为推断';
      }
    });
  }
}


module.exports = { getQ, buildResearchQueue, enqueueResearch, ensureQueue, runQueue, sleep, CHANNEL_LINK, deepResearchOne, lookupBrand, enrichOne, crossValidateTearing, enforceBasisEvidence, runTerminalStatus };
