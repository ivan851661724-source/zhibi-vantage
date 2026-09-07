'use strict';
// R1 跟价闭环单测：price-history 纯函数（PRD §6：新功能各带单测；验收边界全覆盖）
const assert = require('node:assert');
const fs = require('node:fs');
const PH = require('../lib/price-history.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

t('首条快照 → 新价格发现事件（不算涨跌）', () => {
  const r = PH.applySnapshot([], { competitorId: 'c1', price: 29.99, currency: 'USD', at: '2026-09-07T00:00:00Z' });
  assert.equal(r.list.length, 1);
  assert.equal(r.event.kind, 'new-price');
  assert.equal(r.event.deltaPct, undefined);
  assert.ok(/^P-[a-z0-9]+$/.test(r.event.gid), '快照带稳定 gid（PRD R1.1）');
  assert.equal(r.event.gid, PH.applySnapshot([], { competitorId: 'c1', price: 5, currency: 'USD' }).event.gid); // 同对手同币种 gid 稳定
});

t('缺价/非法价 → 不记快照不记事件', () => {
  const r = PH.applySnapshot([{ competitorId: 'c1', price: 10, currency: 'USD' }], { competitorId: 'c1', price: null, currency: 'USD' });
  assert.equal(r.list.length, 1);
  assert.equal(r.event, null);
  const r2 = PH.applySnapshot([], { competitorId: 'c1', price: -5, currency: 'USD' });
  assert.equal(r2.list.length, 0);
  assert.equal(r2.event, null);
});

t('同价不记（不追加快照、无事件）', () => {
  const seed = [{ competitorId: 'c1', price: 29.99, currency: 'USD', display: '$29.99', at: '2026-09-06T00:00:00Z' }];
  const r = PH.applySnapshot(seed, { competitorId: 'c1', price: 29.99, currency: 'USD', at: '2026-09-07T00:00:00Z' });
  assert.equal(r.list.length, 1); // 只追加不同的值
  assert.equal(r.event, null);
});

t('变价 → changed 事件带 old/new/deltaPct（降价 12%）', () => {
  const seed = [{ competitorId: 'c1', price: 29.99, currency: 'USD', display: '$29.99', at: '2026-09-06T00:00:00Z' }];
  const r = PH.applySnapshot(seed, { competitorId: 'c1', price: 26.39, currency: 'USD', at: '2026-09-07T00:00:00Z' });
  assert.equal(r.list.length, 2); // 只追加
  assert.equal(r.event.kind, 'changed');
  assert.equal(r.event.old, 29.99);
  assert.equal(r.event.new, 26.39);
  assert.equal(r.event.deltaPct, -12); // (26.39-29.99)/29.99 = -12.004% → -12.0
});

t('跨币种不换算 → 新价格发现，绝不算涨跌', () => {
  const seed = [{ competitorId: 'c1', price: 29.99, currency: 'USD', at: '2026-09-06T00:00:00Z' }];
  const r = PH.applySnapshot(seed, { competitorId: 'c1', price: 199, currency: 'CNY', at: '2026-09-07T00:00:00Z' });
  assert.equal(r.event.kind, 'new-price');
  assert.equal(r.event.deltaPct, undefined);
  assert.ok(/币种/.test(r.event.note));
});

t('describeChange 产出 PRD 验收格式「降价 12%（$29.99→$26.39）」', () => {
  const text = PH.describeChange({ kind: 'changed', currency: 'USD', old: 29.99, new: 26.39, deltaPct: -12 }, () => '$');
  assert.equal(text, '降价 12%（$29.99→$26.39）');
  const up = PH.describeChange({ kind: 'changed', currency: 'USD', old: 10, new: 10.5, deltaPct: 5 }, () => '$');
  assert.equal(up, '涨价 5%（$10→$10.5）');
  const np = PH.describeChange({ kind: 'new-price', currency: 'USD', price: 26.39 }, () => '$');
  assert.equal(np, '新价格发现：$26.39');
});

t('previousDistinct：跳过同价找上一条不同价；跨币种返回 null（不编造）', () => {
  const list = [
    { competitorId: 'c1', price: 30, currency: 'USD', display: '$30', at: 'd1' },
    { competitorId: 'c1', price: 28, currency: 'USD', display: '$28', at: 'd2' },
    { competitorId: 'c1', price: 28, currency: 'USD', display: '$28', at: 'd3' },
  ];
  const prev = PH.previousDistinct(list, 'c1', 28, 'USD');
  assert.equal(prev.price, 30); // 跳过同价 28，回到 30
  assert.equal(PH.previousDistinct(list, 'c1', 199, 'CNY'), null); // 跨币种不比较
  assert.equal(PH.previousDistinct(list, 'ghost', 10, 'USD'), null);
});

t('historyMapForMaterials：按对手分组、每对手截尾 limit', () => {
  const list = [
    { competitorId: 'c1', price: 1, display: '$1' }, { competitorId: 'c1', price: 2, display: '$2' },
    { competitorId: 'c1', price: 3, display: '$3' }, { competitorId: 'c1', price: 4, display: '$4' },
    { competitorId: 'c2', price: 9, display: '$9' },
  ];
  const m = PH.historyMapForMaterials(list, 3);
  assert.equal(m.c1.length, 3);
  assert.equal(m.c1[0].display, '$2'); // 截掉最旧
  assert.equal(m.c2.length, 1);
});

t('deltaPctOf 边界：old=0 → null（不除零）', () => {
  assert.equal(PH.deltaPctOf(0, 10), null);
  assert.equal(PH.deltaPctOf(10, 10), 0);
});

// price-store：文件读写 + 容量截断（用隔离临时目录，不碰真实 data/）
t('price-store：save 超限截断 + load 往返（ZB_DATA_DIR 隔离）', () => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(os.tmpdir() + '/zb-ph-test-');
  process.env.ZB_DATA_DIR = tmp;
  delete require.cache[require.resolve('../core/paths.js')];
  delete require.cache[require.resolve('../research/price-store.js')];
  const store = require('../research/price-store.js');
  const big = Array.from({ length: store.MAX_PER_PROJECT + 50 }, (_, i) => ({ competitorId: 'c1', price: i, currency: 'USD', at: 't' + i }));
  const saved = store.save('tenant:test', 'proj:1', big);
  assert.equal(saved.length, store.MAX_PER_PROJECT);
  assert.equal(saved[0].at, 't50'); // 裁掉最旧 50 条
  const loaded = store.load('tenant:test', 'proj:1');
  assert.equal(loaded.length, store.MAX_PER_PROJECT);
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.ZB_DATA_DIR;
});

console.log('\n=== price-history.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
