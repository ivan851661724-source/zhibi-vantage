'use client';
// ============================================================
// 情报库 = 每日变化收件箱（核心产品体验收敛 r1 重做）
// 只回答一个问题：今天/最近一段时间，系统新发现了哪些竞争变化？
//
// 本轮三处结构性修复（对应任务书 §三）：
//   ① 空收件箱必须区分三种完全不同的处境，并给出**真实可执行**的下一步：
//      - 尚未建立正式监控      → 「加入监控」
//      - 已监控但还没跑过巡检  → 「立即巡检」（真实触发一次监控窗口）
//      - 已巡检且没有发现变化  → 告知最近巡检时间与监控信号范围
//   ② 变化类型筛选覆盖七个真实维度（价格/商品/库存/官网/评论/社媒/广告），
//      不再只给「价格 + 官网内容」两项造成「其他维度没有变化」的错觉。
//   ③ 每条事件可「反馈有误」——不改写已记录事实，只登记复核（忠实助理红线）。
//
// 明确删除：品牌静态档案卡 / 采集任务统计 / 覆盖面板 / 资料缺口列表 /
//   独立「时序变化」区块 / 首次基线观察 / 报告生成记录 / 回补历史 / 失败维度卡。
// ============================================================
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { EvidenceDrawer } from '@/components/data-surface/evidence-drawer';
import type { SurfaceEvidenceRef } from '@/components/data-surface/types';
import { EmptyState } from '@/components/core-ui';
import {
  fetchBrands, fetchIntelInbox, fetchWatchTargets, inspectWatchTarget,
  reportIntelEvent, type InboxEvent, type InboxGroup, type InboxState, type InboxSummary,
  type WatchTargetInfo,
} from '@/lib/core-api';

// 变化类型——七个真实维度（后端 intel_events.dimension 词表）
const DIMENSIONS: { value: string; label: string }[] = [
  { value: '', label: '全部变化类型' },
  { value: 'price', label: '价格' },
  { value: 'product', label: '商品' },
  { value: 'stock', label: '库存' },
  { value: 'website', label: '官网内容' },
  { value: 'review', label: '评论' },
  { value: 'social', label: '社媒' },
  { value: 'ads', label: '广告' },
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
const CORRECTION_REASONS: { value: string; label: string }[] = [
  { value: 'wrong_value', label: '变化前后值不对' },
  { value: 'wrong_evidence', label: '证据不匹配这条变化' },
  { value: 'not_a_change', label: '这其实不是一次变化' },
  { value: 'wrong_brand', label: '品牌对应错了' },
  { value: 'other', label: '其他问题' },
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
function fmtAt(iso: string | null): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch (e) { return '—'; }
}
// 变化前后值（真实类型：区间保留结构，不退化为标量）
function changeText(ev: InboxEvent): string | null {
  const c = ev.change as { oldValue?: unknown; newValue?: unknown; old?: unknown; new?: unknown } | null;
  if (!c) return null;
  const fmt = (v: unknown): string => {
    if (v == null) return '—';
    if (typeof v === 'object' && v !== null && ('min' in (v as object) || 'max' in (v as object))) {
      const r = v as { min?: number; max?: number };
      const lo = r.min == null ? '—' : r.min;
      const hi = r.max == null ? '—' : r.max;
      return lo === hi ? String(lo) : `${lo}–${hi}`;
    }
    return String(v);
  };
  const oldV = c.oldValue !== undefined ? c.oldValue : c.old;
  const newV = c.newValue !== undefined ? c.newValue : c.new;
  if (oldV === undefined && newV === undefined) return null;
  return `${fmt(oldV)} → ${fmt(newV)}`;
}

// ---------- 空态：三种处境 + 真实动作 ----------
function InboxEmpty({ st, targets, busyId, onInspect, onJumpJoin, lastMsg }: {
  st: InboxState;
  targets: WatchTargetInfo[];
  busyId: string | null;
  onInspect: (t: WatchTargetInfo) => void;
  onJumpJoin: () => void;
  lastMsg: string | null;
}) {
  const active = targets.filter(t => t.monitoringStatus === 'active' || t.monitoringStatus === 'degraded');
  const common = (
    <div className="core-empty-actions">
      {active.length ? (
        active.map(t => (
          <button
            key={t.watchTargetId}
            type="button"
            className="btn-mini"
            disabled={busyId === t.watchTargetId}
            onClick={() => onInspect(t)}
          >
            {busyId === t.watchTargetId ? '正在巡检…' : '立即巡检'}
          </button>
        ))
      ) : (
        <button type="button" className="btn-mini" onClick={onJumpJoin}>加入监控</button>
      )}
      {lastMsg ? <span className="core-brand-muted core-brand-mini">{lastMsg}</span> : null}
    </div>
  );

  if (st.state === 'no_monitoring' || st.state === 'unknown') {
    return (
      <div className="core-inbox-empty" data-testid="inbox-empty-no-monitoring" data-empty-state={st.state}>
        <h4>还没有建立正式监控</h4>
        <p>收件箱只收录正式监控产生的变化。把需要跟进的品牌加入监控后，系统会按计划检查并在发现变化时记录在这里。</p>
        <div className="core-empty-actions">
          <button type="button" className="btn-mini" onClick={onJumpJoin}>加入监控</button>
        </div>
      </div>
    );
  }
  // 非 Shopify 品牌：已提交加入监控，但来源仍在建立 —— 必须说清楚「已经在处理」，
  // 否则用户会以为按钮没生效并重复提交。
  if (st.state === 'establishing') {
    return (
      <div className="core-inbox-empty" data-testid="inbox-empty-establishing" data-empty-state="establishing">
        <h4>正在建立监控来源</h4>
        <p>
          已收到 {st.pendingIntents || 1} 个品牌的加入监控请求。该品牌没有可直接巡检的商品接口，
          系统正在建立可核验的公开商品来源；完成后会自动转为正式监控并按计划巡检。
        </p>
        <p className="core-brand-muted core-brand-mini">{st.intentNote || '建立期间不会产生变化记录，这是正常的。'}</p>
      </div>
    );
  }
  if (st.state === 'source_failed') {
    return (
      <div className="core-inbox-empty" data-testid="inbox-empty-source-failed" data-empty-state="source_failed">
        <h4>监控来源建立失败</h4>
        <p>{st.intentNote || '该品牌暂时没有可核验的公开商品来源，因此还没有进入正式监控。'}</p>
        <p className="core-brand-muted core-brand-mini">这不代表品牌没有商品；可在「竞品数据库」重新加入监控，系统会再试一次。</p>
      </div>
    );
  }
  if (st.state === 'paused') {
    return (
      <div className="core-inbox-empty" data-testid="inbox-empty-paused" data-empty-state="paused">
        <h4>正式监控已暂停</h4>
        <p>{st.pausedTargets} 个品牌的监控处于暂停状态，暂停期间不会产生新的变化记录。恢复后系统会继续按计划巡检。</p>
        <div className="core-empty-actions">
          <button type="button" className="btn-mini" onClick={onJumpJoin}>管理监控</button>
        </div>
      </div>
    );
  }
  if (st.state === 'awaiting_comparison') {
    return (
      <div className="core-inbox-empty" data-testid="inbox-empty-awaiting" data-empty-state="awaiting_comparison">
        <h4>已加入监控，还没有完成第一次巡检</h4>
        <p>
          已有 {st.activeTargets} 个品牌处于正式监控中，但尚未完成一次可比较的巡检观察。
          变化必须由两次真实观察对比得出，所以在此之前不会有变化记录。
        </p>
        {common}
      </div>
    );
  }
  // r2：项目级来源结果——「部分失败」不得被「今日巡检已完成」掩盖；
  // 「全部失败」不得显示成功态。列表由后端聚合（品牌/来源/类别/动作），前端只渲染。
  if (st.state === 'inspected_partial' || st.state === 'inspection_failed') {
    const allBad = st.state === 'inspection_failed';
    const items = (st.sources && st.sources.items) || [];
    return (
      <div
        className="core-inbox-empty"
        data-testid={'inbox-empty-' + (allBad ? 'inspection-failed' : 'inspected-partial')}
        data-empty-state={st.state}
      >
        <h4>{allBad ? '本次巡检没有成功' : '巡检已完成，但部分来源未成功'}</h4>
        <p>
          {allBad
            ? '所有监控来源本次都未能成功采集，因此没有新的可核验变化。'
            : '已完成的来源按计划记录了观察；以下来源本次未成功，它们的变化可能没有被记录。'}
          {st.historicalNote ? ' ' + st.historicalNote + '。' : ''}
        </p>
        <ul className="core-inbox-sources">
          {items.map((it, i) => (
            <li key={i}>
              <span className="core-inbox-src-brand">{it.brandName}</span>
              <span className="core-inbox-src-source">{it.source}</span>
              <span className="core-inbox-src-cat">{it.categoryText}</span>
              <button type="button" className="core-text-btn" onClick={onJumpJoin}>{it.actionText}</button>
            </li>
          ))}
        </ul>
        {common}
      </div>
    );
  }
  // inspected：已完成巡检但没发现变化 —— 区分「今天已巡」与「今天还没巡」
  return (
    <div className="core-inbox-empty" data-testid="inbox-empty-inspected" data-empty-state="inspected">
      <h4>{st.todayInspected ? '今日巡检已完成，没有发现重要变化' : '今天还没有巡检'}</h4>
      <p>
        {st.todayInspected
          ? `今日已完成 ${st.todayWindowCount} 次巡检；最近一次巡检 ${fmtAt(st.lastWindowAt)}。`
          : `最近一次巡检 ${fmtAt(st.lastWindowAt)}，今日尚未巡检。`}
        {' '}监控信号：{st.signalsText || '未启用'}。
        {st.signalsText && st.signalsText !== '价格'
          ? '系统只在上述信号上判断变化，未监控的信号不会被记录。'
          : '系统目前只在已启用的信号上判断变化；其他信号接入后会在此说明。'}
      </p>
      {common}
    </div>
  );
}

function IntelInboxBody({ projectId }: { projectId: string }) {
  const sp = useSearchParams();
  const [brandId, setBrandId] = useState(sp.get('brandId') || '');
  const [dimension, setDimension] = useState(sp.get('dimension') || '');
  const [status, setStatus] = useState(sp.get('verificationStatus') || '');
  const [from, setFrom] = useState(sp.get('from') || '');
  const [to, setTo] = useState(sp.get('to') || '');

  const [summary, setSummary] = useState<InboxSummary>({ today: 0, verified: 0, pending: 0, brandsChanged: 0 });
  const [st, setSt] = useState<InboxState | null>(null);
  const [groups, setGroups] = useState<InboxGroup[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [polling, setPolling] = useState<{ enabled: boolean; reason: string }>({ enabled: false, reason: '' });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [drawerRefs, setDrawerRefs] = useState<SurfaceEvidenceRef[] | null>(null);
  const [targets, setTargets] = useState<WatchTargetInfo[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  // 事件纠错：哪条事件在填反馈、提交了什么
  const [corrFor, setCorrFor] = useState<string | null>(null);
  const [corrReason, setCorrReason] = useState('wrong_value');
  const [corrNote, setCorrNote] = useState('');
  const [corrBusy, setCorrBusy] = useState(false);
  const [corrDone, setCorrDone] = useState<Record<string, string>>({});
  const seen = useRef<Set<string>>(new Set());

  // 跨项目切换：重置筛选与已有数据（否则残留原项目 brandId 造成假空结果）
  useEffect(() => {
    setBrandId(''); setDimension(''); setStatus(''); setFrom(''); setTo('');
    setGroups([]); setCursor(null); setTotal(0); setSt(null); setTargets([]); setActionMsg(null);
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

  const load = useCallback((signal?: AbortSignal) => {
    return fetchIntelInbox({
      projectId, brandId: brandId || undefined, dimension: dimension || undefined,
      verificationStatus: status || undefined, from: from || undefined, to: to || undefined,
      limit: PAGE_SIZE,
    }, signal);
  }, [projectId, brandId, dimension, status, from, to]);

  useEffect(() => {
    if (!projectId) { setLoading(false); return; }
    let alive = true;
    const ctrl = new AbortController();
    setLoading(true);
    seen.current = new Set();
    load(ctrl.signal)
      .then(r => {
        if (!alive) return;
        setSummary(r.summary || { today: 0, verified: 0, pending: 0, brandsChanged: 0 });
        setSt(r.state || null);
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
  }, [projectId, load, mergeGroups]);

  // 监控目标（空态里的「立即巡检」需要真实 targetId）
  const reloadTargets = useCallback(() => {
    if (!projectId) return;
    fetchWatchTargets(projectId)
      .then(r => setTargets(r.targets || []))
      .catch(() => { /* 目标清单失败不阻塞收件箱主体 */ });
  }, [projectId]);
  useEffect(() => { reloadTargets(); }, [reloadTargets]);

  // 轮询：只在存在 active 正式监控时开启；保留全部筛选；已翻页时停（避免游标错位）
  useEffect(() => {
    if (!projectId || !polling.enabled || cursor) return;
    const t = setInterval(() => {
      load()
        .then(r => {
          setSummary(r.summary || { today: 0, verified: 0, pending: 0, brandsChanged: 0 });
          setSt(r.state || null);
          setTotal(r.total || 0);
          setPolling(r.polling || { enabled: false, reason: '' });
          mergeGroups(r.groups || []);
        })
        .catch(() => { /* 单次轮询失败不打断页面 */ });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [projectId, polling.enabled, cursor, load, mergeGroups]);

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

  // 立即巡检：真实触发一次监控窗口（后端 202 + 后台执行），完成后重载
  async function doInspect(t: WatchTargetInfo) {
    if (busyId) return;
    setBusyId(t.watchTargetId);
    setActionMsg(null);
    try {
      await inspectWatchTarget(t.watchTargetId);
      setActionMsg('已开始巡检，完成后这里会自动更新。');
      // 后台执行通常 5–20s：轮询几次收件箱与目标状态
      for (let i = 0; i < 12; i++) {
        await new Promise(res => setTimeout(res, 4000));
        try {
          const r = await load();
          setSummary(r.summary || { today: 0, verified: 0, pending: 0, brandsChanged: 0 });
          setSt(r.state || null);
          setTotal(r.total || 0);
          mergeGroups(r.groups || []);
        } catch (e) { /* 单次失败继续等 */ }
      }
      setActionMsg('巡检已完成；如发现可核验变化会显示在下方。');
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      reloadTargets();
    }
  }

  // 事件纠错：只登记复核，不改写事实
  async function submitCorrection(ev: InboxEvent) {
    if (corrBusy) return;
    setCorrBusy(true);
    try {
      const r = await reportIntelEvent({ projectId, eventId: ev.eventId, reason: corrReason, note: corrNote });
      setCorrDone(prev => ({ ...prev, [ev.eventId]: r.message || '已收到反馈，我们会复核这条记录。' }));
      setCorrFor(null);
      setCorrNote('');
    } catch (e) {
      setCorrDone(prev => ({ ...prev, [ev.eventId]: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCorrBusy(false);
    }
  }

  const hasFilter = !!(brandId || dimension || status || from || to);
  const [brandOptions, setBrandOptions] = useState<[string, string][]>([]);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    fetchBrands(projectId)
      .then(r => { if (alive) setBrandOptions((r.brands || []).map(b => [b.brandId, b.name] as [string, string])); })
      .catch(() => { /* 品牌清单失败不阻塞收件箱 */ });
    return () => { alive = false; };
  }, [projectId]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = [brandId, dimension, status, from, to].filter(Boolean).length;
  const joinHref = useMemo(
    () => `/brands?projectId=${encodeURIComponent(projectId)}`,
    [projectId],
  );
  const targetName = useMemo(() => {
    const m = new Map<string, string>();
    for (const b of brandOptions) m.set(b[0], b[1]);
    return m;
  }, [brandOptions]);

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

      {st && st.activeTargets ? (
        <p className="core-inbox-scope" data-testid="inbox-scope">
          正式监控 {st.activeTargets} 个品牌 · 监控信号：{st.signalsText || '未启用'}
          {st.todayInspected ? ` · 今日已巡检 ${st.todayWindowCount} 次（最近 ${fmtAt(st.lastWindowAt)}）` : ' · 今日尚未巡检'}
        </p>
      ) : null}

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
        ) : st ? (
          <InboxEmpty
            st={st} targets={targets} busyId={busyId}
            onInspect={doInspect}
            onJumpJoin={() => { window.location.href = joinHref; }}
            lastMsg={actionMsg}
          />
        ) : (
          <EmptyState title="正在读取监控状态…" sub="稍后会自动更新。" />
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
                  const diff = changeText(ev);
                  return (
                    <li key={ev.eventId} className="core-inbox-item" data-event-id={ev.eventId}>
                      <span className="core-inbox-time">{hhmm(ev.observedAt)}</span>
                      {brandHref ? (
                        <Link className="core-inbox-brand" href={brandHref}>{ev.brandName || targetName.get(ev.brandId || '') || '—'}</Link>
                      ) : <span className="core-inbox-brand">{ev.brandName || '—'}</span>}
                      <span className={`core-inbox-dim core-dim-${ev.dimension}`}>{DIMENSION_LABEL[ev.dimension] || '变化'}</span>
                      {timelineHref ? (
                        <Link className="core-inbox-text" href={timelineHref}>{ev.title}</Link>
                      ) : <span className="core-inbox-text">{ev.title}</span>}
                      {diff ? <span className="core-inbox-diff" data-testid="inbox-diff">{diff}</span> : null}
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
                      {corrDone[ev.eventId] ? (
                        <span className="core-inbox-corr-done">{corrDone[ev.eventId]}</span>
                      ) : (
                        <button
                          type="button"
                          className="core-inbox-corr"
                          onClick={() => { setCorrFor(corrFor === ev.eventId ? null : ev.eventId); setCorrReason('wrong_value'); setCorrNote(''); }}
                        >
                          反馈有误
                        </button>
                      )}
                      {corrFor === ev.eventId ? (
                        <div className="core-inbox-corr-form" data-testid="inbox-corr-form">
                          <select value={corrReason} onChange={e => setCorrReason(e.target.value)} aria-label="问题类型">
                            {CORRECTION_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                          </select>
                          <input
                            type="text" value={corrNote} maxLength={500}
                            placeholder="补充说明（可选）" aria-label="补充说明"
                            onChange={e => setCorrNote(e.target.value)}
                          />
                          <button type="button" className="btn-mini" disabled={corrBusy} onClick={() => submitCorrection(ev)}>
                            {corrBusy ? '提交中…' : '提交反馈'}
                          </button>
                        </div>
                      ) : null}
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
