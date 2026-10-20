'use strict';
// E2E 浏览器验收（SC-05 Competitive Memory）
// 真实页面 + 真实后端 API；不使用前端 mock，不拦截网络。
// 断言重点：
//   T1 两个可比价格点 → 画线并显示涨跌；单点 → 明确「还不足以判断」，且不画线
//   T2 价格点可打开证据抽屉
//   T3 时间线含 直接观察 / 历史存档观察 / 系统推导事件；不暴露内部标识
//   T4 存档条目显示时间精度（精确到日）
//   T5 覆盖面板：有证据段 / 无法确认段 / 图例；不出现「没有变化」式结论
//   T6 历史回补卡：显示真实终态与 0 导入，不写「已回补」
//   T7 情报库「时序变化（系统推导）」区块存在且可跳转
//   T8 页面不泄漏路径 / token / 栈
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
function arg(n, d) { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; }
const FRONT = arg('--front', 'http://127.0.0.1:3101');
const SEED_PATH = arg('--seed', path.join(__dirname, '.e2e-memory.json'));
const SHOTS = path.join(__dirname, '.e2e-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const SEED = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok - ' + name); }
  else { fail++; failures.push(name + (detail ? ' :: ' + detail : '')); console.log('  FAIL - ' + name + (detail ? ' :: ' + detail : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('pageerror', e => consoleErrors.push(String(e && e.message || e).slice(0, 160)));

  // 登录
  await page.goto(FRONT + '/login', { waitUntil: 'networkidle' });
  await page.fill('input[type=email]', SEED.email);
  await page.fill('input[type=password]', SEED.password);
  await page.click('#authForm button[type=submit], #authForm .btn-primary');
  await page.waitForURL(u => !String(u).includes('/login'), { timeout: 20000 });

  const url = (brandId, tab) => FRONT + '/brands/' + encodeURIComponent(brandId)
    + '?projectId=' + encodeURIComponent(SEED.projectId) + '&tab=' + tab;

  // ---------- T1 商品与价格 ----------
  console.log('T1 商品与价格：两点画线 / 单点不画');
  await page.goto(url(SEED.brandMove, 'products'), { waitUntil: 'networkidle' });
  await page.waitForSelector('.mem-product', { timeout: 20000 });
  await page.waitForFunction(() => document.querySelectorAll('.mem-product').length >= 2, null, { timeout: 15000 });
  const moveCard = page.locator('.mem-product').filter({ hasText: 'Plush Fox' }).first();
  const svgCount = await moveCard.locator('.mem-track-svg').count();
  check('两次观察的商品显示价格连线', svgCount === 1, 'svg=' + svgCount);
  const deltaText = await moveCard.locator('.mem-track-delta').first().textContent().catch(() => '');
  check('显示涨跌与百分比', /15/.test(String(deltaText)) && /%/.test(String(deltaText)), String(deltaText));
  const noteText = await moveCard.textContent();
  check('说明「中间过程没有被观察」', /中间过程没有被观察/.test(String(noteText)));
  const archivedBadge = await moveCard.locator('.mem-badge-archived-observation').count();
  check('商品卡出现「历史存档观察」标签', archivedBadge >= 1, 'badges=' + archivedBadge);
  await page.screenshot({ path: path.join(SHOTS, 'p1-products-move.png'), fullPage: true });

  // 单点品牌
  await page.goto(url(SEED.brandFlat, 'products'), { waitUntil: 'networkidle' });
  await page.waitForSelector('.mem-product', { timeout: 20000 });
  await page.waitForFunction(() => document.body.innerText.includes('还不足以判断价格变化'), null, { timeout: 15000 });
  const flatSvg = await page.locator('.mem-track-svg').count();
  const flatText = await page.textContent('body');
  check('单点商品不画趋势线', flatSvg === 0, 'svg=' + flatSvg);
  check('单点商品说明还不足以判断价格变化', /还不足以判断价格变化/.test(String(flatText)));
  check('单点商品给出开始积累时间', /开始积累于\s*\d{4}-\d{2}-\d{2}/.test(String(flatText)));
  await page.screenshot({ path: path.join(SHOTS, 'p2-products-single.png'), fullPage: true });

  // ---------- T2 证据抽屉 ----------
  console.log('T2 价格点可打开证据');
  await page.goto(url(SEED.brandMove, 'products'), { waitUntil: 'networkidle' });
  await page.waitForSelector('.mem-ev-btn', { timeout: 20000 });
  await page.locator('.mem-ev-btn').first().click();
  await page.waitForTimeout(1200);
  const drawerText = await page.textContent('body');
  check('证据抽屉打开并显示来源信息', /证据|快照|来源|核实/.test(String(drawerText)));
  const drawerOpen = await page.locator('.wb-drawer, [class*="drawer"]').count();
  check('证据抽屉容器存在', drawerOpen >= 1, 'drawers=' + drawerOpen);

  // ---------- T3/T4 历史时间线 ----------
  console.log('T3/T4 历史时间线');
  await page.goto(url(SEED.brandMove, 'timeline'), { waitUntil: 'networkidle' });
  await page.waitForSelector('.mem-tl-item', { timeout: 20000 });
  await page.waitForTimeout(600);
  const liveCnt = await page.locator('.mem-tl-live_observation').count();
  const archCnt = await page.locator('.mem-tl-archived_observation').count();
  const derCnt = await page.locator('.mem-tl-derived_event').count();
  check('含直接观察条目', liveCnt >= 1, 'live=' + liveCnt);
  check('含历史存档观察条目', archCnt >= 1, 'archived=' + archCnt);
  check('含系统推导事件条目', derCnt >= 1, 'derived=' + derCnt);
  const tlText = await page.textContent('.mem-timeline');
  check('存档条目显示精确到日', /精确到日/.test(String(tlText)));
  check('直接观察条目标注「观察到」或时间精度', /观察到|仅采集时可知/.test(String(tlText)));
  for (const leak of ['attempt_', 'snapshot_id', 'ss_product_catalog', '.json', 'C:\\']) {
    check('时间线不含内部标识 ' + leak, !String(tlText).includes(leak));
  }
  await page.screenshot({ path: path.join(SHOTS, 'p3-timeline.png'), fullPage: true });

  // ---------- T5 覆盖 ----------
  console.log('T5 数据覆盖与来源');
  await page.goto(url(SEED.brandMove, 'coverage'), { waitUntil: 'networkidle' });
  await page.waitForSelector('.mem-cov', { timeout: 20000 });
  await page.waitForTimeout(800);
  const covCovered = await page.locator('.mem-cov-seg-covered').count();
  const covUnknown = await page.locator('.mem-cov-seg-unknown').count();
  check('覆盖带出现有证据段', covCovered >= 1, 'covered=' + covCovered);
  check('覆盖带出现无法确认段', covUnknown >= 1, 'unknown=' + covUnknown);
  check('覆盖图例存在', (await page.locator('.mem-cov-legend').count()) >= 1);
  const covText = await page.textContent('body');
  for (const bad of ['没有变化', '无变化', '0 条广告']) {
    check('覆盖页不写「' + bad + '」', !String(covText).includes(bad));
  }
  check('明确说明无记录不等于没有变化', /无记录不等于没有变化|不代表没有发生/.test(String(covText)));

  // ---------- T6 回补卡 ----------
  console.log('T6 历史回补卡（真实终态）');
  await page.waitForSelector('.mem-backfill', { timeout: 20000 });
  const jobState = await page.locator('.mem-job-state').first().textContent().catch(() => '');
  check('显示真实任务终态', !!jobState, String(jobState));
  check('终态为来源不可用 / 存档无记录 / 已完成之一',
    /来源不可用|存档无记录|已完成|部分完成|未完成|已停止/.test(String(jobState)), String(jobState));
  const bfText = await page.textContent('.mem-backfill');
  check('显示 0 导入时如实写 0', /已写入历史事实\s*0\s*个/.test(String(bfText)) || !/已写入历史事实\s*[1-9]/.test(String(bfText)));
  check('不写「已回补」', !String(bfText).includes('已回补'));
  await page.screenshot({ path: path.join(SHOTS, 'p4-coverage.png'), fullPage: true });

  // ---------- T7 情报库 ----------
  console.log('T7 情报库时序变化');
  await page.goto(FRONT + '/intel?projectId=' + encodeURIComponent(SEED.projectId), { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const hasMemBlock = await page.locator('.core-mem-events').count();
  check('情报库出现「时序变化（系统推导）」区块', hasMemBlock >= 1, 'blocks=' + hasMemBlock);
  if (hasMemBlock) {
    const memText = await page.textContent('.core-mem-events');
    check('时序区块标明系统推导', /系统推导/.test(String(memText)));
    check('时序区块含跳转链接', (await page.locator('.core-mem-event-link').count()) >= 1);
    const emptyNoise = await page.locator('.core-empty, [class*=empty]').filter({ hasText: '当前筛选没有结果' }).count();
    check('有时序变化时不显示「当前筛选没有结果」', emptyNoise === 0, 'empty=' + emptyNoise);
    // 截图要在点击之前拍：点击会跳到品牌档案，否则截到的是目标页
    await page.screenshot({ path: path.join(SHOTS, 'p5-intel.png'), fullPage: true });
    await page.locator('.core-mem-event-link').first().click();
    await page.waitForURL(u => String(u).includes('/brands/'), { timeout: 15000 });
    check('点击可定位到品牌档案', String(page.url()).includes('/brands/'));
    await page.waitForTimeout(800);
  }

  // ---------- T8 泄漏 ----------
  console.log('T8 页面泄漏检查');
  const pages = [
    url(SEED.brandMove, 'products'), url(SEED.brandMove, 'timeline'),
    url(SEED.brandMove, 'coverage'), FRONT + '/intel?projectId=' + encodeURIComponent(SEED.projectId),
  ];
  for (const u of pages) {
    await page.goto(u, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    const text = await page.innerText('body');
    const bad = ['C:\\', '/app/', 'at Object.', 'Bearer ', 'ghp_', 'sk-', 'client_secret', 'TODO: ']
      .filter(t => text.includes(t));
    check('无泄漏：' + u.split('?')[1].slice(0, 28), bad.length === 0, bad.join(','));
  }
  check('无未捕获页面错误', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

  await browser.close();
  console.log('\n[memory-e2e] ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { console.error('[memory-e2e] FAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
