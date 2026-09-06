'use strict';
// =============================================================================
// verify-search-fusion.js — 离线验证「failover 切源 + 双源融合」逻辑
// -----------------------------------------------------------------------------
// 说明：用户未提供真实 Brave/Tavily key，故用 stub fetch 模拟真实 API 响应，
// 但调用的是 services/providers/search.js 与 lib/source-fusion.js 的【真实代码】，
// 因此验证的是真实路由与融合逻辑，而非假实现。
//
// 三场景：
//   A. SERPER_400 故障 → 主源切到 Brave/Tavily，且双源一致 → basis='verified'
//      （同时证明 failover 路由 + 三角验证）
//   B. 仅单源可用 → 不标 verified，basis='claimed'（无对照不升级）
//   C. 双源都成功但域名无交集 → basis='claimed'（不一致不升级）
// =============================================================================

const Search = require('../services/providers/search.js');
const { corroborate } = require('../lib/source-fusion.js');

function mock(status, json) {
  return { ok: status < 400, status, async json() { return json; }, async text() { return JSON.stringify(json); } };
}
// map: [[host子串, {status, json}], ...]
function setStub(map) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [host, body] of map) if (u.includes(host)) return mock(body.status, body.json);
    return mock(200, { results: [] });
  };
}

const config = { search: { provider: 'serper', serperKey: 'sk', braveKey: 'bk', tavilyKey: 'tk' } };
const GL = 'us';
const Q = 'acme official website';

const serperFetcher = { name: 'serper', fetch: (q) => Search.serperSearchWithFailover(q, [config.search.serperKey], GL, { disabled: new Set() }) };
const braveFetcher = { name: 'brave', fetch: (q) => Search.braveSearch(q, config.search.braveKey, GL) };
const tavilyFetcher = { name: 'tavily', fetch: (q) => Search.tavilySearch(q, config.search.tavilyKey) };

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  ❌ ' + name + (detail ? '  ' + detail : '')); }
}

(async () => {
  // ---------- 场景 A：SERPER_400 → 切源 + 双源一致 = verified ----------
  console.log('\n[A] SERPER_400 故障 → 切源 + 双源一致');
  setStub([
    ['google.serper.dev', { status: 400, json: {} }],
    ['api.search.brave.com', { status: 200, json: { web: { results: [{ title: 'Acme', url: 'https://example.com/p', description: 'd' }] } } }],
    ['api.tavily.com', { status: 200, json: { results: [{ title: 'Acme', url: 'https://example.com/q', content: 'c' }] } }]
  ]);
  const a = await corroborate(Q, [serperFetcher, braveFetcher, tavilyFetcher]);
  assert('Serper 被排除（failover 生效）', a.failedProviders.includes('serper'), 'failed=' + JSON.stringify(a.failedProviders));
  assert('参与融合源为 brave+tavily', a.sources.length === 2 && a.sources.includes('brave') && a.sources.includes('tavily'), 'sources=' + JSON.stringify(a.sources));
  assert('双源一致 → basis=verified', a.agree === true && a.basis === 'verified', 'agree=' + a.agree + ' basis=' + a.basis);
  assert('共享域名被识别', a.sharedDomains.includes('example.com'), 'shared=' + JSON.stringify(a.sharedDomains));

  // ---------- 场景 B：仅单源 → 不标 verified ----------
  console.log('\n[B] 仅单源可用 → 不标 verified');
  setStub([
    ['api.search.brave.com', { status: 200, json: { web: { results: [{ title: 'Acme', url: 'https://example.com/p', description: 'd' }] } } }]
  ]);
  const b = await corroborate(Q, [braveFetcher]);
  assert('仅 1 个 ok 源', b.sources.length === 1, 'sources=' + JSON.stringify(b.sources));
  assert('单源 → basis=claimed（绝不编造 verified）', b.agree === false && b.basis === 'claimed', 'agree=' + b.agree + ' basis=' + b.basis);

  // ---------- 场景 C：双源成功但域名无交集 → claimed ----------
  console.log('\n[C] 双源成功但域名无交集 → claimed');
  setStub([
    ['api.search.brave.com', { status: 200, json: { web: { results: [{ title: 'A', url: 'https://alpha.com/p', description: 'd' }] } } }],
    ['api.tavily.com', { status: 200, json: { results: [{ title: 'B', url: 'https://beta.com/q', content: 'c' }] } }]
  ]);
  const c = await corroborate(Q, [braveFetcher, tavilyFetcher]);
  assert('双源都 ok', c.sources.length === 2, 'sources=' + JSON.stringify(c.sources));
  assert('域名无交集 → agree=false', c.agree === false, 'shared=' + JSON.stringify(c.sharedDomains));
  assert('不一致 → basis=claimed', c.basis === 'claimed', 'basis=' + c.basis);

  console.log('\n========== 结果: ' + pass + ' 通过 / ' + fail + ' 失败 ==========');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('验证脚本异常:', e); process.exit(2); });
