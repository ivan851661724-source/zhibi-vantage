'use strict';
// ============================================================
// 本文件由拆分脚本自 server.js 机械搬运（行为保持不变，历史见 git）。
// core/version.js —— 导出: APP_VERSION, APP_COMMIT, STARTED_AT, buildVersionInfo, reportProvenance
// ============================================================

const fs = require('fs');
const path = require('path');

// ---- 启动完整性自检（§5-1）：版本/commit/启动时间，供体验报告版本锚定（#310） ----
let _pkgVer = '0.0.0';
try { _pkgVer = (JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) || {}).version || '0.0.0'; } catch (e) {}
const APP_VERSION = process.env.APP_VERSION || _pkgVer;
// 无 git 仓库时回退 'n/a'；部署流水线可用 APP_COMMIT 注入真实 commit。
const APP_COMMIT = process.env.APP_COMMIT || 'n/a';
const STARTED_AT = new Date().toISOString();
function buildVersionInfo() {
  return {
    name: '知彼 Vantage',
    version: APP_VERSION,
    commit: APP_COMMIT,
    startedAt: STARTED_AT,
    pid: process.pid,
    node: process.version
  };
}
// #310 体验报告版本锚定：在报告末尾附一行生成元数据（版本/commit/启动时间），便于追溯「这份报告是哪版知彼产出的」
function reportProvenance(version, commit, startedAt) {
  return `\n\n---\n> 本报告由 知彼 Vantage v${version}（commit ${commit}）生成 · 服务启动于 ${startedAt}`;
}


module.exports = { APP_VERSION, APP_COMMIT, STARTED_AT, buildVersionInfo, reportProvenance };
