'use client';
// 统一覆盖/时间线/情报展示组件（SC-04）——所有新页面复用同一证据与状态表达。
// 纪律：不展示服务器路径、内部错误码、栈、密钥；未接入≠零值；尚未采集≠未发现数据。
import { useState } from 'react';
import type { Coverage, CoverageDimension, IntelItem, TimelineEvent } from '@/lib/core-api';
import { COVER_STATE_TEXT } from '@/lib/core-api';

export function CoveragePanel({ coverage }: { coverage: Coverage }) {
  return (
    <div className="core-cov">
      <div className="core-cov-sum">
        <span>已接入 {coverage.summary.integratedDimensions}/{coverage.summary.totalDimensions} 个维度</span>
        <span>有数据 {coverage.summary.dimensionsWithData} 个</span>
        {coverage.summary.notIntegrated.length ? <span>未接入：{coverage.summary.notIntegrated.length} 个</span> : null}
      </div>
      <ul className="core-dim-list">
        {coverage.dimensions.map((d: CoverageDimension) => (
          <li key={d.code} className={`core-dim core-dim-${d.state}`}>
            <span className="core-dim-name">{d.displayName}</span>
            <span className="core-dim-state">{COVER_STATE_TEXT[d.state] || d.stateText}</span>
            {d.lastObservedAt ? <span className="core-dim-at">最近观察：{new Date(d.lastObservedAt).toLocaleString()}</span> : null}
            {d.note ? <span className="core-dim-note">{d.note}</span> : null}
          </li>
        ))}
      </ul>
      <p className="hint">未接入的维度不提供任何数据或估算；尚未采集不等于未发现数据。</p>
    </div>
  );
}

export function TimelineList({ events, firstObservedAt, note }: { events: TimelineEvent[]; firstObservedAt?: string | null; note?: string }) {
  if (!events.length) {
    return <p className="hint">尚未采集，暂无时间线记录（不等于该品牌没有变化）。</p>;
  }
  return (
    <div className="core-tl">
      {firstObservedAt ? <p className="hint">开始观察日期：{new Date(firstObservedAt).toLocaleString()}{note ? ` · ${note}` : ''}</p> : null}
      <ul>
        {events.map(e => (
          <li key={e.eventId}>
            <span className="core-tl-at">{new Date(e.at).toLocaleString()}</span>
            <span className="core-tl-kind">{e.typeText || e.kindText || e.kind}</span>
            <span className="core-tl-nature">{e.natureText}</span>
            <span className="core-tl-title">{e.title}</span>
            {e.detail ? <span className="core-tl-detail">{e.detail}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function IntelList({ items, onCorrect }: { items: IntelItem[]; onCorrect?: (item: IntelItem) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return <p className="hint">暂无情报项（可能尚未采集或该维度未接入）。</p>;
  return (
    <ul className="core-intel">
      {items.map(it => (
        <li key={it.id} className={`core-intel-${it.status}`}>
          <div className="core-intel-head">
            <span className="core-intel-at">{new Date(it.at).toLocaleString()}</span>
            <span className="core-intel-type">{it.typeText}</span>
            <span className="core-intel-title">{it.title}</span>
            <span className="core-intel-nature">{it.natureText}</span>
            <span className="core-intel-status">{it.statusText}</span>
          </div>
          {it.detail ? <p className="core-intel-detail">{it.detail}</p> : null}
          <div className="core-intel-acts">
            {it.evidence.length ? (
              <button type="button" className="btn-mini" onClick={() => setOpen(open === it.id ? null : it.id)}>
                证据入口（{it.evidence.length}）
              </button>
            ) : <span className="core-intel-noev">无 Evidence（不标记已核实）</span>}
            {onCorrect && it.correctionEndpoint ? (
              <button type="button" className="btn-mini" onClick={() => onCorrect(it)}>发现数据有误？</button>
            ) : null}
          </div>
          {open === it.id ? (
            <ul className="core-intel-ev">
              {it.evidence.map(ev => (
                <li key={ev.evidenceId}>
                  <span>Evidence {ev.evidenceId}</span>
                  <span>状态 {ev.evidenceStatus || '—'}</span>
                  {ev.observedAt ? <span>观察 {new Date(ev.observedAt).toLocaleString()}</span> : null}
                  {(ev.snapshotIds || []).length ? <span>快照 {(ev.snapshotIds || []).length} 个</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
