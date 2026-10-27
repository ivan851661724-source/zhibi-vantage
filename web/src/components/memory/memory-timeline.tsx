'use client';
// 历史时间线（SC-05 §7.2）：直接观察 / 历史存档观察 / 系统推导事件 / 覆盖缺口。
// 不显示 attempt、snapshot id、文件路径或技术状态名。
import { useState } from 'react';
import type { MemoryTimeline } from '@/lib/memory-api';
import { SourceBadge, TimeText } from './badges';
import { refsOf, type EvidenceRef } from './price-track';

export function MemoryTimelineList({
  data, onEvidence,
}: {
  data: MemoryTimeline;
  onEvidence: (refs: EvidenceRef[]) => void;
}) {
  const [filter, setFilter] = useState<'all' | 'live_observation' | 'archived_observation' | 'derived_event' | 'coverage_gap'>('all');
  const items = (data.items || []).filter(i => filter === 'all' || i.type === filter);
  const counts = {
    live: (data.items || []).filter(i => i.type === 'live_observation').length,
    archived: (data.items || []).filter(i => i.type === 'archived_observation').length,
    derived: (data.items || []).filter(i => i.type === 'derived_event').length,
    gap: (data.items || []).filter(i => i.type === 'coverage_gap').length,
  };

  if (!data.items || !data.items.length) {
    return (
      <div className="mem-empty">
        <p><b>尚未形成可核验历史记录</b></p>
        <p className="hint">
          {data.emptyText || '系统从首次成功采集开始积累，不会为没有证据的时间段补造记录。'}
          {data.firstRecordedAt ? ' 首次写入时间：' + String(data.firstRecordedAt).slice(0, 10) + '。' : ''}
        </p>
      </div>
    );
  }

  return (
    <div className="mem-timeline">
      <div className="mem-tl-filters" role="group" aria-label="时间线筛选">
        <button type="button" className={'mem-tl-filter' + (filter === 'all' ? ' on' : '')} onClick={() => setFilter('all')}>
          全部 {data.items.length}
        </button>
        <button type="button" className={'mem-tl-filter' + (filter === 'live_observation' ? ' on' : '')} onClick={() => setFilter('live_observation')}>
          直接观察 {counts.live}
        </button>
        <button type="button" className={'mem-tl-filter' + (filter === 'archived_observation' ? ' on' : '')} onClick={() => setFilter('archived_observation')}>
          历史存档 {counts.archived}
        </button>
        <button type="button" className={'mem-tl-filter' + (filter === 'derived_event' ? ' on' : '')} onClick={() => setFilter('derived_event')}>
          推导事件 {counts.derived}
        </button>
        <button type="button" className={'mem-tl-filter' + (filter === 'coverage_gap' ? ' on' : '')} onClick={() => setFilter('coverage_gap')}>
          覆盖缺口 {counts.gap}
        </button>
      </div>
      <ol className="mem-tl-list">
        {items.map(it => (
          <li key={it.id} className={'mem-tl-item mem-tl-' + it.type}>
            <div className="mem-tl-top">
              <TimeText at={it.at} basis={it.atBasis} precisionText={it.timePrecisionText} />
              {it.sourceKind ? <SourceBadge kind={it.sourceKind} text={it.sourceKindText} /> : <span className="mem-badge mem-badge-gap">覆盖缺口</span>}
              {/* 核验状态：有证据 / 推导待核验 / 无证据 —— 每条都必须让用户能判断可信度 */}
              {it.type !== 'coverage_gap' ? (
                it.evidenceIds && it.evidenceIds.length
                  ? <span className="core-badge core-badge-ok">有证据</span>
                  : <span className="core-badge core-badge-warn">{it.type === 'derived_event' ? '推导·待核验' : '无证据'}</span>
              ) : null}
              {/* 首次观察是档案起点，不是「变化」——绝不伪装成变化 */}
              {it.eventType === 'product_first_observed' ? <span className="core-badge core-badge-neutral">首次观察 · 档案起点</span> : null}
            </div>
            <div className="mem-tl-title">{it.title}</div>
            {it.detail ? <div className="mem-tl-detail">{it.detail}</div> : null}
            {it.evidenceIds && it.evidenceIds.length ? (
              <button type="button" className="mem-ev-btn" onClick={() => onEvidence(refsOf(it))}>查看证据</button>
            ) : null}
            {it.sourceUrl ? (
              <a className="mem-tl-src" href={it.sourceUrl} target="_blank" rel="noreferrer noopener">打开原始来源 ↗</a>
            ) : null}
          </li>
        ))}
      </ol>
      {data.truncated ? <p className="hint">已显示最近 {items.length} 条，缩小时间范围可看到更早记录。</p> : null}
      <p className="hint">{data.note}</p>
    </div>
  );
}
