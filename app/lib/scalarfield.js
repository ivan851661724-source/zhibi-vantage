'use strict';
// ============================================================
// 单值字段「值级交叉验证裁决树」—— 通用引擎（纯函数，可单测）
// 供 launchCadence / reviews 等「单一标量值」字段复用。
// P0-1 主链路接入：置信度由「独立来源身份交叉验证」收敛（见 lib/field-confidence.js），
// 不再按 tier 直映射（收敛版：单源→medium，≥2 独立源→high）。
// 设计原则（见项目记忆 · 忠实助理红线）：
//   - 值只有三种态：【有值 present】【未探测 undetected（value=null）】【冲突 conflict（多源不一致）】。
//   - 冲突不平均、不编造；多源给出不同值 → 标记 conflict，绝不合成假中间值。
//   - 裁决（basis/confidence）由「证据层级 + 多源是否矛盾」决定，不由 LLM 拍脑袋。
//   - 用户纠错（wrong-value / over-confident）是硬信号，对其自身数据的权威覆盖，零延迟生效。
// ============================================================

// 把单条判定映射成"主张"供裁决树消费
const FC = require('./field-confidence.js');

function mapClaim(c, sources) {
  if (c.tier === 1) return { value: c.value, basis: 'verified', confidence: 'high', method: 'code-probe', sources, conflictNote: null, state: 'present' };
  if (c.tier === 2) return { value: c.value, basis: 'inferred', confidence: 'medium', method: 'code-probe', sources, conflictNote: null, state: 'present' };
  return { value: c.value, basis: 'inferred', confidence: 'low', method: 'llm-guess', sources, conflictNote: null, state: 'present' };
}

/**
 * 构建标准化单值字段（值级裁决）。
 * @param {Array} claims 主张数组：{tier:1|2|3, kind, value, url, text}
 * @param {Object} opts {corrections:[{type,value,text}], conflictNote?:string}
 * @returns 标准化字段 {value,basis,confidence,method,sources,conflictNote,state}
 *          state ∈ 'present'|'undetected'|'conflict'
 */
function buildScalarField(claims, opts) {
  opts = opts || {};
  const corrections = opts.corrections || [];
  const conflictNoteDefault = opts.conflictNote || '来源对该值给出不同结论，存在矛盾';
  const all = (claims || []).map(c => ({ ...c }));

  // 用户纠错（硬信号）：wrong-value 覆盖一切，作为 tier-1 权威主张
  const uc = corrections.find(c => c.type === 'wrong-value' && c.value !== undefined && c.value !== null);
  if (uc) all.unshift({ tier: 1, kind: 'user-correct', value: uc.value, text: uc.text || '用户纠错', url: null });

  const sources = all.map(c => ({ url: c.url || null, tier: c.tier, kind: c.kind, value: c.value, agrees: null, text: c.text || '' }));
  const overConf = corrections.some(c => c.type === 'over-confident');
  const finalize = (r) => {
    if (overConf && r.basis !== 'unverified') {
      const down = { verified: 'inferred', inferred: 'unverified', conflict: 'conflict' };
      const downConf = { high: 'medium', medium: 'low', low: 'low' };
      r = { ...r, basis: down[r.basis] || r.basis, confidence: downConf[r.confidence] || r.confidence, conflictNote: (r.conflictNote ? r.conflictNote + '；' : '') + '用户反馈：原置信度偏高，已降级' };
    }
    return r;
  };

  // 无任何主张 → 未探测
  if (!all.length) {
    return finalize({ value: null, basis: 'unverified', confidence: 'low', method: 'unprobed', sources, conflictNote: null, state: 'undetected' });
  }

  // ① 用户纠错主导
  if (uc) {
    return finalize({ value: uc.value, basis: 'verified', confidence: 'high', method: 'user-correct', sources, conflictNote: null, state: 'present' });
  }

  // ② 多源值不一致 → 冲突（不臆造折中）
  const distinct = new Set(all.map(c => JSON.stringify(c.value)));
  if (distinct.size > 1) {
    sources.forEach(s => { s.agrees = null; });
    const lead = all.slice().sort((a, b) => a.tier - b.tier)[0];
    return finalize({
      value: lead.value,
      basis: 'conflict', confidence: 'low', method: 'conflict', sources,
      conflictNote: conflictNoteDefault,
      state: 'conflict'
    });
  }

  // ③ 单值（或全一致）→ 收敛置信：按「独立来源身份」而非 tier 直映射。
  //   单源(哪怕 tier-1 实抓)→medium；≥2 独立源一致→high（闭合裂缝 A）。
  const lead = all[0];
  const recs = all.map((c) => FC.claimToRecord(c, c.value, c.url));
  const res = FC.resolveFieldConfidence(recs, { topVal: lead.value });
  const out = mapClaim(lead, sources);
  out.confidence = res.confidence;
  out.independentAgree = res.independentAgree;
  out.independentSources = res.independentSources;
  return finalize(out);
}

module.exports = { buildScalarField, mapClaim };
