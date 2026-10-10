'use strict';
// ============================================================
// Stage 4 单测：Demo fixture 播种器 + AI 解读端点纪律
//   · 固定场景 39→29 完整走真实事实链；产物标记 Demo / Sample Data
//   · 播种幂等（already）；AI 解读：无 key 诚实 503；prompt 只喂 Event 真值
// 隔离：ZB_DATA_DIR 临时目录；测试零真实 LLM/网络调用
// ============================================================
const os = require('os');
const fs = require('fs');
const path = require('path');
const assert = require('node:assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-m0-demo-'));
process.env.ZB_DATA_DIR = TMP;
delete process.env.LLM_API_KEY; // 确保 503 分支可测

const Fixture = require('../research/demo-fixture.js');
const Events = require('../research/domain-event.js');
const logger = require('../services/logger.js');
for (const k of ['debug', 'info', 'warn', 'error']) logger[k] = () => {};

const TA = 'tenant:demo-stage4';
let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}

// ============ 1. 播种 → 全链事件（39→29 decrease，fixture 标记） ============
t('1. Seed drives real chain: 39->29 price_change_observed with fixture tag', () => {
  const r = Fixture.seedDemoScenario({ tenantId: TA });
  assert.equal(r.seeded, true);
  const evt = Events.getEventById(TA, r.chain.event_id);
  assert.ok(evt, 'event persisted');
  assert.equal(evt.event_type, 'price_change_observed');
  assert.equal(evt.old_price, 39);
  assert.equal(evt.new_price, 29);
  assert.equal(evt.direction, 'decrease');
  assert.equal(evt.pct, -25.641);
  assert.equal(evt.entity_ref && evt.entity_ref.brand_name, 'Demo Brand');
  assert.equal(evt.entity_ref && evt.entity_ref.is_fixture, true);
  assert.ok(String(evt.note || '').includes('Demo / Sample Data'));
  // 全链 id 齐备
  assert.ok(r.chain.snapshot_a && r.chain.snapshot_b);
  assert.ok(r.chain.evidence_a.length && r.chain.evidence_b.length);
  assert.ok(r.chain.fact_a && r.chain.fact_b && r.chain.diff_id);
});

// ============ 2. 播种幂等：重跑 already，事件数不增 ============
t('2. Seed idempotent: rerun -> already:true, event count unchanged', () => {
  const before = Events.listEvents(TA).length;
  const r = Fixture.seedDemoScenario({ tenantId: TA });
  assert.equal(r.already, true);
  assert.equal(Events.listEvents(TA).length, before);
});

// ============ 3. AI 解读端点：无 key 诚实 503（不伪造 AI 输出） ============
t('3. AI interpretation without LLM key -> honest 503 (no fabricated insight)', async () => { /* async 占位 */ });
(async () => {
  // 3. 无 key → 503
  try {
    const H = require('../routes/handlers/demo.js');
    const sent = [];
    const ctx = { sendJSON: (res, code, obj) => { sent.push({ code, obj }); return obj; }, loadConfig: () => ({ llm: { apiKey: '' } }) };
    const als = require('../core/als.js');
    await als.requestScope.run(TA, async () => {
      const evt = Events.listEvents(TA)[0];
      await H.aiInterpretation(ctx, { method: 'POST' }, {}, new URL('http://x/api/demo/ai-interpretation?id=' + evt.event_id), '/api/demo/ai-interpretation');
    });
    assert.equal(sent[sent.length - 1].code, 503);
    assert.equal(sent[sent.length - 1].obj.error, 'LLM_NOT_CONFIGURED');
    passed++; console.log('ok - 3. AI interpretation without LLM key -> honest 503');
  } catch (e) { failed++; console.error('FAIL - 3. AI 503: ' + String(e.message || e).split('\n')[0]); }

  // ============ 4. prompt 纪律（静态断言）：system 禁编造；payload 只含 Event 真值 ============
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'handlers', 'demo.js'), 'utf8');
    assert.ok(/禁止编造/.test(src), 'system prompt must forbid fabrication');
    assert.ok(/禁止编造或推算任何未给出的数字/.test(src));
    // factPayload 只从 event 读取（不出现销量/GMV/AOV 字段名）
    const payloadBlock = src.slice(src.indexOf('const factPayload'), src.indexOf('const messages'));
    assert.equal(/gmv|销量|revenue/i.test(payloadBlock), false);
    // 响应必须带 model + endpoint_kind（§七 必录）
    assert.ok(/endpoint_kind/.test(src) && /model,/.test(src));
    passed++; console.log('ok - 4. AI prompt discipline (fact-only payload, records model+endpoint)');
  } catch (e) { failed++; console.error('FAIL - 4. prompt discipline: ' + String(e.message || e).split('\n')[0]); }

  // ============ 5. fixture 模块零网络零 LLM（静态断言） ============
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'research', 'demo-fixture.js'), 'utf8');
    assert.equal(/fetch\(|XMLHttpRequest|axios|openai|deepseek|dashscope|bailian/i.test(src), false);
    passed++; console.log('ok - 5. demo-fixture zero network / zero LLM');
  } catch (e) { failed++; console.error('FAIL - 5. fixture static: ' + String(e.message || e).split('\n')[0]); }

  // ============ 6. P0-2 端点解析（用户点名场景）：config 空 key + legacy DeepSeek 默认 baseUrl
  //                 不得压制 env 显式百炼端点 —— Demo AI 必须用/汇报百炼，而非 DeepSeek ============
  try {
    // 隔离环境：temp CONFIG_PATH 写入 legacy 配置（空 key + DeepSeek 默认端点）
    const Paths = require('../core/paths.js');
    fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: '', baseUrl: 'https://api.deepseek.com/v1' } }));
    process.env.LLM_API_KEY = 'fake-env-bailian-key-for-test';
    process.env.LLM_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
    process.env.LLM_MODEL = 'qwen-test-model';
    // 重载解析链，让 llm-gateway 以当前 env 重算默认端点（与生产「env 先于进程启动」语义一致）
    delete require.cache[require.resolve('../services/llm-gateway.js')];
    delete require.cache[require.resolve('../research/llm.js')];
    delete require.cache[require.resolve('../routes/handlers/demo.js')];
    const H = require('../routes/handlers/demo.js');
    const LLM = require('../services/llm-gateway.js');
    let captured = null, capturedMessages = null;
    LLM.call = async (msgs, opts) => { captured = opts; capturedMessages = msgs; return '测试解读：价格下降，建议关注。'; };
    const als = require('../core/als.js');
    const Config = require('../core/config.js');
    const sent6 = [];
    const ctx6 = { sendJSON: (res, code, obj) => { sent6.push({ code, obj }); return obj; }, loadConfig: () => Config.loadConfig() };
    const evt6 = Events.listEvents(TA)[0];
    await als.requestScope.run(TA, async () => {
      await H.aiInterpretation(ctx6, { method: 'POST' }, {}, new URL('http://x/api/demo/ai-interpretation?id=' + evt6.event_id), '/api/demo/ai-interpretation');
    });
    assert.equal(sent6[sent6.length - 1].code, 200, 'handler should succeed: ' + JSON.stringify(sent6[sent6.length - 1].obj));
    const body6 = sent6[sent6.length - 1].obj;
    assert.ok(captured, 'gateway must be invoked');
    assert.equal(JSON.parse(capturedMessages[1].content).data_label, 'Demo / Sample Data', 'AI must receive the persisted event demo label');
    assert.equal(JSON.parse(capturedMessages[1].content).currency, null, 'unknown currency must be explicit in the AI input');
    assert.equal(captured.apiKey, 'fake-env-bailian-key-for-test');       // env key（config key 为空）
    assert.equal(captured.model, 'qwen-test-model');                      // env 百炼模型
    assert.ok(String(body6.endpoint_base_url).startsWith('https://token-plan.cn-beijing.maas.aliyuncs.com/'),
      'must report Bailian endpoint, got: ' + body6.endpoint_base_url);
    assert.equal(/deepseek/i.test(body6.endpoint_base_url), false, 'legacy DeepSeek config must NOT suppress env Bailian endpoint');
    assert.equal(body6.model, 'qwen-test-model');
    assert.ok(body6.endpoint_base_url.length > 0, 'endpoint_base_url never empty');
    assert.equal(JSON.stringify(body6).includes('fake-env-bailian-key-for-test'), false, 'API key must never leak into response');
    passed++; console.log('ok - 6. P0-2 resolution: env Bailian key+endpoint wins over legacy DeepSeek config baseUrl');
  } catch (e) { failed++; console.error('FAIL - 6. P0-2 resolution: ' + String(e.message || e).split('\n')[0]); }

  // ============ 7. P0-1 前端诚实币种：fmtMoney 无 '$' 兜底；null 币种就近标注「币种信息暂不可用」 ============
  try {
    const pageSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'app', '(panel)', 'demo', 'page.tsx'), 'utf8');
    const fmtBlock = pageSrc.slice(pageSrc.indexOf('function fmtMoney'), pageSrc.indexOf('function fmtTime'));
    assert.equal(fmtBlock.includes("'$'"), false, 'fmtMoney must NOT fabricate "$" when currency is null');
    assert.ok(pageSrc.includes('币种信息暂不可用'), 'null currency must be labeled 币种信息暂不可用');
    // recent-change 卡片与 Event Detail 两处价格渲染都要挂标注
    const labels = (pageSrc.match(/币种信息暂不可用/g) || []).length;
    assert.ok(labels >= 2, 'both recent-change card and Event Detail must label unknown currency (found ' + labels + ')');
    passed++; console.log('ok - 7. P0-1 UI honesty: no fabricated "$", null currency labeled');
  } catch (e) { failed++; console.error('FAIL - 7. P0-1 UI: ' + String(e.message || e).split('\n')[0]); }

  // ============ 8. 配置回归（§十二）：config 空 key + legacy DeepSeek 值 不得压住 env 百炼配置 ============
  // 「Key 决定配置源」：config key 为空 + env key 存在 → key/baseUrl/model/modelDeep 全套取 env。
  try {
    const Paths = require('../core/paths.js');
    fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: {
      apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash', modelDeep: 'deepseek-v4-max',
    } }));
    process.env.LLM_API_KEY = 'fake-test-bailian-key';
    process.env.LLM_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
    process.env.LLM_MODEL = 'qwen3.6-flash';
    process.env.LLM_MODEL_DEEP = 'qwen3.8-max';
    delete require.cache[require.resolve('../services/llm-gateway.js')];
    delete require.cache[require.resolve('../research/llm.js')];
    const RLLM = require('../research/llm.js');
    const LLM = require('../services/llm-gateway.js');
    const key = RLLM.llmApiKey(require('../core/config.js').loadConfig());
    assert.equal(key, 'fake-test-bailian-key', 'key must come from env (config key empty)');
    const model = RLLM.resolveModel(null);
    assert.notEqual(model, 'deepseek-v4-flash', 'config legacy model must NOT suppress env LLM_MODEL');
    assert.equal(model, 'qwen3.6-flash');
    const deep = RLLM.resolveDeepModel();
    assert.notEqual(deep, 'deepseek-v4-max', 'config legacy modelDeep must NOT suppress env LLM_MODEL_DEEP');
    assert.equal(deep, 'qwen3.8-max');
    const baseUrl = LLM.normalizeBaseUrl(RLLM.resolveBaseUrl(key, null)) || LLM.DEFAULT_BASE_URL; // ''=走网关默认（env LLM_BASE_URL）
    assert.ok(baseUrl.includes('token-plan.cn-beijing.maas.aliyuncs.com'), 'endpoint must be Bailian, got: ' + baseUrl);
    assert.equal(/deepseek/i.test(baseUrl), false, 'endpoint must not contain deepseek');
    // 配置模式不回归：config key 非空 → 整套取 config
    fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: {
      apiKey: 'cfg-key-1', baseUrl: 'https://cfg.example.com/v1', model: 'cfg-model-light', modelDeep: 'cfg-model-deep',
    } }));
    delete process.env.LLM_API_KEY;
    delete require.cache[require.resolve('../research/llm.js')];
    const RLLM2 = require('../research/llm.js');
    assert.equal(RLLM2.resolveModel(null), 'cfg-model-light', 'config-key mode: cfg model wins');
    assert.equal(RLLM2.resolveDeepModel(), 'cfg-model-deep', 'config-key mode: cfg modelDeep wins');
    const RLLM3 = require('../research/llm.js');
    assert.equal(RLLM3.resolveBaseUrl('cfg-key-1', null), 'https://cfg.example.com/v1/chat/completions', 'config-key mode: cfg custom endpoint wins');
    delete require.cache[require.resolve('../research/llm.js')];
    passed++; console.log('ok - 8. config regression: env Bailian wins over legacy DeepSeek config (key/baseUrl/model/modelDeep all from one source)');
  } catch (e) { failed++; console.error('FAIL - 8. config regression: ' + String(e.message || e).split('\n')[0]); }

  // ============ 9. fixture 时间诚实（§十三）：OBS_A < OBS_B，且冻结在历史日期（非未来） ============
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'research', 'demo-fixture.js'), 'utf8');
    const mA = /const OBS_A = '([^']+)';/.exec(src);
    const mB = /const OBS_B = '([^']+)';/.exec(src);
    assert.ok(mA && mB, 'OBS_A/OBS_B must be fixed constants (deterministic, not new Date())');
    const a = new Date(mA[1]).getTime(), b = new Date(mB[1]).getTime();
    assert.ok(a < b, 'OBS_A < OBS_B');
    // 冻结在历史日期：比赛运行期（2026-10-07 起）必然晚于观察时刻，UI 不会出现"未来"变化。
    // 用固定分界日期而非 Date.now() 比较——测试长期稳定不随时间失效。
    const FROZEN_BEFORE = new Date('2026-10-08T00:00:00.000Z').getTime();
    assert.ok(b < FROZEN_BEFORE, 'both observations frozen before 2026-10-08 (no future observations)');
    // 播种产物时间顺序一致
    const evt = Events.listEvents(TA)[0];
    assert.ok(new Date(evt.observed_at_old).getTime() < new Date(evt.observed_at_new).getTime(), 'event observed_at_old < observed_at_new');
    passed++; console.log('ok - 9. fixture time honesty: OBS_A < OBS_B, frozen in history (no future observations)');
  } catch (e) { failed++; console.error('FAIL - 9. fixture time: ' + String(e.message || e).split('\n')[0]); }

  // ============ 10. refresh=1 跳过缓存强制真实调用；默认仍走缓存；不触碰真值链 ============
  try {
    const Paths = require('../core/paths.js');
    const { DATA } = Paths;
    const { sanitizeNs } = require('../core/state-store.js');
    fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: '' } })); // 触发 env key 模式
    process.env.LLM_API_KEY = 'fake-test-bailian-key';
    process.env.LLM_MODEL = 'qwen3.6-flash';
    process.env.LLM_BASE_URL = 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
    delete require.cache[require.resolve('../services/llm-gateway.js')];
    delete require.cache[require.resolve('../research/llm.js')];
    delete require.cache[require.resolve('../routes/handlers/demo.js')];
    const H = require('../routes/handlers/demo.js');
    const LLM = require('../services/llm-gateway.js');
    const fsMod = require('fs');
    const insightDir = path.join(DATA, 'ai-insights', sanitizeNs(TA));
    const evt10 = Events.listEvents(TA)[0];
    const insightPath = path.join(insightDir, evt10.event_id + '.json');
    // 预置一份"旧供应商"缓存（模拟 DeepSeek 时期产物）
    fsMod.mkdirSync(insightDir, { recursive: true });
    fsMod.writeFileSync(insightPath, JSON.stringify({ event_id: evt10.event_id, insight: '旧缓存解读', model: 'deepseek-old' }));
    let calls = 0;
    LLM.call = async () => { calls++; return '新解读：来自真实网关调用。'; };
    const als = require('../core/als.js');
    const Config = require('../core/config.js');
    const mkCtx = () => { const sent = []; return { sent, ctx: { sendJSON: (res, code, obj) => { sent.push({ code, obj }); return obj; }, loadConfig: () => Config.loadConfig() } }; };
    // refresh=1：跳过缓存 → 真实网关调用 → 覆盖缓存
    let c10 = mkCtx();
    await als.requestScope.run(TA, async () => {
      await H.aiInterpretation(c10.ctx, { method: 'POST' }, {}, new URL('http://x/api/demo/ai-interpretation?id=' + evt10.event_id + '&refresh=1'), '/api/demo/ai-interpretation');
    });
    const out = c10.sent[c10.sent.length - 1];
    assert.equal(out.code, 200, 'refresh call should succeed: ' + JSON.stringify(out.obj));
    assert.equal(calls, 1, 'refresh=1 must invoke LLM gateway (bypass cache)');
    assert.equal(out.obj.cached, false, 'refresh response cached=false');
    assert.equal(out.obj.insight, '新解读：来自真实网关调用。');
    assert.equal(JSON.parse(fsMod.readFileSync(insightPath, 'utf8')).model, out.obj.model, 'cache overwritten with fresh payload');
    // 默认（无 refresh）：命中缓存，零网关调用
    let c10b = mkCtx();
    await als.requestScope.run(TA, async () => {
      await H.aiInterpretation(c10b.ctx, { method: 'POST' }, {}, new URL('http://x/api/demo/ai-interpretation?id=' + evt10.event_id), '/api/demo/ai-interpretation');
    });
    const out2 = c10b.sent[c10b.sent.length - 1];
    assert.equal(calls, 1, 'default must still hit cache (no extra gateway call)');
    assert.equal(out2.obj.cached, true);
    // 真值链不受影响：事件数/内容不变
    assert.equal(Events.getEventById(TA, evt10.event_id).new_price, 29);
    delete require.cache[require.resolve('../routes/handlers/demo.js')];
    passed++; console.log('ok - 10. refresh=1 bypasses insight cache & forces real gateway call; truth chain untouched');
  } catch (e) { failed++; console.error('FAIL - 10. refresh: ' + String(e.message || e).split('\n')[0]); }

  console.log('\ndemo-fixture.test: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
})();
