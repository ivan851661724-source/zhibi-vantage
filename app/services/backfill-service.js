'use strict';
// ============================================================
// services/backfill-service.js —— 历史回补任务执行器（SC-05 §4.5 / §5.2）
//
// 链路：CDX 发现 → 按月分桶（每月最多 1 点、默认 ≤24 点、digest 去重）→
//       逐点限速取回存档原始字节 → SourceSnapshot → Evidence → Memory 事实。
//
// 硬纪律：
//   · 终态不被覆盖（finishBackfillJob 内部保证）；重启后 running 租约过期 → 回 pending，
//     attempts 超限 → dead，绝不永久 running；
//   · 任何写库失败都不得产生「已回补」假象：只有 Evidence 落账成功才计入 imported；
//   · 用户文案不含 URL / 路径 / 栈 / 内部错误码 / 密钥；
//   · 同任务重复点击幂等（store 层按 scope+capability+时间范围复用运行中任务）。
// ============================================================
const Store = require('./competitive-memory-store.js');
const Memory = require('./competitive-memory.js');
const Archive = require('../research/web-archive.js');
const Snapshot = require('../research/source-snapshot.js');
const EvidenceStore = require('../research/evidence-store.js');
const Net = require('../research/net.js');

let _summarize = null;
// 延迟加载：复用 source-adapter 的同一份目录汇总口径（不另写第二套统计）
function AdapterSummarize() {
  if (!_summarize) _summarize = require('./source-adapter.js').summarize;
  return _summarize;
}

const WORKER_TICK_MS = 4000;
const MAX_ATTEMPTS = 3;
const MAX_POINTS = 24;
const POINT_DELAY_MS = Math.max(0, Number(process.env.ZB_BACKFILL_POINT_DELAY_MS) || 3000);

const USER_TEXT = Object.freeze({
  unreachable: '公开网页存档当前无法访问，本次未补入历史。可稍后重试。',
  blocked: '公开网页存档拒绝了本次访问，未补入历史。',
  rate_limited: '公开网页存档限流，本次已停止；稍后重试可继续。',
  parse_failed: '存档内容无法解析为商品目录，已跳过该时间点。',
  no_record: '公开网页存档中没有该时间范围的记录。',
  invalid_request: '回补参数不完整，请重新选择时间范围。',
  snapshot_failed: '存档内容未能保存为可核验来源，本次未补入历史。',
  internal: '历史回补未完成，请稍后重试。',
});

let _timer = null;
let _running = false;

function nowIso() { return new Date().toISOString(); }
function resolveCompetitor(tenantId, projectId, competitorId) {
  try {
    const { projFile } = require('../core/state-store.js');
    const fs = require('fs');
    const f = projFile(projectId, tenantId);
    if (!f || !fs.existsSync(f)) return null;
    const st = JSON.parse(fs.readFileSync(f, 'utf8'));
    const list = (st && Array.isArray(st.competitors)) ? st.competitors : [];
    return list.find(c => c && c.id === competitorId) || null;
  } catch (e) { return null; }
}

// 存档 products.json → 与 live 完全相同的解析器（mapShopifyItems + summarize）
function parseArchivedCatalog(buffer) {
  let json = null;
  try { json = JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '')); }
  catch (e) { return { ok: false, failureClass: 'parse_failed' }; }
  const products = json && Array.isArray(json.products) ? json.products : null;
  if (!products) return { ok: false, failureClass: 'parse_failed' };
  const items = Net.mapShopifyItems(products);
  const stats = AdapterSummarize()(items);
  return {
    ok: true, items,
    summary: Object.assign({}, stats, {
      // 存档的 products.json 不含店铺币种：币种一律未知，价格不可比（不推算、不借用当前币种）
      currency: null, currencyStatus: 'unknown',
      partialScan: false, partialScanReason: null,
      successfullyFetchedPages: 1, failedPage: null,
    }),
    sourceCount: products.length,
  };
}
// ---------------- 单任务执行 ----------------
async function runJob({ tenantId, jobId, workerToken }) {
  const token = workerToken || ('bf-' + process.pid + '-' + Date.now());
  const claimed = Store.claimBackfillJob(tenantId, jobId, token, Date.now());
  if (!claimed) return { ok: false, reason: 'not_claimable' };
  const job = claimed;
  const hb = setInterval(() => { try { Store.heartbeatBackfillJob(tenantId, jobId, token, Date.now()); } catch (e) {} }, 20000);
  let imported = 0, fetched = 0, skipped = 0, discovered = 0;
  const failures = [];
  try {
    const comp = resolveCompetitor(tenantId, job.projectId, job.competitorId);
    if (!comp || !comp.url) {
      Store.finishBackfillJob(tenantId, jobId, token, {
        status: 'failed', failureClass: 'competitor_unresolved', errorUserText: USER_TEXT.internal,
      });
      return { ok: false, reason: 'competitor_unresolved' };
    }
    const domain = Net.domainOf(comp.url);
    if (!domain) {
      Store.finishBackfillJob(tenantId, jobId, token, { status: 'failed', failureClass: 'domain_unresolved', errorUserText: USER_TEXT.internal });
      return { ok: false, reason: 'domain_unresolved' };
    }
    const catalogUrl = 'https://' + domain + '/products.json';
    const disc = await Archive.discoverSnapshots({
      url: catalogUrl, from: job.requestedFrom, to: job.requestedTo, limit: 400,
    });
    if (!disc.ok) {
      const cls = disc.failureClass || 'unreachable';
      // 本地设施故障不算「来源不可用」：来源没被证明有问题时不能甩锅给来源
      const isInternal = cls === 'internal';
      Store.finishBackfillJob(tenantId, jobId, token, {
        status: isInternal ? 'failed' : 'source_unavailable', failureClass: cls,
        errorUserText: USER_TEXT[cls] || USER_TEXT.unreachable,
        coverageSummary: { requested: { from: job.requestedFrom, to: job.requestedTo }, discovered: 0, imported: 0, note: '来源不可用，未补入任何历史数据。' },
      });
      return { ok: false, reason: 'discovery_failed', failureClass: cls };
    }
    const bucket = Archive.bucketByMonth(disc.rows, { maxPoints: MAX_POINTS });
    discovered = bucket.points.length;
    if (!bucket.points.length) {
      Store.finishBackfillJob(tenantId, jobId, token, {
        status: 'no_archive_record', failureClass: 'no_record',
        errorUserText: USER_TEXT.no_record,
        coverageSummary: { requested: { from: job.requestedFrom, to: job.requestedTo }, discovered: 0, imported: 0, note: '存档中无该范围记录，未补入任何历史数据。' },
      });
      return { ok: true, status: 'no_archive_record', imported: 0 };
    }
    Store.saveBackfillProgress(tenantId, jobId, token, { discovered, checkpoint: null });

    for (let i = 0; i < bucket.points.length; i++) {
      const p = bucket.points[i];
      const got = await Archive.fetchArchivedBody({
        timestamp: p.timestamp, originalUrl: catalogUrl,
        tenantId, trigger: 'backfill',
      });
      if (!got.ok) {
        skipped++;
        failures.push({ month: String(p.iso).slice(0, 7), cls: got.failureClass || 'unreachable' });
        Store.saveBackfillProgress(tenantId, jobId, token, {
          discovered, fetched, imported, skipped,
          checkpoint: String(p.iso).slice(0, 7),
          coverageSummary: coverageOf(job, bucket, imported, fetched, failures),
        });
        continue;
      }
      fetched++;
      const parsed = parseArchivedCatalog(got.buffer);
      if (!parsed.ok || !parsed.items.length) {
        skipped++;
        failures.push({ month: String(p.iso).slice(0, 7), cls: parsed.failureClass || 'parse_failed' });
        Store.saveBackfillProgress(tenantId, jobId, token, {
          discovered, fetched, imported, skipped, checkpoint: String(p.iso).slice(0, 7),
          coverageSummary: coverageOf(job, bucket, imported, fetched, failures),
        });
        continue;
      }
      // 🔴 先建 Evidence，再写事实——无 Evidence 一律不入已核实历史
      let evidenceId = null;
      try {
        const ev = EvidenceStore.recordEvidence({
          tenantId, projectRef: job.projectId, brandHint: comp.name || null,
          source: 'web_archive', provider: 'web_archive_shopify_products',
          source_snapshot_ids: [got.snapshotId],
          claim: { field: 'catalog.observation', scope: 'archived_catalog_observation' },
          entity_key: domain,
          entity_ref: { kind: 'storefront_domain', domain, archive_timestamp: p.timestamp },
          extracted_value: {
            summaryKind: 'storefront_catalog',
            count: parsed.summary.count, onSaleCount: parsed.summary.onSaleCount,
            soldOutCount: parsed.summary.soldOutCount,
            priceMin: parsed.summary.priceMin, priceMax: parsed.summary.priceMax,
            priceMedian: parsed.summary.priceMedian,
            currency: null, currencyStatus: 'unknown',
            partialScan: false, sourceObservedCount: parsed.sourceCount,
            archiveTimestamp: p.timestamp,
          },
          unit: null, currency: null, market: null,
          evidence_status: 'verified',
          parser_version: 'shopify-adapter-1',
          extractor_version: 'shopify-adapter-1',
          observed_at: got.observedAt,
          note: '历史存档观察：原始 URL ' + catalogUrl + '，存档时间 ' + p.timestamp + '（精度：日）',
        });
        if (ev && ev.recorded) evidenceId = ev.meta.evidence_id;
      } catch (e) {
        evidenceId = null;
      }
      if (!evidenceId) {
        skipped++;
        failures.push({ month: String(p.iso).slice(0, 7), cls: 'evidence_failed' });
        Store.saveBackfillProgress(tenantId, jobId, token, {
          discovered, fetched, imported, skipped, checkpoint: String(p.iso).slice(0, 7),
          coverageSummary: coverageOf(job, bucket, imported, fetched, failures),
        });
        continue;
      }
      const ing = Memory.ingestCatalogObservation({
        tenantId, projectId: job.projectId, competitorId: job.competitorId,
        domain, brandName: comp.name || null,
        items: parsed.items,
        summary: parsed.summary,
        snapshotIds: [got.snapshotId],
        evidenceIds: [evidenceId],
        sourceKind: 'archived_observation',
        effectiveAt: got.effectiveAt,
        timePrecision: 'day',
        observedAt: got.observedAt,
        parserVersion: 'shopify-adapter-1',
        sourceUrl: got.replayUrl,
      });
      if (!ing || !ing.ok) {
        skipped++;
        failures.push({ month: String(p.iso).slice(0, 7), cls: (ing && ing.reason) || 'ingest_failed' });
      } else {
        imported++;
      }
      Store.saveBackfillProgress(tenantId, jobId, token, {
        discovered, fetched, imported, skipped, checkpoint: String(p.iso).slice(0, 7),
        coverageSummary: coverageOf(job, bucket, imported, fetched, failures),
      });
      if (i < bucket.points.length - 1 && POINT_DELAY_MS) await new Promise(r => setTimeout(r, POINT_DELAY_MS));
    }

    const status = imported === 0 ? (failures.length ? 'source_unavailable' : 'no_archive_record')
      : (failures.length ? 'partial' : 'done');
    const firstFail = failures[0];
    Store.finishBackfillJob(tenantId, jobId, token, {
      status,
      discovered, fetched, imported, skipped,
      coverageSummary: coverageOf(job, bucket, imported, fetched, failures),
      failureClass: firstFail ? firstFail.cls : null,
      errorUserText: status === 'source_unavailable'
        ? (USER_TEXT[firstFail && firstFail.cls] || USER_TEXT.unreachable)
        : (status === 'partial' ? '部分时间点未能补入（' + failures.length + ' 个点失败），已补入 ' + imported + ' 个存档快照。' : null),
    });
    return { ok: true, status, imported, fetched, skipped, discovered, failures: failures.length };
  } catch (e) {
    try {
      Store.finishBackfillJob(tenantId, jobId, token, {
        status: 'failed', failureClass: 'internal', errorUserText: USER_TEXT.internal,
        discovered, fetched, imported, skipped,
      });
    } catch (e2) {}
    return { ok: false, reason: 'exception' };
  } finally {
    clearInterval(hb);
  }
}

function coverageOf(job, bucket, imported, fetched, failures) {
  return {
    requested: { from: job.requestedFrom, to: job.requestedTo },
    points: bucket.points.map(p => String(p.iso).slice(0, 7)),
    cap: bucket.cap,
    droppedByCap: bucket.droppedByCap,
    discoveredMonths: bucket.discoveredMonths,
    imported, fetched, failed: failures.length,
    failedMonths: failures.slice(0, 24).map(f => f.month),
    note: '每月最多取一个存档快照；未取到的月份是覆盖缺口。无记录不代表当期未发生价格或商品变动。',
  };
}

// ---------------- worker ----------------
async function tick(options) {
  const o = options || {};
  try { Store.reclaimExpiredBackfillJobs(Date.now(), MAX_ATTEMPTS); } catch (e) {}
  const pending = Store.pendingBackfillJobs(3);
  const results = [];
  for (const j of pending) {
    // pending 任务需要 tenantId；rowToJob 不暴露 tenantId（避免泄漏到 API），此处直接按 jobId 反查
    const row = Store.getDb().prepare('SELECT tenant_id FROM history_backfill_jobs WHERE job_id=?').get(j.jobId);
    if (!row) continue;
    const r = await runJob({ tenantId: row.tenant_id, jobId: j.jobId, workerToken: o.workerId || ('bf-w-' + process.pid) });
    results.push(Object.assign({ jobId: j.jobId }, r));
  }
  return { processed: results.length, results };
}

function startWorker() {
  if (_timer) return;
  _timer = setInterval(() => {
    if (_running) return;
    _running = true;
    tick().catch(() => {}).finally(() => { _running = false; });
  }, WORKER_TICK_MS);
  if (_timer.unref) _timer.unref();
}
function stopWorker() { if (_timer) { clearInterval(_timer); _timer = null; } }

// 供 API 直接触发（不等 tick 间隙）；fire-and-forget 但执行体在持久任务内
function kick(tenantId, jobId) {
  setImmediate(() => { runJob({ tenantId, jobId }).catch(() => {}); });
}

module.exports = {
  USER_TEXT, MAX_POINTS, MAX_ATTEMPTS,
  runJob, tick, startWorker, stopWorker, kick, parseArchivedCatalog, resolveCompetitor,
};
