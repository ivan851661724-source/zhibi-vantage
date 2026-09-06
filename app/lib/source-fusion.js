'use strict';
// =============================================================================
// source-fusion.js — 双源融合（多源三角验证）算子 · 算子③-扩展
// -----------------------------------------------------------------------------
// 职责：同一 query 在多个搜索源上的结果，比对后给出「是否跨源一致」的裁定。
// 这是把「单源采信」升级为「多源可信」的核心：≥2 个独立源返回了相同域名/实体，
// 才把该信号的 basis 从 'claimed' 提升为 'verified'；源间无交集或只有单源，
// 则诚实退化为 'claimed'（绝不编造 verified）。
//
// 设计纪律（与聚合器红线一致 · 不撒谎）：
//   · 纯函数 + 可注入 provider 调用，便于离线单测（不依赖真实网络/key）。
//   · 单源永远不能标 verified —— 没有对照就没有验证。
//   · 比对维度用「域名交集」而非全文相似：跨索引源对同一实体返回不同标题/摘要，
//     但官网域名必然一致，域级交集是跨源存在性最强的证据。
//   · 价格类信号如需更强验证，由调用方在拿到 fusedResults 后再做数值交叉（本模块只判存在性）。
// =============================================================================

// 从 URL 提取去 www. 的主域名（无效返回 ''）
function domainOf(url) {
  if (!url) return '';
  try {
    const u = new URL(String(url));
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

// 一组 results 的去重域名集合
function domainsOf(results) {
  const s = new Set();
  for (const r of (results || [])) {
    const d = domainOf(r && r.url);
    if (d) s.add(d);
  }
  return s;
}

// 两个域名集合的交集
function overlap(a, b) {
  const out = [];
  for (const d of a) if (b.has(d)) out.push(d);
  return out;
}

// 融合裁定：给定多源结果 [{ name, ok, results }]，返回融合结论。
// 规则：
//   ok 源数 ≥ 2 且它们之间存在非空域名交集 → agree=true → basis='verified'
//   仅 1 个 ok 源，或源间无交集 → agree=false → basis='claimed'（无对照不升级）
//   0 个 ok 源 → basis='unverified'
function fuse(providers) {
  const ok = (providers || []).filter(p => p && p.ok && Array.isArray(p.results) && p.results.length > 0);
  const sources = ok.map(p => p.name);

  let sharedDomains = [];
  if (ok.length >= 2) {
    let inter = domainsOf(ok[0].results);
    for (let i = 1; i < ok.length; i++) {
      inter = new Set(overlap([...inter], domainsOf(ok[i].results)));
    }
    sharedDomains = [...inter];
  }

  const agree = ok.length >= 2 && sharedDomains.length > 0;

  // 融合结果：优先取落在共享域名上的条目，更能代表「多源共同指向」的实体。
  let fusedResults = ok.length ? ok[0].results : [];
  if (sharedDomains.length) {
    const wanted = new Set(sharedDomains);
    const all = [];
    for (const p of ok) for (const r of p.results) if (wanted.has(domainOf(r.url))) all.push(r);
    if (all.length) fusedResults = all;
  }

  return {
    sources,
    agree,
    sharedDomains,
    fusedResults,
    basis: agree ? 'verified' : (ok.length ? 'claimed' : 'unverified')
  };
}

// 离线可测的协程封装：并行跑所有源，单源失败不影响其他，最后 fuse。
// providerFetchers: [{ name, fetch: async (query) => ({ results:[...] }) }]
// 返回 fuse 结论 + { ranProviders, failedProviders } 供可观测性。
async function corroborate(query, providerFetchers, opts) {
  const fets = (providerFetchers || []).map(async pf => {
    try {
      const res = await pf.fetch(query);
      return { name: pf.name, ok: true, results: (res && res.results) || [] };
    } catch (e) {
      return { name: pf.name, ok: false, results: [], error: String((e && e.message) || e) };
    }
  });
  const outs = await Promise.all(fets);
  const f = fuse(outs);
  f.ranProviders = outs.length;
  f.failedProviders = outs.filter(o => !o.ok).map(o => o.name);
  return f;
}

module.exports = { fuse, corroborate, domainOf, domainsOf, overlap };
