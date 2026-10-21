'use client';
// CoverageTimeline（SC-05 §7.1）：哪些时间有证据、哪些部分覆盖、哪些无法确认。
// 🔴 只消费后端给的区间数组；组件不自己推算覆盖，也不把「无记录」画成「无变化」。
import type { MemoryCoverageDimension } from '@/lib/memory-api';

const SEG_TEXT: Record<string, string> = {
  covered: '有可核验证据',
  partial: '部分覆盖',
  unknown: '无法确认',
};

function monthsBetween(from: string, to: string): string[] {
  const a = String(from).slice(0, 7), b = String(to).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(a) || !/^\d{4}-\d{2}$/.test(b)) return [];
  const [ay, am] = a.split('-').map(Number); const [by, bm] = b.split('-').map(Number);
  const out: string[] = [];
  let y = ay, m = am, guard = 0;
  while ((y < by || (y === by && m <= bm)) && guard < 240) {
    out.push(String(y) + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; } guard++;
  }
  return out;
}

type Seg = { month: string; kind: 'covered' | 'partial' | 'unknown' };

function buildSegments(dim: MemoryCoverageDimension): Seg[] {
  const map = new Map<string, Seg['kind']>();
  for (const r of dim.coveredRanges || []) for (const mo of monthsBetween(r.from, r.to)) map.set(mo, 'covered');
  for (const r of dim.partialRanges || []) for (const mo of monthsBetween(r.from, r.to)) if (!map.has(mo)) map.set(mo, 'partial');
  for (const r of dim.unknownRanges || []) for (const mo of monthsBetween(r.from, r.to)) if (!map.has(mo)) map.set(mo, 'unknown');
  return [...map.entries()].sort((x, y) => x[0].localeCompare(y[0])).map(([month, kind]) => ({ month, kind }));
}

export function CoverageTimeline({ dimension }: { dimension: MemoryCoverageDimension }) {
  const segs = buildSegments(dimension);
  if (!segs.length) {
    return (
      <div className="mem-cov">
        <p className="mem-cov-empty">
          {dimension.stateText}：该维度还没有可核验的采集记录，系统从首次成功采集开始积累。
        </p>
      </div>
    );
  }
  return (
    <div className="mem-cov">
      <div className="mem-cov-head">
        <b>{dimension.displayName}</b>
        <span className={'mem-cov-state mem-cov-' + dimension.state}>{dimension.stateText}</span>
      </div>
      <div className="mem-cov-bar" role="img"
        aria-label={dimension.displayName + ' 时间覆盖：' + segs.map(s => s.month + ' ' + SEG_TEXT[s.kind]).join('；')}>
        {segs.map(s => (
          <span key={s.month} className={'mem-cov-seg mem-cov-seg-' + s.kind}
            title={s.month + '：' + SEG_TEXT[s.kind]} />
        ))}
      </div>
      <div className="mem-cov-axis">
        <span>{segs[0].month}</span>
        <span>{segs[segs.length - 1].month}</span>
      </div>
      <ul className="mem-cov-facts">
        <li>最早可用：{dimension.earliestAvailableAt ? String(dimension.earliestAvailableAt).slice(0, 10) : '—'}</li>
        <li>最后成功采集：{dimension.lastSuccessAt ? String(dimension.lastSuccessAt).slice(0, 10) : '—'}</li>
        <li>时序事实 {dimension.factCount} 条（可比 {dimension.comparableCount} 条）</li>
        <li>来源 {dimension.evidenceCount} 条证据 / {dimension.snapshotCount} 个快照</li>
      </ul>
      <p className="mem-cov-note">
        色块表示 Vantage 在这个月有没有可核验证据；没有色块不代表没有发生价格或商品变动。
      </p>
    </div>
  );
}

export function CoverageLegend() {
  return (
    <ul className="mem-cov-legend">
      <li><span className="mem-cov-dot mem-cov-seg-covered" />有可核验证据</li>
      <li><span className="mem-cov-dot mem-cov-seg-partial" />部分覆盖</li>
      <li><span className="mem-cov-dot mem-cov-seg-unknown" />无法确认</li>
    </ul>
  );
}
