'use strict';
// ============================================================
// providers/search.js —— 搜索源统一封装（Phase 1 · L-外部依赖层）
// ------------------------------------------------------------
// 从 server.js 抽出的纯外部调用函数：统一返回 {results:[{title,url,content}]}。
// 设计纪律：
//   · 本模块只做「外部调用 + 归一化」，不含计费（metering 在 server.js 的
//     searchProvider 编排层统一处理，一次搜索只计一次）；
//   · 全部函数带超时/状态码语义（抛错含 status），失败不静默吞；
//   · Serper 多 key failover 保留（invalid/exhausted 永久跳过，进程内缓存）；
//   · 零依赖：仅用内置 fetch。
// 测试：test/serper-failover.test.js 为独立复制版（注释注明），本模块为唯一实现。
// ============================================================

// Serper：北美最便宜的真实 Google SERP 源；返回归一化为 {results:[{title,url,content}]}
async function serperSearch(query, key, gl) {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 10, gl: gl || 'us', hl: 'en' })
  });
  if (!r.ok) {
    let bodyText = '';
    try { bodyText = await r.text(); } catch { /* 忽略读取失败 */ }
    const err = new Error('SERPER_' + r.status);
    err.status = r.status;
    err.bodyText = bodyText;
    throw err;
  }
  const j = await r.json();
  const organic = Array.isArray(j.organic) ? j.organic : (Array.isArray(j.organic_results) ? j.organic_results : []);
  return { results: organic.map(o => ({ title: o.title || '', url: o.link || '', content: o.snippet || '' })) };
}

// 归一化 key 池：合并 serperKey(单) 与 serperKeys(数组)，去空去重、保留顺序
function normalizeSerperKeys(search) {
  const keys = [];
  const push = (k) => { k = (k || '').trim(); if (k && !keys.includes(k)) keys.push(k); };
  if (search) {
    if (Array.isArray(search.serperKeys)) search.serperKeys.forEach(push);
    push(search.serperKey);
  }
  return keys;
}

// 判定 Serper 报错类别：invalid=key 失效（永久跳过）；exhausted=额度/限流耗尽（跳过）；other=其他（直接抛出，不重试）
function classifySerperError(e) {
  const status = e && e.status;
  const t = String((e && e.bodyText) || (e && e.message) || '').toLowerCase();
  if (status === 402 || status === 429) return 'exhausted'; // 402 付费额度耗尽 / 429 限流
  if (status === 401 || status === 403) {
    if (/unauthor|invalid|forbidden|not a valid|wrong|denied/.test(t)) return 'invalid';
    if (/limit|quota|exhaust|plan|monthly|searche?s? left|credit|reached|overuse|exceeded/.test(t)) return 'exhausted';
    return 'invalid'; // 未知 401/403 → 视为 key 问题，跳过该 key
  }
  if (/rate limit|quota|exhaust|plan limit|monthly search|out of (searches|credits|credit)|no (searches|credits) left|payment required|exceeded your/.test(t)) return 'exhausted';
  return 'other';
}

// 多 key 容错核心：逐个尝试，invalid/exhausted 的 key 写入 disabled 永久跳过（本次进程内），命中第一个成功即返回；全失败抛 SERPER_ALL_KEYS_EXHAUSTED
// call 可注入（测试用），默认走真实 serperSearch
async function serperSearchWithFailover(query, keys, gl, opts) {
  const o = opts || {};
  const disabled = o.disabled || new Set();
  const call = o.call || (k => serperSearch(query, k, gl));
  if (!keys || !keys.length) throw new Error('NO_SERPER_KEY');
  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    if (disabled.has(i)) continue;
    try {
      return await call(keys[i]);
    } catch (e) {
      lastErr = e;
      const kind = classifySerperError(e);
      if (kind === 'invalid' || kind === 'exhausted') { disabled.add(i); continue; }
      throw e; // 网络/解析等其它错误：不屏蔽、不重试，直接抛出
    }
  }
  const err = new Error('SERPER_ALL_KEYS_EXHAUSTED');
  err.lastErr = lastErr;
  throw err;
}

// 进程内 key 池状态（key 内容变了就重置 disabled；key 不变则保留已判失效/耗尽的标记）
let _serperKeySig = null;
let _serperDisabled = new Set();
function getSerperPool(config) {
  const keys = normalizeSerperKeys(config && config.search);
  const sig = keys.join('|');
  if (sig !== _serperKeySig) { _serperKeySig = sig; _serperDisabled = new Set(); }
  return { keys, disabled: _serperDisabled };
}

// Tavily：深度搜索（advanced + include_answer）；归一化同 serper
async function tavilySearch(query, key) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, search_depth: 'advanced', max_results: 10, include_answer: true })
  });
  if (!r.ok) throw new Error('TAVILY_' + r.status);
  const j = await r.json();
  const items = Array.isArray(j.results) ? j.results : [];
  return { results: items.map(o => ({ title: o.title || '', url: o.url || '', content: o.content || '' })) };
}

// Brave Search：独立索引，免费档每月2000次；GET 接口
async function braveSearch(query, key, gl) {
  const u = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(query)
    + '&count=10&country=' + (gl === 'uk' ? 'gb' : (gl || 'us')) + '&search_lang=en';
  const r = await fetch(u, { headers: { 'Accept': 'application/json', 'X-Subscription-Token': key } });
  if (!r.ok) throw new Error('BRAVE_' + r.status);
  const j = await r.json();
  const items = (j.web && Array.isArray(j.web.results)) ? j.web.results : [];
  return { results: items.map(o => ({ title: o.title || '', url: o.url || '', content: o.description || '' })) };
}

// 博查 Bocha：国产，人民币计费（¥3.6/千次）；对标 Bing 索引
async function bochaSearch(query, key) {
  const r = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ query, count: 10, summary: true })
  });
  if (!r.ok) throw new Error('BOCHA_' + r.status);
  const j = await r.json();
  const items = (j.data && j.data.webPages && Array.isArray(j.data.webPages.value)) ? j.data.webPages.value : [];
  return { results: items.map(o => ({ title: o.name || '', url: o.url || '', content: o.summary || o.snippet || '' })) };
}

// 区域 -> Google 地理码（北美默认 us）
function glFromRegions(regions) {
  if (!regions || !regions.length) return 'us';
  const m = { us: 'us', uk: 'uk', eu: 'uk', jp: 'jp', cn: 'cn', sea: 'sg' };
  for (const rg of regions) if (m[rg]) return m[rg];
  return 'us';
}

// 当前生效搜索 key（供 NO_KEYS 快速判定）：serper 池优先，其次 tavily/brave/bocha
function activeSearchKey(config) {
  const sc = (config && config.search) || {};
  if ((sc.provider || 'tavily') === 'serper') {
    const k = normalizeSerperKeys(sc)[0];
    if (k) return k;
  }
  return sc.tavilyKey || sc.apiKey || sc.braveKey || sc.bochaKey || null;
}

module.exports = {
  serperSearch, normalizeSerperKeys, classifySerperError, serperSearchWithFailover, getSerperPool,
  tavilySearch, braveSearch, bochaSearch, glFromRegions, activeSearchKey,
};
