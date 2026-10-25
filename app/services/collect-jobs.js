'use strict';
// ============================================================
// services/collect-jobs.js —— 数据面采集持久任务队列（SC-02 §6 整改轮）
// ------------------------------------------------------------
// 背景（独立审核 CHANGES REQUIRED §三.6）：进程内 fire-and-forget 不是正式
// 任务机制——重启即丢、僵尸 running 无恢复。本模块提供与 tasks.js 同口径的
// 持久化队列（SQLite + claimToken 租约 + heartbeat 续租 + reclaim 回收），
// 由 server.js 启动常驻 worker 消费：
//   enqueue → pending → claim(running, 租约60s) → heartbeat 续租 →
//   executor(adapter.collect) → finish(done/error) →（retry 或 dead）
// 崩溃语义：
//   · 进程被杀：job 留 running 但 claimExpiresAt 过期 → reclaimExpired 回
//     pending（断点续跑；对应 attempt 行不重开，collect 沿用 attempt_id）
//   · retry 耗尽：job → dead + 对应 attempt reconcile 落 failed/
//     internal_error（绝不遗留「尚未采集」假象——审核 §三.4）
//   · attempt running 但无活跃 job 且超 RUNNING_LEASE_MS → reconcile
// 租户隔离：全部读写显式 tenantId 过滤；worker 认领按 capability 维度。
// 隔离：ZB_DATA_DIR/data_surface.db 同库新表（collection_jobs），加法迁移。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const SurfaceStore = require('./surface-store.js');
const Registry = require('./capability-registry.js');
const Adapters = require('./source-adapter.js');

// SC-05：采集成功后追加写入 Competitive Memory。
// 🔴 只在「attempt 已落终态、Evidence/Snapshot 已齐备」之后调用——复用既有真值，
//    **不二次抓取、不生成第二份原始快照**。Memory 失败不影响采集结果（如实记日志）。
function memoryIngestAfterCollect(job, comp, raw, standardOut, fin) {
  try {
    if (!fin || !fin.attempt) return null;
    const status = fin.attempt.status;
    if (status !== 'success' && status !== 'partial') return null;
    const evIds = Array.isArray(fin.attempt.evidenceIds) ? fin.attempt.evidenceIds : [];
    const snapIds = Array.isArray(fin.attempt.snapshotIds) ? fin.attempt.snapshotIds : [];
    if (!evIds.length || !snapIds.length) return null; // 无证据不入已核实历史
    const r = raw || {};
    const so = standardOut || {};
    const items = Array.isArray(r.items) ? r.items : [];
    if (!items.length) return null;
    const summary = so.summary || (fin.attempt && fin.attempt.summary) || {};
    const Memory = require('./competitive-memory.js');
    const res = Memory.ingestCatalogObservation({
      tenantId: job.tenantId, projectId: job.projectId, competitorId: job.competitorId,
      domain: Memory.domainOf(comp && comp.url),
      brandName: (comp && comp.name) || null,
      items,
      summary,
      snapshotIds: snapIds,
      evidenceIds: evIds,
      observedAt: fin.attempt.endedAt || new Date().toISOString(),
      recordedAt: new Date().toISOString(),
      sourceKind: 'live_observation',
      timePrecision: 'captured_only',
      effectiveAt: null,
      parserVersion: so.parserVersion || (fin.attempt && fin.attempt.parserVersion) || Memory.MEMORY_PARSER_VERSION,
      sourceUrl: so.sourceUrl || r.url || null,
    });
    try {
      require('./logger.js').info('competitive_memory_ingest', {
        competitorId: job.competitorId, capability: job.capability,
        versions: res && res.versionsCreated, facts: res && res.factsCreated,
        events: res && res.eventsCreated, skipped: res && res.skipped ? res.reason : null,
      });
    } catch (e2) {}
    return res;
  } catch (e) {
    try { require('./logger.js').warn('competitive_memory_ingest_failed', { competitorId: job.competitorId, err: String(e && e.message || e).slice(0, 160) }); } catch (e2) {}
    return null;
  }
}

// CLAIM_TTL_MS：认领租期（heartbeat 每 25s 续租）。env ZB_COLLECT_CLAIM_TTL_MS
// 可覆盖（确定性进程测试缩短租约窗口；生产默认 60s）。
const CLAIM_TTL_MS = (() => {
  const n = Number(process.env.ZB_COLLECT_CLAIM_TTL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 60000;
})();
const HEARTBEAT_INTERVAL_MS = 25000;
const MAX_RETRY = 3;
// attempt 无对应活跃 job 的 running 宽限（采集总预算 30s  fetch + 4 页节流 ≈ 10s；10min 宽限）
const RUNNING_LEASE_MS = 10 * 60 * 1000;
const JOB_STATUSES = new Set(['pending', 'running', 'done', 'error', 'dead']);

let _db = null;
// 加法迁移（老库无此列时补上；并发启动时已存在则忽略）
function ensureColumn(db, table, name, ddl) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (cols.includes(name)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
  } catch (e) { /* 已存在 / 并发迁移：忽略 */ }
}
function getDb() {
  // 不缓存连接句柄：随 surface-store 连接重开（closeDb 后重启恢复语义，
  // 避免持有关闭句柄报 "database is not open"）；建表语句幂等。
  const db = SurfaceStore.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS collection_jobs (
    job_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    competitor_id TEXT NOT NULL,
    capability TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 1,
    retry INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT, claim_expires_at INTEGER, heartbeat_at INTEGER,
    created_at TEXT NOT NULL,
    done_at TEXT,
    last_error TEXT
  )`);
  // SC-09 r2 §一：采集用途必须随任务持久化——它决定变化能写到哪儿。
  // 绝不能靠 trigger 推断（自动首采同样用 schedule）。加法迁移，老库不受影响。
  ensureColumn(db, 'collection_jobs', 'collection_purpose', 'TEXT');
  ensureColumn(db, 'collection_jobs', 'window_key', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cj_claim ON collection_jobs(status, claim_expires_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_cj_scope ON collection_jobs(tenant_id, project_id, competitor_id, capability, status)');
  _db = db;
  return db;
}

function rid(p) { return p + '_' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex'); }
function nowIso() { return new Date().toISOString(); }
function rowToJob(r) {
  if (!r) return null;
  return {
    jobId: r.job_id, tenantId: r.tenant_id, projectId: r.project_id, competitorId: r.competitor_id,
    capability: r.capability, attemptId: r.attempt_id, trigger: r.trigger, status: r.status,
    priority: r.priority, retry: r.retry, attempts: r.attempts,
    claimToken: r.claim_token, claimExpiresAt: r.claim_expires_at, heartbeatAt: r.heartbeat_at,
    createdAt: r.created_at, doneAt: r.done_at, lastError: r.last_error,
    collectionPurpose: r.collection_purpose || null, windowKey: r.window_key || null,
  };
}
function assertStatus(s) {
  if (!JOB_STATUSES.has(s)) throw new Error('collect-jobs: invalid status: ' + String(s));
}

// 采集用途：显式声明优先；未声明时按 trigger 取**最保守**的默认值——
// 手动 → manual_refresh（只进品牌时间线），系统 → first_collection（只建基线）。
// 任何情况下都不会把「未声明用途」推断成 monitoring（否则自动首采会污染收件箱）。
const PURPOSES = new Set(['first_collection', 'manual_refresh', 'monitoring']);
function resolvePurpose(raw, trigger) {
  const p = String(raw || '');
  if (PURPOSES.has(p)) return p;
  return trigger === 'manual' ? 'manual_refresh' : 'first_collection';
}

// 入队（幂等：同 scope 已有 pending/running job → 复用，不双任务双费用）
function enqueue(input) {
  const db = getDb();
  const tid = String(input.tenantId || '');
  if (!tid) throw new Error('collect-jobs: tenantId required');
  const dup = db.prepare(`SELECT * FROM collection_jobs
    WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=? AND status IN ('pending','running')
    ORDER BY created_at DESC LIMIT 1`)
    .get(tid, String(input.projectId || ''), String(input.competitorId || ''), String(input.capability || ''));
  if (dup) return { jobId: dup.job_id, deduped: true, job: rowToJob(dup) };
  const id = rid('cj');
  const trigger = input.trigger === 'schedule' ? 'schedule' : 'manual';
  db.prepare(`INSERT INTO collection_jobs
    (job_id, tenant_id, project_id, competitor_id, capability, attempt_id, trigger, status, priority, created_at,
     collection_purpose, window_key)
    VALUES (?,?,?,?,?,?,?, 'pending', ?, ?, ?, ?)`)
    .run(id, tid, String(input.projectId || ''), String(input.competitorId || ''), String(input.capability || ''),
      String(input.attemptId || ''), trigger, Number(input.priority) || 1, nowIso(),
      resolvePurpose(input.collectionPurpose, trigger), input.windowKey ? String(input.windowKey) : null);
  return { jobId: id, deduped: false, job: rowToJob(getDb().prepare('SELECT * FROM collection_jobs WHERE job_id=?').get(id)) };
}

// 原子认领（RETURNING *：调用方需要完整 job 行，缺字段会让 retry 等判断静默失效）。
// 随机 claimToken：静态 token 会让「超时回收后原执行仍能 finish」。
function claim(workerId) {
  const token = 'ct_' + crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  const r = getDb().prepare(`UPDATE collection_jobs SET status='running', claim_token=?, claim_expires_at=?, heartbeat_at=?,
      attempts=attempts+1
    WHERE job_id = (SELECT job_id FROM collection_jobs
      WHERE status='pending' OR (status='running' AND claim_expires_at < ?)
      ORDER BY priority DESC, created_at ASC LIMIT 1)
    RETURNING *`).get(token, now + CLAIM_TTL_MS, now, now);
  return r ? rowToJob(r) : null;
}

function heartbeat(jobId, token, nowMs) {
  const t = nowMs || Date.now();
  const r = getDb().prepare(`UPDATE collection_jobs SET heartbeat_at=?, claim_expires_at=? WHERE job_id=? AND claim_token=?`)
    .run(t, t + CLAIM_TTL_MS, String(jobId || ''), String(token || ''));
  return r && r.changes > 0;
}

function finish(jobId, token, status, err) {
  const s = ['done', 'error', 'dead'].includes(status) ? status : 'error';
  const r = getDb().prepare(`UPDATE collection_jobs SET status=?, done_at=?, last_error=? WHERE job_id=? AND claim_token=?`)
    .run(s, nowIso(), err ? String(err).slice(0, 300) : null, String(jobId || ''), String(token || ''));
  return r && r.changes > 0;
}

// 回收：running 但租约过期 → pending（断点续跑）；retry 耗尽 → dead。
function reclaimExpired(nowMs, maxRetry) {
  const db = getDb();
  const t = nowMs || Date.now();
  const max = maxRetry == null ? MAX_RETRY : maxRetry;
  const expired = db.prepare(`SELECT job_id, retry FROM collection_jobs WHERE status='running' AND claim_expires_at < ?`).all(t);
  let requeued = 0;
  for (const row of expired) {
    if (row.retry >= max) {
      db.prepare(`UPDATE collection_jobs SET status='dead', done_at=?, last_error='retry_exhausted' WHERE job_id=?`).run(nowIso(), row.job_id);
    } else {
      db.prepare(`UPDATE collection_jobs SET status='pending', retry=retry+1, claim_token=NULL, claim_expires_at=NULL WHERE job_id=?`).run(row.job_id);
      requeued++;
    }
  }
  return { requeued, dead: expired.length - requeued };
}

// 弃管 attempt 对账：running 且超宽限、且无活跃 job 指向它（或 job 已终态）→
// 落 failed/internal_error。绝不保留永久 running（审核 §三.4：不得显示为「尚未采集」）。
function reconcileAbandoned(nowMs) {
  const db = getDb();
  const now = nowMs || Date.now();
  const cutoff = new Date(now - RUNNING_LEASE_MS).toISOString();
  const running = db.prepare(`SELECT * FROM collection_attempts WHERE status='running' AND started_at < ?`).all(cutoff);
  let reconciled = 0;
  for (const att of running) {
    const activeJob = db.prepare(`SELECT job_id FROM collection_jobs
      WHERE attempt_id=? AND status IN ('pending','running') LIMIT 1`).get(att.attempt_id);
    if (activeJob) continue; // 仍有主任务在管（心跳续租中），不是弃管
    try {
      SurfaceStore.completeAttempt(att.tenant_id, att.attempt_id, {
        status: 'failed', sourceStatus: 'internal_error', errorClass: 'internal_error',
        errorUserText: '上次采集被中断（服务重启或任务超时），可重新刷新。',
        observations: [], snapshotIds: JSON.parse(att.snapshot_ids || '[]'), evidenceIds: [],
      });
      reconciled++;
    } catch (e) { /* attempt 已终态（并发 reconcile）时显式拒绝，忽略 */ }
  }
  return { reconciled };
}

// ---------- executor（默认走 Registry→adapter 策略链；测试可注入替身） ----------
let executor = null; // (job) => Promise<outcome>，测试专用
function setExecutorForTest(fn) { executor = fn; }

// 从项目档案解析竞品（worker 脱离请求上下文，走持久档案）
// market 回退顺序与品牌读模型一致（brand-service 同步口径）：competitor.market → intent.regions[0]
// ——覆盖判定需要品牌主要市场；缺失时保持 null（adapter 侧记为 unknown，不替平台下结论）。
function loadCompetitor(job) {
  try {
    const { projFile } = require('../core/state-store.js');
    const f = projFile(job.projectId, job.tenantId);
    if (!f || !fs.existsSync(f)) return null;
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!st || !Array.isArray(st.competitors)) return null;
    const c = st.competitors.find(x => x && x.id === job.competitorId) || null;
    if (!c) return null;
    // SC-09 r3 §二：市场解析唯一入口（competitor.market → project intent.regions[0]）
    return require('../lib/brand-market.js').withResolvedMarket(c, st.intent || {});
  } catch (e) { return null; }
}

async function executeJob(job) {
  // 🔴 §五.1：执行前先读 attempt。attempt 已终态（上一任 worker 已完成、job finish
  // 前崩溃）→ 幂等完成，零外部请求、零重复费用。**先于测试 executor 分支**。
  const att0 = SurfaceStore.getAttempt(job.tenantId, job.attemptId);
  if (att0 && att0.status !== 'running') {
    finish(job.jobId, job.claimToken, 'done');
    return { deduped: true, attemptId: job.attemptId, reason: 'attempt_already_terminal', externalCalls: 0 };
  }
  if (executor) return executor(job);
  const cap = Registry.getCapability(job.capability);
  if (!cap) throw new Error('capability not in Registry: ' + job.capability);
  const chain = Adapters.resolveAdapterChain(job.capability);
  if (!chain.ok) throw new Error('adapter chain unresolved: ' + chain.reason);
  if (chain.strategy === 'fanout' && chain.chain.length > 1 && process.env.ZB_FANOUT_DEBUG === '1') console.error('[collect-jobs] fanout: full chain executes, first usable wins');
  const comp = loadCompetitor(job);
  if (!comp) throw new Error('competitor not resolvable from project archive: ' + job.competitorId);
  const fence = { jobId: job.jobId, token: job.claimToken }; // fencing 令牌贯穿 attempt 完成写入
  const baseCtx = {
    tenantId: job.tenantId, projectId: job.projectId, competitor: comp,
    trigger: job.trigger, attemptId: job.attemptId, fence,
  };
  const brandCtx = { url: comp.url || '', isShopify: !!comp.isShopify };

  // 🔴 复审 §二/§七：统一 provider-run 执行器。
  //   provider 运行（suppressTerminal=true）只产出结构化结果，**不写 attempt 终态、
  //   不升级 identity**；执行器是唯一终态写入者：
  //   · single/fallback：首个可用 provider → runProviderOutput（validate+Evidence）
  //     → commitProviderTerminal（终态+identity，fence 贯穿）；失败继续下一个；
  //   · fanout：全链真实执行（外部请求都发生），首个可用者为 winner，其余 discarded；
  //   · 链耗尽 → 唯一最终失败（fence 贯穿，错误分类取首个失败，文案无内部细节）。
  const runCtx = Object.assign({}, baseCtx, { suppressTerminal: true });
  const providerResults = []; // 每个真实执行的 provider 的结果（审计/测试断言）
  const executed = [];        // 真实发生外部调用的 provider（按执行序）

  const runOne = async (code) => {
    const adapter = Adapters.getAdapter(code);
    if (!adapter) { providerResults.push({ code, skipped: true, reason: 'not_registered' }); return { skipped: true }; }
    let chk = { supported: true };
    try { chk = adapter.supports ? adapter.supports(brandCtx) : chk; } catch (e) { chk = { supported: true }; }
    if (chk && chk.supported === false) { providerResults.push({ code, skipped: true, reason: chk.reasonCode || 'unsupported' }); return { skipped: true }; }
    let r = null;
    // 🔴 SC-06 r2（评审 §三.3）：超时必须真正取消底层请求，不能只让 Promise.race 返回。
    // AbortController 贯穿 adapter.collect → Net.fetchPage → safeRequestOnce(req.destroy)：
    // 超时先 abort（网络请求被真正打断、socket 释放），再落终态；否则底层请求永久悬挂，
    // worker 表面恢复、连接和字节流仍在漏。
    const ctrl = new AbortController();
    const providerCtx = Object.assign({}, runCtx, { signal: ctrl.signal });
    const COLLECT_TIMEOUT_MS = Number(process.env.ZB_COLLECT_TIMEOUT_MS) || 10 * 60 * 1000;
    let timer = null;
    let timedOut = false;
    try {
      r = await Promise.race([
        adapter.collect(providerCtx),
        new Promise((_, rej) => {
          timer = setTimeout(() => {
            timedOut = true;
            try { ctrl.abort(new Error('collect_timeout')); } catch (e2) { /* abort 自身失败不改变结论 */ }
            rej(new Error('collect_timeout'));
          }, COLLECT_TIMEOUT_MS);
        }),
      ]).finally(() => { if (timer) clearTimeout(timer); });
    } catch (e) {
      if (e && e.fenced) return { fenced: true };
      executed.push(code);
      if (timedOut || String(e && e.message || e) === 'collect_timeout') {
        // 超时 → 如实按 timeout 分类落终态（不伪装成功、不写成「没数据」）
        providerResults.push({ code, failed: true, errorClass: 'timeout', error: 'collect_timeout', aborted: true });
        return { providerFailed: true, aborted: true };
      }
      providerResults.push({ code, failed: true, error: String(e && e.message || e).slice(0, 120) });
      return { providerFailed: true };
    }
    executed.push(code);
    if (r && r.fenced) return { fenced: true };
    if (r && r.deduped) return { final: Object.assign({ adapterCode: code }, r) };
    if (r && r.providerFailed) {
      providerResults.push({ code, failed: true, errorClass: r.errorClass || r.cls || 'unavailable' });
      return { providerFailed: true };
    }
    if (r && r.providerOk && r.empty) {
      return { empty: r }; // 执行器落零观察终态（commitProviderEmpty）
    }
    if (r && r.providerOk) return { usable: r }; // 执行器 validate+Evidence+终态
    // 兼容老式返回（测试替身自带终态写入，如 D27 fake_b）
    if (r && r.attempt && r.attempt.status && r.attempt.status !== 'running' && r.attempt.status !== 'failed') {
      return { final: Object.assign({ adapterCode: code, legacyProvider: true }, r) };
    }
    if (r && r.attempt && r.attempt.status === 'failed') {
      providerResults.push({ code, failed: true, errorClass: r.attempt.sourceStatus || 'unavailable' });
      return { providerFailed: true };
    }
    providerResults.push({ code, failed: true, error: 'unrecognized provider result' });
    return { providerFailed: true };
  };

  // 可用 provider → validate + Evidence + 终态 + identity（fence 贯穿）
  const commitUsable = async (code, r) => {
    const run = await Adapters.runProviderOutput(baseCtx, r.raw, r.out);
    if (run.providerFailed) {
      providerResults.push({ code, failed: true, errorClass: run.errorClass, invalidErrors: run.invalidErrors, evidenceError: run.evidenceError });
      return null; // 视为该 provider 失败，链可继续
    }
    const fin = await Adapters.commitProviderTerminal(baseCtx, run, r.out, r.ident);
    // SC-05：终态 + Evidence 落账之后写入 Competitive Memory（复用本次快照，不重抓）
    let memory = null;
    if (fin && fin.attempt && (fin.attempt.status === 'success' || fin.attempt.status === 'partial')
      && job.capability === 'shopify_catalog') {
      memory = memoryIngestAfterCollect(job, comp, r.raw, r.out, fin);
    }
    return Object.assign({ adapterCode: code, providerResults, externalCalls: executed.length, memory }, fin);
  };

  if (chain.strategy === 'fanout') {
    let winner = null;
    for (const code of chain.chain) {
      const out = await runOne(code);
      if (out && out.fenced) return { fenced: true, adapterCode: code, providerResults };
      if (out && out.final) return Object.assign(out.final, { fanout: true, providerResults, externalCalls: executed.length });
      if (out && out.empty) {
        if (winner) { providerResults.push({ code, discarded: true, reason: 'fanout_first_usable_wins' }); continue; }
        const fin = Adapters.commitProviderEmpty(baseCtx, out.empty);
        return Object.assign(fin, { adapterCode: code, providerResults, externalCalls: executed.length, fanout: true });
      }
      if (out && out.usable) {
        if (winner) { providerResults.push({ code, discarded: true, reason: 'fanout_first_usable_wins' }); continue; }
        winner = { code, r: out.usable };
      }
    }
    if (winner) {
      const fin = await commitUsable(winner.code, winner.r);
      if (fin) return Object.assign(fin, { fanout: true });
    }
  } else {
    // single / fallback：首个可用者胜出，失败沿链继续
    for (const code of chain.chain) {
      const out = await runOne(code);
      if (out && out.fenced) return { fenced: true, adapterCode: code, providerResults };
      if (out && out.final) return Object.assign(out.final, { providerResults, externalCalls: executed.length });
      if (out && out.empty) {
        const fin = Adapters.commitProviderEmpty(baseCtx, out.empty);
        return Object.assign(fin, { adapterCode: code, providerResults, externalCalls: executed.length });
      }
      if (out && out.usable) {
        const fin = await commitUsable(code, out.usable);
        if (fin) return fin;
      }
    }
  }

  // 链耗尽：唯一最终失败（§二.3——只产生一个可解释的最终失败）
  const firstFail = providerResults.find(p => p.failed);
  const errorClass = (firstFail && firstFail.errorClass) || 'unavailable';
  // 🔴 SC-11 测试服真实复现 P0：errorClass（内部分类词表，含 adapter_output_invalid 等
  // 非 05 §11 值）与 sourceStatus（05 §11 冻结八值）是两套词表。旧代码把 errorClass
  // 直接当 sourceStatus 传入 → completeAttempt 抛 invalid source_status → 外层 catch
  // 把真实失败分类抹成 internal_error（测试服 37 个 public_reviews job 全部中招，
  // 用户看到「采集时发生内部问题」而不是真实成因）。
  // 归一规则：errorClass 本身是合法 sourceStatus 时原样使用；否则归 internal_error
  // （采集管线故障，不是来源侧故障，不冤枉来源）——与 source-adapter.js
  // finalizeOutput 校验失败分支同口径（sourceStatus:'internal_error' +
  // errorClass:'adapter_output_invalid'）。
  const sourceStatus = SurfaceStore.SOURCE_STATUSES.has(errorClass) ? errorClass : 'internal_error';
  const done = SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
    status: 'failed', sourceStatus, errorClass,
    errorUserText: Adapters.FAILURE_TEXT[errorClass] || Adapters.FAILURE_TEXT.unavailable,
    observations: [], snapshotIds: [], evidenceIds: [],
  }, fence);
  // 链耗尽可观测性：首个失败的精确分类 + 完整性校验错误（无内部细节外泄，仅运维日志）
  try {
    require('./logger.js').error('data_surface_chain_exhausted', {
      jobId: job.jobId, capability: job.capability, competitorId: job.competitorId,
      errorClass, sourceStatus,
      invalidErrors: ((firstFail && firstFail.invalidErrors) || []).slice(0, 5),
    });
  } catch (e) { /* 日志失败不影响终态落账 */ }
  return { attempt: done, providerResults, externalCalls: executed.length, chainExhausted: true, strategy: chain.strategy };
}

// SC-07 r3 P0-2 / SC-08 r2 §一：来源探测（商品页 或 官网资料）结束后推进该品牌的监控意向。
// 两个能力都必须接线：意向的分阶段流程会先调商品探测，无可比价格后调官网探测；
// 只接商品探测会让官网阶段永远等不到推进（这正是 r1 的真实缺陷）。
// 成功路径与 executor 异常路径都必须调用——否则异常任务结束后意向既无进行中 job、
// 又无未来 next_probe_at，会永久停在「正在建立」。
const INTENT_PROBE_CAPABILITIES = new Set(['public_site_products', 'official_site_profile']);
function notifyWatchIntent(job) {
  try {
    if (!job || !INTENT_PROBE_CAPABILITIES.has(job.capability)) return null;
    const att = SurfaceStore.getAttempt(job.tenantId, job.attemptId);
    const WIntent = require('./watch-intent.js');
    const out = WIntent.onProbeFinished({
      tenantId: job.tenantId, projectId: job.projectId, competitorId: job.competitorId,
      attempt: att,
    });
    // SC-08 r2 §二：这次真实探测也可能让「已有 site_change 正式监控」的价格资格刚刚满足
    //（受控升级：资格从库里真实 attempt 派生，验证不通过不动）。
    try { WIntent.tryUpgradeTargetToPrice({ tenantId: job.tenantId, projectId: job.projectId, competitorId: job.competitorId }); } catch (e2) { /* 升级失败不影响采集 */ }
    return out;
  } catch (e) { return null; } // 意向推进失败不影响采集结果（由调度器自愈兜底）
}

// SC-09：首采批次推进钩子（异常安全：批次推进失败绝不影响采集本身）
function notifyFirstCollection(job) {
  try {
    return require('./first-collection.js').onJobFinished(job);
  } catch (e) { return null; }
}

// SC-09 r2 §一.9/§一.10：变化检测收口到 services/observation-diff.js，
// 且**必须**显式带 collectionPurpose：
//   · first_collection → 只建基线，什么都不写（首采不是变化来源）
//   · manual_refresh   → 只写品牌时间线，绝不进每日情报收件箱
//   · monitoring       → 唯一允许写 intel_events 的用途，且必须有真实窗口键
// 这里是「任务执行完之后」的唯一接线点，任何用途都不会绕过这个判定。
function notifyObservationDiff(job) {
  try {
    const purpose = resolvePurpose(job && job.collectionPurpose, job && job.trigger);
    if (purpose === 'first_collection') return { purpose, recorded: 0, reason: 'first_collection_baseline_only' };
    const att = SurfaceStore.getAttempt(job.tenantId, job.attemptId);
    if (!att || (att.status !== 'success' && att.status !== 'partial')) return { purpose, recorded: 0, reason: 'not_success' };
    const Diff = require('./observation-diff.js');
    const prev = Diff.previousComparable(job.tenantId, job.projectId, job.competitorId, job.capability, att.attemptId);
    const comp = loadCompetitor(job);
    return Diff.applyChanges({
      tenantId: job.tenantId, projectId: job.projectId, competitorId: job.competitorId,
      capability: job.capability, attempt: att, previousAttempt: prev,
      collectionPurpose: purpose, windowKey: job.windowKey || null,
      brandName: (comp && comp.name) || null, sourceUrl: att.sourceUrl || (comp && comp.url) || null,
    });
  } catch (e) {
    return null; // 变化检测失败不影响采集结果本身
  }
}

// SC-09 r3 §一：统一取消——job 与 attempt 必须同时进入终态，绝不留下
// 「无有效 job 对应的 running attempt」（r2 的缺陷：只把 job 改 done，attempt 仍 running）。
//
// 竞态处理（§一.6）：
//   · job 用 CAS：只在「当前 status 与 claim_token 都仍是刚读到的值」时改写——
//     错误 claimToken / 已被 worker finish 的任务都不可能被这里覆盖；
//   · attempt 只在 status='running' 时终结，已完成（终态不可变，00 §56.2）绝不覆盖；
//   · 已 running 的任务由执行前 fencing 拦截（tick 里 isCancelledScope → 本函数）。
//
// 状态词表（05 §11 冻结，本轮不新增枚举）：attempt 没有 cancelled 状态，因此复用
// 合法失败状态 failed + source_status=internal_error（系统侧取消，不是来源侧故障），
// 用户可见原因由 error_user_text 承载：「品牌已移出项目，采集已取消。」
// 绝不写成 unavailable / blocked（那等于冤枉来源）。
const CANCEL_TEXT = '品牌已移出项目，采集已取消。';
function cancelCollectionJobAndAttempt(input) {
  const o = input || {};
  const tid = String(o.tenantId || '');
  const jobId = String(o.jobId || '');
  const attemptId = String(o.attemptId || '');
  const reasonCode = String(o.reasonCode || 'brand_removed_from_project');
  const userText = String(o.userText || CANCEL_TEXT);
  const out = { jobCancelled: false, attemptCancelled: false, jobStatus: null, attemptStatus: null };
  if (!tid) return out;
  const db = getDb();

  if (jobId) {
    const job = db.prepare('SELECT status, claim_token FROM collection_jobs WHERE job_id=? AND tenant_id=?').get(jobId, tid);
    if (job && !['done', 'error', 'dead'].includes(job.status)) {
      const r = db.prepare(`UPDATE collection_jobs SET status='done', done_at=?, last_error=?
        WHERE job_id=? AND tenant_id=? AND status=? AND IFNULL(claim_token,'')=?`)
        .run(nowIso(), reasonCode, jobId, tid, job.status, String(job.claim_token || ''));
      out.jobCancelled = r.changes > 0;
    }
    const a1 = db.prepare('SELECT status FROM collection_jobs WHERE job_id=? AND tenant_id=?').get(jobId, tid);
    out.jobStatus = a1 ? a1.status : null;
  }

  if (attemptId) {
    const att = db.prepare('SELECT status, snapshot_ids FROM collection_attempts WHERE attempt_id=? AND tenant_id=?')
      .get(attemptId, tid);
    if (att && att.status === 'running') {
      let snapshots = [];
      try { snapshots = JSON.parse(att.snapshot_ids || '[]'); } catch (e) { snapshots = []; }
      try {
        SurfaceStore.completeAttempt(tid, attemptId, {
          status: 'failed', sourceStatus: 'internal_error', errorClass: 'cancelled_scope',
          errorUserText: userText, observations: [], snapshotIds: snapshots, evidenceIds: [],
        });
        out.attemptCancelled = true;
      } catch (e) { out.attemptError = String((e && e.message) || e).slice(0, 160); }
    }
    const a2 = db.prepare('SELECT status FROM collection_attempts WHERE attempt_id=? AND tenant_id=?').get(attemptId, tid);
    out.attemptStatus = a2 ? a2.status : null;
  }
  return out;
}

// 品牌被移出项目（SC-10 r2 §四）：把该品牌在本项目全部未终结任务**双终结**。
// 与首采 cancelPendingJobs 同一口径：job → done + last_error=reasonCode；
// attempt → failed + cancelled_scope + 用户文案。不删历史行、不产事件、不发提醒。
// 覆盖首采 / 手动刷新 / 监控等一切来源的 pending+running 任务（按竞品维度，不按能力）。
function cancelCompetitorJobs(tenantId, projectId, competitorId, reasonCode) {
  const tid = String(tenantId || ''), pid = String(projectId || ''), cid = String(competitorId || '');
  if (!tid || !pid || !cid) return { cancelled: 0 };
  let rows = [];
  try {
    rows = getDb().prepare(`SELECT job_id, attempt_id FROM collection_jobs
      WHERE tenant_id=? AND project_id=? AND competitor_id=? AND status IN ('pending','running')`)
      .all(tid, pid, cid);
  } catch (e) { return { cancelled: 0 }; }
  let cancelled = 0;
  for (const r of rows) {
    try {
      cancelCollectionJobAndAttempt({ tenantId: tid, jobId: r.job_id, attemptId: r.attempt_id, reasonCode: reasonCode || 'brand_removed_from_project' });
      cancelled++;
    } catch (e) { /* 单条失败不影响其余；下轮 reconcile 兜底 */ }
  }
  return { cancelled };
}

// 该任务是否属于「已被移出项目」的首采 item（返回取消上下文，供 tick 统一取消）
function cancelledScopeOf(job) {
  try {
    const row = getDb().prepare(`SELECT in_scope, item_id FROM first_collection_items
      WHERE tenant_id=? AND project_id=? AND competitor_id=? AND capability=? AND job_id=? AND attempt_id=?`)
      .get(String(job.tenantId), String(job.projectId), String(job.competitorId), String(job.capability),
        String(job.jobId), String(job.attemptId));
    if (!row || row.in_scope) return null;
    return { itemId: row.item_id, reasonCode: 'brand_removed_from_project' };
  } catch (e) { return null; }
}

// 兼容旧调用点（r2 语义）：只回答「是否已移出项目」
function isCancelledScope(job) {
  return !!cancelledScopeOf(job);
}

// worker 单 tick：reclaim + reconcile + 认领一个 job 执行到底（含心跳）。
// 返回 { claimed: bool, jobId?, status?, reclaimed?, reconciled? }
async function tick(options) {
  const opt = options || {};
  const reclaimed = reclaimExpired(Date.now());
  const reconciled = reconcileAbandoned(Date.now());
  const job = claim(opt.workerId || 'w-' + process.pid);
  if (!job) return { claimed: false, reclaimed, reconciled };
  const hb = setInterval(() => { try { heartbeat(job.jobId, job.claimToken, Date.now()); } catch (e) {} }, HEARTBEAT_INTERVAL_MS);
  try {
    // SC-09 r3 §一：认领后、执行前再确认一次范围——品牌在执行前被移出则不发外部请求，
    // 并且**同时**把 job 与 attempt 终结（r2 只 finish job，留下孤儿 running attempt）
    const cancelled = cancelledScopeOf(job);
    if (cancelled) {
      const cx = cancelCollectionJobAndAttempt({
        tenantId: job.tenantId, jobId: job.jobId, attemptId: job.attemptId,
        reasonCode: cancelled.reasonCode,
      });
      return {
        claimed: true, jobId: job.jobId, status: 'cancelled', reclaimed, reconciled,
        cancel: cx, reason: cancelled.reasonCode,
      };
    }
    const out = await executeJob(job);
    finish(job.jobId, job.claimToken, 'done');
    const dup = !!(out && out.deduped);
    let diffOut = null;
    if (!dup) {
      // SC-07 r2 §二 / r3 P0-2：公开商品采集完成 → 推进监控意向（读 attempt 库内真值，
      // 不依赖 executeJob 返回形态；取消/已晋升意向由 onProbeFinished 忽略）
      notifyWatchIntent(job);
      // SC-09：项目级自动首采——任务完成后把真实 attempt 状态落回首采 item（幂等，无 item 则忽略）
      notifyFirstCollection(job);
      // SC-09 r2：按用途分发确定性变化（monitoring 才进收件箱；手动刷新只进时间线）
      diffOut = notifyObservationDiff(job);
    }
    return { claimed: true, jobId: job.jobId, status: 'done', reclaimed, reconciled, deduped: dup, diff: dup ? null : diffOut };  } catch (e) {
    const msg = String((e && e.message) || e);
    if (e && e.fenced) {
      // 失租约：不得写 attempt、不得 finish（claimToken 已失效，finish 天然无匹配）
      return { claimed: true, jobId: job.jobId, status: 'fenced', reclaimed, reconciled };
    }
    // executor 自身失败：attempt 仍 running 的，立即落 failed（不等对账）
    try {
      const att = SurfaceStore.getAttempt(job.tenantId, job.attemptId);
      if (att && att.status === 'running') {
        SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
          status: 'failed', sourceStatus: 'internal_error', errorClass: 'internal_error',
          errorUserText: '采集时发生内部问题，已记录，稍后可重试。',
        }, { jobId: job.jobId, token: job.claimToken }); // fencing：仍持令牌才允许写
      }
    } catch (e2) { /* attempt 已终态/fenced 时显式拒绝，忽略 */ }
    // r3 P0-2：异常路径同样推进监控意向——失败按 internal_error 计入 auto_retries，
    // 有界退避重试，达到上限进入 source_failed；绝不留下无 job、无 next_probe_at 的 establishing。
    notifyWatchIntent(job);
    notifyFirstCollection(job);
    // 失败任务没有可比值可 diff（内部按 not_success 直接返回）
    try { notifyObservationDiff(job); } catch (e3) { /* 忽略 */ }
    finish(job.jobId, job.claimToken, 'error', msg);
    return { claimed: true, jobId: job.jobId, status: 'error', reclaimed, reconciled, error: msg.slice(0, 200) };
  } finally { clearInterval(hb); }
}

// ---------- 常驻 worker（server.js 启动接线；禁 fire-and-forget 的替代） ----------
let _timer = null;
function startWorker(options) {
  const opt = options || {};
  if (_timer) return _timer;
  if (process.env.ZB_COLLECT_WORKER_DISABLED === '1') return null;
  const intervalMs = opt.intervalMs || 15000;
  const run = async () => {
    try { await tick({ workerId: 'w-' + process.pid }); } catch (e) { /* tick 内部已兜底 */ }
  };
  _timer = setInterval(run, intervalMs);
  if (_timer.unref) _timer.unref();
  // 启动即跑一次（恢复重启前遗留的 pending/过期 running）
  setImmediate(run);
  return _timer;
}
function stopWorker() { if (_timer) { clearInterval(_timer); _timer = null; } }

// 查询（管理/测试；tenantId 省略 = 全租户 admin 视图，status 数组过滤）
function list(tenantId, projectId, status) {
  const db = getDb();
  const where = [];
  const args = [];
  if (tenantId) { where.push('tenant_id=?'); args.push(String(tenantId)); }
  if (projectId) { where.push('project_id=?'); args.push(String(projectId)); }
  if (status && status.length) {
    where.push('status IN (' + status.map(() => '?').join(',') + ')');
    for (const s of status) args.push(String(s));
  }
  const sql = 'SELECT * FROM collection_jobs' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY created_at DESC LIMIT 100';
  return db.prepare(sql).all(...args).map(rowToJob);
}
function getJob(jobId, tenantId) {
  const r = getDb().prepare('SELECT * FROM collection_jobs WHERE job_id=? AND tenant_id=?').get(String(jobId || ''), String(tenantId || ''));
  return rowToJob(r);
}

module.exports = {
  CLAIM_TTL_MS, HEARTBEAT_INTERVAL_MS, MAX_RETRY, RUNNING_LEASE_MS,
  getDb, enqueue, claim, heartbeat, finish, reclaimExpired, reconcileAbandoned,
  executeJob, tick, startWorker, stopWorker, setExecutorForTest, list, getJob,
  cancelCollectionJobAndAttempt, cancelledScopeOf, isCancelledScope, CANCEL_TEXT,
  cancelCompetitorJobs, // SC-10 r2 §四：品牌移出项目 → 该项目该品牌全部未终结任务双终结
  loadCompetitor, // R4.14：暴露给回归测试（市场回退口径），不对外暴露 HTTP 面
};
