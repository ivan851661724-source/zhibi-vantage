'use client';
// Evidence 抽屉（04 §11：信任核心组件——只渲染用户可见字段，不含 provider/路径/栈）
// 2026-10-18 复审整改：稳定 active key（evidenceId || snapshotId）；refs 改变时
// 重置 active key、清理旧 detail、取消旧请求；多个 snapshot-only 条目可分别选择。
import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import type { SurfaceEvidenceRef } from './types';

interface EvidenceDetail {
  evidence?: {
    evidence_id?: string;
    evidence_status?: string;
    observed_at?: string | null;
    created_at?: string;
    claim?: { field?: string | null; scope?: string | null };
    extracted_value?: unknown;
    currency?: string | null;
    note?: string | null;
  };
  snapshots?: {
    snapshot_id?: string;
    source_url?: string | null;
    source_status?: string | null;
    observed_at?: string | null;
    partial_scan?: boolean | null;
  }[];
}

const STATUS_ZH: Record<string, string> = {
  verified: '已核实', derived: '推算', conflicted: '来源冲突', unavailable: '不可用',
};
// 稳定 active key：evidenceId 优先，缺失时退 snapshotId（多 snapshot-only 条目因此可分别定位）
function refKey(r: SurfaceEvidenceRef | null): string | null {
  if (!r) return null;
  return r.evidenceId || r.snapshotId || null;
}

export function EvidenceDrawer({ refs, onClose }: { refs: SurfaceEvidenceRef[]; onClose: () => void }) {
  const [activeKey, setActiveKey] = useState<string | null>(() => refKey(refs[0] || null));
  const [detail, setDetail] = useState<EvidenceDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // refs 改变（切换品牌/刷新）→ 重置 active key、清理旧 detail；activeKey 变化 → 取消旧请求
  useEffect(() => {
    if (!refs || !refs.length) { setActiveKey(null); setDetail(null); setErr(null); return; }
    const keys = refs.map(refKey).filter(Boolean);
    setActiveKey(prev => (prev && keys.includes(prev)) ? prev : (keys[0] || null));
    setDetail(null);
  }, [refs]);

  useEffect(() => {
    if (!activeKey) { setDetail(null); setErr(null); setLoading(false); return; }
    const activeRef = refs.find(r => refKey(r) === activeKey) || null;
    if (!activeRef || !activeRef.evidenceId) { setDetail(null); setErr(null); setLoading(false); return; }
    setErr(null);
    setLoading(true);
    const ctrl = new AbortController();
    apiGet<EvidenceDetail>('/api/demo/evidence-detail?id=' + encodeURIComponent(activeRef.evidenceId), ctrl.signal)
      .then((d) => { if (!ctrl.signal.aborted) { setDetail(d); setLoading(false); } })
      .catch((e) => {
        if (e && e.name === 'AbortError') return;
        if (!ctrl.signal.aborted) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false); }
      });
    return () => { try { ctrl.abort(); } catch (e) { /* 已结束 */ } };
  }, [activeKey, refs]);

  const ev = detail && detail.evidence;
  const snaps = (detail && detail.snapshots) || [];
  const activeRef = refs.find(r => refKey(r) === activeKey) || null;
  const noEvidenceSelected = !activeKey || !(activeRef && activeRef.evidenceId);

  return (
    <div className="ds-drawer-mask" onClick={onClose}>
      <div className="ds-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="ds-drawer-head">
          <span>数据依据（{refs.length}）</span>
          <button className="btn-mini" type="button" onClick={onClose}>关闭</button>
        </div>

        {/* 多条 Evidence 切换（含仅快照条目；key 稳定可分别选择） */}
        {refs.length > 1 || noEvidenceSelected ? (
          <div className="ds-ev-tabs">
            {refs.map((r, i) => {
              const k = refKey(r);
              return (
                <button
                  key={k || ('ref-' + i)}
                  className={'ds-ev-tab' + (k === activeKey ? ' on' : '')}
                  type="button"
                  onClick={() => setActiveKey(k)}
                >
                  {r.evidenceId ? '证据 ' + (i + 1) : '来源快照 ' + (i + 1)}
                </button>
              );
            })}
          </div>
        ) : null}

        {loading ? <p className="hint">加载证据…</p> : null}
        {err ? <p className="hint">{err}</p> : null}
        {noEvidenceSelected ? (
          <div className="ds-drawer-body">
            <p className="hint">该条目暂无独立证据记录，可经来源链接核对原始数据。</p>
            {activeRef && activeRef.sourceUrl ? (
              <div className="ds-ev-row">
                <span className="k">来源</span>
                <a href={activeRef.sourceUrl} target="_blank" rel="noopener">{activeRef.sourceUrl} ↗</a>
              </div>
            ) : null}
            {activeRef && activeRef.snapshotId ? (
              <div className="ds-ev-row"><span className="k">快照编号</span><span className="ds-ev-snap-id">{activeRef.snapshotId}</span></div>
            ) : null}
          </div>
        ) : null}

        {ev ? (
          <div className="ds-drawer-body">
            <div className="ds-ev-row"><span className="k">状态</span><span>{STATUS_ZH[ev.evidence_status || ''] || ev.evidence_status || '—'}</span></div>
            <div className="ds-ev-row"><span className="k">字段</span><span>{ev.claim?.field || '—'}</span></div>
            <div className="ds-ev-row"><span className="k">观察时间</span><span>{ev.observed_at ? new Date(ev.observed_at).toLocaleString() : '—'}</span></div>
            <div className="ds-ev-row"><span className="k">内容</span><span className="num">{JSON.stringify(ev.extracted_value)}</span></div>
            {snaps.length ? (
              <div className="ds-ev-snaps">
                {snaps.map((s, i) => (
                  <div className="ds-ev-snap" key={s.snapshot_id || i}>
                    <span className="k">来源快照</span>
                    <span>
                      {s.source_url ? <a href={s.source_url} target="_blank" rel="noopener">{s.source_url} ↗</a> : '（来源页不可用）'}
                      {s.partial_scan ? ' · 部分抓取' : ''}
                      {s.observed_at ? ` · ${new Date(s.observed_at).toLocaleString()}` : ''}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
            {/* 仅有 sourceUrl/snapshotId 时的兜底可追溯入口 */}
            {!snaps.length && activeRef ? (
              <div className="ds-ev-row">
                <span className="k">来源</span>
                <span>
                  {activeRef.sourceUrl ? <a href={activeRef.sourceUrl} target="_blank" rel="noopener">{activeRef.sourceUrl} ↗</a> : '（来源页不可用）'}
                  {activeRef.snapshotId ? ` · 快照编号 ${activeRef.snapshotId}` : ''}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
