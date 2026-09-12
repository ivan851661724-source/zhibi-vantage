// 知彼 Vantage · state 类型（对齐后端 /api/state 返回结构，docs/02-API契约.md）
// Phase 1 宽松建模：未知字段用 unknown 兜底，面板迁移时逐字段收紧。
'use client';

export interface Competitor {
  id: string;
  name: string;
  status?: string;
  priceField?: {
    display?: string;
    basis?: string;
    confidence?: string;
  } | null;
  channelFields?: Record<string, unknown>;
  reviewField?: { rating?: { value?: number | string } } | null;
  pendingCorrections?: unknown[];
  [key: string]: unknown;
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
  [key: string]: unknown;
}
