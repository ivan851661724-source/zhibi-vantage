'use client';
// 品牌详情（SC-04 UI 框架轮）：Tabs 档案——概览 / 商品与价格 / 竞争动态时间线 /
// 数据覆盖与来源 / 相关情报 / 相关报告。
// 🔴 项目边界：所有读取与跳转显式携带 projectId；tab 状态进 URL（深链接可分享）。
import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { fetchBrand, priceText, type BrandDetail } from '@/lib/core-api';
import { CoveragePanel, IntelList, TimelineList } from '@/components/brand/coverage-panel';
import { ReportPanel } from '@/components/brand/report-panel';
import { DataSurfaceOverview } from '@/components/data-surface/data-surface-overview';
import { BuildingDims } from '@/components/core-ui';

const TABS: { key: string; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'products', label: '商品与价格' },
  { key: 'timeline', label: '竞争动态' },
  { key: 'coverage', label: '数据覆盖与来源' },
  { key: 'intel', label: '相关情报' },
  { key: 'reports', label: '相关报告' },
];

export default function BrandDetailPage() {
  return (
    <Suspense fallback={<p className="hint">加载品牌档案…</p>}>
      <BrandDetailInner />
    </Suspense>
  );
}

function BrandDetailInner() {
  const params = useParams<{ brandId: string }>();
  const searchParams = useSearchParams();
  const brandId = String(params?.brandId || '');
  const projectId = String(searchParams?.get('projectId') || '');
  const router = useRouter();
  const [tab, setTab] = useState<string>(searchParams?.get('tab') || 'overview');
  const [d, setD] = useState<BrandDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!brandId || !projectId) return;
    let alive = true;
    const ctrl = new AbortController();
    setD(null);
    fetchBrand(brandId, { projectId, signal: ctrl.signal })
      .then(r => { if (alive) { setD(r); setErr(null); } })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; ctrl.abort(); };
  }, [brandId, projectId]);

  function switchTab(k: string) {
    setTab(k);
    // tab 进 URL：刷新/分享后仍停留在原分区，projectId 不丢
    router.replace(`/brands/${brandId}?projectId=${encodeURIComponent(projectId)}&tab=${encodeURIComponent(k)}`, { scroll: false });
  }

  if (!projectId) return <p className="core-err">缺少项目参数：请从竞品库进入品牌详情。</p>;
  if (err) return (
    <div>
      <p className="core-err">{err}</p>
      <p className="hint"><Link href={`/brands?projectId=${encodeURIComponent(projectId)}`}>← 返回竞品库</Link></p>
    </div>
  );
  if (!d) return <p className="hint">加载品牌档案…</p>;

  const b = d.brand;
  const products = d.products || { observations: [], summary: null, attemptId: null, collectedAt: null, evidenceRefs: [] };
  const keep = `projectId=${encodeURIComponent(projectId)}`;

  return (
    <div className="core-brand-detail">
      <p className="hint"><Link href={`/brands?${keep}`}>← 返回竞品库</Link></p>
      <h2>{b.name}</h2>

      <nav className="core-tabs" role="tablist" aria-label="品牌档案分区">
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={'core-tab' + (tab === t.key ? ' on' : '')}
            onClick={() => switchTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <section className="core-sec">
          <h3>概览</h3>
          <ul>
            <li>官网：{b.officialDomain || '未核实'}</li>
            <li>市场：{b.market || '—'}　品类：{b.category || '—'}</li>
            <li>关系：{b.relation || '竞品'}</li>
            <li>开始观察：{b.firstObservedAt ? new Date(b.firstObservedAt).toLocaleString() : '尚未采集'}</li>
          </ul>
          <CoveragePanel coverage={d.coverage} compact />
          <p className="hint">无历史存档接入时只展示开始观察日期，不暗示拥有更早历史。</p>
        </section>
      )}

      {tab === 'products' && (
        <section className="core-sec">
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
                <p className="hint">证据：{products.evidenceRefs.length} 条（可在「数据覆盖与来源」中核对原始快照）。</p>
              ) : null}
            </>
          )}
        </section>
      )}

      {tab === 'timeline' && (
        <section className="core-sec">
          <h3>竞争动态时间线</h3>
          <TimelineList events={d.timeline || []} firstObservedAt={b.firstObservedAt}
            note="无历史存档接入，只展示 Vantage 开始观察之后的记录。" />
        </section>
      )}

      {tab === 'coverage' && (
        <section className="core-sec">
          <h3>数据覆盖与来源</h3>
          <CoveragePanel coverage={d.coverage} />
          {b.competitorId ? <DataSurfaceOverview competitorId={b.competitorId} /> : null}
          <BuildingDims dimensions={d.coverage.dimensions} />
        </section>
      )}

      {tab === 'intel' && (
        <section className="core-sec">
          <h3>相关情报</h3>
          <IntelList items={d.intelligence || []} />
          <p className="hint">
            <Link href={`/intel?${keep}&brandId=${encodeURIComponent(b.brandId)}`}>在情报库中查看该品牌的全部情报 →</Link>
          </p>
        </section>
      )}

      {tab === 'reports' && (
        <section className="core-sec">
          <h3>相关报告</h3>
          <ReportPanel
            projectId={projectId}
            brandIds={[b.brandId]}
            onOpen={(id) => router.push(`/report/${id}?${keep}`)}
          />
        </section>
      )}
    </div>
  );
}
