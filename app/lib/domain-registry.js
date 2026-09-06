/**
 * domain-registry.js — 域注册表契约 v3（Phase A 承重件）
 *
 * 承重声明：系统有哪些情报域、每域评价体系长什么样、Phase 0 验收门槛、enabled 状态。
 * 架构依据：知彼 Zhibi 技术架构总纲 v3 §4（域引擎网格）。
 * 纪律：
 *  1. 每域自包含判分逻辑，不共享判分；
 *  2. 跨域数据只发生在 verdict 快照层（crossDomainRead → 只读 KG），禁止直接耦合其他域引擎；
 *  3. enabled=false 的域：L2 不产出材料，L3 配方不可消费（T4 护栏）；
 *  4. acceptance 为 Phase 0 采集验收门槛，全部达标才允许 enabled=true；
 *  5. engine 惰性加载：enabled=false 的域不加载引擎（按需 require，避免启动即耦合未落地模块）。
 *  6. 当前 Phase B 仅 price 域 enabled:true（跟价材料场景），其余域已注册但不出材料。
 */
'use strict';

/** 惰性引擎加载器：注册表保持声明式，引擎在首次调用时才 require */
function lazyEngine(relPath) {
  let mod = null;
  return function loadEngine() {
    if (!mod) mod = require(relPath);
    return mod;
  };
}

module.exports = {
  price: {
    label: '价格域',
    enabled: true, // Phase B 仅此域 true（跟价材料场景）
    evaluation: {
      sourceQuality: 'official>authorized>marketplace>llmGuess',
      weight: 'recency * tier * isOfficial',
      confidence: 'convergeOnSources', // 多源收敛：≥2 独立源→high，单源→medium，纯 LLM→low
    },
    acceptance: {
      fetchSuccessRate: 0.85, // 价格字段抓取成功率 ≥ 85%
      currencyNormalizeAccuracy: 0.95, // 币种归一化正确率 ≥ 95%
      historyRetentionRate: 0.8, // 历史价回溯完整率 ≥ 80%
    },
    engine: lazyEngine('./pricefield.js'),
    calibrationSet: 'gold-price',
    crossDomainRead: [],
  },

  voice: {
    label: '品牌声量域',
    enabled: false,
    evaluation: {
      sourceQuality: 'platformTrust * deBot * sampleSize',
      weight: 'reach * engagement * recency * platformWeight',
      confidence: 'sampleSizeThreshold', // 样本量门槛（显式化）
    },
    acceptance: {
      minSample30d: 30, // 单对手近 30 天样本 ≥ 30 条才允许 high
      lowSampleFloor: 10, // < 10 条整域 low
    },
    engine: lazyEngine('./voice-collector.js'),
    calibrationSet: 'gold-voice',
    crossDomainRead: [],
  },

  channel: {
    label: '渠道域',
    enabled: false,
    evaluation: {
      sourceQuality: 'officialStore>marketplaceBrand>aggregator>llmGuess',
      weight: 'coverage * recency * channelTrust',
      confidence: 'convergeOnSources',
    },
    acceptance: {
      sellableAccuracy: 0.9, // "有售"判定准确率 ≥ 90%（金标抽样）
    },
    engine: lazyEngine('./channelfield.js'), // 含 P0 放宽的"有售"判定
    calibrationSet: 'gold-channel',
    crossDomainRead: [],
  },

  productMatrix: {
    label: '产品矩阵域',
    enabled: false, // 依赖 channel/set/tier verdict 快照 → 必须在 Phase C（KG）后才 enable
    evaluation: {
      sourceQuality: 'officialCatalog > sitemap > marketplaceBrand > llmGuess',
      weight: 'coverage * recency * categoryCompleteness',
      confidence: 'convergeOnCoverage', // 覆盖率收敛：catalog 全量→high，partial→medium
    },
    acceptance: {
      catalogCoverage: 0.8, // 目录覆盖率 ≥ 80%（SKU 数 vs 金标全集）
    },
    engine: lazyEngine('./product-matrix.js'), // 待抽建：归总 channel+set+tier 的 verdict 快照（T3）
    calibrationSet: 'gold-product-matrix',
    crossDomainRead: ['channel', 'set', 'tier'], // 只读 verdict 快照，非原始采集数据
  },

  userReview: {
    label: '用户评价域', // 原"口碑"立正
    enabled: false,
    evaluation: {
      sourceQuality: 'verifiedPurchase > unverified > aggregator > llmSummary',
      weight: 'verified * recency * volume * platformTrust',
      confidence: 'volumeThreshold * authenticity', // 量门槛 × 真实度（防刷）
    },
    acceptance: {
      verifiedAccuracy: 0.9, // verified 标注准确率 ≥ 90%
    },
    engine: lazyEngine('./reviewfield.js'),
    calibrationSet: 'gold-review',
    crossDomainRead: [],
  },

  set: {
    label: '定位域',
    enabled: false,
    evaluation: { sourceQuality: 'official>marketplace>llmGuess', weight: 'coverage*recency', confidence: 'convergeOnCoverage' },
    acceptance: {},
    engine: lazyEngine('./setfield.js'), // categoryfield 同域
    calibrationSet: 'gold-set',
    crossDomainRead: [],
  },

  opportunity: {
    label: '机会域',
    enabled: false,
    evaluation: { sourceQuality: 'derived', weight: 'gapSize*trend', confidence: 'deriveFromInputs' },
    acceptance: {},
    engine: lazyEngine('./opportunity.js'), // blue-ocean / whitespace-grid
    calibrationSet: 'gold-opportunity',
    crossDomainRead: ['price', 'voice', 'channel'], // 纯聚合型，只读 verdict 快照
  },

  tier: {
    label: '分层域',
    enabled: false,
    evaluation: { sourceQuality: 'official>marketplace>llmGuess', weight: 'salesSignal*recency', confidence: 'convergeOnSources' },
    acceptance: {},
    engine: lazyEngine('./tiering.js'), // hero-product / sizing
    calibrationSet: 'gold-tier',
    crossDomainRead: [],
  },

  timeline: {
    label: '动作域',
    enabled: false,
    evaluation: { sourceQuality: 'derived', weight: 'recency*impact', confidence: 'deriveFromInputs' },
    acceptance: {},
    engine: lazyEngine('./timeline.js'), // trend
    calibrationSet: 'gold-timeline',
    crossDomainRead: [],
  },

  sector: {
    label: '赛道域',
    enabled: false,
    evaluation: { sourceQuality: 'derived', weight: 'whitespaceSize*velocity', confidence: 'deriveFromInputs' },
    acceptance: {},
    engine: lazyEngine('./sector-whitespace.js'), // quadrant / radar
    calibrationSet: 'gold-sector',
    crossDomainRead: ['productMatrix', 'voice', 'opportunity'],
  },
};

/** 工具：返回当前可产出材料的域（enabled === true） */
module.exports.enabledDomains = function enabledDomains() {
  return Object.entries(module.exports)
    .filter(([name, d]) => d && typeof d === 'object' && d.enabled === true && d.engine)
    .map(([name]) => name);
};

/** 工具：校验跨域只读契约 —— 聚合型引擎只能读已注册域的 verdict 快照 */
module.exports.validateCrossDomainRead = function validateCrossDomainRead() {
  const violations = [];
  for (const [name, d] of Object.entries(module.exports)) {
    if (!d || typeof d !== 'object' || !Array.isArray(d.crossDomainRead)) continue;
    for (const dep of d.crossDomainRead) {
      if (!module.exports[dep]) violations.push(`${name}.crossDomainRead 引用未注册域: ${dep}`);
    }
  }
  return violations;
};
