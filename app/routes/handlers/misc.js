'use strict';
// ============================================================
// handlers/misc.js —— 配置/搜索测试/档案管理/报错通道端点组
// config(GET/POST) / searchtest / reset / projects(GET/switch/delete) / report
// 逻辑与原 server.js 实现逐行对应（纯搬运，不改行为）。
// ============================================================

// ---------- /api/config（GET：密钥状态速览） ----------
async function configGet(ctx, req, res, url, p) {
  if (p !== '/api/config' || req.method !== 'GET') return false;
  const c = ctx.loadConfig() || {};
  const provider = (c.search && c.search.provider) || 'tavily';
  const hasTavily = !!(c.search && (c.search.tavilyKey || c.search.apiKey));
  const serperPool = ctx.getSerperPool(c);
  const hasSerper = serperPool.keys.length > 0;
  const hasBrave = !!(c.search && c.search.braveKey);
  const hasBocha = !!(c.search && c.search.bochaKey);
  const hasKeys = !!(ctx.activeSearchKey(c) && c.llm && c.llm.apiKey);
  return ctx.sendJSON(res, 200, { hasKeys, provider, hasTavily, hasSerper, hasBrave, hasBocha, serperKeyCount: serperPool.keys.length, serperKeysDisabled: serperPool.disabled.size, ownBrands: (c.ownBrands || []).filter(Boolean) });
}

// ---------- /api/config（POST：保存配置，RBAC 仅 admin） ----------
async function configPost(ctx, req, res, url, p) {
  if (p !== '/api/config' || req.method !== 'POST') return false;
  // RBAC（P1-4.2）：仅平台超管或租户管理员可改全局配置（含密钥）
  const ap = ctx.getAuthPayload(req);
  const isAdmin = ap && (ap.kind === 'admin' || (ap.payload && (ap.payload.role === 'platform_admin' || ap.payload.role === 'admin')));
  if (!isAdmin) return ctx.sendJSON(res, 403, { error: 'FORBIDDEN', message: '仅平台超管或租户管理员可修改配置。' });
  const body = await ctx.readBody(req);
  ctx.ensureData();
  const cur = ctx.loadConfig() || {};
  const provider = (body.search && body.search.provider) || (cur.search && cur.search.provider) || 'tavily';
  // 归一化 Serper key 池：serperKeys 接受数组或「逗号/换行/分号分隔」字符串；serperKey(单) 会并入
  const rawSerper = (body.search && body.search.serperKeys) || '';
  let serperKeys = Array.isArray(rawSerper)
    ? rawSerper.map(s => String(s).trim()).filter(Boolean)
    : String(rawSerper || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
  const singleSerper = (body.search && body.search.serperKey || '').trim();
  if (singleSerper && !serperKeys.includes(singleSerper)) serperKeys.unshift(singleSerper);
  if (!serperKeys.length) {
    // 留空 = 保留当前已配置 key（与单 key 行为一致）
    const curKeys = (cur.search && cur.search.serperKeys) || (cur.search && cur.search.serperKey ? [cur.search.serperKey] : []);
    serperKeys = curKeys;
  }
  const next = {
    llm: { baseUrl: (body.llm && body.llm.baseUrl) || (cur.llm && cur.llm.baseUrl) || 'https://api.deepseek.com/v1', model: (body.llm && body.llm.model) || 'deepseek-chat', apiKey: (body.llm && body.llm.apiKey) || (cur.llm && cur.llm.apiKey) || '' },
    search: {
      provider,
      apiKey: (body.search && body.search.apiKey) || (cur.search && cur.search.apiKey) || '',
      serperKey: serperKeys[0] || (cur.search && cur.search.serperKey) || '',
      serperKeys: serperKeys.slice(),
      braveKey: (body.search && body.search.braveKey) || (cur.search && cur.search.braveKey) || '',
      bochaKey: (body.search && body.search.bochaKey) || (cur.search && cur.search.bochaKey) || ''
    },
    ownBrands: Array.isArray(body.ownBrands)
      ? body.ownBrands.map(s => String(s).trim()).filter(Boolean)
      : String((body.ownBrands) || '').split(/[\n,;]+/).map(s => s.trim()).filter(Boolean)
  };
  await ctx.saveConfig(next);
  return ctx.sendJSON(res, 200, { ok: true, hasKeys: !!(ctx.activeSearchKey(next) && next.llm.apiKey), serperKeyCount: next.search.serperKeys.length });
}

// ---------- /api/searchtest（POST：搜索源交叉验证） ----------
async function searchtest(ctx, req, res, url, p) {
  if (p !== '/api/searchtest' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const query = (body.query || '').trim();
  if (!query) return ctx.sendJSON(res, 400, { error: '请填写测试查询词' });
  const c = ctx.loadConfig() || {};
  const sc = c.search || {};
  const runners = [];
  if (sc.tavilyKey || sc.apiKey) runners.push(['tavily', () => ctx.tavilySearch(query, sc.tavilyKey || sc.apiKey)]);
  if (sc.serperKey || (sc.serperKeys && sc.serperKeys.length)) {
    const { keys, disabled } = ctx.getSerperPool({ search: sc });
    if (keys.length) runners.push(['serper', () => ctx.serperSearchWithFailover(query, keys, 'us', { disabled })]);
  }
  if (sc.braveKey) runners.push(['brave', () => ctx.braveSearch(query, sc.braveKey, 'us')]);
  if (sc.bochaKey) runners.push(['bocha', () => ctx.bochaSearch(query, sc.bochaKey)]);
  if (!runners.length) return ctx.sendJSON(res, 400, { error: '没有任何已配置 key 的搜索源' });
  const settled = await Promise.allSettled(runners.map(([, fn]) => fn()));
  const out = {};
  runners.forEach(([name], i) => {
    const r = settled[i];
    out[name] = r.status === 'fulfilled'
      ? { ok: true, count: (r.value.results || []).length, results: (r.value.results || []).slice(0, 8).map(x => ({ title: x.title, url: x.url, snippet: (x.content || '').slice(0, 140) })) }
      : { ok: false, error: String(r.reason && r.reason.message || r.reason) };
  });
  return ctx.sendJSON(res, 200, { query, providers: out });
}

// ---------- /api/reset（POST：换赛道，只清当前指针，旧档案归档保留） ----------
async function reset(ctx, req, res, url, p) {
  if (p !== '/api/reset' || req.method !== 'POST') return false;
  ctx.setCurrentId(null);
  return ctx.sendJSON(res, 200, { track: null });
}

// ---------- /api/projects（GET：历史调研档案列表，文件态清单） ----------
// 注意：v0.2 api-tenant.js 曾以 db 版清单遮蔽本端点（db 无镜像数据 → 永远空列表，
// /history 页空态根因），已在分发器层让路（见 api-tenant.js 注释），此处为唯一实现。
async function projectsList(ctx, req, res, url, p) {
  if (p !== '/api/projects' || req.method !== 'GET') return false;
  const out = ctx.listProjects(ctx.resolveTenantId()); // 与 switch/delete 同口径：显式传请求租户
  return ctx.sendJSON(res, 200, { projects: out });
}

// ---------- /api/projects/switch（POST：切换当前调研档案） ----------
async function projectsSwitch(ctx, req, res, url, p) {
  if (p !== '/api/projects/switch' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const id = (body.id || '').trim();
  const tid = ctx.resolveTenantId(); // 请求内租户（P0-2.1）
  const pf = ctx.projFile(id, tid); // 只在「自己命名空间」内查找，天然隔离跨租户
  if (!id || !ctx.fs.existsSync(pf)) return ctx.sendJSON(res, 404, { error: 'NO_PROJECT', message: '找不到该调研档案' });
  // 跨租户拦截（纵深防御）：即便命名空间名巧合命中，也拒绝不属于本租户的档案。
  // 口径注意：档案内 tenantId 是 RAW（如 tenant:xxx），tid 是 sanitize 后的命名空间名
  // （tenant_xxx）——两侧必须过同一 sanitize 再比，否则合法档案会被误判 404。
  let s = null;
  try { s = JSON.parse(ctx.fs.readFileSync(pf, 'utf8')); } catch (e) { s = null; }
  if (s && s.tenantId && ctx.resolveTenantId(s.tenantId) !== tid) return ctx.sendJSON(res, 404, { error: 'NO_PROJECT', message: '找不到该调研档案' });
  ctx.setCurrentId(id, tid);
  if (s) {
    s.whiteSpace = ctx.computeWhiteSpace(s);
    s.progress = { total: s.competitors.length, done: s.competitors.filter(c => c.status === 'done').length };
    s.marketCurrency = ctx.marketCurrency(s.intent && s.intent.regions);
    ctx.decorateState(s);
  }
  return ctx.sendJSON(res, 200, s || { track: null });
}

// ---------- /api/projects/delete（POST：删除调研档案） ----------
async function projectsDelete(ctx, req, res, url, p) {
  if (p !== '/api/projects/delete' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const id = (body.id || '').trim();
  if (!id) return ctx.sendJSON(res, 400, { error: 'EMPTY' });
  const tid = ctx.resolveTenantId();
  const pf = ctx.projFile(id, tid);
  if (!ctx.fs.existsSync(pf)) return ctx.sendJSON(res, 404, { error: 'NO_PROJECT', message: '找不到该调研档案' });
  // 跨租户拦截（纵深防御）：口径与 switch 相同——RAW tenantId 过 sanitize 后再比
  let s = null;
  try { s = JSON.parse(ctx.fs.readFileSync(pf, 'utf8')); } catch (e) { s = null; }
  if (s && s.tenantId && ctx.resolveTenantId(s.tenantId) !== tid) return ctx.sendJSON(res, 404, { error: 'NO_PROJECT', message: '找不到该调研档案' });
  try { ctx.fs.unlinkSync(pf); } catch {}
  if (ctx.getCurrentId(tid) === id) ctx.setCurrentId(null, tid);
  return ctx.sendJSON(res, 200, { ok: true, projects: ctx.listProjects(tid) });
}

// ---------- /api/report（POST：低调报错通道，须附 source） ----------
async function report(ctx, req, res, url, p) {
  if (p !== '/api/report' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const desc = (body.description || '').trim();
  const source = (body.source || '').trim();
  if (!desc) return ctx.sendJSON(res, 400, { error: 'EMPTY', message: '请填写你发现的问题。' });
  if (!source) return ctx.sendJSON(res, 400, { error: 'NO_SOURCE', message: '请附上证据来源，否则我们无法受理（这是护城河纪律：挑战不直接改库）。' });
  ctx.ensureData();
  const rp = ctx.reportsFile(); // P1-7：按请求所属租户落盘，隔离跨租户数据
  let arr = [];
  try { arr = JSON.parse(ctx.fs.readFileSync(rp, 'utf8')); } catch {}
  arr.push({ at: new Date().toISOString(), competitorId: body.competitorId || null, gapId: body.gapId || null, gapLabel: body.gapLabel || null, description: desc, source, status: 'pending' });
  ctx.safeWrite(rp, arr, true);
  return ctx.sendJSON(res, 200, { ok: true, message: '已收到，我们会核实后留痕更新。' });
}

module.exports = { configGet, configPost, searchtest, reset, projectsList, projectsSwitch, projectsDelete, report };
