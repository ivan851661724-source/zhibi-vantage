'use strict';
// ============================================================
// 度量与持久化层（评审 P0-2 / P0-3 / P0-4 地基）
// ------------------------------------------------------------
// 本模块把「派生值不落盘、历史事实必须落盘」的纪律落到代码：
//   - 派生值（当前某 gap 是否可信）由 computeWhiteSpace 实时重算，不在此落盘；
//   - 历史事件（gap 快照 / 变更日志 / 消费埋点 / 校准判定 / 抽检准确率）本质是事实，必须落盘，
//     否则 PRD 的三件事物理上不可测：校准率(P0-3)、时间序列记忆(P0-4/§7.4)、北极星(P0-2/§11)。
//
// 三张表（全局，跨档案，因为护城河养分是产品级而非单赛道）：
//   gap_snapshots      稳定 gid + snapshotAt + gap 全量 + confidenceNum
//   events             ts / competitorId / changeType / from / to / source / confidence
//   insight_consumption ts / userId / itemType / itemId / action / dwellMs
// 另两张支撑表：calibration（校准确认）、accuracy_samples + accuracy_summary（字段准确率）。
// 原子写（tmp+rename）已实现于 lib/fs-util.js，此处 writeArr 复用 atomicWrite（P0-8 已完成）。
//
// 测试接缝：setDataDir(dir) 仅供单测把写入重定向到临时目录；生产默认指向项目 /data。
// ============================================================
const fs = require('fs');
const path = require('path');
const { atomicWrite } = require('./fs-util.js');

let _dataDir = path.join(__dirname, '..', 'data'); // lib/.. = 项目根 /data
function setDataDir(d) { if (d) _dataDir = d; }
const gapSnapFile = () => path.join(_dataDir, 'gap_snapshots.json');
const eventsFile = () => path.join(_dataDir, 'events.json');
const consumeFile = () => path.join(_dataDir, 'insight_consumption.json');
const calibFile = () => path.join(_dataDir, 'calibration.json');
const accSamplesFile = () => path.join(_dataDir, 'accuracy_samples.json');
const accSummaryFile = () => path.join(_dataDir, 'accuracy_summary.json');
const compJudgFile = () => path.join(_dataDir, 'computation_judgments.json'); // 计算层判断校准（入校准）

const DAY = 86400000;
// 与 server.js DISCLAIMER_TEXT 同文（避免跨模块循环依赖，单独定义）
const DISCLAIMER = '此结论基于不足证据，仅供参考，不构成行动建议';

// ---------- 通用读写（与 reports.json 同形态，P0-8 升级原子写）----------
function ensureDir(file) { const d = path.dirname(file); if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readArr(file) {
  try { const a = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}
function writeArr(file, arr) {
  atomicWrite(file, JSON.stringify(arr, null, 2));
}
function dayKey(iso) { const d = new Date(iso); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

// ============================================================
// P0-2 · gap_snapshots：把「当时推了什么」落盘，支撑校准率回溯（§7.1）与周变动记忆（§7.4）
// 稳定 gid 由 computeWhiteSpace 给出（FNV 哈希：dim|value|type|methodKey），是跨时间的 join key。
// ============================================================
function recordGapSnapshotSet(state, ws) {
  if (!ws || ws.hidden || !Array.isArray(ws.gaps)) return 0;
  const projectId = (state && state.projectId) || null;
  const now = new Date().toISOString();
  const today = dayKey(now);
  const existing = readArr(gapSnapFile());
  // 同档案同 gap 一天只记一次，避免每次 /api/state 重算都追加 → 无限增长
  const seenToday = new Set(
    existing.filter(r => r.projectId === projectId && dayKey(r.snapshotAt) === today).map(r => r.gid)
  );
  const added = [];
  for (const g of ws.gaps) {
    if (!g.gid || seenToday.has(g.gid)) continue;
    added.push({
      gid: g.gid, snapshotAt: now, projectId,
      dim: g.dim, value: g.value, type: g.type,
      basis: g.basis, confidence: g.confidence, confidenceNum: g.confidenceNum,
      methodKey: g.methodKey, level: g.level, speculative: !!g.speculative
    });
  }
  if (added.length) writeArr(gapSnapFile(), existing.concat(added));
  return added.length;
}
function readGapSnapshots() { return readArr(gapSnapFile()); }

// ============================================================
// P0-2 · events：时间序列记忆（§7.4）—— 谁、什么时候、从什么变成什么
// ============================================================
// 事件类型枚举（时间线器 eventType 维度）。文档第二部分·时间线器要求扩展该枚举，
// 使每条事件可归入「市场动作」类别，支撑品牌五年轨迹的结构化呈现。
const EVENT_TYPES = new Set([
  'launch',        // 新品/新线上线
  'channel',       // 渠道变动（进/出某渠道）
  'price',         // 价格/促销调整
  'collab',        // 联名/合作
  'funding',       // 融资
  'rebrand',       // 品牌重塑
  'expansion',     // 扩张/进入新市场
  'contraction',   // 收缩/关店/退出
  'leadership',    // 关键人事
  'acquisition',   // 并购
  'data',          // 数据层事件（字段校正/快照），非市场动作
  'other'
]);
// 从 changeType 词面推导 eventType（当调用方未显式给 eventType 时兜底，向后兼容）。
function deriveEventType(changeType) {
  const s = String(changeType || '').toLowerCase();
  const rules = [
    [/price|promo|折扣|涨价|降价/, 'price'],
    [/channel|渠道/, 'channel'],
    [/launch|上线|新品|发布/, 'launch'],
    [/collab|联名|合作/, 'collab'],
    [/fund|融资|轮/, 'funding'],
    [/expand|扩张|出海|新市场/, 'expansion'],
    [/contract|收缩|关店|退出|关停/, 'contraction'],
    [/acqui|并购|收购/, 'acquisition'],
    [/rebrand|重塑|改名|品牌升级/, 'rebrand'],
    [/leader|人事|ceo|高管/, 'leadership'],
    [/field_corrected|snapshot|whitespace_snapshot/, 'data']
  ];
  for (const [re, t] of rules) if (re.test(s)) return t;
  return 'other';
}
function logEvent(ev) {
  const changeType = (ev && ev.changeType) || 'unknown';
  const eventType = (ev && ev.eventType && EVENT_TYPES.has(ev.eventType)) ? ev.eventType : deriveEventType(changeType);
  const e = {
    ts: ev && ev.ts ? ev.ts : new Date().toISOString(),
    competitorId: (ev && ev.competitorId) || null,
    changeType,
    eventType,
    from: ev && ev.from != null ? ev.from : null,
    to: ev && ev.to != null ? ev.to : null,
    source: ev && ev.source != null ? ev.source : null,
    confidence: ev && ev.confidence != null ? ev.confidence : null
  };
  const arr = readArr(eventsFile());
  arr.push(e);
  writeArr(eventsFile(), arr);
  return e;
}
function readEvents() { return readArr(eventsFile()); }

// ============================================================
// P0-2 · insight_consumption：北极星埋点（§11）
// action ∈ expand/favorite/share/export/mark_used/ignore；dwellMs 为停留毫秒（≥5000 视为有效停留信号）
// ============================================================
const CONSUME_ACTIONS = new Set(['expand', 'favorite', 'share', 'export', 'mark_used', 'ignore']);
function recordConsumption(rec) {
  const action = (rec && rec.action || '').trim();
  if (!CONSUME_ACTIONS.has(action)) return { ok: false, error: 'BAD_ACTION' };
  const itemId = String((rec && rec.itemId) || '').slice(0, 80);
  if (!itemId) return { ok: false, error: 'NO_ITEM' };
  const r = {
    ts: rec.ts ? rec.ts : new Date().toISOString(),
    tenantId: String((rec && rec.tenantId) || '').slice(0, 64) || null, // 租户归属（隔离读取用）
    userId: String((rec && rec.userId) || 'anon').slice(0, 40),
    itemType: (rec && rec.itemType === 'field') ? 'field' : 'gap',
    itemId,
    action,
    dwellMs: Number.isFinite(rec && rec.dwellMs) ? Math.max(0, Math.min(600000, rec.dwellMs)) : 0
  };
  const arr = readArr(consumeFile());
  arr.push(r);
  writeArr(consumeFile(), arr);
  return { ok: true, rec: r };
}
function readConsumptions() { return readArr(consumeFile()); }

// 北极星：窗口内「被实际消费的可信洞察条数」 + 强信号占比（信噪比校验）
// 门控（对齐 PRD §11 / 开发文档 11.2）：一条洞察算"被消费"需满足
//   - 主动强动作（favorite/share/export/mark_used）→ 强信号（STRONG_ACTION）
//   - 有效停留（dwellMs ≥ DWELL_VALID，即"展开后真读了"）→ 弱信号（PRD §11 定义，仍为有效消费但非强）
// 纯 expand 但 dwell < DWELL_VALID 视为误触展开，不计入（降噪）；
// ignore 仅降噪，计入 weak 但不算"被消费"。
// 口径红线：有效停留(dwell)是「弱信号」，绝不能当「强信号」——否则 strongRatio 虚高（P1-6 修复点）。
function computeNorthStar(rows, now, windowDays) {
  windowDays = windowDays || 7;
  now = now || Date.now();
  const cutoff = now - windowDays * DAY;
  const w = (rows || []).filter(r => new Date(r.ts).getTime() >= cutoff);
  const STRONG_ACTION = new Set(['favorite', 'share', 'export', 'mark_used']); // 主动强信号（不含 expand）
  const DWELL_VALID = 5000; // 文档约定：停留 ≥5s 视为有效消费/停留信号（弱信号）
  const consumed = new Set();
  let strong = 0, weak = 0;
  for (const r of w) {
    if (STRONG_ACTION.has(r.action)) {
      strong++; // 强信号：主动收藏/分享/导出/标记
      consumed.add(r.itemType + '|' + r.itemId);
    } else if ((r.dwellMs || 0) >= DWELL_VALID) {
      weak++; // #6：有效停留 = 弱信号（PRD §11），仍计消费但不算强，避免 strongRatio 虚高
      consumed.add(r.itemType + '|' + r.itemId);
    } else if (r.action === 'ignore') {
      weak++; // 仅降噪，不计消费
    }
    // 其余（如 expand 但 dwell<5s 误触）→ 不计入，降噪
  }
  const strongRatio = (strong + weak) > 0 ? strong / (strong + weak) : 0;
  return {
    count: consumed.size,           // 去重后「被实际消费的可信洞察条数」
    strong, weak,
    strongRatio: Math.round(strongRatio * 1000) / 1000,
    windowDays
  };
}

// ============================================================
// P0-3 · 校准确认协议（C1/C4 的出口）
// 判据：一条 gap 在 12 周窗口内出现可验证现实事件（对手进入/价位被填/人群被覆盖）或人工抽检确认当时真实存在 → 证实；
//       出现反证 → 证伪；无事件且无抽检 → 未决。
// 三判制：校准率 = 证实 ÷ (证实 + 证伪)，「未决」剔除分母（否则"没人动"被当推对，校准率虚高）。
// 误报率单列：证伪 ÷ 总发出量（gap_snapshots 在窗口内的条数）> 15% ⇒ stopIssuing（停发空白视图）。
// 对齐 PRD §11：wk8 校准率 ≥60%，<50% 触发推理规则复盘。
// ============================================================
const VERDICTS = new Set(['confirmed', 'refuted', 'undecided']);
function recordCalibration(rec) {
  const verdict = (rec && rec.verdict || '').trim();
  if (!VERDICTS.has(verdict)) return { ok: false, error: 'BAD_VERDICT' };
  const gapId = String((rec && rec.gapId) || '').slice(0, 80);
  if (!gapId) return { ok: false, error: 'NO_GAP' };
  const c = {
    gapId, verdict,
    tenantId: String((rec && rec.tenantId) || '').slice(0, 64) || null, // 租户归属（隔离/追责用）
    evidence: String((rec && rec.evidence) || '').slice(0, 400),
    note: String((rec && rec.note) || '').slice(0, 400),
    at: rec && rec.at ? rec.at : new Date().toISOString()
  };
  const arr = readArr(calibFile());
  arr.push(c);
  writeArr(calibFile(), arr);
  return { ok: true, rec: c };
}
function readCalibrations() { return readArr(calibFile()); }

// ============================================================
// P0-5 · 计算层判断校准（入校准）—— 第二部分算子（分层/体量/聚合/时间线/趋势/空白）
// 把算法「推断」与「现实校验」对齐，使推理智能可被量化养护（护城河养分）。
// 每条判断类型登记进 COMPUTATION_KINDS，便于校准率按类型归因。
// ============================================================
const COMPUTATION_KINDS = new Set([
  'tier',        // 分层器（large/mid/small）
  'scale',       // 体量估算（年化营收）
  'concentration', // 聚合器集中度
  'priceBand',   // 价格带分箱
  'channelCoverage', // 渠道覆盖率
  'trend',       // 趋势推断（含检验点）
  'whitespace'   // 赛道级空白战略价值
]);
function recordComputationJudgment(rec) {
  const kind = (rec && rec.judgmentType || '').trim();
  if (!COMPUTATION_KINDS.has(kind)) return { ok: false, error: 'BAD_KIND' };
  const j = {
    id: 'cj-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    judgmentType: kind,
    subjectId: String((rec && rec.subjectId) || '').slice(0, 80),
    predicted: rec && rec.predicted != null ? rec.predicted : null,    // 算法推断值
    actual: rec && rec.actual != null ? rec.actual : null,            // 现实校验值（人工/事件回看）
    confidence: rec && rec.confidence != null ? rec.confidence : null,
    at: rec && rec.at ? rec.at : new Date().toISOString(),
    source: String((rec && rec.source) || '').slice(0, 200),
    verdict: null,        // 三判：confirmed/refuted/undecided（分层/估算→人工抽检标注；趋势→事件回看）
    resolvedAt: null
  };
  const arr = readArr(compJudgFile());
  arr.push(j);
  writeArr(compJudgFile(), arr);
  return { ok: true, rec: j };
}
function readComputationJudgments() { return readArr(compJudgFile()); }

// ▶ PRD整改 §1.3：计算层判断三判解析（分层/估算由人工抽检标注；趋势走三判）
function resolveComputationJudgment(id, verdict) {
  if (!VERDICTS.has(verdict)) return { ok: false, error: 'BAD_VERDICT' };
  const arr = readArr(compJudgFile());
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return { ok: false, error: 'NOT_FOUND' };
  arr[idx].verdict = verdict;
  arr[idx].resolvedAt = new Date().toISOString();
  writeArr(compJudgFile(), arr);
  return { ok: true, rec: arr[idx] };
}

// ▶ PRD整改 §1.3：校准率按类型归因——分层/估算/趋势等计算层判断分别统计三判率
function computeComputationCalibration(windowDays, now) {
  windowDays = windowDays || 84;
  now = now || Date.now();
  const cutoff = now - windowDays * DAY;
  const arr = (readComputationJudgments() || []).filter(j => new Date(j.at).getTime() >= cutoff);
  const byKind = {};
  for (const k of COMPUTATION_KINDS) byKind[k] = { kind: k, total: 0, confirmed: 0, refuted: 0, undecided: 0, rate: 0 };
  let total = 0, confirmed = 0, refuted = 0, undecided = 0;
  for (const j of arr) {
    const b = byKind[j.judgmentType] || (byKind[j.judgmentType] = { kind: j.judgmentType, total: 0, confirmed: 0, refuted: 0, undecided: 0, rate: 0 });
    b.total++; total++;
    if (j.verdict === 'confirmed') { b.confirmed++; confirmed++; }
    else if (j.verdict === 'refuted') { b.refuted++; refuted++; }
    else { b.undecided++; undecided++; }
  }
  for (const k of Object.keys(byKind)) {
    const b = byKind[k];
    b.rate = (b.confirmed + b.refuted) > 0 ? Math.round(b.confirmed / (b.confirmed + b.refuted) * 1000) / 1000 : 0;
  }
  const rate = (confirmed + refuted) > 0 ? Math.round(confirmed / (confirmed + refuted) * 1000) / 1000 : 0;
  return { byKind, total, confirmed, refuted, undecided, rate, windowDays };
}

function computeCalibration(snapshots, calibrations, now, windowDays) {
  windowDays = windowDays || 84; // 12 周
  now = now || Date.now();
  const cutoff = now - windowDays * DAY;
  const ws = (calibrations || []).filter(c => new Date(c.at).getTime() >= cutoff);
  let confirmed = 0, refuted = 0, undecided = 0;
  for (const c of ws) {
    if (c.verdict === 'confirmed') confirmed++;
    else if (c.verdict === 'refuted') refuted++;
    else undecided++;
  }
  const rate = (confirmed + refuted) > 0 ? confirmed / (confirmed + refuted) : 0;
  const issued = (snapshots || []).filter(s => new Date(s.snapshotAt).getTime() >= cutoff).length;
  const falsePositiveRate = issued > 0 ? refuted / issued : 0;
  return {
    confirmed, refuted, undecided,
    rate: Math.round(rate * 1000) / 1000,
    windowDays,
    issued,
    falsePositiveRate: Math.round(falsePositiveRate * 1000) / 1000,
    stopIssuing: falsePositiveRate > 0.15
  };
}

// ============================================================
// P0-4 · 字段准确率（与置信度正交）—— 堵 tier 盲区（采到但抽错）
// 抽检协议：每维度每周随机抽 ≥30 条，双人独立标注（correct 布尔），产出各维度/各来源通道滚动准确率。
// 空白推理 input 门禁：一条 gap 可展示为 opportunity ⟺ confidenceNum≥40 ∧ 其依赖维度的滚动准确率≥红线。
//   未达标的维度只「退出空白推理」（该维 gap 降为未探测区域展示），不阻塞整体上线。
//   无数据（尚无抽检）→ fail-open（不降级），避免冷启动误杀。
// 输入字段红线 ≥90%、展示字段红线 ≥80%（gap 是展示产物，按 80% 门禁；机制同构）。
// ============================================================
// 准确率样本的「来源通道」取值集合。
// 既包含种子来源通道（shopify-scrape/official，由 seedChannelOf 注入），
// 也包含字段抽取 getter 实际产出的 method（code-probe/neg-check/llm-review/llm-band/llm-guess/user-correct/conflict/none/unprobed）。
// 纠错回流时直接存 field.method 原值（#2：按算法原通道聚合「哪个通道在拖后腿」），
// 故此处必须覆盖 getter 真实产出的全部 method，否则会被误置 null 丢失归因。
const ACC_CHANNELS = new Set([
  'shopify-scrape', 'official',
  'llm-band', 'llm-guess', 'llm-review',
  'code-probe', 'neg-check',
  'user-correct', 'conflict', 'none', 'unprobed'
]);
function recordAccuracySample(rec) {
  const dimension = String((rec && rec.dimension) || '').trim();
  if (!dimension) return { ok: false, error: 'NO_DIMENSION' };
  const correct = rec && (rec.correct === true || rec.correct === 'true');
  const s = {
    id: (rec && rec.id) || ('acc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)),
    at: rec && rec.at ? rec.at : new Date().toISOString(),
    tenantId: String((rec && rec.tenantId) || '').slice(0, 64) || null, // 租户归属（隔离/追责用）
    dimension,
    fieldKey: String((rec && rec.fieldKey) || '').slice(0, 60),
    evidenceId: String((rec && rec.evidenceId) || '').slice(0, 60),
    competitorId: (rec && rec.competitorId) != null ? String(rec.competitorId).slice(0, 60) : null,
    channel: ACC_CHANNELS.has(rec && rec.channel) ? rec.channel : null,
    errorType: (rec && rec.errorType) ? String(rec.errorType).slice(0, 40) : null, // #1：E1-E5 错误分类
    layer: (rec && rec.layer) ? String(rec.layer).slice(0, 40) : null,             // #1：归因到层
    algoValue: String((rec && rec.algoValue) == null ? '' : rec.algoValue).slice(0, 200),
    humanValue: String((rec && rec.humanValue) == null ? '' : rec.humanValue).slice(0, 200),
    correct,
    judge: String((rec && rec.judge) || '').slice(0, 40)
  };
  const arr = readArr(accSamplesFile());
  arr.push(s);
  writeArr(accSamplesFile(), arr);
  const summary = recomputeAccuracySummary();
  return { ok: true, rec: s, summary };
}
// 滚动准确率：默认近 30 天窗口，按维度 + 来源通道聚合；写 summary 文件供 computeWhiteSpace 快速读取
function recomputeAccuracySummary(capDays) {
  capDays = capDays || 30;
  const now = Date.now();
  const cutoff = now - capDays * DAY;
  const samples = readArr(accSamplesFile()).filter(s => new Date(s.at).getTime() >= cutoff);
  const byDim = {}, byCh = {}, byErr = {}, byLayer = {};
  for (const s of samples) {
    const d = byDim[s.dimension] || (byDim[s.dimension] = { n: 0, correct: 0 });
    d.n++; if (s.correct) d.correct++;
    if (s.channel) { const c = byCh[s.channel] || (byCh[s.channel] = { n: 0, correct: 0 }); c.n++; if (s.correct) c.correct++; }
    if (s.errorType) { const e = byErr[s.errorType] || (byErr[s.errorType] = { n: 0, correct: 0 }); e.n++; if (s.correct) e.correct++; } // #1：按错误类型聚类
    if (s.layer) { const l = byLayer[s.layer] || (byLayer[s.layer] = { n: 0, correct: 0 }); l.n++; if (s.correct) l.correct++; }         // #1：按归因层聚类
  }
  const accOf = o => o.n ? Math.round((o.correct / o.n) * 1000) / 1000 : null;
  const sum = { byDimension: {}, byChannel: {}, byErrorType: {}, byLayer: {}, updatedAt: new Date().toISOString(), windowDays: capDays };
  for (const k in byDim) sum.byDimension[k] = { accuracy: accOf(byDim[k]), n: byDim[k].n };
  for (const k in byCh) sum.byChannel[k] = { accuracy: accOf(byCh[k]), n: byCh[k].n };
  for (const k in byErr) sum.byErrorType[k] = { accuracy: accOf(byErr[k]), n: byErr[k].n };
  for (const k in byLayer) sum.byLayer[k] = { accuracy: accOf(byLayer[k]), n: byLayer[k].n };
  writeArr(accSummaryFile(), sum);
  return sum;
}
function loadAccuracySummary() {
  try {
    const s = JSON.parse(fs.readFileSync(accSummaryFile(), 'utf8'));
    return (s && s.byDimension) ? s : { byDimension: {}, byChannel: {}, byErrorType: {}, byLayer: {} };
  } catch { return { byDimension: {}, byChannel: {} }; }
}
// input 门禁：依赖维度抽取准确率不足 → 该维空白推理退出（降为未探测区域，附免责声明）
function applyAccuracyGate(gaps, summary, opts) {
  opts = opts || {};
  const redline = (opts.displayRedline != null) ? opts.displayRedline : 0.8; // 展示字段红线 80%
  const byDim = (summary && summary.byDimension) || {};
  if (!Array.isArray(gaps)) return gaps;
  for (const g of gaps) {
    const a = byDim[g.dim];
    if (a && a.accuracy != null && a.accuracy < redline) {
      g.confidence = 'low';
      g.confidenceNum = 30;
      g.basis = 'unverified';
      g.level = 'undetected';
      g.accuracyInsufficient = true;
      g.note = (g.note || '') + `（字段抽取准确率不足：维度「${g.dim}」历史抽检准确率 ${(a.accuracy * 100).toFixed(0)}% < 红线 ${(redline * 100).toFixed(0)}%，空白推理退出，仅作未探测区域展示）`;
      if (!g.disclaimer) g.disclaimer = DISCLAIMER;
    }
  }
  return gaps;
}

// ============================================================
// P1-7 · A2：金标集种子（从既有真实证据 fieldSources 抽取）
// 把 competitors[].fieldSources[key] 中 **tier===1** 的真实来源抽为准确率抽检样本，
// 使 P0-4 的 applyAccuracyGate 不再「空转 fail-open」，而是有数据可算（冷启动默认 pass，随 C 回流纠错收紧）。
// 仅 seed tier-1（verified / official / shopify 真实来源）：tier-2（llm-band 等推断来源）跳过——
// 若 tier-2 来源本身抽错（正是「数据源不准」根源场景），把它当 correct=true 基线会虚高准确率、放行门禁，
// 与「防错不依赖用户纠错」策略冲突。纠正 tier-2 错误交给 C 回流（用户纠错）逐步校准，而非种子假装正确。
// 幂等：同 (fieldKey|evidenceId) 已存在则跳过，可重复运行不重复注入。
// 种子默认 correct=true（tier-1 真实来源即确认该字段抽取正确），judge='seed-auto' 与人工标注区分。
// ============================================================
const ACC_SEED_CHANNEL = { 1: 'official', 2: 'llm-band' };
function dimensionOfFieldKey(key) {
  if (!key) return 'other';
  if (key.indexOf('channels.') === 0) return 'channels';
  if (key.indexOf('categories.') === 0) return 'categories';
  if (key.indexOf('recentMoves.') === 0) return 'launchCadence';
  if (key.indexOf('reviews') === 0) return 'reviews';
  if (key.indexOf('price') === 0) return 'price';
  if (key.indexOf('sellingPoints') === 0) return 'sellingPoints';
  if (key.indexOf('customization') === 0) return 'customization';
  const dot = key.indexOf('.');
  return dot > 0 ? key.slice(0, dot) : key;
}
function seedChannelOf(tier, kind) {
  if (tier === 1) return (kind && /shopify/i.test(kind)) ? 'shopify-scrape' : 'official';
  if (tier === 2) return 'llm-band';
  return null;
}
function seedAccuracyFromFieldSources(state, opts) {
  opts = opts || {};
  const competitors = (state && state.competitors) || [];
  const existing = readArr(accSamplesFile());
  const seen = new Set(existing.map((s) => (s.competitorId || '') + '|' + (s.fieldKey || '') + '|' + (s.evidenceId || '')));
  const at = opts.at || new Date().toISOString();
  const out = [];
  let skipped = 0;
  for (const c of competitors) {
    const fs0 = c.fieldSources || {};
    for (const key in fs0) {
      const dim = dimensionOfFieldKey(key);
      for (const e of (fs0[key] || [])) {
        if (!e || e.tier !== 1) continue; // #3：仅 seed tier-1 真实来源；跳过 tier-2（防 llm-band 推断源虚高准确率）
        const evId = e.id || '';
        const dedup = (c.id || 'x') + '|' + key + '|' + evId; // 证据 id 按竞品命名空间隔离
        if (seen.has(dedup)) { skipped++; continue; }
        seen.add(dedup);
        const title = String(e.title || e.kind || '来源').slice(0, 200);
        out.push({
          id: 'seed-' + dim + '-' + evId + '-' + (c.id || 'x'),
          at,
          dimension: dim,
          fieldKey: String(key).slice(0, 60),
          evidenceId: evId,
          competitorId: c.id || null,
          channel: seedChannelOf(e.tier, e.kind),
          algoValue: title,
          humanValue: title,
          correct: true,
          judge: 'seed-auto'
        });
      }
    }
  }
  if (out.length) {
    writeArr(accSamplesFile(), existing.concat(out));
    recomputeAccuracySummary(opts.capDays);
  }
  const summary = loadAccuracySummary();
  return { added: out.length, skipped, total: existing.length + out.length, byDimension: summary.byDimension };
}

// ============================================================
// P1-7 · C：纠错回流金标集（工作流 C 闭环）
// 一条「已审核 accept」的用户纠错转为字段准确率样本，喂 L2 门禁（applyAccuracyGate），
// 使人工标注能随真实反馈收紧各维度准确率（冷启动 seed 默认 pass，C 回流逐步校准）。
// 幂等 upsert（按 fc-id），同一纠错重复 accept 不重复注入，仅更新 verdict。
// ============================================================
function readAccuracySamples() { return readArr(accSamplesFile()); }
function upsertAccuracySample(rec) {
  const id = String((rec && rec.id) || '').trim();
  if (!id) return { ok: false, error: 'NO_ID' };
  const arr = readArr(accSamplesFile());
  const idx = arr.findIndex(s => s.id === id);
  if (idx >= 0) {
    const merged = Object.assign({}, arr[idx], rec);
    arr[idx] = merged;
    writeArr(accSamplesFile(), arr);
    const summary = recomputeAccuracySummary();
    return { ok: true, rec: merged, summary, updated: true };
  }
  return recordAccuracySample(rec); // 新样本：recordAccuracySample 内部已 recompute summary
}
// 错误类型 → 归因层（#1：支撑「本周哪类错误占大头 → 改采集模板还是改提取 prompt」）
//   wrong-value / wrong-currency / wrong-state → extraction（提取错）
//   missing-source                                → collection（采集漏）
//   over-confident                                → confidence（置信错）
//   confirm-correct                               → null（无错，不计入归因层）
function mapErrorLayer(type) {
  if (type === 'wrong-value' || type === 'wrong-currency' || type === 'wrong-state') return 'extraction';
  if (type === 'missing-source') return 'collection';
  if (type === 'over-confident') return 'confidence';
  return null;
}
// verdict 推导（与 field-correct 的 type 对齐）：
//   wrong-value / wrong-currency / wrong-state → 原抽取错误（correct=false）
//   confirm-correct / missing-source / over-confident → 原值正确（correct=true）
// channel = 算法原通道(corr.prevChannel，即 field.method 原值，#2：按通道聚合「哪个通道在拖后腿」)，不再恒 'user-correct'；
// errorType = 纠错类型（#1：E1-E5 错误分类，用于按错误类型聚类）；layer = mapErrorLayer（#1：归因到层）；
// algoValue=纠错前系统显示值快照(corr.prevValue)，humanValue=用户确认值；judge='user-review'（保留用户复核标记）。
function correctionToAccuracySample(corr) {
  if (!corr || !corr.id) return { ok: false, error: 'NO_CORR' };
  const isWrong = corr.type === 'wrong-value' || corr.type === 'wrong-currency' || corr.type === 'wrong-state';
  const humanText = String(
    (corr.text || '') ||
    (corr.value != null ? (typeof corr.value === 'object' ? JSON.stringify(corr.value) : String(corr.value)) : '') ||
    (corr.currency || '')
  ).slice(0, 200);
  return upsertAccuracySample({
    id: 'fc-' + corr.id,
    dimension: dimensionOfFieldKey(corr.field),
    fieldKey: String(corr.field || '').slice(0, 60),
    evidenceId: corr.id,
    competitorId: corr.competitorId || null,
    channel: corr.prevChannel || null, // #2：存算法原通道（field.method），非 'user-correct'
    errorType: corr.type || null,      // #1：E1-E5 错误分类
    layer: mapErrorLayer(corr.type),   // #1：归因到层
    algoValue: String(corr.prevValue || '').slice(0, 200),
    humanValue: humanText,
    correct: !isWrong,
    judge: 'user-review'
  });
}
// #4：纠错撤销回滚——删除该纠错已回流的准确率样本并重建汇总，使维度准确率不被已撤销纠错污染。
function deleteAccuracySample(id) {
  const sid = String(id || '').trim();
  if (!sid) return { ok: false, error: 'NO_ID' };
  const arr = readArr(accSamplesFile());
  const idx = arr.findIndex(s => s.id === sid);
  if (idx < 0) return { ok: false, error: 'NOT_FOUND' };
  arr.splice(idx, 1);
  writeArr(accSamplesFile(), arr);
  const summary = recomputeAccuracySummary();
  return { ok: true, removed: 1, summary };
}

module.exports = {
  setDataDir,
  // 持久化
  recordGapSnapshotSet, readGapSnapshots,
  logEvent, readEvents, EVENT_TYPES, deriveEventType,
  recordConsumption, readConsumptions, computeNorthStar,
  // 校准
  recordCalibration, readCalibrations, computeCalibration,
  // 计算层判断校准（入校准）
  COMPUTATION_KINDS, recordComputationJudgment, readComputationJudgments, resolveComputationJudgment, computeComputationCalibration,
  // 准确率
  recordAccuracySample, recomputeAccuracySummary, loadAccuracySummary, applyAccuracyGate,
  seedAccuracyFromFieldSources, dimensionOfFieldKey,
  readAccuracySamples, upsertAccuracySample, correctionToAccuracySample, deleteAccuracySample, mapErrorLayer,
  // 常量（供测试/调用方复用）
  CONSUME_ACTIONS, VERDICTS, ACC_CHANNELS, DISCLAIMER, DAY
};
