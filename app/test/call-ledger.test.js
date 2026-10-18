'use strict';
// ============================================================
// call-ledger.test.js —— M4 任务 C：ExternalCallLedger 旁路账本 + cost profile 归因
//
// 覆盖（对应执行计划任务 C 红线回归）：
//   · recordCall 字段校验（tenant/outcome 必填、时间/数值合法）与 append-only（UPDATE/DELETE 拒绝）
//   · 未知成本为 null 不为 0：profile 无条目 → estimated_cost=null；llm 失败/超时 attempt
//     行必有且 request_units/estimated_cost=null（绝不伪造 0）
//   · cost profile：cp-eng-v0 估算与 cost.js PRICE 同源；无条目 → {estimatedCost:null}
//   · list 过滤 + 有界分页（limit 夹紧 ≤200）
//   · llm-gateway 真实模块：成功/网络失败/5xx/超时各产账本行（mock fetch，零外呼）
//   · search fallback 链深度（tavily→brave→wigolo，fallback_depth/attempt_no）
//   · monitoring runtime collect 免费直采：estimated=0 且 trigger=job.trigger
//   · 账本写入抛错不阻断主调用（注入故障，llm/search 主路径仍成功）
//   · 既有 cost_telemetry/metering 关键断言重复（语义不变）
//   · 未知未来 schema 版本拒绝
//
// 隔离纪律：ZB_DATA_DIR 临时目录先设后 require（paths.js 加载时捕获）；
// unset MT_STORE_PATH/OBS_DB_PATH 防继承真实运行库；全部网络打在 global.fetch 桩上。
const os = require('os');
const fs = require('fs');
const nodePath = require('path');
const TMPDIR = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'zb-call-ledger-'));
process.env.ZB_DATA_DIR = TMPDIR;
delete process.env.MT_STORE_PATH;
delete process.env.OBS_DB_PATH;
// 测试确定性：清掉可能影响既有语义开关的外部环境
delete process.env.LLM_DEGRADE;
delete process.env.COST_TELEMETRY;
delete process.env.ZB_DAILY_BUDGET_YUAN;
delete process.env.ZB_QUOTA_ENABLED;
delete process.env.LLM_API_KEY;
delete process.env.LLM_BASE_URL;
delete process.env.LLM_MODEL;
delete process.env.WIGOLO_URL;
delete process.env.WIGOLO_API_TOKEN;

const assert = require('node:assert');
const { DatabaseSync } = require('node:sqlite');

const CallLedger = require('../services/call-ledger.js');
const CostProfile = require('../services/cost-profile.js');
const cost = require('../services/cost.js');
const metering = require('../services/metering.js');
const GW = require('../services/llm-gateway.js');
const als = require('../core/als.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + String(e.message || e).split('\n')[0]); }
}
function ledgerDbFile() { return nodePath.join(TMPDIR, 'call_ledger.db'); }
function rawLedgerDb() { return new DatabaseSync(ledgerDbFile()); }

// ---- fetch 桩（对齐 wigolo.test 模式：假 Response 对象，零外呼）----
const realFetch = global.fetch;
function stubFetch(routes) {
  const calls = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts: opts || {} });
    for (const [prefix, handler] of routes) {
      if (u.startsWith(prefix)) return handler(u, opts || {});
    }
    throw new Error('network forbidden: ' + u);
  };
  return calls;
}
function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}
const LLM_BODY = (content, usage) => ({ choices: [{ message: { content } }], usage });

(async () => {

// ============ 1. schema 安装：版本登记 + 表存在 ============
await t('schema 安装：call_ledger.db schema_version=1（ledger_meta 登记），表与索引存在', () => {
  CallLedger.init(); // 惰性安装（对齐 cost.js 模式）：首次使用时事务安装 schema
  const db = rawLedgerDb();
  try {
    const v = db.prepare(`SELECT value FROM ledger_meta WHERE key='schema_version'`).get();
    assert.equal(v && v.value, '1', 'schema_version 登记为 1');
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name);
    assert.ok(tables.includes('call_ledger'), 'call_ledger 表存在');
    const triggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'`).all().map(r => r.name);
    assert.ok(triggers.includes('call_ledger_append_only_update'), 'append-only UPDATE 触发器');
    assert.ok(triggers.includes('call_ledger_append_only_delete'), 'append-only DELETE 触发器');
  } finally { db.close(); }
});

// ============ 2. recordCall 校验 ============
await t('recordCall 校验：tenant/outcome 必填，非法时间/数值拒绝，合法写入返回 call_id', () => {
  // 除被测字段外其余必填字段齐全，确保抛错点就是被测字段（校验按字段顺序短路）
  const base = { tenantId: 't', capability: 'cap', provider: 'p', operation: 'op', trigger: 'manual', costProfileVersion: 'cp-eng-v0', outcome: 'success' };
  assert.throws(() => CallLedger.recordCall(null), /ENTRY/);
  assert.throws(() => CallLedger.recordCall({ ...base, tenantId: undefined }), /tenantId/);
  assert.throws(() => CallLedger.recordCall({ ...base, outcome: '' }), /outcome/);
  assert.throws(() => CallLedger.recordCall({ ...base, provider: '   ' }), /provider/);
  assert.throws(() => CallLedger.recordCall({ ...base, startedAt: 'not-a-date' }), /startedAt/);
  assert.throws(() => CallLedger.recordCall({ ...base, attemptNo: 0 }), /attemptNo/);
  assert.throws(() => CallLedger.recordCall({ ...base, requestUnits: 'abc' }), /requestUnits/);
  assert.throws(() => CallLedger.recordCall({ ...base, estimatedCost: 'x' }), /estimatedCost/);
  const id1 = CallLedger.recordCall({
    tenantId: 't-valid', projectId: 'proj-1', workspaceId: 'ws-1', watchTargetId: 'wt-1', brandId: 'b-1',
    capability: 'cap', provider: 'prov', operation: 'op', trigger: 'manual',
    costProfileVersion: CostProfile.VERSION, requestUnits: 5, estimatedCost: 0.5,
    cacheHit: true, canonicalReuseHit: false, fallbackDepth: 1, attemptNo: 2,
    startedAt: Date.now() - 100, completedAt: Date.now(), outcome: 'success', errorCode: null,
  });
  const id2 = CallLedger.recordCall({
    tenantId: 't-valid', capability: 'cap', provider: 'prov', operation: 'op', trigger: 'manual',
    costProfileVersion: CostProfile.VERSION, outcome: 'failed', errorCode: 'E_X',
  });
  assert.ok(/^cl_/.test(id1) && /^cl_/.test(id2) && id1 !== id2, 'call_id 前缀 cl_ 且唯一');
  const db = rawLedgerDb();
  try {
    const r1 = db.prepare('SELECT * FROM call_ledger WHERE call_id=?').get(id1);
    assert.equal(r1.tenant_id, 't-valid'); assert.equal(r1.project_id, 'proj-1');
    assert.equal(r1.workspace_id, 'ws-1'); assert.equal(r1.watch_target_id, 'wt-1'); assert.equal(r1.brand_id, 'b-1');
    assert.equal(r1.request_units, 5); assert.equal(r1.estimated_cost, 0.5);
    assert.equal(r1.cache_hit, 1); assert.equal(r1.canonical_reuse_hit, 0);
    assert.equal(r1.fallback_depth, 1); assert.equal(r1.attempt_no, 2);
    assert.equal(r1.outcome, 'success'); assert.equal(r1.cost_profile_version, CostProfile.VERSION);
    assert.ok(!isNaN(Date.parse(r1.started_at)) && !isNaN(Date.parse(r1.completed_at)), 'ISO 时间落库');
    const r2 = db.prepare('SELECT * FROM call_ledger WHERE call_id=?').get(id2);
    assert.equal(r2.project_id, null, 'project 可空');
    assert.equal(r2.request_units, null, '缺省 request_units 为 null');
    assert.equal(r2.estimated_cost, null, '缺省 estimated_cost 为 null');
    assert.equal(r2.fallback_depth, 0, 'fallback_depth 默认 0');
    assert.equal(r2.attempt_no, 1, 'attempt_no 默认 1');
    assert.equal(r2.error_code, 'E_X');
  } finally { db.close(); }
});

// ============ 3. append-only：只插不改 ============
await t('append-only：UPDATE/DELETE 被 RAISE(ABORT) 拒绝，只有 INSERT 可写', () => {
  const db = rawLedgerDb();
  try {
    // 先保证有数据行：BEFORE 触发器只对命中行的语句生效（零行 UPDATE 不触发，语义同 SQLite）
    if (!db.prepare('SELECT COUNT(*) AS n FROM call_ledger').get().n) {
      CallLedger.recordCall({ tenantId: 't-append-only', capability: 'cap', provider: 'p', operation: 'op', trigger: 'manual', costProfileVersion: 'cp-eng-v0', outcome: 'success' });
    }
    assert.throws(() => db.prepare(`UPDATE call_ledger SET outcome='tampered'`).run(), /append-only/);
    assert.throws(() => db.prepare('DELETE FROM call_ledger').run(), /append-only/);
    // 复审 I-1 红线：INSERT OR REPLACE 的隐式 DELETE 不触发 DELETE 触发器
    // （recursive_triggers=0），必须由 BEFORE INSERT 冲突拒绝触发器拦下。
    const existing = db.prepare('SELECT call_id, outcome FROM call_ledger LIMIT 1').get();
    assert.throws(() => db.prepare(
      `INSERT OR REPLACE INTO call_ledger (call_id, tenant_id, capability, provider, operation, "trigger", cost_profile_version, started_at, completed_at, outcome)
       VALUES (?, 't-append-only', 'cap', 'p', 'op', 'manual', 'cp-eng-v0', '2026-10-18T00:00:00Z', '2026-10-18T00:00:01Z', 'tampered')`
    ).run(existing.call_id), /append-only/);
    assert.equal(db.prepare('SELECT outcome FROM call_ledger WHERE call_id=?').get(existing.call_id).outcome, existing.outcome, '原行未被 REPLACE 改写');
    const n = db.prepare('SELECT COUNT(*) AS n FROM call_ledger').get().n;
    assert.ok(n >= 2, '既有行未被破坏');
  } finally { db.close(); }
});

// ============ 4. 未知成本为 null 不为 0 ============
await t('未知成本为 null：无 profile 条目的 provider 行 estimated_cost=null（绝不为 0）', () => {
  CallLedger.recordCall({
    tenantId: 't-null-cost', capability: 'cap', provider: 'mystery-provider', operation: 'op',
    trigger: 'manual', costProfileVersion: CostProfile.estimate({ provider: 'mystery-provider' }).costProfileVersion,
    requestUnits: 7, estimatedCost: CostProfile.estimate({ provider: 'mystery-provider', requestUnits: 7 }).estimatedCost,
    outcome: 'success',
  });
  const row = CallLedger.list({ tenantId: 't-null-cost' }).rows[0];
  assert.equal(row.provider, 'mystery-provider');
  assert.equal(row.estimated_cost, null, 'estimated_cost=null');
  assert.equal(row.request_units, 7, 'request_units 照实记录');
  assert.equal(row.cost_profile_version, 'cp-eng-v0', '已咨询的口径版本照记');
});

// ============ 5. cost profile：无条目 → null；有条目与 cost.js 同源 ============
await t('cost profile：无条目 → {estimatedCost:null, costProfileVersion:cp-eng-v0}', () => {
  const r = CostProfile.estimate({ provider: 'never-heard-of', operation: 'op' });
  assert.deepEqual(r, { estimatedCost: null, costProfileVersion: 'cp-eng-v0' });
  assert.equal(CostProfile.estimate({ provider: 'llm', operation: 'chat', requestUnits: 12345 }).estimatedCost, null,
    'LLM 只有总 token 无 in/out 拆分 → null（不伪造拆分）');
  assert.equal(CostProfile.estimate({ provider: 'llm', requestUnits: null }).estimatedCost, null);
});

await t('cost profile：LLM 估算与 cost.js PRICE 同源；wigolo/shopify 记 0；付费搜索 0.002/次', () => {
  const usage = { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_cache_hit_tokens: 0 };
  const est = CostProfile.estimate({ provider: 'llm', operation: 'chat_completions', requestUnits: usage });
  assert.ok(Math.abs(est.estimatedCost - cost.costOf(usage)) < 1e-12, '与 cost.costOf 完全同源');
  assert.equal(est.costProfileVersion, 'cp-eng-v0');
  const usageHit = { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_cache_hit_tokens: 1000000 };
  assert.ok(Math.abs(CostProfile.estimate({ provider: 'llm', requestUnits: usageHit }).estimatedCost - cost.costOf(usageHit)) < 1e-12,
    '缓存命中口径同源（in=0.02/1M）');
  assert.equal(CostProfile.estimate({ provider: 'wigolo', operation: 'search' }).estimatedCost, 0, 'wigolo 自托管 0');
  assert.equal(CostProfile.estimate({ provider: 'shopify_products_json', operation: 'direct_collect' }).estimatedCost, 0, 'shopify 公开端点 0');
  assert.equal(CostProfile.estimate({ provider: 'serper', operation: 'search', requestUnits: 1 }).estimatedCost, 0.002, '付费搜索 0.002/次');
  assert.equal(CostProfile.estimate({ provider: 'tavily', operation: 'search', requestUnits: 3 }).estimatedCost, 0.006, 'requestUnits 倍数');
});

// ============ 6. list 过滤 + 有界分页 ============
await t('list 过滤分页有界：filters 生效，limit 夹紧 ≤200，offset 越界安全', () => {
  for (let i = 0; i < 210; i++) {
    CallLedger.recordCall({
      tenantId: 't-list', capability: 'cap', provider: i % 2 ? 'p1' : 'p2', operation: 'op',
      trigger: i % 3 ? 'manual' : 'discovery', costProfileVersion: 'cp-eng-v0',
      outcome: i % 4 ? 'success' : 'failed',
    });
  }
  const all = CallLedger.list({ tenantId: 't-list' });
  assert.equal(all.total, 210);
  assert.equal(all.rows.length, 50, '默认 limit 50');
  assert.equal(CallLedger.list({ tenantId: 't-list', limit: 1000 }).rows.length, 200, 'limit 有界（≤200）');
  assert.equal(CallLedger.list({ tenantId: 't-list', limit: -3 }).rows.length, 1, '非法 limit 夹到 1');
  assert.equal(CallLedger.list({ tenantId: 't-list', offset: -10 }).rows.length, 50, '非法 offset 夹到 0');
  const p1 = CallLedger.list({ tenantId: 't-list', provider: 'p1' });
  assert.equal(p1.total, 105, 'provider 过滤');
  assert.ok(p1.rows.every(r => r.provider === 'p1'));
  const failRows = CallLedger.list({ tenantId: 't-list', outcome: 'failed' });
  assert.equal(failRows.total, 53, 'outcome 过滤（210 行中 i%4==0 共 53 行）');
  assert.ok(failRows.rows.every(r => r.outcome === 'failed'));
  const page = CallLedger.list({ tenantId: 't-list', offset: 200, limit: 50 });
  assert.equal(page.rows.length, 10, 'offset 翻页到尾部');
  const trig = CallLedger.list({ tenantId: 't-list', trigger: 'discovery' });
  assert.equal(trig.total, 70, 'trigger 过滤');
  const cap = CallLedger.list({ tenantId: 't-list', capability: 'cap', limit: 1 });
  assert.equal(cap.total, 210, 'capability 过滤不改变 total 口径');
});

// ============ 7. 既有 cost/metering 关键断言重复（语义不变） ============
await t('既有语义不变：metering.shouldBill / cost.record / overDailyBudget / withinQuota', () => {
  assert.equal(metering.shouldBill(200), true);
  assert.equal(metering.shouldBill(500), true, '5xx 供应商已受理计费');
  assert.equal(metering.shouldBill(404), false);
  assert.equal(metering.shouldBill({ error: 'timeout' }), false, '网络层失败不计');
  const usage = { prompt_tokens: 1000000, completion_tokens: 500000, prompt_cache_hit_tokens: 0 };
  assert.ok(Math.abs(cost.costOf(usage) - (1.0 + 1.0)) < 1e-12, 'costOf 口径不变');
  cost.record({ tenantId: 't-cost-legacy', kind: 'search', calls: 1, costYuan: 0.002 });
  assert.ok(cost.dailySpend('t-cost-legacy') >= 0.002, 'cost_telemetry 记账照常');
  assert.equal(cost.overDailyBudget('t-cost-legacy'), false, '无预算配置不熔断');
  assert.equal(metering.withinQuota('t-cost-legacy', 'searchCalls'), true, '配额开关默认放行');
});

// ============ 8. llm-gateway 成功路径产生账本行 ============
await t('llm-gateway 成功：账本行 outcome=success，request_units=usage tokens，estimated 同源，cost_telemetry 照常', () => {
  const routes = stubFetch([
    ['https://llm-unit.example/', () => jsonResponse(200, LLM_BODY('{"ok":1}', { prompt_tokens: 1000000, completion_tokens: 1000000, prompt_cache_hit_tokens: 0 }))],
  ]);
  try {
    return GW.call([{ role: 'user', content: 'x' }], {
      apiKey: 'k-ok-1', json: true, tenantId: 't-llm-ok', projectId: 'p-ok',
      baseUrl: 'https://llm-unit.example/v1', timeoutMs: 3000, maxAttempts: 1, fieldKey: 'ledger-test',
    }).then(out => {
      assert.deepEqual(out, { ok: 1 }, '主调用成功（降级未触发）');
      const { rows, total } = CallLedger.list({ tenantId: 't-llm-ok', provider: 'llm' });
      assert.equal(total, 1, '恰好一行账本');
      const row = rows[0];
      assert.equal(row.outcome, 'success');
      assert.equal(row.request_units, 2000000, 'request_units=usage tokens 总和');
      assert.ok(Math.abs(row.estimated_cost - 3.0) < 1e-9, 'estimated=1M in(¥1)+1M out(¥2)=3.0');
      assert.equal(row.cache_hit, 0);
      assert.equal(row.canonical_reuse_hit, 0);
      assert.equal(row.fallback_depth, 0);
      assert.equal(row.attempt_no, 1);
      assert.equal(row.cost_profile_version, 'cp-eng-v0');
      assert.equal(row.operation, 'chat_completions');
      assert.equal(row.project_id, 'p-ok');
      assert.ok(!isNaN(Date.parse(row.started_at)) && !isNaN(Date.parse(row.completed_at)));
      assert.equal(row.completed_at >= row.started_at, true);
      assert.equal(row.trigger, 'unknown', '未传 trigger 时不伪造归因');
      assert.ok(cost.dailySpend('t-llm-ok') >= 3.0 - 1e-9, '既有 cost_telemetry 记账不受影响');
      assert.ok(metering.usage('t-llm-ok').enrichRuns.total >= 1, '既有 metering 记账不受影响');
    });
  } finally { global.fetch = realFetch; }
});

// ============ 9. llm-gateway 失败/5xx/超时：行必有且成本 null 不为 0 ============
await t('llm-gateway 网络失败：行必有，request_units/estimated_cost=null，outcome=failed', () => {
  stubFetch([['https://llm-fail.example/', () => { throw new Error('ECONNRESET: socket hang up'); }]]);
  try {
    return GW.call([{ role: 'user', content: 'x' }], {
      apiKey: 'k-fail-1', json: true, tenantId: 't-llm-fail',
      baseUrl: 'https://llm-fail.example/v1', timeoutMs: 3000, maxAttempts: 1,
    }).then(out => {
      assert.deepEqual(out, {}, '字段级降级（既有行为不变）');
      const { rows, total } = CallLedger.list({ tenantId: 't-llm-fail' });
      assert.equal(total, 1, '失败 attempt 必有行');
      assert.equal(rows[0].outcome, 'failed');
      assert.equal(rows[0].request_units, null, 'usage 未知 → null 不为 0');
      assert.equal(rows[0].estimated_cost, null, '成本未知 → null 不为 0');
      assert.ok(/ECONNRESET/.test(rows[0].error_code), 'error_code 留真');
    });
  } finally { global.fetch = realFetch; }
});

await t('llm-gateway 5xx：outcome=failed，error_code=DEEPSEEK_500，estimated=null', () => {
  stubFetch([['https://llm-5xx.example/', () => jsonResponse(500, { error: 'boom' })]]);
  try {
    return GW.call([{ role: 'user', content: 'x' }], {
      apiKey: 'k-5xx-1', json: true, tenantId: 't-llm-5xx',
      baseUrl: 'https://llm-5xx.example/v1', timeoutMs: 3000, maxAttempts: 1,
    }).then(out => {
      assert.deepEqual(out, {});
      const row = CallLedger.list({ tenantId: 't-llm-5xx' }).rows[0];
      assert.equal(row.outcome, 'failed');
      assert.equal(row.error_code, 'DEEPSEEK_500');
      assert.equal(row.estimated_cost, null);
      assert.equal(row.request_units, null);
    });
  } finally { global.fetch = realFetch; }
});

await t('llm-gateway 超时（AbortError）：outcome=timeout，成本 null', () => {
  stubFetch([['https://llm-to.example/', () => {
    const e = new Error('This operation was aborted'); e.name = 'AbortError'; throw e;
  }]]);
  try {
    return GW.call([{ role: 'user', content: 'x' }], {
      apiKey: 'k-to-1', json: true, tenantId: 't-llm-timeout',
      baseUrl: 'https://llm-to.example/v1', timeoutMs: 3000, maxAttempts: 1,
    }).then(out => {
      assert.deepEqual(out, {});
      const row = CallLedger.list({ tenantId: 't-llm-timeout' }).rows[0];
      assert.equal(row.outcome, 'timeout');
      assert.equal(row.estimated_cost, null);
      assert.equal(row.request_units, null);
    });
  } finally { global.fetch = realFetch; }
});

// ============ 10. 账本写入抛错不阻断主调用（旁路观测） ============
await t('账本写入抛错不阻断主调用：llm 与 search 主路径照常成功', async () => {
  const origRecord = CallLedger.recordCall;
  CallLedger.recordCall = () => { throw new Error('injected ledger fault'); };
  try {
    // --- llm 主路径 ---
    stubFetch([['https://llm-fault.example/', () => jsonResponse(200, LLM_BODY('{"fine":true}', { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 0 }))]]);
    try {
      const out = await GW.call([{ role: 'user', content: 'x' }], {
        apiKey: 'k-fault-1', json: true, tenantId: 't-llm-fault',
        baseUrl: 'https://llm-fault.example/v1', timeoutMs: 3000, maxAttempts: 1,
      });
      assert.deepEqual(out, { fine: true }, '账本故障不影响 llm 主调用');
    } finally { global.fetch = realFetch; }
    // --- search 主路径（wigolo 兜底成功）---
    for (const m of ['services/providers/health.js', 'research/search.js']) delete require.cache[require.resolve('../' + m)];
    const Search = require('../research/search.js');
    stubFetch([
      ['https://api.tavily.com', () => { throw new Error('ECONNREFUSED'); }],
      ['https://api.search.brave.com', () => { throw new Error('ECONNREFUSED'); }],
      ['http://wigolo-fault.test', () => jsonResponse(200, { results: [{ title: 'w', url: 'https://r.example', content: 'c' }] })],
    ]);
    try {
      const config = { search: { provider: 'tavily', tavilyKey: 'k-t', braveKey: 'k-b', wigoloUrl: 'http://wigolo-fault.test' } };
      const result = await als.requestScope.run('t-search-fault', () =>
        Search.searchProvider('fault query', config, 'us', 'off'));
      assert.equal(result.results.length, 1, '账本故障不影响搜索主链（wigolo 兜底成功）');
    } finally { global.fetch = realFetch; }
  } finally { CallLedger.recordCall = origRecord; }
});

// ============ 11. search fallback 链深度 ============
await t('search fallback 链：tavily(0,1)→brave(1,2)→wigolo(2,3)，失败行 estimated=null，wigolo 成功行 estimated=0', async () => {
  for (const m of ['services/providers/health.js', 'research/search.js']) delete require.cache[require.resolve('../' + m)];
  const Search = require('../research/search.js');
  const routes = stubFetch([
    ['https://api.tavily.com', () => { throw new Error('ECONNREFUSED'); }],
    ['https://api.search.brave.com', () => { throw new Error('ECONNREFUSED'); }],
    ['http://wigolo-chain.test', () => jsonResponse(200, { results: [{ title: 'w', url: 'https://r.example', content: 'c' }] })],
  ]);
  try {
    const config = { search: { provider: 'tavily', tavilyKey: 'k-t', braveKey: 'k-b', wigoloUrl: 'http://wigolo-chain.test' } };
    const result = await als.requestScope.run('t-search-chain', () =>
      Search.searchProvider('chain query', config, 'us', 'off'));
    assert.equal(result.results.length, 1, 'wigolo 兜底成功');
    assert.equal(routes.length, 3, '三次真实 provider 调用');
    const { rows, total } = CallLedger.list({ tenantId: 't-search-chain' });
    assert.equal(total, 3, '每个真实 provider 调用一行（缓存未命中路径）');
    const byProvider = Object.fromEntries(rows.map(r => [r.provider, r]));
    assert.deepEqual(
      rows.slice().sort((a, b) => a.attempt_no - b.attempt_no).map(r => [r.provider, r.fallback_depth, r.attempt_no, r.outcome]),
      [['tavily', 0, 1, 'failed'], ['brave', 1, 2, 'failed'], ['wigolo', 2, 3, 'success']],
      'fallback_depth/attempt_no 沿链记录');
    assert.equal(byProvider.tavily.estimated_cost, null, '付费源失败行成本 null 不伪造');
    assert.equal(byProvider.brave.estimated_cost, null);
    assert.equal(byProvider.wigolo.estimated_cost, 0, 'wigolo 成功行按 profile 记 0');
    assert.equal(byProvider.wigolo.cost_profile_version, 'cp-eng-v0');
    assert.equal(byProvider.tavily.request_units, null, '失败行 request_units=null');
    assert.equal(byProvider.wigolo.request_units, 1, '搜索成功行 request_units=1 次');
    assert.ok(rows.every(r => r.capability === 'web_search'), 'capability 归因');
    assert.ok(rows.every(r => r.trigger === 'manual'), 'probe 调研归因 manual（serp-discover 才是 discovery）');
    assert.ok(rows.every(r => r.cache_hit === 0), '缓存未命中路径 cache_hit=0');
  } finally { global.fetch = realFetch; }
});

// ============ 12. monitoring runtime collect 免费直采入账 ============
await t('monitoring collect：免费直采 estimated=0、trigger=job.trigger=monitor；collect 抛错行 outcome=timeout 且主链照常收束', async () => {
  const { fixture } = require('./monitoring-store.test');
  const f = fixture();
  try {
    // 租户登记：db.js 已绑定本测试 TMPDIR 存储（文件顶部 unset MT_STORE_PATH 后加载）；
    // db.js 未导出连接句柄，经导出的 STORE_PATH 开第二个 WAL 连接写入（顺序执行，隔离无碍）
    const DB = require('../services/db');
    new DatabaseSync(DB.STORE_PATH).prepare('INSERT INTO tenants(id,name,email,createdAt) VALUES(?,?,?,?)')
      .run(f.tenantId, 'synthetic', '', '2026-10-18');
    const { createMonitoringQueue } = require('../services/monitoring-queue');
    const { createMonitoringRuntime } = require('../research/monitoring');
    let now = Date.parse('2026-10-17T10:00:00Z');
    const config = { maxPending: 1, providerMinIntervalMs: 1, leaseMs: 1000 };
    const queue = createMonitoringQueue({ store: f.store, config, clock: () => now });
    let collectErr = null;
    const runtime = createMonitoringRuntime({
      store: f.store, queue, clock: () => now,
      collect: async () => { if (collectErr) throw collectErr; return { ok: false, error: 'shopify_unreachable' }; },
    });
    const w = f.workspace('ws-ledger');
    const seed = f.seed(w, 'ledger1');
    f.write('research/' + f.ns + '/' + seed.input.projectId + '.json', seed.project);
    const target = f.store.createWatchTarget(seed.input);
    assert.ok(target && target.watch_target_id, 'watch target 建立成功');

    runtime.tick(now); await runtime.drain(now);
    let { rows, total } = CallLedger.list({ tenantId: f.tenantId });
    assert.equal(total, 1, '每次 collect 恰好一行账本');
    let row = rows[0];
    assert.equal(row.provider, 'shopify_products_json');
    assert.equal(row.capability, 'product_catalog');
    assert.equal(row.operation, 'direct_collect');
    assert.equal(row.trigger, 'monitor', 'trigger=job.trigger');
    assert.equal(row.estimated_cost, 0, '免费公开端点按 profile 记 0');
    assert.equal(row.cost_profile_version, 'cp-eng-v0');
    assert.equal(row.outcome, 'failed', 'source.ok=false → outcome 留真（不伪造成功）');
    assert.equal(row.error_code, 'shopify_unreachable');
    assert.equal(row.tenant_id, f.tenantId);
    assert.equal(row.watch_target_id, target.watch_target_id, 'watch_target 尽力透传');
    assert.equal(row.workspace_id, w.workspace_id, 'workspace 尽力透传');
    assert.equal(row.fallback_depth, 0); assert.equal(row.attempt_no, 1);

    // collect 抛错：账本行照记（timeout），execute 既有失败收束不受影响。
    // 推进到下一调度窗口（同窗口 tick 会被 queue 去重，不产生新 collect——既有语义）。
    now = Date.parse('2026-10-17T18:00:00Z');
    collectErr = new Error('connection timeout after 30000ms');
    runtime.tick(now); await runtime.drain(now);
    ({ rows, total } = CallLedger.list({ tenantId: f.tenantId }));
    assert.equal(total, 2, '抛错 attempt 同样入账');
    row = rows.find(r => r.outcome === 'timeout');
    assert.ok(row, '抛错行 outcome=timeout');
    assert.ok(/connection timeout/.test(row.error_code), 'error_code 留真');
    assert.equal(row.estimated_cost, 0, '免费直采失败行仍按 profile 记 0（操作本身免费）');
    assert.equal(row.trigger, 'monitor');
  } finally {
    global.fetch = realFetch;
    f.store.close();
    fs.rmSync(f.dir, { recursive: true, force: true });
  }
});

// ============ 13. 未知未来 schema 版本拒绝（置于最后：会污染模块缓存） ============
await t('未知未来 schema 版本拒绝：ledger_meta 被改写为 2 后，新实例 init 抛错', () => {
  const db = rawLedgerDb();
  try {
    db.prepare(`UPDATE ledger_meta SET value='2' WHERE key='schema_version'`).run();
  } finally { db.close(); }
  delete require.cache[require.resolve('../services/call-ledger.js')];
  let msg = '';
  try {
    const Fresh = require('../services/call-ledger.js');
    Fresh.list({});
  } catch (e) { msg = String(e && e.message || e); }
  assert.ok(/SCHEMA_VERSION_UNSUPPORTED/.test(msg), '实际抛错: ' + msg);
});

console.log('');
console.log(failed ? `call-ledger.test: ${failed} failed, ${passed} passed` : `call-ledger.test: all ${passed} passed`);
process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
