'use strict';
const assert = require('node:assert/strict');
const { materialAction } = require('../routes/handlers/feedback.js');

async function run(body, projectId = 'projectB') {
  const state = { projectId, decisions: { existing: 'keep' } };
  let writes = 0, authReads = 0, status, response;
  const ctx = {
    readBody: async () => body, loadState: () => state,
    saveState: () => { writes++; },
    getAuthPayload: () => { authReads++; return null; },
    sendJSON: (_, code, value) => { status=code; response=value; },
  };
  await materialAction(ctx, {method:'POST'}, {}, new URL('http://local/api/material-action'), '/api/material-action');
  return { state, writes, authReads, status, response };
}
(async () => {
  const stale = await run({id:'m',action:'keep',projectId:'projectA'});
  assert.equal(stale.status,409,'old project action must be rejected');
  assert.equal(stale.response.error,'PROJECT_CHANGED');
  assert.equal(stale.writes,0); assert.equal(stale.authReads,0,'rejected action cannot emit telemetry');
  assert.deepEqual(stale.state.decisions,{existing:'keep'});
  const matched=await run({id:'m',action:'',projectId:'projectB'});
  assert.equal(matched.status,200); assert.equal(matched.response.projectId,'projectB'); assert.equal(matched.writes,1);
  const legacy=await run({id:'existing',action:''});
  assert.equal(legacy.status,200,'old clients without projectId retain behavior'); assert.deepEqual(legacy.state.decisions,{});
  const invalid=await run({id:'m',action:'keep',projectId:{}});
  assert.equal(invalid.status,400); assert.equal(invalid.writes,0);
  console.log('PASS: material action project precondition, no rejected writes/telemetry, response echo and legacy compatibility');
})().catch(error=>{console.error(error);process.exitCode=1;});
