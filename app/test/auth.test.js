'use strict';
// 鉴权单测（P0 修复回归）：scrypt 密码 / JWT 签发验签 / 过期拒绝 / 双通道隔离 / ZB_DATA_DIR 隔离
process.env.ZB_DATA_DIR = require('os').tmpdir() + '/zb-auth-test-' + Date.now();
const assert = require('node:assert');
const auth = require('../services/auth.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

t('密码：scrypt 哈希可验证、错密码拒绝', () => {
  const h = auth.hashPassword('correct-horse');
  assert.ok(auth.verifyPassword('correct-horse', h));
  assert.ok(!auth.verifyPassword('wrong', h));
  assert.ok(!auth.verifyPassword('correct-horse', 'bad-format'));
});

t('JWT：签发→验签往返，载荷一致', () => {
  const token = auth.issueToken({ userId: 'user:1', tenantId: 'tenant:a', role: 'owner' });
  const p = auth.verifyToken(token);
  assert.ok(p);
  assert.equal(p.sub, 'user:1');
  assert.equal(p.tid, 'tenant:a');
  assert.equal(p.role, 'owner');
});

t('JWT：过期 token 拒绝（无 exp 的 token 同样拒绝）', () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = auth.signJWT({ sub: 'x', tid: 't', exp: now - 10 }, auth.getJwtSecret());
  assert.equal(auth.verifyToken(expired), null);
  const noExp = auth.signJWT({ sub: 'x', tid: 't' }, auth.getJwtSecret());
  assert.equal(auth.verifyToken(noExp), null); // 无 exp 永不过期属漏洞（P0 修复回归）
});

t('JWT：伪造签名拒绝', () => {
  const token = auth.issueToken({ userId: 'user:1', tenantId: 'tenant:a', role: 'owner' });
  const parts = token.split('.');
  const tampered = parts[0] + '.' + parts[1] + '.' + parts[2].slice(0, -2) + 'xx';
  assert.equal(auth.verifyToken(tampered), null);
});

t('双通道隔离：租户 JWT 验不过超管、超管 token 验不过租户', () => {
  const tenantToken = auth.issueToken({ userId: 'user:1', tenantId: 'tenant:a', role: 'owner' });
  const adminToken = auth.issueAdminToken('platform-admin', 'platform_admin');
  assert.equal(auth.verifyAdminToken(tenantToken), null); // 租户 JWT 伪装不了超管
  assert.equal(auth.verifyToken(adminToken), null);       // 超管 token 进不了租户通道
  assert.ok(auth.verifyAdminToken(adminToken));
  assert.ok(auth.verifyAdminKey(auth.getAdminSecret()));
  assert.ok(!auth.verifyAdminKey('wrong-key'));
});

t('凭据校验：错用户/错密码返回 null（不抛）', () => {
  assert.equal(auth.verifyAdminCredentials('ghost', 'pw123456'), null);
});

const fs = require('node:fs');
fs.rmSync(process.env.ZB_DATA_DIR, { recursive: true, force: true });
delete process.env.ZB_DATA_DIR;

console.log('\n=== auth.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
