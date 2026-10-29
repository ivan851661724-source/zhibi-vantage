'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.ZB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-r4g4-'));
process.env.ZB_MANUAL_INSPECT_CONCURRENCY = '2';
process.env.ZB_MANUAL_INSPECT_START_GAP_MS = '0';

const tenant = require('../services/tenant.js');
const WS = require('../services/watch-store.js');
const Manual = require('../services/watch-manual.js');
const Opportunity = require('../services/opportunity-foundation.js');
const { projFile } = require('../core/state-store.js');

function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

test('r4g4-1 项目立即巡检使用有界队列，不把全部品牌同时打向来源', async () => {
  const reg = tenant.register({ email: 'r4g4-queue@example.com', password: 'password77' });
  const tid = reg.tenant.id;
  const pid = 'r4g4-queue-project';
  const competitors = Array.from({ length: 6 }, (_, i) => ({
    id: 'brand-' + i,
    name: 'Brand ' + i,
    url: 'https://brand-' + i + '.example.com',
    isShopify: false,
  }));
  const file = projFile(pid, tid);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ competitors }));

  let active = 0;
  let maxActive = 0;
  let completed = 0;
  const siteFingerprintFn = async (comp) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await wait(35);
    active -= 1;
    completed += 1;
    return {
      ok: true,
      sourceUrl: comp.url,
      fingerprint: { title: comp.name, canonicalUrl: comp.url, headings: [comp.name], productLinks: [] },
      stability: 'stable',
      partialScan: false,
      evidenceRefs: [],
    };
  };

  const accepted = [];
  for (const comp of competitors) {
    const made = WS.createWatchTarget({
      tenantId: tid,
      projectId: pid,
      competitorId: comp.id,
      market: 'us',
      timezone: 'UTC',
      enabledSignals: ['site_change'],
      supportedSignals: ['site_change'],
      enrichmentStatus: 'complete',
    });
    accepted.push(Manual.startInspect({
      tenantId: tid,
      watchTargetId: made.target.watchTargetId,
      deps: { siteFingerprintFn },
    }));
  }

  assert.equal(accepted.filter(x => x.accepted).length, 6);
  assert.ok(accepted.every(x => x.queued === true));
  const deadline = Date.now() + 5000;
  while (Manual.queueState().inflight > 0 && Date.now() < deadline) await wait(20);
  assert.equal(completed, 6, '六个品牌全部完成，不因限流队列漏采');
  assert.ok(maxActive <= 2, '同时外呼最多两个品牌');
  assert.deepEqual(Manual.queueState(), {
    active: 0, queued: 0, inflight: 0, concurrency: 2, startGapMs: 0,
  });
});

test('r4g4-2 单条异常低价保留原始范围，但不进入市场统计', () => {
  const s = Opportunity.priceSampleStats([0.01, 10, 20, 600]);
  assert.deepEqual(s.raw, [0.01, 10, 20, 600]);
  assert.deepEqual(s.eligible, [10, 20, 600]);
  assert.equal(s.rawMin, 0.01);
  assert.equal(s.rawMax, 600);
  assert.equal(s.min, 10);
  assert.equal(s.median, 20);
  assert.equal(s.max, 600);
  assert.equal(s.excludedCount, 1);
});
