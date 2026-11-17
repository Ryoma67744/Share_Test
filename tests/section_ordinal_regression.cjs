'use strict';
// Exercise the real section-editing methods and publication snapshot builder.
// Only UI/storage/network boundaries are synthetic; no user data is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Safety = require('../viewer/publish-safety.js');
const html = fs.readFileSync(require.resolve('../viewer/index.html'), 'utf8');
const copy = value => JSON.parse(JSON.stringify(value));
let checks = 0;

function source(name, method = false) {
  const marker = method ? '    async ' + name + '(' : 'function ' + name + '(';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, 'Production function exists: ' + name);
  const end = html.indexOf(method ? '\n    },' : '\n}', start);
  assert.notEqual(end, -1, 'Production function ends: ' + name);
  return html.slice(start, end + (method ? 6 : 2));
}

function viewerFixture() {
  let sequence = 0;
  const saved = [], verified = [], deletedBlobs = [], storedBlobs = [], errors = [];
  const node = {appendChild() {}, classList: {add() {}, toggle() {}}};
  const ctx = vm.createContext({
    Map, Set, Blob,
    console: {error: (...args) => errors.push(args), warn: (...args) => errors.push(args)},
    document: {getElementById: () => node},
    uid: prefix => prefix + '-' + (++sequence),
    nowIso: () => '2026-11-18T00:00:00.000Z',
    showToast() {}, populateRoiList() {}, renderMethodTable() {}, _bumpMethodSeries() {},
    parquetAliasFileState() {},
    ProjectArchive: {registeredSource: () => ({version: 1, basis: 'registered-source'})},
    ProjectStorage: {
      deleteBlob: async id => deletedBlobs.push(id),
      putBlob: async record => storedBlobs.push(record)
    },
    openPublishProgressModal: () => ({update() {}, close() {}}),
    SectionPanel: class {
      constructor(section) { this.section = section; this.root = {}; }
      async loadAllLayers() {}
      destroy() {}
    }
  });
  vm.runInContext(source('nextSectionOrdinal') + '\n globalThis.ui = {' +
    ['addSection', 'addParquetSource', 'deleteSection'].map(name => source(name, true)).join(',\n') + '};', ctx);
  Object.assign(ctx.ui, {
    project: {id: 'local-fixture', sections: [], rois: []}, panels: new Map(),
    setActiveSection(id) { this.activeSectionId = id; },
    recomputeMsiAbsScale() {}, refreshOrganFilter() {}, renderAnalysis() {},
    async queueSave() { saved.push(copy(this.project)); },
    async _flushSave() {},
    async _verifyPersistence(action, expected) { verified.push({action, ...expected}); }
  });
  return {ctx, saved, verified, deletedBlobs, storedBlobs, errors};
}

async function editingChecks() {
  const f = viewerFixture(), app = f.ctx.ui;
  await app.addSection(); await app.addSection(); await app.addSection();
  const [first, middle, last] = app.project.sections;
  app.project.rois = [{name: 'retained ROI', polysBySection: {
    [first.id]: [[0, 0], [1, 0], [0, 1]], [last.id]: [[1, 1], [2, 1], [1, 2]]
  }}];
  const before = copy(app.project.rois);
  await app.deleteSection(middle.id);
  assert.deepEqual(copy(app.project.sections.map(s => s.ordinal)), [1, 3]);
  await app.addSection();
  assert.deepEqual(copy(app.project.sections.map(s => s.ordinal)), [1, 3, 4],
    'Deleting a middle section must not reuse a surviving ordinal');
  assert.equal(app.project.sections[0], first);
  assert.equal(app.project.sections[1], last);
  assert.equal(app.project.sections[2].displayName, 'Section 4');
  assert.deepEqual(copy(app.project.rois), before);
  assert.deepEqual(f.verified.at(-1), {action: 'addSection', sectionCount: 3});
  checks += 7;

  // Parquet registration appends several sections after another deletion.
  await app.deleteSection(app.project.sections[2].id);
  const mainFile = Object.assign(new Blob(['synthetic parquet boundary']), {name: 'fixture.parquet'});
  f.ctx.openParquetWizard = async () => ({
    mainFile, labels: ['Cortex A', 'Cortex B'], geom: {sections: [
      {label: 'Cortex A', W: 2, H: 2}, {label: 'Cortex B', W: 3, H: 2}
    ]}, features: [{key: 'MSI_A', colIdx: 2, meta: {name: 'synthetic'}, max: 9}], dupWarn: 0
  });
  await app.addParquetSource();
  assert.deepEqual(copy(app.project.sections.map(s => s.ordinal)), [1, 3, 4, 5]);
  assert.deepEqual(copy(app.project.sections.slice(2).map(s => s.displayName)), ['Cortex A', 'Cortex B']);
  assert.equal(f.storedBlobs.length, 1, 'All parquet sections share one registered original');
  assert.equal(f.storedBlobs[0].blob, mainFile);
  assert.equal(app.project.sections[2].msiSeries.MSI_A.blobId, app.project.sections[3].msiSeries.MSI_A.blobId);
  assert.deepEqual(copy(app.project.rois), before);
  assert.equal(f.saved.at(-1).sections.length, 4);
  assert.deepEqual(f.errors, []);
  checks += 8;

  const next = f.ctx.nextSectionOrdinal;
  for (const [values, expected] of [
    [[], 1], [[1, 3], 4], [[3, 3], 4], [[0, 1], 2],
    [[undefined, null, -3, 1.5, NaN, Infinity, 2147483648], 1],
    [[1, 2, 2147483647], 3], [[2147483647], 1]
  ]) {
    const sections = values.map((ordinal, i) => ({id: 's' + i, ordinal}));
    const original = structuredClone(sections);
    assert.equal(next(sections), expected);
    assert.deepEqual(sections, original, 'Allocation leaves existing sections unchanged');
    checks += 2;
  }
}

function publishFixture(ordinals) {
  const original = new Blob(['immutable fixture original'], {type: 'text/plain'});
  const project = {
    id: 'publish-fixture', displayName: 'Preserved project', storageRevision: 4,
    publishEditEpoch: 2, memo: {freeNote: 'before'},
    sections: ordinals.map((ordinal, i) => ({id: 'section-' + i, ordinal,
      displayName: 'Specimen ' + i, meta: {specimen: {name: 'sample-' + i}},
      images: {}, msiSeries: {MSI_A: {blobId: 'shared-original', filename: 'original.txt',
        sourceFileId: 'file-a', annotation: 'annotation-' + i}},
      msiFiles: {'file-a': {blobId: 'shared-original', filename: 'original.txt', kind: 'txt'}}})),
    rois: []
  };
  if (project.sections.length) project.rois.push({name: 'ROI with stable IDs', colorKey: 'Red',
    polysBySection: Object.fromEntries(project.sections.map((s, i) => [s.id, [[i, 0], [i + 1, 0], [i, 1]]]))});
  let sequence = 0;
  const logs = {commits: [], intents: [], uploads: [], receipts: [], sessions: [], releases: []};
  const meta = {slug: 'ordinal-fixture', isPublic: true};
  const hooks = {
    uuid: () => '00000000-0000-4000-8000-' + String(++sequence).padStart(12, '0'),
    freezeSources() {}, media: () => ({items: []}), publicPhoto: copy,
    imageIdentity: () => null, viewerOverlay: () => false,
    encodeRoi: (roi, sectionId) => copy(roi.polysBySection[sectionId]),
    url: slug => 'https://example.invalid/' + slug,
    state: async () => ({protocol: 2, exists: false, receipt: null}),
    session: async job => { logs.sessions.push(copy(job)); return {protocol: 2, token: 'fixture-ticket',
      object_prefix: job.slug + '/publish-v2/' + job.jobId + '/'}; },
    blob: async () => ({blob: original, mime: 'text/plain'}), exists: async () => true,
    remoteBlob: async () => null, pin: async () => {},
    release: async id => logs.releases.push(id), intent: async intent => logs.intents.push(copy(intent)),
    upload: async (path, blob) => logs.uploads.push({path, blob}),
    start() {}, progress() {}, assertActive() {}, close() {},
    commit: async args => { logs.commits.push(copy(args)); return {ok: true, protocol: 2,
      slug: args._slug, request_id: args._request_id, server_revision: args._expected_revision + 1,
      committed_at: '2026-11-18T00:00:00.000Z'}; },
    receipt: async receipt => logs.receipts.push(copy(receipt))
  };
  return {project, meta, hooks, logs, original};
}

async function publicationChecks() {
  for (const ordinals of [[1, 3, 3], [undefined, undefined, undefined], [0, 1, 2],
    [3, 1, 2], [1, 100, 900], [-1, 1.5, '3'], [2147483647, 2147483648], []]) {
    const f = publishFixture(ordinals), before = structuredClone(f.project);
    await Safety.run(f.project, f.meta, f.hooks);
    const doc = f.logs.commits[0];
    assert.deepEqual(doc._sections.map(s => s.ordinal), ordinals.map((_, i) => i + 1),
      'Publication order follows the displayed section array, including legacy malformed ordinals');
    assert.deepEqual(doc._sections.map(s => s.id), before.sections.map(s => s.id));
    assert.deepEqual(doc._sections.map(s => s.displayName), before.sections.map(s => s.displayName));
    assert.deepEqual(doc._sections.map(s => s.meta), before.sections.map(s => ({...s.meta, overlays: []})));
    assert.deepEqual(doc._rois.map(r => r.sectionId), before.sections.map(s => s.id));
    assert.deepEqual(doc._rois.map(r => r.polyMsi), before.sections.map(s => before.rois[0].polysBySection[s.id]));
    assert.deepEqual(f.project, before, 'Publication repairs its snapshot without mutating local data');
    assert.equal(f.logs.uploads.length, ordinals.length ? 1 : 0);
    if (ordinals.length) {
      const path = f.logs.uploads[0].path;
      assert.equal(f.logs.uploads[0].blob, f.original);
      assert.ok(doc._sections.every(s => s.storagePaths.msiSeries.MSI_A.path === path &&
        s.storagePaths.msiFiles['file-a'].path === path));
      assert.deepEqual(doc._sections.map(s => s.storagePaths.msiSeries.MSI_A.annotation),
        before.sections.map(s => s.msiSeries.MSI_A.annotation));
      checks += 3;
    }
    checks += 8;
  }

  // Capture order before the first await; edits during upload belong to a later publication.
  const f = publishFixture([1, 3, 3]), before = copy(f.project);
  const session = f.hooks.session;
  let release;
  f.hooks.session = job => new Promise(resolve => { release = () => resolve(session(job)); });
  const running = Safety.run(f.project, f.meta, f.hooks);
  f.project.sections.reverse();
  f.project.sections[0].displayName = 'new local name';
  f.project.sections[0].ordinal = 99;
  f.project.sections[0].msiSeries.MSI_A.blobId = 'new local source';
  f.project.publishEditEpoch++;
  const edited = copy(f.project);
  release(); await running;
  assert.deepEqual(f.logs.commits[0]._sections.map(s => s.id), before.sections.map(s => s.id));
  assert.deepEqual(f.logs.commits[0]._sections.map(s => s.ordinal), [1, 2, 3]);
  assert.deepEqual(f.logs.commits[0]._sections.map(s => s.displayName), before.sections.map(s => s.displayName));
  assert.deepEqual(f.project, edited);
  assert.equal(f.logs.receipts[0].publishedEditEpoch, before.publishEditEpoch);
  checks += 5;

  // A saved request is immutable even if it predates ordinal normalization.
  // The server hotfix repairs storage order; the client must retain this exact
  // payload so receipt lookup and the request hash still identify one attempt.
  const seed = publishFixture([1, 3, 3]);
  await Safety.run(seed.project, seed.meta, seed.hooks);
  const pending = copy(seed.logs.intents.at(-1));
  pending.commitArgs._sections.forEach((s, i) => { s.ordinal = [1, 3, 3][i]; });
  const retry = publishFixture([1, 3, 3]);
  retry.project.shareInfo = {slug: retry.meta.slug, pendingPublish: pending};
  await Safety.run(retry.project, retry.meta, retry.hooks);
  const replay = {...retry.logs.commits[0]}; delete replay._publish_token;
  assert.deepEqual(replay, pending.commitArgs);
  assert.equal(retry.logs.commits.length, 1);
  assert.equal(retry.logs.uploads.length, 0, 'Retry reuses already uploaded paths');
  assert.equal(retry.logs.intents.length, 0, 'Retry must not replace the saved immutable intent');
  assert.equal(retry.logs.receipts[0].jobId, pending.jobId);
  assert.deepEqual(retry.logs.releases, [pending.jobId]);
  checks += 6;
}

async function main() {
  await editingChecks();
  await publicationChecks();
  console.log('Section ordinal client regression: PASS (' + checks + ' checks)');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
