'use strict';
// ============================================================
// services/canonical-identity.js —— M4 任务 A：Canonical 身份存储与版本化映射层
//
// 规格依据（冻结范围，见 docs/spec/plans/2026-10-18_M4_身份_复用_账本.md 任务 A）：
//   - 00_Engineering_Baseline_v1.2.md §52：Canonical 层只存公开品牌事实；
//     workspace 私有关系、用户输入、备注、优先级一律不得进入本存储/接口面。
//   - 00_Engineering_Baseline_v1.2.md §53：identity_status 冻结为
//     resolved/unresolved/conflicted 三态；稳定 brand_id 不得从 name/URL 文本
//     派生；merge/split 必须留下可审计映射与版本；unresolved 不得强行合并。
//   - 文件投影为 M2 只读集成格式 DATA/brands/<brand_id>.json，其 brand 校验段
//     见 app/services/monitoring-contracts.js admission。
//
// 本模块只提供显式存储/版本/映射原语：身份匹配算法、合并触发政策均未决，
// 不在本层实现，也不从旧研究数据自动生成身份（SCP-02 仍开放）。
//
// 已知缺口（如实声明，不承诺跨存储事务）：SQLite 与文件系统无法原子提交。
// 顺序为先提交 DB、后写投影文件；文件写失败向上抛出（不吞掉），此时 DB 已
// 提交而投影缺失/滞后。消费方按 M2 合同对缺失文件 fail-closed；修复靠后续
// 显式更新重写投影，不做自动后台重试。
//
// 状态演进只允许同级扩展或向更完整方向（unresolved < conflicted < resolved，
// 次序仅为拒绝降级的实现约定，不新增业务状态）。任何 narrowing（改名、缩减
// 集合、降级）一律拒绝：纠错/撤回必须走显式可审计流程，不静默覆盖（数据真
// 值规则）。已用版本号+无内容变化按幂等原样返回；resolved→conflicted 等
// 降级通道（07 §20 correction）尚未建立，已按规格冲突登记为 M4 开放问题，
// 未经批准不在本层自行放行。
// ============================================================
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { isAsyncFunction } = require('node:util').types;
const { isSafeId, isWithinDir } = require('../core/safe-id');

const SCHEMA_VERSION = 1;
const IDENTITY_STATUS = new Set(['resolved', 'unresolved', 'conflicted']);
const STATUS_RANK = { unresolved: 0, conflicted: 1, resolved: 2 };

function failure(code, status = 400, issues = [code]) { const e = new Error(code); Object.assign(e, { code, status, issues }); return e; }
const nonempty = v => typeof v === 'string' && !!v.trim();
const text = v => (nonempty(v) ? v.trim() : null);
const strings = xs => Array.isArray(xs) && xs.every(nonempty);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
// 与 monitoring-coverage 同构的稳定序列化，用于映射决策的确定性 mapping_id。
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

// 输入面白名单：清单之外的字段（含一切 workspace 私有字段）直接拒绝，
// 从接口面上保证 Canonical 存储不可能携带租户/用户私有数据。
const CREATE_FIELDS = ['identityStatus', 'identityVersion', 'canonicalName', 'aliases', 'officialDomains', 'categoryContext', 'market', 'now'];
const UPDATE_FIELDS = ['brandId', ...CREATE_FIELDS];
const MERGE_FIELDS = ['fromBrandId', 'toBrandId', 'reason', 'algorithmVersion', 'computedAt'];
const SPLIT_FIELDS = ['brandId', 'parts', 'algorithmVersion', 'computedAt'];

function createCanonicalIdentityService({ dataDir = require('../core/paths').DATA } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'canonical.db'));
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== 0 && version !== SCHEMA_VERSION) { db.close(); throw failure('UNSUPPORTED_CANONICAL_SCHEMA', 500); }
  let txDepth = 0;
  function transaction(fn) {
    if (isAsyncFunction(fn) || Object.prototype.toString.call(fn) === '[object AsyncFunction]') throw failure('ASYNC_TRANSACTION_FORBIDDEN');
    const nested = txDepth > 0, savepoint = 'canonical_nested_' + txDepth;
    db.exec(nested ? 'SAVEPOINT ' + savepoint : 'BEGIN IMMEDIATE'); txDepth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw failure('ASYNC_TRANSACTION_FORBIDDEN');
      db.exec(nested ? 'RELEASE SAVEPOINT ' + savepoint : 'COMMIT'); return result;
    } catch (error) {
      if (nested) { db.exec('ROLLBACK TO SAVEPOINT ' + savepoint); db.exec('RELEASE SAVEPOINT ' + savepoint); } else db.exec('ROLLBACK');
      throw error;
    } finally { txDepth--; }
  }
  // 事务安装：只 CREATE IF NOT EXISTS，未知未来版本在上方拒绝；旧表旧数据永不删除。
  transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS canonical_identities(brand_id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS identity_versions(seq INTEGER PRIMARY KEY AUTOINCREMENT, brand_id TEXT NOT NULL, identity_version TEXT NOT NULL, payload TEXT NOT NULL, recorded_at INTEGER NOT NULL, UNIQUE(brand_id, identity_version));
      CREATE INDEX IF NOT EXISTS identity_versions_brand ON identity_versions(brand_id, seq);
      CREATE TABLE IF NOT EXISTS identity_mappings(seq INTEGER PRIMARY KEY AUTOINCREMENT, mapping_id TEXT UNIQUE NOT NULL, mapping_type TEXT NOT NULL, from_brand_id TEXT NOT NULL, to_brand_id TEXT NOT NULL, reason TEXT NOT NULL, algorithm_version TEXT NOT NULL, computed_at TEXT NOT NULL, recorded_at INTEGER NOT NULL, payload TEXT NOT NULL);
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
  });
  const brandsDir = path.join(dataDir, 'brands');
  fs.mkdirSync(brandsDir, { recursive: true });

  function exactFields(input, allowed) {
    for (const key of Object.keys(input || {})) if (!allowed.includes(key)) throw failure('UNKNOWN_INPUT_FIELD', 400, [key]);
  }
  function requireNow(now) {
    if (now === undefined) return Date.now();
    if (!Number.isSafeInteger(now)) throw failure('INVALID_TIMESTAMP', 400);
    return now;
  }
  function requireText(value, code) { if (!nonempty(value)) throw failure(code, 400); return value.trim(); }
  function requireBrandId(value) {
    const brandId = requireText(value, 'INVALID_BRAND_ID');
    if (!isSafeId(brandId)) throw failure('INVALID_BRAND_ID', 400);
    return brandId;
  }
  function requireDate(value, code) {
    if (!nonempty(value) || !Number.isFinite(Date.parse(value))) throw failure(code, 400);
    return value.trim();
  }
  // 域名归一化为小写去重；不校验合法域名词法——词法坏项只会让 M2 消费端
  // 匹配失败（fail-closed），不会伪装成可匹配域名。
  function domainList(input) {
    if (input === undefined || input === null) return null;
    if (!strings(input)) throw failure('INVALID_OFFICIAL_DOMAINS', 400);
    return [...new Set(input.map(d => d.trim().toLowerCase()))];
  }
  function aliasList(input) {
    if (input === undefined || input === null) return null;
    if (!strings(input)) throw failure('INVALID_ALIASES', 400);
    return [...new Set(input.map(a => a.trim()))];
  }
  // resolved 冻结合同：canonical_name 非空 + official_domains 非空字符串数组。
  function requireResolvedContract(record) {
    if (record.identity_status === 'resolved' &&
        (!nonempty(record.canonical_name) || !Array.isArray(record.official_domains) || !record.official_domains.length)) {
      throw failure('RESOLVED_CONTRACT_INCOMPLETE', 400);
    }
    return record;
  }
  function insertVersion(brandId, record, now) {
    db.prepare('INSERT INTO canonical_identities(brand_id,payload) VALUES(?,?)').run(brandId, JSON.stringify(record));
    db.prepare('INSERT INTO identity_versions(brand_id,identity_version,payload,recorded_at) VALUES(?,?,?,?)').run(brandId, record.identity_version, JSON.stringify(record), now);
  }
  // 版本只追加：显式给出的版本号不得与该身份任何历史版本重复；缺省时自动
  // 递增并跳过已用号码。
  function nextVersion(brandId, requested) {
    if (requested !== undefined) {
      const v = requireText(requested, 'INVALID_IDENTITY_VERSION');
      if (db.prepare('SELECT 1 FROM identity_versions WHERE brand_id=? AND identity_version=?').get(brandId, v)) throw failure('IDENTITY_VERSION_CONFLICT', 409);
      return v;
    }
    let n = db.prepare('SELECT count(*) n FROM identity_versions WHERE brand_id=?').get(brandId).n + 1;
    while (db.prepare('SELECT 1 FROM identity_versions WHERE brand_id=? AND identity_version=?').get(brandId, 'v' + n)) n++;
    return 'v' + n;
  }
  function createIdentity(input) {
    exactFields(input, CREATE_FIELDS);
    if (!IDENTITY_STATUS.has(input.identityStatus)) throw failure('INVALID_IDENTITY_STATUS', 400);
    const now = requireNow(input.now);
    const identityVersion = requireText(input.identityVersion, 'INVALID_IDENTITY_VERSION');
    const record = requireResolvedContract({
      schema_version: SCHEMA_VERSION,
      brand_id: 'brand_' + crypto.randomUUID(), // 随机稳定 ID，绝不从名称/URL 文本派生（00 §53）
      identity_status: input.identityStatus,
      canonical_name: text(input.canonicalName),
      aliases: aliasList(input.aliases) || [],
      official_domains: domainList(input.officialDomains),
      category_context: text(input.categoryContext),
      market: text(input.market),
      identity_version: identityVersion,
      created_at: now,
      updated_at: now,
    });
    transaction(() => insertVersion(record.brand_id, record, now));
    project(record); // 文件失败向上抛（已知跨存储缺口，见文件头注释）
    return record;
  }
  // 显式扩展：只允许同级扩展或向更完整状态演进；内容冲突拒绝不覆盖。
  function updateIdentity(input) {
    exactFields(input, UPDATE_FIELDS);
    const brandId = requireBrandId(input.brandId);
    const now = requireNow(input.now);
    const current = getIdentity(brandId);
    if (!current) throw failure('IDENTITY_NOT_FOUND', 404);
    const next = { ...current };
    if (input.identityStatus !== undefined) {
      if (!IDENTITY_STATUS.has(input.identityStatus)) throw failure('INVALID_IDENTITY_STATUS', 400);
      if (STATUS_RANK[input.identityStatus] < STATUS_RANK[current.identity_status]) throw failure('IDENTITY_STATUS_REGRESSION', 409);
      next.identity_status = input.identityStatus;
    }
    const textFields = [['canonicalName', 'canonical_name', 'INVALID_CANONICAL_NAME'], ['categoryContext', 'category_context', 'INVALID_CATEGORY_CONTEXT'], ['market', 'market', 'INVALID_MARKET']];
    for (const [inputKey, field, code] of textFields) {
      if (input[inputKey] === undefined) continue;
      const value = text(input[inputKey]);
      if (!value) throw failure(code, 400);
      if (nonempty(current[field]) && current[field] !== value) throw failure('IDENTITY_CONTENT_CONFLICT', 409, [field]);
      next[field] = value;
    }
    // 集合型公开事实只允许追加（超集）；缺少既有项 = 缩减 = 冲突拒绝。
    if (input.aliases !== undefined) {
      const provided = aliasList(input.aliases);
      if (!provided) throw failure('INVALID_ALIASES', 400);
      if (current.aliases.some(a => !provided.includes(a))) throw failure('IDENTITY_CONTENT_CONFLICT', 409, ['aliases']);
      next.aliases = [...current.aliases, ...provided.filter(a => !current.aliases.includes(a))];
    }
    if (input.officialDomains !== undefined) {
      const provided = domainList(input.officialDomains);
      if (!provided) throw failure('INVALID_OFFICIAL_DOMAINS', 400);
      const existing = current.official_domains || [];
      if (existing.some(d => !provided.includes(d))) throw failure('IDENTITY_CONTENT_CONFLICT', 409, ['official_domains']);
      next.official_domains = [...existing, ...provided.filter(d => !existing.includes(d))];
    }
    requireResolvedContract(next);
    const changed = ['identity_status', 'canonical_name', 'aliases', 'official_domains', 'category_context', 'market']
      .some(field => JSON.stringify(next[field]) !== JSON.stringify(current[field]));
    if (!changed) return current; // 无内容变化不产生新版本
    const updated = { ...next, identity_version: nextVersion(brandId, input.identityVersion), updated_at: now };
    transaction(() => {
      db.prepare('UPDATE canonical_identities SET payload=? WHERE brand_id=?').run(JSON.stringify(updated), brandId);
      db.prepare('INSERT INTO identity_versions(brand_id,identity_version,payload,recorded_at) VALUES(?,?,?,?)').run(brandId, updated.identity_version, JSON.stringify(updated), now);
    });
    project(updated);
    return updated;
  }
  function insertMapping(decision) {
    const mappingId = 'map_' + sha256(canonicalJson(decision));
    const recordedAt = Date.now();
    const payload = { schema_version: SCHEMA_VERSION, mapping_id: mappingId, ...decision, recorded_at: recordedAt };
    // 相同决策重放幂等：append-only，不产生重复行，更不重写既有行。
    db.prepare('INSERT OR IGNORE INTO identity_mappings(mapping_id,mapping_type,from_brand_id,to_brand_id,reason,algorithm_version,computed_at,recorded_at,payload) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(mappingId, decision.mapping_type, decision.from_brand_id, decision.to_brand_id, decision.reason, decision.algorithm_version, decision.computed_at, recordedAt, JSON.stringify(payload));
    const row = db.prepare('SELECT payload FROM identity_mappings WHERE mapping_id=?').get(mappingId);
    return JSON.parse(row.payload);
  }
  // 只登记显式提供的映射决策，缺任一字段拒绝；两端身份必须已存在。
  function recordMerge(input) {
    exactFields(input, MERGE_FIELDS);
    const fromBrandId = requireBrandId(input.fromBrandId), toBrandId = requireBrandId(input.toBrandId);
    const reason = requireText(input.reason, 'INVALID_REASON');
    const algorithmVersion = requireText(input.algorithmVersion, 'INVALID_ALGORITHM_VERSION');
    const computedAt = requireDate(input.computedAt, 'INVALID_COMPUTED_AT');
    if (fromBrandId === toBrandId) throw failure('INVALID_MERGE_ENDPOINTS', 400);
    return transaction(() => {
      const from = getIdentity(fromBrandId), to = getIdentity(toBrandId);
      if (!from || !to) throw failure('IDENTITY_NOT_FOUND', 404);
      // 00 §53 规则1 + M4 验收：unresolved/conflicted 身份不得被强行合并。
      if (from.identity_status !== 'resolved' || to.identity_status !== 'resolved') throw failure('IDENTITY_NOT_RESOLVED', 409);
      return insertMapping({ mapping_type: 'merge', from_brand_id: fromBrandId, to_brand_id: toBrandId, reason, algorithm_version: algorithmVersion, computed_at: computedAt });
    });
  }
  // 拆分不主张同一性：parts 允许处于任意冻结状态（新拆出的品牌可暂为 unresolved）。
  function recordSplit(input) {
    exactFields(input, SPLIT_FIELDS);
    const brandId = requireBrandId(input.brandId);
    const algorithmVersion = requireText(input.algorithmVersion, 'INVALID_ALGORITHM_VERSION');
    const computedAt = requireDate(input.computedAt, 'INVALID_COMPUTED_AT');
    if (!Array.isArray(input.parts) || !input.parts.length) throw failure('INVALID_SPLIT_PARTS', 400);
    const parts = input.parts.map(part => {
      if (!part || typeof part !== 'object' || Array.isArray(part)) throw failure('INVALID_SPLIT_PARTS', 400);
      exactFields(part, ['brandId', 'reason']);
      return { brand_id: requireBrandId(part.brandId), reason: requireText(part.reason, 'INVALID_REASON') };
    });
    const partIds = new Set(parts.map(p => p.brand_id));
    if (partIds.size !== parts.length || partIds.has(brandId)) throw failure('INVALID_SPLIT_PARTS', 400);
    return transaction(() => {
      if (!getIdentity(brandId)) throw failure('IDENTITY_NOT_FOUND', 404);
      for (const part of parts) if (!getIdentity(part.brand_id)) throw failure('IDENTITY_NOT_FOUND', 404);
      return parts.map(part => insertMapping({
        mapping_type: 'split', from_brand_id: brandId, to_brand_id: part.brand_id, reason: part.reason,
        algorithm_version: algorithmVersion, computed_at: computedAt,
      }));
    });
  }
  // —— 只读面（全局层，无 tenantScope）——
  function getIdentity(brandId) {
    if (!isSafeId(brandId)) return null;
    const row = db.prepare('SELECT payload FROM canonical_identities WHERE brand_id=?').get(brandId);
    return row ? JSON.parse(row.payload) : null;
  }
  function listIdentityVersions(brandId) { // 00 §53 规则2：版本必须可审计
    if (!isSafeId(brandId)) return [];
    return db.prepare('SELECT payload FROM identity_versions WHERE brand_id=? ORDER BY seq').all(brandId).map(r => JSON.parse(r.payload));
  }
  function page({ offset = 0, limit = 50 } = {}) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure('INVALID_PAGINATION', 400);
    return { offset, limit };
  }
  function listIdentities(query) {
    const { offset, limit } = page(query);
    const total = db.prepare('SELECT count(*) n FROM canonical_identities').get().n;
    const identities = db.prepare('SELECT payload FROM canonical_identities ORDER BY rowid LIMIT ? OFFSET ?').all(limit, offset).map(r => JSON.parse(r.payload));
    return { identities, total, offset, limit };
  }
  function listMappings(query) {
    const { offset, limit } = page(query);
    const total = db.prepare('SELECT count(*) n FROM identity_mappings').get().n;
    const mappings = db.prepare('SELECT payload FROM identity_mappings ORDER BY seq LIMIT ? OFFSET ?').all(limit, offset).map(r => JSON.parse(r.payload));
    return { mappings, total, offset, limit };
  }
  // M2 只读集成投影：DATA/brands/<brand_id>.json，公开字段白名单，临时文件+改名。
  function project(record) {
    const file = path.join(brandsDir, record.brand_id + '.json');
    if (!isWithinDir(brandsDir, file)) throw failure('INVALID_BRAND_ID', 400);
    const tmp = file + '.tmp-' + crypto.randomUUID();
    try {
      fs.writeFileSync(tmp, JSON.stringify(record));
      fs.renameSync(tmp, file);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不掩盖上抛 */ }
      throw failure('CANONICAL_PROJECTION_WRITE_FAILED', 500, [error.code || String(error)]);
    }
  }
  function close() { if (db.isOpen) db.close(); }
  return { createIdentity, updateIdentity, recordMerge, recordSplit, getIdentity, listIdentities, listIdentityVersions, listMappings, transaction, close };
}

module.exports = { createCanonicalIdentityService };
