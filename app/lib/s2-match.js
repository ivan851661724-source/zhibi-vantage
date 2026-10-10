'use strict';
// ============================================================
// lib/s2-match.js —— S2 赛道匹配分（算法规格 20261003 §5.1 / 抓取需求 §1.1 · 纯函数零依赖）
// 结构化数据算匹配分，不靠 LLM 猜（规格 §二：准入裁决必须可复现）。
//   匹配分 = 目标类目商品占比 × 0.6 + 标题关键词命中占比 × 0.4
//   · typeRatio：product_type 命中赛道词的商品数 / 已分类商品数（product_type 单值字段）
//   · titleHitRatio：标题命中赛道词的商品数 / 商品总数
// 取舍（规格 5.1）：
//   · 未分类（product_type 为空）占比 > 40% → 匹配分标「演算」（降权，不得冒充实抓结论）
//   · 杂货铺判定：类目去重 ≥3 且目标类目占比 <40% → 直接剔除（不进打分）；
//     目标类目一个都没命中 → 无法判定目标类目，不判杂货铺（null），不误杀
//   · 关键词匹配：ASCII 词按词边界（maker 不命中 makeup），CJK 按子串
//   · 赛道词与 product_type 语言不通（中文赛道 × 英文类目）时 typeRatio 可能恒 0——
//     此时 titleHit 可用（店铺若面向该市场，标题常含译名）；两者皆不可测 → 无法判定
// ============================================================

function extractKeywords(track) {
  const t = String(track || '').toLowerCase();
  if (!t) return [];
  const words = t.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(w => w.length >= 3 || /[\u4e00-\u9fff]/.test(w));
  return Array.from(new Set(words));
}

function hitsKeyword(text, kws) {
  const s = String(text || '').toLowerCase();
  if (!s || !kws.length) return false;
  return kws.some(k => {
    if (/[\u4e00-\u9fff]/.test(k)) return s.includes(k); // 中文词无词边界，子串匹配
    const re = new RegExp('(^|[^a-z0-9])' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^a-z0-9])');
    return re.test(s);
  });
}

// items: mapShopifyItems 产物（须含 title/type）；track: 用户赛道词
function computeS2Match(items, track) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  if (!total) return null;
  const kws = extractKeywords(track);
  if (!kws.length) {
    return { score: null, typeRatio: null, titleHitRatio: null, basis: 'unverified', groceryStore: null, note: '无赛道词，无法计算匹配分' };
  }
  const classified = list.filter(x => String(x.type || '').trim());
  const unclassifiedShare = (total - classified.length) / total;
  const distinctTypes = new Set(classified.map(x => String(x.type).trim().toLowerCase())).size;
  const typeMatched = classified.filter(x => hitsKeyword(x.type, kws));
  const titleHit = list.filter(x => hitsKeyword(x.title, kws));

  const typeRatio = classified.length ? typeMatched.length / classified.length : null;
  const titleHitRatio = titleHit.length / total;
  // typeRatio 不可测（全店未分类）时只按标题命中出分，标演算（规格 5.1 降权纪律）
  const score = typeRatio != null ? typeRatio * 0.6 + titleHitRatio * 0.4 : (titleHitRatio || null);
  const degraded = typeRatio == null || unclassifiedShare > 0.4;

  // 杂货铺判定：类目去重 ≥3 且目标类目占比 <40%；目标类目零命中 → 无法判定（不误杀）
  // 默认 false（类目 <3 的专注店不适用该规则，明确"非杂货铺"）；null 仅用于"无法判定"
  let groceryStore = false;
  if (distinctTypes >= 3 && typeMatched.length > 0 && typeRatio < 0.4) groceryStore = true;
  else if (typeRatio != null && typeMatched.length === 0) groceryStore = null;

  const parts = [];
  parts.push(typeRatio != null ? `类目占比 ${(typeRatio * 100).toFixed(0)}%×0.6` : '类目未分类');
  parts.push(`标题命中 ${(titleHitRatio * 100).toFixed(0)}%×0.4`);
  if (degraded) parts.push(`未分类 ${(unclassifiedShare * 100).toFixed(0)}%`);
  return {
    score: score != null ? Math.round(score * 1000) / 1000 : null,
    typeRatio: typeRatio != null ? Math.round(typeRatio * 1000) / 1000 : null,
    titleHitRatio: Math.round(titleHitRatio * 1000) / 1000,
    unclassifiedShare: Math.round(unclassifiedShare * 1000) / 1000,
    distinctTypes,
    groceryStore,
    basis: degraded ? 'inferred' : 'verified',
    note: `S2 匹配分（结构化）：${parts.join(' + ')}${degraded ? '（演算：未分类占比高，降权）' : ''}`
  };
}

module.exports = { computeS2Match, extractKeywords, hitsKeyword };
