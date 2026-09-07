'use strict';
// SSRF 防护单测：私网/环回/链路本地/云元数据地址全拒（含每跳语义的基础函数）
const assert = require('node:assert');
const { isPrivateIp, assertPublicUrl } = require('../research/net.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

t('isPrivateIp：环回/私网/链路本地/CGNAT 元数据段全识别', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.100.100.200', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.ok(isPrivateIp(ip), ip + ' 应判私网');
  }
});

t('isPrivateIp：公网地址放行', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1']) {
    assert.ok(!isPrivateIp(ip), ip + ' 应判公网');
  }
});

t('assertPublicUrl：非 http/https 协议拒绝', async () => {
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /SSRF_BLOCKED/);
  await assert.rejects(() => assertPublicUrl('ftp://example.com'), /SSRF_BLOCKED/);
});

t('assertPublicUrl：localhost / *.internal 主机名拒绝', async () => {
  await assert.rejects(() => assertPublicUrl('http://localhost/x'), /SSRF_BLOCKED/);
  await assert.rejects(() => assertPublicUrl('http://metadata.google.internal/computeMetadata/v1/'), /SSRF_BLOCKED/);
});

t('assertPublicUrl：数字 IP 形式的私网/元数据地址拒绝（不发起 DNS）', async () => {
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data/'), /SSRF_BLOCKED/);
  await assert.rejects(() => assertPublicUrl('http://100.100.100.200/latest/meta-data/'), /SSRF_BLOCKED/);
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1:3300/api/config'), /SSRF_BLOCKED/);
});

t('assertPublicUrl：畸形 URL 拒绝', async () => {
  await assert.rejects(() => assertPublicUrl('not a url'), /SSRF_BLOCKED/);
});

console.log('\n=== ssrf-guard.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
