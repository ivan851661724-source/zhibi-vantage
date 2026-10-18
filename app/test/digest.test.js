'use strict';
// Test-only async harness: late assertions count as failures before exit status.
async function runCases(cases, output = console) {
  let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); output.log('ok - ' + name); }
    catch (e) { failed++; output.error('FAIL - ' + name + ': ' + e.message); }
  }
  return failed;
}
async function main() {
  const assert = require('node:assert/strict');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-digest-'));
  const envKeys = ['ZB_DATA_DIR', 'MT_STORE_PATH', 'ZB_MAIL_API_URL', 'ZB_MAIL_API_KEY', 'ZB_MAIL_FROM'];
  const saved = Object.fromEntries(envKeys.map(k => [k, process.env[k]]));
  const realFetch = global.fetch;
  process.env.ZB_DATA_DIR = tmp;
  process.env.MT_STORE_PATH = path.join(tmp, 'tenants.sqlite');
  delete process.env.ZB_MAIL_API_KEY;
  delete process.env.ZB_MAIL_FROM;
  let db;
  try {
  // All business modules load after DATA isolation; no runtime config is read.
  db = require('../services/db.js');
  const Alerts = require('../services/alerts.js');
  const { buildDigestText, runDigest } = require('../research/digest.js');
  let sent = [];
  let failMail = false;
  global.fetch = async (url, opts) => {
    assert.equal(url, 'https://mail.example.invalid/send');
    await new Promise(resolve => setImmediate(resolve));
    sent.push(JSON.parse(opts.body));
    return { ok: !failMail, status: failMail ? 503 : 200 };
  };
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  let owner;
  const cases = [
    ['no recent alerts retains existing no-mail behavior (not a Coverage quiet gate)', () => {
      assert.equal(buildDigestText([]), null);
      assert.equal(buildDigestText([{ at: old, text: 'old' }]), null);
    }],
    ['recent price and move alerts render in one digest', () => {
      const text = buildDigestText([
        { at: now, type: 'price-change', competitorName: 'A', text: '降价 12%（$29.99→$26.39）' },
        { at: now, type: 'competitor-move', competitorName: 'B', moves: ['new store'] },
        { at: old, text: 'out-of-window' },
      ]);
      assert.ok(text.includes('每日竞品动态摘要'));
      assert.ok(text.includes('降价 12%（$29.99→$26.39）')); assert.ok(text.includes('B'));
      assert.ok(!text.includes('out-of-window'));
    }],
    ['unconfigured channel makes no HTTP calls', async () => {
      delete process.env.ZB_MAIL_API_URL;
      assert.equal((await runDigest()).skipped, true); assert.equal(sent.length, 0);
    }],
    ['configured digest waits for send and skips suspended, no-change and no-recipient tenants', async () => {
      process.env.ZB_MAIL_API_URL = 'https://mail.example.invalid/send';
      owner = db.createTenant({ name: 'Owner', email: 'owner@example.com' });
      db.createTenant({ name: 'No changes', email: 'quiet@example.com' });
      const missing = db.createTenant({ name: 'No recipient', email: '' });
      const suspended = db.createTenant({ name: 'Suspended', email: 'suspended@example.com' });
      db.setTenantStatus(suspended.id, 'suspended');
      for (const t of [owner, missing, suspended]) Alerts.push(t.id, { type: 'price-change', text: 'price changed' });
      assert.equal(Alerts.setSettings(owner.id, { mailTo: 'sales@example.com' }).mailTo, 'sales@example.com');
      const r = await runDigest();
      assert.equal(r.sent, 1); assert.equal(r.tenants, 3); assert.equal(r.noChange, 1); assert.equal(r.noRecipient, 1);
      assert.equal(sent.length, 1); assert.equal(sent[0].to, 'sales@example.com');
      assert.ok(sent[0].text.includes('price changed'));
      assert.ok(fs.existsSync(path.join(tmp, 'alerts', owner.id.replace(/[^a-zA-Z0-9_-]/g, '_'), 'alerts.json')));
    }],
    ['provider rejection is awaited and preserves stored alerts', async () => {
      failMail = true; sent = [];
      const count = Alerts.list(owner.id).length;
      const r = await runDigest();
      assert.equal(r.sent, 0); assert.equal(r.failed, 1); assert.equal(sent.length, 1);
      assert.equal(Alerts.list(owner.id).length, count);
    }],
    ['network rejection is awaited and preserves stored alerts', async () => {
      global.fetch = async () => { await Promise.resolve(); throw new Error('mock transport failure'); };
      const count = Alerts.list(owner.id).length;
      const r = await runDigest(); assert.equal(r.failed, 1);
      assert.equal(Alerts.list(owner.id).length, count);
    }],
  ];
    const failed = await runCases(cases);
    console.log('digest.test: ' + cases.length + ' cases, ' + failed + ' failed');
    process.exitCode = failed ? 1 : 0;
  } finally {
    global.fetch = realFetch; if (db) db.closeDb();
    // digest 路径经 watch-store（Coverage/时区）与 digest-store（幂等行）打开各自的
    // SQLite；不关闭会让 Windows 下 finally 的 rmSync 因句柄未释放而 EPERM。
    try { require('../services/watch-store.js').closeDb(); } catch (e) {}
    try { require('../services/digest-store.js').closeDb(); } catch (e) {}
    for (const k of envKeys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
module.exports = { runCases };
