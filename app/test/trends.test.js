'use strict';
// trends provider 单测：explore→interestovertime 两段流程（fetchImpl 注入零网络）+ 缓存 + 失败口径
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'trends-test-'));
const Trends = require('../services/providers/trends.js');

let passed = 0, failed = 0;
const EXPLORE_BODY = ")]}',\n" + JSON.stringify({ widgets: [{ id: 'TIMESERIES', token: 'TOK123', request: { comparisonItem: [] } }] });
const IOT_BODY = ")]}',\n" + JSON.stringify({
  default: { timelineData: [{ time: '1600000000', value: [50, 30] }, { time: '1600604800', value: [55, 35] }, { time: '1601209600', value: [60, 40] }] },
});

const tests = [];
const ta = (name, fn) => tests.push([name, fn]);

ta('两段流程：explore token → interestovertime 序列按词拆分（XSSI 前缀剥离）', async () => {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, text: async () => (calls.length === 1 ? EXPLORE_BODY : IOT_BODY) };
  };
  const r = await Trends.interestOverTime(['冷萃壶', 'BrandA'], {}, { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2, 'explore + interestovertime 各一次');
  assert.ok(calls[0].includes('/trends/api/explore'), '第一段是 explore');
  assert.ok(calls[1].includes('token=TOK123'), '第二段携带 explore 下发的 token');
  assert.equal(r.series[0].term, '冷萃壶');
  assert.deepEqual(r.series[0].values, [50, 55, 60]);
  assert.deepEqual(r.series[1].values, [30, 35, 40]);
  assert.equal(r.points, 3);
});

ta('缓存：同词组 24h 内不重抓', async () => {
  let calls = 0;
  const f = async () => { calls++; return { ok: true, status: 200, text: async () => (calls === 1 ? EXPLORE_BODY : IOT_BODY) }; };
  await Trends.interestOverTime(['CachedTrack'], {}, { fetchImpl: f });
  await Trends.interestOverTime(['CachedTrack'], {}, { fetchImpl: f });
  assert.equal(calls, 2, 'explore+iot 共 2 次，第二次全走缓存');
});

ta('explore 失败（429）→ ok:false 上浮状态码，不缓存不编数据', async () => {
  const r = await Trends.interestOverTime(['Track429'], {}, { fetchImpl: async () => ({ ok: false, status: 429 }) });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TRENDS_EXPLORE_429');
});

ta('响应缺 TIMESERIES widget → TRENDS_NO_WIDGET', async () => {
  const r = await Trends.interestOverTime(['TrackNoW'], {}, {
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => ")]}',\n" + JSON.stringify({ widgets: [{ id: 'RELATED_TOPICS', token: 'X' }] }) }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'TRENDS_NO_WIDGET');
});

ta('空词表 → NO_TERMS', async () => {
  const r = await Trends.interestOverTime([], {}, { fetchImpl: async () => { throw new Error('should not fetch'); } });
  assert.equal(r.error, 'NO_TERMS');
});

(async () => {
  for (const [name, fn] of tests) {
    try { await fn(); passed++; console.log('  ok - ' + name); }
    catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + (e && e.message || e)); }
  }
  console.log('\n=== trends.test: ' + passed + ' passed, ' + failed + ' failed ===');
  process.exit(failed ? 1 : 0);
})();
