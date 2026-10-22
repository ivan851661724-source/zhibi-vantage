'use strict';
// ============================================================
// services/observation-diff.js —— 通用确定性变化检测（SC-09 r2 §一）
// ------------------------------------------------------------
// 为什么单独成一个服务：
//   r1 把「变化检测」塞在 first-collection.js 里，结果是**任何**同品牌同能力的
//   后续采集（手动刷新、正式监控）都会走到首采的 diff 分支，并用
//   `first_collection:<batchId>` 当 windowKey 写进每日情报收件箱——首采的基线
//   事实被后续任务改写，手动刷新冒充「每日雷达监控事件」。
//
// 本服务的唯一职责：给定「上一次可比观察 + 本次观察 + 采集用途」，产出确定性变化，
// 并按用途决定写到哪儿：
//
//   collectionPurpose    允许的去向
//   ───────────────────  ────────────────────────────────────────────────
//   first_collection     只建基线，**不写任何事件**（收件箱/时间线都不写）
//   manual_refresh       只写品牌时间线（nature=observed），绝不进每日情报收件箱
//   monitoring           **唯一**允许写 intel_events 的用途，origin=monitoring，
//                        windowKey 必须是真实监控窗口（拒绝 first_collection:* 前缀）
//
// 硬规则：
//   · 用途必须显式传入且在白名单内；缺省/非法一律 fail-closed（不写任何事件）。
//   · 禁止仅凭 trigger=schedule 推断 monitoring——自动首采同样使用 schedule。
//   · monitoring 缺 windowKey 直接拒收（宁可少写一条事件，也不伪造窗口来源）。
//   · 只比较**结构化可比值**：商品价格/在售/增减、评论数量、公开内容条数。
//     官网资料 / 搜索热度 / 广告覆盖无可比标量 → 永不产出事件。
// ============================================================

const SurfaceStore = require('./surface-store.js');

const PURPOSE = Object.freeze({
  FIRST_COLLECTION: 'first_collection',
  MANUAL_REFRESH: 'manual_refresh',
  MONITORING: 'monitoring',
});
const PURPOSES = Object.freeze([PURPOSE.FIRST_COLLECTION, PURPOSE.MANUAL_REFRESH, PURPOSE.MONITORING]);
const PURPOSE_SET = new Set(PURPOSES);

// 维度 → 品牌时间线 kind（时间线词表只有 price/product/promo/channel/voice/gap/monitor）
const TIMELINE_KIND = Object.freeze({
  price: 'price', product: 'product', stock: 'product', review: 'voice', social: 'voice',
});

function nowIso() { return new Date().toISOString(); }

// 上一次**可比**观察：同 brand × capability、非本次 attempt、终态 success/partial、有观察
function previousComparable(tenantId, projectId, competitorId, capability, currentAttemptId) {
  let all = [];
  try { all = SurfaceStore.listAttempts(tenantId, projectId, competitorId, capability, 10) || []; } catch (e) { all = []; }
  return all.find(a => a && a.attemptId !== currentAttemptId
    && (a.status === 'success' || a.status === 'partial')
    && Array.isArray(a.observations) && a.observations.length > 0) || null;
}

// ---------- 纯计算：不做任何写库 ----------
function computeChanges(capability, prev, cur) {
  const out = [];
  const obs = (cur && Array.isArray(cur.observations)) ? cur.observations : [];
  if (!prev || !obs.length) return out;

  if (capability === 'public_site_products' || capability === 'shopify_catalog') {
    const prevBy = new Map((prev.observations || []).map(o => [String(o.id || o.sourceUrl || ''), o]));
    const curBy = new Map(obs.map(o => [String(o.id || o.sourceUrl || ''), o]));
    for (const [id, c] of curBy) {
      const old = prevBy.get(id);
      if (!old) {
        out.push({
          dimension: 'product', eventType: 'product_added', subjectId: id,
          title: `新增商品：${c.title || id}`,
          summary: `${c.title || id} 首次出现在公开商品页`,
          change: { field: 'product', oldValue: null, newValue: c.title || id, basis: 'deterministic_diff' },
        });
        continue;
      }
      if (typeof old.price === 'number' && typeof c.price === 'number' && old.price !== c.price) {
        out.push({
          dimension: 'price', eventType: 'price_changed', subjectId: id,
          title: `${c.title || id}：价格由 ${old.price} 调整为 ${c.price}`,
          summary: `${c.title || id} 价格 ${old.price} → ${c.price}${c.currency ? ' ' + c.currency : ''}`,
          change: { field: 'price', oldValue: old.price, newValue: c.price, currency: c.currency || null, basis: 'deterministic_diff' },
        });
      }
      const boolOld = old.available === true || old.available === false;
      const boolCur = c.available === true || c.available === false;
      if (boolOld && boolCur && old.available !== c.available) {
        out.push({
          dimension: 'stock', eventType: 'stock_changed', subjectId: id,
          title: `${c.title || id}：${c.available ? '恢复在售' : '变为缺货'}`,
          summary: `${c.title || id} 在售状态 ${old.available ? '在售' : '缺货'} → ${c.available ? '在售' : '缺货'}`,
          change: { field: 'availability', oldValue: old.available, newValue: c.available, basis: 'deterministic_diff' },
        });
      }
    }
    for (const [id, old] of prevBy) {
      if (curBy.has(id)) continue;
      out.push({
        dimension: 'product', eventType: 'product_removed', subjectId: id,
        title: `商品下架：${old.title || id}`,
        summary: `${old.title || id} 不再出现在公开商品页`,
        change: { field: 'product', oldValue: old.title || id, newValue: null, basis: 'deterministic_diff' },
      });
    }
    return out;
  }

  if (capability === 'public_reviews') {
    const p = prev.summary || {};
    const c = (cur && cur.summary) || {};
    const oldN = typeof p.reviewCount === 'number' ? p.reviewCount : null;
    const newN = typeof c.reviewCount === 'number' ? c.reviewCount : null;
    if (oldN != null && newN != null && oldN !== newN) {
      out.push({
        dimension: 'review', eventType: 'review_changed', subjectId: null,
        title: `公开评论数量变化：${oldN} → ${newN}`,
        summary: `公开评论页样本中的评论数量由 ${oldN} 变为 ${newN}（样本不等于全网口碑）`,
        change: { field: 'reviewCount', oldValue: oldN, newValue: newN, basis: 'deterministic_diff' },
      });
    }
    return out;
  }

  if (capability === 'youtube_content' || capability === 'tiktok_commercial_content') {
    const oldN = Array.isArray(prev.observations) ? prev.observations.length : 0;
    const newN = obs.length;
    if (oldN !== newN) {
      out.push({
        dimension: 'social', eventType: 'social_changed', subjectId: null,
        title: `公开内容数量变化：${oldN} → ${newN}`,
        summary: `公开内容条数由 ${oldN} 变为 ${newN}`,
        change: { field: 'contentCount', oldValue: oldN, newValue: newN, basis: 'deterministic_diff' },
      });
    }
  }
  // 官网资料 / 搜索热度 / 广告：无可比结构化字段 → 不产出事件
  return out;
}

// ---------- 写库：按用途分流 ----------
// 返回 { purpose, changes, recorded, writtenTo, reason }
//   writtenTo: 'none' | 'brand_timeline' | 'intel_inbox'
function applyChanges(input) {
  const o = input || {};
  const purpose = String(o.collectionPurpose || '');
  const capability = String(o.capability || '');
  const attempt = o.attempt || null;
  if (!PURPOSE_SET.has(purpose)) {
    return { purpose: purpose || null, changes: 0, recorded: 0, writtenTo: 'none', reason: 'invalid_purpose' };
  }
  if (!attempt || (attempt.status !== 'success' && attempt.status !== 'partial')) {
    return { purpose, changes: 0, recorded: 0, writtenTo: 'none', reason: 'not_success' };
  }
  const prev = o.previousAttempt || null;
  if (!prev) {
    // 首次观察：只建基线。三种用途都不写事件——首采是基线，手动刷新首次也是基线。
    return { purpose, changes: 0, recorded: 0, writtenTo: 'none', reason: 'baseline_only' };
  }
  const changes = computeChanges(capability, prev, attempt);
  if (!changes.length) return { purpose, changes: 0, recorded: 0, writtenTo: 'none', reason: 'no_changes' };

  if (purpose === PURPOSE.FIRST_COLLECTION) {
    // 首采即使存在历史观察，也只建基线。收件箱只收正式监控窗口的变化。
    return { purpose, changes: changes.length, recorded: 0, writtenTo: 'none', reason: 'first_collection_baseline_only' };
  }

  if (purpose === PURPOSE.MANUAL_REFRESH) {
    const written = writeBrandTimeline(o, capability, attempt, changes);
    return { purpose, changes: changes.length, recorded: written, writtenTo: 'brand_timeline', reason: written ? null : 'no_brand_link' };
  }

  // monitoring：唯一允许写 intel_events 的用途
  const windowKey = String(o.windowKey || '');
  if (!windowKey) {
    return { purpose, changes: changes.length, recorded: 0, writtenTo: 'none', reason: 'window_key_required' };
  }
  if (windowKey.startsWith('first_collection:')) {
    // 防御：首采批次号不是监控窗口，绝不能作为事件窗口来源
    return { purpose, changes: changes.length, recorded: 0, writtenTo: 'none', reason: 'invalid_window_key' };
  }
  const written = writeIntelEvents(o, capability, attempt, changes, windowKey);
  return { purpose, changes: changes.length, recorded: written, writtenTo: 'intel_inbox', reason: written ? null : 'write_failed' };
}

// 手动刷新 → 品牌时间线（不是每日情报收件箱）
function writeBrandTimeline(o, capability, attempt, changes) {
  let BrandStore = null;
  try { BrandStore = require('./brand-store.js'); } catch (e) { return 0; }
  let brandId = null;
  try { brandId = BrandStore.brandIdForCompetitor(o.tenantId, o.projectId, o.competitorId); } catch (e) { brandId = null; }
  if (!brandId) return 0;
  const at = attempt.endedAt || attempt.startedAt || nowIso();
  let n = 0;
  for (const c of changes.slice(0, 12)) {
    try {
      const r = BrandStore.appendTimeline({
        tenantId: o.tenantId, brandId,
        kind: TIMELINE_KIND[c.dimension] || 'monitor',
        at,
        nature: 'observed',
        status: (Array.isArray(attempt.evidenceIds) && attempt.evidenceIds.length) ? 'verified' : 'pending',
        title: c.title,
        detail: c.summary,
        refType: 'collection_attempt',
        // 每条变化唯一引用：同一次 attempt 的多个变化需要不同 refId 才不会互相去重
        refId: attempt.attemptId + ':' + (c.subjectId || c.dimension) + ':' + c.eventType,
        payload: {
          basis: 'deterministic_diff',
          collectionPurpose: PURPOSE.MANUAL_REFRESH,
          capability,
          dimension: c.dimension,
          eventType: c.eventType,
          subjectId: c.subjectId || null,
          change: c.change,
          inboxEligible: false,
          note: '手动刷新发现的变化，记入品牌档案时间线；不计入每日雷达监控事件。',
        },
      });
      if (r && !r.deduped) n++;
    } catch (e) { /* 单条失败不影响其余 */ }
  }
  return n;
}

// 正式监控窗口 → 每日情报收件箱（origin 恒为 monitoring）
function writeIntelEvents(o, capability, attempt, changes, windowKey) {
  let Inbox = null;
  try { Inbox = require('./intel-inbox.js'); } catch (e) { return 0; }
  const observedAt = attempt.endedAt || attempt.startedAt || nowIso();
  const refs = [];
  for (const sid of (attempt.snapshotIds || []).slice(0, 3)) {
    refs.push({ snapshotId: sid, sourceUrl: o.sourceUrl || attempt.sourceUrl || null, observedAt });
  }
  let n = 0;
  for (const c of changes.slice(0, 12)) {
    try {
      const r = Inbox.recordEvent({
        tenantId: o.tenantId, projectId: o.projectId, competitorId: o.competitorId,
        brandName: o.brandName || null,
        dimension: c.dimension, eventType: c.eventType,
        subjectId: c.subjectId || o.competitorId || null,
        title: c.title, summary: c.summary,
        observedAt, effectiveAt: null,
        sourceKind: 'live_observation', origin: 'monitoring',
        change: c.change,
        evidenceRefs: refs,
        verificationStatus: refs.length ? 'verified' : 'pending',
        windowKey,
      });
      if (r && r.recorded) n++;
    } catch (e) { /* 单条失败不影响其余 */ }
  }
  return n;
}

module.exports = {
  PURPOSE, PURPOSES,
  previousComparable, computeChanges, applyChanges,
};
