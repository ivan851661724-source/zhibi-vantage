'use client';
// 情报库页（Phase 3：复刻 renderIntelTab L2201-2216）
// 顶部对手 chips 切换 + 六维档案；纠错正式入口（弹窗 initialField 预选）。
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { FieldCorrectModal } from '@/components/field-correct';
import { IntelProfile } from '@/components/intel-profile';
import type { Competitor } from '@/types/state';
import { IntelList } from '@/components/brand/coverage-panel';
import { fetchIntelligence, type IntelItem } from '@/lib/core-api';

// 统一读模型情报库（SC-04）：按事实与变化组织，可按品牌/类型/时间筛选，
// 每条带数据性质、状态与证据入口；没有 Evidence 的内容不标记「已核实」。
function UnifiedIntelSection({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<IntelItem[]>([]);
  const [brandId, setBrandId] = useState('');
  const [type, setType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    const ctrl = new AbortController();
    fetchIntelligence({ projectId, brandId: brandId || undefined, type: type || undefined, from: from || undefined, to: to || undefined }, ctrl.signal)
      .then(r => { if (alive) { setItems(r.items || []); setErr(null); } })
      .catch(e => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; ctrl.abort(); };
  }, [projectId, brandId, type, from, to]);

  const brandOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const it of items) if (it.brandId && it.brandName) m.set(it.brandId, it.brandName);
    return [...m.entries()];
  }, [items]);

  return (
    <section className="core-intel-section">
      <h3>情报库（按事实与变化）</h3>
      <div className="core-intel-filters">
        <select value={brandId} onChange={(e) => setBrandId(e.target.value)}>
          <option value="">全部品牌</option>
          {brandOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">全部类型</option>
          <option value="price">价格</option>
          <option value="product">商品</option>
          <option value="promo">促销</option>
          <option value="channel">渠道</option>
          <option value="voice">口碑</option>
          <option value="gap">资料缺口</option>
          <option value="monitor">监控状态</option>
        </select>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
      </div>
      {err ? <p className="core-err">{err}</p> : null}
      <IntelList items={items} onCorrect={() => { /* 纠错入口：下方可逐字段提交 */ }} />
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

  if (!cs.length) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h2>情报库 · 竞争品牌档案</h2>
            <p className="desc">品牌定位、价格、渠道、上新节奏与消费者反馈等竞争品牌档案，每个字段都带数据依据与来源，可逐条核对。</p>
          </div>
        </div>
        <div className="empty">
          <div className="big">尚未添加竞争品牌</div>
          <div className="sub">发现并添加竞争品牌后，Vantage 将开始建立竞争档案。</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>情报库 · 竞争品牌档案</h2>
          <p className="desc">品牌定位、价格、渠道、上新节奏与消费者反馈等竞争品牌档案，每个字段都带数据依据与来源，可逐条核对。</p>
        </div>
        <UnifiedIntelSection projectId={String((state as { projectId?: string } | null)?.projectId || '')} />
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
