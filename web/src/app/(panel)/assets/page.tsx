'use client';
// 算法资产（Phase 3，复刻 renderAssetsTab L1441-1455 + renderAssetIndex L1322-1374
// + renderSilentDemand L1377-1406 + renderTrendInference L1409-1439
// + collectGapBuckets L1305-1314 + assetRow L1317-1319 + fmtPct L2232
// + renderPainOpportunityTable 的判定口径 L2235-2262）
// 数据源：POST /api/sector（每次 state 变化重算，对齐旧版 onPush → renderAssetsTab L1737）
// + state 的 blueOcean / trendView / opportunity / radar / whiteSpace 派生视图。
// P1-4 纪律：任何渲染异常都不允许留下空白面板——派生计算包 try/catch 兜底空态。
import { useEffect, useMemo, useState } from 'react';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { apiPost } from '@/lib/api';
import { isDemoMode } from '@/lib/demo';
import { DemoPageGuard } from '@/components/demo-page-guard';
import type { ZhibiState } from '@/types/state';

// ---------- 后端 /api/sector 响应（宽松建模，字段逐个收紧） ----------
interface GapItem {
  dim?: string;
  key?: string;
  demandEvidence?: string;
  gapNote?: string;
  crossAxis?: string;
  [k: string]: unknown;
}
interface TrendItem {
  claim?: string;
  note?: string;
  basis?: string;
  confidence?: string;
  checkpoint?: { test?: string; horizonDays?: number } | null;
  [k: string]: unknown;
}
interface SectorResp {
  brandCount?: number;
  sector?: {
    concentration?: { HHI?: number; hhiInterpretation?: string; CR3?: number; CR5?: number };
    priceBands?: { count?: number }[];
    channelMatrix?: { rows?: { brands?: unknown[] }[] };
  };
  whitespace?: { whitespace?: GapItem[]; gaps?: GapItem[] };
  trend?: TrendItem[] | { items?: TrendItem[] };
}

// ---------- state 侧派生视图的字段（blueOcean / trendView / opportunity / radar） ----------
interface Comp {
  id: string;
  name: string;
  status?: string;
  painPoints?: { point?: string; basis?: string }[];
  reviewField?: { negThemes?: { items?: { text?: string; state?: string; basis?: string }[] } } | null;
  reviews?: { negThemes?: string[] } | null;
  heroProduct?: { heroProducts?: unknown[] } | null;
  [k: string]: unknown;
}
interface BlueOcean {
  dimensions?: Record<string, { buckets?: GapItem[] }>;
  silentDemandHint?: boolean;
  silentDemandNote?: string;
}
interface TrendView {
  label?: string;
  hotScore?: number;
  failSafe?: boolean;
  note?: string;
  total?: number;
  withSignal?: number;
  distribution?: { rising?: number; stable?: number; declining?: number; unknown?: number };
  checkpoint?: { falsifiable?: boolean; test?: string; horizonDays?: number } | null;
}
interface Opportunity {
  hidden?: boolean;
  total?: number;
  reason?: string;
  brandsWithVoice?: number;
  doneBrands?: number;
  zones?: { underserved?: number };
}

function fmtPct(v: number | null | undefined): string {
  if (v == null) return '—';
  return Math.round(v * 100) + '%';
}

// 复刻 collectGapBuckets：按 gapKind 收集蓝海维度里的空白桶
function collectGapBuckets(bo: BlueOcean | undefined, kind: string): GapItem[] {
  const out: GapItem[] = [];
  const dims = (bo && bo.dimensions) || {};
  Object.keys(dims).forEach((dk) => {
    ((dims[dk] && dims[dk].buckets) || []).forEach((b) => {
      if (b.gapKind === kind) out.push({ dim: dk, key: b.key, demandEvidence: b.demandEvidence, gapNote: b.gapNote, crossAxis: b.crossAxis });
    });
  });
  return out;
}

// 复刻 renderPainOpportunityTable 的判定口径（旧版在资产总览里只用其真值）
function hasPainOpportunity(cs: Comp[]): boolean {
  const map: Record<string, unknown> = {};
  cs.forEach((c) => {
    const pains: { text?: string; basis?: string }[] = [];
    (c.painPoints || []).forEach((p) => pains.push({ text: p.point, basis: p.basis || 'inferred' }));
    if (c.reviewField && c.reviewField.negThemes && c.reviewField.negThemes.items) {
      c.reviewField.negThemes.items.forEach((i) => {
        if (i.state !== 'conflict') pains.push({ text: i.text, basis: i.basis || 'inferred' });
      });
    }
    (c.reviews && c.reviews.negThemes)?.forEach((t) => pains.push({ text: t, basis: 'inferred' }));
    pains.forEach((p) => {
      const key = (p.text || '').trim().toLowerCase();
      if (key) map[key] = true;
    });
  });
  return Object.keys(map).length > 0;
}

// 单条资产行（复刻 assetRow：名称 / 状态 / 一句话发现 / 覆盖）
interface AssetRowData {
  name: string;
  status: string;
  cls: string;
  finding: string;
  coverage: string;
}

function buildRows(state: ZhibiState, r: SectorResp | null): AssetRowData[] {
  const sec = (r && r.sector) || {};
  const conc = sec.concentration || {};
  const excluded = new Set((state.excluded as string[]) || []);
  const cs = ((state.competitors || []) as Comp[]).filter((c) => !excluded.has(c.id) && c.status === 'done');
  const bo = (state.blueOcean as BlueOcean) || {};
  const ws = state.whiteSpace || {};
  const radar = (state.radar as { groupSignals?: unknown[] }) || {};
  const tv = (state.trendView as TrendView) || {};
  const opp = (state.opportunity as Opportunity) || {};

  const secPriceBands = sec.priceBands || [];
  const gapsEmpty = secPriceBands.filter((g) => (g.count || 0) <= 1).length;
  const wsGaps = (r && r.whitespace && (r.whitespace.whitespace || r.whitespace.gaps)) || [];
  const trendObj = r && r.trend;
  const trendItems: TrendItem[] = Array.isArray(trendObj)
    ? (trendObj as TrendItem[])
    : ((trendObj as { items?: TrendItem[] } | undefined)?.items) || [];
  const silentBuckets = collectGapBuckets(bo, 'silent_demand');
  const heroCount = cs.filter((c) => c.heroProduct && c.heroProduct.heroProducts && c.heroProduct.heroProducts.length).length;

  const rows: AssetRowData[] = [];
  rows.push({
    name: '赛道集中度',
    status: conc.HHI != null ? '已算出' : '未算出',
    cls: conc.HHI != null ? 'ok' : 'idle',
    finding: conc.HHI != null ? `HHI ${conc.HHI}（${conc.hhiInterpretation || ''}）· CR3 ${fmtPct(conc.CR3)} · CR5 ${fmtPct(conc.CR5)}` : '尚未聚合',
    coverage: `${r ? r.brandCount || 0 : 0} 家参与`,
  });
  rows.push({
    name: '品牌横向对比',
    status: cs.length > 0 ? '已算出' : '未算出',
    cls: cs.length > 0 ? 'ok' : 'idle',
    finding: `${cs.length} 家已就绪（主推 / 价格带 / 体量）`,
    coverage: `${cs.length} 家`,
  });
  rows.push({
    name: '价格带空档',
    status: secPriceBands.length > 0 ? '已算出' : '未算出',
    cls: secPriceBands.length > 0 ? 'ok' : 'idle',
    finding: secPriceBands.length ? `共 ${secPriceBands.length} 档，其中 ${gapsEmpty} 档仅 ≤1 家（★ 空档）` : '无价格带数据',
    coverage: `${secPriceBands.length} 档`,
  });
  const painOpp = hasPainOpportunity(cs);
  rows.push({
    name: '痛点机会表',
    status: painOpp ? '已算出' : '未触发',
    cls: painOpp ? 'ok' : 'idle',
    finding: painOpp ? '已聚合对手抱怨点，标「未解决 = 机会」' : '暂无对手抱怨点',
    coverage: painOpp ? '已算出' : '未触发',
  });
  const chRows = (sec.channelMatrix && sec.channelMatrix.rows) || [];
  rows.push({
    name: '渠道矩阵',
    status: chRows.length > 0 ? '已算出' : '未算出',
    cls: chRows.length > 0 ? 'ok' : 'idle',
    finding: chRows.length ? `${chRows.length} 个渠道 × ${chRows[0].brands ? chRows[0].brands.length : 0} 家` : '无渠道数据',
    coverage: `${chRows.length} 渠道`,
  });
  rows.push({
    name: '赛道空白（对手留的空位）',
    status: wsGaps.length > 0 ? '已算出' : '未触发',
    cls: wsGaps.length > 0 ? 'ok' : 'idle',
    finding: wsGaps.length ? `共 ${wsGaps.length} 条候选空位` : '暂无',
    coverage: `${wsGaps.length} 条`,
  });
  rows.push({
    name: '赛道趋势',
    status: trendItems.length > 0 ? '已算出' : '未触发',
    cls: trendItems.length > 0 ? 'ok' : 'idle',
    finding: trendItems.length ? `${trendItems.length} 条趋势推断` : '暂无',
    coverage: `${trendItems.length} 条`,
  });
  const wsComputed = !!(ws && !ws.hidden);
  const wsLevelCounts: Record<string, number> = (ws && ws.gaps)
    ? (ws.gaps as { level?: string }[]).reduce((a: Record<string, number>, g) => {
        const k = g.level || 'unknown';
        a[k] = (a[k] || 0) + 1;
        return a;
      }, {})
    : {};
  rows.push({
    name: '三态网格（真空位/未知/死区）',
    status: wsComputed ? '已算出' : ws.hidden ? '样本不足·初步' : '未触发',
    cls: wsComputed ? 'ok' : ws.hidden ? 'warn' : 'idle',
    finding: wsComputed ? `真空位 ${wsLevelCounts.vacuum || 0} · 未知 ${wsLevelCounts.unknown || 0} · 死区 ${wsLevelCounts.dead || 0}` : '样本不足或采集覆盖有限',
    coverage: wsComputed ? '已算出' : ws.hidden ? '样本不足' : '未触发',
  });
  const boDims = bo.dimensions ? Object.keys(bo.dimensions).length : 0;
  rows.push({
    name: '蓝海要素曲线',
    status: boDims > 0 ? '已算出' : '未触发',
    cls: boDims > 0 ? 'ok' : 'idle',
    finding: boDims ? `${boDims} 个维度 · 已施加推理纪律 v2（供需交叉 / 边界 / 降级）` : '无',
    coverage: boDims ? `${boDims} 维` : '未触发',
  });
  rows.push({ name: '定位象限（强度 × 机会）', status: '按需触发', cls: 'idle', finding: '点击「品类扫描」下的象限视图实时计算', coverage: '按需' });
  const gs = radar.groupSignals || [];
  rows.push({
    name: '雷达群体异动',
    status: '已算出',
    cls: 'ok',
    finding: gs.length ? `${gs.length} 条跨对手集体异动信号` : '近阶段暂无集体异动',
    coverage: `${gs.length} 条`,
  });
  rows.push({
    name: '主推产品推理',
    status: cs.length > 0 ? '已算出' : '未算出',
    cls: cs.length > 0 ? 'ok' : 'idle',
    finding: cs.length ? `${heroCount}/${cs.length} 家识别到主推（推算）` : '无',
    coverage: `${heroCount} 家`,
  });
  rows.push({ name: '对手时间线', status: '按需触发', cls: 'idle', finding: '点击品牌卡展开时间线', coverage: '按需' });
  const oppComputed = !!(opp && !opp.hidden);
  rows.push({
    name: '机会地图（旗舰·空白视图）',
    status: oppComputed ? '已算出' : opp.hidden ? '样本不足·初步' : '未触发',
    cls: oppComputed ? 'ok' : 'warn',
    finding: oppComputed
      ? `共 ${opp.total != null ? opp.total : '—'} 个用户声音主题，${opp.zones ? (opp.zones.underserved != null ? opp.zones.underserved : '—') : 0} 个落在重点机会区`
      : opp.reason === 'need_more_voice'
        ? `样本不足：仅 ${opp.brandsWithVoice != null ? opp.brandsWithVoice : '—'}/${opp.doneBrands != null ? opp.doneBrands : '—'} 家有声音`
        : `样本不足：仅 ${opp.doneBrands != null ? opp.doneBrands : '—'} 家已就绪`,
    coverage: oppComputed ? '已算出' : opp.hidden ? '样本不足·初步' : '未触发',
  });
  rows.push({
    name: '沉默需求盲区（零提及≠无需求）',
    status: bo.silentDemandHint ? '已识别' : bo.dimensions ? '已排除' : '未触发',
    cls: bo.silentDemandHint ? 'warn' : bo.dimensions ? 'ok' : 'idle',
    finding: bo.silentDemandHint ? `${silentBuckets.length} 个空白桶可能为未被供给激活的沉默需求` : '需求样本充足，无沉默盲区',
    coverage: bo.silentDemandHint ? `${silentBuckets.length} 桶` : bo.dimensions ? '已排除' : '未触发',
  });
  rows.push({
    name: '赛道冷热推断',
    status: tv.label ? (tv.failSafe ? '趋势未知·诚实' : '已算出') : '未触发',
    cls: tv.label ? (tv.failSafe ? 'warn' : 'ok') : 'idle',
    finding: tv.label ? `${tv.label}${tv.failSafe ? '（信号不足，未臆造）' : ''}` : '未计算',
    coverage: tv.label ? (tv.failSafe ? '诚实披露' : '已算出') : '未触发',
  });
  return rows;
}

export default function AssetsPage() {
  // 演示模式：本页依赖 POST /api/sector 服务端计算，替换为提示屏（F-04 配套）
  if (isDemoMode()) return <DemoPageGuard label="算法资产" />;
  return <AssetsPageInner />;
}

function AssetsPageInner() {
  const { state, loading } = useZhibiState();
  const [r, setR] = useState<SectorResp | null>(null);
  const [fetching, setFetching] = useState(false);

  // 复刻 renderAssetsTab：state 就绪即 POST /api/sector（state 变化重算）
  useEffect(() => {
    if (!state) return;
    let alive = true;
    setFetching(true);
    apiPost<SectorResp>('/api/sector', { sectorName: state.track || 'sector' })
      .then((res) => {
        if (alive) setR(res);
      })
      .catch(() => {
        if (alive) setR(null); // 旧版 catch → r = null，仍渲染（各行落「未算出」）
      })
      .finally(() => {
        if (alive) setFetching(false);
      });
    return () => {
      alive = false;
    };
  }, [state]);

  // P1-4：派生计算异常 → 兜底空态，不留白屏
  const view = useMemo(() => {
    if (!state) return null;
    try {
      const bo = (state.blueOcean as BlueOcean) || {};
      const tv = (state.trendView as TrendView) || {};
      const rows = buildRows(state, r);
      const silentBuckets = collectGapBuckets(bo, 'silent_demand');
      const specBuckets = collectGapBuckets(bo, 'speculative_gap');
      const trendInferences = (r && r.trend && Array.isArray(r.trend) ? r.trend : []) as TrendItem[];
      return { rows, bo, tv, silentBuckets, specBuckets, trendInferences };
    } catch (e) {
      return { error: (e as Error)?.message || String(e) };
    }
  }, [state, r]);

  if (loading) return <p className="hint">正在汇总本赛道的算法产出…</p>;
  if (!state || !view) return <p className="hint">无数据。</p>;
  if (view && 'error' in view) {
    return (
      <div className="empty">
        <div className="big">算法资产汇总失败</div>
        <div className="sub">{view.error}。可返回工作台重试。</div>
      </div>
    );
  }

  const { rows, bo, tv, silentBuckets, specBuckets, trendInferences } = view;
  const renderBucket = (b: GapItem, i: number) => (
    <div className="opp-item" data-itemtype="silent" key={(b.dim || '') + (b.key || '') + i}>
      <div className="opp-body">
        <div className="opp-title">
          <span className="gid">{b.dim} · {b.key}</span> <span className="tag warn">推算</span>
        </div>
        <div className="opp-metrics">
          <span>需求侧证据：<b>{b.demandEvidence || '无'}</b></span>
          <span>供给轴：<b>{b.crossAxis || 'supply-only'}</b></span>
        </div>
        <div className="ws-disclaimer">⚠️ {b.gapNote || ''}</div>
        <div className="ws-method"><span className="muted">推理：</span>供给侧空且需求侧无证据，但需求样本薄——可能为未被供给激活的沉默需求，不得断言「无需求」，须人工验证。</div>
      </div>
    </div>
  );

  return (
    <div className="assets-wrap">
      <div className="page-head">
        <div>
          <h2>算法资产</h2>
          <p className="desc">本赛道引擎算出的每份派生数据——是否算出、一句话发现、覆盖状态。</p>
        </div>
      </div>
      {fetching ? <p className="hint">正在汇总本赛道的算法产出…</p> : null}

      {/* —— 算法资产总览（cat-head + asset-index 表） —— */}
      <div className="cat-head">
        <div>
          <h3>算法资产总览</h3>
          <span className="muted">本赛道引擎算出的每份派生数据——是否算出、一句话发现、覆盖状态。点「品类扫描 / 雷达」看明细。</span>
        </div>
      </div>
      <table className="cat-table asset-index">
        <thead>
          <tr><th>派生资产</th><th>状态</th><th>一句话发现</th><th>覆盖</th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td><b>{row.name}</b></td>
              <td><span className={'asset-st asset-' + row.cls}>{row.status}</span></td>
              <td>{row.finding}</td>
              <td className="muted">{row.coverage}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* —— 沉默需求盲区 —— */}
      <div className="cat-sec silent-demand-sec">
        <h4>沉默需求盲区 · 零提及 ≠ 无需求</h4>
        {bo.silentDemandNote ? <p className="ws-prelim-banner">⚠️ {bo.silentDemandNote}</p> : null}
        {!silentBuckets.length && !specBuckets.length ? (
          <p className="hint">
            当前需求样本充足（≥3 家有用户声音），空白桶的「无需求」结论可信，未识别到沉默需求盲区。{bo.dimensions ? '' : '（蓝海视图未计算）'}
          </p>
        ) : (
          <>
            {silentBuckets.length ? (
              <>
                <p className="ws-desc">下列空白桶：供给侧无人占据、需求侧也无证据，但需求样本薄（&lt;3 家有用户声音）——可能是「未被供给激活的沉默需求」，而非真无需求。均按推算处理，置信锁 low，须人工验证。</p>
                <div className="opp-list">{silentBuckets.map(renderBucket)}</div>
              </>
            ) : null}
            {specBuckets.length ? (
              <>
                <p className="ws-desc">另有推测性空白（需求侧无法判定）：</p>
                <div className="opp-list">{specBuckets.map(renderBucket)}</div>
              </>
            ) : null}
          </>
        )}
      </div>

      {/* —— 趋势推断 —— */}
      <div className="cat-sec trend-sec">
        <h4>趋势推断 · 赛道冷热与可证伪检验点</h4>
        {tv.label ? (
          <>
            <div className="opp-denom">
              <div className="opp-denom-row"><b>赛道冷热</b>：{tv.label}{tv.hotScore != null ? `（hotScore ${tv.hotScore}）` : ''}</div>
              {tv.distribution ? (
                <div className="opp-denom-row"><b>分布</b>：上升 {tv.distribution.rising} · 平稳 {tv.distribution.stable} · 下滑 {tv.distribution.declining} · 未知 {tv.distribution.unknown}（样本 {tv.total} 家，有效信号 {tv.withSignal}）</div>
              ) : null}
            </div>
            {tv.note ? <p className="ws-desc">{tv.note}</p> : null}
          </>
        ) : (
          <p className="hint">趋势视图未计算。</p>
        )}
        {tv.checkpoint && tv.checkpoint.falsifiable ? (
          <div className="ws-method">
            <span className="muted">检验点（可证伪）：</span>{tv.checkpoint.test || ''}{tv.checkpoint.horizonDays ? `（窗口 ${tv.checkpoint.horizonDays} 天）` : ''}
          </div>
        ) : null}
        {trendInferences.length ? (
          <div className="opp-list">
            {trendInferences.map((it, i) => {
              const basisTag = it.basis === 'analogy'
                ? <span className="tag warn">类比外推·低置信</span>
                : it.confidence === 'unknown'
                  ? <span className="tag">不可推断</span>
                  : <span className="tag">结构派生</span>;
              return (
                <div className="opp-item" data-itemtype="trend" key={i}>
                  <div className="opp-body">
                    <div className="opp-title">{it.claim || ''} {basisTag}</div>
                    {it.note ? <div className="ws-desc">{it.note}</div> : null}
                    {it.checkpoint && it.checkpoint.test ? (
                      <div className="ws-method"><span className="muted">检验点：</span>{it.checkpoint.test}{it.checkpoint.horizonDays ? `（窗口 ${it.checkpoint.horizonDays} 天）` : ''}</div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
