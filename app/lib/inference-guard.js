'use strict';
// ============================================================
// 情报推理纪律 v2：供需不混淆 —— 推理守卫（纯函数，不落盘）
// ------------------------------------------------------------
// 在 decorateState 实时调用，对蓝海曲线 / 空白视图施加三道闸：
//   闸 A · 强制交叉引用：蓝海曲线本身是供给轴，每桶标注 crossAxis + 需需求侧佐证
//   闸 B · 边界条件过滤：非目标市场的渠道桶标 outOfScope（如目标美国但渠道是小红书）
//   闸 C · 单边证据降级：空白桶查需求侧证据，无证据则禁称"机会"、锁低置信
//
// 设计要点：
//   - 不修改原始计数，只"加标注 + 降级"，原始数据仍可在前端展开核验。
//   - 纯函数、零外部依赖（仅 require 兄弟模块的 DIMENSIONS 取渠道市场标签）。
//   - 可被单测直接 require（test/inference-guard.test.js）。
// ============================================================

const { DIMENSIONS, channelTypeOf } = require('./blue-ocean.js');

// 需求侧信号汇总：negThemes / posThemes / painPoints（缺陷5的关键——把需求侧数据用起来）
function collectDemandSignals(competitors) {
  const out = [];
  (competitors || []).forEach(c => {
    const rv = c.reviews || {};
    (rv.negThemes || []).forEach(t => out.push({ text: String(t), type: 'neg' }));
    (rv.posThemes || []).forEach(t => out.push({ text: String(t), type: 'pos' }));
    (c.painPoints || []).forEach(p => out.push({ text: String((p && p.point) || p), type: 'pain' }));
  });
  return out;
}

// 有用户声音的对手家数（优化一·静默需求盲区判定用）
function countVoiceBrands(competitors) {
  let n = 0;
  (competitors || []).forEach(c => {
    const rv = c.reviews || {};
    // R2.5：真实声音（voice-collector 采集，带来源 URL）计入需求样本厚度
    if (((rv.negThemes || []).length + (rv.posThemes || []).length + ((c.painPoints || []).length) + ((c.voiceItems || []).length)) > 0) n++;
  });
  return n;
}

// 静默需求判定阈值：需求侧样本低于此家数时，"absent" 不可信，须软化为"沉默需求"。
// 与机会地图 MIN_BRANDS_WITH_VOICE(3) 对齐——同源逻辑，避免两处阈值漂移。
const SILENT_DEMAND_MIN_VOICE = 3;

// 卖点桶 → 需求侧关键词（语义对齐，用于查"需求侧有无该需求证据"）
// 优化五（2026-08-03）：在原有基础上扩充近义词覆盖，提升召回（尤其 customization / innovation
// 这类消费者用口语表达、与商业术语存在语义鸿沟的桶）。保持严格子串匹配纪律——只加明确同义，
// 不加过于泛化的字（如单字"像"），避免误召回；真正的语义泛化留给 Tier B 的 LLM 语义召回层。
const SEMANTIC_ALIGN = {
  affordablePrice: ['price', 'cheap', 'expensive', 'cost', '价格', '贵', '便宜', '高价', 'afford', '性价比', '实惠', 'value', '预算'],
  customization: ['custom', 'personaliz', '定制', '个性化', 'bespoke', '专属', '私人定制', 'ones-own'],
  premiumMaterial: ['quality', 'material', '材质', '质量', 'premium', '奢华', 'luxury', '考究'],
  ecoFriendly: ['eco', 'sustainab', '环保', '可持续', 'green', '绿色'],
  fastShipping: ['ship', 'delivery', '物流', '发货', '快递', 'fulfill', '时效'],
  handmade: ['handmade', '手工', '匠心', 'craft', '手作'],
  limitedEdition: ['limited', '限量', '稀缺', 'scarce', 'numbered'],
  personalGift: ['gift', '礼品', '送礼', 'present', '馈赠'],
  localCulture: ['local', '在地', '本地文化', 'culture', '在地文化', '本土'],
  innovation: ['innovat', '创新', 'tech', '智能', 'smart', '电子', '科技'],
  designAesthetic: ['design', '设计', 'aesthetic', '美感', '好看', '颜值'],
  serviceWarranty: ['warranty', '售后', 'service', '质保', '客服'],
  healthSafe: ['health', '安全', 'safe', '健康', '无毒'],
  convenience: ['convenient', '便捷', '省心', 'easy', '省事'],
  naturalOrganic: ['natural', 'organic', '天然', '有机', '无添加'],
  exclusive: ['exclusive', '独家', '会员', 'vip', '私享']
};

// 返回 {status:'present'|'absent'|'unknown', soft:bool}：该维度桶在需求侧有无证据。
// status 沿用语义不变；soft=true 表示"命中"来自第三层 LLM 语义召回（字面/近义均无匹配），
// 属软证据——只召回不裁决，须标低置信、待交叉验证，不得直接据此下注。
// 第三参 softBuckets：{bucketKey:[{theme,reason,competitor}]}（由 collectSoftAlignBuckets 产出）。
function demandEvidenceFor(bucketKey, signals, softBuckets) {
  const raw = String(bucketKey);
  const kw = raw.toLowerCase();
  const aligns = SEMANTIC_ALIGN[raw] || SEMANTIC_ALIGN[kw] || [];
  // 第一层（精确/子串）+ 第二层（近义同义词）——硬证据
  const hardHit = (() => {
    if (!aligns.length && !signals.some(s => String(s.text).toLowerCase().includes(kw))) return false;
    return signals.some(s => {
      const t = String(s.text).toLowerCase();
      if (!t) return false;
      if (t.includes(kw) || kw.includes(t)) return true;
      return aligns.some(a => t.includes(a) || a.includes(t));
    });
  })();
  if (hardHit) return { status: 'present', soft: false };
  // 第三层：LLM 语义召回（仅召回不裁决）——软证据
  if (softBuckets && Array.isArray(softBuckets[raw]) && softBuckets[raw].length) {
    return { status: 'present', soft: true };
  }
  // 无命中：原逻辑判定 unknown / absent（与旧行为一致）
  if (!aligns.length && !signals.some(s => String(s.text).toLowerCase().includes(kw))) return { status: 'unknown', soft: false };
  return { status: 'absent', soft: false };
}

// 优化五（2026-08-03 Tier B）：从各对手的 demandAlignments 汇总"LLM 语义召回的桶集合"。
// 与 collectDemandSignals（硬证据）并列——这是第三层软证据，仅召回、不裁决。
function collectSoftAlignBuckets(competitors) {
  const map = {}; // bucketKey -> [{theme, reason, competitor}]
  (competitors || []).forEach(c => {
    const da = (c && c.demandAlignments) || [];
    da.forEach(d => {
      const bks = (d && d.buckets) || [];
      bks.forEach(bk => { (map[bk] = map[bk] || []).push({ theme: d.theme, reason: d.reason, competitor: c.name }); });
    });
  });
  return map;
}

// 优化五：解析 LLM 返回的 demandAlignments（受控卖点词过滤，去脏数据）
function parseDemandAlignments(arr, vocab) {
  if (!Array.isArray(arr)) return [];
  return arr.map(d => ({
    theme: String((d && d.theme) || ''),
    buckets: Array.isArray(d.buckets) ? d.buckets.filter(b => !vocab || vocab.includes(b)) : [],
    reason: String((d && d.reason) || '')
  })).filter(d => d.theme && d.buckets.length);
}

// 闸 B：渠道桶是否越界。
// 优先级：① 用户显式勾选的平台集为权威范围——勾选即在域、未勾选即越界（含默认推导出的平台集）；
//         市场在平台集未指定时才兜底。这样 global 类平台（如 offlineRetail）被纳入默认平台集后
//         不会被市场标注（markets 不含当前地域）误杀为越界。
// 第三参 platforms 可省略（省略时仅做市场过滤，保持与旧测试的 2 参签名兼容）。
function channelOutOfScope(bucketKey, targetMarket, platforms) {
  // 1) 平台集优先：忠实助理只研究/展示用户勾选的平台
  if (Array.isArray(platforms) && platforms.length) {
    return !platforms.includes(bucketKey);
  }
  // 2) 平台集未提供 → 目标市场兜底：渠道适用市场与目标冲突 = 越界（'global' 视为匹配任何市场）
  if (!targetMarket) return false;
  const markets = (DIMENSIONS.channels && DIMENSIONS.channels.markets) ? DIMENSIONS.channels.markets[bucketKey] : null;
  if (!markets || !markets.length) return false; // 无标注则不过滤（容错）
  const tm = String(targetMarket).toLowerCase();
  return !markets.some(m => m.toLowerCase() === 'global' || tm.includes(m.toLowerCase()) || m.toLowerCase().includes(tm));
}

// 闸 B 辅助：从 state 提取目标市场（多来源容错，修正旧版误读 intent.region 单数导致市场过滤失效）
function extractTargetMarket(state) {
  const intent = state && state.intent;
  if (intent) {
    if (Array.isArray(intent.regions) && intent.regions.length) return intent.regions[0];
    if (intent.region) return intent.region;
  }
  if (state && state.targetMarket) return state.targetMarket; // 无 intent 时的兜底（此前因 !intent 提前 return 而失效，已修复）
  return null;
}

// 主守卫：蓝海曲线
function guardBlueOcean(blueOcean, ctx) {
  if (!blueOcean || !blueOcean.dimensions) return blueOcean;
  const signals = collectDemandSignals(ctx.competitors);
  const softBuckets = collectSoftAlignBuckets(ctx.competitors); // 优化五：第三层 LLM 语义召回（软证据）桶集合
  const target = ctx.targetMarket;
  const voiceBrands = countVoiceBrands(ctx.competitors);   // 优化一：需求样本厚度
  Object.keys(blueOcean.dimensions).forEach(dk => {
    const dim = blueOcean.dimensions[dk];
    dim.guarded = true;
    // 平台集（用户显式勾选；缺失时回退全渠道，由市场兜底）
    const platforms = (ctx.state && ctx.state.intent && Array.isArray(ctx.state.intent.platforms)) ? ctx.state.intent.platforms : null;
    (dim.buckets || []).forEach(b => {
      // 闸 A：蓝海曲线是供给轴，每桶标注需需求侧交叉
      b.crossAxis = 'supply-only';
      b.supplyOnlyNote = '仅基于供给侧计数；需需求侧信号交叉验证方可上升为机会';
      // 闸 B：渠道维度边界过滤（平台集优先 + 市场兜底）
      if (dk === 'channels') {
        b.outOfScope = channelOutOfScope(b.key, target, platforms);
        b.channelType = channelTypeOf(b.key);
        if (b.channelType === 'content') {
          b.contentNote = 'content 渠道（种草平台）：无官方店≠空白，以种草声量为准；空白须种草声量 none/low 且需求侧有证据方可视为机会';
        }
      }
      // 闸 C：空白桶查需求侧证据
      if (b.state === 'blue_gap') {
        const de = demandEvidenceFor(b.key, signals, softBuckets);
        b.demandEvidence = de.status;
        if (de.status === 'present') {
          b.gapKind = 'unmet_gap';            // 未满足空白（机会）
          if (de.soft) {
            // 第三层 LLM 语义召回：字面无匹配但语义相关——软证据，低置信、须核验
            b.demandEvidenceSoft = true;
            b.demandEvidenceNote = 'LLM 语义召回（第三层·需核验）：字面无匹配但语义相关；按软证据处理，置信上限锁 low，须交叉验证方可下注';
            b.confidenceCap = 'low';
            b.gapNote = '供给侧空且需求侧有软证据（LLM语义召回）→ 未满足空白（待核验），可视为候选机会';
          } else {
            b.gapNote = '供给侧空且需求侧有证据 → 未满足空白，可视为机会';
          }
        } else if (de.status === 'absent') {
          // 优化一：需求样本薄时，"absent"不可信——可能只是供给从未激活的沉默需求，
          // 不得断言"无需求"。软化为 silent_demand（区别于 supply_gap_only 的"已验证无需求"）。
          if (voiceBrands < SILENT_DEMAND_MIN_VOICE) {
            b.gapKind = 'silent_demand';
            b.gapNote = '供给侧空且需求侧无证据，但需求样本薄（仅 ' + voiceBrands + ' 家有用户声音）——可能为未被供给激活的沉默需求，不得断言"无需求"，需人工验证';
          } else {
            b.gapKind = 'supply_gap_only';      // 仅供给空白，禁称机会（需求样本充足，absent 可信）
            b.gapNote = '供给侧空，且需求侧无证据（需求样本充足）→ 仅供给空白（事实），不得称机会';
          }
          b.confidenceCap = 'low';
        } else {
          b.gapKind = 'speculative_gap';      // 推测性空白
          b.gapNote = '供给侧空，需求侧无法判定 → 推测性空白，待需求验证';
          b.confidenceCap = 'low';
        }
        // content 渠道额外护栏：空白必须以"种草声量 none/low"为前提
        // （readBuckets 已按种草量计 occupancy，所以此处 blue_gap 已是真实无种草；仅是提示性标注）
        if (b.channelType === 'content') {
          b.gapNote += '；content 渠道空白须以种草声量 none/low 为前提（readBuckets 已按种草量计 occupancy，无官店本身不算空白）';
        }
      }
    });
  });
  blueOcean.guardNote = '本视图已施加推理纪律 v2：供需交叉(闸A)/边界过滤(闸B)/单边降级(闸C)。';
  // 优化一：在维度层暴露沉默需求提示，让"零提及≠无需求"的盲区在输出中可见
  if (voiceBrands < SILENT_DEMAND_MIN_VOICE) {
    blueOcean.silentDemandHint = true;
    blueOcean.silentDemandNote = '需求侧样本仅 ' + voiceBrands + ' 家有用户声音（< ' + SILENT_DEMAND_MIN_VOICE + '），空白桶的"无需求"结论不可信：未被供给激活的沉默需求可能被误判，须人工验证。';
  }
  return blueOcean;
}

// 统一入口：对 state 的三类派生视图施加守卫（白空/机会图先做 crossAxis 标注，蓝海做完三闸）
function guardView(state) {
  const ctx = {
    competitors: state.competitors || [],
    targetMarket: extractTargetMarket(state),
    state: state
  };
  if (state.blueOcean) guardBlueOcean(state.blueOcean, ctx);
  // whiteSpace / opportunity 的 crossAxis 降级在各自模块已含"相对当前数据"标注；
  // 此处统一追加供需交叉提醒，防止选择性只用供给矩阵（缺陷5）。
  if (state.whiteSpace) state.whiteSpace.guarded = true;
  if (state.opportunity) state.opportunity.guarded = true;
  state.guardNote = '推理纪律 v2 已生效：任何机会结论须供需双侧交叉引用，单边证据自动降级。';
  return state;
}

module.exports = {
  guardView, guardBlueOcean,
  collectDemandSignals, demandEvidenceFor, channelOutOfScope, extractTargetMarket,
  collectSoftAlignBuckets, parseDemandAlignments,
  countVoiceBrands, SILENT_DEMAND_MIN_VOICE
};
