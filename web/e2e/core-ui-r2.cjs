'use strict';
// SC-04 UI 框架轮 r2 · Playwright 验收用例（真实租户 API 链路，零 mock）
// 覆盖（任务书 §Playwright 验收资产）：
//   S1 深链接打开项目 B：顶部显示项目 B，页面 API 请求也使用项目 B
//   S2 品牌详情 ?projectId=A&tab=timeline 顶部切换项目 → 保留 tab=timeline 且 projectId 更新
//   S3 带 projectId 的品牌详情点侧栏四个核心入口 → projectId 不丢失
//   S4 失败报告点「重新生成」→ URL 切换为新报告任务（新 reportId + 同 projectId），新任务有状态
//   S5 四项未接入维度：无 0 值、无模拟图表、无虚构来源，刷新位标注不可用
// 用法：node core-ui-r2.cjs --front http://127.0.0.1:3100 --seed .e2e-seed.json [--shots dir]
// 前提：见同目录 README.md（后端 + 前端已启动；seed.cjs 已跑完）。
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
function arg(name, dflt) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; }
const FRONT = arg('--front', 'http://127.0.0.1:3100');
const SEED_PATH = arg('--seed', path.join(__dirname, '.e2e-seed.json'));
const SHOTS = arg('--shots', path.join(__dirname, '.e2e-shots'));
const SEED = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
fs.mkdirSync(SHOTS, { recursive: true });

let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) { console.error('未找到 playwright：请先 `npm i playwright --no-save`（或全局安装）并 `npx playwright install chromium`。'); process.exit(2); }

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok - ' + name);
  else { failures++; console.log('  FAIL - ' + name + (extra ? ' :: ' + extra : '')); }
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const q = (u, pid) => u + '?projectId=' + encodeURIComponent(pid);

  // 登录（真实 UI 表单）
  await page.goto(FRONT + '/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type=email]', SEED.email);
  await page.fill('input[type=password]', SEED.password);
  await page.click('#authForm button[type=submit], #authForm .btn-primary');
  await page.waitForURL(u => !String(u).includes('/login'), { timeout: 15000 });
  check('登录成功', !page.url().includes('/login'));

  // ---------- S1 深链接项目 B：顶部显示 + API 请求同指项目 B ----------
  console.log('S1 深链接项目 B');
  const apiPids = [];
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/') && u.includes('projectId=')) {
      const m = u.match(/projectId=([^&]+)/);
      if (m) apiPids.push(decodeURIComponent(m[1]));
    }
  });
  await page.goto(q(FRONT + '/brands', SEED.projectB), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.core-brand-list .core-brand-card', { timeout: 15000 });
  await page.waitForTimeout(600); // 选择器下拉与 API 请求落定
  const pickerLabel = await page.textContent('.proj-picker-name').catch(() => '');
  check('顶部选择器显示项目 B（' + SEED.trackB + '）', (pickerLabel || '').includes(SEED.trackB), pickerLabel);
  check('品牌卡为项目 B 品牌（AromaHouse）', (await page.textContent('body')).includes('AromaHouse'));
  const apiForB = apiPids.filter(p => p === SEED.projectB).length;
  const apiForA = apiPids.filter(p => p === SEED.projectA).length;
  check('页面 API 请求使用项目 B（B=' + apiForB + ' 次，A=' + apiForA + ' 次）', apiForB > 0 && apiForA === 0, 'pids=' + JSON.stringify(apiPids));
  await page.screenshot({ path: path.join(SHOTS, 's1-deeplink-b.png'), fullPage: true });

  // ---------- S2 品牌详情 ?projectId=A&tab=timeline → 切换项目保留 tab ----------
  console.log('S2 切换项目保留非项目参数');
  await page.goto(FRONT + '/brands/' + encodeURIComponent(SEED.brandA) + '?projectId=' + encodeURIComponent(SEED.projectA) + '&tab=timeline', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.core-tabs', { timeout: 15000 });
  await page.waitForTimeout(500);
  check('时间线 Tab 处于激活态（tab=timeline 生效，标签「竞争动态」）', await page.locator('.core-tab.on', { hasText: '竞争动态' }).count() > 0);
  // 顶部选择器切到项目 B
  await page.click('.proj-picker summary');
  await page.click('.proj-picker-menu button:has-text("' + SEED.trackB + '")');
  await page.waitForURL(u => String(u).includes('projectId=' + SEED.projectB), { timeout: 15000 });
  const url2 = page.url();
  check('切换后 projectId 更新为 B', url2.includes('projectId=' + SEED.projectB), url2);
  check('切换后保留 tab=timeline（非项目参数不丢）', url2.includes('tab=timeline'), url2);
  await page.screenshot({ path: path.join(SHOTS, 's2-switch-keep-tab.png'), fullPage: true });

  // ---------- S3 品牌详情 → 侧栏四个核心入口 projectId 不丢 ----------
  console.log('S3 侧栏四核心入口');
  await page.goto(FRONT + '/brands/' + encodeURIComponent(SEED.brandA) + '?projectId=' + encodeURIComponent(SEED.projectA), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.side-nav', { timeout: 15000 });
  const sideTargets = [
    ['竞品库', '/brands'], ['情报库', '/intel'], ['机会视图', '/opportunity'], ['调研报告', '/report'],
  ];
  for (const [label, href] of sideTargets) {
    // href 前缀匹配（避免 /brands 命中 /brands/[brandId] 语义混淆——导航链接是固定 path）
    await page.click(`.side-nav .nav-item:has-text("${label}")`);
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(400);
    const u = page.url();
    const okPath = new URL(u).pathname === href;
    check('侧栏「' + label + '」→ ' + href + ' 保留 projectId', okPath && u.includes('projectId=' + SEED.projectA), u);
    await page.goto(FRONT + '/brands/' + encodeURIComponent(SEED.brandA) + '?projectId=' + encodeURIComponent(SEED.projectA), { waitUntil: 'networkidle', timeout: 30000 });
  }
  await page.screenshot({ path: path.join(SHOTS, 's3-side-nav.png'), fullPage: true });

  // ---------- S4 失败报告「重新生成」→ 跳转新报告任务 ----------
  console.log('S4 失败报告重新生成');
  await page.goto(q(FRONT + '/report', SEED.projectA), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.core-report-list', { timeout: 15000 });
  await page.waitForTimeout(400);
  const listText = await page.textContent('.core-report-list');
  check('列表含「生成失败」报告', listText.includes('生成失败'), listText.slice(0, 120));
  const navPromise = page.waitForURL(u => /\/report\/[^/?]+/.test(String(u)) && String(u).includes('projectId=' + SEED.projectA), { timeout: 20000 });
  await page.click('.core-report-list .btn-mini:has-text("重新生成")');
  await navPromise;
  const u4 = page.url();
  const newId = new URL(u4).pathname.split('/').pop();
  check('URL 切换为新报告任务（新 reportId）', newId && newId !== SEED.failedReportId, u4);
  check('新任务 URL 保留 projectId=A', u4.includes('projectId=' + SEED.projectA), u4);
  // 新任务页状态可见（排队中/生成中/已完成均为新任务的明确状态；轮询持续到终态）
  await page.waitForSelector('.core-report-detail', { timeout: 15000 });
  await page.waitForTimeout(3200); // 等一次轮询
  const detailStatus = await page.textContent('.core-report-detail .core-report-status').catch(() => '');
  check('新任务状态可见（' + (detailStatus || '').trim() + '）', ['排队中', '生成中', '自动重试中', '已完成'].some(s => (detailStatus || '').includes(s)), detailStatus);
  await page.screenshot({ path: path.join(SHOTS, 's4-regenerated.png'), fullPage: true });

  // ---------- S5 四项未接入维度诚实呈现（无 0 值 / 无模拟图表 / 无虚构来源） ----------
  console.log('S5 未接入维度诚实呈现');
  await page.goto(FRONT + '/brands/' + encodeURIComponent(SEED.brandA) + '?projectId=' + encodeURIComponent(SEED.projectA) + '&tab=coverage', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.core-building', { timeout: 15000 });
  const building = page.locator('.core-building').first();
  const bText = await building.textContent();
  const bHtml = await building.innerHTML();
  for (const dim of ['社媒内容', '广告活动', '口碑与评论', '搜索与热度']) {
    check('建设中区域列出「' + dim + '」', bText.includes(dim));
  }
  check('未接入维度标注「尚未接入」', bText.includes('尚未接入'));
  check('刷新位标注「不可用」（未接入）', bText.includes('不可用'));
  check('无虚构来源（不含「来源：已核实」等）', !bText.includes('来源：已核实') && !bText.includes('来源：采集'));
  check('区域内无图表（无 <svg> 模拟图表）', !bHtml.includes('<svg'));
  check('区域内无 0 值徽章（无「共 0」「0 条」「0 个」）', !/共\s*0|0\s*条|0\s*个/.test(bText));
  check('无伪数据词汇（不含「模拟数据」「示例数据」）', !bText.includes('模拟数据') && !bText.includes('示例数据'));
  await page.screenshot({ path: path.join(SHOTS, 's5-building-dims.png'), fullPage: true });

  await browser.close();
  console.log(failures === 0 ? '[e2e] ALL PASS（5 场景，截图目录 ' + SHOTS + '）' : '[e2e] ' + failures + ' FAIL');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('[e2e] FATAL', e && e.stack || e); process.exit(1); });
