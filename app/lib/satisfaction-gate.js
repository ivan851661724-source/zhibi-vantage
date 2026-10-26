'use strict';
// ============================================================
// lib/satisfaction-gate.js —— 满意度 × 重要性 散点门槛（唯一真源）
// ------------------------------------------------------------
// SC-12 r3 §五：**只保留一套输入和一套输出**
//   · computeOpportunityMap() 负责生成唯一的 scatterGate；
//   · Foundation 直接复用 map.scatterGate，不再从 themes 重组对象；
//   · 前端散点只消费 scatterGate.objects 的坐标/证据/样本范围。
//
// 门槛（§五.3/§五.4）：可比对象必须同时具备
//   1. 可核验满意度数值 satisfaction + 情绪分类依据（来源字段/确定性规则/模型提取）
//   2. 可核验重要性数值 importance + **提及品牌广度的确定性计算**（不得复用情绪分类依据）
//   3. Evidence/Snapshot 引用，且引用的观察时间落在该对象的时间窗口内
//   4. 样本范围 sampleScope 相同或明确属于同一可比分组
//   5. 时间窗口一致或有明确交集
// 且**同一可比分组**内合格对象数 ≥ MIN_OBJECTS（§五.5：任一分组不足 3 个都不出图）。
//
// 红线：只有评分没有重要性 → 不出图；禁止用品牌数/页面数/默认值补 satisfaction/importance；
//       服务端给坐标；重叠只做视觉避让，数值不变。
// ============================================================

const MIN_OBJECTS = 3;

// 情绪分类依据（满意度用）
const SATISFACTION_BASES = ['source_field', 'deterministic_rule', 'model_extraction'];

// 重要性依据：只接受「提及品牌广度」的确定性计算（§五.3 不得复用情绪分类依据）
const IMPORTANCE_BASES = ['mention_breadth'];

// 兼容旧调用方（SENTIMENT_BASIS_KINDS 仍在 opportunity.js 使用）
const SENTIMENT_BASIS_KINDS = SATISFACTION_BASES;

const WINDOW_SLACK_MS = 24 * 3600 * 1000; // 证据与窗口的时间容差（采集日与发布日可能跨日）

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
function arr(v) { return Array.isArray(v) ? v.filter(Boolean) : []; }
function ts(v) { if (!v) return null; const t = Date.parse(String(v)); return isFinite(t) ? t : null; }

function hasSatisfactionBasis(b) {
  return typeof b === 'string' && SATISFACTION_BASES.indexOf(b) !== -1;
}
function hasImportanceBasis(b) {
  return typeof b === 'string' && IMPORTANCE_BASES.indexOf(b) !== -1;
}

// 样本范围归一：同一可比分组必须是完全一致的 scope 标签（大小写/空白归一）
function normScope(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/\s+/g, ' ');
  return t ? t : null;
}

function windowOf(o) {
  const w = o && o.window;
  if (!w) return { from: null, to: null, fromTs: null, toTs: null };
  const from = w.from ? String(w.from) : null;
  const to = w.to ? String(w.to) : (w.from ? String(w.from) : null);
  return { from, to, fromTs: ts(from), toTs: ts(to) };
}

function validWindow(w) { return !!(w && w.fromTs != null && w.toTs != null && w.fromTs <= w.toTs); }

// 两窗口是否有交集（明确交集，允许 0 容差；相等也算交集）
function windowsIntersect(a, b) {
  if (!validWindow(a) || !validWindow(b)) return false;
  return Math.max(a.fromTs, b.fromTs) <= Math.min(a.toTs, b.toTs);
}

// §五.4：Evidence 是否属于该主题与时间窗口（observedAt 必须在窗口内，允许跨日容差）
function evidenceWithinWindow(refs, w) {
  const out = [];
  for (const r of arr(refs)) {
    const id = r && (r.evidenceId || r.snapshotId);
    if (!id) continue;
    const at = ts(r.observedAt);
    if (at == null) continue;                       // 无观察时间 → 无法证明属于该窗口
    if (!validWindow(w)) continue;                  // 无窗口 → 不可比较
    if (at < w.fromTs - WINDOW_SLACK_MS || at > w.toTs + WINDOW_SLACK_MS) continue;
    out.push(r);
  }
  return out;
}

// 结构化证据引用（§三.2）：{ evidenceId, snapshotId, sourceUrl, brandId, observedAt }
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

// 单对象校验：字段 → 依据 → 证据
function validateObject(o) {
  const reasons = [];
  if (!o || typeof o !== 'object') return { ok: false, reasons: ['对象缺失'] };

  const sat = num(o.satisfaction);
  const imp = num(o.importance);
  if (sat == null) reasons.push('缺少可核验满意度数值');
  if (!hasSatisfactionBasis(o.satisfactionBasis)) reasons.push('缺少满意度计算依据');
  if (imp == null) reasons.push('缺少可核验重要性数值');
  if (!hasImportanceBasis(o.importanceBasis)) reasons.push('缺少重要性计算依据（需为提及品牌广度的确定性计算）');

  const w = windowOf(o);
  if (!validWindow(w)) reasons.push('缺少可比较的时间窗口');

  const scope = normScope(o.sampleScope);
  if (!scope) reasons.push('缺少样本范围说明');

  const refs = arr(o.evidenceRefs).filter(r => r && (r.evidenceId || r.snapshotId));
  if (!refs.length) reasons.push('缺少 Evidence/Snapshot 引用');
  else if (validWindow(w) && !evidenceWithinWindow(refs, w).length) reasons.push('Evidence 观察时间不在该对象时间窗口内');

  return { ok: reasons.length === 0, reasons };
}

// 按样本范围分组，再按时间窗口交集切簇（§五.5）
function groupComparable(list) {
  const byScope = new Map();
  for (const e of list) {
    const scope = normScope(e.sampleScope);
    if (!scope) continue;
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push(e);
  }
  const groups = [];
  for (const [scope, items] of byScope) {
    // 贪心切簇：与当前簇的交集窗口保持有效则并入，否则另起一簇
    const clusters = [];
    for (const it of items) {
      const w = windowOf(it);
      if (!validWindow(w)) continue;
      let placed = false;
      for (const c of clusters) {
        const inter = {
          fromTs: Math.max(c.window.fromTs, w.fromTs),
          toTs: Math.min(c.window.toTs, w.toTs),
        };
        if (inter.fromTs <= inter.toTs) {
          c.items.push(it);
          c.window = inter;
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push({ scope, window: { fromTs: w.fromTs, toTs: w.toTs }, items: [it] });
    }
    for (const c of clusters) {
      groups.push({
        scope,
        window: {
          from: new Date(c.window.fromTs).toISOString(),
          to: new Date(c.window.toTs).toISOString(),
        },
        objects: c.items,
        count: c.items.length,
        eligible: c.items.length >= MIN_OBJECTS,
      });
    }
  }
  groups.sort((a, b) => (b.count - a.count) || String(a.scope).localeCompare(String(b.scope)));
  return groups;
}

/**
 * 统一门槛判定（唯一入口）。
 * @param {Array} rawObjects 主题级对象（含 satisfaction/importance/两者的依据/证据/样本范围/窗口）
 * @param {Object} opts { minObjects, corpusWindow }
 * @returns {Object} 服务端结论（前端只消费，不自行判定）
 */
function evaluateScatterGate(rawObjects, opts) {
  const o = opts || {};
  const min = typeof o.minObjects === 'number' ? o.minObjects : MIN_OBJECTS;
  const list = Array.isArray(rawObjects) ? rawObjects.filter(Boolean) : [];

  const evaluated = list.map(o2 => {
    const v = validateObject(o2);
    const w = windowOf(o2);
    const refs = arr(o2.evidenceRefs).map(r => normalizeRef(r, o2.brandId)).filter(Boolean);
    return {
      oid: o2.oid || o2.id || null,
      label: o2.label || o2.theme || null,
      // 真实坐标：不做 jitter / 偏移 / 默认值填充
      satisfaction: num(o2.satisfaction),
      importance: num(o2.importance),
      satisfactionBasis: o2.satisfactionBasis || null,
      importanceBasis: o2.importanceBasis || null,
      satisfactionBasisText: o2.satisfactionBasisText || null,
      importanceBasisText: o2.importanceBasisText || null,
      sampleScope: normScope(o2.sampleScope),
      window: { from: w.from, to: w.to },
      themeWindow: o2.themeWindow || null,
      brandsMentioned: num(o2.brandsMentioned),
      brandsWithVoice: num(o2.brandsWithVoice),
      posMentions: num(o2.posMentions),
      negMentions: num(o2.negMentions),
      confidence: o2.confidence || null,
      evidenceRefs: refs,
      eligible: v.ok,
      missing: v.reasons,
    };
  });

  const qualified = evaluated.filter(x => x.eligible);
  const groups = groupComparable(qualified);
  const best = groups.filter(g => g.eligible && g.count >= min)[0] || null;
  const available = !!best;
  const chosen = available ? best.objects : [];

  // 未出图时给出可执行的补齐方向；reason 恒为规定文案（前端与验收断言依赖），具体缺口放 detail
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
    } else if (!groups.length) {
      detail = '合格对象缺少可比较的样本范围或时间窗口，无法归入同一可比分组。';
    } else {
      const g0 = groups[0];
      detail = '同一可比分组内最多 ' + g0.count + ' 个对象（' + g0.scope + '），至少需要 ' + min
        + ' 个样本范围一致且时间可比的对象才出图。';
    }
  }

  return {
    available,
    minObjects: min,
    evaluatedObjects: evaluated.length,
    // 可比对象数 = 最大可比分组内的合格对象数（不足门槛时也如实返回，供 UI 说明差多少）
    comparableObjects: groups.length ? groups[0].count : 0,
    // 只有 available 时才给坐标（避免前端拿到坐标自行出图）
    objects: available ? chosen : [],
    groups: groups.map(g => ({
      scope: g.scope,
      window: g.window,
      count: g.count,
      eligible: g.eligible,
      labels: g.objects.map(x => x.label),
    })),
    chosenGroup: best ? { scope: best.scope, window: best.window, count: best.count } : null,
    rejected: available ? [] : evaluated.filter(x => !x.eligible)
      .map(x => ({ label: x.label, missing: x.missing })),
    reason,
    detail,
    coordsBasis: '满意度 = 正负提及比（正面 / (正面+负面)）；重要性 = 提及品牌广度（提到该主题的品牌数 / 有声音品牌数）',
    limits: [
      '满意度分母只含已分类（正/负）提及；中性或未分类评论既不进分子也不进分母。',
      '可比对象必须样本范围一致、时间窗口有明确交集，且 Evidence 落在同一窗口内。',
      '重叠点只做视觉避让与重叠计数，坐标数值不被修改。',
    ],
  };
}

module.exports = {
  MIN_OBJECTS,
  SATISFACTION_BASES,
  IMPORTANCE_BASES,
  SENTIMENT_BASIS_KINDS,
  normScope,
  windowsIntersect,
  evidenceWithinWindow,
  validateObject,
  normalizeRef,
  evaluateScatterGate,
};
