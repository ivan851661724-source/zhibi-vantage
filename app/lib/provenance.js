'use strict';
// ============================================================
// 证据链数据库（P0）：每条数据都可溯源。
// 核心五字段： [原始值, 数据源ID, 抓取时间, 冲突标志, 当前采纳值]
// 每一层转换（原始 → 归一 → 校验 → 采纳）都写日志，供报告生成「证据编号对照」。
// 本模块零依赖、纯函数为主，不触碰 LLM（裁决由 adjudication.js 负责）。
// ============================================================
const SOURCE_KIND = {
  OFFICIAL: 'official',       // 官网（最高权威）
  THIRD_PARTY: 'third_party', // 第三方（Crunchbase 等）
  USER: 'user',               // 用户贡献
  LLM_ENUM: 'llm_enum',       // LLM 枚举候选（非权威，待核验）
};

let _seq = 0;
function nextId(prefix) { _seq += 1; return (prefix || 'ev') + '-' + Date.now().toString(36) + '-' + _seq; }

// 一条证据记录：某来源对某锚点某字段的一次取值。
// 这正对应「原始值 / 数据源ID / 抓取时间 / 冲突标志」四项（采纳值在链级别）。
function makeEvidenceRecord({ anchorId, field, rawValue, sourceId, sourceKind, fetchedAt, basis, confidence, note, url, domain, text, fingerprint }) {
  return {
    id: nextId('ev'),                       // 证据编号（报告对照用）
    anchorId: anchorId || null,
    field: field || null,
    rawValue: rawValue,                     // 原始值（未加工）
    sourceId: sourceId || null,             // 数据源ID（如 crunchbase / 某官网URL / 用户ID）
    sourceKind: sourceKind || SOURCE_KIND.LLM_ENUM,
    fetchedAt: fetchedAt || new Date().toISOString(), // 抓取时间（ISO8601）
    basis: basis || 'stated',               // stated(声称) / inferred(推断) / verified(已核验)
    confidence: confidence || 'low',
    note: note || '',
    conflictFlag: false,                    // 冲突标志（被裁决引擎置位）
    // P0-0 加性字段：为契约层与内容指纹预留（不影响既有调用/测试）。
    url: url || null,                       // 来源网页 URL（若有）
    domain: domain || null,                 // 显式注册域（若有）
    text: text || null,                     // 来源原文/快照（内容指纹用，可选）
    fingerprint: fingerprint || null,       // 内容指纹哈希（可选，进一步拆分/合并身份）
  };
}

// 证据链：某锚点某字段的全部证据 + 转换日志 + 当前采纳值（由裁决引擎填）。
function makeEvidenceChain(anchorId, field) {
  return {
    anchorId,
    field,
    records: [],          // EvidenceRecord[]
    transformLog: [],     // {at, layer, from, to, actor, reason} —— 每层转换留痕
    adoptedValue: undefined,
    adoptedConfidence: null,
    conflictFlag: false,
  };
}

function chainAddRecord(chain, rec) {
  chain.records.push(rec);
  return chain;
}

// 记录一次转换：从 from 到 to，由谁(actor)在哪一工序(layer)因何(reason)产生。
function chainLog(chain, layer, from, to, actor, reason) {
  chain.transformLog.push({
    at: new Date().toISOString(),
    layer: layer || 'unknown',
    from: from == null ? null : String(from),
    to: to == null ? null : String(to),
    actor: actor || 'system',
    reason: reason || '',
  });
  return chain;
}

// 标记某记录参与冲突（裁决引擎调用）。
function markConflict(chain, recIds) {
  const set = new Set(recIds || []);
  for (const r of chain.records) if (set.has(r.id)) r.conflictFlag = true;
  chain.conflictFlag = true;
  return chain;
}

// 报告「证据编号对照」行：把链扁平化为五字段 + 证据编号。
// 输出顺序即你要的：原始值 | 数据源ID | 抓取时间 | 冲突标志 | 当前采纳值。
function toEvidenceRow(chain) {
  return {
    evidenceId: chain.records.map(r => r.id).join(','),
    rawValue: chain.records.length ? chain.records[chain.records.length - 1].rawValue : null,
    sourceId: chain.records.length ? chain.records[chain.records.length - 1].sourceId : null,
    fetchedAt: chain.records.length ? chain.records[chain.records.length - 1].fetchedAt : null,
    conflictFlag: chain.conflictFlag,
    adoptedValue: chain.adoptedValue === undefined ? null : chain.adoptedValue,
  };
}

module.exports = {
  SOURCE_KIND,
  makeEvidenceRecord,
  makeEvidenceChain,
  chainAddRecord,
  chainLog,
  markConflict,
  toEvidenceRow,
};
