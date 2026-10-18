'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const bootFs=require('node:fs'),bootDir=bootFs.mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'vantage-api-boot-'));
process.env.ZB_DATA_DIR=bootDir;delete process.env.MT_STORE_PATH;delete process.env.OBS_DB_PATH;
const {fixture}=require('./monitoring-store.test');const f=fixture();
let tenantConnection;
let createMonitoringHandler;try{({createMonitoringHandler}=require('../routes/handlers/monitoring'));}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
test('tenant API rejects false qualification, cross-tenant IDs, switched project and disabled activation',async()=>{
  assert.equal(typeof createMonitoringHandler,'function');
  const db=require('../services/db');db.getTenant('initialize');const tenantDb=tenantConnection=new (require('node:sqlite').DatabaseSync)(process.env.MT_STORE_PATH);tenantDb.prepare('INSERT INTO tenants(id,name,email,createdAt) VALUES(?,?,?,?)').run(f.tenantId,'Synthetic','','2026-10-17');
  const {createMonitoringRuntime}=require('../research/monitoring');const runtime=createMonitoringRuntime({store:f.store});const handler=createMonitoringHandler({runtime});
  let tenant=f.tenantId,current='p';const ctx={getAuthPayload:()=>tenant?{kind:'tenant',payload:{tid:tenant}}:null,readBody:async req=>req.body,loadState:()=>({tenantId:tenant,projectId:current}),sendJSON:(res,status,body)=>{res.status=status;res.body=body;return true;}};
  const call=async(method,endpoint,body)=>{const res={};const url=new URL('http://local/api/monitoring/'+endpoint);await handler(ctx,{method,body},res,url,url.pathname);return res;};
  tenant=null;assert.equal((await call('GET','status')).status,401);tenant=f.tenantId;
  let res=await call('POST','workspaces',{name:'Test',market:'US',timeZone:'America/New_York',idempotencyKey:'api-w'});assert.equal(res.status,201);const w=res.body.workspace;
  const seed=f.seed(w,'api');current=seed.input.projectId;
  const body={...seed.input};delete body.tenantId;delete body.now;
  assert.equal((await call('POST','pause',{watchTargetId:'../other'})).status,400);
  assert.equal((await call('POST','targets',{...body,projectId:'../other'})).status,400);
  delete process.env.FORMAL_MONITORING_ENABLED;res=await call('POST','targets',body);assert.equal(res.status,409);assert.equal(f.store.listWatchTargets(tenant).length,0);
  process.env.FORMAL_MONITORING_ENABLED='1';process.env.SCHEDULER_ENABLED='1';
  res=await call('POST','targets',{...body,brandId:'absent'});assert.equal(res.status,409);assert.equal(f.store.listWatchTargets(tenant).length,0);
  res=await call('POST','targets',{...body,qualification_status:'qualified'});assert.equal(res.status,400);
  current='other';assert.equal((await call('POST','targets',body)).status,409);current=seed.input.projectId;
  res=await call('POST','targets',body);assert.equal(res.status,201);const target=res.body.target;
  const at=Date.parse('2026-10-17T10:00:00Z');
  runtime.queue.enqueue({tenantId:tenant,watchTargetId:target.watch_target_id,trigger:'monitor',windowKey:'2026-10-17:06',scheduledAt:at,now:at});
  const claim=runtime.queue.claim(at),failed={source_status:'blocked',event_ids:[],snapshot_ids:[],issues:['synthetic_blocked']};
  assert.equal(runtime.queue.finish(claim.job_id,claim.claim_token,failed,at+1).ok,true);
  const observation=require('../services/monitoring-coverage').createCoverageService({store:f.store}).recordObservation({job:claim,target:f.store.getWatchTarget(tenant,target.watch_target_id),result:failed,now:at+1});
  const scope='projectId='+body.projectId+'&competitorId='+body.competitorId;
  res=await call('GET','status?'+scope);assert.equal(res.status,200);assert.equal(res.body.total_coverage,1);assert.deepEqual(res.body.coverage,[observation]);assert.equal(res.body.coverage[0].quiet.allowed,false);
  res=await call('GET','status?'+scope+'&offset=1&limit=1');assert.equal(res.body.total_coverage,1);assert.deepEqual(res.body.coverage,[]);
  res=await call('GET','status?projectId=other&competitorId=other');assert.equal(res.body.total_coverage,0);assert.deepEqual(res.body.coverage,[]);
  tenant='tenant?a';res=await call('GET','status');assert.equal(res.body.total_coverage,0);assert.equal(res.body.total_event_projections,0);tenant=f.tenantId;
  process.env.SCHEDULER_ENABLED='0';
  assert.equal((await call('POST','resume',{watchTargetId:target.watch_target_id})).status,409);
  assert.equal((await call('POST','recheck',{watchTargetId:target.watch_target_id,eventId:'missing'})).status,409);
  assert.equal((await call('POST','pause',{watchTargetId:target.watch_target_id})).status,200);
  process.env.SCHEDULER_ENABLED='1';assert.equal((await call('POST','resume',{watchTargetId:target.watch_target_id})).status,200);
  tenant='outsider';assert.equal((await call('POST','pause',{watchTargetId:target.watch_target_id})).status,404);tenant=f.tenantId;
  res=await call('PUT','workspaces',{workspaceId:w.workspace_id,market:'CA',timeZone:'America/Toronto'});assert.equal(res.status,200);assert.equal(res.body.targets[0].monitoring_status,'paused');assert.equal(res.body.scope_changed,true);
  res=await call('GET','status');assert.equal(res.status,200);assert.equal(res.body.targets[0].effective.executable,false);assert.equal(JSON.stringify(res.body).includes('raw_payload_ref'),false);
  assert.deepEqual(res.body.coverage,[observation]);assert.deepEqual(res.body.event_projections,[]);assert.equal(res.body.total_coverage,1);assert.equal(res.body.total_event_projections,0);
  assert.equal((await call('GET','status?limit=10000')).status,400);
  const pages=f.workspace('pages');
  for(let i=0;i<51;i++){
    const synthetic=f.seed(pages,'page'+i);f.store.createWatchTarget(synthetic.input);
  }
  const scoped=f.seed(pages,'last-page');const selected=f.store.createWatchTarget(scoped.input);
  res=await call('GET','targets?projectId='+scoped.input.projectId+'&competitorId='+scoped.input.competitorId);
  assert.equal(res.status,200);assert.equal(res.body.total,1);assert.equal(res.body.targets[0].watch_target_id,selected.watch_target_id);
  assert.equal((await call('GET','status?projectId=x')).status,400);
  assert.equal((await call('GET','targets?projectId=../x&competitorId=x')).status,400);
  const zh=f.seed(pages,'zh');zh.input.projectId='跑鞋-20261017';zh.project.projectId=zh.input.projectId;
  f.write('research/'+f.ns+'/'+zh.input.projectId+'.json',zh.project);
  const fs=require('node:fs'),path=require('node:path');
  for(const rel of ['evidence/'+f.ns+'/'+zh.ev+'.json','snapshots/'+f.ns+'/20261017/'+zh.ss+'.json']){
    const value=JSON.parse(fs.readFileSync(path.join(f.dir,rel)));value.tenant.project_ref=zh.input.projectId;f.write(rel,value);
  }
  const zhBody={...zh.input};delete zhBody.tenantId;delete zhBody.now;current=zh.input.projectId;
  assert.equal((await call('POST','targets',zhBody)).status,201);
  for(const endpoint of ['status','targets']){res=await call('GET',endpoint+'?projectId='+encodeURIComponent(current)+'&competitorId='+zh.input.competitorId);assert.equal(res.status,200);assert.equal(res.body.targets.length,1);}
  ctx.readBody=async()=>{throw Object.assign(new Error('malformed body'),{code:'BAD_JSON'});};assert.equal((await call('POST','workspaces',{})).status,400);
  tenantDb.close();db.closeDb();
});
test('startup defaults to watch+digest ticks without legacy sweep; ZB_SWEEP_ENABLED escape; explicit formal selects only formal; global off blocks all; routes stay tenant-only',()=>{
  const scheduler=require('../services/scheduler'),monitoring=require('../research/monitoring');
  const digestMod=require('../research/digest'),watchMod=require('../services/watch-monitor');
  const next=scheduler.scheduleNext,get=monitoring.getMonitoringRuntime;
  const dst=digestMod.startDigestTick,wst=watchMod.startTick;
  let legacy=0,digest=0,watch=0,formal=0;
  const reset=()=>{legacy=digest=watch=formal=0;};
  scheduler.scheduleNext=()=>{legacy++;return {nextAt:new Date(),hours:[6,14,22]};};
  digestMod.startDigestTick=()=>{digest++;return {tickMinutes:5};};
  watchMod.startTick=()=>{watch++;return {tickMinutes:5};};
  monitoring.getMonitoringRuntime=()=>({start(){formal++;return this;}});
  try {
    const {startScheduler}=require('../research/sweep');delete process.env.FORMAL_MONITORING_ENABLED;delete process.env.SCHEDULER_ENABLED;delete process.env.ZB_SWEEP_ENABLED;
    // 整改 §3 后默认：旧 sweep 不调度（正式监控唯一边界=WatchTarget），watch tick + 每租户 08:00 digest tick 接线。
    reset();let r=startScheduler();assert.ok(r&&r.sweep===null&&r.digestTick&&r.watchTick);assert.deepEqual([legacy,digest,watch,formal],[0,1,1,0]);
    // 运维逃生门：显式启用时也只运行收缩版 sweep（仅 recentMoves 研究维护）。
    process.env.ZB_SWEEP_ENABLED='1';reset();r=startScheduler();assert.ok(r&&r.sweep);assert.deepEqual([legacy,digest,watch,formal],[1,1,1,0]);
    delete process.env.ZB_SWEEP_ENABLED;
    // M2 技术开关显式选择新正式监控路径时整体接管，不再叠加旧 sweep/digest tick。
    process.env.FORMAL_MONITORING_ENABLED='1';reset();r=startScheduler();assert.ok(r);assert.deepEqual([legacy,digest,watch,formal],[0,0,0,1]);
    process.env.SCHEDULER_ENABLED='0';reset();assert.equal(startScheduler(),null);assert.deepEqual([legacy,digest,watch,formal],[0,0,0,0]);
    const routes=require('../routes');for(const [method,p] of [['GET','workspaces'],['POST','workspaces'],['PUT','workspaces'],['GET','targets'],['POST','targets'],['POST','pause'],['POST','resume'],['POST','recheck'],['GET','status']])assert.equal(routes.match(method,'/api/monitoring/'+p).auth,'tenant');
    assert.equal(routes.match('GET','/api/scheduler/status').auth,'tenant');
  }finally{scheduler.scheduleNext=next;monitoring.getMonitoringRuntime=get;digestMod.startDigestTick=dst;watchMod.startTick=wst;delete process.env.FORMAL_MONITORING_ENABLED;delete process.env.SCHEDULER_ENABLED;delete process.env.ZB_SWEEP_ENABLED;}
});
test.after(()=>{if(tenantConnection?.isOpen)tenantConnection.close();require('../services/db').closeDb();f.cleanup();bootFs.rmSync(bootDir,{recursive:true,force:true});});
