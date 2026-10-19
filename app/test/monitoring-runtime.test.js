'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const bootDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'vantage-runtime-boot-'));
process.env.ZB_DATA_DIR=bootDir;delete process.env.MT_STORE_PATH;delete process.env.OBS_DB_PATH;
const { fixture } = require('./monitoring-store.test');
// One DATA root, established before requiring any path-capturing runtime module.
const f = fixture();
const db = require('../services/db');
db.getTenant('initialize');
const tenantDb = new (require('node:sqlite').DatabaseSync)(process.env.MT_STORE_PATH);
tenantDb.prepare('INSERT INTO tenants(id,name,email,createdAt) VALUES(?,?,?,?)').run(f.tenantId,'Synthetic B fixture','','2026-10-17');
const { createMonitoringQueue } = require('../services/monitoring-queue');
let createMonitoringRuntime;
try { ({ createMonitoringRuntime } = require('../research/monitoring')); } catch (e) { if(e.code!=='MODULE_NOT_FOUND')throw e; }
let counter=0, now=Date.parse('2026-10-17T10:00:00Z');
const config={maxPending:1,providerMinIntervalMs:1,leaseMs:1000};
function setup(collect) {
  assert.equal(typeof createMonitoringRuntime,'function','formal runtime must exist');
  for(const name of ['monitoring_jobs','monitoring_targets','monitoring_workspaces','monitoring_cursors','monitoring_gaps','monitoring_dispatch','monitoring_provider','monitoring_idempotency','monitoring_scheduler_state','monitoring_coverage','monitoring_event_projections'])if(f.store.getDb().prepare('SELECT name FROM sqlite_master WHERE name=?').get(name))f.store.getDb().exec('DELETE FROM '+name);
  tenantDb.prepare('UPDATE tenants SET status=NULL WHERE id=?').run(f.tenantId);
  now=Date.parse('2026-10-17T10:00:00Z');
  const queue=createMonitoringQueue({store:f.store,config,clock:()=>now});
  const runtime=createMonitoringRuntime({store:f.store,queue,collect,clock:()=>now});
  const add=(w)=>{const seed=f.seed(w||f.workspace('w'+(++counter)),String(++counter));return {seed,target:f.store.createWatchTarget(seed.input)};};
  return {queue,runtime,add};
}
const jobs=()=>f.store.getDb().prepare('SELECT * FROM monitoring_jobs ORDER BY seq').all();
test('B-R1 formal www-only identity keeps exact HTTP, Snapshot, Evidence, Fact and Metric host; legacy stays compatible',async()=>{
  const {runtime}=setup();const w=f.workspace('www'+(++counter)),seed=f.seed(w,String(++counter));
  seed.project.competitors[0].url='https://www.example.com';f.write('research/'+f.ns+'/'+seed.input.projectId+'.json',seed.project);
  f.write('brands/'+seed.input.brandId+'.json',{schema_version:1,brand_id:seed.input.brandId,identity_status:'resolved',identity_version:'synthetic-1',official_domains:['www.example.com']});
  const proofPath='snapshots/'+f.ns+'/20261017/'+seed.ss+'.json',proof=JSON.parse(fs.readFileSync(path.join(f.dir,proofPath)));proof.source_url=proof.final_url='https://www.example.com/products.json';f.write(proofPath,proof);
  assert.equal(f.store.resolveAdmission(seed.input).ok,true);const target=f.store.createWatchTarget(seed.input);
  const dns=require('node:dns'),lookup=dns.promises.lookup;dns.promises.lookup=async()=>[{address:'93.184.216.34',family:4}];const hosts=[];
  // SC-02 r3：net.js 经 safeRequest（node:https 直连）抓取，打桩下沉到 https.request。
  const httpsMod=require('node:https'),{EventEmitter}=require('events');const origReq=httpsMod.request;
  httpsMod.request=function(opts,cb){hosts.push(opts.hostname);const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};
    req.end=()=>{const p=String(opts.path||'');const body=p.startsWith('/cart.js')?'{"currency":"USD"}':JSON.stringify({products:Array.from({length:6},(_,i)=>({id:990000+i,variants:[{id:9900000+i,price:'10.00',available:true}]}))});
      const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/json'};
      process.nextTick(()=>{cb(res);res.emit('data',Buffer.from(body));res.emit('end');});};
    return req;};
  try {
    runtime.tick(now);await runtime.drain(now);assert.deepEqual(hosts,['www.example.com','www.example.com']);
    const result=JSON.parse(jobs()[0].result);assert.equal(jobs()[0].status,'done');assert.ok(result.price_metric.metric_id);assert.equal(result.price_metric.value.median,10);
    const Snapshot=require('../research/source-snapshot'),Fact=require('../research/fact-store'),Evidence=require('../research/evidence-store'),Metric=require('../research/price-metric');
    for(const id of [...result.snapshot_ids,result.currency_snapshot_id]){const s=Snapshot.getById(f.tenantId,id);assert.equal(new URL(s.source_url).hostname,target.source.domain);assert.equal(new URL(s.final_url||s.source_url).hostname,target.source.domain);assert.equal(s.collector_version,'net-shopify-direct-2');}
    for(const id of result.fact_ids){const fact=Fact.getFactById(f.tenantId,id);assert.equal(fact.entity_ref.domain,target.source.domain);for(const eid of fact.evidence_ids)assert.equal(Evidence.getEvidenceById(f.tenantId,eid).entity_ref.domain,target.source.domain);}
    assert.equal(Metric.getMetricById(f.tenantId,result.price_metric.metric_id).domain,target.source.domain);
    hosts.length=0;const legacy=await require('../research/net').fetchShopifyProducts('https://www.example.com',{tenantId:f.tenantId,projectRef:seed.input.projectId});assert.deepEqual(hosts,['example.com','example.com']);assert.equal(Snapshot.getById(f.tenantId,legacy.snapshotId).collector_version,'net-1');
  }finally{dns.promises.lookup=lookup;httpsMod.request=origReq;}
});
test('B-R1 actual mismatched catalog/cart snapshots retain raw but never normalize or project',async()=>{
  for(const defect of ['source_host','final_host','provider','capability','project','cart_host']){
    let target;const {runtime,add}=setup(async()=>{
      const Snapshot=require('../research/source-snapshot');
      const product=Snapshot.record({tenantId:f.tenantId,projectRef:defect==='project'?'another-project':target.project_id,capability:defect==='capability'?'reviews':'product_catalog',provider:defect==='provider'?'generic_web_fetch':'shopify_products_json',source_url:'https://'+(defect==='source_host'?'www.example.com':'example.com')+'/products.json',final_url:'https://'+(defect==='final_host'?'www.example.com':'example.com')+'/products.json',http_status:200,source_status:'success',observed_at:new Date().toISOString(),bodyBytes:Buffer.from(JSON.stringify({products:[{id:880000+counter,variants:[{id:8800000+counter,price:'15.00',available:true}]}]}))});
      const cart=Snapshot.record({tenantId:f.tenantId,projectRef:target.project_id,capability:'storefront_currency',provider:'shopify_cart_js_json',source_url:'https://'+(defect==='cart_host'?'www.example.com':'example.com')+'/cart.js',source_status:'success',http_status:200,observed_at:new Date().toISOString(),bodyBytes:Buffer.from('{"currency":"USD"}')});
      return {ok:true,url:'https://example.com/products.json',snapshotIds:[product.meta.snapshot_id],currencySnapshotId:cart.meta.snapshot_id};
    });target=add().target;runtime.tick(now);await runtime.drain(now);
    const result=JSON.parse(jobs()[0].result);assert.equal(jobs()[0].status,'error',defect);assert.equal(result.reason,'SOURCE_SCOPE_MISMATCH');assert.equal(result.source_status,'unavailable');
    assert.equal(runtime.status(f.tenantId).targets[0].latest_result,null);const Snapshot=require('../research/source-snapshot');assert.ok(Snapshot.readRawPayload(Snapshot.getById(f.tenantId,result.currency_snapshot_id)));for(const id of result.snapshot_ids){assert.ok(Snapshot.readRawPayload(Snapshot.getById(f.tenantId,id)));assert.equal(require('../research/fact-store').findFactsBySnapshot(f.tenantId,id).length,0);assert.equal(require('../research/evidence-store').findEvidenceBySnapshot(f.tenantId,id).length,0);}
  }
});
test('three fixed windows, repeat ticks, restart, offline users and observation gaps',async()=>{
  const {runtime,queue,add}=setup(async()=>({ok:false,empty:true}));add();
  for(const slot of ['2026-10-17T10:00:00Z','2026-10-17T18:00:00Z','2026-10-18T02:00:00Z']){
    now=Date.parse(slot);runtime.tick(now);runtime.tick(now);await runtime.drain(now);
  }
  assert.equal(jobs().length,3);assert.ok(jobs().every(j=>j.source_status!=='no_change'));
  const restarted=createMonitoringRuntime({store:f.store,queue,clock:()=>now,collect:async()=>{throw Error('must not collect');}});
  restarted.tick(now);assert.equal(jobs().length,3);
  now+=24*3600000+3600000;restarted.tick(now);assert.equal(jobs().length,3);
  assert.ok(f.store.listSchedulerGaps(f.tenantId).length>0);
});
test('a newly due window tolerates 31 seconds and 15 minutes, beyond tolerance is a visible gap',()=>{
  for(const delay of [31000,900000,900001]){
    const {runtime,add}=setup(async()=>({ok:false}));add();const due=now;now=due-1000;runtime.tick(now);now=due+delay;runtime.tick(now);
    assert.equal(jobs().length,delay<=900000?1:0,'delay '+delay);
    if(delay<=900000)assert.equal(jobs()[0].scheduled_at,due);
    else assert.ok(f.store.listSchedulerGaps(f.tenantId).some(g=>g.reason==='unobserved_window_outside_tolerance'&&g.window_key==='2026-10-17:06'));
  }
});
test('capacity one enqueue fairness persists across restart and preserves scheduled time',async()=>{
  const {runtime,queue,add}=setup(async()=>({ok:false,empty:true}));
  const large=f.workspace('large'+(++counter)),small=f.workspace('small'+(++counter));
  for(let i=0;i<8;i++)add(large);add(small);
  runtime.tick(now);assert.equal(jobs().length,1);const first=jobs()[0];await runtime.drain(now);
  now+=60001;
  const restarted=createMonitoringRuntime({store:f.store,queue,clock:()=>now,collect:async()=>({ok:false,empty:true})});
  restarted.tick(now);assert.equal(jobs().length,2);assert.notEqual(jobs()[1].workspace_id,first.workspace_id);
  assert.equal(jobs()[1].scheduled_at,first.scheduled_at);await restarted.drain(now);assert.equal(jobs()[1].schedule_lag,60001);
});
test('backpressured pending intentions still record a scheduler observation outage',async()=>{
  const {runtime,add}=setup(async()=>({ok:false,empty:true}));add();add();runtime.tick(now);
  now+=9*3600000;runtime.tick(now);
  assert.ok(f.store.listSchedulerGaps(f.tenantId).length>=2,'both queued and backpressured targets need gap diagnostics');
});
test('pending intent crossing a second window explicitly records the omitted window',()=>{
  const {runtime,add}=setup(async()=>({ok:false}));const a=add(),b=add();runtime.tick(now);
  const target=jobs()[0].target_id===a.target.watch_target_id?b.target:a.target;
  now+=8*3600000;runtime.tick(now);
  assert.ok(f.store.listSchedulerGaps(f.tenantId).some(g=>g.watch_target_id===target.watch_target_id&&g.reason==='pending_window_backpressure'&&g.window_key==='2026-10-17:14'));
});
test('missing and suspended real tenants never call collector',async()=>{
  let calls=0;const {runtime,add}=setup(async()=>{calls++;return {ok:false};});add();
  runtime.tick(now);tenantDb.prepare("UPDATE tenants SET status='suspended' WHERE id=?").run(f.tenantId);
  await runtime.drain(now);assert.equal(calls,0);assert.equal(jobs()[0].source_status,'unavailable');
  tenantDb.prepare('DELETE FROM tenants WHERE id=?').run(f.tenantId);runtime.tick(now);
  assert.ok(runtime.status(f.tenantId).targets[0].effective.issues.includes('TENANT_NOT_FOUND'));
  tenantDb.prepare('INSERT INTO tenants(id,name,email,createdAt) VALUES(?,?,?,?)').run(f.tenantId,'Synthetic','','2026-10-17');
});
test('pause and stop while collecting fence normalization and retain collection references',async()=>{
  for(const mode of ['pause','stop','lease','token']){
    let release;const {runtime,queue,add}=setup(()=>new Promise(r=>release=r));const {target}=add();runtime.tick(now);
    const draining=runtime.drain(now);await Promise.resolve();
    if(mode==='pause')f.store.pauseWatchTarget(f.tenantId,target.watch_target_id,now);
    if(mode==='stop')runtime.stop();if(mode==='lease')now+=1001;
    if(mode==='token'){now+=1001;assert.ok(queue.claim(now));}
    release({ok:true,snapshotIds:['late-raw'],items:[]});await draining;
    assert.notEqual(jobs()[0].status,'done');
    assert.equal(runtime.status(f.tenantId).jobs[0].discarded.reason,mode==='stop'?'RUNTIME_STOPPED':'CLAIM_INVALID');
    assert.equal(runtime.status(f.tenantId).targets[0].latest_result,null);
    assert.equal(runtime.status(f.tenantId).total_coverage,0);assert.equal(runtime.status(f.tenantId).total_event_projections,0);
    if(mode==='stop')assert.ok(runtime.status(f.tenantId).targets[0].effective.issues.includes('RUNTIME_STOPPED'));
  }
});
test('real Net to M1 keeps baseline, emits observed price event, preserves project and rejects market-null recheck without HTTP',async()=>{
  const {runtime,add}=setup();const {target,seed}=add();
  const dns=require('node:dns'), lookup=dns.promises.lookup;dns.promises.lookup=async()=>[{address:'93.184.216.34',family:4}];
  const httpsMod=require('node:https'),{EventEmitter}=require('events');const origReq=httpsMod.request;
  let calls=0, price='10.00';httpsMod.request=function(opts,cb){calls++;const u=new URL('https://'+opts.hostname+String(opts.path||'/'));assert.equal(u.hostname,'example.com');
    const body=u.pathname==='/cart.js'?'{"currency":"USD"}':JSON.stringify({products:[{id:counter,title:'Synthetic',variants:[{id:counter*10,price,available:true}]}]});
    const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/json'};
      process.nextTick(()=>{cb(res);res.emit('data',Buffer.from(body));res.emit('end');});};return req;};
  try{
    runtime.tick(now);await runtime.drain(now);let result=JSON.parse(jobs()[0].result);
    assert.equal(result.source_status,'success');assert.ok(result.price_metric.metric_id);assert.equal(result.price_metric.market,null);assert.deepEqual(result.event_ids,[]);
    assert.equal(result.comparisons.length,1);assert.equal(result.comparisons[0].reason,'no_previous_fact');
    assert.equal(runtime.status(f.tenantId).coverage[0].quiet.allowed,false);
    const projectPath=path.join(f.dir,'research',f.ns,seed.input.projectId+'.json');
    const original=JSON.parse(fs.readFileSync(projectPath));original.userNote='saved during monitoring';f.write('research/'+f.ns+'/'+seed.input.projectId+'.json',original);
    await new Promise(r=>setTimeout(r,5));price='12.00';now+=8*3600000;runtime.tick(now);await runtime.drain(now);
    result=JSON.parse(jobs()[1].result);assert.equal(result.event_ids.length,1);assert.equal(JSON.parse(fs.readFileSync(projectPath)).userNote,'saved during monitoring');
    assert.equal(result.diff_ids.length,1);assert.equal(result.comparisons[0].status,'changed');
    const status=runtime.status(f.tenantId);assert.equal(status.total_coverage,2);assert.equal(status.total_event_projections,1);
    assert.equal(status.event_projections[0].market,null);assert.equal(status.event_projections[0].new_value.price_min,12);
    assert.equal(status.event_projections[0].external_delivery_blocked,true);assert.equal(status.coverage[0].event_ids[0],result.event_ids[0]);
    assert.equal(status.targets[0].latest_result.coverage_id,status.coverage[0].coverage_id);
    const before=calls;assert.throws(()=>runtime.requestRecheck({tenantId:f.tenantId,watchTargetId:target.watch_target_id,eventId:result.event_ids[0],now}),{code:'RECHECK_EVENT_SCOPE_UNVERIFIED'});
    await runtime.drain(now);assert.equal(calls,before);assert.equal(jobs().length,2);
    await new Promise(r=>setTimeout(r,5));now+=8*3600000;runtime.tick(now);await runtime.drain(now);
    const equal=JSON.parse(jobs()[2].result);assert.equal(equal.comparisons[0].status,'no_meaningful_change');assert.deepEqual(equal.event_ids,[]);
    const unchanged=runtime.status(f.tenantId);assert.equal(unchanged.total_event_projections,1);assert.equal(unchanged.coverage[0].quiet.allowed,false);
    const restarted=createMonitoringRuntime({store:f.store,queue:runtime.queue,clock:()=>now});
    const paged=restarted.status(f.tenantId,{projectId:target.project_id,competitorId:target.competitor_id,offset:1,limit:1});
    assert.equal(paged.total_coverage,3);assert.equal(paged.coverage.length,1);assert.equal(paged.total_event_projections,1);assert.deepEqual(paged.event_projections,[]);
    const missing=restarted.status(f.tenantId,{projectId:'other',competitorId:'other'});assert.equal(missing.total_coverage,0);assert.equal(missing.total_event_projections,0);
  }finally{dns.promises.lookup=lookup;httpsMod.request=origReq;}
});
test('direct HTTP blocked, parse failure, empty and partial keep explicit outcomes and supported references',async()=>{
  const {runtime,add}=setup();add();const dns=require('node:dns'),lookup=dns.promises.lookup;dns.promises.lookup=async()=>[{address:'93.184.216.34',family:4}];
  const timeout=global.setTimeout;global.setTimeout=(fn,ms,...args)=>timeout(fn,ms===2000?0:ms,...args);
  const httpsMod=require('node:https'),{EventEmitter}=require('events');const origReq=httpsMod.request;
  let scenario='blocked';httpsMod.request=function(opts,cb){const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};
    req.end=()=>{const u=new URL('https://'+opts.hostname+String(opts.path||'/'));let status=200,body;
      if(u.pathname==='/cart.js'){body='{"currency":"USD"}';}
      else if(scenario==='blocked'){status=403;body='blocked';}
      else if(scenario==='parse'){body='{broken';}
      else if(scenario==='empty'){body='{"products":[]}';}
      else if(u.searchParams.get('page')==='2'){status=403;body='blocked';}
      else body=JSON.stringify({products:Array.from({length:250},(_,i)=>i?{id:i+1000,variants:[]}:{id:999,title:'Synthetic',variants:[{id:9990,price:'10.00',available:true}]})});
      const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':'application/json'};
      process.nextTick(()=>{cb(res);res.emit('data',Buffer.from(body));res.emit('end');});};
    return req;};
  try {for(const [kind,outcome] of [['blocked','blocked'],['parse','parse_failed'],['empty','success'],['partial','partial']]){
    scenario=kind;runtime.tick(now);await runtime.drain(now);const result=JSON.parse(jobs().at(-1).result);assert.equal(result.source_status,outcome);assert.ok(result.snapshot_ids.length);assert.equal(result.no_change,undefined);assert.equal(result.freshness,undefined);
    assert.ok(result.source_results.every(s=>s.collector_version==='net-shopify-direct-2'));
    const c=runtime.status(f.tenantId).coverage[0];assert.equal(c.source_status,outcome);assert.equal(c.quiet.allowed,false);
    if(kind==='empty')assert.ok(result.issues.includes('empty_catalog'));if(kind==='partial'){assert.equal(result.partial_scan,true);assert.ok(result.price_metric.metric_id);assert.ok(result.issues.length);}
    now+=8*3600000;
  }}finally{dns.promises.lookup=lookup;global.setTimeout=timeout;httpsMod.request=origReq;}
});
test('formal pre-fetch SSRF rejection records its actual collector version without HTTP',async()=>{
  const {runtime,add}=setup();add();const dns=require('node:dns'),lookup=dns.promises.lookup;dns.promises.lookup=async()=>[{address:'127.0.0.1',family:4}];
  const httpsMod=require('node:https');const origReq=httpsMod.request;let calls=0;httpsMod.request=function(){calls++;throw Error('forbidden');};
  try {runtime.tick(now);await runtime.drain(now);const result=JSON.parse(jobs()[0].result);assert.equal(calls,0);assert.equal(result.source_status,'blocked');assert.equal(result.source_results[0].collector_version,'net-shopify-direct-2');}
  finally{dns.promises.lookup=lookup;httpsMod.request=origReq;}
});
test('formal cart and catalog HTTP redirects never reach an unvalidated destination',async()=>{
  const {runtime,add}=setup();const {target}=add();const dns=require('node:dns'),lookup=dns.promises.lookup;dns.promises.lookup=async()=>[{address:'93.184.216.34',family:4}];
  let destinationRequests=0;
  const httpsMod=require('node:https'),{EventEmitter}=require('events');const origReq=httpsMod.request;
  httpsMod.request=function(opts,cb){if(String(opts.hostname)==='127.0.0.1')destinationRequests++;
    const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};
    req.end=()=>{const res=new EventEmitter();res.statusCode=302;res.headers={location:'http://127.0.0.1/private'};
      process.nextTick(()=>{cb(res);res.emit('data',Buffer.from('redirect response retained'));res.emit('end');});};
    return req;};
  try {runtime.tick(now);await runtime.drain(now);assert.equal(destinationRequests,0);
    const result=JSON.parse(jobs()[0].result);assert.equal(result.source_status,'unavailable');
    assert.equal(result.source_results.length,2);assert.ok(result.source_results.every(r=>r.source_status==='unavailable'));
    const Snapshot=require('../research/source-snapshot');for(const id of [...result.snapshot_ids,result.currency_snapshot_id]){const s=Snapshot.getById(target.tenant_id,id);assert.equal(s.http_status,302);assert.equal(s.collector_version,'net-shopify-direct-2');assert.equal(s.parser_version,null);}
  }finally{dns.promises.lookup=lookup;httpsMod.request=origReq;}
});
test('heartbeat maintains a long collection lease and stop prevents another dispatch',async()=>{
  const {runtime,add}=setup(async()=>{await new Promise(r=>setTimeout(r,1250));return {ok:false,empty:true};});add();runtime.tick(now);
  const time=setInterval(()=>{now+=100;},100);try{await runtime.drain(now);}finally{clearInterval(time);}
  assert.equal(jobs()[0].status,'done');runtime.stop();now+=8*3600000;runtime.tick(now);await runtime.drain(now);assert.equal(jobs().length,1);
});
test('same-tenant legacy events comparing another project are not associated with a watch result',async()=>{
  const {runtime,add}=setup();const first=add();const dns=require('node:dns'),lookup=dns.promises.lookup;dns.promises.lookup=async()=>[{address:'93.184.216.34',family:4}];
  const httpsMod=require('node:https'),{EventEmitter}=require('events');const origReq=httpsMod.request;
  let price='20.00';httpsMod.request=function(opts,cb){const p=String(opts.path||'/');const body=p.startsWith('/cart.js')?'{"currency":"USD"}':JSON.stringify({products:[{id:777777,variants:[{id:7777770,price,available:true}]}]});
    const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};req.end=()=>{const res=new EventEmitter();res.statusCode=200;res.headers={'content-type':'application/json'};
      process.nextTick(()=>{cb(res);res.emit('data',Buffer.from(body));res.emit('end');});};return req;};
  try {runtime.tick(now);await runtime.drain(now);f.store.pauseWatchTarget(f.tenantId,first.target.watch_target_id,now);
    const second=add();price='15.00';await new Promise(r=>setTimeout(r,5));now+=8*3600000;runtime.tick(now);await runtime.drain(now);
    const result=JSON.parse(jobs().at(-1).result);assert.equal(result.fact_ids.length,1);assert.deepEqual(result.event_ids,[]);
    const events=require('../research/domain-event').listEvents(f.tenantId);const generated=events.find(e=>e.new_fact_id===result.fact_ids[0]);assert.ok(generated,'legacy detector retains its existing event behavior');
    assert.throws(()=>runtime.requestRecheck({tenantId:f.tenantId,watchTargetId:second.target.watch_target_id,eventId:generated.event_id,now}),{code:'RECHECK_EVENT_SCOPE_UNVERIFIED'});
    assert.ok(result.issues.includes('event_outside_watch_scope'));
    assert.deepEqual(result.diff_ids,[]);assert.equal(result.comparisons[0].status,null);assert.equal(result.comparisons[0].reason,'comparison_outside_watch_scope');
    assert.equal(runtime.status(f.tenantId).total_event_projections,0);
  }finally{dns.promises.lookup=lookup;httpsMod.request=origReq;}
});
test('synthetic market-proven recheck preserves a pre-join baseline, is idempotent and rejects missing times',async()=>{
  let calls=0;const {runtime,queue}=setup(async(_url,opts)=>{calls++;assert.equal(opts.trigger,'recheck');return {ok:false,empty:true};});
  const seed=f.seed(f.workspace('recheck'+(++counter)),String(++counter));seed.input.now=Date.parse('2026-10-17T01:30:00Z');const target=f.store.createWatchTarget(seed.input);runtime.tick(now);
  const tenant={tenant_id:f.tenantId,project_ref:target.project_id},entity_ref={domain:'example.com'},entity_key='synthetic:recheck';
  const oldAt='2026-10-17T01:00:00Z',newAt='2026-10-17T02:00:00Z';
  for(const [id,price,at] of [['b-old',10,oldAt],['b-new',9,newAt]])f.write('facts/'+f.ns+'/'+id+'.json',{schema_version:1,fact_id:id,tenant,entity_ref,entity_key,market:'US',observed_at:at,value:{price_min:price,price_max:price},evidence_ids:[seed.ev],source_snapshot_ids:[seed.ss]});
  const diff={schema_version:1,diff_id:'b-diff',tenant,entity_key,status:'changed',old_fact_id:'b-old',new_fact_id:'b-new',old_evidence_ids:[seed.ev],new_evidence_ids:[seed.ev],old_snapshot_ids:[seed.ss],new_snapshot_ids:[seed.ss],old_value:{price_min:10,price_max:10},new_value:{price_min:9,price_max:9}};
  const event={...diff,event_id:'b-event',event_type:'price_change_observed',entity_ref,provider:'shopify_products_json',occurred_at:newAt,observed_at_old:oldAt,observed_at_new:newAt};
  f.write('diffs/'+f.ns+'/b-diff.json',diff);f.write('events/'+f.ns+'/b-event.json',event);
  const claim=queue.claim(now);queue.finish(claim.job_id,claim.claim_token,{source_status:'partial',event_ids:['b-event']},now);
  const cursor=f.store.getSchedulerCursor(f.tenantId,target.watch_target_id,target.revision);
  const args={tenantId:f.tenantId,watchTargetId:target.watch_target_id,eventId:'b-event',now};
  f.write('events/'+f.ns+'/b-event.json',{...event,observed_at_old:null});assert.throws(()=>runtime.requestRecheck(args),{code:'RECHECK_EVENT_TIME_UNVERIFIED'});assert.equal(calls,0);
  f.write('events/'+f.ns+'/b-event.json',event);
  const result=runtime.requestRecheck(args);assert.equal(result.accepted,true);assert.equal(runtime.requestRecheck(args).job.job_id,result.job.job_id);
  assert.deepEqual(f.store.getSchedulerCursor(f.tenantId,target.watch_target_id,target.revision),cursor);
  now++;await runtime.drain(now);assert.equal(calls,1);assert.equal(jobs().at(-1).trigger,'recheck');
});
test('SQLite Coverage failure rolls job finish and current result back together',async()=>{
  const {runtime,add}=setup(async()=>({ok:false,empty:true}));add();runtime.tick(now);
  f.store.getDb().exec("CREATE TEMP TRIGGER coverage_fault BEFORE INSERT ON monitoring_coverage BEGIN SELECT RAISE(ABORT,'synthetic coverage failure'); END");
  try {await runtime.drain(now);assert.equal(jobs()[0].status,'running');assert.equal(jobs()[0].result,null);assert.equal(runtime.status(f.tenantId).targets[0].latest_result,null);assert.equal(runtime.status(f.tenantId).total_coverage,0);}
  finally {f.store.getDb().exec('DROP TRIGGER coverage_fault');}
});

test('real partial Net event is visible; projection and current-result SQLite faults roll all new SQL state back',async()=>{
  for(const mode of ['partial','projection','current']) {
    const {runtime,add}=setup();add();const productId=600000+counter;
    const dns=require('node:dns'),lookup=dns.promises.lookup;dns.promises.lookup=async()=>[{address:'93.184.216.34',family:4}];
    const timeout=global.setTimeout;global.setTimeout=(fn,ms,...args)=>timeout(fn,ms===2000?0:ms,...args);
    const httpsMod=require('node:https'),{EventEmitter}=require('events');const origReq=httpsMod.request;
    let price='10';let partial=false;
    httpsMod.request=function(opts,cb){const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};
      req.end=()=>{const u=new URL('https://'+opts.hostname+String(opts.path||'/'));let status=200,body;
        if(u.pathname==='/cart.js')body='{"currency":"USD"}';
        else if(partial&&u.searchParams.get('page')==='2'){status=403;body='blocked';}
        else{const product={id:productId,variants:[{id:productId*10,price,available:true}]};
          body=JSON.stringify({products:partial?[product,...Array.from({length:249},(_,i)=>({id:productId+i+1,variants:[]}))]:[product]});}
        const res=new EventEmitter();res.statusCode=status;res.headers={'content-type':'application/json'};
        process.nextTick(()=>{cb(res);res.emit('data',Buffer.from(body));res.emit('end');});};
      return req;};
    try {
      runtime.tick(now);await runtime.drain(now);const first=runtime.status(f.tenantId).targets[0].latest_result;assert.ok(first.coverage_id);
      await new Promise(r=>setTimeout(r,5));price='12';partial=mode==='partial';now+=8*3600000;
      if(mode==='projection')f.store.getDb().exec("CREATE TEMP TRIGGER runtime_fault BEFORE INSERT ON monitoring_event_projections BEGIN SELECT RAISE(ABORT,'projection fault'); END");
      if(mode==='current')f.store.getDb().exec("CREATE TEMP TRIGGER runtime_fault BEFORE INSERT ON monitoring_scheduler_state WHEN NEW.key LIKE 'result:%' BEGIN SELECT RAISE(ABORT,'current result fault'); END");
      runtime.tick(now);await runtime.drain(now);const status=runtime.status(f.tenantId);
      if(mode==='partial'){
        assert.equal(status.coverage[0].source_status,'partial');assert.equal(status.coverage[0].quiet.allowed,false);assert.equal(status.event_projections.length,1);
        assert.ok(status.event_projections[0].limitations.includes('partial_scan'));assert.equal(status.event_projections[0].new_value.price_min,12);
      }else{
        assert.equal(jobs()[1].status,'running');assert.equal(jobs()[1].result,null);assert.equal(status.total_coverage,1);assert.equal(status.total_event_projections,0);
        assert.deepEqual(status.targets[0].latest_result,first);
        assert.ok(require('../research/domain-event').listEvents(f.tenantId).some(e=>String(e.entity_ref?.product_id)===String(productId)),'append-only Event remains outside SQLite rollback');
      }
    }finally {if(mode!=='partial')f.store.getDb().exec('DROP TRIGGER IF EXISTS runtime_fault');dns.promises.lookup=lookup;global.setTimeout=timeout;httpsMod.request=origReq;}
  }
});
test.after(()=>{tenantDb.close();db.closeDb();f.cleanup();fs.rmSync(bootDir,{recursive:true,force:true});});
