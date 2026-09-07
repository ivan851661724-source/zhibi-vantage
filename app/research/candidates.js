'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/candidates.js —— 导出: normName, PLATFORM_NAMES, PLATFORM_SUFFIX, EXCLUDE_REASONS, applySuppression, extractCandidateRules, approvedKeywords, applyApprovedRules, constructFeedbackReport, isPlatformNotBrand, mergeCandidates, crossValidate, rankCandidates, applyRelevanceJudgments, presenceGate, rejudgeRelevance, slug
// ============================================================

const { reportsFile } = require('../core/state-store.js');
const { deepseekJSON } = require('./llm.js');
const { domainOf } = require('./net.js');
const fs = require('fs');

// 候选合并去重（名字归一化后合并，保留信息更全者）
function normName(n) { return String(n || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, ''); }

// 平台/市场/社媒 ≠ 品牌：发现层硬过滤（代码裁决，不依赖 LLM 自觉）
const PLATFORM_NAMES = ['etsy', 'amazon', 'ebay', 'walmart', 'target', 'aliexpress', 'alibaba', 'taobao', 'tmall', 'temu', 'wish', 'shopify', 'tiktok', 'tiktokshop', 'instagram', 'facebook', 'pinterest', 'reddit', 'youtube', 'google', 'kickstarter', 'indiegogo', 'faire', 'wayfair', 'redbubble', 'zazzle', 'shein', '淘宝', '天猫', '拼多多', '京东', '亚马逊'];
const PLATFORM_SUFFIX = /^(custom|customs|handmade|merch|shop|store|marketplace|sellers?|finds|shops)$/;
// 闸门「移除」原因分类（用户反馈 taxonomy，喂养搜索算法迭代）
// isTractionBlind=true 表示这是信号缺口(无流量源)而非算法错误，路由到「是否接流量源」决策
const EXCLUDE_REASONS = {
  irrelevant:   { zh: '不相关（非竞品）', isTractionBlind: false },
  noTraction:   { zh: '无体量（没流量）', isTractionBlind: true },
  wrongSegment: { zh: '错品类（错位）', isTractionBlind: false },
  duplicate:    { zh: '重复（同名异写）', isTractionBlind: false },
  defunct:      { zh: '已退市 / 信息陈旧', isTractionBlind: false },
};
// 硬信号生效：剔除本赛道被用户移除过的品牌（按名字×赛道），零风险自动排除
function applySuppression(candidates, suppressed, track) {
  const supNames = (suppressed || []).filter(x => x.track === track).map(x => x.name);
  const before = candidates.length;
  const kept = candidates.filter(c => !supNames.includes((c.name || '').toLowerCase().trim()));
  return { kept, dropped: before - kept.length };
}
// 软信号提炼：从用户反馈(suppressed)中按原因聚类、找共性，提炼「候选规则」。
// 注意：这些规则只生成、不自动上线——每条需用户审(Q1 已定：每条先审)。
const RELEVANCE_KW = ['打印机', '3d打印', '打印', '工厂', '设备', '代工', 'oem', '原材料', 'supplier', 'manufactur', 'printer', 'factory'];
function extractCandidateRules(state) {
  const sup = state.suppressed || [];
  const rules = [];
  const byReason = {};
  sup.forEach(x => { (byReason[x.reason] = byReason[x.reason] || []).push(x); });
  // irrelevant：找共性关键词（设备/代工/原料商特征）
  const irrel = byReason.irrelevant || [];
  if (irrel.length >= 2) {
    const hitCount = {};
    irrel.forEach(x => {
      // 证据面：名字 + 域名 + 当初的入选理由/定位（噪音特征多藏在"工业级3D打印机厂商"这类描述里）
      const hay = [x.name, x.url, x.why, x.positioning].filter(Boolean).join(' ').toLowerCase();
      RELEVANCE_KW.forEach(k => { if (hay.includes(k.toLowerCase())) hitCount[k] = (hitCount[k] || 0) + 1; });
    });
    const common = Object.keys(hitCount).filter(k => hitCount[k] >= 2);
    if (common.length) {
      rules.push({ id: 'irrel-kw', reason: 'irrelevant', kind: 'relevance-keyword', isTractionBlind: false,
        keywords: common, enforceable: true,
        text: `被移除的无关品牌多命中关键词 [${common.join('/')}]，建议在相关性裁判中强化此类周边企业(设备/代工/原料)识别`,
        effect: `采纳后：下次搜索中，名称/简介命中 [${common.join('/')}] 的候选将被直接剔除。`,
        evidence: irrel.map(x => x.name), confidence: 'medium' });
    } else {
      rules.push({ id: 'irrel-generic', reason: 'irrelevant', kind: 'relevance-review', isTractionBlind: false,
        enforceable: false,
        text: `${irrel.length} 个品牌被标记为不相关，但暂未找到可执行的共性特征`,
        effect: '暂无法转成自动规则——需要更多样本，或你补一句"它们哪里像"。',
        evidence: irrel.map(x => x.name), confidence: 'low' });
    }
  }
  // noTraction：信号缺口，非算法可解
  const nt = byReason.noTraction || [];
  if (nt.length) {
    rules.push({ id: 'traction-gap', reason: 'noTraction', kind: 'signal-gap', isTractionBlind: true, enforceable: false,
      text: `${nt.length} 个品牌被标记为无体量(没流量)。这是信号缺口，不是算法判错`,
      effect: '我们目前没有流量数据源，算法看不见"有没有人访问"，学不会这条。它已被按名字硬排除，但同类新噪音还会再出现——除非接入流量源(Similarweb 类)。这是一个需要你拍板的决策，不是一条可采纳的规则。',
      evidence: nt.map(x => x.name), confidence: 'high' });
  }
  const seg = byReason.wrongSegment || [];
  if (seg.length) rules.push({ id: 'segment', reason: 'wrongSegment', kind: 'segment-mismatch', isTractionBlind: false, enforceable: false,
    text: `${seg.length} 个品牌错品类（与你的定位段位错位）`,
    effect: '需要你的定位信息更完整（价位段/核心卖点）才能转成降权规则，当前样本不足以自动执行。',
    evidence: seg.map(x => x.name), confidence: 'low' });
  const dup = byReason.duplicate || [];
  if (dup.length) rules.push({ id: 'dup', reason: 'duplicate', kind: 'alias-merge', isTractionBlind: false, enforceable: false,
    text: `${dup.length} 个重复项（同名异写）`, effect: '已按名字硬排除；别名合并规则待样本积累。', evidence: dup.map(x => x.name), confidence: 'low' });
  const def = byReason.defunct || [];
  if (def.length) rules.push({ id: 'defunct', reason: 'defunct', kind: 'recency-check', isTractionBlind: false, enforceable: false,
    text: `${def.length} 个已退市/信息陈旧`, effect: '已按名字硬排除；时效性校验需要"最近活跃"信号源。', evidence: def.map(x => x.name), confidence: 'low' });
  return rules;
}
// 采纳后的规则才生效（Q1 铁律：每条先审，不替用户改判定逻辑）
function approvedKeywords(ruleDecisions) {
  const out = [];
  Object.values(ruleDecisions || {}).forEach(d => {
    if (d && d.decision === 'approved' && Array.isArray(d.keywords)) out.push(...d.keywords);
  });
  return [...new Set(out.map(k => String(k).toLowerCase()))];
}
function applyApprovedRules(candidates, ruleDecisions) {
  const kws = approvedKeywords(ruleDecisions);
  if (!kws.length) return { kept: candidates, dropped: 0, hits: [] };
  const hits = [];
  const kept = candidates.filter(c => {
    const hay = [c.name, c.url, c.why, c.positioning].filter(Boolean).join(' ').toLowerCase();
    const hit = kws.find(k => hay.includes(k));
    if (hit) { hits.push({ name: c.name, kw: hit }); return false; }
    return true;
  });
  return { kept, dropped: candidates.length - kept.length, hits };
}
// 纠错报告：本轮移除(带原因) + 补对手 + 候选规则（供用户逐条审）
function constructFeedbackReport(state) {
  const sup = state.suppressed || [];
  const zh = k => (EXCLUDE_REASONS[k] || { zh: k }).zh;
  const dec = state.ruleDecisions || {};
  const rules = extractCandidateRules(state).map(r => ({
    ...r,
    decision: (dec[r.id] && dec[r.id].decision) || 'pending', // 未审即未生效
    decidedAt: (dec[r.id] && dec[r.id].at) || null,
  }));
  // 价格字段纠错（Pilot 1 闭环产物）：喂给"算法校准率"指标 + 复核面板
  const priceCorr = (state.fieldCorrections || []).filter(c => /^price/.test(c.field));
  const nameOf = id => { const c = (state.competitors || []).find(x => x.id === id); return c ? c.name : id; };
  const priceCorrections = priceCorr.map(c => ({ competitor: nameOf(c.competitorId), type: c.type, value: c.value, currency: c.currency, text: c.text, at: c.at }));
  // 软信号提炼：同类型纠错 ≥2 次 → 候选规则（每条需用户审，红线不变）
  const byType = {};
  priceCorr.forEach(c => { byType[c.type] = byType[c.type] || []; byType[c.type].push(c); });
  const priceRules = Object.keys(byType).filter(t => byType[t].length >= 2).map(t => ({
    id: 'price-' + t, reason: 'price', kind: 'field-pattern', isTractionBlind: false,
    text: `${byType[t].length} 次价格字段纠错类型「${t}」——可能存在系统性偏差，建议人工复核该字段的采集/裁决逻辑`,
    evidence: byType[t].map(c => nameOf(c.competitorId)), confidence: 'medium',
    enforceable: false, decision: (dec['price-' + t] && dec['price-' + t].decision) || 'pending', decidedAt: (dec['price-' + t] && dec['price-' + t].at) || null,
  }));
  // 空白视图（聚合产物）轻量纠错通道：用户反馈的"某空白判断不准"落在这里，逐条留痕供复核
  // P1-7：按本项目所属租户读取，杜绝跨租户泄露。
  let gapReports = [];
  try { gapReports = JSON.parse(fs.readFileSync(reportsFile(state && state.tenantId), 'utf8')).filter(r => r.gapId); } catch (e) {}
  return {
    removed: sup.map(x => ({ name: x.name, reason: x.reason, reasonZh: zh(x.reason), isTractionBlind: (EXCLUDE_REASONS[x.reason] || {}).isTractionBlind || false, at: x.at })),
    added: (state.addedCompetitors || []).map(x => ({ name: x.name, at: x.at })),
    rules: rules.concat(priceRules),
    priceCorrections,
    gapReports: gapReports.map(r => ({ at: r.at, gapLabel: r.gapLabel, description: r.description, source: r.source, status: r.status })),
    priceCalibration: { total: priceCorr.length, hardApplied: priceCorr.filter(c => ['wrong-value', 'wrong-currency', 'over-confident', 'confirm-correct'].includes(c.type)).length },
    pendingCount: rules.concat(priceRules).filter(r => r.enforceable && r.decision === 'pending').length,
    activeKeywords: approvedKeywords(dec),
  };
}
function isPlatformNotBrand(c) {
  const key = normName(c.name);
  if (!key) return false;
  if (PLATFORM_NAMES.includes(key)) return true;
  // "Amazon Custom" / "Etsy Handmade" / "TikTok Shop" 这类平台+泛词组合
  for (const pf of PLATFORM_NAMES) {
    if (key.startsWith(pf) && PLATFORM_SUFFIX.test(key.slice(pf.length))) return true;
  }
  return false;
}
function mergeCandidates(lists) {
  const map = new Map();
  lists.flat().forEach(c => {
    if (!c || !c.name) return;
    const key = normName(c.name);
    if (!key) return;
    const ex = map.get(key);
    if (!ex) {
      const e = Object.assign({}, c);
      e._domains = new Set(c.url ? [domainOf(c.url)] : []); // ▶ 数据卫生①：同名实体域名追踪
      map.set(key, e);
      return;
    }
    // 合并：url 取非空；matchScore 取大；tier 取已知；src 标记多源
    if (!ex.url && c.url) ex.url = c.url;
    if ((Number(c.matchScore) || 0) > (Number(ex.matchScore) || 0)) ex.matchScore = c.matchScore;
    if ((!ex.tier || ex.tier === 'unknown') && c.tier) ex.tier = c.tier;
    if (!ex.why && c.why) ex.why = c.why;
    if (c.src === 'llm') ex.llmKnown = true; else ex.serpKnown = true;
    if (ex.src === 'llm') ex.llmKnown = true;
    // ▶ 数据卫生①：实体消歧——同一归一化名映射到不同域名主页 → 同名多实体，标 entity-ambiguous 降级
    const d = c.url ? domainOf(c.url) : '';
    if (d) {
      if (ex._domains.size && !ex._domains.has(d)) ex.entityAmbiguous = true; // 冲突：同名不同域（如 Ursa Major 火箭 vs 护肤品）
      ex._domains.add(d);
    }
  });
  // 剥离内部追踪字段，避免污染下游；entityAmbiguous 透传供降级使用
  return Array.from(map.values()).map(e => { const { _domains, ...rest } = e; return rest; });
}

// 交叉验证：统计每个候选在全部原始结果中真实出现次数（天然去编造）
// 同时算 distinctHits = 命中了「几个不同的查询角度」（单次噪声 vs 真有体量的品牌）
function crossValidate(candidates, fanout) {
  const perQuery = fanout.map(t => (t.results || []).map(x => (x.title + ' ' + x.content + ' ' + x.url).toLowerCase()));
  candidates.forEach(c => {
    const name = (c.name || '').toLowerCase().trim();
    if (!name) { c.evidenceCount = 0; c.distinctHits = 0; return; }
    let count = 0, hits = 0;
    perQuery.forEach(q => {
      const n = q.filter(h => h.includes(name)).length;
      if (n > 0) { hits++; count += n; }
    });
    c.evidenceCount = count;
    c.distinctHits = hits;
  });
  // 保留：至少在来源出现 1 次 或 有 url
  return candidates.filter(c => c.evidenceCount >= 1 || (c.url && c.url.startsWith('http')));
}

function rankCandidates(candidates) {
  // 硬门槛1：平台/市场/社媒不是品牌（Etsy、Amazon Custom 之类），直接剔除
  candidates = candidates.filter(c => !isPlatformNotBrand(c));
  // 硬门槛2：matchScore<40 视为噪音（跨行业巨头/无关大牌），直接剔除
  candidates = candidates.filter(c => (Number(c.matchScore) || 0) >= 40);
  candidates.forEach(c => {
    // categoryFit 优先（相关性二次裁判给的贴合度），缺失时回落到 harvest 自报的 matchScore
    const fit = Math.max(0, Math.min(100, Number(c.categoryFit) || Number(c.matchScore) || 0));
    c.categoryFit = fit;
    const ev = Math.min(c.distinctHits || c.evidenceCount || 0, 5);
    const hasUrl = !!(c.url && c.url.startsWith('http'));
    // 排序：相关性主导；跨查询出现次数作存在度加成；有官网再轻加权
    c.rankScore = Math.round(fit + ev * 3 + (hasUrl ? 4 : 0));
    // 置信度：跨 ≥3 个查询且有官网 = high；跨 ≥2 或有官网 = medium；否则 low
    c.confidence = (c.distinctHits >= 3 && hasUrl) ? 'high' : ((c.distinctHits >= 2 || hasUrl) ? 'medium' : 'low');
    // ▶ 数据卫生①：同名多实体（entityAmbiguous）→ 置信不足，强制降级为 low（覆盖 ≠ 正确）
    if (c.entityAmbiguous) {
      c.confidence = 'low';
      c.ambiguousNote = '同名多实体：归一化名映射到不同域名主页，可能为不同而混淆的对手，已降级';
    }
  });
  candidates.sort((a, b) => b.rankScore - a.rankScore);
  return candidates;
}

// ============================================================
// 相关性二次裁判 + 市场存在度门槛（解决"搜定制手办却出设备商/零曝光品牌"）
// ============================================================

// 纯函数：把 LLM 裁判结果合并回候选（便于单元测试，无副作用之外的 LLM 依赖）
function applyRelevanceJudgments(candidates, judgments) {
  const map = new Map();
  (judgments || []).forEach(j => { if (j && j.name) map.set(normName(j.name), j); });
  candidates.forEach(c => {
    const j = map.get(normName(c.name));
    if (j) {
      c.relevant = j.relevant !== false;
      c.categoryFit = Number(j.categoryFit) || 0;
      c.relReason = j.reason || '';
    } else {
      // LLM 漏返回的候选：默认保留但用 harvest 自报分作拟合度，不误杀
      c.relevant = true;
      if (c.categoryFit == null) c.categoryFit = Number(c.matchScore) || 0;
    }
  });
  return candidates;
}

// 纯函数：市场存在度门槛——单次命中且无官网 ≈ 噪声（"基本没浏览/没曝光"）
function presenceGate(candidates) {
  return candidates.filter(c => {
    const hasUrl = !!(c.url && c.url.startsWith('http'));
    if ((c.distinctHits || 0) < 2 && !hasUrl) return false;
    return true;
  });
}

// 批量 LLM 复核：捕获"设备/打印机/OEM 代工/原材料供应商/平台"等周边企业
async function rejudgeRelevance(track, candidates, fanout, dsKey) {
  if (!candidates.length) return [];
  const snippetsByKey = {};
  fanout.forEach(t => (t.results || []).forEach(x => {
    const blob = (x.title + ' ' + x.content).toLowerCase();
    candidates.forEach(c => {
      const nm = (c.name || '').toLowerCase();
      if (nm && blob.includes(nm)) { (snippetsByKey[normName(c.name)] = snippetsByKey[normName(c.name)] || []).push((x.content || '').slice(0, 140)); }
    });
  }));
  const items = candidates.map(c => ({ name: c.name, tier: c.tier, why: c.why || '', url: c.url || '', snippet: (snippetsByKey[normName(c.name)] || [])[0] || '' }));
  const sys = `你是"知彼 Vantage"的相关性裁判。用户赛道："${track}"。
任务：逐一审视候选，判断它是否真的是该赛道【面向终端消费者的品牌 / 产品公司】，而不是平台、设备 / 3D打印机 / 模具 / OEM 代工厂、原材料供应商、或仅"服务于该行业"的周边企业。
判定铁律：
- 设备 / 3D打印机 / 打印工厂 / OEM代工 / 原材料供应商 = 不是该赛道的消费品牌（即使它给该行业供货），relevant=false。
- 平台 / 电商 / 社媒 = relevant=false。
- 只数"真正面向终端消费者售卖该品类产品"的品牌为 relevant=true。
输出 JSON：{"judgments":[{"name":"","relevant":true|false,"categoryFit":0-100,"reason":"一句话"}]}`;
  const user = `候选清单：\n` + items.map((it, i) => `[${i + 1}] ${it.name} | tier=${it.tier} | ${it.url || '(无官网)'} | ${it.why || ''} | 摘录：${it.snippet || ''}`).join('\n');
  try {
    const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, null, { fieldKey: 'discover-crossvalidate' });
    return j.judgments || [];
  } catch { return []; }
}

function slug(name, i) {
  const base = (name || ('c' + i)).toLowerCase().replace(/[^a-z0-9一-鿿]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return (base || 'c') + '-' + i;
}


module.exports = { normName, PLATFORM_NAMES, PLATFORM_SUFFIX, EXCLUDE_REASONS, applySuppression, extractCandidateRules, approvedKeywords, applyApprovedRules, constructFeedbackReport, isPlatformNotBrand, mergeCandidates, crossValidate, rankCandidates, applyRelevanceJudgments, presenceGate, rejudgeRelevance, slug };
