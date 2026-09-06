#!/usr/bin/env node
'use strict';
// 抓 discover 的首个 discover_error / discover_complete 事件完整 payload，定位失败真因。
const BASE = 'http://localhost:3300';
const fetch = globalThis.fetch;
const H = (t) => ({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t });
(async () => {
  const email = 'cap-' + Date.now() + '@test.local';
  const reg = await (await fetch(BASE + '/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'smokepass', name: 'cap' }) })).json();
  const token = reg.token;
  const dres = await (await fetch(BASE + '/api/discover', { method: 'POST', headers: H(token), body: JSON.stringify({ track: 'collectible figure', intent: { regions: ['us'] } }) })).json();
  console.log('discover ->', JSON.stringify(dres));
  const sse = await fetch(BASE + '/api/stream', { headers: H(token) });
  const reader = sse.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let done = false;
  while (!done) {
    const { value, done: d } = await reader.read();
    if (d) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) {
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        if (ev.type === 'discover_error' || ev.type === 'discover_complete') {
          console.log('EVENT ->', JSON.stringify(ev));
          done = true; break;
        }
      }
    }
  }
  process.exit(0);
})().catch((e) => { console.error('ERR', e); process.exit(1); });
