'use strict';
// ============================================================
// 蓝海要素曲线（一维 · 表达「全行业趋同处」vs「无人区」）
// ------------------------------------------------------------
// 横轴 = 某要素维度的若干固定桶（渠道 / 卖点类型 / 体量 / 价格带）；
// 纵轴 = 行业趋同度（落在该桶的对手绝对计数）。
// 高点 = 红海（大家都挤）；低点 / 零 = 蓝海空位（无人，但需结合品类判断是否真机会）。
//
// 忠实纪律（与机会地图、三态网格同构）：
//   1. 只展示绝对计数 + 占比；红/蓝着色是「相对当前数据」的分布判断，不是绝对门槛。
//   2. 覆盖不足（该维度可定位对手 < MIN_DIM_COVERAGE）时整体判为 insufficient，不画结论。
//   3. 零计数桶 = 当前无对手占；但「没人做」不等于「该做」，需结合品类判断，绝不包装成机会。
//   4. 受控词表只覆盖标准桶；桶外出现的取值（如有）作为额外桶追加，不静默丢弃。
//
// 派生产物，不落盘；每次 decorateState 实时重算，与 priceField / whitespace-grid 同构。
// 纯函数、零外部依赖，可被单测直接 require。
// ============================================================

const MIN_DIM_COVERAGE = 3;          // 某维度可定位对手 < 3 家 → 该维度判为 insufficient

// 固定受控词表（与前端 LABELS / SP_ZH / TIER_LABEL / priceBands 一一对应）
const DIMENSIONS = {
  channels: {
    label: '渠道',
    group: 'channels',
    buckets: ['amazon', 'shopifyDTC', 'tiktokShop', 'instagramShop', 'tmallJD', 'xiaohongshu', 'etsy', 'offlineRetail'],
    // 各渠道适用市场（供 inference-guard 闸B 边界过滤：目标市场与数据冲突时降级）
    markets: {
      amazon: ['global', 'US', 'EU'],
      shopifyDTC: ['global', 'US', 'EU'],
      tiktokShop: ['global', 'US', 'UK', 'SEA'],
      instagramShop: ['global', 'US', 'EU'],
      tmallJD: ['CN'],
      xiaohongshu: ['CN'],
      etsy: ['global', 'US', 'EU'],
      offlineRetail: ['global']
    },
    // 渠道类型（渠道语义 taxonomy · 2026-08-03 新增）：
    //   transaction = 交易渠道（门店/旗舰店是否在售即信号；缺席可为真空白）
    //   content     = 种草/内容平台（小红书：品牌靠 KOL/笔记/软文做声量，无官方店≠无活动；须测种草量）
    //   hybrid      = 既有官方店又有种草（TikTok Shop / Instagram Shop）
    // 用途：① 蓝海曲线对 content 渠道按"种草声量"计 occupancy（避免把种草平台误判真空位）
    //       ② inference-guard 对 content 渠道加护栏（无官店≠空白）
    types: {
      amazon: 'transaction', shopifyDTC: 'transaction', tmallJD: 'transaction',
      etsy: 'transaction', offlineRetail: 'transaction',
      xiaohongshu: 'content', tiktokShop: 'hybrid', instagramShop: 'hybrid'
    }
  },
  sellingPoints: {
    label: '卖点类型',
    group: 'sellingPoints',
    buckets: ['affordablePrice', 'premiumMaterial', 'customization', 'fastShipping', 'ecoFriendly',
      'limitedEdition', 'handmade', 'personalGift', 'localCulture', 'innovation', 'designAesthetic',
      'serviceWarranty', 'healthSafe', 'convenience', 'naturalOrganic', 'exclusive'],
    // 优化二（2026-08-03）：受控词表互斥规则。
    // 同一品牌同时被标入同一互斥组的多个桶 = 逻辑矛盾（如"平价"与"高端材质/溢价"并存），
    // 会污染红/蓝海计数。规则：冲突时按 priority 降序保留高优先级桶，低优先级桶的"净计数"剔除该品牌
    // （原始 count 仍保留，便于核验；只动 countNet）。注意：平价+优质材质有时是 legit 价值定位，
    // 故此处仅对确属价格定位矛盾的组生效，并对外暴露冲突品牌清单与重叠数，由用户肉眼复核。
    exclusivity: {
      groups: [['affordablePrice', 'premiumMaterial']],
      priority: { premiumMaterial: 2, affordablePrice: 1 }
    }
  },
  tier: {
    label: '体量',
    group: 'tier',
    buckets: ['small', 'mid', 'large', 'emerging', 'unknown']
  },
  priceBand: {
    label: '价格带',
    group: 'priceBand',
    buckets: ['mass', 'mid', 'premium', 'ultra']
  }
};

const RELATIVE_NOTE = '蓝海 / 红海着色为「相对当前数据」：按该维度内各桶的对手计数相对分布判断（≥ 半数对手同桶＝红海，零对手＝蓝海空位）；下方计数为绝对数。零计数桶＝当前无对手占，但「没人做」不等于「该做」，需结合品类判断是否真机会。';
const METHOD = '受控词表计数（渠道 present / 卖点数组 / 体量 / 价格带 band），逐桶统计落点对手数；红蓝为相对分布判断，非绝对门槛。';

// 读取单个对手在某维度上占据的桶 key 列表
function readBuckets(c, dimKey) {
  if (dimKey === 'channels') {
    const ch = (c.channels || {});
    return Object.keys(ch).filter(k => {
      const r = ch[k];
      if (!r) return false;
      if (r.present) return true;
      // content 渠道（种草平台）：无官方店但有种草声量（≠none），也算"在场上"。
      // 否则会把小红书这类平台误判成"无人区"——事实是品牌靠 KOL/笔记种草，不靠官方店。
      if (channelTypeOf(k) === 'content' && r.seedingVolume && r.seedingVolume !== 'none') return true;
      return false;
    });
  }
  if (dimKey === 'sellingPoints') return (c.sellingPoints || []).slice();
  if (dimKey === 'tier') return c.tier ? [c.tier] : [];
  if (dimKey === 'priceBand') {
    const b = c.priceBand;
    return (b && b.band) ? [b.band] : [];
  }
  return [];
}

// 主入口：从竞品档案算各维度的蓝海要素曲线。opt.minCoverage 可覆盖门槛。
function computeBlueOceanCurve(competitors, opts) {
  opts = opts || {};
  const minCov = opts.minCoverage != null ? opts.minCoverage : MIN_DIM_COVERAGE;
  const comps = (competitors || []).filter(c => c && c.status === 'done');
  const dimKeys = Object.keys(DIMENSIONS);

  // 预扫：每个维度实际出现过的全部桶值（含受控词表之外的），避免静默丢弃
  const seenByDim = {};
  dimKeys.forEach(dk => {
    const set = new Set();
    comps.forEach(c => readBuckets(c, dk).forEach(b => set.add(b)));
    seenByDim[dk] = set;
  });

  const dimensions = {};
  dimKeys.forEach(dk => {
    const def = DIMENSIONS[dk];
    const eligComps = comps.filter(c => readBuckets(c, dk).length > 0);
    const eligible = eligComps.length;

    // 优化二：受控词表互斥——仅 sellingPoints 维度启用（def.exclusivity 存在时）
    const excl = (dk === 'sellingPoints' && def.exclusivity) ? def.exclusivity : null;
    const counts = {};
    const countsNet = {};
    def.buckets.forEach(b => { counts[b] = { count: 0, competitors: [] }; countsNet[b] = { count: 0, competitors: [] }; });
    const conflictBrands = [];   // 触发互斥冲突的品牌（含冲突标签）
    const overlapByPair = {};    // "低价桶|高价桶" → 冲突品牌数
    eligComps.forEach(c => {
      const bs = readBuckets(c, dk);
      const dropNet = new Set();
      if (excl) {
        excl.groups.forEach(grp => {
          const hit = grp.filter(t => bs.includes(t));
          if (hit.length >= 2) {
            // 冲突：保留优先级最高者，其余从净计数剔除（原始 count 仍保留供核验）
            const sorted = hit.slice().sort((a, b) => (excl.priority[b] || 0) - (excl.priority[a] || 0));
            sorted.slice(1).forEach(t => dropNet.add(t));
            conflictBrands.push({ name: c.name || c.id, tags: hit.slice() });
            const pairKey = hit.slice().sort().join('|');
            overlapByPair[pairKey] = (overlapByPair[pairKey] || 0) + 1;
          }
        });
      }
      bs.forEach(b => {
        if (!counts[b]) { counts[b] = { count: 0, competitors: [] }; countsNet[b] = { count: 0, competitors: [] }; }
        counts[b].count++;
        counts[b].competitors.push(c.name || c.id);
        if (!dropNet.has(b)) { countsNet[b].count++; countsNet[b].competitors.push(c.name || c.id); }
      });
    });

    const insufficient = eligible < minCov;
    const extra = Array.from(seenByDim[dk]).filter(b => !def.buckets.includes(b));
    const orderedBuckets = def.buckets.concat(extra);

    const threshold = Math.ceil(0.5 * eligible);   // 半数对手同桶 → 红海（相对当前数据）
    const buckets = orderedBuckets.map(b => {
      const o = counts[b] || { count: 0, competitors: [] };
      const on = countsNet[b] || { count: 0, competitors: [] };
      const count = o.count;
      const countNet = on.count;
      // 状态（红/蓝/适中）基于净计数，避免互斥冲突品牌污染红海判断；原始 count 仍展示供核验
      const shareNet = eligible ? Math.round((countNet / eligible) * 100) : 0;
      const share = eligible ? Math.round((count / eligible) * 100) : 0;
      let state;
      if (insufficient) state = 'unknown';
      else if (countNet === 0) state = 'blue_gap';
      else if (countNet >= threshold) state = 'red_ocean';
      else state = 'moderate';
      return {
        key: b, count, countNet, conflict: count !== countNet,
        competitors: o.competitors.slice(0, 12), competitorsNet: on.competitors.slice(0, 12),
        share, shareNet, state
      };
    });

    const maxCount = buckets.reduce((m, b) => Math.max(m, b.countNet), 0);
    const convergenceIndex = eligible ? Math.round((maxCount / eligible) * 100) : 0;
    const redCount = buckets.filter(b => b.state === 'red_ocean').length;
    const blueCount = buckets.filter(b => b.state === 'blue_gap').length;

    const dimOut = {
      label: def.label,
      group: def.group,
      eligible,
      insufficient,
      minCoverage: minCov,
      buckets,
      convergenceIndex,
      redOceanBuckets: redCount,
      blueGapBuckets: blueCount
    };
    // 优化二：互斥冲突摘要（仅 sellingPoints 且有冲突时暴露，供报告/矩阵展示"X家被重复计算"）
    if (excl && conflictBrands.length) {
      dimOut.exclusivity = {
        conflictBrandCount: conflictBrands.length,
        conflictBrands: conflictBrands.slice(0, 20),
        overlapByPair,
        note: '以下品牌同时被标入互斥卖点组（如平价+高端材质），红/蓝海状态已按净计数（剔除低优先级标签）计算；原始计数仍保留在 count 字段，请人工复核是否为 legit 价值定位。'
      };
    }
    dimensions[dk] = dimOut;
  });

  return {
    dimensions,
    minCoverage: minCov,
    relativeNote: RELATIVE_NOTE,
    method: METHOD,
    // 始终给出诚实说明：本视图展示的是「原始趋同计数」，不是机会分 O/I/S；
    // 与机会地图一致地「绝对数照常展示 + 相对当前数据着色」。
    note: '本视图展示的是各要素桶的对手绝对计数与占比（不是机会分 O/I/S）；与机会地图一致：绝对数照常展示，红/蓝着色为相对当前数据的分布判断。'
  };
}

// 渠道类型查询（供 inference-guard / server 复用）
function channelTypeOf(bucketKey) {
  const types = (DIMENSIONS.channels && DIMENSIONS.channels.types) ? DIMENSIONS.channels.types : null;
  return (types && types[bucketKey]) || 'transaction';
}

// 优化四（2026-08-03 Tier B）：种草声量相对百分位。
// 绝对输入仍来自 LLM 估计的 high/medium/low/none（无小红书 API 拿真计数），本函数不臆造绝对数；
// 价值在于"同研究集内相对排名"——把主观 ordinal 转成可核验的组内百分位，用户可凭组内排序验证一致性。
// 返回 { competitorId: { channelKey: { ordinal, num, percentile, total, note } } }
const SEEDING_ORD = { none: 0, low: 1, medium: 2, high: 3 };
function computeSeedingPercentiles(competitors, platforms) {
  const out = {};
  // 仅 content / hybrid 渠道有"种草声量"维度（transaction 渠道以是否在售为准，不含声量）
  const chKeys = (Array.isArray(platforms) && platforms.length)
    ? platforms.filter(k => { const t = channelTypeOf(k); return t === 'content' || t === 'hybrid'; })
    : (DIMENSIONS.channels.buckets || []).filter(k => { const t = channelTypeOf(k); return t === 'content' || t === 'hybrid'; });
  // 收集每个渠道的声量分布
  const byCh = {};
  chKeys.forEach(k => { byCh[k] = []; });
  (competitors || []).forEach(c => {
    const ch = c.channels || {};
    chKeys.forEach(k => {
      const sv = ch[k] && ch[k].seedingVolume;
      if (sv && SEEDING_ORD[sv] != null) byCh[k].push({ id: c.id, ordinal: sv, num: SEEDING_ORD[sv] });
    });
  });
  chKeys.forEach(k => {
    const list = byCh[k];
    const total = list.length;
    if (!total) return;
    list.forEach(rec => {
      const below = list.filter(x => x.num < rec.num).length;
      const equal = list.filter(x => x.num === rec.num).length;
      // 百分位 = 组内"声量≤本品牌"的对手占比（标准 percentile rank，at-or-below）。
      // 直觉：none→25、low→50、medium→75、high→100（即"不低于 X% 的对手"），透明可核验。
      const pct = Math.round(((below + equal) / total) * 100);
      (out[rec.id] = out[rec.id] || {});
      out[rec.id][k] = {
        ordinal: rec.ordinal, num: rec.num, percentile: pct, total,
        note: `在 ${total} 个对手的 ${k} 种草声量中位于第 ${pct} 百分位（组内按 none<low<medium<high 排序；相对组内排名，非绝对计数）`
      };
    });
  });
  return out;
}

module.exports = { computeBlueOceanCurve, MIN_DIM_COVERAGE, DIMENSIONS, RELATIVE_NOTE, METHOD, channelTypeOf, computeSeedingPercentiles, SEEDING_ORD };
