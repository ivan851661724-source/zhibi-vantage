'use strict';
// Provider 级成功判定（P0-4 整改 r3）：HTTP 200 不等于 provider 成功。
// 事实依据（当天核实）：
//   · TikTok Commercial Content API：响应 {"data":{...},"error":{"code":"ok","http_status_code":200,"log_id":"...","message":""}}
//     —— 成功判定 = error.code === 'ok'；业务错误可伴 HTTP 200。
//   · DataForSEO：顶层 status_code===20000 且 tasks[].status_code===20000；
//     task 级 40000 等业务错误可伴 HTTP 200（第三方实测佐证）。
//   · YouTube Data API v3：错误响应 {"error":{"code":403,"message":"...","errors":[{"reason":"quotaExceeded"}]}}；
//     成功响应含 items 数组 —— 有 error 对象即不得进入成功链。
// 纪律：合法「零结果」可成功——前提是来源明确返回了成功响应结构（而非空对象/错误对象/解析降级）。
// verification success 三条件由调用方保证：①本模块判定成功 ②快照已保存 ③标准输出通过契约校验。

// ---------- 通用错误码 → 失败分类 ----------
const FAIL = Object.freeze({ auth: 'auth_rejected', quota: 'quota_exhausted', unavailable: 'unavailable' });

function fail(errorClass, detail) { return { ok: false, errorClass, retryable: errorClass !== 'auth_rejected', detail: detail || null }; }

// ---------- YouTube Data API v3 ----------
// 成功结构：{ kind, etag, items: [...] , pageInfo }（search/list/channels/videos 一致）
function youtubeOk(json) {
  const j = json || {};
  if (j.error && typeof j.error === 'object') {
    const code = Number(j.error.code);
    const reasons = (Array.isArray(j.error.errors) ? j.error.errors : []).map(e => String(e && e.reason || '')).join(',');
    if (code === 401 || code === 403) {
      if (/quota/i.test(reasons) || /quota/i.test(String(j.error.message || ''))) return fail('quota_exhausted', 'quota');
      return fail('auth_rejected', 'http_' + code);
    }
    if (code === 429) return fail('quota_exhausted', 'rate_limited');
    return fail('unavailable', 'api_error_' + (code || 'unknown'));
  }
  // 必须显式存在 items 数组（空数组 = 合法零结果）
  if (!Array.isArray(j.items)) return fail('unavailable', 'missing_items');
  return { ok: true, count: j.items.length };
}

// ---------- DataForSEO ----------
// 顶层 status_code=20000 且至少一个 task；task.status_code=20000 才算该 task 成功
function dataforseoOk(json) {
  const j = json || {};
  const top = Number(j.status_code);
  if (top !== 20000) return fail(mapDataForSeoCode(top), 'top_' + top);
  const tasks = Array.isArray(j.tasks) ? j.tasks : [];
  if (!tasks.length) return fail('unavailable', 'no_tasks');
  const t = tasks[0] || {};
  const tsc = Number(t.status_code);
  if (tsc !== 20000) return fail(mapDataForSeoCode(tsc), 'task_' + tsc);
  return { ok: true, task: t };
}
// DataForSEO 错误码族（官方错误附录口径）：2xxxx 成功；4xxxx 业务/参数。
// 401xx/402xx 鉴权与余额；405xx 参数；其余按不可达处理（不猜测细码含义）
function mapDataForSeoCode(code) {
  const c = Number(code);
  if (c === 40100 || c === 40101 || c === 40102 || c === 40103 || c === 40104 || c === 40204) return FAIL.auth;
  if (c === 40203 || c === 40200) return FAIL.quota; // 余额/配额不足
  return FAIL.unavailable;
}

// ---------- TikTok Commercial Content API ----------
// 成功结构：error.code === 'ok'（字符串）；data.ads 数组（空数组 = 合法零广告结果）
function tiktokOk(json) {
  const j = json || {};
  const code = String((j.error && j.error.code) != null ? j.error.code : '').trim().toLowerCase();
  if (!code) return fail('unavailable', 'missing_error_object');
  if (code === 'ok' || code === '0') {
    const data = j.data;
    if (!data || typeof data !== 'object') return fail('unavailable', 'missing_data');
    if (!Array.isArray(data.ads)) return fail('unavailable', 'missing_ads_array');
    return { ok: true, ads: data.ads, hasMore: data.has_more === true || String(data.has_more) === 'true', searchId: data.search_id || null };
  }
  if (/token|scope|permission|authoriz|client/.test(code)) return fail('auth_rejected', code);
  if (/rate|limit|quota/.test(code)) return fail('quota_exhausted', code);
  return fail('unavailable', code);
}

module.exports = {
  FAIL, youtubeOk, dataforseoOk, tiktokOk, mapDataForSeoCode,
  // 用户侧失败文案（四种口径内；不含内部码/变量名）
  USER_TEXT: Object.freeze({
    auth_rejected: '最近采集失败，可稍后重试。',
    quota_exhausted: '数据服务配额已用尽，稍后再试。',
    unavailable: '数据服务暂不可用，请稍后再试。',
  }),
};
