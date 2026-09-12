'use strict';
// ============================================================
// handlers/collect.js —— 采集/研究端点组（Phase 1 第二批迁移）
// stream / voice / sector / discover / enrich / lookup /
// timeline / brief / deepdive
// 全部经 ctx 依赖注入访问服务函数，不直接 require server.js。
// 逻辑与原 server.js 实现逐行对应（纯搬运，不改行为）。
// ============================================================

const { llmApiKey } = require('../../research/llm.js');
const { requestScope, curTenantId } = require('../../core/als.js');
const { marketCurrency } = require('../../research/vocab.js'); // B-7b：/api/sector 币种过滤口径

// ---------- /api/stream（GET：SSE 变化推送，按租户分通道） ----------
async function stream(ctx, req, res, url, p) {
  if (p !== '/api/stream' || req.method !== 'GET') return false;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  // 连接归属租户：入口层 resolveIdentity 已从 Bearer 或 ?token= 解出并注入 ALS；
  // sse-hub 按租户分通道投递（杜绝跨租户事件泄露），并限制每租户连接数（超限 503）。
  const tid = ctx.curTenantId ? ctx.curTenantId() : (ctx.resolveTenantId() || '_legacy');
  const cleanup = ctx.sseHub.connect(res, tid);
  if (!cleanup) {
    res.write('data: ' + JSON.stringify({ type: 'stream_rejected', reason: 'too_many_connections' }) + '\n\n');
    res.end();
    return true;
  }
  req.on('close', cleanup);
  return true; // 长连接，不 sendJSON
}

// ---------- /api/voice（POST：社媒/用户评论采集统一接口） ----------
async function voice(ctx, req, res, url, p) {
  if (p !== '/api/voice' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const brand = (body.brand || '').trim();
  if (!brand) return ctx.sendJSON(res, 400, { error: 'EMPTY', message: '请填写 brand' });
  const since = body.since || null;
  const maxItems = Number.isFinite(body.maxItems) ? Math.min(200, Math.max(1, body.maxItems)) : 50;
  const platforms = Array.isArray(body.platforms) && body.platforms.length ? body.platforms : undefined;
  // 失败源静默（文档第一部分纪律）；keyed 源未配置密钥时返回空，不报错。
  const collected = await ctx.VC.collectBrandVoice(brand, { since, maxItems, platforms, fetchImpl: fetch });
  const normalized = ctx.VC.voiceItemsToNormalized(collected, brand);
  return ctx.sendJSON(res, 200, {
    brand,
    count: collected.length,
    platforms: Array.from(new Set(collected.map(i => i.platform))),
    items: collected,
    normalizedCount: normalized.length,
    note: '社媒/评论采集统一接口：失败源静默；未配置密钥的源（Etsy/YouTube）返回空；Reddit/Trustpilot 走公开端点。'
  });
}

// ---------- /api/sector（POST：赛道分析：聚合 + 空白 + 趋势） ----------
async function sector(ctx, req, res, url, p) {
  if (p !== '/api/sector' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const st = ctx.loadState();
  const comps = (st && st.competitors) ? st.competitors : [];
  let subset = comps.filter(c => c && c.status === 'done');
  if (Array.isArray(body.brandNames) && body.brandNames.length) {
    const set = new Set(body.brandNames.map(String));
    const picked = subset.filter(c => set.has(c.name));
    subset = picked.length ? picked : comps.filter(c => set.has(c.name)); // 退化：允许未 done 的也应被纳入
  }
  const profiles = subset.map(c => ctx.Agg.brandProfileFromComp(c));
  // B-7b：传市场币种 → detected 币种不一致者被剔出集中度分母（currencyExcluded 计数）
  const sectorRes = ctx.Agg.buildSector({ name: body.sectorName || 'sector', brands: profiles, marketCurrency: marketCurrency(st.intent && st.intent.regions) });
  const whitespace = ctx.SW.computeSectorWhitespace({ competitors: subset });
  const trend = ctx.TR.buildTrendInferences(subset.length ? subset : comps);
  return ctx.sendJSON(res, 200, {
    sectorName: body.sectorName || 'sector',
    brandCount: subset.length,
    sector: sectorRes,
    whitespace,
    trend,
    note: '赛道事实（聚合不撒谎：赛道置信≤最弱品牌样本）；空白=竞争前沿内真缺失+分层×规模叠加；趋势每条带可证伪检验点。'
  });
}

// ---------- /api/discover（POST：发现竞品） ----------
const metering = require('../../services/metering.js');
async function discover(ctx, req, res, url, p) {
  if (p !== '/api/discover' || req.method !== 'POST') return false;
  // 并发护栏：研究任务满负荷时直接拒绝（经 ctx 闭包门读写 server.js 的 activeDiscovers）
  if (!ctx.discoverGate.enter()) {
    return ctx.sendJSON(res, 429, { error: 'TOO_BUSY', message: '研究服务正忙，请稍后再试。' });
  }
  // 早退路径需先释放并发闸（成功路径由 discoverLaunch 的 finally 释放）
  const fail = (code, obj) => { ctx.discoverGate.leave(); return ctx.sendJSON(res, code, obj); };
  // 单 IP 研究频率限制（更严格，区别于全局 POST 限流）
  if (ctx.rateLimited(ctx.clientIp(req), 'discover', 8, 60000)) {
    return fail(429, { error: 'RATE_LIMIT', message: '研究请求过于频繁，请稍后再试。' });
  }
  const body = await ctx.readBody(req);
  const track = (body.track || '').trim();
  if (!track) return fail(400, { error: '请填写你要做的赛道' });
  if (track.length > 200) return fail(400, { error: '赛道描述过长（上限 200 字）' });
  const config = ctx.loadConfig();
  // 密钥缺失：同步前置拦截，立即 401（异步管线无法再回 401）
  if (!ctx.activeSearchKey(config) || !llmApiKey(config)) {
    return fail(401, { error: 'NO_KEYS', message: '未配置 API 密钥，请在设置中填入搜索源与 LLM 密钥。' });
  }
  // R5.1：单免费档·每租户每日 N 次全景调研（防滥用上限；值 ZB_FREE_DAILY_DISCOVERS 可配）
  const _tid = ctx.curTenantId ? ctx.curTenantId() : '_legacy';
  if (!metering.withinDailyDiscover(_tid)) {
    return fail(429, {
      error: 'DISCOVER_QUOTA',
      message: '今日免费调研次数已用完（每租户每日 ' + metering.dailyDiscoverLimit() + ' 次）。明天再来，或留下联系方式加入候补名单（POST /api/waitlist）。',
      dailyUsage: metering.dailyDiscoverUsage(_tid),
    });
  }
  // 渐进式发现：异步启动管线，立即 202 返回 projectId；后续进度经 SSE /api/stream 推送。
  // 并发闸在 discoverLaunch 的 setImmediate 链末端 .finally 释放（成功/失败都释放）。
  const { projectId } = ctx.discoverLaunch(track, body.intent || {}, config, ctx.discoverGate);
  metering.recordDailyDiscover(_tid); // R5.1：占用一次每日额度
  return ctx.sendJSON(res, 202, { projectId, sessionId: projectId, status: 'accepted' });
}

// ---------- /api/enrich（POST：单对手富集） ----------
async function enrich(ctx, req, res, url, p) {
  if (p !== '/api/enrich' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const s = ctx.loadState();
  if (!s) return ctx.sendJSON(res, 404, { error: 'NO_STATE' });
  const config = ctx.loadConfig();
  const ok = ctx.enrichOne(body.competitorId, s, config);
  if (!ok) return ctx.sendJSON(res, 404, { error: 'NO_COMP' });
  return ctx.sendJSON(res, 200, { ok: true });
}

// ---------- /api/lookup（POST：用户直接检索一个具体品牌） ----------
async function lookup(ctx, req, res, url, p) {
  if (p !== '/api/lookup' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const name = (body.name || '').trim();
  if (!name) return ctx.sendJSON(res, 400, { error: 'EMPTY', message: '请填写品牌名' });
  const config = ctx.loadConfig();
  if (!config || !ctx.activeSearchKey(config) || !llmApiKey(config))
    return ctx.sendJSON(res, 401, { error: 'NO_KEYS', message: '未配置 API 密钥，请在设置中填入搜索源与 LLM 密钥。' });
  try {
    const s = await ctx.lookupBrand(name, body.url || '', config, body.intent);
    // 正向信号：用户手工补的"真对手"——算法漏了谁，比删了谁更有信息量
    if (body.userAdded) {
      s.addedCompetitors = Array.isArray(s.addedCompetitors) ? s.addedCompetitors : [];
      const nm = name.toLowerCase().trim();
      if (!s.addedCompetitors.some(x => (x.name || '').toLowerCase().trim() === nm)) {
        s.addedCompetitors.push({ name, track: s.track, at: new Date().toISOString() });
      }
      // 用户既然认它是对手，就把之前的压制解除，避免自相矛盾
      if (Array.isArray(s.suppressed)) s.suppressed = s.suppressed.filter(x => !(x.name === nm && x.track === s.track));
      ctx.saveState(s);
    }
    return ctx.sendJSON(res, 200, ctx.decorateState(s));
  } catch (e) {
    return ctx.sendJSON(res, 502, { error: 'LOOKUP_FAILED', message: String(e.message || e) });
  }
}

// ---------- /api/timeline（POST：时间线深度检索） ----------
async function timeline(ctx, req, res, url, p) {
  if (p !== '/api/timeline' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const s = ctx.loadState();
  if (!s) return ctx.sendJSON(res, 404, { error: 'NO_STATE' });
  const config = ctx.loadConfig();
  if (!config || !llmApiKey(config)) return ctx.sendJSON(res, 401, { error: 'NO_KEYS' });
  const comp = s.competitors.find(c => c.id === body.competitorId);
  if (!comp) return ctx.sendJSON(res, 404, { error: 'NO_COMP' });
  try {
    const tl = await ctx.deepTimelineOne(comp, s, config);
    return ctx.sendJSON(res, 200, tl);
  } catch (e) {
    return ctx.sendJSON(res, 502, { error: 'TIMELINE_FAILED', message: String(e.message || e) });
  }
}

// ---------- /api/brief（POST：行业调研报告） ----------
// B-4（2026-09-12 任务书）：brief 异步化 —— 同步段只做校验 + 落 briefStatus='running' 后立即 202；
// buildReport（LLM 40s+）转后台执行，消除 Next 代理 30s 断连与幽灵计费。
// 状态契约：GET /api/state → s.briefStatus: 'running'|'done'|'failed'（+ s.brief / s.briefError）。
async function brief(ctx, req, res, url, p) {
  if (p !== '/api/brief' || req.method !== 'POST') return false;
  const s = ctx.loadState();
  if (!s) return ctx.sendJSON(res, 404, { error: 'NO_STATE' });
  const config = ctx.loadConfig();
  if (!config || !llmApiKey(config)) return ctx.sendJSON(res, 401, { error: 'NO_KEYS' });
  const now = Date.now();
  // 幂等 + 僵尸恢复：running 中重复 POST 直接再回 202；running 超过 15 分钟视为
  // 进程重启遗留的僵尸态 → 标记 failed（不静默卡死），本次放行重跑。
  if (s.briefStatus === 'running') {
    const startedAt = Number(s.briefStartedAt) || 0;
    if (now - startedAt < 15 * 60 * 1000) return ctx.sendJSON(res, 202, { ok: true, status: 'running' });
    s.briefStatus = 'failed';
    s.briefError = 'brief 任务疑似中断（进程重启遗留），请重新发起';
  }
  s.briefStatus = 'running';
  s.briefStartedAt = now;
  delete s.briefError;
  ctx.saveState(s);
  // ⚠️ ALS 上下文重建：buildReport 内部经 curTenantId()/ALS 取租户，脱离请求的异步执行会丢失
  // AsyncLocalStorage 上下文（落到 '_legacy' 幽灵键）→ 必须在处理器内捕获 tid 并 requestScope.run 包裹。
  const tid = curTenantId();
  const task = async () => {
    // B-4 坑二（任务书 9/12 评审补充）：闭包 s 是 POST 时刻快照，后台 45-180s 期间
    // 纠错/排除/深研等并发 saveState 会被 LWW 整对象回写滚掉——终态落库前重读最新，
    // 只叠加 brief 字段，不整对象回写。
    const done = (patch) => {
      const cur = ctx.loadState() || s;
      Object.assign(cur, patch);
      ctx.saveState(cur);
    };
    try {
      const briefRes = await ctx.buildReport(s, config);
      done({ brief: briefRes, briefStatus: 'done' });
    } catch (e) {
      done({ briefStatus: 'failed', briefError: String((e && e.message) || e) });
    }
  };
  setImmediate(() => requestScope.run(tid, task));
  return ctx.sendJSON(res, 202, { ok: true, status: 'running' });
}

// ---------- /api/deepdive（POST：L2 单字段 / 单模块深挖） ----------
async function deepdive(ctx, req, res, url, p) {
  if (p !== '/api/deepdive' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const s = ctx.loadState();
  if (!s) return ctx.sendJSON(res, 404, { error: 'NO_STATE' });
  const config = ctx.loadConfig();
  if (!config || !ctx.activeSearchKey(config)) return ctx.sendJSON(res, 401, { error: 'NO_SEARCH_KEY' });
  const comp = s.competitors.find(c => c.id === (body.competitorId || '').trim());
  if (!comp) return ctx.sendJSON(res, 404, { error: 'NO_COMP' });
  // 字段级 / 模块级 显式区分：level==='module' 才按模块展开，避免与同名的字段 key 冲突
  const asModule = body.level === 'module';
  let fields = (asModule && ctx.L2_MODULE_FIELDS[body.field]) ? ctx.L2_MODULE_FIELDS[body.field] : [body.field];
  // 模块级：只补仍为空（未探测/已查未得）的字段，避免覆盖已有数据
  if (asModule && ctx.L2_MODULE_FIELDS[body.field]) {
    fields = fields.filter(f => ctx.attemptStateOf(comp, f) !== 'has');
  }
  const results = [];
  for (const f of fields) {
    try { results.push(Object.assign({ field: f }, await ctx.deepDiveField(s, comp, f, config))); }
    catch (e) { results.push({ field: f, ok: false, reason: 'exception:' + String(e.message || e) }); }
  }
  s.whiteSpace = ctx.computeWhiteSpace(s);
  ctx.saveState(s);
  return ctx.sendJSON(res, 200, { results, state: ctx.decorateState(s) });
}

module.exports = { stream, voice, sector, discover, enrich, lookup, timeline, brief, deepdive };
