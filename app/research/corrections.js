'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/corrections.js —— 导出: CONF_NUM, confNum, DISCLAIMER_TEXT, stableHash, activeCorrections, softQuarantine, buildCorrectionDashboard, scoreConfidence
// ============================================================

const CONF_NUM = { high: 85, medium: 60, low: 30 };
function confNum(c) { return CONF_NUM[c] != null ? CONF_NUM[c] : 40; }
// 忠实助理红线（P0-1）：用户纠错默认进「待复核」队列，不直接写库标 verified/high。
// 只有 confirm-correct（确认现值正确）或经复核 accept 的纠错才被编织进字段可信值。
const DISCLAIMER_TEXT = '此结论基于不足证据，仅供参考，不构成行动建议';
function stableHash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }
function activeCorrections(corrections) {
  // ▶ PRD v2.1 §0 数据主权：用户对全局库无写入权。已复核通过的纠错(accepted)仅作"复核触发信号"，
  //   不再覆盖展示值（展示值恒由系统采集推导）。仅 confirm-correct（确认系统值无误，非写入）与
  //   遗留 null 状态可参与——confirm-correct 不改变值，属安全强化。
  return (corrections || []).filter(x => (x.type === 'confirm-correct' && x.status !== 'rejected') || x.status == null);
}
// 优化六（2026-08-03，v2.1 修订）：待复核软隔离——pending 纠错在复核通过前不进 activeCorrections（零生效）；
// 提交即对该字段临时降级（值不变、置信降一级、标待复核）以反映"有人质疑"。复核通过后：accepted 不再改写全局，
// 仅标记 reverify（系统随后复采自修），降级随 pending 解除而恢复——展示值始终系统派生的，用户无写入权。
function softQuarantine(obj, pendingCount) {
  if (!obj || !pendingCount) return obj;
  const downBasis = { verified: 'inferred', inferred: 'unverified', unverified: 'unverified' };
  const downConf = { high: 'medium', medium: 'low', low: 'low' };
  if (obj.basis && downBasis[obj.basis]) obj.basis = downBasis[obj.basis];
  if (obj.confidence && downConf[obj.confidence]) obj.confidence = downConf[obj.confidence];
  obj.conflictNote = (obj.conflictNote ? obj.conflictNote + '；' : '') + `用户纠错待复核（已临时降级，复核通过后恢复；${pendingCount} 条待复核）`;
  obj.pendingQuarantine = true;
  return obj;
}
// 优化六：待复核时效仪表盘（顶层暴露，供用户看到队列积压与处理延迟）
function buildCorrectionDashboard(corrections) {
  const list = (corrections || []).filter(x => x.status === 'pending');
  const now = Date.now();
  const ages = list.map(x => { const t = new Date(x.at).getTime(); return isNaN(t) ? 0 : (now - t) / 3600000; });
  const avgAge = ages.length ? Math.round((ages.reduce((a, b) => a + b, 0) / ages.length) * 10) / 10 : 0;
  const oldest = list.length ? list.reduce((m, x) => { const t = new Date(x.at).getTime(); return isNaN(t) ? m : Math.min(m, t); }, now) : null;
  return {
    pendingCount: list.length,
    avgAgeHours: avgAge,
    oldestAt: (oldest && oldest !== now) ? new Date(oldest).toISOString() : null,
    items: list.slice(0, 30).map(x => ({ id: x.id, field: x.field, competitorId: x.competitorId, type: x.type, at: x.at }))
  };
}
// 候选/对手整体置信度：由来源证据数 + 字段置信度综合
function scoreConfidence(evidenceCount, fieldConfs) {
  let s = Math.min(evidenceCount, 5) * 8; // 来源交叉验证
  if (fieldConfs && fieldConfs.length) {
    const avg = fieldConfs.reduce((a, b) => a + confNum(b), 0) / fieldConfs.length;
    s = Math.round(s * 0.5 + avg * 0.5);
  }
  return Math.max(25, Math.min(95, s));
}


module.exports = { CONF_NUM, confNum, DISCLAIMER_TEXT, stableHash, activeCorrections, softQuarantine, buildCorrectionDashboard, scoreConfidence };
