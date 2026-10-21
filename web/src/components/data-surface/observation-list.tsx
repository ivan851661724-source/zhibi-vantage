'use client';
// Observation 列表（单维详情分页；数据全部来自后端真实采集，无任何前端构造数量）
// 2026-10-18 复审整改：分页契约为「每个 capability 独立分页」——顶层 observations/
// pagination 即当前 active capability 的当前页（≤ limit）；多 capability 时各块
// 带独立 pagination。币种可追溯渲染 + 请求序号/取消防护 + 本地时区。
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet } from '@/lib/api';
import type { DimensionDetail, DimensionCapabilityDetail, SurfaceObservation, SurfaceSummary } from './types';

const CUR_SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', CNY: '¥', EUR: '€', JPY: '¥' };
function curLabel(cur: string | null): string {
  if (!cur) return '';
  return CUR_SYMBOLS[cur] || cur;
}
function localDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function ObsRow({ o, dimension }: { o: SurfaceObservation; dimension: string }) {
  const day = (iso: string | null) => (iso ? localDay(iso) : '');
  if (dimension === 'social_content') {
    return (
      <li className="ds-obs-item">
        <span className="nm" title={o.title}>{o.title}</span>
        <span className="val">
          {o.publishedAt ? <span className="ds-obs-pub">{day(o.publishedAt)} 发布</span> : null}
          {o.viewCount != null ? <> · 播放 <b className="num">{o.viewCount}</b></> : null}
          {o.likeCount != null ? <> · 赞 <b className="num">{o.likeCount}</b></> : null}
          {o.commentCount != null ? <> · 评论 <b className="num">{o.commentCount}</b></> : null}
          {o.videoUrl ? <a className="ds-obs-link" href={o.videoUrl} target="_blank" rel="noreferrer noopener">来源 ↗</a> : null}
          <span className="ds-mm-tag">公开来源观察</span>
        </span>
      </li>
    );
  }
  if (dimension === 'search_interest') {
    return (
      <li className="ds-obs-item">
        <span className="nm" title={o.title}>{o.title}</span>
        <span className="val">
          {o.periodStart && o.periodEnd ? <span className="ds-obs-pub">{o.periodStart} ~ {o.periodEnd}</span> : null}
          {o.value != null ? <> · 指数 <b className="num">{o.value}</b></> : null}
          {o.region ? <> · {o.region}</> : null}
          <span className="ds-mm-tag">数据服务估算</span>
        </span>
      </li>
    );
  }
  if (dimension === 'ad_campaigns') {
    const reachLabel = (o as { reach?: string | number | null }).reach;
    const lastShown = (o as { lastShownDate?: string | null }).lastShownDate;
    // R4.15：每个字段独立 span（.val 是 flex + gap）——不再用裸文本「 · 」拼接：
    // 裸文本节点在 flex 里会被拆行，截图里出现只有「·」的空行（看起来像空字段）。
    // 同时：status_statement 缺失时不渲染任何占位节点。
    return (
      <li className="ds-obs-item">
        <span className="nm" title={o.title}>{o.title}</span>
        <span className="val">
          {o.publishedAt ? <span className="ds-obs-pub">{o.publishedAt} 起投</span> : null}
          {lastShown ? <span className="ds-obs-pub">至 {lastShown}</span> : null}
          {o.advertiser ? <span className="ds-obs-pub">{o.advertiser}</span> : null}
          {reachLabel ? <span className="ds-obs-pub">公开触达 {reachLabel}</span> : null}
          {o.statusStatement ? <span className="ds-obs-snippet" title={o.statusStatement}>{o.statusStatement}</span> : null}
          {o.creativeUrl ? <a className="ds-obs-link" href={o.creativeUrl} target="_blank" rel="noreferrer noopener">素材 ↗</a> : null}
          <span className="ds-mm-tag" title="平台公开披露：TikTok Commercial Content API 官方公开数据">平台公开披露</span>
        </span>
      </li>
    );
  }
  if (dimension === 'reviews_reputation') {
    return (
      <li className="ds-obs-item">
        <span className="nm" title={o.title}>{o.title}</span>
        <span className="val">
          {o.rating != null ? <> · 评分 <b className="num">{o.rating}</b></> : null}
          {o.reviewCount != null ? <> · {o.reviewCount} 条评论</> : null}
          {o.snippet ? <span className="ds-obs-snippet">{o.snippet}</span> : null}
          {o.sourceUrl ? <a className="ds-obs-link" href={o.sourceUrl} target="_blank" rel="noreferrer noopener">来源 ↗</a> : null}
          <span className="ds-mm-tag">公开来源观察</span>
        </span>
      </li>
    );
  }
  return (
    <li className="ds-obs-item">
      <span className="nm" title={o.title}>{o.title}</span>
      <span className="val">
        {o.price != null ? (
          o.currency
            ? <span className="num">{curLabel(o.currency)}{o.price}</span>
            : <span className="num">{o.price}（币种待确认）</span>
        ) : <span className="ds-obs-noprice">价格未取到</span>}
        {!o.available ? <span className="ds-obs-soldout">断货</span> : null}
        {o.publishedAt ? <span className="ds-obs-pub">{localDay(o.publishedAt)} 上架</span> : null}
      </span>
    </li>
  );
}

/** 明细摘要（判别联合：collections 无商品观察，显示集合口径） */
function DetailSummary({ summary }: { summary: SurfaceSummary | null }) {
  if (!summary) return null;
  if (summary.kind === 'storefront_catalog') {
    const s = summary as Extract<SurfaceSummary, { kind: 'storefront_catalog' }>;
    return (
      <div className="ds-obs-sum">
        共 {s.count} 款 · 在售 {s.onSaleCount}
        {s.soldOutCount ? ` · 断货 ${s.soldOutCount}` : ''}
        {s.priceMedian != null ? (
          s.currencyStatus === 'confirmed'
            ? ` · 在售价格中位 ${curLabel(s.currency)}${s.priceMedian}（目录统计，非单品价格变化）`
            : ` · 在售价格中位 ${s.priceMedian}（币种待确认；目录统计，非单品价格变化）`
        ) : ''}
        {s.partialScan ? ' · 部分覆盖' : ''}
      </div>
    );
  }
  if (summary.kind === 'storefront_collections') {
    const s = summary as Extract<SurfaceSummary, { kind: 'storefront_collections' }>;
    return <div className="ds-obs-sum">共 {s.collectionCount} 个商品集合{s.partialScan ? '（部分覆盖）' : ''}</div>;
  }
  return null;
}

export function ObservationList({ competitorId, projectId, dimension }: { competitorId: string; projectId?: string; dimension: string }) {
  const [detail, setDetail] = useState<DimensionDetail | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const limit = 20;

  const load = useCallback((off: number) => {
    const seq = ++seqRef.current;
    if (abortRef.current) { try { abortRef.current.abort(); } catch (e) { /* 已结束 */ } }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    setErr(null);
    const pidQ = projectId ? '&projectId=' + encodeURIComponent(projectId) : '';
    apiGet<DimensionDetail>(
      `/api/data-surface/dimension?competitorId=${encodeURIComponent(competitorId)}${pidQ}&dimension=${encodeURIComponent(dimension)}&offset=${off}&limit=${limit}`,
      ctrl.signal,
    )
      .then((d) => { if (seq === seqRef.current) { setDetail(d); setLoading(false); } })
      .catch((e) => {
        if (e && e.name === 'AbortError') return;
        if (seq === seqRef.current) { setErr(e instanceof Error ? e.message : String(e)); setLoading(false); }
      });
  }, [competitorId, projectId, dimension]);

  useEffect(() => { load(offset); return () => { if (abortRef.current) { try { abortRef.current.abort(); } catch (e) {} } }; }, [load, offset]);

  if (loading && !detail) return <p className="hint">加载明细…</p>;
  if (err) return <p className="hint">明细加载失败：{err}</p>;
  // 当前 active capability 的当前页（契约：≤ limit）
  const activeCode = detail && detail.activeCapability;
  const active: DimensionCapabilityDetail | undefined = (detail && detail.capabilities || []).find(c => c.capabilityCode === activeCode);
  const page = (active && active.observations) || (detail ? detail.observations : []);
  if (!detail || !page.length) {
    return <p className="hint">暂无采集明细{detail && detail.collectedAt ? '（最近采集 ' + localDay(detail.collectedAt) + '）' : ''}。</p>;
  }
  const pg = detail.pagination;
  return (
    <div className="ds-obs">
      <DetailSummary summary={active ? active.summary : detail.summary} />
      {active && active.latestAttempt && active.latestAttempt.status === 'failed' && active.attemptId ? (
        <p className="ds-obs-failnote">最近一次更新失败，以上为上次成功数据。</p>
      ) : null}
      {active && active.interrupted ? <p className="ds-obs-failnote">上次采集被中断，可重新刷新。</p> : null}
      <ul className="ds-obs-list">
        {page.map((o: SurfaceObservation, i: number) => (
          <ObsRow key={(o.id || '') + i} o={o} dimension={dimension} />
        ))}
      </ul>

      <div className="ds-obs-pager">
        <button className="btn-mini" type="button" disabled={pg.offset <= 0 || loading} onClick={() => setOffset(Math.max(0, pg.offset - limit))}>上一页</button>
        <span className="hint">{pg.offset + 1}–{Math.min(pg.offset + pg.limit, pg.total)} / {pg.total}</span>
        <button className="btn-mini" type="button" disabled={!pg.hasMore || loading} onClick={() => setOffset(pg.offset + limit)}>下一页</button>
      </div>
    </div>
  );
}
