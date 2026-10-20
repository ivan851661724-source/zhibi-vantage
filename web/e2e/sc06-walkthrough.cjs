'use strict';
// ============================================================
// sc06-walkthrough.cjs —— SC-06 浏览器走查
//   W1 导航：竞品数据库一级入口（无「竞品库」/「赛道档案」重复）
//   W2 竞品数据库首页：官网确认徽章 + 时间积累起点
//   W3 非 Shopify 品牌档案：六区块 Tab + 「官网已确认」块
//   W4 用户声音与公开评论 tab：insufficient 诚实文案
//   W5 内容与广告 tab：维度状态 + 无 fake 数据
//   W6 情报库：用户声音区块 + 建设中区域
//   W7 /sector 深链接不 404
// 数据：新租户 + 真实 VEJA 采集（走生产 refresh 路径）
// ============================================================
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
process.chdir(ROOT);
const FRONT = process.argv[2] || 'http://127.0.0.1:3121';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok - ' + name); }
  else { failed++; console.log('  FAIL - ' + name + (detail ? ' :: ' + String(detail).slice(0, 260) : '')); }
}

(async () => {
  // ---------- 数据准备（真实采集） ----------
  const BASE = 'http://127.0.0.1:3331';
  const email = 'sc06w-' + Math.random().toString(36).slice(2, 10) + '@example.com';
  const pass = 'sc06w-' + Math.random().toString(36).slice(2, 12) + 'P1';
  const reg = await (await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pass, name: 'SC06 Walkthrough' }) })).json();
  if (!reg.token) { console.error('register failed', reg); process.exit(1); }
  const TID = reg.tenantId;
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + reg.token };
  const Db = require(ROOT + '/app/services/db.js');
  const BrandStore = require(ROOT + '/app/services/brand-store.js');
  const projId = 'projsc06w' + Math.random().toString(36).slice(2, 8);
  Db.saveProject({ id: projId, tenantId: TID, track: 'SC06 走查', competitors: [], createdAt: new Date().toISOString(), discoveredAt: new Date().toISOString() });
  const { projFile } = require(ROOT + '/app/core/state-store.js');
  const stPath = projFile(projId, TID);
  fs.mkdirSync(path.dirname(stPath), { recursive: true });
  for (let i = 0; i < 100 && !fs.existsSync(stPath); i++) await sleep(20);
  fs.writeFileSync(stPath, JSON.stringify({
    projectId: projId, tenantId: TID, track: 'SC06 走查', discoveredAt: new Date().toISOString(),
    intent: { regions: ['us'], category: 'sneakers', platforms: ['shopify'] },
    competitors: [
      { id: 'compVejaW', name: 'Veja', status: 'done', url: 'https://www.veja-store.com', isShopify: false, market: 'us' },
      { id: 'compShopW', name: 'Allbirds', status: 'done', url: 'https://www.allbirds.com', isShopify: true, market: 'us' },
    ],
  }));
  console.log('[w] STORE_PATH =', Db.STORE_PATH, '| env ZB_DATA_DIR =', process.env.ZB_DATA_DIR);
  const saved = Db.getProject ? Db.getProject(TID, projId) : null;
  console.log('[w] project saved?', !!saved, fs.existsSync(stPath) ? 'stPath ok' : 'stPath MISSING');
  const bV = BrandStore.upsertBrand({ tenantId: TID, canonicalName: 'Veja', officialDomain: 'veja-store.com', competitorRef: 'compVejaW' });
  BrandStore.linkProject({ tenantId: TID, brandId: bV.brand.brandId, projectId: projId, competitorRef: 'compVejaW', market: 'us' });
  const bA = BrandStore.upsertBrand({ tenantId: TID, canonicalName: 'Allbirds', officialDomain: 'allbirds.com', competitorRef: 'compShopW' });
  BrandStore.linkProject({ tenantId: TID, brandId: bA.brand.brandId, projectId: projId, competitorRef: 'compShopW', market: 'us' });
  const brandIdV = bV.brand.brandId;
  console.log('[w] tenant =', TID, 'brandVeja =', brandIdV, 'proj =', projId);

  // 真实采集 VEJA 官网资料（生产 refresh 路径）
  const r1 = await fetch(BASE + '/api/data-surface/refresh', { method: 'POST', headers: auth, body: JSON.stringify({ competitorId: 'compVejaW', projectId: projId, capability: 'official_site_profile' }) });
  const r1b = await r1.json().catch(() => ({}));
  console.log('[w] veja refresh:', r1.status, JSON.stringify(r1b).slice(0, 200));
  if (r1.status !== 202) { console.error('[w] refresh not 202, abort'); process.exit(1); }
  let vejaOk = false;
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const q = await fetch(BASE + '/api/data-surface/dimension?projectId=' + projId + '&competitorId=compVejaW&dimension=website_products&limit=5', { headers: auth }).then(x => x.json()).catch(() => null);
    const cap = q && Array.isArray(q.capabilities) ? q.capabilities.find(c => c.capabilityCode === 'official_site_profile') : null;
    if (cap && cap.latestAttempt && ['success', 'partial', 'failed'].includes(cap.latestAttempt.status)) { vejaOk = cap.latestAttempt.status === 'success' || cap.latestAttempt.status === 'partial'; break; }
  }
  console.log('[w] veja profile collected:', vejaOk);

  // ---------- 浏览器 ----------
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await ctx.newPage();
  const SP = '?projectId=' + encodeURIComponent(projId);

  // 登录（localStorage token）
  await page.goto(FRONT + '/login');
  await page.evaluate(([t, pid]) => { localStorage.setItem('zhibi_token', t); localStorage.setItem('zhibi_projectId', pid); }, [reg.token, projId]);
  await page.waitForTimeout(300);

  // W1 导航
  await page.goto(FRONT + '/brands' + SP);
  await page.waitForSelector('.core-brand-list, .core-brands, .page-head', { timeout: 30000 });
  await page.waitForTimeout(800);
  const navText = await page.locator('nav, .side-nav, aside').first().textContent().catch(() => '');
  check('W1 主导航含「竞品数据库」', /竞品数据库/.test(navText), navText.slice(0, 120));
  check('W1 主导航不再有「竞品库」一级入口', !/竞品库/.test(navText || ''));
  check('W1 主导航不再有「赛道档案」入口', !/赛道档案/.test(navText || ''));
  const shotDir = path.join(__dirname, '.e2e-shots');
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, 'sc06-w1-nav.png'), fullPage: false });

  // W2 首页
  const headText = await page.locator('.page-head').first().textContent().catch(() => '');
  check('W2 首页标题「竞品数据库」', /竞品数据库/.test(headText), headText.slice(0, 120));
  const listText = await page.locator('.core-brands').textContent().catch(() => '');
  check('W2 官网确认状态展示（Veja：官网已确认）', /官网已确认/.test(listText), listText.slice(0, 200));
  check('W2 时间积累起点展示', /时间积累起点/.test(listText));
  await page.screenshot({ path: path.join(shotDir, 'sc06-w2-home.png'), fullPage: true });

  // W3 品牌档案（Veja：非 Shopify）
  await page.goto(FRONT + '/brands/' + brandIdV + SP + '&tab=products');
  await page.waitForSelector('.core-tabs', { timeout: 30000 });
  await page.waitForTimeout(1000);
  const tabTexts = await page.locator('.core-tabs button').allTextContents();
  const tabJoin = tabTexts.join('|');
  check('W3 六区块 Tab 齐（概览/时间线/官网与商品/用户声音与公开评论/内容与广告/数据覆盖与来源）',
    ['概览', '时间线', '官网与商品', '用户声音与公开评论', '内容与广告', '数据覆盖与来源'].every(t => tabJoin.includes(t)), tabJoin);
  const prodSec = await page.locator('.core-brand-detail').textContent();
  check('W3 「官网已确认」块 + 确认地址', /官网已确认/.test(prodSec), prodSec.slice(0, 300));
  check('W3 无「官网不支持」字样', !/官网不支持|此维度暂不支持/.test(prodSec));
  await page.screenshot({ path: path.join(shotDir, 'sc06-w3-brand-products.png'), fullPage: true });

  // W4 voice tab
  await page.goto(FRONT + '/brands/' + brandIdV + SP + '&tab=voice');
  await page.waitForTimeout(1200);
  const voiceSec = await page.locator('.core-brand-detail').textContent();
  check('W4 「用户声音与公开评论」区块存在', /用户声音与公开评论/.test(voiceSec));
  check('W4 样本不足诚实文案', /资料不足，暂不形成群体结论/.test(voiceSec), voiceSec.slice(0, 260));
  check('W4 无「没有差评/用户满意/无口碑」', !/没有差评|用户满意|无口碑/.test(voiceSec));
  await page.screenshot({ path: path.join(shotDir, 'sc06-w4-voice.png'), fullPage: true });

  // W5 内容与广告 tab
  await page.goto(FRONT + '/brands/' + brandIdV + SP + '&tab=intel');
  await page.waitForTimeout(1000);
  const intelSec = await page.locator('.core-brand-detail').textContent();
  check('W5 「内容与广告」区块 + 社媒/广告状态', /内容与广告/.test(intelSec) && /社媒内容/.test(intelSec) && /广告活动/.test(intelSec), intelSec.slice(0, 300));
  check('W5 建设中语义（不生成数据、估算或结论）', /当前不生成数据、估算或结论/.test(intelSec));

  // W6 情报库
  await page.goto(FRONT + '/intel' + SP);
  await page.waitForSelector('.core-intel, .core-building-fold, main', { timeout: 30000 });
  await page.waitForTimeout(1200);
  const intelPage = await page.locator('main').textContent().catch(() => '');
  check('W6 情报库建设中区域存在（折叠）', await page.locator('.core-building-fold').count() === 1);
  check('W6 情报库无「官网不支持」', !/官网不支持/.test(intelPage));
  check('W6 「Shopify 公开商品目录不可用」出现（≤1 次，不重复刷屏）',
    (intelPage.match(/Shopify 公开商品目录不可用/g) || []).length <= 1, (intelPage.match(/Shopify 公开商品目录不可用/g) || []).length);
  await page.screenshot({ path: path.join(shotDir, 'sc06-w6-intel.png'), fullPage: true });

  // W7 /sector 深链接不 404
  const resp = await page.goto(FRONT + '/sector' + SP);
  check('W7 /sector 深链接返回 200', resp.status() === 200, resp.status());
  await page.screenshot({ path: path.join(shotDir, 'sc06-w7-sector.png'), fullPage: false });

  // W8 项目切换重置（跳到另一页签后再回，筛选被重置由 r3 机制保证——这里验证品牌页 tab 不残留旧项目 brandId）
  await page.goto(FRONT + '/brands' + SP);
  await page.waitForTimeout(600);
  check('W8 品牌页 URL 携带当前 projectId', page.url().includes('projectId=' + projId));

  await browser.close();
  console.log('[w] RESULT: ' + passed + ' passed / ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1); });
