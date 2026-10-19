'use client';
// 五维数据覆盖总览（挂载于品牌情报档案内；不新增一级导航、不做视觉重构）
// - 官网与商品：Shopify catalog + collections 双能力真实数据（判别联合摘要）
// - 其余四维：从 Registry/API 读能力状态，显示「暂未接入」，零构造数据
// - loading 轮询（Collection 进度）：任一维度采集中 → 3s 轮询至终态
// 2026-10-18 整改轮：
//   · 切换品牌竞态：AbortController + 请求序号双保险，旧响应不得覆盖新数据
//   · 多身份（同平台多账号）展示
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { toast } from '@/lib/toast';
import { DimensionCard } from './dimension-card';
import { EvidenceDrawer } from './evidence-drawer';
import type { DataSurfaceOverview, SurfaceEvidenceRef, SurfaceIdentity } from './types';

export function DataSurfaceOverview({ competitorId, projectId }: { competitorId: string; projectId?: string }) {
  const [data, setData] = useState<DataSurfaceOverview | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [evRefs, setEvRefs] = useState<SurfaceEvidenceRef[] | null>(null);
  const aliveRef = useRef(true);
  // R4.15：数据面请求必须显式带 projectId——向后端「当前项目」状态兜底在
  // 多项目租户下会解析到别的项目（404 COMPETITOR_NOT_FOUND 或读错品牌）。
  const pidQ = projectId ? '&projectId=' + encodeURIComponent(projectId) : '';
  // 竞态防护①：请求序号——只有最新序号的响应允许写入 state
  const seqRef = useRef(0);
  // 竞态防护②：进行中的 AbortController——切品牌/卸载时取消旧请求
  const abortRef = useRef<AbortController | null>(null);

  const fetchOverview = useCallback(() => {
    const seq = ++seqRef.current;
    if (abortRef.current) { try { abortRef.current.abort(); } catch (e) { /* 已结束 */ } }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return apiGet<DataSurfaceOverview>('/api/data-surface/overview?competitorId=' + encodeURIComponent(competitorId) + pidQ, ctrl.signal)
      .then((d) => {
        if (aliveRef.current && seq === seqRef.current) { setData(d); setLoadErr(null); }
        return d;
      })
      .catch((e) => {
        if (e && e.name === 'AbortError') return null; // 被新请求/卸载取消：静默丢弃
        if (aliveRef.current && seq === seqRef.current) setLoadErr(e instanceof Error ? e.message : String(e));
        return null;
      });
  }, [competitorId, pidQ]);

  useEffect(() => {
    aliveRef.current = true;
    void fetchOverview();
    return () => { aliveRef.current = false; if (abortRef.current) { try { abortRef.current.abort(); } catch (e) {} } };
  }, [fetchOverview]);

  // Collection 进度：任一维度采集中 → 轮询至终态
  useEffect(() => {
    if (!data || !data.dimensions.some((d) => d.surfaceState === 'loading' || d.isRefreshing)) return;
    const t = setTimeout(() => { void fetchOverview(); }, 3000);
    return () => clearTimeout(t);
  }, [data, fetchOverview]);

  async function refresh(capability: string) {
    setBusy(true);
    try {
      const r = await apiPost<{ attempt?: { status?: string }; deduped?: boolean; message?: string }>('/api/data-surface/refresh', {
        competitorId,
        capability: capability || 'shopify_catalog',
        ...(projectId ? { projectId } : {}),
      });
      if (r && r.deduped) toast(r.message || '已有一次相同采集在进行或刚完成，已复用该次结果（不重复产生费用）。');
      else toast('已开始采集，完成后自动更新。');
      await fetchOverview();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (loadErr && !data) return <div className="ds-wrap"><p className="hint">数据面加载失败：{loadErr}</p></div>;
  if (!data) return <div className="ds-wrap"><p className="hint">加载数据面…</p></div>;

  const anyLoading = data.dimensions.some((d) => d.surfaceState === 'loading' || d.isRefreshing);
  // 多账号身份优先读 identities[]；旧结构回落时补 platform 字段，保持同型
  const identities: SurfaceIdentity[] = (data.identities && data.identities.length)
    ? data.identities
    : (data.identity ? [{
      platform: 'shopify', platformAccountId: null,
      officialDomain: data.identity.officialDomain, identityStatus: data.identity.identityStatus,
      originNote: data.identity.originNote, resolverVersion: data.identity.resolverVersion,
      updatedAt: data.identity.updatedAt,
    }] : []);

  return (
    <div className="ds-wrap">
      <div className="ds-head">
        <span className="ds-title">五维数据覆盖</span>
        {identities.length ? (
          <span className="ds-ident">
            {identities.map((idn, i) => (
              <span key={(idn.platformAccountId || idn.platform || '') + i} className="ds-ident-item">
                {idn.officialDomain ? <>{idn.officialDomain}</> : idn.platform}
                {' · '}
                {idn.identityStatus === 'resolved' ? '身份已核实' : '身份待核实'}
              </span>
            ))}
          </span>
        ) : null}
        {anyLoading ? <span className="ds-poll-hint"><span aria-hidden>◐</span> 采集中，完成后自动更新…</span> : null}
      </div>
      <div className="ds-grid">
        {data.dimensions.map((d) => (
          <DimensionCard
            key={d.code}
            dim={d}
            competitorId={competitorId}
            projectId={projectId}
            busy={busy}
            onRefresh={(cap) => void refresh(cap)}
            onOpenEvidence={(refs) => setEvRefs(refs)}
          />
        ))}
      </div>
      {evRefs ? <EvidenceDrawer refs={evRefs} onClose={() => setEvRefs(null)} /> : null}
    </div>
  );
}
