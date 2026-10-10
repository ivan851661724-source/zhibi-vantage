#!/usr/bin/env node
'use strict';
/**
 * e2e-timing.js —— 全链路真实计时测试（含发现 SSE 阶段时间线 + 深研队列逐竞品耗时）
 * 用法：node scripts/e2e-timing.js [track]   （需 3300 服务在跑；会产生真实搜索/LLM 花费）
 * 输出：阶段时间线表 + 深研总耗时 + 每竞品深研时长与各环节 attempt 时间戳。
 */
const BASE = process.env.BASE_URL || 'http://localhost:3300';
const TRACK = process.argv[2] || 'cold brew coffee maker';
const DEEP_TIMEOUT_MS = Number(process.env.DEEP_TIMEOUT_MS || 600000); // 深研总等待上限 10 分钟

const t0 = Date.now();
const rel = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const H = (token) => ({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token });
const fmtDur = (ms) => ms == null ? '—' : (ms / 1000).toFixed(1) + 's';

async function main() {
  // ① 注册测试租户
  let tA = Date.now();
  const email = 'timing-' + Date.now() + '@test.local';
  const reg = await (await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'timingpass', name: 'timing' }),
  })).json();
  console.log(`[${rel()}] ① 注册 → token ${reg.token ? 'OK' : 'FAIL ' + JSON.stringify(reg).slice(0, 100)}（${fmtDur(Date.now() - tA)}）`);
  const token = reg.token;
  if (!token) process.exit(1);

  // ② 连 SSE（事件时间线）
  const sseEvents = [];
  const sseRes = await fetch(BASE + '/api/stream', { headers: H(token) });
  const reader = sseRes.body.getReader();
  const dec = new TextDecoder();
  const sseTask = (async () => {
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try { sseEvents.push({ at: Date.now(), ev: JSON.parse(line.slice(6)) }); } catch (e) {}
        }
      }
    }
  })();

  // ③ discover（202 异步）
  tA = Date.now();
  const dres = await (await fetch(BASE + '/api/discover', {
    method: 'POST', headers: H(token), body: JSON.stringify({ track: TRACK, intent: { regions: ['us'] } }),
  })).json();
  console.log(`[${rel()}] ② POST /api/discover → projectId=${dres.projectId}（HTTP ${fmtDur(Date.now() - tA)}）`);
  if (!dres.projectId) { console.error(JSON.stringify(dres)); process.exit(1); }
  const pid = dres.projectId;

  // ④ 等待 discover_complete（SSE 驱动；error 事件实时检查，不等到超时）
  let discoverDoneAt = null, errorEv = null;
  while (!discoverDoneAt && !errorEv && Date.now() - t0 < 300000) {
    await new Promise(r => setTimeout(r, 500));
    discoverDoneAt = sseEvents.find(e => e.ev.type === 'discover_complete' && e.ev.projectId === pid);
    errorEv = sseEvents.find(e => e.ev.type === 'discover_error');
  }
  if (errorEv) { console.error(`[${rel()}] ✗ discover_error:`, JSON.stringify(errorEv.ev).slice(0, 300)); try { await reader.cancel(); } catch (e) {} process.exit(2); }
  if (!discoverDoneAt) { console.error(`[${rel()}] ✗ 5 分钟未收到 discover_complete`); try { await reader.cancel(); } catch (e) {} process.exit(1); }

  // 阶段时间线表
  console.log(`[${rel()}] ③ 发现完成（SSE 全程 ${fmtDur(discoverDoneAt.at - tA)}）。阶段时间线：`);
  const stages = sseEvents.filter(e => e.ev.type === 'discover_stage' && e.ev.projectId === pid);
  let prev = tA;
  for (const s of stages) {
    const label = s.ev.label || s.ev.stage;
    console.log(`    +${fmtDur(s.at - tA)}  ${label}（该段 ${fmtDur(s.at - prev)}，pct ${s.ev.pct}，found ${s.ev.found}）`);
    prev = s.at;
  }
  const brandFound = sseEvents.filter(e => e.ev.type === 'brand_found' && e.ev.projectId === pid);
  console.log(`    brand_found 事件 ${brandFound.length} 条（lead/skeleton 混合）`);

  // ⑤ 轮询深研队列完成（progress.done === total）
  console.log(`[${rel()}] ④ 等待深研队列（逐竞品后台）…`);
  const tDeep0 = discoverDoneAt.at;
  let state = null, deepDoneAt = null, lastDone = -1;
  const statusHistory = [];
  while (Date.now() - tDeep0 < DEEP_TIMEOUT_MS) {
    await new Promise(r => setTimeout(r, 3000));
    const tS = Date.now();
    const res = await fetch(BASE + '/api/state', { headers: H(token) });
    const apiMs = Date.now() - tS;
    state = await res.json();
    if (state.projectId !== pid) continue; // current 指针已切到本项目？discover 设置过 setCurrentId，应一致
    const p = state.progress || {};
    if (p.done !== lastDone) {
      statusHistory.push(`    +${fmtDur(Date.now() - tDeep0)}  深研 ${p.done}/${p.total}`);
      lastDone = p.done;
    }
    if (p.total > 0 && p.done >= p.total) { deepDoneAt = Date.now(); break; }
  }
  try { await reader.cancel(); } catch (e) {}
  if (!deepDoneAt) console.log(`    ⚠ 深研等待超时（${DEEP_TIMEOUT_MS / 1000}s），输出已完成部分`);

  // ⑥ 每竞品耗时（attempts 时间戳 + researchedAt）
  const comps = (state && state.competitors) || [];
  console.log(`[${rel()}] ⑤ 深研 ${deepDoneAt ? '完成' : '部分完成'}（队列耗时 ${fmtDur(deepDoneAt ? deepDoneAt - tDeep0 : null)}，${comps.length} 家）`);
  const rows = comps.map(c => {
    const ats = (c.attempts || []).map(a => Date.parse(a.at)).filter(x => !isNaN(x));
    const first = ats.length ? Math.min.apply(null, ats) : null;
    const last = ats.length ? Math.max.apply(null, ats) : null;
    return { name: c.name, status: c.status, attempts: (c.attempts || []).length, dur: (first && last) ? last - first : null };
  }).sort((a, b) => (b.dur || 0) - (a.dur || 0));
  for (const r of rows) {
    console.log(`    ${r.status === 'done' ? '✓' : r.status === 'error' ? '✗' : '…'} ${String(r.name).slice(0, 28).padEnd(28)} ${r.status.padEnd(10)} attempts=${String(r.attempts).padEnd(3)} 深研窗 ${fmtDur(r.dur)}`);
  }
  // 关键产物抽查
  const done0 = comps.find(c => c.status === 'done') || {};
  console.log(`[${rel()}] ⑥ 产物抽查（首家 done）：`);
  console.log(`    priceStats: ${done0.priceStats ? `中位数 ${done0.priceStats.median}，判定 ${done0.priceStats.verdict && done0.priceStats.verdict.code}` : 'null'}`);
  console.log(`    s2Match: ${done0.s2Match ? `score=${done0.s2Match.score} 杂货铺=${done0.s2Match.groceryStore}` : 'null'}`);
  console.log(`    typeDist: ${done0.typeDist ? done0.typeDist.items.length + ' 类目，未分类 ' + done0.typeDist.unclassified : 'null'}`);
  console.log(`    marketTrends: ${JSON.stringify(state.marketTrends || null).slice(0, 200)}`);
  console.log(`    adLibrary: ${done0.adLibrary ? 'OK（活跃度 ' + done0.adLibrary.activityLevel + '）' : 'null（无 token=未探测，正常）'}`);
  console.log(`    excluded: ${(state.excluded || []).length} 家 → 原因 ${JSON.stringify(state.excludedReasons || {})}`);
  // API 延迟抽查
  const lat = async (path) => { const s = Date.now(); await fetch(BASE + path, { headers: H(token) }); return Date.now() - s; };
  console.log(`[${rel()}] ⑦ API 延迟：/api/state ${await lat('/api/state')}ms · /api/projects ${await lat('/api/projects')}ms`);
  console.log(`\n总耗时 ${fmtDur(Date.now() - t0)}`);
}

main().catch(e => { console.error('E2E 失败：', e && e.message || e); process.exit(1); });
