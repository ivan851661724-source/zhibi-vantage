'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// research/attempts.js —— 导出: logAttempt, fieldHasDataOnServer, attemptStateOf, attemptsFor
// ============================================================

// 采集层 attempt 日志：记录每个字段/模块"查过什么、是否命中、为何没命中"。
// 这是空字段三态（unprobed / attempted_empty / unavailable）的地基，供 #51 渲染时区分。
// hit: true=命中, false=执行成功但零结果, null=探测失败（异常/超时，不等同于"查过没有"）。
function logAttempt(comp, field, query, source, hit, reason) {
  if (!comp) return;
  if (!Array.isArray(comp.attempts)) comp.attempts = [];
  comp.attempts.push({
    field: String(field || ''),
    query: String(query || ''),
    source: String(source || 'unknown'),
    hit: hit === true ? true : hit === false ? false : null,
    reason: String(reason || ''),
    time: new Date().toISOString()
  });
}
// 服务端镜像前端 attemptState：has / attempted_empty / unprobed
function fieldHasDataOnServer(comp, field) {
  switch (field) {
    case 'price': return !!(comp.pricePoints && comp.pricePoints.length) || !!comp.priceBand;
    case 'sellingPoints': return (comp.sellingPoints || []).length > 0;
    case 'positioning': return !!comp.positioning;
    case 'products': return (comp.products || []).length > 0;
    case 'audiences': return (comp.audiences || []).length > 0;
    case 'channels': return Object.keys(comp.channels || {}).some(k => comp.channels[k].present);
    case 'reviews': return !!(comp.reviews && (comp.reviews.rating != null || (comp.reviews.posThemes || []).length || (comp.reviews.negThemes || []).length));
    case 'painPoints': return (comp.painPoints || []).length > 0;
    case 'tactics': return (comp.tactics || []).length > 0;
    case 'contentForms': return (comp.contentForms || []).length > 0;
    case 'collabTypes': return (comp.collabTypes || []).length > 0;
    case 'fulfillment': return (comp.fulfillment || []).length > 0;
    case 'recentMoves': return (comp.recentMoves || []).length > 0;
    case 'estSize': return !!comp.estSize;
    case 'techStack': return !!comp.techStack;
    default: return false;
  }
}
function attemptStateOf(comp, field) {
  const a = ((comp && comp.attempts) || []).filter(x => x.field === field);
  if (!a.length) return fieldHasDataOnServer(comp, field) ? 'has' : 'unprobed';
  if (a.some(x => x.hit) || fieldHasDataOnServer(comp, field)) return 'has';
  return 'attempted_empty';
}
// 取某字段的全部 attempt 记录（按时间升序）
function attemptsFor(comp, field) {
  if (!comp || !Array.isArray(comp.attempts) || !field) return [];
  return comp.attempts.filter(a => a.field === field);
}


module.exports = { logAttempt, fieldHasDataOnServer, attemptStateOf, attemptsFor };
