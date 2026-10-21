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

// ---------- 非 Shopify：公开商品页直采（仅供已升级的正式监控使用） ----------
// 走 official_site_products adapter：robots/SSRF/快照/证据链与手动刷新完全一致；
// attempt 以 schedule 记账（03 §20 枚举内），窗口幂等仍由 watch_windows 保证。
async function collectPublicSiteProducts(comp, tid, pid, opts) {
  const Adapters = require('./source-adapter.js');
  const ad = Adapters.getAdapter('official_site_products');
  if (!ad) return { ok: false, error: 'adapter_missing' };
  const o = opts || {};
  let r = null;
  // 显式幂等键（按监控窗口）：窗口本身已保证至多一次有效执行，
  // 不能再让 capability 冷却把同一窗口的复采去重成「上一次的旧观察」——
  // 否则价格变化会被静默吞掉，窗口还会显示成功（E2E 实测缺陷）。
  try { r = await ad.collect({ tenantId: tid, projectId: pid, competitor: comp, trigger: 'schedule', idempotencyKey: o.idempotencyKey || undefined }); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  // 被去重 = 没有本次真实观察：如实失败（覆盖缺口），绝不拿旧 attempt 的观察冒充本轮结果
  if (r && r.deduped) return { ok: false, error: 'deduped', reason: 'observation_deduped' };
  const att = r && r.attempt;
  if (!att) return { ok: false, error: (r && (r.error || r.errorClass)) || 'fetch_failed' };
  if (att.status !== 'success' && att.status !== 'partial') {
    return {
      ok: false,
      status: att.sourceStatus === 'rate_limited' ? 429 : (att.sourceStatus === 'blocked' ? 403 : null),
      error: att.errorClass || 'fetch_failed',
    };
  }
  const obs = Array.isArray(att.observations) ? att.observations : [];
  const items = obs.filter(o => o && o.id && typeof o.price === 'number')
    .map(o => ({ id: o.id, repPrice: o.price, currency: o.currency || null, title: o.title || null, soldOut: false }));
  // 证据：来源快照（本轮真实抓取的页面快照）——价格变化事件据此才能标「已核实」
  return {
    ok: true, items,
    currency: (obs.map(o => o && o.currency).filter(Boolean)[0] || null),
    partialScan: att.status === 'partial',
    snapshotIds: Array.isArray(att.snapshotIds) ? att.snapshotIds : [],
    sourceUrl: att.sourceUrl || comp.url || null,
  };
}

// ---------- 价格变化 → 收件箱（SC-08 r2 §三：先写库，再决定提醒/计数/前移快照） ----------
// 返回 kind：verified | pending | duplicate | failed
//   · 只有 verified 才允许提醒并计入已核实
//   · pending 只计入待核实（提醒按待核实发）
//   · duplicate 不提醒、不计数（调用方仍可前移价格快照）
//   · failed 不提醒、不计数，且调用方**不得**落新快照 → 下次窗口重试这次变化
function applyPriceChange({ tid, pid, comp, ev, windowId, observedAt, sourceUrl, snapshotIds, alertsPushFn, inboxFn }) {
  let rec = null;
  try {
    const refs = [];
    for (const sid of (snapshotIds || []).slice(0, 3)) refs.push({ snapshotId: sid, sourceUrl: sourceUrl || null, observedAt });
    const delta = (typeof ev.old === 'number' && typeof ev.new === 'number') ? ev.new - ev.old : null;
    rec = (inboxFn || require('./intel-inbox.js')).recordEvent({
      tenantId: tid, projectId: pid, competitorId: comp.id,
      brandName: comp.name || null,
      dimension: 'price', eventType: 'price_changed',
      title: (ev.title ? ev.title + '：' : '') + '价格由 ' + (ev.oldDisplay != null ? ev.oldDisplay : ev.old) + ' 调整为 ' + (ev.display != null ? ev.display : ev.new),
      summary: (ev.title || '商品') + ' 价格 ' + ev.old + ' → ' + ev.new + (ev.deltaPct != null ? ('（' + (ev.deltaPct > 0 ? '+' : '') + ev.deltaPct + '%）') : ''),
      subjectId: ev.subjectId ? String(ev.subjectId) : null,
      observedAt,
      effectiveAt: null, // 无可靠发布时间来源 → null，不复制 observedAt
      sourceKind: 'live_observation', origin: 'monitoring',
      change: {
        field: 'price', oldValue: ev.old, newValue: ev.new,
        direction: delta == null ? null : (delta > 0 ? 'increase' : delta < 0 ? 'decrease' : 'flat'),
        delta: delta == null ? null : Number(delta.toFixed(2)),
        pct: ev.deltaPct != null ? ev.deltaPct : null,
        currency: ev.currency || null,
        basis: 'deterministic_diff',
      },
      evidenceRefs: refs,
      verificationStatus: refs.length ? 'verified' : 'pending',
      windowKey: windowId,
    });
  } catch (e) {
    rec = { recorded: false, reason: 'EXCEPTION' };
  }
  const kind = (rec && rec.recorded === true)
    ? (rec.verificationStatus === 'verified' ? 'verified' : 'pending')
    : (rec && rec.reason === 'DUPLICATE' ? 'duplicate' : 'failed');
  if (kind === 'verified' || kind === 'pending') {
    try {
      alertsPushFn(tid, {
        type: 'price-change', projectId: pid,
        competitorId: comp.id, competitorName: comp.name, subjectId: ev.subjectId,
        title: ev.title,
        text: (ev.title ? ev.title + '：' : '') + PH.describeChange(ev, () => ''),
        old: ev.old, new: ev.new,
        deltaPct: ev.deltaPct != null ? ev.deltaPct : null,
        currency: ev.currency, sourceUrl: sourceUrl || null, basis: kind === 'verified' ? 'verified' : 'pending',
      });
    } catch (e) { /* 推送失败不影响窗口落账 */ }
  }
  return { kind, rec };
}


// ---------- 非 Shopify：官网内容结构化指纹采集（SC-08 §三 C） ----------
// 走 official_site_profile adapter：SSRF/FetchGate/robots/重定向/大小/超时/快照/证据链
// 与手动刷新完全一致。返回稳定结构化指纹 + 证据引用；不在这里判定「变化」。
async function collectSiteFingerprint(comp, tid, pid, opts) {
  const Adapters = require('./source-adapter.js');
  const Snapshot = require('../research/source-snapshot.js');
  const FP = require('./site-fingerprint.js');
  const o = opts || {};
  const ad = Adapters.getAdapter('official_site_profile');
  if (!ad) return { ok: false, error: 'adapter_missing', reason: 'not_supported' };
  let r = null;
  // 显式幂等键：site_change 的「两次独立采集」不能被 capability 冷却吞掉
  //（冷却只对自动生成的时间桶键生效；显式键由调用方按窗口/探测序号自管）。
  try { r = await ad.collect({ tenantId: tid, projectId: pid, competitor: comp, trigger: 'schedule', idempotencyKey: o.idempotencyKey || undefined }); }
  catch (e) { return { ok: false, error: String((e && e.message) || e), reason: 'fetch_failed' }; }
  const att = r && r.attempt;
  if (!att) return { ok: false, error: (r && (r.error || r.errorClass)) || 'fetch_failed', reason: 'fetch_failed' };
  if (att.status !== 'success' && att.status !== 'partial') {
    const reason = att.sourceStatus === 'rate_limited' ? 'rate_limited'
      : (att.sourceStatus === 'blocked' ? 'blocked'
        : (att.sourceStatus === 'parse_failed' ? 'parse_failed' : 'fetch_failed'));
    return { ok: false, error: att.errorClass || reason, reason, sourceStatus: att.sourceStatus || null };
  }
  // 从快照回读原始 HTML 构指纹（不额外抓取：一次访问同时供证据与指纹使用）
  let html = null, snapUrl = null;
  for (const sid of (att.snapshotIds || [])) {
    const meta = Snapshot.getById(tid, sid);
    if (!meta) continue;
    let raw = null;
    try { raw = Snapshot.readRawPayload(meta); } catch (e) { raw = null; }
    if (!raw) continue;
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    if (/<html|<body|<title/i.test(text)) { html = text; snapUrl = meta.source_url || meta.final_url || null; break; }
  }
  if (!html) return { ok: false, error: 'raw_unavailable', reason: 'parse_failed', snapshotIds: att.snapshotIds || [], evidenceIds: att.evidenceIds || [] };
  const fingerprint = FP.buildFingerprint(html, snapUrl || att.sourceUrl || comp.url || '');
  const stability = FP.stabilityOf(fingerprint);
  const evidenceRefs = [];
  for (const eid of (att.evidenceIds || [])) evidenceRefs.push({ evidenceId: eid });
  for (const sid of (att.snapshotIds || []).slice(0, 3)) {
    const meta = Snapshot.getById(tid, sid);
    evidenceRefs.push({ snapshotId: sid, sourceUrl: meta ? (meta.source_url || null) : null, observedAt: att.endedAt || att.startedAt || null });
  }
  return {
    ok: true, fingerprint, stability, sourceUrl: snapUrl || att.sourceUrl || comp.url || null,
    evidenceRefs, attempt: att, partialScan: att.status === 'partial',
  };
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
  // 收件箱写入口（默认真实模块；测试可注入以验证「写库失败/重复」分支的行为）
  const inboxFn = deps.inboxFn || require('./intel-inbox.js');
  const signals = target.enabledSignals;
  const results = [];
  const failureReasons = {};
  let partialScan = false, eventsVerified = 0, anySuccess = false;
  // SC-08 r2 §三：事件写库结果的真实计数（不得把 pending/重复/写失败都算成「已核实」）
  let eventsPending = 0, eventsWriteFailed = 0, eventsDuplicate = 0;

  // 事件写入结果的唯一分类口径（§三 规则 1–6）：
  //   recorded && verified → 计入已核实（才允许提醒、才前移基线）
  //   recorded && pending  → 只计入待核实（提醒可按待核实发，但绝不进已核实）
  //   DUPLICATE            → 不重复提醒、不重复计数；允许前移基线（内容确实已是新状态）
  //   WRITE_FAILED / 拒收  → 不提醒、不计数、不前移基线（下次巡检必须能重试这次变化）
  const classifyInboxResult = (rec) => {
    if (rec && rec.recorded === true) {
      return rec.verificationStatus === 'verified' ? 'verified' : 'pending';
    }
    if (rec && rec.reason === 'DUPLICATE') return 'duplicate';
    return 'failed';
  };

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
    // 非 Shopify：只有「监控意向已升级为正式 Target」才会到这里（意向本身不被调度）。
    // SC-08 §三：price 与 site_change 是两条可并存的正式信号——
    //   · price：存在稳定商品价格源时（两次可比较采集后晋升）
    //   · site_change：官网可访问但暂无稳定价格时的**降级信号**（结构化字段变化）
    const unsupported = signals.filter(s => s !== 'price' && s !== 'site_change');
    for (const s of unsupported) attempt(s, false, 'not_supported'); // 上新/断货无发布时间与库存字段可核验
    if (signals.includes('site_change')) {
      let sres = null;
      try { sres = await (deps.siteFingerprintFn || collectSiteFingerprint)(comp, tid, pid, { idempotencyKey: 'site_snap:' + tid + ':' + pid + ':' + comp.id + ':' + windowId }); }
      catch (e) { sres = { ok: false, error: String((e && e.message) || e), reason: 'fetch_failed' }; }
      if (!sres || !sres.ok) {
        attempt('site_change', false, sres && sres.reason ? sres.reason : 'fetch_failed');
      } else {
        if (sres.partialScan) partialScan = true;
        try {
          const nowIsoS = new Date(now).toISOString();
          const baseline = WS.getSiteBaseline(tid, pid, comp.id);
          if (!baseline || !baseline.fingerprint) {
            // 首次成功观察：只存 baseline —— 不生成 inbox event（§二 字段规则 2）
            WS.saveSiteBaseline({
              tenantId: tid, projectId: pid, competitorId: comp.id,
              fingerprint: sres.fingerprint, stability: sres.stability, url: sres.sourceUrl, at: nowIsoS,
            });
            attempt('site_change', true);
          } else {
            const FP = require('./site-fingerprint.js');
            const diff = FP.diffFingerprints(baseline.fingerprint, sres.fingerprint);
            if (diff.comparable && diff.changes.length) {
              // 🔴 SC-08 r2 §三：顺序必须是 确定性 Diff → 写 intel_events → 再处理
              // 基线 / 窗口统计 / 提醒。先发提醒再写库会让「写失败」悄悄变成「已通知」。
              const first = diff.changes[0];
              const refs = (sres.evidenceRefs || []).slice(0, 6);
              const rec = inboxFn.recordEvent({
                tenantId: tid, projectId: pid, competitorId: comp.id,
                brandName: comp.name || null,
                dimension: 'website', eventType: 'website_changed',
                title: '官网内容变化：' + FP.describeChanges(diff.changes),
                summary: FP.describeChanges(diff.changes),
                subjectId: sres.sourceUrl || comp.url || null,
                observedAt: nowIsoS,
                // effectiveAt 无可靠来源 → null（不得复制 observedAt）
                effectiveAt: null,
                sourceKind: 'live_observation', origin: 'monitoring',
                change: {
                  field: first.field, oldValue: first.oldValue, newValue: first.newValue,
                  basis: 'deterministic_diff', fields: diff.changes.slice(0, 8).map(c => c.field),
                  detail: diff.changes.slice(0, 8),
                },
                evidenceRefs: refs,
                verificationStatus: refs.length ? 'verified' : 'pending',
                windowKey: windowId,
              });
              const kind = classifyInboxResult(rec);
              if (kind === 'verified') {
                eventsVerified += 1;
                try {
                  alertsPushFn(tid, {
                    type: 'site-change', projectId: pid,
                    competitorId: comp.id, competitorName: comp.name,
                    title: '官网内容变化', text: (comp.name || '竞品') + '：' + FP.describeChanges(diff.changes),
                    sourceUrl: sres.sourceUrl || comp.url || null, basis: 'verified',
                  });
                } catch (e) { /* 推送失败不影响窗口落账 */ }
                // baseline 前移：同一变化不会在后续窗口被重复报出
                WS.saveSiteBaseline({
                  tenantId: tid, projectId: pid, competitorId: comp.id,
                  fingerprint: sres.fingerprint, stability: sres.stability, url: sres.sourceUrl, at: nowIsoS,
                });
                attempt('site_change', true);
              } else if (kind === 'pending') {
                // 无证据事件：只计入待核实，不计入已核实；仍前移基线（避免同一变化反复报）
                eventsPending += 1;
                try {
                  alertsPushFn(tid, {
                    type: 'site-change', projectId: pid,
                    competitorId: comp.id, competitorName: comp.name,
                    title: '官网内容变化（待核实）', text: (comp.name || '竞品') + '：' + FP.describeChanges(diff.changes),
                    sourceUrl: sres.sourceUrl || comp.url || null, basis: 'pending',
                  });
                } catch (e) { /* 推送失败不影响窗口落账 */ }
                WS.saveSiteBaseline({
                  tenantId: tid, projectId: pid, competitorId: comp.id,
                  fingerprint: sres.fingerprint, stability: sres.stability, url: sres.sourceUrl, at: nowIsoS,
                });
                attempt('site_change', true);
              } else if (kind === 'duplicate') {
                // 重复事件：不提醒、不计数；可以前移基线（这次观察已被记录过）
                eventsDuplicate += 1;
                WS.saveSiteBaseline({
                  tenantId: tid, projectId: pid, competitorId: comp.id,
                  fingerprint: sres.fingerprint, stability: sres.stability, url: sres.sourceUrl, at: nowIsoS,
                });
                attempt('site_change', true);
              } else {
                // 写库失败：不提醒、不计数、不前移基线 —— 下次巡检必须重试这次变化。
                // 采集本身成功，但窗口必须如实登记这个缺口（不能仍显示完全成功）。
                eventsWriteFailed += 1;
                failureReasons.event_write_failed = (failureReasons.event_write_failed || 0) + 1;
                partialScan = true;
                attempt('site_change', true);
                try { Logger.error('intel event 写入失败（官网变化）', { tenantId: tid, projectId: pid, competitorId: comp.id, reason: (rec && rec.reason) || null }); } catch (e2) {}
              }
            } else {
              attempt('site_change', true);
            }
          }
        } catch (e) { attempt('site_change', false, 'parse_failed'); }
      }
    }
    if (signals.includes('price')) {
      let pres = null;
      const priceKey = 'price_snap:' + tid + ':' + pid + ':' + comp.id + ':' + windowId;
      try { pres = await (deps.publicSiteFn || collectPublicSiteProducts)(comp, tid, pid, { idempotencyKey: priceKey }); }
      catch (e) { pres = { ok: false, error: String((e && e.message) || e) }; }
      if (!pres || !pres.ok) {
        const reason = pres && pres.status === 429 ? 'rate_limited'
          : (pres && (pres.status === 403 || pres.status === 401) ? 'blocked' : 'fetch_failed');
        attempt('price', false, reason);
      } else {
        partialScan = !!pres.partialScan;
        try {
          const onSale = pres.items.filter(x => x && x.id != null && typeof x.repPrice === 'number' && x.repPrice > 0);
          const nowIsoS = new Date(now).toISOString();
          const currency = String(pres.currency || comp.currency || 'USD').toUpperCase();
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
              const ap = applyPriceChange({
                tid, pid, comp, ev: r2.event, windowId, observedAt: nowIsoS,
                sourceUrl: it.id || pres.sourceUrl || comp.url || null,
                snapshotIds: (pres && pres.snapshotIds) || [], alertsPushFn, inboxFn,
              });
              if (ap.kind === 'verified') eventsVerified += 1;
              else if (ap.kind === 'pending') eventsPending += 1;
              else if (ap.kind === 'duplicate') eventsDuplicate += 1;
              else {
                // 写库失败：不提醒、不计数、不落新快照 → 下个窗口重试这次变化
                eventsWriteFailed += 1;
                failureReasons.event_write_failed = (failureReasons.event_write_failed || 0) + 1;
                partialScan = true;
                continue;
              }
            }
            try { productPriceSaveFn(tid, pid, comp.id, entry); } catch (e) { /* 落库失败不影响窗口结论 */ }
          }
          attempt('price', true);
        } catch (e) { attempt('price', false, 'parse_failed'); }
      }
    }
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
              const ap = applyPriceChange({
                tid, pid, comp, ev: r2.event, windowId, observedAt: nowIsoS,
                sourceUrl: res.url || comp.url || null,
                snapshotIds: res.snapshotId ? [res.snapshotId] : (res.snapshotIds || []),
                alertsPushFn, inboxFn,
              });
              if (ap.kind === 'verified') eventsVerified += 1;
              else if (ap.kind === 'pending') eventsPending += 1;
              else if (ap.kind === 'duplicate') eventsDuplicate += 1;
              else {
                eventsWriteFailed += 1;
                failureReasons.event_write_failed = (failureReasons.event_write_failed || 0) + 1;
                partialScan = true;
                continue;
              }
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
  return {
    signalResults: results, attempted, succeeded, failed, partialScan, failureReasons, eventsVerified,
    eventsPending, eventsWriteFailed, eventsDuplicate, anySuccess,
  };
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
      const cov = (result.failed > 0 || result.partialScan || result.eventsWriteFailed > 0) ? 'gap' : 'full';
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

module.exports = { dueWindows, jitterMsFor, executeWindow, runDueWindows, startTick, stopTick, medianOf, collectPublicSiteProducts, collectSiteFingerprint };
