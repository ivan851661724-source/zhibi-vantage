'use strict';
// ============================================================
// 口碑字段「值级交叉验证裁决树」—— 复合字段（纯函数，可单测）
// reviews 由四部分构成，分别走同构引擎：
//   - rating      ：数值标量 → scalarfield
//   - trend       ：枚举标量（up/down/stable）→ scalarfield
//   - negThemes   ：主题列表（每主题单 present）→ setfield（按主题）
//   - posThemes   ：主题列表（每主题单 present）→ setfield（按主题）
// 忠实助理红线：每条主张带 basis/confidence/来源；LLM 单源推算 → inferred/low；
//               用户纠错（评分/趋势 wrong-value、主题 wrong-state）是硬信号，零延迟生效。
// ============================================================
const { buildScalarField } = require('./scalarfield.js');
const { buildSetField } = require('./setfield.js');

const CONF_ORDER = { high: 3, medium: 2, low: 1 };
const BASIS_ORDER = { verified: 3, inferred: 2, unverified: 1, conflict: 1 };

// 主题级纠错的 field key：reviews.negThemes.<encodedTheme> / reviews.posThemes.<encodedTheme>
function themeCorr(corrections, prefix, theme) {
  const key = prefix + '.' + encodeURIComponent(theme);
  return (corrections || []).filter(x => x.field === key);
}
function minConf(arr) {
  const cs = arr.filter(Boolean);
  if (!cs.length) return 'low';
  return cs.reduce((a, b) => (CONF_ORDER[a] <= CONF_ORDER[b] ? a : b));
}
function minBasis(arr) {
  const bs = arr.filter(Boolean);
  if (!bs.length) return 'unverified';
  return bs.reduce((a, b) => (BASIS_ORDER[a] <= BASIS_ORDER[b] ? a : b));
}
function dedupeSources(srcs) {
  const seen = new Set();
  const out = [];
  (srcs || []).forEach(s => {
    const k = (s.url || '') + '|' + (s.text || '');
    if (!seen.has(k)) { seen.add(k); out.push(s); }
  });
  return out;
}

// 主题列表字段：每个主题独立值级裁决（present/inferred/low；纠错 absent → verified/absent）
function buildThemeField(themes, corr, prefix) {
  const items = (themes || []).map(t => {
    const c = buildSetField(
      [{ tier: 3, kind: 'llm-guess', stance: 'present', text: t }],
      { corrections: themeCorr(corr, prefix, t) }
    );
    return { text: t, ...c };
  });
  return {
    items,
    basis: minBasis(items.map(i => i.basis)),
    confidence: minConf(items.map(i => i.confidence)),
    sources: dedupeSources(items.flatMap(i => i.sources || []))
  };
}

/**
 * 构建标准化口碑复合字段（值级裁决）。
 * @param {Object} rv 原始 reviews：{rating, trend, posThemes[], negThemes[], ...}
 * @param {Array} corrections 纠错数组，细粒度 key：
 *        reviews.rating / reviews.trend（标量 wrong-value）
 *        reviews.negThemes.<enc> / reviews.posThemes.<enc>（主题 wrong-state）
 * @param {Array} [srcs] 可选：fieldSources['reviews'] 证据级来源（{id,url,tier,kind,title}），
 *        用于把真实来源 url 穿入 rating/trend 标量 claim，使独立来源去重对口碑生效（P0-1 url 桥接）。
 * @returns {rating, trend, negThemes, posThemes, basis, confidence, sources, method}
 */
function buildReviewField(rv, corrections, srcs) {
  rv = rv || {};
  const corr = corrections || [];
  const fScalar = (k) => corr.filter(x => x.field === 'reviews.' + k);
  const srcList = Array.isArray(srcs) ? srcs : [];

  // 评分（标量）
  const ratingVal = (rv.rating != null && !isNaN(Number(rv.rating))) ? Number(rv.rating) : null;
  const ratingClaims = (ratingVal != null && srcList.length)
    ? srcList.map(e => ({ tier: e.tier || 3, kind: e.kind || 'review', value: ratingVal, stance: 'present', url: e.url || null, text: e.title || '口碑评分来源' }))
    : (ratingVal != null ? [{ tier: 3, kind: 'llm-guess', value: ratingVal, text: 'LLM 口碑评分' }] : []);
  const rating = buildScalarField(ratingClaims, { corrections: fScalar('rating') });

  // 趋势（标量枚举）
  const trendVal = ['up', 'down', 'stable'].includes(rv.trend) ? rv.trend : null;
  const trendClaims = (trendVal != null && srcList.length)
    ? srcList.map(e => ({ tier: e.tier || 3, kind: e.kind || 'review', value: trendVal, stance: 'present', url: e.url || null, text: e.title || '口碑趋势来源' }))
    : (trendVal != null ? [{ tier: 3, kind: 'llm-guess', value: trendVal, text: 'LLM 口碑趋势' }] : []);
  const trend = buildScalarField(trendClaims, { corrections: fScalar('trend') });

  // 负面 / 正面主题列表
  const negThemes = buildThemeField(rv.negThemes || [], corr, 'reviews.negThemes');
  const posThemes = buildThemeField(rv.posThemes || [], corr, 'reviews.posThemes');

  const basis = minBasis([rating.basis, trend.basis, negThemes.basis, posThemes.basis]);
  const confidence = minConf([rating.confidence, trend.confidence, negThemes.confidence, posThemes.confidence]);
  const sources = dedupeSources([
    ...(rating.sources || []), ...(trend.sources || []),
    ...(negThemes.sources || []), ...(posThemes.sources || [])
  ]);
  return { rating, trend, negThemes, posThemes, basis, confidence, sources, method: 'llm-review' };
}

module.exports = { buildReviewField, buildThemeField };
