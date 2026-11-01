'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/discover.js —— 导出: isCJK, needsTranslation, translateToMarketLang, buildFanoutQueries, llmEnumerate, harvestCandidates, runDiscover, discoverLaunch
// ============================================================

const { activeSearchKey } = require('../core/config.js');
const { DATA } = require('../core/paths.js');
const { requestScope } = require('../core/als.js');
const { emitSSE } = require('../core/sse-hub.js');
const { getCurrentId, loadState, mirrorProjectToDb, newProjectId, readProject, resolveTenantId, saveState, setCurrentId } = require('../core/state-store.js');
const { fanoutSearch } = require('./search.js');
const { domainOf } = require('./net.js'); // B-6：域级去重用
const { dedupeByDomain } = require('./dedupe.js'); // B-6 修订版：纯函数去重（可单测）
const { llmJSON, deepseekJSON, llmApiKey } = require('./llm.js');
const { normalizeIntent, resolvePlatforms } = require('./vocab.js');
const { applyApprovedRules, applyRelevanceJudgments, applySuppression, crossValidate, mergeCandidates, normName, presenceGate, rankCandidates, rejudgeRelevance, slug } = require('./candidates.js');
const { enqueueResearch } = require('./enrich.js');
const Logger = require('../services/logger.js');
const db = require('../services/db.js');
const { safeWrite } = require('../lib/fs-util.js');
const { glFromRegions } = require('../services/providers/search.js');
const { autoExcludeOwnBrands } = require('../lib/own-brand.js');
const Telemetry = require('../observability/telemetry.js'); // Phase 1 真实基线：阶段度量
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
// P0 整改（2026-11）：候选提取是关键链路 → failureMode:'throw'——模型不可用必须显式失败，
// 绝不允许降级成空候选后把「模型故障」冒充成「市场上没有品牌」。
async function llmEnumerate(track, intent, dsKey) {
  const regions = (intent && intent.regions && intent.regions.length) ? intent.regions.join('/') : 'us(北美为主)';
  const sys = `你是资深消费品行业分析师。基于你的既有知识，枚举"${track}"赛道（主要市场：${regions}）真实存在的品牌。
要求（宁缺毋滥，控制在 8-10 个）：
- 头部(large) 2-3、腰部(mid) 2-3、小众(small) 1-2、新兴(emerging) 1-2。
- 每个给 name（品牌官方英文名优先）、url（官网域名，不确定就留空，绝不编造）、tier、matchScore(0-100 整数)、why（不超过 6 个字的极简短语，如"主流大牌"）。
- 只列你有把握真实存在的；宁缺毋滥。
- 只列独立品牌，绝不列平台/市场（Etsy、Amazon、Amazon Custom、TikTok Shop、eBay 等都是平台，不是品牌）。
输出 JSON：{"candidates":[{"name":"","url":"","tier":"","matchScore":0,"why":""}]}`;
  // 大输出调用：超时放宽到 90s、重试 1 次（避免 45s 阈值触发重试翻倍）
  const j = await llmJSON([{ role: 'system', content: sys }, { role: 'user', content: `赛道：${track}；意图：${JSON.stringify(intent || {})}` }], dsKey, null, { fieldKey: 'discover-enumerate', timeoutMs: 90000, maxAttempts: 2, thinking: false, failureMode: 'throw' });
  return ((j && j.candidates) || []).map(c => { c.src = 'llm'; return c; });
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
  // 大输出调用：超时放宽到 90s、重试 1 次（避免 45s 阈值触发重试翻倍）。
  // P0 整改（2026-11）：候选提取关键链路 → failureMode:'throw'（模型故障不得冒充空结果）。
  const j = await llmJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'discover-harvest', timeoutMs: 90000, maxAttempts: 2, thinking: false, failureMode: 'throw' });
  return { candidates: (j && j.candidates) || [], moreQueries: Array.isArray(j && j.moreQueries) ? j.moreQueries.slice(0, 3) : [] };
}

// 步骤1 主流程：知识枚举 + 两轮迭代搜索 + 合并验证，返回骨架卡（不等待深研）
// r2 追加 opts.reuse：复用既有项目重跑（重新识别）。语义差异只有两条：
//   ① 绝不先用空态覆盖旧档案（旧品牌结果在成功前一直原样保留）；
//   ② 旧结果存在时，新结果只留在内存，全链路成功后一次性原子替换（atomic）。
async function runDiscover(track, intent, config, emit, projectId, runId, opts) {
  const o = opts || {};
  const reuse = !!o.reuse;
  const sKey = activeSearchKey(config);
  const dsKey = llmApiKey(config);
  if (!sKey || !dsKey) throw new Error('NO_KEYS');
  const pid = projectId || newProjectId(track);
  // 审核整改 §一：runId 每次执行独立生成（不可碰撞）；projectId 仅作关联键
  const _runId = runId || Telemetry.newRunId();
  const _t0 = Date.now();
  const _tenantId = resolveTenantId();
  // 复用：读盘上旧档案（只读，不写）。读不到则按新项目处理（不会凭空产生空档案）
  const prev = reuse ? (readProject(pid, _tenantId) || null) : null;
  const prevComps = Array.isArray(prev && prev.competitors) ? prev.competitors : [];
  const hadBrands = prevComps.length > 0;
  // 内部运行序号（不新增业务枚举）：同一项目每次执行 attemptNo+1，用户可见项目始终只有一个
  const attemptNo = ((prev && prev.discoverRun && Number(prev.discoverRun.attemptNo)) || 0) + 1;
  // 原子替换：旧结果存在 → 本次新结果先留在内存，成功后整体替换；失败则旧结果一行不动
  const atomic = !!(prev && hadBrands);
  // ▶ 加固（0812 体验报告）：发现启动即落空状态——即使后续外部调用全失败（密钥失效等），
  // 项目也已落库、state.track 立即可见、/api/projects 立即可列出、轮询兜底恒有数据，杜绝「永久空白」。
  // r2：复用模式以旧档案为基底叠加，绝不把 competitors 清空。
  const _initState = Object.assign({}, prev || {}, {
    projectId: pid,
    track,
    intent: normalizeIntent(intent),
    competitors: prev ? prevComps : [],
    discoveredAt: (prev && prev.discoveredAt) || new Date().toISOString(),
    progress: prev
      ? { total: prevComps.length, done: prevComps.filter(c => c && c.status === 'done').length }
      : { total: 0, done: 0 },
    excluded: (prev && Array.isArray(prev.excluded)) ? prev.excluded : [],
    excludedReasons: (prev && prev.excludedReasons) || {},
    suppressed: (prev && Array.isArray(prev.suppressed)) ? prev.suppressed : [],
    addedCompetitors: (prev && Array.isArray(prev.addedCompetitors)) ? prev.addedCompetitors : [],
    ruleDecisions: (prev && prev.ruleDecisions) || {},
    fieldCorrections: (prev && Array.isArray(prev.fieldCorrections)) ? prev.fieldCorrections : [],
    signals: (prev && prev.signals) || {},
    whiteSpace: (prev && prev.whiteSpace) || null,
    brief: (prev && prev.brief) || null,
    discoverDone: false,
    discovering: true, // 进行中标记：读态据此区分「正在更新」与「历史未完成」
    runId: _runId, // 审核整改 §一：runId 随 state 持久化，深研队列/报告/指定品牌后续段沿用同一 run
    discoverRun: { runId: _runId, attemptNo, status: 'running', startedAt: new Date().toISOString(), reuse: !!prev },
  });
  // 注意：清标记必须显式写 null——saveState 是「磁盘为基底 + 本态覆盖」的合并写，
  // 直接 delete 字段不会删掉磁盘上的旧值（失败标记会一直残留）。
  _initState.discoverError = null; // 新一轮开始：清掉上一次失败态（历史留档在 discoverRunHistory）
  _initState.discoverEmpty = null; // 空市场标记只属于上一次成功运行，本轮重新判定
  _initState.intent = _initState.intent || {};
  _initState.intent.platforms = resolvePlatforms({
    platforms: (intent && intent.platforms) || _initState.intent.platforms,
    regions: _initState.intent.regions,
  });
  _initState.tenantId = _tenantId;
  // 业务事件显式携带 tenantId（后台队列可能脱离请求上下文；sse-hub 据此按租户投递）
  const emitT = (t, p) => (typeof emit === 'function') ? emit(t, Object.assign({}, p, { tenantId: _tenantId })) : undefined;
  setCurrentId(pid, _tenantId);
  saveState(_initState);                                  // ← 关键：首个外部 await 之前落盘
  // Phase 1 可观测性：调研起点（request_received + runs 起始时间戳），运行上下文供深层
  // searchProvider/LLM 调用零签名归因。审核整改 §一：runId 与 projectId 严格分离——
  // runId 由 discoverLaunch 生成并透传（错误路径也要用同一个 runId 终结），每次执行独立。
  const _runCtx = { runId: _runId, tenantId: _initState.tenantId, projectId: pid };
  Telemetry.beginRun(_runCtx);
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
  // 审核整改 §五：candidate_enumeration 使用自身起止时间——翻译与枚举并行，
  // 枚举计时不得把并行等待翻译的时间计入（旧实现误用 _tR1 基准）
  const _tEnum = Date.now();
  const enumP = llmEnumerate(track, intent, dsKey).then(v => { _stage('llmEnumerate-done'); return v; });
  let translateFailed = false;
  try {
    await translateP;
  } catch (e) {
    translateFailed = true;
    Telemetry.recordStage(Object.assign({}, _runCtx, { stage: 'translate', durationMs: Date.now() - _tR1, status: 'error', errorCode: 'TRANSLATE_FAILED' }));
    // 翻译失败不阻断（枚举用原文赛道）：吞掉异常继续（translateP 内部已吞，此处防御）
  }
  _stage('translate');
  if (!translateFailed) {
    Telemetry.recordStage(Object.assign({}, _runCtx, { stage: 'translate', durationMs: Date.now() - _tR1, status: 'ok' }));
  }
  // 承接上一轮的学习信号（用户反馈）：按名字×赛道记的 suppressed / 用户补的对手，跨次 discover 保留
  // r2：复用同一项目时以该项目档案为源（不依赖当前指针，避免重试非当前项目时读错）
  const prevState = (reuse && prev) ? prev : (loadState() || {});
  const carrySuppressed = Array.isArray(prevState.suppressed) ? prevState.suppressed : [];
  const carryAdded = Array.isArray(prevState.addedCompetitors) ? prevState.addedCompetitors : [];
  const carryRules = prevState.ruleDecisions && typeof prevState.ruleDecisions === 'object' ? prevState.ruleDecisions : {};

  // SERP 扇出只依赖翻译结果构造查询：翻译完成即启动，与枚举重叠——
  // 枚举结果到第二轮候选验证才需要，不让 90s 级的枚举挡住 15s 级的搜索
  const queries = buildFanoutQueries(trackWork, intent);
  const _tFan = Date.now();
  const fanoutP = Telemetry.withRun(_runCtx, () => fanoutSearch(queries, config, gl)).then(v => { _stage('fanout-done'); return v; });
  fanoutP.catch(() => {}); // enumP 先失败时避免 fanout 成为未处理的 rejection
  let llmCands;
  try {
    llmCands = await enumP;
  } catch (e) {
    Telemetry.recordStage(Object.assign({}, _runCtx, { stage: 'candidate_enumeration', durationMs: Date.now() - _tEnum, status: 'error', errorCode: 'ENUM_FAILED' }));
    throw e;
  }
  Telemetry.recordStage(Object.assign({}, _runCtx, { stage: 'candidate_enumeration', durationMs: Date.now() - _tEnum, status: 'ok' }));
  const fanout = await fanoutP;
  Telemetry.recordStage(Object.assign({}, _runCtx, { stage: 'search_round_1', durationMs: Date.now() - _tFan, status: 'ok' }));
  if (emit) emitT('discover_stage', { projectId: pid, stage: 'enumerating', label: '已枚举候选品牌，正在全网搜索…', pct: 15, found: llmCands.length });
  if (emit) emitT('discover_stage', { projectId: pid, stage: 'searching', label: '正在多维度搜索竞争品牌（覆盖各体量）…', pct: 30, found: fanout.length });
  _stage('round1（total ' + ((Date.now() - _tR1) / 1000).toFixed(1) + 's）');
  if (!fanout.length && !llmCands.length) throw new Error('SEARCH_FAILED');

  const _tH = Date.now();
  let h1;
  try {
    h1 = await harvestCandidates(trackWork, intent, fanout, dsKey, queries);
  } catch (e) {
    Telemetry.recordStage(Object.assign({}, _runCtx, { stage: 'harvest', durationMs: Date.now() - _tH, status: 'error', errorCode: 'HARVEST_FAILED' }));
    throw e;
  }
  _stage('harvest（total ' + ((Date.now() - _tH) / 1000).toFixed(1) + 's）');
  Telemetry.recordStage(Object.assign({}, _runCtx, { stage: 'harvest', durationMs: Date.now() - _tH, status: 'ok' }));
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
    const _tF2 = Date.now();
    const fan2 = await Telemetry.withRun(_runCtx, () => fanoutSearch(round2, config, gl));
    allFanout = allFanout.concat(fan2);
    Telemetry.recordStage(Object.assign({}, _runCtx, { stage: 'search_round_2', durationMs: Date.now() - _tF2, status: 'ok' }));
  }
  _stage('round2');

  // 合并三路候选：SERP harvest + LLM 枚举；用全部原始结果交叉验证（LLM 候选无搜索痕迹则黜落）
  let candidates = mergeCandidates([h1.candidates, llmCands]);
  // r2 §四.7：搜索结果只作内部候选——不再把未核验线索当竞品卡片广播给用户
  // （旧实现把 24 条 search snippet 作为 tier:'lead' 卡片直出，用户会误读为已确认竞品）。
  const afterHarvest = candidates.slice();
  candidates = crossValidate(candidates, allFanout);
  // LLM 枚举且无任何搜索证据的候选 → 剔除（知识可能过时/幻觉，验证是铁律）
  candidates = candidates.filter(c => !(c.src === 'llm' && (c.evidenceCount || 0) === 0 && !c.serpKnown));
  const afterCross = candidates.slice();
  // 相关性二次裁判：捕获"设备/打印机/OEM代工/原材料供应商/平台"等周边企业（harvest 自报分漏判的无关项）
  const _tRj = Date.now();
  let judgments;
  try {
    judgments = await rejudgeRelevance(trackWork, candidates, allFanout, dsKey);
  } catch (e) {
    Telemetry.recordStage(Object.assign({}, _runCtx, { stage: 'relevance_check', durationMs: Date.now() - _tRj, status: 'error', errorCode: 'REJUDGE_FAILED' }));
    throw e;
  }
  _stage('rejudge');
  Telemetry.recordStage(Object.assign({}, _runCtx, { stage: 'relevance_check', durationMs: Date.now() - _tRj, status: 'ok' }));
  candidates = applyRelevanceJudgments(candidates, judgments);
  candidates = candidates.filter(c => c.relevant && (Number(c.categoryFit) || 0) >= 60);
  // 市场存在度门槛：剔除"基本没浏览/没曝光"的单次噪声（跨 <2 个查询且无官网）
  candidates = presenceGate(candidates);
  const afterRelevance = candidates.slice();
  if (emit) emitT('discover_stage', { projectId: pid, stage: 'validating', label: '正在校验竞争品牌相关性与市场存在度…', pct: 70, found: candidates.length });
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
    priceStats: null, priceVerdict: null, soldOutCount: 0, typeDist: null, // 深研填充（价格三件套/S3 判定/断货/类目占比）
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
  // B-6：被去重的候选显式广播（前端据此移除对应骨架卡，不做静默丢弃）
  if (emit) for (const d of _droppedDup) emitT('brand_removed', { projectId: pid, id: d.id, reason: 'duplicate', name: d.name });
  if (emit) emitT('discover_stage', { projectId: pid, stage: 'ranking', label: '已确认竞争品牌，正在汇总…', pct: 90, found: competitors.length });
  if (competitors.length) Telemetry.milestone(_runId, 'milestone_first_brand'); // 里程碑：首个已核验品牌
  let atomicNext = null;
  if (atomic) {
    // r2 §四：已有旧结果 → 新结果先留在内存，不触碰 state.competitors、不广播骨架卡
    // （旧品牌继续可见；本次失败时旧结果一行不动；成功时在收尾处一次性原子替换）
    atomicNext = competitors;
  } else {
    for (const c of competitors) {
      state.competitors.push(c);
      state.progress.total = state.competitors.length;
      saveState(state); // 增量落盘（关键：刷新/轮询可恢复）
      if (emit) emitT('brand_found', { projectId: pid, tier: 'skeleton', card: {
        id: c.id, name: c.name, url: c.url, tier: c.tier, matchScore: c.matchScore,
        why: c.why, status: 'skeleton', evidenceCount: c.evidenceCount, confidence: c.confidence } });
    }
  }
  mirrorProjectToDb(pid, requestScope.getStore() || state.tenantId, state.track); // T3-1：镜像进 db 项目清单
  // ▶ 市场热度（T0·Google Trends，抓取需求 §2.6 / 算法规格 §5.6）：赛道词+头部品牌词一次对比，
  // 4 周窗口斜率（±10% 死区）→ 涨/跌/平；品牌/赛道声量比 → 声量评级；全部 C 级佐证。
  // 不阻塞发现收尾（fire-and-forget，落盘由回调完成）；失败 → status:'unprobed'，不用旧缓存冒充新数据。
  try {
    const Trends = require('../services/providers/trends.js');
    const MT = require('../lib/market-trends.js');
    const TRENDS_GEO = { us: 'US', uk: 'GB', eu: 'DE', jp: 'JP', cn: 'CN', sea: '' };
    const geo = TRENDS_GEO[(state.intent.regions && state.intent.regions[0]) || ''] || '';
    const terms = [trackWork].concat(competitors.slice(0, 4).map(c => c.name)).slice(0, 5);
    Trends.interestOverTime(terms, config, { geo })
      .then(raw => {
        state.marketTrends = raw.ok
          ? MT.summarize(raw, { track: trackWork })
          : { status: 'unprobed', reason: String(raw.error || 'trends-unavailable').slice(0, 120), track: trackWork };
        try { Logger.info('discover-trends', { projectId: pid, status: state.marketTrends.status || 'ok', verdict: state.marketTrends.verdict || null }); } catch (e2) {}
        saveState(state);
      })
      .catch(e => {
        state.marketTrends = { status: 'unprobed', reason: String(e && e.message || e).slice(0, 120), track: trackWork };
        try { saveState(state); } catch (e2) {}
      });
  } catch (e) {
    state.marketTrends = { status: 'unprobed', reason: String(e && e.message || e).slice(0, 120), track: trackWork };
  }
  // P0 整改（2026-11）：只有完整流程成功结束、且确实没有品牌通过交叉核验时，
  // 才允许以「未找到已核验品牌」收尾——显式标记，绝不与"模型故障导致的空"混淆。
  // r2 §四：全链路成功后才原子替换项目品牌列表（旧结果在此之前一行未动）。
  if (atomicNext) {
    const before = state.competitors.length;
    state.competitors = atomicNext;
    state.discoverReplace = { runId: _runId, attemptNo, at: new Date().toISOString(), brandsBefore: before, brandsAfter: atomicNext.length };
  }
  state.progress = { total: state.competitors.length, done: state.competitors.filter(c => c && c.status === 'done').length };
  if (!state.competitors.length) state.discoverEmpty = true; else state.discoverEmpty = null;
  state.discovering = false;
  state.discoverRun = { runId: _runId, attemptNo, status: 'success', startedAt: (state.discoverRun && state.discoverRun.startedAt) || null, finishedAt: new Date().toISOString() };
  state.discoverDone = true; saveState(state, { replaceCompetitors: !!atomicNext }); // 标记发现完成（供前端 SSE 断开时的轮询兜底判定收尾）
  if (emit) emitT('discover_complete', { projectId: pid, total: state.competitors.length, updated: !!atomicNext, attemptNo });
  // 后台逐家深研（不阻塞返回）
  enqueueResearch(state, config);
  return state;
}

// ============================================================
// P0 整改（2026-11）：任务失败显式化 + 同请求幂等
// ------------------------------------------------------------
// · discoverInflight：同租户进行中的发现任务表（tenantId → projectId）。同一请求
//   重试/双开页重复提交 → 返回同一 projectId，绝不产生重复项目、重复任务或重复扣额。
//   （单进程架构下完备；多副本部署需换共享锁——与 handlers/collect.js briefInflight 同口径。）
// · 失败终态：把 errorCode / 用户可读 errorMessage / failedAt / previousProjectId
//   持久进项目档案（discoverError 字段），SSE 只作加速通知——前端断线后凭状态查询
//   仍能恢复最终失败。绝不把模型故障写成 competitors:[] 的伪成功空结果。
// · 错误载荷纪律：state/SSE 只放归一错误码与用户可读文案；原始异常只进日志。
// ============================================================
const discoverInflight = new Map(); // tenantId -> projectId
// 归一错误码 → 用户可读文案（不含内部细节/原始异常文本；与前端映射保持一致）
function discoverUserMessage(code, e) {
  if (e && e.userMessage && e.name === 'LLMError') return e.userMessage;
  switch (code) {
    case 'NO_KEYS': return '品牌识别服务尚未配置，请联系平台管理员完成配置。';
    case 'quota': return '研究额度已用尽，请明天再试或联系平台管理员。';
    case 'SEARCH_QUOTA': return '搜索服务额度不足，请稍后再试或联系平台管理员。';
    case 'SEARCH_FAILED': return '搜索服务暂不可用，请稍后重新识别。';
    case 'LLM_AUTH_REJECTED': return '品牌识别服务鉴权失败（密钥无效或未获模型授权）。';
    case 'LLM_MODEL_UNAVAILABLE': return '品牌识别服务当前模型不可用，请联系平台管理员。';
    case 'LLM_RATE_LIMITED': return '品牌识别服务额度受限，请稍后重新识别。';
    case 'LLM_TIMEOUT':
    case 'LLM_PROVIDER_UNAVAILABLE':
    case 'LLM_INVALID_RESPONSE': return '品牌识别服务暂不可用，请稍后重新识别。';
    default: return '本次品牌识别未完成，请稍后重新识别。';
  }
}
function discoverErrorCode(e) {
  if (e && e.name === 'LLMError' && e.code) return e.code;
  const m = e && e.message;
  if (m === 'NO_KEYS') return 'NO_KEYS';
  if (m === 'ENRICH_QUOTA') return 'quota'; // 用户今日研究额度
  if (m === 'SEARCH_QUOTA') return 'SEARCH_QUOTA'; // 搜索服务额度不足（区分于用户额度）
  return 'DISCOVER_FAILED';
}

// 异步启动发现（不阻塞 HTTP 响应）：同步返回 projectId 给 handler 组成 202；
// 管线在 setImmediate 里异步跑，结束（成功/失败）时释放并发闸与幂等登记。
// 返回 { projectId, reused, runId, attemptNo }：
//   reused=true 表示「同一目标已有进行中任务」，本次幂等复用（调用方不得重复扣额/重复入闸）。
// opts.reuseProjectId（r2 §三）：同一租户、同一项目、同一查询条件下「重新识别」必须复用
// 原 projectId——用户可见项目永远只有一个，历史失败靠 runId/attemptNo 在档案内区分。
function discoverLaunch(track, intent, config, gate, opts) {
  const o = opts || {};
  const tid = resolveTenantId();
  const reuseProjectId = o.reuseProjectId ? String(o.reuseProjectId) : null;
  // 幂等键：重试按「租户 + 项目」分桶（同一项目的双击只跑一次）；首次发现仍按租户分桶。
  const inflightKey = reuseProjectId ? (tid + '|' + reuseProjectId) : tid;
  if (discoverInflight.has(inflightKey)) return { projectId: discoverInflight.get(inflightKey), reused: true };
  const reuse = !!reuseProjectId;
  const projectId = reuse ? reuseProjectId : newProjectId(track);
  // 复用前先确认档案确属本租户（handler 已校验，这里再兜一道：拿不到就退回新建）
  const prevState = reuse ? readProject(projectId, tid) : null;
  const attemptNo = ((prevState && prevState.discoverRun && Number(prevState.discoverRun.attemptNo)) || 0) + 1;
  discoverInflight.set(inflightKey, projectId);
  // 上一次成功结果指针：失败面板用它引导用户回到旧结果（旧项目档案永不覆盖）
  let prevPointer = null;
  try { prevPointer = getCurrentId(tid); } catch { prevPointer = null; }
  // 审核整改 §一：runId 在启动点生成并透传——成功路径与失败 catch 用同一个 runId 终结
  const runId = Telemetry.newRunId();
  // done：本次执行（成功/失败）的完成句柄。调用方（HTTP handler）不等待——仅为
  // 测试与运维探针提供确定性收尾观测；不改变既有异步行为。
  let _settleDone = null;
  const done = new Promise((r) => { _settleDone = r; });
  setImmediate(() => {
    runDiscover(track, intent, config, emitSSE, projectId, runId, { reuse })
      .catch(e => {
        const code = discoverErrorCode(e);
        const msg = discoverUserMessage(code, e);
        Telemetry.endRun(runId, 'error', code); // 失败终态：total.status=error + 受控 code，绝不产生 milestone_all_done
        try { Logger.error('discover-failed', { projectId, code, message: String(e.message || e), stack: String(e.stack || '').slice(0, 600) }); } catch {}
        // 持久失败态：写进本次项目档案，保留审计；绝不伪成功。
        // r2 §四.5：复用同一项目且已有成功结果 → 旧品牌原样保留（keptPrevious），
        // 失败只叠加错误说明；绝不把旧结果清零，也绝不把失败说成「没有品牌」。
        try {
          const s = readProject(projectId, tid) || loadState();
          if (s && s.projectId === projectId) {
            const kept = Array.isArray(s.competitors) && s.competitors.length > 0;
            s.discoverError = {
              errorCode: code,
              errorMessage: msg,
              failedAt: new Date().toISOString(),
              previousProjectId: kept ? null : ((prevPointer && prevPointer !== projectId) ? prevPointer : null),
              keptPrevious: kept,
              attemptNo,
            };
            s.discovering = false;
            s.discoverRun = {
              runId, attemptNo, status: 'failed',
              startedAt: (s.discoverRun && s.discoverRun.startedAt) || null,
              finishedAt: new Date().toISOString(), errorCode: code,
            };
            s.discoverRunHistory = (Array.isArray(s.discoverRunHistory) ? s.discoverRunHistory : [])
              .concat([{ runId, attemptNo, status: 'failed', errorCode: code, finishedAt: s.discoverRun.finishedAt, brandsBefore: (s.competitors || []).length }])
              .slice(-10);
            // 有旧结果 → 旧结果仍是完整成功结果（discoverDone 保持 true）；无旧结果 → 未完成
            s.discoverDone = kept ? true : false;
            if (!kept) s.discoverEmpty = null;
            saveState(s);
          }
        } catch (e2) { /* 持久化失败不影响错误上报 */ }
        emitSSE('discover_error', { projectId, code, message: msg, keptPrevious: !!(prevState && (prevState.competitors || []).length), tenantId: tid });
      })
      .finally(() => {
        if (discoverInflight.get(inflightKey) === projectId) discoverInflight.delete(inflightKey);
        if (gate) gate.leave();
        if (_settleDone) _settleDone(null);
      });
  });
  return { projectId, reused: false, reuse, runId, attemptNo, done };
}


module.exports = { isCJK, needsTranslation, translateToMarketLang, buildFanoutQueries, llmEnumerate, harvestCandidates, runDiscover, discoverLaunch };
