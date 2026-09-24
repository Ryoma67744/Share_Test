'use strict';
// Exercise the production ROI and persistence methods with a delayed IDB write.
// A new ROI made while an older snapshot is committing must survive reopening.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { html, standalone } = require('./viewer-runtime.cjs');

function fakeElement() {
  const el = {
    children: [], style: {}, dataset: {}, classList: {
      add() {}, remove() {}, toggle() {},
    },
    addEventListener() {}, appendChild(child) { this.children.push(child); },
    querySelectorAll() { return []; },
    _html: '',
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; },
    set(value) { this._html = value; this.children = []; },
  });
  return el;
}

async function main() {
  const nodes = new Map();
  const toasts = [];
  const document = {
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, fakeElement());
      return nodes.get(id);
    },
    createElement: fakeElement,
  };
  const stored = new Map();
  let releaseFirstWrite;
  const firstWriteGate = new Promise(resolve => { releaseFirstWrite = resolve; });
  let writes = 0;
  let deletes = 0;
  let failWrites = false;
  let nextWriteGate = null;
  const ProjectStorage = {
    async putProject(project) {
      // IndexedDB structured-clones the value at put(), before the transaction
      // finishes. Delaying that commit exposes an edit queued in the meantime.
      const snapshot = structuredClone(project);
      if (++writes === 1) await firstWriteGate;
      const gate = nextWriteGate;
      nextWriteGate = null;
      if (gate) await gate;
      if (failWrites) {
        const error = new Error('IDB quota exhausted');
        error.name = 'QuotaExceededError';
        throw error;
      }
      stored.set(snapshot.id, snapshot);
    },
    async getProject(id) {
      const value = stored.get(id);
      return value ? structuredClone(value) : null;
    },
    async deleteProject(id) { deletes++; stored.delete(id); },
  };
  const appStart = html.indexOf('const App = {');
  const appEnd = html.indexOf('\n};', appStart);
  assert.ok(appStart >= 0 && appEnd > appStart, 'production App literal');
  const context = vm.createContext({
    console, document, ProjectStorage, setTimeout, clearTimeout,
    structuredClone, Map, Set,
    uid: () => 'roi-created-during-save',
    prompt: () => 'New cortex ROI',
    showToast: message => { toasts.push(String(message)); },
    confirm: () => true,
    updateAnalysisModeUi: () => {},
    SharePreview: { isOpen: () => false },
    _roiRawGridCache: new Map(),
    parquetReleaseAll: () => {},
    backfillLegacyCompoundMeta: () => {},
    ensureMemoShape: value => value || {},
    localStorage: { setItem() {}, removeItem() {} },
    COLORMAPS: {},
    setupGraphSelector: () => {},
    renderMemoForm: () => {},
  });
  vm.runInContext([
    standalone('pickUnusedColorKey'),
    standalone('msiValidRoiGeometry'),
    standalone('msiLayerSourceGeometry'),
    standalone('populateRoiList'),
    html.slice(appStart, appEnd + 3),
    'globalThis.testApp = App;',
  ].join('\n'), context);
  const app = context.testApp;
  const geometry = {
    sourceRef: 'test-source',
    displayGeometry: {
      version: 'msi-proportional-v1', W: 3, H: 3,
      x: { origin: 0, step: 1 }, y: { origin: 0, step: 1 },
    },
  };
  const section = { id: 'section-a', msiSeries: {} };
  const panel = {
    section,
    _pickRefMsiKey: () => 'MSI_test',
    msiValueRasters: new Map([['MSI_test', { sourceGeometry: geometry }]]),
    setDrawingPointerActive() {},
    destroy() {},
  };
  app.project = { id: 'project-a', displayName: 'Project A', sections: [section], rois: [],
    anatomyPalette: { Red: { rgba: [255, 0, 0, 200], name: 'Red' } }, meta: {} };
  app.activeSectionId = section.id;
  app.panels = new Map([[section.id, panel]]);
  app.redrawAllRois = () => {};
  app.renderAnalysis = () => {};
  app.refreshAnalysisScope = () => {};
  app.refreshProjectPicker = async () => {};
  app.refreshShareInfoButton = () => {};
  app.rebuildSectionPanels = async () => {};
  app.sectionVisibility = () => ({ ensure() {}, flushDeferred() {} });
  app._setSyncStatus = () => {};
  app._scheduleAutoPublish = () => {};
  const saveErrors = [];
  app._showSaveError = (message, reason) => { saveErrors.push({ message, reason }); };
  app.renderEmpty = () => {};

  const previousSave = app._doSave();
  assert.equal(writes, 1, 'the older snapshot is in flight');
  await app.startDrawing(null);
  assert.equal(app.drawing.mode, true, 'production ROI drawing started');
  app.drawing.vertices = [[0, 0], [2, 0]];
  await app.finalizeDrawing();
  assert.equal(app.drawing.mode, true, 'two-vertex Enter keeps drawing mode active');
  assert.equal(app.drawing.vertices.length, 2, 'two pending vertices remain editable');
  assert.equal(app.project.rois.length, 0, 'an unfinished shape does not create an ROI');
  assert.ok(toasts.some(message => /3.*点/.test(message)),
    'two-vertex Enter explains that at least three vertices are required');
  app.drawing.vertices.push([0, 2]);
  const finishedRoi = app.finalizeDrawing();
  assert.equal(nodes.get('roi-list').children.length, 1, 'new ROI appears immediately');
  assert.equal(app.project.rois.length, 1, 'ROI added to the project model');

  // Allow the production zero-delay queueSave timer to fire while the first
  // transaction is still blocked, then finish that transaction and reopen.
  await new Promise(resolve => setTimeout(resolve, 10));
  releaseFirstWrite();
  await previousSave;
  await finishedRoi;
  await app._flushSave();
  app.project = null;
  await app.openProject('project-a');
  assert.equal(app.project.rois.length, 1, 'ROI persists through project reopen');
  assert.equal(app.project.rois[0].name, 'New cortex ROI');
  assert.equal(nodes.get('roi-list').children.length, 1, 'ROI_LIST is rebuilt after reopen');
  assert.ok(writes >= 2, 'a second snapshot was written after the older commit');

  // A failed flush must keep the in-memory ROI (the only copy of this edit)
  // and restore the picker, rather than loading the target project over it.
  stored.set('project-b', { id: 'project-b', displayName: 'Project B', sections: [],
    rois: [], anatomyPalette: {}, meta: {} });
  app.project.rois[0].name = 'Unsaved ROI rename';
  app.queueSave(60000);
  document.getElementById('project-picker').value = 'project-b';
  failWrites = true;
  await app.openProject('project-b');
  assert.equal(app.project.id, 'project-a', 'failed save keeps the original project open');
  assert.equal(app.project.rois[0].name, 'Unsaved ROI rename', 'failed save retains the ROI edit');
  assert.equal(document.getElementById('project-picker').value, 'project-a', 'picker returns to the original project');
  assert.ok(saveErrors.some(error => error.reason === 'queueSave'), 'IDB error was surfaced');
  assert.ok(toasts.some(message => message.includes('切り替えを中止')), 'switch cancellation is explained');

  // Clear the simulated quota error and save the retained edit. Then hold a
  // later snapshot in flight while deleting: a late put() must not recreate
  // the project after deleteProject() commits.
  failWrites = false;
  assert.equal(await app._flushSave(), true);
  assert.equal((await ProjectStorage.getProject('project-a')).rois[0].name, 'Unsaved ROI rename');
  let releaseHeldWrite;
  nextWriteGate = new Promise(resolve => { releaseHeldWrite = resolve; });
  app.queueSave(60000);
  const pendingSave = app._flushSave();
  const pendingDelete = app.deleteCurrentProject();
  await Promise.resolve();
  assert.equal(deletes, 0, 'delete waits for the in-flight write');
  releaseHeldWrite();
  await pendingSave;
  await pendingDelete;
  assert.equal(deletes, 1);
  assert.equal(await ProjectStorage.getProject('project-a'), null,
    'late IDB write cannot resurrect a deleted project');
  assert.equal(app.project, null);
  console.log('ROI save regression: PASS');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
