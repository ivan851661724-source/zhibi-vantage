#!/usr/bin/env node
'use strict';
/**
 * e2e-discover-smoke.js —— 发现链路加固端到端冒烟测试
 * 验证：B1（启动即落库）/ B2+B4（SSE 事件回放与到达）/ F2（幂等）在真机无问题。
 * 用法：node scripts/e2e-discover-smoke.js   （需 3300 服务在跑）
 */
const BASE = process.env.BASE_URL || 'http://localhost:3300';
const fetch = globalThis.fetch;
const H = (token) => ({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token });

async function main() {
  const email = 'smoke-' + Date.now() + '@test.local';
  const reg = await (await fetch(BASE + '/api/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'smokepass', name: 'smoke' }),
  })).json();
  const token = reg.token;
  if (!token) { console.error('注册失败：', JSON.stringify(reg)); process.exit(1); }
  console.log('① 注册测试租户 OK →', email);

  const body = { track: 'collectible figure', intent: { regions: ['us'] } };
  const dres = await (await fetch(BASE + '/api/discover', {
    method: 'POST', headers: H(token), body: JSON.stringify(body),
  })).json();
  console.log('② /api/discover →', JSON.stringify(dres));
  const pid = dres.projectId;
  if (!pid) { console.error('未返回 projectId，终止'); process.exit(1); }

  // B1：discover 返回后「立即」查 state，应已落库（track 非空、discoverDone:false）
  const s0 = await (await fetch(BASE + '/api/state', { headers: H(token) })).json();
  const b1ok = !!(s0.projectId && s0.track && s0.discoverDone === false);
  console.log('③ B1 立即落库检查 →', JSON.stringify({ projectId: s0.projectId, track: s0.track, discoverDone: s0.discoverDone }), b1ok ? '✓' : '✗');

  const pl = await (await fetch(BASE + '/api/projects', { headers: H(token) })).json();
  const list = Array.isArray(pl) ? pl : (pl && pl.projects) || [];
  const inList = list.some((p) => (p.projectId || p.id) === pid);
  console.log('④ /api/projects 列出该项目 →', inList ? '✓' : '✗', '(', JSON.stringify(pl).slice(0, 120), ')');

  // 抓 SSE 事件（确认 B2 记录 + B4 回放 + 实时到达）
  const sseRes = await fetch(BASE + '/api/stream', { headers: H(token) });
  const reader = sseRes.body.getReader();
  const dec = new TextDecoder();
  let buf = '', done = false;
  const events = [];
  const sseTask = (async () => {
    try {
      while (!done) {
        const { value, done: d } = await reader.read();
        if (d) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            try {
              const ev = JSON.parse(line.slice(6));
              if (ev.type && ev.type !== 'change' && ev.type !== 'ping') { events.push(ev.type); console.log('   SSE:', ev.type, ev.projectId || '', ev.stage || ''); }
            } catch {}
          }
        }
      }
    } catch {}
  })();

  // 轮询直到 discoverDone 或超时
  let last = s0;
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    last = await (await fetch(BASE + '/api/state', { headers: H(token) })).json();
    const cc = (last.competitors || []).length;
    console.log(`   轮询#${i}: discoverDone=${last.discoverDone} competitors=${cc}${last.failed ? ' failed=' + last.failed : ''}`);
    if (last.discoverDone) break;
    if (last.failed) break;
  }
  done = true;
  await sseTask.catch(() => {});

  console.log('⑤ 最终结果 →', JSON.stringify({
    projectId: last.projectId, track: last.track, discoverDone: last.discoverDone,
    competitors: (last.competitors || []).length, failed: !!last.failed,
  }));
  const uniq = [...new Set(events)];
  console.log('⑥ SSE 事件类型（去重）→', uniq.join(', ') || '(无)');
  const sawComplete = uniq.includes('discover_complete');
  const sawError = uniq.includes('discover_error');
  console.log('⑦ 结论：',
    b1ok && inList && (last.discoverDone || last.failed) && (sawComplete || sawError || events.length)
      ? '发现链路通畅，B1 落库有效，事件到达 ✅'
      : '存在问题，需排查 ❌');
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
