'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'viewer', 'index.html'), 'utf8');

function scanBalanced(source, openAt) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = openAt; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; i++; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced source block');
}

function extractObject(source, marker) {
  const markerAt = source.indexOf(marker);
  assert.notEqual(markerAt, -1, `missing ${marker}`);
  const openAt = source.indexOf('{', markerAt + marker.length);
  // SharePreview is a top-level const and its terminator is the only `};`
  // beginning at column zero inside the declaration. This avoids treating
  // braces in regex literals/template substitutions as structural braces.
  const terminatorAt = source.indexOf('\n};', openAt);
  assert.notEqual(terminatorAt, -1, `missing terminator for ${marker}`);
  return source.slice(openAt, terminatorAt + 2);
}

function extractFunction(source, name) {
  const marker = `async function ${name}`;
  const markerAt = source.indexOf(marker);
  assert.notEqual(markerAt, -1, `missing ${marker}`);
  const openAt = source.indexOf('{', markerAt + marker.length);
  const closeAt = scanBalanced(source, openAt);
  return source.slice(markerAt, closeAt + 1);
}

function compileInlineScripts() {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((source) => source.trim());
  assert.ok(scripts.length >= 2, 'expected inline viewer scripts');
  scripts.forEach((source, index) => new vm.Script(source, {
    filename: `viewer/index.html#inline-${index + 1}`,
  }));
}

function makePreviewContext(extra = {}) {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Map,
    Set,
    ...extra,
  });
  const objectSource = extractObject(html, 'const SharePreview =');
  return { context, preview: vm.runInContext(`(${objectSource})`, context) };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function testFocusLoadAndRaceGuard() {
  const waits = { MSI_A: deferred(), MSI_B: deferred() };
  const panel = {
    imageSources: {},
    ensureMsiLayerLoaded(key) {
      return waits[key].promise.then((ok) => {
        if (ok) this.imageSources[key] = { loaded: true };
        return ok;
      });
    },
    setupCanvasSize() { return false; },
    renderComposite() {},
  };
  const project = {
    sections: [{ id: 's1', msiSeries: {
      MSI_A: { blobId: 'blob-a' },
      MSI_B: { blobId: 'blob-a' },
    } }],
  };
  const App = {
    project,
    panels: new Map([['s1', panel]]),
    focusCompoundKey: null,
    activeOverlay: null,
    setFocusCompoundKey(key) { this.focusCompoundKey = key; this.activeOverlay = null; },
  };
  const { preview } = makePreviewContext({ App });
  const refreshes = [];
  const prefetched = [];
  const progressive = [];
  preview.isOpen = () => true;
  preview.refresh = () => refreshes.push({
    key: App.focusCompoundKey,
    loading: preview._loadingFocusKey,
  });
  preview._showLoadedPreviewCell = (projectArg, key, sectionId) => progressive.push([key, sectionId]);
  preview._cancelAdjacentPrefetch = () => {};
  preview._scheduleAdjacentPrefetch = (key) => prefetched.push(key);

  const loadA = preview._selectCompound('MSI_A');
  assert.deepEqual(refreshes.at(-1), { key: 'MSI_A', loading: 'MSI_A' });
  const loadB = preview._selectCompound('MSI_B');
  assert.deepEqual(refreshes.at(-1), { key: 'MSI_B', loading: 'MSI_B' });

  waits.MSI_B.resolve(true);
  await loadB;
  assert.deepEqual(refreshes.at(-1), { key: 'MSI_B', loading: null });
  assert.deepEqual(prefetched, ['MSI_B']);
  assert.deepEqual(progressive, [['MSI_B', 's1']]);

  waits.MSI_A.resolve(true);
  await loadA;
  assert.equal(App.focusCompoundKey, 'MSI_B');
  assert.deepEqual(refreshes.at(-1), { key: 'MSI_B', loading: null });
  assert.deepEqual(prefetched, ['MSI_B'], 'late MSI_A completion must not win');
  assert.deepEqual(progressive, [['MSI_B', 's1']], 'late MSI_A must not repaint a cell');
}

async function testFailedLoadStaysExplicit() {
  const panel = {
    imageSources: {},
    async ensureMsiLayerLoaded() { return false; },
    setupCanvasSize() { return false; },
    renderComposite() {},
  };
  const project = { sections: [{ id: 's1', msiSeries: { MSI_A: { blobId: 'bad' } } }] };
  const App = {
    project,
    panels: new Map([['s1', panel]]),
    focusCompoundKey: null,
    activeOverlay: null,
    setFocusCompoundKey(key) { this.focusCompoundKey = key; },
  };
  const { preview } = makePreviewContext({ App });
  preview.isOpen = () => true;
  preview.refresh = () => {};
  preview._cancelAdjacentPrefetch = () => {};
  preview._scheduleAdjacentPrefetch = () => { throw new Error('failed load must not prefetch'); };
  preview._showLoadedPreviewCell = () => {};
  await preview._selectCompound('MSI_A');
  assert.equal(preview._loadingFocusKey, 'MSI_A');
  assert.equal(preview._focusLoadStatus.get('s1'), 'failed');
}

class FakeElement {
  constructor() { this.listeners = new Map(); this.value = ''; this.disabled = false; }
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  fire(type) { this.listeners.get(type)(); }
}

function testRangeResetAndSingleRepaint() {
  const min = new FakeElement();
  const max = new FakeElement();
  const reset = new FakeElement();
  const bySelector = new Map([
    ['[data-preview-range-min]', min],
    ['[data-preview-range-max]', max],
    ['[data-preview-range-reset]', reset],
  ]);
  const panels = [0, 1].map(() => ({
    renders: 0,
    renderComposite() { this.renders++; },
    msiThumbRefs: new Set(),
  }));
  const raf = [];
  const App = {
    focusCompoundKey: 'MSI_A',
    msiUserWindow: { MSI_A: { min: 2, max: 8 } },
    panels: new Map([['s1', panels[0]], ['s2', panels[1]]]),
    project: {},
  };
  const { preview } = makePreviewContext({
    App,
    Toolbar: { refreshRange() {} },
    requestAnimationFrame(fn) { raf.push(fn); return raf.length; },
    cancelAnimationFrame() {},
  });
  preview.overlay = { querySelector(selector) { return bySelector.get(selector) || null; } };
  preview._refreshRangeInputs = () => {};
  preview._rebakeCellImages = () => {};
  preview._wireRangeInputs();

  reset.fire('click');
  assert.equal(App.msiUserWindow.MSI_A, undefined);
  assert.deepEqual(panels.map((panel) => panel.renders), [1, 1]);
  raf.shift()();

  min.value = '3.5';
  min.fire('change');
  assert.equal(App.msiUserWindow.MSI_A.min, 3.5);
  assert.deepEqual(panels.map((panel) => panel.renders), [2, 2],
    'one Range change should repaint each panel exactly once');
}

async function testWorkerXlsxDecodeCache() {
  let arrayBufferCalls = 0;
  let parseCalls = 0;
  const extractedColumns = [];
  const posts = [];
  const self = { postMessage(message) { posts.push(message); } };
  const context = vm.createContext({
    self,
    parseXlsxSheet() { parseCalls++; return { aoa: [[1, 2, 3]] }; },
    rowsFromParsedXlsx(parsed, def) { extractedColumns.push(def.col_v); return [{ x: 0, y: 0, v: 1 }]; },
    parseTxtToRows() { throw new Error('not used'); },
    computeRasterPixels() {
      return {
        width: 1, height: 1,
        pixels: new Uint8ClampedArray(4), values: new Float32Array([1]),
        rawRange: [0, 1], rawMean: 1, rawTrueMax: 1, rawDispMax: 1, diag: {},
      };
    },
    async _encodePixelsToDataUrl() { return 'data:image/png;base64,test'; },
    decodeTiffArrayBufferToDataUrl() {},
    inspectXlsxColumns() {},
    Map,
  });
  const fnSource = extractFunction(html, '_parseWorkerOnMessage');
  vm.runInContext(`${fnSource}; self.handler = _parseWorkerOnMessage;`, context);
  const blob = { async arrayBuffer() { arrayBufferCalls++; return new ArrayBuffer(1); } };
  await self.handler({ data: { id: 1, op: 'xlsx-raster', payload: {
    blob, cacheKey: 'blob-1|Sheet1', def: { col_v: 'C' },
  } } });
  await self.handler({ data: { id: 2, op: 'xlsx-raster', payload: {
    blob, cacheKey: 'blob-1|Sheet1', def: { col_v: 'D' },
  } } });

  assert.equal(arrayBufferCalls, 1, 'cache hit should skip Blob.arrayBuffer');
  assert.equal(parseCalls, 1, 'cache hit should skip XLSX sheet decoding');
  assert.deepEqual(extractedColumns, ['C', 'D']);
  assert.equal(posts.length, 2);
  assert.ok(posts.every((entry) => entry.ok));
}

async function main() {
  compileInlineScripts();
  assert.match(html, /data-preview-range-reset/);
  assert.doesNotMatch(html, /data-organ-select/);
  assert.match(html, /parseXlsxSheet, rowsFromParsedXlsx, parseXlsxToRows/);
  await testFocusLoadAndRaceGuard();
  await testFailedLoadStaysExplicit();
  testRangeResetAndSingleRepaint();
  await testWorkerXlsxDecodeCache();
  console.log('viewer preview regression tests: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
