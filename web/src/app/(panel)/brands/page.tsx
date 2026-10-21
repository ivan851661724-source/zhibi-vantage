'use client';
// 竞品数据库（SC-06 一）：项目内竞争品牌的统一数据库首页——官网确认状态 /
// 数据覆盖 / 最近可核验变化 / 时间积累起点，逐项可核。
// SC-06 信息架构：原「竞品库」列表即竞品数据库首页（不新建重复一级页面）；
// /brands 深链接与旧 URL 完全兼容。
// 术语纪律：「尚未采集」不写成「没有数据」；「未接入」不写成「未发现」。
import Link from 'next/link';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { fetchBrands, type BrandListItem, type CollectionCoverage } from '@/lib/core-api';
import { apiPost } from '@/lib/api';
import { BRAND_COVER_TEXT, brandCoverState, brandsEmptyKind, allBrandsNotCollected, type BrandCoverState } from '@/lib/core-logic';
import { CollectionCoverageStrip } from '@/components/collection-coverage';
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
  { value: 'hasData', label: '已采集' },
  { value: 'partial', label: '部分采集' },
  { value: 'collecting', label: '采集中' },
  { value: 'failed', label: '最近采集失败' },
  { value: 'notCollected', label: '尚未采集' },
  { value: 'notIntegrated', label: '未接入' },
];

function BrandsInner() {
  const { state } = useZhibiState();
  const sp = useSearchParams();
  const projectId = String(sp.get('projectId') || (state as { projectId?: string } | null)?.projectId || '');
  const [items, setItems] = useState<BrandListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [kw, setKw] = useState('');
  // SC-07 r2 §四：项目级采集覆盖（七态计数 + 失败明细），真实渲染后端 collectionCoverage
  const [coverage, setCoverage] = useState<CollectionCoverage | null>(null);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootMsg, setBootMsg] = useState<string | null>(null);

  // SC-07 §1：一次补齐首轮采集（不要求用户逐个点 15 次）；
  // 有界、可重复，幂等/冷却/额度由采集链路保证，重复点击不会重复产生任务。
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
      setCoverage(fresh.collectionCoverage || null);
    } catch (e) {
      setBootMsg(e instanceof Error ? e.message : '入队失败');
    } finally {
      setBootstrapping(false);
    }
  };
  const [cover, setCover] = useState<'' | BrandCoverState>('');
  const [rel, setRel] = useState('');

  // r3 修复：跨项目切换时重置搜索与筛选。搜索词/覆盖状态/竞争关系是原项目的
  // 浏览上下文，残留到目标项目会造成「假空结果」。
  const prevPidRef = useRef(projectId);
  useEffect(() => {
    if (prevPidRef.current === projectId) return;
    prevPidRef.current = projectId;
    setKw('');
    setCover('');
    setRel('');
  }, [projectId]);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    let alive = true;
    const ctrl = new AbortController();
    setLoading(true);
    fetchBrands(projectId, ctrl.signal)
      .then(r => { if (alive) { setItems(r.brands || []); setCoverage(r.collectionCoverage || null); setErr(null); } })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; ctrl.abort(); };
  }, [projectId]);

  // SC-07 r2 §四：有排队/采集中任务时定时刷新，直到进入终态
  //（不把运行中的任务写成「尚未开始」——终态前保持轮询）
  useEffect(() => {
    if (!projectId || !coverage?.anyInFlight) return;
    const t = setInterval(() => {
      fetchBrands(projectId)
        .then(r => setCoverage(r.collectionCoverage || null))
        .catch(() => { /* 单次轮询失败不打断页面 */ });
    }, 5000);
    return () => clearInterval(t);
  }, [projectId, coverage?.anyInFlight]);

  // 竞争关系候选（来自数据本身，不预设枚举）
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
          <p className="desc">项目内全部竞争品牌的统一数据库：官网确认状态、数据覆盖、最近可核验变化与时间积累起点，逐项可核。</p>
        </div>
        <Link className="btn-ghost" href={`/radar?projectId=${encodeURIComponent(projectId)}`}>去发现竞品</Link>
      </div>

      <div className="core-brand-filters">
        <input type="search" placeholder="搜索品牌名或官网" value={kw} onChange={(e) => setKw(e.target.value)} />
        <select value={cover} onChange={(e) => setCover(e.target.value as '' | BrandCoverState)}>
          {COVER_FILTERS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
        <select value={rel} onChange={(e) => setRel(e.target.value)}>
          <option value="">全部关系</option>
          {relOptions.map(([k, n]) => <option key={k} value={k}>{k}（{n}）</option>)}
        </select>
        <span className="core-brand-count">{filtered.length} / {items.length} 个品牌</span>
      </div>

      {bootMsg ? <p className="hint">{bootMsg}</p> : null}

      {/* SC-07 r2 §四：项目级采集状态（七态统一口径，与情报库一致） */}
      <CollectionCoverageStrip coverage={coverage} projectId={projectId} />

      {!items.length ? (
        <EmptyState
          title="尚未添加竞争品牌"
          sub="该项目还没有竞品。先在竞品雷达发现并添加品牌，这里会建立统一品牌档案；未采集的品牌会如实标注「尚未采集」。"
          action={<Link className="btn primary" href={`/radar?projectId=${encodeURIComponent(projectId)}`}>去发现竞品</Link>}
        />
      ) : allBrandsNotCollected(items) && !hasFilter ? (
        <EmptyState
          title="已登记品牌，首轮采集尚未开始"
          sub={`已登记 ${items.length} 个竞争品牌。系统会按公开来源逐项入队采集（官网资料 / Shopify 公开目录 / 公开评论）；此状态不代表这些品牌没有数据。`}
          action={<button type="button" className="btn primary" disabled={bootstrapping} onClick={startBootstrap}>{bootstrapping ? '正在入队…' : '补齐首轮采集'}</button>}
        />
      ) : !filtered.length ? (
        <EmptyState
          title="当前筛选没有结果"
          sub="换个关键词，或清除覆盖状态 / 竞争关系筛选后再试。"
          action={<button type="button" className="btn-ghost" onClick={() => { setKw(''); setCover(''); setRel(''); }}>清除筛选</button>}
        />
      ) : (
        <ul className="core-brand-list">
          {filtered.map(b => {
            const cs = brandCoverState(b);
            return (
              <li key={b.brandId} className="core-brand-card">
                <div className="core-brand-head">
                  <Link href={`/brands/${b.brandId}?projectId=${encodeURIComponent(projectId)}`}>{b.name}</Link>
                  <span className="core-brand-domain">{b.officialDomain || '官网未核实'}</span>
                  {b.market ? <span>{b.market}</span> : null}
                  {b.category ? <span>{b.category}</span> : null}
                  <span className="core-brand-rel">{b.relation || '竞品'}</span>
                  <span className={`core-cover-badge core-cover-${cs}`}>{BRAND_COVER_TEXT[cs]}</span>
                  {b.collection ? (
                    <span className={`core-coll-badge core-coll-${b.collection.state}`} title={b.collection.reason || undefined}>
                      {b.collection.stateText}
                    </span>
                  ) : null}
                </div>
                <div className="core-brand-cov">
                  <span className={'core-site-badge core-site-' + (b.officialSite ? b.officialSite.status : 'not_collected')}>{b.officialSite ? b.officialSite.statusText : '官网未采集'}</span>
                  <span>有数据 {b.coverageSummary.dimensionsWithData}/{b.coverageSummary.totalDimensions} 维度</span>
                  <span>资料缺口 {b.gaps.length} 项</span>
                  <span>最近成功观察：{b.lastObservedAt ? new Date(b.lastObservedAt).toLocaleString() : '尚未采集'}</span>
                  <span>时间积累起点：{b.firstObservedAt ? new Date(b.firstObservedAt).toLocaleDateString() : '尚无记录'}</span>
                </div>
                {b.lastChange ? (
                  <p className="core-brand-change">最近动态：{b.lastChange.title || b.lastChange.kindText}（{new Date(b.lastChange.at).toLocaleString()}）</p>
                ) : (
                  <p className="core-brand-change core-brand-nodynamic">暂未观察到可核实的竞争动态（不代表该品牌没有变化）。</p>
                )}
                <div className="core-brand-foot">
                  <Link className="btn-mini core-brand-open" href={`/brands/${b.brandId}?projectId=${encodeURIComponent(projectId)}`}>进入品牌档案</Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
