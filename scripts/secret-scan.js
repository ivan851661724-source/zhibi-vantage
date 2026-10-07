#!/usr/bin/env node
/**
 * scripts/secret-scan.js — 零依赖仓库密钥扫描（Phase 5 防复发护栏）
 *
 * 用途：扫描 git 跟踪文件中疑似真实 API 密钥/凭据的模式命中。
 * 设计：只报 provider 类型 + 文件 + 行号 + 长度/前缀分类，绝不输出密钥值本身。
 * 结果：命中 potentially real → exit 1（可挂 pre-merge / CI）；example/placeholder → 放行。
 *
 * 用法：node scripts/secret-scan.js [路径...]   （缺省扫描全部 git 跟踪文件）
 * 边界：config-seed/ 必须保持零密钥（见 AGENTS.md Secret Hygiene 条款）。
 */
'use strict';
const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

// provider 判定模式（与 2026-10-07 安全审计同一套，勿随意放宽）
const PATTERNS = [
  { name: 'openai_style(sk-)_DeepSeek/Bocha', rx: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: 'tavily(tvly-)', rx: /\btvly-[A-Za-z0-9_-]{10,}/g },
  { name: 'brave(BSA)', rx: /\bBSA[A-Za-z0-9]{20,}/g },
  { name: 'serper(40hex)', rx: /\b[0-9a-f]{40}\b/g },
  { name: 'generic_assignment', rx: /(?:api[_-]?key|apikey|token|secret|password)\s*[:=]\s*["']?([A-Za-z0-9_\-.]{16,})["']?/gi },
];
const FAKE_HINTS = ['your', 'xxx', 'changeme', 'example', 'placeholder', 'replace', 'dummy', 'fake', '<', '>', '0000'];
const isFake = (v) => FAKE_HINTS.some((h) => v.toLowerCase().includes(h)) || new Set(v).size <= 4;

let files;
if (process.argv.includes('--stdin-files')) {
  // 回退模式：文件清单由外部管道提供（git ls-files | node scripts/secret-scan.js --stdin-files）
  files = require('fs').readFileSync(0, 'utf8').split('\n').filter(Boolean);
} else {
  try {
    files = execSync('git ls-files', { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
      .split('\n').filter(Boolean);
  } catch (e) { console.error('secret-scan: 须在 git 仓库内运行（或用 --stdin-files 管道模式）'); process.exit(2); }
}

const args = new Set(process.argv.slice(2).filter((a) => !a.startsWith('--'))); // 排除模式开关，只留路径参数
if (args.size) files = files.filter((f) => [...args].some((a) => f === a || f.startsWith(a)));

const findings = [];
for (const f of files) {
  let text;
  try { text = require('fs').readFileSync(f, 'utf8'); } catch (e) { continue; } // 二进制/不可读跳过
  for (const { name, rx } of PATTERNS) {
    for (const m of text.matchAll(rx)) {
      const tok = m[1] || m[0];
      if (tok.length < 16) continue;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ file: f, provider: name, line, length: tok.length, class: isFake(tok) ? 'example/placeholder' : 'potentially real', hash: crypto.createHash('sha256').update(tok).digest('hex').slice(0, 12) });
    }
  }
}

// 已知误报白名单（函数名/变量名族，非密钥）——新增误报在此登记 sha256 前 12 位，勿放宽正则
// eb6127cff99d = api-admin.js adminLogin（函数名）；5fcf23c18df8 = auth.test.js issueAdminToken（测试函数名）
const WHITELIST_HASH_PREFIXES = ['eb6127cff99d', '5fcf23c18df8'];

const real = findings.filter((x) => x.class === 'potentially real' && !WHITELIST_HASH_PREFIXES.some((p) => x.hash.startsWith(p)));
for (const x of findings) console.log(`[${x.class}] ${x.file}:${x.line} provider=${x.provider} len=${x.length} hash=${x.hash}`);
if (real.length) { console.error(`secret-scan: FAIL — ${real.length} potentially real hit(s)`); process.exit(1); }
console.log(`secret-scan: PASS — ${findings.length} hit(s), 0 potentially real`);
