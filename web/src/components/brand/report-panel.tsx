'use client';
// 调研报告：列表 + 显式触发生成 + 状态轮询 + 详情与 Markdown 下载（SC-04）
// 纪律：生成只由用户点击触发；页面加载不消耗模型额度；实时数据变化不改写已生成报告。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createReport, fetchReport, fetchReports, type ReportDetail, type ReportListItem } from '@/lib/core-api';

const STATUS_TEXT: Record<string, string> = {
  queued: '排队中', running: '生成中', success: '已完成', failed: '生成失败',
};

export function ReportPanel({ projectId, brandIds, onOpen }: { projectId: string; brandIds?: string[]; onOpen?: (id: string) => void }) {
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetchReports(projectId);
      setReports(r.reports || []);
      return (r.reports || []);
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); return []; }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // 仅当存在 queued/running 时轮询（任务状态可见，不做页面加载即触发生成）
  useEffect(() => {
    const pending = reports.some(r => r.status === 'queued' || r.status === 'running');
    if (!pending) return;
    timer.current = setTimeout(async () => { await load(); }, 3000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [reports, load]);

  async function generate() {
    setBusy(true); setErr(null);
    try {
      await createReport({ projectId, brandIds: brandIds || [] });
      await load();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div className="core-report">
      <div className="core-report-acts">
        <button type="button" className="btn-primary" disabled={busy} onClick={generate}>
          {busy ? '提交中…' : '生成调研报告'}
        </button>
        <span className="hint">报告使用生成时刻冻结的事实包；实时数据变化不会改写已生成报告。</span>
      </div>
      {err ? <p className="core-err">{err}</p> : null}
      {!reports.length ? <p className="hint">暂无报告。点击「生成调研报告」创建（仅在你点击时生成）。</p> : (
        <ul className="core-report-list">
          {reports.map(r => (
            <li key={r.reportId}>
              <span>v{r.version}</span>
              <span className={`core-report-status core-report-${r.status}`}>{STATUS_TEXT[r.status] || r.status}</span>
              <span>生成时间 {new Date(r.createdAt).toLocaleString()}</span>
              <span>事实 {r.factCount} 条 / 缺口 {r.gapCount} 项</span>
              {onOpen ? <button type="button" className="btn-mini" onClick={() => onOpen(r.reportId)}>查看</button> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReportDetailView({ reportId }: { reportId: string }) {
  const [d, setD] = useState<ReportDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const load = async () => {
      try { const r = await fetchReport(reportId, ctrl.signal); if (alive) setD(r); }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : String(e)); }
    };
    load();
    const t = setInterval(load, 3000);
    return () => { alive = false; ctrl.abort(); clearInterval(t); };
  }, [reportId]);
  if (err) return <p className="core-err">{err}</p>;
  if (!d) return <p className="hint">加载报告…</p>;
  function download() {
    const blob = new Blob([d?.markdown || ''], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `vantage-report-v${d?.version || 1}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  return (
    <div className="core-report-detail">
      <div className="core-report-meta">
        <span>版本 v{d.version}</span>
        <span className={`core-report-status core-report-${d.status}`}>{STATUS_TEXT[d.status] || d.status}</span>
        <span>生成时间 {new Date(d.createdAt).toLocaleString()}</span>
        {d.finishedAt ? <span>完成 {new Date(d.finishedAt).toLocaleString()}</span> : null}
        {d.markdown ? <button type="button" className="btn-mini" onClick={download}>下载 Markdown</button> : null}
      </div>
      {d.status === 'failed' ? <p className="core-err">{d.errorText || '生成失败，可重新生成。'}</p> : null}
      {d.status === 'queued' || d.status === 'running' ? <p className="hint">生成中…（任务已持久化，服务重启后可恢复或明确失败）</p> : null}
      {d.markdown ? <pre className="core-report-md">{d.markdown}</pre> : null}
      <h4>事实引用</h4>
      {!d.citations.length ? <p className="hint">暂无引用。</p> : (
        <ul className="core-report-cit">
          {d.citations.slice(0, 100).map(c => (
            <li key={c.citationId}>
              <span>{c.label || c.factId || '事实'}</span>
              {c.evidenceIds.length ? <span>Evidence {c.evidenceIds.length} 条</span> : null}
              {c.snapshotIds.length ? <span>快照 {c.snapshotIds.length} 个</span> : null}
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
