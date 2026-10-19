'use strict';
// ============================================================
// scripts/collect-worker-child.cjs —— 确定性屏障测试的 worker 子进程
// 由 collect-restart-check.cjs  spawn；两种模式：
//   HANG：executor 写出 ready 信号（jobId/claimToken/attemptId）后**永久挂起**，
//         制造「job 已 claim、attempt running、无终态」的确定性崩溃点；
//   DONE：executor 完成该 attempt（success 落账）后正常退出。
// 数据目录/触发文件路径经 argv 传入；零外网依赖。
// ============================================================
const fs = require('fs');
const path = require('path');
const mode = process.argv[2] || 'HANG';
const readyFile = process.argv[3];
const doneFile = process.argv[4];

const ROOT = path.join(__dirname, '..');
const CollectJobs = require(path.join(ROOT, 'services', 'collect-jobs.js'));
const SurfaceStore = require(path.join(ROOT, 'services', 'surface-store.js'));

CollectJobs.setExecutorForTest(async (job) => {
  if (mode === 'HANG') {
    // 屏障：job=running、attempt=running、claimToken 非空——父进程断言后 SIGKILL 本进程
    fs.writeFileSync(readyFile, JSON.stringify({ jobId: job.jobId, claimToken: job.claimToken, attemptId: job.attemptId, pid: process.pid }));
    return new Promise(() => {}); // 永久挂起（绝不 resolve/reject）
  }
  // DONE：完成 attempt（真实终态落账，用于证明 reclaim 后能落终态）
  SurfaceStore.completeAttempt(job.tenantId, job.attemptId, {
    status: 'success', sourceStatus: 'success', observations: [],
    snapshotIds: [], evidenceIds: [],
    summary: { kind: 'storefront_catalog', count: 0, onSaleCount: 0, soldOutCount: 0, priceMin: null, priceMax: null, priceMedian: null, currency: null, currencyStatus: 'unknown', partialScan: false, partialScanReason: null, successfullyFetchedPages: null, failedPage: null },
  }, { jobId: job.jobId, token: job.claimToken });
  fs.writeFileSync(doneFile, JSON.stringify({ jobId: job.jobId, claimToken: job.claimToken }));
  return { attempt: SurfaceStore.getAttempt(job.tenantId, job.attemptId) };
});

// 常驻 worker 不启动（ZB_COLLECT_WORKER_DISABLED 由父进程设置）；显式触发 tick
(async () => {
  try { await CollectJobs.tick({ workerId: 'child-' + process.pid }); } catch (e) { /* 挂起模式不走这里 */ }
  if (mode === 'DONE') process.exit(0);
})();
