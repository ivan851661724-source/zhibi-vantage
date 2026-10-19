'use client';
// 竞品库（SC-04）：统一竞品档案列表——品牌名/官网或已核实身份、市场品类、
// 数据覆盖状态、最近观察时间、最近重要变化、未接入或资料缺口。
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { fetchBrands, type BrandListItem } from '@/lib/core-api';

export default function BrandsPage() {
  return (
    <Suspense fallback={<p className="hint">加载竞品库…</p>}>
      <BrandsInner />
    </Suspense>
  );
}

function BrandsInner() {
  const { state } = useZhibiState();
  const sp = useSearchParams();
  const projectId = String(sp.get('projectId') || (state as { projectId?: string } | null)?.projectId || '');
  const [items, setItems] = useState<BrandListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    let alive = true;
    const ctrl = new AbortController();
    setLoading(true);
    fetchBrands(projectId, ctrl.signal)
      .then(r => { if (alive) { setItems(r.brands || []); setErr(null); } })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; ctrl.abort(); };
  }, [projectId]);

  if (!projectId) return <p className="hint">请先创建或选择项目。</p>;
  if (loading) return <p className="hint">加载竞品库…</p>;
  if (err) return <p className="core-err">{err}</p>;

  return (
    <div className="core-brands">
      <h2>竞品库</h2>
      {!items.length ? (
        <p className="hint">
          该项目还没有竞品。添加竞品后，这里会显示统一品牌档案；未采集的品牌会显示「尚未采集」，不会显示成「未发现数据」。
        </p>
      ) : (
        <ul className="core-brand-list">
          {items.map(b => (
            <li key={b.brandId}>
              <div className="core-brand-head">
                <Link href={`/brands/${b.brandId}?projectId=${encodeURIComponent(projectId)}`}>{b.name}</Link>
                <span className="core-brand-domain">{b.officialDomain || '官网未核实'}</span>
                {b.market ? <span>{b.market}</span> : null}
                {b.category ? <span>{b.category}</span> : null}
                <span className="core-brand-rel">{b.relation || '竞品'}</span>
              </div>
              <div className="core-brand-cov">
                <span>有数据 {b.coverageSummary.dimensionsWithData}/{b.coverageSummary.totalDimensions} 维度</span>
                <span>未接入 {b.coverageSummary.notIntegrated.length}</span>
                <span>最近观察：{b.lastObservedAt ? new Date(b.lastObservedAt).toLocaleString() : '尚未采集'}</span>
              </div>
              {b.lastChange ? (
                <p className="core-brand-change">最近变化：{b.lastChange.title || b.lastChange.kindText}（{new Date(b.lastChange.at).toLocaleString()}）</p>
              ) : null}
              {b.gaps.length ? (
                <ul className="core-brand-gaps">
                  {b.gaps.slice(0, 6).map(g => (
                    <li key={g.code}><span>{g.displayName}</span><span>{g.stateText}</span></li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
