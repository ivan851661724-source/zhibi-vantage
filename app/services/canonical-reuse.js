'use strict';
// ============================================================
// services/canonical-reuse.js —— M4 任务 B：公共事实复用判定与隔离
//
// 规格依据（冻结范围，见 docs/spec/plans/2026-10-18_M4_身份_复用_账本.md 任务 B）：
//   - 02_Data_Algorithm_Spec_v0.3.md §24：复用判定六元组 brand_id / market /
//     capability / entity scope / freshness SLA / collection policy version；
//     缺任一维度不得错误复用。本判定保守 fail-closed：失败方向只有"不共享"，
//     永不把不满足 scope 的结果错误放行为可复用。
//   - 00_Engineering_Baseline_v1.2.md §52：Canonical 层只涉公开品牌事实。
//     本判定不读取、不返回任何租户/工作区私有字段，白名单外输入字段直接拒绝。
//   - 任务 A（app/services/canonical-identity.js）只读消费 getIdentity：
//     仅 resolved 身份可进入复用路径；unresolved/conflicted 一律拒绝（不得强并）。
//
// 本层边界（无批准不得越界）：
//   - 纯只读判定：零 fs/时间依赖（结构性保证不写存储、不缓存、不改写观测时间），
//     无 HTTP 端点；身份服务故障向上抛出，不吞错伪装成"不可复用"。
//   - reusable:true 仅表示"六元组齐备且 Canonical 身份已 resolved，允许进入
//     Canonical 复用路径"，不主张存在已缓存结果；与具体采集结果的 scope 匹配、
//     采集合并/触发政策均未决（03 §22 + SCP-03 开放），不在本层实现。
//   - freshness 档位与 policy 版本的枚举注册表未决，本层不发明取值：两维度只
//     接受版本/档位词形的可识别词元，其余一律拒绝、绝不默认放行；批准的注册
//     表建立后应在调用方接线白名单。
//
// 稳定原因码：missing_<dim>（维度缺失/空）、invalid_<dim>（类型/形态非法）、
// identity_not_found、identity_not_resolved、unknown_input_field；
// <dim> 属于 brand_id/market/capability/entity_scope/freshness_bucket/policy_version。
// ============================================================
const { isSafeId } = require('../core/safe-id');

function failure(code, status = 500, issues = [code]) { const e = new Error(code); Object.assign(e, { code, status, issues }); return e; }

// 六元组（02 §24 顺序）：输入键 → 原因码维度名。
const DIMENSIONS = [
  ['brandId', 'brand_id'],
  ['market', 'market'],
  ['capability', 'capability'],
  ['entityScope', 'entity_scope'],
  ['freshnessBucket', 'freshness_bucket'],
  ['policyVersion', 'policy_version'],
];
const KNOWN_INPUT_FIELDS = new Set(DIMENSIONS.map(([key]) => key));
// freshness/policy 只接受可识别词元：字母数字开头，限 [A-Za-z0-9._:-]，≤64。
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
// market/capability/entity_scope 为有界安全自由文本：无 C0 控制字符与 DEL，≤128。
// 控制字符类经字符码构造，源文件保持零控制字节、零转义序列。
const CONTROL_RE = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127) + ']');
const FREE_TEXT_MAX = 128;

// 维度词法：缺失/空 → missing_<dim>；类型/形态非法 → invalid_<dim>；合法 → null。
function dimensionReason(value, dim) {
  if (value === undefined || value === null) return 'missing_' + dim;
  if (typeof value !== 'string') return 'invalid_' + dim;
  const trimmed = value.trim();
  if (!trimmed) return 'missing_' + dim;
  if (trimmed.length !== value.length) return 'invalid_' + dim; // 首尾空白视为非法形态
  if (dim === 'brand_id') return isSafeId(trimmed) ? null : 'invalid_brand_id';
  if (dim === 'freshness_bucket' || dim === 'policy_version') return TOKEN_RE.test(trimmed) ? null : 'invalid_' + dim;
  return trimmed.length <= FREE_TEXT_MAX && !CONTROL_RE.test(trimmed) ? null : 'invalid_' + dim;
}

// 判定服务工厂：identities 为任务 A 服务实例（只读消费 getIdentity，注入便于测试）。
function createCanonicalReuseService(options) {
  const { identities } = options || {};
  for (const key of Object.keys(options || {})) {
    if (key !== 'identities') throw failure('UNKNOWN_FACTORY_OPTION');
  }
  if (!identities || typeof identities.getIdentity !== 'function') throw failure('MISSING_IDENTITY_SERVICE');
  // evaluateReuse 对任何输入全量返回结论（不抛错）：结论只含 reusable 与稳定
  // 原因码，不回显任何输入值，每次返回全新对象。
  function evaluateReuse(input) {
    const plain = input !== null && typeof input === 'object' && !Array.isArray(input);
    const src = plain ? input : {}; // 非对象整体输入＝全维度缺失
    const reasons = [];
    for (const [key, dim] of DIMENSIONS) {
      const reason = dimensionReason(src[key], dim);
      if (reason) reasons.push(reason);
    }
    // 白名单外字段（含一切租户/工作区私有字段）直接拒绝：私有输入无法从任何
    // 路径影响或进入判定结果。
    if (plain && Object.keys(src).some(key => !KNOWN_INPUT_FIELDS.has(key))) reasons.push('unknown_input_field');
    if (reasons.length) return { reusable: false, reasons }; // 输入面不洁即拒绝，不触达身份层
    const identity = identities.getIdentity(src.brandId);
    if (!identity) return { reusable: false, reasons: ['identity_not_found'] };
    if (identity.identity_status !== 'resolved') return { reusable: false, reasons: ['identity_not_resolved'] };
    return { reusable: true, reasons: [] };
  }
  return { evaluateReuse };
}

module.exports = { createCanonicalReuseService };
