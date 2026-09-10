'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Selection = require('../viewer/section-visibility.js');

const sections = [
  { id: 'a', displayName: 'Brain WT 1', organ: 'Brain' },
  { id: 'b', displayName: 'Brain WT 1', organ: 'Brain' },
  { id: 'c', displayName: 'Liver WT 1', organ: 'Liver' },
  { id: 'd', displayName: '', organ: '' },
];

function testSelectionContract() {
  let state = Selection.reconcileSelection(null, sections);
  assert.deepEqual([...state.selected], ['a', 'b', 'c', 'd']);
  state.selected = Selection.changeSelection(state, ['a', 'c'], false).selected;
  assert.deepEqual([...state.selected], ['b', 'd']);
  // Rename / reorder cannot transfer visibility to a same-named section.
  state = Selection.reconcileSelection(state, [sections[3], { ...sections[1], displayName: 'renamed' }, sections[0], sections[2]]);
  assert.deepEqual([...state.selected], ['d', 'b']);
  state = Selection.reconcileSelection(state, [sections[0], sections[1], { id: 'new' }]);
  assert.deepEqual([...state.selected], ['b', 'new']);
  assert.equal(state.known.has('d'), false);
  const rejected = Selection.changeSelection(state, ['b', 'new'], false);
  assert.equal(rejected.rejected, true);
  assert.deepEqual([...rejected.selected], ['b', 'new']);
  const pending = Selection.changeSelection(state, ['b'], false, 'b');
  assert.deepEqual([...pending.selected], ['b', 'new']);
  assert.deepEqual([...pending.deferred], ['b']);
  // Deleted IDs never reappear, and a one-organ/one-section project remains usable.
  assert.deepEqual([...Selection.reconcileSelection(state, [{ id: 'only' }]).selected], ['only']);
}

function testImageCentredViewport() {
  const before = { tx: -70, ty: 15, scale: 2.5 };
  const view = Selection.captureViewport(before, 400, 200, 0.5);
  const after = Selection.restoreViewport(view, 400, 200, 0.25);
  assert.equal(after.scale, 5);
  assert.ok(Math.abs(after.tx + 70) < 1e-12);
  assert.ok(Math.abs(after.ty - 15) < 1e-12);
  const roundTrip = Selection.captureViewport(after, 400, 200, 0.25);
  assert.deepEqual(roundTrip, view);
  // CSS translation alone would halve the physical image magnification here.
  assert.equal(before.scale * 0.5, after.scale * 0.25);
  assert.equal(Selection.captureViewport(before, 0, 200, 0), null);
}

// Small DOM test double. It implements DOM tree/focus/event operations used by
// this UI; browser layout and native checkbox key activation remain browser QA.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.children = [];
    this.dataset = {}; this.attributes = {}; this.listeners = new Map(); this.style = {};
    this.value = ''; this.offsetWidth = 340; this.offsetHeight = 400; this.isConnected = true;
  }
  append(...items) { for (const item of items) { item.parentNode = this; this.children.push(item); } }
  appendChild(item) { this.append(item); return item; }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key]; }
  addEventListener(key, listener) { if (!this.listeners.has(key)) this.listeners.set(key, []); this.listeners.get(key).push(listener); }
  removeEventListener(key, listener) { this.listeners.set(key, (this.listeners.get(key) || []).filter(v => v !== listener)); }
  dispatch(key, event = {}) { event.target ||= this; for (const listener of this.listeners.get(key) || []) listener(event); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(target) { return this === target || this.children.some(child => child.contains(target)); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(v => v !== this); this.isConnected = false; }
  getBoundingClientRect() { return { left: 20, bottom: 40 }; }
  querySelectorAll(selector) {
    const key = selector.startsWith('[') ? selector.slice(1, -1) : null;
    const matches = el => key ? Object.hasOwn(el.attributes, key) : el.tagName === selector.toUpperCase();
    return this.children.flatMap(child => [...(matches(child) ? [child] : []), ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  set innerHTML(html) {
    this.children = [];
    // Parse the static panel template's controls. Dynamic labels are built by
    // the real implementation with createElement/append and need no parsing.
    for (const match of html.matchAll(/<(input|button|div|span)\b[^>]*\b(data-[\w-]+)(?:\s|>)[^>]*>/g)) {
      const child = new Element(match[1], this.ownerDocument); child.setAttribute(match[2], ''); this.append(child);
    }
  }
}
function fakeDocument() {
  const doc = new Element('document', null); doc.ownerDocument = doc;
  doc.body = new Element('body', doc); doc.append(doc.body);
  doc.defaultView = new Element('window', doc); doc.defaultView.innerWidth = 1024; doc.defaultView.innerHeight = 768;
  doc.createElement = tag => new Element(tag, doc);
  return doc;
}
function fixture() {
  const doc = fakeDocument(), store = new Map();
  let project = { id: 'project-1', sections: sections.map(s => ({ ...s })) };
  let share = null, drawingId = null, scope = null, changes = 0;
  const storage = { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value) };
  const hooks = { document: doc, storage, project: () => project, share: () => share,
    organ: section => section.organ, drawingId: () => drawingId,
    scope: value => { scope = value; }, changed: () => { changes++; } };
  const controller = Selection.createController(hooks);
  return { doc, hooks, controller, setProject: value => { project = value; }, setShare: value => { share = value; },
    setDrawing: value => { drawingId = value; }, scope: () => scope, changes: () => changes };
}

function testSessionAndDrawing() {
  const f = fixture(), c = f.controller;
  c.ensure(); c.change(['b', 'c'], false);
  c.previewTransforms.a = { tx: 4, ty: 7, scale: 2 }; c.previewRotations.a = 90; c.save();
  const restored = Selection.createController(f.hooks); restored.ensure();
  assert.deepEqual([...restored.state.selected], ['a', 'd']);
  assert.equal(restored.previewRotations.a, 90); assert.equal(restored.previewTransforms.a.tx, 4);
  f.setShare({ slug: 'recipient-one', role: 'viewer' }); c.ensure();
  assert.equal(c.state.selected.size, 4); assert.equal(c.previewRotations.a, undefined);
  c.change(['c'], false);
  f.setShare({ slug: 'recipient-two', role: 'viewer' }); c.ensure(); assert.equal(c.state.selected.size, 4);
  f.setShare(null); c.ensure(); assert.deepEqual([...c.state.selected], ['a', 'd']);
  f.setDrawing('a'); c.change(['a'], false); assert.equal(c.state.selected.has('a'), true);
  c.flushDeferred(); assert.equal(c.state.selected.has('a'), true);
  f.setDrawing(null); c.flushDeferred(); assert.deepEqual([...c.state.selected], ['d']);
  f.setProject({ id: 'another', sections: [{ id: 'a' }] }); c.ensure();
  assert.deepEqual([...f.scope()], ['a']); assert.equal(c.previewTransforms.a, undefined);
}

function testPanelAndKeyboard() {
  const f = fixture(), c = f.controller;
  const button = f.doc.createElement('button'); button.setAttribute('data-section-visibility', ''); f.doc.body.append(button);
  c.refresh(); assert.equal(button.textContent, '表示切片 4/4');
  let prevented = false;
  button.dispatch('keydown', { key: 'ArrowDown', preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.doc.activeElement, c.search);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  c.change(['a'], false);
  const inputs = () => c.panel.querySelector('[data-list]').querySelectorAll('input');
  const group = () => inputs().find(input => input.dataset.focusKey === 'group:Brain');
  assert.equal(group().indeterminate, true); assert.equal(group().checked, false);
  c.search.value = 'Brain'; c.search.dispatch('input');
  assert.equal(inputs().filter(input => input.dataset.focusKey.startsWith('section:')).length, 2);
  assert.equal(c.state.selected.has('c'), true, 'search cannot change actual selection');
  const selectedBefore = [...c.state.selected];
  // Native checkbox change applies the whole organ, even when a search is active.
  group().checked = false; group().dispatch('change');
  assert.equal(c.state.selected.has('b'), false); assert.equal(c.state.selected.has('c'), true);
  assert.notDeepEqual([...c.state.selected], selectedBefore);
  assert.ok(c.panel, 'selection leaves the float panel open');
  let stopped = false;
  f.doc.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
  assert.equal(stopped, true); assert.equal(c.panel, null); assert.equal(f.doc.activeElement, button);
  button.dispatch('click'); assert.ok(c.panel);
  f.doc.dispatch('pointerdown', { target: f.doc.body }); assert.equal(c.panel, null);
}

function testInlineSyntaxAndVisibilityIntegration() {
  const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8');
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  assert.ok(html.includes('<script src="section-visibility.js"></script>'));
  assert.equal(html.includes('data-cell-select'), false, 'all selection controls belong to the shared float panel');
  assert.equal(html.includes('_hiddenSectionIds'), false, 'no Preview-only visibility state');
  assert.equal(html.includes('delete App.msiUserWindow[App.focusCompoundKey]'), false, 'selection cannot discard manual Range');
}

testSelectionContract();
testImageCentredViewport();
testSessionAndDrawing();
testPanelAndKeyboard();
testInlineSyntaxAndVisibilityIntegration();
console.log('MSI section selection regressions: PASS');
