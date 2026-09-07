'use strict';
// R4 每日邮件摘要单测：无变化不发 / 有变化一封汇总 / 未配置通道静默跳过
const assert = require('node:assert');
const { buildDigestText, runDigest } = require('../research/digest.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}
const nowIso = new Date().toISOString();
const oldIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString(); // 48h 前（窗口外）

t('无变化（24h 内无预警）→ 正文为 null → 不发', () => {
  assert.equal(buildDigestText([]), null);
  assert.equal(buildDigestText([{ at: oldIso, type: 'price-change', text: '降价' }]), null);
});

t('有变价 → 一封汇总，含 PRD 验收格式', () => {
  const text = buildDigestText([
    { at: nowIso, type: 'price-change', projectId: 'p1', track: '定制手办', competitorName: 'A 品牌', text: '降价 12%（$29.99→$26.39）' },
    { at: nowIso, type: 'competitor-move', projectId: 'p2', competitorName: 'B 品牌', moves: ['新开 TikTok 店'] },
    { at: oldIso, type: 'price-change', text: '窗口外不应出现' },
  ]);
  assert.ok(text.includes('每日竞品动态摘要'));
  assert.ok(text.includes('降价 12%（$29.99→$26.39）'));
  assert.ok(text.includes('B 品牌'));
  assert.ok(!text.includes('窗口外'));
});

t('runDigest：未配置邮件通道 → skipped（静默跳过，不发不发错）', async () => {
  delete process.env.ZB_MAIL_API_URL;
  const r = await runDigest();
  assert.equal(r.skipped, true);
});

t('runDigest：配置通道后正常发送（注入假 fetch 验证一次一封）', async () => {
  process.env.ZB_MAIL_API_URL = 'https://mail.example/send';
  const sent = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true };
  };
  try {
    // 隔离 db（临时文件）
    process.env.MT_STORE_PATH = require('os').tmpdir() + '/zb-digest-test.db';
    delete require.cache[require.resolve('../services/db.js')];
    delete require.cache[require.resolve('../services/alerts.js')];
    delete require.cache[require.resolve('../research/digest.js')];
    const db = require('../services/db.js');
    const Alerts = require('../services/alerts.js');
    const { runDigest: run } = require('../research/digest.js');
    const t1 = db.createTenant({ name: 'A', email: 'a@test.io' });
    db.createTenant({ name: 'B', email: 'b@test.io' }); // 无预警 → 不发
    Alerts.push(t1.id, { type: 'price-change', competitorName: 'A 品牌', text: '降价 12%（$29.99→$26.39）' }, '');
    const r = await run();
    assert.equal(sent.length, 1);       // 只有一封
    assert.ok(sent[0].to === 'a@test.io');
    assert.ok(sent[0].text.includes('降价 12%'));
    assert.equal(r.sent, 1);
    assert.equal(r.noChange, 1);        // B 租户无变化不发
    db.closeDb();
    require('fs').rmSync(process.env.MT_STORE_PATH, { force: true });
  } finally {
    global.fetch = realFetch;
    delete process.env.ZB_MAIL_API_URL;
    delete process.env.MT_STORE_PATH;
  }
});

console.log('\n=== digest.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
