'use client';
// 状态组件 + 新鲜度（SC-02 §7：颜色之外必须有文字和图标；04 §20 不暴露内部码）
import type { SurfaceState } from './types';

const STATE_META: Record<SurfaceState, { icon: string; text: string; cls: string }> = {
  ok: { icon: '✓', text: '数据正常', cls: 'ok' },
  loading: { icon: '◐', text: '采集中', cls: 'loading' },
  failed: { icon: '✕', text: '采集失败', cls: 'failed' },
  empty: { icon: '○', text: '尚未采集', cls: 'empty' },
  partial: { icon: '◔', text: '部分覆盖', cls: 'partial' },
  stale: { icon: '◷', text: '数据过期', cls: 'stale' },
  unsupported: { icon: '⃠', text: '暂未接入', cls: 'unsupported' },
};

export function SurfaceStateBadge({ state }: { state: SurfaceState }) {
  const m = STATE_META[state] || STATE_META.unsupported;
  return (
    <span className={'ds-badge ds-' + m.cls}>
      <span className="ds-badge-icon" aria-hidden>{m.icon}</span>
      <span>{m.text}</span>
    </span>
  );
}

export function FreshnessBadge({ freshness }: { freshness?: { status: string; slaHours: number | null; lastSuccessAt: string | null } | null }) {
  if (!freshness || freshness.status === 'unknown' || !freshness.lastSuccessAt) {
    return <span className="ds-fresh ds-fresh-unk"><span aria-hidden>◌</span> 新鲜度未知</span>;
  }
  const d = new Date(freshness.lastSuccessAt);
  const hoursAgo = Math.max(0, Math.round((Date.now() - d.getTime()) / 3600e3));
  const when = hoursAgo < 1 ? '1 小时内' : hoursAgo < 48 ? `${hoursAgo} 小时前` : `${Math.round(hoursAgo / 24)} 天前`;
  if (freshness.status === 'stale') {
    return <span className="ds-fresh ds-fresh-stale"><span aria-hidden>◷</span> {when}更新 · 超过新鲜度时限</span>;
  }
  return <span className="ds-fresh ds-fresh-ok"><span aria-hidden>✓</span> {when}更新</span>;
}