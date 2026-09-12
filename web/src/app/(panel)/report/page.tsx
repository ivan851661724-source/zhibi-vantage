'use client';
// 调研报告页（PRD R6.2）：顶部诚实条（三色横条，点击展开字段清单）+ 报告正文。
// 数据源：state.brief（POST /api/brief 生成，lib/report 管线产出 evidenceDist + markdown）。
// F-2（B-4 异步契约）：POST /api/brief 立即回 202 {ok,status:'running'}（401 NO_KEYS /
// 404 NO_STATE 同步错误仍同步抛）→ 前端轮询 GET /api/state 按 s.briefStatus 分派：
//   running → 继续轮（间隔 ≥3s，避免打爆 state 接口）
//   done    → patch(s) 渲染 s.brief，停止轮询
//   failed  → 显示 s.briefError + 重试入口（重试 = 再 POST，后端幂等）
// 轮询纪律：不新建接口/通道，只用现有 GET /api/state；组件卸载/切页清理定时器。
// 注意：落地轮询结果用 patch() 而非 refresh()——refresh 走 stateSig 签名比对，
// 签名不含 brief 字段，briefStatus 终态会被「数据未变」跳过导致报告永不渲染。
import { useCallback, useEffect, useRef, useState } from 'react';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { apiGet, apiPost } from '@/lib/api';
import { EvidenceBar, type EvidenceDist } from '@/components/evidence-bar';
import { renderMarkdown } from '@/lib/md';
import type { ZhibiState } from '@/types/state';

const BRIEF_POLL_MS = 3000; // 任务书 F-2：轮询间隔 ≥3s

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
  const { state, loading, patch } = useZhibiState();
  const brief = (state ? (state.brief as Brief | undefined) : undefined) || undefined;
  const dist = (brief && brief.evidenceDist) || (state ? (state.evidenceDist as EvidenceDist | undefined) : undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showQc, setShowQc] = useState(false);
  // 轮询定时器句柄（ref 而非 state：不触发重渲染；卸载/终态时清理）
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // 组件卸载/页面切换：清理轮询定时器（任务书 F-2 第 3 条）
  useEffect(() => stopPoll, [stopPoll]);

  // 轮询一次 /api/state：按 briefStatus 分派（终态 patch 落地，running 静默续轮）
  const pollOnce = useCallback(async () => {
    try {
      const s = await apiGet<ZhibiState>('/api/state');
      if (s.briefStatus === 'done') {
        stopPoll();
        patch(s); // 绕过签名比对，brief 报告立即可渲染
        setBusy(false);
      } else if (s.briefStatus === 'failed') {
        stopPoll();
        patch(s);
        setBusy(false);
        setErr(s.briefError || '报告生成失败，请点击「生成调研报告」重试');
      }
      // running → 继续轮（不 patch，避免每 3s 无谓重渲染）
    } catch {
      // 单次轮询失败静默，下一轮自愈（对齐 onPush 的 catch 口径）
    }
  }, [patch, stopPoll]);

  const startPoll = useCallback(() => {
    if (pollRef.current) return; // 幂等：running 期间重复触发不叠加定时器
    pollRef.current = setInterval(() => {
      void pollOnce();
    }, BRIEF_POLL_MS);
  }, [pollOnce]);

  // 挂载时若后端已有 running 任务（生成中切页后回来），恢复轮询而非让用户盲等
  useEffect(() => {
    if (state && state.briefStatus === 'running') startPoll();
  }, [state, startPoll]);

  async function generate() {
    setErr('');
    setBusy(true);
    try {
      // F-2：POST 只负责任务受理（202）；401 NO_KEYS / 404 NO_STATE 同步错误会抛 ApiError。
      // 不再读 body 里的报告（异步契约下 body 无报告），改由轮询取终态。
      await apiPost('/api/brief');
      startPoll();
    } catch (e) {
      setBusy(false);
      setErr(e instanceof Error ? e.message : '报告生成失败，请稍后再试');
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
