'use strict';
// ============================================================
// 实体锚点库（P0）：品类 → TopN 品牌锚点。
// 每个锚点的值，由「证据链(provenance) + 裁决引擎(adjudication)」产出，
// 绝不由 LLM 直接断言。LLM 枚举只产生「候选(candidate)·待核验」，
// 只有当官网/第三方/用户贡献中至少一个真实源佐证时，才升级为 adopted。
//
// 设计铁律（忠实助理）：LLM 枚举的 3000 条品牌 ≠ 已验证 Top30。
//   它们以 sourceKind=llm_enum、confidence=low、status=candidate 入库，
//   一旦有真实源交叉验证才提升置信/状态；否则永不冒充权威名单。
// ============================================================
const fs = require('fs');
const path = require('path');
const FU = require('./fs-util.js');
const P = require('./provenance.js');
const A = require('./adjudication.js');
const C = require('./contract.js');
const { SOURCE_KIND } = P;

function anchorIdFor(category, name) {
  return (category + '::' + name).toLowerCase().replace(/\s+/g, '-');
}

// ---------- 源适配器：把各类来源映射为 EvidenceRecord[] ----------
// Crunchbase 适配器：受 config.apiKey 门控。无 key → configured:false（绝不伪造调用）。
// 真实 HTTP 拉取由调用方用 fetch 打 Crunchbase Organizations API 后，把组织映射为 records。
function crunchbaseAdapter(config) {
  if (!config || !config.apiKey) return { configured: false };
  return { configured: true, sourceId: 'crunchbase', sourceKind: SOURCE_KIND.THIRD_PARTY };
}
// 真实拉取（需 key + 网络）。返回 EvidenceRecord[]。本函数不臆造，调用失败即抛由上层 bestEffort 处理。
async function crunchbaseFetch(config, query) {
  if (!config || !config.apiKey) throw new Error('crunchbase 未配置 apiKey');
  const url = 'https://api.crunchbase.com/api/v4/searches/organizations?query=' + encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'X-cb-user-key': config.apiKey, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error('crunchbase HTTP ' + res.status);
  const j = await res.json();
  const items = (j && j.data && j.data.items) || [];
  return items.map((it) => {
    const o = it && it.properties || {};
    return P.makeEvidenceRecord({
      anchorId: anchorIdFor(o.category_for_org || query, o.name),
      field: 'exists',
      rawValue: o.name,
      sourceId: 'crunchbase',
      sourceKind: SOURCE_KIND.THIRD_PARTY,
      basis: 'verified',
      confidence: 'medium',
      note: 'Crunchbase 组织: ' + (o.permalink || ''),
    });
  });
}

// LLM 枚举适配器：把 LLM 产出的候选品牌映射为「待核验」证据（低置信、非权威）。
function llmEnumerationAdapter(results, sourceId) {
  return (results || []).map((r) => P.makeEvidenceRecord({
    anchorId: anchorIdFor(r.category, r.name),
    field: 'exists',
    rawValue: r.name,
    sourceId: sourceId || 'llm-enum',
    sourceKind: SOURCE_KIND.LLM_ENUM,
    basis: 'inferred',
    confidence: 'low',
    note: 'LLM枚举候选·待核验: ' + (r.note || (r.category ? ('品类 ' + r.category) : '')),
  }));
}

// 官网适配器：品牌自身声明，最权威（对其自身字段）。
function officialSiteAdapter({ anchorId, field, value, url }) {
  return P.makeEvidenceRecord({
    anchorId, field, rawValue: value, sourceId: url || 'official', sourceKind: SOURCE_KIND.OFFICIAL,
    basis: 'stated', confidence: 'medium', note: '官网声明',
  });
}

// 用户贡献适配器：来自一线，主观但有价值。
function userContributionAdapter({ anchorId, field, value, userId }) {
  return P.makeEvidenceRecord({
    anchorId, field, rawValue: value, sourceId: userId || 'user', sourceKind: SOURCE_KIND.USER,
    basis: 'stated', confidence: 'low', note: '用户贡献',
  });
}

// ---------- 零边际成本真实源适配器（不另开预算） ----------
// Wikidata 适配器：免费、无需 key（仅带 User-Agent）。把品牌匹配为 Wikidata 实体，
// 给出「真实存在」证据 + 成立年(P571)。小品牌不在 Wikidata → 返回 []（保持 candidate，不伪造）。
// fetchImpl 注入便于测试；默认用全局 fetch。
async function wikidataFetch({ category, name, fetchImpl }) {
  const f = fetchImpl || fetch;
  const ua = { 'User-Agent': 'CompetitorIntelAssistant/1.0 (anchor-enrichment; contact@testboard.example)' };
  const sUrl = 'https://www.wikidata.org/w/api.php?action=wbsearchentities&search=' +
    encodeURIComponent(name) + '&language=en&format=json&limit=1';
  let sj;
  try { const r = await f(sUrl, { headers: ua }); if (!r.ok) return []; sj = await r.json(); }
  catch (e) { return []; }
  const ent = sj && sj.search && sj.search[0];
  if (!ent || !ent.id) return [];
  const qid = ent.id;
  const gUrl = 'https://www.wikidata.org/w/api.php?action=wbgetentities&ids=' + qid +
    '&props=claims&languages=en&format=json';
  let gj;
  try { const r = await f(gUrl, { headers: ua }); if (!r.ok) return []; gj = await r.json(); }
  catch (e) { return []; }
  const claims = (gj && gj.entities && gj.entities[qid] && gj.entities[qid].claims) || {};
  const aid = anchorIdFor(category, name);
  const recs = [P.makeEvidenceRecord({
    anchorId: aid, field: 'exists', rawValue: name,
    sourceId: 'wikidata:' + qid, sourceKind: SOURCE_KIND.THIRD_PARTY,
    basis: 'verified', confidence: 'medium', note: 'Wikidata实体: ' + (ent.label || name) + ' (' + qid + ')',
  })];
  const p571 = claims.P571;
  if (Array.isArray(p571) && p571[0] && p571[0].mainsnak && p571[0].mainsnak.datavalue) {
    const t = p571[0].mainsnak.datavalue.value && p571[0].mainsnak.datavalue.value.time;
    const y = t && /^[-+]?(\d{4})/.exec(t);
    if (y) recs.push(P.makeEvidenceRecord({
      anchorId: aid, field: 'foundedYear', rawValue: y[1],
      sourceId: 'wikidata:' + qid, sourceKind: SOURCE_KIND.THIRD_PARTY,
      basis: 'verified', confidence: 'medium', note: 'Wikidata P571(inception) ' + qid,
    }));
  }
  return recs;
}

// 归一化 Serper key 池：与 server.js:getSerperKey 一致——优先 serperKeys 数组 / serperKey，
// 最后才退到 apiKey（注意 apiKey 常为 Tavily 的 tvly- 前缀，并非 Serper key，故排最后）。
function serperKeysOf(config) {
  const s = config && config.search;
  if (!s) return [];
  const out = [];
  const push = (k) => { if (k && typeof k === 'string' && k.trim()) { const t = k.trim(); if (!out.includes(t)) out.push(t); } };
  if (Array.isArray(s.serperKeys)) s.serperKeys.forEach(push);
  push(s.serperKey);
  push(s.apiKey);
  return out;
}

// Serper 适配器：复用已付费的 Serper key（零边际成本）。用 Google 知识图谱 + 真实索引页
// 作为「第三方真实源」佐证品牌存在/成立年。证据=真实网页，LLM 只做提取（诚实纪律）。
// 无 key → 返回 []（不伪造调用）。fetchImpl 注入便于测试。
async function serperFetch({ category, name, config, fetchImpl }) {
  const f = fetchImpl || fetch;
  const keys = serperKeysOf(config);
  const key = keys[0];
  if (!key) return [];
  const aid = anchorIdFor(category, name);
  let j;
  try {
    const r = await f('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: name + ' brand company' }),
    });
    if (!r.ok) return [];
    j = await r.json();
  } catch (e) { return []; }
  const recs = [];
  const kg = j && j.knowledgeGraph;
  if (kg) {
    recs.push(P.makeEvidenceRecord({
      anchorId: aid, field: 'exists', rawValue: name,
      sourceId: kg.website || 'serper:knowledgeGraph', sourceKind: kg.website ? SOURCE_KIND.OFFICIAL : SOURCE_KIND.THIRD_PARTY,
      basis: 'verified', confidence: 'medium', note: 'Serper知识图谱确认实体' + (kg.type ? (' · ' + kg.type) : ''),
    }));
    const y = kg.founded && /^[-+]?(\d{4})/.exec(String(kg.founded));
    if (y) recs.push(P.makeEvidenceRecord({
      anchorId: aid, field: 'foundedYear', rawValue: y[1],
      sourceId: kg.website || 'serper:knowledgeGraph', sourceKind: kg.website ? SOURCE_KIND.OFFICIAL : SOURCE_KIND.THIRD_PARTY,
      basis: 'verified', confidence: 'medium', note: 'Serper知识图谱.founded',
    }));
  }
  // 真实索引页（organic）作为独立来源 → 用于交叉验证「品牌存在」。
  // 若索引页 host 与品牌名高度吻合（官网），则升为 OFFICIAL（优先级3），
  // 与 Wikidata(THIRD_PARTY) 凑成 2 类独立真实源 → 可升 verified（诚实且更可信）。
  const organic = (j && j.organic || []).slice(0, 2);
  const nameNorm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const o of organic) {
    const link = o.link || '';
    let sk = SOURCE_KIND.THIRD_PARTY;
    try {
      const host = new URL(link).hostname.replace(/^www\./, '');
      if (host.includes(nameNorm) || nameNorm.includes(host.split('.')[0])) sk = SOURCE_KIND.OFFICIAL;
    } catch (e) { /* 非法 URL 保持第三方 */ }
    recs.push(P.makeEvidenceRecord({
      anchorId: aid, field: 'exists', rawValue: name,
      sourceId: link || 'serper:organic', sourceKind: sk,
      basis: 'stated',
      confidence: sk === SOURCE_KIND.OFFICIAL ? 'medium' : 'low',
      note: (sk === SOURCE_KIND.OFFICIAL ? '品牌官网' : 'Serper索引页提及') + ': ' + (o.title || ''),
    }));
  }
  return recs;
}

// ---------- 把一个锚点某字段的一组证据，经裁决引擎产出 adopted + status ----------
function buildAnchor(anchorId, field, records) {
  const chain = P.makeEvidenceChain(anchorId, field);
  records.forEach((r) => P.chainAddRecord(chain, r));
  P.chainLog(chain, 'ingest', 'raw-records(' + records.length + ')', 'records', 'anchor-library', '来源归集');
  const a = A.adjudicate(chain.records);
  if (a.conflictFlag) P.markConflict(chain, chain.records.map((r) => r.id));
  chain.adoptedValue = a.adoptedValue;
  chain.adoptedConfidence = a.confidence;
  chain.conflictFlag = a.conflictFlag;
  P.chainLog(chain, 'adjudicate', 'records(' + chain.records.length + ')', 'adopted=' + a.adoptedValue, 'adjudication-engine', a.reason);
  const status = a.conflictFlag ? 'conflict'
    : (a.adoptedFrom === SOURCE_KIND.LLM_ENUM ? 'candidate'
      : (a.confidence === 'high' ? 'verified' : 'claimed'));
  // P0-0：把裁决结论统一收敛为 EvidencePack/Verdict 契约，供上游(server/报告)以单一结构消费。
  const pack = C.makeEvidencePack({ anchorId, field, records: chain.records, status, adopted: a });
  return { anchorId, field, chain, adopted: a, status, pack };
}

// ---------- 锚点库容器（按 dataDir 注入，便于测试与server隔离） ----------
function createAnchorLibrary({ dataDir }) {
  const libPath = path.join(dataDir, 'anchor-library.json');
  const store = { categories: {}, anchors: {}, generatedAt: null };

  // 把一组证据记录按 anchorId+field 分组，构建全部锚点。
  function ingest(records) {
    const groups = {};
    for (const r of records) {
      const key = r.anchorId + '|' + (r.field || '');
      (groups[key] = groups[key] || []).push(r);
    }
    const built = [];
    for (const key of Object.keys(groups)) {
      const [anchorId, field] = key.split('|');
      const a = buildAnchor(anchorId, field, groups[key]);
      store.anchors[key] = a;
      const cat = (anchorId.split('::')[0] || 'unknown');
      (store.categories[cat] = store.categories[cat] || []).push(key);
      built.push(a);
    }
    store.generatedAt = new Date().toISOString();
    return built;
  }

  function get(anchorId, field) { return store.anchors[anchorId + '|' + (field || '')]; }
  function statusOf(anchorId, field) { const a = get(anchorId, field); return a ? a.status : null; }

  // 报告「证据编号对照」：每个链一行五字段。
  function evidenceRows() {
    return Object.keys(store.anchors).map((k) => {
      const a = store.anchors[k];
      const row = P.toEvidenceRow(a.chain);
      return Object.assign({ anchorId: a.anchorId, field: a.field, status: a.status }, row);
    });
  }

  function persist(sync) {
    const serializable = {
      generatedAt: store.generatedAt,
      categories: store.categories,
      anchors: store.anchors,
    };
    // sync=true：CLI 短进程用同步原子写（失败即抛，可靠落盘）；
    // 否则用 bestEffortWrite（常驻服务器用，后台重试，非致命）。
    if (sync) return FU.safeWrite(libPath, serializable, true);
    return FU.bestEffortWrite(libPath, serializable, true);
  }

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(libPath, 'utf8'));
      store.generatedAt = j.generatedAt || null;
      store.categories = j.categories || {};
      store.anchors = j.anchors || {};
      return true;
    } catch (e) { return false; }
  }

  // 富集：给已有锚点追加真实源证据，经 buildAnchor 重建（复用裁决引擎）。
  // 返回 { upgradedFrom, upgradedTo } 或 null（锚点不存在）。新增 field 会登记到 categories。
  function enrich(anchorKey, newRecords) {
    const a = store.anchors[anchorKey];
    if (!a) return null;
    const byField = {};
    for (const r of (newRecords || [])) (byField[r.field] = byField[r.field] || []).push(r);
    const upgradedFrom = a.status;
    let upgradedTo = a.status;
    for (const field of Object.keys(byField)) {
      const fkey = anchorKey.split('|')[0] + '|' + field;
      const base = (field === a.field) ? a.chain.records.slice() : [];
      const built = buildAnchor(a.anchorId, field, base.concat(byField[field]));
      store.anchors[fkey] = built;
      if (fkey !== anchorKey) {
        const cat = a.anchorId.split('::')[0];
        (store.categories[cat] = store.categories[cat] || []).push(fkey);
      }
      if (fkey === anchorKey) upgradedTo = built.status;
    }
    return { upgradedFrom, upgradedTo };
  }

  return {
    store,
    ingest,
    get,
    statusOf,
    evidenceRows,
    persist,
    load,
    enrich,
    path: libPath,
  };
}

module.exports = {
  SOURCE_KIND,
  anchorIdFor,
  crunchbaseAdapter,
  crunchbaseFetch,
  llmEnumerationAdapter,
  officialSiteAdapter,
  userContributionAdapter,
  wikidataFetch,
  serperFetch,
  buildAnchor,
  createAnchorLibrary,
};
