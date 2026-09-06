'use strict';
// ============================================================
// 冲突裁决引擎（P1）：纯代码裁决，绝不调用 LLM。
// 处理 官网 / 第三方 / 用户贡献 / LLM候选 四者之间的数据冲突。
// 设计原则（忠实助理纪律）：
//   ① 不臆造：无来源 → 采纳值为 null，绝不猜一个值填上。
//   ② 不替用户下暗结论：来源冲突时，采纳「最高优先级来源的值」但置 conflictFlag、
//      封顶 low 置信，并在 reason 里透明写明谁和谁不一致，由用户拍板。
//   ③ 交叉验证即信任：≥2 个独立来源(按域名去重)取值一致 → 置信升 high（可溯源的信任，非宣称）。
// ============================================================
const { SOURCE_KIND } = require('./provenance.js');
const SI = require('./source-identity.js');

// 来源优先级（数值越大越权威）。可在 opts.precedence 覆盖，便于不同品类调权重。
const DEFAULT_PRECEDENCE = {
  [SOURCE_KIND.OFFICIAL]: 3,     // 官网：品牌自己说的，最权威（对其自身字段）
  [SOURCE_KIND.THIRD_PARTY]: 2, // 第三方（Crunchbase 等）：独立核验
  [SOURCE_KIND.USER]: 1,         // 用户贡献：主观但来自一线
  [SOURCE_KIND.LLM_ENUM]: 0,    // LLM 枚举：仅候选，不具裁决权
};

// 归一：比较取值时忽略大小写与首尾空白（如需更强归一由调用方先在证据层做）。
function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function hasValue(r) {
  return r && r.rawValue !== undefined && r.rawValue !== null && norm(r.rawValue) !== '';
}

// 裁决一组证据记录 → 采纳值 + 置信 + 冲突标志 + 可审计理由。
// opts: { precedence, crossValidate(true), onConflict('adopt-top'|'null') }
function adjudicate(records, opts) {
  opts = opts || {};
  const prec = opts.precedence || DEFAULT_PRECEDENCE;
  const cross = opts.crossValidate !== false;
  const onConflict = opts.onConflict || 'adopt-top';

  const recs = (records || []).filter(hasValue);
  if (recs.length === 0) {
    return { adoptedValue: null, confidence: 'none', conflictFlag: false, reason: 'no-source', sourcesConsidered: 0, independentAgree: 0, adoptedFrom: null };
  }

  // 排序：优先级降序；同优先级按抓取时间新→旧（以新为准）。
  const pr = (k) => (prec[k] != null ? prec[k] : -1);
  const sorted = recs.slice().sort((a, b) => {
    const d = pr(b.sourceKind) - pr(a.sourceKind);
    if (d !== 0) return d;
    return new Date(b.fetchedAt) - new Date(a.fetchedAt);
  });

  const top = sorted[0];
  const topVal = norm(top.rawValue);

  // 仅「真实来源」参与冲突与交叉验证——LLM 候选(llm_enum)不具裁决权，不得冒充佐证。
  const real = recs.filter((r) => r.sourceKind !== SOURCE_KIND.LLM_ENUM);
  const realVals = new Set(real.map((r) => norm(r.rawValue)));

  // 交叉验证：统计与 top 取值一致的「真实独立来源身份」数。
  // 关键纪律：按域名/URL 去重后的真实出处计数，而非 sourceKind 种类数——
  // 否则同域名的两个镜像站会被误算成 2 个独立来源，虚高置信。(P0-1 修复)
  const agreeInfo = SI.independentAgreement(real, topVal);
  const independentAgree = agreeInfo.count;
  const independentSources = agreeInfo.identities.filter((e) => e.agrees);

  // 冲突检测：任意两个真实来源取值不一致即冲突（无论优先级高低，分歧需对用户透明）。
  // LLM 候选的猜测不构成冲突——它本就被标为待核验、低置信。
  const conflict = realVals.size >= 2;
  let dissentKind = null;
  if (conflict) {
    for (const r of real) { if (norm(r.rawValue) !== topVal) { dissentKind = r.sourceKind; break; } }
  }

  // 置信裁决
  let confidence;
  if (conflict) confidence = 'low';                                  // 有真实来源反对 → 封底
  else if (cross && independentAgree >= 2) confidence = 'high';       // ≥2 独立真实来源一致 → 高
  else if (top.sourceKind === SOURCE_KIND.LLM_ENUM) confidence = 'low'; // LLM 候选无佐证 → 低
  else confidence = 'medium';

  // 冲突时的采纳策略：默认采纳最高优先级值并标记（透明、不静默），可选 null。
  let adoptedValue = topVal;
  if (conflict && onConflict === 'null') adoptedValue = null;

  const reason = conflict
    ? ('冲突：最高优先级来源(' + top.sourceKind + ')取值与真实来源(' + dissentKind + ')不一致；采纳前者的「' + topVal + '」但标记冲突，由你拍板')
    : (independentAgree >= 2 ? ('交叉验证：' + independentAgree + ' 个独立真实来源(按域名去重)一致 → ' + topVal) : ('单一来源(' + top.sourceKind + ')采纳 → ' + topVal));

  return {
    adoptedValue,
    adoptedFrom: top.sourceKind,
    confidence,
    conflictFlag: conflict,
    independentAgree,
    independentSources,
    sourcesConsidered: recs.length,
    reason,
  };
}

module.exports = { DEFAULT_PRECEDENCE, adjudicate };
