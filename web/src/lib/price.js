'use strict';
// 知彼 Vantage · 价格解析（单一实现的前端份）
// 纪律（docs/01-前端架构规范.md §6）：本函数与 app/lib/pricefield.js 的 parsePriceRange
// 必须逐字符一致，由 `pnpm check:price`（scripts/check-price-parity.mjs）在 CI 强制校验。
// 任一侧修改价格解析，必须双侧同步，否则 check 失败。
// 故保持 plain JS 原样拷贝（不加类型标注、不改格式），供 check 脚本逐字符比对。
function parsePriceRange(str, currency) {
  if (!str || typeof str !== 'string') return null;
  const nums = (str.match(/[\d][\d.,]*/g) || []).map(s => parseFloat(s.replace(/,/g, ''))).filter(n => !isNaN(n) && n > 0);
  if (nums.length >= 2) return [Math.min(...nums), Math.max(...nums)];
  if (nums.length === 1) return [nums[0], nums[0]];
  return null;
}

module.exports = { parsePriceRange };
