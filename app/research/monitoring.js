'use strict';
const {createMonitoringStore}=require('../services/monitoring-store');
const {createMonitoringQueue}=require('../services/monitoring-queue');
const {createMonitoringScheduler,TICK_MS}=require('../services/monitoring-scheduler');
const {failure}=require('../services/monitoring-contracts');
const {nextSlot}=require('../services/monitoring-time');
const {requestScope}=require('../core/als');
const tenantDb=require('../services/db');
const {createCoverageService,observedReferences}=require('../services/monitoring-coverage');
const {createMonitoringProjection}=require('../services/monitoring-projection');
const LIMITATIONS=Object.freeze(['canonical_and_qualification_producers_not_connected','product_catalog_only','source_market_may_be_unknown','coverage_window_policy_not_implemented','external_notifications_not_implemented','scheduled_digest_not_implemented','canonical_collection_coalescing_not_implemented','qualification_reference_migration_not_implemented','provider_throttle_is_job_level','inflight_http_not_cancellable','filesystem_and_sqlite_not_globally_atomic']);
function activationIssues(){return process.env.SCHEDULER_ENABLED==='0'?['SCHEDULER_DISABLED']:process.env.FORMAL_MONITORING_ENABLED!=='1'?['FORMAL_MONITORING_DISABLED']:[];}
// M4 任务 C ExternalCallLedger（03 §20 / 07 §17）：formal 监控线每次真实直采调用入账。
// 免费公开端点按 cost profile（cp-eng-v0）记 0——profile 有条目，0 非伪造；outcome 用既有
// 真实形态（success/partial/failed/timeout），source 错误与采集异常 error_code 留真。
// 旁路观测：账本校验/存储失败只留 warn，绝不改变采集、投影与 job 收束（尽力而为）。
function ledgerCollectCall({job,target,source,startedAt,error}) {
  try {
    const CallLedger=require('../services/call-ledger');
    const CostProfile=require('../services/cost-profile');
    const est=CostProfile.estimate({provider:'shopify_products_json',operation:'direct_collect',requestUnits:1});
    let outcome='failed',errorCode=null;
    if(error){const m=String(error&&error.message||error);outcome=/timeout|abort/i.test(m)?'timeout':'failed';errorCode=m.slice(0,64);}
    else if(source){if(source.ok)outcome=source.partialScan?'partial':'success';else{outcome=/timeout|abort/i.test(String(source.error||''))?'timeout':'failed';errorCode=source.error?String(source.error).slice(0,64):null;}}
    CallLedger.recordCall({tenantId:job.tenant_id,projectId:target?.project_id||null,workspaceId:target?.workspace_id||null,watchTargetId:target?.watch_target_id||null,brandId:target?.brand_id||null,capability:'product_catalog',provider:'shopify_products_json',operation:'direct_collect',trigger:job.trigger,costProfileVersion:est.costProfileVersion,requestUnits:null,estimatedCost:est.estimatedCost,cacheHit:false,canonicalReuseHit:false,fallbackDepth:0,attemptNo:1,startedAt,completedAt:Date.now(),outcome,errorCode});
  } catch(e) {try{require('../services/logger').warn('call_ledger_write_failed',{error:String(e&&e.message||e).slice(0,120)});}catch{/* 观测失败不阻断 */}}
}
function checkTenant(tenantId){const tenant=tenantDb.getTenant(tenantId);if(!tenant)throw failure('TENANT_NOT_FOUND');if(tenant.status==='suspended')throw failure('TENANT_SUSPENDED');return tenant;}
function createMonitoringRuntime({store=createMonitoringStore(),queue,collect,clock=Date.now}={}) {
  queue=queue||createMonitoringQueue({store,clock});
  collect=collect||((url,opts)=>require('./net').fetchShopifyProducts(url,opts));
  const scheduler=createMonitoringScheduler({store,queue,checkTenant,clock});
  const coverage=createCoverageService({store}),projection=createMonitoringProjection({store});
  const dataDir=require('node:path').dirname(store.getDb().prepare('PRAGMA database_list').all().find(r=>r.name==='main').file);
  let stopped=false,timer=null,draining=null;
  const scopedKey=(tenantId,key)=>({scope:'tenant',tenantId,key});
  const inScope=(record,target)=>record?.tenant?.tenant_id===target.tenant_id&&record.tenant.project_ref===target.project_id;
  function assertRecheckTime(target,eventId) {
    const event=require('./domain-event').getEventById(target.tenant_id,eventId);
    if(!event||!inScope(event,target))throw failure('RECHECK_EVENT_SCOPE_UNVERIFIED');
    const Fact=require('./fact-store');
    const times=['old','new'].map(side=>{
      const fact=Fact.getFactById(target.tenant_id,event[side+'_fact_id']);
      const at=Date.parse(fact?.observed_at);
      if(!inScope(fact,target)||!Number.isFinite(at)||event['observed_at_'+side]!==fact.observed_at||(side==='new'&&at<target.created_at))throw failure('RECHECK_EVENT_TIME_UNVERIFIED');
      return at;
    });
    if(times[1]<=times[0]||!Number.isFinite(Date.parse(event.occurred_at))||Date.parse(event.occurred_at)<times[1])throw failure('RECHECK_EVENT_TIME_UNVERIFIED');
  }
  function snapshotIds(source){return [...new Set([...(source.snapshotIds||[]),source.snapshotId].filter(x=>typeof x==='string'))];}
  function sourceOutcome(source,target) {
    const Snapshot=require('./source-snapshot');
    const records=snapshotIds(source).map(id=>Snapshot.getById(target.tenant_id,id)).filter(r=>inScope(r,target));
    const statuses=records.map(r=>r.source_status);
    if(source.partialScan&&source.ok)return 'partial';
    if(source.ok)return statuses.includes('partial')?'partial':'success';
    return statuses.find(s=>!['success','partial'].includes(s))|| (source.empty?'success':Snapshot.classifyError(new Error(source.error||'source unavailable')).source_status)||'unavailable';
  }
  function assertCollectionScope(source,target) {
    const Snapshot=require('./source-snapshot');
    const mismatch=reason=>{throw failure('SOURCE_SCOPE_MISMATCH',409,[reason]);};
    const endpoint=(value,pathname)=>{
      try {const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname===target.source.domain&&u.pathname===pathname;}catch{return false;}
    };
    const products=snapshotIds(source);
    if(source.ok&&!products.length)mismatch('catalog_snapshot_missing');
    if(source.url&&!endpoint(source.url,'/products.json'))mismatch('catalog_url_mismatch');
    const check=(id,provider,pathname)=>{
      const snapshot=Snapshot.getById(target.tenant_id,id);
      if(!snapshot||!inScope(snapshot,target))mismatch('snapshot_tenant_or_project_mismatch');
      if(snapshot.provider!==provider||snapshot.capability!=='product_catalog')mismatch('snapshot_provider_or_capability_mismatch');
      if(!endpoint(snapshot.source_url,pathname)||(snapshot.final_url&&!endpoint(snapshot.final_url,pathname)))mismatch('snapshot_endpoint_mismatch');
    };
    for(const id of products)check(id,'shopify_products_json','/products.json');
    if(source.currencySnapshotId)check(source.currencySnapshotId,'shopify_cart_json','/cart.js');
  }
  function persist(source,target,job) {
    // Validate actual collection metadata before legacy extraction can stamp the
    // supplied anchorDomain onto Evidence/Fact. Raw remains append-only on failure.
    assertCollectionScope(source,target);
    const comp={id:target.competitor_id,name:null,url:target.source.url};
    require('./enrich').persistShopifyPriceEvidence({tenantId:target.tenant_id,projectId:target.project_id},comp,source,target.source.domain);
    const Fact=require('./fact-store');
    const Diff=require('./price-diff');
    const Events=require('./domain-event');
    const Snapshot=require('./source-snapshot');
    const snapshots=snapshotIds(source);
    const facts=[...new Map(snapshots.flatMap(id=>Fact.findFactsBySnapshot(target.tenant_id,id)).filter(f=>inScope(f,target)&&f.entity_ref?.domain===target.source.domain).map(f=>[f.fact_id,f])).values()];
    const factIds=new Set(facts.map(f=>f.fact_id));
    const issues=[];
    // Consume this batch's explicit detector output; no tenant-wide event scan.
    // Legacy comparison may find a baseline in a different project. Preserve its
    // files and diagnose the rejected association without changing that detector.
    const comparisons=(comp.factExtract?.comparisons||[]).filter(c=>factIds.has(c.fact_id)).map(c=>{
      if(!c.diff_id)return {...c};
      const d=Diff.getDiffById(target.tenant_id,c.diff_id);
      const old=d&&Fact.getFactById(target.tenant_id,d.old_fact_id),fresh=d&&Fact.getFactById(target.tenant_id,d.new_fact_id);
      if(!inScope(d,target)||d.new_fact_id!==c.fact_id||![old,fresh].every(f=>inScope(f,target)&&f.entity_ref?.domain===target.source.domain)){
        issues.push('comparison_outside_watch_scope');if(c.event_id)issues.push('event_outside_watch_scope');
        return {fact_id:c.fact_id,status:null,diff_id:null,event_id:null,reason:'comparison_outside_watch_scope'};
      }
      return {...c,status:d.status};
    });
    const events=comparisons.map(c=>c.event_id&&Events.getEventById(target.tenant_id,c.event_id)).filter(Boolean);
    if(source.empty)issues.push('empty_catalog');
    if(source.partialScan)issues.push(source.partialScanReason||'partial_scan');
    if(comp.evidenceExtract?.reason)issues.push('evidence_'+comp.evidenceExtract.reason);
    if(comp.factExtract?.reason)issues.push('fact_'+comp.factExtract.reason);
    if(!comp.priceMetric)issues.push('metric_'+(comp.factExtract?.metric_reason||'unavailable'));
    const sourceResults=[...new Set([...snapshots,source.currencySnapshotId].filter(Boolean))].map(id=>Snapshot.getById(target.tenant_id,id)).filter(s=>inScope(s,target)).map(s=>({snapshot_id:s.snapshot_id,provider:s.provider,source_status:s.source_status,http_status:s.http_status,observed_at:s.observed_at,collector_version:s.collector_version}));
    if(sourceResults.some(s=>s.provider==='shopify_cart_json'&&s.source_status!=='success'))issues.push('currency_source_unavailable');
    const result={schema_version:1,job_id:job.job_id,revision:target.revision,source_status:sourceOutcome(source,target),source_results:sourceResults,completed_at:clock(),snapshot_ids:snapshots,currency_snapshot_id:source.currencySnapshotId||null,fact_ids:[...factIds],diff_ids:[...new Set(comparisons.map(c=>c.diff_id).filter(Boolean))],event_ids:events.map(e=>e.event_id),comparisons,price_metric:comp.priceMetric||null,evidence_extract:comp.evidenceExtract||null,fact_extract:comp.factExtract||null,partial_scan:!!source.partialScan,issues};
    const proof=observedReferences(dataDir,target,result);
    const checkedComparisons=proof.fact_ids.map(id=>proof.comparisons.find(c=>c.fact_id===id)||{fact_id:id,status:null,diff_id:null,event_id:null,reason:'comparison_reference_unverified'});
    return {...result,fact_ids:proof.fact_ids,diff_ids:proof.diff_ids,event_ids:proof.event_ids,comparisons:checkedComparisons,issues:proof.issues,
      fact_extract:result.fact_extract?{...result.fact_extract,comparisons:checkedComparisons}:null};
  }
  async function execute(job) {
    let source=null,heartbeat=null,commitStarted=false,collectT0=0,target=null;
    try {
      if(stopped)throw failure('RUNTIME_STOPPED');
      checkTenant(job.tenant_id);
      queue.assertClaim(job.job_id,job.claim_token,clock());
      target=store.assertExecutable(job.tenant_id,job.target_id,job.revision);
      if(job.trigger==='recheck')assertRecheckTime(target,job.event_id);
      heartbeat=setInterval(()=>{try{queue.heartbeat(job.job_id,job.claim_token,clock());}catch{/* Final fencing still mandatory. */}},Math.max(1,Math.floor(queue.config.leaseMs/3)));
      heartbeat.unref?.();
      collectT0=Date.now();
      source=await requestScope.run(job.tenant_id,()=>collect(target.source.url,{tenantId:job.tenant_id,projectRef:target.project_id,trigger:job.trigger,rejectRedirects:true}));
      source=source||{ok:false,error:'source_unavailable'};
      ledgerCollectCall({job,target,source,startedAt:collectT0});
      // Synchronous commit only. SQLite fences the projection and job together;
      // append-only filesystem writes remain outside its rollback guarantee.
      store.transaction(()=>{
        if(stopped)throw failure('RUNTIME_STOPPED');
        checkTenant(job.tenant_id);queue.assertClaim(job.job_id,job.claim_token,clock());
        const current=store.assertExecutable(job.tenant_id,job.target_id,job.revision);
        if(job.trigger==='recheck')assertRecheckTime(current,job.event_id);
        const result=requestScope.run(job.tenant_id,()=>persist(source,current,job));
        commitStarted=true;
        if(!queue.finish(job.job_id,job.claim_token,result,clock()).ok)throw failure('CLAIM_INVALID');
        const observed=coverage.recordObservation({job,target:current,result,now:clock()});
        const projected=projection.recordObservation({job,now:clock()});
        store.setSchedulerState({...scopedKey(job.tenant_id,'result:'+job.target_id),value:{...result,coverage_id:observed.coverage_id,event_projection_ids:projected.event_projections.map(p=>p.notification_id),projection_issues:projected.issues}});
      });
    } catch(error) {
      const reason=error.code||'MONITORING_EXECUTION_FAILED';
      // M4-C 账本：collect 已开始但抛错（行尚未记）→ 补失败行；collect 之后的投影错误
      // 不补行（该次外部调用的行已随 collect 返回时记过），避免同一次调用双行。
      if(collectT0&&!source)ledgerCollectCall({job,target,source:null,startedAt:collectT0,error});
      const result={source_status:['TENANT_NOT_FOUND','TENANT_SUSPENDED','SOURCE_SCOPE_MISMATCH'].includes(reason)?'unavailable':'internal_error',reason,event_ids:[],snapshot_ids:source?snapshotIds(source):[],currency_snapshot_id:source?.currencySnapshotId||null,issues:['collection_or_projection_incomplete',...(error.issues||[])]};
      // Diagnostic history is separate from the fenced current result. It never
      // makes a stale token successful or projects onto a changed target.
      store.setSchedulerState({...scopedKey(job.tenant_id,'discarded:'+job.job_id+':'+job.attempts),value:{...result,at:clock()}});
      // A SQLite projection fault must not finish the rolled-back job separately.
      // The original lease remains recoverable. Current collection failures may
      // finish only under the same target/tenant fence and Coverage transaction.
      if(!stopped&&!commitStarted){try{store.transaction(()=>{
        if(['TENANT_NOT_FOUND','TENANT_SUSPENDED'].includes(reason)){queue.finish(job.job_id,job.claim_token,result,clock());return;}
        checkTenant(job.tenant_id);queue.assertClaim(job.job_id,job.claim_token,clock());
        const current=store.assertExecutable(job.tenant_id,job.target_id,job.revision);
        if(!queue.finish(job.job_id,job.claim_token,result,clock()).ok)throw failure('CLAIM_INVALID');
        coverage.recordObservation({job,target:current,result,now:clock()});
      });}catch{/* lease owner/claim recovery handles invalidated work */}}
    } finally {if(heartbeat)clearInterval(heartbeat);}
  }
  function tick(now=clock()){return stopped?{accepted:0,backpressure:false,issues:['RUNTIME_STOPPED']}:scheduler.tick(now);}
  function drain(now=clock()) {
    if(stopped)return Promise.resolve([]);
    if(draining)return draining;
    const work=[];
    for(let i=0;i<queue.config.globalConcurrency&&!stopped;i++){const job=queue.claim(now);if(!job)break;work.push(execute(job));}
    draining=Promise.all(work).finally(()=>{draining=null;});return draining;
  }
  function requestRecheck({tenantId,watchTargetId,eventId,now=clock()}){checkTenant(tenantId);const target=store.getWatchTarget(tenantId,watchTargetId);if(!target)throw failure('WATCH_TARGET_NOT_FOUND',404);store.assertExecutable(tenantId,watchTargetId,target.revision);assertRecheckTime(target,eventId);return queue.enqueue({tenantId,watchTargetId,trigger:'recheck',eventId,scheduledAt:now,now});}
  function targetStatus(tenantId,id) {
    const t=store.getWatchTarget(tenantId,id);if(!t)throw failure('WATCH_TARGET_NOT_FOUND',404);
    let issues=activationIssues();if(stopped)issues.push('RUNTIME_STOPPED');try{checkTenant(tenantId);}catch(e){issues.push(e.code);}
    try{store.assertExecutable(tenantId,t.watch_target_id,t.revision);}catch(e){issues.push(e.code,...(e.issues||[]));}
    const result=store.getSchedulerState(scopedKey(tenantId,'result:'+t.watch_target_id));let next=null;try{next=nextSlot(clock(),t.target_market_timezone);}catch(e){issues.push(e.code||'TIME_ZONE_ERROR');}
    return {watch_target_id:t.watch_target_id,workspace_id:t.workspace_id,project_id:t.project_id,competitor_id:t.competitor_id,brand_id:t.brand_id,category_scope:t.category_scope,market:t.market,target_market_timezone:t.target_market_timezone,current_qualification_result_id:t.current_qualification_result_id,monitoring_status:t.monitoring_status,monitoring_policy_id:t.monitoring_policy_id,user_priority:t.user_priority,revision:t.revision,created_at:t.created_at,paused_at:t.paused_at,effective:{executable:issues.length===0,issues:[...new Set(issues)]},next_slot:next,latest_result:result?.revision===t.revision?result:null};
  }
  function lastDiscarded(tenantId,job) {
    for(let attempt=job.attempts;attempt>0;attempt--){const result=store.getSchedulerState(scopedKey(tenantId,'discarded:'+job.job_id+':'+attempt));if(result)return {...result,attempt};}
    return null;
  }
  function status(tenantId,{workspaceId,projectId,competitorId,offset=0,limit=50}={}) {
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw failure('INVALID_PAGINATION',400);
    if(workspaceId&&!store.getWorkspace(tenantId,workspaceId))throw failure('WORKSPACE_NOT_FOUND',404);
    if((projectId!==undefined||competitorId!==undefined)&&!(typeof projectId==='string'&&/^[a-z0-9\u4e00-\u9fff-]+$/i.test(projectId)&&require('../core/safe-id').isSafeId(competitorId)))throw failure('INVALID_TARGET_FILTER',400);
    const enabledIssues=activationIssues();let tenantIssues=[];try{checkTenant(tenantId);}catch(e){tenantIssues=[e.code];}
    const allTargets=store.listWatchTargets(tenantId,workspaceId).filter(t=>!projectId||(t.project_id===projectId&&t.competitor_id===competitorId));
    const targets=allTargets.slice(offset,offset+limit).map(t=>targetStatus(tenantId,t.watch_target_id));
    let where=workspaceId?'tenant_id=? AND workspace_id=?':'tenant_id=?';const params=workspaceId?[tenantId,workspaceId]:[tenantId];
    if(projectId){where+=" AND target_id IN (SELECT id FROM monitoring_targets WHERE tenant_id=? AND json_extract(payload,'$.project_id')=? AND json_extract(payload,'$.competitor_id')=?)";params.push(tenantId,projectId,competitorId);}
    const rows=store.getDb().prepare(`SELECT * FROM monitoring_jobs WHERE ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`).all(...params,limit,offset);
    const jobs=rows.map(j=>({job_id:j.job_id,watch_target_id:j.target_id,workspace_id:j.workspace_id,revision:j.revision,status:j.status,trigger:j.trigger,window_key:j.window_key,event_id:j.event_id,scheduled_at:j.scheduled_at,schedule_lag:j.schedule_lag,lag_warning:j.schedule_lag>1800000,degraded_candidate:j.schedule_lag>3600000,source_status:j.source_status,result:j.result?JSON.parse(j.result):null,discarded:lastDiscarded(tenantId,j)}));
    const counts={pending:0,running:0,done:0,error:0,dead:0,oldest_age_ms:null,config_version:queue.config.version};
    for(const r of store.getDb().prepare(`SELECT status,COUNT(*) AS n FROM monitoring_jobs WHERE ${where} GROUP BY status`).all(...params))counts[r.status]=r.n;
    const oldest=store.getDb().prepare(`SELECT MIN(scheduled_at) AS at FROM monitoring_jobs WHERE ${where} AND status IN ('pending','running')`).get(...params).at;
    if(oldest!=null)counts.oldest_age_ms=Math.max(0,clock()-oldest);
    const targetIds=new Set(allTargets.map(t=>t.watch_target_id));
    const filters={workspaceId,projectId,competitorId,offset,limit},observations=coverage.list(tenantId,filters),notifications=projection.list(tenantId,filters);
    return {enabled:enabledIssues.length===0,running:!!timer,issues:[...enabledIssues,...tenantIssues],limitations:[...LIMITATIONS],workspaces:store.listWorkspaces(tenantId).filter(w=>!workspaceId||w.workspace_id===workspaceId).slice(offset,offset+limit),targets,jobs,counts,gaps:store.listSchedulerGaps(tenantId,workspaceId).filter(g=>targetIds.has(g.watch_target_id)).slice(offset,offset+limit),backpressure:allTargets.some(t=>!!store.getSchedulerState({scope:'tenant',tenantId,key:'due:'+t.watch_target_id+':'+t.revision})),offset,limit,total_targets:allTargets.length,total_jobs:store.getDb().prepare(`SELECT COUNT(*) AS n FROM monitoring_jobs WHERE ${where}`).get(...params).n,coverage:observations.coverage,total_coverage:observations.total,event_projections:notifications.event_projections,total_event_projections:notifications.total};
  }
  function start(){if(timer)return api;if(activationIssues().length)return api;stopped=false;const run=()=>{try{tick();drain().catch(()=>{});}catch{/* status/gap and next tick expose recovery */}};timer=setInterval(run,TICK_MS);timer.unref?.();run();return api;}
  function stop(){stopped=true;if(timer)clearInterval(timer);timer=null;}
  const api={store,queue,tick,drain,requestRecheck,status,targetStatus,start,stop};return api;
}
let singleton;function getMonitoringRuntime(){return singleton||(singleton=createMonitoringRuntime());}
module.exports={createMonitoringRuntime,getMonitoringRuntime,activationIssues,LIMITATIONS};
