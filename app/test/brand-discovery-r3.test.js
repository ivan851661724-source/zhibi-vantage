'use strict';
// ============================================================
// brand-discovery-r3.test.js —— 「工作台载荷瘦身与状态快速恢复」回归（2026-11 r3）
// ------------------------------------------------------------
// 覆盖任务书第八节：
//   1. summary 不含 attempts / evidenceList / fieldSources
//   2. full 接口仍完整包含原字段（不删数据）
//   3. 先 summary 后 full → full 内容不被污染（只读投影，不原地裁剪）
//   4. summary/full 品牌集合、状态、错误分类、已核验数量一致
//   5. 状态接口租户与项目隔离（跨租户/不存在均 404，不泄漏存在性）
//   6. SSE 按 projectId + runId 过滤（源码级契约）
//   7. 项目切换后旧请求不能覆盖新页面（源码级：abort + 代数）
//   8. 持久失败横幅不依赖完整 state（源码级）
//   9. 运行中轮询、终态停止（源码级）
//  10. 品牌详情按需加载（competitor-detail 返回该品牌完整字段）
//  11. Evidence 抽屉仍可溯源（/api/evidence-detail 注册未变）
//  12. 摘要体积门槛（<150KB）与完整体积对照
// 运行：node test/brand-discovery-r3.test.js
// ============================================================
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const TMPDIR = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'zb-discover-r3-'));
process.env.ZB_DATA_DIR = TMPDIR;
process.env.OBS_DB_PATH = nodePath.join(TMPDIR, 'obs.sqlite');

const read = require('../routes/handlers/read.js');
const DiscoverStatus = require('../routes/handlers/discover-status.js');
const Summary = require('../services/state-summary.js');
const Routes = require('../routes/index.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + String(e.message || e).split('\n')[0]); }
}

// ---------- 造一个「真实体量」的项目：20 个品牌，每品牌带审计大字段 ----------
function makeBrand(i) {
  const attempts = [];
  for (let k = 0; k < 110; k++) {
    attempts.push({ field: 'price', at: '2026-10-0' + ((k % 9) + 1) + 'T00:00:00Z', ok: true, status: 200, url: 'https://b' + i + '.example/products.json', note: '采集尝试记录'.repeat(14) });
  }
  const fieldSources = {};
  for (let k = 0; k < 40; k++) fieldSources['f' + k] = [{ url: 'https://b' + i + '.example/p' + k, at: '2026-10-01T00:00:00Z', excerpt: '来源片段'.repeat(28) }];
  const evidenceList = [];
  for (let k = 0; k < 40; k++) evidenceList.push({ id: 'ev-' + i + '-' + k, insight: '已核验结论'.repeat(24), url: 'https://b' + i + '.example/e/' + k, snapshotId: 'snap-' + i + '-' + k });
  return {
    id: 'brand-' + i,
    name: 'Brand ' + i,
    url: 'https://b' + i + '.example',
    status: 'done',
    relationship: { code: 'direct', basis: 'profile', label: '直接竞争' },
    researchedAt: '2026-10-02T00:00:00Z',
    evidenceCount: evidenceList.length,
    recentActions: { competitorId: 'brand-' + i, hasAction: true, kind: 'verified', action: { type: '新品', label: '动作', desc: 'Brand ' + i + ' 上新一款产品', when: '2026-09', basis: 'verified' } },
    categoryCoverage: [{ category: 'A', subCategory: 'a1', count: 3 }, { category: 'A', subCategory: 'a2', count: 2 }],
    productCount: 40 + i,
    priceVerified: true,
    probeHealth: { failed: 0, total: 9, rate: 0 },
    attempts,
    fieldSources,
    evidenceList,
  };
}

function makeProject(id, tenantId) {
  return {
    projectId: id,
    tenantId,
    track: '宠物营养品',
    intent: { goals: [], regions: [], platforms: ['shopifyDTC'], profile: null },
    competitors: Array.from({ length: 20 }, (_, i) => makeBrand(i + 1)),
    materials: Array.from({ length: 8 }, (_, i) => ({ id: 'm' + i, type: 'price', title: '材料 ' + i, brand: 'Brand 1', at: '2026-10-0' + (i + 1) })),
    evidenceDist: { verified: 10, inferred: 4, unverified: 2, total: 16 },
    progress: { total: 20, done: 20 },
    discoverDone: true,
    discoverRun: { runId: 'run-1', attemptNo: 3, status: 'failed', startedAt: '2026-11-01T00:00:00Z' },
    discoverError: { errorCode: 'LLM_AUTH_REJECTED', errorMessage: '品牌识别服务鉴权失败（密钥无效或未获模型授权）', failedAt: '2026-11-01T00:00:05Z', keptPrevious: true, attemptNo: 3 },
    decisions: { m0: 'keep' },
    whiteSpace: { gaps: Array.from({ length: 30 }, (_, i) => ({ id: 'g' + i, text: '白空间'.repeat(6) })) },
    blueOcean: { tags: Array.from({ length: 30 }, (_, i) => ({ id: 'b' + i, text: '蓝海'.repeat(6) })) },
  };
}

const PROJECTS = { P_MAIN: makeProject('P_MAIN', 'tenant:a') };
const SNAPSHOT_BEFORE = JSON.stringify(PROJECTS.P_MAIN);
const HEAVY_BEFORE = JSON.stringify(PROJECTS.P_MAIN.competitors.map((c) => ({ a: c.attempts, f: c.fieldSources, e: c.evidenceList })));

function makeCtx(tenantId = 'tenant:a') {
  const out = { status: 0, body: null, headers: null };
  const ctx = {
    resolveTenantId: () => tenantId,
    loadState: () => (tenantId === 'tenant:a' ? PROJECTS.P_MAIN : null),
    // 与真实实现同语义：只在本租户命名空间内查，跨租户读不到
    readProject: (id, tid) => (tid === 'tenant:a' && PROJECTS[id]) ? PROJECTS[id] : null,
    computeWhiteSpace: () => PROJECTS.P_MAIN.whiteSpace,
    marketCurrency: () => 'USD',
    decorateState: (s) => {
      const d = require('../services/discover-state.js').describeDiscover(s);
      s.discoverPhase = d.phase;
      s.discoverState = d;
      return s;
    },
    resolveIdentity: () => ({ tenantId, userId: 'u1' }),
    correctionOverlay: { getCorrections: () => [] },
    sendJSON: (_res, code, body, headers) => { out.status = code; out.body = body; out.headers = headers || null; },
  };
  return { ctx, out };
}

async function callState(query, tenantId) {
  const { ctx, out } = makeCtx(tenantId);
  await read.state(ctx, { method: 'GET' }, {}, new URL('http://local/api/state' + query), '/api/state');
  return out;
}
async function callStatus(query, tenantId) {
  const { ctx, out } = makeCtx(tenantId);
  await DiscoverStatus.discoverStatus(ctx, { method: 'GET' }, {}, new URL('http://local/api/discover/status' + query), '/api/discover/status');
  return out;
}
async function callDetail(query, tenantId) {
  const { ctx, out } = makeCtx(tenantId);
  await read.competitorDetail(ctx, { method: 'GET' }, {}, new URL('http://local/api/competitor-detail' + query), '/api/competitor-detail');
  return out;
}

const FORBIDDEN = ['attempts', 'fieldSources', 'evidenceList'];

(async () => {
  console.log('r3 载荷瘦身与状态恢复');

  // ---------- 1. 摘要不含三个大字段 ----------
  await t('summary 不含 attempts / fieldSources / evidenceList', async () => {
    const full = await callState('?private_view=1&projectId=P_MAIN');
    assert.equal(full.status, 200);
    const plain = JSON.stringify(full.body);
    for (const k of FORBIDDEN) assert.ok(plain.includes('"' + k + '"'), '完整接口必须仍含 ' + k);

    const sum = await callState('?private_view=1&projectId=P_MAIN&scope=summary');
    assert.equal(sum.status, 200);
    const s = JSON.stringify(sum.body);
    for (const k of FORBIDDEN) assert.ok(!s.includes('"' + k + '"'), '摘要不得包含 ' + k);
    // 品牌级字段白名单
    const allowed = new Set(Summary.COMPETITOR_SUMMARY_KEYS);
    for (const c of sum.body.competitors) {
      for (const k of Object.keys(c)) assert.ok(allowed.has(k), '摘要出现未白名单字段: ' + k);
    }
  });

  // ---------- 2. full 保持完整 ----------
  await t('full 接口仍完整包含原字段（不删数据）', async () => {
    const full = await callState('?projectId=P_MAIN');
    const c = full.body.competitors[0];
    assert.equal(full.body.scope, undefined, '完整接口不标记 summary');
    assert.ok(Array.isArray(c.attempts) && c.attempts.length === 110);
    assert.ok(c.fieldSources && Object.keys(c.fieldSources).length === 40);
    assert.ok(Array.isArray(c.evidenceList) && c.evidenceList.length === 40);
    assert.ok(full.body.whiteSpace && full.body.whiteSpace.gaps.length === 30, '白空间等重聚合仍在完整接口');
  });

  // ---------- 3. 先 summary 后 full：不被污染 ----------
  await t('先 summary 后 full，full 与源数据均未被污染', async () => {
    await callState('?private_view=1&projectId=P_MAIN&scope=summary');
    await callState('?private_view=1&projectId=P_MAIN&scope=summary');
    const full = await callState('?private_view=1&projectId=P_MAIN');
    const c = full.body.competitors[0];
    assert.ok(c.attempts && c.attempts.length === 110, 'summary 之后 full 的 attempts 仍在');
    assert.ok(c.fieldSources && Object.keys(c.fieldSources).length === 40);
    // 只比对「重字段」：decorateState 给对象补派生字段属既有一读链路行为，不是裁剪；
    // 本条要证的是摘要绝不原地删除 attempts/fieldSources/evidenceList。
    const heavy = (p) => JSON.stringify(p.competitors.map((c) => ({ a: c.attempts, f: c.fieldSources, e: c.evidenceList })));
    assert.equal(heavy(PROJECTS.P_MAIN), HEAVY_BEFORE, '读摘要不得原地裁剪品牌审计字段');
  });

  // ---------- 4. 一致性 ----------
  await t('summary 与 full 品牌集合/状态/错误分类/已核验数量一致', async () => {
    const full = (await callState('?projectId=P_MAIN')).body;
    const sum = (await callState('?projectId=P_MAIN&scope=summary')).body;
    const c = Summary.summaryConsistency(full, sum);
    assert.equal(c.countEqual, true);
    assert.equal(c.idsEqual, true);
    assert.equal(c.statusEqual, true);
    assert.equal(c.phaseEqual, true);
    assert.equal(c.errorEqual, true);
    assert.equal(c.evidenceCountEqual, true);
    assert.equal(sum.competitors.length, 20);
    assert.equal(sum.competitors[0].competitorId, 'brand-1');
    assert.equal(sum.competitors[0].currentStatus, 'done');
    assert.equal(sum.competitors[0].latestVerifiedChange.summary, 'Brand 1 上新一款产品');
  });

  // ---------- 5. 体积门槛 ----------
  await t('summary < 150KB 且 full 明显更大（真实量级对照）', async () => {
    const fullBody = JSON.stringify((await callState('?projectId=P_MAIN')).body);
    const sumBody = JSON.stringify((await callState('?projectId=P_MAIN&scope=summary')).body);
    assert.ok(fullBody.length > 300 * 1024, '造的数据应达到真实量级，实际 ' + fullBody.length);
    assert.ok(sumBody.length < 150 * 1024, '摘要必须 <150KB，实际 ' + sumBody.length);
    // 摘要里不应出现单条证据/尝试的正文
    assert.ok(!sumBody.includes('采集尝试记录'));
    assert.ok(!sumBody.includes('已核验结论'));
  });

  // ---------- 6. 状态接口 ----------
  await t('状态接口返回最小字段且带 no-store', async () => {
    const r = await callStatus('?projectId=P_MAIN');
    assert.equal(r.status, 200);
    const b = r.body;
    for (const k of ['projectId', 'track', 'runId', 'attemptNo', 'running', 'discoverDone', 'discoverEmpty', 'discoverError', 'keptPrevious', 'competitorCount', 'updatedAt', 'phase']) {
      assert.ok(k in b, '状态接口缺字段 ' + k);
    }
    assert.equal(b.phase, 'failed');
    assert.equal(b.runId, 'run-1');
    assert.equal(b.attemptNo, 3);
    assert.equal(b.keptPrevious, true);
    assert.equal(b.competitorCount, 20);
    assert.equal(b.discoverError.errorCode, 'LLM_AUTH_REJECTED');
    // 不返回品牌正文
    const s = JSON.stringify(b);
    for (const k of FORBIDDEN) assert.ok(!s.includes(k));
    assert.ok(!s.includes('https://b1.example'), '状态接口不得带品牌 URL');
    assert.equal(r.headers && r.headers['Cache-Control'], 'no-store');
  });

  await t('状态接口体积 < 10KB', async () => {
    const b = (await callStatus('?projectId=P_MAIN')).body;
    const n = JSON.stringify(b).length;
    assert.ok(n < 10 * 1024, '状态接口应 <10KB，实际 ' + n);
  });

  await t('状态接口租户与项目隔离（跨租户/不存在都 404）', async () => {
    const cross = await callStatus('?projectId=P_MAIN', 'tenant:b');
    assert.equal(cross.status, 404, '跨租户必须 404');
    const missing = await callStatus('?projectId=NOPE');
    assert.equal(missing.status, 404);
    // 两者响应体一致：不泄漏「存在但不属于你」
    assert.equal(JSON.stringify(cross.body), JSON.stringify(missing.body));
  });

  await t('/api/state 指定他租户 projectId 也 404（不泄漏存在性）', async () => {
    const r = await callState('?projectId=P_MAIN&scope=summary', 'tenant:b');
    assert.equal(r.status, 404);
  });

  // ---------- 7. 详情按需 ----------
  await t('competitor-detail 返回该品牌完整字段（attempts/fieldSources/evidenceList）', async () => {
    const r = await callDetail('?projectId=P_MAIN&competitorId=brand-3');
    assert.equal(r.status, 200);
    const c = r.body.competitor;
    assert.equal(c.id, 'brand-3');
    assert.equal(c.attempts.length, 110);
    assert.equal(Object.keys(c.fieldSources).length, 40);
    assert.equal(c.evidenceList.length, 40);
    assert.equal(r.headers && r.headers['Cache-Control'], 'no-store');
  });

  await t('competitor-detail 越权与不存在都 404', async () => {
    assert.equal((await callDetail('?projectId=P_MAIN&competitorId=brand-3', 'tenant:b')).status, 404);
    assert.equal((await callDetail('?projectId=P_MAIN&competitorId=nope')).status, 404);
    assert.equal((await callDetail('?projectId=P_MAIN')).status, 400);
  });

  // ---------- 8. 路由注册 ----------
  await t('新端点已注册，旧端点未变（evidence-detail 仍可溯源）', async () => {
    const list = Routes.list();
    const find = (m, p) => list.find((r) => r.method === m && r.path === p);
    assert.ok(find('GET', '/api/discover/status'), '/api/discover/status 未注册');
    assert.ok(find('GET', '/api/competitor-detail'), '/api/competitor-detail 未注册');
    assert.ok(find('GET', '/api/state'), '/api/state 注册丢失');
    assert.ok(find('GET', '/api/evidence-detail'), '证据溯源端点不得删除');
  });

  // ---------- 9. 前端契约（源码级） ----------
  const webRoot = nodePath.join(__dirname, '..', '..', 'web', 'src');
  const readSrc = (rel) => fs.readFileSync(nodePath.join(webRoot, rel), 'utf8');

  await t('Provider 首屏读 scope=summary（不再拉 1.1MB 完整 state）', async () => {
    const src = readSrc('hooks/use-zhibi-state.tsx');
    assert.ok(/api\/state\?private_view=1&scope=summary/.test(src), 'Provider 必须以摘要模式读取');
    assert.ok(!/apiGet<ZhibiState>\('\/api\/state\?private_view=1'\)/.test(src), '不得残留完整态读取');
    assert.ok(/scope=summary/.test(readSrc('lib/wb.ts')), '决策水合也不得拉完整 state');
  });

  await t('工作台横幅不依赖完整 state（走轻量状态接口）', async () => {
    const src = readSrc('app/(panel)/page.tsx');
    assert.ok(/useDiscoverStatus\(/.test(src), '工作台必须使用轻量状态接口');
    assert.ok(/const view = dstatus/.test(src), '状态投影应以状态接口优先');
    assert.ok(/taskTrack = \(dstatus && dstatus\.track\)/.test(src), '重新识别按钮不应等 state');
  });

  await t('状态轮询：4 秒一次、终态停止、切项目作废旧请求', async () => {
    const src = readSrc('hooks/use-discover-status.ts');
    assert.ok(/POLL_MS = 4000/.test(src), '轮询间隔应为 4 秒');
    assert.ok(/terminal/.test(src) && /schedule\(POLL_MS\)/.test(src), '终态必须停止轮询');
    assert.ok(/abort\(\)/.test(src), '切项目/卸载必须 abort 旧请求');
    assert.ok(/genRef\.current/.test(src), '迟到响应必须按代数丢弃');
    assert.ok(/no-store|_t=/.test(readSrc('lib/core-api.ts')), '状态请求应绕过缓存');
  });

  await t('SSE 按 projectId + runId 双重过滤', async () => {
    const src = readSrc('hooks/use-discover.ts');
    assert.ok(/evtRun/.test(src) && /runIdRef\.current/.test(src), '事件必须校验 runId');
    const be = fs.readFileSync(nodePath.join(__dirname, '..', 'research', 'discover.js'), 'utf8');
    assert.ok(/runId: _runId/.test(be), '后端事件必须携带 runId');
    assert.ok(/runId \}\)/.test(be) || /runId\s*\}\)/.test(be), '失败事件同样携带 runId');
  });

  await t('重聚合页面按需自取完整 state（不拖累首屏）', async () => {
    for (const p of ['app/(panel)/sector/page.tsx', 'app/(panel)/assets/page.tsx', 'app/(panel)/opportunity/page.tsx']) {
      assert.ok(/useProjectFullState/.test(readSrc(p)), p + ' 应使用 useProjectFullState');
    }
  });

  await t('r2 行为保留：同项目重试 / 双击幂等 / 旧结果保留 / keptPrevious 文案', async () => {
    const page = readSrc('app/(panel)/page.tsx');
    assert.ok(/retryProjectId/.test(page), '重试仍携带 retryProjectId');
    assert.ok(/上一次成功结果仍可查看/.test(page), '旧结果保留文案不得丢失');
    const r2 = fs.readFileSync(nodePath.join(__dirname, 'brand-discovery-r2.test.js'), 'utf8');
    assert.ok(/keptPrevious/.test(r2), 'r2 回归测试仍在');
  });

  console.log('\n' + (failed === 0 ? 'PASS' : 'FAIL') + ' - ' + passed + ' passed, ' + failed + ' failed');
  process.exitCode = failed === 0 ? 0 : 1;
  fs.rmSync(TMPDIR, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exitCode = 1; try { fs.rmSync(TMPDIR, { recursive: true, force: true }); } catch {} });
