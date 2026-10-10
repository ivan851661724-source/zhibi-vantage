'use strict';
// stock-store 单测：断货/上新滞回状态的持久化（隔离 ZB_DATA_DIR，不污染真实 data/）
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-store-test-'));
const Store = require('../research/stock-store.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

t('entryOf：缺省条目带空 productIds 与零 streak', () => {
  const map = {};
  const e = Store.entryOf(map, 'c1');
  assert.deepEqual(e, { productIds: [], soldOutStreak: 0, updatedAt: null });
  assert.ok(map.c1, '应写回 map（引用语义）');
});

t('save/load 往返：streak 与 productIds 不丢', () => {
  const map = Store.load('tenant:x', 'p1');
  const e = Store.entryOf(map, 'c1');
  e.soldOutStreak = 2;
  e.productIds = [1, 2, 3];
  e.updatedAt = 12345;
  Store.save('tenant:x', 'p1', map);
  const again = Store.load('tenant:x', 'p1');
  assert.equal(again.c1.soldOutStreak, 2);
  assert.deepEqual(again.c1.productIds, [1, 2, 3]);
});

t('save 超限截断：按 updatedAt 保留最新 MAX_PER_PROJECT 个竞品', () => {
  const map = {};
  for (let i = 0; i < Store.MAX_PER_PROJECT + 10; i++) {
    map['c' + i] = { productIds: [i], soldOutStreak: 0, updatedAt: i };
  }
  const out = Store.save('tenant:y', 'p2', map);
  assert.equal(Object.keys(out).length, Store.MAX_PER_PROJECT);
  assert.ok(out['c' + (Store.MAX_PER_PROJECT + 9)], '最新的应保留');
  assert.ok(!out.c0, '最旧的应被裁掉');
});

t('坏文件/缺目录：load 返回空对象不抛', () => {
  fs.writeFileSync(Store.fileOf('tenant:z', 'bad'), '{not json');
  assert.deepEqual(Store.load('tenant:z', 'bad'), {});
  assert.deepEqual(Store.load('tenant:z', 'missing-file'), {});
});

console.log('\n=== stock-store.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
