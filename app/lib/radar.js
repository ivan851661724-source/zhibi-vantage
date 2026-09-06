// lib/radar.js
// ============================================================
// 雷达变化检测 + 群体异动（PRD v2.1 · S1-②）
// ------------------------------------------------------------
// 每对手"最近动作"(recentActions)：
//   - 实抓 recentMoves（basis=verified → 准），取最近一条作为主动作；
//   - 无 recentMoves 时从 launchCadence / 口碑趋势 派生（→ 推，带推理逻辑）；
//   - 两者皆无 → hasAction=false（前端留白，不编造）。
// 群体异动(groupSignals)：
//   - 跨对手同类型动作聚簇（如 ≥N 家同时降价/上新/开渠道/联名）→ 战略信号条（最多 3 条）。
//   - 专门识别"头部 N 家同时降价"= 价格战信号。
// 数据来源：recentMoves（已采集动作流）+ launchCadence + reviewField.trend。
// 说明：当前未建立逐日价格快照存储，价格变动以 recentMoves 中 price 类动作为准；
//       若未来接入价格快照 diff，可在 computeRecentActions 内补充 vs 昨日基线。
// ============================================================

const TYPE_LABEL = {
  launch: '上新', channel: '开新渠道', price: '调价', collab: '联名/合作', other: '动作', 其他: '动作'
};
const GROUP_LABEL = {
  price: '价格战信号', launch: '集体上新潮', channel: '集体扩渠道', collab: '集体联名潮', other: '赛道动作集中'
};

// 把 when 转成可排序数值（"持续进行"/null → 0；年份/相对时间 → 近似）
function whenRank(when) {
  if (!when) return 0;
  const s = String(when);
  const yr = s.match(/(20\d{2})/);
  if (yr) return parseInt(yr[1], 10);
  if (/持续|进行|ongoing|always/i.test(s)) return 0.5;
  if (/近期|最近|recent|本月|本月|this\s*month/i.test(s)) return 2026.5;
  if (/2025/.test(s)) return 2025;
  return 0;
}

// 单对手最近动作
function computeRecentActions(competitor) {
  const c = competitor || {};
  const base = { competitorId: c.id || null, competitorName: c.name || '' };
  const moves = Array.isArray(c.recentMoves) ? c.recentMoves : [];

  if (moves.length) {
    const sorted = [...moves].sort((a, b) => whenRank(b.when) - whenRank(a.when));
    const m = sorted[0];
    return Object.assign(base, {
      hasAction: true,
      kind: 'verified',                       // 准：实抓 recentMoves
      action: {
        type: m.type || 'other',
        label: TYPE_LABEL[m.type] || '动作',
        desc: m.desc || '',
        when: m.when || null,
        basis: m.basis || 'inferred'
      },
      all: moves.map(x => ({
        type: x.type || 'other',
        label: TYPE_LABEL[x.type] || '动作',
        desc: x.desc || '',
        when: x.when || null,
        basis: x.basis || 'inferred'
      }))
    });
  }

  // 无 recentMoves → 派生信号（推）
  const lc = c.launchCadence || {};
  const rf = c.reviewField || {};
  const trend = (rf.trend && rf.trend.value) || null;
  if (lc.value && lc.value !== 'unknown') {
    return Object.assign(base, {
      hasAction: true, kind: 'inferred',
      action: { type: 'launch', label: '上新节奏', desc: `上新节奏：${lc.value}`, when: null, basis: lc.basis || 'inferred' },
      all: []
    });
  }
  if (trend && trend !== 'unknown') {
    return Object.assign(base, {
      hasAction: true, kind: 'inferred',
      action: { type: 'other', label: '口碑动向', desc: `口碑趋势：${trend}`, when: null, basis: 'inferred' },
      all: []
    });
  }
  return Object.assign(base, { hasAction: false, kind: 'none', action: null, all: [] });
}

// 跨对手群体异动
function computeGroupSignals(competitors, opts) {
  const list = (competitors || []).filter(c => c && !(opts && opts.excluded && opts.excluded.includes(c.id)));
  const byType = {};
  list.forEach(c => {
    const acts = Array.isArray(c.recentMoves) ? c.recentMoves : [];
    acts.forEach(m => {
      const t = m.type || 'other';
      byType[t] = byType[t] || [];
      byType[t].push({ competitorId: c.id, name: c.name, desc: m.desc || '', when: m.when || null });
    });
  });

  const TH = (opts && opts.threshold) || 2;
  const signals = [];
  Object.keys(byType).forEach(t => {
    const arr = byType[t];
    if (arr.length >= TH) {
      signals.push({
        type: t,
        label: GROUP_LABEL[t] || `${t}动作集中`,
        count: arr.length,
        competitors: arr.map(x => x.name),
        note: `${arr.length} 家同时出现「${TYPE_LABEL[t] || t}」类动作，可能反映赛道级趋势`,
        kind: 'verified'            // 群体异动由实抓 recentMoves 聚簇，属准
      });
    }
  });
  // 价格战优先置顶
  signals.sort((a, b) => {
    if (a.type === 'price' && b.type !== 'price') return -1;
    if (b.type === 'price' && a.type !== 'price') return 1;
    return b.count - a.count;
  });
  return signals.slice(0, 3);
}

// 汇总（decorateState 用）
function computeRadar(competitors, opts) {
  const perCompetitor = {};
  (competitors || []).forEach(c => {
    const r = computeRecentActions(c);
    if (r.competitorId) perCompetitor[r.competitorId] = r;
  });
  return {
    perCompetitor,
    groupSignals: computeGroupSignals(competitors, opts)
  };
}

module.exports = { computeRecentActions, computeGroupSignals, computeRadar, whenRank, TYPE_LABEL, GROUP_LABEL };
