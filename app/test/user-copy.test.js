'use strict';
// 用户可见文案审核回归（2026-10-08 文案审核漏项整改）
// 背景：上轮文案整改只搜了 web/src，漏掉 web/public mock 数据与后端生成文案。
// 验收三块：
//   A. web/public/mock/*.json —— 关系标签不再出现「直接对手」；机会/材料数据不再出现
//      「无人主打 / 无人解决 / 对手被抱怨」等绝对或口语表达；推测级别与 disclaimer 保留。
//   B. 后端生成文案（material-engine / opportunity / quadrant / domain-verdicts /
//      whitespace / inference-guard）—— 统一「竞争品牌」术语、克制可验证表述。
//   C. 协议字段与业务计算结果不变 —— 材料契约、gap 结构键、象限枚举、评分公式输出均不受影响。
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const WEB_ROOT = path.resolve(__dirname, '..', '..', 'web');
const ME = require('../lib/material-engine.js');
const OPP = require('../lib/opportunity.js');
const QUAD = require('../lib/quadrant.js');
const DV = require('../research/domain-verdicts.js');
const WS = require('../research/whitespace.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

// 用户可见字符串的禁用词（绝对/口语表达与旧术语）
const BANNED = ['直接对手', '无人主打', '无人解决', '无人宣称', '属红海', '空白可占', '红海方向', '越右越值得攻', '可下注', '方可下注'];
function hasBanned(s) { return BANNED.filter(w => String(s).includes(w)); }
// 递归收集 JSON 中全部字符串值
function stringsOf(v, out) {
  out = out || [];
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => stringsOf(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => stringsOf(x, out));
  return out;
}

// ---------- A. web/public mock 数据 ----------
t('A1 mock/rivals.json：relationLabel 不再出现「直接对手」，其余字段不变', () => {
  const rivals = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'public', 'mock', 'rivals.json'), 'utf8'));
  assert.ok(Array.isArray(rivals) && rivals.length === 6, '仍为 6 家品牌');
  rivals.forEach(r => {
    assert.ok(r.relationLabel, '每家有 relationLabel');
    assert.ok(!r.relationLabel.includes('对手'), 'relationLabel 不含「对手」: ' + r.relationLabel);
  });
  // 协议不变：relation 枚举与 demo.ts REL_CODE 映射键一致
  const relCodes = new Set(rivals.map(r => r.relation));
  for (const k of relCodes) assert.ok(['direct', 'ref', 'cheap'].includes(k), 'relation 枚举不变: ' + k);
  // 前端兜底术语与 mock 统一（demo.ts: r.relationLabel || '直接竞品'）
  const demoTs = fs.readFileSync(path.join(WEB_ROOT, 'src', 'lib', 'demo.ts'), 'utf8');
  assert.ok(demoTs.includes("r.relationLabel || '直接竞品'"), 'demo.ts 兜底仍为「直接竞品」');
});

t('A2 mock/opportunities.json：无绝对/口语表达，推测级别与 disclaimer 保留', () => {
  const opps = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'public', 'mock', 'opportunities.json'), 'utf8'));
  assert.equal(opps.length, 3);
  opps.forEach(o => {
    for (const field of ['title', 'desc']) {
      const bad = hasBanned(o[field]).concat(String(o[field]).includes('对手') ? ['对手'] : []);
      assert.deepEqual(bad, [], `${o.id}.${field} 不含禁用词`);
      assert.ok(!String(o[field]).includes('无人'), `${o.id}.${field} 不含「无人」`);
    }
    // 推测级别与 disclaimer 保留，置信度不得提高
    assert.ok(o.disclaimer && o.disclaimer.length > 10, o.id + ' 保留 disclaimer');
    assert.ok(['low', 'medium'].includes(o.confidence), o.id + ' confidence 不提高');
    assert.ok(o.confidenceLabel, o.id + ' 保留 confidenceLabel');
    assert.equal(typeof o.score, 'number', o.id + ' score 不变');
    assert.ok(o.methodKey, o.id + ' 保留 methodKey');
  });
  // opp_003 必须仍是推测性表述（不因改写而变成断言已验证）
  const opp3 = opps.find(o => o.id === 'opp_003');
  assert.ok(opp3.confidence === 'low' && /推测/.test(opp3.desc + opp3.disclaimer), 'opp_003 维持推测定级');
});

t('A3 mock/materials.json：用户可见字符串无「对手」', () => {
  const mats = JSON.parse(fs.readFileSync(path.join(WEB_ROOT, 'public', 'mock', 'materials.json'), 'utf8'));
  const all = stringsOf(mats);
  const bad = all.filter(s => s.includes('对手'));
  assert.deepEqual(bad, [], 'materials.json 无「对手」残留');
});

// ---------- B. 后端生成文案 ----------
t('B1 material-engine：材料标题用「竞争品牌」，材料契约字段不变', () => {
  const priceVerdict = {
    missing: false,
    items: [
      { subjectId: 'c1', claim: 'A 价格区间 $20-$40', confidence: 'medium', basis: 'inferred' },
      { subjectId: 'c2', claim: 'B 当前价 $55', confidence: 'low', basis: 'unverified' },
    ],
  };
  const priceHistory = { c1: [{ at: '2026-10-01T00:00:00Z', display: '$50' }] };
  const mats = ME.priceFollowRecipe(priceVerdict, { priceHistory });
  assert.equal(mats.length, 2);
  assert.equal(mats[0].title, '竞争品牌价格变动', 'changed → 竞争品牌价格变动');
  assert.equal(mats[1].title, '竞争品牌当前价格', 'unchanged → 竞争品牌当前价格');
  // 契约不变：schema + 关键字段
  mats.forEach(m => {
    assert.equal(m.schema, 'Material@1');
    assert.equal(m.type, 'price-follow');
    assert.equal(m.domain, 'price');
    for (const k of ['id', 'subjectId', 'title', 'body', 'confidence', 'basis', 'evidenceIds', 'missingFields', 'brand', 'price', 'sources', 'inference', 'at']) {
      assert.ok(k in m, '材料契约字段保留: ' + k);
    }
  });
  // 业务结果不变：有历史才标 changed（missingFields 逻辑不动）
  assert.ok(!mats[0].missingFields.includes('history:60d'), '有历史价不标缺域');
  assert.ok(mats[1].missingFields.includes('history:60d'), '无历史价仍标缺域');
});

t('B2 opportunity：CAVEATS/denominatorText/覆盖率 note 统一「竞争品牌」，评分公式不变', () => {
  OPP.CAVEATS.forEach(c => assert.deepEqual(hasBanned(c).concat(c.includes('对手') ? ['对手'] : []), [], 'CAVEATS 无旧术语'));
  const comps = [1, 2, 3].map(i => ({
    id: 'c' + i, name: '品牌' + i, status: 'done',
    reviews: { negThemes: ['发货太慢'], basis: 'inferred' },
  }));
  const map = OPP.computeOpportunityMap(comps);
  assert.equal(map.hidden, false, '3 家有声音 → 出图');
  const th = map.themes[0];
  assert.ok(th.denominatorText.includes('家有用户声音的竞争品牌提到'), 'denominatorText 统一术语: ' + th.denominatorText);
  // 评分公式不变：importance = 1 + 9×(brandSet/denom)，3/3 家 → 10
  assert.equal(th.importance, 10, 'importance 数值不变');
  assert.equal(th.brandsMentioned, 3);
  // 覆盖率不足路径的 note 同步：5 家完成、3 家有声音 → 覆盖率 60% < 70% → 降级 note
  const sparse = [1, 2, 3, 4, 5].map(i => ({ id: 'c' + i, name: '品牌' + i, status: 'done', reviews: i <= 3 ? { negThemes: ['太贵'] } : {} }));
  const map2 = OPP.computeOpportunityMap(sparse);
  assert.equal(map2.hidden, false, '3 家有声音仍出图');
  assert.equal(map2.lowCoverage, true, '覆盖率不足路径命中');
  map2.themes.forEach(x => assert.ok(!x.note.includes('对手') && x.note.includes('竞争品牌'), '覆盖率 note 统一术语: ' + x.note));
});

t('B3 quadrant：note/legend 无「值得攻/红海/对手」，象限枚举不变', () => {
  const r = QUAD.computeQuadrant([
    { id: 'c1', name: 'A', status: 'done', tier: 'mid' },
    { id: 'c2', name: 'B', status: 'done', tier: 'small' },
    { id: 'c3', name: 'C', status: 'done', tier: 'large' },
  ]);
  assert.deepEqual(hasBanned(r.note), [], 'note 无禁用词');
  assert.ok(!r.note.includes('对手'), 'note 无「对手」');
  Object.values(r.quadrantsLegend).forEach(s => {
    assert.deepEqual(hasBanned(s), [], 'legend 无禁用词: ' + s);
    assert.ok(!s.includes('对手'), 'legend 无「对手」: ' + s);
  });
  assert.deepEqual(QUAD.QUADRANTS, ['priority', 'headToHead', 'avoid', 'watch', 'unknown'], '象限枚举不变');
});

t('B4 domain-verdicts：voice 域 note/denominator 统一术语，items 结构不变', () => {
  const low = DV.voiceVerdict({ opportunity: { themes: [{ label: 'x' }], brandsWithVoice: 2 } });
  assert.ok(low.note.includes('有用户声音的竞争品牌'), 'note 统一术语: ' + low.note);
  assert.ok(!low.note.includes('对手'), 'note 无「对手」');
  const st = {
    opportunity: {
      brandsWithVoice: 3,
      themes: [{ oid: 'O-x', label: '发货太慢', confidence: 'low', posMentions: 0, negMentions: 3, brandsMentioned: 3, sources: [], denominatorText: '3/3 家有用户声音的竞争品牌提到（正面 0 · 负面 3）' }],
    },
  };
  const v = DV.voiceVerdict(st);
  assert.equal(v.denominator, '3 家竞争品牌有声音数据', 'denominator 统一术语');
  assert.equal(v.basis, 'inferred'); assert.equal(v.confidence, 'medium'); // 置信封顶不变
  const it = v.items[0];
  for (const k of ['subjectId', 'claim', 'confidence', 'basis', 'sources', 'evidenceIds', 'posMentions', 'negMentions', 'brandsMentioned', 'denominatorText']) {
    assert.ok(k in it, 'voice item 字段保留: ' + k);
  }
});

t('B5 whitespace：challenges/gap note/method 统一术语，gap 结构与置信度枚举不变', () => {
  const comp = (i, price) => ({
    id: 'c' + i, name: '品牌' + i, status: 'done', currency: 'USD',
    pricePoints: [price], priceVerified: true,
    sellingPoints: ['customization'], sellingPointBasis: { customization: 'verified' },
    tactics: [], channels: {}, regions: [], painPoints: [], reviews: {},
  });
  // 定位档 $20-$40 与 3 家实抓价重叠 → price_crowded + sp_crowded
  const state = {
    competitors: [comp(1, 29), comp(2, 35), comp(3, 39)],
    excluded: [],
    intent: { regions: ['us'], profile: { priceBand: { min: 20, max: 40, currency: 'USD' }, sellingPoints: ['customization'] } },
  };
  const ws = WS.computeWhiteSpace(state);
  const texts = [];
  ((ws.positioning && ws.positioning.challenges) || []).forEach(c => texts.push(c.text));
  (ws.gaps || []).forEach(g => { texts.push(g.note, g.method); });
  texts.forEach(s => {
    assert.deepEqual(hasBanned(s), [], '无禁用词: ' + s);
    assert.ok(!s.includes('对手') && !s.includes('无人'), '统一术语: ' + s);
  });
  // 协议不变：challenges type 枚举与 gap 结构键
  const types = ((ws.positioning && ws.positioning.challenges) || []).map(c => c.type);
  assert.ok(types.includes('price_crowded') && types.includes('sp_crowded'), '挑战类型枚举不变: ' + types.join(','));
  (ws.gaps || []).forEach(g => {
    for (const k of ['dim', 'value', 'type', 'confidence', 'confidenceNum', 'basis', 'evidence', 'note', 'method', 'methodKey', 'sources', 'level', 'isGroup']) {
      assert.ok(k in g, 'gap 字段保留: ' + k);
    }
    assert.ok(['high', 'medium', 'low'].includes(g.confidence), '置信度枚举不变');
  });
});

t('B6 inference-guard：软证据 note 不再用「下注」表述', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'inference-guard.js'), 'utf8');
  assert.ok(!src.includes('方可下注'), '旧表述已移除');
  assert.ok(src.includes('须交叉验证后方可作为行动依据'), '新表述在位');
});

// ---------- C. 报告层静态回归（报告文本由 LLM 装配，此处锁机器生成段落的旧词） ----------
t('C1 report.js：机器生成段落旧词已清零（LLM 提示词不动）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'research', 'report.js'), 'utf8');
  for (const old of ['无人主打（空白可占）', '**无人主打 —— 空白可占**', ' —— 红海方向', '（你选的 vs 对手是否在做）']) {
    assert.ok(!src.includes(old), 'report.js 旧文案已移除: ' + old);
  }
  assert.ok(src.includes('当前样本中尚未发现主打品牌（待验证空缺）'), '新表述在位');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
