// 核心产品主闭环（SC-04）前端契约与请求封装
// 只暴露用户可见字段：不含服务器路径、内部错误码、栈、密钥、原始 payload 路径。
import { apiGet, apiPost } from '@/lib/api';

export type CoverState = 'ok' | 'partial' | 'empty' | 'stale' | 'loading' | 'failed' | 'unsupported' | 'unknown';

export interface CoverageDimension {
  code: string;
  displayName: string;
  state: CoverState;
  stateText: string;
  capabilities: { code: string; displayName: string; maturity?: string }[];
  lastObservedAt: string | null;
  reason?: string | null;
  note?: string | null;
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
  lastObservedAt: string | null;
  lastChange: { at: string; kind: string; kindText: string; title: string | null } | null;
  gaps: { code: string; displayName: string; state: CoverState; stateText: string }[];
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
}

export interface IntelItem {
  id: string;
  brandId: string | null;
  brandName: string | null;
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

export interface OpportunityView {
  status: 'ok' | 'insufficient';
  statusText: string;
  items: {
    id: string | null; theme: string | null; level?: string | null; basis?: unknown;
    brandCount?: number | null; from?: string | null; to?: string | null;
    caveats?: string[]; status?: string; note?: string;
  }[];
  sample: { brandCount: number; brandsWithData: number; required?: number };
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
  } | null;
  gaps: { brandId: string; displayName?: string; dimension?: string; kind?: string; text?: string }[] | null;
  opportunities: unknown[];
  errorText?: string | null;
  citations: ReportCitation[];
  jobs: { jobId: string; reportId: string; status: string; retry: number; attempts: number; lastError?: string | null }[];
}

export interface BrandDetail {
  brand: {
    brandId: string; name: string; officialDomain: string | null;
    market: string | null; category: string | null; relation: string | null;
    competitorId: string | null; firstObservedAt: string | null;
  };
  links: { linkId: string; projectId: string; competitorRef: string | null }[];
  coverage: Coverage;
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
  return apiGet<{ projectId: string; brands: BrandListItem[]; count: number }>(
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
  return apiGet<{ projectId: string; items: IntelItem[]; count: number; filters: Record<string, string | null>; legend: Record<string, Record<string, string>> }>(
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

// 状态 → 展示语义（§六：未接入≠零值，尚未采集≠未发现数据）
export const COVER_STATE_TEXT: Record<string, string> = {
  ok: '已采集且有数据',
  partial: '部分采集',
  empty: '已采集但无可提炼结果',
  stale: '数据过期',
  loading: '采集中',
  failed: '最近采集失败，尚无可展示数据',
  unsupported: '未接入',
  unknown: '尚未采集',
};

export function priceText(o: ProductObservation): string {
  if (o.price == null) return '价格未取到';
  const cur = o.currency ? (o.currency === 'USD' ? '$' : o.currency + ' ') : '';
  return o.currency ? `${cur}${o.price}` : `${o.price}（币种待确认）`;
}
