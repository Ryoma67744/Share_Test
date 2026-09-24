'use strict';
// A previously saved ROI on only one section must not abort openProject while
// Compound mode turns on the focus MSI in another section. Exercise the real
// openProject -> toggleLayer -> drawAllRois -> roiPolygonForDisplay path.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { html, standalone } = require('./viewer-runtime.cjs');

const { element, geometryGlobals, roiDom } = require('./roi-dom.cjs');

async function main() {
  const nodes = new Map();
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: element,
    createElementNS: (_namespace, tag) => element(tag),
  };
  document.getElementById('roi-toggle').checked = true;
  document.getElementById('roi-list').innerHTML = 'No ROI yet.';
  document.getElementById('analysis-scope').textContent = '0 section(s) total';
  const sections = ['left', 'right'].map(id => ({
    id, msiSeries: { MSI_focus: {}, MSI_other: {} },
  }));
  const savedProject = {
    id: 'project-a', displayName: 'Project A', sections, meta: {},
    anatomyPalette: { Red: { name: 'Red', rgba: [255, 0, 0, 255] } },
    rois: [{ id: 'roi-right', name: 'Right ROI', colorKey: 'Red',
      rgba: [255, 0, 0, 255], polysBySection: { right: [[0, 0], [2, 0], [0, 2]] } }],
  };
  const context = vm.createContext({
    console, document, ...geometryGlobals, Map, Set, setTimeout, clearTimeout,
    ProjectStorage: { getProject: async () => structuredClone(savedProject) },
    SharePreview: { isOpen: () => false },
    _roiRawGridCache: new Map(), parquetReleaseAll() {},
    ensureMemoShape: value => value || {}, backfillLegacyCompoundMeta() {},
    localStorage: { setItem() {}, removeItem() {} },
    COLORMAPS: {}, _activeColormapName: 'viridis',
    setupGraphSelector() {}, renderMemoForm() {}, _refreshMethodRowState() {},
    // Fixed, valid MSI geometry lets the real converter reach the polygon
    // iteration. The left section intentionally has no polygon to convert.
    msiLayerSourceGeometry: () => ({ sourceRef: 'source-one',
      legacy: { confirmed: true, x: [[0, 0], [2, 2]], y: [[0, 0], [2, 2]] } }),
    msiRoiGeometryMeta: () => null,
    msiSourceReference: () => 'source-one',
    msiLegacyRasterPointToDisplay: (_section, _key, point) => point,
    applyAffinePoint: (_matrix, x, y) => [x, y],
  });
  const panelStart = html.indexOf('class SectionPanel {');
  const appStart = html.indexOf('const App = {');
  assert.ok(panelStart >= 0 && appStart >= 0);
  vm.runInContext([
    standalone('roiPolygonForDisplay'),
    standalone('populateRoiList'),
    html.slice(panelStart, html.indexOf('\n}\n', panelStart) + 2),
    html.slice(appStart, html.indexOf('\n};', appStart) + 3),
    'globalThis.TestPanel = SectionPanel; globalThis.testApp = App;',
  ].join('\n'), context);
  const app = context.testApp;
  app.viewMode = 'compound';
  app.focusCompoundKey = 'MSI_focus';
  app._flushSave = async () => true;
  app.sectionVisibility = () => ({ ensure() {} });
  app.refreshProjectPicker = async () => {};
  app.refreshShareInfoButton = () => {};
  app.renderAnalysis = () => {};
  function panel(section) {
    const p = Object.create(context.TestPanel.prototype);
    const roiCtx = { clearRect() {} };
    Object.assign(p, {
      section, project: null, roiCtx,
      dom: roiDom(100, 100),
      imageSources: { MSI_focus: {} }, visibleLayers: new Set(['MSI_other']),
      imageSettings: {}, _pickRefMsiKey: () => 'MSI_focus',
      _msiRoiCanvasMatrix: () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
      _persistVisibleLayers() {}, rebuildLayerBar() {}, renderComposite() {},
      refreshThumbHighlights() {}, refreshRangeEditor() {}, refreshActiveOutline() {},
    });
    return p;
  }
  app.panels = new Map(sections.map(section => [section.id, panel(section)]));
  // Full image parsing needs browser resources. The panels above represent
  // loaded MSI layers; the rest of openProject and panel rendering are real.
  app.rebuildSectionPanels = async () => {
    for (const p of app.panels.values()) {
      p.project = app.project;
      p.section = app.project.sections.find(section => section.id === p.section.id);
    }
    document.getElementById('section-count').textContent = '2 sections';
    app.activeSectionId = 'left';
  };

  await app.openProject('project-a');
  assert.equal(document.getElementById('section-count').textContent, '2 sections');
  assert.equal(document.getElementById('roi-list').children.length, 1,
    'saved ROI is listed after the Compound focus is enabled on both sections');
  assert.equal(document.getElementById('analysis-scope').textContent, '2 section(s) total',
    'analysis scope is initialized after opening the project');
  assert.equal(app.panels.get('left').dom.roiSaved.children.length, 0,
    'undrawn left section has no ROI outline');
  assert.equal(app.panels.get('right').dom.roiSaved.children.length, 1,
    'right section renders its saved polygon');
  console.log('ROI project-open regression: PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
