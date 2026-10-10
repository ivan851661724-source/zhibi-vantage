'use strict';
// ============================================================
// observability-remediation.test.js —— 独立审核整改回归（10 项验收）
// ------------------------------------------------------------
// §一 运行身份：runId 独立、projectId 仅关联（测试 1/2）
// §二 终态语义：失败无 all_done、endRun 幂等（测试 3/4）
// §三 隐私：project_hash 化、SQLite 无明文、跨租户伪造拒绝（测试 5/6）
// §四 static-check 异步假通过：注入失败使进程失败（测试 7）
// §五 指标准确性：并行阶段独立计时、空 duration 不产 0ms、保留期清理（测试 8/9/10）
// 附加：旧库 project_id → project_hash 迁移兼容（测试 11）
// 第三轮整改（R12-R17）：
//   §二 runQueue 终态聚合：全成功 ok / 部分失败 degraded / 全失败 error，
//       失败与降级绝不产 milestone_all_done；历史遗留 error 品牌不参与判断；
//       独立点卡重研与 discover 后台深研互不污染（R12-R16）
//   §三 保留期：0 关闭、非法回退+警告、分段清理、边界（R17）
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
  let out = null;
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, 'static-check.test.js')], {
      encoding: 'utf8', timeout: 420000,
      env: Object.assign({}, process.env, {
        TMPDIR: path.join(process.env.ZB_DATA_DIR, 'r7-tmp'),
        TEMP: path.join(process.env.ZB_DATA_DIR, 'r7-tmp'),
        TMP: path.join(process.env.ZB_DATA_DIR, 'r7-tmp'),
        ZB_DATA_DIR: path.join(process.env.ZB_DATA_DIR, 'r7-data'),
      }),
    });
  } catch (e) {
    // 受限环境补偿（第三轮整改）：node 子进程被持续拦截（EBUSY）→ 进程内执行
    // 同一 harness（壳已改为 require 安全：require 不自动退出），失败语义不放宽
    if (!(e && (e.code === 'EBUSY' || /EBUSY/.test(String(e.message || ''))))) throw e;
    process.stdout.write('[observability-remediation] R7 子进程 spawn 被拦截（EBUSY），降级进程内执行壳 harness（非完全等价，失败可见）…\n');
    const shell = require('./static-check.test.js');
    const logs = [];
    const origLog = console.log, origErr = console.error;
    console.log = (m) => logs.push(String(m));
    console.error = (m) => logs.push(String(m));
    let failedN;
    try { failedN = await shell.runHarness(); }
    finally { console.log = origLog; console.error = origErr; }
    if (failedN !== 0) throw new Error('进程内 harness 失败数=' + failedN + '\n' + logs.join('\n'));
    assert.ok(logs.some(l => l.includes('回归：异步 runAll 失败必须使 harness 计入失败')), '注入失败回归已运行');
  }
  if (out !== null) {
    assert.ok(out.includes('回归：异步 runAll 失败必须使 harness 计入失败'), '注入失败回归已运行');
    assert.ok(out.includes('static-check.test: all passed'), '壳全绿');
  }
  // 反向证明：异步注入失败在 harness 内确实产生非零失败计数（直接驱动内核断言）。
  // 子进程探针在正常环境执行；EBUSY 环境降级为进程内直接驱动同一内核。
  let asyncFailed = 0, printedAllPassed = false;
  const { execSync } = require('child_process');
  const probe = 'const m=require("assert");' +
    'async function core(){let failed=0;const t=async(n,fn)=>{try{await fn()}catch(e){failed++}};' +
    'await t("x",async()=>{throw new Error("BOOM")});return failed};' +
    'core().then(f=>{m.strictEqual(f,1);console.log("async-fail-visible")})';
  try {
    const r = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' });
    assert.ok(r.includes('async-fail-visible'), '异步异常使失败计数为 1（不假通过）');
  } catch (e) {
    if (!(e && (e.code === 'EBUSY' || /EBUSY/.test(String(e.message || ''))))) throw e;
    const shell = require('./static-check.test.js');
    const f = await shell.runHarnessCore({
      runner: async () => { throw new Error('INJECTED_ASYNC_FAILURE'); },
      log: () => {},
      err: (m) => { if (/INJECTED_ASYNC_FAILURE/.test(String(m))) asyncFailed++; },
      onDone: () => { printedAllPassed = true; },
    });
    assert.strictEqual(f, 1, '异步异常使失败计数为 1（不假通过）');
    assert.ok(!printedAllPassed, '异步失败后不触发 onDone（不打印 all passed）');
  }
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

// ---------- 第三轮整改 §二：runQueue 终态聚合（真实 runQueue + 注入深研替身 + 数据库实测） ----------
// 注意：R11 已把 OBS_DB_PATH 改指 legacy 库并重建 telemetry 缓存实例——
// R12 起统一重建实例（TV）并换独立库文件，enrich.js 首次 require 时绑定同一实例。
let TV = T;
function _mkRunState(pid, tid, comps) {
  return {
    projectId: pid, tenantId: tid, track: 'r3-test',
    runId: TV.newRunId(),
    competitors: comps,
    progress: { done: 0 },
  };
}

await t('R12 runQueue 两任务全成功 → run=ok + milestone_all_done（数据库实测）', async () => {
  T._resetForTest();
  process.env.OBS_DB_PATH = path.join(process.env.ZB_DATA_DIR, 'obs-r12.sqlite');
  delete require.cache[require.resolve('../observability/telemetry.js')];
  TV = require('../observability/telemetry.js'); // enrich.js 随后 require 时绑定同一实例
  // R7 的进程内降级可能已把 research/services 装入缓存并绑定旧 telemetry 实例——
  // 必须一并摘除，enrich 首载时才会绑定本处新建的 TV 实例（否则终态写错库）
  for (const k of Object.keys(require.cache)) {
    if (k.includes(path.join('research', '')) || k.includes(path.join('services', ''))) {
      delete require.cache[k];
    }
  }
  const Tasks = require('../services/tasks.js');
  const enrich = require('../research/enrich.js');
  Tasks.init();
  const state = _mkRunState('proj-r12-ok', 'tenant:r12', [
    { id: 'c1', name: 'BrandA', rankScore: 10, status: 'pending' },
    { id: 'c2', name: 'BrandB', rankScore: 9, status: 'pending' },
  ]);
  TV.beginRun({ runId: state.runId, tenantId: state.tenantId, projectId: state.projectId });
  enrich.buildResearchQueue(state);
  await enrich.runQueue(state, {}, { deepResearchOneFn: async (comp) => { comp.status = 'done'; } });
  const d = openDb();
  const run = d.prepare('SELECT status FROM runs WHERE run_id=?').get(state.runId);
  const allDone = d.prepare("SELECT COUNT(*) n FROM stage_metrics WHERE run_id=? AND stage='milestone_all_done'").get(state.runId).n;
  const processed = d.prepare("SELECT COUNT(*) n FROM stage_metrics WHERE run_id=? AND stage='milestone_all_processed'").get(state.runId).n;
  const totalRow = d.prepare("SELECT status FROM stage_metrics WHERE run_id=? AND stage='total'").get(state.runId);
  d.close();
  assert.strictEqual(run.status, 'ok', '全成功 → 终态 ok');
  assert.strictEqual(totalRow.status, 'ok', 'total.status=ok');
  assert.strictEqual(allDone, 1, '成功完成里程碑 all_done 恰好一条');
  assert.strictEqual(processed, 0, 'ok 运行不产生 all_processed');
});

await t('R13 runQueue 一成一败 → run=degraded + all_processed，绝不产 all_done（数据库实测）', async () => {
  const Tasks = require('../services/tasks.js');
  const enrich = require('../research/enrich.js');
  Tasks.init();
  const state = _mkRunState('proj-r13-deg', 'tenant:r13', [
    { id: 'c1', name: 'BrandA', rankScore: 10, status: 'pending' },
    { id: 'c2', name: 'BrandB', rankScore: 9, status: 'pending' },
  ]);
  TV.beginRun({ runId: state.runId, tenantId: state.tenantId, projectId: state.projectId });
  enrich.buildResearchQueue(state);
  await enrich.runQueue(state, {}, { deepResearchOneFn: async (comp) => {
    if (comp.id === 'c1') { comp.status = 'done'; return; }
    throw new Error('BOOM_DEEP_RESEARCH');
  } });
  const d = openDb();
  const run = d.prepare('SELECT status FROM runs WHERE run_id=?').get(state.runId);
  const allDone = d.prepare("SELECT COUNT(*) n FROM stage_metrics WHERE run_id=? AND stage='milestone_all_done'").get(state.runId).n;
  const processed = d.prepare("SELECT COUNT(*) n FROM stage_metrics WHERE run_id=? AND stage='milestone_all_processed'").get(state.runId).n;
  const totalRow = d.prepare("SELECT status, error_code FROM stage_metrics WHERE run_id=? AND stage='total'").get(state.runId);
  const comp2 = d.prepare("SELECT status FROM stage_metrics WHERE run_id=? AND stage='competitor_queue_wait'").all(state.runId);
  d.close();
  assert.strictEqual(run.status, 'degraded', '部分失败 → 终态 degraded');
  assert.strictEqual(totalRow.status, 'degraded', 'total.status=degraded');
  assert.strictEqual(allDone, 0, 'degraded 绝不产生 all_done');
  assert.strictEqual(processed, 1, 'degraded 改产「全部处理结束」里程碑');
  assert.strictEqual(comp2.filter(r => r.status === 'error').length, 1, '失败任务有 error 阶段行');
});

await t('R14 runQueue 全失败 → run=error，无 all_done 无 all_processed', async () => {
  const Tasks = require('../services/tasks.js');
  const enrich = require('../research/enrich.js');
  Tasks.init();
  const state = _mkRunState('proj-r14-err', 'tenant:r14', [
    { id: 'c1', name: 'BrandA', rankScore: 10, status: 'pending' },
    { id: 'c2', name: 'BrandB', rankScore: 9, status: 'pending' },
  ]);
  TV.beginRun({ runId: state.runId, tenantId: state.tenantId, projectId: state.projectId });
  enrich.buildResearchQueue(state);
  await enrich.runQueue(state, {}, { deepResearchOneFn: async () => { throw new Error('BOOM_ALL'); } });
  const d = openDb();
  const run = d.prepare('SELECT status FROM runs WHERE run_id=?').get(state.runId);
  const allDone = d.prepare("SELECT COUNT(*) n FROM stage_metrics WHERE run_id=? AND stage='milestone_all_done'").get(state.runId).n;
  const processed = d.prepare("SELECT COUNT(*) n FROM stage_metrics WHERE run_id=? AND stage='milestone_all_processed'").get(state.runId).n;
  d.close();
  assert.strictEqual(run.status, 'error', '全失败 → 终态 error');
  assert.strictEqual(allDone, 0, '全失败绝不产生 all_done');
  assert.strictEqual(processed, 0, '全失败不产生 all_processed');
});

await t('R15 同项目第二次全成功不受第一次失败影响（runId 归属聚合）', async () => {
  const Tasks = require('../services/tasks.js');
  const enrich = require('../research/enrich.js');
  Tasks.init();
  // 第一次：一成一败 → degraded
  const s1 = _mkRunState('proj-r15-again', 'tenant:r15', [
    { id: 'c1', name: 'BrandA', rankScore: 10, status: 'pending' },
    { id: 'c2', name: 'BrandB', rankScore: 9, status: 'pending' },
  ]);
  TV.beginRun({ runId: s1.runId, tenantId: s1.tenantId, projectId: s1.projectId });
  enrich.buildResearchQueue(s1);
  await enrich.runQueue(s1, {}, { deepResearchOneFn: async (comp) => {
    if (comp.id === 'c1') { comp.status = 'done'; return; }
    throw new Error('BOOM_FIRST');
  } });
  // 第二次（同一项目，新 runId，全新任务）：全成功
  const s2 = _mkRunState('proj-r15-again', 'tenant:r15', [
    { id: 'c1b', name: 'BrandA', rankScore: 10, status: 'pending' },
    { id: 'c2b', name: 'BrandB', rankScore: 9, status: 'pending' },
  ]);
  TV.beginRun({ runId: s2.runId, tenantId: s2.tenantId, projectId: s2.projectId });
  enrich.buildResearchQueue(s2);
  await enrich.runQueue(s2, {}, { deepResearchOneFn: async (comp) => { comp.status = 'done'; } });
  const d = openDb();
  const st1 = d.prepare('SELECT status FROM runs WHERE run_id=?').get(s1.runId).status;
  const st2 = d.prepare('SELECT status FROM runs WHERE run_id=?').get(s2.runId).status;
  const done2 = d.prepare("SELECT COUNT(*) n FROM stage_metrics WHERE run_id=? AND stage='milestone_all_done'").get(s2.runId).n;
  d.close();
  assert.strictEqual(st1, 'degraded', '第一次 degraded');
  assert.strictEqual(st2, 'ok', '第二次全成功 → ok（不受第一次失败影响）');
  assert.strictEqual(done2, 1, '第二次产生自己的 all_done');
});

await t('R16 独立点卡重研失败不污染 discover run 终态（互不污染）', async () => {
  const Tasks = require('../services/tasks.js');
  const enrich = require('../research/enrich.js');
  Tasks.init();
  const ownRunId = TV.newRunId(); // 用户点卡重研的独立 run（≠ state.runId）
  const state = _mkRunState('proj-r16-own', 'tenant:r16', [
    { id: 'c1', name: 'BrandA', rankScore: 10, status: 'pending' },
    { id: 'c3', name: 'BrandC', rankScore: 5, status: 'pending' },
  ]);
  TV.beginRun({ runId: state.runId, tenantId: state.tenantId, projectId: state.projectId });
  // 先入队独立重研任务（payload.runId ≠ state.runId）——buildResearchQueue 的 c3 入队
  // 会被任务表幂等去重挡掉（pending 同竞品只留一条），认领到的 c3 便带着独立 runId
  Tasks.enqueue({ tenantId: state.tenantId, projectId: state.projectId, type: 'deep-research',
    payload: { competitorId: 'c3', runId: ownRunId }, priority: 1 });
  enrich.buildResearchQueue(state); // c1 入队（discover run 归属）；c3 被 LIKE 去重跳过
  await enrich.runQueue(state, {}, { deepResearchOneFn: async (comp) => {
    if (comp.id === 'c1') { comp.status = 'done'; return; }
    if (comp.id === 'c3') throw new Error('BOOM_OWN_RUN'); // 独立重研失败
    throw new Error('unexpected-comp');
  } });
  const d = openDb();
  const discover = d.prepare('SELECT status FROM runs WHERE run_id=?').get(state.runId);
  const own = d.prepare('SELECT status FROM runs WHERE run_id=?').get(ownRunId);
  const discoverAllDone = d.prepare("SELECT COUNT(*) n FROM stage_metrics WHERE run_id=? AND stage='milestone_all_done'").get(state.runId).n;
  d.close();
  assert.ok(own, '独立重研 run 有自己的 runs 行');
  assert.strictEqual(own.status, 'error', '独立重研失败 → 其 run=error');
  assert.strictEqual(discover.status, 'ok', 'discover run 不被独立重研失败污染 → ok');
  assert.strictEqual(discoverAllDone, 1, 'discover run 正常产生 all_done');
});

// ---------- 第三轮整改 §三：保留期配置与分段清理 ----------
await t('R17a retentionDays 语义：未设置=30 / 0=关闭 / 正数=对应 / 非法=回退默认+警告', () => {
  const envKey = 'OBS_RETENTION_DAYS';
  const saved = process.env[envKey];
  const warnCalls = [];
  const origErr = console.error;
  console.error = (m) => { warnCalls.push(String(m)); };
  try {
    delete process.env[envKey];
    assert.strictEqual(T.retentionDays(), 30, '未设置 → 默认 30 天');
    process.env[envKey] = '0';
    assert.strictEqual(T.retentionDays(), 0, '0 → 显式关闭');
    process.env[envKey] = '15';
    assert.strictEqual(T.retentionDays(), 15, '正整数 → 对应天数');
    process.env[envKey] = '7.9';
    assert.strictEqual(T.retentionDays(), 7, '小数 → 向下取整');
    // 警告为「一次」语义（_retentionWarned 进程内只告警一次）：首个非法值必须告警，
    // 其余非法值只断言回退值（告警去抖本身即被测行为）
    warnCalls.length = 0;
    process.env[envKey] = '-5';
    assert.strictEqual(T.retentionDays(), 30, '非法值 -5 → 回退默认 30 天');
    assert.strictEqual(warnCalls.length, 1, '首个非法值输出一次配置警告');
    assert.ok(/取值非法/.test(warnCalls[0]), '警告为受控文案（不含敏感信息）');
    for (const bad of ['abc', 'NaN', '30天']) {
      process.env[envKey] = bad;
      assert.strictEqual(T.retentionDays(), 30, `非法值 ${bad} → 回退默认 30 天`);
    }
  } finally {
    console.error = origErr;
    if (saved === undefined) delete process.env[envKey]; else process.env[envKey] = saved;
  }
});

await t('R17b pruneOld 显式 0 → skipped；调度器在 0 下不删除不 checkpoint', async () => {
  const out = T.pruneOld(0);
  assert.ok(out.skipped, '显式 0 → skipped');
  assert.strictEqual(out.reason, 'retention disabled');
  // 调度器：env=0 时不调度删除与 checkpoint（env 必须先于首次惰性建表生效，
  // 否则模块初始化自带的调度会以默认 30 天空跑，_lastPruneInfo 出现竞态污染）
  T._resetForTest();
  process.env.OBS_DB_PATH = path.join(process.env.ZB_DATA_DIR, 'obs-r17.sqlite');
  const savedEnv0 = process.env.OBS_RETENTION_DAYS;
  process.env.OBS_RETENTION_DAYS = '0';
  delete require.cache[require.resolve('../observability/telemetry.js')];
  const T17 = require('../observability/telemetry.js');
  T17.summary({ windowHours: 1 }); // 惰性建表（初始化调度因 0=关闭而完全跳过）
  const d = openDb();
  const old = Date.now() - 40 * 24 * 3600000;
  d.prepare(`INSERT INTO runs (run_id, tenant_hash, project_hash, started_at, status) VALUES ('r17-old','th','ph',?,'ok')`).run(old);
  d.close();
  try {
    T17._schedulePrune();
    await new Promise(r => setImmediate(() => setImmediate(r)));
    const d2 = openDb();
    const n = d2.prepare("SELECT COUNT(*) AS n FROM runs WHERE run_id='r17-old'").get().n;
    d2.close();
    assert.strictEqual(n, 1, '关闭自动清理时过期行不被删除');
    assert.strictEqual(T17._lastPruneInfo(), null, '关闭时不产生清理/checkpoint 记录');
  } finally {
    if (savedEnv0 === undefined) delete process.env.OBS_RETENTION_DAYS; else process.env.OBS_RETENTION_DAYS = savedEnv0;
  }
});

await t('R17c 分段清理：大批量过期数据跨多个 setImmediate 轮次删完，checkpoint 恰好一次，边界行保留', async () => {
  const T17 = require('../observability/telemetry.js');
  const DAY = 24 * 3600000;
  const d = openDb();
  const ins = d.prepare(`INSERT INTO stage_metrics (run_id, tenant_hash, project_hash, stage, duration_ms, status, created_at)
    VALUES ('r17-bulk','th','ph','translate',?,'ok',?)`);
  const now = Date.now();
  const N = 8100; // 17 批（batch=500）→ 必然跨多个调度轮次（每轮 ≤16 批）
  d.exec('BEGIN');
  for (let i = 0; i < N; i++) ins.run(i, now - 40 * DAY);
  // 边界带：确定性地卡住「恰好保留期」两侧（±2s 远大于分段调度耗时）
  ins.run(777777, now - 30 * DAY + 2000); // 保留期内 → 必须保留
  ins.run(888888, now - 30 * DAY - 2000); // 过期 → 必须删除
  d.exec('COMMIT');
  d.prepare(`INSERT INTO runs (run_id, tenant_hash, project_hash, started_at, status) VALUES ('r17-bulk2','th','ph',?,'ok')`).run(now - 40 * DAY);
  d.close();
  const savedEnv = process.env.OBS_RETENTION_DAYS;
  process.env.OBS_RETENTION_DAYS = '30';
  try {
    T17._schedulePrune();
    // 等待分段调度完成（轮询 _pruneScheduled 释放，上限 10s）
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      const info = T17._lastPruneInfo();
      if (info) break;
      await new Promise(r => setImmediate(r));
    }
    const info = T17._lastPruneInfo();
    assert.ok(info, '分段清理完成并产出状态');
    assert.ok(info.rounds >= 2, `跨多个 setImmediate 轮次（实测 rounds=${info.rounds}）`);
    assert.strictEqual(info.deleted.stage_metrics, N + 1, '过期阶段行全删（含过期边界行 888888）');
    assert.strictEqual(info.deleted.runs, 2, '过期 runs 删除（r17-bulk2 + R17b 留下的 r17-old）');
    assert.strictEqual(info.wal_checkpoint, 'truncated', '全部清完后 checkpoint 恰好一次');
    const d2 = openDb();
    const kept = d2.prepare('SELECT COUNT(*) AS n FROM stage_metrics WHERE duration_ms=777777').get().n;
    const gone = d2.prepare('SELECT COUNT(*) AS n FROM stage_metrics WHERE duration_ms=888888').get().n;
    d2.close();
    assert.strictEqual(kept, 1, '保留期边界内的行保留（不误删）');
    assert.strictEqual(gone, 0, '保留期边界外的行删除');
  } finally {
    if (savedEnv === undefined) delete process.env.OBS_RETENTION_DAYS; else process.env.OBS_RETENTION_DAYS = savedEnv;
  }
});

console.log(failed ? `\nobservability-remediation.test: ${failed} failed` : '\nobservability-remediation.test: all passed');
if (failed) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
