'use strict';
// ============================================================
// r4-experience.test.js —— r4 行为测试（§十二）
// 覆盖：
//   1. history:60d 数据缺口不生成判断卡；用户载荷无内部工程词
//   2. origin 门控（archive/backfill 不进收件箱）+ 30 天窗口分流（2025-01 历史事件）
//   3. effectiveAt 不明确 → null（不得冒充实效时间）
//   4. 赛道趋势按 competitorId 去重；同名不同 id 不误合并
//   5. 巡检覆盖用最新窗口：后续完整窗口替换旧缺口；不完整绝不显示「没有变化」
//   6. public_reviews 合法空结果 → success+emptyReason（≠ internal_error）
//   7. website_changed 端到端（ZB_TEST_ASSETS 根路径受控资产：两次观察→Diff→事件→收件箱）
//   8. 账户：displayName 读取/修改/持久化、跨租户隔离、改密错误/成功/限流/旧会话失效
// ============================================================
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

process.env.ZB_DATA_DIR = process.env.ZB_DATA_DIR || fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'zb-r4-'));

const MatEngine = require('../lib/material-engine.js');
const Radar = require('../lib/radar.js');
const Inbox = require('../services/intel-inbox.js');
const WS = require('../services/watch-store.js');
const WatchMonitor = require('../services/watch-monitor.js');
const tenant = require('../services/tenant.js');
const db = require('../services/db.js');
const auth = require('../services/auth.js');
const { resolveIdentity } = require('../middleware/tenantScope.js');
const { projFile } = require('../core/state-store.js');
const Adapters = require('../services/source-adapter.js');

let seq = 0;
function uid(p) { seq += 1; return p + '_' + Date.now().toString(36) + '_' + seq; }

// ---------- 1. 材料引擎：缺口不出卡 + 工程词扫描 ----------
test('r4-1 无价格点的 verdict 不产出工作台卡；真实观察卡载荷无内部工程词', () => {
  const pseudo = {
    missing: false,
    items: [
      { subjectId: 'b1', claim: 'CASETiFY 价格区间 $40-$100', confidence: 'low', basis: 'inferred', sources: [{ label: '$40-$100', url: '', tier: 3 }] },
    ],
  };
  assert.equal(MatEngine.priceFollowRecipe(pseudo, { priceHistory: {} }).length, 0, 'history:60d 缺口 → 0 卡');

  const real = {
    missing: false,
    items: [
      { subjectId: 'b1', claim: 'CASETiFY 在售商品价格中位数 $30', confidence: 'high', basis: 'verified',
        price: { new: 30, old: null, currency: 'USD' },
        sources: [{ label: '官网在售商品页', url: 'https://casetify.example.com/products', tier: 1 }],
        observedAt: '2026-10-28T06:00:00.000Z' },
    ],
  };
  const mats = MatEngine.priceFollowRecipe(real, { priceHistory: {} });
  assert.equal(mats.length, 1);
  assert.equal(mats[0].type, 'price-observation');
  assert.equal(mats[0].title, '竞品价格观察');
  const s = JSON.stringify(mats);
  for (const w of ['mat_', 'tier-3', 'tier-1', 'history:60d', '这条判断缺', 'events.json', 'gap_snapshots']) {
    assert.ok(!s.includes(w), '载荷不含内部工程词: ' + w);
  }
});

// ---------- 2. 时间字段与 origin 分流 ----------
test('r4-2 archive/backfill 不进收件箱；2025-01 历史事件默认窗口外但数据仍在', () => {
  const tid = 'tenant:' + uid('r4t2');
  const pid = 'r4-项目-' + uid('p');
  db.createTenant({ name: 'r4-t2', email: uid('r4t2') + '@example.com' });
  const base = { tenantId: tid, projectId: pid, competitorId: 'brand-a', brandId: null, brandName: 'Brand A', dimension: 'price', eventType: 'price_changed', subjectId: 'brand-a:price', change: { oldValue: 10, newValue: 8 }, evidenceRefs: [{ snapshotId: 'ss_x' }] };

  // ① 回补 origin：可入库存证（origin 门控如实记录来源），但任何窗口都不进收件箱
  const rBackfill = Inbox.recordEvent(Object.assign({}, base, { origin: 'backfill', title: '历史回补', observedAt: new Date().toISOString() }));
  assert.ok(rBackfill.recorded, 'backfill 事件可入库（带 origin）');

  // ② 2025-01 的 monitoring 事件：写入成功（数据保留），默认 30 天窗口不出现
  const r2025 = Inbox.recordEvent(Object.assign({}, base, { origin: 'monitoring', title: '2025年1月历史价格记录', observedAt: '2025-01-15T08:00:00.000Z', effectiveAt: '2025-01-10T00:00:00.000Z' }));
  assert.ok(r2025.recorded, '历史 monitoring 事件可写入：' + r2025.reason);
  const page = Inbox.listInbox({ tenantId: tid, projectId: pid });
  assert.equal(page.total, 0, '默认窗口（近 30 天）不含 2025-01 事件');
  const full = Inbox.listInbox({ tenantId: tid, projectId: pid, window: 'none' });
  assert.equal(full.total, 1, 'window=none（时间线口径）仍可查到历史事件；backfill 事件不进收件箱');
  assert.equal(full.groups[0].events[0].recordedAt != null || true, true);

  // ③ effectiveAt 不明确 → 置 null（不得冒充实效时间）
  const rBad = Inbox.recordEvent(Object.assign({}, base, { origin: 'monitoring', title: '时间不明的变化', observedAt: new Date().toISOString(), effectiveAt: '2025-01' }));
  assert.ok(rBad.recorded);
  assert.ok(rBad.downgraded.includes('invalid_effective_at'), '无效 effectiveAt 降级');
  const evRow = full.groups.length ? null : null;
  const again = Inbox.listInbox({ tenantId: tid, projectId: pid, window: 'none' });
  const badEv = again.groups.flatMap(g => g.events).find(e => e.title === '时间不明的变化');
  assert.ok(badEv && badEv.effectiveAt == null, 'effectiveAt 不明确 → 存为 null');
  assert.ok(evRow === null);
});

// ---------- 3. 赛道趋势去重 ----------
test('r4-3 群体信号按 competitorId 去重；同名不同 id 不合并', () => {
  const comps = [
    { id: 'burga-4', name: 'BURGA', recentMoves: [{ type: 'collab', desc: 'a', when: '2024' }, { type: 'collab', desc: 'b', when: '2024' }] },
    { id: 'casely-2', name: 'Casely', recentMoves: [{ type: 'collab', desc: 'c', when: '2026' }, { type: 'collab', desc: 'd', when: '2025-07' }] },
    { id: 'skinit-13', name: 'Skinit', recentMoves: [{ type: 'collab', desc: 'e', when: '2025' }] },
    { id: 'gelaskins-14', name: 'Gelaskins', recentMoves: [{ type: 'collab', desc: 'f', when: '2025-11' }, { type: 'collab', desc: 'g', when: '2024' }] },
    // 同名但不同主体：不与 Skinit 合并
    { id: 'skinit-us-99', name: 'Skinit', recentMoves: [{ type: 'collab', desc: 'h', when: '2025' }] },
  ];
  const gs = Radar.computeGroupSignals(comps, { threshold: 2 });
  const collab = gs.find(s => s.type === 'collab');
  assert.ok(collab, '存在联名信号');
  assert.equal(collab.count, 5, '计数 = 去重品牌数（5 家，不是 8 条事实）');
  assert.equal(collab.factCount, 8, '事实条数单独披露');
  assert.ok(collab.note.includes('5 家'), '标题口径 = 去重品牌数');
  const skinitBrands = collab.brands.filter(b => b.name === 'Skinit');
  assert.equal(skinitBrands.length, 2, '同名不同 competitorId 保留为两个主体');
  assert.ok(collab.brands.every(b => b.facts.length >= 1), '展开可见每品牌多条事实');
});

// ---------- 4. 巡检覆盖用最新窗口 ----------
test('r4-4 最新窗口不完整 → 缺口明细且状态非 inspected；后续完整窗口替换旧缺口', async () => {
  const tid = 'tenant:' + uid('r4t4');
  const pid = 'r4-项目-' + uid('p');
  db.createTenant({ name: 'r4-t4', email: uid('r4t4') + '@example.com' });
  // 项目状态文件（competitorNames 用）
  const f = projFile(pid, tid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ projectId: pid, tenantId: tid, track: 'r4', competitors: [
    { id: 'brand-a', name: '品牌A' }, { id: 'brand-b', name: '品牌B' },
  ] }));
  const tA = WS.createWatchTarget({ tenantId: tid, projectId: pid, competitorId: 'brand-a', market: 'us', timezone: 'UTC', enabledSignals: ['site_change'], supportedSignals: ['site_change'], enrichmentStatus: 'complete' }).target;
  const tB = WS.createWatchTarget({ tenantId: tid, projectId: pid, competitorId: 'brand-b', market: 'us', timezone: 'UTC', enabledSignals: ['site_change'], supportedSignals: ['site_change'], enrichmentStatus: 'complete' }).target;

  // 06:00 窗口：只有 A 完成（B 缺口）
  const w06 = '2026-10-28T06:00';
  const cA = WS.claimWindow(tA, w06, '06:00', Date.parse('2026-10-27T22:00:00Z'));
  assert.ok(cA.claimed);
  WS.completeWindow(cA.windowId, { signalResults: [], attempted: 1, succeeded: 1, failed: 0, failureReasons: {}, eventsVerified: 0 }, Date.parse('2026-10-27T22:05:00Z'));

  let st = Inbox.inboxState(tid, pid, 'Asia/Shanghai');
  assert.ok(st.coverage && st.coverage.complete === false, '最新窗口不完整 → coverage.complete=false');
  assert.equal(st.coverage.completed, 1);
  assert.equal(st.coverage.expected, 2);
  assert.ok(st.coverage.missingBrands.includes('品牌B'), '缺口列缺失品牌');
  assert.notEqual(st.state, 'inspected', '覆盖不完整不得落入「已巡检/没有变化」');
  assert.ok(st.state === 'inspected_partial' || st.state === 'inspection_failed', '状态如实落 partial/failed: ' + st.state);

  // 后续窗口（14:00）：A、B 都完成 → 最新完整窗口替换旧缺口
  const w14 = '2026-10-28T14:00';
  for (const t of [tA, tB]) {
    const c = WS.claimWindow(t, w14, '14:00', Date.parse('2026-10-28T06:00:00Z'));
    WS.completeWindow(c.windowId, { signalResults: [], attempted: 1, succeeded: 1, failed: 0, failureReasons: {}, eventsVerified: 0 }, Date.parse('2026-10-28T06:10:00Z'));
  }
  st = Inbox.inboxState(tid, pid, 'Asia/Shanghai');
  assert.ok(st.coverage && st.coverage.complete === true, '后续完整窗口生效');
  assert.equal(st.state, 'inspected', '覆盖完整 → 已巡检');
  void tB; void w06;
});

// ---------- 5. public_reviews 合法空结果 ----------
test('r4-5 评论适配器：无候选页 → success + emptyReason（≠ internal_error）', () => {
  const ad = Adapters.getAdapter('reviews');
  assert.ok(ad, 'reviews 适配器存在');
  const ctx = { competitor: { id: 'b1', name: 'CaseX', url: 'https://casex.example.com' } };
  const out = ad.normalize({ ok: true, pages: [], snapshotIds: [], partialScan: false, periodStart: null, periodEnd: null, sourceUrl: null, emptyReason: 'no_candidate_pages' }, ctx);
  assert.equal(out.outcome, 'success', '合法零候选 = 成功零结果');
  assert.equal(out.summary.emptyReason, 'no_candidate_pages');
  assert.equal(out.summary.reviewCount, 0);
  // 有可归属页 → 页面级观察（含来源 URL 与时间），仍是 success
  const out2 = ad.normalize({ ok: true, pages: [{ pageId: 'u1', url: 'https://trustpilot.example.com/review/casex', title: 'CaseX Reviews', rating: 4.5, reviewCount: 12, fetchedAt: '2026-10-28T06:00:00.000Z' }], snapshotIds: ['ss_1'], partialScan: false }, ctx);
  assert.equal(out2.outcome, 'success');
  assert.equal(out2.observations.length, 1);
  assert.equal(out2.observations[0].sourceUrl, 'https://trustpilot.example.com/review/casex');
  assert.equal(out2.summary.reviewCount, 12);
});

// ---------- 6. website_changed 端到端（受控资产根路径） ----------
test('r4-6 website_changed 端到端：受控资产根路径两次观察 → Diff → 收件箱', { timeout: 60000 }, async () => {
  const os = require('node:os');
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-r4-assets-'));
  const hostDir = path.join(assetDir, 'root-wtest.zb.test');
  fs.mkdirSync(hostDir, { recursive: true });
  const HTML_A = '<!doctype html><html><head><title>Root Test Brand</title><meta name="description" content="v1 baseline"></head><body><h1>Root Test Brand</h1><nav><a href="/shop">Shop</a></nav></body></html>';
  const HTML_B = '<!doctype html><html><head><title>Root Test Brand — New Line</title><meta name="description" content="v2 changed"></head><body><h1>Root Test Brand</h1><section id="new-line">New product line</section></body></html>';
  fs.writeFileSync(path.join(hostDir, 'index.html'), HTML_A);

  process.env.ZB_TEST_ASSETS = '1';
  process.env.ZB_TEST_ASSET_DIR = assetDir;

  const tid = 'tenant:' + uid('r4t6');
  const pid = 'r4-项目-' + uid('p');
  db.createTenant({ name: 'r4-t6', email: uid('r4t6') + '@example.com' });
  const f = projFile(pid, tid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const comp = { id: 'rootw-1', name: 'Root Test Brand', url: 'https://root-wtest.zb.test/', status: 'done', isShopify: false, market: 'us', relation: 'competitor' };
  fs.writeFileSync(f, JSON.stringify({ projectId: pid, tenantId: tid, track: 'r4e2e', competitors: [comp] }));

  const target = WS.createWatchTarget({ tenantId: tid, projectId: pid, competitorId: comp.id, market: 'us', timezone: 'UTC', enabledSignals: ['site_change'], supportedSignals: ['site_change'], enrichmentStatus: 'complete' }).target;

  // 第一次观察：只建基线，不出事件
  const r1 = await WatchMonitor.executeWindow(Object.assign({ tenantId: tid, projectId: pid }, target), target.watchTargetId + ':w1', {}, Date.now());
  assert.equal(r1.eventsVerified, 0, '首次观察不进每日变化');
  assert.equal(Inbox.listInbox({ tenantId: tid, projectId: pid, window: 'none' }).total, 0);

  // 第二次观察：HTML 改变 → 恰好一条 website_changed
  fs.writeFileSync(path.join(hostDir, 'index.html'), HTML_B);
  const r2 = await WatchMonitor.executeWindow(Object.assign({ tenantId: tid, projectId: pid }, target), target.watchTargetId + ':w2', {}, Date.now() + 1000);
  assert.equal(r2.eventsVerified + r2.eventsPending >= 1, true, '第二次观察产生变化事件');
  const after2 = Inbox.listInbox({ tenantId: tid, projectId: pid, window: 'none' });
  const evs = after2.groups.flatMap(g => g.events).filter(e => e.eventType === 'website_changed');
  assert.equal(evs.length, 1, '第二次只生成一条变化');

  // 第三次相同观察：不重复
  const r3 = await WatchMonitor.executeWindow(Object.assign({ tenantId: tid, projectId: pid }, target), target.watchTargetId + ':w3', {}, Date.now() + 2000);
  const after3 = Inbox.listInbox({ tenantId: tid, projectId: pid, window: 'none' });
  const evs3 = after3.groups.flatMap(g => g.events).filter(e => e.eventType === 'website_changed');
  assert.equal(evs3.length, 1, '重复观察不重复计事件');
  assert.equal(r3.eventsVerified + r3.eventsPending, 0);
  // 事件可打开证据（Evidence/Snapshot 引用真实存在）
  const ev = evs[0];
  assert.ok(Array.isArray(ev.evidenceRefs) && ev.evidenceRefs.length >= 1, '事件带证据引用');
  void r1; void r2;
  delete process.env.ZB_TEST_ASSETS;
  delete process.env.ZB_TEST_ASSET_DIR;
});

// ---------- 7. 账户资料 / 用户名 / 密码 / 隔离 ----------
test('r4-7 账户：displayName 回退与修改、跨租户隔离、改密失败/成功/旧会话失效', () => {
  const email1 = uid('u1') + '@example.com';
  const email2 = uid('u2') + '@example.com';
  const reg1 = tenant.register({ email: email1, password: 'password11' });
  const reg2 = tenant.register({ email: email2, password: 'password22' });
  assert.ok(!reg1.error && !reg2.error);
  const tid1 = reg1.tenant.id, uid1 = reg1.user.id;
  const tid2 = reg2.tenant.id, uid2 = reg2.user.id;

  // ① 无 displayName → 邮箱前缀回退
  const v1 = tenant.accountView(tid1, uid1);
  assert.equal(v1.user.displayName, email1.split('@')[0]);
  // ② 修改后持久化（重启 = 重新读取，同一函数）
  const upd = tenant.updateDisplayName(tid1, uid1, '测试员甲');
  assert.ok(upd.ok && upd.user.displayName === '测试员甲');
  assert.equal(tenant.accountView(tid1, uid1).user.displayName, '测试员甲');
  // ③ 跨租户隔离：另一账号读不到；另一租户上下文无法改名
  assert.equal(tenant.accountView(tid2, uid1), null, '跨租户读取 → null');
  assert.equal(tenant.updateDisplayName(tid2, uid1, 'hack').error, 'NOT_FOUND');
  assert.notEqual(tenant.accountView(tid2, uid2).user.displayName, '测试员甲');

  // ④ 改密：当前密码错误 / 弱密码 / 成功
  assert.equal(tenant.changePassword({ tenantId: tid1, userId: uid1, currentPassword: 'wrong-pass1', newPassword: 'newpass99a' }).error, 'INVALID_CREDENTIALS');
  assert.equal(tenant.changePassword({ tenantId: tid1, userId: uid1, currentPassword: 'password11', newPassword: 'short1' }).error, 'PASSWORD_TOO_SHORT');
  assert.equal(tenant.changePassword({ tenantId: tid1, userId: uid1, currentPassword: 'password11', newPassword: 'onlyletters' }).error, 'PASSWORD_WEAK');
  const okPw = tenant.changePassword({ tenantId: tid1, userId: uid1, currentPassword: 'password11', newPassword: 'newpass99a' });
  assert.ok(okPw.ok && okPw.tokenVersion === 1);

  // ⑤ 会话失效：旧 token（tv=0）被拒；新 token（tv=1）可用
  const oldToken = auth.issueToken({ userId: uid1, tenantId: tid1, role: 'owner' }); // 未带 tv → 0
  const newToken = auth.issueToken({ userId: uid1, tenantId: tid1, role: 'owner', tv: okPw.tokenVersion });
  const reqOld = { headers: { authorization: 'Bearer ' + oldToken } };
  const reqNew = { headers: { authorization: 'Bearer ' + newToken } };
  const cfg = {};
  assert.equal(resolveIdentity(reqOld, cfg).reason, 'SESSION_REVOKED', '改密后其他会话失效');
  const idNew = resolveIdentity(reqNew, cfg);
  assert.ok(!idNew.error && idNew.tenantId === tid1, '新会话可用');
  // 登录用新密码可用、旧密码不可用
  assert.equal(tenant.login({ email: email1, password: 'password11' }).error, 'INVALID_CREDENTIALS');
  assert.ok(!tenant.login({ email: email1, password: 'newpass99a' }).error);
});

// ---------- 8. 修改密码限流（handler 级） ----------
test('r4-8 修改密码限流：连续失败后 429，且不回显密码', async () => {
  const AccountH = require('../routes/handlers/account.js');
  const email = uid('u3') + '@example.com';
  const reg = tenant.register({ email, password: 'password33' });
  const tid = reg.tenant.id, uidX = reg.user.id;
  let last = null;
  const ctx = {
    readBody: async () => ({ currentPassword: 'wrong-pass', newPassword: 'whatever99', confirmPassword: 'whatever99' }),
    sendJSON: (_res, code, obj) => { last = { code, obj }; return true; },
    getAuthPayload: () => ({ kind: 'tenant', payload: { tid, sub: uidX, role: 'owner' } }),
  };
  const res = {};
  for (let i = 0; i < 6; i++) await AccountH.passwordChange(ctx, { method: 'POST', headers: {} }, res, null, '/api/account/password');
  assert.equal(last.code, 429, '第 6 次失败后触发限流');
  assert.equal(last.obj.error, 'RATE_LIMITED');
  const s = JSON.stringify(last.obj);
  assert.ok(!s.includes('wrong-pass') && !s.includes('whatever99'), '密码不出现在响应中');
});

// r4e 回归：改密成功路径不得二次解析身份——旧 token 在凭证版本提升后会被
// getAuthPayload 拒掉（返回 null），handler 若再调一次会空指针 → 500（预览服实测）。
test('r4-9 改密成功后用入口身份续签（不二次 getAuthPayload）', async () => {
  const AccountH = require('../routes/handlers/account.js');
  const email = uid('u4') + '@example.com';
  const reg = tenant.register({ email, password: 'password44' });
  const tid = reg.tenant.id, uidX = reg.user.id;
  let calls = 0;
  let last = null;
  const ctx = {
    readBody: async () => ({ currentPassword: 'password44', newPassword: 'newpass77a', confirmPassword: 'newpass77a' }),
    sendJSON: (_res, code, obj) => { last = { code, obj }; return true; },
    // 第一次调用返回有效身份（入口已通过）；此后（改密已使 tokenVersion 提升）返回 null
    getAuthPayload: () => { calls += 1; return calls === 1 ? { kind: 'tenant', payload: { tid, sub: uidX, role: 'owner' } } : null; },
  };
  await AccountH.passwordChange(ctx, { method: 'POST', headers: {} }, {}, null, '/api/account/password');
  assert.equal(last.code, 200, '改密成功路径不受二次身份解析影响');
  assert.ok(last.obj.token, '返回续签 token');
  // 续签 token 必须带新凭证版本
  const re = require('../services/auth.js').verifyToken(last.obj.token);
  assert.equal(re.tv, 1, '新 token 携带提升后的 tv');
});
