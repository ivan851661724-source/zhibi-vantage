'use strict';
// M4 任务 A 红线回归：Canonical 身份存储与版本化映射层。
// 规格依据：docs/spec/00_Engineering_Baseline_v1.2.md §52–53、
// docs/spec/plans/2026-10-18_M4_身份_复用_账本.md 任务 A。
// 零外呼：自建临时 ZB_DATA_DIR（并断言 DATA 落点），unset MT_STORE_PATH/OBS_DB_PATH，
// 禁用全局 fetch。红相仅为 MODULE_NOT_FOUND（2026-10-18 独立复审 I-1 如实更正：
// 可复核的首轮红相证据未留存）；绿测对红线的有效性经复审 7/7 突变注入验证
// （brand_id 派生、resolved 合同放空、merge 守卫移除、投影失败吞掉、版本放开、
// 三态放开、私有字段展开均被本套捕获）。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// 公开投影字段白名单（M2 合同字段 + 公开元数据）。任何 workspace 私有字段
//（用户输入、备注、优先级、关系等）出现在存储记录/投影文件中即为失败。
const PUBLIC_FIELDS = ['schema_version', 'brand_id', 'identity_status', 'identity_version', 'canonical_name', 'aliases', 'official_domains', 'category_context', 'market', 'created_at', 'updated_at'];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-canonical-'));
  process.env.ZB_DATA_DIR = dir;
  delete process.env.MT_STORE_PATH;
  delete process.env.OBS_DB_PATH;
  global.fetch = () => { throw new Error('network forbidden'); };
  // core/paths 的 DATA 在进程内首次加载即固定（同 monitoring-store.test.js 的做法），
  // 因此除首个"默认 DATA 落点"用例外，各用例显式传 dataDir 实现隔离。
  const { createCanonicalIdentityService } = require('../services/canonical-identity');
  const service = createCanonicalIdentityService({ dataDir: dir });
  const resolved = overrides => ({
    identityStatus: 'resolved', identityVersion: 'v1', canonicalName: 'Example Brand',
    aliases: ['Example'], officialDomains: ['Example.com'], categoryContext: 'shoes', market: 'US', now: 1, ...overrides,
  });
  const brandsDir = () => path.join(dir, 'brands');
  const projection = brandId => JSON.parse(fs.readFileSync(path.join(brandsDir(), brandId + '.json'), 'utf8'));
  return { dir, service, resolved, brandsDir, projection, cleanup() { this.service.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// 首个用例：唯一依赖默认路径解析的用例（此后 core/paths 的 DATA 被进程内缓存）。
// 断言默认 DATA 落点：无 dataDir 参数时服务写入 ZB_DATA_DIR 指向的 DATA/canonical.db 与 DATA/brands/。
test('默认 DATA 落点：无 dataDir 参数时新库与投影均落在 ZB_DATA_DIR 之下', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-canonical-data-'));
  process.env.ZB_DATA_DIR = dir;
  delete process.env.MT_STORE_PATH;
  delete process.env.OBS_DB_PATH;
  global.fetch = () => { throw new Error('network forbidden'); };
  const { createCanonicalIdentityService } = require('../services/canonical-identity');
  const service = createCanonicalIdentityService();
  try {
    const a = service.createIdentity({ identityStatus: 'resolved', identityVersion: 'v1', canonicalName: 'Data Dir', officialDomains: ['example.com'], now: 1 });
    assert.equal(fs.existsSync(path.join(dir, 'canonical.db')), true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'brands', a.brand_id + '.json'), 'utf8')).brand_id, a.brand_id);
    assert.equal(service.getIdentity(a.brand_id).identity_status, 'resolved');
  } finally { service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('brand_id 为随机稳定 ID：两次创建互不相同、不从 name/URL 文本派生、不合并不强并', () => {
  const f = fixture(); try {
    const a = f.service.createIdentity(f.resolved({ canonicalName: 'Alpha', officialDomains: ['alpha.example'] }));
    const b = f.service.createIdentity(f.resolved({ canonicalName: 'Alpha', officialDomains: ['alpha.example'] }));
    assert.notEqual(a.brand_id, b.brand_id);
    assert.match(a.brand_id, /^brand_[0-9a-f-]{36}$/);
    assert.ok(!a.brand_id.includes('alpha'));
    assert.equal(f.service.listIdentities().total, 2);
  } finally { f.cleanup(); }
});

test('identity_status 三态之外的取值拒绝且不落库', () => {
  const f = fixture(); try {
    for (const status of ['active', 'RESOLVED', 'merged', '', null, 7]) {
      assert.throws(() => f.service.createIdentity(f.resolved({ identityStatus: status })), { status: 400 }, String(status));
    }
    assert.throws(() => f.service.createIdentity(f.resolved({ identityStatus: undefined })), { status: 400 });
    assert.equal(f.service.listIdentities().total, 0);
  } finally { f.cleanup(); }
});

test('resolved 缺 official_domains 或 canonical_name 拒绝且无任何写入（未提供完整输入不得写 resolved）', () => {
  const f = fixture(); try {
    for (const patch of [
      { officialDomains: undefined }, { officialDomains: null }, { officialDomains: [] },
      { officialDomains: 'example.com' }, { officialDomains: [''] }, { officialDomains: [null] },
      { canonicalName: '' }, { canonicalName: '   ' }, { canonicalName: undefined },
    ]) {
      assert.throws(() => f.service.createIdentity(f.resolved(patch)), { status: 400 }, JSON.stringify(patch));
    }
    assert.equal(f.service.listIdentities().total, 0);
    assert.deepEqual(fs.readdirSync(f.brandsDir()), []);
  } finally { f.cleanup(); }
});

test('unresolved 可缺证创建；投影仅含公开字段；私有输入字段与未知字段被拒绝', () => {
  const f = fixture(); try {
    const u = f.service.createIdentity({ identityStatus: 'unresolved', identityVersion: 'v1', now: 1 });
    assert.equal(u.identity_status, 'unresolved');
    assert.equal(u.canonical_name, null);
    assert.equal(u.official_domains, null);
    const file = f.projection(u.brand_id);
    assert.deepEqual(Object.keys(file).sort(), [...PUBLIC_FIELDS].sort());
    assert.equal(file.schema_version, 1);
    assert.equal(file.brand_id, u.brand_id);
    assert.ok(typeof file.identity_version === 'string' && file.identity_version.length > 0);
    for (const key of Object.keys(f.service.getIdentity(u.brand_id))) assert.ok(PUBLIC_FIELDS.includes(key), key);
    assert.throws(() => f.service.createIdentity({ identityStatus: 'unresolved', identityVersion: 'v1', tenantId: 't1', userNote: 'x', priority: 1 }), { status: 400 });
    assert.throws(() => f.service.updateIdentity({ brandId: u.brand_id, identityVersion: 'v2', userPriority: 'high' }), { status: 400 });
  } finally { f.cleanup(); }
});

test('unresolved→resolved 需补齐合同字段；版本只追加；降级拒绝；投影被 M2 brand 校验接受', () => {
  const f = fixture(); try {
    const u = f.service.createIdentity({ identityStatus: 'unresolved', identityVersion: 'v1', now: 1 });
    assert.throws(() => f.service.updateIdentity({ brandId: u.brand_id, identityStatus: 'resolved', identityVersion: 'v2' }), { status: 400 });
    const r = f.service.updateIdentity({ brandId: u.brand_id, identityStatus: 'resolved', identityVersion: 'v2', canonicalName: 'Example Brand', officialDomains: ['Example.COM'], now: 2 });
    assert.equal(r.identity_status, 'resolved');
    assert.deepEqual(r.official_domains, ['example.com']);
    assert.equal(r.identity_version, 'v2');
    assert.deepEqual(f.service.listIdentityVersions(u.brand_id).map(v => v.identity_version), ['v1', 'v2']);
    for (const status of ['conflicted', 'unresolved']) {
      assert.throws(() => f.service.updateIdentity({ brandId: u.brand_id, identityStatus: status, identityVersion: 'v3' }), { status: 409 }, status);
    }
    // monitoring-contracts.js admission 的 brand 校验段（M2 只读集成合同）等价断言。
    const { nonempty } = require('../services/monitoring-contracts');
    const brand = f.projection(u.brand_id);
    assert.equal(brand.schema_version === 1 && brand.brand_id === u.brand_id && brand.identity_status === 'resolved'
      && nonempty(brand.identity_version) && Array.isArray(brand.official_domains) && brand.official_domains.includes('example.com'), true);
  } finally { f.cleanup(); }
});

test('同 brand_id 内容冲突拒绝不覆盖：改名、集合缩减、版本号复用均拒绝；超集扩展成功', () => {
  const f = fixture(); try {
    const a = f.service.createIdentity(f.resolved());
    const before = JSON.stringify(f.service.getIdentity(a.brand_id));
    assert.throws(() => f.service.updateIdentity({ brandId: a.brand_id, identityVersion: 'v2', canonicalName: 'Other Name', now: 2 }), { status: 409 });
    assert.throws(() => f.service.updateIdentity({ brandId: a.brand_id, identityVersion: 'v2', officialDomains: ['other.example'], now: 2 }), { status: 409 });
    assert.throws(() => f.service.updateIdentity({ brandId: a.brand_id, identityVersion: 'v1', aliases: ['Example', 'EB'], now: 2 }), { status: 409 });
    assert.equal(JSON.stringify(f.service.getIdentity(a.brand_id)), before);
    const after = f.service.updateIdentity({ brandId: a.brand_id, identityVersion: 'v2', aliases: ['Example', 'EB'], officialDomains: ['example.com', 'example.net'], now: 2 });
    assert.deepEqual(after.aliases, ['Example', 'EB']);
    assert.deepEqual(after.official_domains, ['example.com', 'example.net']);
    assert.equal(f.service.listIdentityVersions(a.brand_id).length, 2);
    const stored = f.service.getIdentity(a.brand_id);
    assert.equal(stored.canonical_name, 'Example Brand');
    assert.equal(stored.created_at, 1);
    // 无内容变化不产生新版本。
    assert.equal(f.service.updateIdentity({ brandId: a.brand_id }).identity_version, 'v2');
    assert.equal(f.service.listIdentityVersions(a.brand_id).length, 2);
  } finally { f.cleanup(); }
});

test('merge/split 只登记显式映射决策：缺字段拒绝、unresolved/conflicted 不被强并、旧记录与历史不被重写', () => {
  const f = fixture(); try {
    const a = f.service.createIdentity(f.resolved({ canonicalName: 'A', officialDomains: ['a.example'], now: 1 }));
    const b = f.service.createIdentity(f.resolved({ canonicalName: 'B', officialDomains: ['b.example'], now: 1 }));
    const base = { fromBrandId: a.brand_id, toBrandId: b.brand_id, reason: 'duplicate identity', algorithmVersion: 'algo-1', computedAt: '2026-10-18T00:00:00Z' };
    for (const key of ['fromBrandId', 'toBrandId', 'reason', 'algorithmVersion', 'computedAt']) {
      assert.throws(() => f.service.recordMerge({ ...base, [key]: undefined }), { status: 400 }, key);
    }
    assert.throws(() => f.service.recordMerge({ ...base, fromBrandId: 'brand_missing' }), { status: 404 });
    const u = f.service.createIdentity({ identityStatus: 'unresolved', identityVersion: 'v1', now: 1 });
    assert.throws(() => f.service.recordMerge({ ...base, fromBrandId: u.brand_id, reason: 'guess' }), { status: 409 });
    const beforeA = f.service.getIdentity(a.brand_id), versionsA = f.service.listIdentityVersions(a.brand_id);
    const m = f.service.recordMerge(base);
    assert.equal(m.mapping_type, 'merge');
    assert.deepEqual(f.service.getIdentity(a.brand_id), beforeA);
    assert.deepEqual(f.service.listIdentityVersions(a.brand_id), versionsA);
    assert.equal(f.service.listMappings().total, 1);
    // 相同决策重放幂等，不产生重复行。
    const replay = f.service.recordMerge(base);
    assert.equal(replay.mapping_id, m.mapping_id);
    assert.equal(f.service.listMappings().total, 1);
    // split：缺字段/空 parts/自映射/重复 part/不存在端点均拒绝。
    const p1 = f.service.createIdentity({ identityStatus: 'unresolved', identityVersion: 'v1', now: 3 });
    const split = { brandId: b.brand_id, parts: [{ brandId: p1.brand_id, reason: 'distinct sub-brand' }], algorithmVersion: 'algo-1', computedAt: '2026-10-18T01:00:00Z' };
    for (const parts of [[], undefined, [{ brandId: p1.brand_id }], [{ reason: 'no id' }], [{ brandId: b.brand_id, reason: 'self' }],
      [{ brandId: p1.brand_id, reason: 'x' }, { brandId: p1.brand_id, reason: 'y' }]]) {
      assert.throws(() => f.service.recordSplit({ ...split, parts }), e => e.status === 400, JSON.stringify(parts));
    }
    assert.throws(() => f.service.recordSplit({ ...split, parts: [{ brandId: 'brand_missing', reason: 'x' }] }), { status: 404 });
    const s = f.service.recordSplit(split);
    assert.equal(s.length, 1);
    assert.equal(f.service.listMappings().total, 2);
    // split 不修改、不重写既有身份记录及其历史。
    assert.equal(f.service.getIdentity(b.brand_id).identity_version, 'v1');
    assert.equal(f.service.listIdentityVersions(b.brand_id).length, 1);
    assert.deepEqual(f.service.listMappings().mappings.map(x => x.mapping_type), ['merge', 'split']);
  } finally { f.cleanup(); }
});

test('未知未来 schema 版本拒绝安装且不删旧表旧数据', () => {
  const f = fixture(); try {
    const id = f.service.createIdentity(f.resolved()).brand_id;
    f.service.close();
    const { DatabaseSync } = require('node:sqlite');
    const dbPath = path.join(f.dir, 'canonical.db');
    const raw = new DatabaseSync(dbPath);
    raw.exec("CREATE TABLE IF NOT EXISTS legacy_note(note TEXT); INSERT INTO legacy_note VALUES('keep'); PRAGMA user_version=2;");
    raw.close();
    const { createCanonicalIdentityService } = require('../services/canonical-identity');
    assert.throws(() => createCanonicalIdentityService({ dataDir: f.dir }), { code: 'UNSUPPORTED_CANONICAL_SCHEMA' });
    const reset = new DatabaseSync(dbPath);
    assert.equal(reset.prepare('PRAGMA user_version').get().user_version, 2);
    reset.exec('PRAGMA user_version=1;');
    reset.close();
    const again = createCanonicalIdentityService({ dataDir: f.dir });
    assert.equal(again.getIdentity(id).brand_id, id);
    const legacy = new DatabaseSync(dbPath);
    assert.equal(legacy.prepare('SELECT note FROM legacy_note').get().note, 'keep');
    legacy.close();
    again.close();
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('文件投影失败向上抛出不静默；DB 已提交与投影缺失的跨存储缺口如实保留', () => {
  const f = fixture(); try {
    const a = f.service.createIdentity(f.resolved());
    fs.rmSync(path.join(f.brandsDir(), a.brand_id + '.json'));
    fs.mkdirSync(path.join(f.brandsDir(), a.brand_id + '.json')); // 占位目录使 rename 失败
    assert.throws(() => f.service.updateIdentity({ brandId: a.brand_id, identityVersion: 'v2', aliases: ['Example', 'X'], now: 2 }), { code: 'CANONICAL_PROJECTION_WRITE_FAILED' });
    // 已知缺口：DB 先提交、投影后写，文件失败时两侧不一致；消费方按 M2 对缺失文件 fail-closed。
    assert.equal(f.service.getIdentity(a.brand_id).identity_version, 'v2');
  } finally { f.cleanup(); }
});

test('list 只读且分页参数有界；非法/缺失 brand_id 安全拒绝', () => {
  const f = fixture(); try {
    f.service.createIdentity(f.resolved());
    f.service.createIdentity(f.resolved({ canonicalName: 'Second', officialDomains: ['s.example'], now: 2 }));
    const page = f.service.listIdentities({ offset: 1, limit: 1 });
    assert.equal(page.total, 2);
    assert.equal(page.identities.length, 1);
    for (const query of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { offset: 1.5 }]) {
      assert.throws(() => f.service.listIdentities(query), { status: 400 }, JSON.stringify(query));
      assert.throws(() => f.service.listMappings(query), { status: 400 }, JSON.stringify(query));
    }
    assert.equal(f.service.getIdentity('brand_missing'), null);
    assert.equal(f.service.getIdentity('../escape'), null);
    assert.throws(() => f.service.updateIdentity({ brandId: '../escape', identityVersion: 'v9' }), { status: 400 });
    assert.throws(() => f.service.updateIdentity({ brandId: 'brand_missing', identityVersion: 'v9' }), { status: 404 });
  } finally { f.cleanup(); }
});
