'use client';
// ============================================================
// use-discover-status —— 首屏品牌识别状态（r3 §三/§六）
// ------------------------------------------------------------
// 目的：状态横幅不再等 1.1MB 的 /api/state。进入工作台立刻打 /api/discover/status，
// 通常 1–2 秒内就能画出「运行中 / 失败 / 成功 / 合法空结果 / 历史未完整完成」。
//
// 纪律：
//   · 运行中每 4 秒轮询；终态立刻停轮询（不无意义地打后端）。
//   · 切项目 / 卸载 → abort 旧请求，并清空旧状态：旧请求晚返回绝不覆盖新项目。
//   · 失败不会把旧的「上一次成功」信息抹掉（keptPrevious 原样透传，由页面决定文案）。
//   · 轮询上限 10 分钟：后台进程若崩溃，页面不会永久转圈。
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDiscoverStatus, type DiscoverStatus } from '@/lib/core-api';
import { isDemoMode } from '@/lib/demo';

const POLL_MS = 4000;
const POLL_MAX_MS = 10 * 60 * 1000;

export interface DiscoverStatusView {
  status: DiscoverStatus | null;
  loading: boolean;
  error: string;
  refresh: () => void;
}

export function useDiscoverStatus(projectId: string): DiscoverStatusView {
  const [status, setStatus] = useState<DiscoverStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  // 代数：切项目即 +1，旧代数回来的响应当场丢弃
  const genRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    // 切项目：先清空上一个项目的状态，绝不让 A 项目的失败横幅留在 B 项目页面上
    genRef.current += 1;
    const gen = genRef.current;
    if (abortRef.current) { try { abortRef.current.abort(); } catch { /* noop */ } abortRef.current = null; }
    setStatus(null);
    setError('');
    setLoading(true);
    // 演示模式没有真实运行态：直接按本地 mock 渲染，不打后端
    if (isDemoMode()) { setLoading(false); return; }
    // 允许 projectId 为空：后端会按「当前项目指针」返回，不带 ?projectId 也能在首帧就拿到状态
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const startedAt = Date.now();

    const schedule = (ms: number) => {
      if (stopped) return;
      timer = setTimeout(run, ms);
    };

    const run = async () => {
      if (stopped || gen !== genRef.current) return;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const s = await fetchDiscoverStatus(projectId, ctrl.signal);
        if (stopped || gen !== genRef.current) return; // 旧请求晚返回：丢弃
        setStatus(s);
        setError('');
        setLoading(false);
        // 终态停止轮询；运行中（或状态暂缺）继续
        const terminal = s.phase === 'failed' || s.phase === 'done' || s.phase === 'empty'
          || s.phase === 'incomplete' || s.phase === 'no_track';
        if (!terminal && Date.now() - startedAt < POLL_MAX_MS) schedule(POLL_MS);
      } catch (e) {
        if (stopped || gen !== genRef.current) return;
        if (e instanceof Error && e.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : '状态读取失败');
        setLoading(false);
        // 读取失败按 4 秒重试，但不超过上限
        if (Date.now() - startedAt < POLL_MAX_MS) schedule(POLL_MS);
      }
    };

    void run();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (abortRef.current) { try { abortRef.current.abort(); } catch { /* noop */ } abortRef.current = null; }
    };
  }, [projectId, tick]);

  return { status, loading, error, refresh };
}
