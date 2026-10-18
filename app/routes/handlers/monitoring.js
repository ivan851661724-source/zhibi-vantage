'use strict';
const {getMonitoringRuntime,activationIssues}=require('../../research/monitoring');
const {failure}=require('../../services/monitoring-contracts');
const tenantDb=require('../../services/db');
const {isSafeId}=require('../../core/safe-id');
function createMonitoringHandler({runtime}={}) {
  return async function monitoring(ctx,req,res,url,p) {
    if(!p.startsWith('/api/monitoring/'))return false;
    const auth=ctx.getAuthPayload(req);
    if(auth?.kind!=='tenant'||!auth.payload?.tid)return ctx.sendJSON(res,401,{error:'AUTH_REQUIRED',message:'请登录后管理监控。'});
    const tenantId=auth.payload.tid;
    const rt=runtime||getMonitoringRuntime(),store=rt.store;
    const respond=(code,body)=>ctx.sendJSON(res,code,body);
    const requireEnabled=()=>{const issues=activationIssues();if(issues.length)throw failure(issues[0],409,issues);const tenant=tenantDb.getTenant(tenantId);if(!tenant)throw failure('TENANT_NOT_FOUND');if(tenant.status==='suspended')throw failure('TENANT_SUSPENDED');};
    const read=async fields=>{
      const b=await ctx.readBody(req);
      if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!fields.includes(k))||fields.some(k=>typeof b[k]!=='string'||!b[k].trim()||b[k].length>512))throw failure('BAD_INPUT',400);
      if(b.projectId!==undefined&&!/^[a-z0-9\u4e00-\u9fff-]+$/i.test(b.projectId))throw failure('INVALID_PROJECT_ID',400);
      for(const key of ['workspaceId','watchTargetId','competitorId','brandId','qualificationResultId','eventId'])if(b[key]!==undefined&&!isSafeId(b[key]))throw failure('INVALID_ID',400);
      return b;
    };
    const pagination=()=>{const parse=(key,fallback)=>{const raw=url.searchParams.get(key);if(raw===null)return fallback;if(!/^\d+$/.test(raw))throw failure('INVALID_PAGINATION',400);return Number(raw);};return {workspaceId:url.searchParams.get('workspaceId')||undefined,projectId:url.searchParams.get('projectId')??undefined,competitorId:url.searchParams.get('competitorId')??undefined,offset:parse('offset',0),limit:parse('limit',50)};};
    try {
      if(req.method==='GET') {
        const state=rt.status(tenantId,pagination());
        if(p==='/api/monitoring/status')return respond(200,state);
        if(p==='/api/monitoring/workspaces')return respond(200,{workspaces:state.workspaces,offset:state.offset,limit:state.limit});
        if(p==='/api/monitoring/targets')return respond(200,{targets:state.targets,total:state.total_targets,offset:state.offset,limit:state.limit,enabled:state.enabled,issues:state.issues,limitations:state.limitations});
      }
      if(p==='/api/monitoring/workspaces'&&req.method==='POST'){
        const b=await read(['name','market','timeZone','idempotencyKey']);return respond(201,{workspace:store.createWorkspace({...b,tenantId})});
      }
      if(p==='/api/monitoring/workspaces'&&req.method==='PUT'){
        const b=await read(['workspaceId','market','timeZone']);const old=store.getWorkspace(tenantId,b.workspaceId);if(!old)throw failure('WORKSPACE_NOT_FOUND',404);
        const workspace=store.updateWorkspace({...b,tenantId});const state=rt.status(tenantId,{workspaceId:b.workspaceId,limit:100});
        return respond(200,{workspace,scope_changed:workspace.revision!==old.revision,targets:state.targets,total_targets:state.total_targets,message:'市场或时区变更会暂停关联目标并使在途旧范围结果失效；不自动迁移市场。'});
      }
      if(p==='/api/monitoring/targets'&&req.method==='POST'){
        const b=await read(['workspaceId','projectId','competitorId','brandId','qualificationResultId','categoryScope','idempotencyKey']);
        if(!store.getWorkspace(tenantId,b.workspaceId))throw failure('WORKSPACE_NOT_FOUND',404);
        const current=ctx.loadState();if(current?.projectId!==b.projectId||(current.tenantId&&current.tenantId!==tenantId))throw failure('PROJECT_CHANGED');
        requireEnabled();const target=store.createWatchTarget({...b,tenantId});
        return respond(201,{target:rt.targetStatus(tenantId,target.watch_target_id)});
      }
      if(['/api/monitoring/pause','/api/monitoring/resume','/api/monitoring/recheck'].includes(p)&&req.method==='POST'){
        const b=await read(p.endsWith('/recheck')?['watchTargetId','eventId']:['watchTargetId']);
        const existing=store.getWatchTarget(tenantId,b.watchTargetId);if(!existing)throw failure('WATCH_TARGET_NOT_FOUND',404);
        if(!p.endsWith('/pause'))requireEnabled();
        if(p.endsWith('/recheck')){
          const result=rt.requestRecheck({...b,tenantId});if(!result.accepted)return respond(503,{error:'MONITORING_QUEUE_FULL',message:'监控队列暂满，请稍后重试。',retryable:true});
          return respond(202,{accepted:true,duplicate:result.duplicate,job:{job_id:result.job.job_id,watch_target_id:result.job.target_id,status:result.job.status,trigger:result.job.trigger,event_id:result.job.event_id,scheduled_at:result.job.scheduled_at}});
        }
        const target=p.endsWith('/pause')?store.pauseWatchTarget(tenantId,b.watchTargetId):store.resumeWatchTarget(tenantId,b.watchTargetId);
        return respond(200,{target:rt.targetStatus(tenantId,target.watch_target_id)});
      }
      return respond(405,{error:'METHOD',message:'不支持该方法。'});
    }catch(error){
      if(error.code==='REQUEST_ABORTED')return true;
      const status=error.status||(error.code==='BAD_JSON'?400:error.code==='PAYLOAD_TOO_LARGE'?413:500);
      return respond(status,{error:error.code||'MONITORING_ERROR',message:status<500?'监控操作未执行，请查看原因并核对前置条件。':'监控服务暂时无法完成请求。',...(error.issues?{issues:error.issues}:{})});
    }
  };
}
module.exports={createMonitoringHandler,monitoring:createMonitoringHandler()};
