'use strict';
// Read-only integration boundary. Never generates identity or qualification records.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { isSafeId, isWithinDir } = require('../core/safe-id');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const namespace = value => String(value || '').replace(/[^a-z0-9_-]/gi, '_').slice(0,64) || '_legacy';
const nonempty = v => typeof v === 'string' && !!v.trim();
function failure(code, status = 409, issues = [code]) { const e = new Error(code); Object.assign(e, { code, status, issues }); return e; }
function readFile(root, file, raw = false) {
  try {
    if (!isWithinDir(root,file) || !isWithinDir(fs.realpathSync(root),fs.realpathSync(file))) return null;
    const b = fs.readFileSync(file); return raw ? b : JSON.parse(b.toString('utf8'));
  } catch { return null; }
}
function domain(url) { try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && !u.port ? u.hostname.toLowerCase() : null; } catch { return null; } }
function catalogEndpoint(url, sourceDomain) { try { return domain(url)===sourceDomain && new URL(url).pathname==='/products.json'; } catch { return false; } }
function provesCatalogSource(snapshot, raw, sourceDomain) {
  if(snapshot.provider!=='shopify_products_json' || snapshot.capability!=='product_catalog' || !Number.isInteger(snapshot.http_status) || snapshot.http_status<200 || snapshot.http_status>=300 || !catalogEndpoint(snapshot.source_url,sourceDomain) || (snapshot.final_url && !catalogEndpoint(snapshot.final_url,sourceDomain))) return false;
  try { const payload=JSON.parse(raw.toString('utf8'));return payload!==null && typeof payload==='object' && !Array.isArray(payload) && Array.isArray(payload.products); } catch { return false; }
}
function createContracts(dataDir) {
  const read = (...segments) => readFile(dataDir,path.join(dataDir,...segments));
  function snapshot(tenantId, id) {
    if (!isSafeId(id)) return null;
    const root = path.join(dataDir,'snapshots',namespace(tenantId));
    try {
      const matches = fs.readdirSync(root).filter(d => /^\d{8}$/.test(d)).map(d => read('snapshots',namespace(tenantId),d,id+'.json')).filter(Boolean);
      return matches.length === 1 ? matches[0] : null;
    } catch { return null; }
  }
  function validateChain({ tenantId, projectId, market, categoryScope, sourceDomain, evidenceIds, snapshotIds }) {
    if (!Array.isArray(evidenceIds) || !evidenceIds.length || !Array.isArray(snapshotIds) || !snapshotIds.length) return false;
    const linked = new Set(),catalogSnapshotIds=[];
    for (const id of evidenceIds) {
      if (!isSafeId(id)) return false;
      const e = read('evidence',namespace(tenantId),id+'.json');
      if (!e || e.schema_version !== 1 || e.evidence_id !== id || e.tenant?.tenant_id !== tenantId || e.tenant?.project_ref !== projectId || e.market !== market || !['verified','derived'].includes(e.evidence_status) || !nonempty(e.parser_version) || !nonempty(e.extractor_version) || !Array.isArray(e.source_snapshot_ids) || !e.source_snapshot_ids.length) return false;
      if ((e.entity_ref?.domain && e.entity_ref.domain!==sourceDomain) || (e.category_scope!=null && e.category_scope!==categoryScope)) return false;
      for (const sid of e.source_snapshot_ids) { if (!snapshotIds.includes(sid)) return false; linked.add(sid); }
    }
    for (const id of snapshotIds) {
      const s = snapshot(tenantId,id);
      if (!linked.has(id) || !s || s.schema_version !== 1 || s.snapshot_id !== id || s.tenant?.tenant_id !== tenantId || s.tenant?.project_ref !== projectId || !['success','partial'].includes(s.source_status) || !nonempty(s.collector_version) || !Number.isFinite(Date.parse(s.observed_at)) || domain(s.source_url) !== sourceDomain || (s.final_url && domain(s.final_url) !== sourceDomain) || s.raw_truncated || !s.raw_payload_ref?.path) return false;
      const rawPath = path.resolve(dataDir,s.raw_payload_ref.path);
      const ownRoot = path.join(dataDir,'snapshots',namespace(tenantId));
      if (!isWithinDir(ownRoot,rawPath)) return false;
      const raw = readFile(ownRoot,rawPath,true);
      if (!raw || raw.length !== s.raw_size || 'sha256:' + hash(raw) !== s.content_hash) return false;
      // Auxiliary evidence (e.g. cart currency) remains valid, but cannot establish
      // the separately required known Shopify catalog execution capability.
      if(provesCatalogSource(s,raw,sourceDomain))catalogSnapshotIds.push(id);
    }
    return {catalog_snapshot_ids:catalogSnapshotIds};
  }
  function admission(input, workspace) {
    const issues = [], bad = code => issues.push(code);
    const { tenantId, workspaceId, projectId, competitorId, brandId, qualificationResultId, categoryScope } = input;
    if (!nonempty(tenantId) || ![workspaceId,brandId,qualificationResultId,competitorId].every(isSafeId) || typeof projectId !== 'string' || !/^[a-z0-9\u4e00-\u9fff-]+$/i.test(projectId) || !nonempty(categoryScope)) return { ok:false, issues:['invalid_reference'] };
    if (!workspace || workspace.tenant_id !== tenantId) return { ok:false, issues:['workspace_not_found'] };
    const project = read('research',namespace(tenantId),projectId+'.json');
    if (!project || project.tenantId !== tenantId || project.projectId !== projectId) return { ok:false, issues:['project_ownership_unverified'] };
    if(!Array.isArray(project.competitors) || project.competitors.some(c=>!c || typeof c!=='object' || Array.isArray(c) || !nonempty(c.id)))return {ok:false,issues:['project_competitors_invalid']};
    const competitors = project.competitors.filter(c => c.id === competitorId);
    const comp = competitors.length === 1 ? competitors[0] : null;
    if (!comp || comp.brand_id !== brandId || comp.current_qualification_result_id !== qualificationResultId) return { ok:false, issues:['server_references_missing_or_mismatched'] };
    const brand = read('brands',brandId+'.json');
    const qualification = read('qualification-results',hash(tenantId),qualificationResultId+'.json');
    const sourceDomain = domain(comp.url);
    if (!brand || brand.schema_version !== 1 || brand.brand_id !== brandId || brand.identity_status !== 'resolved' || !nonempty(brand.identity_version) || !Array.isArray(brand.official_domains) || !sourceDomain || !brand.official_domains.includes(sourceDomain)) bad('canonical_identity_unavailable');
    if (!qualification) bad('qualification_result_unavailable');
    else {
      const q = qualification;
      if (q.schema_version !== 1 || q.tenant_id !== tenantId || q.qualification_result_id !== qualificationResultId || q.workspace_id !== workspaceId || q.brand_id !== brandId || q.category_scope !== categoryScope || q.market !== workspace.market || q.qualification_status !== 'qualified') bad('qualification_scope_or_status_mismatch');
      if (!['direct','price_overlap','cross_channel','watchlist'].includes(q.relationship_type) || !['category_fit','core_product_price_fit','audience_fit','market_fit','channel_relation'].every(k => q[k] !== undefined && q[k] !== null) || !Array.isArray(q.reason_codes) || !q.reason_codes.every(nonempty) || !nonempty(q.algorithm_version) || !nonempty(q.config_version) || !Number.isFinite(Date.parse(q.computed_at))) bad('qualification_contract_invalid');
      const chain=validateChain({ tenantId,projectId,market:workspace.market,categoryScope,sourceDomain,evidenceIds:q.evidence_ids,snapshotIds:q.source_snapshot_ids });
      if(!chain)bad('qualification_provenance_invalid');
      else if(!chain.catalog_snapshot_ids.length)bad('known_catalog_source_unverified');
    }
    if (issues.length) return { ok:false, issues };
    return { ok:true, issues, workspace, brand, qualification, source:{ provider:'shopify_products_json', capability:'product_catalog', url:comp.url, domain:sourceDomain, identity_version:brand.identity_version } };
  }
  function validateRecheck(tenantId,target,eventId) {
    if (!isSafeId(eventId)) return false;
    const event = read('events',namespace(tenantId),eventId+'.json');
    if (!event || event.schema_version !== 1 || event.event_id !== eventId || event.event_type !== 'price_change_observed' || event.tenant?.tenant_id !== tenantId || event.tenant?.project_ref !== target.project_id || event.provider !== 'shopify_products_json' || event.entity_ref?.domain !== target.source.domain) return false;
    const diff = isSafeId(event.diff_id) && read('diffs',namespace(tenantId),event.diff_id+'.json');
    if (!diff || diff.schema_version !== 1 || diff.diff_id !== event.diff_id || diff.tenant?.tenant_id !== tenantId || diff.tenant?.project_ref !== target.project_id || diff.status !== 'changed' || diff.entity_key !== event.entity_key) return false;
    for (const side of ['old','new']) {
      const factId = event[side+'_fact_id'];
      const fact = isSafeId(factId) && read('facts',namespace(tenantId),factId+'.json');
      if (!fact || fact.schema_version !== 1 || diff[side+'_fact_id'] !== factId || fact.fact_id !== factId || fact.tenant?.tenant_id !== tenantId || fact.tenant?.project_ref !== target.project_id || fact.market !== target.market || fact.entity_ref?.domain !== target.source.domain || fact.entity_key !== event.entity_key) return false;
      for (const [eventKey,factKey] of [[side+'_evidence_ids','evidence_ids'],[side+'_snapshot_ids','source_snapshot_ids'],[side+'_value','value']]) {
        if(JSON.stringify(event[eventKey])!==JSON.stringify(diff[eventKey]) || JSON.stringify(event[eventKey])!==JSON.stringify(fact[factKey]))return false;
      }
      // Existing Fact lacks category scope; establish exact target scope through a persisted job/event association, not a guessed brand hint.
      const chain=validateChain({ tenantId, projectId:target.project_id, market:target.market, categoryScope:target.category_scope, sourceDomain:target.source.domain, evidenceIds:fact.evidence_ids, snapshotIds:fact.source_snapshot_ids });
      if(!chain || !chain.catalog_snapshot_ids.length)return false;
    }
    return true;
  }
  return { admission, validateRecheck };
}
module.exports = { createContracts, failure, hash, nonempty };
