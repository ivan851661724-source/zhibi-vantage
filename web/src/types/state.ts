// 知彼 Vantage · state 类型（对齐后端 /api/state 返回结构，docs/architecture/02_现行API契约.md）
// Phase 1 宽松建模：未知字段用 unknown 兜底，面板迁移时逐字段收紧。
'use client';

/** 本次已观察目录的派生统计；不参与旧 S3 资格或私有字段裁决。 */
export interface PriceMetricSummary {
  metric_id: string;
  metric_type: 'catalog_active_product_price';
  evidence_status: 'derived';
  algorithm_version: string;
  config_version: string;
  computed_at: string;
  observed_from: string | null;
  observed_to: string | null;
  currency: string | null;
  market: string | null;
  unit: string | null;
  value: { p25: number | null; median: number | null; p75: number | null };
  sample_product_count: number;
  product_counts: { observed: number; active_paid: number; free: number; unknown_availability: number; sold_out: number; invalid: number; missing_price: number };
  variant_counts: { observed: number; active_paid: number; active_free: number; unknown_availability: number; sold_out: number; invalid: number };
  partial_scan: boolean;
  limitations: string[];
}

export interface PriceChainIssue { kind: string; id: string; reason: string }
export interface PriceCollectionIssue { snapshot_id: string; source_status: string; reason: string | null; empty: boolean }
export interface PriceSourceSnapshot {
  snapshot_id: string;
  provider?: string | null;
  source_url?: string | null;
  observed_at?: string | null;
  source_updated_at?: string | null;
  collected_at?: string | null;
  fetched_at?: string | null;
  source_status?: string | null;
  content_hash?: string | null;
  collector_version?: string | null;
  parser_version?: string | null;
  raw_resolvable?: boolean;
}
export interface PriceObservationValue {
  price_min?: number | null;
  price_max?: number | null;
  prices?: { variant_id?: string | null; title?: string | null; price?: number | null; available?: boolean | null }[];
}
export interface PriceFact {
  fact_id: string;
  entity_key?: string | null;
  entity_ref?: { product_id?: string | null; title?: string | null } | null;
  claim?: { field?: string; scope?: string };
  value: PriceObservationValue | null;
  currency?: string | null;
  market?: string | null;
  unit?: string | null;
  observed_at?: string | null;
  evidence_ids: string[];
  source_snapshot_ids: string[];
  derivation_version?: string | null;
}
export interface PriceEvidence {
  evidence_id: string;
  claim?: { field?: string; scope?: string };
  extracted_value: PriceObservationValue | null;
  evidence_status?: string | null;
  reason_code?: string | null;
  source?: string | null;
  provider?: string | null;
  observed_at?: string | null;
  source_updated_at?: string | null;
  collected_at?: string | null;
  currency?: string | null;
  market?: string | null;
  unit?: string | null;
  parser_version?: string | null;
  extractor_version?: string | null;
  source_snapshot_ids: string[];
}
export interface PriceEvidenceDetail {
  evidence: PriceEvidence;
  snapshots: PriceSourceSnapshot[];
  issues: PriceChainIssue[];
}
export interface PriceMetricPage {
  metric: PriceMetricSummary & {
    fact_ids: string[]; evidence_ids: string[]; source_snapshot_ids: string[]; collection_snapshot_ids: string[];
    config: Record<string, unknown>; collection_issues?: PriceCollectionIssue[];
  };
  facts: PriceFact[];
  evidences: PriceEvidence[];
  snapshots: PriceSourceSnapshot[];
  issues: PriceChainIssue[];
  collectionIssues: PriceCollectionIssue[];
  offset: number;
  limit: number;
  total: number;
  nextOffset: number | null;
  hasMore: boolean;
}

export interface Competitor {
  id: string;
  name: string;
  /** Exact server-owned references; optional until trusted producers are connected. */
  brand_id?: string | null;
  current_qualification_result_id?: string | null;
  category_scope?: string | null;
  status?: string;
  priceField?: {
    display?: string;
    basis?: string;
    confidence?: string;
  } | null;
  priceMetric?: PriceMetricSummary | null;
  /** 商品价格统计（Shopify 实抓才有，不是订单级 AOV） */
  priceStats?: {
    median?: number | null;
    band?: { min?: number; max?: number } | null;
    currency?: string | null;
    basis?: string;
    truncatedBy?: string | null;
    multiPeak?: boolean;
    sample?: {
      total?: number; onSale?: number; used?: number; dropped?: number;
      soldOut?: number; free?: number;
      dropList?: { title?: string; price?: number; reason?: string }[];
    };
    verdict?: { code?: string; note?: string; pendingHuman?: boolean };
  } | null;
  /** 商品目录仅取得部分页面；不是整个监控窗口的 Coverage 状态。 */
  shopifyPartialScan?: boolean;
  shopifyPartialScanReason?: string | null;
  shopifyTruncated?: boolean;
  /** S3 价格带判定（in_band/above/below/partial/pending/insufficient/undetermined/no_target） */
  priceVerdict?: { code?: string; note?: string; pendingHuman?: boolean } | null;
  /** 全变体不可售款数（断货信号数据基础，规格 5.2） */
  soldOutCount?: number;
  /** product_type 结构化类目占比（S2 数据基础） */
  typeDist?: { total?: number; unclassified?: number; items?: { type: string; n: number }[] } | null;
  channelFields?: Record<string, unknown>;
  reviewField?: { rating?: { value?: number | string } } | null;
  pendingCorrections?: unknown[];
  [key: string]: unknown;
}

export interface MonitoringWorkspace {
  workspace_id: string; name: string; market: string; target_market_timezone: string; revision: number;
}
export interface MonitoringResult {
  completed_at: number; source_status: string; partial_scan: boolean; issues: string[];
  event_ids: string[]; price_metric: PriceMetricSummary | null;
  source_results: { source_status: string; observed_at: string | null }[];
}
export interface MonitoringTarget {
  watch_target_id: string; workspace_id: string; project_id: string; competitor_id: string;
  brand_id: string; current_qualification_result_id: string;
  market: string; category_scope: string; target_market_timezone: string;
  monitoring_status: 'inactive' | 'active' | 'degraded' | 'paused';
  effective: { executable: boolean; issues: string[] };
  next_slot: { scheduled_at: number; window_key: string } | null;
  latest_result: MonitoringResult | null;
}
export interface MonitoringJob {
  job_id: string; watch_target_id: string; status: 'pending' | 'running' | 'done' | 'error' | 'dead';
  scheduled_at: number; schedule_lag?: number | null; lag_warning?: boolean; degraded_candidate?: boolean;
  source_status?: string | null; result?: { reason?: string; issues?: string[] } | null;
  discarded?: { reason: string } | null;
}
/** Durable job-attempt inputs, not a completed daily/weekly window. Null is unknown. */
export interface MonitoringCoverage {
  coverage_id: string; schema_version: number;
  tenant_id: string; workspace_id: string; project_id: string; competitor_id: string;
  watch_target_id: string; revision: number; job_id: string; attempt: number;
  category_scope: string; market: string; target_market_timezone: string;
  completed_at: number; source_status: string; partial_scan: boolean | null;
  expected_targets: number | null; attempted_targets: number | null;
  successful_targets: number | null; qualified_successful_targets: number | null; failed_targets: number | null;
  required_capabilities: string[] | null; missing_capabilities: string[] | null;
  window_start: number | null; window_end: number | null; window_complete: boolean | null;
  freshness_status: string | null; policy_version: string | null;
  source_results: { snapshot_id: string | null; source_status: string; observed_at: string | null; partial_scan: boolean | null }[];
  source_failures: { snapshot_id: string | null; source_status: string; reason?: string | null }[];
  comparisons: { fact_id: string; status: string | null; reason: string | null; diff_id: string | null; event_id: string | null }[];
  issues: string[]; quiet: { allowed: boolean; reasons: string[] };
}
/** Server-owned observed event projection; station visibility grants no external eligibility. */
export interface MonitoringEventProjection {
  notification_id: string; projection_version: number;
  tenant_id: string; workspace_id: string; project_id: string; competitor_id: string;
  watch_target_id: string; revision: number; job_id: string; attempt: number; coverage_id: string;
  event_id: string; event_type: 'price_change_observed'; diff_id: string; old_fact_id: string; new_fact_id: string;
  old_evidence_ids: string[]; new_evidence_ids: string[]; old_snapshot_ids: string[]; new_snapshot_ids: string[];
  old_value: { price_min: number; price_max: number }; new_value: { price_min: number; price_max: number };
  old_price: number | null; new_price: number | null; direction: string | null; delta: number | null; pct: number | null;
  currency: string | null; market: string | null; importance: null;
  observed_at_old: string | null; observed_at_new: string | null; occurred_at: string; enqueue_at: number;
  accepted_at: null; delivered_at: null; failed_at: null;
  external_delivery_blocked: true; external_delivery_reasons: string[]; limitations: string[];
  event_detail_api: string;
  view: { from: string; to: string; changed_boundary: string | null; change_label: string };
}
export interface MonitoringEventDetail {
  event: { event_id: string; event_type: string; diff_id: string; old_fact_id: string; new_fact_id: string };
  diff: { diff_id: string } | null;
  facts: { old: { fact_id: string } | null; new: { fact_id: string } | null };
  evidences: { evidence_id: string }[];
  snapshots: { snapshot_id: string; source_url?: string | null; source_status?: string | null; observed_at?: string | null }[];
}
export interface MonitoringStatus {
  enabled: boolean; running: boolean; issues: string[]; limitations: string[];
  targets: MonitoringTarget[]; jobs: MonitoringJob[];
  gaps: { watch_target_id: string; reason: string; from: number; to: number }[];
  backpressure: boolean; offset: number; limit: number; total_targets: number; total_jobs: number;
  /** Additive fields: absent on older servers/fixtures, never inferred as zero. */
  coverage?: MonitoringCoverage[]; total_coverage?: number;
  event_projections?: MonitoringEventProjection[]; total_event_projections?: number;
}

export interface Material {
  id: string;
  status?: string;
  [key: string]: unknown;
}

export interface WhiteSpace {
  version?: string;
  gaps?: unknown[];
  coverage?: unknown;
  [key: string]: unknown;
}

export interface ZhibiState {
  projectId?: string;
  competitors?: Competitor[];
  materials?: Material[];
  fieldCorrections?: unknown[];
  whiteSpace?: WhiteSpace | null;
  sig?: string;
  track?: string;
  /** F-2（B-4 异步契约）：brief 生成任务状态——POST /api/brief 回 202 后轮询本字段至终态 */
  briefStatus?: 'running' | 'done' | 'failed';
  /** brief 报告本体（briefStatus === 'done' 时落库） */
  brief?: unknown;
  /** brief 生成失败原因（briefStatus === 'failed' 时存在） */
  briefError?: string;
  /** brief 任务受理时刻（ms）。前端据此判僵尸态：running 超 15 分钟无终态视为中断，提示重试 */
  briefStartedAt?: number;
  [key: string]: unknown;
}
