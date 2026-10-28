'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { chromium } = require('playwright');
const JSZip = require('../vendor/jszip.min.js');
const { renderOfflineConfig } = require('../offline/config.cjs');
const root = path.resolve(__dirname, '..');

const sharedSlug = 'synthetic-shared-ppt-report';
const privateMarkers = ['137.875', '246.625', '138.875', '247.625',
  'PRIVATE_INSTRUMENT_SENTINEL', 'PRIVATE_METHOD_SENTINEL', 'PRIVATE_RAW_SENTINEL',
  'PRIVATE_SOURCE_SENTINEL', 'PRIVATE_LAYER_SENTINEL'];
function sharedFixture() {
  const sourcePath = 'synthetic/PRIVATE_SOURCE_SENTINEL.csv';
  const rows = ['x,y,signal_A,signal_B'];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const value = y * 8 + x + 1;
    rows.push([x, y, value, value * 2].join(','));
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
  return {sourcePath, source: rows.join('\n') + '\n', doc: {
    id: 'synthetic-shared-project', slug: sharedSlug,
    meta: {display_name: '共有PPT合成プロジェクト', project_meta: {
      colormap: 'plasma', msiSmoothing: 'none',
      memo: {sample: '公開試料メモ', machine: '公開装置メモ', freeNote: '公開解析メモ', experimentDate: '2026-10-28'}
    }},
    anatomy_palette: {}, sections: [{id: 'synthetic-server-section', client_id: 'synthetic-shared-section',
      ordinal: 1, display_name: '共有切片A',
      meta: {raw: {instrument: 'PRIVATE_RAW_SENTINEL', msMethod: 'PRIVATE_METHOD_SENTINEL'},
        world_coords: {msi_um_per_px: {x: 50, y: 50}}},
      storage_paths: {images: {}, msiSeries: series}
    }]
  }};
}

async function readDeck(download) {
  const bytes = await fs.readFile(await download.path()), zip = await JSZip.loadAsync(bytes);
  const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  // Inspect every XML part, including notes and relationships; a hidden text
  // field is still disclosed to a recipient who downloads the PowerPoint.
  const xmlFiles = Object.keys(zip.files).filter(name => /\.(xml|rels)$/.test(name));
  const xml = (await Promise.all(xmlFiles.map(name => zip.file(name).async('string')))).join('\n');
  return {bytes, zip, slides, xml};
}

async function checkSharedReport(browser, origin, role, traffic) {
  const context = await browser.newContext({viewport: {width: 1920, height: 1080}});
  try {
    const page = await context.newPage(), errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await context.route('**/*', route => {
      if (route.request().url().startsWith(origin + '/') || /^(blob|data):/.test(route.request().url())) return route.continue();
      external.push(route.request().url()); return route.abort();
    });
    // A deliberately synthetic session exercises the production shared-view
    // bootstrap and hydration without passwords, accounts, or token services.
    await page.addInitScript(({slug, sessionRole}) => sessionStorage.setItem('desi:share:' + slug,
      JSON.stringify({slug, role: sessionRole, token: 'synthetic-' + sessionRole + '-token',
        expiresAt: new Date(Date.now() + 3600000).toISOString(), isPublic: false})), {slug: sharedSlug, sessionRole: role});
    const trafficStart = traffic.length;
    await page.goto(origin + '/viewer/#share=' + sharedSlug);
    await page.waitForFunction(expectedRole => typeof App !== 'undefined' && !App.offline
      && App.project && App.project.__share && App.shareMode && App.shareMode.role === expectedRole
      && App.panels.size === 1, role, {timeout: 60000});
    await page.waitForFunction(() => typeof SharePreview !== 'undefined' && SharePreview.isOpen(), undefined, {timeout: 30000});
    await page.locator('[data-preview-close]').click();
    await page.locator('#btn-export-ppt').waitFor({state: 'visible'});
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('share-admin')), role === 'admin');
    const ceVisibility = await page.locator('#method-table th[data-sort-key="ce"]').evaluate(el => getComputedStyle(el).display);
    assert.equal(ceVisibility === 'none', role === 'viewer', 'screen measurement-condition visibility matches the session role');

    const before = await page.evaluate(async () => {
      const section = App.project.sections[0], panel = App.panels.get(section.id);
      const expected = [];
      for (const key of Object.keys(section.msiSeries)) {
        if (!await panel.ensureMsiLayerLoaded(key)) throw new Error('Shared synthetic numeric source failed to load');
        const entry = section.msiSeries[key], raster = panel.msiValueRasters.get(key);
        expected.push({key, mean: msiQuantMean(entry), max: msiMaxIntensity(entry).value,
          blobId: entry.blobId, storagePath: entry.storagePath, values: Array.from(raster.values)});
      }
      // Wait for the parser's decode completion before taking the invariant
      // snapshot. Export must not write the shared project or its source.
      return {expected, projectId: App.project.id, settings: JSON.stringify(section.meta),
        metadata: JSON.stringify(Object.values(section.msiSeries).map(entry => entry.compoundMeta))};
    });
    assert.deepEqual(before.expected.map(entry => [entry.mean, entry.max]), [[32.5, 64], [65, 128]],
      'shared Storage CSV is parsed into authoritative source-row statistics');
    const downloadPromise = page.waitForEvent('download', {timeout: 90000});
    await page.locator('#btn-export-ppt').click();
    const download = await downloadPromise, deck = await readDeck(download);
    assert.match(download.suggestedFilename(), /\.pptx$/);
    assert.ok(deck.slides.length >= 4, 'different private CE/CV conditions remain separate molecule details');
    for (const label of ['共有PPT合成プロジェクト', '共有乳酸', '共有切片A', '公開試料メモ', '公開装置メモ', '公開解析メモ']) {
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
    if (role === 'viewer') {
      for (const marker of [...privateMarkers, '0.1234567']) assert.ok(!deck.xml.includes(marker), 'viewer PPT does not disclose ' + marker);
      assert.doesNotMatch(deck.xml, /CE 137|CV 246/, 'viewer detail subtitles omit machine conditions');
    } else {
      for (const marker of ['137.875', '246.625', 'PRIVATE_INSTRUMENT_SENTINEL', 'PRIVATE_METHOD_SENTINEL',
        'PRIVATE_RAW_SENTINEL', 'PRIVATE_SOURCE_SENTINEL']) {
        assert.ok(deck.xml.includes(marker), 'admin PPT includes registered acquisition metadata: ' + marker);
      }
    }
    for (const token of ['synthetic-viewer-token', 'synthetic-admin-token']) assert.ok(!deck.xml.includes(token), 'session token is never embedded');
    const after = await page.evaluate(() => {
      const section = App.project.sections[0], panel = App.panels.get(section.id);
      return {projectId: App.project.id, settings: JSON.stringify(section.meta),
        metadata: JSON.stringify(Object.values(section.msiSeries).map(entry => entry.compoundMeta)),
        expected: Object.keys(section.msiSeries).map(key => ({key, mean: msiQuantMean(section.msiSeries[key]),
          max: msiMaxIntensity(section.msiSeries[key]).value, blobId: section.msiSeries[key].blobId,
          storagePath: section.msiSeries[key].storagePath, values: Array.from(panel.msiValueRasters.get(key).values)}))};
    });
    assert.deepEqual(after, before, role + ' report leaves shared source values, settings and metadata unchanged');
    assert.ok(traffic.slice(trafficStart).some(item => item.path === '/rest/v1/rpc/get_project_doc'), 'production shared document read was exercised');
    assert.ok(traffic.slice(trafficStart).some(item => item.path.startsWith('/storage/v1/object/public/')), 'production shared Storage download was exercised');
    assert.deepEqual(external, [], role + ' makes no external request');
    assert.deepEqual(errors, [], role + ' has no browser exceptions');
    console.log('Shared ' + role + ' report browser regression passed (' + deck.slides.length + ' slides, ' + deck.bytes.length + ' bytes).');
  } finally { await context.close(); }
}

// The real viewer, parsers, IndexedDB and download flow run with synthetic data
// in an isolated browser context. No account or external service is contacted.
async function main() {
  const fixture = sharedFixture(), traffic = [], forbidden = [];
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
        const readOnly = new Set(['get_project_doc', 'list_rois', 'list_share_overlays', 'list_share_alignments', 'list_share_images']);
        if (!readOnly.has(rpc)) { forbidden.push({method: req.method, path: pathname}); res.writeHead(403); res.end('Unexpected write or RPC'); return; }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(rpc === 'get_project_doc' ? fixture.doc : [])); return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        forbidden.push({method: req.method, path: pathname}); res.writeHead(405); res.end('Read only fixture server'); return;
      }
      if (pathname === '/storage/v1/object/public/atlases/' + fixture.sourcePath) {
        res.setHeader('Content-Type', 'text/csv'); res.end(fixture.source); return;
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
    await page.waitForFunction(() => App.project && App.project.displayName === 'Offline smoke fixture' && App.panels.size > 0);
    // Import populates visible layers and auto-Otsu asynchronously. Finish
    // those unrelated initial derivations before checking export invariance.
    await page.waitForFunction(() => App.project.sections.every(section => App._otsuIsFresh(section) && Array.isArray(section.meta.visibleLayers)));
    const expected = await page.evaluate(async () => {
      const project = App.project, section = project.sections[0];
      project.displayName = 'PPT検証 / project';
      project.memo = {sample:'合成試料',machine:'DESI',experimentDate:'2026-10-28',freeNote:'PPT検証用の登録メモ'};
      section.displayName = '切片A';
      const key = Object.keys(section.msiSeries)[0], ent = section.msiSeries[key];
      ent.compoundMeta = {base:'乳酸テスト',name:'乳酸テスト',precursor:89,product:43,ce:11,cv:20,polarity:'-'};
      const panel = App.panels.get(section.id);
      if (!await panel.ensureMsiLayerLoaded(key)) throw new Error('Fixture MSI failed to load');
      return {mean:msiQuantMean(ent),max:msiMaxIntensity(ent).value,source:ent.blobId,
        settings:JSON.stringify(section.meta),values:Array.from(panel.msiValueRasters.get(key).values)};
    });
    assert.equal(typeof expected.mean, 'number'); assert.equal(typeof expected.max, 'number');
    const downloadPromise = page.waitForEvent('download', {timeout:90000});
    await page.locator('#btn-export-ppt').click();
    const download = await downloadPromise;
    assert.match(download.suggestedFilename(), /\.pptx$/);
    assert.doesNotMatch(download.suggestedFilename(), /[\\/:*?"<>|]/);
    const bytes = await fs.readFile(await download.path()), zip = await JSZip.loadAsync(bytes);
    const slides = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    assert.ok(slides.length >= 3, 'Metadata, matrix and molecule detail exist');
    const xml = (await Promise.all(slides.map(name => zip.file(name).async('string')))).join('\n');
    for (const label of ['PPT検証','乳酸テスト','切片A','合成試料','PPT検証用の登録メモ']) assert.ok(xml.includes(label), label);
    assert.ok(xml.includes('>' + expected.mean + '<'), 'Original-row mean is included');
    assert.ok(xml.includes('>' + expected.max + '<'), 'Original-row maximum is included');
    assert.match(xml, /<a:tbl>/, 'Statistics remain editable native tables');
    assert.ok(Object.keys(zip.files).some(name => /^ppt\/media\/.*\.png$/.test(name)), 'Heatmaps are embedded');
    const after = await page.evaluate(() => {
      const section = App.project.sections[0], key=Object.keys(section.msiSeries)[0];
      return {source:section.msiSeries[key].blobId,settings:JSON.stringify(section.meta),
        values:Array.from(App.panels.get(section.id).msiValueRasters.get(key).values)};
    });
    assert.equal(after.source, expected.source); assert.equal(after.settings, expected.settings);
    assert.deepEqual(after.values,expected.values, 'Report generation leaves numerical data unchanged');
    assert.deepEqual(external, [], 'Works without external connections');
    assert.deepEqual(errors, [], 'No browser exceptions');
    if (process.env.PPT_REPORT_SAMPLE_PATH) await fs.writeFile(process.env.PPT_REPORT_SAMPLE_PATH, bytes);
    console.log('Project report browser regression passed (' + slides.length + ' slides, ' + bytes.length + ' bytes).');
    await page.close();
    serveOnlineConfig = true;
    await checkSharedReport(browser, origin, 'viewer', traffic);
    await checkSharedReport(browser, origin, 'admin', traffic);
    assert.deepEqual(forbidden, [], 'PPT export never writes to the server or invokes a non-read-only RPC');
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error.stack || error); process.exitCode=1;});
