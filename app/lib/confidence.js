// 群体空白「统一置信收敛」纯函数 —— 空白视图技术架构整改·架构整改#1 + 规范 A 的落点。
//
// 之所以独立成模块：gapConfidence 是纯函数（输入 sources + dimCoverage + tracked，输出
// 确定性 level/confidence），必须可被单元测试直接 import 锁定，避免「第一次用准不准」式穿帮。
// server.js 的 computeWhiteSpace 在 gap 生成边界调用本函数，前后端网关/测试均可复用同一份逻辑。
//
// 关键不变量（规范 A 最关键一条验收）：
//   dimCoverage < 0.7 时，无论有多少来源，level 恒为 'undetected'（绝不能为 'opportunity'）。
//   → 覆盖率不足的维度，群体性空白结论是「不可信」的，不得显示为可行动机会。
//   该不变量由 test/gap-confidence.test.js 直接锁死。

// 与 server.js 同一套置信度数值映射，避免输出漂移。
const CONF_NUM = { high: 85, medium: 60, low: 30 };
function confNum(c) { return CONF_NUM[c] != null ? CONF_NUM[c] : 40; }

/**
 * 群体空白置信收敛（纯函数）。
 * @param {Array<{name?:string, basis?:'verified'|'inferred'|'unverified'}>} sources 该 gap 的来源列表
 * @param {number} dimCoverage 该 gap 所属维度的「已采集品牌占比」（0~1）
 * @param {boolean} tracked 该维度是否为「被追踪维度」（未追踪维度如市场机会不按覆盖率惩罚）
 * @returns {{confidence:string, confidenceNum:number, basis:string, level:string, oppGate:boolean, covOk:boolean, verified:number}}
 */
function gapConfidence(sources, dimCoverage, tracked) {
  const srcs = Array.isArray(sources) ? sources : [];
  // 已查实品牌去重数（按品牌名，非记录条数）—— 与规范 B 同一去重口径
  const verifiedNames = new Set(srcs.filter(s => s && s.basis === 'verified').map(s => s.name));
  const verified = verifiedNames.size;
  const covOk = tracked ? (dimCoverage || 0) >= 0.7 : true; // 未追踪维度（市场机会等）不按覆盖率惩罚
  const oppGate = covOk && verified > 0;
  let confidence;
  // 不满足机会门槛（覆盖率<70% 或 无已查实来源）→ 不信任为群体结论，置信度封顶 low（规范：仅单家事实线索）
  if (!oppGate) confidence = 'low';
  else if (verified >= 2) confidence = 'high';
  else confidence = 'medium'; // 恰好 1 家已查实且覆盖率达标
  const confidenceNum = confNum(confidence);
  const basis = confidence === 'high' ? 'verified' : confidence === 'medium' ? 'inferred' : 'unverified';
  const level = oppGate ? 'opportunity' : 'undetected';
  return { confidence, confidenceNum, basis, level, oppGate, covOk, verified };
}

module.exports = { confNum, gapConfidence, CONF_NUM };
