'use strict';
// ============================================================
// test/sc10-r2.test.js —— SC-10 r2 合并前整改（服务级）
// ------------------------------------------------------------
// R1  品牌移出项目：链接回收、列表/详情不可见、历史保留、重新加入恢复
// R2  同品牌挂两个项目：只回收被移出项目的链接，另一项目不受影响
// R3  品牌移出项目：在途 job/attempt 双终结，零 running（与首采/监控取消一致）
// R4  官网变化写失败：日志只记安全 reason code（不抛 ReferenceError、不泄漏），
//     不提醒、不前移基线、窗口记缺口
// R5  跨租户隔离判定：仅 403/404 通过，200（含空列表）必须失败
// R6  migrate-db --check：执行前后数据目录逐字节不变（子进程实测）
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc10r2-'));
process.env.ZB_DATA_DIR = TMP;
process.env.SCHEDULER_ENABLED = '0';
process.env.ZB_COLLECT_WORKER_DISABLED = '1';
process.env.WATCH_MONITOR_ENABLED = '0';
process.env.ZB_INTENT_SCHEDULER = '0';
process.env.ZB_FIRST_COLLECTION_DISABLED = '1';
process.env.CACHE_ENABLED = '0';

const BrandSvc = require('../services/brand-service.js');
const BrandStore = require('../services/brand-store.js');
const CollectJobs = require('../services/collect-jobs.js');
const FC = require('../services/first-collection.js');
const { projFile, mirrorProjectToDb } = require('../core/state-store.js');
const db = require('../services/db.js');

const HOST = 'sc10r2-acme';
function comp(id, n, isShopify) {
  return {
    id, name: 'Brand' + n, url: `https://${HOST}-${n}.example.com/`, status: 'done',
    isShopify: !!isShopify, market: 'us', relation: 'competitor', category: 'outdoor',
  };
}
function writeProject(tenantId, projectId, comps) {
  const f = projFile(projectId, tenantId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({
    tenantId, projectId, intent: { regions: ['us'], category: 'outdoor' }, excluded: [],
    competitors: comps, discoverDone: true, progress: { total: comps.length, done: comps.length },
  }, null, 2));
}
function seedProject(tenantId, projectId, comps) {
  try { db.createTenant({ name: 't-' + tenantId, email: tenantId.replace(/[^a-z0-9]/gi, '') + '@example.com' }); } catch (e) {}
  try {
    db.saveProject({ id: projectId, tenantId, track: 'T-' + projectId, competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  } catch (e) {}
  writeProject(tenantId, projectId, comps);
  try { mirrorProjectToDb(projectId, tenantId, 'SC10R2'); } catch (e) {}
}

// ============================================================
// R1：品牌移出项目 → 回收 / 不可见 / 历史保留 / 重新加入恢复
// ============================================================
test('R1 品牌移出项目：链接回收，列表与详情不可见，历史数据保留，重新加入恢复', () => {
  const tid = 'tenant:r2r1', pid = 'projR2R1', cid = 'c-r1';
  seedProject(tid, pid, [comp(cid, 1)]);

  // 进入竞品数据库：同步建立链接 + 一条时间线历史
  BrandSvc.syncProjectBrands(tid, pid);
  const brandId = BrandStore.brandIdForCompetitor(tid, pid, cid);
  assert.ok(brandId, '链接已建立');
  BrandStore.appendTimeline({ tenantId: tid, brandId, kind: 'monitor', at: new Date().toISOString(), nature: 'observed', status: 'verified', title: '历史观察条目', refId: 'r1-hist' });
  assert.strictEqual(BrandStore.listBrandLinksForProject(tid, pid).length, 1, '前置：项目内 1 个品牌');

  // 品牌被移出项目（项目状态文件是成员关系事实源）
  writeProject(tid, pid, []);
  const r = BrandSvc.syncProjectBrands(tid, pid);
  assert.strictEqual(r.reclaimed, 1, '回收 1 条失效链接: ' + JSON.stringify(r));

  // 列表与详情均不可见
  assert.strictEqual(BrandStore.listBrandLinksForProject(tid, pid).length, 0, '竞品数据库列表不再显示该品牌');
  assert.strictEqual(BrandStore.getLink(tid, brandId, pid), null, '详情链接校验失败 → 上层 404 BRAND_NOT_IN_PROJECT');
  assert.strictEqual(BrandStore.brandIdForCompetitor(tid, pid, cid), null, '按 competitor_ref 反查也为空');

  // 历史数据一律保留（禁删品牌记录 / 时间线）
  assert.ok(BrandStore.getBrand(tid, brandId), '品牌记录保留');
  assert.strictEqual(BrandStore.listTimeline(tid, brandId, { limit: 10 }).length, 1, '品牌时间线保留');

  // 重新加入 → 恢复显示，历史仍在
  writeProject(tid, pid, [comp(cid, 1)]);
  const r2 = BrandSvc.syncProjectBrands(tid, pid);
  assert.strictEqual(r2.synced, 1);
  assert.strictEqual(BrandStore.listBrandLinksForProject(tid, pid).length, 1, '重新加入后恢复显示');
  assert.ok(BrandStore.getLink(tid, brandId, pid), '链接恢复');
  assert.strictEqual(BrandStore.listTimeline(tid, brandId, { limit: 10 }).length, 1, '历史数据仍在');
});

// ============================================================
// R2：同品牌挂两个项目 → 只回收被移出项目的链接
// ============================================================
test('R2 同品牌两个项目：只移除其中一个项目的链接，另一项目与其他历史不受影响', () => {
  const tid = 'tenant:r2r2', pidA = 'projR2R2A', pidB = 'projR2R2B', cid = 'c-r2';
  seedProject(tid, pidA, [comp(cid, 2)]);
  seedProject(tid, pidB, [comp(cid, 2)]);
  BrandSvc.syncProjectBrands(tid, pidA);
  BrandSvc.syncProjectBrands(tid, pidB);
  const brandId = BrandStore.brandIdForCompetitor(tid, pidA, cid);
  const brandIdB = BrandStore.brandIdForCompetitor(tid, pidB, cid);
  assert.strictEqual(brandId, brandIdB, '同域名同竞品 → 同一品牌记录');
  assert.strictEqual(BrandStore.linksForBrand(tid, brandId).length, 2, '两个项目各一条链接');

  // 只从 A 项目移出
  writeProject(tid, pidA, []);
  const r = BrandSvc.syncProjectBrands(tid, pidA);
  assert.strictEqual(r.reclaimed, 1, 'A 项目回收 1 条');
  assert.strictEqual(BrandStore.getLink(tid, brandId, pidA), null, 'A 项目链接已回收');
  assert.ok(BrandStore.getLink(tid, brandId, pidB), 'B 项目链接保留（其他项目对同一品牌的链接禁删）');
  assert.strictEqual(BrandStore.listBrandLinksForProject(tid, pidB).length, 1, 'B 项目列表仍显示');
  assert.ok(BrandStore.getBrand(tid, brandId), '品牌记录保留');
});

// ============================================================
// R3：品牌移出项目 → 在途 job/attempt 双终结，零 running
// ============================================================
test('R3 品牌移出项目：在途 job 与 attempt 双终结，不留 running，item 转 cancelled', () => {
  const tid = 'tenant:r2r3', pid = 'projR2R3', cid = 'c-r3';
  seedProject(tid, pid, [comp(cid, 3)]);
  BrandSvc.syncProjectBrands(tid, pid);
  // 真实首采批次（含入队 job + running attempt）
  FC.ensureBatch({ tenantId: tid, projectId: pid });
  const job = CollectJobs.getDb().prepare('SELECT * FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=? ORDER BY created_at DESC LIMIT 1')
    .get(tid, pid, cid);
  assert.ok(job, '首采已入队任务');
  const before = CollectJobs.getDb().prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=? AND status IN ('pending','running')").get(tid, pid, cid).n;
  assert.ok(before >= 1, '前置：存在未终结任务');

  // 移出品牌 → 同步对账
  writeProject(tid, pid, []);
  const r = BrandSvc.syncProjectBrands(tid, pid);
  assert.strictEqual(r.reclaimed, 1);

  const runningJobs = CollectJobs.getDb().prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE tenant_id=? AND project_id=? AND competitor_id=? AND status IN ('pending','running')").get(tid, pid, cid).n;
  assert.strictEqual(runningJobs, 0, '零 running/pending job');
  const runningAttempts = CollectJobs.getDb().prepare("SELECT COUNT(*) AS n FROM collection_attempts WHERE tenant_id=? AND project_id=? AND competitor_id=? AND status='running'").get(tid, pid, cid).n;
  assert.strictEqual(runningAttempts, 0, '零 running attempt');
  const after = CollectJobs.getDb().prepare('SELECT * FROM collection_jobs WHERE job_id=?').get(job.job_id);
  assert.ok(['done', 'error', 'dead'].includes(after.status), 'job 进入终态: ' + after.status);
  assert.strictEqual(after.last_error, 'brand_removed_from_project', 'job 留下可审计原因');
  const att = CollectJobs.getDb().prepare('SELECT * FROM collection_attempts WHERE attempt_id=?').get(job.attempt_id);
  if (att) {
    assert.notStrictEqual(att.status, 'running', 'attempt 不再 running');
    assert.strictEqual(att.error_class, 'cancelled_scope', 'attempt 归因为范围取消（不是来源故障）');
    assert.strictEqual(att.error_user_text, CollectJobs.CANCEL_TEXT, '用户可读原因');
  }
  // 首采 item 转 cancelled（不是失败），历史保留审计
  const items = CollectJobs.getDb().prepare('SELECT * FROM first_collection_items WHERE tenant_id=? AND project_id=? AND competitor_id=?').all(tid, pid, cid);
  assert.ok(items.length >= 1, '首采 item 存在');
  for (const it of items) {
    assert.strictEqual(it.state, 'cancelled', 'item 转 cancelled: ' + it.capability);
    assert.strictEqual(Number(it.in_scope), 0, 'item 不在册');
    assert.strictEqual(it.cancel_reason, 'brand_removed_from_project', '取消原因可审计');
  }
});

// ============================================================
// R4：官网变化写失败 —— 安全 reason code + 不提醒/不前移基线/窗口记缺口
// ============================================================
test('R4 官网变化写失败：日志记安全 reason code（无 ReferenceError/无泄漏），基线不前移', async () => {
  const WS = require('../services/watch-store.js');
  const WatchMonitor = require('../services/watch-monitor.js');
  const Inbox = require('../services/intel-inbox.js');
  const tid = 'tenant:r2r4', pid = 'projR2R4', cid = 'c-r4';
  seedProject(tid, pid, [comp(cid, 4, false)]);
  BrandSvc.syncProjectBrands(tid, pid);
  const t = WS.createWatchTarget({
    tenantId: tid, projectId: pid, competitorId: cid,
    market: 'us', timezone: 'UTC', enabledSignals: ['site_change'], supportedSignals: ['site_change'],
    enrichmentStatus: 'complete',
  }).target;

  // 第一窗：建立官网指纹基线（注入稳定的 siteFingerprintFn 替身）
  // 直接注入指纹采集替身：两次返回不同指纹 → 第二次产生变化
  const mkFp = (n) => ({
    ok: true,
    fingerprint: { title: 'T' + n, h1: 'H' + n, productCount: n, hasCart: true, canonical: 'https://x.example.com/' },
    stability: 'stable',
    sourceUrl: 'https://' + HOST + '-4.example.com/?token=SECRET-SHOULD-NOT-LEAK',
    evidenceRefs: [{ snapshotId: 'snap-r4-' + n, sourceUrl: 'https://' + HOST + '-4.example.com/?token=SECRET-SHOULD-NOT-LEAK' }],
    partialScan: false,
  });
  const w1 = WS.claimWindow(t, 'R4-W1', '06:00', Date.now(), Date.now());
  await WatchMonitor.executeWindow(t, w1.windowId, { siteFingerprintFn: async () => mkFp(1) }, Date.now());
  const baseline1 = WS.getSiteBaseline(tid, pid, cid);
  assert.ok(baseline1 && baseline1.fingerprint, '首窗只建基线');

  // 第二窗：指纹变化 + 收件箱写入失败（reason 带冒号后的原文，模拟数据库错误文本）
  const alerts = [];
  const brokenInbox = { recordEvent: () => ({ recorded: false, reason: 'WRITE_FAILED:SQLITE_BUSY at /srv/zhibi/data/brands.db line 42 body=secret' }) };
  const w2 = WS.claimWindow(t, 'R4-W2', '14:00', Date.now(), Date.now());
  const r2 = await WatchMonitor.executeWindow(t, w2.windowId, {
    siteFingerprintFn: async () => mkFp(2),
    inboxFn: brokenInbox,
    alertsPushFn: (tt, a) => alerts.push(a),
  }, Date.now());
  assert.strictEqual(r2.eventsWriteFailed, 1, '如实登记写失败: ' + JSON.stringify(r2));
  assert.strictEqual(r2.eventsVerified, 0, '写失败不计已核实');
  assert.strictEqual(alerts.length, 0, '写失败不发提醒');
  assert.strictEqual(r2.partialScan, true, '窗口显示覆盖缺口');
  const baseline2 = WS.getSiteBaseline(tid, pid, cid);
  assert.strictEqual(JSON.stringify(baseline2.fingerprint), JSON.stringify(baseline1.fingerprint), '基线不前移 → 下窗可重试');
  assert.strictEqual(Inbox.listInbox({ tenantId: tid, projectId: pid }).total, 0, '无事件落库');

  // 安全 reason code 提取（不泄漏 URL/密钥/栈/正文；只取冒号前代码段）
  const { safeReasonCode } = require('../services/watch-monitor.js');
  assert.strictEqual(safeReasonCode({ rec: { recorded: false, reason: 'WRITE_FAILED:SQLITE_BUSY at /srv/zhibi/data/brands.db line 42 body=secret' } }), 'WRITE_FAILED', '只保留冒号前代码段');
  assert.strictEqual(safeReasonCode({ rec: { recorded: false, reason: 'INVALID_WINDOW_KEY' } }), 'INVALID_WINDOW_KEY');
  assert.strictEqual(safeReasonCode({ rec: { recorded: false, reason: '奇怪的理由带空格和正文' } }), 'REDACTED', '非白名单 → REDACTED');
  assert.strictEqual(safeReasonCode({ rec: null }), null);
  assert.strictEqual(safeReasonCode(null), null);
});

// ============================================================
// R5：跨租户隔离判定逻辑（200+空列表必须失败）
// ============================================================
test('R5 跨租户隔离判定：仅 403/404 通过；200（含空列表）必须失败', () => {
  const { classifyIsolation } = require('../../scripts/staging-smoke.js');
  assert.strictEqual(classifyIsolation(403), true);
  assert.strictEqual(classifyIsolation(404), true);
  assert.strictEqual(classifyIsolation(200), false, '200 = 隔离失效，必须失败（哪怕返回空列表）');
  assert.strictEqual(classifyIsolation(401), false);
  assert.strictEqual(classifyIsolation(500), false);
});

// ============================================================
// R6：migrate-db --check 执行前后数据目录逐字节不变
// ============================================================
function fingerprintTree(dir) {
  const out = {};
  const walk = (rel) => {
    const abs = rel ? path.join(dir, rel) : dir;
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) { walk(childRel); continue; }
      const st = fs.statSync(path.join(dir, childRel));
      out[childRel] = { size: st.size, mtimeMs: st.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, childRel))).digest('hex') };
    }
  };
  walk('');
  return out;
}

test('R6 migrate-db --check：执行前后数据目录逐字节不变（清单/大小/mtime/SHA-256）', () => {
  // 先在独立数据目录跑一次真实迁移，造出含 WAL 的库
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-sc10r2-mig-'));
  execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'migrate-db.js')], {
    env: Object.assign({}, process.env, { ZB_DATA_DIR: dir }), encoding: 'utf8',
  });
  assert.ok(fs.readdirSync(dir).some(f => f.endsWith('.db')), '迁移产生 .db');
  // 制造一个未 checkpoint 的 WAL（真实运行态），并放一个盐值文件 + 子目录 json
  const { DatabaseSync } = require('node:sqlite');
  const h = new DatabaseSync(path.join(dir, 'brands.db'));
  h.exec('PRAGMA journal_mode = WAL');
  h.prepare('INSERT INTO brand_records (brand_id, tenant_id, canonical_name, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run('br_probe', 'tenant:probe', 'Probe', new Date().toISOString(), new Date().toISOString());
  // 不 close：保留 -wal/-shm，模拟"服务刚停"的运行态
  fs.writeFileSync(path.join(dir, '.obs-salt'), 'salt-probe');
  fs.mkdirSync(path.join(dir, 'research', 'tenant_probe'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'research', 'tenant_probe', 'p.json'), '{"projectId":"p"}');

  const before = fingerprintTree(dir);
  const r = execFileSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'migrate-db.js'), '--check'], {
    env: Object.assign({}, process.env, { ZB_DATA_DIR: dir }), encoding: 'utf8',
  });
  const after = fingerprintTree(dir);
  assert.deepStrictEqual(after, before, '--check 前后目录必须逐字节一致（含 -wal/-shm/盐值/子目录）');
  assert.match(r, /只读核验通过/, '--check 输出只读核验通过: ' + r.slice(-200));
  h.close();
});
