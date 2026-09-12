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
      <p className="hint">{lead ? '正在确认是否为对手…' : '已识别，等待 AI 逐家深研…'}</p>
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
          市场区间 {wbMoney(p.range.min, cur)} – {wbMoney(p.range.max, cur)}
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
  return (
    <div className={'mat ' + wbSignalOf(m) + (done ? ' done' : '')}>
      <div className="mat-body" style={{ cursor: 'pointer' }} onClick={() => onOpen(m.id)}>
        <div className="mat-top">
          <span className={'mtype mt-' + wbSignalOf(m)}>{wbTypeLabel(m)}</span>
          <span className="mat-brand">
            {wbBrandName(m)}
            {burl ? <span className="burl">{burl}</span> : null}
          </span>
          <span className={'ev ' + ev.cls}>{ev.txt}</span>
          <span className="mat-when">{wbWhen(m)}</span>
        </div>
        <div className="mat-title">{m.summary || m.title || m.body || ''}</div>
        <PriceHTML m={m} />
        {m.sources && m.sources.length ? (
          <div className="mat-facts">
            {m.sources.map((s, i) => {
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
                  {so.label || String(s)} <span className="t">tier-{so.tier || 3}</span>
                </a>
              );
            })}
          </div>
        ) : null}
        {m.inference && (m.inference.text || m.inference.why) ? (
          <div className="mat-risk">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3l10 18H2z" strokeLinejoin="round" /><path d="M12 10v4M12 17h.01" strokeLinecap="round" /></svg>
            <div>
              {m.inference.text || ''}
              <span className="rwhy">为什么这么推：{m.inference.why || ''} —— 推算项，请自行判断</span>
            </div>
          </div>
        ) : null}
        {m.missingFields && m.missingFields.length ? (
          <div className="mat-facts">
            <span className="ev ev-unk">
              未探测：
              {m.missingFields
                .map((x) => (x === 'history:60d' ? '历史价 60 天' : x === 'priceRange' ? '价格未探测' : x))
                .join(' / ')}
              （≠ 确认没有）
            </span>
          </div>
        ) : null}
      </div>
      <div className="mat-acts">
        <button className="btn-act act-keep" type="button" onClick={() => onSet(m.id, 'keep')}>✓ 收了</button>
        <button className="btn-act act-later" type="button" onClick={() => onSet(m.id, 'later')}>先放着</button>
        <button className="btn-act act-drop" type="button" onClick={() => onSet(m.id, 'ignore')}>忽略</button>
      </div>
      {done ? (
        <div className="mat-donebar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 13l4 4 10-10" strokeLinecap="round" /></svg>
          <span className="db-text">{decision === 'keep' ? '收了' : decision === 'ignore' ? '忽略' : '稍后'}</span>
          <span className="undo" role="button" tabIndex={0} onClick={() => onSet(m.id, '')}>撤销</span>
        </div>
      ) : null}
    </div>
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
  const searchParams = useSearchParams();
  const forceOb = searchParams.get('new') === '1';
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

  async function onLookup(name: string) {
    // 移植 app.js lookup()：POST /api/lookup 同步返回最终 state 后刷新
    try {
      await apiPost('/api/lookup', { name, intent: { goals: [], regions: [], platforms: [], profile: {} } });
      await refresh();
    } catch (e) {
      discover.reset();
      // 失败原地展示（由下方 error 面板兜底）
      window.alert('检索失败：' + (e instanceof Error ? e.message : String(e)));
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
            : '研究未完成：' + discover.error.message}
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
      {/* R6.2：顶部诚实条（实查/推测/未探测三色占比，点击展开字段清单） */}
      <EvidenceBar dist={evidenceDist} />
      {/* 首页 Hero —— 对齐 Summarize 规格：薄荷绿渐变卡 + 近黑主操作 */}
      {state?.track ? (
        <section className="wb-hero">
          <div className="wbh-left">
            <div className="wbh-kicker">竞品信号雷达</div>
            <div className="wbh-title">{state.track.name}</div>
            <div className="wbh-sub">{state.track.competitor ? `对手 ${state.track.competitor} · ` : ''}实时捕捉竞品动态与价格异动</div>
          </div>
          <div className="wbh-right">
            <div className="wbh-stats">
              <div className="wbh-stat"><b>{msAll.length}</b><span>监测动态</span></div>
              <div className="wbh-stat"><b>{counts.keep}</b><span>已采纳</span></div>
              <div className="wbh-stat"><b>{counts.later}</b><span>稍后看</span></div>
            </div>
            <button className="wbh-cta" onClick={() => refresh()}>开始监测</button>
          </div>
        </section>
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
              : (discover.progress?.label || '正在搜索对手…') +
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

      {/* 材料详情抽屉（五段式，复刻 openWbDrawer） */}
      {drawerMat ? (
        <MaterialDrawer m={drawerMat} decision={decisions[drawerMat.id]} onSet={setDecision} onClose={() => setDrawerId(null)} />
      ) : null}
    </div>
  );
}
