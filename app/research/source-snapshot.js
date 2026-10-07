'use strict';
// ============================================================
// research/source-snapshot.js —— M0-01 SourceSnapshot Foundation
// 证据级原始采集留痕：metadata(.json) → raw_payload_ref → 不可变 blob(.raw)
//
// 规格锚点（/spec，版本锁定）：
//   00 v1.2 §1.6/§5/§7/§38/§42/§51/§54/§56
//   05 v0.3 §10/§11（SourceStatus 八态冻结字面量，逐字使用）/§13
//   03 v0.3 §16（保留数值；物理 resolver 归 03/07）
//
// 硬规则：
//   · append-only：同 id 重复 record 直接拒绝；模块无任何 update/mutate 导出
//   · observed_at = 来源内容被真实观察到的时刻；blocked/timeout/rate_limited/
//     内容 retrieval 前的 internal_error 必须 null（绝不用 fetched_at 冒充）
//   · 租户：显式参数 > ALS(getTenantCtx) > 皆缺 → 拒绝落盘 + 运营告警；
//     不存在 _legacy 共享命名空间
//   · collector_version ≠ parser_version：快照层 parser 未运行，不伪造 parser_version
//   · content_hash 基于「解析/规范化之前的原始响应字节」
//   · P0-3（PR#2 评审）：不产业务 Coverage 语义——raw_truncated 只是 raw 存储截断标记，
//     timeout/blocked 等无 body 观察绝不因此宣称"完整"；采集扫描完整性走 scan 字段，
//     一等 Coverage 对象归后续 Coverage 票
//   · P1-2（PR#2 评审）：raw blob 独占创建（wx）——竞态/孤儿场景绝不静默覆盖既有文件
// ============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA } = require('../core/paths.js');
const { sanitizeNs } = require('../core/state-store.js');
const als = require('../core/als.js');
const logger = require('../services/logger.js');

const COLLECTOR_VERSION = 'net-1';
const SCHEMA_VERSION = 1;
// 03 v0.3 §16 Raw Snapshot 默认保留策略（入库时刻初始分类；后续 Evidence/Judgment/
// Challenge 引用导致的升级走外部 retention reference/index，绝不改写本 JSON —— Snapshot 不可变）：
//   P0 / Evidence-bearing：90 天 hot + 冷归档至 365 天
//   P1/P2 非 Evidence-bearing：30 天 hot + 冷归档至 90 天
// 05 v0.3 §1 Capability Map：product_catalog / evidence_url 均为 P0 能力（终审 P0 修正：
// 不得把全部 SourceSnapshot 一律归 P1 档）
const RETENTION_BY_TIER = {
  P0: { tier: 'P0', evidence_bearing: false, hot_days: 90, archive_days: 365 },
  P1: { tier: 'P1', evidence_bearing: false, hot_days: 30, archive_days: 90 },
};
const TIER_BY_CAPABILITY = { product_catalog: 'P0', evidence_url: 'P0' };
function initialRetention(capability) {
  return RETENTION_BY_TIER[TIER_BY_CAPABILITY[capability] || 'P1'] || RETENTION_BY_TIER.P1;
}

// 05 v0.3 §11 冻结字面量（禁别名）
const SOURCE_STATUS = Object.freeze({
  SUCCESS: 'success',
  PARTIAL: 'partial',
  UNAVAILABLE: 'unavailable',
  BLOCKED: 'blocked',
  RATE_LIMITED: 'rate_limited',
  PARSE_FAILED: 'parse_failed',
  TIMEOUT: 'timeout',
  INTERNAL_ERROR: 'internal_error',
});
const VALID_STATUS = new Set(Object.values(SOURCE_STATUS));

// 运营上限（OQ-1 维持 OPEN）：可配置，非冻结产品规则。超出截断存储 + raw_truncated=true，
// content_hash/raw_size 仍按完整原始字节计，截断时不得宣称完整可重放。
function maxBytes() {
  const n = parseInt(process.env.ZB_SNAPSHOT_MAX_BYTES, 10);
  return Number.isFinite(n) && n > 0 ? n : 2097152;
}

// HTTP 状态 → 05 §11 字面量（无响应走 classifyError）
function mapHttpStatus(status) {
  const s = Number(status);
  if (s === 429) return SOURCE_STATUS.RATE_LIMITED;
  if (s === 401 || s === 403 || s === 407) return SOURCE_STATUS.BLOCKED;
  return SOURCE_STATUS.UNAVAILABLE;
}

// 异常 → 05 §11 字面量（内容 retrieval 前的失败，observed_at 一律 null）
function classifyError(err) {
  const msg = String((err && err.message) || err || '');
  if (msg.indexOf('SSRF_BLOCKED') === 0) return { source_status: SOURCE_STATUS.BLOCKED, error_code: msg };
  if ((err && err.name === 'AbortError') || /aborted|timeout/i.test(msg)) return { source_status: SOURCE_STATUS.TIMEOUT, error_code: 'abort:timeout' };
  return { source_status: SOURCE_STATUS.INTERNAL_ERROR, error_code: msg.slice(0, 200) || 'internal_error' };
}

function dayDirOf(iso) { return String(iso || '').slice(0, 10).replace(/-/g, ''); }
function rand6() { return crypto.randomBytes(3).toString('hex'); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// 解析租户：显式参数 > ALS > null（不落 _legacy）
function resolveTenantId(explicit) {
  if (explicit) return String(explicit);
  const ctx = als.getTenantCtx();
  return ctx ? String(ctx) : null;
}

function metaPathOf(ns, day, id) { return path.join(DATA, 'snapshots', ns, day, id + '.json'); }
function blobPathOf(ns, day, id) { return path.join(DATA, 'snapshots', ns, day, id + '.raw'); }

// 唯一写入口（append-only）。返回 { recorded:true, meta } 或 { recorded:false, reason }。
// 抛错仅用于调用方传参违例（如非法 source_status 字面量）；存储 IO 失败由调用方按
// 「可见运营错误 + 业务不受影响」处理（修正 9 兼容规则）。
function record(input) {
  const status = input.source_status;
  if (!VALID_STATUS.has(status)) throw new Error('source-snapshot: invalid source_status literal: ' + String(status));

  const tenantId = resolveTenantId(input.tenantId);
  if (!tenantId) {
    // 修正 3：拒绝落盘，绝不写共享命名空间；运营可见告警
    logger.warn('source_snapshot_skip', { reason: 'no_tenant_context', url: input.source_url || null, trigger: input.trigger || null });
    return { recorded: false, reason: 'no_tenant_context' };
  }

  const nowIso = new Date().toISOString();
  const fetchedAt = input.fetched_at || nowIso;
  const collectedAt = nowIso;
  // 修正 1：observed_at 仅在来源内容被真实观察时有值；调用方不传即 null
  const observedAt = input.observed_at || null;

  const body = Buffer.isBuffer(input.bodyBytes) && input.bodyBytes.length ? input.bodyBytes : null;
  let contentHash = null;
  let rawSize = 0;
  let store = null;
  let truncated = false;
  if (body) {
    contentHash = 'sha256:' + sha256(body);   // 原始字节指纹（截断前）
    rawSize = body.length;                     // 原始字节长度（截断前）
    const cap = maxBytes();
    if (body.length > cap) { store = body.subarray(0, cap); truncated = true; }
    else store = body;
  }

  const id = input.snapshot_id || ('ss_' + String(input.capability) + '_' + Date.now() + '_' + rand6());
  const ns = sanitizeNs(tenantId);             // 仅文件系统实现细节，非领域身份
  const day = dayDirOf(fetchedAt);
  const dir = path.join(DATA, 'snapshots', ns, day);
  const mPath = metaPathOf(ns, day, id);

  if (fs.existsSync(mPath)) throw new Error('source-snapshot: snapshot exists, append-only violation: ' + id); // 00 §56

  fs.mkdirSync(dir, { recursive: true });
  let relRef = null;
  let refByteSize = 0;
  let createdBlobPath = null;                // 本次调用创建的 blob（终审 P1：meta 失败时仅回滚它）
  if (store) {
    const bPath = blobPathOf(ns, day, id);
    // P1-2：独占创建（wx）——目标已存在（竞态/孤儿）时显式失败，绝不静默覆盖既有 raw
    try { fs.writeFileSync(bPath, store, { flag: 'wx' }); createdBlobPath = bPath; }
    catch (e) { throw new Error('source-snapshot: raw blob write failed (exclusive-create, no overwrite): ' + (e.code || e.message) + ' :: ' + id); }
    relRef = path.relative(DATA, bPath).replace(/\\/g, '/');
    refByteSize = store.length;
  }

  const meta = {
    snapshot_id: id,
    schema_version: SCHEMA_VERSION,
    capability: input.capability,
    provider: input.provider,
    source_url: input.source_url || null,
    final_url: input.final_url || null,
    redirect_hops: input.redirect_hops || 0,
    http_status: input.http_status == null ? null : Number(input.http_status),
    source_status: status,
    error_code: input.error_code || null,
    observed_at: observedAt,
    fetched_at: fetchedAt,
    collected_at: collectedAt,
    source_updated_at: input.source_updated_at || null,
    cache_served_at: null,                     // 快照层恒 null：缓存命中不产新快照（05 §13）
    content_hash: contentHash,
    content_type: input.contentType || null,
    raw_payload_ref: store ? { kind: 'fs_blob', path: relRef, byte_size: refByteSize, encoding: 'identity' } : null,
    raw_size: rawSize,
    raw_truncated: truncated,
    collector_version: COLLECTOR_VERSION,
    trigger: input.trigger || 'enrich',
    tenant: { tenant_id: tenantId, project_ref: input.projectRef || null, brand_hint: input.brandHint || null },
    call_ledger_id: null,                      // ExternalCallLedger 并行 track 预留（正交，OQ-3）
    // P0-3：无 coverage 字段。raw_truncated/raw_size/raw_payload_ref 仅描述 raw 存储属性，
    // 与业务 Coverage 正交；一等 Coverage 对象归后续 Coverage 票。
    // P0 终审（PR#2 二审）：partial_scan 为 05 v0.3 §5.2/§19.6 冻结术语（目录枚举不完整
    // 必须标 true），不得另造 scan.complete 等平行词汇；reason/count 为补充说明，
    // null = 该维度不适用（如 evidence_url 单页观察）。
    partial_scan: input.partial_scan == null ? null : Boolean(input.partial_scan),
    partial_scan_reason: input.partial_scan_reason || null,
    partial_scan_observed_count: input.partial_scan_observed_count == null ? null : Number(input.partial_scan_observed_count),
    note: input.note || null,
    retention: (() => {
      const ret = initialRetention(input.capability);
      return {
        tier: ret.tier,
        evidence_bearing: ret.evidence_bearing,
        hot_until: new Date(Date.now() + ret.hot_days * 86400e3).toISOString(),
        archive_until: new Date(Date.now() + ret.archive_days * 86400e3).toISOString(),
      };
    })(),
  };

  // P1 终审（PR#2 二审）：meta 写失败 → 显式抛错 + 只回滚本次调用创建的 blob；
  // 绝不删除任何既有文件（append-only 语义保持），不落「有 blob 无 meta」的孤儿
  try {
    fs.writeFileSync(mPath, JSON.stringify(meta, null, 1), { flag: 'wx' });
  } catch (e) {
    if (createdBlobPath) { try { fs.unlinkSync(createdBlobPath); } catch (_) {} }
    throw new Error('source-snapshot: metadata write failed, created raw blob rolled back: ' + (e.code || e.message) + ' :: ' + id);
  }
  return { recorded: true, meta };
}

// 按 id 读回元数据：ns 下按日目录扫描（M0 量级：每租户每天两位数，可接受）
function getById(tenantId, snapshotId) {
  const ns = sanitizeNs(tenantId);
  const root = path.join(DATA, 'snapshots', ns);
  if (!fs.existsSync(root)) return null;
  for (const day of fs.readdirSync(root)) {
    const mPath = path.join(root, day, String(snapshotId) + '.json');
    if (fs.existsSync(mPath)) {
      try { return JSON.parse(fs.readFileSync(mPath, 'utf8')); } catch (e) { return null; }
    }
  }
  return null;
}

// 经 raw_payload_ref 读回原始字节；截断快照返回的是截断后存储字节（调用方看 raw_truncated）
function readRawPayload(meta) {
  if (!meta || !meta.raw_payload_ref || !meta.raw_payload_ref.path) return null;
  const p = path.join(DATA, meta.raw_payload_ref.path);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
}

// 缓存命中装饰（修正 2）：不产新快照；原始溯源原样透传，只推进 cache_served_at。
// legacy 缓存条目（无 _prov）如实透传，不伪造 id/时间。
function decorateCacheHit(hit) {
  if (!hit || !hit._prov || !hit._prov.source_snapshot_id) return hit;
  return Object.assign({}, hit, { _prov: Object.assign({}, hit._prov, { cache_served_at: new Date().toISOString() }) });
}

module.exports = { COLLECTOR_VERSION, SCHEMA_VERSION, SOURCE_STATUS, mapHttpStatus, classifyError, maxBytes, record, getById, readRawPayload, decorateCacheHit };
