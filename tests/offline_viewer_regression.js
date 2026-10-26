'use strict';
// Production viewer functions exercised with network/auth traps and a ZIP roundtrip.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8').replace(/\r\n/g, '\n');
const RoiMediaModel = require('../viewer/roi-media-model.js');
const clone = value => JSON.parse(JSON.stringify(value));
function fn(name) {
  let start = html.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  if (html.slice(start - 6, start) === 'async ') start -= 6;
  return html.slice(start, html.indexOf('\n}', start) + 2);
}
function appSource() {
  const start = html.indexOf('const App = {');
  return html.slice(start, html.indexOf('\n};', start) + 3) + '\nglobalThis.app = App;';
}
function clientSource() {
  const start = html.indexOf('const SupabaseClient = (() => {');
  return html.slice(start, html.indexOf('\n})();', start) + 6) + '\nglobalThis.client = SupabaseClient;';
}
const noNetwork = () => { throw new Error('unexpected network or authentication'); };
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

async function main() {
  // All inline classic scripts remain syntactically valid after local-mode hooks.
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!/\bsrc=|type=["']module/.test(match[1])) new vm.Script(match[2]);
  }

  const rpcCalls = [];
  const core = vm.createContext({ console, Map, Set, URLSearchParams, setTimeout, clearTimeout,
    window: { DESI_OFFLINE: true, DesiLocalMrm: { rpc: async (name, args) => { rpcCalls.push([name, args]); return { ok_count: 1 }; } } },
    location: { hash: '#share=old-cloud&folder=old-folder' },
    document: { getElementById: () => null },
    SUPABASE_URL: '', SUPABASE_ANON_KEY: '', supabase: { createClient: noNetwork },
    sessionStorage: { getItem: noNetwork, setItem: noNetwork }, fetch: noNetwork, XMLHttpRequest: noNetwork,
    ProjectStorage: { putProject: async project => { core.saved = clone(project); } },
    showToast() {},
  });
  vm.runInContext([fn('detachOfflineProject'), fn('_readCachedMasterPw'), fn('_saveCachedMasterPw'), appSource(), clientSource()].join('\n'), core);
  assert.equal(core.client.configured(), false);
  assert.equal(core.client.publicUrl('atlases', 'remote/file.png'), null);
  await assert.rejects(() => core.client.unlockProject('old', 'secret'), /オフライン/);
  await assert.rejects(() => core.client.uploadBlob('atlases', 'x', new Blob(['x'])), /offline_cloud_disabled/);
  assert.equal(core._readCachedMasterPw(), 'offline-local');
  core._saveCachedMasterPw('offline-local');
  assert.equal(core.app._readShareSlug(), null);
  assert.equal(core.app._readFolderSlug(), null);
  core.app.project = { id: 'local', sections: [], rois: [{ id: 'roi', polysBySection: { sec: [[0, 0], [1, 0], [0, 1]] } }],
    __share: true, __publishPending: true, shareInfo: { slug: 'old', viewerPassword: 'never-publish' } };
  core.app._saveRevision = 1;
  core.app._publishDirty = true;
  assert.equal(await core.app._doSave(), true, 'cloud-derived local project must persist edits');
  assert.equal(core.saved.rois.length, 1);
  assert.equal(core.saved.__share, undefined);
  assert.equal(core.saved.shareInfo, undefined);
  assert.equal(core.saved.__publishPending, undefined);
  assert.equal(core.app._autoPublishTimer, undefined, 'local save must never schedule cloud synchronization');
  await core.app.autoPublishProject();
  await core.app._refreshMasterCollabRois();
  core.app._startMasterCollabPoll();
  assert.equal(await core.app._serverIsNewerThanLocal(core.app.project), false);
  await core.client.registerFromResultBatch('offline-local', [{ name: 'sample', project_local_id: 'local' }]);
  assert.equal(rpcCalls[0][0], 'register_from_result_batch');
  assert.equal(rpcCalls[0][1]._rows[0].project_local_id, 'local');
  // The auth bypass is tied to the offline flag and does not disable online gating.
  assert.match(html, /if \(!shareSlug && !this\.offline\)/);
  core.window.DESI_OFFLINE = false;
  assert.equal(core.app._readShareSlug(), 'old-cloud');
  core.window.DESI_OFFLINE = true;

  // Online mode retains the configured Supabase client and authentication RPCs.
  const onlineCalls = [], clientCreations = [];
  const online = vm.createContext({ console,
    window: { DESI_OFFLINE: false, DesiLocalMrm: { rpc: noNetwork } },
    SUPABASE_URL: 'https://configured.invalid', SUPABASE_ANON_KEY: 'public-anon-key',
    supabase: { createClient: (...args) => {
      clientCreations.push(args);
      return { rpc: async (name, params) => { onlineCalls.push([name, clone(params)]); return { data: 'online-result', error: null }; } };
    } },
  });
  vm.runInContext(clientSource(), online);
  assert.equal(online.client.configured(), true);
  assert.equal(await online.client.unlockProject('shared-project', 'viewer-pw'), 'online-result');
  await online.client.listMrmLibrary('master-pw');
  assert.equal(clientCreations.length, 1);
  assert.deepEqual(clientCreations[0].slice(0, 2), ['https://configured.invalid', 'public-anon-key']);
  assert.equal(clientCreations[0][2].auth.persistSession, false);
  assert.deepEqual(onlineCalls, [
    ['unlock_project', { p_slug: 'shared-project', p_password: 'viewer-pw' }],
    ['list_mrm_library', { _master_pw: 'master-pw' }],
  ]);

  // Exercise the actual startup route selection: an explicit missing local
  // project must never substitute the last open project (for example from MRM history).
  const routeStart = html.indexOf("        const requestedId = params.get('project') || '';");
  const routeEnd = html.indexOf('\n    },', routeStart);
  const routeCalls = [], routeNotices = [];
  const routing = vm.createContext({ console, params: new URLSearchParams('?project=missing-project'),
    localStorage: { getItem: () => 'other-project' }, showToast: text => routeNotices.push(text),
    location: { replace: noNetwork }, ProjectStorage: { listProjects: async () => [] } });
  const route = vm.runInContext('(async function () {\n' + html.slice(routeStart, routeEnd) + '\n})', routing);
  const routeApp = { offline: true, project: null,
    openProject: async id => { routeCalls.push(id); routeApp.project = id === 'other-project' ? { id } : null; },
    renderEmpty() {}, wireUi() {}, _fillProjectPicker() {} };
  await route.call(routeApp);
  assert.deepEqual(routeCalls, ['missing-project']);
  assert.equal(routeApp.project, null);
  assert.ok(routeNotices.some(text => /指定されたプロジェクトがこのPCにありません/.test(text)));
  routeCalls.length = 0;
  routing.params = new URLSearchParams('');
  await route.call(routeApp);
  assert.deepEqual(routeCalls, ['other-project'], 'last project still opens when no explicit project was requested');

  const blobs = new Map();
  const savedProjects = new Map();
  const source = new Blob([Uint8Array.from([0, 255, 128, 42])], { type: 'image/png' });
  blobs.set('image', { blob: source, mime: 'image/png' });
  let sequence = 0;
  const transport = vm.createContext({ console: { warn() {}, error() {} }, Blob, Map, Set, Promise,
    window: { DESI_OFFLINE: true }, fetch: noNetwork, SupabaseClient: { publicUrl: noNetwork },
    RoiMediaModel, DEFAULT_ANATOMY_PALETTE: {},
    loadScript: async () => {}, LAZY_LIBS: { jszip: 'local-jszip' }, JSZip: MemoryZip,
    uid: p => p + '-' + (++sequence), nowIso: () => '2026-10-09T00:00:00Z',
    ensureMemoShape: x => x || {}, safeName: x => x, freezeMsiSourceReferences() {}, alignmentImageIdentity: ent => ent.blobId,
    buildSampleCsvGroups: async () => [], _yieldUi: async () => {}, blobContentSig: async () => null,
    bakeAlignedHeToMsiPng: async () => null,
    openPublishProgressModal: () => ({ update() {}, close() {} }),
    alert: value => transport.alerts.push(String(value)), alerts: [], showToast() {},
    downloadAsFile: value => { transport.exported = value; },
    ProjectStorage: { getBlob: async id => blobs.get(id), putBlob: async rec => blobs.set(rec.id, rec),
      getProject: async id => savedProjects.get(id) || null,
      putProject: async (project, options) => {
        // The ZIP suite exercises the production transaction; this UI fixture
        // observes its createOnly contract, including the committed fallback ID.
        if (options && options.createOnly) {
          while (savedProjects.has(project.id)) project.id = transport.uid('proj');
        }
        transport.saved = clone(project); savedProjects.set(project.id, clone(project));
      } },
    App: { panels: new Map(), openProject: async () => {}, otsuBgRemove: false, otsuStrength: 0 },
  });
  vm.runInContext('let _exportInProgress = false;\n' + [
    'detachOfflineProject', 'sanitizeStorageKeySegment', 'guessMimeFromPath', 'remapRoiGeometry',
    'roiMediaForTransport', 'roiMediaReadOriginal', 'roiMediaPublicItem', 'exportProjectAsZip', 'importZipFile',
    'ensureLocalBlob', 'parquetSrcForEnt', 'parquetSrcFromBlob', 'parquetSrcFromUrl',
  ].map(fn).join('\n'), transport);
  transport.App.project = { id: 'local', displayName: 'Local project', memo: { freeNote: 'retained memo' },
    sections: [{ id: 'section', ordinal: 1, images: { HE: { blobId: 'image', filename: 'original.png', mime: 'image/png' } }, msiSeries: {} }],
    rois: [{ id: 'old-roi-id', colorKey: 'Red', name: 'ROI', polysBySection: { section: [[0, 0], [1, 0], [0, 1]] },
      geometryBySection: { section: { version: 'msi-source-v1', sourceRef: 'retained' } } }],
    roiHidden: { 'old-roi-id': true }, meta: { colormap: 'viridis', msiSmoothing: 'linear' },
    overlays: [{ id: 'overlay', name: 'Saved overlay', channels: ['MSI_A'] }],
    shareInfo: { slug: 'cloud', viewerPassword: 'secret' }, __publishPending: true };
  await transport.exportProjectAsZip();
  assert.deepEqual(transport.alerts, []);
  assert.ok(transport.exported);
  const zip = transport.exported;
  const manifest = JSON.parse(await zip.file('Local project.json').async('string'));
  assert.equal(manifest.shareInfo, undefined);
  assert.equal(manifest.offlineSettings.meta.colormap, 'viridis');
  await transport.importZipFile(zip);
  assert.equal(transport.saved.id, 'local', 'recovery preserves an unused original project ID for MRM history');
  assert.equal(transport.saved.shareInfo, undefined);
  assert.equal(transport.saved.__publishPending, undefined);
  assert.equal(transport.saved.memo.freeNote, 'retained memo');
  assert.equal(transport.saved.meta.msiSmoothing, 'linear');
  assert.equal(transport.saved.overlays[0].name, 'Saved overlay');
  assert.equal(transport.saved.roiHidden[transport.saved.rois[0].id], true);
  assert.deepEqual(transport.saved.rois[0].polysBySection[transport.saved.sections[0].id], [[0, 0], [1, 0], [0, 1]]);
  const restored = blobs.get(transport.saved.sections[0].images.HE.blobId).blob;
  assert.deepEqual(Buffer.from(await restored.arrayBuffer()), Buffer.from(await source.arrayBuffer()));
  core.window.DESI_OFFLINE = false;
  core.app.project = clone(transport.saved);
  core.app._publishDirty = true;
  core.setTimeout = noNetwork;
  core.app._scheduleAutoPublish();
  await core.app.autoPublishProject();
  assert.equal(core.app._autoPublishTimer, undefined, 'restored portable project never starts online publication automatically');
  core.window.DESI_OFFLINE = true;

  // New, import, and picker selection use the same production openProject
  // path. Its URL must identify the displayed project so reload is coherent.
  const localLocation = { href: 'http://127.0.0.1:8765/viewer/?project=previous&import=cloud&extra=kept#share=old&focus=MSI_A' };
  const lastProject = new Map();
  const node = { value: '', style: {}, classList: { toggle() {} } };
  const opening = vm.createContext({ console, URL, URLSearchParams, Map, Set, setTimeout, clearTimeout,
    window: { DESI_OFFLINE: true }, location: localLocation,
    history: { state: { retained: true }, replaceState: (_state, _title, next) => { localLocation.href = new URL(next, localLocation.href).href; } },
    document: { body: { classList: { remove() {} } }, getElementById: () => node },
    ProjectStorage: { getProject: async id => clone(savedProjects.get(id) || null),
      putProject: async project => savedProjects.set(project.id, clone(project)), deleteProject: async id => savedProjects.delete(id) },
    localStorage: { setItem: (key, value) => lastProject.set(key, value), removeItem: key => lastProject.delete(key) },
    SharePreview: { isOpen: () => false }, _roiRawGridCache: new Map(), parquetReleaseAll() {},
    DEFAULT_ANATOMY_PALETTE: {}, ensureMemoShape: x => x || {}, backfillLegacyCompoundMeta() {},
    populateRoiList() {}, setupGraphSelector() {}, renderMemoForm() {}, COLORMAPS: {},
    showToast() {}, confirm: () => true, uid: prefix => prefix + '-new-url', nowIso: () => '2026-10-09T00:00:00Z',
  });
  vm.runInContext(fn('detachOfflineProject') + '\n' + appSource(), opening);
  Object.assign(opening.app, { _flushSave: async () => true, sectionVisibility: () => ({ ensure() {} }),
    rebuildSectionPanels: async () => {}, refreshAnalysisScope() {}, refreshProjectPicker: async () => {},
    refreshShareInfoButton() {}, renderAnalysis() {}, renderEmpty() {} });
  await opening.app.openProject('local');
  assert.equal(new URL(localLocation.href).searchParams.get('project'), opening.app.project.id);
  assert.equal(new URL(localLocation.href).searchParams.get('import'), null);
  assert.equal(new URL(localLocation.href).searchParams.get('extra'), 'kept');
  assert.equal(new URLSearchParams(new URL(localLocation.href).hash.slice(1)).get('share'), null);
  assert.equal(new URLSearchParams(new URL(localLocation.href).hash.slice(1)).get('focus'), 'MSI_A');
  const createdId = await opening.app.createNewProject('New project');
  assert.equal(new URL(localLocation.href).searchParams.get('project'), createdId);
  await opening.app.openProject('local');
  assert.equal(new URL(localLocation.href).searchParams.get('project'), 'local', 'picker changes the URL to the selected project');
  transport.App.openProject = id => opening.app.openProject(id);
  const originalRecovery = clone(savedProjects.get('local'));
  await transport.importZipFile(zip);
  assert.notEqual(transport.saved.id, 'local', 'duplicate import creates a separate project');
  assert.equal(new URL(localLocation.href).searchParams.get('project'), transport.saved.id, 'ZIP import updates stale project query');
  assert.deepEqual(savedProjects.get('local'), originalRecovery, 'duplicate import never overwrites the first recovery');
  await opening.app.openProject(null);
  assert.equal(new URL(localLocation.href).searchParams.get('project'), null, 'clearing selection removes stale project query');
  await opening.app.openProject(createdId);
  await opening.app.deleteCurrentProject();
  assert.equal(new URL(localLocation.href).searchParams.get('project'), null, 'deleting a project removes stale project query');
  for (const invalidId of ['', 17, 'bad\"id', '../invalid', 'too-long'.repeat(40)]) {
    const invalidZip = new MemoryZip().file('Invalid.json', JSON.stringify({
      format: 'desi_data_share_v2', id: invalidId, displayName: 'Invalid ID', sections: [], rois: [],
    }));
    await transport.importZipFile(invalidZip);
    assert.match(transport.saved.id, /^proj-/);
  }

  // Missing cloud-only originals surface actionable errors before fetch or output.
  await assert.rejects(() => transport.ensureLocalBlob({ blobId: 'absent', storagePath: 'cloud/file' }), /このPCに原本がありません/);
  await assert.rejects(() => transport.parquetSrcForEnt({ sourceUrl: 'https:\/\/cloud.invalid\/file' }), /元の Parquet/);
  await assert.rejects(() => transport.roiMediaReadOriginal({ storagePath: 'cloud/photo', filename: 'photo.png' }), /このPCにROI写真/);
  const localParquet = await transport.parquetSrcForEnt({ blobId: 'image', sourceUrl: 'https:\/\/cloud.invalid\/file' });
  assert.equal(localParquet.blob, source, 'offline local blob wins over an old cloud URL');
  delete zip.files[manifest.sections[0].images.HE.fullPath];
  transport.saved = null;
  await assert.rejects(() => transport.importZipFile(zip), /ZIPに原本がありません/);
  assert.equal(transport.saved, null, 'an incomplete archive must not create a partially restored project');
  transport.exported = undefined;
  blobs.delete('image');
  await transport.exportProjectAsZip();
  assert.equal(transport.exported, undefined);
  assert.match(transport.alerts[0], /HE\/IF 原本がありません/);
  console.log('Offline viewer regression: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
