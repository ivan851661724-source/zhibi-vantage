// 知彼 Vantage · SSE 封装（docs/02-API契约.md §3）
// 行为复刻自 app/public/app.js 的 startPolling()（L651-678）：
//   · EventSource('/api/stream')，浏览器按服务端 retry:3000 自动重连
//   · typed 事件（type 存在且 !== 'change'）→ 分发给 onEvent（Phase 2 discover 增量渲染用）
//   · 通用 change 事件 → 触发 onPush（拉 state + 签名比对）
//   · onerror → 15s 轮询兜底；重连成功（onopen）后清除兜底（对旧版的小改进：
//     旧版 fallbackTimer 一旦建立不会清除，每 15s 空拉一次；事件恢复后轮询冗余）
'use client';

export interface SseEvent {
  type?: string;
  [key: string]: unknown;
}

export interface SseHandle {
  close: () => void;
}

export function connectStream(opts: {
  onEvent: (evt: SseEvent) => void;
  onChange: () => void;
}): SseHandle {
  const { onEvent, onChange } = opts;

  if (typeof window === 'undefined' || typeof EventSource === 'undefined') {
    // SSR / 极旧浏览器兜底：15s 轮询（对齐旧版 fall through to interval）
    const timer = window.setInterval(onChange, 15000);
    return { close: () => window.clearInterval(timer) };
  }

  let fallbackTimer: ReturnType<typeof setInterval> | null = null;
  const clearFallback = () => {
    if (fallbackTimer) {
      clearInterval(fallbackTimer);
      fallbackTimer = null;
    }
  };

  const es = new EventSource('/api/stream');

  es.onopen = () => clearFallback();

  es.onmessage = (ev: MessageEvent<string>) => {
    let evt: SseEvent | null = null;
    try {
      evt = ev.data ? (JSON.parse(ev.data) as SseEvent) : null;
    } catch {
      evt = null;
    }
    // typed 事件按类型分发；change → 触发拉取（对齐旧版 onmessage 逻辑）
    if (evt && evt.type && evt.type !== 'change') {
      onEvent(evt);
      return;
    }
    onChange();
  };

  es.onerror = () => {
    // 断线兜底：15s 轮询保证状态仍可见（EventSource 自动重连期间）
    if (!fallbackTimer) fallbackTimer = setInterval(onChange, 15000);
  };

  return {
    close: () => {
      clearFallback();
      es.close();
    },
  };
}
