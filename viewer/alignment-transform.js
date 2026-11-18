/* Canonical HE -> MSI transforms. Pure data/math; no DOM, storage or rendering. */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.MsiAlignmentTransform = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';
    const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
    const MIN_DETERMINANT = 1e-12;
    // Only allow rounding from a scalar similarity's sin/cos arithmetic. A
    // genuine shear or unequal X/Y scale must never become editable scalars.
    const SIMILARITY_TOLERANCE = 64 * Number.EPSILON;
    const SCALAR_FIELDS = ['flip_lr', 'flip_ud', 'scale_pct', 'rotate_deg', 'offx', 'offy'];
    const RENDER_CONTRACT = 'msi-shared-display-v1';

    function clone(value, seen) {
        if (!value || typeof value !== 'object') return value;
        const visited = seen || new Map();
        if (visited.has(value)) return visited.get(value);
        if (value instanceof Date) return new Date(value.getTime());
        if (value instanceof ArrayBuffer) return value.slice(0);
        if (ArrayBuffer.isView(value)) {
            const bytes = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            return value instanceof DataView ? new DataView(bytes) : new value.constructor(bytes);
        }
        const result = Array.isArray(value) ? [] : {};
        visited.set(value, result);
        for (const key of Object.keys(value)) Object.defineProperty(result, key, {
            value: clone(value[key], visited), enumerable: true, configurable: true, writable: true
        });
        return result;
    }

    function fail(code, message) {
        const error = new Error(message);
        error.code = code;
        throw error;
    }

    function valid(T) {
        if (!Array.isArray(T) || T.length !== 3 || !T.every(row => Array.isArray(row)
            && row.length === 3 && row.every(Number.isFinite))
            || T[2][0] !== 0 || T[2][1] !== 0 || T[2][2] !== 1) return false;
        const det = T[0][0] * T[1][1] - T[0][1] * T[1][0];
        return Number.isFinite(det) && Math.abs(det) >= MIN_DETERMINANT;
    }

    function checked(T) {
        if (!valid(T)) fail('invalid-transform', 'The alignment matrix is invalid or cannot be inverted.');
        return clone(T);
    }

    function numberField(state, key, fallback) {
        const value = own(state, key) ? state[key] : fallback;
        if (!Number.isFinite(value)) fail('invalid-parameter', 'Alignment ' + key + ' must be a finite number.');
        return value;
    }

    function fromScalars(state) {
        const input = state || {};
        const scale = numberField(input, 'scale_pct', 100) / 100;
        if (!(scale > 0)) fail('invalid-scale', 'Alignment scale must be greater than zero.');
        const theta = numberField(input, 'rotate_deg', 0) * Math.PI / 180;
        const tx = numberField(input, 'offx', 0), ty = numberField(input, 'offy', 0);
        const sx = (input.flip_lr ? -1 : 1) * scale;
        const sy = (input.flip_ud ? -1 : 1) * scale;
        const cos = Math.cos(theta), sin = Math.sin(theta);
        return checked([[cos * sx, -sin * sy, tx], [sin * sx, cos * sy, ty], [0, 0, 1]]);
    }

    // Presence is intentional: a corrupt canonical matrix must not fall back
    // to old scalar values, an alias, or a world-coordinate matrix.
    function matrix(state) {
        const input = state || {};
        if (own(input, 'T_he_to_msi')) return checked(input.T_he_to_msi);
        if (own(input, 'T')) return checked(input.T);
        return fromScalars(input);
    }

    function sameLinear(A, B, scale) {
        const tolerance = SIMILARITY_TOLERANCE * scale;
        return Math.abs(A[0][0] - B[0][0]) <= tolerance
            && Math.abs(A[0][1] - B[0][1]) <= tolerance
            && Math.abs(A[1][0] - B[1][0]) <= tolerance
            && Math.abs(A[1][1] - B[1][1]) <= tolerance;
    }

    function similarityParameters(T, preferred) {
        const a = T[0][0], b = T[0][1], c = T[1][0], d = T[1][1];
        const sx = Math.hypot(a, c), sy = Math.hypot(b, d);
        const extent = Math.max(sx, sy);
        if (!(sx > 0 && sy > 0) || !Number.isFinite(extent)
            || Math.abs(sx - sy) > SIMILARITY_TOLERANCE * extent
            || Math.abs((a / sx) * (b / sy) + (c / sx) * (d / sy)) > SIMILARITY_TOLERANCE) return null;
        const reflected = a * d - b * c < 0;
        let flipLr = !!preferred.flip_lr, flipUd = !!preferred.flip_ud;
        if ((flipLr !== flipUd) !== reflected) { flipLr = reflected; flipUd = false; }
        const sign = flipLr ? -1 : 1;
        const params = {flip_lr: flipLr, flip_ud: flipUd, scale_pct: sx * 100,
            rotate_deg: Math.atan2(c * sign, a * sign) * 180 / Math.PI,
            offx: T[0][2], offy: T[1][2]};
        // Preserve the original scalar parameterization (e.g. both flips or
        // a full turn) if it describes this matrix. T itself is never rebuilt.
        if (SCALAR_FIELDS.every(key => own(preferred, key))
            && typeof preferred.flip_lr === 'boolean' && typeof preferred.flip_ud === 'boolean'
            && Number.isFinite(preferred.scale_pct) && preferred.scale_pct > 0
            && Number.isFinite(preferred.rotate_deg) && Number.isFinite(preferred.offx)
            && Number.isFinite(preferred.offy)) {
            let candidate = null;
            try { candidate = fromScalars(preferred); } catch (_) { /* canonical T remains authoritative */ }
            if (candidate && sameLinear(T, candidate, extent)) {
                for (const key of ['flip_lr', 'flip_ud', 'scale_pct', 'rotate_deg']) params[key] = preferred[key];
            }
        }
        return params;
    }

    function restore(record, fallbackT) {
        const input = record || {}, result = clone(input);
        const T = own(input, 'T_he_to_msi') || own(input, 'T') ? matrix(input)
            : fallbackT != null ? checked(fallbackT) : fromScalars(input);
        result.T_he_to_msi = T;
        const params = similarityParameters(T, input);
        result.transformModel = params ? 'similarity' : 'affine';
        if (params) Object.assign(result, params);
        else Object.assign(result, {flip_lr: null, flip_ud: null, scale_pct: null,
            rotate_deg: null, offx: T[0][2], offy: T[1][2]});
        // Loading is never an instruction to refit a saved manual correction.
        result.fitMode = input.fitMode === 'automatic' ? 'automatic' : 'manual';
        return result;
    }

    function upgrade(state, method) {
        if (typeof method !== 'string' || !method) fail('invalid-method', 'An alignment method is required.');
        const result = restore(state);
        result.renderContract = RENDER_CONTRACT;
        result.alignmentContractVersion = 2;
        result.fitMode = method === 'landmarks' ? 'automatic' : 'manual';
        result.fitProvenance = {version: 1, method,
            transformSignature: JSON.stringify(result.T_he_to_msi)};
        if (method === 'landmarks') {
            const points = result.landmarks || {};
            result.fitProvenance.pointCount = Array.isArray(points.he) ? points.he.length : 0;
            result.fitProvenance.landmarkSignature = JSON.stringify([points.he, points.msi,
                result.flip_lr, result.flip_ud]);
        }
        // A previous silhouette Dice is not a score for a manual/landmark fit.
        if (method !== 'silhouette') result.autoAligned = null;
        return result;
    }

    function anchorPoint(state, anchor) {
        if (anchor != null) {
            if (!Array.isArray(anchor) || anchor.length !== 2 || !anchor.every(Number.isFinite)) {
                fail('invalid-anchor', 'The alignment anchor must be a finite HE point.');
            }
            return anchor;
        }
        const points = state.landmarks || {};
        const count = Math.min(Array.isArray(points.he) ? points.he.length : 0,
            Array.isArray(points.msi) ? points.msi.length : 0);
        if (!count) fail('anchor-required', 'An HE image center is required when there are no paired landmarks.');
        let x = 0, y = 0;
        for (let i = 0; i < count; i++) {
            const point = points.he[i];
            if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite)) {
                fail('invalid-anchor', 'The HE landmark centroid is invalid.');
            }
            x += point[0] / count; y += point[1] / count;
        }
        if (!Number.isFinite(x) || !Number.isFinite(y)) fail('invalid-anchor', 'The HE landmark centroid is invalid.');
        return [x, y];
    }

    function edit(state, key, value, anchor) {
        if (!SCALAR_FIELDS.includes(key)) fail('invalid-control', 'Unknown alignment control: ' + key);
        const result = restore(state);
        if (result.transformModel !== 'similarity') {
            fail('affine-controls-unsupported', 'This affine alignment must be preserved or explicitly refitted from landmarks.');
        }
        if (key === 'flip_lr' || key === 'flip_ud') {
            if (typeof value !== 'boolean') fail('invalid-parameter', 'Alignment flips must be boolean values.');
        } else if (!Number.isFinite(value)) fail('invalid-parameter', 'Alignment ' + key + ' must be a finite number.');
        if (key === 'scale_pct' && !(value > 0)) fail('invalid-scale', 'Alignment scale must be greater than zero.');
        // A no-op must not round a canonical matrix, invalidate its score, or
        // convert a loaded legacy record to the corrected render contract.
        if (result[key] === value) return result;
        const previous = result.T_he_to_msi;
        result[key] = value;
        let next;
        if (key === 'offx' || key === 'offy') {
            next = clone(previous);
            next[key === 'offx' ? 0 : 1][2] = value;
        } else {
            const point = anchorPoint(result, anchor);
            const qx = previous[0][0] * point[0] + previous[0][1] * point[1] + previous[0][2];
            const qy = previous[1][0] * point[0] + previous[1][1] * point[1] + previous[1][2];
            next = fromScalars(result);
            next[0][2] = qx - next[0][0] * point[0] - next[0][1] * point[1];
            next[1][2] = qy - next[1][0] * point[0] - next[1][1] * point[1];
        }
        result.T_he_to_msi = checked(next);
        result.offx = next[0][2]; result.offy = next[1][2];
        if (own(result, 'T')) result.T = clone(next);
        return upgrade(result, 'manual');
    }

    function fit(landmarks, flags) {
        const points = landmarks || {}, source = points.he, target = points.msi;
        if (!Array.isArray(source) || !Array.isArray(target) || source.length < 2 || source.length !== target.length) {
            fail('landmark-pairs-required', 'At least two complete landmark pairs are required.');
        }
        if (!source.concat(target).every(point => Array.isArray(point) && point.length === 2
            && point.every(Number.isFinite))) fail('invalid-landmarks', 'Landmark coordinates must be finite numbers.');
        const input = flags || {}, flipLr = !!input.flip_lr, flipUd = !!input.flip_ud;
        const signX = flipLr ? -1 : 1, signY = flipUd ? -1 : 1, count = source.length;
        // Center relative to an observed point to avoid summing large absolute
        // coordinates unnecessarily. The model remains a proper similarity.
        let xs = 0, ys = 0, xd = 0, yd = 0;
        for (let i = 0; i < count; i++) {
            xs += (source[i][0] - source[0][0]) / count;
            ys += (source[i][1] - source[0][1]) / count;
            xd += (target[i][0] - target[0][0]) / count;
            yd += (target[i][1] - target[0][1]) / count;
        }
        const meanSX = (source[0][0] + xs) * signX, meanSY = (source[0][1] + ys) * signY;
        const meanDX = target[0][0] + xd, meanDY = target[0][1] + yd;
        let re = 0, im = 0, den = 0;
        for (let i = 0; i < count; i++) {
            const x = source[i][0] * signX - meanSX, y = source[i][1] * signY - meanSY;
            const u = target[i][0] - meanDX, v = target[i][1] - meanDY;
            re += u * x + v * y; im += v * x - u * y; den += x * x + y * y;
        }
        if (!Number.isFinite(den) || den < MIN_DETERMINANT) {
            fail('degenerate-landmarks', 'The HE landmarks must include at least two distinct locations.');
        }
        const a = re / den, b = im / den, scale = Math.hypot(a, b);
        const tx = meanDX - (a * meanSX - b * meanSY);
        const ty = meanDY - (b * meanSX + a * meanSY);
        const T = checked([[a * signX, -b * signY, tx], [b * signX, a * signY, ty], [0, 0, 1]]);
        const result = Object.assign(clone(input), {flip_lr: flipLr, flip_ud: flipUd,
            scale_pct: scale * 100, rotate_deg: Math.atan2(b, a) * 180 / Math.PI,
            offx: tx, offy: ty, landmarks: clone(points), T_he_to_msi: T});
        if (own(result, 'T')) result.T = clone(T);
        return upgrade(result, 'landmarks');
    }

    return {valid, fromScalars, matrix, restore, edit, fit, upgrade,
        MIN_DETERMINANT, RENDER_CONTRACT};
});
