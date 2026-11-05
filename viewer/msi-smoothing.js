/* Display-only median denoising and adjustable linear interpolation.
 * Source measurements, source palettes and source pixels are never modified. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MsiSmoothing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    function normalizeLevel(value, fallback = 1) {
        const number = typeof value === 'number' && Number.isFinite(value) ? value
            : (typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 1);
        return Math.max(1, Math.min(10, Math.round(number)));
    }
    function medianIndices(indices, width, height, level, validMask) {
        const pixels = width * height;
        if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0
            || !Number.isSafeInteger(pixels)) {
            throw new RangeError('Invalid MSI median raster dimensions');
        }
        const type = Object.prototype.toString.call(indices);
        if (!['[object Uint8Array]', '[object Uint8ClampedArray]'].includes(type) || indices.length !== pixels) {
            throw new TypeError('MSI median filtering requires one byte index per raster pixel');
        }
        if (validMask != null && (typeof validMask !== 'object' || validMask.length !== pixels)) {
            throw new TypeError('MSI median mask must match the raster dimensions');
        }
        const result = new Uint8Array(indices);
        if (pixels === 1) return result;
        const radius = normalizeLevel(level);
        // Filter the ordered display-intensity indices before the colour map.
        // A 2-D median is not a pair of 1-D medians. Slide a full square window
        // horizontally and retain only its 256-bin histogram, plus 16 coarse
        // bins to locate each median without scanning all 256 intensity bins.
        // Working memory is bounded even for extremely wide native rasters.
        const fine = new Uint32Array(256), coarse = new Uint32Array(16);
        for (let y = 0; y < height; y++) {
            fine.fill(0); coarse.fill(0);
            const top = Math.max(0, y - radius), bottom = Math.min(height - 1, y + radius);
            const end = Math.min(width - 1, radius);
            let count = 0;
            for (let ny = top; ny <= bottom; ny++) {
                const row = ny * width;
                for (let nx = 0; nx <= end; nx++) {
                    const index = row + nx;
                    if (validMask != null && !(validMask[index] > 0)) continue;
                    const value = indices[index];
                    fine[value]++; coarse[value >> 4]++; count++;
                }
            }
            for (let x = 0; x < width; x++) {
                const center = y * width + x;
                if (count && (validMask == null || validMask[center] > 0)) {
                    // Select the lower middle value for an even valid count.
                    // This is deterministic at clipped edges and masked holes,
                    // and never introduces a colour between two tissue regions.
                    let rank = (count - 1) >> 1, block = 0;
                    while (rank >= coarse[block]) rank -= coarse[block++];
                    let value = block << 4;
                    while (rank >= fine[value]) rank -= fine[value++];
                    result[center] = value;
                }
                const removeX = x - radius, addX = x + radius + 1;
                for (let ny = top; ny <= bottom; ny++) {
                    const row = ny * width;
                    if (removeX >= 0) {
                        const index = row + removeX;
                        if (validMask == null || validMask[index] > 0) {
                            const value = indices[index];
                            fine[value]--; coarse[value >> 4]--; count--;
                        }
                    }
                    if (addX < width) {
                        const index = row + addX;
                        if (validMask == null || validMask[index] > 0) {
                            const value = indices[index];
                            fine[value]++; coarse[value >> 4]++; count++;
                        }
                    }
                }
            }
        }
        return result;
    }
    let scratch = null;
    function scratchCanvas(ctx, width, height) {
        const canvas = ctx.canvas;
        // Keep one recyclable display buffer, rather than retaining a second
        // full-size canvas for every MSI layer, thumbnail and export target.
        if (!scratch || scratch.constructor !== canvas.constructor) {
            if (canvas.ownerDocument && canvas.ownerDocument.createElement) {
                scratch = canvas.ownerDocument.createElement('canvas');
            } else if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
                scratch = new OffscreenCanvas(width, height);
            } else {
                scratch = new canvas.constructor(width, height);
            }
        }
        if (scratch.width !== width) scratch.width = width;
        if (scratch.height !== height) scratch.height = height;
        return scratch;
    }
    function drawBounds(source, args, matrix, width, height) {
        let x, y, w, h;
        if (args.length === 2) {
            [x, y] = args;
            w = source.naturalWidth || source.videoWidth || source.width;
            h = source.naturalHeight || source.videoHeight || source.height;
        } else if (args.length === 4) {
            [x, y, w, h] = args;
        } else if (args.length === 8) {
            [, , , , x, y, w, h] = args;
        }
        if (![x, y, w, h].every(Number.isFinite)) return {x:0, y:0, width, height};
        const xs = [], ys = [];
        for (const px of [x, x + w]) for (const py of [y, y + h]) {
            xs.push(matrix.a * px + matrix.c * py + matrix.e);
            ys.push(matrix.b * px + matrix.d * py + matrix.f);
        }
        // Two device pixels of transparent padding retain the browser's edge
        // coverage. Cropping is especially important for physical-frame images
        // drawn as many small patches into one large destination canvas.
        const left = Math.max(0, Math.floor(Math.min(...xs)) - 2);
        const top = Math.max(0, Math.floor(Math.min(...ys)) - 2);
        const right = Math.min(width, Math.ceil(Math.max(...xs)) + 2);
        const bottom = Math.min(height, Math.ceil(Math.max(...ys)) + 2);
        return {x:left, y:top, width:Math.max(0, right-left), height:Math.max(0, bottom-top)};
    }
    function drawImage(ctx, source, level, ...args) {
        const amount = normalizeLevel(level, 10) / 10;
        ctx.save();
        try {
            if (amount === 1) {
                // Level 10 is exactly the former Linear draw, including native
                // browser interpolation, pixel geometry and caller opacity.
                ctx.imageSmoothingEnabled = true;
                ctx.drawImage(source, ...args);
                return;
            }
            const width = ctx.canvas.width, height = ctx.canvas.height;
            if (!width || !height) return;
            const matrix = ctx.getTransform(), bounds = drawBounds(source, args, matrix, width, height);
            if (!bounds.width || !bounds.height) return;
            const buffer = scratchCanvas(ctx, bounds.width, bounds.height), blend = buffer.getContext('2d');
            blend.setTransform(1, 0, 0, 1, 0, 0);
            blend.clearRect(0, 0, bounds.width, bounds.height);
            blend.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - bounds.x, matrix.f - bounds.y);
            blend.imageSmoothingQuality = ctx.imageSmoothingQuality;
            // Addition of premultiplied RGBA yields a true crossfade, including
            // transparent edges. Two source-over draws would darken/attenuate
            // one sample and would not preserve the requested blend amount.
            blend.globalCompositeOperation = 'source-over';
            blend.globalAlpha = 1 - amount;
            blend.imageSmoothingEnabled = false;
            blend.drawImage(source, ...args);
            blend.globalCompositeOperation = 'lighter';
            blend.globalAlpha = amount;
            blend.imageSmoothingEnabled = true;
            blend.drawImage(source, ...args);
            // Apply caller opacity and composition once. Its clip is already
            // fixed in device coordinates, so resetting the transform here
            // retains clipping even under rotations, flips and physical pitch.
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(buffer, bounds.x, bounds.y);
        } finally {
            ctx.restore();
        }
    }
    return {normalizeLevel, medianIndices, drawImage};
});
