'use strict';
// =============================================================================
// static-check.js —— 防回归静态扫描（B-8，2026-09-12 任务书；Phase 1 EBUSY 加固）
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
// Windows EBUSY 根因与修复（2026-10-09）：
//   · 根因：Windows 上 Defender/AV 或进程护栏在 node.exe 镜像刚映射时短暂持锁，
//     spawnSync 返回 { error: EBUSY, status: null }（stderr 为空）——旧脚本把
//     status!==0 一律判失败，产生大量空报错的幽灵 [SYNTAX]/[REQ] 行；
//     受限环境（如沙箱）甚至对所有 node 子进程持续性 EBUSY，重试无效。
//   · 修复（三层，检查语义不放宽、不跳过、不改警告）：
//     ① 稳定可执行文件路径：一律 process.execPath（不依赖 PATH 解析）；
//     ② 瞬态 EBUSY/EAGAIN 指数退避重试（scripts/lib/spawn-node.js）；
//     ③ spawn 级失败（重试耗尽仍 EBUSY）→ 同一检查切换到**进程内等价实现**：
//        语法=vm.Script 编译（等价 --check，只编译不执行）；require-all=进程内
//        require（数据目录指向隔离临时根）；stub 冒烟=进程内 Module._load 打桩
//        + 清 discover/llm 缓存后重载。
//
// 用法：node scripts/static-check.js   退出码 0=绿 / 1=红
//       也可被测试壳进程内调用：const { runAll } = require(...); await runAll({ tmpRoot })
// =============================================================================
const { spawnSync } = require('child_process');
const { spawnNode } = require('./lib/spawn-node.js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

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
// 降级通知（审核整改 §四）：spawn 级失败切进程内补偿时必须显式可见——
// 进程内路径与子进程并非完全等价（共享事件循环与 require 缓存、无法验证模块级隔离），
// 正式生产门禁 = 子进程路径；进程内仅作受控环境补偿，且降级事实计入 notices 供门禁审阅。
const notices = [];
function report(kind, file, line, msg) {
  const rel = path.relative(APP_ROOT, file).replace(/\\/g, '/');
  problems.push(`[${kind}] ${rel}:${line} ${msg}`);
}
function notice(msg) {
  notices.push(msg);
  try { console.warn('[static-check][fallback] ' + msg); } catch (e) { /* 无控制台环境 */ }
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

// ---- 检查 1：语法（spawn 优先，EBUSY 重试耗尽 → 进程内 vm 编译等价检查） ----
function checkSyntax(files, tmpRoot) {
  let spawnBlocked = false;
  for (const f of files) {
    const r = spawnNode(['--check', f], { encoding: 'utf8', timeout: 30000, tmpRoot });
    if (r.error) { spawnBlocked = true; break; } // spawn 级失败（EBUSY 等，已重试）——整批切换进程内
    if (r.status !== 0) report('SYNTAX', f, 0, String(r.stderr || '').trim().split('\n')[0]);
  }
  if (spawnBlocked) {
    notice(`语法检查：spawn 被拦截（EBUSY 等），${files.length} 个文件降级为进程内 vm 编译（等价 --check，非完全等价：无法验证子进程内行为）`);
    for (const f of files) {
      try {
        // 进程内等价 node --check：vm.Script 只编译不执行（require 未定义也无妨）
        new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f });
      } catch (e) {
        report('SYNTAX', f, 0, '语法错误: ' + String(e.message || e).split('\n')[0]);
      }
    }
  }
}

// ---- 检查 3：require-all 冒烟（spawn 优先，EBUSY → 进程内 require） ----
function collectRequireFiles() {
  const reqDirs = ['research', 'lib', 'services'].map(d => path.join(APP_ROOT, d));
  const reqFiles = [];
  for (const d of reqDirs) {
    if (!fs.existsSync(d)) continue;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isFile() && e.name.endsWith('.js')) reqFiles.push(path.join(d, e.name));
      if (e.isDirectory() && !SKIP_DIRS.has(e.name)) {
        for (const e2 of fs.readdirSync(path.join(d, e.name), { withFileTypes: true })) {
          if (e2.isFile() && e2.name.endsWith('.js')) reqFiles.push(path.join(d, e.name, e2.name));
        }
      }
    }
  }
  return reqFiles;
}
function requireAll(files, tmpRoot) {
  let spawnBlocked = false;
  for (const f of files) {
    const r = spawnNode(['-e', 'require(process.argv[1])', f], { encoding: 'utf8', timeout: 30000, tmpRoot });
    if (r.error) { spawnBlocked = true; break; }
    if (r.status !== 0) {
      const firstErr = String(r.stderr || '').split('\n').find(l => l.includes('Error')) || String(r.stderr || '').slice(0, 200);
      report('REQ', f, 0, '顶层 require 抛错: ' + firstErr.trim());
    }
  }
  if (spawnBlocked) {
    // 进程内等价：先隔离数据目录再加载（子模块按 ZB_DATA_DIR 缓存路径）
    // 与子进程的差异：共享本进程 require 缓存与事件循环、无法证明模块级隔离完全等价——
    // 故仅作受控环境补偿；生产门禁以子进程路径为准（见文件头说明）
    notice(`require-all 冒烟：spawn 被拦截，${files.length} 个文件降级为进程内 require（非完全等价：共享 require 缓存，无法验证模块级隔离）`);
    process.env.ZB_DATA_DIR = process.env.ZB_DATA_DIR || tmpRoot;
    for (const f of files) {
      try { require(f); }
      catch (e) { report('REQ', f, 0, '顶层 require 抛错(进程内): ' + String(e.message || e).slice(0, 200)); }
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

function runStubDiscoverSmoke(tmpRoot) {
  const tmp = fs.mkdtempSync(path.join(tmpRoot, 'smoke-'));
  const preload = path.join(tmp, 'stub-preload.js');
  const driver = path.join(tmp, 'stub-driver.js');
  fs.writeFileSync(preload, STUB_PRELOAD);
  fs.writeFileSync(driver, STUB_DRIVER);
  const r = spawnNode(['--require', preload, driver], {
    encoding: 'utf8', timeout: 90000, tmpRoot,
    env: Object.assign({}, process.env, { APP_ROOT: APP_ROOT }),
  });
  if (!r.error) {
    const out = String(r.stdout || '') + String(r.stderr || '');
    if (r.status !== 0 || /SMOKE_FAIL/.test(out)) {
      console.error('---- stub discover 冒烟完整输出 ----\n' + out + '---- 完整输出结束 ----');
      const m = out.match(/SMOKE_FAIL[ ]*([^\r\n]+)/);
      const msg = (m && m[1] && m[1].trim()) || ('exit=' + r.status + ' tail=' + out.slice(-300).replace(/\s+/g, ' '));
      report('SMOKE', path.join(APP_ROOT, 'research', 'discover.js'), 0, 'stub discover 冒烟失败: ' + msg);
    }
    return Promise.resolve();
  }
  // spawn 级失败（EBUSY 等，已重试）→ 进程内等价冒烟：打桩 + 清相关缓存 + 重载 discover
  notice('stub discover 冒烟：spawn 被拦截，降级为进程内打桩重载（非完全等价：与本门禁共享进程状态）');
  return smokeInProcess(tmp);
}
async function smokeInProcess(tmp) {
  const Module = require('module');
  const origLoad = Module._load;
  const stubLlm = {
    deepseekJSON: async () => ({}),
    deepseekText: async () => '',
    llmApiKey: () => 'stub-key',
    resolveModel: () => 'stub-model',
    resolveBaseUrl: () => 'http://127.0.0.1:9',
  };
  const empty = async () => ({ results: [] });
  const stubSearch = {
    serperSearch: empty, normalizeSerperKeys: () => [], classifySerperError: () => 'STUB',
    serperSearchWithFailover: empty, getSerperPool: () => ({ keys: [], disabled: [] }),
    tavilySearch: empty, braveSearch: empty, bochaSearch: empty,
    glFromRegions: () => 'us', activeSearchKey: () => 'stub',
  };
  Module._load = function (request, parent, isMain) {
    let resolved = null;
    try {
      resolved = request.startsWith('.') && parent && parent.filename
        ? require.resolve(path.resolve(path.dirname(parent.filename), request))
        : require.resolve(request, { paths: parent ? parent.paths : undefined });
    } catch (e) { resolved = String(request); }
    const norm = String(resolved || '').split(path.sep).join('/');
    if (norm.endsWith('/research/llm.js')) return stubLlm;
    if (norm.endsWith('/services/providers/search.js')) return stubSearch;
    if (norm.endsWith('/research/net.js')) {
      try { delete require.cache[resolved]; } catch (e) {} // 摘缓存重新装配，保证打桩生效
      const real = origLoad(request, parent, isMain);
      return Object.assign({}, real, {
        fetchPage: async () => ({ ok: false, error: 'stub' }),
        fetchShopifyProducts: async () => ({ ok: false, error: 'stub' }),
      });
    }
    return origLoad(request, parent, isMain);
  };
  // 清掉 research/ 下全部缓存：discover/enrich/candidates/search 等都在首载时绑定了
  // llm.js 与 providers/search.js 的真实引用——必须经打桩 loader 重载才能生效
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(APP_ROOT + path.sep + 'research' + path.sep)) {
      try { delete require.cache[k]; } catch (e) {}
    }
  }
  process.env.ZB_DATA_DIR = process.env.ZB_DATA_DIR || tmp;
  try {
    const { runDiscover } = require(path.join(APP_ROOT, 'research', 'discover.js'));
    const config = { search: { provider: 'tavily', tavilyKey: 'stub-key' }, deepseekKey: 'stub-key' };
    await runDiscover('stub widget', { regions: ['us'] }, config, null, null);
    console.log('SMOKE_OK discover 完成（进程内 stub，全链路无 ReferenceError）');
  } catch (e) {
    report('SMOKE', path.join(APP_ROOT, 'research', 'discover.js'), 0,
      'stub discover 冒烟失败(进程内): ' + String(e.message || e).slice(0, 200));
  } finally {
    Module._load = origLoad;
  }
}

// ---- 主流程（可被测试壳进程内调用） ----
async function runAll(opts) {
  const o = opts || {};
  console.log('static-check：app 根 = ' + APP_ROOT);
  // 一次性隔离临时根：全部子进程的 TMPDIR/TEMP/TMP/ZB_DATA_DIR 重定向到此处
  const RUN_TMP = o.tmpRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'zhibi-staticcheck-run-'));
  const files = listAppJs();
  console.log(`① 语法检查 ${files.length} 个文件…`);
  checkSyntax(files, RUN_TMP);
  console.log('② 命名空间启发式扫描…');
  for (const f of files) scanNamespace(f);
  console.log('③ require-all 冒烟（research/lib/services）…');
  requireAll(collectRequireFiles(), RUN_TMP);
  console.log('④ e2e stub discover 冒烟…');
  await runStubDiscoverSmoke(RUN_TMP);
  return problems;
}

module.exports = { runAll, listAppJs, stripCommentsAndStrings, declaredNames, scanNamespace, problems, notices };

// CLI 直跑（被测试壳 require 时不自动退出）
if (require.main === module) {
  runAll({}).then(() => {
    if (problems.length) {
      console.error('\nstatic-check 失败，共 ' + problems.length + ' 处：');
      for (const p of problems) console.error('  ' + p);
      process.exit(1);
    }
    console.log('\nstatic-check 全绿（语法 / 命名空间 / require-all / stub discover 冒烟）');
    process.exit(0);
  }).catch(e => { console.error('static-check 异常: ' + String(e && e.stack || e)); process.exit(1); });
}
