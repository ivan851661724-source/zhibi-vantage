'use strict';
// ============================================================
// services/voice-unified.js —— 「用户声音与公开评论」统一读模型（SC-06 三 / r2 整改）
// ------------------------------------------------------------
// 产品裁决（SC-06 任务书 §三 + r2 评审 §一）：
//   · 用户侧只保留一个名称：「用户声音与公开评论」；
//   · public_reviews（公开评论页采集）是唯一来源层；
//   · 旧 voiceItems（discover 期社媒/评论采集投影）只能作为兼容输入或
//     迁移投影——不得再生成第二套用户可见统计、第二套卡片或第二套
//     机会分母；旧 reviews / painPoints 同理，不再作为独立统计来源；
//   · 每条已核实评论必须带：来源 URL、Snapshot/Evidence 引用、观察时间、
//     品牌归属、采集范围与样本限制；情绪/主题若展示必须标明提取依据；
//   · 无 Evidence/Snapshot 的评论不得标为已核实；
//   · 样本不足时显示「资料不足，暂不形成群体结论」，不得写成
//     「没有差评」「用户满意」或「无口碑」。
//
// 🔴 r2 整改（评审 §一）：统一评论事实链必须真正进入机会计算。
//   ── 情绪/主题契约（未来能力，先定死，未实现即不产出）──
//   每一条分类必须同时满足：
//     ① polarity ∈ {'pos','neg'}（'neu'/未分类 ≠ 正面也 ≠ 负面）；
//     ② sentimentBasis ∈ {'source_field','deterministic_rule','model_extraction'}，
//        并带可读的 basis 说明（sentimentBasisNote）——无法解释依据的分类不进入算法；
//     ③ 保留 Evidence、Snapshot、来源 URL、观察时间、品牌归属（缺一不可）。
//   当前 public_reviews 采集只产出「来源页面公开的评分/评价数/片段」，
//   **不产出情绪分类**——因此机会算法输入恒为空，机会视图必须如实说明
//   「用户声音已采集，但尚不足以形成满意度机会判断」，不得：
//     · 把 sentiment:'neu' 当正面或负面用；
//     · 把未分类评论塞进「满意度」分母；
//     · 拿旧 state 的评论主题混装成新模型的市场结论。
// 消费方（同一读模型，禁止各自拼第二口径）：
//   情报库评论变化 / 品牌档案「用户声音与公开评论」tab / 机会算法输入。
// ============================================================

const Surface = require('./data-surface.js');

const VOICE_MODEL_VERSION = 'voice-unified-2';

// 极性词表：neu（中性/未分类）不是极性，不得进入正面/负面任一分子或分母
const POLARITIES = Object.freeze(['pos', 'neg']);
// 情绪依据来源分类（可证据化的三种，缺一类即不得进入机会算法）
const SENTIMENT_BASIS_KINDS = Object.freeze(['source_field', 'deterministic_rule', 'model_extraction']);
// 机会资格：样本下限（与足够形成群体结论同口径）
const MIN_QUALIFIED_ITEMS = 3;

// 机会闸的四种结局（前端据此显示不同口径，禁止统一写成「无数据」）
const OPP_GATE = Object.freeze({
  OK: 'ok',
  NO_PUBLIC_REVIEWS: 'no_public_reviews',                 // 还没采到可核验公开评论
  NO_EVIDENCE_BACKED_POLARITY: 'no_evidence_backed_polarity', // 采到了，但没有带依据的正负分类
  INSUFFICIENT_SAMPLE: 'insufficient_sample',             // 有分类但样本不足
});

const OPP_GATE_TEXT = Object.freeze({
  ok: '',
  no_public_reviews: '尚未采集到可核验的公开评论，暂不形成满意度判断。',
  no_evidence_backed_polarity: '用户声音已采集，但尚不足以形成满意度机会判断。',
  insufficient_sample: '用户声音样本不足，暂不形成满意度机会判断。',
});

// ---------- 情绪分类归一（契约唯一实现） ----------
// 接受两种入参形状：
//   o.polarity = 'pos'|'neg' + o.sentimentBasis = 'source_field'|'deterministic_rule'|'model_extraction'
//   o.polarity + o.sentimentBasis = { kind, note, source }
// 任一不满足 → null（不猜、不降级成 neu 参与计算）
function normalizeClassification(o) {
  const src = o || {};
  const p = src.polarity;
  if (POLARITIES.indexOf(p) === -1) return null;
  let kind = null, note = '', basisSource = null;
  const b = src.sentimentBasis;
  if (typeof b === 'string') kind = b;
  else if (b && typeof b === 'object') { kind = b.kind || null; note = String(b.note || ''); basisSource = b.source || null; }
  if (SENTIMENT_BASIS_KINDS.indexOf(kind) === -1) return null;
  note = String(note || src.sentimentBasisNote || '').trim();
  if (!note) return null; // 依据不可解释 → 不得进入机会算法
  return { polarity: p, sentimentBasis: kind, sentimentBasisNote: note.slice(0, 240), sentimentSource: basisSource };
}

// 单条已核实评论的规范化（字段来自采集观察 + Evidence 引用，缺失即 null）
function toVerifiedItem(o, evRefs, brandId, competitorId) {
  const src = o || {};
  const ev = (evRefs && evRefs[0]) || {};
  const cls = normalizeClassification(src);
  return {
    kind: 'review_page',
    title: src.title || null,
    snippet: src.snippet || null,
    sourceUrl: src.sourceUrl || null,
    rating: typeof src.rating === 'number' ? src.rating : null,
    reviewCount: typeof src.reviewCount === 'number' ? src.reviewCount : null,
    observedAt: src.publishedAt || null,
    brandId: brandId || null,
    competitorId: competitorId || null,
    evidenceId: ev.evidenceId || null,
    snapshotId: ev.snapshotId || null,
    // 情绪与依据：public_reviews 采集不产生情绪判断——null 即不展示，
    // 不从片段/评分猜情绪（评分只在 rating 字段原样展示）
    polarity: cls ? cls.polarity : null,
    sentiment: cls ? cls.polarity : null, // 兼容字段：只可能是 pos/neg，永不为 'neu'
    sentimentBasis: cls ? cls.sentimentBasis : null,
    sentimentBasisNote: cls ? cls.sentimentBasisNote : null,
  };
}

// 旧 voiceItem → 迁移投影（明确降级：不算已核实、不进统计、不进机会分母）
function toLegacyItem(v, brandId) {
  if (!v) return null;
  return {
    kind: 'legacy_voice',
    platform: v.platform || null,
    text: v.text ? String(v.text).slice(0, 300) : null,
    url: v.url || null,
    date: v.date || null,
    brandId: brandId || null,
    evidenceId: null, snapshotId: null, // 旧链路无 Snapshot/Evidence 引用
    note: '历史采集投影',
  };
}

// 样本是否足以形成群体结论：至少 1 个来源页面且总评论量 ≥ 5（保守下限；
// 依据：reviews_digest 摘要口径——样本必须明示，不足即不形成群体结论）
function enoughForGroupConclusion(summary) {
  if (!summary) return false;
  return (summary.reviewCount || 0) >= 5 || (summary.sourceCount || 0) >= 3;
}

// 单条是否具备进入机会算法的资格（契约的守门实现）
function isOpportunityEligible(it) {
  const x = it || {};
  if (POLARITIES.indexOf(x.polarity) === -1) return false;
  if (SENTIMENT_BASIS_KINDS.indexOf(x.sentimentBasis) === -1) return false;
  if (!String(x.sentimentBasisNote || '').trim()) return false;
  if (!x.evidenceId || !x.snapshotId) return false;   // 无 Evidence/Snapshot → 不可核验
  if (!x.sourceUrl || !x.observedAt) return false;     // 无来源/无观察时间 → 不可核验
  if (!x.brandId && !x.competitorId) return false;     // 无品牌归属 → 不分母
  return true;
}

/**
 * 统一读模型。brandId 必须已做 tenant/project/brand 三重归属校验（调用方负责）。
 * 返回结构（用户可见投影，不含内部路径/错误）：
 * {
 *   version, title, status: 'sufficient'|'insufficient',
 *   insufficientText,
 *   verified: { items, summary },
 *   legacy: { items, note },
 * }
 */
function buildUnifiedVoice({ tenantId, projectId, brandId, competitorId, comp }) {
  const c = comp || {};
  // —— 来源层：public_reviews 采集（Data Surface 真值链读出）——
  let obs = []; let evRefs = []; let summary = null;
  try {
    const det = Surface.buildDimensionDetail({
      tenantId, projectId, competitorId: c.id, dimension: 'reviews_reputation',
      offset: 0, limit: 50, comp: c,
    });
    const cap = (det.capabilities || []).find(x => x.capabilityCode === 'public_reviews');
    if (cap) {
      obs = cap.observations || [];
      evRefs = cap.evidenceRefs || [];
      summary = cap.summary || null;
    }
  } catch (e) { /* 维度不可读：按样本不足处理，不填充 */ }

  const verifiedItems = obs
    .map(o => toVerifiedItem(o, evRefs, brandId, competitorId || c.id || null))
    // 无 Evidence/Snapshot 引用的观察不进入「已核实」集合（SC-06 验收 6）
    .filter(x => x.evidenceId || x.snapshotId);

  const verifiedSummary = summary ? {
    sampleSize: typeof summary.reviewCount === 'number' ? summary.reviewCount : verifiedItems.reduce((s, x) => s + (x.reviewCount || 0), 0),
    sourceCount: typeof summary.sourceCount === 'number' ? summary.sourceCount : verifiedItems.length,
    periodStart: summary.periodStart || null,
    periodEnd: summary.periodEnd || null,
    measurementMethod: summary.measurementMethod || 'public_source_observation',
    sampleNote: summary.sampleNote || '样本为本次采集窗口内通过校验的公开评论页面，不等于全网口碑',
    limitations: [
      '样本为公开页面可核验的评论，不是全网口碑总量',
      '评分与评价数为来源页面公开字段，未做跨平台归一',
      '情绪分类当前未实现：没有带依据的正负主题，因此不形成满意度判断',
    ],
  } : null;

  const sufficient = verifiedItems.length > 0 && enoughForGroupConclusion(verifiedSummary || {});

  // —— 兼容输入：旧 voiceItems 迁移投影（不算已核实、不进统计、不进机会分母）——
  const legacyItems = (Array.isArray(c.voiceItems) ? c.voiceItems : [])
    .map(v => toLegacyItem(v, brandId)).filter(Boolean).slice(0, 50);

  return {
    version: VOICE_MODEL_VERSION,
    title: '用户声音与公开评论',
    status: sufficient ? 'sufficient' : 'insufficient',
    insufficientText: '资料不足，暂不形成群体结论。',
    verified: {
      items: verifiedItems,
      summary: verifiedSummary,
    },
    legacy: {
      items: legacyItems,
      note: legacyItems.length ? '以下为历史采集的迁移投影，未挂 Snapshot/Evidence 引用，不计入公开评论统计。' : null,
    },
  };
}

// ---------- 机会算法输入（唯一装配点） ----------
// 只吃统一读模型：旧 reviews / painPoints / voiceItems 一律不读。
// 返回 { eligible, reason, reasonText, items, collected, qualified, sample }
function buildOpportunityInput(unified) {
  const u = unified || {};
  const all = (u.verified && Array.isArray(u.verified.items)) ? u.verified.items : [];
  const collected = all.length;
  const qualified = all.filter(isOpportunityEligible);

  const base = {
    eligible: false,
    reason: OPP_GATE.NO_PUBLIC_REVIEWS,
    reasonText: OPP_GATE_TEXT.no_public_reviews,
    items: [],
    collected,
    qualified: qualified.length,
    sample: {
      collectedItems: collected,
      qualifiedItems: qualified.length,
      minQualified: MIN_QUALIFIED_ITEMS,
      sampleNote: '合格输入 = 带 polarity + sentimentBasis + Evidence/Snapshot + 来源 URL + 观察时间 + 品牌归属的公开评论',
    },
  };

  if (!collected) return base;
  if (!qualified.length) {
    return Object.assign({}, base, {
      reason: OPP_GATE.NO_EVIDENCE_BACKED_POLARITY,
      reasonText: OPP_GATE_TEXT.no_evidence_backed_polarity,
    });
  }
  if (qualified.length < MIN_QUALIFIED_ITEMS) {
    return Object.assign({}, base, {
      reason: OPP_GATE.INSUFFICIENT_SAMPLE,
      reasonText: OPP_GATE_TEXT.insufficient_sample,
      items: qualified.map(toOpportunityItem),
    });
  }
  return Object.assign({}, base, {
    eligible: true,
    reason: OPP_GATE.OK,
    reasonText: '',
    items: qualified.map(toOpportunityItem),
  });
}

// 统一事实 → 机会聚类条目（字段与 lib/opportunity 的输入契约一致）
function toOpportunityItem(x) {
  return {
    field: 'public_reviews.verified_item',
    text: String(x.snippet || x.title || '').slice(0, 120),
    brand: x.brandId || x.competitorId || null,
    brandId: x.brandId || null,
    competitorId: x.competitorId || null,
    polarity: x.polarity,
    sentimentBasis: x.sentimentBasis,
    sentimentBasisNote: x.sentimentBasisNote,
    url: x.sourceUrl || null,
    observedAt: x.observedAt || null,
    evidenceId: x.evidenceId || null,
    snapshotId: x.snapshotId || null,
  };
}

// 兼容旧调用名：只返回**合格**条目（不合格恒为空数组，绝不补 neu 占位）
function toOpportunityInput(unified) {
  return buildOpportunityInput(unified).items;
}

/**
 * 多品牌装配（decorate / 报告 / 象限 / 机会页共用同一口径）。
 * comps 为项目内的 competitor 列表；不带 tenant/project 时直接返回空（诚实：无法读来源层）。
 * 返回 { items, collected, qualified, eligible, reason, reasonText, byBrand, brandsWithVoice }
 */
function buildOpportunityInputForComps({ tenantId, projectId, comps, brandIdOf }) {
  const list = Array.isArray(comps) ? comps.filter(Boolean) : [];
  const out = {
    items: [], collected: 0, qualified: 0, eligible: false,
    reason: OPP_GATE.NO_PUBLIC_REVIEWS, reasonText: OPP_GATE_TEXT.no_public_reviews,
    byBrand: [], brandsWithVoice: 0,
  };
  if (!tenantId || !projectId || !list.length) return out;
  const byBrand = [];
  for (const c of list) {
    let unified = null;
    try {
      const bid = typeof brandIdOf === 'function' ? brandIdOf(c) : null;
      unified = buildUnifiedVoice({ tenantId, projectId, brandId: bid, competitorId: c.id, comp: c });
    } catch (e) { unified = null; }
    if (!unified) continue;
    const gate = buildOpportunityInput(unified);
    out.collected += gate.collected;
    out.qualified += gate.qualified;
    if (gate.items.length) {
      out.items.push.apply(out.items, gate.items);
      byBrand.push({ competitorId: c.id || null, name: c.name || null, qualified: gate.qualified, collected: gate.collected });
    } else if (gate.collected) {
      byBrand.push({ competitorId: c.id || null, name: c.name || null, qualified: 0, collected: gate.collected });
    }
  }
  out.byBrand = byBrand;
  out.brandsWithVoice = byBrand.filter(b => b.qualified > 0).length;
  if (!out.collected) {
    out.reason = OPP_GATE.NO_PUBLIC_REVIEWS;
    out.reasonText = OPP_GATE_TEXT.no_public_reviews;
  } else if (!out.qualified) {
    out.reason = OPP_GATE.NO_EVIDENCE_BACKED_POLARITY;
    out.reasonText = OPP_GATE_TEXT.no_evidence_backed_polarity;
  } else if (out.qualified < MIN_QUALIFIED_ITEMS) {
    out.reason = OPP_GATE.INSUFFICIENT_SAMPLE;
    out.reasonText = OPP_GATE_TEXT.insufficient_sample;
  } else {
    out.eligible = true;
    out.reason = OPP_GATE.OK;
    out.reasonText = '';
  }
  return out;
}

/**
 * 项目级「用户声音与公开评论」投影（情报库独立字段 voiceChanges 用）。
 * 只有一套口径：verified.summary 统计 + 最近观察样例；sufficient 才给统计。
 */
function buildProjectVoiceSummary(tenantId, projectId, opts) {
  const o = opts || {};
  const BrandStore = require('./brand-store.js');
  const BrandSvc = require('./brand-service.js');
  const state = BrandSvc.loadProjectState(tenantId, projectId);
  const links = BrandStore.listBrandLinksForProject(tenantId, projectId) || [];
  const out = [];
  for (const b of links) {
    if (o.brandId && b.brandId !== o.brandId) continue;
    const comp = b.competitorRef ? BrandSvc.findCompetitor(state, b.competitorRef) : null;
    let u = null;
    try { u = buildUnifiedVoice({ tenantId, projectId, brandId: b.brandId, competitorId: comp ? comp.id : null, comp: comp || {} }); } catch (e) { u = null; }
    if (!u) continue;
    const gate = buildOpportunityInput(u);
    out.push({
      brandId: b.brandId,
      brandName: b.canonicalName || null,
      status: u.status,
      sampleSize: u.verified.summary ? u.verified.summary.sampleSize : 0,
      sourceCount: u.verified.summary ? u.verified.summary.sourceCount : 0,
      opportunityEligible: gate.eligible,
      opportunityReason: gate.reason,
      opportunityReasonText: gate.reasonText,
      recentItems: (u.verified.items || []).slice(0, 3).map(x => ({
        title: x.title, sourceUrl: x.sourceUrl, rating: x.rating, reviewCount: x.reviewCount,
        observedAt: x.observedAt, evidenceId: x.evidenceId, snapshotId: x.snapshotId,
        polarity: x.polarity, sentimentBasis: x.sentimentBasis,
      })),
    });
  }
  return out;
}

module.exports = {
  VOICE_MODEL_VERSION, POLARITIES, SENTIMENT_BASIS_KINDS, OPP_GATE, OPP_GATE_TEXT,
  MIN_QUALIFIED_ITEMS,
  normalizeClassification, isOpportunityEligible,
  buildUnifiedVoice, buildOpportunityInput, toOpportunityInput, buildOpportunityInputForComps,
  buildProjectVoiceSummary,
};
