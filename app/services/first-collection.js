'use strict';
// ============================================================
// services/first-collection.js —— SC-09 项目级自动首采批次
// ------------------------------------------------------------
// 目标：用户完成一次赛道调研后，**不需要逐个点击品牌**，系统自动为本项目全部
// 有效竞品建立一次首采计划，并把真实采集结果送到竞品数据库与品牌详情。
//
// 硬约束（SC-09 §二/§五 + r2 §一~§五）：
//   · 一个项目只有一条首采批次（UNIQUE(tenant_id, project_id)）；
//   · 同一品牌 × 同一能力只有一条 item（UNIQUE），入队走**显式代数幂等键**，
//     刷新/重复进入/服务重启都不会产生双任务或重复计费；
//   · item 只接受**属于自己**的 job_id / attempt_id 的结果（r2 §一）：
//     后续手动刷新、正式监控采集绝不改写首采 item / batch；
//   · 首采只建立初始观察基线，**不写每日情报收件箱**（Diff 职责已拆到
//     services/observation-diff.js，且首采用途只建基线）；
//   · 任务持久化（collection_jobs 队列），重启后 resumePending() 继续；
//   · 逐品牌 × 逐能力记录 queued/running/success/partial/empty/failed/
//     not_configured/out_of_coverage/cancelled；
//   · 单品牌/单来源失败不阻塞其它品牌（逐 item 独立推进）；
//   · 首采**绝不创建 WatchTarget**——正式监控只由用户明确「加入监控」触发；
//   · 不伪造数据：无凭据 → not_configured；来源不覆盖市场 → out_of_coverage；
//     真实检查无结果 → empty。三者严格区分，不写 0 条假数据；
//   · r2 §三：批次是**活的计划**——新增竞品/新增能力通过 reconcileBatchPlan
//     补齐 item；被移出项目的品牌转 cancelled，在途任务取消，历史保留审计。
// ============================================================

const fs = require('fs');
const CollectJobs = require('./collect-jobs.js');
const CollectReq = require('./collect-request.js');
const SurfaceStore = require('./surface-store.js');
const Registry = require('./capability-registry.js');
const Readiness = require('./source-readiness.js');
const TikTokAdLib = require('../lib/tiktok-adlib.js');

// item 状态（与任务书 §二 词表一致；r2 追加 cancelled = 品牌已移出项目，不是采集失败）
const ITEM_STATES = Object.freeze([
  'queued', 'running', 'success', 'partial', 'empty', 'failed', 'not_configured', 'out_of_coverage', 'cancelled',
]);
const TERMINAL = new Set(['success', 'partial', 'empty', 'failed', 'not_configured', 'out_of_coverage', 'cancelled']);
const TERMINAL_STATUS = new Set(['success', 'partial', 'failed']); // attempt 终态（running 之外）
// 允许「重新评估后自动恢复」的终态：只有这两类状态会随凭据/市场变化而改变
const RECOVERABLE = new Set(['not_configured', 'out_of_coverage']);

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

// 加法迁移：老库只有前 15 列。所有新列都有默认值，历史记录保持可读。
function ensureColumn(table, name, ddl) {
  const cols = db().prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (cols.includes(name)) return;
  try { db().exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`); } catch (e) { /* 并发迁移：已存在则忽略 */ }
}

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
  // r2 §三/§二 加法迁移
  ensureColumn('first_collection_items', 'in_scope', 'INTEGER NOT NULL DEFAULT 1');
  // 上次评估时的 readiness 状态（凭据恢复判定「状态是否发生变化」）
  ensureColumn('first_collection_items', 'readiness_state', 'TEXT');
  // 上次评估时的品牌市场（市场变化才重新评估广告来源覆盖）
  ensureColumn('first_collection_items', 'market_snapshot', 'TEXT');
  // 入队代数：每次真实入队 +1，幂等键 = fc:<batch>:<comp>:<cap>:g<N>（可审计、不撞旧 key）
  ensureColumn('first_collection_items', 'enqueue_generation', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('first_collection_items', 'cancel_reason', 'TEXT');
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
function loadProjectIntent(tenantId, projectId) {
  try {
    const { projFile } = require('../core/state-store.js');
    const st = JSON.parse(fs.readFileSync(projFile(String(projectId), String(tenantId)), 'utf8'));
    return (st && st.intent) || {};
  } catch (e) { return {}; }
}
// 品牌主要市场（与 collect-jobs.loadCompetitor 同口径：competitor.market → intent.regions[0]）
function marketOf(comp, intent) {
  const m = comp && comp.market != null ? String(comp.market) : '';
  if (m) return m;
  const region = intent && Array.isArray(intent.regions) ? intent.regions[0] : null;
  return region ? String(region) : '';
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
  if (capability === 'official_site_profile' || capability === 'public_site_products') {
    if (!/^https?:\/\//i.test(String(comp.url || ''))) {
      return { state: 'failed', failureText: '该品牌没有可核验的官网地址，无法采集公开页面。' };
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
function listItems(tenantId, projectId, competitorId, opts) {
  ensureTable();
  const o = opts || {};
  const scope = o.includeOutOfScope ? '' : ' AND in_scope=1';
  return competitorId
    ? db().prepare(`SELECT * FROM first_collection_items WHERE tenant_id=? AND project_id=? AND competitor_id=?${scope} ORDER BY capability`)
      .all(String(tenantId), String(projectId), String(competitorId))
    : db().prepare(`SELECT * FROM first_collection_items WHERE tenant_id=? AND project_id=?${scope} ORDER BY competitor_id, capability`)
      .all(String(tenantId), String(projectId));
}
function itemView(r) {
  if (!r) return null;
  return {
    capability: r.capability, state: r.state,
    competitorId: r.competitor_id, attemptId: r.attempt_id || null,
    resultCount: r.result_count == null ? null : Number(r.result_count),
    failureText: r.failure_text || null,
    inScope: r.in_scope ? true : false,
    cancelReason: r.cancel_reason || null,
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
    // 已有批次：**对账**计划（补齐新增品牌/新增能力、回收移出品牌、评估可恢复项），
    // 不重跑已成功项、不重试仍未配置/覆盖外的来源。重启/刷新都安全。
    reconcileBatchPlan(existing.batch_id);
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
    if (winner) { reconcileBatchPlan(winner.batch_id); return winner; }
    throw e;
  }
  reconcileBatchPlan(batchId); // 首次同样走同一套计划写入/入队逻辑
  return getBatch(tenantId, projectId);
}

// ---------- 计划对账（SC-09 r2 §三） ----------
// 每次进入 / 轮询 / 重启 / 凭据变化都调用；幂等，可并发（依赖 UNIQUE 约束）。
function reconcileBatchPlan(batchId) {
  ensureTable();
  const batch = db().prepare('SELECT * FROM first_collection_batches WHERE batch_id=?').get(String(batchId));
  if (!batch) return { ok: false, reason: 'NO_BATCH' };
  const tenantId = batch.tenant_id;
  const projectId = batch.project_id;
  const comps = loadCompetitors(tenantId, projectId);
  const intent = loadProjectIntent(tenantId, projectId);
  const byId = new Map(comps.map(c => [String(c.id), c]));
  const at = nowIso();

  const ins = db().prepare(`INSERT OR IGNORE INTO first_collection_items
    (item_id, batch_id, tenant_id, project_id, competitor_id, capability, state, failure_text,
     market_snapshot, readiness_state, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const items = db().prepare('SELECT * FROM first_collection_items WHERE batch_id=?').all(String(batchId));
  const byKey = new Map(items.map(it => [it.competitor_id + '|' + it.capability, it]));

  let added = 0, revived = 0;
  // ① 补齐：新增品牌 / Registry 新增能力 → 只补缺失 item，既有成功项一律不重跑
  for (const comp of comps) {
    for (const cap of plannedCapabilities(comp)) {
      const key = String(comp.id) + '|' + cap;
      const cur = byKey.get(key);
      if (!cur) {
        const prior = existingOutcome(tenantId, projectId, String(comp.id), cap);
        const init = prior || initialItemState(cap, comp);
        const res = ins.run(rid('fci'), batchId, tenantId, projectId, String(comp.id), cap,
          init.state, init.failureText || null, marketOf(comp, intent), readinessOf(cap), at, at);
        if (res && res.changes > 0) {
          added++;
          if (prior) {
            db().prepare(`UPDATE first_collection_items SET attempt_id=?, result_count=?, job_id=NULL
              WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=?`)
              .run(prior.attemptId || null, prior.resultCount == null ? null : prior.resultCount,
                tenantId, projectId, String(comp.id), cap);
          }
        }
      } else if (!cur.in_scope) {
        // 品牌被移出后又被加回：恢复在册，取消状态回到待评估（历史记录不删）
        db().prepare('UPDATE first_collection_items SET in_scope=1, state=?, cancel_reason=NULL, updated_at=? WHERE item_id=?')
          .run('queued', at, cur.item_id);
        cur.in_scope = 1; cur.state = 'queued';
        revived++;
      }
    }
  }

  // ② 回收：品牌已不在项目内 → 转 cancelled（不是失败），并取消其未执行任务
  let cancelled = 0;
  for (const it of items) {
    if (!it.in_scope) continue;
    if (byId.has(String(it.competitor_id))) continue;
    db().prepare('UPDATE first_collection_items SET in_scope=0, state=?, cancel_reason=?, job_id=NULL, updated_at=? WHERE item_id=?')
      .run('cancelled', 'brand_removed_from_project', at, it.item_id);
    cancelPendingJobs(it);
    cancelled++;
  }

  // ③ 重新评估可恢复项（凭据配置完成 / 品牌市场变化）
  const recovered = evaluateRecoverable(batchId);

  // ④ 统计与入队（只为 in_scope=1 且 state=queued 的 item 入队）
  const after = db().prepare('SELECT * FROM first_collection_items WHERE batch_id=?').all(String(batchId));
  const inScope = after.filter(x => x.in_scope);
  const totalBrands = new Set(inScope.map(x => x.competitor_id)).size;
  const totalItems = inScope.length;
  // 只在计划真的变化时写批次行 —— 幂等对账不得刷新「任何时间字段」
  if (Number(batch.total_brands) !== totalBrands || Number(batch.total_items) !== totalItems) {
    db().prepare('UPDATE first_collection_batches SET total_brands=?, total_items=?, updated_at=? WHERE batch_id=?')
      .run(totalBrands, totalItems, nowIso(), String(batchId));
  }
  const q = enqueueQueued(batchId);
  refreshBatch(batchId);
  return { ok: true, batchId, added, revived, cancelled, recovered, enqueued: q.enqueued, totalItems: inScope.length };
}

function readinessOf(capability) {
  try {
    const cap = Registry.getCapability(capability);
    if (!cap) return null;
    return Readiness.getReadiness(capability).state || null;
  } catch (e) { return null; }
}

// 取消该 item 尚未执行的任务（pending → done + 原因；不删历史行）
function cancelPendingJobs(item) {
  try {
    if (item.job_id) {
      db().prepare(`UPDATE collection_jobs SET status='done', done_at=?, last_error='brand_removed_from_project'
        WHERE job_id=? AND tenant_id=? AND status='pending'`)
        .run(nowIso(), String(item.job_id), String(item.tenant_id));
    }
    // 兜底：同 scope 的 pending 任务（可能由幂等/重排产生多个）一并取消
    db().prepare(`UPDATE collection_jobs SET status='done', done_at=?, last_error='brand_removed_from_project'
      WHERE tenant_id=? AND project_id=? AND competitor_id=? AND status='pending'`)
      .run(nowIso(), String(item.tenant_id), String(item.project_id), String(item.competitor_id));
  } catch (e) { /* 任务表不存在/已终态：忽略 */ }
}

// ---------- 可恢复项重新评估（SC-09 r2 §二） ----------
// 只处理 not_configured / out_of_coverage：
//   · readiness 从 not_configured 变为任何可请求状态 → queued（新代数幂等键入队）
//   · 品牌市场发生变化且新市场在覆盖内 → queued
//   · 状态没变化 → 一律不动（绝不重复入队、绝不请求外部服务）
function evaluateRecoverable(batchId) {
  ensureTable();
  const batch = db().prepare('SELECT * FROM first_collection_batches WHERE batch_id=?').get(String(batchId));
  if (!batch) return { evaluated: 0, queued: 0 };
  const comps = loadCompetitors(batch.tenant_id, batch.project_id);
  const intent = loadProjectIntent(batch.tenant_id, batch.project_id);
  const byId = new Map(comps.map(c => [String(c.id), c]));
  const items = db().prepare('SELECT * FROM first_collection_items WHERE batch_id=? AND in_scope=1').all(String(batchId));
  let evaluated = 0, queued = 0;
  for (const it of items) {
    if (!RECOVERABLE.has(it.state)) continue;
    const comp = byId.get(String(it.competitor_id));
    if (!comp) continue;
    evaluated++;
    const market = marketOf(comp, intent);
    const marketChanged = String(it.market_snapshot || '') !== String(market || '');
    const readiness = readinessOf(it.capability);
    const readinessChanged = !!it.readiness_state && String(it.readiness_state) !== String(readiness || '');
    if (marketChanged || readinessChanged) {
      const next = initialItemState(it.capability, Object.assign({}, comp, { market: market || comp.market }));
      db().prepare('UPDATE first_collection_items SET state=?, failure_text=?, market_snapshot=?, readiness_state=?, updated_at=? WHERE item_id=?')
        .run(next.state, next.failureText || null, market || null, readiness, nowIso(), it.item_id);
      if (next.state === 'queued') queued++;
    } else {
      // 只更新观测到的 readiness/市场快照，不改变状态、不入队
      db().prepare('UPDATE first_collection_items SET readiness_state=?, market_snapshot=? WHERE item_id=?')
        .run(readiness, market || null, it.item_id);
    }
  }
  return { evaluated, queued };
}

// ---------- 入队（显式代数幂等键；重复调用不产生双任务） ----------
function enqueueQueued(batchId) {
  ensureTable();
  const batch = db().prepare('SELECT * FROM first_collection_batches WHERE batch_id=?').get(String(batchId));
  if (!batch) return { enqueued: 0 };
  const comps = loadCompetitors(batch.tenant_id, batch.project_id);
  const byId = new Map(comps.map(c => [String(c.id), c]));
  const items = db().prepare("SELECT * FROM first_collection_items WHERE batch_id=? AND in_scope=1 AND state='queued'").all(String(batchId));
  let enqueued = 0;
  for (const it of items) {
    const comp = byId.get(String(it.competitor_id));
    if (!comp) continue; // 已由 reconcile 转 cancelled，不会到这里
    // 已有在途任务：不再创建第二个 attempt（重复轮询/重启对账都不能产生双任务）
    if (hasInFlightJob(it)) continue;
    if (enqueueOne(it, comp)) enqueued++;
  }
  return { enqueued };
}

function hasInFlightJob(item) {
  if (!item.job_id) return false;
  const job = db().prepare('SELECT status FROM collection_jobs WHERE job_id=?').get(String(item.job_id));
  return !!(job && (job.status === 'pending' || job.status === 'running'));
}

// 代数幂等键：fc:<batch>:<competitor>:<capability>:g<N>
// N 只增不减且落库可审计；旧的失败 attempt 不会因为 key 相同而被当成「本轮已跑」。
function enqueueOne(item, comp) {
  let gen = Number(item.enqueue_generation || 0);
  for (let attempt = 0; attempt < 3; attempt++) {
    gen += 1;
    const key = 'fc:' + item.batch_id + ':' + item.competitor_id + ':' + item.capability + ':g' + gen;
    let r = null;
    try {
      r = CollectReq.requestCollection({
        tenantId: item.tenant_id, projectId: item.project_id, competitorId: item.competitor_id,
        capability: item.capability, comp, trigger: 'schedule', tickNow: false,
        idempotencyKey: key, collectionPurpose: 'first_collection',
      });
    } catch (e) {
      setItemState(item.item_id, { state: 'failed', failureText: '采集任务创建失败，可稍后重试。' });
      return false;
    }
    const st = r && r.status;
    if (st === 'accepted') {
      db().prepare('UPDATE first_collection_items SET enqueue_generation=? WHERE item_id=?').run(gen, item.item_id);
      setItemState(item.item_id, {
        state: 'queued', jobId: r.jobId || (r.job && r.job.jobId) || null,
        attemptId: (r.attempt && r.attempt.attemptId) || null,
        readinessState: readinessOf(item.capability), marketSnapshot: marketSnapshotFor(item),
      });
      return true;
    }
    if (st === 'deduped') {
      const att = r.attempt || null;
      if (att && (att.status === 'success' || att.status === 'partial')) { applyAttempt(item, att); return false; }
      if (att && att.status === 'failed') continue; // 该代数键已被失败的 attempt 占用：换下一代
      if (att && att.status === 'running') {
        db().prepare('UPDATE first_collection_items SET enqueue_generation=? WHERE item_id=?').run(gen, item.item_id);
        setItemState(item.item_id, { state: 'running', jobId: r.jobId || null, attemptId: att.attemptId });
        return false;
      }
      setItemState(item.item_id, { state: 'running', jobId: r.jobId || null });
      return false;
    }
    if (st === 'not_configured') {
      setItemState(item.item_id, { state: 'not_configured', failureText: '数据服务暂不可用，稍后再试。', readinessState: readinessOf(item.capability) });
      return false;
    }
    if (st === 'quota') {
      setItemState(item.item_id, { state: 'failed', failureText: '今日采集次数已达上限，可稍后重试失败项。' });
      return false;
    }
    // not_supported / unknown_capability：不虚构执行
    setItemState(item.item_id, { state: 'not_configured', failureText: (r && r.message) || '该来源当前不可用。', readinessState: readinessOf(item.capability) });
    return false;
  }
  setItemState(item.item_id, { state: 'failed', failureText: '采集任务创建失败，可稍后重试。' });
  return false;
}

function marketSnapshotFor(item) {
  try {
    const comps = loadCompetitors(item.tenant_id, item.project_id);
    const comp = comps.find(c => String(c.id) === String(item.competitor_id));
    if (!comp) return null;
    return marketOf(comp, loadProjectIntent(item.tenant_id, item.project_id)) || null;
  } catch (e) { return null; }
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
  if (p.readinessState !== undefined) { sets.push('readiness_state=?'); vals.push(p.readinessState || null); }
  if (p.marketSnapshot !== undefined) { sets.push('market_snapshot=?'); vals.push(p.marketSnapshot || null); }
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

// ---------- 任务完成钩子（SC-09 r2 §一：六字段身份校验） ----------
// 只有「本次 job/attempt 就是该 item 自己的那次采集」才允许落账；
// 其余情况（手动刷新、正式监控、旧任务补发、终态后再通知）一律忽略，
// 不修改 item、batch 和任何时间字段，更不写收件箱。
function onJobFinished(job) {
  if (!job || !job.tenantId || !job.projectId || !job.competitorId || !job.capability) {
    return { ignored: true, reason: 'missing_context' };
  }
  ensureTable();
  const item = db().prepare('SELECT * FROM first_collection_items WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=?')
    .get(String(job.tenantId), String(job.projectId), String(job.competitorId), String(job.capability));
  if (!item) return { ignored: true, reason: 'not_first_collection_item' };
  // 六字段校验：tenant / project / competitor / capability 已由查询命中，
  // job_id 与 attempt_id 必须与 item 自己记录的一致。
  if (!item.job_id || !item.attempt_id) return { ignored: true, reason: 'item_has_no_active_job' };
  if (String(item.job_id) !== String(job.jobId || '') || String(item.attempt_id) !== String(job.attemptId || '')) {
    return { ignored: true, reason: 'job_identity_mismatch' };
  }
  if (!item.in_scope) return { ignored: true, reason: 'out_of_scope' };
  if (TERMINAL.has(item.state)) return { ignored: true, reason: 'item_terminal' };

  let att = null;
  try { att = SurfaceStore.getAttempt(job.tenantId, job.attemptId); } catch (e) { att = null; }
  if (!att || att.attemptId !== String(item.attempt_id)) return { ignored: true, reason: 'attempt_not_found' };
  const st = applyAttempt(item, att);
  // 首采只建基线：这里**不做任何变化检测**（Diff 已拆到 services/observation-diff.js，
  // 且首采用途只建基线，不写每日情报收件箱）。
  refreshBatch(item.batch_id);
  return { ignored: false, state: st, itemId: item.item_id, changes: { events: 0, reason: 'first_collection_baseline_only' } };
}

// ---------- 批次对账（重启/刷新/轮询共用） ----------
function refreshBatch(batchId) {
  ensureTable();
  const batch = db().prepare('SELECT * FROM first_collection_batches WHERE batch_id=?').get(String(batchId));
  if (!batch) return null;
  const items = db().prepare('SELECT * FROM first_collection_items WHERE batch_id=? AND in_scope=1').all(String(batchId));
  const comps = loadCompetitors(batch.tenant_id, batch.project_id);
  const byId = new Map(comps.map(c => [String(c.id), c]));

  for (const it of items) {
    if (TERMINAL.has(it.state)) continue;
    let att = null;
    if (it.attempt_id) { try { att = SurfaceStore.getAttempt(it.tenant_id, it.attempt_id); } catch (e) { att = null; } }
    if (att && TERMINAL_STATUS.has(att.status)) { applyAttempt(it, att); continue; }
    if (att && att.status === 'running') {
      // 有在途 attempt：确认 job 仍在跑；job 丢失（崩溃/清理）则把 attempt 如实落失败，
      // 并用新一代代数键重排——否则 item 会永远停在「采集中」。
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
      if (comp) enqueueOne(it, comp);
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
    // 没有任何 job/attempt（服务重启时入队中断）→ 用新一代键续跑
    const comp = byId.get(String(it.competitor_id));
    if (comp) enqueueOne(it, comp);
  }

  // 批次结论：执行状态与覆盖状态分开（见 summaryForProject）
  const after = db().prepare('SELECT * FROM first_collection_items WHERE batch_id=? AND in_scope=1').all(String(batchId));
  const pending = after.filter(x => !TERMINAL.has(x.state)).length;
  const failed = after.filter(x => x.state === 'failed').length;
  const notConfigured = after.filter(x => x.state === 'not_configured').length;
  const status = pending > 0 ? 'running' : ((failed > 0 || notConfigured > 0) ? 'partial' : 'complete');
  // 幂等：状态没变化就不写批次行（不刷新 updated_at/completed_at）
  const nextCompletedAt = pending > 0 ? null : (batch.completed_at || nowIso());
  if (String(batch.status) !== status || String(batch.completed_at || '') !== String(nextCompletedAt || '')) {
    db().prepare('UPDATE first_collection_batches SET status=?, updated_at=?, completed_at=? WHERE batch_id=?')
      .run(status, nowIso(), nextCompletedAt, String(batchId));
  }
  return getBatch(batch.tenant_id, batch.project_id);
}

// ---------- 项目级摘要（前端轮询 + 首页状态块） ----------
// r2 §四：**不**用一个 status 同时表达「任务是否结束」和「数据是否齐全」。
function summaryForProject(tenantId, projectId) {
  ensureTable();
  const batch = getBatch(tenantId, projectId);
  if (!batch) return null;
  const items = listItems(tenantId, projectId); // 只含 in_scope=1
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
  const failedCount = counts.failed;
  const notConfiguredCount = counts.not_configured;
  const outOfCoverageCount = counts.out_of_coverage;
  const pendingCount = items.filter(x => !TERMINAL.has(x.state)).length;

  // 执行状态：只看「任务是否都到终态」
  const executionStatus = pendingCount > 0 ? 'running' : 'complete';
  // 覆盖状态：failed 或当前仍未配置的来源 → partial；out_of_coverage 单独计数、不算失败
  const coverageStatus = (failedCount > 0 || notConfiguredCount > 0) ? 'partial' : 'complete';
  const recoverable = recoverableNotConfigured(items);
  const removed = db().prepare('SELECT COUNT(*) AS n FROM first_collection_items WHERE batch_id=? AND in_scope=0').get(batch.batch_id).n;

  return {
    batchId: batch.batch_id,
    executionStatus,
    coverageStatus,
    // 兼容字段（旧前端/旧报表）：status 由两者派生，不再单独表达语义
    status: executionStatus === 'running' ? 'running' : coverageStatus,
    startedAt: batch.created_at,
    completedAt: batch.completed_at || null,
    brandsTotal, brandsDone, brandsCollecting, brandsPartial, brandsNeedsAttention,
    failedCount, notConfiguredCount, outOfCoverageCount,
    removedBrandsCount: removed,
    items: counts,
    totalItems: items.length,
    canRetry: failedCount > 0 || recoverable > 0,
    recoverableCount: recoverable,
  };
}

// 当前「凭据已就绪、可以真正请求」的 not_configured 项数（按钮/文案用；不发请求）
function recoverableNotConfigured(items) {
  let n = 0;
  for (const it of items) {
    if (it.state !== 'not_configured') continue;
    const rd = readinessOf(it.capability);
    if (rd && rd !== 'not_configured') n++;
  }
  return n;
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
// r2 §二.7：可重试项 = failed + **已完成配置**的 not_configured。
// 仍未配置的 not_configured 绝不请求外部服务；out_of_coverage 不重试。
function retryFailed(tenantId, projectId) {
  ensureTable();
  const batch = getBatch(tenantId, projectId);
  if (!batch) return { retried: 0, reason: 'NO_BATCH' };
  const comps = loadCompetitors(tenantId, projectId);
  const byId = new Map(comps.map(c => [String(c.id), c]));
  const items = db().prepare("SELECT * FROM first_collection_items WHERE batch_id=? AND in_scope=1 AND state IN ('failed','not_configured')")
    .all(batch.batch_id);
  let retried = 0, skipped = 0;
  for (const it of items) {
    const comp = byId.get(String(it.competitor_id));
    if (!comp) { skipped++; continue; }
    if (it.state === 'not_configured') {
      const rd = readinessOf(it.capability);
      if (!rd || rd === 'not_configured') { skipped++; continue; } // 仍未配置：不请求
      // 市场类未配置（覆盖未知/无覆盖）也走同一判定：market 未变且仍不覆盖 → 不重试
      const mc = TikTokAdLib.marketCoverage(marketOf(comp, loadProjectIntent(tenantId, projectId)));
      if (it.capability === 'tiktok_commercial_content' && mc.coverageState === 'out_of_coverage') { skipped++; continue; }
    }
    setItemState(it.item_id, { state: 'queued', jobId: null, attemptId: null, failureText: null });
    const fresh = Object.assign({}, it, { state: 'queued' });
    if (enqueueOne(fresh, comp)) retried++;
  }
  refreshBatch(batch.batch_id);
  return { retried, skipped, batchId: batch.batch_id };
}

// ---------- 重启续跑 ----------
// 服务启动对账：**所有**批次都重新评估（凭据可能在停机期间补齐），不只 running。
function resumePending() {
  ensureTable();
  const batches = db().prepare('SELECT batch_id FROM first_collection_batches').all();
  let touched = 0;
  for (const b of batches) {
    try { reconcileBatchPlan(b.batch_id); touched++; } catch (e) { /* 单批失败不影响其它 */ }
  }
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
  onJobFinished, refreshBatch, resumePending, startWorker,
  reconcileBatchPlan, evaluateRecoverable,
  loadCompetitors, plannedCapabilities, initialItemState,
};
