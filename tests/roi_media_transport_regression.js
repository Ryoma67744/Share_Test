'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { html } = require('./viewer-runtime.cjs');
const PublishSafety = require('../viewer/publish-safety.js');
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
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Blob, RoiMediaModel, PublishSafety, Map, Set, Promise, URL, AbortController,
    setTimeout: cb => { cb(); return 1; }, clearTimeout() {},
    uid: prefix => prefix + '-' + (++sequence), nowIso: () => '2026-09-24T12:00:00Z',
    freezeMsiSourceReferences() {}, alignmentImageIdentity: () => null, loadScript: async () => {}, LAZY_LIBS: { jszip: 'unused' }, JSZip: MemoryZip,
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
      pinBlobs: async () => {}, releaseBlobPins: async () => {},
      patchProject: async (id, fn) => {const p=copy(ctx.App.project),prev=p.storageRevision||0;fn(p);p.storageRevision=prev+1;return {applied:true,project:p,previousStorageRevision:prev,storageRevision:prev+1};},
      recordPublishReceipt: async (id, receipt) => {const p=copy(ctx.App.project),prev=p.storageRevision||0;p.shareInfo={...p.shareInfo,...receipt};delete p.shareInfo.pendingPublish;p.storageRevision=prev+1;return {applied:true,project:p,previousStorageRevision:prev,storageRevision:prev+1};},
      putBlob: async rec => { records.set(rec.id, rec); return rec.id; },
      putProject: async p => { ctx.saved = copy(p); },
    },
    App: { project: project(), _setSyncStatus() {}, panels: new Map(), openProject: async () => {}, queueSave() {} },
    SupabaseClient: { configured: () => true, requestPublishSessionV2: async (_pw,job) => ({ protocol:2,token:'test',object_prefix:job.slug+'/publish-v2/'+job.jobId+'/' }),
      headObject: async () => false, uploadBlob: async (_bucket, path, blob) => { ctx.uploads.push({ path, blob }); },
      publishProjectDocV2: async args => { ctx.published = copy(args); return { ok:true,protocol:2,slug:args._slug,request_id:args._request_id,server_revision:args._expected_revision+1,committed_at:'2026-11-04T00:00:00Z' }; },
      publicUrl: (_bucket, path) => 'https://test.invalid/' + path },
    uploads: [], records, ...extra,
  });
  require('./archive_test_support.cjs').install(ctx);
  const names = ['sanitizeStorageKeySegment', 'storageExtOf', 'roiMediaForTransport', 'roiMediaReadOriginal',
    'roiMediaPublicItem', 'roiMediaRegistryFromDoc', 'exportProjectAsZip', 'importZipFile', '_publishContext', '_publishStatus', '_adoptPublishPatch', '_publishCoreInner'];
  vm.runInContext('let _exportInProgress = false; const _publishContexts = new Map();\n' + names.map(n => fn(n)).join('\n'), ctx);
  return ctx;
}
async function main() {
  // Display polling may retain successful sections after one failed RPC.
  // A master import must instead reject incomplete ROI data, including when
  // an earlier share viewer's token-expired flag is still set in this tab.
  const roiCalls = [], roiWarnings = [], roiRows = {
    first: [{ id: 'master', section_id: 'first', poly_msi: copy(vertices) }],
    second: [{ id: 'viewer', section_id: 'second', poly_msi: copy(vertices) }],
  };
  let roiFailure = null, expiredNotices = 0;
  const roster = vm.createContext({
    _shareTokenExpired: false,
    console: { warn: (...args) => roiWarnings.push(args) },
    _isExpiredTokenError: error => error.code === '28000',
    _noteShareTokenExpired: () => { expiredNotices++; roster._shareTokenExpired = true; },
    SupabaseClient: { listRois: async (token, sectionId) => {
      roiCalls.push([token, sectionId]);
      if (sectionId === 'second' && roiFailure) throw roiFailure;
      return roiRows[sectionId];
    } },
  });
  vm.runInContext(fn('fetchAllShareRois'), roster);
  const roiSections = [{ id: 'first' }, { id: 'second' }];
  const expectedRows = [...roiRows.first, ...roiRows.second];
  assert.deepEqual(copy(await roster.fetchAllShareRois('read-token', roiSections, {strict:true})), expectedRows);
  assert.deepEqual(roiCalls, [['read-token','first'], ['read-token','second']]);
  roiFailure = new Error('synthetic ROI download failed');
  await assert.rejects(() => roster.fetchAllShareRois('read-token', roiSections, {strict:true}), error => error === roiFailure);
  assert.deepEqual(copy(await roster.fetchAllShareRois('read-token', roiSections)), roiRows.first,
    'Normal display keeps successfully fetched ROI sections');
  assert.equal(roiWarnings.length, 1);
  roiFailure = Object.assign(new Error('expired synthetic token'), {code:'28000'});
  assert.deepEqual(copy(await roster.fetchAllShareRois('expired', roiSections)), roiRows.first);
  assert.equal(expiredNotices, 1);
  const skippedCalls = roiCalls.length;
  assert.deepEqual(copy(await roster.fetchAllShareRois('expired', roiSections)), []);
  assert.equal(roiCalls.length, skippedCalls, 'Normal polling stops after its token expired');
  roiFailure = null;
  assert.deepEqual(copy(await roster.fetchAllShareRois('fresh-master-token', roiSections, {strict:true})), expectedRows,
    'A fresh master import still reads ROIs after an unrelated share token expired');
  assert.equal(roiCalls.length, skippedCalls + 2);
  roiFailure = Object.assign(new Error('master token expired'), {code:'28000'});
  await assert.rejects(() => roster.fetchAllShareRois('expired-master', roiSections, {strict:true}), error => error === roiFailure);
  assert.equal(expiredNotices, 1, 'Strict import reports its error without altering display polling state');

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
  assert.match(missing.alerts[0], /必要な原本がありません/);
  await assert.rejects(() => missing._publishCoreInner(missing.App.project, { slug: 'test' }, 'pw', { silent: true }), /原本を確認できない/);
  assert.equal(missing.published, undefined);

  const publishing = context();
  await publishing._publishCoreInner(publishing.App.project, { slug: 'test' }, 'pw', { silent: true });
  assert.equal(publishing.uploads.length, 1);
  assert.match(publishing.uploads[0].path, /^test\/publish-v2\/[a-f0-9-]+\/[a-f0-9-]+$/);
  const publicItem = publishing.published._meta.roiMedia.items[0];
  assert.equal(publicItem.storagePath, publishing.uploads[0].path);
  assert.equal(publicItem.blobId, undefined);
  assert.deepEqual(publicItem.roiSnapshot, item.roiSnapshot);
  assert.equal(publishing.App.project.meta.roiMedia.items[0].storagePath, undefined, 'Receipt must not mutate scientific registry');
  assert.equal(publishing.App.project.shareInfo.blobPaths['original-blob'].path, publicItem.storagePath);
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
  await removedWhileUploading._publishCoreInner(removedWhileUploading.App.project, { slug:'test' }, 'pw', {silent:true});
  assert.equal(removedWhileUploading.published._rois.length,1,'Snapshot keeps its own original ROI association');
  assert.equal(removedWhileUploading.App.project.rois.length,0,'Completion never revives the live deleted ROI');
  const changedDestination=context();
  changedDestination.App.project.shareInfo={slug:'old',serverRevision:2};
  changedDestination.SupabaseClient.requestPublishSessionV2=async(_pw,job)=>{changedDestination.App.project.shareInfo.slug='changed-by-another-save';return {protocol:2,token:'t',object_prefix:job.slug+'/publish-v2/'+job.jobId+'/'};};
  await assert.rejects(()=>changedDestination._publishCoreInner(changedDestination.App.project,{slug:'new-project'},'pw',{silent:true}),/公開先が変更/);
  assert.equal(changedDestination.published,undefined);
  const differentSlug = context();
  differentSlug.App.project.shareInfo={slug:'previous-project',serverRevision:4};
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
  const remaining=project(),target=project();target.id='deleted-project';
  target.sections[0].images={HE:{blobId:'exclusive-blob'}};
  const memory=require('./helpers/memory-idb.cjs')({projects:new Map([[target.id,target],[remaining.id,remaining]])});
  gc.storeSafety=()=>require('../project-store-safety.js').create({transaction:memory.transaction,indexRowFor:p=>({id:p.id})});
  vm.runInContext(fn('deleteProject', '    '), gc);
  await gc.deleteProject('deleted-project');
  const deleted=memory.operations.filter(op=>op.store==='blobs'&&op.op==='delete').map(op=>op.key);
  assert.ok(deleted.includes('exclusive-blob'));
  assert.ok(!deleted.includes('original-blob'), 'Another project still using a photo must retain its original');
  console.log('ROI media transport regression: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
