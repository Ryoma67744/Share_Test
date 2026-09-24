'use strict';
// Production SVG renderer + production pointer handlers; do not replace either
// with a drawing stub. Screen expectations are calculated independently from
// the known fixture CSS transform, not from the method under test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtime, html } = require('./viewer-runtime.cjs');
const { element, geometryGlobals, roiDom, svgPoints, svgMarkup } = require('./roi-dom.cjs');

const close = (actual, expected, label) => {
  assert.equal(actual.length, expected.length, label);
  actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-8,
    `${label}: ${actual} != ${expected}`));
};
const plain = value => JSON.parse(JSON.stringify(value));
const source = { sourceRef: 'source-A', displayGeometry: {
  version: 'msi-proportional-v1', W: 7, H: 3,
  x: { origin: 0, step: .2 }, y: { origin: 0, step: .75 },
} };
let showRois = true, finalizations = 0, notices = 0, nextFrame = 1;
const pendingFrames = new Map();
const app = { drawing: { mode: false }, activeRoiId: 'selected',
  finalizeDrawing() { finalizations++; } };
const context = runtime({
  ...geometryGlobals, App: app,
  document: { createElementNS: (_ns, tag) => element(tag),
    getElementById: id => id === 'roi-toggle' ? { checked: showRois } : null },
  msiLayerSourceGeometry: section => section._source,
  showToast() { notices++; },
  requestAnimationFrame(callback) { const id = nextFrame++; pendingFrames.set(id, callback); return id; },
  cancelAnimationFrame(id) { pendingFrames.delete(id); },
});

function fixture(scale = 1, angle = 0, lr = false, ud = false) {
  const sec = { id: 'section', _source: plain(source), msiSeries: { MSI_A: {} }, meta: {
    displayTransform: { version: 2, baseOrientation: 'native-raster' },
    viewerTransform: { rot: angle + 90, rotMSI: 23, scale, tx: 11.25, ty: -17.125 },
    flip: { lr, ud }, world_coords: { msi_um_per_px: { x: 10, y: 30 } },
  } };
  const frame = context.sectionCanvasFrame(sec, 6, 14, false);
  const rad = angle * Math.PI / 180, a = Math.cos(rad) * scale, b = Math.sin(rad) * scale;
  const rect = { left: 19.375, top: 72.125, width: 280.625, height: 480.375 };
  const css = { left: '35.125px', top: '18.375px', width: '210.4px', height: '420.75px' };
  const dom = roiDom(frame.width, frame.height, { rect, css,
    transform: `matrix(${a},${b},${-b},${a},11.25,-17.125)` });
  dom.cdisp = { width: frame.width, height: frame.height };
  const vertices = [[.4, .8], [6.1, 2.6], [2.2, 1.1]];
  const project = { rois: [
    { id: 'normal', rgba: [255, 0, 0, 255], polysBySection: { section: vertices } },
    { id: 'selected', rgba: [0, 128, 255, 255], polysBySection: { section: vertices } },
    { id: 'hidden', polysBySection: { section: vertices } },
    { id: 'elsewhere', polysBySection: { other: vertices } },
  ], roiHidden: { hidden: true } };
  const panel = Object.assign(Object.create(context.Panel.prototype), {
    section: sec, project, dom, _displayCanvasFrame: frame,
    roiCtx: { clearRect() {} }, _pickRefMsiKey: () => 'MSI_A',
    getMsiRefSize: () => ({ w: 7, h: 3 }),
  });
  // Reconstruct CSS rotate + scale + translate about the fixture host center.
  const expectedScreen = (canvasX, canvasY) => {
    const x = canvasX / frame.width * 210.4 + 35.125 - rect.width / 2;
    const y = canvasY / frame.height * 420.75 + 18.375 - rect.height / 2;
    return [rect.left + rect.width / 2 + a * x - b * y + 11.25,
      rect.top + rect.height / 2 + b * x + a * y - 17.125];
  };
  return { panel, project, vertices, rect, frame, expectedScreen };
}

let combinations = 0;
for (const scale of [.2, 1, 5, 8]) for (const angle of [0, 37, 90, 180])
for (const lr of [false, true]) for (const ud of [false, true]) {
  const { panel, project, vertices, rect, expectedScreen } = fixture(scale, angle, lr, ud);
  const before = JSON.stringify(project);
  app.drawing = { mode: true, sectionId: 'section', sourceGeometry: plain(source), vertices: plain(vertices) };
  panel.drawAllRois('selected');
  const saved = panel.dom.roiSaved.children, preview = panel.dom.roiPreview;
  assert.equal(saved.length, 2, 'hidden and absent-section ROIs are skipped');
  assert.equal(saved[0].getAttribute('stroke-width'), '1');
  assert.equal(saved[1].getAttribute('stroke-width'), '2');
  for (const polygon of saved) assert.equal(polygon.getAttribute('fill'), 'none');
  const line = preview.querySelectorAll('polyline')[0], rings = preview.querySelectorAll('circle').filter(node => node.getAttribute('fill') === 'none');
  assert.equal(line.getAttribute('stroke-width'), '1.5');
  assert.equal(line.getAttribute('stroke-dasharray'), '4 3');
  assert.equal(rings.length, vertices.length);
  for (const ring of rings) {
    assert.equal(ring.getAttribute('fill'), 'none', 'target remains visible inside the ring');
    assert.equal(Number(ring.getAttribute('r')) * 2 + Number(ring.getAttribute('stroke-width')), 6,
      'outer diameter includes the stroke and stays at six screen pixels');
    assert.equal(ring.getAttribute('stroke-width'), '1');
  }
  const canvasT = panel._msiRoiCanvasMatrix();
  vertices.forEach(([mx, my], i) => {
    const canvas = context.applyAffinePoint(canvasT, mx, my);
    const expected = expectedScreen(...canvas);
    close(panel.canvasToClient(...canvas), expected, 'forward CSS projection');
    close(panel.clientToCanvas(...expected), canvas, 'inverse CSS projection');
    close(panel.canvasToMsi(...panel.clientToCanvas(...expected)), [mx, my], 'full sample-centre roundtrip');
    const overlay = [expected[0] - rect.left, expected[1] - rect.top];
    close(svgPoints(saved[0])[i], overlay, 'saved SVG matches displayed image');
    close(svgPoints(line)[i], overlay, 'preview SVG matches displayed image');
    close([+rings[i].getAttribute('cx'), +rings[i].getAttribute('cy')], overlay, 'ring is centred on clicked point');
  });
  panel.attachDrawingHandlers();
  const first = expectedScreen(...context.applyAffinePoint(canvasT, ...vertices[0]));
  for (const distance of [7, 9, 20]) {
    app.drawing.vertices = plain(vertices);
    const count = finalizations, desired = [first[0] + distance, first[1]];
    panel.dom.croi.listeners.click({ clientX: desired[0], clientY: desired[1] });
    assert.equal(finalizations - count, distance === 7 ? 1 : 0, `close hit distance ${distance} at scale ${scale}`);
    assert.equal(app.drawing.vertices.length, distance === 7 ? 3 : 4);
    if (distance !== 7) {
      const added = app.drawing.vertices[3];
      close(expectedScreen(...context.applyAffinePoint(canvasT, ...added)), desired, 'new vertex at actual mouse position');
    }
  }
  assert.equal(JSON.stringify(project), before, 'display/unfinished clicks do not change saved ROI coordinates');
  combinations++;
}

// The canvas is laid out in an integer-sized rot container even when its host
// has fractional DOM bounds. A noncentral transform origin must be respected.
{
  const { panel, rect } = fixture(5, 37, true, true);
  Object.assign(panel.dom.rot.style, { width: '280px', height: '480px' });
  Object.assign(panel.dom.rot, { _transformOrigin: '70px 300px', offsetLeft: 3, offsetTop: 4 });
  Object.assign(panel.dom.host, { clientLeft: 1, clientTop: 2 });
  const r = 37 * Math.PI / 180, a = 5 * Math.cos(r), b = 5 * Math.sin(r);
  for (const [cx, cy] of [[0, 0], [1.3, 2.7], [panel.dom.croi.width, panel.dom.croi.height]]) {
    const x = cx / panel.dom.croi.width * 210.4 + 35.125 - 70;
    const y = cy / panel.dom.croi.height * 420.75 + 18.375 - 300;
    const expected = [rect.left + 4 + 70 + a * x - b * y + 11.25,
      rect.top + 6 + 300 + b * x + a * y - 17.125];
    close(panel.canvasToClient(cx, cy), expected, 'actual noncentral origin and rot container');
    close(panel.clientToCanvas(...expected), [cx, cy], 'fractional host/integer rot inverse');
  }
  panel.dom.rot._transformOrigin = '25% 62.5%';
  const expected = panel.canvasToClient(1.3, 2.7);
  panel.dom.rot._transformOrigin = '70px 300px';
  close(panel.canvasToClient(1.3, 2.7), expected, 'percent and px origins match rot size');
  app.drawing = { mode: false };
  panel.drawAllRois();
  assert.equal(panel.dom.roiSaved.children[1].getAttribute('stroke-width'), '2', 'default redraw preserves active ROI highlight');
}

// Source mismatch hides preview and rejects both append and double-click. A
// hidden saved overlay must still permit a valid pending drawing to be seen.
{
  const { panel, vertices } = fixture(5, 37, true, false);
  app.drawing = { mode: true, sectionId: 'section', sourceGeometry: plain(source), vertices: plain(vertices) };
  showRois = false; panel.drawAllRois();
  assert.equal(panel.dom.roiSaved.children.length, 0);
  assert.equal(panel.dom.roiPreview.querySelectorAll('circle').filter(node => node.getAttribute('fill') === 'none').length, 3);
  panel.attachDrawingHandlers();
  panel.section._source.sourceRef = 'another-source';
  panel.drawAllRois();
  assert.equal(panel.dom.roiPreview.children.length, 0, 'old preview is removed after source change');
  const count = finalizations, before = plain(app.drawing.vertices);
  panel.dom.croi.listeners.click({ clientX: 100, clientY: 100 });
  panel.dom.croi.listeners.dblclick({ preventDefault() {} });
  assert.deepEqual(plain(app.drawing.vertices), before); assert.equal(finalizations, count);
  assert.ok(notices >= 2, 'source guards notify the user');
  panel.section._source = plain(source); app.drawing.sectionId = 'elsewhere'; panel.drawAllRois();
  assert.equal(panel.dom.roiPreview.children.length, 0);
  app.drawing.sectionId = 'section';
  let prevented = false;
  panel.dom.croi.listeners.dblclick({ preventDefault() { prevented = true; } });
  assert.ok(prevented); assert.equal(finalizations, count + 1);
  app.drawing.mode = false; panel.drawAllRois(); assert.equal(panel.dom.roiPreview.children.length, 0);
  showRois = true;
}

// Zoom redraws should coalesce and must not survive removal of a section.
{
  const { panel } = fixture();
  let draws = 0;
  panel.drawAllRois = () => { draws++; };
  panel._saveViewerSession = () => {};
  panel.updateScaleBar = () => {};
  panel.applyViewerTransform(); panel.applyViewerTransform(); panel.applyViewerTransform();
  assert.equal(pendingFrames.size, 1, 'one overlay redraw per animation frame');
  const frame = [...pendingFrames.entries()][0]; pendingFrames.delete(frame[0]); frame[1]();
  assert.equal(draws, 1);
  panel.applyViewerTransform();
  assert.equal(pendingFrames.size, 1);
  panel.destroy();
  assert.equal(pendingFrames.size, 0, 'destroy cancels pending overlay redraw');
}

async function svgPixels() {
  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const { panel } = fixture();
  panel.dom = { ...roiDom(100, 100), cdisp: { width: 100, height: 100 } };
  panel._msiRoiCanvasMatrix = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  app.drawing = { mode: true, sectionId: 'section', sourceGeometry: plain(source),
    // Cross a nonincident vertex to prove all line segments are excluded from
    // marker cores, not just adjacent endpoint segments.
    vertices: [[20, 20], [80, 20], [50, 20], [50, 80]] };
  panel.drawDrawingPreview();
  const previewSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100">${svgMarkup(panel.dom.roiPreview)}</svg>`);
  const previewImage = await loadImage(previewSvg), previewCanvas = createCanvas(100, 100);
  const previewCtx = previewCanvas.getContext('2d'); previewCtx.drawImage(previewImage, 0, 0);
  const pixels = previewCtx.getImageData(0, 0, 100, 100).data;
  for (const [cx, cy] of app.drawing.vertices) {
    for (let y = cy - 1; y < cy + 1; y++) for (let x = cx - 1; x < cx + 1; x++)
      assert.equal(pixels[(y * 100 + x) * 4 + 3], 0, 'combined preview line and rings leave central 2x2px transparent');
    const ringAlpha = pixels[((cy - 3) * 100 + cx) * 4 + 3];
    assert.ok(ringAlpha > 0, 'hollow marker still has a visible rim');
  }
  const svg = fs.readFileSync(path.join(__dirname, '../viewer/roi-cursor.svg'));
  const image = await loadImage(svg), canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, image.width, image.height).data;
  const cx = image.width / 2, cy = image.height / 2;
  for (let y = cy - 1; y < cy + 1; y++) for (let x = cx - 1; x < cx + 1; x++)
    assert.equal(data[(y * image.width + x) * 4 + 3], 0, 'central two-by-two pixels are transparent');
  let count = 0, maxAlpha = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i]) {
      count++;
      const pixel = (i - 3) / 4, x = pixel % image.width, y = Math.floor(pixel / image.width);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    maxAlpha = Math.max(maxAlpha, data[i]);
  }
  assert.ok(count > 0, 'cursor arms are visible');
  assert.ok(maxAlpha <= 180, 'cursor remains approximately 70 percent opaque');
  assert.deepEqual([maxX - minX + 1, maxY - minY + 1], [10, 10], 'cursor visible extent is ten pixels');
  assert.match(html, /roi-cursor\.svg/);
  panel.setDrawingPointerActive(true);
  assert.equal(panel.dom.croi.style.pointerEvents, 'auto');
  assert.ok(panel.dom.croi.style.cursor.includes('roi-cursor.svg'));
  assert.match(panel.dom.croi.style.cursor, /6\s+6,/, 'cursor hotspot is its transparent center');
  panel.setDrawingPointerActive(false);
  assert.equal(panel.dom.croi.style.pointerEvents, 'none');
  assert.equal(panel.dom.croi.style.cursor, '');
}

svgPixels().then(() => console.log(`ROI screen overlay regression: PASS (${combinations} zoom/rotation/flip cases, screen hit tests, source guards, combined preview/cursor pixels)`))
  .catch(error => { console.error(error); process.exitCode = 1; });
