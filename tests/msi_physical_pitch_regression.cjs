'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8');
const context = vm.createContext({});
for (const name of ['buildMsiGrid', 'buildLegacyMsiGrid', 'msiSourceReference',
    'createMsiSourceGeometry', 'msiDisplayPhysicalPitch']) {
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

const sparse = [];
for (const y of [0, 1, 2]) for (const x of [0, 1, 3]) {
    sparse.push({x: Math.fround(10 + x * 0.07), y: Math.fround(-5 + y * 0.1), v: 1});
}
const gap = pitch(sparse, 70, 100);
assert.ok(Math.abs(gap.value.x - 70) < 1e-9);
assert.ok(Math.abs(gap.value.y - 100) < 1e-9, 'Anisotropic calibration and actual missing scan lines are retained');

const geometry = {legacy: {x: [[0, 0], [1, 1], [8, 2]], y: [[0, 0], [1, 1]]},
    displayGeometry: {x: {step: 1}, y: {step: 1}}};
context.msiLayerSourceGeometry = () => geometry;
assert.equal(context.msiDisplayPhysicalPitch(section(50, 50)), null, 'Genuinely nonuniform ordinal axes remain uncalibrated');
geometry.legacy.x = [[1e8, 0], [1e8 + 1.01, 1], [1e8 + 2, 2]];
assert.equal(context.msiDisplayPhysicalPitch(section(50, 50)), null, 'Large coordinate offsets cannot relax tolerance beyond a small fraction of a pixel');
for (const knots of [[[0, 0], [1, 0]], [[0, 1], [1, 0]], [[0, 0], [NaN, 1]]]) {
    geometry.legacy.x = knots;
    assert.equal(context.msiDisplayPhysicalPitch(section(50, 50)), null, 'Invalid calibration axes have no physical scale');
}
geometry.legacy.x = [[0, 0], [1, 1]];
geometry.displayGeometry.x.step = Infinity;
assert.equal(context.msiDisplayPhysicalPitch(section(50, 50)), null);
context.msiLayerSourceGeometry = () => null;
for (const calibration of [{}, section(0, 50), section(Infinity, 50), section(50, NaN)]) {
    assert.equal(context.msiDisplayPhysicalPitch(calibration), null, 'Unknown or invalid pitch never gets physical units');
}
assert.deepEqual(plain(context.msiDisplayPhysicalPitch(section(50, 75))), {x: 50, y: 75});
console.log('MSI physical pitch regression: PASS (float32 RAW, complete image extents, missing lines, invalid/nonuniform axes)');
