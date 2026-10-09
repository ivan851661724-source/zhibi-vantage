'use strict';
// ============================================================
// llm-timeout.test.js —— 验证 LLM 网关超时覆盖「响应头等待」与「正文读取」
// （Phase 1 验收：超时覆盖 LLM 响应头与正文读取 + 阶段度量落盘）
//
// 真实 socket 场景（127.0.0.1 临时端口，零外部依赖）：
//   场景 1：服务器立即发响应头、但正文永久挂起 → deadline 必须 abort 正文读取，
//           经重试后降级返回 {}；llm_body_read 行 status=error。
//   场景 2：服务器连响应头都不发 → deadline 必须中断头等待；
//           llm_header_wait 行 status=error。
//   场景 3：正常响应 → header/body 两行均 status=ok，且 header 行 duration>0。
// ============================================================
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 数据目录隔离必须先于任何业务模块 require（paths.js 缓存陷阱）
process.env.ZB_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-llmto-test-'));
process.env.OBS_DB_PATH = path.join(process.env.ZB_DATA_DIR, 'obs.sqlite');

const GW = require('../services/llm-gateway.js');
const Telemetry = require('../observability/telemetry.js');

let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('ok - ' + name); }
  catch (e) { failed++; console.error('FAIL - ' + name + ': ' + String(e.message || e).split('\n')[0]); }
}

function startServer(handler) {
  return new Promise(resolve => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
const base = port => `http://127.0.0.1:${port}/v1`;

(async () => {

await t('场景1：正文永久挂起 → 超时中断、重试后降级，body 行 status=error', async () => {
  const { srv, port } = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{ "choices": [{"message": {"content":'); // 只发一半，正文挂起
    // 故意不 end() —— 正文黑洞
  });
  try {
    const t0 = Date.now();
    const out = await GW.call([{ role: 'user', content: 'x' }], {
      apiKey: 'test-key', model: 'm1', json: true, baseUrl: base(port),
      timeoutMs: 300, maxAttempts: 2, fieldKey: 'obs-test',
    });
    const elapsed = Date.now() - t0;
    assert.deepStrictEqual(out, {}, '降级返回空对象');
    assert.ok(elapsed < 300 * 2 + 2000 + 1500, '总耗时受 deadline 约束（无网络黑洞）: ' + elapsed + 'ms');
    const rows = Telemetry.summary({ windowHours: 1 });
    // 直接读库断言（summary 阶段样本 <5 会 insufficient_sample）
    const db = new (require('node:sqlite').DatabaseSync)(process.env.OBS_DB_PATH);
    const bodyRows = db.prepare("SELECT * FROM stage_metrics WHERE stage='llm_body_read'").all();
    const headerRows = db.prepare("SELECT * FROM stage_metrics WHERE stage='llm_header_wait'").all();
    db.close();
    assert.ok(bodyRows.length >= 1, 'llm_body_read 已落盘');
    assert.ok(bodyRows.every(r => r.status === 'error'), 'body 失败行 status=error');
    assert.ok(bodyRows.every(r => r.degraded === 1), '降级标志=1');
    assert.ok(headerRows.length >= 1 && headerRows[0].status === 'ok', 'header 行 status=ok（headers 正常到达）');
    assert.strictEqual(headerRows[0].model, 'm1', 'model 已记录');
    assert.ok(headerRows[0].duration_ms >= 0 && headerRows[0].duration_ms < 300 + 100, 'header 等待短于 deadline');
  } finally { srv.close(); }
});

await t('场景2：响应头永不到达 → 超时中断头等待，header 行 status=error', async () => {
  const { srv, port } = await startServer((req, res) => {
    // 不 writeHead、不 end —— 头黑洞
  });
  try {
    const t0 = Date.now();
    const out = await GW.call([{ role: 'user', content: 'x' }], {
      apiKey: 'test-key', model: 'm2', json: true, baseUrl: base(port),
      timeoutMs: 250, maxAttempts: 1, fieldKey: 'obs-test',
    });
    const elapsed = Date.now() - t0;
    assert.deepStrictEqual(out, {}, '降级返回空对象');
    assert.ok(elapsed < 250 + 2000, '头等待受 deadline 约束: ' + elapsed + 'ms');
    const db = new (require('node:sqlite').DatabaseSync)(process.env.OBS_DB_PATH);
    const headerRows = db.prepare("SELECT * FROM stage_metrics WHERE stage='llm_header_wait' AND model='m2'").all();
    db.close();
    assert.ok(headerRows.length === 1, 'header 行恰好一条（1 次尝试）');
    assert.strictEqual(headerRows[0].status, 'error', 'header 行 status=error');
    assert.ok(headerRows[0].duration_ms >= 240, '头等待时长≈deadline: ' + headerRows[0].duration_ms);
    assert.ok(headerRows[0].degraded === 1, '降级标志=1');
  } finally { srv.close(); }
});

await t('场景3：正常响应 → header/body 两行 ok，cache_hit 与 retry_count 正确', async () => {
  const { srv, port } = await startServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 10 },
      }));
    });
  });
  try {
    const out = await GW.call([{ role: 'user', content: 'x' }], {
      apiKey: 'test-key', model: 'm3', json: true, baseUrl: base(port),
      timeoutMs: 3000, maxAttempts: 1, fieldKey: 'obs-test',
    });
    assert.deepStrictEqual(out, { ok: true }, '正常解析');
    const db = new (require('node:sqlite').DatabaseSync)(process.env.OBS_DB_PATH);
    const rows = db.prepare("SELECT * FROM stage_metrics WHERE model='m3' ORDER BY id").all();
    db.close();
    const h = rows.find(r => r.stage === 'llm_header_wait');
    const b = rows.find(r => r.stage === 'llm_body_read');
    assert.ok(h && h.status === 'ok', 'header ok');
    assert.ok(b && b.status === 'ok', 'body ok');
    assert.strictEqual(b.cache_hit, 1, 'cache_hit=1（prompt 全命中）');
    assert.strictEqual(h.retry_count, 0, '首次尝试 retry_count=0');
    assert.ok(h.degraded === 0 && b.degraded === 0, '成功调用 degraded=0');
  } finally { srv.close(); }
});

console.log(failed ? `\nllm-timeout.test: ${failed} failed` : '\nllm-timeout.test: all passed');
if (failed) process.exit(1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
