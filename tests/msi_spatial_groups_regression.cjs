'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Groups = require('../viewer/msi-spatial-groups.js');
const clone = value => JSON.parse(JSON.stringify(value));
const entry = (id, patch = {}) => ({kind: 'xlsx', sourceFileId: id, blobId: 'blob-' + id,
    sheet: 'Sheet1', col_x: 'A', col_y: 'B', col_v: 'C', data_start_row: 2, ...patch});
const geometry = (source, patch = {}) => ({sourceRef: Groups.sourceReference(source),
    legacy: {W: 3, H: 2, confirmed: true, x: [[10, 0], [12, 1], [14, 2]], y: [[20, 0], [23, 1]]},
    displayGeometry: {version: 'msi-proportional-v1', W: 3, H: 2,
        x: {origin: 10, step: 2}, y: {origin: 20, step: 3}}, ...patch});
const section = id => ({id, meta: {}, msiSeries: {}});

const a = entry('positive'), b = entry('negative'), ga = geometry(a), gb = geometry(b), s = section('section-1');
const originalA = clone(a), originalGeometry = clone(ga);
assert.equal(Groups.geometryKey(ga), Groups.geometryKey(gb), 'source identity does not define the shared coordinate frame');
assert.notEqual(Groups.memberKey(a), Groups.memberKey(b), 'different measurements retain distinct identities');
const first = Groups.ensureGroup(s, a, ga);
assert.equal(first.memberCount, 1);
assert.equal(Groups.resolveMembership(s, b, gb), null, 'exact coordinates alone do not enroll a measurement');
const roi = Groups.roiMeta(s, a, ga);
const registryBeforeRead = JSON.stringify(s.meta.spatialGroups);
assert.equal(Groups.roiCompatible(roi, gb, s, b), false);
assert.equal(JSON.stringify(s.meta.spatialGroups), registryBeforeRead, 'read-only resolution does not enroll a source');
const second = Groups.ensureGroup(s, b, gb);
assert.equal(second.groupId, first.groupId);
assert.equal(second.memberCount, 2);
assert.equal(Groups.roiCompatible(roi, ga, s, a), true);
assert.equal(Groups.roiCompatible(roi, gb, s, b), true, 'one saved ROI includes a later registered matching measurement');
assert.deepEqual(a, originalA); assert.deepEqual(ga, originalGeometry);
assert.notEqual(a.sourceFileId, b.sourceFileId);
assert.equal(s.meta.spatialGroups.groups.length, 1);
assert.equal(Groups.ensureGroup(s, a, ga).memberCount, 2, 'repeated registration is idempotent');
const currentOnly=clone(ga);
currentOnly.currentConfirmed=true;
currentOnly.legacy.confirmed=false;
currentOnly.legacy.reason='legacy-render-quant-axis-mismatch';
assert.equal(Groups.geometryKey(currentOnly),first.frameKey,'missing signal cannot change a confirmed current frame');
assert.equal(Groups.roiCompatible(roi,currentOnly,s,a),true);
currentOnly.legacy.x[1][0]=NaN;
assert.equal(Groups.geometryKey(currentOnly),null,'current confidence cannot bypass malformed coordinate validation');

// Molecule and intensity-only changes share a frame, but coordinate readers and
// source revision changes are independent membership decisions.
assert.equal(Groups.memberKey(a), Groups.memberKey({...a, col_v: 'D', compoundMeta: {name: 'new molecule'}}));
for (const patch of [{sourceRevision: 'revision-2'}, {sourceHash: 'hash-2'}, {sheet: 'Sheet2'},
    {col_x: 'X'}, {col_y: 'Y'}, {data_start_row: 3}, {sourceFileId: 'replacement'}]) {
    const changed = {...a, sourceReference: Groups.sourceReference(a), ...patch};
    const changedGeometry = {...ga, sourceRef: Groups.sourceReference(changed)};
    assert.equal(Groups.resolveMembership(s, changed, changedGeometry, first.groupId), null,
        'changed identity/reader is not silently enrolled: ' + JSON.stringify(patch));
}
const frozen = {...a, sourceReference: Groups.sourceReference(a)};
const transported = {...frozen, blobId: 'imported-local-blob', sourceUrl: 'https://storage/new-location'};
assert.equal(Groups.memberKey(frozen), Groups.memberKey(transported), 'blob/URL transport preserves frozen scientific identity');

for (const change of [g => { g.legacy.x = [[11, 0], [13, 1], [15, 2]]; g.displayGeometry.x.origin = 11; },
    g => { g.legacy.x[1][0] += 0.0000001; },
    g => { g.displayGeometry.x.step = 3; },
    g => { g.legacy.x = [[10, 0], [12, 1], [14, 3]]; g.legacy.W = 4; },
    g => { g.displayGeometry.W = 4; }]) {
    const changed = clone(ga); change(changed);
    assert.notEqual(Groups.geometryKey(changed), first.frameKey, 'origin, pitch, jitter and logical-pixel mapping remain exact');
    assert.equal(Groups.roiCompatible(roi, changed, s, a), false);
}
for (const change of [g => { g.legacy.confirmed = false; }, g => { delete g.legacy.confirmed; },
    g => { g.legacy.x[1][0] = NaN; }, g => { g.legacy.x[1][0] = 10; },
    g => { g.legacy.x.reverse(); }, g => { g.legacy.x[1][1] = 1.5; },
    g => { g.legacy.x[1][1] = -1; }, g => { g.legacy.W = 0; },
    g => { g.displayGeometry.x.step = 0; }, g => { g.displayGeometry.y.origin = 0; }]) {
    const bad = clone(ga); change(bad);
    assert.equal(Groups.geometryKey(bad), null);
    const target = section('untouched');
    assert.equal(Groups.ensureGroup(target, a, bad), null);
    assert.deepEqual(target.meta, {}, 'invalid coordinates do not create stored groups');
}
assert.equal(Groups.ensureGroup(s, a, gb), null, 'geometry from a different source cannot register the current entry');
for (const patch of [{frameKey: undefined}, {frameKey: 'invalid'}, {frameVersion: 9},
    {scope: 'source'}, {version: 'msi-source-v1'}, {groupId: 'different'}, {sectionId: 'another-section'}]) {
    assert.equal(Groups.roiCompatible({...roi, ...patch}, ga, s, a), false);
}
const malformedRoi = clone(roi); malformedRoi.displayGeometry.x.step *= 2;
assert.equal(Groups.roiCompatible(malformedRoi, ga, s, a), false, 'saved ROI mapping is validated independently');

// Same geometry in another section must not share an ROI. Shared server UUIDs
// are resolved through client_id; ZIP import explicitly remaps ROI sectionId.
const other = section('section-2');
Groups.ensureGroup(other, a, ga);
assert.notEqual(other.meta.spatialGroups.groups[0].id, first.groupId);
assert.equal(Groups.roiCompatible(roi, ga, other, a), false);
const shared = {...clone(s), id: 'server-section-uuid', meta: {...clone(s.meta), client_id: s.id}};
assert.equal(Groups.roiCompatible(roi, ga, shared, a), true);
const imported = {...clone(s), id: 'imported-section'};
assert.equal(Groups.roiCompatible(roi, ga, imported, a), false);
assert.equal(Groups.roiCompatible({...roi, sectionId: imported.id}, ga, imported, a), true);
assert.equal(imported.meta.spatialGroups.groups[0].id, first.groupId, 'group ID remains opaque and stable through import');

for (const registryPatch of [value => { value.version = 999; }, value => { delete value.nextId; },
    value => { value.groups[0].frameKey = 'invalid'; }, value => { value.groups.push(clone(value.groups[0])); },
    value => { value.groups[0].members.push(clone(value.groups[0].members[0])); }]) {
    const bad = clone(s); registryPatch(bad.meta.spatialGroups);
    const before = JSON.stringify(bad);
    assert.equal(Groups.resolveMembership(bad, a, ga), null);
    assert.equal(Groups.ensureGroup(bad, a, ga), null);
    assert.equal(JSON.stringify(bad), before, 'unknown/corrupt saved contracts are preserved');
}
const browser = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/msi-spatial-groups.js'), 'utf8'), browser);
assert.equal(browser.MsiSpatialGroups.geometryKey(ga), Groups.geometryKey(ga), 'browser and connector/CJS agree exactly');
assert.match(fs.readFileSync(path.join(__dirname, '../tools/build.cjs'), 'utf8'), /'msi-spatial-groups\.js'/,
    'web and offline distributions include the shared coordinate resolver');
console.log('MSI spatial groups regression: PASS (exact frames, scoped ROI, later enrollment, identity, transport, corrupt state)');
