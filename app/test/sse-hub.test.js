'use strict';
// SSE 租户通道键归一回归测试（实证 bug：emitSSE 携带 sanitize 后的 tenant_8cf0…，
// 连接注册用 ALS RAW tenant:8cf0…，两侧桶键不一致 → scoped 业务事件全部丢失，
// 前端只能靠轮询兜底）。修复后：无论两侧传 RAW 还是 sanitized 键，必须落进同一桶。
const assert = require('node:assert');
const hub = require('../core/sse-hub.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

function fakeRes() {
  return { lines: [], write(x) { this.lines.push(x); }, on() {}, end() {} };
}
function dataLines(res) {
  return res.lines.filter(l => l.startsWith('data: ')).map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
}

t('RAW 连接 + sanitize 事件 → 同桶投递（实证 bug 场景）', () => {
  const res = fakeRes();
  const cleanup = hub.connect(res, 'tenant:8cf0aebaebd1');          // /api/stream：ALS RAW 键
  hub.emitSSE('discover_stage', { projectId: 'p1', tenantId: 'tenant_8cf0aebaebd1', stage: 'x' }); // 管线：sanitize 键
  cleanup();
  const evs = dataLines(res);
  assert.ok(evs.some(e => e.type === 'discover_stage' && e.stage === 'x'), 'scoped 事件必须送达');
});

t('反向：sanitize 连接 + RAW 事件 → 同桶投递', () => {
  const res = fakeRes();
  const cleanup = hub.connect(res, 'tenant_8cf0aebaebd1');
  hub.emitSSE('brand_found', { projectId: 'p1', tenantId: 'tenant:8cf0aebaebd1', card: { name: 'X' } });
  cleanup();
  const evs = dataLines(res);
  assert.ok(evs.some(e => e.type === 'brand_found'), 'scoped 事件必须送达');
});

t('跨租户隔离不因归一而失效（不同 hash 仍不同桶）', () => {
  const resA = fakeRes(), resB = fakeRes();
  const cA = hub.connect(resA, 'tenant:aaaaaaaaaaaaaaaa');
  const cB = hub.connect(resB, 'tenant:bbbbbbbbbbbbbbbb');
  hub.emitSSE('discover_stage', { projectId: 'pA', tenantId: 'tenant_aaaaaaaaaaaaaaaa', stage: 'only-A' });
  cA(); cB();
  assert.ok(dataLines(resA).some(e => e.type === 'discover_stage'), 'A 收到自己的事件');
  assert.ok(!dataLines(resB).some(e => e.type === 'discover_stage'), 'B 不得收到 A 的事件');
});

t('新连回放：sanitize 键写入的事件对 RAW 连接可回放', () => {
  hub.emitSSE('discover_error', { projectId: 'pR', tenantId: 'tenant_9cf0aebaebd1', code: 'TEST' });
  const res = fakeRes();
  const cleanup = hub.connect(res, 'tenant:9cf0aebaebd1');
  cleanup();
  const evs = dataLines(res);
  assert.ok(evs.some(e => e.type === 'discover_error' && e.projectId === 'pR'), '回放必须命中同一桶');
});

t('回放缓冲每租户项目数上限：超限淘汰旧项目，最新项目回放不受影响', () => {
  const tid = 'tenant:captest0001';
  const N = hub.MAX_REPLAY_PROJECTS + 4;
  for (let i = 0; i < N; i++) {
    hub.emitSSE('discover_stage', { projectId: 'pcap' + i, tenantId: tid, stage: 's' + i });
  }
  const res = fakeRes();
  const cleanup = hub.connect(res, tid); // 回放读 lastProjectByTenant → 最新项目
  cleanup();
  const evs = dataLines(res);
  assert.ok(evs.some(e => e.type === 'discover_stage' && e.stage === 's' + (N - 1)), '上限淘汰不得影响最新项目回放');
});

console.log('\n=== sse-hub.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
