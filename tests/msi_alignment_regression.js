'use strict';
// Exercise the real Align modal and its real handlers in a deterministic DOM.
// Canvas decoding and layout are adapters; state transitions, close routing,
// landmark math, session logic, and persistence calls come from production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const identity = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

function sourceFunction(name) {
    const start = html.search(new RegExp('(?:async )?function ' + name + '\\('));
    assert.ok(start >= 0, 'production function exists: ' + name);
    const end = html.indexOf('\n}', start) + 2;
    assert.ok(end > start, 'production function boundary: ' + name);
    return html.slice(start, end);
}

class EventTarget {
    constructor() { this.listeners = new Map(); }
    addEventListener(type, listener, options = {}) {
        const capture = options === true || !!options.capture;
        const list = this.listeners.get(type) || [];
        list.push({ listener, capture, once: !!options.once }); this.listeners.set(type, list);
    }
    removeEventListener(type, listener) {
        this.listeners.set(type, (this.listeners.get(type) || []).filter(x => x.listener !== listener));
    }
    async fire(type, props = {}) {
        const event = { type, target: this, currentTarget: this, defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; },
            stopPropagation() { this.stopped = true; },
            stopImmediatePropagation() { this.immediate = this.stopped = true; }, ...props };
        const list = [...(this.listeners.get(type) || [])].sort((a, b) => Number(b.capture) - Number(a.capture));
        for (const item of list) {
            if (event.immediate) break;
            if (item.once) this.removeEventListener(type, item.listener);
            await item.listener.call(this, event);
        }
        const direct = this['on' + type];
        if (!event.immediate && typeof direct === 'function') await direct.call(this, event);
        return event;
    }
}

const decode = text => String(text).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
class Element extends EventTarget {
    constructor(tagName = 'div', document = null) {
        super(); this.tagName = tagName.toUpperCase(); this.ownerDocument = document;
        this.children = []; this.parentNode = null; this.attrs = {}; this.dataset = {};
        this.style = { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } };
        this._value = ''; this.checked = false; this.disabled = false; this.hidden = false;
        this._innerHTML = ''; this._textContent = ''; this.clientWidth = 640; this.clientHeight = 440;
        const classes = new Set();
        this.classList = { add: (...xs) => xs.forEach(x => classes.add(x)), remove: (...xs) => xs.forEach(x => classes.delete(x)),
            contains: x => classes.has(x), toggle(x, force) { const active = force === undefined ? !classes.has(x) : force; active ? classes.add(x) : classes.delete(x); return active; } };
    }
    get isConnected() { return this.tagName === 'BODY' || !!this.parentNode?.isConnected; }
    get parentElement() { return this.parentNode; }
    get childNodes() { return this.children; }
    appendChild(child) { if (child.parentNode) child.remove(); child.parentNode = this; this.children.push(child); return child; }
    append(...children) { children.forEach(x => this.appendChild(x)); }
    replaceChildren(...children) { this.children.forEach(x => { x.parentNode = null; }); this.children = []; this.append(...children); }
    insertBefore(child, before) { child.remove(); child.parentNode = this; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, child); return child; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; }
    contains(child) { return child === this || this.children.some(x => x.contains(child)); }
    setAttribute(name, value) {
        this.attrs[name] = String(value);
        if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
        if (name === 'value') this._value = String(value);
        if (name === 'checked') this.checked = true;
        if (name === 'disabled') this.disabled = true;
        if (name === 'class') { this.className = value; String(value).split(/\s+/).forEach(x => this.classList.add(x)); }
        if (name === 'id') this.id = value;
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
    removeAttribute(name) { delete this.attrs[name]; if (name === 'src') this._src = ''; }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    get options() { return this.children.filter(x => x.tagName === 'OPTION'); }
    get textContent() { return this._textContent; }
    set textContent(value) { this._textContent = String(value); }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(markup) {
        this._innerHTML = String(markup); this.replaceChildren();
        const stack = [this];
        const tags = String(markup).match(/<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*(?:>|$)/g) || [];
        const voidTags = new Set(['INPUT', 'IMG', 'BR', 'HR', 'META', 'LINK', 'AREA', 'WBR']);
        for (const token of tags) {
            if (token.startsWith('<!--')) continue;
            const tag = token.match(/^<\/?([\w-]+)/)?.[1]; if (!tag) continue;
            if (token.startsWith('</')) { while (stack.length > 1) { if (stack.pop().tagName === tag.toUpperCase()) break; } continue; }
            const child = this.ownerDocument.createElement(tag);
            const attrText = token.slice(tag.length + 1, -1);
            const attrs = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
            for (const match of attrText.matchAll(attrs)) child.setAttribute(match[1], decode(match[2] ?? match[3] ?? match[4] ?? ''));
            stack.at(-1).appendChild(child);
            if (!voidTags.has(child.tagName) && !token.endsWith('/>')) stack.push(child);
        }
        for (const select of [this, ...this.querySelectorAll('select')].filter(x => x.tagName === 'SELECT')) {
            select._value = (select.options.find(x => x.hasAttribute('selected')) || select.options[0])?.value || '';
        }
    }
    matches(selector) {
        if (selector === '*') return true;
        if (selector.startsWith('#')) return this.id === selector.slice(1);
        if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
        const attribute = selector.match(/^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/);
        if (attribute) return this.hasAttribute(attribute[1]) && (attribute[2] === undefined || this.getAttribute(attribute[1]) === attribute[2]);
        return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) {
        const selectors = selector.split(',').map(x => x.trim());
        const result = [];
        const visit = element => { for (const child of element.children) { if (selectors.some(x => child.matches(x))) result.push(child); visit(child); } };
        visit(this); return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let e = this; e; e = e.parentNode) if (e.matches(selector)) return e; return null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight }; }
    focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
    click() { if (this.disabled) return Promise.resolve(); return this.fire('click'); }
    getContext() { return this.ctx ||= new CanvasContext(this); }
    toDataURL() { return `mock:${this.width}x${this.height}:${this.ctx?.sourceTag || ''}`; }
    get src() { return this._src || ''; }
    set src(value) {
        this._src = value;
        const dims = String(value).match(/^mock:(\d+)x(\d+)/);
        if (dims) { this.naturalWidth = +dims[1]; this.naturalHeight = +dims[2]; this.complete = true; }
    }
}
class CanvasContext {
    constructor(canvas) { this.canvas = canvas; }
    save() {} restore() {} transform() {} setTransform() {} resetTransform() {} scale() {} translate() {} rotate() {}
    clearRect() {} fillRect() {} beginPath() {} moveTo() {} lineTo() {} closePath() {} clip() {} stroke() {} fill() {} arc() {} fillText() {}
    drawImage(image) { this.sourceTag = image.key || image.ctx?.sourceTag || ''; }
    createImageData(width, height) { const data = new Uint8ClampedArray(width * height * 4); data.fill(255); return { data, width, height }; }
    getImageData(x, y, width, height) { return this.createImageData(width, height); }
    putImageData() {}
}
class Document extends EventTarget {
    constructor() { super(); this.body = new Element('body', this); this.documentElement = new Element('html', this); this.activeElement = this.body; const host = this.createElement('div'); host.id = 'modal-host'; this.body.appendChild(host); }
    createElement(tag) { return new Element(tag, this); }
    createElementNS(ns, tag) { return this.createElement(tag); }
    getElementById(id) { return this.body.querySelector('#' + id); }
    querySelector(selector) { return this.body.querySelector(selector); }
    querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
}

function fixture() {
    const geometry = (sourceRef, W, H) => ({ version: 'msi-source-v1', sourceRef,
        displayGeometry: { version: 'msi-proportional-v1', W, H, x: { origin: 0, step: 1 }, y: { origin: 0, step: 1 } },
        legacy: { W, H, confirmed: true, x: Array.from({ length: W }, (_, i) => [i, i]), y: Array.from({ length: H }, (_, i) => [i, i]) } });
    const series = (fid, ref, W, H, valueColumn) => ({ sourceFileId: fid, sourceReference: ref, kind: 'csv', col_x: 'A', col_y: 'B', col_v: valueColumn,
        sourceGeometry: geometry(ref, W, H), def: { kind: 'csv', xCol: 0, yCol: 1, vCol: valueColumn },
        W, H, rawRange: { min: -2, max: 30 }, rawDispMax: 30 });
    return { id: 'section-1', name: 'Asymmetric section',
        images: { HE_STAIN: { blobId: 'he-1' }, IF_STAIN: { blobId: 'if-1' } },
        msiFiles: { 'file-1': { filename: 'measure-1.csv', blobId: 'raw-1' }, 'file-2': { filename: 'measure-2.csv', blobId: 'raw-2' } },
        msiSeries: { MSI_A: series('file-1', 'source-1', 8, 6, 2), MSI_B: series('file-1', 'source-1', 8, 6, 3), MSI_C: series('file-2', 'source-2', 12, 7, 2) },
        meta: { alignmentMsiKey: 'MSI_A', alignmentSourceMode: 'file-1', perSourceAlign: true,
            world_coords: { T_he_to_msi: identity(), msi_um_per_px: { x: 10, y: 30 } },
            alignment: { HE_STAIN: { scale_pct: 100, landmarks: { he: [], msi: [] }, bySource: {
                'file-1': { scale_pct: 100, rotate_deg: 0, offx: 0, offy: 0, landmarks: { he: [], msi: [] } },
                'file-2': { scale_pct: 125, rotate_deg: 0, offx: 0, offy: 0, landmarks: { he: [], msi: [] } }
            } } } } };
}

async function harness(options = {}) {
    const document = new Document(), window = new EventTarget(), frames = new Map(), timers = new Map(), errors = [];
    const section = options.section ? plain(options.section) : fixture(); if (options.prepare) options.prepare(section);
    const initialSection = plain(section);
    const originalRows = [{ rowId: 0, x: 0, y: 0, v: -2 }, { rowId: 1, x: 0, y: 0, v: 30 }, { rowId: 2, x: 7, y: 5, v: null }];
    const roi = { id: 'roi-1', polysBySection: { 'section-1': [[0, 0], [7, 0], [7, 5]] }, mean: 14, max: 30 };
    const numericBefore = JSON.stringify({ originalRows, roi });
    const saves = [], sharedSaves = [], queueSaves = [], alerts = [], releaseCalls = [];
    const imageFor = (key, W, H) => { const image = document.createElement('img'); Object.assign(image, { key, complete: true, naturalWidth: W, naturalHeight: H }); return image; };
    const imageSources = { HE_STAIN: imageFor('HE_STAIN', 8, 6), IF_STAIN: imageFor('IF_STAIN', 8, 6) };
    for (const [key, entry] of Object.entries(section.msiSeries)) imageSources[key] = imageFor(key, entry.W, entry.H);
    const project = { id: 'project-1', sections: [section], rois: [roi] };
    const panel = { section, project, imageSources, msiValueRasters: new Map(), originalRows,
        getMsiRefSize: () => ({ w: 8, h: 6 }), msiRasterSize: k => ({ w: imageSources[k]?.naturalWidth || 8, h: imageSources[k]?.naturalHeight || 6 }),
        _pickRefMsiKey: () => 'MSI_A', renderComposite() {}, refreshSectionLabel() {},
        _ensureDrawableLoaded() {}, loadImageLayer: async () => {}, loadMsiLayer: async () => {} };
    const shareRecords = new Map([[section.id, { payload: {}, version: 7 }]]);
    let nextTimer = 1, storageFail = !!options.storageFail, shareFail = !!options.shareFail, closed = false, outcome;
    const App = { project, currentProject: project, focusCompoundKey: 'MSI_A', viewMode: 'compound', panels: new Map([[section.id, panel]]), shareMode: options.shared ? { token: 'test-token' } : null,
        getMsiWindow: () => ({ min: 0, max: 30 }), queueSave: (...args) => queueSaves.push(args),
        setFocusCompoundKey(key) { this.focusCompoundKey = key; },
        _tryAcquireRoiLock: async () => true, _releaseRoiLock: () => releaseCalls.push(true), _refreshShareAlignments: async () => {},
        saveProject: async (...args) => { if (storageFail) throw new Error('simulated disk failure'); saves.push(plain(args)); },
        saveNow: async (...args) => { if (storageFail) throw new Error('simulated disk failure'); saves.push(plain(args)); } };
    let workspaceCallbacks;
    const context = vm.createContext({ console, document, window, Image: class extends Element { constructor() { super('img', document); } },
        Math, Number, String, Boolean, Object, Array, Date, JSON, Map, Set, WeakMap, Promise, Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, structuredClone,
        App, panel, _shareAlignBySection: shareRecords, isShareAlignMode: () => !!options.shared,
        alert: x => alerts.push(String(x)), confirm: () => true, showToast: x => alerts.push(String(x)),
        requestAnimationFrame: callback => { const id = nextTimer++; frames.set(id, callback); return id; }, cancelAnimationFrame: id => frames.delete(id),
        setTimeout: callback => { const id = nextTimer++; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
        performance: { now: () => 0 }, ResizeObserver: class { observe() {} disconnect() {} },
        getComputedStyle: () => ({ objectFit: 'contain', objectPosition: '50% 50%' }),
        ProjectStorage: { getBlob: async () => null, putProject: async (...args) => { if (storageFail) throw new Error('simulated disk failure'); saves.push(plain(args)); } },
        decodeImageBlobToDataUrl: async () => null, get2dContext: c => c.getContext('2d'),
        getActiveColormap: () => Array.from({ length: 256 }, (_, i) => [i, 0, 0]), getColormapBackground: () => [0, 0, 0],
        msiRawFallbackMax: () => 30, msiValueEval: () => ({ n: 0.5 }), msiWindowEval: () => ({ n: 0.5 }),
        otsuKeepGridForLayer: () => null, formatDisplayName: key => key,
        msiLayerSourceGeometry: (sec, key) => sec.msiSeries[key]?.sourceGeometry,
        msiLegacyEdgePointToDisplay: (sec, key, p) => p,
        msiDisplayEdgePointToLegacy: (sec, key, p) => p,
        msiDisplayPhysicalPitch: sec => sec.meta.world_coords.msi_um_per_px,
        heMsiDisplayWarp: () => null,
        pushShareAlignment: async (...args) => { sharedSaves.push({ args: plain(args), realSection: plain(section) }); return !shareFail; },
        captureSectionAlignment: sec => plain(sec.meta),
        applySectionAlignment: (sec, value) => { sec.meta = plain(value); },
        saveShareAlignChoice() {}, applyAlignChoiceToSections() {},
    });
    window.document = document; window.innerWidth = 1366; window.innerHeight = 768;
    const helpers = html.slice(html.indexOf('function displayAffineMultiply('), html.indexOf('// ---- HE↔MSI registration math'));
    vm.runInContext(helpers, context);
    for (const name of ['buildHeToMsiAffine', 'solveSimilarity', 'computeLandmarkResiduals', 'assessLandmarkGeometry', 'openModal']) vm.runInContext(sourceFunction(name), context);
    for (const name of ['SECTION_ALIGN_WC_KEYS', 'SECTION_ALIGN_META_KEYS']) {
        const declaration = new RegExp('const ' + name + ' = \\[[^\\]]*\\];').exec(html);
        if (declaration) vm.runInContext(declaration[0], context);
    }
    for (const name of ['alignmentFrameDescriptor', 'alignmentLegacySourceIsUnambiguous', 'alignmentLegacySeedIsCompatible', 'alignmentImageIdentity', 'alignmentValidAffine',
        'captureSectionAlignment', 'applySectionAlignment', 'getShareAlignmentVersion']) {
        if (html.includes('function ' + name + '(')) vm.runInContext(sourceFunction(name), context);
    }
    for (const filename of ['alignment-session.js']) {
        const full = path.join(__dirname, '../viewer', filename);
        if (fs.existsSync(full)) vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename });
    }
    // Layout and viewport integration have their own regression suite. Only
    // this display adapter is stubbed here; every modal handler is real.
    context.MsiAlignmentWorkspace = { mount: (card, callbacks) => { workspaceCallbacks = callbacks; return { refresh() {}, requestComposite() {}, getViewState: () => ({}),
        setViewState() {}, acceptsPoint: () => true, destroy() {}, setCompositeRenderer() {},
        getContentRect: side => context.openModal._card.querySelector(`[data-${side}-img]`).getBoundingClientRect(),
        clientToImage: () => null }; } };
    const methodStart = html.indexOf('    async openAlignmentModal(panel) {');
    const methodEnd = html.indexOf('\n    async openHeIfWizard(panel)', methodStart);
    assert.ok(methodStart >= 0 && methodEnd > methodStart, 'actual Align method boundary');
    vm.runInContext('globalThis.Wizards = {' + html.slice(methodStart, methodEnd) + '};', context);
    if (options.images) options.images(imageSources);
    const pending = context.Wizards.openAlignmentModal(panel).then(value => { closed = true; outcome = value; }, error => { errors.push(error); closed = true; });
    async function flush() {
        for (let round = 0; round < 12; round++) {
            await new Promise(resolve => setImmediate(resolve));
            const callbacks = [...frames.values(), ...timers.values()]; frames.clear(); timers.clear();
            for (const callback of callbacks) await callback(0);
        }
        if (errors.length) throw errors[0];
    }
    await flush();
    const card = context.openModal._card; assert.ok(card, 'Align opens');
    const $ = selector => { const element = card.querySelector(selector); assert.ok(element, 'Align control exists: ' + selector); return element; };
    const fire = async (selector, type, props) => { await $(selector).fire(type, props); await flush(); };
    const change = async (selector, value) => { $(selector).value = value; await fire(selector, 'change'); };
    const input = async (selector, value) => { $(selector).value = value; await fire(selector, 'input'); };
    const click = selector => fire(selector, 'click');
    const addPair = async (x = 100, y = 80) => {
        await click('[data-pick="he"]'); await fire('[data-he-img]', 'click', { clientX: x, clientY: y });
        await click('[data-pick="msi"]'); await fire('[data-msi-img]', 'click', { clientX: x, clientY: y });
    };
    const assertNumericUnchanged = () => assert.equal(JSON.stringify({ originalRows, roi }), numericBefore, 'MSI source rows and ROI quantitative state unchanged');
    return { context, panel, section, initialSection, project, card, $, fire, change, input, click, addPair, flush, window, document,
        shareRecords, saves, sharedSaves, queueSaves, alerts, releaseCalls, imageSources, pending, assertNumericUnchanged,
        closeFromWorkspace: () => workspaceCallbacks.onClose(),
        get closed() { return closed; }, get outcome() { return outcome; }, setStorageFail(value) { storageFail = value; }, setShareFail(value) { shareFail = value; } };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const expectPoints = (h, he, msi) => assert.match(h.$('[data-pick-status]').textContent, new RegExp(`HE ${he} / MSI ${msi}(?:\\D|$)`));
const compatibleSources = section => {
    section.msiSeries.MSI_C.sourceGeometry = plain(section.msiSeries.MSI_A.sourceGeometry);
    section.msiSeries.MSI_C.W = 8; section.msiSeries.MSI_C.H = 6;
};
const savedFrame = (section, sourceId, layer = 'HE_STAIN') => Object.values(section.meta.alignment[layer].byFrame)
    .find(record => record.frame.sourceFileId === sourceId);

test('new landmarks and scale survive A → B → A in the same measurement', async () => {
    const h = await harness(); await h.addPair(); await h.input('[data-scale-num]', 142);
    const coordinates = h.$('[data-lm-table]').innerHTML;
    await h.change('[data-align-msi]', 'MSI_B'); expectPoints(h, 1, 1);
    assert.equal(+h.$('[data-scale-num]').value, 142); assert.equal(h.$('[data-lm-table]').innerHTML, coordinates);
    await h.addPair(250, 190); expectPoints(h, 2, 2);
    await h.change('[data-align-msi]', 'MSI_A'); expectPoints(h, 2, 2);
    assert.equal(+h.$('[data-scale-num]').value, 142); h.assertNumericUnchanged();
    await h.click('[data-modal-cancel]');
});

test('source and HE switches retain independent unfinished drafts', async () => {
    const h = await harness(); await h.addPair(); await h.input('[data-scale-num]', 142);
    await h.change('[data-align-source]', 'file-2'); expectPoints(h, 0, 0);
    await h.addPair(300, 200); await h.input('[data-scale-num]', 175);
    await h.change('[data-align-source]', 'file-1'); expectPoints(h, 1, 1); assert.equal(+h.$('[data-scale-num]').value, 142);
    await h.change('[data-align-layer]', 'IF_STAIN'); expectPoints(h, 0, 0);
    await h.addPair(120, 200); await h.input('[data-scale-num]', 88);
    await h.change('[data-align-layer]', 'HE_STAIN'); expectPoints(h, 1, 1); assert.equal(+h.$('[data-scale-num]').value, 142);
    await h.change('[data-align-source]', 'file-2'); expectPoints(h, 1, 1); assert.equal(+h.$('[data-scale-num]').value, 175);
    h.assertNumericUnchanged(); await h.click('[data-modal-cancel]');
});

test('Solve uses the combined landmarks collected across molecules', async () => {
    const h = await harness();
    const addTranslatedPair = async (x, y) => {
        await h.click('[data-pick="he"]'); await h.fire('[data-he-img]', 'click', { clientX: x, clientY: y });
        await h.click('[data-pick="msi"]'); await h.fire('[data-msi-img]', 'click', { clientX: x + 80, clientY: y + 44 });
    };
    await addTranslatedPair(100, 80);
    await h.change('[data-align-msi]', 'MSI_B');
    await addTranslatedPair(250, 190); await addTranslatedPair(400, 250);
    expectPoints(h, 3, 3); assert.equal(h.$('[data-solve]').disabled, false);
    await h.click('[data-solve]');
    // Fixture canvas: 8 × 6 logical pixels in 640 × 440 CSS pixels, with
    // the preserved initial 180° view. CSS (+80, +44) = raw (−1, −0.6).
    assert.ok(Math.abs(+h.$('[data-scale-num]').value - 100) < 1e-9);
    assert.ok(Math.abs(+h.$('[data-rotate-num]').value) < 1e-9);
    assert.ok(Math.abs(+h.$('[data-offx-num]').value + 1) < 1e-9);
    assert.ok(Math.abs(+h.$('[data-offy-num]').value + 0.6) < 1e-9);
    await h.click('[data-save]'); assert.equal(h.closed, true);
    const saved = Object.values(h.section.meta.alignment.HE_STAIN.byFrame)[0];
    assert.equal(saved.landmarks.he.length, 3); assert.equal(saved.landmarks.msi.length, 3);
    assert.ok(Math.abs(saved.T_he_to_msi[0][2] + 1) < 1e-9); h.assertNumericUnchanged();
});

test('Cancel discards all drafts and per-source toggle without any save', async () => {
    const h = await harness({ shared: true });
    assert.deepEqual(plain(h.section), h.initialSection, 'opening cannot write real section metadata');
    await h.addPair(); await h.input('[data-scale-num]', 123);
    h.$('[data-align-persource]').checked = false; await h.fire('[data-align-persource]', 'change');
    await h.change('[data-align-source]', 'file-2'); await h.addPair();
    assert.deepEqual(plain(h.section), h.initialSection, 'draft controls cannot write real section metadata');
    assert.equal(h.queueSaves.length, 0, 'toggle must not queue persistence');
    await h.click('[data-modal-cancel]');
    assert.equal(h.closed, true); assert.equal(h.releaseCalls.length, 1);
    assert.deepEqual(plain(h.section), h.initialSection); assert.equal(h.sharedSaves.length, 0); h.assertNumericUnchanged();
});

test('workspace close action uses the same cleanup path as Cancel', async () => {
    const h = await harness({ shared: true }); await h.addPair(); await h.input('[data-scale-num]', 123);
    h.closeFromWorkspace(); await h.flush();
    assert.equal(h.closed, true); assert.equal(h.releaseCalls.length, 1); assert.deepEqual(plain(h.section), h.initialSection);
    h.assertNumericUnchanged();
});

test('Escape on the focused modal closes and releases the lock exactly once', async () => {
    const h = await harness({ shared: true }); await h.addPair(); await h.input('[data-scale-num]', 123);
    await h.card.fire('keydown', { key: 'Escape', target: h.$('[data-scale-num]') }); await h.flush();
    assert.equal(h.closed, true); assert.equal(h.releaseCalls.length, 1);
    await h.card.fire('keydown', { key: 'Escape' }); h.closeFromWorkspace(); await h.flush();
    assert.equal(h.releaseCalls.length, 1); assert.deepEqual(plain(h.section), h.initialSection); h.assertNumericUnchanged();
});

test('same-sized images with different source coordinates keep separate drafts', async () => {
    const h = await harness({ prepare(section) {
        section.msiSeries.MSI_B.sourceGeometry.legacy.x = Array.from({ length: 8 }, (_, i) => [i + 10, i]);
        section.msiSeries.MSI_B.sourceGeometry.displayGeometry.x.origin = 10;
    } });
    await h.addPair(); await h.input('[data-scale-num]', 144);
    await h.change('[data-align-msi]', 'MSI_B'); expectPoints(h, 0, 0);
    await h.addPair(270, 210); await h.input('[data-scale-num]', 99);
    await h.change('[data-align-msi]', 'MSI_A'); expectPoints(h, 1, 1); assert.equal(+h.$('[data-scale-num]').value, 144);
    await h.change('[data-align-msi]', 'MSI_B'); expectPoints(h, 1, 1); assert.equal(+h.$('[data-scale-num]').value, 99);
    await h.click('[data-modal-cancel]'); assert.deepEqual(plain(h.section), h.initialSection);
});

test('a late molecule image load cannot replace the current molecule', async () => {
    const h = await harness({ images(images) { images.MSI_A.complete = false; images.MSI_A.naturalWidth = 0; images.MSI_A.naturalHeight = 0; } });
    await h.change('[data-align-msi]', 'MSI_B'); const selectedImage = h.$('[data-msi-img]').src;
    assert.ok(selectedImage, 'new molecule rendered');
    Object.assign(h.imageSources.MSI_A, { complete: true, naturalWidth: 8, naturalHeight: 6 });
    await h.imageSources.MSI_A.fire('load'); await h.flush();
    assert.equal(h.$('[data-msi-img]').src, selectedImage, 'stale completion cannot overwrite B');
    assert.equal(h.$('[data-align-msi]').value, 'MSI_B'); await h.click('[data-modal-cancel]');
});

test('failed shared save retains the draft and uses the opening version', async () => {
    const h = await harness({ shared: true, shareFail: true }); await h.addPair(); await h.input('[data-scale-num]', 133);
    h.shareRecords.set(h.section.id, { payload: { received: true }, version: 8 });
    await h.click('[data-save]');
    assert.equal(h.sharedSaves.length, 1); assert.equal(h.closed, false); expectPoints(h, 1, 1);
    assert.equal(+h.$('[data-scale-num]').value, 133); assert.deepEqual(plain(h.section), h.initialSection);
    const options = h.sharedSaves[0].args[1];
    assert.equal(options?.expectedVersion, 7, 'share save must compare with the version from opening, not latest poll');
    assert.equal(h.releaseCalls.length, 0, 'failed save retains editor lock while draft stays open');
    await h.click('[data-modal-cancel]'); assert.equal(h.releaseCalls.length, 1); h.assertNumericUnchanged();
});

test('local save failure keeps private drafts and retry persists every edited frame', async () => {
    const h = await harness({ storageFail: true });
    await h.addPair(); await h.input('[data-scale-num]', 142);
    await h.change('[data-align-msi]', 'MSI_B'); await h.addPair(250, 190);
    await h.change('[data-align-source]', 'file-2'); await h.addPair(300, 200); await h.input('[data-scale-num]', 175);
    await h.change('[data-align-layer]', 'IF_STAIN'); await h.addPair(120, 200); await h.input('[data-scale-num]', 88);
    await h.click('[data-save]');
    assert.equal(h.closed, false); expectPoints(h, 1, 1); assert.equal(+h.$('[data-scale-num]').value, 88);
    assert.deepEqual(plain(h.section), h.initialSection, 'failed write cannot expose any alignment draft');
    assert.equal(h.queueSaves.length, 0); assert.ok(h.alerts.some(x => x.includes('simulated disk failure')));
    h.setStorageFail(false); await h.click('[data-save]');
    assert.equal(h.closed, true); assert.equal(h.outcome, 'saved'); assert.equal(h.saves.length, 1);
    assert.equal(h.queueSaves.length, 1, 'normal synchronization starts after durable save');
    const savedSection = h.saves[0][0].sections.find(s => s.id === h.section.id);
    assert.deepEqual(savedSection.meta, plain(h.section.meta), 'detached saved snapshot matches committed metadata');
    const heFrames = Object.values(h.section.meta.alignment.HE_STAIN.byFrame);
    const a = heFrames.find(record => record.frame.sourceFileId === 'file-1');
    const c = heFrames.find(record => record.frame.sourceFileId === 'file-2');
    assert.equal(a.landmarks.he.length, 2); assert.equal(a.landmarks.msi.length, 2); assert.equal(a.scale_pct, 142);
    assert.equal(c.landmarks.he.length, 1); assert.equal(c.landmarks.msi.length, 1); assert.equal(c.scale_pct, 175);
    const ifFrame = Object.values(h.section.meta.alignment.IF_STAIN.byFrame)[0];
    assert.equal(ifFrame.landmarks.he.length, 1); assert.equal(ifFrame.scale_pct, 88);
    assert.deepEqual(plain(h.section.msiSeries), h.initialSection.msiSeries);
    assert.deepEqual(plain(h.section.msiFiles), h.initialSection.msiFiles);
    assert.deepEqual(plain(h.section.meta.world_coords.msi_um_per_px), h.initialSection.meta.world_coords.msi_um_per_px);
    h.assertNumericUnchanged();
});

test('explicit Apply all commits an unchanged source alignment to every compatible source', async () => {
    const h = await harness({ prepare: compatibleSources });
    assert.equal(+h.$('[data-scale-num]').value, 100);
    await h.click('[data-apply-all]');
    assert.equal(h.closed, true); assert.equal(h.outcome, 'saved');
    assert.equal(savedFrame(h.section, 'file-1').scale_pct, 100);
    assert.equal(savedFrame(h.section, 'file-2').scale_pct, 100, 'explicit apply replaces the second source baseline of 125');
    const shared = Object.values(h.section.meta.alignment.HE_STAIN.sharedByCoordinate)[0];
    assert.equal(shared.scale_pct, 100); assert.equal(h.section.meta.alignmentSourceMode, '__all__');
    h.assertNumericUnchanged();
});

test('shared and individual saves follow the most recent real edit, not the order of visits', async () => {
    const h = await harness({ prepare: compatibleSources });
    await h.input('[data-scale-num]', 111);
    await h.change('[data-align-source]', '__all__'); await h.input('[data-scale-num]', 130);
    await h.change('[data-align-source]', 'file-2'); await h.input('[data-scale-num]', 150);
    await h.change('[data-align-source]', 'file-1'); await h.input('[data-scale-num]', 170);
    await h.change('[data-align-source]', '__all__'); await h.input('[data-scale-num]', 190);
    await h.change('[data-align-source]', 'file-2'); await h.input('[data-scale-num]', 210);
    // Merely visiting an older individual draft and a common draft, including
    // assigning the same slider value, must not promote its edit revision.
    await h.change('[data-align-source]', 'file-1'); assert.equal(+h.$('[data-scale-num]').value, 170);
    await h.change('[data-align-source]', '__all__'); await h.input('[data-scale-num]', 190);
    await h.change('[data-align-source]', 'file-1'); await h.click('[data-save]');
    assert.equal(h.closed, true);
    assert.equal(savedFrame(h.section, 'file-1').scale_pct, 190, 'later common edit applies to source one');
    assert.equal(savedFrame(h.section, 'file-2').scale_pct, 210, 'latest individual edit wins for source two');
    assert.equal(Object.values(h.section.meta.alignment.HE_STAIN.sharedByCoordinate)[0].scale_pct, 190);
    h.assertNumericUnchanged();
});

test('shared state reopens from its own record after a source received a later individual edit', async () => {
    const first = await harness({ prepare(section) { compatibleSources(section); section.meta.perSourceAlign = false; } });
    await first.change('[data-align-source]', '__all__'); await first.input('[data-scale-num]', 140);
    await first.addPair(); expectPoints(first, 1, 1); await first.click('[data-save]'); assert.equal(first.closed, true, JSON.stringify(first.alerts));
    const second = await harness({ section: first.section });
    assert.equal(second.$('[data-align-source]').value, '__all__'); expectPoints(second, 1, 1);
    await second.change('[data-align-source]', 'file-1'); await second.input('[data-scale-num]', 175);
    await second.click('[data-save]'); assert.equal(second.closed, true);
    const third = await harness({ section: second.section });
    assert.equal(+third.$('[data-scale-num]').value, 175);
    await third.change('[data-align-source]', '__all__'); assert.equal(+third.$('[data-scale-num]').value, 140);
    expectPoints(third, 1, 1); await third.click('[data-save]'); assert.equal(third.closed, true);
    const reopened = await harness({ section: third.section });
    assert.equal(reopened.$('[data-align-source]').value, '__all__');
    assert.equal(+reopened.$('[data-scale-num]').value, 140, 'common record must not inherit source one value 175');
    expectPoints(reopened, 1, 1); await reopened.click('[data-modal-cancel]'); reopened.assertNumericUnchanged();
});

test('saved HE selection reopens and a source remembers its selected molecule during switching', async () => {
    const h = await harness(); await h.change('[data-align-layer]', 'IF_STAIN');
    await h.change('[data-align-msi]', 'MSI_B'); await h.addPair(); await h.input('[data-scale-num]', 87);
    await h.change('[data-align-source]', 'file-2'); await h.change('[data-align-source]', 'file-1');
    assert.equal(h.$('[data-align-msi]').value, 'MSI_B'); expectPoints(h, 1, 1);
    await h.click('[data-save]'); assert.equal(h.closed, true);
    const reopened = await harness({ section: h.section });
    assert.equal(reopened.$('[data-align-layer]').value, 'IF_STAIN');
    assert.equal(reopened.$('[data-align-msi]').value, 'MSI_B');
    assert.equal(+reopened.$('[data-scale-num]').value, 87); expectPoints(reopened, 1, 1);
    await reopened.change('[data-align-source]', 'file-2'); await reopened.change('[data-align-source]', 'file-1');
    assert.equal(reopened.$('[data-align-msi]').value, 'MSI_B');
    await reopened.click('[data-modal-cancel]'); reopened.assertNumericUnchanged();
});

(async () => {
    let passed = 0;
    for (const { name, fn } of tests) { await fn(); passed++; console.log('PASS Align: ' + name); }
    console.log(`MSI alignment modal regression tests: PASS (${passed} actual interaction paths)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
