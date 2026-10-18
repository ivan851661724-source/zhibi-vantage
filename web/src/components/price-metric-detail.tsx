'use client';

import { useEffect, useRef, useState } from 'react';
import { apiGet } from '@/lib/api';
import { useStateOperation } from '@/hooks/use-zhibi-state';
import type { StateOperation } from '@/lib/state-ownership';
import type { PriceChainIssue, PriceEvidence, PriceEvidenceDetail, PriceMetricPage, PriceMetricSummary, PriceObservationValue, PriceSourceSnapshot } from '@/types/state';

// No currency fallback or conversion: these values belong only to this Metric.
export function metricPrice(value: number | null, currency: string | null): string {
  return value == null ? '未形成' : `${value}${currency ? ` ${currency}` : '（币种未知）'}`;
}

function Times({ observed, updated, collected }: { observed?: string | null; updated?: string | null; collected?: string | null }) {
  return <div className="muted">
    <div>观察时间：{observed || '未知'}</div>
    {updated ? <div>来源更新时间：{updated}</div> : null}
    {collected ? <div>采集时间：{collected}</div> : null}
  </div>;
}

function SourceLink({ url }: { url?: string | null }) {
  let safe = false;
  try { safe = !!url && ['http:', 'https:'].includes(new URL(url).protocol); } catch { /* Missing or invalid source stays plain text. */ }
  return safe ? <a className="src-tag" href={url!} target="_blank" rel="noopener noreferrer">{url}</a>
    : <span className="muted">来源 URL：{url || '未知'}（无法打开）</span>;
}

function Issues({ issues }: { issues: PriceChainIssue[] }) {
  return issues.length ? <div className="hint" role="note"><b>当前缺链或原始资料问题</b>{issues.map((i, n) => <div key={n}>{i.kind} · {i.id} · {i.reason}</div>)}</div> : null;
}

function Observation({ value }: { value: PriceObservationValue | null }) {
  if (!value) return <div className="muted">来源值缺失</div>;
  return <div className="fb-flow">
    <div>原始价格范围：{value.price_min ?? '未知'} – {value.price_max ?? '未知'}</div>
    {(value.prices || []).map((v, n) => <div className="fb-item" key={n}>变体 {v.variant_id ?? '身份未知'} {v.title || ''} · price: {v.price ?? '未知'} · available: {v.available == null ? 'null（未知）' : String(v.available)}</div>)}
  </div>;
}

function Snapshot({ snapshot }: { snapshot: PriceSourceSnapshot }) {
  return <div className="field">
    <div className="field-t">SourceSnapshot · {snapshot.snapshot_id}</div>
    <div className="field-v">
      <SourceLink url={snapshot.source_url} />
      <div>来源：{snapshot.provider || '未知'} · 状态：{snapshot.source_status || '未知'}</div>
      <Times observed={snapshot.observed_at} updated={snapshot.source_updated_at} collected={snapshot.collected_at} />
      {snapshot.fetched_at ? <div className="muted">抓取批次时间：{snapshot.fetched_at}</div> : null}
      <div className="muted">采集版本：{snapshot.collector_version || '未知'} · 解析版本：{snapshot.parser_version || '未知'}</div>
      <div className="muted">内容 hash：{snapshot.content_hash || '未知'}</div>
      <div className="muted">原始资料：{snapshot.raw_resolvable === true ? '可解析' : snapshot.raw_resolvable === false ? '当前不可完整解析' : '可解析性未知'}</div>
    </div>
  </div>;
}

function Evidence({ evidence, snapshots }: { evidence: PriceEvidence; snapshots: PriceSourceSnapshot[] }) {
  return <div className="field">
    <div className="field-t">Evidence · {evidence.evidence_id}</div>
    <div className="field-v">
      <div>字段：{evidence.claim?.field || '未知'} · 状态：{evidence.evidence_status || '未知'} {evidence.reason_code || ''}</div>
      <div>来源：{evidence.source || evidence.provider || '未知'} · 币种：{evidence.currency || '未知'} · 市场：{evidence.market || '未知'} · 单位：{evidence.unit || '未知'}</div>
      <Times observed={evidence.observed_at} updated={evidence.source_updated_at} collected={evidence.collected_at} />
      <div className="muted">解析版本：{evidence.parser_version || '未知'} · 提取版本：{evidence.extractor_version || '未知'}</div>
      <Observation value={evidence.extracted_value} />
      {(evidence.source_snapshot_ids || []).map(id => {
        const snapshot = snapshots.find(s => s.snapshot_id === id);
        return snapshot ? <Snapshot key={id} snapshot={snapshot} /> : <p className="hint" key={id}>SourceSnapshot {id} · 当前缺链</p>;
      })}
    </div>
  </div>;
}

interface OpenDetail {
  metricId: string;
  owner: StateOperation;
  pages: PriceMetricPage[];
  loading: boolean;
  error: string;
  evidenceId: string | null;
  evidence: PriceEvidenceDetail | null;
  evidenceLoading: boolean;
  evidenceError: string;
}

/** Shared inline audit view. Each async lane also checks Provider generation/session/lifetime. */
export function PriceMetricBlock({ metric }: { metric: PriceMetricSummary }) {
  const beginOperation = useStateOperation();
  const [detail, setDetail] = useState<OpenDetail | null>(null);
  const latestMetric = useRef(metric.metric_id);
  latestMetric.current = metric.metric_id;
  const requests = useRef({ lifetime: 0, detail: 0, page: 0, evidence: 0 });
  const ownershipCurrent = detail?.owner.isCurrent() ?? false;
  const currentDetail = detail?.metricId === metric.metric_id && ownershipCurrent ? detail : null;

  function invalidate() {
    const r = requests.current;
    r.lifetime++; r.detail++; r.page++; r.evidence++;
  }
  useEffect(() => {
    invalidate(); setDetail(null);
    return () => { invalidate(); };
  }, [metric.metric_id]);
  // A→B→A may invalidate ownership while ending on the same rendered project ID.
  useEffect(() => {
    if (detail && !ownershipCurrent) { invalidate(); setDetail(null); }
  }, [detail, ownershipCurrent]);

  function close() { invalidate(); setDetail(null); }
  async function readPage(offset: number, opening = false) {
    const owner = beginOperation();
    if (!owner.isCurrent()) return;
    if (opening) invalidate();
    const id = metric.metric_id, lifetime = requests.current.lifetime;
    const lane = opening || offset === 0 ? 'detail' : 'page';
    const sequence = ++requests.current[lane];
    const valid = () => owner.isCurrent() && latestMetric.current === id && requests.current.lifetime === lifetime && requests.current[lane] === sequence;
    if (opening) setDetail({ metricId: id, owner, pages: [], loading: true, error: '', evidenceId: null, evidence: null, evidenceLoading: false, evidenceError: '' });
    else setDetail(d => d ? { ...d, loading: true, error: '' } : null);
    try {
      const page = await apiGet<PriceMetricPage>(`/api/price-metric?id=${encodeURIComponent(id)}&offset=${offset}&limit=20`);
      if (!valid()) return;
      if (page.metric.metric_id !== id) throw new Error('返回的统计依据与当前指标不一致');
      setDetail(d => d ? { ...d, pages: offset === 0 ? [page] : [...d.pages, page], loading: false, error: '' } : null);
    } catch (error) {
      if (valid()) setDetail(d => d ? { ...d, loading: false, error: error instanceof Error ? error.message : String(error) } : null);
    }
  }
  function closeEvidence() {
    requests.current.evidence++;
    setDetail(d => d ? { ...d, evidenceId: null, evidence: null, evidenceLoading: false, evidenceError: '' } : null);
  }
  async function readEvidence(id: string) {
    const owner = beginOperation();
    if (!owner.isCurrent() || !currentDetail) return;
    const metricId = metric.metric_id, lifetime = requests.current.lifetime, sequence = ++requests.current.evidence;
    const valid = () => owner.isCurrent() && latestMetric.current === metricId && requests.current.lifetime === lifetime && requests.current.evidence === sequence;
    setDetail(d => d ? { ...d, evidenceId: id, evidence: null, evidenceLoading: true, evidenceError: '' } : null);
    try {
      const evidence = await apiGet<PriceEvidenceDetail>(`/api/evidence-detail?id=${encodeURIComponent(id)}`);
      if (!valid()) return;
      if (evidence.evidence.evidence_id !== id) throw new Error('返回的证据与当前选择不一致');
      setDetail(d => d ? { ...d, evidence, evidenceLoading: false } : null);
    } catch (error) {
      if (valid()) setDetail(d => d ? { ...d, evidenceLoading: false, evidenceError: error instanceof Error ? error.message : String(error) } : null);
    }
  }
  const limitationLabels: Record<string, string> = {
    insufficient_sample: '样本不足：至少需要3个明确可售正价商品，暂不形成价格统计',
    currency_unknown: '币种未知', market_unknown: '市场未知', unit_unknown: '单位未知',
    availability_unknown: '部分变体可售性未知，未计入有效价格样本',
    invalid_or_missing_price: '存在无效或缺价商品 / 变体', partial_scan: '采集不完整，仅代表已观察目录',
  };
  const limitations = new Set(metric.limitations || []);
  if (!metric.currency) limitations.add('currency_unknown');
  if (!metric.market) limitations.add('market_unknown');
  if (!metric.unit) limitations.add('unit_unknown');
  if (metric.partial_scan) limitations.add('partial_scan');
  if (metric.sample_product_count < 3) limitations.add('insufficient_sample');
  const lastPage = currentDetail?.pages.at(-1);
  const nextOffset = lastPage?.hasMore ? lastPage.nextOffset : null;
  return <div className="field" data-price-metric={metric.metric_id}>
    <div className="field-t">已观察目录价格统计 <span className="tag inferred">派生统计</span></div>
    <div className="field-v">
      <div>中位数 {metricPrice(metric.value.median, metric.currency)} · 目录样本四分位区间 {metricPrice(metric.value.p25, metric.currency)} – {metricPrice(metric.value.p75, metric.currency)}</div>
      <p className="hint">每商品一个观察点；仅使用观察时明确可售的正价变体，商品内取中位数。此目录样本不代表核心产品线、成交价或销量加权价格。</p>
      <div className="muted">有效样本 {metric.sample_product_count} 款 · 币种 {metric.currency || '未知'} · 市场 {metric.market || '未知'} · 单位 {metric.unit || '未知'}</div>
      <div className="muted">商品计数（各类可重叠）：观察商品 {metric.product_counts.observed} · 含明确可售正价变体商品 {metric.product_counts.active_paid} · 含零价变体商品 {metric.product_counts.free}（仅明确可售） · 含可售性未知变体商品 {metric.product_counts.unknown_availability} · 含缺货变体商品 {metric.product_counts.sold_out} · 含无效价格变体商品 {metric.product_counts.invalid} · 无有效价格观察商品 {metric.product_counts.missing_price}</div>
      <div className="muted">变体计数（商品内按真实身份去重）：观察 {metric.variant_counts.observed} · 明确可售正价 {metric.variant_counts.active_paid} · 可售零价 {metric.variant_counts.active_free} · 可售性未知 {metric.variant_counts.unknown_availability} · 缺货 {metric.variant_counts.sold_out} · 无效 {metric.variant_counts.invalid}</div>
      {[...limitations].map(reason => <div className="hint" key={reason}>{limitationLabels[reason] || reason}</div>)}
      <div className="muted">观察时间：{metric.observed_from || '未知'} 至 {metric.observed_to || '未知'}</div>
      <div className="muted">计算时间：{metric.computed_at || '未知'} · 新鲜度未知；计算时间不代表重新观察</div>
      <button className="btn-mini" type="button" aria-expanded={!!currentDetail} onClick={() => currentDetail ? close() : void readPage(0, true)}>{currentDetail ? '收起统计依据' : '展开统计依据'}</button>
      {currentDetail ? <div className="fb-flow">
        <div className="muted">Metric · {metric.metric_id} · {metric.evidence_status} · 算法 {metric.algorithm_version} · 配置 {metric.config_version}</div>
        {currentDetail.loading ? <p className="hint" role="status">正在读取统计依据…</p> : null}
        {currentDetail.error ? <p className="hint" role="alert">统计依据读取失败：{currentDetail.error} <button className="link-btn" type="button" onClick={() => void readPage(currentDetail.pages.length ? nextOffset ?? 0 : 0)}>{currentDetail.pages.length ? '重试加载下一页' : '重试读取依据'}</button></p> : null}
        {currentDetail.pages.map(page => <div key={page.offset}>
          <div className="muted">依据页：偏移 {page.offset} · 共 {page.total} 条 Fact 引用</div>
          <Issues issues={page.issues} />
          {page.offset === 0 ? <>
            <div className="muted">计算配置：{JSON.stringify(page.metric.config)}</div>
            {page.collectionIssues.map((issue, n) => <div className="hint" key={n}>采集范围问题 · {issue.snapshot_id} · {issue.source_status} · {issue.reason || '原因未知'}{issue.empty ? ' · 空页' : ''}</div>)}
          </> : null}
          {page.facts.map(fact => <div className="field" key={fact.fact_id}>
            <div className="field-t">Fact · {fact.fact_id} · {fact.entity_ref?.title || fact.entity_key || '对象未知'}</div>
            <div className="field-v">
              <div>字段：{fact.claim?.field || '未知'} · 范围：{fact.claim?.scope || '未知'}</div>
              <div>币种：{fact.currency || '未知'} · 市场：{fact.market || '未知'} · 单位：{fact.unit || '未知'} · 派生版本：{fact.derivation_version || '未知'}</div>
              <Times observed={fact.observed_at} />
              <Observation value={fact.value} />
              {fact.evidence_ids.map(id => {
                const evidence = page.evidences.find(e => e.evidence_id === id);
                return <div key={id}>{evidence ? <Evidence evidence={evidence} snapshots={page.snapshots} /> : <p className="hint">Evidence {id} · 当前缺链</p>}<button className="link-btn" type="button" onClick={() => void readEvidence(id)}>查看证据 {id}</button></div>;
              })}
              {fact.source_snapshot_ids.filter(id => !page.evidences.some(e => e.source_snapshot_ids.includes(id))).map(id => {
                const snapshot = page.snapshots.find(s => s.snapshot_id === id);
                return snapshot ? <Snapshot key={id} snapshot={snapshot} /> : <p className="hint" key={id}>SourceSnapshot {id} · 当前缺链</p>;
              })}
            </div>
          </div>)}
        </div>)}
        {nextOffset != null ? <button className="btn-mini" type="button" disabled={currentDetail.loading} onClick={() => void readPage(nextOffset)}>继续加载依据</button> : null}
        {currentDetail.evidenceId ? <div className="field" role="region" aria-label="证据详情">
          <div className="field-t">证据详情 · {currentDetail.evidenceId} <button className="link-btn" type="button" onClick={closeEvidence}>关闭证据详情</button></div>
          {currentDetail.evidenceLoading ? <p role="status">正在读取证据…</p> : null}
          {currentDetail.evidenceError ? <p className="hint" role="alert">证据读取失败：{currentDetail.evidenceError} <button className="link-btn" type="button" onClick={() => void readEvidence(currentDetail.evidenceId!)}>重试读取证据</button></p> : null}
          {currentDetail.evidence ? <><Evidence evidence={currentDetail.evidence.evidence} snapshots={currentDetail.evidence.snapshots} /><Issues issues={currentDetail.evidence.issues} /></> : null}
        </div> : null}
      </div> : null}
    </div>
  </div>;
}
