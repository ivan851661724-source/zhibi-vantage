'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const boot = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-projection-boot-'));
process.env.ZB_DATA_DIR = boot;
delete process.env.MT_STORE_PATH; delete process.env.OBS_DB_PATH;
global.fetch = () => { throw Error('network forbidden'); };
const { fixture } = require('./monitoring-store.test');
const f = fixture();
const { createMonitoringStore } = require('../services/monitoring-store');
const { createMonitoringQueue } = require('../services/monitoring-queue');
const { createCoverageService } = require('../services/monitoring-coverage');
const Snapshot = require('../research/source-snapshot'), Extract = require('../research/evidence-extract');
const Fact = require('../research/fact-store'), Events = require('../research/domain-event');
const implementationPath = path.join(__dirname, '../services/monitoring-projection.js');
const implementation = fs.existsSync(implementationPath) ? require(implementationPath) : {};
let seq = 0, nextNow=Date.parse('2026-10-17T10:00:00Z');
function service(store = f.store) {
  assert.equal(typeof implementation.createMonitoringProjection, 'function', 'durable observed projection service');
  return implementation.createMonitoringProjection({ store });
}
function setup(options = {}) {
  const n = ++seq, seed = f.seed(f.workspace('projection' + n), 'projection' + n);
  const target = f.store.createWatchTarget(seed.input), queue = createMonitoringQueue({store:f.store,config:{providerMinIntervalMs:1}});
  function observation(price, hour) {
    const observed_at = `2026-01-01T0${hour}:00:00.000Z`;
    const products=Array.from({length:options.count||1},(_,i)=>({id:n*1000+i,variants:[{id:n*10000+i,price:String(price),available:options.available===null?null:true}]}));
    const s = Snapshot.record({tenantId:f.tenantId,projectRef:target.project_id,provider:'shopify_products_json',capability:'product_catalog',source_url:'https://example.com/products.json',http_status:200,source_status:'success',observed_at,bodyBytes:Buffer.from(JSON.stringify({products}))}).meta;
    const e = Extract.extractShopifyPriceEvidence({tenantId:f.tenantId,snapshotId:s.snapshot_id,projectRef:target.project_id,entityRef:{domain:'example.com'}});
    const facts=e.evidence_ids.map(evidenceId=>{
      if(hour===1&&options.oldParserVersion!==undefined){
        const rel=`evidence/${f.ns}/${evidenceId}.json`,evidence=JSON.parse(fs.readFileSync(path.join(f.dir,rel),'utf8'));
        evidence.parser_version=options.oldParserVersion;
        if(options.oldParserVersion==='shopify-products-json-1'){
          evidence.extractor_version='evidence-extract-1';
          // Verified HEAD v1 differs only by the absence of prices.available.
          evidence.extracted_value.prices=evidence.extracted_value.prices.map(({available,...value})=>value);
        }
        f.write(rel,evidence);
      }
      return Fact.recordPriceFactFromEvidence({tenantId:f.tenantId,evidenceId}).meta;
    });
    return {s,fact:facts[0],facts};
  }
  const old = observation(10,1), fresh = observation(12,2);
  const comparisons=fresh.facts.map(fact=>({fact_id:fact.fact_id,...Events.detectPriceChangeFromFact({tenantId:f.tenantId,factId:fact.fact_id})}));
  const detected = comparisons[0];
  assert.equal(detected.status,'changed');
  const event = Events.getEventById(f.tenantId,detected.event_id);
  const result = {schema_version:1,revision:target.revision,source_status:'success',source_results:[{snapshot_id:fresh.s.snapshot_id}],snapshot_ids:[fresh.s.snapshot_id],fact_ids:fresh.facts.map(f=>f.fact_id),diff_ids:comparisons.map(c=>c.diff_id),event_ids:comparisons.map(c=>c.event_id),comparisons,partial_scan:false,issues:[],completed_at:nextNow};
  function finish(patch={}) {
    const now=nextNow;nextNow+=8*3600000;
    const slot = require('../services/monitoring-time').nextSlot(now-1,target.target_market_timezone);
    queue.enqueue({tenantId:f.tenantId,watchTargetId:target.watch_target_id,trigger:'monitor',scheduledAt:slot.scheduled_at,windowKey:slot.window_key,now});
    const job = queue.claim(now); assert.ok(job);
    const saved = {...result,...patch,job_id:job.job_id};
    assert.equal(queue.finish(job.job_id,job.claim_token,saved,now+1).ok,true);
    const c = createCoverageService({store:f.store}).recordObservation({job,target:f.store.getWatchTarget(f.tenantId,target.watch_target_id),result:saved,now:now+1});
    return {job,coverage:c,result:saved,now:now+2};
  }
  const rewrite = (folder,id,record) => f.write(`${folder}/${f.ns}/${id}.json`,record);
  return {target,event,result,old,fresh,finish,rewrite};
}

test('observed projection is safe, durable, immutable and deduplicated across jobs, connections and reopen',()=>{
  const p = service(), s = setup(), input = s.finish();
  const out = p.recordObservation({job:input.job,now:input.now});
  assert.equal(out.event_projections.length,1,JSON.stringify(out)); const row = out.event_projections[0];
  assert.equal(row.event_type,'price_change_observed'); assert.equal(row.market,null); assert.equal(row.importance,null);
  assert.equal(row.old_value.price_min,10); assert.equal(row.new_value.price_min,12); assert.equal(row.pct,20);
  assert.equal(row.view.from,'10'); assert.equal(row.view.to,'12'); assert.equal(row.external_delivery_blocked,true);
  assert.ok(row.external_delivery_reasons.includes('notification_policy_unknown'));
  assert.equal(row.delivered_at,null); assert.equal(row.accepted_at,null); assert.equal(row.failed_at,null); assert.equal(row.enqueue_at,input.now);
  assert.equal(Object.hasOwn(row,'enqueued_at'),false);
  assert.equal(row.observed_at_new,'2026-01-01T02:00:00.000Z');
  assert.equal(row.event_detail_api,'/api/demo/event-detail?id='+s.event.event_id);
  assert.equal(JSON.stringify(row).includes('raw_payload_ref'),false); assert.equal(JSON.stringify(row).includes(f.dir),false);
  assert.deepEqual(p.recordObservation({job:input.job,now:input.now+99}).event_projections,[row]);
  const repeat=s.finish(); assert.deepEqual(p.recordObservation({job:repeat.job,now:repeat.now}).event_projections,[row]);
  let other=createMonitoringStore({dataDir:f.dir});
  assert.deepEqual(service(other).recordObservation({job:repeat.job,now:repeat.now+1}).event_projections,[row]);other.close();
  other=createMonitoringStore({dataDir:f.dir});assert.deepEqual(service(other).get(f.tenantId,row.notification_id),row);other.close();
  assert.equal(p.get('tenant?a',row.notification_id),null);
  assert.equal(p.list(f.tenantId,{projectId:s.target.project_id,competitorId:s.target.competitor_id,offset:1,limit:1}).total,1);
  assert.deepEqual(p.list(f.tenantId,{projectId:s.target.project_id,competitorId:s.target.competitor_id,offset:1,limit:1}).event_projections,[]);
  assert.equal(p.list(f.tenantId,{workspaceId:'unknown'}).total,0);
  assert.throws(()=>p.list(f.tenantId,{projectId:s.target.project_id}),{code:'INVALID_TARGET_FILTER'});
  assert.throws(()=>p.list(f.tenantId,{offset:-1}),{code:'INVALID_PAGINATION'});
  assert.deepEqual(p.list('tenant?a').event_projections,[]);
  assert.equal(f.store.getDb().prepare('PRAGMA user_version').get().user_version,1);
});

test('actual v1 Evidence price shape remains comparable to v2 without changing stored Fact or Event',()=>{
  const p=service(),s=setup({oldParserVersion:'shopify-products-json-1'}),input=s.finish();
  assert.equal(input.coverage.event_ids.length,1);
  assert.equal(Object.hasOwn(s.old.fact.value.prices[0],'available'),false);
  assert.equal(s.old.fact.entity_ref.variant_observed_count,1);
  const before=JSON.stringify(Fact.getFactById(f.tenantId,s.old.fact.fact_id));
  const result=p.recordObservation({job:input.job,now:input.now});
  assert.equal(result.event_projections.length,1,JSON.stringify(result.issues));
  assert.equal(result.event_projections[0].old_price,10);assert.equal(result.event_projections[0].new_price,12);
  assert.equal(result.event_projections[0].pct,20);
  assert.equal(JSON.stringify(Fact.getFactById(f.tenantId,s.old.fact.fact_id)),before);
  assert.deepEqual(Events.getEventById(f.tenantId,s.event.event_id),s.event);
});

test('unknown or missing Evidence parser versions reject rather than defaulting to current raw shape',()=>{
  const p=service();
  for(const oldParserVersion of ['shopify-products-json-999',null]){
    const s=setup({oldParserVersion}),input=s.finish();assert.equal(input.coverage.event_ids.length,1);
    const result=p.recordObservation({job:input.job,now:input.now});
    assert.deepEqual(result.event_projections,[]);assert.ok(result.issues.includes('event_source_unverified'));
  }
});

test('supported parser versions require their actual price shape and consistent Fact provenance',()=>{
  const p=service();
  for(const defect of ['v1_with_v2_prices','v2_without_available','fact_parser_version','fact_extractor_version','evidence_extractor_version']){
    const s=setup(),input=s.finish();
    const fact=structuredClone(s.old.fact);
    const evidence=JSON.parse(fs.readFileSync(path.join(f.dir,`evidence/${f.ns}/${fact.evidence_ids[0]}.json`),'utf8'));
    if(defect==='v1_with_v2_prices'){
      evidence.parser_version=fact.provenance.evidence.parser_version='shopify-products-json-1';
      evidence.extractor_version=fact.provenance.evidence.extractor_version='evidence-extract-1';
    }
    if(defect==='v2_without_available'){
      evidence.extracted_value.prices=evidence.extracted_value.prices.map(({available,...v})=>v);
      fact.value.prices=evidence.extracted_value.prices;
    }
    if(defect==='fact_parser_version')fact.provenance.evidence.parser_version='shopify-products-json-1';
    if(defect==='fact_extractor_version')fact.provenance.evidence.extractor_version='evidence-extract-999';
    if(defect==='evidence_extractor_version')evidence.extractor_version=fact.provenance.evidence.extractor_version='evidence-extract-999';
    s.rewrite('facts',fact.fact_id,fact);s.rewrite('evidence',evidence.evidence_id,evidence);
    const out=p.recordObservation({job:input.job,now:input.now});assert.deepEqual(out.event_projections,[],defect);assert.ok(out.issues.includes('event_source_unverified'),defect);
  }
});

test('v1 requires its actual product metadata; v2 retains legitimate null availability and unknown context',()=>{
  const p=service(),s=setup({oldParserVersion:'shopify-products-json-1'});
  const oldFact=structuredClone(s.old.fact);delete oldFact.entity_ref.variant_observed_count;
  s.rewrite('facts',oldFact.fact_id,oldFact);
  const oldEvidence=JSON.parse(fs.readFileSync(path.join(f.dir,`evidence/${f.ns}/${oldFact.evidence_ids[0]}.json`),'utf8'));
  delete oldEvidence.entity_ref.variant_observed_count;s.rewrite('evidence',oldEvidence.evidence_id,oldEvidence);
  const diff=JSON.parse(fs.readFileSync(path.join(f.dir,`diffs/${f.ns}/${s.event.diff_id}.json`),'utf8'));
  s.rewrite('diffs',diff.diff_id,{...diff,entity_ref:oldFact.entity_ref});s.rewrite('events',s.event.event_id,{...s.event,entity_ref:oldFact.entity_ref});
  const input=s.finish();assert.equal(input.coverage.event_ids.length,1);
  assert.deepEqual(p.recordObservation({job:input.job,now:input.now}).event_projections,[]);
  const valid=setup({available:null}),control=valid.finish();
  assert.equal(valid.old.fact.value.prices[0].available,null);
  const row=p.recordObservation({job:control.job,now:control.now}).event_projections[0];
  assert.ok(row);assert.equal(row.market,null);assert.equal(row.currency,null);assert.equal(row.new_price,12);
});

test('shared catalog raw is read and parsed once per invocation, then revalidated after tampering',()=>{
  const p=service(),s=setup({count:6}),input=s.finish();
  assert.equal(input.coverage.event_ids.length,6);
  const parse=Extract.parseProductPriceObservations,read=fs.readFileSync;
  const paths=[s.old.s,s.fresh.s].map(snap=>path.resolve(f.dir,snap.raw_payload_ref.path));
  function measured(){
    let parserCalls=0;const reads=new Map();
    Extract.parseProductPriceObservations=(...args)=>{parserCalls++;return parse(...args);};
    fs.readFileSync=function(file,...args){const key=typeof file==='string'?path.resolve(file):null;if(paths.includes(key))reads.set(key,(reads.get(key)||0)+1);return read.call(this,file,...args);};
    try{return {result:p.recordObservation({job:input.job,now:input.now}),parserCalls,reads};}
    finally{Extract.parseProductPriceObservations=parse;fs.readFileSync=read;}
  }
  const first=measured();assert.equal(first.result.event_projections.length,6);assert.equal(first.parserCalls,2);
  // One A integrity verification and one B content verification per raw snapshot,
  // independent of event count; no cache persists between calls.
  assert.ok(paths.every(p=>(first.reads.get(p)||0)<=2));
  const again=measured();assert.equal(again.parserCalls,2);assert.deepEqual(again.result.event_projections,first.result.event_projections);
  fs.writeFileSync(paths[1],'tampered between calls');
  const broken=measured();assert.deepEqual(broken.result.event_projections,[]);assert.ok(broken.result.issues.length);
  assert.ok((broken.reads.get(paths[1])||0)>=1);
});

test('revision replay returns original notification provenance and does not inflate scoped totals',()=>{
  const p=service(),s=setup(),input=s.finish();
  s.rewrite('events',s.event.event_id,{...s.event,note:'private note and raw_payload_ref path must not escape'});
  const original=p.recordObservation({job:input.job,now:input.now}).event_projections[0];assert.ok(original);
  assert.equal(JSON.stringify(original).includes('private note'),false);
  f.store.pauseWatchTarget(f.tenantId,s.target.watch_target_id,input.now+1);
  const resumed=f.store.resumeWatchTarget(f.tenantId,s.target.watch_target_id,input.now+2);
  assert.ok(resumed.revision>s.target.revision);
  const repeat=s.finish({revision:resumed.revision});
  assert.deepEqual(p.recordObservation({job:repeat.job,now:repeat.now}).event_projections,[original]);
  const page=p.list(f.tenantId,{workspaceId:s.target.workspace_id,projectId:s.target.project_id,competitorId:s.target.competitor_id});
  assert.equal(page.total,1);assert.equal(page.event_projections[0].revision,s.target.revision);assert.equal(page.event_projections[0].job_id,input.job.job_id);
});

test('projection schema is additive, transactionally installed and refuses unknown extension versions',()=>{
  const isolated=fixture();
  try {
    const workspace=isolated.workspace();
    assert.throws(()=>isolated.store.transaction(()=>{service(isolated.store);throw Error('DDL fault');}),/DDL fault/);
    assert.equal(isolated.store.getDb().prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='monitoring_event_projections'").get().n,0);
    service(isolated.store);assert.deepEqual(isolated.store.getWorkspace(isolated.tenantId,workspace.workspace_id),workspace);
    isolated.store.getDb().prepare("UPDATE monitoring_extension_schema SET version=999 WHERE name='event_projections'").run();
    assert.throws(()=>service(isolated.store),{code:'UNSUPPORTED_PROJECTION_SCHEMA'});
    assert.equal(isolated.store.getDb().prepare('PRAGMA user_version').get().user_version,1);
  }finally{isolated.cleanup();}
});

test('concurrent SQLite connections create exactly one immutable station row',async()=>{
  const p=service(),s=setup(),input=s.finish();
  const {Worker}=require('node:worker_threads');
  const source=`const {parentPort,workerData:w}=require('node:worker_threads');
    process.env.ZB_DATA_DIR=w.dir;delete process.env.MT_STORE_PATH;delete process.env.OBS_DB_PATH;
    global.fetch=()=>{throw Error('network forbidden');};
    const store=require(w.storePath).createMonitoringStore({dataDir:w.dir});
    const projection=require(w.projectionPath).createMonitoringProjection({store});
    parentPort.once('message',()=>{try{parentPort.postMessage({result:projection.recordObservation({job:w.job,now:w.now})});}
      catch(e){parentPort.postMessage({error:e.message});}finally{store.close();parentPort.close();}});
    parentPort.postMessage({ready:true});`;
  const workers=[0,1].map(i=>new Worker(source,{eval:true,workerData:{dir:f.dir,storePath:require.resolve('../services/monitoring-store'),projectionPath:implementationPath,job:input.job,now:input.now+i}}));
  try {
    await Promise.all(workers.map(w=>new Promise((resolve,reject)=>{w.once('message',v=>v.ready?resolve():reject(Error('worker not ready')));w.once('error',reject);})));
    const results=workers.map(w=>new Promise((resolve,reject)=>{w.once('message',v=>v.error?reject(Error(v.error)):resolve(v.result));w.once('error',reject);}));
    workers.forEach(w=>w.postMessage('go'));const [a,b]=await Promise.all(results);
    assert.equal(a.event_projections.length,1);assert.deepEqual(a.event_projections,b.event_projections);
    assert.equal(p.list(f.tenantId,{projectId:s.target.project_id,competitorId:s.target.competitor_id}).total,1);
  }finally{await Promise.all(workers.map(w=>w.terminate()));}
});

test('stored Coverage cannot authorize tampered raw or event content, wrong job refs, or failed supporting source',()=>{
  const p=service();
  for(const defect of ['raw','raw_rehashed','raw_product','raw_duplicate','raw_null','event','scope','empty_refs','failed_source','wrong_fact','wrong_provider']) {
    const s=setup(), input=s.finish(); assert.equal(input.coverage.event_ids.length,1,defect+' valid control');
    if(defect==='raw')fs.writeFileSync(path.join(f.dir,s.fresh.s.raw_payload_ref.path),'tampered');
    if(defect.startsWith('raw_')) {
      const raw=JSON.parse(fs.readFileSync(path.join(f.dir,s.fresh.s.raw_payload_ref.path),'utf8'));
      if(defect==='raw_rehashed')raw.products[0].variants[0].price='999';
      if(defect==='raw_product')raw.products[0].id=999999;
      if(defect==='raw_duplicate')raw.products.push(raw.products[0]);
      const bytes=Buffer.from(defect==='raw_null'?'null':JSON.stringify(raw));fs.writeFileSync(path.join(f.dir,s.fresh.s.raw_payload_ref.path),bytes);
      f.write(s.fresh.s.raw_payload_ref.path.replace(/\.raw$/,'.json'),{...s.fresh.s,raw_size:bytes.length,content_hash:'sha256:'+require('node:crypto').createHash('sha256').update(bytes).digest('hex')});
    }
    if(defect==='event')s.rewrite('events',s.event.event_id,{...s.event,new_price:999});
    if(defect==='scope')s.rewrite('events',s.event.event_id,{...s.event,tenant:{...s.event.tenant,tenant_id:'tenant?a'}});
    if(defect==='empty_refs')s.rewrite('events',s.event.event_id,{...s.event,new_evidence_ids:[]});
    if(defect==='failed_source'||defect==='wrong_provider') {
      const original=Snapshot.getById(f.tenantId,s.fresh.s.snapshot_id);
      f.write(original.raw_payload_ref.path.replace(/\.raw$/,'.json'),{...original,...(defect==='failed_source'?{source_status:'blocked',http_status:403}:{provider:'generic_web_fetch'})});
    }
    if(defect==='wrong_fact') {
      const wrong={...input.result,fact_ids:[s.old.fact.fact_id]};
      f.store.getDb().prepare('UPDATE monitoring_jobs SET result=? WHERE job_id=?').run(JSON.stringify(wrong),input.job.job_id);
    }
    const out=p.recordObservation({job:input.job,now:input.now});assert.deepEqual(out.event_projections,[],defect);assert.ok(out.issues.length,defect);
    assert.equal(p.list(f.tenantId,{projectId:s.target.project_id,competitorId:s.target.competitor_id}).total,0);
  }
});

test('only current completed job associations authorize new projection; incomplete attempts and changed revisions reject',()=>{
  const p=service(), s=setup(), input=s.finish();
  for(const patch of [{tenant_id:'tenant?a'},{target_id:'wrong'},{revision:99},{attempts:99}])assert.throws(()=>p.recordObservation({job:{...input.job,...patch},now:input.now}));
  f.store.pauseWatchTarget(f.tenantId,s.target.watch_target_id,input.now);
  assert.throws(()=>p.recordObservation({job:input.job,now:input.now}));
  assert.equal(p.list(f.tenantId,{projectId:s.target.project_id,competitorId:s.target.competitor_id}).total,0);
});

test('partial supported observations stay visible; failed jobs never become notifications; SQL failure rolls back without editing Event',()=>{
  const p=service(), s=setup();
  // Net marks even complete successfully fetched pages partial when later pages fail.
  f.write(s.fresh.s.raw_payload_ref.path.replace(/\.raw$/,'.json'),{...s.fresh.s,source_status:'partial',partial_scan:true,partial_scan_reason:'page_failed'});
  const input=s.finish({source_status:'partial',partial_scan:true});
  const before=JSON.stringify(Events.getEventById(f.tenantId,s.event.event_id));
  const db=f.store.getDb();db.exec("CREATE TEMP TRIGGER projection_fault BEFORE INSERT ON monitoring_event_projections BEGIN SELECT RAISE(ABORT,'synthetic projection failure'); END");
  assert.throws(()=>p.recordObservation({job:input.job,now:input.now}),/synthetic projection failure/);
  db.exec('DROP TRIGGER projection_fault');
  assert.equal(p.list(f.tenantId,{projectId:s.target.project_id,competitorId:s.target.competitor_id}).total,0);
  const out=p.recordObservation({job:input.job,now:input.now});assert.equal(out.event_projections.length,1);
  assert.ok(out.event_projections[0].limitations.includes('partial_scan'));
  assert.equal(JSON.stringify(Events.getEventById(f.tenantId,s.event.event_id)),before);
  const failure=setup(), failed=failure.finish({source_status:'blocked'});
  const blocked=p.recordObservation({job:failed.job,now:failed.now});assert.deepEqual(blocked.event_projections,[]);assert.ok(blocked.issues.includes('source_incomplete'));
});

test.after(()=>{f.cleanup();fs.rmSync(boot,{recursive:true,force:true});});
