'use strict';
// Exercise the real sweep/deepdive with only external search, LLM and HTTP replaced.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-sweep-context-'));
process.env.ZB_DATA_DIR = tmp;
process.env.MT_STORE_PATH = path.join(tmp, 'tenants.sqlite');
const { requestScope, getTenantCtx } = require('../core/als.js');
const Store = require('../core/state-store.js');
const Snapshot = require('../research/source-snapshot.js');
const seen = [];
function replace(p, exports) { require.cache[require.resolve(p)] = { id: require.resolve(p), filename: require.resolve(p), loaded: true, exports }; }
replace('../research/search.js', { multiSourceSearch: async () => {
  const before = getTenantCtx(); await new Promise(resolve => setImmediate(resolve));
  seen.push({ kind: 'search', before, after: getTenantCtx() }); return { results: [] };
} });
replace('../research/llm.js', { llmApiKey: () => 'fake-test-key', resolveDeepModel: () => 'mock-model', deepseekJSON: async (messages, key, model, opts) => {
  await new Promise(resolve => setImmediate(resolve));
  seen.push({ kind: 'llm', scope: getTenantCtx(), opts }); return {};
} });
replace('../research/net.js', { domainOf: u => new URL(u).hostname, fetchShopifyProducts: async (url, opts) => {
  const s = Snapshot.record({ tenantId: opts && opts.tenantId, trigger: opts && opts.trigger, projectRef: opts && opts.projectRef,
    capability: 'product_catalog', provider: 'shopify_products_json', source_url: url,
    source_status: Snapshot.SOURCE_STATUS.UNAVAILABLE, error_code: 'fetch_failed', bodyBytes: null });
  seen.push({ kind: 'collect', scope: getTenantCtx(), opts, recorded: s.recorded, meta: s.meta });
  return { ok: false, error: 'fetch_failed' };
} });
const { sweepProject } = require('../research/sweep.js');
function fixture(id, tid, stateTid = tid) {
  const state = { projectId: id, tenantId: stateTid, track: 'test', competitors: [
    { id: 'brand-' + id, name: id, status: 'done', isShopify: true, url: 'https://example.com' }
  ] };
  const file = Store.projFile(id, tid);
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state));
  return { id, tenantId: tid };
}
let failures = 0;
async function t(name, fn) { try { await fn(); console.log('ok - ' + name); } catch (e) { failures++; console.error('FAIL - ' + name + ': ' + e.message); } }
(async () => {
  await t('interleaved sweeps retain raw tenant, project and monitor source attribution', async () => {
    const a = fixture('a', 'tenant:alpha', 'tenant_alpha');
    const b = fixture('b', 'tenant:beta');
    await requestScope.run('tenant:unrelated', () => Promise.all([sweepProject(a, {}), sweepProject(b, {})]));
    for (const row of seen.filter(x => x.kind === 'search')) {
      assert.ok(['tenant:alpha', 'tenant:beta'].includes(row.before)); assert.equal(row.after, row.before);
    }
    const llm = seen.filter(x => x.kind === 'llm'); assert.equal(llm.length, 2);
    for (const row of llm) {
      const project = row.scope === 'tenant:alpha' ? 'a' : 'b';
      assert.equal(row.opts.tenantId, row.scope); assert.equal(row.opts.projectId, project);
      assert.equal(row.opts.competitorId, 'brand-' + project);
    }
    // 整改 §3：收缩版 sweep 只保留 recentMoves 研究维护；价格/断货/上新等正式监控
    // 信号唯一边界是 WatchMonitor/WatchTarget——旧 sweep 不得再直抓 Shopify 目录。
    const collection = seen.filter(x => x.kind === 'collect'); assert.equal(collection.length, 0);
    assert.equal(getTenantCtx(), null);
  });
  await t('mismatched persisted tenant cannot use caller ALS or mutate either tenant', async () => {
    const p = fixture('mismatch', 'tenant:alpha', 'tenant:beta');
    const file = Store.projFile(p.id, p.tenantId); const before = fs.readFileSync(file, 'utf8');
    const n = seen.length;
    const r = await requestScope.run('tenant:beta', () => sweepProject(p, {}));
    assert.equal(r.ok, false); assert.equal(seen.length, n); assert.equal(fs.readFileSync(file, 'utf8'), before);
  });
  await t('missing project tenant cannot borrow caller ALS', async () => {
    fixture('unknown', 'tenant:beta'); const n = seen.length;
    const r = await requestScope.run('tenant:beta', () => sweepProject({ id: 'unknown' }, {}));
    assert.equal(r.ok, false); assert.equal(seen.length, n);
  });
  await t('legacy state without projectId keeps the project key for attribution and saves', async () => {
    const p = fixture('legacy', 'tenant:alpha');
    const file = Store.projFile(p.id, p.tenantId); const state = JSON.parse(fs.readFileSync(file));
    delete state.projectId; delete state.tenantId; fs.writeFileSync(file, JSON.stringify(state));
    const n = seen.length;
    assert.equal((await sweepProject(p, {})).ok, true);
    for (const row of seen.slice(n).filter(x => x.kind === 'llm')) assert.equal(row.opts.projectId, 'legacy');
    assert.equal(JSON.parse(fs.readFileSync(file)).projectId, 'legacy');
  });
  await t('mismatched state projectId is rejected without overwriting another archive', async () => {
    const p = fixture('project-mismatch', 'tenant:alpha');
    const file = Store.projFile(p.id, p.tenantId); const state = JSON.parse(fs.readFileSync(file));
    state.projectId = 'other-project'; fs.writeFileSync(file, JSON.stringify(state));
    const before = fs.readFileSync(file, 'utf8'); const n = seen.length;
    assert.equal((await sweepProject(p, {})).ok, false);
    assert.equal(seen.length, n); assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.existsSync(Store.projFile('other-project', p.tenantId)), false);
  });
  await t('timeline deepdive preserves existing tenant/project/competitor attribution', async () => {
    const p = fixture('timeline', 'tenant:alpha', 'tenant_alpha');
    const state = JSON.parse(fs.readFileSync(Store.projFile(p.id, p.tenantId)));
    const n = seen.length;
    await requestScope.run(p.tenantId, () => require('../research/deepdive.js').deepTimelineOne(state.competitors[0], state, {}));
    const row = seen.slice(n).find(x => x.kind === 'llm');
    assert.equal(row.opts.tenantId, 'tenant:alpha'); assert.equal(row.opts.projectId, 'timeline');
    assert.equal(row.opts.competitorId, 'brand-timeline');
  });
})().catch(e => { failures++; console.error(e); }).finally(() => {
  require('../services/db.js').closeDb();
  fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = failures ? 1 : 0;
});
