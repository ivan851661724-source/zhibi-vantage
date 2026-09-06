'use strict';
// ============================================================
// 集合类字段「值级交叉验证裁决树」—— 通用引擎（纯函数，可单测）
// 供 channels / categories 等「集合成员资格」字段复用，避免每类重写裁决逻辑。
// 设计原则（见项目记忆 · 忠实助理红线）：
//   - 集合成员只有三种确定态：【在 present】【确认不在 absent】【未探测 undetected】；"未探测"≠"确认不做"。
//   - 冲突不平均、不编造；多源不一致时【标记 conflict】，绝不合成假中间结论。
//   - 裁决结论（basis/confidence）由「证据层级 + 正负证据是否矛盾」共同决定，不由 LLM 拍脑袋。
//   - 用户纠错（wrong-state）是硬信号，对其自身数据的权威覆盖，零延迟自动生效。
// ============================================================

// 把单条判定（代码级/LLM 结论）映射成"主张"供裁决树消费
// claim: { tier:1|2|3, kind, stance:'present'|'absent', url, text }
const FC = require('./field-confidence.js');

function mapClaim(c, sources) {
  if (c.stance === 'present') {
    if (c.tier === 1) return { present: true, basis: 'verified', confidence: 'high', method: 'code-probe', sources, conflictNote: null, state: 'present' };
    if (c.tier === 2) return { present: true, basis: 'inferred', confidence: 'medium', method: 'code-probe', sources, conflictNote: null, state: 'present' };
    return { present: true, basis: 'inferred', confidence: 'low', method: 'llm-guess', sources, conflictNote: null, state: 'present' };
  }
  // absent（含"确认不在"与"未探测"两条语义）
  if (c.tier === 1) return { present: false, basis: 'verified', confidence: 'medium', method: 'neg-check', sources, conflictNote: null, state: 'absent' };
  if (c.tier === 2) return { present: false, basis: 'inferred', confidence: 'medium', method: 'neg-check', sources, conflictNote: null, state: 'absent' };
  return { present: false, basis: 'unverified', confidence: 'low', method: 'unprobed', sources, conflictNote: null, state: 'undetected' };
}

/**
 * 构建标准化集合字段（值级裁决）。
 * @param {Array} claims 主张数组：{tier:1|2|3, kind, stance:'present'|'absent', url, text}
 * @param {Object} opts {corrections:[{type,value,text}], conflictNote?:string}
 * @returns 标准化字段 {present,basis,confidence,method,sources,conflictNote,state}
 *          state ∈ 'present'|'absent'|'undetected'|'conflict'
 */
function buildSetField(claims, opts) {
  opts = opts || {};
  const corrections = opts.corrections || [];
  const conflictNoteDefault = opts.conflictNote || '来源对该条目是否存在存在矛盾（"存在"与"不存在"证据并存）';
  const all = (claims || []).map(c => ({ ...c }));

  // 用户纠错（硬信号）：wrong-state 覆盖一切，作为 tier-1 权威主张
  const uc = corrections.find(c => c.type === 'wrong-state' && /^(present|absent|undetected)$/.test(c.value));
  if (uc) all.unshift({ tier: 1, kind: 'user-correct', stance: uc.value, text: uc.text || '用户纠错', url: null });

  const sources = all.map(c => ({ url: c.url || null, tier: c.tier, kind: c.kind, stance: c.stance, agrees: null, text: c.text || '' }));
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
    return finalize({ present: false, basis: 'unverified', confidence: 'low', method: 'unprobed', sources, conflictNote: null, state: 'undetected' });
  }

  // ① 用户确认态主导
  if (uc) {
    if (uc.value === 'present') return finalize({ present: true, basis: 'verified', confidence: 'high', method: 'user-correct', sources, conflictNote: null, state: 'present' });
    if (uc.value === 'absent') return finalize({ present: false, basis: 'verified', confidence: 'medium', method: 'user-correct', sources, conflictNote: null, state: 'absent' });
    return finalize({ present: false, basis: 'unverified', confidence: 'low', method: 'user-correct', sources, conflictNote: null, state: 'undetected' });
  }

  // ② 正负证据同时存在 → 冲突（不臆造折中）
  const presentClaim = all.find(c => c.stance === 'present');
  const absentClaim = all.find(c => c.stance === 'absent');
  if (presentClaim && absentClaim) {
    sources.forEach(s => { s.agrees = null; });
    const lead = presentClaim.tier <= absentClaim.tier ? presentClaim : absentClaim;
    return finalize({
      present: lead.stance === 'present',
      basis: 'conflict', confidence: 'low', method: 'conflict', sources,
      conflictNote: conflictNoteDefault,
      state: 'conflict'
    });
  }

  // ③ 单条代码/LLM 判定 → 收敛置信：按「独立来源身份」而非 tier 直映射。
  //   cmpVal 取 stance（present/absent），一致身份≥2→high，单源→medium。
  const lead = all[0];
  const recs = all.map((c) => FC.claimToRecord(c, c.stance, c.url));
  const res = FC.resolveFieldConfidence(recs, { topVal: lead.stance });
  const out = mapClaim(lead, sources);
  out.confidence = res.confidence;
  out.independentAgree = res.independentAgree;
  out.independentSources = res.independentSources;
  return finalize(out);
}

module.exports = { buildSetField, mapClaim };
