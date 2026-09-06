'use strict';
// ============================================================
// 关系计算与派生（评审 P0-7：从 server.js 抽出的自洽子模块）
// ------------------------------------------------------------
// 本模块只依赖自身常量/函数，不依赖 server.js 全局，故可被单测直接 require，
// 无需再用「字符串标记切片 + eval」抠函数（消除 slice 测试脆弱性）。
// decorateState 中耦合 getPriceField/CHANNELS 等的部分仍留在 server.js；
// 这里提供轻量 decorateRelationships 仅用于单测（只附 relationship + marketCurrency）。
// ============================================================
// 卖点受控词表（跨品类通用 · 与产品"面向所有赛道"定位一致）
// 仅保留真正跨赛道复用、且 AI 可稳定判定的通用卖点；潮玩专属词（盲盒/收藏级/IP授权/粉圈/互动可玩）已移除。
// 允许 AI / 用户在受控词之外补充自由词（混合方案：少量通用 + AI/自填），渲染层对未知词做兜底展示。
const SELLING_POINTS = ['affordablePrice', 'premiumMaterial', 'customization', 'fastShipping', 'ecoFriendly',
  'limitedEdition', 'handmade', 'personalGift', 'localCulture', 'innovation', 'designAesthetic',
  'serviceWarranty', 'healthSafe', 'convenience', 'naturalOrganic', 'exclusive'];
// 卖点受控词 → 中文标签（模块级，computeWhiteSpace 与 assessPositioning 共用）
const SP_LABEL = {
  affordablePrice: '平价 / 高性价比', premiumMaterial: '高端材质 / 溢价', customization: '可定制 / 个性化',
  fastShipping: '快发货 / 即时交付', ecoFriendly: '环保可持续', limitedEdition: '限量 / 稀缺',
  handmade: '手作 / 匠心', personalGift: '礼品属性', localCulture: '在地 / 本地文化',
  innovation: '科技创新', designAesthetic: '设计感', serviceWarranty: '服务 / 质保',
  healthSafe: '健康安全', convenience: '便捷省心', naturalOrganic: '天然有机', exclusive: '独家 / 会员专属'
};
const TACTICS = ['discount', 'bundle', 'subscription', 'ugcCampaign', 'livestreamSelling', 'membership', 'influencerSeeding', 'giveaway', 'preorder', 'loyaltyProgram', 'seasonalDrop', 'communityBuilding'];
// ---------- 币种：跟随目标市场，永不做汇率换算 ----------
// 铁律：换算会制造"精确假象"（汇率哪天的？含不含税？），我们只显示原币种原数字。
const CURRENCY_BY_REGION = { us: 'USD', uk: 'GBP', eu: 'EUR', jp: 'JPY', cn: 'CNY', sea: 'USD' };
const CURRENCY_SYMBOL = { USD: '$', GBP: '£', EUR: '€', JPY: '¥', CNY: '¥', AUD: 'A$', CAD: 'C$', SGD: 'S$', HKD: 'HK$' };
function marketCurrency(regions) {
  if (!regions || !regions.length) return 'USD';
  for (const rg of regions) if (CURRENCY_BY_REGION[rg]) return CURRENCY_BY_REGION[rg];
  return 'USD';
}
// 归一化用户「我的定位」：卖点受控词表 + 自定（≤3 总 / ≤2 自定），价位区间原币种
const SP_MAX = 3, SP_CUSTOM_MAX = 2;
function normalizeProfile(intent) {
  const p = intent && intent.profile;
  if (!p) return null;
  const out = { sellingPoints: [], priceBand: null };
  // 卖点：受控 key 直接收，自由文本作自定义；总量与自定量封顶
  const custom = [];
  if (Array.isArray(p.sellingPoints)) {
    for (const x of p.sellingPoints) {
      if (!x) continue;
      if (SELLING_POINTS.includes(x)) {
        if (!out.sellingPoints.includes(x)) out.sellingPoints.push(x);
      } else if (typeof x === 'string' && x.trim() && custom.length < SP_CUSTOM_MAX) {
        const t = x.trim();
        if (!out.sellingPoints.includes(t) && !custom.includes(t)) custom.push(t);
      }
      if (out.sellingPoints.length + custom.length >= SP_MAX) break;
    }
  }
  out.sellingPoints = out.sellingPoints.concat(custom).slice(0, SP_MAX);
  // 价位：min/max 数字（原币种，绝不换算），币种跟随市场
  const pb = p.priceBand;
  if (pb && (pb.min != null || pb.max != null)) {
    const min = pb.min == null ? null : Number(pb.min);
    const max = pb.max == null ? null : Number(pb.max);
    if (!isNaN(min) || !isNaN(max)) {
      out.priceBand = {
        min: isNaN(min) ? null : min,
        max: isNaN(max) ? null : max,
        currency: pb.currency || marketCurrency(intent.regions)
      };
    }
  }
  return (out.sellingPoints.length || out.priceBand) ? out : null;
}
function normalizeIntent(intent) {
  const i = intent || {};
  return {
    goals: Array.isArray(i.goals) ? i.goals.filter(x => typeof x === 'string') : [],
    regions: Array.isArray(i.regions) ? i.regions.filter(x => typeof x === 'string') : [],
    profile: normalizeProfile(i)
  };
}
// ---------- 「与你的关系」判定：纯代码派生，绝不猜测 ----------
// 四态：direct 直接对手 / indirect 间接对手 / unrelated 暂不直接相关 / undetermined 关系待定
// 判据（可验证、可复核，不依赖 LLM 主观判断）：
//   卖点重叠 = 双方「主打卖点」受控词表有交集
//   价位重叠 = 双方价位区间交叉（跨币种不比，返回未知而非猜"不重叠"）
//   direct  = 价位重叠 且 卖点重叠（正面硬刚同一定位）
//   unrelated = 价位与卖点「双已知且都不重叠」（确认不抢同一批客户）
//   indirect = 仅单一维度重叠（在价格或卖点上碰到你，但另一维不同）
//   undetermined = 数据不足以下结论（任一维度未知，则不强行定性）
function priceRangeOf(comp) {
  const pts = (comp.pricePoints || []).filter(n => typeof n === 'number' && !isNaN(n));
  if (pts.length) return { min: Math.min(...pts), max: Math.max(...pts), currency: comp.currency };
  return null;
}
function computeRelationship(comp, profile) {
  if (!profile) return { code: 'undetermined', basis: 'no-profile', label: '关系待定' };
  const mySP = new Set(profile.sellingPoints || []);
  const compSP = new Set(comp.sellingPoints || []);
  let spOverlap = null;
  if (mySP.size && compSP.size) {
    let hit = false;
    for (const x of mySP) if (compSP.has(x)) { hit = true; break; }
    spOverlap = hit; // 双方都有卖点：有交集=true，无交集=false（不是未知）
  } else if (mySP.size || compSP.size) {
    spOverlap = false; // 一方有、另一方无
  }
  const myPB = profile.priceBand;
  const compPR = priceRangeOf(comp);
  let priceOverlap = null;
  if (myPB && myPB.min != null && myPB.max != null && compPR && compPR.min != null && compPR.max != null) {
    if (myPB.currency && compPR.currency && myPB.currency !== compPR.currency) priceOverlap = null; // 跨币种，不猜
    else priceOverlap = !(compPR.max < myPB.min || compPR.min > myPB.max);
  }
  if (priceOverlap === true && spOverlap === true) return { code: 'direct', basis: 'price+sp', label: '直接对手' };
  if (priceOverlap === false && spOverlap === false) return { code: 'unrelated', basis: 'no-touch', label: '暂不直接相关' };
  if (priceOverlap === true || spOverlap === true) return { code: 'indirect', basis: 'partial', label: '间接对手' };
  return { code: 'undetermined', basis: 'insufficient', label: '关系待定' };
}
// 在响应序列化前给每个竞品附上 relationship（派生字段，不落库；profile 变则重算）
// #309：¥ 在 CNY / JPY 上同符号，显示须显式带币种代码避免歧义（¥CNY / ¥JPY）
function curSym(cur) {
  if (cur === 'CNY') return '¥CNY';
  if (cur === 'JPY') return '¥JPY';
  return CURRENCY_SYMBOL[cur] || (cur ? cur + ' ' : '$');
}
function fmtMoney(n, cur) {
  if (n == null || isNaN(n)) return '';
  const v = (cur === 'JPY' || cur === 'CNY') ? Math.round(n) : Math.round(n * 100) / 100;
  return curSym(cur) + (Number.isInteger(v) ? v : v.toFixed(2));
}
// 从站点 HTML 探测店铺实际结算币种（Shopify/OG/schema.org/meta 多路），探不到返回 null —— 不猜
const CURRENCY_PATTERNS = [
  /shopify\.currency\s*=\s*\{\s*"active"\s*:\s*"([a-z]{3})"/i,        // Shopify 标准（带引号 active）
  /shopify\.currency\s*=\s*\{\s*active\s*:\s*"([a-z]{3})"/i,          // Shopify 松散 JSON（无引号 active）
  /"currencycode"\s*:\s*"([a-z]{3})"/i,
  /property=["']product:price:currency["'][^>]*content=["']([a-z]{3})["']/i,  // OG
  /itemprop=["']pricecurrency["'][^>]*content=["']([a-z]{3})["']/i,
  /name=["']twitter:price:currency["'][^>]*content=["']([a-z]{3})["']/i,
  /"pricecurrency"\s*:\s*"([a-z]{3})"/i,
  /"priceCurrency"\s*:\s*"([a-z]{3})"/i,                              // JSON-LD (schema.org)
  /presentment_currencies["']?\s*:\s*\[["']([a-z]{3})["']/i,
  /data-currency=["']([a-z]{3})["']/i,
  /moneyFormat[^>]*?([¥€£₹₩])/i                                      // 货币符号兜底（出现在 moneyFormat 语境）
];
// 货币符号 → 币种（仅作最后兜底，避免把文案里偶发的符号当结算币种）
const SYMBOL_CURRENCY = { '¥': 'CNY', '￥': 'CNY', '€': 'EUR', '£': 'GBP', '₹': 'INR', '₩': 'KRW' };
function detectCurrency(html) {
  if (!html) return null;
  for (const re of CURRENCY_PATTERNS) {
    const m = html.match(re);
    if (m && m[1]) { const c = m[1].toUpperCase(); if (CURRENCY_SYMBOL[c]) return c; }
  }
  // 兜底：仅在"符号紧贴数字"的价格语境下才认（如 ¥199 / 199¥），避免文案里偶发的符号误判为结算币种
  const SYM_RE = /(¥|￥|€|£|₹|₩)\s*\d|\d\s*(¥|￥|€|£|₹|₩)/;
  if (SYM_RE.test(html)) {
    const m = html.match(SYM_RE);
    const sym = m[1] || m[2];
    if (sym && SYMBOL_CURRENCY[sym]) return SYMBOL_CURRENCY[sym];
  }
  return null;
}
// 价格阶梯：每个币种给"市场原生档位"，不是把美元档按汇率硬套过去
const LADDER_THRESHOLDS = {
  USD: [15, 30, 60, 120], EUR: [15, 30, 60, 120], GBP: [12, 25, 50, 100],
  CNY: [100, 200, 400, 800], JPY: [2000, 4000, 8000, 16000],
  AUD: [25, 50, 100, 200], CAD: [20, 40, 80, 160], SGD: [20, 40, 80, 160], HKD: [120, 240, 480, 960]
};
function priceLadder(cur) {
  const t = LADDER_THRESHOLDS[cur] || LADDER_THRESHOLDS.USD;
  const s = curSym(cur);
  return [
    { key: 'b1', label: `<${s}${t[0]}`, min: 0, max: t[0] },
    { key: 'b2', label: `${s}${t[0]}-${t[1]}`, min: t[0], max: t[1] },
    { key: 'b3', label: `${s}${t[1]}-${t[2]}`, min: t[1], max: t[2] },
    { key: 'b4', label: `${s}${t[2]}-${t[3]}`, min: t[2], max: t[3] },
    { key: 'b5', label: `>${s}${t[3]}`, min: t[3], max: 1e9 }
  ];
}

// ---------- 置信度数值化 ----------

// 轻量派生（供单测）：仅附 relationship + marketCurrency，不碰价格/渠道字段
function decorateRelationships(s) {
  if (!s || !Array.isArray(s.competitors)) return s;
  const profile = s.intent && s.intent.profile;
  for (const c of s.competitors) c.relationship = computeRelationship(c, profile);
  s.marketCurrency = marketCurrency(s.intent && s.intent.regions);
  return s;
}

module.exports = { SELLING_POINTS, SP_LABEL, TACTICS, CURRENCY_BY_REGION, CURRENCY_SYMBOL, marketCurrency, SP_MAX, SP_CUSTOM_MAX, normalizeProfile, normalizeIntent, priceRangeOf, computeRelationship, curSym, fmtMoney, CURRENCY_PATTERNS, detectCurrency, LADDER_THRESHOLDS, priceLadder, decorateRelationships };
