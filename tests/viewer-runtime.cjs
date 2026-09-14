'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8');
function standalone(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Missing production function: ' + name);
  return html.slice(start, html.indexOf('\n}', start) + 2);
}
function runtime(globals = {}, functions = []) {
  const start = html.indexOf('class SectionPanel {');
  const helpers = html.slice(html.indexOf('function displayAffineMultiply('), html.indexOf('// ---- HE↔MSI registration math'));
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...globals });
  vm.runInContext(helpers + '\n' + functions.map(standalone).join('\n') + '\n' +
    html.slice(start, html.indexOf('\n}\n', start) + 2) + '\nglobalThis.Panel = SectionPanel;', context);
  return context;
}
function previewMethod(name, globals = {}) {
  const start = html.indexOf('    ' + name + '(', html.indexOf('const SharePreview ='));
  if (start < 0) throw new Error('Missing Preview method: ' + name);
  return vm.runInNewContext('({' + html.slice(start, html.indexOf('\n    },', start) + 6) + '})', globals)[name];
}
module.exports = { html, runtime, standalone, previewMethod };
