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
// 03 §16 非 Evidence-bearing 档（入库时刻初始分类；后续 Evidence 引用导致的
// 升级走外部 retention reference/index，绝不改写本 JSON —— Snapshot 不可变）
const RETENTION_INITIAL = { tier: 'P1', evidence_bearing: false, hot_days: 30, archive_days: 90 };

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
  if (store) {
    const bPath = blobPathOf(ns, day, id);
    fs.writeFileSync(bPath, store);            // 新文件一次性写，无覆盖路径
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
    coverage: { complete: truncated ? false : true, partial_scan: false, note: input.note || null },
    retention: {
      tier: RETENTION_INITIAL.tier,
      evidence_bearing: RETENTION_INITIAL.evidence_bearing,
      hot_until: new Date(Date.now() + RETENTION_INITIAL.hot_days * 86400e3).toISOString(),
      archive_until: new Date(Date.now() + RETENTION_INITIAL.archive_days * 86400e3).toISOString(),
    },
  };

  fs.writeFileSync(mPath, JSON.stringify(meta, null, 1));
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
