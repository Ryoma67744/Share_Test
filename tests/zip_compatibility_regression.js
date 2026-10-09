'use strict';
// Run the production ZIP transport in each source/target runtime combination.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const RoiMediaModel = require('../viewer/roi-media-model.js');
const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8').replace(/\r\n/g, '\n');
const clone = value => JSON.parse(JSON.stringify(value));
const noNetwork = () => { throw new Error('ZIP transport must not contact or publish to the cloud'); };
function productionFunction(name) {
  let start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  if (html.slice(start - 6, start) === 'async ') start -= 6;
  const indent = html.slice(html.lastIndexOf('\n', start) + 1, start);
  const end = html.indexOf('\n' + indent + '}', start);
  assert.ok(end > start, name + ' closing brace');
  return html.slice(start, end + indent.length + 2);
}
// A small request/transaction adapter with IndexedDB's relevant contract:
// readwrite transactions serialize, writes remain private until commit, add
// rejects duplicate keys, and abort rolls back BOTH stores. Production
// putProject/pr/txDone/indexRowFor below perform all recovery-ID decisions.
function transactionalStore(projects) {
  const summaries = new Map(), operations = [];
  let tail = Promise.resolve();
  const storage = { summaries, operations, failNextCommit: false };
  storage.tx = async (names, mode) => {
    assert.equal(mode, 'readwrite');
    assert.deepEqual(Array.from(names), ['projects', 'project_index']);
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    const original = { projects, project_index: summaries };
    const draft = Object.fromEntries(names.map(name => [name, new Map(
      Array.from(original[name], ([key, value]) => [key, clone(value)]))]));
    let finished = false, commitTimer;
    const t = {
      error: null,
      abort() {
        if (finished) return;
        finished = true;
        clearImmediate(commitTimer);
        t.error = t.error || Object.assign(new Error('transaction aborted'), { name: 'AbortError' });
        if (t.onabort) t.onabort();
        release();
      },
      objectStore(name) {
        assert.ok(draft[name]);
        const request = (op, key, value) => {
          assert.equal(finished, false, 'request belongs to an active transaction');
          clearImmediate(commitTimer);
          const req = {};
          setImmediate(() => {
            if (finished) return;
            try {
              operations.push({ store: name, op, key });
              if (op === 'get') req.result = draft[name].has(key) ? clone(draft[name].get(key)) : undefined;
              else {
                if (op === 'add' && draft[name].has(key)) {
                  throw Object.assign(new Error('duplicate key'), { name: 'ConstraintError' });
                }
                draft[name].set(key, clone(value));
                req.result = key;
              }
              req.onsuccess();
              commitTimer = setImmediate(() => {
                if (storage.failNextCommit) {
                  storage.failNextCommit = false;
                  t.error = Object.assign(new Error('quota exhausted at commit'), { name: 'QuotaExceededError' });
                  t.abort();
                  return;
                }
                finished = true;
                for (const name of names) {
                  original[name].clear();
                  for (const [key, value] of draft[name]) original[name].set(key, clone(value));
                }
                if (t.oncomplete) t.oncomplete();
                release();
              });
            } catch (error) {
              req.error = error;
              if (req.onerror) req.onerror();
              t.error = error;
              t.abort();
            }
          });
          return req;
        };
        return { get: key => request('get', key),
          add: value => request('add', value.id, value),
          put: value => request('put', value.id, value) };
      },
    };
    return t;
  };
  return storage;
}
class MemoryZip {
  constructor() { this.files = {}; }
  file(name, value) {
    if (arguments.length === 1) return this.files[name] || null;
    this.files[name] = { async: async kind => kind === 'string' ? String(value) : value };
    return this;
  }
  async generateAsync() { return this; }
  static async loadAsync(value) { return value; }
}
const vertices = [[10, 11], [12, 11], [12, 13], [10, 13]];
const geometry = { version: 'msi-source-v1', sourceRef: 'source-one', displayGeometry: { W: 40, H: 50 } };
const originals = {
  he: new Blob([Uint8Array.from([0, 255, 128, 42])], { type: 'image/png' }),
  txt: new Blob(['x\ty\tvalue\n01\t2\tNA\n3\t4\t0\n'], { type: 'text/plain' }),
  photo: new Blob([Uint8Array.from([137, 80, 78, 71, 255, 1, 0])], { type: 'image/png' }),
};
function fixture() {
  return {
    id: 'portable-project', displayName: 'Portable project', memo: { freeNote: 'Preserved note' },
    sections: [{ id: 'source-section', ordinal: 1, displayName: 'Sample',
      meta: { transform: { rot: 90, scale: 1.25 } },
      images: { HE: { blobId: 'he', filename: 'whole-slide.png', mime: 'image/png' } },
      msiFiles: { source: { id: 'source', kind: 'txt', blobId: 'txt', filename: 'instrument.txt' } },
      msiSeries: { MSI_A: { kind: 'txt', blobId: 'txt', filename: 'instrument.txt', sourceFileId: 'source',
        sourceReference: 'source-one', x: 'x', y: 'y', v: 'value', bakeMode: 'full',
        sourceUrl: 'https://old-cloud.invalid/instrument.txt' } },
    }],
    rois: [{ id: 'old-roi', colorKey: 'ROI_1', name: 'Cyst',
      polysBySection: { 'source-section': clone(vertices) }, geometryBySection: { 'source-section': clone(geometry) } }],
    roiHidden: { 'old-roi': true },
    meta: { colormap: 'viridis', msiSmoothing: 'linear', custom: { retained: 17, adminPassword: 'never-copy' },
      shareInfo: { slug: 'old-cloud', viewerPassword: 'never-copy' }, __share: true, __publishPending: true,
      masterPw: 'never-copy', viewerPassword: 'never-copy',
      roiMedia: RoiMediaModel.normalizeRegistry({ version: 1, items: [{
        id: 'photo-1', roiKey: 'ROI_1', sectionId: 'source-section', sourceRef: 'source-one',
        roiSnapshot: { vertices: clone(vertices), geometry: clone(geometry) }, blobId: 'photo',
        mime: 'image/png', filename: 'HE40x.png', width: 3200, height: 2400, title: 'HE 40x', revision: 1,
      }] }),
    },
    overlays: [
      { id: 'saved-overlay', name: 'Master overlay', layers: [
        { key: 'MSI_A', color: '#ff00ff' }, { key: 'MSI_B', color: '#00ff00' }], bg: 'he', matchBrightness: true },
      { id: 'shared-overlay', name: 'Collaborator overlay', layers: [
        { key: 'MSI_A', color: '#ff0000' }, { key: 'MSI_B', color: '#00ffff' }], bg: 'black',
        matchBrightness: false, _server: true, _serverVersion: 8 },
      { id: 'local-overlay', name: 'Recipient browser overlay', layers: [
        { key: 'MSI_A', color: '#ffffff' }, { key: 'MSI_B', color: '#0000ff' }], bg: 'he', _local: true },
    ],
    shareInfo: { slug: 'old-cloud', viewerPassword: 'never-copy' }, __share: true, __publishPending: true,
  };
}
function context(offline, includeOriginals = false) {
  let sequence = 0;
  const blobs = new Map(includeOriginals ? Object.entries(originals).map(([id, blob]) => [id, { blob, mime: blob.type }]) : []);
  const projects = new Map();
  const storage = transactionalStore(projects);
  const ctx = vm.createContext({ console, Blob, Map, Set, Promise, RoiMediaModel,
    window: { DESI_OFFLINE: offline }, fetch: noNetwork, SupabaseClient: { publicUrl: noNetwork, rpc: noNetwork },
    loadScript: async () => {}, LAZY_LIBS: { jszip: 'local-jszip' }, JSZip: MemoryZip,
    uid: prefix => prefix + '-' + (++sequence), nowIso: () => '2026-10-09T00:00:00Z',
    ensureMemoShape: value => value || {}, safeName: value => value, DEFAULT_ANATOMY_PALETTE: {},
    freezeMsiSourceReferences() {}, alignmentImageIdentity: image => image.blobId,
    blobContentSig: async () => null, bakeAlignedHeToMsiPng: async () => null,
    buildSampleCsvGroups: async () => [], _yieldUi: async () => {},
    openPublishProgressModal: () => ({ update() {}, close() {} }), showToast() {},
    alert: value => ctx.alerts.push(String(value)), alerts: [],
    downloadAsFile: value => { ctx.exported = value; },
    ProjectStorage: { getBlob: async id => blobs.get(id), putBlob: async record => blobs.set(record.id, record),
      getProject: async id => projects.get(id) || null,
      putProject: async (project, options) => { const saved = await ctx.putProject(project, options); ctx.saved = clone(saved); return saved; } },
    App: { project: fixture(), panels: new Map(), openProject: async id => { ctx.openedId = id; },
      otsuBgRemove: true, otsuStrength: 0.35, otsuManualThreshold: 1.25 },
    blobs, projects, storage, tx: storage.tx,
  });
  vm.runInContext('let _exportInProgress = false;\n' + [
    'detachOfflineProject', 'sanitizeStorageKeySegment', 'guessMimeFromPath', 'remapRoiGeometry',
    'roiMediaForTransport', 'roiMediaReadOriginal', 'roiMediaPublicItem', 'exportProjectAsZip', 'importZipFile',
    'isViewerOverlay', 'indexRowFor', 'pr', 'txDone', 'putProject',
  ].map(productionFunction).join('\n'), ctx);
  return ctx;
}
async function equalOriginal(ctx, blobId, original) {
  assert.deepEqual(Buffer.from(await ctx.blobs.get(blobId).blob.arrayBuffer()), Buffer.from(await original.arrayBuffer()));
}
async function main() {
  for (const sourceOffline of [false, true]) {
    const source = context(sourceOffline, true);
    const before = clone(source.App.project);
    await source.exportProjectAsZip();
    assert.deepEqual(source.alerts, []);
    const zip = source.exported;
    assert.ok(zip);
    const manifest = JSON.parse(await zip.file('Portable project.json').async('string'));
    assert.equal(manifest.offlineSettings.version, 1, 'portable settings are exported in both modes');
    assert.equal(manifest.offlineSettings.meta.roiMedia, undefined, 'ROI photos use the dedicated source transport');
    assert.ok(!JSON.stringify(manifest).includes('never-copy'), 'publication credentials never enter the archive');
    assert.deepEqual(clone(source.App.project), before, 'export never mutates the source project');

    for (const targetOffline of [false, true]) {
      const target = context(targetOffline);
      await target.importZipFile(zip);
      const restored = target.saved, section = restored.sections[0], roi = restored.rois[0];
      assert.equal(target.openedId, restored.id);
      if (targetOffline) assert.equal(restored.id, before.id, 'unused local ID survives offline recovery');
      else assert.notEqual(restored.id, before.id, 'online ZIP imports remain independent projects');
      assert.equal(restored.shareInfo, undefined);
      assert.equal(restored.__share, undefined);
      assert.equal(restored.__publishPending, undefined);
      assert.equal(restored.meta.shareInfo, undefined);
      assert.equal(restored.meta.__publishPending, undefined);
      assert.deepEqual(restored.meta.custom, { retained: 17 });
      assert.equal(restored.meta.colormap, 'viridis');
      assert.equal(restored.meta.msiSmoothing, 'linear');
      assert.equal(restored.meta.otsuBgRemove, true);
      assert.equal(restored.meta.otsuStrength, 0.35);
      assert.equal(restored.meta.otsuManualThreshold, 1.25);
      const expectedOverlays = clone(before.overlays).map(overlay => {
        delete overlay._server; delete overlay._local; delete overlay._serverVersion;
        return overlay;
      });
      assert.deepEqual(restored.overlays, expectedOverlays, 'overlay display definitions survive without source ownership');
      assert.equal(restored.overlays.filter(o => !target.isViewerOverlay(o)).length, before.overlays.length,
        'every recovered overlay is eligible for publication from the independent master project');
      assert.deepEqual(restored.memo, before.memo);
      assert.deepEqual(section.meta, before.sections[0].meta);
      assert.notEqual(roi.id, 'old-roi');
      assert.equal(restored.roiHidden[roi.id], true);
      assert.equal(restored.roiHidden['old-roi'], undefined);
      assert.deepEqual(roi.polysBySection[section.id], vertices);
      assert.deepEqual(roi.geometryBySection[section.id], geometry);
      assert.equal(section.msiSeries.MSI_A.sourceReference, 'source-one');
      assert.equal(section.msiSeries.MSI_A.sourceUrl, undefined);
      assert.equal(section.msiFiles.source.blobId, section.msiSeries.MSI_A.blobId);
      await equalOriginal(target, section.images.HE.blobId, originals.he);
      await equalOriginal(target, section.msiSeries.MSI_A.blobId, originals.txt);
      const photo = restored.meta.roiMedia.items[0];
      assert.equal(photo.sectionId, section.id);
      assert.deepEqual(photo.roiSnapshot, { vertices, geometry });
      assert.equal(photo.sourcePath, undefined);
      assert.equal(photo.storagePath, undefined);
      await equalOriginal(target, photo.blobId, originals.photo);

      const firstId = restored.id;
      await target.importZipFile(zip);
      assert.notEqual(target.saved.id, firstId, 'a second import never overwrites a project in either mode');
      assert.deepEqual(target.projects.get(firstId), restored);
    }
  }

  // Simulate simultaneous recoveries against the same transactional store.
  // Both archives ask for the same old ID; distinct names and independently
  // restored image blobs expose replacement instead of a successful import.
  const source = context(true, true);
  await source.exportProjectAsZip();
  const firstZip = source.exported;
  source.App.project.displayName = 'Other recovery';
  await source.exportProjectAsZip();
  const secondZip = source.exported;
  const concurrent = context(true);
  await Promise.all([concurrent.importZipFile(firstZip), concurrent.importZipFile(secondZip)]);
  assert.equal(concurrent.projects.size, 2, 'concurrent recoveries both survive');
  assert.ok(concurrent.projects.has('portable-project'), 'one recovery retains the MRM-linked ID');
  assert.deepEqual(Array.from(concurrent.projects.values(), p => p.displayName).sort(), ['Other recovery', 'Portable project']);
  assert.equal(concurrent.storage.summaries.size, 2, 'both manager summaries commit alongside the projects');
  for (const project of concurrent.projects.values()) {
    assert.equal(concurrent.storage.summaries.get(project.id).displayName, project.displayName);
    await equalOriginal(concurrent, project.sections[0].images.HE.blobId, originals.he);
  }
  assert.equal(concurrent.storage.operations.filter(o => o.store === 'projects' && o.op === 'add').length, 2);
  assert.equal(concurrent.storage.operations.filter(o => o.store === 'projects' && o.op === 'put').length, 0,
    'ZIP recovery never upserts an existing project');

  // Test commit failure after a collision selected a fresh ID. Neither the
  // old project, its summary nor the caller's ID may change on a failed save.
  const beforeProjects = clone(Array.from(concurrent.projects));
  const beforeSummaries = clone(Array.from(concurrent.storage.summaries));
  const failed = { id: 'portable-project', displayName: 'Failed recovery', sections: [], rois: [] };
  concurrent.storage.failNextCommit = true;
  await assert.rejects(concurrent.ProjectStorage.putProject(failed, { createOnly: true }), /quota exhausted/);
  assert.equal(failed.id, 'portable-project', 'the caller only receives the fallback ID after commit');
  assert.deepEqual(clone(Array.from(concurrent.projects)), beforeProjects);
  assert.deepEqual(clone(Array.from(concurrent.storage.summaries)), beforeSummaries);

  // Ordinary project saves still update the chosen project rather than
  // silently duplicating it; only archive creation uses createOnly.
  const edit = clone(concurrent.projects.get('portable-project'));
  edit.displayName = 'Edited project';
  await concurrent.ProjectStorage.putProject(edit);
  assert.equal(concurrent.projects.size, 2);
  assert.equal(concurrent.projects.get(edit.id).displayName, 'Edited project');
  assert.equal(concurrent.storage.summaries.get(edit.id).displayName, 'Edited project');

  // Earlier online archives have no offlineSettings field. Their display and
  // hidden-ROI metadata remains usable; unknown display keys are never copied.
  for (const offline of [false, true]) {
    const oldDoc = { format: 'desi_data_share_v2', displayName: 'Earlier online ZIP', id: 'legacy-project',
      sections: [{ id: 's', images: {}, data: [] }],
      rois: [{ id: 'r', polysBySection: { s: vertices }, geometryBySection: { s: geometry } }], roiHidden: { r: true },
      displaySettings: { otsuBgRemove: false, otsuStrength: 0.5, otsuManualThreshold: null,
        shareInfo: { slug: 'must-not-restore' }, __publishPending: true, arbitrary: 'must-not-copy' } };
    const target = context(offline);
    await target.importZipFile(new MemoryZip().file('Legacy.json', JSON.stringify(oldDoc)));
    assert.deepEqual(target.saved.meta, { otsuBgRemove: false, otsuStrength: 0.5, otsuManualThreshold: null });
    assert.equal(target.saved.roiHidden[target.saved.rois[0].id], true);
    assert.equal(target.saved.shareInfo, undefined);
    assert.equal(target.saved.__publishPending, undefined);
  }
  console.log('ZIP compatibility regression: PASS (4 mode pairs, original bytes, overlay ownership, atomic concurrent recovery, rollback, legacy archives)');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
