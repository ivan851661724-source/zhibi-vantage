'use strict';
// ============================================================
// observability.test.js —— Phase 1「真实基线与可观测性」单元/集成测试
// 覆盖：
//   A. 脱敏：tenantId 加盐哈希不可逆、同输入稳定、跨租户不同
//   B. recordStage 白名单：未知阶段拒收、多余键（提示词/正文）物理不入库
//   C. beginRun/milestone/endRun：里程碑一次、total/all_done 正确
//   D. recordEvent：白名单 9 类、未知拒收、不保存用户输入内容
//   E. summary：样本不足返回 insufficient_sample（禁止 0 冒充）、有样本时指标形状
//   F. spawnNode：瞬态 EBUSY 重试成功 / 非瞬态失败不重试 / 使用 process.execPath
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 数据目录隔离必须先于任何业务模块 require（paths.js 缓存陷阱）
process.env.ZB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-obs-test-'));
process.env.OBS_DB_PATH = path.join(process.env.ZB_DATA_DIR, 'obs.sqlite');

const T = require('../observability/telemetry.js');
const { spawnNode } = require('../scripts/lib/spawn-node.js');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}

(async () => {

await t('A1 tenantId 哈希不可逆且稳定、不同租户不同', () => {
  const h1 = T.hashId('tenant:demo-abc');
  const h2 = T.hashId('tenant:demo-abc');
  const h3 = T.hashId('tenant:other');
  assert.ok(h1.length === 24, '24 hex');
  assert.strictEqual(h1, h2, '同输入同哈希');
  assert.notStrictEqual(h1, h3, '异输入异哈希');
  assert.ok(!h1.includes('demo'), '不可逆：哈希不含原文片段');
});

await t('B1 recordStage 白名单：未知阶段拒收、敏感键丢弃', () => {
  assert.strictEqual(T.recordStage({ stage: 'not_a_stage', tenantId: 't1' }), null, '未知阶段拒收');
  assert.strictEqual(T.recordStage({ stage: 'translate', tenantId: '' }), null, '无租户拒收');
  const id = T.recordStage({
    stage: 'translate', tenantId: 'tenant:redact-test', projectId: 'p1', durationMs: 123, status: 'ok',
    // ——以下敏感/多余键必须被入口丢弃——
    prompt: 'SECRET-PROMPT-TEXT', pageBody: 'SECRET-BODY', note: 'user private note', authorization: 'Bearer x',
  });
  assert.ok(id != null, '正常接收');
  const db = require('node:sqlite').DatabaseSync;
  const d = new db(process.env.OBS_DB_PATH);
  const row = d.prepare('SELECT * FROM stage_metrics WHERE id = ?').get(id);
  const blob = JSON.stringify(row);
  for (const bad of ['SECRET-PROMPT-TEXT', 'SECRET-BODY', 'user private note', 'Bearer x']) {
    assert.ok(!blob.includes(bad), '库中不含敏感内容: ' + bad);
  }
  assert.strictEqual(row.tenant_hash.includes('redact'), false, '租户已脱敏');
  d.close();
});

await t('C1 beginRun→milestone→endRun：total/all_done 落盘、里程碑只记一次', () => {
  T.beginRun({ runId: 'run-C1', tenantId: 'tenant:c1', projectId: 'run-C1' });
  T.milestone('run-C1', 'milestone_first_brand');
  T.milestone('run-C1', 'milestone_first_brand'); // 第二次必须被忽略
  T.endRun('run-C1', 'ok');
  const db = require('node:sqlite').DatabaseSync;
  const d = new db(process.env.OBS_DB_PATH);
  const nBrand = d.prepare("SELECT COUNT(*) AS n FROM stage_metrics WHERE run_id='run-C1' AND stage='milestone_first_brand'").get().n;
  const total = d.prepare("SELECT COUNT(*) AS n FROM stage_metrics WHERE run_id='run-C1' AND stage='total'").get().n;
  const run = d.prepare("SELECT * FROM runs WHERE run_id='run-C1'").get();
  assert.strictEqual(nBrand, 1, '里程碑幂等');
  assert.strictEqual(total, 1, 'total 一条');
  assert.ok(run.ended_at != null && run.status === 'ok', 'runs 终态');
  d.close();
});

await t('D1 recordEvent 白名单与内容不落库', () => {
  assert.strictEqual(T.recordEvent({ eventType: 'free_text_event', tenantId: 't1' }), null, '未知事件拒收');
  const ok = T.recordEvent({ eventType: 'evidence_opened', tenantId: 'tenant:ev-user', objectType: 'evidence', objectId: 'ev_123' });
  assert.ok(ok != null, '白名单事件接收');
  // 模拟恶意/误用上报：带正文内容
  T.recordEvent({ eventType: 'intelligence_viewed', tenantId: 'tenant:ev-user',
    objectType: 'page', objectId: 'x',
    note: 'USER-NOTE-CONTENT', body: 'USER-BODY-CONTENT', text: 'USER-TEXT' });
  const db = require('node:sqlite').DatabaseSync;
  const d = new db(process.env.OBS_DB_PATH);
  const rows = d.prepare('SELECT * FROM product_events').all();
  const blob = JSON.stringify(rows);
  for (const bad of ['USER-NOTE-CONTENT', 'USER-BODY-CONTENT', 'USER-TEXT', 'ev_123', 'ev-user']) {
    assert.ok(!blob.includes(bad), '事件表不含原文/明文标识: ' + bad);
  }
  assert.ok(blob.includes('evidence_opened'), '事件类型明文（受控枚举）');
  d.close();
});

await t('E1 summary 空库 → insufficient_sample（禁止 0 冒充）', () => {
  T._resetForTest();
  process.env.OBS_DB_PATH = path.join(process.env.ZB_DATA_DIR, 'obs-empty.sqlite');
  // 重新加载模块拿全新 DB
  delete require.cache[require.resolve('../observability/telemetry.js')];
  const T2 = require('../observability/telemetry.js');
  const s = T2.summary({ windowHours: 24 });
  assert.strictEqual(s.status, 'insufficient_sample', '整体 insufficient_sample');
  assert.strictEqual(s.sample.runs, 0, 'runs 计数真实为 0（sample 元信息允许）');
  assert.strictEqual(s.stages.translate, 'insufficient_sample', '阶段指标 insufficient_sample');
  assert.strictEqual(s.per_run, 'insufficient_sample', 'per_run insufficient_sample');
  assert.strictEqual(s.milestones.milestone_first_brand, 'insufficient_sample', '里程碑 insufficient_sample');
});

await t('E2 有样本时：阶段 P50/P95/成功率/重试率形状正确', () => {
  T._resetForTest();
  process.env.OBS_DB_PATH = path.join(process.env.ZB_DATA_DIR, 'obs-full.sqlite');
  delete require.cache[require.resolve('../observability/telemetry.js')];
  const T3 = require('../observability/telemetry.js');
  for (let i = 0; i < 10; i++) {
    T3.recordStage({ stage: 'translate', tenantId: 'tenant:sum', projectId: 'pr' + (i % 2), durationMs: 100 + i * 10, status: i === 9 ? 'error' : 'ok', retryCount: i === 2 ? 1 : 0 });
  }
  for (let i = 0; i < 4; i++) {
    T3.beginRun({ runId: 'r' + i, tenantId: 'tenant:sum', projectId: 'r' + i });
    T3.endRun('r' + i, 'ok');
  }
  const s = T3.summary({ windowHours: 24 });
  assert.ok(!s.status, '样本充足时无 insufficient_sample 顶层标记');
  const tr = s.stages.translate;
  assert.ok(tr && tr.count === 10, 'count=10');
  assert.ok(tr.p50_ms >= 100 && tr.p50_ms <= 190, 'p50 在数据范围内: ' + tr.p50_ms);
  assert.ok(tr.p95_ms >= tr.p50_ms, 'p95>=p50');
  assert.ok(Math.abs(tr.success_rate - 0.9) < 1e-9, '成功率 0.9');
  assert.ok(Math.abs(tr.fail_rate - 0.1) < 1e-9, '失败率 0.1');
  assert.ok(Math.abs(tr.retry_rate - 0.1) < 1e-9, '重试率 0.1');
  // 少样本阶段必须 insufficient_sample 而不是 0
  assert.strictEqual(s.stages.harvest, 'insufficient_sample', '少样本阶段 insufficient_sample');
});

await t('F1 spawnNode：瞬态 EBUSY 重试后成功', () => {
  let calls = 0;
  const fake = (file, args, opts) => {
    calls++;
    if (calls === 1) return { status: null, error: Object.assign(new Error('busy'), { code: 'EBUSY' }) };
    return { status: 0, stdout: 'fine', stderr: '' };
  };
  const r = spawnNode(['--check', 'x.js'], { spawnFn: fake });
  assert.strictEqual(r.status, 0, '第二次成功');
  assert.ok(calls >= 2, '发生了重试: ' + calls);
});

await t('F2 spawnNode：非瞬态错误不重试（ENOENT 立即返回）', () => {
  let calls = 0;
  const fake = () => { calls++; return { status: null, error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }; };
  spawnNode(['x'], { spawnFn: fake });
  assert.strictEqual(calls, 1, '不重试');
});

await t('F3 spawnNode：始终使用 process.execPath（稳定 Node 路径）', () => {
  let usedFile = '';
  const fake = (file) => { usedFile = file; return { status: 0 }; };
  spawnNode(['x'], { spawnFn: fake });
  assert.strictEqual(usedFile, process.execPath, 'file = process.execPath');
});

await t('F4 spawnNode：隔离临时目录注入 TMPDIR/TEMP/TMP（ZB_DATA_DIR 不覆盖已存在值）', () => {
  let seenEnv = null;
  const fake = (file, args, opts) => { seenEnv = opts.env; return { status: 0 }; };
  spawnNode(['x'], { spawnFn: fake, tmpRoot: '/tmp/iso-root' });
  assert.strictEqual(seenEnv.TMPDIR, '/tmp/iso-root');
  assert.strictEqual(seenEnv.TEMP, '/tmp/iso-root');
  assert.strictEqual(seenEnv.TMP, '/tmp/iso-root');
  assert.ok(seenEnv.ZB_DATA_DIR, 'ZB_DATA_DIR 有值（已存在则保留，缺省指向 tmpRoot）');
});

console.log(failed ? `\nobservability.test: ${failed} failed` : '\nobservability.test: all passed');
if (failed) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
