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
      meta: {raw: {instrument: 'PRIVATE_RAW_SENTINEL', msMethod: 'PRIVATE_METHOD_SENTINEL',
        ce: 137.875, cv: 246.625,
        source: {coneV: '351.3125', msCe: '452.6875', msmsCe: '553.8125', capillaryKv: '0.654321'}},
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
        && App.panels.size === 1, expectedRole, {timeout:60000});
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
    async function assertSharedUnchanged(stage) {
      const after = await page.evaluate(() => {
        const section = App.project.sections[0], panel = App.panels.get(section.id);
        return {projectId: App.project.id, settings: JSON.stringify(section.meta),
          metadata: JSON.stringify(Object.values(section.msiSeries).map(entry => entry.compoundMeta)),
          expected: Object.keys(section.msiSeries).map(key => ({key, mean: msiQuantMean(section.msiSeries[key]),
            max: msiMaxIntensity(section.msiSeries[key]).value, blobId: section.msiSeries[key].blobId,
            storagePath: section.msiSeries[key].storagePath, values: Array.from(panel.msiValueRasters.get(key).values)}))};
      });
      assert.deepEqual(after, before, stage + ' leaves shared source values, settings and metadata unchanged');
      assert.equal(await page.evaluate(() => App.shareMode.role), role, 'PPT export does not change the share role');
    }
    async function openOptions(includeCeCv) {
      await page.locator('#btn-export-ppt').click();
      await page.getByRole('dialog', {name:'PPT レポートの設定', exact:true}).waitFor({state:'visible'});
      const checkbox = page.locator('#project-report-include-ce-cv');
      assert.equal(await checkbox.isChecked(), false, 'Shared Admin CV/CE starts OFF for every export');
      assert.equal(await page.locator('#project-report-master-password').count(), 0, 'Existing Admin login needs no extra master-password input');
      if (includeCeCv) await checkbox.check();
    }
    function assertSharedDeck(deck, includeCeCv) {
      assert.ok(deck.slides.length >= 4, 'Different private CE/CV conditions remain separate molecule details');
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
      if (includeCeCv) {
        for (const marker of voltageMarkers) assert.ok(deck.xml.includes(marker), 'Admin opt-in includes CV/CE: ' + marker);
      } else assertNoVoltages(deck, 'Shared ' + role);
      if (role === 'viewer') {
        for (const marker of [...privateMarkers, ...sourceVoltageMarkers, '0.1234567', '0.654321']) {
          assert.ok(!deck.xml.includes(marker), 'Viewer report does not disclose private metadata: ' + marker);
        }
      } else {
        for (const marker of ['PRIVATE_INSTRUMENT_SENTINEL', 'PRIVATE_METHOD_SENTINEL',
          'PRIVATE_RAW_SENTINEL', 'PRIVATE_SOURCE_SENTINEL', '0.1234567', '0.654321']) {
          assert.ok(deck.xml.includes(marker), 'Admin retains non-voltage acquisition metadata: ' + marker);
        }
        if (includeCeCv) for (const marker of sourceVoltageMarkers) {
          assert.ok(deck.xml.includes(marker), 'Admin opt-in retains RAW acquisition voltage: ' + marker);
        }
      }
      assertNoSessionTokens(deck);
    }
    async function createReport(includeCeCv) {
      const downloadPromise = page.waitForEvent('download', {timeout:90000});
      await page.locator(role === 'viewer' ? '#btn-export-ppt' : '[data-report-create]').click();
      if (role === 'viewer') {
        assert.equal(await page.locator('.project-report-options').count(), 0, 'Viewer exports directly without a settings dialog');
        assert.equal(await page.locator('#project-report-include-ce-cv').count(), 0, 'Viewer is never offered a CV/CE setting');
        assert.equal(await page.locator('#project-report-master-password').count(), 0, 'Viewer is never offered extra authentication');
      }
      const download = await downloadPromise, deck = await readDeck(download);
      await page.evaluate(() => window.__reportTestRun);
      assert.match(download.suggestedFilename(), /\.pptx$/);
      assertSharedDeck(deck, includeCeCv);
      await assertSharedUnchanged('Shared ' + role + ' CV/CE ' + (includeCeCv ? 'ON' : 'OFF'));
      console.log('Shared ' + role + ' CV/CE ' + (includeCeCv ? 'ON' : 'OFF') + ' browser regression passed (' + deck.slides.length + ' slides, ' + deck.bytes.length + ' bytes).');
    }
    if (role === 'viewer') {
      await createReport(false);
      assert.equal(downloadCount, 1, 'The viewer downloads directly without a settings step');
    } else {
      await openOptions(true);
      await page.locator('[data-report-cancel]').click();
      await page.evaluate(() => window.__reportTestRun);
      await page.locator('.project-report-options').waitFor({state:'detached'});
      assert.equal(downloadCount, 0, 'Cancelling Admin settings does not download a report');
      await assertSharedUnchanged('Cancelled Admin export');
      for (const includeCeCv of [false, true, false]) {
        await openOptions(includeCeCv);
        await createReport(includeCeCv);
      }
      assert.equal(downloadCount, 3, 'Admin OFF, ON and next-default-OFF exports download only when requested');
    }
    assert.equal(logins.length, loginCountBeforeExport, 'PPT export never asks for another Admin or master password');
    assert.ok(!traffic.slice(trafficStart).some(item => item.path === '/rest/v1/rpc/unlock_project_master'), 'Shared PPT never invokes master authentication');
    assert.ok(traffic.slice(trafficStart).some(item => item.path === '/rest/v1/rpc/get_project_doc'), 'production shared document read was exercised');
    assert.ok(traffic.slice(trafficStart).some(item => item.path.startsWith('/storage/v1/object/public/')), 'production shared Storage download was exercised');
    assert.deepEqual(external, [], role + ' makes no external request');
    assert.deepEqual(errors, [], role + ' has no browser exceptions');
  } finally { await context.close(); }
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
    let sampleDeck;
    for (const includeCeCv of [false, true]) {
      const checkbox = await openMasterOptions();
      if (includeCeCv) await checkbox.check();
      const downloadPromise = page.waitForEvent('download', {timeout:90000});
      await page.locator('[data-report-create]').click();
      const download = await downloadPromise, deck = await readDeck(download);
      assert.match(download.suggestedFilename(), /\.pptx$/);
      assert.doesNotMatch(download.suggestedFilename(), /[\\/:*?"<>|]/);
      assert.ok(deck.slides.length >= 3, 'Metadata, matrix and molecule detail exist');
      for (const label of ['PPT検証','乳酸テスト','切片A','合成試料','PPT検証用の登録メモ',
        'C3H6O3','0.1234567','MASTER_INSTRUMENT_SENTINEL','MASTER_METHOD_SENTINEL',
        'MASTER_SOURCE_SENTINEL','MASTER_RAW_SENTINEL','0.654321']) {
        assert.ok(deck.xml.includes(label), 'Master export preserves non-voltage metadata: ' + label);
      }
      assert.ok(deck.xml.includes('89 → 43'), 'Master export preserves the precursor/product transition');
      assert.ok(deck.xml.includes('>' + expected.mean + '<'), 'Original-row mean is included');
      assert.ok(deck.xml.includes('>' + expected.max + '<'), 'Original-row maximum is included');
      assert.match(deck.xml, /<a:tbl>/, 'Statistics remain editable native tables');
      assert.ok(Object.keys(deck.zip.files).some(name => /^ppt\/media\/.*\.png$/.test(name)), 'Heatmaps are embedded');
      if (includeCeCv) {
        for (const marker of [...voltageMarkers.slice(0, 2), ...sourceVoltageMarkers]) assert.ok(deck.xml.includes(marker), 'Opt-in includes voltage: ' + marker);
      } else assertNoVoltages(deck, 'Master default export');
      assertNoSessionTokens(deck);
      await assertMasterUnchanged('Master CV/CE ' + (includeCeCv ? 'ON' : 'OFF'));
      await page.waitForFunction(() => !document.getElementById('btn-export-ppt').disabled);
      console.log('Master CV/CE ' + (includeCeCv ? 'ON' : 'OFF') + ' browser regression passed (' + deck.slides.length + ' slides, ' + deck.bytes.length + ' bytes).');
      if (!includeCeCv) sampleDeck = deck;
    }
    // Opting in is per-download; it must not become the next export's default.
    await openMasterOptions();
    await page.locator('[data-report-cancel]').click();
    await page.locator('.project-report-options').waitFor({state:'detached'});
    assert.equal(downloadCount, 2, 'Only explicitly created reports download');
    assert.deepEqual(external, [], 'Works without external connections');
    assert.deepEqual(errors, [], 'No browser exceptions');
    if (process.env.PPT_REPORT_SAMPLE_PATH) await fs.writeFile(process.env.PPT_REPORT_SAMPLE_PATH, sampleDeck.bytes);
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
