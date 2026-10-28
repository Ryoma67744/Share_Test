'use strict';
const assert = require('node:assert/strict');
const {createCanvas, loadImage} = require('@napi-rs/canvas');
const Data = require('../viewer/project-report-data.js');
const nativeOptions = {createCanvas, nearestUpscale: false};

const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-11 * Math.max(1, Math.abs(expected)), message || `${actual} != ${expected}`);
const raster = values => ({W: values.length, H: 1, values: Float64Array.from(values)});
async function decode(image) {
  const decoded = await loadImage(image.data), canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(decoded, 0, 0);
  return canvas;
}
const pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data];
const sortedPercentile = (values, p) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const at = (sorted.length - 1) * p / 100, lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo] * (hi - at || 1) + (lo === hi ? 0 : sorted[hi] * (at - lo));
};

(async () => {
  // A pooled quantile differs from per-section upper bounds. Real zero and
  // negative values count; missing and nonfinite values do not.
  const a = raster([0, 10, 20, 1000000, NaN, Infinity]);
  a.measuredMask = Uint8Array.from([1, 1, 1, 0, 1, 1]);
  const b = raster([-10, 100]);
  const originalA = Array.from(a.values), originalMask = Array.from(a.measuredMask);
  const duplicateStats = Object.freeze({max: 100, mean: 140 / 3, n: 3});
  const source = {
    projectName: '登録済みプロジェクト', generatedAt: '2026-10-28T00:00:00Z', metadata: {machine: 'DESI'},
    sections: [{id: 'a', name: '切片A'}, {id: 'b', name: '切片B'}, {id: 'missing', name: '欠損'}],
    molecules: [{key: 'm', name: 'Glucose', subtitle: '181 > 89', sections: [
      {sectionId: 'a', name: '切片A', raster: a, stats: duplicateStats},
      {sectionId: 'b', name: '切片B', raster: b},
      {sectionId: 'missing', name: '欠損', missingReason: '元データなし', stats: {max: null, mean: null, n: 0}}
    ]}]
  };
  const result = await Data.prepare(source, nativeOptions);
  const molecule = result.molecules[0];
  close(molecule.upper, 99.36);
  assert.equal(molecule.displaySampleCount, 5);
  assert.equal(molecule.sections[0].mean, 140 / 3, 'quantitative mean comes from original rows, never raster representatives');
  assert.equal(molecule.sections[0].max, 100);
  assert.equal(molecule.sections[0].n, 3);
  assert.equal(molecule.sections[1].mean, null, 'missing source statistics must not be inferred from display intensities');
  assert.equal(molecule.sections[1].max, null);
  assert.equal(molecule.sections[2].image, null);
  assert.equal(molecule.sections[2].missingReason, '元データなし');
  assert.equal(result.intensityScale.basis, 'finite-measured-display-raster');
  assert.equal(result.intensityScale.statisticsBasis, 'original-measurement-rows');
  assert.equal(molecule.intensityScale.upperBasis, 'percentile');
  assert.equal(molecule.intensityScale.sampleCount, 5);
  assert.deepEqual(Array.from(a.values), originalA);
  assert.deepEqual(Array.from(a.measuredMask), originalMask);
  assert.equal(source.molecules[0].sections[0].stats, duplicateStats);
  const first = await decode(molecule.sections[0].image);
  assert.deepEqual(pixel(first, 0, 0), [0, 0, 0, 255], 'measured zero is opaque black');
  assert.deepEqual(pixel(first, 3, 0), [0, 0, 0, 0], 'unmeasured cells remain transparent');
  assert.equal(pixel(first, 4, 0)[3], 0, 'NaN is missing');
  assert.equal(pixel(first, 5, 0)[3], 0, 'Infinity is missing');
  const second = await decode(molecule.sections[1].image);
  assert.deepEqual(pixel(second, 0, 0), [0, 0, 0, 255], 'negative source intensities clip only in display');
  assert.deepEqual(pixel(second, 1, 0), [255, 255, 151, 255], 'p99.8 exceedances saturate at the final ramp colour');

  // Validate the selection algorithm against an independent sorted baseline
  // over ordered, reversed, tied and deterministic random distributions.
  let seed = 718;
  const random = Array.from({length: 10003}, () => {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
    return (seed % 129) - 50;
  });
  for (const values of [[4], [0, 0, 0], [NaN, Infinity], random, random.slice().sort((a, b) => a - b), random.slice().reverse()]) {
    for (const p of [0, 0.2, 50, 99.8, 100]) {
      const before = values.slice(), actual = Data.percentile(Float64Array.from(values), p);
      const expected = sortedPercentile(values, p);
      if (expected == null) assert.equal(actual, null); else close(actual, expected);
      assert.deepEqual(values, before);
    }
  }
  const precision = Float64Array.from([1, 1 + 1e-10, 1 + 2e-10]);
  assert.ok(Data.percentile(precision) > 1 + 1e-10, 'display quantile retains Float64 precision');
  close(Data.percentile([-Number.MAX_VALUE, Number.MAX_VALUE], 50), 0);
  assert.throws(() => Data.percentile(new BigInt64Array(2)), /配列/);
  assert.throws(() => Data.percentile([1], 101), /パーセンタイル/);
  assert.throws(() => Data.validateRaster({W: 2, H: 2, values: [1, 2]}), /ラスター/);
  assert.throws(() => Data.validateRaster({W: Data.MAX_SAMPLES + 1, H: 1, values: []}), /上限/);
  assert.throws(() => Data.validateRaster({W: 1, H: 1, values: [1], measuredMask: []}), /マスク/);
  assert.deepEqual(Data.statistics({max: 22, mean: 4, n: 0}), {max: null, mean: null, n: 0});

  // Pixel-level orientation checks on an asymmetric source detect accidental
  // 180° rotations, transposition, reflections and transformed-statistics bugs.
  const native = {W: 3, H: 2, values: Float64Array.from([1, 2, 3, 4, 5, 6])};
  const identity = await decode(await Data.render(native, 6, nativeOptions));
  const rotate = [[0, -1, 70], [1, 0, -12], [0, 0, 1]];
  const rotateBefore = JSON.stringify(rotate);
  const rotatedImage = await Data.render(native, 6, {...nativeOptions, transform: rotate});
  const rotated = await decode(rotatedImage);
  assert.equal(rotated.width, 2); assert.equal(rotated.height, 3);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
    assert.deepEqual(pixel(rotated, 1 - y, x), pixel(identity, x, y));
  }
  const reflected = await decode(await Data.render(native, 6, {...nativeOptions, transform: [[-1, 0, 0], [0, 1, 0], [0, 0, 1]]}));
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
    assert.deepEqual(pixel(reflected, 2 - x, y), pixel(identity, x, y));
  }
  const anisotropic = await Data.render(native, 6, {...nativeOptions, transform: [[2, 0, 0], [0, 1, 0], [0, 0, 1]]});
  assert.equal(anisotropic.width / anisotropic.height, 3, 'supplied non-square pixel aspect is preserved');
  assert.equal(JSON.stringify(rotate), rotateBefore);
  const thin = await Data.render(raster(Array(2800).fill(1)), 1, nativeOptions);
  assert.equal(thin.width, 1400); assert.equal(thin.height, 1);
  assert.equal(pixel(await decode(thin), 0, 0)[3], 255, 'downscaled thin images retain their measured row');

  // Lazy molecules are processed one at a time, with cancellation across the
  // asynchronous load boundary. All-empty images do not masquerade as zero.
  const events = [];
  const lazy = {...source, molecules: [1, 2].map(i => ({key: String(i), name: 'M' + i,
    loadEntries: async () => {events.push('load' + i); return [{sectionId: 'a', name: 'A', raster: raster([i])}];}}))};
  await Data.prepare(lazy, {...nativeOptions, onProgress: progress => events.push('render' + progress.index)});
  assert.deepEqual(events, ['load1', 'render1', 'load2', 'render2']);
  const empty = await Data.prepare({...source, molecules: [{key: 'empty', sections: [{sectionId: 'a', raster: raster([NaN])}]}]}, nativeOptions);
  assert.equal(empty.molecules[0].upper, 1);
  assert.equal(empty.molecules[0].percentileValue, null);
  assert.equal(empty.molecules[0].sections[0].image, null);
  const zeros = await Data.prepare({...source, molecules: [{key: 'zero', sections: [{sectionId: 'a', raster: raster([0, 0])}]}]}, nativeOptions);
  assert.equal(zeros.molecules[0].percentileValue, 0);
  assert.equal(zeros.molecules[0].upper, 1);
  assert.equal(zeros.molecules[0].intensityScale.upperBasis, 'unit-fallback');
  assert.ok(zeros.molecules[0].sections[0].image);
  const sparseValues = new Float64Array(1001); sparseValues[0] = 100;
  const sparse = await Data.prepare({...source, molecules: [{key: 'sparse', sections: [{sectionId: 'a',
    raster: {W: sparseValues.length, H: 1, values: sparseValues}}]}]}, nativeOptions);
  assert.equal(sparse.molecules[0].percentileValue, 0);
  assert.equal(sparse.molecules[0].upper, 100);
  assert.equal(sparse.molecules[0].intensityScale.upperBasis, 'positive-maximum-fallback');
  assert.match(sparse.intensityScale.note, /正の最大表示強度/);
  const metadata = [{label: '装置', value: 'DESI'}, {label: '条件', value: {solvent: ['MeOH', 'water']}}];
  const preserved = await Data.prepare({...source, metadata, molecules: [{key: 'meta', name: 'M',
    metadata: {dwell: 0.02, formula: 'C6H12O6', method: {instrument: 'registered'}}, sections: [
      {sectionId: 'a', metadata: [{label: 'Acquisition', value: 'registered'}], raster: raster([1])}
    ]}]}, nativeOptions);
  assert.ok(Array.isArray(preserved.metadata));
  assert.deepEqual(preserved.metadata, metadata);
  preserved.metadata[1].value.solvent.push('detached');
  assert.deepEqual(metadata[1].value.solvent, ['MeOH', 'water']);
  assert.equal(preserved.molecules[0].metadata.dwell, 0.02);
  assert.equal(preserved.molecules[0].metadata.method.instrument, 'registered');
  assert.deepEqual(preserved.molecules[0].sections[0].metadata, [{label: 'Acquisition', value: 'registered'}]);

  // Exercise the production orientation helper through the real adapter,
  // rather than assuming the helper called "Linear" returns a 2x2 matrix.
  const viewer = require('./viewer-runtime.cjs').runtime();
  const Adapter = require('../viewer/project-report-app.js');
  const section = {id: 'orientation', displayName: '回転切片', meta: {
    displayTransform: {version: 2, baseOrientation: 'native-raster', mirror: [1, 0, 0, 1]},
    viewerTransform: {rot: 90}
  }, images: {}, msiSeries: {MSI_m: {blobId: 'source', compoundMeta: {name: 'M'},
    quantVersion: 'msi-source-rows-v1', sourceStats: {n: 7}}}};
  const project = {displayName: 'Orientation', sections: [section]};
  const panel = {project, section, msiValueRasters: new Map(), async ensureMsiLayerLoaded(key) {
    this.msiValueRasters.set(key, native); return true;
  }};
  const app = {project, panels: new Map([[section.id, panel]])};
  const orientationInput = Adapter.createAdapter({getApp: () => app,
    transform: s => viewer.sectionLayerViewLinear(s, 'msi'), mean: () => 4, max: () => 9});
  const orientationSnapshot = JSON.stringify(section.meta);
  const adapterEntries = await orientationInput.molecules[0].loadEntries();
  assert.equal(adapterEntries[0].transform.length, 3);
  assert.ok(adapterEntries[0].transform.every(row => row.length === 3));
  const orientationReport = await Data.prepare(orientationInput, nativeOptions);
  const orientationMolecule = orientationReport.molecules[0], oriented = await decode(orientationMolecule.sections[0].image);
  const normal = await decode(await Data.render(native, orientationMolecule.upper, nativeOptions));
  assert.equal(oriented.width, 2); assert.equal(oriented.height, 3);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
    assert.deepEqual(pixel(oriented, 1 - y, x), pixel(normal, x, y), 'production rotation reaches the report unchanged');
  }
  assert.equal(orientationMolecule.sections[0].mean, 4);
  assert.equal(orientationMolecule.sections[0].max, 9);
  assert.equal(JSON.stringify(section.meta), orientationSnapshot);

  // Tiny native rasters must be enlarged with nearest sampling BEFORE PPT
  // embeds them. Every decoded PNG pixel belongs to an exact constant-colour
  // source block; no bilinear intermediate intensities are introduced.
  const tiny = {W: 8, H: 8, values: Float64Array.from({length: 64}, (_, i) => i)};
  const tinyBefore = Array.from(tiny.values);
  const enlargedReport = await Data.prepare({...source, molecules: [{key: 'tiny', name: 'Tiny', sections: [
    {sectionId: 'a', raster: tiny, stats: {max: 80, mean: 40, n: 70}}
  ]}]}, {createCanvas});
  const enlargedMolecule = enlargedReport.molecules[0], enlargedImage = enlargedMolecule.sections[0].image;
  assert.equal(enlargedImage.width, 1000); assert.equal(enlargedImage.height, 1000);
  const enlargedCanvas = await decode(enlargedImage);
  const enlargedPixels = enlargedCanvas.getContext('2d').getImageData(0, 0, 1000, 1000).data;
  const colors = tinyBefore.map(value => [...Data.colorAt(value, enlargedMolecule.upper), 255]);
  for (let y = 0; y < 1000; y++) for (let x = 0; x < 1000; x++) {
    const expected = colors[Math.floor(y / 125) * 8 + Math.floor(x / 125)], offset = (y * 1000 + x) * 4;
    for (let channel = 0; channel < 4; channel++) {
      assert.equal(enlargedPixels[offset + channel], expected[channel], 'every enlarged PNG pixel remains a source colour');
    }
  }
  assert.equal(enlargedMolecule.sections[0].max, 80);
  assert.equal(enlargedMolecule.sections[0].mean, 40);
  assert.equal(enlargedMolecule.sections[0].n, 70);
  close(enlargedMolecule.upper, Data.percentile(tiny.values));
  assert.equal(enlargedMolecule.displaySampleCount, 64, 'resized image pixels never enter the percentile population');
  assert.deepEqual(Array.from(tiny.values), tinyBefore);
  const enlargedRotation = await Data.render(native, 6, {createCanvas, transform: rotate});
  assert.equal(enlargedRotation.width, 668); assert.equal(enlargedRotation.height, 1002);
  const enlargedRotatedCanvas = await decode(enlargedRotation);
  for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) {
    assert.deepEqual(pixel(enlargedRotatedCanvas, (1 - y) * 334 + 167, x * 334 + 167), pixel(identity, x, y));
  }
  assert.equal(Data.geometry(tiny).width, 8, 'standalone geometry can retain native dimensions');
  assert.ok(Data.geometry({W: 700, H: 1, values: new Float64Array(700)}, null, 1400, true).width <= 1400);
  const controller = new AbortController();
  await assert.rejects(() => Data.prepare({...source, molecules: [{loadEntries: async () => {controller.abort(); return [];}}]},
    {createCanvas, signal: controller.signal}), error => error.name === 'AbortError');
  let current = true;
  await assert.rejects(() => Data.prepare({...source, assertCurrent: () => {if (!current) throw new Error('project-changed');},
    molecules: [{loadEntries: async () => {current = false; return [];}}]}, {createCanvas}), /project-changed/);
  console.log('project report data regression: passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
