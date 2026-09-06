// lib/hero-product.js
// ============================================================
// 主推产品推理器（PRD v2.1 · S1-①）
// ------------------------------------------------------------
// 5 信号加权：广告素材主打 SKU（最高） > 首屏/置顶 > 评论量+增速 > 促销频率 > 上新节奏
// 输出：{ heroProducts[], corePriceBand, kind, reason, signalState }
//   两信号契约：
//     kind='verified'（准） —— 实抓可点开，前端零标注直接展示
//     kind='inferred'（推） —— 带「推理：」一行逻辑，并声明缺失信号；禁空，缺失时基于品类定位推测（均为演算）
//   信号不全：用剩余信号推；全部缺失也输出一条 推 结论，绝不返回空。
// ============================================================

const AD_PATTERNS = [/广告/i, /ad\s*creative/i, /facebook\s*ad/i, /instagram\s*ad/i, /投放/i, /promoted/i, /adsense/i];
const PROMO_PATTERNS = [/promo/i, /discount/i, /sale\b/i, /折扣/i, /促销/i, /优惠/i, /coupon/i, /bundl/i, /满减/i, /买[一二三]送/i];

function num(v) {
  if (typeof v === 'number') return isNaN(v) ? null : v;
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? null : n;
}

// 信号1：广告素材主打 SKU（当前采集管线未系统抓取广告素材；预留接入点）
function extractAdSkus(c) {
  const ads = c.ads || c.adCreatives || c.creatives || null;
  if (!ads) return [];
  try {
    if (Array.isArray(ads)) {
      return ads.map(x => (x && (x.sku || x.name || x.title)) || '').filter(Boolean).map(String).slice(0, 4);
    }
    if (Array.isArray(ads.items)) {
      return ads.items.map(x => (x && (x.sku || x.name)) || '').filter(Boolean).map(String).slice(0, 4);
    }
  } catch (_) { /* noop */ }
  return [];
}

// 信号2：首屏/置顶（官网 productMatrix.heroSku，最可靠的主推直接证据）
function extractHeroSkus(c) {
  const pm = c.productMatrix || {};
  if (Array.isArray(pm.heroSku) && pm.heroSku.length) {
    return pm.heroSku.map(s => String(s).trim()).filter(Boolean).slice(0, 4);
  }
  if (Array.isArray(c.products)) {
    const feat = c.products
      .filter(p => p && (p.featured || p.hero || p.star || p.isHero))
      .map(p => p.name || p.title)
      .filter(Boolean);
    if (feat.length) return feat.slice(0, 4);
  }
  return [];
}

// 信号3：评论量 + 增速
function reviewSignal(c) {
  const rf = c.reviewField || {};
  const rating = rf.rating || {};
  const trend = rf.trend || {};
  const count = num(rating.count != null ? rating.count : (rating.reviews != null ? rating.reviews : null));
  const growth = trend.value || trend.growth || null;
  const present = (count != null && count > 0) || (growth && growth !== 'unknown' && growth !== '稳定' && growth !== 'stable');
  return { present, count, growth, basis: rating.basis || 'unverified', confidence: rating.confidence || 'low' };
}

// 信号4：促销频率
function promoSignal(c) {
  const t = Array.isArray(c.tactics) ? c.tactics : [];
  const promo = t.filter(x => {
    const s = String(x && (x.tactic || x.name || ''));
    const ev = x && x.demandEvidence;
    return PROMO_PATTERNS.some(re => re.test(s)) || ev === 'present';
  });
  return { present: promo.length > 0, count: promo.length };
}

// 信号5：上新节奏
function launchSignal(c) {
  const lc = c.launchCadence || {};
  const moves = Array.isArray(c.recentMoves) ? c.recentMoves : [];
  const launchMoves = moves.filter(m => /launch|上新|新品|上架|new\s*product/i.test(String(m && (m.type || m.desc || ''))));
  let label = lc.value || null;
  if (!label && launchMoves.length) {
    label = launchMoves.length >= 4 ? '高频上新' : launchMoves.length >= 2 ? '稳定上新' : '低频上新';
  }
  return { present: !!label, label, count: launchMoves.length, basis: lc.basis || 'unverified', confidence: lc.confidence || 'low' };
}

// 名义主推（禁空回退）：无具体SKU信号时，用品类/定位命名一个推测主推
// P1-1 修复：positioning 可能是对象/数组（profile.positioning 结构），String() 会得到 [object Object]——
// 先归一为纯文本（title/summary/label/text 或数组元素），无文本才退回到 track。
function posBrief(c) {
  const p = c && c.positioning;
  if (!p) return '';
  if (typeof p === 'string') return p;
  if (Array.isArray(p)) return p.map(x => (typeof x === 'string' ? x : (x && (x.text || x.title || x.label)) || '')).filter(Boolean).join(' / ');
  return (p.title || p.summary || p.label || p.text) || '';
}
function nominalHero(c) {
  const cats = Array.isArray(c.categories) ? c.categories : [];
  if (cats.length) return `${cats[0]} 核心产品线`;
  const brief = posBrief(c);
  if (brief) return `定位「${String(brief).slice(0, 30)}」的核心产品`;
  if (c.track) return `${c.track} 核心产品`;
  return '核心产品线';
}

// 核心价格带
function coreBand(c) {
  const pf = c.priceField || {};
  const band = pf.band || null;
  let min = band && band.min != null ? num(band.min) : null;
  let max = band && band.max != null ? num(band.max) : null;
  let currency = (band && band.currency) || c.currency || pf.currency || null;
  if (min == null && max == null) {
    // 回退：priceBand.range
    const pr = c.priceBand && c.priceBand.range;
    if (pr) {
      const nums = String(pr).match(/[\d,.]+/g);
      if (nums && nums.length) {
        const vals = nums.map(n => num(n)).filter(v => v != null);
        if (vals.length) { min = Math.min(...vals); max = Math.max(...vals); }
        const curM = String(pr).match(/[A-Z]{3}|US\$|¥|€|£|\$/);
        if (curM) currency = curM[0];
      }
    }
  }
  const sources = Array.isArray(pf.sources) ? pf.sources : [];
  return {
    min, max, currency,
    basis: pf.basis || (min != null || max != null ? 'inferred' : 'unverified'),
    confidence: pf.confidence || (min != null || max != null ? 'medium' : 'low'),
    sources
  };
}

// 主推产品推理（单对手）
function heroProductInfer(competitor) {
  const c = competitor || {};
  const name = c.name || '该品牌';

  const ad = extractAdSkus(c);
  const hero = extractHeroSkus(c);
  const rv = reviewSignal(c);
  const pm = promoSignal(c);
  const lc = launchSignal(c);

  const signalState = {
    ad: ad.length ? 'present' : 'missing',
    hero: hero.length ? 'present' : 'missing',
    review: rv.present ? 'present' : 'missing',
    promo: pm.present ? 'present' : 'missing',
    launch: lc.present ? 'present' : 'missing'
  };

  // 候选主推：广告素材(最高权) > 首屏/置顶
  const candidates = [];
  ad.forEach(s => candidates.push({ name: s, signal: 'ad', basis: 'inferred' }));
  hero.forEach(s => candidates.push({ name: s, signal: 'hero', basis: 'verified' }));

  let heroProducts = [];
  let kind = 'inferred';
  if (candidates.length) {
    kind = 'verified';
    heroProducts = candidates.slice(0, 3).map(x => ({ name: x.name, signal: x.signal, basis: x.basis }));
  } else {
    // 禁空：无任何具体SKU信号 → 推：基于品类/定位推测
    heroProducts = [{ name: nominalHero(c), signal: 'inferred', basis: 'inferred' }];
  }

  const band = coreBand(c);
  const bandMissing = (band.min == null && band.max == null);

  const missing = Object.keys(signalState).filter(k => signalState[k] === 'missing');
  let reason;
  if (kind === 'verified') {
    const src = [];
    if (signalState.ad === 'present') src.push('广告素材主打SKU');
    else if (signalState.hero === 'present') src.push('官网首屏/置顶SKU');
    reason = `基于${src.join('、') || '首屏信号'}识别主推` +
      (missing.length ? `；辅助信号缺失：${missing.join('/')}（未参与加权）` : '；五大信号齐备');
  } else {
    reason = `未采集到具体主推SKU信号（缺失：${missing.join('/') || '无'}），以下基于品类定位推测，均为演算，仅供参照。`;
  }
  if (bandMissing) reason += ' 价格区间未采集，核心价位为演算。';

  return {
    competitorId: c.id || null,
    competitorName: name,
    heroProducts,
    corePriceBand: band,
    kind,                 // verified(准) | inferred(推)
    signalState,
    reason,               // 「推理：」行内容
    basis: kind === 'verified' ? 'verified' : 'inferred',
    confidence: kind === 'verified' ? 'high' : 'low'
  };
}

// 批量推理（decorateState 用）
function computeHeroProducts(competitors, opts) {
  const excluded = (opts && opts.excluded) || [];
  return (competitors || [])
    .filter(c => c && !excluded.includes(c.id))
    .map(c => heroProductInfer(c));
}

module.exports = { heroProductInfer, computeHeroProducts, extractAdSkus, extractHeroSkus, reviewSignal, promoSignal, launchSignal, coreBand };
