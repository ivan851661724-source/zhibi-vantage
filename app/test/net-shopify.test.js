'use strict';
// mapShopifyItems 单测（免费品透传修复）：
// 此前变体层 filter(n => n > 0) 把全 0 元商品整条丢弃，enrich 的 comp.freebies 恒空
// （报告-数据同源 §5 的免费品单列从未生效）。修复后：全 0 元商品保留 minPrice=0 透传，
// 混合免费+付费变体的商品仍以正价 min 为准（免费变体不拉低真实价）。
const assert = require('node:assert');
const { mapShopifyItems } = require('../research/net.js');

let passed = 0, failed = 0;
// 顺序 await 运行器：支持 async 用例（同步 fn 同样适用）——
// 同步 t() 不 await async fn，断言会在 process.exit 前被跳过（假绿）
const tests = [];
function t(name, fn) { tests.push([name, fn]); }

t('全 0 元商品保留 minPrice=0（freebies 可见，不再整条丢失）', () => {
  const items = mapShopifyItems([
    { title: 'Free Sample', product_type: 'gift', variants: [{ price: '0.00' }, { price: '0.00' }] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].minPrice, 0);
  assert.equal(items[0].maxPrice, 0);
});

t('混合免费+付费变体：正价 min 为准，免费变体不拉低真实价', () => {
  const items = mapShopifyItems([
    { title: 'Starter Kit', product_type: '', variants: [{ price: '0.00' }, { price: '29.99' }] },
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0].minPrice, 29.99);
  assert.equal(items[0].maxPrice, 29.99);
});

t('正常多变体商品：正价 min/max 照旧', () => {
  const items = mapShopifyItems([
    { title: 'Brewer', product_type: '', variants: [{ price: '49.50' }, { price: '80.00' }] },
  ]);
  assert.equal(items[0].minPrice, 49.5);
  assert.equal(items[0].maxPrice, 80);
});

t('无数值价格（空 variants / 非数字）→ 丢弃', () => {
  const items = mapShopifyItems([
    { title: 'No Variants', variants: [] },
    { title: 'Bad Price', variants: [{ price: 'abc' }] },
  ]);
  assert.equal(items.length, 0);
});

t('repPrice = 变体中位价（规格 3.1 第 2 步：引流小样最低价不拉低代表价）', () => {
  const items = mapShopifyItems([
    { title: 'Kit', variants: [{ price: '9.00' }, { price: '29.00' }, { price: '31.00' }] },   // 中位 29
    { title: 'Duo', variants: [{ price: '20.00' }, { price: '40.00' }] },                       // 偶数个 → 30
  ]);
  assert.equal(items[0].repPrice, 29);
  assert.equal(items[1].repPrice, 30);
  assert.equal(items[0].minPrice, 9);   // 区间展示字段保留
  assert.equal(items[0].maxPrice, 31);
});

t('soldOut：至少一个变体上报 available 且全 false 才算断货（字段缺失≠断货，禁推断）', () => {
  const items = mapShopifyItems([
    { title: 'A', variants: [{ price: '10', available: false }, { price: '12', available: false }] },
    { title: 'B', variants: [{ price: '10', available: true }] },
    { title: 'C', variants: [{ price: '10' }] },                    // 未上报 available → 不判定
  ]);
  assert.equal(items.length, 3);
  assert.equal(items[0].soldOut, true);
  assert.equal(items[1].soldOut, false);
  assert.equal(items[2].soldOut, false);
});

t('publishedAt 透传（上新事件佐证字段）+ 商品 id 透传（上新 ID 对比用）', () => {
  const items = mapShopifyItems([{ id: 987654, title: 'A', published_at: '2026-09-01T00:00:00Z', variants: [{ price: '10' }] }]);
  assert.equal(items[0].publishedAt, '2026-09-01T00:00:00Z');
  assert.equal(items[0].id, 987654);
  const noId = mapShopifyItems([{ title: 'B', variants: [{ price: '10' }] }]);
  assert.equal(noId[0].id, null);
});

t('默认不截断（分页全量：截尾统计/类目占比需要全量）', () => {
  const products = Array.from({ length: 80 }, (_, i) => ({ title: 'P' + i, variants: [{ price: String(i + 1) }] }));
  assert.equal(mapShopifyItems(products).length, 80);
});

t('cap 参数显式给定时截断（旧调用兼容）', () => {
  const products = Array.from({ length: 80 }, (_, i) => ({ title: 'P' + i, variants: [{ price: String(i + 1) }] }));
  assert.equal(mapShopifyItems(products, 60).length, 60);
});

t('非数组输入 → 空结果（防御）', () => {
  assert.equal(mapShopifyItems(null).length, 0);
  assert.equal(mapShopifyItems(undefined).length, 0);
});

t('SSRF：localhost / 元数据 IP 形态的站点 URL 被拒（不发起任何请求）', async () => {
  const { fetchShopifyProducts } = require('../research/net.js');
  const r1 = await fetchShopifyProducts('http://localhost:9/shop');
  assert.equal(r1.ok, false);
  assert.match(String(r1.error), /SSRF_BLOCKED/);
  const r2 = await fetchShopifyProducts('http://169.254.169.254/');
  assert.equal(r2.ok, false);
  assert.match(String(r2.error), /SSRF_BLOCKED/);
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok - ' + name); }
    catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + (e && e.message || e)); }
  }
  console.log('\n=== net-shopify.test: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed ? 1 : 0);
})();
