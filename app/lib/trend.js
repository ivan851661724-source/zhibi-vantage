'use strict';
// ============================================================
// 优化三（2026-08-03 Tier B）：时间趋势维度
// ------------------------------------------------------------
// 此前红蓝海纯截面（无 foundedYear/growth 采集），无法区分"红海风口"(增长+拥挤)
// vs "夕阳赛道"(下滑+稀疏)。本模块从各对手的 growth（LLM 推算增长态势）与
// foundedYear 汇总出赛道级冷热视图。
//
// 忠实纪律（与推理纪律 v2 一致）：
//   - 数据缺失（growth=unknown 占多数或未采集）→ 标"趋势未知"，绝不臆造冷热。
//   - growth 是 LLM 推算的态势判断，非精确指标；本视图只做"样本层面聚合"，
//     不把它当硬事实渲染。
//
// 纯函数、零外部依赖，可被单测直接 require。
// ============================================================

const GROWTH_VALUES = ['rising', 'stable', 'declining', 'unknown'];

function growthDistribution(competitors) {
  const dist = { rising: 0, stable: 0, declining: 0, unknown: 0 };
  let withSignal = 0;
  (competitors || []).forEach(c => {
    const g = (c && c.growth) || 'unknown';
    if (!GROWTH_VALUES.includes(g)) { dist.unknown++; return; }
    dist[g]++;
    if (g !== 'unknown') withSignal++;
  });
  return { dist, total: (competitors || []).length, withSignal };
}

function median(arr) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

// 趋势检验点（红线⑤·趋势可证伪）：每条趋势结论必带一个可被现实反驳/证实的
// 观测点（含时间窗）。结构派生=medium；类比派生=low（明确标注「类比外推，置信低」）。
function trendCheckpoint(label, dist, withSignal) {
  if (label.indexOf('风口') !== -1) {
    return {
      horizonDays: 90,
      falsifiable: true,
      test: `未来 90 天内，样本中 rising 品牌净增 ≥1 且出现 ≥1 条 launch/expansion 事件 → 证实升温；若 rising 转 stable/declining 或新进入停滞 → 证伪。`,
      basis: 'structure'
    };
  }
  if (label.indexOf('趋冷') !== -1) {
    return {
      horizonDays: 90,
      falsifiable: true,
      test: `未来 90 天内 declining 品牌数继续增加或出现 contraction 事件 → 证实趋冷；若 declining 转 stable/rising → 证伪。`,
      basis: 'structure'
    };
  }
  if (label === '平稳') {
    return {
      horizonDays: 90,
      falsifiable: true,
      test: `未来 90 天分布波动 <1 家 → 维持平稳；波动 ≥2 家 → 证伪「平稳」假设。`,
      basis: 'structure'
    };
  }
  return { horizonDays: null, falsifiable: false, test: '', basis: 'structure' };
}

// 赛道级冷热视图：区分"红海风口" vs "夕阳赛道"，fail-safe 标"趋势未知"
function computeTrendView(competitors) {
  const { dist, total, withSignal } = growthDistribution(competitors);
  const foundedYears = (competitors || []).map(c => c && c.foundedYear).filter(n => typeof n === 'number');
  // fail-safe：无有效增长信号 → 趋势未知，不臆造
  if (total === 0 || withSignal === 0) {
    return {
      label: '趋势未知',
      hotScore: null,
      distribution: dist,
      total, withSignal,
      foundedYears,
      foundedMedian: foundedYears.length ? median(foundedYears) : null,
      failSafe: true,
      confidence: 'unknown',
      checkpoint: { horizonDays: null, falsifiable: false, test: '', basis: 'structure' },
      note: '样本无增长态势信号（growth=unknown 占多数或未采集），无法判断赛道冷热；不臆造冷热结论，请补充来源或人工研判。'
    };
  }
  // hotScore ∈ [-1,1]：上升 − 下滑（样本内），正=升温、负=趋冷
  const hotScore = Math.round(((dist.rising - dist.declining) / withSignal) * 100) / 100;
  let label, note;
  if (dist.rising >= dist.declining && (dist.rising / withSignal) >= 0.34) {
    label = '风口升温（红海风口预警）';
    note = `赛道处于上升期：${dist.rising} 家扩张/声量上升 vs ${dist.declining} 家收缩。拥挤+升温=红海风口，进入须有差异化；空白桶在此环境下可能是真窗口，也可能是伪窗口，须结合供需交叉验证。`;
  } else if (dist.declining > dist.rising && (dist.declining / withSignal) >= 0.34) {
    label = '赛道趋冷（夕阳预警）';
    note = `赛道处于下行期：${dist.declining} 家收缩/声量下滑 vs ${dist.rising} 家上升。空白桶可能是真无人区（需求也在退），也可能是撤离后的暂时真空，须核验需求侧是否仍在。`;
  } else {
    label = '平稳';
    note = `赛道格局平稳：${dist.rising} 上升 / ${dist.stable} 平稳 / ${dist.declining} 下滑。无明显冷热信号。`;
  }
  return {
    label, hotScore, distribution: dist, total, withSignal,
    foundedYears, foundedMedian: foundedYears.length ? median(foundedYears) : null,
    failSafe: false,
    confidence: 'medium',                       // 结构派生（样本聚合），medium
    checkpoint: trendCheckpoint(label, dist, withSignal),  // 红线⑤：必有检验点
    note
  };
}

// ---------------------------------------------------------------------------
// 趋势推断集合（每条必带检验点 + 推断依据标注）
// 返回：[{ claim, basis, confidence, checkpoint, falsifiable }]
//   basis='structure' → confidence medium；basis='analogy' → confidence low。
// ---------------------------------------------------------------------------
function buildTrendInferences(competitors) {
  const comps = (competitors || []).filter(Boolean);
  const view = computeTrendView(comps);
  const out = [];

  // 1) 结构派生（medium）：来自样本级冷热分布本身。
  if (!view.failSafe) {
    out.push({
      claim: '赛道层面：' + view.label + (view.hotScore != null ? '（hotScore=' + view.hotScore + '）' : ''),
      basis: 'structure',
      confidence: 'medium',
      checkpoint: view.checkpoint,
      falsifiable: view.checkpoint.falsifiable
    });
  }

  // 2) 类比派生（low）：以体量最大者为「领头羊」，推断其动作向 sector 扩散。
  //    明确标注「类比外推，置信低」，并给可证伪观测点。
  const withScale = comps
    .map(c => ({ c, scale: Number((c.scale && c.scale.value) || 0) }))
    .filter(x => x.scale > 0)
    .sort((a, b) => b.scale - a.scale);
  if (withScale.length >= 2) {
    const leader = withScale[0].c;
    const leaderName = leader.name || '头部品牌';
    out.push({
      claim: '类比外推：' + leaderName + ' 的渠道/上新节奏可能被 mid 梯队跟随，赛道集中度或进一步上升。',
      basis: 'analogy',
      confidence: 'low',                  // 类比派生 → 低置信
      checkpoint: {
        horizonDays: 180,
        falsifiable: true,
        test: `未来 180 天内，观察 mid 梯队（规模居中者）是否复制 ${leaderName} 的渠道/上新动作；若出现 ≥1 家跟随 → 类比成立；若无跟随 → 证伪。`,
        basis: 'analogy'
      },
      falsifiable: true,
      note: '类比外推，非样本直接观测；置信 low，仅作前瞻线索，不可当结论。'
    });
  }

  // 3) fail-safe 时仍给一条「不可推断」声明（诚实）。
  if (view.failSafe) {
    out.push({
      claim: '趋势不可推断：样本增长信号不足，无法给出冷热结论或检验点。',
      basis: 'structure',
      confidence: 'unknown',
      checkpoint: { horizonDays: null, falsifiable: false, test: '', basis: 'structure' },
      falsifiable: false
    });
  }
  return out;
}

module.exports = { computeTrendView, buildTrendInferences, trendCheckpoint, growthDistribution, GROWTH_VALUES };
