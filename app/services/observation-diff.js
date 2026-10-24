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

// ---------- 可比范围（SC-09 r3 §三 / SC-10 §二 旧数据保护） ----------
// 缺陷：r2 对 success 与 partial 用同一套集合差 → 本次没抓到的商品被写成「下架」，
// 内容条数因为分页失败变少被写成「内容减少」。没被观察到 ≠ 不存在。
//
// 口径：
//   · 完整采集 = attempt.status==='success' 且 summary.partialScan 不为 true 且无 failedPage；
//   · 比较范围一致 = 同一发现路径 / 同一测量方法 / 同一周期 / 同一国家或渠道范围；
//   · 只有「两次都完整 且 范围一致」才允许下「东西没了」的结论（product_removed / 数量下降）；
//   · partial 仍可记录「同一稳定 ID 的价格/库存变化」和「本次确实新观察到的东西」，
//     但必须标注 scopeLimited=true，文案说明只代表已抓取到的部分；
//   · SC-10 §二：旧 attempt 缺字段时**默认不可比**——unknown + unknown ≠ 范围相同。
//
// 为什么不允许 unknown+unknown：升级前落库的 attempt 没有 discoveryPath/周期/渠道，
// 两侧都取到空串时字符串相等会判定「范围相同」，一旦本次是完整采集就会把「旧库里
// 有、本次没抓到」的老商品批量写成下架。宁可少报事件，不可制造假结论。
const UNKNOWN_SCOPE_WORDS = new Set(['', 'unknown', 'null', 'undefined', 'n/a']);

// 归一化范围字段：缺失/未知 → null（不可用于证明范围一致）
function scopeVal(v) {
  const s = v == null ? '' : String(v).trim();
  return UNKNOWN_SCOPE_WORDS.has(s.toLowerCase()) ? null : s;
}
// 必须「两侧都明确且相同」的字段（缺失一律不可比）
function requiredScopeField(a, b) {
  const x = scopeVal(a), y = scopeVal(b);
  return x !== null && y !== null && x === y;
}
// 可缺省字段：两侧都缺失 = 一致；只有一侧缺失 = 不可比
function optionalScopeField(a, b) {
  const x = scopeVal(a), y = scopeVal(b);
  if (x === null && y === null) return true;
  return x !== null && y !== null && x === y;
}
function declaredCountOf(capability, s) {
  const pick = {
    shopify_catalog: s.count, public_site_products: s.productCount,
    public_reviews: s.reviewCount, youtube_content: s.videoCount,
    tiktok_commercial_content: s.creativeCount, dataforseo_trends: s.pointCount,
  }[capability];
  return typeof pick === 'number' ? pick : null;
}

function coverageProfile(attempt) {
  const a = attempt || {};
  const s = a.summary || {};
  const obs = Array.isArray(a.observations) ? a.observations : [];
  const pages = Number.isFinite(Number(s.successfullyFetchedPages)) ? Number(s.successfullyFetchedPages) : null;
  const reasons = Array.isArray(s.matchReasons) ? s.matchReasons.map(String).sort().join(',') : '';
  return {
    status: a.status || null,
    partialScan: s.partialScan === true,
    failedPage: s.failedPage || null,
    pages,
    discoveryPath: s.discoveryPath || null,
    method: s.measurementMethod || null,
    periodStart: s.periodStart || null,
    periodEnd: s.periodEnd || null,
    scope: s.countryScope || s.region || s.channelId || null,
    channelKey: reasons || null,
    keyword: s.keyword || null,
    declaredCount: declaredCountOf(a.capability, s),
    observedCount: obs.length,
    partialReason: s.partialScanReason || null,
  };
}

function isComplete(p) {
  return p.status === 'success' && !p.partialScan && !p.failedPage;
}

// 两次采集的「比较范围」是否一致；只要无法证明一致就返回 false（宁可不下结论）
function sameComparisonScope(prev, cur, capability) {
  if (capability === 'shopify_catalog') {
    // 目录接口本身就是全量口径：稳定身份由 product id 保证，无发现路径可选。
    // 币种口径另在价格比较处单独校验（SC-10 §二.3：全量目录也必须校验币种）。
    return true;
  }
  if (capability === 'public_site_products' || capability === 'official_site_products') {
    // 发现路径不同 = 抽到的样本集合不同（jsonld / sitemap / 首页内链）；
    // 任一侧缺失（旧数据）→ 不可比，绝不当成「都是 sitemap」。
    return requiredScopeField(prev.discoveryPath, cur.discoveryPath);
  }
  // 评论 / 社媒 / 广告 / 热度：测量方法必须先明确且一致（旧数据缺 method → 不可比）
  if (!requiredScopeField(prev.method, cur.method)) return false;
  // 周期：可双方缺省，但有一侧就必须一致
  if (!optionalScopeField(prev.periodStart, cur.periodStart)) return false;
  if (!optionalScopeField(prev.periodEnd, cur.periodEnd)) return false;
  // 渠道身份 / 查询市场：该能力的身份边界，缺失即不可证明「查的是同一个东西」
  //   · YouTube：频道身份（channelId）必须明确
  //   · TikTok 广告：投放国家/地区必须明确
  //   · 评论 / 搜索热度：无单一身份字段，渠道/地区/关键词任一方出现即必须双向一致
  if (capability === 'youtube_content' || capability === 'tiktok_commercial_content') {
    return requiredScopeField(prev.scope, cur.scope) && optionalScopeField(prev.keyword, cur.keyword);
  }
  return optionalScopeField(prev.scope, cur.scope)
    && optionalScopeField(prev.channelKey, cur.channelKey)
    && optionalScopeField(prev.keyword, cur.keyword);
}

// ---------- 单品可比性：币种 / 规格签名（SC-10 §二.3） ----------
// 全量目录（Shopify products.json）可以按稳定商品 ID 比较，但**必须同时校验币种口径**：
// 币种不同绝不换算、绝不比较；任一侧币种缺失也无法证明同口径 → 不可比。
function currencyComparable(oldC, newC) {
  const a = oldC == null || oldC === '' ? null : String(oldC).toUpperCase();
  const b = newC == null || newC === '' ? null : String(newC).toUpperCase();
  if (a === null && b === null) return true;   // 双方都无币种字段（非价格型观察）
  return a !== null && b !== null && a === b;
}
// 规格签名（变体数代理）：规格/包装构成变化 → 价格不可直接比较（沿用 lib/watch-price 语义）
function specComparable(oldS, newS) {
  const a = oldS == null || oldS === '' ? '' : String(oldS);
  const b = newS == null || newS === '' ? '' : String(newS);
  return a === b;
}

const SCOPE_LIMITED_NOTE = '（本次采集范围受限，只代表已抓取到的部分）';

// ---------- 纯计算：不做任何写库 ----------
// opts.purpose：monitoring 下「上新」必须有发布时间佐证（01 §17 / watch 整改 §8：
// Vantage 首次观察到 ≠ 来源证明的上市）；其余用途按观察事实记录。
function computeChanges(capability, prev, cur, opts) {
  const out = [];
  const o = opts || {};
  const purpose = String(o.purpose || '');
  const obs = (cur && Array.isArray(cur.observations)) ? cur.observations : [];
  const isProduct = capability === 'public_site_products' || capability === 'shopify_catalog' || capability === 'official_site_products';
  // 商品域没有观察就没有可比集合；评论/社媒的「0 条」本身是有意义的口径，不能被这条 guard 吞掉
  if (!prev || (isProduct && !obs.length)) return out;
  const prevP = coverageProfile(prev);
  const curP = coverageProfile(cur);
  const bothComplete = isComplete(prevP) && isComplete(curP);
  const scopeSame = sameComparisonScope(prevP, curP, capability);
  // 「确认不存在」的唯一允许条件
  const mayConcludeAbsence = bothComplete && scopeSame;
  const scopeLimited = !mayConcludeAbsence;

  if (isProduct) {
    const prevBy = new Map((prev.observations || []).map(o => [String(o.id || o.sourceUrl || ''), o]));
    const curBy = new Map(obs.map(o => [String(o.id || o.sourceUrl || ''), o]));
    for (const [id, c] of curBy) {
      const old = prevBy.get(id);
      if (!old) {
        // 本次真实观察到的新商品：即便范围受限也成立（它确实被抓到了）。
        // monitoring 额外要求发布时间佐证——否则只是「Vantage 首次观察到」。
        if (purpose === PURPOSE.MONITORING && !String(c.publishedAt || '')) continue;
        out.push({
          dimension: 'product', eventType: 'product_added', subjectId: id,
          title: `新增商品：${c.title || id}`,
          summary: `${c.title || id} 首次出现在公开商品页${scopeLimited ? SCOPE_LIMITED_NOTE : ''}`,
          change: { field: 'product', oldValue: null, newValue: c.title || id, basis: 'deterministic_diff', scopeLimited, publishedAt: c.publishedAt || null },
        });
        continue;
      }
      // 同币种 + 同规格签名才允许比较价格（SC-10 §二.3：绝不跨币种换算）
      const canComparePrice = currencyComparable(old.currency, c.currency) && specComparable(old.specSignature, c.specSignature);
      if (canComparePrice && typeof old.price === 'number' && typeof c.price === 'number' && old.price !== c.price) {
        // 同一稳定商品 ID 的两次真实观察：partial 也可比较
        out.push({
          dimension: 'price', eventType: 'price_changed', subjectId: id,
          title: `${c.title || id}：价格由 ${old.price} 调整为 ${c.price}`,
          summary: `${c.title || id} 价格 ${old.price} → ${c.price}${c.currency ? ' ' + c.currency : ''}${scopeLimited ? SCOPE_LIMITED_NOTE : ''}`,
          change: { field: 'price', oldValue: old.price, newValue: c.price, currency: c.currency || null, basis: 'deterministic_diff', scopeLimited },
        });
      }
      const boolOld = old.available === true || old.available === false;
      const boolCur = c.available === true || c.available === false;
      if (boolOld && boolCur && old.available !== c.available) {
        out.push({
          dimension: 'stock', eventType: 'stock_changed', subjectId: id,
          title: `${c.title || id}：${c.available ? '恢复在售' : '变为缺货'}`,
          summary: `${c.title || id} 在售状态 ${old.available ? '在售' : '缺货'} → ${c.available ? '在售' : '缺货'}${scopeLimited ? SCOPE_LIMITED_NOTE : ''}`,
          change: { field: 'availability', oldValue: old.available, newValue: c.available, basis: 'deterministic_diff', scopeLimited },
        });
      }
    }
    // 「没出现」只有在两次都完整且范围一致时才是「下架」
    if (mayConcludeAbsence) {
      for (const [id, old] of prevBy) {
        if (curBy.has(id)) continue;
        out.push({
          dimension: 'product', eventType: 'product_removed', subjectId: id,
          title: `商品下架：${old.title || id}`,
          summary: `${old.title || id} 不再出现在公开商品页`,
          change: { field: 'product', oldValue: old.title || id, newValue: null, basis: 'deterministic_diff', scopeLimited: false },
        });
      }
    }
    return out;
  }

  if (capability === 'public_reviews') {
    // 数量口径必须同源同查询范围；范围不一致 → 只保存观察，不做数量结论
    if (!scopeSame) return out;
    const p = prev.summary || {};
    const c = (cur && cur.summary) || {};
    const oldN = typeof p.reviewCount === 'number' ? p.reviewCount : null;
    const newN = typeof c.reviewCount === 'number' ? c.reviewCount : null;
    if (oldN != null && newN != null && oldN !== newN) {
      const decline = newN < oldN;
      if (decline && !bothComplete) return out; // 样本页变少 ≠ 评论变少
      const limited = decline ? false : scopeLimited;
      out.push({
        dimension: 'review', eventType: 'review_changed', subjectId: null,
        title: `公开评论数量变化：${oldN} → ${newN}`,
        summary: `公开评论页样本中的评论数量由 ${oldN} 变为 ${newN}（样本不等于全网口碑）${limited ? SCOPE_LIMITED_NOTE : ''}`,
        change: { field: 'reviewCount', oldValue: oldN, newValue: newN, basis: 'deterministic_diff', scopeLimited: limited },
      });
    }
    return out;
  }

  if (capability === 'youtube_content' || capability === 'tiktok_commercial_content') {
    if (!scopeSame) return out; // 渠道/查询范围变了 → 条数不可比
    const oldN = Array.isArray(prev.observations) ? prev.observations.length : 0;
    const newN = obs.length;
    if (oldN !== newN) {
      const decline = newN < oldN;
      if (decline && !bothComplete) return out; // 分页失败导致条数变少 ≠ 内容减少
      const limited = decline ? false : scopeLimited;
      out.push({
        dimension: 'social', eventType: 'social_changed', subjectId: null,
        title: `公开内容数量变化：${oldN} → ${newN}`,
        summary: `公开内容条数由 ${oldN} 变为 ${newN}${limited ? SCOPE_LIMITED_NOTE : ''}`,
        change: { field: 'contentCount', oldValue: oldN, newValue: newN, basis: 'deterministic_diff', scopeLimited: limited },
      });
    }
  }
  // 官网资料 / 搜索热度 / 广告：无可比结构化字段 → 不产出事件
  return out;
}

// ---------- 收件箱写入结果分类（唯一口径） ----------
//   recorded && verified → verified（允许提醒、允许前移基线）
//   recorded && pending  → pending（只计待核实）
//   DUPLICATE            → duplicate（不重复提醒、不重复计数）
//   其余                 → failed（不提醒、不计数、不前移基线）
function classifyInboxResult(rec) {
  if (rec && rec.recorded === true) return rec.verificationStatus === 'verified' ? 'verified' : 'pending';
  if (rec && rec.reason === 'DUPLICATE') return 'duplicate';
  return 'failed';
}

// ---------- 写库：按用途分流 ----------
// 返回 { purpose, changes, recorded, writtenTo, reason, results }
//   results: [{ eventType, subjectId, dimension, kind, change }] —— 调用方据此决定
//   提醒 / 是否前移基线；kind=failed 一律不得前移基线（SC-10 §一.7）
//   writtenTo: 'none' | 'brand_timeline' | 'intel_inbox'
function applyChanges(input) {
  const o = input || {};
  const purpose = String(o.collectionPurpose || '');
  const capability = String(o.capability || '');
  const attempt = o.attempt || null;
  const empty = (reason, results) => ({ purpose: purpose || null, changes: 0, recorded: 0, writtenTo: 'none', reason, results: results || [] });
  if (!PURPOSE_SET.has(purpose)) return empty('invalid_purpose');
  if (!attempt || (attempt.status !== 'success' && attempt.status !== 'partial')) return empty('not_success');
  const prev = o.previousAttempt || null;
  if (!prev) {
    // 首次观察：只建基线。三种用途都不写事件——首采是基线，手动刷新首次也是基线。
    return empty('baseline_only');
  }
  const changes = computeChanges(capability, prev, attempt, { purpose });
  if (!changes.length) return empty('no_changes');

  if (purpose === PURPOSE.FIRST_COLLECTION) {
    // 首采即使存在历史观察，也只建基线。收件箱只收正式监控窗口的变化。
    return Object.assign(empty('first_collection_baseline_only'), { changes: changes.length });
  }

  if (purpose === PURPOSE.MANUAL_REFRESH) {
    const written = writeBrandTimeline(o, capability, attempt, changes);
    return { purpose, changes: changes.length, recorded: written, writtenTo: 'brand_timeline', reason: written ? null : 'no_brand_link', results: changes.map(c => ({ eventType: c.eventType, subjectId: c.subjectId, dimension: c.dimension, kind: written ? 'recorded' : 'failed', change: c.change })) };
  }

  // monitoring：唯一允许写 intel_events 的用途
  const windowKey = String(o.windowKey || '');
  if (!windowKey) {
    return Object.assign(empty('window_key_required'), { changes: changes.length });
  }
  if (windowKey.startsWith('first_collection:')) {
    // 防御：首采批次号不是监控窗口，绝不能作为事件窗口来源
    return Object.assign(empty('invalid_window_key'), { changes: changes.length });
  }
  const { n, results } = writeIntelEvents(o, capability, attempt, changes, windowKey);
  return { purpose, changes: changes.length, recorded: n, writtenTo: 'intel_inbox', reason: n ? null : 'write_failed', results };
}

// 正式监控的**唯一**事件写入口（watch-monitor / 队列任务共用）：
// 校验 purpose=monitoring + 真实 windowKey，写入后返回 kind，调用方按 kind 决定后续动作。
function recordMonitoringEvent(input) {
  const o = input || {};
  const windowKey = String(o.windowKey || '');
  if (!windowKey || windowKey.startsWith('first_collection:')) {
    return { kind: 'failed', rec: { recorded: false, reason: 'INVALID_WINDOW_KEY' } };
  }
  let Inbox = null;
  try { Inbox = o.inboxFn || require('./intel-inbox.js'); } catch (e) { return { kind: 'failed', rec: { recorded: false, reason: 'INBOX_UNAVAILABLE' } }; }
  let rec;
  try {
    rec = Inbox.recordEvent({
      tenantId: o.tenantId, projectId: o.projectId, competitorId: o.competitorId,
      brandName: o.brandName || null,
      dimension: o.dimension, eventType: o.eventType,
      subjectId: o.subjectId || o.competitorId || null,
      title: o.title, summary: o.summary || o.title,
      observedAt: o.observedAt, effectiveAt: null,
      sourceKind: 'live_observation', origin: 'monitoring',
      change: o.change || null,
      evidenceRefs: o.evidenceRefs || [],
      verificationStatus: (o.evidenceRefs && o.evidenceRefs.length) ? 'verified' : 'pending',
      windowKey,
    });
  } catch (e) { rec = { recorded: false, reason: 'EXCEPTION' }; }
  return { kind: classifyInboxResult(rec), rec };
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
// 返回 { n, results }：results 逐条给出 kind，供调用方决定提醒与基线前移。
function writeIntelEvents(o, capability, attempt, changes, windowKey) {
  let Inbox = null;
  try { Inbox = o.inboxFn || require('./intel-inbox.js'); } catch (e) { return { n: 0, results: changes.map(c => ({ eventType: c.eventType, subjectId: c.subjectId, dimension: c.dimension, kind: 'failed', change: c.change })) }; }
  const observedAt = attempt.endedAt || attempt.startedAt || nowIso();
  const refs = [];
  for (const sid of (attempt.snapshotIds || []).slice(0, 3)) {
    refs.push({ snapshotId: sid, sourceUrl: o.sourceUrl || attempt.sourceUrl || null, observedAt });
  }
  let n = 0;
  const results = [];
  for (const c of changes.slice(0, 12)) {
    let kind = 'failed';
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
      kind = classifyInboxResult(r);
      if (r && r.recorded) n++;
    } catch (e) { /* 单条失败不影响其余 */ }
    results.push({ eventType: c.eventType, subjectId: c.subjectId, dimension: c.dimension, kind, change: c.change });
  }
  return { n, results };
}

module.exports = {
  PURPOSE, PURPOSES,
  previousComparable, computeChanges, applyChanges, recordMonitoringEvent, classifyInboxResult,
  // 可比范围（测试与审计用；纯函数，不写库）
  coverageProfile, isComplete, sameComparisonScope,
  currencyComparable, specComparable, scopeVal,
};
