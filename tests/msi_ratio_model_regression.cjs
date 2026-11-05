'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const model = require('../viewer/msi-ratio-model.js');
const clone = value => JSON.parse(JSON.stringify(value));
const entry = {kind:'xlsx',sourceFileId:'original-file',sourceReference:'frozen-original',sourceRevision:'rev-1',
    sheet:'Sheet1',col_x:'A',col_y:'B',col_v:'C',data_start_row:2};
const ref = model.makeInputRef(entry, 'MSI_OldName');
const yref = model.makeInputRef({...entry,col_v:'D'}, 'MSI_Y');
const definition = {id:'ratio-1',name:'X / Y',revision:1,operation:'divide',calculationVersion:'msi-ratio-v1',
    denominatorMin:0,numeratorPolicy:'nonnegative',invalidPolicy:'exclude',
    bindings:{'client-section':{numerator:ref,denominator:yref,coordinateConfirmed:false,coordinateEvidence:''}}};
const registry = {schemaVersion:1,definitions:[definition]};
const snapshot = JSON.stringify(registry);

// Renaming a molecule, changing a download URL, or restoring its local blob ID
// must not replace a frozen scientific input. Hints cannot select a different one.
const section = {id:'server-section',meta:{client_id:'client-section'},msiSeries:{
    MSI_Renamed:{...entry,blobId:'new-local-blob',sourceUrl:'https://example.invalid/new'},MSI_Y:{...entry,col_v:'D'}}};
assert.equal(model.canonicalSectionId(section), 'client-section');
assert.equal(model.canonicalSectionId({id:'a',client_id:'b'}), 'b');
assert.equal(model.resolveInput(section, ref).key, 'MSI_Renamed');
assert.equal(model.resolveInput(section, {...ref,layerKeyHint:'MSI_Y',labelHint:'Y'}).key, 'MSI_Renamed');
assert.equal(model.resolveInput({msiSeries:{MSI_OldName:{...entry,col_v:'Z'}}}, ref).status, 'missing');
assert.equal(model.resolveInput({msiSeries:{MSI_A:entry,MSI_B:{...entry}}}, ref).status, 'ambiguous');
assert.equal(model.resolveInput({msiSeries:{MSI_A:{...entry,sourceRevision:'rev-2'}}}, ref).status, 'source-changed');
assert.equal(model.resolveInput(section, {}).status, 'invalid');
assert.throws(() => model.makeInputRef({kind:'xlsx',col_v:'C'}, 'MSI_PNG'), /original source/);

// Every supported reader freezes its feature separately from its file/frame.
for (const [source, expected] of [
    [{kind:'raw',func:2,channel:3},{channel:3}],
    [{kind:'parquet',annotation:'tissue-1',colIdx:5},{columnIndex:5}],
    [{kind:'txt',x:'X',y:'Y',v:'signal'},{columnName:'signal'}],
    [{kind:'txt'},{columnIndex:2}],
    [{kind:'txt-analyte',compound_index:2,dataStartLine:4},{analyteIndex:2}]
]) {
    const frozen = model.makeInputRef({sourceReference:'source',...source}, 'MSI_X');
    assert.deepEqual(frozen.feature, expected);
    assert.equal(model.validateInputRef(frozen).valid, true);
    const changed = {...source,sourceReference:'other'};
    assert.equal(model.resolveInput({msiSeries:{MSI_X:changed}}, frozen).status, 'missing');
}
const pq = model.makeInputRef({sourceReference:'file',kind:'parquet',annotation:'one',colIdx:3});
assert.equal(model.resolveInput({msiSeries:{MSI_X:{sourceReference:'file',kind:'parquet',annotation:'two',colIdx:3}}}, pq).status, 'missing');
const raw = model.makeInputRef({sourceReference:'file',kind:'raw',func:1,channel:2});
assert.equal(model.resolveInput({msiSeries:{MSI_X:{sourceReference:'file',kind:'raw',func:2,channel:2}}}, raw).status, 'missing');

assert.deepEqual(model.normalizeRegistry(null), {schemaVersion:1,definitions:[]});
assert.equal(model.validateRegistry(registry).valid, true);
assert.equal(model.validateProjectReferences({meta:{msiRatios:registry},sections:[section]}).valid, true);
assert.equal(model.validateProjectReferences({sections:[]}, registry).valid, false);
assert.equal(model.validateProjectReferences({sections:[section, section]}, registry).valid, false);
assert.equal(model.validateProjectReferences({sections:[{...section,msiSeries:{}}]}, registry).valid, false);
assert.deepEqual(model.normalizeRegistry(registry), registry);
const unknown = {schemaVersion:9,definitions:[{future:{x:1}}],futureSetting:true};
assert.deepEqual(model.validateRegistry(unknown), {valid:true,supported:false,errors:[]});
assert.deepEqual(model.normalizeRegistry(unknown), unknown);
assert.deepEqual(model.validateProjectReferences({sections:[]}, unknown), {valid:true,supported:false,errors:[]});
assert.deepEqual(model.remapSections(unknown, {'old':'new'}), unknown);
for (const patch of [{denominatorMin:-1}, {operation:'log'}, {name:''}, {revision:0}, {bindings:{}}, {display:[]}]) {
    assert.equal(model.validateDefinition({...definition,...patch}).valid, false);
    assert.throws(() => model.normalizeRegistry({schemaVersion:1,definitions:[{...definition,...patch}]}), /Invalid ratio registry/);
}
assert.throws(() => model.normalizeRegistry({schemaVersion:1,definitions:[definition,definition]}), /duplicate-ratio-id/);
const bad = clone(registry);
bad.definitions[0].bindings['client-section'].numerator.feature = {};
assert.equal(model.validateRegistry(bad).valid, false);

const remapped = model.remapSections(registry, {'client-section':'local-section'});
assert.ok(remapped.definitions[0].bindings['local-section']);
assert.equal(remapped.definitions[0].bindings['client-section'], undefined);
assert.equal(JSON.stringify(registry), snapshot);
const ranged = clone(registry);
ranged.definitions[0].display = {ranges:{version:1,whole:{same:{min:0,max:9},'client-section':{min:1,max:7}},
    roi:{'client-section':{min:2,max:5}}}};
const rangedCopy = model.remapSections(ranged, {'client-section':'new-section',same:'must-not-remap'});
assert.deepEqual(rangedCopy.definitions[0].display.ranges.whole['new-section'], {min:1,max:7});
assert.deepEqual(rangedCopy.definitions[0].display.ranges.roi['new-section'], {min:2,max:5});
assert.deepEqual(rangedCopy.definitions[0].display.ranges.whole.same, {min:0,max:9});
assert.equal(rangedCopy.definitions[0].display.ranges.version,1);
assert.ok(ranged.definitions[0].display.ranges.whole['client-section'],'Range remap leaves its source registry unchanged');
const collision = clone(registry);
collision.definitions[0].bindings.other = {...clone(definition.bindings['client-section']),coordinateConfirmed:true};
assert.throws(() => model.remapSections(collision, {'client-section':'same',other:'same'}), /Conflicting ratio section remap/);
assert.equal(model.displayKey('ratio-1'), 'MSI_RATIO_ratio-1');
assert.equal(model.isRatioKey('MSI_RATIO_ratio-1', registry), true);
assert.equal(model.isRatioKey('MSI_RATIO_real-compound', registry), false);
assert.equal(model.isRatioKey('MSI_RATIO_', registry), false);

// Canonical comparison is stable across JSON key order. Numeric cache identity
// excludes labels/display/revision-only changes but includes direction, cutoff,
// raw versions, feature selectors and coordinate confirmation.
assert.equal(model.fingerprint({b:2,a:1}), model.fingerprint({a:1,b:2}));
const identity = model.definitionFingerprint(definition);
assert.equal(model.definitionFingerprint({...definition,name:'Renamed',revision:2,display:{colormap:'hot'}}), identity);
assert.notEqual(model.definitionFingerprint({...definition,denominatorMin:2}), identity);
const swapped = clone(definition);
[swapped.bindings['client-section'].numerator,swapped.bindings['client-section'].denominator] =
    [swapped.bindings['client-section'].denominator,swapped.bindings['client-section'].numerator];
assert.notEqual(model.definitionFingerprint(swapped), identity);
const changedRevision = clone(definition);
changedRevision.bindings['client-section'].numerator.source.revision = 'rev-2';
assert.notEqual(model.definitionFingerprint(changedRevision), identity);
const browser = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/msi-ratio-model.js'), 'utf8'), browser);
assert.equal(typeof browser.MsiRatioModel.resolveInput, 'function');
assert.equal(JSON.stringify(registry), snapshot);
console.log('MSI ratio model regression: OK');
