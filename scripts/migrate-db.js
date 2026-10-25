'use strict';
// ============================================================
// scripts/migrate-db.js —— 数据库**加法**迁移执行器 / 只读核验器
// ------------------------------------------------------------
// 设计约束（与代码内迁移一致，禁止破坏性变更）：
//   · 只允许 CREATE TABLE IF NOT EXISTS / ADD COLUMN / CREATE INDEX IF NOT EXISTS；
//   · 不 DROP、不改写既有列、不重写历史行；
//   · 幂等：重复执行结果一致（模块内 ensureSchema 自带 try/catch）；
//   · 迁移由各 service 模块惰性执行，本脚本只负责按固定顺序 require 并核验结果。
//
// 用法：
//   ZB_DATA_DIR=/srv/zhibi/data node scripts/migrate-db.js            # 执行加法迁移
//   ZB_DATA_DIR=/srv/zhibi/data node scripts/migrate-db.js --check    # 只读核验
// 退出码：0 成功 / 1 失败
//
// 🔴 --check 只读纪律（SC-10 r2 §二）：
//   · 禁止 mkdir（数据目录不存在即失败，绝不创建）；
//   · 禁止 require 任何会触发建表的业务模块；
//   · 禁止调用 getDb() / ensureTable() 等写入入口；
//   · 禁止创建或修改任何 DB / WAL / SHM 文件——
//     实测（node:sqlite）：即便 SQLITE_OPEN_READONLY，打开 WAL 库也会创建/改写
//     -shm/-wal 文件。因此 --check 把 *.db（连同 -wal/-shm）**复制到系统临时
//     Scratch 区**，只对副本做查询；数据目录全程只读；
//   · 执行前后对数据目录**全部文件**（递归）做 清单/大小/mtime/SHA-256 指纹比对，
//     任一变化即失败退出。
//
// 🔴 SC-10 r3 P0 修复（--check 假通过）：
//   · 旧实现的缺陷：列核验闭包 columnCheck 依赖 scratch 临时库，但 scratch 在
//     实际调用 columnCheck 之前就被删除；读取异常被 catch 成 []，报告出现
//     present:false，退出条件却只查缺表 → 照常打印「只读核验通过」并返回 0。
//     SC-10 必需字段缺失时，部署前检查形同虚设。
//   · 新实现：
//     1) 删除 scratch **之前**，一次性读入全部表的列集合（colCache 内存缓存）；
//     2) 报告与判定只读内存缓存，不保留任何依赖已删除 scratch 的闭包；
//     3) 必需字段走单一清单 REQUIRED_COLUMNS；缺任一字段 → exit 1、
//        输出 表名.字段名、不打印「只读核验通过」；
//     4) scratch 清理入 finally：检查成功与失败都清理临时副本。
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

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

// 🔴 SC-10 必需字段**单一清单**（表 → 列数组）：
// --check 与 apply 的核验都只以此为准，杜绝两处口径漂移；缺任一字段即失败退出。
const REQUIRED_COLUMNS = {
  collection_jobs: ['collection_purpose', 'window_key'],
  first_collection_items: ['in_scope', 'enqueue_generation', 'cancel_reason'],
  monitoring_windows: ['events_pending', 'events_write_failed', 'events_duplicate'],
};

// ---------- 数据目录指纹（--check 专用）：递归全部文件 ----------
// 记录 相对路径 → { size, mtimeMs, sha256 }；任一维度变化都算「目录被改动」。
function fingerprintDir(dir) {
  const out = {};
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { walk(childRel); continue; }
      if (!ent.isFile()) continue; // 符号链接等不纳入指纹（避免跟随逃逸目录）
      try {
        const st = fs.statSync(path.join(dir, childRel));
        const buf = fs.readFileSync(path.join(dir, childRel));
        out[childRel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
      } catch (e) { out[childRel] = { error: String((e && e.message) || e) }; }
    }
  };
  walk('');
  return out;
}
function diffFingerprints(before, after) {
  const diffs = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = before[k], a = after[k];
    if (!b) { diffs.push('新增文件: ' + k); continue; }
    if (!a) { diffs.push('文件消失: ' + k); continue; }
    if (b.error || a.error) { diffs.push('读取失败: ' + k); continue; }
    if (b.size !== a.size) diffs.push('大小变化: ' + k + ' (' + b.size + ' → ' + a.size + ')');
    if (b.mtimeMs !== a.mtimeMs) diffs.push('修改时间变化: ' + k);
    if (b.sha256 !== a.sha256) diffs.push('内容变化(SHA-256): ' + k);
  }
  return diffs;
}

// ---------- --check：复制到临时 Scratch 区后只读查询 ----------
function checkMode(dir) {
  const before = fingerprintDir(dir);
  const dbFiles = fs.readdirSync(dir).filter(f => f.endsWith('.db'));
  if (!dbFiles.length) {
    console.error('[migrate] --check：数据目录没有任何 .db 文件 ' + dir);
    process.exit(1);
  }
  // 复制 *.db 连同 -wal/-shm 到临时目录（只读数据目录，副本上允许 SQLite 正常打开）
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-migrate-check-'));
  const dbs = {};      // 库文件 → 表名清单
  const colCache = {}; // 表名 → 列名清单（**删除 scratch 之前一次性读入内存**）
  let openError = null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    for (const f of dbFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        const src = path.join(dir, f + suffix);
        if (!fs.existsSync(src)) continue;
        fs.copyFileSync(src, path.join(scratch, f + suffix));
      }
      // 副本以只读方式打开（双保险：即使代码写错也改不到数据目录）
      const h = new DatabaseSync(path.join(scratch, f), { readOnly: true });
      try {
        const tables = h.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
        dbs[f] = tables;
        // 🔴 SC-10 r3 P0 修复：此刻 scratch 仍存在，一次性读入**全部表**的列集合。
        // 此后报告与判定只读 colCache，绝不调用已删除的临时库。
        for (const t of tables) {
          if (colCache[t]) continue; // 同名表已在其他库读过（表不跨库重复）
          colCache[t] = h.prepare('PRAGMA table_info("' + t.replace(/"/g, '""') + '")').all().map(r => r.name);
        }
      } finally {
        h.close();
      }
    }
  } catch (e) {
    openError = e;
  } finally {
    // scratch 清理走可靠 finally：检查成功与失败都清理临时副本
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (e) { /* 临时目录清理失败不影响结论 */ }
  }
  if (openError) {
    console.error('[migrate] --check：副本打开失败 :: ' + String((openError && openError.message) || openError).slice(0, 300));
    process.exit(1);
  }

  // ===== 以下判定只读内存缓存（dbs / colCache），禁止再打开任何数据库 =====
  const allTables = Array.from(new Set(Object.values(dbs).flat()));
  const missing = REQUIRED_TABLES.filter(t => !allTables.includes(t));
  const missingColumns = [];
  const sc10Columns = {};
  for (const [t, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const have = colCache[t] || [];
    sc10Columns[t] = cols.map(c => {
      const present = have.includes(c);
      if (!present) missingColumns.push(t + '.' + c);
      return { column: c, present };
    });
  }
  const report = {
    dataDir: dir,
    mode: 'check',
    readOnlyVerified: true,
    dbFiles: Object.keys(dbs).sort(),
    tableCount: allTables.length,
    requiredMissing: missing,
    requiredMissingColumns: missingColumns,
    sc10Columns: sc10Columns,
  };

  // 前后指纹比对：数据目录必须逐字节不变（失败检查同样遵守）
  const after = fingerprintDir(dir);
  const diffs = diffFingerprints(before, after);
  if (diffs.length) {
    console.error('[migrate] --check 失败：数据目录在核验过程中发生变化（违反只读纪律）');
    for (const d of diffs.slice(0, 20)) console.error('  - ' + d);
    process.exit(1);
  }

  if (missing.length || missingColumns.length) {
    console.error('[migrate] 缺表: ' + JSON.stringify(missing));
    console.error('[migrate] SC-10 必需字段缺失: ' + JSON.stringify(missingColumns));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(report, null, 2));
  console.log('[migrate] 只读核验通过（表 ' + allTables.length + ' 张；数据目录逐字节未变）');
}

// ---------- 普通模式：加法迁移（行为保持不变） ----------
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

function applyMode(dir) {
  fs.mkdirSync(dir, { recursive: true });
  console.log('[migrate] 数据目录: ' + dir);
  console.log('[migrate] 模式: 执行加法迁移');

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
    mode: 'apply',
    dbFiles: Object.keys(dbs).sort(),
    tableCount: allTables.length,
    requiredMissing: missing,
    requiredMissingColumns: [],
    sc10Columns: {},
  };
  const colOf = (t) => {
    for (const f of Object.keys(dbs)) {
      if (!dbs[f].includes(t)) continue;
      try {
        const h = new DatabaseSync(path.join(dir, f));
        const cols = h.prepare('PRAGMA table_info("' + t.replace(/"/g, '""') + '")').all().map(r => r.name);
        h.close();
        return cols;
      } catch (e) { return []; }
    }
    return [];
  };
  const missingColumns = [];
  for (const [t, cols] of Object.entries(REQUIRED_COLUMNS)) {
    const have = colOf(t);
    report.sc10Columns[t] = cols.map(c => {
      const present = have.includes(c);
      if (!present) missingColumns.push(t + '.' + c);
      return { column: c, present };
    });
  }
  report.requiredMissingColumns = missingColumns;
  if (missing.length) {
    console.error('[migrate] 缺表: ' + JSON.stringify(missing));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  if (missingColumns.length) {
    console.error('[migrate] SC-10 必需字段缺失: ' + JSON.stringify(missingColumns));
    console.log(JSON.stringify(report, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(report, null, 2));
  console.log('[migrate] 加法迁移完成（表 ' + allTables.length + ' 张，无破坏性变更）');
}

function main() {
  if (!process.env.ZB_DATA_DIR) {
    console.error('[migrate] 必须设置 ZB_DATA_DIR（例如 /srv/zhibi/data）');
    process.exit(1);
  }
  const dir = process.env.ZB_DATA_DIR;
  if (checkOnly) {
    if (!fs.existsSync(dir)) {
      console.error('[migrate] --check：数据目录不存在（只读模式绝不创建） ' + dir);
      process.exit(1);
    }
    if (!fs.statSync(dir).isDirectory()) {
      console.error('[migrate] --check：不是目录 ' + dir);
      process.exit(1);
    }
    checkMode(dir);
    return;
  }
  applyMode(dir);
}

main();
