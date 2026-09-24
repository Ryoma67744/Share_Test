'use strict';

const assert = require('node:assert/strict');
const model = require('../viewer/roi-media-model.js');
const { create } = require('../viewer/roi-media-service.js');

function photo(name = 'cyst.png', signature = 'png') {
  const bytes = signature === 'png' ? [137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]
    : signature === 'jpeg' ? [255, 216, 255, 224, 1, 2, 3] : [37, 80, 68, 70];
  const file = new Blob([Uint8Array.from(bytes)], { type: 'application/octet-stream' });
  Object.defineProperty(file, 'name', { value: name });
  return file;
}
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
function harness(extra) {
  const section = { id: 'section-4', meta: {} };
  const roi = { id: 'roi-4', colorKey: 'ROI_4', name: 'tiny cyst',
    polysBySection: { 'section-4': [[20, 30], [22, 30], [22, 32], [20, 32]] },
    geometryBySection: { 'section-4': { version: 'msi-source-v1', sourceRef: 'brain-parquet-A' } } };
  const project = { id: 'project-1', sections: [section], rois: [roi], meta: { memo: 'Keep this' } };
  const blobs = new Map(), projects = new Map(), events = [];
  let nextId = 0;
  const state = { current: project, failBlob: false, failSave: false, decodeGate: null, saveGate: null,
    decoded: { width: 2048, height: 1536 }, disposals: 0, changed: 0, decodeCalls: 0 };
  const storage = {
    async getBlob(id) { return blobs.get(id); },
    async putBlob(record) {
      events.push('blob:' + record.id);
      if (state.failBlob) { const e = new Error('Storage quota'); e.name = 'QuotaExceededError'; throw e; }
      blobs.set(record.id, record);
      return record.id;
    },
    async deleteBlob() { throw new Error('Service must defer cross-project orphan deletion'); },
  };
  const service = create(Object.assign({ model, storage, uid: () => String(++nextId), now: () => '2026-09-24T12:00:00.000Z',
    isCurrent: p => state.current === p,
    sourceRef: (_p, r, s) => r.geometryBySection[s.id].sourceRef,
    async decode() {
      state.decodeCalls++;
      if (state.decodeGate) { const waiting = state.decodeGate; state.decodeGate = null; await waiting.promise; }
      return Object.assign({}, state.decoded, { dispose() { state.disposals++; } });
    },
    async save(p, expected) {
      assert.equal(p.meta.roiMedia, expected, 'save receives the exact new registry');
      events.push('project:' + p.id);
      const snapshot = structuredClone(p);
      if (state.saveGate) { const waiting = state.saveGate; state.saveGate = null; await waiting.promise; }
      if (state.failSave) return false;
      projects.set(p.id, snapshot);
      return true;
    },
    onChange() { state.changed++; },
  }, extra));
  return { service, state, project, roi, section, storage, projects, blobs, events };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  // Files are original Blobs; metadata is committed only after every blob put.
  const h = harness(), originalRoi = structuredClone(h.roi), file1 = photo(), file2 = photo('fluorescence.jpg', 'jpeg');
  const photos = await h.service.add(h.project, h.roi, h.section, [file1, file2], { magnification: '40', kind: 'HE' });
  assert.equal(photos.length, 2);
  assert.equal(photos[0].isPrimary, true);
  assert.equal(photos[1].isPrimary, false);
  assert.equal(photos[0].byteSize, file1.size);
  assert.equal(photos[0].mime, 'image/png', 'sniff actual content, independent of MIME metadata');
  assert.equal(photos[1].mime, 'image/jpeg');
  assert.equal(h.blobs.get(photos[0].blobId).blob, file1, 'original file retained without resampling');
  assert.match(h.events[0], /^blob:/);
  assert.match(h.events[1], /^blob:/);
  assert.equal(h.events[2], 'project:project-1');
  assert.equal(h.state.disposals, 2);
  assert.equal(h.state.changed, 1);
  assert.deepEqual(h.roi, originalRoi, 'registration never changes vertices/source metadata');
  assert.deepEqual(h.projects.get(h.project.id).meta.roiMedia, h.project.meta.roiMedia, 'reload reconstructs saved records');
  assert.equal(h.project.meta.memo, 'Keep this');
  await h.service.idle(h.project);
  assert.equal(h.service.isBusy(h.project), false);

  const second = await h.service.makePrimary(h.project, h.roi, h.section, photos[1]);
  assert.equal(second.isPrimary, true);
  assert.equal(model.list(h.project, h.roi, h.section)[0].id, photos[1].id);
  const edited = await h.service.update(h.project, h.roi, h.section, second, { title: 'New x40 fluorescence', note: 'after MSI',
    umPerPixel: { x: 0.24, y: 0.25 }, roiKey: 'evil', sectionId: 'elsewhere' });
  assert.equal(edited.title, 'New x40 fluorescence');
  assert.equal(edited.roiKey, 'ROI_4');
  assert.equal(edited.sectionId, 'section-4');
  assert.equal(edited.revision, second.revision + 1);
  await assert.rejects(h.service.update(h.project, h.roi, h.section, second, { title: 'stale' }), { code: 'revision-conflict' });
  const replaced = await h.service.replace(h.project, h.roi, h.section, edited, photo('retaken.png'));
  assert.equal(replaced.id, edited.id);
  assert.equal(replaced.order, edited.order);
  assert.equal(replaced.isPrimary, edited.isPrimary);
  assert.equal(replaced.magnification, edited.magnification);
  assert.notEqual(replaced.blobId, edited.blobId);
  assert.equal(h.blobs.has(edited.blobId), true, 'old original retained for safe cross-project GC');
  assert.deepEqual(replaced.roiSnapshot, model.snapshot(h.roi, h.section));
  await h.service.remove(h.project, h.roi, h.section, replaced);
  assert.equal(model.list(h.project, h.roi, h.section).length, 1);
  assert.equal(model.list(h.project, h.roi, h.section)[0].isPrimary, true);
  assert.deepEqual(h.roi, originalRoi, 'metadata edits/removal never affect quantification geometry');

  // Failed replacement, quota failure and failed batch preserve the old list.
  const before = structuredClone(h.project.meta.roiMedia), existing = model.list(h.project, h.roi, h.section)[0];
  h.state.failSave = true;
  await assert.rejects(h.service.replace(h.project, h.roi, h.section, existing, photo('not-saved.png')), { code: 'save-failed' });
  assert.deepEqual(h.project.meta.roiMedia, before);
  assert.deepEqual(h.projects.get(h.project.id).meta.roiMedia, before);
  assert.equal(h.blobs.has(existing.blobId), true);
  h.state.failSave = false;
  h.state.failBlob = true;
  await assert.rejects(h.service.replace(h.project, h.roi, h.section, existing, photo('quota.png')), { name: 'QuotaExceededError' });
  assert.deepEqual(h.project.meta.roiMedia, before);
  h.state.failBlob = false;
  await assert.rejects(h.service.add(h.project, h.roi, h.section, [photo(), photo('bad.pdf', 'pdf')]), { code: 'unsupported-file' });
  assert.deepEqual(h.project.meta.roiMedia, before, 'no partial batch metadata committed');

  // Read-only, deleted targets and malformed polygons cannot write a blob.
  for (const transform of [t => { t.project.__share = {}; }, t => { t.roi._collab = {}; }, t => { t.project.rois = []; },
    t => { t.project.sections = []; }, t => { t.roi.polysBySection[t.section.id][0][0] = NaN; }]) {
    const t = harness(); transform(t);
    await assert.rejects(t.service.add(t.project, t.roi, t.section, [photo()]));
    assert.equal(t.events.length, 0);
  }

  // Async decode may outlive an open project, an ROI redraw, or a source swap.
  for (const transform of [t => { t.state.current = {}; }, t => { t.roi.polysBySection[t.section.id][0][0] += 0.5; },
    t => { t.roi.geometryBySection[t.section.id].sourceRef = 'different-source'; }]) {
    const t = harness(), waiting = gate();
    t.state.decodeGate = waiting;
    const pending = t.service.add(t.project, t.roi, t.section, [photo()]);
    await tick(); transform(t); waiting.release();
    await assert.rejects(pending);
    assert.equal(t.events.length, 0, 'stale geometry/project aborted before any storage write');
    assert.equal(model.allItems(t.project).length, 0);
  }

  // A different registry update must not be lost after a slow file decode.
  {
    const t = harness();
    const [first] = await t.service.add(t.project, t.roi, t.section, [photo()]);
    const waiting = gate(); t.state.decodeGate = waiting;
    const pending = t.service.add(t.project, t.roi, t.section, [photo('late.png')]);
    await tick();
    t.project.meta.roiMedia = model.update(t.project.meta.roiMedia, first.id, { note: 'external update' });
    waiting.release();
    await assert.rejects(pending, { code: 'registry-conflict' });
    assert.equal(model.allItems(t.project)[0].note, 'external update');
    assert.equal(model.allItems(t.project).length, 1);
  }

  // Same-project additions queue without overwriting the previous addition.
  {
    const t = harness(), waiting = gate(); t.state.decodeGate = waiting;
    const first = t.service.add(t.project, t.roi, t.section, [photo('1.png')]);
    const next = t.service.add(t.project, t.roi, t.section, [photo('2.png')]);
    assert.equal(t.service.isBusy(t.project), true);
    await tick();
    assert.equal(t.state.decodeCalls, 1, 'second batch waits for first transaction');
    waiting.release();
    await Promise.all([first, next]);
    await t.service.idle(t.project);
    assert.equal(t.service.isBusy(t.project), false);
    assert.equal(model.allItems(t.project).length, 2);
    assert.equal(t.projects.get(t.project.id).meta.roiMedia.items.length, 2);
  }

  // Rollback owns only its exact registry and never unrelated live changes.
  {
    const t = harness(), waiting = gate(); t.state.saveGate = waiting; t.state.failSave = true;
    const pending = t.service.add(t.project, t.roi, t.section, [photo()]);
    await tick(); t.project.meta.memo = 'User edited memo while saving'; waiting.release();
    await assert.rejects(pending, { code: 'save-failed' });
    assert.equal(t.project.meta.memo, 'User edited memo while saving');
    assert.equal(Object.hasOwn(t.project.meta, 'roiMedia'), false);
  }
  for (const mutateInPlace of [false, true]) {
    let rollbacks = 0;
    const t = harness({ onRollback:async () => { rollbacks++; } }), waiting = gate(); t.state.saveGate = waiting; t.state.failSave = true;
    const pending = t.service.add(t.project, t.roi, t.section, [photo()]);
    await tick();
    if (mutateInPlace) t.project.meta.roiMedia.items[0].note = 'newer registry';
    else t.project.meta.roiMedia = model.update(t.project.meta.roiMedia, t.project.meta.roiMedia.items[0].id, { note: 'newer registry' });
    waiting.release(); await assert.rejects(pending);
    assert.equal(model.allItems(t.project)[0].note, 'newer registry', 'never roll back newer external registry edits');
    assert.equal(rollbacks, 0, 'a newer registry must not trigger an old rollback write');
  }

  // Verification can fail after a successful database commit. Persist the
  // restored metadata as a new revision, so reopening cannot resurrect it.
  {
    let t, failReadback = false, saveRevision = 0, savedRevision = 0, rollbacks = 0;
    const verificationError = new Error('IDB readback unavailable');
    t = harness({
      async save(project) {
        saveRevision++;
        t.projects.set(project.id, structuredClone(project));
        savedRevision = saveRevision;
        if (failReadback) throw verificationError;
        return true;
      },
      async onRollback(project, registry, originalError) {
        rollbacks++;
        assert.equal(originalError, verificationError);
        assert.deepEqual(model.getRegistry(project), registry);
        saveRevision++; // App.queueSave must record rollback as its own edit.
        t.projects.set(project.id, structuredClone(project));
        savedRevision = saveRevision;
      },
    });
    const [original] = await t.service.add(t.project, t.roi, t.section, [photo('original.png')]);
    const registryBefore = structuredClone(t.project.meta.roiMedia);
    failReadback = true;
    await assert.rejects(t.service.replace(t.project, t.roi, t.section, original, photo('rejected.png')), error => error === verificationError);
    assert.equal(rollbacks, 1);
    assert.equal(saveRevision, 3);
    assert.equal(savedRevision, 3);
    assert.deepEqual(t.project.meta.roiMedia, registryBefore);
    assert.deepEqual(t.projects.get(t.project.id).meta.roiMedia, registryBefore, 'reload keeps the old original after failed readback');
    assert.equal(t.state.changed, 1, 'failed replacement does not announce success');
  }
  {
    const failure = new Error('Original save failure');
    const t = harness({ save:async () => { throw failure; }, onRollback:async () => { throw new Error('Rollback retry failed'); } });
    await assert.rejects(t.service.add(t.project, t.roi, t.section, [photo()]), error => error === failure);
    assert.equal(Object.hasOwn(t.project.meta, 'roiMedia'), false);
  }

  // Decode limits release temporary buffers and never persist invalid images.
  for (const decoded of [{ width: 0, height: 10 }, { width: 20000, height: 2 }, { width: 16384, height: 16384 },
    { width: 100, height: 100, pages: 2 }]) {
    const t = harness(); t.state.decoded = decoded;
    await assert.rejects(t.service.add(t.project, t.roi, t.section, [photo()]));
    assert.equal(t.state.disposals, 1);
    assert.equal(t.events.length, 0);
  }
  {
    const t = harness({ maxBytes: 5 });
    await assert.rejects(t.service.add(t.project, t.roi, t.section, [photo()]), { code: 'file-too-large' });
    assert.equal(t.state.decodeCalls, 0);
  }
  console.log('ROI media service regressions passed: original files, atomic metadata, rollback, target/revision guards, queue and limits.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
