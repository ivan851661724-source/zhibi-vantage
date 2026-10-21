'use strict';
// URL 凭据脱敏（P0-1 整改 r3）：独立共享模块，零依赖、无循环引用。
// 纪律：所有持久化边界的 URL 必须经过本模块——
//   SourceSnapshot.source_url / final_url、fetchApiJson 返回 finalUrl、
//   provider_verifications.source_url、Evidence/report/admin/错误对象、重定向 URL。
// 敏感 query key 大小写不敏感；键名列表冻结，禁止就地修改。
const SENSITIVE_QUERY_KEYS = Object.freeze([
  'key',
  'api_key',
  'apikey',
  'access_token',
  'token',
  'client_secret',
  'signature',
  'secret',
  'password',
]);

const REDACTED = '[REDACTED]';

// 脱敏单个 URL：命中敏感 key 的 query 值替换为 [REDACTED]（保留参数名，便于排查）
function redactUrl(u, extraKeys) {
  if (u == null || u === '') return u == null ? u : '';
  try {
    const uu = new URL(String(u));
    const lower = new Set(SENSITIVE_QUERY_KEYS);
    for (const k of (extraKeys || [])) lower.add(String(k).toLowerCase());
    for (const k of [...uu.searchParams.keys()]) {
      if (lower.has(k.toLowerCase())) uu.searchParams.set(k, REDACTED);
    }
    return uu.href;
  } catch (e) {
    // 非 URL 形态（相对路径/畸形串）：按键值对做保守文本替换，宁可过度脱敏
    let s = String(u);
    for (const k of SENSITIVE_QUERY_KEYS) {
      s = s.replace(new RegExp('([?&]' + k + '=)[^&#\\s]+', 'gi'), '$1' + REDACTED);
    }
    return s;
  }
}

// 深度脱敏对象中的 URL 型字段（用于错误对象/证据 note/报告引用等任意结构）
const URL_FIELD_NAMES = new Set([
  'url', 'sourceUrl', 'source_url', 'finalUrl', 'final_url', 'redirectUrl',
  'redirect_url', 'href', 'link', 'creativeUrl', 'check_url',
]);
function redactUrlsDeep(node, depth) {
  if (depth > 8 || node == null) return node;
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(n => redactUrlsDeep(n, depth + 1));
  if (typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string' && URL_FIELD_NAMES.has(k)) out[k] = redactUrl(v);
      else if (typeof v === 'object' && v !== null) out[k] = redactUrlsDeep(v, depth + 1);
      else out[k] = v;
    }
    return out;
  }
  return node;
}

// 文本脱敏（日志/错误消息兜底）：任何形如 ?key=... 的片段脱敏
function redactUrlText(text) {
  let s = String(text == null ? '' : text);
  for (const k of SENSITIVE_QUERY_KEYS) {
    s = s.replace(new RegExp('([?&]' + k + '=)[^&#\\s]*', 'gi'), '$1' + REDACTED);
  }
  return s;
}

module.exports = { SENSITIVE_QUERY_KEYS, REDACTED, redactUrl, redactUrlsDeep, redactUrlText };
