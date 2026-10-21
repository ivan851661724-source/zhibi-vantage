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
const UrlRedact = require('../lib/url-redact.js');

const READINESS_STATES = Object.freeze([
  'not_configured', 'ready_to_verify', 'operational',
  'auth_rejected', 'quota_exhausted', 'unavailable',
]);

// 用户侧文案（普通用户页面只允许出现这四种口径；不得出现环境变量名/key 名）
const USER_TEXT = Object.freeze({
  not_configured: '数据服务暂不可用。',
  ready_to_verify: '正在验证数据服务。',
  // SC-06 r2：公开来源（无需凭据）尚无一次真实成功采集时的诚实口径——
  // 不写「正在验证」（并非进行中），更不写「已采集/已接通」
  ready_to_verify_public: '该数据来源尚未完成真实采集验证，暂不展示数据。',
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

// 🔴 SC-07 §1：凭据来源有两处——环境变量 与 运行配置文件（app/data/config.json，
// 落盘加密、内存解密）。此前只读 process.env，导致「配置写在配置文件里」的部署被判未配置。
// 搜索类凭据还可能来自配置文件里的 search.serperKey / serperKeys / tavilyKey / apiKey /
// braveKey / bochaKey——与 ENV 名一一对应。
const ENV_TO_SEARCH_PROVIDER = Object.freeze({
  SERPER_API_KEY: 'serper',
  TAVILY_API_KEY: 'tavily',
  BRAVE_API_KEY: 'brave',
  BOCHA_API_KEY: 'bocha',
});

let _cfgCache = { at: 0, cfg: null };
function runtimeConfig() {
  // 配置文件改动后 10s 内生效即可（readiness 本身实时调用，缓存只为避免每次读盘解密）
  const now = Date.now();
  if (_cfgCache.cfg && now - _cfgCache.at < 10000) return _cfgCache.cfg;
  let cfg = null;
  try { cfg = require('../core/config.js').loadConfig(); } catch (e) { cfg = null; }
  _cfgCache = { at: now, cfg };
  return cfg;
}

function searchProviderReady(providerName) {
  try {
    const Search = require('../research/search.js');
    return !!Search.providerConfigured(runtimeConfig(), providerName);
  } catch (e) { return false; }
}

// 单个 configKey 是否已具备：env 优先，其次运行配置文件中的对应字段
function keyPresent(key) {
  if (String(process.env[key] || '').trim()) return { present: true, from: 'env' };
  const provider = ENV_TO_SEARCH_PROVIDER[key];
  if (provider && searchProviderReady(provider)) return { present: true, from: 'config' };
  return { present: false, from: null };
}

// 凭据模式：any_of（任选其一，如搜索链）/ all_of（默认：全部齐备才算配置完成）
function configState(cap) {
  const keys = Array.isArray(cap.configKeys) ? cap.configKeys : [];
  const mode = cap.credentialMode === 'any_of' ? 'any_of' : 'all_of';
  const present = {};
  const presentKeys = [];
  const missing = [];
  for (const k of keys) {
    const r = keyPresent(k);
    present[k] = r.present;
    if (r.present) presentKeys.push(k); else missing.push(k);
  }
  // any_of：只要有一个通道可用就算已配置（missing 记为「未配置的备选通道」，
  // 不得据此判 not_configured）；all_of：沿用原语义（有任一缺失即未配置）
  const satisfied = mode === 'any_of' ? presentKeys.length > 0 : missing.length === 0;
  return { keys, present, presentKeys, missing, mode, satisfied };
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
  if (!cfg.satisfied) {
    return {
      state: 'not_configured', userText: USER_TEXT.not_configured,
      configKeys: cfg.keys, configKeysPresent: cfg.present, credentialMode: cfg.mode,
      reason: 'system_credentials_missing',
    };
  }
  // 无凭据需求的公开来源（Shopify 公开目录 / 官网公开页面）：
  // 🔴 SC-06 r2（评审 §二）：无凭据 ≠ 已接通。运行态同样只能由**真实成功采集**推到
  // operational；没有成功记录时是 ready_to_verify（来源已配置、尚无真实成功），
  // 最近一次真实尝试失败则按失败分类如实回显——绝不因为「不需要配置」就恒报可用。
  if (!cfg.keys.length) {
    const okPub = lastSuccess(capabilityCode);
    const failPub = lastFailure(capabilityCode);
    const failNewerPub = !!(failPub && (!okPub || String(failPub.at || '') > String(okPub.created_at || '')));
    if (okPub && !failNewerPub) {
      return {
        state: 'operational', userText: '', lastVerifiedAt: okPub.created_at,
        provider: okPub.provider || cap.provider, publicSource: true,
        configKeys: [], configKeysPresent: {},
      };
    }
    if (failPub) {
      const state = failPub.failureClass === 'auth_rejected' ? 'auth_rejected'
        : failPub.failureClass === 'quota_exhausted' || failPub.failureClass === 'rate_limited' ? 'quota_exhausted'
          : 'unavailable';
      return {
        state, userText: USER_TEXT[state], lastFailureClass: failPub.failureClass, lastFailureAt: failPub.at,
        publicSource: true, configKeys: [], configKeysPresent: {},
      };
    }
    return {
      state: 'ready_to_verify', userText: USER_TEXT.ready_to_verify_public,
      reason: 'public_source_no_verified_success', publicSource: true,
      configKeys: [], configKeysPresent: {},
    };
  }
  const ok = lastSuccess(capabilityCode);
  const fail = lastFailure(capabilityCode);
  // 运行态按「最近一次真实尝试」判定：失败晚于成功 → 反映失败分类（凭据失效/权限变更等）。
  // 仅在最近一次成功之后无失败时才是 operational。
  const failIsNewer = !!(fail && (!ok || String(fail.at || '') > String(ok.created_at || '')));
  if (ok && !failIsNewer) {
    return {
      state: 'operational', userText: '',
      lastVerifiedAt: ok.created_at, provider: ok.provider,
      configKeys: cfg.keys, configKeysPresent: cfg.present, credentialMode: cfg.mode,
    };
  }
  if (fail) {
    const state = fail.failureClass === 'auth_rejected' ? 'auth_rejected'
      : fail.failureClass === 'quota_exhausted' || fail.failureClass === 'rate_limited' ? 'quota_exhausted'
        : 'unavailable';
    return {
      state, userText: USER_TEXT[state], lastFailureClass: fail.failureClass, lastFailureAt: fail.at,
      configKeys: cfg.keys, configKeysPresent: cfg.present, credentialMode: cfg.mode,
    };
  }
  return {
    state: 'ready_to_verify', userText: USER_TEXT.ready_to_verify,
    configKeys: cfg.keys, configKeysPresent: cfg.present, credentialMode: cfg.mode,
  };
}

// 记录真实尝试结果（只存脱敏 URL 与分类，绝不存密钥/token）。
// P0-1 整改 r3：sourceUrl 在本函数内**强制**走共享脱敏模块——调用方传入
// 未脱敏 URL（如 ?access_token=...）也不会落库。
function recordVerification({ capability, provider, status, failureClass, sourceUrl, tenantId }) {
  ensureTable();
  const db = SurfaceStore.getDb();
  const row = {
    id: rid('pv'), capability: String(capability || ''), provider: String(provider || ''),
    status: status === 'success' ? 'success' : 'failed',
    failureClass: status === 'success' ? null : String(failureClass || 'unavailable'),
    sourceUrl: sourceUrl ? String(UrlRedact.redactUrl(sourceUrl)).slice(0, 500) : null,
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
  // SC-06 r2：待验证能力（代码就绪、尚无真实成功）也必须在管理员健康视图可见——
  // 否则「已实现但未验证」在运维面上是隐形的。
  const caps = Registry.listCapabilities().filter(c => c.maturity === 'ga' || c.maturity === 'pending_config' || c.maturity === 'pending_verification');
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
      credentialMode: r.credentialMode || 'all_of',
      configKeys: (r.configKeys || []).map(k => ({ name: k, present: !!(r.configKeysPresent && r.configKeysPresent[k]) })),
    };
  });
}

module.exports = {
  READINESS_STATES, USER_TEXT,
  getReadiness, recordVerification, adminView, configState,
};
