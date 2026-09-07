'use strict';
// ============================================================
// price-history.js —— 价格快照与变价 diff（PRD R1 跟价闭环 · 纯函数可单测）
//
// 边界（PRD R1 铁律）：
//   · 同价不记——同币种同价不追加快照、不产生事件；
//   · 缺价/首次见到 → 「新价格发现」事件，不算涨跌；
//   · 跨币种不换算——币种变化按「新价格发现」处理，绝不计算跨币种涨跌幅。
// 快照只追加（append-only）；调用方负责持久化与文件截断。
// ============================================================

// 涨跌幅（%）：new 相对 old 的百分比变化，保留 1 位小数（降价为负）
function stableHash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

function deltaPctOf(oldPrice, newPrice) {
  const o = Number(oldPrice), n = Number(newPrice);
  if (!Number.isFinite(o) || !Number.isFinite(n) || o === 0) return null;
  return Math.round(((n - o) / Math.abs(o)) * 1000) / 10;
}

function samePrice(a, b) {
  return Number(a) === Number(b); // 严格同值才算"同价"（浮点中位数稳定后才会相等）
}

/**
 * 追加一条快照并产出变价事件（纯函数）。
 * entry: { competitorId, price:number>0, display?:string, currency, url?, at, basis? }
 * 返回 { list, event }
 *   event = null                       —— 同价不记
 *         | { kind:'new-price', ... }   —— 首次见到该对手价格 / 币种变化（不算涨跌）
 *         | { kind:'changed', old, new, deltaPct, ... }
 */
function applySnapshot(prevList, entry) {
  const list = Array.isArray(prevList) ? prevList.slice() : [];
  const e = entry || {};
  const price = Number(e.price);
  const currency = String(e.currency || 'USD').toUpperCase();
  const base = {
    competitorId: String(e.competitorId || ''),
    gid: 'P-' + stableHash(String(e.competitorId || '') + '|' + currency), // R1.1：稳定内容标识（对手×币种），跨时间 join key
    price, display: e.display != null ? String(e.display) : String(price),
    currency, url: e.url || null,
    at: e.at || new Date().toISOString(),
    basis: e.basis || 'unverified',
  };
  if (!base.competitorId || !Number.isFinite(price) || price <= 0) {
    return { list, event: null }; // 缺价/非法价：不记快照、不记事件
  }
  // 找该对手最近一条快照
  let prev = null;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i] && list[i].competitorId === base.competitorId) { prev = list[i]; break; }
  }
  if (prev && prev.currency === base.currency && samePrice(prev.price, price)) {
    return { list, event: null }; // 同价不记
  }
  list.push(base);
  let event = null;
  if (!prev || prev.currency !== base.currency) {
    // 首次见到 / 跨币种：新价格发现，不算涨跌（跨币种不换算）
    event = Object.assign({ kind: 'new-price' }, base, {
      note: prev ? '币种变化，不与旧币种比较涨跌' : '新价格发现',
    });
  } else {
    const deltaPct = deltaPctOf(prev.price, price);
    event = Object.assign({ kind: 'changed' }, base, {
      old: prev.price,
      oldDisplay: prev.display != null ? prev.display : String(prev.price),
      new: price,
      deltaPct,
    });
  }
  return { list, event };
}

/**
 * 上一条"不同价"快照（供展示 old→new 对比）。与当前价同币种才比较；
 * 返回 { price, display, at } 或 null（无历史 / 跨币种 → 不编造涨跌）。
 */
function previousDistinct(list, competitorId, currentPrice, currency) {
  const cur = Number(currentPrice);
  const curCur = String(currency || 'USD').toUpperCase();
  for (let i = (list || []).length - 1; i >= 0; i--) {
    const s = list[i];
    if (!s || s.competitorId !== String(competitorId || '')) continue;
    if (s.currency !== curCur) return null; // 跨币种不换算
    if (samePrice(s.price, cur)) continue;  // 跳过同价，找上一条不同价
    return { price: s.price, display: s.display != null ? s.display : String(s.price), at: s.at };
  }
  return null;
}

/** 供 material-engine 的 priceHistory：{ competitorId: [{at, display}] }，每对手最近 limit 条 */
function historyMapForMaterials(list, limit) {
  const out = {};
  for (const s of list || []) {
    if (!s || !s.competitorId) continue;
    (out[s.competitorId] = out[s.competitorId] || []).push({ at: s.at, display: s.display });
  }
  for (const k of Object.keys(out)) {
    if (out[k].length > (limit || 3)) out[k] = out[k].slice(-(limit || 3));
  }
  return out;
}

/**
 * 变化事件的中文描述（站内信/邮件 digest 共用）。
 * symOf(currency) 返回货币符号（如 $ / ¥）；缺省用货币代码。
 * 产出例：降价 12%（$29.99→$26.39）／涨价 5%（$10.00→$10.50）／新价格发现：$26.39
 */
function describeChange(event, symOf) {
  if (!event) return '';
  const sym = (symOf || (c => c))(event.currency);
  const fmt = (n) => {
    const num = Number(n);
    return sym + (Number.isInteger(num) ? String(num) : String(num));
  };
  if (event.kind === 'new-price') return '新价格发现：' + fmt(event.price);
  const d = event.deltaPct;
  if (d == null) return '价格变动：' + fmt(event.old) + '→' + fmt(event.new);
  const dir = d < 0 ? '降价' : '涨价';
  const pct = Math.abs(d);
  const pctText = Number.isInteger(pct) ? String(pct) : String(pct);
  return dir + ' ' + pctText + '%（' + fmt(event.old) + '→' + fmt(event.new) + '）';
}

module.exports = { deltaPctOf, applySnapshot, previousDistinct, historyMapForMaterials, describeChange };
