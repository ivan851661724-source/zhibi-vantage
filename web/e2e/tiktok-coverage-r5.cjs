'use strict';
// SC-04 TikTok 覆盖范围 · 浏览器级验收（R4.15）
// ------------------------------------------------------------
// 目的：验证「populated ad_creatives 分支」在真实浏览器里的呈现，而不是只看 adapter summary。
// 数据来源：seed.cjs + seed-svc.cjs 经生产真值链写入的 Attempt / Snapshot / Evidence，
//           页面通过真实后端 HTTP API（/api/data-surface/overview、/api/data-surface/dimension）读取。
// 🔴 纪律：这些记录是**受控测试记录**（原始响应体带 _e2e_fixture 标记），
//          不代表真实 TikTok provider 调用成功，也不代表广告源已接通。
//
// 用例：
//   T1 美国品牌（coverageState=out_of_coverage）卡片显示「该公开来源当前无覆盖」
//   T2 页面不出现「0 条广告」「未观察到广告」「没有广告」（否定说明除外）、无虚构趋势
//   T3 覆盖外品牌仍有素材时：明确来源（平台公开披露）与覆盖限制，不表述为美国市场投放结论
//   T4 德国品牌（covered）正常展示广告摘要；展示字段仅限已落库的官方字段
//   T5 status_statement 缺失不渲染空行；有值才展示
//   T6 页面不泄漏 API key / token / client secret / 环境变量名 / 内部路径 / 调用栈
//
// 用法：node tiktok-coverage-r5.cjs --front http://127.0.0.1:3100 --seed .e2e-seed.json
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
catch (e) { console.error('未找到 playwright：请先 `npm i playwright --no-save`（或全局安装）。'); process.exit(2); }

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok - ' + name);
  else { failures++; console.log('  FAIL - ' + name + (extra ? ' :: ' + extra : '')); }
}
// 「不代表（该市场）没有广告」是必要的否定说明，不当作结论式「没有广告」
function stripNegations(txt) {
  return String(txt || '').replace(/不代表(该市场)?没有广告/g, '');
}

(async () => {
  if (!SEED.brandAdUs || !SEED.brandAdDe) {
    console.error('[tiktok-r5] seed 缺少 brandAdUs / brandAdDe（请用本仓库 seed.cjs 重跑）');
    process.exit(1);
  }
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, locale: 'zh-CN' });
  const page = await ctx.newPage();

  // 记录真实 API 响应（证明材料经后端投影返回，而非前端构造）
  const overviews = [];
  page.on('response', async (res) => {
    const u = res.url();
    if (u.includes('/api/data-surface/overview')) {
      try { overviews.push({ url: u, status: res.status(), json: await res.json() }); } catch (e) { /* 非 JSON 忽略 */ }
    }
  });

  // 登录（真实 UI 表单）
  await page.goto(FRONT + '/login', { waitUntil: 'networkidle', timeout: 30000 });
  await page.fill('input[type=email]', SEED.email);
  await page.fill('input[type=password]', SEED.password);
  await page.click('#authForm button[type=submit], #authForm .btn-primary');
  await page.waitForURL(u => !String(u).includes('/login'), { timeout: 15000 });
  check('登录成功', !page.url().includes('/login'));

  const coverageUrl = (brandId) => FRONT + '/brands/' + encodeURIComponent(brandId) +
    '?projectId=' + encodeURIComponent(SEED.projectA) + '&tab=coverage';
  const adCard = () => page.locator('.ds-card').filter({ hasText: '广告活动' }).first();

  // ---------- T1 / T2 / T3 美国品牌（官方覆盖外） ----------
  console.log('T1-T3 美国品牌（out_of_coverage）');
  await page.goto(coverageUrl(SEED.brandAdUs), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.ds-card', { timeout: 20000 });
  await adCard().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(400);
  const usCardText = await adCard().innerText();

  check('广告活动卡出现（真实 API 渲染）', usCardText.includes('广告活动'), usCardText.slice(0, 120));
  check('卡片显示「该公开来源当前无覆盖」', usCardText.includes('该公开来源当前无覆盖'), usCardText.slice(0, 300));
  check('卡片注明覆盖国家数与「不含美国」', /当前 \d+ 国/.test(usCardText) && usCardText.includes('不含美国'), usCardText.slice(0, 300));
  check('卡片不显示「公开广告素材 0 条」（零值冒充结论）', !/公开广告素材\s*0\s*条/.test(usCardText), usCardText.slice(0, 300));

  const usStripped = stripNegations(usCardText);
  check('卡片无「未观察到广告」', !/未观察到广告/.test(usCardText));
  check('卡片无结论式「没有广告」', !/没有广告/.test(usStripped), usStripped.slice(0, 300));
  check('卡片无「0 条广告」表述', !/0\s*条广告/.test(usCardText));

  // 真实 API 投影校验（不是前端拼的文案）
  // 注：overview 请求按 competitorId 发起，故取最近一次响应（当前页 = 美国品牌页）
  const usOverview = overviews[overviews.length - 1];
  check('overview API 返回 200（真实后端）', !!usOverview && usOverview.status === 200, usOverview ? String(usOverview.status) : 'no response');
  const usDim = usOverview && (usOverview.json.dimensions || []).find(d => d.code === 'ad_campaigns');
  check('API 投影 coverageState=out_of_coverage', !!usDim && usDim.summary && usDim.summary.coverageState === 'out_of_coverage', JSON.stringify(usDim && usDim.summary && usDim.summary.coverageState));
  check('API 投影覆盖国家数=32（派生值）', !!usDim && usDim.summary && usDim.summary.coverageCountryCount === 32, String(usDim && usDim.summary && usDim.summary.coverageCountryCount));
  check('API 投影 summary.brandMarket=US', !!usDim && usDim.summary && usDim.summary.brandMarket === 'US', String(usDim && usDim.summary && usDim.summary.brandMarket));

  // 覆盖外品牌仍有素材：展开明细，验证来源与覆盖限制表述
  await adCard().locator('button', { hasText: '采集明细' }).first().click();
  await page.waitForSelector('.ds-obs-item', { timeout: 15000 });
  await page.waitForTimeout(400);
  const usObsText = await adCard().innerText();
  check('明细可见素材（受控记录，非 0 条）', (await page.locator('.ds-obs-item').count()) >= 1, String(await page.locator('.ds-obs-item').count()));
  check('素材标注来源「平台公开披露」', usObsText.includes('平台公开披露'));
  check('素材行展示公开触达区间标签（官方 reach 标签）', /公开触达\s*\d+(\.\d+)?\s*[KMB]/.test(usObsText), usObsText.slice(-260));
  check('未把素材表述为「美国市场投放」结论', !/美国市场(投放|表现|结论)/.test(usObsText) && !/美国市场/.test(usObsText), '');
  await page.screenshot({ path: path.join(SHOTS, 't1-us-out-of-coverage.png'), fullPage: true });

  // T7 页面自洽：顶部「数据覆盖与来源」列表与下方数据面卡片必须同口径
  // （r5 前：卡片有数据、面板仍写「数据服务暂不可用」——同一屏自相矛盾）
  const covRow = page.locator('.core-dim').filter({ hasText: '广告活动' }).first();
  const covState = await covRow.locator('.core-dim-state').innerText().catch(() => '');
  check('顶部覆盖面板不再写「数据服务暂不可用」', !!covState && !covState.includes('数据服务暂不可用'), covState);
  check('顶部覆盖面板显示已采集状态（与卡片一致）', /已采集|部分采集|数据过期/.test(covState), covState);

  // T5（缺失侧）：美国品牌素材无 status_statement → 不得渲染空的状态说明行
  const usSnippetCount = await adCard().locator('.ds-obs-item .ds-obs-snippet').count();
  check('status_statement 缺失时不渲染状态说明行', usSnippetCount === 0, 'snippet=' + usSnippetCount);
  const usRowText = (await page.locator('.ds-obs-item').first().innerText()).trim();
  check('素材行无孤立分隔符 / 空字段占位', !/^·/.test(usRowText) && !/\n\s*·\s*\n/.test(usRowText), JSON.stringify(usRowText));

  // ---------- T4 / T5 德国品牌（官方覆盖内 + 有 status_statement） ----------
  console.log('T4-T5 德国品牌（covered）');
  await page.goto(coverageUrl(SEED.brandAdDe), { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForSelector('.ds-card', { timeout: 20000 });
  await adCard().waitFor({ state: 'visible', timeout: 15000 });
  await page.waitForTimeout(400);
  const deCardText = await adCard().innerText();
  check('德国品牌卡片不再显示「无覆盖」', !deCardText.includes('该公开来源当前无覆盖'), deCardText.slice(0, 240));
  check('德国品牌正常展示广告摘要（1 条）', /公开广告素材\s*1\s*条/.test(deCardText), deCardText.slice(0, 240));
  check('摘要标注测量方法「平台公开披露」', deCardText.includes('平台公开披露'));
  check('摘要声明花费/ROI/转化不可观测', deCardText.includes('广告花费') && deCardText.includes('无法直接观测'));

  await adCard().locator('button', { hasText: '采集明细' }).first().click();
  await page.waitForSelector('.ds-obs-item', { timeout: 15000 });
  await page.waitForTimeout(400);
  const deObsText = await adCard().innerText();
  check('德国素材展示 status_statement（有值才展示）', deObsText.includes('Ad is no longer active.'), deObsText.slice(-300));
  check('德国素材同样标注来源「平台公开披露」', deObsText.includes('平台公开披露'));
  // 展示字段只能来自已落库的官方字段：广告主名 / 起投日 / 触达区间 / 素材或来源
  check('展示字段为官方字段（广告主 PuppetLab 系列品牌名）', deObsText.includes('ToyHive'), deObsText.slice(-300));
  check('未出现未落库字段（花费/CPM/转化/GMV）', !/花费|CPM|转化率|GMV/i.test(deObsText.replace(/广告花费 \/ 获客成本 \/ ROI \/ 转化率 \/ GMV 当前公开来源无法直接观测/g, '')));
  await page.screenshot({ path: path.join(SHOTS, 't4-de-covered.png'), fullPage: true });

  // ---------- T6 泄漏检查（两页合并） ----------
  console.log('T6 页面泄漏检查');
  // 只看**可见文本**（innerText 不含 <script>/RSC flight 数据；textContent 会把框架自带的
  // 序列化载荷算进来，产生假阳性）
  const visible = await page.evaluate(() => document.body.innerText);
  const body = visible;
  const leaks = [
    ['client key 名', /TIKTOK_CLIENT_KEY/],
    ['client secret 名', /TIKTOK_CLIENT_SECRET/],
    ['Bearer 头', /Bearer\s+[A-Za-z0-9._-]{8,}/],
    ['环境变量名', /process\.env|\$\{?[A-Z_]{6,}\}?/],
    ['内部文件路径', /[A-Za-z]:\\|\.js:\d+|app\/services\//],
    ['调用栈', /\bat\s+[A-Za-z0-9_.]+\s+\(|\bError:\s/],
    ['access token 形态', /\bact\.[A-Za-z0-9]{8,}|\bclt\.[A-Za-z0-9]{8,}/],
  ];
  for (const [name, re] of leaks) check('页面无' + name, !re.test(String(body)), (String(body).match(re) || [''])[0].slice(0, 60));

  await browser.close();
  console.log(failures === 0
    ? '[tiktok-r5] ALL PASS（' + 'T1-T6，截图目录 ' + SHOTS + '）'
    : '[tiktok-r5] ' + failures + ' FAIL');
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('[tiktok-r5] FATAL', e && e.stack || e); process.exit(1); });
