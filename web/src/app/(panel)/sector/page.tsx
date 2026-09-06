'use client';
// 赛道档案（Phase 3，复刻 renderSectorTab L1814-1863）
// 四宫格：品类分布 / 价格阶梯 / 渠道覆盖矩阵 / 头部格局（grid 1fr 1fr）。
// 数据全部由前端从 state.competitors 聚合（与旧版同一份计算逻辑，非后端派生）。
import { useMemo } from 'react';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { fmtPrice, lbl } from '@/lib/labels';

interface DoneComp {
  id: string;
  name: string;
  categories?: string[];
  category?: string;
  channels?: Record<string, { present?: boolean; label?: string }>;
  priceField?: { priceBand?: string } | null;
  priceBand?: { band?: string };
  rankScore?: number;
  heroProduct?: { heroProducts?: { name?: string }[] } | null;
  [key: string]: unknown;
}

const QUAD_TITLES = ['品类分布', '价格阶梯', '渠道覆盖', '头部格局'];

function Quad({ title, body }: { title: string; body: React.ReactNode }) {
  const n = QUAD_TITLES.indexOf(title);
  return (
    <div className="sec">
      <div className="sec-h">
        <span className="n">{'①②③④'[n] || '·'}</span>
        {title}
      </div>
      <div className="sec-b">{body}</div>
    </div>
  );
}

export default function SectorPage() {
  const { state, loading } = useZhibiState();

  const agg = useMemo(() => {
    if (!state) return null;
    const cs = ((state.competitors || []) as DoneComp[]).filter((c) => c.status === 'done');
    if (!cs.length) return { cs, catTop: [], chanTop: [], bandTop: [], ranked: [] };
    // 品类分布（粗粒度：按 category 聚合）
    const catCount: Record<string, number> = {};
    cs.forEach((c) => {
      (c.categories && c.categories.length ? c.categories : [c.category || '未分类']).forEach((x) => {
        catCount[x] = (catCount[x] || 0) + 1;
      });
    });
    const catTop = Object.entries(catCount).sort((a, b) => b[1] - a[1]).slice(0, 3);
    // 渠道覆盖（按展示名 label 去重聚合，避免 ch_0_* 等 demo key 泄漏到 UI）
    const chanCount: Record<string, number> = {};
    cs.forEach((c) => {
      const seen = new Set<string>();
      Object.keys(c.channels || {}).forEach((k) => {
        const v = c.channels![k];
        if (v && v.present) {
          const nm = v.label || k;
          if (!seen.has(nm)) {
            seen.add(nm);
            chanCount[nm] = (chanCount[nm] || 0) + 1;
          }
        }
      });
    });
    const chanTop = Object.entries(chanCount).sort((a, b) => b[1] - a[1]).slice(0, 3);
    // 价格阶梯
    const priceBands: Record<string, number> = {};
    cs.forEach((c) => {
      const b = (c.priceField && c.priceField.priceBand) || (c.priceBand && c.priceBand.band);
      if (b) priceBands[lbl('priceBands', b)] = (priceBands[lbl('priceBands', b)] || 0) + 1;
    });
    const bandTop = Object.entries(priceBands).sort((a, b) => b[1] - a[1]).slice(0, 3);
    // 头部格局
    const ranked = cs.slice().sort((a, b) => (b.rankScore || 0) - (a.rankScore || 0)).slice(0, 3);
    return { cs, catTop, chanTop, bandTop, ranked };
  }, [state]);

  if (loading) return <p className="hint">加载赛道档案…</p>;
  if (!state || !agg) return <p className="hint">暂无调研档案，先到工作台发起一次调研。</p>;

  if (!agg.cs.length) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h2>赛道档案</h2>
            <p className="desc">品类分布 / 价格阶梯 / 渠道覆盖 / 头部格局，一屏看清赛道结构。</p>
          </div>
        </div>
        <div className="empty">
          <div className="big">暂无赛道数据</div>
          <div className="sub">完成调研后，这里会展示品类分布 / 价格阶梯 / 渠道覆盖 / 头部格局。</div>
        </div>
      </div>
    );
  }

  const { cs, catTop, chanTop, bandTop, ranked } = agg;
  // 竞争密度口径：≥60% 家做同一件事 = 饱和；≥2 家 = 分散；仅 1 家 = 空白
  const evCls = (n: number) => (n >= Math.ceil(cs.length * 0.6) ? 'ev-ok' : n >= 2 ? 'ev-warn' : 'ev-unk');
  const evLabel = (n: number) => (n >= Math.ceil(cs.length * 0.6) ? '饱和' : n >= 2 ? '分散' : '空白');

  const catHtml = catTop.length ? (
    catTop.map(([k, n]) => (
      <div className="fb-item" style={{ marginBottom: 7 }} key={k}>
        <span className={'ev ' + evCls(n)}>{evLabel(n)}</span>
        <span className="nm">{k}</span>
        <span className="val num">{n}/{cs.length} 家</span>
      </div>
    ))
  ) : (
    <p className="hint">暂无品类数据。</p>
  );

  const bandHtml = bandTop.length ? (
    bandTop.map(([k, n]) => (
      <div className="band-row" key={k}>
        <span className="band-name">{k}</span>
        <div className="band-bar">
          <div className="band-fill" style={{ left: 0, width: `${Math.min(100, n * 20)}%` }} />
        </div>
        <span className="band-price num">{n} 家</span>
      </div>
    ))
  ) : (
    <p className="hint">暂无价格带数据。</p>
  );

  const chanHtml = chanTop.length ? (
    chanTop.map(([k, n]) => (
      <div className="fb-item" style={{ marginBottom: 7 }} key={k}>
        <span className={'ev ' + evCls(n)}>{evLabel(n)}</span>
        <span className="nm">{k}</span>
        <span className="val num">{n}/{cs.length} 家</span>
      </div>
    ))
  ) : (
    <p className="hint">暂无渠道数据。</p>
  );

  const headHtml = ranked.map((c, i) => (
    <div className="fb-item" style={{ marginBottom: 7 }} key={c.id}>
      <span className={'ev ' + (i === 0 ? 'ev-ok' : i === 1 ? 'ev-warn' : 'ev-unk')}>
        {i === 0 ? '头部' : i === 1 ? '新兴' : '快时尚'}
      </span>
      <span className="nm">
        {c.name}
        {c.heroProduct && c.heroProduct.heroProducts && c.heroProduct.heroProducts[0]
          ? ' · ' + c.heroProduct.heroProducts[0].name
          : ''}
      </span>
      <span className="val">{fmtPrice(c)} 起</span>
    </div>
  ));

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>赛道档案</h2>
          <p className="desc">品类分布 / 价格阶梯 / 渠道覆盖 / 头部格局，一屏看清赛道结构。</p>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Quad title="品类分布 · 谁在做什么" body={catHtml} />
        <Quad title="价格阶梯 · 市场带" body={bandHtml} />
        <Quad title="渠道覆盖矩阵" body={chanHtml} />
        <Quad title="头部格局 · 关系定位" body={headHtml} />
      </div>
    </div>
  );
}
