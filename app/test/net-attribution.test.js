'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-net-attribution-'));
process.env.ZB_DATA_DIR = tmp;
const { fetchShopifyProducts } = require('../research/net.js');
const Snapshot = require('../research/source-snapshot.js');
const { requestScope } = require('../core/als.js');
const realFetch = global.fetch;
let failures = 0;
(async () => {
  for (const mode of ['success', 'http-error', 'parse-error', 'network-error', 'blocked']) {
    try {
      global.fetch = async raw => {
        const url = new URL(raw);
        assert.equal(url.hostname, '93.184.216.34');
        if (url.pathname === '/cart.js') return new Response('{"currency":"USD"}');
        if (mode === 'network-error') throw new Error('mock-network');
        if (mode === 'http-error') return new Response('blocked', { status: 403 });
        if (mode === 'parse-error') return new Response('broken-json');
        return new Response(JSON.stringify({ products: [{ id: 1, title: 'test', variants: [{ price: '10', available: true }] }] }));
      };
      const r = await requestScope.run('tenant:other', () => fetchShopifyProducts(mode === 'blocked' ? 'http://localhost/' : 'https://93.184.216.34/', {
        tenantId: 'tenant:owner', trigger: 'monitor', projectRef: 'project-explicit',
      }));
      assert.ok(r.snapshotId, mode + ' keeps a snapshot');
      const meta = Snapshot.getById('tenant:owner', r.snapshotId);
      assert.equal(meta.tenant.tenant_id, 'tenant:owner'); assert.equal(meta.tenant.project_ref, 'project-explicit');
      assert.equal(meta.trigger, 'monitor');
      assert.equal(Snapshot.getById('tenant:other', r.snapshotId), null);
      console.log('ok - explicit tenant/project attribution: ' + mode);
    } catch (e) { failures++; console.error('FAIL - ' + mode + ': ' + e.message); }
  }
})().catch(e => { failures++; console.error(e); }).finally(() => {
  global.fetch = realFetch; fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = failures ? 1 : 0;
});
