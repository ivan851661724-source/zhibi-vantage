'use strict';
// Wigolo 自托管搜索降级源（KnockOutEZ/wigolo）单测：
//   · wigoloSearch 归一化（snippet/excerpt/content 三种字段）+ 请求契约（POST /v1/search、Bearer token、30s 有界超时）
//   · 错误传播（WIGOLO_<status>）与 NO_WIGOLO_URL 防御
//   · 降级链接线：付费源全断/全 exhausted → wigolo 兜底；daemon 不健康 → 跳过不白等；成本记 0
//   · 无任何源 → SEARCH_QUOTA（原语义不回归）
// 数据目录用 ZB_DATA_DIR 隔离到临时目录（对齐 serper-budget.test.js 模式）；fetch 全局打桩。
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ok - ' + name); })
    .catch(e => { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-wigolo-'));
process.env.ZB_DATA_DIR = TMP;
delete process.env.WIGOLO_URL;
delete process.env.WIGOLO_API_TOKEN;

function freshModules() {
  for (const m of ['core/paths.js', 'services/providers/health.js', 'services/providers/search.js',
    'services/cache.js', 'services/metering.js', 'services/cost.js', 'core/als.js', 'research/search.js']) {
    delete require.cache[require.resolve('../' + m)];
  }
}

// fetch 打桩：按 URL 前缀路由；记录每次调用供断言
function stubFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts || {} });
    for (const [prefix, handler] of routes) {
      if (u.startsWith(prefix)) return handler(u, opts || {});
    }
    return { ok: false, status: 599, text: async () => 'unrouted:' + u };
  };
  return calls;
}
const realFetch = global.fetch;

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

const WIGOLO_OK_BODY = {
  results: [
    { title: 'A', url: 'https://a.example/', snippet: 'snippet 字段' },
    { title: 'B', url: 'https://b.example/', excerpt: 'excerpt 字段' },
    { title: 'C', url: 'https://c.example/', content: 'content 字段' },
  ],
  engines_used: ['bing', 'duckduckgo'],
};

(async () => {
  console.log('=== wigolo.test.js ===');

  await t('1. wigoloSearch：POST {base}/v1/search，snippet/excerpt/content 均归一化为 content；带 Bearer token', async () => {
    freshModules();
    const { wigoloSearch } = require('../services/providers/search.js');
    const calls = stubFetch([
      ['http://127.0.0.1:3333', (u, o) => {
        assert.strictEqual(u, 'http://127.0.0.1:3333/v1/search');
        assert.strictEqual(o.headers['Authorization'], 'Bearer tok-123');
        const body = JSON.parse(o.body);
        assert.strictEqual(body.query, 'test q');
        assert.strictEqual(body.max_results, 10);
        assert.strictEqual(body.search_depth, 'fast');
        return jsonResponse(200, WIGOLO_OK_BODY);
      }],
    ]);
    const out = await wigoloSearch('test q', 'http://127.0.0.1:3333/', 'tok-123');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(out.results.length, 3);
    assert.strictEqual(out.results[0].content, 'snippet 字段');
    assert.strictEqual(out.results[1].content, 'excerpt 字段');
    assert.strictEqual(out.results[2].content, 'content 字段');
    assert.strictEqual(out.results[0].url, 'https://a.example/');
  });

  await t('2. wigoloSearch：非 2xx → WIGOLO_<status>（含 status）；空 URL → NO_WIGOLO_URL', async () => {
    freshModules();
    const { wigoloSearch } = require('../services/providers/search.js');
    stubFetch([['http://bad', () => jsonResponse(401, { error: 'unauthorized', error_reason: 'unauthorized' })]]);
    await assert.rejects(() => wigoloSearch('q', 'http://bad', 'nope'), e => e.message === 'WIGOLO_401' && e.status === 401);
    await assert.rejects(() => wigoloSearch('q', '   ', ''), e => e.message === 'NO_WIGOLO_URL');
  });

  await t('3. 降级链：付费源一个都没配 + wigolo 已配置 → wigolo 兜底成功，成本记 0', async () => {
    freshModules();
    const S = require('../services/providers/search.js');
    const Search = require('../research/search.js');
    const Cost = require('../services/cost.js');
    const Metering = require('../services/metering.js');
    const costRecs = []; Cost.record = o => costRecs.push(o);
    const meterRecs = []; Metering.recordCall = (tid, kind, n) => meterRecs.push({ kind, n });
    stubFetch([['http://wigolo.internal', (u, o) => {
      assert.strictEqual(o.headers['Authorization'], 'Bearer env-tok'); // env token 注入
      return jsonResponse(200, WIGOLO_OK_BODY);
    }]]);
    const config = { search: { provider: 'serper', wigoloUrl: 'http://wigolo.internal', wigoloToken: '' } };
    process.env.WIGOLO_API_TOKEN = 'env-tok';
    try {
      const out = await Search.searchProvider('fallback q', config, 'us', 'off');
      assert.strictEqual(out.results.length, 3);
      assert.strictEqual(costRecs.length, 1);
      assert.strictEqual(costRecs[0].costYuan, 0, 'self-hosted wigolo must record zero marginal cost');
      assert.strictEqual(costRecs[0].calls, 1);
      assert.deepStrictEqual(meterRecs, [{ kind: 'searchCalls', n: 1 }]);
    } finally { delete process.env.WIGOLO_API_TOKEN; }
  });

  await t('4. 降级链：付费源失败（serper 402）→ wigolo 接管，结果可用', async () => {
    freshModules();
    const S = require('../services/providers/search.js');
    const Search = require('../research/search.js');
    const Health = require('../services/providers/health.js');
    stubFetch([
      ['https://google.serper.dev', () => jsonResponse(402, { error: 'Not enough credits' })],
      ['http://wigolo.internal', () => jsonResponse(200, WIGOLO_OK_BODY)],
    ]);
    const config = { search: { provider: 'serper', serperKey: 'sk-test', wigoloUrl: 'http://wigolo.internal' } };
    const out = await Search.searchProvider('paid-fail q', config, 'us', 'off');
    assert.strictEqual(out.results.length, 3);
    assert.strictEqual(Health.isHealthy('wigolo'), true);
    assert.strictEqual(Health.isExhausted('wigolo'), false, 'wigolo must NOT be marked exhausted when paid source failed');
  });

  await t('5. wigolo daemon 连续失败 → 健康度垫底跳过，不再白等（无付费源 → SEARCH_QUOTA）', async () => {
    freshModules();
    const Search = require('../research/search.js');
    const Health = require('../services/providers/health.js');
    for (let i = 0; i < 3; i++) Health.recordFail('wigolo', new Error('WIGOLO_503'));
    assert.strictEqual(Health.isHealthy('wigolo'), false, 'fail rate 100% (>=3 samples) must be unhealthy');
    const calls = stubFetch([['http://wigolo.internal', () => jsonResponse(200, WIGOLO_OK_BODY)]]);
    const config = { search: { provider: 'serper', wigoloUrl: 'http://wigolo.internal' } };
    await assert.rejects(() => Search.searchProvider('down q', config, 'us', 'off'), e => e.message === 'SEARCH_QUOTA');
    assert.strictEqual(calls.length, 0, 'unhealthy wigolo must not be called at all');
  });

  await t('6. 无任何源（含未配 wigolo）→ SEARCH_QUOTA 原语义不回归', async () => {
    freshModules();
    const Search = require('../research/search.js');
    const calls = stubFetch([]);
    const config = { search: { provider: 'serper' } };
    await assert.rejects(() => Search.searchProvider('nothing q', config, 'us', 'off'), e => e.message === 'SEARCH_QUOTA');
    assert.strictEqual(calls.length, 0);
  });

  await t('7. config 密钥加密：wigoloToken 进 SECRET_PATHS（MT_MASTER_KEY 下落盘密文、loadConfig 回填明文）', async () => {
    freshModules();
    process.env.MT_MASTER_KEY = '7a'.repeat(32);
    try {
      const Paths = require('../core/paths.js');
      fs.mkdirSync(Paths.DATA, { recursive: true });
      const Config = require('../core/config.js');
      await Config.saveConfig({ search: { wigoloUrl: 'http://wigolo.internal', wigoloToken: 'plain-tok' } });
      const raw = JSON.parse(fs.readFileSync(Paths.CONFIG_PATH, 'utf8'));
      assert.strictEqual(raw.search.wigoloToken, undefined, 'token must be lifted out of plaintext layer');
      assert.ok(raw.secrets && raw.secrets.data && raw.secrets.iv && raw.secrets.tag, 'encrypted bundle must exist');
      assert.strictEqual(JSON.stringify(raw).includes('plain-tok'), false, 'token must never appear in plaintext on disk');
      const back = Config.loadConfig();
      assert.strictEqual(back.search.wigoloToken, 'plain-tok');
      assert.strictEqual(back.search.wigoloUrl, 'http://wigolo.internal', 'non-secret URL stays plaintext');
    } finally { delete process.env.MT_MASTER_KEY; }
  });

  await t('8. activeSearchKey：只配 wigolo 也算「已配置搜索能力」（闸门不误杀）', () => {
    freshModules();
    const S = require('../services/providers/search.js');
    const Config = require('../core/config.js');
    assert.strictEqual(S.activeSearchKey({ search: { wigoloUrl: 'http://w:3333' } }), 'http://w:3333');
    assert.strictEqual(S.activeSearchKey({ search: {} }), null);
    assert.strictEqual(S.activeSearchKey({ search: { wigoloUrl: '' } }), null);
    process.env.WIGOLO_URL = 'http://env-w:3333';
    try {
      assert.strictEqual(S.activeSearchKey({ search: {} }), 'http://env-w:3333');
      assert.strictEqual(Config.activeSearchKey({ search: { provider: 'serper' } }), 'http://env-w:3333');
    } finally { delete process.env.WIGOLO_URL; }
  });

  global.fetch = realFetch;
  console.log(`\nwigolo.test: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
