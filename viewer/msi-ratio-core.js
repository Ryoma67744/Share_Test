/* Original-row signal ratios. No display transform, source mutation or persistence. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MsiRatioCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    const CALCULATION_VERSION = 'msi-ratio-v1';
    const REASONS = Object.freeze({
        'numerator-missing':1, 'numerator-invalid':2, 'numerator-nonfinite':4,
        'numerator-negative':8, 'denominator-missing':16, 'denominator-invalid':32,
        'denominator-nonfinite':64, 'denominator-negative':128, 'denominator-zero':256,
        'denominator-at-or-below-min':512, 'ratio-nonfinite':1024,
        'unsupported-source-precision':2048, 'coordinate-unavailable':4096
    });
    const PRECISION = new Set(['unsafe-integer', 'unsupported-decimal', 'unsupported-type']);
    const reasonNames = code => Object.keys(REASONS).filter(name => (code & REASONS[name]) !== 0);
    const unavailable = reason => ({status:'unavailable', reason, calculationVersion:CALCULATION_VERSION});
    const positioned = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);
    const samePoint = (a, b) => a && b && Object.is(a.x, b.x) && Object.is(a.y, b.y);
    const coordinateKey = p => positioned(p) ? p.x + '\u0000' + p.y : null;
    const rowId = (input, i) => input.rowIds ? input.rowIds[i] : input.positions[i] && input.positions[i].rowId;
    const validId = id => typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id));
    function inputError(input) {
        if (!input || !input.positions || !input.values
            || !Number.isInteger(input.positions.length) || input.positions.length !== input.values.length)
            return 'source-shape-mismatch';
        if (input.rowIds && input.rowIds.length !== input.values.length) return 'source-row-id-length-mismatch';
        if (input.sourceCells && input.sourceCells.length !== input.values.length) return 'source-cell-length-mismatch';
        if (input.values.length > 0xffffffff) return 'too-many-source-rows';
        return null;
    }
    // Return Y's index for every original X row. A raster's dimensions never
    // establish correspondence. Cross-source confirmation is explicit metadata.
    function alignRows(numerator, denominator, options) {
        const error = inputError(numerator) || inputError(denominator);
        if (error) return unavailable(error);
        const n = numerator.values.length;
        if (n !== denominator.values.length) return unavailable('source-row-count-mismatch');
        const order = new Uint32Array(n);
        const sameFrame = !!numerator.sourceFrame && numerator.sourceFrame === denominator.sourceFrame;
        if (sameFrame) {
            // Source scan/sheet row IDs normally increase strictly. Prove that
            // common case without million-entry Map/Set allocations.
            let ordered = true, previous;
            for (let i = 0; i < n; i++) {
                const id = rowId(numerator, i), other = rowId(denominator, i);
                if (!validId(id) || id !== other || (i && (typeof id !== typeof previous || !(id > previous)))) { ordered = false; break; }
                if (!samePoint(numerator.positions[i], denominator.positions[i])) return unavailable('source-coordinate-mismatch');
                previous = id; order[i] = i;
            }
            if (ordered) return {status:'ready', denominatorOrder:order, joinMethod:'source-row-id'};
            const target = new Map();
            for (let i = 0; i < n; i++) {
                const id = rowId(denominator, i);
                if (!validId(id)) return unavailable('source-row-id-missing');
                if (target.has(id)) return unavailable('source-row-id-duplicate');
                target.set(id, i);
            }
            const seen = new Set();
            for (let i = 0; i < n; i++) {
                const id = rowId(numerator, i);
                if (!validId(id)) return unavailable('source-row-id-missing');
                if (seen.has(id)) return unavailable('source-row-id-duplicate');
                seen.add(id);
                const j = target.get(id);
                if (j === undefined) return unavailable('source-row-id-mismatch');
                if (!samePoint(numerator.positions[i], denominator.positions[j])) return unavailable('source-coordinate-mismatch');
                order[i] = j;
            }
            return {status:'ready', denominatorOrder:order, joinMethod:'source-row-id'};
        }
        if (!options || options.coordinateConfirmed !== true) return unavailable('coordinate-frame-unconfirmed');
        const target = new Map();
        for (let i = 0; i < n; i++) {
            const key = coordinateKey(denominator.positions[i]);
            if (key === null) return unavailable('coordinate-unavailable');
            if (target.has(key)) return unavailable('coordinate-duplicate');
            target.set(key, i);
        }
        const seen = new Set();
        for (let i = 0; i < n; i++) {
            const key = coordinateKey(numerator.positions[i]);
            if (key === null) return unavailable('coordinate-unavailable');
            if (seen.has(key)) return unavailable('coordinate-duplicate');
            seen.add(key);
            if (!target.has(key)) return unavailable('source-coordinate-mismatch');
            order[i] = target.get(key);
        }
        return {status:'ready', denominatorOrder:order, joinMethod:'unique-coordinates'};
    }
    function cellAt(input, i) {
        const cell = input.sourceCells && input.sourceCells[i];
        return cell && cell.v ? cell.v : cell;
    }
    function precisionAt(input, i) {
        const cell = cellAt(input, i), p = input.positions[i];
        return input.precisionBlocked === true || (cell && PRECISION.has(cell.status))
            || (p && p.sourceCells && ['x', 'y'].some(k => p.sourceCells[k] && PRECISION.has(p.sourceCells[k].status)));
    }
    function valueReason(value, cell, role, minimum) {
        if (cell && ['missing', 'blank'].includes(cell.status)) return REASONS[role + '-missing'];
        if (cell && ['invalid', 'invalid-cell'].includes(cell.status)) return REASONS[role + '-invalid'];
        if (!Number.isFinite(value)) return REASONS[role + '-nonfinite'];
        if (value < 0) return REASONS[role + '-negative'];
        if (role === 'denominator') {
            if (value === 0) return REASONS['denominator-zero'];
            if (value <= minimum) return REASONS['denominator-at-or-below-min'];
        }
        return 0;
    }
    // Selection accepts a byte/boolean mask, one coordinate predicate, or a
    // predicate union. null selects all located rows; unknown geometry fails.
    function selectionPredicate(selection, n) {
        if (selection == null) return () => true;
        if (typeof selection === 'function') return selection;
        if (Array.isArray(selection) && selection.every(item => typeof item === 'function')) {
            return (x, y, i) => {
                let unknown = false;
                for (const predicate of selection) {
                    const inside = predicate(x, y, i);
                    if (inside === true) return true;
                    if (inside !== false) unknown = true;
                }
                return unknown ? null : false;
            };
        }
        if (!selection || selection.length !== n) throw new TypeError('Ratio selection mask has a different row count');
        return (x, y, i) => selection[i] === true || selection[i] === 1;
    }
    // Neumaier compensated sums; nonfinite totals are reported, never clamped.
    function accumulator() {
        let sum = 0, correction = 0;
        return {
            add(value) {
                const next = sum + value;
                if (!Number.isFinite(next)) { sum = next; correction = 0; return; }
                correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
                sum = next;
            },
            value() { return sum + correction; }
        };
    }
    function summarize(result, selection) {
        if (!result || !result.values) return unavailable(result && result.reason || 'ratio-unavailable');
        const n = result.values.length, includes = selectionPredicate(selection, n);
        const selected = new Uint8Array(n), counts = {}, coordinates = new Map();
        let nCandidate = 0, nValid = 0, nUniqueCoordinates = 0, unlocatedRows = 0, precisionBlocked = false;
        for (let i = 0; i < n; i++) {
            const p = result.positions[i];
            if (!positioned(p)) { unlocatedRows++; continue; }
            const inside = includes(p.x, p.y, i);
            if (inside !== true && inside !== false) return unavailable('roi-geometry-unavailable');
            if (!inside) continue;
            nCandidate++;
            if (result.reasons[i]) for (const reason of reasonNames(result.reasons[i])) counts[reason] = (counts[reason] || 0) + 1;
            if (result.reasons[i] & REASONS['unsupported-source-precision']) precisionBlocked = true;
            if (!result.valid[i]) continue;
            selected[i] = 1;
            nValid++;
            let xs = coordinates.get(p.y);
            if (!xs) { xs = new Set(); coordinates.set(p.y, xs); }
            if (!xs.has(p.x)) { xs.add(p.x); nUniqueCoordinates++; }
        }
        const base = {status:nValid ? 'ready' : 'empty', nCandidate, nValid,
            validFraction:nCandidate ? nValid / nCandidate : null,
            nUniqueCoordinates, unlocatedRows, reasonCounts:counts,
            denominatorMin:result.denominatorMin, calculationVersion:CALCULATION_VERSION,
            sumX:null, sumY:null, totalRatio:null, mean:null, median:null, min:null, max:null};
        if (precisionBlocked) return Object.assign(base, {status:'unavailable', reason:'unsupported-source-precision'});
        if (!nValid) return base;
        const sx = accumulator(), sy = accumulator(), sr = accumulator();
        const ratios = new Float64Array(nValid);
        let k = 0, min = Infinity, max = -Infinity;
        for (let i = 0; i < n; i++) {
            if (!selected[i]) continue;
            const j = result.denominatorOrder[i], r = result.values[i];
            sx.add(result.numerator.values[i]); sy.add(result.denominator.values[j]);
            sr.add(r);
            ratios[k++] = r;
            if (r < min) min = r;
            if (r > max) max = r;
        }
        ratios.sort();
        const middle = Math.floor(nValid / 2);
        const median = nValid % 2 ? ratios[middle] : ratios[middle - 1] + (ratios[middle] - ratios[middle - 1]) / 2;
        let mean = sr.value() / nValid;
        if (!Number.isFinite(mean)) {
            // Normalize only on overflow; dividing each tiny term by N first
            // would incorrectly underflow a perfectly representable mean.
            const scaled = accumulator();
            for (const r of ratios) scaled.add(r / max);
            mean = (scaled.value() / nValid) * max;
        }
        const sumX = sx.value(), sumY = sy.value();
        Object.assign(base, {sumX:Number.isFinite(sumX) ? sumX : null,
            sumY:Number.isFinite(sumY) ? sumY : null, mean:Number.isFinite(mean) ? mean : null,
            median, min, max});
        const ratio = sumX / sumY;
        if (Number.isFinite(sumX) && Number.isFinite(sumY) && sumY > 0 && Number.isFinite(ratio)) base.totalRatio = ratio;
        else { base.totalRatioStatus = 'unavailable'; base.totalRatioReason = 'aggregate-nonfinite'; }
        if (!Number.isFinite(mean)) { base.meanStatus = 'unavailable'; base.meanReason = 'aggregate-nonfinite'; }
        return base;
    }
    function calculate(numerator, denominator, options) {
        const opts = options || {}, minimum = opts.denominatorMin == null ? 0 : opts.denominatorMin;
        if (!Number.isFinite(minimum) || minimum < 0) return unavailable('invalid-denominator-min');
        const aligned = alignRows(numerator, denominator, opts);
        if (aligned.status !== 'ready') return aligned;
        const n = numerator.values.length, values = new Float64Array(n).fill(NaN);
        const valid = new Uint8Array(n), reasons = new Uint16Array(n);
        let precisionBlocked = false;
        for (let i = 0; i < n; i++) {
            const j = aligned.denominatorOrder[i], x = numerator.values[i], y = denominator.values[j];
            let reason = valueReason(x, cellAt(numerator, i), 'numerator', minimum)
                | valueReason(y, cellAt(denominator, j), 'denominator', minimum);
            if (precisionAt(numerator, i) || precisionAt(denominator, j)) {
                reason |= REASONS['unsupported-source-precision']; precisionBlocked = true;
            }
            if (!positioned(numerator.positions[i])) reason |= REASONS['coordinate-unavailable'];
            if (!reason) {
                const ratio = x / y;
                if (Number.isFinite(ratio)) { values[i] = ratio; valid[i] = 1; }
                else reason |= REASONS['ratio-nonfinite'];
            }
            reasons[i] = reason;
        }
        const result = {status:'ready', calculationVersion:CALCULATION_VERSION,
            denominatorMin:minimum, joinMethod:aligned.joinMethod, denominatorOrder:aligned.denominatorOrder,
            numerator, denominator, positions:numerator.positions, rowIds:numerator.rowIds,
            values, valid, reasons};
        result.summary = summarize(result);
        result.status = precisionBlocked ? 'unavailable' : result.summary.status;
        if (precisionBlocked) result.reason = 'unsupported-source-precision';
        return result;
    }
    // A lazy export/raster adapter. Even invalid rows retain identity and values.
    function* rows(result, selection) {
        if (!result || !result.values) return;
        const includes = selectionPredicate(selection, result.values.length);
        for (let i = 0; i < result.values.length; i++) {
            const p = result.positions[i], inside = selection == null ? true : positioned(p) && includes(p.x, p.y, i);
            if (inside !== true && inside !== false) throw new Error('roi-geometry-unavailable');
            if (!inside) continue;
            const j = result.denominatorOrder[i], numeratorRowId = rowId(result.numerator, i);
            yield {x:p && p.x, y:p && p.y, v:result.values[i], ratio:result.values[i], rowId:numeratorRowId,
                numeratorRowId, denominatorRowId:rowId(result.denominator, j),
                numeratorValue:result.numerator.values[i], denominatorValue:result.denominator.values[j],
                valid:!!result.valid[i], reason:reasonNames(result.reasons[i]).join(';'), reasonCode:result.reasons[i], index:i};
        }
    }
    return {CALCULATION_VERSION, REASONS, reasonNames, alignRows, calculate, summarize, rows};
});
