'use strict';
// ============================================================
// 字段级置信收敛（P0-1 主链路接入 · 收敛版）—— 把用户可见三引擎
// （scalarfield / setfield / pricefield）的 tier→confidence 直映射，
// 替换为与 adjudication(锚点库) 同套的「独立来源身份交叉验证」。
// 忠实助理纪律（收敛版，闭合裂缝 A）：
//   · 单一独立来源（哪怕 tier-1 实抓）→ medium（不冒充"我们查实"）
//   · ≥2 个独立来源(按域名去重)一致 → high
//   · 冲突 → low（由各引擎在抵达本模块前已单独处理）
// 零依赖纯函数，复用 source-identity.js 的去重逻辑，确保
// 锚点库与用户可见字段共用同一套身份层。
// ============================================================
const SI = require('./source-identity.js');
const { SOURCE_KIND } = require('./provenance.js');

// tier(1|2|3) → 来源种类（与 provenance 对齐；tier3 即 LLM_ENUM，自动被去重排除）
function tierSourceKind(tier) {
  if (tier === 1) return SOURCE_KIND.OFFICIAL;
  if (tier === 2) return SOURCE_KIND.THIRD_PARTY;
  return SOURCE_KIND.LLM_ENUM;
}

// 把一条字段 claim 转成 provenance 记录形状，供 SI 消费。
//   cmpVal : 用于一致性比较的"值"（scalar=标量 / set=stance / price=range 数组）
//   url    : 来源 URL（用于域名去重；legacy 数据 url:null 时退化为 logical:kind）
//   fingerprint : 内容指纹（P0-1 第二阶段，由 claim.text 计算，供 matchByFingerprint 同源合并）
function claimToRecord(claim, cmpVal, url) {
  return {
    sourceKind: tierSourceKind(claim.tier),
    rawValue: cmpVal,
    url: url || null,
    sourceId: claim.kind || null,
    fingerprint: (claim && claim.text) ? SI.contentFingerprint(claim.text) : null,
  };
}

// 收敛置信：给定真实记录 + 采纳值 + 可选 match（价格区间重叠用），
// 返回 { confidence, independentAgree, independentSources }。
//   independentAgree    : 与采纳值一致的独立身份数
//   independentSources : 这些身份的聚合 [{identity, sourceKinds[], sourceIds[], agrees}]
// 收敛规则（三态，对应忠实助理纪律）：
//   · 独立身份 ≥2          → high（可溯源的交叉验证信任）
//   · 恰好 1 个独立来源     → medium（含 tier-1 实抓：不冒充"查实"）
//   · 0 个真实来源(纯 LLM) → low（无佐证，绝不暗示有依据）
function resolveFieldConfidence(records, opts) {
  opts = opts || {};
  const match = opts.match || null;
  const topVal = opts.topVal;
  const ia = SI.independentAgreement(records, topVal, match ? { match } : undefined);
  let confidence;
  if (ia.count >= 2) confidence = 'high';
  else if (ia.count === 0) confidence = 'low';
  else confidence = 'medium';
  return {
    confidence,
    independentAgree: ia.count,
    independentSources: ia.identities.filter((e) => e.agrees),
  };
}

// ============================================================
// 四态标签 + 独立来源数上卷（P1-7 · A1）
// 把 build*Field 产出的字段对象标准化为「忠实助理可见」的 provenance 形状：
//   fourState.membership ∈ present | absent | undetected | conflict
//   fourState.basis      ∈ verified | inferred | unverified | claimed | conflict
//   independentAgree / independentSources：补齐默认（部分分支未产出 → 0 / []），任何门禁可消费
//   provenanceTags[]：人读 chip（basis + 独立来源数），前端与 L1 门禁共用
// kind 由调用方显式传入（'price'|'set'|'scalar'|'review'），避免脆弱鸭子类型。
// ============================================================
const BASIS_TAG = {
  verified: '已查实',
  inferred: '推测·未查实',
  unverified: '未验证',
  claimed: '品牌自称',
  conflict: '来源冲突',
};

function safeNum(n, d) {
  return (typeof n === 'number' && !isNaN(n)) ? n : d;
}

// 由字段对象 + 类型推导「成员资格四态」。
function deriveMembership(f, kind) {
  if (kind === 'scalar') {
    if (f.state) return f.state;               // scalar 自带 state（present/undetected/conflict）
    if (f.method === 'none') return 'undetected';
    if (f.basis === 'conflict') return 'conflict';
    return 'present';
  }
  if (kind === 'price') {
    if (f.method === 'none') return 'undetected'; // 价格无数据
    if (f.basis === 'conflict') return 'conflict';
    return 'present';                            // 价格只区分「有值 / 无值 / 冲突」，无 absent 语义
  }
  if (kind === 'set') {
    return f.state || 'undetected';             // set 自带 state（present/absent/undetected/conflict）
  }
  if (kind === 'review') {
    const subs = [f.rating, f.trend].filter(Boolean);
    if (subs.some((s) => s.state === 'conflict')) return 'conflict';
    const anyPresent = subs.some((s) => s.state === 'present')
      || (f.negThemes && f.negThemes.items && f.negThemes.items.length)
      || (f.posThemes && f.posThemes.items && f.posThemes.items.length);
    return anyPresent ? 'present' : 'undetected';
  }
  return f.state || 'present';
}

// 口碑复合字段：独立来源取 rating/trend 子标量的最大值与来源并集（主题列表恒 tier-3 → 0）。
function reviewIndependent(f) {
  const subs = [f.rating, f.trend].filter(Boolean);
  let maxAgree = 0;
  const srcMap = new Map();
  for (const s of subs) {
    maxAgree = Math.max(maxAgree, safeNum(s.independentAgree, 0));
    (s.independentSources || []).forEach((e) => { if (!srcMap.has(e.identity)) srcMap.set(e.identity, e); });
  }
  return { independentAgree: maxAgree, independentSources: [...srcMap.values()] };
}

function enrichFieldProvenance(f, kind) {
  if (!f || typeof f !== 'object') return f;
  kind = kind || 'set';
  let independentAgree;
  let independentSources;
  if (kind === 'review') {
    const ri = reviewIndependent(f);
    independentAgree = ri.independentAgree;
    independentSources = ri.independentSources;
    // 嵌套标量（rating/trend）也一并上卷，保持字段层统一可见
    if (f.rating) f.rating = enrichFieldProvenance(f.rating, 'scalar');
    if (f.trend) f.trend = enrichFieldProvenance(f.trend, 'scalar');
  } else {
    independentAgree = safeNum(f.independentAgree, 0);
    independentSources = Array.isArray(f.independentSources) ? f.independentSources : [];
  }
  const basis = f.basis || 'unverified';
  const membership = deriveMembership(f, kind);
  const tags = [];
  tags.push(BASIS_TAG[basis] || basis);
  if (independentAgree >= 2) tags.push('2+ 独立来源佐证');
  else if (independentAgree === 1) tags.push('单一来源');
  else tags.push('无独立来源佐证');
  return Object.assign({}, f, {
    independentAgree,
    independentSources,
    fourState: { membership, basis },
    provenanceTags: tags,
  });
}

// ============================================================
// 来源可信门禁（P1-7 · A3-L1）
// 一条字段/空白可作「高可信结论」⟺ basis==='verified' 或 independentAgree>=2（双独立源）。
// 忠实助理纪律：单源（inferred/unverified/claimed）即便 confidence=high，也不得标「已查实」，
//   只能标 inferred + 附「单一来源/无佐证」说明。来源冲突 → 直接不可信。
// 返回 { credible, reason, level }：level ∈ 'high' | 'single' | 'weak'。
//   credible=true  ⟺ 通过 L1（可作为高可信结论对外呈现）
//   level='high'   → 双独立源或查实；'single' → 单源；'weak' → 无佐证/冲突
// ============================================================
function provenanceGate(field) {
  if (!field || typeof field !== 'object') return { credible: false, reason: '无字段数据', level: 'weak' };
  const basis = (field.fourState && field.fourState.basis) || field.basis || 'unverified';
  const ind = (typeof field.independentAgree === 'number') ? field.independentAgree : 0;
  if (basis === 'conflict') return { credible: false, reason: '来源冲突，无一致结论', level: 'weak' };
  const credible = (basis === 'verified') || (ind >= 2);
  if (credible) {
    let reason;
    if (ind >= 2) reason = ind + ' 个独立来源一致佐证';
    else reason = '已查实来源确认';
    return { credible: true, reason, level: 'high' };
  }
  let reason;
  if (ind === 1) reason = '单一来源，未达双独立源门槛（推测·未查实）';
  else if (basis === 'inferred') reason = '无独立来源佐证，仅推断（未查实）';
  else if (basis === 'claimed') reason = '品牌自称，无第三方佐证';
  else reason = '未验证 / 未探测';
  return { credible: false, reason, level: (ind === 1 ? 'single' : 'weak') };
}

// ============================================================
// 纠错回流编织（P0-5 · 工作流 C）
// 把一条「已审核 accept」的用户纠错作为真实来源（tier-1）编织回 comp.fieldSources，
// 增强该字段可信溯源与独立来源数（L1 门禁随之可能升级为"已查实/双独立源"）。
// 仅对明确有 fieldSources 键的字段编织，避免污染未知键：
//   channels.* / categories.* → 同键编织（getChannelField/getCategoryField 直接消费）
//   reviews*               → 编织进单一 'reviews' 桶（buildReviewField 消费）
//   price* / launchCadence → 暂无对应 fieldSources 键，跳过（准确率样本仍由 metrics 记录）
// 幂等：同一纠错 id 已织过则不重复。
// ============================================================
function weaveUserEvidence(comp, corr, humanText) {
  if (!comp || !corr || !corr.field) return false;
  const f = corr.field;
  let key = null;
  if (/^channels\./.test(f)) key = f;
  else if (/^categories\./.test(f)) key = f;
  else if (/^reviews/.test(f)) key = 'reviews'; // 单一 reviews 桶
  else return false; // price / launchCadence 暂跳过编织
  comp.fieldSources = comp.fieldSources || {};
  const arr = Array.isArray(comp.fieldSources[key]) ? comp.fieldSources[key] : [];
  // #5：多用户开放后，user-confirm 来源按 userId 去重（一个用户只贡献 1 个独立来源），
  // 防单用户刷独立来源数抬高 L1 门禁。同一用户重复确认同一字段 → 幂等不增长。
  const evId = 'user-confirm:' + (corr.actor || 'owner');
  if (arr.some(e => e.id === evId)) return false; // 幂等（按用户去重）
  arr.push({
    id: evId,
    tier: 1, // 用户附来源并经复核 = 真实来源
    kind: 'user-confirm',
    url: corr.source || '',
    title: (humanText || corr.text || '用户复核确认').slice(0, 200),
  });
  comp.fieldSources[key] = arr;
  return true;
}

module.exports = { tierSourceKind, claimToRecord, resolveFieldConfidence, enrichFieldProvenance, provenanceGate, weaveUserEvidence };
