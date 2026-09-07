'use strict';
// ============================================================
// core/http-gate.js —— 边界闸原语：身份解析 / 客户端 IP / 限流 / 并发闸
// 本文件自 server.js 拆分并加固（历史见 git）：
//   · getAuthPayload：/api/stream 额外接受 ?token= 查询参数（EventSource 无法自定义请求头）
//   · clientIp：XFF 从右往左按可信代理层数解析，堵伪造首段绕过限流/封禁
// ============================================================
const Auth = require('../services/auth.js');
const ipguard = require('../lib/ipguard.js');

// 解析请求身份：租户 JWT 或平台超管 token，任一有效即通过。
function getAuthPayload(req, url, pathname) {
  const h = req.headers && req.headers['authorization'];
  if (h) {
    const m = String(h).match(/^Bearer\s+(.+)$/i);
    if (m) {
      const token = m[1].trim();
      const t = Auth.verifyToken(token);
      if (t) return { kind: 'tenant', payload: t };
      const a = Auth.verifyAdminToken(token);
      if (a) return { kind: 'admin', payload: a };
      return null;
    }
  }
  // SSE 专用通道：EventSource 无法携带 Authorization 头，仅 /api/stream 接受查询串令牌。
  // （logger 只记 pathname 不落 query，令牌不会进日志；过期/伪造令牌同样验签失败。）
  if (url && pathname === '/api/stream') {
    const qt = url.searchParams.get('token') || url.searchParams.get('access_token');
    if (qt) {
      const t = Auth.verifyToken(String(qt).trim());
      if (t) return { kind: 'tenant', payload: t };
    }
  }
  return null;
}

// 客户端 IP：X-Forwarded-For 从右往左取第 (ZB_TRUSTED_PROXIES+1) 项。
// XFF 语义是"每个代理把上一跳追加到右侧"：最右 trustN 项由我们前面的可信代理生成，
// 再往左一项才是真实客户端。默认 1 层可信代理（当前部署：zhibi-web 反代 → 后端）。
// 直连场景（无代理）攻击者可伪造整个 XFF，但此时 length-1-trustN < 0 自动回落 socket 地址。
function clientIp(req) {
  const trustN = Math.max(0, parseInt(process.env.ZB_TRUSTED_PROXIES || '1', 10) || 0);
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff && trustN > 0) {
    const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean);
    const idx = parts.length - 1 - trustN;
    if (idx >= 0 && parts[idx]) return parts[idx];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// 简单内存固定窗口限流（单实例语义；多实例部署需换集中式存储）
const rateBuckets = new Map();
function rateLimited(ip, key, max, windowMs) {
  const now = Date.now();
  const full = key + '|' + ip;
  let b = rateBuckets.get(full);
  if (!b || now - b.ts > windowMs) { b = { ts: now, count: 0 }; rateBuckets.set(full, b); }
  b.count++;
  return b.count > max;
}
// 定期清理过期限流桶，避免内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) if (now - b.ts > 600000) rateBuckets.delete(k);
}, 300000).unref();

// 全局研究任务并发护栏：避免同时发起过多 LLM/搜索任务拖垮服务或失控扣费。
// activeDiscovers 是模块标量，handler 无法直接读写，经此闭包保持进程内唯一。
let activeDiscovers = 0;
const MAX_DISCOVERS = 3;
const discoverGate = {
  enter: () => { if (activeDiscovers >= MAX_DISCOVERS) return false; activeDiscovers++; return true; },
  leave: () => { activeDiscovers = Math.max(0, activeDiscovers - 1); },
};

module.exports = { getAuthPayload, clientIp, rateLimited, discoverGate, ipguard };
