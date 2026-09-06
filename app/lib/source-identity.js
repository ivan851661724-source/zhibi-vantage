'use strict';
// ============================================================
// 独立来源身份判定（P0-1 基石，零依赖纯函数）。
// 忠实助理纪律：独立来源 = 真实世界的不同出处，绝不是 sourceKind 的"种类数"。
//   · 两个同域名的镜像站（一个标 third_party、一个标 official）算 1 个独立来源。
//   · 同一篇网页被不同适配器各抓一次 → 1 个独立来源。
//   · LLM 枚举(llm_enum)不具裁决权，永不计入独立来源（避免冒充佐证）。
// 本模块只做"身份解析 + 聚合"，不参与置信裁决（裁决在 adjudication.js）。
// ============================================================
const { SOURCE_KIND } = require('./provenance.js');

// 常见"多段公共后缀"：这类域名的注册域是末三段（如 brandA.co.uk ≠ brandB.co.uk）。
// 宁可少去重也不可误去重——这里只列入竞品场景高频、且误判代价高的少数几个。
const MULTI_TLD = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'edu.au', 'com.au', 'net.au', 'org.au',
  'co.jp', 'co.nz', 'com.br', 'com.cn', 'org.cn', 'gov.cn', 'com.sg', 'co.za', 'com.hk', 'org.hk',
]);

// 取注册域：去协议 / 去 www / 去子域；非 URL 输入返回 null。
function extractDomain(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;
  // 没有协议、也不是裸域名形态（含点且为 label.label...）→ 视为逻辑名，非 URL
  const looksLikeUrl = /^https?:\/\//i.test(s) || /^www\./i.test(s);
  const looksLikeHost = /^[\w-]+(\.[\w-]+)+$/.test(s);
  if (!looksLikeUrl && !looksLikeHost) return null;
  try {
    let host;
    if (/^https?:\/\//i.test(s)) host = new URL(s).hostname;
    else host = s.replace(/^www\./i, '').split('/')[0];
    host = host.replace(/^www\./i, '').toLowerCase();
    if (!host) return null;
    const parts = host.split('.');
    if (parts.length <= 2) return parts.join('.');
    const last2 = parts.slice(-2).join('.');
    if (MULTI_TLD.has(last2)) return parts.slice(-3).join('.');
    return last2;
  } catch (e) {
    return null;
  }
}

// 解析一条证据记录的"独立来源身份"键：
//   优先 record.url（适配器显式给的网页）→ 域名
//   否则 record.domain（显式给的域）
//   否则 record.sourceId 若是 URL 形态 → 域名
//   否则 逻辑名（crunchbase / wikidata:Q123 / official / user ...）
// LLM 枚举恒返回 null（不计入独立来源）。
function sourceIdentity(record) {
  if (!record) return null;
  if (record.sourceKind === SOURCE_KIND.LLM_ENUM) return null;
  const dom = extractDomain(record.url || record.domain || record.sourceId);
  if (dom) return 'domain:' + dom;
  const sid = record.sourceId != null ? String(record.sourceId) : null;
  return sid ? 'logical:' + sid : null;
}

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

// ============================================================
// 内容指纹（P0-1 第二阶段）：SimHash 局部敏感哈希，用于跨域转载同源检测。
// 两篇不同域名的文章若正文（title/描述）高度相似 → 指纹汉明距离很小 → 判同源，
// 不应被 independentAgreement 计为「两个独立来源」（避免转载刷独立源数）。
// 零依赖：64 位 SimHash（32 位 FNV-1a 哈希按位扩散到 64 位向量）。
// ============================================================
function contentFingerprint(text) {
  if (!text || typeof text !== 'string') return null;
  const tokens = text.toLowerCase().match(/[a-z0-9一-龥]+/g) || [];
  if (!tokens.length) return null;
  const BITS = 64;
  const vec = new Array(BITS).fill(0);
  for (const t of tokens) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    for (let b = 0; b < BITS; b++) {
      if ((h >>> (b & 31)) & 1) vec[b] += 1; else vec[b] -= 1; // 32 位哈希按位旋转铺到 64 位
    }
  }
  let fp = 0n;
  for (let b = 0; b < BITS; b++) if (vec[b] > 0) fp |= (1n << BigInt(b));
  return fp.toString(16);
}
// 两指纹汉明距离（不同 → 返回大数；任一缺失 → 不相似）
function fingerprintHamming(aHex, bHex) {
  if (!aHex || !bHex) return Infinity;
  const x = (BigInt('0x' + aHex) ^ BigInt('0x' + bHex));
  let v = x, c = 0;
  while (v > 0n) { c += Number(v & 1n); v >>= 1n; }
  return c;
}
function fingerprintSimilar(aHex, bHex, threshold) {
  const th = (threshold != null) ? threshold : 3;
  return fingerprintHamming(aHex, bHex) <= th;
}

// 给定一组真实记录（外部已建议先过滤 LLM）与采纳值 topVal，
// 返回按独立身份聚合的交叉验证结果。
//   count      : 与 topVal 一致的独立身份数量（真正的"独立来源同意数"）
//   identities : 全部真实身份的聚合 [{identity, sourceKinds[], sourceIds[], agrees}]
// opts.match(rv, topVal): 自定义"是否一致"判定（如价格区间 range 重叠）。
//   不传则回退 norm(rv)===norm(topVal) 精确相等（向后兼容 adjudication 的 2 参调用）。
// opts.matchByFingerprint: true → 开启内容指纹同源合并：不同域名但正文指纹相近（转载同源）
//   的记录合并为同一独立来源，不夸大独立源数（忠实助理：转载不是新证据）。
// opts.fingerprintThreshold: 汉明距离阈值（默认 3 / 64 位，越严越不易误并）。
function independentAgreement(records, topVal, opts) {
  opts = opts || {};
  const real = (records || []).filter((r) => r.sourceKind !== SOURCE_KIND.LLM_ENUM);
  const tv = norm(topVal);
  const agreesWith = (rv) => (opts.match ? opts.match(rv, topVal) : norm(rv) === tv);
  const byIdentity = new Map();
  for (const r of real) {
    const id = sourceIdentity(r);
    if (!id) continue;
    if (!byIdentity.has(id)) byIdentity.set(id, { identity: id, sourceKinds: new Set(), sourceIds: new Set(), agrees: false, fingerprints: new Set() });
    const e = byIdentity.get(id);
    e.sourceKinds.add(r.sourceKind);
    if (r.sourceId != null) e.sourceIds.add(String(r.sourceId));
    if (agreesWith(r.rawValue)) e.agrees = true;
    if (r.fingerprint) e.fingerprints.add(r.fingerprint);
  }
  let identities = [...byIdentity.values()].map((e) => {
    const o = { identity: e.identity, sourceKinds: [...e.sourceKinds], sourceIds: [...e.sourceIds], agrees: e.agrees };
    if (e.fingerprints.size) o.fingerprints = [...e.fingerprints];
    return o;
  });
  // P0-1 第二阶段：内容指纹同源合并（不同域名但转载同源 → 不计入独立源）
  if (opts.matchByFingerprint && identities.length >= 2) {
    const parent = identities.map((_, i) => i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { parent[find(a)] = find(b); };
    const TH = (opts.fingerprintThreshold != null) ? opts.fingerprintThreshold : 3;
    for (let i = 0; i < identities.length; i++) {
      for (let j = i + 1; j < identities.length; j++) {
        if (identities[i].identity === identities[j].identity) continue; // 同域已并
        let sim = false;
        for (const fa of (identities[i].fingerprints || [])) {
          for (const fb of (identities[j].fingerprints || [])) {
            if (fa && fb && fingerprintSimilar(fa, fb, TH)) { sim = true; break; }
          }
          if (sim) break;
        }
        if (sim) union(i, j);
      }
    }
    const groups = new Map();
    for (let i = 0; i < identities.length; i++) {
      const r = find(i);
      if (!groups.has(r)) {
        groups.set(r, {
          identity: identities[i].identity,
          sourceKinds: new Set(identities[i].sourceKinds),
          sourceIds: new Set(identities[i].sourceIds),
          agrees: identities[i].agrees,
          mergedFrom: [identities[i].identity],
        });
      } else {
        const g = groups.get(r);
        identities[i].sourceKinds.forEach((s) => g.sourceKinds.add(s));
        identities[i].sourceIds.forEach((s) => g.sourceIds.add(s));
        g.agrees = g.agrees || identities[i].agrees;
        g.mergedFrom.push(identities[i].identity);
      }
    }
    identities = [...groups.values()].map((g) => ({ identity: g.identity, sourceKinds: [...g.sourceKinds], sourceIds: [...g.sourceIds], agrees: g.agrees, mergedFrom: g.mergedFrom }));
  }
  return {
    count: identities.filter((e) => e.agrees).length,
    identities,
  };
}

module.exports = { extractDomain, sourceIdentity, independentAgreement, contentFingerprint, fingerprintHamming, fingerprintSimilar, MULTI_TLD };
