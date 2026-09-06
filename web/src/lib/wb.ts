'use client';
// 工作台材料流工具（移植 app.js L1457-1617 的 wb* 系列，行为逐项对应）
// 三动作裁决：localStorage 即时展示 + POST /api/material-action 服务端落盘（跨设备还原）。
// 绝不替用户决定，不收集用户私有数据。
import { useEffect, useState } from 'react';
import { apiPost, getToken } from '@/lib/api';
import { isDemoMode } from '@/lib/demo';

export const WB_KEY = 'ci_workbench_decisions'; // 与旧前端同键：已有裁决无缝继承
export const WB_ACTIONS: Record<string, string> = { keep: '收了', ignore: '忽略', later: '稍后' };
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

export function wbLoad(): WbDecisions {
  try {
    return JSON.parse(localStorage.getItem(WB_KEY) || '{}') as WbDecisions;
  } catch {
    return {};
  }
}

export function wbSave(d: WbDecisions): void {
  localStorage.setItem(WB_KEY, JSON.stringify(d));
}

// ---- 服务端持久化（POST /api/material-action） ----
// fire-and-forget：失败静默（localStorage 仍是本设备真相，下次操作会再同步）；
// 演示模式（demo-token）跳过——后端无此会话，401 会误杀演示态。
function wbSyncServer(matId: string, action: WbAction | ''): void {
  if (isDemoMode() || getToken() === 'demo-token') return;
  apiPost('/api/material-action', { id: matId, action: action || '' }).catch(() => {
    /* 网络失败静默：本地已生效，跨设备同步下次操作补齐 */
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
 * 策略：本地为空且服务端非空才回填——本地已有记录时以本地为准
 * （本设备是最近操作的真相源，避免服务端陈旧值复活已撤销的裁决）。
 * 幂等：由 use-zhibi-state 在每次拉到 state 后调用。
 */
export function wbHydrateFromServer(decisions: unknown): void {
  try {
    if (!decisions || typeof decisions !== 'object') return;
    const local = wbLoad();
    if (Object.keys(local).length) return; // 本地非空：不回填
    const ok: WbDecisions = {};
    for (const [k, v] of Object.entries(decisions as Record<string, unknown>)) {
      if (v === 'keep' || v === 'later' || v === 'ignore') ok[k] = v;
    }
    if (Object.keys(ok).length) {
      wbSave(ok);
      fireWbChanged(); // 通知已挂载的 useWbDecisions / 徽章刷新
    }
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
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(WB_CHANGED_EVENT, onWbChanged);
    };
  }, []);
  const set = (matId: string, action: WbAction | '') => {
    // 服务端同步（撤销也同步：action='' 后端删除该条）
    wbSyncServer(matId, action);
    setDecisions((prev) => {
      const d = { ...prev };
      if (!action || d[matId] === action) delete d[matId]; // 再点取消（对齐 wbSet）
      else d[matId] = action;
      wbSave(d);
      return d;
    });
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
  if (t.includes('down')) return '跟价 · 降价';
  if (t.includes('up')) return '跟价 · 涨价';
  if (t.includes('launch')) return '上新';
  if (t.includes('channel')) return '新渠道';
  if (t.includes('crisis')) return '口碑 · 差评暴涨';
  if (t.includes('price')) return '跟价';
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
