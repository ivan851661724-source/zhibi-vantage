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

// SC-09 §四：详情 Tab 的真实观察列表（只渲染后端返回的 observations；无数据不渲染）
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
  // SC-12 §五：品牌级「立即更新」（真实刷新 → 后端 202 入队）
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
  // SC-08 r3 §三：有历史数据但最近一次更新失败的维度数（旧数据保留，不冒充正常）
  const staleDims = (bc.dimensions || []).filter(x => x.usingPreviousData).length;
  // SC-09 §四：评论/社媒/热度/广告的真实 observations（后端只读派生）
  const dd = (d.dimensionDetails || {}) as Record<string, { observations: DimensionObservation[]; summary: Record<string, unknown> | null; collectedAt: string | null; evidenceRefs: { evidenceId: string | null; snapshotId: string | null; sourceUrl: string | null; label?: string | null }[] }>;
  const reviewsDet = dd.reviews_reputation || null;
  const socialDet = dd.social_content || null;
  const searchDet = dd.search_interest || null;
  const adsDet = dd.ad_campaigns || null;
  const products = d.products || { observations: [], summary: null, hasAttempt: false, collectedAt: null, evidenceRefs: [] };
  // 可核验证据数：各维度 Evidence 引用去重（不重复计数同一证据）
  // （普通计算而非 useMemo：位于早返回之后，Hooks 不可条件调用）
  const evidenceSet = new Set<string>();
  for (const dim of Object.values(dd || {})) {
    for (const r of (dim && dim.evidenceRefs) || []) if (r && r.evidenceId) evidenceSet.add(r.evidenceId);
  }
  for (const r of (products.evidenceRefs || [])) if (r && r.evidenceId) evidenceSet.add(r.evidenceId);
  const evidenceTotal = evidenceSet.size;
  // 「立即更新」目标：优先修复失败/待更新的维度；否则刷新评论能力（真实请求，非前端伪造状态）
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
      setRefreshMsg(r && r.attempt ? '已入队，完成后自动更新' : '已入队');
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

  // 下一步（只在概览出现一次；按真实状态给可执行动作）
  const nextStep = (() => {
    // SC-08 r4 §5：「部分维度旧数据可用但最近更新失败」必须最先说清，
    // 不得与「数据正在按计划正常积累」同页并存（一个说失败、一个说正常 = 自相矛盾）
    if (staleDims > 0) return '部分维度已有历史数据，但最近一次更新失败；请查看「来源与采集记录」了解原因，最近一次成功后这里会自动恢复。';
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
          {/* SC-08 r3 §三：「成功观察」只认最近一次成功采集（lastSuccessfulAt），
              失败的采集不能冒充成功观察时间 */}
          <div><dt>最近一次成功观察</dt><dd>{d.collection && d.collection.lastSuccessfulAt ? fmt(d.collection.lastSuccessfulAt, true) : '—'}</dd></div>
          <div><dt>已接入维度</dt><dd>{configuredDims} / {sum.total}{sum.available ? `（${sum.available} 个已有数据）` : ''}</dd></div>
          <div><dt>可核验证据</dt><dd>{evidenceTotal} 条</dd></div>
        </dl>
        {/* SC-12 §五：品牌总览必须给「立即更新」与「加入/管理监控」两个操作 */}
        <div className="core-brand-hero-actions">
          <button type="button" className="btn-mini" disabled={refreshing} onClick={doRefresh}>
            {refreshing ? '正在更新…' : '立即更新'}
          </button>
          {/* 监控管理入口在情报库的品牌档案（MonitoringControls 所在处），不得指向不存在的路由 */}
          <Link className="btn-ghost btn-mini" href={`/intel?${keep}&brandId=${encodeURIComponent(b.brandId)}`}>加入 / 管理监控</Link>
          {refreshMsg ? <span className="core-brand-muted core-brand-mini">{refreshMsg}</span> : null}
        </div>
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
                {/* SC-08 r3 §三：旧数据仍可用但最近更新失败的维度，不冒充完全正常 */}
                {staleDims ? `、${staleDims} 个已有历史数据但最近更新失败` : ''}
                {sum.notConfigured ? `、${sum.notConfigured} 个未接入` : ''}。
              </p>
              <button type="button" className="btn-ghost btn-mini" onClick={() => switchTab('sources')}>查看来源与采集记录</button>
            </div>
            <div className="core-overview-card">
              <h4>下一步</h4>
              <p className="core-overview-main">{nextStep}</p>
            </div>
            {/* SC-12 §五.1：概览补商品/声音/内容摘要与数据完整度（不复制诊断区） */}
            <div className="core-overview-card">
              <h4>商品与价格</h4>
              <p className="core-overview-main">
                {products.observations.length
                  ? `${products.observations.length} 款在售观察${productPriceText(products.observations) ? ' · ' + productPriceText(products.observations) : ''}`
                  : <span className="core-brand-muted">尚无商品观察</span>}
              </p>
              {products.collectedAt ? <p className="core-brand-muted core-brand-mini">采集于 {fmt(products.collectedAt, true)}</p> : null}
            </div>
            <div className="core-overview-card">
              <h4>用户声音</h4>
              <p className="core-overview-main">
                {reviewsDet && reviewsDet.observations.length
                  ? `${reviewsDet.observations.length} 个可核验公开页面`
                  : <span className="core-brand-muted">尚无公开评论观察</span>}
              </p>
              {reviewsDet && reviewsDet.collectedAt ? <p className="core-brand-muted core-brand-mini">采集于 {fmt(reviewsDet.collectedAt, true)}</p> : null}
            </div>
            <div className="core-overview-card">
              <h4>内容与广告</h4>
              <p className="core-overview-main">
                {socialDet && socialDet.observations.length
                  ? `${socialDet.observations.length} 条内容观察`
                  : (searchDet && searchDet.observations.length ? `${searchDet.observations.length} 条热度观察` : null)
                    || (adsDet && adsDet.observations.length ? `${adsDet.observations.length} 条广告观察` : null)
                    || <span className="core-brand-muted">该维度数据服务尚未接入</span>}
              </p>
              <p className="core-brand-muted core-brand-mini">未接入的维度不生成数据、估算或结论。</p>
            </div>
            <div className="core-overview-card">
              <h4>数据完整度</h4>
              <p className="core-overview-main">
                {sum.total} 个维度中 {sum.available} 个已有数据、{sum.collecting} 个正在采集
                {sum.failed ? `、${sum.failed} 个需要处理` : ''}
                {staleDims ? `、${staleDims} 个已有历史数据但最近更新失败` : ''}，
                共 {evidenceTotal} 条可核验证据。
              </p>
              <button type="button" className="btn-ghost btn-mini" onClick={() => switchTab('sources')}>查看数据覆盖与来源</button>
            </div>
            <div className="core-overview-card">
              <h4>相关报告</h4>
              <p className="core-overview-main">基于该品牌已核验事实生成调研报告（含证据引用与冻结事实包）。</p>
              <Link className="btn-ghost btn-mini" href={`/report?${keep}`}>打开调研报告</Link>
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
          {/* SC-09 §四：公开评论页的真实观察（不是搜索摘要，正文经合规抓取） */}
          <div className="core-sub" data-testid="reviews-observations">
            <h4>公开评论页</h4>
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
                {/* SC-09 §四：真实内容观察（YouTube 公开视频等） */}
                {socialDet && socialDet.observations.length ? (
                  <div className="core-sub">
                    <h4>公开内容（{socialDet.observations.length} 条，{socialDet.collectedAt ? fmt(socialDet.collectedAt, true) : '—'}）</h4>
                    <ObsList items={socialDet.observations} evidenceRefs={socialDet.evidenceRefs} onEvidence={setEvRefs} />
                  </div>
                ) : null}
                {adsDet && adsDet.observations.length ? (
                  <div className="core-sub">
                    <h4>公开广告信息（{adsDet.observations.length} 条）</h4>
                    <ObsList items={adsDet.observations} evidenceRefs={adsDet.evidenceRefs} onEvidence={setEvRefs} />
                  </div>
                ) : null}
              </>
            );
          })()}
          <div className="core-sub" data-testid="search-interest">
            <h4>搜索热度</h4>
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
              {/* SC-08 r3 §三：同一失败原因只显示一次（多维度同因时只在第一行出现） */}
              {(() => {
                const seenFail = new Set<string>();
                return bc.dimensions.map(x => {
                  const failOnce = !!x.latestFailureText && !seenFail.has(x.latestFailureText);
                  if (failOnce && x.latestFailureText) seenFail.add(x.latestFailureText);
                  return (
                    <tr key={x.code} className={'core-cov-row core-cov-' + x.state}>
                      <td>{x.label}</td>
                      <td><span className={'core-cov-badge core-cov-badge-' + x.state}>{x.stateText}</span></td>
                      <td>{x.lastObservedAt ? fmt(x.lastObservedAt) : '—'}</td>
                      <td>{x.state === 'available' ? x.observationCount : '—'}</td>
                      <td>{x.state === 'available' ? x.evidenceCount : '—'}</td>
                      <td>{x.state === 'available' && x.sourceCount ? x.sourceCount : '—'}</td>
                      <td className="core-cov-note">
                        {/*「已有历史数据」由状态徽标表达；说明列只放失败原因，不重复 */}
                        {failOnce ? (x.latestFailureText || '') : (x.usingPreviousData ? '' : (x.reason === 'credential_required' ? '' : (x.note || '')))}
                      </td>
                    </tr>
                  );
                });
              })()}
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
