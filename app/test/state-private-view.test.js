'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-private-state-'));
process.env.ZB_DATA_DIR = temp;
process.env.MT_STORE_PATH = path.join(temp, 'tenant.db');
const read = require('../routes/handlers/read.js');
const fields = require('../research/fields.js');
const overlay = require('../lib/correction-overlay.js');
const publicState = { projectId:'A', competitors:[{id:'c',name:'Brand',status:'done',currency:'USD',priceClaims:[{tier:1,kind:'shopify',value:[20,20],url:'https://brand.example/products'}],reviews:{rating:4,trend:'down',negThemes:['old'],posThemes:['legacy']}}] };
function correction(id,field,type,status,value=null){return {id,competitorId:'c',field,type,status,value,at:'2026-10-17T00:00:00Z'};}
async function request(identity, query='?private_view=1') {
  let status,body;
  const ctx={...fields,loadState:()=>publicState,computeWhiteSpace:()=>({}),marketCurrency:()=> 'USD',config0:{},
    resolveIdentity:()=>identity,correctionOverlay:overlay,
    decorateState:s=>{for(const c of s.competitors){c.priceField=fields.getPriceField(c,[]);c.reviewField=fields.getReviewField(c,[]);}return s;},
    sendJSON:(_,code,value)=>{status=code;body=value;}};
  await read.state(ctx,{method:'GET'}, {},new URL('http://local/api/state'+query),'/api/state');
  return {status,body};
}
(async()=>{
  const alice={tenantId:'t',userId:'alice'},bob={tenantId:'t',userId:'bob'};
  overlay.setCorrection('t','alice',correction('rating','reviews.rating','confirm-correct','accepted'));
  overlay.setCorrection('t','alice',correction('price','price','confirm-correct','accepted'));
  overlay.setCorrection('t','bob',correction('trend','reviews.trend','wrong-value','pending','down'));
  const first=await request(alice);assert.equal(first.status,200);assert.equal(first.body.competitors[0].reviewField.trend.value,'down');
  publicState.competitors[0].reviews={rating:4.8,trend:'up',negThemes:['fresh'],posThemes:['new positive']};
  publicState.competitors[0].priceClaims=[{tier:1,kind:'shopify',value:[36,36],url:'https://brand.example/products'}];
  delete publicState.competitors[0].priceField;
  overlay.setCorrection('t','alice',correction('trend-confirm','reviews.trend','confirm-correct','accepted'));
  // Establish default/public projection, then prove the private read cannot mutate it.
  const normal=await request(alice,'');const publicBefore=JSON.stringify(publicState);
  const pending=await request(bob);const c=pending.body.competitors[0];
  assert.equal(c.reviewField.pendingQuarantine,true,'real pending rule must appear in current user view');
  assert.equal(c.reviewField.trend.value,'up','pending proposed value does not override current source');
  assert.equal(JSON.stringify(publicState),publicBefore,'private soft quarantine cannot mutate public input');
  const current=await request(alice);const own=current.body.competitors[0];
  assert.equal(own.reviewField.rating.value,4.8);assert.equal(own.reviewField.trend.value,'up');assert.equal(own.reviewField.negThemes.items[0].text,'fresh');
  assert.equal(own.reviewField.pendingQuarantine,undefined,'another user pending correction cannot leak');
  assert.match(own.priceField.display,/36/,'confirm-correct cannot freeze old product price');
  assert.equal(JSON.stringify(publicState),publicBefore);
  assert.equal(normal.body.competitors[0].reviewField.pendingQuarantine,undefined,'default GET stays public');
  const other=await request({tenantId:'other',userId:'bob'},'?private_view=1&userId=bob&tenantId=t');
  assert.equal(other.body.competitors[0].reviewField.pendingQuarantine,undefined,'query identity cannot select another tenant/user');
  for(const identity of [{ghost:true,tenantId:'t',userId:'bob'},{error:401},{tenantId:'t'}])assert.equal((await request(identity)).status,403,'unresolved/ghost identity must fail closed');
  console.log('PASS: private state uses real correction rules, fresh review siblings/price, pending quarantine, identity isolation, immutable public input and default compatibility');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
