'use strict';

// Run after `npm ci` in connector: exercise the actual XLSX/Parquet decoders,
// source-token export and worker transport, without DOM or a remote service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { deflateRawSync } = require('node:zlib');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'viewer/index.html'), 'utf8');
const XLSX = require('../connector/node_modules/xlsx');

function sourceFunction(name) {
  const re = new RegExp('(?:async )?function ' + name + '\\(');
  const start = html.search(re);
  assert.ok(start >= 0, 'function exists: ' + name);
  // Top-level function terminators are at column zero throughout the viewer.
  const end = html.indexOf('\n}', start);
  assert.ok(end > start, 'function terminator: ' + name);
  return html.slice(start, end + 2);
}

const names = [
  'msiSourceCell', 'msiSourceNumber', 'msiSourceRow', 'msiDelimitedRecords',
  'msiTextTable', 'msiTextValueColumn', 'a1ColToIndex', 'parseXlsxSheet',
  'rowsFromParsedXlsx', 'parseXlsxToRows', 'parseTxtToRows', 'rawSnapCoords',
  'rawRowsFromDecoded', 'msiMatrixFromRows', 'msiSourceFrameKey',
  'extractSourceMatrixForExport', 'msiCsvRowOrder', 'msiCsvCellText',
  'msiCellMetadata', 'buildOneCsvTable', 'buildSampleCsvGroups', 'csvEscape',
  'exportProjectAsZip', 'importZipFile', '_parquetWorkerBody', 'extractRawSourceMatrix',
  'buildMsiGrid', 'buildLegacyMsiGrid', 'msiSourceReference', 'createMsiSourceGeometry',
  'msiAxisInterpolate', 'pointInPolygon', 'roiContainsSourcePoint', 'msiValidRoiGeometry', 'msiRoiGeometryMeta',
];
const ctx = vm.createContext({
  console, TextDecoder, TextEncoder, Uint8Array, Int32Array, Float32Array,
  Float64Array, ArrayBuffer, Blob, Response, DecompressionStream, XLSX, Promise, Object, Math, JSON, BigInt,
  Number, String, Map, Set, Array, Error,
  findCompoundMeta: () => null, formatDisplayName: value => value,
  sanitizeCompoundName: value => value,
  sortMethodKeys: keys => keys,
  _yieldUi: async () => {},
});
vm.runInContext(names.map(sourceFunction).join('\n') + '\nlet _exportInProgress = false;', ctx);
const bytes = text => new TextEncoder().encode(text).buffer;
const serial = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(Buffer.from(value)).digest('hex');

async function testRowsAndExports() {
  const connector = await import(pathToFileURL(path.join(root, 'connector/src/msi.js')));
  const txt = 'x,y,"ion, A"\r\n2,0,10\r\n0,0,30\r\n2,0,100\r\n1,0,\r\n,0,7\r\n1,1,0\r\n1,2,-3\r\n1,3,invalid\r\n1,4,9007199254740993\r\n1,5,"bad, token"\r\n';
  const buf = bytes(txt), before = hash(buf);
  const def = { kind: 'txt', v: 'ion, A', sourceFileId: 'file-A', blobId: 'blob-A' };
  const rows = ctx.parseTxtToRows(buf, def);
  assert.equal(rows.length, 10, 'missing/invalid rows retained');
  assert.equal(rows[3].sourceCells.v.status, 'blank');
  assert.ok(Number.isNaN(rows[3].v));
  assert.ok(Number.isNaN(rows[4].x));
  assert.equal(rows[4].v, 7, 'invalid coordinate does not remove global measurement');
  assert.equal(rows[5].v, 0);
  assert.equal(rows[6].v, -3);
  assert.equal(rows[7].sourceCells.v.token, 'invalid');
  assert.equal(rows[8].sourceCells.v.token, '9007199254740993');
  assert.equal(rows[8].sourceCells.v.status, 'unsafe-integer');
  assert.equal(rows[8].precisionBlocked, true);
  assert.equal(rows[9].sourceCells.v.token, 'bad, token');
  assert.deepEqual(serial(rows), serial(connector.parseTxtToRows(buf, def)), 'viewer/connector tokens and values agree');
  assert.equal(hash(buf), before, 'source bytes unchanged');

  const entry = { layerKey: 'MSI_A', ent: def };
  const matrix = await ctx.extractSourceMatrixForExport(buf, def, [entry]);
  const member = { matrix, entries: [entry] };
  const none = ctx.buildOneCsvTable([member], [], {}, 'none');
  for (const mode of ['drop', 'flag', 'none']) {
    ctx.App = { otsuBgRemove: true, otsuStrength: 99, otsuManualThreshold: 99 };
    const out = ctx.buildOneCsvTable([member], [], {}, mode);
    assert.equal(out.csvText, none.csvText, 'Otsu cannot alter numeric output');
    assert.equal(out.rowCount, 10);
  }
  const csvRows = ctx.msiDelimitedRecords(none.csvText, ',');
  assert.deepEqual(serial(csvRows.slice(1).map(row => row.slice(0, 3))), serial(ctx.msiDelimitedRecords(txt, ',').slice(1)));
  assert.equal(none.sourceMetadata.columns[0].cells[3].status, 'blank');
  assert.equal(none.sourceMetadata.columns[0].cells[8].token, '9007199254740993');
  const otherDef = { kind: 'txt', sourceFileId: 'file-B' };
  const other = await ctx.extractSourceMatrixForExport(bytes('x,y,z\n9,9,1\n8,8,2\n'), otherDef, [{ layerKey: 'MSI_B', ent: otherDef }]);
  assert.equal(ctx.msiCsvRowOrder(matrix, other), null);
  assert.deepEqual(serial(ctx.msiCsvRowOrder(matrix, { ...matrix })), Array.from({ length: 10 }, (_, i) => i), 'same-source row IDs preserve duplicates');
  assert.equal(ctx.msiCsvRowOrder(matrix, { ...matrix, sourceFrame: 'unrelated-source' }), null, 'duplicate coordinates cannot join across sources');
  const pairA = await ctx.extractSourceMatrixForExport(bytes('x,y,z\n2,0,10\n0,0,30\n'), def, [{ layerKey: 'MSI_A', ent: { ...def, v: 'z' } }]);
  const pairB = await ctx.extractSourceMatrixForExport(bytes('x,y,z\n0,0,300\n2,0,100\n'), otherDef, [{ layerKey: 'MSI_B', ent: otherDef }]);
  assert.deepEqual(serial(ctx.msiCsvRowOrder(pairA, pairB)), [1, 0], 'complete coordinate bijection accepted');
  const wrong = { ...pairB, positions: [{ x: 7, y: 0 }, { x: 8, y: 0 }] };
  assert.equal(ctx.msiCsvRowOrder(pairA, wrong), null, 'equal row count does not establish identity');
  assert.throws(() => ctx.buildOneCsvTable([{ matrix: pairA, entries: [entry] }, { matrix: wrong, entries: [{ layerKey: 'MSI_B', ent: otherDef }] }], [], {}, 'none'), /Cannot join/);

  const wb = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['x', 'y', 'v'], [2, 0, 1.0000000000000002], [2, 0, null], [null, 0, 9], [1, 0, 0], [1, 1, -2], [1, 2, 'bad']]);
  sheet.C7 = { t: 'e', v: 7 };
  XLSX.utils.book_append_sheet(wb, sheet, 'MSI');
  const xbuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const xd = { kind: 'xlsx', sheet: 'MSI', data_start_row: 2, col_x: 'A', col_y: 'B', col_v: 'C' };
  const xr = ctx.parseXlsxToRows(xbuf, xd);
  assert.equal(xr.length, 6);
  assert.equal(xr[0].v, 1.0000000000000002, 'DOUBLE precision retained');
  assert.ok(Number.isNaN(xr[1].v));
  assert.ok(Number.isNaN(xr[2].x));
  assert.equal(xr[3].v, 0);
  assert.equal(xr[5].sourceCells.v.status, 'invalid-cell', 'Excel errors are not numeric error codes');
  assert.equal(xr[5].sourceCells.v.errorCode, 7, 'original error code retained separately');
  assert.ok(Number.isNaN(Number(xr[5].sourceCells.v.token)), 'error token cannot look like measured intensity');
  assert.deepEqual(serial(xr), serial(connector.parseXlsxToRows(xbuf, xd)));
  const errorMatrix = await ctx.extractSourceMatrixForExport(xbuf, xd, [{ layerKey: 'MSI_Error', ent: xd }]);
  const errorCsv = ctx.buildOneCsvTable([{ matrix: errorMatrix, entries: [{ layerKey: 'MSI_Error', ent: xd }] }], [], {}, 'none');
  assert.equal(ctx.msiDelimitedRecords(errorCsv.csvText, ',')[6][2], xr[5].sourceCells.v.token);
  assert.equal(errorCsv.sourceMetadata.columns[0].cells[5].errorCode, 7, 'sidecar retains original error code');
  const withoutFormattedText = ctx.rowsFromParsedXlsx({ aoa: [[0, 0, 7]], sheet: { C1: { t: 'e', v: 7 } } }, { col_x: 'A', col_y: 'B', col_v: 'C' });
  assert.equal(withoutFormattedText[0].sourceCells.v.token, '#EXCEL_ERROR:7', 'unformatted error uses a visibly nonnumeric token');
  const decoded = { nCh: 1, nScans: 3, xs: new Float64Array([0, 1.00001, 2]), ys: new Float64Array([0, 0, 0]), chans: [new Float64Array([10, NaN, 100])], gridX: { pitch: 1, min: 0 }, gridY: { pitch: 0, min: 0 } };
  const rr = ctx.rawRowsFromDecoded(decoded, {});
  assert.equal(rr.length, 3);
  assert.equal(rr[1].x, 1.00001, 'original raw jitter retained');
  assert.equal(rr[1].legacyX, 1, 'legacy position is separate metadata');
  assert.ok(Number.isNaN(rr[1].v));
  assert.equal(ctx.msiSourceCell(9007199254740993n).status, 'unsafe-integer');
  assert.equal(ctx.msiSourceNumber(123n), 123);
  assert.equal(ctx.msiSourceCell(-0).token, '-0');
}

async function testSourceFramesAndRoiMetadata() {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x', 'y', 'v'], [2, 0, 10], [0, 0, 30]]), 'One');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x', 'y', 'v'], [12, 0, 100], [10, 0, 300]]), 'Two');
  const xbuf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const base = { kind: 'xlsx', sourceFileId: 'shared-workbook', blobId: 'workbook', data_start_row: 2, col_x: 'A', col_y: 'B', col_v: 'C' };
  const sec = { id: 'multi', meta: {}, msiSeries: { MSI_One: { ...base, sheet: 'One' }, MSI_Two: { ...base, sheet: 'Two' } } };
  const poly = [[-1, -1], [2, -1], [2, 2], [-1, 2]];
  const legacyRoi = { name: 'Legacy', polysBySection: { multi: poly } };
  ctx.ProjectStorage = { getBlob: async () => ({ blob: new Blob([xbuf]) }) };
  const groups = await ctx.buildSampleCsvGroups(sec, { rois: [legacyRoi] }, 'none');
  assert.equal(groups.length, 2, 'different sheets from same workbook retain independent source frames');
  const read = group => ctx.msiDelimitedRecords(group.csvText, ',').slice(1);
  assert.deepEqual(serial(read(groups[0]).map(row => row.slice(0, 3))), [['2', '0', '10'], ['0', '0', '30']]);
  assert.deepEqual(serial(read(groups[1]).map(row => row.slice(0, 3))), [['12', '0', '100'], ['10', '0', '300']]);
  for (const group of groups) {
    assert.ok(read(group).every(row => row.at(-1) === ''), 'ambiguous legacy ROI cannot assign invented labels');
    assert.deepEqual(serial(group.sourceMetadata.roiAssignments), [{ name: 'Legacy', status: 'unresolved', reason: 'legacy-roi-source-ambiguous' }]);
  }
  const firstDef = sec.msiSeries.MSI_One;
  const firstMatrix = await ctx.extractSourceMatrixForExport(xbuf, firstDef, [{ layerKey: 'MSI_One', ent: firstDef }]);
  const geometry = ctx.createMsiSourceGeometry(firstMatrix.positions, firstDef);
  const roiGeometry = { version: 'msi-source-v1', sourceRef: geometry.sourceRef, displayGeometry: geometry.displayGeometry };
  const resolved = ctx.buildOneCsvTable([{ matrix: firstMatrix, entries: [{ layerKey: 'MSI_One', ent: firstDef }] }], [{ name: 'Resolved', poly, geometry: roiGeometry }], {}, 'none');
  assert.ok(read(resolved).every(row => row.at(-1) === 'Resolved'));
  const mismatch = ctx.buildOneCsvTable([{ matrix: firstMatrix, entries: [{ layerKey: 'MSI_One', ent: firstDef }] }], [{ name: 'WrongSource', poly, geometry: { ...roiGeometry, sourceRef: 'unrelated' } }], {}, 'none');
  assert.ok(read(mismatch).every(row => row.at(-1) === ''));
  assert.equal(mismatch.sourceMetadata.roiAssignments[0].status, 'unresolved');

  // Reuse the existing byte-level raw fixture, adding a real second function
  // with translated source coordinates and different original intensity words.
  const fixtureSource = fs.readFileSync(path.join(root, 'tests/viewer_preview_regression.js'), 'utf8');
  const fxStart = fixtureSource.indexOf('const RAW_FX =');
  const fxEnd = fixtureSource.indexOf('// Anchored so a mention', fxStart);
  assert.ok(fxStart >= 0 && fxEnd > fxStart);
  const fx = vm.createContext({ TextEncoder, Uint8Array, Uint32Array, DataView, ArrayBuffer, deflateRawSync });
  vm.runInContext(fixtureSource.slice(fxStart, fxEnd), fx);
  const members = fx.buildSyntheticRawMembers();
  const second = members.filter(([name]) => /_FUNC001\./.test(name)).map(([name, bytes]) => {
    const copy = new Uint8Array(bytes);
    const dv = new DataView(copy.buffer);
    if (name.endsWith('.DAT')) {
      for (let i = 0; i < copy.length; i += 4) dv.setUint32(i, dv.getUint32(i, true) + 1000, true);
    }
    if (name.endsWith('.STS')) {
      const start = dv.getUint16(0, true), stride = dv.getUint16(4, true);
      for (let i = start; i < copy.length; i += stride) dv.setFloat32(i + 1, dv.getFloat32(i + 1, true) + 10, true);
    }
    return [name.replace('_FUNC001.', '_FUNC002.'), copy];
  });
  assert.ok(second.length >= 3, 'second raw function has its actual IDX/DAT/STS members');
  const archive = fx.buildZip(members.concat(second));
  const rawStart = html.indexOf('// ==== BEGIN waters-raw parser');
  const rawEnd = html.indexOf('// ==== END waters-raw parser', rawStart);
  vm.runInContext(html.slice(rawStart, rawEnd), ctx);
  const rawBase = { kind: 'raw', blobId: 'raw', sourceFileId: 'raw-source', channel: 0 };
  const rawSec = { id: 'raw-section', meta: {}, msiSeries: { MSI_F1: { ...rawBase, func: 1 }, MSI_F2: { ...rawBase, func: 2 } } };
  ctx.ProjectStorage = { getBlob: async () => ({ blob: new Blob([archive]) }) };
  const rawGroups = await ctx.buildSampleCsvGroups(rawSec, { rois: [] }, 'none');
  assert.equal(rawGroups.length, 2, 'same archive distinct function scans are never silently skipped or mixed');
  const r1 = read(rawGroups[0]), r2 = read(rawGroups[1]);
  assert.equal(r1.length, r2.length);
  for (let i = 0; i < r1.length; i++) {
    assert.equal(Number(r2[i][2]), Number(r1[i][2]) + 1000);
    assert.ok(Math.abs(Number(r2[i][0]) - Number(r1[i][0]) - 10) < 1e-5);
  }
}

async function testParquetColumns() {
  const importPackage = name => { const dir = path.join(root, 'connector/node_modules', name); const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); return import(pathToFileURL(path.join(dir, pkg.main))); };
  const { parquetWriteBuffer } = await importPackage('hyparquet-writer');
  const hy = await importPackage('hyparquet');
  const { compressors } = await importPackage('hyparquet-compressors');
  const { openParquet, readColumn } = await import(pathToFileURL(path.join(root, 'connector/src/parquet.js')));
  const buf = parquetWriteBuffer({ compressed: false, columnData: [
    { name: 'double', type: 'DOUBLE', data: [1.0000000000000002, null, NaN] },
    { name: 'integer', type: 'INT64', data: [1n, 9007199254740993n, null] },
    { name: 'float', type: 'FLOAT', data: [Math.fround(0.1), null, 10] },
  ] });
  const blob = new Blob([buf]);
  const file = { byteLength: buf.byteLength, slice: async (a, b) => buf.slice(a, b) };
  const st = await openParquet('source-regression', { file });
  const dc = await readColumn(st.file, st.idx, 0, 'f32');
  assert.ok(dc instanceof Float64Array, 'even explicit display f32 cannot narrow DOUBLE source');
  assert.equal(dc[0], 1.0000000000000002);
  assert.equal(dc._sourceCellStates[1].status, 'missing');
  assert.ok(Number.isNaN(dc[2]));
  const ints = await readColumn(st.file, st.idx, 1);
  assert.equal(ints[1], 9007199254740993n);
  assert.equal(ints[2], null);
  const fc = await readColumn(st.file, st.idx, 2);
  assert.ok(fc instanceof Float32Array);
  assert.equal(fc[0], Math.fround(0.1));
  const fake = { onmessage: null, posted: [], postMessage(message) { this.posted.push(structuredClone(message)); } };
  ctx._parquetWorkerBody(fake, { ...hy, compressors });
  await fake.onmessage({ data: { id: 1, op: 'open', fileId: 'f', blob } });
  assert.equal(fake.posted[0].ok, true);
  await fake.onmessage({ data: { id: 2, op: 'columns', fileId: 'f', blob, colIdxs: [0, 1, 2] } });
  const msg = fake.posted[1];
  assert.equal(msg.ok, true, msg.error);
  assert.equal(msg.result[0][0], dc[0]);
  assert.equal(msg.result[1][1], ints[1]);
  assert.equal(msg.sourceCellStates[0][1].status, 'missing', 'missing type survives real structured clone envelope');
  const decimalIdx = { ...st.idx, schema: st.idx.schema.map(el => el.name === 'double' ? { ...el, converted_type: 'DECIMAL', scale: 18 } : el) };
  await assert.rejects(readColumn({ slice() { throw new Error('decoder must not run'); } }, decimalIdx, 0), /exact decimal arithmetic is unsupported/);
}

async function testOriginalZipBytes() {
  const source = bytes('x,y,v\n2,0,10\n0,0,\n2,0,30\n');
  const originalHash = hash(source), files = new Map();
  class TestZip {
    static async loadAsync() {
      return { files: Object.fromEntries([...files.keys()].map(name => [name, {}])),
        file(name) { if (!files.has(name)) return null; return { async: async type => {
          const data = files.get(name);
          if (type === 'blob') return data instanceof Blob ? data : new Blob([data]);
          if (type === 'string') return data instanceof Blob ? await data.text() : String(data);
          throw new Error('unexpected ZIP read type');
        } }; } };
    }
    file(name, data) { files.set(name, data); return this; }
    async generateAsync() { return new Blob(['fixture']); }
  }
  const ent = { kind: 'txt', blobId: 'b', sourceFileId: 'f', filename: 'test.txt', sourceReference: 'stable-source' };
  Object.assign(ctx, {
    JSZip: TestZip, LAZY_LIBS: { jszip: '' }, loadScript: async () => {},
    freezeMsiSourceReferences: () => {}, safeName: v => v,
    sanitizeStorageKeySegment: v => v, DEFAULT_ANATOMY_PALETTE: {},
    ensureMemoShape: () => ({}), openPublishProgressModal: () => ({ update() {}, close() {} }),
    ProjectStorage: { getBlob: async id => id === 'b' ? { blob: new Blob([source]) } : null },
    App: { project: { id: 'p', displayName: 'Project', sections: [{ id: 's', displayName: 'Section', msiSeries: { MSI_A: ent }, msiFiles: { f: ent } }] } },
    showToast: () => {}, alert: message => { throw new Error(message); },
    downloadAsFile: () => {},
  });
  await ctx.exportProjectAsZip();
  const original = files.get('Source/b__test.txt');
  assert.ok(original instanceof Blob);
  assert.equal(hash(await original.arrayBuffer()), originalHash, 'ZIP original has identical bytes');
  const manifest = JSON.parse(files.get('Project.json'));
  assert.equal(manifest.sections[0].originalSeries.MSI_A.sourceReference, 'stable-source');
  assert.equal(manifest.sections[0].originalSeries.MSI_A.kind, 'txt');
  assert.equal(manifest.sections[0].data[0].rowCount, 3);
  assert.ok(files.has(manifest.sections[0].data[0].sourceMetadataPath));
  const importedBlobs = new Map(); let importedProject = null, seq = 0;
  Object.assign(ctx, { uid: prefix => prefix + (++seq), nowIso: () => '2026-09-10T00:00:00Z',
    guessMimeFromPath: () => 'application/octet-stream',
    ProjectStorage: { putBlob: async rec => importedBlobs.set(rec.id, rec.blob), putProject: async project => { importedProject = project; } },
  });
  ctx.App.openProject = async () => {};
  await ctx.importZipFile(new Blob(['fixture']));
  assert.ok(importedProject);
  const restored = importedProject.sections[0].msiSeries.MSI_A;
  assert.equal(restored.kind, 'txt');
  assert.equal(restored.sourceReference, 'stable-source');
  const restoredBytes = await importedBlobs.get(restored.blobId).arrayBuffer();
  assert.equal(hash(restoredBytes), originalHash, 'Export -> Import preserves original source bytes');
  assert.deepEqual(serial(ctx.parseTxtToRows(restoredBytes, restored)), serial(ctx.parseTxtToRows(source, ent)), 'Export -> Import preserves source row values, missingness and tokens');
}

(async () => {
  await testRowsAndExports();
  await testSourceFramesAndRoiMetadata();
  await testParquetColumns();
  await testOriginalZipBytes();
  console.log('MSI source rows, precision and export regression tests: PASS');
})().catch(error => { console.error(error); process.exitCode = 1; });
