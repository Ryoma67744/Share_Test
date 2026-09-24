'use strict';
// Real picker events, ROI/MRM edit paths, publish payload and ZIP metadata
// round trips. The DOM and ZIP byte container are test doubles: no browser
// painting, archive compression or remote writes are claimed by this suite.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { html } = require('./viewer-runtime.cjs');
const { dom, loadFixedColors, sourceFunction, defaultPaletteSource } = require('./fixed-colors-runtime.cjs');
const plain = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const d = dom();
  const saved = new Map();
  const counters = { save: 0, redraw: 0, analysis: 0, errors: [] };
  const App = {
    project: null, shareMode: null, activeSectionId: null, panels: new Map(),
    redrawAllRois() { counters.redraw++; }, renderAnalysis() { counters.analysis++; },
    queueSave() { counters.save++; },
    async _flushSave() { saved.set(this.project.id, structuredClone(this.project)); return true; },
    _showSaveError(...args) { counters.errors.push(args); },
  };
  const ProjectStorage = {
    async getProject(id) { return structuredClone(saved.get(id)); },
    async putProject(project) { saved.set(project.id, structuredClone(project)); },
    async getBlob() { return { blob: 'original MSI bytes' }; },
    async putBlob() {},
  };
  const context = vm.createContext({ console, setTimeout, clearTimeout, structuredClone,
    ...d, App, ProjectStorage });
  const FixedColors = loadFixedColors(context);
  vm.runInContext(defaultPaletteSource() + '\n' + [
    'pickUnusedColorKey', 'storeRoiPaletteColor', 'roiFixedColorEditable', 'setRoiFixedColor',
    'openRoiFixedColorPicker', 'populateRoiList', 'encodeRoiPolygon', 'decodeRoiPolygon',
    'groupRoiRowsByColor', 'remapRoiGeometry', 'freezeMsiSourceReferences',
    '_markerTargetIsCurrent', '_openSharedMarkerInput', 'applyMarkerColor',
    '_setMarkerSwatchLabel', '_restampMarkerSwatch', '_refreshKmdMarkerColor', '_bindMethodRowDelegation',
  ].map(sourceFunction).join('\n'), context);
  for (const id of ['roi-list', 'method-rows', 'graph-container']) {
    const node = d.element(id === 'method-rows' ? 'tbody' : 'div'); node.id = id; d.document.body.append(node);
  }
  return { ...d, context, App, saved, counters, FixedColors };
}

function pickerTests() {
  const f = fixture(), { FixedColors: colors, document, dispatch, element } = f;
  assert.deepEqual(plain(colors.colors).map(color => color.hex), [
    '#0173B2', '#DE8F05', '#029E73', '#D55E00', '#CC78BC',
    '#CA9161', '#FBAFE4', '#949494', '#ECE133', '#56B4E9',
  ]);
  assert.equal(new Set(colors.colors.map(color => color.hex)).size, 10);
  assert.equal(new Set(colors.colors.map(color => color.name)).size, 10);
  assert.ok(colors.isPreset('#0173b2'));
  assert.equal(colors.isPreset('#123456'), false);
  assert.deepEqual(plain(colors.toRgba('#0173b2')), [1, 115, 178, 255]);
  const anchor = element('button'); document.body.append(anchor);
  const choices = [];
  const open = (extras = {}) => colors.open({ anchor, value: '#0173b2', onSelect: value => choices.push(value), ...extras });
  assert.equal(open(), true);
  const panel = document.getElementById('fixed-colors-picker');
  const buttons = panel.querySelectorAll('.fixed-colors-option');
  assert.equal(buttons.length, 10);
  assert.equal(panel.querySelectorAll('input').length, 0, 'no unconstrained native color input');
  assert.equal(buttons.filter(button => button.getAttribute('aria-pressed') === 'true').length, 1);
  assert.equal(document.activeElement, buttons[0]);
  dispatch(buttons[0], 'keydown', { key: 'ArrowDown' });
  assert.equal(document.activeElement, buttons[5], 'keyboard moves one row in the 2 x 5 grid');
  dispatch(buttons[5], 'keydown', { key: 'End' });
  assert.equal(document.activeElement, buttons[9]);
  dispatch(buttons[9], 'keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(document.activeElement, anchor);
  assert.deepEqual(choices, [], 'Escape does not recolor');
  open(); dispatch(document.body, 'pointerdown');
  assert.equal(panel.hidden, true, 'outside click closes');
  assert.deepEqual(choices, []);
  open({ value: '#123456' });
  assert.match(panel.querySelector('.fixed-colors-current').children[1].textContent, /カスタム/);
  assert.equal(buttons.filter(button => button.getAttribute('aria-pressed') === 'true').length, 0);
  panel.querySelector('.fixed-colors-clear').click();
  assert.deepEqual(choices, [], 'ROI cannot clear via a hidden clear action');
  buttons[2].click();
  assert.deepEqual(choices, ['#029E73']);
  open({ allowClear: true }); panel.querySelector('.fixed-colors-clear').click();
  assert.deepEqual(choices, ['#029E73', null]);
  let live = true;
  open({ isValid: () => live }); live = false; buttons[1].click();
  assert.equal(choices.length, 2, 'stale target cannot apply a choice');
  open(); anchor.remove(); buttons[1].click();
  assert.equal(choices.length, 2, 'virtualized/removed anchor cannot apply a choice');
  document.body.append(anchor);
  for (let i = 0; i < 20; i++) { open(); colors.close(); }
  assert.equal(document.querySelectorAll('#fixed-colors-picker').length, 1, 'one reusable popup');
  assert.equal(document.querySelectorAll('#fixed-colors-style').length, 1, 'styles installed once');
}

async function roiTests() {
  const f = fixture(), { App, context: c, counters, FixedColors } = f;
  const originalPalette = { custom: { name: 'Original anatomy', rgba: [12, 34, 56, 111], extra: 'keep' } };
  const geometry = { version: 'msi-source-v1', sourceRef: 'original source', displayGeometry: { W: 2, H: 2 } };
  const makeRoi = (id, colorKey) => ({ id, colorKey, name: id, rgba: [12, 34, 56, 111],
    polysBySection: { sec1: [[0, 0], [1, 0], [0, 1]] }, geometryBySection: { sec1: geometry } });
  const project = { id: 'project1', sections: [{ id: 'sec1', msiSeries: {} }], anatomyPalette: originalPalette,
    rois: [makeRoi('one', 'custom'), makeRoi('two', 'different')], roiHidden: { one: true } };
  App.project = project;
  const polygonsBefore = JSON.stringify(project.rois.map(roi => [roi.polysBySection, roi.geometryBySection]));
  const otherProject = { anatomyPalette: originalPalette };
  c.populateRoiList();
  const swatch = f.document.getElementById('roi-list').children[0].querySelector('.color-swatch');
  const activeBefore = App.activeRoiId;
  swatch.click();
  assert.equal(App.activeRoiId, activeBefore, 'swatch click does not activate the ROI row');
  const popup = f.document.getElementById('fixed-colors-picker');
  assert.equal(popup.hidden, false, 'ROI list swatch opens real picker');
  FixedColors.close();
  assert.deepEqual(project.rois[0].rgba, [12, 34, 56, 111], 'opening custom color leaves it unchanged');
  assert.equal(await c.setRoiFixedColor(project, project.rois[0], '#0173B2'), true);
  assert.equal(await c.setRoiFixedColor(project, project.rois[1], '#0173B2'), true);
  assert.notEqual(project.anatomyPalette, originalPalette, 'palette cloned before mutation');
  assert.notEqual(project.anatomyPalette.custom, originalPalette.custom, 'entry cloned before mutation');
  assert.deepEqual(otherProject.anatomyPalette.custom.rgba, [12, 34, 56, 111]);
  assert.equal(project.anatomyPalette.custom.extra, 'keep');
  assert.deepEqual(project.rois.map(roi => roi.colorKey), ['custom', 'different']);
  assert.equal(project.rois.length, 2, 'same display color does not merge identities');
  assert.equal(JSON.stringify(project.rois.map(roi => [roi.polysBySection, roi.geometryBySection])), polygonsBefore,
    'recolor leaves source geometry and polygons untouched');
  assert.deepEqual(project.roiHidden, { one: true });
  assert.equal(counters.errors.length, 0);
  const reopened = await c.ProjectStorage.getProject(project.id);
  assert.deepEqual(plain(reopened.rois.map(roi => roi.rgba)), [[1, 115, 178, 255], [1, 115, 178, 255]]);
  assert.deepEqual(plain(reopened.anatomyPalette.different.rgba), [1, 115, 178, 255]);

  const saves = counters.save;
  assert.equal(await c.setRoiFixedColor(project, project.rois[0], '#123456'), false);
  App.shareMode = { token: 'test' };
  assert.equal(await c.setRoiFixedColor(project, project.rois[0], '#029E73'), false);
  c.populateRoiList();
  assert.equal(f.document.getElementById('roi-list').children[0].querySelector('.color-swatch').disabled, true);
  App.shareMode = null; project.__share = true;
  assert.equal(c.roiFixedColorEditable(project, project.rois[0]), false);
  delete project.__share; project.rois[0]._collab = true;
  assert.equal(await c.setRoiFixedColor(project, project.rois[0], '#029E73'), false);
  delete project.rois[0]._collab;
  App.project = { ...project };
  assert.equal(await c.setRoiFixedColor(project, project.rois[0], '#029E73'), false);
  App.project = project;
  assert.equal(counters.save, saves, 'invalid/readonly/stale edits never save');

  const realRedraw = App.redrawAllRois;
  const warnings = [];
  c.console = { ...console, warn: (...args) => warnings.push(args) };
  App.redrawAllRois = () => { throw new Error('Simulated renderer failure'); };
  assert.equal(await c.setRoiFixedColor(project, project.rois[0], '#029E73'), true,
    'display failure does not interrupt color persistence/readback');
  assert.deepEqual(plain((await c.ProjectStorage.getProject(project.id)).rois[0].rgba), [2, 158, 115, 255]);
  assert.equal(counters.save, saves + 1);
  assert.equal(counters.errors.length, 0);
  assert.ok(warnings.length > 0, 'renderer failure remains observable');
  App.redrawAllRois = realRedraw;
  await c.setRoiFixedColor(project, project.rois[0], '#0173B2');

  const blank = { id: 'empty', anatomyPalette: {}, rois: [], sections: [] };
  for (let i = 0; i < 12; i++) {
    const def = c.pickUnusedColorKey(blank);
    blank.rois.push({ id: 'created' + i, colorKey: def.key, rgba: def.rgba });
    c.storeRoiPaletteColor(blank, blank.rois.at(-1));
  }
  assert.equal(new Set(blank.rois.map(roi => roi.colorKey)).size, 12);
  assert.equal(new Set(blank.rois.map(roi => JSON.stringify(roi.rgba))).size, 10);
  assert.deepEqual(plain(blank.rois[0].rgba), plain(blank.rois[10].rgba), 'palette cycles after ten');
  blank.rois.splice(2, 1);
  assert.equal(c.pickUnusedColorKey(blank).key, 'ROI_13', 'deleted key in saved palette is not reused');
  const defNamed = c.pickUnusedColorKey({ rois: [], anatomyPalette: originalPalette });
  assert.equal(defNamed.key, 'custom', 'existing named anatomy entry is retained');
  assert.deepEqual(plain(defNamed.rgba), [12, 34, 56, 111]);
  const shared = { __share: true, rois: [], anatomyPalette: {} };
  for (let i = 0; i < 22; i++) {
    const def = c.pickUnusedColorKey(shared, true);
    shared.rois.push({ colorKey: def.key });
    const wire = c.groupRoiRowsByColor([{ id: 'wire', color_key: def.key, section_id: 'sec', poly_msi: [] }], {});
    assert.deepEqual(plain(wire[0].rgba), plain(def.rgba), 'shared allocation hydrates with the same color');
  }
  shared.rois.splice(0, 1);
  const nextShared = c.pickUnusedColorKey(shared, true);
  assert.equal(shared.rois.some(roi => roi.colorKey === nextShared.key), false);

  // Execute the production publish payload builder, with no remote request.
  c.project = project; c.meta = { slug: 'test', viewerPassword: 'fixture' };
  c.masterPw = 'fixture'; c.sectionsPayload = [];
  const start = html.indexOf('    const roisPayload =', html.indexOf('async function _publishCoreInner('));
  const end = html.indexOf('    let result;', start);
  assert.ok(start > 0 && end > start);
  const payload = vm.runInContext('(function(){\n' + html.slice(start, end) + '\nreturn args;})()', c);
  const wireRows = plain(payload._rois).map((row, i) => ({ id: 'server' + i,
    section_id: row.sectionId, color_key: row.colorKey, name: row.name, poly_msi: row.polyMsi }));
  const hydrated = c.groupRoiRowsByColor(wireRows, plain(payload._meta.anatomyPalette));
  assert.equal(hydrated.length, 2);
  assert.deepEqual(plain(hydrated.map(roi => roi.colorKey)), ['custom', 'different']);
  assert.deepEqual(plain(hydrated.map(roi => roi.rgba)), [[1, 115, 178, 255], [1, 115, 178, 255]]);
  assert.deepEqual(plain(hydrated[0].geometryBySection.sec1), geometry);
  return { f, project };
}

function mrmTests() {
  const f = fixture(), { App, context: c, document, element, counters, dispatch } = f;
  const key = 'MSI_A "quoted"';
  const section = { id: 's1', msiSeries: { [key]: { markerColor: '#123456', compoundMeta: { name: 'Renamed compound' } }, MSI_B: {} } };
  const otherSection = { id: 's2', msiSeries: { [key]: { markerColor: '#D55E00' } } };
  const project = { id: 'mrm', sections: [section, otherSection], anatomyPalette: {}, rois: [] };
  let outlines = 0, layerBars = 0, scatterDraws = 0;
  const panel = { project, section, refreshMarkerOutline() { outlines++; }, rebuildLayerBar() { layerBars++; },
    handleLayerClick() { throw new Error('Swatch click activated compound'); } };
  App.project = project; App.activeSectionId = section.id; App.panels.set(section.id, panel);
  const tbody = document.getElementById('method-rows');
  const row = element('tr'); row.className = 'method-row'; row.dataset.layerKey = key;
  const swatch = element('button'); swatch.className = 'marker-swatch'; row.append(swatch); tbody.append(row);
  c._bindMethodRowDelegation(tbody);
  swatch.click();
  const popup = document.getElementById('fixed-colors-picker');
  assert.equal(popup.hidden, false, 'Method row delegates to real picker');
  assert.match(popup.querySelector('.fixed-colors-current').children[1].textContent, /カスタム/);
  assert.match(popup.querySelector('.fixed-colors-note').textContent, /この切片のみ/);
  f.FixedColors.close();
  assert.equal(section.msiSeries[key].markerColor, '#123456');
  c.applyMarkerColor(panel, key, '#029E73');
  assert.equal(section.msiSeries[key].markerColor, '#029E73');
  assert.equal(otherSection.msiSeries[key].markerColor, '#D55E00');
  assert.equal(section.msiSeries.MSI_B.markerColor, undefined);
  assert.equal(section.msiSeries[key].compoundMeta.name, 'Renamed compound');
  assert.match(swatch.style.cssText, /#029E73/);
  assert.match(swatch.getAttribute('aria-label'), /緑/);
  assert.equal(counters.save, 1); assert.equal(outlines, 1); assert.equal(layerBars, 1);
  c.applyMarkerColor(panel, key, '#abcdef');
  assert.equal(section.msiSeries[key].markerColor, '#029E73');
  dispatch(swatch, 'click', { shiftKey: true });
  assert.equal(Object.hasOwn(section.msiSeries[key], 'markerColor'), false);
  assert.match(swatch.getAttribute('aria-label'), /色なし/);
  c.applyMarkerColor(panel, key, '#0173B2');
  dispatch(swatch, 'contextmenu');
  assert.equal(Object.hasOwn(section.msiSeries[key], 'markerColor'), false);

  const choose = () => popup.querySelectorAll('.fixed-colors-option')[4].click();
  swatch.click(); App.activeSectionId = 's2'; choose();
  assert.equal(section.msiSeries[key].markerColor, undefined, 'section change invalidates open picker');
  App.activeSectionId = 's1'; swatch.click();
  const original = section.msiSeries[key]; section.msiSeries[key] = { markerColor: '#CA9161' }; choose();
  assert.equal(section.msiSeries[key].markerColor, '#CA9161', 'replacement layer rejects stale popup');
  section.msiSeries[key] = original;
  swatch.click(); row.remove(); choose();
  assert.equal(original.markerColor, undefined, 'virtualized row cannot apply stale choice');
  tbody.append(row); swatch.click(); App.project = { ...project }; choose();
  assert.equal(original.markerColor, undefined, 'project change invalidates popup'); App.project = project;
  swatch.click(); App.panels.set('s1', {}); choose();
  assert.equal(original.markerColor, undefined, 'recreated panel invalidates popup'); App.panels.set('s1', panel);

  document.body.classList.add('share-mode'); const saves = counters.save;
  swatch.click(); assert.match(popup.querySelector('.fixed-colors-note').textContent, /再読込/); choose();
  assert.equal(original.markerColor, '#CC78BC');
  assert.equal(counters.save, saves, 'shared marker choice is temporary and does not queue persistence');
  document.body.classList.remove('share-mode');
  const graph = document.getElementById('graph-container');
  const canvas = element('canvas'); canvas.className = 'kmd-scatter'; graph.append(canvas);
  graph._lastKmd = { points: [{ key, markerColor: original.markerColor }, { key: 'MSI_B', markerColor: null }] };
  c.drawKmdScatter = () => { scatterDraws++; }; App.analysisMode = 'kmd';
  c.applyMarkerColor(panel, key, '#DE8F05');
  assert.equal(graph._lastKmd.points[0].markerColor, '#DE8F05');
  c.applyMarkerColor(panel, key, null);
  assert.equal(graph._lastKmd.points[0].markerColor, '#D55E00', 'KMD falls back to next marked section');
  assert.equal(scatterDraws, 2);
  assert.equal(graph._lastKmd.points[1].markerColor, null);
  const beforeFailureSave = counters.save;
  c.console = { ...console, warn() {} };
  c.drawKmdScatter = () => { throw new Error('Simulated KMD canvas failure'); };
  assert.doesNotThrow(() => c.applyMarkerColor(panel, key, '#0173B2'));
  assert.equal(original.markerColor, '#0173B2');
  assert.equal(counters.save, beforeFailureSave + 1, 'MRM change is queued before a failing repaint');
  return f;
}

async function zipRoundTrip({ f, project }) {
  const c = f.context;
  // Real export/import functions write/read the metadata. Only ZIP compression
  // and binary image parsing are replaced, because neither defines color state.
  let bundle, imported, nextId = 0;
  class ZipContainer {
    constructor() { this.files = {}; }
    file(name, data) {
      if (arguments.length === 2) { this.files[name] = data; return this; }
      if (!Object.hasOwn(this.files, name)) return null;
      return { async: async () => this.files[name] };
    }
    async generateAsync() { return this; }
    static async loadAsync(value) { return value; }
  }
  Object.assign(c, {
    JSZip: ZipContainer, LAZY_LIBS: { jszip: 'test' }, loadScript: async () => {},
    safeName: value => value, ensureMemoShape: value => value || {},
    sanitizeStorageKeySegment: value => value, buildSampleCsvGroups: async () => [],
    _yieldUi: async () => {}, openPublishProgressModal: () => ({ update() {}, close() {} }),
    downloadAsFile: value => { bundle = value; }, showToast() {},
    alert: message => { throw new Error(message); }, uid: prefix => prefix + (++nextId),
    nowIso: () => '2026-09-24T00:00:00.000Z', guessMimeFromPath: () => 'application/octet-stream',
  });
  project.displayName = 'Color regression';
  project.sections[0].msiSeries.MSI_A = { kind: 'txt', blobId: 'blob1', filename: 'source.txt',
    sourceReference: 'test-source', markerColor: '#029E73', compoundMeta: { name: 'Renamed compound' } };
  project.sections[0].msiSeries.MSI_custom = { kind: 'txt', blobId: 'blob1', filename: 'source.txt',
    sourceReference: 'test-source', markerColor: '#123456' };
  c.App.project = project;
  c.App.openProject = async id => { imported = await c.ProjectStorage.getProject(id); };
  vm.runInContext('let _exportInProgress = false;\n' + ['exportProjectAsZip', 'importZipFile'].map(sourceFunction).join('\n'), c);
  await c.exportProjectAsZip();
  assert.ok(bundle, 'production exporter completed');
  await c.importZipFile(bundle);
  assert.equal(imported.rois.length, 2);
  assert.deepEqual(plain(imported.rois.map(roi => roi.colorKey)), ['custom', 'different']);
  assert.deepEqual(plain(imported.rois.map(roi => roi.rgba)), [[1, 115, 178, 255], [1, 115, 178, 255]]);
  assert.deepEqual(plain(imported.anatomyPalette.custom.rgba), [1, 115, 178, 255]);
  assert.deepEqual(plain(Object.values(imported.rois[0].polysBySection)[0]), [[0, 0], [1, 0], [0, 1]]);
  assert.equal(imported.sections[0].msiSeries.MSI_A.markerColor, '#029E73');
  assert.equal(imported.sections[0].msiSeries.MSI_A.compoundMeta.name, 'Renamed compound');
  assert.equal(imported.sections[0].msiSeries.MSI_custom.markerColor, '#123456');
}

(async () => {
  pickerTests();
  const roi = await roiTests();
  mrmTests();
  await zipRoundTrip(roi);
  console.log('Fixed color regression: PASS (picker, ROI identity/persistence, MRM targets, publish/ZIP metadata)');
})().catch(error => { console.error(error); process.exitCode = 1; });
