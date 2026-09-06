'use strict';
// =============================================================================
// 时间线器 (timeline.js) — 推理·分析合并计算层 · 算子 ④
// 文档 v0.5 · 第二部分 · 2.6 施工顺序第 4 条（依赖 events 表扩展 eventType）
//
// 职责：把某品牌的 events 时间序列，整理成「五年轨迹」——按时间排序、归类市场动作、
// 分段（按年）汇总，并给出可溯源统计。
//
// 设计铁律（红线 ④ · 时间线可溯源）：
//   每条轨迹事件都必须能追到 source + confidence。缺 source 的事件不丢弃（避免掩盖），
//   但显式标记为 unsourced=true，呈现层据此打「未溯源」角标，绝不把无来源事件伪装成事实。
//
// 其他：
//   - 纯函数：now 由调用方传入，核心无时钟/无网络/无随机（确定性、可回归）。
//   - eventType 枚举来自 metrics.js（launch/channel/price/.../data/other），
//     由 logEvent 写入；本模块只消费。
// =============================================================================

const M = require('./metrics.js');

const EVENT_TYPE_LABELS = {
  launch: '上线/新品', channel: '渠道变动', price: '价格/促销', collab: '联名/合作',
  funding: '融资', rebrand: '品牌重塑', expansion: '扩张/出海', contraction: '收缩/关店',
  leadership: '关键人事', acquisition: '并购', data: '数据层事件', other: '其他'
};

function eventTypeLabel(t) { return EVENT_TYPE_LABELS[t] || EVENT_TYPE_LABELS.other; }

// 把原始 event 规整为时间线条目（含溯源标记）。
function toEntry(e) {
  const source = e && e.source != null ? e.source : null;
  return {
    ts: e && e.ts ? e.ts : null,
    eventType: e && e.eventType ? e.eventType : 'other',
    eventTypeLabel: eventTypeLabel(e && e.eventType),
    changeType: e && e.changeType ? e.changeType : null,
    from: e && e.from != null ? e.from : null,
    to: e && e.to != null ? e.to : null,
    source,
    confidence: e && e.confidence != null ? e.confidence : null,
    sourced: !!source,                 // 红线④：是否可溯源
    competitorId: e && e.competitorId ? e.competitorId : null
  };
}

// =============================================================================
// 核心：buildTimeline({ competitorId, events, now, windowYears, includeTypes })
//   events: 原始事件数组（通常由 M.readEvents() 提供，本模块不负责 IO）。
//   now: 时间戳(ms) 或 ISO 字符串；窗口上界。
//   windowYears: 回溯年数（默认 5）。
//   includeTypes: 仅保留这些 eventType（如 ['launch','price']）；null=全保留；
//                 传入 'business' 等价于排除 'data' 与 'other'。
// 输出：{ competitorId, windowYears, startTs, endTs, events[], phases{}, stats }
// =============================================================================
function buildTimeline(opts) {
  opts = opts || {};
  const competitorId = opts.competitorId != null ? opts.competitorId : null;
  const now = opts.now != null ? (typeof opts.now === 'number' ? opts.now : new Date(opts.now).getTime()) : Date.now();
  const windowYears = opts.windowYears || 5;
  const MS_YEAR = 365 * 24 * 3600 * 1000;
  const startTs = now - windowYears * MS_YEAR;

  let raw = Array.isArray(opts.events) ? opts.events : [];

  // 过滤：品牌 + 时间窗口
  raw = raw.filter(e => {
    if (competitorId != null && (e.competitorId || null) !== competitorId) return false;
    const t = e.ts ? new Date(e.ts).getTime() : NaN;
    if (isNaN(t) || t < startTs || t > now) return false;
    return true;
  });

  // 类型过滤
  let include = opts.includeTypes || null;
  if (include === 'business') include = ['launch', 'channel', 'price', 'collab', 'funding', 'rebrand', 'expansion', 'contraction', 'leadership', 'acquisition'];
  if (Array.isArray(include) && include.length) {
    raw = raw.filter(e => include.indexOf(e.eventType) !== -1);
  }

  // 排序：时间升序（同 ts 按 changeType 字典序，保证确定性）
  raw.sort((a, b) => {
    const ta = a.ts ? new Date(a.ts).getTime() : 0;
    const tb = b.ts ? new Date(b.ts).getTime() : 0;
    if (ta !== tb) return ta - tb;
    return String(a.changeType || '').localeCompare(String(b.changeType || ''));
  });

  const events = raw.map(toEntry);

  // 分段（按自然年）
  const phases = {};
  for (const ev of events) {
    const yr = ev.ts ? new Date(ev.ts).getUTCFullYear() : 'unknown';
    if (!phases[yr]) phases[yr] = { year: yr, count: 0, byType: {}, sourced: 0, unsourced: 0 };
    phases[yr].count++;
    phases[yr].byType[ev.eventType] = (phases[yr].byType[ev.eventType] || 0) + 1;
    if (ev.sourced) phases[yr].sourced++; else phases[yr].unsourced++;
  }

  // 统计（红线④：溯源率必须透明）
  const sourcedCount = events.filter(e => e.sourced).length;
  const byType = {};
  for (const ev of events) byType[ev.eventType] = (byType[ev.eventType] || 0) + 1;

  return {
    competitorId,
    windowYears,
    startTs,
    endTs: now,
    events,
    phases,
    stats: {
      total: events.length,
      sourced: sourcedCount,
      unsourced: events.length - sourcedCount,
      traceabilityRate: events.length ? sourcedCount / events.length : 0, // 溯源率
      byType
    }
  };
}

// 便捷封装：直接从 metrics 存储读事件并建时间线（server 接线用）。
function buildBrandTimeline(competitorId, opts) {
  opts = opts || {};
  const events = M.readEvents();
  return buildTimeline(Object.assign({ competitorId }, opts, { events }));
}

module.exports = {
  EVENT_TYPE_LABELS,
  eventTypeLabel,
  buildTimeline,
  buildBrandTimeline,
  toEntry
};
