import { parquetMetadataAsync, parquetRead } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { storageObjectUrl } from './supabase.js';

// =============================================================================
// TIMS non-target (parquet) reading — READ-ONLY, column-at-a-time over HTTP Range.
//
// Ported from the viewer's parquet worker (viewer/index.html, _parquetWorkerBody)
// so the connector returns THE SAME NUMBERS the app shows. Keep the two in sync.
// That includes the LIBRARY VERSION: the viewer pins hyparquet 1.27.1 /
// hyparquet-compressors 1.1.1 from the CDN, so package.json must resolve to the
// same ones. `npm run selftest` diffs the two readers and fails if they drift.
//
// Why not just fetchStorageObject()? The published TIMS file is one 836 MB
// parquet shared by 1390 compounds × 4 sections. Downloading it whole would
// blow the connector's host out of memory, and it is never necessary: parquet is
// columnar, so one compound is ~0.3 MB of one column. Everything below exists to
// read exactly that much.
//
// Three things here are load-bearing and were each measured in the viewer:
//   1. Range requests, never a whole-object GET.
//   2. A FLAT NUMERIC index instead of hyparquet's ColumnChunk objects — the
//      real file has ~500 row groups × 1394 columns ≈ 700k chunks, which cost
//      0.7–1.4 GB as objects and ~20 MB as typed arrays.
//   3. A schema trimmed to root + the one column being read. hyparquet rebuilds
//      the whole schema tree per column chunk, so passing all 1395 elements
//      costs ~700k nodes to read a single column.
// =============================================================================

const INDEX_VERSION = 2;

// How many parquet files to keep indexed in this process. The index is ~20 MB
// for the real file, so this is a memory ceiling, not a hit-rate knob: a single
// getRoiStats call touches one file.
const MAX_CACHED_FILES = 3;

// path -> Promise<{ url, byteLength, idx, geom }>
const fileCache = new Map();

function cachePut(key, value) {
  fileCache.set(key, value);
  while (fileCache.size > MAX_CACHED_FILES) {
    const oldest = fileCache.keys().next().value;
    if (oldest === key) break;
    fileCache.delete(oldest);
  }
}

// ---- AsyncBuffer over HTTP Range --------------------------------------------
// Same shape hyparquet expects ({ byteLength, slice }); it never learns the bytes
// came off the network.
export async function asyncBufferFromUrl(url, knownLength, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  let byteLength = Number(knownLength);
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    const head = await doFetch(url, { method: 'HEAD' });
    if (!head.ok) throw new Error('parquet: HEAD ' + head.status + ' for ' + url);
    byteLength = Number(head.headers.get('content-length'));
    if (!Number.isFinite(byteLength) || byteLength <= 0) {
      throw new Error('parquet: could not determine content-length for ' + url);
    }
  }
  return {
    byteLength,
    slice: async (start, end) => {
      const last = (end === undefined ? byteLength : end) - 1;
      const resp = await doFetch(url, { headers: { Range: 'bytes=' + start + '-' + last } });
      // 206 is correct. A 200 means the server ignored Range and is streaming the
      // whole object — swallowing that would quietly pull 836 MB into memory,
      // which is exactly what this module exists to avoid.
      if (resp.status === 200) throw new Error('parquet: server does not honour Range requests (' + url + ')');
      if (!resp.ok) throw new Error('parquet: HTTP ' + resp.status + ' for ' + url);
      return resp.arrayBuffer();
    },
  };
}

// ---- Flat index --------------------------------------------------------------
// Keeps only the numbers needed to rebuild one column's metadata on demand.
// Field list verified against hyparquet 1.27.1 (plan.js, rowgroup.js, column.js).
export function buildIndex(meta) {
  const colNames = meta.row_groups.length
    ? meta.row_groups[0].columns.map((c) => c.meta_data.path_in_schema.join('.'))
    : [];
  const colIndexByName = new Map(colNames.map((n, i) => [n, i]));
  const nCol = colNames.length;
  const nRg = meta.row_groups.length;

  // Columns sit in schema order inside a row group, so the same-position name
  // almost always matches; that shortcut skips joining ~700k path arrays.
  const resolve = (cc, j) => {
    const p = cc.meta_data.path_in_schema;
    if (j < nCol && p.length === 1 && p[0] === colNames[j]) return j;
    const name = p.join('.');
    return colIndexByName.has(name) ? colIndexByName.get(name) : -1;
  };

  const counts = new Int32Array(nCol);
  for (let r = 0; r < nRg; r++) {
    const cols = meta.row_groups[r].columns;
    for (let j = 0; j < cols.length; j++) {
      const i = resolve(cols[j], j);
      if (i >= 0) counts[i]++;
    }
  }
  // CSR layout: colStart[c] .. colStart[c+1] are column c's chunks.
  const colStart = new Int32Array(nCol + 1);
  for (let c = 0; c < nCol; c++) colStart[c + 1] = colStart[c] + counts[c];
  const total = colStart[nCol];

  const rgIdx = new Int32Array(total);
  const dataOff = new Float64Array(total);
  const dictOff = new Float64Array(total);
  const compSz = new Float64Array(total);
  const codecIds = new Uint8Array(total);
  const codecList = [];
  const codecIdOf = (name) => {
    const s = name || '';
    let k = codecList.indexOf(s);
    if (k < 0) { k = codecList.length; codecList.push(s); }
    return k;
  };
  const rgRows = new Float64Array(nRg);
  const colPaths = new Array(nCol);
  const colChunkTypes = new Array(nCol);
  // Footer statistics are aggregated here and then dropped — readColumn passes
  // no filter, so hyparquet never looks at them (filter.js:122).
  const stMin = new Float64Array(nCol).fill(Infinity);
  const stMax = new Float64Array(nCol).fill(-Infinity);
  const stNulls = new Float64Array(nCol);
  const stAny = new Uint8Array(nCol);
  const fill = new Int32Array(nCol);

  for (let r = 0; r < nRg; r++) {
    const rg = meta.row_groups[r];
    rgRows[r] = Number(rg.num_rows);
    const cols = rg.columns;
    for (let j = 0; j < cols.length; j++) {
      const cc = cols[j];
      const i = resolve(cc, j);
      if (i < 0) continue;
      const md = cc.meta_data;
      const at = colStart[i] + fill[i]++;
      rgIdx[at] = r;
      dataOff[at] = Number(md.data_page_offset);
      dictOff[at] = md.dictionary_page_offset ? Number(md.dictionary_page_offset) : 0;
      compSz[at] = Number(md.total_compressed_size);
      codecIds[at] = codecIdOf(md.codec);
      if (colPaths[i] === undefined) {
        colPaths[i] = md.path_in_schema.slice();
        colChunkTypes[i] = md.type || null;
      }
      const s = md.statistics;
      if (s) {
        const lo = Number(s.min_value !== undefined ? s.min_value : s.min);
        const hi = Number(s.max_value !== undefined ? s.max_value : s.max);
        if (Number.isFinite(lo)) { if (lo < stMin[i]) stMin[i] = lo; stAny[i] = 1; }
        if (Number.isFinite(hi)) { if (hi > stMax[i]) stMax[i] = hi; stAny[i] = 1; }
        if (s.null_count !== undefined && s.null_count !== null) stNulls[i] += Number(s.null_count);
      }
    }
  }
  const stats = new Array(nCol);
  for (let c = 0; c < nCol; c++) {
    stats[c] = stAny[c] ? { min: stMin[c], max: stMax[c], nulls: stNulls[c] } : null;
  }
  // Physical type per column. The spec says m/z columns default to float32 "but
  // DOUBLE depending on settings", so never hard-code the width — read it here.
  const typeByName = new Map();
  for (const el of (meta.schema || [])) if (el && el.name && el.type) typeByName.set(el.name, el.type);
  const colTypes = colNames.map((n, i) => typeByName.get(n) || colChunkTypes[i] || null);

  return {
    v: INDEX_VERSION,
    schema: meta.schema, version: meta.version, created_by: meta.created_by,
    metadata_length: meta.metadata_length, numRows: meta.num_rows,
    colNames, colTypes, colPaths, colChunkTypes,
    colStart, rgIdx, dataOff, dictOff, compSz, codecIds, codecList, rgRows,
    stats,
  };
}

// FLOAT stays 32-bit (exact round-trip), everything numeric else goes to 64-bit
// so nothing is rounded, and BYTE_ARRAY (annotation) stays as-is — coercing
// strings to numbers would turn the whole column into NaN.
function modeForType(t) {
  if (t === 'BYTE_ARRAY' || t === 'FIXED_LEN_BYTE_ARRAY') return 'raw';
  if (t === 'FLOAT') return 'f32';
  return 'f64';
}

// hyparquet's getSchemaPath (schema.js:34) rebuilds the whole schema tree every
// call, and rowgroup.js:26 calls it once per column chunk. schemaTree counts
// children from the root's num_children, so a root with num_children:1 plus the
// one leaf produces the identical tree — ~700k nodes down to ~1000.
function schemaForColumn(idx, colIdx, path) {
  if (!idx._schemaCache) idx._schemaCache = new Map();
  const hit = idx._schemaCache.get(colIdx);
  if (hit) return hit;
  const full = idx.schema || [];
  const leafName = path[path.length - 1];
  const root = full[0];
  let leaf = null;
  for (let i = 1; i < full.length; i++) {
    const el = full[i];
    if (el && el.name === leafName && el.type) { leaf = el; break; }
  }
  // Nested columns keep the full schema: correct, just not trimmed.
  const trimmed = (root && leaf && path.length === 1)
    ? [Object.assign({}, root, { num_children: 1 }), leaf]
    : full;
  idx._schemaCache.set(colIdx, trimmed);
  return trimmed;
}

// One column's FileMetaData, rebuilt from the flat table at read time. Offsets go
// back to BigInt because plan.js:93 adds them to total_compressed_size.
function minimalMeta(idx, colIdx) {
  const from = idx.colStart[colIdx], to = idx.colStart[colIdx + 1];
  const path = idx.colPaths[colIdx] || [idx.colNames[colIdx]];
  const type = idx.colChunkTypes[colIdx] || idx.colTypes[colIdx];
  const row_groups = new Array(to - from);
  for (let k = from; k < to; k++) {
    const dict = idx.dictOff[k];
    row_groups[k - from] = {
      // Row counts come via rgIdx, not chunk order: a row group missing this
      // column would otherwise shift every subsequent count by one.
      num_rows: idx.rgRows[idx.rgIdx[k]],
      total_byte_size: 0n,
      columns: [{
        // file_path must stay falsy (plan.js:88 throws on external chunks).
        meta_data: {
          path_in_schema: path,
          type,
          codec: idx.codecList[idx.codecIds[k]],
          data_page_offset: BigInt(idx.dataOff[k]),
          dictionary_page_offset: dict ? BigInt(dict) : undefined,
          total_compressed_size: BigInt(idx.compSz[k]),
        },
      }],
    };
  }
  return {
    version: idx.version, schema: schemaForColumn(idx, colIdx, path),
    num_rows: idx.numRows,
    created_by: idx.created_by, metadata_length: idx.metadata_length,
    row_groups,
  };
}

// onChunk, not onComplete: onComplete makes hyparquet build a row array (one
// single-element array per row), which for one column of 100k rows is 200k
// throwaway objects and a transpose. onChunk hands over the column chunk itself.
export async function readColumn(file, idx, colIdx, mode) {
  if (!mode) mode = modeForType(idx.colTypes && idx.colTypes[colIdx]);
  const name = idx.colNames[colIdx];
  const n = Number(idx.numRows) || 0;
  let out = (mode === 'raw') ? new Array(n)
    : (mode === 'f64') ? new Float64Array(n) : new Float32Array(n);
  if (mode !== 'raw') out.fill(NaN);
  let seen = 0;
  await parquetRead({
    file, metadata: minimalMeta(idx, colIdx), columns: [name], compressors,
    onChunk: ({ columnData, rowStart }) => {
      const len = columnData.length;
      if (rowStart + len > seen) seen = rowStart + len;
      if (mode === 'raw') {
        for (let i = 0; i < len; i++) out[rowStart + i] = columnData[i];
        return;
      }
      for (let i = 0; i < len; i++) {
        const v = columnData[i];
        out[rowStart + i] = (v === null || v === undefined) ? NaN : Number(v);
      }
    },
  });
  // Files whose num_rows disagrees with the chunks still return the length that
  // was actually filled — callers use it as the row count.
  if (seen !== n) out = (mode === 'raw') ? out.slice(0, seen) : out.subarray(0, seen);
  return out;
}

// Column roles. The spec fixes the order as id, x, y, <m/z...>, annotation, but
// the m/z set is taken as the complement rather than by position so a file with
// no id column, or extra columns, still works. Mirrors parquetColumnRoles in the
// viewer.
export function parquetColumnRoles(colNames) {
  const idIdx = colNames.indexOf('id');
  const xIdx = colNames.indexOf('x');
  const yIdx = colNames.indexOf('y');
  const annIdx = colNames.indexOf('annotation');
  const skip = new Set([idIdx, xIdx, yIdx, annIdx].filter((i) => i >= 0));
  const mzIdxs = [];
  for (let i = 0; i < colNames.length; i++) if (!skip.has(i)) mzIdxs.push(i);
  return { idIdx, xIdx, yIdx, annIdx, mzIdxs };
}

// Open (index) a parquet file once per process. `opts.file` lets selftest.js
// hand in a local AsyncBuffer instead of a URL.
export async function openParquet(key, opts) {
  const hit = fileCache.get(key);
  if (hit) return hit;
  const p = (async () => {
    const file = (opts && opts.file) || await asyncBufferFromUrl(
      (opts && opts.url) || key, opts && opts.byteLength, opts && opts.fetchImpl);
    const meta = await parquetMetadataAsync(file);
    const idx = buildIndex(meta);
    return { file, idx, geom: null };
  })();
  cachePut(key, p);
  p.catch(() => { if (fileCache.get(key) === p) fileCache.delete(key); });
  return p;
}

// x / y / annotation, read once per file and reused by every compound in it.
// Without this, 1390 compounds would each re-read three full columns.
async function ensureGeometry(st) {
  if (st.geom) return st.geom;
  if (st._geomLoading) return st._geomLoading;
  st._geomLoading = (async () => {
    const roles = parquetColumnRoles(st.idx.colNames);
    if (roles.xIdx < 0 || roles.yIdx < 0) throw new Error('parquet: no x/y columns');
    const xs = await readColumn(st.file, st.idx, roles.xIdx);
    const ys = await readColumn(st.file, st.idx, roles.yIdx);
    const ann = roles.annIdx >= 0 ? await readColumn(st.file, st.idx, roles.annIdx, 'raw') : null;
    // Row indices per section label, so a compound read only has to gather.
    const byLabel = new Map();
    const n = xs.length;
    for (let i = 0; i < n; i++) {
      const label = ann ? String(ann[i]) : '(all)';
      let rows = byLabel.get(label);
      if (!rows) { rows = []; byLabel.set(label, rows); }
      rows.push(i);
    }
    st.geom = { roles, xs, ys, byLabel };
    return st.geom;
  })();
  try { return await st._geomLoading; }
  finally { st._geomLoading = null; }
}

// def (one published compound) → [{x, y, v}] for its section only.
// Returning the same row shape as xlsx/txt is what keeps buildMsiGrid /
// extractRoiValues — and therefore the reported statistics — identical to the
// app's, which is the promise the connector's README makes.
export async function parquetRowsForDef(def, cache) {
  const path = def && def.path;
  if (!path) throw new Error('this compound has no storage path on the server (not published?)');
  const colIdx = Number(def.colIdx);
  if (!Number.isInteger(colIdx) || colIdx < 0) {
    throw new Error('parquet compound has no colIdx: ' + JSON.stringify(def.compoundMeta || {}));
  }
  const st = await openParquet(path, {
    url: storageObjectUrl(path),
    fetchImpl: cache && cache.fetchImpl,
  });
  if (colIdx >= st.idx.colNames.length) {
    throw new Error('parquet: colIdx ' + colIdx + ' is out of range (' + st.idx.colNames.length + ' columns)');
  }
  const geom = await ensureGeometry(st);
  // A file with no annotation column is a single section; otherwise the label
  // must match, or we would silently return another section's pixels.
  let rowIdx = null;
  if (geom.roles.annIdx < 0) {
    rowIdx = geom.byLabel.get('(all)');
  } else if (def.annotation != null && geom.byLabel.has(String(def.annotation))) {
    rowIdx = geom.byLabel.get(String(def.annotation));
  } else if (geom.byLabel.size === 1) {
    rowIdx = geom.byLabel.values().next().value;
  }
  if (!rowIdx) {
    throw new Error("parquet: section '" + def.annotation + "' not found (have: " +
      [...geom.byLabel.keys()].join(', ') + ')');
  }
  const col = await readColumn(st.file, st.idx, colIdx);
  const rows = [];
  for (let k = 0; k < rowIdx.length; k++) {
    const i = rowIdx[k];
    const x = geom.xs[i], y = geom.ys[i], v = col[i];
    // Same finite-only filter the xlsx/txt parsers apply, so NaN cells (outside
    // the scan) drop out instead of poisoning the statistics.
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(v)) rows.push({ x, y, v });
  }
  if (!rows.length) throw new Error('parquet: no numeric rows for this compound/section');
  return rows;
}

// Exposed for tests / diagnostics.
export function _clearParquetCache() { fileCache.clear(); }
