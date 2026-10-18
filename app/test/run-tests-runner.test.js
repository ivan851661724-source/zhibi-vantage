'use strict';
// Run the actual CLI orchestration with fake filesystem/children; no long sleeps.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'run-tests.js'), 'utf8');
function run(files, child) {
  const calls = []; let code; let stderr = '';
  const exit = {};
  try { vm.runInNewContext(source, {
    __dirname: path.join(__dirname, '..', 'scripts'),
    process: { execPath: 'node', stdout: { write() {} }, stderr: { write(s) { stderr += s; } }, exit(n) { code = n; throw exit; } },
    console: { log() {} }, require: id => id === 'fs' ? { readdirSync: () => files } : id === 'child_process' ? {
      execFileSync: (node, args, opts) => { calls.push({ file: path.basename(args[0]), opts }); return child(path.basename(args[0]), opts); }
    } : require(id),
  }); } catch (e) { if (e !== exit) throw e; }
  return { code, calls, stderr };
}
let failed = 0;
function t(name, fn) { try { fn(); console.log('ok - ' + name); } catch (e) { failed++; console.error('FAIL - ' + name + ': ' + e.message); } }
t('long nested suites can finish within explicit bounded budgets', () => {
  const r = run(['static-check.test.js', 'observability-remediation.test.js', 'ordinary.test.js'], (file, opts) => {
    const duration = file === 'static-check.test.js' ? 610000 : file === 'observability-remediation.test.js' ? 700000 : 100;
    if (opts.timeout < duration) throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
    assert.ok(opts.timeout <= 780000); return 'passed';
  });
  assert.equal(r.code, 0); assert.equal(r.calls.find(x => x.file === 'ordinary.test.js').opts.timeout, 60000);
});
t('real failures remain nonzero and do not skip remaining suites', () => {
  const r = run(['a.test.js', 'b.test.js'], file => { if (file === 'a.test.js') throw Object.assign(new Error('assertion'), { status: 1, stderr: 'assertion failed' }); return ''; });
  assert.equal(r.code, 1); assert.equal(r.calls.length, 2); assert.match(r.stderr, /assertion failed/);
});
t('timeout remains nonzero with its actual budget visible', () => {
  const r = run(['ordinary.test.js'], () => { throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', signal: 'SIGTERM' }); });
  assert.equal(r.code, 1); assert.match(r.stderr, /60s/);
});
process.exitCode = failed ? 1 : 0;
