'use client';
// ============================================================
// /demo —— Demo Sprint Stage 4：产品化演示控制台
// 四个产品功能入口：工作台（今日竞争动态）/ 竞品发现（复用现有链路）/
// 竞品档案 / 事件详情（AI 解读 + 查看证据）。
// 数据纪律：页面零写死业务数字——全部来自真值链 REST
// （/api/demo/recent-changes | event-detail | evidence-detail | seed |
//   ai-interpretation）；AI 解读标注实际模型与端点；场景标记 Demo / Sample Data。
// ============================================================
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { apiGet, apiPost } from '@/lib/api';

type RecentResp = {
  events: DemoEvent[];
  summary: { total: number; decrease: number; increase: number };
};
type DemoEvent = {
  event_id: string; event_type: string; occurred_at: string;
  entity_key: string; entity_ref: Record<string, unknown> | null;
  old_price: number; new_price: number; direction: string | null;
  delta: number | null; pct: number | null; currency: string | null;
  old_evidence_ids: string[]; new_evidence_ids: string[];
  old_snapshot_ids: string[]; new_snapshot_ids: string[];
  observed_at_old: string | null; observed_at_new: string | null;
  note: string | null;
};
type Insight = { insight: string; model: string; endpoint_kind: string; endpoint_base_url: string; cached: boolean };
type EventDetail = {
  event: DemoEvent;
  diff: Record<string, unknown> | null;
  facts: { old: Record<string, unknown> | null; new: Record<string, unknown> | null };
  evidences: Array<Record<string, unknown>>;
  snapshots: Array<Record<string, unknown>>;
};
type EvidenceDetail = { evidence: Record<string, unknown>; snapshots: Array<Record<string, unknown>> };

// P0-1 诚实币种渲染：currency 为 null（products.json 快照未证明币种）时绝不伪造 '$'，
// 只显示数字本身，并由调用方就近标注「币种未确认」；仅当快照携带真实币种时才显示。
function fmtMoney(n: number | null, cur: string | null) {
  if (n == null) return '—';
  return cur ? cur + ' ' + n : String(n);
}
function fmtTime(iso: string | null) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch { return iso; }
}

export default function DemoPage() {
  const [recent, setRecent] = useState<RecentResp | null>(null);
  const [seeding, setSeeding] = useState(false);
  const [seedMsg, setSeedMsg] = useState('');
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [evModal, setEvModal] = useState<EvidenceDetail | null>(null);
  const [insight, setInsight] = useState<Record<string, Insight>>({});
  const [aiLoading, setAiLoading] = useState('');
  const [aiErr, setAiErr] = useState<Record<string, string>>({});

  const load = useCallback(() => { apiGet<RecentResp>('/api/demo/recent-changes').then(setRecent).catch(() => setRecent(null)); }, []);
  useEffect(() => { load(); }, [load]);

  async function seed() {
    setSeeding(true); setSeedMsg('');
    try {
      const r = await apiPost<{ seeded?: boolean; already?: boolean; event_id?: string }>('/api/demo/seed');
      setSeedMsg(r.seeded ? '已播种：39 → 29 完整走真实事实链（Snapshot→Evidence→Fact→Diff→Event）' : '场景已存在，未重复播种');
      load();
    } catch (e) {
      setSeedMsg('播种失败：' + String((e as Error).message || e).slice(0, 120));
    } finally { setSeeding(false); }
  }

  async function openDetail(evt: DemoEvent) {
    try { setDetail(await apiGet<EventDetail>('/api/demo/event-detail?id=' + evt.event_id)); } catch { setDetail(null); }
  }
  async function openEvidence(id: string) {
    try { setEvModal(await apiGet<EvidenceDetail>('/api/demo/evidence-detail?id=' + id)); } catch { setEvModal(null); }
  }
  async function askAi(evt: DemoEvent) {
    setAiLoading(evt.event_id); setAiErr(s => ({ ...s, [evt.event_id]: '' }));
    try {
      const r = await apiPost<Insight>('/api/demo/ai-interpretation?id=' + evt.event_id);
      setInsight(s => ({ ...s, [evt.event_id]: r }));
    } catch (e) {
      setAiErr(s => ({ ...s, [evt.event_id]: String((e as Error).message || e).slice(0, 160) }));
    } finally { setAiLoading(''); }
  }

  const events = recent?.events || [];
  const summary = recent?.summary;

  // ---- 今日竞争简报（纯派生：数字全部来自 recent-changes REST 的 DomainEvent，不写死业务数字）----
  const [copyMsg, setCopyMsg] = useState('');
  const latest = events.length
    ? [...events].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))[0]
    : null;
  const latestBrand = latest ? String((latest.entity_ref && (latest.entity_ref as Record<string, unknown>).brand_name) || '竞品') : '';
  const latestTitle = latest ? String((latest.entity_ref && (latest.entity_ref as Record<string, unknown>).title) || '商品') : '';
  const latestPct = latest ? Math.abs(latest.pct ?? 0).toFixed(1) : '';
  const latestDirWord = latest ? (latest.direction === 'decrease' ? '下降' : latest.direction === 'increase' ? '上涨' : '变化') : '';
  // 确定性「建议关注」（按方向给固定口径，不编造任何数字/事件）
  const advice = latest
    ? (latest.direction === 'decrease'
      ? '建议关注同价格带商品的后续价格压力与促销动作。'
      : latest.direction === 'increase'
        ? '建议关注该品牌是否在试探提价空间，以及对自家转化与促销策略的影响。'
        : '建议保持观察，等待下一次扫描确认趋势。')
    : '';
  const briefAi = latest ? insight[latest.event_id] : undefined; // 复用现有 ai-interpretation 结果；无 AI 不影响简报
  const briefText = latest ? [
    '【今日竞争简报】（Demo / Sample Data）',
    '近期发现 ' + (summary ? summary.total : events.length) + ' 个竞争变化动作' + (summary ? '（降价 ' + summary.decrease + ' · 涨价 ' + summary.increase + '）' : '') + '。',
    '最重要：' + latestBrand + ' · ' + latestTitle + ' 价格从 ' + fmtMoney(latest.old_price, latest.currency)
      + ' 调整至 ' + fmtMoney(latest.new_price, latest.currency) + '，' + latestDirWord + ' ' + latestPct + '%'
      + (latest.currency ? '（币种 ' + latest.currency + '）' : '（币种未确认）') + '。',
    '观察时间：' + fmtTime(latest.observed_at_old) + ' → ' + fmtTime(latest.observed_at_new),
    advice,
    briefAi ? 'AI 解读（' + briefAi.model + '）：' + briefAi.insight : '',
  ].filter(Boolean).join('\n') : '';

  async function copyBrief() {
    try {
      await navigator.clipboard.writeText(briefText);
      setCopyMsg('已复制到剪贴板');
    } catch {
      setCopyMsg('复制失败（浏览器剪贴板权限受限）');
    }
    setTimeout(() => setCopyMsg(''), 3000);
  }

  return (
    <div className="demo-console">
      <style jsx global>{`
        .demo-console { max-width: 960px; margin: 0 auto; padding: 20px 16px 60px; }
        .demo-badge { display: inline-block; font-size: 11px; border: 1px solid #d97b00; color: #b26500; border-radius: 4px; padding: 1px 8px; margin-left: 8px; vertical-align: middle; }
        .demo-h1 { font-size: 20px; font-weight: 700; margin: 6px 0 2px; }
        .demo-sub { color: #777; font-size: 12.5px; margin-bottom: 16px; }
        .demo-card { border: 1px solid #e5e7eb; border-radius: 10px; padding: 16px; margin-bottom: 14px; background: #fff; }
        .demo-sec-title { font-size: 13px; font-weight: 700; color: #374151; letter-spacing: .04em; margin: 18px 0 8px; }
        .demo-btn { border: 1px solid #1d9e75; color: #1d9e75; background: #fff; border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; margin-right: 8px; }
        .demo-btn.primary { background: #1d9e75; color: #fff; }
        .demo-btn:disabled { opacity: .5; cursor: default; }
        .demo-price-old { text-decoration: line-through; color: #9ca3af; font-size: 15px; }
        .demo-price-new { color: #d92d20; font-size: 26px; font-weight: 700; margin: 0 8px; }
        .demo-pct { color: #d92d20; font-weight: 700; }
        .demo-cur-note { color: #9ca3af; font-size: 11px; border: 1px dashed #d1d5db; border-radius: 4px; padding: 0 6px; }
        .demo-kv { font-size: 12.5px; color: #555; margin: 2px 0; }
        .demo-kv b { color: #111; }
        .demo-modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 60; }
        .demo-modal { background: #fff; border-radius: 12px; max-width: 640px; width: 92%; max-height: 82vh; overflow: auto; padding: 20px; }
        .demo-evidence { border: 1px dashed #d1d5db; border-radius: 8px; padding: 10px 12px; margin: 8px 0; font-size: 12.5px; }
        .demo-ai { background: #f0fdf9; border: 1px solid #b7e4d3; border-radius: 8px; padding: 12px 14px; margin-top: 10px; font-size: 13.5px; line-height: 1.7; }
        .demo-ai-meta { color: #6b7280; font-size: 11.5px; margin-top: 6px; word-break: break-all; }
        .demo-err { color: #d92d20; font-size: 12.5px; margin-top: 8px; }
        .demo-empty { color: #9ca3af; font-size: 13px; padding: 18px 0; text-align: center; }
        .demo-row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
        .demo-brief-line { font-size: 13.5px; margin: 5px 0; line-height: 1.9; color: #374151; }
        .demo-brief-line b { color: #111; }
        .demo-brief-new { color: #d92d20; font-weight: 700; }
        .demo-brief-advice { color: #166534; font-size: 13px; margin-top: 8px; }
      `}</style>

      <div>
        <span className="demo-h1">AI 竞品情报助手</span>
        <span className="demo-badge">Demo / Sample Data</span>
        <div className="demo-sub">持续替你观察竞争对手 · 记住过去 · 发现变化 · 用 AI 解释影响 · 每个结论可回到证据</div>
      </div>

      {/* 今日竞争简报（AI Analyst 首屏）：数字全部来自 recent-changes；AI 不可用时仅显确定性事实 */}
      {latest && (
        <>
          <div className="demo-sec-title">今日竞争简报</div>
          <div className="demo-card">
            <div className="demo-brief-line">
              近期发现 <b>{summary ? summary.total : events.length}</b> 个重要竞争动作（降价 <b>{summary ? summary.decrease : 0}</b> · 涨价 <b>{summary ? summary.increase : 0}</b>）。
            </div>
            <div className="demo-brief-line">
              {latestBrand} · {latestTitle} 价格从 <b>{fmtMoney(latest.old_price, latest.currency)}</b> 调整至 <b className="demo-brief-new">{fmtMoney(latest.new_price, latest.currency)}</b>，{latestDirWord} {latestPct}%
              {!latest.currency && <span className="demo-cur-note" style={{ marginLeft: 4 }}>币种未确认</span>}。
            </div>
            {briefAi && (
              <div className="demo-ai">
                {briefAi.insight}
                <div className="demo-ai-meta">模型 {briefAi.model} · 端点 {briefAi.endpoint_kind}{briefAi.cached ? ' · 缓存' : ''}</div>
              </div>
            )}
            <div className="demo-brief-advice">{advice}</div>
            <div style={{ marginTop: 10 }}>
              <button className="demo-btn" onClick={copyBrief}>复制简报</button>
              {copyMsg && <span className="demo-kv" style={{ marginLeft: 4 }}>{copyMsg}</span>}
            </div>
          </div>
        </>
      )}

      {/* 页面 A —— 工作台：今日竞争动态 */}
      <div className="demo-sec-title">今日竞争动态</div>
      <div className="demo-card">
        <div style={{ marginBottom: 10 }}>
          <button className="demo-btn primary" disabled={seeding} onClick={seed}>{seeding ? '播种中…' : '播种 Demo 场景（39 → 29）'}</button>
          {seedMsg && <span className="demo-kv">{seedMsg}</span>}
        </div>
        {summary && (
          <div className="demo-kv" style={{ marginBottom: 8 }}>
            近期变化事件 <b>{summary.total}</b> 条 · 降价 <b>{summary.decrease}</b> · 涨价 <b>{summary.increase}</b>
          </div>
        )}
        {!events.length && <div className="demo-empty">暂无变化事件。点击上方按钮播种确定性演示场景，或等待下一次真实扫描。</div>}
        {events.map(ev => {
          const brand = (ev.entity_ref && (ev.entity_ref as Record<string, unknown>).brand_name) || '竞品';
          const title = (ev.entity_ref && (ev.entity_ref as Record<string, unknown>).title) || '商品';
          return (
            <div key={ev.event_id} style={{ borderTop: '1px solid #f1f5f9', padding: '12px 0' }}>
              <div className="demo-row">
                <b>{String(brand)}</b>
                <span style={{ color: '#6b7280', fontSize: 13 }}>{String(title)}</span>
                <span className="demo-price-old">{fmtMoney(ev.old_price, ev.currency)}</span>
                <span>→</span>
                <span className="demo-price-new">{fmtMoney(ev.new_price, ev.currency)}</span>
                {!ev.currency && <span className="demo-cur-note">币种未确认</span>}
                {ev.direction === 'decrease' && <span className="demo-pct">↓ {Math.abs(ev.pct ?? 0).toFixed(1)}%</span>}
                {ev.direction === 'increase' && <span className="demo-pct" style={{ color: '#b26500' }}>↑ {Math.abs(ev.pct ?? 0).toFixed(1)}%</span>}
              </div>
              <div className="demo-kv">检出时间：{fmtTime(ev.occurred_at)} · 观察窗口 {fmtTime(ev.observed_at_old)} → {fmtTime(ev.observed_at_new)} · 来源 {String((ev as unknown as { source?: string }).source || 'shopify')}</div>
              <div style={{ marginTop: 8 }}>
                <button className="demo-btn" onClick={() => openDetail(ev)}>查看详情</button>
                <button className="demo-btn" onClick={() => openEvidence(ev.new_evidence_ids[0])}>查看证据</button>
                <button className="demo-btn" disabled={!!aiLoading} onClick={() => askAi(ev)}>{aiLoading === ev.event_id ? 'AI 解读中…' : 'AI 解读'}</button>
              </div>
              {insight[ev.event_id] && (
                <div className="demo-ai">
                  {insight[ev.event_id].insight}
                  <div className="demo-ai-meta">模型 {insight[ev.event_id].model} · 端点 {insight[ev.event_id].endpoint_kind} · {insight[ev.event_id].endpoint_base_url}{insight[ev.event_id].cached ? ' · 缓存' : ''}</div>
                </div>
              )}
              {aiErr[ev.event_id] && <div className="demo-err">{aiErr[ev.event_id]}</div>}
            </div>
          );
        })}
      </div>

      {/* 页面 B —— 竞品发现（复用现有 Discovery 链路，不重写） */}
      <div className="demo-sec-title">竞品发现</div>
      <div className="demo-card demo-kv">
        输入自己的品牌 / 商品关键词 / 类目 / 目标市场，系统自动发现潜在竞争品牌（品牌名 · 官网 · 定位 · 为什么是竞品 · 一键关注）。
        <div style={{ marginTop: 8 }}>
          <Link className="demo-btn" style={{ textDecoration: 'none', display: 'inline-block' }} href="/">前往工作台·帮我找对手 →</Link>
        </div>
      </div>

      {/* 页面 C —— 竞品档案入口（复用现有 intel 档案页） */}
      <div className="demo-sec-title">竞品档案</div>
      <div className="demo-card demo-kv">
        统一档案：品牌定位 · 商品列表 · 价格区间 · 最近变化 · Evidence 来源入口。无可靠数据的模块自动隐藏，不伪造采集结果。
        <div style={{ marginTop: 8 }}>
          <Link className="demo-btn" style={{ textDecoration: 'none', display: 'inline-block' }} href="/intel">打开竞品档案 →</Link>
        </div>
      </div>

      {/* 页面 D —— 事件详情 Modal */}
      {detail && (
        <div className="demo-modal-mask" onClick={() => setDetail(null)}>
          <div className="demo-modal" onClick={e => e.stopPropagation()}>
            <div className="demo-h1" style={{ fontSize: 17 }}>价格变化详情</div>
            <span className="demo-badge">{String(detail.event.note || 'Demo / Sample Data').slice(0, 40)}</span>
            <div className="demo-row" style={{ margin: '12px 0' }}>
              <span className="demo-price-old">{fmtMoney(detail.event.old_price, detail.event.currency)}</span>
              <span>→</span>
              <span className="demo-price-new">{fmtMoney(detail.event.new_price, detail.event.currency)}</span>
              {!detail.event.currency && <span className="demo-cur-note">币种未确认</span>}
              <span className="demo-pct">{detail.event.direction === 'decrease' ? '↓' : '↑'} {Math.abs(detail.event.pct ?? 0).toFixed(1)}%</span>
            </div>
            <div className="demo-kv">检出：{fmtTime(detail.event.occurred_at)}</div>
            <div className="demo-kv">观察窗口：{fmtTime(detail.event.observed_at_old)} → {fmtTime(detail.event.observed_at_new)}</div>
            <div className="demo-kv">Diff：{detail.diff ? String((detail.diff as { diff_id?: string }).diff_id) : '—'}（status={detail.diff ? String((detail.diff as { status?: string }).status) : '—'}）</div>
            <div className="demo-kv">Fact：{detail.facts.old ? String((detail.facts.old as { fact_id?: string }).fact_id) : '—'} → {detail.facts.new ? String((detail.facts.new as { fact_id?: string }).fact_id) : '—'}</div>

            <div className="demo-sec-title">证据（{detail.evidences.length} 条）</div>
            {detail.evidences.map(ev => (
              <div className="demo-evidence" key={String(ev.evidence_id)}>
                <div><b>{String(ev.evidence_id)}</b> · status <b>{String(ev.evidence_status)}</b> · observed_at {fmtTime(String(ev.observed_at || ''))}</div>
                <div style={{ color: '#6b7280' }}>来源 {String(ev.source)}/{String(ev.provider)} · 快照 {JSON.stringify(ev.source_snapshot_ids)} · 快照数 {detail.snapshots.length}</div>
                <div style={{ marginTop: 6 }}>
                  <button className="demo-btn" onClick={() => openEvidence(String(ev.evidence_id))}>查看证据原始溯源</button>
                </div>
              </div>
            ))}

            <div className="demo-sec-title">AI 解读</div>
            {insight[detail.event.event_id]
              ? <div className="demo-ai">{insight[detail.event.event_id].insight}<div className="demo-ai-meta">模型 {insight[detail.event.event_id].model} · 端点 {insight[detail.event.event_id].endpoint_kind}</div></div>
              : <button className="demo-btn primary" disabled={!!aiLoading} onClick={() => askAi(detail.event)}>{aiLoading === detail.event.event_id ? 'AI 解读中…' : '生成 AI 业务解读'}</button>}
            {aiErr[detail.event.event_id] && <div className="demo-err">{aiErr[detail.event.event_id]}</div>}

            <div style={{ marginTop: 14, textAlign: 'right' }}>
              <button className="demo-btn" onClick={() => setDetail(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 证据 Modal：Source URL / observed_at / value / status / Snapshot ID / 来源 */}
      {evModal && (
        <div className="demo-modal-mask" onClick={() => setEvModal(null)}>
          <div className="demo-modal" onClick={e => e.stopPropagation()}>
            <div className="demo-h1" style={{ fontSize: 17 }}>证据溯源</div>
            <div className="demo-kv">Evidence ID：<b>{String(evModal.evidence.evidence_id)}</b></div>
            <div className="demo-kv">EvidenceStatus：<b>{String(evModal.evidence.evidence_status)}</b>{evModal.evidence.reason_code ? '（' + String(evModal.evidence.reason_code) + '）' : ''}</div>
            <div className="demo-kv">观察值：<b>{JSON.stringify(evModal.evidence.extracted_value)}</b></div>
            <div className="demo-kv">observed_at：{fmtTime(String(evModal.evidence.observed_at || ''))}</div>
            <div className="demo-kv">来源：{String(evModal.evidence.source)} / {String(evModal.evidence.provider)}</div>
            <div className="demo-kv">币种：{evModal.evidence.currency == null ? 'null（来源快照未携带，诚实缺失）' : String(evModal.evidence.currency)}</div>
            <div className="demo-sec-title">SourceSnapshot 溯源</div>
            {evModal.snapshots.map((s, i) => (
              <div className="demo-evidence" key={i}>
                <div>Snapshot ID：<b>{String(s.snapshot_id)}</b></div>
                <div style={{ color: '#6b7280' }}>Source URL：{String(s.source_url || s.raw_payload_ref && (s.raw_payload_ref as Record<string, unknown>).source_url || '—')}</div>
                <div style={{ color: '#6b7280' }}>source_status {String(s.source_status)} · collector {String(s.collector_version)} · content_hash {String(s.content_hash)}</div>
                {s.raw_payload_ref ? <div style={{ color: '#6b7280' }}>raw payload：{String((s.raw_payload_ref as Record<string, unknown>).path)}</div> : null}
              </div>
            ))}
            <div style={{ marginTop: 14, textAlign: 'right' }}>
              <button className="demo-btn" onClick={() => setEvModal(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
