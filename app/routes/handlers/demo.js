'use strict';
// ============================================================
// handlers/demo.js —— M0-05 Demo 最小 REST（Stage 3）
// 真值链只读端点：recent changes / event detail / evidence detail。
// 数据全部来自事实链落盘对象（events/diffs/facts/evidence/snapshots），
// 本层零计算零装饰——数字即 Fact/Event 原值，不在此重算。
//
// 规格锚点：00 v1.2 §5/§32（Projection 只 render 不重算）/§42；
//           02 v0.3 §10.1；03 v0.3（API 契约：租户隔离）；06 v0.3 Traceability。
// 鉴权：注册为 'tenant'（走统一鉴权门；ALS 请求上下文解租户）。
// ============================================================
const als = require('../../core/als.js');
const { isSafeId } = require('../../core/safe-id.js');
const DomainEvent = require('../../research/domain-event.js');
const Diff = require('../../research/price-diff.js');
const FactStore = require('../../research/fact-store.js');
const EvidenceStore = require('../../research/evidence-store.js');
const Snapshot = require('../../research/source-snapshot.js');

// P0-1：外部传入 id 的统一格式校验——非法（../ 穿越/URL 编码穿越/Windows ..\ /
// 盘符/绝对路径/任何路径分隔符）→ 400 INVALID_ID；合法但不存在由存储层返回
// null → 上层继续 404。存储层另有独立防御（core/safe-id.js），本层是第一道门。
function invalidIdResponse(ctx, res) {
  return ctx.sendJSON(res, 400, { error: 'INVALID_ID', message: '非法 id 格式。' });
}

// P2：API projection 层快照净化——剥离 raw_payload_ref（服务器内部文件路径），
// 保留 Snapshot ID / content_hash / collector_version / source_status / observed_at
// 等溯源信息。存储层 raw_payload_ref 原样保留（内部 raw 读回不受影响）。
function publicSnapshot(s) {
  if (!s || typeof s !== 'object') return s;
  const c = Object.assign({}, s);
  delete c.raw_payload_ref;
  return c;
}

// ---------- 价格区间展示派生（2026-10-08 P1 下游整改） ----------
// 规则依据：price-diff.judge v2 方向规则（2026-10-08 冻结）——仅在 API projection
// 层根据 event.old_value/new_value 派生展示边界（任务书明确允许），不写库、
// 不新增领域枚举：changed_boundary 取值（price_min/price_max/both/mixed）是
// projection 描述值，DomainEvent/Diff 存储对象保持原样。
function changedBoundaryOf(oldV, newV) {
  if (!oldV || !newV || !Number.isFinite(oldV.price_min) || !Number.isFinite(oldV.price_max)
    || !Number.isFinite(newV.price_min) || !Number.isFinite(newV.price_max)) return null;
  const dMin = newV.price_min - oldV.price_min;
  const dMax = newV.price_max - oldV.price_max;
  if (dMin === 0 && dMax !== 0) return 'price_max';
  if (dMax === 0 && dMin !== 0) return 'price_min';
  if (dMin !== 0 && dMax !== 0) return Math.sign(dMin) === Math.sign(dMax) ? 'both' : 'mixed';
  return null;
}

// |pct| 展示：整数省小数（25 → "25"），非整数保留一位（25.641 → "25.6"）
function fmtPct(p) {
  if (p == null || !Number.isFinite(p)) return null;
  const a = Math.abs(p);
  return a % 1 === 0 ? a.toFixed(0) : a.toFixed(1);
}

// 展示视图：from/to（区间或单一价字符串）+ change_label（业务话术，direction=null
// 时为中性表达，绝无箭头/0.0%）。纯函数、只读 event，供 recent-changes /
// event-detail 下发 display 字段与 AI payload 复用。
function priceChangeView(ev) {
  const ov = ev && ev.old_value, nv = ev && ev.new_value;
  const cur = ev && ev.currency ? ev.currency + ' ' : '';
  const single = (v) => !!v && v.price_min === v.price_max;
  const fmtV = (v) => !v ? '—'
    : (single(v) ? cur + v.price_min : cur + v.price_min + ' – ' + v.price_max);
  let from = fmtV(ov);
  let to = fmtV(nv);
  let changeLabel = null;
  const b = changedBoundaryOf(ov, nv);
  const dir = ev && ev.direction;
  if (b === 'both' && ov && single(ov) && nv && single(nv)) {
    // 单一价格 39 → 29：方向 + 幅度（25.641 → 25.6%）
    changeLabel = (dir === 'decrease' ? '下降 ' : dir === 'increase' ? '上升 ' : '变化 ')
      + (fmtPct(ev.pct) == null ? '—' : fmtPct(ev.pct) + '%');
  } else if (b === 'price_max') {
    const p = fmtPct((nv.price_max - ov.price_max) / ov.price_max * 100);
    changeLabel = (dir === 'decrease' ? '最高价下降 ' : '最高价上升 ') + (p == null ? '—' : p + '%');
  } else if (b === 'price_min') {
    const p = fmtPct((nv.price_min - ov.price_min) / ov.price_min * 100);
    changeLabel = (dir === 'decrease' ? '最低价下降 ' : '最低价上升 ') + (p == null ? '—' : p + '%');
  } else if (b === 'both') {
    // 双边界同向：10–20 → 12–25，价格区间上移（口径：不标单一基准幅度）
    changeLabel = dir === 'decrease' ? '价格区间下移' : dir === 'increase' ? '价格区间上移' : '价格区间变化';
  } else if (b === 'mixed' || dir == null) {
    // 双边界反向（10–20 → 12–15 收窄 / 10–20 → 8–25 扩大）：诚实无方向，中性表达
    const wOld = ov ? ov.price_max - ov.price_min : null;
    const wNew = nv ? nv.price_max - nv.price_min : null;
    changeLabel = (wOld != null && wNew != null && wNew < wOld) ? '价格区间收窄，无单一涨跌方向'
      : (wOld != null && wNew != null && wNew > wOld) ? '价格区间扩大，无单一涨跌方向'
        : '区间边界变化，无单一涨跌方向';
  } else {
    // 防御回退：值缺失等异常形态——沿用旧标量口径，不编造
    changeLabel = (dir === 'decrease' ? '下降 ' : dir === 'increase' ? '上升 ' : '变化 ')
      + (fmtPct(ev.pct) == null ? '—' : fmtPct(ev.pct) + '%');
    if (ov && single(ov)) from = cur + ov.price_min;
    if (nv && single(nv)) to = cur + nv.price_min;
  }
  return { from, to, changed_boundary: b, change_label: changeLabel };
}

// AI factPayload 装配（纯函数，供 ai-interpretation 与回归测试复用）：
// 携带完整价格区间（old/new_price_range）+ changed_boundary（projection 派生）；
// direction=null 时 delta/pct 原样 null——绝不用 0 替代未知百分比。
//
// 历史兼容（2026-10-08）：**不信任历史事件落盘的 old_price/new_price**——升级前
// v1 曾把 price_min 冒充区间标量，旧区间事件会带矛盾「10→10」标量。标量一律从
// old_value/new_value 重新安全派生：仅 price_min===price_max 时承载，区间价输出
// null，完整区间由 *_price_range 表达。对当前版事件（落盘已是 null）结果一致。
function aiFactPayloadOf(event) {
  const val = (x) => x && Number.isFinite(x.price_min) && Number.isFinite(x.price_max)
    ? { min: x.price_min, max: x.price_max } : null;
  const scalar = (x) => (x && Number.isFinite(x.price_min) && Number.isFinite(x.price_max)
    && x.price_min === x.price_max) ? x.price_min : null;
  return {
    event_type: event.event_type,
    competitor_brand: (event.entity_ref && event.entity_ref.brand_name) || null,
    product: (event.entity_ref && event.entity_ref.title) || null,
    old_price: scalar(event.old_value),
    new_price: scalar(event.new_value),
    old_price_range: val(event.old_value),
    new_price_range: val(event.new_value),
    changed_boundary: changedBoundaryOf(event.old_value, event.new_value),
    direction: event.direction || null,
    delta: event.delta == null ? null : event.delta,
    pct: event.pct == null ? null : event.pct,
    observed_at_old: event.observed_at_old,
    observed_at_new: event.observed_at_new,
    data_source: event.source + '/' + event.provider,
    data_note: '以下数字均为系统真值链（SourceSnapshot→Evidence→Fact→Diff→Event）产出，是本回复唯一可用数据。价格可能为单一价格（old_price/new_price）或价格区间（old_price_range/new_price_range）；区间变化时请按区间表述，不要把区间简化成单一价格。',
  };
}

// ---------- AI insight 缓存兼容（2026-10-08） ----------
// v2：标量价格改为从 old/new_value 安全派生。历史 v1 缓存（无 payload_version
// 字段）中，**仅区间事件**的 insight 可能基于矛盾 payload（"10→10，下降25%"）
// 生成——此类缓存判定失效，在用户下一次显式点击「AI 竞争分析」时重新生成并
// 覆盖（本端点只由用户点击触发，页面读取绝不产生付费 LLM 调用）。单一价事件
// 的 v1 缓存标量本就正确，继续有效——把重生成范围压到最小。缓存是派生物，
// 覆盖不触碰真值链（Event/Diff/Fact/Evidence/Snapshot 均原样保留）。
const AI_PAYLOAD_VERSION = 2;
function insightCacheStale(event, cached) {
  if (!cached || typeof cached !== 'object') return false;          // 无缓存/损坏 → 走正常 miss
  if (cached.payload_version >= AI_PAYLOAD_VERSION) return false;   // 已是新版 → 有效
  const isRange = (x) => !!x && Number.isFinite(x.price_min) && Number.isFinite(x.price_max)
    && x.price_min !== x.price_max;
  return isRange(event.old_value) || isRange(event.new_value);
}

// ---------- GET /api/demo/recent-changes?limit=30 ----------
// 近期 price_change_observed 事件（工作台「今日竞争动态」数据源）。
async function recentChanges(ctx, req, res, url, p) {
  if (p !== '/api/demo/recent-changes' || req.method !== 'GET') return false;
  const tenantId = als.getTenantCtx();
  if (!tenantId) return ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' });
  const limit = Math.min(Number(url && url.searchParams && url.searchParams.get('limit')) || 30, 100);
  const events = DomainEvent.listEvents(tenantId, { limit });
  const all = DomainEvent.listEvents(tenantId);
  ctx.sendJSON(res, 200, {
    // display：projection 层按 old/new value 派生的区间展示视图（不入库）
    events: events.map(e => Object.assign({}, e, { display: priceChangeView(e) })),
    summary: {
      total: all.length,
      decrease: all.filter(e => e.direction === 'decrease').length,
      increase: all.filter(e => e.direction === 'increase').length,
    },
  });
  return true;
}

// ---------- GET /api/demo/event-detail?id=evt_xxx ----------
// 事件详情：Event → Diff → Fact(×2) → Evidence(×N) → Snapshot 全链装配。
// 任一环节缺失按诚实降级（该段返回 null + reason），绝不伪造补齐。
async function eventDetail(ctx, req, res, url, p) {
  if (p !== '/api/demo/event-detail' || req.method !== 'GET') return false;
  const tenantId = als.getTenantCtx();
  if (!tenantId) return ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' });
  const id = url && url.searchParams && url.searchParams.get('id');
  if (!id) return ctx.sendJSON(res, 400, { error: 'MISSING_ID', message: '缺少事件 id。' });
  if (!isSafeId(id)) return invalidIdResponse(ctx, res);
  const event = DomainEvent.getEventById(tenantId, id);
  if (!event) return ctx.sendJSON(res, 404, { error: 'NOT_FOUND', message: '事件不存在。' });
  const diff = Diff.getDiffById(tenantId, event.diff_id);
  const oldFact = FactStore.getFactById(tenantId, event.old_fact_id);
  const newFact = FactStore.getFactById(tenantId, event.new_fact_id);
  // P2：Fact 的 provenance.snapshots 继承 Evidence 快照引用（内含 raw_payload_ref 内部
  // 路径），出 API 前统一净化——溯源 id/hash/version 全保留，服务器文件路径不出网。
  const pubFact = (f) => !f || !f.provenance || !Array.isArray(f.provenance.snapshots)
    ? f
    : Object.assign({}, f, { provenance: { evidence: f.provenance.evidence, snapshots: f.provenance.snapshots.map(publicSnapshot) } });
  const evidences = [];
  for (const eid of [].concat(event.old_evidence_ids || [], event.new_evidence_ids || [])) {
    const ev = EvidenceStore.getEvidenceById(tenantId, eid);
    if (ev && !evidences.some(x => x.evidence_id === ev.evidence_id)) {
      // P2：Evidence 的 provenance.snapshots[] 内含 raw_payload_ref.path（内部路径），过滤后出 API
      evidences.push(Object.assign({}, ev, {
        provenance: ev.provenance && ev.provenance.snapshots
          ? { snapshots: ev.provenance.snapshots.map(publicSnapshot) }
          : ev.provenance,
      }));
    }
  }
  const snapshots = [];
  for (const sid of [].concat(event.old_snapshot_ids || [], event.new_snapshot_ids || [])) {
    const sm = Snapshot.getById(tenantId, sid);
    if (sm && !snapshots.some(x => x.snapshot_id === sm.snapshot_id)) {
      snapshots.push(publicSnapshot({
        snapshot_id: sm.snapshot_id, capability: sm.capability, provider: sm.provider,
        source_url: sm.source_url, source_status: sm.source_status, observed_at: sm.observed_at,
        partial_scan: sm.partial_scan == null ? null : Boolean(sm.partial_scan),
        content_hash: sm.content_hash, collector_version: sm.collector_version,
        raw_payload_ref: sm.raw_payload_ref || null,
      }));
    }
  }
  ctx.sendJSON(res, 200, {
    event: Object.assign({}, event, { display: priceChangeView(event) }),
    diff,
    facts: { old: pubFact(oldFact), new: pubFact(newFact) },
    evidences,
    snapshots,
  });
  return true;
}

// ---------- GET /api/demo/evidence-detail?id=ev_xxx ----------
// 证据详情（「查看证据」Modal 数据源）：Evidence + 快照 provenance。
async function evidenceDetail(ctx, req, res, url, p) {
  if (p !== '/api/demo/evidence-detail' || req.method !== 'GET') return false;
  const tenantId = als.getTenantCtx();
  if (!tenantId) return ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' });
  const id = url && url.searchParams && url.searchParams.get('id');
  if (!id) return ctx.sendJSON(res, 400, { error: 'MISSING_ID', message: '缺少证据 id。' });
  if (!isSafeId(id)) return invalidIdResponse(ctx, res);
  const evRaw = EvidenceStore.getEvidenceById(tenantId, id);
  if (!evRaw) return ctx.sendJSON(res, 404, { error: 'NOT_FOUND', message: '证据不存在。' });
  // Phase 1 可观测性：evidence_opened 行为事件（只记脱敏标识与时间，不记证据内容）
  try { require('../../observability/telemetry.js').recordEvent({ eventType: 'evidence_opened', tenantId, objectType: 'evidence', objectId: id }); } catch (e) { /* 观测失败不影响主链路 */ }
  // P2：剥离 raw_payload_ref（服务器内部文件路径），溯源字段全保留
  const ev = Object.assign({}, evRaw, {
    provenance: evRaw.provenance && evRaw.provenance.snapshots
      ? { snapshots: evRaw.provenance.snapshots.map(publicSnapshot) }
      : evRaw.provenance,
  });
  ctx.sendJSON(res, 200, { evidence: ev, snapshots: ev.provenance && ev.provenance.snapshots || [] });
  return true;
}

// ---------- POST /api/demo/seed ----------
// 一键播种确定性 Demo 场景（39→29 走真实事实链）。幂等：已播种 → already。
// 产物全部标记 'Demo / Sample Data'（app/research/demo-fixture.js）。
async function seed(ctx, req, res, url, p) {
  if (p !== '/api/demo/seed' || req.method !== 'POST') return false;
  const tenantId = als.getTenantCtx();
  if (!tenantId) return ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' });
  const Fixture = require('../../research/demo-fixture.js');
  const r = Fixture.seedDemoScenario({ tenantId });
  if (r.recorded === false) return ctx.sendJSON(res, 500, { error: 'SEED_FAILED', reason: r.reason });
  ctx.sendJSON(res, 200, r);
  return true;
}

// ---------- POST /api/demo/ai-interpretation?id=evt_xxx[&refresh=1] ----------
// AI 竞争分析师（任务书 §一.4 / §七）：只解释已有结构化 Event 数据。
// 硬规则：prompt 仅含 Event 真值字段（价格/方向/幅度/时间/来源），
// system 明令禁止编造数字/来源/销量/GMV/AOV；实际使用的 model 与端点类型
// 随响应返回（百炼真实调用须可核验）。结果按 event_id 幂等缓存（可回算对象）。
// refresh=1（百炼真实 smoke 用）：跳过已有缓存，强制真实调用 LLM Gateway，
// 成功后覆盖更新缓存——只影响 AI 解读，绝不触碰 Event/Diff/Fact/Evidence/Snapshot。
async function aiInterpretation(ctx, req, res, url, p) {
  if (p !== '/api/demo/ai-interpretation' || req.method !== 'POST') return false;
  const tenantId = als.getTenantCtx();
  if (!tenantId) return ctx.sendJSON(res, 401, { error: 'AUTH_REQUIRED', message: '请先登录后再操作。' });
  const id = url && url.searchParams && url.searchParams.get('id');
  if (!id) return ctx.sendJSON(res, 400, { error: 'MISSING_ID', message: '缺少事件 id。' });
  if (!isSafeId(id)) return invalidIdResponse(ctx, res);
  const event = DomainEvent.getEventById(tenantId, id);
  if (!event) return ctx.sendJSON(res, 404, { error: 'NOT_FOUND', message: '事件不存在。' });

  const fs = require('fs');
  const path = require('path');
  const { DATA } = require('../../core/paths.js');
  const { sanitizeNs } = require('../../core/state-store.js');
  const insightDir = path.join(DATA, 'ai-insights', sanitizeNs(tenantId));
  const insightPath = path.join(insightDir, event.event_id + '.json');
  // refresh=1（真实 smoke）：跳过缓存命中，强制走真实 LLM 调用（默认行为不变）
  const refresh = (url && url.searchParams && url.searchParams.get('refresh')) === '1';
  // 缓存兼容（2026-10-08）：v1 区间事件缓存可能基于矛盾标量 payload 生成 →
  // 判定失效后落到下方重新生成并覆盖；单一价 v1 缓存继续有效（不多花 LLM 费用）。
  let staleCache = false;
  if (!refresh && fs.existsSync(insightPath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(insightPath, 'utf8'));
      if (insightCacheStale(event, cached)) {
        staleCache = true; // 不返回旧解读，继续走重新生成（仅限用户显式点击本端点）
      } else {
        return ctx.sendJSON(res, 200, Object.assign(cached, { cached: true }));
      }
    } catch (e) {}
  }

  // LLM 配置解析（P0-2）：复用 research/llm.js 既有解析语义（单一口径，不另立政策）：
  //   key：cfg.llm.apiKey > env LLM_API_KEY（llmApiKey）
  //   model：显式 > cfg.llm.model > 网关默认（resolveModel，含 legacy 模型名迁移）
  //   端点：resolveBaseUrl——配置里只有「真自定义」接入点才生效（legacy DeepSeek 默认
  //   地址视为未设置，不压制 env 显式配置的百炼端点）；'' 表示走网关默认（env LLM_BASE_URL > 内置）。
  //   key 与 baseUrl 同源：空 config key + env 百炼 key 绝不会误配到 legacy DeepSeek 端点。
  // 未配置 key → 诚实 503，绝不返回假解读。
  const cfg = (ctx.loadConfig ? ctx.loadConfig() : {}) || {};
  const RLLM = require('../../research/llm.js');
  const LLM = require('../../services/llm-gateway.js');
  const apiKey = String(RLLM.llmApiKey(cfg) || '').trim();
  if (!apiKey) return ctx.sendJSON(res, 503, { error: 'LLM_NOT_CONFIGURED', message: 'LLM 未配置（平台设置 llm.apiKey 或环境变量 LLM_API_KEY）。Demo 不伪造 AI 解读。' });
  // 传 null → resolveModel 按同源原则解析（config key 非空用 cfg.llm.model；
  // config key 空 + env key 在用 env LLM_MODEL——历史 DeepSeek 默认模型名不得压住 env）。
  const model = RLLM.resolveModel(null);
  const baseUrl = RLLM.resolveBaseUrl(apiKey, null);
  // 汇报实际端点（§七 必录）：baseUrl 为空时网关用默认端点，这里如实还原，绝不上报空 URL。
  const endpointUsed = LLM.normalizeBaseUrl(baseUrl) || LLM.DEFAULT_BASE_URL;

  // P1 下游整改：AI 输入携带完整价格区间 + changed_boundary（projection 派生）；
  // 单一价兼容字段保留；direction=null 时 delta/pct 为 null（绝不用 0 替代）。
  const factPayload = aiFactPayloadOf(event);
  const messages = [
    { role: 'system', content: '你是跨境电商竞品分析师。严格纪律：只能使用用户消息中给出的结构化数据；禁止编造或推算任何未给出的数字、时间、来源、销量、GMV、AOV；禁止提及数据之外的事件。用不超过 120 字的简体中文输出业务解读：这个价格变化意味着什么、建议卖家关注什么。' },
    { role: 'user', content: JSON.stringify(factPayload) },
  ];
  let text = '';
  try {
    text = await LLM.call(messages, { apiKey, model, baseUrl, tenantId, temperature: 0.3, maxAttempts: 2, fieldKey: 'demo_ai_insight' });
  } catch (e) {
    return ctx.sendJSON(res, 502, { error: 'LLM_CALL_FAILED', message: 'AI 调用失败：' + String((e && e.message) || e).slice(0, 160) });
  }
  text = String(text || '').trim();
  if (!text) return ctx.sendJSON(res, 502, { error: 'LLM_EMPTY', message: 'AI 未返回解读（可能处于熔断/降级期），请稍后重试。' });

  const payload = {
    event_id: event.event_id,
    insight: text,
    model,                                   // 实际模型标识（§七 必录）
    endpoint_kind: 'openai_compatible',      // 端点类型（§七 必录）
    endpoint_base_url: endpointUsed,         // 实际完整端点（无凭据，可核验；绝不为空）
    payload_version: AI_PAYLOAD_VERSION,     // 缓存兼容：v2 起标量从 old/new_value 安全派生
    purpose: 'DomainEvent -> AI Insight（价格变化业务解读）',
    created_at: new Date().toISOString(),
    cached: false,
  };
  try {
    fs.mkdirSync(insightDir, { recursive: true });
    // refresh=1 或旧区间缓存失效时覆盖写入；默认 'wx' 保持首次写幂等（不覆盖既有文件）
    fs.writeFileSync(insightPath, JSON.stringify(payload, null, 1), { flag: (refresh || staleCache) ? 'w' : 'wx' });
  } catch (e) { if (!fs.existsSync(insightPath)) throw e; }
  ctx.sendJSON(res, 200, payload);
  return true;
}

module.exports = { recentChanges, eventDetail, evidenceDetail, seed, aiInterpretation, priceChangeView, aiFactPayloadOf, changedBoundaryOf, insightCacheStale, AI_PAYLOAD_VERSION };
