'use strict';
// ============================================================
// handlers/correction.js —— 纠错闭环 + 意图/排除/反馈端点组
// field-correct / field-review / field-correct/revoke /
// intent / exclude / feedback
// 忠实助理红线：用户对全局库无写入权——纠错走私有覆盖层或
// 遗留 ghost 通道，绝不开全局写权后门（PRD v2.1 / §五）。
// 逻辑与原 server.js 实现逐行对应（纯搬运，不改行为）。
// ============================================================

// ---------- /api/field-correct（POST：字段级纠错闭环） ----------
async function fieldCorrect(ctx, req, res, url, p) {
  if (p !== '/api/field-correct' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const id = (body.id || '').trim();
  const field = (body.field || '').trim();
  const type = body.type;
  const s = ctx.loadState();
  if (!s) return ctx.sendJSON(res, 404, { error: 'NO_STATE' });
  const comp = s.competitors.find(c => c.id === id);
  if (!comp) return ctx.sendJSON(res, 404, { error: 'NO_COMP' });
  // T2-1 主权隔离：解析真实登录用户身份，决定纠错走「私有覆盖层」还是「遗留全局写入」。
  const _ident = ctx.resolveIdentity(req, ctx.config0);
  const _isPrivate = !_ident.error && !_ident.ghost && !!_ident.userId;
  const _isLegacyGlobal = _ident.ghost === true;
  const _tid = _ident.tenantId || ctx.curTenantId();
  const _uid = _ident.userId || 'owner';
  const CHANNELS = ctx.CHANNELS;
  const CATEGORIES = ctx.CATEGORIES;
  const isPrice = /^price/.test(field);
  const isChannel = /^channels\./.test(field);
  const isCategory = /^categories\./.test(field);
  const isLaunch = field === 'launchCadence';
  const isReviewScalar = field === 'reviews.rating' || field === 'reviews.trend';
  const isReviewSet = /^reviews\.(negThemes|posThemes)\./.test(field);
  const isScalar = isLaunch || isReviewScalar;
  if (!isPrice && !isChannel && !isCategory && !isScalar && !isReviewSet) return ctx.sendJSON(res, 400, { error: 'UNSUPPORTED_FIELD', hint: '当前支持 price / channels.<key> / categories.<key> / launchCadence / reviews.rating / reviews.trend / reviews.negThemes.<主题> / reviews.posThemes.<主题> 闭环' });
  // 渠道 / 品类字段须是合法 key
  let chKey = null, catKey = null;
  if (isChannel) {
    chKey = field.split('.')[1];
    if (!CHANNELS.includes(chKey)) return ctx.sendJSON(res, 400, { error: 'BAD_CHANNEL', hint: '未知渠道：' + chKey });
  }
  if (isCategory) {
    catKey = field.split('.')[1];
    // 品类为全赛道自由文本：仅在仍配置受控词表（CATEGORIES 非空）时校验，否则放行自由词
    if (CATEGORIES.length && !CATEGORIES.includes(catKey)) return ctx.sendJSON(res, 400, { error: 'BAD_CATEGORY', hint: '未知品类：' + catKey });
  }
  // 各字段允许的纠错类型
  const PRICE_TYPES = ['wrong-value', 'wrong-currency', 'missing-source', 'over-confident', 'confirm-correct'];
  const CHAN_TYPES = ['wrong-state', 'missing-source', 'over-confident', 'confirm-correct'];
  const CAT_TYPES = ['wrong-state', 'missing-source', 'over-confident', 'confirm-correct'];
  const SCALAR_TYPES = ['wrong-value', 'over-confident', 'confirm-correct', 'missing-source'];
  const SET_TYPES = CHAN_TYPES; // 集合类（渠道/品类/口碑主题）共享 wrong-state 类
  const okTypes = isPrice ? PRICE_TYPES : (isChannel ? CHAN_TYPES : (isCategory ? CAT_TYPES : (isReviewSet ? SET_TYPES : SCALAR_TYPES)));
  if (!okTypes.includes(type)) return ctx.sendJSON(res, 400, { error: 'BAD_TYPE', hint: '该字段不支持此纠错类型' });
  let val = null, cur = null;
  if (isPrice && type === 'wrong-value') {
    if (Array.isArray(body.value)) val = body.value.map(Number);
    else if (body.value && typeof body.value === 'object') val = [Number(body.value.min), Number(body.value.max)];
    else if (typeof body.value === 'number') val = [body.value, body.value];
    if (!val || val.some(n => isNaN(n))) return ctx.sendJSON(res, 400, { error: 'BAD_VALUE', hint: 'wrong-value 需提供 {min,max} 或 [min,max]' });
  }
  if (isPrice && type === 'wrong-currency') {
    cur = (body.currency || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) return ctx.sendJSON(res, 400, { error: 'BAD_CURRENCY', hint: '请填 3 位币种代码，如 USD / CNY / EUR' });
  }
  if (isChannel && type === 'wrong-state') {
    const v = (body.value || '').trim();
    if (!['present', 'absent', 'undetected'].includes(v)) return ctx.sendJSON(res, 400, { error: 'BAD_VALUE', hint: 'wrong-state 需提供 present / absent / undetected' });
    val = v;
  }
  if (isCategory && type === 'wrong-state') {
    const v = (body.value || '').trim();
    if (!['present', 'absent', 'undetected'].includes(v)) return ctx.sendJSON(res, 400, { error: 'BAD_VALUE', hint: 'wrong-state 需提供 present / absent / undetected' });
    val = v;
  }
  if (isReviewSet && type === 'wrong-state') {
    const v = (body.value || '').trim();
    if (!['present', 'absent', 'undetected'].includes(v)) return ctx.sendJSON(res, 400, { error: 'BAD_VALUE', hint: 'wrong-state 需提供 present / absent / undetected' });
    val = v;
  }
  if (isScalar && type === 'wrong-value') {
    const v = (body.valueText || '').trim() || (typeof body.value === 'string' ? body.value.trim() : '');
    if (!v) return ctx.sendJSON(res, 400, { error: 'BAD_VALUE', hint: 'wrong-value 需提供正确取值文本（如：月更及以上）' });
    val = v;
  }
  const source = (body.source || '').trim();
  const actor = String(req.headers['x-actor'] || body.actor || 'owner').slice(0, 40);
  const fcId = 'fc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
  // PRD §7.3 硬约束：confirm-correct（确认现值正确）无风险，零延迟生效；其余纠错须附来源、进待复核队列
  let status, reviewedAt = null, reviewer = null;
  if (type === 'confirm-correct') {
    status = 'accepted';
  } else {
    if (!source) return ctx.sendJSON(res, 400, { error: 'NO_SOURCE', message: '请附上证据来源，否则我们无法受理（忠实助理红线：纠错不直接改写可信结论）。' });
    status = 'pending';
  }
  // 工作流 C：纠错前先快照当前系统显示值（algoValue）与算法原通道(method)
  let prevValue = null;
  let prevChannel = null;
  if (isPrice) { prevValue = JSON.stringify(comp.priceField || null); prevChannel = (comp.priceField && comp.priceField.method) || null; }
  else if (isChannel) { prevValue = JSON.stringify((comp.channelFields || {})[chKey] || null); prevChannel = (comp.channelFields && comp.channelFields[chKey] && comp.channelFields[chKey].method) || null; }
  else if (isCategory) { prevValue = JSON.stringify((comp.categoryFields || {})[catKey] || null); prevChannel = (comp.categoryFields && comp.categoryFields[catKey] && comp.categoryFields[catKey].method) || null; }
  else if (isScalar) { prevValue = JSON.stringify(comp.launchCadence || null); prevChannel = (comp.launchCadence && comp.launchCadence.method) || null; }
  else if (isReviewScalar || isReviewSet) { prevValue = JSON.stringify(comp.reviewField || null); prevChannel = (comp.reviewField && comp.reviewField.method) || null; }
  const corr = {
    id: fcId, competitorId: id, field, type,
    value: val,
    currency: cur,
    text: (body.text || '').slice(0, 200),
    source,
    actor,
    status,
    reviewedAt,
    reviewer,
    prevValue: prevValue ? prevValue.slice(0, 200) : null,
    prevChannel: prevChannel ? String(prevChannel).slice(0, 40) : null, // #2：算法原通道（field.method）
    at: new Date().toISOString()
  };
  if (_isPrivate) {
    // —— 私有覆盖分支（T2-1 红线）——
    ctx.correctionOverlay.setCorrection(_tid, _uid, corr);
    const myCorrs = ctx.correctionOverlay.getCorrections(_tid, _uid, id);
    let priceField, channelField, categoryField, launchCadence, reviewField;
    if (isPrice) priceField = ctx.getPriceField(comp, myCorrs.filter(c => /^price/.test(c.field || '')));
    if (isChannel) { const cf = {}; CHANNELS.forEach(k => { cf[k] = ctx.getChannelField(comp, myCorrs, k); }); channelField = cf[chKey]; }
    if (isCategory) { const cf = {}; CATEGORIES.forEach(k => { cf[k] = ctx.getCategoryField(comp, myCorrs, k); }); categoryField = cf[catKey]; }
    if (isScalar) launchCadence = ctx.getLaunchCadence(comp, myCorrs);
    if (isReviewScalar || isReviewSet) reviewField = ctx.getReviewField(comp, myCorrs);
    const resp = {
      ok: true, correction: corr, status: corr.status, private: true,
      message: corr.status === 'pending'
        ? '已记录你的私有纠错（仅你可见，不直接改写系统结论，待复核后触发系统重采）'
        : '已记录你的私有覆盖（仅你可见，不影响系统结论）',
      state: ctx.decorateState(s) // s 未改动 → 系统态；前端再叠加私有值
    };
    if (isPrice) { resp.priceField = priceField; resp.systemPriceField = comp.priceField; }
    if (isChannel) { resp.channelField = channelField; resp.systemChannelField = (comp.channelFields || {})[chKey]; }
    if (isCategory) { resp.categoryField = categoryField; resp.systemCategoryField = (comp.categoryFields || {})[catKey]; }
    if (isScalar) { resp.launchCadence = launchCadence; resp.systemLaunchCadence = comp.launchCadence; }
    if (isReviewScalar || isReviewSet) { resp.reviewField = reviewField; resp.systemReviewField = comp.reviewField; }
    return ctx.sendJSON(res, 200, resp);
  } else if (_isLegacyGlobal) {
    // —— 遗留/幽灵通道：保持旧全局写入行为（仅 x-legacy-key 显式通道）——
    s.fieldCorrections = Array.isArray(s.fieldCorrections) ? s.fieldCorrections : [];
    s.fieldCorrections.push(corr);
    // 即时重算（硬信号零延迟生效）
    const cidFilter = c => c.competitorId === id;
    if (isPrice) comp.priceField = ctx.getPriceField(comp, s.fieldCorrections.filter(c => cidFilter(c) && c.field === 'price'));
    if (isChannel) { comp.channelFields = comp.channelFields || {}; CHANNELS.forEach(k => { comp.channelFields[k] = ctx.getChannelField(comp, s.fieldCorrections.filter(cidFilter), k); }); }
    if (isCategory) { comp.categoryFields = comp.categoryFields || {}; CATEGORIES.forEach(k => { comp.categoryFields[k] = ctx.getCategoryField(comp, s.fieldCorrections.filter(cidFilter), k); }); }
    if (isScalar) comp.launchCadence = ctx.getLaunchCadence(comp, s.fieldCorrections.filter(cidFilter));
    if (isReviewScalar || isReviewSet) comp.reviewField = ctx.getReviewField(comp, s.fieldCorrections.filter(cidFilter));
    ctx.saveState(s);
    const resp = { ok: true, correction: corr, status: corr.status, private: false, message: corr.status === 'pending' ? '已收到，作为复核触发信号（系统将重新采集核验，不直接改写全局结论）' : '已记录（不直接改写全局结论）', state: ctx.decorateState(s) };
    if (isPrice) resp.priceField = comp.priceField;
    if (isChannel) resp.channelField = (comp.channelFields || {})[chKey];
    if (isCategory) resp.categoryField = (comp.categoryFields || {})[catKey];
    if (isScalar) resp.launchCadence = comp.launchCadence;
    if (isReviewScalar || isReviewSet) resp.reviewField = comp.reviewField;
    return ctx.sendJSON(res, 200, resp);
  } else {
    // 解析失败 / 生产无有效 userId：绝不开全局写权后门，拒绝
    return ctx.sendJSON(res, 401, { error: 'IDENTITY_UNRESOLVED', message: '身份无法解析，纠错被拒绝（请重新登录后再试）。' });
  }
}

// ---------- /api/field-review（POST：纠错复核） ----------
async function fieldReview(ctx, req, res, url, p) {
  if (p !== '/api/field-review' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const fcId = (body.id || '').trim();
  const decision = body.decision === 'accept' ? 'accept' : body.decision === 'reject' ? 'reject' : '';
  if (!fcId || !decision) return ctx.sendJSON(res, 400, { error: 'BAD_INPUT', message: '缺少纠错 id 或裁决' });
  const s = ctx.loadState();
  if (!s) return ctx.sendJSON(res, 404, { error: 'NO_STATE' });
  // T2-1：真实用户纠错在私有层，故 review 优先查私有层；遗留全局纠错走 s.fieldCorrections。
  const _ident = ctx.resolveIdentity(req, ctx.config0);
  const _isPrivate = !_ident.error && !_ident.ghost && !!_ident.userId;
  const _isLegacyGlobal = _ident.ghost === true;
  const _tid = _ident.tenantId || ctx.curTenantId();
  const _uid = _ident.userId || 'owner';
  let corr, isOverlay = false;
  if (_isPrivate) { corr = ctx.correctionOverlay.findById(_tid, _uid, fcId); isOverlay = !!corr; }
  else if (_isLegacyGlobal) { corr = (s.fieldCorrections || []).find(x => x.id === fcId); }
  else { return ctx.sendJSON(res, 401, { error: 'IDENTITY_UNRESOLVED', message: '身份无法解析，纠错操作被拒绝（请重新登录后再试）。' }); }
  if (!corr) return ctx.sendJSON(res, 404, { error: 'NO_CORR' });
  corr.status = decision === 'accept' ? 'accepted' : 'rejected';
  if (decision === 'accept') {
    // ▶ PRD v2.1 §0 数据主权：复核通过 = 一条"复核触发信号"，系统随后重新采集核验并自行修正
    ctx.M.logEvent({ changeType: 'field_review_trigger', competitorId: corr.competitorId, from: corr.field, to: 'reverify-trigger', source: corr.source || null, confidence: 'high' });
    const back = ctx.M.correctionToAccuracySample(corr);
    corr.reverify = true;
  }
  corr.reviewedAt = new Date().toISOString();
  corr.reviewer = String(req.headers['x-actor'] || body.reviewer || 'owner').slice(0, 40);
  if (isOverlay) ctx.correctionOverlay.updateById(_tid, _uid, fcId, { status: corr.status, reverify: corr.reverify, reviewedAt: corr.reviewedAt, reviewer: corr.reviewer });
  else ctx.saveState(s);
  return ctx.sendJSON(res, 200, {
    ok: true,
    correction: corr,
    private: isOverlay,
    state: ctx.decorateState(s),
    message: decision === 'accept'
      ? '已标记为该字段的复核触发信号（系统将重新采集核验并自行修正，不直接改写全局结论）'
      : '已驳回该纠错，仅留痕'
  });
}

// ---------- /api/field-correct/revoke（POST：纠错撤销） ----------
async function fieldRevoke(ctx, req, res, url, p) {
  if (p !== '/api/field-correct/revoke' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const fcId = (body.id || '').trim();
  if (!fcId) return ctx.sendJSON(res, 400, { error: 'BAD_INPUT', message: '缺少纠错 id' });
  const s = ctx.loadState();
  if (!s) return ctx.sendJSON(res, 404, { error: 'NO_STATE' });
  const _ident = ctx.resolveIdentity(req, ctx.config0);
  const _isPrivate = !_ident.error && !_ident.ghost && !!_ident.userId;
  const _isLegacyGlobal = _ident.ghost === true;
  const _tid = _ident.tenantId || ctx.curTenantId();
  const _uid = _ident.userId || 'owner';
  let corr, isOverlay = false;
  if (_isPrivate) { corr = ctx.correctionOverlay.findById(_tid, _uid, fcId); isOverlay = !!corr; }
  else if (_isLegacyGlobal) { corr = (s.fieldCorrections || []).find(x => x.id === fcId); }
  else { return ctx.sendJSON(res, 401, { error: 'IDENTITY_UNRESOLVED', message: '身份无法解析，纠错操作被拒绝（请重新登录后再试）。' }); }
  if (!corr) return ctx.sendJSON(res, 404, { error: 'NO_CORR' });
  corr.status = 'revoked';
  corr.reviewedAt = new Date().toISOString();
  corr.reviewer = String(req.headers['x-actor'] || body.reviewer || 'owner').slice(0, 40);
  // #4：撤销回滚——删除对应准确率样本并重建汇总，避免已撤销纠错继续污染维度准确率
  const dropped = ctx.M.deleteAccuracySample('fc-' + fcId);
  if (isOverlay) ctx.correctionOverlay.updateById(_tid, _uid, fcId, { status: 'revoked', reviewedAt: corr.reviewedAt, reviewer: corr.reviewer });
  else ctx.saveState(s);
  return ctx.sendJSON(res, 200, { ok: true, correction: corr, private: isOverlay, state: ctx.decorateState(s), accuracyRolledBack: dropped && dropped.removed ? dropped.removed : 0 });
}

// ---------- /api/intent（POST：设定调研意图） ----------
async function intent(ctx, req, res, url, p) {
  if (p !== '/api/intent' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const s = ctx.loadState();
  if (!s) return ctx.sendJSON(res, 404, { error: 'NO_STATE' });
  s.intent = ctx.normalizeIntent(body.intent || {});
  ctx.saveState(s);
  return ctx.sendJSON(res, 200, ctx.decorateState(s));
}

// ---------- /api/exclude（POST：排除/拉回竞品，防确认偏误：只记录不阻止） ----------
async function exclude(ctx, req, res, url, p) {
  if (p !== '/api/exclude' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const id = (body.id || '').trim();
  const action = body.action === 'restore' ? 'restore' : 'remove';
  const reason = ctx.EXCLUDE_REASONS[body.reason] ? body.reason : 'irrelevant';
  const s = ctx.loadState();
  if (!s) return ctx.sendJSON(res, 404, { error: 'NO_STATE' });
  const comp = s.competitors.find(c => c.id === id);
  if (!comp) return ctx.sendJSON(res, 404, { error: 'NO_COMP' });
  s.excluded = Array.isArray(s.excluded) ? s.excluded : [];
  s.excludedReasons = s.excludedReasons || {};
  s.suppressed = Array.isArray(s.suppressed) ? s.suppressed : [];
  const nm = (comp.name || '').toLowerCase().trim();
  if (action === 'remove') {
    if (!s.excluded.includes(id)) s.excluded.push(id);
    s.excludedReasons[id] = reason; // 记原因，喂养算法迭代
    if (nm && !s.suppressed.some(x => x.name === nm && x.track === s.track)) {
      // 连同证据快照一起存：规则提炼要看"当初为什么被选进来"，不能只有名字
      s.suppressed.push({
        name: nm, track: s.track, reason, at: new Date().toISOString(),
        url: comp.url || '', why: comp.why || '', positioning: ctx.posSummary(comp) || '',
      });
    }
  } else {
    s.excluded = s.excluded.filter(x => x !== id);
    delete s.excludedReasons[id];
    s.suppressed = s.suppressed.filter(x => !(x.name === nm && x.track === s.track));
  }
  s.whiteSpace = ctx.computeWhiteSpace(s);
  ctx.saveState(s);
  return ctx.sendJSON(res, 200, ctx.decorateState(s));
}

// ---------- /api/feedback（POST：弱信号反馈计数） ----------
async function feedback(ctx, req, res, url, p) {
  if (p !== '/api/feedback' || req.method !== 'POST') return false;
  const body = await ctx.readBody(req);
  const s = ctx.loadState();
  if (!s) return ctx.sendJSON(res, 404, { error: 'NO_STATE' });
  s.signals = s.signals || {};
  const cid = body.competitorId || 'global';
  s.signals[cid] = s.signals[cid] || { views: 0, stars: 0, ignore: 0 };
  if (body.action === 'view') s.signals[cid].views++;
  if (body.action === 'star') s.signals[cid].stars++;
  if (body.action === 'ignore') s.signals[cid].ignore++;
  ctx.saveState(s);
  return ctx.sendJSON(res, 200, { ok: true });
}

module.exports = { fieldCorrect, fieldReview, fieldRevoke, intent, exclude, feedback };
