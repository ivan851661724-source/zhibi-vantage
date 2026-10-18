// Real profile/detail callbacks and useStateOperation/Provider; only React scheduling and transport are deterministic.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const root = path.join(__dirname, '../src');
const store = new Map(), events = new Map();
const token = user => 'h.' + Buffer.from(JSON.stringify({ tid: 'tenant', sub: user })).toString('base64url') + '.s';
store.set('zhibi_token', token('one'));
const window = { localStorage: { getItem: k => store.get(k) || null, setItem: (k,v) => store.set(k,v), removeItem: k => store.delete(k) }, addEventListener: (k,f) => { const s=events.get(k)||new Set(); s.add(f); events.set(k,s); }, removeEventListener:(k,f)=>events.get(k)?.delete(f), dispatchEvent:e=>events.get(e.type)?.forEach(f=>f(e)) };
let active, context, requests=[];
const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>x===b[i]);
const react={createContext:()=>({Provider:'Provider'}),useContext:()=>context,
 useState:init=>{const n=active.i++,o=active;if(!(n in o.slots))o.slots[n]=typeof init==='function'?init():init;return[o.slots[n],v=>{assert.ok(o.alive,'unmounted state write');o.slots[n]=typeof v==='function'?v(o.slots[n]):v;}];},
 useRef:init=>{const n=active.i++;return active.slots[n]||(active.slots[n]={current:init});},
 useMemo:(fn,deps)=>{const n=active.i++,old=active.slots[n];if(!old||!equal(old.deps,deps))active.slots[n]={deps,value:fn()};return active.slots[n].value;},
 useEffect:(fn,deps)=>{const n=active.i++,old=active.slots[n];if(!old||!equal(old.deps,deps)){old?.cleanup?.();const item={deps};active.slots[n]=item;active.effects.push(()=>{item.cleanup=fn();});}},
};react.useCallback=(fn,deps)=>react.useMemo(()=>fn,deps);
const jsx={jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key}),Fragment:'Fragment'};
const cache=new Map();
function load(rel){if(cache.has(rel))return cache.get(rel);const out={};cache.set(rel,out);const code=ts.transpileModule(fs.readFileSync(path.join(root,rel),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2017}}).outputText;
 vm.runInNewContext(code,{exports:out,Error,console,window,localStorage:window.localStorage,URL,Event:class{constructor(type){this.type=type;}},atob:s=>Buffer.from(s,'base64').toString('binary'),setInterval:()=>1,clearInterval(){},queueMicrotask,require:n=>{
 if(n==='react')return react;if(n==='react/jsx-runtime')return jsx;
 if(n==='@/lib/api')return {getToken:()=>store.get('zhibi_token'),apiGet:url=>new Promise((resolve,reject)=>requests.push({url,resolve,reject})),apiPost:()=>{throw new Error('unexpected mutation');}};
 if(n==='@/lib/demo')return {isDemoMode:()=>false,useIsDemoMode:()=>false};
 if(n==='@/lib/sse')return {connectStream:()=>({close(){}})};
 if(n==='@/lib/wb')return {wbHydrateFromServer(){},WB_MUTATION_EVENT:'wb-mutation'};
 if(n==='@/lib/toast')return {toast(){}};
 if(n.startsWith('@/')){const base=n.slice(2);return load(fs.existsSync(path.join(root,base+'.tsx'))?base+'.tsx':base+'.ts');}
 return require(n);}}, {filename:rel});return out;}
function mount(fn,props={}){return {fn,props,slots:[],effects:[],alive:true,render(){active=this;this.i=0;this.tree=this.fn(this.props);active=null;this.effects.splice(0).forEach(f=>f());return this.tree;},unmount(){this.slots.forEach(s=>s?.cleanup?.());this.alive=false;}};}
function view(fn,props){const instances=new Map();return {props,render(){const used=new Set();const expand=(n,p)=>{if(Array.isArray(n))return n.map((x,i)=>expand(x,p+'.'+(x?.key??i)));if(!n||typeof n!=='object')return n;if(typeof n.type==='function'){used.add(p);let ins=instances.get(p);if(ins&&ins.fn!==n.type){ins.unmount();instances.delete(p);ins=null;}if(!ins){ins=mount(n.type,n.props);instances.set(p,ins);}ins.props=n.props;return expand(ins.render(),p+'.r');}return {...n,props:{...n.props,children:expand(n.props?.children,p+'.c')}};};this.tree=expand({type:fn,props:this.props},'root');for(const [p,i] of instances)if(!used.has(p)){i.unmount();instances.delete(p);}return this.tree;},unmount(){instances.forEach(i=>i.unmount());instances.clear();}};}
function nodes(n,test,out=[]){if(Array.isArray(n)){n.forEach(x=>nodes(x,test,out));return out;}if(!n||typeof n!=='object')return out;if(test(n))out.push(n);nodes(n.props?.children,test,out);return out;}
const text=n=>n==null?'':typeof n==='object'?(Array.isArray(n)?n.map(text).join(''):text(n.props?.children)):String(n);
const tick=()=>new Promise(r=>setImmediate(r));
const take=prefix=>{const i=requests.findIndex(r=>r.url.startsWith(prefix));assert.ok(i>=0,'missing request '+prefix);return requests.splice(i,1)[0];};
const click=(v,label)=>{const b=nodes(v.render(),n=>n.type==='button'&&text(n)===label)[0];assert.ok(b,'missing button '+label);assert.ok(!b.props.disabled,'disabled button '+label);b.props.onClick();v.render();};
const metric={metric_id:'metric_one',metric_type:'catalog_active_product_price',evidence_status:'derived',algorithm_version:'catalog-price-1',config_version:'catalog-config-1',computed_at:'2026-10-17T01:00:00Z',observed_from:'2026-10-01T01:00:00Z',observed_to:'2026-10-01T01:05:00Z',currency:null,market:null,unit:null,value:{p25:17,median:31,p75:79},sample_product_count:3,product_counts:{observed:7,active_paid:3,free:1,unknown_availability:2,sold_out:1,invalid:1,missing_price:1},variant_counts:{observed:11,active_paid:5,active_free:1,unknown_availability:2,sold_out:1,invalid:2},partial_scan:true,limitations:['currency_unknown','market_unknown','unit_unknown','availability_unknown','invalid_or_missing_price','partial_scan']};
const snapshot={snapshot_id:'src_one',provider:'shopify_products_json',source_url:'https://store.example/products.json',observed_at:'2026-10-01T01:00:00Z',source_updated_at:'2026-09-29T01:00:00Z',collected_at:'2026-10-01T01:01:00Z',source_status:'success',content_hash:'sha256:example',collector_version:'collector-2',parser_version:'parser-2',raw_resolvable:false};
const fact={fact_id:'fact_one',entity_ref:{title:'<img src=x onerror=alert(1)>'},claim:{field:'product.price',scope:'public_price_observation'},value:{price_min:0,price_max:42,prices:[{variant_id:'v1',price:42,available:true},{variant_id:'v2',price:0,available:null}]},currency:null,unit:null,market:null,observed_at:snapshot.observed_at,evidence_ids:['ev_one','ev_missing'],source_snapshot_ids:['src_one'],derivation_version:'fact-2'};
const evidence={evidence_id:'ev_one',claim:fact.claim,extracted_value:fact.value,evidence_status:'verified',source:'shopify',observed_at:snapshot.observed_at,source_snapshot_ids:['src_one'],parser_version:'parser-2',extractor_version:'extractor-2'};
const page=(overrides={})=>({metric:{...metric,fact_ids:['fact_one','fact_two'],evidence_ids:['ev_one'],source_snapshot_ids:['src_one'],collection_snapshot_ids:['src_one','src_failed'],config:{minimum_product_sample:3}},facts:[fact],evidences:[evidence],snapshots:[snapshot],issues:[{kind:'evidence',id:'ev_missing',reason:'missing_or_inaccessible'},{kind:'raw',id:'src_one',reason:'raw_unavailable'}],collectionIssues:[{snapshot_id:'src_failed',source_status:'blocked',reason:'http_429',empty:false}],offset:0,limit:20,total:21,nextOffset:20,hasMore:true,...overrides});
async function main(){
 const provider=mount(load('hooks/use-zhibi-state.tsx').ZhibiStateProvider,{children:null});provider.render();take('/api/state').resolve({projectId:'A',competitors:[]});await tick();context=provider.render().props.value;
 const c={id:'c',name:'品牌',currency:'USD',priceStats:{median:999,band:{min:888,max:1000},currency:'USD',verdict:{code:'in_band'}},priceMetric:metric};
 const profile=view(load('components/intel-profile.tsx').IntelProfile,{c,state:{projectId:'A'},onCorrect(){}});profile.render();
 const block=nodes(profile.tree,n=>n.props?.['data-price-metric']==='metric_one')[0];
 assert.ok(block,'real business profile must display its server priceMetric');
 assert.match(text(block),/中位数 31/);assert.match(text(block),/17.*79/);assert.doesNotMatch(text(block),/999|888|\$|价格带同构/);
 for(const label of ['已观察目录价格统计','目录样本四分位区间','币种未知','市场未知','单位未知','可售性未知','无效或缺价','采集不完整','每商品一个观察点','观察时间','计算时间','新鲜度未知','含零价变体商品 1','可售零价 1'])assert.ok(text(block).includes(label),label);
 assert.doesNotMatch(text(block),/免费/,'zero listing prices do not prove free purchase conditions');
 profile.unmount();
 // Public Metric and the server's current user-specific price field are independent views.
 const corrected={...c,pricePoints:[100,200],priceField:{display:'PRIVATE_PRICE_SENTINEL',basis:'conflict',conflictNote:'QUARANTINE_SENTINEL',sources:[{url:'https://private.example/correction',text:'USER_EVIDENCE_SENTINEL',agrees:false}]}};
 const coexist=view(load('components/intel-profile.tsx').IntelProfile,{c:corrected,state:{projectId:'A'},onCorrect(){}});coexist.render();
 assert.match(text(coexist.tree),/PRIVATE_PRICE_SENTINEL/,'Metric must preserve the server-projected price field');
 assert.match(text(coexist.tree),/QUARANTINE_SENTINEL/,'Metric must preserve current quarantine/conflict explanation');
 assert.equal(nodes(coexist.tree,n=>n.type==='a'&&n.props.href==='https://private.example/correction').length,1,'price field correction source remains accessible');
 const privateBlock=nodes(coexist.tree,n=>n.props?.className==='field'&&text(n).includes('PRIVATE_PRICE_SENTINEL'))[0];
 assert.match(text(privateBlock),/价格字段（值级核验）/);assert.doesNotMatch(text(privateBlock),/中位数 31|已观察目录价格统计/,'private field has its own scope');
 const publicBlock=nodes(coexist.tree,n=>n.props?.['data-price-metric']==='metric_one')[0];
 assert.match(text(publicBlock),/中位数 31/);assert.match(text(publicBlock),/17.*79/);assert.doesNotMatch(text(publicBlock),/PRIVATE_PRICE_SENTINEL|QUARANTINE_SENTINEL|USER_EVIDENCE_SENTINEL|999|888/,'private corrections cannot alter the public Metric');
 coexist.unmount();
 const ordinary=view(load('components/intel-profile.tsx').IntelProfile,{c:{...c,priceField:{display:'ORDINARY_PRICE_FIELD',basis:'verified'}},state:{projectId:'A'},onCorrect(){}});ordinary.render();assert.match(text(ordinary.tree),/ORDINARY_PRICE_FIELD/);assert.doesNotMatch(text(ordinary.tree),/你的私有纠错/,'ordinary fields must not acquire invented private correction state');ordinary.unmount();
 const Small=view(load('components/price-metric-detail.tsx').PriceMetricBlock,{metric:{...metric,metric_id:'small',sample_product_count:2,value:{p25:null,median:null,p75:null},limitations:['insufficient_sample']}});Small.render();assert.match(text(Small.tree),/样本不足/);assert.doesNotMatch(text(Small.tree),/中位数 0/);Small.unmount();
 const detail=view(load('components/price-metric-detail.tsx').PriceMetricBlock,{metric});detail.render();click(detail,'展开统计依据');take('/api/price-metric?').resolve(page());await tick();detail.render();
 for(const label of ['fact_one','ev_one','src_one','42','available: true','available: null','观察时间','来源更新时间','采集时间','success','sha256:example','collector-2','parser-2','ev_missing','raw_unavailable','src_failed','blocked','http_429'])assert.ok(text(detail.tree).includes(label),'detail '+label);
 assert.ok(nodes(detail.tree,n=>n.type==='a'&&n.props.href==='https://store.example/products.json').length);
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
 const element=(n,p='static')=>Array.isArray(n)?n.map((x,i)=>element(x,p+'.'+i)):n&&typeof n==='object'?React.createElement(n.type==='Fragment'?React.Fragment:n.type,{...n.props,key:n.key??p},element(n.props?.children,p+'.c')):n;
 const html=renderToStaticMarkup(element(detail.tree));assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x|onerror="alert/,'source values must be React-escaped');
 click(detail,'继续加载依据');const oldPage=take('/api/price-metric?');assert.match(oldPage.url,/offset=20&limit=20$/);
 click(detail,'收起统计依据');click(detail,'展开统计依据');const reopened=take('/api/price-metric?');oldPage.resolve(page({facts:[{...fact,fact_id:'OLD_PAGE'}],offset:20}));await tick();detail.render();assert.doesNotMatch(text(detail.tree),/OLD_PAGE/);reopened.resolve(page());await tick();detail.render();click(detail,'继续加载依据');const failure=take('/api/price-metric?');failure.reject(new Error('page unavailable'));await tick();detail.render();assert.match(text(detail.tree),/page unavailable/);assert.match(text(detail.tree),/fact_one/);
 click(detail,'重试加载下一页');const retry=take('/api/price-metric?');assert.match(retry.url,/offset=20/);retry.resolve(page({facts:[{...fact,fact_id:'fact_two'}],offset:20,hasMore:false,nextOffset:null}));await tick();detail.render();assert.match(text(detail.tree),/fact_two/);assert.equal(nodes(detail.tree,n=>n.type==='button'&&text(n)==='继续加载依据').length,0);
 click(detail,'查看证据 ev_one');const er=take('/api/evidence-detail?');er.resolve({evidence,snapshots:[{...snapshot,source_url:'javascript:alert(1)'}],issues:[{kind:'snapshot',id:'gone',reason:'missing_or_inaccessible'}]});await tick();detail.render();assert.match(text(detail.tree),/gone/);assert.equal(nodes(detail.tree,n=>n.type==='a'&&String(n.props.href).startsWith('javascript:')).length,0);
 click(detail,'查看证据 ev_one');const staleEvidence=take('/api/evidence-detail?');click(detail,'查看证据 ev_one');const newEvidence=take('/api/evidence-detail?');staleEvidence.reject(new Error('OLD_SEQUENCE'));newEvidence.reject(new Error('evidence unavailable'));await tick();detail.render();assert.doesNotMatch(text(detail.tree),/OLD_SEQUENCE/);assert.match(text(detail.tree),/evidence unavailable/);click(detail,'重试读取证据');take('/api/evidence-detail?').resolve({evidence,snapshots:[snapshot],issues:[]});await tick();detail.render();assert.doesNotMatch(text(detail.tree),/evidence unavailable/);
 click(detail,'收起统计依据');click(detail,'展开统计依据');const old=take('/api/price-metric?');click(detail,'收起统计依据');click(detail,'展开统计依据');const fresh=take('/api/price-metric?');old.resolve(page({facts:[{...fact,fact_id:'OLD_CLOSED'}]}));await tick();detail.render();assert.doesNotMatch(text(detail.tree),/OLD_CLOSED/);fresh.reject(new Error('first read failed'));await tick();detail.render();assert.match(text(detail.tree),/first read failed/);click(detail,'重试读取依据');take('/api/price-metric?').resolve(page());await tick();detail.render();
 click(detail,'查看证据 ev_one');const oldEvidence=take('/api/evidence-detail?');click(detail,'关闭证据详情');oldEvidence.reject(new Error('OLD_EVIDENCE'));await tick();detail.render();assert.doesNotMatch(text(detail.tree),/OLD_EVIDENCE/);
 click(detail,'收起统计依据');click(detail,'展开统计依据');const metricOld=take('/api/price-metric?');detail.props={metric:{...metric,metric_id:'metric_two'}};detail.render();metricOld.resolve(page({facts:[{...fact,fact_id:'OLD_METRIC'}]}));await tick();detail.render();assert.doesNotMatch(text(detail.tree),/OLD_METRIC|fact_one|first read failed/);click(detail,'展开统计依据');const abandoned=take('/api/price-metric?');assert.match(abandoned.url,/id=metric_two/);
 detail.unmount();abandoned.resolve(page());await tick();
 async function adopt(projectId){const task=context.refresh();take('/api/state').resolve({projectId,competitors:[]});await task;context=provider.render().props.value;}
 for(const mode of ['project','session','unmount']){
  const v=view(load('components/price-metric-detail.tsx').PriceMetricBlock,{metric});v.render();click(v,'展开统计依据');take('/api/price-metric?').resolve(page());await tick();v.render();click(v,'继续加载依据');const pendingPage=take('/api/price-metric?');click(v,'查看证据 ev_one');const pendingEvidence=take('/api/evidence-detail?');
  if(mode==='project'){await adopt('B');await adopt('A');v.render();}
  if(mode==='session'){store.set('zhibi_token',token('two'));window.dispatchEvent({type:'zhibi-session-changed'});context=provider.render().props.value;v.render();}
  if(mode==='unmount')v.unmount();
  pendingPage.resolve(page({facts:[{...fact,fact_id:'OLD_'+mode}],offset:20}));pendingEvidence.reject(new Error('OLD_'+mode));await tick();if(mode!=='unmount'){v.render();assert.doesNotMatch(text(v.tree),new RegExp('OLD_'+mode));assert.doesNotMatch(text(v.tree),/fact_one|正在读取证据|统计依据读取失败/);v.unmount();}
  if(mode==='session'){take('/api/state').resolve({projectId:'A',competitors:[]});await tick();context=provider.render().props.value;}
 }
 // Initial reads have the same Provider generation/session protection as paging/evidence.
 for(const mode of ['project','session']){const v=view(load('components/price-metric-detail.tsx').PriceMetricBlock,{metric});v.render();click(v,'展开统计依据');const pending=take('/api/price-metric?');if(mode==='project'){await adopt('B');await adopt('A');}else{store.set('zhibi_token',token('three'));window.dispatchEvent({type:'zhibi-session-changed'});context=provider.render().props.value;}pending.reject(new Error('OLD_INITIAL'));await tick();v.render();assert.doesNotMatch(text(v.tree),/OLD_INITIAL|正在读取统计依据/);v.unmount();if(mode==='session'){take('/api/state').resolve({projectId:'A',competitors:[]});await tick();context=provider.render().props.value;}}
 const orphaned=requests.filter(r=>!r.url.startsWith('/api/user-notes'));assert.equal(orphaned.length,0,'every metric/evidence/provider response is settled by its test');
 provider.unmount();console.log('PASS: real profile + Metric detail callbacks, server values/unknown scope, paging/retry/issues/evidence and close/metric/project A→B→A/session/unmount ownership');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
