'use strict';
// M4 任务 B 红线回归：公共事实复用判定与隔离。
// 规格依据：docs/spec/02_Data_Algorithm_Spec_v0.3.md §24（复用判定六元组）、
// docs/spec/00_Engineering_Baseline_v1.2.md §52（Canonical 只含公开事实）、
// docs/spec/plans/2026-10-18_M4_身份_复用_账本.md 任务 B。
// 零外呼：自建临时 ZB_DATA_DIR（并断言判定零文件写入），unset MT_STORE_PATH/OBS_DB_PATH，
// 禁用全局 fetch；身份层使用真实任务 A 服务实例（canonical-identity.js，只读消费）。
// 红相：canonical-reuse 模块未建时本套以 MODULE_NOT_FOUND 失败（2026-10-18 实测）。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createCanonicalReuseService } = require('../services/canonical-reuse');

// 六元组（02 §24 顺序）：输入键 → 稳定原因码（缺失 / 非法）。
const DIMENSIONS = [
  ['brandId', 'missing_brand_id', 'invalid_brand_id'],
  ['market', 'missing_market', 'invalid_market'],
  ['capability', 'missing_capability', 'invalid_capability'],
  ['entityScope', 'missing_entity_scope', 'invalid_entity_scope'],
  ['freshnessBucket', 'missing_freshness_bucket', 'invalid_freshness_bucket'],
  ['policyVersion', 'missing_policy_version', 'invalid_policy_version'],
];
const ALL_MISSING = DIMENSIONS.map(d => d[1]);

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-canonical-reuse-'));
  process.env.ZB_DATA_DIR = dir;
  delete process.env.MT_STORE_PATH;
  delete process.env.OBS_DB_PATH;
  global.fetch = () => { throw new Error('network forbidden'); };
  const { createCanonicalIdentityService } = require('../services/canonical-identity');
  const identities = createCanonicalIdentityService({ dataDir: dir });
  const reuse = createCanonicalReuseService({ identities });
  // 真实任务 A 实例建三种冻结状态身份；brand_id 由任务 A 随机生成，判定输入
  // 只引用其 ID，不携带任何其他身份字段。
  const resolved = identities.createIdentity({ identityStatus: 'resolved', identityVersion: 'v1', canonicalName: 'Example Brand', aliases: ['Example'], officialDomains: ['example.com'], market: 'US', now: 1 });
  const unresolved = identities.createIdentity({ identityStatus: 'unresolved', identityVersion: 'v1', now: 1 });
  const conflicted = identities.createIdentity({ identityStatus: 'conflicted', identityVersion: 'v1', now: 1 });
  const ok = () => ({
    brandId: resolved.brand_id, market: 'US', capability: 'product_catalog',
    entityScope: 'domain:example.com', freshnessBucket: '24h', policyVersion: 'cp-test-1',
  });
  return {
    dir, identities, reuse, ok,
    resolvedBrandId: resolved.brand_id, unresolvedBrandId: unresolved.brand_id, conflictedBrandId: conflicted.brand_id,
    cleanup() { identities.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

// 判定零写入断言：全树逐字节比对。SQLite WAL 的 -shm/-wal 读标记字节可能因
// 身份查询（读取行为副产物）变化，内容比对豁免，但路径集合仍须完全不变。
function treeSnapshot(root) {
  const out = {};
  (function walk(dir, rel) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const key = rel ? rel + '/' + entry.name : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs, key); continue; }
      const volatile = entry.name.endsWith('-shm') || entry.name.endsWith('-wal');
      out[key] = volatile ? 'volatile' : fs.statSync(abs).size + ':' + crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    }
  })(root, '');
  return out;
}

test('工厂守卫：identities 缺失或非任务 A 服务实例拒绝构建；未知工厂选项拒绝', () => {
  for (const bad of [undefined, null, {}, { identities: null }, { identities: {} }, { identities: { getIdentity: 'x' } }, { identities: [] }]) {
    assert.throws(() => createCanonicalReuseService(bad), { code: 'MISSING_IDENTITY_SERVICE' }, JSON.stringify(Object.keys(bad || {})));
  }
  const f = fixture(); try {
    assert.throws(() => createCanonicalReuseService({ identities: f.identities, dataDir: f.dir }), { code: 'UNKNOWN_FACTORY_OPTION' });
  } finally { f.cleanup(); }
});

test('resolved + 六元组齐备 → 可复用；结果仅含 reusable/reasons，不携带身份与来源痕迹', () => {
  const f = fixture(); try {
    const r = f.reuse.evaluateReuse(f.ok());
    assert.deepEqual(Object.keys(r), ['reusable', 'reasons']);
    assert.equal(r.reusable, true);
    assert.deepEqual(r.reasons, []);
    const s = JSON.stringify(r);
    for (const trace of ['Example', 'example.com', f.resolvedBrandId, 'identity_version', 'workspace', 'tenant']) {
      assert.ok(!s.includes(trace), trace);
    }
  } finally { f.cleanup(); }
});

test('逐维度缺失（undefined/null/空串/纯空白）各自产生稳定 missing_ 原因码', () => {
  const f = fixture(); try {
    for (const [key, missing] of DIMENSIONS) {
      for (const value of [undefined, null, '', '   ']) {
        const r = f.reuse.evaluateReuse({ ...f.ok(), [key]: value });
        assert.deepEqual(r, { reusable: false, reasons: [missing] }, key + '=' + JSON.stringify(value));
      }
    }
    // 全缺失：六个原因码按 02 §24 六元组顺序齐出。
    assert.deepEqual(f.reuse.evaluateReuse({}).reasons, ALL_MISSING);
    // 维度不齐即拒绝，不查身份：brandId 缺失只有 missing_brand_id，无 identity_not_found。
    assert.deepEqual(f.reuse.evaluateReuse({ ...f.ok(), brandId: undefined }), { reusable: false, reasons: ['missing_brand_id'] });
  } finally { f.cleanup(); }
});

test('逐维度非法类型/形态产生 invalid_ 原因码；未知 freshnessBucket/policyVersion 不得默认放行', () => {
  const f = fixture(); try {
    for (const [key, , invalid] of DIMENSIONS) {
      for (const value of [42, 3.14, true, {}, ['x'], () => {}]) {
        assert.deepEqual(f.reuse.evaluateReuse({ ...f.ok(), [key]: value }), { reusable: false, reasons: [invalid] }, key + '=' + String(value));
      }
    }
    // 自由文本维度（market/capability/entity_scope）：控制字符、首尾空白、超界拒绝。
    for (const key of ['market', 'capability', 'entityScope']) {
      const invalid = 'invalid_' + key.replace(/([A-Z])/g, m => '_' + m.toLowerCase());
      for (const value of ['\u0007bell', ' lead', 'trail ', 'a'.repeat(129)]) {
        assert.deepEqual(f.reuse.evaluateReuse({ ...f.ok(), [key]: value }), { reusable: false, reasons: [invalid] }, key + '=' + JSON.stringify(value));
      }
    }
    // freshness/policy 词元维度：版本/档位词形之外的未知取值一律拒绝（本层不发明
    // 枚举，也绝不默认放行）；仅词形可识别的取值放行进入身份层判定。
    for (const key of ['freshnessBucket', 'policyVersion']) {
      const invalid = 'invalid_' + key.replace(/([A-Z])/g, m => '_' + m.toLowerCase());
      for (const value of ['24 h', 'latest!', '../day', 'v1;drop', '中文档位', 'a'.repeat(65), 'x y']) {
        assert.deepEqual(f.reuse.evaluateReuse({ ...f.ok(), [key]: value }), { reusable: false, reasons: [invalid] }, key + '=' + JSON.stringify(value));
      }
      for (const value of ['24h', 'v1.2', 'cp-2026:beta']) {
        assert.equal(f.reuse.evaluateReuse({ ...f.ok(), [key]: value }).reusable, true, key + '=' + value);
      }
    }
  } finally { f.cleanup(); }
});

test('身份不存在 / unresolved / conflicted 一律不可复用；非法 brand_id 在词法层拒绝', () => {
  const f = fixture(); try {
    assert.deepEqual(f.reuse.evaluateReuse({ ...f.ok(), brandId: 'brand_00000000-0000-0000-0000-00000000dead' }),
      { reusable: false, reasons: ['identity_not_found'] });
    assert.deepEqual(f.reuse.evaluateReuse({ ...f.ok(), brandId: f.unresolvedBrandId }),
      { reusable: false, reasons: ['identity_not_resolved'] });
    assert.deepEqual(f.reuse.evaluateReuse({ ...f.ok(), brandId: f.conflictedBrandId }),
      { reusable: false, reasons: ['identity_not_resolved'] });
    for (const bad of ['../escape', 'brand_x..y', 'brand ok', '.hidden']) {
      assert.deepEqual(f.reuse.evaluateReuse({ ...f.ok(), brandId: bad }), { reusable: false, reasons: ['invalid_brand_id'] }, bad);
    }
  } finally { f.cleanup(); }
});

test('整体非法输入全量拒绝且不抛错；额外私有输入字段拒绝且值不外泄', () => {
  const f = fixture(); try {
    for (const bad of [null, undefined, 0, -1, '', 'x', true, [], ['a'], () => {}, new Date(0)]) {
      assert.deepEqual(f.reuse.evaluateReuse(bad), { reusable: false, reasons: ALL_MISSING }, String(bad));
    }
    // 白名单外字段（租户/工作区私有字段）直接拒绝；结论中无字段名、无字段值。
    const r = f.reuse.evaluateReuse({ ...f.ok(), tenantId: 'tenant-secret-1', workspaceId: 'ws-9', priority: 9, now: 123 });
    assert.deepEqual(r, { reusable: false, reasons: ['unknown_input_field'] });
    const s = JSON.stringify(r);
    for (const trace of ['tenant-secret-1', 'ws-9', 'priority', 'tenantId', 'workspaceId']) assert.ok(!s.includes(trace), trace);
  } finally { f.cleanup(); }
});

test('无缓存、无输入/结果别名：同输入重复判定一致且为全新结论；结论随身份实况更新', () => {
  const f = fixture(); try {
    const input = f.ok();
    const r1 = f.reuse.evaluateReuse(input);
    assert.deepEqual(r1, { reusable: true, reasons: [] });
    r1.reasons.push('mutated'); // 污染旧结论，证明无共享引用
    const r2 = f.reuse.evaluateReuse(input);
    assert.deepEqual(r2, { reusable: true, reasons: [] });
    input.market = 42; // 调用后改输入不得影响已产生的结论
    assert.deepEqual(f.reuse.evaluateReuse(input), { reusable: false, reasons: ['invalid_market'] });
    assert.deepEqual(r2, { reusable: true, reasons: [] });
    // 无缓存：身份实况变化反映到后续判定（unresolved → resolved）。
    const late = f.identities.createIdentity({ identityStatus: 'unresolved', identityVersion: 'v1', now: 2 });
    const withLate = { ...f.ok(), brandId: late.brand_id };
    assert.deepEqual(f.reuse.evaluateReuse(withLate), { reusable: false, reasons: ['identity_not_resolved'] });
    f.identities.updateIdentity({ brandId: late.brand_id, identityStatus: 'resolved', identityVersion: 'v2', canonicalName: 'Late Brand', officialDomains: ['late.example'], now: 3 });
    assert.deepEqual(f.reuse.evaluateReuse(withLate), { reusable: true, reasons: [] });
  } finally { f.cleanup(); }
});

test('跨租户/跨工作区隔离：独立身份库同一六元组结论一致，结果不含任何来源痕迹', () => {
  const f = fixture();
  const second = fixture(); // 独立临时目录、独立身份库、不同随机 brand_id
  try {
    assert.notEqual(f.ok().brandId, second.ok().brandId);
    const a = f.reuse.evaluateReuse(f.ok());
    const b = second.reuse.evaluateReuse(second.ok());
    assert.deepEqual(a, b); // 同一公开结论，与哪个库/哪个 workspace 无关
    const cross = second.reuse.evaluateReuse({ ...second.ok(), brandId: f.ok().brandId });
    assert.deepEqual(cross, { reusable: false, reasons: ['identity_not_found'] });
    for (const r of [a, b, cross]) {
      assert.deepEqual(Object.keys(r), ['reusable', 'reasons']);
      for (const brandId of [f.ok().brandId, second.ok().brandId]) assert.ok(!JSON.stringify(r).includes(brandId));
    }
  } finally { f.cleanup(); second.cleanup(); }
});

test('判定零文件写入：批量判定前后数据目录树逐字节一致', () => {
  const f = fixture(); try {
    const before = treeSnapshot(f.dir);
    const batch = [
      f.ok(), {}, null, 42,
      { ...f.ok(), brandId: 'brand_00000000-0000-0000-0000-00000000dead' },
      { ...f.ok(), brandId: f.unresolvedBrandId },
      { ...f.ok(), brandId: f.conflictedBrandId },
      { ...f.ok(), tenantId: 't-1', freshnessBucket: 'no such' },
      { brandId: f.resolvedBrandId },
    ];
    for (const input of batch) assert.equal(typeof f.reuse.evaluateReuse(input).reusable, 'boolean');
    assert.deepEqual(treeSnapshot(f.dir), before);
  } finally { f.cleanup(); }
});
