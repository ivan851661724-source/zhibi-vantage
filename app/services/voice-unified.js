'use strict';
// ============================================================
// services/voice-unified.js —— 「用户声音与公开评论」统一读模型（SC-06 三）
// ------------------------------------------------------------
// 产品裁决（SC-06 任务书 §三）：
//   · 用户侧只保留一个名称：「用户声音与公开评论」；
//   · public_reviews（公开评论页采集）是唯一来源层；
//   · 旧 voiceItems（discover 期社媒/评论采集投影）只能作为兼容输入或
//     迁移投影——不得再生成第二套用户可见统计、第二套卡片或第二套
//     机会分母；
//   · 每条已核实评论必须带：来源 URL、Snapshot/Evidence 引用、观察时间、
//     品牌归属、采集范围与样本限制；情绪/主题若展示必须标明提取依据；
//   · 无 Evidence/Snapshot 的评论不得标为已核实；
//   · 样本不足时显示「资料不足，暂不形成群体结论」，不得写成
//     「没有差评」「用户满意」或「无口碑」。
// 消费方（同一读模型，禁止各自拼第二口径）：
//   情报库评论变化 / 品牌档案「用户声音与公开评论」tab / 机会算法输入。
// ============================================================

const Surface = require('./data-surface.js');

const VOICE_MODEL_VERSION = 'voice-unified-1';

// 单条已核实评论的规范化（字段来自采集观察 + Evidence 引用，缺失即 null）
function toVerifiedItem(o, evRefs, brandId) {
  const ev = (evRefs && evRefs[0]) || {};
  return {
    kind: 'review_page',
    title: o.title || null,
    snippet: o.snippet || null,
    sourceUrl: o.sourceUrl || null,
    rating: typeof o.rating === 'number' ? o.rating : null,
    reviewCount: typeof o.reviewCount === 'number' ? o.reviewCount : null,
    observedAt: o.publishedAt || null,
    brandId: brandId || null,
    evidenceId: ev.evidenceId || null,
    snapshotId: ev.snapshotId || null,
    // 情绪与依据：public_reviews 采集不产生情绪判断——null 即不展示，
    // 不从片段/评分猜情绪（评分只在 rating 字段原样展示）
    sentiment: null,
    sentimentBasis: null,
  };
}

// 旧 voiceItem → 迁移投影（明确降级：不算已核实、不进统计）
function toLegacyItem(v, brandId) {
  if (!v) return null;
  return {
    kind: 'legacy_voice',
    platform: v.platform || null,
    text: v.text ? String(v.text).slice(0, 300) : null,
    url: v.url || null,
    date: v.date || null,
    brandId: brandId || null,
    evidenceId: null, snapshotId: null, // 旧链路无 Snapshot/Evidence 引用
    note: '历史采集投影',
  };
}

// 样本是否足以形成群体结论：至少 1 个来源页面且总评论量 ≥ 5（保守下限；
// 依据：reviews_digest 摘要口径——样本必须明示，不足即不形成群体结论）
function enoughForGroupConclusion(summary) {
  if (!summary) return false;
  return (summary.reviewCount || 0) >= 5 || (summary.sourceCount || 0) >= 3;
}

/**
 * 统一读模型。brandId 必须已做 tenant/project/brand 三重归属校验（调用方负责）。
 * 返回结构（用户可见投影，不含内部路径/错误）：
 * {
 *   version, title, status: 'sufficient'|'insufficient',
 *   insufficientText,
 *   verified: { items, summary },
 *   legacy: { items, note },
 * }
 */
function buildUnifiedVoice({ tenantId, projectId, brandId, comp }) {
  const c = comp || {};
  // —— 来源层：public_reviews 采集（Data Surface 真值链读出）——
  let obs = []; let evRefs = []; let summary = null;
  try {
    const det = Surface.buildDimensionDetail({
      tenantId, projectId, competitorId: c.id, dimension: 'reviews_reputation',
      offset: 0, limit: 50, comp: c,
    });
    const cap = (det.capabilities || []).find(x => x.capabilityCode === 'public_reviews');
    if (cap) {
      obs = cap.observations || [];
      evRefs = cap.evidenceRefs || [];
      summary = cap.summary || null;
    }
  } catch (e) { /* 维度不可读：按样本不足处理，不填充 */ }

  const verifiedItems = obs
    .map(o => toVerifiedItem(o, evRefs, brandId))
    // 无 Evidence/Snapshot 引用的观察不进入「已核实」集合（SC-06 验收 6）
    .filter(x => x.evidenceId || x.snapshotId);

  const verifiedSummary = summary ? {
    sampleSize: typeof summary.reviewCount === 'number' ? summary.reviewCount : verifiedItems.reduce((s, x) => s + (x.reviewCount || 0), 0),
    sourceCount: typeof summary.sourceCount === 'number' ? summary.sourceCount : verifiedItems.length,
    periodStart: summary.periodStart || null,
    periodEnd: summary.periodEnd || null,
    measurementMethod: summary.measurementMethod || 'public_source_observation',
    sampleNote: summary.sampleNote || '样本为本次采集窗口内通过校验的公开评论页面，不等于全网口碑',
    limitations: [
      '样本为公开页面可核验的评论，不是全网口碑总量',
      '评分与评价数为来源页面公开字段，未做跨平台归一',
    ],
  } : null;

  const sufficient = verifiedItems.length > 0 && enoughForGroupConclusion(verifiedSummary || {});

  // —— 兼容输入：旧 voiceItems 迁移投影（不算已核实、不进统计）——
  const legacyItems = (Array.isArray(c.voiceItems) ? c.voiceItems : [])
    .map(v => toLegacyItem(v, brandId)).filter(Boolean).slice(0, 50);

  return {
    version: VOICE_MODEL_VERSION,
    title: '用户声音与公开评论',
    status: sufficient ? 'sufficient' : 'insufficient',
    insufficientText: '资料不足，暂不形成群体结论。',
    verified: {
      items: verifiedItems,
      summary: verifiedSummary,
    },
    legacy: {
      items: legacyItems,
      note: legacyItems.length ? '以下为历史采集的迁移投影，未挂 Snapshot/Evidence 引用，不计入公开评论统计。' : null,
    },
  };
}

/**
 * 机会算法输入投影：统一读模型 → computeOpportunityMap 的 voiceItems 兼容形状。
 * 只输出已核实评论（有 Evidence/Snapshot），保证机会分母只吃一套口径；
 * 样本不足返回空数组（机会层自然退化为无口碑输入，而不是猜一个）。
 */
function toOpportunityInput(unified) {
  const u = unified || {};
  if (u.status !== 'sufficient') return [];
  return (u.verified.items || []).map(x => ({
    platform: 'public_web',
    url: x.sourceUrl || null,
    text: x.snippet || '',
    date: x.observedAt || null,
    // 情绪：统一读模型当前不产出情绪（不猜），机会层按中性处理
    sentiment: 'neu',
    tier: 'public_web',
  }));
}

/**
 * 项目级「用户声音与公开评论」投影（情报库独立字段 voiceChanges 用）。
 * 只有一套口径：verified.summary 统计 + 最近观察样例；sufficient 才给统计。
 */
function buildProjectVoiceSummary(tenantId, projectId, opts) {
  const o = opts || {};
  const BrandStore = require('./brand-store.js');
  const BrandSvc = require('./brand-service.js');
  const state = BrandSvc.loadProjectState(tenantId, projectId);
  const links = BrandStore.listBrandLinksForProject(tenantId, projectId) || [];
  const out = [];
  for (const b of links) {
    if (o.brandId && b.brandId !== o.brandId) continue;
    const comp = b.competitorRef ? BrandSvc.findCompetitor(state, b.competitorRef) : null;
    let u = null;
    try { u = buildUnifiedVoice({ tenantId, projectId, brandId: b.brandId, comp: comp || {} }); } catch (e) { u = null; }
    if (!u) continue;
    out.push({
      brandId: b.brandId,
      brandName: b.canonicalName || null,
      status: u.status,
      sampleSize: u.verified.summary ? u.verified.summary.sampleSize : 0,
      sourceCount: u.verified.summary ? u.verified.summary.sourceCount : 0,
      recentItems: (u.verified.items || []).slice(0, 3).map(x => ({
        title: x.title, sourceUrl: x.sourceUrl, rating: x.rating, reviewCount: x.reviewCount,
        observedAt: x.observedAt, evidenceId: x.evidenceId, snapshotId: x.snapshotId,
      })),
    });
  }
  return out;
}

module.exports = { buildUnifiedVoice, toOpportunityInput, buildProjectVoiceSummary, VOICE_MODEL_VERSION };
