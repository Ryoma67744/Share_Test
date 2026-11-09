/* The existing display TIC: average of each layer's baked 8-bit contribution.
 * This is deliberately not a sum of raw ion intensities. Shared with the parser worker. */
(function(root, factory) {
    const api = factory();
    api.workerSource = () => '(' + factory.toString() + ')()';
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TicCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function ticCoreFactory() {
    'use strict';
    const VERSION = 'display-tic-v1';
    function canonical(value) {
        if (value === undefined) return 'null';
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
        return '{' + Object.keys(value).filter(k => value[k] !== undefined).sort()
            .map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    }
    function create(width, height) {
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
            || !Number.isSafeInteger(width * height)) throw new Error('Invalid TIC dimensions');
        return {width, height, accum:new Float64Array(width * height), count:new Uint32Array(width * height), summed:0};
    }
    function accumulate(state, raster) {
        if (!raster || raster.width !== state.width || raster.height !== state.height) return false;
        const rr = raster.rawRange, values = raster.values, n = state.width * state.height;
        if (values && values.length === n && Array.isArray(rr) && Number.isFinite(rr[0]) && rr[1] > rr[0]) {
            const lo = rr[0], span = rr[1] - rr[0];
            for (let p = 0; p < n; p++) {
                const v = values[p];
                if (!Number.isFinite(v)) continue;
                state.accum[p] += Math.round(Math.max(0, Math.min(1, (v - lo) / span)) * 255);
                state.count[p]++;
            }
        } else {
            const pixels = raster.pixels;
            if (!pixels || pixels.length !== n * 4) return false;
            for (let p = 0, j = 0; p < n; p++, j += 4) {
                if (pixels[j + 3] === 0) continue;
                state.accum[p] += .299 * pixels[j] + .587 * pixels[j + 1] + .114 * pixels[j + 2];
                state.count[p]++;
            }
        }
        state.summed++;
        return true;
    }
    function finish(state) {
        if (!state.summed) return null;
        const n = state.width * state.height, pixels = new Uint8ClampedArray(n * 4);
        let maxAvg = 0;
        for (let p = 0; p < n; p++) if (state.count[p]) maxAvg = Math.max(maxAvg, state.accum[p] / state.count[p]);
        const norm = maxAvg > 0 ? 255 / maxAvg : 0;
        for (let p = 0, j = 0; p < n; p++, j += 4) {
            if (!state.count[p]) continue;
            const g = Math.max(0, Math.min(255, Math.round(state.accum[p] / state.count[p] * norm)));
            pixels[j] = pixels[j + 1] = pixels[j + 2] = g;
            pixels[j + 3] = 255;
        }
        return {width:state.width, height:state.height, pixels};
    }
    // Explicit parser inputs, including RAW snap. Derived statistics and UI windows
    // are not inputs: filling those during ordinary display must not invalidate a job.
    const FIELDS = ['kind','sheet','col_x','col_y','col_v','data_start_row','x','y','v',
        'dataStartLine','compound_index','v_index','func','channel','snap','annotation','colIdx','range','bakeMode','sep'];
    function source(entry, scope) {
        const e = entry || {}, path = e.storagePath || '';
        if (e.sourceHash) return {identity:['hash',e.sourceHash,e.sourceRevision || ''],durable:true};
        if (/\/publish-v2\//.test(path)) return {identity:['immutable-path',path,e.sourceRevision || ''],durable:true};
        if (!scope.shared && e.blobId) return {identity:['local-blob',e.blobId,e.sourceRevision || ''],durable:true};
        return {identity:['session-source',path || e.sourceUrl || e.blobId || '',e.sourceRevision || ''],durable:false};
    }
    function describe(scope, entries, reference, versions) {
        let durable = true;
        const layers = entries.map(({key,entry}) => {
            const src = source(entry, scope); durable = durable && src.durable;
            const def = {};
            for (const name of FIELDS) if (entry[name] !== undefined) def[name] = entry[name];
            return {key,source:src.identity,def};
        });
        const signature = canonical({version:VERSION,scope,reference,versions,layers});
        return {signature,durable};
    }
    return {VERSION,canonical,create,accumulate,finish,describe};
});
