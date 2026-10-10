'use strict';
// ============================================================
// services/providers/trends.js —— Google Trends（T0 · 抓取需求 §2.6「白送」）
// 零依赖直连公开端点：explore 拿 token → interestovertime 拿 5 年周级时序（0-100 归一化相对值）。
// 纪律（§2.6/§5.6）：
//   · 同一词组 24h 内不重抓（Cache kind 'trends'）
//   · 官方相对值直接收；接口超限/失败 → {ok:false}，调用方标「未探测」，不用旧缓存冒充新数据
//   · 输出只作相对热度（C 级置信），禁止表述为绝对搜索量
// fetchImpl 可注入（单测）；单次 ≤5 词对比（Google 上限）。
// ============================================================
const Cache = require('../cache.js');

const EXPLORE_URL = 'https://trends.google.com/trends/api/explore';
const IOT_URL = 'https://trends.google.com/trends/api/interestovertime';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

function stripJsonPrefix(text) {
  // Google 内部端点返回以 )]}', 开头的防 XSSI 前缀
  const s = String(text || '');
  const idx = s.indexOf('{');
  if (idx < 0) throw new Error('TRENDS_BAD_PAYLOAD');
  return JSON.parse(s.slice(idx));
}

// terms: [赛道词, ...品牌词≤4]；opts.geo: ''(全球) | 'US' 等；opts.time 默认 'today 5-y'
async function interestOverTime(terms, config, opts) {
  const o = opts || {};
  const list = (Array.isArray(terms) ? terms : []).map(t => String(t || '').trim()).filter(Boolean).slice(0, 5);
  if (!list.length) return { ok: false, error: 'NO_TERMS' };
  const geo = String(o.geo || '');
  const time = o.time || 'today 5-y';
  const key = list.join('|') + '|' + geo + '|' + time;
  const hit = Cache.get('trends', key);
  if (hit) return hit;

  const f = o.fetchImpl || fetch;
  const reqPayload = {
    comparisonItem: list.map(k => ({ keyword: k, geo, time, property: '' })),
    category: 0, property: '',
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    // ① explore：拿 TIMESERIES widget 的 token
    const exploreUrl = EXPLORE_URL + '?hl=en-US&tz=0&req=' + encodeURIComponent(JSON.stringify(reqPayload));
    const r1 = await f(exploreUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!r1.ok) return { ok: false, error: 'TRENDS_EXPLORE_' + r1.status };
    const explore = await stripJsonPrefix(await r1.text());
    const widget = (explore.widgets || []).find(w => w.id === 'TIMESERIES');
    if (!widget || !widget.token) return { ok: false, error: 'TRENDS_NO_WIDGET' };
    // ② interestovertime：拿时序（每点 value[] 与 terms 一一对应）
    const iotUrl = IOT_URL + '?hl=en-US&tz=0&req=' + encodeURIComponent(JSON.stringify(widget.request)) + '&token=' + encodeURIComponent(widget.token);
    const r2 = await f(iotUrl, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!r2.ok) return { ok: false, error: 'TRENDS_IOT_' + r2.status };
    const iot = await stripJsonPrefix(await r2.text());
    const tl = (iot && iot.default && iot.default.timelineData) || [];
    if (!tl.length) return { ok: false, error: 'TRENDS_EMPTY' };
    const result = {
      ok: true,
      terms: list,
      geo,
      time,
      granularity: tl.length > 120 ? 'week' : 'unknown',
      points: tl.length,
      series: list.map((term, i) => ({ term, values: tl.map(d => (d.value && d.value[i] != null) ? d.value[i] : null) })),
      fetchedAt: new Date().toISOString(),
    };
    Cache.set('trends', key, result, 86400); // 同一词组 24h 不重抓（§2.6）
    return result;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally { clearTimeout(timer); }
}

module.exports = { interestOverTime };
