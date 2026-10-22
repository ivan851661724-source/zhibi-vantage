'use strict';
// ============================================================
// services/first-collection.js —— SC-09 项目级自动首采批次
// ------------------------------------------------------------
// 目标：用户完成一次赛道调研后，**不需要逐个点击品牌**，系统自动为本项目全部
// 有效竞品建立一次首采计划，并把真实采集结果送到竞品数据库与品牌详情。
//
// 硬约束（任务书 §二/§五）：
//   · 一个项目只有一条首采批次（UNIQUE(tenant_id, project_id)）；
//   · 同一品牌 × 同一能力只有一条 item（UNIQUE），入队走显式幂等键，
//     刷新/重复进入/服务重启都不会产生双任务或重复计费；
//   · 任务持久化（collection_jobs 队列），重启后 resumePending() 继续；
//   · 逐品牌 × 逐能力记录 queued/running/success/partial/empty/failed/
//     not_configured/out_of_coverage；
//   · 单品牌/单来源失败不阻塞其它品牌（逐 item 独立推进）；
//   · 首采**绝不创建 WatchTarget**——正式监控只由用户明确「加入监控」触发；
//   · 不伪造数据：无凭据 → not_configured；来源不覆盖市场 → out_of_coverage；
//     真实检查无结果 → empty。三者严格区分，不写 0 条假数据。
// ============================================================

const fs = require('fs');
const CollectJobs = require('./collect-jobs.js');
const CollectReq = require('./collect-request.js');
const SurfaceStore = require('./surface-store.js');
const Registry = require('./capability-registry.js');
const Readiness = require('./source-readiness.js');
const TikTokAdLib = require('../lib/tiktok-adlib.js');

// item 状态（与任务书 §二 词表一致）
const ITEM_STATES = Object.freeze([
  'queued', 'running', 'success', 'partial', 'empty', 'failed', 'not_configured', 'out_of_coverage',
]);
const TERMINAL = new Set(['success', 'partial', 'empty', 'failed', 'not_configured', 'out_of_coverage']);
const TERMINAL_STATUS = new Set(['success', 'partial', 'failed']); // attempt 终态（running 之外）

// 首采能力顺序（任务书 §二）：官网 → 商品 → 评论 → 社媒 → 热度 → 广告
const CAP_ORDER = Object.freeze([
  'official_site_profile',
  'shopify_catalog',        // 与 public_site_products 二选一（按品牌渠道）
  'public_site_products',
  'public_reviews',
  'youtube_content',
  'dataforseo_trends',      // 搜索热度
  'tiktok_commercial_content', // 广告公开信息
]);

let _tableReady = false;
function db() { return CollectJobs.getDb(); }
function nowIso() { return new Date().toISOString(); }
function rid(p) { return p + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

function ensureTable() {
  if (_tableReady) return;
  const d = db();
  d.exec(`CREATE TABLE IF NOT EXISTS first_collection_batches (
    batch_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    total_brands INTEGER NOT NULL DEFAULT 0,
    total_items INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    UNIQUE(tenant_id, project_id)
  )`);
  d.exec(`CREATE TABLE IF NOT EXISTS first_collection_items (
    item_id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'queued',
    attempt_id TEXT,
    job_id TEXT,
    result_count INTEGER,
    failure_text TEXT,
    enqueued_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(tenant_id, project_id, competitor_id, capability)
  )`);
  d.exec('CREATE INDEX IF NOT EXISTS idx_fci_batch ON first_collection_items(batch_id, state)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_fcb_tenant ON first_collection_batches(tenant_id, status)');
  _tableReady = true;
}

// ---------- 项目竞品（与调研同一真源：项目状态文件） ----------
function loadCompetitors(tenantId, projectId) {
  try {
    const { projFile } = require('../core/state-store.js');
    const raw = fs.readFileSync(projFile(String(projectId), String(tenantId)), 'utf8');
    const st = JSON.parse(raw);
    return (Array.isArray(st.competitors) ? st.competitors : [])
      .filter(c => c && c.id && c.status === 'done');
  } catch (e) { return []; }
}

// ---------- 每个品牌的首采能力计划 ----------
function plannedCapabilities(comp) {
  const catalog = comp && comp.isShopify ? 'shopify_catalog' : 'public_site_products';
  return CAP_ORDER.filter(c => c !== 'shopify_catalog' && c !== 'public_site_products').concat([catalog]);
}

// 初始状态判定（不伪造）：真实不覆盖 → out_of_coverage；无凭据 → not_configured；
// 无官网 URL 的官方资料 → failed（如实原因）；其余进入 queued。
function initialItemState(capability, comp) {
  if (capability === 'tiktok_commercial_content') {
    const cov = TikTokAdLib.marketCoverage(comp.market);
    if (cov.coverageState === 'out_of_coverage') {
      return { state: 'out_of_coverage', failureText: TikTokAdLib.coverageNoteFor('out_of_coverage', cov.brandMarket) };
    }
    if (cov.coverageState === 'unknown') {
      return { state: 'not_configured', failureText: '品牌主要市场未确定，暂不判断该来源的覆盖范围；这不代表该市场没有广告。' };
    }
    // 覆盖内：仍需官方研究凭据
    const rd = Readiness.getReadiness(capability);
    if (rd && rd.state === 'not_configured') {
      return { state: 'not_configured', failureText: '数据服务暂不可用；该来源仅在官方支持国家提供公开广告信息。' };
    }
    return { state: 'queued' };
  }
  if (capability === 'official_site_profile') {
    if (!/^https?:\/\//i.test(String(comp.url || ''))) {
      return { state: 'failed', failureText: '该品牌没有可核验的官网地址，无法采集官网资料。' };
    }
    return { state: 'queued' };
  }
  if (capability === 'public_site_products') {
    if (!/^https?:\/\//i.test(String(comp.url || ''))) {
      return { state: 'failed', failureText: '该品牌没有可核验的官网地址，无法检查公开商品页。' };
    }
    return { state: 'queued' };
  }
  const capDef = Registry.getCapability(capability);
  if (capDef && capDef.maturity === 'pending_config') {
    const rd = Readiness.getReadiness(capability);
    if (rd && rd.state === 'not_configured') {
      return { state: 'not_configured', failureText: '数据服务暂不可用，稍后再试。' };
    }
  }
  return { state: 'queued' };
}

// 已有可用观察则不再重复首采（避免每次进入页面重复抓取/重复计费）：
// 直接把 item 落成既有真实结果，不新建任务。
function existingOutcome(tenantId, projectId, competitorId, capability) {
  try {
    const atts = SurfaceStore.listAttempts(tenantId, projectId, competitorId, capability, 5) || [];
    const usable = atts.find(a => a && (a.status === 'success' || a.status === 'partial'));
    if (!usable) return null;
    const n = Array.isArray(usable.observations) ? usable.observations.length : 0;
    const hasSummary = !!(usable.summary && Object.keys(usable.summary).length);
    const state = usable.status === 'partial' ? 'partial' : ((n > 0 || hasSummary) ? 'success' : 'empty');
    return { state, resultCount: n, attemptId: usable.attemptId, failureText: null };
  } catch (e) { return null; }
}

// ---------- 查询 ----------
function getBatch(tenantId, projectId) {
  ensureTable();
  return db().prepare('SELECT * FROM first_collection_batches WHERE tenant_id=? AND project_id=?')
    .get(String(tenantId || ''), String(projectId || '')) || null;
}
function listItems(tenantId, projectId, competitorId) {
  ensureTable();
  return competitorId
    ? db().prepare('SELECT * FROM first_collection_items WHERE tenant_id=? AND project_id=? AND competitor_id=? ORDER BY capability')
      .all(String(tenantId), String(projectId), String(competitorId))
    : db().prepare('SELECT * FROM first_collection_items WHERE tenant_id=? AND project_id=? ORDER BY competitor_id, capability')
      .all(String(tenantId), String(projectId));
}
function itemView(r) {
  if (!r) return null;
  return {
    capability: r.capability, state: r.state,
    competitorId: r.competitor_id, attemptId: r.attempt_id || null,
    resultCount: r.result_count == null ? null : Number(r.result_count),
    failureText: r.failure_text || null,
    updatedAt: r.updated_at,
  };
}

// ---------- 建批次（幂等：一个项目只有一条） ----------
function ensureBatch(input) {
  ensureTable();
  const tenantId = String((input || {}).tenantId || '');
  const projectId = String((input || {}).projectId || '');
  if (!tenantId || !projectId) return null;
  const existing = getBatch(tenantId, projectId);
  if (existing) {
    // 已有批次：只做对账（不做任何新计划），重启/刷新都安全
    refreshBatch(existing.batch_id);
    return getBatch(tenantId, projectId);
  }
  const comps = loadCompetitors(tenantId, projectId);
  if (!comps.length) return null; // 调研未产生竞品：不建空批次

  const batchId = rid('fcb');
  const at = nowIso();
  try {
    db().prepare(`INSERT INTO first_collection_batches
      (batch_id, tenant_id, project_id, status, total_brands, total_items, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(batchId, tenantId, projectId, 'running', comps.length, 0, at, at);
  } catch (e) {
    // 并发重复请求：UNIQUE 冲突 → 返回赢家的批次（绝不建第二条）
    const winner = getBatch(tenantId, projectId);
    if (winner) { refreshBatch(winner.batch_id); return winner; }
    throw e;
  }

  const ins = db().prepare(`INSERT OR IGNORE INTO first_collection_items
    (item_id, batch_id, tenant_id, project_id, competitor_id, capability, state, failure_text, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  let n = 0;
  for (const comp of comps) {
    for (const cap of plannedCapabilities(comp)) {
      // 已有可用观察 → 直接落既有结果（不重复采集）；否则按初始判定（queued/not_configured/...）
      const prior = existingOutcome(tenantId, projectId, String(comp.id), cap);
      const init = prior || initialItemState(cap, comp);
      const r = ins.run(rid('fci'), batchId, tenantId, projectId, String(comp.id), cap, init.state, init.failureText || null, at, at);
      if (r && r.changes > 0) {
        n++;
        if (prior) {
          db().prepare('UPDATE first_collection_items SET attempt_id=?, result_count=?, job_id=NULL WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=?')
            .run(prior.attemptId || null, prior.resultCount == null ? null : prior.resultCount, tenantId, projectId, String(comp.id), cap);
        }
      }
    }
  }
  db().prepare('UPDATE first_collection_batches SET total_items=?, updated_at=? WHERE batch_id=?').run(n, nowIso(), batchId);
  enqueueQueued(batchId);
  refreshBatch(batchId);
  return getBatch(tenantId, projectId);
}

// ---------- 入队（显式幂等键；重复调用不产生双任务） ----------
function enqueueQueued(batchId) {
  ensureTable();
  const batch = db().prepare('SELECT * FROM first_collection_batches WHERE batch_id=?').get(String(batchId));
  if (!batch) return { enqueued: 0 };
  const comps = loadCompetitors(batch.tenant_id, batch.project_id);
  const byId = new Map(comps.map(c => [String(c.id), c]));
  const items = db().prepare("SELECT * FROM first_collection_items WHERE batch_id=? AND state='queued'").all(String(batchId));
  let enqueued = 0;
  for (const it of items) {
    const comp = byId.get(String(it.competitor_id));
    if (!comp) {
      // 品牌已不在项目内（被删除/排除）：如实标记，不采集
      setItemState(it.item_id, { state: 'failed', failureText: '该品牌已不在本项目竞品列表中，未执行采集。' });
      continue;
    }
    if (enqueueOne(it, comp)) enqueued++;
  }
  return { enqueued };
}

function enqueueOne(item, comp) {
  const key = 'fc:' + item.batch_id + ':' + item.competitor_id + ':' + item.capability;
  let r = null;
  try {
    r = CollectReq.requestCollection({
      tenantId: item.tenant_id, projectId: item.project_id, competitorId: item.competitor_id,
      capability: item.capability, comp, trigger: 'schedule', tickNow: false, idempotencyKey: key,
    });
  } catch (e) {
    setItemState(item.item_id, { state: 'failed', failureText: '采集任务创建失败，可稍后重试。' });
    return false;
  }
  const st = r && r.status;
  if (st === 'accepted') {
    setItemState(item.item_id, { state: 'queued', jobId: r.jobId || (r.job && r.job.jobId) || null, attemptId: (r.attempt && r.attempt.attemptId) || null });
    return true;
  }
  if (st === 'deduped') {
    // 已有在途/近期尝试：不新建任务，按真实 attempt 状态落账
    const att = r.attempt || (r.jobId ? null : null);
    if (att) applyAttempt(item, att);
    else setItemState(item.item_id, { state: 'running', jobId: r.jobId || null });
    return false;
  }
  if (st === 'not_configured') {
    setItemState(item.item_id, { state: 'not_configured', failureText: '数据服务暂不可用，稍后再试。' });
    return false;
  }
  if (st === 'quota') {
    setItemState(item.item_id, { state: 'failed', failureText: '今日采集次数已达上限，可稍后重试失败项。' });
    return false;
  }
  // not_supported / unknown_capability：不虚构执行
  setItemState(item.item_id, { state: 'not_configured', failureText: (r && r.message) || '该来源当前不可用。' });
  return false;
}

// ---------- 状态落账 ----------
function setItemState(itemId, patch) {
  const p = patch || {};
  const sets = ['updated_at=?'];
  const vals = [nowIso()];
  if (p.state !== undefined) { sets.push('state=?'); vals.push(p.state); }
  if (p.attemptId !== undefined) { sets.push('attempt_id=?'); vals.push(p.attemptId || null); }
  if (p.jobId !== undefined) { sets.push('job_id=?'); vals.push(p.jobId || null); }
  if (p.resultCount !== undefined) { sets.push('result_count=?'); vals.push(p.resultCount == null ? null : Number(p.resultCount)); }
  if (p.failureText !== undefined) { sets.push('failure_text=?'); vals.push(p.failureText || null); }
  vals.push(String(itemId));
  db().prepare(`UPDATE first_collection_items SET ${sets.join(', ')} WHERE item_id=?`).run(...vals);
}

function stateFromAttempt(att) {
  if (!att) return { state: 'failed', failureText: '采集任务已结束但没有留下结果，可稍后重试。', resultCount: null };
  const obsCount = Array.isArray(att.observations) ? att.observations.length : 0;
  if (att.status === 'running') return { state: 'running', resultCount: null };
  if (att.status === 'partial') return { state: 'partial', resultCount: obsCount };
  if (att.status === 'success') {
    return obsCount > 0
      ? { state: 'success', resultCount: obsCount }
      : { state: 'empty', resultCount: 0 };
  }
  return { state: 'failed', failureText: att.errorUserText || '采集失败，可稍后重试。', resultCount: obsCount };
}

function applyAttempt(item, att) {
  const s = stateFromAttempt(att);
  setItemState(item.item_id, {
    state: s.state, attemptId: att ? att.attemptId : undefined,
    resultCount: s.resultCount, failureText: s.failureText === undefined ? null : s.failureText,
  });
  return s.state;
}

// ---------- 确定性变化检测（首次 = 基线，不产事件） ----------
// 只在「同一品牌 × 同一能力」存在**更早的可用观察**时比较；逐字段严格可比：
//   商品：同 id 的价格/库存（bool）变化、商品增减
//   评论：reviewCount / 页面数变化
//   内容：公开内容条数变化
// 不做：搜索热度估算变化、广告覆盖变化（非可比值，不写入收件箱）。
const CAP_LABEL = Object.freeze({
  official_site_profile: '官网资料', shopify_catalog: '商品目录', public_site_products: '官网商品',
  public_reviews: '公开评论', youtube_content: '公开内容', tiktok_commercial_content: '公开广告',
  dataforseo_trends: '搜索热度',
});

function prevUsableAttempt(item, att) {
  let all = [];
  try { all = SurfaceStore.listAttempts(item.tenant_id, item.project_id, item.competitor_id, item.capability, 10) || []; }
  catch (e) { all = []; }
  return all.find(a => a && a.attemptId !== (att && att.attemptId)
    && (a.status === 'success' || a.status === 'partial')
    && Array.isArray(a.observations) && a.observations.length > 0) || null;
}

function detectChanges(item, att) {
  if (!att || (att.status !== 'success' && att.status !== 'partial')) return { events: 0, reason: 'not_success' };
  const obs = Array.isArray(att.observations) ? att.observations : [];
  if (!obs.length) return { events: 0, reason: 'no_observations' };
  const prev = prevUsableAttempt(item, att);
  if (!prev) return { events: 0, reason: 'baseline_only' }; // 首次采集：只建基线

  const Inbox = require('./intel-inbox.js');
  const comp = (loadCompetitors(item.tenant_id, item.project_id).find(c => String(c.id) === String(item.competitor_id))) || {};
  const observedAt = att.endedAt || att.startedAt || nowIso();
  const refs = [];
  for (const sid of (att.snapshotIds || []).slice(0, 3)) refs.push({ snapshotId: sid, sourceUrl: att.sourceUrl || comp.url || null, observedAt });
  const base = {
    tenantId: item.tenant_id, projectId: item.project_id, competitorId: item.competitor_id,
    brandName: comp.name || null, observedAt, effectiveAt: null,
    sourceKind: 'live_observation', origin: 'monitoring',
    evidenceRefs: refs, verificationStatus: refs.length ? 'verified' : 'pending',
    windowKey: 'first_collection:' + item.batch_id,
  };
  const events = [];

  if (item.capability === 'public_site_products' || item.capability === 'shopify_catalog') {
    const prevBy = new Map((prev.observations || []).map(o => [String(o.id || o.sourceUrl || ''), o]));
    const curBy = new Map(obs.map(o => [String(o.id || o.sourceUrl || ''), o]));
    for (const [id, cur] of curBy) {
      const old = prevBy.get(id);
      if (!old) {
        events.push(Object.assign({}, base, {
          dimension: 'product', eventType: 'product_added', subjectId: id,
          title: `新增商品：${cur.title || id}`,
          summary: `${cur.title || id} 首次出现在公开商品页`,
          change: { field: 'product', oldValue: null, newValue: cur.title || id, basis: 'deterministic_diff' },
        }));
        continue;
      }
      if (typeof old.price === 'number' && typeof cur.price === 'number' && old.price !== cur.price) {
        events.push(Object.assign({}, base, {
          dimension: 'price', eventType: 'price_changed', subjectId: id,
          title: `${cur.title || id}：价格由 ${old.price} 调整为 ${cur.price}`,
          summary: `${cur.title || id} 价格 ${old.price} → ${cur.price}${cur.currency ? ' ' + cur.currency : ''}`,
          change: { field: 'price', oldValue: old.price, newValue: cur.price, currency: cur.currency || null, basis: 'deterministic_diff' },
        }));
      }
      if (old.available !== cur.available && (old.available === true || old.available === false) && (cur.available === true || cur.available === false)) {
        events.push(Object.assign({}, base, {
          dimension: 'stock', eventType: 'stock_changed', subjectId: id,
          title: `${cur.title || id}：${cur.available ? '恢复在售' : '变为缺货'}`,
          summary: `${cur.title || id} 在售状态 ${old.available ? '在售' : '缺货'} → ${cur.available ? '在售' : '缺货'}`,
          change: { field: 'availability', oldValue: old.available, newValue: cur.available, basis: 'deterministic_diff' },
        }));
      }
    }
    for (const [id, old] of prevBy) {
      if (curBy.has(id)) continue;
      events.push(Object.assign({}, base, {
        dimension: 'product', eventType: 'product_removed', subjectId: id,
        title: `商品下架：${old.title || id}`,
        summary: `${old.title || id} 不再出现在公开商品页`,
        change: { field: 'product', oldValue: old.title || id, newValue: null, basis: 'deterministic_diff' },
      }));
    }
  } else if (item.capability === 'public_reviews') {
    const p = prev.summary || {};
    const c = att.summary || {};
    const oldN = typeof p.reviewCount === 'number' ? p.reviewCount : null;
    const newN = typeof c.reviewCount === 'number' ? c.reviewCount : null;
    if (oldN != null && newN != null && oldN !== newN) {
      events.push(Object.assign({}, base, {
        dimension: 'review', eventType: 'review_changed', subjectId: item.competitor_id,
        title: `公开评论数量变化：${oldN} → ${newN}`,
        summary: `公开评论页样本中的评论数量由 ${oldN} 变为 ${newN}（样本不等于全网口碑）`,
        change: { field: 'reviewCount', oldValue: oldN, newValue: newN, basis: 'deterministic_diff' },
      }));
    }
  } else if (item.capability === 'youtube_content' || item.capability === 'tiktok_commercial_content') {
    const oldN = Array.isArray(prev.observations) ? prev.observations.length : 0;
    const newN = obs.length;
    if (oldN !== newN) {
      events.push(Object.assign({}, base, {
        dimension: 'social', eventType: 'social_changed', subjectId: item.competitor_id,
        title: `公开内容数量变化：${oldN} → ${newN}`,
        summary: `公开内容条数由 ${oldN} 变为 ${newN}`,
        change: { field: 'contentCount', oldValue: oldN, newValue: newN, basis: 'deterministic_diff' },
      }));
    }
  }
  // 官网资料 / 搜索热度 / 广告：无可比结构化字段 → 不写事件（保持收件箱只收确定性变化）

  let recorded = 0;
  for (const ev of events.slice(0, 12)) {
    try {
      const r = Inbox.recordEvent(ev);
      if (r && r.recorded) recorded++;
    } catch (e) { /* 单条写入失败不影响其余 */ }
  }
  return { events: recorded, compared: prev.attemptId };
}

// 采集任务完成（collect-jobs 钩子）：只更新对应 item，再刷新批次结论
function onJobFinished(job) {
  if (!job || !job.tenantId || !job.projectId || !job.competitorId || !job.capability) return null;
  ensureTable();
  const item = db().prepare('SELECT * FROM first_collection_items WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=?')
    .get(String(job.tenantId), String(job.projectId), String(job.competitorId), String(job.capability));
  if (!item) return null; // 非首采任务（用户手动刷新/监控窗口）
  let att = null;
  try { att = SurfaceStore.getAttempt(job.tenantId, job.attemptId); } catch (e) { att = null; }
  const st = applyAttempt(item, att);
  // SC-09 §四：**首次采集只建立基线**；已有历史可比观察时的后续采集才产生变化事件
  let changes = { events: 0, reason: 'not_comparable' };
  try { changes = detectChanges(item, att); } catch (e) { changes = { events: 0, reason: 'diff_failed' }; }
  refreshBatch(item.batch_id);
  return { state: st, itemId: item.item_id, changes };
}

// 续跑：优先用原幂等键（不重复计费）；若该键已被终态 attempt 占用（去重会直接返回旧结果），
// 则用代数键重新入队——保证「中断后可继续」，且同一时刻只有一个在途任务。
function requeueItem(item, comp) {
  const baseKey = 'fc:' + item.batch_id + ':' + item.competitor_id + ':' + item.capability;
  const genKey = baseKey + ':rr' + Date.now().toString(36);
  for (const key of [baseKey, genKey]) {
    let r = null;
    try {
      r = CollectReq.requestCollection({
        tenantId: item.tenant_id, projectId: item.project_id, competitorId: item.competitor_id,
        capability: item.capability, comp, trigger: 'schedule', tickNow: false, idempotencyKey: key,
      });
    } catch (e) { r = null; }
    if (!r) continue;
    if (r.status === 'accepted') {
      setItemState(item.item_id, { state: 'queued', jobId: r.jobId || null, attemptId: (r.attempt && r.attempt.attemptId) || null, failureText: null });
      return true;
    }
    if (r.status === 'deduped') {
      const att = r.attempt || null;
      // 旧键命中**成功**终态：这次观察已落过账，按真实结果落定，不再重跑
      if (att && (att.status === 'success' || att.status === 'partial')) { applyAttempt(item, att); return false; }
      // 旧键命中**失败**终态（上次被中断）：继续用代数键真正重试
      if (att && att.status === 'failed') continue;
      setItemState(item.item_id, { state: 'running', jobId: r.jobId || null, attemptId: (att && att.attemptId) || null });
      return false;
    }
    if (r.status === 'not_configured') { setItemState(item.item_id, { state: 'not_configured', failureText: '数据服务暂不可用，稍后再试。' }); return false; }
    if (r.status === 'quota') { setItemState(item.item_id, { state: 'failed', failureText: '今日采集次数已达上限，可稍后重试失败项。' }); return false; }
  }
  setItemState(item.item_id, { state: 'failed', failureText: '自动续跑未成功，可点「重新检查失败项」重试。' });
  return false;
}

// ---------- 批次对账（重启/刷新/轮询共用） ----------
function refreshBatch(batchId) {
  ensureTable();
  const batch = db().prepare('SELECT * FROM first_collection_batches WHERE batch_id=?').get(String(batchId));
  if (!batch) return null;
  const items = db().prepare('SELECT * FROM first_collection_items WHERE batch_id=?').all(String(batchId));
  const comps = loadCompetitors(batch.tenant_id, batch.project_id);
  const byId = new Map(comps.map(c => [String(c.id), c]));

  for (const it of items) {
    if (TERMINAL.has(it.state)) continue;
    let att = null;
    if (it.attempt_id) { try { att = SurfaceStore.getAttempt(it.tenant_id, it.attempt_id); } catch (e) { att = null; } }
    if (att && TERMINAL_STATUS.has(att.status)) { applyAttempt(it, att); continue; }
    if (att && att.status === 'running') {
      // 有在途 attempt：确认 job 仍在跑；job 丢失（崩溃/清理）则把 attempt 如实落失败，
      // 并用新代数键重排——否则 item 会永远停在「采集中」。
      const job = it.job_id ? db().prepare('SELECT status FROM collection_jobs WHERE job_id=?').get(String(it.job_id)) : null;
      if (job && (job.status === 'pending' || job.status === 'running')) { setItemState(it.item_id, { state: 'running' }); continue; }
      try {
        SurfaceStore.completeAttempt(it.tenant_id, att.attemptId, {
          status: 'failed', sourceStatus: 'internal_error', errorClass: 'internal_error',
          errorUserText: '上次采集被中断（服务重启或任务丢失），已重新安排。',
          observations: [], snapshotIds: att.snapshotIds || [], evidenceIds: [],
        }, null);
      } catch (e) { /* fenced/已终态：忽略，下面继续按计划重排 */ }
      const comp = byId.get(String(it.competitor_id));
      if (comp) requeueItem(it, comp);
      continue;
    }
    if (it.job_id) {
      const job = db().prepare('SELECT status, attempt_id FROM collection_jobs WHERE job_id=?').get(String(it.job_id));
      if (job && (job.status === 'done' || job.status === 'error' || job.status === 'dead')) {
        let a2 = null;
        try { a2 = SurfaceStore.getAttempt(it.tenant_id, job.attempt_id || it.attempt_id); } catch (e) { a2 = null; }
        applyAttempt(Object.assign({}, it, { attempt_id: a2 ? a2.attemptId : it.attempt_id }), a2);
        continue;
      }
      if (job && (job.status === 'pending' || job.status === 'running')) {
        setItemState(it.item_id, { state: job.status === 'running' ? 'running' : 'queued' });
        continue;
      }
      // job 已被清理：按 attempt 兜底
      if (att) { applyAttempt(it, att); continue; }
    }
    // 没有任何 job/attempt（服务重启时入队中断）→ 用同一幂等键续跑
    const comp = byId.get(String(it.competitor_id));
    if (comp) requeueItem(it, comp);
  }

  // 批次结论
  const after = db().prepare('SELECT * FROM first_collection_items WHERE batch_id=?').all(String(batchId));
  const pending = after.filter(x => !TERMINAL.has(x.state)).length;
  const failed = after.filter(x => x.state === 'failed').length;
  const status = pending > 0 ? 'running' : (failed > 0 ? 'partial' : 'complete');
  db().prepare('UPDATE first_collection_batches SET status=?, updated_at=?, completed_at=? WHERE batch_id=?')
    .run(status, nowIso(), status === 'running' ? null : nowIso(), String(batchId));
  return getBatch(batch.tenant_id, batch.project_id);
}

// ---------- 项目级摘要（前端轮询 + 首页状态块） ----------
function summaryForProject(tenantId, projectId) {
  ensureTable();
  const batch = getBatch(tenantId, projectId);
  if (!batch) return null;
  const items = listItems(tenantId, projectId);
  const byCompetitor = new Map();
  for (const it of items) {
    const k = String(it.competitor_id);
    if (!byCompetitor.has(k)) byCompetitor.set(k, []);
    byCompetitor.get(k).push(it.state);
  }
  const brandsTotal = byCompetitor.size;
  let brandsDone = 0, brandsCollecting = 0, brandsPartial = 0, brandsNeedsAttention = 0;
  for (const states of byCompetitor.values()) {
    const pending = states.filter(s => !TERMINAL.has(s)).length;
    if (pending) brandsCollecting++;
    else brandsDone++;
    if (states.some(s => s === 'failed')) brandsNeedsAttention++;
    else if (states.some(s => s === 'partial') || (states.some(s => s === 'success' || s === 'empty') && states.some(s => s === 'not_configured' || s === 'out_of_coverage'))) brandsPartial++;
  }
  const counts = {};
  for (const s of ITEM_STATES) counts[s] = items.filter(x => x.state === s).length;
  return {
    batchId: batch.batch_id,
    status: batch.status,             // running | complete | partial
    startedAt: batch.created_at,
    completedAt: batch.completed_at || null,
    brandsTotal, brandsDone, brandsCollecting, brandsPartial, brandsNeedsAttention,
    items: counts,
    totalItems: items.length,
    canRetry: counts.failed > 0,
  };
}

// 品牌级首采摘要（卡片用）：只读真实 item + attempt，不做推断
function brandSummary(tenantId, projectId, competitorId) {
  ensureTable();
  const items = listItems(tenantId, projectId, competitorId);
  if (!items.length) return null;
  const out = { items: {}, hasFailure: false, failureText: null, collecting: false };
  for (const it of items) {
    out.items[it.capability] = { state: it.state, resultCount: it.result_count == null ? null : Number(it.result_count) };
    if (it.state === 'failed') { out.hasFailure = true; if (!out.failureText && it.failure_text) out.failureText = it.failure_text; }
    if (it.state === 'queued' || it.state === 'running') out.collecting = true;
  }
  return out;
}

// ---------- 失败项重试（用户点「重新检查失败项」） ----------
function retryFailed(tenantId, projectId) {
  ensureTable();
  const batch = getBatch(tenantId, projectId);
  if (!batch) return { retried: 0, reason: 'NO_BATCH' };
  const items = db().prepare("SELECT * FROM first_collection_items WHERE batch_id=? AND state='failed'").all(batch.batch_id);
  let n = 0;
  for (const it of items) {
    // 清空在途指向，回到 queued；幂等键带代数，避免与旧 attempt 的冷却/去重撞车
    const gen = 'r' + Date.now().toString(36);
    setItemState(it.item_id, { state: 'queued', jobId: null, attemptId: null, failureText: null });
    const comps = loadCompetitors(tenantId, projectId);
    const comp = comps.find(c => String(c.id) === String(it.competitor_id));
    if (!comp) { setItemState(it.item_id, { state: 'failed', failureText: '该品牌已不在本项目竞品列表中。' }); continue; }
    const key = 'fc:' + it.batch_id + ':' + it.competitor_id + ':' + it.capability + ':' + gen;
    let r = null;
    try {
      r = CollectReq.requestCollection({
        tenantId, projectId, competitorId: it.competitor_id, capability: it.capability,
        comp, trigger: 'manual', tickNow: false, idempotencyKey: key,
      });
    } catch (e) { r = null; }
    if (r && (r.status === 'accepted' || r.status === 'deduped')) {
      setItemState(it.item_id, { state: 'queued', jobId: r.jobId || null, attemptId: (r.attempt && r.attempt.attemptId) || null });
      n++;
    } else {
      setItemState(it.item_id, { state: 'failed', failureText: (r && r.message) || '暂时无法重试，请稍后再试。' });
    }
  }
  refreshBatch(batch.batch_id);
  return { retried: n, batchId: batch.batch_id };
}

// ---------- 重启续跑 ----------
function resumePending() {
  ensureTable();
  const batches = db().prepare("SELECT batch_id FROM first_collection_batches WHERE status='running'").all();
  let touched = 0;
  for (const b of batches) { try { refreshBatch(b.batch_id); touched++; } catch (e) { /* 单批失败不影响其它 */ } }
  return { batches: touched };
}

let _timer = null;
function startWorker(options) {
  const opt = options || {};
  if (_timer) return _timer;
  if (process.env.ZB_FIRST_COLLECTION_DISABLED === '1') return null;
  const intervalMs = opt.intervalMs || 20000;
  const run = () => { try { resumePending(); } catch (e) { /* 下一轮继续 */ } };
  run();
  _timer = setInterval(run, intervalMs);
  if (_timer.unref) _timer.unref();
  return _timer;
}

module.exports = {
  ITEM_STATES, CAP_ORDER, ensureTable,
  ensureBatch, getBatch, listItems, itemView,
  summaryForProject, brandSummary, retryFailed,
  onJobFinished, refreshBatch, resumePending, startWorker, detectChanges,
  loadCompetitors, plannedCapabilities, initialItemState,
};
