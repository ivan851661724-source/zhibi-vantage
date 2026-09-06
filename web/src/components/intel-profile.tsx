'use client';
// 情报库 · 对手六维档案（Phase 3：复刻 app.js renderIntelTab L2201-2216 / renderIntelProfile L2134-2198）
// 六字段折叠：价格 / 渠道 / 品类 / 上新节奏 / 口碑 / 空白。每个字段带证据等级与来源，可逐条核对。
// 值级核验渲染复刻：priceFieldHTML / channelFieldHTML / scalarFieldHTML / themeChip / L1_ITEMS（L2837-3267）
import { useEffect, useState, type ReactNode } from 'react';
import { apiGet, apiPost } from '@/lib/api';
import { toast } from '@/lib/toast';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { LABELS, lbl } from '@/lib/labels';
import type { Competitor, ZhibiState } from '@/types/state';

// ---- 基础字典（移植 app.js 顶部常量） ----
const REL_LABEL: Record<string, string> = {
  direct: '直接对手',
  indirect: '间接对手',
  unrelated: '暂不直接相关',
  undetermined: '关系待定',
};
const TIER_LABEL: Record<string, string> = {
  large: '头部大牌',
  mid: '腰部品牌',
  small: '独立小众',
  emerging: '新兴品牌',
  unknown: '体量未明',
};
const SP_ZH: Record<string, string> = {
  affordablePrice: '平价 / 高性价比', premiumMaterial: '高端材质 / 溢价', customization: '可定制 / 个性化',
  fastShipping: '快发货 / 即时交付', ecoFriendly: '环保可持续', limitedEdition: '限量 / 稀缺',
  handmade: '手作 / 匠心', personalGift: '礼品属性', localCulture: '在地 / 本地文化',
  innovation: '科技创新', designAesthetic: '设计感', serviceWarranty: '服务 / 质保',
  healthSafe: '健康安全', convenience: '便捷省心', naturalOrganic: '天然有机', exclusive: '独家 / 会员专属',
};
const SRC_ICON: Record<string, string> = {
  official: '🏪官网', shopify: '💲实抓价格', etsy: '🧵Etsy', tiktokShop: '🎵TK', amazon: '📦Amazon',
  reputation: '💬口碑', moves: '📰动态', 'neg-check': '✅核查',
};

function prettyKey(k: string): string {
  if (!k) return k;
  if (/[一-龥]/.test(k)) return k;
  return k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).trim();
}

function curSym(cur: string): string {
  return ({ GBP: '£', USD: '$', CNY: '¥', EUR: '€', JPY: '¥' } as Record<string, string>)[cur] || cur || '';
}

// 品牌价位区间（结构化 pricePoints，原币种；移植 L133-137）
export function compPriceRange(c: Competitor): { min: number; max: number; currency: string } | null {
  const p = ((c.pricePoints as number[]) || []).filter((n) => typeof n === 'number' && !isNaN(n));
  if (p.length) return { min: Math.min(...p), max: Math.max(...p), currency: (c.currency as string) || '' };
  return null;
}

// 价格是否重叠或相邻（跨币种不比，null = 不可判定；移植 L139-148）
function priceOverlapOrAdjacent(c: Competitor, prof: { priceBand?: { min: number; max: number; currency?: string } } | null): boolean | null {
  if (!prof || !prof.priceBand) return null;
  const pr = compPriceRange(c);
  if (!pr) return null;
  const pb = prof.priceBand;
  if (pb.currency && pr.currency && pb.currency !== pr.currency) return null;
  if (!(pr.max < pb.min || pr.min > pb.max)) return true; // 重叠
  const span = Math.max(pb.max - pb.min, 1);
  return Math.abs(pr.max - pb.min) <= span * 0.4 || Math.abs(pr.min - pb.max) <= span * 0.4; // 相邻
}

function fmtRating(c: Competitor): string {
  const r = (c.reviews as { rating?: number } | undefined)?.rating || (c.ratingField as { value?: number } | undefined) || null;
  if (!r) return '评分未明';
  const v = (r as { value?: number; rating?: number }).value != null ? (r as { value?: number }).value : (r as { rating?: number }).rating;
  const n = (r as { count?: number; reviews?: number }).count != null ? (r as { count?: number }).count : (r as { reviews?: number }).reviews ?? null;
  if (v == null) return '评分未明';
  return n != null ? `${v}（${n} 评）` : `${v}`;
}

// ---- 证据标签（呈现层反转：内部门禁/置信不显示，仅 verified/inferred/conflict 三态；L2111-2116 / L3116-3121） ----
function intelEvTag(basis?: string): ReactNode {
  if (basis === 'verified') return <span className="ev ev-ok">已核实</span>;
  if (basis === 'inferred') return <span className="ev ev-warn">推算</span>;
  if (basis === 'conflict') return <span className="ev ev-crisis">冲突</span>;
  return <span className="ev ev-unk">未探测</span>;
}
function confBadge(k: { basis?: string } | undefined): ReactNode {
  if (!k) return null;
  if (k.basis === 'inferred') return <span className="tag inferred">推算</span>;
  if (k.basis === 'conflict') return <span className="tag">冲突</span>;
  return null;
}

// ---- 来源标签（srcTags L2829-2835 / srcTagsFromSources L3122-3125） ----
interface Src { url?: string; title?: string; text?: string; kind?: string; tier?: number; agrees?: boolean }

function srcTags(c: Competitor, fieldKey: string): ReactNode {
  const arr = ((c.fieldSources as Record<string, Src[]>) || {})[fieldKey];
  if (!arr || !arr.length) return null;
  return arr.slice(0, 3).map((s, i) => (
    <a key={i} className={'src-tag t' + (s.tier || '')} href={s.url || '#'} target="_blank" rel="noopener" title={s.title || ''}>
      {SRC_ICON[s.kind || ''] || '🔗来源'}
    </a>
  ));
}
function srcTagsFromSources(sources?: Src[]): ReactNode {
  if (!sources || !sources.length) return null;
  return sources.map((s, i) => (
    <a key={i} className="src-tag" href={s.url || '#'} target="_blank" rel="noopener" title={s.text || ''}>
      {s.url ? '🔗' : '·'}
    </a>
  ));
}
// 来源（含一致 ✓ / 冲突 ✗ 标记）
function agreeSrcs(sources?: Src[]): ReactNode {
  if (!sources || !sources.length) return null;
  return sources.map((s, i) => (
    <a key={i} className={'src-tag' + (s.agrees === false ? ' disagree' : '')} href={s.url || '#'} target="_blank" rel="noopener" title={(s.text || s.kind || '')}>
      {s.agrees === true ? '✓' : s.agrees === false ? '✗' : '🔗'}
      {s.agrees === true ? ' ✓' : s.agrees === false ? ' ✗' : ''}
    </a>
  ));
}

// ---- 值级核验三件套（L2837-2898） ----
interface FieldLike {
  display?: string;
  basis?: string;
  value?: string;
  state?: string;
  conflictNote?: string | null;
  realScraped?: boolean;
  sources?: Src[];
}

function PriceFieldHTML({ c }: { c: Competitor }) {
  const pf = (c.priceField || {}) as FieldLike;
  if (!pf.display) return null;
  const srcs = agreeSrcs(pf.sources);
  return (
    <>
      <span className={'pf-display' + (pf.basis === 'conflict' ? ' conflict' : '')}>{pf.display}</span>
      <span className="pf-scope" title="所有价格均按官网挂牌标价展示，不含税费与运费，跨币种不换算">官网标价·不含税运</span>
      {pf.realScraped ? <span className="tag">官网实抓</span> : null}
      <div className="pf-meta">
        {pf.conflictNote ? <span className="pf-note warn">⚠ {pf.conflictNote}</span> : null}
        {srcs ? <span className="pf-src">来源：{srcs}</span> : null}
      </div>
    </>
  );
}

function ChannelFieldHTML({ c, chKey }: { c: Competitor; chKey: string }) {
  const cf = (((c.channelFields as Record<string, FieldLike>) || {})[chKey] || {}) as FieldLike & { present?: boolean };
  const st = cf.state || (cf.present ? 'present' : cf.basis === 'verified' ? 'absent' : 'undetected');
  const stText: Record<string, string> = { present: '在售', absent: '确认未入驻', undetected: '暂未发现', conflict: '存在矛盾' };
  const stCls: Record<string, string> = { present: 'present', absent: 'absent-v', undetected: 'und', conflict: 'conflict' };
  const srcs = agreeSrcs(cf.sources);
  return (
    <>
      <span className={'ch-state ' + (stCls[st] || 'und')}>{stText[st] || '—'}</span>
      {cf.conflictNote ? <span className="pf-note warn">⚠ {cf.conflictNote}</span> : null}
      {srcs ? <span className="pf-src">{srcs}</span> : null}
    </>
  );
}

function ScalarFieldHTML({ c, fieldKey }: { c: Competitor; fieldKey: string }) {
  const f = (c[fieldKey] || {}) as FieldLike;
  if (!f.value && f.state !== 'conflict') return null;
  const srcs = agreeSrcs(f.sources);
  return (
    <>
      <span className={'pf-display' + (f.basis === 'conflict' ? ' conflict' : '')}>{f.value || '存在矛盾'}</span>
      {f.conflictNote ? <span className="pf-note warn">⚠ {f.conflictNote}</span> : null}
      {srcs ? <span className="pf-src">{srcs}</span> : null}
    </>
  );
}

function ThemeChip({ item }: { item: { text: string; state?: string; present?: boolean } }) {
  const stMap: Record<string, string> = { present: '在列', absent: '确认无', undetected: '暂未发现', conflict: '矛盾' };
  const st = stMap[item.state || ''] || (item.present ? '在列' : '确认无');
  return (
    <span className={'theme-chip ' + (item.state || 'present')}>
      {item.text} <span className={'theme-state ' + (item.state || 'present')}>{st}</span>
    </span>
  );
}

// field 块（block L3553-3558；横向对比 ⇄ 属旧版模态功能，暂不迁移）
function FieldBlock({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-t">{title}</div>
      <div className="field-v">{children}</div>
    </div>
  );
}

// ---- L1_ITEMS 数据块（有数据才产出；移植 L3135-3267） ----
function PricingItems({ c }: { c: Competitor }) {
  const nodes: ReactNode[] = [];
  const pf = c.priceField as FieldLike | undefined;
  if (pf && pf.display) {
    nodes.push(<FieldBlock key="pf" title="定价（值级核验）"><PriceFieldHTML c={c} /></FieldBlock>);
  } else {
    const band = c.priceBand as { band?: string; range?: string; basis?: string } | undefined;
    const points = (c.pricePoints as number[]) || [];
    if (band || points.length) {
      const sym = curSym((c.currency as string) || '');
      nodes.push(
        <FieldBlock key="pb" title="定价">
          {band ? (
            <>
              <span className="tag">{band.band}</span> {band.range || ''}
              {band.basis === 'inferred' ? <span className="tag inferred">推算</span> : null}
              {srcTags(c, 'priceBand')}
            </>
          ) : null}
          {points.length ? (
            <span className="muted">
              价位点：{sym}{points.slice(0, 12).join(' / ' + sym)}{points.length > 12 ? ' …' : ''}
              {c.priceVerified ? '（官网实抓）' : ''}
            </span>
          ) : null}
          <span className="tag inferred">旧版·重研后启用值级核验</span>
        </FieldBlock>,
      );
    }
  }
  return <>{nodes}</>;
}

function ChannelItems({ c }: { c: Competitor }) {
  const rows = Object.keys(LABELS.channels).map((k) => (
    <div className="ch-row" key={k}>
      <span className="ch-name">{lbl('channels', k)}</span>
      <span className="ch-det"><ChannelFieldHTML c={c} chKey={k} /></span>
    </div>
  ));
  const regions = (c.regions as string[]) || [];
  return (
    <>
      {rows.length ? <FieldBlock title="渠道版图（逐渠道核验）"><div className="ch-grid">{rows}</div></FieldBlock> : null}
      {regions.length ? (
        <FieldBlock title="覆盖地域">
          {regions.map((r) => <span className="tag" key={r}>{lbl('regions', r)}</span>)}
        </FieldBlock>
      ) : null}
    </>
  );
}

function ProductItems({ c }: { c: Competitor }) {
  const nodes: ReactNode[] = [];
  const pm = c.productMatrix as
    | { skuCount?: number; priceBandDist?: string; heroSku?: string[]; productLines?: string[] }
    | undefined;
  const products = (c.products as string[]) || [];
  if (pm && (pm.skuCount || pm.priceBandDist || (pm.heroSku || []).length || (pm.productLines || []).length)) {
    nodes.push(
      <FieldBlock key="pm" title="产品矩阵（纵向深度）">
        <div className="pm-stats">
          {pm.skuCount ? <div className="pm-stat"><b>{pm.skuCount}</b><span>SKU 数(估)</span></div> : null}
          {pm.priceBandDist ? <div className="pm-stat wide"><b>{pm.priceBandDist}</b><span>价格带分布</span></div> : null}
        </div>
        {(pm.heroSku || []).length ? (
          <div className="pm-sub"><span className="pm-sub-k">爆款/主打</span>{pm.heroSku!.map((x) => <span className="tag" key={x}>{x}</span>)}</div>
        ) : null}
        {(pm.productLines || []).length ? (
          <div className="pm-sub"><span className="pm-sub-k">产品线</span>{pm.productLines!.map((x) => <span className="tag soft" key={x}>{x}</span>)}</div>
        ) : null}
      </FieldBlock>,
    );
  } else if (products.length) {
    nodes.push(<FieldBlock key="p" title="产品矩阵">{products.map((p) => <span className="tag soft" key={p}>{p}</span>)}</FieldBlock>);
  }
  const cc = (c.categoryCoverage as { category: string; subCategory?: string; count?: number }[]) || [];
  const cats = (c.categories as string[]) || [];
  if (cc.length) {
    nodes.push(
      <FieldBlock key="cc" title="品类布局（横向广度）">
        {cc.map((x, i) => (
          <div className="cov-row" key={i}>
            <span className="cov-cat">{x.category}</span>
            {x.subCategory ? <span className="cov-sub">› {x.subCategory}</span> : null}
            {x.count != null ? <span className="cov-n">≈{x.count} SKU</span> : null}
          </div>
        ))}
      </FieldBlock>,
    );
  } else if (cats.length && String(cats.slice().sort()) !== String(products.slice().sort())) {
    nodes.push(<FieldBlock key="c" title="品类布局">{cats.map((k) => <span className="tag soft" key={k}>{prettyKey(k)}</span>)}</FieldBlock>);
  }
  const audiences = (c.audiences as string[]) || [];
  if (audiences.length) {
    nodes.push(<FieldBlock key="a" title="目标人群">{audiences.map((a) => <span className="tag" key={a}>{prettyKey(a)}</span>)}</FieldBlock>);
  }
  return <>{nodes}</>;
}

function ReviewItems({ c }: { c: Competitor }) {
  const nodes: ReactNode[] = [];
  const rf = c.reviewField as
    | { rating?: FieldLike & { value?: number }; trend?: FieldLike & { value?: string }; negThemes?: { items?: { text: string; state?: string; present?: boolean }[] }; posThemes?: { items?: { text: string; state?: string; present?: boolean }[] } }
    | undefined;
  if (rf) {
    const r = rf.rating;
    if (r) {
      nodes.push(
        <FieldBlock key="r" title="口碑评分（值级核验）">
          <span className="scalar-val">{r.value != null ? String(r.value) : '—'}</span>
          {confBadge(r)}
          {srcTagsFromSources(r.sources)}
        </FieldBlock>,
      );
    }
    const t = rf.trend;
    if (t) {
      const tlabel = t.value === 'up' ? '↑上升' : t.value === 'down' ? '↓下滑' : t.value === 'stable' ? '→平稳' : '—';
      nodes.push(
        <FieldBlock key="t" title="口碑趋势（值级核验）">
          <span className="scalar-val">{tlabel}</span>
          {confBadge(t)}
          {srcTagsFromSources(t.sources)}
        </FieldBlock>,
      );
    }
    if (rf.negThemes && rf.negThemes.items && rf.negThemes.items.length) {
      nodes.push(<FieldBlock key="n" title="负面主题（逐条核验）"><div className="theme-grid">{rf.negThemes.items.map((i, k) => <ThemeChip key={k} item={i} />)}</div></FieldBlock>);
    }
    if (rf.posThemes && rf.posThemes.items && rf.posThemes.items.length) {
      nodes.push(<FieldBlock key="p" title="正面主题（逐条核验）"><div className="theme-grid">{rf.posThemes.items.map((i, k) => <ThemeChip key={k} item={i} />)}</div></FieldBlock>);
    }
  } else {
    const rv = c.reviews as { rating?: number; trend?: string; posThemes?: string[]; negThemes?: string[]; basis?: string } | undefined;
    if (rv) {
      nodes.push(
        <FieldBlock key="rv" title="口碑走势">
          {rv.rating != null ? <>评分 <b>{rv.rating}</b></> : null}
          {rv.trend ? <span className={'trend ' + rv.trend}>{rv.trend === 'up' ? '↑上升' : rv.trend === 'down' ? '↓下滑' : '→平稳'}</span> : null}
          {(rv.posThemes || []).length ? <span className="muted">好评：{rv.posThemes!.join('、')}</span> : null}
          {(rv.negThemes || []).length ? <span className="warn">差评：{rv.negThemes!.join('、')}</span> : null}
          {rv.basis === 'inferred' ? <span className="tag inferred">推算</span> : null}
          {srcTags(c, 'reviews')}
        </FieldBlock>,
      );
    }
  }
  // F6：横向痛点卡（未解决=机会 / 自述与口碑矛盾）
  const painCards: ReactNode[] = [];
  ((c.painPoints as { point: string; basis?: string }[]) || []).forEach((p, i) => {
    const basis = p.basis || 'inferred';
    painCards.push(
      <div className="pain" key={'pp' + i}>
        <div className="n">{p.point}</div>
        <div className="c">{basis === 'verified' ? '已核实' : '推测'}</div>
        <span className="flag opp">未解决 = 机会</span>
      </div>,
    );
  });
  const nts = (rf && rf.negThemes && rf.negThemes.items) || [];
  nts.forEach((i, k) => {
    if (i.state === 'conflict') {
      painCards.push(
        <div className="pain" key={'ct' + k}>
          <div className="n">{i.text}</div>
          <div className="c">矛盾</div>
          <span className="flag warn">自述与口碑矛盾</span>
        </div>,
      );
    }
  });
  if (painCards.length) {
    nodes.push(<FieldBlock key="pain" title="用户抱怨点（横向痛点卡）"><div className="pain-cards">{painCards}</div></FieldBlock>);
  }
  return <>{nodes}</>;
}

// ---- 三态空白（attemptState / intelBlankItems，L91-131 / L2118-2133） ----
const L1_EMPTY_FIELDS: { fieldKey: string; label: string }[] = [
  { fieldKey: 'price', label: '价格体系' },
  { fieldKey: 'sellingPoints', label: '主打卖点' }, { fieldKey: 'positioning', label: '定位战略' },
  { fieldKey: 'products', label: '产品矩阵' }, { fieldKey: 'audiences', label: '目标人群' },
  { fieldKey: 'channels', label: '渠道版图' },
  { fieldKey: 'reviews', label: '口碑走势' }, { fieldKey: 'painPoints', label: '用户抱怨点' },
  { fieldKey: 'tactics', label: '销售打法' }, { fieldKey: 'contentForms', label: '内容形态' },
  { fieldKey: 'collabTypes', label: '联名方式' }, { fieldKey: 'fulfillment', label: '履约方式' },
  { fieldKey: 'recentMoves', label: '近期动作' }, { fieldKey: 'estSize', label: '估算规模' },
  { fieldKey: 'techStack', label: '技术栈' },
];
const L1_FIELD_LABEL: Record<string, string> = Object.fromEntries(L1_EMPTY_FIELDS.map((f) => [f.fieldKey, f.label]));

interface Attempt { field: string; hit?: boolean; source?: string; time?: string; query?: string }

function fieldHasData(c: Competitor, fieldKey: string): boolean {
  const ch = (c.channels || {}) as Record<string, { present?: boolean }>;
  const rv = c.reviews as { rating?: number; posThemes?: string[]; negThemes?: string[] } | undefined;
  const pm = c.productMatrix as { skuCount?: number; heroSku?: string[]; productLines?: string[]; priceBandDist?: string } | undefined;
  switch (fieldKey) {
    case 'price': return !!((c.pricePoints as number[]) || []).length || !!c.priceBand;
    case 'sellingPoints': return ((c.sellingPoints as string[]) || []).length > 0;
    case 'positioning': return !!c.positioning;
    case 'products': return ((c.products as string[]) || []).length > 0 || !!(pm && (pm.skuCount || (pm.heroSku || []).length || (pm.productLines || []).length || pm.priceBandDist));
    case 'audiences': return ((c.audiences as string[]) || []).length > 0;
    case 'channels': return Object.keys(ch).some((k) => ch[k].present);
    case 'reviews': return !!(rv && (rv.rating != null || (rv.posThemes || []).length || (rv.negThemes || []).length));
    case 'painPoints': return ((c.painPoints as unknown[]) || []).length > 0;
    case 'tactics': return ((c.tactics as unknown[]) || []).length > 0;
    case 'contentForms': return ((c.contentForms as unknown[]) || []).length > 0;
    case 'collabTypes': return ((c.collabTypes as unknown[]) || []).length > 0;
    case 'fulfillment': return ((c.fulfillment as unknown[]) || []).length > 0;
    case 'recentMoves': return ((c.recentMoves as unknown[]) || []).length > 0;
    case 'estSize': return !!c.estSize;
    case 'techStack': return !!c.techStack;
    default: return false;
  }
}

function attemptState(c: Competitor, fieldKey: string): { state: 'has' | 'unprobed' | 'attempted_empty'; sources?: string[]; latest?: string | null } {
  const a = ((c.attempts as Attempt[]) || []).filter((x) => x.field === fieldKey);
  if (!a.length) return { state: fieldHasData(c, fieldKey) ? 'has' : 'unprobed' };
  if (a.some((x) => x.hit) || fieldHasData(c, fieldKey)) return { state: 'has' };
  const sources = Array.from(new Set(a.map((x) => x.source).filter(Boolean) as string[]));
  const dates = a.map((x) => x.time).filter(Boolean).sort() as string[];
  return { state: 'attempted_empty', sources, latest: dates.length ? dates[dates.length - 1] : null };
}

// ---- 六字段折叠盒（intelFieldBox L2101-2109） ----
const INTEL_ICO: Record<string, ReactNode> = {
  price: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" /></svg>,
  channel: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 21V8l8-4 8 4v13M9 21v-6h6v6" /></svg>,
  category: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 4h16v16H4zM4 9h16M9 4v16" /></svg>,
  launch: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>,
  review: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M4 20V9l8-5 8 5v11M9 20v-6h6v6" strokeLinejoin="round" /></svg>,
  blank: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" strokeLinecap="round" /></svg>,
};

function IntelFieldBox({
  icon, colorVar, title, sub, defaultOpen, children,
}: { icon: string; colorVar: string; title: string; sub: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className={'field-box' + (open ? ' open' : '')}>
      <div className="fb-head" onClick={() => setOpen((v) => !v)} role="button" tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setOpen((v) => !v); }}>
        <div className="fb-ico" style={{ background: `var(--${colorVar}-bg)`, color: `var(--${colorVar})` }}>{INTEL_ICO[icon]}</div>
        <div><div className="fb-t">{title}</div><div className="fb-s">{sub}</div></div>
        <span className="fb-arr">›</span>
      </div>
      <div className="fb-body">{children}</div>
    </div>
  );
}

// ---- 私有备注（ensureUserNote / saveUserNote，L2510-2537；/api/user-notes 按用户隔离） ----
function NoteBox({ cid }: { cid: string }) {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setText('');
    apiGet<{ note?: { text?: string } }>(`/api/user-notes?competitorId=${encodeURIComponent(cid)}`)
      .then((r) => { if (alive) { setText((r.note && r.note.text) || ''); setLoaded(true); } })
      .catch(() => { if (alive) { setText(''); setLoaded(true); } });
    return () => { alive = false; };
  }, [cid]);

  async function save() {
    setSaving(true);
    try {
      const r = await apiPost<{ deleted?: boolean }>('/api/user-notes', { competitorId: cid, text });
      setSaved(r.deleted ? '已清除' : '已保存 ✓');
      setTimeout(() => setSaved(''), 2000);
    } catch {
      setSaved('保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="note-box">
      <div className="lbl">私有备注（只在本机生效，不进公共库）</div>
      <textarea className="note-ta" placeholder="例：这家「可动关节」卖点与我们方向重合，重点盯它的新品定价…" value={text} onChange={(e) => setText(e.target.value)} maxLength={5000} />
      <div className="note-hint">你补充的信息只在你自己的页面生效——这是忠实助理的底线，防对手投假数据。</div>
      <div className="notes-actions" style={{ marginTop: 8 }}>
        <button className="btn-mini" type="button" disabled={saving || !loaded} onClick={() => void save()}>保存备注</button>
        <span className="notes-saved">{saved}</span>
      </div>
    </div>
  );
}

// ---- 主档案组件（renderIntelProfile L2134-2198） ----
export function IntelProfile({
  c, state, onCorrect,
}: { c: Competitor; state: ZhibiState; onCorrect: (field?: string) => void }) {
  const prof = ((state.intent as { profile?: { priceBand?: { min: number; max: number; currency?: string } } | null }) || {}).profile || null;
  const rel = (c.relationship || { code: 'undetermined' }) as { code?: string; label?: string };
  const relClsMap: Record<string, string> = { direct: 'rrel-direct', indirect: 'rrel-ref', unrelated: 'rrel-cheap', undetermined: 'rrel-cheap' };
  const relZh = rel.label || REL_LABEL[rel.code || ''] || '关系待定';
  const tierTxt = TIER_LABEL[(c.tier as string) || ''] || '体量未明';
  const osLine = [c.category as string, tierTxt].filter(Boolean).join(' · ') || '—';
  // 档案头指标（P1-3：缺数据口径统一——「未探测」≠ 确认的 0/—）
  const pr = compPriceRange(c);
  const priceTxt = pr
    ? curSym(pr.currency) + pr.min + '–' + pr.max
    : ((c.priceField as FieldLike)?.display) || (c.priceBand as { range?: string })?.range || '未探测';
  const lc = c.launchCadence as FieldLike | undefined;
  const lcTxt = (lc && lc.value) || '未探测';
  const rtTxt0 = fmtRating(c);
  const rtTxt = rtTxt0 === '评分未明' || rtTxt0 === '—' ? '未探测' : rtTxt0;
  const ch = (c.channels || {}) as Record<string, { present?: boolean }>;
  const chN = Object.keys(ch).filter((k) => ch[k] && ch[k].present).length;
  const ovl = priceOverlapOrAdjacent(c, prof);
  const ovlTxt = ovl == null ? '未探测' : ovl === true ? '高' : '中';
  const ovlColor = ovl == null ? 'var(--ink3)' : ovl === true ? 'var(--crisis)' : 'var(--warn)';

  return (
    <div>
      {/* 档案头 */}
      <div className="profile-head">
        <div className="pf-avatar">{((c.name as string) || '?')[0].toUpperCase()}</div>
        <div className="pf-main">
          <div className="pf-nm">
            {c.name as string}{' '}
            <span className={'r-rel ' + (relClsMap[rel.code || ''] || 'rrel-cheap')}>{relZh}</span>{' '}
            <span className="ev ev-ok">档案置信 {c.rankScore ? '高' : '中'}</span>
          </div>
          <div className="pf-tag">{osLine}{c.estSize ? ' · ' + (c.estSize as string) : ''}</div>
          {c.url ? <a className="pf-url" href={c.url as string} target="_blank" rel="noopener">{c.url as string} ↗</a> : null}
          <div className="pf-metrics">
            <div className="pf-m"><span className="k">主力价格带</span><span className="v num">{priceTxt}</span></div>
            <div className="pf-m"><span className="k">上新节奏</span><span className="v">{lcTxt}</span></div>
            <div className="pf-m"><span className="k">口碑</span><span className="v num">{rtTxt}</span></div>
            <div className="pf-m"><span className="k">覆盖渠道</span><span className={chN ? 'v num' : 'v'}>{chN ? <>{chN} <small>个</small></> : '未探测'}</span></div>
            <div className="pf-m"><span className="k">与你重叠</span><span className="v" style={{ color: ovlColor }}>{ovlTxt}</span></div>
          </div>
        </div>
        <div className="pf-acts">
          {/* 旧版开 reportModal（反馈模态）；此处直接进纠错闭环（同一「数据有误」意图的最短路径） */}
          <button className="btn-ghost" type="button" onClick={() => onCorrect()}>发现数据有误？</button>
        </div>
      </div>

      {/* 六字段折叠 */}
      <IntelFieldBox icon="price" colorVar="down" title="价格" sub="price · 实抓 + 推算混合" defaultOpen>
        <div className="fb-value">
          {priceTxt}{' '}
          {(c.priceField as FieldLike)?.basis
            ? intelEvTag((c.priceField as FieldLike).basis)
            : (c.priceBand as { basis?: string })?.basis
              ? intelEvTag((c.priceBand as { basis?: string }).basis)
              : null}
          <span className="sub">· 原币种展示，不换算</span>
        </div>
        <PricingItems c={c} />
        <button className="fb-correct" type="button" onClick={() => onCorrect('price')}>✎ 纠正价格数据（须附证据来源）</button>
      </IntelFieldBox>

      <IntelFieldBox icon="channel" colorVar="new" title="渠道" sub="channels · 集合裁决">
        <ChannelItems c={c} />
      </IntelFieldBox>

      <IntelFieldBox icon="category" colorVar="warn" title="品类" sub="categories · 集合裁决">
        <ProductItems c={c} />
      </IntelFieldBox>

      <IntelFieldBox icon="launch" colorVar="new" title="上新节奏" sub="launch cadence · 标量裁决">
        <ScalarFieldHTML c={c} fieldKey="launchCadence" />
      </IntelFieldBox>

      <IntelFieldBox icon="review" colorVar="crisis" title="口碑" sub="reviews · 复合裁决">
        <ReviewItems c={c} />
      </IntelFieldBox>

      <IntelFieldBox icon="blank" colorVar="unk" title="空白 · 未探测" sub="not detected ≠ 确认没有">
        <BlankItems c={c} />
      </IntelFieldBox>

      <NoteBox cid={c.id} />
    </div>
  );
}

// 空白字段收集：三态（未探测 / 查过没找到）→ fb-item 证据流（≠ 确认没有）
function BlankItems({ c }: { c: Competitor }) {
  const [busy, setBusy] = useState<string | null>(null);
  const { patch } = useZhibiState();

  async function deepdive(fieldKey: string) {
    setBusy(fieldKey);
    const label = L1_FIELD_LABEL[fieldKey] || fieldKey;
    try {
      const r = await apiPost<{ state?: ZhibiState; results?: { ok?: boolean }[] }>('/api/deepdive', {
        competitorId: c.id,
        field: fieldKey,
        level: 'field',
      });
      if (r && r.state) {
        const okN = (r.results || []).filter((x) => x.ok).length;
        patch(r.state); // 对齐旧版 state = r.state; renderAll()
        toast(`「${label}」已补查（命中 ${okN} 项，来源可点开核验）。`);
      } else {
        toast(`「${label}」暂未挖到有效信息。`);
      }
    } catch (e) {
      toast('深挖失败：' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setBusy(null);
    }
  }

  const items: ReactNode[] = [];
  L1_EMPTY_FIELDS.forEach((f) => {
    const a = attemptState(c, f.fieldKey);
    if (a.state === 'unprobed') {
      items.push(
        <div className="fb-item" key={f.fieldKey}>
          <span className="ev ev-unk">未探测</span>
          <span className="nm">{f.label}</span>
          <span className="val" style={{ fontWeight: 500, color: 'var(--ink3)' }}>≠ 确认没有，待重研</span>
          <button className="st-empty unprobed" type="button" title="点此补查" disabled={busy === f.fieldKey} onClick={() => void deepdive(f.fieldKey)}>
            {busy === f.fieldKey ? '深挖中…' : '补查'}
          </button>
        </div>,
      );
    } else if (a.state === 'attempted_empty') {
      const d = a.latest ? new Date(a.latest).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' }) : '';
      items.push(
        <div className="fb-item" key={f.fieldKey}>
          <span className="ev ev-unk">已查未得</span>
          <span className="nm">{f.label}</span>
          <span className="val" style={{ fontWeight: 500, color: 'var(--ink3)' }}>{d ? d + ' 查过' : '查过'}，未找到来源</span>
          <button className="st-empty attempted" type="button" disabled={busy === f.fieldKey} onClick={() => void deepdive(f.fieldKey)}>
            {busy === f.fieldKey ? '深挖中…' : '重研'}
          </button>
        </div>,
      );
    }
  });
  if (!items.length) return <p className="hint">六维字段已全部覆盖，暂无「未探测」项。</p>;
  return <div className="fb-flow">{items}</div>;
}
