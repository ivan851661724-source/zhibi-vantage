'use strict';
// ============================================================
// SC-05 r3：网页存档发现阶段的失败分类回归
// ------------------------------------------------------------
// 🔴 fixture 声明：本文件用**受控测试数据**（monkey-patch Net.safeRequest 抛出
//    特定错误）验证**分类逻辑**，不替代真实验收，也不产生任何"已回补"结论。
// 背景（r3 真实复现）：代理出站环境下，代理拒绝到 web.archive.org 的隧道时
//    Node 抛 ERR_PROXY_TUNNEL（"Failed to establish tunnel ... 502 Bad Gateway"），
//    旧正则未覆盖 → 被误判为 internal（本地故障），导致任务落 failed 且用户文案错误。
//    正确语义：目标不可达 = unreachable（source_unavailable）。
// ============================================================
const os = require('os');
const fs = require('fs');
const path = require('path');

// 测试隔离：必须先设数据目录再 require 业务模块
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'zb-arch-r3-'));
process.env.ZB_DATA_DIR = TMP;

const { test } = require('node:test');
const assert = require('node:assert');

const Net = require('../research/net.js');
const Archive = require('../research/web-archive.js');
const FetchGate = require('../services/fetch-gate.js');

const RANGE = { url: 'https://www.allbirds.com/products.json', from: '2024-01-01', to: '2024-12-31', limit: 5 };

function withSafeRequest(fn) {
  const orig = Net.safeRequest;
  Net.safeRequest = fn;
  return () => { Net.safeRequest = orig; };
}

test('A1 代理隧道失败（ERR_PROXY_TUNNEL / 502）→ unreachable，不是 internal', async () => {
  const restore = withSafeRequest(async () => {
    const e = new Error('Failed to establish tunnel to web.archive.org:443 via http://127.0.0.1:53320: HTTP/1.1 502 Bad Gateway');
    e.code = 'ERR_PROXY_TUNNEL';
    throw e;
  });
  try {
    const r = await Archive.discoverSnapshots(RANGE);
    assert.equal(r.ok, false);
    assert.equal(r.failureClass, 'unreachable', '代理隧道失败必须归 unreachable');
  } finally { restore(); }
});

test('A2 连接超时 → unreachable', async () => {
  const restore = withSafeRequest(async () => { const e = new Error('connect ETIMEDOUT 69.171.229.73:443'); e.code = 'ETIMEDOUT'; throw e; });
  try {
    const r = await Archive.discoverSnapshots(RANGE);
    assert.equal(r.failureClass, 'unreachable');
  } finally { restore(); }
});

test('A3 DNS 失败（污染/无记录）→ unreachable', async () => {
  const restore = withSafeRequest(async () => { const e = new Error('getaddrinfo ENOTFOUND web.archive.org'); e.code = 'ENOTFOUND'; throw e; });
  try {
    const r = await Archive.discoverSnapshots(RANGE);
    assert.equal(r.failureClass, 'unreachable');
  } finally { restore(); }
});

test('A4 本地设施故障（非网络错误）仍归 internal，不冒充来源不可用', async () => {
  const restore = withSafeRequest(async () => { throw new Error('ENOSPC: no space left on device, write'); });
  try {
    const r = await Archive.discoverSnapshots(RANGE);
    assert.equal(r.failureClass, 'internal', '本地磁盘故障不得写成来源不可用');
  } finally { restore(); }
});

test('A5 SSRF 阻断仍归 blocked（安全边界不因分类调整而放宽）', async () => {
  const restore = withSafeRequest(async () => { throw new Error('SSRF_BLOCKED:private_dns_connect:web.archive.org'); });
  try {
    const r = await Archive.discoverSnapshots(RANGE);
    assert.equal(r.failureClass, 'blocked');
  } finally { restore(); }
});

test('A6 robots 拒绝 → blocked（不作数据抓取）', async () => {
  FetchGate.resetForTest(); // 前序用例的失败记录会触发熔断，先重置
  const orig = FetchGate.robotsAllows;
  FetchGate.robotsAllows = async () => false;
  try {
    const r = await Archive.discoverSnapshots(RANGE);
    assert.equal(r.failureClass, 'blocked');
  } finally { FetchGate.robotsAllows = orig; }
});

test('A7 真实 CDX 成功响应解析（受控 fixture：固定 CDX JSON，不联网）', async () => {
  FetchGate.resetForTest();
  const restore = withSafeRequest(async () => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    buffer: Buffer.from(JSON.stringify([
      ['timestamp', 'original', 'statuscode', 'digest'],
      ['20240315120000', 'https://www.allbirds.com/products.json', '200', 'ABCDEF'],
      ['20240820120000', 'https://www.allbirds.com/products.json', '200', '123456'],
    ])),
  }));
  try {
    const r = await Archive.discoverSnapshots(RANGE);
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0].iso, '2024-03-15T00:00:00.000Z', '存档时间精度到日');
    assert.equal(Archive.archiveTimestampToIso('20240315'), '2024-03-15T00:00:00.000Z');
  } finally { restore(); }
});
