'use strict';
// ============================================================
// M0-01 SourceSnapshot 单测（计划 v0.2 §6 + PR#2 评审增补，18 用例）
// 评审增补：16=P0-1 部分扫描诚实语义 / 17=P0-3 无业务 Coverage / 18=P1-2 独占创建；
// 9=P0-2 跨租户缓存不串溯源；11=P1-1 parse_failed body 已接收 → observed_at 非空
// 隔离：ZB_DATA_DIR 指向临时目录（必须在 require 业务模块前设置）
// 网络隔离：stub global.fetch + dns.promises.lookup（SSRF 守卫按公网 IP 放行）
// 规格锚点：/spec 05 v0.3 §11（八态字面量）/§13；00 v1.2 §38/§54/§56
// ============================================================
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert');
const dns = require('dns');

// ---- 隔离沙箱：必须在 require 业务模块之前设置 ----
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-m0-01-'));
process.env.ZB_DATA_DIR = TMP;
delete process.env.ZB_SNAPSHOT_MAX_BYTES;
// cache.js 硬编码 app/data/cache.sqlite（既有行为，不属本票改动范围）；测试期清残留防串场
fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(__dirname, '..', 'data', 'cache.sqlite' + suffix), { force: true });

const Snapshot = require('../research/source-snapshot.js');
const net = require('../research/net.js');
const als = require('../core/als.js');
const logger = require('../services/logger.js');

// 静音测试期间的日志输出（用例 14 会临时重挂 error 计数器）
const silent = () => {};
for (const k of ['debug', 'info', 'warn', 'error']) logger[k] = silent;

// ---- 网络 stub：DNS 全解析到公网 IP（过 SSRF 守卫），fetch 按 URL 前缀分发 ----
const realLookup = dns.promises.lookup;
dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const realFetch = global.fetch;
let fetchRoutes = {}; // url 前缀 → (url, opts) => Response
global.fetch = (url, opts) => {
  const s = String(url);
  for (const prefix of Object.keys(fetchRoutes)) {
    if (s.startsWith(prefix)) return Promise.resolve().then(() => fetchRoutes[prefix](s, opts || {}));
  }
  return Promise.reject(new Error('no stub route: ' + s));
};
function jsonResponse(body, headers) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
}
function abortingFetch() {
  return (url, opts) => new Promise((res, rej) => {
    const rejAbort = () => rej(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    if (opts.signal) opts.signal.addEventListener('abort', rejAbort); else rejAbort();
  });
}
function sha256hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function snapshotsRoot() { return path.join(TMP, 'snapshots'); }
function nsDir(tenantId) { return path.join(snapshotsRoot(), String(tenantId).replace(/[^a-z0-9_-]/gi, '_')); }
function countFilesUnder(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countFilesUnder(path.join(dir, e.name)); else n++;
  }
  return n;
}

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

const TENANT_A = 'tenant:aaaa01';
const TENANT_B = 'tenant:bbbb02';
const BASE = 'http://example.com';

(async () => {

  // 1. success 快照字段完整性（collector_version，非 parser_version）
  await t('1 success 快照字段完整性（collector_version 而非 parser_version）', async () => {
    fetchRoutes = { [BASE + '/page1']: () => jsonResponse('<html>hello page1</html>', { 'content-type': 'text/html' }) };
    const out = await net.fetchPage(BASE + '/page1', 5000, { tenantId: TENANT_A, trigger: 'enrich' });
    assert.ok(out.ok && out._prov && out._prov.recorded, '应成功并带 _prov');
    const meta = Snapshot.getById(TENANT_A, out.snapshotId);
    assert.ok(meta, '元数据可读回');
    assert.equal(meta.schema_version, 1);
    assert.equal(meta.capability, 'evidence_url');
    assert.equal(meta.provider, 'generic_web_fetch');
    assert.equal(meta.http_status, 200);
    assert.equal(meta.source_status, 'success');
    assert.equal(meta.collector_version, 'net-1');
    assert.ok(!('parser_version' in meta), '快照层不得伪造 parser_version');
    assert.ok(meta.observed_at && meta.fetched_at && meta.collected_at, '三时间齐备');
    assert.equal(meta.content_hash, 'sha256:' + sha256hex(Buffer.from('<html>hello page1</html>', 'utf8')));
    assert.equal(meta.tenant.tenant_id, TENANT_A);
    assert.equal(meta.trigger, 'enrich');
    assert.ok(meta.retention && meta.retention.tier === 'P1');
    assert.equal(meta.raw_payload_ref.kind, 'fs_blob');
    assert.equal(meta.raw_truncated, false);
  });

  // 2. content_hash 稳定且基于原始字节
  await t('2 content_hash 稳定且基于原始字节（同 body 两次一致）', async () => {
    fetchRoutes = { [BASE + '/h1']: () => jsonResponse('<p>same body</p>'), [BASE + '/h2']: () => jsonResponse('<p>same body</p>') };
    const a = await net.fetchPage(BASE + '/h1', 5000, { tenantId: TENANT_A });
    const b = await net.fetchPage(BASE + '/h2', 5000, { tenantId: TENANT_A });
    assert.equal(a._prov.content_hash, b._prov.content_hash);
    const blob = Snapshot.readRawPayload(Snapshot.getById(TENANT_A, b.snapshotId));
    assert.equal(b._prov.content_hash, 'sha256:' + sha256hex(blob), 'hash == 未截断 blob 字节指纹');
  });

  // 3. raw 完整性：>9000 字符 blob 完整，fetchPage 返回值仍截断
  await t('3 raw 完整性（blob 存完整原始字节，业务 text 仍截 9000）', async () => {
    const long = '<div>' + 'x'.repeat(20000) + '</div>';
    fetchRoutes = { [BASE + '/long']: () => new Response(long, { status: 200, headers: { 'content-type': 'text/html' } }) };
    const out = await net.fetchPage(BASE + '/long', 5000, { tenantId: TENANT_A });
    assert.ok(out.text.length <= 9000, '业务 text 截断不变');
    const meta = Snapshot.getById(TENANT_A, out.snapshotId);
    assert.equal(Snapshot.readRawPayload(meta).toString('utf8').length, long.length, 'blob 完整');
    assert.equal(meta.raw_truncated, false);
    assert.equal(meta.raw_size, Buffer.byteLength(long));
  });

  // 4. 失败观察：observed_at 必须 null（修正 1）
  await t('4 失败观察 404/timeout/SSRF：source_status 映射正确且 observed_at=null', async () => {
    fetchRoutes = { [BASE + '/nf']: () => new Response('nope', { status: 404 }) };
    const nf = await net.fetchPage(BASE + '/nf', 5000, { tenantId: TENANT_A });
    const mNf = Snapshot.getById(TENANT_A, nf.snapshotId);
    assert.equal(mNf.source_status, 'unavailable');
    assert.equal(mNf.observed_at, null, '无内容即无观察时刻');
    assert.ok(mNf.fetched_at, 'fetched_at 有值');
    assert.equal(mNf.http_status, 404);

    fetchRoutes = { [BASE + '/slow']: abortingFetch() };
    const to = await net.fetchPage(BASE + '/slow', 30, { tenantId: TENANT_A });
    const mTo = Snapshot.getById(TENANT_A, to.snapshotId);
    assert.equal(mTo.source_status, 'timeout');
    assert.equal(mTo.observed_at, null);
    assert.equal(mTo.http_status, null);

    const ssrf = await net.fetchPage('http://127.0.0.1:9/x', 5000, { tenantId: TENANT_A });
    const mSsrf = Snapshot.getById(TENANT_A, ssrf.snapshotId);
    assert.equal(mSsrf.source_status, 'blocked');
    assert.equal(mSsrf.observed_at, null);
  });

  // 5-7. 缓存命中：不产快照 / 保留原始 id 与 observed_at / 只推进 cache_served_at（修正 2）
  await t('5 缓存命中不产新快照', async () => {
    let calls = 0;
    fetchRoutes = { [BASE + '/cache1']: () => { calls++; return jsonResponse('<p>c</p>'); } };
    const first = await net.fetchPage(BASE + '/cache1', 5000, { tenantId: TENANT_A });
    global.__firstProv = first._prov;
    const before = countFilesUnder(nsDir(TENANT_A));
    const second = await net.fetchPage(BASE + '/cache1', 5000, { tenantId: TENANT_A });
    assert.equal(calls, 1, '网络只走一次');
    assert.equal(countFilesUnder(nsDir(TENANT_A)), before, '快照数不变');
    assert.ok(second._prov && second._prov.source_snapshot_id, '命中返回带溯源');
  });
  await t('6 缓存命中返回原始 source_snapshot_id', async () => {
    const again = await net.fetchPage(BASE + '/cache1', 5000, { tenantId: TENANT_A });
    assert.equal(again._prov.source_snapshot_id, global.__firstProv.source_snapshot_id, '与首次快照 id 一致');
  });
  await t('7 缓存命中保留原始 observed_at，只推进 cache_served_at', async () => {
    await new Promise(r => setTimeout(r, 20));
    const again = await net.fetchPage(BASE + '/cache1', 5000, { tenantId: TENANT_A });
    assert.equal(again._prov.observed_at, global.__firstProv.observed_at, 'observed_at 原样透传');
    assert.ok(again._prov.cache_served_at, 'cache_served_at 有值');
    assert.notEqual(again._prov.cache_served_at, again._prov.observed_at, 'cache_served_at != observed_at');
    assert.ok(new Date(again._prov.cache_served_at) >= new Date(again._prov.observed_at));
  });

  // 8. 不可变：同 id 二次 record 拒绝且文件不变；模块无 mutate 导出
  await t('8 append-only：同 id 二次 record 拒绝、字节不变、无 update API', async () => {
    const id = 'ss_unit_fixed_0001_aabbcc';
    const r1 = Snapshot.record({ capability: 'evidence_url', provider: 'generic_web_fetch', source_url: BASE + '/imm', source_status: 'unavailable', error_code: 'http:404', observed_at: null, bodyBytes: null, tenantId: TENANT_A, snapshot_id: id });
    assert.ok(r1.recorded);
    const mPath = path.join(nsDir(TENANT_A), String(r1.meta.fetched_at).slice(0, 10).replace(/-/g, ''), id + '.json');
    const before = fs.readFileSync(mPath);
    assert.throws(() => Snapshot.record({ capability: 'evidence_url', provider: 'generic_web_fetch', source_url: BASE + '/imm', source_status: 'unavailable', observed_at: null, bodyBytes: null, tenantId: TENANT_A, snapshot_id: id }), /append-only/);
    assert.ok(before.equals(fs.readFileSync(mPath)), '文件字节不变');
    for (const k of Object.keys(Snapshot)) assert.ok(!/^(update|mutate|rewrite)/i.test(k), '不得存在 mutate API: ' + k);
  });

  // 9. 租户规则：隔离 + ALS 兜底 + 双缺拒绝（无 _legacy）
  // P0-2（PR#2 评审）：fetch-page 缓存键按租户隔离——同 URL 跨租户时 B 缓存不命中（B 键独立），
  // 触发真实网络观察并落 B 自己的快照；B 永不接收 A 的租户级快照溯源。
  // Canonical 跨工作区复用归 Canonical track 显式实现（00 §52），不得借公共缓存模拟。
  await t('9 租户隔离 / 跨租户缓存不串溯源 / ALS 兜底 / 双缺拒绝且无 _legacy 目录', async () => {
    fetchRoutes = { [BASE + '/t1']: () => jsonResponse('<p>tenants</p>') };
    const outA = await net.fetchPage(BASE + '/t1', 5000, { tenantId: TENANT_A });
    const outB = await net.fetchPage(BASE + '/t1', 5000, { tenantId: TENANT_B });
    assert.ok(outA._prov.recorded && outB._prov.recorded, '双租户各自真实观察并落盘');
    assert.notEqual(outB._prov.source_snapshot_id, outA._prov.source_snapshot_id, 'P0-2：B 永不接收 A 的快照溯源');
    assert.ok(fs.existsSync(nsDir(TENANT_A)), 'A 目录存在');
    assert.ok(fs.existsSync(nsDir(TENANT_B)), 'B 目录存在');
    assert.equal(Snapshot.getById(TENANT_B, outA.snapshotId), null, 'A 的快照对 B 不可见');
    assert.equal(Snapshot.getById(TENANT_A, outB.snapshotId), null, 'B 的快照对 A 不可见（反向）');
    assert.ok(Snapshot.getById(TENANT_B, outB.snapshotId), 'B 自己的快照可读回（溯源可解析）');
    assert.equal(outB._prov.tenant_id, undefined, '无租户关系元数据泄漏');
    // 同租户重复抓取：仍走缓存命中路径，修正 2 语义不变
    const againA = await net.fetchPage(BASE + '/t1', 5000, { tenantId: TENANT_A });
    assert.equal(againA._prov.source_snapshot_id, outA._prov.source_snapshot_id, '同租户命中保留原快照 id');
    const alsOut = await als.requestScope.run(TENANT_A, () => net.fetchPage(BASE + '/t1', 5000));
    assert.ok(alsOut._prov && alsOut._prov.recorded, 'ALS 上下文内无需显式 tenantId（缓存命中路径亦带溯源）');
    const skipped = als.requestScope.run(undefined, () => Snapshot.record({ capability: 'evidence_url', provider: 'generic_web_fetch', source_url: BASE + '/t1', source_status: 'unavailable', observed_at: null, bodyBytes: null }));
    assert.equal(skipped.recorded, false);
    assert.equal(skipped.reason, 'no_tenant_context');
    assert.ok(!fs.existsSync(path.join(snapshotsRoot(), '_legacy')), '绝无 _legacy 命名空间');
  });

  // 10. getById + readRawPayload roundtrip（经 raw_payload_ref）
  await t('10 getById / readRawPayload roundtrip', async () => {
    const body = Buffer.from('roundtrip-bytes-123', 'utf8');
    const r = Snapshot.record({ capability: 'evidence_url', provider: 'generic_web_fetch', source_url: BASE + '/rt', source_status: 'success', observed_at: new Date().toISOString(), bodyBytes: body, contentType: 'text/plain', tenantId: TENANT_A });
    const meta = Snapshot.getById(TENANT_A, r.meta.snapshot_id);
    assert.equal(meta.snapshot_id, r.meta.snapshot_id);
    assert.ok(Snapshot.readRawPayload(meta).equals(body), 'blob 经 ref 读回一致');
    assert.equal(meta.raw_payload_ref.path.indexOf('snapshots/'), 0, 'ref.path 相对 DATA');
  });

  // 11. parse_failed：2XX 但非法 JSON，字节仍落 blob
  await t('11 parse_failed：blob 保留原始字节供重放', async () => {
    const bad = 'not-json{';
    fetchRoutes = { 'https://example.com/cart.js': () => jsonResponse({ currency: 'USD' }), 'https://example.com/products.json': () => new Response(bad, { status: 200, headers: { 'content-type': 'application/json' } }) };
    const out = await net.fetchShopifyProducts(BASE, { tenantId: TENANT_A });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'parse_failed');
    const meta = Snapshot.getById(TENANT_A, out.snapshotId);
    assert.equal(meta.source_status, 'parse_failed');
    // P1-1（PR#2 评审）：2XX body 已成功接收 = 内容已被真实观察 → observed_at 非空
    assert.ok(meta.observed_at, 'P1-1：body 接收后 parse_failed 的 observed_at 非空');
    assert.ok(new Date(meta.observed_at) <= new Date(meta.collected_at), 'observed_at <= collected_at');
    assert.ok(Snapshot.readRawPayload(meta).equals(Buffer.from(bad)), '原始字节保留');
  });

  // 12. 截断诚实：hash 仍按完整原始字节
  await t('12 截断：raw_truncated 诚实标记，hash/raw_size 按原始字节', async () => {
    process.env.ZB_SNAPSHOT_MAX_BYTES = '64';
    try {
      const body = Buffer.from('T'.repeat(1000), 'utf8');
      const meta = Snapshot.record({ capability: 'evidence_url', provider: 'generic_web_fetch', source_url: BASE + '/tr', source_status: 'success', observed_at: new Date().toISOString(), bodyBytes: body, tenantId: TENANT_A }).meta;
      assert.equal(meta.raw_truncated, true);
      assert.equal(meta.content_hash, 'sha256:' + sha256hex(body), 'hash 为完整原始字节指纹');
      assert.equal(meta.raw_size, 1000);
      assert.equal(meta.raw_payload_ref.byte_size, 64);
      assert.equal(Snapshot.readRawPayload(meta).length, 64);
      assert.ok(!('coverage' in meta), 'P0-3：截断仅是 raw 存储属性，不得产生业务 Coverage 语义');
    } finally { delete process.env.ZB_SNAPSHOT_MAX_BYTES; }
  });

  // 13. enrich 调用形态等价集成：Promise.all 双入口 + 业务契约不变
  await t('13 enrich 形态集成：双入口快照齐产、返回契约不变', async () => {
    const products = { products: [{ title: 'P1', product_type: 'fig', variants: [{ price: '19.9' }] }] };
    fetchRoutes = {
      [BASE + '/page-enn']: () => new Response('<html><body>official site</body></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      'https://example.com/cart.js': () => jsonResponse({ currency: 'USD' }),
      'https://example.com/products.json': () => jsonResponse(products),
    };
    // 模拟生产：enrich.js:172 调用不带显式 tenantId，租户靠 ALS 传播（验证 Promise.all 链路）
    const [officialPage, shopify] = await als.requestScope.run(TENANT_A, () =>
      Promise.all([net.fetchPage(BASE + '/page-enn'), net.fetchShopifyProducts(BASE)]));
    assert.ok(officialPage.ok && typeof officialPage.text === 'string', 'fetchPage 业务契约不变');
    assert.ok(shopify.ok && shopify.total === 1 && shopify.currency === 'USD', 'fetchShopifyProducts 业务契约不变');
    const m1 = Snapshot.getById(TENANT_A, officialPage.snapshotId);
    const m2 = Snapshot.getById(TENANT_A, shopify.snapshotId);
    assert.ok(m1 && m1.capability === 'evidence_url');
    assert.ok(m2 && m2.capability === 'product_catalog' && m2.provider === 'shopify_products_json');
    // P0-1 对照面：首页不满额（1 < 100）= 完整目录观察 → success + scan.complete=true
    assert.equal(m2.source_status, 'success', '首页 < 100 款即全部 → success');
    assert.equal(m2.scan.complete, true, 'scan.complete=true');
    assert.equal(m2.scan.observed_first_page, 1);
    assert.ok(new Date(m2.observed_at) <= new Date(m2.collected_at), 'observed_at <= collected_at');
  });

  // 14. 落盘失败不破坏业务 + 可见运营错误（修正 9）
  await t('14 落盘失败：业务照常返回，error 级日志可见', async () => {
    const realRecord = Snapshot.record;
    let errLogged = 0;
    logger.error = () => { errLogged++; };
    Snapshot.record = () => { throw new Error('E_DISK_FULL'); };
    try {
      fetchRoutes = { [BASE + '/df']: () => jsonResponse('<p>diskfail</p>') };
      const out = await net.fetchPage(BASE + '/df', 5000, { tenantId: TENANT_A });
      assert.ok(out.ok === true, '业务结果不受影响');
      assert.ok(!out._prov.source_snapshot_id, '无落盘即无证据级溯源声明');
      assert.ok(errLogged > 0, '运营错误日志可见（非静默）');
    } finally {
      Snapshot.record = realRecord;
      for (const k of ['debug', 'info', 'warn', 'error']) logger[k] = silent;
    }
  });

  // 15. 状态映射全口径 + 别名字面量拒绝
  await t('15 mapHttpStatus：429→rate_limited / 401·403·407→blocked / 其余→unavailable；别名字面量被拒', () => {
    assert.equal(Snapshot.mapHttpStatus(429), 'rate_limited');
    for (const s of [401, 403, 407]) assert.equal(Snapshot.mapHttpStatus(s), 'blocked');
    for (const s of [400, 404, 500, 503]) assert.equal(Snapshot.mapHttpStatus(s), 'unavailable');
    assert.throws(() => Snapshot.record({ capability: 'x', provider: 'x', source_status: 'source_unavailable', tenantId: TENANT_A }), /invalid source_status/, '别名 source_unavailable 必须被拒');
    assert.throws(() => Snapshot.record({ capability: 'x', provider: 'x', source_status: 'partial_success', tenantId: TENANT_A }), /invalid source_status/, '别名 partial_success 必须被拒');
  });

  // 16. P0-1：Shopify 首页满额不得宣称完整目录 → partial + scan.complete=false
  await t('16 P0-1：首页满额（100 款）→ partial，绝不宣称 success+完整目录', async () => {
    const hundred = { products: Array.from({ length: 100 }, (_, i) => ({ title: 'P' + i, product_type: 'fig', variants: [{ price: '9.9' }] })) };
    fetchRoutes = {
      [BASE + '/big-site']: () => jsonResponse('<p>site</p>'),
      'https://example.com/cart.js': () => jsonResponse({ currency: 'USD' }),
      'https://example.com/products.json': () => jsonResponse(hundred),
    };
    const out = await net.fetchShopifyProducts(BASE, { tenantId: TENANT_A });
    assert.ok(out.ok && out.total === 100, '业务行为不变（items/total 契约兼容）');
    const meta = Snapshot.getById(TENANT_A, out.snapshotId);
    assert.equal(meta.source_status, 'partial', 'M0-04 分页落地前不得记 success');
    assert.equal(meta.scan.complete, false, '不宣称完整目录');
    assert.equal(meta.scan.observed_first_page, 100);
    assert.ok(meta.scan.reason, '不完整原因显式可读');
    assert.ok(meta.observed_at, 'body 已接收 → observed_at 非空（P1-1 同样适用）');
    assert.ok(!('coverage' in meta), '无业务 Coverage 字段（P0-3）');
  });

  // 17. P0-3：失败观察（unavailable/timeout）无 body 也绝不隐含任何 Coverage complete
  await t('17 P0-3：失败观察不携带 coverage；raw 属性诚实为空', async () => {
    fetchRoutes = { [BASE + '/nf2']: () => new Response('nope', { status: 404 }) };
    const nf = await net.fetchPage(BASE + '/nf2', 5000, { tenantId: TENANT_A });
    const meta = Snapshot.getById(TENANT_A, nf.snapshotId);
    assert.equal(meta.source_status, 'unavailable');
    assert.ok(!('coverage' in meta), 'unavailable 快照不得隐含 coverage.complete=true');
    assert.equal(meta.raw_truncated, false, 'raw_truncated 仅为 raw 存储属性（无 body 自然 false）');
    assert.equal(meta.raw_payload_ref, null, '无 body 即无 blob 引用');
    assert.equal(meta.observed_at, null, '内容从未被观察');
  });

  // 18. P1-2：raw blob 独占创建——既有文件绝不被静默覆盖（竞态/孤儿场景）
  await t('18 P1-2：blob 独占创建，冲突显式失败且原文件字节不变', async () => {
    const id = 'ss_unit_xcreate_0001_ddeeff';
    const fetchedAt = new Date().toISOString();
    const day = String(fetchedAt).slice(0, 10).replace(/-/g, '');
    const bPath = path.join(nsDir(TENANT_A), day, id + '.raw');
    fs.mkdirSync(path.dirname(bPath), { recursive: true });
    fs.writeFileSync(bPath, 'sentinel-do-not-overwrite');
    assert.throws(
      () => Snapshot.record({ capability: 'evidence_url', provider: 'generic_web_fetch', source_url: BASE + '/xc', source_status: 'success', observed_at: fetchedAt, fetched_at: fetchedAt, bodyBytes: Buffer.from('new-bytes'), tenantId: TENANT_A, snapshot_id: id }),
      /exclusive-create/,
      '独占创建冲突必须显式抛错（可见运营错误）'
    );
    assert.equal(fs.readFileSync(bPath, 'utf8'), 'sentinel-do-not-overwrite', '既有 blob 字节不变');
    const mPath = path.join(nsDir(TENANT_A), day, id + '.json');
    assert.ok(!fs.existsSync(mPath), 'blob 失败时不得落 meta（无半截快照）');
  });

  // 还原全局 stub（跑回归时防止泄漏到其他用例——本文件独立进程执行，此为防御性收尾）
  dns.promises.lookup = realLookup;
  global.fetch = realFetch;

  console.log(`\n结果：${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);

})().catch(e => { console.error(e); process.exit(1); });
