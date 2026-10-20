'use client';
// SourceBadge / TimePrecisionLabel / EvidenceButton（SC-05 §7.1）
// 🔴 词表纪律：来源标签与精度标签一律使用后端投影返回的 *_Text 字段，
//    组件内不维护第二套来源/精度词表（避免后端改了文案前端不跟随）。
import type { SourceKind, TimePrecision } from '@/lib/memory-api';

const FALLBACK_SOURCE: Record<SourceKind, string> = {
  live_observation: '直接观察',
  archived_observation: '历史存档观察',
  licensed_dataset: '授权数据服务',
  derived_event: '系统推导事件',
};
const FALLBACK_PRECISION: Record<TimePrecision, string> = {
  exact: '精确到时刻', day: '精确到日', month: '精确到月', captured_only: '仅采集时可知', unknown: '时间无法确认',
};

export function SourceBadge({ kind, text }: { kind: SourceKind | null; text?: string | null }) {
  if (!kind) return null;
  const label = text || FALLBACK_SOURCE[kind] || kind;
  const cls = 'mem-badge mem-badge-' + kind.replace(/_/g, '-');
  const title = kind === 'derived_event'
    ? '由已验证时序事实确定性计算的变化，不是新的来源'
    : kind === 'archived_observation'
      ? '来自公开网页存档的历史版本；时间取存档快照时间'
      : kind === 'live_observation'
        ? 'Vantage 本次直接采集该页面'
        : '合规数据服务返回';
  return <span className={cls} title={title}>{label}</span>;
}

export function TimePrecisionLabel({ precision, text }: { precision: TimePrecision; text?: string | null }) {
  if (!precision) return null;
  const label = text || FALLBACK_PRECISION[precision] || precision;
  return <span className="mem-precision" title="该条时间信息的精度">{label}</span>;
}

// 时间展示：发生时间优先（effective），否则明确写成「Vantage 观察到」
export function TimeText({ at, basis, precisionText }: { at: string; basis: string; precisionText?: string | null }) {
  const day = String(at || '').slice(0, 10);
  if (!day) return null;
  const isEffective = basis === 'effective_at';
  return (
    <span className="mem-time">
      {isEffective ? day : <>{day}<span className="mem-time-pre">（观察到）</span></>}
      {precisionText ? <span className="mem-time-pre">（{precisionText}）</span> : null}
    </span>
  );
}
