'use strict';
// ============================================================
// 渠道字段「值级交叉验证裁决树」—— 复用通用集合引擎 lib/setfield.js
// 仅保留渠道专属的冲突说明文案；裁决逻辑全部下沉到 setfield，避免重复。
// ============================================================
const { buildSetField, mapClaim } = require('./setfield.js');

// 渠道专属：正负证据矛盾时的说明
const CHANNEL_CONFLICT_NOTE = '来源对该渠道是否进驻存在矛盾（"在售"与"未入驻"证据并存）';

function buildChannelField(claims, opts) {
  opts = opts || {};
  return buildSetField(claims, { ...opts, conflictNote: CHANNEL_CONFLICT_NOTE });
}

module.exports = { buildSetField, buildChannelField, mapClaim };
