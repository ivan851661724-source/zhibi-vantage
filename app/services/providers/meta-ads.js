'use strict';
// ============================================================
// services/providers/meta-ads.js —— Meta 广告库（T0 · 抓取需求 §2.5）
// 官方 Ad Library API（graph /ads_archive）：需要有效 access_token（config.metaAds.token）；
// 无 token → {ok:false,error:'NO_META_TOKEN'}，调用方按「未探测（源未配置）」处理，绝不编数据。
// 产出（§2.5）：近窗口在投广告卡（文案/链接标题/起止日期/平台分布）+ 活跃度评级（§5.4）。
//   活跃度 = f(在投条数, 最长持续天数, 平台覆盖数) → 高/中/低（阈值初值，进常量可调）
//   只评级不算钱——花费任何平台都不公示，估算金额=编数据（§5.4 铁律）
// 去重：按 creative id（跨平台同创意在 API 层同 id）；文案截断入库；纯图无文案只记 id 不进卖点。
// fetchImpl 可注入（单测）。
// ============================================================
const Cache = require('../cache.js');

const GRAPH_URL = 'https://graph.facebook.com/v21.0/ads_archive';
// §5.4 活跃度评级初值（可调）
const LEVEL_ACTIVE_HIGH = 10;   // 在投 ≥10 条 → 高
const LEVEL_ACTIVE_MID = 3;     // 在投 ≥3 条 → 中
const LEVEL_DAYS_HIGH = 30;     // 最长持续 ≥30 天 → 高
const LEVEL_DAYS_MID = 7;       // ≥7 天 → 中

function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return isNaN(ms) ? null : Math.max(0, Math.round(ms / 86400000));
}
function activityLevelOf(activeCount, longestDays, platformCount) {
  if (activeCount >= LEVEL_ACTIVE_HIGH || longestDays >= LEVEL_DAYS_HIGH || platformCount >= 3) return 'high';
  if (activeCount >= LEVEL_ACTIVE_MID || longestDays >= LEVEL_DAYS_MID || platformCount >= 2) return 'medium';
  if (activeCount >= 1) return 'low';
  return 'none';
}

// brand: 品牌名；config.metaAds.token 必需；opts.fetchImpl 注入
async function searchBrandAds(brand, config, opts) {
  const o = opts || {};
  const token = config && config.metaAds && config.metaAds.token;
  const name = String(brand || '').trim();
  if (!name) return { ok: false, error: 'NO_BRAND' };
  if (!token) return { ok: false, error: 'NO_META_TOKEN' };
  const key = name.toLowerCase() + '|' + String(o.country || '');
  const hit = Cache.get('meta-ads', key);
  if (hit) return hit;

  const f = o.fetchImpl || fetch;
  const params = new URLSearchParams({
    access_token: token,
    search_terms: name,
    ad_reached_countries: o.country || 'ALL',
    ad_type: 'ALL',
    fields: 'id,ad_delivery_start_time,ad_delivery_stop_time,ad_creative_body,ad_creative_link_title,publisher_platforms',
    limit: '100',
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await f(GRAPH_URL + '?' + params.toString(), { headers: { 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = j && j.error && j.error.message || ''; } catch (e) {}
      return { ok: false, error: 'META_' + r.status + (detail ? ':' + String(detail).slice(0, 120) : '') };
    }
    const j = await r.json();
    const rows = Array.isArray(j.data) ? j.data : [];
    // 去重：同 id 只留一条；文案归一（body 优先，缺 body 只记 linkTitle；纯图无文案 → text 空）
    const seen = new Set();
    const creatives = [];
    let activeCount = 0, longestDays = 0;
    const platforms = new Set();
    const now = new Date().toISOString();
    for (const ad of rows) {
      const id = ad && ad.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const start = ad.ad_delivery_start_time || null;
      const stop = ad.ad_delivery_stop_time || null;
      const isActive = !stop || stop >= now;
      if (isActive) activeCount++;
      const d = start ? daysBetween(start, stop || now) : null;
      if (d != null && d > longestDays) longestDays = d;
      const plats = Array.isArray(ad.publisher_platforms) ? ad.publisher_platforms : [];
      plats.forEach(p => platforms.add(p));
      creatives.push({
        id,
        text: String(ad.ad_creative_body || '').slice(0, 200),   // 无 body 的纯图素材 text=''（不进卖点统计）
        linkTitle: String(ad.ad_creative_link_title || '').slice(0, 120),
        startDate: start, stopDate: stop,
        platforms: plats,
        active: isActive,
      });
    }
    const result = {
      ok: true,
      brand: name,
      totalInWindow: creatives.length,
      activeCount,
      longestDays,
      platforms: Array.from(platforms),
      activityLevel: activityLevelOf(activeCount, longestDays, platforms.size),
      creatives: creatives.slice(0, 10), // 素材卡入库上限（§5.4：素材库展示层自控）
      fetchedAt: now,
      note: '投放花费不公示，只做活跃度评级，无金额',
    };
    Cache.set('meta-ads', key, result, 86400); // 日级缓存（§2.5 周级全量由 sweep 后续接管）
    return result;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  } finally { clearTimeout(timer); }
}

module.exports = { searchBrandAds, activityLevelOf };
