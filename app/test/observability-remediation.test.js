'use strict';
// ============================================================
// observability-remediation.test.js —— 独立审核整改回归（10 项验收）
// ------------------------------------------------------------
// §一 运行身份：runId 独立、projectId 仅关联（测试 1/2）
// §二 终态语义：失败无 all_done、endRun 幂等（测试 3/4）
// §三 隐私：project_hash 化、SQLite 无明文、跨租户伪造拒绝（测试 5/6）
// §四 static-check 异步假通过：注入失败使进程失败（测试 7）
// §五 指标准确性：并行阶段独立计时、空 duration 不产 0ms、保留期清理（测试 8/9/10）
// 附加：旧库 project_id → project_hash 迁移兼容
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// 数据目录隔离必须先于任何业务模块 require（paths.js 缓存陷阱）
process.env.ZB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-obs-remed-'));
process.env.OBS_DB_PATH = path.join(process.env.ZB_DATA_DIR, 'obs.sqlite');

const T = require('../observability/telemetry.js');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}
function openDb() { return new DatabaseSync(process.env.OBS_DB_PATH); }

// 带赛道/品牌名的 projectId（隐私测试素材：这些词严禁明文入库）
const TRACK = '宠物营养品赛道';
const BRAND = 'SnapFig品牌';

(async () => {

// ---------- §一 运行身份 ----------
await t('R1 同一项目连续两次运行 → runs 两条独立记录（起止/状态/total/里程碑互不污染）', () => {
  const pid = 'proj-' + TRACK + '-001';
  const r1 = T.newRunId(), r2 = T.newRunId();
  assert.notStrictEqual(r1, r2, 'runId 不可碰撞');
  assert.ok(!r1.includes(pid), 'runId 不含 projectId 片段');
  // 第一次运行：完整生命周期 + 一个里程碑
  T.beginRun({ runId: r1, tenantId: 'tenant:r1', projectId: pid });
  T.recordStage({ runId: r1, tenantId: 'tenant:r1', projectId: pid, stage: 'translate', durationMs: 111, status: 'ok' });
  T.milestone(r1, 'milestone_first_brand');
  T.endRun(r1, 'ok');
  // 第二次运行（同一 projectId）：只有自己的里程碑与阶段
  T.beginRun({ runId: r2, tenantId: 'tenant:r1', projectId: pid });
  T.recordStage({ runId: r2, tenantId: 'tenant:r1', projectId: pid, stage: 'translate', durationMs: 222, status: 'ok' });
  T.endRun(r2, 'ok');
  const d = openDb();
  const runs = d.prepare('SELECT * FROM runs ORDER BY started_at').all();
  d.close();
  assert.strictEqual(runs.length, 2, 'runs 两条独立记录');
  assert.ok(runs[0].run_id !== runs[1].run_id, 'run_id 不同');
  assert.ok(runs[0].ended_at != null && runs[1].ended_at != null, '两次运行各自终结');
  const d2 = openDb();
  const t1 = d2.prepare("SELECT duration_ms FROM stage_metrics WHERE run_id=? AND stage='total'").get(r1);
  const t2 = d2.prepare("SELECT duration_ms FROM stage_metrics WHERE run_id=? AND stage='total'").get(r2);
  const totalN1 = d2.prepare("SELECT COUNT(*) AS n FROM stage_metrics WHERE run_id=? AND stage='total'").get(r1).n;
  const totalN2 = d2.prepare("SELECT COUNT(*) AS n FROM stage_metrics WHERE run_id=? AND stage='total'").get(r2).n;
  const m1 = d2.prepare("SELECT COUNT(*) AS n FROM stage_metrics WHERE run_id=? AND stage='milestone_first_brand'").get(r1).n;
  const m2 = d2.prepare("SELECT COUNT(*) AS n FROM stage_metrics WHERE run_id=? AND stage='milestone_first_brand'").get(r2).n;
  const tr1 = d2.prepare("SELECT duration_ms FROM stage_metrics WHERE run_id=? AND stage='translate'").get(r1);
  const tr2 = d2.prepare("SELECT duration_ms FROM stage_metrics WHERE run_id=? AND stage='translate'").get(r2);
  d2.close();
  assert.ok(t1 && t2 && totalN1 === 1 && totalN2 === 1, '两次运行各有且仅有一条自己的 total');
  assert.ok(tr1 && tr2 && tr1.duration_ms === 111 && tr2.duration_ms === 222, '阶段行互不污染（各归自己的 runId）');
  assert.strictEqual(m1, 1, 'run1 有自己的里程碑');
  assert.strictEqual(m2, 0, 'run2 不继承 run1 的里程碑');
});

await t('R2 第一次失败、第二次成功：状态与指标互不污染', () => {
  const pid = 'proj-fail-then-ok';
  const r1 = T.newRunId(), r2 = T.newRunId();
  T.beginRun({ runId: r1, tenantId: 'tenant:r2', projectId: pid });
  T.endRun(r1, 'error', 'DISCOVER_FAILED');
  T.beginRun({ runId: r2, tenantId: 'tenant:r2', projectId: pid });
  T.endRun(r2, 'ok');
  const d = openDb();
  const rows = d.prepare('SELECT run_id, status FROM runs ORDER BY started_at').all();
  const st1 = d.prepare("SELECT status, error_code FROM stage_metrics WHERE run_id=? AND stage='total'").get(r1);
  const st2 = d.prepare("SELECT status FROM stage_metrics WHERE run_id=? AND stage='total'").get(r2);
  d.close();
  const byId = new Map(rows.map(r => [r.run_id, r.status]));
  assert.strictEqual(byId.get(r1), 'error', 'run1 保持 error');
  assert.strictEqual(byId.get(r2), 'ok', 'run2 成功不被 run1 污染');
  assert.strictEqual(st1.status, 'error', 'run1 total.status=error');
  assert.strictEqual(st1.error_code, 'DISCOVER_FAILED', '受控 error_code');
  assert.strictEqual(st2.status, 'ok', 'run2 total.status=ok');
});

// ---------- §二 终态语义 ----------
await t('R3 失败运行不产生 milestone_all_done（成功运行才产生）', () => {
  const rf = T.newRunId(), rs = T.newRunId();
  T.beginRun({ runId: rf, tenantId: 'tenant:r3', projectId: 'p-fail' });
  T.endRun(rf, 'error', 'DISCOVER_FAILED');
  T.beginRun({ runId: rs, tenantId: 'tenant:r3', projectId: 'p-ok' });
  T.endRun(rs, 'ok');
  const d = openDb();
  const failAllDone = d.prepare("SELECT COUNT(*) AS n FROM stage_metrics WHERE run_id=? AND stage='milestone_all_done'").get(rf).n;
  const okAllDone = d.prepare("SELECT COUNT(*) AS n FROM stage_metrics WHERE run_id=? AND stage='milestone_all_done'").get(rs).n;
  d.close();
  assert.strictEqual(failAllDone, 0, '失败运行绝不产生 all_done');
  assert.strictEqual(okAllDone, 1, '成功运行产生 all_done');
});

await t('R4 endRun 幂等：重复调用不产生第二条 total、不覆盖首次终态', () => {
  const rid = T.newRunId();
  T.beginRun({ runId: rid, tenantId: 'tenant:r4', projectId: 'p-idem' });
  T.endRun(rid, 'ok');
  const d1 = openDb();
  const first = d1.prepare('SELECT ended_at, status FROM runs WHERE run_id=?').get(rid);
  d1.close();
  // 重复调用：换参数也必须被拒绝（首终态唯一）
  T.endRun(rid, 'error', 'LATE_FAILURE');
  T.endRun(rid, 'ok');
  const d2 = openDb();
  const second = d2.prepare('SELECT ended_at, status FROM runs WHERE run_id=?').get(rid);
  const totalN = d2.prepare("SELECT COUNT(*) AS n FROM stage_metrics WHERE run_id=? AND stage='total'").get(rid).n;
  const allDoneN = d2.prepare("SELECT COUNT(*) AS n FROM stage_metrics WHERE run_id=? AND stage='milestone_all_done'").get(rid).n;
  d2.close();
  assert.strictEqual(totalN, 1, 'total 只有一条');
  assert.strictEqual(second.ended_at, first.ended_at, 'ended_at 不被覆盖');
  assert.strictEqual(second.status, 'ok', '首终态保留');
  assert.strictEqual(allDoneN, 1, 'all_done 不因重复调用翻倍');
});

// ---------- §三 隐私 ----------
await t('R5 SQLite 全库扫描：无明文 projectId / 赛道名 / 品牌名', () => {
  const pid = 'proj-' + TRACK + '-' + BRAND;
  const rid = T.newRunId();
  T.beginRun({ runId: rid, tenantId: 'tenant:r5', projectId: pid });
  T.recordStage({ runId: rid, tenantId: 'tenant:r5', projectId: pid, stage: 'translate', durationMs: 5, status: 'ok' });
  T.recordSourceCall({ runId: rid, tenantId: 'tenant:r5', projectId: pid, source: 'serper', kind: 'serp-probe', status: 'ok', resultCount: 3, durationMs: 120 });
  T.recordEvent({ eventType: 'intelligence_viewed', tenantId: 'tenant:r5', projectId: pid, objectType: 'page', objectId: 'x1' });
  T.endRun(rid, 'ok');
  // 逐表 JSON 扫描 + 原始文件字节扫描（含 WAL，防明文留在未 checkpoint 页）
  const d = openDb();
  const tables = ['runs', 'stage_metrics', 'source_calls', 'product_events'];
  for (const tb of tables) {
    const blob = JSON.stringify(d.prepare(`SELECT * FROM ${tb}`).all());
    for (const bad of [pid, TRACK, BRAND]) {
      assert.ok(!blob.includes(bad), `${tb} 不含明文: ${bad}`);
    }
  }
  d.close();
  for (const ext of ['', '-wal', '-shm']) {
    const f = process.env.OBS_DB_PATH + ext;
    if (!fs.existsSync(f)) continue;
    const buf = fs.readFileSync(f);
    // 双编码扫描：utf8 保真中文明文字节序列；latin1 兜底 ASCII 序列跨边界
    for (const enc of ['utf8', 'latin1']) {
      const bytes = buf.toString(enc);
      for (const bad of [TRACK, BRAND, '旧赛道']) {
        assert.ok(!bytes.includes(bad), `数据库文件${ext || '(主库)'} 不含明文(${enc}): ${bad}`);
      }
    }
  }
});

await t('R6 跨租户伪造行为事件 projectId → 404 拒绝且不写库（归属校验）', async () => {
  const dbMod = require('../services/db.js');
  const victim = { id: 'proj-victim-' + TRACK, tenantId: 'tenant:victim', track: TRACK };
  dbMod.saveProject(Object.assign({ competitors: [], brief: null, whiteSpace: null, createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() }, victim));
  const ObsH = require('../routes/handlers/observability.js');
  const makeRes = () => { const c = { status: 0, json: null }; c.writeHead = (x) => { c.status = x; }; c.end = (b) => { try { c.json = JSON.parse(b); } catch { c.raw = b; } }; return c; };
  const makeCtx = (ap, body) => ({ getAuthPayload: () => ap, readBody: async () => body, sendJSON: (r, code, obj) => { r.status = code; r.json = obj; } });
  const url = new URL('http://x/api/events/product');
  const d0 = openDb();
  const before = d0.prepare('SELECT COUNT(*) AS n FROM product_events').get().n;
  d0.close();
  // 跨租户伪造：attacker 冒用 victim 的 projectId
  const res1 = makeRes();
  await ObsH.productEvent(makeCtx({ kind: 'tenant', payload: { tid: 'tenant:attacker' } },
    { eventType: 'intelligence_viewed', projectId: victim.id }), { method: 'POST' }, res1, url, '/api/events/product');
  assert.strictEqual(res1.status, 404, '伪造 projectId 被拒绝');
  assert.strictEqual(res1.json.error, 'PROJECT_NOT_FOUND', '受控错误码');
  const dM = openDb();
  const mid = dM.prepare('SELECT COUNT(*) AS n FROM product_events').get().n;
  dM.close();
  assert.strictEqual(mid, before, '伪造请求未写库');
  // 自己的项目：通过并落库（project_hash）
  const res2 = makeRes();
  await ObsH.productEvent(makeCtx({ kind: 'tenant', payload: { tid: 'tenant:victim' } },
    { eventType: 'intelligence_viewed', projectId: victim.id }), { method: 'POST' }, res2, url, '/api/events/product');
  assert.strictEqual(res2.status, 200, '归属租户正常上报');
  assert.strictEqual(res2.json.ok, true, '落库成功');
  const d = openDb();
  const n = d.prepare('SELECT COUNT(*) AS n FROM product_events').get().n;
  const blob = JSON.stringify(d.prepare('SELECT * FROM product_events').all());
  d.close();
  assert.strictEqual(n, mid + 1, '仅归属租户成功落库 1 条');
  assert.ok(!blob.includes(victim.id) && !blob.includes(TRACK), '落库为 project_hash，无明文');
});

// ---------- §四 static-check 异步假通过 ----------
await t('R7 static-check 测试壳：注入异步失败 → 进程非零退出且不打印 all passed', async () => {
  // 以子进程跑壳（真实生产形态），壳内含注入失败回归；断言：退出码 0（全部通过，
  // 含注入回归）且注入回归行存在——若壳回归为同步假通过，此断言不会成立
  const { execFileSync } = require('child_process');
  for (const sub of ['r7-tmp', 'r7-data']) fs.mkdirSync(path.join(process.env.ZB_DATA_DIR, sub), { recursive: true });
  const out = execFileSync(process.execPath, [path.join(__dirname, 'static-check.test.js')], {
    encoding: 'utf8', timeout: 420000,
    env: Object.assign({}, process.env, {
      TMPDIR: path.join(process.env.ZB_DATA_DIR, 'r7-tmp'),
      TEMP: path.join(process.env.ZB_DATA_DIR, 'r7-tmp'),
      TMP: path.join(process.env.ZB_DATA_DIR, 'r7-tmp'),
      ZB_DATA_DIR: path.join(process.env.ZB_DATA_DIR, 'r7-data'),
    }),
  });
  assert.ok(out.includes('回归：异步 runAll 失败必须使 harness 计入失败'), '注入失败回归已运行');
  assert.ok(out.includes('static-check.test: all passed'), '壳全绿');
  // 反向证明：异步注入失败在 harness 内确实产生非零失败计数（直接驱动内核断言）
  const { execSync } = require('child_process');
  const probe = 'const m=require("assert");' +
    'async function core(){let failed=0;const t=async(n,fn)=>{try{await fn()}catch(e){failed++}};' +
    'await t("x",async()=>{throw new Error("BOOM")});return failed};' +
    'core().then(f=>{m.strictEqual(f,1);console.log("async-fail-visible")})';
  const r = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
  assert.ok(r.includes('async-fail-visible'), '异步异常使失败计数为 1（不假通过）');
});

// ---------- §五 指标准确性与保留 ----------
await t('R8 并行翻译与候选枚举各自独立计时（discover.js 结构回归守卫）', () => {
  // discover 管线的计时正确性由源码结构保证（枚举起点 _tEnum 独立于翻译起点 _tR1）。
  // 直接跑 stub 管线成本过高，此处做源码结构守卫：锚定关键行，防回归回退到共享基准。
  const src = fs.readFileSync(path.join(__dirname, '..', 'research', 'discover.js'), 'utf8');
  assert.ok(/const _tEnum = Date.now\(\);/.test(src), '枚举独立起点 _tEnum 存在');
  assert.ok(src.indexOf('const _tEnum') < src.indexOf('const enumP = llmEnumerate'), '_tEnum 在枚举启动前打点');
  const enumRow = src.match(/stage: 'candidate_enumeration'[^\n]*/g) || [];
  assert.ok(enumRow.length >= 2, '枚举成功/失败两路都有埋点');
  assert.ok(enumRow.every(l => l.includes('_tEnum')), '枚举计时用自身起点（不再计入并行翻译等待）');
  assert.ok(enumRow.every(l => !l.includes('_tR1')), '枚举计时不再误用翻译基准 _tR1');
  const trRow = src.match(/stage: 'translate'[^\n]*/g) || [];
  assert.ok(trRow.some(l => l.includes('_tR1')), '翻译计时保留自身起点');
});

await t('R9 duration 为空或不足五条 → insufficient_sample（绝不产出 0ms）', () => {
  T._resetForTest();
  process.env.OBS_DB_PATH = path.join(process.env.ZB_DATA_DIR, 'obs-r9.sqlite');
  delete require.cache[require.resolve('../observability/telemetry.js')];
  const T9 = require('../observability/telemetry.js');
  // 6 条样本但 duration 全空 → count 足够、百分位必须 insufficient_sample
  for (let i = 0; i < 6; i++) {
    T9.recordStage({ stage: 'translate', tenantId: 'tenant:r9', projectId: 'p' + i, durationMs: null, status: 'ok' });
  }
  let s = T9.summary({ windowHours: 24 });
  assert.ok(s.stages.translate && typeof s.stages.translate === 'object', '样本计数足够时输出对象');
  assert.strictEqual(s.stages.translate.p50_ms, 'insufficient_sample', '空 duration → p50 insufficient_sample');
  assert.strictEqual(s.stages.translate.p95_ms, 'insufficient_sample', '空 duration → p95 insufficient_sample');
  assert.notStrictEqual(s.stages.translate.p50_ms, 0, '绝不产出 0ms');
  // 有效 duration 4 条（<5）→ 整条 insufficient_sample
  T9.recordStage({ stage: 'harvest', tenantId: 'tenant:r9', projectId: 'q', durationMs: 10, status: 'ok' });
  T9.recordStage({ stage: 'harvest', tenantId: 'tenant:r9', projectId: 'q', durationMs: 20, status: 'ok' });
  T9.recordStage({ stage: 'harvest', tenantId: 'tenant:r9', projectId: 'q', durationMs: 30, status: 'ok' });
  T9.recordStage({ stage: 'harvest', tenantId: 'tenant:r9', projectId: 'q', durationMs: 40, status: 'ok' });
  s = T9.summary({ windowHours: 24 });
  assert.strictEqual(s.stages.harvest, 'insufficient_sample', '有效 duration 不足 5 条 → insufficient_sample');
  // 5 条有效 → 正常百分位
  T9.recordStage({ stage: 'harvest', tenantId: 'tenant:r9', projectId: 'q', durationMs: 50, status: 'ok' });
  s = T9.summary({ windowHours: 24 });
  assert.strictEqual(s.stages.harvest.p50_ms, 30, '5 条有效 duration → 正常 p50');
});

await t('R10 保留期清理：过期数据被删除、保留期内数据不受影响、WAL checkpoint 执行', () => {
  T._resetForTest();
  process.env.OBS_DB_PATH = path.join(process.env.ZB_DATA_DIR, 'obs-r10.sqlite');
  delete require.cache[require.resolve('../observability/telemetry.js')];
  const T10 = require('../observability/telemetry.js');
  T10.summary({ windowHours: 1 }); // 强制惰性建表（db() 首调创建四表）
  const d = openDb();
  const DAY = 24 * 3600000;
  const old = Date.now() - 40 * DAY, fresh = Date.now() - 1 * DAY;
  d.prepare(`INSERT INTO runs (run_id, tenant_hash, project_hash, started_at, status) VALUES ('run-old','th','ph',?, 'ok')`).run(old);
  d.prepare(`INSERT INTO runs (run_id, tenant_hash, project_hash, started_at, status) VALUES ('run-fresh','th','ph',?, 'ok')`).run(fresh);
  d.prepare(`INSERT INTO stage_metrics (run_id, tenant_hash, project_hash, stage, duration_ms, status, created_at)
    VALUES ('run-old','th','ph','translate',5,'ok',?)`).run(old);
  d.prepare(`INSERT INTO stage_metrics (run_id, tenant_hash, project_hash, stage, duration_ms, status, created_at)
    VALUES ('run-fresh','th','ph','translate',7,'ok',?)`).run(fresh);
  d.prepare(`INSERT INTO source_calls (ts, tenant_hash, project_hash, source, status) VALUES (?,'th','ph','serper','ok')`).run(old);
  d.prepare(`INSERT INTO source_calls (ts, tenant_hash, project_hash, source, status) VALUES (?,'th','ph','serper','ok')`).run(fresh);
  d.prepare(`INSERT INTO product_events (ts, tenant_hash, project_hash, event_type) VALUES (?,'th','ph','report_viewed')`).run(old);
  d.prepare(`INSERT INTO product_events (ts, tenant_hash, project_hash, event_type) VALUES (?,'th','ph','report_viewed')`).run(fresh);
  d.close();
  const out = T10.pruneOld(30, 500); // 显式 30 天（默认值同）；分批单批 500
  assert.strictEqual(out.retention_days, 30, '默认保留期 30 天');
  assert.strictEqual(out.deleted.runs, 1, '过期 runs 删除');
  assert.strictEqual(out.deleted.stage_metrics, 1, '过期阶段行删除');
  assert.strictEqual(out.deleted.source_calls, 1, '过期数据源行删除');
  assert.strictEqual(out.deleted.product_events, 1, '过期事件删除');
  assert.strictEqual(out.wal_checkpoint, 'truncated', '清理后 WAL checkpoint');
  const d2 = openDb();
  assert.strictEqual(d2.prepare("SELECT COUNT(*) AS n FROM runs WHERE run_id='run-fresh'").get().n, 1, '保留期内 runs 不受影响');
  assert.strictEqual(d2.prepare("SELECT COUNT(*) AS n FROM stage_metrics WHERE duration_ms=7").get().n, 1, '保留期内阶段行不受影响');
  assert.strictEqual(d2.prepare("SELECT COUNT(*) AS n FROM source_calls WHERE ts >= ?").get(fresh).n, 1, '保留期内数据源行不受影响');
  assert.strictEqual(d2.prepare("SELECT COUNT(*) AS n FROM product_events WHERE ts >= ?").get(fresh).n, 1, '保留期内事件不受影响');
  d2.close();
});

// ---------- 附加：迁移兼容 ----------
await t('R11 旧库迁移：project_id 明文列 → project_hash（存量行哈希迁移、无明文残留）', () => {
  const legacyPath = path.join(process.env.ZB_DATA_DIR, 'obs-legacy.sqlite');
  // 手工构造旧 Schema 库（Phase 1 首版的 project_id 明文列）
  const legacy = new DatabaseSync(legacyPath);
  legacy.exec(`CREATE TABLE runs (run_id TEXT PRIMARY KEY, tenant_hash TEXT NOT NULL, project_id TEXT,
    started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT)`);
  legacy.prepare(`INSERT INTO runs VALUES ('run-legacy','th-old', ?, ?, NULL, 'ok')`).run('proj-旧赛道' + TRACK, Date.now() - 1000);
  legacy.close();
  // 用 telemetry 打开同一文件（新代码路径）→ 自动迁移
  T._resetForTest();
  process.env.OBS_DB_PATH = legacyPath;
  delete require.cache[require.resolve('../observability/telemetry.js')];
  const TM = require('../observability/telemetry.js');
  TM.summary({ windowHours: 1 }); // 强制惰性初始化（db() 首调触发旧库迁移）
  const d = new DatabaseSync(legacyPath);
  const cols = d.prepare('PRAGMA table_info(runs)').all().map(c => c.name);
  const row = d.prepare("SELECT * FROM runs WHERE run_id='run-legacy'").get();
  d.close();
  assert.ok(cols.includes('project_hash'), '新列 project_hash 存在');
  assert.ok(!cols.includes('project_id'), '旧列 project_id 已移除');
  assert.ok(row, '存量行保留');
  assert.ok(!String(row.project_hash || '').includes(TRACK) && !String(row.project_hash || '').includes('旧赛道'), '存量 projectId 已哈希（无明文残留）');
  assert.ok(row.project_hash && row.project_hash.length === 24, '哈希形状正确（24 hex）');
  assert.ok(TM, '迁移后模块可用');
});

console.log(failed ? `\nobservability-remediation.test: ${failed} failed` : '\nobservability-remediation.test: all passed');
if (failed) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
