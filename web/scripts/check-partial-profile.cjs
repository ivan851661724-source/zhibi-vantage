const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const modules = new Map();
function load(rel) {
  if (modules.has(rel)) return modules.get(rel);
  const out={}; modules.set(rel,out);
  const filename=path.join(__dirname,'../src',rel);
  const js=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  vm.runInNewContext(js,{exports:out,require:n=>{
    if(n==='@/hooks/use-zhibi-state') return {useZhibiState:()=>({state:null,refresh:async()=>{}}),useStateOperation:()=>()=>({isCurrent:()=>true})};
    if(n.startsWith('@/')) { const base=n.slice(2); return load(fs.existsSync(path.join(__dirname,'../src',base+'.tsx'))?base+'.tsx':base+'.ts'); }
    return require(n);
  }});
  return out;
}
const {IntelProfile}=load('components/intel-profile.tsx');
const base={id:'c',name:'品牌',priceStats:{median:12,band:{min:10,max:20},sample:{used:2,onSale:3},currency:'USD'}};
const render=c=>renderToStaticMarkup(React.createElement(IntelProfile,{c,state:{competitors:[c]},onCorrect:()=>{}}));
const partial=render({...base,shopifyPartialScan:true,shopifyPartialScanReason:'products_json_page_2_http_429'});
assert.match(partial,/采集不完整/,'partial scan must be visible beside price statistics');
assert.match(partial,/后续页面/,'failed pagination gets a product explanation');
assert.match(partial,/商品价格/); assert.doesNotMatch(partial,/客单价/);
assert.match(render({...base,shopifyTruncated:true}),/采集不完整/,'legacy truncated catalog remains visible');
assert.match(render({id:'c',name:'品牌',shopifyPartialScan:true,shopifyPartialScanReason:'products_json_pagination_budget_250x4_exhausted'}),/采集不完整/,'partial catalog remains visible without a median');
assert.doesNotMatch(render(base),/采集不完整/,'complete legacy records do not fabricate a gap');
console.log('PASS: partial/legacy catalogs and missing statistics render visible limits; product prices are not AOV');
