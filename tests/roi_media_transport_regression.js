'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { html } = require('./viewer-runtime.cjs');
const RoiMediaModel = require('../viewer/roi-media-model.js');
const copy = x => JSON.parse(JSON.stringify(x));
function fn(name, indent = '') {
  const needle = 'function ' + name + '(';
  let start = html.indexOf(needle);
  if (start < 0) throw new Error('Missing production function ' + name);
  if (html.slice(start - 6, start) === 'async ') start -= 6;
  return html.slice(start, html.indexOf('\n' + indent + '}', start) + indent.length + 2);
}
function appMethod(name) {
  const start = html.indexOf('    async ' + name + '(');
  if (start < 0) throw new Error('Missing production method ' + name);
  return html.slice(start, html.indexOf('\n    },', start) + 6);
}
const vertices = [[10, 11], [12, 11], [12, 13], [10, 13]];
const geometry = { version: 'msi-source-v1', sourceRef: 'source-one', displayGeometry: { W: 40, H: 50 } };
const item = { id: 'photo-1', roiKey: 'ROI_1', sectionId: 'local-section', sourceRef: 'source-one',
  roiSnapshot: { vertices, geometry }, blobId: 'original-blob', mime: 'image/png', filename: 'HE40x.png',
  width: 3200, height: 2400, title: 'HE 40×', revision: 1 };
function project() {
  return { id: 'p1', displayName: 'Photo test', sections: [{ id: 'local-section', ordinal: 1, meta: {}, images: {}, msiSeries: {} }],
    rois: [{ id: 'roi-local', colorKey: 'ROI_1', name: 'Cyst', polysBySection: { 'local-section': copy(vertices) },
      geometryBySection: { 'local-section': copy(geometry) } }],
    meta: { roiMedia: RoiMediaModel.normalizeRegistry({ version: 1, items: [item] }) } };
}
class MemoryZip {
  constructor() { this.files = {}; }
  file(path, data) {
    if (arguments.length === 1) return this.files[path] || null;
    this.files[path] = { async: async kind => kind === 'string' ? String(data) : data, data };
    return this;
  }
  async generateAsync() { return this; }
  static async loadAsync(value) { return value; }
}
function context(extra = {}) {
  let sequence = 0;
  const records = new Map([['original-blob', { blob: new Blob([Uint8Array.from([137, 80, 78, 71, 255, 1, 0])]), mime: 'image/png' }]]);
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Blob, RoiMediaModel, Map, Set, Promise, URL, AbortController,
    setTimeout: cb => { cb(); return 1; }, clearTimeout() {},
    uid: prefix => prefix + '-' + (++sequence), nowIso: () => '2026-09-24T12:00:00Z',
    freezeMsiSourceReferences() {}, loadScript: async () => {}, LAZY_LIBS: { jszip: 'unused' }, JSZip: MemoryZip,
    DEFAULT_ANATOMY_PALETTE: {}, ensureMemoShape: x => x || {}, safeName: x => x,
    buildSampleCsvGroups: async () => [], _yieldUi: async () => {},
    showToast() {}, alert: x => { ctx.alerts.push(String(x)); }, alerts: [], confirm: () => true,
    openPublishProgressModal: () => ({ update() {}, close() {}, setNote() {}, setCancelHandler() {} }),
    downloadAsFile: value => { ctx.exported = value; },
    location: { origin: 'https://test.invalid', pathname: '/viewer/index.html' },
    isViewerOverlay: () => false, fmtBytesMB: x => String(x),
    runWithConcurrency: async (values, _n, worker) => { for (const value of values) await worker(value); },
    encodeRoiPolygon: (roi, sid) => roi.polysBySection[sid],
    remapRoiGeometry: (g, ids) => Object.fromEntries(Object.entries(g || {}).map(([k, v]) => [ids[k], v])),
    ProjectStorage: {
      getBlob: async id => records.get(id),
      putBlob: async rec => { records.set(rec.id, rec); return rec.id; },
      putProject: async p => { ctx.saved = copy(p); },
    },
    App: { project: project(), panels: new Map(), openProject: async () => {}, queueSave() {} },
    SupabaseClient: { configured: () => true, requestPublishSession: async () => ({ token: 'test' }),
      headObject: async () => false, uploadBlob: async (_bucket, path, blob) => { ctx.uploads.push({ path, blob }); },
      upsertProjectDoc: async args => { ctx.published = copy(args); return { ok: true }; },
      publicUrl: (_bucket, path) => 'https://test.invalid/' + path },
    uploads: [], records, ...extra,
  });
  const names = ['sanitizeStorageKeySegment', 'storageExtOf', 'roiMediaForTransport', 'roiMediaReadOriginal',
    'roiMediaPublicItem', 'roiMediaRegistryFromDoc', 'exportProjectAsZip', 'importZipFile', '_publishCoreInner'];
  vm.runInContext('let _exportInProgress = false;\n' + names.map(n => fn(n)).join('\n'), ctx);
  return ctx;
}
async function main() {
  const ctx = context();
  const before = JSON.stringify(ctx.App.project.rois);
  // Two attachments referencing one original must transport exactly one binary.
  ctx.App.project.meta.roiMedia = RoiMediaModel.add(ctx.App.project.meta.roiMedia, { ...item, id: 'photo-2', title: 'Second reference' });
  await ctx.exportProjectAsZip();
  assert.deepEqual(ctx.alerts, []);
  const zip = ctx.exported;
  assert.equal(Object.keys(zip.files).filter(p => p.startsWith('ROI_Media/')).length, 1);
  const manifest = JSON.parse(await zip.file('Photo test.json').async('string'));
  assert.equal(manifest.roiMedia.items.length, 2);
  assert.equal(manifest.roiMedia.items[0].blobId, undefined);
  assert.equal(manifest.roiMedia.items[0].storagePath, undefined);
  await ctx.importZipFile(zip);
  const restored = ctx.saved.meta.roiMedia.items;
  assert.equal(restored.length, 2);
  assert.equal(restored[0].blobId, restored[1].blobId);
  assert.equal(restored[0].sectionId, ctx.saved.sections[0].id);
  assert.notEqual(restored[0].sectionId, item.sectionId);
  assert.deepEqual(restored[0].roiSnapshot, item.roiSnapshot);
  assert.equal(restored[0].sourceRef, item.sourceRef);
  assert.deepEqual(Buffer.from(await ctx.records.get(restored[0].blobId).blob.arrayBuffer()),
    Buffer.from(await ctx.records.get('original-blob').blob.arrayBuffer()));
  assert.equal(JSON.stringify(ctx.App.project.rois), before, 'Transport must not change scientific ROI geometry');
  delete zip.files[manifest.roiMedia.items[0].sourcePath];
  ctx.saved = null;
  await assert.rejects(() => ctx.importZipFile(zip), /ROI写真の原本がありません/);
  assert.equal(ctx.saved, null, 'Incomplete archives must not create a project');

  const missing = context();
  missing.records.delete('original-blob');
  await missing.exportProjectAsZip();
  assert.equal(missing.exported, undefined);
  assert.match(missing.alerts[0], /ROI写真の原本がありません/);
  await assert.rejects(() => missing._publishCoreInner(missing.App.project, { slug: 'test' }, 'pw', { silent: true }), /ROI写真の原本/);
  assert.equal(missing.published, undefined);

  const publishing = context();
  await publishing._publishCoreInner(publishing.App.project, { slug: 'test' }, 'pw', { silent: true });
  assert.equal(publishing.uploads.length, 1);
  assert.match(publishing.uploads[0].path, /^test\/roi-media\/photo-1\/r1\/original-blob\.png$/);
  const publicItem = publishing.published._meta.roiMedia.items[0];
  assert.equal(publicItem.storagePath, publishing.uploads[0].path);
  assert.equal(publicItem.blobId, undefined);
  assert.deepEqual(publicItem.roiSnapshot, item.roiSnapshot);
  assert.equal(publishing.App.project.meta.roiMedia.items[0].storagePath, publicItem.storagePath);
  publishing.records.delete('original-blob');
  publishing.SupabaseClient.headObject = async (_bucket, path) => path === publicItem.storagePath;
  await publishing._publishCoreInner(publishing.App.project, { slug: 'test' }, 'pw', { silent: true });
  assert.equal(publishing.uploads.length, 1, 'Verified remote original survives local blob eviction without re-upload');
  publishing.App.project.meta.roiMedia.items = [];
  await publishing._publishCoreInner(publishing.App.project, { slug: 'test' }, 'pw', { silent: true });
  assert.deepEqual(publishing.published._meta.roiMedia, { version: 1, items: [] }, 'Last photo deletion explicitly clears shared registry');

  const concurrent = context();
  concurrent.SupabaseClient.uploadBlob = async () => {
    concurrent.App.project.meta.roiMedia = RoiMediaModel.replace(concurrent.App.project.meta.roiMedia, 'photo-1',
      { blobId: 'new-retake', mime: 'image/png', filename: 'retake.png', width: 30, height: 40 });
  };
  await concurrent._publishCoreInner(concurrent.App.project, { slug: 'test' }, 'pw', { silent: true });
  assert.equal(concurrent.published._meta.roiMedia.items[0].revision, 1, 'In-flight uploads use detached registry snapshot');
  assert.equal(concurrent.App.project.meta.roiMedia.items[0].revision, 2, 'Publish must not overwrite a concurrent retake');
  const failed = context();
  failed.SupabaseClient.uploadBlob = async () => { throw new Error('connection lost'); };
  await assert.rejects(() => failed._publishCoreInner(failed.App.project, { slug: 'test' }, 'pw', { silent: true }), /connection lost/);
  assert.equal(failed.published, undefined, 'Upload failure cannot publish incomplete photo registry');
  const removedWhileUploading = context();
  removedWhileUploading.SupabaseClient.uploadBlob = async () => { removedWhileUploading.App.project.rois = []; };
  await assert.rejects(() => removedWhileUploading._publishCoreInner(removedWhileUploading.App.project,
    { slug: 'test' }, 'pw', { silent: true }), /対応先が見つかりません/);
  assert.equal(removedWhileUploading.published, undefined, 'Deleted ROI cannot acquire an orphan photograph reference');
  const differentSlug = context();
  differentSlug.App.project.meta.roiMedia.items[0].storagePath = 'previous-project/roi-media/old.png';
  await differentSlug._publishCoreInner(differentSlug.App.project, { slug: 'new-project' }, 'pw', { silent: true });
  assert.match(differentSlug.published._meta.roiMedia.items[0].storagePath, /^new-project\//,
    'A new project must own its published original so deleting an old project cannot destroy it');

  const doc = { meta: { project_meta: { roiMedia: { version: 1, items: [publicItem] } } },
    sections: [{ id: 'server-uuid', meta: { client_id: 'local-section' } }] };
  const remote = copy(ctx.roiMediaRegistryFromDoc(doc));
  assert.equal(remote.items[0].sectionId, 'local-section');
  assert.equal(remote.items[0].blobId, undefined);
  assert.equal(remote.items[0].storagePath, publicItem.storagePath);
  const oldIdDoc = copy(doc);
  oldIdDoc.meta.project_meta.roiMedia.items[0].sectionId = 'server-uuid';
  assert.equal(ctx.roiMediaRegistryFromDoc(oldIdDoc).items[0].sectionId, 'local-section');

  // Server -> local import downloads the original once and resolves server ROI
  // UUIDs without ever using them as the photograph's logical identity.
  const imported = context({ fetch: async () => ({ ok: true, blob: async () => new Blob(['server original']) }),
    _overlaysFromSections: () => [], fetchAllShareRois: async () => [],
    groupRoiRowsByColor: () => [{ id: 'new-server-roi', colorKey: 'ROI_1',
      polysBySection: { 'server-uuid': copy(vertices) }, geometryBySection: { 'server-uuid': copy(geometry) } }],
  });
  vm.runInContext('globalThis.localBuilder = ({' + appMethod('_buildLocalProjectFromDoc') + '});', imported);
  const local = await imported.localBuilder._buildLocalProjectFromDoc('test', doc, { token: 'x' });
  assert.equal(local.meta.roiMedia.items[0].sectionId, local.sections[0].id);
  assert.equal(await imported.records.get(local.meta.roiMedia.items[0].blobId).blob.text(), 'server original');
  imported.fetch = async () => ({ ok: false, status: 404 });
  await assert.rejects(() => imported.localBuilder._buildLocalProjectFromDoc('test', doc, { token: 'x' }), /ROI写真を取り込めませんでした/);

  // GC collects originals even when no image layer points at them; project
  // deletion checks every remaining project's reference before reclaiming.
  const gc = vm.createContext({ Set });
  vm.runInContext(fn('collectBlobIds', '    '), gc);
  assert.deepEqual([...gc.collectBlobIds(project())], ['original-blob']);
  assert.deepEqual([...gc.collectBlobIds({ meta: project().meta })], ['original-blob']);
  const deleted = [], remaining = project();
  const store = { delete: async id => { deleted.push(id); }, openCursor() {
    const req = {};
    queueMicrotask(() => req.onsuccess({ target: { result: { value: remaining,
      continue: () => queueMicrotask(() => req.onsuccess({ target: { result: null } })) } } }));
    return req;
  } };
  const target = project();
  target.sections[0].images = { HE: { blobId: 'exclusive-blob' } };
  Object.assign(gc, { getProject: async () => target, tx: async () => ({ objectStore: () => store }),
    txDone: () => Promise.resolve(), pr: async x => x });
  vm.runInContext(fn('deleteProject', '    '), gc);
  await gc.deleteProject('deleted-project');
  assert.ok(deleted.includes('exclusive-blob'));
  assert.ok(!deleted.includes('original-blob'), 'Another project still using a photo must retain its original');
  console.log('ROI media transport regression: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
