// 存量档案币种回填：只补标注，绝不改动任何价格数字
// 判定：老数据无法回溯当时站点币种 -> 一律标 assumed（按目标市场默认），前端会显示"按市场假定"
const fs = require('fs');
const path = require('path');
const CURRENCY_BY_REGION = { us: 'USD', uk: 'GBP', eu: 'EUR', jp: 'JPY', cn: 'CNY', sea: 'USD' };
function marketCurrency(regions) {
  if (!regions || !regions.length) return 'USD';
  for (const rg of regions) if (CURRENCY_BY_REGION[rg]) return CURRENCY_BY_REGION[rg];
  return 'USD';
}
const dir = path.join(__dirname, '..', 'data', 'projects');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
let touched = 0;
for (const f of files) {
  const p = path.join(dir, f);
  let s;
  try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { console.log('跳过（非法 JSON）: ' + f); continue; }
  const cur = marketCurrency(s.intent && s.intent.regions);
  let n = 0;
  (s.competitors || []).forEach(c => {
    if (!c.currency) { c.currency = cur; c.currencyBasis = 'assumed'; n++; }
  });
  if (n) {
    fs.writeFileSync(p + '.curbak', JSON.stringify(JSON.parse(fs.readFileSync(p, 'utf8')), null, 1));
    fs.writeFileSync(p, JSON.stringify(s, null, 1));
    touched++;
    console.log(`${f}: 地区=${JSON.stringify((s.intent || {}).regions || [])} -> ${cur}，回填 ${n} 家`);
  } else {
    console.log(`${f}: 无需回填`);
  }
}
console.log('完成，改动档案 ' + touched + ' 个');
