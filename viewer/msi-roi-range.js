/* Session-only ROI display summaries. Source samples and baked ranges are never changed. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MsiRoiRange = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';

    // A predicate or a list of predicates describes the visible ROI union.
    // true/false means known membership; null/undefined means unresolved geometry.
    // An overlapping sample is visited once, preserving distinct source rows that
    // happen to have identical coordinates.
    function membership(contains) {
        const predicates = contains == null ? [] : Array.isArray(contains) ? contains : [contains];
        if (!predicates.length) return null;
        if (predicates.some(fn => typeof fn !== 'function')) throw new TypeError('ROI membership must be a function');
        return function(a, b, c) {
            let unknown = false;
            for (const predicate of predicates) {
                const inside = predicate(a, b, c);
                if (inside === true) return true;
                if (inside !== false) unknown = true;
            }
            return unknown ? null : false;
        };
    }

    function absent(status, reason, raster) {
        const result = {status, n:0, min:null, max:null};
        if (reason) result.reason = reason;
        if (raster) { result.displayMin = null; result.displayMax = null; }
        return result;
    }

    // contains(x, y, index) operates in native raster coordinates. values must be
    // the raw value raster, before LUT, median/linear display effects or PNG bake.
    // This deliberately retains the existing averaging of rows in a raster cell.
    function summarizeRaster(raster, contains, options) {
        const includes = membership(contains);
        if (!includes) return absent('no-roi', null, true);
        if (!raster || !Number.isInteger(raster.W) || raster.W <= 0
            || !Number.isInteger(raster.H) || raster.H <= 0 || !raster.values
            || raster.values.length !== raster.W * raster.H) return absent('unavailable', 'raster-unavailable', true);
        const opts = options || {};
        const percentile = opts.percentile == null ? 0.999 : opts.percentile;
        if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) throw new RangeError('ROI percentile must be between 0 and 1');
        const selected = [];
        let min = Infinity, max = -Infinity;
        for (let index = 0; index < raster.values.length; index++) {
            const value = raster.values[index];
            if (!Number.isFinite(value)) continue;
            const inside = includes(index % raster.W, Math.floor(index / raster.W), index);
            if (inside === null) return absent('unavailable', 'roi-geometry-unavailable', true);
            if (!inside) continue;
            selected.push(value);
            if (value < min) min = value;
            if (value > max) max = value;
        }
        if (!selected.length) return absent('empty', null, true);
        // Match deriveBakeStats' constant-data behavior, including zero/negative
        // constants. Report actual extrema separately from this display fallback.
        let displayMin = min, displayMax = max;
        if (!(max > min)) {
            displayMin = 0;
            displayMax = Math.max(1, max);
        } else if (opts.bakeMode !== 'full') {
            selected.sort((a, b) => a - b);
            const candidate = selected[Math.round(percentile * (selected.length - 1))];
            displayMax = candidate > min ? candidate : max;
        }
        return {status:'ready', n:selected.length, min, max, displayMin, displayMax};
    }

    // contains(row, index) receives an original source row. No coordinate
    // deduplication, smoothing, Otsu mask or display-raster conversion is applied.
    function summarizeRows(rows, contains) {
        const includes = membership(contains);
        if (!includes) return absent('no-roi');
        if (!rows || typeof rows[Symbol.iterator] !== 'function') return absent('unavailable', 'source-unavailable');
        let n = 0, min = Infinity, max = -Infinity, index = 0;
        for (const row of rows) {
            const rowIndex = index++;
            if (!row || !Number.isFinite(row.x) || !Number.isFinite(row.y)) continue;
            const inside = includes(row, rowIndex);
            if (inside === null) return absent('unavailable', 'roi-geometry-unavailable');
            if (!inside) continue;
            const cell = row.sourceCells && row.sourceCells.v;
            if (cell && ['unsafe-integer','unsupported-decimal','unsupported-type'].includes(cell.status)) {
                return absent('unavailable', 'unsupported-source-precision');
            }
            if (!Number.isFinite(row.v)) continue;
            n++;
            if (row.v < min) min = row.v;
            if (row.v > max) max = row.v;
        }
        return n ? {status:'ready', n, min, max} : absent('empty');
    }

    return {summarizeRaster, summarizeRows};
});
