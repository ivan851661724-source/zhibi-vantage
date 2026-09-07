'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/search.js —— 导出: providerMain, providerConfigured, providerCall, searchProvider, multiSourceSearch, fanoutSearch, recordProbeHealth
// ============================================================

const Cache = require('../services/cache.js');
const Logger = require('../services/logger.js');
const ProviderHealth = require('../services/providers/health.js');
const SourceFusion = require('../lib/source-fusion.js');
const metering = require('../services/metering.js');
const { bochaSearch, braveSearch, getSerperPool, normalizeSerperKeys, serperSearchWithFailover, tavilySearch } = require('../services/providers/search.js');

// 搜索适配层：根据 config.search.provider 选择搜索源，统一返回 {results:[{title,url,content}]}
// T1-1：每次外部搜索都经 metering 闸门并计费。searchProvider 委托给各 provider（tavily/serper/brave/bocha），
// provider 内部不直接暴露统一 status，故在此层统一计费（一次搜索只计一次，含 serper 多 key failover）；
// 失败时从抛错 message 解析状态码（TAVILY_500/SERPER_403/...），按 shouldBill 决定是否计费
// （5xx 计、4xx/网络失败/无 key 不计），与 metering.js 计费裁决口径一致。
// kind: 'serp-discover'(24h) | 'serp-probe'(7d，默认) | 'off'(禁用缓存)
// 模块 0-3：命中缓存直接返回（不 recordCall —— 天然免配额）；缓存键含地域 gl 防美/英串数据
// 模块 2-2：跨 provider 健康度路由 —— 主 provider（config 指定）失败时按序尝试有 key 的备用源；
//           serper 内部多 key failover（serperSearchWithFailover）原样保留，本层在其外层叠加。
const PROVIDER_ORDER = ['serper', 'brave', 'bocha', 'tavily'];
const PROVIDER_ALIAS = { serper: 'serper', google: 'serper', brave: 'brave', bocha: 'bocha', tavily: 'tavily' };
function providerMain(config) {
  const p = String(((config && config.search && config.search.provider) || 'tavily')).toLowerCase();
  return PROVIDER_ALIAS[p] || 'tavily';
}
function providerConfigured(config, name) {
  const sc = (config && config.search) || {};
  if (name === 'serper') return normalizeSerperKeys(sc).length > 0;
  if (name === 'brave') return !!sc.braveKey;
  if (name === 'bocha') return !!sc.bochaKey;
  if (name === 'tavily') return !!(sc.tavilyKey || sc.apiKey);
  return false;
}
async function providerCall(name, query, config, gl) {
  if (name === 'serper') {
    const { keys, disabled } = getSerperPool(config);
    if (!keys.length) throw new Error('NO_SERPER_KEY');
    return serperSearchWithFailover(query, keys, gl, { disabled });
  }
  if (name === 'brave') {
    const k = config.search.braveKey;
    if (!k) throw new Error('NO_BRAVE_KEY');
    return braveSearch(query, k, gl);
  }
  if (name === 'bocha') {
    const k = config.search.bochaKey;
    if (!k) throw new Error('NO_BOCHA_KEY');
    return bochaSearch(query, k);
  }
  const k = config.search.tavilyKey || config.search.apiKey;
  if (!k) throw new Error('NO_TAVILY_KEY');
  return tavilySearch(query, k);
}
async function searchProvider(query, config, gl, kind) {
  const ckind = kind || 'serp-probe';
  const cacheKey = gl ? (query + ' [gl:' + gl + ']') : query;
  if (ckind !== 'off') {
    const hit = Cache.get(ckind, cacheKey);
    if (hit) return hit;
  }
  const tid = curTenantId();
  if (!metering.withinQuota(tid, 'searchCalls')) {
    return { results: [], error: 'quota', note: 'SEARCH_QUOTA' };
  }
  // 候选顺序：主 provider 在前，其余按健康度（不健康者垫底）；exhausted（额度类失败）源直接排除早退
  // 2026-09-06 B-01：全源 402/429 时不再每 query 把配置源全打一遍——recordFail 已按错误标记 exhausted
  const main = providerMain(config);
  const rest = PROVIDER_ORDER.filter(p => p !== main)
    .sort((a, b) => (ProviderHealth.isHealthy(b) ? 1 : 0) - (ProviderHealth.isHealthy(a) ? 1 : 0));
  const candidates = [main, ...rest].filter(p => providerConfigured(config, p) && !ProviderHealth.isExhausted(p));
  // 所有配置源都已 exhausted（额度耗尽）→ 直接抛清晰 SEARCH_QUOTA，不再发起任何外部调用
  if (!candidates.length) {
    metering.recordCall(tid, 'searchCalls', 0);
    throw new Error('SEARCH_QUOTA');
  }
  let lastErr = null;
  const _s0 = Date.now();
  for (const name of candidates) {
    try {
      const result = await providerCall(name, query, config, gl);
      ProviderHealth.recordOk(name);
      // 可观测性：记录搜索耗时（供 discover 耗时排查）
      try { Logger.info('search-call', { provider: name, kind: ckind, status: 'ok', durationMs: Date.now() - _s0, q: String(query).slice(0, 60) }); } catch (e) {}
      // 成功路径：写缓存（后续同 query 命中免配额）+ 本次搜索到达供应商即计费 1
      if (ckind !== 'off') Cache.set(ckind, cacheKey, result);
      metering.recordCall(tid, 'searchCalls', 1);
      return result;
    } catch (e) {
      lastErr = e;
      ProviderHealth.recordFail(name, e);
      try { Logger.info('search-call', { provider: name, kind: ckind, status: 'fail', durationMs: Date.now() - _s0, err: String(e.message || '').slice(0, 80), q: String(query).slice(0, 60) }); } catch (e2) {}
      // 无 key（配置缺失）与真实失败都继续尝试下一候选
    }
  }
  // 全失败：按原计费口径（5xx 计、网络失败/无 key 不计）并抛最后错误
  const msg = (lastErr && lastErr.message) || '';
  const m = /_(\d{3})$/.exec(msg);
  const status = m ? Number(m[1]) : null;
  const billed = status != null ? metering.shouldBill(status) : false;
  metering.recordCall(tid, 'searchCalls', billed ? 1 : 0);
  throw lastErr;
}

// ============ 双源融合搜索（多源三角验证 seam）============
// 主源仍走 searchProvider（含内部 failover + 计费 + 缓存），本函数在「主源已得结果」之上，
// 并行再跑一个「健康且已配置」的备用源，比对域名交集 → 给 corroboration。
// 成本纪律：仅当 config.search.fusion !== false 且存在 ≥2 个已配置健康源时才额外发一次备用源；
// 当前只配 Serper（单源）时直接返回主结果，零额外开销，不会拖慢 discover。
// 返回结构兼容 searchProvider（{results,error,note}），额外挂：
//   _fusion: { sources, agree, sharedDomains }   供可观测性/审计
//   _basis:  'verified'(≥2源一致) | 'claimed'(单源或源间无交集) | undefined(未启用融合)
async function multiSourceSearch(query, config, gl, kind) {
  const primary = await searchProvider(query, config, gl, kind);
  const fusionOn = (config && config.search && config.search.fusion) !== false;
  if (!fusionOn) return primary;

  const main = providerMain(config);
  const alt = PROVIDER_ORDER.filter(p => p !== main)
    .sort((a, b) => (ProviderHealth.isHealthy(b) ? 1 : 0) - (ProviderHealth.isHealthy(a) ? 1 : 0))
    .find(p => providerConfigured(config, p) && ProviderHealth.isHealthy(p));
  if (!alt) return primary; // 单源，无法融合

  let altResults = null;
  try {
    altResults = await providerCall(alt, query, config, gl);
    ProviderHealth.recordOk(alt);
  } catch (e) {
    ProviderHealth.recordFail(alt, e);
    return primary; // 备用源失败：不影响主结果，主源结论照常返回
  }

  const fz = SourceFusion.fuse([
    { name: main, ok: true, results: (primary && primary.results) || [] },
    { name: alt, ok: true, results: (altResults && altResults.results) || [] }
  ]);
  primary._fusion = { sources: fz.sources, agree: fz.agree, sharedDomains: fz.sharedDomains };
  primary._basis = fz.basis;
  return primary;
}

// ---- 定向探测健康度（失败可见性，§5-2）：不再静默吞掉探测失败 ----
// 跨进程生命周期累计近 7 天探测失败率，超过 30% 直接告警，便于区分
// "代码没修" 与 "搜索 API 配额/连通性出问题"。
const probeHealth = { runs: [] };
function recordProbeHealth(failed, total) {
  if (!total) return;
  const ts = Date.now();
  probeHealth.runs.push({ ts, failed, total });
  const cutoff = ts - 7 * 24 * 3600 * 1000;
  probeHealth.runs = probeHealth.runs.filter(r => r.ts >= cutoff);
  const tot = probeHealth.runs.reduce((a, r) => a + r.total, 0);
  const fail = probeHealth.runs.reduce((a, r) => a + r.failed, 0);
  const rate = tot ? fail / tot : 0;
  if (rate > 0.30) {
    console.warn(`[探针健康告警] 近7天定向探测失败率 ${(rate * 100).toFixed(1)}% (${fail}/${tot})，超过 30% 阈值 —— 请检查搜索 API 配额/连通性`);
  }
  return { failed, total, rate };
}
async function fanoutSearch(queries, config, gl) {
  // 模块 0-3：discover 扇出查询用 24h 缓存（同赛道跨租户/跨时段复用，命中免配额）
  // 技术债 §7.4 修复（2026-09-05）：全失败不再静默丢弃 ——
  //   · 配额类失败（402/429/exhausted/quota）→ 上浮清晰 SEARCH_QUOTA（前端 discover_error → 429 语义）
  //   · 其他全失败 → 上浮首个原始错误（不再让 runDiscover 猜 SEARCH_FAILED）
  //   · 部分失败 → 记 warn 日志可观测，保留成功结果（不阻塞发现）
  const results = await Promise.allSettled(queries.map(q => searchProvider(q, config, gl, 'serp-discover')));
  const ok = [];
  let quotaSignal = false;
  let failCount = 0;
  const failErrs = [];
  results.forEach(r => {
    if (r.status === 'fulfilled') {
      // T1-1：searchProvider 在额度耗尽时返回 {error:'quota'}（非抛出，避免其它调用点崩）；此处汇聚信号并抛出
      if (r.value && r.value.error === 'quota') { quotaSignal = true; return; }
      ok.push(r.value);
    } else {
      failCount++;
      const msg = String((r.reason && r.reason.message) || r.reason || '');
      failErrs.push(msg);
      if (/QUOTA|EXHAUSTED|_402|_429|_403/i.test(msg)) quotaSignal = true; // 配额/限流/key 失效类
    }
  });
  // 错误上浮（§7.4）：0 成功时必须让调用方看到清晰原因，绝不静默返回空
  if (!ok.length) {
    if (quotaSignal) throw new Error('SEARCH_QUOTA');     // 配额耗尽 → 前端 discover_error(SEARCH_QUOTA)
    if (failCount === queries.length && failErrs.length) throw new Error(failErrs[0]); // 全失败 → 上浮首个原始错误
    throw new Error('SEARCH_FAILED');
  }
  // 部分失败：可观测（不静默），保留成功结果继续发现
  if (failCount > 0) {
    try { Logger.warn('fanout 部分查询失败', { ok: ok.length, failCount, total: queries.length, errs: failErrs.slice(0, 3) }); } catch (e) {}
  }
  return ok;
}


module.exports = { providerMain, providerConfigured, providerCall, searchProvider, multiSourceSearch, fanoutSearch, recordProbeHealth };
