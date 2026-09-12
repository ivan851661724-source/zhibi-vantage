'use strict';
// =============================================================================
// static-check.js —— 防回归静态扫描（B-8，2026-09-12 任务书）
//
// 背景：连续 3 例同族事故（research/llm.js:10 / research/search.js / research/decorate.js
// ——均为 server.js 拆分时遗漏 import / 错用命名空间），肉眼评审已证明靠不住。本脚本治本。
//
// 四道检查（全部零依赖）：
//   1) 语法检查：app/ 全部 js（排除 test/）逐文件 node --check
//   2) 命名空间启发式：正文 `X.` 形式的调用，X 匹配 /^[A-Z][A-Za-z0-9]{1,}$/ 且
//      本文件无 const/let/var/class/function 声明、无解构导入、非标准全局 → 报错（抓 FC.-型）
//   3) require-all 冒烟：逐个 require app/research|lib|services/*.js，顶层加载即抛错直接红
//   4) e2e stub 冒烟：stub LLM/搜索/抓取后跑一轮最小 discover（抓 curTenantId-型——
//      函数体内才触发的 ReferenceError，静态扫描抓不到）
//
// 用法：node scripts/static-check.js   退出码 0=绿 / 1=红
// =============================================================================
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'test', '.git']);
// 标准全局/Node 内建（大写开头，允许未声明直接使用）
const GLOBALS = new Set([
  'Math', 'JSON', 'Date', 'Object', 'Array', 'Number', 'String', 'Boolean', 'RegExp', 'Function',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError', 'ReferenceError',
  'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
  'Buffer', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams', 'AbortController', 'AbortSignal',
  'Intl', 'Event', 'EventTarget', 'MessageChannel', 'MessagePort', 'Atomics', 'SharedArrayBuffer', 'Float32Array', 'Float64Array',
  'Int8Array', 'Int16Array', 'Int32Array', 'Uint8Array', 'Uint16Array', 'Uint32Array',
  'Infinity', 'NaN', 'globalThis',
]);
// 已知跨文件按命名空间引用的注册表类（如有新增请在文件头注释登记，勿私自加白）
const KNOWN_NS = new Set([
  // （当前为空：出现误报时先核对代码，确属跨文件注册表再加入并注明文件）
]);

const problems = [];
function report(kind, file, line, msg) {
  const rel = path.relative(APP_ROOT, file).replace(/\\/g, '/');
  problems.push(`[${kind}] ${rel}:${line} ${msg}`);
}

// ---- 列出 app/ 全部 js（排除 test/） ----
function listAppJs() {
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name)); }
      else if (e.name.endsWith('.js')) out.push(path.join(dir, e.name));
    }
  })(APP_ROOT);
  return out.sort();
}

// ---- 剥离注释与字符串（保留换行以维持行号；近似处理，面向启发式而非解析） ----
function stripCommentsAndStrings(src) {
  let out = '', i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; out += ' '; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n) {
        if (src[i] === '\\') { i += 2; continue; }
        if (q !== '`' && src[i] === '\n') break; // 未闭合容错
        if (src[i] === q) { i++; break; }
        if (q === '`' && src[i] === '\n') out += '\n'; // 模板串保留换行对齐行号
        i++;
      }
      out += ' '; continue;
    }
    out += c; i++;
  }
  return out;
}

// ---- 收集文件内声明的标识符（const/let/var 单名 + 解构 + function/class） ----
function declaredNames(stripped) {
  const names = new Set();
  const pushDecl = (raw) => {
    raw.split(',').forEach(seg => {
      seg = seg.trim();
      if (!seg) return;
      const m = seg.match(/^[A-Za-z_$][\w$]*/) || seg.match(/:\s*([A-Za-z_$][\w$]*)\s*$/);
      if (m) names.add(m[1] || m[0]);
    });
  };
  let m;
  const reSingle = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reSingle.exec(stripped))) names.add(m[1]);
  const reBrace = /\b(?:const|let|var)\s*\{([^{}]*)\}/g;
  while ((m = reBrace.exec(stripped))) pushDecl(m[1]);
  const reFn = /\bfunction\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reFn.exec(stripped))) names.add(m[1]);
  const reCls = /\bclass\s+([A-Za-z_$][\w$]*)/g;
  while ((m = reCls.exec(stripped))) names.add(m[1]);
  return names;
}

// ---- 检查 2：命名空间启发式 ----
function scanNamespace(file) {
  const src = fs.readFileSync(file, 'utf8');
  const stripped = stripCommentsAndStrings(src);
  const names = declaredNames(stripped);
  const lines = stripped.split('\n');
  const reUse = /(?<![.\w$'"`/])([A-Z][A-Za-z0-9]{1,})\s*\./g;
  lines.forEach((line, idx) => {
    let m;
    reUse.lastIndex = 0;
    while ((m = reUse.exec(line))) {
      const id = m[1];
      if (GLOBALS.has(id) || KNOWN_NS.has(id) || names.has(id)) continue;
      report('NS', file, idx + 1, `命名空间 '${id}.' 在本文件无声明/导入（FC-型遗漏）`);
    }
  });
}

// ---- 检查 3：require-all 冒烟 ----
function requireAll(files) {
  for (const f of files) {
    const r = spawnSync(process.execPath, ['-e', 'require(process.argv[1])', f], {
      encoding: 'utf8', timeout: 30000,
      env: Object.assign({}, process.env, { ZB_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-req-')) }),
    });
    if (r.status !== 0) {
      const firstErr = String(r.stderr || '').split('\n').find(l => l.includes('Error')) || String(r.stderr || '').slice(0, 200);
      report('REQ', f, 0, '顶层 require 抛错: ' + firstErr.trim());
    }
  }
}

// ---- 检查 4：e2e stub discover 冒烟 ----
const STUB_PRELOAD = `
const Module = require('module');
const path = require('path');
const origLoad = Module._load;
function resolveReq(request, parent) {
  try {
    if (request.startsWith('.') && parent && parent.filename) {
      return require.resolve(path.resolve(path.dirname(parent.filename), request));
    }
    return require.resolve(request, { paths: parent ? parent.paths : undefined });
  } catch (e) { return String(request); }
}
Module._load = function (request, parent, isMain) {
  const resolved = resolveReq(request, parent);
  if (resolved.endsWith('research' + path.sep + 'llm.js')) {
    return {
      deepseekJSON: async () => ({}),
      deepseekText: async () => '',
      llmApiKey: () => 'stub-key',
      resolveModel: () => 'stub-model',
      resolveBaseUrl: () => 'http://127.0.0.1:9',
    };
  }
  if (resolved.endsWith('services' + path.sep + 'providers' + path.sep + 'search.js')) {
    const empty = async () => ({ results: [] });
    return {
      serperSearch: empty, normalizeSerperKeys: () => [], classifySerperError: () => 'STUB',
      serperSearchWithFailover: empty, getSerperPool: () => ({ keys: [], disabled: [] }),
      tavilySearch: empty, braveSearch: empty, bochaSearch: empty,
      glFromRegions: () => 'us', activeSearchKey: () => 'stub',
    };
  }
  if (resolved.endsWith('research' + path.sep + 'net.js')) {
    const real = origLoad(request, parent, isMain);
    return Object.assign({}, real, {
      fetchPage: async () => ({ ok: false, error: 'stub' }),
      fetchShopifyProducts: async () => ({ ok: false, error: 'stub' }),
    });
  }
  return origLoad(request, parent, isMain);
};
`;
const STUB_DRIVER = `
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.ZB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-smoke-'));
const APP = process.env.APP_ROOT;
const { runDiscover } = require(path.join(APP, 'research', 'discover.js'));
const config = { search: { provider: 'tavily', tavilyKey: 'stub-key' }, deepseekKey: 'stub-key' };
const { activeSearchKey } = require(path.join(APP, 'core', 'config.js'));
const { llmApiKey } = require(path.join(APP, 'research', 'llm.js'));
console.log('probe activeSearchKey=', activeSearchKey(config), 'llmApiKey=', llmApiKey(config));
runDiscover('stub widget', { regions: ['us'] }, config, null, null)
  .then(() => { console.log('SMOKE_OK discover 完成（stub 全链路无 ReferenceError）'); process.exit(0); })
  .catch(e => { console.error(String(e && e.stack || e)); console.error('SMOKE_FAIL ' + String((e && e.message) || e)); process.exit(2); });
`;

function runStubDiscoverSmoke() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-staticcheck-'));
  const preload = path.join(tmp, 'stub-preload.js');
  const driver = path.join(tmp, 'stub-driver.js');
  fs.writeFileSync(preload, STUB_PRELOAD);
  fs.writeFileSync(driver, STUB_DRIVER);
  const r = spawnSync(process.execPath, ['--require', preload, driver], {
    encoding: 'utf8', timeout: 90000,
    env: Object.assign({}, process.env, { APP_ROOT: APP_ROOT }),
  });
  const out = String(r.stdout || '') + String(r.stderr || '');
  if (r.status !== 0 || /SMOKE_FAIL/.test(out)) {
    console.error('---- stub discover 冒烟完整输出 ----\n' + out + '---- 完整输出结束 ----');
    const m = out.match(/SMOKE_FAIL[ ]*([^\r\n]+)/);
    const msg = (m && m[1] && m[1].trim()) || ('exit=' + r.status + ' tail=' + out.slice(-300).replace(/\s+/g, ' '));
    report('SMOKE', path.join(APP_ROOT, 'research', 'discover.js'), 0, 'stub discover 冒烟失败: ' + msg);
  }
}

// ---- 主流程 ----
function main() {
  console.log('static-check：app 根 = ' + APP_ROOT);
  const files = listAppJs();
  console.log(`① 语法检查 ${files.length} 个文件…`);
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', timeout: 30000 });
    if (r.status !== 0) report('SYNTAX', f, 0, String(r.stderr || '').trim().split('\n')[0]);
  }
  console.log('② 命名空间启发式扫描…');
  for (const f of files) scanNamespace(f);
  console.log('③ require-all 冒烟（research/lib/services）…');
  const reqDirs = ['research', 'lib', 'services'].map(d => path.join(APP_ROOT, d));
  const reqFiles = [];
  for (const d of reqDirs) {
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.js')) reqFiles.push(path.join(d, e.name));
      // services/providers 子目录
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        for (const e2 of fs.readdirSync(path.join(d, e.name), { withFileTypes: true })) {
          if (e2.isFile() && e2.name.endsWith('.js')) reqFiles.push(path.join(d, e.name, e2.name));
        }
      }
    }
  }
  requireAll(reqFiles);
  console.log(`④ e2e stub discover 冒烟…`);
  runStubDiscoverSmoke();

  if (problems.length) {
    console.error('\nstatic-check 失败，共 ' + problems.length + ' 处：');
    for (const p of problems) console.error('  ' + p);
    process.exit(1);
  }
  console.log('\nstatic-check 全绿（语法 / 命名空间 / require-all / stub discover 冒烟）');
  process.exit(0);
}
main();
