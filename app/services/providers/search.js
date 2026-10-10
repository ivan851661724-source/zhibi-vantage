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

const Budget = require('./serper-budget.js'); // Serper key 总额度预算（总额度口径，不按月重置）

// Serper：北美最便宜的真实 Google SERP 源；返回归一化为 {results:[{title,url,content}]}
async function serperSearch(query, key, gl) {
  const r = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, num: 10, gl: gl || 'us', hl: 'en' }),
    signal: AbortSignal.timeout(15000) // 有界超时（此前依赖 undici 默认 ~300s，会拖住 sweep/failover）
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
  if (status === 400) {
    // 实证（2026-10-04 部署）：serper 欠费不走 402，而是 400 + body "Not enough credits"——
    // 归 other 会级联打满全部查询（部署阻塞项根因）。欠费/无效 key 必须按语义归类，快速熔断。
    if (/not enough credit|out of credit|credit balance|insufficient/i.test(t)) return 'exhausted';
    if (/invalid api key|api key (is )?invalid|not a valid key/i.test(t)) return 'invalid';
    return 'other';
  }
  if (status === 401 || status === 403) {
    if (/unauthor|invalid|forbidden|not a valid|wrong|denied/.test(t)) return 'invalid';
    if (/limit|quota|exhaust|plan|monthly|searche?s? left|credit|reached|overuse|exceeded/.test(t)) return 'exhausted';
    return 'invalid'; // 未知 401/403 → 视为 key 问题，跳过该 key
  }
  if (/rate limit|quota|exhaust|plan limit|monthly search|out of (searches|credits|credit)|no (searches|credits) left|payment required|exceeded your/.test(t)) return 'exhausted';
  return 'other';
}

// 多 key 容错核心：逐个尝试，invalid/exhausted 的 key 写入 disabled 永久跳过（本次进程内），命中第一个成功即返回；全失败抛 SERPER_ALL_KEYS_EXHAUSTED
// 总额度预算（serper-budget.js）：canSpend 不通过的 key 视同耗尽跳过；2xx 成功 / 5xx（到达即计费，metering 口径）各扣 1；
// 全部可用 key 都被预算挡住时抛 SERPER_BUDGET_EXHAUSTED（区别于 key 本身失效）。
// call 可注入（测试用），默认走真实 serperSearch
async function serperSearchWithFailover(query, keys, gl, opts) {
  const o = opts || {};
  const disabled = o.disabled || new Set();
  const call = o.call || (k => serperSearch(query, k, gl));
  const total = o.budgetTotal; // Infinity / undefined = 不设限
  if (!keys || !keys.length) throw new Error('NO_SERPER_KEY');
  let lastErr = null;
  let budgetBlocked = 0;
  let attempted = 0;
  for (let i = 0; i < keys.length; i++) {
    if (disabled.has(i)) continue;
    if (!Budget.canSpend(keys[i], total)) { disabled.add(i); budgetBlocked++; continue; }
    attempted++;
    try {
      const out = await call(keys[i]);
      await Budget.recordSpend(keys[i]); // 2xx：真实消耗
      return out;
    } catch (e) {
      lastErr = e;
      if (e && e.status >= 500) await Budget.recordSpend(keys[i]); // 5xx 到达即计费
      const kind = classifySerperError(e);
      if (kind === 'invalid' || kind === 'exhausted') { disabled.add(i); continue; }
      throw e; // 网络/解析等其它错误：不屏蔽、不重试，直接抛出
    }
  }
  if (attempted === 0 && budgetBlocked > 0) {
    const err = new Error('SERPER_BUDGET_EXHAUSTED'); // 一笔都没真实调用：全部被预算挡住
    err.budgetExhausted = true;
    throw err;
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
  return { keys, disabled: _serperDisabled, budgetTotal: Budget.budgetTotal(config && config.search) };
}

// Tavily：深度搜索（advanced + include_answer）；归一化同 serper
async function tavilySearch(query, key) {
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, search_depth: 'advanced', max_results: 10, include_answer: true }),
    signal: AbortSignal.timeout(15000)
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
  const r = await fetch(u, { headers: { 'Accept': 'application/json', 'X-Subscription-Token': key }, signal: AbortSignal.timeout(15000) });
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
    body: JSON.stringify({ query, count: 10, summary: true }),
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error('BOCHA_' + r.status);
  const j = await r.json();
  const items = (j.data && j.data.webPages && Array.isArray(j.data.webPages.value)) ? j.data.webPages.value : [];
  return { results: items.map(o => ({ title: o.name || '', url: o.url || '', content: o.summary || o.snippet || '' })) };
}

// Wigolo：自托管本地优先多引擎搜索（github.com/KnockOutEZ/wigolo）——$0/次、无外部 key，
// 作为付费搜索链（serper/brave/bocha/tavily）全断时的降级兜底源。
// REST 契约：POST {base}/v1/search {query, max_results, search_depth} → {results:[{title,url,snippet|excerpt}]}；
// 非回环绑定强制 Bearer token（WIGOLO_API_TOKEN）；服务端 search 响应 deadline 60s → 客户端 30s 有界超时。
async function wigoloSearch(query, baseUrl, token) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('NO_WIGOLO_URL');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const r = await fetch(base + '/v1/search', {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, max_results: 10, search_depth: 'fast' }),
    signal: AbortSignal.timeout(30000) // 有界超时：多引擎扇出比单 API 慢，仍不得拖住 sweep/failover
  });
  if (!r.ok) {
    let bodyText = '';
    try { bodyText = await r.text(); } catch { /* 忽略读取失败 */ }
    const err = new Error('WIGOLO_' + r.status);
    err.status = r.status;
    err.bodyText = bodyText;
    throw err;
  }
  const j = await r.json();
  const items = Array.isArray(j.results) ? j.results : [];
  return { results: items.map(o => ({ title: o.title || '', url: o.url || '', content: o.content || o.excerpt || o.snippet || '' })) };
}

// 区域 -> Google 地理码（北美默认 us）
function glFromRegions(regions) {
  if (!regions || !regions.length) return 'us';
  const m = { us: 'us', uk: 'uk', eu: 'uk', jp: 'jp', cn: 'cn', sea: 'sg' };
  for (const rg of regions) if (m[rg]) return m[rg];
  return 'us';
}

// 当前生效搜索 key（供 NO_KEYS 快速判定）：serper 池优先，其次 tavily/brave/bocha；
// wigolo 自托管无 key——配置了 wigoloUrl 即视为具备搜索能力（返回其 URL 供真值判断）
function activeSearchKey(config) {
  const sc = (config && config.search) || {};
  if ((sc.provider || 'tavily') === 'serper') {
    const k = normalizeSerperKeys(sc)[0];
    if (k) return k;
  }
  return sc.tavilyKey || sc.apiKey || sc.braveKey || sc.bochaKey
    || (String(sc.wigoloUrl || '').trim() || process.env.WIGOLO_URL || '') || null;
}

module.exports = {
  serperSearch, normalizeSerperKeys, classifySerperError, serperSearchWithFailover, getSerperPool,
  tavilySearch, braveSearch, bochaSearch, wigoloSearch, glFromRegions, activeSearchKey,
};
