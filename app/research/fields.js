'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/fields.js —— 导出: getPriceField, getChannelField, getCategoryField, getLaunchCadence, getReviewField, posSummary, compareField
// ============================================================

const { CATEGORIES, CHANNELS, marketCurrency, seedingLabel } = require('./vocab.js');
const { activeCorrections, softQuarantine } = require('./corrections.js');
const { buildPriceField, parsePriceRange } = require('../lib/pricefield.js');
const { buildChannelField } = require('../lib/channelfield.js');
const { buildCategoryField } = require('../lib/categoryfield.js');
const { buildScalarField } = require('../lib/scalarfield.js');
const { buildReviewField } = require('../lib/reviewfield.js');
const { channelTypeOf } = require('../lib/blue-ocean.js');

// ============================================================
// 横向对比：点击某字段名 → 拉全品牌对比表（纯聚合，不调 LLM；忠实：价格不换算币种）
// ============================================================
// 取价格字段契约：优先用研究时算好的 priceField；旧数据无则按遗留字段重建。
// 支持用户纠错（硬信号零延迟生效）：wrong-value / wrong-currency / over-confident。
function getPriceField(c, corrections) {
  const corr = activeCorrections((corrections || []).filter(x => /^price/.test(x.field || '')));
  const curCorr = corr.find(x => x.type === 'wrong-currency' && x.currency);
  const cur = curCorr ? curCorr.currency : (c.currency || 'USD');
  // 无纠错且已算好 → 直接返回存储结果
  if (c.priceField && c.priceField.display && !corr.length) { if (!c.priceField.priceScope) c.priceField.priceScope = 'list'; return c.priceField; }
  const claims = (c.priceClaims && c.priceClaims.length) ? c.priceClaims
    : (() => {
        const pts = (c.pricePoints || []).filter(n => typeof n === 'number' && n > 0);
        const cl = [];
        if (c.priceVerified && pts.length) cl.push({ tier: 1, kind: 'shopify', value: [Math.min(...pts), Math.max(...pts)], url: null, text: '实抓价格点', points: c.pricePoints.slice() });
        else if (pts.length) cl.push({ tier: 3, kind: 'llm-guess', value: [Math.min(...pts), Math.max(...pts)], url: null, text: 'LLM 价格点' });
        if (c.priceBand && c.priceBand.range) {
          const pv = parsePriceRange(c.priceBand.range, cur);
          if (pv) cl.push({ tier: (c.priceBand.basis === 'verified') ? 1 : 2, kind: 'llm-band', value: pv, url: null, text: c.priceBand.range });
        }
        return cl;
      })();
  let pf = buildPriceField(claims, { currency: cur, corrections: corr });
  // ▶ PRD整改 §3.4 #3：价格口径——恒为官网挂牌标价（list），不含税运；前端恒标注，跨品牌只比同口径
  pf.priceScope = 'list';
  pf.includesShipping = false;
  // over-confident：用户认为当前置信度虚高 → 降级（用户对其自身数据的硬信号，可自动生效）
  if (corr.some(x => x.type === 'over-confident') && pf.basis !== 'unverified') {
    const down = { verified: 'inferred', inferred: 'unverified' };
    const downConf = { high: 'medium', medium: 'low', low: 'low' };
    pf = { ...pf, basis: down[pf.basis] || pf.basis, confidence: downConf[pf.confidence] || pf.confidence, conflictNote: (pf.conflictNote ? pf.conflictNote + '；' : '') + '用户反馈：原置信度偏高，已降级' };
  }
  const pricePend = (corrections || []).filter(x => x.status === 'pending' && /^price/.test(x.field || ''));
  if (pricePend.length) pf = softQuarantine(pf, pricePend.length);
  return pf;
}

// 取渠道字段契约：优先用研究时算好的 channelFields；旧数据无则按遗留 channels 重建。
// 支持用户纠错（硬信号零延迟生效）：wrong-state（在售/确认未入驻/未探测）覆盖一切；over-confident 降级。
// 与 getPriceField 同构：每次 decorateState 实时重算，不落盘（忠实、可迭代）。
// P0-1 url 桥接：重建 claim 时优先用 fieldSources['channels.'+chKey] 中带真实 url 的条目，
// 保留来源级粒度 → 多域渠道可触发独立来源去重（此前 url:null 导致去重休眠）。
function getChannelField(c, corrections, channelKey) {
  const corr = activeCorrections((corrections || []).filter(x => x.field === ('channels.' + channelKey)));
  const stored = (c.channels && c.channels[channelKey]) || null;
  const srcs = (c.fieldSources && c.fieldSources['channels.' + channelKey]) || [];
  const claims = [];
  if (srcs.length) {
    // 用证据级来源逐条还原（带 url/tier/kind），使独立来源身份判定可用
    const stance = (stored && stored.present === false) ? 'absent' : 'present';
    for (const e of srcs) {
      if (!e) continue;
      claims.push({ tier: e.tier || 2, kind: e.kind || 'third', stance, url: e.url || null, text: e.title || '' });
    }
  }
  if (!claims.length && stored) {
    if (stored.present === true) {
      const tier = stored.basis === 'verified' ? 1 : (stored.basis === 'inferred' ? 2 : 3);
      const kind = /shopify/i.test(stored.note || '') ? 'shopify' : (/官网/.test(stored.note || '') ? 'official' : 'probe');
      claims.push({ tier, kind, stance: 'present', url: null, text: stored.note || '' });
    } else {
      // present===false：basis=verified → 确认未入驻(tier1)；否则只是"未探测"(tier3，绝不能当确认缺席)
      if (stored.basis === 'verified') claims.push({ tier: 1, kind: 'neg-check', stance: 'absent', url: null, text: stored.note || '' });
      else claims.push({ tier: 3, kind: 'unprobed', stance: 'absent', url: null, text: stored.note || '未探测' });
    }
  }
  // over-confident 降级已在 buildChannelField 内统一处理（与价格同构，纯函数可单测）
  const chPend = (corrections || []).filter(x => x.status === 'pending' && x.field === ('channels.' + channelKey));
  const chBuilt = buildChannelField(claims, { corrections: corr });
  return chPend.length ? softQuarantine(chBuilt, chPend.length) : chBuilt;
}

// 取品类字段契约：优先用研究时算好的 categories；旧数据无则按遗留 categories 重建。
// 与 getChannelField 同构：每次 decorateState 实时重算，支持用户纠错（wrong-state 硬信号零延迟生效）。
function getCategoryField(c, corrections, catKey) {
  const corr = activeCorrections((corrections || []).filter(x => x.field === ('categories.' + catKey)));
  const stored = (c.categories && c.categories[catKey]) || null;
  const claims = [];
  if (stored) {
    if (stored.present === true) {
      const tier = stored.basis === 'verified' ? 1 : (stored.basis === 'inferred' ? 2 : 3);
      claims.push({ tier, kind: 'official', stance: 'present', url: null, text: stored.note || '' });
    } else {
      // present===false：verified → 确认缺席(tier1)；inferred → 推断缺席(tier2)；其余未探测(tier3)
      const tier = stored.basis === 'verified' ? 1 : (stored.basis === 'inferred' ? 2 : 3);
      const kind = stored.basis === 'verified' ? 'neg-check' : 'unprobed';
      claims.push({ tier, kind, stance: 'absent', url: null, text: stored.note || '未探测' });
    }
  }
  const catPend = (corrections || []).filter(x => x.status === 'pending' && x.field === ('categories.' + catKey));
  const catBuilt = buildCategoryField(claims, { corrections: corr });
  return catPend.length ? softQuarantine(catBuilt, catPend.length) : catBuilt;
}

// 取上新节奏字段契约：从近期动作(recentMoves)数量推导节奏标签；用户纠错(wrong-value)硬信号零延迟生效。
// 与价格/品类同构：每次 decorateState 实时重算。
// P0-1 url 桥接：每条 recentMove 按 fieldSources['recentMoves.'+i] 还原 claim（带 url），
// 多域多动作→独立来源≥2→high（此前合并单 claim + url:null 导致去重休眠）。
function getLaunchCadence(c, corrections) {
  const corr = activeCorrections((corrections || []).filter(x => x.field === 'launchCadence'));
  const claims = [];
  const moves = (c.recentMoves || []).filter(m => m && (m.desc || m.type));
  const n = moves.length;
  let label = null;
  if (n >= 3) label = '高频（月更及以上）';
  else if (n === 2) label = '中频（季更）';
  else if (n === 1) label = '低频（偶发）';
  if (label) {
    moves.forEach((m, i) => {
      const srcs = (c.fieldSources && c.fieldSources['recentMoves.' + i]) || [];
      // 多条动作共享同一节奏标签 → 一致值；不同域名来源→独立源计数
      if (srcs.length) {
        for (const e of srcs) {
          if (!e) continue;
          claims.push({ tier: e.tier || 3, kind: e.kind || 'moves', value: label, stance: 'present', url: e.url || null, text: e.title || m.desc || '' });
        }
      } else {
        const tier = (m.basis === 'verified') ? 1 : (m.basis === 'inferred' ? 2 : 3);
        claims.push({ tier, kind: 'moves', value: label, stance: 'present', url: null, text: m.desc || '' });
      }
    });
  }
  const cadPend = (corrections || []).filter(x => x.status === 'pending' && x.field === 'launchCadence');
  const cadBuilt = buildScalarField(claims, { corrections: corr, conflictNote: '来源对该品牌上新节奏给出不同判断' });
  return cadPend.length ? softQuarantine(cadBuilt, cadPend.length) : cadBuilt;
}

// 取口碑复合字段契约：rating/trend 标量 + neg/pos 主题列表，各自值级裁决；用户纠错零延迟生效。
// 与价格/渠道同构：每次 decorateState 实时重算。
function getReviewField(c, corrections) {
  const corr = activeCorrections((corrections || []).filter(x => x.field && x.field.startsWith('reviews')));
  const revPend = (corrections || []).filter(x => x.status === 'pending' && x.field && x.field.startsWith('reviews'));
  const revBuilt = buildReviewField(c.reviews || {}, corr, (c.fieldSources && c.fieldSources['reviews']) || null);
  return revPend.length ? softQuarantine(revBuilt, revPend.length) : revBuilt;
}

// ▶ P2 #8 定位战略：归一化摘要（兼容旧版字符串 positioning 与新版结构化对象），供对比/动力种子/快照复用。
function posSummary(c) {
  const p = c && c.positioning;
  if (!p) return '';
  if (typeof p === 'string') return p.slice(0, 200);
  return (p.valueProposition || p.differentiation || '').slice(0, 200);
}

function compareField(state, fieldKey) {
  const excluded = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) excluded.add(c.id); }); // #305 错配/低置信卡一并剔除
  const comps = state.competitors.filter(c => c.status === 'done' && !excluded.has(c.id));
  const MKT_CUR = marketCurrency(state.intent && state.intent.regions);
  const BAND_LABEL = { mass: '大众档', mid: '中端', premium: '高端', ultra: '超高端' };
  const srcOf = (c, key) => {
    const fs0 = (c.fieldSources || {})[key];
    return (fs0 && fs0.length) ? fs0.map(s => ({ url: s.url, title: s.title || (s.kind || '来源') })) : [];
  };
  const base = (c) => ({ id: c.id, name: c.name, tier: c.tier, confidence: c.confidence });
  // 跨币种提示：价格类尤其要如实说明"不换算"
  const crossNote = (arr) => {
    const diff = arr.filter(c => (c.currency || MKT_CUR) !== MKT_CUR).map(c => `${c.name}(${c.currency || MKT_CUR})`);
    return diff.length ? `各对手计价币种不一（${diff.slice(0, 6).join('、')}），下表不换算币种，请按各品牌原币种对照。` : '';
  };

  switch (fieldKey) {
    case 'price': {
      const corr = (state.fieldCorrections || []).filter(x => x.field === 'price');
      const rows = comps.map(c => {
        const cur = c.currency || MKT_CUR;
        const pf = getPriceField(c, corr.filter(x => x.competitorId === c.id));
        return { ...base(c), currency: cur, display: pf.display, basis: pf.basis, confidence: pf.confidence, method: pf.method, sources: pf.sources, conflictNote: pf.conflictNote, realScraped: pf.realScraped };
      });
      return { field: 'price', label: '价格带 / 价格点', kind: 'scalar', note: crossNote(comps), rows };
    }
    case 'sellingPoints': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.sellingPoints || []), display: (c.sellingPoints || []).join('/') || '—', sources: srcOf(c, 'sellingPoints') }));
      return { field: 'sellingPoints', label: '主打卖点', kind: 'scalar', rows };
    }
    case 'positioning': {
      const rows = comps.map(c => ({ ...base(c), display: posSummary(c) || '—', basis: c.positioningBasis === 'verified' ? 'verified' : (c.positioning ? 'claimed' : null), sources: srcOf(c, 'positioning') }));
      return { field: 'positioning', label: '定位战略', kind: 'scalar', rows };
    }
    case 'products': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.products || []), display: (c.products || []).join('、') || '—', sources: srcOf(c, 'products') }));
      return { field: 'products', label: '产品矩阵', kind: 'scalar', rows };
    }
    case 'launchCadence': {
      const rows = comps.map(c => {
        const lc = getLaunchCadence(c, state.fieldCorrections || []);
        return { ...base(c), display: lc.value || '—', basis: lc.basis, confidence: lc.confidence, method: lc.method, sources: lc.sources, conflictNote: lc.conflictNote };
      });
      return { field: 'launchCadence', label: '上新节奏', kind: 'scalar', rows };
    }
    case 'audiences': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.audiences || []), display: (c.audiences || []).join('、') || '—' }));
      return { field: 'audiences', label: '目标人群', kind: 'scalar', rows };
    }
    case 'channels': {
      // 只渲染用户勾选的平台（忠实助理：不展示用户不关心的平台）
      const plat = (state.intent && state.intent.platforms);
      const cols = (plat && plat.length) ? plat : CHANNELS;
      const columns = cols.map(ch => ({ key: ch, label: ch, type: channelTypeOf(ch) }));
      const rows = comps.map(c => {
        const cells = {};
        cols.forEach(ch => {
          const cf = getChannelField(c, state.fieldCorrections || [], ch);
          const seeding = (c.channels && c.channels[ch] && c.channels[ch].seedingVolume) || null;
          const t = channelTypeOf(ch);
          if (!cf || cf.state === 'undetected') cells[ch] = { state: 'unprobed' };
          else if (t === 'content' || t === 'hybrid') {
            // content/hybrid：以种草声量为主信号，无官店≠空白
            if (seeding && seeding !== 'none') cells[ch] = { state: 'seeding', seeding, present: !!cf.present, note: '种草声量' + seedingLabel(seeding) + (cf.present ? ' · 有官方店' : ''), basis: cf.basis, confidence: cf.confidence };
            else if (cf.present === true) cells[ch] = { state: 'present', note: cf.conflictNote || '', basis: cf.basis, confidence: cf.confidence };
            else cells[ch] = { state: 'low-seeding', seeding: seeding || 'none', note: '无官方店且种草声量' + seedingLabel(seeding || 'none'), basis: cf.basis, confidence: cf.confidence };
          } else if (cf.present === true) cells[ch] = { state: 'present', note: cf.conflictNote || '', basis: cf.basis, confidence: cf.confidence };
          else cells[ch] = { state: cf.basis === 'verified' ? 'absent-verified' : 'absent', note: cf.conflictNote || '', basis: cf.basis, confidence: cf.confidence };
        });
        return { ...base(c), cells };
      });
      return { field: 'channels', label: '渠道布局', kind: 'matrix', columns, rows };
    }
    case 'categories': {
      const columns = CATEGORIES.map(cat => ({ key: cat, label: cat }));
      const rows = comps.map(c => {
        const cells = {};
        CATEGORIES.forEach(cat => {
          const cf = getCategoryField(c, state.fieldCorrections || [], cat);
          if (!cf || cf.state === 'undetected') cells[cat] = { state: 'unprobed' };
          else if (cf.present === true) cells[cat] = { state: 'present', note: cf.conflictNote || '', basis: cf.basis, confidence: cf.confidence };
          else cells[cat] = { state: cf.basis === 'verified' ? 'absent-verified' : 'absent', note: cf.conflictNote || '', basis: cf.basis, confidence: cf.confidence };
        });
        return { ...base(c), cells };
      });
      return { field: 'categories', label: '品类布局', kind: 'matrix', columns, rows };
    }
    case 'regions': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.regions || []), display: (c.regions || []).join('、') || '—' }));
      return { field: 'regions', label: '覆盖地域', kind: 'scalar', rows };
    }
    case 'reviews': {
      const rows = comps.map(c => {
        const rf = c.reviewField || getReviewField(c, state.fieldCorrections || []);
        return {
          ...base(c),
          rating: rf.rating.value != null ? rf.rating.value : '—',
          trend: rf.trend.value || '',
          neg: (rf.negThemes.items || []).map(i => i.text),
          pos: (rf.posThemes.items || []).map(i => i.text),
          basis: rf.basis, confidence: rf.confidence, sources: srcOf(c, 'reviews')
        };
      });
      return { field: 'reviews', label: '口碑评分', kind: 'scalar', rows };
    }
    case 'painPoints': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.painPoints || []).map(p => p.point || p), display: (c.painPoints || []).map(p => p.point || p).join('、') || '—' }));
      return { field: 'painPoints', label: '用户抱怨点', kind: 'scalar', rows };
    }
    case 'tactics': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.tactics || []), display: (c.tactics || []).join('、') || '—', sources: srcOf(c, 'tactics') }));
      return { field: 'tactics', label: '销售打法', kind: 'scalar', rows };
    }
    case 'contentForms': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.contentForms || []), display: (c.contentForms || []).join('、') || '—' }));
      return { field: 'contentForms', label: '内容形态', kind: 'scalar', rows };
    }
    case 'collabTypes': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.collabTypes || []), display: (c.collabTypes || []).join('、') || '—' }));
      return { field: 'collabTypes', label: '联名方式', kind: 'scalar', rows };
    }
    case 'fulfillment': {
      const rows = comps.map(c => ({ ...base(c), tags: (c.fulfillment || []), display: (c.fulfillment || []).join('、') || '—' }));
      return { field: 'fulfillment', label: '履约方式', kind: 'scalar', rows };
    }
    case 'estSize': {
      const rows = comps.map(c => ({ ...base(c), display: c.estSize || '—', basis: c.estSizeBasis === 'inferred' ? 'inferred' : (c.estSize ? 'stated' : null) }));
      return { field: 'estSize', label: '估算规模', kind: 'scalar', rows };
    }
    case 'techStack': {
      const rows = comps.map(c => ({ ...base(c), display: c.techStack || '—' }));
      return { field: 'techStack', label: '技术栈', kind: 'scalar', rows };
    }
    default:
      return { error: 'unknown-field', field: fieldKey };
  }
}


module.exports = { getPriceField, getChannelField, getCategoryField, getLaunchCadence, getReviewField, posSummary, compareField };
