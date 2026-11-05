'use strict';
// Opt-in one-million-row benchmark. Timings describe this machine, not a UI SLA.
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');
const {createHash} = require('node:crypto');
const core = require('../viewer/msi-ratio-core.js');
const n = 1000000, x = new Float64Array(n), y = new Float64Array(n), rowIds = new Uint32Array(n);
const positions = Array.from({length:n}, (_, i) => ({x:i % 1000,y:Math.floor(i / 1000)}));
for (let i = 0; i < n; i++) { x[i] = 2 * ((i % 100) + 1); y[i] = (i % 100) + 1; rowIds[i] = i; }
const digest = array => createHash('sha256').update(Buffer.from(array.buffer)).digest('hex');
const before = [digest(x), digest(y)], memory = process.memoryUsage(), start = performance.now();
const result = core.calculate({values:x,positions,rowIds,sourceFrame:'benchmark'}, {values:y,positions,rowIds,sourceFrame:'benchmark'});
const elapsedMs = performance.now() - start, after = process.memoryUsage();
assert.equal(result.status, 'ready');
assert.equal(result.summary.nValid, n);
assert.equal(result.summary.nUniqueCoordinates, n);
for (const metric of ['mean','median','totalRatio','min','max']) assert.equal(result.summary[metric], 2);
assert.equal(result.summary.sumX, 101000000);
assert.equal(result.summary.sumY, 50500000);
assert.deepEqual([digest(x),digest(y)], before);
console.log(JSON.stringify({rows:n,elapsedMs:Math.round(elapsedMs),derivedResultBuffersBytes:
    result.values.byteLength + result.valid.byteLength + result.reasons.byteLength + result.denominatorOrder.byteLength,
    rssDeltaBytes:after.rss-memory.rss,heapUsedDeltaBytes:after.heapUsed-memory.heapUsed,note:'Parser, worker cloning, rendering and existing app caches excluded.'}));
