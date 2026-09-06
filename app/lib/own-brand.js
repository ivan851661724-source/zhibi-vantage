// ▶ 数据卫生②：自列竞品排除
// 输入竞品集排除用户自有实体；空白视图分母只计外部竞品（PetLuxV2 排第一污染分母的教训）。
// 纯函数库：server.js 在 discover / lookupBrand 时调用 autoExcludeOwnBrands，
// 把命中自有品牌的候选 id 自动塞进 state.excluded（reason='own-brand'），
// 复用现成的分母排除通道（computeWhiteSpace / computeOpportunityMap 均 filter excluded）。

function normToken(s) {
  // 大小写归一 + 去非字母数字与中文，便于跨写法匹配（"PetLux" / "pet lux" / "PETLUX"）
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9一-龥]+/g, '').trim();
}

function domainOfUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(String(url)) ? String(url) : 'http://' + String(url));
    return u.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// 自有品牌条目可能是「名字」或「带域名的字符串」：
//   "PetLux" / "petlux" / "petlux.com" / "https://petlux.com" / "www.petlux.com/shop"
// 分别抽出名字 token 与域名，双重匹配候选。
function ownBrandTokens(ownBrands) {
  const names = new Set();
  const domains = new Set();
  const list = Array.isArray(ownBrands) ? ownBrands : [];
  for (const raw of list) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) continue;
    const d = domainOfUrl(s);
    if (d) domains.add(d);
    const t = normToken(s);
    if (t) names.add(t);
  }
  return { names, domains };
}

// 单个候选是否命中自有品牌：名字 token 相等，或候选 url 域名命中自有域名。
// comp: { name, url }
function isOwnBrand(comp, ownBrands) {
  const { names, domains } = ownBrandTokens(ownBrands);
  if (!names.size && !domains.size) return false;
  const nm = normToken(comp && comp.name);
  if (nm && names.has(nm)) return true;
  const cd = domainOfUrl(comp && comp.url);
  if (cd && domains.has(cd)) return true;
  return false;
}

// 批量：返回 { excluded: [ids], reasons: { id: 'own-brand' } }
// 无 ownBrands 或无命中 → 返回空，绝不误伤。
function autoExcludeOwnBrands(competitors, ownBrands) {
  const excluded = [];
  const reasons = {};
  const list = Array.isArray(competitors) ? competitors : [];
  if (!Array.isArray(ownBrands) || !ownBrands.length) return { excluded, reasons };
  for (const c of list) {
    if (c && c.id != null && isOwnBrand(c, ownBrands)) {
      excluded.push(c.id);
      reasons[c.id] = 'own-brand';
    }
  }
  return { excluded, reasons };
}

module.exports = { normToken, domainOfUrl, ownBrandTokens, isOwnBrand, autoExcludeOwnBrands };
