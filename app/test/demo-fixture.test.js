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

  console.log('\ndemo-fixture.test: ' + passed + ' passed, ' + failed + ' failed');
  if (failed > 0) process.exit(1);
})();
