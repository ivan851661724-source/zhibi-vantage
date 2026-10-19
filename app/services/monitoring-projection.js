'use strict';
// Observed station history only. External delivery policy has no producer here.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { failure } = require('./monitoring-contracts');
const { createCoverageService, observedReferences } = require('./monitoring-coverage');
const { isSafeId, isWithinDir } = require('../core/safe-id');
const VERSION = 1;
const EXTERNAL_REASONS = Object.freeze(['notification_policy_unknown', 'notification_preferences_unknown', 'external_eligibility_unknown']);

function createMonitoringProjection({ store }) {
  const db = store.getDb();
  const coverage = createCoverageService({ store });
  const dataDir = path.dirname(db.prepare('PRAGMA database_list').all().find(r => r.name === 'main').file);
  store.transaction(() => {
    const installed = db.prepare('SELECT version FROM monitoring_extension_schema WHERE name=?').get('event_projections');
    if (installed && installed.version !== VERSION) throw failure('UNSUPPORTED_PROJECTION_SCHEMA');
    db.exec(`CREATE TABLE IF NOT EXISTS monitoring_event_projections(
      seq INTEGER PRIMARY KEY AUTOINCREMENT, notification_id TEXT UNIQUE NOT NULL,
      tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL, project_id TEXT NOT NULL, competitor_id TEXT NOT NULL,
      target_id TEXT NOT NULL, event_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL,
      UNIQUE(tenant_id,workspace_id,target_id,event_id));
      CREATE INDEX IF NOT EXISTS monitoring_projection_scope ON monitoring_event_projections(tenant_id,workspace_id,project_id,competitor_id,seq);
      CREATE INDEX IF NOT EXISTS monitoring_projection_project ON monitoring_event_projections(tenant_id,project_id,competitor_id,seq);`);
    if (!installed) db.prepare('INSERT INTO monitoring_extension_schema VALUES(?,?)').run('event_projections', VERSION);
  });
  const nonempty = v => typeof v === 'string' && v.trim().length > 0;
  function get(tenantId, notificationId) {
    if (!nonempty(tenantId) || !nonempty(notificationId)) return null;
    const row = db.prepare('SELECT payload FROM monitoring_event_projections WHERE tenant_id=? AND notification_id=?').get(tenantId, notificationId);
    return row ? JSON.parse(row.payload) : null;
  }
  function list(tenantId, { workspaceId, projectId, competitorId, offset = 0, limit = 50 } = {}) {
    if (!nonempty(tenantId)) throw failure('INVALID_TENANT', 400);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure('INVALID_PAGINATION', 400);
    if ((projectId !== undefined || competitorId !== undefined) && (!nonempty(projectId) || !nonempty(competitorId))) throw failure('INVALID_TARGET_FILTER', 400);
    if (workspaceId !== undefined && !nonempty(workspaceId)) throw failure('INVALID_TARGET_FILTER', 400);
    let where = 'tenant_id=?'; const params = [tenantId];
    for (const [column, value] of [['workspace_id', workspaceId], ['project_id', projectId], ['competitor_id', competitorId]]) {
      if (value !== undefined) { where += ` AND ${column}=?`; params.push(value); }
    }
    const total = db.prepare(`SELECT COUNT(*) n FROM monitoring_event_projections WHERE ${where}`).get(...params).n;
    const event_projections = db.prepare(`SELECT payload FROM monitoring_event_projections WHERE ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...params, limit, offset).map(r => JSON.parse(r.payload));
    return { event_projections, total, offset, limit };
  }
  // Bind all reads to the injected store, including realpath containment. Neither
  // path-capturing global stores nor safe filename aliases establish raw identity.
  function readers(target) {
    const ns = target.tenant_id.replace(/[^a-z0-9_-]/gi, '_').slice(0,64) || '_legacy';
    // Each recordObservation creates its own readers. Cache only within that
    // synchronous verification, never across jobs/retries or observation times.
    const recordCache=new Map(),snapshotCache=new Map(),rawCache=new Map(),catalogCache=new Map();
    let days;
    function read(folder, rel) {
      const root = path.join(dataDir, folder, ns), file = path.join(root, rel);
      if(recordCache.has(file))return recordCache.get(file);
      let value=null;
      try {
        if (isWithinDir(root,file) && isWithinDir(fs.realpathSync(dataDir),fs.realpathSync(root)) && isWithinDir(fs.realpathSync(root),fs.realpathSync(file))) {
          const r = JSON.parse(fs.readFileSync(file,'utf8'));
          if(r?.schema_version === 1 && r.tenant?.tenant_id === target.tenant_id && r.tenant.project_ref === target.project_id)value=r;
        }
      } catch { /* Invalid/missing records remain null for this invocation. */ }
      recordCache.set(file,value);return value;
    }
    const record = (folder,id,key) => { if (!isSafeId(id)) return null; const r=read(folder,id+'.json'); return r?.[key]===id?r:null; };
    function snapshot(id) {
      if (!isSafeId(id)) return null;
      if(snapshotCache.has(id))return snapshotCache.get(id);
      let value=null;
      try {
        days=days||fs.readdirSync(path.join(dataDir,'snapshots',ns)).filter(d=>/^\d{8}$/.test(d));
        const matches=days.map(d=>read('snapshots',path.join(d,id+'.json'))).filter(Boolean);
        if(matches.length===1&&matches[0].snapshot_id===id)value=matches[0];
      } catch { /* Absence is cached only inside this invocation. */ }
      snapshotCache.set(id,value);return value;
    }
    const contentKey=s=>JSON.stringify([s.snapshot_id,s.content_hash,s.raw_size,s.raw_truncated,s.raw_payload_ref?.path]);
    function raw(s) {
      const key=contentKey(s);if(rawCache.has(key))return rawCache.get(key);
      let value=null;
      try {
        const root=path.join(dataDir,'snapshots',ns),file=path.resolve(dataDir,s.raw_payload_ref.path);
        if(!s.raw_truncated&&isWithinDir(root,file)&&isWithinDir(fs.realpathSync(dataDir),fs.realpathSync(root))&&isWithinDir(fs.realpathSync(root),fs.realpathSync(file))){
          const bytes=fs.readFileSync(file);
          if(bytes.length===s.raw_size&&'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')===s.content_hash)value=bytes;
        }
      }catch{ /* Invalid/missing raw is not reusable outside this invocation. */ }
      rawCache.set(key,value);return value;
    }
    function catalog(s) {
      const key=contentKey(s);if(catalogCache.has(key))return catalogCache.get(key);
      const indexed=new Map(),bytes=raw(s);
      if(bytes){
        try {
          const parsed=require('../research/evidence-extract').parseProductPriceObservations(bytes.toString('utf8'));
          for(const product of parsed.products||[])indexed.set(product.entity_key,indexed.has(product.entity_key)?null:product);
        }catch{ /* A malformed raw page proves no product observations. */ }
      }
      catalogCache.set(key,indexed);return indexed;
    }
    return {record,snapshot,raw,catalog};
  }
  function recordObservation({ job, now = Date.now() }) {
    if (!Number.isSafeInteger(now)) throw failure('INVALID_TIMESTAMP',400);
    return store.transaction(() => {
      const saved = job && db.prepare('SELECT * FROM monitoring_jobs WHERE tenant_id=? AND job_id=?').get(job.tenant_id,job.job_id);
      if (!saved || !['done','error'].includes(saved.status) || !saved.result || !saved.attempts ||
          ['tenant_id','job_id','target_id','workspace_id','revision','attempts'].some(k=>job[k]!==saved[k])) throw failure('PROJECTION_JOB_MISMATCH');
      const target = store.assertExecutable(saved.tenant_id,saved.target_id,saved.revision);
      if (target.workspace_id!==saved.workspace_id) throw failure('PROJECTION_JOB_MISMATCH');
      const result = JSON.parse(saved.result);
      let c;
      try { c=coverage.recordObservation({job:saved,target,result,now}); }
      catch (e) { if(e.code!=='COVERAGE_OBSERVATION_CONFLICT')throw e;return {event_projections:[],issues:['committed_result_changed']}; }
      // Revalidate even when Coverage already exists: an immutable observation is
      // historical evidence, not permission to project subsequently damaged files.
      const proof = observedReferences(dataDir,target,result), issues = new Set(proof.issues);
      const out = [];
      if (!['success','partial'].includes(result.source_status)) return {event_projections:out,issues:[...issues,'source_incomplete']};
      const {record,snapshot,raw,catalog:catalogProducts}=readers(target);
      for (const eventId of proof.event_ids) {
        const event=record('events',eventId,'event_id');
        const old=event&&record('facts',event.old_fact_id,'fact_id'), fresh=event&&record('facts',event.new_fact_id,'fact_id');
        const endpoint = (url,pathname) => { try {const u=new URL(url);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname===target.source.domain&&u.pathname===pathname;}catch{return false;} };
        const sourceProof = fact => {
          if(!fact||fact.provider!==target.source.provider||!fact.source_snapshot_ids.length)return false;
          const evidence=record('evidence',fact.evidence_ids[0],'evidence_id');
          const parserVersion=evidence?.parser_version;
          if(!['shopify-products-json-1','shopify-products-json-2'].includes(parserVersion))return false;
          const extractorVersion=parserVersion==='shopify-products-json-1'?'evidence-extract-1':'evidence-extract-2';
          const provenance=fact.provenance?.evidence;
          if(evidence.extractor_version!==extractorVersion||provenance?.evidence_id!==evidence.evidence_id||
            provenance.evidence_status!==evidence.evidence_status||provenance.parser_version!==parserVersion||provenance.extractor_version!==extractorVersion)return false;
          let catalogSource=null,cartSource=null;
          const verified=fact.source_snapshot_ids.every(id=>{
          const s=snapshot(id), catalog=s?.provider===target.source.provider, cart=s?.provider==='shopify_cart_js_json';
          const pathname=catalog?'/products.json':'/cart.js';
          if(!s||!(catalog||cart)||s.capability!==(catalog?'product_catalog':'storefront_currency')||!['success','partial'].includes(s.source_status)||!Number.isInteger(s.http_status)||s.http_status<200||s.http_status>=300||
            !endpoint(s.source_url,pathname)||(s.final_url&&!endpoint(s.final_url,pathname))||(catalog&&s.observed_at!==fact.observed_at))return false;
          const bytes=raw(s);if(!bytes)return false;
          if(catalog){
            if(catalogSource)return false;catalogSource=s;
            // Replay the existing pure parser, never introduce another extractor
            // or price algorithm and never write evidence during projection.
            const match=catalogProducts(s).get(fact.entity_key);if(!match)return false;
            // HEAD's published v1 parser has the same product metadata and price
            // parsing but no prices.available field. Adapt only that known shape
            // using the actual supporting Evidence version; stored Facts stay intact.
            const prices=parserVersion==='shopify-products-json-1'?match.prices.map(({available,...price})=>price):match.prices;
            return require('node:util').isDeepStrictEqual(fact.value,{price_min:match.price_min,price_max:match.price_max,prices})&&
              Object.entries(match.entity_ref).every(([k,v])=>fact.entity_ref?.[k]===v);
          }
          if(cartSource||s.source_status!=='success')return false;cartSource=s;
          try {const currency=JSON.parse(bytes.toString('utf8'))?.currency;return typeof currency==='string'&&/^[A-Za-z]{3}$/.test(currency)&&currency.toUpperCase()===fact.currency;}catch{return false;}
          });
          return verified&&!!catalogSource&&(cartSource?!!catalogSource.fetched_at&&catalogSource.fetched_at===cartSource.fetched_at:fact.currency==null);
        };
        if (!event || !proof.fact_ids.includes(event.new_fact_id) || !proof.diff_ids.includes(event.diff_id) ||
            !sourceProof(old) || !sourceProof(fresh) || (event.currency!=null&&!/^[A-Z]{3}$/.test(event.currency))) {
          issues.add('event_source_unverified');continue;
        }
        const notificationId='notification_'+crypto.createHash('sha256').update(JSON.stringify([saved.tenant_id,target.workspace_id,target.watch_target_id,eventId])).digest('hex');
        const previous=get(saved.tenant_id,notificationId);
        if(previous){out.push(previous);continue;}
        const limitations=['observed_unconfirmed','catalog_product_price_only','category_relevance_unknown','coverage_window_unknown','importance_unknown','source_market_unknown'].filter(v=>v!=='source_market_unknown'||fresh.market==null);
        if(c.partial_scan===true)limitations.push('partial_scan');
        const row={notification_id:notificationId,projection_version:VERSION,
          tenant_id:saved.tenant_id,workspace_id:target.workspace_id,project_id:target.project_id,competitor_id:target.competitor_id,
          watch_target_id:target.watch_target_id,revision:target.revision,job_id:saved.job_id,attempt:saved.attempts,coverage_id:c.coverage_id,
          event_id:eventId,event_type:'price_change_observed',diff_id:event.diff_id,old_fact_id:event.old_fact_id,new_fact_id:event.new_fact_id,
          old_evidence_ids:event.old_evidence_ids,new_evidence_ids:event.new_evidence_ids,old_snapshot_ids:event.old_snapshot_ids,new_snapshot_ids:event.new_snapshot_ids,
          old_value:{price_min:event.old_value.price_min,price_max:event.old_value.price_max},new_value:{price_min:event.new_value.price_min,price_max:event.new_value.price_max},
          old_price:event.old_price,new_price:event.new_price,direction:event.direction,delta:event.delta,pct:event.pct,currency:event.currency,market:fresh.market??null,
          observed_at_old:event.observed_at_old,observed_at_new:event.observed_at_new,occurred_at:event.occurred_at,enqueue_at:now,
          importance:null,accepted_at:null,delivered_at:null,failed_at:null,external_delivery_blocked:true,external_delivery_reasons:[...EXTERNAL_REASONS],limitations,
          // This API path requires the existing authenticated transport, not an href.
          event_detail_api:'/api/demo/event-detail?id='+encodeURIComponent(eventId)};
        row.view=require('../routes/handlers/demo').priceChangeView(row);
        db.prepare('INSERT INTO monitoring_event_projections(notification_id,tenant_id,workspace_id,project_id,competitor_id,target_id,event_id,revision,payload) VALUES(?,?,?,?,?,?,?,?,?)')
          .run(notificationId,saved.tenant_id,target.workspace_id,target.project_id,target.competitor_id,target.watch_target_id,eventId,target.revision,JSON.stringify(row));
        out.push(row);
      }
      return {event_projections:out,issues:[...issues]};
    });
  }
  return {recordObservation,get,list};
}
module.exports={createMonitoringProjection};
