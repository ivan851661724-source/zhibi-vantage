'use strict';
// ============================================================
// test/deploy-backup.test.js —— deploy-staging.sh 备份可靠性与失败语义
// ------------------------------------------------------------
// D1  备份复制失败 → 迁移与构建均未执行；旧服务被重启；失败步骤被明确打印
// D2  后续步骤（迁移）失败 → 旧服务被重启；失败步骤 5-migrate 被打印
// D3  正常路径 → 整树备份 + manifest（数量/总字节/SHA-256）+ 当场复核通过；
//     瞬时文件（锁/日志）不进快照；恢复必需文件（db/-wal/-shm/json/盐值/子目录）齐全
//
// 手法：在临时目录搭一个假 APP_DIR（git 仓库 + 桩 migrate-db.js），
// 通过 PATH 注入垫片（cp / npx / curl）确定性地制造失败或记录调用，绝不碰真实环境。
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
const DEPLOY = path.join(REPO, 'scripts', 'deploy-staging.sh');
// Windows 反斜杠路径进 shell 会被当转义符吞掉 → 统一转 POSIX 斜杠
const posix = (p) => String(p).replace(/\\/g, '/');

function sh(cmd, opts) { return spawnSync('sh', ['-c', cmd], Object.assign({ encoding: 'utf8' }, opts || {})); }

// 搭建假部署环境：返回各路径
function makeEnv(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-deploy-' + tag + '-'));
  const app = path.join(root, 'app');
  const data = path.join(root, 'data');
  const backup = path.join(root, 'backups');
  const shim = path.join(root, 'shim');
  fs.mkdirSync(app, { recursive: true });
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(app, 'web'), { recursive: true });
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(backup, { recursive: true });
  fs.mkdirSync(shim, { recursive: true });
  fs.copyFileSync(DEPLOY, path.join(app, 'scripts', 'deploy-staging.sh'));

  // 数据目录夹具：db 三件套 + json + 盐值 + 子目录调研档案 + 运行期瞬时文件
  fs.writeFileSync(path.join(data, 'brands.db'), 'DB-CONTENT-1');
  fs.writeFileSync(path.join(data, 'brands.db-wal'), 'WAL-CONTENT');
  fs.writeFileSync(path.join(data, 'brands.db-shm'), 'SHM-CONTENT');
  fs.writeFileSync(path.join(data, 'config.json'), '{"a":1}');
  fs.writeFileSync(path.join(data, 'current.json'), '{"id":"p1"}');
  fs.writeFileSync(path.join(data, '.obs-salt'), 'SALT');
  fs.writeFileSync(path.join(data, '.jwt-secret'), 'JWT');
  fs.mkdirSync(path.join(data, 'research', 'tenant_x'), { recursive: true });
  fs.writeFileSync(path.join(data, 'research', 'tenant_x', 'p1.json'), '{"projectId":"p1"}');
  fs.writeFileSync(path.join(data, '.server-lock'), 'LOCK');   // 瞬时：不进快照
  fs.writeFileSync(path.join(data, 'run.log'), 'LOG');          // 瞬时：不进快照

  // 桩 migrate-db.js：落 MIGRATE_MARKER；MIGRATE_FAIL=1 时失败
  fs.writeFileSync(path.join(app, 'scripts', 'migrate-db.js'),
    "const fs=require('fs');\n"
    + "fs.writeFileSync(process.env.MIGRATE_MARKER, 'ran');\n"
    + "if (process.env.MIGRATE_FAIL === '1') { console.error('stub migrate failed'); process.exit(1); }\n"
    + "console.log('stub migrate ok');\n");

  // git 仓库（step 1 要求干净提交）
  sh('git init -q . && git add -A && git -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -qm fixture', { cwd: app });
  const head = sh('git rev-parse HEAD', { cwd: app }).stdout.trim();

  // PATH 垫片目录
  const realCp = sh('command -v cp').stdout.trim() || '/usr/bin/cp';
  // cp：FAIL_CP=1 且参数含 BACKUP 路径 → 失败；否则放行真 cp
  fs.writeFileSync(path.join(shim, 'cp'),
    '#!/bin/sh\n'
    + 'if [ "$FAIL_CP" = "1" ]; then\n'
    + '  for a in "$@"; do case "$a" in *"$BACKUP_DIR"*) echo "simulated cp failure: $a" >&2; exit 1;; esac; done\n'
    + 'fi\n'
    + 'exec ' + realCp + ' "$@"\n');
  // npx：记录到 NPX_LOG（验证构建是否被执行）
  fs.writeFileSync(path.join(shim, 'npx'),
    '#!/bin/sh\necho "npx $*" >> "$NPX_LOG"\nexit 0\n');
  // curl：健康检查一律成功（避免真实网络）
  fs.writeFileSync(path.join(shim, 'curl'),
    '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(shim, 'cp'), 0o755);
  fs.chmodSync(path.join(shim, 'npx'), 0o755);
  fs.chmodSync(path.join(shim, 'curl'), 0o755);

  const startMarker = path.join(root, 'START_MARKER');
  const stopMarker = path.join(root, 'STOP_MARKER');
  const migrateMarker = path.join(root, 'MIGRATE_MARKER');
  const npxLog = path.join(root, 'NPX_LOG');

  const baseEnv = Object.assign({}, process.env, {
    APP_DIR: posix(app), DATA_DIR: posix(data), BACKUP_DIR: posix(backup),
    STOP_CMD: 'touch ' + posix(stopMarker),
    START_CMD: 'touch ' + posix(startMarker),
    SKIP_INSTALL: '1',
    MIGRATE_MARKER: posix(migrateMarker),
    NPX_LOG: posix(npxLog),
    PATH: posix(shim) + path.delimiter + process.env.PATH,
  });
  return { root, app, data, backup, shim, head, startMarker, stopMarker, migrateMarker, npxLog, baseEnv };
}

function runDeploy(env, extra) {
  const e = Object.assign({}, env.baseEnv, extra || {});
  const r = spawnSync('sh', [path.join(env.app, 'scripts', 'deploy-staging.sh')], { encoding: 'utf8', env: e });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

// ============================================================
// D1：备份复制失败 → 迁移与构建均未执行；旧服务重启；失败步骤打印
// ============================================================
test('D1 备份复制失败：迁移与构建均未执行，旧服务被重启，失败步骤明确打印', () => {
  const env = makeEnv('d1');
  const r = runDeploy(env, { FAIL_CP: '1' });
  assert.notStrictEqual(r.code, 0, '部署必须失败: ' + r.out.slice(-300));
  assert.match(r.out, /FAILED at step: 3-backup|部署失败于步骤：3-backup/, '明确打印失败步骤');
  assert.ok(!fs.existsSync(env.migrateMarker), '迁移未执行');
  assert.ok(!fs.existsSync(env.npxLog), '构建未执行');
  assert.ok(fs.existsSync(env.startMarker), '旧服务被重新启动（不得静默停机）');
  assert.match(r.out, /尝试重新启动服务/, '打印重启动作');
});

// ============================================================
// D2：后续步骤（迁移）失败 → 旧服务重启；失败步骤打印
// ============================================================
test('D2 迁移步骤失败：部署中止、旧服务重启、失败步骤 5-migrate 明确打印', () => {
  const env = makeEnv('d2');
  const r = runDeploy(env, { MIGRATE_FAIL: '1' });
  assert.notStrictEqual(r.code, 0, '部署必须失败');
  assert.match(r.out, /部署失败于步骤：5-migrate/, '明确打印失败步骤');
  assert.ok(fs.existsSync(env.migrateMarker), '迁移确实执行过（失败点在迁移自身）');
  assert.ok(!fs.existsSync(env.npxLog), '迁移失败后构建不再执行');
  assert.ok(fs.existsSync(env.startMarker), '旧服务被重新启动');
});

// ============================================================
// D3：正常路径 → 整树备份 + manifest + 当场复核 + 瞬时文件排除
// ============================================================
test('D3 正常路径：整树备份齐全（db/-wal/-shm/json/盐值/子目录），manifest 与 SHA-256 复核通过，瞬时文件排除', () => {
  const env = makeEnv('d3');
  const r = runDeploy(env, { SKIP_SMOKE: '1' });
  assert.strictEqual(r.code, 0, '部署应成功: ' + r.out.slice(-500));
  assert.ok(fs.existsSync(env.migrateMarker), '迁移已执行');
  assert.ok(fs.existsSync(env.npxLog), '构建已执行');
  assert.ok(fs.existsSync(env.startMarker), '服务已启动');

  // 找到唯一快照目录
  const snaps = fs.readdirSync(env.backup);
  assert.strictEqual(snaps.length, 1, '恰好一个快照: ' + snaps.join(','));
  const snap = path.join(env.backup, snaps[0]);
  // 恢复必需文件齐全
  for (const rel of ['brands.db', 'brands.db-wal', 'brands.db-shm', 'config.json', 'current.json', '.obs-salt', '.jwt-secret', 'research/tenant_x/p1.json', 'COMMIT', 'MANIFEST.txt', 'MANIFEST.sha256']) {
    assert.ok(fs.existsSync(path.join(snap, rel)), '快照包含 ' + rel);
  }
  // 瞬时文件被排除
  for (const rel of ['.server-lock', 'run.log']) {
    assert.ok(!fs.existsSync(path.join(snap, rel)), '快照排除运行期瞬时文件 ' + rel);
  }
  // COMMIT 记录部署前 commit
  assert.strictEqual(fs.readFileSync(path.join(snap, 'COMMIT'), 'utf8').trim(), env.head, 'COMMIT = 部署前 HEAD');
  // manifest 内容：数量/总字节/逐文件 SHA-256
  const man = fs.readFileSync(path.join(snap, 'MANIFEST.txt'), 'utf8');
  assert.match(man, /文件数量: 9/, 'manifest 记录文件数量');
  assert.match(man, /总字节: \d+/, 'manifest 记录总字节');
  const sha = fs.readFileSync(path.join(snap, 'MANIFEST.sha256'), 'utf8').trim().split('\n');
  assert.ok(sha.length >= 9, 'manifest 覆盖全部数据文件（含 COMMIT）');
  for (const line of sha) assert.match(line, /^[0-9a-f]{64} [ *]\.\//, 'SHA-256 行格式');
  // 当场复核（脚本内部已做过一次，这里独立复验）
  const verify = sh('sha256sum -c MANIFEST.sha256', { cwd: snap });
  assert.strictEqual(verify.status, 0, '独立复核 SHA-256: ' + (verify.stdout || verify.stderr).slice(0, 300));
});
