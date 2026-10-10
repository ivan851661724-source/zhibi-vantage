'use strict';
// robots.txt 解析器单测（RFC 9309 简化实现）
const assert = require('node:assert');
const Robots = require('../lib/robots.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + e.message); }
}

const SAMPLE = `
# 有点注释
User-agent: googlebot
Disallow: /private/

User-agent: *
Crawl-delay: 2
Disallow: /admin/
Disallow: /cart$
Allow: /admin/login
Disallow:
Sitemap: https://x.com/sitemap.xml
`;

t('最长匹配胜出：/admin/login 命中 Allow（比 /admin/ 长）', () => {
  const rules = Robots.parse(SAMPLE);
  assert.equal(Robots.isAllowed(rules, '/admin/login'), true);
  assert.equal(Robots.isAllowed(rules, '/admin/panel'), false);
});

t('通配与 $ 锚：/cart 禁止但 /cart.js 允许', () => {
  const rules = Robots.parse(SAMPLE);
  assert.equal(Robots.isAllowed(rules, '/cart'), false);
  assert.equal(Robots.isAllowed(rules, '/cart.js'), true);
});

t('googlebot 专属组不适用于我们（* 组为准）', () => {
  const rules = Robots.parse(SAMPLE);
  assert.equal(Robots.isAllowed(rules, '/private/x'), true, 'googlebot 的 /private/ 禁令不约束 * 组');
});

t('其它 UA 组的规则不被误收', () => {
  const rules = Robots.parse(SAMPLE);
  const paths = rules.map(r => r.path);
  assert.ok(!paths.includes('/private/'), '专属组规则不得进入 * 组规则集');
});

t('无规则 / 空文件 → 全允许', () => {
  assert.equal(Robots.isAllowed([], '/x'), true);
  assert.equal(Robots.isAllowed(Robots.parse(''), '/x'), true);
  assert.equal(Robots.isAllowed(Robots.parse(null), '/x'), true);
});

t('空 Disallow 值 = 全允许（RFC 9309），不生成规则', () => {
  const rules = Robots.parse('User-agent: *\nDisallow:');
  assert.equal(rules.length, 0);
  assert.equal(Robots.isAllowed(rules, '/anything'), true);
});

t('裸规则（无 UA 头，畸形文件）→ 不生效（fail-open）', () => {
  const rules = Robots.parse('Disallow: /secret/');
  assert.equal(rules.length, 0);
});

t('通配符 *：Disallow: /*.pdf 禁止 pdf 路径', () => {
  const rules = Robots.parse('User-agent: *\nDisallow: /*.pdf');
  assert.equal(Robots.isAllowed(rules, '/files/a.pdf'), false);
  assert.equal(Robots.isAllowed(rules, '/files/a.docx'), true);
});

t('通配符 + $ 组合：/*.php$ 只锚结尾', () => {
  const rules = Robots.parse('User-agent: *\nDisallow: /*.php$');
  assert.equal(Robots.isAllowed(rules, '/a.php'), false);
  assert.equal(Robots.isAllowed(rules, '/a.php?x=1'), true);
});

console.log('\n=== robots.test: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed ? 1 : 0);
