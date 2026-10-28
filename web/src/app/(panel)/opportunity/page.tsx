'use client';
// 机会视图（Phase 3，复刻 renderOpportunity L1200-1301 + oppScatterSvg L1115-1168
//   + oppSourceTags L1169-1175 + oppMarketGapSection L1177-1199 + OPP_ZONE L1110-1114）
// 铁律：分母常驻可见、每条可溯源、置信度封顶「中」、覆盖率不足不作排序结论。
// 结构：卖点空缺（市场空缺，来自空白视图）默认主层 → 口碑机会（满意度×重要性）补充层。
// 交互：散点图点 → 高亮下方对应卡片并平滑滚动（复刻 L1292-1299）。
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import type { ZhibiState } from '@/types/state';
import { fetchOpportunities, type OpportunityView, type OpportunityFoundation, type OpportunityDimensionBasis, type OpportunityEvidenceRef } from '@/lib/core-api';
import { EvidenceDrawer } from '@/components/data-surface/evidence-drawer';

// 统一读模型机会基础（SC-04 UI 框架轮）：先展示「已具备什么数据」（品牌样本 + 维度构成），
// 再展示机会线索；样本不足 → 明确「资料不足，暂不生成机会判断」并给出补齐方向，
// 绝不把未接入维度伪装成市场机会。
// ============================================================
// SC-12 §六：机会模块（按可用维度独立工作）
//   · 价格带分布 / 品牌价格定位 / 产品矩阵密度 / 上新与库存动态 / 公开评论与声音
//   · 满意度×重要性：仅服务端门槛满足时渲染；不足时显示规定文案（不出空图）
//   · 缺失维度：显示状态而不是空白；不填 0
// ============================================================
function DimStatusLine({ d }: { d: OpportunityDimensionBasis }) {
  const t = d.statusText || (d.status === 'missing' ? '暂无数据' : d.status);
  return <span className="core-opp-dim-state">{t}</span>;
}

function FoundationModules({ f }: { f: OpportunityFoundation | null }) {
  // §五.3：证据入口是可操作按钮，打开现有 Evidence Drawer（不打印内部 Evidence ID）
  const [evRefs, setEvRefs] = useState<OpportunityEvidenceRef[] | null>(null);
  if (!f) return null;
  const price = f.modules.priceBands;
  const matrix = f.modules.matrixDensity;
  const dyn = f.modules.newItemDynamics;
  const rev = f.modules.reviewInsights;
  const sat = f.modules.satisfactionScatter;
  const maxSku = Math.max(1, ...matrix.rows.map(r => r.productCount || 0));
  const fmtWin = (w: { from: string | null; to: string | null }) =>
    w && w.from ? `${String(w.from).slice(0, 10)} → ${String(w.to || '').slice(0, 10) || '至今'}` : '—';
  // §五.5：证据按钮（打开抽屉；不渲染裸 Evidence ID）
  const evBtn = (refs: OpportunityEvidenceRef[] | undefined) => {
    const usable = (refs || []).filter(r => r && (r.evidenceId || r.snapshotId));
    if (!usable.length) return <span className="core-brand-muted">本次无逐条证据引用</span>;
    return (
      <button type="button" className="btn-mini core-opp-ev-btn" onClick={() => setEvRefs(usable)}>
        查看证据（{usable.length}）
      </button>
    );
  };

  return (
    <section className="core-opp-modules" data-testid="opp-modules">
      {/* ① 数据基础摘要 */}
      <div className="core-opp-basis-line">
        <span>品牌 <b>{f.brandScope.total}</b> 个，已有数据 <b>{f.brandScope.withData}</b> 个</span>
        <span>可用维度 <b>{f.summary.usableDimensionCount}</b> 个</span>
        <span>缺失维度 <b>{f.summary.missingDimensionCount}</b> 个</span>
        <span>机会线索 <b>{f.summary.opportunityCount}</b> 条</span>
        <span className="core-brand-muted">缺失维度不填 0，也不参与统计</span>
      </div>

      {/* ② 第一层：价格与商品（只要有公开商品与价格即可生成，不依赖评论/广告） */}
      <section className="core-opp-layer" data-testid="opp-layer-1">
        <header className="core-opp-layer-head">
          <h3>第一层 · 价格与商品</h3>
          <p>只要有公开商品与价格就能生成这一层，评论、社媒、广告缺失都不影响。</p>
        </header>
        <div className="core-opp-grid">
        {/* 价格带分布（§一.5/§一.7：按币种分组；标题与单位随实际币种） */}
        <div className="core-opp-card" data-testid="opp-price-bands">
          <h4>价格带分布{price.multiCurrency ? '（按币种分组）' : ''}</h4>
          {price.groups.length ? (
            <>
              {price.groups.map(g => (
                <div key={g.currency} className="core-opp-cur-group">
                  <p className="core-opp-cur-title">{g.currency} · {g.brandCount} 个品牌参与统计{g.medianPrice != null ? ` · 中位价 ${g.medianPrice}` : ''}</p>
                  {g.rawObservation ? (
                    <p className="hint" data-testid="opp-raw-observation">{g.rawObservation.note}</p>
                  ) : null}
                  {g.bandsAvailable ? (
                    <ul className="core-opp-bands">
                      {g.bands.map(b => {
                        const maxB = Math.max(1, ...g.bands.map(x => x.brandCount));
                        return (
                          <li key={b.key}>
                            <span className="core-opp-band-label">{b.label}</span>
                            <span className="core-opp-band-bar"><i style={{ width: Math.round((b.brandCount / maxB) * 100) + '%' }} /></span>
                            <span className="core-opp-band-num">{b.brandCount} 个品牌</span>
                          </li>
                        );
                      })}
                    </ul>
                  ) : <p className="core-brand-muted">{g.currency} 组品牌数不足，只展示原始价格范围，不生成价格带。</p>}
                </div>
              ))}
              <p className="core-brand-muted core-brand-mini">
                口径：各组币种内公开标价截面；仅在同一币种内比较，不做汇率换算；未采集品牌不计入。
              </p>
            </>
          ) : <p className="core-brand-muted">暂无可用价格数据（未采集，不按 0 计入）。</p>}
        </div>

        {/* 品牌价格定位（§一：币种未知/混合的品牌只展示原始范围，不参与相对定位） */}
        <div className="core-opp-card core-opp-price-position" data-testid="opp-price-position">
          <h4>品牌价格定位{price.multiCurrency ? '（按币种分组）' : ''}</h4>
          {(price.rows.length || price.nonComparableRows.length) ? (
            <>
            <div className="core-opp-table-wrap">
            <table className="core-opp-table">
              <thead><tr><th>品牌</th><th>币种</th><th>中位价</th><th>价格区间</th><th>在售 SKU</th><th>证据</th></tr></thead>
              <tbody>
                {price.rows.map(r => (
                  <tr key={r.brandId}>
                    <td>{r.name}</td>
                    <td>{r.currency || '—'}</td>
                    <td>{r.priceMedian != null ? (r.currency ? r.currency + ' ' : '') + r.priceMedian : '—'}</td>
                    <td>{r.priceMin != null && r.priceMax != null
                      ? (r.currency ? r.currency + ' ' : '') + r.priceMin + '–' + r.priceMax
                      : '—'}</td>
                    <td>{r.productCount != null ? r.productCount : '—'}</td>
                    <td>{evBtn(r.evidenceRefs)}</td>
                  </tr>
                ))}
                {price.nonComparableRows.map(r => (
                  <tr key={'nc_' + r.brandId} className="core-opp-nc-row">
                    <td>{r.name}</td>
                    <td>—</td>
                    <td colSpan={2}><span className="core-brand-muted">{r.note}</span></td>
                    <td>{r.productCount != null ? r.productCount : '—'}</td>
                    <td>—</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            {/* r4 §九：移动端价格定位改为卡片（不塞桌面宽表格，无需横向滑动） */}
            <div className="core-opp-price-cards" data-testid="opp-price-cards">
              {price.rows.map(r => (
                <div className="core-opp-price-card" key={'m_' + r.brandId}>
                  <div className="cc-head"><b>{r.name}</b><span className="cc-cur">{r.currency || '—'}</span></div>
                  <div className="cc-grid">
                    <span>中位价<b>{r.priceMedian != null ? (r.currency ? r.currency + ' ' : '') + r.priceMedian : '—'}</b></span>
                    <span>价格区间<b>{r.priceMin != null && r.priceMax != null ? (r.currency ? r.currency + ' ' : '') + r.priceMin + '–' + r.priceMax : '—'}</b></span>
                    <span>在售 SKU<b>{r.productCount != null ? r.productCount : '—'}</b></span>
                    <span>证据{evBtn(r.evidenceRefs)}</span>
                  </div>
                </div>
              ))}
              {price.nonComparableRows.map(r => (
                <div className="core-opp-price-card is-nc" key={'mnc_' + r.brandId}>
                  <div className="cc-head"><b>{r.name}</b></div>
                  <p className="core-brand-muted">{r.note}</p>
                </div>
              ))}
            </div>
            </>
          ) : <p className="core-brand-muted">暂无可用价格数据。</p>}
        </div>

        {/* 产品矩阵密度 */}
        <div className={'core-opp-card' + (matrix.available ? '' : ' is-empty')} data-testid="opp-matrix">
          <h4>产品矩阵密度</h4>
          {matrix.available ? (
            <>
              <ul className="core-opp-bars">
                {matrix.rows.map(r => (
                  <li key={r.brandId}>
                    <span className="core-opp-band-label">{r.name}</span>
                    <span className="core-opp-band-bar"><i style={{ width: Math.round(((r.productCount || 0) / maxSku) * 100) + '%' }} /></span>
                    <span className="core-opp-band-num">{r.productCount != null ? r.productCount + ' 款' : '—'}</span>
                  </li>
                ))}
              </ul>
              <p className="core-brand-muted core-brand-mini">
                同项目中位数：{matrix.medianProductCount != null ? matrix.medianProductCount + ' 款' : '—'}；在售 {matrix.rows.filter(r => r.available != null).reduce((s, r) => s + (r.available || 0), 0)} 款，缺货 {matrix.rows.filter(r => r.soldOut != null).reduce((s, r) => s + (r.soldOut || 0), 0)} 款。
              </p>
            </>
          ) : <p className="core-brand-muted">暂无可用商品数据。</p>}
        </div>

        {/* 上新与库存动态 */}
        <div className={'core-opp-card' + (dyn.available ? '' : ' is-empty')} data-testid="opp-dynamics">
          <h4>上新与库存动态</h4>
          {dyn.available ? (
            <>
              <ul className="core-opp-list">
                {dyn.rows.map(r => (
                  <li key={r.brandId}>
                    <b>{r.name}</b>：已建立 {r.baselineItems} 款商品的采集基线（{String(r.firstSeenAt || '').slice(0, 10)}）
                  </li>
                ))}
              </ul>
              <p className="core-brand-muted core-brand-mini">
                当前只有 {dyn.comparableWindows} 个可比窗口，因此只陈述「首次观察到的商品数」，不判断上新或下架；不可比记录不伪装成变化。
              </p>
            </>
          ) : <p className="core-brand-muted">尚无带可比窗口的商品观察。</p>}
        </div>

        </div>
      </section>

      {/* ③ 第二层：用户声音（样本达门槛后增加；不足只隐藏本层模块，不空页） */}
      <section className="core-opp-layer" data-testid="opp-layer-2">
        <header className="core-opp-layer-head">
          <h3>第二层 · 用户声音</h3>
          <p>公开评论样本达到门槛后增加；样本不足时本层只说明原因，第一层结论不受影响。</p>
        </header>
        <div className="core-opp-grid">

        {/* 公开评论与用户声音 */}
        <div className="core-opp-card" data-testid="opp-reviews">
          <h4>公开评论与用户声音</h4>
          {rev.available ? (
            <>
              <ul className="core-opp-list">
                {rev.rows.map(r => (
                  <li key={r.brandId}>
                    <b>{r.name}</b>：{r.pageCount} 个可核验公开页面
                    {r.reviewCount != null ? `，页面报告评论数 ${r.reviewCount}` : '，页面未报告可核验评论数'}
                    {r.ratedPages ? `，其中 ${r.ratedPages} 个带评分` : ''}
                    {r.pages && r.pages[0] && r.pages[0].url ? (
                      <> · <a href={r.pages[0].url} target="_blank" rel="noopener noreferrer nofollow">来源页</a></>
                    ) : null}
                  </li>
                ))}
              </ul>
              <p className="core-brand-muted core-brand-mini">样本是本次采集窗口内通过校验的公开页面，不等于全网口碑；缺分类依据时不做满意度结论。</p>
            </>
          ) : <p className="core-brand-muted">尚未采集到公开评论页面。</p>}
        </div>

        {/* 满意度 × 重要性（门槛由服务端判定） */}
        <div className="core-opp-card" data-testid="opp-satisfaction">
          <h4>满意度 × 重要性</h4>
          {sat.available ? (
            <>
              <ul className="core-opp-list">
                {sat.objects.map(o => (
                  <li key={o.oid || o.label}>
                    <b>{o.label || '未命名主题'}</b>：满意度 {o.satisfaction} · 重要性 {o.importance}
                    {o.sampleScope ? `（${o.sampleScope}）` : ''} {evBtn(o.evidenceRefs)}
                  </li>
                ))}
              </ul>
              <p className="core-brand-muted core-brand-mini">坐标与依据全部来自服务端结论；重叠点使用碰撞避让与重叠计数，不修改真实数值。</p>
            </>
          ) : (
            <>
              <p className="core-opp-gate">{sat.reason || '当前评论样本不足，暂不生成满意度分布'}</p>
              <p className="core-brand-muted core-brand-mini">
                可比对象 {sat.comparableObjects} 个，至少需要 {sat.minObjects} 个同时具备满意度、重要性、证据与时间窗口的对象才出图。
                价格、商品等已有模块不受影响。
              </p>
            </>
          )}
        </div>
        </div>
      </section>

      {/* ④ 第三层：内容 · 热度 · 广告（接入后才生成，未接入不编造趋势） */}
      <section className="core-opp-layer" data-testid="opp-layer-3">
        <header className="core-opp-layer-head">
          <h3>第三层 · 内容、热度与广告</h3>
          <p>这层依赖社媒内容、搜索热度与广告数据；未接入或样本不足时不生成任何趋势结论。</p>
        </header>
        <div className="core-opp-grid">
          {(['content', 'heat', 'ads'] as const).map(code => {
            const dim = f.dimensions[code];
            const label = code === 'content' ? '内容热度' : code === 'heat' ? '关键词趋势' : '广告素材与投放';
            if (!dim) {
              return (
                <div key={code} className="core-opp-card" data-testid={'opp-l3-' + code}>
                  <h4>{label}</h4>
                  <p className="core-brand-muted">该维度尚未接入，暂不生成{label}结论。</p>
                </div>
              );
            }
            const usable = dim.status === 'complete' || dim.status === 'partial' || dim.status === 'checked_empty';
            return (
              <div key={code} className="core-opp-card" data-testid={'opp-l3-' + code}>
                <h4>{label}</h4>
                {usable && dim.observationCount > 0 ? (
                  <>
                    <p className="core-opp-main">
                      覆盖 {dim.brandCount} 个品牌，{dim.observationCount} 条观察，{dim.evidenceCount} 条证据。
                    </p>
                    <p className="core-brand-muted core-brand-mini">
                      时间范围 {dim.window && dim.window.from ? String(dim.window.from).slice(0, 10) + ' → ' + (dim.window.to ? String(dim.window.to).slice(0, 10) : '至今') : '—'}
                      {dim.measurementMethod ? ` · 口径：${dim.measurementMethod}` : ''}
                      {dim.usingPreviousData ? ' · 使用历史数据（最近一次更新未成功）' : ''}
                    </p>
                    {dim.limits && dim.limits.length ? (
                      <p className="core-brand-muted core-brand-mini">限制：{dim.limits.slice(0, 2).join('；')}</p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p className="core-opp-gate">{dim.statusText || '该维度暂无可用数据'}</p>
                    <p className="core-brand-muted core-brand-mini">
                      {dim.status === 'not_configured' ? '数据服务尚未接入，不生成估算或趋势。' : '本层只陈述观察到的公开内容，不做投放效果推断。'}
                      {dim.latestFailureText ? `（${dim.latestFailureText}）` : ''}
                    </p>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ⑤ 机会线索（只陈述事实 + 限制 + 建议验证的问题） */}
      {f.opportunities.length ? (
        <div className="core-opp-opps" data-testid="opp-opportunities">
          <h3>可核验的机会线索</h3>
          {f.opportunities.map(op => (
            <div key={op.id} className="core-opp-opp">
              <h4>{op.title}</h4>
              <p className="core-opp-fact">{op.fact}</p>
              <dl className="core-opp-meta">
                <div><dt>使用维度</dt><dd>{op.dimension}</dd></div>
                <div><dt>样本量</dt><dd>{op.sampleSize}</dd></div>
                <div><dt>时间范围</dt><dd>{fmtWin(op.window)}</dd></div>
                <div><dt>证据入口</dt><dd>{evBtn(op.evidenceRefs)}</dd></div>
                <div><dt>限制</dt><dd>{op.limits.join('；')}</dd></div>
                <div><dt>建议验证</dt><dd>{op.question}</dd></div>
              </dl>
            </div>
          ))}
          <p className="core-brand-muted core-brand-mini">线索只陈述观察到的事实与样本口径，不替你做经营决策。</p>
        </div>
      ) : null}

      {evRefs && evRefs.length ? (
        <EvidenceDrawer refs={evRefs.map(r => ({ evidenceId: r.evidenceId, snapshotId: r.snapshotId, sourceUrl: r.sourceUrl || null }))} onClose={() => setEvRefs(null)} />
      ) : null}
    </section>
  );
}

// SC-12 §六：机会视图统一取数（父页 + 数据基础块共用同一份，避免重复请求）
function useOpportunityView(projectId: string) {
  const [v, setV] = useState<OpportunityView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const ctrl = new AbortController();
    setV(null);
    fetchOpportunities(projectId, ctrl.signal)
      .then(r => { if (alive) { setV(r); setErr(null); } })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; ctrl.abort(); };
  }, [projectId]);
  return { view: v, err };
}

function UnifiedOpportunityBasis({ projectId, view }: { projectId: string; view?: OpportunityView | null }) {
  const own = useOpportunityView(projectId);
  const v = view !== undefined ? view : own.view;
  const err = view !== undefined ? null : own.err;
  if (err) return <p className="core-err">{err}</p>;
  if (!v) return null;
  const db = v.dimensionBasis;
  return (
    <section className="core-opp-basis">
      {/* SC-12 §六.2：机会模块按可用数据独立工作——有价格/商品就必须有分析 */}
      <FoundationModules f={v.foundation || null} />
      <details className="core-opp-basis-more" data-testid="opp-basis-detail">
      <summary>数据基础与样本范围（展开查看口径与限制）</summary>
      <ul>
        <li>竞争品牌数：{v.sample.brandCount}（已具备真实数据：{v.sample.brandsWithData}{v.sample.required ? ` / 至少需要 ${v.sample.required}` : ''}）</li>
        {db ? (
          <>
            <li>已接入维度：{db.integrated.length ? db.integrated.join('、') : '—'}</li>
            <li>当前实际有数据的维度：{db.covered.length ? db.covered.join('、') : '暂无（尚未采集到可用数据）'}</li>
            {db.pendingVerification && db.pendingVerification.length ? <li>待验证维度（能力已实现、尚无真实成功采集）：{db.pendingVerification.join('、')}</li> : null}
            {db.pendingConfig && db.pendingConfig.length ? <li>需要系统数据服务配置的维度：{db.pendingConfig.join('、')}</li> : null}
            <li>本次判断未使用的维度（建设中）：{(db.pendingVerification || []).length + (db.pendingConfig || []).length + db.notIntegrated.length ? [...(db.pendingVerification || []), ...(db.pendingConfig || []), ...db.notIntegrated].join('、') : '无'}</li>
          </>
        ) : null}
        {/* SC-05：可用历史跨度与本次判断使用的时间范围（来自时序事实，不是采集次数） */}
        {v.historyBasis ? (
          <>
            <li>
              可用历史跨度：{v.historyBasis.availableHistoryDays > 0
                ? v.historyBasis.availableHistoryDays + ' 天（' + String(v.historyBasis.earliestAvailableAt || '').slice(0, 10) + ' 起，' + v.historyBasis.factCount + ' 条时序事实，其中 ' + (v.historyBasis.comparableCount || 0) + ' 条可比）'
                : '尚无可用时序历史'}
            </li>
            <li>本次判断使用的时间范围：{v.historyBasis.earliestAvailableAt ? String(v.historyBasis.earliestAvailableAt).slice(0, 10) + ' 至今' : '—（无历史区间）'}</li>
            <li>{v.historyBasis.note}</li>
          </>
        ) : null}
        <li>机会状态：{v.statusText}</li>
        {v.note ? <li>{v.note}</li> : null}
      </ul>
      </details>
      {/* §六.1：不可用 / 建设中维度合并为唯一区域，每个维度只出现一次 */}
      {(v.foundation && v.foundation.unavailableDimensions.length) || (db && db.notIntegrated.length) ? (
        <div className="core-building core-opp-building" data-testid="opp-missing">
          <div className="core-building-head">当前不可用与建设中维度</div>
          <p className="hint">以下维度当前不生成数据、估算或结论；接入并完成配置验证后这里会展示采集状态与来源。</p>
          <ul className="core-building-list">
            {(v.foundation ? v.foundation.unavailableDimensions : []).map(d => (
              <li key={d.code}>
                <span className="core-building-name">{d.label}</span>
                <span className="core-building-state">{d.statusText || DimStatusLine({ d })}</span>
                {d.usingPreviousData ? (
                  <span className="core-building-meta">已有历史数据，最近更新失败（最近成功 {String(d.lastSuccessAt || '').slice(0, 10)}）：{d.latestFailureText || ''}</span>
                ) : null}
                {(d.perBrand || []).length > 1 ? (
                  <span className="core-building-meta">按品牌：{(d.perBrand || []).map(p => p.name + '（' + (p.stateText || p.state) + '）').join('、')}</span>
                ) : null}
                <span className="core-building-meta">当前不生成数据、估算或结论</span>
              </li>
            ))}
            {(db ? db.notIntegrated : []).filter(n => {
              const f = v.foundation;
              if (!f) return true;
              return !f.unavailableDimensions.some(d => d.label === n || d.code === n);
            }).map(n => (
              <li key={n}>
                <span className="core-building-name">{n}</span>
                <span className="core-building-state">尚未接入</span>
                <span className="core-building-meta">最近观察：—</span>
                <span className="core-building-meta">来源：未接入</span>
                <span className="core-building-meta">刷新：不可用</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {v.status === 'insufficient_voice' ? (
        // SC-06 r2：评论已采集但没有带依据的正负分类 → 不出满意度判断，也不拿旧主题凑数
        <div className="core-opp-insufficient">
          <p className="core-opp-insufficient-title">用户声音已采集，但尚不足以形成满意度机会判断</p>
          <ul>
            <li>已采集的可核验公开评论观察：{v.voiceBasis ? v.voiceBasis.collected : 0} 条</li>
            <li>合格输入（带 polarity + sentimentBasis + 证据/快照 + 来源 URL + 观察时间 + 项目内竞品归属（competitorId））：{v.voiceBasis ? v.voiceBasis.qualified : 0} 条</li>
            <li>缺的不是评论条数，而是可解释的正负分类依据；中性/未分类评论不进满意度分子或分母，因此不出「满意度 × 重要性」散点图，也不按相对百分位标「重点机会」。</li>
          </ul>
          {v.nextSteps && v.nextSteps.length ? (
            <div className="hint">
              下一步：<ul>{v.nextSteps.map((n, i) => <li key={i}>{n}</li>)}</ul>
            </div>
          ) : null}
        </div>
      ) : v.status === 'insufficient' ? (
        <div className="core-opp-insufficient">
          <p className="core-opp-insufficient-title">资料不足，暂不生成机会判断</p>
          {v.note ? <p className="hint">{v.note}</p> : null}
          <p className="hint">补齐方向：把更多竞争品牌推进到「已具备真实数据」（当前 {v.sample.brandsWithData}/{v.sample.required || 3}）；建设中维度接入后不会追溯生成，只对之后的数据生效。</p>
        </div>
      ) : (
        <ul className="core-opp-items">
          {v.items.slice(0, 10).map((it, i) => (
            <li key={it.id || i}>
              <span className="core-opp-theme">{it.theme}</span>
              <span>覆盖品牌数 {it.brandCount != null ? it.brandCount : '—'}</span>
              {it.from || it.to ? <span>时间范围 {it.from || '不限'} ~ {it.to || '不限'}</span> : null}
              <span>{it.status || '线索（待验证）'}</span>
              {it.basis != null ? <span className="core-opp-basisline">事实依据：{typeof it.basis === 'string' ? it.basis : JSON.stringify(it.basis)}</span> : null}
              {it.caveats && it.caveats.length ? <span className="core-opp-caveat">限制与待验证：{it.caveats.join('；')}</span> : null}
              <a className="core-opp-link" href={`/intel?projectId=${encodeURIComponent(projectId)}`}>到每日变化核对 →</a>
            </li>
          ))}
        </ul>
      )}
      {v.limits.length ? (
        <ul className="core-opp-limits">
          {v.limits.map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      ) : null}
      <p className="hint">文案口径：这里是「机会线索」，基于当前样本显示；不是经营决策或行动指令。</p>
    </section>
  );
}

// ---------- 类型（对齐后端 opportunity / whiteSpace.gaps 结构） ----------
interface OppSource {
  name?: string;
  field?: string;
  polarity?: string;
  detail?: string;
  basis?: string;
}

interface OppTheme {
  oid: string;
  label?: string;
  zone?: string;
  opportunity?: number | string;
  importance?: number | string;
  satisfaction?: number | string;
  denominatorText?: string;
  coverageInsufficient?: boolean;
  mergedFrom?: number;
  members?: string[];
  note?: string;
  method?: string;
  sources?: OppSource[];
  brandsMentioned?: number;
  brandsWithVoice?: number;
}

// SC-06 r2：统一评论事实链的资格状态（缺合格输入时不画散点、不按相对百分位分区）
interface OppVoiceBasis {
  collected?: number;
  qualified?: number;
  brandsWithVoice?: number;
  doneBrands?: number;
  gate?: string;
  note?: string | null;
}

interface Opportunity {
  hidden?: boolean;
  reason?: string;
  brandsWithVoice?: number;
  doneBrands?: number;
  coveragePct?: number;
  mentionsTotal?: number;
  method?: string;
  caveats?: string[];
  preliminaryThemes?: OppTheme[];
  total?: number;
  ranked?: boolean;
  relativeBands?: boolean;
  zones?: { underserved?: number; moderate?: number; served?: number };
  themes?: OppTheme[];
  voiceBasis?: OppVoiceBasis | null;
}

interface MarketGap {
  gid?: string;
  copyGap?: boolean;
  level?: string;
  gapKind?: string;
  dim?: string;
  value?: string;
  confidence?: string;
  speculative?: boolean;
  note?: string;
}

const OPP_ZONE: Record<string, { label: string; color: string; fill: string; stroke: string }> = {
  underserved: { label: '重点机会 · 蓝海', color: '#5DCAA5', fill: 'rgba(29,158,117,0.14)', stroke: '#1D9E75' },
  moderate: { label: '值得关注', color: '#FAC775', fill: 'rgba(186,117,23,0.10)', stroke: '#BA7517' },
  served: { label: '已被满足', color: '#8b95a3', fill: 'rgba(107,118,132,0.08)', stroke: '#3a4452' },
};

// methodKey 英文标识 → 中文方法名映射（用于 .gid 标签显示）
const METHOD_LABEL: Record<string, string> = {
  adjacencyStruct: '邻接结构',
  'importance+satisfaction': '重要性+满意度',
  'speculative=true': '推测性痛点',
};
function methodLabel(oid?: string): string {
  if (!oid) return '';
  return METHOD_LABEL[oid] || ''; // 未映射的原始编号（O-xxxxx）不再展示
}
// gid 标签：仅在有可读方法名时渲染（原始 O-xxxxx 编号隐藏）
function GidTag({ oid }: { oid?: string }) {
  const lbl = methodLabel(oid);
  if (!lbl) return null;
  return <span className="gid">{lbl}</span>;
}

const ZONE_ORDER = ['underserved', 'moderate', 'served'] as const;
const ZONE_DESC: Record<string, string> = {
  underserved: '重要性高、满意度低：多个竞争品牌的用户反馈中反复出现相同问题，且尚未发现稳定的正向表现。',
  moderate: '有一定普遍性、满意度中等：建议优先验证其是否为目标人群真正关心的议题。',
  served: '要么已经被做好，要么只有零星提及——不建议作为切入点。',
};
const FIELD_ZH: Record<string, string> = {
  'reviews.negThemes': '口碑负面主题',
  'reviews.posThemes': '口碑正面主题',
  painPoints: '抱怨点',
};

// ---------- 来源标签（复刻 oppSourceTags L1169-1175） ----------
function OppSourceTags({ sources }: { sources?: OppSource[] }) {
  if (!sources || !sources.length) return null;
  return (
    <div className="opp-src">
      {sources.slice(0, 8).map((s, i) => (
        <span
          key={i}
          className={'src-tag ' + (s.polarity === 'pos' ? 'pos' : 'neg')}
          title={s.detail || ''}
        >
          {s.name || ''} · {FIELD_ZH[s.field || ''] || s.field}
          {s.basis === 'verified' ? ' ✓' : ''}
        </span>
      ))}
      {sources.length > 8 ? <span className="src-more">+{sources.length - 8}</span> : null}
    </div>
  );
}

// ---------- 卖点空缺 / 市场空缺主层（复刻 oppMarketGapSection L1177-1199） ----------
function MarketGapSection({ state }: { state: ZhibiState }) {
  const ws = (state && state.whiteSpace) || {};
  const gaps = ws && !ws.hidden && Array.isArray(ws.gaps) ? (ws.gaps as MarketGap[]) : [];
  const market = gaps.filter((g) => !g.copyGap && (g.level === 'opportunity' || g.gapKind === 'silent_demand'));
  if (!market.length) return null;
  return (
    <div className="ws-section opp-section opp-market">
      <h4><span className="opp-zone-dot" style={{ background: '#1f6fb2' }} />卖点空缺 / 市场空缺（竞争品牌未覆盖的空位 · 来自空白视图）</h4>
      <p className="ws-desc">下列空位来自「空白视图」：供给侧暂未发现品牌占据、且（需求侧有证据，或薄样本下不定为无需求）。这是建议优先验证的切入线索；口碑驱动的补充机会见下方「口碑机会」层。</p>
      <div className="opp-list">
        {market.map((g, i) => {
          const silent = g.gapKind === 'silent_demand';
          const conf = g.confidence || 'low';
          return (
            <div className="opp-item" data-gid={g.gid || ''} data-itemtype="marketgap" key={(g.gid || '') + i}>
              <div className="opp-score" style={{ borderColor: '#1f6fb2' }}>
                <div className="opp-score-v" style={{ color: '#1f6fb2' }}>空位</div>
                <div className="opp-score-k">{g.dim || ''}</div>
              </div>
              <div className="opp-body">
                <div className="opp-title">
                  <GidTag oid={g.gid} /> {g.value || ''} {silent ? <span className="tag warn">沉默需求·待验证</span> : null}
                </div>
                <div className="opp-metrics">
                  <span>置信度 <b>{conf}</b></span>
                  {g.speculative ? <span className="tag warn">推测</span> : null}
                </div>
                <div className="ws-method"><span className="muted">推理：</span>{g.note || ''}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------- 散点图（复刻 oppScatterSvg L1115-1168；点点击 → 高亮滚动 L1292-1299） ----------
function OppScatter({ op, hl, onPick }: { op: Opportunity; hl: string | null; onPick: (oid: string) => void }) {
  // 扩大画布宽度以容纳更长的中文图例（避免「蓝海 · 重点机会（机会分≥15）」在窄屏被裁切），
  // 同时增加右侧留白给「已被满足」标签。
  const W = 700, H = 400, padL = 60, padR = 60, padT = 26, padB = 54;
  const sx = (s: number) => padL + ((s - 1) / 9) * (W - padL - padR);
  const sy = (i: number) => padT + ((10 - i) / 9) * (H - padT - padB);
  const grid: number[] = [];
  for (let v = 1; v <= 10; v += 1.5) grid.push(v);
  // 同坐标去重叠：确定性螺旋偏移，不改变数值，只避免遮挡
  const used: Record<string, number> = {};
  let best: { x: number; y: number; r: number; t: OppTheme } | null = null;
  const themes = op.themes || [];
  const dots = themes.map((t, idx) => {
    const sat = Number(t.satisfaction) || 1;
    const imp = Number(t.importance) || 1;
    const bx = sx(sat), by = sy(imp);
    const key = Math.round(bx) + ',' + Math.round(by);
    const k = used[key] == null ? 0 : used[key] + 1;
    used[key] = k;
    const ang = k * 1.0472, rad = k ? 8 + 3 * Math.floor(k / 6) : 0;
    const cx = bx + Math.cos(ang) * rad, cy = by + Math.sin(ang) * rad;
    const z = OPP_ZONE[t.zone || ''] || OPP_ZONE.served;
    const r = 4 + 5 * Math.min(1, (t.brandsMentioned || 0) / Math.max(1, t.brandsWithVoice || 1));
    const solid = !t.coverageInsufficient;
    const tip = `${t.label || ''}｜机会分 ${t.opportunity}（重要性 ${t.importance} · 满意度 ${t.satisfaction}）｜${t.denominatorText || ''}`;
    if (!best || Number(t.opportunity) > Number(best.t.opportunity)) best = { x: cx, y: cy, r, t };
    let label: { x: number; y: number; text: string; anchor: 'start' | 'end' } | null = null;
    if (idx < 5) {
      const lx = cx + r + 4;
      const right = lx > W - padR - 80;
      // 中文标签按"看起来像 7 个汉字"的视觉宽度截断（中文每个字约 = 1.1 个英文字宽）
      const txt = (t.label || '').length > 12 ? (t.label || '').slice(0, 12) + '…' : t.label || '';
      label = { x: right ? cx - r - 4 : lx, y: cy + 4, text: txt, anchor: right ? 'end' : 'start' };
    }
    return { t, cx, cy, r, z, solid, tip, label };
  });
  const bestStar =
    best && themes.length
      ? {
          x: (best as { x: number; y: number; r: number; t: OppTheme }).x,
          y: (best as { x: number; y: number; r: number; t: OppTheme }).y,
          r: (best as { x: number; y: number; r: number; t: OppTheme }).r,
          t: (best as { x: number; y: number; r: number; t: OppTheme }).t,
        }
      : null;

  return (
    <svg className="opp-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet">
      {/* 分区底色：机会分等值线 opp=I+max(I−S,0) → 边界 I=(opp+S)/2（S≤I 区） */}
      <polygon points={`${sx(1)},${sy(8)} ${sx(5)},${sy(10)} ${sx(1)},${sy(10)}`} fill={OPP_ZONE.underserved.fill} stroke={OPP_ZONE.underserved.stroke} />
      <polygon points={`${sx(1)},${sy(5.5)} ${sx(10)},${sy(10)} ${sx(5)},${sy(10)} ${sx(1)},${sy(8)}`} fill={OPP_ZONE.moderate.fill} stroke={OPP_ZONE.moderate.stroke} />
      {/* 网格 */}
      {grid.map((v, i) => (
        <g key={i}>
          <line x1={sx(v)} y1={padT} x2={sx(v)} y2={H - padB} stroke="#2a313c" />
          <line x1={padL} y1={sy(v)} x2={W - padR} y2={sy(v)} stroke="#2a313c" />
        </g>
      ))}
      {/* 坐标轴 */}
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="#3a4452" />
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="#3a4452" />
      <text x={padL} y={H - padB + 18} textAnchor="start" className="qax">满意度低（多被抱怨）</text>
      <text x={W - padR} y={H - padB + 18} textAnchor="end" className="qax">满意度高（多被夸）</text>
      <text x={padL} y={H - padB + 34} textAnchor="start" className="qax muted">← 满意度（正负提及比代理，1–10）→</text>
      <text transform={`translate(${padL - 38},${padT + 8}) rotate(-90)`} textAnchor="end" className="qax">重要性低</text>
      <text transform={`translate(${padL - 38},${(H - padB + padT) / 2}) rotate(-90)`} textAnchor="middle" className="qax">重要性（提及广度代理）</text>
      <text x={padL + 8} y={padT + 16} className="qzone" fill={OPP_ZONE.underserved.color}>蓝海 · 重点机会（机会分≥15）</text>
      <text x={sx(6.6)} y={sy(9.4)} className="qzone" fill={OPP_ZONE.moderate.color}>值得关注 · 10–15</text>
      <text x={sx(7.6)} y={sy(3)} className="qzone" fill={OPP_ZONE.served.color}>已被满足 / 不够重要</text>
      {/* 点 + 前 5 个标签 */}
      {dots.map((d) => (
        <g key={d.t.oid}>
          <circle
            className="opp-dot"
            data-oid={d.t.oid}
            cx={d.cx.toFixed(1)}
            cy={d.cy.toFixed(1)}
            r={d.r.toFixed(1)}
            fill={d.solid ? d.z.color : '#1b2129'}
            fillOpacity={d.solid ? 0.82 : 1}
            stroke={d.z.color}
            strokeWidth={d.solid ? 1 : 1.6}
            style={{ cursor: 'pointer' }}
            onClick={() => onPick(d.t.oid)}
          >
            <title>{d.tip}</title>
          </circle>
          {d.label ? (
            <text x={d.label.x.toFixed(1)} y={d.label.y.toFixed(1)} textAnchor={d.label.anchor} className="opp-lbl">{d.label.text}</text>
          ) : null}
        </g>
      ))}
      {/* ★ 最佳机会标记（机会分最高者） */}
      {bestStar ? (() => {
        const b = bestStar;
        const lx = b.x + b.r + 6;
        const anchor = lx > W - padR - 90 ? 'end' : 'start';
        const tx = anchor === 'end' ? b.x - b.r - 6 : lx;
        const txt = (b.t.label || '').length > 12 ? (b.t.label || '').slice(0, 12) + '…' : b.t.label || '';
        return (
          <text x={tx.toFixed(1)} y={(b.y - b.r - 6).toFixed(1)} textAnchor={anchor} className="opp-best" fill="#FAC775">★ 最佳机会 · {txt}</text>
        );
      })() : null}
      {/* 高亮环（对齐旧版 .opp-item.hl 联动，图上也标出所选点） */}
      {hl ? (() => {
        const d = dots.find((x) => x.t.oid === hl);
        if (!d) return null;
        return <circle cx={d.cx.toFixed(1)} cy={d.cy.toFixed(1)} r={(d.r + 3).toFixed(1)} fill="none" stroke="#FAC775" strokeWidth={1.4} />;
      })() : null}
    </svg>
  );
}

// ---------- 主题卡（复刻 L1267-1287） ----------
function OppItem({ t, hl }: { t: OppTheme; hl: boolean }) {
  const z = OPP_ZONE[t.zone || ''] || OPP_ZONE.served;
  return (
    <div className={'opp-item' + (hl ? ' hl' : '')} data-oid={t.oid} data-itemtype="opportunity">
      <div className="opp-score" style={{ borderColor: z.color }}>
        <div className="opp-score-v" style={{ color: z.color }}>{t.opportunity}</div>
        <div className="opp-score-k">机会分</div>
      </div>
      <div className="opp-body">
        <div className="opp-title">
          <GidTag oid={t.oid} /> {t.label}
          {t.coverageInsufficient ? <span className="tag warn">覆盖率不足</span> : null}
        </div>
        {t.mergedFrom && t.mergedFrom > 1 ? (
          <div className="opp-merged">
            <span className="muted">合并自：</span>
            {(t.members || []).map((m, i) => <span className="tag" key={i}>{m}</span>)}
          </div>
        ) : null}
        {t.note ? <div className="ws-disclaimer">⚠️ {t.note}</div> : null}
        <OppSourceTags sources={t.sources} />
      </div>
    </div>
  );
}

// ---------- r2：机会视图骨架（首屏 500ms 内出现，避免整页空白） ----------
function OpportunitySkeleton() {
  return (
    <div className="core-opp-skeleton" data-testid="opp-skeleton" aria-busy="true" role="status" aria-label="正在汇总机会数据">
      <div className="page-head">
        <div>
          <h2>市场机会</h2>
          <p className="hint">正在汇总价格、商品与用户声音，先显示已就绪的维度…</p>
        </div>
      </div>
      <div className="core-sk core-sk-head" />
      <div className="core-sk core-sk-row" />
      <div className="core-sk core-sk-row short" />
      <div className="core-sk-grid">
        <div className="core-sk core-sk-card" />
        <div className="core-sk core-sk-card" />
        <div className="core-sk core-sk-card" />
      </div>
    </div>
  );
}

// ---------- 主页面（Suspense：useSearchParams 深链接） ----------
export default function OpportunityPage() {
  return (
    <Suspense fallback={<OpportunitySkeleton />}>
      <OpportunityInner />
    </Suspense>
  );
}

function OpportunityInner() {
  const { state, loading } = useZhibiState();
  const searchParams = useSearchParams();
  const [hl, setHl] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // 🔴 projectId 以 URL 为第一来源（深链接/跳转上下文），state 当前档案兜底
  const urlProjectId = String(searchParams.get('projectId') || (state as { projectId?: string } | null)?.projectId || '');

  // 点图上的点 → 高亮下方对应卡片（复刻 L1292-1299）
  const onPick = (oid: string) => {
    setHl(oid);
    const el = wrapRef.current && wrapRef.current.querySelector(`.opp-item[data-oid="${oid}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // 🔴 项目边界：全局 state 是「当前项目」投影；URL 上的 projectId 才是本页上下文。
  // 两者不一致时不拿别的项目的机会图冒充（项目切换不残留旧视图）。
  // 真正的数据基础/机会状态由 UnifiedOpportunityBasis 按 URL projectId 单独读取。
  const op = useMemo(() => {
    const s = state as (ZhibiState & { projectId?: string }) | null;
    if (!s) return null;
    if (urlProjectId && s.projectId && String(s.projectId) !== String(urlProjectId)) return null;
    return (s.opportunity as Opportunity) || null;
  }, [state, urlProjectId]);
  // SC-12：机会数据基础（服务端按可用维度独立产出）——与旧视图同一接口，一次请求
  const oppView = useOpportunityView(urlProjectId);

  // r2：首屏立即给结构化骨架（不整页空白），后端聚合完成后再替换为真实内容
  if (loading) return <OpportunitySkeleton />;
  if (!op) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h2>市场机会</h2>
            <p className="desc">口碑机会 · 重要但没人做好的地方；卖点空缺来自空白视图。</p>
          </div>
        </div>
        <UnifiedOpportunityBasis projectId={urlProjectId} view={oppView.view} />
        {/* §六.2：foundation 有实质内容时给出具体状态，不显示笼统「暂无数据」 */}
        {oppView.view && oppView.view.foundation && oppView.view.foundation.summary.hasAnalysis ? (
          <div className="ws-head">
            <h3>机会地图 · 正在基于已获得的数据工作</h3>
            <p>
              旧版机会图要等口碑样本齐备才出图；本页已按可用维度独立给出价格、商品等分析（见上方模块与线索）。
              口碑样本补齐后，满意度机会判断会在这里自动出现。
            </p>
          </div>
        ) : (
          <div className="ws-empty">
            <h3>机会地图</h3>
            <p>尚无可核验的竞品数据（价格、商品、评论等均未采集到），因此暂不生成机会分析；采集到数据后这里会按维度逐项展示。</p>
          </div>
        )}
      </div>
    );
  }

  // 🔴 SC-06 r2：评论已采集、但没有带依据的正负分类（或合格样本不足）→
  // 不画假散点、不按相对百分位强行分「重点机会」，也不把旧评论主题混装成市场结论；
  // 保留数据基础（UnifiedOpportunityBasis）、卖点空缺与下一步建议。
  const voiceGate = (op.voiceBasis && op.voiceBasis.gate) || op.reason;
  // SC-12 §六.3 + §四.5：满意度×重要性的渲染门槛以服务端判定为准（≥3 个可比对象 + 可追溯依据），
  // 旧图散点消费 computeOpportunityMap 内同一 ScatterGate 函数的结论（op.scatterGate），
  // 与 foundation.modules.satisfactionScatter 共用一套门槛逻辑，不由两套逻辑分别决定是否画图。
  const satGate = op && (op as any).scatterGate ? (op as any).scatterGate
    : (oppView.view && oppView.view.foundation ? oppView.view.foundation.modules.satisfactionScatter : null);
  const satBlocked = !!(satGate && !satGate.available);
  if (op.hidden && (voiceGate === 'no_evidence_backed_polarity' || voiceGate === 'insufficient_sample')) {
    const vb = op.voiceBasis || {};
    return (
      <div ref={wrapRef}>
        <div className="page-head">
          <div>
            <h2>市场机会</h2>
            <p className="desc">口碑机会 · 重要但没人做好的地方；卖点空缺来自空白视图。</p>
          </div>
        </div>
        <UnifiedOpportunityBasis projectId={urlProjectId} view={oppView.view} />
        <div className="ws-head">
          <h3>口碑机会 · 尚不足以形成满意度判断</h3>
          <p className="ws-prelim-banner">
            ⚠️ <b>已采集用户声音，但缺可解释的正负分类</b>：{voiceGate === 'insufficient_sample' ? '合格样本不足' : '评论尚未完成带依据的正负分类'}，
            因此这里<b>不出「满意度 × 重要性」散点图，也不按相对百分位标「重点机会」</b>。
          </p>
          <ul>
            <li>已采集的可核验公开评论观察：{vb.collected || 0} 条</li>
            <li>合格输入：{vb.qualified || 0} 条（需要 polarity + sentimentBasis + 证据/快照 + 来源 URL + 观察时间 + 项目内竞品归属（competitorId））</li>
            <li>中性或未分类评论既不当作正面也不当作负面，不进满意度分子或分母——「暂不形成判断」是诚实的结论，不是缺数据。</li>
          </ul>
          <p className="hint">
            下一步：① 到「竞品数据库 → 品牌档案 → 用户声音与公开评论」补齐更多公开评论页采集（每条都会留来源、快照与证据）；
            ② 情绪/主题分类需要可解释依据（来源原始字段 / 确定性规则 / 可追溯模型提取），在此之前本页不生成满意度判断。
          </p>
        </div>
        <MarketGapSection state={state!} />
      </div>
    );
  }

  // ▶ P1b：薄样本优雅降级——不再塌成空屏，展示已算出的初步主题 + 显著「初步·样本不足」横幅
  if (op.hidden) {
    const pt = op.preliminaryThemes || [];
    const reasonLine =
      op.reason === 'need_more_voice'
        ? <>需要至少 <b>3</b> 家竞争品牌采到评论主题或抱怨点。当前 <b>{op.brandsWithVoice}</b> / {op.doneBrands} 家有声音（{op.coveragePct}%）。</>
        : <>需要至少 <b>3</b> 家已就绪竞争品牌，当前 <b>{op.doneBrands}</b> 家。</>;
    return (
      <div ref={wrapRef}>
        <div className="page-head">
          <div>
            <h2>市场机会</h2>
            <p className="desc">口碑机会 · 重要但没人做好的地方；卖点空缺来自空白视图。</p>
          </div>
        </div>
        <UnifiedOpportunityBasis projectId={urlProjectId} view={oppView.view} />
        <div className="ws-head">
          <h3>机会地图 · 初步（样本不足）</h3>
          <p className="ws-prelim-banner">⚠️ <b>初步信号 · 样本不足</b>：以下不是正式机会图，仅列出目前已识别的用户声音主题，<b>不作排序结论、不标重点机会</b>。{reasonLine}</p>
          <p className="hint">补齐办法：在全景汇报里点开某个品牌卡 → 「补充口碑这块数据」，只补这一块，不用重跑全研。</p>
        </div>
        <MarketGapSection state={state!} />
        {pt.length ? (
          <>
            <p className="pano-tip">分母：{op.brandsWithVoice} / {op.doneBrands} 家已就绪竞争品牌采到了用户声音（覆盖率 {op.coveragePct}%），共 {op.mentionsTotal} 条提及。</p>
            <p className="pano-tip">推理：{op.method || ''}</p>
            <div className="ws-section opp-section">
              <h4><span className="opp-zone-dot" style={{ background: '#b9b9b9' }} />已识别主题（{pt.length}）· 初步</h4>
              <p className="ws-desc">下列主题来自现有用户声音，因样本不足未做分区排名；每条仍带分母与来源，可逐条核验。</p>
              <div className="opp-list">
                {pt.map((t) => (
                  <div className="opp-item" data-oid={t.oid} data-itemtype="opportunity" key={t.oid}>
                    <div className="opp-score" style={{ borderColor: '#b9b9b9' }}>
                      <div className="opp-score-v" style={{ color: '#8a8a8a' }}>{t.opportunity}</div>
                      <div className="opp-score-k">机会分*</div>
                    </div>
                    <div className="opp-body">
                      <div className="opp-title">
                        <GidTag oid={t.oid} /> {t.label} <span className="tag warn">初步·样本不足</span>
                      </div>
                      <div className="ws-disclaimer">⚠️ {t.note}</div>
                      <OppSourceTags sources={t.sources} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <p className="hint">当前还没有竞争品牌留出可识别的用户声音（评论主题 / 抱怨点），暂无可展示的初步信号。继续补齐竞争品牌或补采反馈后即可生成正式机会图。</p>
        )}
        {(op.caveats || []).length ? (
          <p className="pano-tip">{(op.caveats || []).map((c) => '· ' + c).join(' ')}</p>
        ) : null}
      </div>
    );
  }

  // 正式机会图
  const z = op.zones || {};
  return (
    <div ref={wrapRef}>
      <div className="page-head">
        <div>
          <h2>市场机会</h2>
          <p className="desc">口碑机会 · 重要但没人做好的地方；卖点空缺来自空白视图。</p>
        </div>
      </div>
      <UnifiedOpportunityBasis projectId={urlProjectId} view={oppView.view} />
      <div className="ws-head">
        <h3>口碑机会 · 重要但没人做好的地方（补充层）</h3>
        <p>
          机会分 = 重要性 + max(重要性 − 满意度, 0)。共聚类出 <b>{op.total}</b> 个用户声音主题，其中 <b>{z.underserved || 0}</b> 个落在「重点机会」区。
          {op.ranked ? null : <b className="warn-txt">覆盖率不足，排序仅供参考。</b>}
          {op.relativeBands ? <> <b className="warn-txt">分区按「相对当前数据」着色（top 15% 重点机会 / 再 35% 中等），下方 O/I/S 为绝对代理值。</b></> : null}
        </p>
      </div>
      <MarketGapSection state={state!} />
      <div className="pano-quad-wrap opp-chart">
        <div className="pano-sec-title">机会分布 · 满意度 × 重要性</div>
        {/* SC-12 §六.3：样本不足不渲染空坐标图（真实数值不变；重叠由碰撞避让处理） */}
        {satBlocked ? (
          <div className="core-opp-gate-block" data-testid="opp-scatter-gated">
            <p className="core-opp-gate">当前评论样本不足，暂不生成满意度分布</p>
            <p className="pano-tip">
              可比对象 {satGate ? satGate.comparableObjects : 0} 个，至少需要 {satGate ? satGate.minObjects : 3} 个带评分且样本范围一致的对象才出图。
              满意度与重要性都需可追溯依据，缺一即不出结论；价格与商品等已有模块不受影响。
            </p>
          </div>
        ) : (
          <OppScatter op={op} hl={hl} onPick={onPick} />
        )}
        <p className="pano-tip">点的大小＝提及广度（多少家竞争品牌的用户声音提到）。空心点＝覆盖率不足、仅供参考。左上角＝需求呼声较高、负面反馈集中，是建议优先验证的机会区域；右侧＝需求已被较好满足，该区域竞争较为充分。</p>
        <p className="pano-tip">分母：{op.brandsWithVoice} / {op.doneBrands} 家已就绪竞争品牌采到了用户声音（覆盖率 {op.coveragePct}%），共 {op.mentionsTotal} 条提及。</p>
        <p className="pano-tip">推理：{op.method}</p>
        {(op.caveats || []).length ? (
          <p className="pano-tip">{(op.caveats || []).map((c) => '· ' + c).join(' ')}</p>
        ) : null}
      </div>
      {ZONE_ORDER.map((zk) => {
        const list = (op.themes || []).filter((t) => t.zone === zk);
        if (!list.length) return null;
        const zone = OPP_ZONE[zk];
        return (
          <div className="ws-section opp-section" key={zk}>
            <h4>
              <span className="opp-zone-dot" style={{ background: zone.color }} />
              {zone.label}（{list.length}）
              {op.relativeBands ? <> <span className="tag rel">相对当前数据</span></> : null}
            </h4>
            <p className="ws-desc">{ZONE_DESC[zk]}</p>
            <div className="opp-list">
              {list.map((t) => (
                <OppItem key={t.oid} t={t} hl={hl === t.oid} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
