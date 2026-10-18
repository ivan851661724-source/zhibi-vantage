'use strict';
// Job-attempt observations are inputs to future window Coverage, not Daily Windows.
// There is deliberately no policy/denominator/freshness/actionability writer here.
const fs = require('node:fs');
const path = require('node:path');
const { failure, nonempty, hash } = require('./monitoring-contracts');
const { isSafeId, isWithinDir } = require('../core/safe-id');
const VERSION = 1;
const SOURCE_STATUSES = new Set(['success', 'partial', 'unavailable', 'blocked', 'rate_limited', 'parse_failed', 'timeout', 'internal_error']);
const count = n => Number.isSafeInteger(n) && n >= 0;
const strings = xs => Array.isArray(xs) && xs.every(nonempty) && new Set(xs).size === xs.length;
const equalSet = (a, b) => strings(a) && strings(b) && a.length === b.length && a.every(x => b.includes(x));
const targetKey = t => t && nonempty(t.watch_target_id) && Number.isSafeInteger(t.revision) && t.revision > 0 ? JSON.stringify([t.watch_target_id, t.revision]) : null;
function targetKeys(refs) {
  if (!Array.isArray(refs)) return null;
  const keys = refs.map(targetKey);
  return keys.every(Boolean) && new Set(keys).size === keys.length ? keys : null;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

// Pure invariant check for a trusted Coverage object. Structural provenance is
// necessary, not an authorization endpoint: only a future approved producer may
// supply it. recordObservation always leaves those unavailable inputs null.
function evaluateQuiet(input) {
  const c = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const reasons = new Set();
  const add = reason => reasons.add(reason);
  const p = c.policy_provenance;
  if (!nonempty(c.policy_version) || !p || p.policy_version !== c.policy_version ||
      ![p.approval_ref, p.membership_ref, p.window_ref].every(nonempty) || !equalSet(p.required_capabilities, c.required_capabilities)) add('policy_unknown');
  if (!Number.isSafeInteger(c.window_start) || !Number.isSafeInteger(c.window_end)) add('window_unknown');
  else if (c.window_end <= c.window_start || c.window_complete !== true || !Number.isSafeInteger(c.completed_at) || c.completed_at < c.window_end) add('window_incomplete');
  const expected = targetKeys(c.expected_target_refs), attempted = targetKeys(c.attempted_target_refs), qualified = targetKeys(c.qualified_successful_target_refs);
  if (!count(c.expected_targets) || c.expected_targets === 0 || !expected || expected.length !== c.expected_targets) add('denominator_unknown');
  if (![c.attempted_targets, c.successful_targets, c.qualified_successful_targets, c.failed_targets].every(count)) add('coverage_counts_unknown');
  if (!count(c.expected_targets) || c.expected_targets === 0 || c.attempted_targets !== c.expected_targets ||
      c.successful_targets !== c.expected_targets || c.qualified_successful_targets !== c.expected_targets || c.failed_targets !== 0 ||
      !equalSet(expected, attempted) || !equalSet(expected, qualified)) add('coverage_below_100_percent');
  if (!strings(c.required_capabilities) || !c.required_capabilities.length) add('required_p0_unknown');
  if (!strings(c.missing_capabilities)) add('missing_capabilities_unknown');
  else if (c.missing_capabilities.length) add('required_p0_missing');
  const capabilities = c.capability_results;
  if (!expected || !strings(c.required_capabilities) || !Array.isArray(capabilities) ||
      capabilities.length !== expected.length * c.required_capabilities.length) add('required_p0_incomplete');
  else {
    const seen = new Set();
    for (const r of capabilities) {
      const key = targetKey(r), pair = JSON.stringify([key, r?.capability]);
      if (!r || !expected.includes(key) || !c.required_capabilities.includes(r.capability) || seen.has(pair) ||
          r.complete !== true || r.freshness_status !== 'fresh' || r.comparison_complete !== true) add('required_p0_incomplete');
      seen.add(pair);
    }
  }
  if (c.freshness_status === 'stale') add('stale');
  else if (c.freshness_status !== 'fresh') add('freshness_unknown');
  if (!nonempty(c.freshness_policy_version)) add('freshness_unknown');
  if (c.actionability_complete !== true || !nonempty(c.actionability_policy_version) || !count(c.verified_actionable_events) ||
      !equalSet(c.assessed_event_ids, c.event_ids)) add('actionability_unknown');
  if (count(c.verified_actionable_events) && c.verified_actionable_events > 0) add('verified_actionable_event');
  if (c.comparison_complete !== true) add('comparison_unknown');
  if (c.partial_scan !== false) add(c.partial_scan === true ? 'partial_scan' : 'scan_completeness_unknown');
  if (c.source_status !== 'success') add('source_incomplete');
  if (!Array.isArray(c.source_results) || !c.source_results.length) add('source_results_unknown');
  else if (c.source_results.some(r => !r || r.source_status !== 'success' || r.partial_scan === true)) add('source_incomplete');
  if (!Array.isArray(c.source_failures)) add('source_failures_unknown');
  else if (c.source_failures.length) add('source_failure');
  if (!Array.isArray(c.issues)) add('observation_issues_unknown');
  else for (const issue of c.issues) add(typeof issue === 'string' ? issue : 'observation_issue');
  return { allowed: reasons.size === 0, reasons: [...reasons] };
}

function createCoverageService({ store }) {
  const db = store.getDb();
  store.transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS monitoring_extension_schema(name TEXT PRIMARY KEY,version INTEGER NOT NULL);');
    const installed = db.prepare('SELECT version FROM monitoring_extension_schema WHERE name=?').get('coverage');
    if (installed && installed.version !== VERSION) throw failure('UNSUPPORTED_COVERAGE_SCHEMA');
    db.exec(`CREATE TABLE IF NOT EXISTS monitoring_coverage(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, coverage_id TEXT UNIQUE NOT NULL,
      tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, competitor_id TEXT NOT NULL,
      job_id TEXT NOT NULL, attempt INTEGER NOT NULL, target_id TEXT NOT NULL, revision INTEGER NOT NULL,
      input_digest TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(tenant_id,job_id,attempt));
      CREATE INDEX IF NOT EXISTS monitoring_coverage_scope ON monitoring_coverage(tenant_id,workspace_id,project_id,competitor_id,seq);
      CREATE INDEX IF NOT EXISTS monitoring_coverage_project ON monitoring_coverage(tenant_id,project_id,competitor_id,seq);`);
    if (!installed) db.prepare('INSERT INTO monitoring_extension_schema VALUES(?,?)').run('coverage', VERSION);
  });
  // Bind evidence reads to this store, even if another store uses a different DATA.
  const dataDir = path.dirname(db.prepare('PRAGMA database_list').all().find(r => r.name === 'main').file);
  function get(tenantId, id) {
    if (!nonempty(tenantId) || !nonempty(id)) return null;
    const row = db.prepare('SELECT payload FROM monitoring_coverage WHERE tenant_id=? AND coverage_id=?').get(tenantId, id);
    return row ? JSON.parse(row.payload) : null;
  }
  function list(tenantId, { workspaceId, projectId, competitorId, offset = 0, limit = 50 } = {}) {
    if (!nonempty(tenantId)) throw failure('INVALID_TENANT', 400);
    if (!count(offset) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure('INVALID_PAGINATION', 400);
    if ((projectId !== undefined || competitorId !== undefined) && (!nonempty(projectId) || !nonempty(competitorId))) throw failure('INVALID_TARGET_FILTER', 400);
    if (workspaceId !== undefined && !nonempty(workspaceId)) throw failure('INVALID_TARGET_FILTER', 400);
    let where = 'tenant_id=?'; const params = [tenantId];
    for (const [column, value] of [['workspace_id', workspaceId], ['project_id', projectId], ['competitor_id', competitorId]]) {
      if (value !== undefined) { where += ` AND ${column}=?`; params.push(value); }
    }
    const total = db.prepare(`SELECT count(*) n FROM monitoring_coverage WHERE ${where}`).get(...params).n;
    const coverage = db.prepare(`SELECT payload FROM monitoring_coverage WHERE ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...params, limit, offset).map(r => JSON.parse(r.payload));
    return { coverage, total, offset, limit };
  }
  function recordObservation({ job, target, result, now = Date.now() }) {
    if (!Number.isSafeInteger(now)) throw failure('INVALID_TIMESTAMP', 400);
    return store.transaction(() => {
      const saved = job && db.prepare('SELECT * FROM monitoring_jobs WHERE tenant_id=? AND job_id=?').get(job.tenant_id, job.job_id);
      if (!saved || !['done', 'error'].includes(saved.status) || !saved.result || !count(saved.attempts) || saved.attempts === 0) throw failure('COVERAGE_JOB_NOT_COMPLETED');
      for (const key of ['tenant_id', 'job_id', 'target_id', 'workspace_id', 'revision', 'attempts']) {
        if (job[key] !== saved[key]) throw failure('COVERAGE_JOB_MISMATCH');
      }
      const claim = db.prepare('SELECT * FROM monitoring_claims WHERE job_id=? AND attempt=?').get(saved.job_id, saved.attempts);
      if (!claim) throw failure('COVERAGE_JOB_NOT_COMPLETED');
      const persisted = JSON.parse(saved.result);
      if (canonical(persisted) !== canonical(result) || persisted.source_status !== saved.source_status || !SOURCE_STATUSES.has(persisted.source_status) ||
          saved.status !== (['success', 'partial'].includes(persisted.source_status) ? 'done' : 'error')) throw failure('COVERAGE_RESULT_MISMATCH');
      if ((persisted.job_id !== undefined && persisted.job_id !== saved.job_id) || (persisted.revision !== undefined && persisted.revision !== saved.revision) || persisted.discarded === true) throw failure('COVERAGE_RESULT_MISMATCH');
      const t = store.getWatchTarget(saved.tenant_id, saved.target_id), w = store.getWorkspace(saved.tenant_id, saved.workspace_id);
      const scopeFields = ['tenant_id', 'workspace_id', 'project_id', 'competitor_id', 'brand_id', 'category_scope', 'market', 'target_market_timezone', 'revision', 'workspace_revision'];
      if (!t || !w || !target || t.watch_target_id !== target.watch_target_id || t.tenant_id !== saved.tenant_id || t.workspace_id !== saved.workspace_id || t.revision !== saved.revision ||
          w.tenant_id !== saved.tenant_id || w.workspace_id !== t.workspace_id || w.revision !== t.workspace_revision || w.market !== t.market || w.target_market_timezone !== t.target_market_timezone ||
          scopeFields.some(key => t[key] !== target[key])) throw failure('COVERAGE_TARGET_MISMATCH');
      const inputDigest = hash(canonical({ result: persisted, scope: scopeFields.map(k => t[k]), job_id: saved.job_id, attempt: saved.attempts, target_id: t.watch_target_id }));
      const previous = db.prepare('SELECT input_digest,payload FROM monitoring_coverage WHERE tenant_id=? AND job_id=? AND attempt=?').get(saved.tenant_id, saved.job_id, saved.attempts);
      if (previous) {
        if (previous.input_digest !== inputDigest) throw failure('COVERAGE_OBSERVATION_CONFLICT');
        return JSON.parse(previous.payload);
      }
      const observed = observedReferences(dataDir, t, persisted);
      const issues = new Set(observed.issues);
      if (!Array.isArray(persisted.source_results) || !persisted.source_results.length) issues.add('source_results_unknown');
      if (!observed.fact_ids.length) issues.add('fact_observation_missing');
      if (!Array.isArray(persisted.comparisons) || !persisted.comparisons.length) issues.add('comparison_unknown');
      const c = {
        coverage_id: 'cov_' + hash(canonical([saved.tenant_id, saved.job_id, saved.attempts])), schema_version: VERSION,
        tenant_id: saved.tenant_id, workspace_id: t.workspace_id, project_id: t.project_id, competitor_id: t.competitor_id,
        brand_id: t.brand_id, category_scope: t.category_scope, market: t.market, target_market_timezone: t.target_market_timezone,
        watch_target_id: t.watch_target_id, revision: t.revision, workspace_revision: t.workspace_revision,
        job_id: saved.job_id, attempt: saved.attempts, trigger: saved.trigger, scheduled_at: saved.scheduled_at, window_key: saved.window_key,
        recorded_at: now, completed_at: Number.isSafeInteger(persisted.completed_at) ? persisted.completed_at : now,
        source_status: persisted.source_status, ...observed,
        expected_targets: null, attempted_targets: 1, successful_targets: null, qualified_successful_targets: null,
        failed_targets: observed.source_failures.length || !['success', 'partial'].includes(persisted.source_status) ? 1 : null,
        expected_target_refs: null, attempted_target_refs: [{ watch_target_id: t.watch_target_id, revision: t.revision }], qualified_successful_target_refs: null,
        required_capabilities: null, missing_capabilities: null, capability_results: null,
        window_start: null, window_end: null, window_complete: null, policy_version: null, policy_provenance: null,
        freshness_status: null, freshness_policy_version: null, actionability_complete: null, actionability_policy_version: null,
        verified_actionable_events: null, assessed_event_ids: null, comparison_complete: null,
        partial_scan: observed.source_results.some(s => s.partial_scan === true) ? true : typeof persisted.partial_scan === 'boolean' ? persisted.partial_scan : null, issues: [...issues],
      };
      c.quiet = evaluateQuiet(c);
      db.prepare('INSERT INTO monitoring_coverage(coverage_id,tenant_id,workspace_id,project_id,competitor_id,job_id,attempt,target_id,revision,input_digest,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(c.coverage_id, c.tenant_id, c.workspace_id, c.project_id, c.competitor_id, c.job_id, c.attempt, c.watch_target_id, c.revision, inputDigest, JSON.stringify(c));
      return c;
    });
  }
  return { recordObservation, get, list };
}

// Read only the committed result's explicit references. No tenant Fact/Event scan.
// Metadata refs are retained even for failed sources; unproven chains never enter
// Fact/Diff/Event output. Raw bytes/paths and arbitrary caller text never escape.
function observedReferences(dataDir, target, result) {
  const issues = new Set(), bad = reason => issues.add(reason);
  const namespace = String(target.tenant_id).replace(/[^a-z0-9_-]/gi, '_').slice(0, 64) || '_legacy';
  const token = v => typeof v === 'string' && /^[a-z0-9_:-]{1,128}$/i.test(v) ? v : null;
  if (Array.isArray(result.issues)) for (const issue of result.issues) bad(token(issue) || 'observation_issue');
  if (result.reason) bad(token(result.reason) || 'observation_failed');
  const inScope = r => r?.schema_version === 1 && r.tenant?.tenant_id === target.tenant_id && r.tenant.project_ref === target.project_id;
  const explicitScopeMatches = r => (r.market == null || r.market === target.market) &&
    (r.category_scope == null || r.category_scope === target.category_scope);
  const same = (a, b) => canonical(a) === canonical(b);
  const priceClaim = c => c?.field === 'product.price' && c.scope === 'public_price_observation';
  const priceValue = v => v && typeof v === 'object' && Number.isFinite(v.price_min) && Number.isFinite(v.price_max) &&
    Array.isArray(v.prices) && v.prices.length > 0 && v.prices.every(p => p && Number.isFinite(p.price));
  const rangeOf = f => ({ price_min: f.value.price_min, price_max: f.value.price_max });
  // Mirrors the supported Fact producer's inheritance contract, not a new
  // extraction algorithm. In particular, derived Evidence is not price-eligible.
  function inheritedPrice(f, e) {
    return f.fact_type === 'public_product_price' && priceClaim(f.claim) && priceClaim(e.claim) &&
      e.evidence_status === 'verified' && priceValue(e.extracted_value) &&
      same(f.value, { price_min: e.extracted_value.price_min, price_max: e.extracted_value.price_max, prices: e.extracted_value.prices }) &&
      nonempty(f.entity_key) && f.entity_key === e.entity_key && same(f.entity_ref, e.entity_ref) &&
      f.currency === (e.currency ?? null) && f.unit === (e.unit ?? null) && f.market === (e.market ?? null) &&
      f.observed_at === e.observed_at && f.source === (e.source || null) && f.provider === (e.provider || null) &&
      explicitScopeMatches(e) && equalSet(f.source_snapshot_ids, e.source_snapshot_ids);
  }
  function derivedDiff(d, old, fresh) {
    // Reuse the frozen comparator. A non-comparable pair produces unavailable;
    // neither this verifier nor Coverage changes the comparison policy.
    const judged = require('../research/price-diff').judge(old, fresh);
    const expectedStatus = judged.notComparable ? 'unavailable' : judged.status;
    return d.diff_type === 'product.price' && priceClaim(d.claim) && same(d.entity_ref, old.entity_ref) && explicitScopeMatches(d) &&
      same(d.old_value, rangeOf(old)) && same(d.new_value, rangeOf(fresh)) &&
      d.old_currency === (old.currency ?? null) && d.new_currency === (fresh.currency ?? null) && d.status === expectedStatus &&
      d.direction === (judged.direction || null) && d.delta === (judged.delta ?? null) && d.pct === (judged.pct ?? null) &&
      d.reason === (judged.notComparable ? judged.reason : null) && d.reason_detail === null && Number.isFinite(Date.parse(d.computed_at));
  }
  function derivedEvent(e, d) {
    const scalar = v => v.price_min === v.price_max ? v.price_min : null;
    return same(e.entity_ref, d.entity_ref) && explicitScopeMatches(e) && (e.claim == null || priceClaim(e.claim)) &&
      same(e.old_value, d.old_value) && same(e.new_value, d.new_value) &&
      e.old_price === scalar(d.old_value) && e.new_price === scalar(d.new_value) &&
      e.direction === (d.direction || null) && e.delta === (d.delta ?? null) && e.pct === (d.pct ?? null) &&
      e.currency === (d.old_currency ?? null) && e.source === 'shopify' && e.occurred_at === d.computed_at &&
      same(e.provenance?.diff, { diff_id: d.diff_id, status: d.status, reason: d.reason || null });
  }
  function read(root, file, raw = false) {
    try {
      if (!isWithinDir(root, file) || !isWithinDir(fs.realpathSync(dataDir), fs.realpathSync(root)) ||
          !isWithinDir(fs.realpathSync(root), fs.realpathSync(file))) return null;
      const bytes = fs.readFileSync(file); return raw ? bytes : JSON.parse(bytes.toString('utf8'));
    } catch { return null; }
  }
  function record(folder, id, idField) {
    if (!isSafeId(id)) return null;
    const root = path.join(dataDir, folder, namespace), r = read(root, path.join(root, id + '.json'));
    return inScope(r) && r[idField] === id ? r : null;
  }
  const snapshotRoot = path.join(dataDir, 'snapshots', namespace);
  let days = [];
  try { days = fs.readdirSync(snapshotRoot).filter(d => /^\d{8}$/.test(d)); } catch { /* absence is reported per reference */ }
  const snapshotCache = new Map(), factCache = new Map(), diffCache = new Map();
  function snapshot(id) {
    if (snapshotCache.has(id)) return snapshotCache.get(id);
    if (!isSafeId(id)) return null;
    const matches = days.map(d => read(snapshotRoot, path.join(snapshotRoot, d, id + '.json'))).filter(Boolean);
    const s = matches.length === 1 ? matches[0] : null;
    const endpoint = url => { try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && !u.port && u.hostname === target.source.domain; } catch { return false; } };
    if (!inScope(s) || s.snapshot_id !== id || !endpoint(s.source_url) || (s.final_url && !endpoint(s.final_url)) || !SOURCE_STATUSES.has(s.source_status)) { snapshotCache.set(id, null); return null; }
    let raw = null;
    if (typeof s.raw_payload_ref?.path === 'string') raw = read(snapshotRoot, path.resolve(dataDir, s.raw_payload_ref.path), true);
    const validRaw = !!raw && !s.raw_truncated && raw.length === s.raw_size && 'sha256:' + hash(raw) === s.content_hash;
    if (!validRaw) bad('snapshot_raw_unverified');
    const out = { meta: s, validRaw }; snapshotCache.set(id, out); return out;
  }
  function fact(id, current = false) {
    if (!factCache.has(id)) {
      const f = record('facts', id, 'fact_id');
      const linked = new Set();
      const ok = f && f.entity_ref?.domain === target.source.domain && Number.isFinite(Date.parse(f.observed_at)) &&
        explicitScopeMatches(f) && strings(f.evidence_ids) && f.evidence_ids.length === 1 && strings(f.source_snapshot_ids) && f.source_snapshot_ids.length &&
        f.source_snapshot_ids.every(sid => snapshot(sid)?.validRaw) && f.evidence_ids.every(eid => {
          const e = record('evidence', eid, 'evidence_id');
          return e && inheritedPrice(f, e) &&
            strings(e.source_snapshot_ids) && e.source_snapshot_ids.length && e.source_snapshot_ids.every(sid => {
              linked.add(sid); return f.source_snapshot_ids.includes(sid) && snapshot(sid)?.validRaw;
            });
        }) && f.source_snapshot_ids.every(sid => linked.has(sid));
      factCache.set(id, ok ? f : null);
    }
    const f = factCache.get(id);
    return f && (!current || (Date.parse(f.observed_at) >= target.created_at && f.source_snapshot_ids.some(id => Array.isArray(result.snapshot_ids) && result.snapshot_ids.includes(id)))) ? f : null;
  }
  function diff(id) {
    if (diffCache.has(id)) return diffCache.get(id);
    const d = record('diffs', id, 'diff_id'), old = d && fact(d.old_fact_id), fresh = d && fact(d.new_fact_id, true);
    const ok = d && old && fresh && Array.isArray(result.fact_ids) && result.fact_ids.includes(d.new_fact_id) &&
      d.entity_key === old.entity_key && derivedDiff(d, old, fresh) && d.observed_at_old === old.observed_at && d.observed_at_new === fresh.observed_at &&
      equalSet(d.old_evidence_ids, old.evidence_ids) && equalSet(d.new_evidence_ids, fresh.evidence_ids) &&
      equalSet(d.old_snapshot_ids, old.source_snapshot_ids) && equalSet(d.new_snapshot_ids, fresh.source_snapshot_ids) &&
      Date.parse(old.observed_at) < Date.parse(fresh.observed_at) && ['changed', 'no_meaningful_change', 'unavailable'].includes(d.status);
    diffCache.set(id, ok ? d : null); return diffCache.get(id);
  }
  function ids(values, kind, verify) {
    if (values === undefined) return [];
    if (!Array.isArray(values)) { bad(kind + '_references_invalid'); return []; }
    return [...new Set(values)].filter(id => { if (!isSafeId(id) || !verify(id)) { bad(kind + '_reference_unverified'); return false; } return true; });
  }
  const requestedSnapshots = [...(Array.isArray(result.snapshot_ids) ? result.snapshot_ids : []), ...(result.currency_snapshot_id ? [result.currency_snapshot_id] : [])];
  if (Array.isArray(result.source_results)) for (const s of result.source_results) if (s?.snapshot_id) requestedSnapshots.push(s.snapshot_id);
  const snapshot_ids = ids(requestedSnapshots, 'snapshot', snapshot);
  const source_results = snapshot_ids.map(id => {
    const s = snapshot(id).meta;
    return { snapshot_id: id, provider: token(s.provider), source_status: s.source_status,
      http_status: Number.isInteger(s.http_status) ? s.http_status : null,
      observed_at: typeof s.observed_at === 'string' && Number.isFinite(Date.parse(s.observed_at)) ? s.observed_at : null,
      collector_version: token(s.collector_version), partial_scan: typeof s.partial_scan === 'boolean' ? s.partial_scan : null,
      partial_scan_reason: token(s.partial_scan_reason) };
  });
  const source_failures = source_results.filter(s => s.source_status !== 'success' || s.partial_scan === true);
  if (!['success', 'partial'].includes(result.source_status) && !source_failures.length) source_failures.push({ snapshot_id: null, provider: null, source_status: result.source_status, reason: token(result.reason) });
  const fact_ids = ids(result.fact_ids, 'fact', id => fact(id, true));
  const diff_ids = ids(result.diff_ids, 'diff', diff);
  const event_ids = ids(result.event_ids, 'event', id => {
    const e = record('events', id, 'event_id'), d = e && diff(e.diff_id);
    return e && d && d.status === 'changed' && derivedEvent(e, d) && e.event_type === 'price_change_observed' && e.provider === target.source.provider &&
      e.old_fact_id === d.old_fact_id && e.new_fact_id === d.new_fact_id && e.entity_key === d.entity_key &&
      e.observed_at_old === d.observed_at_old && e.observed_at_new === d.observed_at_new &&
      Number.isFinite(Date.parse(e.occurred_at)) && Date.parse(e.occurred_at) >= Date.parse(d.observed_at_new) &&
      ['old_evidence_ids', 'new_evidence_ids', 'old_snapshot_ids', 'new_snapshot_ids'].every(key => equalSet(e[key], d[key]));
  });
  const comparisons = [];
  if (Array.isArray(result.comparisons)) for (const r of result.comparisons) {
    if (!r || !fact_ids.includes(r.fact_id) || (r.diff_id && (!diff_ids.includes(r.diff_id) || diff(r.diff_id)?.new_fact_id !== r.fact_id)) ||
        (r.event_id && (!event_ids.includes(r.event_id) || !r.diff_id || record('events', r.event_id, 'event_id')?.diff_id !== r.diff_id))) { bad('comparison_reference_unverified'); continue; }
    const d = r.diff_id ? diff(r.diff_id) : null;
    if (d && r.status !== d.status) { bad('comparison_status_mismatch'); continue; }
    const reason = token(r.reason);
    comparisons.push({ fact_id: r.fact_id, diff_id: r.diff_id || null, event_id: r.event_id || null, status: d?.status || null, reason });
    const normalExplanation = d?.status === 'no_meaningful_change' && reason === 'no_event_for_no_meaningful_change';
    if (!d || d.status === 'unavailable' || (reason && !normalExplanation)) bad(reason || 'comparison_unknown');
  }
  return { source_results, source_failures, snapshot_ids, currency_snapshot_id: snapshot_ids.includes(result.currency_snapshot_id) ? result.currency_snapshot_id : null,
    fact_ids, diff_ids, event_ids, comparisons, issues: [...issues] };
}

module.exports = { createCoverageService, evaluateQuiet, observedReferences };
