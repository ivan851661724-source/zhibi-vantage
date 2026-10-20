'use client';
// 品牌详情（SC-05）：从「当前卡片」升级为「时序档案」。
//   Tab：概览 / 商品与价格 / 历史时间线 / 数据覆盖与来源 / 相关情报 / 相关报告
// 🔴 项目边界：所有读取与跳转显式携带 projectId；tab 与时间范围进 URL（深链接可分享）。
// 🔴 诚实纪律：无历史 → 明确说明「尚未形成可核验历史记录」；单点 → 不画趋势；
//    存档点与实时点标签不同；覆盖缺口与「没有变化」严格区分。
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { fetchBrand, priceText, type BrandDetail } from '@/lib/core-api';
import { CoveragePanel, IntelList } from '@/components/brand/coverage-panel';
import { ReportPanel } from '@/components/brand/report-panel';
import { DataSurfaceOverview } from '@/components/data-surface/data-surface-overview';
import { EvidenceDrawer } from '@/components/data-surface/evidence-drawer';
import { BuildingDims } from '@/components/core-ui';
import {
  fetchBrandMemory, fetchBrandMemoryTimeline, fetchHistoryCoverage,
  presetToRange, type HistoryCoverage, type MemoryTimeline, type MemoryView, type RangePreset,
} from '@/lib/memory-api';
import { TimeRangePicker } from '@/components/memory/time-range-picker';
import { ProductMemoryList, type EvidenceRef } from '@/components/memory/price-track';
import { MemoryTimelineList } from '@/components/memory/memory-timeline';
import { CoverageLegend, CoverageTimeline } from '@/components/memory/coverage-timeline';
import { BackfillCard } from '@/components/memory/backfill-card';

const TABS: { key: string; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'products', label: '商品与价格' },
  { key: 'timeline', label: '历史时间线' },
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
  const [preset, setPreset] = useState<RangePreset>((searchParams?.get('range') as RangePreset) || 'all');
  const [range, setRange] = useState<{ from: string | null; to: string | null }>({ from: null, to: null });
  const [d, setD] = useState<BrandDetail | null>(null);
  const [mem, setMem] = useState<MemoryView | null>(null);
  const [tl, setTl] = useState<MemoryTimeline | null>(null);
  const [cov, setCov] = useState<HistoryCoverage | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [evRefs, setEvRefs] = useState<EvidenceRef[] | null>(null);

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

  // 「全部可用历史」的起点来自后端覆盖投影（不在此处猜）
  const effectiveRange = useMemo(() => {
    if (preset === 'custom') return range;
    if (preset === 'all') {
      const earliest = cov?.summary?.earliestAvailableAt || null;
      return earliest ? { from: String(earliest).slice(0, 10), to: null } : { from: null, to: null };
    }
    return presetToRange(preset);
  }, [preset, range, cov]);

  const reload = useCallback(() => {
    if (!brandId || !projectId) return;
    setLoadErr(null);
    fetchHistoryCoverage(brandId, { projectId })
      .then(setCov)
      .catch(e => setLoadErr(e instanceof Error ? e.message : String(e)));
    fetchBrandMemory(brandId, {
      projectId, from: effectiveRange?.from || undefined, to: effectiveRange?.to || undefined,
      factTypes: ['product.price', 'product.available', 'product.title', 'product.currency'], limit: 400,
    }).then(setMem).catch(e => setLoadErr(e instanceof Error ? e.message : String(e)));
    fetchBrandMemoryTimeline(brandId, {
      projectId, from: effectiveRange?.from || undefined, to: effectiveRange?.to || undefined, limit: 150,
    }).then(setTl).catch(e => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, [brandId, projectId, effectiveRange?.from, effectiveRange?.to]);

  useEffect(() => { reload(); }, [reload]);

  function switchTab(k: string) {
    setTab(k);
    const qs = new URLSearchParams({ projectId, tab: k });
    if (preset !== 'all') qs.set('range', preset);
    router.replace(`/brands/${brandId}?${qs.toString()}`, { scroll: false });
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
  const earliest = cov?.summary?.earliestAvailableAt || null;
  const rangePicker = (
    <TimeRangePicker
      preset={preset} from={effectiveRange?.from || null} to={effectiveRange?.to || null}
      earliest={earliest}
      onChange={(next) => {
        setPreset(next.preset);
        if (next.preset === 'custom') setRange({ from: next.from, to: next.to });
      }}
    />
  );

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
            <li>时序积累起点：{earliest ? String(earliest).slice(0, 10) : '尚未开始积累'}</li>
          </ul>
          <CoveragePanel coverage={d.coverage} compact />
          <p className="hint">
            时序档案从 Vantage 开始采集或回补到公开存档的那一天起有证据；更早的时间没有记录，不代表当时没有变化。
          </p>
        </section>
      )}

      {tab === 'products' && (
        <section className="core-sec">
          <h3>商品与价格</h3>
          {rangePicker}
          {loadErr ? <p className="core-err">{loadErr}</p> : null}
          {mem ? <ProductMemoryList facts={mem.facts} onEvidence={setEvRefs} /> : <p className="hint">加载中…</p>}
          {mem && !mem.facts.length ? (
            <div className="mem-empty">
              <p><b>尚未形成可核验的历史价格记录</b></p>
              <p className="hint">
                {mem.note || '系统从首次成功采集开始积累；不足两个可比观察点时不判断价格变化。'}
              </p>
            </div>
          ) : null}
          {products.observations.length ? (
            <details className="mem-current">
              <summary>本次采集的当前观察（{products.observations.length} 条，未进入时序库）</summary>
              <p className="hint">
                采集时间：{products.collectedAt ? new Date(products.collectedAt).toLocaleString() : '—'}。
                这些是最近一次采集的即时结果，只有写入时序库后才会形成可回溯历史。
              </p>
              <ul className="core-products">
                {products.observations.slice(0, 30).map((o, i) => (
                  <li key={o.id || i}>
                    <span>{o.title}</span>
                    <span>{priceText(o)}</span>
                    <span>{o.available === false ? '断货' : '在售'}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      )}

      {tab === 'timeline' && (
        <section className="core-sec">
          <h3>历史时间线</h3>
          {rangePicker}
          {loadErr ? <p className="core-err">{loadErr}</p> : null}
          {tl ? <MemoryTimelineList data={tl} onEvidence={setEvRefs} /> : <p className="hint">加载中…</p>}
        </section>
      )}

      {tab === 'coverage' && (
        <section className="core-sec">
          <h3>数据覆盖与来源</h3>
          <CoveragePanel coverage={d.coverage} />
          <div className="mem-cov-block">
            <div className="mem-cov-block-head">
              <b>时间覆盖</b>
              <CoverageLegend />
            </div>
            {cov ? (
              cov.dimensions.length ? (
                <>
                  <p className="hint">窗口：{cov.window.from} ~ {cov.window.to}（默认近 12 个月）。{cov.note}</p>
                  {cov.dimensions.map(dim => <CoverageTimeline key={dim.key} dimension={dim} />)}
                </>
              ) : <p className="hint">{cov.note}</p>
            ) : <p className="hint">加载中…</p>}
          </div>
          <BackfillCard
            brandId={brandId}
            projectId={projectId}
            canBackfill={!!b.competitorId}
            disabledReason={b.competitorId ? null : '该品牌还没有可核验的官网，暂不能回补历史。'}
            initialJob={cov?.backfill || null}
            onFinished={reload}
          />
          {b.competitorId ? <DataSurfaceOverview competitorId={b.competitorId} projectId={projectId} /> : null}
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

      {evRefs && evRefs.length ? (
        <EvidenceDrawer refs={evRefs} onClose={() => setEvRefs(null)} />
      ) : null}
    </div>
  );
}
