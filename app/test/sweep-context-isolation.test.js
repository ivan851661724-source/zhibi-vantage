'use strict';
// An inherited MT_STORE_PATH must not escape the sweep test's own DATA root.
// Every external-looking path below belongs to this disposable fixture.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-sweep-isolation-'));
const sweepTest = path.join(__dirname, 'sweep-context.test.js');
// Observe real SQLite opens in the child, including opens swallowed by sweep's
// best-effort DB mirror. Do not replace actual SQLite behavior or touch host DBs.
const probe = `
const fs = require('fs');
const path = require('path');
const sqlite = require('node:sqlite');
const sentinel = path.resolve(process.env.SWEEP_TEST_SENTINEL);
sqlite.DatabaseSync = new Proxy(sqlite.DatabaseSync, {
  construct(target, args, newTarget) {
    if (path.resolve(String(args[0])) === sentinel) fs.writeFileSync(process.env.SWEEP_TEST_MARKER, 'opened');
    return Reflect.construct(target, args, newTarget);
  }
});
require(process.env.SWEEP_TEST_FILE);
`;
let failed = 0;
try {
  for (const existing of [false, true]) {
    const name = existing ? 'existing sentinel' : 'missing sentinel';
    try {
      const sentinel = path.join(tmp, existing ? 'existing.sqlite' : 'missing.sqlite');
      const marker = path.join(tmp, existing ? 'existing-opened' : 'missing-opened');
      if (existing) {
        const db = new DatabaseSync(sentinel);
        db.exec("CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('unchanged')"); db.close();
      }
      const before = existing ? fs.readFileSync(sentinel) : null;
      execFileSync(process.execPath, ['-e', probe], {
        encoding: 'utf8', timeout: 15000,
        env: { ...process.env, MT_STORE_PATH: sentinel, SWEEP_TEST_SENTINEL: sentinel,
          SWEEP_TEST_MARKER: marker, SWEEP_TEST_FILE: sweepTest },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.equal(fs.existsSync(marker), false, 'test must not even open inherited MT_STORE_PATH');
      assert.equal(fs.existsSync(sentinel), existing, 'test must not create the inherited DB');
      if (existing) assert.deepEqual(fs.readFileSync(sentinel), before, 'existing DB bytes must remain unchanged');
      assert.equal(fs.existsSync(sentinel + '-wal'), false);
      assert.equal(fs.existsSync(sentinel + '-shm'), false);
      console.log('ok - sweep-context self-isolation: ' + name);
    } catch (e) { failed++; console.error('FAIL - ' + name + ': ' + e.message); }
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); process.exitCode = failed ? 1 : 0; }
