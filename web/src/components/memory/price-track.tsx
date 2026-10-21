'use client';
// 商品与价格（SC-05 §7.2）
// 规则：
//   · ≥2 个可比、同币种、同规格的价格点才连线算涨跌；否则只展示当前观察与开始积累时间；
//   · 不可比的点（存档币种未确认 / 规格不明 / partial）**照实画出来**（空心点），
//     但不参与连线与涨跌计算 —— 藏起来等于隐瞒已经观察到的数据；
//   · 「开始积累于」用 observed_at（Vantage 何时开始观察），不是 effective_at；
//     存档更早的时间单独说明为「最早可回溯到」，两者不混。
import { useMemo } from 'react';
import type { MemoryFact } from '@/lib/memory-api';
import { SourceBadge, TimePrecisionLabel } from './badges';

export interface EvidenceRef { evidenceId: string | null; snapshotId: string | null; sourceUrl: string | null; label?: string | null }

export function refsOf(f: { evidenceIds: string[]; snapshotIds: string[] }): EvidenceRef[] {
  const evs = f.evidenceIds || [];
  const sns = f.snapshotIds || [];
  const out: EvidenceRef[] = [];
  const n = Math.max(evs.length, sns.length);
  for (let i = 0; i < n; i++) {
    out.push({ evidenceId: evs[i] || null, snapshotId: sns[i] || sns[0] || null, sourceUrl: null, label: null });
  }
  return out.filter(r => r.evidenceId || r.snapshotId);
}

type Point = {
  at: string; atMs: number; value: number; currency: string | null; comparable: boolean;
  sourceKind: MemoryFact['sourceKind']; sourceKindText: string;
  precision: MemoryFact['timePrecision']; precisionText: string;
  effectiveAt: string | null; observedAt: string; refs: EvidenceRef[];
};

function pointsOf(facts: MemoryFact[]): Point[] {
  return facts
    .filter(f => f.factType === 'product.price' && (typeof f.value === 'number'))
    .map(f => ({
      at: f.at,
      atMs: Date.parse(f.at) || 0,
      value: Number(f.value),
      currency: f.currency,
      comparable: f.comparable,
      sourceKind: f.sourceKind,
      sourceKindText: f.sourceKindText,
      precision: f.timePrecision,
      precisionText: f.timePrecisionText,
      effectiveAt: f.effectiveAt,
      observedAt: f.observedAt,
      refs: refsOf(f),
    }))
    .sort((a, b) => a.atMs - b.atMs);
}

function fmt(v: number) { return Number.isInteger(v) ? String(v) : v.toFixed(2); }
function d10(v: string | null) { return v ? String(v).slice(0, 10) : ''; }

const W = 300, H = 68, PAD = 10;

export function PriceTrack({ points, onEvidence }: { points: Point[]; onEvidence: (refs: EvidenceRef[]) => void }) {
  if (!points.length) return null;
  const usable = points.filter(p => p.comparable);
  const sameCurrency = usable.length >= 2 && usable.every(p => p.currency && p.currency === usable[0].currency);
  const canDraw = usable.length >= 2 && sameCurrency;
  const last = points[points.length - 1];
  // 开始积累 = Vantage 最早观察到该商品的时间（不是存档里的实际发生时间）
  const firstObserved = points.map(p => p.observedAt).filter(Boolean).sort()[0] || last.observedAt;
  const earliestEffective = points.filter(p => p.effectiveAt).map(p => String(p.effectiveAt)).sort()[0] || null;
  const excluded = points.filter(p => !p.comparable);

  if (!canDraw) {
    return (
      <div className="mem-track mem-track-single">
        <div className="mem-track-now">
          {last.currency ? last.currency + ' ' : ''}{fmt(last.value)}
          <SourceBadge kind={last.sourceKind} text={last.sourceKindText} />
          <TimePrecisionLabel precision={last.precision} text={last.precisionText} />
        </div>
        <p className="hint">
          开始积累于 {d10(firstObserved)}（Vantage 首次观察到该商品），目前只有 {usable.length} 个可比观察点，
          还不足以判断价格变化；系统会继续积累。
        </p>
        {excluded.length ? (
          <p className="hint">
            另有 {excluded.length} 个观察点未纳入比较：{excluded.map(p => d10(p.at) + ' ' + fmt(p.value) + (p.currency ? ' ' + p.currency : '（币种未确认）')).join('、')}。
          </p>
        ) : null}
        <button type="button" className="mem-ev-btn" onClick={() => onEvidence(last.refs)}>查看证据</button>
      </div>
    );
  }

  // 时间比例坐标：所有观察点都出现在时间轴上（含不可比点），连线只连可比点
  const times = points.map(p => p.atMs);
  const t0 = Math.min(...times), t1 = Math.max(...times);
  const span = (t1 - t0) || 1;
  const x = (ms: number) => PAD + ((ms - t0) / span) * (W - PAD * 2);
  // 纵轴按**全部**观察点取值域：不可比点也要落在画布内（否则会出现看不见的点）
  const vals = points.map(p => p.value);
  const vmin = Math.min(...vals), vmax = Math.max(...vals);
  const vspan = (vmax - vmin) || 1;
  const y = (v: number) => H - PAD - ((v - vmin) / vspan) * (H - PAD * 2);
  const path = usable.map((p, i) => (i ? 'L' : 'M') + x(p.atMs).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ');
  const delta = usable[usable.length - 1].value - usable[0].value;
  const pct = usable[0].value ? (delta / usable[0].value) * 100 : 0;

  return (
    <div className="mem-track">
      <div className="mem-track-head">
        <span className="mem-track-now">{last.currency} {fmt(last.value)}</span>
        <span className={'mem-track-delta' + (delta > 0 ? ' up' : delta < 0 ? ' down' : '')}>
          {delta > 0 ? '↑' : delta < 0 ? '↓' : '→'} {fmt(Math.abs(delta))}（{Math.abs(pct).toFixed(1)}%）
        </span>
        <span className="hint">基于 {usable.length} 个可比观察点</span>
      </div>
      <svg className="mem-track-svg" viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={'价格观察点：' + points.map(p => d10(p.at) + ' ' + fmt(p.value) + (p.comparable ? '' : '（未纳入比较）')).join('，')}>
        <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={x(p.atMs)}
            cy={y(p.value)}
            r={p.comparable ? 2.6 : 3.2}
            className={'mem-track-dot' + (p.comparable ? '' : ' excluded')
              + (p.sourceKind === 'archived_observation' ? ' archived' : ' live')}
          />
        ))}
      </svg>
      <div className="mem-track-axis">
        <span>{d10(points[0].at)}</span>
        <span>{d10(points[points.length - 1].at)}</span>
      </div>
      <p className="hint">连线只表示两个已核验观察点之间的价格差，中间过程没有被观察，不代表逐日走势。</p>
      {excluded.length ? (
        <p className="hint">
          {excluded.length} 个观察点未纳入比较（空心点）：{excluded.map(p => d10(p.at) + ' ' + (p.currency || '币种未确认')).join('、')}。
        </p>
      ) : null}
      <p className="hint">
        开始积累于 {d10(firstObserved)}
        {earliestEffective && d10(earliestEffective) < d10(firstObserved)
          ? '；最早可回溯到 ' + d10(earliestEffective) + '（历史存档观察，取存档时间）' : ''}。
      </p>
      <div className="mem-track-legend">
        <SourceBadge kind="live_observation" />
        <SourceBadge kind="archived_observation" />
      </div>
      <button type="button" className="mem-ev-btn" onClick={() => onEvidence(usable[usable.length - 1].refs)}>查看证据</button>
    </div>
  );
}

// 商品列表：按实体分组，展示每个商品的观察点
export function ProductMemoryList({ facts, onEvidence }: { facts: MemoryFact[]; onEvidence: (refs: EvidenceRef[]) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; facts: MemoryFact[] }>();
    for (const f of facts) {
      if (f.entityType !== 'product') continue;
      if (!map.has(f.entityId)) map.set(f.entityId, { name: f.entityName || '未命名商品', facts: [] });
      map.get(f.entityId)!.facts.push(f);
    }
    return [...map.entries()].map(([entityId, g]) => {
      const pts = pointsOf(g.facts);
      const avail = g.facts.filter(f => f.factType === 'product.available')
        .sort((a, b) => String(a.at).localeCompare(String(b.at)));
      return { entityId, name: g.name, pts, available: avail.length ? String(avail[avail.length - 1].value) : null };
    });
  }, [facts]);

  if (!groups.length) {
    return <p className="hint">该品牌还没有进入时序数据库的商品记录。</p>;
  }
  return (
    <ul className="mem-products">
      {groups.slice(0, 60).map(g => (
        <li key={g.entityId} className="mem-product">
          <div className="mem-product-head">
            <b>{g.name}</b>
            {g.available === 'sold_out' ? <span className="mem-stock off">不可售</span> : g.available === 'in_stock' ? <span className="mem-stock on">在售</span> : null}
            <span className="hint">{g.pts.length} 个价格观察点</span>
          </div>
          <PriceTrack points={g.pts} onEvidence={onEvidence} />
        </li>
      ))}
    </ul>
  );
}
