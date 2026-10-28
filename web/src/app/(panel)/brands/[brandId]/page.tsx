'use client';
// ============================================================
// 品牌档案（核心产品体验收敛 r1 重做）
// ------------------------------------------------------------
// 职责——只回答六个问题：
//   ① 这是谁 ② 现在卖什么、价格如何 ③ 最近发生了什么
//   ④ 我们从什么时候开始积累 ⑤ 哪些内容有证据 ⑥ 哪些维度仍缺资料
//
// 结构（固定）：
//   · 顶部品牌头部：品牌名 / 官网 / 关系 / 主要市场 / 官网确认 / 最近成功更新 /
//     正式监控 + 「立即更新」「加入·管理监控」；不出现内部码、字段名、英文枚举。
//   · 第一屏摘要：**最多四张**卡（已积累时长 / 可核验变化数 / 商品与价格 / 数据覆盖）。
//   · Tab：概览 · 时间线 · 官网与商品 · 用户声音与公开评论 · 内容与广告 ·
//     数据覆盖与来源 · 相关报告。
//
// 纪律：
//   · 覆盖信息只出现两处：第一屏第 4 张卡（一句话摘要）+ 最后一个 Tab（明细）；
//     概览里不再重复「数据覆盖」「数据完整度」「分维度覆盖面板」等模块；
//   · 没有数据时给原因 + 下一步，不显示假 0、空图或大段技术说明；
//   · 首次观察（基线）不得伪装成「变化」——时间线与摘要都按真实语义标注。
// ============================================================
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { fetchBrand, priceText, refreshBrandSource, type BrandDetail } from '@/lib/core-api';
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
import type { DimensionObservation } from '@/lib/core-api';

// 公开商品的发现路径（只描述「怎么找到的」，不暗示覆盖率更高）
function discoveryPathText(p: string): string {
  if (p === 'jsonld') return '商品页结构化数据';
  if (p === 'sitemap') return '站点地图';
  if (p === 'homepage_links') return '首页内链商品页';
  return '公开商品页';
}

const TABS: { key: string; label: string }[] = [
  { key: 'overview', label: '概览' },
  { key: 'timeline', label: '时间线' },
  { key: 'products', label: '官网与商品' },
  { key: 'voice', label: '用户声音与公开评论' },
  { key: 'ads', label: '内容与广告' },
  { key: 'sources', label: '数据覆盖与来源' },
  { key: 'reports', label: '相关报告' },
];

const DIM_TEXT: Record<string, string> = {
  price: '价格', website: '官网内容', product: '商品', stock: '库存',
  review: '评论', social: '社媒', ads: '广告', search: '搜索热度',
};

// 价格区间文案（真实观察值；无价格时返回 null，不补 0）
function productPriceText(obs: { price?: number | null; currency?: string | null }[]): string | null {
  const ps = obs.map(o => (o && typeof o.price === 'number' ? o.price : null)).filter(v => v != null) as number[];
  if (!ps.length) return null;
  const cur = (obs.map(o => (o && o.currency) || null).filter(Boolean)[0] as string) || '';
  const lo = Math.min(...ps); const hi = Math.max(...ps);
  const money = (n: number) => (cur ? cur + ' ' : '') + n.toFixed(2);
  return lo === hi ? money(lo) : money(lo) + '–' + money(hi);
}

function fmt(iso: string | null | undefined, withTime?: boolean): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    const day = `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
    return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day;
  } catch (e) { return '—'; }
}

// 已积累时长：从可核验起点算到今天（不足一天显示「不到 1 天」，绝不显示 0 天）
function accumulatedText(startIso: string | null): { main: string; sub: string } {
  if (!startIso) return { main: '尚未开始积累', sub: '首次成功采集后开始计算' };
  const start = new Date(startIso);
  const days = Math.floor((Date.now() - start.getTime()) / 86400000);
  if (!isFinite(days) || days < 0) return { main: '—', sub: '' };
  return {
    main: days < 1 ? '不到 1 天' : `${days} 天`,
    sub: `自 ${fmt(startIso)} 起`,
  };
}

function ObsList({ items, evidenceRefs, onEvidence }: {
  items: DimensionObservation[];
  evidenceRefs?: { evidenceId: string | null; snapshotId: string | null; sourceUrl: string | null; label?: string | null }[];
  onEvidence?: (refs: { evidenceId: string | null; snapshotId: string | null; sourceUrl: string | null; label?: string | null }[]) => void;
}) {
  if (!items || !items.length) return null;
  return (
    <>
      <ul className="core-obs-list">
        {items.slice(0, 30).map((o, i) => (
          <li key={o.id || o.sourceUrl || i}>
            <div className="core-obs-title">{o.title || o.sourceUrl || '未命名条目'}</div>
            <div className="core-obs-meta">
              {o.sourceUrl ? <a href={o.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">来源页</a> : null}
              {o.price != null ? <span>{priceText(o)}</span> : null}
              {o.rating != null ? <span>评分 {o.rating}</span> : null}
              {o.reviewCount != null ? <span>评论 {o.reviewCount}</span> : null}
              {o.publishedAt ? <span>{fmt(o.publishedAt)}</span> : null}
              {o.observedAt ? <span>观察于 {fmt(o.observedAt, true)}</span> : null}
            </div>
            {o.snippet ? <p className="core-obs-snip">{o.snippet}</p> : null}
          </li>
        ))}
      </ul>
      {onEvidence && evidenceRefs && evidenceRefs.length ? (
        <p className="core-obs-ev">
          <button type="button" className="btn-mini btn-ghost" onClick={() => onEvidence(evidenceRefs)}>查看证据（{evidenceRefs.length}）</button>
        </p>
      ) : null}
    </>
  );
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
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null);

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
      <p><Link className="core-back-link" href={`/brands?projectId=${encodeURIComponent(projectId)}`}>← 返回竞品数据库</Link></p>
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
  const staleDims = (bc.dimensions || []).filter(x => x.usingPreviousData).length;
  const dd = (d.dimensionDetails || {}) as Record<string, { observations: DimensionObservation[]; summary: Record<string, unknown> | null; collectedAt: string | null; evidenceRefs: { evidenceId: string | null; snapshotId: string | null; sourceUrl: string | null; label?: string | null }[] }>;
  const reviewsDet = dd.reviews_reputation || null;
  const socialDet = dd.social_content || null;
  const searchDet = dd.search_interest || null;
  const adsDet = dd.ad_campaigns || null;
  const products = d.products || { observations: [], summary: null, hasAttempt: false, collectedAt: null, evidenceRefs: [] };

  // 可核验变化数（后端唯一口径；无变化 ≠ 没有变化过）
  const vc = (d as unknown as { verifiedChanges?: { count: number; firstAt: string | null; lastAt: string | null } }).verifiedChanges;
  const changeCount = vc ? vc.count : 0;
  const acc = accumulatedText(accumulatedStart);
  const priceText2 = productPriceText(products.observations);
  const monitorOn = !!mon && (mon.state === 'active' || mon.state === 'degraded');

  // 「立即更新」目标：优先修复失败/待更新维度，否则刷新评论能力（真实请求）
  const dimsAll = (bc && bc.dimensions) || [];
  const needDim = dimsAll.find(x => x.state === 'failed') || dimsAll.find(x => x.usingPreviousData) || dimsAll.find(x => x.state === 'not_started');
  const needCap = needDim && (needDim.capabilities || []).find(c => c.maturity !== 'not_integrated');
  const refreshTarget = needCap ? needCap.code : 'public_reviews';
  async function doRefresh() {
    if (!b.competitorId || refreshing) return;
    setRefreshing(true);
    setRefreshMsg(null);
    try {
      const r = await refreshBrandSource({ projectId, competitorId: b.competitorId, capability: refreshTarget });
      setRefreshMsg(r && r.attempt ? '已开始更新，完成后自动刷新' : '已开始更新');
    } catch (e) {
      setRefreshMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }

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

  // 下一步（只说一次，按真实状态给可执行动作）
  const nextStep = (() => {
    if (staleDims > 0) return '部分维度已有历史数据，但最近一次更新失败；可在「数据覆盖与来源」查看原因，恢复后这里会自动更新。';
    if (sum.collecting > 0) return '正在采集数据，完成后这里会自动更新。';
    if (sum.failed > 0) return '有维度的最近一次采集未成功：可在「数据覆盖与来源」查看原因并重试。';
    if (sum.available === 0) return '还没有可展示的采集数据：可在「数据覆盖与来源」发起首轮采集。';
    if (mon && mon.state === 'none') return '尚未加入正式监控：加入后系统会按计划每天检查变化。';
    if (mon && mon.state === 'source_failed') return mon.nextStepText || '正式监控来源建立失败，可重新加入监控。';
    if ((sum.notConfigured || 0) > 0) return `部分维度（${sum.notConfigured} 个）的数据服务尚未接入，已接入维度照常积累。`;
    return '数据正在按计划积累；有可核实变化时会出现在「每日变化收件箱」。';
  })();

  return (
    <div className="core-brand-detail">
      <p><Link className="core-back-link" href={`/brands?${keep}`}>← 返回竞品数据库</Link></p>

      {/* ---------- 顶部品牌头部（唯一品牌级标识区） ---------- */}
      <header className="core-brand-hero" data-testid="brand-overview-card">
        <div className="core-brand-hero-head">
          <h1 title={b.name}>{b.name}</h1>
          <span className="core-badge core-badge-neutral">{relationText(b.relation)}</span>
        </div>
        <a className="core-brand-hero-domain" href={b.officialDomain ? `https://${b.officialDomain}` : undefined} target="_blank" rel="noopener noreferrer nofollow">
          {b.officialDomain || '官网待确认'}
        </a>
        <dl className="core-brand-hero-facts">
          <div><dt>主要市场</dt><dd>{[marketText(b.market), b.category].filter(Boolean).join(' · ') || '未标注'}</dd></div>
          <div><dt>官网确认</dt><dd>{d.officialSite ? d.officialSite.statusText : '未采集'}</dd></div>
          <div><dt>最近成功更新</dt><dd>{d.collection && d.collection.lastSuccessfulAt ? fmt(d.collection.lastSuccessfulAt, true) : '—'}</dd></div>
          <div>
            <dt>正式监控</dt>
            <dd>
              <span className={'core-badge ' + (monitorOn ? 'core-badge-ok' : 'core-badge-neutral')}>
                {mon ? mon.stateText : '未加入监控'}
              </span>
              {mon && mon.signalsText ? <span className="core-brand-muted core-brand-mini">（{mon.signalsText}）</span> : null}
            </dd>
          </div>
        </dl>
        <div className="core-brand-hero-actions">
          <button type="button" className="btn-mini" disabled={refreshing} onClick={doRefresh}>
            {refreshing ? '正在更新…' : '立即更新'}
          </button>
          <Link className="btn-ghost btn-mini" href={`/intel?${keep}&brandId=${encodeURIComponent(b.brandId)}`}>
            {monitorOn ? '管理监控' : '加入监控'}
          </Link>
          {refreshMsg ? <span className="core-brand-muted core-brand-mini">{refreshMsg}</span> : null}
        </div>
      </header>

      {/* ---------- 第一屏摘要：最多四张卡 ---------- */}
      <section className="core-sum-grid" data-testid="brand-summary-cards">
        <article className="core-sum-card">
          <h3>已积累时长</h3>
          <p className="core-sum-main">{acc.main}</p>
          <p className="core-sum-sub">{acc.sub}</p>
        </article>
        <article className="core-sum-card">
          <h3>可核验变化</h3>
          <p className="core-sum-main">{changeCount > 0 ? `${changeCount} 条` : '暂无'}</p>
          <p className="core-sum-sub">
            {changeCount > 0
              ? `最近 ${fmt(vc?.lastAt || null, true)}`
              : '有可核实的变化才会记录；没有记录不代表没有变化。'}
          </p>
        </article>
        <article className="core-sum-card">
          <h3>商品与价格</h3>
          <p className="core-sum-main">
            {products.observations.length ? `${products.observations.length} 款在售` : '暂无商品观察'}
          </p>
          <p className="core-sum-sub">
            {priceText2 ? `价格带 ${priceText2}` : '采集到公开商品价格后显示区间'}
            {products.collectedAt ? ` · ${fmt(products.collectedAt)}` : ''}
          </p>
        </article>
        <article className="core-sum-card">
          <h3>数据覆盖</h3>
          <p className="core-sum-main">{sum.available} / {sum.total} 个维度</p>
          <p className="core-sum-sub">
            {[
              sum.collecting ? `${sum.collecting} 个正在采集` : null,
              sum.failed ? `${sum.failed} 个未成功` : null,
              staleDims ? `${staleDims} 个用历史数据` : null,
              (sum.notConfigured || 0) ? `${sum.notConfigured} 个未接入` : null,
            ].filter(Boolean).join(' · ') || '暂无可展示数据'}
            {' · '}
            <button type="button" className="core-link-btn" onClick={() => switchTab('sources')}>查看明细</button>
          </p>
        </article>
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

      {/* ---------- ① 概览：结论 + 下一步（不复制各 Tab 正文、不重复覆盖面板） ---------- */}
      {tab === 'overview' && (
        <section className="core-sec">
          <div className="core-overview-two">
            <div>
              <h3>最近一次可核验变化</h3>
              {d.lastVerifiedChange ? (
                <p className="core-overview-main">
                  <span className={`core-badge core-badge-info`}>{DIM_TEXT[d.lastVerifiedChange.dimension] || '变化'}</span>
                  <span>{d.lastVerifiedChange.title}</span>
                  <span className="core-brand-muted core-brand-mini">{fmt(d.lastVerifiedChange.at, true)}</span>
                </p>
              ) : (
                <p className="core-brand-muted">暂未观察到可核验变化（不代表该品牌没有变化）。</p>
              )}
            </div>
            <div>
              <h3>下一步</h3>
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
          <p className="desc">按时间倒序排列：价格变化、上新与下架、库存、官网内容、评论、内容与广告、报告生成。首次观察是档案起点，不是变化。</p>
          {rangePicker}
          {loadErr ? <p className="core-err">{loadErr}</p> : null}
          {tl ? (
            (tl.items && tl.items.length)
              ? <MemoryTimelineList data={tl} onEvidence={setEvRefs} />
              : <EmptyState title="这段时间还没有记录" sub="换个时间范围，或先在「数据覆盖与来源」发起一次采集。" />
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
                    {o.observedAt ? <span className="core-obs-meta">{fmt(o.observedAt, true)}</span> : null}
                  </li>
                ))}
              </ul>
              {products.evidenceRefs && products.evidenceRefs.length ? (
                <p className="core-obs-ev">
                  <button type="button" className="btn-mini btn-ghost" onClick={() => setEvRefs(products.evidenceRefs)}>查看证据（{products.evidenceRefs.length}）</button>
                </p>
              ) : null}
            </details>
          ) : null}
        </section>
      )}

      {/* ---------- ④ 用户声音与公开评论 ---------- */}
      {tab === 'voice' && (
        <section className="core-sec">
          <VoicePanel voice={d.unifiedVoice} onEvidence={setEvRefs} />
          <div className="core-sub" data-testid="reviews-observations">
            <h3>公开评论页</h3>
            {reviewsDet && reviewsDet.observations.length ? (
              <>
                <p className="hint">本次采集到 {reviewsDet.observations.length} 个可访问的公开页面{reviewsDet.collectedAt ? `（${fmt(reviewsDet.collectedAt, true)}）` : ''}；样本不等于全网口碑。</p>
                <ObsList items={reviewsDet.observations} evidenceRefs={reviewsDet.evidenceRefs} onEvidence={setEvRefs} />
              </>
            ) : (
              <p className="hint">
                {(bc.dimensions.find(x => x.code === 'reviews_reputation') || {}).stateText || '尚未采集'}
                ；暂无可展示的公开评论页观察。
              </p>
            )}
          </div>
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
              <>
                <ul className="core-dim-list">
                  {dims.map(x => (
                    <li key={x.code}>
                      <b>{x.label}</b>：{x.stateText}
                      {x.observationCount ? <span className="hint">（{x.observationCount} 条观察，{x.evidenceCount} 条证据）</span> : null}
                    </li>
                  ))}
                </ul>
                {socialDet && socialDet.observations.length ? (
                  <div className="core-sub">
                    <h3>公开内容（{socialDet.observations.length} 条，{socialDet.collectedAt ? fmt(socialDet.collectedAt, true) : '—'}）</h3>
                    <ObsList items={socialDet.observations} evidenceRefs={socialDet.evidenceRefs} onEvidence={setEvRefs} />
                  </div>
                ) : null}
                {adsDet && adsDet.observations.length ? (
                  <div className="core-sub">
                    <h3>公开广告信息（{adsDet.observations.length} 条）</h3>
                    <ObsList items={adsDet.observations} evidenceRefs={adsDet.evidenceRefs} onEvidence={setEvRefs} />
                  </div>
                ) : null}
              </>
            );
          })()}
          <div className="core-sub" data-testid="search-interest">
            <h3>搜索热度</h3>
            {searchDet && searchDet.observations.length ? (
              <>
                <p className="hint">数据服务估算（非绝对搜索量，不等于销量或市场份额）{searchDet.collectedAt ? `　观察时间：${fmt(searchDet.collectedAt, true)}` : ''}</p>
                <ObsList items={searchDet.observations} evidenceRefs={searchDet.evidenceRefs} onEvidence={setEvRefs} />
              </>
            ) : (
              <p className="hint">{(bc.dimensions.find(x => x.code === 'search_interest') || {}).stateText || '尚未采集'}；该维度不生成任何估算数据。</p>
            )}
          </div>
          <p className="hint">
            <Link href={`/intel?${keep}&brandId=${encodeURIComponent(b.brandId)}`}>在每日变化收件箱里查看该品牌的变化 →</Link>
          </p>
        </section>
      )}

      {/* ---------- ⑥ 数据覆盖与来源（覆盖明细的唯一位置） ---------- */}
      {tab === 'sources' && (
        <section className="core-sec" id="coverage">
          <h3>数据覆盖与来源</h3>
          <p className="desc">每个数据维度的真实来源状态、最近观察时间、观察与证据条数；同一失败原因只说明一次。</p>
          <table className="core-cov-table" data-testid="brand-coverage-table">
            <thead>
              <tr><th>维度</th><th>状态</th><th>最近观察</th><th>观察</th><th>证据</th><th>来源</th><th>说明</th></tr>
            </thead>
            <tbody>
              {(() => {
                const seenFail = new Set<string>();
                return bc.dimensions.map(x => {
                  const failOnce = !!x.latestFailureText && !seenFail.has(x.latestFailureText);
                  if (failOnce && x.latestFailureText) seenFail.add(x.latestFailureText);
                  return (
                    <tr key={x.code} className={'core-cov-row core-cov-' + x.state}>
                      <td>{x.label}</td>
                      <td><span className={'core-badge core-badge-' + (x.state === 'available' ? 'ok' : x.state === 'failed' ? 'danger' : x.state === 'collecting' ? 'info' : 'neutral')}>{x.stateText}</span></td>
                      <td>{x.lastObservedAt ? fmt(x.lastObservedAt) : '—'}</td>
                      <td>{x.state === 'available' ? x.observationCount : '—'}</td>
                      <td>{x.state === 'available' ? x.evidenceCount : '—'}</td>
                      <td>{x.state === 'available' && x.sourceCount ? x.sourceCount : '—'}</td>
                      <td className="core-cov-note">
                        {failOnce ? (x.latestFailureText || '') : (x.usingPreviousData ? '' : (x.reason === 'credential_required' ? '' : (x.note || '')))}
                      </td>
                    </tr>
                  );
                });
              })()}
            </tbody>
          </table>
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
