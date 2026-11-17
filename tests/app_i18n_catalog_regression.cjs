'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(root).filter(file => /^app-i18n-.+\.js$/.test(file));
const registrations = [];
const catalogContext = vm.createContext({ AppI18n: { register(namespace, entries, options) {
  registrations.push({ namespace, entries, options });
} } });
for (const file of files) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), catalogContext, { filename: file });
const placeholders = text => Array.from(text.matchAll(/\{([\w.-]+)\}/g), match => match[1]).sort();
for (const { namespace, entries } of registrations) {
  for (const [source, translated] of Object.entries(entries)) {
    assert.equal(typeof translated, 'string', namespace + ': ' + source);
    assert.ok(translated.trim(), namespace + ': empty translation for ' + source);
    assert.deepEqual(placeholders(translated), placeholders(source), namespace + ': preserve all data parameters in ' + source);
  }
}
// Each page has a different catalog set. Loading those exact scripts must not
// make an English label depend on page order or overwrite a scoped role label.
for (const page of ['index.html', 'mrm.html', 'viewer/index.html', 'help.html']) {
  const context = vm.createContext({});
  const html = fs.readFileSync(path.join(root, page), 'utf8');
  const scripts = Array.from(html.matchAll(/<script\b[^>]*\bsrc=["']([^"']*app-i18n[^"']*)["'][^>]*>/g), match => match[1]);
  assert.ok(scripts.length, page + ': language scripts are present');
  for (const src of scripts) {
    const file = path.resolve(path.dirname(path.join(root, page)), src.split('?')[0]);
    vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  }
  assert.equal(context.AppI18n.getConflicts().length, 0, page + ': conflicting translations');
  context.AppI18n.setLocale('en');
  assert.equal(context.AppI18n.t('保存'), 'Save', page);
  assert.equal(context.AppI18n.t('確認'), 'Confirm', page);
  assert.equal(context.AppI18n.t('確認', null, 'mrm-role'), 'Qualifier', page);
}
console.log('Application translation catalogs: PASS (parameters, page load order and scoped roles)');
