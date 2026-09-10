'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../viewer/index.html'), 'utf8');
function fn(name) {
  const at = html.indexOf('function ' + name + '(');
  assert.ok(at >= 0, name);
  return html.slice(at, html.indexOf('\n}', at) + 2);
}
const ctx = vm.createContext({
  // The source reference is an opaque contract here. Its derivation belongs
  // to the source/ROI tests; this test requires it to precede blob mutation.
  msiSourceReference: ent => ent.sourceReference || 'derived:' + ent.blobId,
});
for (const name of ['parquetReplaceMismatch', 'replaceParquetSourceReferences']) {
  vm.runInContext(fn(name), ctx);
}
const info = { colNames: ['x', 'y', 'annotation', '100'], numRows: 3 };
function geometry() {
  return { sections: [{ label: 'brain', W: 2, H: 1,
    rowIdx: [0, 1], cellIdx: [0, 1],
    sourceRows: [{ x: 0, y: 0, rowId: 0 }, { x: 1, y: 0, rowId: 1 },
      { x: NaN, y: 0, rowId: 2 }] }] };
}
const mismatch = other => ctx.parquetReplaceMismatch(info, [100], geometry(), info, [100], other);
assert.equal(mismatch(geometry()), null, 'An identical repack, including unlocated rows, is accepted');
const shifted = geometry();
shifted.sections[0].sourceRows[0].x += 100;
shifted.sections[0].sourceRows[1].x += 100;
assert.match(mismatch(shifted), /元座標/, 'Equal grids must not hide translated raw coordinates');
const rescaled = geometry(); rescaled.sections[0].sourceRows[1].x = 2;
assert.match(mismatch(rescaled), /元座標/, 'Equal grids must not hide a different physical pitch');
const unlocated = geometry(); unlocated.sections[0].sourceRows[2].rowId = 9;
assert.match(mismatch(unlocated), /行識別子/, 'Unlocated source rows still retain their identity');
const oldCache = geometry(); delete oldCache.sections[0].sourceRows;
assert.match(mismatch(oldCache), /確認できません/, 'Unavailable provenance must fail closed');

const a = { kind: 'parquet', sourceFileId: 'fileA', blobId: 'old', storagePath: 'old/path', sourceUrl: 'old/url' };
const b = { kind: 'parquet', sourceFileId: 'fileA', blobId: 'old', sourceReference: 'stable' };
const unrelated = { kind: 'parquet', sourceFileId: 'other', blobId: 'old' };
const fa = { blobId: 'old', storagePath: 'old/path', sourceUrl: 'old/url', sourcePath: 'old/zip' };
const fb = { blobId: 'old' };
const project = { sections: [
  { msiSeries: { a, unrelated }, msiFiles: { fileA: fa, other: { blobId: 'old' } } },
  { msiSeries: { b }, msiFiles: { fileA: fb } },
] };
const stillUsed = ctx.replaceParquetSourceReferences(project, [a, b], 'old', 'new', { name: 'repacked.parquet', size: 123 });
assert.equal(stillUsed, true, 'A different source still references the old blob');
assert.equal(a.sourceReference, 'derived:old', 'A legacy source reference is frozen before changing its blob');
assert.equal(b.sourceReference, 'stable');
for (const e of [a, b, fa, fb]) {
  assert.equal(e.blobId, 'new');
  assert.equal(e.filename, 'repacked.parquet');
  assert.equal(e.sourceBytes, 123);
  assert.equal(e.storagePath, undefined);
  assert.equal(e.sourceUrl, undefined);
  assert.equal(e.sourcePath, undefined);
}
assert.equal(unrelated.blobId, 'old', 'An unrelated source must remain unchanged');
assert.equal(project.sections[0].msiFiles.other.blobId, 'old');
const single = { sections: [{ msiSeries: { a: { blobId: 'before' } } }] };
assert.equal(ctx.replaceParquetSourceReferences(single, [single.sections[0].msiSeries.a], 'before', 'after',
  { name: 'same.parquet', size: 9 }), false);
console.log('MSI source replacement regression: PASS');
