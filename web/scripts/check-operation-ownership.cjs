// Exercises real Provider callbacks and real component handlers with deterministic hook/transport boundaries.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const root=path.join(__dirname,'../src');
const store=new Map(), events=new Map();
const token='h.'+Buffer.from(JSON.stringify({tid:'t',sub:'u'})).toString('base64url')+'.s'; store.set('zhibi_token',token);
const window={localStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},addEventListener:(k,f)=>{const s=events.get(k)||new Set();s.add(f);events.set(k,s);},removeEventListener:(k,f)=>events.get(k)?.delete(f),dispatchEvent:e=>events.get(e.type)?.forEach(f=>f(e)),confirm:()=>true};
let active,context,requests=[],toasts=[],routes=[],timerId=0;
const timers=new Map();
const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const react={
 createContext:()=>({Provider:'Provider'}),useContext:()=>context,
 useState:init=>{const n=active.i++,o=active; if(!(n in o.slots))o.slots[n]=typeof init==='function'?init():init;return[o.slots[n],v=>{o.slots[n]=typeof v==='function'?v(o.slots[n]):v;}];},
 useRef:init=>{const n=active.i++;return active.slots[n]||(active.slots[n]={current:init});},
 useMemo:(fn,deps)=>{const n=active.i++,old=active.slots[n];if(!old||!equal(old.deps,deps))active.slots[n]={deps,value:fn()};return active.slots[n].value;},
 useEffect:(fn,deps)=>{const n=active.i++,old=active.slots[n];if(!old||!equal(old.deps,deps)) {if(old?.cleanup)old.cleanup();const item={deps};active.slots[n]=item;active.effects.push(()=>{item.cleanup=fn();});}},
}; react.useCallback=(fn,deps)=>react.useMemo(()=>fn,deps);
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'Fragment'};
const cache=new Map();
const transport=(url,body)=>{
 const caller=(new Error().stack.split('\n').find(line=>line.includes('lib/wb.ts')||line.includes('hooks/use-zhibi-state.tsx'))||'');
 return new Promise((resolve,reject)=>requests.push({url:url.split('?')[0],actualUrl:url,body,resolve,reject,fromWorkbench:caller.includes('lib/wb.ts')}));
};
function load(rel){if(cache.has(rel))return cache.get(rel);const out={};cache.set(rel,out);const code=ts.transpileModule(fs.readFileSync(path.join(root,rel),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2017}}).outputText;
 vm.runInNewContext(code,{exports:out,Error,console,window,localStorage:window.localStorage,Event:class{constructor(type){this.type=type;}},atob:s=>Buffer.from(s,'base64').toString('binary'),setInterval:f=>{timers.set(++timerId,f);return timerId;},clearInterval:id=>timers.delete(id),queueMicrotask,require:n=>{
 if(n==='react')return react;if(n==='react/jsx-runtime')return jsx;
 if(n==='next/navigation')return {useRouter:()=>({push:r=>routes.push(r)})};
 if(n==='@/lib/api')return {getToken:()=>token,apiGet:url=>transport(url),apiPost:(url,body)=>transport(url,body)};
 if(n==='@/lib/demo')return {isDemoMode:()=>false,useIsDemoMode:()=>false,getDemoSource:()=>'',buildDemoState:async()=>({})};
 if(n==='@/lib/sse')return {connectStream:()=>({close(){}})};
 if(n==='@/lib/toast')return {toast:m=>toasts.push(m)};
 if(n.startsWith('@/')){const base=n.slice(2);return load(fs.existsSync(path.join(root,base+'.tsx'))?base+'.tsx':base+'.ts');}
 return require(n);
 }},{filename:rel});return out;}
function mount(fn,props={}){const instance={fn,props,slots:[],effects:[],i:0,render(){active=this;this.i=0;this.tree=this.fn(this.props);active=null;const effects=this.effects.splice(0);effects.forEach(f=>f());return this.tree;},unmount(){this.slots.forEach(s=>s?.cleanup?.());}};instance.render();return instance;}
function nodes(tree,predicate,out=[]){if(!tree||typeof tree!=='object')return out;if(predicate(tree))out.push(tree);const kids=tree.props?.children;(Array.isArray(kids)?kids:[kids]).flat(Infinity).forEach(c=>nodes(c,predicate,out));return out;}
const text=n=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):n&&typeof n==='object'?text(n.props?.children):'';
const tick=()=>new Promise(r=>setImmediate(r));
async function main(){
 const provider=mount(load('hooks/use-zhibi-state.tsx').ZhibiStateProvider,{children:null});
 const renderProvider=()=>{context=provider.render().props.value;return context;};
 const initial=requests.shift();assert.equal(initial.actualUrl,'/api/state?private_view=1','Provider reads fresh server-side user projection');initial.resolve({projectId:'A',competitors:[{id:'c',name:'品牌'}]});await tick();renderProvider();
 async function settleProvider(projectId,decisions={}) {
   for(let n=0;n<5;n++) {
     const pending=requests.filter(r=>r.url==='/api/state'&&!r.fromWorkbench);
     if(!pending.length)return;
     pending.forEach(r=>{requests.splice(requests.indexOf(r),1);r.resolve({projectId,decisions,competitors:[{id:'c',name:'品牌'}]});});await tick();
   }
   throw new Error('Provider refresh did not settle');
 }
 async function adopt(projectId){
   if(context.switchProject){const task=context.switchProject(projectId,()=>true);await tick();const req=requests.find(r=>r.url==='/api/projects/switch');requests.splice(requests.indexOf(req),1);req.resolve({projectId,competitors:[{id:'c',name:'品牌'}]});await task;}
   else context.patch({projectId,competitors:[{id:'c',name:'品牌'}]});
   await settleProvider(projectId);renderProvider();
 }
 const profile=mount(load('components/intel-profile.tsx').IntelProfile,{c:{id:'c',name:'品牌'},state:context.state,onCorrect(){}});
 const blankType=nodes(profile.tree,n=>typeof n.type==='function'&&n.type.name==='BlankItems')[0];
 const blank=mount(blankType.type,blankType.props);
 nodes(blank.tree,n=>n.type==='button')[0].props.onClick();
 const oldDive=requests.find(r=>r.url==='/api/deepdive');requests.splice(requests.indexOf(oldDive),1);
 await adopt('B');
 oldDive.resolve({state:{projectId:'A',competitors:[{id:'c',name:'OLD'}]},results:[{ok:true}]});await tick();
 assert.equal(renderProvider().state.projectId,'B','real old deepdive handler must not overwrite a switched project');
 assert.equal(toasts.length,0,'stale consumer must not claim success');
 // A→B→A still invalidates the original A operation, despite equal project ids.
 await adopt('A');
 const profile2=mount(load('components/intel-profile.tsx').IntelProfile,{c:{id:'c',name:'品牌'},state:context.state,onCorrect(){}});
 const b2=nodes(profile2.tree,n=>typeof n.type==='function'&&n.type.name==='BlankItems')[0];const blank2=mount(b2.type,b2.props);
 nodes(blank2.tree,n=>n.type==='button')[0].props.onClick();const cycle=requests.find(r=>r.url==='/api/deepdive');requests.splice(requests.indexOf(cycle),1);
 await adopt('B');await adopt('A');cycle.resolve({state:{projectId:'A',competitors:[{id:'c',name:'CYCLE OLD'}]},results:[{ok:true}]});await tick();
 assert.equal(renderProvider().state.competitors[0].name,'品牌');
 // Same-project report completion must not replace newer authoritative fields/decisions.
 context.state={...context.state,briefStatus:'running',briefStartedAt:Date.now()};
 const sameReport=mount(load('app/(panel)/report/page.tsx').default);[...timers.values()][0]();
 const staleSameReport=requests.find(r=>r.url==='/api/state');requests.splice(requests.indexOf(staleSameReport),1);
 const newerRead=context.refresh();const newerRequest=requests.find(r=>r.url==='/api/state');requests.splice(requests.indexOf(newerRequest),1);
 newerRequest.resolve({projectId:'A',competitors:[{id:'c',name:'NEW_AUTHORITATIVE'}],decisions:{m:'keep'}});await newerRead;renderProvider();
 staleSameReport.resolve({projectId:'A',competitors:[{id:'c',name:'OLD_SNAPSHOT'}],decisions:{},briefStatus:'done'});await tick();
 assert.equal(renderProvider().state.competitors[0].name,'NEW_AUTHORITATIVE','same-project old report cannot overwrite newer REST');
 const wbBeforeWrites=load('lib/wb.ts');assert.equal(wbBeforeWrites.wbLoad().m,'keep','old report must not erase newer decisions');
 const reportRecovery=requests.find(r=>r.url==='/api/state');assert.ok(reportRecovery,'local completion reconciles authoritative REST without SSE');requests.splice(requests.indexOf(reportRecovery),1);reportRecovery.resolve({projectId:'A',competitors:[{id:'c',name:'NEW_AUTHORITATIVE'}],decisions:{m:'keep'},briefStatus:'done'});await tick();renderProvider();sameReport.unmount();assert.equal(timers.size,0);
 // A late private rating response cannot replay old trend/theme siblings over a newer read.
 const privateModal=mount(load('components/field-correct.tsx').FieldCorrectModal,{competitorId:'c',initialField:'reviews.rating',onClose(){}});
 nodes(privateModal.tree,n=>n.type==='select')[1].props.onChange({target:{value:'confirm-correct'}});privateModal.render();nodes(privateModal.tree,n=>n.type==='button'&&text(n).includes('提交纠错'))[0].props.onClick();
 const stalePrivate=requests.find(r=>r.url==='/api/field-correct');requests.splice(requests.indexOf(stalePrivate),1);
 const latestSystem={projectId:'A',competitors:[{id:'c',name:'LATEST_SYSTEM',priceField:{display:'SYSTEM36'},reviewField:{rating:{value:4.8},trend:{value:'up'},negThemes:{items:[{text:'fresh'}]}},systemExtra:'new field'}],decisions:{m:'keep'}};
 const systemRead=context.refresh();const systemRequest=requests.find(r=>r.url==='/api/state');requests.splice(requests.indexOf(systemRequest),1);systemRequest.resolve(latestSystem);await systemRead;renderProvider();
 stalePrivate.resolve({private:true,status:'accepted',correction:{competitorId:'c',field:'reviews.rating',type:'confirm-correct'},reviewField:{rating:{value:4},trend:{value:'down'},negThemes:{items:[{text:'old'}]}},state:{projectId:'A',competitors:[{id:'c',name:'OLD_CORRECTION_SYSTEM'}],decisions:{}}});await tick();
 assert.equal(renderProvider().state.competitors[0].name,'LATEST_SYSTEM');assert.equal(context.state.competitors[0].systemExtra,'new field');assert.equal(context.state.competitors[0].reviewField.trend.value,'up','rating correction must not replay old trend sibling');assert.equal(context.state.competitors[0].reviewField.negThemes.items[0].text,'fresh');assert.equal(wbBeforeWrites.wbLoad().m,'keep');
 const privateRecovery=requests.find(r=>r.url==='/api/state');assert.ok(privateRecovery);requests.splice(requests.indexOf(privateRecovery),1);privateRecovery.resolve(latestSystem);await tick();renderProvider();assert.equal(context.state.competitors[0].reviewField.rating.value,4.8,'confirm-correct must follow latest source rather than freeze old value');privateModal.unmount();
 // A second private review subfield update also follows the newest sibling values.
 const trendModal=mount(load('components/field-correct.tsx').FieldCorrectModal,{competitorId:'c',initialField:'reviews.trend',onClose(){}});
 nodes(trendModal.tree,n=>n.type==='select')[1].props.onChange({target:{value:'confirm-correct'}});trendModal.render();nodes(trendModal.tree,n=>n.type==='button'&&text(n).includes('提交纠错'))[0].props.onClick();
 const lateTrend=requests.find(r=>r.url==='/api/field-correct');requests.splice(requests.indexOf(lateTrend),1);
 const secondSystem={...latestSystem,competitors:[{...latestSystem.competitors[0],reviewField:{rating:{value:5},trend:{value:'stable'},negThemes:{items:[{text:'fresh2'}]}}}]};
 const secondRead=context.refresh();const secondReq=requests.find(r=>r.url==='/api/state');requests.splice(requests.indexOf(secondReq),1);secondReq.resolve(secondSystem);await secondRead;renderProvider();
 lateTrend.resolve({private:true,status:'accepted',correction:{competitorId:'c',field:'reviews.trend',type:'confirm-correct'},reviewField:latestSystem.competitors[0].reviewField,state:latestSystem});await tick();renderProvider();assert.equal(context.state.competitors[0].reviewField.rating.value,5,'trend confirmation cannot replay an older rating');assert.equal(context.state.competitors[0].reviewField.negThemes.items[0].text,'fresh2');
 const trendRecovery=requests.find(r=>r.url==='/api/state');requests.splice(requests.indexOf(trendRecovery),1);trendRecovery.resolve(secondSystem);await tick();renderProvider();assert.equal(context.state.competitors[0].reviewField.trend.value,'stable');assert.equal(latestSystem.competitors[0].priceField.display,'SYSTEM36');trendModal.unmount();
 // Restore the ordinary fixture for the remaining ownership cases.
 await adopt('B');await adopt('A');toasts=[];
 // Real correction modal, including its onClose/success side effects.
 let closed=0;
 const correction=mount(load('components/field-correct.tsx').FieldCorrectModal,{competitorId:'c',onClose:()=>closed++});
 nodes(correction.tree,n=>n.type==='select')[1].props.onChange({target:{value:'confirm-correct'}});correction.render();
 nodes(correction.tree,n=>n.type==='button'&&text(n).includes('提交纠错'))[0].props.onClick();
 const oldCorrection=requests.find(r=>r.url==='/api/field-correct');assert.ok(oldCorrection);requests.splice(requests.indexOf(oldCorrection),1);
 await adopt('B');oldCorrection.resolve({state:{projectId:'A',competitors:[{id:'c',name:'OLD CORRECTION'}]},status:'pending'});await tick();
 assert.equal(renderProvider().state.projectId,'B');assert.equal(closed,0,'stale correction must not close current UI');assert.equal(toasts.length,0);
 await adopt('A');
 // Real report polling result cannot patch after switching away and back.
 context.state={...context.state,briefStatus:'running',briefStartedAt:Date.now()};
 const report=mount(load('app/(panel)/report/page.tsx').default);
 assert.equal(timers.size,1);[...timers.values()][0]();
 const oldReport=requests.find(r=>r.url==='/api/state');requests.splice(requests.indexOf(oldReport),1);
 await adopt('B');await adopt('A');oldReport.resolve({projectId:'A',competitors:[{id:'c',name:'OLD REPORT'}],briefStatus:'done',brief:{markdown:'old'}});await tick();
 assert.equal(renderProvider().state.competitors[0].name,'品牌');report.unmount();assert.equal(timers.size,0);
 // Unmounted real consumer cannot patch or toast.
 nodes(blank2.render(),n=>n.type==='button')[0].props.onClick();const abandoned=requests.find(r=>r.url==='/api/deepdive');requests.splice(requests.indexOf(abandoned),1);blank2.unmount();abandoned.resolve({state:{projectId:'A',competitors:[{id:'c',name:'UNMOUNTED'}]},results:[{ok:true}]});await tick();
 assert.equal(renderProvider().state.competitors[0].name,'品牌');
 // Real material hook: one request in flight, newer optimistic decision survives old REST/ack.
 const wb=load('lib/wb.ts');wb.wbHydrateFromServer({},'A');
 const decisions=mount(()=>wb.useWbDecisions());decisions.tree[1]('m','keep');decisions.render().at(1)('m','ignore');await tick();
 let writes=requests.filter(r=>r.url==='/api/material-action');assert.equal(writes.length,1,'same-project writes must be serialized');
 assert.equal(writes[0].body.projectId,'A');wb.wbHydrateFromServer({m:'keep'},'A');assert.equal(wb.wbLoad().m,'ignore','REST cannot overwrite a pending decision');
 requests.splice(requests.indexOf(writes[0]),1);writes[0].resolve({projectId:'A',decisions:{m:'keep'}});await tick();
 assert.equal(wb.wbLoad().m,'ignore','old acknowledgement cannot roll back latest intent');
 writes=requests.filter(r=>r.url==='/api/material-action');assert.equal(writes.length,1);assert.equal(writes[0].body.action,'ignore');requests.splice(requests.indexOf(writes[0]),1);writes[0].resolve({projectId:'A',decisions:{m:'ignore'}});await tick();
 const reconcile=requests.find(r=>r.url==='/api/state'&&r.fromWorkbench);assert.ok(reconcile,'queue completion reconciles authoritative REST');requests.splice(requests.indexOf(reconcile),1);reconcile.resolve({projectId:'A',decisions:{m:'ignore'}});await tick();assert.equal(wb.wbLoad().m,'ignore');await settleProvider('A',{m:'ignore'});
 decisions.render().at(1)('x','keep');decisions.render().at(1)('y','later');await tick();
 const oldWrite=requests.find(r=>r.url==='/api/material-action');requests.splice(requests.indexOf(oldWrite),1);
 wb.wbHydrateFromServer({},'B');wb.wbHydrateFromServer({},'A');oldWrite.resolve({projectId:'A',decisions:{x:'keep'}});await tick();
 assert.equal(requests.filter(r=>r.url==='/api/material-action').length,0,'old queued project writes must not dispatch after A→B→A');
 assert.deepEqual(Object.keys(wb.wbLoad()),[]);await settleProvider('A');
 // A Provider read begun before writes must not erase the final acknowledged decisions.
 const staleRefresh=context.refresh();
 const staleProviderRead=requests.find(r=>r.url==='/api/state');assert.ok(staleProviderRead);requests.splice(requests.indexOf(staleProviderRead),1);
 decisions.render().at(1)('race','keep');decisions.render().at(1)('race','ignore');await tick();
 const firstRace=requests.find(r=>r.url==='/api/material-action');requests.splice(requests.indexOf(firstRace),1);firstRace.resolve({projectId:'A',decisions:{race:'keep'}});await tick();
 const secondRace=requests.find(r=>r.url==='/api/material-action');requests.splice(requests.indexOf(secondRace),1);secondRace.resolve({projectId:'A',decisions:{race:'ignore'}});await tick();
 const raceReconcile=requests.find(r=>r.url==='/api/state'&&r.fromWorkbench);requests.splice(requests.indexOf(raceReconcile),1);raceReconcile.resolve({projectId:'A',decisions:{race:'ignore'}});await tick();
 assert.equal(wb.wbLoad().race,'ignore');
 staleProviderRead.resolve({projectId:'A',decisions:{},competitors:[{id:'c',name:'品牌'}]});await tick();
 assert.equal(wb.wbLoad().race,'ignore','pre-write Provider REST cannot erase acknowledged decisions');
 const freshProviderRead=requests.find(r=>r.url==='/api/state');assert.ok(freshProviderRead,'mutation completion schedules authoritative Provider recovery without SSE');requests.splice(requests.indexOf(freshProviderRead),1);freshProviderRead.resolve({projectId:'A',decisions:{race:'ignore'},competitors:[{id:'c',name:'品牌'}]});await staleRefresh;renderProvider();
 // Real history handlers preserve latest switch both in UI and server dispatch ordering.
 const historyOuter=mount(load('app/(panel)/history/page.tsx').default);
 const history=mount(historyOuter.tree.type,historyOuter.tree.props);
 const listRequest=requests.find(r=>r.url==='/api/projects');requests.splice(requests.indexOf(listRequest),1);listRequest.resolve({projects:[{id:'A',current:true},{id:'B'},{id:'C'}]});await tick();history.render();
 const buttons=nodes(history.tree,n=>n.type==='button'&&n.props.className?.includes('hi-open'));
 buttons[0].props.onClick();await tick();buttons[1].props.onClick();await tick();
 const firstSwitch=requests.find(r=>r.url==='/api/projects/switch');assert.equal(firstSwitch.body.id,'B');assert.equal(requests.filter(r=>r.url==='/api/projects/switch').length,1);
 requests.splice(requests.indexOf(firstSwitch),1);firstSwitch.resolve({projectId:'B',competitors:[]});await tick();assert.equal(routes.length,0,'old switch completion must not navigate');
 const latestSwitch=requests.find(r=>r.url==='/api/projects/switch');assert.equal(latestSwitch.body.id,'C');requests.splice(requests.indexOf(latestSwitch),1);latestSwitch.resolve({projectId:'C',competitors:[]});await tick();await settleProvider('C');assert.equal(renderProvider().state.projectId,'C');assert.deepEqual(routes,['/']);
 // An already dispatched history switch still changes the server pointer after its page unmounts.
 history.render();const reopened=nodes(history.tree,n=>n.type==='button'&&n.props.className?.includes('hi-open'))[0];
 reopened.props.onClick();await tick();const abandonedSwitch=requests.find(r=>r.url==='/api/projects/switch');assert.ok(abandonedSwitch);requests.splice(requests.indexOf(abandonedSwitch),1);history.unmount();
 abandonedSwitch.resolve({projectId:'B',competitors:[]});await tick();
 const switchRecovery=requests.find(r=>r.url==='/api/state');assert.ok(switchRecovery,'dispatched switch completion rebuilds Provider even after caller unmount');requests.splice(requests.indexOf(switchRecovery),1);switchRecovery.resolve({projectId:'B',competitors:[]});await tick();assert.equal(renderProvider().state.projectId,'B');assert.deepEqual(routes,['/'],'unmounted history must not navigate');
 console.log('PASS: real Provider + deepdive/correction/report/history consumers, A→B→A/unmount, latest ordered switches, serialized/pending decisions and REST reconciliation');
 provider.unmount();
}
main().catch(e=>{console.error(e);process.exitCode=1;});
