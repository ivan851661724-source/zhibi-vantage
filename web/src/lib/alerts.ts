'use client';
// 异动提醒中心存储（F-03，移植旧版 store.js 的 alert 部分 + alerts.js 的 AlertsUI 行为）
// 双来源合并：
//   · 本地推送：SSE discover_complete / discover_error 事件 → push（localStorage 持久）
//   · 服务端：GET /api/alerts（雷达 sweep 检测到竞品动作落盘的站内信）→ mergeServer 按 id 去重合并
// 键名 zb_alerts_v1 与旧前端一致：同浏览器下已有提醒无缝继承。
import { useCallback, useEffect, useState } from 'react';

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

function load(): ZbAlert[] {
  try {
    return JSON.parse(localStorage.getItem(ALERT_KEY) || '[]') as ZbAlert[];
  } catch {
    return [];
  }
}

function persist(list: ZbAlert[]): void {
  try {
    localStorage.setItem(ALERT_KEY, JSON.stringify(list));
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
    const name = String(x.competitorName || '对手');
    const moves = Array.isArray(x.moves) ? (x.moves as unknown[]).map(String).filter(Boolean) : [];
    title = name + ' 有新动作';
    body = moves.length ? moves.join('；') : '雷达检测到该竞品有新动态，去工作台查看。';
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

export function alertsPush(a: { type: string; title: string; body?: string }): void {
  const list = load();
  list.unshift({
    id: 'al_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    ts: Date.now(),
    read: false,
    ...a,
  });
  if (list.length > MAX_ALERTS) list.length = MAX_ALERTS;
  persist(list);
}

/** 合并服务端提醒（按 id 去重，已读态以本地为准——旧版同语义）。返回本次合并的服务端 id 集 */
export function alertsMergeServer(raw: unknown[]): { merged: number; serverIds: string[] } {
  if (!Array.isArray(raw) || !raw.length) return { merged: 0, serverIds: [] };
  const list = load();
  const ids = new Set(list.map((x) => x.id));
  let merged = 0;
  const serverIds: string[] = [];
  for (const item of raw.slice().reverse()) {
    const a = normalizeServerAlert((item || {}) as Record<string, unknown>);
    if (!a.id) continue;
    serverIds.push(a.id);
    if (ids.has(a.id)) continue;
    list.unshift(a);
    ids.add(a.id);
    merged++;
  }
  if (list.length > MAX_ALERTS) list.length = MAX_ALERTS;
  persist(list);
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
    return () => window.removeEventListener('storage', onStorage);
  }, [refresh]);
  const unread = alerts.filter((x) => !x.read).length;
  return { alerts, unread, refresh };
}
