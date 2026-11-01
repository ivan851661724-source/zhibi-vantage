'use client';
// ============================================================
// use-project-full-state —— 按需取「完整真值」（r3 §四/§五）
// ------------------------------------------------------------
// 首屏只取摘要（scope=summary）。但白空间 / 蓝海 / 趋势 / 机会 / 品牌字段明细
// 这些重聚合仍需要完整真值 —— 由真正用到它们的页面（算法资产、市场机会、象限）
// 自己按需加载，绝不再拖着工作台首屏。
//
// 纪律：
//   · 一个项目只发一次请求；切项目 abort 旧请求，晚返回不覆盖新项目。
//   · 失败不清空已有数据（保留上一次成功结果），只回报 error。
// ============================================================
import { useEffect, useState } from 'react';
import { apiGet } from '@/lib/api';
import type { ZhibiState } from '@/types/state';
import { isDemoMode } from '@/lib/demo';

export interface ProjectFullStateView {
  state: ZhibiState | null;
  loading: boolean;
  error: string;
}

export function useProjectFullState(
  projectId: string | undefined | null,
  opts: { demoFallback?: ZhibiState | null } = {},
): ProjectFullStateView {
  const [state, setState] = useState<ZhibiState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!projectId) { setState(null); setLoading(false); setError(''); return; }
    // 演示模式的数据来自本地 mock（本身就是完整结构），不请求真实后端
    if (isDemoMode()) { setState(opts.demoFallback || null); setLoading(false); setError(''); return; }
    let alive = true;
    const ctrl = new AbortController();
    setLoading(true);
    setError('');
    apiGet<ZhibiState>(`/api/state?private_view=1&projectId=${encodeURIComponent(projectId)}`, ctrl.signal)
      .then((s) => { if (alive) { setState(s); setLoading(false); } })
      .catch((e: unknown) => {
        if (!alive) return;
        if (e instanceof Error && e.name === 'AbortError') return;
        // 失败保留上一次成功结果，只标记错误（不把「读不到」显示成「没有数据」）
        setError(e instanceof Error ? e.message : '完整资料读取失败');
        setLoading(false);
      });
    return () => { alive = false; ctrl.abort(); };
  }, [projectId, opts.demoFallback]);

  return { state, loading, error };
}
