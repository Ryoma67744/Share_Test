'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
async function main() {
  const store = new Map(), writes = [];
  const context = vm.createContext({DESI_OFFLINE:true, crypto:require('node:crypto').webcrypto,
    localStorage:{getItem:key => store.get(key) || null, setItem:(key,value) => { store.set(key,value); writes.push(key); }}});
  context.window = context;
  const run = file => vm.runInContext(fs.readFileSync(path.join(root,file), 'utf8'), context, {filename:file});
  // Follow the real Viewer catalog dependencies; its local MRM operations must
  // not depend on the separate MRM page being visited first.
  const viewer = fs.readFileSync(path.join(root,'viewer/index.html'), 'utf8');
  const scripts = [...viewer.matchAll(/<script src="\.\.\/(app-i18n(?:-[a-z0-9-]+)?\.js)"><\/script>/g)].map(match => match[1]);
  assert.ok(scripts.includes('app-i18n-storage.js'));
  scripts.forEach(run); run('offline/local-mrm.js');
  context.AppI18n.setLocale('en'); writes.length = 0;
  store.set(context.DesiLocalMrm.storageKey, JSON.stringify({format:'invalid'}));
  await assert.rejects(context.DesiLocalMrm.rpc('list_mrm_library'), /Invalid MRM backup format/);
  store.delete(context.DesiLocalMrm.storageKey);
  await assert.rejects(context.DesiLocalMrm.rpc('register_from_result', {_name:'保存', _precursor:'invalid'}), /Invalid MRM numeric value/);
  assert.deepEqual(writes, [], 'failed validation cannot save or replace the local library');
  const source = fs.readFileSync(path.join(root,'offline/local-mrm.js'), 'utf8');
  const messages = [...new Set([...source.matchAll(/\buiT\(("(?:[^"\\]|\\.)*")/g)].map(match => JSON.parse(match[1])))];
  assert.equal(messages.length, 16);
  for (const message of messages) assert.ok(context.AppI18n.hasTranslation(message), 'Viewer is missing local MRM diagnostic: ' + message);
  assert.deepEqual(Array.from(context.AppI18n.getMissingKeys()), []);
  const before = messages.map(message => context.AppI18n.t(message));
  run('app-i18n-mrm.js');
  assert.deepEqual(messages.map(message => context.AppI18n.t(message)), before, 'shared diagnostics use the same wording on both pages');
  assert.deepEqual(Array.from(context.AppI18n.getConflicts()), []);
  context.AppI18n.setLocale('ja');
  await assert.rejects(context.DesiLocalMrm.rpc('register_from_result', {_name:'保存', _precursor:'invalid'}), /MRM 数値が不正です/);
  console.log('Local MRM shared language regressions: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
