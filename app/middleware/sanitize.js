'use strict';
// ============================================================
// 中间件：响应脱敏（v0.2）—— 隔离执行点之二（§5 Layer B / P1-4）
// 两层职责：
//   A) sanitizeBriefing：剥离一切"护城河资产"键——规则/权重/推理轨迹/训练数据/校准历史，
//      确保任何租户 API 响应、日志、报错都不泄露算法本体（竞品潜伏订阅逆向防护）。
//   B) debugMirror（P1-4）：超管脱敏排障视图——保留数据结构，但把可定位明文
//      （竞品品牌名 / 具体价格）替换为占位符，仅在工单授权后才看明文。
// ============================================================

// 含这些 token 的键名一律剥离（大小写/符号无关匹配）
const DENY_TOKENS = [
  'rule', 'rules', 'weight', 'weights', 'selection', 'score', 'scoring',
  'inference', 'reasoning', 'trace', 'trail', 'training', 'calibration',
  'modelweight', 'prompt', 'systemprompt', 'sourceweight', 'algorithm',
  'internal', 'secret', 'private', 'calibrate', 'heuristic'
];

function normKey(k) { return (k || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function keyBlocked(k) {
  const nk = normKey(k);
  if (!nk) return false;
  return DENY_TOKENS.some(t => nk.includes(t));
}

// 递归剥离护城河键，返回新对象（不改原对象）
function sanitizeBriefing(obj) {
  if (Array.isArray(obj)) return obj.map(sanitizeBriefing);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (keyBlocked(k)) continue;
      out[k] = sanitizeBriefing(obj[k]);
    }
    return out;
  }
  return obj;
}

// P1-4：可定位明文键 → 遮罩
const MASK_TOKENS = ['brand', 'competitor', 'company', 'price', 'cost', 'amount', 'pricename'];
function keyMasked(k) {
  const nk = normKey(k);
  if (!nk) return null;
  for (const t of MASK_TOKENS) if (nk.includes(t)) return t;
  return null;
}

// 脱敏排障视图：保留结构，遮罩品牌/价格明文
function debugMirror(obj, state) {
  const s = state || { n: 0 };
  if (Array.isArray(obj)) return obj.map(x => debugMirror(x, s));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      const mask = keyMasked(k);
      if (mask) {
        const isPrice = /price|cost|amount|价/.test(mask);
        if (typeof obj[k] === 'string' && obj[k]) {
          // 价格类遮罩为 <price>（不占品牌计数）；品牌类递增 <Brand n>
          out[k] = isPrice ? '<price>' : '<Brand ' + (++s.n) + '>';
        } else if (obj[k] && typeof obj[k] === 'object') {
          out[k] = debugMirror(obj[k], s); // 嵌套对象继续遮罩其品牌/价格子键
        } else {
          out[k] = obj[k];
        }
      } else {
        out[k] = debugMirror(obj[k], s);
      }
    }
    return out;
  }
  return obj;
}

module.exports = { sanitizeBriefing, debugMirror, DENY_TOKENS, MASK_TOKENS };
