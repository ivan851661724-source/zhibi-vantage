'use strict';
// R2.4/R3.3 域闸门单测：voice ≥3 家门槛 / channel 覆盖率 70% 门槛（PRD 红线 4：不越域出结论）
const assert = require('node:assert');
const DV = require('../research/domain-verdicts.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

function ch(present, basis) { return { present, basis }; }

// ---------- voice ----------
t('voice：<3 家有声音 → level=undetected，不出群体结论', () => {
  const v = DV.voiceVerdict({ opportunity: { themes: [{ oid: 'O-1', label: '差评聚集' }], brandsWithVoice: 2 } });
  assert.equal(v.level, 'undetected');
  assert.equal(v.items.length, 0);
  assert.ok(/<3/.test(v.note));
});

t('voice：无主题 → undetected', () => {
  const v = DV.voiceVerdict({ opportunity: { themes: [], brandsWithVoice: 5 } });
  assert.equal(v.level, 'undetected');
});

t('voice：≥3 家 → 出结论，置信封顶 medium，主题带来源 URL', () => {
  const v = DV.voiceVerdict({
    opportunity: {
      brandsWithVoice: 4,
      themes: [{
        oid: 'O-abc', label: '想要定制礼盒但没人做', confidence: 'high', // 故意给 high → 必须被封顶
        posMentions: 3, negMentions: 5, brandsMentioned: 3,
        denominatorText: '3/4 家提到',
        sources: [{ name: 'A', detail: '想要礼盒', url: 'https://reddit.com/r/x/1', polarity: 'neg', basis: 'inferred' }],
      }],
    },
  });
  assert.equal(v.level, 'opportunity');
  assert.equal(v.items.length, 1);
  assert.equal(v.items[0].confidence, 'medium'); // 封顶
  assert.equal(v.items[0].sources[0].url, 'https://reddit.com/r/x/1');
  assert.equal(v.items[0].evidenceIds[0], 'https://reddit.com/r/x/1');
});

// ---------- channel ----------
function mkComp(id, channels) {
  return { id, name: id, status: 'done', channels };
}

t('channel：覆盖率 <70% → undetected（未探测不当作缺席）', () => {
  const st = { competitors: [mkComp('a', { amazon: { present: true, basis: 'verified' } }), { id: 'b', status: 'done', channels: {} }], excluded: [] };
  // 1/2 = 50% < 70%
  const v = DV.channelVerdict(st, ['amazon'], null);
  assert.equal(v.level, 'undetected');
  assert.ok(/70%/.test(v.note));
});

t('channel：覆盖率 ≥70% → 出渠道分布；全部确认缺席才 verified', () => {
  const ch = (present, basis) => ({ present, basis });
  const st = { competitors: [
    mkComp('a', { amazon: ch(true, 'verified'), etsy: ch(false, 'verified'), tiktokShop: ch(true, 'verified') }),
    mkComp('b', { amazon: ch(true, 'verified'), etsy: ch(false, 'verified'), tiktokShop: {} }),
    mkComp('c', { amazon: {}, etsy: ch(false, 'verified'), tiktokShop: ch(true, 'inferred') }),
    mkComp('d', { amazon: ch(false, 'verified'), etsy: ch(false, 'inferred') }),
  ], excluded: [] };
  // 4/4 有渠道数据 = 100% 覆盖
  const v = DV.channelVerdict(st, ['amazon', 'etsy', 'tiktokShop'], null);
  assert.equal(v.level, 'opportunity');
  const byId = {};
  v.items.forEach(i => { byId[i.subjectId] = i; });
  // amazon：a/b 在售，c 无记录，d 确认缺席 → 不是"全部确认缺席"（有在售）→ basis 按 verified 在售证据
  assert.equal(byId['channel:amazon'].basis, 'verified'); // 有在售记录（verified 探测）
  // etsy：a/b/c 全确认缺席（verified），d inferred 缺席 → 有未探测式（inferred）缺席 → 封顶 inferred
  assert.equal(byId['channel:etsy'].basis, 'inferred');
  assert.equal(byId['channel:etsy'].confirmedAbsent, 3);
});

t('channel：单源/含未探测的缺席 → 不得 verified（R3.2 单源不升级）', () => {
  const st = { competitors: [
    mkComp('a', { amazon: ch(false, 'verified') }),
    mkComp('b', { amazon: ch(false, 'verified') }),
    mkComp('c', { amazon: ch(false, 'verified') }),
    mkComp('d', { amazon: ch(false, 'verified') }),
  ], excluded: [] };
  const v = DV.channelVerdict(st, ['amazon'], null);
  assert.equal(v.items[0].basis, 'verified'); // 4 家全部确认缺席 → verified 成立
  // 加入一家"未探测式缺席" → 封顶 inferred
  const st2 = { competitors: st.competitors.concat([mkComp('e', { amazon: ch(false, 'unverified') })]), excluded: [] };
  const v2 = DV.channelVerdict(st2, ['amazon'], null);
  assert.equal(v2.items[0].basis, 'inferred');
});

console.log('\n=== domain-verdicts.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
