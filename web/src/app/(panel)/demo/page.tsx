'use client';
// ============================================================
// /demo —— 产品演示控制台（评委观看路径：产品价值 → 技术可信度）
// Hero（Vantage · AI 竞争情报分析师）→ 今日竞争情报 → 近期竞争动态
// → 事件详情（发生了什么 / 竞争影响分析 / 数据依据 / 技术溯源折叠）。
// 数据纪律：页面零写死业务数字——全部来自真值链 REST
// （/api/demo/recent-changes | event-detail | evidence-detail | seed |
//   ai-interpretation）；AI 只做分析不制造事实；场景标记 Demo / Sample Data。
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

// 数据状态中文标签（业务界面用中文，技术溯源折叠区保留原始代码）
const STATUS_ZH: Record<string, string> = {
  verified: '已核实', derived: '推算', conflicted: '存在冲突', unavailable: '未获取',
};
function statusZh(s: unknown): string {
  const k = String(s || '');
  return STATUS_ZH[k] ? STATUS_ZH[k] + '（' + k + '）' : k || '—';
}

// P0-1 诚实币种渲染：currency 为 null（来源快照未证明币种）时绝不伪造 '$'，
// 只显示数字本身，并由调用方就近标注「币种信息暂不可用」；仅当快照携带真实币种时才显示。
function fmtMoney(n: number | null, cur: string | null) {
  if (n == null) return '—';
  return cur ? cur + ' ' + n : String(n);
}
function fmtTime(iso: string | null) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false }); } catch { return iso; }
}
// 观察值业务层友好展示：结构化价格取 price_min/price_max 区间；原始 JSON 只进技术溯源折叠区
function fmtValue(v: unknown): string {
  if (v == null) return '—';
  if (typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.price_min === 'number' && typeof o.price_max === 'number') {
      return o.price_min === o.price_max ? String(o.price_min) : o.price_min + ' – ' + o.price_max;
    }
  }
  return String(v);
}
// 数据来源业务层标签：按 evidence.source 派生（非硬编码）；工程 provider 码只进技术溯源折叠区
function sourceLabel(ev: Record<string, unknown>): string {
  const s = String(ev.source || '');
  if (s === 'shopify') return 'Shopify 商品目录';
  return s || '—';
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
      setSeedMsg(r.seeded ? '演示数据已载入' : '演示数据已就绪');
      load();
    } catch {
      setSeedMsg('暂时无法载入演示数据，请稍后重试。');
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
    } catch {
      setAiErr(s => ({ ...s, [evt.event_id]: '暂时无法生成竞争影响分析。已确认的竞争事实和数据依据不受影响。' }));
    } finally { setAiLoading(''); }
  }

  const events = recent?.events || [];
  const summary = recent?.summary;

  // ---- 今日竞争情报（纯派生：数字全部来自 recent-changes REST 的 DomainEvent，不写死业务数字）----
  const [copyMsg, setCopyMsg] = useState('');
  const latest = events.length
    ? [...events].sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)))[0]
    : null;
  const latestBrand = latest ? String((latest.entity_ref && (latest.entity_ref as Record<string, unknown>).brand_name) || '竞争品牌') : '';
  const latestTitle = latest ? String((latest.entity_ref && (latest.entity_ref as Record<string, unknown>).title) || '商品') : '';
  const latestPct = latest ? Math.abs(latest.pct ?? 0).toFixed(1) : '';
  const latestDirWord = latest ? (latest.direction === 'decrease' ? '下调' : latest.direction === 'increase' ? '上调' : '变化') : '';
  // 确定性「建议关注」（按方向给固定口径，不编造任何数字/事件）
  const advice = latest
    ? (latest.direction === 'decrease'
      ? '建议关注自身同价格带产品受到的竞争压力，以及后续促销动作。'
      : latest.direction === 'increase'
        ? '建议关注该品牌是否在试探提价空间，以及对自家转化与促销策略的影响。'
        : '建议保持观察，等待后续监测确认趋势。')
    : '';
  const briefAi = latest ? insight[latest.event_id] : undefined; // 复用现有 ai-interpretation 结果；无 AI 不影响简报
  const briefText = latest ? [
    '【今日竞争情报】（Demo / Sample Data）',
    '发现 ' + (summary ? summary.total : events.length) + ' 项已确认的竞争变化（价格下调 ' + (summary ? summary.decrease : 0) + ' · 价格上调 ' + (summary ? summary.increase : 0) + '）。',
    '最重要：' + latestBrand + ' · ' + latestTitle + ' 价格从 ' + fmtMoney(latest.old_price, latest.currency)
      + ' 调整至 ' + fmtMoney(latest.new_price, latest.currency) + '，' + latestDirWord + ' ' + latestPct + '%'
      + (latest.currency ? '（币种 ' + latest.currency + '）' : '（币种信息暂不可用）') + '。',
    '观察时间：' + fmtTime(latest.observed_at_old) + ' → ' + fmtTime(latest.observed_at_new),
    advice,
    briefAi ? 'AI 竞争分析（' + briefAi.model + '）：' + briefAi.insight : '',
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
        /* Design tokens：与 docs/design.md / globals.css :root 对齐，不引入新色值 */
        .demo-console { max-width: 960px; margin: 0 auto; padding: 20px 16px 60px; }
        .demo-badge { display: inline-block; font-size: 11.5px; border: 1px solid #d97b00; color: #b26500; border-radius: 6px; padding: 1px 8px; margin-left: 8px; vertical-align: middle; }
        .demo-h1 { font-size: 30px; font-weight: 800; color: #0D0D0D; letter-spacing: -0.8px; margin: 6px 0 2px; }
        .demo-sub { color: #888888; font-size: 12.5px; margin-bottom: 2px; }
        .demo-sub2 { color: #888888; font-size: 12px; margin-bottom: 16px; }
        .demo-card { border: 1px solid #E8E8E5; border-radius: 20px; padding: 24px; margin-bottom: 16px; background: #FFFFFF; box-shadow: 0 2px 12px rgba(0,0,0,0.06); }
        .demo-card.brief { border-color: var(--brand-line, #BDEFD4); background: var(--brand-dim, #E7F9EF); }
        .demo-sec-title { font-size: 11px; font-weight: 600; color: #888888; text-transform: uppercase; letter-spacing: 0.06em; margin: 18px 0 8px; }
        .demo-btn { border: 1.5px solid #D0D0CC; color: #0D0D0D; background: #FFFFFF; border-radius: 12px; padding: 6px 14px; font-size: 13.5px; font-weight: 600; cursor: pointer; margin-right: 8px; }
        .demo-btn.primary { background: #0D0D0D; color: var(--brand-hi, #8EF69A); border: none; }
        .demo-btn-text { border: none; background: none; color: #0D0D0D; font-size: 13px; cursor: pointer; padding: 6px 4px; text-decoration: underline; text-underline-offset: 3px; }
        .demo-btn:disabled, .demo-btn-text:disabled { opacity: .5; cursor: default; }
        .demo-price-old { text-decoration: line-through; color: #888888; font-size: 15px; }
        .demo-price-new { color: #d92d20; font-size: 26px; font-weight: 800; margin: 0 8px; }
        .demo-pct { color: #d92d20; font-weight: 700; }
        .demo-cur-note { color: #888888; font-size: 11px; border: 1px dashed #D0D0CC; border-radius: 6px; padding: 0 6px; }
        .demo-kv { font-size: 13px; color: #444444; margin: 2px 0; }
        .demo-kv b { color: #0D0D0D; }
        .demo-modal-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 60; }
        .demo-modal { background: #FFFFFF; border-radius: 20px; max-width: 640px; width: 92%; max-height: 82vh; overflow: auto; padding: 24px; box-shadow: 0 4px 16px rgba(0,0,0,0.12); }
        .demo-evidence { background: #F7F7F5; border-radius: 12px; padding: 10px 12px; margin: 8px 0; font-size: 13px; }
        .demo-ai { background: var(--brand-dim, #E7F9EF); border: 1px solid var(--brand-line, #BDEFD4); border-radius: 12px; padding: 12px 14px; margin-top: 10px; font-size: 13.5px; line-height: 1.7; color: #1A4A2E; }
        .demo-ai b { color: #0D0D0D; }
        .demo-ai-meta { color: #888888; font-size: 11.5px; margin-top: 6px; word-break: break-all; }
        .demo-ai-note { color: #888888; font-size: 11.5px; margin-top: 4px; }
        .demo-err { color: #b26500; font-size: 12.5px; margin-top: 8px; }
        .demo-empty { color: #888888; font-size: 13px; padding: 18px 0; text-align: center; }
        .demo-row { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
        .demo-brief-line { font-size: 13.5px; margin: 5px 0; line-height: 1.9; color: #444444; }
        .demo-brief-line b { color: #0D0D0D; }
        .demo-brief-new { color: #d92d20; font-weight: 700; }
        .demo-brief-advice { color: #1A4A2E; font-size: 13px; margin-top: 8px; }
        details.demo-tech { margin-top: 12px; border-top: 1px dashed #E8E8E5; padding-top: 8px; }
        details.demo-tech summary { color: #888888; font-size: 12px; cursor: pointer; user-select: none; }
        details.demo-tech .demo-tech-body { color: #888888; font-size: 11.5px; line-height: 1.8; margin-top: 6px; word-break: break-all; }
      `}</style>

      {/* 1) Hero */}
      <div>
        <span className="demo-h1">Vantage · AI 竞争情报分析师</span>
        <span className="demo-badge">Demo / Sample Data</span>
        <div className="demo-sub">持续监测竞争品牌 · 记录历史 · 发现变化 · 分析影响 · 关键判断可追溯</div>
        <div className="demo-sub2">每项关键判断均可追溯至数据来源。</div>
      </div>

      {/* 2) 今日竞争情报（首屏最显眼）：数字全部来自 recent-changes；AI 不可用时仅显确定性事实 */}
      <div className="demo-sec-title">今日竞争情报</div>
      {latest ? (
        <div className="demo-card brief">
          <div className="demo-brief-line">
            发现 <b>{summary ? summary.total : events.length}</b> 项已确认的竞争变化（价格下调 <b>{summary ? summary.decrease : 0}</b> · 价格上调 <b>{summary ? summary.increase : 0}</b>）。
          </div>
          <div className="demo-brief-line" style={{ fontSize: 15 }}>
            <b>{latestBrand} · {latestTitle}</b>
          </div>
          <div className="demo-row" style={{ margin: '6px 0' }}>
            <span className="demo-price-old">{fmtMoney(latest.old_price, latest.currency)}</span>
            <span>→</span>
            <span className="demo-price-new">{fmtMoney(latest.new_price, latest.currency)}</span>
            {!latest.currency && <span className="demo-cur-note">币种信息暂不可用</span>}
            {/* P1：direction=null（混合区间变化）不伪造涨跌方向，不显示 0% 箭头 */}
            {latest.direction === null
              ? <span className="demo-pct">区间变化</span>
              : <span className="demo-pct">{latest.direction === 'decrease' ? '↓' : '↑'} {latestPct}%</span>}
          </div>
          <div className="demo-kv">观察时间：{fmtTime(latest.observed_at_old)} → {fmtTime(latest.observed_at_new)}</div>
          {briefAi && (
            <div className="demo-ai">
              <b>竞争影响分析</b><br />{briefAi.insight}
              <div className="demo-ai-note">基于已确认事件生成，不用于替代业务决策。</div>
              <div className="demo-ai-meta">分析模型 {briefAi.model}{briefAi.cached ? ' · 缓存结果' : ''}</div>
            </div>
          )}
          <div className="demo-brief-advice">{advice}</div>
          <div style={{ marginTop: 10 }}>
            <button className="demo-btn primary" onClick={() => latest && openDetail(latest)}>查看详情</button>
            <button className="demo-btn" onClick={copyBrief}>复制简报</button>
            {copyMsg && <span className="demo-kv" style={{ marginLeft: 4 }}>{copyMsg}</span>}
          </div>
        </div>
      ) : (
        <div className="demo-card">
          <div className="demo-empty">暂无已确认的竞争变化。系统将在后续监测中持续更新竞争动态。</div>
        </div>
      )}

      {/* 3) 近期竞争动态（Event cards） */}
      <div className="demo-sec-title">近期竞争动态</div>
      <div className="demo-card">
        <div style={{ marginBottom: 10 }}>
          <button className="demo-btn primary" disabled={seeding} onClick={seed}>{seeding ? '正在载入演示数据…' : '载入演示数据'}</button>
              <span className="demo-kv" style={{ marginLeft: 4, color: '#888888' }}>载入一组固定演示数据，用于展示完整的竞争变化识别与数据溯源流程。</span>
          {seedMsg && <div className="demo-kv" style={{ marginTop: 4 }}>{seedMsg}</div>}
        </div>
        {summary && (
          <div className="demo-kv" style={{ marginBottom: 8 }}>
            近期共 <b>{summary.total}</b> 项已确认变化 · 价格变动 · 下调 <b>{summary.decrease}</b> · 价格变动 · 上调 <b>{summary.increase}</b>
          </div>
        )}
        {!events.length && <div className="demo-empty">暂无已确认的竞争变化。系统将在后续监测中持续更新竞争动态。</div>}
        {events.map(ev => {
          const brand = (ev.entity_ref && (ev.entity_ref as Record<string, unknown>).brand_name) || '竞争品牌';
          const title = (ev.entity_ref && (ev.entity_ref as Record<string, unknown>).title) || '商品';
          return (
            <div key={ev.event_id} style={{ borderTop: '1px solid #F0F0EE', padding: '12px 0' }}>
              <div className="demo-row">
                <b>{String(brand)}</b>
                <span style={{ color: '#444444', fontSize: 13 }}>{String(title)}</span>
                <span className="demo-kv">{ev.direction === 'decrease' ? '价格变动 · 下调' : ev.direction === 'increase' ? '价格变动 · 上调' : '竞争变化'}</span>
              </div>
              <div className="demo-row" style={{ marginTop: 4 }}>
                <span className="demo-price-old">{fmtMoney(ev.old_price, ev.currency)}</span>
                <span>→</span>
                <span className="demo-price-new">{fmtMoney(ev.new_price, ev.currency)}</span>
                {!ev.currency && <span className="demo-cur-note">币种信息暂不可用</span>}
                {ev.direction === 'decrease' && <span className="demo-pct">↓ {Math.abs(ev.pct ?? 0).toFixed(1)}%</span>}
                {ev.direction === 'increase' && <span className="demo-pct" style={{ color: '#b26500' }}>↑ {Math.abs(ev.pct ?? 0).toFixed(1)}%</span>}
              </div>
              <div className="demo-kv">检出时间：{fmtTime(ev.occurred_at)} · 观察窗口 {fmtTime(ev.observed_at_old)} → {fmtTime(ev.observed_at_new)} · 数据状态：已确认变化</div>
              <div style={{ marginTop: 8 }}>
                <button className="demo-btn primary" onClick={() => openDetail(ev)}>查看详情</button>
                <button className="demo-btn" onClick={() => openEvidence(ev.new_evidence_ids[0])}>查看数据依据</button>
                <button className="demo-btn-text" disabled={!!aiLoading} onClick={() => askAi(ev)}>{aiLoading === ev.event_id ? '正在生成竞争影响分析…' : 'AI 竞争分析'}</button>
              </div>
              {insight[ev.event_id] && (
                <div className="demo-ai">
                  <b>竞争影响分析</b> · {insight[ev.event_id].insight}
                  <div className="demo-ai-note">基于已确认事件生成，不用于替代业务决策。</div>
                  <div className="demo-ai-meta">分析模型 {insight[ev.event_id].model}{insight[ev.event_id].cached ? ' · 缓存结果' : ''}</div>
                </div>
              )}
              {aiErr[ev.event_id] && <div className="demo-err">{aiErr[ev.event_id]}</div>}
            </div>
          );
        })}
      </div>

      {/* 竞争品牌发现入口（复用现有 Discovery 链路，不重写） */}
      <div className="demo-sec-title">竞争品牌发现</div>
      <div className="demo-card demo-kv">
        输入品牌、商品关键词、类目或目标市场，发现值得持续关注的竞争品牌（品牌名 · 官网 · 定位摘要 · 竞争关联 · 一键关注）。
        <div style={{ marginTop: 8 }}>
          <Link className="demo-btn" style={{ textDecoration: 'none', display: 'inline-block' }} href="/">前往工作台 · 发现竞争品牌 →</Link>
        </div>
      </div>

      {/* 竞争品牌档案入口（复用现有 intel 档案页） */}
      <div className="demo-sec-title">竞争品牌档案</div>
      <div className="demo-card demo-kv">
        统一档案：品牌定位 · 商品列表 · 价格区间 · 近期竞争动态 · 数据依据与来源入口。无可靠数据的模块自动隐藏，不伪造采集结果。
        <div style={{ marginTop: 8 }}>
          <Link className="demo-btn" style={{ textDecoration: 'none', display: 'inline-block' }} href="/intel">打开竞争品牌档案 →</Link>
        </div>
      </div>

      {/* 事件详情 Modal：发生了什么 → 竞争影响分析 → 数据依据 → 技术溯源（折叠） */}
      {detail && (
        <div className="demo-modal-mask" onClick={() => setDetail(null)}>
          <div className="demo-modal" onClick={e => e.stopPropagation()}>
            <div className="demo-h1" style={{ fontSize: 17 }}>发生了什么</div>
            <span className="demo-badge">{String(detail.event.note || 'Demo / Sample Data').slice(0, 40)}</span>
            <div className="demo-kv" style={{ marginTop: 10 }}>竞争品牌：<b>{String((detail.event.entity_ref && (detail.event.entity_ref as Record<string, unknown>).brand_name) || '竞争品牌')}</b></div>
            <div className="demo-kv">商品：<b>{String((detail.event.entity_ref && (detail.event.entity_ref as Record<string, unknown>).title) || '商品')}</b></div>
            <div className="demo-kv">价格变化：</div>
            <div className="demo-row" style={{ margin: '4px 0 8px' }}>
              <span className="demo-price-old">{fmtMoney(detail.event.old_price, detail.event.currency)}</span>
              <span>→</span>
              <span className="demo-price-new">{fmtMoney(detail.event.new_price, detail.event.currency)}</span>
              {!detail.event.currency && <span className="demo-cur-note">币种信息暂不可用</span>}
              {/* P1：direction=null（混合区间变化）诚实无方向，不显示 0% 箭头 */}
              {detail.event.direction === null
                ? <span className="demo-pct">区间变化</span>
                : <span className="demo-pct">{detail.event.direction === 'decrease' ? '↓' : '↑'} {Math.abs(detail.event.pct ?? 0).toFixed(1)}%</span>}
            </div>
            <div className="demo-kv">变化幅度：{detail.event.direction === null ? '区间边界混合变化（无单一方向）' : (detail.event.direction === 'decrease' ? '下降 ' : '上涨 ') + Math.abs(detail.event.pct ?? 0).toFixed(1) + '%'}</div>
            <div className="demo-kv">时间：观察窗口 {fmtTime(detail.event.observed_at_old)} → {fmtTime(detail.event.observed_at_new)} · 检出 {fmtTime(detail.event.occurred_at)}</div>
            <div className="demo-kv">状态：<b>已确认变化</b></div>

            <div className="demo-sec-title">竞争影响分析</div>
            {insight[detail.event.event_id]
              ? <div className="demo-ai">{insight[detail.event.event_id].insight}<div className="demo-ai-note">基于已确认事件生成，不用于替代业务决策。</div><div className="demo-ai-meta">分析模型 {insight[detail.event.event_id].model}</div></div>
              : <div><button className="demo-btn primary" disabled={!!aiLoading} onClick={() => askAi(detail.event)}>{aiLoading === detail.event.event_id ? '正在生成竞争影响分析…' : '生成竞争影响分析'}</button>{aiErr[detail.event.event_id] && <div className="demo-err">{aiErr[detail.event.event_id]}</div>}</div>}

            <div className="demo-sec-title">数据依据（{detail.evidences.length} 条）</div>
            {detail.evidences.map(ev => (
              <div className="demo-evidence" key={String(ev.evidence_id)}>
                <div>数据来源：<b>{sourceLabel(ev)}</b></div>
                <div>观察时间：{fmtTime(String(ev.observed_at || ''))} · 观察值：<b>{fmtValue(ev.extracted_value)}</b></div>
                <div>数据状态：{statusZh(ev.evidence_status)}</div>
                <div style={{ marginTop: 6 }}>
                  <button className="demo-btn" onClick={() => openEvidence(String(ev.evidence_id))}>查看完整数据依据</button>
                </div>
              </div>
            ))}

            {/* 技术溯源：默认折叠，技术评委展开后可见完整可信度链 */}
            <details className="demo-tech">
              <summary>技术溯源（DomainEvent → Diff → Fact → Evidence → SourceSnapshot）</summary>
              <div className="demo-tech-body">
                <div>Event ID：{String(detail.event.event_id)}</div>
                <div>Diff ID：{detail.diff ? String((detail.diff as { diff_id?: string }).diff_id) : '—'}（status={detail.diff ? String((detail.diff as { status?: string }).status) : '—'}）</div>
                <div>Fact ID：{detail.facts.old ? String((detail.facts.old as { fact_id?: string }).fact_id) : '—'} → {detail.facts.new ? String((detail.facts.new as { fact_id?: string }).fact_id) : '—'}</div>
                <div>Evidence ID：{detail.evidences.map(ev => String(ev.evidence_id)).join(' · ') || '—'}</div>
                <div>Snapshot ID：{detail.snapshots.map(s => String(s.snapshot_id)).join(' · ') || '—'}</div>
              </div>
            </details>

            <div style={{ marginTop: 14, textAlign: 'right' }}>
              <button className="demo-btn" onClick={() => setDetail(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* 数据依据与来源 Modal：业务字段默认可见，技术细节折叠 */}
      {evModal && (
        <div className="demo-modal-mask" onClick={() => setEvModal(null)}>
          <div className="demo-modal" onClick={e => e.stopPropagation()}>
            <div className="demo-h1" style={{ fontSize: 17 }}>数据依据与来源</div>
            <div className="demo-kv">观察值：<b>{fmtValue(evModal.evidence.extracted_value)}</b></div>
            <div className="demo-kv">数据状态：<b>{statusZh(evModal.evidence.evidence_status)}</b></div>
            <div className="demo-kv">观察时间：{fmtTime(String(evModal.evidence.observed_at || ''))}</div>
            <div className="demo-kv">数据来源：{sourceLabel(evModal.evidence as Record<string, unknown>)}</div>
            <div className="demo-kv">币种：{evModal.evidence.currency == null ? '币种信息暂不可用' : String(evModal.evidence.currency)}</div>
            {evModal.snapshots.map((s, i) => (
              <div className="demo-evidence" key={i}>
                <div>原始来源：<a href={String(s.source_url || '')} target="_blank" rel="noreferrer" style={{ color: '#3F9C65', wordBreak: 'break-all' }}>{String(s.source_url || '—')}</a></div>
              </div>
            ))}
            <details className="demo-tech">
              <summary>技术溯源（Evidence → SourceSnapshot）</summary>
              <div className="demo-tech-body">
                <div>Evidence ID：{String(evModal.evidence.evidence_id)} · status {String(evModal.evidence.evidence_status)}{evModal.evidence.reason_code ? '（' + String(evModal.evidence.reason_code) + '）' : ''}</div>
                <div>source {String(evModal.evidence.source || '—')} · provider {String(evModal.evidence.provider || '—')}</div>
                <div>extracted_value 原始：{JSON.stringify(evModal.evidence.extracted_value)}</div>
                {evModal.snapshots.map((s, i) => (
                  <div key={i} style={{ marginTop: 6 }}>
                    <div>Snapshot ID：{String(s.snapshot_id)}</div>
                    <div>source_status {String(s.source_status)} · collector {String(s.collector_version)} · content_hash {String(s.content_hash)}</div>
                    {/* P2：不展示 raw_payload_ref.path（服务器内部文件路径）；API 层已过滤 */}
                  </div>
                ))}
              </div>
            </details>
            <div style={{ marginTop: 14, textAlign: 'right' }}>
              <button className="demo-btn" onClick={() => setEvModal(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
