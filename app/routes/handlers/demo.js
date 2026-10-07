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
const DomainEvent = require('../../research/domain-event.js');
const Diff = require('../../research/price-diff.js');
const FactStore = require('../../research/fact-store.js');
const EvidenceStore = require('../../research/evidence-store.js');
const Snapshot = require('../../research/source-snapshot.js');

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
    events,
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
  const event = DomainEvent.getEventById(tenantId, id);
  if (!event) return ctx.sendJSON(res, 404, { error: 'NOT_FOUND', message: '事件不存在。' });
  const diff = Diff.getDiffById(tenantId, event.diff_id);
  const oldFact = FactStore.getFactById(tenantId, event.old_fact_id);
  const newFact = FactStore.getFactById(tenantId, event.new_fact_id);
  const evidences = [];
  for (const eid of [].concat(event.old_evidence_ids || [], event.new_evidence_ids || [])) {
    const ev = EvidenceStore.getEvidenceById(tenantId, eid);
    if (ev && !evidences.some(x => x.evidence_id === ev.evidence_id)) evidences.push(ev);
  }
  const snapshots = [];
  for (const sid of [].concat(event.old_snapshot_ids || [], event.new_snapshot_ids || [])) {
    const sm = Snapshot.getById(tenantId, sid);
    if (sm && !snapshots.some(x => x.snapshot_id === sm.snapshot_id)) {
      snapshots.push({
        snapshot_id: sm.snapshot_id, capability: sm.capability, provider: sm.provider,
        source_url: sm.source_url, source_status: sm.source_status, observed_at: sm.observed_at,
        partial_scan: sm.partial_scan == null ? null : Boolean(sm.partial_scan),
        content_hash: sm.content_hash, collector_version: sm.collector_version,
        raw_payload_ref: sm.raw_payload_ref || null,
      });
    }
  }
  ctx.sendJSON(res, 200, { event, diff, facts: { old: oldFact, new: newFact }, evidences, snapshots });
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
  const ev = EvidenceStore.getEvidenceById(tenantId, id);
  if (!ev) return ctx.sendJSON(res, 404, { error: 'NOT_FOUND', message: '证据不存在。' });
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
  if (!refresh && fs.existsSync(insightPath)) {
    try { return ctx.sendJSON(res, 200, Object.assign(JSON.parse(fs.readFileSync(insightPath, 'utf8')), { cached: true })); } catch (e) {}
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

  const factPayload = {
    event_type: event.event_type,
    competitor_brand: (event.entity_ref && event.entity_ref.brand_name) || null,
    product: (event.entity_ref && event.entity_ref.title) || null,
    old_price: event.old_price,
    new_price: event.new_price,
    direction: event.direction,
    delta: event.delta,
    pct: event.pct,
    observed_at_old: event.observed_at_old,
    observed_at_new: event.observed_at_new,
    data_source: event.source + '/' + event.provider,
    data_note: '以下数字均为系统真值链（SourceSnapshot→Evidence→Fact→Diff→Event）产出，是本回复唯一可用数据。',
  };
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
    purpose: 'DomainEvent -> AI Insight（价格变化业务解读）',
    created_at: new Date().toISOString(),
    cached: false,
  };
  try {
    fs.mkdirSync(insightDir, { recursive: true });
    // refresh=1 覆盖已有缓存；默认 'wx' 保持首次写幂等（不覆盖既有文件）
    fs.writeFileSync(insightPath, JSON.stringify(payload, null, 1), { flag: refresh ? 'w' : 'wx' });
  } catch (e) { if (!fs.existsSync(insightPath)) throw e; }
  ctx.sendJSON(res, 200, payload);
  return true;
}

module.exports = { recentChanges, eventDetail, evidenceDetail, seed, aiInterpretation };
