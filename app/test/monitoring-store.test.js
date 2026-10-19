'use strict';
// Synthetic server integration records only: no production identity/qualification producer exists.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-monitoring-'));
  process.env.ZB_DATA_DIR = dir;
  process.env.MT_STORE_PATH = path.join(dir, 'multitenant.db');
  process.env.OBS_DB_PATH = path.join(dir, 'observability.db');
  global.fetch = () => { throw new Error('network forbidden'); };
  const { createMonitoringStore } = require('../services/monitoring-store');
  const store = createMonitoringStore({ dataDir: dir });
  const tenantId = 'tenant/a';
  const ns = 'tenant_a';
  const write = (rel, value) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); };
  function seed(workspace, suffix = '1') {
    const brandId = 'brand' + suffix, qualificationResultId = 'qual' + suffix, projectId = 'project-' + suffix, competitorId = 'comp' + suffix;
    const input = { tenantId, workspaceId: workspace.workspace_id, projectId, competitorId, brandId, qualificationResultId, categoryScope: 'shoes', idempotencyKey: 'target-' + suffix, now: 0 };
    const tenant = { tenant_id: tenantId, project_ref: projectId };
    const ss = 'ss' + suffix, ev = 'ev' + suffix;
    const raw = '{"products":[{"id":1,"handle":"synthetic-shoe","variants":[{"id":11,"price":"10.00"}]}]}';
    write('snapshots/' + ns + '/20261017/' + ss + '.raw', raw);
    write('snapshots/' + ns + '/20261017/' + ss + '.json', { schema_version: 1, snapshot_id: ss, tenant, source_url: 'https://example.com/products.json', final_url: 'https://example.com/products.json', http_status:200, source_status: 'success', capability: 'product_catalog', provider: 'shopify_products_json', observed_at: '2026-10-17T00:00:00Z', collector_version: 'synthetic-1', raw_size: Buffer.byteLength(raw), raw_truncated: false, content_hash: 'sha256:' + crypto.createHash('sha256').update(raw).digest('hex'), raw_payload_ref: { path: 'snapshots/' + ns + '/20261017/' + ss + '.raw' } });
    write('evidence/' + ns + '/' + ev + '.json', { schema_version: 1, evidence_id: ev, tenant, evidence_status: 'verified', market: 'US', parser_version: 'synthetic-parser-1', extractor_version: 'synthetic-extractor-1', source_snapshot_ids: [ss] });
    const qualification = { schema_version: 1, tenant_id: tenantId, qualification_result_id: qualificationResultId, workspace_id: workspace.workspace_id, brand_id: brandId, category_scope: 'shoes', market: 'US', qualification_status: 'qualified', relationship_type: 'direct', category_fit: true, core_product_price_fit: true, audience_fit: true, market_fit: true, channel_relation: 'direct', reason_codes: ['synthetic_fixture'], evidence_ids: [ev], source_snapshot_ids: [ss], algorithm_version: 'synthetic-1', config_version: 'synthetic-1', computed_at: '2026-10-17T00:00:00Z' };
    const qualPath = 'qualification-results/' + crypto.createHash('sha256').update(tenantId).digest('hex') + '/' + qualificationResultId + '.json';
    const project = { tenantId, projectId, competitors: [{ id: competitorId, url: 'https://example.com', brand_id: brandId, current_qualification_result_id: qualificationResultId }] };
    write('brands/' + brandId + '.json', { schema_version: 1, brand_id: brandId, identity_status: 'resolved', official_domains: ['example.com'], identity_version: 'synthetic-1' });
    write(qualPath, qualification); write('research/' + ns + '/' + projectId + '.json', project);
    return { input, qualification, qualPath, project, ss, ev };
  }
  const workspace = (key = 'one') => store.createWorkspace({ tenantId, name: key, market: 'US', timeZone: 'America/New_York', idempotencyKey: key, now: 0 });
  return { dir, store, tenantId, ns, write, seed, workspace, cleanup() { this.store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
module.exports = { fixture };
if (require.main === module) {
  const test = require('node:test');
  test('A-R1 requires actual known catalog capability proof while allowing auxiliary cart evidence',()=>{
    const f=fixture();try {
      const s=f.seed(f.workspace()),metaPath='snapshots/'+f.ns+'/20261017/'+s.ss+'.json';
      const snapshot=JSON.parse(fs.readFileSync(path.join(f.dir,metaPath),'utf8'));
      assert.equal(f.store.resolveAdmission(s.input).ok,true);
      for(const patch of [{provider:'unrelated_source',capability:'reviews',source_url:'https://example.com/reviews',final_url:'https://example.com/reviews'},{provider:null},{capability:null},{provider:'generic_web_fetch'},{capability:'reviews'},{source_url:'https://example.com/reviews'},{final_url:'https://example.com/reviews'},{http_status:403}]) {
        f.write(metaPath,{...snapshot,...patch});assert.equal(f.store.resolveAdmission(s.input).ok,false,JSON.stringify(patch));
        assert.throws(()=>f.store.createWatchTarget(s.input),{status:409});
      }
      for(const raw of ['{"reviews":[]}','not-json']) {
        f.write(snapshot.raw_payload_ref.path,raw);f.write(metaPath,{...snapshot,raw_size:Buffer.byteLength(raw),content_hash:'sha256:'+crypto.createHash('sha256').update(raw).digest('hex')});
        assert.equal(f.store.resolveAdmission(s.input).ok,false);
      }
      f.seed(f.store.getWorkspace(f.tenantId,s.input.workspaceId));
      const cartRaw='{"currency":"USD"}',cartPath='snapshots/'+f.ns+'/20261017/cart.raw';
      f.write(cartPath,cartRaw);f.write('snapshots/'+f.ns+'/20261017/cart.json',{...snapshot,snapshot_id:'cart',provider:'shopify_cart_js_json',capability:'storefront_currency',source_url:'https://example.com/cart.js',final_url:'https://example.com/cart.js',raw_payload_ref:{path:cartPath},raw_size:Buffer.byteLength(cartRaw),content_hash:'sha256:'+crypto.createHash('sha256').update(cartRaw).digest('hex')});
      const evPath='evidence/'+f.ns+'/'+s.ev+'.json',ev=JSON.parse(fs.readFileSync(path.join(f.dir,evPath),'utf8'));
      f.write(evPath,{...ev,source_snapshot_ids:[s.ss,'cart']});f.write(s.qualPath,{...s.qualification,source_snapshot_ids:[s.ss,'cart']});
      assert.equal(f.store.resolveAdmission(s.input).ok,true);
      f.write(evPath,{...ev,source_snapshot_ids:['cart']});f.write(s.qualPath,{...s.qualification,source_snapshot_ids:['cart']});
      assert.equal(f.store.resolveAdmission(s.input).ok,false);
    }finally{f.cleanup();}
  });
  test('A-R2 native async transaction callbacks never start or escape the rollback',async()=>{
    const f=fixture();try {
      for(const bind of [false,true]) {
        let started=false;
        const callback=async()=>{started=true;await Promise.resolve();f.store.setSchedulerState({scope:'system',key:'escaped',value:true});};
        assert.throws(()=>f.store.transaction(bind?callback.bind(null):callback),{code:'ASYNC_TRANSACTION_FORBIDDEN'});
        await Promise.resolve();assert.equal(started,false);assert.equal(f.store.getSchedulerState({scope:'system',key:'escaped'}),null);
      }
      assert.throws(()=>f.store.transaction(()=>Promise.resolve()),{code:'ASYNC_TRANSACTION_FORBIDDEN'});
    }finally{f.cleanup();}
  });
  test('A-R3 damaged competitor array items return a classified admission issue',()=>{
    const f=fixture();try {
      const s=f.seed(f.workspace());
      for(const damaged of [null,7,'bad',[],{}]) {
        f.write('research/'+f.ns+'/'+s.input.projectId+'.json',{...s.project,competitors:[damaged,...s.project.competitors]});
        const result=f.store.resolveAdmission(s.input);assert.equal(result.ok,false);assert.ok(result.issues.includes('project_competitors_invalid'));
        assert.throws(()=>f.store.createWatchTarget(s.input),{status:409});
      }
    }finally{f.cleanup();}
  });
  test('Workspace requires explicit market/timezone and stable idempotent payload', () => {
    const f = fixture(); try {
      assert.throws(() => f.store.createWorkspace({ tenantId: f.tenantId, name: 'x', market: 'US', idempotencyKey: 'x' }), { status: 400 });
      assert.throws(() => f.store.createWorkspace({ tenantId: f.tenantId, name: 'x', market: 'US', timeZone:'+08:00', idempotencyKey:'offset' }), { status:400 });
      const w = f.workspace(); assert.equal(f.workspace().workspace_id, w.workspace_id);
      assert.throws(() => f.store.createWorkspace({ tenantId: f.tenantId, name: 'changed', market: 'US', timeZone: 'UTC', idempotencyKey: 'one' }), { status: 409 });
      assert.equal(f.store.getWorkspace('other', w.workspace_id), null);
    } finally { f.cleanup(); }
  });
  test('No upstream or forged client status cannot activate; synthetic complete chain can', () => {
    const f = fixture(); try {
      const w = f.workspace(); const input = { tenantId: f.tenantId, workspaceId: w.workspace_id, projectId: 'missing', competitorId: 'c', brandId: 'b', qualificationResultId: 'q', categoryScope: 'shoes', idempotencyKey: 'x', qualification_status: 'qualified' };
      assert.throws(() => f.store.createWatchTarget(input), { status: 409 });
      const s = f.seed(w); const target = f.store.createWatchTarget(s.input);
      assert.equal(target.monitoring_status, 'active'); assert.equal(target.user_priority, null);
      assert.equal(f.store.createWatchTarget({ ...s.input, idempotencyKey: 'other' }).watch_target_id, target.watch_target_id);
      assert.throws(() => f.store.createWatchTarget({ ...s.input, categoryScope: 'bags' }), { status: 409 });
      f.store.pauseWatchTarget(f.tenantId, target.watch_target_id, 1);
      assert.throws(() => f.store.assertExecutable(f.tenantId, target.watch_target_id, target.revision), { status: 409 });
      assert.equal(f.store.resumeWatchTarget(f.tenantId, target.watch_target_id, 2).monitoring_status, 'active');
      f.write(s.qualPath, { ...s.qualification, qualification_status: 'unresolved' });
      assert.throws(() => f.store.assertExecutable(f.tenantId, target.watch_target_id, 3), { status: 409 });
    } finally { f.cleanup(); }
  });
  test('Admission rejects namespace aliases, project references, broken raw chain and hostile paths', () => {
    const f = fixture(); try {
      const w = f.workspace(), s = f.seed(w);
      f.write('research/' + f.ns + '/' + s.input.projectId + '.json', { ...s.project, tenantId: 'tenant?a' });
      assert.equal(f.store.resolveAdmission(s.input).ok, false);
      f.write('research/' + f.ns + '/' + s.input.projectId + '.json', s.project);
      f.write('snapshots/' + f.ns + '/20261017/' + s.ss + '.raw', 'tampered');
      assert.equal(f.store.resolveAdmission(s.input).ok, false);
      assert.equal(f.store.resolveAdmission({ ...s.input, brandId: '../config' }).ok, false);
    } finally { f.cleanup(); }
  });
  test('Workspace scope change invalidates old jobs without rewriting historical target market', () => {
    const f = fixture(); try {
      const w = f.workspace(), s = f.seed(w), t = f.store.createWatchTarget(s.input);
      f.store.updateWorkspace({ tenantId: f.tenantId, workspaceId: w.workspace_id, market: 'CA', timeZone: 'America/Toronto', now: 3 });
      assert.equal(f.store.getWatchTarget(f.tenantId, t.watch_target_id).market, 'US');
      assert.throws(() => f.store.resumeWatchTarget(f.tenantId, t.watch_target_id), { status: 409 });
    } finally { f.cleanup(); }
  });
  test('Malformed input closes safely and immutable qualification cannot be silently overwritten', () => {
    const f=fixture();try {
      assert.equal(f.store.resolveAdmission({}).ok,false);
      const w=f.workspace(),s=f.seed(w),t=f.store.createWatchTarget(s.input);
      f.write(s.qualPath,{...s.qualification,reason_codes:['silent_change']});
      assert.throws(()=>f.store.assertExecutable(f.tenantId,t.watch_target_id,t.revision),{status:409});
      f.store.pauseWatchTarget(f.tenantId,t.watch_target_id);
      assert.throws(()=>f.store.resumeWatchTarget(f.tenantId,t.watch_target_id),{status:409});
    }finally{f.cleanup();}
  });
  test('Qualification scope, required versions, project anchor and source domain cannot be substituted',()=>{
    const f=fixture();try {
      const w=f.workspace(),s=f.seed(w);
      for(const patch of [{tenant_id:'tenant?a'},{workspace_id:'other'},{brand_id:'other'},{category_scope:'bags'},{market:'CA'},{algorithm_version:''},{config_version:null},{source_snapshot_ids:['absent']}]) {
        f.write(s.qualPath,{...s.qualification,...patch});assert.equal(f.store.resolveAdmission(s.input).ok,false,JSON.stringify(patch));
      }
      f.write(s.qualPath,s.qualification);
      for(const patch of [{url:'https://impostor.example'},{url:'https://example.com@impostor.example'},{brand_id:null},{current_qualification_result_id:'other'}]) {
        f.write('research/'+f.ns+'/'+s.input.projectId+'.json',{...s.project,competitors:[{...s.project.competitors[0],...patch}]});assert.equal(f.store.resolveAdmission(s.input).ok,false);
      }
      f.write('research/'+f.ns+'/'+s.input.projectId+'.json',s.project);
      const evPath='evidence/'+f.ns+'/'+s.ev+'.json',ev=JSON.parse(fs.readFileSync(path.join(f.dir,evPath),'utf8'));
      f.write(evPath,{...ev,entity_ref:{domain:'impostor.example'}});assert.equal(f.store.resolveAdmission(s.input).ok,false);
      f.write(evPath,{...ev,category_scope:'bags'});assert.equal(f.store.resolveAdmission(s.input).ok,false);
      f.write(evPath,{...ev,tenant:{tenant_id:'tenant?a',project_ref:s.input.projectId}});assert.equal(f.store.resolveAdmission(s.input).ok,false);
      f.write(evPath,ev);assert.equal(f.store.resolveAdmission(s.input).ok,true);
      f.write(s.qualPath,'{broken');assert.equal(f.store.resolveAdmission(s.input).ok,false);
    }finally{f.cleanup();}
  });
}
