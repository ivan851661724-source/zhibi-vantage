'use strict';
// ============================================================
// observability/telemetry.js —— 真实基线与可观测性（Phase 1 + 审核整改）
// ------------------------------------------------------------
// 职责：为一次完整调研落盘「阶段度量 + 数据源调用 + 产品行为事件」，
// 供管理员只读统计接口聚合出 P50/P95、成功率、重试率、成本基线。
//
// 运行身份模型（审核整改 §一）：
//   · runId 与 projectId 严格分离：每次完整调研 / 指定品牌调研 / 重新执行
//     都由调用方经 newRunId() 生成全局唯一 run（crypto.randomUUID，不可碰撞）；
//   · projectId 仅作为关联键（且入库前一律加盐哈希为 project_hash）；
//   · 同一 projectId 连续运行两次 → runs 必然两条独立记录，互不污染。
//
// 终态语义（审核整改 §二 / 第三轮整改 §二）：
//   · endRun 幂等：首次终态落库后，重复调用直接返回（不追加 total、不改状态）；
//   · 仅 status='ok'（真正完成全部任务）才补 milestone_all_done；
//     失败运行保留 total.status=error + 受控 error_code，绝不产生 all_done；
//   · degraded（第三轮整改 §二新增）：部分任务成功、部分失败——total.status=degraded，
//     不计入成功率、不产生 all_done，改产 milestone_all_processed（「全部处理结束」
//     与「成功完成」分开表达）。
//
// 隐私铁律（任务书 §一/§三 + 审核整改 §三）：
//   · tenantId、projectId 一律经加盐 sha256 不可逆脱敏（盐落 data/.obs-salt）；
//   · 四张表一律存 tenant_hash / project_hash，不存明文——projectId 含用户输入的
//     赛道/品牌名，明文禁止入观测库；
//   · recordStage/recordEvent/recordSourceCall 只接受白名单字段——任何多余键
//     （提示词、正文、备注、用户输入）在入口即被丢弃，物理上进不了库；
//   · errorCode 只允许短 token（[A-Za-z0-9_.-] ≤64），截断一切自由文本。
// 业务纪律：本模块只写自己的四张表，绝不触碰价格/证据/置信度/机会评分；
//          所有写操作 best-effort（try/catch 静默），观测故障不得拖垮调研主链路。
//
// 四张表（node:sqlite，库文件 data/observability.sqlite，ZB_DATA_DIR/OBS_DB_PATH 可重定向）：
//   runs            一次运行的起止（run_id 全局唯一，project_hash 关联项目）
//   stage_metrics   阶段耗时与结局（17 阶段 + 5 里程碑）
//   source_calls    搜索数据源逐次调用（含缓存命中，外部调用与命中分开计）
//   product_events  产品行为事件（9 类白名单）
//
// 数据保留（第三轮整改 §三）：OBS_RETENTION_DAYS 未设置=默认 30 天；正数=对应天数；
// 0=显式关闭（不调度删除、不调度 checkpoint）；负数/NaN/非法=回退默认并输出一次配置
// 警告。启动后异步【分段】清理（每轮有限批次 + 时间盒，setImmediate 让出事件循环），
// 全部完成后做一次 WAL checkpoint（TRUNCATE）；绝不在请求路径 VACUUM。
//
// 运行上下文：AsyncLocalStorage 携带 {runId, tenantId, projectId}，使 search.js /
// llm-gateway.js 等深层调用点零签名改动即可归因到本次运行（withRun 包裹管线入口）。
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA = process.env.ZB_DATA_DIR ? path.resolve(process.env.ZB_DATA_DIR) : path.join(ROOT, 'data');
let DB_PATH = process.env.OBS_DB_PATH || path.join(DATA, 'observability.sqlite');

// ---- 受控枚举 ----
const STAGES = new Set([
  'request_received', 'translate', 'candidate_enumeration', 'search_round_1', 'harvest',
  'search_round_2', 'relevance_check', 'competitor_queue_wait', 'site_shopify_fetch',
  'channel_probe', 'voice_collection', 'llm_header_wait', 'llm_body_read',
  'field_merge_citation_check', 'derived_analysis', 'report_generation', 'total',
  // 里程碑（durationMs 语义 = 从本次运行创建起的累计耗时）
  'milestone_first_brand', 'milestone_first_batch', 'milestone_first_report', 'milestone_all_done',
  // 第三轮整改 §二：「全部处理结束」里程碑——degraded 运行专用，与「成功完成」
  //（milestone_all_done）严格分开，统计聚合分别读取
  'milestone_all_processed',
]);
const EVENT_TYPES = new Set([
  'intelligence_viewed', 'evidence_opened', 'material_saved', 'material_deferred',
  'material_ignored', 'correction_submitted', 'opportunity_viewed', 'report_viewed', 'alert_opened',
]);
// 终态白名单（endRun status 只接受这些值）。第三轮整改 §二：新增 degraded——
// 部分任务成功、部分失败的可观测终态：不计入成功率、不产生 milestone_all_done，
// 改产 milestone_all_processed（「全部处理结束」与「成功完成」分开表达）。
const RUN_STATUSES = new Set(['ok', 'error', 'aborted', 'degraded']);

// 数据保留（第三轮整改 §三）：未设置=默认 30 天；正数=对应天数（向下取整）；
// 0=显式关闭自动清理（不调度删除、不调度 checkpoint）；负数/NaN/非法字符串=
// 回退默认值并输出一次不含敏感信息的配置警告。
const RETENTION_DAYS_DEFAULT = 30;
let _retentionWarned = false;
function retentionDays() {
  const raw = process.env.OBS_RETENTION_DAYS;
  if (raw == null || String(raw).trim() === '') return RETENTION_DAYS_DEFAULT;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (!_retentionWarned) {
    _retentionWarned = true;
    try { console.error('[observability] 配置警告：OBS_RETENTION_DAYS 取值非法（要求 ≥0 的数字），已回退默认 ' + RETENTION_DAYS_DEFAULT + ' 天'); } catch { /* ignore */ }
  }
  return RETENTION_DAYS_DEFAULT;
}

let _db = null;
let _salt = null;
const runStore = new AsyncLocalStorage();

// ---- Schema（project_hash 化：审核整改 §三） ----
const SCHEMA = {
  runs: `CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY, tenant_hash TEXT NOT NULL, project_hash TEXT,
    started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT
  )`,
  stage_metrics: `CREATE TABLE IF NOT EXISTS stage_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT, tenant_hash TEXT NOT NULL, project_hash TEXT,
    stage TEXT NOT NULL, duration_ms INTEGER,
    status TEXT, provider TEXT, model TEXT,
    retry_count INTEGER DEFAULT 0, cache_hit INTEGER DEFAULT 0,
    degraded INTEGER DEFAULT 0, error_code TEXT, result_count INTEGER,
    created_at INTEGER NOT NULL
  )`,
  source_calls: `CREATE TABLE IF NOT EXISTS source_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, tenant_hash TEXT NOT NULL, project_hash TEXT,
    source TEXT NOT NULL, kind TEXT, status TEXT,
    result_count INTEGER, duration_ms INTEGER
  )`,
  product_events: `CREATE TABLE IF NOT EXISTS product_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, tenant_hash TEXT NOT NULL, project_hash TEXT,
    event_type TEXT NOT NULL, object_type TEXT, object_hash TEXT
  )`,
};
const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_sm_stage ON stage_metrics(stage, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_sm_run ON stage_metrics(run_id)',
  'CREATE INDEX IF NOT EXISTS idx_sc_source ON source_calls(source, ts)',
  'CREATE INDEX IF NOT EXISTS idx_pe_type ON product_events(event_type, ts)',
];
const TS_COLUMN = { runs: 'started_at', stage_metrics: 'created_at', source_calls: 'ts', product_events: 'ts' };

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA synchronous = NORMAL');
  _migrateLegacyProjectId(d); // 审核整改 §三：旧 project_id 列 → project_hash（存量哈希迁移）
  for (const ddl of Object.values(SCHEMA)) d.exec(ddl);
  for (const idx of INDEXES) d.exec(idx);
  _db = d;
  _schedulePrune(); // 数据保留：进程生命周期一次，分批异步（不阻塞首写调用方）
  return d;
}

// ---- 迁移兼容（审核整改 §三/报告要求）：旧库含明文 project_id 列 → 重建为 project_hash ----
// 策略：读出旧行 → JS 侧加盐哈希 → 重建新表回插 → DROP 旧表。行数小（观测库），
// 分表处理；任何一步失败都不阻断（观测库可重建，业务数据不受影响）。
function _migrateLegacyProjectId(d) {
  for (const table of Object.keys(SCHEMA)) {
    try {
      const cols = d.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
      if (!cols.length || !cols.includes('project_id') || cols.includes('project_hash')) continue;
      const rows = d.prepare(`SELECT * FROM ${table}`).all();
      d.exec(`DROP TABLE ${table}`);
      d.exec(SCHEMA[table]);
      if (rows.length) {
        const colNames = rows[0] ? Object.keys(rows[0]).filter(k => k !== 'project_id') : [];
        if (colNames.length) {
          const ins = d.prepare(`INSERT INTO ${table} (${colNames.join(',') + ',project_hash'})
            VALUES (${colNames.map(() => '?').join(',') + ',?'})`);
          for (const r of rows) {
            ins.run(...colNames.map(k => r[k]), hashId(r.project_id));
          }
        }
      }
      try { console.log(`[observability] 迁移完成：${table}.project_id → project_hash（${rows.length} 行，已加盐哈希）`); } catch (e) { /* 无控制台环境 */ }
    } catch (e) {
      try { console.error(`[observability] ${table} 迁移失败（忽略，表将按新 Schema 重建）: ` + String(e && e.message || e)); } catch (e2) { /* ignore */ }
      try { d.exec(SCHEMA[table]); } catch (e3) { /* ignore */ }
    }
  }
}

// ---- 不可逆脱敏：加盐 sha256（盐独立落盘，库泄露无法反推原值） ----
function salt() {
  if (_salt) return _salt;
  const p = path.join(DATA, '.obs-salt');
  try { const s = fs.readFileSync(p, 'utf8').trim(); if (s) { _salt = s; return s; } } catch { /* 首次生成 */ }
  const s = crypto.randomBytes(24).toString('hex');
  try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(p, s + '\n', { mode: 0o600 }); } catch { /* 只读环境：用进程内盐（重启后哈希不可跨进程比对，仍然不可逆） */ }
  _salt = s;
  return s;
}
function hashId(value) {
  const v = String(value == null ? '' : value);
  if (!v) return '';
  return crypto.createHash('sha256').update(salt() + '|' + v).digest('hex').slice(0, 24);
}
// errorCode/短 token 消毒：只留安全字符，截断 64
function token(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || null;
}

// ---- 运行身份（审核整改 §一）：每次运行独立、不可碰撞 ----
function newRunId() {
  return 'run-' + crypto.randomUUID();
}

// ---- 运行上下文（AsyncLocalStorage） ----
function withRun(ctx, fn) { return runStore.run(ctx || {}, fn); }
function currentRun() { return runStore.getStore() || null; }
function _ctx(ctx) {
  const cur = currentRun() || {};
  return {
    runId: ctx.runId || cur.runId || null,
    tenantId: ctx.tenantId || cur.tenantId || '',
    projectId: ctx.projectId || cur.projectId || null,
  };
}

// ---- 阶段度量（白名单入口：多余键一律丢弃；project_hash 化） ----
function _insertStage(c, entry) {
  const d = db();
  return d.prepare(`INSERT INTO stage_metrics
    (run_id, tenant_hash, project_hash, stage, duration_ms, status, provider, model,
     retry_count, cache_hit, degraded, error_code, result_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    c.runId, c.tenantHash, c.projectHash, entry.stage,
    Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : null,
    token(entry.status) || 'ok', token(entry.provider), token(entry.model),
    Number.isFinite(entry.retryCount) ? Math.max(0, Math.round(entry.retryCount)) : 0,
    entry.cacheHit ? 1 : 0, entry.degraded ? 1 : 0,
    token(entry.errorCode), Number.isFinite(entry.resultCount) ? Math.max(0, Math.round(entry.resultCount)) : null,
    Date.now(),
  ).lastInsertRowid;
}
function recordStage(entry) {
  try {
    if (!entry || !STAGES.has(entry.stage)) return null; // 未知阶段直接拒（防脏数据入库）
    const c = _ctx(entry);
    if (!c.tenantId) return null; // 无租户上下文不记（防御匿名/测试误用；网关匿名调用显式传 'anonymous'）
    return _insertStage(
      { runId: c.runId, tenantHash: hashId(c.tenantId), projectHash: c.projectId ? hashId(c.projectId) : null },
      entry,
    );
  } catch { return null; } // best-effort：观测不拖垮主链路
}

// ---- 调研起止与里程碑 ----
function beginRun(ctx) {
  try {
    const c = _ctx(ctx);
    // runId 缺省时现场生成（防御调用方遗漏）；projectId 仅作关联键，入库即哈希
    const runId = c.runId || newRunId();
    if (!c.tenantId) return runId; // 无租户上下文不落 runs 行（仍返回 runId 供调用方统一使用）
    const tenantHash = hashId(c.tenantId);
    db().prepare(`INSERT INTO runs (run_id, tenant_hash, project_hash, started_at, status)
      VALUES (?,?,?,?, 'running')
      ON CONFLICT(run_id) DO NOTHING`).run(runId, tenantHash, c.projectId ? hashId(c.projectId) : null, Date.now());
    _insertStage({ runId, tenantHash, projectHash: c.projectId ? hashId(c.projectId) : null },
      { stage: 'request_received', durationMs: 0, status: 'ok' });
    return runId;
  } catch { return (ctx && ctx.runId) || null; } /* best-effort */
}
function _runRow(runId) {
  try {
    return db().prepare('SELECT run_id, tenant_hash, project_hash, started_at, ended_at, status FROM runs WHERE run_id = ?').get(runId) || null;
  } catch { return null; }
}
// 里程碑：durationMs = 从本次运行创建起的累计耗时；同一里程碑只记第一次
function milestone(runId, name, extra) {
  try {
    if (!runId || !STAGES.has(name) || !name.startsWith('milestone_')) return;
    const run = _runRow(runId);
    if (!run) return;
    const exists = db().prepare('SELECT 1 FROM stage_metrics WHERE run_id = ? AND stage = ?').get(runId, name);
    if (exists) return;
    _insertStage({ runId, tenantHash: run.tenant_hash, projectHash: run.project_hash },
      Object.assign({ stage: name, durationMs: Date.now() - run.started_at, status: 'ok' }, extra || {}));
  } catch { /* best-effort */ }
}
// 终点（审核整改 §二 / 第三轮整改 §二）：
//   · 幂等——runs 行已有 ended_at 时直接返回：重复调用不产生第二条 total、不覆盖首次终态；
//   · 失败语义——status != 'ok' 时保留 total.status=error/degraded/aborted + 受控 error_code，
//     绝不补 milestone_all_done；仅真正完成（'ok'）的成功运行才产生 all_done；
//   · degraded 语义——部分任务成功的运行：total.status=degraded（阶段聚合不计入失败率、
//     不计入成功率），改产 milestone_all_processed（全部处理结束 ≠ 全部成功）。
function endRun(runId, status, errorCode) {
  try {
    if (!runId) return;
    const d = db();
    const run = _runRow(runId);
    if (!run || run.ended_at != null) return; // 幂等闸：首终态唯一
    const st = RUN_STATUSES.has(status) ? status : (token(status) === 'ok' ? 'ok' : 'error');
    d.prepare('UPDATE runs SET ended_at = ?, status = ? WHERE run_id = ? AND ended_at IS NULL')
      .run(Date.now(), st, runId);
    _insertStage({ runId, tenantHash: run.tenant_hash, projectHash: run.project_hash },
      { stage: 'total', durationMs: Date.now() - run.started_at, status: st,
        errorCode: st === 'ok' ? undefined : (token(errorCode) || (st === 'degraded' ? 'PARTIAL_FAILED' : 'RUN_FAILED')) });
    if (st === 'ok') milestone(runId, 'milestone_all_done');
    else if (st === 'degraded') milestone(runId, 'milestone_all_processed');
  } catch { /* best-effort */ }
}

// ---- 数据源调用（search.js 埋点） ----
function recordSourceCall(entry) {
  try {
    if (!entry || !entry.source) return null;
    const c = _ctx(entry);
    if (!c.tenantId) return null;
    return db().prepare(`INSERT INTO source_calls
      (ts, tenant_hash, project_hash, source, kind, status, result_count, duration_ms)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      Date.now(), hashId(c.tenantId), c.projectId ? hashId(c.projectId) : null,
      token(entry.source), token(entry.kind) || null, token(entry.status) || 'ok',
      Number.isFinite(entry.resultCount) ? Math.max(0, Math.round(entry.resultCount)) : null,
      Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : null,
    );
  } catch { return null; }
}

// ---- 产品行为事件（白名单 9 类；只存脱敏标识与时间；projectId 由端点先验证归属） ----
function recordEvent(entry) {
  try {
    if (!entry || !EVENT_TYPES.has(entry.eventType)) return null;
    const c = _ctx(entry);
    if (!c.tenantId) return null;
    return db().prepare(`INSERT INTO product_events
      (ts, tenant_hash, project_hash, event_type, object_type, object_hash)
      VALUES (?,?,?,?,?,?)`).run(
      Date.now(), hashId(c.tenantId), c.projectId ? hashId(c.projectId) : null,
      entry.eventType, token(entry.objectType), entry.objectId ? hashId(entry.objectId) : null,
    );
  } catch { return null; }
}

// ---- 数据保留（第三轮整改 §三）：分批删除过期行；可测试、不阻塞主链路 ----
// pruneOld 为「一次性同步清干净」（测试/运维显式调用）；启动自动清理走 _schedulePrune
// 的分段调度（每轮有限批次 + 时间盒，setImmediate 让出事件循环，全部完成后 checkpoint 一次）。
function pruneOld(retentionDaysOverride, batchSizeOverride) {
  let days;
  if (retentionDaysOverride != null) {
    const v = Number(retentionDaysOverride);
    days = (Number.isFinite(v) && v >= 0) ? Math.floor(v) : retentionDays();
  } else {
    days = retentionDays();
  }
  if (days === 0) return { skipped: true, reason: 'retention disabled' }; // 显式 0 = 关闭
  const batch = Math.min(Math.max(Number.isFinite(batchSizeOverride) ? batchSizeOverride : 500, 10), 5000);
  const cutoff = Date.now() - days * 24 * 3600000;
  const d = db();
  const out = { cutoff, retention_days: days, deleted: {} };
  for (const [table, tsCol] of Object.entries(TS_COLUMN)) {
    let total = 0, batches = 0;
    // 分批：单批 LIMIT 上限，最多 200 批（防御性上限，避免极端积压时长时间占用）
    while (batches < 200) {
      const info = d.prepare(`DELETE FROM ${table} WHERE rowid IN
        (SELECT rowid FROM ${table} WHERE ${tsCol} < ? LIMIT ?)`).run(cutoff, batch);
      const n = Number(info.changes) || 0;
      total += n; batches++;
      if (n < batch) break;
    }
    out.deleted[table] = total;
  }
  try { d.exec('PRAGMA wal_checkpoint(TRUNCATE)'); out.wal_checkpoint = 'truncated'; } catch { /* WAL 关闭等场景忽略 */ }
  return out;
}
let _pruneScheduled = false;
let _lastPruneInfo = null;
// 分段调度（第三轮整改 §三）：不再在一个 setImmediate 回调里同步执行最多
// 800 次删除（旧实现 200 批 × 4 表）。每轮最多 PRUNE_ROUND_BATCHES 批且不超过
// PRUNE_ROUND_BUDGET_MS 毫秒，随即 setImmediate 让出事件循环；全部表清完后
// 只做一次 WAL checkpoint。OBS_RETENTION_DAYS=0（关闭）时完全不调度删除与 checkpoint。
const PRUNE_ROUND_BATCHES = 16;
const PRUNE_ROUND_BUDGET_MS = 25;
function _schedulePrune() {
  if (_pruneScheduled) return;
  const days = retentionDays();
  if (days === 0) return; // 显式关闭：不调度删除、不调度 checkpoint
  _pruneScheduled = true;
  const cutoff = Date.now() - days * 24 * 3600000;
  const batch = 500;
  const tables = Object.entries(TS_COLUMN);
  let ti = 0, rounds = 0, walDone = false;
  const deleted = {};
  const step = () => {
    let finished = false;
    try {
      const t0 = Date.now();
      let batchesThisRound = 0;
      while (ti < tables.length && batchesThisRound < PRUNE_ROUND_BATCHES
             && (Date.now() - t0) < PRUNE_ROUND_BUDGET_MS) {
        const [table, tsCol] = tables[ti];
        const info = db().prepare(`DELETE FROM ${table} WHERE rowid IN
          (SELECT rowid FROM ${table} WHERE ${tsCol} < ? LIMIT ?)`).run(cutoff, batch);
        const n = Number(info.changes) || 0;
        deleted[table] = (deleted[table] || 0) + n;
        batchesThisRound++;
        if (n < batch) ti++; // 该表已清完 → 下一张表
      }
      rounds++;
      if (ti >= tables.length) {
        // 全部表清理完成 → checkpoint 恰好一次
        try { db().exec('PRAGMA wal_checkpoint(TRUNCATE)'); walDone = true; } catch { walDone = true; /* WAL 关闭等场景忽略 */ }
        finished = true;
      }
    } catch (e) {
      try { console.error('[observability] 保留期清理失败（不阻断）: ' + String(e && e.message || e)); } catch (e2) { /* ignore */ }
      finished = true;
    }
    if (finished) {
      _lastPruneInfo = { rounds, deleted, wal_checkpoint: walDone ? 'truncated' : 'skipped' };
      _pruneScheduled = false;
      return;
    }
    setImmediate(step); // 未清完：让出事件循环后继续
  };
  setImmediate(step);
}

// ---- 统计聚合 ----
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}
const INSUFFICIENT = 'insufficient_sample';
// 指标级最小样本：低于该样本量的指标一律返回 insufficient_sample（禁止 0 冒充）
const MIN_PER_METRIC = 5;
const MIN_RUNS = 3;

// 审核整改 §五：百分位必须按**有效 duration 样本数**判定——空 duration 绝不产出 0ms
function _pctRow(n, durations, rates) {
  if (n < MIN_PER_METRIC) return INSUFFICIENT;
  const durs = (durations || []).filter(Number.isFinite);
  const base = {
    count: n,
    duration_samples: durs.length,
    success_rate: rates.success_rate, fail_rate: rates.fail_rate, degraded_rate: rates.degraded_rate,
    retry_rate: rates.retry_rate,
  };
  if (durs.length < MIN_PER_METRIC) {
    base.p50_ms = INSUFFICIENT; base.p95_ms = INSUFFICIENT;
    return base;
  }
  const s = durs.slice().sort((a, b) => a - b);
  base.p50_ms = Math.round(percentile(s, 0.5));
  base.p95_ms = Math.round(percentile(s, 0.95));
  return base;
}

function summary(opts) {
  const o = opts || {};
  const windowHours = Number.isFinite(o.windowHours) ? Math.min(Math.max(o.windowHours, 1), 24 * 90) : 24 * 7;
  const from = Date.now() - windowHours * 3600000;
  const d = db();
  const runCount = d.prepare('SELECT COUNT(*) AS n FROM runs WHERE started_at >= ?').get(from).n;
  const stageCount = d.prepare('SELECT COUNT(*) AS n FROM stage_metrics WHERE created_at >= ?').get(from).n;
  const sufficient = runCount >= MIN_RUNS && stageCount >= MIN_PER_METRIC;

  // ---- 各阶段（已知阶段恒有键：无样本=insufficient_sample，禁止缺键或 0 冒充） ----
  const stages = {};
  for (const st of STAGES) stages[st] = INSUFFICIENT;
  const stageRows = d.prepare(`SELECT stage, duration_ms, status, retry_count, degraded
    FROM stage_metrics WHERE created_at >= ?`).all(from);
  const byStage = new Map();
  for (const r of stageRows) {
    if (!byStage.has(r.stage)) byStage.set(r.stage, []);
    byStage.get(r.stage).push(r);
  }
  for (const [stage, rows] of byStage) {
    const n = rows.length;
    const withDur = rows.filter(r => r.duration_ms != null).map(r => r.duration_ms);
    const ok = rows.filter(r => r.status === 'ok').length;
    const fail = rows.filter(r => r.status != null && r.status !== 'ok' && r.status !== 'degraded' && r.status !== 'partial').length;
    const degraded = rows.filter(r => r.degraded === 1 || r.status === 'degraded').length;
    const retried = rows.filter(r => (r.retry_count || 0) > 0).length;
    if (n < MIN_PER_METRIC) { stages[stage] = INSUFFICIENT; continue; }
    const pct = (k) => Math.round((k / n) * 1000) / 1000;
    stages[stage] = _pctRow(n, withDur, {
      success_rate: pct(ok), fail_rate: pct(fail), degraded_rate: pct(degraded), retry_rate: pct(retried),
    });
  }

  // ---- 数据源 ----
  const dataSources = {};
  const scRows = d.prepare(`SELECT source, status, result_count, duration_ms FROM source_calls WHERE ts >= ?`).all(from);
  const bySource = new Map();
  for (const r of scRows) {
    if (!bySource.has(r.source)) bySource.set(r.source, []);
    bySource.get(r.source).push(r);
  }
  for (const [source, rows] of bySource) {
    if (rows.length < MIN_PER_METRIC) { dataSources[source] = INSUFFICIENT; continue; }
    const external = rows.filter(r => r.status !== 'cache');
    const ok = external.filter(r => r.status === 'ok');
    const results = ok.map(r => r.result_count || 0);
    const durs = external.filter(r => r.duration_ms != null).map(r => r.duration_ms).sort((a, b) => a - b);
    dataSources[source] = {
      external_calls: external.length,
      ok_calls: ok.length,
      failed_calls: external.length - ok.length,
      cache_hits: rows.length - external.length,
      results_total: results.reduce((a, b) => a + b, 0),
      results_avg: results.length ? Math.round((results.reduce((a, b) => a + b, 0) / results.length) * 100) / 100 : INSUFFICIENT,
      p50_ms: durs.length >= MIN_PER_METRIC ? Math.round(percentile(durs, 0.5)) : INSUFFICIENT,
      p95_ms: durs.length >= MIN_PER_METRIC ? Math.round(percentile(durs, 0.95)) : INSUFFICIENT,
    };
  }

  // ---- 单次运行均量（搜索调用 / token / 成本） ----
  // token 与成本落在 data/cost.sqlite 的 cost_telemetry（1-1 成本归因），独立连接读取；
  // 表不存在/无数据 → 该子指标 insufficient_sample（禁止 0 冒充）
  let perRun = INSUFFICIENT;
  if (runCount >= MIN_RUNS) {
    const searchPerRun = d.prepare(`SELECT AVG(c) AS avg FROM (
      SELECT tenant_hash, project_hash, COUNT(*) AS c FROM source_calls
      WHERE ts >= ? AND status != 'cache' AND project_hash IS NOT NULL
      GROUP BY tenant_hash, project_hash)`).get(from);
    let llmByRun = [];
    try {
      const costDb = new DatabaseSync(path.join(DATA, 'cost.sqlite'), { readOnly: true });
      llmByRun = costDb.prepare(`SELECT project_id,
          SUM(tokens_in) AS tin, SUM(tokens_out) AS tout, SUM(cost_yuan) AS cost
        FROM cost_telemetry WHERE created_at >= ? AND kind = 'llm' AND project_id IS NOT NULL
        GROUP BY tenant_id, project_id`).all(from);
      costDb.close();
    } catch { /* cost.sqlite 不存在或无表：视为无成本样本 */ }
    if (llmByRun.length >= MIN_RUNS) {
      perRun = {
        runs: runCount,
        avg_search_calls: searchPerRun && searchPerRun.avg != null ? Math.round(searchPerRun.avg * 100) / 100 : INSUFFICIENT,
        avg_tokens_in: Math.round(llmByRun.reduce((a, r) => a + (r.tin || 0), 0) / llmByRun.length),
        avg_tokens_out: Math.round(llmByRun.reduce((a, r) => a + (r.tout || 0), 0) / llmByRun.length),
        avg_cost_yuan: Math.round(llmByRun.reduce((a, r) => a + (r.cost || 0), 0) / llmByRun.length * 10000) / 10000,
      };
    } else {
      perRun = { runs: runCount, note: INSUFFICIENT };
    }
  }

  // ---- 里程碑（运行创建 → 首品牌 / 首批结果 / 初版报告 / 全部完成 / 全部处理结束；无样本=insufficient_sample） ----
  const milestones = {};
  for (const m of ['milestone_first_brand', 'milestone_first_batch', 'milestone_first_report', 'milestone_all_done', 'milestone_all_processed']) {
    milestones[m] = INSUFFICIENT;
    const durs = stageRows.filter(r => r.stage === m && r.duration_ms != null).map(r => r.duration_ms);
    if (durs.length < MIN_PER_METRIC) { milestones[m] = INSUFFICIENT; continue; }
    const s = durs.sort((a, b) => a - b);
    milestones[m] = { count: durs.length, p50_ms: Math.round(percentile(s, 0.5)), p95_ms: Math.round(percentile(s, 0.95)) };
  }

  return {
    window: { hours: windowHours, from, to: Date.now() },
    sample: { runs: runCount, stage_records: stageCount, sufficient, minimum: { runs: MIN_RUNS, stage_records: MIN_PER_METRIC } },
    ...(sufficient ? {} : { status: INSUFFICIENT }),
    stages, data_sources: dataSources, per_run: perRun, milestones,
  };
}

// 测试接缝：关闭/重置（仅测试用）
function _resetForTest() {
  try { if (_db) { _db.close(); } } catch { /* ignore */ }
  _db = null; _salt = null; _pruneScheduled = false; _lastPruneInfo = null; _retentionWarned = false;
}

module.exports = {
  STAGES, EVENT_TYPES, RUN_STATUSES, INSUFFICIENT, MIN_PER_METRIC, MIN_RUNS,
  RETENTION_DAYS_DEFAULT, retentionDays,
  hashId, token, newRunId, withRun, currentRun,
  recordStage, beginRun, milestone, endRun, recordSourceCall, recordEvent,
  pruneOld, percentile, summary, _resetForTest,
  // 第三轮整改 §三：分段清理调度状态（测试/运维只读）
  _lastPruneInfo() { return _lastPruneInfo; },
  _schedulePrune, // 测试接缝：显式触发分段清理调度（生产由首次初始化自动触发）
  // 测试/运维接缝：显式指定库路径（必须在首次写之前设置）
  _setDbPathForTest(p) { if (_db) throw new Error('already initialized'); DB_PATH = p; },
};
