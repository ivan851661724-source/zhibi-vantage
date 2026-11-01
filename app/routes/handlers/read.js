'use strict';
// ============================================================
// handlers/read.js —— 只读/派生端点组（Phase 1 首批迁移）
// 全部为「读状态 → 派生 → 返回」的纯查询端点，无副作用写入，
// 迁移风险最低，作为注册表模式的首批示范。
// handler 签名：async (ctx, req, res, url, p) => boolean
// ============================================================

const { marketCurrency } = require('../../research/vocab.js'); // B-7b：quadrant 币种过滤口径
const { buildStateSummary } = require('../../services/state-summary.js'); // r3 §四：首屏摘要投影片

// ---------- /api/version（public） ----------
async function version(ctx, req, res, url, p) {
  if (p !== '/api/version' || req.method !== 'GET') return false;
  ctx.sendJSON(res, 200, ctx.buildVersionInfo());
  return true;
}

// ---------- /api/state（GET：全量派生状态） ----------
// r3 §四：新增 scope=summary（首屏摘要，<150KB）与 projectId（按 id 读本租户档案）。
// 不带 scope 的调用保持原有全量行为，旧调用零改动。
async function state(ctx, req, res, url, p) {
  if (p !== '/api/state' || req.method !== 'GET') return false;
  const privateView = url.searchParams.get('private_view') === '1';
  const scope = String(url.searchParams.get('scope') || '').toLowerCase();
  const wantedId = String(url.searchParams.get('projectId') || '').trim();
  let identity = null;
  if (privateView) {
    identity = ctx.resolveIdentity(req, ctx.config0);
    if (!identity || identity.error || identity.ghost || !identity.tenantId || !identity.userId) {
      ctx.sendJSON(res, 403, { error: 'PRIVATE_VIEW_UNAVAILABLE', message: '当前身份不支持私有视图，请重新登录。' }); return true;
    }
  }
  // 指定 projectId 时只在本租户命名空间内读取：跨租户/不存在的 id 一律 404，
  // 不区分「不存在」与「不属于你」，避免泄漏项目存在性（§三.3）。
  let loaded;
  if (wantedId) {
    loaded = ctx.readProject(wantedId, ctx.resolveTenantId());
    if (!loaded) {
      ctx.sendJSON(res, 404, { error: 'NOT_FOUND', message: '项目不存在。' });
      return true;
    }
  } else {
    loaded = ctx.loadState();
  }
  // Existing field builders may mutate returned objects (e.g. soft quarantine).
  // Private projection must never share mutable references with the public state.
  const s = privateView && loaded ? JSON.parse(JSON.stringify(loaded)) : loaded;
  if (s) {
    if (!Array.isArray(s.excluded)) s.excluded = [];
    s.whiteSpace = ctx.computeWhiteSpace(s);
    s.progress = { total: s.competitors.length, done: s.competitors.filter(c => c.status === 'done').length };
    s.marketCurrency = ctx.marketCurrency(s.intent && s.intent.regions);
    ctx.decorateState(s);
    if (privateView) {
      for (const comp of s.competitors) {
        const own = ctx.correctionOverlay.getCorrections(identity.tenantId, identity.userId, comp.id);
        if (!own.length) continue;
        if (own.some(c => /^price/.test(c.field || ''))) comp.priceField = ctx.getPriceField(comp, own);
        if (own.some(c => c.field === 'launchCadence')) comp.launchCadence = ctx.getLaunchCadence(comp, own);
        if (own.some(c => /^reviews\./.test(c.field || ''))) comp.reviewField = ctx.getReviewField(comp, own);
        for (const prefix of ['channels', 'categories']) {
          const keys = new Set(own.filter(c => (c.field || '').startsWith(prefix + '.')).map(c => c.field.slice(prefix.length + 1)));
          const target = prefix === 'channels' ? 'channelFields' : 'categoryFields';
          for (const key of keys) {
            if (!key || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
            comp[target] = comp[target] || {};
            comp[target][key] = prefix === 'channels' ? ctx.getChannelField(comp, own, key) : ctx.getCategoryField(comp, own, key);
          }
        }
      }
    }
  }
  if (!s) { ctx.sendJSON(res, 200, { track: null, scope: scope === 'summary' ? 'summary' : 'full' }); return true; }
  if (scope === 'summary') {
    // 只读投影：buildStateSummary 返回全新对象，s 本身不动（不得原地裁剪）
    ctx.sendJSON(res, 200, buildStateSummary(s), { 'Cache-Control': 'no-store' });
    return true;
  }
  ctx.sendJSON(res, 200, s);
  return true;
}

// ---------- /api/competitor-detail（GET：单品品牌详情，按需加载） ----------
// r3 §五：工作台首屏不再携带 attempts / evidenceList / fieldSources；
// 用户点开某个品牌时按需取这**一个**品牌的完整对象（含证据与字段来源）。
// 租户边界与 /api/state 完全一致：只在本租户命名空间内查，跨租户与不存在都 404。
async function competitorDetail(ctx, req, res, url, p) {
  if (p !== '/api/competitor-detail' || req.method !== 'GET') return false;
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const competitorId = String(url.searchParams.get('competitorId') || '').trim();
  if (!competitorId) { ctx.sendJSON(res, 400, { error: 'NO_COMPETITOR_ID', message: '缺少品牌标识。' }); return true; }
  const tid = ctx.resolveTenantId();
  const raw = projectId ? ctx.readProject(projectId, tid) : ctx.loadState();
  if (!raw) { ctx.sendJSON(res, 404, { error: 'NOT_FOUND', message: '项目不存在。' }); return true; }
  // 与 /api/state 走同一条派生链路，保证详情与摘要/全量同源（不另算口径）
  const s = JSON.parse(JSON.stringify(raw));
  if (!Array.isArray(s.excluded)) s.excluded = [];
  s.progress = { total: (s.competitors || []).length, done: (s.competitors || []).filter(c => c.status === 'done').length };
  ctx.decorateState(s);
  const comp = (s.competitors || []).find(c => c && c.id === competitorId);
  if (!comp) { ctx.sendJSON(res, 404, { error: 'NOT_FOUND', message: '品牌不存在。' }); return true; }
  ctx.sendJSON(res, 200, {
    projectId: s.projectId || null,
    competitorId: comp.id,
    competitor: comp,
    updatedAt: comp.researchedAt || null,
  }, { 'Cache-Control': 'no-store' });
  return true;
}

// ---------- /api/domains（GET：域注册表状态） ----------
async function domains(ctx, req, res, url, p) {
  if (p !== '/api/domains' || req.method !== 'GET') return false;
  const st = ctx.loadState();
  if (st) ctx.decorateState(st);
  const status = ctx.DomainRunner.domainStatus();
  const violations = ctx.DomainReg.validateCrossDomainRead();
  const verdictKeys = (st && st.domainVerdicts) ? Object.keys(st.domainVerdicts) : [];
  ctx.sendJSON(res, 200, {
    domains: status,
    enabled: ctx.DomainReg.enabledDomains(),
    crossDomainViolations: violations,
    verdictKeys,
    materialsCount: (st && Array.isArray(st.materials)) ? st.materials.length : 0,
    guardNote: 'Phase A：域注册表驱动已生效；仅 enabled 域产出 verdict 快照，未启用域不出材料。',
  });
  return true;
}

// ---------- /api/materials（GET：L3 材料引擎读取面） ----------
async function materials(ctx, req, res, url, p) {
  if (p !== '/api/materials' || req.method !== 'GET') return false;
  const st = ctx.loadState();
  if (!st) { ctx.sendJSON(res, 200, { materials: [], domainsInUse: [] }); return true; }
  ctx.decorateState(st);
  ctx.sendJSON(res, 200, {
    materials: st.materials || [],
    domainsInUse: ctx.DomainReg.enabledDomains(),
    note: '当前仅价格域上线：跟价材料（谁 + 什么动作 + 何时 + 依据）。历史价回溯未达标前标 missingFields，不编造历史趋势。',
  });
  return true;
}

// ---------- /api/heroes（GET：主推产品推理） ----------
async function heroes(ctx, req, res, url, p) {
  if (p !== '/api/heroes' || req.method !== 'GET') return false;
  const st = ctx.loadState();
  if (!st) { ctx.sendJSON(res, 404, { error: 'NO_STATE' }); return true; }
  const ds = ctx.decorateState(st);
  const heroes = (ds.competitors || []).map(c => ({
    id: c.id, name: c.name, heroProduct: c.heroProduct,
    priceBand: c.priceField && c.priceField.band ? c.priceField.band : (c.priceBand || null)
  }));
  ctx.sendJSON(res, 200, { track: ds.track, heroes });
  return true;
}

// ---------- /api/radar-changes（GET：雷达变化检测 + 群体异动） ----------
async function radarChanges(ctx, req, res, url, p) {
  if (p !== '/api/radar-changes' || req.method !== 'GET') return false;
  const st = ctx.loadState();
  if (!st) { ctx.sendJSON(res, 404, { error: 'NO_STATE' }); return true; }
  const ds = ctx.decorateState(st);
  ctx.sendJSON(res, 200, {
    track: ds.track,
    groupSignals: (ds.radar && ds.radar.groupSignals) || [],
    perCompetitor: (ds.radar && ds.radar.perCompetitor) || {},
    note: 'groupSignals=战略信号条（群体异动）；perCompetitor.recentActions=每个竞争品牌最近动作（verified=准 / inferred=推）。'
  });
  return true;
}

// ---------- /api/quadrant（POST：竞争强度×机会大小 象限） ----------
async function quadrant(ctx, req, res, url, p) {
  if (p !== '/api/quadrant' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const st = ctx.loadState();
  if (!st) { ctx.sendJSON(res, 404, { error: 'NO_STATE' }); return true; }
  const excluded = new Set(Array.isArray(st.excluded) ? st.excluded : []);
  // SC-06 r2：机会轴输入来自统一评论事实链（与机会页/报告/品牌档案同一读模型）
  let voiceInput = { items: [], collected: 0 };
  try {
    const VoiceUnified = require('../../services/voice-unified.js');
    const BrandStore = require('../../services/brand-store.js');
    const brandByRef = new Map();
    if (st.tenantId && st.projectId) {
      for (const l of (BrandStore.listBrandLinksForProject(st.tenantId, st.projectId) || [])) {
        if (l && l.competitorRef && l.brandId) brandByRef.set(l.competitorRef, l.brandId);
      }
    }
    const done = (st.competitors || []).filter(c => c && c.status === 'done' && !excluded.has(c.id));
    voiceInput = VoiceUnified.buildOpportunityInputForComps({
      tenantId: st.tenantId, projectId: st.projectId, comps: done,
      brandIdOf: (c) => brandByRef.get(c.id) || null,
    });
  } catch (e) { /* 读不到来源层 → 机会轴按无合格输入处理（不猜） */ }
  const q = ctx.QD.computeQuadrant(st.competitors, {
    excluded, sectorName: st.track, marketCurrency: marketCurrency(st.intent && st.intent.regions),
    voiceItems: voiceInput.items, voiceCollected: voiceInput.collected,
  });
  ctx.sendJSON(res, 200, q);
  return true;
}

// ---------- /api/compare（POST：横向对比，纯聚合不调 LLM） ----------
async function compare(ctx, req, res, url, p) {
  if (p !== '/api/compare' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const s = ctx.loadState();
  if (!s) { ctx.sendJSON(res, 404, { error: 'NO_STATE' }); return true; }
  const field = (body.field || '').trim();
  if (!field) { ctx.sendJSON(res, 400, { error: 'NO_FIELD' }); return true; }
  const result = ctx.compareField(s, field);
  ctx.sendJSON(res, 200, result);
  return true;
}

module.exports = {
  version, state, competitorDetail, domains, materials, heroes, radarChanges, quadrant, compare,
};
