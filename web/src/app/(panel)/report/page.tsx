'use client';
// 调研报告页（PRD R6.2）：顶部诚实条（三色横条，点击展开字段清单）+ 报告正文。
// 数据源：state.brief（POST /api/brief 生成，lib/report 管线产出 evidenceDist + markdown）。
// 未生成 → 提示 + 一键生成按钮（LLM 调用，耗时约 30-60s）。
import { useState } from 'react';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { apiPost } from '@/lib/api';
import { EvidenceBar, type EvidenceDist } from '@/components/evidence-bar';
import { renderMarkdown } from '@/lib/md';

interface Brief {
  markdown?: string;
  generatedAt?: string;
  asOf?: string;
  evidenceDist?: EvidenceDist;
  audit?: { facts?: number; gaps?: number; removedSentences?: number; flaggedSentences?: number; suspectSentences?: number };
  qc?: { passed?: number; total?: number; allPass?: boolean; checks?: { name: string; desc: string; pass: boolean }[] };
  [k: string]: unknown;
}

export default function ReportPage() {
  const { state, loading, refresh } = useZhibiState();
  const brief = (state ? (state.brief as Brief | undefined) : undefined) || undefined;
  const dist = (brief && brief.evidenceDist) || (state ? (state.evidenceDist as EvidenceDist | undefined) : undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showQc, setShowQc] = useState(false);

  async function generate() {
    setErr('');
    setBusy(true);
    try {
      await apiPost('/api/brief');
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : '报告生成失败，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  const hasTrack = !!(state && (state.track || (state.competitors && state.competitors.length)));

  return (
    <div className="report-page">
      <div className="report-head">
        <h2 className="report-title">调研报告{state && typeof state.track === 'string' && state.track ? <span className="crumb"> / {state.track}</span> : null}</h2>
        {brief && brief.generatedAt && (
          <span className="hint">生成于 {new Date(brief.generatedAt).toLocaleString('zh-CN')} · as-of {brief.asOf || '—'}</span>
        )}
        <button className="btn primary" type="button" onClick={generate} disabled={busy || !hasTrack}>
          {busy ? '生成中…（约 30-60 秒）' : brief ? '重新生成报告' : '生成调研报告'}
        </button>
      </div>

      {/* R6.2：报告顶部诚实条（三色横条 + 点击展开字段清单） */}
      <EvidenceBar dist={dist} />

      {err && <p className="hint">⚠ {err}</p>}
      {!hasTrack && !loading && <p className="hint">还没有调研数据——先在工作台发起一次赛道调研。</p>}
      {hasTrack && !brief && !busy && !err && (
        <p className="hint">报告尚未生成。点击上方「生成调研报告」，基于已查实的字段与空白清单装配（每句可溯源，无据不写）。</p>
      )}

      {brief && brief.markdown && (
        <>
          <article className="report-body">{renderMarkdown(brief.markdown)}</article>
          {brief.qc && (
            <div className="report-qc">
              <button className="btn-ghost" type="button" onClick={() => setShowQc(!showQc)}>
                机器校验：{brief.qc.passed}/{brief.qc.total} 项通过{showQc ? '（收起）' : '（展开）'}
              </button>
              {showQc && (
                <ul className="qc-list">
                  {(brief.qc.checks || []).map((c) => (
                    <li key={c.name}>{c.pass ? '✓' : '✗'} <b>{c.name}</b> — {c.desc}</li>
                  ))}
                </ul>
              )}
              {brief.audit && (
                <p className="hint">
                  审计：事实 {brief.audit.facts || 0} 条 · 空白 {brief.audit.gaps || 0} 条 · 删除编造/裸句 {brief.audit.removedSentences || 0} 句
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
