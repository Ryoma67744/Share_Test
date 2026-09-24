'use strict';

// Production viewer plus an event-capable DOM model: tests focus, keyboard
// bubbling, adapter routing, and deferred I/O. This is not a browser layout test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {dom} = require('./fixed-colors-runtime.cjs');
const source = fs.readFileSync(path.join(__dirname, '../viewer/roi-media-viewer.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 6; ++i) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };

function environment(overrides = {}) {
  const env = dom(), frames = [], draws = [], calls = [], disposals = [];
  const originalCreate = env.document.createElement;
  env.document.createTextNode = value => { const node = env.element('span'); node.textContent = String(value); return node; };
  env.document.createElement = tag => {
    const node = originalCreate(tag);
    node.clientWidth = 400; node.clientHeight = 300; node.ownerDocument = env.document;
    if (tag === 'canvas') node.getContext = () => ({
      setTransform() {}, clearRect() {}, drawImage(image) { draws.push(image.marker); },
      beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, strokeText() {}, fillText() {}
    });
    return node;
  };
  const context = vm.createContext({...env.window, console, confirm: () => true});
  env.document.defaultView = context;
  context.RoiMediaMsi = {createViewport(host) {
    const canvas = env.document.createElement('canvas'); host.appendChild(canvas);
    return {canvas, setFrame(frame) { frames.push(frame && frame.marker); return frame && {ok: true}; },
      setMode(mode) { calls.push(['mode', mode]); }, setMargin(margin) { calls.push(['margin', margin]); },
      setOutline(value) { calls.push(['outline', value]); }, zoomBy(value) { calls.push(['zoom', value]); },
      panBy(x, y) { calls.push(['pan', x, y]); }, fit() { calls.push(['fit']); }, resize() {}, destroy() { canvas.remove(); }};
  }};
  vm.runInContext(source, context);
  const project = {id: 'project'}, roi = {id: 'roi4', name: 'toxo4_cyst'};
  const items = {S4: [{id: 'photo1', title: '40× HE', filename: 'he.png', kind: 'HE', isPrimary: true, revision: 1}], S1: [{id: 'photo2', title: 'IF', filename: 'if.png', kind: 'IF', revision: 1}]};
  let selectedPhoto = null;
  const adapter = {
    sections: () => [{id: 'S4', name: 'toxo4'}, {id: 'S1', name: 'toxo1'}],
    list: (_project, _roi, section) => items[section] || [], editable: () => true,
    selectPhoto: (_project, _roi, section, item) => { selectedPhoto = item; calls.push(['selectPhoto', section, item && item.id]); },
    compounds: (_project, _roi, section) => { calls.push(['compounds', section, selectedPhoto && selectedPhoto.id]); return [{key: 'PC', label: 'PC(30:0)'}]; },
    preferredCompound: () => 'PC',
    loadPhoto: async item => ({image: {width: 800, height: 600, marker: item.id}, dispose: () => disposals.push(item.id)}),
    loadThumbnail: async item => ({image: {width: 100, height: 80, marker: 'thumb:' + item.id}, dispose: () => disposals.push('thumb:' + item.id)}),
    loadMsi: async (_project, _roi, section, key) => { calls.push(['loadMsi', section, key]); return {canvas: {}, marker: section + ':' + key, status: 'PC(30:0) · 0–200 · Viridis'}; },
    add: async (_project, _roi, section, files) => { const item = {id: 'new', title: files[0].name, filename: files[0].name}; items[section].push(item); calls.push(['add', section]); return [item]; },
    update: async (_project, _roi, section, item, patch) => { Object.assign(item, patch); calls.push(['update', section, item.id]); return item; },
    replace: async (_project, _roi, section, item, file) => { item.filename = file.name; return item; },
    remove: async (_project, _roi, section, item) => { items[section] = items[section].filter(row => row.id !== item.id); return item; },
    makePrimary: async (_project, _roi, section, item) => { items[section].forEach(row => { row.isPrimary = row.id === item.id; }); return item; },
    ...overrides
  };
  const anchor = env.element('button'); env.document.body.appendChild(anchor); anchor.focus();
  return {...env, context, api: context.RoiMediaViewer, project, roi, adapter, items, frames, draws, calls, disposals, anchor,
    find: selector => env.document.querySelector(selector),
    buttons: label => env.document.querySelectorAll('button').find(node => node.textContent === label)};
}

async function main() {
  {
    const e = environment(); e.api.open({project: e.project, roi: e.roi, adapter: e.adapter}); await flush();
    assert.equal(e.api.hasUnsavedChanges(), false, 'opening a saved photo is clean');
    assert.equal(e.find('[aria-label="対象切片"]').value, 'S4', 'ROI section wins over the unrelated main-view selection');
    assert(e.calls.some(call => call[0] === 'loadMsi' && call[1] === 'S4'));
    assert.deepEqual(e.calls.find(call => call[0] === 'compounds').slice(1), ['S4', 'photo1'], 'MSI eligibility uses selected-photo source before image decoding');
    assert.equal(e.find('.roi-media-msi-notice').textContent, 'PC(30:0) · 0–200 · Viridis');
    assert.equal(e.find('.roi-media-window').getAttribute('aria-modal'), 'false');
    let mainKeys = 0; e.document.addEventListener('keydown', () => { mainKeys++; });
    const title = e.document.querySelectorAll('input').find(node => node.name === 'title');
    e.dispatch(title, 'keydown', {key: 'Enter'}); assert.equal(mainKeys, 0, 'Enter cannot finalize the main ROI');
    e.find('.roi-media-msi').querySelectorAll('button').find(node => node.textContent === '全体').click(); assert(e.calls.some(call => call[0] === 'mode' && call[1] === 'whole'));
    const msiCanvas = e.find('.roi-media-msi-viewport').children.find(node => node.tagName === 'CANVAS');
    e.dispatch(msiCanvas, 'keydown', {key: 'ArrowLeft'}); assert(e.calls.some(call => call[0] === 'pan' && call[1] === 30)); assert.equal(mainKeys, 0);
    title.value = 'new title'; e.dispatch(title, 'input');
    assert.equal(e.api.hasUnsavedChanges(), true, 'metadata edits participate in the unload guard');
    e.context.confirm = () => false; assert.equal(e.api.requestClose(), false); assert.equal(e.api.isOpen(), true, 'dirty form cannot be silently discarded');
    const section = e.find('[aria-label="対象切片"]'); section.value = 'S1'; e.dispatch(section, 'change'); await flush(); assert.equal(section.value, 'S4');
    e.dispatch(e.find('.roi-media-form'), 'submit'); await flush(); assert.equal(e.items.S4[0].title, 'new title');
    assert.equal(e.api.hasUnsavedChanges(), false, 'successful save clears metadata dirtiness');
    section.value = 'S1'; e.dispatch(section, 'change'); await flush(); assert(e.calls.some(call => call[0] === 'loadMsi' && call[1] === 'S1'));
    const addInput = e.document.querySelectorAll('input').find(node => node.type === 'file' && node.multiple);
    addInput.files = [{name: 'later.png'}]; e.dispatch(addInput, 'change'); await flush();
    assert(e.calls.some(call => call[0] === 'add' && call[1] === 'S1')); assert.equal(e.items.S1.length, 2);
    e.dispatch(e.find('.roi-media-window'), 'keydown', {key: 'Escape'}); assert.equal(e.api.isOpen(), false); assert.equal(mainKeys, 0); assert.equal(e.document.activeElement, e.anchor);
    assert.equal(e.api.hasUnsavedChanges(), false, 'closed window has no unsaved form');
    e.dispatch(e.anchor, 'keydown', {key: 'ArrowDown'}); assert.equal(mainKeys, 1, 'main keys work after floating window closes');
  }
  {
    const e = environment({preferredCompound: () => 'unavailable'}); e.api.open({project: e.project, roi: e.roi, adapter: e.adapter}); await flush();
    assert.equal(e.find('[aria-label="MSIの化合物"]').value, ''); assert(!e.calls.some(call => call[0] === 'loadMsi'), 'no silent replacement with another compound'); e.api.close();
  }
  {
    const photo = deferred(), msi = deferred(); let photoDisposed = false, msiDisposed = false;
    const e = environment({loadPhoto: () => photo.promise, loadMsi: () => msi.promise});
    e.api.open({project: e.project, roi: e.roi, adapter: e.adapter}); await flush(); e.api.close();
    photo.resolve({image: {width: 40, height: 40, marker: 'late-photo'}, dispose() { photoDisposed = true; }});
    msi.resolve({canvas: {}, marker: 'late-msi', dispose() { msiDisposed = true; }}); await flush();
    assert(!e.draws.includes('late-photo')); assert(!e.frames.includes('late-msi')); assert(photoDisposed && msiDisposed, 'late results release their image resources');
  }
  {
    const old = deferred(); const e = environment({loadPhoto: item => item.id === 'photo1' ? old.promise : Promise.resolve({image: {width: 80, height: 80, marker: item.id}})});
    e.api.open({project: e.project, roi: e.roi, adapter: e.adapter}); await flush();
    const section = e.find('[aria-label="対象切片"]'); section.value = 'S1'; e.dispatch(section, 'change'); await flush();
    old.resolve({image: {width: 80, height: 80, marker: 'wrong-section'}}); await flush();
    assert(!e.draws.includes('wrong-section')); assert(e.draws.includes('photo2')); e.api.close();
  }
  {
    const preferred = deferred(), nextList = deferred();
    const e = environment({
      list: (_project, _roi, section) => section === 'S4' ? [{id: 'photo1', filename: 'he.png'}] : nextList.promise,
      compounds: (_project, _roi, section) => [{key: section === 'S4' ? 'OLD' : 'NEW'}],
      preferredCompound: (_project, _roi, section) => section === 'S4' ? preferred.promise : 'NEW'
    });
    e.api.open({project: e.project, roi: e.roi, adapter: e.adapter}); await flush();
    const section = e.find('[aria-label="対象切片"]'); section.value = 'S1'; e.dispatch(section, 'change'); await flush();
    preferred.resolve('OLD'); await flush();
    const selector = e.find('[aria-label="MSIの化合物"]');
    assert(!selector.children.some(node => node.value === 'OLD'), 'late preferred compound cannot restore old-section options while the new photo list is pending');
    assert(!e.calls.some(call => call[0] === 'loadMsi'));
    nextList.resolve([{id: 'photo2', filename: 'if.png'}]); await flush();
    assert(e.calls.some(call => call[0] === 'loadMsi' && call[1] === 'S1' && call[2] === 'NEW')); e.api.close();
  }
  {
    const e = environment({replace: async () => { throw new Error('保存失敗'); }}); e.api.open({project: e.project, roi: e.roi, adapter: e.adapter}); await flush();
    const input = e.document.querySelectorAll('input').find(node => node.type === 'file' && !node.multiple);
    input.files = [{name: 'new.png'}]; e.dispatch(input, 'change'); await flush();
    assert.equal(e.items.S4[0].filename, 'he.png'); assert.equal(e.find('.roi-media-status').textContent, '保存失敗');
    assert(e.draws.includes('photo1')); e.api.close();
  }
  {
    const e = environment({editable: () => false}); e.api.open({project: e.project, roi: e.roi, adapter: e.adapter}); await flush();
    assert(e.buttons('＋ 画像を新規登録').disabled); assert(e.buttons('画像を差し替え').disabled); assert(e.buttons('写真を削除').disabled); e.api.close();
    assert.equal(e.api.photoScaleBar(2, null, 400), null, '40× alone never creates a scale');
    const bar = e.api.photoScaleBar(2, {x: 0.5, y: 0.5}, 400); assert.equal(bar.pixels, 80); assert.equal(bar.label, '20 µm');
    assert.throws(() => e.api.metadataPatch({umX: '0.5', umY: ''}), /両方/);
    const patch = e.api.metadataPatch({title: ' HE ', kind: 'HE', umX: '.5', umY: '.6'}); assert.equal(patch.title, 'HE'); assert.equal(patch.umPerPixel.x, 0.5);
  }
  console.log('roi_media_viewer_regression: PASS (adapter routing, event isolation, dirty guard, deferred I/O, failed replacement, calibration)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
