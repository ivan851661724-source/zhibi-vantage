'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { isAsyncFunction } = require('node:util').types;
const { createContracts, failure, nonempty, hash } = require('./monitoring-contracts');
const { formatter } = require('./monitoring-time');
const POLICY = 'shopify-catalog-observation-1';
function createMonitoringStore({ dataDir = require('../core/paths').DATA } = {}) {
  fs.mkdirSync(dataDir,{recursive:true});
  const db = new DatabaseSync(path.join(dataDir,'monitoring.db'));
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== 0 && version !== 1) { db.close(); throw failure('UNSUPPORTED_MONITORING_SCHEMA'); }
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitoring_workspaces(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS monitoring_targets(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,scope_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS monitoring_idempotency(tenant_id TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,request TEXT NOT NULL,object_id TEXT NOT NULL,PRIMARY KEY(tenant_id,operation,key));
    CREATE TABLE IF NOT EXISTS monitoring_jobs(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT UNIQUE NOT NULL,dedupe_key TEXT UNIQUE NOT NULL,tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,target_id TEXT NOT NULL,revision INTEGER NOT NULL,provider TEXT NOT NULL,status TEXT NOT NULL,scheduled_at INTEGER NOT NULL,available_at INTEGER NOT NULL,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,claim_token TEXT,lease_until INTEGER,claimed_at INTEGER,schedule_lag INTEGER,source_status TEXT,result TEXT,trigger TEXT NOT NULL,window_key TEXT,event_id TEXT);
    CREATE INDEX IF NOT EXISTS monitoring_jobs_status ON monitoring_jobs(status,available_at,seq);
    CREATE TABLE IF NOT EXISTS monitoring_dispatch(workspace_id TEXT PRIMARY KEY,last_dispatch INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS monitoring_provider(provider TEXT PRIMARY KEY,last_started INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS monitoring_cursors(target_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(target_id,revision));
    CREATE TABLE IF NOT EXISTS monitoring_gaps(gap_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,target_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS monitoring_claims(job_id TEXT NOT NULL,attempt INTEGER NOT NULL,claimed_at INTEGER NOT NULL,schedule_lag INTEGER NOT NULL,lag_warning INTEGER NOT NULL,degraded_candidate INTEGER NOT NULL,PRIMARY KEY(job_id,attempt));
    CREATE TABLE IF NOT EXISTS monitoring_queue_config(version TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS monitoring_scheduler_state(namespace TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(namespace,key));
    PRAGMA user_version=1;
  `);
  const contracts = createContracts(dataDir);
  const parse = row => row ? JSON.parse(row.payload) : null;
  let transactionDepth=0;
  function transaction(fn) {
    // Reject native async callbacks before they can start. The thenable guard
    // below also rejects invalid return values; it cannot undo async side effects
    // privately scheduled by an otherwise synchronous callback.
    if(isAsyncFunction(fn) || Object.prototype.toString.call(fn)==='[object AsyncFunction]')throw failure('ASYNC_TRANSACTION_FORBIDDEN',400);
    const nested=transactionDepth>0,savepoint='monitoring_nested_'+transactionDepth;
    db.exec(nested?'SAVEPOINT '+savepoint:'BEGIN IMMEDIATE');transactionDepth++;
    try {
      const result=fn();
      if(result&&typeof result.then==='function')throw failure('ASYNC_TRANSACTION_FORBIDDEN',400);
      db.exec(nested?'RELEASE SAVEPOINT '+savepoint:'COMMIT');return result;
    } catch(error) {
      if(nested){db.exec('ROLLBACK TO SAVEPOINT '+savepoint);db.exec('RELEASE SAVEPOINT '+savepoint);}else db.exec('ROLLBACK');
      throw error;
    } finally {transactionDepth--;}
  }
  function getWorkspace(tenantId,id) { if(!nonempty(tenantId)||!nonempty(id))return null;return parse(db.prepare('SELECT payload FROM monitoring_workspaces WHERE id=? AND tenant_id=?').get(id,tenantId)); }
  function getWatchTarget(tenantId,id) { if(!nonempty(tenantId)||!nonempty(id))return null;return parse(db.prepare('SELECT payload FROM monitoring_targets WHERE id=? AND tenant_id=?').get(id,tenantId)); }
  function listWorkspaces(tenantId) { return db.prepare('SELECT payload FROM monitoring_workspaces WHERE tenant_id=? ORDER BY rowid').all(tenantId).map(parse); }
  function listWatchTargets(tenantId,workspaceId) { return (workspaceId ? db.prepare('SELECT payload FROM monitoring_targets WHERE tenant_id=? AND workspace_id=? ORDER BY rowid').all(tenantId,workspaceId) : db.prepare('SELECT payload FROM monitoring_targets WHERE tenant_id=? ORDER BY rowid').all(tenantId)).map(parse); }
  function requireWorkspace(tenantId,id) { const w=getWorkspace(tenantId,id); if (!w) throw failure('WORKSPACE_NOT_FOUND',404); return w; }
  function requireTarget(tenantId,id) { const t=getWatchTarget(tenantId,id); if (!t) throw failure('WATCH_TARGET_NOT_FOUND',404); return t; }
  function validateWorkspace(input) { if (![input.tenantId,input.name,input.market,input.timeZone].every(nonempty)) throw failure('EXPLICIT_WORKSPACE_SCOPE_REQUIRED',400); try { formatter(input.timeZone); } catch { throw failure('INVALID_TIME_ZONE',400); } }
  function idem(tenantId,op,key,request,create) {
    if (!nonempty(key) || key.length>256) throw failure('IDEMPOTENCY_KEY_REQUIRED',400);
    const json=JSON.stringify(request), previous=db.prepare('SELECT * FROM monitoring_idempotency WHERE tenant_id=? AND operation=? AND key=?').get(tenantId,op,key);
    if (previous) { if(previous.request !== json) throw failure('IDEMPOTENCY_CONFLICT'); return previous.object_id; }
    const id=create(); db.prepare('INSERT INTO monitoring_idempotency VALUES(?,?,?,?,?)').run(tenantId,op,key,json,id); return id;
  }
  function saveTarget(t) { db.prepare('UPDATE monitoring_targets SET payload=? WHERE id=? AND tenant_id=?').run(JSON.stringify(t),t.watch_target_id,t.tenant_id); }
  function invalidatePending(t) { db.prepare("UPDATE monitoring_jobs SET status='error',source_status='unavailable',result=? WHERE target_id=? AND status='pending'").run(JSON.stringify({source_status:'unavailable',reason:'target_or_scope_invalidated'}),t.watch_target_id); }
  function createWorkspace(input) {
    validateWorkspace(input);
    return transaction(() => { const id=idem(input.tenantId,'workspace',input.idempotencyKey,[input.name,input.market,input.timeZone],() => {
      const w={ schema_version:1,workspace_id:'ws_'+crypto.randomUUID(),tenant_id:input.tenantId,name:input.name,market:input.market,target_market_timezone:input.timeZone,revision:1,created_at:input.now ?? Date.now(),updated_at:input.now ?? Date.now() };
      db.prepare('INSERT INTO monitoring_workspaces VALUES(?,?,?)').run(w.workspace_id,w.tenant_id,JSON.stringify(w)); return w.workspace_id;
    }); return getWorkspace(input.tenantId,id); });
  }
  function updateWorkspace({tenantId,workspaceId,market,timeZone,now=Date.now()}) {
    return transaction(() => {
      const w=requireWorkspace(tenantId,workspaceId); validateWorkspace({tenantId,name:w.name,market,timeZone});
      if(w.market===market && w.target_market_timezone===timeZone) return w;
      Object.assign(w,{market,target_market_timezone:timeZone,revision:w.revision+1,updated_at:now});
      db.prepare('UPDATE monitoring_workspaces SET payload=? WHERE id=?').run(JSON.stringify(w),workspaceId);
      for(const t of listWatchTargets(tenantId,workspaceId)) { t.monitoring_status='paused';t.paused_at=now;t.revision++;saveTarget(t);invalidatePending(t); }
      return w;
    });
  }
  function resolveAdmission(input) { return contracts.admission(input,getWorkspace(input.tenantId,input.workspaceId)); }
  function admissionInput(t) { return {tenantId:t.tenant_id,workspaceId:t.workspace_id,projectId:t.project_id,competitorId:t.competitor_id,brandId:t.brand_id,qualificationResultId:t.current_qualification_result_id,categoryScope:t.category_scope}; }
  function createWatchTarget(input) {
    return transaction(() => {
      const a=resolveAdmission(input); if(!a.ok) throw failure('ADMISSION_REJECTED',409,a.issues);
      const id=idem(input.tenantId,'target',input.idempotencyKey,[input.workspaceId,input.projectId,input.competitorId,input.brandId,input.qualificationResultId,input.categoryScope],() => {
        const scope=JSON.stringify([input.workspaceId,input.brandId,input.categoryScope,a.workspace.market]);
        const previous=db.prepare('SELECT payload FROM monitoring_targets WHERE scope_key=?').get(scope);
        if(previous) {const t=parse(previous); if(t.project_id!==input.projectId || t.competitor_id!==input.competitorId || t.current_qualification_result_id!==input.qualificationResultId) throw failure('TARGET_SCOPE_CONFLICT'); return t.watch_target_id;}
        const t={schema_version:1,watch_target_id:'wt_'+crypto.randomUUID(),tenant_id:input.tenantId,workspace_id:input.workspaceId,project_id:input.projectId,competitor_id:input.competitorId,brand_id:input.brandId,category_scope:input.categoryScope,market:a.workspace.market,target_market_timezone:a.workspace.target_market_timezone,workspace_revision:a.workspace.revision,current_qualification_result_id:input.qualificationResultId,qualification_digest:hash(JSON.stringify(a.qualification)),relationship_type:a.qualification.relationship_type,qualification_status:'qualified',monitoring_status:'active',monitoring_policy_id:POLICY,user_priority:null,created_at:input.now??Date.now(),paused_at:null,revision:1,source:a.source};
        db.prepare('INSERT INTO monitoring_targets VALUES(?,?,?,?,?)').run(t.watch_target_id,t.tenant_id,t.workspace_id,scope,JSON.stringify(t));return t.watch_target_id;
      }); return getWatchTarget(input.tenantId,id);
    });
  }
  function pauseWatchTarget(tenantId,id,now=Date.now()) { return transaction(() => {const t=requireTarget(tenantId,id);if(t.monitoring_status!=='paused'){t.monitoring_status='paused';t.paused_at=now;t.revision++;saveTarget(t);invalidatePending(t);}return t;}); }
  function resumeWatchTarget(tenantId,id,now=Date.now()) { return transaction(() => {
    const t=requireTarget(tenantId,id),w=requireWorkspace(tenantId,t.workspace_id);
    if(t.market!==w.market) throw failure('TARGET_MARKET_CHANGED');
    const a=resolveAdmission(admissionInput(t));if(!a.ok) throw failure('ADMISSION_REJECTED',409,a.issues);
    if(hash(JSON.stringify(a.qualification))!==t.qualification_digest)throw failure('QUALIFICATION_IMMUTABILITY_VIOLATION');
    if(t.monitoring_status!=='active'){Object.assign(t,{monitoring_status:'active',paused_at:null,revision:t.revision+1,workspace_revision:w.revision,target_market_timezone:w.target_market_timezone,source:a.source,resumed_at:now});saveTarget(t);} return t;
  }); }
  function assertExecutable(tenantId,id,revision) {
    const t=requireTarget(tenantId,id),w=requireWorkspace(tenantId,t.workspace_id);
    if(t.revision!==revision || !['active','degraded'].includes(t.monitoring_status) || t.workspace_revision!==w.revision || t.market!==w.market || t.target_market_timezone!==w.target_market_timezone) throw failure('TARGET_NOT_EXECUTABLE');
    const a=resolveAdmission(admissionInput(t));if(!a.ok)throw failure('ADMISSION_REJECTED',409,a.issues);
    if(hash(JSON.stringify(a.qualification))!==t.qualification_digest)throw failure('QUALIFICATION_IMMUTABILITY_VIOLATION');
    if(JSON.stringify(a.source)!==JSON.stringify(t.source))throw failure('SOURCE_IDENTITY_CHANGED');
    return t;
  }
  function getSchedulerCursor(tenantId,targetId,revision) { const t=requireTarget(tenantId,targetId); return parse(db.prepare('SELECT payload FROM monitoring_cursors WHERE target_id=? AND revision=?').get(t.watch_target_id,revision)); }
  function saveSchedulerCursor({tenantId,watchTargetId,revision,observedAt,acceptedJobId=null}) {
    return transaction(() => { assertExecutable(tenantId,watchTargetId,revision);
      if(!Number.isSafeInteger(observedAt))throw failure('INVALID_CURSOR',400);
      const old=getSchedulerCursor(tenantId,watchTargetId,revision);
      if(old && observedAt<old.observed_at)throw failure('CURSOR_REGRESSION');
      let job=null;
      if(acceptedJobId) {job=db.prepare('SELECT * FROM monitoring_jobs WHERE job_id=? AND tenant_id=? AND target_id=? AND revision=? AND trigger=?').get(acceptedJobId,tenantId,watchTargetId,revision,'monitor'); if(!job)throw failure('CURSOR_JOB_NOT_ACCEPTED');}
      const c={schema_version:1,watch_target_id:watchTargetId,revision,observed_at:observedAt,accepted_job_id:job?.job_id||old?.accepted_job_id||null,accepted_window_key:job?.window_key||old?.accepted_window_key||null,accepted_scheduled_at:job?.scheduled_at??old?.accepted_scheduled_at??null};
      if(old?.accepted_scheduled_at!=null && job && job.scheduled_at<old.accepted_scheduled_at)throw failure('CURSOR_REGRESSION');
      db.prepare('INSERT INTO monitoring_cursors VALUES(?,?,?) ON CONFLICT(target_id,revision) DO UPDATE SET payload=excluded.payload').run(watchTargetId,revision,JSON.stringify(c));return c;
    });
  }
  function recordSchedulerGap({tenantId,watchTargetId,revision,from,to,reason,windowKey=null}) {
    const t=requireTarget(tenantId,watchTargetId);
    if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to)||to<from||!nonempty(reason))throw failure('INVALID_GAP',400);
    const gapId=crypto.createHash('sha256').update(JSON.stringify([tenantId,watchTargetId,revision,from,to,reason,windowKey])).digest('hex');
    const gap={schema_version:1,gap_id:gapId,watch_target_id:watchTargetId,revision,from,to,reason,window_key:windowKey};
    db.prepare('INSERT OR IGNORE INTO monitoring_gaps VALUES(?,?,?,?,?,?)').run(gapId,tenantId,t.workspace_id,watchTargetId,revision,JSON.stringify(gap));return gap;
  }
  function listSchedulerGaps(tenantId,workspaceId) {return (workspaceId?db.prepare('SELECT payload FROM monitoring_gaps WHERE tenant_id=? AND workspace_id=?').all(tenantId,workspaceId):db.prepare('SELECT payload FROM monitoring_gaps WHERE tenant_id=?').all(tenantId)).map(parse);}
  function schedulerNamespace({scope,tenantId,key}) {if(!nonempty(key)||key.length>256||(scope==='system'&&tenantId!==undefined)||(scope==='tenant'&&!nonempty(tenantId))||!['tenant','system'].includes(scope))throw failure('INVALID_SCHEDULER_NAMESPACE',400);return scope==='system'?'system':JSON.stringify(['tenant',tenantId]);}
  function getSchedulerState(input) {const ns=schedulerNamespace(input);return parse(db.prepare('SELECT payload FROM monitoring_scheduler_state WHERE namespace=? AND key=?').get(ns,input.key));}
  function setSchedulerState(input) {const ns=schedulerNamespace(input),json=JSON.stringify(input.value);if(json===undefined)throw failure('INVALID_SCHEDULER_STATE',400);db.prepare('INSERT INTO monitoring_scheduler_state VALUES(?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET payload=excluded.payload').run(ns,input.key,json);return input.value;}
  return {getDb:()=>db,close:()=>{if(db.isOpen)db.close();},transaction,createWorkspace,updateWorkspace,getWorkspace,listWorkspaces,resolveAdmission,createWatchTarget,listWatchTargets,getWatchTarget,pauseWatchTarget,resumeWatchTarget,assertExecutable,getSchedulerCursor,saveSchedulerCursor,recordSchedulerGap,listSchedulerGaps,getSchedulerState,setSchedulerState,validateRecheck:contracts.validateRecheck};
}
module.exports={createMonitoringStore,POLICY};
