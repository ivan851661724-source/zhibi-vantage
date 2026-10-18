'use strict';
// ============================================================
// scripts/http-auth-check.mjs—— Data Surface 真实 HTTP 鉴权测试（SC-02 §8 整改）
// 起真实 server 子进程，打真实 HTTP 请求验证：
//   1. GET /api/admin/data-surface/capabilities 无令牌        → 401 AUTH_REQUIRED
//   2. GET /api/admin/data-surface/capabilities 无效签名      → 401 AUTH_REQUIRED
//   3. GET /api/admin/data-surface/capabilities 普通租户令牌  → 403 FORBIDDEN
//   4. GET /api/admin/data-surface/capabilities 超管令牌      → 200 + integrity.ok
//   5. GET /api/data-surface/overview 无令牌                  → 401
//   6. GET /api/data-surface/refresh-policy 租户令牌          → 200（含 cooldown 口径）
// 用法：node app/scripts/http-auth-check.mjs（自动 spawn/kill server）
// ============================================================
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const PORT = parseInt(process.env.HTTP_AUTH_PORT || '3391', 10);
const BASE = 'http://127.0.0.1:' + PORT;

async function waitHealthy(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/healthz');
      if (r.ok) return true;
    } catch (e) { /* 未起 */ }
    await new Promise(r2 => setTimeout(r2, 300));
  }
  return false;
}

async function req(method, p, body, token) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(BASE + p, { method, headers, body: payload });
  let json = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('json')) { try { json = await r.json(); } catch (e) { json = null; } }
  return { status: r.status, json };
}

(async () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-http-auth-'));
  const env = Object.assign({}, process.env, {
    ZB_DATA_DIR: path.join(TMP, 'data'),
    PORT: String(PORT),
    SCHEDULER_ENABLED: '0',
    ZB_COLLECT_WORKER_DISABLED: '1', // 鉴权测试不触发采集循环
    NODE_ENV: 'test',
  });
  delete env.http_proxy; delete env.https_proxy; delete env.HTTP_PROXY; delete env.HTTPS_PROXY;
  const srv = spawn(process.execPath, [path.join(ROOT, 'app', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => process.stderr.write('[server] ' + String(d)));
  const results = [];
  try {
    if (!await waitHealthy(20000)) throw new Error('server 未就绪（20s 超时）');
    // 租户与项目注册（同 ZB_DATA_DIR 直写，SQLite 跨进程）
    process.env.ZB_DATA_DIR = env.ZB_DATA_DIR;
    const dbx = require(path.join(ROOT, 'app', 'services', 'db.js'));
    const Auth = require(path.join(ROOT, 'app', 'services', 'auth.js'));
    const { saveState, projFile } = require(path.join(ROOT, 'app', 'core', 'state-store.js'));
    dbx.createTenant({ name: 'httpauth', email: 'httpauth@example.com' });
    dbx.saveProject({ id: 'projH', tenantId: 'tenant:httpauth', track: 'T-projH', competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
    fs.mkdirSync(path.dirname(projFile('projH', 'tenant:httpauth')), { recursive: true });
    saveState({
      projectId: 'projH', tenantId: 'tenant:httpauth', track: 'T-projH',
      discoveredAt: new Date().toISOString(), intent: { regions: ['us'] },
      competitors: [{ id: 'compH1', name: 'AuthBrand', status: 'done', url: 'https://allbirds.com', isShopify: true, currency: 'USD' }],
    });
    for (let i = 0; i < 100 && !fs.existsSync(projFile('projH', 'tenant:httpauth')); i++) await new Promise(r => setTimeout(r, 20));
    const tenantTok = Auth.issueToken({ userId: 'u1', tenantId: 'tenant:httpauth', role: 'member' });
    const adminTok = Auth.issueAdminToken('platform-admin', 'platform_admin');

    const r1 = await req('GET', '/api/admin/data-surface/capabilities', undefined, null);
    results.push(['admin 无令牌 → 401', r1.status === 401 && r1.json && r1.json.error === 'AUTH_REQUIRED', r1.status + ' ' + (r1.json && r1.json.error)]);
    const r2 = await req('GET', '/api/admin/data-surface/capabilities', undefined, 'garbage.token.value');
    results.push(['admin 无效签名 → 401', r2.status === 401 && r2.json && r2.json.error === 'AUTH_REQUIRED', r2.status + ' ' + (r2.json && r2.json.error)]);
    const r3 = await req('GET', '/api/admin/data-surface/capabilities', undefined, tenantTok);
    results.push(['admin 租户令牌 → 403', r3.status === 403 && r3.json && r3.json.error === 'FORBIDDEN', r3.status + ' ' + (r3.json && r3.json.error)]);
    const r4 = await req('GET', '/api/admin/data-surface/capabilities', undefined, adminTok);
    results.push(['admin 超管令牌 → 200 + integrity', r4.status === 200 && r4.json && r4.json.integrity && r4.json.integrity.ok === true && r4.json.adapterContracts.ok === true, r4.status + ' integrity=' + (r4.json && r4.json.integrity && r4.json.integrity.ok)]);
    const r5 = await req('GET', '/api/data-surface/overview?competitorId=compH1', undefined, null);
    results.push(['overview 无令牌 → 401', r5.status === 401 && r5.json && r5.json.error === 'AUTH_REQUIRED', r5.status]);
    const r6 = await req('GET', '/api/data-surface/refresh-policy?projectId=projH&competitorId=compH1&capability=shopify_catalog', undefined, tenantTok);
    results.push(['refresh-policy 租户 → 200 + cooldown', r6.status === 200 && r6.json && r6.json.capability === 'shopify_catalog' && r6.json.cooldownMinutes >= 5, r6.status + ' cd=' + (r6.json && r6.json.cooldownMinutes)]);
    const r7 = await req('GET', '/api/data-surface/overview?projectId=projH&competitorId=compH1', undefined, tenantTok);
    results.push(['overview 租户 → 200', r7.status === 200 && r7.json && r7.json.competitorId === 'compH1', r7.status]);
    // 跨租户 404 不泄露存在性
    dbx.createTenant({ name: 'httpauth2', email: 'httpauth2@example.com' });
    const tenant2 = Auth.issueToken({ userId: 'u2', tenantId: 'tenant:httpauth2', role: 'member' });
    const r8 = await req('GET', '/api/data-surface/overview?projectId=projH&competitorId=compH1', undefined, tenant2);
    results.push(['overview 跨租户 → 404 不泄露', r8.status === 404 && r8.json && r8.json.error === 'PROJECT_NOT_FOUND', r8.status + ' ' + (r8.json && r8.json.error)]);
  } finally {
    try { srv.kill('SIGKILL'); } catch (e) {}
  }
  let failed = 0;
  for (const [name, ok, info] of results) {
    console.log((ok ? 'ok ' : 'FAIL ') + name + '  [' + info + ']');
    if (!ok) failed++;
  }
  console.log(failed ? `\nhttp-auth-check: ${failed} failed` : '\nhttp-auth-check: all passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('http-auth-check 异常:', e); process.exit(1); });
