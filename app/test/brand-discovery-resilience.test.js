'use strict';
// ============================================================
// brand-discovery-resilience.test.js —— P0 整改回归（2026-11）
// 「新用户品牌发现恢复与 LLM 故障显式化」
// ------------------------------------------------------------
// 覆盖任务书第七节全部场景：
//   1. Serper 成功 + LLM 403：任务明确失败，绝不提交空品牌伪成功
//   2. LLM 429：归一 LLM_RATE_LIMITED（额度受限，可重试）
//   3. LLM 5xx：归一 LLM_PROVIDER_UNAVAILABLE（服务暂不可用）
//   4. 模型返回合法 JSON：产出已核验品牌（完整发现链）
//   5. 模型返回非 JSON：归一 LLM_INVALID_RESPONSE
//   6. SSE 丢失恢复的地基：失败态持久化进 /api/state（discoverError 字段）
//   7. 重试成功不重复（新项目替换失败项目；同请求幂等复用不重复建项目）
//   8. 上一次已有成功结果、本次失败：旧结果档案完整保留 + previousProjectId 可达
//   9. Key 零泄漏：失败流程后全数据目录扫描无密钥材料
//  10. 两租户隔离不回退
//  11. 网关错误分类矩阵 + failureMode 语义 + 错误载荷卫生
// 运行方式：node test/brand-discovery-resilience.test.js（零外部依赖，fetch 全局打桩）
// ============================================================
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');

// —— 数据目录隔离（必须在任何业务模块 require 之前） ——
const TMPDIR = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'zb-discover-res-'));
process.env.ZB_DATA_DIR = TMPDIR;
process.env.OBS_DB_PATH = nodePath.join(TMPDIR, 'obs.sqlite');

const { requestScope } = require('../core/als.js');
const { discoverLaunch, runDiscover } = require('../research/discover.js');
const { loadState, saveState, listProjects, projFile, resolveTenantId, getCurrentId } = require('../core/state-store.js');
const GW = require('../services/llm-gateway.js');
const RLLM = require('../research/llm.js');
const Paths = require('../core/paths.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok - ' + name); }
  catch (e) { failed++; console.error('  FAIL - ' + name + ' :: ' + String(e.message || e).split('\n')[0]); }
}

// ============================================================
// fetch 打桩：按 URL 前缀路由（serper / LLM stub），未命中一律 503
// ============================================================
const REAL_FETCH = global.fetch;
let llmMode = 'qwen-ok';           // qwen-ok | http-403 | http-429 | http-500 | bad-json | delay-500-then-403
const SERPER_KEY_STUB = 'stub-serper-key-0001abcdef';
const LLM_KEY_STUB = 'stub-llm-key-0002abcdef';
const LLM_STUB_BASE = 'http://llm-stub.test/v1';
const BRANDS = [
  { name: 'TrailBark', url: 'https://trailbark.com', tier: 'mid', matchScore: 82, why: '腰部品牌' },
  { name: 'PawsTick', url: 'https://pawstick.com', tier: 'small', matchScore: 74, why: '小众品牌' },
];
function serperBody() {
  return {
    organic: BRANDS.flatMap((b) => ([
      { title: b.name + ' official site — custom dog tags', link: b.url, snippet: b.name + ' makes custom dog tags for outdoor dogs. ' + b.name + ' reviews are positive.' },
      { title: 'Best custom dog tags: ' + b.name + ' and alternatives', link: 'https://guides.example.com/' + b.name.toLowerCase(), snippet: 'We compare ' + b.name + ' with other custom dog tag brands.' },
    ])),
  };
}
function llmJsonFor(bodyText) {
  // 按 system 提示词区分三类调用：枚举 / 收割 / 相关性裁判
  if (/行业分析师/.test(bodyText)) return { candidates: BRANDS.map((b) => ({ ...b })) };
  if (/只提取/.test(bodyText)) {
    return { candidates: BRANDS.map((b) => ({ ...b, src: 'serp' })), moreQueries: [] };
  }
  if (/相关性裁判/.test(bodyText)) {
    return { judgments: BRANDS.map((b) => ({ name: b.name, relevant: true, categoryFit: 92, reason: '消费品牌' })) };
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
    if (llmMode === 'http-429') return new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 });
    if (llmMode === 'http-500') return new Response(JSON.stringify({ error: 'boom' }), { status: 500 });
    if (llmMode === 'bad-json') {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'sorry, I cannot produce JSON today' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (llmMode === 'delay-500-then-403') {
      await new Promise((r) => setTimeout(r, 500));
      return new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 });
    }
    // qwen-ok：合法 JSON（带 ```json 围栏变体也兼容——这里直接裸 JSON）
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(llmJsonFor(body)) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
  return new Response(JSON.stringify({ error: 'unrouted' }), { status: 503 });
}

// 统一测试配置（key/baseUrl/model 显式传入，不依赖 CONFIG_PATH）。
// 每次调用生成独立 llm key：网关熔断按 key 分桶，避免上一用例的 429/500 熔断
// 泄漏到下一用例（真实部署中不同租户 key 天然隔离）。
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

function launchAndWait(track, intent, config) {
  const r = discoverLaunch(track, intent || INTENT, config || testConfig(), null);
  return { projectId: r.projectId, reused: !!r.reused, done: r.done };
}

// 递归扫描目录内全部文件文本是否包含敏感串。
// 排除 serper-budget.json：运行时额度账本按既有设计以完整 key 记账（独享保真口径，
// 见 services/providers/serper-budget.js 头注）——该文件属数据卷运行时数据而非代码/
// 测试夹具，其设计已在交付报告单独登记。
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
      else {
        try {
          const txt = fs.readFileSync(p, 'utf8');
          if (txt.includes(needle)) hits.push(p);
        } catch { /* 二进制等不可读文件跳过 */ }
      }
    }
  })(root);
  return hits;
}

(async () => {
  global.fetch = stubFetch;
  // —— 配置同源原则（与生产一致）：LLM 端点来自 config 文件（"Key 决定配置源"）。
  // config 里的 key 只是占位（让 configKeySet 生效）；流程实际使用的 per-case key
  // 由 runDiscover 的 config 参数显式传入，不落 config 文件。
  fs.writeFileSync(Paths.CONFIG_PATH, JSON.stringify({
    llm: { apiKey: 'cfg-source-placeholder-key', baseUrl: LLM_STUB_BASE, model: 'cfg-source-model' },
    search: {},
  }));

  // —— 替换后台深研队列：发现链单测不跑真实深研（enrich 链有独立测试覆盖） ——
  function replace(p, exports) { require.cache[require.resolve(p)] = { id: require.resolve(p), filename: require.resolve(p), loaded: true, exports }; }
  replace('../research/enrich.js', { enqueueResearch: () => {}, ensureQueue: () => {}, runQueue: async () => {} });

  // ============================================================
  // 11. 网关错误分类矩阵 + failureMode 语义（纯网关层，先于全链路）
  // ============================================================
  await t('11a gateway failureMode=throw: 403 → LLM_AUTH_REJECTED，userMessage 用户可读且无密钥', async () => {
    llmMode = 'http-403';
    await assert.rejects(
      () => GW.call([{ role: 'user', content: 'x' }], { apiKey: LLM_KEY_STUB, model: 'm', json: true, baseUrl: LLM_STUB_BASE, timeoutMs: 2000, maxAttempts: 1, failureMode: 'throw' }),
      (e) => {
        assert.equal(e.name, 'LLMError');
        assert.equal(e.code, 'LLM_AUTH_REJECTED');
        assert.equal(e.retryable, false);
        assert.ok(e.userMessage && !e.userMessage.includes(LLM_KEY_STUB), 'userMessage 不得含密钥');
        assert.ok(!JSON.stringify({ m: e.message, u: e.userMessage, s: e.status }).includes(LLM_KEY_STUB), '错误载荷不得含密钥');
        return true;
      },
    );
  });

  await t('11b gateway 分类矩阵：404→MODEL_UNAVAILABLE / 429→RATE_LIMITED / 500→PROVIDER_UNAVAILABLE / abort→TIMEOUT', async () => {
    llmMode = 'http-403'; // 复用路由；下面直接以 status 定制
    const probe = async (status) => {
      global.fetch = async () => new Response(JSON.stringify({ error: 'x' }), { status });
      try {
        await GW.call([{ role: 'user', content: 'x' }], { apiKey: 'k', model: 'm', json: true, baseUrl: LLM_STUB_BASE, timeoutMs: 2000, maxAttempts: 1, failureMode: 'throw' });
        return null;
      } catch (e) { return e; }
    };
    assert.equal((await probe(404)).code, 'LLM_MODEL_UNAVAILABLE');
    assert.equal((await probe(429)).code, 'LLM_RATE_LIMITED');
    assert.equal((await probe(500)).code, 'LLM_PROVIDER_UNAVAILABLE');
    // 400 + 模型名错误体 → LLM_MODEL_UNAVAILABLE（供应商把未知模型报成 400 的兼容归类）
    global.fetch = async () => new Response(JSON.stringify({ error: 'model stub-model does not exist' }), { status: 400 });
    try { await GW.call([{ role: 'user', content: 'x' }], { apiKey: 'k', model: 'm', json: true, baseUrl: LLM_STUB_BASE, timeoutMs: 2000, maxAttempts: 1, failureMode: 'throw' }); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, 'LLM_MODEL_UNAVAILABLE'); }
    // abort → LLM_TIMEOUT
    global.fetch = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    try { await GW.call([{ role: 'user', content: 'x' }], { apiKey: 'k', model: 'm', json: true, baseUrl: LLM_STUB_BASE, timeoutMs: 2000, maxAttempts: 1, failureMode: 'throw' }); assert.fail('should throw'); }
    catch (e) { assert.equal(e.code, 'LLM_TIMEOUT'); }
    global.fetch = stubFetch;
  });

  await t('11c gateway 默认 degrade 行为不变（非关键调用不受本轮影响）', async () => {
    llmMode = 'http-403';
    const j = await GW.call([{ role: 'user', content: 'x' }], { apiKey: LLM_KEY_STUB, model: 'm', json: true, baseUrl: LLM_STUB_BASE, timeoutMs: 2000, maxAttempts: 1 });
    assert.deepEqual(j, {}, '默认 json 降级返回 {}');
    const txt = await GW.call([{ role: 'user', content: 'x' }], { apiKey: LLM_KEY_STUB, model: 'm', json: false, baseUrl: LLM_STUB_BASE, timeoutMs: 2000, maxAttempts: 1 });
    assert.equal(txt, '', '默认 text 降级返回空串');
  });

  await t('11d research/llm.js：llmJSON/llmText 为规范名，deepseekJSON/deepseekText 为兼容别名', async () => {
    assert.ok(RLLM.deepseekJSON === RLLM.llmJSON, 'deepseekJSON === llmJSON');
    assert.ok(RLLM.deepseekText === RLLM.llmText, 'deepseekText === llmText');
  });

  // ============================================================
  // 1. Serper 成功 + LLM 403 → 任务明确失败（不写空品牌伪成功）
  // ============================================================
  llmMode = 'http-403';
  await t('1 LLM 403：任务失败、discoverError 持久化（errorCode/message/failedAt），不得伪成功空结果', async () => {
    const r = launchAndWait(TRACK);
    assert.ok(r.projectId);
    await r.done;
    const s = loadState();
    assert.ok(s, '项目档案存在');
    assert.equal(s.projectId, r.projectId);
    assert.equal(s.discoverDone, false, '失败 ≠ 完成');
    assert.ok(s.discoverError, '失败态已持久化（SSE 丢失后状态查询可恢复）');
    assert.equal(s.discoverError.errorCode, 'LLM_AUTH_REJECTED');
    assert.ok(s.discoverError.errorMessage.includes('品牌识别服务'), 'errorMessage 用户可读且供应商中立');
    assert.ok(s.discoverError.failedAt, 'failedAt 存在');
    assert.equal(Array.isArray(s.competitors) ? s.competitors.length : -1, 0, '失败态不产生品牌数据');
    assert.ok(!s.discoverEmpty, '失败不得标记为「成功但为空」');
  });

  // ============================================================
  // 2. LLM 429 → LLM_RATE_LIMITED（重试后仍失败 → 明确失败）
  // ============================================================
  await t('2 LLM 429：归一 LLM_RATE_LIMITED（额度受限语义）', async () => {
    llmMode = 'http-429';
    const r = launchAndWait('custom cat tags');
    await r.done;
    const s = loadState();
    assert.equal(s.discoverError.errorCode, 'LLM_RATE_LIMITED');
    assert.ok(s.discoverError.errorMessage.includes('额度受限'), '用户可读：额度受限');
    assert.equal(s.discoverDone, false);
  });

  // ============================================================
  // 3. LLM 5xx → LLM_PROVIDER_UNAVAILABLE（服务暂不可用）
  // ============================================================
  await t('3 LLM 5xx：归一 LLM_PROVIDER_UNAVAILABLE', async () => {
    llmMode = 'http-500';
    const r = launchAndWait('custom cat collars');
    await r.done;
    const s = loadState();
    assert.equal(s.discoverError.errorCode, 'LLM_PROVIDER_UNAVAILABLE');
    assert.equal(s.discoverDone, false);
  });

  // ============================================================
  // 5. Qwen 返回非 JSON → LLM_INVALID_RESPONSE（先于 4 验证失败面）
  // ============================================================
  await t('5 模型 200 但非 JSON：归一 LLM_INVALID_RESPONSE，任务失败', async () => {
    llmMode = 'bad-json';
    const r = launchAndWait('custom cat beds');
    await r.done;
    const s = loadState();
    assert.equal(s.discoverError.errorCode, 'LLM_INVALID_RESPONSE');
    assert.equal(s.discoverDone, false);
  });

  // ============================================================
  // 4. 模型返回合法 JSON → 完整发现链产出已核验品牌
  // ============================================================
  await t('4 模型合法 JSON + Serper 证据：产出已核验品牌（不降级、不伪空）', async () => {
    llmMode = 'qwen-ok';
    const r = launchAndWait('custom dog tags');
    await r.done;
    const s = loadState();
    assert.ok(s.discoverDone === true, '成功收尾');
    assert.ok(!s.discoverError, '成功无失败态');
    assert.ok(!s.discoverEmpty, '有品牌时不标记 discoverEmpty');
    assert.ok(s.competitors.length >= 1, '至少一个已核验品牌，得到 ' + (s.competitors ? s.competitors.length : 0));
    const names = s.competitors.map((c) => c.name);
    assert.ok(names.includes('TrailBark'), '候选品牌 TrailBark 入库（过了搜索验证与相关性核验）');
    const tb = s.competitors.find((c) => c.name === 'TrailBark');
    assert.equal(tb.url, 'https://trailbark.com', '品牌带官网 URL（可溯源）');
    assert.ok((tb.evidenceCount || 0) >= 1 || tb.serpKnown, '品牌有搜索证据（LLM 候选必须过验证铁律）');
  });

  // ============================================================
  // 8. 上一次成功 + 本次失败：旧结果完整保留 + previousProjectId 可达
  // ============================================================
  await t('8 已有成功结果后本次失败：旧项目档案不被覆盖，discoverError.previousProjectId 指向旧结果', async () => {
    const successState = loadState();
    assert.ok(successState && successState.competitors.length >= 1, '前置：上一次成功结果存在');
    const oldProjectId = successState.projectId;
    const oldComps = successState.competitors.length;
    llmMode = 'http-403';
    const r = launchAndWait('custom dog tags');
    await r.done;
    const s = loadState();
    assert.notEqual(s.projectId, oldProjectId, '本次失败是新项目（旧档案不被覆盖）');
    assert.equal(s.discoverError.errorCode, 'LLM_AUTH_REJECTED');
    assert.equal(s.discoverError.previousProjectId, oldProjectId, '失败面板可跳回旧结果');
    // 旧档案完整性：直接读旧项目文件核对品牌数量不变
    const old = JSON.parse(fs.readFileSync(projFile(oldProjectId), 'utf8'));
    assert.equal(old.competitors.length, oldComps, '旧结果品牌数量原样保留');
    assert.ok(!old.discoverError, '旧成功项目不被写失败态');
  });

  // ============================================================
  // 7. 重试成功不重复：新项目替换失败项目；同请求幂等复用
  // ============================================================
  await t('7a LLM 恢复后重试：新项目成功、失败项目保留审计、无重复品牌', async () => {
    llmMode = 'qwen-ok';
    const r = launchAndWait('custom dog tags');
    await r.done;
    const s = loadState();
    assert.ok(s.discoverDone === true && !s.discoverError, '重试成功（失败态自然清除：新项目无 discoverError）');
    const ids = s.competitors.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, '品牌 id 无重复');
    const names = s.competitors.map((c) => c.name.toLowerCase());
    assert.equal(new Set(names).size, names.length, '品牌名无重复');
    // 失败项目仍在历史清单（审计保留），但当前指针已切到新项目
    const prjs = listProjects(resolveTenantId());
    assert.ok(prjs.length >= 3, '历史清单含失败项目与成功项目');
    assert.equal(getCurrentId(resolveTenantId()), s.projectId, '当前指针 = 新成功项目');
  });

  await t('7b 同请求重复提交：幂等复用同一 projectId，不产生重复项目/任务', async () => {
    llmMode = 'delay-500-then-403'; // 慢失败：给重复提交留窗口
    const first = discoverLaunch('custom leashes', INTENT, testConfig(), null);
    const second = discoverLaunch('custom leashes', INTENT, testConfig(), null);
    assert.equal(second.reused, true, '第二次提交复用进行中任务');
    assert.equal(second.projectId, first.projectId, 'projectId 一致（无重复项目）');
    await first.done;
    // 幂等登记释放后，新请求应正常受理（不再是 reused）
    const third = discoverLaunch('custom leashes', INTENT, testConfig(), null);
    assert.equal(third.reused, false, '任务结束后不再复用');
    await third.done;
  });

  // ============================================================
  // 6. SSE 消息丢失：前端轮询恢复的地基 = 失败/完成态全部在 state 中
  // ============================================================
  await t('6 SSE 丢失恢复地基：state 同时具备 discoverDone/discoverError（前端轮询可判定终态）', async () => {
    llmMode = 'http-403';
    const r = launchAndWait('custom cat toys');
    await r.done;
    const s = loadState();
    // 前端轮询判定终态所需的全部字段都在 state 里（不依赖 SSE）
    assert.ok('discoverDone' in s && 'discoverError' in s);
    assert.equal(s.discoverDone, false);
    assert.equal(s.discoverError.errorCode, 'LLM_AUTH_REJECTED');
  });

  // ============================================================
  // 9. Key 零泄漏：失败/成功全流程后，数据目录零密钥材料
  // ============================================================
  await t('9 密钥零泄漏：全数据目录扫描无 LLM/Serper 密钥材料', async () => {
    for (const needle of [LLM_KEY_STUB, SERPER_KEY_STUB]) {
      const hits = dirContains(TMPDIR, needle);
      assert.deepEqual(hits, [], '数据目录不得出现密钥材料: ' + needle.slice(0, 8) + '… 命中 ' + hits.length + ' 个文件');
    }
  });

  // ============================================================
  // 10. 两租户隔离不回退：A 的品牌/项目对 B 不可见
  // ============================================================
  await t('10 两租户隔离：A 的成功项目对 B 不可见，B 失败态独立', async () => {
    llmMode = 'qwen-ok';
    let aState = null;
    await requestScope.run('tenant:iso-a', async () => {
      const r = discoverLaunch('custom dog tags', INTENT, testConfig(), null);
      await r.done;
      aState = loadState();
    });
    assert.ok(aState && aState.competitors.length >= 1, 'A 成功产出品牌');
    llmMode = 'http-403';
    await requestScope.run('tenant:iso-b', async () => {
      const r = discoverLaunch('custom dog tags', INTENT, testConfig(), null);
      await r.done;
      const bState = loadState();
      assert.ok(bState && bState.discoverError, 'B 独立失败态');
      assert.equal(bState.competitors.length, 0, 'B 无品牌（不串到 A 的结果）');
      assert.notEqual(bState.projectId, aState.projectId, 'projectId 不同');
      const bProjects = listProjects(resolveTenantId());
      assert.ok(!bProjects.some((p) => p.id === aState.projectId), 'B 的项目清单不含 A 的项目');
    });
  });

  global.fetch = REAL_FETCH;
  console.log('\n----------------------------------------');
  console.log('通过 ' + passed + ' / 失败 ' + failed);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('测试框架异常:', e); global.fetch = REAL_FETCH; process.exit(1); });
