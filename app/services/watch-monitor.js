'use strict';
// ============================================================
// services/watch-monitor.js —— 正式监控执行器（WatchTarget 巡检 + 窗口 Coverage）
// ------------------------------------------------------------
// 规格依据：
//   · 03 v0.3 §12.1 调度唯一口径：Workspace 目标市场时区 06:00/14:00/22:00，
//     IANA 时区 + DST 自动处理，jitter 不改用户窗口语义，跨出容忍记 schedule_lag
//   · 03 v0.3 §12：必须经队列/认领派发（幂等认领 + 崩溃残留重新认领），
//     不允许"到点直接并发全部执行"
//   · 00 v1.2 §20/§21：fetch_failed / blocked / partial_scan 绝不生成 quiet；
//     quiet = window complete + coverage 达标 + 无 verified/actionable event
//   · 01 v1.3.3 §17.5 Monitoring ≠ Research：日常巡检走低成本直采
//     （Shopify /products.json 公开端点，零 LLM 零搜索），无意义变化不触发
//     完整 Research / Judgment LLM
//   · AGENTS.md Monitoring Rules：treat fetch failure/blocked as no_change 禁止
//
// 与旧 sweep（research/sweep.js）的关系：sweep 是研究活跃度驱动的观测雷达
// （近 30 天活跃项目），不承担正式监控资格；本模块只巡检用户明确「加入监控」
// 的 WatchTarget（monitoring_status='active'/'degraded'，整改 §2：degraded=降级运行
// ≠ 暂停，继续按计划窗口复查），二者正交（01 §16 / 整改 §3：WatchMonitor 是正式
// 监控的唯一资格边界，旧 sweep 不再调度、不发正式监控提醒、不重复抓取）。
// ============================================================
const fs = require('fs');
const WS = require('./watch-store.js');
const PH = require('../lib/price-history.js');
const WPrice = require('../lib/watch-price.js');
const StockStore = require('../research/stock-store.js');
const Net = require('../research/net.js');
const Alerts = require('./alerts.js');
const Logger = require('./logger.js');
const M = require('../lib/metrics.js');
const { projFile } = require('../core/state-store.js');

function medianOf(nums) {
  const s = nums.slice().sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// jitter：确定性派生（hash(windowKey + targetId) % 15min）——重启不变、无需计时器状态，
// 同一窗口的重试/补跑 jitter 恒定（03 §12.2：normal jitter ±15 分钟）
function jitterMsFor(windowKey, targetId) {
  const h = cryptoHash(windowKey + '|' + targetId);
  return h % WS.JITTER_MAX_MS;
}
function cryptoHash(s) {
  // 零依赖 FNV-1a 32bit（够 jitter 用，不需要加密强度）
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// 到点窗口计算：目标时区下「今天」的三个 slot；now 已过 slot+jitter → due。
// 补跑语义：服务重启后同一 windowKey 未认领 → 依然 due（当日补跑），窗口幂等由
// UNIQUE(watch_target_id, window_key) 保证至多一次有效执行。
function dueWindows(target, nowMs) {
  const { date } = WS.localParts(target.timezone, nowMs);
  const out = [];
  for (const slot of WS.WINDOW_SLOTS) {
    const scheduledTs = WS.zonedSlotUtc(target.timezone, date, slot);
    const fireAt = scheduledTs + jitterMsFor(date + 'T' + slot, target.watchTargetId);
    if (nowMs >= fireAt) out.push({ windowKey: date + 'T' + slot, slot, scheduledTs });
  }
  return out;
}

// ---------- 单目标单窗口执行（返回窗口级 Coverage 结果） ----------
// deps（全部可注入，测试用替身）：fetchFn / productPricesFn / productPriceSaveFn /
//   stockLoadFn / stockSaveFn / alertsPushFn
// 整改 §1：fetchFn 未注入时默认使用真实 Net.fetchShopifyProducts——生产巡检入口
// 永远走真实直采，测试替身只覆盖默认函数，禁止测试全部走注入路径。
async function executeWindow(target, windowId, deps, nowMs) {
  const now = nowMs || Date.now();
  const tid = target.tenantId, pid = target.projectId;
  const fetchFn = deps.fetchFn || Net.fetchShopifyProducts;
  const productPricesFn = deps.productPricesFn || WS.listProductPrices;
  const productPriceSaveFn = deps.productPriceSaveFn || WS.upsertProductPrice;
  const stockLoadFn = deps.stockLoadFn || StockStore.load;
  const stockSaveFn = deps.stockSaveFn || StockStore.save;
  const alertsPushFn = deps.alertsPushFn || Alerts.push;
  const signals = target.enabledSignals;
  const results = [];
  const failureReasons = {};
  let partialScan = false, eventsVerified = 0, anySuccess = false;

  let comp = null;
  try {
    const state = JSON.parse(fs.readFileSync(projFile(pid, tid), 'utf8'));
    comp = (state.competitors || []).find(c => c && c.id === target.competitorId) || null;
  } catch (e) { comp = null; }

  const attempt = (signal, ok, reason) => {
    results.push({ signal, attempted: 1, succeeded: ok ? 1 : 0, failed: ok ? 0 : 1, reason: ok ? null : reason });
    if (!ok) failureReasons[reason] = (failureReasons[reason] || 0) + 1;
    else anySuccess = true;
  };

  const shopifyReady = comp && comp.url && (comp.isShopify || /shopify/i.test(String(comp.url)));
  if (!comp) {
    // 竞品档案缺失（项目被删/竞品被移出）→ 信号不可执行：显式失败，不产生 quiet
    for (const s of signals) attempt(s, false, 'not_supported');
  } else if (!shopifyReady) {
    // 非 Shopify 直采通道未接入（05 冻结 capability 边界）→ not_supported，不冒充 no_change
    for (const s of signals) attempt(s, false, 'not_supported');
  } else {
    let res = null;
    try { res = await fetchFn(comp.url, { trigger: 'monitor', tenantId: tid }); }
    catch (e) { res = { ok: false, error: String((e && e.message) || e) }; }
    const failReasonOf = (r) => {
      if (r && r.error === 'parse_failed') return 'parse_failed';
      if (r && r.status === 429) return 'rate_limited';
      if (r && (r.status === 403 || r.status === 401)) return 'blocked';
      return 'fetch_failed';
    };
    if (!res || !res.ok || !Array.isArray(res.items)) {
      const reason = failReasonOf(res || {});
      for (const s of signals) attempt(s, false, reason);
      if (res && res.partialScan) partialScan = true;
    } else {
      partialScan = !!res.truncated || !!res.partialScan;
      const onSale = res.items.filter(x => x && x.id != null && typeof x.repPrice === 'number' && x.repPrice > 0 && !x.soldOut);
      const nowIsoS = new Date(now).toISOString();
      const currency = String(res.currency || comp.currency || 'USD').toUpperCase();
      // price（整改 §6）：按稳定商品身份逐品比较——同商品 id、同市场（WatchTarget 圈定）、
      // 同币种、同规格签名（变体数代理）才允许涨跌事件；新增/删除其他商品不影响原商品
      // 的比较（逐品独立）；目录中位数只作独立 Metric，绝不冒充单品 price-change。
      if (signals.includes('price')) {
        try {
          const prevList = productPricesFn(tid, pid, comp.id) || [];
          const byKey = new Map(prevList.map(p => [String(p.subjectId) + '|' + String(p.currency).toUpperCase(), p]));
          for (const it of onSale) {
            const prev = byKey.get(String(it.id) + '|' + currency) || null;
            const entry = {
              subjectId: String(it.id), currency,
              specSignature: WPrice.specSignatureOf(it),
              price: it.repPrice, display: String(it.repPrice), title: it.title || null, at: nowIsoS,
            };
            const r2 = WPrice.applyProductSnapshot(prev, entry);
            if (r2.event && r2.event.kind === 'changed') {
              eventsVerified++;
              try {
                alertsPushFn(tid, {
                  type: 'price-change', projectId: pid,
                  competitorId: comp.id, competitorName: comp.name, subjectId: r2.event.subjectId,
                  title: r2.event.title,
                  text: (r2.event.title ? r2.event.title + '：' : '') + PH.describeChange(r2.event, () => ''),
                  old: r2.event.old, new: r2.event.new,
                  deltaPct: r2.event.deltaPct != null ? r2.event.deltaPct : null,
                  currency: r2.event.currency, sourceUrl: res.url || comp.url || null, basis: 'verified',
                });
              } catch (e) { /* 推送失败不影响窗口落账 */ }
            }
            try { productPriceSaveFn(tid, pid, comp.id, entry); } catch (e) { /* 落库失败不影响窗口结论 */ }
          }
          attempt('price', true);
        } catch (e) { attempt('price', false, 'fetch_failed'); }
        // 目录中位数 → 独立 Metric（§6：只作指标记录，不产单品事件）
        try {
          const med = medianOf(onSale.map(x => x.repPrice));
          if (med != null) M.logEvent({ changeType: 'watch_catalog_median_price', competitorId: comp.id, to: String(med), source: res.url || comp.url || null, confidence: 'high', tenantId: tid });
        } catch (e) { /* 非致命 */ }
      }
      // launch / stock：同一份全量 products.json（canonical 合并：一次抓取喂多个信号）
      if (signals.includes('launch') || signals.includes('stock')) {
        try {
          const stockState = stockLoadFn(tid, pid); // 一次载入：entryOf 原地改、末尾一次存回（两次 load 会丢改动）
          const cur = StockStore.entryOf(stockState, comp.id);
          const ids = res.items.map(x => x.id).filter(x => x != null);
          const known = new Set(cur.productIds || []);
          const newIds = ids.filter(id => !known.has(id));
          const newIdSet = new Set(newIds);
          const soldOutNow = res.items.filter(x => x.soldOut).length;
          if (signals.includes('stock')) {
            if (soldOutNow > 0) {
              cur.soldOutStreak = (cur.soldOutStreak || 0) + 1;
              if (cur.soldOutStreak === 2) { // 滞回：连续 2 窗口才成事件（防单窗口噪声）
                eventsVerified++;
                try {
                  alertsPushFn(tid, { type: 'stockout', projectId: pid, competitorId: comp.id, competitorName: comp.name, text: `${comp.name} ${soldOutNow} 款断货`, count: soldOutNow, sourceUrl: comp.url || null, basis: 'verified' });
                } catch (e) {}
              }
            } else {
              cur.soldOutStreak = 0;
            }
            attempt('stock', true);
          }
          if (signals.includes('launch')) {
            if ((cur.productIds || []).length && newIds.length) {
              // 整改 §8：有发布时间佐证的数量 = withPub.length；区分「Vantage 首次观察到」
              // 与「来源证明的上市」——不能因为一款商品有 publishedAt 就把全部新 ID 标成已核实
              const withPub = res.items.filter(x => x.id != null && newIdSet.has(x.id) && x.publishedAt);
              if (withPub.length) {
                eventsVerified++;
                const observedOnly = newIds.length - withPub.length;
                try {
                  alertsPushFn(tid, {
                    type: 'product-launch', projectId: pid, competitorId: comp.id, competitorName: comp.name,
                    text: `${comp.name} 上新 ${withPub.length} 款（发布时间佐证）`
                      + (observedOnly > 0 ? `；另有 ${observedOnly} 款为 Vantage 首次观察到，暂无发布时间佐证，不计入已核实上新` : ''),
                    count: withPub.length, observedCount: newIds.length,
                    sourceUrl: comp.url || null, basis: 'verified',
                  });
                } catch (e) {}
              }
            }
            attempt('launch', true);
          }
          cur.productIds = ids.slice(-StockStore.MAX_IDS_PER_COMP);
          cur.updatedAt = nowIsoS;
          stockSaveFn(tid, pid, stockState);
        } catch (e) {
          for (const s of ['stock', 'launch']) if (signals.includes(s) && !results.find(r => r.signal === s)) attempt(s, false, 'fetch_failed');
        }
      }
    }
  }

  const attempted = results.reduce((n, r) => n + r.attempted, 0);
  const succeeded = results.reduce((n, r) => n + r.succeeded, 0);
  const failed = results.reduce((n, r) => n + r.failed, 0);
  return { signalResults: results, attempted, succeeded, failed, partialScan, failureReasons, eventsVerified, anySuccess };
}

// ---------- 一轮到点巡检 ----------
// 返回本轮执行的窗口数与结果（供调度日志/测试断言）
async function runDueWindows(opts) {
  const o = opts || {};
  const nowMs = o.nowMs || Date.now();
  const deps = o.deps || {};
  // 整改 §2：active + degraded 都进入巡检集合（degraded=降级运行≠暂停）；
  // paused/inactive 才停止巡检
  const targets = o.targets || WS.listSchedulableTargets();
  const out = { targets: targets.length, windows: [], skipped: 0 };
  for (const target of targets) {
    for (const due of dueWindows(target, nowMs)) {
      const claim = WS.claimWindow(target, due.windowKey, due.slot, due.scheduledTs, nowMs);
      if (!claim.claimed) { out.skipped++; continue; }
      let result;
      try {
        result = await executeWindow(target, claim.windowId, deps, nowMs);
      } catch (e) {
        WS.failWindow(claim.windowId, nowMs); // 窗口级异常 = 覆盖缺口，绝不落成"无变化"
        try { Logger.error('watch window 执行失败', { windowId: claim.windowId, err: String((e && e.message) || e).slice(0, 200) }); } catch (e2) {}
        out.windows.push({ windowId: claim.windowId, slot: due.slot, outcome: 'error' });
        continue;
      }
      WS.completeWindow(claim.windowId, result, nowMs);
      // 目标级状态推进：任一信号成功 → fresh + 基线完成；全部失败 → degraded
      if (result.anySuccess) WS.markSuccess(target.tenantId, target.watchTargetId, new Date(nowMs).toISOString());
      else WS.markDegraded(target.tenantId, target.watchTargetId);
      const cov = (result.failed > 0 || result.partialScan) ? 'gap' : 'full';
      out.windows.push({ windowId: claim.windowId, slot: due.slot, outcome: cov === 'full' ? 'full' : 'gap', failed: result.failed, partialScan: result.partialScan });
    }
  }
  try { WS.refreshFreshness(nowMs); } catch (e) { /* 非致命 */ }
  return out;
}

// ---------- 调度接入（03 §12：经认领派发，不"到点直接并发全部执行"——
// 本执行器串行遍历认领，单轮内逐窗口执行；tick 频率 5 min，远小于窗口粒度） ----------
let _timer = null;
function startTick(logger) {
  if (process.env.WATCH_MONITOR_ENABLED === '0') return null;
  if (_timer) return null; // 已启动
  const minutes = Math.max(1, parseInt(process.env.WATCH_TICK_MINUTES || '5', 10) || 5);
  // 启动补跑：进程重启后，当日已到点未认领的窗口在本轮立即补上
  const catchUp = setTimeout(() => { runDueWindows().catch(() => {}); }, 30 * 1000);
  if (catchUp.unref) catchUp.unref();
  _timer = setInterval(() => { runDueWindows().catch(() => {}); }, minutes * 60 * 1000);
  if (_timer.unref) _timer.unref();
  try { logger && logger.info && logger.info('watch monitor 已启动', { tickMinutes: minutes, slots: WS.WINDOW_SLOTS, policyVersion: WS.POLICY_VERSION }); } catch (e) {}
  return { tickMinutes: minutes };
}
function stopTick() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { dueWindows, jitterMsFor, executeWindow, runDueWindows, startTick, stopTick, medianOf };
