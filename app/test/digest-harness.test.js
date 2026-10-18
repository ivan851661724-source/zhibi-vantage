'use strict';
// Loading a test harness must not start business calls or terminate its importer.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const filename = path.join(__dirname, 'digest.test.js');
const moduleUnderTest = { exports: {} };
const exit = {};
const fakeRequire = id => {
  if (id === 'node:assert') return require(id);
  if (id === '../research/digest.js') return { buildDigestText: () => null, runDigest: () => new Promise(() => {}) };
  if (id === '../services/db.js') return { createTenant: () => ({ id: 'tenant:fake' }) };
  if (id === '../services/alerts.js') return { push() {} };
  if (id === 'os') return { tmpdir: () => '/unused-isolated-directory' };
  throw new Error('unexpected import while loading test harness: ' + id);
};
fakeRequire.main = {}; fakeRequire.resolve = id => id; fakeRequire.cache = {};
let prematureExit = false;
try {
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: moduleUnderTest, exports: moduleUnderTest.exports, require: fakeRequire,
    __dirname, process: { env: {}, exit() { prematureExit = true; throw exit; } },
    console: { log() {}, error() {} }, global: { fetch: async () => ({ ok: true }) },
  }, { filename });
} catch (e) { if (e !== exit) throw e; }
(async () => {
  assert.equal(prematureExit, false, 'import must not exit before asynchronous assertions settle');
  const { runCases } = moduleUnderTest.exports;
  let reached = false; const logs = [];
  const failed = await runCases([
    ['late rejection', async () => { await Promise.resolve(); reached = true; throw new Error('LATE_ASSERTION_FAILURE'); }],
    ['next case', async () => { await Promise.resolve(); }],
  ], { log: m => logs.push(m), error: m => logs.push(m) });
  assert.equal(reached, true); assert.equal(failed, 1);
  assert.ok(logs.some(m => /LATE_ASSERTION_FAILURE/.test(m)));
  assert.ok(logs.some(m => /ok - next case/.test(m)));
  console.log('ok - digest harness awaits rejection, records failure and continues');
})().catch(e => { console.error(e.message); process.exitCode = 1; });
