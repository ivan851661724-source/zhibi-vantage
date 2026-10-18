// Behavior regressions: authoritative state, stream recovery and account-scoped caches.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.join(__dirname, '../src');
const store = new Map();
const listeners = new Map();
const timers = new Map();
let timerId = 0;
let transport = async () => { throw new Error('Unexpected network request'); };
const docListeners = new Map();
const doc = { visibilityState:'visible', addEventListener:(k,f)=>docListeners.set(k,f), removeEventListener:k=>docListeners.delete(k) };
const win = { localStorage: { getItem: k => store.get(k) || null, setItem: (k,v) => store.set(k,v), removeItem: k => store.delete(k) },
  addEventListener: (k,f) => { const set = listeners.get(k) || new Set(); set.add(f); listeners.set(k,set); },
  removeEventListener: (k,f) => listeners.get(k)?.delete(f), dispatchEvent: e => listeners.get(e.type)?.forEach(f=>f(e)),
  setInterval: f => { timers.set(++timerId,f); return timerId; }, clearInterval: id => timers.delete(id) };
const token = (tid, sub='u1', iat=1) => 'h.'+Buffer.from(JSON.stringify({tid,sub,iat})).toString('base64url')+'.s';
const modules = new Map();
const react = { useState: ()=>{}, useEffect: ()=>{}, useCallback: f=>f };
function load(rel) {
  if(modules.has(rel)) return modules.get(rel);
  const filename=path.join(root,rel);
  const out={}; modules.set(rel,out);
  const source=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(source,{exports:out,Error,require:n=>n==='react'?react:n.startsWith('@/')?load(n.slice(2)+'.ts'):require(n),window:win,document:doc,fetch:(...args)=>transport(...args),localStorage:win.localStorage,atob:s=>Buffer.from(s,'base64').toString('binary'),Event:class{constructor(type){this.type=type;}},setInterval:win.setInterval,clearInterval:win.clearInterval,queueMicrotask,console}, {filename});
  return out;
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function main(){
  const alerts=load('lib/alerts.ts');
  store.set('zhibi_token',token('A'));
  alerts.alertsMergeServer([{id:'p',type:'price-change',competitorName:'品牌A',text:'价格由10降至0',old:10,new:0,read:false}]);
  assert.equal(alerts.alertsLoad()[0].body,'价格由10降至0','price-change must retain server text');
  for(const type of ['price-discovered','product-launch','stockout']){
    alerts.alertsMergeServer([{id:type,type,competitorName:'品牌A',text:'服务端事实',read:false}]);
    assert.equal(alerts.alertsLoad()[0].body,'服务端事实');
    assert.match(alerts.alertsLoad()[0].title,/品牌A/);
  }
  alerts.alertsMergeServer([{id:'p',type:'price-change',competitorName:'品牌A',text:'更正正文',read:true}]);
  assert.equal(alerts.alertsLoad().find(a=>a.id==='p').body,'更正正文');
  assert.equal(alerts.alertsLoad().find(a=>a.id==='p').read,true);
  const scope=load('lib/storage-scope.ts');
  const before=scope.getStorageScope();
  store.set('zhibi_token',token('A','u1',2));
  assert.equal(scope.getStorageScope(),before,'token renewal retains stable namespace');
  const oldSession=scope.captureSession();
  store.set('zhibi_token',token('B'));
  assert.equal(alerts.alertsLoad().length,0,'another account cannot read alerts');
  alerts.alertsMergeServer([{id:'late',type:'price-change',text:'A response'}],oldSession);
  assert.equal(alerts.alertsLoad().length,0,'late response cannot enter new namespace');
  store.set('zb_alerts_v1',JSON.stringify([{id:'legacy'}]));
  store.set('ci_workbench_decisions',JSON.stringify({m:'keep'}));
  store.delete('zhibi_token');
  assert.equal(alerts.alertsLoad().length,0,'unknown account never reads legacy cache');
  const wb=load('lib/wb.ts');
  assert.deepEqual(Object.keys(wb.wbLoad()),[]);
  store.set('zhibi_token',token('A'));
  wb.wbHydrateFromServer({m:'keep'},'project1');
  assert.equal(wb.wbLoad().m,'keep');
  wb.wbHydrateFromServer({m:'ignore'},'project2');
  assert.equal(wb.wbLoad().m,'ignore','same material id in another project is isolated');
  wb.wbHydrateFromServer({},'project2');
  assert.equal(wb.wbLoad().m,undefined,'REST removes stale local decisions');
  const oldContext=wb.captureWorkbench();
  store.set('zhibi_token',token('B'));
  wb.wbSave({m:'keep'},oldContext);
  assert.deepEqual(Object.keys(wb.wbLoad()),[],'deferred writes cannot cross account');
  const refresh=load('lib/state-refresh.ts');
  for(const changed of [{materials:[{id:'m'}]},{briefStatus:'done'},{track:'new'},{observed_at:'new'},{fieldCorrections:[{id:'c',text:'new'}]}]){
    assert.notEqual(refresh.stateSignature({...changed}),refresh.stateSignature({}),'all REST fields participate in comparison');
  }
  let resolvers=[], applied=[], errors=[],done=0;
  const worker=refresh.createStateRefresh({read:()=>new Promise((resolve,reject)=>resolvers.push({resolve,reject})),apply:s=>applied.push(s),onError:e=>errors.push(e),onSettled:()=>done++,isCurrent:()=>true});
  const pending=worker.request(); worker.request();
  assert.equal(resolvers.length,1,'only one request in flight');
  resolvers.shift().resolve({track:'stale'}); await tick();
  assert.equal(applied.length,0,'invalidated in-flight response is not applied');
  assert.equal(resolvers.length,1,'dirty signal causes trailing REST request');
  resolvers.shift().resolve({track:'latest'}); await pending;
  assert.equal(applied[0].track,'latest');
  const failed=worker.request(); resolvers.shift().reject(new Error('offline')); await failed;
  assert.equal(applied.length,1,'failure preserves previous data'); assert.equal(errors.at(-1).message,'offline'); assert.ok(done>=2);
  const late=worker.request(); worker.close(); resolvers.shift().resolve({track:'late'}); await late;
  assert.equal(applied.length,1,'unmounted worker ignores completion');
  let finish, updates=0, alertErrors=[];
  store.set('zhibi_token',token('A'));
  const polling=alerts.startAlertsRefresh({read:()=>new Promise(resolve=>finish=resolve),onUpdate:()=>updates++,onError:e=>alertErrors.push(e)});
  assert.equal(timers.size,1,'alert polling has one bounded timer');
  finish({alerts:[{id:'polled',type:'stockout',text:'库存变化'}]}); await tick();
  assert.equal(updates,1);
  doc.visibilityState='hidden'; [...timers.values()][0](); assert.equal(updates,1);
  doc.visibilityState='visible'; docListeners.get('visibilitychange')();
  store.set('zhibi_token',token('B')); finish({alerts:[{id:'late-poll',type:'stockout',text:'A的提醒'}]}); await tick();
  assert.equal(updates,1,'old alert response cannot update a new account');
  polling.close(); assert.equal(timers.size,0); assert.equal(docListeners.size,0);
  const api=load('lib/api.ts');
  let respond;
  store.set('zhibi_token',token('A'));
  transport=()=>new Promise(resolve=>respond=resolve);
  const old401=api.apiGet('/api/state');
  store.set('zhibi_token',token('B'));
  respond({ok:false,status:401,json:async()=>({error:'AUTH_REQUIRED'})});
  await assert.rejects(old401,/账号已变化/);
  assert.equal(store.get('zhibi_token'),token('B'),'late A 401 must not log out B');
  transport=async()=>({ok:false,status:401,json:async()=>({error:'AUTH_REQUIRED'})});
  win.location={pathname:'/login'};
  await assert.rejects(api.apiGet('/api/state'));
  assert.equal(store.has('zhibi_token'),false,'current genuine auth failure clears token');
  // Real EventSource boundary, with fake transport/timers only.
  let es, changes=0, typed=0, closed=false;
  class FakeSource { constructor(){es=this;} close(){closed=true;} }
  const sseFile=fs.readFileSync(path.join(root,'lib/sse.ts'),'utf8');
  const sseOut={};
  vm.runInNewContext(ts.transpileModule(sseFile,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:sseOut,require:()=>({getToken:()=>token('A')}),window:win,EventSource:FakeSource,setInterval:win.setInterval,clearInterval:win.clearInterval});
  const handle=sseOut.connectStream({onEvent:()=>typed++,onChange:()=>changes++});
  es.onopen(); assert.equal(changes,1,'connection open rebuilds REST state');
  es.onmessage({data:JSON.stringify({type:'brand_found'})}); assert.equal(typed,1); assert.equal(changes,2,'typed state change also invalidates REST');
  es.onerror(); assert.equal(timers.size,1); es.onopen(); assert.equal(timers.size,0);
  handle.close(); es.onmessage({data:'{}'}); assert.equal(changes,3,'closed connection cannot notify'); assert.equal(closed,true);
  const ssr={};
  vm.runInNewContext(ts.transpileModule(sseFile,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{exports:ssr,require:()=>({})});
  assert.doesNotThrow(()=>ssr.connectStream({onEvent:()=>{},onChange:()=>{}}).close());
  console.log('PASS: REST trailing refresh, failures/unmount, SSE reconnect/typed/SSR, alert payloads and account/project storage isolation');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
