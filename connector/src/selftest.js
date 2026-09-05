// Offline self-consistency test (no network). Verifies the ported parsing /
// grid / ROI-extraction / stats produce the expected numbers, so we can trust
// they match the web app. Run: `npm run selftest`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { deflateRawSync } from 'node:zlib';
import * as XLSX from 'xlsx';
import {
  a1ColToIndex, pointInPolygon, buildMsiGrid,
  parseXlsxToRows, parseTxtToRows, extractRoiValues, stats,
} from './msi.js';
import { buildExp } from './exp.js';
import { newRowCache, loadRowsForDef, parseCacheKey } from './rows.js';
import { narrowCompoundCandidates } from './tools.js';

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS', name); }
  else { failures++; console.log('  FAIL', name, detail != null ? ('-> ' + JSON.stringify(detail)) : ''); }
}
const approx = (a, b) => Math.abs(a - b) < 1e-9;

console.log('a1ColToIndex / pointInPolygon');
check('A->0', a1ColToIndex('A') === 0);
check('C->2', a1ColToIndex('C') === 2);
check('AA->26', a1ColToIndex('AA') === 26);
const box = [[-0.5, -0.5], [1.5, -0.5], [1.5, 1.5], [-0.5, 1.5]];
check('inside', pointInPolygon(0, 0, box) === true);
check('outside', pointInPolygon(5, 5, box) === false);

console.log('buildMsiGrid');
const rows0 = [{ x: 0, y: 0, v: 10 }, { x: 1, y: 0, v: 20 }, { x: 0, y: 1, v: 30 }, { x: 1, y: 1, v: 40 }];
const g = buildMsiGrid(rows0);
check('W=2', g.W === 2, g.W);
check('H=2', g.H === 2, g.H);
check('xIndex(1)=1', g.xIndex.get(1) === 1);

console.log('parseXlsxToRows (synthetic workbook)');
const aoa = [['Image_X', 'Image_Y', 'val'], [0, 0, 10], [1, 0, 20], [0, 1, 30], [1, 1, 40]];
const ws = XLSX.utils.aoa_to_sheet(aoa);
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, 'MSI_Data');
const xbuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
const xdef = { sheet: 'MSI_Data', data_start_row: 2, col_x: 'A', col_y: 'B', col_v: 'C' };
const xrows = parseXlsxToRows(xbuf, xdef);
check('xlsx 4 rows', xrows.length === 4, xrows.length);
check('xlsx row0', xrows[0].x === 0 && xrows[0].y === 0 && xrows[0].v === 10, xrows[0]);
check('xlsx row3', xrows[3].x === 1 && xrows[3].y === 1 && xrows[3].v === 40, xrows[3]);

console.log('extractRoiValues + stats (whole-grid ROI)');
const allVals = extractRoiValues(xrows, box);
check('ROI has 4 values', allVals.length === 4, allVals);
const sAll = stats(allVals);
check('mean=25', approx(sAll.mean, 25), sAll.mean);
check('min=10', sAll.min === 10);
check('max=40', sAll.max === 40);
check('n=4', sAll.n === 4);

console.log('extractRoiValues (left column only)');
const leftBox = [[-0.5, -0.5], [0.5, -0.5], [0.5, 1.5], [-0.5, 1.5]]; // px=0 only
const leftVals = extractRoiValues(xrows, leftBox).sort((a, b) => a - b);
check('left col = [10,30]', JSON.stringify(leftVals) === JSON.stringify([10, 30]), leftVals);
const sLeft = stats(leftVals);
check('left mean=20', approx(sLeft.mean, 20), sLeft.mean);

console.log('parseTxtToRows (generic TSV)');
const txt = 'x\ty\tv\n0\t0\t10\n1\t0\t20\n0\t1\t30\n';
const tbuf = new TextEncoder().encode(txt).buffer;
const trows = parseTxtToRows(tbuf, {});
check('txt 3 rows', trows.length === 3, trows.length);
check('txt row2', trows[2].x === 0 && trows[2].y === 1 && trows[2].v === 30, trows[2]);

console.log('.exp buildExp parity (connector exp.js vs mrm.html)');
{
  // Extract the app's buildExp (+ helpers) live from mrm.html and diff its
  // output against the connector's ported copy — byte-for-byte. Guards drift:
  // if either buildExp changes, this fails until they are re-synced.
  const html = readFileSync(fileURLToPath(new URL('../../mrm.html', import.meta.url)), 'utf8');
  const s = html.indexOf('function _expKey(line)');
  const e = html.indexOf('// Shared .exp build + download');
  check('locate app buildExp in mrm.html', s >= 0 && e > s, { s, e });
  if (s >= 0 && e > s) {
    const appBuildExp = new Function(html.slice(s, e) + '\n return buildExp;')();
    const tmpl = [
      'NumSIRMasses,1', 'SIRMass1,100.0', 'SIRMass_2_1,50.0', 'SIRAutoDwell1,0', 'SIRDwellTime1,0.0100',
      'SIRDelay1,0.0037', 'UseAsLockMass1,0', 'UseSampleList1,0', 'UseSampleList_21,0',
      'NoOfChannels,1', 'UseSLMassesP_1,0', 'UseSLMassesD_1,0', 'Mass(amu)_1,100.0', 'Mass2(amu)_1,50.0',
      'AutoDwell_1,0', 'Dwell(s)_1,0.0100', 'ConeVoltage(V)_1,30', 'CollisionEnergy(eV)_1,15', '',
      'CompoundName_1,Old', '', 'CompoundFormula_1,', 'CompoundComment_1,', 'FunctionScanTime(sec),0.1960', '',
    ].join('\n');
    const rows = [
      { name: 'Glucose', precursor: 179, product: 89, ce: 12, cv: 20 },
      { name: 'Succinate', precursor: 117, product: 73, ce: 10, cv: 25 },
    ];
    check('LF parity', appBuildExp(tmpl, rows) === buildExp(tmpl, rows));
    const crlf = tmpl.replace(/\n/g, '\r\n');
    check('CRLF parity', appBuildExp(crlf, rows) === buildExp(crlf, rows));
    const edge = [{ name: '', precursor: 100, product: 50, ce: null, cv: null }];
    check('edge parity (null CE/CV, empty name)', appBuildExp(tmpl, edge) === buildExp(tmpl, edge));
  }
}

// =============================================================================
// ★ Multi-compound-per-file mix-up (the bug rows.js exists to fix)
//
// One Analyte txt holds several compounds (columns 3, 4, 5...). getRoiStats used
// to cache parsed rows by `def.path` alone, so the 2nd and 3rd compound silently
// got the 1st one's numbers. The old implementation is reproduced verbatim below
// and asserted to be WRONG, so this test can never pass vacuously.
// =============================================================================
console.log('multi-compound-per-file (rows.js cache)');
{
  // 3 compounds in one file: value columns are tok[3], tok[4], tok[5].
  const analyte = [
    'Analyte (converted from imzML)',
    'meta', 'meta', 'header',
    // id, x, y, compA, compB, compC
    '1\t0\t0\t10\t100\t1000',
    '2\t1\t0\t20\t200\t2000',
    '3\t0\t1\t30\t300\t3000',
    '4\t1\t1\t40\t400\t4000',
  ].join('\n');
  const abuf = new TextEncoder().encode(analyte).buffer;
  const defs = [0, 1, 2].map((i) => ({
    path: 'proj/blobs/blob_shared.txt', kind: 'txt', compound_index: i, dataStartLine: 4,
  }));

  // --- the OLD implementation, kept as a tripwire -----------------------------
  const oldParseRowsForDef = async (def, cache) => {
    const path = def.path;
    if (cache.has(path)) return cache.get(path);
    const rows = parseTxtToRows(abuf, def);
    cache.set(path, rows);
    return rows;
  };
  const oldCache = new Map();
  const oldMeans = [];
  for (const d of defs) oldMeans.push(stats((await oldParseRowsForDef(d, oldCache)).map((r) => r.v)).mean);
  check('OLD code really did mix them up (tripwire)',
    oldMeans[0] === oldMeans[1] && oldMeans[1] === oldMeans[2], oldMeans);

  // --- the NEW implementation -------------------------------------------------
  let fetched = 0;
  const cache = newRowCache({ fetchBytes: async () => { fetched++; return abuf; } });
  const newMeans = [];
  for (const d of defs) newMeans.push(stats((await loadRowsForDef(d, cache)).map((r) => r.v)).mean);
  check('compound 0 mean = 25', approx(newMeans[0], 25), newMeans[0]);
  check('compound 1 mean = 250', approx(newMeans[1], 250), newMeans[1]);
  check('compound 2 mean = 2500', approx(newMeans[2], 2500), newMeans[2]);
  check('★ all three differ (mix-up fixed)',
    new Set(newMeans).size === 3, newMeans);

  // Speed half of the fix: the byte cache still collapses to one download.
  check('★ downloaded the shared file exactly once', fetched === 1, fetched);
  check('fetchCount agrees', cache.fetchCount === 1, cache.fetchCount);

  // Re-asking must not re-parse (parsed rows are cached per compound).
  const again = await loadRowsForDef(defs[1], cache);
  check('second ask for the same compound is the cached array',
    again === (await loadRowsForDef(defs[1], cache)));
  check('still only one download', fetched === 1, fetched);

  // A def with no path fails loudly rather than returning someone else's rows.
  let noPathErr = null;
  try { await loadRowsForDef({ kind: 'txt' }, cache); } catch (e) { noPathErr = e; }
  check('missing path throws', !!noPathErr && /storage path/.test(String(noPathErr.message)));

  // ★ Both tiers are bounded. The old code let the downloaded buffer go to
  // garbage right after parsing; an unbounded byte cache would pin one whole
  // file per path for the length of the call (get_roi_stats visits up to 25).
  const many = newRowCache({ fetchBytes: async () => abuf });
  for (let f = 0; f < 12; f++) {
    for (let ci = 0; ci < 3; ci++) {
      await loadRowsForDef({ path: 'proj/blobs/file_' + f + '.txt', kind: 'txt', compound_index: ci, dataStartLine: 4 }, many);
    }
  }
  check('★ byte cache stays bounded (36 reads across 12 files)', many.bytes.size <= 2, many.bytes.size);
  check('★ row cache stays bounded', many.rows.size <= 4, many.rows.size);
  check('a file is still downloaded once while it is being read',
    many.fetchCount === 12, many.fetchCount);
  // Values must stay correct across evictions — a miss re-reads, never mixes up.
  const reread = stats((await loadRowsForDef(
    { path: 'proj/blobs/file_0.txt', kind: 'txt', compound_index: 2, dataStartLine: 4 }, many)).map((r) => r.v));
  check('★ evicted entries re-read to the SAME value', approx(reread.mean, 2500), reread.mean);
}

// get_matrix's `compound` is a substring match, so "PC" can hit hundreds of
// non-target layers. Picking candidates[0] would be the same silent-wrong-answer
// shape rows.js fixes.
console.log('narrowCompoundCandidates (get_matrix disambiguation)');
{
  const c = (k, name, sec) => ({ k, name, s: { name: sec || 'S1' } });
  const many = [c('MSI_PC_34_1', 'PC(34:1)'), c('MSI_PC_36_2', 'PC(36:2)'), c('MSI_PCX', 'PC(38:4)')];
  check('one candidate passes through', narrowCompoundCandidates([many[0]], 'PC').length === 1);
  check('★ a substring hitting several stays ambiguous',
    narrowCompoundCandidates(many, 'PC').length === 3);
  check('★ an exact name wins over the substring',
    narrowCompoundCandidates(many, 'PC(34:1)').length === 1 &&
    narrowCompoundCandidates(many, 'PC(34:1)')[0].k === 'MSI_PC_34_1');
  check('an exact key also wins',
    narrowCompoundCandidates(many, 'MSI_PC_36_2').length === 1 &&
    narrowCompoundCandidates(many, 'MSI_PC_36_2')[0].k === 'MSI_PC_36_2');
  check('normalisation absorbs case and separators',
    narrowCompoundCandidates(many, 'pc 34 1').length === 1);
  // The same compound on 4 sections must NOT be silently resolved to section 1.
  const acrossSections = ['01', '02', '03', '04'].map((s) => c('MSI_PC_34_1', 'PC(34:1)', s));
  check('★ the same compound on 4 sections stays ambiguous (pick a section)',
    narrowCompoundCandidates(acrossSections, 'PC(34:1)').length === 4);
  check('distinct compounds are never merged',
    narrowCompoundCandidates(many, 'PC(99:9)').length === 3);
}

console.log('parseCacheKey');
{
  const a = { path: 'p', kind: 'txt', compound_index: 0, compoundMeta: { name: 'A', mz: 1 } };
  const b = { compoundMeta: { mz: 1, name: 'A' }, compound_index: 0, kind: 'txt', path: 'p' };
  check('key is order-independent', parseCacheKey(a) === parseCacheKey(b));
  check('key separates compounds of one file',
    parseCacheKey({ path: 'p', compound_index: 0 }) !== parseCacheKey({ path: 'p', compound_index: 1 }));
  check('key separates parquet columns',
    parseCacheKey({ path: 'p', kind: 'parquet', colIdx: 3 }) !==
    parseCacheKey({ path: 'p', kind: 'parquet', colIdx: 4 }));
  check('key separates parquet sections (same column, different annotation)',
    parseCacheKey({ path: 'p', kind: 'parquet', colIdx: 3, annotation: '01' }) !==
    parseCacheKey({ path: 'p', kind: 'parquet', colIdx: 3, annotation: '02' }));
  check('key separates xlsx column refs',
    parseCacheKey({ path: 'p', col_v: 'C' }) !== parseCacheKey({ path: 'p', col_v: 'D' }));
  check('nested arrays are keyed',
    parseCacheKey({ path: 'p', rawRange: [0, 1] }) !== parseCacheKey({ path: 'p', rawRange: [0, 2] }));
}

// =============================================================================
// ★ TIMS non-target (parquet)
//
// Same idea as the .exp parity check above: pull the APP's parquet reader live
// out of viewer/index.html, run it against a synthetic file, and diff it against
// the connector's port. If either side drifts, this fails until they are
// re-synced — which matters more here than anywhere else, because a silent
// mismatch would mean the AI quotes numbers the app never showed.
//
// It also asserts the connector reads over HTTP Range and never pulls the whole
// object: the real published file is 836 MB.
// =============================================================================
console.log('parquet (TIMS non-target) — connector vs app');
{
  let writerMod = null;
  try { writerMod = await import('hyparquet-writer'); }
  catch (e) { console.log('  SKIP  hyparquet-writer not installed (devDependency)'); }

  if (writerMod) {
    // Shaped like the published data, just smaller: two sections of 40×50 pixels
    // in one file, many m/z columns, several row groups. It has to be big enough
    // that "we only read one column" is a real claim and not an artefact of a
    // file smaller than its own footer.
    const SEC_W = 40, SEC_H = 50, PER_SEC = SEC_W * SEC_H;
    const N_ROWS = PER_SEC * 2, N_MZ = 40, ROW_GROUP = 500;
    const columnData = [
      { name: 'id', data: Array.from({ length: N_ROWS }, (_, i) => i), type: 'INT32' },
      { name: 'x', data: Array.from({ length: N_ROWS }, (_, i) => (i % PER_SEC) % SEC_W), type: 'FLOAT' },
      { name: 'y', data: Array.from({ length: N_ROWS }, (_, i) => Math.floor((i % PER_SEC) / SEC_W)), type: 'FLOAT' },
    ];
    for (let c = 0; c < N_MZ; c++) {
      columnData.push({
        name: 'mz_' + c,
        // nulls exercise the NaN path; DOUBLE/FLOAT mix exercises type detection
        data: Array.from({ length: N_ROWS }, (_, i) => ((i + c) % 31 === 0 ? null : (c * 1000 + i + 0.5))),
        type: (c % 3 === 0) ? 'DOUBLE' : 'FLOAT',
      });
    }
    // Two sections in one file, exactly like the published TIMS data.
    columnData.push({
      name: 'annotation',
      data: Array.from({ length: N_ROWS }, (_, i) => (i < PER_SEC ? '01' : '02')),
      type: 'STRING',
    });
    const buf = writerMod.parquetWriteBuffer({ columnData, rowGroupSize: ROW_GROUP, compressed: true });

    // --- a Storage stand-in that only honours Range ---------------------------
    let rangeRequests = 0, rangeBytes = 0, wholeGets = 0, heads = 0;
    const fakeFetch = async (url, init) => {
      if (init && init.method === 'HEAD') {
        heads++;
        return { ok: true, status: 200, headers: { get: (h) => (/length/i.test(h) ? String(buf.byteLength) : null) } };
      }
      const range = init && init.headers && init.headers.Range;
      if (!range) { wholeGets++; throw new Error('selftest: connector issued a non-Range GET'); }
      const m = /^bytes=(\d+)-(\d+)$/.exec(range);
      const start = Number(m[1]), end = Number(m[2]) + 1;
      rangeRequests++; rangeBytes += (end - start);
      const slice = buf.slice(start, end);
      return {
        ok: true, status: 206,
        headers: { get: () => String(buf.byteLength) },
        arrayBuffer: async () => slice,
      };
    };

    const { openParquet, _clearParquetCache, parquetColumnRoles } = await import('./parquet.js');
    _clearParquetCache();

    // colIdx is an index into ALL columns (id, x, y, mz_0.., annotation) — the
    // same numbering the app's registration wizard writes into the project doc.
    const colNames = ['id', 'x', 'y', ...Array.from({ length: N_MZ }, (_, c) => 'mz_' + c), 'annotation'];
    const roles = parquetColumnRoles(colNames);
    check('roles: x/y/annotation found', roles.xIdx === 1 && roles.yIdx === 2 && roles.annIdx === N_MZ + 3,
      JSON.stringify({ x: roles.xIdx, y: roles.yIdx, ann: roles.annIdx }));
    check('roles: m/z columns are the complement', roles.mzIdxs.length === N_MZ, roles.mzIdxs.length);

    const defFor = (colIdx, annotation) => ({
      path: 'proj/blobs/blob_tims.parquet', kind: 'parquet', colIdx, annotation,
      filename: 'data.parquet',
    });

    // Index the file first so the footer probe and the column reads can be told
    // apart. hyparquet probes a fixed 512 KB tail for the footer — a constant,
    // whatever the file's size; on the real 836 MB file it is 0.06%.
    const cache = newRowCache({ fetchImpl: fakeFetch });
    const PROBE = 512 * 1024;
    await openParquet('proj/blobs/blob_tims.parquet', { url: 'x', fetchImpl: fakeFetch });
    const footerBytes = rangeBytes;
    check('★ indexing reads only the footer probe, not the file',
      footerBytes <= PROBE + 4096, footerBytes + ' bytes');

    const rowsA1 = await loadRowsForDef(defFor(3, '01'), cache);      // mz_0, section 01
    const firstCompoundBytes = rangeBytes - footerBytes;
    check('parquet rows returned', rowsA1.length > 0, rowsA1.length);
    check('whole-object GET never issued', wholeGets === 0, wholeGets);
    check('length learned from one HEAD', heads === 1, heads);
    check('★ read over Range only', rangeRequests > 0, rangeRequests);
    // x + y + annotation + one m/z, out of 44 columns. The published file is
    // 836 MB; this is the property that makes it readable at all.
    check('★ a compound costs four columns, not the file',
      firstCompoundBytes < buf.byteLength / 4,
      firstCompoundBytes + ' / ' + buf.byteLength + ' bytes');

    // --- the APP's reader, pulled live out of viewer/index.html ---------------
    const viewerSrc = readFileSync(fileURLToPath(new URL('../../viewer/index.html', import.meta.url)), 'utf8');
    const START = 'function _parquetWorkerBody(self, lib) {';
    const END = '\n}\n\nfunction _buildParquetWorkerSource';
    const a = viewerSrc.indexOf(START);
    const b = a >= 0 ? viewerSrc.indexOf(END, a + START.length) : -1;
    check('locate the app parquet worker in viewer/index.html', a >= 0 && b > a, { a, b });
    let appRows = null;
    if (a >= 0 && b > a) {
      const body = viewerSrc.slice(a, b) + '\n}';
      const ctx = vm.createContext({
        console, Promise, Object, Map, Set, Array, Number, String, Math, JSON, Error, BigInt,
        Float32Array, Float64Array, Int32Array, Uint8Array, isNaN, parseFloat, Infinity, NaN,
      });
      ctx.globalThis = ctx;
      new vm.Script(body + '\nglobalThis.__body = _parquetWorkerBody;').runInContext(ctx);
      const posted = [];
      const fakeSelf = { onmessage: null, postMessage: (m) => posted.push(m) };
      const hy = await import('hyparquet');
      const { compressors } = await import('hyparquet-compressors');
      ctx.__body(fakeSelf, {
        parquetMetadataAsync: hy.parquetMetadataAsync, parquetRead: hy.parquetRead, compressors,
      });
      // The app opens from a Blob; give it the same bytes so the only thing under
      // test is the reading logic, not the transport.
      const blobLike = {
        size: buf.byteLength,
        slice: (s, e) => ({ arrayBuffer: async () => buf.slice(s, e === undefined ? buf.byteLength : e) }),
      };
      let seq = 0;
      const callApp = async (msg) => {
        const id = ++seq;
        const before = posted.length;
        await fakeSelf.onmessage({ data: Object.assign({ id }, msg) });
        const out = posted.slice(before).find((m) => m.id === id);
        if (!out.ok) throw new Error('app worker: ' + out.error);
        return out.result;
      };
      const opened = await callApp({ op: 'open', fileId: 'f1', blob: blobLike });
      check('app and connector see the same columns',
        JSON.stringify(opened.colNames) === JSON.stringify(colNames), JSON.stringify(opened.colNames));
      const [ax, ay, aann, av] = await callApp({
        op: 'columns', fileId: 'f1', blob: blobLike,
        colIdxs: [roles.xIdx, roles.yIdx, roles.annIdx, 3],
      });
      appRows = [];
      for (let i = 0; i < ax.length; i++) {
        if (String(aann[i]) !== '01') continue;
        if (Number.isFinite(ax[i]) && Number.isFinite(ay[i]) && Number.isFinite(av[i])) {
          appRows.push({ x: ax[i], y: ay[i], v: av[i] });
        }
      }
    }
    if (appRows) {
      check('★ row count matches the app', rowsA1.length === appRows.length,
        rowsA1.length + ' vs ' + appRows.length);
      let firstBad = -1;
      for (let i = 0; i < Math.min(rowsA1.length, appRows.length); i++) {
        const c = rowsA1[i], d = appRows[i];
        if (c.x !== d.x || c.y !== d.y || c.v !== d.v) { firstBad = i; break; }
      }
      check('★ every {x,y,v} matches the app bit for bit', firstBad < 0,
        firstBad >= 0 ? ('row ' + firstBad + ': ' + JSON.stringify([rowsA1[firstBad], appRows[firstBad]])) : '');
      // The statistics the AI actually receives must match too.
      const roiAll = [[-1, -1], [999, -1], [999, 999], [-1, 999]];
      const sc = stats(extractRoiValues(rowsA1, roiAll));
      const sa = stats(extractRoiValues(appRows, roiAll));
      check('★ ROI statistics match the app',
        sc.n === sa.n && sc.mean === sa.mean && sc.min === sa.min && sc.max === sa.max && sc.sd === sa.sd,
        JSON.stringify({ connector: sc, app: sa }));
    }

    // --- section filtering ----------------------------------------------------
    const rowsA2 = await loadRowsForDef(defFor(3, '02'), cache);
    check('section 02 is a different set of rows',
      rowsA2.length > 0 && stats(rowsA2.map((r) => r.v)).mean !== stats(rowsA1.map((r) => r.v)).mean,
      JSON.stringify({ n1: rowsA1.length, n2: rowsA2.length }));
    check('the two sections partition the file',
      rowsA1.length + rowsA2.length <= N_ROWS, rowsA1.length + rowsA2.length);

    let badSection = null;
    try { await loadRowsForDef(defFor(3, 'no-such-section'), cache); } catch (e) { badSection = e; }
    check('unknown section throws instead of returning another one',
      !!badSection && /not found/.test(String(badSection.message)),
      badSection ? String(badSection.message) : 'did not throw');

    // --- different compounds in one file give different numbers ---------------
    const means = [];
    for (const ci of [3, 4, 5]) {
      means.push(stats((await loadRowsForDef(defFor(ci, '01'), cache)).map((r) => r.v)).mean);
    }
    check('★ three parquet compounds give three different means', new Set(means).size === 3, means);

    // --- geometry is read once, not once per compound -------------------------
    // Without the per-file geometry cache, every one of 1390 compounds would
    // re-read x / y / annotation in full.
    const beforeBytes = rangeBytes;
    await loadRowsForDef(defFor(6, '01'), cache);
    const forOneMore = rangeBytes - beforeBytes;
    check('★ a further compound costs roughly one column, not four',
      forOneMore > 0 && forOneMore < buf.byteLength / 10,
      forOneMore + ' / ' + buf.byteLength + ' bytes');

    let badCol = null;
    try { await loadRowsForDef(defFor(9999, '01'), cache); } catch (e) { badCol = e; }
    check('out-of-range colIdx throws', !!badCol && /out of range/.test(String(badCol.message)),
      badCol ? String(badCol.message) : 'did not throw');

    // A server that ignores Range must be an error, not an 836 MB download.
    _clearParquetCache();
    let rangeIgnored = null;
    const ignoringFetch = async () => ({
      ok: true, status: 200, headers: { get: () => String(buf.byteLength) },
      arrayBuffer: async () => buf,
    });
    try {
      await loadRowsForDef(defFor(3, '01'), newRowCache({ fetchImpl: ignoringFetch }));
    } catch (e) { rangeIgnored = e; }
    check('★ a server that ignores Range is rejected, not silently downloaded',
      !!rangeIgnored && /Range/.test(String(rangeIgnored.message)),
      rangeIgnored ? String(rangeIgnored.message) : 'did not throw');
    _clearParquetCache();
  }
}

// =============================================================================
// Waters .raw — connector vs app
//
// A .raw is built here byte by byte, which doubles as executable documentation
// of the binary layout. Its channel table carries the SAME values as a real
// Xevo TQ Absolute acquisition, so an endianness or field-offset regression
// fails on the first run instead of producing plausible-but-wrong ion images.
//
// It then extracts the app's parser live from viewer/index.html (between the
// "waters-raw parser" sentinels) and diffs this module's output against it.
// The only permitted divergence is rawInflate (DecompressionStream vs zlib).
// =============================================================================
console.log('Waters .raw — connector vs app');
{
  // The real acquisition's 8 MRM channels, verbatim.
  const FX = {
    names: ['POS-NTs-GABA', 'POS-NTs-Dopamine', 'POS_Acetylcholine', 'POS_AA_Glutamine',
            'POS-NTs-NE', 'POS-NTs-5-HT', 'POS_Adenosine', '798'],
    precursor: [104, 137.1, 146.1, 147.0691, 152, 177, 268.24, 798.55],
    product: [87, 91.1, 87.1, 84, 107, 160, 136, 163],
    cv: [10, 50, 15, 22, 30, 14, 32, 20],
    ce: [10, 18, 10, 18, 14, 8, 18, 35],
    dwell: 0.0098889,
    W: 5, H: 3, pitch: 0.07, x0: 9.40746, y0: -5.78301,
  };
  const N = FX.W * FX.H, NCH = FX.names.length;
  const xs = [], ys = [];
  for (let r = 0; r < FX.H; r++) for (let c = 0; c < FX.W; c++) {
    xs.push(FX.x0 + c * FX.pitch); ys.push(FX.y0 + r * FX.pitch);
  }
  // Distinct per (scan, channel) so a column mix-up cannot pass unnoticed.
  const valueAt = (i, ch) => (ch + 1) * 1000 + i;

  // intensity = (w & 0x3FFFFF) * 2 ** ((w >>> 22) - 21); exponent 21 keeps an
  // integer mantissa verbatim.
  const word = (v) => ((((21 << 22) >>> 0) | v) >>> 0);

  const paramTable = ({ stride, params, records, write }) => {
    const dataOffset = 32 + params.length * 48;
    const buf = new ArrayBuffer(dataOffset + records * stride);
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    dv.setUint16(0, dataOffset, true); dv.setUint16(2, 1, true);
    dv.setUint16(4, stride, true); dv.setUint16(6, params.length, true);
    params.forEach((p, i) => {
      const b = 32 + i * 48;
      dv.setUint16(b, p.id, true); dv.setUint16(b + 2, p.flag, true); dv.setUint16(b + 4, p.offset, true);
      for (let k = 0; k < p.name.length && k < 26; k++) u8[b + 6 + k] = p.name.charCodeAt(k);
      dv.setUint16(b + 32, p.size, true);
    });
    for (let r = 0; r < records; r++) write(dv, dataOffset + r * stride, r);
    return new Uint8Array(buf);
  };

  const dat = new ArrayBuffer(N * NCH * 4);
  const datDv = new DataView(dat);
  for (let i = 0; i < N; i++) for (let c = 0; c < NCH; c++) {
    datDv.setUint32((i * NCH + c) * 4, word(valueAt(i, c)), true);
  }
  const idx = new ArrayBuffer(N * 22);
  const idxDv = new DataView(idx);
  for (let i = 0; i < N; i++) {
    let tic = 0; for (let c = 0; c < NCH; c++) tic += valueAt(i, c);
    idxDv.setUint32(i * 22, i * NCH * 4, true);
    idxDv.setUint32(i * 22 + 4, (0x08000000 | NCH) >>> 0, true);
    idxDv.setFloat32(i * 22 + 8, tic, true);
    idxDv.setFloat32(i * 22 + 12, (i + 1) * 0.00185, true);
  }
  // Odd stride (153, as the real instrument writes) so the fixture exercises the
  // unaligned reads that make DataView mandatory over typed-array views.
  const sts = paramTable({
    stride: 153,
    params: [
      { id: 9, flag: 3, offset: 16, size: 4, name: 'Aim X Position' },
      { id: 10, flag: 3, offset: 20, size: 4, name: 'Aim Y Position' },
    ],
    records: N,
    write: (dv, at, r) => { dv.setFloat32(at + 16, xs[r], true); dv.setFloat32(at + 20, ys[r], true); },
  });
  const ee = paramTable({
    stride: 4,
    params: [
      { id: 110, flag: 1, offset: 0, size: 2, name: 'Cone Voltage' },
      { id: 111, flag: 1, offset: 2, size: 2, name: 'Collision Energy' },
    ],
    records: NCH,
    write: (dv, at, c) => { dv.setUint16(at, FX.cv[c], true); dv.setUint16(at + 2, FX.ce[c], true); },
  });
  const REC = 1024;
  const cmp = new Uint8Array(12 + NCH * REC);
  const cmpDv = new DataView(cmp.buffer);
  cmpDv.setUint32(0, 1, true); cmpDv.setUint32(4, NCH, true);
  FX.names.forEach((nm, c) => { for (let k = 0; k < nm.length; k++) cmp[12 + c * REC + k] = nm.charCodeAt(k); });
  const fnsBuf = new Uint8Array(416);
  const fnsDv = new DataView(fnsBuf.buffer);
  fnsDv.setUint8(0, 9);                       // function type 9 = MRM
  fnsDv.setFloat32(10, 0, true); fnsDv.setFloat32(14, 3000, true);
  for (let c = 0; c < NCH; c++) {
    fnsDv.setFloat32(32 + c * 4, FX.dwell, true);
    fnsDv.setFloat32(160 + c * 4, FX.precursor[c], true);
    fnsDv.setFloat32(288 + c * 4, FX.product[c], true);
  }
  const enc = (t) => new TextEncoder().encode(t);
  const members = [
    ['260904_Test_POS1.raw/_HEADER.TXT', enc('$$ Instrument: XEVO-TQAbs#WDA0428\r\n$$ Acquired Date: 04-Sep-2026\r\n')],
    // 0xB0 is the windows-1252 degree sign; decoding as UTF-8 corrupts the key.
    ['260904_Test_POS1.raw/_extern.inf', Uint8Array.from([
      ...enc('[DESI Experiment Parameters]\r\nDesiXStep\t0.0087\r\nDesiYStep\t0.0700\r\n\r\n'),
      ...enc('Instrument Parameters - Function 1:\r\nPolarity\tES+\r\nSource Temperature ('), 0xB0,
      ...enc('C)\t150\t150\r\n'),
    ])],
    ['260904_Test_POS1.raw/_FUNCTNS.INF', fnsBuf],
    ['260904_Test_POS1.raw/_FUNC001.IDX', new Uint8Array(idx)],
    ['260904_Test_POS1.raw/_FUNC001.DAT', new Uint8Array(dat)],
    ['260904_Test_POS1.raw/_FUNC001.STS', sts],
    ['260904_Test_POS1.raw/_FUNC001.EE', ee],
    ['260904_Test_POS1.raw/_FUNC001.CMP', cmp],
  ];

  // Members matching this are DEFLATEd. The app writes deflated archives, so a
  // STORE-only fixture would never execute rawInflate — the single line where
  // this module and the app legitimately differ (zlib vs DecompressionStream).
  const ZIP_DEFLATE = /_FUNC001\.(STS|DAT|CMP)$/;
  const CRC_T = (() => { const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c >>> 0; }
    return t; })();
  const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const zipOf = (entries) => {
    const parts = [], central = []; let offset = 0;
    for (const [name, bytes] of entries) {
      const nb = enc(name), crc = crc32(bytes);
      const deflate = ZIP_DEFLATE.test(name);
      const stored = deflate ? new Uint8Array(deflateRawSync(bytes)) : bytes;
      const method = deflate ? 8 : 0;
      const L = new Uint8Array(30 + nb.length), ld = new DataView(L.buffer);
      ld.setUint32(0, 0x04034b50, true); ld.setUint16(4, 20, true); ld.setUint16(8, method, true);
      ld.setUint32(14, crc, true); ld.setUint32(18, stored.length, true); ld.setUint32(22, bytes.length, true);
      ld.setUint16(26, nb.length, true); L.set(nb, 30);
      const C = new Uint8Array(46 + nb.length), cd = new DataView(C.buffer);
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(6, 20, true); cd.setUint16(10, method, true);
      cd.setUint32(16, crc, true); cd.setUint32(20, stored.length, true); cd.setUint32(24, bytes.length, true);
      cd.setUint16(28, nb.length, true); cd.setUint32(42, offset, true); C.set(nb, 46);
      central.push(C); parts.push(L, stored); offset += L.length + stored.length;
    }
    const cdStart = offset; let cdSize = 0;
    for (const c of central) { parts.push(c); cdSize += c.length; }
    const E = new Uint8Array(22), ed = new DataView(E.buffer);
    ed.setUint32(0, 0x06054b50, true); ed.setUint16(8, central.length, true); ed.setUint16(10, central.length, true);
    ed.setUint32(12, cdSize, true); ed.setUint32(16, cdStart, true); parts.push(E);
    const total = parts.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(total); let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out.buffer;
  };
  const zip = zipOf(members);

  const { rawBundleFromZip, parseRawArchiveMeta, parseRawToRows, parseWatersFunctions } = await import('./raw.js');
  const meta = await parseRawArchiveMeta(rawBundleFromZip(zip));
  const f = meta.functions[0];

  check('root name comes from the *.raw/ prefix', meta.rootName === '260904_Test_POS1', meta.rootName);
  // .STS / .DAT / .CMP are DEFLATEd above, so everything below also exercises
  // rawInflate — zlib here, DecompressionStream in the app.
  check('DEFLATEd members inflate (zlib side of the only divergence)',
    f.channels[0].name === 'POS-NTs-GABA' && f.nScans === N, [f.channels[0].name, f.nScans]);
  check('instrument + acquired date read from _HEADER.TXT',
    meta.header['Instrument'] === 'XEVO-TQAbs#WDA0428' && meta.header['Acquired Date'] === '04-Sep-2026', meta.header);
  check('function type 9 = MRM', f.type === 9 && f.isMrm === true, f.type);

  // The type byte is 5 bits of MassLynx function type + acquisition flags in the
  // upper bits. Comparing the raw byte to 9 rejected a real 17-channel MRM
  // imaging run whose byte was 0x29, and the wizard then said "no MRM function"
  // about a file that decoded perfectly. Same fixture is run through the app's
  // copy below, so the two can never drift apart on this.
  const typeFixture = (() => {
    const REC = 416;
    const buf = new ArrayBuffer(REC * 3);
    const dv = new DataView(buf);
    [0x09, 0x29, 0x01].forEach((typeByte, fi) => {
      const b = fi * REC;
      dv.setUint8(b, typeByte);
      dv.setUint8(b + 1, 0x2d);
      if (typeByte === 0x01) return;         // SIR carries no transition
      for (let c = 0; c < 2; c++) {
        dv.setFloat32(b + 160 + c * 4, 104 + c, true);
        dv.setFloat32(b + 288 + c * 4, 87 + c, true);
      }
    });
    return buf;
  })();
  const typeFns = parseWatersFunctions(typeFixture);
  check('★ acquisition flags masked off the type byte (0x29 is still MRM)',
    typeFns.length === 3
    && typeFns[0].type === 9 && typeFns[0].typeByte === 0x09 && typeFns[0].isMrm === true
    && typeFns[1].type === 9 && typeFns[1].typeByte === 0x29 && typeFns[1].isMrm === true
    && typeFns[2].type === 1 && typeFns[2].isMrm === false,
    typeFns.map(x => [x.typeByte, x.type, x.isMrm]));
  check('polarity from _extern.inf (never guessed)', f.polarity === '+', f.polarity);
  check('windows-1252 key survives (Source Temperature)',
    f.source && f.source.sourceTempC === '150', f.source);
  check('scan + channel counts', f.nScans === N && f.nChannels === NCH, [f.nScans, f.nChannels]);
  check('all four channel counts agree', f.countsDisagree === false, f.counts);
  check('compound names from _FUNCnnn.CMP',
    JSON.stringify(f.channels.map(c => c.name)) === JSON.stringify(FX.names), f.channels.map(c => c.name));
  check('precursor m/z from _FUNCTNS.INF @160',
    JSON.stringify(f.channels.map(c => c.precursor)) === JSON.stringify(FX.precursor), f.channels.map(c => c.precursor));
  check('product m/z from _FUNCTNS.INF @288',
    JSON.stringify(f.channels.map(c => c.product)) === JSON.stringify(FX.product), f.channels.map(c => c.product));
  check('★ cone voltage from _FUNCnnn.EE',
    JSON.stringify(f.channels.map(c => c.cv)) === JSON.stringify(FX.cv), f.channels.map(c => c.cv));
  check('★ collision energy from _FUNCnnn.EE',
    JSON.stringify(f.channels.map(c => c.ce)) === JSON.stringify(FX.ce), f.channels.map(c => c.ce));
  check('dwell rounded off float32 noise', f.channels.every(c => c.dwell === 0.009889), f.channels[0].dwell);
  // DesiXStep is the distance travelled during ONE channel, so the X pitch is
  // DesiXStep * nChannels. Reading it as the pitch is wrong by the channel count;
  // the stage coordinates in .STS are the authority.
  check('★ grid and pitch come from the stage coordinates, not DesiXStep',
    f.width === FX.W && f.height === FX.H
    && Math.abs(f.pitchX - FX.pitch) < 1e-6 && Math.abs(f.pitchY - FX.pitch) < 1e-6,
    [f.width, f.height, f.pitchX, f.pitchY]);
  check('DesiXStep x nChannels agrees, so no pitch warning', meta.pitchWarning === null, meta.pitchWarning);

  const rows = await parseRawToRows(zip, { func: 1, channel: 2 });
  check('rows returned', rows.length === N, rows.length);
  check('★ the requested channel is the one returned',
    rows.every((r, i) => r.v === valueAt(i, 2)), rows.slice(0, 3));
  const grid = buildMsiGrid(rows);
  check('snapped coordinates land on the true raster (no ordinal fallback)',
    grid.W === FX.W && grid.H === FX.H && !grid.gridFallback, [grid.W, grid.H, grid.gridFallback]);

  // ---- live diff against the app's own copy -------------------------------
  const viewerSrc = readFileSync(fileURLToPath(new URL('../../viewer/index.html', import.meta.url)), 'utf8');
  const S = viewerSrc.indexOf('// ==== BEGIN waters-raw parser');
  const E = viewerSrc.indexOf('// ==== END waters-raw parser');
  check('locate the app .raw parser in viewer/index.html', S >= 0 && E > S, { S, E });
  if (S >= 0 && E > S) {
    // The app's rawInflate uses DecompressionStream, which Node has natively,
    // so the block runs here unmodified — no shim, nothing to keep in sync.
    const ctx = vm.createContext({
      TextDecoder, TextEncoder, Blob, Response, DecompressionStream, console,
    });
    new vm.Script(viewerSrc.slice(S, E)
      + '\nglobalThis.__app = { rawBundleFromZip, parseRawArchiveMeta, parseRawToRows, parseWatersFunctions };').runInContext(ctx);
    const app = ctx.globalThis ? ctx.globalThis.__app : ctx.__app;
    const appMeta = await app.parseRawArchiveMeta(app.rawBundleFromZip(zip));
    const appF = appMeta.functions[0];
    check('★ app and connector agree on the channel table',
      JSON.stringify(appF.channels) === JSON.stringify(f.channels));
    check('★ app and connector agree on the grid',
      appF.width === f.width && appF.height === f.height
      && appF.pitchX === f.pitchX && appF.pitchY === f.pitchY);
    let same = true;
    for (let ch = 0; ch < NCH; ch++) {
      const a = await app.parseRawToRows(zip, { func: 1, channel: ch });
      const b = await parseRawToRows(zip, { func: 1, channel: ch });
      if (a.length !== b.length) { same = false; break; }
      for (let i = 0; i < a.length; i++) {
        if (a[i].x !== b[i].x || a[i].y !== b[i].y || a[i].v !== b[i].v) { same = false; break; }
      }
      if (!same) break;
    }
    check('★ every {x,y,v} of every channel matches the app bit for bit', same);
    const poly = [[-0.5, -0.5], [1.5, -0.5], [1.5, 1.5], [-0.5, 1.5]];
    const appRows = await app.parseRawToRows(zip, { func: 1, channel: 5 });
    const sa = stats(extractRoiValues(appRows, poly));
    const sb = stats(extractRoiValues(rows.length ? await parseRawToRows(zip, { func: 1, channel: 5 }) : [], poly));
    check('★ ROI statistics match the app', JSON.stringify(sa) === JSON.stringify(sb), [sa, sb]);
    const appTypeFns = app.parseWatersFunctions(typeFixture);
    check('★ app and connector mask the type byte identically',
      JSON.stringify(appTypeFns.map(x => [x.typeByte, x.type, x.isMrm]))
      === JSON.stringify(typeFns.map(x => [x.typeByte, x.type, x.isMrm])),
      appTypeFns.map(x => [x.typeByte, x.type, x.isMrm]));
  }

  // ---- it must survive the pieces a .raw may not carry --------------------
  const minimal = zipOf(members.filter(([n]) => /(IDX|DAT|STS)$/.test(n)));
  const mm = await parseRawArchiveMeta(rawBundleFromZip(minimal));
  check('IDX + DAT + STS alone still parse', mm.functions[0].nChannels === NCH
    && mm.functions[0].width === FX.W, mm.functions[0]);
  check('missing EE/CMP degrades to null rather than throwing',
    mm.functions[0].channels[0].name === null && mm.functions[0].channels[0].cv === null);

  // ---- rows.js dispatch ---------------------------------------------------
  const cache = newRowCache({ fetchBytes: async () => zip });
  const viaCache = await loadRowsForDef({ kind: 'raw', path: 'x/blobs/b.zip', func: 1, channel: 2 }, cache);
  check('loadRowsForDef dispatches kind:raw', viaCache.length === N && viaCache[0].v === valueAt(0, 2));
  check('the archive is fetched whole exactly once', cache.fetchCount === 1, cache.fetchCount);
}

// =============================================================================
// buildMsiGrid — connector vs app
//
// This one exists because it actually drifted. The app gained a "try the MEDIAN
// gap before the minimum" pitch estimator; this module kept the min-only
// version for about a month. On evenly spaced data the two agree, so nothing
// looked broken — but they disagree exactly where the median was introduced to
// help (float stage jitter), which is what a Waters .raw carries. A silent
// disagreement here means the AI quotes ROI numbers computed on a different
// pixel grid than the one the app drew.
//
// Extract the app's own buildMsiGrid and diff it, rather than eyeballing the
// two copies.
// =============================================================================
console.log('buildMsiGrid — connector vs app');
{
  const viewerSrc = readFileSync(fileURLToPath(new URL('../../viewer/index.html', import.meta.url)), 'utf8');
  const START = '\nfunction buildMsiGrid(rows) {';
  const END = '// Pure numeric core (no DOM/canvas): build the MSI raster grid';
  const s0 = viewerSrc.indexOf(START);
  const e0 = viewerSrc.indexOf(END, s0);
  check('locate the app buildMsiGrid in viewer/index.html', s0 >= 0 && e0 > s0, { s0, e0 });
  if (s0 >= 0 && e0 > s0) {
    const ctx = vm.createContext({});
    new vm.Script(viewerSrc.slice(s0 + 1, e0) + '\nglobalThis.__appGrid = buildMsiGrid;').runInContext(ctx);
    const appGrid = ctx.globalThis ? ctx.globalThis.__appGrid : ctx.__appGrid;

    // Coordinates are the same on both axes so each case exercises x and y.
    const CASES = {
      'evenly spaced, complete': [0, 1, 2, 3, 4, 5],
      'a skipped scan line': [0, 1, 2, 4, 5],
      // ★ THE DISCRIMINATING CASE. One gap smaller than the true pitch, which is
      //   what stage jitter looks like. min-only spreads this to W=10 and draws
      //   phantom gaps; the median keeps W=6. The drift this test guards against
      //   showed up here and nowhere else.
      'float jitter (one short gap)': [0, 1, 2, 3, 4, 4.5],
      'sparse ROI-only coordinates': [0, 10, 20, 21],
      'two clustered coordinates': [0, 2, 4, 6, 6.1, 8],
      'single coordinate': [3],
    };
    const asRows = (vals) => {
      const out = [];
      for (const y of vals) for (const x of vals) out.push({ x, y, v: 1 });
      return out;
    };
    const dump = (g) => JSON.stringify({
      W: g.W, H: g.H, fallback: g.gridFallback,
      x: [...g.xIndex.entries()].sort((a, b) => a[0] - b[0]),
      y: [...g.yIndex.entries()].sort((a, b) => a[0] - b[0]),
    });
    for (const [name, vals] of Object.entries(CASES)) {
      const rows = asRows(vals);
      const a = dump(appGrid(rows));
      const b = dump(buildMsiGrid(rows));
      check('★ ' + name, a === b, a === b ? null : { app: a, connector: b });
    }
    // Pin the behaviour the drift got wrong, so "both sides agree" cannot be
    // satisfied by both regressing to min-only together.
    const jitter = asRows(CASES['float jitter (one short gap)']);
    check('★ the jitter case uses the median pitch (W=6, not the min-gap W=10)',
      buildMsiGrid(jitter).W === 6, buildMsiGrid(jitter).W);
  }
}

console.log('');
if (failures) { console.log('SELFTEST FAILED:', failures, 'check(s)'); process.exit(1); }
console.log('SELFTEST PASSED');
