// 前端展示纯逻辑（UI 框架轮）——无 React 依赖、无副作用，
// 可被 `node --test --experimental-strip-types` 直接测试（禁 enum/namespace 等需转换语法）。
// 纪律：未接入≠零值；尚未采集≠未发现数据；无证据不得呈现「已核实」。
import type { BrandListItem, IntelItem, ReportListItem } from './core-api';

// ---------- 品牌级覆盖状态（竞品库卡片徽章） ----------
export type BrandCoverState = 'collecting' | 'hasData' | 'partial' | 'failed' | 'notCollected' | 'notIntegrated';

export const BRAND_COVER_TEXT: Record<BrandCoverState, string> = {
  collecting: '采集中',
  hasData: '已采集',
  partial: '部分采集',
  failed: '最近采集失败',
  notCollected: '尚未采集',
  notIntegrated: '未接入',
};

/** 从维度级状态推导品牌级状态（一次遍历，确定性；任一采集中优先展示进行中） */
export function brandCoverState(b: Pick<BrandListItem, 'coverageDimensions'>): BrandCoverState {
  const dims = b.coverageDimensions || [];
  const integrated = dims.filter((d) => d.state !== 'unsupported');
  if (!integrated.length) return 'notIntegrated'; // 全部维度未接入
  const s = new Set(integrated.map((d) => d.state));
  if (s.has('loading')) return 'collecting';
  const hasData = s.has('ok') || s.has('stale') || s.has('partial');
  if (hasData) {
    return s.has('unknown') || s.has('empty') || s.has('failed') ? 'partial' : 'hasData';
  }
  if (s.has('failed')) return 'failed'; // 已接入但最近采集失败、无可展示数据
  return 'notCollected'; // 已接入但尚未采集（≠该品牌没有数据）
}

// ---------- 情报库顶部摘要统计 ----------
export interface IntelSummary {
  verified: number;
  pending: number;
  gaps: number;
  insufficient: number;
}

/** 可核实=后端仅在证据齐备时标记 verified；资料缺口按类型单列 */
export function intelSummary(items: IntelItem[]): IntelSummary {
  let verified = 0;
  let pending = 0;
  let gaps = 0;
  let insufficient = 0;
  for (const it of items) {
    if (it.type === 'gap') {
      gaps += 1;
      continue;
    }
    if (it.status === 'verified') verified += 1;
    else if (it.status === 'pending') pending += 1;
    else insufficient += 1;
  }
  return { verified, pending, gaps, insufficient };
}

// ---------- 报告状态五态（列表展示；重试进度由后端 retryCount 透出） ----------
export type ReportUiStatus = 'queued' | 'running' | 'retrying' | 'success' | 'failed';

export const REPORT_STATUS_TEXT: Record<ReportUiStatus, string> = {
  queued: '排队中',
  running: '生成中',
  retrying: '自动重试中',
  success: '已完成',
  failed: '生成失败',
};

export function reportUiStatus(r: Pick<ReportListItem, 'status' | 'retryCount'>): ReportUiStatus {
  if (r.status === 'queued' && (r.retryCount || 0) > 0) return 'retrying';
  if (r.status === 'running' && (r.retryCount || 0) > 0) return 'retrying';
  return r.status;
}

// ---------- 报告章节（与后端 REPORT_ALL_SECTIONS 顺序对齐，测试中有契约断言防漂移） ----------
export interface ReportSectionMeta {
  code: string;
  label: string;
  desc: string;
}

export const REPORT_SECTIONS: ReportSectionMeta[] = [
  { code: 'overview', label: '总览', desc: '品牌范围与数据基础' },
  { code: 'problems', label: '问题清单', desc: '已观察到的问题点' },
  { code: 'opportunities', label: '机会线索', desc: '当前样本下的待验证线索' },
  { code: 'judgment', label: '综合判断', desc: '基于冻结事实的综合结论' },
  { code: 'facts', label: '事实清单', desc: '进入报告的全部事实与来源' },
  { code: 'gaps', label: '资料缺口', desc: '未采集与未接入的说明' },
];

export const REPORT_DEFAULT_SECTIONS: string[] = ['overview', 'problems', 'opportunities', 'judgment'];

// ---------- 竞品库空状态三分 ----------
export type BrandsEmptyKind = 'noBrands' | 'noneCollected' | 'noFilterResult';

/** 列表为空时的空状态归类（调用方约定：仅在 items.length === 0 时调用） */
export function brandsEmptyKind(hasActiveFilter: boolean): BrandsEmptyKind {
  return hasActiveFilter ? 'noFilterResult' : 'noBrands';
}

/** 无筛选且列表非空时，判断是否属于「已添加但全部尚未采集」 */
export function allBrandsNotCollected(items: BrandListItem[]): boolean {
  return items.length > 0 && !items.some((b) => (b.coverageSummary.dimensionsWithData || 0) > 0);
}
