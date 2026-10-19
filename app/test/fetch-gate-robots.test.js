'use strict';
// ============================================================
// fetch-gate-robots.test.js —— robots.txt 路径 P0 SSRF 回归（R3）
// 覆盖：robots.txt 必须与正文共用同一条受控安全网络路径。
//   R1 私网/回环/链路本地/云元数据 origin：robots 与正文均零连接
//   R2 DNS rebinding 发生在 robots 阶段：零响应（连接未建立）
//   R3 robots 302 → 私网：私网跳零连接（手动重定向逐跳校验）
//   R4 正常公网 robots + 正文请求可完成（缓存命中不重复请求）
// 纪律：**禁止把 robotsAllows mock 成常量 true**——全部用例真实经过 robots 调用路径；
//   只 stub 传输层（node http/https + dns），并计数证明全局 fetch 零调用。
// ============================================================
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-robots-'));
process.env.ZB_DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.ZB_DATA_DIR, { recursive: true });
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.ZB_FETCH_INTERVAL_MS = '1'; // 同域节流：测试内串行多次，不等待

const dns = require('dns');
const nodeHttp = require('http');
const nodeHttps = require('https');
const { EventEmitter } = require('events');

const Net = require('../research/net.js');
const FetchGate = require('../services/fetch-gate.js');
const Cache = require('../services/cache.js');

const PUB = { address: '93.184.216.34', family: 4 };
const TENANT = 'tenant:robots';

// ---- 传输层 stub：DNS 双层（promises 供 assertPublicUrl / callback 供 safeLookup）+ http/https ----
const realLookupCb = dns.lookup;
const realLookupPr = dns.promises.lookup;
const realHttpReq = nodeHttp.request;
const realHttpsReq = nodeHttps.request;
let globalFetchCalls = 0;
const realGlobalFetch = global.fetch;

function mockDns(map) {
  dns.promises.lookup = async (h) => { const r = map(h); if (!r) throw new Error('nxdomain'); return [r]; };
  dns.lookup = function (h, o, cb) {
    const cb2 = typeof o === 'function' ? o : cb;
    const r = map(h);
    if (!r) return cb2(new Error('nxdomain'));
    const all = o && typeof o === 'object' && o.all;
    process.nextTick(() => (all ? cb2(null, [r]) : cb2(null, r.address, r.family)));
  };
}
// routes: (url) => { status, headers, body } | { kind:'timeout' }；命中计数按 URL 记录
function mockTransport(routes) {
  const calls = []; // 每次 request 的 URL
  const responses = []; // 每次真正交付响应
  const make = (mod) => function (opts, cb) {
    const proto = mod === nodeHttps ? 'https://' : 'http://';
    const url = proto + (opts.hostname || '') + (opts.path || '/');
    calls.push(url);
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      const fake = routes(url);
      if (!fake) { process.nextTick(() => req.emit('error', new Error('no route: ' + url))); return; }
      if (fake.kind === 'timeout') { process.nextTick(() => req.emit('error', new Error('SAFE_FETCH_TIMEOUT'))); return; }
      const res = new EventEmitter();
      res.statusCode = fake.status || 200;
      res.headers = fake.headers || { 'content-type': 'text/plain' };
      const body = Buffer.from(fake.body || '');
      process.nextTick(() => { responses.push(url); cb(res); if (body.length) res.emit('data', body); res.emit('end'); });
    };
    return req;
  };
  nodeHttp.request = make(nodeHttp);
  nodeHttps.request = make(nodeHttps);
  return { calls, responses };
}
function restore() {
  dns.lookup = realLookupCb;
  dns.promises.lookup = realLookupPr;
  nodeHttp.request = realHttpReq;
  nodeHttps.request = realHttpsReq;
  global.fetch = realGlobalFetch;
}

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + ' :: ' + (e && e.message)); }
}

(async () => {
  // 前置：受控 fetcher 已由 net.js 注入（生产路径的 robots 通道）
  await t('R0 前置：FetchGate 已注入受控安全取回器（非全局 fetch）', async () => {
    assert.strictEqual(typeof FetchGate.getRobotsFetcher(), 'function', 'net.js 注入 safeRequest');
    assert.notStrictEqual(FetchGate.getRobotsFetcher(), realGlobalFetch, '注入的不是全局 fetch');
    global.fetch = (...a) => { globalFetchCalls++; return realGlobalFetch(...a); };
  });

  // ---- R1 私网/回环/云元数据：robots 与正文均零连接 ----
  for (const origin of ['http://127.0.0.1:9', 'http://localhost', 'http://169.254.169.254', 'http://100.100.100.200', 'http://10.1.2.3', 'http://[::1]']) {
    await t('R1 ' + origin + '：robots 与正文均零连接，全局 fetch 零调用', async () => {
      mockDns(() => PUB);
      const tr = mockTransport(() => ({ status: 200, body: 'should-not-be-reached' }));
      try {
        const r = await FetchGate.robotsAllows(origin, '/x');
        assert.ok(r === null || r === true, 'robots 判定为不可判定(fail-open)或无 robots，不得建立连接：' + r);
        assert.strictEqual(tr.calls.length, 0, '传输层零请求（实际 ' + JSON.stringify(tr.calls) + '）');
        const fp = await Net.fetchPage(origin + '/page', 3000, { tenantId: TENANT });
        assert.strictEqual(fp.ok, false, '正文失败');
        assert.ok(/^SSRF_BLOCKED/.test(String(fp.error)), '正文 SSRF 拒绝：' + fp.error);
        assert.strictEqual(tr.calls.length, 0, '正文阶段也零请求（robots 阶段不得抢先连接）');
        assert.strictEqual(tr.responses.length, 0, '零响应');
        assert.strictEqual(globalFetchCalls, 0, '全局 fetch 零调用');
      } finally { restore(); global.fetch = (...a) => { globalFetchCalls++; return realGlobalFetch(...a); }; }
    });
  }

  // ---- R2 DNS rebinding 发生在 robots 阶段 ----
  await t('R2 robots 阶段 DNS rebinding（校验层公网 / 连接层私网）：零响应', async () => {
    mockDns(() => PUB); // assertPublicUrl（promises DNS）看公网 → 放行
    dns.lookup = function (h, o, cb) { // 仅连接层返回私网（rebinding 模拟）
      const cb2 = typeof o === 'function' ? o : cb;
      const all = o && typeof o === 'object' && o.all;
      process.nextTick(() => (all ? cb2(null, [{ address: '10.66.66.66', family: 4 }]) : cb2(null, '10.66.66.66', 4)));
    };
    // 🔴 传输层保持真实（不 mock）：连接阶段由 node 真正走到 safeLookup，
    // 私网结果必须在此拒绝——任何响应都意味着连接被建立。
    nodeHttp.request = realHttpReq;
    nodeHttps.request = realHttpsReq;
    // 直接证据：safeLookup 回调本身对私网解析结果拒绝（连接前）
    const lookupErr = await new Promise((res) => {
      Net.safeLookup('rebind.example.com', {}, (err) => res(err));
    });
    assert.ok(lookupErr && /SSRF_BLOCKED:private_dns_connect/.test(String(lookupErr.message)),
      'safeLookup 在连接阶段拒绝私网 DNS（实际 ' + (lookupErr && lookupErr.message) + '）');
    try {
      const r = await FetchGate.robotsAllows('https://rebind.example.com', '/p');
      assert.strictEqual(r, null, 'rebinding → 安全请求失败 → fail-open(null)，不得建立连接');
      const fp = await Net.fetchPage('https://rebind.example.com/page2', 3000, { tenantId: TENANT });
      assert.strictEqual(fp.ok, false);
      assert.ok(/^SSRF_BLOCKED/.test(String(fp.error)), '正文 SSRF 拒绝：' + fp.error);
      assert.strictEqual(globalFetchCalls, 0, '全局 fetch 零调用');
    } finally { restore(); global.fetch = (...a) => { globalFetchCalls++; return realGlobalFetch(...a); }; }
  });

  // ---- R3 robots 302 → 私网：私网跳零连接 ----
  await t('R3 robots 302 → 私网：仅首跳发起请求，私网跳零连接', async () => {
    mockDns(() => PUB);
    const tr = mockTransport((url) => {
      if (/\/robots\.txt$/.test(url) && url.startsWith('https://pub-robots.example.com')) {
        return { status: 302, headers: { location: 'http://127.0.0.1/robots.txt' } };
      }
      return { status: 200, body: 'x' };
    });
    try {
      const r = await FetchGate.robotsAllows('https://pub-robots.example.com', '/p');
      assert.strictEqual(tr.responses.length, 1, '仅首跳有响应');
      assert.ok(!tr.calls.some(u => /127\.0\.0\.1/.test(u)), '私网跳零连接（实际 ' + JSON.stringify(tr.calls) + '）');
      assert.ok(tr.calls.some(u => /robots\.txt/.test(u)), 'robots 请求确实经过受控传输层');
      assert.strictEqual(r, null, '重定向被拒 → fail-open(null)');
      assert.strictEqual(globalFetchCalls, 0, '全局 fetch 零调用');
    } finally { restore(); global.fetch = (...a) => { globalFetchCalls++; return realGlobalFetch(...a); }; }
  });

  // ---- R4 正常公网：robots 与正文均可完成，缓存命中不重复请求 ----
  await t('R4 正常公网 robots + 正文请求可完成（robots 判定生效，缓存复用）', async () => {
    mockDns(() => PUB);
    let robotsHits = 0;
    const tr = mockTransport((url) => {
      if (/\/robots\.txt$/.test(url)) { robotsHits++; return { status: 200, body: 'User-agent: *\nAllow: /' }; }
      return { status: 200, body: '<html>hello world</html>', headers: { 'content-type': 'text/html' } };
    });
    try {
      const allow = await FetchGate.robotsAllows('https://ok-robots.example.com', '/page');
      assert.strictEqual(allow, true, 'robots 允许');
      assert.strictEqual(robotsHits, 1, 'robots 请求发生一次');
      const fp = await Net.fetchPage('https://ok-robots.example.com/page', 5000, { tenantId: TENANT });
      assert.strictEqual(fp.ok, true, '正文成功');
      assert.ok(fp.text.includes('hello world'));
      assert.strictEqual(robotsHits, 1, '缓存命中：同域正文不再重复请求 robots');
      // 禁止路径也生效（不 mock robots，改返回 Disallow）
      const tr2 = mockTransport((url) => (/\/robots\.txt$/.test(url)
        ? { status: 200, body: 'User-agent: *\nDisallow: /private' }
        : { status: 200, body: '<html>x</html>', headers: { 'content-type': 'text/html' } }));
      try {
        const deny = await FetchGate.robotsAllows('https://deny-robots.example.com', '/private/x');
        assert.strictEqual(deny, false, 'Disallow 生效');
        const fp2 = await Net.fetchPage('https://deny-robots.example.com/private/x', 5000, { tenantId: TENANT });
        assert.strictEqual(fp2.ok, false, '正文被 robots 拒绝');
        assert.strictEqual(fp2.error, 'ROBOTS_DISALLOWED');
      } finally { restore(); }
      assert.strictEqual(globalFetchCalls, 0, '全局 fetch 零调用');
    } finally { restore(); global.fetch = (...a) => { globalFetchCalls++; return realGlobalFetch(...a); } }
  });

  // ---- R5 源码级：用户可控抓取路径不得直接调用全局 fetch ----
  await t('R5 源码级：fetch-gate/net 不得直接调用全局 fetch', async () => {
    const gate = fs.readFileSync(path.join(__dirname, '..', 'services', 'fetch-gate.js'), 'utf8');
    const net = fs.readFileSync(path.join(__dirname, '..', 'research', 'net.js'), 'utf8');
    assert.ok(!/\bfetch\s*\(\s*(origin|url|u\b)/.test(gate), 'fetch-gate 不得以裸 fetch 发请求');
    assert.ok(!/=\s*fetch;/.test(gate) && !/\|\|\s*fetch\b/.test(gate), 'fetch-gate 不得回落到全局 fetch');
    const netBody = net.split('async function fetchPage')[1] || '';
    assert.ok(!/await\s+fetch\s*\(/.test(netBody), 'fetchPage 正文请求不得用全局 fetch');
  });

  global.fetch = realGlobalFetch;
  console.log(`\nfetch-gate-robots.test: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
