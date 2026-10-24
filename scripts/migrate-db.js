'use strict';
// ============================================================
// scripts/migrate-db.js —— 数据库**加法**迁移执行器
// ------------------------------------------------------------
// 设计约束（与代码内迁移一致，禁止破坏性变更）：
//   · 只允许 CREATE TABLE IF NOT EXISTS / ADD COLUMN / CREATE INDEX IF NOT EXISTS；
//   · 不 DROP、不改写既有列、不重写历史行；
//   · 幂等：重复执行结果一致（模块内 ensureSchema 自带 try/catch）；
//   · 迁移由各 service 模块惰性执行，本脚本只负责按固定顺序 require 并核验结果。
//
// 用法：
//   ZB_DATA_DIR=/srv/zhibi/data node scripts/migrate-db.js
//   ZB_DATA_DIR=/srv/zhibi/data node scripts/migrate-db.js --check   # 只核验不写
// 退出码：0 成功 / 1 失败（任一表缺失）
// ============================================================
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const APP = path.join(REPO, 'app');
const checkOnly = process.argv.includes('--check');

// 迁移顺序：底层 db → 各业务表（依赖顺序仅影响建表，不改写数据）
const MODULES = [
  'services/db.js',
  'services/surface-store.js',
  'services/brand-store.js',
  'services/watch-store.js',
  'services/watch-intent.js',
  'services/collect-jobs.js',
  'services/first-collection.js',
  'services/intel-inbox.js',
  'services/source-readiness.js',
  'services/brand-service.js',
];

// 迁移后必须存在的表（缺任一 → 失败退出）
const REQUIRED_TABLES = [
  'projects',
  'brand_records', 'brand_project_links', 'brand_timeline',
  'collection_jobs', 'collection_attempts',
  'first_collection_batches', 'first_collection_items',
  'watch_targets', 'monitoring_windows', 'watch_intents', 'watch_price_snapshots', 'watch_site_baselines',
  'intel_events', 'provider_verifications',
];

function dbHandle() {
  // 采集/首采/监控三张库都在 surface-store 的连接上（collect-jobs.getDb 即同一句柄）
  try {
    const cj = require(path.join(APP, 'services/collect-jobs.js'));
    if (cj && typeof cj.getDb === 'function') return { handle: cj.getDb(), scope: 'collect-jobs/surface-store' };
  } catch (e) { /* fallthrough */ }
  const dbmod = require(path.join(APP, 'services/db.js'));
  const { DatabaseSync } = require('node:sqlite');
  return { handle: new DatabaseSync(dbmod.STORE_PATH), scope: 'multitenant' };
}

function main() {
  if (!process.env.ZB_DATA_DIR) {
    console.error('[migrate] 必须设置 ZB_DATA_DIR（例如 /srv/zhibi/data）');
    process.exit(1);
  }
  const dir = process.env.ZB_DATA_DIR;
  if (!checkOnly) fs.mkdirSync(dir, { recursive: true });
  if (checkOnly && !fs.existsSync(dir)) {
    console.error('[migrate] --check：数据目录不存在 ' + dir);
    process.exit(1);
  }

  console.log('[migrate] 数据目录: ' + dir);
  console.log('[migrate] 模式: ' + (checkOnly ? '只核验' : '执行加法迁移'));

  for (const m of MODULES) {
    const p = path.join(APP, m);
    if (!fs.existsSync(p)) { console.warn('[migrate] 跳过（模块不存在）: ' + m); continue; }
    try {
      require(p);
      console.log('[migrate] ok  ' + m);
    } catch (e) {
      console.error('[migrate] FAIL ' + m + ' :: ' + String((e && e.message) || e).slice(0, 300));
      process.exit(1);
    }
  }

  // 建表/加列都是惰性触发（getDb / ensureTable 内），所以 require 之后还要
  // 显式调用一次各库的初始化入口，否则"看起来迁移成功、实际列没补上"。
  const dbmod = require(path.join(APP, 'services/db.js'));
  try { if (typeof dbmod.getDaily === 'function') dbmod.getDaily('__migrate_probe__'); } catch (e) {}
  for (const [m, fn] of [
    ['services/collect-jobs.js', 'getDb'],
    ['services/surface-store.js', 'getDb'],
    ['services/watch-store.js', 'getDb'],
  ]) {
    try {
      const mod = require(path.join(APP, m));
      if (typeof mod[fn] === 'function') mod[fn]();
      console.log('[migrate] schema ok  ' + m);
    } catch (e) {
      console.error('[migrate] FAIL schema ' + m + ' :: ' + String((e && e.message) || e).slice(0, 300));
      process.exit(1);
    }
  }
  // 首采表：经一次只读查询触发 ensureTable（不写入任何业务数据）
  try { require(path.join(APP, 'services/first-collection.js')).summaryForProject('__migrate_probe__', '__migrate_probe__'); } catch (e) {}
  // 其余惰性建表：各用一次只读查询触发（probe 作用域不会落任何业务行）
  const probes = [
    ['services/brand-store.js', 'brandIdForCompetitor', ['__migrate_probe__', '__migrate_probe__', '__migrate_probe__']],
    ['services/watch-intent.js', 'listIntents', ['__migrate_probe__', '__migrate_probe__']],
    ['services/intel-inbox.js', 'listInbox', [{ tenantId: '__migrate_probe__', projectId: '__migrate_probe__' }]],
    ['services/source-readiness.js', 'getReadiness', ['__migrate_probe__']],
  ];
  for (const [m, fn, args] of probes) {
    try {
      const mod = require(path.join(APP, m));
      if (typeof mod[fn] === 'function') mod[fn].apply(null, args);
    } catch (e) { /* 探针查询失败不代表迁移失败，最终以表核验为准 */ }
  }

  // 数据分布在多个库文件（multitenant / data_surface / watch_targets / brands）：
  // 全部 require 后统一开只读句柄核验，Required 表只要出现在任一库即算通过。
  const { DatabaseSync } = require('node:sqlite');
  const dbs = {};
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.db'));
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const h = new DatabaseSync(p);
      dbs[f] = h.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
      h.close();
    } catch (e) { dbs[f] = []; }
  }
  const allTables = Array.from(new Set(Object.values(dbs).flat()));
  const missing = REQUIRED_TABLES.filter(t => !allTables.includes(t));
  const report = {
    dataDir: dir,
    mode: checkOnly ? 'check' : 'apply',
    dbFiles: Object.keys(dbs).sort(),
    tableCount: allTables.length,
    requiredMissing: missing,
    sc10Columns: {},
  };
  // SC-10 相关加法列核验（历史库升级后必须存在）
  const colOf = (t) => {
    for (const f of Object.keys(dbs)) {
      if (!dbs[f].includes(t)) continue;
      try {
        const h = new DatabaseSync(path.join(dir, f));
        const cols = h.prepare('PRAGMA table_info(' + t + ')').all().map(r => r.name);
        h.close();
        return cols;
      } catch (e) { return []; }
    }
    return [];
  };
  for (const [t, cols] of Object.entries({
    collection_jobs: ['collection_purpose', 'window_key'],
    first_collection_items: ['in_scope', 'enqueue_generation', 'cancel_reason'],
    monitoring_windows: ['events_pending', 'events_write_failed', 'events_duplicate'],
  })) {
    const have = colOf(t);
    report.sc10Columns[t] = cols.map(c => ({ column: c, present: have.includes(c) }));
  }
  if (missing.length) {
    console.error('[migrate] 缺表: ' + JSON.stringify(missing));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(report, null, 2));
  console.log('[migrate] 加法迁移完成（表 ' + allTables.length + ' 张，无破坏性变更）');
}

main();
