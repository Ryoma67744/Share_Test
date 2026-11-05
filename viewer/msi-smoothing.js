/* Display-only RGB smoothing. Source measurements and input pixels are never changed. */
(function(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.MsiSmoothing = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
    'use strict';
    function normalizeStrength(value) {
        return typeof value === 'number' && Number.isFinite(value)
            ? Math.max(0, Math.min(100, Math.round(value))) : 0;
    }
    function smoothRgba(rgba, width, height, strength, validMask) {
        const pixels = width * height, bytes = pixels * 4;
        if (!Number.isSafeInteger(width) || width <= 0 || !Number.isSafeInteger(height) || height <= 0
            || !Number.isSafeInteger(pixels) || !Number.isSafeInteger(bytes)) {
            throw new RangeError('Invalid MSI smoothing raster dimensions');
        }
        const type = Object.prototype.toString.call(rgba);
        if (!['[object Uint8Array]', '[object Uint8ClampedArray]'].includes(type) || rgba.length !== bytes) {
            throw new TypeError('MSI smoothing requires one RGBA byte array matching its dimensions');
        }
        if (validMask != null && (typeof validMask !== 'object' || validMask.length !== pixels)) {
            throw new TypeError('MSI smoothing mask must match the raster dimensions');
        }
        const result = new Uint8ClampedArray(rgba);
        const normalized = normalizeStrength(strength);
        if (!normalized || pixels === 1) return result;
        const sigma = 3 * normalized / 100, radius = Math.ceil(3 * sigma);
        const kernel = new Float64Array(2 * radius + 1);
        for (let offset = -radius; offset <= radius; offset++) {
            kernel[offset + radius] = Math.exp(-0.5 * (offset / sigma) ** 2);
        }
        // Keep only the horizontal sums needed by the vertical pass, instead
        // of full-raster Float32 intermediates. Prefer contiguous source rows
        // for cache locality; transpose unusually wide rasters to keep even a
        // twenty-million-pixel single row from allocating a huge buffer.
        const transposed = width > height && width > 16384;
        const rowWidth = transposed ? height : width, rowCount = transposed ? width : height;
        const rowStride = transposed ? 1 : width, columnStride = transposed ? width : 1;
        const slots = Math.min(rowCount, 2 * radius + 1), lineSize = rowWidth * 4;
        const rows = new Float32Array(slots * lineSize);
        const valid = index => rgba[index * 4 + 3] > 0 && (validMask == null || validMask[index] > 0);
        let prepared = -1;
        for (let y = 0; y < rowCount; y++) {
            const last = Math.min(rowCount - 1, y + radius);
            while (prepared < last) {
                const row = ++prepared, rowStart = (row % slots) * lineSize, sourceStart = row * rowStride;
                for (let x = 0; x < rowWidth; x++) {
                    let red = 0, green = 0, blue = 0, weight = 0;
                    const from = Math.max(0, x - radius), to = Math.min(rowWidth - 1, x + radius);
                    for (let nx = from; nx <= to; nx++) {
                        const index = sourceStart + nx * columnStride;
                        if (!valid(index)) continue;
                        const k = kernel[nx - x + radius], offset = index * 4;
                        red += rgba[offset] * k; green += rgba[offset + 1] * k; blue += rgba[offset + 2] * k;
                        weight += k;
                    }
                    const out = rowStart + x * 4;
                    rows[out] = red; rows[out + 1] = green; rows[out + 2] = blue; rows[out + 3] = weight;
                }
            }
            const from = Math.max(0, y - radius), to = Math.min(rowCount - 1, y + radius);
            for (let x = 0; x < rowWidth; x++) {
                const index = y * rowStride + x * columnStride;
                // Missing/Otsu-hidden pixels retain their original RGBA, as do
                // all original alpha values. Smoothing cannot fill a hole.
                if (!valid(index)) continue;
                let red = 0, green = 0, blue = 0, weight = 0;
                for (let ny = from; ny <= to; ny++) {
                    const offset = (ny % slots) * lineSize + x * 4, k = kernel[ny - y + radius];
                    red += rows[offset] * k; green += rows[offset + 1] * k; blue += rows[offset + 2] * k;
                    weight += rows[offset + 3] * k;
                }
                if (weight > 0) {
                    const offset = index * 4;
                    result[offset] = red / weight; result[offset + 1] = green / weight; result[offset + 2] = blue / weight;
                }
            }
        }
        return result;
    }
    return {normalizeStrength, smoothRgba};
});
