'use client';
// 工作台材料流工具（移植 app.js L1457-1617 的 wb* 系列，行为逐项对应）
// 三动作裁决：localStorage 即时展示 + POST /api/material-action 服务端落盘（跨设备还原）。
// 绝不替用户决定，不收集用户私有数据。
import { useEffect, useState } from 'react';
import { apiGet, apiPost, getToken } from '@/lib/api';
import { isDemoMode } from '@/lib/demo';
import { captureSession, isSessionCurrent, SESSION_CHANGED_EVENT, type BrowserSession } from '@/lib/storage-scope';

export const WB_KEY = 'ci_workbench_decisions'; // 无归属旧键保留，不自动归给当前账号。
export const WB_ACTIONS: Record<string, string> = { keep: '收录', ignore: '忽略', later: '稍后' };
export type WbAction = 'keep' | 'later' | 'ignore';

export interface WbMaterial {
  id: string;
  type?: string;
  signal?: string;
  summary?: string;
  title?: string;
  body?: string;
  capturedAt?: string | number;
  at?: string | number;
  brand?: { name?: string; url?: string };
  brandUrl?: string;
  subjectId?: string;
  price?: {
    old?: number | null;
    new?: number | null;
    currency?: string;
    deltaPct?: number | null;
    range?: { min: number; max: number };
  };
  sources?: ({ url?: string; label?: string; tier?: number } | string)[];
  inference?: { text?: string; why?: string };
  missingFields?: string[];
  evidenceTier?: string;
  basis?: string;
  [k: string]: unknown;
}

export interface WbDecisions {
  [matId: string]: WbAction;
}

const projects = new Map<string, string>();
const projectGenerations = new Map<string, number>();
interface WorkbenchContext { session: BrowserSession; projectId: string | null; generation: number }
export function captureWorkbench(): WorkbenchContext {
  const session = captureSession();
  return { session, projectId: session.scope ? projects.get(session.scope) || null : null, generation: session.scope ? projectGenerations.get(session.scope) || 0 : 0 };
}
function contextCurrent(context: WorkbenchContext): boolean {
  return isSessionCurrent(context.session) && !!context.session.scope && !!context.projectId && projects.get(context.session.scope) === context.projectId && (projectGenerations.get(context.session.scope) || 0) === context.generation;
}
function decisionKey(context: WorkbenchContext): string { return WB_KEY + ':' + context.session.scope + ':project:' + encodeURIComponent(context.projectId || ''); }
export function wbLoad(context = captureWorkbench()): WbDecisions {
  try {
    if (!contextCurrent(context)) return {};
    return JSON.parse(localStorage.getItem(decisionKey(context)) || '{}') as WbDecisions;
  } catch {
    return {};
  }
}

export function wbSave(d: WbDecisions, context = captureWorkbench()): void {
  try {
    if (!contextCurrent(context)) return;
    localStorage.setItem(decisionKey(context), JSON.stringify(d));
  } catch {
    /* 隐私模式等 localStorage 不可用：静默（本会话内存态仍可用） */
  }
}

// ---- 服务端持久化（POST /api/material-action） ----
// 同项目串行提交；本地只保留待提交的即时视图，完成或失败后从权威 REST 对账。
// 对账读取失败时保留账号/项目隔离缓存，后续统一状态刷新可继续恢复。
// 演示模式（demo-token）跳过——后端无此会话，401 会误杀演示态。
interface PendingDecision { matId: string; action: WbAction | ''; context: WorkbenchContext }
const serverDecisions = new Map<string, WbDecisions>();
const writes = new Map<string, { tail: Promise<unknown>; revision: number; pending: PendingDecision[] }>();
export const WB_MUTATION_EVENT = 'wb-mutation-invalidated';
function invalidateWorkbenchReads(): void {
  try { window.dispatchEvent(new Event(WB_MUTATION_EVENT)); } catch { /* SSR/no browser */ }
}
function projectDecisions(decisions: unknown, context: WorkbenchContext): void {
  const key = decisionKey(context);
  const clean: WbDecisions = {};
  for (const [id, value] of Object.entries(decisions && typeof decisions === 'object' ? decisions : {})) {
    if (id !== '__proto__' && id !== 'constructor' && id !== 'prototype' && (value === 'keep' || value === 'ignore' || value === 'later')) clean[id] = value;
  }
  serverDecisions.set(key, clean);
  const view = { ...clean };
  for (const item of writes.get(key)?.pending || []) {
    if (!contextCurrent(item.context)) continue;
    if (item.action) view[item.matId] = item.action;
    else delete view[item.matId];
  }
  wbSave(view, context);
  fireWbChanged();
}
function wbSyncServer(matId: string, action: WbAction | '', context: WorkbenchContext): void {
  if (!contextCurrent(context)) return;
  if (isDemoMode() || getToken() === 'demo-token') return;
  const key = decisionKey(context);
  let queue = writes.get(key);
  if (!queue) { queue = { tail: Promise.resolve(), revision: 0, pending: [] }; writes.set(key, queue); }
  const currentQueue = queue;
  const item = { matId, action, context };
  queue.pending.push(item);
  queue.revision++;
  // Also invalidate the Provider's REST reads, not only this module's reconciliation read.
  invalidateWorkbenchReads();
  queue.tail = queue.tail.catch(() => {}).then(async () => {
    try {
      // Do not dispatch an old project's queued action after leaving/re-entering it.
      if (!contextCurrent(context)) return;
      const response = await apiPost<{ decisions?: unknown; projectId?: string }>('/api/material-action', { id: matId, action, projectId: context.projectId });
      if (contextCurrent(context) && (!response.projectId || response.projectId === context.projectId)) {
        projectDecisions(response.decisions, context);
      }
    } catch { /* The final authoritative read below reconciles failed writes too. */ }
    finally {
      currentQueue.pending = currentQueue.pending.filter(pending => pending !== item);
      if (contextCurrent(context)) {
        // Invalidate reads begun while this write was pending before dropping its overlay.
        invalidateWorkbenchReads();
        projectDecisions(serverDecisions.get(key) || {}, context);
        if (!currentQueue.pending.length) {
          const revision = currentQueue.revision;
          try {
            const state = await apiGet<{ projectId?: string; decisions?: unknown }>('/api/state');
            if (contextCurrent(context) && revision === currentQueue.revision && state.projectId === context.projectId) projectDecisions(state.decisions, context);
          } catch { /* Cached view remains scoped; a later state refresh can reconcile. */ }
        }
        if (contextCurrent(context)) invalidateWorkbenchReads();
      }
    }
  });
}

// 水合/外部写入后的同标签页广播（storage 事件只在跨标签页触发，同页需自定义事件）
export const WB_CHANGED_EVENT = 'wb-decisions-changed';
function fireWbChanged(): void {
  try {
    window.dispatchEvent(new Event(WB_CHANGED_EVENT));
  } catch {
    /* 极旧浏览器静默 */
  }
}

/**
 * 从服务端 state.decisions 水合本地（换设备 / 清缓存后还原裁决）。
 * 服务端为权威；项目切换时选择独立缓存，不复用另一项目的材料决策。
 * 幂等：由 use-zhibi-state 在每次拉到 state 后调用。
 */
export function wbHydrateFromServer(decisions: unknown, projectId?: string | null, session = captureSession()): void {
  try {
    if (!isSessionCurrent(session) || !session.scope) return;
    if ((projects.get(session.scope) || null) !== (projectId || null)) projectGenerations.set(session.scope, (projectGenerations.get(session.scope) || 0) + 1);
    if (projectId) projects.set(session.scope, projectId); else projects.delete(session.scope);
    const context = captureWorkbench();
    projectDecisions(decisions, context);
  } catch {
    /* 坏数据静默 */
  }
}

// React 版：订阅式读取（决策变化触发重渲染，替代旧版手动 renderWorkbench）
export function useWbDecisions(): [WbDecisions, (matId: string, action: WbAction | '') => void] {
  const [decisions, setDecisions] = useState<WbDecisions>({});
  useEffect(() => {
    setDecisions(wbLoad());
    const onStorage = () => setDecisions(wbLoad());
    const onWbChanged = () => setDecisions(wbLoad()); // 同标签页水合/外部写入
    window.addEventListener('storage', onStorage);
    window.addEventListener(WB_CHANGED_EVENT, onWbChanged);
    window.addEventListener(SESSION_CHANGED_EVENT, onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(WB_CHANGED_EVENT, onWbChanged);
      window.removeEventListener(SESSION_CHANGED_EVENT, onStorage);
    };
  }, []);
  const set = (matId: string, action: WbAction | '') => {
    const context = captureWorkbench();
    if (!contextCurrent(context)) return;
    const d = { ...wbLoad(context) };
    if (!action || d[matId] === action) delete d[matId];
    else d[matId] = action;
    // Persist outside React's updater: no deferred writes can pick up a new account/project.
    wbSave(d, context);
    setDecisions(d);
    fireWbChanged();
    wbSyncServer(matId, d[matId] || '', context);
  };
  return [decisions, set];
}

// ---- U4 归一化（移植 L1510-1535） ----
export function wbSignalOf(m: WbMaterial): 'down' | 'up' | 'crisis' | 'new' | 'price' {
  const t = (m.type || '').toLowerCase();
  if (t.includes('down') || m.signal === 'down') return 'down';
  if (t.includes('up') || m.signal === 'up') return 'up';
  if (t.includes('crisis') || m.signal === 'crisis') return 'crisis';
  if (t.includes('launch') || t.includes('new') || m.signal === 'new') return 'new';
  if (t.includes('price') || m.signal === 'price') return 'price';
  return 'new';
}

export function wbTypeLabel(m: WbMaterial): string {
  const t = (m.type || '').toLowerCase();
  // r4 §三：观察/变化材料使用中性标题（「价格观察」不预判涨跌）
  if (t === 'price-observation') return '价格观察';
  if (t === 'price-change') return '价格变化';
  if (t.includes('down')) return '跟价 · 降价';
  if (t.includes('up')) return '跟价 · 涨价';
  if (t.includes('launch')) return '上新';
  if (t.includes('channel')) return '新渠道';
  if (t.includes('crisis')) return '口碑 · 差评暴涨';
  if (t.includes('price')) return '价格观察';
  return (m.typeLabel as string) || m.type || '信号';
}

export function wbTypeGroup(m: WbMaterial): string {
  const t = (m.type || '').toLowerCase();
  const s = m.signal || '';
  if (t.includes('down') || t.includes('up') || t.includes('price') || s === 'down' || s === 'up') return 'down';
  if (t.includes('channel')) return 'channel';
  if (t.includes('crisis') || t.includes('review')) return 'crisis';
  return 'new';
}

export function wbEvidence(m: WbMaterial): { cls: string; txt: string } {
  const tier =
    m.evidenceTier || (m.basis === 'verified' ? 'verified' : m.basis === 'inferred' ? 'inferred' : 'unknown');
  return {
    cls: tier === 'verified' ? 'ev-ok' : tier === 'inferred' ? 'ev-warn' : 'ev-unk',
    txt: tier === 'verified' ? '已核实' : tier === 'inferred' ? '推算' : '未探测',
  };
}

export function wbMoney(v: number, cur: string): string {
  const sym = ({ GBP: '£', USD: '$', CNY: '¥', EUR: '€' } as Record<string, string>)[cur] || cur + ' ';
  return sym + Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function wbBrandName(m: WbMaterial): string {
  if (m.brand && m.brand.name) return m.brand.name;
  const sid = String(m.subjectId || '');
  if (sid.startsWith('brand:')) return sid.slice(6);
  return m.brandUrl || sid || '未知品牌';
}

export function wbBrandUrl(m: WbMaterial): string {
  return (m.brand && m.brand.url) || m.brandUrl || '';
}

export function wbWhen(m: WbMaterial): string {
  const t = m.capturedAt || m.at;
  if (!t) return '';
  try {
    const mins = Math.max(1, Math.round((Date.now() - new Date(t).getTime()) / 60000));
    if (mins < 60) return mins + ' 分钟前';
    const h = Math.round(mins / 60);
    if (h < 24) return h + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  } catch {
    return '';
  }
}

// 按天分组（移植 renderWorkbench L1640-1648：今天/昨天/更早）
export type DayGroups = { label: string; list: WbMaterial[] }[];

export function wbDayGroups(ms: WbMaterial[]): DayGroups {
  const sorted = ms
    .slice()
    .sort((a, b) => new Date(b.capturedAt || b.at || 0).getTime() - new Date(a.capturedAt || a.at || 0).getTime());
  const groups: { 'TODAY · 今天': WbMaterial[]; 'YESTERDAY · 昨天': WbMaterial[]; 'EARLIER · 更早': WbMaterial[] } = {
    'TODAY · 今天': [],
    'YESTERDAY · 昨天': [],
    'EARLIER · 更早': [],
  };
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  for (const m of sorted) {
    const t = new Date(m.capturedAt || m.at || 0).getTime();
    if (!t) {
      groups['EARLIER · 更早'].push(m);
      continue;
    }
    if (t >= dayStart.getTime()) groups['TODAY · 今天'].push(m);
    else if (t >= dayStart.getTime() - 86400000) groups['YESTERDAY · 昨天'].push(m);
    else groups['EARLIER · 更早'].push(m);
  }
  return (Object.entries(groups) as [keyof typeof groups, WbMaterial[]][])
    .filter(([, list]) => list.length)
    .map(([label, list]) => ({ label, list }));
}
