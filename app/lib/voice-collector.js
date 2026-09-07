'use strict';
// ============================================================
// 社媒/用户评论 统一采集接口（文档 v0.5 · 第一部分）
// ------------------------------------------------------------
// 设计目标（文档 1.1 裁决标准）：
//   新增一个平台 = 新建一个适配器类 + 注册，collectVoiceItems / 提取管线 / 推理·分析层零改动。
//
// 统一契约（文档 1.2）：
//   async fetchVoice({ brand, since, maxItems }) → VoiceItem[]
//   VoiceItem = { platform, url, text, author(脱敏), date(ISO), sentiment(pos|neg|neu), tier }
//
// 四个关键决策（文档 1.4）：
//   1. 增量抓取必选项：since + 游标续传，防止重复计数污染需求侧信号；
//   2. 社媒文本走同一套 cite 管线：VoiceItem 仅是一种 EvidencePack，进入提取层后无差别；
//   3. 需求侧按"提及广度"聚合：适配器内去重前置（同用户+同话题只计一次）；
//   4. author 脱敏在适配器层完成（只留首字符，原始用户名不落库）。
//
// 质量属性（文档 1.5，复用 anchors.js 范式）：
//   - 失败静默：无 key / 限流 / 平台封禁 → 返回 []，不阻塞整体采集；
//   - 鉴权与限速集中基类：适配器只写"怎么取数据"，key 管理/速率/重试由基类统一；
//   - tier 由适配器声明，进入裁决层自动参与独立来源判定。
//
// 零依赖：仅用 Node 全局 fetch；fetchImpl 注入便于单测（与 anchors.js 一致）。
// ============================================================

const SENTIMENTS = new Set(['pos', 'neg', 'neu']);

// ---------- 工具：author 脱敏（文档 1.4.4，只留首字符）----------
// 例："john" → "j***n"（首 + *** + 末）；长度 ≤2 → 首字符 + "***"。
function anonymizeAuthor(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return 'anon';
  if (s.length <= 2) return s[0] + '***';
  return s[0] + '***' + s[s.length - 1];
}

// ---------- 工具：日期归一为 ISO（容错多种来源格式）----------
function toISO(d) {
  if (!d) return null;
  if (typeof d === 'number') {
    // 秒级时间戳（Reddit created_utc）→ 毫秒
    const ms = d < 1e12 ? d * 1000 : d;
    const dt = new Date(ms);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  }
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? null : dt.toISOString();
}

// ---------- 工具：stars → sentiment（Trustpilot/Etsy 有原生评分）----------
function starsToSentiment(stars) {
  const n = Number(stars);
  if (!isFinite(n)) return 'neu';
  if (n >= 4) return 'pos';
  if (n <= 2) return 'neg';
  return 'neu';
}

// 校验并补全一个 VoiceItem（保证结构一致，供消费端无差别消费）
function coerceVoiceItem(raw) {
  if (!raw || !raw.platform) return null;
  const sentiment = SENTIMENTS.has(raw.sentiment) ? raw.sentiment : 'neu';
  const iso = toISO(raw.date);
  if (!iso) return null; // 无时间不可增量去重，丢弃（fail-safe）
  return {
    platform: String(raw.platform),
    url: String(raw.url || '').slice(0, 2048),
    text: String(raw.text || '').trim().slice(0, 2000),
    author: anonymizeAuthor(raw.author),
    date: iso,
    sentiment,
    tier: (raw.tier === 1 || raw.tier === 2) ? raw.tier : 2
  };
}

// ============================================================
// 基类：所有平台适配器继承。负责 key 门控、静默失败、限速、去重前置。
// 子类只需实现：
//   - this.keyOf(config)        → 返回该平台密钥（无则 undefined）
//   - this.fetchVoice(...)      → 具体取数（可重写以处理多步/无 key 源）
// ============================================================
class BaseVoiceAdapter {
  constructor({ platform, tier, rateLimitMs }) {
    this.platform = platform;
    this.tier = tier || 2;
    this.rateLimitMs = rateLimitMs || 0;
    this._lastCall = 0;
  }
  // 子类可重写：返回密钥；基类据此判定 configured
  keyOf() { return undefined; }
  isConfigured() { return !!this.keyOf(); }
  requiresKey() { return false; }

  // 集中限速：两次调用至少间隔 rateLimitMs（测试注入 rateLimitMs=0 则不sleep）
  async _rateLimit() {
    if (!this.rateLimitMs) return;
    const now = Date.now();
    const wait = this.rateLimitMs - (now - this._lastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this._lastCall = Date.now();
  }

  // 集中 HTTP：任何异常 → 返回 null（失败静默，绝不抛出阻塞整体）
  async _getJson(url, headers, fetchImpl) {
    const f = fetchImpl || fetch;
    try {
      const res = await f(url, { headers: headers || {} });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) { return null; }
  }

  // 适配器内去重前置（文档 1.4.3）：同用户 + 同话题只计一次
  _dedupe(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      if (!it || !it.text) continue;
      const key = it.author + '|' + it.text.toLowerCase().replace(/\s+/g, ' ').trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(it);
    }
    return out;
  }

  // 增量过滤：date >= since（ISO 或 epoch ms），游标续传由子类实现
  _afterSince(items, since) {
    if (!since) return items;
    const t = typeof since === 'number' ? (since < 1e12 ? since * 1000 : since) : new Date(since).getTime();
    if (isNaN(t)) return items;
    return items.filter(it => new Date(it.date).getTime() >= t);
  }

  // 默认取数：单页即止（无 key 源可直接用；多步源重写本方法）
  async fetchVoice({ brand, since, maxItems, fetchImpl }) {
    await this._rateLimit();
    if (this.requiresKey() && this.keyOf() === undefined) return [];
    const json = await this._getJson(this.endpoint(brand), this.headers(), fetchImpl);
    if (!json) return [];
    const parsed = this.parsePage(json, brand) || {};
    let items = (parsed.items || []).map(coerceVoiceItem).filter(Boolean);
    items = this._afterSince(items, since);
    items = this._dedupe(items);
    if (maxItems && items.length > maxItems) items = items.slice(0, maxItems);
    return items;
  }
  headers() { return {}; }
  endpoint() { return null; }
  parsePage() { return { items: [], next: null }; }
}

// ============================================================
// 适配器 1：Reddit（P1，无 key 公开 JSON 端点，tier 2）
// ============================================================
class RedditAdapter extends BaseVoiceAdapter {
  constructor() { super({ platform: 'reddit', tier: 2, rateLimitMs: 1000 }); }
  // 无 key：requiresKey=false → 即使无密钥也尝试（公开端点）
  endpoint(brand) {
    return 'https://www.reddit.com/search.json?q=' + encodeURIComponent(brand) +
      '&sort=new&limit=100&type=link,comment';
  }
  headers() {
    // Reddit 要求 UA，否则 429
    return { 'User-Agent': 'CompetitorIntelAssistant/1.0 (voice-collection; contact@testboard.example)' };
  }
  parsePage(json) {
    const children = (json && json.data && json.data.children) || [];
    const items = children.map(c => {
      const d = c && c.data || {};
      const text = d.selftext || d.title || '';
      return {
        platform: 'reddit',
        url: 'https://www.reddit.com' + (d.permalink || ''),
        text,
        author: d.author || 'anon',
        date: d.created_utc,
        sentiment: 'neu', // 无原生情感，交由提取管线（LLM）再判定
        tier: 2
      };
    });
    return { items, next: null };
  }
}

// ============================================================
// 适配器 2：Trustpilot（P0，官方 API，tier 1）
// 两步：find-by-domain 拿 businessUnitId → 拉 reviews
// ============================================================
class TrustpilotAdapter extends BaseVoiceAdapter {
  constructor() { super({ platform: 'trustpilot', tier: 1, rateLimitMs: 500 }); }
  keyOf(config) { return config && config.voice && config.voice.trustpilotKey; }
  requiresKey() { return true; }
  headers(key) { return { 'apikey': key, 'Accept': 'application/json' }; }

  async fetchVoice({ brand, since, maxItems, fetchImpl, config }) {
    await this._rateLimit();
    const key = this.keyOf(config);
    if (!key) return []; // 未配置 → 静默空
    const f = fetchImpl || fetch;
    // 1) 找 business unit
    const buUrl = 'https://api.trustpilot.com/v1/business-units/find-by-domain/' +
      encodeURIComponent((brand || '').toLowerCase().replace(/\s+/g, '')) + '?apikey=' + key;
    const buJson = await this._getJson(buUrl, this.headers(key), f);
    const buId = buJson && buJson.id;
    if (!buId) return [];
    // 2) 拉 reviews
    const revUrl = 'https://api.trustpilot.com/v1/business-units/' + encodeURIComponent(buId) +
      '/reviews?apikey=' + key + '&perPage=100&page=1';
    const revJson = await this._getJson(revUrl, this.headers(key), f);
    const reviews = (revJson && revJson.reviews) || [];
    let items = reviews.map(r => ({
      platform: 'trustpilot',
      url: (r && r.reviewUrl) || '',
      text: (r && r.text) || '',
      author: (r && r.author && r.author.displayName) || 'anon',
      date: (r && r.createdAt) || null,
      sentiment: starsToSentiment((r && r.stars) || 0),
      tier: 1
    })).map(coerceVoiceItem).filter(Boolean);
    items = this._afterSince(items, since);
    items = this._dedupe(items);
    if (maxItems && items.length > maxItems) items = items.slice(0, maxItems);
    return items;
  }
}

// ============================================================
// 适配器 3：Etsy（P0，Reviews 端点，OAuth token，tier 1）
// 需要 shopId（品牌在 Etsy 的店铺 id）；无 shopId → 静默空（fail-open）。
// 真实 shopId 解析可借既有 Serper/discover 找到 Etsy 店铺 URL 后抽取，本适配器只消费 shopId。
// ============================================================
class EtsyAdapter extends BaseVoiceAdapter {
  constructor() { super({ platform: 'etsy', tier: 1, rateLimitMs: 500 }); }
  keyOf(config) { return config && config.voice && config.voice.etsyToken; }
  requiresKey() { return true; }
  headers(token) { return { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' }; }
  shopIdOf(brand, opts) {
    return (opts && opts.shopId) || (brand && brand.etsyShopId) || null;
  }
  async fetchVoice({ brand, since, maxItems, fetchImpl, config, opts }) {
    await this._rateLimit();
    const token = this.keyOf(config);
    if (!token) return [];
    const shopId = this.shopIdOf(brand, opts);
    if (!shopId) return []; // 无 shopId → 静默空
    const url = 'https://openapi.etsy.com/v3/application/shops/' + encodeURIComponent(shopId) +
      '/reviews?limit=100';
    const json = await this._getJson(url, this.headers(token), fetchImpl);
    const reviews = (json && json.results) || [];
    let items = reviews.map(r => ({
      platform: 'etsy',
      url: (r && r.shop_name) ? ('https://www.etsy.com/shop/' + r.shop_name) : '',
      text: (r && r.review) || (r && r.message) || '',
      author: (r && r.username) || 'anon',
      date: (r && r.create_timestamp) ? Number(r.create_timestamp) : null,
      sentiment: starsToSentiment((r && r.rating) || 0),
      tier: 1
    })).map(coerceVoiceItem).filter(Boolean);
    items = this._afterSince(items, since);
    items = this._dedupe(items);
    if (maxItems && items.length > maxItems) items = items.slice(0, maxItems);
    return items;
  }
}

// ============================================================
// 适配器 4：YouTube（P1，Data API v3 评论，key，tier 1）
// 两步：search 找频道 → commentThreads 拉评论。
// ============================================================
class YouTubeAdapter extends BaseVoiceAdapter {
  constructor() { super({ platform: 'youtube', tier: 1, rateLimitMs: 500 }); }
  keyOf(config) { return config && config.voice && config.voice.youtubeKey; }
  requiresKey() { return true; }
  headers() { return { 'Accept': 'application/json' }; }
  async fetchVoice({ brand, since, maxItems, fetchImpl, config }) {
    await this._rateLimit();
    const key = this.keyOf(config);
    if (!key) return [];
    const f = fetchImpl || fetch;
    // 1) 找频道
    const sUrl = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=' +
      encodeURIComponent(brand) + '&key=' + key;
    const sJson = await this._getJson(sUrl, this.headers(), f);
    const chanId = sJson && sJson.items && sJson.items[0] && sJson.items[0].id &&
      sJson.items[0].id.channelId;
    if (!chanId) return [];
    // 2) 拉评论
    const cUrl = 'https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&maxResults=100&order=time&channelId=' +
      encodeURIComponent(chanId) + '&key=' + key;
    const cJson = await this._getJson(cUrl, this.headers(), f);
    const threads = (cJson && cJson.items) || [];
    let items = threads.map(t => {
      const sn = t && t.snippet && t.snippet.topLevelComment && t.snippet.topLevelComment.snippet || {};
      return {
        platform: 'youtube',
        url: 'https://www.youtube.com/watch?v=' + (t && t.snippet && t.snippet.videoId || ''),
        text: sn.textDisplay || sn.textOriginal || '',
        author: sn.authorDisplayName || 'anon',
        date: sn.publishedAt || null,
        sentiment: 'neu', // 无原生情感，交由提取管线再判定
        tier: 1
      };
    }).map(coerceVoiceItem).filter(Boolean);
    items = this._afterSince(items, since);
    items = this._dedupe(items);
    if (maxItems && items.length > maxItems) items = items.slice(0, maxItems);
    return items;
  }
}

// ============================================================
// 独立站评论页适配器（R2.2）：抓品牌官网的公开评论页（常见 Shopify 评论应用路径），
// 抽取文本片段作为声音条目（带来源 URL，tier2）。评论组件各异，只做保守文本抽取；
// 情感交给归一化层的词典派生。SSRF 防护走 research/net 的 assertPublicUrl（惰性 require 防循环）。
// ============================================================
class SiteReviewsAdapter extends BaseVoiceAdapter {
  constructor() { super({ platform: 'site', tier: 2, rateLimitMs: 500 }); }
  headers() { return { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36' }; }
  async fetchVoice(opts) {
    const f = opts.fetchImpl || fetch;
    const siteUrl = (opts.opts && opts.opts.siteUrl) || '';
    if (!siteUrl) return [];
    let assertPublicUrl = null;
    try { assertPublicUrl = require('../research/net.js').assertPublicUrl; } catch (e) { assertPublicUrl = null; }
    const paths = ['/reviews', '/pages/reviews', '/a/reviews'];
    const maxItems = opts.maxItems || 30;
    const out = [];
    for (const p of paths) {
      if (out.length >= maxItems) break;
      let target;
      try { target = new URL(p, String(siteUrl)).href; } catch (e) { return out; }
      try {
        if (assertPublicUrl) { try { await assertPublicUrl(target); } catch (e) { continue; } } // 私网/元数据地址直接跳过
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10000);
        let r, html;
        try {
          r = await f(target, { headers: this.headers(), signal: ctrl.signal });
          if (!r.ok) continue;
          html = await r.text();
        } finally { clearTimeout(timer); }
        // 保守抽取：剥脚本/标签 → 按句切 → 取 40-240 字符的候选片段（评论页正文多为短句）
        const text = String(html || '')
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;|&amp;|&quot;|&#\d+;|&[a-z]+;/gi, ' ')
          .replace(/\s+/g, ' ');
        const parts = text.split(/(?<=[.!?。！？])\s+/);
        for (const seg of parts) {
          const t = seg.trim();
          if (t.length < 40 || t.length > 240) continue;
          if (!/[a-zA-Z一-鿿]/.test(t)) continue;
          out.push(coerceVoiceItem({
            platform: 'site', url: target, text: t, author: 'site-anon',
            date: null, sentiment: 'neu', tier: 2
          }));
          if (out.length >= maxItems) break;
        }
      } catch (e) { /* 单路径失败静默，试下一个 */ }
    }
    return this._dedupe(this._afterSince(out, opts.since));
  }
}

// ============================================================
// 注册表：新增平台 = 实例化一个适配器并 register 即可（消费端零改动）
// 默认只启用「评论源」（文档 1.3 裁决：默认不注册帖子源 XHS/TikTok）
// ============================================================
const REGISTRY = {};
function registerVoiceAdapter(adapter) {
  if (adapter && adapter.platform) REGISTRY[adapter.platform] = adapter;
}
function getVoiceAdapter(name) { return REGISTRY[name] || null; }
function listVoiceAdapters() { return Object.keys(REGISTRY); }

// 默认注册（评论源：Trustpilot/Etsy/Reddit/YouTube）
registerVoiceAdapter(new TrustpilotAdapter());
registerVoiceAdapter(new EtsyAdapter());
registerVoiceAdapter(new RedditAdapter());
registerVoiceAdapter(new YouTubeAdapter());
registerVoiceAdapter(new SiteReviewsAdapter());

// 默认启用列表（仅评论源；帖子源不注册，需要时走第三方数据服务）
const DEFAULT_ENABLED = ['trustpilot', 'etsy', 'reddit', 'youtube', 'site'];

// ============================================================
// 编排：跨平台收集某品牌的用户声音。
// opts: { platforms?, since?, maxItems?, config, fetchImpl, adapterOpts? }
// 返回 VoiceItem[]（已按平台去重 url，防跨平台同帖重复）。
// 增量协议：since 透传给每个适配器；游标续传由各适配器内部处理。
// ============================================================
async function collectBrandVoice(brand, opts) {
  opts = opts || {};
  const config = opts.config || {};
  const platforms = opts.platforms || DEFAULT_ENABLED;
  const maxItems = opts.maxItems || 100;
  const f = opts.fetchImpl || fetch;
  const out = [];
  const urlSeen = new Set();
  for (const name of platforms) {
    const ad = getVoiceAdapter(name);
    if (!ad) continue;
    let items;
    try {
      items = ad.fetchVoice
        ? await ad.fetchVoice({ brand, since: opts.since, maxItems, fetchImpl: f, config, opts: opts.adapterOpts })
        : [];
    } catch (e) { items = []; } // 单平台异常不影响其他平台（失败静默）
    for (const it of (items || [])) {
      if (it.url && urlSeen.has(it.url)) continue; // 跨平台 url 去重
      if (it.url) urlSeen.add(it.url);
      out.push(it);
    }
  }
  return out;
}

// ============================================================
// 归一化：VoiceItem → 机会管线消费形状（文档 1.4.2：社媒走同一套管线）
// 映射极性：pos→pos, neg→neg, neu 不参与机会打分（机会只看 pos/neg 提及比）。
// basis：tier1 官方API → verified；tier2 公开端点 → inferred。
// ============================================================
// 情感词典（透明派生，R2.3 前置）：平台无原生情感时按词表判定，结果仅作提及极性候选。
// 规则极简且确定性：正/负词命中数多者胜，平手保持 neu（不参与机会打分）。绝不臆造强度。
const POS_LEXICON = ['love', 'loved', 'perfect', 'great', 'amazing', 'awesome', 'excellent', 'best', 'recommend', 'comfortable', 'durable', 'beautiful', 'worth it', 'five stars', 'wonderful', 'good quality', '好用', '喜欢', '推荐', '满意', '超值', '舒服', '质量好'];
const NEG_LEXICON = ['broke', 'broken', 'terrible', 'awful', 'worst', 'disappointed', 'disappointing', 'waste', 'returned', 'returning', 'cheap', 'flimsy', 'stopped working', 'never again', 'poor quality', 'uncomfortable', 'refund', 'scam', '难用', '失望', '退货', '质量差', '后悔', '坑人', '破损'];
function lexiconSentiment(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  let pos = 0, neg = 0;
  POS_LEXICON.forEach(w => { if (t.includes(w)) pos++; });
  NEG_LEXICON.forEach(w => { if (t.includes(w)) neg++; });
  if (pos > neg) return 'pos';
  if (neg > pos) return 'neg';
  return null;
}

function voiceItemsToNormalized(items, brand) {
  const bName = (brand && brand.name) || (typeof brand === 'string' ? brand : 'unknown');
  const bId = (brand && brand.id) || null;
  const out = [];
  for (const it of (items || [])) {
    let polarity = null;
    if (it.sentiment === 'pos') polarity = 'pos';
    else if (it.sentiment === 'neg') polarity = 'neg';
    if (!polarity) polarity = lexiconSentiment(it.text); // 透明词典派生（仅 pos/neg 参与机会打分）
    if (!polarity) continue; // 仍中性：不参与机会打分
    out.push({
      text: it.text,
      brand: bName,
      brandId: bId,
      polarity,
      field: 'voice.' + it.platform,
      basis: it.tier === 1 ? 'verified' : 'inferred',
      url: it.url || null // R2.3：每条主题可溯源——保留原始 URL 进机会管线
    });
  }
  return out;
}

module.exports = {
  SENTIMENTS, anonymizeAuthor, toISO, starsToSentiment, coerceVoiceItem, lexiconSentiment,
  BaseVoiceAdapter,
  RedditAdapter, TrustpilotAdapter, EtsyAdapter, YouTubeAdapter, SiteReviewsAdapter,
  registerVoiceAdapter, getVoiceAdapter, listVoiceAdapters,
  DEFAULT_ENABLED, collectBrandVoice, voiceItemsToNormalized
};
