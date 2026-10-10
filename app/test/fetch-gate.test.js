'use strict';
// fetch-gate 单测：同域节流 / 失败熔断（同步）/ robots 判定与缓存纪律（异步，fetchImpl 注入零网络）
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-gate-test-'));
const Gate = require('../services/fetch-gate.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}
function fresh() { Gate.resetForTest(); }

// ---- 同步：节流与熔断 ----
t('节流：同域第二次请求须等待（≥3s 间隔），不同域不受影响', () => {
  fresh();
  const r1 = Gate.beforeRequest('a.com', 1000000);
  assert.equal(r1.allowed, true);
  assert.equal(r1.waitMs, 0);
  const r2 = Gate.beforeRequest('a.com', 1000500); // 500ms 后
  assert.equal(r2.allowed, true);
  assert.equal(r2.waitMs, Gate.DOMAIN_INTERVAL_MS - 500);
  const r3 = Gate.beforeRequest('b.com', 1000600);
  assert.equal(r3.waitMs, 0, '不同域不排队');
});

t('节流到期恢复：间隔满 3s 后 waitMs=0', () => {
  fresh();
  Gate.beforeRequest('a.com', 1000000);
  const r = Gate.beforeRequest('a.com', 1000000 + Gate.DOMAIN_INTERVAL_MS);
  assert.equal(r.waitMs, 0);
});

t('失败熔断：连续 5 次失败 → 拒绝；到期半开恢复；成功清零', () => {
  fresh();
  for (let i = 0; i < Gate.FAIL_THRESHOLD - 1; i++) Gate.recordResult('c.com', false, 2000000);
  const before = Gate.beforeRequest('c.com', 2000000);
  assert.equal(before.allowed, true, '未达阈值不熔断');
  Gate.recordResult('c.com', false, 2000000); // 第 5 次：openedAt 注入同一假时钟
  const tripped = Gate.beforeRequest('c.com', 2000001);
  assert.equal(tripped.allowed, false);
  assert.equal(tripped.reason, 'circuit-open');
  const recovered = Gate.beforeRequest('c.com', 2000000 + Gate.CIRCUIT_MS + 1);
  assert.equal(recovered.allowed, true, '熔断到期半开恢复');
  Gate.recordResult('c.com', true);
  Gate.recordResult('c.com', false, 2000002);
  const after = Gate.beforeRequest('c.com', 2000002);
  assert.equal(after.allowed, true, '成功后失败计数清零，不误熔断');
});

// ---- 异步：robots（显式 await，防假绿） ----
const asyncTests = [];
function ta(name, fn) { asyncTests.push([name, fn]); }

ta('robots：规则判定 + 24h 缓存（同域只抓一次）', async () => {
  fresh();
  let calls = 0;
  const disallow = { ok: true, status: 200, text: async () => 'User-agent: *\nDisallow: /private/' };
  assert.equal(await Gate.robotsAllows('https://x1.com', '/private/a', async () => { calls++; return disallow; }), false);
  assert.equal(await Gate.robotsAllows('https://x1.com', '/public/a', async () => { calls++; return disallow; }), true);
  assert.equal(calls, 1, 'robots 文本走 24h 缓存');
});

ta('robots：404 = 无 robots 全允许并缓存 none；网络失败/403 → null（fail-open 不缓存）', async () => {
  fresh();
  const nf = { ok: false, status: 404, text: async () => '' };
  assert.equal(await Gate.robotsAllows('https://x2.com', '/anything', async () => nf), true, '404 全允许');
  assert.equal(await Gate.robotsAllows('https://x2.com', '/anything', async () => { throw new Error('should not be called (cached none)'); }), true, 'none 结果已缓存');
  const flaky = async () => { throw new Error('net down'); };
  assert.equal(await Gate.robotsAllows('https://x3.com', '/a', flaky), null, '不可判定 → null');
  assert.equal(await Gate.robotsAllows('https://x3.com', '/a', flaky), null, '失败不缓存，下次重试');
  const e403 = { ok: false, status: 403, text: async () => '' };
  assert.equal(await Gate.robotsAllows('https://x4.com', '/a', async () => e403), null, '403 → fail-open');
});

(async () => {
  for (const [name, fn] of asyncTests) {
    try { await fn(); passed++; console.log('  ok - ' + name); }
    catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + (e && e.message || e)); }
  }
  console.log('\n=== fetch-gate.test: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed ? 1 : 0);
})();
