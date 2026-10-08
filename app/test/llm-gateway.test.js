'use strict';
// LLM 网关/封装单测：多供应商接入（OpenAI 兼容）的纯函数部分（不发起网络请求）。
// 覆盖：baseUrl 归一化、旧模型名迁移、key 接入点同源配对解析、P0-2 配置同源回归。
// 隔离：ZB_DATA_DIR 必须在任何业务模块 require 之前设置——core/paths.js 在加载时
// 计算 DATA/CONFIG_PATH，晚了就会指向仓库真实 data 目录（P0-2 测试隔离教训）。
const os = require('os');
const fs = require('fs');
const nodePath = require('path');
const TMPDIR = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'zb-llm-src-'));
process.env.ZB_DATA_DIR = TMPDIR;

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

// ============ P0-2 回归：Key 决定整套配置源（最终代码审核整改） ============
// 场景：config.llm.apiKey 为空 + config 自定义端点（过期残留 stale-config.example）
//       + env 全套配置 → 必须整套走 env：env 密钥绝不发往 config 端点（修复前
//       resolveBaseUrl 会返回 config 自定义端点，造成跨源密钥泄漏）。
const Paths = require('../core/paths.js'); // CONFIG_PATH 已随顶部 ZB_DATA_DIR 指向 TMPDIR

function freshRLLM() {
  delete require.cache[require.resolve('../core/config.js')];
  delete require.cache[require.resolve('../core/paths.js')];
  delete require.cache[require.resolve('../research/llm.js')];
  return require('../research/llm.js');
}
const ENV_SAVE = {};
for (const k of ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_MODEL_DEEP']) {
  ENV_SAVE[k] = process.env[k];
}
function restoreEnv() {
  for (const k of Object.keys(ENV_SAVE)) {
    if (ENV_SAVE[k] === undefined) delete process.env[k]; else process.env[k] = ENV_SAVE[k];
  }
}

t('P0-2A: config 空 key + config 自定义端点 + env 全套 → 端点取 env（密钥不发往 config 端点）', () => {
  fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: '', baseUrl: 'https://stale-config.example/v1' } }));
  process.env.LLM_API_KEY = 'fake-env-only-key-abcdef';
  process.env.LLM_BASE_URL = 'https://environment-provider.example/v1';
  const R = freshRLLM();
  const key = R.llmApiKey(require('../core/config.js').loadConfig());
  assert.equal(key, 'fake-env-only-key-abcdef');
  const url = R.resolveBaseUrl(key, null);
  assert.ok(url.includes('environment-provider.example'), 'endpoint must come from env, got: ' + url);
  assert.equal(url.includes('stale-config.example'), false, 'stale config endpoint must NEVER receive env key');
  assert.equal(url.includes('fake-env-only-key-abcdef'), false, 'returned value must never contain key material');
});

t('P0-2B: config 非空 key + env 全套 → 整套取 config（config key 不打 env 端点）', () => {
  fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: 'fake-cfg-key-123456', baseUrl: 'https://cfg-provider.example/v1', model: 'cfg-model' } }));
  process.env.LLM_API_KEY = 'fake-env-only-key-abcdef';
  process.env.LLM_BASE_URL = 'https://environment-provider.example/v1';
  const R = freshRLLM();
  const key = R.llmApiKey(require('../core/config.js').loadConfig());
  assert.equal(key, 'fake-cfg-key-123456', 'config key wins over env key');
  const url = R.resolveBaseUrl(key, null);
  assert.ok(url.includes('cfg-provider.example'), 'config key must use config endpoint, got: ' + url);
  assert.equal(url.includes('environment-provider.example'), false, 'config key must NOT go to env endpoint');
  assert.equal(url.includes('fake-cfg-key-123456'), false, 'returned value must never contain key material');
});

t('P0-2C: config 空 key + legacy DeepSeek 默认地址 + env key → env 端点（legacy 值不压制 env）', () => {
  fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: '', baseUrl: 'https://api.deepseek.com/v1' } }));
  process.env.LLM_API_KEY = 'fake-legacy-case-key';
  process.env.LLM_BASE_URL = 'https://environment-provider.example/v1';
  const R = freshRLLM();
  const url = R.resolveBaseUrl(R.llmApiKey(require('../core/config.js').loadConfig()), null);
  assert.ok(url.includes('environment-provider.example'), 'got: ' + url);
  assert.equal(/deepseek/i.test(url), false);
});

t('P0-2D: 无 key（两侧皆空）→ 旧行为保持：env LLM_BASE_URL 或网关默认', () => {
  fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: '', baseUrl: '' } }));
  delete process.env.LLM_API_KEY;
  process.env.LLM_BASE_URL = 'https://environment-provider.example/v1';
  const R = freshRLLM();
  assert.equal(R.resolveBaseUrl('', null), 'https://environment-provider.example/v1');
  // 显式 opts.baseUrl 仍是最高优先级（显式调用配置：调用方自保 key/端点配对）
  assert.equal(R.resolveBaseUrl('', { baseUrl: 'https://explicit.example/v1' }), 'https://explicit.example/v1');
});

restoreEnv();
fs.rmSync(TMPDIR, { recursive: true, force: true });

console.log('');
process.exit(failed ? 1 : 0);
