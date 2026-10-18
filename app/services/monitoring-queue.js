'use strict';
const crypto = require('node:crypto');
const { failure, nonempty } = require('./monitoring-contracts');
const { resolveLocalTime } = require('./monitoring-time');
const DEFAULT_CONFIG = Object.freeze({ version:'monitoring-queue-1',maxPending:2000,globalConcurrency:2,providerConcurrency:1,providerMinIntervalMs:1000,leaseMs:60000,maxClaimAttempts:3,jitterMs:0 });
function createMonitoringQueue({store,config={},clock=Date.now}) {
  const cfg={...DEFAULT_CONFIG,...config},db=store.getDb();
  if(cfg.version!==DEFAULT_CONFIG.version || Object.keys(config).some(k=>!(k in DEFAULT_CONFIG)))throw failure('INVALID_QUEUE_CONFIG',400);
  for(const k of ['maxPending','globalConcurrency','providerConcurrency','providerMinIntervalMs','leaseMs','maxClaimAttempts']) if(!Number.isSafeInteger(cfg[k])||cfg[k]<=0)throw failure('INVALID_QUEUE_CONFIG',400);
  if(!Number.isSafeInteger(cfg.jitterMs)||cfg.jitterMs<0||cfg.jitterMs>900000)throw failure('INVALID_QUEUE_CONFIG',400);
  store.transaction(()=>{
    const saved=db.prepare('SELECT payload FROM monitoring_queue_config WHERE version=?').get(cfg.version);
    if(saved && saved.payload!==JSON.stringify(cfg))throw failure('QUEUE_CONFIG_CONFLICT');
    if(!saved)db.prepare('INSERT INTO monitoring_queue_config VALUES(?,?)').run(cfg.version,JSON.stringify(cfg));
  });
  const time=v=>{const n=v??clock();if(!Number.isSafeInteger(n))throw failure('INVALID_TIMESTAMP',400);return n;};
  const project=row=>row?{...row,result:row.result?JSON.parse(row.result):null,config_version:cfg.version}:null;
  function executable(job) {try{return store.assertExecutable(job.tenant_id,job.target_id,job.revision);}catch{return null;}}
  function recheckValid(t,eventId) {
    const associated=db.prepare("SELECT result FROM monitoring_jobs WHERE tenant_id=? AND target_id=? AND revision=? AND status='done' AND source_status IN ('success','partial')").all(t.tenant_id,t.watch_target_id,t.revision).some(r=>{try{return JSON.parse(r.result).event_ids?.includes(eventId);}catch{return false;}});
    return associated && store.validateRecheck(t.tenant_id,t,eventId);
  }
  function enqueue({tenantId,watchTargetId,trigger,scheduledAt,windowKey=null,eventId=null,now}) {
    const at=time(now);if(!Number.isSafeInteger(scheduledAt))throw failure('INVALID_TIMESTAMP',400);
    if(!['monitor','recheck'].includes(trigger) || (trigger==='monitor' && (!nonempty(windowKey)||eventId!==null)) || (trigger==='recheck' && (!nonempty(eventId)||windowKey!==null)))throw failure('INVALID_MONITORING_TRIGGER',400);
    return store.transaction(()=>{
      const current=store.getWatchTarget(tenantId,watchTargetId);if(!current)throw failure('WATCH_TARGET_NOT_FOUND',404);
      const key=JSON.stringify([watchTargetId,current.revision,trigger,trigger==='monitor'?windowKey:eventId]);
      const old=db.prepare('SELECT * FROM monitoring_jobs WHERE dedupe_key=? AND tenant_id=?').get(key,tenantId);
      if(old) { if(trigger==='monitor' && old.scheduled_at!==scheduledAt)throw failure('WINDOW_SCHEDULE_CONFLICT'); return {accepted:true,duplicate:true,job:project(old)}; }
      if(!['active','degraded'].includes(current.monitoring_status))throw failure('TARGET_NOT_EXECUTABLE');
      if(trigger==='recheck'&&!recheckValid(current,eventId))throw failure('RECHECK_EVENT_SCOPE_UNVERIFIED');
      const count=db.prepare("SELECT COUNT(*) AS n FROM monitoring_jobs WHERE status IN ('pending','running')").get().n;
      if(count>=cfg.maxPending)return {accepted:false,backpressure:true,retryable:true,reason:'monitoring_queue_full'};
      if(trigger==='monitor') {
        const match=/^(\d{4}-\d{2}-\d{2}):(06|14|22)$/.exec(windowKey);
        if(!match)throw failure('INVALID_MONITORING_WINDOW',400);
        let expected;try{expected=resolveLocalTime(match[1],+match[2],0,current.target_market_timezone);}catch{throw failure('INVALID_MONITORING_WINDOW',400);}
        if(expected!==scheduledAt)throw failure('INVALID_MONITORING_WINDOW',400);
      }
      const t=store.assertExecutable(tenantId,watchTargetId,current.revision);
      const id='mj_'+crypto.randomUUID();
      // Stable positive jitter preserves scheduled_at. It is job dispatch jitter, not a different business window.
      const jitter=trigger==='monitor'&&cfg.jitterMs ? crypto.createHash('sha256').update(key).digest().readUInt32BE(0)%(cfg.jitterMs+1):0;
      db.prepare(`INSERT INTO monitoring_jobs(job_id,dedupe_key,tenant_id,workspace_id,target_id,revision,provider,status,scheduled_at,available_at,created_at,trigger,window_key,event_id) VALUES(?,?,?,?,?,?,?,'pending',?,?,?,?,?,?)`).run(id,key,tenantId,t.workspace_id,watchTargetId,t.revision,t.source.provider,scheduledAt,trigger==='monitor'?scheduledAt+jitter:at,at,trigger,windowKey,eventId);
      return {accepted:true,duplicate:false,job:project(db.prepare('SELECT * FROM monitoring_jobs WHERE job_id=?').get(id))};
    });
  }
  function expire(now) {
    db.prepare("UPDATE monitoring_jobs SET status=CASE WHEN attempts>=? THEN 'dead' ELSE 'pending' END,claim_token=NULL,lease_until=NULL,source_status='internal_error',result=? WHERE status='running' AND lease_until<=?").run(cfg.maxClaimAttempts,JSON.stringify({source_status:'internal_error',reason:'lease_expired'}),now);
  }
  function claim(now) {
    const at=time(now);
    return store.transaction(()=>{
      expire(at);
      if(db.prepare("SELECT COUNT(*) AS n FROM monitoring_jobs WHERE status='running'").get().n>=cfg.globalConcurrency)return null;
      // Least-recently served Workspace, then FIFO within that Workspace. No user/plan priority inference.
      const jobs=db.prepare(`SELECT j.* FROM monitoring_jobs j LEFT JOIN monitoring_dispatch d ON d.workspace_id=j.workspace_id WHERE j.status='pending' AND j.available_at<=? ORDER BY COALESCE(d.last_dispatch,0),j.seq`).all(at);
      const blockedProviders=new Set();
      for(const j of jobs) {
        if(blockedProviders.has(j.provider))continue;
        const last=db.prepare('SELECT last_started FROM monitoring_provider WHERE provider=?').get(j.provider);
        if((last && at-last.last_started<cfg.providerMinIntervalMs)||db.prepare("SELECT COUNT(*) AS n FROM monitoring_jobs WHERE provider=? AND status='running'").get(j.provider).n>=cfg.providerConcurrency){blockedProviders.add(j.provider);continue;}
        const t=executable(j);
        if(!t || (j.trigger==='recheck'&&!recheckValid(t,j.event_id))) {db.prepare("UPDATE monitoring_jobs SET status='error',source_status='unavailable',result=? WHERE job_id=?").run(JSON.stringify({source_status:'unavailable',reason:'target_or_scope_invalidated'}),j.job_id);continue;}
        const token=crypto.randomUUID(),lag=Math.max(0,at-j.scheduled_at);
        db.prepare("UPDATE monitoring_jobs SET status='running',attempts=attempts+1,claim_token=?,lease_until=?,claimed_at=?,schedule_lag=?,source_status=NULL,result=NULL WHERE job_id=? AND status='pending'").run(token,at+cfg.leaseMs,at,lag,j.job_id);
        const seq=db.prepare('SELECT COALESCE(MAX(last_dispatch),0)+1 AS n FROM monitoring_dispatch').get().n;
        db.prepare('INSERT INTO monitoring_dispatch VALUES(?,?) ON CONFLICT(workspace_id) DO UPDATE SET last_dispatch=excluded.last_dispatch').run(j.workspace_id,seq);
        db.prepare('INSERT INTO monitoring_provider VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET last_started=excluded.last_started').run(j.provider,at);
        db.prepare('INSERT INTO monitoring_claims VALUES(?,?,?,?,?,?)').run(j.job_id,j.attempts+1,at,lag,Number(lag>1800000),Number(lag>3600000));
        return project(db.prepare('SELECT * FROM monitoring_jobs WHERE job_id=?').get(j.job_id));
      }
      return null;
    });
  }
  function owned(jobId,token,at) { const j=db.prepare("SELECT * FROM monitoring_jobs WHERE job_id=? AND claim_token=? AND status='running' AND lease_until>?").get(jobId,token,at);if(!j)return null;const t=executable(j);return t&&(j.trigger!=='recheck'||recheckValid(t,j.event_id))?j:null; }
  function heartbeat(jobId,claimToken,now) {const at=time(now);return store.transaction(()=>{if(!owned(jobId,claimToken,at))return {ok:false,reason:'claim_invalid'};db.prepare('UPDATE monitoring_jobs SET lease_until=? WHERE job_id=?').run(at+cfg.leaseMs,jobId);return {ok:true,lease_until:at+cfg.leaseMs};});}
  function finish(jobId,claimToken,result,now) {
    const at=time(now);
    if(!result || !['success','partial','unavailable','blocked','rate_limited','parse_failed','timeout','internal_error'].includes(result.source_status) || (result.event_ids!==undefined && (!Array.isArray(result.event_ids)||!result.event_ids.every(nonempty))))throw failure('EXPLICIT_SOURCE_OUTCOME_REQUIRED',400);
    return store.transaction(()=>{if(!owned(jobId,claimToken,at))return {ok:false,reason:'claim_invalid'};
      const status=['success','partial'].includes(result.source_status)?'done':'error';
      db.prepare('UPDATE monitoring_jobs SET status=?,source_status=?,result=?,claim_token=NULL,lease_until=NULL WHERE job_id=?').run(status,result.source_status,JSON.stringify(result),jobId);return {ok:true};
    });
  }
  function stats(tenantId,workspaceId,now) {
    const at=time(now),params=workspaceId?[tenantId,workspaceId]:[tenantId],where=workspaceId?'tenant_id=? AND workspace_id=?':'tenant_id=?';
    const out={pending:0,running:0,done:0,error:0,dead:0};
    for(const r of db.prepare(`SELECT status,COUNT(*) AS n FROM monitoring_jobs WHERE ${where} GROUP BY status`).all(...params))out[r.status]=r.n;
    const oldest=db.prepare(`SELECT MIN(scheduled_at) AS at FROM monitoring_jobs WHERE ${where} AND status IN ('pending','running')`).get(...params).at;
    return {...out,oldest_age_ms:oldest==null?null:Math.max(0,at-oldest),config_version:cfg.version};
  }
  // Worker must check this immediately before source calls/persistence; it never extends a lease.
  function assertClaim(jobId,claimToken,now) {const at=time(now);return store.transaction(()=>{const j=owned(jobId,claimToken,at);if(!j)throw failure('CLAIM_INVALID');return project(j);});}
  return {enqueue,claim,heartbeat,finish,stats,assertClaim,config:Object.freeze(cfg)};
}
module.exports={createMonitoringQueue,DEFAULT_CONFIG};
