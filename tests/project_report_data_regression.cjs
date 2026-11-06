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
      {sectionId: 'a', name: '切片A', raster: a, stats: duplicateStats,
        pixelPitch: {x: 50, y: 80}, registeredPixelPitch: {x: 25, y: 40}},
      {sectionId: 'b', name: '切片B', raster: b},
      {sectionId: 'missing', name: '欠損', missingReason: '元データなし', stats: {max: null, mean: null, n: 0},
        registeredPixelPitch: {x: 30, y: 60}}
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
  assert.deepEqual(molecule.sections[0].registeredPixelPitch, {x: 25, y: 40}, 'measurement labels survive independently of resampled display pitch');
  assert.deepEqual(molecule.sections[0].pixelPitch, {x: 50, y: 80});
  assert.equal(molecule.sections[1].registeredPixelPitch, null, 'unknown registration stays unknown');
  assert.deepEqual(molecule.sections[2].registeredPixelPitch, {x: 30, y: 60}, 'load failure retains known registration');
  molecule.sections[0].registeredPixelPitch.x = 999;
  assert.deepEqual(source.molecules[0].sections[0].registeredPixelPitch, {x: 25, y: 40}, 'prepared metadata does not alias its source');
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
  // Rulers follow the displayed horizontal direction after rotation. The
  // physical distance is independent of PNG up/down-sampling and padding.
  const calibrated = await Data.render(native, 6, {...nativeOptions, pixelPitch: {x: 25, y: 40}});
  close(calibrated.physicalWidthUm, 75); close(calibrated.physicalHeightUm, 80);
  const calibratedRotation = await Data.render(native, 6, {createCanvas, transform: rotate, pixelPitch: {x: 25, y: 40}});
  close(calibratedRotation.physicalWidthUm, 80); close(calibratedRotation.physicalHeightUm, 75);
  const angle = Math.PI / 4, diagonal = [[Math.cos(angle), -Math.sin(angle), 0], [Math.sin(angle), Math.cos(angle), 0], [0, 0, 1]];
  const diagonalImage = await Data.render(native, 6, {...nativeOptions, transform: diagonal, pixelPitch: {x: 25, y: 40}});
  close(diagonalImage.physicalWidthUm / diagonalImage.width, Math.hypot(25, 40) / Math.sqrt(2));
  for (const pitch of [null, {x: 0, y: 25}, {x: Infinity, y: 25}, {x: '25', y: 25}]) {
    assert.equal((await Data.render(native, 6, {...nativeOptions, pixelPitch: pitch})).physicalWidthUm, undefined);
  }
  const referenceCanvas = createCanvas(3, 2), referenceContext = referenceCanvas.getContext('2d');
  referenceContext.fillStyle = '#ff0000'; referenceContext.fillRect(0, 0, 1, 1);
  const optical = Data.renderReference(referenceCanvas, rotate, {createCanvas});
  assert.equal(optical.width, 2); assert.equal(optical.height, 3);
  const referencePixel = pixel(await decode(optical), 1, 0);
  assert.deepEqual(referencePixel.slice(0, 3), [255, 0, 0]);
  assert.ok(referencePixel[3] > 200, 'rotated optical pixel remains in the expected location');
  assert.equal(Data.renderReference(null, rotate, {createCanvas}), null);
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
  const references = await Data.prepare({...source, molecules: [], loadSectionReferences: async () => [
    {id: 'a', name: '切片A', referenceLabel: 'Optical', referenceImage: optical}
  ]}, nativeOptions);
  assert.equal(references.sections[0].referenceImage.data, optical.data);
  assert.deepEqual(references.sections.map(section => section.id), ['a', 'b', 'missing'], 'optional references never remove or reorder sections');
  assert.equal(references.sections[1].referenceImage, undefined);
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
  const Geometry=require('../viewer/msi-display-geometry.js');
  const physicalRaster={W:2,H:2,values:Float64Array.from([0,10,20,30])};
  const physicalFrame=Geometry.createFrame({width:2,height:2,sourceWidth:2,sourceHeight:2,
    registeredPitch:{x:'30',y:'60'},aspectMode:'physical'});
  const redLut=Array.from({length:256},(_,i)=>[i,0,0]);
  const displayStyle={mode:'same',rangePolicy:'maximum',lut:redLut,background:[0,0,0],colormap:'red',smoothing:'none',otsu:true};
  const styledInput={projectName:'Style',displayStyle,sections:[{id:'s',name:'S'}],molecules:[{key:'m',name:'M',sections:[{
    sectionId:'s',raster:physicalRaster,transform:physicalFrame.matrix,frame:physicalFrame,pixelPitch:physicalFrame.displayPitch,
    displayWindow:{min:10,max:30},keepGrid:{W:2,H:2,keep:Uint8Array.from([1,1,1,0])},stats:{mean:123,max:999,n:7}}]}]};
  const styled=await Data.prepare(styledInput,nativeOptions),styledEntry=styled.molecules[0].sections[0];
  assert.equal(styledEntry.image.width,2);assert.equal(styledEntry.image.height,4);
  close(styledEntry.image.physicalWidthUm,60);close(styledEntry.image.physicalHeightUm,120);
  const styledPixels=await decode(styledEntry.image);
  assert.deepEqual(pixel(styledPixels,0,2),[128,0,0,255]);assert.deepEqual(pixel(styledPixels,1,2),[0,0,0,255],'captured Otsu masks affect only display colours');
  assert.equal(styledEntry.mean,123);assert.equal(styledEntry.max,999);assert.equal(styledEntry.n,7);
  assert.deepEqual(Array.from(physicalRaster.values),[0,10,20,30]);assert.equal(styled.intensityScale.basis,'display-style');
  const ticCanvas=createCanvas(2,2),ticContext=ticCanvas.getContext('2d');ticContext.fillStyle='#808080';ticContext.fillRect(0,0,2,2);
  const physicalTic=Data.renderReference(ticCanvas,physicalFrame.matrix,{createCanvas,frame:physicalFrame,drawingRects:Geometry.drawingRects(physicalFrame)});
  assert.equal(physicalTic.width,2);assert.equal(physicalTic.height,4,'TIC reference uses the same calibrated aspect as MSI details');
  assert.deepEqual(pixel(await decode(physicalTic),1,3),[128,128,128,255]);
  const unchangedOptical=Data.renderReference(ticCanvas,undefined,{createCanvas});assert.equal(unchangedOptical.width,unchangedOptical.height,'optical reference keeps its native basis');
  const physicalRotate=Geometry.createFrame({width:2,height:2,sourceWidth:2,sourceHeight:2,
    registeredPitch:{x:30,y:60},orientation:rotate,aspectMode:'physical'});
  const physicalRotated=await Data.render(physicalRaster,30,{...nativeOptions,transform:physicalRotate.matrix,frame:physicalRotate,pixelPitch:physicalRotate.displayPitch});
  assert.equal(physicalRotated.width,4);assert.equal(physicalRotated.height,2);close(physicalRotated.physicalWidthUm,120);
  const sourceFrame=Geometry.createFrame({width:4,height:1,sourceWidth:3,sourceHeight:1,
    registeredPitch:{x:30,y:60},aspectMode:'physical'});
  const resampled=await Data.render({W:4,H:1,values:Float64Array.from([1,2,3,4])},4,
    {...nativeOptions,transform:sourceFrame.matrix,frame:sourceFrame,pixelPitch:sourceFrame.displayPitch});
  close(resampled.physicalWidthUm,90,'source footprint is N × registered pitch after display-grid resampling');
  const smooth=await Data.render(raster([0,30]),30,{createCanvas,displayStyle:{...displayStyle,smoothing:'linear'},displayWindow:{min:0,max:30}});
  const smoothPixels=await decode(smooth),middle=pixel(smoothPixels,499,100)[0];
  assert.ok(middle>100&&middle<150,'linear display interpolation blends colours without changing measurements');
  const linearOptions={createCanvas,maxDimension:20,displayWindow:{min:0,max:30},displayStyle:{...displayStyle,smoothing:'linear'}};
  const legacyLinear=await Data.render(raster([0,30]),30,linearOptions);
  const fullLinear=await Data.render(raster([0,30]),30,{...linearOptions,displayStyle:{...linearOptions.displayStyle,linearStrength:10}});
  assert.equal(fullLinear.data,legacyLinear.data,'level 10 preserves the existing linear PPT pixels exactly');
  let previousLinear=-1;
  for(let level=1;level<=10;level++) {
    const stepped=await decode(await Data.render(raster([0,30]),30,{...linearOptions,
      displayStyle:{...linearOptions.displayStyle,linearStrength:level}}));
    const value=pixel(stepped,9,3)[0];
    assert.ok(value>previousLinear,'every Linear level moves from nearest towards full interpolation');
    previousLinear=value;
  }
  // The report's inverse sampler has opaque measurement/background colours.
  // Only the exterior of the transformed footprint is transparent; changing
  // interpolation strength must not move that crop or its alpha boundary.
  const smoothingAngle=37*Math.PI/180;
  const slantedTransform=[[Math.cos(smoothingAngle),-Math.sin(smoothingAngle),0],[Math.sin(smoothingAngle),Math.cos(smoothingAngle),0],[0,0,1]];
  let footprintAlpha;
  for(const level of [1,5,10]) {
    const image=await Data.render(raster([0,30]),30,{...linearOptions,transform:slantedTransform,
      displayStyle:{...linearOptions.displayStyle,linearStrength:level}});
    const output=await decode(image),bytes=output.getContext('2d').getImageData(0,0,image.width,image.height).data;
    const alpha=Array.from(bytes).filter((_,index)=>index%4===3);
    assert.ok(alpha.includes(0)&&alpha.includes(255),'rotated report retains a bounded opaque footprint on transparent exterior');
    if(footprintAlpha)assert.deepEqual(alpha,footprintAlpha,'Linear level does not change report crop/alpha under rotation');
    footprintAlpha=alpha;
  }
  const pulse=raster([0,0,0,100,100,100,0,0,0]),pulseBefore=Array.from(pulse.values);
  const pulseOptions={...nativeOptions,displayWindow:{min:0,max:100},displayStyle:{...displayStyle,smoothing:'median'}};
  const weak=await decode(await Data.render(pulse,100,{...pulseOptions,displayStyle:{...pulseOptions.displayStyle,smoothingStrength:1}}));
  const strong=await decode(await Data.render(pulse,100,{...pulseOptions,displayStyle:{...pulseOptions.displayStyle,smoothingStrength:10}}));
  assert.deepEqual(pixel(weak,4,0),[255,0,0,255],'3 x 3 median preserves the interior of a wider signal');
  assert.deepEqual(pixel(strong,4,0),[0,0,0,255],'21 x 21 median suppresses a narrow signal without spreading blur');
  assert.deepEqual(Array.from(pulse.values),pulseBefore,'PPT smoothing never rewrites measurement values');
  const noInterpolation={...pulseOptions,displayStyle:{...displayStyle,smoothing:'none'}};
  assert.equal((await Data.render(pulse,100,{...noInterpolation,displayStyle:{...noInterpolation.displayStyle,smoothingStrength:10}})).data,
    (await Data.render(pulse,100,noInterpolation)).data,'disabled Smoothing ignores remembered strength');
  const maskedPulse=raster([50,10000,10000,50]);maskedPulse.measuredMask=Uint8Array.from([1,0,1,1]);
  const maskedOptions={...nativeOptions,displayWindow:{min:0,max:100},keepGrid:{W:4,H:1,keep:Uint8Array.from([1,1,0,1])},
    displayStyle:{...displayStyle,smoothing:'median',smoothingStrength:10,background:[9,10,11]}};
  const masked=await decode(await Data.render(maskedPulse,100,maskedOptions));
  assert.deepEqual(pixel(masked,0,0),[128,0,0,255],'unmeasured and Otsu-hidden high values cannot bleed into valid pixels');
  assert.deepEqual(pixel(masked,3,0),[128,0,0,255]);
  assert.deepEqual(pixel(masked,1,0),[9,10,11,255]);assert.deepEqual(pixel(masked,2,0),[9,10,11,255]);
  assert.deepEqual(Array.from(maskedPulse.measuredMask),[1,0,1,1]);
  assert.deepEqual(Array.from(maskedOptions.keepGrid.keep),[1,1,0,1]);
  for(const smoothing of ['linear','median'])for(let level=1;level<=10;level++) {
    const smoothStats=await Data.prepare({...styledInput,displayStyle:{...displayStyle,smoothing,smoothingStrength:level,linearStrength:level}},nativeOptions);
    const smoothStatsEntry=smoothStats.molecules[0].sections[0];
    assert.deepEqual([smoothStatsEntry.mean,smoothStatsEntry.max,smoothStatsEntry.n],[123,999,7],`${smoothing} ${level}: PPT statistics stay on original measurement rows`);
    assert.equal(smoothStats.displayStyle.smoothingStrength,level);assert.equal(smoothStats.displayStyle.linearStrength,level);
  }
  assert.ok(Data.geometry({W: 700, H: 1, values: new Float64Array(700)}, null, 1400, true).width <= 1400);
  const controller = new AbortController();
  await assert.rejects(() => Data.prepare({...source, molecules: [{loadEntries: async () => {controller.abort(); return [];}}]},
    {createCanvas, signal: controller.signal}), error => error.name === 'AbortError');
  let current = true;
  await assert.rejects(() => Data.prepare({...source, assertCurrent: () => {if (!current) throw new Error('project-changed');},
    molecules: [{loadEntries: async () => {current = false; return [];}}]}, {createCanvas}), /project-changed/);
  console.log('project report data regression: passed');
})().catch(error => {console.error(error); process.exitCode = 1;});
