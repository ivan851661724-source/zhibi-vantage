// 价格解析单一实现校验（docs/01-前端架构规范.md §6）
// 比对 web/src/lib/price.js 与 app/lib/pricefield.js 中 parsePriceRange 的函数源码（逐字符）。
// 任一侧漂移 → 退出码 1，CI 失败。
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const repoRoot = join(webRoot, '..');

const backendFn = require(join(repoRoot, 'app', 'lib', 'pricefield.js')).parsePriceRange;
const backendSrc = backendFn.toString();

// web 份是 plain JS 模块（allowJs），直接 require 比对
const webFn = require(join(webRoot, 'src', 'lib', 'price.js')).parsePriceRange;
const webSrc = webFn.toString();

if (backendSrc !== webSrc) {
  console.error('[check:price] FAIL — parsePriceRange 前后端实现不一致：');
  console.error('--- 后端 app/lib/pricefield.js ---');
  console.error(backendSrc);
  console.error('--- 前端 web/src/lib/price.js ---');
  console.error(webSrc);
  console.error('纪律：价格解析必须双侧同步修改（docs/01-前端架构规范.md §6）。');
  process.exit(1);
}

// 行为冒烟：同一批输入，两份实现输出必须全等
const cases = [
  ['', 'USD'],
  ['$12.99', 'USD'],
  ['$12.99 - $18.50', 'USD'],
  ['1,200円～2,400円', 'JPY'],
  ['not a price', 'USD'],
  ['40 off 100', 'USD'],
  [null, 'USD'],
];
for (const [input, cur] of cases) {
  const a = JSON.stringify(backendFn(input, cur));
  const b = JSON.stringify(webFn(input, cur));
  if (a !== b) {
    console.error(`[check:price] FAIL — 行为不一致 input=${JSON.stringify(input)}: backend=${a} web=${b}`);
    process.exit(1);
  }
}

console.log('[check:price] OK — parsePriceRange 前后端逐字符一致，行为冒烟通过。');
