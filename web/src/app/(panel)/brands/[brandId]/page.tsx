'use client';
// ============================================================
// 品牌详情（SC-08 r2 §五）——「竞品数据 + 时间轴」主体页面
// ------------------------------------------------------------
// 顶部品牌总览卡：品牌名称 / 官网 / 市场与品类 / 关系 / 官网确认状态 /
//                正式监控状态 / 数据积累起点 / 最近一次成功观察 / 已接入维度数量
// 分区（收敛为七段，顺序固定）：
//   ① 概览  ② 时间线  ③ 官网与商品  ④ 用户声音与公开评论
//   ⑤ 内容与广告  ⑥ 来源与采集记录  ⑦ 相关报告
// 纪律：
//   · 覆盖信息只在一处出现：顶部总览卡给一句摘要，明细只放在「来源与采集记录」；
//     不再挂 DataSurfaceOverview / 旧 CoveragePanel 等重复组件；
//   · 概览不复制各 Tab 的正文（只给结论 + 下一步）；
//   · 没有数据的 Tab 只显示一个简洁空态 + 下一步，不重复多段说明；
//   · 用户可理解的内容优先，内部实现说明（能力码/attempt/provider）不出现在页面上。
// ============================================================
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { fetchBrand, priceText, type BrandDetail } from '@/lib/core-api';
import { ReportPanel } from '@/components/brand/report-panel';
import { EvidenceDrawer } from '@/components/data-surface/evidence-drawer';
import {
  fetchBrandMemory, fetchBrandMemoryTimeline, fetchHistoryCoverage,
  presetToRange, type HistoryCoverage, type MemoryTimeline, type MemoryView, type RangePreset,
} from '@/lib/memory-api';
import { TimeRangePicker } from '@/components/memory/time-range-picker';
import { ProductMemoryList, type EvidenceRef } from '@/components/memory/price-track';
import { MemoryTimelineList } from '@/components/memory/memory-timeline';
import { CoverageLegend, CoverageTimeline } from '@/components/memory/coverage-timeline';
import { BackfillCard } from '@/components/memory/backfill-card';
import { VoicePanel } from '@/components/brand/voice-panel';
import { EmptyState } from '@/components/core-ui';
import { relationText, marketText } from '@/lib/core-logic';

// 公开商品的发现路径（只描述「怎么找到的」，不暗示覆盖率更高）
function discoveryPathText(p: string): string {
  if (p === 'jsonld') return '商品页 JSON-LD';
  if (p === 'sitemap') return 'robots 声明的 sitemap';
  if (p === 'homepage_links') return '首页内链商品页';
  return p;
}

const TABS: { key: string; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'timeline', label: '时间线' },
  { key: 'products', label: '官网与商品' },
  { key: 'voice', label: '用户声音与公开评论' },
  { key: 'ads', label: '内容与广告' },
  { key: 'sources', label: '来源与采集记录' },
  { key: 'reports', label: '相关报告' },
];

const DIM_TEXT: Record<string, string> = {
  price: '价格', website: '官网内容', product: '商品', stock: '库存',
  review: '评论', social: '社媒', ads: '广告', search: '搜索热度',
};

// 时间只精确到分钟（机器口径的秒不展示给用户）
function fmt(iso: string | null | undefined, withTime?: boolean): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
    return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day;
  } catch (e) { return '—'; }
}

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

  // 「全部可用历史」的起点来自后端投影（不在前端猜）
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

  if (!projectId) return <p className="core-err">缺少项目参数：请从竞品数据库进入品牌详情。</p>;
  if (err) return (
    <div>
      <p className="core-err">{err}</p>
      <p className="hint"><Link href={`/brands?projectId=${encodeURIComponent(projectId)}`}>← 返回竞品数据库</Link></p>
    </div>
  );
  if (!d) return <p className="hint">加载品牌档案…</p>;

  const b = d.brand;
  const bc = d.brandCoverage;
  const sum = bc.summary;
  const mon = d.monitoring;
  const keep = `projectId=${encodeURIComponent(projectId)}`;
  const earliest = cov?.summary?.earliestAvailableAt || null;
  const accumulatedStart = b.dataAccumulationStart || earliest || null;
  // 「已接入维度数量」按 Registry 总数减去未配置数得出（不硬编码 5）
  const configuredDims = sum.total - (sum.notConfigured || 0);
  const products = d.products || { observations: [], summary: null, attemptId: null, collectedAt: null, evidenceRefs: [] };
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

  // 下一步（只在概览出现一次；按真实状态给可执行动作）
  const nextStep = (() => {
    if (sum.collecting > 0) return '正在采集数据，完成后这里会自动更新。';
    if (sum.failed > 0) return '有维度的最近一次采集失败：可在「来源与采集记录」查看原因并重试。';
    if (sum.available === 0) return '还没有可展示的采集数据：可在「来源与采集记录」发起首轮采集。';
    if (mon && mon.state === 'none') return '尚未加入正式监控：加入后系统会按计划每天检查变化。';
    if (mon && mon.state === 'source_failed') return mon.nextStepText || '正式监控来源建立失败，可重新加入监控。';
    if ((sum.notConfigured || 0) > 0) return `部分维度（${sum.notConfigured} 个）的数据服务尚未接入，已接入维度照常积累。`;
    return '数据正在按计划积累；有可核实变化时会出现在「每日变化收件箱」。';
  })();

  return (
    <div className="core-brand-detail">
      <p className="hint"><Link href={`/brands?${keep}`}>← 返回竞品数据库</Link></p>

      {/* ---------- 顶部品牌总览卡（唯一的品牌级事实摘要） ---------- */}
      <section className="core-brand-hero" data-testid="brand-overview-card">
        <div className="core-brand-hero-head">
          <h2 title={b.name}>{b.name}</h2>
          <span className="core-brand-rel">{relationText(b.relation)}</span>
        </div>
        <a className="core-brand-hero-domain" href={b.officialDomain ? `https://${b.officialDomain}` : undefined} target="_blank" rel="noopener noreferrer nofollow">
          {b.officialDomain || '官网待确认'}
        </a>
        <dl className="core-brand-hero-facts">
          <div><dt>市场 / 品类</dt><dd>{[marketText(b.market), b.category].filter(Boolean).join(' · ') || '—'}</dd></div>
          <div><dt>官网确认</dt><dd>{d.officialSite ? d.officialSite.statusText : '未采集'}</dd></div>
          <div><dt>正式监控</dt><dd className={mon && (mon.state === 'active' || mon.state === 'degraded') ? 'is-on' : undefined}>
            {mon ? mon.stateText : '未加入监控'}{mon && mon.signalsText ? `（${mon.signalsText}）` : ''}
          </dd></div>
          <div><dt>数据积累起点</dt><dd>{accumulatedStart ? fmt(accumulatedStart) : '尚未开始积累'}</dd></div>
          <div><dt>最近一次成功观察</dt><dd>{d.collection && d.collection.lastAttemptAt ? fmt(d.collection.lastAttemptAt, true) : '—'}</dd></div>
          <div><dt>已接入维度</dt><dd>{configuredDims} / {sum.total}{sum.available ? `（${sum.available} 个已有数据）` : ''}</dd></div>
        </dl>
      </section>

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

      {/* ---------- ① 概览：结论 + 下一步（不复制各 Tab 正文） ---------- */}
      {tab === 'overview' && (
        <section className="core-sec">
          <div className="core-overview-grid">
            <div className="core-overview-card">
              <h4>最近一次可核验变化</h4>
              {d.lastVerifiedChange ? (
                <p className="core-overview-main">
                  <span className={`core-inbox-dim core-dim-${d.lastVerifiedChange.dimension}`}>{DIM_TEXT[d.lastVerifiedChange.dimension] || '变化'}</span>
                  <span>{d.lastVerifiedChange.title}</span>
                  <span className="core-overview-at">{fmt(d.lastVerifiedChange.at, true)}</span>
                </p>
              ) : <p className="core-brand-muted">暂未观察到可核验变化（不代表该品牌没有变化）。</p>}
            </div>
            <div className="core-overview-card">
              <h4>数据覆盖</h4>
              <p className="core-overview-main">
                {sum.total} 个维度中 {sum.available} 个已有数据
                {sum.collecting ? `、${sum.collecting} 个正在采集` : ''}
                {sum.failed ? `、${sum.failed} 个需要处理` : ''}
                {sum.notConfigured ? `、${sum.notConfigured} 个未接入` : ''}。
              </p>
              <button type="button" className="btn-ghost btn-mini" onClick={() => switchTab('sources')}>查看来源与采集记录</button>
            </div>
            <div className="core-overview-card">
              <h4>下一步</h4>
              <p className="core-overview-main">{nextStep}</p>
            </div>
          </div>
          <p className="hint">
            档案从 Vantage 首次成功采集或回补到公开存档的那一天起有证据；更早的时间没有记录，不代表当时没有变化。
          </p>
        </section>
      )}

      {/* ---------- ② 时间线 ---------- */}
      {tab === 'timeline' && (
        <section className="core-sec">
          <h3>时间线</h3>
          <p className="desc">按时间倒序排列的品牌档案事件：首次观察、日常采集、出现的变化与生成的报告。</p>
          {rangePicker}
          {loadErr ? <p className="core-err">{loadErr}</p> : null}
          {tl ? (
            (tl.items && tl.items.length)
              ? <MemoryTimelineList data={tl} onEvidence={setEvRefs} />
              : <EmptyState title="这段时间还没有记录" sub="换个时间范围，或先在「来源与采集记录」发起一次采集。" />
          ) : <p className="hint">加载中…</p>}
        </section>
      )}

      {/* ---------- ③ 官网与商品 ---------- */}
      {tab === 'products' && (
        <section className="core-sec">
          <h3>官网与商品</h3>
          <div className="core-site-grid">
            <div className={'core-site-status core-site-' + (d.officialSite ? d.officialSite.status : 'not_collected')}>
              <b>{d.officialSite ? d.officialSite.statusText : '官网资料未采集'}</b>
              <p className="hint">
                {d.officialSite && d.officialSite.status === 'confirmed'
                  ? <>确认地址：<a href={d.officialSite.canonical || undefined} target="_blank" rel="noopener noreferrer nofollow">{d.officialSite.canonical || b.officialDomain}</a>{d.officialSite.lastCollectedAt ? `　采集时间：${fmt(d.officialSite.lastCollectedAt, true)}` : ''}</>
                  : (d.officialSite && d.officialSite.status === 'unavailable'
                    ? '最近一次官网采集未成功，稍后可重试；此状态不代表官网不存在。'
                    : '还没有对官网公开资料发起过采集。')}
              </p>
            </div>
            <div className="core-site-status core-site-wrap">
              <b>{d.publicProducts ? d.publicProducts.statusText : '官网公开商品：未采集'}</b>
              <p className="hint">
                {d.publicProducts && d.publicProducts.status === 'verified'
                  ? <>{d.publicProducts.observedCount != null ? `观察条数：${d.publicProducts.observedCount}　` : ''}{d.publicProducts.discoveryPath ? `发现路径：${discoveryPathText(d.publicProducts.discoveryPath)}　` : ''}{d.publicProducts.sampleNote || ''}</>
                  : (d.publicProducts && d.publicProducts.status === 'unavailable'
                    ? `${d.publicProducts.failureText || '来源暂不可达，稍后可重试。'}`
                    : '该来源尚未产出可展示的商品观察。')}
              </p>
            </div>
          </div>
          {rangePicker}
          {loadErr ? <p className="core-err">{loadErr}</p> : null}
          {mem ? (
            mem.facts.length
              ? <ProductMemoryList facts={mem.facts} onEvidence={setEvRefs} />
              : <EmptyState title="还没有可核验的历史价格记录" sub={mem.note || '系统从首次成功采集开始积累；不足两个可比观察点时不判断价格变化。'} />
          ) : <p className="hint">加载中…</p>}
          {products.observations.length ? (
            <details className="mem-current">
              <summary>本次采集的当前观察（{products.observations.length} 条，未进入时序库）</summary>
              <p className="hint">采集时间：{products.collectedAt ? fmt(products.collectedAt, true) : '—'}。写入时序库后才会形成可回溯历史。</p>
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

      {/* ---------- ④ 用户声音与公开评论 ---------- */}
      {tab === 'voice' && (
        <section className="core-sec">
          <VoicePanel voice={d.unifiedVoice} onEvidence={setEvRefs} />
        </section>
      )}

      {/* ---------- ⑤ 内容与广告 ---------- */}
      {tab === 'ads' && (
        <section className="core-sec">
          <h3>内容与广告</h3>
          {(() => {
            const dims = bc.dimensions.filter(x => x.code === 'social_content' || x.code === 'ad_campaigns');
            if (!dims.length) return <EmptyState title="尚无内容与广告维度" sub="该维度尚未接入。" />;
            const anyData = dims.some(x => x.state === 'available');
            if (!anyData) {
              return <EmptyState
                title="内容与广告数据尚未接入"
                sub={dims.map(x => `${x.label}：${x.stateText}`).join('；') + '。接入后这里会展示可核验的公开内容与广告观察。'}
              />;
            }
            return (
              <ul className="core-dim-list">
                {dims.map(x => (
                  <li key={x.code}>
                    <b>{x.label}</b>：{x.stateText}
                    {x.observationCount ? <span className="hint">（{x.observationCount} 条观察，{x.evidenceCount} 条证据）</span> : null}
                  </li>
                ))}
              </ul>
            );
          })()}
          <p className="hint">
            <Link href={`/intel?${keep}&brandId=${encodeURIComponent(b.brandId)}`}>在每日变化收件箱里查看该品牌的变化 →</Link>
          </p>
        </section>
      )}

      {/* ---------- ⑥ 来源与采集记录（覆盖明细的唯一位置） ---------- */}
      {tab === 'sources' && (
        <section className="core-sec">
          <h3>来源与采集记录</h3>
          <p className="desc">每个数据维度的真实来源状态、最近观察时间、观察与证据条数；失败原因只在对应维度显示一次。</p>
          <table className="core-cov-table" data-testid="brand-coverage-table">
            <thead>
              <tr><th>维度</th><th>状态</th><th>最近观察</th><th>观察</th><th>证据</th><th>来源</th><th>说明</th></tr>
            </thead>
            <tbody>
              {bc.dimensions.map(x => (
                <tr key={x.code} className={'core-cov-row core-cov-' + x.state}>
                  <td>{x.label}</td>
                  <td><span className={'core-cov-badge core-cov-badge-' + x.state}>{x.stateText}</span></td>
                  <td>{x.lastObservedAt ? fmt(x.lastObservedAt) : '—'}</td>
                  <td>{x.state === 'available' ? x.observationCount : '—'}</td>
                  <td>{x.state === 'available' ? x.evidenceCount : '—'}</td>
                  <td>{x.state === 'available' && x.sourceCount ? x.sourceCount : '—'}</td>
                  <td className="core-cov-note">{x.latestFailureText || (x.reason === 'credential_required' ? '' : (x.note || ''))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* 同一类「数据服务暂不可用」只在表下说明一次，不在每行重复 */}
          {(() => {
            const notConfigured = bc.dimensions.filter(x => x.reason === 'credential_required');
            const notIntegrated = bc.dimensions.filter(x => x.reason === 'source_not_integrated');
            return (
              <>
                {notConfigured.length ? (
                  <p className="hint core-cov-groupnote">
                    {notConfigured.map(x => x.label).join('、')}（{notConfigured.length} 个维度）的数据服务尚未接入或凭据不可用，当前不生成这些维度的数据、估算或结论，不影响已接入维度的积累。
                  </p>
                ) : null}
                {notIntegrated.length ? (
                  <p className="hint core-cov-groupnote">
                    {notIntegrated.map(x => x.label).join('、')}（{notIntegrated.length} 个维度）尚未接入，Vantage 不提供其数据或估算。
                  </p>
                ) : null}
              </>
            );
          })()}

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
        </section>
      )}

      {/* ---------- ⑦ 相关报告 ---------- */}
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
