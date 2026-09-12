'use strict';
// ============================================================
// 竞争强度 × 机会大小 象限（S3-⑤）
// ------------------------------------------------------------
// 回答："我该先打谁？"——把每个对手放到一张 2×2 图上。
//
//   Y 轴 = 竞争强度 entrenchment（越上越难撼动）
//        = 0.6 × 分层等级(0..1) + 0.4 × 在赛道规模中的份额(0..1)
//        分层 unknown 计 0；无规模信号时份额=0（仅按分层估）。
//
//   X 轴 = 机会大小 openness（越右越值得攻）
//        = 该对手"参与的主题"的机会分暴露，跨对手归一(0..1)。
//        机会分来自机会地图（computeOpportunityMap）：重要性←提及广度，
//        满意度←正负比，机会分=重要性+max(重要性−满意度,0)。
//        即：一个对手越陷在"重要但大家都做得烂"的话题里，你可夺取的空间越大。
//
//   象限（按两轴中位数切分，稳健不依赖绝对值）：
//     priority   低强度 + 高机会  → 易攻的甜点，先做
//     headToHead 高强度 + 高机会  → 大 prize 但 incumbent 难啃，正面刚
//     avoid      高强度 + 低机会  → 已锁死/红海，别硬碰
//     watch      低强度 + 低机会  → 小众/暂无关，监控即可
//     unknown    机会维度样本不足 → 仅按强度归入中性区，不判避/攻（待补数据）
//
//   忠实纪律：
//     · 机会轴需 ≥3 家对手有用户声音才出；否则 opportunity=未知，
//       归入 "unknown/待补数据" 中性区（不判避/攻），并显式标 opportunityUnknown。
//     · 一切为派生展示，不落盘；分母/置信随机会地图一起透明。
// ============================================================
const Agg = require('./aggregator.js');
const OPP = require('./opportunity.js');

const TIER_RANK = { unknown: 0, niche: 1, emerging: 2, established: 3, major: 4, leader: 5 };
const QUADRANTS = ['priority', 'headToHead', 'avoid', 'watch', 'unknown'];

function median(arr) {
  const a = (arr || []).slice().sort((x, y) => x - y);
  const n = a.length;
  if (!n) return 0;
  const m = Math.floor(n / 2);
  return n % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
function round2(v) { return Math.round((v == null ? 0 : v) * 100) / 100; }

function computeQuadrant(competitors, opts) {
  opts = opts || {};
  const ex = opts.excluded instanceof Set ? opts.excluded : new Set(opts.excluded || []);
  const comps = (competitors || []).filter(c => c && c.status === 'done' && !ex.has(c.id));
  const profiles = comps.map(c => Agg.brandProfileFromComp(c)).filter(Boolean);

  // B-7b：透传市场币种（由调用方从 intent.regions 取），保持与 /api/sector 同一币种过滤口径
  const sector = Agg.buildSector({ name: opts.sectorName || 'sector', brands: profiles, marketCurrency: opts.marketCurrency });
  const oppMap = OPP.computeOpportunityMap(comps, { excluded: ex });

  // 品牌名 → 机会分暴露（仅在该对手参与的主题上累加）
  const exp = {};
  if (!oppMap.hidden && Array.isArray(oppMap.themes)) {
    for (const t of oppMap.themes) {
      const opp = Number(t.opportunity) || 0;
      (t.brands || []).forEach(bn => { exp[bn] = (exp[bn] || 0) + opp; });
    }
  }
  const maxExposure = Math.max(0, ...Object.values(exp));

  // 份额查表：profile.id → share
  const shareById = {};
  (sector.concentration && sector.concentration.shares || []).forEach(s => { shareById[s.id] = s.share; });

  const points = [];
  const entrenchVals = [];
  const oppVals = [];

  for (const p of profiles) {
    const tierVal = (TIER_RANK[p.tier && p.tier.value] != null) ? TIER_RANK[p.tier.value] : 0;
    const tierNorm = tierVal / 5;
    const share = Number(shareById[p.id] || 0); // 0..1
    const entrenchment = round2(0.6 * tierNorm + 0.4 * share);

    let opportunity = null;
    let opportunityUnknown = oppMap.hidden;
    if (!oppMap.hidden) {
      const exposure = exp[p.name] || 0;
      opportunity = round2(maxExposure > 0 ? exposure / maxExposure : 0);
      oppVals.push(opportunity);
    }
    entrenchVals.push(entrenchment);

    const themeLabels = (oppMap.hidden ? [] : (oppMap.themes || [])
      .filter(t => (t.brands || []).includes(p.name))
      .map(t => t.label)).slice(0, 12);

    points.push({
      id: p.id,
      name: p.name,
      tier: (p.tier && p.tier.value) || 'unknown',
      scale: (p.scale && Number(p.scale.value) > 0) ? Number(p.scale.value) : null,
      entrenchment,
      opportunity,
      opportunityUnknown,
      themesInvolved: themeLabels,
      quadrant: null // 稍后填
    });
  }

  const yMid = median(entrenchVals);
  // 机会轴：若隐藏则全部判为"低机会"（unknown），仅按强度分 avoid/watch
  const xMid = oppMap.hidden ? Infinity : median(oppVals);

  for (const pt of points) {
    if (pt.opportunityUnknown) {
      // 机会维度样本不足：归入中性"待补数据"区，明确不判避/攻（避免把"未知"误读成"红海/别碰"的负面结论）
      pt.quadrant = 'unknown';
    } else {
      const hiY = pt.entrenchment >= yMid;
      const hiX = pt.opportunity >= xMid;
      pt.quadrant = hiY
        ? (hiX ? 'headToHead' : 'avoid')
        : (hiX ? 'priority' : 'watch');
    }
  }

  const buckets = { priority: [], headToHead: [], avoid: [], watch: [], unknown: [] };
  for (const pt of points) if (buckets[pt.quadrant]) buckets[pt.quadrant].push(pt.id);

  return {
    brandCount: comps.length,
    points,
    quadrants: buckets,
    entrenchmentMid: round2(yMid),
    opportunityMid: oppMap.hidden ? null : round2(xMid),
    opportunity: {
      hidden: !!oppMap.hidden,
      reason: oppMap.reason || null,
      coveragePct: oppMap.coveragePct || 0,
      brandsWithVoice: oppMap.brandsWithVoice || 0,
      doneBrands: oppMap.doneBrands || 0
    },
    sector: {
      concentration: {
        hhiInterpretation: sector.concentration && sector.concentration.hhiInterpretation,
        CR3: sector.concentration ? round2(sector.concentration.CR3) : 0,
        brandCountWithScale: sector.concentration ? sector.concentration.brandCountWithScale : 0
      },
      scale: {
        total: sector.scale ? sector.scale.total : 0,
        confidence: sector.scale ? sector.scale.confidence : 'unknown'
      }
    },
    method: '竞争强度=0.6×分层等级 + 0.4×赛道规模份额；机会大小=该对手参与主题的机会分暴露（跨对手归一）。象限按两轴中位数切分。',
    note: 'Y=竞争强度（越上越难撼动）；X=机会大小（越右越值得攻）。机会轴需≥3家对手有用户声音才出，否则标 opportunityUnknown，归入"待补数据"中性区，不判避/攻。',
    quadrantsLegend: {
      priority: '低强度 + 高机会：易攻的甜点，建议优先做',
      headToHead: '高强度 + 高机会：大 prize 但 incumbent 难啃，正面刚',
      avoid: '高强度 + 低机会：已锁死/红海，别硬碰',
      watch: '低强度 + 低机会：小众或暂无关，监控即可',
      unknown: '机会维度样本不足（待补数据）：仅按强度归入中性区，不判避/攻；采到 ≥3 家对手用户声音后可解锁象限归属'
    }
  };
}

module.exports = { computeQuadrant, QUADRANTS, TIER_RANK };
