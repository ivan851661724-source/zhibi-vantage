#!/usr/bin/env node
'use strict';
// ============================================================
// scripts/live-source-smoke.js —— Wave 1 凭据化数据源真实冒烟
// 用法：node scripts/live-source-smoke.js [--only youtube|dataforseo|tiktok|reviews]
// 纪律：
//  · 仅在相应系统级密钥存在时执行真实请求；缺失 → CONFIG_MISSING（不伪装成功）。
//  · 每来源一条最小真实请求；记录 成功 / 权限不足 / 配额耗尽 / 配置缺失。
//  · 不输出密钥、Authorization、Cookie 或完整私有响应——只输出状态与字段名摘要。
//  · 没有真实成功请求的 adapter 不得升级为 GA（任务书 §五）。
// ============================================================
const Net = require('../research/net.js');

const results = [];
function record(provider, status, detail) {
  results.push({ provider, status, detail: detail || null });
  console.log('[' + status + '] ' + provider + (detail ? ' :: ' + detail : ''));
}

// URL 脱敏（仅用于本脚本打印；快照层已有 redact 逻辑）
function safeUrl(u) {
  try { const uu = new URL(u); if (uu.searchParams.has('key')) uu.searchParams.set('key', '[REDACTED]'); return uu.href; }
  catch (e) { return u; }
}

async function smokeYouTube() {
  const key = String(process.env.YOUTUBE_API_KEY || '').trim();
  if (!key) { record('youtube', 'CONFIG_MISSING', 'YOUTUBE_API_KEY 未配置'); return; }
  // 最小真实请求：官方 search 端点 1 次（maxResults=1）
  const url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=test&key=' + encodeURIComponent(key);
  try {
    await Net.assertPublicUrl(url);
    const res = await Net.safeRequestOnce(url, { timeoutMs: 15000 });
    if (res.status === 200) {
      const j = JSON.parse(res.buffer.toString('utf8'));
      const kind = j && j.kind;
      record('youtube', 'SUCCESS', 'status=200 kind=' + kind + ' items=' + ((j.items || []).length) + ' url=' + safeUrl(url));
    } else if (res.status === 403) {
      let reason = '';
      try { const j = JSON.parse(res.buffer.toString('utf8')); reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || ''; } catch (e) { /* 忽略 */ }
      if (/quota/i.test(reason)) record('youtube', 'QUOTA_EXHAUSTED', '403 reason=' + reason);
      else record('youtube', 'AUTH_REJECTED', '403 reason=' + reason + '（key 无效或 API 未启用）');
    } else if (res.status === 400) {
      record('youtube', 'AUTH_REJECTED', '400（key 格式无效）');
    } else {
      record('youtube', 'UNAVAILABLE', 'status=' + res.status);
    }
  } catch (e) {
    record('youtube', 'UNAVAILABLE', '请求异常：' + String((e && e.message) || e).slice(0, 80));
  }
}

async function smokeDataForSEO() {
  const login = String(process.env.DATAFORSEO_LOGIN || '').trim();
  const password = String(process.env.DATAFORSEO_PASSWORD || '').trim();
  if (!login || !password) { record('dataforseo', 'CONFIG_MISSING', 'DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD 未配置'); return; }
  const auth = Buffer.from(login + ':' + password).toString('base64');
  const body = JSON.stringify([{ keywords: ['smoke_test'], location_name: 'United States', language_name: 'English' }]);
  try {
    await Net.assertPublicUrl('https://api.dataforseo.com/v3/dataforseo_labs/google/trends/explore/live');
    const res = await Net.safeRequestOnce('https://api.dataforseo.com/v3/dataforseo_labs/google/trends/explore/live', {
      timeoutMs: 20000, method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json' }, body,
    });
    if (res.status === 200) {
      let code = null, cost = null;
      try { const j = JSON.parse(res.buffer.toString('utf8')); code = j.status_code; cost = j.cost; } catch (e) { /* 忽略 */ }
      record('dataforseo', 'SUCCESS', 'status=200 api_status_code=' + code + ' cost=' + cost + '（凭据有效，本次真实请求已完成）');
    } else if (res.status === 401 || res.status === 403) {
      record('dataforseo', 'AUTH_REJECTED', 'status=' + res.status + '（凭据无效或权限不足）');
    } else if (res.status === 402) {
      record('dataforseo', 'QUOTA_EXHAUSTED', '402（余额/配额不足）');
    } else {
      record('dataforseo', 'UNAVAILABLE', 'status=' + res.status);
    }
  } catch (e) {
    record('dataforseo', 'UNAVAILABLE', '请求异常：' + String((e && e.message) || e).slice(0, 80));
  }
}

async function smokeTikTok() {
  const clientKey = String(process.env.TIKTOK_CLIENT_KEY || '').trim();
  const clientSecret = String(process.env.TIKTOK_CLIENT_SECRET || '').trim();
  if (!clientKey || !clientSecret) { record('tiktok', 'CONFIG_MISSING', 'TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET 未配置'); return; }
  // P0-3 整改 r2：先走官方 OAuth client_credentials 换 token（client key/secret 只用于此步）；
  // token 仅内存使用，不打印、不落快照。随后用 token 调商业内容研究端点。
  try {
    const OAUTH = 'https://open.tiktokapis.com/v2/oauth/token/';
    await Net.assertPublicUrl(OAUTH);
    const form = new URLSearchParams({ grant_type: 'client_credentials', client_key: clientKey, client_secret: clientSecret }).toString();
    const tok = await Net.safeRequestOnce(OAUTH, { timeoutMs: 20000, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (tok.status === 401 || tok.status === 403) { record('tiktok', 'AUTH_REJECTED', 'oauth status=' + tok.status + '（凭据无效或权限未开通）'); return; }
    if (tok.status === 429) { record('tiktok', 'QUOTA_EXHAUSTED', 'oauth status=429'); return; }
    if (tok.status !== 200) { record('tiktok', 'UNAVAILABLE', 'oauth status=' + tok.status); return; }
    let token = null;
    try { const j = JSON.parse(tok.buffer.toString('utf8')); token = j.access_token || (j.data && j.data.access_token) || null; } catch (e) { /* parse */ }
    if (!token) { record('tiktok', 'AUTH_REJECTED', 'oauth 响应无 access_token（权限未开通）'); return; }
    // P0-2 整改 r3：官方 Query Ads 契约（Authorization: Bearer + 官方 body/fields）
    // R4.14：字段清单与产品请求同源（lib/tiktok-adlib.js），不在此另写子集
    const TikTokAdLib = require('../lib/tiktok-adlib.js');
    const TT_FIELDS = TikTokAdLib.AD_FIELDS_CSV;
    const url = 'https://open.tiktokapis.com/v2/research/adlib/ad/query/?fields=' + encodeURIComponent(TT_FIELDS);
    const ymd = (d) => '' + d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0');
    const body = JSON.stringify({ filters: { ad_published_date_range: { min: ymd(new Date(Date.now() - 30 * 86400000)), max: ymd(new Date(Date.now() - 86400000)) } }, search_term: 'coffee', max_count: 1 });
    const res = await Net.safeRequestOnce(url, {
      timeoutMs: 20000, method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body,
    });
    if (res.status === 200) {
      // HTTP 200 不等于成功：必须 error.code === 'ok' 且 data.ads 为数组（P0-4）
      let biz = null, adsCount = null;
      try { const j = JSON.parse(res.buffer.toString('utf8')); biz = j.error && j.error.code; adsCount = Array.isArray(j.data && j.data.ads) ? j.data.ads.length : null; } catch (e) { /* parse */ }
      if (String(biz).toLowerCase() === 'ok' && adsCount != null) record('tiktok', 'SUCCESS', 'http=200 error.code=ok ads=' + adsCount + '（公开广告记录可查询；token 未进 URL/输出）');
      else if (/token|scope|permission|authoriz/i.test(String(biz))) record('tiktok', 'AUTH_REJECTED', 'http=200 业务码=' + String(biz) + '（研究权限未开通）');
      else record('tiktok', 'UNAVAILABLE', 'http=200 但业务码=' + String(biz) + '（不可视为成功）');
    }
    else if (res.status === 401 || res.status === 403) record('tiktok', 'AUTH_REJECTED', 'api status=' + res.status + '（研究权限未开通）');
    else if (res.status === 429) record('tiktok', 'QUOTA_EXHAUSTED', 'api status=429');
    else record('tiktok', 'UNAVAILABLE', 'api status=' + res.status);
  } catch (e) {
    record('tiktok', 'UNAVAILABLE', '请求异常：' + String((e && e.message) || e).slice(0, 80));
  }
}

async function smokeReviews() {
  // public_reviews 复用系统搜索链（Serper/Tavily/Brave/Bocha 任一）——最小发现请求
  const Search = require('../research/search.js');
  const cfg = require('../core/config.js').loadConfig();
  const any = ['serper', 'tavily', 'brave', 'bocha', 'wigolo'].find(n => Search.providerConfigured(cfg, n));
  if (!any) { record('reviews', 'CONFIG_MISSING', '未配置任何搜索数据服务（SERPER_API_KEY / TAVILY_API_KEY / BRAVE_API_KEY / BOCHA_API_KEY 任一）'); return; }
  try {
    const r = await Search.searchProvider('smoke test public reviews', cfg, 'us', 'reviews');
    const n = (r && (r.results || r.organic || []).length) || 0;
    record('reviews', 'SUCCESS', '搜索服务 ' + any + ' 可用，发现 ' + n + ' 条候选（采集页另行走 robots/归属校验）');
  } catch (e) {
    record('reviews', 'UNAVAILABLE', '搜索请求失败：' + String((e && e.message) || e).slice(0, 80));
  }
}

(async () => {
  const argv = process.argv.slice(2);
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
  console.log('=== live-source-smoke（凭据化数据源真实冒烟；输出不含任何密钥） ===');
  if (!only || only === 'youtube') await smokeYouTube();
  if (!only || only === 'dataforseo') await smokeDataForSEO();
  if (!only || only === 'tiktok') await smokeTikTok();
  if (!only || only === 'reviews') await smokeReviews();
  const ok = results.filter(r => r.status === 'SUCCESS').length;
  console.log('=== 汇总：' + ok + '/' + results.length + ' SUCCESS ===');
  console.log('=== 纪律：没有真实成功请求的 adapter 不升级 GA；本结果可作为 Registry 升级依据之一 ===');
  process.exit(0);
})().catch(e => { console.error('[smoke] FATAL', e && e.message); process.exit(1); });
