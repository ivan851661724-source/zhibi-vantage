// Regression: persisted legacy priceBand.range can be an object or array.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = fs.readFileSync(require('node:path').join(__dirname, '../src/lib/labels.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const sandbox = { exports: {} };
vm.runInNewContext(compiled, sandbox);
const { fmtPrice } = sandbox.exports;
const cases = [
  [{ heroProduct: { corePriceBand: { min: null, max: null } }, priceBand: { range: { min: 155, max: 350 } }, priceField: { display: '$80-$400（推断·未实抓）' } }, '$80-$400（推断·未实抓）'],
  [{ priceBand: { range: [74.95, 649.95] }, priceField: { display: '$10-$800' } }, '$10-$800'],
  [{ priceBand: { range: { min: 155, max: 350 } } }, '价位未明'],
  [{ priceBand: { range: {} }, priceField: { display: {} } }, '价位未明'],
  [{ priceBand: { range: '$20–$30' } }, '$20–$30'],
  [{ heroProduct: { corePriceBand: { min: 39, max: 39, currency: 'USD' } }, priceBand: { range: {} } }, 'USD39–39'],
];
for (const [input, expected] of cases) {
  const result = fmtPrice(input);
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement('span', null, result)), 'price must remain renderable in radar card');
  assert.equal(result, expected);
}
console.log('PASS: legacy object/array ranges, missing price, inference labels, normal ranges and hero price render safely');
