'use client';

import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut } from '@/lib/api';
import { useStateOperation } from '@/hooks/use-zhibi-state';
import { captureSession } from '@/lib/storage-scope';
import type { StateOperation } from '@/lib/state-ownership';
import type { Competitor, MonitoringCoverage, MonitoringEventDetail, MonitoringEventProjection, MonitoringJob, MonitoringStatus, MonitoringTarget, MonitoringWorkspace } from '@/types/state';

const explanations: Record<string, string> = {
  BAD_INPUT: '输入内容不符合要求，请检查后重试', INVALID_TIME_ZONE: '时区无效，请填写 IANA 时区', EXPLICIT_WORKSPACE_SCOPE_REQUIRED: '请完整填写工作空间名称、市场和时区',
  WORKSPACE_NOT_FOUND: '工作空间当前不可用', WATCH_TARGET_NOT_FOUND: '监控目标当前不可用', TARGET_MARKET_CHANGED: '工作空间市场已变化，旧目标不能直接恢复',
  FORMAL_MONITORING_DISABLED: '正式监控尚未启用', SCHEDULER_DISABLED: '巡检调度已关闭', RUNTIME_STOPPED: '巡检服务已停止',
  TENANT_NOT_FOUND: '账户当前不可用', TENANT_SUSPENDED: '账户已暂停', TARGET_NOT_EXECUTABLE: '目标已暂停或当前不能执行',
  ADMISSION_REJECTED: '正式监控准入条件未满足', PROJECT_CHANGED: '当前研究档案已切换，请重新展开面板',
  TARGET_SCOPE_CHANGED: '工作空间范围已变更，旧目标需要重新准入', WORKSPACE_SCOPE_CHANGED: '工作空间范围已变更，旧目标需要重新准入',
  canonical_identity_unavailable: '品牌身份尚未核实', qualification_result_unavailable: '资格证明尚未接通',
  server_references_missing_or_mismatched: '当前档案的品牌或资格引用不可用', qualification_scope_or_status_mismatch: '资格与当前工作空间范围不匹配',
  qualification_contract_invalid: '资格资料尚不完整', qualification_provenance_invalid: '资格依据目前无法完整核验',
  known_catalog_source_unverified: '尚未核实可直接观察的 Shopify 目录来源', invalid_reference: '当前对象缺少正式引用',
  project_ownership_unverified: '当前研究档案归属尚未核实', project_competitors_invalid: '当前研究对象资料不完整', workspace_not_found: '工作空间当前不可用',
  SOURCE_SCOPE_MISMATCH: '来源范围核验失败，本次资料不可用', RECHECK_EVENT_SCOPE_UNVERIFIED: '这项变化的范围依据不足，未安排复查',
  RECHECK_EVENT_TIME_UNVERIFIED: '这项变化的观察时间依据不足，未安排复查', MONITORING_QUEUE_FULL: '巡检队列已满，本次请求未完成，可稍后重试',
  target_or_scope_invalidated: '目标或范围已变更，本次任务已失效', collection_or_projection_incomplete: '本次采集或结果保存未完成',
  snapshot_endpoint_mismatch: '实际来源与获准范围不符', snapshot_provider_or_capability_mismatch: '来源能力与获准范围不符',
  snapshot_tenant_or_project_mismatch: '来源归属与当前范围不符', catalog_snapshot_missing: '目录原始资料缺失', catalog_url_mismatch: '目录网址与获准范围不符',
  empty_catalog: '本次目录为空，不能据此判断没有变化', partial_scan: '目录只检查了一部分', currency_source_unavailable: '币种来源不可用',
  event_outside_watch_scope: '部分变化不属于当前监控范围，未关联', scheduler_observation_gap: '调度期间存在无法确认的检查窗口',
  pending_window_backpressure: '先前窗口仍在排队，本窗口未完成检查',
  canonical_and_qualification_producers_not_connected: '品牌身份与资格的真实生产入口尚未接通',
  product_catalog_only: '当前只支持 Shopify 目录观察', source_market_may_be_unknown: '来源市场可能未知，不能借工作空间市场补值',
  coverage_quiet_notifications_not_implemented: '全范围检查、静默摘要与通知尚未接通',
  canonical_collection_coalescing_not_implemented: '跨工作空间的公开资料采集合并尚未接通',
  qualification_reference_migration_not_implemented: '资格更新后的引用迁移尚未接通', provider_throttle_is_job_level: '采集节奏按任务控制，单页请求仍可能受限',
  inflight_http_not_cancellable: '暂停后已发出的来源请求可能仍会结束，其迟到结果不得作为当前结果',
  filesystem_and_sqlite_not_globally_atomic: '异常中断时原始资料与结果保存可能不同时完成',
  policy_unknown: '检查策略及其批准依据未知', window_unknown: '完整检查窗口范围未知', window_incomplete: '检查窗口尚未完成',
  denominator_unknown: '应检查的目标集合未知', coverage_counts_unknown: '完成检查的计数依据不足', coverage_below_100_percent: '尚不能证明所有必需检查均已完成',
  required_p0_unknown: '必需检查能力尚未明确', missing_capabilities_unknown: '缺失检查能力尚不能确认', required_p0_missing: '存在未完成的必需检查能力', required_p0_incomplete: '必需检查能力的完整性依据不足',
  freshness_unknown: '资料鲜度及其策略未知', stale: '资料已过时', actionability_unknown: '变化是否可行动的判定依据不足', verified_actionable_event: '存在已经核验的可行动变化',
  comparison_unknown: '价格比较尚不能证明完整', scan_completeness_unknown: '目录检查完整性未知', source_incomplete: '来源检查未完整完成',
  source_results_unknown: '来源检查结果未知', source_failures_unknown: '来源失败情况未知', source_failure: '存在失败或不完整的来源检查',
  observation_issues_unknown: '检查记录的问题情况未知', observation_issue: '检查记录存在尚未解决的问题', fact_observation_missing: '本次缺少可用的事实观察',
  notification_policy_unknown: '外部通知策略尚未批准', notification_preferences_unknown: '外部通知偏好尚未明确', external_eligibility_unknown: '外部推送资格尚未明确',
  observed_unconfirmed: '这是已观察的目录价格变化，尚未确认', catalog_product_price_only: '仅反映商品目录价格，不代表订单客单价或销量',
  category_relevance_unknown: '目标品类仅作范围关联，商品的品类关联尚未验证', coverage_window_unknown: '完整检查窗口尚未建立', importance_unknown: '业务重要性未知',
  source_market_unknown: '来源市场未知', no_previous_fact: '缺少较早的可比价格观察', not_replayed: '重复事实未重新比较', comparison_failed: '价格比较未完成',
  no_event_for_no_meaningful_change: '本项可比价格未见有意义变化，不代表全范围没有变化',
  no_event_for_incomparable: '本项价格观察不可比', no_event_for_unavailable: '本项价格比较依据不可用',
  coverage_window_policy_not_implemented: '完整检查窗口策略尚未接通', external_notifications_not_implemented: '外部推送尚未接通', scheduled_digest_not_implemented: '正式日报及周回执尚未接通',
};
function explain(code: string): string {
  if (explanations[code]) return explanations[code];
  if (/partial|pagination|page_budget|truncat/i.test(code)) return '目录检查不完整';
  if (/identity|brand|source_changed/i.test(code)) return '品牌身份或来源已变化，需要重新核验';
  if (/qualification/i.test(code)) return '资格证明当前不可用，需要重新核验';
  if (/scope|revision/i.test(code)) return '目标范围或版本已变化，需要重新准入';
  if (/metric|fact|evidence|snapshot/i.test(code)) return '本次资料或统计依据不完整';
  return '服务端报告尚未解决的检查问题，请稍后刷新或联系管理员';
}
const jobLabels: Record<MonitoringJob['status'], string> = { pending: '等待执行', running: '执行中', done: '任务已完成（不代表没有变化）', error: '执行失败', dead: '已停止重试' };
const targetLabels: Record<MonitoringTarget['monitoring_status'], string> = { inactive: '未启用', active: '已启用', degraded: '运行受损', paused: '已暂停' };
const sourceLabels: Record<string, string> = { success: '取得资料', partial: '仅取得部分资料', unavailable: '来源不可用', blocked: '来源阻止访问', rate_limited: '来源限流', parse_failed: '资料解析失败', timeout: '来源请求超时', internal_error: '处理失败' };
function plannedTime(at: number, zone: string): string {
  try { return new Intl.DateTimeFormat('zh-CN', { timeZone: zone, dateStyle: 'short', timeStyle: 'short', hour12: false }).format(at) + '（' + zone + '）'; }
  catch { return Number.isFinite(at) ? new Date(at).toISOString() + '（UTC）' : '时间未知'; }
}
function validZone(zone: string): boolean {
  if (!zone.trim()) return false;
  try { new Intl.DateTimeFormat('zh-CN', { timeZone: zone.trim() }); return true; } catch { return false; }
}
function Issues({ values }: { values: string[] }) {
  return <>{Array.from(new Set(values.map(explain))).map(value => <p className="hint" key={value}>{value}</p>)}</>;
}
function knownCount(value: number | null | undefined): string { return value == null ? '未知' : String(value); }
function sourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function CoverageObservation({ value: v }: { value: MonitoringCoverage }) {
  const capabilityText = (values: string[] | null) => values == null ? '未知' : values.length ? values.map(explain).join('；') : '服务端未列出';
  return <div className="field" data-coverage-id={v.coverage_id}>
    <div className="field-t">逐任务检查记录</div>
    <p>记录：{v.coverage_id} · 工作空间：{v.workspace_id} · 目标：{v.watch_target_id} · 版本 {v.revision} · 任务：{v.job_id} · 尝试 {v.attempt}</p>
    <p>任务市场范围：{v.market} · 品类范围：{v.category_scope} · 完成时间：{plannedTime(v.completed_at, v.target_market_timezone)}</p>
    <p>预期目标：{knownCount(v.expected_targets)} · 实际尝试目标：{knownCount(v.attempted_targets)} · 成功目标：{knownCount(v.successful_targets)} · 合格成功目标：{knownCount(v.qualified_successful_targets)} · 失败目标：{knownCount(v.failed_targets)}</p>
    <p>必需检查能力：{capabilityText(v.required_capabilities)} · 缺失检查能力：{capabilityText(v.missing_capabilities)}</p>
    <p>窗口范围：{v.window_start == null || v.window_end == null ? '未知' : `${plannedTime(v.window_start, v.target_market_timezone)} 至 ${plannedTime(v.window_end, v.target_market_timezone)}`} · 窗口完成：{v.window_complete == null ? '未知' : v.window_complete ? '是' : '否'}</p>
    <p>资料鲜度：{v.freshness_status == null ? '未知' : v.freshness_status === 'fresh' ? '服务端标记为新鲜' : explain(v.freshness_status)} · 策略版本：{v.policy_version ?? '未知'}</p>
    <p>{v.quiet.allowed ? '服务端允许静默' : '静默未允许'}；静默资格不代表外部推送已获准。</p><Issues values={v.quiet.reasons} />
    <p>来源状态：{sourceLabels[v.source_status] || '未知'} · 来源失败或不完整：{v.source_failures.length}</p>
    {v.partial_scan ? <Issues values={['partial_scan']} /> : null}
    {v.source_results.map((s, i) => <p key={s.snapshot_id || i}>来源 {i + 1}：{sourceLabels[s.source_status] || '未知'} · 观察时间：{s.observed_at ?? '未知'} · 快照：{s.snapshot_id ?? '未知'}</p>)}
    {v.source_failures.map((s, i) => <p key={i}>未完成来源：{sourceLabels[s.source_status] || '未知'}{s.reason ? ` · ${explain(s.reason)}` : ''}</p>)}
    {v.comparisons.map((comparison, i) => <p key={i}>价格比较 · 事实：{comparison.fact_id} · {comparison.reason ? explain(comparison.reason) : comparison.event_id ? '已关联观察事件' : '比较结果尚不能确认'}</p>)}
    <Issues values={v.issues} />
  </div>;
}
function EventProof({ data, row }: { data: MonitoringEventDetail; row: MonitoringEventProjection }) {
  const incomplete = !data.diff || !data.facts?.old || !data.facts?.new ||
    [...row.old_evidence_ids, ...row.new_evidence_ids].some(id => !data.evidences.some(e => e.evidence_id === id)) ||
    [...row.old_snapshot_ids, ...row.new_snapshot_ids].some(id => !data.snapshots.some(s => s.snapshot_id === id));
  return <div className="hint">
    <p>事件：{data.event.event_id} · 比较：{data.diff?.diff_id ?? '未知'} · 旧事实：{data.facts?.old?.fact_id ?? '未知'} · 新事实：{data.facts?.new?.fact_id ?? '未知'}</p>
    {incomplete ? <p>依据链不完整，缺失部分不能据此补齐。</p> : null}
    {data.evidences.map(e => <p key={e.evidence_id}>证据：{e.evidence_id}</p>)}
    {data.snapshots.map(s => { const url = sourceUrl(s.source_url); return <p key={s.snapshot_id}>快照：{s.snapshot_id} · 观察时间：{s.observed_at ?? '未知'}{s.source_status ? ` · ${sourceLabels[s.source_status] || '来源状态未知'}` : ''} {url ? <a href={url} target="_blank" rel="noopener noreferrer">查看原始来源</a> : null}</p>; })}
  </div>;
}
function failureText(error: unknown): string {
  const body = (error as { body?: { error?: string; issues?: string[] } })?.body;
  return body ? [body.error, ...(body.issues || [])].filter((v): v is string => !!v).map(explain).join('；') || '监控请求未完成，请重试' : '监控请求未完成，请检查连接后重试';
}
interface Panel {
  owner: StateOperation; cycle: number; competitorId: string; projectId: string | null;
  workspaceId: string; workspaces: MonitoringWorkspace[]; workspaceOffset: number; moreWorkspaces: boolean;
  status: MonitoringStatus | null; statusOffset: number; loading: boolean; workspaceLoading: boolean;
  error: string; workspaceError: string; statusError: string; notice: string;
  detail: { notificationId: string; eventId: string; loading: boolean; error: string; data: MonitoringEventDetail | null } | null;
}
interface MutationResult {
  workspace?: MonitoringWorkspace; target?: MonitoringTarget; duplicate?: boolean; job?: MonitoringJob; scope_changed?: boolean;
}

/** Local UI state only. Server DTOs and Provider generations remain authoritative. */
export function MonitoringControls({ c, projectId }: { c: Competitor; projectId: string | null }) {
  const beginOperation = useStateOperation();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState(''), [market, setMarket] = useState(''), [timeZone, setTimeZone] = useState('');
  const [editMarket, setEditMarket] = useState(''), [editZone, setEditZone] = useState('');
  const [eventChoice, setEventChoice] = useState<Record<string, string>>({});
  const mounted = useRef(true), mutation = useRef(false);
  const retryKey = useRef<{ payload: string; token: string; key: string } | null>(null);
  const lanes = useRef({ cycle: 0, selection: 0, version: 0, workspaces: 0, status: 0, detail: 0, workspaceId: '', context: '' });
  const context = JSON.stringify([projectId, c.id]);
  if (lanes.current.context !== context) { lanes.current.context = context; lanes.current.cycle++; lanes.current.workspaceId = ''; }
  const visible = panel && panel.cycle === lanes.current.cycle && panel.owner.isCurrent() ? panel : null;
  useEffect(() => {
    const lifecycle = lanes.current;
    mounted.current = true;
    return () => { mounted.current = false; lifecycle.cycle++; };
  }, []);
  useEffect(() => { if (panel && !visible) { lanes.current.cycle++; setPanel(null); } }, [panel, visible]);

  function capture(p: Panel, lane?: 'status' | 'workspaces' | 'detail') {
    const r = lanes.current, cycle = r.cycle, selection = r.selection, version = r.version;
    const sequence = lane ? ++r[lane] : 0;
    return () => mounted.current && p.owner.isCurrent() && p.owner.projectId === projectId && p.cycle === r.cycle && r.cycle === cycle && r.version === version && (!lane || r[lane] === sequence) && r.selection === selection && (lane === 'workspaces' || p.workspaceId === r.workspaceId);
  }
  async function readWorkspaces(p: Panel, offset = 0) {
    const valid = capture(p, 'workspaces');
    setPanel(old => old ? { ...old, workspaceLoading: true } : null);
    try {
      const result = await apiGet<{ workspaces: MonitoringWorkspace[] }>(`/api/monitoring/workspaces?offset=${offset}&limit=100`);
      if (!valid()) return;
      const page = [...result.workspaces];
      // Refreshing page one must not discard an explicitly selected workspace on a later page.
      // Fetch its current server record rather than retaining a potentially stale configuration.
      if (!offset && p.workspaceId && !page.some(w => w.workspace_id === p.workspaceId)) {
        const exact = await apiGet<{ workspaces: MonitoringWorkspace[] }>(`/api/monitoring/workspaces?workspaceId=${encodeURIComponent(p.workspaceId)}&offset=0&limit=1`);
        if (!valid()) return;
        const selected = exact.workspaces.find(w => w.workspace_id === p.workspaceId);
        if (!selected) throw new Error('Selected workspace unavailable');
        page.push(selected);
      }
      setPanel(old => old ? { ...old, workspaces: offset ? [...old.workspaces, ...page.filter(w => !old.workspaces.some(x => x.workspace_id === w.workspace_id))] : page, workspaceOffset: offset, moreWorkspaces: result.workspaces.length === 100, workspaceLoading: false, workspaceError: '' } : null);
    } catch (e) { if (valid()) setPanel(old => old ? { ...old, workspaceLoading: false, workspaceError: '工作空间读取未完成：' + failureText(e) } : null); }
  }
  async function readStatus(p: Panel, offset = 0) {
    const valid = capture(p, 'status');
    if (!p.projectId) return;
    // A fresh status can retire the selected projection: end the detail wait now.
    lanes.current.detail++;
    setPanel(old => old ? { ...old, loading: true, detail: null } : null);
    const query = new URLSearchParams({ projectId: p.projectId, competitorId: p.competitorId, offset: String(offset), limit: '100' });
    if (p.workspaceId) query.set('workspaceId', p.workspaceId);
    try {
      const result = await apiGet<MonitoringStatus>('/api/monitoring/status?' + query);
      if (!valid()) return;
      if (!offset) setEventChoice(old => {
        const current: Record<string, string> = {};
        for (const target of result.targets) {
          const selected = old[target.watch_target_id];
          if (selected && target.latest_result?.event_ids.includes(selected)) current[target.watch_target_id] = selected;
        }
        return current;
      });
      setPanel(old => {
        if (!old) return null;
        const prior = offset ? old.status : null;
        const merge = <T,>(before: T[], after: T[], key: (v: T) => string) => [...before.filter(x => !after.some(y => key(x) === key(y))), ...after];
        const status = prior ? { ...result, targets: merge(prior.targets, result.targets, t => t.watch_target_id), jobs: merge(prior.jobs, result.jobs, j => j.job_id), gaps: [...prior.gaps, ...result.gaps],
          coverage: result.coverage ? merge(prior.coverage || [], result.coverage, c => c.coverage_id) : undefined,
          event_projections: result.event_projections ? merge(prior.event_projections || [], result.event_projections, e => e.notification_id) : undefined,
        } : result;
        return { ...old, status, statusOffset: offset, loading: false, statusError: '' };
      });
    } catch (e) { if (valid()) setPanel(old => old ? { ...old, loading: false, statusError: '监控状态读取未完成：' + failureText(e) } : null); }
  }
  async function readEvent(row: MonitoringEventProjection) {
    if (!visible || !visible.status?.event_projections?.some(e => e.notification_id === row.notification_id && e.event_id === row.event_id) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(row.event_id) || row.event_id.includes('..')) return;
    const p = visible, valid = capture(p, 'detail');
    const detail = { notificationId: row.notification_id, eventId: row.event_id, loading: true, error: '', data: null };
    setPanel(old => old ? { ...old, detail } : null);
    try {
      // Build the known authenticated path from the event identity, never an arbitrary DTO URL.
      const data = await apiGet<MonitoringEventDetail>('/api/demo/event-detail?id=' + encodeURIComponent(row.event_id));
      if (!valid()) return;
      if (data.event?.event_id !== row.event_id || data.event.event_type !== row.event_type || data.event.diff_id !== row.diff_id || data.event.old_fact_id !== row.old_fact_id || data.event.new_fact_id !== row.new_fact_id || !Array.isArray(data.evidences) || !Array.isArray(data.snapshots) || (data.diff && data.diff.diff_id !== row.diff_id) || (data.facts?.old && data.facts.old.fact_id !== row.old_fact_id) || (data.facts?.new && data.facts.new.fact_id !== row.new_fact_id)) throw new Error('Event proof mismatch');
      setPanel(old => old ? { ...old, detail: { ...detail, loading: false, data } } : null);
    } catch { if (valid()) setPanel(old => old ? { ...old, detail: { ...detail, loading: false, error: '变化依据读取未完成，请重试；站内观察记录仍然保留。' } } : null); }
  }
  function open() {
    const owner = beginOperation();
    if (!owner.isCurrent() || owner.projectId !== projectId) return;
    const r = lanes.current; r.cycle++; r.selection++; r.workspaceId = '';
    const p: Panel = { owner, cycle: r.cycle, competitorId: c.id, projectId, workspaceId: '', workspaces: [], workspaceOffset: 0, moreWorkspaces: false, status: null, statusOffset: 0, loading: !!projectId, workspaceLoading: true, workspaceError: '', statusError: '', error: '', notice: '', detail: null };
    setName(''); setMarket(''); setTimeZone(''); setEditMarket(''); setEditZone(''); setEventChoice({}); setPanel(p);
    void readWorkspaces(p); void readStatus(p);
  }
  function selectWorkspace(id: string) {
    if (!visible || visible.cycle !== lanes.current.cycle || mutation.current) return;
    lanes.current.selection++; lanes.current.workspaceId = id;
    const workspace = visible.workspaces.find(w => w.workspace_id === id);
    setEditMarket(workspace?.market || ''); setEditZone(workspace?.target_market_timezone || ''); setEventChoice({});
    const next = { ...visible, workspaceId: id, status: null, error: '', statusError: '', notice: '', detail: null }; setPanel(next); void readStatus(next);
    // A selection can change while its list is being refreshed. Replace that read owner too,
    // including an exact fetch for a selected item beyond page one; the old lane cannot settle it.
    if (visible.workspaceLoading) void readWorkspaces(next);
  }
  async function mutate(path: string, body: Record<string, string>, method: 'POST' | 'PUT' = 'POST', idempotent = false) {
    if (!visible || visible.cycle !== lanes.current.cycle || visible.workspaceId !== lanes.current.workspaceId || mutation.current) return;
    const p = visible, owner = beginOperation();
    if (!owner.isCurrent() || !p.owner.isCurrent() || owner.projectId !== projectId) return;
    mutation.current = true; setPending(true); lanes.current.version++;
    const valid = capture(p);
    // version++ retires both read owners. Their late responses cannot settle busy flags;
    // end those UI waits here without treating either obsolete read as successful.
    setPanel(old => old ? { ...old, error: '', notice: '', loading: false, workspaceLoading: false, detail: null } : null);
    try {
      let payload = body;
      if (idempotent) {
        const serialized = JSON.stringify([path, body]), token = captureSession().token;
        if (retryKey.current?.payload !== serialized || retryKey.current.token !== token) {
          const random = crypto.getRandomValues(new Uint32Array(4));
          retryKey.current = { payload: serialized, token, key: 'ui_' + Array.from(random, value => value.toString(16).padStart(8, '0')).join('') };
        }
        payload = { ...body, idempotencyKey: retryKey.current.key };
      }
      const result = method === 'PUT'
        ? await apiPut<MutationResult>(path, payload)
        : await apiPost<MutationResult>(path, payload);
      if (!valid()) return;
      if (idempotent) retryKey.current = null;
      const notice = result.job ? `${result.duplicate ? '已有复查任务' : '复查请求已接受'}：${jobLabels[result.job.status] || '状态未知'}`
        : result.target ? `服务端目标状态：${targetLabels[result.target.monitoring_status]}`
        : method === 'PUT' ? result.scope_changed ? '工作空间配置已保存；范围变更的旧目标已暂停，需要重新准入，未自动恢复。' : '工作空间配置已核对，范围未改变；未自动恢复目标。'
        : '工作空间已创建，请显式选择后再加入监控。';
      setPanel(old => {
        if (!old) return null;
        const target = result.target;
        const nextStatus = old.status && target ? { ...old.status, targets: [...old.status.targets.filter(t => t.watch_target_id !== target.watch_target_id), target] } : old.status;
        const nextWorkspaces = result.workspace && method === 'PUT' ? old.workspaces.map(w => w.workspace_id === result.workspace!.workspace_id ? result.workspace! : w) : old.workspaces;
        return { ...old, notice, status: nextStatus, workspaces: nextWorkspaces };
      });
      await Promise.all([readWorkspaces(p), readStatus(p)]);
    } catch (e) { if (valid()) setPanel(old => old ? { ...old, error: failureText(e) } : null); }
    finally { mutation.current = false; if (mounted.current) setPending(false); }
  }
  const hasReferences = [c.brand_id, c.current_qualification_result_id, c.category_scope].every(v => typeof v === 'string' && !!v.trim());
  const workspace = visible?.workspaces.find(w => w.workspace_id === visible.workspaceId);
  const status = visible?.status;
  const configured = !!workspace?.market?.trim() && validZone(workspace?.target_market_timezone || '');
  const targetsLoaded = !!status && !!visible && visible.statusOffset + 100 >= status.total_targets;
  const ready = !!visible && !!projectId && hasReferences && configured && targetsLoaded && status?.enabled === true && !visible.loading && !visible.workspaceLoading && !visible.workspaceError && !visible.statusError;
  const targets = status?.targets || [];
  const sameWorkspaceMarket = (target: MonitoringTarget) => !!workspace && target.workspace_id === workspace.workspace_id && target.market === workspace.market;
  // Server scope identity excludes timezone; an explicit resume revalidates the same-market scope.
  const alreadyJoined = targets.some(t => sameWorkspaceMarket(t) && t.brand_id === c.brand_id && t.category_scope === c.category_scope);
  function join() {
    if (!ready || !visible || alreadyJoined) return;
    void mutate('/api/monitoring/targets', { workspaceId: visible.workspaceId, projectId: projectId!, competitorId: c.id, brandId: c.brand_id!, qualificationResultId: c.current_qualification_result_id!, categoryScope: c.category_scope! }, 'POST', true);
  }
  return <div className="field-box" data-monitoring-controls>
    <button className="btn-ghost" type="button" onClick={() => { if (visible) { lanes.current.cycle++; setPanel(null); } else open(); }}>{visible ? '收起正式监控' : '展开正式监控'}</button>
    {visible ? <div className="fb-body" style={{ display: 'block' }}>
      <p>执行范围：Shopify目录观察。固定计划窗口：06:00 / 14:00 / 22:00，按显式配置的目标市场时区。</p>
      <p className="hint">逐任务检查记录和站内观察变化可在下方查看。其他信号、完整检查窗口、静默摘要、外部通知与当天送达承诺尚未验收。收藏与正式监控互不转换。</p>
      {!projectId ? <p className="hint">当前研究档案尚未就绪，暂不能加入正式监控。</p> : null}
      <label>工作空间 <select aria-label="监控工作空间" value={visible.workspaceId} disabled={pending} onChange={e => selectWorkspace(e.target.value)}><option value="">请选择工作空间</option>{visible.workspaces.map(w => <option key={w.workspace_id} value={w.workspace_id}>{w.name} · {w.market} · {w.target_market_timezone}</option>)}</select></label>
      {visible.moreWorkspaces ? <button type="button" disabled={pending || visible.workspaceLoading} onClick={() => void readWorkspaces(visible, visible.workspaceOffset + 100)}>加载更多工作空间</button> : null}
      <div className="field">
        <div className="field-t">新建工作空间</div>
        <label>名称 <input aria-label="工作空间名称" value={name} disabled={pending} onChange={e => setName(e.target.value)} /></label>
        <label>目标市场 <input aria-label="新建目标市场" value={market} disabled={pending} onChange={e => setMarket(e.target.value)} /></label>
        <label>IANA时区 <input aria-label="新建IANA时区" placeholder="例如 America/New_York" value={timeZone} disabled={pending} onChange={e => setTimeZone(e.target.value)} /></label>
        <button type="button" disabled={pending || !name.trim() || !market.trim() || !validZone(timeZone)} onClick={() => { if (name.trim() && market.trim() && validZone(timeZone)) void mutate('/api/monitoring/workspaces', { name: name.trim(), market: market.trim(), timeZone: timeZone.trim() }, 'POST', true); }}>创建工作空间</button>
        {timeZone && !validZone(timeZone) ? <p className="hint">请填写有效的 IANA 时区。</p> : null}
      </div>
      {workspace ? <div className="field">
        <p>当前市场：{workspace.market} · 时区：{workspace.target_market_timezone}</p>
        <label>目标市场 <input aria-label="修改目标市场" disabled={pending} value={editMarket} onChange={e => setEditMarket(e.target.value)} /></label>
        <label>IANA时区 <input aria-label="修改IANA时区" disabled={pending} value={editZone} onChange={e => setEditZone(e.target.value)} /></label>
        <p className="hint">保存范围变更会暂停旧目标。旧目标保留原市场，需要重新准入；时区在显式恢复并通过核验后生效，不会自动恢复。</p>
        <button type="button" disabled={pending || !editMarket.trim() || !validZone(editZone)} onClick={() => { if (editMarket.trim() && validZone(editZone)) void mutate('/api/monitoring/workspaces', { workspaceId: workspace.workspace_id, market: editMarket.trim(), timeZone: editZone.trim() }, 'PUT'); }}>保存工作空间配置</button>
      </div> : <p className="hint">请显式选择工作空间，未选择时不能加入正式监控。</p>}
      {!hasReferences ? <p className="hint">品牌身份/资格尚未接通，暂不能加入正式监控；必须具备服务端明确的品类范围引用。</p> : null}
      {workspace && !configured ? <p className="hint">工作空间缺少市场或目标市场时区，暂不能加入。</p> : null}
      <button type="button" disabled={pending || !ready || alreadyJoined} onClick={join}>加入正式监控</button>
      <button type="button" disabled={pending || visible.loading || visible.workspaceLoading} onClick={() => { void readWorkspaces(visible); void readStatus(visible); }}>刷新真实状态</button>
      {visible.loading ? <p role="status">正在读取监控状态…</p> : null}
      {[visible.error, visible.workspaceError, visible.statusError].filter(Boolean).map(message => <p role="alert" key={message}>{message}。已显示的状态可能不是最新，请刷新。</p>)}
      {visible.notice ? <p role="status">{visible.notice}</p> : null}
      {status ? <>
        <p>正式路径：{status.enabled ? '已启用' : '未启用'} · 调度服务：{status.running ? '运行中' : '未运行'}</p>
        <Issues values={status.issues} /><Issues values={status.limitations} />
        {status.backpressure ? <p className="hint">队列背压：部分检查仍在等待，不能视为检查完成。</p> : null}
        {!targetsLoaded ? <p className="hint">监控记录尚未读取完整，请继续加载后再确认加入状态。</p> : !targets.length ? <p>当前筛选范围尚未加入正式监控。</p> : null}
        {targets.map((target, index) => <div className="field" key={target.watch_target_id}>
          <div className="field-t">监控对象 {index + 1} · 保存状态：{targetLabels[target.monitoring_status]}</div>
          <p>目标范围：{target.market} · {target.target_market_timezone}</p>
          <p>当前执行条件：{target.effective.executable ? '可执行' : '不可执行'}</p><Issues values={target.effective.issues} />
          <p>下一计划窗口：{target.next_slot ? plannedTime(target.next_slot.scheduled_at, target.target_market_timezone) : '暂无计划'}（不是最近完成时间）</p>
          {target.latest_result ? <>
            <p>最近结果完成时间：{plannedTime(target.latest_result.completed_at, target.target_market_timezone)} · {sourceLabels[target.latest_result.source_status] || '来源状态未知'}</p>
            {target.latest_result.partial_scan ? <p className="hint">目录仅检查了一部分，不能确认全范围变化。</p> : null}
            <Issues values={target.latest_result.issues} />
            {target.latest_result.source_results.map((source, i) => <p key={i}>来源 {i + 1}：{sourceLabels[source.source_status] || '状态未知'} · 观察时间：{source.observed_at || '未知'}</p>)}
            {!target.latest_result.event_ids.length ? <p>本次未关联价格变化事件；不能据此判断没有变化。</p> : null}
            {target.latest_result.event_ids.length ? <><label>价格变化 <select aria-label={`复查事件 ${index + 1}`} value={eventChoice[target.watch_target_id] || ''} onChange={e => setEventChoice(old => ({ ...old, [target.watch_target_id]: e.target.value }))}><option value="">请选择已观察变化</option>{target.latest_result.event_ids.map((id, i) => <option key={id} value={id}>本轮价格变化 {i + 1}</option>)}</select></label>
              <button type="button" disabled={pending || !status.enabled || !target.effective.executable || !target.latest_result.event_ids.includes(eventChoice[target.watch_target_id] || '')} onClick={() => { const id = eventChoice[target.watch_target_id]; if (status.enabled && target.effective.executable && id && target.latest_result?.event_ids.includes(id)) void mutate('/api/monitoring/recheck', { watchTargetId: target.watch_target_id, eventId: id }); }}>复查所选变化</button></> : null}
          </> : <p>尚无本版本的可用观察结果，历史正在积累；不能判断趋势。</p>}
          {workspace && !sameWorkspaceMarket(target) ? <p className="hint">旧目标市场与当前工作空间不同，请按新范围重新加入；旧目标不会自动迁移。</p> : null}
          {target.monitoring_status === 'paused' ? <button type="button" disabled={pending || !status.enabled || !configured || !sameWorkspaceMarket(target) || visible.workspaceLoading || !!visible.workspaceError || !!visible.statusError} onClick={() => { if (status.enabled && configured && sameWorkspaceMarket(target) && !visible.workspaceLoading && !visible.workspaceError && !visible.statusError) void mutate('/api/monitoring/resume', { watchTargetId: target.watch_target_id }); }}>恢复监控</button>
            : <button type="button" disabled={pending} onClick={() => void mutate('/api/monitoring/pause', { watchTargetId: target.watch_target_id })}>暂停监控</button>}
        </div>)}
        {status.jobs.map((job, i) => <div className="hint" key={job.job_id}>任务 {i + 1}：{jobLabels[job.status] || '状态未知'} {job.source_status ? `· ${sourceLabels[job.source_status] || '来源状态未知'}` : ''}
          {job.schedule_lag != null ? <span> · 领取延迟 {Math.round(job.schedule_lag / 60000)} 分钟</span> : null}
          {job.lag_warning ? <span> · 延迟警告</span> : null}{job.degraded_candidate ? <span> · 延迟已达到受损候选范围</span> : null}
          <Issues values={[...(job.result?.issues || []), ...(job.result?.reason ? [job.result.reason] : []), ...(job.discarded ? [job.discarded.reason] : [])]} />
        </div>)}
        {status.gaps.length ? <div className="hint">存在 {status.gaps.length} 条未完成或无法确认的检查记录。<Issues values={status.gaps.map(g => g.reason)} /></div> : null}
        <div className="field">
          <div className="field-t">检查覆盖与静默资格</div>
          <p className="hint">以下是逐任务的实际观察输入，不是正式日报、周报或完整窗口；分页数量不能用作检查覆盖率。</p>
          <p>检查记录总数：{knownCount(status.total_coverage)} · 已载入：{knownCount(status.coverage?.length)}</p>
          {status.coverage == null ? <p>检查覆盖记录暂不可用，不能确认静默资格。</p> : !status.coverage.length ? <p>当前范围尚无检查覆盖记录，不能确认静默资格。</p> : status.coverage.map(value => <CoverageObservation key={value.coverage_id} value={value} />)}
        </div>
        <div className="field">
          <div className="field-t">站内观察变化</div>
          <p className="hint">保留已保存的目录观察及其原始目标版本，不代表当前版本已完成检查。站内可见不等于变化已确认或外部已接收、已送达。</p>
          <p>站内记录总数：{knownCount(status.total_event_projections)} · 已载入：{knownCount(status.event_projections?.length)}</p>
          {status.event_projections == null ? <p>站内变化记录暂不可用。</p> : !status.event_projections.length ? <p>当前范围尚无站内变化记录；不能据此判断没有变化。</p> : status.event_projections.map(row => <div className="field" key={row.notification_id} data-notification-id={row.notification_id}>
            <div className="field-t">已观察价格变化 · 尚未确认</div>
            <p>{row.view.from} → {row.view.to} · {row.view.change_label}</p>
            <p>币种：{row.currency ?? '未知'} · 来源市场：{row.market ?? '未知'} · 业务重要性：未知</p>
            <p>旧观察时间：{row.observed_at_old ?? '未知'} · 新观察时间：{row.observed_at_new ?? '未知'}</p>
            <p>发现时间：{row.occurred_at} · 站内记录时间：{plannedTime(row.enqueue_at, 'UTC')}</p>
            <p>站内记录：{row.notification_id} · 工作空间：{row.workspace_id} · 目标：{row.watch_target_id} · 版本 {row.revision} · 任务：{row.job_id} · 尝试 {row.attempt} · 检查记录：{row.coverage_id} · 事件：{row.event_id}</p>
            <Issues values={row.limitations} />
            <p>外部推送已阻止；没有外部接收、送达或失败回执。</p><Issues values={row.external_delivery_reasons} />
            <button type="button" disabled={pending || visible.loading || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(row.event_id) || row.event_id.includes('..')} onClick={() => void readEvent(row)}>查看变化依据</button>
            {visible.detail?.notificationId === row.notification_id && visible.detail.eventId === row.event_id ? <>
              {visible.detail.loading ? <p role="status">正在读取变化依据…</p> : null}
              {visible.detail.error ? <p role="alert">{visible.detail.error}</p> : null}
              {visible.detail.data ? <EventProof data={visible.detail.data} row={row} /> : null}
            </> : null}
          </div>)}
        </div>
        {Math.max(status.total_targets, status.total_jobs, status.total_coverage ?? 0, status.total_event_projections ?? 0) > visible.statusOffset + 100 ? <button type="button" disabled={pending || visible.loading} onClick={() => void readStatus(visible, visible.statusOffset + 100)}>继续加载监控记录</button> : null}
      </> : null}
    </div> : null}
  </div>;
}
