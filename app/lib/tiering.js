'use strict';
// =============================================================================
// 分层器 (tiering.js) — 推理·分析合并计算层 · 算子 ①
// 文档 v0.5 · 第二部分 · 2.6 施工顺序第 1 条
//
// 职责：把「体量信号」确定性地归并为 大(large)/中(mid)/小(small)，并给出可复现的依据。
//
// 设计铁律（红线 2）：**确定性函数** —— 同输入恒同输出，无任何随机 / 时间 /
// 网络依赖。分层结果只由输入信号决定，可被回归测试逐字节复现。
//
// 信号优先级（降序，文档原文）：
//   官方营收  >  流量档位  >  团队规模  >  社媒/融资
// 含义：当多个信号同时存在时，最高优先级的「可决断」信号说了算；它若缺席或
// 不足以定档，才降级到下一优先级。社媒/融资是最弱信号，单独存在时**永不得**
// 判定为 large（避免把「网红店」误判成「大公司」）。
//
// 与现有档案模型的关系：当前 comp 记录里只有 LLM 口述的 estSize(文本) 与
// tier(枚举)，尚无结构化的 officialRevenue/trafficTier/teamSize/socialFollowers/
// funding 字段。本模块暴露两个入口：
//   1) classifyTier(signals) —— 纯函数核心，消费干净信号对象（测试主战场）。
//   2) signalsFromComp(comp) —— 桥接适配器：尽力从现有 comp 抽取权威信号；
//      若完全缺失，才退而解析 estSize 文本作为「估算」代理，并在依据里显式
//      标注 estimatedFromText，绝不把 LLM 口述伪装成官方披露。
// 一旦抽取层（server.js 报告装配）补上结构化体量字段，signalsFromComp 自动
// 优先采用真实信号，无需改动 classifier。
// =============================================================================

// ---- 信号优先级（降序） ------------------------------------------------
const TIER_PRIORITY = ['officialRevenue', 'trafficTier', 'teamSize', 'socialFunding'];

// ---- 阈值表（确定性数据，无魔法散落） ----------------------------------
// 官方披露年化营收（USD）。区间：≥50M→large，≥5M→mid，>0→small。
const REVENUE_BANDS = [
  { min: 50_000_000, tier: 'large' },
  { min: 5_000_000, tier: 'mid' },
  { min: 1, tier: 'small' }
];
// 团队规模（员工数）。≥200→large，≥20→mid，>0→small。
const TEAM_BANDS = [
  { min: 200, tier: 'large' },
  { min: 20, tier: 'mid' },
  { min: 1, tier: 'small' }
];
// 流量档位（Similarweb 类）直接映射。
const TRAFFIC_MAP = { high: 'large', mid: 'mid', low: 'small' };
// 社媒/融资：最弱信号，单独存在不得定为 large。
function socialFundingTier(s) {
  const followers = Number(s && s.socialFollowers) || 0;
  const funded = s && s.funding === 'funded';
  if (funded && followers >= 100_000) return 'mid';
  if (followers >= 1_000_000) return 'mid';
  if (followers >= 10_000) return 'small';
  return null; // 不足以定档
}

// 标准空信号对象（构造用，便于调用方按需填值）。
function emptySignals() {
  return {
    officialRevenue: null,   // 官方披露年化营收 (USD number)
    trafficTier: null,       // 'high'|'mid'|'low'|'none'
    teamSize: null,          // 员工数
    socialFollowers: null,   // 社媒粉丝总数
    funding: null            // 'funded'|'bootstrapped'|'unknown'
  };
}

// 把单个权威信号映射到档位（返回 tier 或 null）。
function signalToTier(key, value) {
  if (key === 'officialRevenue') {
    const n = Number(value);
    if (!(n > 0)) return null;
    for (const b of REVENUE_BANDS) if (n >= b.min) return b.tier;
    return null;
  }
  if (key === 'trafficTier') {
    return TRAFFIC_MAP[value] || null;
  }
  if (key === 'teamSize') {
    const n = Number(value);
    if (!(n > 0)) return null;
    for (const b of TEAM_BANDS) if (n >= b.min) return b.tier;
    return null;
  }
  if (key === 'socialFunding') {
    return socialFundingTier(value);
  }
  return null;
}

// 人类可读的来源描述。
function signalLabel(key, value) {
  if (key === 'officialRevenue') return '官方披露营收 $' + Number(value).toLocaleString('en-US');
  if (key === 'trafficTier') return '流量档位=' + value;
  if (key === 'teamSize') return '团队规模=' + value + ' 人';
  if (key === 'socialFunding') {
    const f = Number(value && value.socialFollowers) || 0;
    return '社媒粉丝=' + f.toLocaleString('en-US') + '，融资=' + (value && value.funding || 'unknown');
  }
  return key;
}

// =============================================================================
// 核心：classifyTier(signals)
// 输入：干净信号对象（见 emptySignals）。
// 输出：{ tier, basis }，tier ∈ large|mid|small|unknown，basis 含可复现依据。
// 纯函数：无 IO、无随机、无时钟读取。
// =============================================================================
function classifyTier(signals) {
  const s = Object.assign(emptySignals(), signals || {});

  // 1) 收集「存在的」信号（按优先级降序）。
  const present = [];
  if (Number(s.officialRevenue) > 0) present.push('officialRevenue');
  if (s.trafficTier && TRAFFIC_MAP[s.trafficTier]) present.push('trafficTier');
  if (Number(s.teamSize) > 0) present.push('teamSize');
  const sfTier = socialFundingTier(s);
  if (sfTier) present.push('socialFunding');

  // 2) 沿优先级取首个「可决断」信号。
  let used = null, usedValue = null, usedTier = null;
  for (const key of TIER_PRIORITY) {
    if (present.indexOf(key) === -1) continue;
    const v = key === 'socialFunding' ? s : s[key];
    const t = signalToTier(key, v);
    if (t) { used = key; usedValue = v; usedTier = t; break; }
  }

  const basis = {
    used: used,
    usedValue: used === 'socialFunding' ? { socialFollowers: s.socialFollowers, funding: s.funding } : usedValue,
    available: present.slice(),     // 所有存在的信号（含未被采用的低优先级）
    flags: [],
    reason: ''
  };

  if (!used) {
    basis.reason = '无权威体量信号可决断（官方营收/流量/团队/社媒融资均缺失或不足），分层置为 unknown，不臆测。';
    return { tier: 'unknown', basis };
  }

  // 3) 矛盾检测：被采用的信号之外，是否存在指向「更极端档位」的同级/低优先级信号。
  //    仅作标注（flags），不改变采用结果——优先级规则必须稳定可复现。
  const RANK = { large: 3, mid: 2, small: 1, unknown: 0 };
  for (const key of present) {
    if (key === used) continue;
    const v = key === 'socialFunding' ? s : s[key];
    const t = signalToTier(key, v);
    if (!t) continue;
    if (RANK[t] - RANK[usedTier] >= 2) {
      basis.flags.push('低优先级信号 ' + signalLabel(key, v) + ' 指向 ' + t + '，与采用信号(' + used + '→' + usedTier + ') 冲突；按优先级规则仍以 ' + used + ' 为准。');
    }
  }

  basis.reason = '采用最高优先级可决断信号：' + signalLabel(used, used === 'socialFunding' ? s : s[used]) +
    ' → ' + usedTier + '。（优先级：' + TIER_PRIORITY.join(' > ') + '）';
  return { tier: usedTier, basis };
}

// 档位排序权重（large>mid>small>unknown），供聚合器比较/分箱。
function tierRank(tier) {
  return ({ large: 3, mid: 2, small: 1, unknown: 0 })[tier] != null ? ({ large: 3, mid: 2, small: 1, unknown: 0 })[tier] : 0;
}

// =============================================================================
// 桥接：signalsFromComp(comp)
// 从现有档案记录尽力抽取结构化信号。现有模型只有 estSize(文本)/tier(枚举)，
// 故绝大多数字段会留空 → classifyTier 诚实返回 unknown；一旦抽取层补上真实
// 字段（officialRevenue/trafficTier/teamSize/socialFollowers/funding），自动优先。
// 仅在「无任何权威信号」时，解析 estSize 文本作为估算代理，并标注 estimatedFromText。
// =============================================================================
function signalsFromComp(comp) {
  const s = emptySignals();
  if (!comp || typeof comp !== 'object') return s;

  // —— 优先采用真实结构化字段（若抽取层已补） ——
  if (Number(comp.officialRevenue) > 0) s.officialRevenue = Number(comp.officialRevenue);
  if (comp.trafficTier && TRAFFIC_MAP[comp.trafficTier]) s.trafficTier = comp.trafficTier;
  if (Number(comp.teamSize) > 0) s.teamSize = Number(comp.teamSize);
  if (Number(comp.socialFollowers) > 0) s.socialFollowers = Number(comp.socialFollowers);
  if (comp.funding && ['funded', 'bootstrapped', 'unknown'].includes(comp.funding)) s.funding = comp.funding;

  // 已经有任一权威信号 → 直接返回，不做文本猜测。
  const hasAuth = s.officialRevenue || s.trafficTier || s.teamSize || s.socialFollowers || s.funding !== null && s.funding !== undefined && s.funding !== '';
  if (s.officialRevenue || s.trafficTier || s.teamSize || s.socialFollowers || (s.funding && s.funding !== 'unknown')) {
    s._estimatedFromText = false;
    return s;
  }

  // —— 退路：解析 estSize 文本（LLM 口述，仅作估算代理） ——
  const est = comp.estSize && (typeof comp.estSize === 'string' ? comp.estSize : comp.estSize.value);
  if (est && typeof est === 'string') {
    const parsed = parseEstSize(est);
    if (parsed) {
      if (parsed.kind === 'revenue') s.officialRevenue = parsed.value; // 标注为估算，非官方
      else if (parsed.kind === 'team') s.teamSize = parsed.value;
      s._estimatedFromText = true;
      s._estimatedNote = 'estSize 文本解析为估算代理（' + parsed.kind + '≈' + parsed.value + '），非官方披露，置信应降级。';
    }
  }
  return s;
}

// 极简 estSize 解析：识别「营收型」($/ARR/revenue/sales) 或「团队型」(employees/people/team)。
// 返回 { kind, value(USD 或 人数) } 或 null。只取首个量级，不臆造区间。
function parseEstSize(text) {
  const t = String(text).toLowerCase();
  const num = (str) => {
    const m = str.match(/([\d.]+)\s*([kmb])?/);
    if (!m) return null;
    let n = parseFloat(m[1]);
    if (m[2] === 'k') n *= 1e3;
    else if (m[2] === 'm') n *= 1e6;
    else if (m[2] === 'b') n *= 1e9;
    return n;
  };
  const isRevenue = /\$|\barr\b|\brevenue\b|\bsales\b|\bturnover\b/.test(t);
  const isTeam = /employees?|people|staff|team|heads|\bppl\b|\bheadcount\b/.test(t);
  const firstNum = num(t);
  if (firstNum == null) return null;
  if (isRevenue) return { kind: 'revenue', value: firstNum };
  if (isTeam) return { kind: 'team', value: Math.round(firstNum) };
  // 无上下文：默认按团队量级（DTC 口述规模多为人数）。
  return { kind: 'team', value: Math.round(firstNum) };
}

module.exports = {
  TIER_PRIORITY,
  emptySignals,
  classifyTier,
  tierRank,
  signalsFromComp,
  parseEstSize,
  signalToTier
};
