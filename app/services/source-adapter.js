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
const UrlRedact = require('../lib/url-redact.js');
const ProviderResponse = require('../lib/provider-response.js');
const TikTokAdLib = require('../lib/tiktok-adlib.js');
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
  // Wave 1：各新维度独立摘要形状（禁止复用 Shopify 价格卡模板）
  social_videos: ['youtube_content'],
  trend_series: ['dataforseo_trends'],
  ad_creatives: ['tiktok_commercial_content'],
  reviews_digest: ['public_reviews'],
  // SC-06：通用官网公开资料形状（与 Shopify 目录摘要严格分离）
  official_site_profile: ['official_site_profile'],
  official_site_products: ['public_site_products'],
});

// normalize 输出 outcome 冻结词表（§七.2：词表外一律拒绝）
const OUTCOMES = Object.freeze(['success', 'partial', 'empty_success']);

// summary.kind 必填字段表（§七.2：不完整即拒绝）
const SUMMARY_REQUIRED_FIELDS = Object.freeze({
  storefront_catalog: ['count', 'onSaleCount', 'soldOutCount', 'priceMin', 'priceMax', 'priceMedian', 'currency', 'currencyStatus', 'partialScan'],
  storefront_collections: ['collectionCount', 'collections', 'sourceObservedCount', 'storedCount', 'partialScan', 'partialScanReason'],
  // Wave 1：measurementMethod 为必填——公开来源观察 vs 数据服务估算必须在摘要层可判别
  social_videos: ['videoCount', 'measurementMethod', 'partialScan'],
  trend_series: ['pointCount', 'measurementMethod', 'periodStart', 'periodEnd', 'partialScan'],
  ad_creatives: ['creativeCount', 'measurementMethod', 'partialScan'],
  reviews_digest: ['reviewCount', 'sourceCount', 'measurementMethod', 'periodStart', 'periodEnd', 'partialScan'],
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
  // P0-2 整改 r2：真实成功 → provider verification（operational 只能由真实成功产生）
  try {
    const capDef = Registry.getCapability(out.capability);
    require('./source-readiness.js').recordVerification({
      capability: out.capability, provider: (capDef && capDef.provider) || out.evidenceProvider || '',
      status: 'success', tenantId: ctx.tenantId,
    });
  } catch (eR) { /* readiness 记录失败不影响 attempt 终态 */ }
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
// SC-06：fetchPage 失败 → 用户文案分类（blocked=robots/SSRF 主动拒绝；
// 其余网络类=来源暂不可达；两者都不伪装成「官网不支持」）
function AdaptersClassify(fr) {
  const err = String((fr && fr.error) || '');
  if (/ROBOTS_DISALLOWED|SSRF_BLOCKED|FETCH_CIRCUIT_OPEN/.test(err)) return 'blocked';
  return 'unreachable';
}

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
  // P0-2 整改 r2：真实失败分类进 readiness（CONFIG_MISSING 不记录——状态实时判定已优先覆盖）
  try {
    if (res && res.error !== 'CONFIG_MISSING' && ctx.attemptId) {
      const att = SurfaceStore.getAttempt(ctx.tenantId, ctx.attemptId);
      if (att && att.capability) {
        const Readiness = require('./source-readiness.js');
        const capDef = Registry.getCapability(att.capability);
        const fc = cls.sourceStatus === 'blocked' ? 'auth_rejected'
          : cls.sourceStatus === 'rate_limited' ? 'quota_exhausted' : 'unavailable';
        Readiness.recordVerification({ capability: att.capability, provider: (capDef && capDef.provider) || '', status: 'failed', failureClass: fc, tenantId: ctx.tenantId });
      }
    }
  } catch (e2) { /* readiness 记录失败不影响 attempt 终态 */ }
  if (ctx.suppressTerminal) {
    return { providerFailed: true, cls: cls.sourceStatus, errorClass: cls.sourceStatus, retryable: cls.retryable, sourceStatus: cls.sourceStatus };
  }
  // Wave 1：extra.errorUserText 允许 adapter 定制失败文案（如凭据缺失 ≠ 来源拒绝），
  // 但仍必须产品化（04 §20：无内部码/路径/栈），且绝不含密钥。
  const userText = (extra && extra.errorUserText) || FAILURE_TEXT[cls.sourceStatus] || FAILURE_TEXT.unavailable;
  const done = SurfaceStore.completeAttempt(ctx.tenantId, ctx.attemptId, {
    status: 'failed', sourceStatus: cls.sourceStatus,
    errorClass: cls.sourceStatus,
    errorUserText: userText,
    endedAt: ctx.nowMs ? new Date(ctx.nowMs).toISOString() : undefined,
    observations: [], snapshotIds: (res && res.snapshotIds) || (res && res.snapshotId ? [res.snapshotId] : []) || [],
    evidenceIds: [],
  }, ctx.fence);
  return { deduped: false, attempt: done, retryable: cls.retryable };
}

// P0-4 整改 r3：provider 结构判定失败 → 真实失败分类（HTTP 200 + 业务错误绝不进成功链）
function failFromProviderCheck(ctx, chk) {
  const status = chk.errorClass === 'auth_rejected' ? 403 : chk.errorClass === 'quota_exhausted' ? 429 : 502;
  return failAttempt(ctx, { ok: false, error: chk.errorClass, status }, { errorUserText: ProviderResponse.USER_TEXT[chk.errorClass] || '数据服务暂不可用，请稍后再试。' });
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

// ============================================================
// Wave 1 adapters（youtube / dataforseo / tiktok / reviews）
// 共同纪律（任务书 §一/§二/§三）：
//  · 全部经既有链路：Registry → Adapter Contract → CollectionAttempt →
//    SourceSnapshot → Evidence → Data Surface；不另起采集体系。
//  · 凭据化 API 调用走 safeRequestOnce（assertPublicUrl/safeLookup 的
//    SSRF/DNS-rebinding 防护全保留）；robots 合规门面向网页抓取，凭据化
//    API 调用是授权数据服务使用而非爬取，不适用 robots（public_reviews
//    的网页抓取部分仍走完整 FetchGate/robots）。
//  · 凭据（query key / Authorization）绝不进快照 URL、日志、错误信息——
//    快照 source_url 对凭据参数做 [REDACTED] 脱敏。
//  · measurementMethod 必标：公开来源观察 vs 数据服务估算（licensed_estimate）。
//  · 凭据缺失/权限不足/配额耗尽/来源不可达 = 各自真实失败状态，不伪装无结果。
//  · 未通过一次真实 staging 成功请求（live-source-smoke）前，capability 保持
//    pending_config，不升级 ga。
// ============================================================
const YT_ADAPTER_VERSION = 'youtube-adapter-1';
const DFS_ADAPTER_VERSION = 'dataforseo-adapter-1';
const TT_ADAPTER_VERSION = 'tiktok-adapter-1';
// P0-2 整改 r3：TikTok Commercial Content API 官方常量（2026-10-19 核实文档）
// Query Ads: POST https://open.tiktokapis.com/v2/research/adlib/ad/query/?fields=<白名单>
// Authorization: Bearer <client access token>（client key/secret 只用于 /v2/oauth/token/）
const TT_AD_ENDPOINT = 'https://open.tiktokapis.com/v2/research/adlib/ad/query/';
// 官方 fields 白名单（Query Ads 文档逐字，11 项）与「本产品实际请求字段」统一由
// lib/tiktok-adlib.js 持有——此处只做引用，禁止在本文件再写一份字段清单/数量。
//   白名单：ad.id / ad.first_shown_date / ad.last_shown_date / ad.status / ad.status_statement
//           / ad.videos / ad.image_urls / ad.reach
//           / advertiser.business_id / advertiser.business_name / advertiser.paid_for_by
const TT_AD_FIELDS = TikTokAdLib.AD_FIELDS_CSV;
const TT_AD_FIELD_COUNT = TikTokAdLib.AD_FIELD_COUNT;
// 官方 Supported Countries（文档页核实）：EU 27 + EEA 3 + GB/CH = 32 国——不含美国。
// 🔴 数量一律从 SUPPORTED_COUNTRIES.length 派生（r3 曾列表 32 项而文案写成 30）。
const TT_SUPPORTED_COUNTRIES = TikTokAdLib.SUPPORTED_COUNTRIES;
const TT_COUNTRY_COUNT = TikTokAdLib.COUNTRY_COUNT;

const REV_ADAPTER_VERSION = 'reviews-adapter-1';
// SC-06：通用官网公开资料解析器（零 IO；网络由 Net.fetchPage 完成）
const SiteProfile = require('../research/site-profile.js');

// 失败文案（Wave 1 定制：配置缺失是系统状态，不是来源拒绝；04 §20 产品化）
const WAVE1_FAILURE_TEXT = Object.freeze({
  config_missing: '该数据服务尚未配置系统级访问凭据，当前无法采集；配置后即可使用。',
  auth_rejected: '数据服务拒绝了本次访问（凭据无效或权限不足），已记录，暂无法采集。',
  quota_exhausted: '数据服务配额已用尽，稍后重试或调整配额。',
});

// 凭据参数脱敏（P0-1 整改 r3）：委托独立共享模块 app/lib/url-redact.js（零循环依赖）。
// 所有持久化边界（Snapshot source_url/final_url、fetchApiJson finalUrl、
// provider_verifications.source_url、Evidence/report/admin/错误对象、重定向 URL）
// 都必须经过同一套脱敏函数。
const SENSITIVE_QUERY_KEYS = UrlRedact.SENSITIVE_QUERY_KEYS;
function redactSecretParams(u, secretParams) {
  return UrlRedact.redactUrl(u, secretParams);
}

// 凭据化 API JSON 抓取（共享 helper）：SSRF 校验 → safeRequestOnce → 脱敏快照 → JSON。
// robots 不适用（授权 API 调用）；快照仍逐次落账（原始字节可追溯）。
async function fetchApiJson(spec) {
  const o = spec || {};
  const fetchedAt = new Date().toISOString();
  try { await Net.assertPublicUrl(o.url); } catch (e) {
    return { ok: false, error: 'internal_error', errorUserText: '请求地址未通过安全校验，已阻止。' };
  }
  let res = null;
  try {
    res = await Net.safeRequestOnce(o.url, { timeoutMs: o.timeoutMs || 15000, method: o.method || 'GET', headers: o.headers || {}, body: o.body != null ? o.body : undefined });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/SAFE_FETCH_TIMEOUT/.test(msg)) return { ok: false, error: 'timeout', errorUserText: WAVE1_FAILURE_TEXT.quota_exhausted ? '数据服务响应超时，稍后可重试。' : '数据服务响应超时。' };
    return { ok: false, error: 'unavailable', errorUserText: '数据服务暂时无法访问，稍后可重试。' };
  }
  // 脱敏快照（原始字节；source_url / final_url 一律 [REDACTED] 凭据参数——P0 整改 r2）
  let snapshotId = null;
  const safeSourceUrl = redactSecretParams(o.url, o.secretParams || []);
  const safeFinalUrl = redactSecretParams(res.url || o.url, o.secretParams || []);
  try {
    const s = Snapshot.record({
      capability: o.capability || 'evidence_url', provider: o.provider || 'licensed_api',
      source_url: safeSourceUrl, final_url: safeFinalUrl,
      redirect_hops: 0, http_status: res.status, source_status: res.status >= 200 && res.status < 300 ? 'success' : (res.status === 401 || res.status === 403 ? 'blocked' : res.status === 429 ? 'rate_limited' : 'unavailable'),
      observed_at: fetchedAt, fetched_at: fetchedAt, bodyBytes: res.buffer,
      contentType: (res.headers && res.headers['content-type']) || 'application/json',
      trigger: o.trigger || 'manual', tenantId: o.tenantId,
    });
    if (s.recorded) snapshotId = s.meta.snapshot_id;
  } catch (e) { /* 快照失败 → 调用方按 Evidence 落账失败处理，不放水 */ }
  if (!(res.status >= 200 && res.status < 300)) {
    const st = res.status;
    if (st === 401 || st === 403) return { ok: false, error: 'auth_rejected', status: st, snapshotId, errorUserText: WAVE1_FAILURE_TEXT.auth_rejected };
    if (st === 429) return { ok: false, error: 'quota_exhausted', status: st, snapshotId, errorUserText: WAVE1_FAILURE_TEXT.quota_exhausted };
    return { ok: false, error: 'unavailable', status: st, snapshotId, errorUserText: '数据服务返回 ' + st + '，稍后可重试。' };
  }
  let json = null;
  try { json = JSON.parse(res.buffer.toString('utf8')); } catch (e) {
    return { ok: false, error: 'parse_failed', status: res.status, snapshotId, errorUserText: '数据服务返回了无法解析的内容，已保留原始数据待修复。' };
  }
  return { ok: true, status: res.status, json, snapshotId, finalUrl: safeFinalUrl };
}

// YouTube 公开内容（官方 Data API v3 REST 契约；发现→归属校验→视频→评论）
const youtubeAdapter = {
  code: 'youtube',
  displayName: '社媒内容（YouTube 公开频道）',
  version: YT_ADAPTER_VERSION,
  summaryKinds: ['social_videos'],

  supports(brandCtx) {
    return Registry.supportsForBrand('youtube_content', brandCtx);
  },

  // 品牌→频道归属校验：官方 channel 数据内的匹配依据（频道名/简介含品牌名或官网域）。
  // 冻结语义（00 §53）：identity 只有 unresolved/resolved，无 candidate——不确定时
  // 保持 unresolved，匹配依据写 originNote 供人工核对。
  matchEvidence(channelSnippet, brand) {
    const reasons = [];
    const name = String(brand.name || '').trim().toLowerCase();
    const domain = Net.domainOf(brand.url || '');
    const title = String((channelSnippet && channelSnippet.title) || '').toLowerCase();
    const desc = String((channelSnippet && (channelSnippet.description || channelSnippet.customUrl)) || '').toLowerCase();
    if (name && title.includes(name)) reasons.push('频道名称包含品牌名「' + (brand.name || '') + '」');
    if (domain && desc.includes(domain.toLowerCase())) reasons.push('频道公开简介包含官网域名 ' + domain);
    if (name && desc.includes(name)) reasons.push('频道公开简介包含品牌名');
    return reasons;
  },

  resolveIdentity(brandCtx) {
    const b = brandCtx || {};
    const d = Net.domainOf(b.url || '');
    return {
      platform: 'youtube',
      officialDomain: d || null,
      platformAccountId: null, // 频道归属需归属校验后由 recordIdentity 授予
      identityStatus: 'unresolved',
      originNote: null,
      resolverVersion: YT_ADAPTER_VERSION,
    };
  },

  // raw → StandardOutput：公开视频观察 + social_videos 摘要（measurementMethod 必标）
  normalize(raw, ctx) {
    const res = raw || {};
    const ident = this.resolveIdentity({ url: ctx.competitor && ctx.competitor.url });
    const videos = (Array.isArray(res.videos) ? res.videos : []).slice(0, SurfaceStore.OBSERVATION_CAP).map(v => ({
      id: String(v.videoId || v.id || ''),
      title: String(v.title || '').slice(0, 120),
      price: null, currency: null,
      available: true,
      publishedAt: v.publishedAt || null,
      // 公开互动字段原样透出（YouTube Data API statistics；不推算任何衍生指标）
      viewCount: typeof v.viewCount === 'number' ? v.viewCount : null,
      likeCount: typeof v.likeCount === 'number' ? v.likeCount : null,
      commentCount: typeof v.commentCount === 'number' ? v.commentCount : null,
      thumbnailUrl: v.thumbnailUrl || null,
      videoUrl: v.videoUrl || null,
    }));
    const partial = !!res.partialScan;
    const comments = (Array.isArray(res.comments) ? res.comments : []).slice(0, 20).map(c => ({
      text: String(c.text || '').slice(0, 160), videoId: c.videoId || null, sourceUrl: c.sourceUrl || null,
    }));
    return {
      capability: 'youtube_content', dimension: 'social_content',
      outcome: partial ? 'partial' : 'success',
      observations: videos,
      summary: {
        kind: 'social_videos',
        videoCount: videos.length,
        channelTitle: res.channelTitle || null,
        channelId: res.channelId || null,
        matchReasons: res.matchReasons || [],
        measurementMethod: 'public_source_observation',
        periodStart: res.periodStart || null, periodEnd: res.periodEnd || null,
        comments,
        partialScan: partial, partialScanReason: partial ? (res.partialScanReason || null) : null,
      },
      snapshotIds: (res.snapshotIds || []).slice(), evidenceSnapshotIds: (res.snapshotIds || []).slice(),
      currency: null, currencySnapshotId: null, currencyStatus: 'unknown',
      identityStatus: 'unresolved',
      evidenceSource: 'youtube', evidenceProvider: 'youtube_data_api_v3',
      claimField: 'social.public_videos', claimScope: 'public_social_content_observation',
      entityKey: res.channelId || ident.officialDomain || null,
      entityRef: { kind: 'youtube_channel', channelId: res.channelId || null },
      extractedValue: {
        summaryKind: 'social_videos', videoCount: videos.length,
        channelId: res.channelId || null, matchReasons: res.matchReasons || [],
        measurementMethod: 'public_source_observation', partialScan: partial,
      },
      parserVersion: YT_ADAPTER_VERSION,
      note: 'YouTube Data API v3 public content (per-response snapshots, key redacted)',
      sourceUrl: res.sourceUrl || null,
    };
  },

  async collect(ctx) {
    const comp = ctx.competitor || {};
    const trigger = ctx.trigger === 'schedule' ? 'schedule' : 'manual';
    const suppress = !!ctx.suppressTerminal;
    const opened = suppress ? { deduped: false, attemptId: ctx.attemptId } : openAttempt(ctx, 'youtube_content');
    if (opened.deduped) return { deduped: true, attempt: opened.attempt };
    ctx.attemptId = opened.attemptId;
    const ident = this.resolveIdentity({ url: comp.url, isShopify: comp.isShopify });
    try { if (!suppress) recordIdentity(ctx, ident, 'unconfirmed', [], []); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; }

    const key = String(process.env.YOUTUBE_API_KEY || '').trim();
    if (!key) {
      return failAttempt(ctx, { ok: false, error: 'CONFIG_MISSING' }, { errorUserText: '数据服务暂不可用，请稍后再试。' });
    }
    const API = 'https://www.googleapis.com/youtube/v3';
    const snapshotIds = [];
    const brand = { name: comp.name, url: comp.url };
    // 1) 官方 search 端点发现候选频道（同属 YouTube Data API；发现与采集同一凭据链路）
    const find = await fetchApiJson({
      url: API + '/search?part=snippet&type=channel&maxResults=5&q=' + encodeURIComponent(String(comp.name || '')) + '&key=' + encodeURIComponent(key),
      tenantId: ctx.tenantId, capability: 'youtube_content', provider: 'youtube_data_api_v3',
      secretParams: ['key'], trigger,
    });
    if (!find.ok) return failAttempt(ctx, find, { errorUserText: find.errorUserText });
    { const chk = ProviderResponse.youtubeOk(find.json); if (!chk.ok) return failFromProviderCheck(ctx, chk); }
    if (find.snapshotId) snapshotIds.push(find.snapshotId);
    const candItems = (find.json && find.json.items) || [];
    // 2) 可解释的归属校验：匹配依据记录；不确定 → identity 保持 unresolved（不升级）
    let chosen = null, chosenReasons = [];
    for (const it of candItems) {
      const sn = it.snippet || {};
      const reasons = this.matchEvidence(sn, brand);
      if (reasons.length && !chosen) { chosen = it; chosenReasons = reasons; }
    }
    const emptyRes = { ok: true, videos: [], comments: [], snapshotIds, channelTitle: null, channelId: null, matchReasons: [], partialScan: false, sourceUrl: 'https://www.googleapis.com/youtube/v3/search' };
    if (!chosen) {
      // 无可归属频道：成功的「零观察」（≠ 失败 ≠ 未接入；任务书 §二.A.6）
      const out = this.normalize(emptyRes, ctx);
      if (suppress) return { providerOk: true, ident, raw: emptyRes, out };
      let fin;
      try { fin = await finalizeOutput(ctx, emptyRes, out); }
      catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; throw e; }
      if (fin.invalid || fin.evidenceFailed) return fin;
      return Object.assign(fin, { sourceUrl: out.sourceUrl, entityKey: out.entityKey, emptyWindow: true });
    }
    const channelId = chosen.id && chosen.id.channelId;
    const channelTitle = (chosen.snippet && chosen.snippet.title) || null;
    // 3) 频道公开信息 + 最近公开视频（真实失败状态：权限不足/配额耗尽/不可达各自分类）
    const chan = await fetchApiJson({
      url: API + '/channels?part=snippet,statistics&id=' + encodeURIComponent(String(channelId || '')) + '&key=' + encodeURIComponent(key),
      tenantId: ctx.tenantId, capability: 'youtube_content', provider: 'youtube_data_api_v3', secretParams: ['key'], trigger,
    });
    if (!chan.ok) return failAttempt(ctx, chan, { errorUserText: chan.errorUserText });
    { const chk = ProviderResponse.youtubeOk(chan.json); if (!chk.ok) return failFromProviderCheck(ctx, chk); }
    if (chan.snapshotId) snapshotIds.push(chan.snapshotId);
    const vidsSearch = await fetchApiJson({
      url: API + '/search?part=snippet&type=video&order=date&maxResults=10&channelId=' + encodeURIComponent(String(channelId || '')) + '&key=' + encodeURIComponent(key),
      tenantId: ctx.tenantId, capability: 'youtube_content', provider: 'youtube_data_api_v3', secretParams: ['key'], trigger,
    });
    if (!vidsSearch.ok) return failAttempt(ctx, vidsSearch, { errorUserText: vidsSearch.errorUserText });
    { const chk = ProviderResponse.youtubeOk(vidsSearch.json); if (!chk.ok) return failFromProviderCheck(ctx, chk); }
    if (vidsSearch.snapshotId) snapshotIds.push(vidsSearch.snapshotId);
    const vidIds = ((vidsSearch.json && vidsSearch.json.items) || []).map(v => v.id && v.id.videoId).filter(Boolean).slice(0, 10);
    let stats = { items: [] };
    if (vidIds.length) {
      const det = await fetchApiJson({
        url: API + '/videos?part=snippet,statistics&id=' + encodeURIComponent(vidIds.join(',')) + '&key=' + encodeURIComponent(key),
        tenantId: ctx.tenantId, capability: 'youtube_content', provider: 'youtube_data_api_v3', secretParams: ['key'], trigger,
      });
      if (!det.ok) return failAttempt(ctx, det, { errorUserText: det.errorUserText });
    { const chk = ProviderResponse.youtubeOk(det.json); if (!chk.ok) return failFromProviderCheck(ctx, chk); }
      if (det.snapshotId) snapshotIds.push(det.snapshotId);
      stats = det.json || { items: [] };
    }
    const videos = (stats.items || []).map(v => ({
      videoId: v.id,
      title: (v.snippet && v.snippet.title) || null,
      publishedAt: (v.snippet && v.snippet.publishedAt) || null,
      thumbnailUrl: (v.snippet && v.snippet.thumbnails && (v.snippet.thumbnails.medium || v.snippet.thumbnails.default) && (v.snippet.thumbnails.medium || v.snippet.thumbnails.default).url) || null,
      viewCount: v.statistics && v.statistics.viewCount != null ? Number(v.statistics.viewCount) : null,
      likeCount: v.statistics && v.statistics.likeCount != null ? Number(v.statistics.likeCount) : null,
      commentCount: v.statistics && v.statistics.commentCount != null ? Number(v.statistics.commentCount) : null,
      videoUrl: v.id ? 'https://www.youtube.com/watch?v=' + v.id : null,
    }));
    // 4) 可公开获取的评论摘要（首个视频一条线程页；失败不致命——评论属可选公开字段）
    let comments = [];
    if (vidIds.length) {
      const ct = await fetchApiJson({
        url: API + '/commentThreads?part=snippet&maxResults=5&videoId=' + encodeURIComponent(String(vidIds[0])) + '&key=' + encodeURIComponent(key),
        tenantId: ctx.tenantId, capability: 'youtube_content', provider: 'youtube_data_api_v3', secretParams: ['key'], trigger,
      });
      if (ct.ok && ct.snapshotId) snapshotIds.push(ct.snapshotId);
      const ctChk = ct.ok ? ProviderResponse.youtubeOk(ct.json) : { ok: false };
      if (ct.ok && ctChk.ok && Array.isArray(ct.json.items)) {
        comments = ct.json.items.map(i => {
          const top = i.snippet && i.snippet.topLevelComment && i.snippet.topLevelComment.snippet;
          return { text: (top && top.textDisplay) || '', videoId: vidIds[0], sourceUrl: vidIds[0] ? 'https://www.youtube.com/watch?v=' + vidIds[0] : null };
        }).filter(c => c.text);
      }
    }
    const res = {
      ok: true, videos, comments, snapshotIds,
      channelId, channelTitle, matchReasons: chosenReasons,
      partialScan: false,
      sourceUrl: 'https://www.googleapis.com/youtube/v3/search?q=' + encodeURIComponent(String(comp.name || '')) + '&type=channel',
    };
    const out = this.normalize(res, ctx);
    if (suppress) return { providerOk: true, ident, raw: res, out };
    let fin;
    try { fin = await finalizeOutput(ctx, res, out); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; throw e; }
    if (fin.invalid || fin.evidenceFailed) return fin;
    // 归属校验有据（频道名/简介匹配）→ 允许 resolved；无据保持 unresolved
    try { recordIdentity(ctx, ident, chosenReasons.length ? 'success' : 'unconfirmed', fin.attempt.evidenceIds, fin.attempt.snapshotIds); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: fin.attempt }; }
    return Object.assign(fin, { sourceUrl: out.sourceUrl, entityKey: out.entityKey });
  },

  health() {
    return { ok: true, adapter: this.code, version: this.version, checkedAt: new Date().toISOString(), configured: !!String(process.env.YOUTUBE_API_KEY || '').trim() };
  },
};

// DataForSEO Labs Trends（官方 REST 契约；Basic auth；licensed_estimate）
const dataforseoAdapter = {
  code: 'dataforseo',
  displayName: '搜索与热度（DataForSEO Trends）',
  version: DFS_ADAPTER_VERSION,
  summaryKinds: ['trend_series'],

  supports(brandCtx) {
    return Registry.supportsForBrand('dataforseo_trends', brandCtx);
  },

  resolveIdentity(brandCtx) {
    const b = brandCtx || {};
    const d = Net.domainOf(b.url || '');
    return {
      platform: 'dataforseo',
      officialDomain: d || null,
      platformAccountId: d || null,
      identityStatus: 'unresolved',
      originNote: null,
      resolverVersion: DFS_ADAPTER_VERSION,
    };
  },

  // 趋势点观察 + trend_series 摘要（每个结果标 licensed_estimate，不做平台原始事实表述）
  normalize(raw, ctx) {
    const res = raw || {};
    const ident = this.resolveIdentity({ url: ctx.competitor && ctx.competitor.url });
    const points = (Array.isArray(res.points) ? res.points : []).slice(0, SurfaceStore.OBSERVATION_CAP).map(p => ({
      id: String(p.id || ''),
      title: String(p.label || '').slice(0, 120),
      price: null, currency: null,
      available: true,
      publishedAt: p.periodEnd || null,
      periodStart: p.periodStart || null, periodEnd: p.periodEnd || null,
      value: typeof p.value === 'number' ? p.value : null,
      region: p.region || null,
    }));
    const partial = !!res.partialScan;
    return {
      capability: 'dataforseo_trends', dimension: 'search_interest',
      outcome: partial ? 'partial' : 'success',
      observations: points,
      summary: {
        kind: 'trend_series',
        pointCount: points.length,
        keyword: res.keyword || null,
        region: res.region || null,
        measurementMethod: 'licensed_estimate',
        periodStart: res.periodStart || null, periodEnd: res.periodEnd || null,
        providerRecordId: res.providerRecordId || null,
        methodologyVersion: DFS_ADAPTER_VERSION,
        partialScan: partial, partialScanReason: partial ? (res.partialScanReason || null) : null,
      },
      snapshotIds: (res.snapshotIds || []).slice(), evidenceSnapshotIds: (res.snapshotIds || []).slice(),
      currency: null, currencySnapshotId: null, currencyStatus: 'unknown',
      identityStatus: 'unresolved',
      evidenceSource: 'dataforseo', evidenceProvider: 'dataforseo_labs_trends',
      claimField: 'search.trend', claimScope: 'licensed_estimate_series',
      entityKey: ident.officialDomain || (ctx.competitor && ctx.competitor.url) || null,
      entityRef: { kind: 'keyword_series', keyword: res.keyword || null },
      extractedValue: {
        summaryKind: 'trend_series', pointCount: points.length, keyword: res.keyword || null,
        measurementMethod: 'licensed_estimate', providerRecordId: res.providerRecordId || null,
        partialScan: partial,
      },
      parserVersion: DFS_ADAPTER_VERSION,
      note: 'DataForSEO Labs Trends (licensed estimate; per-response snapshots; Basic auth never persisted)',
      sourceUrl: res.sourceUrl || null,
    };
  },

  async collect(ctx) {
    const comp = ctx.competitor || {};
    const trigger = ctx.trigger === 'schedule' ? 'schedule' : 'manual';
    const suppress = !!ctx.suppressTerminal;
    const opened = suppress ? { deduped: false, attemptId: ctx.attemptId } : openAttempt(ctx, 'dataforseo_trends');
    if (opened.deduped) return { deduped: true, attempt: opened.attempt };
    ctx.attemptId = opened.attemptId;
    const ident = this.resolveIdentity({ url: comp.url });
    try { if (!suppress) recordIdentity(ctx, ident, 'unconfirmed', [], []); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; }

    const login = String(process.env.DATAFORSEO_LOGIN || '').trim();
    const password = String(process.env.DATAFORSEO_PASSWORD || '').trim();
    if (!login || !password) {
      return failAttempt(ctx, { ok: false, error: 'CONFIG_MISSING' }, { errorUserText: '数据服务暂不可用，请稍后再试。' });
    }
    const keyword = String(comp.name || '').trim();
    if (!keyword) return failAttempt(ctx, { ok: false, error: 'not_applicable' }, { errorUserText: '该品牌缺少可用于趋势查询的名称。' });
    const auth = Buffer.from(login + ':' + password).toString('base64');
    const periodEnd = new Date();
    const periodStart = new Date(Date.now() - 90 * 86400000);
    const body = JSON.stringify([{
      keywords: [keyword],
      location_name: 'United States',
      language_name: 'English',
      date_from: periodStart.toISOString().slice(0, 10),
      date_to: periodEnd.toISOString().slice(0, 10),
    }]);
    const r = await fetchApiJson({
      url: 'https://api.dataforseo.com/v3/dataforseo_labs/google/trends/explore/live',
      method: 'POST', headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' }, body,
      tenantId: ctx.tenantId, capability: 'dataforseo_trends', provider: 'dataforseo_labs_trends', trigger,
    });
    if (!r.ok) return failAttempt(ctx, r, { errorUserText: r.errorUserText });
    { const chk = ProviderResponse.dataforseoOk(r.json); if (!chk.ok) return failFromProviderCheck(ctx, chk); }
    // 只采信服务实际返回的字段：trend points（时间/值/地区）——结构按官方契约容错解析
    const tasks = (r.json && r.json.tasks) || [];
    const t0 = tasks[0] || {};
    const result0 = (Array.isArray(t0.result) && t0.result[0]) || {};
    const items = (result0.items && (result0.items.items || result0.items)) || [];
    const flat = [];
    for (const it of (Array.isArray(items) ? items : [])) {
      const kwData = it.items || it.trend_items || [];
      for (const p of (Array.isArray(kwData) ? kwData : [])) {
        flat.push({
          id: String(p.date || (p.period_end_date || p.timestamp || flat.length)),
          label: keyword,
          periodStart: p.date_from || p.period_start_date || null,
          periodEnd: p.date_to || p.period_end_date || p.date || null,
          value: typeof p.value === 'number' ? p.value : (p.values && Array.isArray(p.values) ? p.values[p.values.length - 1] : null),
          region: result0.location_name || 'United States',
        });
      }
    }
    const res = {
      ok: true, points: flat, snapshotIds: r.snapshotId ? [r.snapshotId] : [],
      keyword, region: result0.location_name || 'United States',
      periodStart: periodStart.toISOString().slice(0, 10), periodEnd: periodEnd.toISOString().slice(0, 10),
      providerRecordId: (t0.id ? String(t0.id) : (r.json && r.json.cost != null ? 'cost_' + r.json.cost : null)) || null,
      partialScan: flat.length === 0 && tasks.length === 0 ? false : false,
      sourceUrl: 'https://app.dataforseo.com/' ,
    };
    const out = this.normalize(res, ctx);
    if (suppress) return { providerOk: true, ident, raw: res, out };
    let fin;
    try { fin = await finalizeOutput(ctx, res, out); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; throw e; }
    if (fin.invalid || fin.evidenceFailed) return fin;
    try { recordIdentity(ctx, ident, 'success', fin.attempt.evidenceIds, fin.attempt.snapshotIds); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: fin.attempt }; }
    return Object.assign(fin, { sourceUrl: out.sourceUrl, entityKey: out.entityKey });
  },

  health() {
    return { ok: true, adapter: this.code, version: this.version, checkedAt: new Date().toISOString(), configured: !!String(process.env.DATAFORSEO_LOGIN || '').trim() && !!String(process.env.DATAFORSEO_PASSWORD || '').trim() };
  },
};

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

// P0-3 整改 r2：TikTok 官方 OAuth client_credentials token 流程。
// client key/secret 只用于官方规定的 token 获取（POST /v2/oauth/token/），
// 绝不把 client key 当 access token；token 仅内存缓存 + 受控请求头使用，
// 绝不进入 URL、快照、日志、错误或前端。token 获取请求不落快照（非数据采集）。
const tiktokTokenCache = { token: null, expiresAt: 0 };
async function getTikTokAccessToken(clientKey, clientSecret) {
  const now = Date.now();
  if (tiktokTokenCache.token && now < tiktokTokenCache.expiresAt - 60000) return { ok: true, token: tiktokTokenCache.token };
  const OAUTH_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
  try { await Net.assertPublicUrl(OAUTH_URL); } catch (e) {
    return { ok: false, error: 'internal_error', errorUserText: '请求地址未通过安全校验，已阻止。' };
  }
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_key: clientKey, client_secret: clientSecret }).toString();
  let res = null;
  try {
    res = await Net.safeRequestOnce(OAUTH_URL, { timeoutMs: 15000, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/SAFE_FETCH_TIMEOUT/.test(msg)) return { ok: false, error: 'timeout', errorUserText: '数据服务响应超时，稍后可重试。' };
    return { ok: false, error: 'unavailable', errorUserText: '数据服务暂时无法访问，稍后可重试。' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, error: 'auth_rejected', status: res.status, errorUserText: WAVE1_FAILURE_TEXT.auth_rejected };
  if (res.status === 429) return { ok: false, error: 'quota_exhausted', status: res.status, errorUserText: WAVE1_FAILURE_TEXT.quota_exhausted };
  if (!(res.status >= 200 && res.status < 300)) return { ok: false, error: 'unavailable', status: res.status, errorUserText: '数据服务暂不可用，请稍后再试。' };
  let json = null;
  try { json = JSON.parse(res.buffer.toString('utf8')); } catch (e) { return { ok: false, error: 'parse_failed', status: res.status, errorUserText: '数据服务返回了无法解析的内容，已保留原始数据待修复。' }; }
  const token = json && (json.access_token || (json.data && json.data.access_token));
  if (!token) {
    // 官方错误响应（error/code 字段）：权限不足等 → 如实 auth_rejected，不伪装无结果
    return { ok: false, error: 'auth_rejected', status: 403, errorUserText: WAVE1_FAILURE_TEXT.auth_rejected };
  }
  tiktokTokenCache.token = String(token);
  const expiresIn = Number(json.expires_in) > 0 ? Number(json.expires_in) * 1000 : 3600 * 1000;
  tiktokTokenCache.expiresAt = now + expiresIn;
  return { ok: true, token: tiktokTokenCache.token };
}

// TikTok 商业内容研究接口（官方 Business API 契约骨架 + 真实配置验证）。
// 纪律：凭据真实可用并完成一次真实 staging 请求拿到可展示公开记录前，
// capability 保持 pending_config；未获官方研究权限时运行态停在
// ready_to_verify / auth_rejected（source-readiness 管理），不标 operational、
// 不写成「未观察到广告」。
const tiktokAdapter = {
  code: 'tiktok',
  displayName: '广告活动（TikTok 商业内容）',
  version: TT_ADAPTER_VERSION,
  summaryKinds: ['ad_creatives'],

  supports(brandCtx) {
    return Registry.supportsForBrand('tiktok_commercial_content', brandCtx);
  },

  resolveIdentity(brandCtx) {
    const b = brandCtx || {};
    const d = Net.domainOf(b.url || '');
    return {
      platform: 'tiktok',
      officialDomain: d || null,
      platformAccountId: null,
      identityStatus: 'unresolved',
      originNote: null,
      resolverVersion: TT_ADAPTER_VERSION,
    };
  },

  // 广告素材观察（P0-3 整改 r3：平台公开披露 official_disclosure；R4.14：字段与覆盖事实对齐）。
  // 只映射官方响应真实字段（11 项白名单，见 lib/tiktok-adlib.js）：
  // ad.{id,first_shown_date,last_shown_date,status,status_statement,videos,image_urls,reach}、
  // advertiser.{business_id,business_name,paid_for_by}；ad_name/download_url/数值 reach 等一律不预设。
  // status_statement 仅在官方实际返回非空字符串时映射，缺失即 null（不补猜、不占位）。
  normalize(raw, ctx) {
    const res = raw || {};
    const ident = this.resolveIdentity({ url: ctx.competitor && ctx.competitor.url });
    const creatives = (Array.isArray(res.creatives) ? res.creatives : []).slice(0, SurfaceStore.OBSERVATION_CAP).map(c => ({
      id: String(c.id || ''),
      title: String(c.advertiser || '').slice(0, 80),
      price: null, currency: null, // 🔴 广告花费不可观测，恒 null（00 §17 冻结）
      available: c.status === 'active',
      publishedAt: c.firstShownDate || null,
      advertiser: c.advertiser || null,
      region: c.region || null,
      creativeUrl: c.creativeUrl || null,
      reach: c.reachLabel || null, // 官方 reach.unique_user_seen 区间标签（"11K"），非数值推算
      lastShownDate: c.lastShownDate || null,
      status: c.status || null,
      statusStatement: c.statusStatement || null,
    }));
    const partial = !!res.partialScan;
    const countryScope = res.countryScope || 'ALL';
    const coverage = TikTokAdLib.marketCoverage(res.brandMarket);
    const coverageState = res.coverageState || coverage.coverageState;
    // 市场标识一律用归一后的 ISO2（调用方传 'us'/'美国' 也统一成 'US'）；
    // 归一不出来（区域词/空值）→ null，不把原文当国家写进投影。
    const brandMarket = coverage.brandMarket;
    return {
      capability: 'tiktok_commercial_content', dimension: 'ad_campaigns',
      outcome: partial ? 'partial' : 'success',
      observations: creatives,
      summary: {
        kind: 'ad_creatives',
        creativeCount: creatives.length,
        measurementMethod: 'official_disclosure', // 平台公开披露，非数据服务估算
        periodStart: res.periodStart || null, periodEnd: res.periodEnd || null,
        countryScope,
        // 覆盖事实（用户投影）：数量从唯一事实源派生，禁止在此写死数字
        coverageCountryCount: TT_COUNTRY_COUNT,
        coverageScope: TikTokAdLib.COVERAGE_SCOPE_TEXT,
        coverageState, // covered | out_of_coverage | unknown
        brandMarket,
        brandMarketCovered: coverage.brandMarketCovered,
        coverageNote: TikTokAdLib.coverageNoteFor(coverageState, brandMarket),
        providerRecordId: res.providerRecordId || null,
        methodologyVersion: TT_ADAPTER_VERSION,
        partialScan: partial, partialScanReason: partial ? (res.partialScanReason || null) : null,
      },
      snapshotIds: (res.snapshotIds || []).slice(), evidenceSnapshotIds: (res.snapshotIds || []).slice(),
      currency: null, currencySnapshotId: null, currencyStatus: 'unknown',
      identityStatus: 'unresolved',
      evidenceSource: 'tiktok', evidenceProvider: 'tiktok_research_api',
      claimField: 'ads.public_creatives', claimScope: 'official_commercial_content_disclosure',
      entityKey: ident.officialDomain || (ctx.competitor && ctx.competitor.url) || null,
      entityRef: { kind: 'ad_creatives', keyword: ctx.competitor ? (ctx.competitor.name || null) : null },
      extractedValue: {
        summaryKind: 'ad_creatives', creativeCount: creatives.length,
        measurementMethod: 'official_disclosure', partialScan: partial, countryScope,
        coverageCountryCount: TT_COUNTRY_COUNT, coverageState, brandMarket,
      },
      parserVersion: TT_ADAPTER_VERSION,
      note: 'TikTok Commercial Content API（平台公开披露）｜覆盖范围受官方支持国家限制：' + TT_SUPPORTED_COUNTRIES.join('/') + '（共 ' + TT_COUNTRY_COUNT + ' 国，不含美国）；client key/secret/access token 均不落快照',
      sourceUrl: res.sourceUrl || null,
    };
  },

  async collect(ctx) {
    const comp = ctx.competitor || {};
    const trigger = ctx.trigger === 'schedule' ? 'schedule' : 'manual';
    const suppress = !!ctx.suppressTerminal;
    const opened = suppress ? { deduped: false, attemptId: ctx.attemptId } : openAttempt(ctx, 'tiktok_commercial_content');
    if (opened.deduped) return { deduped: true, attempt: opened.attempt };
    ctx.attemptId = opened.attemptId;
    const ident = this.resolveIdentity({ url: comp.url });
    try { if (!suppress) recordIdentity(ctx, ident, 'unconfirmed', [], []); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; }

    const clientKey = String(process.env.TIKTOK_CLIENT_KEY || '').trim();
    const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || '').trim();
    if (!clientKey || !clientSecret) {
      return failAttempt(ctx, { ok: false, error: 'CONFIG_MISSING' }, { errorUserText: '数据服务暂不可用，请稍后再试。' });
    }
    // P0-3 整改 r2：官方 OAuth client_credentials 换 access token（client key/secret 只用于本步）
    const tk = await getTikTokAccessToken(clientKey, clientSecret);
    if (!tk.ok) {
      return failAttempt(ctx, { ok: false, error: tk.error, status: tk.status }, { errorUserText: tk.errorUserText });
    }
    // P0-2 整改 r3：官方 Query Ads 契约（2026-10-19 核实 developers.tiktok.com/doc/commercial-content-api-query-ads）
    //   POST /v2/research/adlib/ad/query/?fields=<白名单>
    //   Authorization: Bearer <token>；Content-Type: application/json
    //   body: { filters: { ad_published_date_range: { min, max } }, search_term, max_count, search_id? }
    // 规范：min 必须晚于 2022-10-01（YYYYMMDD）。
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = (d) => '' + d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate());
    const nowD = new Date(Date.now() - 86400000); // 上一日（官方数据有滞后）
    const startD = new Date(Math.max(nowD.getTime() - 90 * 86400000, Date.UTC(2022, 9, 2))); // 2022-10-02 起
    const periodStart = ymd(startD);
    const periodEnd = ymd(nowD);
    const searchTerm = String(comp.name || '').trim().slice(0, 50);
    if (!searchTerm) {
      return failAttempt(ctx, { ok: false, error: 'not_applicable' }, { errorUserText: '该品牌缺少可用于广告查询的名称。' });
    }
    const snapshotIds = [];
    async function queryPage(searchId) {
      const bodyObj = {
        filters: { ad_published_date_range: { min: periodStart, max: periodEnd } },
        search_term: searchTerm,
        max_count: 20,
      };
      if (searchId) bodyObj.search_id = searchId;
      return fetchApiJson({
        url: TT_AD_ENDPOINT + '?fields=' + encodeURIComponent(TT_AD_FIELDS),
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tk.token, 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
        secretParams: ['access_token', 'token'],
        tenantId: ctx.tenantId, capability: 'tiktok_commercial_content', provider: 'tiktok_research_api', trigger,
      });
    }
    const r1 = await queryPage(null);
    if (!r1.ok) return failAttempt(ctx, r1, { errorUserText: r1.errorUserText });
    if (r1.snapshotId) snapshotIds.push(r1.snapshotId);
    // P0-4 整改 r3：HTTP 200 + 业务错误对象绝不进成功链（error.code 必须 'ok' 且 data.ads 为数组）
    const chk1 = ProviderResponse.tiktokOk(r1.json);
    if (!chk1.ok) return failFromProviderCheck(ctx, chk1);
    let rawAds = chk1.ads.slice();
    let searchId = chk1.searchId;
    let hasMore = chk1.hasMore;
    // 分页：最多再取 1 页（search_id 续查同一搜索缓存）；失败不致命但如实标 partial
    let pagingPartial = false;
    if (hasMore && searchId) {
      const r2 = await queryPage(searchId);
      if (r2.ok) {
        const chk2 = ProviderResponse.tiktokOk(r2.json);
        if (chk2.ok) { rawAds = rawAds.concat(chk2.ads); searchId = chk2.searchId || searchId; hasMore = chk2.hasMore; if (r2.snapshotId) snapshotIds.push(r2.snapshotId); }
        else pagingPartial = true;
      } else pagingPartial = true;
    }
    // 官方真实响应字段映射（不预设 ad_name/download_url 等不存在字段）
    const creatives = rawAds.map((item, i) => {
      const ad = (item && item.ad) || {};
      const adv = (item && item.advertiser) || {};
      const vids = Array.isArray(ad.videos) ? ad.videos : [];
      const imgs = Array.isArray(ad.image_urls) ? ad.image_urls : [];
      const reach = ad.reach && typeof ad.reach === 'object' ? ad.reach : null;
      return {
        id: ad.id != null ? String(ad.id) : String(i),
        firstShownDate: ad.first_shown_date != null ? String(ad.first_shown_date) : null,
        lastShownDate: ad.last_shown_date != null ? String(ad.last_shown_date) : null,
        status: ad.status != null ? String(ad.status) : null,
        // 官方白名单第 5 项：状态说明（审核/下线原因）。仅当实际返回非空字符串时映射。
        statusStatement: (typeof ad.status_statement === 'string' && ad.status_statement.trim())
          ? ad.status_statement.trim().slice(0, 200) : null,
        advertiser: adv.business_name != null ? String(adv.business_name) : null,
        businessId: adv.business_id != null ? String(adv.business_id) : null,
        paidForBy: adv.paid_for_by != null ? String(adv.paid_for_by) : null,
        creativeUrl: imgs[0] || (vids[0] && vids[0].url) || null,
        videoUrls: vids.map(v => v && v.url).filter(Boolean).slice(0, 3),
        reachLabel: reach && reach.unique_user_seen != null ? String(reach.unique_user_seen) : null,
        region: null, // 单次查询未按国家拆分；countryScope 记录在摘要
      };
    });
    // R4.14 覆盖范围事实：品牌主要市场是否落在官方支持国家内。
    // 不在覆盖内时 summary.coverageState=out_of_coverage，用户侧显示「该公开来源当前无覆盖」，
    // 绝不把官方覆盖缺失显示成「没有广告」。
    const coverage = TikTokAdLib.marketCoverage(comp.market);
    const res = {
      ok: true, creatives, snapshotIds,
      periodStart, periodEnd,
      countryScope: 'ALL（官方支持国家范围）',
      brandMarket: coverage.brandMarket,
      coverageState: coverage.coverageState,
      providerRecordId: searchId ? String(searchId) : null,
      partialScan: pagingPartial, partialScanReason: pagingPartial ? '后续分页请求失败，仅保留首页结果' : null,
      sourceUrl: TT_AD_ENDPOINT,
    };
    const out = this.normalize(res, ctx);
    if (suppress) return { providerOk: true, ident, raw: res, out };
    let fin;
    try { fin = await finalizeOutput(ctx, res, out); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; throw e; }
    if (fin.invalid || fin.evidenceFailed) return fin;
    try { recordIdentity(ctx, ident, 'success', fin.attempt.evidenceIds, fin.attempt.snapshotIds); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: fin.attempt }; }
    return Object.assign(fin, { sourceUrl: out.sourceUrl, entityKey: out.entityKey });
  },

  health() {
    return { ok: true, adapter: this.code, version: this.version, checkedAt: new Date().toISOString(), configured: !!String(process.env.TIKTOK_CLIENT_KEY || '').trim() && !!String(process.env.TIKTOK_CLIENT_SECRET || '').trim() };
  },
};

const reviewsAdapter = {
  code: 'reviews',
  displayName: '口碑与评论（公开页面）',
  version: REV_ADAPTER_VERSION,
  summaryKinds: ['reviews_digest'],

  supports(brandCtx) {
    return Registry.supportsForBrand('public_reviews', brandCtx);
  },

  resolveIdentity(brandCtx) {
    const b = brandCtx || {};
    const d = Net.domainOf(b.url || '');
    return {
      platform: 'public_web',
      officialDomain: d || null,
      platformAccountId: d || null,
      identityStatus: 'unresolved',
      originNote: null,
      resolverVersion: REV_ADAPTER_VERSION,
    };
  },

  // 页面级评论观察（片段/评分/来源 URL）+ reviews_digest 摘要（样本量/时间范围/来源数）
  normalize(raw, ctx) {
    const res = raw || {};
    const ident = this.resolveIdentity({ url: ctx.competitor && ctx.competitor.url });
    const pages = (Array.isArray(res.pages) ? res.pages : []).slice(0, SurfaceStore.OBSERVATION_CAP).map(p => ({
      id: String(p.pageId || p.url || ''),
      title: String(p.title || '').slice(0, 120),
      price: null, currency: null,
      available: true,
      publishedAt: p.publishedAt || p.fetchedAt || null,
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviewCount: typeof p.reviewCount === 'number' ? p.reviewCount : null,
      snippet: p.snippet ? String(p.snippet).slice(0, 200) : null,
      sourceUrl: p.url || null,
    }));
    const partial = !!res.partialScan;
    const totalReviews = pages.reduce((s, p) => s + (p.reviewCount || 0), 0);
    return {
      capability: 'public_reviews', dimension: 'reviews_reputation',
      outcome: partial ? 'partial' : 'success',
      observations: pages,
      summary: {
        kind: 'reviews_digest',
        reviewCount: totalReviews,
        sourceCount: pages.length,
        measurementMethod: 'public_source_observation',
        periodStart: res.periodStart || null, periodEnd: res.periodEnd || null,
        methodologyVersion: REV_ADAPTER_VERSION,
        sampleNote: '样本为本次采集窗口内通过校验的公开页面，不等于全网口碑',
        partialScan: partial, partialScanReason: partial ? (res.partialScanReason || null) : null,
      },
      snapshotIds: (res.snapshotIds || []).slice(), evidenceSnapshotIds: (res.snapshotIds || []).slice(),
      currency: null, currencySnapshotId: null, currencyStatus: 'unknown',
      identityStatus: 'unresolved',
      evidenceSource: 'public_web', evidenceProvider: 'public_web_reviews',
      claimField: 'reviews.public_pages', claimScope: 'public_page_reviews_observation',
      entityKey: ident.officialDomain || (ctx.competitor && ctx.competitor.url) || null,
      entityRef: { kind: 'review_pages', domain: ident.officialDomain || null },
      extractedValue: {
        summaryKind: 'reviews_digest', reviewCount: totalReviews, sourceCount: pages.length,
        measurementMethod: 'public_source_observation', partialScan: partial,
      },
      parserVersion: REV_ADAPTER_VERSION,
      note: 'public review pages (robots-respecting fetch; per-page raw snapshots)',
      sourceUrl: res.sourceUrl || null,
    };
  },

  async collect(ctx) {
    const comp = ctx.competitor || {};
    const trigger = ctx.trigger === 'schedule' ? 'schedule' : 'manual';
    const suppress = !!ctx.suppressTerminal;
    const opened = suppress ? { deduped: false, attemptId: ctx.attemptId } : openAttempt(ctx, 'public_reviews');
    if (opened.deduped) return { deduped: true, attempt: opened.attempt };
    ctx.attemptId = opened.attemptId;
    const ident = this.resolveIdentity({ url: comp.url });
    try { if (!suppress) recordIdentity(ctx, ident, 'unconfirmed', [], []); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; }

    // 候选发现复用系统搜索链（Serper/Tavily/Brave/Bocha fanout；配置缺失=真实失败状态）
    const Search = require('../research/search.js');
    const cfg = require('../core/config.js').loadConfig();
    const searchReady = Search.providerConfigured(cfg, Search.providerMain(cfg)) || ['serper', 'brave', 'bocha', 'tavily'].some(n => Search.providerConfigured(cfg, n));
    if (!searchReady) {
      return failAttempt(ctx, { ok: false, error: 'CONFIG_MISSING' }, { errorUserText: '数据服务暂不可用，请稍后再试。' });
    }
    const brand = String(comp.name || '').trim();
    const domain = Net.domainOf(comp.url || '');
    let candidates = [];
    try {
      const r = await Search.fanoutSearch(
        [brand + ' reviews', brand + ' customer reviews ratings', (domain ? domain + ' reviews' : brand + ' reviews site:trustpilot.com OR site:reddit.com')].filter(Boolean),
        cfg, 'us', 'reviews'
      );
      candidates = (r && r.results || []).map(x => ({ url: x.url || x.link, title: x.title || null })).filter(c => c.url).slice(0, 5);
    } catch (e) {
      return failAttempt(ctx, { ok: false, error: 'unavailable', errorUserText: '候选评论页发现失败，稍后可重试。' });
    }
    if (!candidates.length) {
      // 采集窗口无可归属公开评论页：成功零观察（≠ 失败 ≠ 未接入）
      const res = { ok: true, pages: [], snapshotIds: [], partialScan: false, periodStart: null, periodEnd: null, sourceUrl: null };
      const out = this.normalize(res, ctx);
      if (suppress) return { providerOk: true, ident, raw: res, out };
      let fin;
      try { fin = await finalizeOutput(ctx, res, out); }
      catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; throw e; }
      if (fin.invalid || fin.evidenceFailed) return fin;
      return Object.assign(fin, { sourceUrl: out.sourceUrl, entityKey: out.entityKey, emptyWindow: true });
    }
    // 逐页抓取：FetchGate/robots/SSRF 全合规（Net.fetchPage）；品牌归属粗校验（标题/URL 含品牌名或域名）
    const pages = []; const snapshotIds = [];
    for (const c of candidates) {
      const fr = await Net.fetchPage(c.url, 15000, { trigger, tenantId: ctx.tenantId });
      if (!fr || fr.ok !== true) continue; // robots 禁止/失败页不入库（不伪装成功）
      if (fr.snapshotId) snapshotIds.push(fr.snapshotId);
      let text = '';
      try { text = Net.stripHtml(fr.html || '').slice(0, 800); } catch (e) { text = String(fr.html || '').slice(0, 800); }
      const urlL = String(c.url).toLowerCase(); const titleL = String(c.title || '').toLowerCase(); const brandL = brand.toLowerCase();
      const related = (domain && urlL.includes(domain)) || (brandL && (urlL.includes(brandL) || titleL.includes(brandL)));
      if (!related) continue; // 归属校验不过 → 不入库（identity 保持 unresolved）
      // 评分抽取：schema.org aggregateRating（JSON-LD）→ meta → 评分模式（可信度递减）
      let rating = null, reviewCount = null;
      try {
        const lds = String(fr.html || '').match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) || [];
        for (const ld of lds) {
          try {
            const j = JSON.parse(ld.replace(/<script type="application\/ld\+json">|<\/script>/g, ''));
            const node = (j['@graph'] || [j]).find(n => n.aggregateRating || n.review) || j;
            if (node.aggregateRating) {
              rating = typeof node.aggregateRating.ratingValue === 'number' ? node.aggregateRating.ratingValue : Number(node.aggregateRating.ratingValue) || null;
              reviewCount = Number(node.aggregateRating.reviewCount || node.aggregateRating.ratingCount) || null;
              break;
            }
          } catch (e2) { /* 单个 JSON-LD 解析失败跳过 */ }
        }
      } catch (e) { /* 抽取失败保持 null */ }
      pages.push({
        pageId: c.url, url: c.url, title: c.title || (text.slice(0, 60)),
        rating, reviewCount, snippet: text.slice(0, 200), fetchedAt: new Date().toISOString(),
      });
    }
    const res = {
      ok: true, pages, snapshotIds, partialScan: false,
      periodStart: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
      periodEnd: new Date().toISOString().slice(0, 10),
      sourceUrl: pages.length ? pages[0].url : null,
    };
    const out = this.normalize(res, ctx);
    if (suppress) return { providerOk: true, ident, raw: res, out };
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

// ============================================================
// SC-06 二：通用官网公开资料 adapter（非 Shopify 目录接口）
// ------------------------------------------------------------
// 只采集公开页面真实出现的内容（canonical/标题/简介/OG/JSON-LD
// Organization）；网络全部经 Net.fetchPage（SSRF/DNS rebinding/
// FetchGate/robots/逐跳重定向校验/快照落账）。失败如实登记，
// 不从文案或结构猜测销量、GMV、转化、广告花费或用户画像。
// ============================================================
const OSITE_VERSION = 'official-site-1';

const officialSiteProfileAdapter = {
  code: 'official_site_profile',
  displayName: '官网资料（公开页面）',
  version: OSITE_VERSION,
  summaryKinds: ['official_site_profile'],

  supports(brandCtx) {
    return Registry.supportsForBrand('official_site_profile', brandCtx);
  },

  resolveIdentity(brandCtx) {
    const b = brandCtx || {};
    const d = Net.domainOf(b.url || '');
    return {
      platform: 'public_web',
      officialDomain: d || null,
      platformAccountId: d || null,
      identityStatus: 'unresolved',
      originNote: null,
      resolverVersion: OSITE_VERSION,
    };
  },

  normalize(raw, ctx) {
    const res = raw || {};
    const ident = this.resolveIdentity({ url: ctx.competitor && ctx.competitor.url });
    const prof = res.profile || {};
    const canonical = prof.canonical || null;
    const observations = [{
      id: 'official_site_profile',
      title: prof.siteName || prof.title || null,
      price: null, currency: null, available: true,
      publishedAt: null,
      snippet: prof.brandIntro ? String(prof.brandIntro).slice(0, 200) : null,
      sourceUrl: canonical,
    }];
    return {
      capability: 'official_site_profile', dimension: 'website_products',
      outcome: 'success',
      observations,
      summary: {
        kind: 'official_site_profile',
        canonical: canonical,
        siteName: prof.siteName || null,
        pageTitle: prof.title || null,
        brandIntro: prof.brandIntro || null,
        hasOpenGraph: !!(prof.og && (prof.og.title || prof.og.description || prof.og.siteName)),
        hasOrganization: !!(prof.organization && prof.organization.name),
        organizationName: prof.organization ? prof.organization.name : null,
        sameAsCount: prof.organization && Array.isArray(prof.organization.sameAs) ? prof.organization.sameAs.length : 0,
        measurementMethod: 'public_source_observation',
        methodologyVersion: OSITE_VERSION,
        parserVersion: prof.parserVersion || SITE_PROFILE_PARSER_VERSION,
      },
      snapshotIds: (res.snapshotIds || []).slice(), evidenceSnapshotIds: (res.snapshotIds || []).slice(),
      currency: null, currencySnapshotId: null, currencyStatus: 'unknown',
      identityStatus: 'unresolved',
      evidenceSource: 'public_web', evidenceProvider: 'public_site_profile_fetch',
      claimField: 'site.profile', claimScope: 'public_site_profile_observation',
      entityKey: ident.officialDomain || (ctx.competitor && ctx.competitor.url) || null,
      entityRef: { kind: 'official_site', domain: ident.officialDomain || null },
      extractedValue: {
        summaryKind: 'official_site_profile',
        canonical, siteName: prof.siteName || null,
        hasOrganization: !!(prof.organization && prof.organization.name),
      },
      parserVersion: OSITE_VERSION,
      note: 'official site public profile (robots-respecting fetch; raw homepage snapshot)',
      sourceUrl: canonical,
    };
  },

  async collect(ctx) {
    const comp = ctx.competitor || {};
    const trigger = ctx.trigger === 'schedule' ? 'schedule' : 'manual';
    const suppress = !!ctx.suppressTerminal;
    const opened = suppress ? { deduped: false, attemptId: ctx.attemptId } : openAttempt(ctx, 'official_site_profile');
    if (opened.deduped) return { deduped: true, attempt: opened.attempt };
    ctx.attemptId = opened.attemptId;
    const ident = this.resolveIdentity({ url: comp.url });
    try { if (!suppress) recordIdentity(ctx, ident, 'unconfirmed', [], []); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; }
    if (!comp.url) return failAttempt(ctx, { ok: false, error: 'not_applicable' }, { errorUserText: '该品牌没有可采集的官网地址。' });

    // 首页抓取：SSRF/FetchGate/robots/重定向全在 Net.fetchPage 内强制执行
    const fr = await Net.fetchPage(comp.url, 15000, { trigger, tenantId: ctx.tenantId, includeHtml: true });
    if (!fr || fr.ok !== true) {
      const cls = AdaptersClassify(fr);
      return failAttempt(ctx, { ok: false, error: fr && fr.error || 'unavailable', snapshotId: fr && fr.snapshotId },
        { errorUserText: cls === 'blocked' ? '对方官网拒绝了本次访问。' : '来源暂不可达，稍后可重试。' });
    }
    const snapshotIds = [];
    if (fr.snapshotId) snapshotIds.push(fr.snapshotId);
    const profile = SiteProfile.parseSiteProfile(fr.html || '', fr.url || comp.url);
    if (!profile.observed.hasTitle && !profile.observed.hasCanonical && !profile.observed.hasIntro) {
      // 页面取到但没有任何可解析的公开资料：诚实空结果（非失败）
      const res = { ok: true, profile: { parserVersion: profile.parserVersion, canonical: null, title: null, siteName: null, brandIntro: null, og: {}, organization: null, products: [], observed: profile.observed }, snapshotIds, sourceUrl: fr.url || null };
      const out = this.normalize(res, ctx);
      if (suppress) return { providerOk: true, ident, raw: res, out };
      let fin;
      try { fin = await finalizeOutput(ctx, res, out); }
      catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; throw e; }
      if (fin.invalid || fin.evidenceFailed) return fin;
      return Object.assign(fin, { sourceUrl: out.sourceUrl, entityKey: out.entityKey, emptyWindow: true });
    }
    const res = { ok: true, profile, snapshotIds, sourceUrl: profile.canonical || fr.url || null };
    const out = this.normalize(res, ctx);
    if (suppress) return { providerOk: true, ident, raw: res, out };
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

// SC-06 二：公开商品页发现（非目录接口）。发现路径依次：
//   ① 首页 JSON-LD Product；② robots 声明的 sitemap（含 1 层 index 展开）；
//   ③ 首页内链商品 URL。商品页只读取 JSON-LD 公开的名称/价格/币种/评分。
const officialSiteProductsAdapter = {
  code: 'official_site_products',
  displayName: '官网公开商品（非目录接口）',
  version: OSITE_VERSION,
  summaryKinds: ['official_site_products'],

  supports(brandCtx) {
    return Registry.supportsForBrand('public_site_products', brandCtx);
  },

  resolveIdentity(brandCtx) {
    const b = brandCtx || {};
    const d = Net.domainOf(b.url || '');
    return {
      platform: 'public_web',
      officialDomain: d || null,
      platformAccountId: d || null,
      identityStatus: 'unresolved',
      originNote: null,
      resolverVersion: OSITE_VERSION,
    };
  },

  normalize(raw, ctx) {
    const res = raw || {};
    const ident = this.resolveIdentity({ url: ctx.competitor && ctx.competitor.url });
    const products = (Array.isArray(res.products) ? res.products : []).slice(0, SurfaceStore.OBSERVATION_CAP).map(p => ({
      id: String(p.url || p.name || ''),
      title: String(p.name || '').slice(0, 120),
      price: typeof p.price === 'number' ? p.price : null,
      currency: p.currency || null,
      available: p.availability ? !/outofstock|soldout|discontinued/i.test(p.availability) : true,
      publishedAt: null,
      rating: typeof p.rating === 'number' ? p.rating : null,
      reviewCount: typeof p.reviewCount === 'number' ? p.reviewCount : null,
      snippet: null,
      sourceUrl: p.url || null,
    }));
    const partial = !!res.partialScan;
    return {
      capability: 'public_site_products', dimension: 'website_products',
      outcome: partial ? 'partial' : 'success',
      observations: products,
      summary: {
        kind: 'official_site_products',
        productCount: products.length,
        priceObservedCount: products.filter(p => p.price != null).length,
        currencies: res.currencies || [],
        ratingObservedCount: products.filter(p => p.rating != null).length,
        discoveryPath: res.discoveryPath || null, // 'jsonld' | 'sitemap' | 'homepage_links' | null
        urlCandidatesFound: res.urlCandidatesFound != null ? res.urlCandidatesFound : null,
        measurementMethod: 'public_source_observation',
        methodologyVersion: OSITE_VERSION,
        sampleNote: '样本为公开页面可安全识别的商品（发现路径受限），非全量商品清单，不推断销量',
        partialScan: partial, partialScanReason: partial ? (res.partialScanReason || null) : null,
      },
      snapshotIds: (res.snapshotIds || []).slice(), evidenceSnapshotIds: (res.snapshotIds || []).slice(),
      currency: (res.currencies && res.currencies.length === 1) ? res.currencies[0] : null,
      currencySnapshotId: null, currencyStatus: (res.currencies && res.currencies.length === 1) ? 'confirmed' : 'unknown',
      identityStatus: 'unresolved',
      evidenceSource: 'public_web', evidenceProvider: 'public_site_products_fetch',
      claimField: 'site.products', claimScope: 'public_site_products_observation',
      entityKey: ident.officialDomain || (ctx.competitor && ctx.competitor.url) || null,
      entityRef: { kind: 'official_site_products', domain: ident.officialDomain || null },
      extractedValue: {
        summaryKind: 'official_site_products',
        productCount: products.length,
        priceObservedCount: products.filter(p => p.price != null).length,
        discoveryPath: res.discoveryPath || null,
      },
      parserVersion: OSITE_VERSION,
      note: 'public product pages (robots-respecting fetch; per-page raw snapshots)',
      sourceUrl: res.sourceUrl || null,
    };
  },

  async collect(ctx) {
    const comp = ctx.competitor || {};
    const trigger = ctx.trigger === 'schedule' ? 'schedule' : 'manual';
    const suppress = !!ctx.suppressTerminal;
    const opened = suppress ? { deduped: false, attemptId: ctx.attemptId } : openAttempt(ctx, 'public_site_products');
    if (opened.deduped) return { deduped: true, attempt: opened.attempt };
    ctx.attemptId = opened.attemptId;
    const ident = this.resolveIdentity({ url: comp.url });
    try { if (!suppress) recordIdentity(ctx, ident, 'unconfirmed', [], []); }
    catch (e) { if (e && e.fenced) return { deduped: false, fenced: true, attempt: null }; }
    if (!comp.url) return failAttempt(ctx, { ok: false, error: 'not_applicable' }, { errorUserText: '该品牌没有可采集的官网地址。' });

    const snapshotIds = [];
    const fetchOpts = { trigger, tenantId: ctx.tenantId, includeHtml: true };
    const home = await Net.fetchPage(comp.url, 15000, fetchOpts);
    if (!home || home.ok !== true) {
      return failAttempt(ctx, { ok: false, error: home && home.error || 'unavailable', snapshotId: home && home.snapshotId },
        { errorUserText: '来源暂不可达，稍后可重试。' });
    }
    if (home.snapshotId) snapshotIds.push(home.snapshotId);
    const homeProfile = SiteProfile.parseSiteProfile(home.html || '', home.url || comp.url);
    let products = homeProfile.products.slice();
    let discoveryPath = products.length ? 'jsonld' : null;
    let urlCandidatesFound = products.length;
    let partialScan = false; let partialScanReason = null;

    // ② robots sitemap 路径：首页商品不足时展开（robots + sitemap 各限 1 跳 index + 1 个子文件）
    if (products.length < 3) {
      const robotsUrl = new URL('/robots.txt', home.url || comp.url).toString();
      const rb = await Net.fetchPage(robotsUrl, 10000, { trigger, tenantId: ctx.tenantId });
      if (rb && rb.ok === true) {
        if (rb.snapshotId) snapshotIds.push(rb.snapshotId);
        const smUrls = SiteProfile.parseSitemapsFromRobots(rb.htmlLower || rb.text || '');
        if (smUrls.length) {
          let sm = await Net.fetchPage(smUrls[0], 15000, fetchOpts);
          if (sm && sm.ok === true) {
            if (sm.snapshotId) snapshotIds.push(sm.snapshotId);
            let locs = SiteProfile.parseSitemapLocs(sm.html || '');
            // sitemap index：按序展开子 sitemap 直到发现商品 URL（上限 8 个子文件，
            // 防爬取面失控——多区域站点的首个子文件常是无关区域语言区）
            let urls = SiteProfile.sampleProductUrls(locs);
            if (!urls.length) {
              // 并发抓取子 sitemap（上限 8，抓取面与串行一致；FetchGate 同域节流仍生效），
              // 取首个发现商品 URL 的子文件——多区域站点子文件顺序无关商品分布
              const subIdxs = locs.filter(u => /\.xml$/i.test(u)).slice(0, 8);
              const results = await Promise.all(subIdxs.map(async u => {
                const r = await Net.fetchPage(u, 15000, fetchOpts);
                if (r && r.ok === true) return { u, html: r.html, snapshotId: r.snapshotId };
                return null;
              }));
              for (const r of results) {
                if (!r) continue;
                if (r.snapshotId) snapshotIds.push(r.snapshotId);
                if (!urls.length) urls = SiteProfile.sampleProductUrls(SiteProfile.parseSitemapLocs(r.html || ''));
              }
            }
            urlCandidatesFound = Math.max(urlCandidatesFound, urls.length);
            if (urls.length) {
              discoveryPath = discoveryPath || 'sitemap';
              // 逐页抓取上限 12：公开观察抽样（样本明示），不是全量枚举
              for (const u of urls.slice(0, 12)) {
                const pr = await Net.fetchPage(u, 12000, fetchOpts);
                if (!pr || pr.ok !== true) { partialScan = true; partialScanReason = partialScanReason || 'some_product_pages_unreachable'; continue; }
                if (pr.snapshotId) snapshotIds.push(pr.snapshotId);
                const pp = SiteProfile.parseSiteProfile(pr.html || '', pr.url || u);
                for (const p of pp.products) {
                  if (!products.some(x => (x.url || x.name) === (p.url || p.name))) products.push(p);
                }
              }
              if (urls.length > 12) { partialScan = true; partialScanReason = 'product_url_sample_limited'; }
            }
          }
        }
      }
    }

    const currencies = Array.from(new Set(products.map(p => p.currency).filter(Boolean)));
    const res = {
      ok: true, products, snapshotIds,
      currencies,
      discoveryPath, urlCandidatesFound,
      partialScan: products.length === 0 ? false : partialScan,
      partialScanReason: products.length === 0 ? null : partialScanReason,
      sourceUrl: home.url || comp.url,
    };
    const out = this.normalize(res, ctx);
    if (suppress) return { providerOk: true, ident, raw: res, out };
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

const ADAPTERS = Object.freeze({
  shopify: shopifyAdapter, shopify_collections: shopifyCollectionsAdapter,
  youtube: youtubeAdapter, dataforseo: dataforseoAdapter,
  tiktok: tiktokAdapter, reviews: reviewsAdapter,
  official_site_profile: officialSiteProfileAdapter,
  official_site_products: officialSiteProductsAdapter,
});

module.exports = {
  CATALOG_ADAPTER_VERSION, COLLECTIONS_ADAPTER_VERSION,
  ADAPTERS, ADAPTER_METHODS, SUMMARY_KINDS, ADAPTER_STRATEGIES, OUTCOMES,
  getAdapter, listAdapters, validateAdapter, validateOutput, assertAdaptersIntegrity,
  redactSecretParams, SENSITIVE_QUERY_KEYS, fetchApiJson,
  resolveAdapterChain, classifyFetchFailure, summarize, summarizeObservations, assertFence,
  runProviderOutput, commitProviderTerminal, finalizeOutput, commitProviderEmpty, FAILURE_TEXT,
};
