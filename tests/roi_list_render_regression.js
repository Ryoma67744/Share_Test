'use strict';
// Exercise the actual multi-section ROI renderer during finalizeDrawing.
// The ROI exists on one section only; the other section must be skipped before
// its polygon is transformed, otherwise finalizeDrawing aborts before the list
// is populated and before IndexedDB is written.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { html, standalone } = require('./viewer-runtime.cjs');

function element() {
  const node = {
    children: [], dataset: {}, style: {}, textContent: '',
    classList: { add() {}, remove() {} },
    addEventListener() {}, appendChild(child) { this.children.push(child); },
    querySelectorAll() { return []; },
    _html: '',
  };
  Object.defineProperty(node, 'innerHTML', {
    get() { return this._html; },
    set(value) { this._html = value; this.children = []; },
  });
  return node;
}

async function main() {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: element,
  };
  const saved = new Map();
  const ProjectStorage = {
    async putProject(project) { saved.set(project.id, structuredClone(project)); },
    async getProject(id) { return structuredClone(saved.get(id)); },
  };
  const panelStart = html.indexOf('class SectionPanel {');
  const panelEnd = html.indexOf('\n}\n', panelStart) + 2;
  const appStart = html.indexOf('const App = {');
  const appEnd = html.indexOf('\n};', appStart) + 3;
  assert.ok(panelStart >= 0 && panelEnd > panelStart && appStart >= 0 && appEnd > appStart);
  const context = vm.createContext({
    console, document, ProjectStorage, setTimeout, clearTimeout, structuredClone,
    Map, Set, uid: () => 'roi-new', prompt: () => 'Cortex',
    showToast: () => {}, updateAnalysisModeUi: () => {},
    // The real renderer receives the identity transform in this two-section
    // fixture. Its polygon lookup and iteration are deliberately unmocked.
    applyAffinePoint: (_matrix, x, y) => [x, y],
    msiSourceReference: () => 'source-one',
    msiAxisInterpolate: (_axis, value) => value,
  });
  vm.runInContext([
    ...['pickUnusedColorKey', 'msiValidRoiGeometry', 'msiRoiGeometryMeta',
      'msiLayerSourceGeometry', 'roiPolygonForDisplay', 'populateRoiList'].map(standalone),
    html.slice(panelStart, panelEnd),
    html.slice(appStart, appEnd),
    'globalThis.testApp = App; globalThis.TestPanel = SectionPanel;',
  ].join('\n'), context);
  const app = context.testApp;
  const sourceGeometry = {
    sourceRef: 'source-one',
    displayGeometry: {
      version: 'msi-proportional-v1', W: 4, H: 4,
      x: { origin: 0, step: 1 }, y: { origin: 0, step: 1 },
    },
    legacy: { confirmed: true, x: [[0, 0], [3, 3]], y: [[0, 0], [3, 3]] },
  };
  const sections = ['first', 'second'].map(id => ({ id, msiSeries: { MSI_A: {} } }));
  const project = {
    id: 'project-a', rois: [], sections,
    anatomyPalette: { red: { name: 'Red', rgba: [255, 0, 0, 255] } },
  };
  app.project = project;
  app.activeSectionId = 'first';
  app.panels = new Map(sections.map(section => {
    const panel = Object.create(context.TestPanel.prototype);
    const roiCtx = {
      paths: [], clearRect() {}, beginPath() { this.path = []; },
      moveTo(x, y) { this.path.push([x, y]); },
      lineTo(x, y) { this.path.push([x, y]); },
      closePath() {}, stroke() { this.paths.push(this.path); },
    };
    Object.assign(panel, {
      section, project, roiCtx, dom: { croi: { width: 4, offsetWidth: 4, style: {} } },
      msiValueRasters: new Map([['MSI_A', { sourceGeometry }]]),
      _pickRefMsiKey: () => 'MSI_A', _msiRoiCanvasMatrix: () => null,
      setDrawingPointerActive() {}, renderComposite() {},
    });
    return [section.id, panel];
  }));
  app.renderAnalysis = () => {};
  app.sectionVisibility = () => ({ flushDeferred() {} });
  app._setSyncStatus = () => {};
  app._scheduleAutoPublish = () => {};
  document.getElementById('roi-list').innerHTML = '<p>No ROI yet.</p>';
  document.getElementById('roi-toggle').checked = true;

  await app.startDrawing(null);
  app.drawing.vertices = [[0, 0], [3, 0], [0, 3]];
  await app.finalizeDrawing();
  assert.equal(app.drawing.mode, false, 'drawing was finalized');
  assert.equal(document.getElementById('roi-draw-toggle').textContent, '+ 新規');
  assert.equal(project.rois.length, 1);
  assert.equal(document.getElementById('roi-list').children.length, 1,
    'ROI_LIST shows the new polygon despite an undrawn second section');
  assert.ok(app.panels.get('first').roiCtx.paths.length >= 1,
    'first section used the real ROI renderer to draw its polygon');
  assert.equal(app.panels.get('second').roiCtx.paths.length, 0,
    'second section has no ROI outline');
  assert.equal(saved.get('project-a').rois.length, 1,
    'the drawing reached persistence after updating the list');
  assert.equal(context.roiPolygonForDisplay(project.rois[0], sections[1], 'MSI_A', undefined), null,
    'polygon conversion treats an undrawn section as absent');
  assert.equal(context.roiPolygonForDisplay(project.rois[0], sections[1], 'MSI_A', []), null,
    'an empty polygon is also absent');

  const reloaded = await ProjectStorage.getProject('project-a');
  assert.equal(reloaded.rois[0].name, 'Cortex');
  app.project = reloaded;
  for (const panel of app.panels.values()) {
    panel.project = reloaded;
    panel.section = reloaded.sections.find(section => section.id === panel.section.id);
    panel.roiCtx.paths = [];
  }
  document.getElementById('roi-list').innerHTML = '<p>No ROI yet.</p>';
  context.populateRoiList();
  app.redrawAllRois();
  assert.equal(document.getElementById('roi-list').children.length, 1,
    'saved ROI is listed after a fresh project read');
  assert.equal(app.panels.get('first').roiCtx.paths.length, 1,
    'saved polygon renders on its own section');
  assert.equal(app.panels.get('second').roiCtx.paths.length, 0,
    'saved polygon leaves the other section empty');
  console.log('ROI list render regression: PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
