'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..'), source = fs.readFileSync(path.join(root, 'mrm.html'), 'utf8');
function extractFunction(name) {
  const match = new RegExp('(?:async )?function ' + name + '\\(').exec(source);
  assert.ok(match, 'Missing function ' + name);
  const start = match.index, open = source.indexOf('{', start);
  let depth = 0, quote = null, escaped = false, line = false, block = false;
  for (let i = open; i < source.length; i++) {
    const c = source[i], next = source[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '*' && next === '/') { block = false; i++; } continue; }
    if (quote) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === quote) quote = null; continue; }
    if (c === '/' && next === '/') { line = true; i++; continue; }
    if (c === '/' && next === '*') { block = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('Unclosed function ' + name);
}
async function verify(name, locale) {
  const rows = Array.from({length:12}, (_, i) => ({name:'User ' + i, precursor:100 + i, product:50, ce:11, cv:20, shelf:'main'}));
  const before = JSON.stringify(rows), progress = [], calls = [];
  let text = '';
  const label = {get textContent() { return text; }, set textContent(value) { text = value; progress.push(value); }};
  const card = {querySelector:selector => selector === '[data-prog]' ? label : null, _close() {}};
  const openModal = () => {}; openModal._card = card;
  const context = vm.createContext({openModal, console:{warn() {}}, alert() {},
    _readCachedMasterPw:() => 'fixture-only', loadLibrary:async() => {}, reload:async() => {},
    selectedRows:() => rows, body:() => ({querySelector:() => null}), parseTags:() => [], num:Number,
    SHELVES:{main:{label:'Main'}, archive:{label:'Archive'}},
    SupabaseClient:{registerMeasuredCompound:async(_pw, row) => { calls.push(row); if (calls.length === 5) throw new Error('fixture failure'); }}});
  vm.runInContext(fs.readFileSync(path.join(root, 'app-i18n.js'), 'utf8'), context);
  for (const helper of ['uiT', 'uiMsg', 'uiBind', name]) vm.runInContext(extractFunction(helper), context);
  context.AppI18n.setLocale(locale, {persist:false});
  await context[name](rows);
  assert.deepEqual(progress, ['1 / 12','2 / 12','3 / 12','4 / 12','5 / 12','6 / 12','7 / 12','8 / 12','9 / 12','10 / 12','11 / 12','12 / 12'], name + ' must display completed counts as numbers in ' + locale);
  assert.equal(calls.length, 12, 'A failed row does not stop progress');
  assert.equal(JSON.stringify(rows), before, 'Progress formatting cannot change input rows');
}
(async() => {
  for (const locale of ['ja', 'en']) for (const name of ['runPasteImport', 'doRegister']) await verify(name, locale);
  console.log('MRM numeric progress regression: PASS (bulk import and measured registration, both languages)');
})().catch(error => { console.error(error); process.exitCode = 1; });
