'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/deepdive.js —— 导出: deepTimelineOne, L2_PLAN, L2_MODULE_FIELDS, sanitizeVocab, parseGradedList, applyL2Result, deepDiveField, normalizeCustomization
// ============================================================

const { saveState } = require('../core/state-store.js');
const { multiSourceSearch } = require('./search.js');
const { deepseekJSON, llmApiKey, resolveDeepModel } = require('./llm.js');
const { domainOf } = require('./net.js');
const { belongsToBrand, sourceTier } = require('./evidence.js');
const { AUDIENCES, CHANNELS, COLLAB_TYPES, CONTENT_FORMS, FULFILLMENT, SELLING_POINTS, TACTICS } = require('./vocab.js');
const { fieldHasDataOnServer, logAttempt } = require('./attempts.js');
const { glFromRegions } = require('../services/providers/search.js');

// 时间线深度检索：按时间梳理该品牌在做什么 + 战略/战术转变
async function deepTimelineOne(comp, state, config) {
  const dsKey = llmApiKey(config);
  const sys = `你是"知彼 Vantage"。请基于公开信息，按【时间线】梳理竞争对手"${comp.name}"（官网：${comp.url || '未知'}）在做什么，以及战略(strategy)与战术(tactic)层面的转变。
严格输出 JSON：
{
 "events": [ { "period": "2022下半年"或"2023", "title": "短句动作名", "level": "strategy"|"tactic", "desc": "做了什么/怎么做的", "evidence": "来源或推算依据" } ],
 "summary": "一句话总括该品牌演进主线",
 "shifts": "战略/战术上的关键转折与当下重心（2-3句）"
}
要求：
- 按时间由早到晚；period 用可识别的时间段。
- level 区分：strategy=方向性/定位性决策（如切入新品类、品牌升级）；tactic=具体执行动作（如某渠道投放、某联名）。
- 若某时期无公开信息，基于可得信号【推算】并标 evidence 为"推算"。
- 不要多余文字，直接输出 JSON。`;
  const user = `品牌：${comp.name}（${comp.url || ''}）。赛道：${state.track}。已知：定位=${comp.positioning || '未知'}；渠道=${Object.keys(comp.channels || {}).filter(k => comp.channels[k].present).join('/') || '未知'}；近期动作=${(comp.recentMoves || []).map(m => m.desc).join('；') || '未知'}。请按时间线梳理其战略与战术演进。`;
  const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, resolveDeepModel(), { fieldKey: 'timeline', competitorId: comp.id, timeoutMs: 120000, maxAttempts: 2 });
  const tl = {
    generatedAt: new Date().toISOString(),
    events: Array.isArray(j.events) ? j.events : [],
    summary: j.summary || '',
    shifts: j.shifts || ''
  };
  comp.timeline = tl;
  comp.researchedAt = new Date().toISOString();
  saveState(state);
  return tl;
}
// ============================================================
// L2 单模块 / 单字段深挖（点击"未探测·点此深挖"触发）
//   忠实助理纪律：① 不重跑全卡 ② 每条结果必须带可追溯来源 URL
//   ③ LLM 提取的标 basis=inferred（非 verified）④ 无 Key 时如实标 attempted_empty，绝不编造
// ============================================================
const L2_PLAN = {
  price:         { mode: 'llm', q: n => `"${n}" price OR pricing OR cost shop`, ask: '该品牌的价格带/价格区间（保持原币种，禁止换算）；可给价格点数组 pricePoints 与价格带 priceBand{band,range}。若无法确定返回空。' },
  sellingPoints: { mode: 'llm-vocab', vocab: 'SELLING_POINTS', q: n => `"${n}" brand selling points features benefits`, ask: '该品牌的主打卖点，只能从给定词表选。输出对象数组，每项 {point:卖点词(受控词优先，可补自由词), basis:"claimed|verified", cite:["E#"]}：claimed=营销文案/官网宣称；verified=产品实测/用户证言/第三方评测确认实际具备。' },
  positioning:   { mode: 'llm', q: n => `"${n}" brand positioning tagline about us`, ask: '用一句话(<=200字)概括该品牌的定位语调，输出 positioning 字段。' },
  customization: { mode: 'llm', q: n => `"${n}" customizable made-to-order personalized product options bespoke`, ask: '该品牌产品的可定制/按需定制程度，输出 customization 对象 {score:0-100, note:"依据一句话", cite:[]}。score 越高代表越按需定制/个性化，越低越标品化。' },
  products:      { mode: 'llm', q: n => `"${n}" product collection lineup items`, ask: '列举该品牌的产品矩阵（产品线/系列名称），输出 products 字符串数组。' },
  audiences:     { mode: 'llm-vocab', vocab: 'AUDIENCES', q: n => `"${n}" target customer audience who buys`, ask: '该品牌的目标人群，只能从给定词表选，输出 items 数组。' },
  channels:      { mode: 'rule-channels', q: n => `"${n}" official instagram OR tiktok OR youtube OR shopify OR etsy OR amazon` },
  reviews:       { mode: 'llm', q: n => `"${n}" reviews rating complaints feedback`, ask: '提取口碑：rating(数字或null)、trend(up/down/stable)、posThemes[]、negThemes[]，包进 reviews 对象。' },
  painPoints:    { mode: 'llm', q: n => `"${n}" complaints problems reddit disappointed`, ask: '提取用户抱怨点（具体痛点），输出 painPoints 字符串数组。' },
  tactics:       { mode: 'llm-vocab', vocab: 'TACTICS', q: n => `"${n}" promotion marketing tactic discount`, ask: '该品牌的销售打法，只能从给定词表选。输出对象数组，每项 {tactic:打法词, demandEvidence:"present|absent|unknown", cite:["E#"]}：demandEvidence=用户是否表达想要该策略/竞品因缺它流失；无证据填 unknown。' },
  contentForms:  { mode: 'llm-vocab', vocab: 'CONTENT_FORMS', q: n => `"${n}" content marketing form video livestream`, ask: '该品牌的内容形态，只能从给定词表选，输出 items 数组。' },
  collabTypes:   { mode: 'llm-vocab', vocab: 'COLLAB_TYPES', q: n => `"${n}" collaboration IP联名 artist brand`, ask: '该品牌的联名方式，只能从给定词表选，输出 items 数组。' },
  fulfillment:   { mode: 'llm-vocab', vocab: 'FULFILLMENT', q: n => `"${n}" shipping fulfillment made to order`, ask: '该品牌的履约方式，只能从给定词表选，输出 items 数组。' },
  recentMoves:   { mode: 'llm', q: n => `"${n}" news launch partnership 2024 OR 2025`, ask: '提取近期动作，输出 recentMoves 数组（每项 {type,desc,when}）。' },
  estSize:       { mode: 'llm', q: n => `"${n}" company size revenue employees founded`, ask: '估算该品牌规模（员工/营收量级/是否融资），输出 estSize 字符串。' },
  techStack:     { mode: 'rule-techstack', q: n => `"${n}" powered by shopify wordpress magento` },
};
const L2_MODULE_FIELDS = {
  pricing: ['price'],
  positioning: ['sellingPoints', 'positioning', 'customization'],
  products: ['products', 'audiences'],
  channels: ['channels'],
  reviews: ['reviews', 'painPoints'],
  marketing: ['tactics', 'contentForms', 'collabTypes', 'fulfillment', 'recentMoves', 'estSize', 'techStack'],
};
function sanitizeVocab(arr, vocab) {
  if (!Array.isArray(arr)) return [];
  const clean = Array.from(new Set(arr.map(x => String(x).trim()).filter(Boolean)));
  if (!vocab || !vocab.length) return clean.slice(0, 12); // 自由文本模式（品类/人群）：不约束词表
  return clean.filter(x => vocab.includes(x)).slice(0, 12);
}
// 解析"分级列表"：兼容 字符串[]（旧格式）与 {point|tactic, basis|demandEvidence, cite}[]（供需分级格式）。
// vocab=null 表示混合模式（放行自由词）；否则按受控词过滤。返回 {points, meta}。
// 这是"情报推理纪律 v2：供需不混淆"的解析落点——basis/demandEvidence 在此落地到 comp 副字段，供 inference-guard 使用。
function parseGradedList(raw, vocab) {
  const arr = Array.isArray(raw) ? raw : [];
  const points = [];
  const meta = {};
  arr.forEach(x => {
    if (typeof x === 'string') { points.push(x); return; }
    if (x && typeof x === 'object') {
      const k = x.point || x.tactic;
      if (!k) return;
      points.push(k);
      if (x.basis) meta[k] = x.basis;                              // claimed | verified
      if (x.demandEvidence) meta[k + '::demand'] = x.demandEvidence; // present | absent | unknown
    }
  });
  const filtered = vocab ? points.filter(p => vocab.includes(p)) : points.slice(0, 12);
  const cleanMeta = {};
  filtered.forEach(p => {
    if (meta[p]) cleanMeta[p] = meta[p];
    if (meta[p + '::demand']) cleanMeta[p + '::demand'] = meta[p + '::demand'];
  });
  return { points: filtered, meta: cleanMeta };
}
const L2_TECH_PATTERNS = [
  [/shopify/, 'Shopify'], [/wordpress/, 'WordPress'], [/magento/, 'Magento'],
  [/squarespace/, 'Squarespace'], [/bigcommerce/, 'BigCommerce'],
  [/(shoplazza|店匠)/, 'Shoplazza(店匠)'], [/(shopyy|2cshop|ueeshop|shoplazza)/, '独立站SaaS'],
  [/(woocommerce)/, 'WooCommerce'], [/(sapo|haravan)/, 'Sapo/Haravan']
];
function applyL2Result(comp, fieldKey, j, srcs) {
  comp.fieldSources = comp.fieldSources || {};
  const setSrc = () => { comp.fieldSources[fieldKey] = srcs; };
  switch (fieldKey) {
    case 'price': {
      // ▶ 报告-数据同源 §5：merge 路径同样前置过滤 $0，免费品不污染价格点
      const pts = Array.isArray(j.pricePoints) ? j.pricePoints.map(Number).filter(n => !isNaN(n) && n > 0) : [];
      if (pts.length) { comp.pricePoints = Array.from(new Set(pts.map(n => Math.round(n)))).sort((a, b) => a - b).slice(0, 40); comp.priceVerified = false; }
      if (j.priceBand && j.priceBand.band) comp.priceBand = { band: j.priceBand.band, range: j.priceBand.range || '', confidence: 'medium', basis: 'inferred' };
      setSrc(); break;
    }
    case 'sellingPoints': { const p = parseGradedList(j.items || j.sellingPoints || [], null); comp.sellingPoints = p.points; comp.sellingPointBasis = p.meta; setSrc(); break; } // 混合：分级列表兼容对象/字符串
    case 'positioning': {
      const p = j.positioning;
      if (p) {
        // 兼容旧字符串与结构化对象；纠正入口提交的是"品牌自称"，basis 归一为 claimed（PRD整改 #4：自述层）
        const o = (typeof p === 'object' && p) ? p : { valueProposition: String(p) };
        comp.positioning = {
          valueProposition: String(o.valueProposition || o.value || '').slice(0, 400),
          targetAudience: String(o.targetAudience || '').slice(0, 200),
          pricePosition: String(o.pricePosition || '').slice(0, 200),
          differentiation: String(o.differentiation || '').slice(0, 300)
        };
        comp.positioningBasis = 'claimed';
      }
      setSrc(); break;
    }
    case 'customization': {
      const norm = normalizeCustomization(j.customization || j);
      if (norm) comp.customization = { score: norm.score, note: norm.note, basis: 'inferred', confidence: 'medium' };
      setSrc(); break;
    }
    case 'products': comp.products = Array.isArray(j.products) ? j.products.map(String).filter(Boolean).slice(0, 20) : (comp.products || []); setSrc(); break;
    case 'audiences': comp.audiences = sanitizeVocab(j.items || j.audiences || [], AUDIENCES); setSrc(); break;
    case 'reviews': {
      const rv = j.reviews || j;
      comp.reviews = {
        rating: rv.rating != null ? Number(rv.rating) : null,
        trend: ['up', 'down', 'stable'].includes(rv.trend) ? rv.trend : null,
        posThemes: Array.isArray(rv.posThemes) ? rv.posThemes : [],
        negThemes: Array.isArray(rv.negThemes) ? rv.negThemes : [],
        basis: 'inferred'
      };
      setSrc(); break;
    }
    case 'painPoints': comp.painPoints = Array.isArray(j.painPoints) ? j.painPoints.slice(0, 10).map(p => ({ point: String(p).slice(0, 120), basis: 'inferred' })) : (comp.painPoints || []); setSrc(); break;
    case 'tactics': { const p = parseGradedList(j.items || j.tactics || [], TACTICS); comp.tactics = p.points; comp.tacticDemand = p.meta; setSrc(); break; }
    case 'contentForms': comp.contentForms = sanitizeVocab(j.items || j.contentForms || [], CONTENT_FORMS); setSrc(); break;
    case 'collabTypes': comp.collabTypes = sanitizeVocab(j.items || j.collabTypes || [], COLLAB_TYPES); setSrc(); break;
    case 'fulfillment': comp.fulfillment = sanitizeVocab(j.items || j.fulfillment || [], FULFILLMENT); setSrc(); break;
    case 'recentMoves': comp.recentMoves = Array.isArray(j.recentMoves) ? j.recentMoves.slice(0, 8).map(m => ({ type: String(m.type || '其他'), desc: String(m.desc || '').slice(0, 160), when: m.when || null, basis: 'inferred' })) : (comp.recentMoves || []); setSrc(); break;
    case 'estSize': if (j.estSize) { comp.estSize = String(j.estSize).slice(0, 160); comp.estSizeBasis = 'inferred'; } setSrc(); break;
  }
}
// 单字段 L2 深挖；返回 { ok, reason }
async function deepDiveField(state, comp, fieldKey, config) {
  const plan = L2_PLAN[fieldKey];
  if (!plan) { logAttempt(comp, fieldKey, '', 'l2', false, '无对应深挖计划'); return { ok: false, reason: 'unknown_field' }; }
  const gl = glFromRegions(state.intent && state.intent.regions);
  const sProv = (config.search && config.search.provider) || 'search';
  const query = plan.q(comp.name);
  let results = [];
  let l2Fusion = null;
  try { const raw = await multiSourceSearch(query, config, gl); results = raw.results || []; l2Fusion = raw._fusion || null; }
  catch (e) { logAttempt(comp, fieldKey, query, sProv, null, '检索失败：' + String(e.message || e)); return { ok: false, reason: 'search_failed' }; }
  // 多源三角验证结论随字段挂载（B-06 已生效：rule-channels 命中时按 agree 升 verified）
  comp._l2Fusion = l2Fusion;
  // 双源一致判定：agree 且存在共享域名 → 该查询的搜索结果有双源证据
  const fusedVerified = !!(l2Fusion && l2Fusion.agree && Array.isArray(l2Fusion.sharedDomains) && l2Fusion.sharedDomains.length);
  const srcs = results.slice(0, 5).filter(x => /^https?:/i.test(x.url || '')).map(x => ({ url: x.url, title: x.title, tier: sourceTier(x.url, domainOf(comp.url)), kind: 'l2-' + fieldKey, excerpt: String(x.content || '').slice(0, 200) }));
  const anchor = domainOf(comp.url);

  if (plan.mode === 'rule-channels') {
    const ptns = {
      tiktokShop: /tiktok\.com\/@[\w.\-]+/i, amazon: /amazon\.[a-z.]+\/(stores?|shops)\/[\w.\-]+/i,
      shopifyDTC: /(^|\.)myshopify\.com|\/store\/|shop\.[\w.-]+\.(com|co|shop)/i, xiaohongshu: /xiaohongshu\.com\/user\/profile/i,
      instagramShop: /instagram\.com\/[\w.\-]+/i, etsy: /etsy\.com\/shop\/[\w.\-]+/i,
      offlineRetail: /(store locator|实体店|线下门店|retail store|flagship store)/i, tmallJD: /(tmall\.com|jd\.com\/[\w.\-]+)/i
    };
    const found = {};
    const plat = (state.intent && state.intent.platforms);
    const scopedChannels = (plat && plat.length) ? plat : CHANNELS; // 只探用户勾选的平台，省 Serper 也避免越界噪声
    results.forEach(x => { for (const k of scopedChannels) { const p = ptns[k]; if (p && p.test(x.url || '') && belongsToBrand(x, comp.name, anchor)) found[k] = true; } });
    if (Object.keys(found).length) {
      comp.channels = comp.channels || {};
      // B-06（2026-09-06）：命中平台页 = 直接搜索证据；双源一致（agree+sharedDomains）→ basis 升 verified
      Object.keys(found).forEach(k => { comp.channels[k] = { present: true, confidence: fusedVerified ? 'high' : 'medium', basis: fusedVerified ? 'verified' : 'inferred', note: fusedVerified ? '双源一致命中平台页' : 'L2 定向检索命中平台页', since: null }; });
      comp.fieldSources = comp.fieldSources || {};
      comp.fieldSources['channels'] = srcs;
      logAttempt(comp, 'channels', query, sProv, true, '命中 ' + Object.keys(found).join('/'));
      saveState(state);
      return { ok: true };
    }
    logAttempt(comp, 'channels', query, sProv, false, '定向检索未命中官方平台页');
    saveState(state);
    return { ok: false, reason: 'no_hit' };
  }
  if (plan.mode === 'rule-techstack') {
    const lower = results.map(x => (x.url + ' ' + x.title + ' ' + x.content)).join(' ').toLowerCase();
    let tech = '';
    for (const [p, name] of L2_TECH_PATTERNS) if (p.test(lower)) tech += name + '; ';
    if (tech) {
      comp.techStack = tech.trim().replace(/;$/, '');
      comp.techStackBasis = 'inferred';
      comp.fieldSources = comp.fieldSources || {};
      comp.fieldSources['techStack'] = srcs;
      logAttempt(comp, 'techStack', query, sProv, true, tech);
      saveState(state);
      return { ok: true };
    }
    logAttempt(comp, 'techStack', query, sProv, false, '未识别到建站技术栈');
    saveState(state);
    return { ok: false, reason: 'no_hit' };
  }

  // LLM 提取（rule 之外的所有字段）
  const dsKey = llmApiKey(config);
  if (!dsKey) { logAttempt(comp, fieldKey, query, sProv, false, '需 LLM 解析，但未配置 Key'); saveState(state); return { ok: false, reason: 'no_llm_key' }; }
  let vocabText = '';
  if (plan.mode === 'llm-vocab') {
    const arr = plan.vocab === 'SELLING_POINTS' ? SELLING_POINTS : plan.vocab === 'TACTICS' ? TACTICS : plan.vocab === 'CONTENT_FORMS' ? CONTENT_FORMS : plan.vocab === 'COLLAB_TYPES' ? COLLAB_TYPES : plan.vocab === 'FULFILLMENT' ? FULFILLMENT : plan.vocab === 'AUDIENCES' ? AUDIENCES : [];
    vocabText = '\n只允许从以下词表选（输出 key 数组）：[' + arr.join(', ') + ']。不要自造词。';
  }
  const snippetText = results.slice(0, 6).map((x, i) => `【${i + 1}】${x.title || ''}\n${x.content || ''}`).join('\n---\n');
  const sys = `你是"知彼 Vantage"。只基于下面给出的检索片段，提取关于品牌"${comp.name}"的"${plan.ask}"。
严格输出 JSON。若片段不足以判断，返回空值（不要编造）。${vocabText}
禁止汇率换算，保持原币种。`;
  const user = `检索片段：\n${snippetText}\n\n赛道背景：${state.track}。请输出 JSON。`;
  let j;
  try { j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], dsKey, resolveDeepModel(), { fieldKey, competitorId: comp.id, timeoutMs: 120000, maxAttempts: 2 }); }
  catch (e) { logAttempt(comp, fieldKey, query, 'llm', false, 'LLM 解析失败：' + String(e.message || e)); saveState(state); return { ok: false, reason: 'llm_error' }; }
  applyL2Result(comp, fieldKey, j || {}, srcs);
  // 忠实助理：LLM 解析成功但无有效数据 → 记 hit=false（显示"已查未得"），不留空白间隙
  const got = fieldHasDataOnServer(comp, fieldKey);
  logAttempt(comp, fieldKey, query, 'llm', got, got ? 'L2 深挖命中' : 'L2 检索后无有效数据');
  saveState(state);
  return { ok: got, reason: got ? 'ok' : 'no_data' };
}

// ============================================================
// 步骤3b：定位校准引擎（#55）—— 以「用户填写的价格段 / 卖点」为原点，
// 反推"你选的方向里对手已占(红海) vs 对手没做(空白可占)"，并敢挑战用户假设。
// 这是忠实助理最锋利也最容易得罪人的部分：不顺着用户说，只给参照事实。
// 纯事实计算，不调 LLM（挑战信号由计数推导，避免编造）。
// ============================================================
// 定制化程度归一化：LLM 可能返回 {score,note,cite} 或纯数字；统一夹到 0-100，缺失返回 null。
// 该字段用于定位象限图 Y 轴（替代体量/梯队），必须可溯源（basis + 来源），缺失时前端回退体量。
function normalizeCustomization(jc) {
  if (jc == null) return null;
  let score, note = '';
  if (typeof jc === 'number') { score = jc; }
  else if (typeof jc === 'object') { score = jc.score; note = jc.note || ''; }
  else return null;
  const n = Number(score);
  if (isNaN(n)) return null;
  return { score: Math.max(0, Math.min(100, Math.round(n))), note: String(note).slice(0, 200) };
}


module.exports = { deepTimelineOne, L2_PLAN, L2_MODULE_FIELDS, sanitizeVocab, parseGradedList, applyL2Result, deepDiveField, normalizeCustomization };
