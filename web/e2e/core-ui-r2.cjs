'use strict';
// SC-04 UI 框架轮 · Playwright 验收用例（真实租户 API 链路，零 mock）
// r3 起本文件覆盖 UI 框架轮全部浏览器回归（r2 场景保留/按新规则改写）：
//   S1 深链接打开项目 B：顶部显示项目 B，页面 API 请求也使用项目 B
//   S2 品牌详情 ?projectId=A&tab=timeline 切换项目 → 跳 /brands?projectId=B
//      （r3 规则 2：brandId/tab 属于原项目，不跨项目保留；改写 r2 的「保留 tab」语义）
//   S3 带 projectId 的品牌详情点侧栏四个核心入口 → projectId 不丢失
//   S4 失败报告点「重新生成」→ URL 切换为新报告任务（新 reportId + 同 projectId），新任务有状态
//   S5 四项未接入维度：无 0 值、无模拟图表、无虚构来源，刷新位标注不可用
//   S6 报告详情 ?projectId=A 切换项目 → 跳 /report?projectId=B（不保留 reportId，
//      页面不再展示 A 的报告正文/引用/失败态，展示 B 的列表或空状态）（r3 规则 3）
//   S7 情报库 ?projectId=A&brandId=<A品牌> 切换项目 → URL 清除 brandId，
//      展示 B 的真实数据或真实空状态，无筛选残留造成的假空结果（r3 规则 1）
//   S8 情报库噪音修复（r4.10）：主列表无「XX：未接入」卡片；底部「数据覆盖
//      与建设中维度」区域恰 4 项、无时间戳/「暂无可打开来源」/「待核实」；
//      统一文案；真实采集项（成功/部分完成）保留
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

  // ---------- S2 品牌详情切项目 → 跳竞品库列表页（r3 规则 2） ----------
  console.log('S2 品牌详情切换项目 → 跳列表页（资源上下文不跨项目）');
  await page.goto(FRONT + '/brands/' + encodeURIComponent(SEED.brandA) + '?projectId=' + encodeURIComponent(SEED.projectA) + '&tab=timeline', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.core-tabs', { timeout: 15000 });
  await page.waitForTimeout(500);
  check('时间线 Tab 处于激活态（tab=timeline 生效，标签「竞争动态」）', await page.locator('.core-tab.on', { hasText: '竞争动态' }).count() > 0);
  // 顶部选择器切到项目 B
  await page.click('.proj-picker summary');
  await page.click('.proj-picker-menu button:has-text("' + SEED.trackB + '")');
  await page.waitForURL(u => { const s = String(u); return new URL(s).pathname === '/brands' && s.includes('projectId=' + SEED.projectB); }, { timeout: 15000 });
  await page.waitForSelector('.core-brand-list .core-brand-card', { timeout: 15000 });
  const url2 = page.url();
  check('URL 为 /brands?projectId=B（详情页不保留原品牌）', new URL(url2).pathname === '/brands' && url2.includes('projectId=' + SEED.projectB), url2);
  check('不保留 tab=timeline（品牌详情上下文不跨项目）', !url2.includes('tab='), url2);
  const body2 = await page.textContent('body');
  check('页面展示 B 的竞品列表（AromaHouse）', body2.includes('AromaHouse'));
  check('无错误现场（BRAND_NOT_IN_PROJECT / 无法找到）且无 A 的品牌（DollForge）', !body2.includes('BRAND_NOT_IN_PROJECT') && !body2.includes('无法找到') && !body2.includes('DollForge'));
  await page.screenshot({ path: path.join(SHOTS, 's2-brand-switch-to-list.png'), fullPage: true });

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

  // ---------- S5 建设中维度诚实呈现（r2：用户侧四种口径，凭据细节仅管理员接口） ----------
  console.log('S5 建设中维度诚实呈现');
  await page.goto(FRONT + '/brands/' + encodeURIComponent(SEED.brandA) + '?projectId=' + encodeURIComponent(SEED.projectA) + '&tab=coverage', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.core-building', { timeout: 15000 });
  const building = page.locator('.core-building').first();
  const bText = await building.textContent();
  const bHtml = await building.innerHTML();
  for (const dim of ['社媒内容', '广告活动', '口碑与评论', '搜索与热度']) {
    check('建设中区域列出「' + dim + '」', bText.includes(dim));
  }
  check('维度状态标注「数据服务暂不可用」（r2 用户侧口径，不写「未接入」）', bText.includes('数据服务暂不可用'));
  check('用户页面零凭据变量名（YOUTUBE_API_KEY 等不出现）', !/YOUTUBE_API_KEY|DATAFORSEO_|TIKTOK_CLIENT|SERPER_API_KEY/.test(bText));
  check('无「需要配置：」管理语气文案', !bText.includes('需要配置：'));
  check('无虚构来源（不含「来源：已核实」等）', !bText.includes('来源：已核实') && !bText.includes('来源：采集'));
  check('区域内无图表（无 <svg> 模拟图表）', !bHtml.includes('<svg'));
  check('区域内无 0 值徽章（无「共 0」「0 条」「0 个」）', !/共\s*0|0\s*条|0\s*个/.test(bText));
  check('无伪数据词汇（不含「模拟数据」「示例数据」）', !bText.includes('模拟数据') && !bText.includes('示例数据'));
  await page.screenshot({ path: path.join(SHOTS, 's5-building-dims.png'), fullPage: true });

  // ---------- S6 报告详情切项目 → 跳报告列表页（r3 规则 3） ----------
  console.log('S6 报告详情切换项目 → 跳列表页（reportId 不跨项目）');
  await page.goto(FRONT + '/report/' + encodeURIComponent(SEED.failedReportId) + '?projectId=' + encodeURIComponent(SEED.projectA), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.core-report-detail', { timeout: 15000 });
  await page.waitForTimeout(500);
  const detA = await page.textContent('body');
  check('A 报告详情可见（失败态或详情内容）', detA.includes('生成失败') || detA.includes('重新生成'), detA.slice(0, 80));
  await page.click('.proj-picker summary');
  await page.click('.proj-picker-menu button:has-text("' + SEED.trackB + '")');
  await page.waitForURL(u => { const s = String(u); return new URL(s).pathname === '/report' && s.includes('projectId=' + SEED.projectB); }, { timeout: 15000 });
  await page.waitForSelector('.core-reports-section', { timeout: 15000 });
  await page.waitForTimeout(800);
  const url6 = page.url();
  check('URL 为 /report?projectId=B（不保留原 reportId）', new URL(url6).pathname === '/report' && url6.includes('projectId=' + SEED.projectB) && !url6.includes(SEED.failedReportId), url6);
  const body6 = await page.textContent('.core-reports-section');
  check('不再展示 A 的报告内容（无「生成失败」/「结构化事实版本」）', !body6.includes('生成失败') && !body6.includes('结构化事实版本'));
  check('展示 B 的报告列表空状态（暂无报告）', body6.includes('暂无报告'));
  await page.screenshot({ path: path.join(SHOTS, 's6-report-switch-to-list.png'), fullPage: true });

  // ---------- S7 情报库带 A 的 brandId 筛选切项目 → 清除 brandId（r3 规则 1） ----------
  console.log('S7 情报库 brandId 筛选切换项目 → 清除资源筛选');
  await page.goto(FRONT + '/intel?projectId=' + encodeURIComponent(SEED.projectA) + '&brandId=' + encodeURIComponent(SEED.brandA), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.core-inbox', { timeout: 15000 });
  await page.waitForSelector('.core-intel li', { timeout: 15000 });
  const cntA = await page.locator('.core-intel li').count();
  check('A 项目带 brandId 筛选展示该品牌情报（' + cntA + ' 条）', cntA > 0);
  const selA = await page.locator('.core-inbox select').first().inputValue().catch(() => '');
  check('品牌筛选下拉当前值为 A 的品牌', selA === SEED.brandA, selA);
  await page.click('.proj-picker summary');
  await page.click('.proj-picker-menu button:has-text("' + SEED.trackB + '")');
  await page.waitForURL(u => { const s = String(u); return s.includes('projectId=' + SEED.projectB) && !s.includes('brandId='); }, { timeout: 15000 });
  const url7 = page.url();
  check('URL 已清除 brandId 且指向项目 B', !url7.includes('brandId=') && url7.includes('projectId=' + SEED.projectB), url7);
  // 等待数据真正切换：A 的旧卡片被替换（不再出现 DollForge）且 B 数据/空态落定。
  // 注意不能用「li>0」单条件——组件复用时 A 的旧列表会先满足它。
  await page.waitForFunction(() => {
    const box = document.querySelector('.core-inbox');
    if (!box) return false;
    const t = box.textContent || '';
    if (t.includes('DollForge')) return false; // 仍是项目 A 的旧数据
    return t.includes('尚无采集结果') || t.includes('当前筛选没有结果') || document.querySelectorAll('.core-intel li').length > 0;
  }, undefined, { timeout: 15000 });
  const body7 = await page.textContent('.core-inbox');
  const cntB = await page.locator('.core-intel li').count();
  check('展示 B 的真实数据或真实空状态（' + (cntB > 0 ? cntB + ' 条情报' : '空状态') + '）', cntB > 0 || body7.includes('尚无采集结果'));
  check('无筛选残留假空标志「当前筛选没有结果」', !body7.includes('当前筛选没有结果'));
  check('无 A 项目情报内容（DollForge）', !body7.includes('DollForge'));
  await page.screenshot({ path: path.join(SHOTS, 's7-intel-clear-brandid.png'), fullPage: true });

  // ---------- S8 情报库噪音修复（r4.10）：未接入维度 ≠ 情报事件 ----------
  console.log('S8 未接入维度去噪 + 底部建设中区域');
  await page.goto(q(FRONT + '/intel', SEED.projectA), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.core-inbox', { timeout: 15000 });
  await page.waitForFunction(() => {
    const box = document.querySelector('.core-inbox');
    if (!box) return false;
    const t = box.textContent || '';
    return t.includes('尚无采集结果') || document.querySelectorAll('.core-intel li').length > 0;
  }, undefined, { timeout: 15000 });
  await page.waitForTimeout(400);
  const bodyA = await page.textContent('.core-inbox');
  // 主列表：无「XX：未接入」噪音卡片（seed A 项目 3 品牌，修复前会有 12 条此类噪音）
  check('主列表无「：未接入」噪音卡片', !bodyA.includes('：未接入') && !bodyA.includes('：未接入\n'));
  for (const dim of ['社媒内容', '广告活动', '口碑与评论', '搜索与热度']) {
    check('主列表无「' + dim + '：未接入」', !bodyA.includes(dim + '：未接入'));
  }
  // 真实采集项保留（seed full：ok 品牌 1 次成功 + partial 品牌 1 次部分完成）
  const lisA = await page.locator('.core-intel li').count();
  check('真实情报项保留（成功/部分完成，A 项目恰 2 条）', lisA === 2, '实际 ' + lisA);
  check('「采集完成」项在列表中', bodyA.includes('采集完成'));
  // 底部建设中区域：折叠面板恰 4 项
  await page.click('.core-building-fold > summary');
  await page.waitForTimeout(200);
  const fold = page.locator('.core-building-fold');
  check('底部建设中区域存在（唯一、可折叠）', (await fold.count()) === 1);
  const foldLis = await page.locator('.core-building-fold .core-building-list > li').count();
  check('建设中区域恰 4 项（每维度一条，不随品牌数重复）', foldLis === 4, '实际 ' + foldLis);
  const foldText = await fold.textContent();
  for (const dim of ['社媒内容', '广告活动', '口碑与评论', '搜索与热度']) {
    check('建设中区域列出「' + dim + '」恰一次', (foldText.match(new RegExp(dim, 'g')) || []).length === 1);
  }
  // r2：pending_config 用户侧口径——「数据服务暂不可用…当前不生成数据、估算或结论。」
  check('「数据服务暂不可用」出现（每项，≥4 次）', (foldText.match(/数据服务暂不可用/g) || []).length >= 4);
  check('「当前不生成数据、估算或结论」出现（含 hint，≥4 次）', (foldText.match(/当前不生成数据、估算或结论/g) || []).length >= 4);
  check('用户页面零凭据变量名', !/YOUTUBE_API_KEY|DATAFORSEO_|TIKTOK_CLIENT|SERPER_API_KEY/.test(foldText));
  check('无时间戳（不含日期格式）', !/\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/.test(foldText));
  check('无「待核实」徽章', !foldText.includes('待核实'));
  check('无「暂无可打开来源」', !foldText.includes('暂无可打开来源'));
  check('无「资料不足」', !foldText.includes('资料不足'));
  check('无「尚未采集」事件字样', !foldText.includes('尚未采集'));
  const foldHtml = await fold.innerHTML();
  check('无 svg 图表 / 无 Evidence 链接', !foldHtml.includes('<svg') && !foldHtml.includes('href='));
  await page.screenshot({ path: path.join(SHOTS, 's8-intel-noise-fix.png'), fullPage: true });

  await browser.close();
  console.log(failures === 0 ? '[e2e] ALL PASS（8 场景，截图目录 ' + SHOTS + '）' : '[e2e] ' + failures + ' FAIL');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('[e2e] FATAL', e && e.stack || e); process.exit(1); });
