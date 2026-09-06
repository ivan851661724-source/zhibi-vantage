'use client';
// 机会视图（Phase 3，复刻 renderOpportunity L1200-1301 + oppScatterSvg L1115-1168
//   + oppSourceTags L1169-1175 + oppMarketGapSection L1177-1199 + OPP_ZONE L1110-1114）
// 铁律：分母常驻可见、每条可溯源、置信度封顶「中」、覆盖率不足不作排序结论。
// 结构：卖点空缺（市场空缺，来自空白视图）默认主层 → 口碑机会（满意度×重要性）补充层。
// 交互：散点图点 → 高亮下方对应卡片并平滑滚动（复刻 L1292-1299）。
import { useMemo, useRef, useState } from 'react';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import type { ZhibiState } from '@/types/state';

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

const ZONE_ORDER = ['underserved', 'moderate', 'served'] as const;
const ZONE_DESC: Record<string, string> = {
  underserved: '重要性高、满意度低：多家对手的用户都在抱怨同一件事，且无人被夸做得好。',
  moderate: '有一定普遍性、满意度中等：值得盯，但先确认它是否是你的目标人群真正在乎的。',
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
      <h4><span className="opp-zone-dot" style={{ background: '#1f6fb2' }} />卖点空缺 / 市场空缺（对手没占的空位 · 来自空白视图）</h4>
      <p className="ws-desc">下列空位来自「空白视图」：供给侧无人占据、且（需求侧有证据，或薄样本下不定为无需求）。这是最该盯的切入线索；口碑驱动的补充机会见下方「口碑机会」层。</p>
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
                  <span className="gid">{g.gid}</span> {g.value || ''} {silent ? <span className="tag warn">沉默需求·待验证</span> : null}
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
  const W = 620, H = 380, padL = 54, padR = 22, padT = 22, padB = 48;
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
      const right = lx > W - padR - 60;
      const txt = (t.label || '').length > 9 ? (t.label || '').slice(0, 9) + '…' : t.label || '';
      label = { x: right ? cx - r - 4 : lx, y: cy + 3.5, text: txt, anchor: right ? 'end' : 'start' };
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
        const anchor = lx > W - padR - 70 ? 'end' : 'start';
        const tx = anchor === 'end' ? b.x - b.r - 6 : lx;
        const txt = (b.t.label || '').length > 10 ? (b.t.label || '').slice(0, 10) + '…' : b.t.label || '';
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
          <span className="gid">{t.oid}</span> {t.label}
          {t.coverageInsufficient ? <span className="tag warn">覆盖率不足</span> : null}
        </div>
        <div className="opp-metrics">
          <span>重要性 <b>{t.importance}</b></span>
          <span>满意度 <b>{t.satisfaction}</b></span>
          <span className="opp-denom-inline">{t.denominatorText}</span>
        </div>
        {t.mergedFrom && t.mergedFrom > 1 ? (
          <div className="opp-merged">
            <span className="muted">合并自：</span>
            {(t.members || []).map((m, i) => <span className="tag" key={i}>{m}</span>)}
          </div>
        ) : null}
        {t.note ? <div className="ws-disclaimer">⚠️ {t.note}</div> : null}
        <div className="ws-method"><span className="muted">推理：</span>{t.method}</div>
        <OppSourceTags sources={t.sources} />
      </div>
    </div>
  );
}

// ---------- 主页面 ----------
export default function OpportunityPage() {
  const { state, loading } = useZhibiState();
  const [hl, setHl] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点图上的点 → 高亮下方对应卡片（复刻 L1292-1299）
  const onPick = (oid: string) => {
    setHl(oid);
    const el = wrapRef.current && wrapRef.current.querySelector(`.opp-item[data-oid="${oid}"]`);
    if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const op = useMemo(() => (state && (state.opportunity as Opportunity)) || null, [state]);

  if (loading) return <p className="hint">加载机会视图…</p>;
  if (!op) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h2>机会视图</h2>
            <p className="desc">口碑机会 · 重要但没人做好的地方；卖点空缺来自空白视图。</p>
          </div>
        </div>
        <div className="ws-empty">
          <h3>机会地图</h3>
          <p>暂无数据。</p>
        </div>
      </div>
    );
  }

  // ▶ P1b：薄样本优雅降级——不再塌成空屏，展示已算出的初步主题 + 显著「初步·样本不足」横幅
  if (op.hidden) {
    const pt = op.preliminaryThemes || [];
    const reasonLine =
      op.reason === 'need_more_voice'
        ? <>需要至少 <b>3</b> 家对手采到评论主题或抱怨点。当前 <b>{op.brandsWithVoice}</b> / {op.doneBrands} 家有声音（{op.coveragePct}%）。</>
        : <>需要至少 <b>3</b> 家已就绪对手，当前 <b>{op.doneBrands}</b> 家。</>;
    return (
      <div ref={wrapRef}>
        <div className="page-head">
          <div>
            <h2>机会视图</h2>
            <p className="desc">口碑机会 · 重要但没人做好的地方；卖点空缺来自空白视图。</p>
          </div>
        </div>
        <div className="ws-head">
          <h3>机会地图 · 初步（样本不足）</h3>
          <p className="ws-prelim-banner">⚠️ <b>初步信号 · 样本不足</b>：以下不是正式机会图，仅列出目前已识别的用户声音主题，<b>不作排序结论、不标重点机会</b>。{reasonLine}</p>
          <p className="hint">补齐办法：在全景汇报里点开某个品牌卡 → 「补充口碑这块数据」，只补这一块，不用重跑全研。</p>
        </div>
        <MarketGapSection state={state!} />
        {pt.length ? (
          <>
            <div className="opp-denom">
              <div className="opp-denom-row"><b>分母</b>：{op.brandsWithVoice} / {op.doneBrands} 家已就绪对手采到了用户声音（覆盖率 {op.coveragePct}%），共 {op.mentionsTotal} 条提及。</div>
              <div className="opp-denom-row"><b>推理</b>：{op.method || ''}</div>
            </div>
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
                        <span className="gid">{t.oid}</span> {t.label} <span className="tag warn">初步·样本不足</span>
                      </div>
                      <div className="opp-metrics">
                        <span>重要性 <b>{t.importance}</b></span>
                        <span>满意度 <b>{t.satisfaction}</b></span>
                        <span className="opp-denom-inline">{t.denominatorText}</span>
                      </div>
                      <div className="ws-disclaimer">⚠️ {t.note}</div>
                      <div className="ws-method"><span className="muted">推理：</span>{t.method}</div>
                      <OppSourceTags sources={t.sources} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : (
          <p className="hint">当前还没有对手留出可识别的用户声音（评论主题 / 抱怨点），暂无可展示的初步信号。继续补齐对手或补采口碑后即可生成正式机会图。</p>
        )}
        <div className="opp-caveats">
          {(op.caveats || []).map((c, i) => (
            <div className="opp-cav" key={i}>· {c}</div>
          ))}
        </div>
      </div>
    );
  }

  // 正式机会图
  const z = op.zones || {};
  return (
    <div ref={wrapRef}>
      <div className="page-head">
        <div>
          <h2>机会视图</h2>
          <p className="desc">口碑机会 · 重要但没人做好的地方；卖点空缺来自空白视图。</p>
        </div>
      </div>
      <div className="ws-head">
        <h3>口碑机会 · 重要但没人做好的地方（补充层）</h3>
        <p>
          机会分 = 重要性 + max(重要性 − 满意度, 0)。共聚类出 <b>{op.total}</b> 个用户声音主题，其中 <b>{z.underserved || 0}</b> 个落在「重点机会」区。
          {op.ranked ? null : <b className="warn-txt">覆盖率不足，排序仅供参考。</b>}
          {op.relativeBands ? <> <b className="warn-txt">分区按「相对当前数据」着色（top 15% 重点机会 / 再 35% 中等），下方 O/I/S 为绝对代理值。</b></> : null}
        </p>
      </div>
      <MarketGapSection state={state!} />
      <div className="opp-denom">
        <div className="opp-denom-row"><b>分母</b>：{op.brandsWithVoice} / {op.doneBrands} 家已就绪对手采到了用户声音（覆盖率 {op.coveragePct}%），共 {op.mentionsTotal} 条提及。</div>
        <div className="opp-denom-row"><b>推理</b>：{op.method}</div>
        <div className="opp-caveats">
          {(op.caveats || []).map((c, i) => (
            <div className="opp-cav" key={i}>· {c}</div>
          ))}
        </div>
      </div>
      <div className="pano-quad-wrap opp-chart">
        <div className="pano-sec-title">机会分布 · 满意度 × 重要性</div>
        <OppScatter op={op} hl={hl} onPick={onPick} />
        <p className="pano-tip">点的大小＝提及广度（多少家对手的用户声音提到）。空心点＝覆盖率不足、仅供参考。左上角＝很多人在乎、但普遍被抱怨，是最值得下注的位置；右侧＝已经被做好了，硬挤是红海。</p>
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
