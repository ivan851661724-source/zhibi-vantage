'use client';
// ============================================================
// 情报库 = 每日变化收件箱（SC-08 §二 重做）
// 只回答一个问题：今天/最近一段时间，系统新发现了哪些竞争变化？
//
// 只展示（后端已保证）：基线建立后由两次可比较观察产生的确定性变化、正式监控窗口发现的变化。
// 每条必须带：品牌、变化类型、观察时间、核验状态、证据入口。
//
// 明确删除（§一.2 / §二 正文删除清单）：
//   品牌静态档案卡 / 采集任务统计 / 公开评论覆盖统计 / 资料缺口列表 /
//   独立「时序变化（系统推导）」区块 / 首次基线观察 / 报告生成记录 / 回补历史 / 失败维度卡。
// 采集状态只保留一个次级链接 → 竞品数据库的项目级覆盖区域。
// ============================================================
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { EvidenceDrawer } from '@/components/data-surface/evidence-drawer';
import type { SurfaceEvidenceRef } from '@/components/data-surface/types';
import { EmptyState } from '@/components/core-ui';
import { fetchBrands, fetchIntelInbox, type InboxEvent, type InboxGroup, type InboxSummary } from '@/lib/core-api';

// 变化类型（维度）——只列**真实接入**的维度；未接入维度不在前端造选项
const DIMENSIONS: { value: string; label: string }[] = [
  { value: '', label: '全部变化类型' },
  { value: 'price', label: '价格' },
  { value: 'website', label: '官网内容' },
];
const DIMENSION_LABEL: Record<string, string> = {
  price: '价格', product: '商品', stock: '库存', website: '官网内容',
  review: '评论', social: '社媒', ads: '广告', search: '搜索热度',
};
const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: '全部核验状态' },
  { value: 'verified', label: '已核实' },
  { value: 'pending', label: '待核实' },
];

const PAGE_SIZE = 30;
const POLL_MS = 30000;

function hhmm(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch (e) { return '—'; }
}
function dayLabel(date: string): string {
  const today = new Date();
  const y = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const yest = new Date(today.getTime() - 86400000);
  const yd = `${yest.getFullYear()}-${String(yest.getMonth() + 1).padStart(2, '0')}-${String(yest.getDate()).padStart(2, '0')}`;
  if (date === y) return '今天';
  if (date === yd) return '昨天';
  return date;
}

function IntelInboxBody({ projectId }: { projectId: string }) {
  const sp = useSearchParams();
  const [brandId, setBrandId] = useState(sp.get('brandId') || '');
  const [dimension, setDimension] = useState(sp.get('dimension') || '');
  const [status, setStatus] = useState(sp.get('verificationStatus') || '');
  const [from, setFrom] = useState(sp.get('from') || '');
  const [to, setTo] = useState(sp.get('to') || '');

  const [summary, setSummary] = useState<InboxSummary>({ today: 0, verified: 0, pending: 0, brandsChanged: 0 });
  const [groups, setGroups] = useState<InboxGroup[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [polling, setPolling] = useState<{ enabled: boolean; reason: string }>({ enabled: false, reason: '' });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drawerRefs, setDrawerRefs] = useState<SurfaceEvidenceRef[] | null>(null);
  // eventId 去重（轮询 / 加载更多都不得重复插入）
  const seen = useRef<Set<string>>(new Set());

  // 跨项目切换：重置筛选与已有数据（否则残留原项目 brandId 造成假空结果）
  useEffect(() => {
    setBrandId('');
    setDimension('');
    setStatus('');
    setFrom('');
    setTo('');
    setGroups([]);
    setCursor(null);
    setTotal(0);
    seen.current = new Set();
  }, [projectId]);

  const mergeGroups = useCallback((incoming: InboxGroup[]) => {
    setGroups(prev => {
      const byDate = new Map(prev.map(g => [g.date, { date: g.date, events: [...g.events] }]));
      for (const g of incoming) {
        if (!byDate.has(g.date)) byDate.set(g.date, { date: g.date, events: [] });
        const bucket = byDate.get(g.date)!;
        for (const ev of g.events) {
          if (seen.current.has(ev.eventId)) continue;
          seen.current.add(ev.eventId);
          bucket.events.push(ev);
        }
      }
      return [...byDate.values()]
        .map(g => ({ date: g.date, events: g.events.sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0)) }))
        .filter(g => g.events.length > 0)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    });
  }, []);

  // 首屏 / 筛选变化：整体替换（筛选条件全部参与请求）
  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    let alive = true;
    const ctrl = new AbortController();
    setLoading(true);
    seen.current = new Set();
    fetchIntelInbox({
      projectId, brandId: brandId || undefined, dimension: dimension || undefined,
      verificationStatus: status || undefined, from: from || undefined, to: to || undefined,
      limit: PAGE_SIZE,
    }, ctrl.signal)
      .then(r => {
        if (!alive) return;
        setSummary(r.summary || { today: 0, verified: 0, pending: 0, brandsChanged: 0 });
        setCursor(r.nextCursor || null);
        setTotal(r.total || 0);
        setPolling(r.polling || { enabled: false, reason: '' });
        setGroups([]);
        mergeGroups(r.groups || []);
        setErr(null);
      })
      .catch(e => { if (alive && !ctrl.signal.aborted) setErr(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; ctrl.abort(); };
  }, [projectId, brandId, dimension, status, from, to, mergeGroups]);

  // 轮询：只在后端明确「存在 active 正式监控」时开启；必须保留当前全部筛选条件。
  // 已翻页（cursor 存在）时停止轮询，避免游标与内容错位。
  useEffect(() => {
    if (!projectId || !polling.enabled || cursor) return;
    const t = setInterval(() => {
      fetchIntelInbox({
        projectId, brandId: brandId || undefined, dimension: dimension || undefined,
        verificationStatus: status || undefined, from: from || undefined, to: to || undefined,
        limit: PAGE_SIZE,
      })
        .then(r => {
          setSummary(r.summary || { today: 0, verified: 0, pending: 0, brandsChanged: 0 });
          setTotal(r.total || 0);
          setPolling(r.polling || { enabled: false, reason: '' });
          // 轮询只做增量合并（eventId 去重，绝不重复插入）
          mergeGroups(r.groups || []);
        })
        .catch(() => { /* 单次轮询失败不打断页面 */ });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [projectId, polling.enabled, cursor, brandId, dimension, status, from, to, mergeGroups]);

  function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    fetchIntelInbox({
      projectId, brandId: brandId || undefined, dimension: dimension || undefined,
      verificationStatus: status || undefined, from: from || undefined, to: to || undefined,
      cursor, limit: PAGE_SIZE,
    })
      .then(r => { setCursor(r.nextCursor || null); mergeGroups(r.groups || []); })
      .catch(() => { /* 保留已有内容 */ })
      .finally(() => setLoadingMore(false));
  }

  function openEvidence(ev: InboxEvent) {
    const refs: SurfaceEvidenceRef[] = (ev.evidenceRefs || []).map(r => ({
      evidenceId: r.evidenceId || null,
      snapshotId: r.snapshotId || null,
      sourceUrl: r.sourceUrl || null,
    }));
    if (!refs.length) return;
    setDrawerRefs(refs);
  }

  const hasFilter = !!(brandId || dimension || status || from || to);
  // 品牌筛选选项 = 项目内全部品牌（不只是当前页出现过的），随项目切换重置
  const [brandOptions, setBrandOptions] = useState<[string, string][]>([]);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    fetchBrands(projectId)
      .then(r => {
        if (!alive) return;
        setBrandOptions((r.brands || []).map(b => [b.brandId, b.name] as [string, string]));
      })
      .catch(() => { /* 品牌清单失败不阻塞收件箱 */ });
    return () => { alive = false; };
  }, [projectId]);
  // 移动端：筛选器默认折叠（390 宽下不挤占首屏）
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = [brandId, dimension, status, from, to].filter(Boolean).length;

  return (
    <section className="core-inbox-page">
      <div className="core-inbox-head">
        <h3>每日变化收件箱</h3>
        <Link className="core-inbox-cov-link" href={`/brands?projectId=${encodeURIComponent(projectId)}#coverage`}>
          查看数据覆盖与采集状态 →
        </Link>
      </div>

      <div className="core-inbox-sum" data-testid="inbox-summary">
        <span className="core-sum-item">今日变化 <b>{summary.today}</b></span>
        <span className="core-sum-item core-sum-ok">已核实 <b>{summary.verified}</b></span>
        <span className="core-sum-item core-sum-warn">待核实 <b>{summary.pending}</b></span>
        <span className="core-sum-item">涉及品牌 <b>{summary.brandsChanged}</b></span>
      </div>

      <button
        type="button"
        className="core-inbox-filter-toggle"
        aria-expanded={filtersOpen}
        onClick={() => setFiltersOpen(v => !v)}
      >
        {filtersOpen ? '收起筛选' : '筛选'}{activeFilterCount ? `（${activeFilterCount}）` : ''}
      </button>

      <div className={'core-inbox-filters' + (filtersOpen ? ' is-open' : '')}>
        <select value={brandId} onChange={e => setBrandId(e.target.value)} aria-label="品牌筛选">
          <option value="">全部品牌</option>
          {brandOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={dimension} onChange={e => setDimension(e.target.value)} aria-label="变化类型筛选">
          {DIMENSIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
        <select value={status} onChange={e => setStatus(e.target.value)} aria-label="核验状态筛选">
          {STATUS_FILTERS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} aria-label="起始时间" />
        <span className="core-filter-sep">至</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} aria-label="结束时间" />
      </div>

      {err ? <p className="core-err">{err}</p> : null}

      {loading ? (
        <p className="hint">正在加载变化记录…</p>
      ) : !groups.length ? (
        hasFilter ? (
          <EmptyState title="当前筛选条件下没有变化记录" sub="放宽筛选条件，或清空筛选查看全部变化。" />
        ) : (
          <EmptyState
            title="当前没有新的已观察变化"
            sub="这里只收录已建立监控基线之后、由真实观察产生的变化。系统会继续按计划检查；想了解采集范围与来源，请看「数据覆盖与采集状态」。"
          />
        )
      ) : (
        <div className="core-inbox-groups" data-testid="inbox-groups">
          {groups.map(g => (
            <section key={g.date} className="core-inbox-day" data-date={g.date}>
              <h4 className="core-inbox-day-title">{dayLabel(g.date)} <span className="core-inbox-day-raw">{g.date}</span></h4>
              <ul className="core-inbox-list">
                {g.events.map(ev => {
                  const brandHref = ev.links.brand
                    ? `${ev.links.brand}${ev.links.brand.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(projectId)}`
                    : null;
                  const timelineHref = ev.links.timeline
                    ? `${ev.links.timeline}${ev.links.timeline.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(projectId)}`
                    : brandHref;
                  return (
                    <li key={ev.eventId} className="core-inbox-item" data-event-id={ev.eventId}>
                      <span className="core-inbox-time">{hhmm(ev.observedAt)}</span>
                      {brandHref ? (
                        <Link className="core-inbox-brand" href={brandHref}>{ev.brandName || '—'}</Link>
                      ) : <span className="core-inbox-brand">{ev.brandName || '—'}</span>}
                      <span className={`core-inbox-dim core-dim-${ev.dimension}`}>{DIMENSION_LABEL[ev.dimension] || ev.dimension}</span>
                      {timelineHref ? (
                        <Link className="core-inbox-text" href={timelineHref}>{ev.title}</Link>
                      ) : <span className="core-inbox-text">{ev.title}</span>}
                      <span
                        className={`core-inbox-verify ${ev.verificationStatus === 'verified' ? 'is-verified' : 'is-pending'}`}
                        data-verify={ev.verificationStatus}
                      >
                        {ev.verificationStatus === 'verified' ? '已核实' : '待核实'}
                      </span>
                      {ev.evidenceCount > 0 ? (
                        <button
                          type="button"
                          className="core-inbox-evidence"
                          onClick={() => openEvidence(ev)}
                          disabled={!ev.evidenceRefs.length}
                        >
                          证据{ev.evidenceCount > 1 ? `（${ev.evidenceCount}）` : ''}
                        </button>
                      ) : (
                        <span className="core-inbox-evidence-none">无证据</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {cursor ? (
            <button type="button" className="core-btn core-inbox-more" onClick={loadMore} disabled={loadingMore}>
              {loadingMore ? '加载中…' : `加载更早的变化（已显示 ${groups.reduce((n, g) => n + g.events.length, 0)} / ${total}）`}
            </button>
          ) : null}
        </div>
      )}

      {drawerRefs ? <EvidenceDrawer refs={drawerRefs} onClose={() => setDrawerRefs(null)} /> : null}
    </section>
  );
}

export default function IntelPage() {
  // 与 /brands 同一范式：URL 优先，其次当前项目状态
  const { state } = useZhibiState();
  const sp = useSearchParams();
  const projectId = String(sp.get('projectId') || (state as { projectId?: string } | null)?.projectId || '');
  if (!projectId) {
    return <EmptyState title="请先选择项目" sub="选择项目后，这里会显示已监控品牌的每日竞争变化。" />;
  }
  return (
    <Suspense fallback={<p className="hint">正在加载…</p>}>
      <IntelInboxBody projectId={projectId} />
    </Suspense>
  );
}
