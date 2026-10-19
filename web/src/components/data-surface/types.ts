'use client';
// 数据面共享类型（对齐 GET /api/data-surface/overview|dimension 响应，SC-02 §8）
// 2026-10-18 整改轮：summary 判别联合（可扩展摘要协议）+ currency 贯通 +
// latestAttempt / latestUsable / isRefreshing 状态三拆 + 多 Evidence 引用。
export type SurfaceState = 'ok' | 'loading' | 'failed' | 'empty' | 'partial' | 'stale' | 'unsupported' | 'pending_config';

// ---------- 摘要判别联合（SC-02 §4 整改：禁止跨维度共用固定模板） ----------
export interface StorefrontCatalogSummary {
  kind: 'storefront_catalog';
  count: number;
  onSaleCount: number;
  soldOutCount: number;
  priceMin: number | null;
  priceMax: number | null;
  priceMedian: number | null;
  currency: string | null;
  /** confirmed = 有可追溯币种快照；unknown = 无依据，前端必须显示「币种待确认」 */
  currencyStatus: 'confirmed' | 'unknown';
  partialScan: boolean;
}
export interface StorefrontCollectionsSummary {
  kind: 'storefront_collections';
  collectionCount: number;
  collections: { title: string; handle: string }[];
  /** 截断诚实口径（SC-02 复审 §三.4） */
  sourceObservedCount: number;
  storedCount: number;
  partialScan: boolean;
  partialScanReason: string | null;
}
// ---------- Wave 1：四个新维度各自的摘要形状（不复用 Shopify 价格卡模板） ----------
/** 社媒内容：公开视频观察（measurementMethod=public_source_observation） */
export interface SocialVideosSummary {
  kind: 'social_videos';
  videoCount: number;
  channelTitle: string | null;
  channelId: string | null;
  matchReasons: string[];
  measurementMethod: 'public_source_observation';
  periodStart: string | null;
  periodEnd: string | null;
  comments: { text: string; videoId: string | null; sourceUrl: string | null }[];
  partialScan: boolean;
  partialScanReason?: string | null;
}
/** 搜索与热度：数据服务估算趋势点（measurementMethod=licensed_estimate） */
export interface TrendSeriesSummary {
  kind: 'trend_series';
  pointCount: number;
  keyword: string | null;
  region: string | null;
  measurementMethod: 'licensed_estimate';
  periodStart: string | null;
  periodEnd: string | null;
  providerRecordId: string | null;
  methodologyVersion: string | null;
  partialScan: boolean;
  partialScanReason?: string | null;
}
/** 广告活动：平台公开披露（official_disclosure；花费/ROI/转化率/GMV 不可观测；覆盖范围受官方支持国家限制） */
export interface AdCreativesSummary {
  kind: 'ad_creatives';
  creativeCount: number;
  measurementMethod: 'official_disclosure';
  periodStart: string | null;
  periodEnd: string | null;
  countryScope?: string | null;
  coverageNote?: string | null;
  providerRecordId: string | null;
  methodologyVersion: string | null;
  partialScan: boolean;
  partialScanReason?: string | null;
}
/** 口碑与评论：公开页面评论摘要（样本量/时间范围/来源数必须明示） */
export interface ReviewsDigestSummary {
  kind: 'reviews_digest';
  reviewCount: number;
  sourceCount: number;
  measurementMethod: 'public_source_observation';
  periodStart: string | null;
  periodEnd: string | null;
  methodologyVersion: string | null;
  sampleNote: string | null;
  partialScan: boolean;
  partialScanReason?: string | null;
}
/** 未来新维度的摘要形状在此扩展；前端对未知 kind 走通用键值渲染（不假装看得懂） */
export type SurfaceSummary =
  | StorefrontCatalogSummary
  | StorefrontCollectionsSummary
  | SocialVideosSummary
  | TrendSeriesSummary
  | AdCreativesSummary
  | ReviewsDigestSummary
  | { kind: string; [key: string]: unknown };

export interface SurfaceEvidenceRef {
  evidenceId: string | null;
  snapshotId: string | null;
  sourceUrl: string | null;
}

export interface SurfaceGap {
  code: string;
  text?: string;
  /** 多能力聚合时标识缺口归属（website_products = catalog + collections） */
  capability?: string;
}

export interface SurfaceCapability {
  code: string;
  displayName: string;
  dimension: string;
  supportedObjects: { objectTypes: string[]; platforms: string[]; markets: string | Record<string, unknown> };
  manualRefresh: boolean;
  autoInspect: boolean;
  freshnessSlaHours: number | null;
  maturity: string;
  limitations: string;
  refreshPolicy: { cooldownMinutes: number; dailyQuota: number | null };
  /** Wave 1：凭据要求（产品面声明）与测量方法标签 */
  configKeys?: string[] | null;
  measurementMethod?: string | null;
}

/** attempt 用户可视图（剔除内部字段） */
export interface SurfaceAttemptView {
  attemptId: string;
  status: 'running' | 'success' | 'partial' | 'failed';
  sourceStatus: string | null;
  errorText: string | null;
  observationCount: number;
  startedAt: string;
  endedAt: string | null;
}

/** 单能力聚合块（dimension → capabilities[] → adapters[] 的投影元素） */
export interface SurfaceCapabilityBlock {
  capability: SurfaceCapability;
  surfaceState: SurfaceState;
  reasonText?: string | null;
  lastSuccessAt?: string | null;
  lastAttemptAt?: string | null;
  freshness?: { status: string; slaHours: number | null; lastSuccessAt: string | null };
  summary?: SurfaceSummary | null;
  coverage?: { attempted?: number; partial?: boolean; sourceStatus?: string | null; observationCount?: number };
  isRefreshing?: boolean;
  latestAttempt?: SurfaceAttemptView | null;
  gaps?: SurfaceGap[];
  actions?: { code: string; label: string; capability?: string }[];
  evidenceRefs?: SurfaceEvidenceRef[];
  pagination?: { total: number };
}

/** 观察行：价格字段对非商品维度恒 null；Wave 1 各维度扩展字段可选 */
export interface SurfaceObservation {
  id: string | null;
  title: string;
  price: number | null;
  currency: string | null;
  available: boolean;
  publishedAt: string | null;
  // social_videos
  viewCount?: number | null;
  likeCount?: number | null;
  commentCount?: number | null;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  // trend_series
  value?: number | null;
  region?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  // ad_creatives
  advertiser?: string | null;
  creativeUrl?: string | null;
  reach?: number | null;
  // reviews_digest
  rating?: number | null;
  reviewCount?: number | null;
  snippet?: string | null;
  sourceUrl?: string | null;
}

export interface SurfaceDimension {
  code: string;
  displayName: string;
  /** 兼容旧单块字段（首能力）；新前端优先读 aggregations[] */
  capability: SurfaceCapability | null;
  capabilityView?: SurfaceCapability | null;
  surfaceState: SurfaceState;
  reasonText?: string | null;
  lastSuccessAt?: string | null;
  lastAttemptAt?: string | null;
  freshness?: { status: string; slaHours: number | null; lastSuccessAt: string | null };
  summary?: SurfaceSummary | null;
  coverage?: { attempted?: number; partial?: boolean; sourceStatus?: string | null; observationCount?: number };
  isRefreshing?: boolean;
  latestAttempt?: SurfaceAttemptView | null;
  gaps?: SurfaceGap[];
  actions?: { code: string; label: string; capability?: string }[];
  evidenceRefs?: SurfaceEvidenceRef[];
  /** 多能力聚合（同维度并行）；未接入维度为空数组 */
  aggregations?: SurfaceCapabilityBlock[];
  pagination?: { total: number };
}

export interface SurfaceIdentity {
  platform: string;
  platformAccountId: string | null;
  officialDomain: string | null;
  identityStatus: string;
  originNote: string | null;
  resolverVersion: string | null;
  updatedAt: string;
}

export interface DataSurfaceOverview {
  competitorId: string;
  identity?: {
    officialDomain: string | null;
    identityStatus: string;
    originNote: string | null;
    resolverVersion: string | null;
    updatedAt: string;
  } | null;
  /** 同平台多账号身份（整改 §二.7） */
  identities?: SurfaceIdentity[];
  dimensions: SurfaceDimension[];
  generatedAt: string;
}

/** 明细维度中的单 capability 视图 */
export interface DimensionCapabilityDetail {
  capability: SurfaceCapability;
  capabilityCode: string;
  surfaceState: SurfaceState;
  isRefreshing?: boolean;
  latestAttempt?: SurfaceAttemptView | null;
  attemptId: string | null;
  collectedAt: string | null;
  summary: SurfaceSummary | null;
  observations: SurfaceObservation[];
  pagination: { offset: number; limit: number; total: number; hasMore: boolean };
  evidenceRefs: SurfaceEvidenceRef[];
  gaps: SurfaceGap[];
  interrupted?: boolean;
}

export interface DimensionDetail {
  dimension: string;
  dimensionUnsupported?: boolean;
  surfaceState: SurfaceState;
  /** 聚合各 capability 真实 isRefreshing（复审 §八.8） */
  isRefreshing?: boolean;
  capabilities: DimensionCapabilityDetail[];
  capability: SurfaceCapability | null;
  /** 顶层 observations/pagination 所属 capability（分页契约：每 capability 独立分页，
   *  顶层返回当前 active capability 的当前页，≤ limit） */
  activeCapability?: string | null;
  attemptId: string | null;
  collectedAt: string | null;
  summary: SurfaceSummary | null;
  observations: SurfaceObservation[];
  pagination: { offset: number; limit: number; total: number; hasMore: boolean };
  evidenceRefs: SurfaceEvidenceRef[];
}

/** 刷新策略（capability 级 cooldown + 日额度） */
export interface RefreshPolicy {
  capability: string;
  manualRefresh: boolean;
  cooldownMinutes: number;
  cooldownRemainingSec: number;
  dailyQuota: number | null;
  dailyUsed: number;
  dailyRemaining: number | null;
}
