// Offline self-consistency test (no network). Verifies the ported parsing /
// grid / ROI-extraction / stats produce the expected numbers, so we can trust
// they match the web app. Run: `npm run selftest`.
import * as XLSX from 'xlsx';
import {
  a1ColToIndex, pointInPolygon, buildMsiGrid,
  parseXlsxToRows, parseTxtToRows, extractRoiValues, stats,
} from './msi.js';

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

console.log('');
if (failures) { console.log('SELFTEST FAILED:', failures, 'check(s)'); process.exit(1); }
console.log('SELFTEST PASSED');
