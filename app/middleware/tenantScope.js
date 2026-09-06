'use strict';
// ============================================================
// 中间件：租户身份解析（v0.2）—— 隔离执行点之一（§3.1 / P0-1）
// 解析优先级：
//   1) Authorization: Bearer <JWT> → 解出 {tenantId,userId,role,ghost}
//   2) 旧全局 Key（x-legacy-key 匹配 config.auth.legacyKey）→ 幽灵租户（仅遗留迁移端点可用）
//   3) 都没有 → 401
// 注意：本中间件只"解析身份"，不决定 ghost 能否访问某接口——那由 api-tenant 分发器
//       按 allowGhost 裁决（新接口一律禁止 ghost，否则 403）。这样"旧 Key 当平台身份
//       窥探新租户数据"在结构上不可能发生。
// ============================================================
const auth = require('../services/auth.js');
const db = require('../services/db.js');

function extractToken(req) {
  const h = req.headers && req.headers['authorization'];
  if (!h) return null;
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// 返回 {tenantId,userId,role,ghost} 或 {error:401|403, reason}
function resolveIdentity(req, config) {
  const token = extractToken(req);
  if (token) {
    const payload = auth.verifyToken(token);
    if (!payload) return { error: 401, reason: 'BAD_TOKEN' };
    // 封禁裁决（§6.2 / 隔离层）：被 suspended 的真实租户，任何携带其 token 的请求一律 403。
    // 放在身份解析层而非业务层，确保即使业务代码漏判也挡得住。
    if (!payload.ghost) {
      const t = db.getTenant(payload.tid);
      if (t && t.status === 'suspended') return { error: 403, reason: 'TENANT_SUSPENDED' };
    }
    return { tenantId: payload.tid, userId: payload.sub, role: payload.role, ghost: !!payload.ghost };
  }
  // 旧全局 Key → 幽灵租户（必须在 config 显式配置 legacyKey 才开放该通道，否则默认关闭）
  const legacyKey = config && config.auth && config.auth.legacyKey;
  const provided = req.headers && req.headers['x-legacy-key'];
  if (legacyKey && provided && provided === legacyKey) {
    return { tenantId: auth.GHOST_TENANT_ID, userId: null, role: 'legacy', ghost: true };
  }
  return { error: 401, reason: 'NO_AUTH' };
}

module.exports = { resolveIdentity, GHOST_TENANT_ID: auth.GHOST_TENANT_ID, extractToken };
