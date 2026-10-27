'use strict';
// ============================================================
// lib/satisfaction-gate.js —— 满意度 × 重要性 散点门槛（唯一真源）
// ------------------------------------------------------------
// SC-12「合并前事实一致性整改」§四：
//   旧 opportunity（v.items 主题）与新 foundation（satisfactionScatter）
//   **必须共用这一套门槛**，不得由两套逻辑分别决定是否画图。
//
// 门槛（§四.1）：可比对象必须**同时**具备
//   1. 可核验满意度数值 satisfaction 及计算依据 satisfactionBasis
//   2. 可核验重要性数值 importance 及计算依据 importanceBasis
//   3. Evidence / Snapshot 引用（evidenceRefs 至少一条含 evidenceId）
//   4. 一致或明确可比较的样本范围 sampleScope 与时间窗口 window
// 且合格对象数 ≥ MIN_OBJECTS。
//
// 红线（§四.2 / §四.4）：
//   · 只有评分、没有重要性 → 不合格，不出图
//   · 禁止用品牌数、页面数或默认值补出 satisfaction / importance
//   · §四.3：坐标、计算依据、证据全部由服务端给出；前端只消费结果
//   · 坐标重叠只能做视觉避让，数据值不得改变（服务端永远返回真实值）
// ============================================================

const MIN_OBJECTS = 3;

// 可解释的情绪依据种类（与 opportunity.js SENTIMENT_BASIS_KINDS 对齐：
// 来源原始字段 / 确定性规则 / 可追溯模型提取 —— 三者之外不算「有依据」）
const SENTIMENT_BASIS_KINDS = ['source_field', 'deterministic_rule', 'model_extraction'];

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function arr(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }

function hasBasis(b) {
  return typeof b === 'string' && SENTIMENT_BASIS_KINDS.indexOf(b) !== -1;
}

// 单对象校验：返回 { ok, reasons[] }
function validateObject(o) {
  const reasons = [];
  if (!o || typeof o !== 'object') return { ok: false, reasons: ['对象缺失'] };

  const sat = num(o.satisfaction);
  const imp = num(o.importance);
  if (sat == null) reasons.push('缺少可核验满意度数值');
  if (!hasBasis(o.satisfactionBasis)) reasons.push('缺少满意度计算依据');
  if (imp == null) reasons.push('缺少可核验重要性数值');
  if (!hasBasis(o.importanceBasis)) reasons.push('缺少重要性计算依据');

  const refs = arr(o.evidenceRefs).filter(r => r && (r.evidenceId || r.snapshotId));
  if (!refs.length) reasons.push('缺少 Evidence/Snapshot 引用');

  const w = o.window || null;
  const hasWindow = !!(w && (w.from || w.to));
  if (!hasWindow) reasons.push('缺少可比较的时间窗口');
  if (!o.sampleScope || typeof o.sampleScope !== 'string') reasons.push('缺少样本范围说明');

  return { ok: reasons.length === 0, reasons };
}

// 结构化证据引用（§五.2）：{ evidenceId, snapshotId, sourceUrl, brandId, observedAt }
function normalizeRef(r, brandId) {
  if (!r || typeof r !== 'object') return null;
  const evidenceId = typeof r.evidenceId === 'string' && r.evidenceId ? r.evidenceId : null;
  const snapshotId = typeof r.snapshotId === 'string' && r.snapshotId ? r.snapshotId : null;
  if (!evidenceId && !snapshotId) return null;
  return {
    evidenceId,
    snapshotId,
    sourceUrl: typeof r.sourceUrl === 'string' && r.sourceUrl ? r.sourceUrl : null,
    brandId: (typeof r.brandId === 'string' && r.brandId) ? r.brandId : (brandId || null),
    observedAt: typeof r.observedAt === 'string' && r.observedAt ? r.observedAt : null,
  };
}

/**
 * 统一门槛判定。
 * @param {Array} rawObjects 主题级对象（含 satisfaction/importance/依据/证据/窗口）
 * @param {Object} opts { minObjects }
 * @returns {Object} 服务端结论（前端只消费，不自行判定）
 */
function evaluateScatterGate(rawObjects, opts) {
  const o = opts || {};
  const min = typeof o.minObjects === 'number' ? o.minObjects : MIN_OBJECTS;
  const list = Array.isArray(rawObjects) ? rawObjects.filter(Boolean) : [];

  const evaluated = list.map(o2 => {
    const v = validateObject(o2);
    return {
      oid: o2.oid || o2.id || null,
      label: o2.label || o2.theme || null,
      // 真实坐标：不做任何 jitter / 偏移 / 默认值填充
      satisfaction: num(o2.satisfaction),
      importance: num(o2.importance),
      satisfactionBasis: o2.satisfactionBasis || null,
      importanceBasis: o2.importanceBasis || null,
      satisfactionBasisText: o2.satisfactionBasisText || null,
      importanceBasisText: o2.importanceBasisText || null,
      sampleScope: o2.sampleScope || null,
      window: o2.window || { from: null, to: null },
      brandsMentioned: num(o2.brandsMentioned),
      brandsWithVoice: num(o2.brandsWithVoice),
      posMentions: num(o2.posMentions),
      negMentions: num(o2.negMentions),
      confidence: o2.confidence || null,
      evidenceRefs: arr(o2.evidenceRefs).map(r => normalizeRef(r, o2.brandId)).filter(Boolean),
      eligible: v.ok,
      missing: v.reasons,
    };
  });

  const qualified = evaluated.filter(x => x.eligible);
  const available = qualified.length >= min;

  // 未出图时给出可执行的补齐方向（不空泛、不承诺）。
  // reason 恒为规定文案（SC-12 §六.3 / §八 ⑫b 断言依赖），具体缺口放 detail。
  const NO_PLOT_TEXT = '当前评论样本不足，暂不生成满意度分布';
  let reason = null;
  let detail = null;
  if (!available) {
    reason = NO_PLOT_TEXT;
    if (!evaluated.length) {
      detail = '当前没有可核验的用户声音主题；需要带可解释情绪依据（来源字段 / 确定性规则 / 模型提取）的评论观察。';
    } else if (qualified.length === 0) {
      const top = (evaluated[0] && evaluated[0].missing) || [];
      detail = '已有 ' + evaluated.length + ' 个主题，但都缺少「' + (top[0] || '满意度或重要性的可核验依据') + '」；只带评分、没有重要性依据时不出图。';
    } else {
      detail = '合格对象 ' + qualified.length + ' 个，至少需要 ' + min + ' 个同时具备满意度、重要性、证据与时间窗口的对象。';
    }
  }

  return {
    available,
    minObjects: min,
    evaluatedObjects: evaluated.length,
    comparableObjects: qualified.length,
    // 只有 available 时才给坐标（避免前端拿到坐标自行出图）
    objects: available ? qualified : [],
    rejected: available ? [] : evaluated.filter(x => !x.eligible)
      .map(x => ({ label: x.label, missing: x.missing })),
    reason,
    detail,
    coordsBasis: '满意度 = 正负提及比（正面 / (正面+负面)）；重要性 = 提及广度（提到该主题的品牌数 / 有声音品牌数）',
    limits: [
      '满意度分母只含已分类（正/负）提及；中性或未分类评论既不进分子也不进分母。',
      '样本范围与时间窗口不一致时必须标注差异，不得直接比较。',
      '重叠点只做视觉避让与重叠计数，坐标数值不被修改。',
    ],
  };
}

module.exports = {
  MIN_OBJECTS,
  SENTIMENT_BASIS_KINDS,
  validateObject,
  normalizeRef,
  evaluateScatterGate,
};
