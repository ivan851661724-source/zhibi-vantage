'use strict';
// R2 口碑链路单测：词典情感 / url 保留 / 去重 / 独立站适配器契约
const assert = require('node:assert');
const VC = require('../lib/voice-collector.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

t('词典情感：pos/neg/neu 三态判定', () => {
  assert.equal(VC.lexiconSentiment('I absolutely love it, highly recommend'), 'pos');
  assert.equal(VC.lexiconSentiment('it broke after two days, asked for a refund'), 'neg');
  assert.equal(VC.lexiconSentiment('shipping took five days'), null); // 平手 → null（不臆造）
  assert.equal(VC.lexiconSentiment(''), null);
});

t('归一化：保留来源 URL（R2.3 溯源红线）', () => {
  const out = VC.voiceItemsToNormalized(
    [{ platform: 'reddit', url: 'https://reddit.com/r/x/abc', text: 'love this brand', sentiment: 'neu', tier: 2 }],
    { id: 'c1', name: 'ACME' }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].url, 'https://reddit.com/r/x/abc');
  assert.equal(out[0].polarity, 'pos'); // 词典派生
  assert.equal(out[0].basis, 'inferred');
});

t('归一化：无 URL 时 url=null，绝不编造链接', () => {
  const out = VC.voiceItemsToNormalized(
    [{ platform: 'trustpilot', text: 'terrible service', sentiment: 'neg', tier: 1 }],
    { id: 'c1', name: 'ACME' }
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].url, null);
  assert.equal(out[0].basis, 'verified'); // tier1 官方 API
});

t('作者脱敏（合规：作者信息不落库原文）', () => {
  assert.equal(VC.anonymizeAuthor('john_michael_doe'), 'j***e');
  const masked = VC.anonymizeAuthor('john');
  assert.ok(!masked.includes('john'));
});

t('适配器注册表：site 适配器已注册且默认启用（R2.2）', () => {
  assert.ok(VC.listVoiceAdapters().includes('site'));
  assert.ok(VC.DEFAULT_ENABLED.includes('site'));
  assert.ok(VC.getVoiceAdapter('site'));
});

t('collectBrandVoice：单平台异常不影响其他平台（失败静默）', async () => {
  // 注入假 fetch：所有请求都抛错 → 返回空数组而非抛出
  const items = await VC.collectBrandVoice('ACME', { fetchImpl: async () => { throw new Error('network down'); }, maxItems: 5 });
  assert.ok(Array.isArray(items));
});

console.log('\n=== voice-collector.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
