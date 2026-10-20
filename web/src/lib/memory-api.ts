// 知彼 Vantage · Competitive Memory 客户端（SC-05）
// 纪律：组件内禁止裸写 fetch；所有字段来自后端投影，前端不手写来源词表 / 覆盖词表。
'use client';

import { apiGet, apiPost } from '@/lib/api';

export type SourceKind = 'live_observation' | 'archived_observation' | 'licensed_dataset' | 'derived_event';
export type TimePrecision = 'exact' | 'day' | 'month' | 'captured_only' | 'unknown';
export type CoverageState = 'verified' | 'partial' | 'source_unavailable' | 'not_started' | 'unknown';

export interface MemoryFact {
  factId: string;
  entityId: string;
  entityName: string | null;
  entityType: 'product' | 'brand_catalog';
  factType: string;
  value: number | string | null;
  unit: string | null;
  currency: string | null;
  sourceKind: SourceKind;
  sourceKindText: string;
  measurementMethod: string;
  sourceStatus: string;
  comparable: boolean;
  timePrecision: TimePrecision;
  timePrecisionText: string;
  effectiveAt: string | null;
  observedAt: string;
  recordedAt: string;
  at: string;
  atBasis: 'effective_at' | 'observed_at';
  atBasisText: string;
  versionId: string;
  evidenceIds: string[];
  snapshotIds: string[];
  quality?: Record<string, unknown>;
}

export interface MemoryVersion {
  versionId: string;
  entityId: string;
  entityName: string | null;
  sourceKind: SourceKind;
  sourceKindText: string;
  sourceUrl: string | null;
  finalUrl: string | null;
  effectiveAt: string | null;
  observedAt: string;
  recordedAt: string;
  timePrecision: TimePrecision;
  timePrecisionText: string;
  evidenceIds: string[];
  snapshotIds: string[];
}

export interface MemoryCoverageDimension {
  key: string;
  displayName: string;
  entityType: string;
  state: CoverageState;
  stateText: string;
  earliestAvailableAt: string | null;
  lastSuccessAt: string | null;
  factCount: number;
  comparableCount: number;
  evidenceCount: number;
  snapshotCount: number;
  coveredRanges: { from: string; to: string }[];
  partialRanges: { from: string; to: string }[];
  unknownRanges: { from: string; to: string }[];
  bySourceKind: Record<string, number>;
}

export interface MemoryView {
  brandId: string;
  projectId: string;
  state: 'available' | 'not_started';
  stateText: string;
  facts: MemoryFact[];
  versions: MemoryVersion[];
  nextCursor: string | null;
  coverage: { product: MemoryCoverageDimension | null; catalog: MemoryCoverageDimension | null };
  note?: string;
  legend?: { sourceKinds: Record<string, string>; timePrecisions: Record<string, string> };
}

export interface TimelineItem {
  id: string;
  type: 'live_observation' | 'archived_observation' | 'derived_event' | 'coverage_gap';
  sourceKind: SourceKind | null;
  sourceKindText: string | null;
  eventType?: string;
  title: string;
  detail: string | null;
  at: string;
  atBasis: string;
  timePrecision: TimePrecision;
  timePrecisionText: string;
  effectiveAt: string | null;
  observedAt: string | null;
  evidenceIds: string[];
  snapshotIds: string[];
  derivedFromFactIds?: string[];
  entityId: string | null;
  entityName: string | null;
  entityCount?: number;
  sourceUrl?: string | null;
  dimension?: string;
  counts?: { productCount?: number | null; onSaleCount?: number | null };
}

export interface MemoryTimeline {
  brandId: string;
  projectId: string;
  state: 'available' | 'not_started';
  stateText: string;
  items: TimelineItem[];
  total: number;
  truncated: boolean;
  firstRecordedAt: string | null;
  firstObservedAt: string | null;
  emptyText: string | null;
  note: string;
  coverageSummary?: { state: CoverageState; stateText: string; factCount: number; evidenceCount: number } | null;
  legend?: Record<string, unknown>;
}

export interface BackfillJob {
  jobId: string;
  capability: string;
  sourceRoute: string;
  status: string;
  statusText: string;
  requested: { from: string; to: string };
  counts: { discovered: number; fetched: number; imported: number; skipped: number };
  coverageSummary?: {
    points?: string[];
    imported?: number;
    failed?: number;
    failedMonths?: string[];
    droppedByCap?: number;
    note?: string;
  } | null;
  failureClass: string | null;
  errorUserText: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: { totalMonths: number; doneMonths: number; percent: number; text: string };
}

export interface HistoryCoverage {
  brandId: string;
  projectId: string;
  window: { from: string; to: string };
  dimensions: MemoryCoverageDimension[];
  summary: {
    state: CoverageState;
    stateText: string;
    earliestAvailableAt?: string | null;
    lastSuccessAt?: string | null;
    factCount: number;
    evidenceCount: number;
  };
  backfill: BackfillJob | null;
  note: string;
}

export function fetchBrandMemory(
  brandId: string,
  opts: { projectId: string; from?: string; to?: string; entityType?: string; factTypes?: string[]; cursor?: string; limit?: number } = { projectId: '' },
  signal?: AbortSignal,
) {
  const q = new URLSearchParams({ projectId: opts.projectId });
  if (opts.from) q.set('from', opts.from);
  if (opts.to) q.set('to', opts.to);
  if (opts.entityType) q.set('entityType', opts.entityType);
  if (opts.factTypes && opts.factTypes.length) q.set('factTypes', opts.factTypes.join(','));
  if (opts.cursor) q.set('cursor', opts.cursor);
  if (opts.limit) q.set('limit', String(opts.limit));
  return apiGet<MemoryView>(`/api/brands/${encodeURIComponent(brandId)}/memory?${q.toString()}`, signal);
}

export function fetchBrandMemoryTimeline(
  brandId: string,
  opts: { projectId: string; from?: string; to?: string; limit?: number },
  signal?: AbortSignal,
) {
  const q = new URLSearchParams({ projectId: opts.projectId });
  if (opts.from) q.set('from', opts.from);
  if (opts.to) q.set('to', opts.to);
  if (opts.limit) q.set('limit', String(opts.limit));
  return apiGet<MemoryTimeline>(`/api/brands/${encodeURIComponent(brandId)}/timeline?${q.toString()}`, signal);
}

export function fetchHistoryCoverage(
  brandId: string,
  opts: { projectId: string; from?: string; to?: string },
  signal?: AbortSignal,
) {
  const q = new URLSearchParams({ projectId: opts.projectId });
  if (opts.from) q.set('from', opts.from);
  if (opts.to) q.set('to', opts.to);
  return apiGet<HistoryCoverage>(`/api/brands/${encodeURIComponent(brandId)}/history-coverage?${q.toString()}`, signal);
}

export function startHistoryBackfill(
  brandId: string,
  body: { projectId: string; capability: string; from: string; to: string },
) {
  return apiPost<{ jobId: string; deduped: boolean; job: BackfillJob; message: string }>(
    `/api/brands/${encodeURIComponent(brandId)}/history-backfill`, body);
}

export function fetchBackfillJob(jobId: string) {
  return apiGet<BackfillJob>(`/api/history-backfill/${encodeURIComponent(jobId)}`);
}

// 时间范围预设（纯 UI 选项，不含任何数据口径）
export type RangePreset = '30d' | '90d' | '1y' | 'all' | 'custom';
export function presetToRange(preset: RangePreset, earliest?: string | null): { from: string; to: string } | null {
  const to = new Date().toISOString().slice(0, 10);
  const back = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  if (preset === '30d') return { from: back(30), to };
  if (preset === '90d') return { from: back(90), to };
  if (preset === '1y') return { from: back(365), to };
  if (preset === 'all') return earliest ? { from: String(earliest).slice(0, 10), to } : null;
  return null;
}
