'use strict';
// CLI：播种确定性 Demo 场景（39→29 走真实事实链）。
// 用法：node app/scripts/demo-scenario.js [--tenant <tenantId>]
//   tenant 缺省取 ZB_DEMO_TENANT 环境变量。产物标记 Demo / Sample Data。
const Fixture = require('../research/demo-fixture.js');

const args = process.argv.slice(2);
let tenant = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--tenant') tenant = args[i + 1] || null;
}
if (!tenant) tenant = process.env.ZB_DEMO_TENANT || null;
if (!tenant) {
  console.error('缺少租户：请用 --tenant <tenantId> 或环境变量 ZB_DEMO_TENANT 指定。');
  process.exit(2);
}
const r = Fixture.seedDemoScenario({ tenantId: tenant });
console.log(JSON.stringify(r, null, 2));
if (r.recorded === false) process.exit(1);
