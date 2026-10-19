'use client';
// 统一覆盖/时间线/情报展示组件（SC-04）——所有核心页面复用同一证据与状态表达。
// 纪律：不展示服务器路径、内部错误码、栈、密钥；未接入≠零值；尚未采集≠未发现数据；
// 无证据引用的事件/情报一律「待核实」，不得使用「已核实」样式。
import { useState } from 'react';
import type { Coverage, CoverageDimension, IntelItem, TimelineEvent } from '@/lib/core-api';
import { COVER_STATE_TEXT } from '@/lib/core-api';

// 覆盖状态徽章语义（不引入内部枚举名）
const TL_STATUS: Record<string, { text: string; cls: string }> = {
  verified: { text: '已核实', cls: 'ok' },
  pending: { text: '待核实', cls: 'warn' },
  insufficient: { text: '资料不足', cls: 'bad' },
};

// ---------- 数据覆盖面板 ----------
// compact：概览区只显示汇总；hideUnsupported：未接入维度交由「建设中维度」区域统一展示。
export function CoveragePanel({ coverage, compact, hideUnsupported }: { coverage: Coverage; compact?: boolean; hideUnsupported?: boolean }) {
  const dims = (coverage.dimensions || []).filter(d => !hideUnsupported || d.state !== 'unsupported');
  const buildingCount = (coverage.summary.notIntegrated || []).length;
  return (
    <div className="core-cov">
      <div className="core-cov-sum">
        <span>已接入 {coverage.summary.integratedDimensions}/{coverage.summary.totalDimensions} 个维度</span>
        <span>有数据 {coverage.summary.dimensionsWithData} 个</span>
        {buildingCount ? <span>建设中 {buildingCount} 个维度（尚未接入，不生成数据）</span> : null}
        {!coverage.summary.notCollected.length ? null : <span>已接入未采集 {coverage.summary.notCollected.length} 个</span>}
      </div>
      {compact ? null : (
        <ul className="core-dim-list">
          {dims.map((d: CoverageDimension) => (
            <li key={d.code} className={`core-dim core-dim-${d.state}`}>
              <span className="core-dim-name">{d.displayName}</span>
              <span className="core-dim-state">{COVER_STATE_TEXT[d.state] || d.stateText}</span>
              {d.lastObservedAt ? <span className="core-dim-at">最近观察：{new Date(d.lastObservedAt).toLocaleString()}</span> : null}
              {d.note ? <span className="core-dim-note">{d.note}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {!compact ? <p className="hint">未接入的维度不提供任何数据或估算；尚未采集不等于未发现数据。</p> : null}
    </div>
  );
}

// ---------- 竞争动态时间线（已核实 / 待核实 / 资料不足 + 证据展开） ----------
export function TimelineList({ events, firstObservedAt, note }: { events: TimelineEvent[]; firstObservedAt?: string | null; note?: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!events.length) {
    return <p className="hint">尚未采集，暂无时间线记录（不等于该品牌没有变化）。</p>;
  }
  return (
    <div className="core-tl">
      {firstObservedAt ? <p className="hint">开始观察日期：{new Date(firstObservedAt).toLocaleString()}{note ? ` · ${note}` : ''}</p> : null}
      <ul>
        {events.map(e => {
          const st = TL_STATUS[e.status || ''] || { text: e.statusText || '待核实', cls: 'warn' };
          const evIds = (e.payload && e.payload.evidenceIds) || [];
          return (
            <li key={e.eventId} className="core-tl-item">
              <div className="core-tl-row">
                <span className="core-tl-at">{new Date(e.at).toLocaleString()}</span>
                <span className="core-tl-kind">{e.typeText || e.kindText || e.kind}</span>
                <span className="core-tl-nature">{e.natureText}</span>
                <span className={`core-tl-status core-tl-status-${st.cls}`}>{st.text}</span>
                <span className="core-tl-title">{e.title}</span>
              </div>
              {e.detail ? <span className="core-tl-detail">{e.detail}</span> : null}
              {evIds.length ? (
                <div className="core-tl-acts">
                  <button type="button" className="btn-mini" onClick={() => setOpen(open === e.eventId ? null : e.eventId)}>
                    证据记录（{evIds.length}）
                  </button>
                </div>
              ) : null}
              {open === e.eventId && evIds.length ? (
                <ul className="core-tl-ev">
                  {evIds.map(id => <li key={id}>证据记录 {id}（原始快照可在「数据覆盖与来源」中核对）</li>)}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---------- 情报列表（证据入口 + 纠错入口；无证据不得标已核实） ----------
export function IntelList({ items, onCorrect }: { items: IntelItem[]; onCorrect?: (item: IntelItem) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!items.length) return <p className="hint">暂无情报项（可能尚未采集，或该维度未接入）。</p>;
  return (
    <ul className="core-intel">
      {items.map(it => {
        const verifiedLook = it.status === 'verified' && it.evidence.length > 0; // 无证据时永不使用已核实样式
        return (
          <li key={it.id} className={`core-intel-${verifiedLook ? 'verified' : it.status}`}>
            <div className="core-intel-head">
              <span className="core-intel-at">{new Date(it.at).toLocaleString()}</span>
              <span className="core-intel-type">{it.typeText}</span>
              <span className="core-intel-title">{it.title}</span>
              <span className="core-intel-nature">{it.natureText}</span>
              <span className="core-intel-status">{verifiedLook ? it.statusText : it.status === 'verified' ? '待核实' : it.statusText}</span>
            </div>
            {it.detail ? <p className="core-intel-detail">{it.detail}</p> : null}
            <div className="core-intel-acts">
              {it.evidence.length ? (
                <button type="button" className="btn-mini" onClick={() => setOpen(open === it.id ? null : it.id)}>
                  证据入口（{it.evidence.length}）
                </button>
              ) : <span className="core-intel-noev">暂无可打开的来源，暂不标记已核实</span>}
              {onCorrect && it.correctionEndpoint ? (
                <button type="button" className="btn-mini" onClick={() => onCorrect(it)}>发现数据有误？</button>
              ) : null}
            </div>
            {open === it.id ? (
              <ul className="core-intel-ev">
                {it.evidence.map(ev => (
                  <li key={ev.evidenceId}>
                    <span>证据 {ev.evidenceId}</span>
                    <span>状态 {ev.evidenceStatus || '—'}</span>
                    {ev.observedAt ? <span>观察 {new Date(ev.observedAt).toLocaleString()}</span> : null}
                    {(ev.snapshotIds || []).length ? <span>快照 {(ev.snapshotIds || []).length} 个</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
