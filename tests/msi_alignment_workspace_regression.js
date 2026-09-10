'use strict';

const assert = require('node:assert/strict');
const Workspace = require('../viewer/alignment-workspace.js');

function closeTo(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`); }
function geometryContract() {
    for (const [w, h] of [[300, 100], [100, 300], [240, 240], [4096, 1]]) {
        const fitted = Workspace.fitView(w, h, 640, 480);
        const before = Workspace.imageRect(fitted, w, h, 640, 480);
        closeTo(before.left + before.width / 2, 320); closeTo(before.top + before.height / 2, 240);
        const anchor = [320, 220];
        const imagePoint = [(anchor[0] - before.left) / before.width, (anchor[1] - before.top) / before.height];
        const zoomed = Workspace.zoomView(fitted, 2.5, ...anchor, w, h, 640, 480);
        const after = Workspace.imageRect(zoomed, w, h, 640, 480);
        closeTo((anchor[0] - after.left) / after.width, imagePoint[0]);
        closeTo((anchor[1] - after.top) / after.height, imagePoint[1]);
        const moved = Workspace.panView(zoomed, 70, -35, w, h);
        const movedRect = Workspace.imageRect(moved, w, h, 640, 480);
        closeTo(movedRect.left - after.left, 70); closeTo(movedRect.top - after.top, -35);
        const resized = Workspace.imageRect(moved, w, h, 900, 700);
        closeTo(resized.width, movedRect.width); closeTo(resized.height, movedRect.height);
        const inside = [resized.left + resized.width * 0.2, resized.top + resized.height * 0.7];
        const clicked = Workspace.clientPoint(resized, ...inside, w, h);
        closeTo(clicked[0], w * 0.2); closeTo(clicked[1], h * 0.7);
        assert.equal(Workspace.clientPoint(resized, resized.left - 1, resized.top, w, h), null);
        assert.equal(Workspace.clientPoint(resized, resized.left, resized.top + resized.height, w, h), null);
    }
    assert.equal(Workspace.fitView(0, 100, 640, 480), null);
    assert.equal(Workspace.clientPoint({left: 0, top: 0, width: 0, height: 100}, 0, 0, 100, 100), null);
}

// DOM event/tree test double: layout is supplied explicitly. It tests the real
// mounted UI's listener ordering, element identity, transforms and cleanup;
// native CSS layout and platform keyboard behavior still require browser QA.
class Element {
    constructor(tag, doc) {
        this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.childNodes = [];
        this.attrs = new Map(); this.dataset = {}; this.style = {}; this.events = new Map();
        this.clientWidth = 640; this.clientHeight = 480; this.value = ''; this.inert = false;
        this.classList = {
            add: (...names) => { const set = new Set((this.className || '').split(/\s+/).filter(Boolean)); names.forEach(n => set.add(n)); this.className = [...set].join(' '); },
            remove: (...names) => { this.className = (this.className || '').split(/\s+/).filter(n => !names.includes(n)).join(' '); },
            contains: name => (this.className || '').split(/\s+/).includes(name),
            toggle: (name, force) => { const enabled = force == null ? !this.classList.contains(name) : force; this.classList[enabled ? 'add' : 'remove'](name); return enabled; }
        };
    }
    get children() { return this.childNodes.filter(node => !node.tagName.startsWith('#')); }
    get parentElement() { return this.parentNode || null; }
    get className() { return this.getAttribute('class') || ''; }
    set className(value) { this.setAttribute('class', value); }
    get hidden() { return this.attrs.has('hidden'); }
    set hidden(value) { if (value) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
    get tabIndex() { return Number(this.getAttribute('tabindex')); }
    set tabIndex(value) { this.setAttribute('tabindex', String(value)); }
    get isConnected() { return this === this.ownerDocument.body || !!(this.parentNode && this.parentNode.isConnected); }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    getAttribute(name) { return this.attrs.has(name) ? this.attrs.get(name) : null; }
    removeAttribute(name) { this.attrs.delete(name); }
    appendChild(child) { child.remove(); this.childNodes.push(child); child.parentNode = this; return child; }
    insertBefore(child, next) { child.remove(); const index = this.childNodes.indexOf(next); if (index < 0) throw new Error('Missing insertion point'); this.childNodes.splice(index, 0, child); child.parentNode = this; return child; }
    remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); this.parentNode = null; }
    contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
    matches(selector) {
        if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
        const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(selector);
        if (match) return this.attrs.has(match[1]) && (match[2] == null || this.getAttribute(match[1]) === match[2]);
        return this.tagName === selector.toUpperCase();
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(selector.split(',').some(s => child.matches(s)) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement && this.parentElement.closest(selector); }
    addEventListener(type, fn, options) { const events = this.events.get(type) || []; events.push({ fn, capture: options === true || !!(options && options.capture) }); this.events.set(type, events); }
    removeEventListener(type, fn) { this.events.set(type, (this.events.get(type) || []).filter(item => item.fn !== fn)); }
    dispatch(type, props) {
        const event = Object.assign({ type, target: this, defaultPrevented: false, detail: 1,
            preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
            stopImmediatePropagation() { this.stopped = true; this.immediate = true; } }, props);
        const chain = []; for (let node = this; node; node = node.parentNode) chain.push(node);
        for (const capture of [true, false]) {
            for (const node of (capture ? [...chain].reverse() : chain)) {
                for (const listener of node.events.get(type) || []) {
                    if (listener.capture === capture) listener.fn(event);
                    if (event.immediate) return event;
                }
                if (event.stopped) return event;
            }
        }
        return event;
    }
    focus() { this.ownerDocument.activeElement = this; }
    setPointerCapture(id) { this.pointerId = id; }
    hasPointerCapture(id) { return this.pointerId === id; }
    releasePointerCapture() { this.pointerId = null; }
    getBoundingClientRect() {
        if (this.tagName === 'IMG' && this.parentNode && this.parentNode.classList.contains('msi-align-content')) {
            const content = this.parentNode, viewport = content.parentNode.getBoundingClientRect();
            const m = /translate\(([-.\de]+)px, ([-.\de]+)px\) scale\(([-.\de]+)\)/.exec(content.style.transform);
            if (m) return { left: viewport.left + Number(m[1]), top: viewport.top + Number(m[2]),
                width: parseFloat(content.style.width) * Number(m[3]), height: parseFloat(content.style.height) * Number(m[3]) };
        }
        return { left: 100, top: 80, width: this.clientWidth, height: this.clientHeight };
    }
    getClientRects() { for (let node = this; node; node = node.parentNode) if (node.hidden) return []; return [this.getBoundingClientRect()]; }
    getContext() {
        this.context ||= { draws: [], clearRect() {}, drawImage: image => this.context.draws.push(image.token || 'canvas') };
        return this.context;
    }
}
function fixture() {
    const doc = {}, frames = new Map(), observers = [];
    let nextFrame = 1;
    doc.createElement = tag => new Element(tag, doc);
    doc.createComment = () => new Element('#comment', doc);
    doc.createTextNode = text => { const node = new Element('#text', doc); node.textContent = text; return node; };
    doc.body = doc.createElement('body'); doc.body.style.overflow = 'auto';
    doc.defaultView = new Element('window', doc);
    doc.defaultView.requestAnimationFrame = fn => { const id = nextFrame++; frames.set(id, fn); return id; };
    doc.defaultView.cancelAnimationFrame = id => frames.delete(id);
    doc.defaultView.ResizeObserver = class { constructor(fn) { this.callback = fn; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } };
    const el = (tag, parent, attr) => { const node = doc.createElement(tag); if (attr) node.setAttribute(attr, ''); if (parent) parent.appendChild(node); return node; };
    const app = el('main', doc.body), opener = el('button', app); opener.focus();
    const priorInert = el('aside', doc.body); priorInert.inert = true; priorInert.setAttribute('aria-hidden', 'false');
    const host = el('div', doc.body), back = el('div', host), card = el('div', back); card._back = back; card.className = 'modal-card help-card';
    const header = el('div', card); el('h2', header); el('select', header, 'data-align-msi');
    el('p', card);
    const physical = el('fieldset', card); el('input', physical, 'data-msi-um-x');
    const manual = el('fieldset', card); el('input', manual, 'data-scale');
    const landmark = el('fieldset', card), controls = el('div', landmark);
    const pick = el('button', controls, 'data-pick'); pick.setAttribute('data-pick', 'he');
    for (const attr of ['data-solve', 'data-clear-lm']) el('button', controls, attr);
    el('span', controls, 'data-pick-status');
    el('div', landmark, 'data-qc'); el('div', landmark, 'data-auto-result');
    const imageGrid = el('div', landmark), images = {}, wraps = {}, svgs = {};
    for (const side of ['he', 'msi']) {
        const wrap = el('div', imageGrid, 'data-thumb-wrap'); wrap.setAttribute('data-thumb-wrap', side); wrap.setAttribute('style', 'original-wrap');
        el('div', wrap);
        const img = el('img', wrap, 'data-' + side + '-img'); img.naturalWidth = 300; img.naturalHeight = 100;
        img.setAttribute('style', 'original-image');
        images[side] = img; wraps[side] = wrap; svgs[side] = el('svg', wrap, 'data-' + side + '-svg');
    }
    el('table', landmark, 'data-lm-table');
    const footer = el('div', card); el('button', footer, 'data-reset');
    const actions = el('div', footer); el('button', actions, 'data-modal-cancel'); el('button', actions, 'data-save');
    const flush = async () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } await Promise.resolve(); await Promise.resolve(); };
    return { doc, app, priorInert, opener, host, back, card, images, wraps, svgs, observers, frames, flush };
}

async function mountedWorkspaceContract() {
    const f = fixture(); let changes = 0, closed = 0, pointClicks = 0;
    f.images.msi.addEventListener('click', () => { pointClicks++; });
    const oldWrapChildren = [...f.wraps.msi.childNodes];
    const workspace = Workspace.mount(f.card, { canSync: () => true, onViewChange: () => { changes++; }, onClose: () => { closed++; } });
    await f.flush();
    assert.equal(f.app.inert, true); assert.equal(f.app.getAttribute('aria-hidden'), 'true');
    assert.equal(f.doc.body.style.overflow, 'hidden');
    assert.equal(f.card.querySelector('[data-msi-img]'), f.images.msi);
    assert.equal(f.images.msi.parentNode, f.svgs.msi.parentNode, 'image and markers use one display transform');
    assert.equal(f.card.querySelectorAll('[data-msi-img]').length, 1, 'mount cannot clone image/event nodes');
    assert.equal(f.card.querySelector('.msi-align-details').parentNode.className, 'msi-align-footer');
    const viewBefore = workspace.getViewState();
    const rect = workspace.getContentRect('msi');
    const center = { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
    assert.equal(workspace.acceptsPoint('msi', center), true);
    f.images.msi.dispatch('click', center); assert.equal(pointClicks, 1);
    f.wraps.msi.dispatch('click', { clientX: 101, clientY: 81 });
    assert.equal(workspace.acceptsPoint('msi', { clientX: 101, clientY: 81 }), false, 'letterbox click cannot become a point');
    f.images.msi.dispatch('pointerdown', { ...center, pointerId: 1, button: 0 });
    f.images.msi.dispatch('pointermove', { clientX: center.clientX + 30, clientY: center.clientY + 12, pointerId: 1 });
    f.images.msi.dispatch('pointerup', { clientX: center.clientX + 30, clientY: center.clientY + 12, pointerId: 1 });
    f.images.msi.dispatch('click', { clientX: center.clientX + 30, clientY: center.clientY + 12 });
    await f.flush();
    assert.equal(pointClicks, 1, 'drag-end click must not append a landmark');
    assert.notDeepEqual(workspace.getViewState().msi, viewBefore.msi);
    const beforeZoom = workspace.getViewState().msi;
    f.wraps.msi.dispatch('wheel', { ...center, deltaY: -120 }); await f.flush();
    assert.ok(workspace.getViewState().msi.pixelScale > beforeZoom.pixelScale);
    workspace.setViewState({ he: beforeZoom, msi: beforeZoom, sync: true }); await f.flush();
    f.wraps.msi.dispatch('wheel', { ...center, deltaY: -80 }); await f.flush();
    assert.deepEqual(workspace.getViewState().he, workspace.getViewState().msi);
    const savedView = workspace.getViewState();
    // A re-baked / supersampled HE has the same logical geometry and cannot
    // reset an in-progress view. Pure viewport resizing also preserves scale.
    f.images.he.naturalWidth = 900; f.images.he.naturalHeight = 300; f.images.he.dataset.ss = '3';
    f.wraps.he.clientWidth = 700; f.wraps.msi.clientWidth = 700;
    workspace.refresh(); await f.flush();
    assert.deepEqual(workspace.getViewState(), savedView);
    const imgPoint = workspace.clientToImage('he', ...(() => { const r = workspace.getContentRect('he'); return [r.left + r.width * 0.3, r.top + r.height * 0.6]; })());
    closeTo(imgPoint[0], 270); closeTo(imgPoint[1], 180);
    f.card.dispatch('keydown', { key: 'Escape' }); assert.equal(closed, 1);
    assert.ok(changes > 0);
    const changesBeforeDestroy = changes;
    workspace.destroy(); workspace.destroy(); await f.flush();
    assert.equal(f.app.inert, false); assert.equal(f.app.getAttribute('aria-hidden'), null);
    assert.equal(f.priorInert.inert, true); assert.equal(f.priorInert.getAttribute('aria-hidden'), 'false');
    assert.equal(f.doc.body.style.overflow, 'auto'); assert.equal(f.doc.activeElement, f.opener);
    assert.equal(f.card.className, 'modal-card help-card');
    assert.deepEqual(f.wraps.msi.childNodes, oldWrapChildren, 'destroy restores the original nodes in order');
    assert.equal(f.wraps.msi.getAttribute('style'), 'original-wrap');
    assert.equal(f.images.msi.getAttribute('style'), 'original-image');
    assert.equal(f.card.querySelector('.msi-align-content'), null);
    assert.ok(f.observers.every(observer => observer.disconnected));
    f.wraps.msi.dispatch('wheel', { ...center, deltaY: -100 }); await f.flush();
    assert.equal(changes, changesBeforeDestroy, 'destroy removes display listeners and queued updates');
}

async function staleCompositeContract() {
    const f = fixture(), pending = [];
    const workspace = Workspace.mount(f.card, {
        onComposite: ({ canvas, signal, isCurrent }) => new Promise(resolve => { pending.push({ canvas, signal, isCurrent, resolve }); })
    });
    workspace.setViewState({ mode: 'overlay' }); await f.flush();
    assert.equal(pending.length, 1);
    workspace.requestComposite(); await f.flush();
    assert.equal(pending.length, 2); assert.equal(pending[0].signal.aborted, true);
    pending[1].canvas.token = 'new'; pending[1].resolve(); await f.flush();
    const canvas = f.card.querySelector('canvas');
    assert.deepEqual(canvas.getContext().draws, ['new']);
    pending[0].canvas.token = 'stale'; pending[0].resolve(); await f.flush();
    assert.deepEqual(canvas.getContext().draws, ['new'], 'late render cannot overwrite the currently selected molecule');
    workspace.requestComposite(); await f.flush();
    workspace.destroy(); pending[2].resolve(); await f.flush();
    assert.equal(pending[2].isCurrent(), false);
    assert.deepEqual(canvas.getContext().draws, ['new'], 'closed workspace cannot receive a late render');
}

async function delayedImageContract() {
    const f = fixture();
    f.images.he.naturalWidth = 0; f.images.he.naturalHeight = 0;
    f.images.he.width = 640; f.images.he.height = 480;
    const workspace = Workspace.mount(f.card);
    await f.flush();
    assert.equal(workspace.getViewState().he, null, 'CSS fallback size cannot freeze the initial magnification');
    f.images.he.naturalWidth = 3000; f.images.he.naturalHeight = 1000;
    f.images.he.dispatch('load'); await f.flush();
    assert.deepEqual(workspace.getViewState().he, Workspace.fitView(3000, 1000, 640, 480));
    workspace.destroy();
}

(async () => {
    geometryContract();
    await mountedWorkspaceContract();
    await staleCompositeContract();
    await delayedImageContract();
    console.log('MSI alignment workspace regressions: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
