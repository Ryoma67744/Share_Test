'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const range = require('../viewer/msi-roi-range.js');
const raster = (values, W = values.length) => ({W, H:values.length / W, values:Float64Array.from(values)});
const all = () => true;

// Visible ROI union: an overlap contributes once; hidden/off-region outliers do
// not affect either percentile or extrema. Membership receives native indices.
const native = raster([10, 30, 50, 100000]);
const before = Buffer.from(native.values.buffer).toString('hex');
const summary = range.summarizeRaster(native, [(x, y, i) => x <= 1 && y === 0 && i <= 1, x => x >= 1 && x <= 2], {percentile:0.5});
assert.deepEqual(summary, {status:'ready', n:3, min:10, max:50, displayMin:10, displayMax:30});
assert.equal(Buffer.from(native.values.buffer).toString('hex'), before, 'summary mutated the raw raster');
assert.equal(range.summarizeRaster(native, x => x < 3, {bakeMode:'full', percentile:0.5}).displayMax, 50);

// Current nearest-rank rule uses round(p * (n - 1)); default p99.9 excludes a
// single outlier in this distribution. The source array stays unsorted.
const distribution = Array.from({length:2001}, (_, i) => 2000 - i);
distribution[0] = 1000000;
const population = raster(distribution);
assert.equal(range.summarizeRaster(population, all).displayMax, 1998);
assert.equal(population.values[0], 1000000);
assert.equal(range.summarizeRaster(raster([0, 0, 100]), all, {percentile:0}).displayMax, 100, 'a collapsed percentile falls back to the actual maximum');

// Original rows retain duplicate-coordinate measurements, while raster values
// retain their pre-existing cell averages. Union overlap must not add rows twice.
const rows = Object.freeze([
    Object.freeze({x:0, y:0, v:10, rowId:'a'}),
    Object.freeze({x:0, y:0, v:90, rowId:'b'}),
    Object.freeze({x:1, y:0, v:30, rowId:'c'}),
    Object.freeze({x:2, y:0, v:99999, rowId:'outside'})
]);
assert.deepEqual(range.summarizeRows(rows, [row => row.x === 0, row => row.x <= 1]), {status:'ready', n:3, min:10, max:90});
assert.equal(range.summarizeRaster(raster([50, 30, 99999]), x => x <= 1, {bakeMode:'full'}).max, 50);
assert.equal(rows[1].v, 90);
const lazyRows = {[Symbol.iterator]:function*() { yield* rows; }};
assert.equal(range.summarizeRows(lazyRows, row => row.x <= 1).max, 90);

// Constant, zero and negative samples have deterministic display fallbacks;
// actual source maxima stay unchanged so the caller can apply maximum policy.
for (const value of [100, 0, -8]) {
    assert.deepEqual(range.summarizeRaster(raster([value, value]), all),
        {status:'ready', n:2, min:value, max:value, displayMin:0, displayMax:Math.max(1, value)});
    assert.equal(range.summarizeRows([{x:0, y:0, v:value}], all).max, value);
}
assert.deepEqual(range.summarizeRaster(raster([-9, -5]), all),
    {status:'ready', n:2, min:-9, max:-5, displayMin:-9, displayMax:-5});
assert.equal(range.summarizeRaster(raster([NaN, Infinity, -Infinity, 0]), all).n, 1);
assert.deepEqual(range.summarizeRows([{x:0,y:0,v:NaN}, {x:NaN,y:0,v:100}, {x:0,y:0,v:0}], all),
    {status:'ready', n:1, min:0, max:0});

// Distinguish absent ROIs, empty samples, missing source data and unresolved
// geometry. A known member of one ROI remains a union member if another is unknown.
for (const contains of [null, []]) {
    assert.equal(range.summarizeRaster(null, contains).status, 'no-roi');
    assert.equal(range.summarizeRows(null, contains).status, 'no-roi');
}
assert.equal(range.summarizeRaster(native, () => false).status, 'empty');
assert.equal(range.summarizeRaster(raster([NaN, Infinity]), all).status, 'empty');
assert.equal(range.summarizeRows([], all).status, 'empty');
assert.equal(range.summarizeRaster(null, all).reason, 'raster-unavailable');
assert.equal(range.summarizeRaster({W:2,H:2,values:[1]}, all).status, 'unavailable');
assert.equal(range.summarizeRows(null, all).reason, 'source-unavailable');
assert.equal(range.summarizeRaster(native, () => null).reason, 'roi-geometry-unavailable');
assert.equal(range.summarizeRows(rows, () => null).reason, 'roi-geometry-unavailable');
assert.equal(range.summarizeRaster(native, [() => null, all]).n, 4);
assert.equal(range.summarizeRows(rows, [() => null, all]).n, 4);
const unsafe = [{x:0,y:0,v:NaN,sourceCells:{v:{status:'unsafe-integer'}}}];
assert.equal(range.summarizeRows(unsafe, all).reason, 'unsupported-source-precision');
assert.equal(range.summarizeRows(unsafe, () => false).status, 'empty');
assert.throws(() => range.summarizeRaster(native, all, {percentile:2}), RangeError);

// Browser script export works without CommonJS, matching other viewer modules.
const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/msi-roi-range.js'), 'utf8'), context);
assert.equal(typeof context.MsiRoiRange.summarizeRaster, 'function');
assert.equal(typeof context.MsiRoiRange.summarizeRows, 'function');
console.log('MSI ROI range regression: OK');
