'use client';
// 品牌详情（SC-04 统一档案）：概览 / 商品与价格 / 竞争动态时间线 / 数据覆盖与来源
// （Data Surface 在此作为「数据覆盖与来源」区域，不单独暴露成技术面板）/ 情报 / 相关报告。
import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { fetchBrand, priceText, type BrandDetail } from '@/lib/core-api';
import { CoveragePanel, IntelList, TimelineList } from '@/components/brand/coverage-panel';
import { ReportPanel } from '@/components/brand/report-panel';
import { DataSurfaceOverview } from '@/components/data-surface/data-surface-overview';

export default function BrandDetailPage() {
  const params = useParams<{ brandId: string }>();
  const brandId = String(params?.brandId || '');
  const router = useRouter();
  const [d, setD] = useState<BrandDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!brandId) return;
    let alive = true;
    const ctrl = new AbortController();
    fetchBrand(brandId, ctrl.signal)
      .then(r => { if (alive) { setD(r); setErr(null); } })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; ctrl.abort(); };
  }, [brandId]);

  if (err) return <p className="core-err">{err}</p>;
  if (!d) return <p className="hint">加载品牌档案…</p>;

  const b = d.brand;
  const products = d.products || { observations: [], summary: null, attemptId: null, collectedAt: null, evidenceRefs: [] };

  return (
    <div className="core-brand-detail">
      <h2>{b.name}</h2>
      <section>
        <h3>概览</h3>
        <ul>
          <li>官网：{b.officialDomain || '未核实'}</li>
          <li>市场：{b.market || '—'}　品类：{b.category || '—'}</li>
          <li>关系：{b.relation || '竞品'}</li>
          <li>开始观察：{b.firstObservedAt ? new Date(b.firstObservedAt).toLocaleString() : '尚未采集'}</li>
        </ul>
        <p className="hint">无历史存档接入时只展示开始观察日期，不暗示拥有更早历史。</p>
      </section>

      <section>
        <h3>商品与价格</h3>
        {!products.observations.length ? (
          <p className="hint">尚未采集（不等于该品牌没有商品或价格）。</p>
        ) : (
          <>
            <p className="hint">采集时间：{products.collectedAt ? new Date(products.collectedAt).toLocaleString() : '—'}</p>
            <ul className="core-products">
              {products.observations.slice(0, 30).map((o, i) => (
                <li key={o.id || i}>
                  <span>{o.title}</span>
                  <span>{priceText(o)}</span>
                  <span>{o.available === false ? '断货' : '在售'}</span>
                </li>
              ))}
            </ul>
            {products.evidenceRefs.length ? (
              <p className="hint">证据：{products.evidenceRefs.length} 条（可在下方覆盖与来源中核对）。</p>
            ) : null}
          </>
        )}
      </section>

      <section>
        <h3>数据覆盖与来源</h3>
        <CoveragePanel coverage={d.coverage} />
        {b.competitorId ? <DataSurfaceOverview competitorId={b.competitorId} /> : null}
      </section>

      <section>
        <h3>竞争动态时间线</h3>
        <TimelineList events={d.timeline || []} firstObservedAt={b.firstObservedAt}
          note="无历史存档接入，只展示 Vantage 开始观察之后的记录。" />
      </section>

      <section>
        <h3>情报</h3>
        <IntelList items={d.intelligence || []} onCorrect={() => router.push('/intel')} />
      </section>

      <section>
        <h3>相关报告</h3>
        <ReportPanel projectId={d.links[0]?.projectId || ''} brandIds={[b.brandId]}
          onOpen={(id) => router.push(`/report/${id}`)} />
      </section>
    </div>
  );
}
