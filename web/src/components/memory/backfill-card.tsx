'use client';
// BackfillProgressCard（SC-05 §7.1）：仅在用户主动创建历史回补任务后出现。
// 展示真实任务状态、覆盖缺口与失败分类；不显示内部错误码、URL、栈。
import { useEffect, useRef, useState } from 'react';
import { fetchBackfillJob, startHistoryBackfill, type BackfillJob } from '@/lib/memory-api';

const TERMINAL = ['done', 'partial', 'failed', 'source_unavailable', 'no_archive_record', 'dead'];

export function BackfillCard({
  brandId, projectId, canBackfill, disabledReason, initialJob, onFinished,
}: {
  brandId: string;
  projectId: string;
  canBackfill: boolean;
  disabledReason?: string | null;
  initialJob?: BackfillJob | null;
  onFinished?: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const [from, setFrom] = useState(yearAgo);
  const [to, setTo] = useState(today);
  const [job, setJob] = useState<BackfillJob | null>(initialJob || null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    setJob(initialJob || null);
  }, [initialJob]);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  function poll(jobId: string) {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(async () => {
      try {
        const j = await fetchBackfillJob(jobId);
        if (!aliveRef.current) return;
        setJob(j);
        if (TERMINAL.includes(j.status)) {
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
          if (onFinished) onFinished();
        }
      } catch (e) {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }, 3000);
  }

  async function start() {
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const r = await startHistoryBackfill(brandId, { projectId, capability: 'shopify_catalog', from, to });
      setJob(r.job);
      setMsg(r.message);
      poll(r.jobId);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '发起失败，请稍后重试。');
    } finally { setBusy(false); }
  }

  const running = job && !TERMINAL.includes(job.status);

  return (
    <div className="mem-backfill">
      <div className="mem-backfill-head">
        <b>历史回补</b>
        <span className="hint">只有当用户主动发起时才抓取公开网页存档；每月最多取一个存档快照。</span>
      </div>
      {!canBackfill ? (
        <p className="hint">{disabledReason || '该品牌暂不支持历史回补。'}</p>
      ) : (
        <div className="mem-backfill-form">
          <label>从<input type="date" value={from} max={to} disabled={busy || !!running} onChange={e => setFrom(e.target.value)} /></label>
          <label>到<input type="date" value={to} min={from} max={today} disabled={busy || !!running} onChange={e => setTo(e.target.value)} /></label>
          <button type="button" className="mem-backfill-btn" disabled={busy || !!running || !from || !to} onClick={start}>
            {running ? '回补进行中…' : busy ? '提交中…' : '回补历史'}
          </button>
        </div>
      )}
      {msg ? <p className="hint">{msg}</p> : null}
      {job ? (
        <div className="mem-backfill-job">
          <div className="mem-backfill-status">
            <span className={'mem-job-state mem-job-' + job.status}>{job.statusText}</span>
            <span className="hint">
              请求范围 {job.requested.from} ~ {job.requested.to}
              {job.progress ? ' · ' + job.progress.text : ''}
            </span>
          </div>
          {running ? (
            <div className="mem-backfill-bar"><span style={{ width: Math.max(2, job.progress.percent) + '%' }} /></div>
          ) : null}
          <ul className="mem-backfill-counts">
            <li>发现候选快照 {job.counts.discovered} 个</li>
            <li>成功取回 {job.counts.fetched} 个</li>
            <li>已写入历史事实 {job.counts.imported} 个</li>
            <li>跳过 {job.counts.skipped} 个</li>
          </ul>
          {job.coverageSummary && job.coverageSummary.failedMonths && job.coverageSummary.failedMonths.length ? (
            <p className="hint">未成功的时间点：{job.coverageSummary.failedMonths.join('、')}（这些月份没有补入任何数据）</p>
          ) : null}
          {job.errorUserText ? <p className="mem-backfill-err">{job.errorUserText}</p> : null}
          <p className="hint">
            回补只补充「公开网页存档里确实存在的版本」；存档没有的时间点保持空缺，不会被补成连续趋势。
          </p>
        </div>
      ) : null}
    </div>
  );
}
