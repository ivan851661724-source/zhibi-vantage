'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/discover.js —— 导出: isCJK, needsTranslation, translateToMarketLang, buildFanoutQueries, llmEnumerate, harvestCandidates, runDiscover, discoverLaunch
// ============================================================

const { activeSearchKey } = require('../core/config.js');
const { DATA } = require('../core/paths.js');
const { requestScope } = require('../core/als.js');
const { emitSSE } = require('../core/sse-hub.js');
const { loadState, mirrorProjectToDb, newProjectId, resolveTenantId, saveState, setCurrentId } = require('../core/state-store.js');
const { fanoutSearch } = require('./search.js');
const { domainOf } = require('./net.js'); // B-6：域级去重用
const { dedupeByDomain } = require('./dedupe.js'); // B-6 修订版：纯函数去重（可单测）
const { deepseekJSON, llmApiKey } = require('./llm.js');
const { normalizeIntent, resolvePlatforms } = require('./vocab.js');
const { applyApprovedRules, applyRelevanceJudgments, applySuppression, crossValidate, mergeCandidates, normName, presenceGate, rankCandidates, rejudgeRelevance, slug } = require('./candidates.js');
const { enqueueResearch } = require('./enrich.js');
const Logger = require('../services/logger.js');
const db = require('../services/db.js');
const { safeWrite } = require('../lib/fs-util.js');
const { glFromRegions } = require('../services/providers/search.js');
const { autoExcludeOwnBrands } = require('../lib/own-brand.js');
const path = require('path');

// ============================================================
// 步骤1：发现引擎（扇出 + 两阶段 + 排名）
// ============================================================
function isCJK(s) {
  s = s || '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3000 && c <= 0x303f)) return true;
  }
  return false;
}

// 多语言适配：用户可能用任意语言操作（中文/德语/日语…），检索前统一翻译成
// 目标市场语言（先英语/海外）。检索层本身固定 hl=en + gl=市场地区，所以把赛道翻成
// 市场语言再去搜，才能命中真实对手，而不是「中文词查美国英文 Google」得到 0 结果。
// 判定：输入含非 ASCII 字符（CJK/重音/西里尔等）才需要翻译；纯 ASCII 视为已是英文，
// 直接跳过以省一次 LLM 调用（覆盖海外商家主要用英文输入的常见路径）。
function needsTranslation(track) {
  return /[^\x00-\x7F]/.test(track || '');
}
async function translateToMarketLang(track, intent, targetLang, dsKey) {
  const langName = { en: 'English', de: 'German', fr: 'French', es: 'Spanish', ja: 'Japanese', zh: 'Chinese' }[targetLang] || targetLang;
  const sys = `You are the localization layer of a competitive-intelligence tool that serves the ${langName}-speaking OVERSEAS e-commerce market (Shopify merchants etc.).
Task: rewrite the user's product category / niche into the most natural ${langName} phrase a local shopper or analyst would type into Google.
Rules:
- Output 1-5 words, commercial and precise. Example: "定制手办" -> "custom action figure"; "定制玩具" -> "custom toys".
- Preserve the exact product meaning; do NOT broaden to a vague generic category.
- Respond with JSON only: {"query":"<translated phrase>"}`;
  const user = `User input (may be any language): ${track}\nNiche/positioning context: ${JSON.stringify((intent && (intent.niche || intent.positioning)) || {})}`;
  try {
    const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'track-translate', thinking: false });
    if (j && j.query && String(j.query).trim()) return String(j.query).trim();
  } catch (e) { /* 翻译失败，回落原文 */ }
  return null;
}
function buildFanoutQueries(track, intent) {
  const cjk = isCJK(track);
  // 覆盖全体量：头部大牌 / 腰部 / 独立小众 / 新兴，避免只出大牌或残缺小品牌
  let q;
  if (cjk) {
    q = [
      `${track} 品牌 推荐`,
      `${track} 独立品牌 小众`,
      `${track} 新兴 创业 公司`,
      `类似 ${track} 的品牌 竞品`,
      `${track} 淘宝 店铺 推荐`,
      `${track} 头部 品牌 排行榜`,
      `${track} 腰部 品牌`,
      `${track} 出海 品牌`
    ];
  } else {
    q = [
      `best ${track} brands market leaders`,
      `top ${track} companies 2025`,
      `${track} small independent boutique brands`,
      `${track} emerging startups 2024 2025`,
      `${track} niche indie DTC brands`,
      `${track} micro handmade brand etsy`,
      `${track} TikTok Shop growing sellers`,
      `alternatives to leading ${track} brand`
    ];
  }
  const regions = (intent && intent.regions && intent.regions.length) ? intent.regions : null;
  if (regions) regions.slice(0, 2).forEach(r => {
    const rname = { us: '美国', uk: '英国', eu: '欧洲', cn: '中国', jp: '日本', sea: '东南亚' }[r] || r;
    q.push(cjk ? `${track} ${rname} 市场 品牌` : `${track} brands market ${r}`);
  });
  return q.slice(0, 9);
}
// 发现渠道①：LLM 内生知识枚举（免费候选生成器；铁律：每个名字必须过搜索验证才能入库）
// 性能（2026-08-12 诊断）：输出规模是 discover 慢的主因 → 候选 8-10、why 极简（输出 tokens 减半）
async function llmEnumerate(track, intent, dsKey) {
  const regions = (intent && intent.regions && intent.regions.length) ? intent.regions.join('/') : 'us(北美为主)';
  const sys = `你是资深消费品行业分析师。基于你的既有知识，枚举"${track}"赛道（主要市场：${regions}）真实存在的品牌。
要求（宁缺毋滥，控制在 8-10 个）：
- 头部(large) 2-3、腰部(mid) 2-3、小众(small) 1-2、新兴(emerging) 1-2。
- 每个给 name（品牌官方英文名优先）、url（官网域名，不确定就留空，绝不编造）、tier、matchScore(0-100 整数)、why（不超过 6 个字的极简短语，如"主流大牌"）。
- 只列你有把握真实存在的；宁缺毋滥。
- 只列独立品牌，绝不列平台/市场（Etsy、Amazon、Amazon Custom、TikTok Shop、eBay 等都是平台，不是品牌）。
输出 JSON：{"candidates":[{"name":"","url":"","tier":"","matchScore":0,"why":""}]}`;
  try {
    // 大输出调用：超时放宽到 90s、重试 1 次（避免 45s 阈值触发重试翻倍）
    const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: `赛道：${track}；意图：${JSON.stringify(intent || {})}` }], dsKey, null, { fieldKey: 'discover-enumerate', timeoutMs: 90000, maxAttempts: 2, thinking: false });
    return (j.candidates || []).map(c => { c.src = 'llm'; return c; });
  } catch { return []; }
}
// 阶段一：只 harvest 候选名 + URL（减编造）；同时产出第二轮追加查询（两轮迭代搜索）
// 性能（2026-08-12 诊断）：snippets 每查询 6→4 条、截断 260→200（输入减负），候选 why 极简（输出减半）
async function harvestCandidates(track, intent, fanout, dsKey, labels) {
  const snippets = [];
  let idx = 0;
  fanout.forEach((tres, qi) => {
    const query = (labels && labels[qi]) || '';
    (tres.results || []).slice(0, 4).forEach(x => {
      idx++;
      snippets.push(`[${idx}] (query: ${query}) ${x.title} — ${x.url}\n${(x.content || '').slice(0, 200)}`);
    });
  });
  const sys = `你是"知彼 Vantage"。用户赛道："${track}"。用户意图：${JSON.stringify(intent || {})}.
从下面真实搜索结果中，只提取【真实存在、且在运营】的竞争对手【品牌名 + 官网URL】。
规则：
- 只列消费品牌/公司，不要列平台、媒体、泛指南、非竞品。【特别注意】Etsy / Amazon / "Amazon Custom" / "Amazon Handmade" / TikTok Shop / eBay / 速卖通 等是【销售平台/市场】，不是品牌，绝对不能作为候选输出；"某平台上的定制服务"也不算品牌，除非能给出独立的品牌名和官网。
- 【严格贴合赛道】只列真正属于"${track}"这个赛道（同类消费品牌）的玩家；若某角度搜回来多是 Apple/Nike/阿里 这类跨行业巨头或无关大牌，说明该角度无效，宁可少列、只保留强相关，也不要塞入无关品牌。matchScore<50 的除非有强证据否则不要输出。
- 【宁缺毋滥】总数控制在 8-12 个；头部大牌、腰部品牌、独立小众、新兴品牌都要有；优先列真实在运营、有公开痕迹的。
- 每个候选给 name、url（必须来自真实链接，不确定留空）、tier（"large"/"mid"/"small"/"emerging"）、matchScore(0-100 整数)、why（不超过 8 个字的极简短语）。
- 不要编造；不确定 url 就留空字符串。
- 另外：从结果里发现的【线索】（提到但信息不足的品牌名、别名、"also compare with X"），生成最多 3 条值得追加的搜索查询放入 moreQueries；没有就给空数组。
输出 JSON：{"candidates":[{"name":"","url":"","tier":"","matchScore":0,"why":""}],"moreQueries":["",""]}`;
  const user = `搜索结果：\n${snippets.join('\n\n')}`;
  // 大输出调用：超时放宽到 90s、重试 1 次（避免 45s 阈值触发重试翻倍）
  const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'discover-harvest', timeoutMs: 90000, maxAttempts: 2, thinking: false });
  return { candidates: j.candidates || [], moreQueries: Array.isArray(j.moreQueries) ? j.moreQueries.slice(0, 3) : [] };
}

// 步骤1 主流程：知识枚举 + 两轮迭代搜索 + 合并验证，返回骨架卡（不等待深研）
async function runDiscover(track, intent, config, emit, projectId) {
  const sKey = activeSearchKey(config);
  const dsKey = llmApiKey(config);
  if (!sKey || !dsKey) throw new Error('NO_KEYS');
  const pid = projectId || newProjectId(track);
  const _t0 = Date.now();
  // ▶ 加固（0812 体验报告）：发现启动即落空状态——即使后续外部调用全失败（密钥失效等），
  // 项目也已落库、state.track 立即可见、/api/projects 立即可列出、轮询兜底恒有数据，杜绝「永久空白」。
  const _initState = {
    projectId: pid,
    track,
    intent: normalizeIntent(intent),
    competitors: [],
    discoveredAt: new Date().toISOString(),
    progress: { total: 0, done: 0 },
    excluded: [], excludedReasons: {}, suppressed: [], addedCompetitors: [],
    ruleDecisions: {}, fieldCorrections: [], signals: {}, whiteSpace: null, brief: null,
    discoverDone: false,
  };
  _initState.intent = _initState.intent || {};
  _initState.intent.platforms = resolvePlatforms({
    platforms: (intent && intent.platforms) || _initState.intent.platforms,
    regions: _initState.intent.regions,
  });
  _initState.tenantId = resolveTenantId();
  // 业务事件显式携带 tenantId（后台队列可能脱离请求上下文；sse-hub 据此按租户投递）
  const emitT = (t, p) => (typeof emit === 'function') ? emit(t, Object.assign({}, p, { tenantId: _initState.tenantId })) : undefined;
  setCurrentId(pid, _initState.tenantId);
  saveState(_initState);                                  // ← 关键：首个外部 await 之前落盘
  // 关键：项目立即进 db 清单。tenantId 必须用 RAW（requestScope）对齐 db.listProjects 的过滤键——
  // resolveTenantId 返回 sanitizeNs 后的（tenant:xxx → tenant_xxx），而 db 存 RAW（tenant:xxx），
  // 用错键会导致 /api/projects 查不到（0812 加固实测发现，与原中部 mirrorProjectToDb 口径对齐）。
  mirrorProjectToDb(pid, requestScope.getStore() || _initState.tenantId, track);
  if (emit) emitT('discover_stage', { projectId: pid, stage: 'translating', label: '正在理解你的赛道…', pct: 5, found: 0 });
  const _stage = (name) => { try { Logger.info('discover-stage', { stage: name, elapsedMs: Date.now() - _t0, track }); } catch (e) {} };
  // —— 多语言适配 + 第一轮并行（性能优化 ②）：翻译 ∥ LLM 枚举 ——
  // 翻译只喂搜索查询构造（buildFanoutQueries）；枚举用原文赛道（LLM 懂中文，品牌名是英文不依赖翻译）
  // 原串行：translate(2-4s) → 枚举(20-30s)；改并行：max(translate, 枚举)，省 translate 时间
  const marketLang = (config.search && config.search.marketLang) || 'en';
  let trackWork = track;
  let translatedFrom = null;
  const gl = glFromRegions(intent && intent.regions);
  const _tR1 = Date.now();
  const translateP = (marketLang && marketLang !== 'raw' && needsTranslation(track))
    ? translateToMarketLang(track, intent, marketLang, dsKey).then(tr => {
        if (tr) { trackWork = tr; translatedFrom = track; }
      })
    : Promise.resolve();
  const enumP = llmEnumerate(track, intent, dsKey).then(v => { _stage('llmEnumerate-done'); return v; });
  await Promise.all([translateP, enumP]);
  _stage('translate');
  // 承接上一轮的学习信号（用户反馈）：按名字×赛道记的 suppressed / 用户补的对手，跨次 discover 保留
  const prevState = loadState() || {};
  const carrySuppressed = Array.isArray(prevState.suppressed) ? prevState.suppressed : [];
  const carryAdded = Array.isArray(prevState.addedCompetitors) ? prevState.addedCompetitors : [];
  const carryRules = prevState.ruleDecisions && typeof prevState.ruleDecisions === 'object' ? prevState.ruleDecisions : {};

  // SERP 扇出（依赖翻译结果构造查询；与枚举已并行，这里单独跑）
  const queries = buildFanoutQueries(trackWork, intent);

  const fanout = await fanoutSearch(queries, config, gl).then(v => { _stage('fanout-done'); return v; });
  const llmCands = await enumP;
  if (emit) emitT('discover_stage', { projectId: pid, stage: 'enumerating', label: '已枚举候选品牌，正在全网搜索…', pct: 15, found: llmCands.length });
  if (emit) emitT('discover_stage', { projectId: pid, stage: 'searching', label: '正在多维度搜索对手（覆盖各体量）…', pct: 30, found: fanout.length });
  _stage('round1（total ' + ((Date.now() - _tR1) / 1000).toFixed(1) + 's）');
  if (!fanout.length && !llmCands.length) throw new Error('SEARCH_FAILED');

  const _tH = Date.now();
  const h1 = await harvestCandidates(trackWork, intent, fanout, dsKey, queries);
  _stage('harvest（total ' + ((Date.now() - _tH) / 1000).toFixed(1) + 's）');
  if (emit) emitT('discover_stage', { projectId: pid, stage: 'harvesting', label: '已抓取到一批线索，正在校验…', pct: 45, found: h1.candidates.length });
  let allFanout = fanout.slice();
  let labels2 = [];

  // 第二轮：追加"线索查询" + 对 LLM 独有候选做存活验证（迭代搜索，复刻"多轮追问"机制）
  const llmOnlyNames = llmCands
    .filter(c => !h1.candidates.some(x => normName(x.name) === normName(c.name)))
    .slice(0, 8) // 上限控预算
    .map(c => `"${c.name}" official site ${trackWork}`);
  const round2 = h1.moreQueries.concat(llmOnlyNames);
  if (round2.length) {
    labels2 = round2;
    const fan2 = await fanoutSearch(round2, config, gl);
    allFanout = allFanout.concat(fan2);
  }
  _stage('round2');

  // 合并三路候选：SERP harvest + LLM 枚举；用全部原始结果交叉验证（LLM 候选无搜索痕迹则黜落）
  let candidates = mergeCandidates([h1.candidates, llmCands]);
  // 渐进式发现：先以 lead 线索卡广播，让用户尽早看到“在找”（最终被滤掉的线索卡会在收尾时 brand_removed）
  const _leadIds = [];
  for (const c of candidates.slice(0, 24)) {
    const _id = slug(c.name, _leadIds.length);
    _leadIds.push(_id);
    if (emit) emitT('brand_found', { projectId: pid, tier: 'lead', card: {
      id: _id, name: c.name || ('线索' + (_leadIds.length)), url: c.url || '', tier: c.tier || 'unknown',
      matchScore: 0, why: c.why || '全网/维度命中线索', status: 'lead', evidenceCount: c.evidenceCount || 0, confidence: 'low' } });
  }
  const afterHarvest = candidates.slice();
  candidates = crossValidate(candidates, allFanout);
  // LLM 枚举且无任何搜索证据的候选 → 剔除（知识可能过时/幻觉，验证是铁律）
  candidates = candidates.filter(c => !(c.src === 'llm' && (c.evidenceCount || 0) === 0 && !c.serpKnown));
  const afterCross = candidates.slice();
  // 相关性二次裁判：捕获"设备/打印机/OEM代工/原材料供应商/平台"等周边企业（harvest 自报分漏判的无关项）
  const judgments = await rejudgeRelevance(trackWork, candidates, allFanout, dsKey);
  _stage('rejudge');
  candidates = applyRelevanceJudgments(candidates, judgments);
  candidates = candidates.filter(c => c.relevant && (Number(c.categoryFit) || 0) >= 60);
  // 市场存在度门槛：剔除"基本没浏览/没曝光"的单次噪声（跨 <2 个查询且无官网）
  candidates = presenceGate(candidates);
  const afterRelevance = candidates.slice();
  if (emit) emitT('discover_stage', { projectId: pid, stage: 'validating', label: '正在校验对手相关性与市场存在度…', pct: 70, found: candidates.length });
  candidates = rankCandidates(candidates).slice(0, 18);
  // 硬信号生效：剔除上一轮用户在本赛道移除过的品牌（按名字×赛道），零风险自动排除
  const supRes = applySuppression(candidates, carrySuppressed, track);
  candidates = supRes.kept;
  const suppressedDropped = supRes.dropped;
  // 软信号生效：仅执行你已「采纳」的规则（未审的规则一律不生效）
  const ruleRes = applyApprovedRules(candidates, carryRules);
  candidates = ruleRes.kept;
  try { safeWrite(path.join(DATA, 'debug_discover.json'), JSON.stringify({
    trackReceived: track, translatedFrom, trackWork, marketLang, cjkResult: isCJK(trackWork), provider: (config.search && config.search.provider) || 'tavily', gl,
    queries, round2Queries: labels2, llmEnumerated: llmCands.map(c => c.name),
    fanoutCounts: allFanout.map(f => (f.results || []).length),
    afterHarvest: afterHarvest.map(c => ({ name: c.name, match: c.matchScore, ev: c.evidenceCount, dh: c.distinctHits, url: c.url, tier: c.tier, src: c.src || 'serp' })),
    afterCross: afterCross.map(c => ({ name: c.name, match: c.matchScore, ev: c.evidenceCount, dh: c.distinctHits, url: c.url })),
    rejudge: candidates.length ? null : judgments, // 仅当被全滤掉时保留裁判明细便于排查
    afterRelevance: afterRelevance.map(c => ({ name: c.name, match: c.matchScore, fit: c.categoryFit, dh: c.distinctHits, url: c.url, rel: c.relReason || '' })),
    suppressedDropped, approvedRuleHits: ruleRes.hits,
    final: candidates.map(c => ({ name: c.name, match: c.matchScore, fit: c.categoryFit, dh: c.distinctHits, ev: c.evidenceCount }))
  }, null, 1)); } catch {}

  let competitors = candidates.map((c, i) => ({ // B-6：let 以支持域级去重重排
    id: slug(c.name, i),
    name: c.name || ('竞品' + (i + 1)),
    url: c.url || '',
    why: c.why || '',
    discoverWhy: c.why || '', // #304 保留发现阶段归类理由，供字段撕裂交叉校验
    categoryTearing: false, tearingNote: '', // #304 字段撕裂标记
    tier: c.tier || 'unknown', // large/mid/small/emerging/unknown
    matchScore: c.matchScore || 0,
    evidenceCount: c.evidenceCount || 0,
    confidence: c.confidence || 'low',
    entityAmbiguous: !!c.entityAmbiguous,
    ambiguousNote: c.ambiguousNote || '',
    rankScore: c.rankScore || 0,
    status: 'skeleton', // skeleton -> researching -> done | error
    manual: false,
    channels: {}, priceBand: null, pricePoints: [], freebies: [], audiences: [], regions: [],
    products: [], reviews: null, positioning: '', customization: null, estSize: null, techStack: null,
    recentMoves: [], contentForms: [], collabTypes: [], fulfillment: [],
    sellingPoints: [], tactics: [], painPoints: [], fieldSources: {},
    attempts: [],
    inferred: [], timeline: null, reviewSnippets: [], priceForensic: null,
    foundedYear: null, growth: 'unknown', demandAlignments: [],
    evidence: '', researchedAt: null
  }));

  // ▶ 数据卫生②：自动排除用户自有品牌（输入竞品集排除自有实体；空白视图分母只计外部竞品）
  // 不依赖 LLM，纯字符串/域名匹配；无 ownBrands 配置则零误伤。
  const ownEx = autoExcludeOwnBrands(competitors, (config && config.ownBrands) || []);

  // ▶ 加固（0812 体验报告）：复用顶部已落盘的 _initState（含 discoverDone:false），
  // 避免二次构建覆盖首次落库；以下赋值覆盖学习信号，幂等无害。
  const state = _initState;
  state.excluded = ownEx.excluded.slice(); // 闸门：用户标记为"不算对手"的竞品 id（零焦虑：默认全参与，移除可拉回）；自有品牌自动预填
  state.excludedReasons = Object.assign({}, ownEx.reasons); // id -> 移除原因（EXCLUDE_REASONS key / 'own-brand' 自动排除），喂养算法迭代
  state.suppressed = carrySuppressed.slice(); // 承接上一轮学习信号（按名字×赛道），discover 自动排除
  state.addedCompetitors = carryAdded.slice(); // 承接上一轮「补对手」正向信号
  state.ruleDecisions = JSON.parse(JSON.stringify(carryRules)); // 承接已审规则（采纳的持续生效，否决的不再复问）
  // 注：_initState 已含 intent.platforms / tenantId / setCurrentId / saveState / mirrorProjectToDb，
  // 此处不重复（避免二次 saveState 覆盖 discoverDone）。
  // ▶ B-6（2026-09-12 任务书·修订版）D2 域级去重：同域名只保留 matchScore 最高者（无 url 退化用归一化名）。
  // 复检实锤同域候选成对深研白烧 ~3 分钟（如 Nutramax/VetriScience 重复）；去重必须在排名收尾前做，
  // 否则 HHI/份额被重复样本中度扭曲。
  // 初版 filter 写法三重错（被保留者误入 brand_removed、高分替换者被静默丢弃、永远留第一个而非最优），
  // 修订为纯函数 dedupeByDomain（先选最优建 map → 按 droppedIds 一次性过滤），逻辑与单测见 research/dedupe.js。
  const _dedup = dedupeByDomain(competitors, c =>
    domainOf(c.url) || String(c.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  competitors = _dedup.kept;
  const _droppedDup = _dedup.dropped;
  // 渐进式发现：把被最终过滤掉的 lead 线索卡移除，再逐张广播确认卡（skeleton）
  const finalIds = new Set(competitors.map(c => c.id));
  for (const lid of _leadIds) {
    if (!finalIds.has(lid)) { if (emit) emitT('brand_removed', { projectId: pid, id: lid, reason: 'filtered' }); }
  }
  // B-6：被去重的候选显式广播（前端据此移除对应线索/骨架卡，不做静默丢弃）
  if (emit) for (const d of _droppedDup) emitT('brand_removed', { projectId: pid, id: d.id, reason: 'duplicate', name: d.name });
  if (emit) emitT('discover_stage', { projectId: pid, stage: 'ranking', label: '已确认对手，正在汇总…', pct: 90, found: competitors.length });
  for (const c of competitors) {
    state.competitors.push(c);
    state.progress.total = state.competitors.length;
    saveState(state); // 增量落盘（关键：刷新/轮询可恢复）
    if (emit) emitT('brand_found', { projectId: pid, tier: 'skeleton', card: {
      id: c.id, name: c.name, url: c.url, tier: c.tier, matchScore: c.matchScore,
      why: c.why, status: 'skeleton', evidenceCount: c.evidenceCount, confidence: c.confidence } });
  }
  mirrorProjectToDb(pid, requestScope.getStore() || state.tenantId, state.track); // T3-1：镜像进 db 项目清单
  state.discoverDone = true; saveState(state); // 标记发现完成（供前端 SSE 断开时的轮询兜底判定收尾）
  if (emit) emitT('discover_complete', { projectId: pid, total: state.competitors.length });
  // 后台逐家深研（不阻塞返回）
  enqueueResearch(state, config);
  return state;
}

// 异步启动发现（不阻塞 HTTP 响应）：同步返回 projectId 给 handler 组成 202；
// 管线在 setImmediate 里异步跑，结束（成功/失败）时释放并发闸。
function discoverLaunch(track, intent, config, gate) {
  const projectId = newProjectId(track);
  setImmediate(() => {
    runDiscover(track, intent, config, emitSSE, projectId)
      .catch(e => {
        const code = e.message === 'NO_KEYS' ? 'NO_KEYS'
                   : (e.message === 'SEARCH_QUOTA' || e.message === 'ENRICH_QUOTA') ? 'quota'
                   : 'DISCOVER_FAILED';
        try { Logger.error('discover-failed', { projectId, code, message: String(e.message || e), stack: String(e.stack || '').slice(0, 600) }); } catch {}
        emitSSE('discover_error', { projectId, code, message: String(e.message || e) });
      })
      .finally(() => { if (gate) gate.leave(); });
  });
  return { projectId };
}


module.exports = { isCJK, needsTranslation, translateToMarketLang, buildFanoutQueries, llmEnumerate, harvestCandidates, runDiscover, discoverLaunch };
