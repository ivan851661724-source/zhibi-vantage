'use strict';
// ============================================================
// 成本归因与租户日预算（模块 1-1）—— node:sqlite，零依赖
// 三级归因：tenantId → projectId → competitorId/fieldKey
// 计价口径（2026-08 官方现价，V4-Flash）：输入 ¥1/1M、缓存命中 ¥0.02/1M、输出 ¥2/1M
// 开关：COST_TELEMETRY=0 停记账；ZB_DAILY_BUDGET_YUAN 设日预算上限（空=不限）
// ============================================================
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const COST_DB = path.join(__dirname, '..', 'data', 'cost.sqlite');
// 写死常量便于换价（¥/1M tokens）
const PRICE = { inMiss: 1.0, inHit: 0.02, out: 2.0 };

let db;
function init() {
  if (db) return db;
  db = new DatabaseSync(COST_DB);
  db.exec('PRAGMA journal_mode = WAL');
  // WAL 卫生（2026-08-12 排查）：收紧 autocheckpoint 防大 WAL 同步写卡顿
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA wal_autocheckpoint = 200');
  db.exec(`CREATE TABLE IF NOT EXISTS cost_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenantId TEXT NOT NULL, projectId TEXT, competitorId TEXT, fieldKey TEXT,
    kind TEXT NOT NULL,               -- 'llm' | 'search'
    tokensIn INTEGER, tokensOut INTEGER, calls INTEGER,
    costYuan REAL,
    cached INTEGER DEFAULT 0,
    createdAt INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_ct_tenant ON cost_telemetry(tenantId, createdAt)');
  return db;
}

// usage -> 成本（¥）
function costOf(usage) {
  const miss = ((usage.prompt_tokens || 0) - (usage.prompt_cache_hit_tokens || 0)) / 1e6 * PRICE.inMiss;
  const hit = (usage.prompt_cache_hit_tokens || 0) / 1e6 * PRICE.inHit;
  const out = (usage.completion_tokens || 0) / 1e6 * PRICE.out;
  return miss + hit + out;
}

// 记账一条（三级归因）；entry: {tenantId, projectId, competitorId, fieldKey, kind, tokensIn, tokensOut, cached, calls, costYuan?}
function record(entry) {
  if (process.env.COST_TELEMETRY === '0') return;
  if (!entry || !entry.tenantId) return;
  init().prepare(`INSERT INTO cost_telemetry
    (tenantId, projectId, competitorId, fieldKey, kind, tokensIn, tokensOut, calls, costYuan, cached, createdAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      entry.tenantId,
      entry.projectId || null,
      entry.competitorId || null,
      entry.fieldKey || null,
      entry.kind || 'llm',
      entry.tokensIn || 0,
      entry.tokensOut || 0,
      entry.calls || 1,
      entry.costYuan != null ? entry.costYuan : 0,
      entry.cached || 0,
      Date.now()
    );
}

// 今日已花（¥）
function dailySpend(tenantId) {
  if (!tenantId) return 0;
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const row = init().prepare('SELECT COALESCE(SUM(costYuan),0) AS s FROM cost_telemetry WHERE tenantId=? AND createdAt >= ?')
    .get(tenantId, start.getTime());
  return row ? row.s : 0;
}

// 日预算熔断（ZB_DAILY_BUDGET_YUAN > 0 才生效；独立于 QUOTA_ENABLED 配额开关）
function overDailyBudget(tenantId) {
  if (!tenantId) return false;
  const budget = Number(process.env.ZB_DAILY_BUDGET_YUAN || '');
  if (!(budget > 0)) return false;
  return dailySpend(tenantId) >= budget;
}

function logBudgetAlert(tenantId) {
  try {
    const logger = require('./logger.js');
    logger && logger.warn('租户日预算已达上限，LLM 字段级降级', {
      tenantId, budgetYuan: process.env.ZB_DAILY_BUDGET_YUAN, spentYuan: dailySpend(tenantId).toFixed(4),
    });
  } catch { /* 日志模块不可用时静默 */ }
}

// 汇总（供 /api/cost/summary）：按 kind/project/competitor/field 分组
function summary(tenantId, days) {
  if (!tenantId) return [];
  const since = Date.now() - (days || 7) * 86400000;
  return init().prepare(`SELECT kind, projectId, competitorId, fieldKey,
      COUNT(*) AS calls, COALESCE(SUM(tokensIn),0) AS tokensIn, COALESCE(SUM(tokensOut),0) AS tokensOut,
      COALESCE(SUM(costYuan),0) AS costYuan
    FROM cost_telemetry WHERE tenantId=? AND createdAt >= ?
    GROUP BY kind, projectId, competitorId, fieldKey`).all(tenantId, since);
}

module.exports = { init, record, costOf, dailySpend, overDailyBudget, logBudgetAlert, summary, PRICE };
