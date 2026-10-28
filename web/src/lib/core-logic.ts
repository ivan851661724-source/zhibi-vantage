// 前端展示纯逻辑（UI 框架轮）——无 React 依赖、无副作用，
// 可被 `node --test --experimental-strip-types` 直接测试（禁 enum/namespace 等需转换语法）。
// 纪律：未接入≠零值；尚未采集≠未发现数据；无证据不得呈现「已核实」。
import type { BrandListItem, IntelItem, ReportListItem } from './core-api';

// ---------- 品牌级覆盖状态（竞品库卡片徽章） ----------
// SC-08 r2 §六：品牌级状态直接读后端唯一投影 brandCoverage.summary（不再由前端二次推导，
// 避免「同一事实两套口径」）。这里只做显示名的映射。
export type BrandCoverState = 'collecting' | 'hasData' | 'partial' | 'failed' | 'notCollected' | 'notIntegrated';

export const BRAND_COVER_TEXT: Record<BrandCoverState, string> = {
  collecting: '正在采集',
  hasData: '已有数据',
  partial: '部分维度有数据',
  failed: '需要处理',
  notCollected: '尚未开始采集',
  notIntegrated: '来源未接入',
};

/** 从后端 brandCoverage.summary 归纳品牌级状态（确定性；进行中优先） */
export function brandCoverState(b: Pick<BrandListItem, 'brandCoverage'>): BrandCoverState {
  const sum = (b && b.brandCoverage && b.brandCoverage.summary) || null;
  if (!sum || !sum.total) return 'notCollected';
  if (sum.collecting > 0) return 'collecting';
  if (sum.failed > 0) return 'failed';
  const configured = sum.total - (sum.notConfigured || 0);
  if (configured <= 0) return 'notIntegrated';
  if (sum.available > 0) return sum.available < configured ? 'partial' : 'hasData';
  return 'notCollected';
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
  // 只有「全部品牌都还没开始采集」才用首轮采集引导空态。
  // 采集失败 / 正在采集 / 有数据 都必须显示卡片——否则「需要处理」的品牌会被空态吞掉。
  return items.length > 0 && items.every((b) => brandCoverState(b) === 'notCollected');
}

// ---------- 用户可读枚举（禁止把内部英文码直接显示给用户） ----------
export const RELATION_TEXT: Record<string, string> = {
  direct: '直接竞品',
  indirect: '间接竞品',
  emerging: '新兴竞品',
  competitor: '竞品',
};
// SC-12 §三.3：品牌卡片短状态词表（与后端 brand-service.cardStatusOf 同口径）
// 规则：只给短状态词与一句短提示；不出现 attempt / source_status / internal_error 等内部码。
export const CARD_STATUS_TEXT: Record<string, string> = {
  // r3：SourceHealth 十态（后端唯一投影；卡片直接显示后端给的 text，这里兜底用）
  not_started: '尚未开始采集',
  probing: '正在采集',
  available: '已有可核验数据',
  monitoring: '正式监控中',
  limited: '仅能监控部分信号',
  retryable: '本次未完成，会自动重试',
  blocked: '来源拒绝访问',
  not_configured: '数据服务暂不可用',
  out_of_coverage: '不覆盖当前市场',
  unsupported: '暂不支持该来源',
  updated: '已更新',
  partial: '部分数据待更新',
  collecting: '正在采集',
  stale: '已有历史数据，最近更新失败',
  source_unreachable: '来源暂时不可达',
  source_blocked: '来源拒绝了本次访问',
  source_rate_limited: '来源访问频率受限',
  source_parse_failed: '来源内容暂时无法解析',
  needs_attention: '采集未完成，需要重试',
  awaiting_config: '等待系统数据服务配置',
};

export function relationText(r: string | null | undefined): string {
  const k = String(r || '').trim().toLowerCase();
  if (!k) return '竞品';
  return RELATION_TEXT[k] || String(r);
}

export const MARKET_TEXT: Record<string, string> = {
  us: '美国', uk: '英国', eu: '欧洲', cn: '中国', jp: '日本', sea: '东南亚', ca: '加拿大', au: '澳大利亚',
};
export function marketText(m: string | null | undefined): string {
  const k = String(m || '').trim().toLowerCase();
  if (!k) return '';
  return MARKET_TEXT[k] || String(m);
}
