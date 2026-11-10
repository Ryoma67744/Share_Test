'use strict';
// Real viewer, source parser, ROI geometry, Range editors and Preview. All HTTP
// traffic is confined to this synthetic fixture; unexpected writes are rejected.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createServer} = require('node:http');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const slug = 'synthetic-roi-range';

function fixture() {
  const sources = {};
  const sections = [1, 2].map((factor, index) => {
    const sourcePath = 'synthetic/roi-range-' + index + '.csv';
    const rows = ['x,y,signal'];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const value = x === 15 && y === 15 ? 1000 : x === 0 && y === 0 ? 5 : 1 + (x + y) % 10;
      rows.push([x, y, value * factor].join(','));
    }
    // One measured coordinate has two independent measurements. The original
    // maximum is 95, while its displayed raster value is their average, 50.
    rows.push([0, 0, 95 * factor].join(','));
    sources[sourcePath] = rows.join('\n') + '\n';
    return {id:'roi-server-' + index, client_id:'roi-section-' + index,
      ordinal:index + 1, display_name:'ROI synthetic ' + index,
      meta:{displayTransform:{version:2, baseOrientation:'native-raster'},
        world_coords:{msi_um_per_px:{x:30, y:30}}},
      storage_paths:{images:{}, msiSeries:{MSI_A:{path:sourcePath, mime:'text/csv',
        filename:'roi-range-' + index + '.csv', kind:'txt', sourceFileId:'roi-source-' + index,
        sourceReference:'roi-source-revision-' + index, x:'x', y:'y', v:'signal', sep:',',
        bakeMode:'full', compoundMeta:{base:'Synthetic ROI', precursor:89, product:43}}}}};
  });
  return {sources, doc:{id:'shared-roi-range', slug,
    meta:{display_name:'ROI Range fixture', project_meta:{colormap:'hotmetal', msiSmoothing:'none',
      msiDisplay:{version:2, preset:'hdi', aspectMode:'physical', rangePolicy:'maximum',
        smoothingStrength:1, linearStrength:10}}}, sections, anatomy_palette:{}}};
}

async function ranges(page) {
  return page.evaluate(() => App.project.sections.map(section => {
    const entry = section.msiSeries.MSI_A;
    return App.getMsiWindow('MSI_A', entry.rawRange, entry.rawDispMax, entry.rawTrueMax, section);
  }));
}
async function settled(page) {
  await page.evaluate(async () => {
    if (App.roiOnlyMode) await Promise.all(App.project.sections.map(section => App.ensureRoiDisplayRange(section, 'MSI_A')));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}
async function expectMaxima(page, expected, message) {
  await settled(page);
  assert.deepEqual((await ranges(page)).map(window => window.max), expected, message);
}
async function sourceSnapshot(page) {
  return page.evaluate(async () => {
    const out = [];
    for (const section of App.project.sections) {
      const entry = section.msiSeries.MSI_A, panel = App.panels.get(section.id);
      const raster = panel.msiValueRasters.get('MSI_A');
      const record = await ProjectStorage.getBlob(entry.blobId);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await record.blob.arrayBuffer())),
        value => value.toString(16).padStart(2, '0')).join('');
      const original = window.__originalRangeRoi;
      const quant = await extractRoiRawFromSection(panel, 'MSI_A', original.polysBySection[section.id], original);
      out.push({id:section.id, hash, values:Array.from(raster.values), sourceGeometry:raster.sourceGeometry,
        statistics:{mean:msiQuantMean(entry), max:msiMaxIntensity(entry).value,
          rawRange:entry.rawRange, rawDispMax:entry.rawDispMax, sourceStats:entry.sourceStats},
        roi:{values:quant.values, rowIds:quant.rowIds, stats:calcStats(quant.values)}});
    }
    return out;
  });
}
async function sampleRenderedLayer(page) {
  return page.evaluate(() => {
    const panel = App.panels.get(App.project.sections[0].id);
    const cached = panel._msiLutCache.get('MSI_A');
    const raster = panel.msiValueRasters.get('MSI_A');
    const index = Array.from(raster.values).indexOf(50);
    if (!cached || index < 0) throw new Error('The production renderer must contain the duplicate-averaged pixel');
    const color = Array.from(cached.canvas.getContext('2d').getImageData(index % raster.W,
      Math.floor(index / raster.W), 1, 1).data).slice(0, 3);
    return {color, wholeImage:panel.dom.cdisp.toDataURL(),
      thumbnail:panel.msiThumbRefs.get('MSI_A')?.src || null};
  });
}
async function setRoiMode(page, on) {
  await page.locator('#roi-clip-toggle').setChecked(on);
  await page.waitForFunction(expected => App.roiOnlyMode === expected, on);
  await settled(page);
}
async function delayNextSourceRead(page) {
  await page.evaluate(() => {
    window.__roiOriginalGridReader = _ensureRoiRawGrid;
    window.__roiGateHeld = false;
    const gate = new Promise(resolve => {window.__releaseRoiGate = resolve;});
    _ensureRoiRawGrid = async (...args) => {
      const result = await window.__roiOriginalGridReader(...args);
      if (!window.__roiGateHeld) {window.__roiGateHeld = true; await gate;}
      return result;
    };
  });
}
async function releaseSourceRead(page) {
  await page.evaluate(async () => {
    window.__releaseRoiGate();
    if (window.__heldRoiCalculation) await window.__heldRoiCalculation;
    _ensureRoiRawGrid = window.__roiOriginalGridReader;
    delete window.__roiOriginalGridReader;
    delete window.__releaseRoiGate;
    delete window.__heldRoiCalculation;
  });
}
async function inspectLruStress(page) {
  await page.evaluate(() => {
    window.__roiStress = {sourceReads:0, loads:0, completed:false};
    const originalReader = _ensureRoiRawGrid;
    _ensureRoiRawGrid = async (...args) => {window.__roiStress.sourceReads++; return originalReader(...args);};
    const keys = Array.from({length:20}, (_, index) => 'MSI_STRESS_' + index);
    for (const section of App.project.sections) {
      const panel = App.panels.get(section.id), originalLoad = panel.loadMsiLayer;
      panel.loadMsiLayer = async (...args) => {window.__roiStress.loads++; return originalLoad.apply(panel, args);};
      for (const key of keys) section.msiSeries[key] = {...section.msiSeries.MSI_A};
      panel.populateThumbnails();
      // All thumbnail cells participate in the real IntersectionObserver path.
      panel.dom.thumbs.style.maxHeight = 'none'; panel.dom.thumbs.style.height = '900px';
      panel.dom.thumbs.style.overflow = 'visible';
    }
    (async () => {
      for (const section of App.project.sections) for (const key of keys) {
        await App.panels.get(section.id).ensureMsiLayerLoaded(key);
        await App.ensureRoiDisplayRange(section, key);
      }
      window.__roiStress.completed = true;
    })().catch(error => {window.__roiStress.error = error.message;});
  });
  const samples = [];
  for (let index = 0; index < 8; index++) {
    samples.push(await page.evaluate(async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return {...window.__roiStress,
        rasters:Array.from(App.panels.values(), panel => panel.msiValueRasters.size),
        summaries:App._roiDisplayRanges.size};
    }));
  }
  console.log('ROI LRU stress samples: ' + JSON.stringify(samples));
  const last = samples.at(-1), previous = samples.at(-2);
  assert.equal(last.completed, true, 'All 20 additional layers per section finish their ROI summaries');
  assert.equal(last.sourceReads, 40, 'LRU eviction/reload does not recompute a completed summary from the same source');
  assert.deepEqual(last.rasters, [16,16], 'MSI raster memory remains bounded by the existing per-section LRU');
  assert.equal(last.loads, previous.loads, 'Thumbnail reload activity settles instead of entering a repaint loop');
}

async function main() {
  const data = fixture(), writes = [], external = [], errors = [];
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/runtime-config.js') {
        res.setHeader('Content-Type', 'text/javascript');
        res.end("Object.defineProperty(window,'DESI_BUILD_CONFIG',{value:Object.freeze({mode:'online',cloud:{url:"
          + JSON.stringify('http://' + req.headers.host) + ",anonKey:'synthetic-roi-range-key'}}),writable:false,configurable:false});");
        return;
      }
      if (req.method === 'POST' && pathname.startsWith('/rest/v1/rpc/')) {
        const rpc = pathname.slice('/rest/v1/rpc/'.length);
        if (!['get_project_doc', 'list_rois', 'list_share_overlays', 'list_share_alignments', 'list_share_images'].includes(rpc)) {
          writes.push(pathname); res.writeHead(403); res.end('Unexpected write'); return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(rpc === 'get_project_doc' ? data.doc : [])); return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) {writes.push(pathname); res.writeHead(405); res.end(); return;}
      const prefix = '/storage/v1/object/public/atlases/';
      const source = data.sources[pathname.slice(prefix.length)];
      if (pathname.startsWith(prefix) && source) {res.setHeader('Content-Type', 'text/csv'); res.end(source); return;}
      const file = path.resolve(root, '.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
      if (!file.startsWith(root + path.sep)) {res.writeHead(403); res.end(); return;}
      res.setHeader('Content-Type', ({'.js':'text/javascript', '.html':'text/html; charset=utf-8', '.css':'text/css'})[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch (_) {res.writeHead(404); res.end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try {
    browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined});
    const context = await browser.newContext({viewport:{width:1920, height:1080}});
    await context.route('**/*', route => {
      const url = route.request().url();
      if (url.startsWith(origin + '/') || /^(blob|data):/.test(url)) return route.continue();
      external.push(url); return route.abort();
    });
    await context.addInitScript(slug => sessionStorage.setItem('desi:share:' + slug,
      JSON.stringify({slug, role:'viewer', token:'synthetic-roi-viewer',
        expiresAt:new Date(Date.now() + 3600000).toISOString(), isPublic:false})), slug);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(origin + '/viewer/#share=' + slug);
    await page.waitForFunction(() => typeof App !== 'undefined' && App.project && App.panels.size === 2
      && typeof SharePreview !== 'undefined' && SharePreview.isOpen());
    await page.locator('[data-preview-close]').click();
    // Keep the asynchronous fixture in the page while source/worker/image jobs
    // finish. CDP's weak reference to an evaluate-returned Promise can be
    // collected during a cold load; readiness is observed separately so an
    // unresolved application operation still fails the bounded wait below.
    await page.evaluate(() => {
      const setup = window.__roiRangeSetup = {done:false, error:null};
      setup.promise = (async () => {
      App._stopShareRoiPoll();
      for (const section of App.project.sections) {
        if (!await App.panels.get(section.id).ensureMsiLayerLoaded('MSI_A')) throw new Error('Fixture source failed');
      }
      App.setActiveSection(App.project.sections[0].id);
      App.setViewMode('compound'); App.setFocusCompoundKey('MSI_A');
      await App.setOtsuBgRemove(false);
      const primary = {id:'roi-left', colorKey:'Red', name:'Left half', rgba:[255,0,0,200], polysBySection:{}, geometryBySection:{}};
      const outside = {id:'roi-right', colorKey:'Blue', name:'Outside maximum', rgba:[0,0,255,200], polysBySection:{}, geometryBySection:{}};
      for (const section of App.project.sections) {
        const raster = App.panels.get(section.id).msiValueRasters.get('MSI_A');
        const geometry = {version:'msi-source-v1', sourceRef:raster.sourceGeometry.sourceRef,
          displayGeometry:raster.sourceGeometry.displayGeometry};
        primary.polysBySection[section.id] = [[-.5,-.5],[7.5,-.5],[7.5,15.5],[-.5,15.5]];
        outside.polysBySection[section.id] = [[14.5,14.5],[15.5,14.5],[15.5,15.5],[14.5,15.5]];
        primary.geometryBySection[section.id] = geometry;
        outside.geometryBySection[section.id] = geometry;
      }
      window.__originalRangeRoi = structuredClone(primary);
      App.project.rois = [primary, outside]; App.project.roiHidden = {'roi-right':true};
      App.activeRoiId = primary.id; populateRoiList(); App.redrawAllRois();
      App.recomputeMsiAbsScale(); App.repaintAllMsi();
      })().then(() => { setup.done = true; }, error => {
        setup.error = error.stack || error.message || String(error); setup.done = true;
      });
    });
    await page.waitForFunction(() => window.__roiRangeSetup.done);
    const setup = await page.evaluate(() => ({error:window.__roiRangeSetup.error,
      ready:App.project.sections.map(section => App.panels.get(section.id).isMsiLayerReady('MSI_A'))}));
    assert.equal(setup.error, null, 'ROI fixture setup completes without an application error');
    assert.deepEqual(setup.ready, [true,true], 'Both fixture source layers have finished decoding');
    await page.evaluate(() => { delete window.__roiRangeSetup; });
    const originalSources = await sourceSnapshot(page);
    assert.deepEqual(originalSources.map(source => source.roi.stats.max), [95,190], 'Fixture includes duplicate source rows in the ROI');
    await expectMaxima(page, [2000,2000], 'Whole-image Same uses the original global maximum');
    await page.locator('#tb-range-max').fill('1234'); await page.locator('#tb-range-max').blur();
    await expectMaxima(page, [1234,1234]);
    const whole = await sampleRenderedLayer(page);
    await setRoiMode(page, true);
    await expectMaxima(page, [190,190], 'ROI mode ignores the whole-image manual window and uses visible ROI source maxima');
    assert.equal(Number(await page.locator('#tb-range-max').inputValue()), 190, 'Toolbar displays the ROI auto window');
    assert.equal(await page.evaluate(() => App.msiUserWindow.MSI_A.max), 1234, 'Whole-image manual setting remains intact');
    const roiImage = await sampleRenderedLayer(page);
    const expectedRoiColor = await page.evaluate(() => getActiveColormap()[Math.round(50 / 190 * 255)]);
    assert.deepEqual(roiImage.color, expectedRoiColor, 'Real MSI pixels are recolored with the ROI range');
    assert.notDeepEqual(roiImage.color, whole.color, 'ROI auto range brightens the in-ROI signal');
    assert.notEqual(roiImage.thumbnail, whole.thumbnail, 'Thumbnail range follows the main renderer');

    await page.locator('#msi-scale-mode').selectOption('individual');
    await expectMaxima(page, [95,190], 'Individual uses each section ROI maximum');
    await page.locator('#tb-range-max').fill('77'); await page.locator('#tb-range-max').blur();
    await expectMaxima(page, [77,77], 'Manual ROI window applies while ROI mode is enabled');
    await setRoiMode(page, false);
    await expectMaxima(page, [1234,1234], 'Turning ROI off restores the whole-image manual window');
    await setRoiMode(page, true);
    await expectMaxima(page, [77,77], 'ROI manual window remains separate when returning to ROI mode');
    await page.locator('#tb-range-reset').click();
    await expectMaxima(page, [95,190], 'Reset in ROI mode restores ROI auto scaling');
    await page.locator('#msi-scale-mode').selectOption('same');
    await page.evaluate(() => {
      App.sectionVisibility().change([App.project.sections[1].id], false);
    });
    await expectMaxima(page, [95,95], 'Same aggregation excludes hidden sections');
    await page.evaluate(() => App.sectionVisibility().change([App.project.sections[1].id], true));
    await expectMaxima(page, [190,190]);

    await page.evaluate(() => {App.project.roiHidden['roi-right'] = false; App.redrawAllRois();});
    await expectMaxima(page, [2000,2000], 'Showing a second ROI expands the union and invalidates its range');
    await page.evaluate(() => {App.project.roiHidden['roi-right'] = true; App.redrawAllRois();});
    await expectMaxima(page, [190,190], 'Hiding that ROI restores the union range');
    await page.evaluate(() => {
      for (const section of App.project.sections) App.project.rois[0].polysBySection[section.id] = [[.5,-.5],[7.5,-.5],[7.5,15.5],[.5,15.5]];
      App.redrawAllRois();
    });
    await expectMaxima(page, [20,20], 'Editing ROI geometry drops the duplicate-coordinate maximum');
    await page.evaluate(() => {
      App.project.rois[0] = structuredClone(window.__originalRangeRoi); App.redrawAllRois();
    });
    await expectMaxima(page, [190,190]);

    await setRoiMode(page, false);
    await page.locator('#btn-share-preview').click();
    await page.locator('[data-roi-only]').check();
    await expectMaxima(page, [190,190]);
    await page.waitForFunction(() => Number(document.querySelector('[data-preview-range-max]').value) === 190);
    const previewImage = await page.locator('[data-cell-img]').first().getAttribute('src');
    assert.ok(previewImage && previewImage.startsWith('data:image/png'), 'Preview rebakes its data URL with ROI-scaled pixels');
    await page.locator('[data-preview-close]').click();
    assert.equal(await page.evaluate(() => App.roiOnlyMode), false, 'Closing Preview restores the main ROI mode');
    await expectMaxima(page, [1234,1234], 'Preview close restores the full-image manual range');
    assert.equal(Number(await page.locator('#tb-range-max').inputValue()), 1234);

    await setRoiMode(page, true);
    await page.evaluate(() => {App.project.roiHidden['roi-left'] = true; App.redrawAllRois();});
    await expectMaxima(page, [1,1], 'No visible ROI has a neutral window instead of leaking outside intensities');
    await page.evaluate(() => {
      App.project.roiHidden['roi-left'] = false;
      for (const section of App.project.sections) App.project.rois[0].polysBySection[section.id] = [[100,100],[101,100],[101,101],[100,101]];
      App.redrawAllRois();
    });
    await expectMaxima(page, [1,1], 'An ROI without measured points uses the neutral window');
    await page.evaluate(() => {App.project.rois[0] = structuredClone(window.__originalRangeRoi); App.redrawAllRois();});
    await expectMaxima(page, [190,190]);

    // Hold an actual source-read completion while a newer ROI geometry wins.
    // The parser still produces the real source grid; only delivery is delayed.
    await delayNextSourceRead(page);
    await page.evaluate(() => {
      const section = App.project.sections[0];
      App.project.rois[0].polysBySection[section.id] = [[1.5,-.5],[7.5,-.5],[7.5,15.5],[1.5,15.5]];
      App.redrawAllRois();
      window.__heldRoiCalculation = App.ensureRoiDisplayRange(section, 'MSI_A');
    });
    await page.waitForFunction(() => window.__roiGateHeld);
    await page.evaluate(() => {App.project.rois[0] = structuredClone(window.__originalRangeRoi); App.redrawAllRois();});
    await expectMaxima(page, [190,190], 'The newer ROI takes effect while the superseded read is pending');
    await releaseSourceRead(page);
    await expectMaxima(page, [190,190], 'An old asynchronous ROI result cannot overwrite the current geometry');

    await delayNextSourceRead(page);
    await page.evaluate(() => {
      const section = App.project.sections[0];
      App.project.rois[0].polysBySection[section.id] = [[2.5,-.5],[7.5,-.5],[7.5,15.5],[2.5,15.5]];
      App.redrawAllRois();
      window.__heldRoiCalculation = App.ensureRoiDisplayRange(section, 'MSI_A');
    });
    await page.waitForFunction(() => window.__roiGateHeld);
    await setRoiMode(page, false);
    await releaseSourceRead(page);
    await expectMaxima(page, [1234,1234], 'Late ROI completion after disabling ROI cannot replace the whole-image manual range');
    await page.evaluate(() => {App.project.rois[0] = structuredClone(window.__originalRangeRoi); App.redrawAllRois();});
    await setRoiMode(page, true);
    await expectMaxima(page, [190,190]);

    // Replacing the source identity invalidates a formerly valid ROI. A range
    // from the old source must never be silently reused for the new source.
    await page.evaluate(() => {
      for (const section of App.project.sections) {
        const entry = section.msiSeries.MSI_A;
        entry.__originalRangeSourceRef = entry.sourceReference;
        entry.sourceReference += '-different-source';
      }
      App.redrawAllRois();
    });
    await expectMaxima(page, [1,1], 'A source identity mismatch invalidates cached ROI statistics');
    await page.evaluate(() => {
      for (const section of App.project.sections) {
        const entry = section.msiSeries.MSI_A;
        entry.sourceReference = entry.__originalRangeSourceRef;
        delete entry.__originalRangeSourceRef;
      }
      App.redrawAllRois();
    });
    await expectMaxima(page, [190,190]);

    await page.evaluate(() => {
      window.__roiOriginalGridReader = _ensureRoiRawGrid;
      window.__failedRoiReads = 0;
      _ensureRoiRawGrid = async () => {window.__failedRoiReads++; return null;};
      // Same measured membership, new geometry signature: exercise an actual
      // source-read attempt instead of returning the previous ready summary.
      for (const section of App.project.sections)
        App.project.rois[0].polysBySection[section.id][0][0] = -.4;
      App.redrawAllRois();
    });
    await expectMaxima(page, [1,1], 'A temporarily unavailable source uses a neutral maximum window');
    const failedReadCount = await page.evaluate(() => window.__failedRoiReads);
    await page.evaluate(() => {App.repaintAllMsi(); App.repaintAllMsi();});
    await settled(page);
    assert.equal(await page.evaluate(() => window.__failedRoiReads), failedReadCount,
      'An unavailable source does not create an automatic repaint/retry loop');
    await page.evaluate(() => {_ensureRoiRawGrid = window.__roiOriginalGridReader; delete window.__roiOriginalGridReader;});
    await setRoiMode(page, false);
    await setRoiMode(page, true);
    await expectMaxima(page, [190,190], 'Re-enabling ROI retries a transient source failure');
    await page.evaluate(() => {App.project.rois[0] = structuredClone(window.__originalRangeRoi); App.redrawAllRois();});
    await expectMaxima(page, [190,190]);

    await page.evaluate(async () => {
      const previous = App.panels.get(App.project.sections[0].id);
      await App.rebuildSectionPanels();
      if (App.panels.get(App.project.sections[0].id) === previous) throw new Error('Fixture must replace actual panel objects');
    });
    await expectMaxima(page, [190,190], 'Rebuilt panels acquire a fresh ROI summary instead of retaining a retired panel cache');

    await page.locator('#msi-scale-mode').selectOption('individual');
    await delayNextSourceRead(page);
    await page.evaluate(() => {
      const section = App.project.sections[0];
      App.project.rois[0].polysBySection[section.id] = [[3.5,-.5],[7.5,-.5],[7.5,15.5],[3.5,15.5]];
      App.redrawAllRois();
      window.__heldRoiCalculation = App.ensureRoiDisplayRange(section, 'MSI_A');
    });
    await page.waitForFunction(() => window.__roiGateHeld);
    await page.evaluate(async () => {
      App.project.rois[0] = structuredClone(window.__originalRangeRoi);
      await App.rebuildSectionPanels();
    });
    await expectMaxima(page, [95,190], 'New panels finish calculating while a retired panel source read remains pending');
    await releaseSourceRead(page);
    await expectMaxima(page, [95,190], 'Late completion from a destroyed panel cannot poison its replacement');
    await page.locator('#msi-scale-mode').selectOption('same');
    await page.evaluate(async () => {
      App.updateMsiDisplaySettings({rangePolicy:'legacy', preset:'custom'}, false);
      await App.setMsiOutlierClipAll(true);
    });
    await settled(page);
    await expectMaxima(page, [100,100],
      'Legacy robust Range uses the ROI raster percentile (nearest rank selects 50 for 128 pixels), not source maximum 95');
    await page.evaluate(async () => {
      await App.setMsiOutlierClipAll(false);
      App.updateMsiDisplaySettings({rangePolicy:'maximum', preset:'custom'});
    });
    await expectMaxima(page, [190,190], 'Maximum policy returns to original measured-row maxima');
    assert.deepEqual(await sourceSnapshot(page), originalSources,
      'ROI display changes preserve source bytes, duplicate rows, raster values, original statistics and geometry');
    assert.deepEqual(writes, [], 'ROI display operations never write to the shared service');
    assert.deepEqual(external, [], 'Browser traffic stays within the synthetic server');
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    if (process.env.MSI_ROI_STRESS) await inspectLruStress(page);
    console.log('ROI Range browser: Same/Individual, source maxima, pixels, manual isolation, scope, ROI edits, Preview, empty ROI and asynchronous invalidation PASS.');
    await context.close();
  } finally {
    if (browser) await browser.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => {console.error(error.stack || error); process.exitCode = 1;});
