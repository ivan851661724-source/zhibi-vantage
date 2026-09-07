'use strict';
// ============================================================
// 锚点库种子管线（CLI，不依赖 server.js）。
// 流程：对每个核心品类 → LLM 枚举候选品牌(Top30, 标 candidate/待核验)
//        + 若 config.crunchbase.apiKey 存在则查 Crunchbase(真实第三方源)
//        → 经 evidence chain + 裁决引擎 → 持久化到 data/anchor-library.json。
//
// 诚实纪律：LLM 枚举结果只作「候选·待核验」，绝不作为已验证 Top30 呈现；
//           仅当官网/第三方/用户贡献任一真实源佐证才升级为 adopted。
//           未配置 Crunchbase 时，锚点全部保持 candidate，符合"不伪造权威"。
//
// 用法：
//   node scripts/seed-anchors.js                 # 全量起始类目，持久化
//   node scripts/seed-anchors.js --limit 3      # 只跑前 3 个类目（演示/控成本）
//   node scripts/seed-anchors.js --dry           # 只打印不落盘
//   node scripts/seed-anchors.js --cat path.json # 用自定义类目清单
//   node scripts/seed-anchors.js --enrich        # 对现有锚点库富集真实第三方源(Wikidata免费+Serper已付费)
//   node scripts/seed-anchors.js --enrich --limit 15  # 只富集前 15 个锚点（控成本/加速）
//   node scripts/seed-anchors.js --enrich --filter 保健品  # 只富集某品类（按 anchorId 前缀匹配）
// ============================================================
const fs = require('fs');
const path = require('path');
const AL = require('../lib/anchors.js');
const { SOURCE_KIND } = AL;

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

function parseArgs(argv) {
  const a = { limit: 0, dry: false, cat: path.join(DATA, 'categories.json'), enrich: false, force: false, filter: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--limit') a.limit = parseInt(argv[++i], 10) || 0;
    else if (argv[i] === '--dry') a.dry = true;
    else if (argv[i] === '--cat') a.cat = argv[++i];
    else if (argv[i] === '--enrich') a.enrich = true;
    else if (argv[i] === '--force') a.force = true;
    else if (argv[i] === '--filter') a.filter = argv[++i];
  }
  return a;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8')); } catch (e) { return {}; }
}
function loadCategories(p) {
  try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(j) ? j : (j.categories || []); }
  catch (e) { console.error('类目清单读取失败: ' + p); process.exit(1); }
}

// 复用代码库的 LLM 调用约定（OpenAI 兼容 /chat/completions；接入点/模型/key 均可用环境变量覆盖）。
async function deepseekJSON(messages, key, model) {
  if (!key) throw new Error('缺少 config.llm.apiKey（或环境变量 LLM_API_KEY）');
  const base = String(process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '');
  const endpoint = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: model || process.env.LLM_MODEL || 'deepseek-v4-flash', messages, response_format: { type: 'json_object' }, temperature: 0.2 }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error('deepseek HTTP ' + r.status + ' ' + t.slice(0, 160)); }
  const j = await r.json();
  return JSON.parse(j.choices[0].message.content);
}

// LLM 枚举某品类的候选品牌。提示词要求"真实存在/广泛流传"，但仍标 candidate。
async function llmEnumerate(cat, key, model) {
  const sys = '你是消费品类品牌枚举器。给定消费品类，返回该品类下全球较知名、用户在电商平台常搜的品牌名单(最多30个)。只列真实存在或广泛流传的品牌名，不要编造无意义名称。严格输出JSON:{"brands":[{"name":"品牌名","note":"一句话说明(可选)"}]}。这些仅作候选，需后续核验。';
  const user = '品类：' + cat + '。返回 Top30 品牌。';
  const j = await deepseekJSON([{ role: 'system', content: sys }, { role: 'user', content: user }], key, model);
  return (j && Array.isArray(j.brands)) ? j.brands : [];
}

// 富集现有锚点库：对每个锚点追加 Wikidata(免费) + Serper(已付费) 真实第三方源证据，
// 经裁决引擎重建 → candidate 可升级为 claimed/verified（绝不伪造权威）。
async function runEnrich(args, cfg) {
  const lib = AL.createAnchorLibrary({ dataDir: DATA });
  if (!lib.load()) { console.error('无现成锚点库可富集（请先跑一次 --seed）'); process.exit(1); }
  const keys = Object.keys(lib.store.anchors);
  const filtered = args.filter ? keys.filter(k => k.startsWith(args.filter + '::')) : keys;
  const limited = args.limit > 0 ? filtered.slice(0, args.limit) : filtered;
  const spOn = !!(cfg.search && (cfg.search.apiKey || cfg.search.serperKey));
  console.log('=== 锚点富集（真实第三方源）===');
  console.log('锚点: ' + limited.length + ' / ' + filtered.length + (args.limit ? ' (--limit)' : '') + (args.filter ? ' (--filter ' + args.filter + ')' : '') + (args.dry ? '  [dry]' : ''));
  console.log('Wikidata: 免费启用 | Serper: ' + (spOn ? '已接活体(零边际成本)' : '未配置(跳过)'));
  let upgraded = 0, claimed = 0, verified = 0, wkHits = 0, spHits = 0, processed = 0;
  let aborted = false;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const checkpointPersist = () => { if (!args.dry) { try { lib.persist(true); } catch (e) { console.error('  [checkpoint] 持久化失败: ' + e.message); } } };
  try {
    for (const key of limited) {
      const a = lib.store.anchors[key];
      if (!a) continue;
      const category = a.anchorId.split('::')[0];
      const llmRec = a.chain.records.find((r) => r.sourceKind === SOURCE_KIND.LLM_ENUM) || a.chain.records[0];
      const name = llmRec ? llmRec.rawValue : (a.anchorId.split('::')[1] || '');
      // 已升级的锚点跳过，避免重复堆叠同一真实源证据（幂等）
      if (a.status !== 'candidate' && !args.force) {
        console.log('  ' + name + ': 已是 ' + a.status + ' (跳过)');
        continue;
      }
      let newRecs = [];
      const alreadyClaimed = a.status !== 'candidate';
      // 沙箱环境 Wikidata 被墙，每次失败出站请求会触发沙箱静默杀进程；生产(美区)跑时去掉该 env 即可恢复 Wikidata 交叉核验。
      if (!process.env.SKIP_WIKIDATA) {
        try { const wk = await AL.wikidataFetch({ category, name }); if (wk.length) { newRecs = newRecs.concat(wk); wkHits++; } }
        catch (e) { /* Wikidata 在受限网络下常被挡，单锚点失败不影响整体 */ }
      } else { wkHits = 'skipped'; }
      // --force 且已 claimed 时，只补 Wikidata(缺失的第二源)即可推动 verified，不再重复抓 Serper 以免堆叠同源自证。
      if (spOn && !(args.force && alreadyClaimed)) {
        try { const sp = await AL.serperFetch({ category, name, config: cfg }); if (sp.length) { newRecs = newRecs.concat(sp); spHits++; } }
        catch (e) { /* 单锚点 Serper 失败容错 */ }
      }
      if (newRecs.length) {
        const before = a.status;
        try {
          const up = lib.enrich(key, newRecs);
          const after = up ? up.upgradedTo : before;
          if (before === 'candidate' && after !== 'candidate') { upgraded++; if (after === 'verified') verified++; else claimed++; }
          console.log('  ' + name + ': ' + before + ' → ' + after + ' (+' + newRecs.length + ' 真实源)');
        } catch (e) { console.error('  enrich失败(' + name + '): ' + e.message); }
      } else {
        console.log('  ' + name + ': 无真实源命中(保持 ' + a.status + ')');
      }
      processed++;
      // 每 10 个锚点检查点落盘 + 微延时，避免受限网络下被中断丢进度
      if (processed % 10 === 0) { checkpointPersist(); console.log('  [检查点] 已落盘进度 (' + processed + '/' + limited.length + ')'); }
      if (!args.dry) await sleep(150);
    }
  } catch (e) {
    aborted = true;
    console.error('  [中断] 富集循环异常: ' + (e && e.message ? e.message : e));
  } finally {
    checkpointPersist();
  }
  console.log('\n--- 富集结果 ---');
  console.log('被真实源升级的锚点: ' + upgraded + ' (claimed ' + claimed + ', verified ' + verified + ')');
  console.log('Wikidata 命中: ' + wkHits + ' | Serper 命中: ' + spHits + ' | 已处理: ' + processed + (aborted ? ' (中断)' : ''));
  console.log(args.dry ? '(dry 模式：未持久化)' : ('已持久化 → ' + lib.path));
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.enrich) { await runEnrich(args, loadConfig()); return; }
  const cfg = loadConfig();
  const cats = loadCategories(args.cat);
  const limited = args.limit > 0 ? cats.slice(0, args.limit) : cats;

  if (!limited.length) { console.error('无类目可处理'); process.exit(1); }

  const lib = AL.createAnchorLibrary({ dataDir: DATA });
  let allRecords = [];
  let cbCount = 0;
  const cbOn = !!(cfg.crunchbase && cfg.crunchbase.apiKey);

  console.log('=== 锚点种子管线 ===');
  console.log('类目: ' + limited.length + ' / ' + cats.length + (args.limit ? ' (--limit)' : '') + (args.dry ? '  [dry]' : ''));
  console.log('Crunchbase: ' + (cbOn ? '已接活体' : '未配置(跳过，锚点保持 candidate)'));

  for (const cat of limited) {
    let brands = [];
    try { brands = await llmEnumerate(cat, (cfg.llm && cfg.llm.apiKey) || process.env.LLM_API_KEY, cfg.llm && cfg.llm.model); }
    catch (e) { console.error('  LLM枚举失败(' + cat + '): ' + e.message); }
    const recs = AL.llmEnumerationAdapter(brands.map((b) => ({ category: cat, name: b.name, note: b.note })), 'llm-enum');
    allRecords = allRecords.concat(recs);

    if (cbOn) {
      try { const cb = await AL.crunchbaseFetch(cfg.crunchbase, cat); allRecords = allRecords.concat(cb); cbCount += cb.length; }
      catch (e) { console.error('  Crunchbase失败(' + cat + '): ' + e.message); }
    }
    console.log('  品类[' + cat + ']: LLM候选 ' + recs.length + (cbOn ? (' + Crunchbase ' + cbCount) : ''));
  }

  const built = lib.ingest(allRecords);
  if (!args.dry) lib.persist(true);
  const rows = lib.evidenceRows();

  console.log('\n--- 种子结果 ---');
  console.log('候选锚点(链): ' + built.length);
  console.log('证据记录: ' + allRecords.length + ' (LLM枚举 ' + (allRecords.length - cbCount) + ', Crunchbase ' + cbCount + ')');
  console.log('证据编号对照行: ' + rows.length);
  console.log(args.dry ? '(dry 模式：未持久化)' : ('已持久化 → ' + lib.path));
}

main().catch((e) => { console.error('种子管线异常:', e && e.stack ? e.stack : e); process.exit(1); });
