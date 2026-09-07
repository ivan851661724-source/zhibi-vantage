'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/report.js —— 导出: dimensionCoverage, assembleFacts, isClaimLine, validateReport, buildReport
// ============================================================

const { APP_COMMIT, APP_VERSION, STARTED_AT, reportProvenance } = require('../core/version.js');
const { deepseekText, llmApiKey } = require('./llm.js');
const { fmtMoney, seedingLabel } = require('./vocab.js');
const { assessPositioning, computeWhiteSpace } = require('./whitespace.js');
const M = require('../lib/metrics.js');
const { computeOpportunityMap } = require('../lib/opportunity.js');
const { evidenceDistribution } = require('../lib/evidence-dist.js');
const { channelTypeOf } = require('../lib/blue-ocean.js');

// ============================================================
// 步骤4：行业调研报告 v3 —— 8 章研究级装配（事实层不经 LLM 生成 + 强制引用 + 机器校验器 + 11 点 QC 门）
// ============================================================
// 事实层：直接从库里取带来源的事实，编号 F1、F2…（LLM 没有机会编造事实）
// ▶ 报告-数据同源 原则3：维度完整性闸门 —— 统计每个维度在 done 对手中的覆盖率；
// 覆盖率 < 50% 视为"未充分探测"，该维度不得进入报告原料（LLM 看不到），并计入"我们不知道"清单。
function dimensionCoverage(state) {
  const excluded = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) excluded.add(c.id); }); // #305 错配/低置信卡一并剔除
  const done = (state.competitors || []).filter(c => c.status === 'done' && !excluded.has(c.id));
  const total = done.length;
  const dims = {
    '渠道': c => Object.values(c.channels || {}).some(r => r && r.basis === 'verified'),
    '口碑': c => !!(c.reviews && c.reviews.rating != null && c.reviews.basis !== 'unverified'),
    '价格': c => (c.pricePoints || []).length > 0 || (c.priceBand && c.priceBand.basis !== 'unverified'),
    '卖点': c => (c.sellingPoints || []).length > 0,
    '打法': c => (c.tactics || []).length > 0,
    '动作': c => (c.recentMoves || []).some(m => m && m.basis === 'verified'),
    '定位': c => !!(typeof c.positioning === 'string' ? c.positioning : (c.positioning && (c.positioning.valueProposition || c.positioning.targetAudience || c.positioning.differentiation)))
  };
  const cov = {};
  const detected = [], undetected = [];
  for (const [name, fn] of Object.entries(dims)) {
    const present = done.filter(fn).length;
    const ratio = total ? present / total : 0;
    cov[name] = { present, total, ratio };
    (ratio < 0.5 ? undetected : detected).push(name);
  }
  return { cov, detected, undetected, total };
}
function assembleFacts(state) {
  const _ex = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) _ex.add(c.id); }); // #305 错配/低置信卡不进报告事实基数
  const done = (state.competitors || []).filter(c => c.status === 'done' && !_ex.has(c.id));
  const facts = [];
  // ▶ 报告-数据同源：suspect = 该事实来自被标 flaggedOutlier（量级离谱降级）的对手 → 决策链需标"数据存疑"
  const addFact = (text, source, suspect, dim) => {
    if (facts.length >= 60) return;
    facts.push({ id: 'F' + (facts.length + 1), text, source: source || null, suspect: !!suspect, dim: dim || null });
  };
  done.forEach(c => {
    const suspect = !!c.flaggedOutlier; // 该对手被数据卫生③降级 → 其事实默认存疑
    const src = (key) => {
      const fs0 = (c.fieldSources || {})[key];
      return fs0 && fs0.length ? fs0[0].url : (c.url || null);
    };
    // 渠道（只取 verified 的，事实层不收推测；只报选中平台）
    const plat = (state.intent && state.intent.platforms);
    Object.keys(c.channels || {}).forEach(k => {
      if (plat && plat.length && !plat.includes(k)) return; // 越界平台不进报告
      const r = c.channels[k];
      if (r.basis !== 'verified') return;
      const t = channelTypeOf(k);
      let txt;
      if (t === 'content') {
        // content 渠道：无官方店≠空白，以种草声量表述，绝不写"确认未进驻"
        if (r.seedingVolume && r.seedingVolume !== 'none') txt = `${c.name} 在 ${k} 种草声量${seedingLabel(r.seedingVolume)}（${r.note || '核查'}）`;
        else if (r.present) txt = `${c.name} 已进驻 ${k} 官方店（${r.note || '核查'}）`;
        else return;
      } else {
        txt = `${c.name} ${r.present ? '已进驻' : '确认未进驻'} ${k}（${r.note || '核查'}）`;
      }
      addFact(txt, src('channels.' + k), suspect, '渠道');
    });
    // #309：标签化区分价格带 / 单品价；单品价明确标注「非价格带锚点」，避免 ¥35 之类的单 SKU 价被当成品牌价位
    if (c.priceBand && c.priceBand.basis === 'verified') addFact(`${c.name} 价格带 ${c.priceBand.range}（${c.priceVerified ? '官网实抓' : '公开标价'}）`, src('priceBand'), suspect, '价格');
    if ((c.pricePoints || []).filter(n => typeof n === 'number' && n > 0).length && (!c.priceBand || c.priceBand.basis !== 'verified')) {
      const _pp = c.pricePoints.filter(n => typeof n === 'number' && n > 0);
      addFact(`${c.name} 单品价 ${fmtMoney(Math.min(..._pp), c.currency)} 起（共 ${_pp.length} 款在售标价，非价格带锚点）`, src('pricePoints'), suspect, '价格');
    }
    if (c.reviews && c.reviews.basis !== 'unverified' && c.reviews.rating != null) addFact(`${c.name} 口碑评分约 ${c.reviews.rating}，负面主题：${(c.reviews.negThemes || []).slice(0, 3).join('/') || '无'}`, src('reviews'), suspect, '口碑');
    (c.recentMoves || []).slice(0, 2).forEach((m, i) => { if (m.basis === 'verified') addFact(`${c.name} 近期动作：${m.desc}（${m.when || '时间不详'}）`, src('recentMoves.' + i), suspect, '动作'); });
    if ((c.sellingPoints || []).length) addFact(`${c.name} 主打卖点：${c.sellingPoints.join('/')}`, c.url || null, suspect, '卖点');
    if ((c.tactics || []).length) addFact(`${c.name} 销售打法：${c.tactics.join('/')}`, c.url || null, suspect, '打法');
  });
  // 优化二：受控词表互斥冲突摘要（让"桶间重叠品牌数"在报告中可见）
  const spDim = state.blueOcean && state.blueOcean.dimensions && state.blueOcean.dimensions.sellingPoints;
  if (spDim && spDim.exclusivity && spDim.exclusivity.conflictBrandCount) {
    const pairs = Object.entries(spDim.exclusivity.overlapByPair)
      .map(([pair, n]) => `${pair.replace('|', '+')} 冲突 ${n} 家`).join('；');
    addFact(`卖点互斥冲突提示：${spDim.exclusivity.conflictBrandCount} 家品牌同时被标入互斥卖点组（${pairs}）；红/蓝海已按净计数（剔除低优先级标签）计算，原始计数仍保留，请复核是否为 legit 价值定位。`, null, false, '卖点');
  }
  return facts;
}
// 机器校验器 + 质检门（C5 宪法）：句级查引用 + 程序化校验 LLM 产出结构，不靠模型自觉
// v2（报告-数据同源架构）：删编造编号句 + 删无编号裸句（段/条均删，仅保留坦诚陈述/不确定标注/结构行）；依赖降级数据不再打徽章，改在"我们不知道"清单诚实提示复核
// 返回 { markdown, removed, flagged, suspectSentences, qc:{ checks:[{name,desc,pass}], passed, total, allPass } }
function isClaimLine(t) {
  if (!t || t.length < 15) return false;            // 过短行（连接词/小标题）不当作论断
  if (/^#{1,4}\s/.test(t)) return false;             // 标题
  if (/^>\s/.test(t)) return false;                  // 引用块（信号卡/空白卡内部自引用）
  if (/^\|/.test(t) || /^\s*\|/.test(t)) return false; // 表格
  if (/[：:—-]\s*$/.test(t)) return false;           // 结尾是冒号/破折号（列表引导句，非论断）
  if (/^(【|\[)/.test(t)) return false;              // 章节/标注前缀
  if (/(我们不知道|未探测|未采集|暂无法确认|尚未覆盖|数据不足|无法确定|无法核实|未证实|暂无)/.test(t)) return false; // 坦诚陈述放行
  if (/\[推算\]|置信度|低置信|估算|推测/.test(t)) return false; // 已诚实标不确定，非裸编
  return true;
}
function validateReport(md, factIds, gapIds, opts) {
  opts = opts || {};
  const okIds = new Set([...factIds, ...gapIds]);
  const suspectFacts = new Set(opts.suspectFactIds || []);
  const suspectGaps = new Set(opts.suspectGapIds || []);
  const lines = String(md || '').split('\n');
  let removed = 0, flagged = 0, suspectSentences = 0;
  let inAppendix = false;
  const out = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (/^#{1,4}\s*.*(附录|证据编号对照)/.test(t)) inAppendix = true;
    if (inAppendix) { out.push(raw); continue; }     // 机器生成的附录/对照表原样保留
    if (!t || /^#{1,4}\s/.test(t) || /^[-*]?\s*$/.test(t)) { out.push(raw); continue; } // 标题/空行放行
    const cites = (t.match(/\[([FG]\d+|O\d+)\]/g) || []).map(x => x.slice(1, -1));
    const bad = cites.filter(id => !okIds.has(id));
    if (bad.length) { removed++; continue; }          // 编造编号 → 整句删除
    // ▶ v2：无编号裸句（脑补句）——段/条一律删除，无处藏身
    if (!cites.length && isClaimLine(t)) { removed++; continue; }
    out.push(raw);
  }
  const clean = out.join('\n');

  // ---- 残留复核：clean 中不得再有编造编号 / 裸论断句 ----
  const residualBad = (clean.match(/\[([FG]\d+|O\d+)\]/g) || []).map(x => x.slice(1, -1)).filter(id => !okIds.has(id));
  const residualBare = clean.split('\n').filter(l => { const tt = l.trim(); const c = (tt.match(/\[([FG]\d+|O\d+)\]/g) || []).map(x => x.slice(1, -1)); return c.length === 0 && isClaimLine(tt); });

  const checks = [];
  const add = (name, desc, pass) => checks.push({ name, desc, pass: !!pass });
  const hasAny = (...subs) => subs.some(s => clean.includes(s));

  // 1 判断收束：「我们的判断」段存在且带 ≥3 条可溯源 insight
  const judgeBlock = clean.match(/#{1,3}\s*.*我们的判断[\s\S]*?(?=\n#{1,3}\s|$)/i);
  const judgeText = judgeBlock ? judgeBlock[0] : '';
  const judgeCites = (judgeText.match(/\[[FG]\d+|O\d+\]/g) || []).length;
  add('判断收束', '「我们的判断」段先给结论，并带 ≥3 条可溯源 insight', judgeText.length > 0 && judgeCites >= 3);

  // 2 引用纪律：编造编号句与无编号裸句均被删净（残留=0）
  add('引用纪律', `编造编号句已删 ${removed} 句，无残留裸句`, residualBad.length === 0 && residualBare.length === 0);

  // 3 as-of + 来源可点：文末附证据编号对照（可核验）
  add('as-of · 来源可点', '文末附证据编号对照（可核验），含数据来源/as-of',
    hasAny('证据编号对照', '附录') && /as-of|数据来源|来源/.test(clean));

  // 4 现状含细分 MECE：现状段含细分/区域且声明占比/不重不漏
  add('现状·细分 MECE', '现状段含细分/区域，并声明占比或维度不重不漏',
    hasAny('现状') && /(细分|区域|MECE)/.test(clean) && /(占比|不重不漏|加总|份额)/.test(clean));

  // 5 问题解释 why：问题段含 why 类表述
  add('问题·解释 why', '问题段含「因为/源于/导致」等 why 解释',
    hasAny('问题') && /(为什么|因为|原因|源于|导致|why)/i.test(clean));

  // 6 空白视图：机会段含空白卡
  add('含空白视图', '机会段含空白卡（竞品全无，差异化核心）',
    hasAny('机会') && /空白卡|\[空白 G/.test(clean));

  // 7 敢标不确定
  add('敢标不确定', '估算/推断均标 [推算]/置信度/低置信，无伪装精确',
    /\[推算\]|置信度|低置信|未证实|估算/.test(clean));

  // 8 立场忠实：主动指出未知（不伪装全知）
  add('立场忠实', '主动列出"我们不知道/未探测/未采集"，不伪装全知',
    /(我们不知道|未探测|未采集|暂无法确认|尚未覆盖|数据不足)/.test(clean));

  // 9 红线：无"你应该做 X"
  const noImperative = !/(你应该做|建议你立即|必须购买|务必|理应马上)/.test(clean);
  add('红线自检', '全文无「你应该做 X」替结论表述，决策权归用户', noImperative);

  const passed = checks.filter(c => c.pass).length;
  return {
    markdown: clean,
    removed,
    flagged,
    suspectSentences,
    qc: { checks, passed, total: checks.length, allPass: passed === checks.length }
  };
}
async function buildReport(state, config) {
  const dsKey = llmApiKey(config);
  state.whiteSpace = computeWhiteSpace(state);
  // ▶ #307：两套机会打通 —— brief §三 同时承接「用户声音机会（口碑驱动）」与「市场空缺（卖点空缺）」，单一来源 lib/opportunity.js
  const _oppEx = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) _oppEx.add(c.id); });
  const _oppComps = (state.competitors || []).filter(c => c.status === 'done' && !_oppEx.has(c.id));
  // R2.5：报告的用户声音机会层接真实声音（与 decorate 同口径）
  const _reportVoice = [];
  _oppComps.forEach(c => { (c.voiceItems || []).forEach(v => { if (v) _reportVoice.push(v); }); });
  const voiceOpp = computeOpportunityMap(_oppComps, { excluded: _oppEx, voiceItems: _reportVoice });
  const allFacts = assembleFacts(state);
  // ▶ 报告-数据同源 原则3：维度完整性闸门 —— 未充分探测（覆盖率<50%）的维度，其事实不进入报告原料
  const dimCov = dimensionCoverage(state);
  const facts = allFacts.filter(f => !f.dim || dimCov.detected.includes(f.dim));
  const undetectedDims = dimCov.undetected;

  const ws = state.whiteSpace && !state.whiteSpace.hidden ? state.whiteSpace.gaps : [];
  // 机会 = 市场空缺（非文案空缺）；文案空缺(copyGap)单列"观察级"，不撑机会场面（原则4）
  const opps = ws.filter(g => g.level === 'opportunity' && !g.copyGap);
  const copyGaps = ws.filter(g => g.copyGap);

  // ▶ 决策链 deps（原则6）：依赖被降级(flaggedOutlier)对手的数据 → 整条标"数据存疑"
  const flaggedNames = new Set((state.competitors || []).filter(c => c.flaggedOutlier).map(c => c.name));
  const suspectFactIds = facts.filter(f => f.suspect).map(f => f.id);
  const suspectGapIds = opps.filter(g => (g.sources || []).some(s => flaggedNames.has(s.name))).map(g => g.gid);

  const factText = facts.map(f => `[${f.id}] ${f.text}`).join('\n');
  const gapText = opps.map(g => `[${g.gid}] (${g.dim}·置信${g.confidence}${g.speculative ? '·推测' : ''}) ${g.value}：${g.note}`).join('\n');
  const copyGapText = copyGaps.map(g => `[${g.gid}] (文案空缺·观察级) ${g.dim}·${g.value}：${g.note}`).join('\n');
  // ▶ #10：单家观察空白（样本<3）作为低置信观察喂给报告，但明确非群体共识
  const singleGaps = ws.filter(g => g.singleCompetitor);
  const singleGapText = singleGaps.map(g => `[${g.gid}] (单家观察·推测·非群体共识) ${g.dim}·${g.value}：${g.note}`).join('\n');
  // ▶ #307：用户声音机会（口碑驱动）作为 brief §三 的补充层，与 G# 市场空缺并列
  const voiceOppText = voiceOpp.hidden
    ? `(用户声音机会暂不可比：样本不足（${voiceOpp.brandsWithVoice || 0}/${voiceOpp.doneBrands || 0} 家有用户声音），不单列；详见「我们不知道」清单)`
    : (voiceOpp.themes || []).map(t => `[O${t.onum}] (${t.zone}·机会分${t.opportunity}·重要性${t.importance}·满意度${t.satisfaction}) ${t.label}：${t.denominatorText}`).join('\n');
  const singleMode = !!(state.whiteSpace && state.whiteSpace.singleMode);

  // ▶ 报告-数据同源 原则3/原则4："我们不知道"清单（未探测维度 + 文案空缺观察 + 降级数据）
  const weDontKnow = [];
  undetectedDims.forEach(d => {
    const c = dimCov.cov[d];
    weDontKnow.push(`- ${d}维度：本赛道仅 ${c.present}/${c.total} 家对手有可靠数据（覆盖率 ${(c.ratio * 100).toFixed(0)}% < 50%），本报告未引用该维度结论。`);
  });
  if (copyGaps.length) weDontKnow.push(`- 文案空缺（非市场空缺）：以下卖点/打法空缺仅基于"官网文案比对"（${copyGaps.length} 项），未验证市场层面需求，属观察级，不构成已确认的市场机会。`);
  if (singleMode) weDontKnow.push(`- 当前仅 ${state.whiteSpace.total} 家对手完成研究（<3），空白分析处于"单家观察"模式：下方单家留白仅为结构推测、非群体共识，补充至 ≥3 家后才会给出赛道级群体空白。`);
  if (suspectFactIds.length || suspectGapIds.length) weDontKnow.push(`- 部分结论依赖被降级（量级存疑 flaggedOutlier）对手的数据，可信度相对更低，建议在「我们的判断」段结合原始来源复核。`);
  const weDontKnowText = weDontKnow.length ? weDontKnow.join('\n') : '- （本次各维度探测覆盖较充分，暂无重大未探测项）';


  // 用户定位（价格段/卖点）整理成可读原点，喂给 LLM 与附录校准块
  const pos = assessPositioning(state);
  let posText = '(未填写定位——空白分析以全赛道为参照，未以你为锚点)';
  if (pos && pos.hasProfile) {
    const lines = [];
    if (pos.price) lines.push(`价格段：${pos.price.band.currency} ${pos.price.band.min}-${pos.price.band.max}，被 ${pos.price.contestedBy} 家同币种对手占据${pos.price.contestedNames.length ? `（${pos.price.contestedNames.join('、')}）` : ''}。`);
    if (pos.sellingPoints) lines.push('卖点：' + pos.sellingPoints.map(r => `「${r.label}」${r.claimedBy ? `被${r.claimedBy}家主打` : '无人主打（空白可占）'}`).join('；') + '。');
    if (pos.challenges.length) lines.push('已识别信号：' + pos.challenges.map(c => c.text).join(' '));
    posText = lines.join('\n');
  }

  const sys = `你是"知彼 Vantage"，站在用户（品牌负责人）那一边。基于给定的【事实清单F#】与【空缺清单G#】装配一份**研究级行业调研报告**（对标 Euromonitor / Nielsen / Similarweb 的产出标准：完整、准确、清晰、客观、每条可溯源）。
【结构（markdown，必须严格按此 4 段顺序，段标题用 ## 一、现状 / ## 二、问题 / ## 三、机会 / ## 四、我们的判断）】
## 一、现状
- 赛道正在发生什么：市场规模与趋势、细分与区域（标注占比，声明维度内部不重不漏）、头部竞争格局（对头部 3-5 家各给 Strengths 与可趁软肋 Cautions）。
- 趋势列 2-4 条、格局每条挂 [F#]。
- 无可靠赛道级量化数据时，必须明确写"未采集到赛道级量化数据，以下为公开行业资料推算，置信度低，需你二次核实"，并标 [推算]。
## 二、问题
- 站在用户视角，指出"不顺耳但有用"的问题：用户未被满足的需求、对手的软肋、已知风险与制约（Restraints / Challenges 放这里）。
- 每条先讲 what，再用"因为/源于/导致"解释 why，挂 [F#]。
## 三、机会
- 逐条复述下方【空缺清单 G# 市场机会】，每条用**空白卡**格式（用 > 引用块）：
- 同时补充下方【用户声音机会 O#（口碑驱动 · 补充层）】：这些是"重要但对手普遍没做好的地方"（用户抱怨 / 痛点聚类），作为补充层与 G# 市场空缺并列呈现；逐条带 [O#] 引用与分母（N/M 家对手提到），不得脱离 O# 编号编造。
  > **[空白 Gx]** 空白：… ／ 证据类型：… ／ 推理逻辑：… ／ 置信度：高|中|低 ／ 可行性提示：…
- 文案空缺（观察级 G#）提及须注明"基于官网文案比对，未验证市场层面"，不得当作市场空白大做文章。
## 四、我们的判断
- 综合上述给出"我们的判断"——这是对局势的**有倾向的评估，不是替你下结论，也不列行动建议**。
- 用 3-5 条判断句收束，每条必须带明确倾向（不要只罗列两面、不要留"见仁见智"式尾巴），并挂证据编号 [F#]/[G#]：
  · **最锋利的空白在哪**：给出你（助理）最看好的 1-2 个空白，句式如"我们判断 X 是当前最值得盯的空白"；若处于单家观察模式（样本<3、无群体空白），则基于"单家观察"给初步倾向，并明确标注"单家观察·推测，群体共识待≥3家"。
  · **最大风险在哪**：最该警惕的对手软肋或已知制约，给出明确"我们判断风险在 Y"。
  · **你（用户）定位的相对位置是否成立**：给出明确结论——"成立 / 偏乐观 / 偏保守"，并给一句理由（挂 [F#]/[G#]）。
- 倾向性表达边界：可以说"我们判断……""我们倾向认为……"，但**绝不写"你应该做 X / 建议你立即"**这类替结论的句子——决策权始终归用户。
- 说明数据来源、as-of 时间，并主动列出"我们不知道 / 未探测 / 未采集"的事项（基于下方清单），不伪装全知。
【铁律】
1. 你**不能**引入清单之外的"事实"。每一句论断句末必须标注引用编号 [F#] 或 [G#]；编造编号或**无任何编号的裸句**都会被系统自动删除（脑补句无处藏身）。
2. 敢标不确定：任何估算 / 推断必须标 [推算] 或置信度分级，绝不伪装精确。
3. 立场忠实：主动指出"你想进的方向已有强对手"这类不顺耳事实；主动标"相关于你的目标"；**绝不写"你应该做 X / 建议你立即"这类替结论的句子**——决策权始终归用户。
4. 不堆免责、不写通用行业套话；直接、有据。
5. **禁止常识外推**：你收到的【事实清单F#】【空缺清单G#】是你唯一可引用的"事实"来源；不得引入品牌常识/行业常识做推理（如"大牌所以渠道强""品类火热所以必有机会"）。【你的定位】是合法锚点（用户自身资料），其余背景信息仅供理解语境，不得作为 [F#]/[G#] 之外的引用。
6. **文案空缺 ≠ 市场空缺**：标记为"文案空缺·观察级"的 G# 仅基于官网文案比对，是观察不是已确认机会；提及须注明"基于官网文案比对，未验证市场层面"，不得将其当作市场空白大做文章。
直接输出 markdown，不要外层 json。`;
  const user = `赛道：${state.track}
用户意图/目标：${JSON.stringify(state.intent || {})}

【你的定位（空白分析原点，作为参照事实，合法锚点）】
${posText}

【事实清单 F#】（你唯一可引用的"事实"来源，句末必须引用其中编号）
${factText || '(无 verified 事实——请在执行摘要如实说明证据不足)'}

【空缺清单 G# · 市场机会】（已剔除"文案空缺"，见下方观察级）
${gapText || '(无)'}

【文案空缺 · 观察级 G#】（仅基于官网文案比对，非已确认市场机会，提及须注明"未验证市场层面"）
${copyGapText || '(无)'}

【单家观察 · 推测 G#】（样本<3，仅结构推理"该对手应做而未做"，非群体共识，提及须注明"单家观察·推测"）
${singleGapText || '(无)'}

【用户声音机会 O#（口碑驱动 · 补充层）】
${voiceOppText || '(无)'}

【我们不知道 / 未探测维度】（在「我们的判断」段如实列出，不伪装全知）
${weDontKnowText}

【维度覆盖提示】已充分探测（进入报告原料）的维度：${dimCov.detected.join('、') || '无'}；未充分探测（<50% 覆盖率，已排除出报告原料）的维度：${undetectedDims.join('、') || '无'}。`;
  const raw = await deepseekText([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'report' });
  // ▶ #10：单家观察 gap 的 gid 也纳入合法引用集（否则 LLM 引用单家留白会被 validateReport 当编造编号删除）
  const citedGapIds = opps.map(g => g.gid).concat(singleGaps.map(g => g.gid)).concat(voiceOpp.hidden ? [] : (voiceOpp.themes || []).map(t => 'O' + t.onum));
  const v = validateReport(raw, facts.map(f => f.id), citedGapIds, { suspectFactIds, suspectGapIds });
  // R6.1：全字段证据分布（诚实条数据源，与 state.evidenceDist 同口径）
  const evidenceDist = evidenceDistribution(state);
  // 附录：编号对照表（可点开核验来源 URL —— "每条可验证"红线）
  const appendix = ['\n---\n### 附录 · 证据编号对照'];
  facts.forEach(f => appendix.push(`- **${f.id}** ${f.text}${f.source ? ` — [来源](${f.source})` : ''}`));
  opps.forEach(g => appendix.push(`- **${g.gid}** [${g.dim}] ${g.value}（置信度 ${g.confidence}${g.speculative ? '·推测' : ''}）`));
  singleGaps.forEach(g => appendix.push(`- **${g.gid}** [单家观察·推测] ${g.dim}·${g.value}（置信度 ${g.confidence}）`));
  (voiceOpp.hidden ? [] : (voiceOpp.themes || [])).forEach(t => appendix.push(`- **O${t.onum}** [${t.zone}] ${t.label}（机会分 ${t.opportunity} · 重要性 ${t.importance} · 满意度 ${t.satisfaction} · ${t.denominatorText}）`));
  // 机器生成的"定位校准"块（事实、不依赖 LLM，保证敢挑战的内容一定在、且不被模型改写）
  let calib = '';
  if (pos && pos.hasProfile) {
    calib = '\n\n---\n### 定位校准 · 基于你填写的价格段 / 卖点（机器核对，非模型生成）\n';
    if (pos.price) {
      calib += `- **价格段** ${pos.price.band.currency} ${pos.price.band.min}–${pos.price.band.max}：被 **${pos.price.contestedBy}** 家同币种对手占据${pos.price.contestedNames.length ? `（${pos.price.contestedNames.join('、')}）` : ''}。\n`;
    }
    if (pos.sellingPoints) {
      calib += '- **卖点对照**（你选的 vs 对手是否在做）：\n';
      pos.sellingPoints.forEach(r => {
        calib += `  - 「${r.label}」：${r.claimedBy ? `被 ${r.claimedBy} 家主打${r.claimedNames.length ? `（${r.claimedNames.join('、')}）` : ''} —— 红海方向` : '**无人主打 —— 空白可占**'}。\n`;
      });
    }
    if (pos.challenges.length) {
      calib += '- **值得正视的信号**（不顺耳但有用）：\n' + pos.challenges.map(c => `  - ${c.text}`).join('\n') + '\n';
    }
  }
  // #310 体验报告版本锚定：报告末尾附生成元数据，且对象层暴露 generatedBy 供前端复用
  const _genFooter = reportProvenance(APP_VERSION, APP_COMMIT, STARTED_AT);
  return {
    generatedAt: new Date().toISOString(),
    asOf: new Date().toISOString().slice(0, 10),
    markdown: (v.markdown || '（报告生成失败）') + calib + appendix.join('\n') + _genFooter,
    generatedBy: { version: APP_VERSION, commit: APP_COMMIT, startedAt: STARTED_AT },
    evidenceDist,
    audit: { facts: facts.length, gaps: opps.length, removedSentences: v.removed, flaggedSentences: v.flagged, suspectSentences: v.suspectSentences },
    qc: v.qc
  };
}


module.exports = { dimensionCoverage, assembleFacts, isClaimLine, validateReport, buildReport };
