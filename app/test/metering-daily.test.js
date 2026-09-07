'use strict';
// R5 单免费档单测：每租户每日 N 次全景调研配额（默认 3，可配置，可关闭）
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

function freshModules(env) {
  process.env.MT_STORE_PATH = os.tmpdir() + '/zb-quota-test-' + Date.now() + '.db';
  for (const k of Object.keys(env)) process.env[k] = env[k];
  delete require.cache[require.resolve('../services/db.js')];
  delete require.cache[require.resolve('../services/metering.js')];
  const db = require('../services/db.js');
  const metering = require('../services/metering.js');
  return { db, metering, cleanup: () => {
    db.closeDb();
    fs.rmSync(process.env.MT_STORE_PATH, { force: true });
    for (const k of Object.keys(env)) delete process.env[k];
  } };
}

t('默认限额 3 次/日：前 3 次放行、第 4 次拒绝、次日重置', () => {
  const { db, metering, cleanup } = freshModules({});
  try {
    assert.equal(metering.dailyDiscoverLimit(), 3);
    for (let i = 0; i < 3; i++) {
      assert.ok(metering.withinDailyDiscover('tenant:t1'), '第 ' + (i + 1) + ' 次应放行');
      metering.recordDailyDiscover('tenant:t1');
    }
    assert.ok(!metering.withinDailyDiscover('tenant:t1'), '第 4 次应拒绝');
    // 按天分键：昨日计数为 0 → 次日自然重置
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    assert.equal(db.getDaily('tenant:t1', 'discover'), 3);       // 今日 3 次
    assert.equal(db.getDaily('tenant:t1', 'discover', yesterday), 0); // 昨日 0 次
  } finally { cleanup(); }
});

t('值可配置：ZB_FREE_DAILY_DISCOVERS=5 → 限额 5', () => {
  const { metering, cleanup } = freshModules({ ZB_FREE_DAILY_DISCOVERS: '5' });
  try {
    assert.equal(metering.dailyDiscoverLimit(), 5);
    for (let i = 0; i < 5; i++) metering.recordDailyDiscover('tenant:t1');
    assert.ok(!metering.withinDailyDiscover('tenant:t1'));
  } finally { cleanup(); }
});

t('租户隔离：A 用满额度不影响 B', () => {
  const { metering, cleanup } = freshModules({});
  try {
    for (let i = 0; i < 3; i++) metering.recordDailyDiscover('tenant:a');
    assert.ok(!metering.withinDailyDiscover('tenant:a'));
    assert.ok(metering.withinDailyDiscover('tenant:b'));
  } finally { cleanup(); }
});

t('总开关：ZB_DAILY_QUOTA_ENABLED=0 → 全量放行', () => {
  const { metering, cleanup } = freshModules({ ZB_DAILY_QUOTA_ENABLED: '0' });
  try {
    for (let i = 0; i < 10; i++) metering.recordDailyDiscover('tenant:t1');
    assert.ok(metering.withinDailyDiscover('tenant:t1'));
  } finally { cleanup(); }
});

console.log('\n=== metering-daily.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
