'use client';
// 情报库（SC-04 UI 框架轮）：「竞争变化收件箱」主体 + 品牌逐字段档案（保留区）。
// 收件箱：顶部摘要（可核实/待核实/资料缺口）+ 品牌/类型/时间/状态筛选 +
// 情报卡（证据入口/纠错入口）；无证据的条目永不使用「已核实」样式。
// 空状态三分：尚无采集结果 / 当前筛选无结果 / 资料不足。
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { FieldCorrectModal } from '@/components/field-correct';
import { IntelProfile } from '@/components/intel-profile';
import { EmptyState } from '@/components/core-ui';
import type { Competitor } from '@/types/state';
import { IntelList } from '@/components/brand/coverage-panel';
import { fetchIntelligence, type ConstructionDimension, type IntelItem, type MemoryEventItem, type VoiceChangeItem } from '@/lib/core-api';
import { intelSummary } from '@/lib/core-logic';

const INTEL_TYPES: { value: string; label: string }[] = [
  { value: '', label: '全部类型' },
  { value: 'price', label: '价格' },
  { value: 'product', label: '商品' },
  { value: 'promo', label: '促销' },
  { value: 'channel', label: '渠道' },
  { value: 'voice', label: '口碑' },
  { value: 'gap', label: '资料缺口' },
  { value: 'monitor', label: '监控状态' },
];

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: '全部状态' },
  { value: 'verified', label: '已核实' },
  { value: 'pending', label: '待核实' },
  { value: 'insufficient', label: '资料不足' },
];

function IntelInbox({ projectId }: { projectId: string }) {
  const sp = useSearchParams();
  const [apiItems, setApiItems] = useState<IntelItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [brandId, setBrandId] = useState(sp.get('brandId') || '');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [fcItem, setFcItem] = useState<IntelItem | null>(null);
  // r4.10：项目级建设中维度（后端独立字段，不再混入情报列表）
  const [construction, setConstruction] = useState<ConstructionDimension[]>([]);
  // SC-05：项目级时序变化事件（后端独立字段；与采集观察分开呈现，不把推导当直接观察）
  const [memoryEvents, setMemoryEvents] = useState<MemoryEventItem[]>([]);
  // SC-06 三：评论变化统一读「用户声音与公开评论」读模型（一套口径，独立区块）
  const [voiceChanges, setVoiceChanges] = useState<VoiceChangeItem[]>([]);

  // r3 修复：跨项目切换时重置全部筛选。brandId/type/status/from/to 都是原项目的
  // 筛选上下文；组件在同路由 query 变化时不会重挂载，若不重置会残留原项目的
  // brandId（URL 已被导航函数清除，但 state 仍在）造成「假空结果」。
  // brandId 取切换后 URL 的现值（导航函数已清除资源参数，通常为空）。
  const prevPidRef = useRef(projectId);
  useEffect(() => {
    if (prevPidRef.current === projectId) return;
    prevPidRef.current = projectId;
    setBrandId(sp.get('brandId') || '');
    setType('');
    setStatus('');
    setFrom('');
    setTo('');
  }, [projectId, sp]);

  // API 不支持 status 参数：状态筛选在前端做（展示层行为，不改后端契约）
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const ctrl = new AbortController();
    fetchIntelligence({ projectId, brandId: brandId || undefined, type: type || undefined, from: from || undefined, to: to || undefined }, ctrl.signal)
      .then(r => { if (alive) { setApiItems(r.items || []); setConstruction(r.constructionDimensions || []); setMemoryEvents(r.memoryEvents || []); setVoiceChanges(r.voiceChanges || []); setErr(null); } })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; ctrl.abort(); };
  }, [projectId, brandId, type, from, to]);

  const shown = useMemo(
    () => (status ? apiItems.filter(it => it.status === status) : apiItems),
    [apiItems, status],
  );

  const brandOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of apiItems) if (it.brandId && it.brandName) m.set(it.brandId, it.brandName);
    return [...m.entries()];
  }, [apiItems]);

  const sum = useMemo(() => intelSummary(apiItems), [apiItems]);
  const hasFilter = !!(brandId || type || status || from || to);
  const onlyGaps = apiItems.length > 0 && sum.verified === 0 && sum.pending === 0;

  return (
    <section className="core-intel-section core-inbox">
      <h3>竞争变化收件箱</h3>
      <div className="core-inbox-sum">
        <span className="core-sum-item core-sum-ok">可核实 <b>{sum.verified}</b></span>
        <span className="core-sum-item core-sum-warn">待核实 <b>{sum.pending}</b></span>
        <span className="core-sum-item">资料缺口 <b>{sum.gaps}</b></span>
      </div>
      <p className="hint">「可核实」= 每条都有可打开的证据记录；无证据的条目一律待核实，不会使用已核实样式。</p>

      <div className="core-intel-filters">
        <select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
          <option value="">全部品牌</option>
          {brandOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {INTEL_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_FILTERS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="起始日期" />
        <span className="core-filter-sep">至</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="结束日期" />
      </div>

      {err ? <p className="core-err">{err}</p> : null}

      {/* SC-05：时序变化（derived_timeline_events 投影）——独立区块，不与采集观察混排；
          每条都能回到品牌档案的对应时间与证据。 */}
      {memoryEvents.length ? (
        <section className="core-mem-events">
          <h3>时序变化（系统推导）</h3>
          <p className="hint">由已验证的时序事实确定性计算得出，不是新的来源；点击可打开品牌档案中对应时间段与证据。</p>
          <ul className="core-mem-event-list">
            {memoryEvents.slice(0, 40).map(ev => (
              <li key={ev.id}>
                <div className="core-mem-event-top">
                  <span className="mem-time">{String(ev.at).slice(0, 10)}</span>
                  <span className="mem-badge mem-badge-derived-event">{ev.sourceKindText}</span>
                  <span className="core-mem-event-brand">{ev.brandName || '—'}</span>
                  <span className="core-mem-event-text">{ev.eventText}{ev.entityName ? '：' + ev.entityName : ''}</span>
                  <span className="mem-precision">{ev.timePrecisionText}</span>
                </div>
                {ev.summary ? <div className="core-mem-event-sum">{ev.summary}</div> : null}
                {ev.link ? (
                  <Link className="core-mem-event-link" href={`/brands/${encodeURIComponent(ev.link.brandId)}?projectId=${encodeURIComponent(projectId)}&tab=products`}>
                    在品牌档案查看 →
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {voiceChanges.length ? (
        <section className="core-voice-changes">
          <h3>用户声音与公开评论（统一读模型）</h3>
          <p className="hint">
            只有一套口径：公开评论页采集（来源 URL + 快照与证据引用 + 观察时间）。
            样本不足的品牌只列状态，不做「满意/不满意」群体结论。
          </p>
          <ul className="core-voice-changes-list">
            {voiceChanges.map(v => (
              <li key={v.brandId}>
                <div className="core-voice-changes-top">
                  <Link href={`/brands/${encodeURIComponent(v.brandId)}?projectId=${encodeURIComponent(projectId)}&tab=voice`}>{v.brandName || v.brandId}</Link>
                  {v.status === 'sufficient' ? (
                    <span>样本 {v.sampleSize} 条 · {v.sourceCount} 个来源页</span>
                  ) : (
                    <span className="hint">资料不足，暂不形成群体结论。</span>
                  )}
                </div>
                {v.recentItems.length ? (
                  <ul className="core-voice-changes-items">
                    {v.recentItems.map((it, i) => (
                      <li key={i}>
                        {it.sourceUrl ? <a href={it.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">{it.title || it.sourceUrl}</a> : (it.title || '公开评论页')}
                        {typeof it.rating === 'number' ? <span> · 评分 {it.rating}</span> : null}
                        {typeof it.reviewCount === 'number' ? <span> · {it.reviewCount} 条评价</span> : null}
                        <span className="hint">（观察 {String(it.observedAt || '').slice(0, 10) || '—'}）</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!apiItems.length && !memoryEvents.length && !hasFilter ? (
        <EmptyState
          title="尚无采集结果"
          sub="该项目还没有可展示的情报。采集由你的操作触发；完成后，可核实的变化会出现在这里。"
        />
      ) : !shown.length && memoryEvents.length ? (
        <p className="hint">采集观察暂无条目；上方「时序变化（系统推导）」来自已核验的时序事实，单独呈现，不计入上面的三个计数。</p>
      ) : !shown.length ? (
        <EmptyState
          title="当前筛选没有结果"
          sub="换个品牌、类型或状态，或清除时间范围再试。"
          action={<button type="button" className="btn-ghost" onClick={() => { setBrandId(''); setType(''); setStatus(''); setFrom(''); setTo(''); }}>清除筛选</button>}
        />
      ) : (
        <>
          {onlyGaps ? (
            <p className="core-inbox-poor">当前可展示的内容以资料缺口为主：已接入维度的采集尚未产出可核实情报。补齐采集后这里会出现品牌变化。</p>
          ) : null}
          <IntelList items={shown} onCorrect={(it) => setFcItem(it)} />
        </>
      )}

      {fcItem && fcItem.competitorId ? (
        <FieldCorrectModal
          competitorId={fcItem.competitorId}
          onClose={() => setFcItem(null)}
        />
      ) : null}

      {/* r4.10：数据覆盖与建设中维度——项目级单一去重区域（页面最底部）。
          未接入维度不是情报事件：无时间戳、无来源、无证据、无状态徽章、无 0 值；
          每维度恰一条，来自后端 constructionDimensions 投影（前端不自建清单）。
          P0-2 整改 r2：用户侧只有四种口径——数据服务暂不可用 / 正在验证数据服务 /
          本轮未观察到结果 / 最近采集失败，可稍后重试；凭据细节仅管理员接口可见。 */}
      {construction.length ? (
        <details className="core-building core-building-fold">
          <summary>数据覆盖与建设中维度（{construction.length}）</summary>
          <p className="hint">以下维度当前不生成数据、估算或结论；数据服务可用后这里会展示采集状态与来源。</p>
          <ul className="core-building-list">
            {construction.map(d => (
              <li key={d.code}>
                <span className="core-building-name">{d.displayName}</span>
                <span className="core-building-state cfg">{d.state === 'pending_config' ? '数据服务暂不可用' : '尚未接入'}</span>
                <span className="core-building-msg">{d.message}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

export default function IntelPage() {
  return (
    <Suspense fallback={<p className="hint">加载情报库…</p>}>
      <IntelInner />
    </Suspense>
  );
}

function IntelInner() {
  const { state, loading } = useZhibiState();
  const searchParams = useSearchParams();
  // 🔴 projectId 以 URL 为第一来源（深链接/跳转上下文），state 当前档案兜底
  const projectId = String(searchParams.get('projectId') || (state as { projectId?: string } | null)?.projectId || '');
  const [curId, setCurId] = useState<string | null>(null);
  const [fcField, setFcField] = useState<string | undefined>(undefined);
  const [fcOpen, setFcOpen] = useState(false);

  const cs = useMemo(() => {
    if (!state) return [] as Competitor[];
    const excluded = new Set((state.excluded as string[]) || []);
    return ((state.competitors || []) as Competitor[])
      .filter((c) => !excluded.has(c.id))
      .slice()
      .sort((a, b) => ((b.rankScore as number) || 0) - ((a.rankScore as number) || 0));
  }, [state]);

  // 支持 ?c=<id> 定位（雷达卡点击跳转；对齐旧版 switchTab('intel', cid)）
  const qsId = searchParams.get('c');
  const active =
    (qsId && cs.find((x) => x.id === qsId)?.id) ||
    (curId && cs.find((x) => x.id === curId)?.id) ||
    (cs[0] && cs[0].id) ||
    null;
  const cur = cs.find((x) => x.id === active);

  if (loading) return <p className="hint">加载情报库…</p>;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>情报库</h2>
          <p className="desc">每天看一遍：竞争品牌发生了什么变化、哪些已核实、哪些待核实、还缺什么资料。每个字段都可逐条核对与纠错。</p>
        </div>
      </div>

      {projectId ? <IntelInbox projectId={projectId} /> : (
        <EmptyState title="请先选择项目" sub="右上角选择项目后，这里会显示该项目竞争品牌的变化收件箱。" />
      )}

      {/* 品牌逐字段档案（保留区）：六维画像与逐字段纠错 */}
      {cs.length ? (
        <>
          <div className="page-head">
            <div className="actions">
              <div className="filters" style={{ marginBottom: 0 }}>
                {cs.map((c) => (
                  <button
                    key={c.id}
                    className={'chip' + (c.id === active ? ' on' : '')}
                    type="button"
                    onClick={() => setCurId(c.id)}
                  >
                    {c.name as string}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="intel-list">
            {cur ? (
              <IntelProfile
                key={cur.id}
                c={cur}
                state={state!}
                onCorrect={(field) => {
                  setFcField(field);
                  setFcOpen(true);
                }}
              />
            ) : null}
          </div>
        </>
      ) : null}

      {fcOpen && active ? (
        <FieldCorrectModal
          competitorId={active}
          initialField={fcField}
          onClose={() => {
            setFcOpen(false);
            setFcField(undefined);
          }}
        />
      ) : null}
    </div>
  );
}
