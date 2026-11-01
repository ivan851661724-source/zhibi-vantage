'use strict';
// r4 §三：把「Key 无效」与「模型未开通」拆开。
// 背景：百炼 Token Plan 对「未购买」返回 403 AccessDenied.Unpurchased，
// 与「Key 失效」同为 403，但处置动作完全不同（换 Key vs 去控制台开通额度）。
// 本测试锁死归类规则，防止以后有人图省事把两者又合并回去。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GW = require('../services/llm-gateway.js');
const { classifyLlmStatus, LLM_ERROR_MESSAGES } = GW;

// 故意的假 Key：不写成 sk- 前缀，避免被 secret-scan 当成真 Key 拦截
const KEY = 'unit-test-placeholder-not-a-real-key';
let calls = 0;
let nextResponse = () => new Response('{}', { status: 200 });
global.fetch = async () => { calls++; return nextResponse(); };
require('../services/metering.js').recordCall = () => {};

const UNPURCHASED_BODY = JSON.stringify({
  error: {
    message: 'Access to model denied. Please make sure you are eligible for using the model.',
    type: 'AccessDenied.Unpurchased',
    code: 'AccessDenied.Unpurchased',
  },
});

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok - ' + name); }
  catch (e) { failed++; console.log('  FAIL - ' + name + '\n        ' + (e && e.message)); }
}

(async () => {
  console.log('\n# 归类矩阵');

  await t('403 + Unpurchased 错误体 → LLM_NO_ENTITLEMENT', () => {
    assert.equal(classifyLlmStatus(403, UNPURCHASED_BODY).code, 'LLM_NO_ENTITLEMENT');
  });

  await t('403 + 仅 "not eligible for using" 文案 → LLM_NO_ENTITLEMENT', () => {
    assert.equal(classifyLlmStatus(403, '{"message":"you are not eligible for using the model"}').code, 'LLM_NO_ENTITLEMENT');
  });

  await t('403 但错误体无未购买语义 → 保持 LLM_AUTH_REJECTED（不误判）', () => {
    assert.equal(classifyLlmStatus(403, '{"error":"forbidden"}').code, 'LLM_AUTH_REJECTED');
    assert.equal(classifyLlmStatus(403, '').code, 'LLM_AUTH_REJECTED');
    assert.equal(classifyLlmStatus(403, null).code, 'LLM_AUTH_REJECTED');
  });

  await t('401 无论错误体如何 → LLM_AUTH_REJECTED', () => {
    assert.equal(classifyLlmStatus(401, '').code, 'LLM_AUTH_REJECTED');
    assert.equal(classifyLlmStatus(401, UNPURCHASED_BODY).code, 'LLM_AUTH_REJECTED');
  });

  await t('404 / 400+模型名 → 仍归 LLM_MODEL_UNAVAILABLE（不受本次改动影响）', () => {
    assert.equal(classifyLlmStatus(404, '').code, 'LLM_MODEL_UNAVAILABLE');
    assert.equal(classifyLlmStatus(400, '{"message":"model not exist"}').code, 'LLM_MODEL_UNAVAILABLE');
  });

  await t('两个错误码的用户文案不同，且都提到可执行动作', () => {
    const a = LLM_ERROR_MESSAGES.LLM_AUTH_REJECTED;
    const b = LLM_ERROR_MESSAGES.LLM_NO_ENTITLEMENT;
    assert.ok(a && b && a !== b, '文案必须区分');
    assert.ok(/未开通|额度/.test(b), '未开通码要说明是额度问题：' + b);
    assert.ok(/鉴权/.test(a), '鉴权码保持鉴权表述：' + a);
  });

  console.log('\n# 网关行为（真实 call 链路，stub fetch）');

  const call = (opts) => GW.call(
    [{ role: 'user', content: 'x' }],
    Object.assign({ apiKey: KEY, model: 'qwen3.6-flash', baseUrl: 'http://llm.stub/v1', timeoutMs: 2000, maxAttempts: 3, failureMode: 'throw' }, opts || {}),
  );

  await t('403 Unpurchased 抛错：码正确、不可重试、只发一次请求', async () => {
    calls = 0;
    nextResponse = () => new Response(UNPURCHASED_BODY, { status: 403 });
    await assert.rejects(() => call(), (e) => {
      assert.equal(e.name, 'LLMError');
      assert.equal(e.code, 'LLM_NO_ENTITLEMENT');
      assert.equal(e.status, 403);
      assert.equal(e.retryable, false, '确定性失败不得重试');
      return true;
    });
    assert.equal(calls, 1, '只应发出一次请求，实际 ' + calls);
  });

  await t('错误载荷不含密钥、不含供应商原始正文', async () => {
    calls = 0;
    nextResponse = () => new Response(UNPURCHASED_BODY, { status: 403 });
    await assert.rejects(() => call(), (e) => {
      const dump = JSON.stringify({ m: e.message, u: e.userMessage, c: e.code, s: e.status });
      assert.ok(!dump.includes(KEY), '不得泄漏 Key');
      assert.ok(!dump.includes('Access to model denied'), '不得回传供应商原始正文');
      assert.ok(!/Bearer/i.test(dump), '不得包含 Authorization');
      return true;
    });
  });

  await t('401 无效 Key 仍抛 LLM_AUTH_REJECTED（未回退）', async () => {
    calls = 0;
    nextResponse = () => new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 });
    await assert.rejects(() => call(), (e) => {
      assert.equal(e.code, 'LLM_AUTH_REJECTED');
      assert.equal(e.retryable, false);
      return true;
    });
  });

  console.log('\n# 文案表一致性（后端 / 发现链路 / 前端）');

  const root = path.join(__dirname, '..', '..');
  const readSrc = (p) => fs.readFileSync(path.join(root, p), 'utf8');

  await t('discover.js 的归一错误码表含 LLM_NO_ENTITLEMENT', () => {
    assert.ok(/case 'LLM_NO_ENTITLEMENT':/.test(readSrc('app/research/discover.js')));
  });

  await t('前端 use-discover.ts 的文案表含 LLM_NO_ENTITLEMENT', () => {
    assert.ok(/case 'LLM_NO_ENTITLEMENT':/.test(readSrc('web/src/hooks/use-discover.ts')));
  });

  await t('健康检查走同一套归类（llm-health 调用 classifyLlmStatus）', () => {
    assert.ok(/classifyLlmStatus/.test(readSrc('app/services/llm-health.js')));
  });

  if (failed) { console.log('\n' + failed + ' 项失败'); process.exit(1); }
  console.log('\n全部通过');
})();
