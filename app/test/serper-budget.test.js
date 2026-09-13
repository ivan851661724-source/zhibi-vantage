'use strict';
// Serper key 总额度预算单测：总额度口径（不按月重置）、按 key 记账、failover 接线。
// 数据目录用 ZB_DATA_DIR 隔离到临时目录（对齐 metering-daily.test.js 的 freshModules 模式）。
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('  ok - ' + name); })
    .catch(e => { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); });
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-serper-budget-'));
process.env.ZB_DATA_DIR = TMP;
for (const m of ['core/paths.js', 'services/providers/serper-budget.js', 'services/providers/search.js']) {
  delete require.cache[require.resolve('../' + m)];
}
const Budget = require('../services/providers/serper-budget.js');
const { serperSearchWithFailover } = require('../services/providers/search.js');
const budgetFile = path.join(TMP, 'serper-budget.json');

function usedOf(key) {
  try { return (JSON.parse(fs.readFileSync(budgetFile, 'utf8')).used || {})[key] || 0; } catch { return 0; }
}

(async () => {
  console.log('=== serper-budget.test.js ===');

  await t('budgetTotal：数字 / {total} / {limit} / 未配置 → Infinity / 非法 → Infinity', () => {
    assert.strictEqual(Budget.budgetTotal({ serperBudget: 2500 }), 2500);
    assert.strictEqual(Budget.budgetTotal({ serperBudget: { total: 2500 } }), 2500);
    assert.strictEqual(Budget.budgetTotal({ serperBudget: { limit: 100 } }), 100);
    assert.strictEqual(Budget.budgetTotal({}), Infinity);
    assert.strictEqual(Budget.budgetTotal({ serperBudget: 'abc' }), Infinity);
    assert.strictEqual(Budget.budgetTotal({ serperBudget: 0 }), Infinity);
  });

  await t('recordSpend 按 key 记账并持久化，canSpend 随之翻转', async () => {
    const K = 'keyA';
    assert.strictEqual(Budget.canSpend(K, 3), true);
    await Budget.recordSpend(K);
    await Budget.recordSpend(K);
    await Budget.recordSpend(K);
    assert.strictEqual(usedOf(K), 3);
    assert.strictEqual(Budget.canSpend(K, 3), false, 'used=3 达到 total=3 → 不可再花');
    assert.strictEqual(Budget.canSpend(K, 5), true, 'total=5 仍有余量');
    assert.strictEqual(Budget.canSpend('keyB', 3), true, '另一把 key 独立起算（独享口径）');
    assert.strictEqual(Budget.canSpend(K, Infinity), true, '未配置额度 → 不设限');
  });

  await t('failover 接线：成功一次记一笔（2xx 扣减）', async () => {
    const K = 'keyOK';
    const calls = [];
    const r = await serperSearchWithFailover('q', [K], 'us', {
      budgetTotal: 10,
      call: async (k) => { calls.push(k); return { results: [{ title: 't', url: 'u', content: 'c' }] }; }
    });
    assert.strictEqual(r.results.length, 1);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(usedOf(K), 1);
  });

  await t('failover 接线：5xx 到达即计费（扣减）且原样抛出（other 不重试）', async () => {
    const K = 'key5xx';
    let calls = 0;
    await assert.rejects(
      () => serperSearchWithFailover('q', [K], 'us', {
        budgetTotal: 10,
        call: async () => { calls++; const e = new Error('SERPER_500'); e.status = 500; e.bodyText = 'boom'; throw e; }
      }),
      /SERPER_500/
    );
    assert.strictEqual(calls, 1, 'other 类错误不重试');
    assert.strictEqual(usedOf(K), 1, '5xx 按 metering 口径扣减');
  });

  await t('failover 接线：预算耗尽抛 SERPER_BUDGET_EXHAUSTED，call 一次都不发', async () => {
    const K = 'keyFull';
    await Budget.recordSpend(K, 5);
    let calls = 0;
    await assert.rejects(
      () => serperSearchWithFailover('q', [K], 'us', {
        budgetTotal: 5,
        call: async () => { calls++; return { results: [] }; }
      }),
      (e) => { assert.strictEqual(e.message, 'SERPER_BUDGET_EXHAUSTED'); assert.strictEqual(e.budgetExhausted, true); return true; }
    );
    assert.strictEqual(calls, 0, '预算挡住，不产生真实调用');
    assert.strictEqual(usedOf(K), 5, '无真实调用不再扣减');
  });

  await t('failover 接线：混合场景——第一把预算耗尽跳过，第二把成功；invalid 不扣减', async () => {
    const K1 = 'keyMix1', K2 = 'keyMix2';
    await Budget.recordSpend(K1, 2);
    const calls = [];
    const r = await serperSearchWithFailover('q', [K1, K2], 'us', {
      budgetTotal: 2,
      call: async (k) => {
        calls.push(k);
        if (k === K2) return { results: [{ title: 'ok', url: 'u', content: 'c' }] };
        const e = new Error('SERPER_401'); e.status = 401; e.bodyText = 'invalid key'; throw e;
      }
    });
    assert.strictEqual(r.results[0].title, 'ok');
    assert.deepStrictEqual(calls, [K2], 'key1 被预算挡住（未调用），key2 直接成功');
    assert.strictEqual(usedOf(K1), 2, 'key1 未产生真实调用，不扣');
    assert.strictEqual(usedOf(K2), 1);
  });

  await t('status 回显：total/used/remaining，key 只出 6 位掩码', async () => {
    const K = 'maskKey1234567890';
    await Budget.recordSpend(K, 4);
    const st = Budget.status({ serperBudget: 2500, serperKeys: [K] });
    assert.strictEqual(st.total, 2500);
    assert.strictEqual(st.keys[0].mask, 'maskKe…');
    assert.ok(!JSON.stringify(st).includes(K), '完整 key 不得回传');
    assert.strictEqual(st.keys[0].used, 4);
    assert.strictEqual(st.keys[0].remaining, 2496);
  });

  console.log(`\nserper-budget.test: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
