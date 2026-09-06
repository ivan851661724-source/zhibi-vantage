'use client';
// discover 流程状态机（移植 app.js discover()/onSSEEvent()/onStage() L687-811 的 React 版）
// 行为契约：
//   · start() → POST /api/discover（202 accepted，进度由 SSE typed 事件推送）
//   · discover_stage → 进度条；brand_found/removed → 实时骨架卡；complete → 全量拉 state；error → 原地失败面板
import { useCallback, useEffect, useState } from 'react';
import { apiPost } from '@/lib/api';
import { useZhibiState } from '@/hooks/use-zhibi-state';

export interface DiscoverCard {
  id: string;
  name: string;
  url?: string;
  tier?: string;
  matchScore?: number;
  why?: string;
}

export interface DiscoverError {
  code?: string;
  message: string;
}

export function useDiscover() {
  const { subscribe, refresh } = useZhibiState();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; label: string; found: number } | null>(null);
  const [cards, setCards] = useState<Record<string, DiscoverCard>>({});
  const [error, setError] = useState<DiscoverError | null>(null);

  useEffect(
    () =>
      subscribe((evt) => {
        switch (evt.type) {
          case 'discover_stage': {
            setProgress({
              pct: typeof evt.pct === 'number' ? evt.pct : 10,
              label: (evt.label as string) || '正在搜索对手…',
              found: typeof evt.found === 'number' ? evt.found : 0,
            });
            break;
          }
          case 'brand_found': {
            const card = evt.card as DiscoverCard | undefined;
            if (card && card.id) setCards((prev) => ({ ...prev, [card.id]: card }));
            break;
          }
          case 'brand_removed': {
            const id = evt.id as string | undefined;
            if (id)
              setCards((prev) => {
                const next = { ...prev };
                delete next[id];
                return next;
              });
            break;
          }
          case 'discover_complete': {
            setRunning(false);
            setCards({});
            setProgress(null);
            void refresh(); // 全量拉权威状态（对齐 onDiscoverComplete）
            break;
          }
          case 'discover_error': {
            setRunning(false);
            const code = evt.code as string | undefined;
            setError({
              code,
              message:
                (evt.message as string | undefined) ||
                (code === 'NO_KEYS'
                  ? '未配置 API 密钥，请在设置中填入搜索源与 DeepSeek 密钥。'
                  : code === 'quota'
                    ? '研究额度已用尽，请升级套餐或稍后再试。'
                    : '识别失败，请稍后重试。'),
            });
            break;
          }
          default:
            break;
        }
      }),
    [subscribe, refresh],
  );

  const start = useCallback(
    async (track: string, intent: Record<string, unknown>) => {
      setRunning(true);
      setError(null);
      setCards({});
      setProgress({ pct: 5, label: '正在理解你的赛道…', found: 0 });
      try {
        await apiPost('/api/discover', { track, intent });
        // 发现启动即拉一次空状态（对齐 F1 加固：用户立即看到「赛道 + 研究中」而非空白）
        await refresh();
      } catch (e) {
        setRunning(false);
        setProgress(null);
        const m = e instanceof Error ? e.message : '未知错误';
        setError({
          message: /NO_KEYS/.test(m)
            ? '未配置 API 密钥，请在设置中填入搜索源与 DeepSeek 密钥。'
            : /TOO_BUSY|RATE_LIMIT|quota/.test(m)
              ? '研究服务正忙或请求过于频繁，请稍后再试。'
              : '识别失败：' + m,
        });
      }
    },
    [refresh],
  );

  const reset = useCallback(() => {
    setError(null);
    setProgress(null);
    setCards({});
  }, []);

  return { running, progress, cards, error, start, reset };
}
