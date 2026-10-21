'use strict';
// ============================================================
// scripts/migration-collection-bootstrap.js —— 已有项目首轮采集一次性迁移命令
// （SC-07 r2 §三：受控迁移命令；旧项目不依赖最终用户点击即开始首轮采集）
// ------------------------------------------------------------
// 用法（工程人员在部署机上执行，唯一入口）：
//   ZB_DATA_DIR=<数据目录> node app/scripts/migration-collection-bootstrap.js \
//     [--dry-run] [--max-projects 50] [--per-project-limit 50] \
//     [--max-reviews-per-project 5] [--max-reviews-total 25]
//
// 行为：
//   · 扫描尚无采集 attempt 的现有项目，逐项目执行首轮采集计划
//    （collection-plan.bootstrapProject：官网资料/Shopify 目录/公开商品/公开评论）；
//   · 一次性幂等：已迁移（done）的项目直接跳过——重复执行不重复建任务、不重复计费；
//   · 并发保护：running 行带 10 分钟租约，另一进程在跑时自动跳过；
//   · 数量与搜索调用上限见 --max-* 参数；
//   · 每品牌逐项决策落 collection_plan_log 台账（入队/跳过/失败+原因）。
//
// 核验查询（执行前后各跑一次对比）：
//   ① node -e "require('ZB_DATA_DIR 注入后').services..." —— 见脚本输出末尾
//      的 jobCounts 与迁移状态清单（同库 collection_migrations / collection_jobs）；
//   ② 或用 sqlite3 直接查：
//      SELECT status, COUNT(*) FROM collection_migrations GROUP BY status;
//      SELECT status, COUNT(*) FROM collection_jobs GROUP BY status;
//      SELECT decision, capability, COUNT(*) FROM collection_plan_log
//        WHERE created_at > <执行时间> GROUP BY decision, capability;
//
// 只读凭据存在性，不读取、不打印任何密钥值。
// ============================================================

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

function main() {
  const Migration = require('../services/collection-migration.js');
  const opts = {
    dryRun: !!arg('dry-run', false),
    maxProjects: Number(arg('max-projects', 50)) || 50,
    perProjectLimit: Number(arg('per-project-limit', 50)) || 50,
    maxReviewsPerProject: Number(arg('max-reviews-per-project', 5)) || 5,
    maxReviewsTotal: Number(arg('max-reviews-total', 25)) || 25,
  };
  console.log('[migration] 开始：' + JSON.stringify({ migrationId: Migration.MIGRATION_ID, ...opts }));
  const before = Migration.jobCounts();
  const out = Migration.runMigration(opts);
  console.log(JSON.stringify({
    ok: out.ok, dryRun: out.dryRun, scanned: out.scanned, migrated: out.migrated,
    skippedDone: out.skippedDone, skippedRunning: out.skippedRunning,
    skippedHasAttempts: out.skippedHasAttempts, failed: out.failed,
    budget: out.budget, perProject: out.perProject,
    jobCountsBefore: before, jobCountsAfter: out.jobCountsAfter,
  }, null, 2));
  console.log('\n迁移状态清单（collection_migrations）：');
  console.log(Migration.listRecords().map(r =>
    [r.tenantId, r.projectId, r.status, r.reason || '-', r.finishedAt || '-'].join(' | ')
  ).join('\n'));
  process.exit(out.ok ? 0 : 1);
}

main();
