'use strict';
// ============================================================
// 品类字段「值级交叉验证裁决树」—— 复用通用集合引擎 lib/setfield.js
// 仅保留品类专属的冲突说明文案；裁决逻辑全部下沉到 setfield。
// ============================================================
const { buildSetField, mapClaim } = require('./setfield.js');

const CATEGORY_CONFLICT_NOTE = '来源对该品类是否经营存在矛盾（"在售"与"未经营"证据并存）';

function buildCategoryField(claims, opts) {
  opts = opts || {};
  return buildSetField(claims, { ...opts, conflictNote: CATEGORY_CONFLICT_NOTE });
}

module.exports = { buildSetField, buildCategoryField, mapClaim };
