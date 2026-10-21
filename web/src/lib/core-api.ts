// 核心产品主闭环（SC-04）前端契约与请求封装
// 只暴露用户可见字段：不含服务器路径、内部错误码、栈、密钥、原始 payload 路径。
import { apiGet, apiPost } from '@/lib/api';

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

export interface BrandListItem {
  brandId: string;
  name: string;
  officialDomain: string | null;
  market: string | null;
  category: string | null;
  relation: string | null;
  competitorId: string | null;
  coverageSummary: CoverageSummary;
  coverageDimensions: CoverageDimension[];
  // SC-06：竞品数据库首页新增——官网确认状态与时间积累起点
  officialSite?: { status: 'confirmed' | 'unavailable' | 'not_collected'; statusText: string; canonical?: string | null; siteName?: string | null; lastCollectedAt?: string | null } | null;
  // SC-06 r2：官网公开商品（非目录接口）——未验证时 status='not_collected' 且带说明
  publicProducts?: PublicProductsStatus | null;
  collection?: BrandCollectionState | null;
  firstObservedAt?: string | null;
  lastObservedAt: string | null;
  lastChange: { at: string; kind: string; kindText: string; title: string | null } | null;
  gaps: { code: string; displayName: string; state: CoverState; stateText: string }[];
}

// SC-07 §3：逐品牌真实采集状态（由后端 attempt/job/readiness 派生）
export interface BrandCollectionState {
  state: 'queued' | 'collecting' | 'has_data' | 'empty' | 'failed' | 'source_pending' | 'not_started';
  stateText: string;
  observedDimensions?: number;
  lastAttemptAt?: string | null;
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
  };
  links: { linkId: string; projectId: string; competitorRef: string | null }[];
  coverage: Coverage;
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
    attemptId: string | null;
    collectedAt: string | null;
    evidenceRefs: EvidenceRefLite[];
  };
  timeline: TimelineEvent[];
  intelligence: IntelItem[];
  reports: ReportListItem[];
}

export function fetchBrands(projectId: string, signal?: AbortSignal) {
  return apiGet<{ projectId: string; brands: BrandListItem[]; count: number; collectionCoverage?: CollectionCoverage | null }>(
    `/api/brands?projectId=${encodeURIComponent(projectId)}`, signal);
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
  return apiGet<{ brandId: string; projectId?: string; coverage: Coverage }>(`/api/brands/${encodeURIComponent(brandId)}/coverage${q}`, opts.signal);
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
