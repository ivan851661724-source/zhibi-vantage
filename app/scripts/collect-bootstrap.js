'use strict';
// ============================================================
// scripts/collect-bootstrap.js —— 项目首轮采集补建（运维/测试服一次性入口）
// ------------------------------------------------------------
// SC-07 §1：已有项目不能只靠用户逐个点刷新。此脚本与
// POST /api/data-surface/bootstrap 走同一实现（services/collection-plan.js），
// 复用既有幂等/冷却/额度/attempt/worker 链路；可重复执行，不重复产生任务。
//
// 用法：
//   node scripts/collect-bootstrap.js --tenant tenant:xxxx --project 项目id [--limit 20] [--max-reviews 5] [--dry-run]
//   省略 --project 时使用该租户「当前项目」（state-store current 指针）。
//
// 只读凭据存在性，不读取、不打印任何密钥值。
// ============================================================
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

function main() {
  const tenantId = String(arg('tenant', '') || '').trim();
  if (!tenantId) {
    console.error('缺少 --tenant（例如 tenant:xxxxxxxx）');
    process.exit(2);
  }
  let projectId = String(arg('project', '') || '').trim();
  const limit = Number(arg('limit', 50)) || 50;
  const maxReviews = arg('max-reviews', undefined) === undefined ? 5 : Number(arg('max-reviews', 5));
  const dryRun = !!arg('dry-run', false);

  const Db = require('../services/db.js');
  if (!projectId) {
    const cur = Db.listProjects ? Db.listProjects(tenantId) : [];
    const p = (cur || []).find(x => x && (x.current || x.isCurrent)) || (cur || [])[0];
    projectId = p && p.id ? p.id : '';
  }
  if (!projectId || !Db.getProject(tenantId, projectId)) {
    console.error('项目不存在或不属于该租户：' + projectId);
    process.exit(3);
  }

  const Plan = require('../services/collection-plan.js');
  const out = Plan.bootstrapProject({ tenantId, projectId, limit, maxReviews, dryRun, trigger: 'schedule' });

  // 逐品牌一行，方便贴进报告：品牌 | 已入队能力 | 跳过原因
  const lines = (out.perBrand || []).map((b) => {
    const queued = (b.decisions || []).filter(d => d.decision === 'enqueued' || d.decision === 'planned').map(d => d.capability);
    return [
      (b.name || b.competitorId),
      queued.length ? queued.join(',') : '-',
      (b.reasons || []).join('; ') || '-',
    ].join(' | ');
  });
  console.log(JSON.stringify({
    runId: out.runId, projectId, brands: out.brands, counts: out.counts,
    budget: out.budget, dryRun: out.dryRun, elapsedMs: out.elapsedMs,
  }, null, 2));
  console.log('\n品牌 | 已入队能力 | 跳过原因');
  console.log(lines.join('\n'));
  process.exit(0);
}

main();
