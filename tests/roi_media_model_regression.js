'use strict';
const assert = require('node:assert/strict');
const model = require('../viewer/roi-media-model.js');
const copy = value => JSON.parse(JSON.stringify(value));
const section = { id: 'sec-1', meta: { client_id: 'original-client' } };
const geometry = { version: 'msi-source-v1', sourceRef: 'source-1', displayGeometry: {
  version: 'msi-proportional-v1', W: 8, H: 11,
  x: { origin: 1.5, step: 2 }, y: { origin: -3, step: 6 },
}, createdQuantVersion: 'msi-source-rows-v1' };
const roi = { id: 'browser-roi', colorKey: 'ROI_1', name: 'Cyst', rgba: [255, 0, 0, 255],
  polysBySection: { 'sec-1': [[1, 2], [3, 2], [3, 4], [1, 4]] },
  geometryBySection: { 'sec-1': copy(geometry) } };
const base = { id: 'image-1', roiKey: 'ROI_1', sectionId: 'sec-1', sourceRef: 'source-1',
  roiSnapshot: model.snapshot(roi, section), blobId: 'blob-original', mime: 'image/tiff',
  filename: '40x.tif', width: 6400, height: 4800, byteSize: 122880000, title: 'HE 40×', kind: 'HE',
  magnification: '40', createdAt: '2026-09-24T12:00:00Z', updatedAt: '2026-09-24T12:00:00Z' };
const empty = { version: 1, items: [] };
const before = JSON.stringify({ empty, base, roi });
const first = model.add(empty, base);
assert.equal(JSON.stringify({ empty, base, roi }), before, 'Adding a photograph cannot mutate ROI geometry or its input registry');
assert.equal(first.items[0].isPrimary, true);
assert.equal(first.items[0].byteSize, base.byteSize);
assert.equal(first.items[0].umPerPixel, null, 'Objective magnification must not create a spatial calibration');

const project = { sections: [section], rois: [roi], meta: { roiMedia: first } };
const detached = model.getRegistry(project);
detached.items[0].roiSnapshot.vertices[0][0] = 999;
assert.equal(project.meta.roiMedia.items[0].roiSnapshot.vertices[0][0], 1, 'Readback must be detached');
const renamed = { ...roi, id: 'server-roi-new-id', name: 'Renamed cyst', rgba: [0, 0, 255, 255] };
assert.equal(model.list(project, renamed, section).length, 1, 'ROI rename, repaint, and server ID replacement retain photos');
assert.equal(model.snapshotMatches(first.items[0], renamed, section), true);
const redrawn = copy(roi);
redrawn.polysBySection['sec-1'][0][0] = 1.25;
assert.equal(model.snapshotMatches(first.items[0], redrawn, section), false, 'A subpixel ROI redraw must be detected');
const anotherSource = copy(roi);
anotherSource.geometryBySection['sec-1'].sourceRef = 'other-acquisition';
assert.equal(model.snapshotMatches(first.items[0], anotherSource, section), false, 'A different measurement source must be detected');
const reorderedGeometry = copy(roi);
reorderedGeometry.geometryBySection['sec-1'] = { createdQuantVersion: geometry.createdQuantVersion,
  displayGeometry: geometry.displayGeometry, sourceRef: geometry.sourceRef, version: geometry.version };
assert.equal(model.snapshotMatches(first.items[0], reorderedGeometry, section), true, 'JSON object property order is not a geometry change');

let registry = model.add(first, { ...base, id: 'image-2', blobId: 'blob-other', isPrimary: true });
assert.deepEqual(registry.items.map(item => [item.id, item.order, item.isPrimary]), [['image-1', 0, false], ['image-2', 1, true]]);
registry = model.add(registry, { ...base, id: 'image-3', sectionId: 'sec-2', blobId: 'blob-original' });
assert.equal(registry.items.filter(item => item.isPrimary).length, 2, 'Each ROI and section pair has its own primary photo');
registry = model.makePrimary(registry, 'image-1');
assert.equal(registry.items.filter(item => item.sectionId === 'sec-1' && item.isPrimary)[0].id, 'image-1');
const removed = model.remove(registry, 'image-1');
assert.equal(removed.items.find(item => item.id === 'image-2').isPrimary, true, 'Deleting a representative promotes a surviving photo');
assert.equal(registry.items.length, 3, 'Deletion is immutable');
assert.deepEqual([...model.collectBlobIds({ meta: { roiMedia: registry } })].sort(), ['blob-original', 'blob-other']);
assert.equal(model.removeSection(registry, 'sec-1').items.length, 1);
assert.equal(model.removeRoi(registry, 'ROI_1').items.length, 0);

const edit = model.update(first, 'image-1', { title: 'New label', updatedAt: '2026-09-24T13:00:00Z',
  roiKey: 'hijack', sectionId: 'elsewhere', sourceRef: 'wrong-source', blobId: 'wrong-image',
  umPerPixel: { x: .17, y: .19 } });
assert.equal(edit.items[0].title, 'New label');
assert.equal(edit.items[0].revision, 2);
assert.equal(edit.items[0].roiKey, 'ROI_1');
assert.equal(edit.items[0].sectionId, 'sec-1');
assert.equal(edit.items[0].sourceRef, 'source-1');
assert.equal(edit.items[0].blobId, 'blob-original');
assert.deepEqual(edit.items[0].roiSnapshot, base.roiSnapshot);

const published = model.normalizeRegistry({ version: 1, items: [{ ...first.items[0], storagePath: 'project/roi-media/original.tif' }] });
const replaced = model.replace(published, 'image-1', { blobId: 'blob-retake', mime: 'image/png', filename: 'retake.png',
  width: 2048, height: 1024, byteSize: 1048576, roiSnapshot: model.snapshot(redrawn, section), sourceRef: 'source-1',
  updatedAt: '2026-09-24T13:00:00Z' });
assert.equal(replaced.items[0].storagePath, undefined, 'A retake must not retain the old published image reference');
assert.equal(replaced.items[0].id, 'image-1');
assert.equal(replaced.items[0].revision, 2);
assert.equal(replaced.items[0].order, 0);
assert.equal(replaced.items[0].isPrimary, true);
assert.equal(model.snapshotMatches(replaced.items[0], redrawn, section), true, 'A retake may explicitly confirm the current ROI shape');
assert.deepEqual(published.items[0].roiSnapshot, base.roiSnapshot, 'Replacement leaves prior saved revision untouched');
assert.throws(() => model.replace(first, 'image-1', { title: 'Missing new binary' }), { code: 'invalid-item' });

const imported = model.remapSections(registry, { 'sec-1': 'new-local-1', 'sec-2': 'new-local-2' });
assert.deepEqual(imported.items.map(item => item.sectionId), ['new-local-1', 'new-local-1', 'new-local-2']);
assert.deepEqual(imported.items[0].roiSnapshot, registry.items[0].roiSnapshot, 'Transport preserves scientific coordinate frames');
assert.equal(imported.items[0].sourceRef, 'source-1');
assert.throws(() => model.remapSections(registry, { 'sec-1': 'new-local-1' }), { code: 'unmapped-section' });
assert.equal(model.sectionKey(project, section), 'sec-1', 'A local section uses its actual local ID');
assert.equal(model.sectionKey({ __share: true }, section), 'original-client', 'A shared section uses its original client ID');
const serverSection = { id: 'server-section', meta: { client_id: 'sec-1' } };
const shared = { __share: true, meta: { roiMedia: first } };
assert.equal(model.list(shared, renamed, serverSection).length, 1);

const inheritedMap = Object.create({ 'sec-1': 'wrong-section' });
assert.throws(() => model.remapSections(first, inheritedMap), { code: 'unmapped-section' });
const prototypeNames = { ...base, id: '__proto__', roiKey: 'constructor', sectionId: '__proto__' };
const odd = model.add(null, prototypeNames);
const remappedOdd = model.remapSections(odd, JSON.parse('{"__proto__":"safe-new-section"}'));
assert.equal(remappedOdd.items[0].sectionId, 'safe-new-section');
assert.equal({}.polluted, undefined);
const inheritedRegistry = Object.create({ version: 1, items: [] });
assert.throws(() => model.normalizeRegistry(inheritedRegistry), { code: 'unsupported-version' });
for (const version of [0, 2, '1', undefined]) {
  const future = { version, items: [] }, original = JSON.stringify(future);
  assert.throws(() => model.normalizeRegistry(future), { code: 'unsupported-version' });
  assert.throws(() => model.add(future, base), { code: 'unsupported-version' });
  assert.equal(JSON.stringify(future), original, 'Unknown versions cannot be overwritten');
}
assert.throws(() => model.normalizeRegistry({ version: 1, items: [base, base] }), { code: 'invalid-registry' });
assert.throws(() => model.add(first, base), { code: 'duplicate-item' });
assert.throws(() => model.add(null, { ...base, roiSnapshot: { vertices: [[0, 0], [1, 0], [NaN, 1]], geometry: null } }), { code: 'invalid-item' });
assert.throws(() => model.add(null, { ...base, roiSnapshot: { vertices: [[0, 0], [1, 0], new Array(2)], geometry: null } }), { code: 'invalid-item' });
assert.throws(() => model.add(null, { ...base, sourceRef: 'wrong-frame' }), { code: 'invalid-item' });
assert.throws(() => model.update(first, 'image-1', { umPerPixel: { x: 0, y: .2 } }), { code: 'invalid-item' });
for (const storagePath of ['https://other.test/a.jpg', '//other.test/a.jpg', '../old.jpg', 'project/../old.jpg', 'project/%2e%2e/old.jpg', 'a%2fb', 'a\\b', 'a?token=x', 'a#x', 'a\nfile']) {
  assert.throws(() => model.add(null, { ...base, storagePath }), { code: 'invalid-item' });
}
assert.equal(model.add(null, { ...base, sourceRef: '', roiSnapshot: { vertices: base.roiSnapshot.vertices, geometry: null } }).items.length, 1,
  'Legacy ROI snapshots remain usable without claiming a known scientific source');
console.log('ROI media model regression: identity, immutable edits, retakes, primary photos, source snapshots, transport, validation and future-version protection passed');
