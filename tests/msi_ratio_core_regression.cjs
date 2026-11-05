'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../viewer/msi-ratio-core.js');
const input = (values, options = {}) => Object.assign({values:Float64Array.from(values),
    positions:values.map((_, i) => ({x:i, y:0})), rowIds:values.map((_, i) => i), sourceFrame:'frame'}, options);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) <= 1e-12 * Math.max(Math.abs(expected), Number.MIN_VALUE), `${actual} != ${expected}`);
const snapshot = x => Buffer.from(x.values.buffer).toString('hex');

// Explicit common valid-pair population: sum(X)/sum(Y) is NOT mean(X/Y).
const x = input([10, 10, 0, 8, NaN, -2, 9]);
const y = input([1, 10, 2, 0, 3, 2, NaN]);
const originals = [snapshot(x), snapshot(y)];
const r = core.calculate(x, y);
assert.equal(r.status, 'ready');
assert.deepEqual(Array.from(r.values).slice(0, 3), [10, 1, 0]);
assert.ok(Array.from(r.values).slice(3).every(Number.isNaN));
assert.equal(r.summary.nCandidate, 7);
assert.equal(r.summary.nValid, 3);
assert.equal(r.summary.validFraction, 3 / 7);
assert.equal(r.summary.sumX, 20);
assert.equal(r.summary.sumY, 13);
near(r.summary.totalRatio, 20 / 13);
near(r.summary.mean, 11 / 3);
assert.equal(r.summary.median, 1);
assert.equal(r.summary.min, 0);
assert.equal(r.summary.max, 10);
assert.deepEqual(r.summary.reasonCounts, {'denominator-zero':1, 'numerator-nonfinite':1, 'numerator-negative':1, 'denominator-nonfinite':1});
assert.deepEqual([snapshot(x), snapshot(y)], originals);
const cut = core.calculate(x, y, {denominatorMin:2});
assert.equal(cut.summary.nValid, 1);
assert.equal(cut.summary.totalRatio, 1);
assert.equal(cut.summary.mean, 1);
assert.equal(cut.summary.median, 1);
assert.equal(core.calculate(x, y, {denominatorMin:-1}).reason, 'invalid-denominator-min');
assert.equal(core.calculate(x, y, {denominatorMin:Infinity}).reason, 'invalid-denominator-min');

// Reversing is a fresh division: zeros, validity and the raw-unit cutoff change.
assert.equal(core.calculate(y, x).summary.nValid, 3);
const same = core.calculate(input([3, 0, -2, NaN]), input([3, 0, -2, NaN]));
assert.deepEqual(Array.from(same.valid), [1, 0, 0, 0]);
assert.equal(same.values[0], 1);
assert.equal(core.calculate(input([1]), input([0])).status, 'empty');
assert.equal(core.calculate(input([]), input([])).summary.validFraction, null);

// Coordinate duplicates stay separate raw measurements when row IDs prove
// correspondence. A display cell would average 10 and 1 to 5.5, not 20/11.
const dupPositions = [{x:0, y:0}, {x:0, y:0}];
const dx = input([10, 10], {positions:dupPositions, rowIds:['scan-a', 'scan-b']});
const dy = input([10, 1], {positions:dupPositions, rowIds:['scan-b', 'scan-a']});
const duplicate = core.calculate(dx, dy);
assert.deepEqual(Array.from(duplicate.denominatorOrder), [1, 0]);
assert.deepEqual(Array.from(duplicate.values), [10, 1]);
assert.equal(duplicate.summary.mean, 5.5);
near(duplicate.summary.totalRatio, 20 / 11);
assert.equal(duplicate.summary.nUniqueCoordinates, 1);
assert.equal(core.calculate(dx, Object.assign({}, dy, {rowIds:['scan-a', 'scan-a']})).reason, 'source-row-id-duplicate');
assert.equal(core.calculate(dx, Object.assign({}, dy, {rowIds:['scan-z', 'scan-a']})).reason, 'source-row-id-mismatch');
assert.equal(core.calculate(input([1], {rowIds:null}), input([1], {rowIds:null})).reason, 'source-row-id-missing');

// Cross-file pairing requires explicit coordinate confirmation, a complete
// bijection and unique positions. Equal raster sizes are irrelevant.
const cross = input([20, 10], {positions:[{x:1,y:0}, {x:0,y:0}], sourceFrame:'other'});
assert.equal(core.calculate(input([2, 4]), cross).reason, 'coordinate-frame-unconfirmed');
const joined = core.calculate(input([2, 4]), cross, {coordinateConfirmed:true});
assert.deepEqual(Array.from(joined.values), [0.2, 0.2]);
assert.equal(joined.joinMethod, 'unique-coordinates');
assert.equal(core.calculate(dx, Object.assign({}, dy, {sourceFrame:'other'}), {coordinateConfirmed:true}).reason, 'coordinate-duplicate');
assert.equal(core.calculate(input([2]), cross, {coordinateConfirmed:true}).reason, 'source-row-count-mismatch');
assert.equal(core.calculate(input([2,4]), input([1,2], {sourceFrame:'other', positions:[{x:10,y:0},{x:11,y:0}]}), {coordinateConfirmed:true}).reason, 'source-coordinate-mismatch');
assert.equal(core.calculate(input([2]), input([1], {sourceFrame:'other', positions:[{x:NaN,y:0}]}), {coordinateConfirmed:true}).reason, 'coordinate-unavailable');

// A union visits each original row once. Numeric ROI statistics do not accept
// display settings, smoothing, intensity windows or Otsu as implicit filters.
const union = core.summarize(r, [(x) => x <= 1, (x) => x >= 1 && x <= 2]);
assert.equal(union.nCandidate, 3);
assert.equal(union.nValid, 3);
assert.equal(core.summarize(r, new Uint8Array([1,0,0,0,0,0,0])).totalRatio, 10);
assert.equal(core.summarize(r, []).status, 'empty');
assert.equal(core.summarize(r, () => null).reason, 'roi-geometry-unavailable');
assert.equal(core.summarize(r, [() => null, () => true]).nCandidate, 7);
assert.throws(() => core.summarize(r, [true]), /different row count/);
const points = Array.from(core.rows(r));
assert.equal(points.length, 7);
assert.equal(points[3].valid, false);
assert.equal(points[3].reason, 'denominator-zero');
assert.equal(points[0].numeratorValue, 10);
assert.equal(points[0].denominatorRowId, 0);
assert.equal(Array.from(core.rows(r, (x) => x === 0)).length, 1);

// Invalid coordinates are reported separately and never enter an ROI count.
const unlocated = core.calculate(input([1,2], {positions:[{x:0,y:0},{x:NaN,y:0}]}), input([1,1], {positions:[{x:0,y:0},{x:NaN,y:0}]}));
assert.equal(unlocated.summary.nCandidate, 1);
assert.equal(unlocated.summary.unlocatedRows, 1);
assert.equal(Array.from(core.rows(unlocated)).length, 2);

// Preserve the existing precision barrier instead of pretending rounded source
// cells are exact. A selected ROI that excludes the unsafe row remains usable.
for (const status of ['unsafe-integer', 'unsupported-decimal', 'unsupported-type']) {
    const unsafe = core.calculate(input([1,2], {sourceCells:[{status:'valid'}, {status}]}), input([1,1]));
    assert.equal(unsafe.status, 'unavailable');
    assert.equal(unsafe.reason, 'unsupported-source-precision');
    assert.equal(unsafe.summary.status, 'unavailable');
    assert.equal(core.summarize(unsafe, x => x === 0).totalRatio, 1);
}
const missing = core.calculate(input([NaN,NaN], {sourceCells:[{status:'blank'},{status:'invalid-cell'}]}), input([1,1]));
assert.deepEqual(core.reasonNames(missing.reasons[0]), ['numerator-missing']);
assert.deepEqual(core.reasonNames(missing.reasons[1]), ['numerator-invalid']);
const overflow = core.calculate(input([Number.MAX_VALUE]), input([Number.MIN_VALUE]));
assert.equal(overflow.status, 'empty');
assert.deepEqual(core.reasonNames(overflow.reasons[0]), ['ratio-nonfinite']);
const huge = core.calculate(input([Number.MAX_VALUE, Number.MAX_VALUE]), input([1,1]));
assert.equal(huge.summary.sumX, null);
assert.equal(huge.summary.totalRatio, null);
assert.equal(huge.summary.totalRatioReason, 'aggregate-nonfinite');
assert.equal(huge.summary.mean, Number.MAX_VALUE);
assert.equal(huge.summary.median, Number.MAX_VALUE);
const tiny = core.calculate(input([Number.MIN_VALUE, Number.MIN_VALUE]), input([1,1]));
assert.equal(tiny.summary.mean, Number.MIN_VALUE);
assert.equal(tiny.summary.median, Number.MIN_VALUE);
const compensated = core.calculate(input([1e16,1,1]), input([1,1,1]));
assert.equal(compensated.summary.sumX, 10000000000000002);
assert.deepEqual([snapshot(x), snapshot(y)], originals);

// Browser UMD and the real worker entry run the identical implementation.
const source = fs.readFileSync(path.join(__dirname, '../viewer/msi-ratio-core.js'), 'utf8');
const browser = vm.createContext({});
vm.runInContext(source, browser);
assert.equal(typeof browser.MsiRatioCore.calculate, 'function');
let reply, transferred;
const worker = vm.createContext({self:{postMessage:(data, buffers) => { reply = data; transferred = buffers; }}});
worker.importScripts = filename => { assert.equal(filename, 'msi-ratio-core.js'); vm.runInContext(source, worker); };
vm.runInContext(fs.readFileSync(path.join(__dirname, '../viewer/msi-ratio-worker.js'), 'utf8'), worker);
worker.self.onmessage({data:{id:'job', X:x, Y:y, options:{}}});
assert.equal(reply.id, 'job');
assert.equal(reply.result.summary.totalRatio, r.summary.totalRatio);
assert.deepEqual(Array.from(reply.result.values), Array.from(r.values));
assert.equal(transferred.length, 4);
for (const key of ['numerator','denominator','positions','rowIds']) assert.equal(key in reply.result, false);
worker.self.onmessage({data:{id:'bad', X:null, Y:y}});
assert.equal(reply.result.status, 'unavailable');
console.log('MSI ratio core and worker regression: OK');
