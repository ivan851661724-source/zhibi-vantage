'use strict';
// ============================================================
// 机会地图（Ulwick ODI 改良版）
// ------------------------------------------------------------
// 它回答的问题不是「谁没占」，而是「什么事很重要、但大家都做得烂」。
// 机会分 = 重要性 + max(重要性 − 满意度, 0)
//
// 我们用得起的代理指标（必须逐字对用户明说，不许暗示是调研测得）：
//   重要性 importance  ← 提及广度：多少家对手的用户声音提到该主题 / 有声音的对手数
//   满意度 satisfaction ← 正负提及比：正面提及 / (正面 + 负面)
//
// 铁律（忠实助理纪律，代码级兑现）：
//   1. 分母必须显式：任何一条都带「N/M 家提到」，不给孤立分数。
//   2. 每条可溯源：记录品牌 + 来源字段 + basis，供逐条核对。
//   3. 置信度封顶「中」：提及广度只是重要性的代理，不足以支撑高置信结论。
//   4. 样本不足不出图：有用户声音的对手 < 3 家直接隐藏；覆盖率 < 70% 降级、不作排序结论。
//   5. 🔴 SC-06 r2：输入只接受「统一评论事实链」产出的合格条目
//      （services/voice-unified.js 的 buildOpportunityInput / buildOpportunityInputForComps）。
//      本模块**不再读**竞品档案里的 reviews / painPoints / voiceItems——
//      那些是旧链路字段，没有 Evidence/Snapshot/sentimentBasis，不能当统计来源。
//      没有合格输入时返回 hidden + reason='no_evidence_backed_polarity'，
//      由上层如实显示「用户声音已采集，但尚不足以形成满意度机会判断」。
// ============================================================

const CONF_CAP = 'medium';               // 置信度硬上限（永不 high）
const MIN_BRANDS_WITH_VOICE = 3;         // 出图门槛：至少 3 家有用户声音
const COVERAGE_OK = 0.7;                 // 覆盖率红线：低于此仅展示、不作排序结论
const SIM_THRESHOLD = 0.5;               // 主题聚类相似度阈值（字符二元组 Jaccard）
const MAX_THEMES = 24;                   // 前端展示上限（total 仍给全量计数）
// 情绪依据来源分类（与 services/voice-unified.js 的契约保持一致，此处为守门副本）
const SENTIMENT_BASIS_KINDS = ['source_field', 'deterministic_rule', 'model_extraction'];

// 分区阈值（沿用 ODI 惯例：>15 严重欠满足，10–15 值得关注，<10 已满足/不重要）
const ZONE_UNDERSERVED = 15;
const ZONE_MODERATE = 10;

const CAVEATS = [
  '重要性＝提及广度代理（多少家竞争品牌的用户声音提到），不是调研测得的重要性；满意度＝正负提及比，只统计带依据（polarity + sentimentBasis）的公开评论，中性或未分类评论不进任何分子或分母。',
  '分母是「有用户声音的竞争品牌家数」，不是消费者样本量。本图可以帮你排优先级，不能替代真实用户访谈。',
  '本图任何一条置信度封顶为「中」——代理指标不足以支撑高置信结论。',
  '同义表述按字面相似度合并，阈值取保守值：宁可少合并也不硬凑。因此机会分的失真方向是「低估」而非「高估」，看到的分数是下限。',
  '分区（重点机会 / 中等 / 已覆盖）是「相对当前数据」：按机会分在可见主题里排 top 15% / 再 35% 着色，不是 Ulwick 绝对门槛；上面展示的重要性 / 满意度 / 机会分仍是绝对代理值，请照绝对值看。'
];

const METHOD_LABEL = '用户声音聚类（提及广度代理重要性 · 带依据的正负提及比代理满意度）';

function stableHash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

// 归一化：仅保留中日韩字符与字母数字，用于聚类比对（不改变展示原文）
function normTheme(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

// 字符二元组集合（中英通用；长度 1 时退化为单字符集合）
function bigrams(s) {
  const t = normTheme(s);
  const set = new Set();
  if (!t) return set;
  if (t.length === 1) { set.add(t); return set; }
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2));
  return set;
}

function jaccard(A, B) {
  let inter = 0;
  A.forEach(x => { if (B.has(x)) inter++; });
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}

// 相似度：二元组 Jaccard 与单字 Jaccard 各占一半（二元组管词序，单字管增删字）。
// 另加「包含」规则：短串完整出现在长串中且长度≥2 → 视为同一主题。
// 取值偏保守：宁可少合并（低估机会分），不硬凑同义（高估会骗人下注）。
function similarity(a, b) {
  const na = normTheme(a), nb = normTheme(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  if (shorter.length >= 2 && longer.indexOf(shorter) !== -1) return 1;
  const bi = jaccard(bigrams(na), bigrams(nb));
  const uni = jaccard(new Set(na.split('')), new Set(nb.split('')));
  return 0.5 * bi + 0.5 * uni;
}

// 统一评论事实链 → 聚类条目。只认 opts.voiceItems（voice-unified 已过资格闸），
// 并在此再做一次轻量守门（polarity 必须是 pos/neg、必须带 sentimentBasis/来源/观察时间）。
// 返回 [{ text, brand, brandId, competitorId, polarity:'pos'|'neg', field, basis, url, observedAt }]
function collectUnifiedItems(opts) {
  const raw = (opts && Array.isArray(opts.voiceItems)) ? opts.voiceItems : [];
  const seen = new Set();
  const items = [];
  for (const v of raw) {
    if (!v) continue;
    const polarity = v.polarity === 'pos' ? 'pos' : (v.polarity === 'neg' ? 'neg' : null);
    if (!polarity) continue;                                   // neu / 未分类 → 不进分子也不进分母
    if (!v.sentimentBasis || !String(v.sentimentBasisNote || '').trim()) continue; // 依据不可解释 → 丢弃
    if (!v.url || !v.observedAt) continue;                     // 不可核验 → 丢弃
    // 项目成员资格只能由 competitorId 确认。brandId 是品牌库主键，不能与项目内竞品 ID 混用。
    const competitorId = itemCompetitorId(v);
    if (!competitorId) continue;                               // 无项目竞品归属 → 不进分母
    const text = String(v.text == null ? '' : v.text).trim();
    if (!text) continue;
    const key = competitorId + '|' + polarity + '|' + normTheme(text);
    if (seen.has(key)) continue;                               // 同品牌同极性去重，避免刷高广度
    seen.add(key);
    items.push({
      text: text.slice(0, 60),
      // 展示只使用人可读品牌名；内部 ID 不得作为品牌名泄漏到机会视图。
      brand: v.brand || v.brandName || null,
      brandId: v.brandId || null,
      competitorId,
      polarity,
      field: v.field || 'public_reviews.verified_item',
      basis: v.sentimentBasis,
      basisNote: v.sentimentBasisNote || null,
      url: v.url || null,
      observedAt: v.observedAt || null,
      evidenceId: v.evidenceId || null,
      snapshotId: v.snapshotId || null,
    });
  }
  return items;
}

// brandId（品牌库主键）与 competitorId（项目内竞争品牌主键）是两套 ID。
// 机会的成员资格、广度去重与分母只认 competitorId；brandId 不能作为回退。
function itemCompetitorId(m) { return (m && m.competitorId) || null; }
function itemBrandKey(m) { return itemCompetitorId(m); }

// 贪心聚类：按出现频次从高到低，逐条并入首个足够相似的簇，否则自立门户。
// 确定性（同输入同输出），且保留全部原始成员供前端展示「合并自：…」。
function clusterThemes(items, opts) {
  const threshold = (opts && opts.threshold != null) ? opts.threshold : SIM_THRESHOLD;
  // 先按归一化文本统计频次，让高频表述当簇代表（更可能是通用说法）
  const freq = new Map();
  items.forEach(it => {
    const k = normTheme(it.text);
    freq.set(k, (freq.get(k) || 0) + 1);
  });
  const ordered = items.slice().sort((a, b) => {
    const fa = freq.get(normTheme(a.text)) || 0, fb = freq.get(normTheme(b.text)) || 0;
    if (fb !== fa) return fb - fa;
    const la = normTheme(a.text).length, lb = normTheme(b.text).length;
    if (la !== lb) return la - lb;                       // 同频取短表述当代表
    return String(a.text).localeCompare(String(b.text)); // 完全并列时字典序，保证确定性
  });
  const clusters = [];
  ordered.forEach(it => {
    let target = null;
    for (const cl of clusters) {
      if (similarity(cl.rep, it.text) >= threshold) { target = cl; break; }
    }
    if (!target) { target = { rep: it.text, members: [], mentions: [] }; clusters.push(target); }
    target.mentions.push(it);
    if (!target.members.some(m => normTheme(m) === normTheme(it.text))) target.members.push(it.text);
  });
  return clusters;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round1(v) { return Math.round(v * 10) / 10; }

// 单簇打分。brandsWithVoice = 分母（有合格用户声音事实的对手家数）
function scoreCluster(cl, brandsWithVoice) {
  const brandSet = new Set(cl.mentions.map(itemCompetitorId).filter(Boolean));
  const brands = Array.from(new Set(cl.mentions.map(m => m.brand).filter(Boolean)));
  const pos = cl.mentions.filter(m => m.polarity === 'pos').length;
  const neg = cl.mentions.filter(m => m.polarity === 'neg').length;
  const denom = Math.max(1, brandsWithVoice);
  const breadth = clamp(brandSet.size / denom, 0, 1);
  const importance = round1(1 + 9 * breadth);
  const totalMentions = pos + neg;
  // 分母只含已分类（pos/neg）提及：neu/未分类绝不进满意度分母
  const satisfaction = totalMentions ? round1(1 + 9 * (pos / totalMentions)) : 5.5;
  const opportunity = round1(importance + Math.max(importance - satisfaction, 0));
  const zone = opportunity >= ZONE_UNDERSERVED ? 'underserved'
    : opportunity >= ZONE_MODERATE ? 'moderate' : 'served';
  const cited = cl.mentions.filter(m => SENTIMENT_BASIS_KINDS.indexOf(m.basis) !== -1).length;
  // 置信度封顶 medium：广度≥3家且至少 2 条带可解释依据 → medium，否则 low
  const confidence = (brandSet.size >= 3 && cited >= 2) ? CONF_CAP : 'low';
  return {
    oid: 'O-' + stableHash(normTheme(cl.rep)),
    label: cl.rep,
    members: cl.members.slice(0, 8),
    mergedFrom: cl.members.length,
    importance, satisfaction, opportunity, zone,
    brandsMentioned: brandSet.size,
    brandsWithVoice: denom,
    brands,
    posMentions: pos,
    negMentions: neg,
    confidence,
    method: METHOD_LABEL,
    denominatorText: `${brandSet.size}/${denom} 家有用户声音的竞争品牌提到（正面 ${pos} · 负面 ${neg}）`,
    sources: cl.mentions.slice(0, 12).map(m => ({
      name: m.brand, competitorId: itemCompetitorId(m) || null, field: m.field, polarity: m.polarity,
      basis: m.basis || 'unverified', basisNote: m.basisNote || null,
      detail: m.text, url: m.url || null, observedAt: m.observedAt || null,
      evidenceId: m.evidenceId || null, snapshotId: m.snapshotId || null,
    }))
  };
}

// 相对百分位分区：在「当前可见主题」里按机会分排名着色，不套 Ulwick 绝对门槛。
// 规则：top 15% = 重点机会；再 35% = 中等；其余 = 已覆盖。
// 仅当覆盖率达标（可作排序结论）时启用；否则保留 scoreCluster 的绝对分区（压缩数据下皆是「已覆盖」），不制造排名。
// O/I/S 绝对代理值保持不变，只动「分区着色」这一层——属于透明排序，不是制造信号。
function applyRelativeZones(themes) {
  const n = themes.length;
  if (n === 0) return;
  const underN = Math.max(1, Math.round(0.15 * n));
  let modN = Math.round(0.35 * n);
  if (underN + modN > n) modN = Math.max(0, n - underN);
  themes.forEach((t, i) => {
    t.zone = i < underN ? 'underserved' : (i < underN + modN ? 'moderate' : 'served');
    t.bandBasis = 'relative';
  });
}

// 初步主题（薄样本降级用）：只有在**已通过资格闸**的条目存在时才聚类，
// 供前端在「样本不足」时仍展示已算出的部分信号，而非塌成空屏。
// 与正式出图的区别：① 不分区排名（不制造 top15% 重点机会）；② 每条锁 low 置信并标 preliminary。
function computePreliminaryThemes(items, brandsWithVoice, doneBrands) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { themes: [], mentionsTotal: 0 };
  const clusters = clusterThemes(list, {});
  let themes = clusters.map(cl => scoreCluster(cl, brandsWithVoice));
  themes.sort((a, b) => (b.opportunity - a.opportunity) || (b.brandsMentioned - a.brandsMentioned) || a.label.localeCompare(b.label));
  themes = themes.slice(0, MAX_THEMES);
  themes.forEach((t, i) => { t.onum = i + 1; }); // ▶ #307：顺序编号，供 brief 引用 [O#]
  const note = `初步信号：样本不足（仅 ${brandsWithVoice}/${doneBrands} 家有用户声音），未达出图门槛，下列主题仅作已识别信号陈列、不作排序结论。`;
  themes.forEach(t => { t.confidence = 'low'; t.preliminary = true; t.note = note; });
  return { themes, mentionsTotal: list.length };
}

// 主入口：从**统一评论事实链**算机会地图。派生产物，不落盘。
// opts: {
//   excluded: Set|Array,
//   threshold: number,
//   voiceItems: 合格事实条目（只来自 services/voice-unified.js 的装配结果）,
//   voiceCollected: 已采集到的公开评论条数（用于区分「没采到」与「采到了但没分类」）,
// }
function computeOpportunityMap(competitors, opts) {
  opts = opts || {};
  const ex = opts.excluded instanceof Set ? opts.excluded : new Set(opts.excluded || []);
  const comps = (competitors || []).filter(c => c && c.status === 'done' && !ex.has(c.id));
  const doneBrands = comps.length;
  const compIds = new Set(comps.map(c => c.id).filter(Boolean));
  // 只收本项目已就绪品牌的合格条目（跨项目/已排除品牌的条目不得进分母）
  const items = collectUnifiedItems(opts).filter(it => {
    const competitorId = itemCompetitorId(it);
    return Boolean(competitorId && compIds.has(competitorId));
  });
  const brandsWithVoice = new Set(items.map(itemCompetitorId).filter(Boolean)).size;
  const coverage = doneBrands ? brandsWithVoice / doneBrands : 0;
  const coveragePct = Math.round(coverage * 100);
  const collected = Number.isFinite(Number(opts.voiceCollected)) ? Number(opts.voiceCollected) : 0;
  const voiceBasis = {
    collected,
    qualified: items.length,
    brandsWithVoice,
    doneBrands,
    gate: items.length ? 'ok' : (collected > 0 ? 'no_evidence_backed_polarity' : 'no_public_reviews'),
    note: items.length ? null : (collected > 0
      ? '用户声音已采集，但尚不足以形成满意度机会判断。'
      : '尚未采集到可核验的公开评论，暂不形成满意度判断。'),
  };

  if (!items.length) {
    // 没有任何合格输入 → 不出图、不给初步主题、不做相对百分位分区
    return {
      hidden: true, preliminary: false,
      reason: collected > 0 ? 'no_evidence_backed_polarity' : 'need_more_voice',
      doneBrands, brandsWithVoice: 0, coveragePct: 0, collected,
      caveats: CAVEATS, preliminaryThemes: [], mentionsTotal: 0,
      voiceBasis,
    };
  }
  if (doneBrands < 3) {
    const pt = computePreliminaryThemes(items, brandsWithVoice, doneBrands);
    return { hidden: true, preliminary: true, reason: 'need_more_brands', doneBrands, brandsWithVoice, coveragePct, caveats: CAVEATS, preliminaryThemes: pt.themes, mentionsTotal: pt.mentionsTotal, voiceBasis };
  }
  if (brandsWithVoice < MIN_BRANDS_WITH_VOICE) {
    const pt = computePreliminaryThemes(items, brandsWithVoice, doneBrands);
    return { hidden: true, preliminary: true, reason: 'need_more_voice', doneBrands, brandsWithVoice, coveragePct, caveats: CAVEATS, preliminaryThemes: pt.themes, mentionsTotal: pt.mentionsTotal, voiceBasis };
  }

  const clusters = clusterThemes(items, { threshold: opts.threshold });
  let themes = clusters.map(cl => scoreCluster(cl, brandsWithVoice));
  const lowCoverage = coverage < COVERAGE_OK;
  if (lowCoverage) {
    // 覆盖率不足：整体降级为低可信，且明说「不作排序结论」
    themes.forEach(t => {
      t.confidence = 'low';
      t.coverageInsufficient = true;
      t.note = `覆盖率不足：${brandsWithVoice}/${doneBrands} 家竞争品牌有用户声音（${coveragePct}%），排序仅供参考，不构成优先级结论。`;
    });
  }
  themes.sort((a, b) => (b.opportunity - a.opportunity) || (b.brandsMentioned - a.brandsMentioned) || a.label.localeCompare(b.label));
  const total = themes.length;
  themes = themes.slice(0, MAX_THEMES);
  themes.forEach((t, i) => { t.onum = i + 1; }); // ▶ #307：顺序编号，供 brief 引用 [O#]

  const relativeBands = !lowCoverage;          // 覆盖率不足时不制造排名
  if (relativeBands) applyRelativeZones(themes);

  // SC-12 §四.5：旧机会图的散点与新 foundation 使用同一个门槛（lib/satisfaction-gate.js），
  // 不得由两套逻辑分别决定是否画图。坐标、依据、证据全部由服务端给出，前端只消费结论。
  const ScatterGate = require('./satisfaction-gate.js');
  const times = [];
  for (const t of themes) for (const s of t.sources) if (s.observedAt) times.push(s.observedAt);
  times.sort();
  const scatterGate = ScatterGate.evaluateScatterGate(themes.map(t => ({
    oid: t.oid,
    label: t.label,
    satisfaction: t.satisfaction,
    // 满意度 = 正面/(正面+负面) 的确定性规则，分母只含已分类提及（可核验依据）
    satisfactionBasis: 'deterministic_rule',
    satisfactionBasisText: '正面提及 / (正面提及 + 负面提及)，中性或未分类评论不计入',
    importance: t.importance,
    // 重要性 = 提及广度的确定性规则（提到该主题的品牌数 / 有声音品牌数）
    importanceBasis: 'deterministic_rule',
    importanceBasisText: '提到该主题的品牌数 / 有用户声音的品牌数（广度）',
    sampleScope: t.denominatorText || (t.brandsMentioned + '/' + t.brandsWithVoice + ' 家有用户声音的品牌提到'),
    window: { from: times[0] || null, to: times[times.length - 1] || null },
    brandsMentioned: t.brandsMentioned,
    brandsWithVoice: t.brandsWithVoice,
    posMentions: t.posMentions,
    negMentions: t.negMentions,
    confidence: t.confidence,
    evidenceRefs: (t.sources || []).map(s => ({
      evidenceId: s.evidenceId, snapshotId: s.snapshotId,
      sourceUrl: s.url || null, brandId: s.competitorId || null, observedAt: s.observedAt || null,
    })),
  })), {});

  return {
    hidden: false,
    ranked: !lowCoverage,
    relativeBands,
    lowCoverage,
    doneBrands,
    brandsWithVoice,
    coveragePct,
    mentionsTotal: items.length,
    total,
    shown: themes.length,
    zones: {
      underserved: themes.filter(t => t.zone === 'underserved').length,
      moderate: themes.filter(t => t.zone === 'moderate').length,
      served: themes.filter(t => t.zone === 'served').length
    },
    thresholds: relativeBands
      ? {
          bandMethod: 'relative-percentile',
          underservedTopPct: 15,
          moderateTopPct: 35,
          note: '分区为相对当前数据：按机会分在可见主题中排 top 15% / 再 35% 着色；O/I/S 为绝对代理值。'
        }
      : { underserved: ZONE_UNDERSERVED, moderate: ZONE_MODERATE, note: '覆盖率不足，未按相对排名着色，排序仅供参考。' },
    confidenceCap: CONF_CAP,
    method: METHOD_LABEL,
    caveats: CAVEATS,
    voiceBasis,
    // §四.5：与新 foundation 共用的散点门槛结论（前端只消费，不自行判定）
    scatterGate,
    themes
  };
}

module.exports = {
  CONF_CAP, MIN_BRANDS_WITH_VOICE, COVERAGE_OK, SIM_THRESHOLD, CAVEATS, METHOD_LABEL,
  ZONE_UNDERSERVED, ZONE_MODERATE, SENTIMENT_BASIS_KINDS,
  normTheme, bigrams, similarity, collectUnifiedItems, itemCompetitorId, itemBrandKey,
  clusterThemes, scoreCluster, computeOpportunityMap
};
