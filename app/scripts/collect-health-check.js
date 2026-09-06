#!/usr/bin/env node
/**
 * collect-health-check.js — Phase 0 采集健康体检（验收闸门）
 *
 * 目标：把 PRD 阶段 1「修数据」变成可证明的工程动作。
 * 每个域按 domain-registry.acceptance 门槛体检，全部达标才允许 enabled=true。
 * 未达标域 → 材料中显式"缺域标注"，绝不编造（对应 PRD 底线）。
 *
 * 用法：
 *   node scripts/collect-health-check.js --demo          # 用内置 mock 数据跑一遍（CI 冒烟）
 *   node scripts/collect-health-check.js --env=staging   # 接真实采集探针（collectors 接口见下）
 *
 * 退出码：0 = 全部达标（CI 闸门放行）；1 = 存在未达标项。
 */
'use strict';

const path = require('path');
const registry = require('../lib/domain-registry.js');

// ---------- 采集探针接口（生产接入点） ----------
// 每个域需实现：probe(domain) => { checkName: { pass, actual, threshold } }
// 示例见 --demo 分支。生产实现接真实采集统计（抓取成功率 / 币种归一化 / 覆盖率等）。
async function probeFor(domainName, domain) {
  if (process.argv.includes('--demo')) {
    return demoProbe(domainName, domain);
  }
  const impl = require(`../collectors/health-${domainName}`); // 生产：每域一个健康探针
  return impl.probe(domain);
}

// ---------- 内置 demo 探针（演示/冒烟用，勿用于生产） ----------
function demoProbe(domainName, domain) {
  const a = domain.acceptance || {};
  const checks = {};
  for (const [key, threshold] of Object.entries(a)) {
    // 用固定 mock：前三个域故意模拟"价格已达标、其余未达标"的中间态
    const mockValue = domainName === 'price' ? threshold + 0.05 : threshold - 0.2;
    checks[key] = { actual: Number(mockValue.toFixed(3)), threshold, pass: mockValue >= threshold };
  }
  return checks;
}

// ---------- 体检主流程 ----------
async function run() {
  const results = [];
  let anyFail = false;

  for (const [name, domain] of Object.entries(registry)) {
    if (!domain || typeof domain !== 'object' || !domain.label) continue; // 跳过工具函数

    const checks = await probeFor(name, domain);
    const entries = Object.entries(checks);
    const passed = entries.every(([, c]) => c.pass);

    results.push({ name, label: domain.label, enabled: domain.enabled, passed, checks: entries });
    if (!passed) anyFail = true;
  }

  // ---------- 输出体检报告 ----------
  console.log('=== Phase 0 采集健康体检报告 ===');
  for (const r of results) {
    const badge = r.enabled ? (r.passed ? '[已启用]' : '[启用中-未达标!]') : '[未启用]';
    console.log(`\n${r.name.padEnd(14)} ${r.label} ${badge}`);
    for (const [key, c] of r.checks) {
      const mark = c.pass ? 'PASS' : 'FAIL';
      console.log(`  ${mark.padEnd(5)} ${key.padEnd(26)} actual=${c.actual}  threshold>=${c.threshold}`);
    }
    if (!r.checks.length) console.log('  (无验收门槛，视为通过)');
  }

  const enabledButFail = results.filter((r) => r.enabled && !r.passed);
  console.log('\n=== 闸门结论 ===');
  if (enabledButFail.length) {
    console.log(`阻断：已启用域存在未达标项（${enabledButFail.map((r) => r.name).join(', ')}）→ exit 1`);
    console.log('修复后重跑；未达标期间该域材料须带"缺域标注"，不得编造。');
    process.exitCode = 1;
  } else {
    console.log('通过：所有已启用域采集质量达标 → exit 0');
    process.exitCode = 0;
  }
}

run().catch((err) => {
  console.error('体检执行失败:', err.message);
  process.exitCode = 1;
});
