'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { chromium } = require('playwright');
const JSZip = require('../vendor/jszip.min.js');
const { renderOfflineConfig } = require('../offline/config.cjs');
const { compareAllReportSections } = require('./report-groups-browser-helpers.cjs');
const root = path.resolve(__dirname, '..');

const sharedSlug = 'synthetic-shared-ppt-report';
const syntheticAdminPassword = 'synthetic-project-admin-password';
const syntheticViewerPassword = 'synthetic-project-viewer-password';
const voltageMarkers = ['137.875', '246.625', '138.875', '247.625'];
const sourceVoltageMarkers = ['351.3125', '452.6875', '553.8125'];
const privateMarkers = [...voltageMarkers,
  'PRIVATE_INSTRUMENT_SENTINEL', 'PRIVATE_METHOD_SENTINEL', 'PRIVATE_RAW_SENTINEL',
  'PRIVATE_SOURCE_SENTINEL', 'PRIVATE_LAYER_SENTINEL'];
function sharedFixture() {
  const sourcePath = 'synthetic/PRIVATE_SOURCE_SENTINEL.csv';
  const rows = ['x,y,signal_A,signal_B'];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) {
    const value = y * 16 + x + 1;
    // Synthetic rounded TXT coordinates intentionally fail the old RAW-only
    // tolerance. Registered 30×60 µm/pixel is authoritative, not inferred from
    // the coordinate spelling or from the 0.030005 source-coordinate step.
    rows.push([(-12.3456 + x * 0.030005).toPrecision(6), (-4.3 + y * 0.03).toPrecision(6), value, value * 2].join(','));
  }
  const series = {};
  for (const [index, column] of ['signal_A', 'signal_B'].entries()) {
    series['MSI_PRIVATE_LAYER_SENTINEL_' + index] = {
      path: sourcePath, mime: 'text/csv', filename: 'PRIVATE_SOURCE_SENTINEL.csv',
      kind: 'txt', sourceFileId: 'synthetic-source', sourceReference: 'synthetic-source-revision',
      x: 'x', y: 'y', v: column, sep: ',', bakeMode: 'full',
      compoundMeta: {base: '共有乳酸', name: '共有乳酸', precursor: 89, product: 43,
        ce: 137.875 + index, cv: 246.625 + index, polarity: '-', formula: 'C3H6O3',
        dwell: 0.1234567, instrument: 'PRIVATE_INSTRUMENT_SENTINEL',
        msMethod: 'PRIVATE_METHOD_SENTINEL', sourceFile: 'PRIVATE_SOURCE_SENTINEL.csv'}
    };
  }
  const source = rows.join('\n') + '\n';
  const secondSourcePath = 'synthetic/PRIVATE_SOURCE_SENTINEL_second.csv';
  const secondSource = [rows[0], ...rows.slice(1).map(row => {
    const cells = row.split(','); cells[2] = Number(cells[2]) * 4; cells[3] = Number(cells[3]) * 4;
    return cells.join(',');
  })].join('\n') + '\n';
  const fixture = {sourcePath, source, sources: {[sourcePath]:source, [secondSourcePath]:secondSource}, doc: {
    id: 'synthetic-shared-project', slug: sharedSlug,
    meta: {display_name: '共有PPT合成プロジェクト', project_meta: {
      colormap: 'hotmetal', msiSmoothing: 'median',
      msiDisplay: {version:2, preset:'custom', aspectMode:'physical', rangePolicy:'maximum',smoothingStrength:6,linearStrength:4},
      memo: {sample: '公開試料メモ', machine: '公開装置メモ', freeNote: '公開解析メモ', experimentDate: '2026-10-28'}
    }},
    anatomy_palette: {}, sections: [{id: 'synthetic-server-section', client_id: 'synthetic-shared-section',
      ordinal: 1, display_name: '共有切片A',
      meta: {raw: {instrument: 'PRIVATE_RAW_SENTINEL', msMethod: 'PRIVATE_METHOD_SENTINEL',
        ce: 137.875, cv: 246.625,
        source: {coneV: '351.3125', msCe: '452.6875', msmsCe: '553.8125', capillaryKv: '0.654321'}},
        displayTransform: {version: 2, baseOrientation: 'native-raster'},
        world_coords: {msi_um_per_px: {x: '30', y: '6e1'}}},
      storage_paths: {images: {}, msiSeries: series}
    }]
  }};
  const second = structuredClone(fixture.doc.sections[0]);
  second.id = 'synthetic-server-section-second'; second.client_id = 'synthetic-shared-section-second';
  second.ordinal = 2; second.display_name = '共有切片B';
  for (const entry of Object.values(second.storage_paths.msiSeries)) {
    entry.path = secondSourcePath; entry.sourceFileId = 'synthetic-source-second';
    entry.sourceReference = 'synthetic-source-second-revision';
  }
  fixture.doc.sections.push(second);
  return fixture;
}

async function readDeck(download) {
  const bytes = await fs.readFile(await download.path()), zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
  const slideXml = await Promise.all(slides.map(name => zip.file(name).async('string')));
  // Inspect every XML part, including notes and relationships; a hidden text
  // field is still disclosed to a recipient who downloads the PowerPoint.
  const xmlFiles = Object.keys(zip.files).filter(name => /\.(xml|rels)$/.test(name));
  const xml = (await Promise.all(xmlFiles.map(name => zip.file(name).async('string')))).join('\n');
  return {bytes, zip, slides, slideXml, xml};
}

function assertImageReportPages(deck, detailCount, context) {
  assert.equal(deck.slides.length, detailCount + 1, context + ' contains only the matrix and molecule details');
  assert.match(deck.slideXml[0], /<p:bg>[\s\S]*?<a:srgbClr val="000000"/, context + ' starts with a black image matrix');
  assert.doesNotMatch(deck.slideXml[0], /<a:tbl>/, context + ' matrix has no information table');
  for (const xml of deck.slideXml.slice(1)) {
    assert.match(xml, /<p:bg>[\s\S]*?<a:srgbClr val="FFFFFF"/, context + ' molecule details have a white background');
    assert.equal((xml.match(/<a:tbl>/g) || []).length, 1, context + ' detail has one editable Max/Mean table');
    assert.match(xml, /Max Intensity/);
    assert.match(xml, /Mean Intensity/);
  }
  assert.doesNotMatch(deck.xml, /Project information/, context + ' omits project information pages');
}

function assertPixelSizeLabels(deck, pitch, context, sectionCount = 1) {
  const value = pitch ? pitch.x + ' × ' + pitch.y + ' µm/px' : null;
  for (const [index, xml] of deck.slideXml.entries()) {
    const label = value ? (index ? 'Pixel size: ' : '') + value : 'Pixel size: —';
    const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
    assert.equal(shapes.filter(shape => shape.includes('<a:t>' + label + '</a:t>')).length, sectionCount,
      context + ' has an editable registered pixel-size label per section on ' + (index ? 'detail ' + index : 'the matrix'));
  }
  if (!pitch) assert.doesNotMatch(deck.xml, /\d(?:\.\d+)?\s*[µμ]m(?:\/px)?/,
    context + ' does not invent numerical physical dimensions or a scale bar for unknown pitch');
}

function assertNativeScaleBars(deck, context, label = '50 µm', physicalWidthUm, sectionCount = 1) {
  const slideSize = deck.xml.match(/<p:sldSz cx="(\d+)" cy="(\d+)"/);
  assert.ok(slideSize, context + ' declares slide dimensions');
  for (const xml of deck.slideXml.slice(1)) {
    // A unit in metadata alone is not a visible scale bar. Require an editable
    // native label paired with a horizontal native rectangle on each detail.
    const shapes = xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) || [];
    const labels = shapes.map((shape, index) => shape.includes('<a:t>' + label + '</a:t>') ? index : -1).filter(index => index >= 0);
    assert.equal(labels.length, sectionCount, context + ' has a calibrated native ' + label + ' label per section image');
    for (const [imageIndex, labelIndex] of labels.entries()) {
      const bar = shapes[labelIndex - 1] || '';
      assert.match(bar, /<a:prstGeom prst="rect"/, context + ' scale is a native editable bar');
      const size = bar.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
      assert.ok(size && Number(size[1]) > Number(size[2]) && Number(size[2]) > 0,
        context + ' scale bar has a nonzero horizontal extent');
      const position = bar.match(/<a:off x="(\d+)" y="(\d+)"/);
      assert.ok(position && Number(position[1]) + Number(size[1]) <= Number(slideSize[1])
        && Number(position[2]) + Number(size[2]) <= Number(slideSize[2]), context + ' scale bar stays inside the slide');
      assert.match(bar, /<a:solidFill><a:srgbClr val="000000"/, context + ' black scale bar is visible on the white detail page');
      if (physicalWidthUm) {
        const pictures = xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) || [];
        assert.equal(pictures.length, sectionCount, context + ' detail contains each calibrated source image');
        const imageSize = pictures[imageIndex].match(/<a:ext cx="(\d+)" cy="(\d+)"/);
        assert.ok(imageSize, context + ' image declares its actual slide dimensions');
        const lengthUm = Number.parseFloat(label) * (label.endsWith(' mm') ? 1000 : 1);
        assert.ok(Math.abs(Number(size[1]) / Number(imageSize[1]) - lengthUm / physicalWidthUm) < 2 / Number(imageSize[1]),
          context + ' native bar/image ratio equals labelled distance / registered physical image width');
      }
    }
  }
}

function assertImageAspect(deck, ratio, context) {
  for (const xml of deck.slideXml.slice(1)) for (const picture of xml.match(/<p:pic>[\s\S]*?<\/p:pic>/g) || []) {
    const size = picture.match(/<a:ext cx="(\d+)" cy="(\d+)"/);
    assert.ok(size && Math.abs(Number(size[1]) / Number(size[2]) - ratio) < 0.002,
      context + ' image aspect uses registered physical pitch, not raster columns / rows');
  }
}

async function installReportObservation(page) {
  await page.evaluate(async () => {
    await loadScript((window.LAZY_LIBS || {}).projectReportDeck || 'project-report-deck.js');
    const originalDeck = window.ProjectReportDeck;
    window.ProjectReportDeck = {...originalDeck, async create(report, options) {
      window.__reportTestModel = {displayStyle:report.displayStyle, molecules:report.molecules.map(molecule => ({
        upper:molecule.upper, intensityScale:molecule.intensityScale, outputScales:molecule.outputScales,
        sections:molecule.sections.map(section => ({sectionId:section.sectionId, displayWindow:section.displayWindow,
          width:section.image && section.image.width, height:section.image && section.image.height,
          physicalWidthUm:section.image && section.image.physicalWidthUm,
          physicalHeightUm:section.image && section.image.physicalHeightUm}))}))};
      return originalDeck.create(report, options);
    }};
  });
}

async function installReportLoadGate(page) {
  await page.evaluate(() => {
    const panel = App.panels.get(App.project.sections[0].id), original = panel.ensureMsiLayerLoaded;
    window.__reportGateEntered = false;
    panel.ensureMsiLayerLoaded = async function (...args) {
      panel.ensureMsiLayerLoaded = original;
      window.__reportGateEntered = true;
      await new Promise(resolve => {window.__releaseReportGate = resolve;});
      return original.apply(this, args);
    };
  });
}

async function checkRoiPhysicalComparison(page) {
  const result = await page.evaluate(async () => {
    await loadScript('roi-media-msi.js'); await loadScript('roi-media-app.js');
    const project = App.project, section = project.sections[0], key = Object.keys(section.msiSeries)[0];
    const saved = project.rois, polygon = [[1,1],[3,1],[3,3],[1,3]], source = msiLayerSourceGeometry(section,key);
    const roi = {id:'synthetic-physical-comparison',polysBySection:{[section.id]:polygon},
      geometryBySection:{[section.id]:{version:'msi-source-v1',sourceRef:msiSourceReference(section.msiSeries[key]),
        displayGeometry:structuredClone(source.displayGeometry)}}};
    project.rois = [...(saved || []),roi];
    try {
      const adapter = RoiMediaApp.createAdapter(project,roi), frame = await adapter.loadMsi(project,roi,section.id,key);
      const canvas = document.createElement('canvas'), rendered = RoiMediaMsi.draw(canvas,frame,{width:400,height:400,mode:'whole'});
      const matrix = rendered.imageMatrix;
      return {sourceBounds:frame.physicalFrame.sourceBoundsUm,
        expected:polygon.map(([x,y])=>[matrix[0][0]*(x+.5)+matrix[0][1]*(y+.5)+matrix[0][2],
          matrix[1][0]*(x+.5)+matrix[1][1]*(y+.5)+matrix[1][2]]),
        actual:rendered.screenPolygon,bar:rendered.scaleBar,
        pitch:frame.pixelPitch,matrix,smoothing:frame.smoothing,smoothingStrength:frame.smoothingStrength,linearStrength:frame.linearStrength};
    } finally {project.rois=saved;}
  });
  assert.deepEqual(result.sourceBounds,{x:0,y:0,width:480,height:480},'The real ROI comparison adapter preserves the registered physical footprint');
  assert.equal(result.smoothing,'median');assert.equal(result.smoothingStrength,6,'ROI comparison captures shared smoothing through browser globals');
  assert.equal(result.linearStrength,4,'ROI comparison retains the independent Linear setting');
  for (let i=0;i<result.expected.length;i++) for (let axis=0;axis<2;axis++)
    assert.ok(Math.abs(result.expected[i][axis]-result.actual[i][axis])<1e-9,'ROI overlay uses one half-pixel centre correction');
  assert.ok(result.bar && result.bar.pixels>0 && result.bar.length>0);
  const matrix=result.matrix,det=matrix[0][0]*matrix[1][1]-matrix[0][1]*matrix[1][0];
  const umPerPixel=Math.hypot(matrix[1][1]*result.pitch.x/det,matrix[1][0]*result.pitch.y/det);
  assert.ok(Math.abs(result.bar.length/result.bar.pixels-umPerPixel)<1e-9,'ROI comparison ruler consumes physical pitch once');
  console.log('ROI physical comparison adapter, source footprint, overlay centre and scale bar browser regression passed.');
}

async function sharedSourceSnapshot(load) {
  const expected = [];
  for (const section of App.project.sections) {
    const panel = App.panels.get(section.id);
    for (const key of Object.keys(section.msiSeries)) {
      if (load && !await panel.ensureMsiLayerLoaded(key)) throw new Error('Shared synthetic numeric source failed to load');
      const entry = section.msiSeries[key], raster = panel.msiValueRasters.get(key);
      const record = await ProjectStorage.getBlob(entry.blobId);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer())),
        byte => byte.toString(16).padStart(2, '0')).join('');
      expected.push({sectionId:section.id, key, mean: msiQuantMean(entry), max: msiMaxIntensity(entry).value,
        blobId: entry.blobId, storagePath: entry.storagePath, sourceHash: hash,
        width: raster.W, height: raster.H, pitch: msiDisplayPhysicalPitch(section, key),
        sourceGeometry: JSON.stringify(raster.sourceGeometry), values: Array.from(raster.values)});
    }
  }
  return {expected, projectId: App.project.id, settings: JSON.stringify(App.project.sections.map(section=>section.meta)),
    rois: JSON.stringify(App.project.rois),
    metadata: JSON.stringify(App.project.sections.flatMap(section=>Object.values(section.msiSeries).map(entry => entry.compoundMeta)))};
}

function assertNoVoltages(deck, context) {
  for (const marker of [...voltageMarkers, ...sourceVoltageMarkers]) assert.ok(!deck.xml.includes(marker), context + ' does not disclose CV/CE value ' + marker);
  assert.doesNotMatch(deck.xml, /<a:t>\s*(?:CE|CV|Cone Voltage|Collision Energy)\s*<\/a:t>|\b(?:CE|CV)\s+(?:137|246)/i,
    context + ' omits CV/CE labels and subtitles');
}

function assertNoSessionTokens(deck) {
  for (const token of ['synthetic-viewer-token', 'synthetic-admin-token', 'synthetic-test-anon-key',
    syntheticAdminPassword, syntheticViewerPassword]) {
    assert.ok(!deck.xml.includes(token), 'password, session token or service key is never embedded');
  }
}

async function checkSharedReport(browser, origin, role, traffic, logins) {
  const context = await browser.newContext({viewport: {width: 1920, height: 1080}});
  try {
    const page = await context.newPage(), errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/') || /^(blob|data):/.test(route.request().url())) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    // Both paths start as viewers. The admin case must use the real Admin
    // button, unlock_project RPC, session cache and reload before exporting.
    await page.addInitScript(({slug}) => {
      const key = 'desi:share:' + slug;
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key,
        JSON.stringify({slug, role:'viewer', token:'synthetic-viewer-token',
          expiresAt:new Date(Date.now() + 3600000).toISOString(), isPublic:false}));
    }, {slug:sharedSlug});
    const trafficStart = traffic.length, loginStart = logins.length;
    await page.goto(origin + '/viewer/#share=' + sharedSlug);
    async function waitForSharedRole(expectedRole) {
      await page.waitForFunction(expected => typeof App !== 'undefined' && !App.offline
        && App.project && App.project.__share && App.shareMode && App.shareMode.role === expected
        && App.panels.size === 2, expectedRole, {timeout:60000});
      await page.waitForFunction(() => typeof SharePreview !== 'undefined' && SharePreview.isOpen(), undefined, {timeout:30000});
      await page.locator('[data-preview-close]').click();
      await page.locator('#btn-export-ppt').waitFor({state:'visible'});
    }
    await waitForSharedRole('viewer');
    if (role === 'admin') {
      await page.locator('#btn-share-admin-login').click();
      await page.getByLabel('Admin password', {exact:true}).fill(syntheticViewerPassword);
      await page.locator('[data-modal-ok]').click();
      await page.getByText('Admin password ではありません (viewer pass を入力したようです)', {exact:true}).waitFor({state:'visible'});
      assert.equal(await page.evaluate(() => App.shareMode.role), 'viewer', 'A viewer password cannot elevate the session');
      assert.equal(await page.evaluate(slug => JSON.parse(sessionStorage.getItem('desi:share:' + slug)).role, sharedSlug), 'viewer',
        'Rejected elevation does not replace the cached viewer session');
      await page.locator('#btn-share-admin-login').click();
      await page.getByLabel('Admin password', {exact:true}).fill(syntheticAdminPassword);
      const reload = page.waitForEvent('load');
      await page.locator('[data-modal-ok]').click();
      await reload;
      await waitForSharedRole('admin');
      assert.equal(await page.evaluate(slug => JSON.parse(sessionStorage.getItem('desi:share:' + slug)).role, sharedSlug), 'admin',
        'The production Admin login persists its session across reload');
      assert.equal(logins.length, loginStart + 2, 'Viewer-password rejection and Admin login use unlock_project');
      assert.deepEqual(logins.slice(loginStart).map(login => login.password), [syntheticViewerPassword, syntheticAdminPassword]);
      for (const login of logins.slice(loginStart)) assert.equal(login.slug, sharedSlug, 'Admin login targets the current shared project');
    }
    const loginCountBeforeExport = logins.length;
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('share-admin')), role === 'admin');
    const ceVisibility = await page.locator('#method-table th[data-sort-key="ce"]').evaluate(el => getComputedStyle(el).display);
    assert.equal(ceVisibility === 'none', role === 'viewer', 'screen measurement-condition visibility matches the session role');

    // Decode before the invariant snapshot; exporting must not alter original
    // bytes, the rounded coordinate geometry, numerical values or calibration.
    const before = await page.evaluate(sharedSourceSnapshot, true);
    assert.deepEqual(before.expected.map(entry => [entry.mean, entry.max]), [[64.5, 128], [129, 256], [258, 512], [516, 1024]],
      'shared Storage CSV is parsed into authoritative source-row statistics');
    for (const entry of before.expected) {
      assert.deepEqual([entry.width, entry.height], [16, 8], 'Rounded TXT retains its measured raster dimensions');
      assert.deepEqual(entry.pitch, {x: 30, y: 60}, 'Registered numeric strings are normalized without coordinate inference');
    }
    if (role === 'viewer') {
      await checkRoiPhysicalComparison(page);
      assert.deepEqual(await page.evaluate(sharedSourceSnapshot,false),before,'ROI comparison preserves source data and stored ROI state');
    }
    let downloadCount = 0;
    page.on('download', () => downloadCount++);
    // Track completion without replacing authentication or generation behavior.
    await page.evaluate(() => {
      const original = ProjectReportApp.exportCurrent;
      ProjectReportApp.exportCurrent = function (...args) {
        const result = original.apply(this, args);
        window.__reportTestRun = result;
        return result;
      };
    });
    await installReportObservation(page);
    async function assertSharedUnchanged(stage) {
      const after = await page.evaluate(sharedSourceSnapshot, false);
      assert.deepEqual(after, before, stage + ' leaves shared source values, settings and metadata unchanged');
      assert.equal(await page.evaluate(() => App.shareMode.role), role, 'PPT export does not change the share role');
    }
    async function openOptions(includeCeCv, useDisplayStyle = false) {
      await page.locator('#btn-export-ppt').click();
      await page.getByRole('dialog', {name:'PPT レポートの設定', exact:true}).waitFor({state:'visible'});
      await compareAllReportSections(page);
      const checkbox = page.locator('#project-report-include-ce-cv');
      const style = page.locator('#project-report-use-display-style');
      assert.equal(await style.isChecked(), false, 'Display-style mode starts OFF for every shared export');
      if (role === 'viewer') assert.equal(await checkbox.count(), 0, 'Viewer is never offered CV/CE');
      else assert.equal(await checkbox.isChecked(), false, 'Shared Admin CV/CE starts OFF for every export');
      assert.equal(await page.locator('#project-report-master-password').count(), 0, 'Existing Admin login needs no extra master-password input');
      if (includeCeCv) await checkbox.check();
      if (useDisplayStyle) await style.check();
    }
    function assertSharedDeck(deck, includeCeCv) {
      assertImageReportPages(deck, 2, 'Shared ' + role);
      assertPixelSizeLabels(deck, {x:30,y:60}, 'Shared ' + role + ' normalizes registered numeric strings', 2);
      assertNativeScaleBars(deck, 'Shared ' + role, '100 µm', 16 * 30, 2);
      assertImageAspect(deck, 1, 'Shared ' + role + ' 30×60 µm');
      for (const label of ['共有PPT合成プロジェクト', '共有乳酸', '共有切片A', '共有切片B']) {
        assert.ok(deck.xml.includes(label), role + ' includes public registered label: ' + label);
      }
      assert.ok(deck.xml.includes('89 → 43'), role + ' retains the public precursor/product transition');
      assert.ok(deck.xml.includes('C3H6O3'), role + ' retains the public molecular formula');
      for (const entry of before.expected) {
        assert.ok(deck.xml.includes('>' + entry.mean + '<'), role + ' retains original-row mean');
        assert.ok(deck.xml.includes('>' + entry.max + '<'), role + ' retains original-row maximum');
      }
      assert.match(deck.xml, /<a:tbl>/, role + ' contains editable quantitative tables');
      assert.ok(Object.keys(deck.zip.files).some(name => /^ppt\/media\/.*\.png$/.test(name)), role + ' contains numeric heatmaps');
      if (includeCeCv) {
        for (const [index, xml] of deck.slideXml.slice(1).entries()) {
          assert.ok(xml.includes('CE ' + voltageMarkers[index * 2]), 'Admin opt-in includes transition CE in the detail subtitle');
          assert.ok(xml.includes('CV ' + voltageMarkers[index * 2 + 1]), 'Admin opt-in includes transition CV in the detail subtitle');
        }
      } else assertNoVoltages(deck, 'Shared ' + role);
      for (const marker of ['公開試料メモ', '公開装置メモ', '公開解析メモ', ...privateMarkers.slice(voltageMarkers.length),
        ...sourceVoltageMarkers, '0.654321']) {
        assert.ok(!deck.xml.includes(marker), 'Image report omits Memo and detailed acquisition metadata: ' + marker);
      }
      assert.equal(deck.xml.includes('0.1234567'), role === 'admin', 'Dwell remains in authorized transition subtitles only');
      assertNoSessionTokens(deck);
    }
    async function createReport(includeCeCv, useDisplayStyle = false, mutateAfterStart = false) {
      if (mutateAfterStart) await installReportLoadGate(page);
      const downloadPromise = page.waitForEvent('download', {timeout:90000});
      await page.locator('[data-report-create]').click();
      if (mutateAfterStart) {
        await page.waitForFunction(() => window.__reportGateEntered);
        await page.evaluate(() => {
          window.__reportRestoreDisplay = {meta:structuredClone(App.project.meta), mode:App.msiScaleMode,
            pitches:App.project.sections.map(section=>structuredClone(section.meta.world_coords))};
          App.project.meta.colormap = 'viridis'; App.project.meta.msiSmoothing = 'linear';
          App.project.meta.msiDisplay = {...App.project.meta.msiDisplay, rangePolicy:'percentile', aspectMode:'legacy',smoothingStrength:3,linearStrength:9};
          App.msiScaleMode = 'individual';
          for (const section of App.project.sections) section.meta.world_coords.msi_um_per_px = {x:90,y:90};
          window.__releaseReportGate();
        });
      }
      const download = await downloadPromise, deck = await readDeck(download);
      await page.evaluate(() => window.__reportTestRun);
      if (mutateAfterStart) await page.evaluate(() => {
        const saved = window.__reportRestoreDisplay;
        App.project.meta = saved.meta; App.msiScaleMode = saved.mode;
        App.project.sections.forEach((section,index)=>{section.meta.world_coords=saved.pitches[index];});
        delete window.__reportRestoreDisplay;
      });
      assert.match(download.suggestedFilename(), /\.pptx$/);
      assertSharedDeck(deck, includeCeCv);
      const report = await page.evaluate(() => window.__reportTestModel);
      assert.equal(report.molecules.length, 2, 'Both measured molecular transitions are exported');
      for (const [index, molecule] of report.molecules.entries()) {
        assert.equal(molecule.sections.length, 2, 'Both output sections contribute to every molecule');
        const maximum = 512 * (index + 1);
        const scales=Object.values(molecule.outputScales);
        assert.equal(scales.length,1,'The requested comparison group has one automatic scale');
        assert.equal(molecule.intensityScale.basis,'group-automatic');
        if (useDisplayStyle) {
          assert.equal(report.displayStyle.mode, 'same', 'Viewer mode is captured; the explicit comparison group controls its automatic range');
          assert.equal(report.displayStyle.rangePolicy, 'maximum');
          assert.equal(report.displayStyle.colormap, 'hotmetal');
          assert.equal(report.displayStyle.smoothing, 'median');
          assert.equal(report.displayStyle.smoothingStrength,6,'PPT retains strength captured before asynchronous settings changes');
          assert.equal(report.displayStyle.linearStrength,4,'PPT retains the independent Linear strength');
          assert.match(deck.xml,/median \(strength 6\/10\)/);
          assert.equal(scales[0].max,maximum,'Display-style comparison uses its captured automatic maximum');
          assert.deepEqual(molecule.sections.map(section => section.displayWindow),
            [{min:0,max:maximum},{min:0,max:maximum}], 'Same includes the stronger second section without mixing molecules');
        } else {
          assert.equal(scales[0].upperBasis, 'percentile', 'OFF retains p99.8 within its comparison group');
          assert.equal(scales[0].max,scales[0].percentileValue);
          assert.ok(molecule.upper > 0 && molecule.upper < maximum, 'Legacy p99.8 does not silently become maximum');
        }
        for (const section of molecule.sections) {
          assert.ok(Math.abs(section.width / section.height - 1) < 0.002, 'Embedded pixels preserve the 30×60 physical aspect');
          assert.ok(Math.abs(section.physicalWidthUm - 480) < 1e-6);
          assert.ok(Math.abs(section.physicalHeightUm - 480) < 1e-6);
        }
      }
      await assertSharedUnchanged('Shared ' + role + ' CV/CE ' + (includeCeCv ? 'ON' : 'OFF'));
      if (role === 'viewer' && process.env.PPT_REPORT_SHARED_SAMPLE_PATH) {
        await fs.writeFile(process.env.PPT_REPORT_SHARED_SAMPLE_PATH, deck.bytes);
      }
      console.log('Shared ' + role + ' CV/CE ' + (includeCeCv ? 'ON' : 'OFF') + ', display style '
        + (useDisplayStyle ? 'ON' : 'OFF') + ' browser regression passed (' + deck.slides.length + ' slides, ' + deck.bytes.length + ' bytes).');
    }
    await openOptions(role === 'admin', true);
    await page.locator('[data-report-cancel]').click();
    await page.evaluate(() => window.__reportTestRun);
    await page.locator('.project-report-options').waitFor({state:'detached'});
    assert.equal(downloadCount, 0, 'Cancelling shared settings does not download a report');
    await assertSharedUnchanged('Cancelled shared export');
    await openOptions(false, true);
    await installReportLoadGate(page);
    await page.locator('[data-report-create]').click();
    await page.waitForFunction(() => window.__reportGateEntered);
    await page.getByRole('dialog', {name:'PPT レポートを作成',exact:true}).getByRole('button', {name:'中止',exact:true}).click();
    await page.evaluate(() => window.__releaseReportGate());
    await page.evaluate(() => window.__reportTestRun);
    await page.locator('.project-report-progress').waitFor({state:'detached'});
    assert.equal(downloadCount, 0, 'Cancelling an active display-style export never downloads a partial deck');
    await assertSharedUnchanged('Cancelled running display-style export');
    for (const [includeCeCv, useDisplayStyle] of [[false,false],[role === 'admin',true],[false,false]]) {
      await openOptions(includeCeCv, useDisplayStyle);
      await createReport(includeCeCv, useDisplayStyle, useDisplayStyle);
    }
    assert.equal(downloadCount, 3, 'OFF, ON and next-default-OFF exports download only when requested');
    assert.equal(logins.length, loginCountBeforeExport, 'PPT export never asks for another Admin or master password');
    assert.ok(!traffic.slice(trafficStart).some(item => item.path === '/rest/v1/rpc/unlock_project_master'), 'Shared PPT never invokes master authentication');
    assert.ok(traffic.slice(trafficStart).some(item => item.path === '/rest/v1/rpc/get_project_doc'), 'production shared document read was exercised');
    assert.ok(traffic.slice(trafficStart).some(item => item.path.startsWith('/storage/v1/object/public/')), 'production shared Storage download was exercised');
    assert.deepEqual(external, [], role + ' makes no external request');
    assert.deepEqual(errors, [], role + ' has no browser exceptions');
  } finally { await context.close(); }
}

async function checkManualPixelCalibration(page) {
  const projectId = await page.evaluate(async () => {
    const section = App.project.sections[0], key = Object.keys(section.msiSeries)[0];
    App.setActiveSection(section.id); App.setFocusCompoundKey(key);
    if (!await App.panels.get(section.id).ensureMsiLayerLoaded(key)) throw new Error('Calibration fixture source unavailable');
    return App.project.id;
  });
  const invariant = snapshot => ({expected:snapshot.expected.map(({pitch, ...entry})=>entry),
    rois:snapshot.rois, metadata:snapshot.metadata});
  const before = invariant(await page.evaluate(sharedSourceSnapshot, true));
  const exported = async (pitch, stage) => {
    await page.locator('#btn-export-ppt').click();
    await page.getByRole('dialog', {name:'PPT レポートの設定',exact:true}).waitFor({state:'visible'});
    const downloadPromise = page.waitForEvent('download', {timeout:90000});
    await page.locator('[data-report-create]').click();
    const deck = await readDeck(await downloadPromise);
    assertPixelSizeLabels(deck, {x:pitch,y:pitch}, stage);
    assertNoSessionTokens(deck);
    await page.waitForFunction(() => !document.getElementById('btn-export-ppt').disabled);
  };
  const displayed = async (pitch, preview) => {
    await page.waitForFunction(({pitch,preview}) => {
      const panel = App.panels.get(App.project.sections[0].id);
      const bar = preview ? document.querySelector('#share-preview-overlay [data-cell-scalebar]') : panel.dom.scalebar;
      const caption = preview ? document.querySelector('#share-preview-overlay .cell-title') : panel.dom.label;
      return bar && getComputedStyle(bar).display !== 'none' && bar.getBoundingClientRect().width > 0
        && caption && caption.textContent.includes(pitch+'×'+pitch+' μm/px');
    },{pitch,preview});
    return page.evaluate(preview => {
      const panel = App.panels.get(App.project.sections[0].id);
      const bar = preview ? document.querySelector('#share-preview-overlay [data-cell-scalebar]') : panel.dom.scalebar;
      const line = bar.querySelector('.bar'), text = bar.querySelector('.label').textContent;
      const lengthUm = Number.parseFloat(text) * (/mm$/.test(text) ? 1000 : 1);
      const width = line.getBoundingClientRect().width;
      const rect = bar.getBoundingClientRect(), host = (preview ? bar.parentElement : panel.dom.host).getBoundingClientRect();
      return {lengthUm,width,umPerScreenPixel:lengthUm/width,inside:rect.left>=host.left-1 && rect.right<=host.right+1
        && rect.top>=host.top-1 && rect.bottom<=host.bottom+1};
    },preview);
  };
  let previous;
  for (const pitch of [30,60]) {
    await page.locator('#tb-msi-um').click();
    await page.getByRole('heading',{name:'MSI pixel size (μm/px)',exact:true}).waitFor({state:'visible'});
    await page.locator('input[name="x"]').fill(String(pitch));
    await page.locator('input[name="y"]').fill(String(pitch));
    await page.locator('[data-modal-ok]').click();
    const main = await displayed(pitch,false);
    await page.locator('#btn-share-preview').click();
    const preview = await displayed(pitch,true);
    for (const view of [main,preview]) {
      assert.ok(view.lengthUm>0 && view.width>0 && view.inside,'Manual calibration draws a visible bar inside its viewport');
    }
    if (previous) for (const name of ['main','preview']) {
      const value = name==='main' ? main : preview;
      assert.ok(Math.abs(value.umPerScreenPixel/previous[name].umPerScreenPixel-2)<0.002,
        name+' ruler reflects 30 → 60 µm without changing image zoom');
    }
    previous = {main,preview};
    await page.locator('[data-preview-close]').click();
    const saved = await page.evaluate(async () => {
      if (await App._flushSave()===false) throw new Error('Calibration save failed');
      return (await ProjectStorage.getProject(App.project.id)).sections[0].meta.world_coords.msi_um_per_px;
    });
    assert.deepEqual(saved,{x:pitch,y:pitch},'Manual modal persists its calibration in real IndexedDB');
    await exported(pitch, 'Manual ' + pitch + ' µm calibration');
    assert.deepEqual(invariant(await page.evaluate(sharedSourceSnapshot,false)),before,
      'Manual calibration, Preview and PPT preserve original SHA-256, coordinates, intensities, ROI and statistics');
  }
  await page.reload();
  await page.waitForFunction(id => typeof App!=='undefined' && App.project && App.project.id===id && App.panels.size>0,projectId);
  await page.evaluate(async () => {
    const section=App.project.sections[0],key=Object.keys(section.msiSeries)[0];
    App.setActiveSection(section.id); App.setFocusCompoundKey(key);
    if (!await App.panels.get(section.id).ensureMsiLayerLoaded(key)) throw new Error('Reloaded calibration source unavailable');
  });
  await displayed(60,false);
  await page.locator('#btn-share-preview').click();
  await displayed(60,true);
  await page.locator('[data-preview-close]').click();
  await exported(60, 'Reloaded manual 60 µm calibration');
  assert.deepEqual(invariant(await page.evaluate(sharedSourceSnapshot,true)),before,
    'Reload and PPT keep the original bytes, source geometry, ROI and source-row statistics');
  console.log('Manual pixel calibration browser regression passed (30 → 60 µm, main/Preview/PPT, IndexedDB save and reload).');
}

// The real viewer, parsers, IndexedDB and download flow run with synthetic data
// in an isolated browser context. No account or external service is contacted.
async function main() {
  const fixture = sharedFixture(), traffic = [], forbidden = [];
  const logins = [];
  let serveOnlineConfig = false;
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      traffic.push({path: pathname, method: req.method});
      if (pathname === '/runtime-config.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(serveOnlineConfig ? "Object.defineProperty(window,'DESI_BUILD_CONFIG',{value:Object.freeze({mode:'online',cloud:{url:"
          + JSON.stringify('http://' + req.headers.host) + ",anonKey:'synthetic-test-anon-key'}}),writable:false,configurable:false});" : renderOfflineConfig());
        return;
      }
      if (req.method === 'POST' && pathname.startsWith('/rest/v1/rpc/')) {
        const rpc = pathname.slice('/rest/v1/rpc/'.length);
        if (rpc === 'unlock_project') {
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          logins.push({slug:body.p_slug, password:body.p_password});
          res.setHeader('Content-Type', 'application/json');
          const role = body.p_password === syntheticAdminPassword ? 'admin'
            : body.p_password === syntheticViewerPassword ? 'viewer' : null;
          if (!role || body.p_slug !== sharedSlug) {
            res.writeHead(401); res.end(JSON.stringify({code:'28P01', message:'invalid credentials'})); return;
          }
          res.end(JSON.stringify([{token:'synthetic-' + role + '-token', role,
            expires_at:new Date(Date.now() + 3600000).toISOString()}])); return;
        }
        const readOnly = new Set(['get_project_doc', 'list_rois', 'list_share_overlays', 'list_share_alignments', 'list_share_images']);
        if (!readOnly.has(rpc)) { forbidden.push({method: req.method, path: pathname}); res.writeHead(403); res.end('Unexpected write or RPC'); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(rpc === 'get_project_doc' ? fixture.doc : [])); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        forbidden.push({method: req.method, path: pathname}); res.writeHead(405); res.end('Read only fixture server'); return;
      }
      const fixturePath = pathname.slice('/storage/v1/object/public/atlases/'.length);
      if (pathname.startsWith('/storage/v1/object/public/atlases/') && Object.hasOwn(fixture.sources, fixturePath)) {
        res.setHeader('Content-Type', 'text/csv'); res.end(fixture.sources[fixturePath]); return;
      }
      const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
      res.setHeader('Content-Type', ({ '.js':'text/javascript', '.mjs':'text/javascript', '.html':'text/html; charset=utf-8', '.css':'text/css' })[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch (_) { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined});
    const page = await browser.newPage({viewport:{width:1920,height:1080}});
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/') || /^(blob|data):/.test(route.request().url())) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    // A missing explicit project keeps the real viewer's Import ZIP path open.
    await page.goto(origin + '/viewer/?project=report-test-empty');
    await page.waitForFunction(() => typeof App !== 'undefined' && App.offline && typeof ProjectReportApp !== 'undefined').catch(async error => {
      console.error({errors,external,state:await page.evaluate(()=>({url:location.href,app:typeof App,offline:window.DESI_OFFLINE,report:typeof ProjectReportApp,text:document.body.innerText.slice(0,1000)}))});
      throw error;
    });
    await page.locator('#hidden-import-input').setInputFiles(path.join(root,'tests/fixtures/browser/offline-smoke-project.zip'));
    // The real import now reviews archive completeness/provenance before writing.
    await page.getByRole('button', {name:'復元 / Restore', exact:true}).click();
    await page.waitForFunction(() => App.project && App.project.displayName === 'Offline smoke fixture' && App.panels.size > 0);
    // Initial visibility is restored without writing project metadata. Finish
    // the selected image loads and auto-Otsu before checking export invariance.
    await page.waitForFunction(() => App.project.sections.every(section => {
      const panel=App.panels.get(section.id);
      return App._otsuIsFresh(section)&&panel?._initialStatePrepared&&panel.requestedLayerKeys().every(key=>
        /^MSI_/i.test(key)?panel.isMsiLayerReady(key):panel.isImageLayerReady(key));
    }));
    if (process.env.PPT_REPORT_CALIBRATION_ONLY === '1') {
      await checkManualPixelCalibration(page);
      assert.deepEqual(external,[],'Manual calibration needs no external connection');
      assert.deepEqual(errors,[],'Manual calibration and reload have no browser exceptions');
      return;
    }
    const expected = await page.evaluate(async () => {
      const project = App.project, section = project.sections[0];
      project.displayName = 'PPT検証 / project';
      project.memo = {sample:'合成試料',machine:'DESI',experimentDate:'2026-10-28',freeNote:'PPT検証用の登録メモ'};
      section.displayName = '切片A';
      const key = Object.keys(section.msiSeries)[0], ent = section.msiSeries[key];
      ent.compoundMeta = {base:'乳酸テスト',name:'乳酸テスト',precursor:89,product:43,
        ce:137.875,cv:246.625,polarity:'-',formula:'C3H6O3',dwell:0.1234567,
        instrument:'MASTER_INSTRUMENT_SENTINEL',msMethod:'MASTER_METHOD_SENTINEL',sourceFile:'MASTER_SOURCE_SENTINEL.csv'};
      section.meta.raw = {instrument:'MASTER_RAW_SENTINEL',ce:137.875,cv:246.625,
        msMethod:'MASTER_METHOD_SENTINEL',source:{coneV:'351.3125',msCe:'452.6875',msmsCe:'553.8125',capillaryKv:'0.654321'}};
      const panel = App.panels.get(section.id);
      if (!await panel.ensureMsiLayerLoaded(key)) throw new Error('Fixture MSI failed to load');
      return {mean:msiQuantMean(ent),max:msiMaxIntensity(ent).value,source:ent.blobId,
        settings:JSON.stringify(section.meta),metadata:JSON.stringify(ent.compoundMeta),
        values:Array.from(panel.msiValueRasters.get(key).values)};
    });
    assert.equal(typeof expected.mean, 'number'); assert.equal(typeof expected.max, 'number');
    let downloadCount = 0;
    page.on('download', () => downloadCount++);
    async function assertMasterUnchanged(stage) {
      const after = await page.evaluate(() => {
        const section = App.project.sections[0], key = Object.keys(section.msiSeries)[0], ent = section.msiSeries[key];
        return {mean:msiQuantMean(ent),max:msiMaxIntensity(ent).value,source:ent.blobId,
          settings:JSON.stringify(section.meta),metadata:JSON.stringify(ent.compoundMeta),
          values:Array.from(App.panels.get(section.id).msiValueRasters.get(key).values)};
      });
      assert.deepEqual(after, expected, stage + ' leaves numerical data, statistics and registered metadata unchanged');
    }
    async function openMasterOptions() {
      await page.locator('#btn-export-ppt').click();
      await page.getByRole('dialog', {name:'PPT レポートの設定', exact:true}).waitFor({state:'visible'});
      const checkbox = page.locator('#project-report-include-ce-cv');
      assert.equal(await checkbox.isChecked(), false, 'CV/CE starts OFF for every export');
      assert.equal(await page.locator('#project-report-use-display-style').isChecked(), false, 'Display style starts OFF for every local export');
      assert.equal(await page.locator('#project-report-master-password').isVisible(), false, 'Local master export does not request a share master password');
      return checkbox;
    }
    // Dismissing the preflight must not start generation or remember a checked
    // value. The following successful export also catches a stuck active run.
    await (await openMasterOptions()).check();
    await page.locator('[data-report-cancel]').click();
    await page.locator('.project-report-options').waitFor({state:'detached'});
    await page.waitForFunction(() => !document.getElementById('btn-export-ppt').disabled);
    assert.equal(downloadCount, 0, 'Cancelling the options dialog does not download a report');
    assert.equal(await page.locator('.project-report-progress').count(), 0, 'Cancelling does not begin generation');
    await assertMasterUnchanged('Cancelled export');
    // A page can outlive a deployment. Cached or late-loaded modules from a
    // different revision must stop before preparing images or downloading a
    // file, and the next export must remain usable after the page is repaired.
    for (const moduleName of ['ProjectReportData', 'ProjectReportDeck']) {
      await page.evaluate(async name => {
        for (const lib of ['projectReportData', 'projectReportDeck']) await loadScript(LAZY_LIBS[lib]);
        window.revisionOriginalModule = window[name];
        window.revisionOriginalToast = showToast;
        window.revisionMessages = [];
        window.revisionWorkStarted = false;
        showToast = message => window.revisionMessages.push(message);
        window[name] = {...window[name], REPORT_REVISION: 'previous-report',
          prepare() { window.revisionWorkStarted = true; throw new Error('Unexpected preparation'); },
          create() { window.revisionWorkStarted = true; throw new Error('Unexpected generation'); }};
      }, moduleName);
      await openMasterOptions();
      await page.locator('[data-report-create]').click();
      await page.waitForFunction(() => window.revisionMessages.some(message => /再読み込み/.test(message))
        && !document.getElementById('btn-export-ppt').disabled && !document.querySelector('.project-report-progress'));
      assert.equal(downloadCount, 0, 'Mismatched ' + moduleName + ' does not download a report');
      assert.equal(await page.evaluate(() => window.revisionWorkStarted), false, 'Version mismatch stops before report work');
      await assertMasterUnchanged('Mismatched ' + moduleName);
      await page.evaluate(name => {
        window[name] = window.revisionOriginalModule;
        showToast = window.revisionOriginalToast;
        delete window.revisionOriginalModule; delete window.revisionOriginalToast;
      }, moduleName);
    }
    let sampleDeck;
    for (const [includeCeCv, calibrated] of [[false, false], [true, false], [false, true]]) {
      if (calibrated) {
        // This is an explicit fixture setup change, not part of exporting.
        // Keep the new registered setting in the subsequent invariance check.
        expected.settings = await page.evaluate(() => {
          const section = App.project.sections[0];
          section.meta.world_coords = {...section.meta.world_coords, msi_um_per_px:{x:50,y:50}};
          return JSON.stringify(section.meta);
        });
      }
      const checkbox = await openMasterOptions();
      if (includeCeCv) await checkbox.check();
      const downloadPromise = page.waitForEvent('download', {timeout:90000});
      await page.locator('[data-report-create]').click();
      const download = await downloadPromise, deck = await readDeck(download);
      assert.match(download.suggestedFilename(), /\.pptx$/);
      assert.doesNotMatch(download.suggestedFilename(), /[\\/:*?"<>|]/);
      assertImageReportPages(deck, 1, 'Master');
      assertPixelSizeLabels(deck, calibrated ? {x:50,y:50} : null, 'Master ' + (calibrated ? '50 µm' : 'unknown pitch'));
      if (calibrated) assertNativeScaleBars(deck, 'Master 50 µm calibration');
      for (const label of ['PPT検証','乳酸テスト','切片A','C3H6O3','0.1234567']) {
        assert.ok(deck.xml.includes(label), 'Master export preserves registered image labels: ' + label);
      }
      for (const label of ['合成試料','PPT検証用の登録メモ',
        'MASTER_INSTRUMENT_SENTINEL','MASTER_METHOD_SENTINEL','MASTER_SOURCE_SENTINEL','MASTER_RAW_SENTINEL',
        '0.654321', ...sourceVoltageMarkers]) {
        assert.ok(!deck.xml.includes(label), 'Image report omits Memo and detailed acquisition metadata: ' + label);
      }
      assert.ok(deck.xml.includes('89 → 43'), 'Master export preserves the precursor/product transition');
      assert.ok(deck.xml.includes('>' + expected.mean + '<'), 'Original-row mean is included');
      assert.ok(deck.xml.includes('>' + expected.max + '<'), 'Original-row maximum is included');
      assert.match(deck.xml, /<a:tbl>/, 'Statistics remain editable native tables');
      assert.ok(Object.keys(deck.zip.files).some(name => /^ppt\/media\/.*\.png$/.test(name)), 'Heatmaps are embedded');
      if (includeCeCv) {
        assert.ok(deck.slideXml[1].includes('CE ' + voltageMarkers[0]), 'Opt-in includes transition CE in the detail subtitle');
        assert.ok(deck.slideXml[1].includes('CV ' + voltageMarkers[1]), 'Opt-in includes transition CV in the detail subtitle');
      } else assertNoVoltages(deck, 'Master default export');
      assertNoSessionTokens(deck);
      await assertMasterUnchanged('Master CV/CE ' + (includeCeCv ? 'ON' : 'OFF'));
      await page.waitForFunction(() => !document.getElementById('btn-export-ppt').disabled);
      console.log('Master CV/CE ' + (includeCeCv ? 'ON' : 'OFF') + ', ' + (calibrated ? '50 µm' : 'unknown pitch')
        + ' browser regression passed (' + deck.slides.length + ' slides, ' + deck.bytes.length + ' bytes).');
      if (!includeCeCv) sampleDeck = deck;
    }
    // Opting in is per-download; it must not become the next export's default.
    await openMasterOptions();
    await page.locator('[data-report-cancel]').click();
    await page.locator('.project-report-options').waitFor({state:'detached'});
    assert.equal(downloadCount, 3, 'Only explicitly created reports download');
    assert.deepEqual(external, [], 'Works without external connections');
    assert.deepEqual(errors, [], 'No browser exceptions');
    if (process.env.PPT_REPORT_SAMPLE_PATH) await fs.writeFile(process.env.PPT_REPORT_SAMPLE_PATH, sampleDeck.bytes);
    await checkManualPixelCalibration(page);
    assert.deepEqual(external, [], 'Manual calibration and reload remain offline');
    assert.deepEqual(errors, [], 'Manual calibration and reload introduce no browser exception');
    await page.close();
    serveOnlineConfig = true;
    assert.equal(logins.length, 0, 'Local master options do not authenticate again');
    await checkSharedReport(browser, origin, 'viewer', traffic, logins);
    await checkSharedReport(browser, origin, 'admin', traffic, logins);
    assert.ok(!traffic.some(item => item.path === '/rest/v1/rpc/unlock_project_master'), 'No PPT path invokes the master authentication RPC');
    assert.deepEqual(forbidden, [], 'PPT export invokes only read and authentication RPCs and never writes project data');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error.stack || error); process.exitCode=1;});
