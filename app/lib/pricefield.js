'use strict';
// ============================================================
// 价格字段「值级交叉验证裁决树」—— 忠实助理护城河本体（纯函数，可单测）
// 设计原则（见项目记忆 · 忠实助理红线）：
//   - 不换算币种；来源币种与主力市场不一致由前端标红，本模块只保管原值。
//   - 冲突不平均、不编造；多源不一致时【双值并陈 + 标红】，绝不合成假中间值。
//   - 裁决结论（basis/confidence）由「证据层级 + 值是否一致」共同决定，不由 LLM 拍脑袋。
//   - P0-1 主链路接入：tier-1 分支加「域名去重」（单独立源→medium，≥2→high），
//     tier-2 分支用独立身份计数(ia.count)替换旧 domains.size（保留 P0-4 的 medium 保守）；
//     价格区间用 rangesOverlap 作一致性 match（见 lib/field-confidence.js）。
// ============================================================
const FC = require('./field-confidence.js');
const SI = require('./source-identity.js');

const CUR_SYM = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CNY: '¥', HKD: 'HK$', AUD: 'A$', CAD: 'C$' };

function domainOf(url) {
  if (!url) return null;
  try { const u = new URL(url); return u.hostname.replace(/^www\./, ''); } catch { return null; }
}
function sym(cur) { return CUR_SYM[cur] || (cur ? cur + ' ' : ''); }
function fmtMoney(n, cur) {
  const s = sym(cur);
  const v = Math.round(Number(n) * 100) / 100;
  return s + v.toLocaleString('en-US');
}
function rangesOverlap(a, b) {
  if (!a || !b || a.length !== 2 || b.length !== 2) return false;
  return Math.max(a[0], b[0]) <= Math.min(a[1], b[1]);
}
function bounding(vals) {
  const mins = vals.map(v => v[0]); const maxs = vals.map(v => v[1]);
  return [Math.min(...mins), Math.max(...maxs)];
}
function normValue(v) {
  if (Array.isArray(v) && v.length === 2 && !isNaN(Number(v[0])) && !isNaN(Number(v[1]))) return [Number(v[0]), Number(v[1])];
  if (typeof v === 'number' && !isNaN(v)) return [v, v];
  return null;
}
// 从 "¥100-¥300" / "$20-$80" / "100 to 300" 这类文本抽 [min,max]
function parsePriceRange(str, currency) {
  if (!str || typeof str !== 'string') return null;
  const nums = (str.match(/[\d][\d.,]*/g) || []).map(s => parseFloat(s.replace(/,/g, ''))).filter(n => !isNaN(n) && n > 0);
  if (nums.length >= 2) return [Math.min(...nums), Math.max(...nums)];
  if (nums.length === 1) return [nums[0], nums[0]];
  return null;
}
function displayRange(v, cur) {
  if (!v) return '—';
  if (v[0] === v[1]) return fmtMoney(v[0], cur);
  return `${fmtMoney(v[0], cur)}-${fmtMoney(v[1], cur)}`;
}
function labelOf(c) {
  return ({ shopify: '实抓', official: '官网', 'llm-band': 'LLM·有源', 'llm-guess': 'LLM·推算', 'user-correct': '用户确认' })[c.kind] || c.kind;
}

/**
 * 构建标准化价格字段（值级裁决）。
 * @param {Array} claims 价格主张数组：{tier:1|2|3, kind, value:[min,max]|null, raw, url, text, points?}
 * @param {Object} opts {currency, corrections:[{type,value:[min,max]|null,text,currency}]}
 * @returns 标准化字段 {display,basis,confidence,currency,points,method,sources,conflictNote,realScraped}
 */
function buildPriceField(claims, opts) {
  opts = opts || {};
  const currency = opts.currency || 'USD';
  const corrections = opts.corrections || [];

  let all = (claims || []).map(c => ({ ...c, value: normValue(c.value) }));

  // 用户纠错（硬信号）：作为 tier-1 权威主张，覆盖一切
  const uc = corrections.find(c => (c.type === 'wrong-value' || c.type === 'confirm-correct') && c.value);
  if (uc) {
    all.unshift({ tier: 1, kind: 'user-correct', value: normValue(uc.value), raw: uc.text || '', url: null, text: uc.text || '用户纠正确认值', points: null });
  }

  const valued = all.filter(c => c.value && c.value.length === 2 && !isNaN(c.value[0]) && !isNaN(c.value[1]));
  const sources = all.map(c => ({ url: c.url || null, tier: c.tier, kind: c.kind, value: c.value || null, agrees: null, text: c.text || c.raw || '' }));

  if (!valued.length) {
    return { display: '—', basis: 'unverified', confidence: 'low', currency, points: null, method: 'none', sources, conflictNote: null, realScraped: all.some(c => c.kind === 'shopify') };
  }

  // ① 用户确认值主导（用户纠错是硬信号，但值必须可解析为合法区间；
  //    无法解析时不采信、不崩溃，回落到正常裁决，保持服务可用 + 忠实）
  let ucClaim = null;
  if (uc) {
    ucClaim = valued.find(c => c.kind === 'user-correct');
    if (!ucClaim) {
      const fixed = (typeof uc.value === 'number') ? [uc.value, uc.value]
                  : parsePriceRange(String(uc.value == null ? '' : uc.value), currency);
      if (fixed) {
        ucClaim = { tier: 1, kind: 'user-correct', value: fixed, text: uc.text || '用户纠正确认值', points: null };
        valued.push(ucClaim);
      }
    }
  }
  if (uc && ucClaim) {
    const others = valued.filter(c => c.kind !== 'user-correct');
    const agree = others.filter(o => rangesOverlap(o.value, ucClaim.value));
    sources.forEach(s => { s.agrees = s.value ? rangesOverlap(s.value, ucClaim.value) : null; });
    const note = agree.length < others.length ? `部分来源与用户确认值不一致（已按用户确认值显示）` : null;
    return {
      display: displayRange(ucClaim.value, currency), basis: 'verified', confidence: 'high', currency,
      points: ucClaim.value[0] === ucClaim.value[1] ? [ucClaim.value[0]] : [ucClaim.value[0], ucClaim.value[1]],
      method: 'user-correct', sources, conflictNote: note, realScraped: all.some(c => c.kind === 'shopify')
    };
  }

  const minTier = Math.min(...valued.map(c => c.tier));

  // ② tier-1 真实主张（Shopify 实抓 / 官网 / 官方）存在
  //    P0-1 收敛：按「独立来源身份」定级，杜绝同域镜像叠 high。
  //    单独立源(哪怕 tier-1 实抓)→medium；≥2 独立源一致→high（闭合裂缝 A）。
  if (minTier === 1) {
    const lead = valued.filter(c => c.tier === 1);
    const consensus = bounding(lead.map(c => c.value));
    const others = valued.filter(c => c.tier !== 1);
    const disagree = others.filter(o => !rangesOverlap(o.value, consensus));
    sources.forEach(s => { s.agrees = s.value ? rangesOverlap(s.value, consensus) : null; });
    const recs = valued.map(c => FC.claimToRecord(c, c.value, c.url));
    const res = FC.resolveFieldConfidence(recs, { topVal: consensus, match: rangesOverlap });
    return {
      display: displayRange(consensus, currency), basis: 'verified', confidence: res.confidence, currency,
      independentAgree: res.independentAgree, independentSources: res.independentSources,
      points: lead.find(c => c.kind === 'shopify' && c.points) ? lead.find(c => c.kind === 'shopify' && c.points).points : null,
      method: lead.some(c => c.kind === 'shopify') ? 'shopify-scrape' : 'official',
      sources, conflictNote: disagree.length ? `有 ${disagree.length} 个低层级来源与之不一致` : null,
      realScraped: lead.some(c => c.kind === 'shopify')
    };
  }

  // ③ tier-2（独立媒体/口碑/有源 LLM）主张
  //    P0-4 保守纪律：tier-2 即便多域独立，也只给 inferred/medium，不得冒充"查实"
  //    （媒体/LLM 极易同源：同训练语料 / 同被转载的错误报道，重合是同源症状而非独立验证）。
  //    去重改用独立身份计数 ia.count：同域多来源不再误算"多域独立"；consensus 取全部 tier-2 的 bounding。
  if (minTier === 2) {
    const lead = valued.filter(c => c.tier === 2);
    const leadOverlap = lead.every((c, i, a) => i === 0 || rangesOverlap(c.value, a[0].value));
    if (!leadOverlap) return conflictResult(valued, currency, sources); // tier-2 互不一致 → 冲突
    const consensus = bounding(lead.map(c => c.value));
    const others = valued.filter(c => c.tier !== 2);
    const disagree = others.filter(o => !rangesOverlap(o.value, consensus));
    sources.forEach(s => { s.agrees = s.value ? rangesOverlap(s.value, consensus) : null; });
    const iaRecs = lead.map(c => FC.claimToRecord(c, c.value, c.url));
    const ia = SI.independentAgreement(iaRecs, consensus, { match: rangesOverlap });
    const note = (disagree.length || ia.count >= 2)
      ? (disagree.length ? `有 ${disagree.length} 个来源不一致（多域重合，已保守降为推测）` : '多域重合，已保守降为推测（可能同源）')
      : '已保守降为推测（可能同源）';
    return {
      display: displayRange(consensus, currency), basis: 'inferred', confidence: 'medium', currency,
      independentAgree: ia.count, independentSources: ia.identities.filter(e => e.agrees),
      points: null, method: 'llm-band', sources, conflictNote: note, realScraped: false
    };
  }

  // ④ 仅 tier-3（LLM 推算，无源）主张 → inferred/low（绝非 medium）
  const t3 = valued.filter(c => c.tier === 3);
  if (t3.length) {
    const consensus = bounding(t3.map(c => c.value));
    const others = valued.filter(c => c.tier !== 3);
    const disagree = others.filter(o => !rangesOverlap(o.value, consensus));
    sources.forEach(s => { s.agrees = s.value ? rangesOverlap(s.value, consensus) : null; });
    return { display: displayRange(consensus, currency) + '（推断·未实抓）', basis: 'inferred', confidence: 'low', currency, points: null, method: 'llm-guess', sources, conflictNote: disagree.length ? `有 ${disagree.length} 个来源不一致` : null, realScraped: false };
  }

  // ⑤ 有主张但无法形成共识 → 冲突
  return conflictResult(valued, currency, sources);
}

function conflictResult(valued, currency, sources) {
  const disp = valued.map(c => `${labelOf(c)} ${displayRange(c.value, currency)}`).join(' ； ');
  sources.forEach(s => { s.agrees = null; });
  return { display: disp, basis: 'conflict', confidence: 'low', currency, points: null, method: 'conflict', sources, conflictNote: '各来源价格不一致，无法确认单一区间', realScraped: false };
}

module.exports = { buildPriceField, parsePriceRange, rangesOverlap, normValue, domainOf, displayRange, fmtMoney };
