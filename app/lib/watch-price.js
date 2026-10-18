'use strict';
// ============================================================
// lib/watch-price.js —— 正式监控的单品价格比较语义（纯函数，可单测）
// ------------------------------------------------------------
// 规格依据（审核整改 §6 价格变化语义）：
//   · 正式价格事件必须比较稳定的商品/变体身份，禁止用整个商品目录的
//     价格中位数冒充"同商品价格变化"；
//   · 可直接比较（才允许产生涨跌事件）必须同时满足：
//       1) 同商品/变体身份（subjectId：products.json 的稳定商品 id）
//       2) 同市场和币种（市场由 WatchTarget 的 competitor×project 范围圈定；
//          币种不同 → 不可比较，绝不换算）
//       3) 同包装、规格及购买条件 —— products.json 不暴露订阅/包装字段，
//          以变体数（variantCount）作为规格签名代理：变体集变化（增删变体、
//          改规格档位）→ 视为不可直接比较，按"新价格发现"处理；
//   · 新增或删除其他商品不得生成原商品的涨跌事件（逐商品独立比较天然满足）；
//   · 目录中位数/价格带只能作为独立 Metric（由调用方记 metrics），本模块
//     不产出任何目录级事件。
// 事件词表（复用 price-history 语义，不新造同义词）：
//   event = null                    —— 同价不记（同价同身份不追加快照）
//         | { kind:'new-price' }    —— 首次见到 / 币种变化 / 规格签名变化（不可比）
//         | { kind:'changed' }      —— 同身份同规格同币种下的真实涨跌
// ============================================================

function deltaPctOf(oldPrice, newPrice) {
  const o = Number(oldPrice), n = Number(newPrice);
  if (!Number.isFinite(o) || !Number.isFinite(n) || o === 0) return null;
  return Math.round(((n - o) / Math.abs(o)) * 1000) / 10;
}

/**
 * prev: 上一条同身份快照 { subjectId, currency, specSignature, price, display?, at } | null
 * entry: 本轮快照 { subjectId, currency, specSignature, price, display?, at, title? }
 * 返回 { comparable, event }：
 *   comparable=false → 身份/币种/规格不一致，禁止比较（只记新价，不产涨跌）
 */
function applyProductSnapshot(prev, entry) {
  const e = entry || {};
  const price = Number(e.price);
  if (!e.subjectId || !Number.isFinite(price) || price <= 0) return { comparable: false, event: null };
  const cur = {
    subjectId: String(e.subjectId),
    currency: String(e.currency || 'USD').toUpperCase(),
    specSignature: String(e.specSignature == null ? '' : e.specSignature),
    price,
    display: e.display != null ? String(e.display) : String(price),
    at: e.at || new Date().toISOString(),
    title: e.title != null ? String(e.title) : null,
  };
  if (!prev) return { comparable: false, event: Object.assign({ kind: 'new-price', note: '首次观察到该商品价格' }, cur) };
  // 同身份 + 同币种 + 同规格签名才允许直接比较（§6 三条件）
  const sameIdentity = String(prev.subjectId) === cur.subjectId;
  const sameCurrency = String(prev.currency).toUpperCase() === cur.currency;
  const sameSpec = String(prev.specSignature == null ? '' : prev.specSignature) === cur.specSignature;
  if (!sameIdentity || !sameCurrency || !sameSpec) {
    const why = !sameIdentity ? '商品身份不一致' : !sameCurrency ? '币种变化，不跨币种比较' : '规格/变体构成变化，不可直接比较';
    return { comparable: false, event: Object.assign({ kind: 'new-price', note: why }, cur) };
  }
  if (Number(prev.price) === price) return { comparable: true, event: null }; // 同价不记
  return {
    comparable: true,
    event: {
      kind: 'changed',
      subjectId: cur.subjectId, title: cur.title, currency: cur.currency,
      price, display: cur.display, at: cur.at,
      old: Number(prev.price),
      oldDisplay: prev.display != null ? String(prev.display) : String(prev.price),
      new: price,
      deltaPct: deltaPctOf(prev.price, price),
    },
  };
}

// 规格签名（当前可得字段的代理）：变体数。变体增删/档位调整 → 签名变化 → 不可比。
// products.json 不含订阅/包装字段，接入后应并入此签名（扩展点，不改变比较语义）。
function specSignatureOf(item) {
  return item && item.variantCount != null ? 'v' + Number(item.variantCount) : '';
}

module.exports = { applyProductSnapshot, specSignatureOf, deltaPctOf };
