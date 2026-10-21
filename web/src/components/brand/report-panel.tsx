'use client';
// 调研报告：列表 + 显式触发生成（可选品牌/时间范围/章节）+ 状态轮询 + 详情与下载（SC-04 UI 框架轮）。
// 纪律：生成只由用户点击触发（页面加载绝不调用生成接口）；
// 报告使用生成时刻冻结的事实包；LLM 不可用的结构化回退必须如实标记，不伪装成完整 AI 分析。
// r2 修复：重新生成 = 创建新报告后立即跳转新任务页（不再重读旧失败报告停留原页）；
// 提交期间按钮禁用，防连续点击重复创建。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { renderMarkdown } from '@/lib/md';
import {
  createReport, fetchBrands, fetchReport, fetchReports,
  type ReportDetail, type ReportListItem,
} from '@/lib/core-api';
import {
  REPORT_DEFAULT_SECTIONS, REPORT_SECTIONS, REPORT_STATUS_TEXT, reportUiStatus,
} from '@/lib/core-logic';

// 重生成提交后跳转新报告任务页；保留当前 URL 全部非项目参数，仅同步 projectId
function useRegenerateNav() {
  const router = useRouter();
  const searchParams = useSearchParams();
  return useCallback((newReportId: string, projectId: string) => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set('projectId', projectId);
    router.push(`/report/${encodeURIComponent(newReportId)}?${sp.toString()}`);
  }, [router, searchParams]);
}

function formSectionsLabel(codes?: string[] | null): string {
  if (!codes || !codes.length) return REPORT_DEFAULT_SECTIONS.map(c => REPORT_SECTIONS.find(s => s.code === c)?.label || c).join('、');
  return codes.map(c => REPORT_SECTIONS.find(s => s.code === c)?.label || c).join('、');
}

// ---------- 列表 + 新建 ----------
export function ReportPanel({ projectId, brandIds, onOpen }: {
  projectId: string;
  brandIds?: string[];
  onOpen?: (id: string) => void;
}) {
  const navigateToNew = useRegenerateNav();
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [brandOpts, setBrandOpts] = useState<{ brandId: string; name: string }[]>([]);
  const [selBrands, setSelBrands] = useState<Set<string>>(new Set(brandIds || []));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sections, setSections] = useState<Set<string>>(new Set(REPORT_DEFAULT_SECTIONS));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchReports(projectId);
      setReports(r.reports || []);
      return (r.reports || []);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return []; }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // 仅当存在排队/生成中时轮询；绝不自动触发生成
  useEffect(() => {
    const pending = reports.some(r => r.status === 'queued' || r.status === 'running');
    if (!pending) return;
    timer.current = setTimeout(async () => { await load(); }, 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [reports, load]);

  function openForm() {
    setFormOpen(v => !v);
    if (!brandIds) {
      fetchBrands(projectId)
        .then(r => setBrandOpts((r.brands || []).map(b => ({ brandId: b.brandId, name: b.name }))))
        .catch(() => setBrandOpts([]));
    }
  }

  function toggle(set: Set<string>, v: string, apply: (s: Set<string>) => void) {
    const n = new Set(set);
    if (n.has(v)) n.delete(v); else n.add(v);
    apply(n);
  }

  async function generate() {
    setBusy(true); setErr(null);
    try {
      await createReport({
        projectId,
        brandIds: brandIds || [...selBrands],
        from: from || null,
        to: to || null,
        sections: [...sections],
      });
      setFormOpen(false);
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  async function regenerate(r: ReportListItem) {
    setBusy(true); setErr(null);
    try {
      const res = await createReport({
        projectId,
        brandIds: brandIds || r.scope.brandIds || [],
        from: r.scope.from || null,
        to: r.scope.to || null,
        sections: r.scope.sections && r.scope.sections.length ? r.scope.sections : undefined,
      });
      // r2：立即跳转新报告任务页，让用户看到新任务的状态与轮询（不停留旧列表）
      navigateToNew(res.reportId, projectId);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="core-report">
      <div className="core-report-acts">
        <button type="button" className="btn-primary" disabled={busy} onClick={openForm}>
          {formOpen ? '收起生成选项' : '生成新报告'}
        </button>
        <span className="hint">报告使用生成时刻冻结的事实范围；实时数据变化不会改写已生成报告。</span>
      </div>

      {formOpen && (
        <div className="core-report-form">
          {!brandIds && (
            <div className="core-form-row">
              <span className="core-form-k">品牌范围</span>
              <div className="core-form-v">
                {brandOpts.length ? (
                  <ul className="core-check-list">
                    {brandOpts.map(b => (
                      <li key={b.brandId}>
                        <label>
                          <input type="checkbox" checked={selBrands.has(b.brandId)}
                            onChange={() => toggle(selBrands, b.brandId, setSelBrands)} />
                          {b.name}
                        </label>
                      </li>
                    ))}
                  </ul>
                ) : <span className="hint">品牌清单加载中…</span>}
                <span className="hint">不勾选 = 使用项目内全部品牌。</span>
              </div>
            </div>
          )}
          <div className="core-form-row">
            <span className="core-form-k">时间范围</span>
            <div className="core-form-v core-form-inline">
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} /> 至
              <input type="date" value={to} onChange={e => setTo(e.target.value)} />
              <span className="hint">留空 = 不限时间。无法判定时间的数据不会强行计入所选范围。</span>
            </div>
          </div>
          <div className="core-form-row">
            <span className="core-form-k">报告章节</span>
            <div className="core-form-v">
              <ul className="core-check-list core-check-inline">
                {REPORT_SECTIONS.map(s => (
                  <li key={s.code}>
                    <label title={s.desc}>
                      <input type="checkbox" checked={sections.has(s.code)}
                        onChange={() => toggle(sections, s.code, setSections)} />
                      {s.label}
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="hint">⚠ 生成后本次事实范围即被冻结：报告内容只反映生成时刻已采集的数据，之后的新数据不会自动进入本报告。</p>
          <button type="button" className="btn-primary" disabled={busy || !sections.size} onClick={generate}>
            {busy ? '提交中…' : '确认生成（冻结当前事实）'}
          </button>
        </div>
      )}

      {err ? <p className="core-err">{err}</p> : null}
      {!reports.length ? (
        <p className="hint">暂无报告。点击「生成新报告」创建（仅在你点击时生成，页面不会自动消耗生成额度）。</p>
      ) : (
        <ul className="core-report-list">
          {reports.map(r => {
            const st = reportUiStatus(r);
            return (
              <li key={r.reportId}>
                <span>v{r.version}</span>
                <span className={`core-report-status core-report-${st}`}>{REPORT_STATUS_TEXT[st]}</span>
                <span>生成时间 {new Date(r.createdAt).toLocaleString()}</span>
                <span>事实 {r.factCount} 条 / 缺口 {r.gapCount} 项</span>
                {st === 'retrying' && r.errorText ? <span className="core-report-retry">{r.errorText}</span> : null}
                {onOpen ? <button type="button" className="btn-mini" onClick={() => onOpen(r.reportId)}>查看</button> : null}
                {r.status === 'failed' ? (
                  <button type="button" className="btn-mini" disabled={busy} onClick={() => regenerate(r)}>重新生成</button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------- 详情 ----------
export function ReportDetailView({ reportId }: { reportId: string }) {
  const [d, setD] = useState<ReportDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [brandNames, setBrandNames] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const navigateToNew = useRegenerateNav();

  const load = useCallback(async (signal?: AbortSignal) => {
    try { const r = await fetchReport(reportId, signal); setD(r); setErr(null); }
    catch (e) { if (!signal?.aborted) setErr(e instanceof Error ? e.message : String(e)); }
  }, [reportId]);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // 轮询仅在任务未达终态时继续（成功/失败停止；queued/running/retrying 均持续刷新）
  useEffect(() => {
    if (!d) return;
    if (d.status === 'success' || d.status === 'failed') return;
    const t = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(t);
  }, [d, load]);

  // 品牌名解析（scope 展示用；失败不阻塞详情）
  const pid = d?.projectId || '';
  useEffect(() => {
    if (!pid) return;
    let alive = true;
    fetchBrands(pid)
      .then(r => {
        if (!alive) return;
        const m: Record<string, string> = {};
        for (const b of (r.brands || [])) m[b.brandId] = b.name;
        setBrandNames(m);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [pid]);

  if (err) return <p className="core-err">{err}</p>;
  if (!d) return <p className="hint">加载报告…</p>;

  const structured = d.generatedBy === 'structured-fallback';
  const scope = d.scope || {};
  const brandScope = scope.brandIds && scope.brandIds.length
    ? scope.brandIds.map(id => brandNames[id] || `品牌 ${id.slice(0, 8)}…`).join('、')
    : '项目内全部品牌';

  function download() {
    const blob = new Blob([d?.markdown || ''], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vantage-report-v${d?.version || 1}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function regenerate() {
    if (!d || busy) return;
    setBusy(true); setErr(null);
    try {
      const res = await createReport({
        projectId: d.projectId,
        brandIds: scope.brandIds || [],
        from: scope.from || null,
        to: scope.to || null,
        sections: scope.sections && scope.sections.length ? scope.sections : undefined,
      });
      // r2：不再重读旧报告停留原页——立即跳转新报告任务页（URL 同步 projectId、保留其它参数）
      navigateToNew(res.reportId, d.projectId);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="core-report-detail">
      <div className="core-report-meta">
        <span>版本 v{d.version}</span>
        <span className={`core-report-status core-report-${d.status}`}>{REPORT_STATUS_TEXT[reportUiStatus(d)]}</span>
        <span>生成时间 {new Date(d.createdAt).toLocaleString()}</span>
        {d.finishedAt ? <span>完成 {new Date(d.finishedAt).toLocaleString()}</span> : null}
        {d.markdown ? <button type="button" className="btn-mini" onClick={download}>下载 Markdown</button> : null}
      </div>
      <div className="core-report-scope">
        <span>品牌范围：{brandScope}</span>
        <span>时间范围：{scope.from || scope.to ? `${scope.from || '不限'} 至 ${scope.to || '不限'}` : '不限'}</span>
        <span>章节：{formSectionsLabel(scope.sections)}</span>
      </div>
      {structured ? (
        <p className="core-report-structured">结构化事实版本：本次生成时 AI 叙述不可用，以下为按章节整理的事实与缺口清单（非完整 AI 分析报告），可重新生成。</p>
      ) : null}
      {d.status === 'failed' ? (
        <p className="core-err">
          {d.errorText || '生成失败。'}
          <button type="button" className="btn-mini" disabled={busy} onClick={regenerate}>{busy ? '提交中…' : '重新生成'}</button>
        </p>
      ) : null}
      {d.status === 'queued' || d.status === 'running' ? (
        <p className="hint">生成中…（任务已持久化，服务重启后可恢复或明确失败；不会重复消耗额度）</p>
      ) : null}
      {d.markdown ? <article className="core-report-md core-report-md-render">{renderMarkdown(d.markdown)}</article> : null}

      {/* SC-05：冻结的时序基线——存档时间 / 观察时间 / 实际发生时间分开说明，不混为一谈 */}
      {d.factPack && d.factPack.memoryBasis ? (
        <p className="hint core-report-memory">
          时序事实基线：已冻结 {d.factPack.memoryBasis.factCount || 0} 条时序事实
          （范围 {d.factPack.memoryBasis.from || '不限'} ~ {d.factPack.memoryBasis.to || '生成时'}）；
          每条都带事实 ID、版本 ID 与证据引用。存档观察的时间取存档快照时间，实时观察只记录 Vantage 的观察时间。
        </p>
      ) : null}

      <h4>事实引用</h4>
      {!d.citations.length ? <p className="hint">暂无引用。</p> : (
        <ul className="core-report-cit">
          {d.citations.slice(0, 100).map(c => (
            <li key={c.citationId}>
              <span>{c.label || c.factId || '事实'}</span>
              {c.evidenceIds.length ? <span>证据 {c.evidenceIds.length} 条</span> : null}
              {c.snapshotIds.length ? <span>快照 {c.snapshotIds.length} 个</span> : null}
              {c.sourceUrl ? <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="core-cite-link">来源 ↗</a> : null}
            </li>
          ))}
        </ul>
      )}

      <h4>数据覆盖与资料缺口</h4>
      {!(d.gaps || []).length ? <p className="hint">无缺口记录。</p> : (
        <ul className="core-report-gaps">
          {(d.gaps || []).slice(0, 50).map((g, i) => (
            <li key={i}><span>{g.displayName || g.dimension}</span><span>{g.text}</span></li>
          ))}
        </ul>
      )}
    </div>
  );
}
