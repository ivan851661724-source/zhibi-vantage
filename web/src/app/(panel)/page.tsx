'use client';
// 工作台（Phase 2：onboarding + discover 进度 + 材料流三动作，复刻 renderWorkbench L1623-1656）
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { useDiscover, type DiscoverCard } from '@/hooks/use-discover';
import { OverviewCards } from '@/components/overview-cards';
import { EvidenceBar, type EvidenceDist } from '@/components/evidence-bar';
import { GuideTour, guideNeeded } from '@/components/guide-tour';
import { WaitlistForm } from '@/components/waitlist-form';
import { MaterialDrawer } from '@/components/wb-drawer';
import { apiPost } from '@/lib/api';
import {
  fetchBrands, fetchWorkbenchCards, retryFirstCollection,
  type BrandsHealthSummary, type WorkbenchCardsResponse, type WorkbenchObservationCard,
} from '@/lib/core-api';
import {
  useWbDecisions,
  wbDayGroups,
  wbEvidence,
  wbMoney,
  wbBrandName,
  wbBrandUrl,
  wbWhen,
  wbSignalOf,
  wbTypeGroup,
  wbTypeLabel,
  type WbAction,
  type WbMaterial,
} from '@/lib/wb';

// 发现阶段实时骨架卡（复刻 buildBrandCard L703-722）
const TIER_LABEL: Record<string, string> = { large: '头部', mid: '腰部', small: '小体量', emerging: '新兴' };

function LiveBrandCard({ card, lead }: { card: DiscoverCard; lead: boolean }) {
  return (
    <article className="card status-skeleton brand-live">
      <div className="card-head">
        <div className="card-title">
          <h3>{card.name}</h3>
          {card.url ? (
            <a className="ext" href={card.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>
              ↗
            </a>
          ) : null}
        </div>
        <div className="badges">
          <span className={'pill tier ' + (card.tier || 'unknown')}>{TIER_LABEL[card.tier || ''] || '体量未明'}</span>
          {card.matchScore ? <span className="pill match">匹配 {card.matchScore}</span> : null}
          <span className={'pill st' + (lead ? ' researching' : '')}>{lead ? '检索中…' : '待调研'}</span>
        </div>
      </div>
      {card.why ? <p className="why">{card.why}</p> : null}
      <p className="hint">{lead ? '正在确认是否为竞争品牌…' : '已识别，等待 AI 逐家深研…'}</p>
    </article>
  );
}

function PriceHTML({ m }: { m: WbMaterial }) {
  const p = m.price;
  if (!p || (p.old == null && p.new == null)) return null;
  const cur = p.currency || 'USD';
  const up = (p.deltaPct || 0) > 0;
  return (
    <div className="mat-price">
      {p.old != null ? <span className="mp-old num">{wbMoney(p.old, cur)}</span> : null}
      <span className={'mp-new num' + (up ? ' up' : '')}>{wbMoney(p.new as number, cur)}</span>
      {p.deltaPct != null ? (
        <span className={'mp-delta num' + (up ? ' up' : '')}>
          {up ? '▲' : '▼'} {Math.abs(p.deltaPct as number)}%
        </span>
      ) : null}
      {p.range ? (
        <span className="mp-range">
          观察到的价格范围 {wbMoney(p.range.min, cur)} – {wbMoney(p.range.max, cur)}
        </span>
      ) : null}
    </div>
  );
}

function MaterialCard({
  m,
  decision,
  onSet,
  onOpen,
}: {
  m: WbMaterial;
  decision: WbAction | undefined;
  onSet: (id: string, act: WbAction | '') => void;
  onOpen: (id: string) => void;
}) {
  const ev = wbEvidence(m);
  const done = !!decision;
  const burl = wbBrandUrl(m);
  // 来源标签降噪：「实抓 N 款」「LLM 价格点推算」是取数方式说明，不在卡片上展示（抽屉里仍可溯源）
  const srcs = (m.sources || []).filter((s) => {
    const label = typeof s === 'string' ? s : s.label || '';
    return !/^实抓\s*\d+\s*款/.test(label) && !/LLM\s*价格点推算/.test(label);
  });
  return (
    <div className={'mat ' + wbSignalOf(m) + (done ? ' done' : '')}>
      <div className="mat-body" style={{ cursor: 'pointer' }} onClick={() => onOpen(m.id)}>
        <div className="mat-top">
          <span className={'mtype mt-' + wbSignalOf(m)}>{wbTypeLabel(m)}</span>
          <span className="mat-brand">
            {wbBrandName(m)}
            {burl ? <span className="burl">{burl}</span> : null}
          </span>
          <span className="mat-when">{wbWhen(m)}</span>
        </div>
        <PriceHTML m={m} />
        <div className="mat-facts">
          {srcs.map((s, i) => {
            const so = typeof s === 'string' ? { label: s } : s;
            return (
              <a
                key={i}
                className="src"
                href={so.url || '#'}
                target="_blank"
                rel="noopener"
                onClick={(e) => e.stopPropagation()}
              >
                {so.label || String(s)}
              </a>
            );
          })}
          <span className={'ev ' + ev.cls}>{ev.txt}</span>
        </div>
        {m.inference && (m.inference.text || m.inference.why) ? (
          <div className="mat-risk">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l10 18H2z" strokeLinejoin="round" /><path d="M12 10v4M12 17h.01" strokeLinecap="round" /></svg>
            <div>
              {m.inference.text || ''}
              <span className="rwhy">为什么这么推：{m.inference.why || ''} —— 推算项，请自行判断</span>
            </div>
          </div>
        ) : null}
      </div>
      <div className="mat-acts">
        <button className="btn-act act-keep" type="button" onClick={() => onSet(m.id, 'keep')}>✓ 收录</button>
        <button className="btn-act act-later" type="button" onClick={() => onSet(m.id, 'later')}>稍后处理</button>
        <button className="btn-act act-drop" type="button" onClick={() => onSet(m.id, 'ignore')}>忽略</button>
      </div>
      {done ? (
        <div className="mat-donebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 13l4 4 10-10" strokeLinecap="round" /></svg>
          <span className="db-text">{decision === 'keep' ? '收录' : decision === 'ignore' ? '忽略' : '稍后'}</span>
          <span className="undo" role="button" tabIndex={0} onClick={() => onSet(m.id, '')}>撤销</span>
        </div>
      ) : null}
    </div>
  );
}

// ---------------- r4 §三：竞品价格观察卡（真实观察；无伪判断） ----------------
function obsMoney(v: number | null | undefined, cur: string | null): string {
  if (v == null) return '—';
  const sym = ({ GBP: '£', USD: '$', CNY: '¥', EUR: '€' } as Record<string, string>)[cur || ''] || (cur || '') + ' ';
  return sym + Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function obsWhen(iso: string | null | undefined): string {
  if (!iso) return '时间未记录';
  try {
    const mins = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 60) return mins + ' 分钟前';
    const h = Math.round(mins / 60);
    if (h < 24) return h + ' 小时前';
    return Math.round(h / 24) + ' 天前';
  } catch { return String(iso).slice(0, 10); }
}

function ObsCard({ c, decision, onSet, onOpen }: {
  c: WorkbenchObservationCard;
  decision: WbAction | undefined;
  onSet: (id: string, act: WbAction | '') => void;
  onOpen: (id: string) => void;
}) {
  const done = !!decision;
  const ev = c.evidence;
  return (
    <div className={'mat obs' + (done ? ' done' : '')}>
      <div className="mat-body" style={{ cursor: 'pointer' }} onClick={() => onOpen(c.cardId)}>
        <div className="mat-top">
          <span className="mtype mt-price">价格观察</span>
          <span className="mat-brand">
            {c.brandName}
            {c.usingPreviousData ? <span className="burl">沿用上次采集</span> : null}
          </span>
          <span className="mat-when">{obsWhen(c.observedAt)}</span>
        </div>
        <div className="mat-price">
          <span className="mp-new num">{obsMoney(c.price.median, c.currency)}</span>
          {c.price.min != null && c.price.max != null && c.price.min !== c.price.max ? (
            <span className="mp-range num">{obsMoney(c.price.min, c.currency)} – {obsMoney(c.price.max, c.currency)}</span>
          ) : null}
          <span className="mp-range">在售 {c.availableCount} / {c.productCount} 款</span>
        </div>
        <div className="mat-facts">
          <span className="src">{c.source.label}</span>
          {ev && ev.count ? (
            <span className="ev ev-ok">已核实{ev.count > 1 ? `（${ev.count} 条观察）` : ''}</span>
          ) : (
            <span className="ev ev-unk">未探测</span>
          )}
        </div>
      </div>
      <div className="mat-acts">
        <button className="btn-act act-keep" type="button" onClick={() => onSet(c.cardId, 'keep')}>✓ 收录</button>
        <button className="btn-act act-later" type="button" onClick={() => onSet(c.cardId, 'later')}>稍后处理</button>
        <button className="btn-act act-drop" type="button" onClick={() => onSet(c.cardId, 'ignore')}>忽略</button>
      </div>
      {done ? (
        <div className="mat-donebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 13l4 4 10-10" strokeLinecap="round" /></svg>
          <span className="db-text">{decision === 'keep' ? '收录' : decision === 'ignore' ? '忽略' : '稍后'}</span>
          <span className="undo" role="button" tabIndex={0} onClick={() => onSet(c.cardId, '')}>撤销</span>
        </div>
      ) : null}
    </div>
  );
}

// 观察抽屉：只渲染实际有内容的章节；不展示内部 ID / 内部词表；证据行含来源页/URL/时间/核验。
function ObsDrawer({ c, onClose }: { c: WorkbenchObservationCard; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const ev = c.evidence;
  const first = ev && ev.first ? ev.first : null;
  return (
    <>
      <div className="drawer-mask on" onClick={onClose} />
      <div className="drawer on" aria-hidden="false">
        <div className="dr-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dr-title">
              <span className="mtype mt-price">价格观察</span>
              {c.brandName} <span className="ev ev-ok">已核实</span>
            </div>
            <div className="dr-sub">观察于 {obsWhen(c.observedAt)} · 来源 {c.source.label}</div>
          </div>
          <button className="dr-close" aria-label="关闭" type="button" onClick={onClose}>✕</button>
        </div>
        <div className="dr-body">
          <div className="sec">
            <div className="sec-h"><span className="n">1</span>当前价格</div>
            <div className="sec-b">
              <div className="price-cmp">
                <div className="pc-new">
                  <div className="k">在售商品价格中位数{c.currency ? `（${c.currency}）` : ''}</div>
                  <div className="v num">{obsMoney(c.price.median, c.currency)}</div>
                </div>
              </div>
              {c.price.min != null && c.price.max != null ? (
                <p className="hint">观察到的价格范围：{obsMoney(c.price.min, c.currency)} – {obsMoney(c.price.max, c.currency)}（{c.productCount} 款在售商品的实际标价，非市场判断）</p>
              ) : null}
              <p className="hint">在售 {c.availableCount} 款 · 缺货/下架 {c.soldOutCount} 款。单次观察不构成涨跌判断。</p>
            </div>
          </div>
          {first ? (
            <div className="sec">
              <div className="sec-h"><span className="n">2</span>证据来源 · 逐条可验</div>
              <div className="sec-b">
                <div className="src-list">
                  <div className="src-row">
                    <span className="ev ev-ok">实抓</span>
                    <div className="txt">
                      {first.sourceUrl ? (
                        <a href={first.sourceUrl} target="_blank" rel="noopener" className="core-text-link">来源页面 ↗</a>
                      ) : '来源页面'}
                      <br />
                      <span className="u">{first.sourceUrl || ''}</span>
                    </div>
                    <span className="tier">{first.observedAt ? '观察于 ' + obsWhen(first.observedAt) : ''}</span>
                  </div>
                </div>
                <p className="hint">本次观察共 {ev.count} 条商品级记录，均来自公开商品页实抓（含快照与核验状态）。</p>
              </div>
            </div>
          ) : null}
        </div>
        <div className="dr-foot">
          <button className="btn-act act-keep" type="button" onClick={onClose}>关闭</button>
        </div>
      </div>
    </>
  );
}

const STATE_FILTERS = ['all', 'pending', 'kept', 'dropped'] as const;
const TYPE_FILTERS = ['down', 'new', 'channel', 'crisis'] as const;
const FILTER_LABELS: Record<string, string> = {
  all: '全部', pending: '待处理', kept: '已收', dropped: '已忽略',
  down: '跟价', new: '上新', channel: '新渠道', crisis: '口碑',
};

export default function WorkbenchPage() {
  return (
    <Suspense fallback={<p className="hint">加载工作台…</p>}>
      <WorkbenchInner />
    </Suspense>
  );
}

function WorkbenchInner() {
  const { state, loading, refresh } = useZhibiState();
  const discover = useDiscover();
  const [decisions, setDecision] = useWbDecisions();
  const [stFilter, setStFilter] = useState<(typeof STATE_FILTERS)[number]>('all');
  const [tpFilter, setTpFilter] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  // r4 §三：竞品价格观察卡（真实观察；数据缺口只进「数据覆盖」区）
  const [wbCards, setWbCards] = useState<WorkbenchCardsResponse | null>(null);
  const [obsId, setObsId] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const forceOb = searchParams.get('new') === '1';
  // r3 §三：进入工作台即做一次轻量对账（补缺失首采 + 续跑卡住的来源），
  // 并把品牌级来源状态摆到台面上——用户不需要逐品牌点击才开始采集。
  const projectId = searchParams.get('projectId') || (state && state.projectId) || '';
  const [health, setHealth] = useState<BrandsHealthSummary | null>(null);
  const [rechecking, setRechecking] = useState(false);
  const [healthMsg, setHealthMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    apiPost('/api/data-surface/reconcile', { projectId }).catch(() => { /* 对账失败不阻断页面 */ });
    fetchWorkbenchCards(projectId)
      .then(r => { if (alive) setWbCards(r); })
      .catch(() => { /* 观察卡失败不阻断页面；状态保留上一次 */ });
    const load = () => {
      fetchBrands(projectId)
        .then(r => { if (alive) setHealth(r.healthSummary || null); })
        .catch(() => { /* 单次读取失败保留上一次 */ });
    };
    const t = setTimeout(load, 2500);
    return () => { alive = false; clearTimeout(t); };
  }, [projectId]);

  const recheckFailed = async () => {
    if (!projectId || rechecking) return;
    setRechecking(true);
    setHealthMsg(null);
    try {
      const r = await retryFirstCollection(projectId);
      setHealthMsg(r.message || '已重新排队检查失败项');
      const fresh = await fetchBrands(projectId);
      setHealth(fresh.healthSummary || null);
    } catch (e) {
      setHealthMsg(e instanceof Error ? e.message : '重新检查失败，请稍后再试。');
    } finally {
      setRechecking(false);
    }
  };
  // R6：诚实条数据（decorate 实时派生，深研过程中随之更新）
  const evidenceDist = (state ? (state.evidenceDist as EvidenceDist | undefined) : undefined) || undefined;
  // R7.1：首次报告生成后的 5 步导读（一次性）
  const [guide, setGuide] = useState(false);
  useEffect(() => {
    if (!loading && state && (state as Record<string, unknown>).brief && guideNeeded()) setGuide(true);
  }, [loading, state]);

  const msAll = ((state && state.materials) || []) as WbMaterial[];
  const hasTrack = !!(state && (state.track || (state.competitors && state.competitors.length)));
  const showOnboarding =
    !loading &&
    !discover.running &&
    Object.keys(discover.cards).length === 0 &&
    (forceOb || !hasTrack); // 错误不再隐藏表单——错误横幅独立渲染，用户可读完后重试

  // 筛选（复刻 wbPass L1482-1489）
  const ms = useMemo(
    () =>
      msAll.filter((m) => {
        const d = decisions[m.id];
        if (stFilter === 'pending' && d && d !== 'later') return false;
        if (stFilter === 'kept' && d !== 'keep') return false;
        if (stFilter === 'dropped' && d !== 'ignore') return false;
        if (tpFilter && wbTypeGroup(m) !== tpFilter) return false;
        return true;
      }),
    [msAll, decisions, stFilter, tpFilter],
  );

  const counts = useMemo(() => {
    const c = { keep: 0, ignore: 0, later: 0 };
    ms.forEach((m) => {
      const d = decisions[m.id];
      if (d) c[d as 'keep' | 'ignore' | 'later']++;
    });
    return c;
  }, [ms, decisions]);

  const groups = useMemo(() => wbDayGroups(ms), [ms]);
  const liveCards = Object.values(discover.cards);
  const drawerMat = drawerId ? msAll.find((m) => m.id === drawerId) : undefined;
  const obsCard = obsId && wbCards ? wbCards.cards.find((c) => c.cardId === obsId) || null : null;

  async function onLookup(name: string) {
    // 移植 app.js lookup()：POST /api/lookup 同步返回最终 state 后刷新
    try {
      await apiPost('/api/lookup', { name, intent: { goals: [], regions: [], platforms: [], profile: {} } });
      await refresh();
    } catch (e) {
      discover.reset();
      // 失败原地展示（由下方 error 面板兜底）
      window.alert('暂时无法完成品牌检索，请稍后重试。');
    }
  }

  // 发现失败横幅（同步错误如 NO_KEYS/每日配额；独立于进度条渲染，修复错误被吞）
  const errorBanner = discover.error && !discover.running ? (
    <div className="discover-error-box" style={{ margin: '0 0 12px' }}>
      <p className="hint">
        {discover.error.code === 'DISCOVER_QUOTA'
          ? '今日免费调研次数已用完。明天再来，或加入候补名单优先解锁。'
          : discover.error.code === 'NO_KEYS'
            ? '尚未配置 API 密钥：请到「设置」填写搜索源与 LLM 密钥后重试。'
            : '⚠ 本次发现未完成，系统将在后续监测中重新确认。'}
      </p>
      {discover.error.code === 'DISCOVER_QUOTA' && <WaitlistForm />}
    </div>
  ) : null;

  if (showOnboarding) {
    return (
      <div className="wb-page">
        {errorBanner}
        <OverviewCards onDiscover={discover.start} onLookup={onLookup} busy={discover.running} />
      </div>
    );
  }

  return (
    <div className="wb-page">
      {errorBanner}
      {/* 首页 Hero —— 黑底卡片 + 纯白渐变文本 + 白底主操作 */}
      {state?.track ? (
        <section className="wb-hero">
          <div className="wbh-left">
            <div className="wbh-kicker">AI 竞争情报分析师</div>
            <div className="wbh-title">{state.track}</div>
            <div className="wbh-sub">持续监测竞争品牌动态与价格变化</div>
          </div>
          <div className="wbh-right">
            <div className="wbh-stats">
              <div className="wbh-stat"><b>{msAll.length}</b><span>监测动态</span></div>
              <div className="wbh-stat"><b>{counts.keep}</b><span>已采纳</span></div>
              <div className="wbh-stat"><b>{counts.later}</b><span>稍后看</span></div>
            </div>
            <button className="wbh-cta" onClick={() => refresh()}>开始监测</button>
          </div>
          {/* R6.2 诚实条：置于 hero 黑卡底部整行 */}
          <EvidenceBar dist={evidenceDist} className="in-hero" />
        </section>
      ) : null}
      {/* r3：品牌级采集状态（与竞品库/情报库同一份投影）+ 一键重新检查 */}
      {health ? (
        <div className="core-health-strip" data-testid="wb-health" data-needs={health.needsHandling}>
          <span>已建立数据 <b>{health.established}</b></span>
          <span>正在采集 <b>{health.collecting}</b></span>
          <span>有限覆盖 <b>{health.limited}</b></span>
          <span className={health.needsHandling > 0 ? 'is-warn' : ''}>需要处理 <b>{health.needsHandling}</b></span>
          <span className="core-health-weak">覆盖限制 <b>{health.limits}</b></span>
          {health.needsHandling > 0 ? (
            <button type="button" className="btn-mini" disabled={rechecking} onClick={recheckFailed}>
              {rechecking ? '正在重新检查…' : '重新检查失败项'}
            </button>
          ) : null}
          <a className="core-text-link" href={`/brands?projectId=${encodeURIComponent(projectId)}#coverage`}>查看来源明细</a>
          {healthMsg ? <span className="core-health-msg">{healthMsg}</span> : null}
        </div>
      ) : null}
      {/* R7.1：首次报告后的 5 步导读（一次性） */}
      {guide && <GuideTour onDone={() => setGuide(false)} />}
      {/* 进度条（discover 进行中或失败时显示） */}
      {(discover.running || discover.progress) && (
        <div className="progress-wrap">
          <div className="progress-track">
            <div
              className="progress-bar"
              style={{ width: (discover.progress?.pct ?? (discover.error ? 100 : 5)) + '%' }}
            />
          </div>
          <span className="progress-text">
            {discover.error
              ? '⚠ 研究未完成：' + discover.error.message
              : (discover.progress?.label || '正在发现竞争品牌…') +
                (discover.progress?.found ? `（已发现 ${discover.progress.found} 个）` : '') +
                (evidenceDist && evidenceDist.total
                  ? `（已查实 ${evidenceDist.verified}/${evidenceDist.total} 项）`
                  : '')}
          </span>
        </div>
      )}

      {/* 发现阶段：实时骨架卡 */}
      {liveCards.length > 0 && (
        <div className="pano-cards">
          {liveCards.map((c) => (
            <LiveBrandCard key={c.id} card={c} lead={false} />
          ))}
        </div>
      )}

      {/* 筛选 chips（状态 × 类型双组单选，复刻 bindWbFilters） */}
      {msAll.length > 0 && (
        <div className="filters">
          {STATE_FILTERS.map((f) => (
            <button key={f} className={'chip' + (stFilter === f ? ' on' : '')} type="button" onClick={() => setStFilter(f)}>
              {FILTER_LABELS[f]}
            </button>
          ))}
          <span className="sep"></span>
          {TYPE_FILTERS.map((f) => (
            <button
              key={f}
              className={'chip' + (tpFilter === f ? ' on' : '')}
              type="button"
              onClick={() => setTpFilter(tpFilter === f ? null : f)}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </div>
      )}

      {/* r4 §三：竞品价格观察（真实观察卡）+ 数据覆盖（缺口不进行动卡） */}
      {wbCards && (wbCards.cards.length > 0 || wbCards.coverage.missingPriceBrands.length > 0) ? (
        <>
          <div className="wb-sec-head" data-testid="wb-observations">
            <h3>竞品价格观察</h3>
            <span className="hint">
              来自官网在售商品页实抓；单次观察不构成涨跌或趋势判断。
              {wbCards.market ? `（${wbCards.market.currency} 观察 ${wbCards.market.brandCount} 家：${obsMoney(wbCards.market.min, wbCards.market.currency)} – ${obsMoney(wbCards.market.max, wbCards.market.currency)}）` : ''}
            </span>
          </div>
          <div className="pano-cards">
            {wbCards.cards.map((c) => (
              <ObsCard key={c.cardId} c={c} decision={decisions[c.cardId]} onSet={setDecision} onOpen={setObsId} />
            ))}
          </div>
        </>
      ) : null}
      {wbCards && wbCards.coverage.missingPriceBrands.length > 0 ? (
        <div className="core-warn-box" data-testid="wb-coverage" style={{ margin: '8px 0 16px' }}>
          <b>数据覆盖</b>
          <p className="hint">{wbCards.coverage.note}</p>
          <p className="hint">
            已观察到价格的品牌 {wbCards.coverage.observedBrands} / 项目品牌 {wbCards.coverage.totalBrands}。
            这些是采集缺口说明，不是判断卡。
          </p>
        </div>
      ) : null}

      {/* 材料流 */}
      <div className="workbench-wrap" id="workbenchWrap">
        {msAll.length === 0 ? (
          <div className="empty">
            <div className="big">{discover.running ? '正在调研…' : '暂无材料'}</div>
            <div className="sub">完成一次调研后，Agent 会在这里推送跟价 / 上新 / 新渠道 / 口碑材料。</div>
          </div>
        ) : ms.length === 0 ? (
          <div className="empty">
            <div className="big">没有符合条件的材料</div>
            <div className="sub">试试切换筛选，或先处理几份材料。</div>
          </div>
        ) : (
          groups.map((g) => (
            <div className="day-group" key={g.label}>
              <div className="day-label">{g.label}</div>
              {g.list.map((m) => (
                <MaterialCard key={m.id} m={m} decision={decisions[m.id]} onSet={setDecision} onOpen={setDrawerId} />
              ))}
            </div>
          ))
        )}
        {ms.length > 0 && (
          <p className="hint wb-summary">
            共 {ms.length} 条 · 已收 {counts.keep} · 稍后 {counts.later} · 忽略 {counts.ignore}
          </p>
        )}
      </div>

      {/* 材料详情抽屉（仅当存在真实材料；观察卡用专用抽屉） */}
      {obsCard ? (
        <ObsDrawer c={obsCard} onClose={() => setObsId(null)} />
      ) : null}
      {drawerMat ? (
        <MaterialDrawer m={drawerMat} decision={decisions[drawerMat.id]} onSet={setDecision} onClose={() => setDrawerId(null)} />
      ) : null}
    </div>
  );
}
