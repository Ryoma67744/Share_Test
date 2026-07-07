import * as XLSX from 'xlsx';

// =============================================================================
// MSI parsing / ROI extraction — ported VERBATIM from the web app
// (viewer/index.html) so the connector's numbers match what the app shows.
// Keep these in sync with the app's a1ColToIndex / buildMsiGrid /
// parseXlsxToRows / parseTxtToRows / pointInPolygon.
// =============================================================================

export function a1ColToIndex(colRef) {
  if (typeof colRef === 'number') return colRef;
  const s = String(colRef || '').toUpperCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 65 || c > 90) return NaN;
    n = n * 26 + (c - 64);
  }
  return n - 1;
}

export function pointInPolygon(x, y, vertices) {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i][0], yi = vertices[i][1];
    const xj = vertices[j][0], yj = vertices[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

// Reconstruct the MSI pixel grid from raw rows exactly as the app does, so ROI
// polygons (which live in this pixel space) line up with the raw coordinates.
export function buildMsiGrid(rows) {
  const xSet = new Set(), ySet = new Set();
  for (const r of rows) {
    if (!r) continue;
    if (Number.isFinite(r.x)) xSet.add(r.x);
    if (Number.isFinite(r.y)) ySet.add(r.y);
  }
  const ordinal = (vals) => new Map(vals.map((v, i) => [v, i]));
  const axis = (vals) => {
    const n = vals.length;
    if (n <= 1) return { index: ordinal(vals), size: Math.max(1, n) };
    let step = Infinity;
    for (let i = 1; i < n; i++) {
      const d = vals[i] - vals[i - 1];
      if (d > 0 && d < step) step = d;
    }
    if (!(step > 0) || !Number.isFinite(step)) return { index: ordinal(vals), size: n };
    const size = Math.round((vals[n - 1] - vals[0]) / step) + 1;
    const INFLATION_LIMIT = 4, ABS_CAP = 8192;
    if (!(size >= n) || size > ABS_CAP || size > n * INFLATION_LIMIT + 1) {
      return { index: ordinal(vals), size: n };
    }
    const index = new Map();
    const used = new Set();
    for (const v of vals) {
      const k = Math.round((v - vals[0]) / step);
      if (used.has(k)) return { index: ordinal(vals), size: n };
      used.add(k);
      index.set(v, k);
    }
    return { index, size };
  };
  const ax = axis([...xSet].sort((a, b) => a - b));
  const ay = axis([...ySet].sort((a, b) => a - b));
  return { xIndex: ax.index, yIndex: ay.index, W: ax.size, H: ay.size };
}

// xlsx ArrayBuffer/Buffer → [{x,y,v}] using the def stored in the project doc's
// storage_paths.msiSeries entry (sheet / data_start_row / col_x / col_y / col_v).
export function parseXlsxToRows(buf, def) {
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  const sheetName = def.sheet || wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error("sheet '" + sheetName + "' not found");
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  const startIdx = Math.max(0, (def.data_start_row || 1) - 1);
  const xi = a1ColToIndex(def.col_x);
  const yi = a1ColToIndex(def.col_y);
  const vi = a1ColToIndex(def.col_v);
  if (!Number.isFinite(xi) || !Number.isFinite(yi) || !Number.isFinite(vi)) {
    throw new Error('invalid xlsx column refs: ' + JSON.stringify(def));
  }
  const rows = [];
  for (let i = startIdx; i < aoa.length; i++) {
    const r = aoa[i]; if (!r) continue;
    const x = Number(r[xi]), y = Number(r[yi]), v = Number(r[vi]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(v)) rows.push({ x, y, v });
  }
  if (!rows.length) throw new Error('no numeric rows in xlsx');
  return rows;
}

// txt/tsv/csv ArrayBuffer/Buffer → [{x,y,v}] (Analyte-from-imzML or generic).
export function parseTxtToRows(buf, def) {
  const raw = new TextDecoder('utf-8').decode(buf);
  const linesAll = raw.split(/\r?\n/);
  if (linesAll.length < 1) throw new Error('empty txt');
  const isAnalyte = /Analyte\s*\(converted from imzML\)/i.test(linesAll[0] || '');
  const rows = [];
  if (isAnalyte || def.kind === 'txt-analyte' || Number.isFinite(def.compound_index) || Number.isFinite(def.v_index)) {
    if (linesAll.length < 5) throw new Error('Analyte format too short');
    const compoundIndex = Number.isFinite(def.compound_index)
      ? def.compound_index
      : (Number.isFinite(def.v_index) ? def.v_index : 0);
    const valueColIndex = 3 + compoundIndex;
    const dataStart = Number.isFinite(def.dataStartLine) ? def.dataStartLine : 4;
    for (let i = dataStart; i < linesAll.length; i++) {
      const line = linesAll[i];
      if (!line || !line.trim()) continue;
      const tok = line.split('\t').map(s => Number(s));
      if (tok.length < 4) continue;
      if (!Number.isFinite(tok[1]) || !Number.isFinite(tok[2])) continue;
      if (valueColIndex >= tok.length) continue;
      const v = tok[valueColIndex];
      if (!Number.isFinite(v)) continue;
      rows.push({ x: tok[1], y: tok[2], v });
    }
  } else {
    const lines = linesAll.filter(s => s.trim().length > 0);
    if (!lines.length) throw new Error('empty txt');
    const rawHeader = lines[0];
    const sep = rawHeader.includes('\t') ? '\t' : (rawHeader.includes(',') ? ',' : 'ws');
    const splitBy = (s) => sep === 'ws' ? s.trim().split(/\s+/) : s.split(sep);
    const header = splitBy(rawHeader).map(s => s.trim());
    const xi = def.x ? header.indexOf(def.x) : header.indexOf('x');
    const yi = def.y ? header.indexOf(def.y) : header.indexOf('y');
    const vi = def.v ? header.indexOf(def.v) : (header.length > 2 ? 2 : -1);
    if (xi < 0 || yi < 0 || vi < 0) throw new Error('column not found in txt');
    for (let i = 1; i < lines.length; i++) {
      const cols = splitBy(lines[i]);
      if (cols.length < header.length) continue;
      const x = Number(cols[xi]), y = Number(cols[yi]), v = Number(cols[vi]);
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(v)) rows.push({ x, y, v });
    }
  }
  if (!rows.length) throw new Error('no numeric rows in txt');
  return rows;
}

export function parseMsiRows(buf, def) {
  return (def && def.kind === 'txt') ? parseTxtToRows(buf, def) : parseXlsxToRows(buf, def);
}

// Extract RAW MSI values inside an ROI polygon. Mirrors the app's export path
// (appendRoisToAnalyteLines): map each raw row to its grid pixel cell via
// buildMsiGrid, then pointInPolygon on pixel coords. Returns the raw intensity
// values (NOT the 0-255 display luminance the analysis chart uses).
export function extractRoiValues(rows, polyMsi, precomputedGrid) {
  if (!polyMsi || !polyMsi.length) return [];
  const { xIndex, yIndex } = precomputedGrid || buildMsiGrid(rows);
  const out = [];
  for (const r of rows) {
    const px = xIndex.get(r.x), py = yIndex.get(r.y);
    if (px == null || py == null) continue;
    if (pointInPolygon(px, py, polyMsi)) out.push(r.v);
  }
  return out;
}

export function stats(values) {
  const n = values.length;
  if (!n) return { n: 0, mean: null, min: null, max: null, median: null, q1: null, q3: null, sd: null };
  const a = Float64Array.from(values).sort();
  const at = (p) => a[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  let sum = 0; for (const v of a) sum += v;
  const mean = sum / n;
  let varsum = 0; for (const v of a) varsum += (v - mean) * (v - mean);
  return {
    n,
    mean,
    min: a[0],
    max: a[n - 1],
    median: at(0.5),
    q1: at(0.25),
    q3: at(0.75),
    sd: Math.sqrt(varsum / n),
  };
}
