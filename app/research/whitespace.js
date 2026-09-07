'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/whitespace.js —— 导出: GAP_METHOD, gapMethodOf, TACTIC_LABELS, computeSingleCompetitorGaps, computeWhiteSpace, assessPositioning
// ============================================================

const { CHANNELS, COLLAB_TYPES, CONTENT_FORMS, FULFILLMENT, REGIONS, SELLING_POINTS, SP_LABEL, TACTICS, fmtMoney, marketCurrency, priceLadder } = require('./vocab.js');
const { DISCLAIMER_TEXT, confNum, stableHash } = require('./corrections.js');
const { normName } = require('./candidates.js');
const { applyAccuracyGate, loadAccuracySummary } = require('../lib/metrics.js');
const { computeWhiteSpaceGrid } = require('../lib/whitespace-grid.js');
const { gapConfidence } = require('../lib/confidence.js');

function assessPositioning(state) {
  const prof = (state.intent && state.intent.profile) || null;
  const excluded = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) excluded.add(c.id); }); // #305 错配/低置信卡一并剔除
  const comps = state.competitors.filter(c => c.status === 'done' && !excluded.has(c.id));
  const MKT_CUR = marketCurrency(state.intent && state.intent.regions);
  const out = { hasProfile: !!prof, price: null, sellingPoints: null, challenges: [] };

  // 价格段原点：只有与用户同币种的对手才进同一张比较（跨币种不换算，铁律）
  if (prof && prof.priceBand && prof.priceBand.min != null && prof.priceBand.max != null) {
    const cur = prof.priceBand.currency || MKT_CUR;
    const lo = +prof.priceBand.min, hi = +prof.priceBand.max;
    let overlap = 0; const names = [];
    comps.forEach(c => {
      const cCur = c.currency || MKT_CUR;
      if (cCur !== cur) return;
      const pts = (c.pricePoints || []).filter(n => typeof n === 'number' && n > 0);
      const range = c.priceBand && c.priceBand.range;
      let hit = false;
      if (pts.length) hit = pts.some(p => p >= lo && p <= hi);
      else if (range) { const m = String(range).match(/(\d+)\D+(\d+)/); if (m) { const a = +m[1], b = +m[2]; hit = hi > a && lo < b; } }
      if (hit) { overlap++; names.push(c.name); }
    });
    out.price = { band: { min: lo, max: hi, currency: cur }, contestedBy: overlap, contestedNames: names.slice(0, 6) };
    if (overlap >= 3) out.challenges.push({ type: 'price_crowded', text: `你定的 ${cur} ${fmtMoney(lo, cur)}–${fmtMoney(hi, cur)} 价格段已被 ${overlap} 家对手占据，属红海——要么找差异点，要么看相邻空档。` });
    else if (overlap === 0) out.challenges.push({ type: 'price_open', text: `你定的 ${cur} ${fmtMoney(lo, cur)}–${fmtMoney(hi, cur)} 价格段目前无人直接占据，是可守的空档（但仍看产品力）。` });
    else out.challenges.push({ type: 'price_partial', text: `你定的 ${cur} ${fmtMoney(lo, cur)}–${fmtMoney(hi, cur)} 价格段有 ${overlap} 家对手在打，不算拥挤但已有先入者。` });
  }

  // 卖点原点：你选的卖点里，哪些被对手占了、哪些还是空白
  if (prof && (prof.sellingPoints || []).length) {
    const spComps = comps.filter(c => (c.sellingPoints || []).length);
    out.sellingPoints = prof.sellingPoints.map(sp => {
      const claimed = spComps.filter(c => (c.sellingPoints || []).includes(sp)).map(c => c.name);
      return { sp, label: SP_LABEL[sp] || sp, claimedBy: claimed.length, claimedNames: claimed.slice(0, 6) };
    });
    out.sellingPoints.forEach(r => {
      if (r.claimedBy === 0) out.challenges.push({ type: 'sp_open', text: `你选的卖点「${r.label}」目前无对手主打，是空白可占。` });
      else if (r.claimedBy >= 3) out.challenges.push({ type: 'sp_crowded', text: `你选的卖点「${r.label}」已被 ${r.claimedBy} 家对手主打（${r.claimedNames.join('、')}），属拥挤方向。` });
    });
  }
  return out;
}

// ============================================================
// 步骤3：空白推理引擎（执行弱 + 邻接 + 细粒度）
// ============================================================

// 推理方法论标注（把 type+evidence 映射到统一「推理类别」标签，供前端透明展示"这条空位怎样推出来"）。
const GAP_METHOD = {
  'executionWeak': { key: 'execWeak', label: '执行弱探测（在售但被评执行弱）' },
  'absence:verified-neg': { key: 'verifiedAbsence', label: '已验证缺失（多家确证未入驻）' },
  'absence:partial-verified': { key: 'partialVerifiedAbsence', label: '部分验证缺失（部分确证、部分未探测）' },
  'absence:undetected': { key: 'undetectedAbsence', label: '未探测（仅未查到，非确认不做）' },
  'absence:neg': { key: 'regionAbsence', label: '地域缺席（无对手覆盖该市场）' },
  'priceGap:scraped-prices': { key: 'priceScraped', label: '价位阶梯空档（≥2家实抓价佐证）' },
  'priceGap:stated-prices': { key: 'priceStated', label: '价位阶梯空档（陈述价佐证）' },
  'priceGap:undetected': { key: 'priceLack', label: '价格数据不足（<3家同币种）' },
  'claimGap:matrix': { key: 'spMatrix', label: '卖点矩阵空缺（品牌×卖点无人认领）' },
  'tacticGap:matrix': { key: 'tacticMatrix', label: '策略矩阵空缺（品牌×打法无人使用）' },
  'demandGap:reviews': { key: 'painSpeculation', label: '口碑痛点推测（被抱怨但无人解决）' },
  'adjacency:struct': { key: 'adjacencyStruct', label: '邻接结构推理（相邻品类通用打法，无对手采用）' },
  'singleBlindSpot:struct': { key: 'singleBlindSpot', label: '单家盲点（同类对手在做/本对手价位复购，结构推理其留白）' }
};
const gapMethodOf = (type, evidence) => GAP_METHOD[type + ':' + evidence] || GAP_METHOD[type] || { key: 'other', label: '结构推理' };

// 销售策略中文标签（模块级复用）
const TACTIC_LABELS = { discount: '折扣促销', bundle: '捆绑销售', subscription: '订阅制', ugcCampaign: 'UGC征集', livestreamSelling: '直播带货', membership: '会员制', influencerSeeding: '达人种草', giveaway: '抽奖赠品', preorder: '预售', loyaltyProgram: '积分忠诚', seasonalDrop: '季节限定上新', communityBuilding: '社群运营' };

// ▶ #10 冷启动单家空白：当已研究对手 < 3 家时，不再整体隐藏空白视图，
// 改为产出「单家观察」空白——按结构推理"应做而未做"（如同类对手在做的渠道/打法本对手没做、复购价位却无订阅制）。
// 严格标注：非群体共识、低置信(unverified)、level=undetected、附免责声明；quality gate 仍生效（不冒充市场机会）。
function computeSingleCompetitorGaps(state, comps) {
  const MKT_CUR = marketCurrency(state.intent && state.intent.regions);
  const LADDER = priceLadder(MKT_CUR);
  const gaps = [];
  const pushSingle = (c, dim, value, type, note, src) => {
    const m = gapMethodOf(type, 'struct');
    gaps.push({
      dim, value, type,
      confidence: 'low', confidenceNum: confNum('low'), basis: 'unverified',
      evidence: 'struct', note, method: m.label, methodKey: m.key,
      sources: src || [], level: 'undetected',
      isGroup: false, singleCompetitor: true, copyGap: false,
      disclaimer: DISCLAIMER_TEXT,
      gid: 'G-' + stableHash(`${dim}|${value}|${type}|single|${c.id}`)
    });
  };
  comps.forEach(c => {
    const others = comps.filter(p => p.id !== c.id);
    // 1) 渠道盲点：同类对手在该渠道活跃、本对手未入驻（结构推理其留白）
    CHANNELS.forEach(ch => {
      const activePeers = others.filter(p => (p.channels || {})[ch] && (p.channels[ch].present === true));
      const cRec = (c.channels || {})[ch];
      const cPresent = cRec && cRec.present === true;
      if (activePeers.length && !cPresent) {
        pushSingle(c, '渠道', ch, 'singleBlindSpot',
          `「${c.name}」未在 ${ch} 布局（其同类对手 ${activePeers.map(p => p.name).join('/')} 在该渠道活跃，结构推测其留白）`,
          activePeers.map(p => ({ name: p.name, basis: 'inferred', detail: '在' + ch + '活跃' })));
      }
    });
    // 2) 打法盲点：同类对手采用该打法、本对手未采用
    TACTICS.forEach(tc => {
      const tcLabel = TACTIC_LABELS[tc] || tc;
      const usingPeers = others.filter(p => (p.tactics || []).includes(tc));
      const cUsing = (c.tactics || []).includes(tc);
      if (usingPeers.length && !cUsing) {
        pushSingle(c, '策略空缺', tcLabel, 'singleBlindSpot',
          `「${c.name}」未采用「${tcLabel}」打法（其同类对手 ${usingPeers.map(p => p.name).join('/')} 采用，结构推测其留白）`,
          usingPeers.map(p => ({ name: p.name, basis: 'inferred', detail: '采用' + tcLabel })));
      }
    });
    // 3) 复购价位却无订阅/会员（仅需本对手数据，结构推测其留白）
    const pts = (c.pricePoints || []).filter(n => typeof n === 'number' && n > 0);
    if (pts.length && LADDER.length) {
      const inLowBand = pts.some(p => p >= LADDER[0].min && p < LADDER[0].max);
      const hasSub = (c.tactics || []).some(t => ['subscription', 'membership', 'loyaltyProgram'].includes(t));
      if (inLowBand && !hasSub) {
        pushSingle(c, '策略空缺', '订阅/会员制', 'singleBlindSpot',
          `「${c.name}」定价含 ${MKT_CUR} ${Math.min(...pts)} 的复购价位却无订阅制/会员（复购型品类常见留白，结构推测）`,
          [{ name: c.name, basis: 'inferred', detail: '低位复购价' }]);
      }
    }
  });
  return gaps;
}

function computeWhiteSpace(state) {
  const excluded = new Set(state.excluded || []);
  (state.competitors || []).forEach(c => { if (c.entityAmbiguous || c.categoryTearing) excluded.add(c.id); }); // #305 错配/低置信卡一并剔除
  const comps = state.competitors.filter(c => c.status === 'done' && !excluded.has(c.id));
  const total = comps.length;
  // ▶ #10：<3 家不再整体隐藏——转单家观察模式（hidden:false + singleMode），产出结构推理的单家盲点。
  // 仅 0 家完成研究时才回退隐藏（无可推理对象）。
  if (total < 3) {
    if (total === 0) return { hidden: true, reason: 'add_more', total, excludedCount: excluded.size, positioning: assessPositioning(state) };
    const gaps = computeSingleCompetitorGaps(state, comps);
    const coverage = Math.round((comps.length / Math.max(1, state.competitors.length)) * 100);
    return { hidden: false, singleMode: true, total, coverage, dimCoverage: {}, gaps, positioning: assessPositioning(state) };
  }

  const gaps = [];
  // 统一 basis：high→verified（我们查实）、medium→inferred（部分/间接）、low→unverified（仅未探测/推测）。
  const gapBasis = (conf) => conf === 'high' ? 'verified' : conf === 'medium' ? 'inferred' : 'unverified';
  const pushGap = (dim, value, type, conf, evidence, note, sources, copyGap) => {
    const num = confNum(conf);
    const m = gapMethodOf(type, evidence);
    gaps.push({
      dim, value, type,
      confidence: conf, confidenceNum: num, basis: gapBasis(conf),
      evidence, note: note || '',
      method: m.label, methodKey: m.key,
      sources: Array.isArray(sources) ? sources : [],
      level: num < 40 ? 'undetected' : 'opportunity',
      // ▶ 报告-数据同源 原则4：卖点/策略矩阵空缺基于"官网文案比对"，属"文案空缺(观察级)"，
      // 非"市场空缺(需需求侧证据)"——前端/报告须区分，不拿"数量"撑机会场面。
      copyGap: !!copyGap
    });
  };

  // 1) 渠道：缺席 + 执行弱（区分"已验证缺失"与"未探测"，未探测不当作机会）
  CHANNELS.forEach(ch => {
    const recs = comps.map(c => ({ name: c.name, rec: (c.channels || {})[ch] })).filter(x => x.rec);
    const present = recs.filter(x => x.rec.present === true);
    const verifiedAbsent = recs.filter(x => x.rec.present === false && x.rec.basis === 'verified');
    const unverifiedAbsent = recs.filter(x => x.rec.present === false && x.rec.basis !== 'verified');
    const weak = recs.filter(x => x.rec.present === true && /弱|少|差|低|投诉|硬广|无内容|缺/.test(x.rec.note || ''));
    if (present.length > 0) {
      if (weak.length > 0) {
        const src = weak.map(x => ({ name: x.name, basis: x.rec.basis || 'inferred', detail: (x.rec.note || '').slice(0, 36) }));
        pushGap('渠道', ch, 'executionWeak', 'medium', 'present-but-weak', `${weak.length}/${present.length}家在做但执行弱`, src);
      }
      return;
    }
    // 无人 present：区分"已验证缺失"与"未探测"
    if (verifiedAbsent.length === recs.length && recs.length > 0) {
      const src = verifiedAbsent.map(x => ({ name: x.name, basis: 'verified', detail: '确认未入驻' }));
      pushGap('渠道', ch, 'absence', 'high', 'verified-neg', `行业普遍确认未进入该渠道（${verifiedAbsent.length}家均确认缺席）`, src);
    } else if (verifiedAbsent.length > 0) {
      const src = verifiedAbsent.map(x => ({ name: x.name, basis: 'verified', detail: '确认未入驻' }))
        .concat(unverifiedAbsent.map(x => ({ name: x.name, basis: 'unverified', detail: '未探测到' })));
      pushGap('渠道', ch, 'absence', 'medium', 'partial-verified', `${verifiedAbsent.length}家确认缺席，${unverifiedAbsent.length}家未探测到`, src);
    } else if (unverifiedAbsent.length > 0) {
      const src = unverifiedAbsent.map(x => ({ name: x.name, basis: 'unverified', detail: '未探测到' }));
      pushGap('渠道', ch, 'absence', 'low', 'undetected', `${unverifiedAbsent.length}家未探测到该渠道布局（可能只是没查到，非确认不做）`, src);
    }
  });

  // ==========================================================
  // PRD 四类空缺 —— ① 价位空缺（价格阶梯聚类，实价证据，置信度上限 high）
  // ==========================================================
  // 币种裁决：只有与目标市场同币种的对手才进同一张阶梯 —— 跨币种直接比数字是错的，且我们不做汇率换算
  const MKT_CUR = marketCurrency(state.intent && state.intent.regions);
  const LADDER = priceLadder(MKT_CUR);
  const ladderOcc = {}; // key -> [{name, verified}]
  LADDER.forEach(L => { ladderOcc[L.key] = []; });
  const pricedList = []; // 每家对手定价落在的阶梯（溯源用：空档由"对手均在其它档"反推）
  const crossCurrency = []; // 有价格但币种不同 → 不参与比较，但要如实告诉用户被排除了
  comps.forEach(c => {
    const cCur = c.currency || MKT_CUR;
    const hasPrice = (c.pricePoints || []).length || (c.priceBand && c.priceBand.range);
    if (hasPrice && cCur !== MKT_CUR) { crossCurrency.push(`${c.name}(${cCur})`); return; }
    const pts = (c.pricePoints || []).filter(n => typeof n === 'number' && n > 0);
    if (pts.length) {
      const hit = new Set();
      pts.forEach(p => { const L = LADDER.find(x => p >= x.min && p < x.max); if (L) hit.add(L.key); });
      hit.forEach(k => { const Lx = LADDER.find(x => x.key === k); ladderOcc[k].push({ name: c.name, verified: !!c.priceVerified }); pricedList.push({ name: c.name, ladder: Lx.label, verified: !!c.priceVerified }); });
    } else if (c.priceBand && c.priceBand.range) {
      // 无实价时用 band 文本区间粗略映射
      const m = String(c.priceBand.range).match(/(\d+)\D+(\d+)/);
      if (m) {
        const lo = +m[1], hi = +m[2];
        LADDER.forEach(L => { if (hi > L.min && lo < L.max) { ladderOcc[L.key].push({ name: c.name, verified: false }); pricedList.push({ name: c.name, ladder: L.label, verified: false }); } });
      }
    }
  });
  const pricedComps = comps.filter(c => (c.currency || MKT_CUR) === MKT_CUR && ((c.pricePoints || []).length || (c.priceBand && c.priceBand.range))).length;
  const xcNote = crossCurrency.length ? `（另有 ${crossCurrency.length} 家币种不同未纳入比较：${crossCurrency.slice(0, 4).join('、')}）` : '';
  const priceSrc = () => pricedList.map(p => ({ name: p.name, basis: p.verified ? 'verified' : 'inferred', detail: '定价落在' + p.ladder }));
  if (pricedComps >= 3) {
    LADDER.forEach(L => {
      const occ = ladderOcc[L.key];
      if (occ.length === 0) {
        // ▶ 空白视图整改 · 规范 B：verifiedCnt 按「品牌」去重（一家实抓只算 1，无论落几个档），
        // 避免 1 家 × N 档被误算成 N 家实抓、虚高 high 判定。
        const verifiedBrands = new Set(Object.values(ladderOcc).flat().filter(o => o.verified).map(o => o.name));
        const verifiedCnt = verifiedBrands.size;
        const conf = verifiedCnt >= 2 ? 'high' : 'medium'; // 有≥2家实抓价格佐证 → 高置信
        pushGap('价位空缺', L.label, 'priceGap', conf, verifiedCnt >= 2 ? 'scraped-prices' : 'stated-prices', `${pricedComps}家对手（均以 ${MKT_CUR} 计价）定价都不落在 ${L.label} 档（${verifiedCnt}家为实抓价格），该价位带无人占据${xcNote}`, priceSrc());
      }
    });
  } else {
    pushGap('价位空缺', '数据不足', 'priceGap', 'low', 'undetected', `仅${pricedComps}家有 ${MKT_CUR} 计价数据，不足以判断价位空档（需≥3家）${xcNote}`, priceSrc());
  }

  // ==========================================================
  // ② 卖点空缺（受控词表 × 品牌矩阵，置信度上限 medium：归类有主观性）
  // ==========================================================
  const spComps = comps.filter(c => (c.sellingPoints || []).length);
  if (spComps.length >= 3) {
    // ▶ 1.3：矩阵反推 gap 过度保守修复 —— 来源 basis 不再恒 'inferred'，
    // 改按"该对手卖点矩阵是否含查实(verified)证据"判定，与渠道 verified-neg 同口径。
    // 仅当对手确有 verified 级卖点时才标 verified，绝不为无据数据虚报 verified。
    const spSrc = spComps.map(c => {
      const sb = c.sellingPointBasis || {};
      const verified = (c.sellingPoints || []).some(p => sb[p] === 'verified');
      return { name: c.name, basis: verified ? 'verified' : 'inferred', detail: '已查卖点矩阵' };
    });
    SELLING_POINTS.forEach(sp => {
      const claimed = spComps.filter(c => (c.sellingPoints || []).includes(sp));
      if (claimed.length === 0) {
        pushGap('卖点空缺', SP_LABEL[sp] || sp, 'claimGap', 'medium', 'matrix', `${spComps.length}家对手无一主打「${SP_LABEL[sp] || sp}」，卖点矩阵该列空缺`, spSrc, true);
      }
    });
  }

  // ==========================================================
  // ③ 销售策略空缺（策略词表 × 品牌矩阵）
  // ==========================================================
  const tcComps = comps.filter(c => (c.tactics || []).length);
  if (tcComps.length >= 3) {
    // ▶ 1.3：策略矩阵来源 basis —— tactics 维度 schema 无 per-tactic verified basis（仅 demandEvidence），
    // 故用"该对手 tactics 来自真实一手证据(fieldSource tier=1)"作 verified 信号，与 verified-neg 同口径。
    const tcSrc = tcComps.map(c => {
      const ts = (c.fieldSources && c.fieldSources['tactics']) || [];
      const verified = ts.some(s => s.tier === 1);
      return { name: c.name, basis: verified ? 'verified' : 'inferred', detail: '已查打法矩阵' };
    });
    TACTICS.forEach(tc => {
      const used = tcComps.filter(c => (c.tactics || []).includes(tc));
      if (used.length === 0) {
        pushGap('策略空缺', TACTIC_LABELS[tc] || tc, 'tacticGap', 'medium', 'matrix', `${tcComps.length}家对手无一采用「${TACTIC_LABELS[tc] || tc}」打法`, tcSrc, true);
      }
    });
  }

  // ==========================================================
  // ④ 市场机会空缺（口碑痛点：被抱怨但没人解决 → 强制封顶 low·标推测）
  // ==========================================================
  const painMap = new Map(); // 归一化痛点 -> {point, brands:[], hasCite}
  comps.forEach(c => {
    (c.painPoints || []).forEach(p => {
      const key = normName(p.point).slice(0, 24);
      if (!key) return;
      const ex = painMap.get(key) || { point: p.point, brands: [], hasCite: false };
      if (!ex.brands.includes(c.name)) ex.brands.push(c.name);
      if (p.basis === 'verified' || p.basis === 'inferred') ex.hasCite = ex.hasCite || (p.confidence !== 'low');
      painMap.set(key, ex);
    });
    // 复用 reviews.negThemes 作为补充痛点源
    ((c.reviews || {}).negThemes || []).forEach(t => {
      const key = normName(t).slice(0, 24);
      if (!key) return;
      const ex = painMap.get(key) || { point: t, brands: [], hasCite: false };
      if (!ex.brands.includes(c.name)) ex.brands.push(c.name);
      painMap.set(key, ex);
    });
  });
  Array.from(painMap.values())
    .filter(p => p.brands.length >= 2) // 至少两家被抱怨同一点 → 行业级痛点
    .sort((a, b) => b.brands.length - a.brands.length)
    .slice(0, 6)
    .forEach(p => {
      const src = p.brands.map(b => ({ name: b, basis: 'inferred', detail: '抱怨：「' + p.point + '」' }));
      pushGap('市场机会', p.point, 'demandGap', 'low', 'reviews', `${p.brands.length}家对手（${p.brands.slice(0, 3).join('/')}）被用户抱怨「${p.point}」且无人宣称解决 —— 推测存在需求空档`, src);
      gaps[gaps.length - 1].speculative = true; // 强制标"推测"（低置信，按 PRD §7.1 归 undetected + 免责声明，不冒充机会）
    });

  // ▶ 空白视图整改 · 规范 E：邻接结构推理（联名/内容/履约）强制 low + 类比依据
  // ==========================================================
  // 原有邻接/细粒度维度（保留）
  // ==========================================================
  const allCollab = comps.flatMap(c => c.collabTypes || []);
  COLLAB_TYPES.forEach(ct => {
    if (!allCollab.includes(ct)) {
      // 规范 E：邻接结构推理（联名）置信度强制 low，level 恒 undetected，不得显示为机会
      pushGap('联名', ct, 'adjacency', 'low', 'struct', `无对手采用${ct}联名（类比依据：相邻品类普遍用联名拉新；无对手采用≠对手刻意不做，需核验）`);
    }
  });
  const allContent = comps.flatMap(c => c.contentForms || []);
  CONTENT_FORMS.forEach(cf => {
    if (!allContent.includes(cf)) {
      pushGap('内容', cf, 'adjacency', 'low', 'struct', `无对手主打${cf}内容形态（类比依据：相邻品类内容打法常规；无对手采用属结构推测，非确证缺失）`);
    }
  });
  REGIONS.forEach(rg => {
    const present = comps.filter(c => (c.regions || []).includes(rg)).length;
    if (present === 0) {
      // ▶ 1.3：地域矩阵来源 basis —— regions 来自主研究无独立 verified basis，
      // 故用"该对手 regions 来自真实一手证据(fieldSource tier=1)"作 verified 信号，与 verified-neg 同口径。
      const src = comps.map(c => {
        const rs = (c.fieldSources && c.fieldSources['regions']) || [];
        const verified = rs.some(s => s.tier === 1);
        return { name: c.name, basis: verified ? 'verified' : 'inferred', detail: '无该市场覆盖' };
      });
      pushGap('地域', rg, 'absence', 'medium', 'neg', `无对手覆盖${rg}市场`, src);
    }
  });
  FULFILLMENT.forEach(f => {
    const present = comps.filter(c => (c.fulfillment || []).includes(f)).length;
    if (present === 0) pushGap('履约', f, 'adjacency', 'low', 'struct', `无对手采用${f}履约（类比依据：相邻品类履约方式常规；无对手采用属结构推测，非确证缺失）`);
  });

  // 各维度采集覆盖率（PRD §8：覆盖率 <70% 严禁输出群体性空白）
  const cov = (arr) => { const n = (arr || []).filter(Boolean).length; return comps.length ? n / comps.length : 0; };
  const dimCov = {
    '渠道': cov(comps.map(c => c.channels && Object.keys(c.channels).length)),
    '价位空缺': cov(comps.map(c => (c.pricePoints || []).length || (c.priceBand && c.priceBand.range))),
    '卖点空缺': cov(comps.map(c => (c.sellingPoints || []).length)),
    '策略空缺': cov(comps.map(c => (c.tactics || []).length)),
    '地域': cov(comps.map(c => (c.regions || []).length))
  };
  const GROUP_DIMS = new Set(['渠道', '价位空缺', '卖点空缺', '策略空缺', '地域', '联名', '内容', '履约']); // ▶ 空白视图整改 · 规范 D：补全 3 条邻接维度，无绕过路径

  // ==========================================================
  // ▶ 空白视图整改 · 架构整改#1 + 规范 A：群体空白「统一置信收敛」闸门（坐在 gap 生成边界）
  // 闭合裂缝一·第三变体（字段层已收敛，gap 层此前 7 条路径各自手写）。
  // 规则（由「证据形态」决定，不按路径硬编码）：
  //   - 机会门槛 oppGate：维度覆盖率≥70% 且 存在「已查实(verified)」来源 → 才可作为可行动机会；
  //   - 置信度：已查实品牌≥2 → high；恰好 1 家已查实 → medium；否则 low；
  //   - 不满足 oppGate（覆盖率<70% 或 来源空/全推断）→ level 恒 undetected（不得显示为机会），并显式标注。
  //   - 所有 gap 均跨≥2 品牌聚合 → 一律标记 isGroup=true（供前端双保险过滤，规范 C）。
  // 收敛逻辑已抽离为 lib/confidence.js 的纯函数 gapConfidence（可单测，详见 test/gap-confidence.test.js）。
  // ==========================================================

  gaps.forEach(g => {
    g.isGroup = true; // ▶ 空白视图整改 · 规范 A/C：群体 gap 标记，供前端双保险过滤
    const tracked = dimCov.hasOwnProperty(g.dim);
    const covVal = tracked ? (dimCov[g.dim] || 0) : 1;
    const r = gapConfidence(g.sources, covVal, tracked);
    const prevNum = confNum(g.confidence);
    const demoted = (g.level === 'opportunity' && r.level === 'undetected') || (prevNum > r.confidenceNum);
    g.confidence = r.confidence; g.confidenceNum = r.confidenceNum; g.basis = r.basis; g.level = r.level;
    if (!r.covOk && tracked) g.coverageInsufficient = true;
    if (demoted) {
      const reasons = [];
      if (!r.covOk && tracked) reasons.push(`维度采集覆盖率 ${Math.round(covVal * 100)}% < 70%，群体性结论暂不可信`);
      if (r.verified === 0) reasons.push(`来源为空或全部为推断（无已查实交叉佐证），不得作为机会结论`);
      if (reasons.length) g.note += `（${reasons.join('；')}）`;
    }
  });
  // 低可信缺失项统一附免责声明（PRD §7.1 硬验收）
  gaps.forEach(g => { if (g.level === 'undetected') g.disclaimer = DISCLAIMER_TEXT; });
  // 空缺编号（稳定内容哈希，可跨时间引用，支撑校准率回溯与 /api/report 对齐）
  gaps.forEach(g => { g.gid = 'G-' + stableHash(`${g.dim}|${g.value}|${g.type}|${g.methodKey}`); });

  // P0-4 字段准确率 input 门禁：依赖维度抽取准确率不足（<红线80%）→ 该维空白推理退出，
  // 仅作未探测区域展示（不阻塞整体上线）。无抽检数据 → fail-open，不降级（冷启动不误杀）。
  applyAccuracyGate(gaps, loadAccuracySummary());

  // 覆盖率（竞品参与率，用于前端头部展示）
  const coverage = Math.round((comps.length / Math.max(1, state.competitors.length)) * 100);
  // 三态网格（真空位/未知/死区）：派生产物，不落盘；与 priceField/opportunity 同构，每次读态实时重算。
  const grid = computeWhiteSpaceGrid(state.competitors, { minCellCoverage: 3 });
  return { hidden: false, total, coverage, dimCoverage: dimCov, gaps, positioning: assessPositioning(state), grid };
}


module.exports = { GAP_METHOD, gapMethodOf, TACTIC_LABELS, computeSingleCompetitorGaps, computeWhiteSpace, assessPositioning };
