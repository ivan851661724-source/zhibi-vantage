'use strict';
// SC-04 真实数据面 r2：数据源就绪状态服务（P0-2）。
// 职责：把「实现状态」（Registry maturity：pending_config = 代码实现完成、
// 尚未生产验证）与「运行状态」（本服务的 readiness）分离：
//   not_configured   系统级凭据未配置（管理员可配；用户侧只显示「数据服务暂不可用」）
//   ready_to_verify  凭据齐备、尚无一次真实成功验证
//   operational      已有真实成功验证记录（provider verification 持久化，不含密钥）
//   auth_rejected    最近一次真实尝试被拒（凭据无效/权限不足）
//   quota_exhausted  最近一次真实尝试配额耗尽
//   unavailable      最近一次真实尝试来源不可达/超时
// 规则：
// - 不通过人工改 Registry 把 capability 标成 ga 绕过验证；operational 只能由真实成功产生。
// - verification 记录绝不包含密钥值；source_url 一律已脱敏。
// - 用户侧文案只有四种（任务书 r2 §P0-2）；技术细节仅管理员健康接口可见（不显示密钥值）。
const SurfaceStore = require('./surface-store.js');
const Registry = require('./capability-registry.js');

const READINESS_STATES = Object.freeze([
  'not_configured', 'ready_to_verify', 'operational',
  'auth_rejected', 'quota_exhausted', 'unavailable',
]);

// 用户侧文案（普通用户页面只允许出现这四种口径；不得出现环境变量名/key 名）
const USER_TEXT = Object.freeze({
  not_configured: '数据服务暂不可用。',
  ready_to_verify: '正在验证数据服务。',
  operational: '',
  auth_rejected: '最近采集失败，可稍后重试。',
  quota_exhausted: '最近采集失败，可稍后重试。',
  unavailable: '数据服务暂不可用，可稍后重试。',
  no_results: '本轮未观察到结果。',
});

let _tableReady = false;
function ensureTable() {
  if (_tableReady) return;
  const db = SurfaceStore.getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS provider_verifications (
    id TEXT PRIMARY KEY,
    capability TEXT NOT NULL,
    provider TEXT NOT NULL,
    status TEXT NOT NULL,
    failure_class TEXT,
    source_url TEXT,
    tenant_id TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pv_cap ON provider_verifications(capability, created_at)`);
  _tableReady = true;
}

function rid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function configState(cap) {
  const keys = Array.isArray(cap.configKeys) ? cap.configKeys : [];
  const present = {};
  let missing = [];
  for (const k of keys) {
    const v = String(process.env[k] || '').trim();
    present[k] = !!v;
    if (!v) missing.push(k);
  }
  return { keys, present, missing };
}

// 最近一次失败分类（verification failed 记录优先，collection_attempts 真实失败兜底）
function lastFailure(capabilityCode) {
  ensureTable();
  const db = SurfaceStore.getDb();
  const row = db.prepare(
    `SELECT status, failure_class, created_at FROM provider_verifications
     WHERE capability = ? AND status = 'failed' ORDER BY created_at DESC LIMIT 1`
  ).get(capabilityCode);
  if (row) return { failureClass: row.failure_class || 'unavailable', at: row.created_at };
  const at = db.prepare(
    `SELECT error_class, ended_at FROM collection_attempts
     WHERE capability = ? AND status = 'failed' AND error_class IS NOT NULL
       AND error_class NOT IN ('config_missing')
     ORDER BY ended_at DESC LIMIT 1`
  ).get(capabilityCode);
  if (at && at.error_class) return { failureClass: at.error_class, at: at.ended_at };
  return null;
}

function lastSuccess(capabilityCode) {
  ensureTable();
  const db = SurfaceStore.getDb();
  return db.prepare(
    `SELECT provider, source_url, created_at FROM provider_verifications
     WHERE capability = ? AND status = 'success' ORDER BY created_at DESC LIMIT 1`
  ).get(capabilityCode) || null;
}

// 就绪状态计算（实时；不缓存——凭据与验证记录变化即时生效）
function getReadiness(capabilityCode) {
  ensureTable();
  const cap = Registry.getCapability(capabilityCode);
  if (!cap) return { state: 'unavailable', userText: USER_TEXT.unavailable, reason: 'capability_not_found' };
  const cfg = configState(cap);
  if (cfg.missing.length) {
    return {
      state: 'not_configured', userText: USER_TEXT.not_configured,
      configKeys: cfg.keys, configKeysPresent: cfg.present,
      reason: 'system_credentials_missing',
    };
  }
  // 无凭据需求的公开来源（如 Shopify 公开目录）：恒可运行
  if (!cfg.keys.length) {
    return { state: 'operational', userText: '', provider: cap.provider, configKeys: [], configKeysPresent: {} };
  }
  const ok = lastSuccess(capabilityCode);
  if (ok) {
    return {
      state: 'operational', userText: '',
      lastVerifiedAt: ok.created_at, provider: ok.provider,
      configKeys: cfg.keys, configKeysPresent: cfg.present,
    };
  }
  const fail = lastFailure(capabilityCode);
  if (fail) {
    const state = fail.failureClass === 'auth_rejected' ? 'auth_rejected'
      : fail.failureClass === 'quota_exhausted' || fail.failureClass === 'rate_limited' ? 'quota_exhausted'
        : 'unavailable';
    return {
      state, userText: USER_TEXT[state], lastFailureClass: fail.failureClass, lastFailureAt: fail.at,
      configKeys: cfg.keys, configKeysPresent: cfg.present,
    };
  }
  return {
    state: 'ready_to_verify', userText: USER_TEXT.ready_to_verify,
    configKeys: cfg.keys, configKeysPresent: cfg.present,
  };
}

// 记录真实尝试结果（只存脱敏 URL 与分类，绝不存密钥/token）
function recordVerification({ capability, provider, status, failureClass, sourceUrl, tenantId }) {
  ensureTable();
  const db = SurfaceStore.getDb();
  const row = {
    id: rid('pv'), capability: String(capability || ''), provider: String(provider || ''),
    status: status === 'success' ? 'success' : 'failed',
    failureClass: status === 'success' ? null : String(failureClass || 'unavailable'),
    sourceUrl: sourceUrl ? String(sourceUrl).slice(0, 500) : null,
    tenantId: tenantId || null,
    createdAt: new Date().toISOString(),
  };
  db.prepare(`INSERT INTO provider_verifications (id, capability, provider, status, failure_class, source_url, tenant_id, created_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(row.id, row.capability, row.provider, row.status, row.failureClass, row.sourceUrl, row.tenantId, row.createdAt);
  return row;
}

// 管理员健康视图（不显示密钥值，只显示配置存在性 + 状态 + 最近验证/失败）
function adminView() {
  const caps = Registry.listCapabilities().filter(c => c.maturity === 'ga' || c.maturity === 'pending_config');
  return caps.map(c => {
    const r = getReadiness(c.code);
    return {
      capability: c.code,
      displayName: c.displayName,
      dimension: c.dimension,
      maturity: c.maturity,
      readiness: r.state,
      lastVerifiedAt: r.lastVerifiedAt || null,
      lastFailureClass: r.lastFailureClass || null,
      lastFailureAt: r.lastFailureAt || null,
      configKeys: (r.configKeys || []).map(k => ({ name: k, present: !!(r.configKeysPresent && r.configKeysPresent[k]) })),
    };
  });
}

module.exports = {
  READINESS_STATES, USER_TEXT,
  getReadiness, recordVerification, adminView, configState,
};
