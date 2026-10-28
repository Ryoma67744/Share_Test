'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const { chromium } = require('playwright');
const JSZip = require('../vendor/jszip.min.js');
const { renderOfflineConfig } = require('../offline/config.cjs');
const root = path.resolve(__dirname, '..');

// The real viewer, parsers, IndexedDB and download flow run with synthetic data
// in an isolated browser context. No account or external service is contacted.
async function main() {
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/runtime-config.js') {
        res.setHeader('Content-Type', 'text/javascript'); res.end(renderOfflineConfig()); return;
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
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections(); await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error.stack || error); process.exitCode=1;});
