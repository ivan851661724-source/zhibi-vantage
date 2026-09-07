'use strict';
// LLM 网关/封装单测：多供应商接入（OpenAI 兼容）的纯函数部分（不发起网络请求）。
// 覆盖：baseUrl 归一化、旧模型名迁移、key 接入点同源配对解析。
const assert = require('node:assert');
const G = require('../services/llm-gateway.js');
const RLLM = require('../research/llm.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

t('normalizeBaseUrl：OpenAI 风格基地址自动补全 /chat/completions', () => {
  assert.equal(G.normalizeBaseUrl('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),
    'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
});

t('normalizeBaseUrl：完整端点保持不变、去尾部斜杠', () => {
  assert.equal(G.normalizeBaseUrl('https://api.deepseek.com/v1/chat/completions/'), 'https://api.deepseek.com/v1/chat/completions');
});

t('normalizeBaseUrl：空值返回空串（走内置默认）', () => {
  assert.equal(G.normalizeBaseUrl(''), '');
  assert.equal(G.normalizeBaseUrl(null), '');
});

t('resolveModel：旧模型名 deepseek-chat 自动迁移', () => {
  assert.equal(RLLM.resolveModel('deepseek-chat'), G.DEFAULT_MODEL);
});

t('resolveModel：显式模型名原样透传（如 Token Plan 的 glm-5.2）', () => {
  assert.equal(RLLM.resolveModel('glm-5.2'), 'glm-5.2');
});

t('resolveBaseUrl：显式 opts.baseUrl 最高优先', () => {
  assert.equal(RLLM.resolveBaseUrl('k', { baseUrl: 'https://example.com/v1' }), 'https://example.com/v1');
});

t('resolveBaseUrl：旧版硬编码默认地址视为未设置，让位环境变量', () => {
  const saved = process.env.LLM_BASE_URL;
  process.env.LLM_BASE_URL = 'https://env.example.com/v1';
  try {
    // 传 key（配置或 env 下发）且配置里只有官方默认地址 → 返回空串，由网关落环境变量默认
    assert.equal(RLLM.resolveBaseUrl('sk-test', {}), '');
  } finally {
    if (saved === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = saved;
  }
});

console.log('');
process.exit(failed ? 1 : 0);
