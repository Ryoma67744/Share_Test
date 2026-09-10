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
const ctx = vm.createContext({ Map, Array, Object });
for (const name of ['encodeRoiPolygon', 'decodeRoiPolygon', 'remapRoiGeometry', 'groupRoiRowsByColor', 'diagBadgeHtml']) {
  vm.runInContext(fn(name), ctx);
}
const plain = x => JSON.parse(JSON.stringify(x));
const vertices = [[-0.5, -0.5], [1.5, -0.5], [1.5, 2.5], [-0.5, 2.5]];
const geometry = { version: 'msi-source-v1', sourceRef: 'source-01',
  displayGeometry: { version: 'msi-proportional-v1', x: { origin: 0.1, step: 1 },
    y: { origin: -10, step: 2 }, W: 2, H: 3 } };
const legacy = { polysBySection: { local: vertices } };
assert.deepEqual(plain(ctx.encodeRoiPolygon(legacy, 'local')), vertices);
const roi = { polysBySection: { local: vertices }, geometryBySection: { local: geometry } };
const wire = plain(ctx.encodeRoiPolygon(roi, 'local'));
// Server JSONB roundtrip, UUID→client ID remap, re-publish and re-import all keep
// the source-coordinate contract paired with exactly the same vertices.
const grouped = ctx.groupRoiRowsByColor([{ id: 'r-uuid', section_id: 's-uuid',
  color_key: 'Red', poly_msi: wire, version: 4 }], {});
assert.deepEqual(plain(grouped[0].polysBySection['s-uuid']), vertices);
assert.deepEqual(plain(grouped[0].geometryBySection['s-uuid']), geometry);
const remapped = ctx.remapRoiGeometry(grouped[0].geometryBySection, { 's-uuid': 'local' });
assert.deepEqual(plain(remapped), { local: geometry });
assert.deepEqual(plain(ctx.encodeRoiPolygon({ polysBySection: { local: vertices }, geometryBySection: remapped }, 'local')), wire);
const both = ctx.groupRoiRowsByColor([
  { id: 'a', section_id: 'old', color_key: 'Red', poly_msi: vertices },
  { id: 'b', section_id: 'new', color_key: 'Red', poly_msi: wire },
], {});
assert.equal(both.length, 1);
assert.equal(both[0].geometryBySection.old, undefined);
assert.deepEqual(plain(both[0].geometryBySection.new), geometry);
const unknown = { version: 'future-coordinate-v9', vertices, geometry };
const decoded = ctx.decodeRoiPolygon(unknown);
assert.deepEqual(plain(decoded.vertices), []);
assert.deepEqual(plain(decoded.geometry.originalPayload), unknown);
assert.equal(ctx.diagBadgeHtml({ clippedHigh: 20, blankCells: 30, blankRows: 2 }), '');
assert.match(ctx.diagBadgeHtml({ dupCells: 1, dupRows: 1 }), /データ詳細/);
assert.doesNotMatch(ctx.diagBadgeHtml({ dupCells: 1, dupRows: 1 }), /⚠ 加工/);
assert.match(ctx.diagBadgeHtml({ quantUnavailable: '<unsafe>' }), /&lt;unsafe&gt;/);
console.log('MSI persistence regression: PASS');
