'use client';
// ============================================================
// 竞品数据库（SC-08 r2 §四）
// 定位：项目内所有竞争品牌的**长期数据档案入口**——不是调试信息列表。
//
// 页面结构（自上而下，只有这四块）：
//   ① 标题 + 一句普通用户能读懂的说明
//   ② 紧凑项目统计：品牌总数 / 已开始积累 / 正在采集 / 需要处理
//   ③ 同一工具栏：搜索 + 状态 + 关系筛选（移动端纵向堆叠）
//   ④ 品牌卡片网格：1920 → 3 列；1440 → 2–3 列；390 → 1 列
//
// 每张卡片只有六项 + 一个主按钮：
//   品牌名 / 官网 / 关系 · 官网确认状态 · 正式监控状态 · 已有真实数据的维度 ·
//   最近一次可核验变化 · 数据积累起点 · 「查看品牌档案」
// 纪律：内部状态、英文枚举、attempt、provider、技术错误码一律不出现在卡片上；
//       「尚未开始采集」不等于「没有数据」，「来源未接入」不等于「没有变化」。
// ============================================================
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { fetchBrands, retryFirstCollection, type BrandListItem, type BrandsProjectStats, type FirstCollectionSummary } from '@/lib/core-api';
import { apiPost } from '@/lib/api';
import { BRAND_COVER_TEXT, CARD_STATUS_TEXT, brandCoverState, allBrandsNotCollected, relationText, type BrandCoverState } from '@/lib/core-logic';
import type { BrandsHealthSummary } from '@/lib/core-api';
import { EmptyState } from '@/components/core-ui';

export default function BrandsPage() {
  return (
    <Suspense fallback={<p className="hint">加载竞品数据库…</p>}>
      <BrandsInner />
    </Suspense>
  );
}

const COVER_FILTERS: { value: '' | BrandCoverState; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'hasData', label: '已有数据' },
  { value: 'partial', label: '部分维度有数据' },
  { value: 'collecting', label: '正在采集' },
  { value: 'failed', label: '需要处理' },
  { value: 'notCollected', label: '尚未开始采集' },
  { value: 'notIntegrated', label: '来源未接入' },
];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString(); } catch (e) { return '—'; }
}
// 精确到分钟即可：秒级时间戳是机器口径，不该占据卡片视线
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) { return '—'; }
}
// SC-09：真实状态的人话（不出现英文枚举/技术码）
const SEARCH_STATE_TEXT: Record<string, string> = {
  available: '已有估算',
  not_configured: '数据服务暂不可用',
  not_started: '尚未采集',
};
const ADS_COVERAGE_TEXT: Record<string, string> = {
  covered: '该来源覆盖此市场',
  out_of_coverage: '该来源不覆盖此市场',
  unknown: '覆盖范围未知',
};
function priceRangeText(d: { priceMin: number | null; priceMax: number | null; currencies: string[] } | null | undefined): string | null {
  if (!d || d.priceMin == null || d.priceMax == null) return null;
  const cur = (d.currencies || [])[0] || '';
  return `${cur ? cur + ' ' : ''}${d.priceMin}–${d.priceMax}`;
}

const DIM_LABEL: Record<string, string> = {
  price: '价格', website: '官网内容', product: '商品', stock: '库存',
  review: '评论', social: '社媒', ads: '广告', search: '搜索热度',
};

function BrandsInner() {
  const { state } = useZhibiState();
  const sp = useSearchParams();
  const projectId = String(sp.get('projectId') || (state as { projectId?: string } | null)?.projectId || '');
  const [items, setItems] = useState<BrandListItem[]>([]);
  const [stats, setStats] = useState<BrandsProjectStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [kw, setKw] = useState('');
  const [cover, setCover] = useState<'' | BrandCoverState>('');
  const [rel, setRel] = useState('');
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootMsg, setBootMsg] = useState<string | null>(null);
  const [inFlight, setInFlight] = useState(false);
  // SC-09：项目级首采（后端自动建立，前端只轮询到终态，不需要用户逐个点击）
  const [fc, setFc] = useState<FirstCollectionSummary | null>(null);
  // r3：品牌级四类计数（去重品牌；后端 SourceHealth 汇总，前端不再按维度累加）
  const [hs, setHs] = useState<BrandsHealthSummary | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryMsg, setRetryMsg] = useState<string | null>(null);

  // 一次补齐首轮采集（有界、幂等；重复点击不会重复产生任务）
  const startBootstrap = async () => {
    setBootstrapping(true);
    setBootMsg(null);
    try {
      const r = await apiPost<{ counts?: Record<string, number>; brands?: number }>(
        '/api/data-surface/bootstrap', { projectId, maxReviews: 5 },
      );
      const c = (r && r.counts) || {};
      setBootMsg(`已入队 ${c.enqueued || 0} 项 / 去重 ${c.deduped || 0} 项 / 跳过 ${c.skipped || 0} 项（共 ${(r && r.brands) || 0} 个品牌）`);
      const fresh = await fetchBrands(projectId);
      setItems(fresh.brands || []);
      setStats(fresh.stats || null);
    } catch (e) {
      setBootMsg(e instanceof Error ? e.message : '入队失败');
    } finally {
      setBootstrapping(false);
    }
  };

  // 跨项目切换：搜索/状态/关系是原项目的浏览上下文，残留会造成「假空结果」
  const prevPidRef = useRef(projectId);
  useEffect(() => {
    if (prevPidRef.current === projectId) return;
    prevPidRef.current = projectId;
    setKw('');
    setCover('');
    setRel('');
    setBootMsg(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    let alive = true;
    const ctrl = new AbortController();
    setLoading(true);
    fetchBrands(projectId, ctrl.signal)
      .then(r => {
        if (!alive) return;
        setItems(r.brands || []);
        setStats(r.stats || null);
        setFc(r.firstCollection || null);
        setHs(r.healthSummary || null);
        setInFlight((r.collectionCoverage && r.collectionCoverage.anyInFlight) || false);
        setErr(null);
      })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; ctrl.abort(); };
  }, [projectId]);

  // 有排队/采集中任务、或首采未到终态时定时刷新（用户不需要手动刷新页面）
  const fcRunning = !!(fc && (fc.executionStatus === 'running' || fc.status === 'running'));
  // r2 §四：执行完成 ≠ 数据齐全。存在失败或仍未配置的来源时，不得只显示绿色「已完成」。
  const fcExecRunning = fcRunning;
  const fcCoveragePartial = !!(fc && fc.coverageStatus === 'partial');
  const fcHeadline = !fc ? ''
    : fcExecRunning ? '正在采集'
      : fcCoveragePartial ? '首轮检查已完成'
        : '已完成';
  // r3 §四：口径改为**品牌级**（同一品牌多个能力不再累加成「N 个来源」）；
  // 有限覆盖与覆盖限制分别说，不混进「需要处理」。
  const fcNote = !fc ? ''
    : fcExecRunning ? '结果会自动更新，无需刷新页面'
      : hs && hs.needsHandling > 0 ? `首轮检查已完成，${hs.needsHandling} 个品牌需要处理`
        : hs && hs.limited > 0 ? `首轮检查已完成，${hs.limited} 个品牌仅能监控部分信号`
          : hs && (hs.partialSignalBrands ?? hs.limits) > 0 ? `首轮检查已完成，${hs.partialSignalBrands ?? hs.limits} 个品牌存在部分信号限制、${hs.notIntegratedDimensions ?? 0} 个维度尚未接入`
            : '数据已齐全';
  useEffect(() => {
    if (!projectId || (!inFlight && !fcRunning)) return;
    let alive = true;
    const t = setInterval(() => {
      fetchBrands(projectId)
        .then(r => {
          if (!alive) return;
          setItems(r.brands || []);
          setStats(r.stats || null);
          setFc(r.firstCollection || null);
          setHs(r.healthSummary || null);
          setInFlight((r.collectionCoverage && r.collectionCoverage.anyInFlight) || false);
        })
        .catch(() => { /* 单次轮询失败不打断页面 */ });
    }, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [projectId, inFlight, fcRunning]);

  // SC-09：重新检查失败项（幂等：只重排失败项，不动已成功的项）
  const retryFailedItems = async () => {
    if (!projectId) return;
    setRetrying(true); setRetryMsg(null);
    try {
      const r = await retryFirstCollection(projectId);
      setRetryMsg(r.message || null);
      setFc(r.firstCollection || null);
      const fresh = await fetchBrands(projectId);
      setItems(fresh.brands || []);
      setStats(fresh.stats || null);
      setFc(fresh.firstCollection || null);
      setHs(fresh.healthSummary || null);
    } catch (e) {
      setRetryMsg(e instanceof Error ? e.message : '重试失败，请稍后再试。');
    } finally { setRetrying(false); }
  };

  const relOptions = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of items) {
      const k = b.relation || '竞品';
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()];
  }, [items]);

  const filtered = useMemo(() => {
    const kwN = kw.trim().toLowerCase();
    return items.filter(b => {
      if (kwN && !(`${b.name}`.toLowerCase().includes(kwN) || `${b.officialDomain || ''}`.toLowerCase().includes(kwN))) return false;
      if (cover && brandCoverState(b) !== cover) return false;
      if (rel && (b.relation || '竞品') !== rel) return false;
      return true;
    });
  }, [items, kw, cover, rel]);

  const hasFilter = !!(kw.trim() || cover || rel);

  if (!projectId) return <p className="hint">请先创建或选择项目（右上角可切换项目）。</p>;
  if (loading) return <p className="hint">加载竞品数据库…</p>;
  if (err) return <p className="core-err">{err}</p>;

  return (
    <div className="core-brands">
      <div className="page-head">
        <div>
          <h2>竞品数据库</h2>
          <p className="desc">这里长期保存项目内每个竞争品牌的公开数据档案：官网与商品、用户声音、内容与广告，以及每天发生的变化。</p>
        </div>
        <Link className="btn-ghost" href={`/radar?projectId=${encodeURIComponent(projectId)}`}>去发现竞品</Link>
      </div>

      {/* SC-09 ② 首轮采集进度（后端自动建立；轮询到终态，无需逐个点击品牌/手动刷新）
          r2 §四：执行状态与覆盖状态分开——「首轮检查已完成」不等于「数据已齐全」 */}
      {fc ? (
        <div className="core-fc" data-testid="first-collection" data-execution={fc.executionStatus} data-coverage={fc.coverageStatus}>
          <div className="core-fc-head">
            <b>首轮采集</b>
            <span className={'core-fc-state ' + (fcExecRunning ? 'core-fc-running' : fcCoveragePartial ? 'core-fc-partial' : 'core-fc-complete')}>
              {fcHeadline}
            </span>
            <span className="core-fc-progress">{fc.brandsDone} / {fc.brandsTotal} 个品牌已完成</span>
            <span className={fcCoveragePartial ? 'core-fc-hint is-warn' : 'core-fc-hint'}>{fcNote}</span>
          </div>
          <div className="core-fc-bar" role="progressbar" aria-valuemin={0} aria-valuemax={fc.brandsTotal || 1} aria-valuenow={fc.brandsDone}>
            <i style={{ width: (fc.brandsTotal ? Math.round((fc.brandsDone / fc.brandsTotal) * 100) : 0) + '%' }} />
          </div>
          <div className="core-fc-facts">
            <span>已建立数据 <b>{hs ? hs.established : 0}</b></span>
            <span>正在采集 <b>{hs ? hs.collecting : 0}</b></span>
            <span>有限覆盖 <b>{hs ? hs.limited : 0}</b></span>
            <span className={hs && hs.needsHandling > 0 ? 'is-warn' : ''}>需要处理 <b>{hs ? hs.needsHandling : 0}</b></span>
            <span className="core-fc-limit">部分信号品牌 <b>{hs ? (hs.partialSignalBrands ?? hs.limits) : 0} 个</b> · 尚未接入维度 <b>{hs ? (hs.notIntegratedDimensions ?? 0) : 0} 个</b></span>
            {/* SC-12 §四：首页不铺 attempt 级计数（失败/未配置/不覆盖明细属诊断区） */}
            {fc.canRetry ? (
              <button type="button" className="btn-ghost btn-mini" disabled={retrying} onClick={retryFailedItems}>
                {retrying ? '正在重试…' : '重新检查失败项'}
              </button>
            ) : null}
          </div>
          {retryMsg ? <p className="hint">{retryMsg}</p> : null}
        </div>
      ) : null}

      {/* ③ 紧凑项目统计（后端同源派生；点击「需要处理」可直接筛选） */}
      <div id="coverage" className="core-stat-row" data-testid="brands-stats">
        <div className="core-stat"><span className="core-stat-num">{stats ? stats.brands : items.length}</span><span className="core-stat-label">品牌总数</span></div>
        <div className="core-stat"><span className="core-stat-num">{hs ? hs.established : 0}</span><span className="core-stat-label">已建立数据</span></div>
        <div className="core-stat"><span className="core-stat-num">{hs ? hs.collecting : 0}</span><span className="core-stat-label">正在采集</span></div>
        <div className="core-stat"><span className="core-stat-num">{hs ? hs.limited : 0}</span><span className="core-stat-label">有限覆盖</span></div>
        <div className={'core-stat' + (hs && hs.needsHandling > 0 ? ' is-warn' : '')}>
          <span className="core-stat-num">{hs ? hs.needsHandling : 0}</span><span className="core-stat-label">需要处理</span>
        </div>
        <div className="core-stat"><span className="core-stat-num">{hs ? (hs.partialSignalBrands ?? hs.limits) : 0}</span><span className="core-stat-label">部分信号品牌</span></div>
        <div className="core-stat"><span className="core-stat-num">{hs ? (hs.notIntegratedDimensions ?? 0) : 0}</span><span className="core-stat-label">尚未接入维度</span></div>
      </div>

      {/* ③ 统一工具栏 */}
      <div className="core-brand-filters">
        <input type="search" placeholder="搜索品牌名或官网" value={kw} onChange={(e) => setKw(e.target.value)} />
        <select value={cover} onChange={(e) => setCover(e.target.value as '' | BrandCoverState)} aria-label="状态筛选">
          {COVER_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <select value={rel} onChange={(e) => setRel(e.target.value)} aria-label="关系筛选">
          <option value="">全部关系</option>
          {relOptions.map(([k, n]) => <option key={k} value={k}>{relationText(k)}（{n}）</option>)}
        </select>
        <span className="core-brand-count">{filtered.length} / {items.length} 个品牌</span>
      </div>

      {bootMsg ? <p className="hint">{bootMsg}</p> : null}

      {!items.length ? (
        <EmptyState
          title="还没有竞争品牌"
          sub="先在竞品监控确认品牌（或从工作台发现），这里会为每个品牌建立长期数据档案。"
          action={<Link className="btn primary" href={`/radar?projectId=${encodeURIComponent(projectId)}`}>去发现竞品</Link>}
        />
      ) : allBrandsNotCollected(items) && !hasFilter && !(fc && (fc.status === 'running' || fc.brandsDone > 0)) ? (
        <EmptyState
          title="品牌已登记，首轮采集尚未开始"
          sub={`已登记 ${items.length} 个竞争品牌。系统会按公开来源逐项采集（官网资料 / 公开商品页 / 公开评论），完成后这里会显示各自的档案。`}
          action={<button type="button" className="btn primary" disabled={bootstrapping} onClick={startBootstrap}>{bootstrapping ? '正在入队…' : '开始首轮采集'}</button>}
        />
      ) : !filtered.length ? (
        <EmptyState
          title="当前筛选没有结果"
          sub="换个关键词，或清除状态 / 关系筛选。"
          action={<button type="button" className="btn-ghost" onClick={() => { setKw(''); setCover(''); setRel(''); }}>清除筛选</button>}
        />
      ) : (
        <ul className="core-brand-grid">
          {filtered.map(b => {
            const cs = brandCoverState(b);
            const sum = b.brandCoverage.summary;
            const dims = b.brandCoverage.dataDimensions || [];
            const mon = b.monitoring;
            const dg = b.collectionDigest || null;
            const st = b.status || { code: 'not_started', text: CARD_STATUS_TEXT.not_started, detail: null };
            const href = `/brands/${b.brandId}?projectId=${encodeURIComponent(projectId)}`;
            return (
              <li key={b.brandId} className="core-brand-card">
                <div className="core-brand-card-head">
                  <Link className="core-brand-name" href={href} title={b.name}>{b.name}</Link>
                  <span className="core-brand-rel">{relationText(b.relation)}</span>
                </div>
                <p className="core-brand-domain" title={b.officialDomain || ''}>{b.officialDomain || '官网待确认'}</p>

                {/* SC-12 §四：卡片只保留 7 项——品牌名/域名/关系、官网确认、正式监控、
                    已获得数据的维度数、最近一次可核验变化、时间积累起点、一个主操作。
                    采集失败不占整张卡，只给「需要处理」短状态，详细原因在「数据覆盖与来源」。 */}
                <dl className="core-brand-facts">
                  <div><dt>官网</dt><dd>{b.officialSite ? b.officialSite.statusText : '尚未采集'}</dd></div>
                  <div><dt>监控</dt><dd className={mon && mon.state === 'active' ? 'is-on' : undefined}>
                    {mon ? mon.stateText : '未加入监控'}{mon && mon.signalsText ? <span className="core-brand-sig">{mon.signalsText}</span> : null}
                  </dd></div>
                  <div><dt>已有数据</dt><dd>{dims.length} / {sum.total} 个维度</dd></div>
                  {b.lastVerifiedChange ? (
                    <div><dt>最近变化</dt><dd>
                      <span className="core-brand-change-line" title={b.lastVerifiedChange.title}>
                        {DIM_LABEL[b.lastVerifiedChange.dimension] || '变化'} · {fmtDateTime(b.lastVerifiedChange.at)}
                      </span>
                    </dd></div>
                  ) : (
                    <div><dt>最近变化</dt><dd><span className="core-brand-muted">暂无可核验变化</span></dd></div>
                  )}
                  <div><dt>积累起点</dt><dd>{b.firstObservedAt ? fmtDate(b.firstObservedAt) : <span className="core-brand-muted">尚未开始</span>}</dd></div>
                </dl>

                {/* 短状态（后端单一真源；不出现长错误段落与内部码） */}
                <div className="core-brand-state" data-state={st.code}>
                  <span className={'core-state-chip core-state-' + st.code}>{st.text}</span>
                  {st.detail ? <span className="core-brand-muted core-brand-mini">{st.detail}</span> : null}
                </div>

                <div className="core-brand-card-foot">
                  <Link className="btn-mini core-brand-open" href={href}>查看品牌数据</Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
