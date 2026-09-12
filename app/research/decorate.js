'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/decorate.js —— 导出: decorateState, aggExcludedSet, aggComps
// ============================================================

const { CATEGORIES, CHANNELS, computeRelationship, marketCurrency, resolvePlatforms } = require('./vocab.js');
const { buildCorrectionDashboard } = require('./corrections.js');
const { getCategoryField, getChannelField, getLaunchCadence, getPriceField, getReviewField } = require('./fields.js');
const DomainRunner = require('../lib/domain-runner.js');
const Guard = require('../lib/inference-guard.js');
const HeroProduct = require('../lib/hero-product.js');
const MatEngine = require('../lib/material-engine.js');
const PH = require('../lib/price-history.js');
const priceStore = require('./price-store.js');
const DomainVerdicts = require('./domain-verdicts.js');
const { evidenceDistribution } = require('../lib/evidence-dist.js');
const Radar = require('../lib/radar.js');
const { enrichFieldProvenance, provenanceGate } = require('../lib/field-confidence.js');
const { computeOpportunityMap } = require('../lib/opportunity.js');
const { computeBlueOceanCurve, computeSeedingPercentiles } = require('../lib/blue-ocean.js');
const { computeTrendView } = require('../lib/trend.js');

function decorateState(s) {
  if (!s || !Array.isArray(s.competitors)) return s;
  // R1：价格快照历史（仅本轮派生用；返回前剥离，不落盘不下发）
  s.__priceHist = null;
  try { if (s.projectId) s.__priceHist = priceStore.load(s.tenantId, s.projectId); } catch (e) {}
  // 平台集：每次读态实时重算，保证与 intent.regions/platforms 一致（单一可信源）
  s.intent = s.intent || {};
  s.intent.platforms = resolvePlatforms(s.intent);
  const profile = s.intent && s.intent.profile;
  for (const c of s.competitors) {
    c.relationship = computeRelationship(c, profile);
    // P1-7 · A1+A3-L1：字段对象上卷四态 + 独立来源数（可见），并施加来源可信门禁（L1）。
    // 门禁仅附加 credible / gateReason 标注（数据层可见，前端暂未消费），不改写 basis/confidence。
    const enrich = (f, kind) => {
      // B-2（2026-09-12 任务书）：L19 已解构导入，此处误用 FC. 命名空间 → FC is not defined
      const e = enrichFieldProvenance(f, kind);
      const g = provenanceGate(e);
      e.credible = g.credible;
      e.gateReason = g.reason;
      e.gateLevel = g.level;
      return e;
    };
    c.priceField = enrich(getPriceField(c, (s.fieldCorrections) || []), 'price');
    c.channelFields = {};
    // 只算选中平台的渠道字段（忠实助理：不展示用户不关心的平台）
    const chPlat = (s.intent && s.intent.platforms);
    const chKeys = (chPlat && chPlat.length) ? chPlat : CHANNELS;
    chKeys.forEach(k => { c.channelFields[k] = enrich(getChannelField(c, (s.fieldCorrections) || [], k), 'set'); });
    c.categoryFields = {};
    CATEGORIES.forEach(k => { c.categoryFields[k] = enrich(getCategoryField(c, (s.fieldCorrections) || [], k), 'set'); });
    c.launchCadence = enrich(getLaunchCadence(c, (s.fieldCorrections) || []), 'scalar');
    c.reviewField = enrich(getReviewField(c, (s.fieldCorrections) || []), 'review');
    c.pendingCorrections = (s.fieldCorrections || [])
      .filter(x => x.competitorId === c.id && x.status === 'pending')
      .map(x => ({ id: x.id, field: x.field, type: x.type, value: x.value, text: x.text, source: x.source, at: x.at }));
  }
  s.marketCurrency = marketCurrency(s.intent && s.intent.regions);
  // #305 聚合过滤集：错配/低置信卡不进任何聚合分母（UI 仍可见）
  const _aggEx = aggExcludedSet(s);
  const _aggComps = (s.competitors || []).filter(c => c.status === 'done' && !_aggEx.has(c.id));
  // ▶ PRD整改 §5.3 跨币种元认知闸门：聚合视图顶部 banner 所需（前端只渲染，不前端自检）
  s.crossCurrency = _aggComps
    .filter(c => {
      const cur = c.currency || s.marketCurrency;
      const hasPrice = (c.pricePoints || []).length || (c.priceBand && c.priceBand.range);
      return hasPrice && cur !== s.marketCurrency;
    })
    .map(c => `${c.name}(${c.currency || s.marketCurrency})`);
  // 机会地图（Ulwick ODI 改良）：派生产物，不落盘；与 priceField 同构，每次读态实时重算。
  // R2.5：机会视图接真实声音（voice-collector 采集产物，带来源 URL）
  const _realVoice = [];
  _aggComps.forEach(c => { (c.voiceItems || []).forEach(v => { if (v) _realVoice.push(v); }); });
  s.opportunity = computeOpportunityMap(_aggComps, { excluded: s.excluded || [], voiceItems: _realVoice });
  // 蓝海要素曲线（一维 · 全行业趋同处 vs 无人区）：派生产物，不落盘；与 whitespace-grid 同构。
  s.blueOcean = computeBlueOceanCurve(_aggComps, { minCoverage: 3 });
  // 推理纪律 v2：对派生视图施加供需交叉(闸A)/边界过滤(闸B)/单边降级(闸C) 三道闸（不落盘，实时重算）
  Guard.guardView(s);
  // 优化六：待复核时效仪表盘（顶层暴露，让用户看见队列积压与处理延迟）
  s.correctionDashboard = buildCorrectionDashboard(s.fieldCorrections || []);
  // 优化三：赛道时间趋势视图（fail-safe：多数 unknown → 趋势未知，不臆造）
  s.trendView = computeTrendView(_aggComps);
  // 优化四：种草声量相对百分位（组内排名，透明可核验；绝对值仍 LLM 估计，不臆造计数）
  const seedPct = computeSeedingPercentiles(_aggComps, s.intent && s.intent.platforms);
  s.competitors.forEach(c => {
    const pc = seedPct[c.id] || {};
    Object.keys(c.channelFields || {}).forEach(k => {
      if (pc[k]) {
        c.channelFields[k].seedingPercentile = pc[k].percentile;
        c.channelFields[k].seedingPercentileNote = pc[k].note;
        c.channelFields[k].seedingOrdinal = pc[k].ordinal;
      }
    });
  });
  // S1-① 主推产品推理（两信号：verified=准 / inferred=推，禁空）——挂在每个对手上，情报库/卡片墙引用
  s.competitors.forEach(c => { c.heroProduct = HeroProduct.heroProductInfer(c); });
  // S1-② 雷达变化检测 + 群体异动（群体异动进战略信号条；每对手最近动作挂 recentActions）
  s.radar = Radar.computeRadar(_aggComps, { excluded: s.excluded || [] });
  s.competitors.forEach(c => {
    c.recentActions = (s.radar && s.radar.perCompetitor && s.radar.perCompetitor[c.id]) ||
      { competitorId: c.id, competitorName: c.name, hasAction: false, kind: 'none', action: null, all: [] };
  });
  // Phase A（架构总纲 v3 §3/§4/§8）：域注册表驱动 —— 按 enabled 域遍历产出 verdict 快照。
  // 非破坏：不修改现有字段，仅附加 domainVerdicts（verdict 快照层，L3 材料引擎/Phase B 消费）。
  // 当前 Phase B 仅 price 域 enabled:true（跟价材料）；其余域已注册但不出材料（T4 护栏）。
  s.domainVerdicts = DomainRunner.runEnabledDomains(s, {
    price: (st) => {
      const exSet = aggExcludedSet(st);
      const doneComps = (st.competitors || []).filter(c => c.status === 'done' && !exSet.has(c.id));
      // P0-1：与用户定位锚点做带位比较 → 推算影响面（真实计算，非编造；无锚点则不推）
      const ub = (st.intent && st.intent.profile && st.intent.profile.priceBand) || null;
      const items = doneComps.map(c => {
        const pf = c.priceField || {};
        const band = pf.band || null;
        const cur = pf.currency || 'USD';
        const hasMin = band && band.min != null;
        const hasMax = band && band.max != null;
        const srcs = (pf.sources || []).filter(s => s && (s.url || s.text)).map(s => ({
          label: String((s.text || s.url || '')).slice(0, 48),
          url: s.url || '',
          tier: s.tier || 3,
        }));
        // 推算影响面：价格带与用户锚点带位比较（诚实：无锚点/无带位 → 不推）
        let inferText = null, inferWhy = null;
        if (hasMin && ub && ub.min != null) {
          const lo = band.min, hi = hasMax ? band.max : band.min;
          const uLo = ub.min, uHi = ub.max != null ? ub.max : ub.min;
          if (lo <= uHi && uLo <= hi) {
            inferText = `与你的价格带（${cur} ${uLo}–${uHi}）存在部分重叠，主要竞争区间重叠。`;
          } else if (lo > uHi) {
            inferText = `价格带（${cur} ${lo}${hasMax ? '–' + band.max : ''}）整体高于你的带位，主战场在更高价位细分。`;
          } else {
            inferText = `价格带（${cur} ${lo}${hasMax ? '–' + band.max : ''}）整体低于你的带位，走量打法，需留意价格锚定。`;
          }
          inferWhy = `价格带取自 ${(pf.sources || []).length} 条来源的带位裁决；你的锚点来自定位档案。推算项，供你判断。`;
        }
        return {
          subjectId: 'brand:' + ((c.name || c.id || '').toLowerCase().replace(/[^a-z0-9]/g, '') || c.id),
          brand: { name: c.name || c.id || '', url: c.url || '' },
          claim: pf.display ? `${c.name} 价格区间 ${pf.display}` : `${c.name} 价格未探测`,
          confidence: pf.confidence || 'low',
          basis: pf.basis || 'unverified',
          evidenceIds: srcs.map(s => s.url).filter(Boolean),
          sources: srcs,
          // R1 跟价闭环：new/old/deltaPct 取自价格快照历史（同口径标量价）；无历史 → 显式 null，不编造涨跌
          price: (() => {
            if (!hasMin && !band) return null;
            const curPrice = priceStore.currentScalarPrice(c);
            const prev = curPrice != null ? PH.previousDistinct(st.__priceHist || [], c.id, curPrice, cur) : null;
            const base = { currency: cur, range: hasMax ? { min: band.min, max: band.max } : (hasMin ? { min: band.min, max: band.min } : null) };
            if (prev) return Object.assign(base, { new: curPrice, old: prev.price, deltaPct: PH.deltaPctOf(prev.price, curPrice) });
            return Object.assign(base, { new: hasMin ? band.min : null, old: null, deltaPct: null });
          })(),
          inference: inferText ? { text: inferText, why: inferWhy } : null,
          missingFields: pf.display ? [] : ['priceRange'],
          scope: pf.priceScope || 'list',
        };
      });
      return {
        subjectCount: items.length,
        items,
        basis: items.length ? (items.every(i => i.basis === 'verified') ? 'verified' : 'inferred') : 'unverified',
        confidence: items.length ? (items.some(i => i.confidence === 'high') ? 'medium' : 'low') : 'low',
      };
    },

    voice: DomainVerdicts.voiceVerdict,
    channel: (st) => DomainVerdicts.channelVerdict(st, CHANNELS, aggExcludedSet),
  });
  // Phase B：L3 材料引擎 —— 消费 enabled 域 verdict 快照，产出待批材料（工作台 L4 消费）。
  // 当前仅 price 域 enabled → 只产出跟价材料（Phase B 验收：只有价格域材料上线）。
  // R1：把价格快照历史按 verdict subjectId 喂给材料引擎（变价材料分支得以生效）
  try {
    const _histMap = {};
    const _list = s.__priceHist || [];
    for (const c of (s.competitors || [])) {
      const key = 'brand:' + ((c.name || c.id || '').toLowerCase().replace(/[^a-z0-9]/g, '') || c.id);
      const hist = _list.filter(x => x && x.competitorId === c.id).slice(-3)
        .map(x => ({ at: x.at, display: x.display != null ? x.display : String(x.price) }));
      if (hist.length) _histMap[key] = hist;
    }
    s.materials = MatEngine.buildMaterials(s, { priceHistory: _histMap }).materials;
  } catch (e) { s.materials = MatEngine.buildMaterials(s).materials; }
  // R6：全字段证据分布（诚实条数据源），实时派生不落盘
  try { s.evidenceDist = evidenceDistribution(s); } catch (e) {}
  try { delete s.__priceHist; } catch (e) {}
  return s;
}
// ---- #305 聚合过滤：错配/低置信卡（entityAmbiguous / categoryTearing）不得进赛道统计、空白视图分母、brief 基数 ----
// 仍保留在 s.competitors（UI 可见，供用户裁决是否排除），仅从聚合派生中剔除。
function aggExcludedSet(state) {
  const ex = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) ex.add(c.id); });
  return ex;
}
function aggComps(state) {
  const ex = aggExcludedSet(state);
  return (state.competitors || []).filter(c => c.status === 'done' && !ex.has(c.id));
}


module.exports = { decorateState, aggExcludedSet, aggComps };
