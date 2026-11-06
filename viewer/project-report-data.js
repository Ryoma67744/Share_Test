(function(root, factory) {
  'use strict';
  const api = factory(typeof module === 'object' && module.exports ? require('./msi-smoothing.js') : root.MsiSmoothing);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ProjectReportData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(MsiSmoothing) {
  'use strict';
  const REPORT_REVISION = 'ppt-20261106-2';

  // Report colour clipping is a display operation. Quantitative table values
  // are supplied by the application's original-measurement statistics, never
  // calculated from a raster which may average duplicate coordinates.
  const MAX_SAMPLES = 20000000;
  const MAX_IMAGE_DIMENSION = 1400;
  const TARGET_IMAGE_DIMENSION = 1000;
  const PERCENTILE = 99.8;
  const COLOR_STOPS = Object.freeze([
    '#000000', '#00002E', '#00005C', '#00008A', '#0000B8', '#0000E5',
    '#1500E9', '#4400BB', '#71008D', '#9F0060', '#CC0032', '#FB0004',
    '#FF2B00', '#FF5800', '#FF8600', '#FFB400', '#FFE200', '#FFFF11',
    '#FFFF3E', '#FFFF6A', '#FFFF97'
  ]);
  const COLORS = COLOR_STOPS.map(s => [1, 3, 5].map(i => parseInt(s.slice(i, i + 2), 16)));
  const IDENTITY = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const yieldTask = () => new Promise(resolve => setTimeout(resolve, 0));
  const text = v => v == null ? '' : String(v);
  const metadataCopy = value => Array.isArray(value) ? value.map(metadataCopy)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, metadataCopy(item)]))
      : value;

  function numericArray(value) {
    return Array.isArray(value) || (ArrayBuffer.isView(value)
      && !(value instanceof DataView) && typeof value.length === 'number'
      && !/BigInt|BigUint/.test(Object.prototype.toString.call(value)));
  }

  function validateRaster(raster) {
    if (!raster || !Number.isSafeInteger(raster.W) || !Number.isSafeInteger(raster.H)
        || raster.W < 1 || raster.H < 1 || !Number.isSafeInteger(raster.W * raster.H)) {
      throw new Error('MSIラスターの画像サイズを確認できません。');
    }
    const size = raster.W * raster.H;
    if (size > MAX_SAMPLES) throw new Error('1分子の画像画素数がレポートの上限（2,000万）を超えています。');
    if (!numericArray(raster.values) || raster.values.length !== size) {
      throw new Error('元の強度に対応するMSIラスターがありません。');
    }
    if (raster.measuredMask != null && (!numericArray(raster.measuredMask) || raster.measuredMask.length !== size)) {
      throw new Error('MSIラスターの測定画素マスクが一致しません。');
    }
    return size;
  }

  function measured(raster, i) {
    return (raster.measuredMask == null || raster.measuredMask[i] === true
      || (Number.isFinite(raster.measuredMask[i]) && raster.measuredMask[i] !== 0))
      && Number.isFinite(raster.values[i]);
  }

  function statistics(stats) {
    const n = stats && Number.isSafeInteger(stats.n) && stats.n >= 0 ? stats.n : null;
    return {
      max: n === 0 || !stats || !Number.isFinite(stats.max) ? null : stats.max,
      mean: n === 0 || !stats || !Number.isFinite(stats.mean) ? null : stats.mean,
      n
    };
  }
  function ratioStatistics(stats) {
    if (!stats || typeof stats !== 'object') return null;
    const out={};
    for (const key of ['nCandidate','nValid','validFraction','nUniqueCoordinates','unlocatedRows',
      'sumX','sumY','totalRatio','mean','median','min','max']) out[key]=Number.isFinite(stats[key])?stats[key]:null;
    out.reasonCounts=Object.fromEntries(Object.entries(stats.reasonCounts || {})
      .filter(([,value])=>Number.isSafeInteger(value) && value>=0));
    return out;
  }

  function swap(a, i, j) { const tmp = a[i]; a[i] = a[j]; a[j] = tmp; }

  // In-place three-way selection on an owned Float64Array. Equal intensities
  // (including millions of real zeros) finish in one partition, without a
  // JS array sort, argument spreading, or narrowing DOUBLE data to Float32.
  function select(a, k) {
    let left = 0, right = a.length - 1;
    while (left < right) {
      const mid = left + Math.floor((right - left) / 2);
      const x = a[left], y = a[mid], z = a[right];
      const pivot = x < y ? (y < z ? y : Math.max(x, z)) : (x < z ? x : Math.max(y, z));
      let low = left, i = left, high = right;
      while (i <= high) {
        if (a[i] < pivot) swap(a, low++, i++);
        else if (a[i] > pivot) swap(a, i, high--);
        else i++;
      }
      if (k < low) right = low - 1;
      else if (k > high) left = high + 1;
      else return a[k];
    }
    return a[left];
  }

  function percentileOwned(values, p) {
    if (!values.length) return null;
    const index = (values.length - 1) * (p / 100);
    const low = Math.floor(index), high = Math.ceil(index), fraction = index - low;
    const a = select(values, low);
    if (low === high) return a;
    const b = select(values, high);
    // Avoid overflow for opposite-signed extreme finite values.
    return a * (1 - fraction) + b * fraction;
  }

  function percentile(values, p = PERCENTILE) {
    if (!numericArray(values) || values.length > MAX_SAMPLES) throw new Error('強度配列のサイズが不正です。');
    if (!Number.isFinite(p) || p < 0 || p > 100) throw new Error('パーセンタイルが不正です。');
    let count = 0;
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) count++;
    const copy = new Float64Array(count);
    for (let i = 0, j = 0; i < values.length; i++) if (Number.isFinite(values[i])) copy[j++] = values[i];
    return percentileOwned(copy, p);
  }

  function affine(input) {
    const m = input == null ? IDENTITY : input;
    if (!Array.isArray(m) || m.length !== 3
        || !m.every(row => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite))
        || Math.abs(m[2][0]) > 1e-10 || Math.abs(m[2][1]) > 1e-10 || Math.abs(m[2][2] - 1) > 1e-10) {
      throw new Error('MSIの表示座標を確認できません。');
    }
    const determinant = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-14) throw new Error('MSIの表示座標が特異です。');
    return m;
  }

  function geometry(raster, transform, maxDimension = MAX_IMAGE_DIMENSION, nearestUpscale = false, frame = null) {
    validateRaster(raster);
    const m = affine(transform);
    const corners = [[0, 0], [raster.W, 0], [0, raster.H], [raster.W, raster.H]];
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const [x, y] of corners) {
      const px = m[0][0] * x + m[0][1] * y + m[0][2];
      const py = m[1][0] * x + m[1][1] * y + m[1][2];
      left = Math.min(left, px); right = Math.max(right, px);
      top = Math.min(top, py); bottom = Math.max(bottom, py);
    }
    if (frame && frame.bounds) {
      left=frame.bounds.x;top=frame.bounds.y;right=left+frame.bounds.width;bottom=top+frame.bounds.height;
    }
    const worldWidth = right - left, worldHeight = bottom - top;
    if (![left, top, worldWidth, worldHeight].every(Number.isFinite) || worldWidth <= 0 || worldHeight <= 0) {
      throw new Error('MSIの表示範囲を確認できません。');
    }
    const limit = Math.max(1, Math.min(MAX_IMAGE_DIMENSION, Math.floor(maxDimension) || MAX_IMAGE_DIMENSION));
    const longest = Math.max(worldWidth, worldHeight);
    let scale = Math.min(1, limit / longest);
    if (nearestUpscale && longest < Math.min(TARGET_IMAGE_DIMENSION, limit)) {
      // PowerPoint interpolates tiny embedded PNGs when enlarging them. Make
      // measured pixels into actual constant-colour blocks before embedding.
      // One integer factor preserves aspect/orientation and never changes
      // the source raster or the percentile/statistics calculated from it.
      scale = Math.max(1, Math.min(Math.ceil(Math.min(TARGET_IMAGE_DIMENSION, limit) / longest),
        Math.floor(limit / longest)));
    }
    const width = Math.max(1, Math.ceil(worldWidth * scale - 1e-9));
    const height = Math.max(1, Math.ceil(worldHeight * scale - 1e-9));
    // A single uniform scale preserves physical aspect under rotations and
    // mirrors. The caller's affine already includes its saved pixel aspect.
    return { width, height, left, top, scale, matrix: m,
      padX: (width - worldWidth * scale) / 2, padY: (height - worldHeight * scale) / 2 };
  }

  function colorAt(value, upper) {
    const t = Math.max(0, Math.min(1, value / (upper > 0 ? upper : 1))) * (COLORS.length - 1);
    const low = Math.floor(t), high = Math.min(COLORS.length - 1, low + 1), f = t - low;
    return COLORS[low].map((v, i) => Math.round(v * (1 - f) + COLORS[high][i] * f));
  }

  function physicalDimensions(g, pitch) {
    if (!pitch || ![pitch.x, pitch.y].every(v => Number.isFinite(v) && v > 0)) return {};
    const m = g.matrix, det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    // A horizontal ruler measures distance along the displayed horizontal
    // axis. Invert the display affine before applying the calibrated pitches;
    // this also handles rotations, reflections and non-square source pixels.
    const horizontal = Math.hypot(m[1][1] * pitch.x / det, m[1][0] * pitch.y / det);
    const vertical = Math.hypot(m[0][1] * pitch.x / det, m[0][0] * pitch.y / det);
    const physicalWidthUm = g.width / g.scale * horizontal;
    const physicalHeightUm = g.height / g.scale * vertical;
    return [physicalWidthUm, physicalHeightUm].every(v => Number.isFinite(v) && v > 0)
      ? {physicalWidthUm, physicalHeightUm} : {};
  }

  // Optical/TIC references are already loaded image assets, never screen
  // captures with controls or annotation text. Keep their native colour and
  // use the same registered orientation as their corresponding image layer.
  function renderReference(source, transform, options) {
    const o = options || {}, w = source && (source.naturalWidth || source.width),
      h = source && (source.naturalHeight || source.height);
    if (!(w > 0 && h > 0)) return null;
    const m = affine(transform);
    const worldWidth = o.frame ? o.frame.bounds.width : Math.abs(m[0][0]) * w + Math.abs(m[0][1]) * h;
    const worldHeight = o.frame ? o.frame.bounds.height : Math.abs(m[1][0]) * w + Math.abs(m[1][1]) * h;
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(worldWidth, worldHeight));
    if (![worldWidth, worldHeight, scale].every(v => Number.isFinite(v) && v > 0)) return null;
    const width = Math.max(1, Math.ceil(worldWidth * scale)), height = Math.max(1, Math.ceil(worldHeight * scale));
    const makeCanvas = o.createCanvas || ((cw, ch) => {
      const canvas = document.createElement('canvas'); canvas.width = cw; canvas.height = ch; return canvas;
    });
    const canvas = makeCanvas(width, height); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = !o.frame;
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(m[0][0] * scale, m[1][0] * scale, m[0][1] * scale, m[1][1] * scale,
      o.frame ? (m[0][2]-o.frame.bounds.x)*scale : width / 2 - (m[0][0] * w + m[0][1] * h) * scale / 2,
      o.frame ? (m[1][2]-o.frame.bounds.y)*scale : height / 2 - (m[1][0] * w + m[1][1] * h) * scale / 2);
    if(o.drawingRects)for(const rect of o.drawingRects)ctx.drawImage(source,rect.source.x,rect.source.y,rect.source.width,rect.source.height,
      rect.dest.x,rect.dest.y,rect.dest.width,rect.dest.height);
    else ctx.drawImage(source, 0, 0);
    return {data: canvas.toDataURL('image/png'), width, height};
  }

  async function render(raster, upper, options) {
    const o = options || {}, g = geometry(raster, o.transform, o.maxDimension, o.nearestUpscale !== false, o.frame);
    const makeCanvas = o.createCanvas || ((w, h) => {
      if (typeof document === 'undefined') throw new Error('画像作製用Canvasが利用できません。');
      const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
    });
    const canvas = makeCanvas(g.width, g.height);
    canvas.width = g.width; canvas.height = g.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('画像作製用Canvasが利用できません。');
    const pixels = ctx.createImageData(g.width, g.height), rgba = pixels.data;
    const m = g.matrix, det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
    const style=o.displayStyle,win=o.displayWindow;
    const bounds=o.frame && o.frame.sampleBounds || {x:0,y:0,width:raster.W,height:raster.H};
    const strength=style && style.smoothing==='median' ? MsiSmoothing.normalizeLevel(style.smoothingStrength) : 0;
    const linearWeight=style && style.smoothing==='linear' ? MsiSmoothing.normalizeLevel(style.linearStrength,10)/10 : 0;
    let smoothed=null;
    const sample=(x,y)=>{
      const index=Math.max(0,Math.min(raster.H-1,y))*raster.W+Math.max(0,Math.min(raster.W-1,x));
      if(!measured(raster,index)||o.keepGrid && !o.keepGrid.keep[index])return style ? style.background || [0,0,0] : null;
      if(smoothed)return style.lut[smoothed[index]];
      if(!style)return colorAt(raster.values[index],upper);
      const t=Math.max(0,Math.min(1,(raster.values[index]-win.min)/(win.max-win.min)));
      return style.lut[Math.round(t*(style.lut.length-1))];
    };
    if(strength>0) {
      // Filter scalar display indices before the palette lookup. A nonmonotonic
      // colour map therefore cannot change the median's intensity ordering.
      // Source values, missing pixels and Otsu masks remain untouched.
      const indices=new Uint8Array(raster.W*raster.H),valid=new Uint8Array(raster.W*raster.H);
      for(let y=0;y<raster.H;y++) {
        if(y%128===0) { if(o.assertCurrent)o.assertCurrent();await yieldTask(); }
        for(let x=0;x<raster.W;x++) {
          const index=y*raster.W+x;
          valid[index]=measured(raster,index) && !(o.keepGrid && !o.keepGrid.keep[index]) ? 1 : 0;
          if(valid[index])indices[index]=Math.round(Math.max(0,Math.min(1,(raster.values[index]-win.min)/(win.max-win.min)))*(style.lut.length-1));
        }
      }
      smoothed=MsiSmoothing.medianIndices(indices,raster.W,raster.H,strength,valid);
      if(o.assertCurrent)o.assertCurrent();
    }
    // Rasterize the bounded output directly. Median uses display byte arrays
    // bounded by MAX_SAMPLES and never writes to measurement rasters.
    // Source measurements stay unchanged in either sampling mode.
    for (let y = 0; y < g.height; y++) {
      if (y % 128 === 0) { if (o.assertCurrent) o.assertCurrent(); await yieldTask(); }
      const py = g.top + (y + 0.5 - g.padY) / g.scale - m[1][2];
      for (let x = 0; x < g.width; x++) {
        const px = g.left + (x + 0.5 - g.padX) / g.scale - m[0][2];
        const sx = (m[1][1] * px - m[0][1] * py) / det;
        const sy = (-m[1][0] * px + m[0][0] * py) / det;
        if (sx < bounds.x || sy < bounds.y || sx >= bounds.x+bounds.width || sy >= bounds.y+bounds.height) continue;
        let color;
        if(style && style.smoothing==='linear') {
          const ix=Math.floor(sx-0.5),iy=Math.floor(sy-0.5),fx=sx-0.5-ix,fy=sy-0.5-iy;
          const a=sample(ix,iy),b=sample(ix+1,iy),c=sample(ix,iy+1),d=sample(ix+1,iy+1);
          const nearest=sample(Math.floor(sx),Math.floor(sy));
          color=[0,1,2].map(channel=>Math.round(nearest[channel]*(1-linearWeight)
            +((a[channel]*(1-fx)+b[channel]*fx)*(1-fy)+(c[channel]*(1-fx)+d[channel]*fx)*fy)*linearWeight));
        } else color=sample(Math.floor(sx),Math.floor(sy));
        if(!color)continue;
        const dest = (y * g.width + x) * 4;
        rgba[dest] = color[0]; rgba[dest + 1] = color[1]; rgba[dest + 2] = color[2]; rgba[dest + 3] = 255;
      }
    }
    if (o.assertCurrent) o.assertCurrent();
    ctx.putImageData(pixels, 0, 0);
    return {data: canvas.toDataURL('image/png'), width: g.width, height: g.height,
      ...physicalDimensions(g, o.pixelPitch)};
  }

  async function prepare(input, options) {
    const o = options || {};
    if (!input || !Array.isArray(input.molecules) || !Array.isArray(input.sections)) throw new Error('プロジェクトのレポート情報が不正です。');
    if(input.displayStyle && (!Array.isArray(input.displayStyle.lut)||input.displayStyle.lut.length!==256
        ||!input.displayStyle.lut.every(c=>Array.isArray(c)&&c.length===3&&c.every(v=>Number.isFinite(v)&&v>=0&&v<=255))))
      throw new Error('表示スタイルの配色を確認できません。');
    function assertCurrent() {
      if (o.signal && o.signal.aborted) { const error = new Error('レポート作製を中止しました。'); error.name = 'AbortError'; throw error; }
      if (typeof input.assertCurrent === 'function') input.assertCurrent();
    }
    assertCurrent();
    const result = {
      projectName: text(input.projectName), generatedAt: input.generatedAt || new Date().toISOString(),
      metadata: metadataCopy(input.metadata || {}), displayStyle:metadataCopy(input.displayStyle || null),
      sections: input.sections.map(s => ({...s})), molecules: [],
      intensityScale: {percentile: PERCENTILE, basis: 'finite-measured-display-raster',
        statisticsBasis: 'original-measurement-rows',
        note: '画像は同一分子の全切片に共通の表示ラスター p99.8 で配色。p99.8が0以下または計算不可の場合、正の最大表示強度、それも無い場合は1を表示上限に使用。最大・平均は元測定行の統計値を使用。欠損は測定ゼロに置換しない。'}
    };
    if(input.displayStyle)result.intensityScale={basis:'display-style',statisticsBasis:'original-measurement-rows',
      note:'全切片・全分子を開始時の表示スタイルで出力。Same自動上限は全出力切片で再計算。元測定行の最大・平均は変更しない。'};
    if(input.molecules.some(source=>source.kind==='ratio')) {
      result.intensityScale.statisticsBasis='per-layer';
      result.intensityScale.note+=' 比の統計は同じ有効な原本ペアから計算し、実測Intensityの統計とは区別する。';
    }
    for (let moleculeIndex = 0; moleculeIndex < input.molecules.length; moleculeIndex++) {
      assertCurrent();
      const source = input.molecules[moleculeIndex];
      const displayStyle=source.displayStyle || input.displayStyle;
      const entries = typeof source.loadEntries === 'function' ? await source.loadEntries() : source.sections;
      assertCurrent();
      if (!Array.isArray(entries)) throw new Error('分子の切片情報を読み込めません。');
      const states = [];
      let totalSize = 0, measuredCount = 0, max = -Infinity;
      for (const entry of entries) {
        assertCurrent();
        let error = entry.missingReason || null, size = 0, count = 0;
        if (entry.raster && !error) {
          size = validateRaster(entry.raster);
          totalSize += size;
          if (totalSize > MAX_SAMPLES) throw new Error('1分子の全切片の画像画素数がレポートの上限（2,000万）を超えています。');
          // Invalid transforms are explicit missing images, not silently
          // replaced by a scientifically different orientation.
          try { affine(entry.transform); } catch (e) { error = e.message; }
          if (!error) for (let i = 0; i < size; i++) {
            if (i % 262144 === 0) { assertCurrent(); await yieldTask(); }
            if (measured(entry.raster, i)) { count++; max = Math.max(max, entry.raster.values[i]); }
          }
        }
        if (!entry.raster && !error) error = '元データのMSI強度を利用できません。';
        if (!count && !error) error = '有効な測定画素がありません。';
        measuredCount += count;
        states.push({entry, size, count, error});
      }
      let pool = displayStyle ? null : new Float64Array(measuredCount), offset = 0;
      for (const state of states) if (state.count && pool) {
        const raster = state.entry.raster;
        for (let i = 0; i < state.size; i++) {
          if (i % 262144 === 0) { assertCurrent(); await yieldTask(); }
          if (measured(raster, i)) pool[offset++] = raster.values[i];
        }
      }
      const percentileValue = pool ? percentileOwned(pool, PERCENTILE) : null;
      pool = null;
      const upper = percentileValue > 0 ? percentileValue : (max > 0 ? max : 1);
      const upperBasis = percentileValue > 0 ? 'percentile' : (max > 0 ? 'positive-maximum-fallback' : 'unit-fallback');
      const molecule = {key: source.key, name: text(source.name), subtitle: text(source.subtitle), upper,
        ...(source.kind==='ratio'?{kind:'ratio',ratio:metadataCopy(source.ratio || {}),displayStyle:metadataCopy(displayStyle || null)}:{}),
        metadata: metadataCopy(source.metadata || {}), percentileValue, displaySampleCount: measuredCount,
        intensityScale: {percentile: PERCENTILE, percentileValue, sampleCount: measuredCount, upper, upperBasis,
          basis: 'finite-measured-display-raster'}, sections: []};
      if(displayStyle) {
        const ranges=states.map(s=>s.entry.displayWindow).filter(Boolean);
        molecule.upper=ranges.length?Math.max(...ranges.map(w=>w.max)):1;
        molecule.lower=ranges.length?Math.min(...ranges.map(w=>w.min)):0;
        molecule.intensityScale={basis:'display-style',upperBasis:'display-style',statisticsBasis:'original-measurement-rows'};
      }
      if(source.kind==='ratio') {
        molecule.intensityScale.statisticsBasis='valid-paired-original-rows';
        const formulas=[...new Set(entries.map(e=>text(e.metadata && e.metadata.formula)).filter(Boolean))];
        const formula=formulas.length>1?'Section-specific X / Y':formulas[0] || molecule.ratio.formula || 'X / Y';
        molecule.ratio.formula=formula;molecule.metadata.formula=formula;
        molecule.subtitle=formula+'  |  Y > '+molecule.ratio.denominatorMin;
      }
      for (const state of states) {
        assertCurrent();
        const entry = state.entry, stats = statistics(entry.stats);
        if(state.count && displayStyle && (!entry.displayWindow || !Number.isFinite(entry.displayWindow.min)
          || !Number.isFinite(entry.displayWindow.max) || !(entry.displayWindow.max>entry.displayWindow.min)))
          throw new Error('表示スタイルの強度範囲を確認できません。');
        const image = state.count ? await render(entry.raster, upper, {
          createCanvas: o.createCanvas, transform: entry.transform, frame:entry.frame, pixelPitch: entry.pixelPitch, assertCurrent,
          displayStyle, displayWindow:entry.displayWindow, keepGrid:entry.keepGrid,
          nearestUpscale: o.nearestUpscale !== false
        }) : null;
        molecule.sections.push({sectionId: entry.sectionId, name: text(entry.name), ...stats,
          ...(source.kind==='ratio'?{ratioStatistics:ratioStatistics(entry.ratioStatistics),
            ratioRois:(entry.ratioRois || []).map(row=>({roiId:text(row.roiId),name:text(row.name),
              status:text(row.status),reason:text(row.reason),
              statistics:ratioStatistics(row.statistics)}))}:{}),
          image, missingReason: state.error, pixelPitch: entry.pixelPitch || null, displayWindow:entry.displayWindow || null,
          registeredPixelPitch: metadataCopy(entry.registeredPixelPitch || null),
          otsuApplied:!!entry.keepGrid,
          archiveProvenance: metadataCopy(entry.archiveProvenance || null), qualityNote: text(entry.qualityNote),
          metadata: metadataCopy(entry.metadata || {})});
      }
      result.molecules.push(molecule);
      if (typeof o.onProgress === 'function') o.onProgress({phase: 'render', index: moleculeIndex + 1,
        total: input.molecules.length, moleculeKey: source.key, moleculeName: source.name});
      await yieldTask();
    }
    assertCurrent();
    if (typeof input.loadSectionReferences === 'function') {
      const references = await input.loadSectionReferences();
      assertCurrent();
      // References are optional. Preserve every registered section and its
      // order even when only some of them have a loaded optical/TIC image.
      if (Array.isArray(references)) result.sections = result.sections.map(section => {
        const reference = references.find(item => item.id === section.id);
        return reference && reference.referenceImage ? {...section,
          referenceImage: reference.referenceImage, referenceLabel: reference.referenceLabel} : section;
      });
    }
    return result;
  }

  return Object.freeze({REPORT_REVISION, prepare, render, renderReference, geometry, percentile, statistics, colorAt,
    validateRaster, COLOR_STOPS, MAX_SAMPLES, MAX_IMAGE_DIMENSION, TARGET_IMAGE_DIMENSION, PERCENTILE});
});
