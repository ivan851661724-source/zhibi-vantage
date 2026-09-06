'use client';
// 竞品雷达（Phase 2：信号条 + 对手卡墙，复刻 renderRadarTab L1939-1988 / radarCard L2012-2056）
// Phase 3：卡片点击跳 /intel?c=<id>（对齐旧版 switchTab('intel', cid)）；「纠错」入口保留（双入口）
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useZhibiState } from '@/hooks/use-zhibi-state';
import { FieldCorrectModal } from '@/components/field-correct';
import { chgClass, fmtChannels, fmtHero, fmtPrice, lbl } from '@/lib/labels';

interface GroupSignal {
  label?: string;
  note?: string;
  competitors?: string[];
}

function SignalStrip({ gs }: { gs: GroupSignal[] }) {
  if (!gs.length) {
    return (
      <div className="signal-strip" id="radarStrip">
        <div className="sig">
          <div className="ico">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /></svg>
          </div>
          <div><b>近阶段暂无跨对手集体异动</b><span className="t">持续观测中</span></div>
        </div>
      </div>
    );
  }
  return (
    <div className="signal-strip" id="radarStrip">
      {gs.slice(0, 5).map((s, i) => {
        const cls = chgClass(s.label || '');
        return (
          <div className={'sig ' + (cls === 'down' ? 'sig-down' : 'sig-new')} key={i}>
            <div className="ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M12 5v14M5 12h14" /></svg>
            </div>
            <div>
              <b>{s.label || '动作'}</b>
              <span className="t">
                {s.note || ''}
                {s.competitors && s.competitors.length ? ` ｜ ${s.competitors.join('、')}` : ''}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RivalCard({ c, onCorrect }: { c: Record<string, unknown>; onCorrect: (id: string) => void }) {
  const router = useRouter();
  const ra = (c.recentActions || {}) as {
    hasAction?: boolean;
    action?: { label?: string; desc?: string; when?: string };
  };
  const rel = ((c.relationship && (c.relationship as { code?: string }).code) || 'undetermined') as string;
  const relZh = rel === 'indirect' ? '高价参考' : rel === 'unrelated' ? '低价走量' : '直接对手';
  const relCls = rel === 'indirect' ? 'rrel-ref' : rel === 'unrelated' ? 'rrel-cheap' : 'rrel-direct';
  const heroName = fmtHero(c);
  const osLine = [c.category as string, fmtChannels(c)].filter(Boolean).join(' · ') || '—';

  // 渠道 chips（去重，复刻 radarCard L2022-2034）
  const ch = (c.channels || {}) as Record<string, { present?: boolean; label?: string }>;
  const seen = new Set<string>();
  const present: string[] = [];
  Object.keys(ch).forEach((k) => {
    const v = ch[k];
    if (v && v.present) {
      const l = v.label || lbl('channels', k) || k;
      if (!seen.has(l)) {
        seen.add(l);
        present.push(l);
      }
    }
  });

  return (
    <article className="rival" style={{ cursor: 'pointer' }} onClick={() => router.push('/intel?c=' + encodeURIComponent(c.id as string))}>
      <div className="r-top">
        <div className="r-avatar">{((c.name as string) || '?')[0]}</div>
        <div>
          <div className="r-nm">{c.name as string}</div>
          <div className="r-tag">{osLine}</div>
        </div>
        <span className={'r-rel ' + relCls}>{relZh}</span>
      </div>
      <div className="r-price">
        <span className="num">{fmtPrice(c)}</span>
        <span className="unit">起</span>
        <span className="band">{heroName !== '未识别主推' ? '主推 ' + heroName : ''}</span>
      </div>
      <div className="r-chips">
        {present.slice(0, 4).map((l) => (
          <span className="rch ok" key={l}>{l}</span>
        ))}
        {present.length > 4 ? <span className="rch warn">+{present.length - 4} 个</span> : null}
      </div>
      {ra.hasAction && ra.action ? (
        <div className="r-act">
          <span className={'mt mt-' + (chgClass(ra.action.label || '') === 'up' ? 'new' : chgClass(ra.action.label || ''))}>
            {ra.action.label || '动作'}
          </span>
          <b>{ra.action.desc || ''}</b>
          {ra.action.when ? String(ra.action.when) : ''}
        </div>
      ) : (
        <div className="r-act">近阶段无显著动作</div>
      )}
      <button
        className="fb-correct"
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onCorrect(c.id as string);
        }}
      >
        ✎ 纠正这张卡的数据（须附证据来源）
      </button>
    </article>
  );
}

export default function RadarPage() {
  const { state, loading } = useZhibiState();
  const [fcId, setFcId] = useState<string | null>(null);

  const { cs, gs } = useMemo(() => {
    if (!state) return { cs: [], gs: [] as GroupSignal[] };
    const excluded = new Set((state.excluded as string[]) || []);
    const list = ((state.competitors || []) as Record<string, unknown>[]).filter(
      (c) => !excluded.has(c.id as string) && c.status === 'done',
    );
    list.sort((a, b) => {
      const ra = (a.recentActions || {}) as { hasAction?: boolean };
      const rb = (b.recentActions || {}) as { hasAction?: boolean };
      const ka = ra.hasAction ? 1 : 0;
      const kb = rb.hasAction ? 1 : 0;
      if (ka !== kb) return kb - ka;
      return ((b.rankScore as number) || 0) - ((a.rankScore as number) || 0);
    });
    const groupSignals =
      ((state.radar && (state.radar as { groupSignals?: GroupSignal[] }).groupSignals) || []) as GroupSignal[];
    return { cs: list, gs: groupSignals };
  }, [state]);

  if (loading) return <p className="hint">加载雷达…</p>;
  if (!state) return <p className="hint">暂无调研档案，先到工作台发起一次调研。</p>;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>竞品雷达</h2>
          <p className="desc">
            当前赛道在观测的全部对手，按「与你位置的接近程度」排序。觉得哪家不算对手，闸门移掉即可，空白视图自动重算。
          </p>
        </div>
      </div>
      <SignalStrip gs={gs} />
      {cs.length > 0 && cs.length < 3 ? (
        <div className="radar-lead-banner" id="radarLeadBanner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14" strokeLinecap="round" /></svg>
          <div className="rlb-main">
            <b>当前仅 {cs.length} 家对手，样本偏薄</b>
            <span>信号聚合与空白视图需要 ≥3 家对手数据才可靠。补录几个你真在盯的品牌，雷达与机会视图会自动重算。</span>
          </div>
          <Link className="btn-ghost" href="/?new=1">＋ 补录对手</Link>
        </div>
      ) : null}
      <div id="radarWall">
        {cs.length === 0 ? (
          <div className="empty">
            <div className="big">暂无可展示的对手</div>
            <div className="sub">完成一次调研后，这里会列出竞品卡墙。</div>
          </div>
        ) : (
          <div className="rival-grid">
            {cs.map((c) => (
              <RivalCard key={c.id as string} c={c} onCorrect={setFcId} />
            ))}
          </div>
        )}
      </div>

      {/* 字段纠错弹窗（/api/field-correct，Phase 3 首项） */}
      {fcId ? <FieldCorrectModal competitorId={fcId} onClose={() => setFcId(null)} /> : null}
    </div>
  );
}
