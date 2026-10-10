'use strict';
// meta-ads 单测（抓取需求 §2.5 / 算法规格 §5.4）：token 门控 / 去重 / 活跃度评级 / 缓存 / 失败口径
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-ads-test-'));
const MetaAds = require('../services/providers/meta-ads.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}
const FIXTURE = {
  data: [
    { id: '1', ad_delivery_start_time: '2026-09-01', ad_delivery_stop_time: null, ad_creative_body: 'Cold brew maker 20% off', ad_creative_link_title: 'Cold Brew Maker Pro', publisher_platforms: ['facebook', 'instagram'] },
    { id: '2', ad_delivery_start_time: '2026-06-01', ad_delivery_stop_time: '2026-07-01', ad_creative_body: '', ad_creative_link_title: '', publisher_platforms: ['facebook'] }, // 纯图无文案，已停投
    { id: '1', ad_delivery_start_time: '2026-09-01', ad_delivery_stop_time: null, ad_creative_body: 'dup', ad_creative_link_title: 'dup', publisher_platforms: [] },             // 跨平台同创意重复
  ],
};
const okFetch = async () => ({ ok: true, status: 200, json: async () => FIXTURE });

(async () => {
  const tests = [];
  const ta = (name, fn) => tests.push([name, fn]);

  ta('token 未配置 → NO_META_TOKEN（源未接入，静默未探测）', async () => {
    const r = await MetaAds.searchBrandAds('BrandX', {}, {});
    assert.equal(r.ok, false);
    assert.equal(r.error, 'NO_META_TOKEN');
  });

  ta('正常检索：去重 by id / 在投计数 / 最长持续天数 / 平台集合', async () => {
    const r = await MetaAds.searchBrandAds('BrandX', { metaAds: { token: 'T' } }, { fetchImpl: okFetch });
    assert.equal(r.ok, true);
    assert.equal(r.totalInWindow, 2, '重复 id 去重');
    assert.equal(r.activeCount, 1, '无 stop = 在投');
    assert.ok(r.longestDays >= 28, '6-01→7-01 ≈ 30 天');
    assert.deepEqual(r.platforms.sort(), ['facebook', 'instagram']);
    assert.equal(r.creatives.find(c => c.id === '2').text, '', '纯图素材 text 空（不进卖点统计）');
  });

  ta('活跃度评级：0 → none；少量 → low/medium；多在投/长持续/多平台 → high', async () => {
    assert.equal(MetaAds.activityLevelOf(0, 0, 0), 'none');
    assert.equal(MetaAds.activityLevelOf(1, 0, 1), 'low');
    assert.equal(MetaAds.activityLevelOf(5, 10, 1), 'medium');
    assert.equal(MetaAds.activityLevelOf(12, 5, 1), 'high');
    assert.equal(MetaAds.activityLevelOf(1, 60, 1), 'high', '长持续 ≥30 天 → high');
  });

  ta('API 失败：401 带 error message 上浮（不编数据）', async () => {
    const r = await MetaAds.searchBrandAds('BrandAuthFail', { metaAds: { token: 'BAD' } }, {
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: { message: 'Invalid OAuth access token' } }) }),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /META_401/);
    assert.match(r.error, /Invalid OAuth/);
  });

  ta('缓存：同品牌 24h 内不重抓', async () => {
    let calls = 0;
    const f = async () => { calls++; return { ok: true, status: 200, json: async () => ({ data: [] }) }; };
    await MetaAds.searchBrandAds('CachedBrand', { metaAds: { token: 'T' } }, { fetchImpl: f });
    await MetaAds.searchBrandAds('CachedBrand', { metaAds: { token: 'T' } }, { fetchImpl: f });
    assert.equal(calls, 1);
  });

  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok - ' + name); }
    catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + (e && e.message || e)); }
  }
  console.log('\n=== meta-ads.test: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed ? 1 : 0);
})();
