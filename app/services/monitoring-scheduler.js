'use strict';
const Time = require('./monitoring-time');
const TICK_MS = 30000;
// 03 §12.2 permits a 15 minute normal window. This is not a missed-day
// catch-up policy; older unaccepted slots are recorded as gaps only.
const WINDOW_TOLERANCE_MS = 15*60*1000;

// A missed observation interval is diagnostic, never a historical scan. Pending
// intentions are persisted separately so queue pressure cannot lose an observed slot.
function createMonitoringScheduler({store,queue,checkTenant,clock=Date.now}) {
  const key = target => ({scope:'tenant',tenantId:target.tenant_id,key:'due:'+target.watch_target_id+':'+target.revision});
  function tick(now=clock()) {
    return store.transaction(()=>{
      const candidates=[];
      const summary={accepted:0,backpressure:false,issues:[]};
      const targets=store.getDb().prepare('SELECT payload FROM monitoring_targets ORDER BY rowid').all().map(r=>JSON.parse(r.payload));
      for(const target of targets) {
        if(!['active','degraded'].includes(target.monitoring_status))continue;
        try {
          checkTenant(target.tenant_id);
          store.assertExecutable(target.tenant_id,target.watch_target_id,target.revision);
          const cursor=store.getSchedulerCursor(target.tenant_id,target.watch_target_id,target.revision);
          const seenKey={scope:'tenant',tenantId:target.tenant_id,key:'seen:'+target.watch_target_id+':'+target.revision};
          const seen=store.getSchedulerState(seenKey);
          if(seen!==null&&now-seen>2*TICK_MS)store.recordSchedulerGap({tenantId:target.tenant_id,watchTargetId:target.watch_target_id,revision:target.revision,from:seen,to:now,reason:'scheduler_observation_gap'});
          store.setSchedulerState({...seenKey,value:Math.max(now,seen??now)});
          let pending=store.getSchedulerState(key(target));
          const slots=Time.slotsForDate(Time.localDateKey(now,target.target_market_timezone),target.target_market_timezone);
          if(seen!==null)for(const slot of slots.filter(s=>s.scheduled_at>seen&&s.scheduled_at>=Math.max(target.created_at,target.resumed_at??0)&&now-s.scheduled_at>WINDOW_TOLERANCE_MS))store.recordSchedulerGap({tenantId:target.tenant_id,watchTargetId:target.watch_target_id,revision:target.revision,from:slot.scheduled_at,to:slot.scheduled_at,reason:'unobserved_window_outside_tolerance',windowKey:slot.window_key});
          if(pending)for(const slot of slots.filter(s=>s.scheduled_at>pending.scheduled_at&&s.scheduled_at<=now))store.recordSchedulerGap({tenantId:target.tenant_id,watchTargetId:target.watch_target_id,revision:target.revision,from:slot.scheduled_at,to:slot.scheduled_at,reason:'pending_window_backpressure',windowKey:slot.window_key});
          if(!pending) {
            const start=cursor?.observed_at??Math.max(target.resumed_at??target.created_at,now-WINDOW_TOLERANCE_MS);
            const slot=slots
              .filter(s=>s.scheduled_at<=now&&s.scheduled_at>=Math.max(target.resumed_at??target.created_at,start)&&now-s.scheduled_at<=WINDOW_TOLERANCE_MS)
              .find(s=>s.window_key!==cursor?.accepted_window_key);
            if(slot){pending=slot;store.setSchedulerState({...key(target),value:slot});}
            else store.saveSchedulerCursor({tenantId:target.tenant_id,watchTargetId:target.watch_target_id,revision:target.revision,observedAt:Math.max(now,cursor?.observed_at??now)});
          }
          if(pending)candidates.push({target,slot:pending});
        } catch(error) {
          const issue={watch_target_id:target.watch_target_id,reason:error.code||'scheduler_error'};
          summary.issues.push(issue);
          store.setSchedulerState({scope:'tenant',tenantId:target.tenant_id,key:'scheduler-issue:'+target.watch_target_id,value:{...issue,observed_at:now}});
          if(['LOCAL_TIME_NONEXISTENT','LOCAL_TIME_AMBIGUOUS'].includes(error.code))store.recordSchedulerGap({tenantId:target.tenant_id,watchTargetId:target.watch_target_id,revision:target.revision,from:now,to:now,reason:error.code});
        }
      }
      const groups=new Map();for(const c of candidates){if(!groups.has(c.target.workspace_id))groups.set(c.target.workspace_id,[]);groups.get(c.target.workspace_id).push(c);}
      const ids=[...groups.keys()].sort();
      const rr={scope:'system',key:'enqueue-last-workspace'};
      const last=store.getSchedulerState(rr),position=ids.indexOf(last);
      const order=position<0?ids:[...ids.slice(position+1),...ids.slice(0,position+1)];
      while(order.some(id=>groups.get(id).length)) {
        for(const id of order) {
          const candidate=groups.get(id).shift();if(!candidate)continue;
          const {target,slot}=candidate;
          const accepted=queue.enqueue({tenantId:target.tenant_id,watchTargetId:target.watch_target_id,trigger:'monitor',scheduledAt:slot.scheduled_at,windowKey:slot.window_key,now});
          if(!accepted.accepted){summary.backpressure=true;return summary;}
          store.saveSchedulerCursor({tenantId:target.tenant_id,watchTargetId:target.watch_target_id,revision:target.revision,observedAt:now,acceptedJobId:accepted.job.job_id});
          store.setSchedulerState({...key(target),value:null});store.setSchedulerState({...rr,value:id});summary.accepted++;
        }
      }
      return summary;
    });
  }
  return {tick};
}
module.exports={createMonitoringScheduler,TICK_MS};
