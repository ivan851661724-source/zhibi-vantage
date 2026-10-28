// 核心产品主闭环（SC-04）前端契约与请求封装
// 只暴露用户可见字段：不含服务器路径、内部错误码、栈、密钥、原始 payload 路径。
import { apiGet, apiPatch, apiPost } from '@/lib/api';

// SC-06 r2：pending_verification = 能力已实现但尚无真实成功采集（不得显示「已采集」）
export type CoverState = 'ok' | 'partial' | 'empty' | 'stale' | 'loading' | 'failed' | 'unsupported' | 'pending_config' | 'pending_verification' | 'unknown';

export interface CoverageDimension {
  code: string;
  displayName: string;
  state: CoverState;
  stateText: string;
  capabilities: { code: string; displayName: string; maturity?: string }[];
  lastObservedAt: string | null;
  reason?: string | null;
  note?: string | null;
  // SC-05 起后端 buildCoverage 返回多条备注（notes[]）；note 为旧字段兼容
  notes?: string[] | null;
}
export interface CoverageSummary {
  totalDimensions: number;
  integratedDimensions: number;
  notIntegrated: string[];
  dimensionsWithData: number;
  notCollected: string[];
}
export interface Coverage {
  dimensions: CoverageDimension[];
  summary: CoverageSummary;
}


// ---------- SC-09：项目级自动首采 ----------
// r2 §四：执行状态（任务是否都结束）与覆盖状态（数据是否齐全）**分开表达**
export type FirstCollectionStatus = 'running' | 'complete' | 'partial';
export type FirstCollectionExecutionStatus = 'running' | 'complete';
export type FirstCollectionCoverageStatus = 'complete' | 'partial';
export interface FirstCollectionSummary {
  batchId: string;
  /** 任务是否全部进入终态 */
  executionStatus: FirstCollectionExecutionStatus;
  /** 数据是否齐全：存在失败或当前仍未配置的来源 → partial */
  coverageStatus: FirstCollectionCoverageStatus;
  /** 兼容字段（由上面两者派生） */
  status: FirstCollectionStatus;
  startedAt: string;
  completedAt: string | null;
  brandsTotal: number;
  brandsDone: number;
  brandsCollecting: number;
  brandsPartial: number;
  brandsNeedsAttention: number;
  failedCount: number;
  notConfiguredCount: number;
  outOfCoverageCount: number;
  removedBrandsCount: number;
  recoverableCount: number;
  items: Record<string, number>;
  totalItems: number;
  canRetry: boolean;
}
// r3：用户侧来源状态（唯一投影；十个状态见 app/services/source-health.js）
export type SourceHealthState =
  | 'not_started' | 'probing' | 'available' | 'monitoring' | 'limited'
  | 'retryable' | 'blocked' | 'not_configured' | 'out_of_coverage' | 'unsupported';
export interface SourceHealthGap {
  dimension: string;
  state: string;
  kind?: string;
  text: string;
  owner?: string;
}
export interface SourceHealth {
  state: SourceHealthState;
  stateText: string;
  tone: 'ok' | 'info' | 'warn' | 'muted';
  note: string | null;
  action: { kind: string; text: string | null };
  hasData: boolean;
  started: boolean;
  needsHandling: boolean;
  limited: boolean;
  stale: boolean;
  watching: 'none' | 'probing' | 'monitoring' | 'limited';
  signals: string[];
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  issue: { kind: string; owner: string; retryable: boolean; text: string } | null;
  limits: Array<{ dimension: string; state: string; text: string }>;
  gaps: SourceHealthGap[];
}
// 项目级四类计数（去重品牌）
export interface BrandsHealthSummary {
  brands: number;
  established: number;
  collecting: number;
  limited: number;
  needsHandling: number;
  notStarted: number;
  limits: number;
  /** r4g §七：覆盖限制拆分——品牌数与维度数不得混用 */
  partialSignalBrands?: number;
  notIntegratedDimensions?: number;
  byState: Record<string, number>;
}

// 逐品牌 × 逐能力首采状态（真实任务状态，不含推断）
export interface BrandFirstCollection {
  items: Record<string, { state: string; resultCount: number | null }>;
  hasFailure: boolean;
  failureText: string | null;
  collecting: boolean;
}
// 品牌卡片真实摘要（后端从 attempt 派生；无数据即 null，不补 0）
export interface BrandCollectionDigest {
  products: { count: number; priceMin: number | null; priceMax: number | null; currencies: string[]; collectedAt: string | null } | null;
  reviews: { pageCount: number; reviewCount: number | null; collectedAt: string | null } | null;
  social: { count: number; platform: string; collectedAt: string | null } | null;
  search: { state: 'available' | 'not_started' | 'not_configured'; collectedAt: string | null; measurement: string | null } | null;
  ads: { coverage: 'covered' | 'out_of_coverage' | 'unknown'; brandMarket: string | null; note: string | null } | null;
  lastSuccessAt: string | null;
  lastFailureText: string | null;
}

// ---------- SC-08 r2 §六：唯一覆盖投影 brandCoverage（后端 Registry 派生） ----------
export type BrandCoverState6 = 'available' | 'collecting' | 'empty' | 'failed' | 'not_configured' | 'not_started';
export interface BrandCoverageDimension {
  code: string;
  label: string;
  displayName?: string;
  state: BrandCoverState6;
  stateText: string;
  reason: string | null;
  note?: string | null;
  lastObservedAt: string | null;
  firstObservedAt?: string | null;
  lastAttemptAt?: string | null;
  lastSuccessfulAt?: string | null;
  latestAttemptStatus?: 'success' | 'partial' | 'failed' | 'running' | null;
  usingPreviousData?: boolean;
  // SC-12：维度下辖能力（含 maturity）——「立即更新」据此挑选可刷新的能力
  capabilities?: { code: string; label?: string; displayName?: string; maturity?: string }[];
  observationCount: number;
  evidenceCount: number;
  sourceCount: number;
  latestFailureText: string | null;
  // SC-12 §三.3：用户级失败种类（非内部码）
  failureKind?: string | null;
}
export interface BrandCoverageSummary {
  available: number;
  total: number;
  collecting: number;
  failed: number;
  notConfigured: number;
  notStarted?: number;
  empty?: number;
}
export interface BrandCoverage {
  summary: BrandCoverageSummary;
  firstObservedAt?: string | null;
  dimensions: BrandCoverageDimension[];
  dataDimensions: { code: string; label: string }[];
}

// 正式监控状态（卡片/详情共用口径；establishing ≠ 监控中）
export interface BrandMonitoringState {
  state: 'active' | 'degraded' | 'paused' | 'establishing' | 'source_failed' | 'none';
  stateText: string;
  signals: string[];
  signalsText: string | null;
  sinceAt: string | null;
  lastSuccessAt?: string | null;
  freshness?: string | null;
  nextStepText?: string | null;
}

export interface BrandVerifiedChange {
  at: string;
  dimension: string;
  eventType: string;
  title: string;
  eventId: string;
}

export interface BrandListItem {
  brandId: string;
  name: string;
  officialDomain: string | null;
  market: string | null;
  category: string | null;
  relation: string | null;
  competitorId: string | null;
  // SC-08 r2 §六：唯一覆盖投影（列表与详情同源同口径）
  brandCoverage: BrandCoverage;
  // SC-06：竞品数据库首页新增——官网确认状态与时间积累起点
  officialSite?: { status: 'confirmed' | 'unavailable' | 'not_collected'; statusText: string; canonical?: string | null; siteName?: string | null; lastCollectedAt?: string | null } | null;
  // SC-06 r2：官网公开商品（非目录接口）——未验证时 status='not_collected' 且带说明
  publicProducts?: PublicProductsStatus | null;
  collection?: BrandCollectionState | null;
  monitoring?: BrandMonitoringState | null;
  lastVerifiedChange?: BrandVerifiedChange | null;
  firstObservedAt?: string | null;
  lastObservedAt: string | null;
  // SC-12 §三.3：卡片短状态（后端单一真源；不出现长错误段落与内部码）
  status?: { code: string; text: string; detail: string | null; tone?: string | null };
  // r3：唯一来源状态投影（工作台/竞品雷达/竞品库/情报库共用同一份结论）
  sourceHealth?: SourceHealth | null;
  // SC-12 §三.3：卡片短状态（后端单一真源；不出现长错误段落与内部码）
  collectionDigest?: BrandCollectionDigest | null;
  firstCollection?: BrandFirstCollection | null;
}

// 竞品数据库首页四项统计（后端同源派生，禁止前端各算一套）
export interface BrandsProjectStats {
  brands: number;
  accumulating: number;
  collecting: number;
  /** r3：有限覆盖与覆盖限制（分开计，不进「需要处理」） */
  limited?: number;
  coverageLimited?: number;
  byState?: Record<string, number>;
  needsAttention: number;
}

// SC-07 §3：逐品牌真实采集状态（由后端 attempt/job/readiness 派生）
export interface BrandCollectionState {
  state: 'queued' | 'collecting' | 'has_data' | 'empty' | 'failed' | 'source_pending' | 'not_started';
  stateText: string;
  observedDimensions?: number;
  // SC-08 r3 §三：最近一次任意采集 vs 最近一次成功采集（UI 的「成功观察」只准用后者）
  lastAttemptAt?: string | null;
  lastSuccessfulAt?: string | null;
  latestAttemptStatus?: 'success' | 'partial' | 'failed' | 'running' | null;
  reason?: string | null;
}

export interface VoiceCoverage {
  brands: number;
  checked: number;
  withObservations: number;
  empty: number;
  failed: number;
  notCollected: number;
  observations: number;
  failures: { brandId: string; brandName: string | null; competitorId: string | null; reason: string; at: string | null }[];
  note?: string;
}

// SC-07 r2 §四：项目级采集覆盖（七态计数 + 失败明细；后端从真实 attempt/job/readiness 派生）
export interface CollectionCoverage {
  brands: number;
  counts: { queued: number; collecting: number; has_data: number; empty: number; failed: number; source_pending: number; not_started: number };
  failures: { brandId: string; brandName: string | null; competitorId: string | null; reason: string | null; at: string | null }[];
  stateText: Record<string, string>;
  anyInFlight: boolean;
  note?: string;
}

export interface PublicProductsStatus {
  status: 'verified' | 'unavailable' | 'not_collected';
  statusText: string;
  maturity?: string | null;
  lastCollectedAt?: string | null;
  lastAttemptAt?: string | null;
  observedCount?: number | null;
  discoveryPath?: string | null;
  sampleNote?: string | null;
  failureText?: string | null;
  note?: string | null;
}

export interface ProductObservation {
  id?: string | null;
  title?: string;
  price?: number | null;
  currency?: string | null;
  available?: boolean;
  publishedAt?: string | null;
  // SC-09 §三.A：商品观察至少保留 图片/观察时间/来源快照
  image?: string | null;
  observedAt?: string | null;
  snapshotId?: string | null;
}

// 任意维度的观察（商品/评论页/视频/趋势）：字段取并集，缺省即 null（不补值）
export interface DimensionObservation extends ProductObservation {
  rating?: number | null;
  reviewCount?: number | null;
  snippet?: string | null;
  sourceUrl?: string | null;
}

export interface EvidenceRefLite {
  evidenceId: string | null;
  snapshotId: string | null;
  sourceUrl: string | null;
  label?: string | null;
}

export interface TimelineEvent {
  eventId: string;
  kind: string;
  kindText?: string;
  typeText?: string;
  at: string;
  nature: string;
  natureText: string;
  status: string | null;
  statusText?: string;
  title: string | null;
  detail: string | null;
  refType?: string | null;
  refId?: string | null;
  payload?: { evidenceIds?: string[]; observationCount?: number; capability?: string; status?: string } | null;
}

export interface IntelItem {
  id: string;
  brandId: string | null;
  brandName: string | null;
  competitorId?: string | null;
  type: string;
  typeText: string;
  at: string;
  nature: string;
  natureText: string;
  status: string;
  statusText: string;
  title: string;
  detail: string | null;
  evidence: { evidenceId: string; evidenceStatus?: string; observedAt?: string | null; snapshotIds?: string[] }[];
  correctionEndpoint?: string | null;
}

// r4.10：项目级建设中维度（未接入维度不再作为情报事件出现在 items 中）
// P0-2 整改 r2：pending_config（实现完成未验证；用户侧「数据服务暂不可用」）≠ not_integrated
export interface ConstructionDimension {
  code: string;
  displayName: string;
  state: 'pending_config' | 'not_integrated';
  message: string;
  configKeys?: string[];
}

// SC-05：情报库「时序变化」独立字段（derived_timeline_events 投影，与采集观察不混排）
// SC-06 三：情报库「用户声音与公开评论」项目级投影（统一读模型 voice-unified.js）
export interface VoiceChangeItem {
  brandId: string;
  brandName: string | null;
  status: 'sufficient' | 'insufficient';
  sampleSize: number;
  sourceCount: number;
  // SC-06 r2：统一事实链是否够格进入满意度机会判断（缺依据时明确写出原因）
  opportunityEligible?: boolean;
  opportunityReason?: string | null;
  opportunityReasonText?: string | null;
  recentItems: { title: string | null; sourceUrl: string | null; rating: number | null; reviewCount: number | null; observedAt: string | null; evidenceId: string | null; snapshotId: string | null; polarity?: string | null; sentimentBasis?: string | null }[];
}

export interface MemoryEventItem {
  id: string;
  brandId: string | null;
  brandName: string | null;
  competitorId: string | null;
  entityId: string;
  entityName: string | null;
  eventType: string;
  eventText: string;
  summary: string | null;
  fromValue: number | null;
  toValue: number | null;
  currency: string | null;
  unit: string | null;
  at: string;
  atBasis: string;
  timePrecision: string;
  timePrecisionText: string;
  sourceKind: 'derived_event';
  sourceKindText: string;
  evidenceIds: string[];
  snapshotIds: string[];
  derivedFromFactIds: string[];
  link?: { brandId: string; tab: string; from: string; to: string } | null;
}

export interface OpportunityHistoryBasis {
  brandsWithHistory: number;
  factCount: number;
  comparableCount?: number;
  earliestAvailableAt: string | null;
  latestObservedAt: string | null;
  availableHistoryDays: number;
  enoughForTrend: boolean;
  note: string;
}

export interface OpportunityVoiceBasis {
  collected: number;
  qualified: number;
  brandsWithQualifiedVoice?: number;
  gate: 'ok' | 'no_public_reviews' | 'no_evidence_backed_polarity' | 'insufficient_sample' | string;
  gateText?: string;
  sampleNote?: string;
}

export interface OpportunityView {
  // insufficient_voice = 评论已采集但没有带依据的正负分类 → 不画满意度散点
  status: 'ok' | 'insufficient' | 'insufficient_voice';
  statusText: string;
  items: {
    id: string | null; theme: string | null; level?: string | null; basis?: unknown;
    brandCount?: number | null; from?: string | null; to?: string | null;
    caveats?: string[]; status?: string; note?: string;
  }[];
  sample: { brandCount: number; brandsWithData: number; required?: number };
  dimensionBasis?: { integrated: string[]; pendingVerification?: string[]; pendingConfig?: string[]; notIntegrated: string[]; covered: string[] };
  historyBasis?: OpportunityHistoryBasis | null; // SC-05：可用历史跨度 + 本次使用的时间范围
  // SC-06 r2：统一评论事实链的资格状态 + 下一步建议（缺合格输入时如实说明）
  voiceBasis?: OpportunityVoiceBasis | null;
  nextSteps?: string[];
  limits: string[];
  note?: string | null;
  // SC-12 §六：机会数据基础（缺失维度如实标注；不因单个维度缺失而整页空白）
  foundation?: OpportunityFoundation | null;
}

// ---------- SC-12 §六：机会数据基础（服务端按可用维度独立产出） ----------
export interface OpportunityDimensionBasis {
  code: string; label: string;
  status: 'complete' | 'partial' | 'missing' | 'not_covered' | 'not_configured' | 'checked_empty';
  statusText: string | null;
  brandCount: number;        // 参与品牌数
  observationCount: number;  // 观察数量
  evidenceCount: number;     // Evidence 数量
  window: { from: string | null; to: string | null };
  measurementMethod: string | null;
  limits: string[];
  // §三：历史数据与最新失败
  usingPreviousData?: boolean;
  lastSuccessAt?: string | null;
  latestFailureText?: string | null;
  // §二：逐品牌状态（UI 用于「每项只显示一次」+ 混合状态不混用）
  perBrand?: { brandId: string; name: string; state: string; stateText: string | null; observationCount: number; observedAt: string | null; outOfCoverage?: boolean; coverageNote?: string | null }[] | null;
}

export interface OpportunityEvidenceRef {
  evidenceId: string | null;
  snapshotId: string | null;
  sourceUrl: string | null;
  brandId?: string | null;
  observedAt?: string | null;
}

export interface OpportunityPriceRow {
  brandId: string; name: string; competitorId: string | null;
  productCount: number | null; available: number | null; soldOut: number | null;
  priceMin: number | null; priceMedian: number | null; priceMax: number | null;
  currency: string | null; currencyStatus?: 'confirmed' | 'mixed' | 'unknown';
  priceComparable?: boolean;
  observedAt: string | null; evidenceIds: string[];
  usingPreviousData?: boolean; lastSuccessAt?: string | null; latestFailureText?: string | null;
  evidenceRefs?: OpportunityEvidenceRef[];  /** r4g §八：是否参与市场统计（ ineligible 行保留展示与证据，不进统计） */
  priceEligible?: boolean;
  priceIneligibleReason?: string | null;
}

export interface OpportunityLead {
  id: string; title: string; fact: string; dimension: string; dimensionCode?: string; sampleSize: string;
  window: { from: string | null; to: string | null };
  evidenceRefs: OpportunityEvidenceRef[];
  limits: string[]; question: string;
  historical?: boolean;
}

export interface OpportunityFoundation {
  projectId: string;
  generatedAt: string;
  brandScope: {
    total: number; withData: number; withReviews: number;
    list: { brandId: string; competitorId: string | null; name: string; domain: string | null; relation: string | null; market: string | null; category: string | null; hasPrice: boolean; hasReviews: boolean }[];
  };
  dimensions: Record<string, OpportunityDimensionBasis>;
  // §六.1：不可用维度统一在此列出（每个维度只出现一次）
  unavailableDimensions: OpportunityDimensionBasis[];
  modules: {
    priceBands: {
      available: boolean;
      // §一.5：按币种分组
      groups: { currency: string; brandCount: number; medianPrice: number | null; medianText?: string | null; bandsAvailable: boolean; positioningAvailable: boolean; /** r4g §八：原始观察范围（含异常标价行，未参与市场统计） */ rawObservation?: { min: number; max: number; brandCount: number; note: string } | null; bands: { key: string; label: string; min: number | null; max: number | null; brandCount: number; brandIds: string[]; brandNames: string[]; covered: boolean }[]; rows: OpportunityPriceRow[] }[];
      bands: { key: string; label: string; min: number | null; max: number | null; brandCount: number; brandIds: string[]; brandNames: string[]; covered: boolean }[];
      currency: string | null;
      multiCurrency: boolean;
      rows: OpportunityPriceRow[];
      nonComparableRows: { brandId: string; competitorId: string | null; name: string; productCount: number | null; currencyStatus: string; note: string }[];
      limits: string[];
    };
    matrixDensity: { available: boolean; rows: OpportunityPriceRow[]; medianProductCount: number | null; limits: string[] };
    newItemDynamics: {
      available: boolean;
      rows: { brandId: string; name: string; baselineItems: number; firstSeenAt: string | null; lastSeenAt: string | null; days: { day: string; count: number; firstAt: string | null }[] }[];
      comparableWindows: number;
      limits: string[];
    };
    reviewInsights: {
      available: boolean;
      rows: { brandId: string; name: string; pageCount: number; ratedPages: number; reviewCount: number | null; sourceCount: number | null; observedAt: string | null; evidenceIds: string[]; usingPreviousData?: boolean; latestFailureText?: string | null; pages: { url: string | null; title: string | null; rating: number | null; reviewCount: number | null; observedAt: string | null }[] }[];
      ratedObjects: number;
      limits: string[];
    };
    // §四：散点门槛结论由服务端给出（前端只消费，不自行判定；无 jitter）
    satisfactionScatter: {
      available: boolean; minObjects: number; evaluatedObjects?: number; comparableObjects: number;
      objects: { oid: string | null; label: string | null; satisfaction: number | null; importance: number | null; sampleScope: string | null; window: { from: string | null; to: string | null }; evidenceRefs: OpportunityEvidenceRef[] }[];
      rejected?: { label: string | null; missing: string[] }[];
      reason: string | null;
      detail?: string | null;
      coordsBasis?: string;
      limits: string[];
    };
  };
  opportunities: OpportunityLead[];
  summary: {
    usableDimensionCodes: string[]; unavailableDimensionCodes?: string[]; missingDimensionCodes: string[];
    usableDimensionCount: number; missingDimensionCount: number;
    brandCount: number; brandsWithData: number; opportunityCount: number;
    hasAnalysis?: boolean;
  };
}

export interface ReportListItem {
  reportId: string;
  projectId: string;
  version: number;
  status: 'queued' | 'running' | 'success' | 'failed';
  scope: { brandIds?: string[]; from?: string | null; to?: string | null; sections?: string[] };
  createdAt: string;
  finishedAt: string | null;
  factCount: number;
  gapCount: number;
  retryCount?: number;
  errorText?: string | null;
  generatedBy?: string | null;
}

export interface ReportCitation {
  citationId: string;
  section: string | null;
  factId: string | null;
  label: string | null;
  sourceUrl?: string | null;
  evidenceIds: string[];
  snapshotIds: string[];
}

export interface ReportDetail extends ReportListItem {
  markdown: string | null;
  factPack: {
    generatedAt?: string;
    facts?: { id: string; text?: string | null; dim?: string | null }[];
    coverage?: { brandId: string; name: string; summary: CoverageSummary }[];
    gaps?: { brandId: string; displayName?: string; dimension?: string; kind?: string; text?: string }[];
    opportunities?: unknown[];
    // SC-05：冻结的时序事实基线（事实 id / 版本 id / 双时间 / 证据引用）
    memoryBasis?: {
      from?: string | null;
      to?: string | null;
      factCount?: number;
      facts?: {
        factId: string; versionId: string; entityId: string; brandId?: string | null;
        factType: string; value: string | number | null; currency?: string | null;
        sourceKind?: string; timePrecision?: string;
        effectiveAt?: string | null; observedAt?: string | null; at?: string; atBasis?: string;
        evidenceIds?: string[]; snapshotIds?: string[];
      }[];
      note?: string;
    } | null;
  } | null;
  gaps: { brandId: string; displayName?: string; dimension?: string; kind?: string; text?: string }[] | null;
  opportunities: unknown[];
  errorText?: string | null;
  citations: ReportCitation[];
  jobs: { jobId: string; reportId: string; status: string; retry: number; attempts: number; lastError?: string | null }[];
}

// SC-06 三：「用户声音与公开评论」统一读模型（后端 voice-unified.js 投影）
export interface UnifiedVoice {
  version: string;
  title: string;
  status: 'sufficient' | 'insufficient';
  insufficientText: string;
  verified: {
    items: {
      kind: string; title: string | null; snippet: string | null; sourceUrl: string | null;
      rating: number | null; reviewCount: number | null; observedAt: string | null;
      brandId: string | null; competitorId?: string | null; evidenceId: string | null; snapshotId: string | null;
      polarity: string | null; sentiment: string | null; sentimentBasis: string | null; sentimentBasisNote?: string | null;
    }[];
    summary: {
      sampleSize: number; sourceCount: number;
      periodStart: string | null; periodEnd: string | null;
      measurementMethod: string; sampleNote: string; limitations: string[];
    } | null;
  };
  legacy: { items: { kind: string; platform: string | null; text: string | null; url: string | null; date: string | null; brandId: string | null; note: string | null }[]; note: string | null };
}

export interface BrandDetail {
  brand: {
    brandId: string; name: string; officialDomain: string | null;
    market: string | null; category: string | null; relation: string | null;
    competitorId: string | null; firstObservedAt: string | null;
    dataAccumulationStart?: string | null;
  };
  links: { linkId: string; projectId: string; competitorRef: string | null }[];
  // SC-08 r2 §六：唯一的覆盖投影（不再返回第二套 coverage）
  brandCoverage: BrandCoverage;
  monitoring?: BrandMonitoringState | null;
  lastVerifiedChange?: BrandVerifiedChange | null;
  // 核心产品体验收敛 r1：品牌级可核验变化统计（第一屏摘要卡唯一口径）
  verifiedChanges?: { count: number; firstAt: string | null; lastAt: string | null };
  // SC-09 §四：详情 Tab 的真实 observations（评论/社媒/热度/广告）+ 证据引用
  dimensionDetails?: Record<string, {
    observations: DimensionObservation[];
    summary: Record<string, unknown> | null;
    hasAttempt: boolean;
    collectedAt: string | null;
    surfaceState?: string | null;
    evidenceRefs: { evidenceId: string | null; snapshotId: string | null; sourceUrl: string | null; label: string | null }[];
  }>;
  collectionDigest?: BrandCollectionDigest | null;
  // SC-06 二：官网确认状态（confirmed/unavailable/not_collected，非「官网不支持」语义）
  officialSite?: { status: 'confirmed' | 'unavailable' | 'not_collected'; statusText: string; canonical?: string | null; siteName?: string | null; hasOrganization?: boolean; lastCollectedAt?: string | null; sampleNote?: string } | null;
  // SC-06 r2：官网公开商品采集状态（与官方资料分离；未验证不写「已采集」）
  publicProducts?: PublicProductsStatus | null;
  // SC-07 §3：逐品牌真实采集状态
  collection?: BrandCollectionState | null;
  // SC-06 三：统一「用户声音与公开评论」读模型
  unifiedVoice?: UnifiedVoice | null;
  products: {
    observations: ProductObservation[];
    summary: Record<string, unknown> | null;
    hasAttempt: boolean;
    collectedAt: string | null;
    evidenceRefs: EvidenceRefLite[];
  };
  timeline: TimelineEvent[];
  intelligence: IntelItem[];
  reports: ReportListItem[];
}

export function fetchBrands(projectId: string, signal?: AbortSignal) {
  return apiGet<{ projectId: string; brands: BrandListItem[]; count: number; stats?: BrandsProjectStats; firstCollection?: FirstCollectionSummary | null; collectionCoverage?: CollectionCoverage | null; healthSummary?: BrandsHealthSummary | null }>(
    `/api/brands?projectId=${encodeURIComponent(projectId)}`, signal);
}
// SC-09：首采进度轮询 / 失败项重试
export function fetchFirstCollection(projectId: string, signal?: AbortSignal) {
  return apiGet<{ projectId: string; firstCollection: FirstCollectionSummary | null }>(
    `/api/first-collection?projectId=${encodeURIComponent(projectId)}`, signal);
}
export function retryFirstCollection(projectId: string) {
  return apiPost<{ projectId: string; retried: number; firstCollection: FirstCollectionSummary | null; message: string }>(
    '/api/first-collection/retry-failed', { projectId });
}

export function fetchBrand(brandId: string, opts: { projectId?: string; signal?: AbortSignal } = {}) {
  const q = opts.projectId ? `?projectId=${encodeURIComponent(opts.projectId)}` : '';
  return apiGet<BrandDetail>(`/api/brands/${encodeURIComponent(brandId)}${q}`, opts.signal);
}
export function fetchBrandTimeline(brandId: string, opts: { projectId?: string; kind?: string; from?: string; to?: string; limit?: number; signal?: AbortSignal } = {}, signal?: AbortSignal) {
  const q = new URLSearchParams();
  if (opts.projectId) q.set('projectId', opts.projectId);
  if (opts.kind) q.set('kind', opts.kind);
  if (opts.from) q.set('from', opts.from);
  if (opts.to) q.set('to', opts.to);
  q.set('limit', String(opts.limit || 50));
  return apiGet<{ brandId: string; projectId?: string; firstObservedAt: string | null; note: string; events: TimelineEvent[] }>(
    `/api/brands/${encodeURIComponent(brandId)}/timeline?${q.toString()}`, signal || opts.signal);
}
export function fetchBrandCoverage(brandId: string, opts: { projectId?: string; signal?: AbortSignal } = {}) {
  const q = opts.projectId ? `?projectId=${encodeURIComponent(opts.projectId)}` : '';
  return apiGet<{ brandId: string; projectId?: string; brandCoverage: BrandCoverage }>(`/api/brands/${encodeURIComponent(brandId)}/coverage${q}`, opts.signal);
}
// ---------- SC-08 §二：每日变化收件箱 ----------
export type InboxDimension = 'price' | 'product' | 'stock' | 'website' | 'review' | 'social' | 'ads' | 'search';
export interface InboxEvidenceRef {
  evidenceId?: string;
  snapshotId?: string;
  sourceUrl?: string | null;
  observedAt?: string | null;
}
export interface InboxEvent {
  eventId: string;
  brandId: string | null;
  competitorId: string | null;
  brandName: string | null;
  dimension: InboxDimension;
  eventType: string;
  title: string;
  summary: string | null;
  subjectId: string | null;
  observedAt: string;
  effectiveAt: string | null;
  /** r4 §四：系统入库时间（区别于观察时间/实际发生时间） */
  recordedAt?: string | null;
  verificationStatus: 'verified' | 'pending';
  sourceKind: 'live_observation' | 'derived_event';
  origin: 'monitoring' | 'backfill' | 'history';
  change: Record<string, unknown> | null;
  evidenceCount: number;
  evidenceRefs: InboxEvidenceRef[];
  windowKey?: string | null;
  links: { brand: string | null; timeline: string | null; evidence: string | null };
}
export interface InboxGroup { date: string; events: InboxEvent[] }
export interface InboxSummary { today: number; verified: number; pending: number; brandsChanged: number }
// 收件箱真实状态（后端只读投影）：空收件箱必须能区分「没加入监控 / 加了没跑过 / 跑过没变化」
export interface InboxSourceIssue {
  brandName: string;
  source: string;
  category: string;
  categoryText: string;
  action: string;
  actionText: string;
}
export interface InboxSources {
  total: number;
  ok: number;
  failed: number;
  items: InboxSourceIssue[];
  /** r3：非失败类说明（如「官网可访问，正在建立可监控基线」），不进红色清单 */
  notes?: Array<{ brandName: string; text: string }>;
  latestAt: string | null;
}
export interface InboxState {
  state: 'no_monitoring' | 'paused' | 'establishing' | 'source_failed' | 'awaiting_comparison' | 'inspected' | 'inspected_partial' | 'inspection_failed' | 'unknown';
  /** r2：项目级来源结果（后端聚合，前端不猜测） */
  sources?: InboxSources;
  partialFailure?: boolean;
  allFailed?: boolean;
  historicalNote?: string | null;
  activeTargets: number;
  pausedTargets: number;
  pendingIntents?: number;
  failedIntents?: number;
  intentNote?: string | null;
  signals: string[];
  signalsText: string;
  baselineCompleted: number;
  windowCount: number;
  lastWindowAt: string | null;
  lastWindowStatus: string | null;
  /** r4 §六：最新巡检窗口覆盖（不完整时必须给缺口明细，绝不显示「没有变化」） */
  coverage?: {
    complete: boolean;
    expected: number;
    completed: number;
    missingBrands: string[];
    failures: Array<{ brandName: string; category: string; categoryText: string; action: string; actionText: string }>;
    nextRetryAt: string | null;
    nextRetryText: string | null;
  } | null;
  lastSuccessAt: string | null;
  todayInspected: boolean;
  todayWindowCount: number;
  lastEventsVerified: number;
}
export interface InboxResponse {
  projectId: string;
  summary: InboxSummary;
  groups: InboxGroup[];
  nextCursor: string | null;
  total: number;
  polling: { enabled: boolean; reason: string; activeTargets?: number };
  state: InboxState;
  filters: Record<string, string | null>;
  timeZone: string;
  limitations: string[];
}
export function fetchIntelInbox(params: {
  projectId: string; brandId?: string; dimension?: string; eventType?: string;
  verificationStatus?: string; from?: string; to?: string; cursor?: string; limit?: number;
}, signal?: AbortSignal) {
  const q = new URLSearchParams({ projectId: params.projectId });
  for (const k of ['brandId', 'dimension', 'eventType', 'verificationStatus', 'from', 'to', 'cursor'] as const) {
    const v = params[k];
    if (v) q.set(k, String(v));
  }
  if (params.limit) q.set('limit', String(params.limit));
  return apiGet<InboxResponse>(`/api/intel/inbox?${q.toString()}`, signal);
}

export function fetchIntelligence(params: { projectId: string; brandId?: string; type?: string; from?: string; to?: string }, signal?: AbortSignal) {
  const q = new URLSearchParams({ projectId: params.projectId });
  if (params.brandId) q.set('brandId', params.brandId);
  if (params.type) q.set('type', params.type);
  if (params.from) q.set('from', params.from);
  if (params.to) q.set('to', params.to);
  return apiGet<{ projectId: string; items: IntelItem[]; count: number; constructionDimensions?: ConstructionDimension[]; memoryEvents?: MemoryEventItem[]; voiceChanges?: VoiceChangeItem[]; voiceCoverage?: VoiceCoverage | null; collectionCoverage?: CollectionCoverage | null; filters: Record<string, string | null>; legend: Record<string, Record<string, string>> }>(
    `/api/intelligence?${q.toString()}`, signal);
}
export function fetchOpportunities(projectId: string, signal?: AbortSignal) {
  return apiGet<OpportunityView>(`/api/opportunities?projectId=${encodeURIComponent(projectId)}`, signal);
}
// SC-12 §五：品牌详情页「立即更新」——对单个能力的真实刷新（后端 202 入队，非前端伪造状态）
export function refreshBrandSource(body: { projectId: string; competitorId: string; capability: string }) {
  return apiPost<{ attempt?: { attemptId: string; status: string }; jobId?: string; deduped?: boolean; message?: string }>(
    '/api/data-surface/refresh', body,
  );
}

// ---------- 正式监控对象（收件箱的「立即巡检 / 加入监控」真实动作） ----------
export interface WatchTargetInfo {
  watchTargetId: string;
  competitorId: string;
  monitoringStatus: string;
  enabledSignals: string[];
  supportedSignals: string[];
  baselineCompletedAt?: string | null;
  lastSuccessAt?: string | null;
}
export interface WatchIntentInfo {
  intentId: string;
  competitorId: string;
  state: string;
  reasonText?: string | null;
  monitoring?: boolean;
}
export function fetchWatchTargets(projectId: string, signal?: AbortSignal) {
  return apiGet<{ targets: WatchTargetInfo[]; intents: WatchIntentInfo[] }>(
    `/api/watch-targets?projectId=${encodeURIComponent(projectId)}`, signal,
  );
}
// 立即巡检：202 + 后台真实执行一次监控窗口（不是前端假状态）
export function inspectWatchTarget(watchTargetId: string) {
  return apiPost<{ accepted: boolean; windowKey: string; message: string }>(
    `/api/watch-targets/${encodeURIComponent(watchTargetId)}/inspect`, {},
  );
}
// 加入正式监控（真实建目标；幂等）
export function createWatchTarget(body: { projectId: string; competitorId: string }) {
  return apiPost<{ target?: WatchTargetInfo; existed?: boolean; reactivated?: boolean }>('/api/watch-targets', body);
}
// 事件级纠错：只登记复核，不改写已记录事实
export function reportIntelEvent(body: { projectId: string; eventId: string; reason: string; note?: string }) {
  return apiPost<{ ok: boolean; duplicate?: boolean; message: string }>(
    `/api/intel/events/${encodeURIComponent(body.eventId)}/correction`,
    { projectId: body.projectId, eventId: body.eventId, reason: body.reason, note: body.note || '' },
  );
}

export function fetchReports(projectId: string, signal?: AbortSignal) {
  return apiGet<{ projectId: string; reports: ReportListItem[] }>(`/api/reports?projectId=${encodeURIComponent(projectId)}`, signal);
}
export function createReport(body: { projectId: string; brandIds?: string[]; from?: string | null; to?: string | null; sections?: string[] }) {
  return apiPost<{ reportId: string; jobId: string; status: string; version: number; message: string }>('/api/reports', body);
}
export function fetchReport(reportId: string, signal?: AbortSignal) {
  return apiGet<ReportDetail>(`/api/reports/${encodeURIComponent(reportId)}`, signal);
}

// 项目清单（顶部项目选择器数据源；GET /api/projects 为文件态清单唯一实现）
export interface ProjectInfo {
  id: string;
  track: string;
  discoveredAt: string | null;
  total: number;
  done: number;
  hasBrief: boolean;
  current: boolean;
}
export function fetchProjects(signal?: AbortSignal) {
  return apiGet<{ projects: ProjectInfo[] }>('/api/projects', signal);
}

// 状态 → 展示语义（§六：未接入≠零值，尚未采集≠未发现数据）
export const COVER_STATE_TEXT: Record<string, string> = {
  ok: '已采集且有数据',
  partial: '部分采集',
  empty: '已采集但无可提炼结果',
  stale: '数据过期',
  loading: '采集中',
  failed: '最近采集失败，尚无可展示数据',
  unsupported: '未接入',
  pending_config: '数据服务暂不可用',
  unknown: '尚未采集',
};

export function priceText(o: ProductObservation): string {
  if (o.price == null) return '价格未取到';
  const cur = o.currency ? (o.currency === 'USD' ? '$' : o.currency + ' ') : '';
  return o.currency ? `${cur}${o.price}` : `${o.price}（币种待确认）`;
}

// ---------- r4 §三：工作台「竞品价格观察」卡（真实观察 + 数据覆盖区） ----------
export interface WorkbenchEvidenceFirst {
  evidenceId: string | null;
  snapshotId: string | null;
  sourceUrl: string | null;
  observedAt: string | null;
}
export interface WorkbenchObservationCard {
  cardId: string;
  kind: 'price_observation';
  brandId: string | null;
  competitorId: string | null;
  brandName: string;
  currency: string | null;
  currencyStatus?: string | null;
  price: { median: number | null; min: number | null; max: number | null };
  productCount: number;
  availableCount: number;
  soldOutCount: number;
  observedAt: string | null;
  usingPreviousData: boolean;
  lastSuccessAt: string | null;
  source: { label: string; measurementMethod: string };
  evidence: { count: number; first: WorkbenchEvidenceFirst | null };
}
export interface WorkbenchCardsResponse {
  projectId: string;
  cards: WorkbenchObservationCard[];
  market: { currency: string; symbol?: string; min: number; max: number; brandCount: number; basis: string } | null;
  coverage: {
    totalBrands: number;
    observedBrands: number;
    missingPriceBrands: string[];
    usingPreviousDataBrands: string[];
    note: string | null;
  };
  error?: string;
  generatedAt: string;
}
export function fetchWorkbenchCards(projectId: string, opts: { fresh?: boolean; signal?: AbortSignal } = {}) {
  const q = new URLSearchParams();
  q.set('projectId', projectId);
  if (opts.fresh) q.set('fresh', '1');
  return apiGet<WorkbenchCardsResponse>(`/api/workbench/cards?${q.toString()}`, opts.signal);
}

// ---------- r4 §十：账户资料 / 用户名 / 修改密码 ----------
export interface AccountView {
  user: { id: string; email: string; role: string; createdAt: string | null; displayName: string; displayNameSet: boolean };
  tenant: { id: string; name: string; plan: string; createdAt: string | null };
  usage: {
    plan: string;
    dailyDiscover: { used: number; limit: number; enabled: boolean };
    resetsAtText: string;
    note: string;
  } | null;
}
export function fetchAccount(signal?: AbortSignal) {
  return apiGet<AccountView>('/api/account', signal);
}
export function updateDisplayName(displayName: string) {
  return apiPatch<{ ok: true; user: AccountView['user'] }>('/api/account', { displayName });
}
export function changePassword(body: { currentPassword: string; newPassword: string; confirmPassword: string }) {
  return apiPost<{ ok: true; token: string; message: string }>('/api/account/password', body);
}

// ---------- r4 §十一：竞品监控（正式监控对象的暂停/恢复/重新检查） ----------
export function monitoringPause(watchTargetId: string) {
  return apiPost<{ target?: unknown }>('/api/monitoring/pause', { watchTargetId });
}
export function monitoringResume(watchTargetId: string) {
  return apiPost<{ target?: unknown }>('/api/monitoring/resume', { watchTargetId });
}
export function monitoringRecheck(watchTargetId: string) {
  return apiPost<{ accepted: boolean; duplicate?: boolean }>('/api/monitoring/recheck', { watchTargetId });
}

// ---------- r4g §四：监控首页唯一首屏摘要（只读投影；后端 20s 硬超时 partial） ----------
export interface MonitoringSummaryRow {
  competitorId: string;
  name: string;
  state: 'active' | 'paused' | 'establishing' | 'source_failed' | 'none';
  signals: string[];
  signalsText: string;
  lastSuccessAt: string | null;
  watchTargetId: string | null;
  intentId: string | null;
  note: string | null;
}
export interface MonitoringSummary {
  projectId: string;
  partial: boolean;
  partialReason?: string;
  totals: {
    projectBrands: number;
    active: number;
    paused: number;
    establishing: number;
    sourceFailed: number;
    unmonitored: number;
    signalCoverage: Record<string, number>;
  } | null;
  coverage: {
    activeTargets: number;
    pausedTargets: number;
    signalsText: string;
    lastWindowAt: string | null;
    todayInspected: boolean;
    todayWindowCount: number;
    coverage: {
      complete: boolean;
      expected: number;
      completed: number;
      missingBrands: string[];
      failures: Array<{ brandName: string; category: string; categoryText: string; action: string; actionText: string }>;
      nextRetryAt: string | null;
      nextRetryText: string | null;
    } | null;
    windowCount: number;
    sources?: { total: number; ok: number; failed: number; items: Array<{ brandName: string; source: string; categoryText: string; actionText: string }>; notes: Array<{ brandName: string; text: string }>; latestAt: string | null };
  } | null;
  healthSummary: {
    brands: number;
    accumulating: number;
    collecting: number;
    needsAttention: number;
    limited: number;
    partialSignalBrands: number;
    notIntegratedDimensions: number;
  } | null;
  rows: MonitoringSummaryRow[];
  unmonitored: string[];
  generatedAt: string;
  elapsedMs?: number;
}
export function fetchMonitoringSummary(projectId: string, signal?: AbortSignal) {
  return apiGet<MonitoringSummary>(`/api/monitoring/summary?projectId=${encodeURIComponent(projectId)}`, signal);
}

// r4g §六.5：项目级巡检批次（一次巡检全部监控品牌；重复点击幂等）
export function inspectAllTargets(projectId: string) {
  return apiPost<{ accepted: number; inProgress: number; skipped: number; batchId: string | null; totalTargets: number; message: string }>('/api/monitoring/inspect-all', { projectId });
}

// r4g §六.1：监控覆盖计划收敛（把项目内全部竞品纳入监控计划；幂等）
export function planMonitoringReconcile(projectId: string) {
  return apiPost<{ ok: boolean; totalBrands: number; createdCount: number; skippedCount: number; failed: number; message: string }>('/api/monitoring/plan-reconcile', { projectId });
}
