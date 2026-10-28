'use client';
// 竞品监控（r4 §十一 职责收口）
// 唯一职责：监控哪些品牌、哪些信号、巡检是否完整、暂停/恢复/重新检查、当前来源异常。
// 不承担品牌长期档案与历史事件列表（那在竞品数据库的品牌时间线）；
// 不展示每日变化（那在「每日变化」页）。
// 时间纪律（r4 §四）：本页不展示 LLM 提取的模糊历史动作（如 2025-01），
// 只展示系统真实巡检与真实监控状态。
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { apiPost } from '@/lib/api';
import {
  createWatchTarget, fetchMonitoringSummary, planMonitoringReconcile,
  inspectWatchTarget, monitoringPause, monitoringResume,
  retryFirstCollection,
  type MonitoringSummary,
} from '@/lib/core-api';

const SIGNAL_ZH: Record<string, string> = { price: '价格', launch: '上新', stock: '库存', site_change: '官网内容' };

function fmtAt(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return String(iso).slice(0, 16).replace('T', ' '); }
}

type Row = {
  competitorId: string;
  name: string;
  state: 'active' | 'paused' | 'establishing' | 'source_failed' | 'none';
  signals: string[];
  signalsText: string;
  lastSuccessAt: string | null;
  watchTargetId: string | null;
  intentId: string | null;
  note: string | null;
};

function StateBadge({ r }: { r: Row }) {
  switch (r.state) {
    case 'active': return <span className="pill st researching">监控中</span>;
    case 'paused': return <span className="pill tier unknown">已暂停</span>;
    case 'establishing': return <span className="pill match">正在建立</span>;
    case 'source_failed': return <span className="pill st" style={{ color: '#B3261E' }}>来源异常</span>;
    default: return <span className="pill st">未加入</span>;
  }
}

// r4g §四：summary 的宽松本地类型（后端已组装同口径行，前端不再拼接三接口）
type InboxLike = {
  activeTargets?: number; pausedTargets?: number; signalsText?: string;
  lastWindowAt?: string | null; todayInspected?: boolean; todayWindowCount?: number;
  coverage?: CovGap | null; windowCount?: number;
  sources?: { total?: number; ok?: number; failed?: number; items?: Array<{ brandName: string; source: string; categoryText: string; actionText: string }>; notes?: Array<{ brandName: string; text: string }>; latestAt?: string | null };
};
type HealthLike = { needsHandling?: number; brands?: number; accumulating?: number; collecting?: number; limited?: number; partialSignalBrands?: number; notIntegratedDimensions?: number };
type InboxResponse = { state: InboxLike };
type BrandsHealthSummary = HealthLike;
interface CovGap {
  complete: boolean;
  expected: number;
  completed: number;
  missingBrands: string[];
  failures: Array<{ brandName: string; categoryText: string }>;
  nextRetryText: string | null;
}

export default function MonitoringPage() {
  return (
    <Suspense fallback={<p className="hint">加载竞品监控…</p>}>
      <MonitoringInner />
    </Suspense>
  );
}

function MonitoringInner() {
  const searchParams = useSearchParams();
  const projectId = searchParams.get('projectId') || '';
  const [rows, setRows] = useState<Row[] | null>(null);
  const [coverage, setCoverage] = useState<InboxLike | null>(null);
  const [health, setHealth] = useState<HealthLike | null>(null);
  const [partial, setPartial] = useState(false);
  const [totals, setTotals] = useState<MonitoringSummary['totals']>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!projectId) { setErr('请先选择项目。'); return; }
    setErr(null);
    try {
      // r4g §四：首屏只拉一个只读摘要（rows + coverage + healthCounts，~8KB）。
      // 不再串 brands(122KB) 全量档案；来源详情/历史窗口延迟到点开行时再取。
      const sum = await fetchMonitoringSummary(projectId);
      setPartial(!!sum.partial);
      setCoverage(sum.coverage as unknown as InboxLike);
      setHealth(sum.healthSummary as unknown as HealthLike);
      setRows((sum.rows || []) as Row[]);
      setTotals(sum.totals || null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : '监控状态暂时无法加载。');
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const cov: CovGap | null = (coverage as { coverage?: CovGap | null } | null)?.coverage ?? null;

  // r4g §六.1：把项目内全部竞品纳入监控计划（幂等；来源建立走后台链）
  const runPlan = async () => {
    if (planBusy) return;
    setPlanBusy(true); setMsg(null); setErr(null);
    try {
      const r = await planMonitoringReconcile(projectId);
      setMsg(r.message || '监控计划已收敛。');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '监控计划收敛未完成，请稍后再试。');
    } finally { setPlanBusy(false); }
  };

  const act = async (id: string, fn: () => Promise<unknown>, okText: string) => {
    if (busyId) return;
    setBusyId(id); setMsg(null); setErr(null);
    try {
      await fn();
      setMsg(okText);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '操作未完成，请稍后再试。');
    } finally { setBusyId(null); }
  };

  const unwatched = useMemo(() => (rows || []).filter(r => r.state === 'none'), [rows]);

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>竞品监控</h2>
          <p className="desc">
            管理正式监控：哪些品牌在监控、支持哪些信号、最近巡检是否完整。品牌档案与历史在「竞品数据库」，每日新变化在「每日变化」。
          </p>
        </div>
      </div>

      {partial ? <p className="hint" data-testid="mon-partial">监控摘要暂时只返回了部分数据（后台仍在汇总），稍后会自动补全。</p> : null}
      {totals ? (
        <div className="mon-totals" data-testid="mon-totals">
          <span>项目品牌 <b>{totals.projectBrands}</b></span>
          <span>正式监控 <b>{totals.active}</b></span>
          <span>已暂停 <b>{totals.paused}</b></span>
          <span>建立中 <b>{totals.establishing}</b></span>
          <span>来源异常 <b>{totals.sourceFailed}</b></span>
          {totals.unmonitored > 0 ? (
            <button type="button" className="btn-mini" disabled={planBusy} onClick={runPlan}>
              {planBusy ? '正在收敛监控计划…' : `把其余 ${totals.unmonitored} 个品牌纳入监控`}
            </button>
          ) : null}
        </div>
      ) : null}
      {totals && totals.signalCoverage && Object.keys(totals.signalCoverage).length ? (
        <div className="mon-totals mon-signals" data-testid="mon-signals">
          {Object.entries(totals.signalCoverage).map(([sg, n]) => (
            <span key={sg}>{SIGNAL_ZH[sg] || sg}信号 <b>{n}</b> 个品牌</span>
          ))}
        </div>
      ) : null}
      {err ? <p className="core-err">{err}</p> : null}
      {msg ? <p className="acc-msg" role="status">{msg}</p> : null}

      {coverage ? (
        <div className="core-health-strip" data-testid="mon-overview">
          <span>正式监控 <b>{coverage.activeTargets}</b></span>
          <span>已暂停 <b>{coverage.pausedTargets}</b></span>
          <span>监控信号：{coverage.signalsText || '未启用'}</span>
          <span>最近巡检：{fmtAt(coverage.lastWindowAt)}</span>
          <span className={coverage.todayInspected ? '' : 'core-sum-warn'}>
            {coverage.todayInspected ? `今日已巡检 ${coverage.todayWindowCount} 次` : '今日尚未巡检'}
          </span>
          {health ? (
            <>
              <span>需要处理 <b>{health.needsHandling ?? 0}</b></span>
              {(health.needsHandling ?? 0) > 0 ? (
                <button
                  type="button"
                  className="btn-mini"
                  disabled={busyId === '__retry__'}
                  onClick={() => act('__retry__', () => retryFirstCollection(projectId), '已重新检查失败项。')}
                >
                  重新检查失败项
                </button>
              ) : null}
            </>
          ) : null}
          <Link className="core-text-link" href={`/brands?projectId=${encodeURIComponent(projectId)}#coverage`}>查看来源明细</Link>
        </div>
      ) : null}

      {/* 巡检覆盖（最新窗口的真实状态；不完整时绝不显示「没有变化」） */}
      {cov && cov.complete === false ? (
        <div className="core-warn-box" data-testid="mon-coverage-gap">
          <b>最近一次巡检不完整（完成 {cov.completed}/{cov.expected}）</b>
          {cov.missingBrands && cov.missingBrands.length ? (
            <p>未覆盖品牌：{cov.missingBrands.join('、')}</p>
          ) : null}
          {cov.failures && cov.failures.length ? (
            <ul>
              {cov.failures.map((f, i) => (
                <li key={i}>{f.brandName}：{f.categoryText}</li>
              ))}
            </ul>
          ) : null}
          <p className="hint">{cov.nextRetryText || '缺失项将自动重试。'} 在覆盖补齐前，不生成「没有变化」的结论。</p>
          <button
            type="button"
            className="btn-mini"
            disabled={!!busyId}
            onClick={() => {
              const t = (rows || []).find(r => r.watchTargetId);
              if (t && t.watchTargetId) act(t.watchTargetId, () => inspectWatchTarget(t.watchTargetId as string), '已发起立即巡检。');
            }}
          >
            立即重试
          </button>
        </div>
      ) : null}

      {/* 监控品牌列表 */}
      <div style={{ marginTop: 8 }}>
        {rows === null ? (
          <p className="hint">正在加载监控状态…</p>
        ) : rows.length === 0 ? (
          <div className="empty">
            <div className="big">还没有监控中的品牌</div>
            <div className="sub">在下方品牌列表点击「加入监控」，建立两次观察基线后开始正式监控。</div>
          </div>
        ) : (
          <div className="mon-list" data-testid="mon-list">
            {rows.map((r) => (
              <div className="mon-row" key={r.competitorId} data-state={r.state}>
                <div className="mon-main">
                  <div className="mon-name">
                    {r.name} <StateBadge r={r} />
                  </div>
                  <div className="mon-sub">
                    {r.state === 'active' ? (
                      <>信号：{r.signalsText} · 最近成功检查：{fmtAt(r.lastSuccessAt)}</>
                    ) : r.state === 'establishing' ? (
                      <>正在建立公开来源基线（两次观察后自动转为正式监控）</>
                    ) : r.state === 'source_failed' ? (
                      <>{r.note || '来源暂时不可访问，系统会自动重试'}</>
                    ) : r.state === 'paused' ? (
                      <>已暂停监控，可随时恢复</>
                    ) : (
                      <>未加入正式监控</>
                    )}
                  </div>
                </div>
                <div className="mon-acts">
                  {r.state === 'active' && r.watchTargetId ? (
                    <>
                      <button type="button" className="btn-mini" disabled={busyId === r.competitorId}
                        onClick={() => act(r.competitorId, () => inspectWatchTarget(r.watchTargetId as string), `已对「${r.name}」发起立即巡检。`)}>
                        立即巡检
                      </button>
                      <button type="button" className="btn-mini" disabled={busyId === r.competitorId}
                        onClick={() => act(r.competitorId, () => monitoringPause(r.watchTargetId as string), `已暂停「${r.name}」的监控。`)}>
                        暂停
                      </button>
                    </>
                  ) : null}
                  {r.state === 'paused' && r.watchTargetId ? (
                    <button type="button" className="btn-mini" disabled={busyId === r.competitorId}
                      onClick={() => act(r.competitorId, () => monitoringResume(r.watchTargetId as string), `已恢复「${r.name}」的监控。`)}>
                      恢复
                    </button>
                  ) : null}
                  {r.state === 'source_failed' ? (
                    <button type="button" className="btn-mini" disabled={busyId === r.competitorId}
                      onClick={() => act(r.competitorId, () => apiPost('/api/data-surface/reconcile', { projectId }), `已对「${r.name}」发起重新检查。`)}>
                      重新检查
                    </button>
                  ) : null}
                  {r.state === 'none' ? (
                    <button type="button" className="btn-mini" disabled={busyId === r.competitorId}
                      onClick={() => act(r.competitorId, () => createWatchTarget({ projectId, competitorId: r.competitorId }), `已为「${r.name}」发起监控建立。`)}>
                      加入监控
                    </button>
                  ) : null}
                  <Link className="core-text-link" href={`/brands?projectId=${encodeURIComponent(projectId)}&competitor=${encodeURIComponent(r.competitorId)}`}>品牌档案</Link>
                </div>
              </div>
            ))}
          </div>
        )}

        {unwatched.length > 0 ? (
          <p className="hint" style={{ marginTop: 8 }}>
            有 {unwatched.length} 个品牌尚未加入正式监控，加入后才会产生每日变化。
          </p>
        ) : null}

        {/* 当前来源异常（真实失败；limited/not_configured 不列失败） */}
        {coverage && coverage.sources && ((coverage.sources.items || []).length || (coverage.sources.notes || []).length) ? (
          <div className="core-warn-box" data-testid="mon-source-issues" style={{ marginTop: 12 }}>
            <b>当前来源状态</b>
            {(coverage.sources.items || []).length ? (
              <ul>
                {(coverage.sources.items || []).map((it, i) => (
                  <li key={i}>{it.brandName} · {it.source}：{it.categoryText}（{it.actionText}）</li>
                ))}
              </ul>
            ) : null}
            {(coverage.sources.notes || []).map((n, i) => (
              <p className="hint" key={i}>{n.brandName}：{n.text}</p>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
