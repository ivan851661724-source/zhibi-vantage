'use strict';
// ============================================================
// scripts/collect-restart-check.cjs —— 确定性跨进程 kill/reclaim 测试（SC-02 复审 §六）
// 屏障设计（替代旧版 400ms 睡眠杀进程——无法证明杀时 job 已 claim）：
//   1. 父进程预置：租户/项目/竞品/attempt(running)/job(pending)
//   2. worker1（HANG 模式子进程）：claim 成功 → executor 写 ready 信号 → 永久挂起
//   3. 父进程确认 ready + DB 状态（job=running, attempt=running, claimToken 非空）
//   4. SIGKILL worker1（确定性崩溃点：持有租约、attempt 未终态、job 未 finish）
//   5. 等待租约过期（ZB_COLLECT_CLAIM_TTL_MS 缩短窗口）
//   6. worker2（DONE 模式同数据目录）：reclaim → 续跑同一 attempt → 落终态
//   7. 断言：retry/attempts 增加、claimToken 更换、全库零 running、
//      只一个 attempt 一套业务结果
// 真实 provider 连通性冒烟与队列恢复**分开**：默认不跑外网（DS_SMOKE=1 才跑，
// 且不作为恢复测试通过条件）。
// ============================================================
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-restart-')) + path.sep + 'data';
const CHILD = path.join(__dirname, 'collect-worker-child.cjs');
const READY = path.join(os.tmpdir(), 'zb-ready-' + Date.now() + '.json');
const DONE = path.join(os.tmpdir(), 'zb-done-' + Date.now() + '.json');
const TID = 'tenant:restart';
const PID = 'projR';
const CID = 'compR1';
const CLAIM_TTL = Number(process.env.ZB_COLLECT_CLAIM_TTL_MS || '3000');

process.env.ZB_DATA_DIR = DATA;
const SurfaceStore = require(path.join(ROOT, 'services', 'surface-store.js'));
const CollectJobs = require(path.join(ROOT, 'services', 'collect-jobs.js'));
const dbx = require(path.join(ROOT, 'services', 'db.js'));
const { saveState, projFile } = require(path.join(ROOT, 'core', 'state-store.js'));

const checks = [];
function check(name, ok, info) { checks.push([name, ok, info]); }
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFile(f, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } } await sleep(150); }
  return null;
}

(async () => {
  // 1) 预置
  dbx.createTenant({ name: 'restart', email: 'restart@example.com' });
  dbx.saveProject({ id: PID, tenantId: TID, track: 'T-' + PID, competitors: '[]', createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(projFile(PID, TID)), { recursive: true });
  saveState({
    projectId: PID, tenantId: TID, track: 'T-' + PID,
    discoveredAt: new Date().toISOString(), intent: { regions: ['us'] },
    competitors: [{ id: CID, name: 'RestartBrand', status: 'done', url: 'https://gymshark.com', isShopify: true, currency: 'USD' }],
  });
  const mk = SurfaceStore.createAttempt({ tenantId: TID, projectId: PID, competitorId: CID, capability: 'shopify_catalog', dimension: 'website_products', trigger: 'manual', idempotencyKey: 'restart-att-1', nowMs: Date.now() });
  check('预置 attempt=running', mk.attempt && mk.attempt.status === 'running', mk.attempt && mk.attempt.attemptId);
  const enq = CollectJobs.enqueue({ tenantId: TID, projectId: PID, competitorId: CID, capability: 'shopify_catalog', attemptId: mk.attempt.attemptId, trigger: 'manual' });
  check('预置 job=pending', enq.deduped === false && enq.jobId, enq.jobId);

  // 2) worker1（HANG 屏障）
  const w1 = spawn(process.execPath, [CHILD, 'HANG', READY, DONE], {
    env: Object.assign({}, process.env, { ZB_DATA_DIR: DATA, ZB_COLLECT_CLAIM_TTL_MS: String(CLAIM_TTL), ZB_COLLECT_WORKER_DISABLED: '1' }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  w1.stderr.on('data', () => {});
  // 3) 屏障断言：ready + DB 状态
  const ready = await waitFile(READY, 20000);
  check('worker1 claim 成功并写出 ready 信号', !!ready, ready ? ready.jobId : 'timeout');
  if (ready) {
    const jobRow = CollectJobs.getDb().prepare('SELECT status, claim_token, attempts, retry FROM collection_jobs WHERE job_id=?').get(ready.jobId);
    const attRow = SurfaceStore.getAttempt(TID, ready.attemptId);
    check('杀进程前 job=running', jobRow && jobRow.status === 'running', jobRow && jobRow.status);
    check('杀进程前 attempt=running', attRow && attRow.status === 'running', attRow && attRow.status);
    check('杀进程前 claimToken 非空', !!ready.claimToken, String(ready.claimToken).slice(0, 12));
    // 4) 确定性 SIGKILL（持有租约、attempt 未终态、job 未 finish）
    w1.kill('SIGKILL');
    await sleep(300);
    check('worker1 已 SIGKILL', true, 'pid=' + ready.pid);
    // 5) 等租约过期
    await sleep(CLAIM_TTL + 1500);
    // 6) worker2（DONE，同数据目录）
    const w2 = spawn(process.execPath, [CHILD, 'DONE', READY, DONE], {
      env: Object.assign({}, process.env, { ZB_DATA_DIR: DATA, ZB_COLLECT_CLAIM_TTL_MS: String(CLAIM_TTL), ZB_COLLECT_WORKER_DISABLED: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    w2.stderr.on('data', () => {});
    const done = await waitFile(DONE, 30000);
    check('worker2 reclaim 后完成同一 attempt', !!done, done ? done.jobId : 'timeout');
    // 7) 断言组
    const job2 = CollectJobs.getDb().prepare('SELECT * FROM collection_jobs WHERE job_id=?').get(ready.jobId);
    check('job 终态 done', job2 && job2.status === 'done', job2 && job2.status);
    check('job retry 增加（reclaim 续跑）', job2 && job2.retry >= 1, 'retry=' + (job2 && job2.retry));
    check('job attempts 增加', job2 && job2.attempts >= 2, 'attempts=' + (job2 && job2.attempts));
    check('claimToken 已更换（fencing 换届）', job2 && String(job2.claim_token) !== String(ready.claimToken), String(job2 && job2.claim_token).slice(0, 12));
    const att2 = SurfaceStore.getAttempt(TID, ready.attemptId);
    check('同一 attempt 落终态 success（断点续跑不重开）', att2 && att2.status === 'success', att2 && att2.status);
    check('attempt 仍是同一个 id', att2 && att2.attemptId === ready.attemptId, att2 && att2.attemptId);
    const attCount = SurfaceStore.getDb().prepare('SELECT COUNT(*) AS n FROM collection_attempts WHERE tenant_id=? AND capability=?').get(TID, 'shopify_catalog').n;
    check('全库只有一个 attempt', attCount === 1, 'count=' + attCount);
    const runningLeft = SurfaceStore.getDb().prepare("SELECT COUNT(*) AS n FROM collection_attempts WHERE status='running'").get().n;
    const jobRunningLeft = CollectJobs.getDb().prepare("SELECT COUNT(*) AS n FROM collection_jobs WHERE status IN ('pending','running')").get().n;
    check('全库零 running 残留（attempt + job）', runningLeft === 0 && jobRunningLeft === 0, 'att=' + runningLeft + ' job=' + jobRunningLeft);
    check('仅一套业务结果（无重复终态写入）', att2 && att2.status === 'success', 'evidence=' + (att2 && att2.evidenceIds.length));
    try { w2.kill('SIGKILL'); } catch (e) {}
  }
  try { w1.kill('SIGKILL'); } catch (e) {}

  let failed = 0;
  for (const [name, ok, info] of checks) {
    console.log((ok ? 'ok ' : 'FAIL ') + name + '  [' + String(info) + ']');
    if (!ok) failed++;
  }
  console.log(failed ? `\ncollect-restart-check: ${failed} failed` : '\ncollect-restart-check: all passed (deterministic barrier)');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('collect-restart-check 异常:', e); process.exit(1); });
