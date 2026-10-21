'use client';
// 维度卡片（状态 + 新鲜度 + 摘要 + Coverage 缺口 + Evidence 引用 + 可用操作）
// 2026-10-18 整改轮：
//   · 币种可追溯：confirmed 显示符号/代码；unknown 显示「币种待确认」（不裸显示数字区间）
//   · 缺口全量渲染：stale / partial / latest_failure / interrupted 同屏不互吞
//   · 刷新中继续展示旧数据（latestUsable）+ 明确「更新中」
//   · 同维度多能力聚合块各循其类（判别联合摘要）
import { useState } from 'react';
import { SurfaceStateBadge, FreshnessBadge } from './surface-state';
import { ObservationList } from './observation-list';
import type { SurfaceDimension, SurfaceEvidenceRef, SurfaceSummary, SurfaceGap } from './types';

const CUR_SYMBOLS: Record<string, string> = { GBP: '£', USD: '$', CNY: '¥', EUR: '€', JPY: '¥' };
function curLabel(cur: string | null): string {
  if (!cur) return '';
  return CUR_SYMBOLS[cur] || cur;
}
// 用户本地时区时间（04 §11：准确可读）
function localTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** 摘要渲染（判别联合）：每种 kind 只渲染自己确实拥有的字段 */
function SummaryView({ summary }: { summary: SurfaceSummary }) {
  if (summary.kind === 'storefront_catalog') {
    const s = summary as Extract<SurfaceSummary, { kind: 'storefront_catalog' }>;
    const hasRange = s.priceMin != null && s.priceMax != null;
    return (
      <div className="ds-card-sum">
        共 <b className="num">{s.count}</b> 款 · 在售 <b className="num">{s.onSaleCount}</b> 款
        {s.soldOutCount ? <> · 断货 <b className="num">{s.soldOutCount}</b> 款</> : null}
        {hasRange ? (
          s.currencyStatus === 'confirmed' ? (
            <> · 在售价格 {curLabel(s.currency)}<b className="num">{s.priceMin}</b>–<b className="num">{s.priceMax}</b></>
          ) : (
            <> · 在售价格 <b className="num">{s.priceMin}</b>–<b className="num">{s.priceMax}</b>（币种待确认）</>
          )
        ) : null}
      </div>
    );
  }
  if (summary.kind === 'storefront_collections') {
    const s = summary as Extract<SurfaceSummary, { kind: 'storefront_collections' }>;
    return (
      <div className="ds-card-sum">
        共 <b className="num">{s.collectionCount}</b> 个商品集合
        {s.collections && s.collections.length ? (
          <> · {s.collections.slice(0, 3).map(c => c.title).join(' / ')}{s.collections.length > 3 ? ' …' : ''}</>
        ) : null}
      </div>
    );
  }
  // ---------- Wave 1：四个新维度各自的摘要形状（不复用 Shopify 价格卡模板） ----------
  if (summary.kind === 'social_videos') {
    const s = summary as Extract<SurfaceSummary, { kind: 'social_videos' }>;
    return (
      <div className="ds-card-sum">
        公开视频 <b className="num">{s.videoCount}</b> 个
        {s.channelTitle ? <> · 频道 {s.channelTitle}</> : null}
        {s.periodStart && s.periodEnd ? <> · 期间 {s.periodStart} ~ {s.periodEnd}</> : null}
        <span className="ds-mm-tag" title="公开来源观察：YouTube Data API 实际返回的公开字段">公开来源观察</span>
        {s.matchReasons && s.matchReasons.length ? <span className="ds-mm-note">归属依据：{s.matchReasons.join('；')}</span> : null}
      </div>
    );
  }
  if (summary.kind === 'trend_series') {
    const s = summary as Extract<SurfaceSummary, { kind: 'trend_series' }>;
    return (
      <div className="ds-card-sum">
        趋势点 <b className="num">{s.pointCount}</b> 个
        {s.keyword ? <> · 关键词 {s.keyword}</> : null}
        {s.region ? <> · 地区 {s.region}</> : null}
        {s.periodStart && s.periodEnd ? <> · 期间 {s.periodStart} ~ {s.periodEnd}</> : null}
        <span className="ds-mm-tag" title="数据服务估算：非平台原始事实">数据服务估算</span>
      </div>
    );
  }
  if (summary.kind === 'ad_creatives') {
    const s = summary as Extract<SurfaceSummary, { kind: 'ad_creatives' }>;
    // 覆盖国家数只能来自后端唯一事实源（summary.coverageCountryCount），前端不写死数字
    const cc = s.coverageCountryCount;
    const scopeText = cc != null
      ? `覆盖范围受 TikTok 官方支持国家限制（当前 ${cc} 国，不含美国）`
      : '覆盖范围受 TikTok 官方支持国家限制（不含美国）';
    const ooc = s.coverageState === 'out_of_coverage';
    return (
      <div className="ds-card-sum">
        {ooc ? (
          <>该维度在品牌主要市场（{s.brandMarket || '未知'}）无公开来源覆盖</>
        ) : s.creativeCount > 0 ? (
          <>公开广告素材 <b className="num">{s.creativeCount}</b> 条</>
        ) : (
          <>官方覆盖范围内本轮未观察到结果</>
        )}
        <span className="ds-mm-tag" title="平台公开披露：TikTok Commercial Content API 官方公开数据">平台公开披露</span>
        {ooc ? (
          <span className="ds-mm-note ds-mm-warn">
            该公开来源当前无覆盖：TikTok 官方支持国家不含 {s.brandMarket || '该市场'}；零结果不代表该市场没有广告
          </span>
        ) : null}
        {s.periodStart && s.periodEnd ? <> · 投放窗口 {s.periodStart} ~ {s.periodEnd}</> : null}
        <span className="ds-mm-note">{scopeText}；未覆盖国家不代表没有广告</span>
        <span className="ds-mm-note">广告花费 / 获客成本 / ROI / 转化率 / GMV 当前公开来源无法直接观测</span>
      </div>
    );
  }
  if (summary.kind === 'reviews_digest') {
    const s = summary as Extract<SurfaceSummary, { kind: 'reviews_digest' }>;
    return (
      <div className="ds-card-sum">
        评论样本 <b className="num">{s.reviewCount}</b> 条 · 来源页面 <b className="num">{s.sourceCount}</b> 个
        {s.periodStart && s.periodEnd ? <> · 采集范围 {s.periodStart} ~ {s.periodEnd}</> : null}
        <span className="ds-mm-tag" title="公开来源观察：通过 robots 与归属校验的公开页面">公开来源观察</span>
        {s.sampleNote ? <span className="ds-mm-note">{s.sampleNote}</span> : null}
      </div>
    );
  }
  // 未知 kind：诚实降级为通用键值（不假装看得懂，也不编数）
  return (
    <div className="ds-card-sum ds-card-sum-unknown">
      摘要类型暂不支持展示（{String((summary as { kind?: string }).kind || 'unknown')}）
    </div>
  );
}

export function DimensionCard({
  dim, competitorId, projectId, busy, onRefresh, onOpenEvidence,
}: {
  dim: SurfaceDimension;
  competitorId: string;
  projectId?: string;
  busy: boolean;
  onRefresh: (capability: string) => void;
  onOpenEvidence: (refs: SurfaceEvidenceRef[]) => void;
}) {
  const [showObs, setShowObs] = useState(false);
  const blocks = (dim.aggregations && dim.aggregations.length) ? dim.aggregations : [];
  const first = blocks[0] || null;
  const canRefresh = (dim.actions || []).some((a) => a.code === 'refresh');
  const total = (dim.pagination && dim.pagination.total) || 0;
  const gaps: SurfaceGap[] = dim.gaps || [];
  const latestFailure = gaps.find(g => g.code === 'latest_failure');
  const interrupted = gaps.find(g => g.code === 'interrupted');
  // 明细入口：任一能力块有观察且是商品目录维度
  const obsCap = blocks.find(b => (b.pagination && b.pagination.total) || 0 > 0);

  return (
    <div className={'ds-card ds-card-' + dim.surfaceState}>
      <div className="ds-card-head">
        <span className="ds-card-name">{dim.displayName}</span>
        <SurfaceStateBadge state={dim.surfaceState} />
        {dim.isRefreshing ? <span className="ds-refreshing-tag"><span aria-hidden>◐</span> 更新中</span> : null}
      </div>

      {/* 摘要（多能力聚合：各块各循其类；刷新中保留旧数据） */}
      {blocks.map((b) => (b.summary ? (
        <div className="ds-agg-block" key={b.capability.code}>
          {blocks.length > 1 ? <span className="ds-agg-cap">{b.capability.displayName}</span> : null}
          <SummaryView summary={b.summary} />
        </div>
      ) : null))}
      {dim.surfaceState === 'unsupported' && dim.reasonText ? <p className="ds-card-note">{dim.reasonText}</p> : null}
      {/* P0-2 整改 r2：pending_config 用户侧口径「数据服务暂不可用」（reasonText 后端下发） */}
      {dim.surfaceState === 'pending_config' && dim.reasonText ? <p className="ds-card-note ds-note-config">{dim.reasonText}</p> : null}
      {dim.surfaceState === 'empty' ? <p className="ds-card-note">该维度受支持但还未采集过数据，点「刷新数据」开始第一次采集。</p> : null}
      {/* SC-06 r2：能力已实现但尚无真实成功采集的项单列——不混进已采集结果、不显示观察数 */}
      {dim.pendingVerification && dim.pendingVerification.length ? (
        <ul className="ds-gaps">
          {dim.pendingVerification.map(pv => (
            <li key={'pv_' + pv.code}><span aria-hidden>◌</span> {pv.displayName}：{pv.stateText || '待验证（能力已实现，尚未完成真实采集）'}</li>
          ))}
        </ul>
      ) : null}
      {dim.surfaceState === 'loading' ? <p className="ds-card-note">正在采集该维度数据，完成后自动更新（无需重复点击）。</p> : null}

      {/* 最近更新失败 + 旧数据保留（整改 §三.2：失败不吞旧，明确告知） */}
      {latestFailure ? (
        <p className="ds-card-note ds-note-fail">最近更新失败，当前展示上次成功数据（{localTime(dim.lastSuccessAt)}）。可重新刷新。</p>
      ) : null}
      {interrupted ? <p className="ds-card-note ds-note-warn">上次采集被中断（服务重启或任务超时），可重新刷新。</p> : null}

      {dim.freshness && dim.surfaceState !== 'unsupported' ? <FreshnessBadge freshness={dim.freshness} /> : null}

      {/* Coverage 缺口（诚实传播：partial_scan / 过期 / 失败 / 中断 / latest_failure 全量列出） */}
      {gaps.length ? (
        <ul className="ds-gaps">
          {gaps.map((g, i) => <li key={g.code + (g.capability || '') + i}><span aria-hidden>▲</span> {g.text || g.code}</li>)}
        </ul>
      ) : null}

      {/* Evidence 引用（点开抽屉审计；来源链接 = 品牌公开页面） */}
      {dim.evidenceRefs && dim.evidenceRefs.length ? (
        <div className="ds-evids">
          <button className="btn-mini" type="button" onClick={() => onOpenEvidence(dim.evidenceRefs || [])}>
            查看数据依据（{dim.evidenceRefs.length}）
          </button>
        </div>
      ) : null}

      {/* 操作 + 明细 */}
      <div className="ds-card-acts">
        {canRefresh ? (
          <button
            className="btn-mini"
            type="button"
            disabled={busy || dim.surfaceState === 'loading' || dim.isRefreshing}
            onClick={() => onRefresh((dim.actions || []).find((a) => a.code === 'refresh')?.capability || (first ? first.capability.code : ''))}
          >
            {busy ? '刷新中…' : '刷新数据'}
          </button>
        ) : null}
        {obsCap ? (
          <button className="btn-mini" type="button" onClick={() => setShowObs(!showObs)}>
            {showObs ? '收起明细' : `采集明细（${total}）`}
          </button>
        ) : null}
      </div>
      {showObs ? <ObservationList competitorId={competitorId} projectId={projectId} dimension={dim.code} /> : null}
    </div>
  );
}
