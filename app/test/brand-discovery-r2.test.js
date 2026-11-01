'use strict';
// ============================================================
// brand-discovery-r2.test.js —— 「品牌发现 r2 最小闭环整改」回归（2026-11）
// ------------------------------------------------------------
// 覆盖任务书第九节：
//   1. 相同失败项目重试复用 projectId（不再产生第二个用户可见项目）
//   2. 连续双击只创建一个 run（不重复 spawn / 不重复扣额 / 不重复品牌）
//   3. 查询条件变化才创建新项目（条件比较函数 + handler 判定口径）
//   4. 失败不覆盖上一次成功品牌（keptPrevious，旧品牌原样保留）
//   5. 成功后原子替换结果（旧品牌整体让位，不是并集）
//   6. 历史伪空项目不显示合法空市场文案（incomplete 口径）
//   7. 合法空市场必须带 discoverEmpty=true
//   8. Key/模型/地址变化后健康缓存失效
//   9. HTTP 200 非法 JSON → LLM_INVALID_RESPONSE
//  10. SSE 丢失后轮询恢复（终态全部落在 state，不依赖单条事件）
//  11. 两租户隔离不回退（跨租户读档/重试一律不可见）
//  12. 并发闸释放与额度语义不回退（重试不计每日额度）
//  13. Key 在数据目录零泄漏
// 运行：node test/brand-discovery-r2.test.js
// ============================================================
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

const TMPDIR = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'zb-discover-r2-'));
process.env.ZB_DATA_DIR = TMPDIR;
process.env.OBS_DB_PATH = nodePath.join(TMPDIR, 'obs.sqlite');

const { requestScope } = require('../core/als.js');
const { discoverLaunch } = require('../research/discover.js');
const { loadState, readProject, listProjects, projFile, resolveTenantId, saveState } = require('../core/state-store.js');
const DState = require('../services/discover-state.js');
const { decorateState } = require('../research/decorate.js');
const LLMHealth = require('../services/llm-health.js');
const Paths = require('../core/paths.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + String(e.message || e).split('\n')[0]); }
}

// ============================================================
// fetch 打桩（serper + LLM），品牌集可切换，用于验证「原子替换」
// ============================================================
const REAL_FETCH = global.fetch;
let llmMode = 'ok';            // ok | empty-market | http-403 | delay-403 | bad-json
let ACTIVE_BRANDS = [];
const SET_A = [
  { name: 'TrailBark', url: 'https://trailbark.com', tier: 'mid', matchScore: 82, why: '腰部品牌' },
  { name: 'PawsTick', url: 'https://pawstick.com', tier: 'small', matchScore: 74, why: '小众品牌' },
];
const SET_B = [
  { name: 'RidgeTag', url: 'https://ridgetag.com', tier: 'large', matchScore: 88, why: '头部品牌' },
  { name: 'CopperPaw', url: 'https://copperpaw.com', tier: 'mid', matchScore: 77, why: '腰部品牌' },
];
const SERPER_KEY_STUB = 'stub-serper-r2-key-abcdef012345';
const LLM_KEY_STUB = 'stub-llm-r2-key-abcdef012345';
const LLM_STUB_BASE = 'http://llm-stub-r2.test/v1';

function serperBody() {
  if (llmMode === 'empty-market') return { organic: [] };
  return {
    organic: ACTIVE_BRANDS.flatMap((b) => ([
      { title: b.name + ' official site — custom dog tags', link: b.url, snippet: b.name + ' makes custom dog tags for outdoor dogs. ' + b.name + ' reviews are positive.' },
      { title: 'Best custom dog tags: ' + b.name + ' and alternatives', link: 'https://guides.example.com/' + b.name.toLowerCase(), snippet: 'We compare ' + b.name + ' with other custom dog tag brands.' },
    ])),
  };
}
function llmJsonFor(bodyText) {
  if (/健康探测|health probe/i.test(bodyText)) return { ok: true };
  if (llmMode === 'empty-market') return { candidates: [], moreQueries: [] };
  if (/行业分析师/.test(bodyText)) return { candidates: ACTIVE_BRANDS.map((b) => ({ ...b })) };
  if (/只提取/.test(bodyText)) return { candidates: ACTIVE_BRANDS.map((b) => ({ ...b })), moreQueries: [] };
  if (/相关性裁判/.test(bodyText)) {
    return { judgments: ACTIVE_BRANDS.map((b) => ({ name: b.name, relevant: true, categoryFit: 92, reason: '消费品牌' })) };
  }
  return {};
}
async function stubFetch(url, opts) {
  const u = String(url);
  if (u.startsWith('https://google.serper.dev')) {
    return new Response(JSON.stringify(serperBody()), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  if (u.startsWith(LLM_STUB_BASE)) {
    const body = (opts && opts.body) || '';
    if (llmMode === 'http-403') return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    if (llmMode === 'delay-403') {
      await new Promise((r) => setTimeout(r, 400));
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    }
    if (llmMode === 'bad-json') {
      return new Response('<html>gateway error</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(llmJsonFor(body)) } }],
      usage: { prompt_tokens: 8, completion_tokens: 8 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'unrouted' }), { status: 503 });
}

let _keySeq = 0;
function testConfig() {
  _keySeq++;
  return {
    search: { provider: 'serper', serperKeys: [SERPER_KEY_STUB], serperKey: SERPER_KEY_STUB, serperBudget: { total: 1000 } },
    llm: { apiKey: LLM_KEY_STUB + '-' + _keySeq, baseUrl: LLM_STUB_BASE, model: 'stub-model', modelDeep: 'stub-model-deep' },
    ownBrands: [],
  };
}
const INTENT = { goals: ['pricing'], regions: ['us'], platforms: ['amazon'] };
const TRACK = 'custom dog tags';

function makeGate() {
  const g = { enters: 0, leaves: 0 };
  g.enter = () => { g.enters++; return true; };
  g.leave = () => { g.leaves++; };
  return g;
}
function launch(track, intent, opts) {
  return discoverLaunch(track || TRACK, intent || INTENT, testConfig(), makeGate(), opts);
}

function dirContains(root, needle) {
  const hits = [];
  (function walk(d) {
    let files = [];
    try { files = fs.readdirSync(d); } catch { return; }
    for (const f of files) {
      if (f === 'serper-budget.json') continue;
      const p = nodePath.join(d, f);
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else { try { if (fs.readFileSync(p, 'utf8').includes(needle)) hits.push(p); } catch { /* 跳过二进制 */ } }
    }
  })(root);
  return hits;
}

(async () => {
  global.fetch = stubFetch;
  const replace = (p, exports) => { require.cache[require.resolve(p)] = { id: require.resolve(p), filename: require.resolve(p), loaded: true, exports }; };
  replace('../research/enrich.js', { enqueueResearch: () => {}, ensureQueue: () => {}, runQueue: async () => {} });

  fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: 'cfg-placeholder', baseUrl: LLM_STUB_BASE, model: 'cfg-model' }, search: {} }));

  // ============================================================
  // 1 + 4：失败项目重试复用 projectId；失败不覆盖旧成功品牌
  // ============================================================
  await t('1 首次失败 → 同项目重试成功：projectId 复用，项目清单不新增第二个', async () => {
    llmMode = 'http-403';
    ACTIVE_BRANDS = SET_A;
    await requestScope.run('tenant:r2-retry', async () => {
      const first = launch();
      await first.done;
      const s1 = loadState();
      assert.equal(s1.projectId, first.projectId, '首次失败项目落档');
      assert.equal(s1.competitors.length, 0);
      const before = listProjects(resolveTenantId()).length;

      llmMode = 'ok';
      const second = launch(TRACK, INTENT, { reuseProjectId: first.projectId });
      await second.done;
      assert.equal(second.reuse, true, '标记为重试（复用原项目）');
      assert.equal(second.projectId, first.projectId, '重试复用原 projectId（不产生第二个项目）');
      assert.equal(second.attemptNo, 2, 'attemptNo 递增（内部运行序号，不新增用户可见项目）');
      const s2 = loadState();
      assert.equal(s2.projectId, first.projectId);
      assert.ok(s2.competitors.length >= 1, '重试成功产出品牌');
      assert.ok(!s2.discoverError, '成功态清除失败标记');
      const after = listProjects(resolveTenantId()).length;
      assert.equal(after, before, '项目数量不变（重试不污染项目列表）');
      assert.ok(Array.isArray(s2.discoverRunHistory) === false || s2.discoverRunHistory.length <= 10, '运行历史有上限');
    });
  });

  await t('4 已有成功品牌后重试失败：旧品牌原样保留，keptPrevious=true，绝不覆盖为空', async () => {
    ACTIVE_BRANDS = SET_A;
    await requestScope.run('tenant:r2-keep', async () => {
      llmMode = 'ok';
      const ok1 = launch();
      await ok1.done;
      const s1 = loadState();
      assert.ok(s1.competitors.length >= 2, '前置：成功结果含品牌');
      const names1 = s1.competitors.map((c) => c.name).sort();

      llmMode = 'http-403';
      const bad = launch(TRACK, INTENT, { reuseProjectId: s1.projectId });
      await bad.done;
      const s2 = loadState();
      assert.equal(s2.projectId, s1.projectId, '同一项目（第 2 次运行）');
      assert.deepEqual(s2.competitors.map((c) => c.name).sort(), names1, '旧品牌一个不少');
      assert.equal(s2.discoverError.errorCode, 'LLM_AUTH_REJECTED');
      assert.equal(s2.discoverError.keptPrevious, true, '标记「上一次成功结果仍可查看」');
      assert.equal(s2.discoverError.previousProjectId, null, '同项目保留，无需跳转旧项目');
      assert.equal(s2.discoverDone, true, '旧结果仍是完整成功结果（不被失败污染成未完成）');
      const phase = DState.discoverPhase(s2);
      assert.equal(phase, 'failed', '状态口径为 failed（页面据 keptPrevious 提示旧结果仍可查看）');
    });
  });

  // ============================================================
  // 5：成功后原子替换（不是并集）
  // ============================================================
  await t('5 重试成功：品牌列表整体原子替换（旧品牌让位，不是并集合并）', async () => {
    await requestScope.run('tenant:r2-atomic', async () => {
      ACTIVE_BRANDS = SET_A;
      llmMode = 'ok';
      const r1 = launch();
      await r1.done;
      const s1 = loadState();
      const oldNames = s1.competitors.map((c) => c.name);
      assert.ok(oldNames.includes('TrailBark'), '前置：首轮为 SET_A');

      ACTIVE_BRANDS = SET_B;
      const r2 = launch(TRACK, INTENT, { reuseProjectId: s1.projectId });
      await r2.done;
      const s2 = loadState();
      assert.equal(s2.projectId, s1.projectId);
      const names = s2.competitors.map((c) => c.name);
      assert.ok(names.includes('RidgeTag'), '新结果已入库');
      assert.ok(!names.includes('TrailBark'), '旧品牌已被替换（不是并集残留）: ' + names.join(','));
      assert.ok(s2.discoverReplace && s2.discoverReplace.brandsAfter === names.length, '记录替换前后品牌数（审计）');
      assert.ok(!s2.discoverEmpty, '有品牌时不得带空市场标记');
    });
  });

  // ============================================================
  // 2：双击只创建一个 run + 12：并发闸只释放一次
  // ============================================================
  await t('2 连续双击重试：只创建一个 run（同一 projectId+runId，第二次幂等复用）', async () => {
    await requestScope.run('tenant:r2-dblclick', async () => {
      ACTIVE_BRANDS = SET_A;
      llmMode = 'http-403';
      const seed = launch();
      await seed.done;
      const pid = loadState().projectId;

      llmMode = 'delay-403';
      const gate = makeGate();
      const a = discoverLaunch(TRACK, INTENT, testConfig(), gate, { reuseProjectId: pid });
      const b = discoverLaunch(TRACK, INTENT, testConfig(), gate, { reuseProjectId: pid });
      assert.equal(b.reused, true, '第二次命中进行中的运行');
      assert.equal(b.projectId, pid);
      await a.done;
      const s = loadState();
      assert.equal(s.projectId, pid);
      assert.equal(s.discoverRun.attemptNo, 2, '只推进了一次运行（不是两次）');
      assert.equal(gate.leaves, 1, '并发闸只释放一次（第二次复用不占闸）');
    });
  });

  // ============================================================
  // 3：查询条件变化 → 必须新建项目
  // ============================================================
  await t('3 查询条件比较：只在赛道/地区/诉求/平台/画像变化时允许新建项目', async () => {
    const prev = { track: 'custom dog tags', intent: { goals: ['pricing'], regions: ['us'], platforms: ['amazon'], profile: { price: 'mid' } } };
    assert.equal(DState.sameDiscoveryConditions(prev, 'custom dog tags', { goals: ['pricing'], regions: ['us'], platforms: ['amazon'], profile: { price: 'mid' } }), true, '同条件 → 复用');
    assert.equal(DState.sameDiscoveryConditions(prev, 'custom cat tags', { goals: ['pricing'], regions: ['us'], platforms: ['amazon'], profile: { price: 'mid' } }), false, '赛道变 → 新建');
    assert.equal(DState.sameDiscoveryConditions(prev, 'custom dog tags', { goals: ['pricing'], regions: ['uk'], platforms: ['amazon'], profile: { price: 'mid' } }), false, '地区变 → 新建');
    assert.equal(DState.sameDiscoveryConditions(prev, 'custom dog tags', { goals: ['launch'], regions: ['us'], platforms: ['amazon'], profile: { price: 'mid' } }), false, '核心诉求变 → 新建');
    assert.equal(DState.sameDiscoveryConditions(prev, 'custom dog tags', { goals: ['pricing'], regions: ['us'], platforms: ['amazon'], profile: { price: 'high' } }), false, '定位画像变 → 新建');
    assert.equal(DState.sameDiscoveryConditions(null, 'x', {}), false, '无旧档案 → 新建');
  });

  // ============================================================
  // 6：历史伪空记录不得显示成「合法空市场」
  // ============================================================
  await t('6 历史伪空（discoverDone=true + 0 品牌 + 无 discoverEmpty）→ incomplete，不说「没有品牌」', async () => {
    await requestScope.run('tenant:r2-legacy', async () => {
      const pid = 'legacy-pseudo-empty-1';
      const legacy = {
        projectId: pid, track: 'custom dog tags', tenantId: 'tenant:r2-legacy',
        intent: { regions: ['us'], platforms: [] },
        competitors: [], discoverDone: true, discoveredAt: new Date().toISOString(),
      };
      const file = projFile(pid, 'tenant:r2-legacy');
      fs.mkdirSync(nodePath.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(legacy));
      const d = DState.describeDiscover(legacy);
      assert.equal(d.phase, 'incomplete');
      assert.equal(d.incomplete, true);
      assert.ok(d.message.includes('未完整完成'), '文案为「上次识别未完整完成」: ' + d.message);
      assert.ok(!/没有品牌|没有找到/.test(d.message), '不得出现「没有品牌」式结论');
      const decorated = decorateState(JSON.parse(JSON.stringify(legacy)));
      assert.equal(decorated.discoverPhase, 'incomplete', 'decorateState 投影同一口径');
      // 清单层同样标注（历史页不得显示「0 个品牌」）
      const item = listProjects('tenant:r2-legacy').find((p) => p.id === pid);
      assert.ok(item, '清单包含该档案');
      assert.equal(item.incomplete, true);
      // 兼容旧数据：不删除、不改写磁盘内容
      const onDisk = JSON.parse(fs.readFileSync(projFile(pid, 'tenant:r2-legacy'), 'utf8'));
      assert.equal(onDisk.discoverDone, true, '不做破坏性改写');
      assert.equal(onDisk.competitors.length, 0);
    });
  });

  // ============================================================
  // 7：合法空市场必须显式带 discoverEmpty
  // ============================================================
  await t('7 完整流程成功但没有已核验品牌：discoverEmpty=true（与失败/未完成区分）', async () => {
    await requestScope.run('tenant:r2-empty', async () => {
      llmMode = 'empty-market';
      const r = launch('custom yak wool blankets');
      await r.done;
      const s = loadState();
      assert.equal(s.discoverDone, true);
      assert.equal(s.competitors.length, 0);
      assert.equal(s.discoverEmpty, true, '合法空市场必须显式标记');
      assert.equal(DState.discoverPhase(s), 'empty');
      assert.ok(!s.discoverError, '空市场不是错误');
      llmMode = 'ok';
    });
  });

  // ============================================================
  // 8 / 9：健康检查缓存失效与结构校验
  // ============================================================
  await t('8 配置指纹：Key/Model 变化后旧健康缓存立即失效，不冒充当前配置状态', async () => {
    ACTIVE_BRANDS = SET_A;
    llmMode = 'ok';
    fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: 'health-key-A', baseUrl: LLM_STUB_BASE, model: 'model-A' }, search: {} }));
    LLMHealth._resetCache();
    const h1 = await LLMHealth.getStatus({ probe: true });
    assert.equal(h1.readiness, 'operational', '真实探测通过 → operational（HTTP 成功 + 结构合规）');
    // 同配置：命中缓存，不重复外呼
    const h1b = await LLMHealth.getStatus({ probe: false });
    assert.equal(h1b.readiness, 'operational');
    assert.equal(h1b.checkedAt, h1.checkedAt, '缓存期内返回同一快照');
    // Key 变化 → 旧缓存不得继续命中
    fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: 'health-key-B', baseUrl: LLM_STUB_BASE, model: 'model-A' }, search: {} }));
    const h2 = await LLMHealth.getStatus({ probe: false });
    assert.notEqual(h2.checkedAt, h1.checkedAt, '配置变化后不得返回旧快照');
    assert.equal(h2.readiness, 'configured', '未重探前给保守态，而不是沿用旧 operational');
    // Model 变化同样失效
    fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: 'health-key-B', baseUrl: LLM_STUB_BASE, model: 'model-B' }, search: {} }));
    const h3 = await LLMHealth.getStatus({ probe: true });
    assert.equal(h3.model, 'model-B', '探测使用当前生效模型');
    assert.equal(h3.readiness, 'operational');
  });

  await t('9 健康探测：HTTP 200 但返回非 JSON → LLM_INVALID_RESPONSE（不得判 operational）', async () => {
    llmMode = 'bad-json';
    fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: 'health-key-C', baseUrl: LLM_STUB_BASE, model: 'model-C' }, search: {} }));
    LLMHealth._resetCache();
    const h = await LLMHealth.getStatus({ probe: true });
    assert.equal(h.readiness, 'unavailable');
    assert.equal(h.errorClass, 'LLM_INVALID_RESPONSE');
    llmMode = 'ok';
  });

  await t('9b 健康探测：200 + 合法 JSON 但结构不符（ok 非 true）→ LLM_INVALID_RESPONSE', async () => {
    const prev = llmJsonFor;
    // 临时改写健康探测返回 {"ok": false}
    const origMode = llmMode;
    global.fetch = async (url, opts) => {
      const u = String(url);
      if (u.startsWith(LLM_STUB_BASE)) {
        return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":false}' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return stubFetch(url, opts);
    };
    fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({ llm: { apiKey: 'health-key-D', baseUrl: LLM_STUB_BASE, model: 'model-D' }, search: {} }));
    LLMHealth._resetCache();
    const h = await LLMHealth.getStatus({ probe: true });
    assert.equal(h.readiness, 'unavailable', '结构不符不得算 operational');
    assert.equal(h.errorClass, 'LLM_INVALID_RESPONSE');
    global.fetch = stubFetch;
    llmMode = origMode;
    void prev;
  });

  // ============================================================
  // 10：SSE 丢失后轮询恢复（终态全在 state）
  // ============================================================
  await t('10 SSE 丢失：失败态与成功态均可仅凭 /api/state 字段恢复（不依赖单条事件）', async () => {
    await requestScope.run('tenant:r2-sse', async () => {
      ACTIVE_BRANDS = SET_A;
      llmMode = 'http-403';
      const r = launch();
      await r.done;
      const raw = JSON.parse(fs.readFileSync(projFile(r.projectId, 'tenant:r2-sse'), 'utf8'));
      assert.equal(raw.discoverDone, false);
      assert.ok(raw.discoverError && raw.discoverError.errorCode, '失败终态持久化');
      assert.equal(raw.discovering, false, '进行中标记已清除（否则前端会一直「正在调研」）');
      assert.equal(raw.discoverRun.status, 'failed');
      llmMode = 'ok';
      const r2 = launch(TRACK, INTENT, { reuseProjectId: r.projectId });
      await r2.done;
      const raw2 = JSON.parse(fs.readFileSync(projFile(r.projectId, 'tenant:r2-sse'), 'utf8'));
      assert.equal(raw2.discoverDone, true);
      assert.equal(raw2.discovering, false);
      assert.equal(raw2.discoverRun.status, 'success');
      assert.ok(!raw2.discoverError);
    });
  });

  // ============================================================
  // 11：两租户隔离不回退
  // ============================================================
  await t('11 跨租户：B 读不到 A 的项目档案（重试键无法越权命中）', async () => {
    await requestScope.run('tenant:r2-iso-a', async () => {
      ACTIVE_BRANDS = SET_A;
      llmMode = 'ok';
      const r = launch();
      await r.done;
      const aState = loadState();
      assert.ok(aState.competitors.length >= 1);
      await requestScope.run('tenant:r2-iso-b', async () => {
        const peek = readProject(aState.projectId, 'tenant:r2-iso-b');
        assert.equal(peek, null, 'B 读不到 A 的项目（重试键无法越权）');
        const bList = listProjects('tenant:r2-iso-b');
        assert.ok(!bList.some((p) => p.id === aState.projectId), 'B 清单不含 A 项目');
      });
    });
  });

  // ============================================================
  // 12：额度语义与并发闸不回退
  // ============================================================
  await t('12 额度语义：重试不计每日额度（新建才计）；运行结束并发闸只释放一次', async () => {
    const collectSrc = fs.readFileSync(nodePath.join(__dirname, '../routes/handlers/collect.js'), 'utf8');
    assert.ok(/if \(!launched\.reuse\) metering\.recordDailyDiscover/.test(collectSrc), '每日额度只在新建项目时占用');
    assert.ok(/if \(launched\.reused\) \{[\s\S]{0,200}discoverGate\.leave\(\)/.test(collectSrc), '幂等复用路径释放本次占用的闸');
    await requestScope.run('tenant:r2-gate', async () => {
      ACTIVE_BRANDS = SET_A;
      llmMode = 'ok';
      const gate = makeGate();
      const r = discoverLaunch(TRACK, INTENT, testConfig(), gate, undefined);
      await r.done;
      assert.equal(gate.leaves, 1, '一次运行只释放一次');
    });
  });

  // ============================================================
  // 13：密钥零泄漏
  // ============================================================
  await t('13 密钥零泄漏：全数据目录扫描无 LLM/Serper 密钥材料', async () => {
    for (const needle of [LLM_KEY_STUB, SERPER_KEY_STUB]) {
      const hits = dirContains(TMPDIR, needle);
      assert.deepEqual(hits, [], '数据目录不得出现密钥材料：' + needle.slice(0, 8) + '… 命中 ' + hits.length);
    }
  });

  global.fetch = REAL_FETCH;
  console.log('\n----------------------------------------');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试框架异常:', e); global.fetch = REAL_FETCH; process.exit(1); });
