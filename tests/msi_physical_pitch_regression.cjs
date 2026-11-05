'use strict';
const {displayContext}=require('./viewer-runtime.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8');
const context = displayContext({});
for (const name of ['buildMsiGrid', 'buildLegacyMsiGrid', 'msiSourceReference',
    'createMsiSourceGeometry', 'normalizeMsiPhysicalPitch', 'resolveMsiCoordinateCalibration', 'resolveMsiPhysicalCalibration',
    'msiDisplayPhysicalPitch', 'formatPixelPitchLabel', 'pickPreviewScalebarLength', 'rawPitchOf']) {
    const start = html.indexOf('function ' + name + '(');
    assert.ok(start >= 0, name);
    vm.runInContext(html.slice(start, html.indexOf('\n}', start) + 2), context);
}
const section = (x, y) => ({meta: {world_coords: {msi_um_per_px: {x, y}}}});
const plain = value => JSON.parse(JSON.stringify(value));
function pitch(rows, x, y) {
    const geometry = context.createMsiSourceGeometry(rows, {kind: 'raw'});
    context.msiLayerSourceGeometry = () => geometry;
    return {geometry, value: context.msiDisplayPhysicalPitch(section(x, y), 'MSI_test')};
}
const approximate = (actual, expected, message) => assert.ok(Math.abs(actual-expected) < 1e-9,
    message + ': ' + actual + ' versus ' + expected);
function dimensions(sourceW, sourceH, displayW = sourceW, displayH = sourceH) {
    return {legacy:{W:sourceW,H:sourceH,confirmed:false,reason:'legacy-coordinate-unconfirmed'},
        displayGeometry:{version:'msi-proportional-v1',W:displayW,H:displayH,
            x:{origin:0,step:1},y:{origin:0,step:1}}};
}
function physicalForGeometry(geometry, x = 30, y = 50) {
    context.msiLayerSourceGeometry = () => geometry;
    return context.resolveMsiPhysicalCalibration(section(x,y),'MSI_test');
}

// Reproduce float32 stage coordinates from a 70 µm RAW scan without copying
// measured intensities. The original neighboring differences vary by ~1e-6 mm.
const rows = [];
for (let y = 0; y < 54; y++) for (let x = 0; x < 73; x++) {
    rows.push({x: Math.fround(9.40746 + x * 0.07), y: Math.fround(-5.78301 + y * 0.07), v: 1});
}
const before = JSON.stringify(rows);
const raw = pitch(rows, 70, 70);
assert.equal(raw.geometry.legacy.confirmed, true);
assert.equal(raw.geometry.displayGeometry.W, 73);
assert.equal(raw.geometry.displayGeometry.H, 54);
assert.deepEqual(plain(raw.value), {x: 70, y: 70}, 'Float32 rounding keeps the registered physical pitch');
assert.equal(raw.value.x * raw.geometry.displayGeometry.W, 5110, 'Image extent includes the complete edge pixels');
assert.equal(raw.value.y * raw.geometry.displayGeometry.H, 3780);
assert.equal(JSON.stringify(rows), before, 'Scale calculation does not modify source coordinates or intensities');
assert.deepEqual(plain(context.resolveMsiCoordinateCalibration(section(70,70),'MSI_test').displayPitch),
    {x:70,y:70},'RAW coordinate calibration remains available to HE auto-alignment');
for (const value of ['70', ' 70.0 ', '7e1', '+70']) {
    assert.deepEqual(plain(pitch(rows, value, '7e1').value), {x:70,y:70});
    assert.equal(context.formatPixelPitchLabel(section(value,'7e1')), '70×70 μm/px');
}
for (const value of ['', ' ', true, [], ['70'], '70 µm', '70abc', '0x46', '-70', '0', 'Infinity']) {
    assert.equal(pitch(rows,value,70).value,null,'Reject invalid calibration '+JSON.stringify(value));
    assert.equal(context.formatPixelPitchLabel(section(value,70)),'');
}
assert.equal(context.formatPixelPitchLabel(section(.01,.02)), '0.01×0.02 μm/px');
// Invalid intensity can break old ROI correspondence without breaking scale.
const invalidValue = rows.map((r,i)=>({...r,v:i===0?NaN:1}));
const independent = pitch(invalidValue,70,70);
assert.deepEqual(plain(independent.value),{x:70,y:70});
independent.geometry.legacy.confirmed=false;
context.msiLayerSourceGeometry=()=>independent.geometry;
assert.deepEqual(plain(context.msiDisplayPhysicalPitch(section('70','70'))),{x:70,y:70});
const invalidCoordinates = rows.concat([{x:NaN,y:rows[0].y,v:123}, {x:rows[0].x,y:NaN,v:456}]);
const invalidCoordinatesBefore=structuredClone(invalidCoordinates);
const manualWithInvalidRows=pitch(invalidCoordinates,30,30);
assert.equal(manualWithInvalidRows.geometry.legacy.confirmed,false);
assert.deepEqual(plain(manualWithInvalidRows.value),{x:30,y:30},'Invalid source coordinates do not revoke a valid manual pixel calibration');
assert.deepEqual(invalidCoordinates,invalidCoordinatesBefore,'Invalid rows remain unchanged, including NaN coordinates');
const stale=section(70,70);stale.msiSeries={MSI_test:{kind:'txt',blobId:'replacement'}};
assert.equal(context.resolveMsiPhysicalCalibration(stale,'MSI_test').status,'conflict');
assert.equal(context.resolveMsiCoordinateCalibration(stale,'MSI_test').status,'conflict');
context.msiLayerSourceGeometry=()=>null;
assert.equal(context.resolveMsiPhysicalCalibration(stale,'MSI_test').status,'pending');
assert.equal(context.resolveMsiCoordinateCalibration(stale,'MSI_test').status,'pending');
// Choosing a length may change the label; clamping its drawn width may not.
for(const umPerPx of [.0001,.01,.3,70,1e5]) {
    const length=context.pickPreviewScalebarLength(umPerPx,100);
    assert.ok(length/umPerPx>=20 && length/umPerPx<=100.000001);
}

const sparse = [];
for (const y of [0, 1, 2]) for (const x of [0, 1, 3]) {
    sparse.push({x: Math.fround(10 + x * 0.07), y: Math.fround(-5 + y * 0.1), v: 1});
}
const gap = pitch(sparse, 70, 100);
assert.ok(Math.abs(gap.value.x - 70) < 1e-9);
assert.ok(Math.abs(gap.value.y - 100) < 1e-9, 'Anisotropic calibration and actual missing scan lines are retained');
assert.equal(gap.geometry.legacy.W,4,'The missing scan column occupies its original pixel index');

// A representative TXT writer emits six significant decimal digits. Its
// coordinates must stay untouched; manual 30 µm pixels do not depend on how
// accurately that text follows a line in stage-coordinate units.
const rounded=[];
for(let y=0;y<3;y++)for(let x=0;x<106;x++)rounded.push({
    x:Number((-16.9535+x*0.030005).toPrecision(6)),y:-4.3093+y*0.03,v:x+y});
const roundedBefore=JSON.stringify(rounded),roundedResult=pitch(rounded,30,30);
assert.equal(roundedResult.geometry.legacy.W,106);
assert.equal(roundedResult.geometry.displayGeometry.W,106);
assert.deepEqual(plain(roundedResult.value),{x:30,y:30},'Registered pixels survive decimal TXT coordinate rounding');
assert.equal(context.resolveMsiCoordinateCalibration(section(30,30),'MSI_test').reason,'nonuniform-coordinate-axis',
    'HE automatic coordinate alignment retains the strict coordinate-distance contract');
assert.equal(JSON.stringify(rounded),roundedBefore);

// The calibration is tied to raster pixels, not coordinate knots or old ROI
// membership. Equal dimensions are exactly the registered pitch even if those
// separate scientific-coordinate diagnostics are unavailable.
const sameSize=dimensions(7,3);
const sameSizeBefore=JSON.stringify(sameSize);
assert.deepEqual(plain(physicalForGeometry(sameSize).displayPitch),{x:30,y:50});
sameSize.legacy.x=[[0,0],[1,1],[8,6]];sameSize.legacy.y=[[0,0],[3,2]];
assert.deepEqual(plain(physicalForGeometry(sameSize).displayPitch),{x:30,y:50},'Nonuniform coordinate spacing never replaces manual pixel dimensions');
delete sameSize.legacy.x;delete sameSize.legacy.y;
assert.equal(JSON.stringify(sameSize),sameSizeBefore,'Calibration does not backfill or migrate geometry');

// A source with 5000 centres is capped at 4096 by the real grid builder.
// Centre-to-centre resampling uses (W-1), not W; both endpoint distances remain.
const cappedRows=Array.from({length:5000},(_,x)=>({x,y:0,v:x%7}));
const capped=pitch(cappedRows,30,40);
assert.equal(capped.geometry.legacy.W,5000);
const cappedWidth=capped.geometry.displayGeometry.W;
assert.ok(cappedWidth>1 && cappedWidth<=4096);
approximate(capped.value.x,30*4999/(cappedWidth-1),'Raster cap preserves original centre spacing');
assert.equal(capped.value.y,40,'Single unchanged Y pixel retains its height');
assert.notEqual(capped.value.x,30*5000/cappedWidth,'Pixel-edge image resizing is a separate transform');
approximate(capped.value.x*(cappedWidth-1),30*4999,'First-to-last source-centre physical distance is preserved');
const expanded=physicalForGeometry(dimensions(3,2,7,5));
assert.deepEqual(plain(expanded.displayPitch),{x:10,y:12.5},'Supersampled display pixels use the inverse centre-span ratio');
const missingColumn=dimensions(4,3,2,3);
missingColumn.legacy.x=[[0,0],[1,1],[3,3]];
assert.deepEqual(plain(physicalForGeometry(missingColumn).displayPitch),{x:90,y:50},'A missing index is not collapsed into the number of measured columns');
assert.deepEqual(plain(physicalForGeometry(dimensions(1,1)).displayPitch),{x:30,y:50});
for(const dims of [[1,3,2,3],[2,3,1,3],[3,1,3,2],[3,2,3,1],
    [0,3,3,3],[3,0,3,3],[3,3,0,3],[3,3,3,0],[2.5,3,3,3],[3,3,Infinity,3],[3,3,3,NaN]]) {
    const result=physicalForGeometry(dimensions(...dims));
    assert.equal(result.displayPitch,null,'Invalid or collapsed display dimensions cannot invent a physical distance: '+dims);
    assert.equal(result.reason,'invalid-display-grid');
}

// These checks are still required for coordinate-based HE auto-alignment.
// They deliberately target the strict resolver, not manual raster calibration.
const geometry = {legacy: {x: [[0, 0], [1, 1], [8, 2]], y: [[0, 0], [1, 1]]},
    displayGeometry: {x: {step: 1}, y: {step: 1}}};
context.msiLayerSourceGeometry = () => geometry;
assert.equal(context.resolveMsiCoordinateCalibration(section(50,50)).displayPitch,null,'Nonuniform axes cannot automatically calibrate coordinate alignment');
geometry.legacy.x = [[1e8, 0], [1e8 + 1.01, 1], [1e8 + 2, 2]];
assert.equal(context.resolveMsiCoordinateCalibration(section(50,50)).displayPitch,null,'Large coordinate offsets cannot relax coordinate-alignment tolerance');
for (const knots of [[[0, 0], [1, 0]], [[0, 1], [1, 0]], [[0, 0], [NaN, 1]]]) {
    geometry.legacy.x = knots;
    assert.equal(context.resolveMsiCoordinateCalibration(section(50,50)).displayPitch,null,'Invalid axes cannot calibrate coordinate alignment');
}
geometry.legacy.x = [[0, 0], [1, 1]];
geometry.displayGeometry.x.step = Infinity;
assert.equal(context.resolveMsiCoordinateCalibration(section(50,50)).displayPitch,null);
context.msiLayerSourceGeometry = () => null;
for (const calibration of [{}, section(0, 50), section(Infinity, 50), section(50, NaN)]) {
    assert.equal(context.msiDisplayPhysicalPitch(calibration), null, 'Unknown or invalid pitch never gets physical units');
}
assert.deepEqual(plain(context.msiDisplayPhysicalPitch(section(50, 75))), {x: 50, y: 75});

// Exercise the existing RAW estimator and actual registration assignment, not a
// second implementation of its fallback. The original data array is read-only.
const stageX=Array.from({length:73},(_,i)=>Math.fround(9.40746+i*.07));
const stageY=Array.from({length:54},(_,i)=>Math.fround(-5.78301+i*.1));
const stageBefore=JSON.stringify([stageX,stageY]);
const estimateX=context.rawPitchOf(stageX),estimateY=context.rawPitchOf(stageY);
approximate(estimateX.pitch,.07,'RAW X spacing estimate');approximate(estimateY.pitch,.1,'RAW Y spacing estimate');
assert.equal(context.rawPitchOf([2,2,2]).pitch,null,'A single RAW coordinate does not invent a pitch');
assert.equal(JSON.stringify([stageX,stageY]),stageBefore);
const registrationStart=html.indexOf('if (!sec.meta.world_coords.msi_um_per_px && first.pitchX != null && first.pitchY != null)');
assert.ok(registrationStart>=0,'RAW registration keeps its existing non-overwrite guard');
const registrationEnd=html.indexOf('\n                }',registrationStart);
assert.ok(registrationEnd>registrationStart);
vm.runInContext('function registerRawPitch(sec,first){'+html.slice(registrationStart,registrationEnd+'\n                }'.length)+'}',context);
const fresh=section(undefined,undefined);delete fresh.meta.world_coords.msi_um_per_px;
context.registerRawPitch(fresh,{pitchX:estimateX.pitch,pitchY:estimateY.pitch});
assert.deepEqual(plain(fresh.meta.world_coords.msi_um_per_px),{x:70,y:100},'Missing RAW calibration receives the coordinate estimate in micrometres');
for(const registered of [{x:30,y:30},{x:'30',y:'30'}]) {
    const existing={meta:{world_coords:{msi_um_per_px:registered}}};
    context.registerRawPitch(existing,{pitchX:.07,pitchY:.1});
    assert.equal(existing.meta.world_coords.msi_um_per_px,registered,'RAW never replaces a registered/manual calibration');
}
const incomplete={meta:{world_coords:{}}};context.registerRawPitch(incomplete,{pitchX:null,pitchY:.1});
assert.equal(incomplete.meta.world_coords.msi_um_per_px,undefined);
console.log('MSI physical pitch regression: PASS (registered raster calibration, decimal TXT, centre-span resolution, missing pixels, RAW defaults, strict alignment isolation)');
