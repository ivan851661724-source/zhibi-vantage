'use client';
// 知彼 Vantage · 全局 state Provider（docs/01-前端架构规范.md §5）
// 数据流复刻 app/public/app.js：
//   state 单一服务端真相（/api/state）+ SSE 推送 → 签名比对（stateSig，L616-630）→ 不同才替换
//   React 版：Provider 持有 state，面板组件经 useZhibiState() 订阅。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { apiGet } from '@/lib/api';
import { connectStream, type SseEvent } from '@/lib/sse';
import type { ZhibiState } from '@/types/state';

// ---------- 签名函数（逐行复刻 app.js stateSig，L616-630） ----------
function stateSig(s: ZhibiState): string {
  try {
    const cs = (s.competitors || [])
      .map((c) =>
        [
          c.id,
          c.status,
          c.priceField && c.priceField.display,
          c.priceField && c.priceField.basis,
          c.priceField && c.priceField.confidence,
          (c.channelFields && Object.keys(c.channelFields).length) || 0,
          c.reviewField ? c.reviewField.rating && c.reviewField.rating.value : '',
          (c.pendingCorrections || []).length,
        ].join('|'),
      )
      .join('~');
    const ws = s.whiteSpace
      ? s.whiteSpace.version || JSON.stringify(s.whiteSpace.gaps && s.whiteSpace.gaps.length) || ''
      : '';
    return (
      cs +
      '#' +
      (s.fieldCorrections ? s.fieldCorrections.length : 0) +
      '#' +
      ws +
      '#' +
      (s.whiteSpace ? String(s.whiteSpace.coverage) : '')
    );
  } catch {
    return '' + Date.now();
  }
}

interface ZhibiStateContextValue {
  state: ZhibiState | null;
  loading: boolean;
  /** 手动刷新（拉 state + 签名比对；供纠错提交等主动操作后调用） */
  refresh: () => Promise<void>;
  /**
   * 本地替换 state（Phase 3 纠错用）：/api/field-correct 返回服务端 state +
   * 该用户私有覆盖值，前端叠加后立即呈现（对齐旧版 state = s.state; applyPrivateOverride(s)）。
   * 绕过签名比对——下次 SSE 推送仍会按签名决定是否替换。
   */
  patch: (next: ZhibiState) => void;
  /** 订阅 SSE typed 事件（Phase 2 discover 增量渲染用） */
  subscribe: (fn: (evt: SseEvent) => void) => () => void;
}

const ZhibiStateContext = createContext<ZhibiStateContextValue | null>(null);

export function ZhibiStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ZhibiState | null>(null);
  const [loading, setLoading] = useState(true);
  const sigRef = useRef<string>('');
  // typed 事件订阅者集合（Set 天然幂等去重）
  const listenersRef = useRef(new Set<(evt: SseEvent) => void>());

  // onPush（复刻 app.js L639-650）：拉 state → 签名比对 → 不同才替换
  const onPush = useCallback(async () => {
    try {
      const s = await apiGet<ZhibiState>('/api/state');
      setState((prev) => {
        const sig = stateSig(s as ZhibiState);
        if (sig === sigRef.current) return prev; // 数据未变，跳过重渲染
        sigRef.current = sig;
        return s;
      });
    } catch {
      // 静默（对齐旧版 catch {}）：401 已由 api.ts 统一跳登录处理
    } finally {
      setLoading(false);
    }
  }, []);

  const subscribe = useCallback((fn: (evt: SseEvent) => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  // 本地替换（Phase 3 纠错私有覆盖）：同步刷新签名，避免下次 SSE 推送误判「未变」跳过
  const patch = useCallback((next: ZhibiState) => {
    sigRef.current = stateSig(next);
    setState(next);
  }, []);

  useEffect(() => {
    void onPush(); // 首拉
    const handle = connectStream({
      onEvent: (evt) => {
        for (const fn of listenersRef.current) {
          try {
            fn(evt);
          } catch {
            /* 单个订阅者异常不影响其他 */
          }
        }
      },
      onChange: () => {
        void onPush();
      },
    });
    return () => handle.close();
  }, [onPush]);

  const value = useMemo(
    () => ({ state, loading, refresh: onPush, patch, subscribe }),
    [state, loading, onPush, patch, subscribe],
  );

  return <ZhibiStateContext.Provider value={value}>{children}</ZhibiStateContext.Provider>;
}

export function useZhibiState(): ZhibiStateContextValue {
  const ctx = useContext(ZhibiStateContext);
  if (!ctx) throw new Error('useZhibiState 必须在 ZhibiStateProvider 内使用（面板路由应位于 (panel)/ 布局下）');
  return ctx;
}
