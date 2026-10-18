'use client';
// 异动提醒中心存储（F-03，移植旧版 store.js 的 alert 部分 + alerts.js 的 AlertsUI 行为）
// 双来源合并：
//   · 本地推送：SSE discover_complete / discover_error 事件 → push（localStorage 持久）
//   · 服务端：GET /api/alerts（雷达 sweep 检测到竞品动作落盘的站内信）→ mergeServer 按 id 去重合并
// 无归属旧键保留但不读取；每个已识别账号独立缓存。
import { useCallback, useEffect, useState } from 'react';
import { captureSession, isSessionCurrent, SESSION_CHANGED_EVENT, type BrowserSession } from '@/lib/storage-scope';
import { createStateRefresh } from '@/lib/state-refresh';

const ALERT_KEY = 'zb_alerts_v1';
const MAX_ALERTS = 100;

/** 统一提醒视图模型：本地推送带 ts(number)，服务端带 at(ISO) */
export interface ZbAlert {
  id: string;
  type: string; // 'complete' | 'error' | 'competitor-move' | ...
  title: string;
  body?: string;
  ts?: number;
  at?: string;
  read: boolean;
}

function load(session = captureSession()): ZbAlert[] {
  try {
    if (!session.scope || !isSessionCurrent(session)) return [];
    const list: unknown = JSON.parse(localStorage.getItem(ALERT_KEY + ':' + session.scope) || '[]');
    return Array.isArray(list) ? list as ZbAlert[] : [];
  } catch {
    return [];
  }
}

function persist(list: ZbAlert[], session = captureSession()): void {
  try {
    if (!session.scope || !isSessionCurrent(session)) return;
    localStorage.setItem(ALERT_KEY + ':' + session.scope, JSON.stringify(list));
  } catch {
    /* 隐私模式等静默 */
  }
}

/** 服务端提醒归一化：competitor-move → 人类可读标题/正文（旧版 mergeServer 原样透传导致只显示「提醒」） */
function normalizeServerAlert(x: Record<string, unknown>): ZbAlert {
  const type = String(x.type || '');
  let title = String(x.title || '');
  let body = x.body ? String(x.body) : '';
  if (type === 'competitor-move') {
    const name = String(x.competitorName || '竞争品牌');
    const moves = Array.isArray(x.moves) ? (x.moves as unknown[]).map(String).filter(Boolean) : [];
    title = name + ' 出现新的竞争动态';
    body = moves.length ? moves.join('；') : '雷达检测到该竞争品牌的新动态，请前往工作台查看。';
  } else if (['price-change', 'price-discovered', 'product-launch', 'stockout'].includes(type)) {
    const labels: Record<string, string> = { 'price-change': '价格变化', 'price-discovered': '首次观察到价格', 'product-launch': '商品动态', stockout: '库存变化' };
    title = String(x.competitorName || '竞争品牌') + ' · ' + labels[type];
    body = typeof x.text === 'string' ? x.text : body;
  }
  return {
    id: String(x.id || ''),
    type: type || 'info',
    title: title || '提醒',
    body,
    ts: typeof x.ts === 'number' ? x.ts : undefined,
    at: typeof x.at === 'string' ? x.at : undefined,
    read: !!x.read,
  };
}

export function alertsLoad(): ZbAlert[] {
  return load();
}

export function alertsPush(a: { type: string; title: string; body?: string }, session = captureSession()): void {
  if (!isSessionCurrent(session)) return;
  const list = load(session);
  list.unshift({
    id: 'al_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    ts: Date.now(),
    read: false,
    ...a,
  });
  if (list.length > MAX_ALERTS) list.length = MAX_ALERTS;
  persist(list, session);
}

/** 按 id 合并服务端提醒；已有条目的正文及已读态随服务端权威结果更新。返回服务端 id 集。 */
export function alertsMergeServer(raw: unknown[], session: BrowserSession = captureSession()): { merged: number; serverIds: string[] } {
  if (!isSessionCurrent(session) || !session.scope) return { merged: 0, serverIds: [] };
  if (!Array.isArray(raw) || !raw.length) return { merged: 0, serverIds: [] };
  const list = load(session);
  let merged = 0;
  const serverIds: string[] = [];
  for (const item of raw.slice().reverse()) {
    const a = normalizeServerAlert((item || {}) as Record<string, unknown>);
    if (!a.id) continue;
    serverIds.push(a.id);
    const index = list.findIndex(x => x.id === a.id);
    if (index >= 0) {
      list[index] = a;
      continue;
    }
    list.unshift(a);
    merged++;
  }
  if (list.length > MAX_ALERTS) list.length = MAX_ALERTS;
  persist(list, session);
  return { merged, serverIds };
}

/** 全部已读（本地落盘；服务端 ids 由调用方另行 POST /api/alerts/read） */
export function alertsMarkAllRead(): ZbAlert[] {
  const list = load();
  list.forEach((x) => {
    x.read = true;
  });
  persist(list);
  return list;
}

export function alertsUnreadCount(): number {
  return load().filter((x) => !x.read).length;
}

/** Visible tabs poll the existing inbox endpoint; reopening/reconnecting UI may request immediately. */
export function startAlertsRefresh(opts: {
  read: () => Promise<{ alerts: unknown[] }>;
  onUpdate: (serverIds: string[]) => void;
  onError: (error: Error | null) => void;
}) {
  const session = captureSession();
  if (typeof window === 'undefined' || !session.scope || session.scope === 'demo') return { request: () => Promise.resolve(), close: () => {} };
  const worker = createStateRefresh({
    read: opts.read,
    apply: result => {
      if (!Array.isArray(result.alerts)) throw new Error('提醒响应格式不完整');
      const merged = alertsMergeServer(result.alerts, session);
      opts.onUpdate(merged.serverIds);
    },
    onError: opts.onError,
    onSettled: () => {},
    isCurrent: () => isSessionCurrent(session),
  });
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const timer = window.setInterval(() => { if (visible()) void worker.request(); }, 30000);
  const onVisibility = () => { if (visible()) void worker.request(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  void worker.request();
  return {
    request: worker.request,
    close: () => {
      worker.close();
      window.clearInterval(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

/** 相对时间（移植 alerts.js fmtWhen；兼容 ts/at 两种时间字段） */
export function fmtAlertWhen(a: ZbAlert): string {
  const t = a.ts || (a.at ? new Date(a.at).getTime() : 0);
  if (!t) return '';
  const diff = Date.now() - t;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  try {
    return new Date(t).toLocaleDateString('zh-CN');
  } catch {
    return '';
  }
}

// ---------- React 订阅式 Hook（storage 事件跨组件同步） ----------
export function useAlerts(): {
  alerts: ZbAlert[];
  unread: number;
  refresh: () => void;
} {
  const [alerts, setAlerts] = useState<ZbAlert[]>([]);
  const refresh = useCallback(() => setAlerts(load()), []);
  useEffect(() => {
    refresh();
    const onStorage = () => refresh();
    window.addEventListener('storage', onStorage);
    window.addEventListener(SESSION_CHANGED_EVENT, onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SESSION_CHANGED_EVENT, onStorage);
    };
  }, [refresh]);
  const unread = alerts.filter((x) => !x.read).length;
  return { alerts, unread, refresh };
}
