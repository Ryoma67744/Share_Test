// Offline self-consistency test (no network). Verifies the ported parsing /
// grid / ROI-extraction / stats produce the expected numbers, so we can trust
// they match the web app. Run: `npm run selftest`.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
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

console.log('');
if (failures) { console.log('SELFTEST FAILED:', failures, 'check(s)'); process.exit(1); }
console.log('SELFTEST PASSED');
