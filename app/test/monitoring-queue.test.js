'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { fixture } = require('./monitoring-store.test');
const { createMonitoringQueue } = require('../services/monitoring-queue');
const fs=require('node:fs'),path=require('node:path');
function setup(config = {}) {
  const f = fixture(), w1 = f.workspace('one'), w2 = f.workspace('two');
  for(const w of [w1,w2])f.store.updateWorkspace({tenantId:f.tenantId,workspaceId:w.workspace_id,market:'US',timeZone:'UTC',now:0});
  f.t1 = f.store.createWatchTarget(f.seed(w1, '1').input); f.t2 = f.store.createWatchTarget(f.seed(w2, '2').input);
  f.q = createMonitoringQueue({ store: f.store, config: { providerMinIntervalMs: 1, ...config } });
  f.enq = (t, n) => {const scheduledAt=-7200000+n*28800000,iso=new Date(scheduledAt).toISOString();return f.q.enqueue({ tenantId: f.tenantId, watchTargetId: t.watch_target_id, trigger: 'monitor', scheduledAt, windowKey:iso.slice(0,10)+':'+iso.slice(11,13), now: 0 });};
  return f;
}
function eventFixture(f) {
  // Synthetic immutable server chain; not a real QualificationResult producer.
  const tenant={tenant_id:f.tenantId,project_ref:'project-1'},entity_ref={domain:'example.com'},entity_key='shopify:product:1';
  for(const [id,price] of [['old',10],['new',9]])f.write('facts/'+f.ns+'/'+id+'.json',{schema_version:1,fact_id:id,fact_type:'product_price',tenant,entity_ref,entity_key,market:'US',value:{price_min:price,price_max:price},evidence_ids:['ev1'],source_snapshot_ids:['ss1']});
  const diff={schema_version:1,diff_id:'diff1',tenant,entity_key,status:'changed',old_fact_id:'old',new_fact_id:'new',old_evidence_ids:['ev1'],new_evidence_ids:['ev1'],old_snapshot_ids:['ss1'],new_snapshot_ids:['ss1'],old_value:{price_min:10,price_max:10},new_value:{price_min:9,price_max:9}};
  const event={...diff,event_id:'evt1',event_type:'price_change_observed',entity_ref,provider:'shopify_products_json'};
  f.write('diffs/'+f.ns+'/diff1.json',diff);f.write('events/'+f.ns+'/evt1.json',event);return event;
}
test('Bounded capacity, idempotence, terminal history and persisted round-robin fairness', () => {
  const f = setup({ maxPending: 2 }); try {
    const a = f.enq(f.t1,0), b = f.enq(f.t2,0); assert.equal(f.enq(f.t1,0).job.job_id, a.job.job_id);
    assert.equal(f.enq(f.t1,1).backpressure,true);
    const c = f.q.claim(0); assert.equal(c.workspace_id,f.t1.workspace_id); assert.equal(f.q.claim(0),null);
    assert.equal(f.q.finish(c.job_id,c.claim_token,{ source_status:'success' },1).ok,true);
    assert.equal(f.q.claim(1).job_id,b.job.job_id);
    assert.equal(f.enq(f.t1,1).accepted,true);
  } finally { f.cleanup(); }
});
test('A-R1 lost catalog proof fences a previously admitted pending job and current execution',()=>{
  const f=setup();try {
    f.enq(f.t1,0);
    const p='snapshots/'+f.ns+'/20261017/ss1.json',snapshot=JSON.parse(fs.readFileSync(path.join(f.dir,p),'utf8'));
    f.write(p,{...snapshot,provider:'unrelated_source',capability:'reviews',source_url:'https://example.com/reviews',final_url:'https://example.com/reviews'});
    assert.throws(()=>f.store.assertExecutable(f.tenantId,f.t1.watch_target_id,1),{status:409});
    assert.equal(f.q.claim(0),null);assert.equal(f.q.stats(f.tenantId,undefined,0).error,1);
    assert.throws(()=>f.enq(f.t1,1),{status:409});
    f.write(p,snapshot);f.enq(f.t1,1);const running=f.q.claim(21600000);assert.ok(running);
    f.write(p,{...snapshot,capability:'reviews'});
    assert.throws(()=>f.q.assertClaim(running.job_id,running.claim_token,21600001),{status:409});
    assert.equal(f.q.finish(running.job_id,running.claim_token,{source_status:'success'},21600001).ok,false);
  }finally{f.cleanup();}
});
test('Only genuine fixed local windows are accepted; jitter preserves scheduled time',()=>{
  const f=setup({jitterMs:900000});try {
    const args={tenantId:f.tenantId,watchTargetId:f.t1.watch_target_id,trigger:'monitor',scheduledAt:0,windowKey:'1970-01-01:00',now:0};
    assert.throws(()=>f.q.enqueue(args),{status:400});
    assert.throws(()=>f.q.enqueue({...args,scheduledAt:undefined}),{status:400});
    const a=f.enq(f.t1,0);assert.equal(a.job.scheduled_at,-7200000);assert.ok(a.job.available_at>=-7200000&&a.job.available_at<=-6300000);
    assert.equal(f.q.claim(a.job.available_at-1),null);assert.equal(f.q.claim(a.job.available_at).job_id,a.job.job_id);
  }finally{f.cleanup();}
});
test('Expired leases fence old workers and bounded crash attempts end dead', () => {
  const f = setup({ leaseMs: 10, maxClaimAttempts: 2 }); try {
    f.enq(f.t1,0); const a=f.q.claim(0); const b=f.q.claim(10); assert.notEqual(a.claim_token,b.claim_token);
    assert.equal(f.q.finish(a.job_id,a.claim_token,{source_status:'success'},11).ok,false);
    assert.equal(f.q.heartbeat(a.job_id,a.claim_token,11).ok,false);
    assert.equal(f.q.claim(20),null); assert.equal(f.q.stats(f.tenantId,undefined,20).dead,1);
  } finally { f.cleanup(); }
});
test('Pause fences running completion and pending jobs never execute', () => {
  const f = setup(); try {
    f.enq(f.t1,0); const a=f.q.claim(0); f.store.pauseWatchTarget(f.tenantId,f.t1.watch_target_id,1);
    assert.equal(f.q.finish(a.job_id,a.claim_token,{source_status:'success'},2).ok,false);
    assert.throws(() => f.enq(f.t1,1), {status:409});
  } finally { f.cleanup(); }
});
test('Pausing pending work releases capacity and preserves an explicit unavailable terminal outcome',()=>{
  const f=setup({maxPending:1});try {
    f.enq(f.t1,0);f.store.pauseWatchTarget(f.tenantId,f.t1.watch_target_id,1);
    assert.equal(f.enq(f.t2,0).accepted,true);
    assert.equal(f.q.stats(f.tenantId).error,1);
  }finally{f.cleanup();}
});
test('Provider spacing, real two-connection claiming and attempt lag history survive restart',()=>{
  const f=setup({providerConcurrency:2,providerMinIntervalMs:100,globalConcurrency:2});let second;
  try {
    f.enq(f.t1,0);f.enq(f.t2,0);
    second=require('../services/monitoring-store').createMonitoringStore({dataDir:f.dir});
    const q2=createMonitoringQueue({store:second,config:{providerConcurrency:2,providerMinIntervalMs:100,globalConcurrency:2}});
    const a=f.q.claim(3600001);assert.equal(q2.claim(3600001),null);
    const b=q2.claim(3600101);assert.notEqual(a.job_id,b.job_id);assert.equal(f.q.claim(3600201),null);
    assert.equal(second.getDb().prepare('SELECT degraded_candidate FROM monitoring_claims WHERE job_id=?').get(a.job_id).degraded_candidate,1);
    assert.equal(q2.heartbeat(a.job_id,a.claim_token,3600201).ok,true);
    assert.equal(q2.finish(a.job_id,a.claim_token,{source_status:'blocked'},3600202).ok,true);
    assert.equal(q2.stats(f.tenantId,undefined,3600203).error,1);
  }finally{second?.close();f.cleanup();}
});
test('Queue config disagreement cannot bypass a shared capacity policy',()=>{
  const f=setup({maxPending:2});try {
    assert.throws(()=>createMonitoringQueue({store:f.store,config:{maxPending:3}}),{status:409});
    assert.throws(()=>createMonitoringQueue({store:f.store,config:{jitterMs:900001}}),{status:400});
  }finally{f.cleanup();}
});
test('Cursor only advances accepted windows, gap is separate and recheck cannot invent events',()=>{
  const f=setup({maxPending:1});try {
    const a=f.enq(f.t1,0);
    const args={tenantId:f.tenantId,watchTargetId:f.t1.watch_target_id,revision:f.t1.revision,observedAt:0};
    assert.throws(()=>f.store.saveSchedulerCursor({...args,acceptedJobId:'missing'}),{status:409});
    f.store.saveSchedulerCursor({...args,acceptedJobId:a.job.job_id});
    assert.equal(f.enq(f.t1,1).backpressure,true);
    assert.equal(f.store.getSchedulerCursor(f.tenantId,f.t1.watch_target_id,f.t1.revision).accepted_job_id,a.job.job_id);
    f.store.recordSchedulerGap({...args,from:0,to:1,reason:'scheduler_observation_gap'});
    assert.equal(f.store.listSchedulerGaps(f.tenantId).length,1);assert.equal(f.store.listSchedulerGaps('other').length,0);
    assert.throws(()=>f.q.enqueue({tenantId:f.tenantId,watchTargetId:f.t1.watch_target_id,trigger:'recheck',scheduledAt:0,eventId:'missing',now:0}),{status:409});
  }finally{f.cleanup();}
});
test('Recheck requires persisted current-scope event association, exact chain, and is idempotent without cursor mutation',()=>{
  const f=setup();try {
    const event=eventFixture(f),r={tenantId:f.tenantId,watchTargetId:f.t1.watch_target_id,trigger:'recheck',eventId:'evt1',scheduledAt:1,now:1};
    assert.throws(()=>f.q.enqueue(r),{status:409});
    const a=f.enq(f.t1,0),claim=f.q.claim(0);
    f.q.finish(claim.job_id,claim.claim_token,{source_status:'partial',event_ids:['evt1']},1);
    f.store.saveSchedulerCursor({tenantId:f.tenantId,watchTargetId:f.t1.watch_target_id,revision:1,observedAt:1,acceptedJobId:a.job.job_id});
    const b=f.q.enqueue(r);assert.equal(b.accepted,true);assert.equal(f.q.enqueue({...r,now:2}).job.job_id,b.job.job_id);
    assert.equal(f.store.getSchedulerCursor(f.tenantId,f.t1.watch_target_id,1).accepted_job_id,a.job.job_id);
    f.write('events/'+f.ns+'/evt1.json',{...event,old_evidence_ids:['other']});
    assert.equal(f.q.claim(2),null);
  }finally{f.cleanup();}
});
test('Scheduler technical KV separates tenant and system namespaces',()=>{
  const f=setup();try {
    f.store.setSchedulerState({scope:'tenant',tenantId:f.tenantId,key:'round-robin',value:{last:'w1'}});
    assert.equal(f.store.getSchedulerState({scope:'tenant',tenantId:'other',key:'round-robin'}),null);
    f.store.setSchedulerState({scope:'system',key:'round-robin',value:{last:'w2'}});
    assert.deepEqual(f.store.getSchedulerState({scope:'tenant',tenantId:f.tenantId,key:'round-robin'}),{last:'w1'});
    assert.throws(()=>f.store.getSchedulerState({scope:'system',tenantId:f.tenantId,key:'round-robin'}),{status:400});
  }finally{f.cleanup();}
});
test('Nested claim/finish transaction permits synchronous fenced commit and rolls back inner failures',()=>{
  const f=setup();try {
    f.enq(f.t1,0);const c=f.q.claim(0);
    const result=f.store.transaction(()=>{
      assert.equal(f.q.assertClaim(c.job_id,c.claim_token,1).job_id,c.job_id);
      assert.throws(()=>f.store.transaction(()=>{f.store.setSchedulerState({scope:'system',key:'rollback',value:1});throw new Error('rollback');}));
      assert.equal(f.store.getSchedulerState({scope:'system',key:'rollback'}),null);
      return f.q.finish(c.job_id,c.claim_token,{source_status:'success'},1);
    });assert.equal(result.ok,true);
    assert.throws(()=>f.store.transaction(()=>Promise.resolve()),{code:'ASYNC_TRANSACTION_FORBIDDEN'});
  }finally{f.cleanup();}
});
test('Simultaneous independent worker connections never claim a job twice or exceed capacity',async()=>{
  const f=setup({providerConcurrency:2,providerMinIntervalMs:1});
  try {
    f.enq(f.t1,0);f.enq(f.t2,0);
    const {Worker}=require('node:worker_threads');
    const results=await Promise.all([0,1,2,3].map(i=>new Promise((resolve,reject)=>{
      const worker=new Worker(`const {parentPort,workerData}=require('node:worker_threads');const s=require(workerData.store).createMonitoringStore({dataDir:workerData.dir});const q=require(workerData.queue).createMonitoringQueue({store:s,config:{providerConcurrency:2,providerMinIntervalMs:1}});const result=q.claim(100+workerData.i);s.close();parentPort.postMessage(result);`,{eval:true,workerData:{dir:f.dir,i,store:require.resolve('../services/monitoring-store'),queue:require.resolve('../services/monitoring-queue')}});
      worker.once('message',resolve);worker.once('error',reject);
    })));
    const claims=results.filter(Boolean);assert.ok(claims.length>=1&&claims.length<=2);assert.equal(new Set(claims.map(c=>c.job_id)).size,claims.length);
    assert.equal(f.q.stats(f.tenantId,undefined,104).running,claims.length);
  }finally{f.cleanup();}
});
test('Default 2000 bound survives 10x burst and durable restart', () => {
  const f = setup(); try {
    let accepted=0; for(let n=0;n<20000;n++) accepted += Number(f.enq(n%2?f.t2:f.t1,n).accepted);
    assert.equal(accepted,2000); assert.equal(f.q.stats(f.tenantId,undefined,0).pending,2000);
    const dir=f.dir; f.store.close(); f.store=require('../services/monitoring-store').createMonitoringStore({dataDir:dir});
    const q=createMonitoringQueue({store:f.store,config:{providerMinIntervalMs:1}}); assert.equal(q.stats(f.tenantId,undefined,0).pending,2000);
  } finally { f.cleanup(); }
});
