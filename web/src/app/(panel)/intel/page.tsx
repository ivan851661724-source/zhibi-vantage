'use client';
// 情报库页（Phase 3：复刻 renderIntelTab L2201-2216）
// 顶部对手 chips 切换 + 六维档案；纠错正式入口（弹窗 initialField 预选）。
import { Suspense, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { FieldCorrectModal } from '@/components/field-correct';
import { IntelProfile } from '@/components/intel-profile';
import type { Competitor } from '@/types/state';

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
            <h2>情报库 · 对手档案</h2>
            <p className="desc">每个对手的六维档案：价格 / 渠道 / 品类 / 上新节奏 / 口碑 / 空白。每个字段都带证据等级与来源，可逐条核对。</p>
          </div>
        </div>
        <div className="empty">
          <div className="big">暂无可展示的对手档案</div>
          <div className="sub">完成调研后，这里会展示每家对手的六维档案。</div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>情报库 · 对手档案</h2>
          <p className="desc">每个对手的六维档案：价格 / 渠道 / 品类 / 上新节奏 / 口碑 / 空白。每个字段都带证据等级与来源，可逐条核对。</p>
        </div>
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
