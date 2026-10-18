'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-alert-isolation-'));
let failures = 0;
function t(name, fn) { try { fn(); console.log('ok - ' + name); } catch (e) { failures++; console.error('FAIL - ' + name + ': ' + e.message); } }
function load(file, data) {
  const filename = path.join(__dirname, '..', file); const writes = [];
  const guarded = Object.create(fs);
  for (const name of ['existsSync', 'mkdirSync', 'readFileSync', 'writeFileSync']) guarded[name] = (target, ...args) => {
    if (!path.resolve(target).startsWith(path.resolve(data) + path.sep)) throw new Error('outside isolated DATA');
    if (name === 'writeFileSync') writes.push(target);
    return fs[name](target, ...args);
  };
  let dbPath;
  const module = { exports: {} };
  const context = { module, exports: module.exports, __dirname: path.dirname(filename), process,
    require: id => id === 'fs' ? guarded : id === '../core/paths.js' ? { DATA: data } : id === 'node:sqlite' ? {
      DatabaseSync: class { constructor(p) { dbPath = p; } exec() {} prepare() { return { run() {} }; } }
    } : require(id) };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { api: module.exports, writes, dbPath: () => dbPath };
}
try {
  t('alert settings accept s and reject embedded whitespace in isolated DATA', () => {
    const { api, writes } = load('services/alerts.js', tmp);
    assert.equal(api.setSettings('tenant:test', { mailTo: 'sales@example.com' }).mailTo, 'sales@example.com');
    assert.equal(api.setSettings('tenant:test', { mailTo: 'a b@example.com' }).error, 'BAD_EMAIL');
    assert.equal(api.setSettings('tenant:test', { mailTo: 'a@test' }).error, 'BAD_EMAIL');
    assert.equal(api.setSettings('tenant:test', { mailTo: '' }).mailTo, '');
    assert.ok(writes.length >= 2); assert.ok(writes.every(p => p.startsWith(tmp + path.sep)));
    api.push('tenant:test', { text: 'test' }); assert.equal(api.list('tenant:test').length, 1);
  });
  t('cost SQLite follows DATA and retains the default filename', () => {
    for (const data of [tmp, path.join(__dirname, '..', 'data')]) {
      const m = load('services/cost.js', data); m.api.init(); assert.equal(m.dbPath(), path.join(data, 'cost.sqlite'));
    }
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = failures ? 1 : 0; }
