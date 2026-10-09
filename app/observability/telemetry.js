'use strict';
// ============================================================
// observability/telemetry.js —— 真实基线与可观测性（Phase 1）
// ------------------------------------------------------------
// 职责：为一次完整调研落盘「阶段度量 + 数据源调用 + 产品行为事件」，
// 供管理员只读统计接口聚合出 P50/P95、成功率、重试率、成本基线。
//
// 隐私铁律（任务书 §一/§三）：
//   · tenantId 一律经加盐 sha256 不可逆脱敏（盐落 data/.obs-salt，首次自动生成）；
//   · recordStage/recordEvent/recordSourceCall 只接受白名单字段——任何多余键
//     （提示词、正文、备注、用户输入）在入口即被丢弃，物理上进不了库；
//   · errorCode 只允许短 token（[A-Za-z0-9_.-] ≤64），截断一切自由文本。
// 业务纪律：本模块只写自己的三张表，绝不触碰价格/证据/置信度/机会评分；
//          所有写操作 best-effort（try/catch 静默），观测故障不得拖垮调研主链路。
//
// 三张表（node:sqlite，库文件 data/observability.sqlite，ZB_DATA_DIR/OBS_DB_PATH 可重定向）：
//   runs            一次完整调研的起止（runId=projectId）
//   stage_metrics   阶段耗时与结局（17 阶段 + 4 里程碑）
//   source_calls    搜索数据源逐次调用（含缓存命中，外部调用与命中分开计）
//   product_events  产品行为事件（9 类白名单）
//
// 运行上下文：AsyncLocalStorage 携带 {runId, tenantId, projectId}，使 search.js /
// llm-gateway.js 等深层调用点零签名改动即可归因到调研（withRun 包裹管线入口）。
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
  // 里程碑（durationMs 语义 = 从调研创建起的累计耗时）
  'milestone_first_brand', 'milestone_first_batch', 'milestone_first_report', 'milestone_all_done',
]);
const EVENT_TYPES = new Set([
  'intelligence_viewed', 'evidence_opened', 'material_saved', 'material_deferred',
  'material_ignored', 'correction_submitted', 'opportunity_viewed', 'report_viewed', 'alert_opened',
]);

let _db = null;
let _salt = null;
const runStore = new AsyncLocalStorage();

function db() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const d = new DatabaseSync(DB_PATH);
  d.exec('PRAGMA journal_mode = WAL');
  d.exec('PRAGMA synchronous = NORMAL');
  d.exec(`CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY, tenant_hash TEXT NOT NULL, project_id TEXT,
    started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT
  )`);
  d.exec(`CREATE TABLE IF NOT EXISTS stage_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT, tenant_hash TEXT NOT NULL, project_id TEXT,
    stage TEXT NOT NULL, duration_ms INTEGER,
    status TEXT, provider TEXT, model TEXT,
    retry_count INTEGER DEFAULT 0, cache_hit INTEGER DEFAULT 0,
    degraded INTEGER DEFAULT 0, error_code TEXT, result_count INTEGER,
    created_at INTEGER NOT NULL
  )`);
  d.exec('CREATE INDEX IF NOT EXISTS idx_sm_stage ON stage_metrics(stage, created_at)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_sm_run ON stage_metrics(run_id)');
  d.exec(`CREATE TABLE IF NOT EXISTS source_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, tenant_hash TEXT NOT NULL, project_id TEXT,
    source TEXT NOT NULL, kind TEXT, status TEXT,
    result_count INTEGER, duration_ms INTEGER
  )`);
  d.exec('CREATE INDEX IF NOT EXISTS idx_sc_source ON source_calls(source, ts)');
  d.exec(`CREATE TABLE IF NOT EXISTS product_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL, tenant_hash TEXT NOT NULL, project_id TEXT,
    event_type TEXT NOT NULL, object_type TEXT, object_hash TEXT
  )`);
  d.exec('CREATE INDEX IF NOT EXISTS idx_pe_type ON product_events(event_type, ts)');
  _db = d;
  return d;
}

// ---- 不可逆脱敏：加盐 sha256（盐独立落盘，库泄露无法反推 tenantId） ----
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

// ---- 阶段度量（白名单入口：多余键一律丢弃） ----
// 内部统一插入点：tenantHash 已算好（recordStage 走 hashId，milestone/endRun 走 runs 行反查）
function _insertStage(c, entry) {
  const d = db();
  return d.prepare(`INSERT INTO stage_metrics
    (run_id, tenant_hash, project_id, stage, duration_ms, status, provider, model,
     retry_count, cache_hit, degraded, error_code, result_count, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    c.runId, c.tenantHash, c.projectId, entry.stage,
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
    const tenantHash = hashId(c.tenantId);
    return _insertStage({ runId: c.runId, tenantHash, projectId: c.projectId }, entry);
  } catch { return null; } // best-effort：观测不拖垮主链路
}

// ---- 调研起止与里程碑 ----
function beginRun(ctx) {
  try {
    const c = _ctx(ctx);
    if (!c.runId || !c.tenantId) return;
    const tenantHash = hashId(c.tenantId);
    db().prepare(`INSERT INTO runs (run_id, tenant_hash, project_id, started_at, status)
      VALUES (?,?,?,?, 'running')
      ON CONFLICT(run_id) DO NOTHING`).run(c.runId, tenantHash, c.projectId, Date.now());
    _insertStage({ runId: c.runId, tenantHash, projectId: c.projectId },
      { stage: 'request_received', durationMs: 0, status: 'ok' });
  } catch { /* best-effort */ }
}
function _runRow(runId) {
  try {
    return db().prepare('SELECT run_id, tenant_hash, project_id, started_at FROM runs WHERE run_id = ?').get(runId) || null;
  } catch { return null; }
}
// 里程碑：durationMs = 从调研创建起的累计耗时；同一里程碑只记第一次
function milestone(runId, name, extra) {
  try {
    if (!STAGES.has(name) || !name.startsWith('milestone_')) return;
    const run = _runRow(runId);
    if (!run) return;
    const exists = db().prepare('SELECT 1 FROM stage_metrics WHERE run_id = ? AND stage = ?').get(runId, name);
    if (exists) return;
    _insertStage({ runId, tenantHash: run.tenant_hash, projectId: run.project_id },
      Object.assign({ stage: name, durationMs: Date.now() - run.started_at, status: 'ok' }, extra || {}));
  } catch { /* best-effort */ }
}
function endRun(runId, status, errorCode) {
  try {
    if (!runId) return;
    const run = _runRow(runId);
    db().prepare('UPDATE runs SET ended_at = ?, status = ? WHERE run_id = ? AND ended_at IS NULL')
      .run(Date.now(), token(status) || 'ok', runId);
    if (run) {
      _insertStage({ runId, tenantHash: run.tenant_hash, projectId: run.project_id },
        { stage: 'total', durationMs: Date.now() - run.started_at, status: status || 'ok', errorCode });
      milestone(runId, 'milestone_all_done');
    }
  } catch { /* best-effort */ }
}

// ---- 数据源调用（search.js 埋点） ----
function recordSourceCall(entry) {
  try {
    if (!entry || !entry.source) return null;
    const c = _ctx(entry);
    if (!c.tenantId) return null;
    return db().prepare(`INSERT INTO source_calls
      (ts, tenant_hash, project_id, source, kind, status, result_count, duration_ms)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      Date.now(), hashId(c.tenantId), c.projectId,
      token(entry.source), token(entry.kind) || null, token(entry.status) || 'ok',
      Number.isFinite(entry.resultCount) ? Math.max(0, Math.round(entry.resultCount)) : null,
      Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : null,
    );
  } catch { return null; }
}

// ---- 产品行为事件（白名单 9 类；只存脱敏标识与时间） ----
function recordEvent(entry) {
  try {
    if (!entry || !EVENT_TYPES.has(entry.eventType)) return null;
    const c = _ctx(entry);
    if (!c.tenantId) return null;
    return db().prepare(`INSERT INTO product_events
      (ts, tenant_hash, project_id, event_type, object_type, object_hash)
      VALUES (?,?,?,?,?,?)`).run(
      Date.now(), hashId(c.tenantId), c.projectId || null,
      entry.eventType, token(entry.objectType), entry.objectId ? hashId(entry.objectId) : null,
    );
  } catch { return null; }
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

function _pctRow(n, durations, rates) {
  if (n < MIN_PER_METRIC) return INSUFFICIENT;
  const s = durations.slice().sort((a, b) => a - b);
  return {
    count: n,
    p50_ms: Math.round(percentile(s, 0.5)),
    p95_ms: Math.round(percentile(s, 0.95)),
    success_rate: rates.success_rate, fail_rate: rates.fail_rate, degraded_rate: rates.degraded_rate,
    retry_rate: rates.retry_rate,
  };
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
    const fail = rows.filter(r => r.status != null && r.status !== 'ok' && r.status !== 'degraded').length;
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

  // ---- 单次调研均量（搜索调用 / token / 成本） ----
  // token 与成本落在 data/cost.sqlite 的 cost_telemetry（1-1 成本归因），独立连接读取；
  // 表不存在/无数据 → 该子指标 insufficient_sample（禁止 0 冒充）
  let perRun = INSUFFICIENT;
  if (runCount >= MIN_RUNS) {
    const searchPerRun = d.prepare(`SELECT AVG(c) AS avg FROM (
      SELECT project_id, COUNT(*) AS c FROM source_calls
      WHERE ts >= ? AND status != 'cache' AND project_id IS NOT NULL
      GROUP BY tenant_hash, project_id)`).get(from);
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

  // ---- 里程碑（调研创建 → 首品牌 / 首批结果 / 初版报告 / 全部完成；无样本=insufficient_sample） ----
  const milestones = {};
  for (const m of ['milestone_first_brand', 'milestone_first_batch', 'milestone_first_report', 'milestone_all_done']) {
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
function _resetForTest() { try { if (_db) { _db.close(); } } catch { /* ignore */ } _db = null; _salt = null; }

module.exports = {
  STAGES, EVENT_TYPES, INSUFFICIENT, MIN_PER_METRIC, MIN_RUNS,
  hashId, token, withRun, currentRun,
  recordStage, beginRun, milestone, endRun, recordSourceCall, recordEvent,
  percentile, summary, _resetForTest,
  // 测试/运维接缝：显式指定库路径（必须在首次写之前设置）
  _setDbPathForTest(p) { if (_db) throw new Error('already initialized'); DB_PATH = p; },
};
