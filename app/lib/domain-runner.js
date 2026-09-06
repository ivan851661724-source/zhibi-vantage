'use strict';
// ============================================================
// domain-runner.js — 域调度器（Phase A 注册表驱动执行层）
//
// 架构依据：知彼 Zhibi 技术架构总纲 v3 §3 / §4 / §8。
// 职责：
//  1. 按 domain-registry 遍历域，enabled=false 的域跳过（T4 护栏）；
//  2. 对 enabled 域调用注入的引擎执行函数，产出 Verdict 快照（§8 模型）；
//  3. 快照写入 state.domainVerdicts（verdict 层，供 L3 材料引擎消费）；
//  4. 未接线的 enabled 域 → 显式"缺域标注"，绝不编造（PRD 底线）。
//
// 设计：为避免 server.js ↔ runner 循环依赖，引擎执行函数由 server.js 注入
// （runner 只做注册表遍历 + 契约包装，不 require 任何 lib 引擎）。
// 快照 schema：Verdict@1（与 lib/contract.js 同 schema 前缀，域级扩展）。
// ============================================================
const registry = require('./domain-registry.js');

/**
 * 返回注册表状态（供 /api/domains 端点与前端 Phase B 使用）。
 * 只暴露声明元数据（label/evaluation/acceptance/calibrationSet/crossDomainRead），
 * 不暴露引擎内部（护城河不外泄，架构 §5.2）。
 */
function domainStatus() {
  const out = {};
  for (const [name, d] of Object.entries(registry)) {
    if (!d || typeof d !== 'object' || !d.label) continue;
    out[name] = {
      label: d.label,
      enabled: d.enabled,
      evaluation: d.evaluation || {},
      acceptance: d.acceptance || {},
      calibrationSet: d.calibrationSet || null,
      crossDomainRead: d.crossDomainRead || [],
    };
  }
  return out;
}

/**
 * 对单个已启用域执行引擎并产出 Verdict 快照。
 * ctx[name] = (state) => rawVerdict  —— 由 server.js 注入。
 * 未接线 → 返回缺域标注（不抛错，材料层据此显式缺域）。
 */
function runDomain(name, state, ctx) {
  const d = registry[name];
  if (!d || typeof d !== 'object' || !d.enabled) return null; // 未启用域不运行
  const exec = ctx && ctx[name];
  if (typeof exec !== 'function') {
    return {
      schema: 'Verdict@1',
      domain: name,
      missing: true,
      missingNote: `${d.label}未接线，本次不产出（缺域标注，绝不编造）`,
      updatedAt: new Date().toISOString(),
    };
  }
  try {
    const raw = exec(state) || {};
    return Object.assign(
      {
        schema: 'Verdict@1',
        domain: name,
        version: 1, // 快照版本：重新裁决产生新 version（Phase C KG 起保留旧版）
        updatedAt: new Date().toISOString(),
      },
      raw
    );
  } catch (e) {
    return {
      schema: 'Verdict@1',
      domain: name,
      error: String((e && e.message) || e),
      missing: true,
      missingNote: `${d.label}执行失败，本次不产出`,
      updatedAt: new Date().toISOString(),
    };
  }
}

/**
 * 遍历注册表运行所有 enabled 域，产出 state.domainVerdicts（verdict 快照层）。
 * 非破坏：不修改现有 state 字段，仅附加 domainVerdicts。
 */
function runEnabledDomains(state, ctx) {
  const verdicts = {};
  for (const [name, d] of Object.entries(registry)) {
    if (!d || typeof d !== 'object' || !d.enabled) continue; // 跳过 enabled=false 域
    verdicts[name] = runDomain(name, state, ctx);
  }
  return verdicts;
}

module.exports = { domainStatus, runDomain, runEnabledDomains };
