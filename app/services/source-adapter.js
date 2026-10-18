'use strict';
// ============================================================
// services/source-adapter.js —— Source Adapter Contract + Shopify reference
// adapters（SC-02 §4 / 05 v0.4.0 §10/§19.6/§25.3）
// ------------------------------------------------------------
// 规格依据（冻结语义）：
//   · 05 v0.4.0 §10 Adapter Record 统一输出（source_id/capability/entity_keys/
//     raw_snapshot_id/observed_at/…/collector_version/parser_version?）——本模块
//     collect 返回结构逐字段对齐，另补 evidence_refs/pagination/retryable/
//     cache_hit/cost_attribution/attempt_id（SC-02 §4）
//   · 05 §19.6 Shopify Public Catalog Adapter：分页或标 partial_scan；禁 AOV/
//     销量/GMV；403/429/分页不完整等失败如实分类
//   · 05 §25.3：委托既有采集实现（Net.fetchShopify*，零复制第二套采集逻辑）；
//     监控链路与数据面共用同一采集函数
//   · 00 v1.2 §2/§2.1：Evidence 层 verified/失败传播；SC-01：结构化层
//     parser_version/extractor_version 必填且 ≠ collector_version
//   · 04 §20 / SC-02 §7：用户面 error_text 为产品化文案，不含内部码/路径/栈
// 🔴 2026-10-18 整改轮（独立审核 CHANGES REQUIRED）：
//   · Adapter Contract 正式化：supports / resolveIdentity / collect /
//     normalize / health 五方法，validateAdapter() 结构锁定（启动自检+测试）
//   · normalize() 输出运行时 validator：字段缺失 / 维度不匹配 / Evidence
//     引用不完整 → 抛错，绝不允许静默接受（真值链零放水）
//   · 摘要判别联合 summary.kind（storefront_catalog / storefront_collections）：
//     商品/社媒/广告/评价/搜索不得共用「款、在售、价格区间」固定模板
//   · 快照真值链：多页 products.json 每页快照 + cart.js 币种独立快照，
//     Evidence 引用全部；currency 无币种快照一律 null
//   · identity 默认 unresolved；仅当成功确认来源且关联 Evidence/Snapshot
//     后才转 resolved（00 §53 三值冻结，不新增 candidate 枚举）
//   · timeout 独立分类（abort/超时不得归 unavailable，05 §11 八值）
// ============================================================
const Net = require('../research/net.js');
const EvidenceStore = require('../research/evidence-store.js');
const Snapshot = require('../research/source-snapshot.js');
const Registry = require('./capability-registry.js');
const SurfaceStore = require('./surface-store.js');
const fs = require('fs');

const CATALOG_ADAPTER_VERSION = 'shopify-adapter-1';
const COLLECTIONS_ADAPTER_VERSION = 'collections-adapter-1';

// ---------- 失败分类（05 §11 冻结字面量） ----------
// net.js 返回 { ok:false, error?, status?, snapshotId? }；此处映射为 source_status。
// 优先以快照自身 source_status 为准（快照落账时已用 Snapshot.classifyError 分类），
// 回退才按错误消息形态判定——abort/timeout 必须独立归类，不得吞进 unavailable。
function classifyFetchFailure(res, tenantId) {
  if (res && res.error === 'parse_failed') return { sourceStatus: 'parse_failed', retryable: true };
  if (tenantId && res && res.snapshotId) {
    try {
      const meta = Snapshot.getById(tenantId, res.snapshotId);
      if (meta && meta.source_status) {
        const st = String(meta.source_status);
        if (SurfaceStore.SOURCE_STATUSES.has(st)) {
          const retryable = st !== 'blocked';
          return { sourceStatus: st, retryable };
        }
      }
    } catch (e) { /* 反查失败走消息形态回退 */ }
  }
  const msg = String((res && (res.error || '')).toString());
  if (/abort|timed\s*out|timeout/i.test(msg)) return { sourceStatus: 'timeout', retryable: true };
  const st = Number(res && res.status);
  if (st === 429) return { sourceStatus: 'rate_limited', retryable: true };
  if (st === 401 || st === 403 || st === 407) return { sourceStatus: 'blocked', retryable: false };
  if (Number.isFinite(st) && st >= 500) return { sourceStatus: 'unavailable', retryable: true };
  return { sourceStatus: 'unavailable', retryable: true };
}
// 用户面失败文案（04 §20：产品化说明，无内部码）
const FAILURE_TEXT = Object.freeze({
  rate_limited: '对方官网暂时限制了访问频率，稍后重试通常可恢复。',
  blocked: '对方官网拒绝了本次访问，暂无法采集。',
  parse_failed: '对方官网返回了无法解析的内容，已保留原始数据待修复。',
  timeout: '对方官网响应超时，稍后可重试。',
  available: '对方官网暂时无法访问，稍后可重试。',
  unavailable: '对方官网暂时无法访问，稍后可重试。',
  internal_error: '采集时发生内部问题，已记录，稍后可重试。',
  adapter_output_invalid: '采集结果未通过完整性校验，已记录，稍后可重试。',
});

// ---------- 目录级摘要（独立 Metric 语义：不是单品价格变化，00 §32/SC-02 §9） ----------
function summarize(items) {
  const prices = items.filter(x => x && typeof x.repPrice === 'number' && x.repPrice > 0 && !x.soldOut)
    .map(x => x.repPrice).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor((prices.length - 1) / 2)] : null;
  return {
    count: items.length,
    onSaleCount: prices.length,
    soldOutCount: items.filter(x => x && x.soldOut).length,
    priceMin: prices.length ? prices[0] : null,
    priceMax: prices.length ? prices[prices.length - 1] : null,
    priceMedian: median,
  };
}

// ============================================================
// Adapter Contract（SC-02 §4 整改轮正式化）
//   supports(brandCtx)     → { supported, reasonCode?, reasonText? }
//   resolveIdentity(ctx)   → { platform, officialDomain?, platformAccountId?,
//                              identityStatus, originNote?, resolverVersion }
//   collect(ctx)           → adapter 自有采集结果（含 attempt 落账）
//   normalize(raw, ctx)    → StandardOutput（validator 校验通过的标准结构）
//   health()               → { ok, adapter, version, checkedAt }
// StandardOutput 字段清单见 validateOutput()。
// ============================================================
const ADAPTER_METHODS = Object.freeze(['supports', 'resolveIdentity', 'collect', 'normalize', 'health']);

// 摘要判别联合白名单（可扩展协议：新 kind = 新数据形状，禁止混用模板）
const SUMMARY_KINDS = Object.freeze({
  storefront_catalog: ['shopify_catalog'],
  storefront_collections: ['shopify_collections'],
});

// normalize 输出 outcome 冻结词表（§七.2：词表外一律拒绝）
const OUTCOMES = Object.freeze(['success', 'partial', 'empty_success']);

// summary.kind 必填字段表（§七.2：不完整即拒绝）
const SUMMARY_REQUIRED_FIELDS = Object.freeze({
  storefront_catalog: ['count', 'onSaleCount', 'soldOutCount', 'priceMin', 'priceMax', 'priceMedian', 'currency', 'currencyStatus', 'partialScan'],
  storefront_collections: ['collectionCount', 'collections', 'sourceObservedCount', 'storedCount', 'partialScan', 'partialScanReason'],
});

// 结构校验（启动自检 + 测试锁定）：缺方法/缺字段/缺白名单映射 → 显式失败
function validateAdapter(adapter) {
  const errs = [];
  if (!adapter || typeof adapter !== 'object') return { ok: false, errors: ['adapter is not an object'] };
  if (!adapter.code || typeof adapter.code !== 'string') errs.push('adapter.code required');
  if (!adapter.version || typeof adapter.version !== 'string') errs.push(adapter.code + ': version required');
  for (const m of ADAPTER_METHODS) {
    if (typeof adapter[m] !== 'function') errs.push(adapter.code + ': missing contract method ' + m);
  }
  const allKinds = Object.keys(SUMMARY_KINDS);
  if (adapter.code && !errs.some(e => e.includes('contract method'))) {
    const declared = adapter.summaryKinds || [];
    for (const k of declared) {
      if (!allKinds.includes(k)) errs.push(adapter.code + ': unknown summary.kind ' + k);
      else if (!SUMMARY_KINDS[k].length) errs.push(adapter.code + ': summary.kind ' + k + ' maps to no capability');
    }
  }
  return { ok: errs.length === 0, errors: errs };
}

// 运行时输出校验：任何放水都等于伪造真值链（审核整改硬要求）。
// 🔴 复审 §七：对**任意畸形输入**必须返回 {ok:false, errors}，绝不抛 TypeError；
// 且校验快照真实存在、属于当前租户、raw 可解析（06 Traceability 断链即无效）。
// out = normalize() 返回值；ctx = { capability, dimension, tenantId }。
function validateOutput(out, ctx) {
  const errs = [];
  try {
    if (!out || typeof out !== 'object') return { ok: false, errors: ['output is not an object'] };
    if (Array.isArray(out)) return { ok: false, errors: ['output must not be an array'] };
    const capCode = (ctx && ctx.capability) || out.capability;
    const cap = Registry.getCapability(capCode);
    if (!cap) return { ok: false, errors: ['output.capability not in Registry: ' + String(capCode)] };
    if (out.capability && out.capability !== cap.code) errs.push('capability mismatch: ' + out.capability + ' ≠ ' + cap.code);
    if (out.dimension && out.dimension !== cap.dimension) {
      errs.push('dimension mismatch: output ' + out.dimension + ' ≠ capability dimension ' + cap.dimension);
    }
    // outcome 冻结词表（§七.2）
    if (!OUTCOMES.includes(out.outcome)) {
      errs.push('outcome outside frozen vocabulary (success|partial|empty_success): ' + String(out.outcome));
    }
    // observations：必数组；币种只允许 null 或与 attempt 币种一致
    if (!Array.isArray(out.observations)) {
      errs.push('observations must be an array');
    } else {
      for (let i = 0; i < out.observations.length; i++) {
        const o = out.observations[i] || {};
        if (typeof o.title !== 'string') errs.push('observations[' + i + '].title must be string');
        if (o.price != null && typeof o.price !== 'number') errs.push('observations[' + i + '].price must be number|null');
        if (o.currency != null && out.currency != null && o.currency !== out.currency) {
          errs.push('observations[' + i + '].currency ≠ attempt currency');
        }
        if (typeof o.available !== 'boolean') errs.push('observations[' + i + '].available must be boolean');
      }
    }
    // summary：null 或判别联合合法 + kind↔capability 映射 + 必填字段完整
    if (out.summary != null) {
      const s = out.summary;
      if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.kind !== 'string') {
        errs.push('summary must be null or { kind, ... } discriminated union');
      } else if (!SUMMARY_KINDS[s.kind]) {
        errs.push('unknown summary.kind: ' + s.kind);
      } else {
        if (!SUMMARY_KINDS[s.kind].includes(cap.code)) errs.push('summary.kind ' + s.kind + ' not served by capability ' + cap.code);
        const reqFields = SUMMARY_REQUIRED_FIELDS[s.kind] || [];
        for (const f of reqFields) {
          if (!(f in s)) errs.push('summary.' + s.kind + ' missing required field: ' + f);
        }
      }
    }
    // snapshot / evidence 引用完整性（§七.2：必数组）
    if (!Array.isArray(out.snapshotIds)) errs.push('snapshotIds must be an array');
    const evSnaps = Array.isArray(out.evidenceSnapshotIds) ? out.evidenceSnapshotIds : [];
    const statusOk = OUTCOMES.includes(out.outcome);
    if (statusOk && !evSnaps.length) errs.push('evidence-grade provenance requires >=1 snapshot (06 Traceability)');
    for (const sid of evSnaps) {
      if (typeof sid !== 'string' || !sid) { errs.push('evidence snapshot id must be non-empty string'); continue; }
      if (!Array.isArray(out.snapshotIds) || !out.snapshotIds.includes(sid)) errs.push('evidence snapshot not in snapshotIds: ' + sid);
    }
    // 币种可追溯：有值必须有币种快照且被 Evidence 引用；status 与值一致（§七.2）
    if (out.currency != null) {
      if (typeof out.currency !== 'string') errs.push('currency must be string|null');
      if (!out.currencySnapshotId) errs.push('currency without currencySnapshotId (无快照币种非法)');
      else if (!evSnaps.includes(out.currencySnapshotId)) errs.push('currencySnapshotId not referenced by evidence');
      if (out.currencyStatus !== 'confirmed') errs.push('currencyStatus must be confirmed when currency present');
    } else {
      if (out.currencyStatus === 'confirmed') errs.push('currencyStatus confirmed but currency null');
    }
    // identity 三值冻结（00 §53）
    if (out.identityStatus && !['resolved', 'unresolved', 'conflicted'].includes(out.identityStatus)) {
      errs.push('identityStatus outside frozen triad (00 §53): ' + out.identityStatus);
    }
    // 快照真实性与租户归属（§七.2）：存在 + 当前租户 + raw 可解析
    const tenantId = ctx && ctx.tenantId;
    if (tenantId && Array.isArray(out.snapshotIds)) {
      for (const sid of out.snapshotIds) {
        if (typeof sid !== 'string' || !sid) continue;
        let meta = null;
        try { meta = Snapshot.getById(tenantId, sid); } catch (e) { errs.push('snapshot lookup threw: ' + sid); continue; }
        if (!meta) { errs.push('snapshot not resolvable in tenant scope: ' + sid); continue; }
        if (statusOk) {
          const rawRef = meta.raw_payload_ref && meta.raw_payload_ref.path;
          if (!rawRef) { errs.push('snapshot raw payload ref missing: ' + sid); continue; }
          try {
            const { DATA } = require('../core/paths.js');
            const path = require('path');
            const safeId = require('../core/safe-id.js');
            const abs = path.join(DATA, rawRef);
            if (!safeId.isWithinDir(DATA, abs) || !fs.existsSync(abs)) { errs.push('snapshot raw payload unresolvable: ' + sid); continue; }
            // 🔴 复审 §四.1：raw bytes 必须按已知 content type 可解析——JSON 型快照
            // 解析失败 = 不可追溯断链，不得产生 success evidence。
            const ct = String((meta.content_type || meta.contentType || '')).toLowerCase();
            if (statusOk && ct.includes('json')) {
              try {
                const raw = Snapshot.readRawPayload(meta);
                JSON.parse(raw.toString('utf8'));
              } catch (e) {
                errs.push('snapshot raw payload not parseable as JSON (content_type=' + ct + '): ' + sid);
              }
            }
          } catch (e) { errs.push('snapshot raw payload check failed: ' + sid); }
        }
      }
    }
  } catch (e) {
    // 兜底：validator 自身遇畸形输入（getter 抛错/Proxy 等）也不得上抛
    errs.push('validator internal error: ' + String((e && e.message) || e).slice(0, 120));
  }
  return { ok: errs.length === 0, errors: errs };
}

// 从 attempt 摘要重算目录级统计（纯投影；目录中位数只是目录摘要，非单品价格变化语义）
function summarizeObservations(observations) {
  const prices = (observations || []).filter(o => o && typeof o.price === 'number' && o.price > 0 && o.available)
    .map(o => o.price).sort((a, b) => a - b);
  const median = prices.length ? prices[Math.floor((prices.length - 1) / 2)] : null;
  return {
    count: (observations || []).length,
    onSaleCount: prices.length,
    soldOutCount: (observations || []).filter(o => o && o.available === false).length,
    priceMin: prices.length ? prices[0] : null,
    priceMax: prices.length ? prices[prices.length - 1] : null,
    priceMedian: median,
  };
}

// ---------- fencing（复审 §五）----------
// attempt 完成写入必须持有该 attempt 对应 job 的有效 claimToken（且租约未过期）。
// 旧 worker 失去租约后即使恢复运行，也写不动 attempt/Evidence/Identity/finish。
function assertFence(ctx) {
  const f = ctx && ctx.fence;
  if (!f || !f.jobId || !f.token) return; // 无 job 上下文（handler/测试直调）：不适用 fencing
  const row = SurfaceStore.getDb().prepare('SELECT status, claim_token, claim_expires_at FROM collection_jobs WHERE job_id=? AND tenant_id=?')
    .get(String(f.jobId), String(ctx.tenantId || ''));
  const now = Date.now();
  if (!row || row.status !== 'running' || String(row.claim_token) !== String(f.token) || Number(row.claim_expires_at || 0) < now) {
    const err = new Error('FENCED: claim token invalid or lease expired (job=' + f.jobId + ')');
    err.fenced = true;
    throw err;
  }
}

// 统一收尾：normalize → validate → Evidence → attempt 终态。
// 🔴 复审 §四：Evidence 创建失败（抛错或 recorded:false）→ attempt 落
// failed/internal_error，**绝不允许吞异常后继续 success**；identity 不 resolved。
// validator 失败同样落 failed（不静默接受不合格输出）。
async function finalizeOutput(ctx, raw, out) {
  const endedAt = ctx.nowMs ? new Date(ctx.nowMs).toISOString() : undefined; // 时间手术贯通（测试/回放）
  const v = validateOutput(out, { capability: out.capability, dimension: out.dimension, tenantId: ctx.tenantId });
  if (!v.ok) {
    assertFence(ctx); // fencing 拒绝时不得抢写终态
    const done = SurfaceStore.completeAttempt(ctx.tenantId, ctx.attemptId, {
      status: 'failed', sourceStatus: 'internal_error', errorClass: 'adapter_output_invalid',
      errorUserText: FAILURE_TEXT.adapter_output_invalid, endedAt,
      observations: [], snapshotIds: raw && Array.isArray(raw.snapshotIds) ? raw.snapshotIds : [], evidenceIds: [],
    }, ctx.fence);
    try { require('./logger.js').error('data_surface_adapter_output_invalid', { attemptId: ctx.attemptId, errors: v.errors.slice(0, 5) }); } catch (e) {}
    return { deduped: false, attempt: done, invalid: true, invalidErrors: v.errors };
  }

  // ---------- Evidence：引用全部参与汇总的快照（多页 + 币种） ----------
  // 失败语义：抛错 / 未落账 → attempt failed/internal_error（§四.2），零 verified 放行
  let evidenceId = null;
  if (out.evidenceSnapshotIds.length) {
    assertFence(ctx); // 写 Evidence 前 fencing 复核
    let ev = null;
    try {
      ev = EvidenceStore.recordEvidence({
        tenantId: ctx.tenantId, projectRef: ctx.projectId, brandHint: (ctx.competitor && ctx.competitor.name) || null,
        source: out.evidenceSource, provider: out.evidenceProvider,
        source_snapshot_ids: out.evidenceSnapshotIds,
        claim: { field: out.claimField, scope: out.claimScope },
        entity_key: out.entityKey, entity_ref: out.entityRef,
        extracted_value: out.extractedValue,
        unit: null, currency: out.currency || null, market: null,
        evidence_status: 'verified',
        parser_version: out.parserVersion,      // SC-01：结构化层必填，≠ collector 'net-1'
        extractor_version: out.parserVersion,
        observed_at: raw && raw._prov && raw._prov.observed_at || null,
        note: out.note || null,
      });
    } catch (e) {
      // 🔴 禁止吞： Evidence 落账失败（含 raw blob 缺失断链）= 数据不可追溯 → 失败
      assertFence(ctx);
      const done = SurfaceStore.completeAttempt(ctx.tenantId, ctx.attemptId, {
        status: 'failed', sourceStatus: 'internal_error', errorClass: 'internal_error',
        errorUserText: FAILURE_TEXT.internal_error, endedAt,
        observations: [], snapshotIds: out.snapshotIds, evidenceIds: [],
      }, ctx.fence);
      try { require('./logger.js').error('data_surface_evidence_failed', { attemptId: ctx.attemptId, err: String(e && e.message || e).slice(0, 200) }); } catch (e2) {}
      return { deduped: false, attempt: done, currency: out.currency || null, summary: out.summary, invalid: false, evidenceFailed: true, evidenceError: String(e && e.message || e).slice(0, 120) };
    }
    if (!ev || !ev.recorded) {
      // recorded:false（如 no_tenant_context）：同样不得 success
      assertFence(ctx);
      const reason = (ev && ev.reason) || 'not_recorded';
      const done = SurfaceStore.completeAttempt(ctx.tenantId, ctx.attemptId, {
        status: 'failed', sourceStatus: 'internal_error', errorClass: 'internal_error',
        errorUserText: FAILURE_TEXT.internal_error, endedAt,
        observations: [], snapshotIds: out.snapshotIds, evidenceIds: [],
      }, ctx.fence);
      try { require('./logger.js').error('data_surface_evidence_not_recorded', { attemptId: ctx.attemptId, reason }); } catch (e2) {}
      return { deduped: false, attempt: done, currency: out.currency || null, summary: out.summary, invalid: false, evidenceFailed: true, evidenceError: reason };
    }
    evidenceId = ev.meta.evidence_id;
  }

  const done = SurfaceStore.completeAttempt(ctx.tenantId, ctx.attemptId, {
    status: out.outcome === 'partial' ? 'partial' : 'success',
    sourceStatus: out.outcome === 'partial' ? 'partial' : 'success',
    observations: out.observations, endedAt,
    snapshotIds: out.snapshotIds, evidenceIds: evidenceId ? [evidenceId] : [],
    summary: out.summary ? Object.assign({}, out.summary, { currency: out.currency || null, currencyStatus: out.currencyStatus || 'unknown' }) : null,
  }, ctx.fence);
  return { deduped: false, attempt: done, currency: out.currency || null, summary: out.summary, invalid: false, evidenceId };
}

// ============================================================
// provider 运行模式（复审 §二/§七：fallback/fanout 的执行器模型）
//   · runProviderOutput：validate + Evidence 落账，**不写 attempt 终态、
//     不升级 identity**——执行器据其结果决定链是否继续；
//   · commitProviderTerminal：执行器选定的最终 provider → attempt 终态
//     （fence 贯穿）+ identity 升级（fence 门控）。
// 终态写入权唯一归属执行器：首 provider 失败不再固化父 attempt。
// ============================================================
async function runProviderOutput(ctx, raw, out) {
  const v = validateOutput(out, { capability: out.capability, dimension: out.dimension, tenantId: ctx.tenantId });
  if (!v.ok) {
    return { providerFailed: true, errorClass: 'adapter_output_invalid', invalidErrors: v.errors };
  }
  let evidenceId = null;
  if (out.evidenceSnapshotIds.length) {
    assertFence(ctx); // 写 Evidence 前 fencing 复核
    let ev = null;
    try {
      ev = EvidenceStore.recordEvidence({
        tenantId: ctx.tenantId, projectRef: ctx.projectId, brandHint: (ctx.competitor && ctx.competitor.name) || null,
        source: out.evidenceSource, provider: out.evidenceProvider,
        source_snapshot_ids: out.evidenceSnapshotIds,
        claim: { field: out.claimField, scope: out.claimScope },
        entity_key: out.entityKey, entity_ref: out.entityRef,
        extracted_value: out.extractedValue,
        unit: null, currency: out.currency || null, market: null,
        evidence_status: 'verified',
        parser_version: out.parserVersion,
        extractor_version: out.parserVersion,
        observed_at: raw && raw._prov && raw._prov.observed_at || null,
        note: out.note || null,
      });
    } catch (e) {
      return { providerFailed: true, errorClass: 'internal_error', evidenceFailed: true, evidenceError: String(e && e.message || e).slice(0, 120) };
    }
    if (!ev || !ev.recorded) {
      return { providerFailed: true, errorClass: 'internal_error', evidenceFailed: true, evidenceError: (ev && ev.reason) || 'not_recorded' };
    }
    evidenceId = ev.meta.evidence_id;
  }
  return { providerOk: true, evidenceId };
}

async function commitProviderTerminal(ctx, providerRun, out, ident) {
  const endedAt = ctx.nowMs ? new Date(ctx.nowMs).toISOString() : undefined;
  const done = SurfaceStore.completeAttempt(ctx.tenantId, ctx.attemptId, {
    status: out.outcome === 'partial' ? 'partial' : 'success',
    sourceStatus: out.outcome === 'partial' ? 'partial' : 'success',
    observations: out.observations, endedAt,
    snapshotIds: out.snapshotIds, evidenceIds: providerRun.evidenceId ? [providerRun.evidenceId] : [],
    summary: out.summary ? Object.assign({}, out.summary, { currency: out.currency || null, currencyStatus: out.currencyStatus || 'unknown' }) : null,
  }, ctx.fence);
  // identity 升级（fence 门控在 upsertIdentity 内部；FENCED 上抛由执行器透传）
  recordIdentity(ctx, ident, 'success', done.evidenceIds || [], done.snapshotIds || []);
  return { deduped: false, attempt: done, currency: out.currency || null, summary: out.summary, invalid: false, evidenceId: providerRun.evidenceId };
}

// 零观察成功终态（执行器调用）：无 Evidence → identity 保持 unresolved
//（catalog_accessible_no_evidence；来源可访问但无可提炼取值，不升级）。
function commitProviderEmpty(ctx, providerRun) {
  const done = SurfaceStore.completeAttempt(ctx.tenantId, ctx.attemptId, {
    status: 'success', sourceStatus: 'success', observations: [],
    endedAt: ctx.nowMs ? new Date(ctx.nowMs).toISOString() : undefined,
    snapshotIds: providerRun.snapshotIds || [], evidenceIds: [],
    summary: providerRun.summary || null,
  }, ctx.fence);
  if (providerRun.ident) {
    try { recordIdentity(ctx, providerRun.ident, 'empty_success', [], providerRun.snapshotIds || []); }
    catch (e) { if (!(e && e.fenced)) throw e; }
  }
  return { deduped: false, attempt: done, emptyCatalog: true };
}

// 身份落账：默认 unresolved；仅在成功确认来源且关联 Evidence/Snapshot 后 resolved。
// 已有 resolved 身份不因单次失败降级（身份连续性 00 §53；一次抓取失败不等于归属失效）。
function recordIdentity(ctx, ident, outcome, evidenceIds, snapshotIds) {
  const existing = SurfaceStore.getIdentity(ctx.tenantId, ctx.projectId, ctx.competitor.id, ident.platform, ident.platformAccountId || null);
  let status = 'unresolved';
  let resolvedAt = null;
  if (outcome === 'success' && snapshotIds.length && evidenceIds.length) {
    status = 'resolved'; // 成功确认来源 + Evidence/Snapshot 关联（整改硬门控）
  } else if (existing && existing.identityStatus === 'resolved') {
    status = 'resolved'; // 连续性：不降级
  }
  const upserted = SurfaceStore.upsertIdentity({
    tenantId: ctx.tenantId, projectId: ctx.projectId, competitorId: ctx.competitor.id,
    platform: ident.platform, platformAccountId: ident.platformAccountId || null,
    officialDomain: ident.officialDomain, identityStatus: status,
    originNote: status === 'resolved' ? null : (outcome === 'empty_success' ? 'catalog_accessible_no_evidence' : 'unconfirmed_source'),
    resolverVersion: ident.resolverVersion,
    evidenceIds, snapshotIds, resolvedAt: status === 'resolved' ? (existing && existing.resolvedAt) || null : null,
  }, ctx.fence); // resolved 升级的 fence 门控（复审 §三.2）
  return upserted.identity;
}

// 幂等开 attempt（handler 202+持久任务场景由 collect-jobs 传入 attemptId）
function openAttempt(ctx, capability) {
  const cap = Registry.getCapability(capability);
  let attemptId = ctx.attemptId || null;
  let attempt = ctx.attemptId ? SurfaceStore.getAttempt(ctx.tenantId, ctx.attemptId) : null;
  if (!attemptId) {
    const mk = SurfaceStore.createAttempt({
      tenantId: ctx.tenantId, projectId: ctx.projectId, competitorId: ctx.competitor.id,
      capability, dimension: cap.dimension,
      trigger: ctx.trigger === 'schedule' ? 'schedule' : 'manual', // 03 §20 词表
      idempotencyKey: ctx.idempotencyKey, nowMs: ctx.nowMs,
      costAttributionKey: cap.costAttributionKey,
      collectorVersion: cap.collectorVersion, parserVersion: cap.parserVersion,
    });
    if (mk.deduped) return { deduped: true, attempt: mk.attempt };
    attemptId = mk.attempt.attemptId;
    attempt = mk.attempt;
  }
  return { deduped: false, attempt, attemptId };
}

// 失败/空落账（分类 + 用户文案；不留僵尸 running）
// 🔴 复审 §二/§三：provider 运行模式（ctx.suppressTerminal）下不写终态——
// fallback/fanout 链的首个 provider 失败不得固化父 attempt，链耗尽后由
// 执行器统一落唯一最终失败；fence 贯穿一切终态写入（§三.1）。
function failAttempt(ctx, res, extra) {
  const cls = classifyFetchFailure(res, ctx.tenantId);
  if (ctx.suppressTerminal) {
    return { providerFailed: true, cls: cls.sourceStatus, errorClass: cls.sourceStatus, retryable: cls.retryable, sourceStatus: cls.sourceStatus };
  }
  const done = SurfaceStore.completeAttempt(ctx.tenantId, ctx.attemptId, {
    status: 'failed', sourceStatus: cls.sourceStatus,
    errorClass: cls.sourceStatus,
    errorUserText: FAILURE_TEXT[cls.sourceStatus] || FAILURE_TEXT.unavailable,
    endedAt: ctx.nowMs ? new Date(ctx.nowMs).toISOString() : undefined,
    observations: [], snapshotIds: (res && res.snapshotIds) || (res && res.snapshotId ? [res.snapshotId] : []) || [],
    evidenceIds: [],
  }, ctx.fence);
  return { deduped: false, attempt: done, retryable: cls.retryable };
}

// ============================================================
// Shopify catalog adapter（products.json 多页 + cart.js 币种）
// ============================================================
const shopifyAdapter = {
  code: 'shopify',
  displayName: '官网公开目录（Shopify）',
  version: CATALOG_ADAPTER_VERSION,
  summaryKinds: ['storefront_catalog'],

  supports(brandCtx) {
    return Registry.supportsForBrand('shopify_catalog', brandCtx);
  },

  // 最小身份解析：official domain + platform；不碰跨租户 Canonical 层（SC-02 §5）。
  // 默认 unresolved——resolved 只由 recordIdentity() 在证据齐备后授予。
  resolveIdentity(brandCtx) {
    const b = brandCtx || {};
    const d = Net.domainOf(b.url || '');
    return {
      platform: 'shopify',
      officialDomain: d || null,
      platformAccountId: d || null, // v0：公开目录无账号体系，domain 即身份键
      identityStatus: 'unresolved',
      originNote: null,
      resolverVersion: CATALOG_ADAPTER_VERSION,
    };
  },

  // normalize：原始采集结果 → StandardOutput（含判别联合摘要与币种可追溯性）
  // 🔴 复审 §二.3：partial 语义读结构化字段（partialScan/partialScanReason/
  // successfullyFetchedPages/failedPage），truncated 仅作 legacy 兼容，不替代。
  normalize(raw, ctx) {
    const res = raw || {};
    const ident = this.resolveIdentity({ url: ctx.competitor && ctx.competitor.url });
    const items = Array.isArray(res.items) ? res.items : [];
    const observations = items.slice(0, SurfaceStore.OBSERVATION_CAP).map(x => ({
      id: x.id == null ? null : String(x.id),
      title: String(x.title || '').slice(0, 120),
      price: typeof x.repPrice === 'number' ? x.repPrice : null,
      currency: res.currency || null, // 无币种快照时 net 层已给 null
      available: !x.soldOut,
      publishedAt: x.publishedAt || null,
    }));
    const stats = summarize(items);
    // snapshotIds = 汇总 + 全部页 + 币种（全部参与汇总/引用，一个不落——真值链可复算）
    const snapshotIds = (Array.isArray(res.snapshotIds) ? res.snapshotIds.slice() : (res.snapshotId ? [res.snapshotId] : []));
    const currencySnapshotId = res.currencySnapshotId || null;
    if (currencySnapshotId && !snapshotIds.includes(currencySnapshotId)) snapshotIds.push(currencySnapshotId);
    const currency = res.currency || null;
    // Evidence 引用 = snapshotIds 全集（多页 + 币种；无币种则不引用任何币种快照）
    const evidenceSnapshotIds = snapshotIds.slice();
    // partial 结构化：net 层 partialScan/partialScanReason/successfullyFetchedPages/failedPage
    const partial = !!(res.partialScan != null ? res.partialScan : res.truncated);
    const partialScanReason = partial ? (res.partialScanReason || (res.truncated ? 'products_json_truncated_legacy' : null) || 'partial_scan_unspecified') : null;
    const pages = typeof res.successfullyFetchedPages === 'number' ? res.successfullyFetchedPages
      : (Array.isArray(res.successfullyFetchedPages) ? res.successfullyFetchedPages.length : null);
    const failedPage = res.failedPage || null;
    return {
      capability: 'shopify_catalog', dimension: 'website_products',
      outcome: partial ? 'partial' : 'success',
      observations,
      summary: {
        kind: 'storefront_catalog',
        count: stats.count, onSaleCount: stats.onSaleCount, soldOutCount: stats.soldOutCount,
        priceMin: stats.priceMin, priceMax: stats.priceMax, priceMedian: stats.priceMedian,
        currency, currencyStatus: currency ? 'confirmed' : 'unknown',
        partialScan: partial, partialScanReason,
        successfullyFetchedPages: pages, failedPage,
      },
      snapshotIds, evidenceSnapshotIds,
      currency, currencySnapshotId,
      currencyStatus: currency ? 'confirmed' : 'unknown',
      identityStatus: 'unresolved',
      evidenceSource: 'shopify', evidenceProvider: 'shopify_products_json',
      claimField: 'catalog.observation', claimScope: 'public_catalog_observation',
      entityKey: ident.officialDomain || (ctx.competitor && ctx.competitor.url) || null,
      entityRef: { kind: 'storefront_domain', domain: ident.officialDomain || null },
      extractedValue: {
        summaryKind: 'storefront_catalog',
        count: stats.count, onSaleCount: stats.onSaleCount, soldOutCount: stats.soldOutCount,
        priceMin: stats.priceMin, priceMax: stats.priceMax, priceMedian: stats.priceMedian,
        currency: currency || null, partialScan: partial, partialScanReason,
        successfullyFetchedPages: pages, failedPage,
      },
      parserVersion: CATALOG_ADAPTER_VERSION,
      note: 'data-surface catalog observation (multi-page snapshots + currency snapshot)',
      sourceUrl: res.url || null,
    };
  },

  async collect(ctx) {
    const comp = ctx.competitor || {};
    const trigger = ctx.trigger === 'schedule' ? 'schedule' : 'manual'; // 03 §20 词表
    const suppress = !!ctx.suppressTerminal; // provider 运行模式：终态写入权归策略执行器
    const opened = suppress ? { deduped: false, attemptId: ctx.attemptId } : openAttempt(ctx, 'shopify_catalog');
    if (opened.deduped) return { deduped: true, attempt: opened.attempt };
    ctx.attemptId = opened.attemptId;
    const ident = this.resolveIdentity({ url: comp.url, isShopify: comp.isShopify });
    // 身份默认 unresolved 落账（成功路径再由 recordIdentity 升级）
    try { if (!suppress) recordIdentity(ctx, ident, 'unconfirmed', [], []); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; }

    let res = null;
    try { res = await Net.fetchShopifyProducts(comp.url, { trigger, tenantId: ctx.tenantId }); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }

    if (!res || res.ok !== true) {
      if (res && res.empty) {
        // 目录可访问但 0 款：成功的"零观察"（≠ 失败 ≠ 未采集）。
        // 无 Evidence（零观察不提炼取值）→ identity 保持 unresolved。
        const emptySummary = { kind: 'storefront_catalog', count: 0, onSaleCount: 0, soldOutCount: 0, priceMin: null, priceMax: null, priceMedian: null, currency: res.currency || null, currencyStatus: res.currency ? 'confirmed' : 'unknown', partialScan: false, partialScanReason: null, successfullyFetchedPages: null, failedPage: null };
        if (suppress) return { providerOk: true, empty: true, ident, summary: emptySummary, snapshotIds: res.snapshotIds || [], currency: res.currency || null };
        try {
          assertFence(ctx);
          const done = SurfaceStore.completeAttempt(ctx.tenantId, ctx.attemptId, {
            status: 'success', sourceStatus: 'success', observations: [],
            endedAt: ctx.nowMs ? new Date(ctx.nowMs).toISOString() : undefined,
            snapshotIds: res.snapshotIds || (res.snapshotId ? [res.snapshotId] : []), evidenceIds: [],
            summary: emptySummary,
          }, ctx.fence);
          return { deduped: false, attempt: done, emptyCatalog: true };
        } catch (e) {
          if (e && e.fenced) return { deduped: false, fenced: true, attempt: null };
          throw e;
        }
      }
      return failAttempt(ctx, res);
    }

    const out = this.normalize(res, ctx);
    if (suppress) return { providerOk: true, ident, raw: res, out }; // validate/Evidence/终态由执行器统一
    let fin;
    try {
      fin = await finalizeOutput(ctx, res, out);
    } catch (e) {
      if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; // 失租约：不写任何终态
      throw e;
    }
    if (fin.invalid || fin.evidenceFailed) return fin;
    // 成功 + Evidence/Snapshot 齐备 → identity resolved（整改门控）
    try { recordIdentity(ctx, ident, 'success', fin.attempt.evidenceIds, fin.attempt.snapshotIds); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: fin.attempt }; }
    return Object.assign(fin, { sourceUrl: out.sourceUrl, entityKey: out.entityKey });
  },

  health() {
    return { ok: true, adapter: this.code, version: this.version, checkedAt: new Date().toISOString() };
  },
};

// ============================================================
// Shopify collections adapter（/collections.json 店铺集合清单）
// 第二能力示例：同维度（website_products）第二个 capability 并行聚合。
// ============================================================
const shopifyCollectionsAdapter = {
  code: 'shopify_collections',
  displayName: '官网商品集合清单（Shopify）',
  version: COLLECTIONS_ADAPTER_VERSION,
  summaryKinds: ['storefront_collections'],

  supports(brandCtx) {
    return Registry.supportsForBrand('shopify_collections', brandCtx);
  },

  resolveIdentity(brandCtx) {
    const b = brandCtx || {};
    const d = Net.domainOf(b.url || '');
    return {
      platform: 'shopify',
      officialDomain: d || null,
      platformAccountId: d ? d + '#collections' : null, // 同平台不同账号/主体的 account_key
      identityStatus: 'unresolved',
      originNote: null,
      resolverVersion: COLLECTIONS_ADAPTER_VERSION,
    };
  },

  // normalize：集合清单 → storefront_collections 摘要（无商品观察、无价格——不越界）。
  // 🔴 复审 §三：快照由 net 层落原始字节（res.snapshotId），adapter 不再自建快照；
  // 截断语义（sourceObservedCount/storedCount/partialScan/partialScanReason）如实传播。
  normalize(raw, ctx) {
    const res = raw || {};
    const ident = this.resolveIdentity({ url: ctx.competitor && ctx.competitor.url });
    const list = (Array.isArray(res.collections) ? res.collections : []).map(c => ({
      title: String(c.title || '').slice(0, 80), handle: String(c.handle || '').slice(0, 80),
    }));
    const snapshotIds = res.snapshotId ? [res.snapshotId] : [];
    const partial = !!res.partialScan;
    return {
      capability: 'shopify_collections', dimension: 'website_products',
      outcome: partial ? 'partial' : 'success',
      observations: [],
      summary: {
        kind: 'storefront_collections',
        collectionCount: list.length, collections: list,
        sourceObservedCount: typeof res.sourceObservedCount === 'number' ? res.sourceObservedCount : list.length,
        storedCount: typeof res.storedCount === 'number' ? res.storedCount : list.length,
        partialScan: partial, partialScanReason: partial ? (res.partialScanReason || 'collections_truncated') : null,
      },
      snapshotIds, evidenceSnapshotIds: snapshotIds.slice(),
      currency: null, currencySnapshotId: null, currencyStatus: 'unknown',
      identityStatus: 'unresolved',
      evidenceSource: 'shopify', evidenceProvider: 'shopify_collections_json',
      claimField: 'catalog.collections', claimScope: 'storefront_collections_observation',
      entityKey: ident.officialDomain || (ctx.competitor && ctx.competitor.url) || null,
      entityRef: { kind: 'storefront_domain', domain: ident.officialDomain || null },
      extractedValue: {
        summaryKind: 'storefront_collections',
        collectionCount: list.length,
        sourceObservedCount: typeof res.sourceObservedCount === 'number' ? res.sourceObservedCount : list.length,
        storedCount: typeof res.storedCount === 'number' ? res.storedCount : list.length,
        partialScan: partial, partialScanReason: partial ? (res.partialScanReason || 'collections_truncated') : null,
        collections: list,
      },
      parserVersion: COLLECTIONS_ADAPTER_VERSION,
      note: 'data-surface storefront collections observation (raw bytes snapshot by net layer)',
      sourceUrl: res.sourceUrl || res.url || null,
    };
  },

  async collect(ctx) {
    const comp = ctx.competitor || {};
    const trigger = ctx.trigger === 'schedule' ? 'schedule' : 'manual';
    const suppress = !!ctx.suppressTerminal; // provider 运行模式：终态写入权归策略执行器
    const opened = suppress ? { deduped: false, attemptId: ctx.attemptId } : openAttempt(ctx, 'shopify_collections');
    if (opened.deduped) return { deduped: true, attempt: opened.attempt };
    ctx.attemptId = opened.attemptId;
    const ident = this.resolveIdentity({ url: comp.url, isShopify: comp.isShopify });
    try { if (!suppress) recordIdentity(ctx, ident, 'unconfirmed', [], []); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; }

    let res = null;
    try { res = await Net.fetchShopifyCollections(comp.url, { trigger, tenantId: ctx.tenantId }); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    // 无 status 无 error 的 ok:false = 店铺可访问但 0 集合（成功的零观察）；
    // 带 status/error = 真实失败，走失败分类。🔴 无 res.snapshotId 的成功也不接受
    // （原始字节快照不可追溯 = 不得 success，由 validator 拒绝）。
    if (res && res.ok !== true && (res.status != null || res.error)) return failAttempt(ctx, res);

    const out = this.normalize(res, ctx);
    if (suppress) return { providerOk: true, ident, raw: res, out }; // validate/Evidence/终态由执行器统一
    let fin;
    try { fin = await finalizeOutput(ctx, res, out); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; throw e; }
    if (fin.invalid || fin.evidenceFailed) return fin;
    try { recordIdentity(ctx, ident, 'success', fin.attempt.evidenceIds, fin.attempt.snapshotIds); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: fin.attempt }; }
    return Object.assign(fin, { sourceUrl: out.sourceUrl, entityKey: out.entityKey });
  },

  health() {
    return { ok: true, adapter: this.code, version: this.version, checkedAt: new Date().toISOString() };
  },
};

const ADAPTERS = Object.freeze({ shopify: shopifyAdapter, shopify_collections: shopifyCollectionsAdapter });

// 全量结构自检（启动与测试锁定）：缺方法/缺 kind 映射 → 显式失败
function assertAdaptersIntegrity() {
  const errs = [];
  for (const ad of Object.values(ADAPTERS)) {
    const v = validateAdapter(ad);
    if (!v.ok) errs.push(...v.errors);
  }
  return { ok: errs.length === 0, errors: errs };
}

// ---------- adapter 执行策略（复审 §七.3：dimension→capabilities[]→adapters[]） ----------
// single：链 = 主 adapter 一个；fallback：全序链，依次尝试至首个成功；
// fanout：全量链全部执行（本批语义：全部执行、首个成功为 attempt 结果、
//   其余记 skipped；同能力多 attempt 拆分为后续批，见 SC-02 已知限制）。
// overrides：测试注入 { adapters:[...], strategy }（不依赖修改冻结 Registry）。
const ADAPTER_STRATEGIES = Object.freeze(['single', 'fallback', 'fanout']);
function resolveAdapterChain(capability, overrides) {
  const ov = overrides || {};
  const cap = Registry.getCapability(capability);
  const strategy = ov.strategy || (cap && cap.adapterStrategy) || 'single';
  if (!ADAPTER_STRATEGIES.includes(strategy)) {
    return { ok: false, reason: 'unknown_strategy:' + String(strategy), strategy, chain: [] };
  }
  const adapters = Array.isArray(ov.adapters) ? ov.adapters.slice()
    : (cap ? (Array.isArray(cap.adapters) && cap.adapters.length ? cap.adapters.slice() : (cap.adapter ? [cap.adapter] : [])) : []);
  const chain = strategy === 'single' ? adapters.slice(0, 1) : adapters.slice();
  if (!chain.length) return { ok: false, reason: 'no_adapter_for_capability', strategy, chain: [] };
  return { ok: true, reason: null, strategy, chain };
}

function getAdapter(code) { return ADAPTERS[String(code || '')] || null; }
function listAdapters() { return Object.values(ADAPTERS).map(a => ({ code: a.code, displayName: a.displayName, version: a.version, summaryKinds: a.summaryKinds })); }

module.exports = {
  CATALOG_ADAPTER_VERSION, COLLECTIONS_ADAPTER_VERSION,
  ADAPTERS, ADAPTER_METHODS, SUMMARY_KINDS, ADAPTER_STRATEGIES, OUTCOMES,
  getAdapter, listAdapters, validateAdapter, validateOutput, assertAdaptersIntegrity,
  resolveAdapterChain, classifyFetchFailure, summarize, summarizeObservations, assertFence,
  runProviderOutput, commitProviderTerminal, finalizeOutput, commitProviderEmpty, FAILURE_TEXT,
};
