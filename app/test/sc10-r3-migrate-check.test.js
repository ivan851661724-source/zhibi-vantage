'use strict';
// ============================================================
// app/test/sc10-r3-migrate-check.test.js
// SC-10 r3：迁移核验器（--check）假通过修复 —— 真实子进程回归
//
// 背景（P0）：旧 --check 的列核验闭包依赖 scratch 临时库，但 scratch 在调用前
// 已被删除，读取异常被吞成 []，报告 present:false 却仍打印「只读核验通过」
// 并 exit 0 —— SC-10 必需字段缺失时部署前检查形同虚设。
//
// M1 完整迁移后 --check：exit 0，8 个必需字段全部 present:true
//    （行为佐证：若字段读取发生在 scratch 删除之后，读取必失败→[]→present:false，
//      全 true 即证明读取先于删除发生）
// M2 真实删除一个必需字段后 --check：exit 1，输出点名缺失字段，无「只读核验通过」
// M3 M2 失败检查前后，数据目录指纹逐项相同（失败检查也没修改原目录）
// M4 缺少必需表时 --check：exit 1
// M5 无 .db 文件：exit 1，且不创建任何文件/目录（含 scratch 临时目录）
// M6 源码断言：字段读取发生在 scratch 删除之前；最终判定不再调用临时数据库
// ============================================================
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const MIGRATE = path.join(REPO, 'scripts', 'migrate-db.js');

// SC-10 必需字段单一清单（与 scripts/migrate-db.js 的 REQUIRED_COLUMNS 对应）
const REQUIRED_FIELDS = [
  'collection_jobs.collection_purpose',
  'collection_jobs.window_key',
  'first_collection_items.in_scope',
  'first_collection_items.enqueue_generation',
  'first_collection_items.cancel_reason',
  'monitoring_windows.events_pending',
  'monitoring_windows.events_write_failed',
  'monitoring_windows.events_duplicate',
];

function tmpdir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

// 真实子进程执行迁移/检查，返回 { status, stdout, stderr }
function runMigrate(dataDir, args) {
  try {
    const stdout = execFileSync(process.execPath, [MIGRATE].concat(args || []), {
      env: Object.assign({}, process.env, { ZB_DATA_DIR: dataDir }),
      encoding: 'utf8',
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout: String(stdout), stderr: '' };
  } catch (e) {
    return {
      status: typeof e.status === 'number' ? e.status : -1,
      stdout: String(e.stdout || ''),
      stderr: String(e.stderr || ''),
    };
  }
}

// 从输出中提取报告 JSON（JSON 块之后还有一行中文摘要，不能整串 parse）
function parseReport(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  assert.ok(s >= 0 && e > s, '输出中应包含报告 JSON');
  return JSON.parse(text.slice(s, e + 1));
}

// 递归全文件指纹：相对路径 → { size, mtimeMs, sha256 }（与 migrate-db.js 同口径）
function fingerprint(dir) {
  const out = {};
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    let entries = [];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { walk(childRel); continue; }
      if (!ent.isFile()) continue;
      const st = fs.statSync(path.join(dir, childRel));
      const buf = fs.readFileSync(path.join(dir, childRel));
      out[childRel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: require('crypto').createHash('sha256').update(buf).digest('hex') };
    }
  };
  walk('');
  return out;
}
function diffFp(before, after) {
  const diffs = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const b = before[k], a = after[k];
    if (!b) { diffs.push('新增文件: ' + k); continue; }
    if (!a) { diffs.push('文件消失: ' + k); continue; }
    if (b.size !== a.size) diffs.push('大小变化: ' + k);
    if (b.mtimeMs !== a.mtimeMs) diffs.push('修改时间变化: ' + k);
    if (b.sha256 !== a.sha256) diffs.push('内容变化(SHA-256): ' + k);
  }
  return diffs;
}

function scratchDirs() {
  try {
    return fs.readdirSync(os.tmpdir()).filter(f => f.startsWith('zhibi-migrate-check-')).sort();
  } catch (e) { return []; }
}

// ---------- 测试夹具助手（node:sqlite） ----------
function findDbWithTable(dir, table) {
  const { DatabaseSync } = require('node:sqlite');
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.db'))) {
    try {
      const h = new DatabaseSync(path.join(dir, f), { readOnly: true });
      const row = h.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name=?").get(table);
      h.close();
      if (row) return path.join(dir, f);
    } catch (e) { /* 打不开就换下一个库 */ }
  }
  return null;
}

// 真实删除一列（优先 ALTER DROP COLUMN，老版本 SQLite 走重建表）
function dropColumn(dbFile, table, column) {
  const { DatabaseSync } = require('node:sqlite');
  const h = new DatabaseSync(dbFile);
  try {
    const info = h.prepare('PRAGMA table_info("' + table + '")').all();
    const names = info.map(c => c.name);
    if (!names.includes(column)) return { dropped: false, reason: 'column-not-found' };
    try {
      h.prepare('ALTER TABLE "' + table + '" DROP COLUMN "' + column + '"').run();
      return { dropped: true, how: 'alter-drop' };
    } catch (e) { /* fallthrough: 老版本 SQLite 重建表 */ }
    const keep = info.filter(c => c.name !== column);
    const pk = keep.filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => '"' + c.name + '"');
    const defs = keep.map(c => {
      let d = '"' + c.name + '" ' + (c.type || '');
      if (c.notnull) d += ' NOT NULL';
      if (c.dflt_value != null) d += ' DEFAULT ' + c.dflt_value;
      return d;
    });
    if (pk.length) defs.push('PRIMARY KEY (' + pk.join(', ') + ')');
    const tmp = table + '__r3_rebuild';
    h.prepare('DROP TABLE IF EXISTS "' + tmp + '"').run();
    h.prepare('CREATE TABLE "' + tmp + '" (' + defs.join(', ') + ')').run();
    const colList = keep.map(c => '"' + c.name + '"').join(', ');
    h.prepare('INSERT INTO "' + tmp + '" (' + colList + ') SELECT ' + colList + ' FROM "' + table + '"').run();
    h.prepare('DROP TABLE "' + table + '"').run();
    h.prepare('ALTER TABLE "' + tmp + '" RENAME TO "' + table + '"').run();
    return { dropped: true, how: 'rebuild' };
  } finally { h.close(); }
}

function dropTable(dbFile, table) {
  const { DatabaseSync } = require('node:sqlite');
  const h = new DatabaseSync(dbFile);
  try { h.prepare('DROP TABLE "' + table + '"').run(); return true; } finally { h.close(); }
}

// 去掉注释后按大括号配平提取函数体（供 M6 源码结构断言）
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '未找到函数 ' + name);
  let i = src.indexOf('{', start);
  assert.ok(i >= 0, '函数体起始花括号缺失: ' + name);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('函数体花括号不配平: ' + name);
}

// ============================================================
test('M1 完整迁移后 --check：exit 0 且 8 个必需字段全部 present:true', () => {
  const dir = tmpdir('zb-r3-m1-');
  try {
    const apply = runMigrate(dir, []);
    assert.strictEqual(apply.status, 0, 'apply 应成功: ' + apply.stderr.slice(0, 500));

    const scratchBefore = scratchDirs();
    const check = runMigrate(dir, ['--check']);
    assert.strictEqual(check.status, 0, '--check 应 exit 0: ' + check.stderr.slice(0, 500));
    assert.match(check.stdout, /只读核验通过/);

    const report = parseReport(check.stdout);
    assert.deepStrictEqual(report.requiredMissing, []);
    assert.deepStrictEqual(report.requiredMissingColumns, []);
    for (const f of REQUIRED_FIELDS) {
      const [t, c] = f.split('.');
      const row = (report.sc10Columns[t] || []).find(x => x.column === c);
      assert.ok(row, '报告缺少字段条目 ' + f);
      assert.strictEqual(row.present, true, '字段应为 present:true → ' + f);
    }
    // 成功路径也清理 scratch（finally）
    assert.deepStrictEqual(scratchDirs(), scratchBefore, '成功检查后不得残留 scratch 临时目录');
  } finally { rmrf(dir); }
});

test('M2 真实删除必需字段后 --check：exit 1 且点名缺失字段', () => {
  const dir = tmpdir('zb-r3-m2-');
  try {
    assert.strictEqual(runMigrate(dir, []).status, 0, '前置迁移应成功');

    const dbFile = findDbWithTable(dir, 'first_collection_items');
    assert.ok(dbFile, '应找到含 first_collection_items 的库文件');
    const drop = dropColumn(dbFile, 'first_collection_items', 'in_scope');
    assert.strictEqual(drop.dropped, true, '测试夹具应真实删除 in_scope 列');

    const scratchBefore = scratchDirs();
    const check = runMigrate(dir, ['--check']);
    assert.strictEqual(check.status, 1, '必需字段缺失必须 exit 1（不得假通过）');

    const out = check.stdout + '\n' + check.stderr;
    assert.match(out, /first_collection_items\.in_scope/, '必须点名缺失的 表名.字段名');
    assert.match(out, /必需字段缺失/, '必须输出必需字段缺失结论');
    assert.doesNotMatch(check.stdout, /只读核验通过/, '失败时不得打印「只读核验通过」');

    const report = parseReport(check.stdout);
    assert.strictEqual(report.requiredMissingColumns.includes('first_collection_items.in_scope'), true);
    const row = report.sc10Columns.first_collection_items.find(x => x.column === 'in_scope');
    assert.strictEqual(row.present, false);
    // 失败路径也清理 scratch（finally）
    assert.deepStrictEqual(scratchDirs(), scratchBefore, '失败检查后不得残留 scratch 临时目录');
  } finally { rmrf(dir); }
});

test('M3 失败检查前后数据目录指纹逐项相同（失败检查也没改原目录）', () => {
  const dir = tmpdir('zb-r3-m3-');
  try {
    assert.strictEqual(runMigrate(dir, []).status, 0, '前置迁移应成功');
    const dbFile = findDbWithTable(dir, 'monitoring_windows');
    assert.ok(dbFile, '应找到含 monitoring_windows 的库文件');
    const drop = dropColumn(dbFile, 'monitoring_windows', 'events_pending');
    assert.strictEqual(drop.dropped, true, '测试夹具应真实删除 events_pending 列');

    const before = fingerprint(dir);
    const check = runMigrate(dir, ['--check']);
    assert.strictEqual(check.status, 1, '缺字段检查应失败');
    const after = fingerprint(dir);

    assert.deepStrictEqual(diffFp(before, after), [], '失败检查也不得修改数据目录（清单/大小/mtime/SHA-256 逐项相同）');
    assert.deepStrictEqual(Object.keys(before).length > 0, true, '指纹应非空（确认真在比对文件）');
  } finally { rmrf(dir); }
});

test('M4 缺少必需表时 --check：exit 1', () => {
  const dir = tmpdir('zb-r3-m4-');
  try {
    assert.strictEqual(runMigrate(dir, []).status, 0, '前置迁移应成功');
    const dbFile = findDbWithTable(dir, 'monitoring_windows');
    assert.ok(dbFile, '应找到含 monitoring_windows 的库文件');
    assert.strictEqual(dropTable(dbFile, 'monitoring_windows'), true);

    const check = runMigrate(dir, ['--check']);
    assert.strictEqual(check.status, 1, '缺表必须 exit 1');
    const out = check.stdout + '\n' + check.stderr;
    assert.match(out, /monitoring_windows/, '必须指出缺失的表名');
    assert.doesNotMatch(check.stdout, /只读核验通过/, '失败时不得打印「只读核验通过」');
  } finally { rmrf(dir); }
});

test('M5 无 .db 文件：exit 1 且不创建任何文件/目录', () => {
  const dir = tmpdir('zb-r3-m5-');
  try {
    const before = fingerprint(dir);
    const scratchBefore = scratchDirs();
    const check = runMigrate(dir, ['--check']);
    assert.strictEqual(check.status, 1, '无 .db 文件必须 exit 1');
    assert.match(check.stderr, /没有任何 \.db 文件/);

    assert.deepStrictEqual(fingerprint(dir), before, '数据目录必须逐字节不变');
    assert.deepStrictEqual(fs.readdirSync(dir), [], '不得在数据目录创建任何文件');
    assert.deepStrictEqual(scratchDirs(), scratchBefore, '不得创建 scratch 临时目录');
    assert.ok(fs.statSync(dir).isDirectory(), '数据目录必须仍在');
  } finally { rmrf(dir); }
});

test('M6 源码断言：字段读取先于 scratch 删除；最终判定不调用临时数据库', () => {
  const raw = fs.readFileSync(MIGRATE, 'utf8');
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const body = extractFn(stripped, 'checkMode');

  const cleanIdx = body.indexOf('rmSync(scratch');
  assert.ok(cleanIdx > 0, 'checkMode 必须包含 scratch 清理调用');
  const head = body.slice(0, cleanIdx);
  const tail = body.slice(cleanIdx);

  // 读取（列查询 / 打开库）必须全部发生在清理之前
  assert.ok(head.includes('PRAGMA table_info'), '列读取必须在 scratch 删除之前完成');
  assert.ok(head.includes('DatabaseSync'), '表清单读取必须在 scratch 删除之前完成');
  // 清理之后（报告与判定段）不得再调用任何数据库
  assert.ok(!tail.includes('DatabaseSync'), 'scratch 删除后不得再打开任何数据库');
  assert.ok(!tail.includes('PRAGMA table_info'), 'scratch 删除后不得再做列查询');
  assert.ok(!tail.includes('node:sqlite'), 'scratch 删除后不得再 require node:sqlite');
  assert.ok(!/columnCheck\s*\(/.test(tail), '判定段不得调用依赖已删除 scratch 的 columnCheck 闭包');

  // 单一清单：模块级 REQUIRED_COLUMNS 必须恰好定义 8 个必需字段
  const listIdx = stripped.indexOf('const REQUIRED_COLUMNS');
  assert.ok(listIdx >= 0, '必须定义单一清单 REQUIRED_COLUMNS');
  const listBody = stripped.slice(listIdx, stripped.indexOf('};', listIdx));
  for (const f of REQUIRED_FIELDS) {
    const col = f.split('.')[1];
    assert.ok(listBody.indexOf("'" + col + "'") >= 0, '单一清单缺少字段 ' + f);
  }

  // 行为佐证由 M1 覆盖：读取若发生在删除之后（旧 bug），present 必为 false；
  // M1 断言 8 字段全部 present:true，即行为上证明读取先于删除。
});
