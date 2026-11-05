'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8');
const ratioModelSource=fs.readFileSync(path.join(__dirname,'../viewer/msi-ratio-model.js'),'utf8');
function standalone(name) {
  const start = html.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Missing production function: ' + name);
  return html.slice(start, html.indexOf('\n}', start) + 2);
}
function installDisplayHelpers(context) {
  // Execute the production model and display-layer adapters in the same realm
  // as the extracted viewer code. This is not a measured-layer-only stub.
  if(!context.window)context.window=context;
  vm.runInContext(ratioModelSource+'\n'+['isRatioDisplayKey','displayMsiEntry','displayMsiKeys'].map(standalone).join('\n'),context);
  return context;
}
function displayContext(globals = {}) { return installDisplayHelpers(vm.createContext(globals)); }
function runtime(globals = {}, functions = []) {
  const start = html.indexOf('class SectionPanel {');
  const helpers = html.slice(html.indexOf('function displayAffineMultiply('), html.indexOf('// ---- HE↔MSI registration math'));
  const context = displayContext({ console, setTimeout, clearTimeout, ...globals });
  vm.runInContext(helpers + '\n' + functions.map(standalone).join('\n') + '\n' +
    html.slice(start, html.indexOf('\n}\n', start) + 2) + '\nglobalThis.Panel = SectionPanel;', context);
  return context;
}
function previewMethod(name, globals = {}) {
  const start = html.indexOf('    ' + name + '(', html.indexOf('const SharePreview ='));
  if (start < 0) throw new Error('Missing Preview method: ' + name);
  return vm.runInContext('({' + html.slice(start, html.indexOf('\n    },', start) + 6) + '})', displayContext(globals))[name];
}
module.exports = { html, runtime, standalone, previewMethod,installDisplayHelpers,displayContext };
