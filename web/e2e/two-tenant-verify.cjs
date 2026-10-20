'use strict';
// SC-05 两租户隔离验证（API 级；后端为全新 ZB_DATA_DIR）
// 租户 B 对租户 A 的 brandId 访问 memory/timeline/history-coverage → 一律 404（不暴露存在性）
const fs = require('fs');
const path = require('path');
const BASE = process.argv[2] || 'http://127.0.0.1:3311';
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? ' :: ' + String(detail).slice(0, 160) : '')); }
}
(async () => {
  const seed = JSON.parse(fs.readFileSync(__dirname + '/.e2e-memory.json', 'utf8'));
  // 租户 A（既有 e2e 租户）
  const a = await (await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: seed.email, password: seed.password }) })).json();
  check('租户 A 登录', !!a.token);
  // 租户 B（全新注册；密码随机生成，不入库任何固定凭据）
  const emailB = 'iso-' + Math.random().toString(36).slice(2, 10) + '@example.com';
  const passB = 'iso-' + Math.random().toString(36).slice(2, 14) + '-P1';
  const b = await (await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: emailB, password: passB, name: '隔离验证B' }) })).json();
  check('租户 B 注册', !!(b.token && b.tenantId && b.tenantId !== a.tenantId), 'b=' + b.tenantId + ' a=' + a.tenantId);

  // 租户 A 的品牌（真实采集品牌 + seed 品牌都要测）
  const brandsA = await (await fetch(BASE + '/api/brands?projectId=' + seed.projectId, { headers: { Authorization: 'Bearer ' + a.token } })).json();
  const target = (brandsA.brands || [])[0];
  check('租户 A 有可测品牌', !!target && target.brandId);
  const brandId = target.brandId;

  for (const [label, path] of [
    ['memory', '/api/brands/' + brandId + '/memory?projectId=' + seed.projectId],
    ['timeline', '/api/brands/' + brandId + '/timeline?projectId=' + seed.projectId],
    ['history-coverage', '/api/brands/' + brandId + '/history-coverage?projectId=' + seed.projectId],
  ]) {
    const rA = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + a.token } });
    check('租户 A 访问自己的 ' + label + ' = 200', rA.status === 200, 'status=' + rA.status);
    const rB = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + b.token } });
    check('租户 B 访问 A 的 ' + label + ' = 404', rB.status === 404, 'status=' + rB.status);
    const rBNoProj = await fetch(BASE + '/api/brands/' + brandId + '/' + label.split('?')[0], { headers: { Authorization: 'Bearer ' + b.token } });
    check('租户 B 无 projectId 访问 ' + label + ' ≠ 200', rBNoProj.status !== 200, 'status=' + rBNoProj.status);
  }
  // 回补任务 id 同样隔离（伪造一个读取 → 404）
  const rJob = await fetch(BASE + '/api/history-backfill/job_fake_does_not_exist', { headers: { Authorization: 'Bearer ' + b.token } });
  check('租户 B 访问不存在的回补任务 = 404', rJob.status === 404, 'status=' + rJob.status);
  console.log('\n[two-tenant] ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.message); process.exit(1); });
