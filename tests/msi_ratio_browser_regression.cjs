'use strict';
// Production viewer/parser/rendering with wholly synthetic paired signals.
// Exports reusable fixtures so Help captures can use the very same real UI.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createServer} = require('node:http');
const {chromium} = require('playwright');
const JSZip = require('../vendor/jszip.min.js');
const {renderOfflineConfig} = require('../offline/config.cjs');
const root = path.resolve(__dirname, '..'), slug = 'synthetic-ratio-help';

function fixture() {
  const sources = {}, X = [10,10,0,8,'',-2,9,12], Y = [1,10,2,0,3,2,'',3];
  const sections = [1,2].map((factor, i) => {
    const sourcePath = 'synthetic/ratio-' + i + '.csv', rows = ['x,y,X,Y'];
    for (let y = 0; y < 16; y++) for (let x = 0; x < 32; x++) {
      const k = x % 8; rows.push([x,y,X[k] === '' ? '' : X[k] * factor,Y[k]].join(','));
    }
    sources[sourcePath] = rows.join('\n') + '\n';
    const common = {path:sourcePath,mime:'text/csv',filename:'ratio-' + i + '.csv',kind:'txt',
      sourceFileId:'ratio-file-' + i,sourceReference:'ratio-source-' + i,sourceRevision:'revision-1',
      x:'x',y:'y',sep:',',bakeMode:'full'};
    return {id:'ratio-server-' + i,ordinal:i+1,
      display_name:'Synthetic ratio ' + (i+1),meta:{client_id:'ratio-section-' + i,
        displayTransform:{version:2,baseOrientation:'native-raster'},world_coords:{msi_um_per_px:{x:30,y:30}}},
      storage_paths:{images:{},msiSeries:{MSI_X:{...common,v:'X',compoundMeta:{base:'Molecule X'}},
        MSI_Y:{...common,v:'Y',compoundMeta:{base:'Molecule Y'}}}}};
  });
  const poly = [[-.5,-.5],[7.5,-.5],[7.5,.5],[-.5,.5]];
  const rois = sections.map((section,i) => ({id:'ratio-roi-' + i,section_id:section.id,color_key:'Red',
    name:'Eight original measurements',created_by:'master',version:1,
    poly_msi:{version:'msi-roi-polygon-v1',vertices:poly,geometry:{version:'msi-source-v1',
      sourceRef:'ratio-source-' + i,displayGeometry:{version:'msi-proportional-v1',W:32,H:16,
        x:{origin:0,step:1},y:{origin:0,step:1}}}}}));
  return {sources,rois,doc:{id:'synthetic-ratio-project',slug,
    meta:{display_name:'Synthetic ratio test project',project_meta:{colormap:'plasma',msiSmoothing:'none',
      msiDisplay:{version:2,preset:'hdi',aspectMode:'physical',rangePolicy:'maximum',smoothingStrength:1,linearStrength:10}}},
    sections,anatomy_palette:{}}};
}
async function archive(data) {
  const zip = new JSZip(), roi = {id:'ratio-roi',colorKey:'Red',name:'Eight original measurements',
    rgba:[255,0,0,200],polysBySection:{},geometryBySection:{}};
  const sections = data.doc.sections.map((s,i) => {
    const originalSeries = {};
    for (const [key,e] of Object.entries(s.storage_paths.msiSeries)) {
      originalSeries[key] = {...e,sourcePath:e.path}; delete originalSeries[key].path;
      zip.file(e.path,data.sources[e.path]);
    }
    roi.polysBySection[s.meta.client_id] = data.rois[i].poly_msi.vertices;
    roi.geometryBySection[s.meta.client_id] = data.rois[i].poly_msi.geometry;
    return {id:s.meta.client_id,ordinal:s.ordinal,displayName:s.display_name,meta:s.meta,images:{},data:[],
      msiFilesMeta:{['ratio-file-' + i]:{kind:'txt',filename:'ratio-' + i + '.csv',sourcePath:Object.values(originalSeries)[0].sourcePath}},originalSeries};
  });
  zip.file('SyntheticRatio.json',JSON.stringify({format:'desi_data_share_v2',id:'ratio-local-project',
    displayName:'Synthetic ratio test project',sourceContract:'msi-source-rows-v1',
    sectionOrder:sections.map(s=>s.id),roiHidden:{},memo:{purpose:'Synthetic test signals, no real specimen.'},
    meta:data.doc.meta.project_meta,rois:[roi],roiMedia:{version:1,items:[]},sections}));
  return zip.generateAsync({type:'nodebuffer'});
}
async function startServer(data = fixture()) {
  const state = {online:false,writes:[],data};
  const server = createServer(async(req,res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if (pathname === '/runtime-config.js') {
        res.setHeader('Content-Type','text/javascript');
        res.end(state.online ? "Object.defineProperty(window,'DESI_BUILD_CONFIG',{value:Object.freeze({mode:'online',cloud:{url:"
          + JSON.stringify('http://' + req.headers.host) + ",anonKey:'synthetic-ratio-key'}}),writable:false,configurable:false});" : renderOfflineConfig()); return;
      }
      if (req.method === 'POST' && pathname.startsWith('/rest/v1/rpc/')) {
        const rpc = pathname.slice('/rest/v1/rpc/'.length);
        if (!['get_project_doc','list_rois','list_share_overlays','list_share_alignments','list_share_images'].includes(rpc)) {
          state.writes.push(pathname); res.writeHead(403);res.end('Unexpected write');return;
        }
        let body = '';for await (const chunk of req) body += chunk;
        const payload = body ? JSON.parse(body) : {};
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify(rpc === 'get_project_doc' ? data.doc : rpc === 'list_rois'
          ? data.rois.filter(r=>r.section_id === payload.p_section_id) : []));return;
      }
      if (!['GET','HEAD'].includes(req.method)) {state.writes.push(pathname);res.writeHead(405);res.end();return;}
      const prefix = '/storage/v1/object/public/atlases/';
      if (pathname.startsWith(prefix) && data.sources[pathname.slice(prefix.length)]) {
        res.setHeader('Content-Type','text/csv');res.end(data.sources[pathname.slice(prefix.length)]);return;
      }
      const file = path.resolve(root,'.' + pathname + (pathname.endsWith('/') ? 'index.html' : ''));
      if (!file.startsWith(root + path.sep)) {res.writeHead(403);res.end();return;}
      res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html; charset=utf-8','.css':'text/css'})[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch (_) {res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  state.origin = 'http://127.0.0.1:' + server.address().port;
  state.close = async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));};
  return state;
}
async function prepare(page, shared = false) {
  await page.waitForFunction(()=>typeof App !== 'undefined' && App.project && App.project.sections.length === 2 && App.panels.size === 2);
  if (shared) {
    await page.waitForFunction(()=>typeof SharePreview !== 'undefined' && SharePreview.isOpen());
    await page.locator('[data-preview-close]').click();
  }
  await page.waitForFunction(()=>App.project.sections.every(s=>App.panels.get(s.id)?.activeMsiKey));
  await page.evaluate(async()=>{
    if (App.shareMode) App._stopShareRoiPoll();
    for (const section of App.project.sections) for (const key of ['MSI_X','MSI_Y'])
      if (!await App.panels.get(section.id).ensureMsiLayerLoaded(key)) throw new Error('Synthetic source failed: ' + key);
    App.setActiveSection(App.project.sections[0].id);App.setViewMode('compound');App.setFocusCompoundKey('MSI_X');
    await App.setOtsuBgRemove(false);App.activeRoiId=App.project.rois[0]?.id;
    populateRoiList();App.redrawAllRois();App.recomputeMsiAbsScale();App.repaintAllMsi();
  });
  assert.equal(await page.locator('#btn-msi-ratio').count(),1);
  assert.equal(await page.evaluate(()=>App.project.rois.length),1);
}
async function sourceSnapshot(page) {
  return page.evaluate(async()=>{
    const rows = [], roi = App.project.rois[0];
    for (const section of App.project.sections) for (const key of ['MSI_X','MSI_Y']) {
      const entry = section.msiSeries[key], panel = App.panels.get(section.id);
      const record = await ProjectStorage.getBlob(entry.blobId);
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await record.blob.arrayBuffer())),v=>v.toString(16).padStart(2,'0')).join('');
      const quant = await extractRoiRawFromSection(panel,key,roi.polysBySection[section.id],roi);
      if (quant.unavailable) throw new Error('Original ROI unavailable: ' + quant.reason);
      rows.push({section:section.id,key,hash,values:Array.from(panel.msiValueRasters.get(key).values),
        geometry:panel.msiValueRasters.get(key).sourceGeometry,roiValues:quant.values,roiRowIds:quant.rowIds,roiStats:calcStats(quant.values)});
    }
    return {sources:rows,rois:JSON.stringify(App.project.rois)};
  });
}
async function createRatio(page) {
  await page.locator('#btn-msi-ratio').click();
  const dialog = page.locator('#msi-ratio-dialog');await dialog.waitFor();
  await dialog.locator('[data-ratio-name]').fill('Molecule X / Molecule Y');
  for (let i=0;i<2;i++) {
    await dialog.locator('[data-ratio-x]').nth(i).selectOption('MSI_X');
    await dialog.locator('[data-ratio-y]').nth(i).selectOption('MSI_Y');
  }
  await dialog.locator('[data-ratio-threshold]').fill('5');
  await dialog.locator('[data-ratio-swap]').click();
  assert.equal(await dialog.locator('[data-ratio-threshold]').inputValue(),'0');
  assert.match(await dialog.locator('[data-ratio-status]').innerText(),/0に戻しました/);
  await dialog.locator('[data-ratio-swap]').click();
  await dialog.locator('[data-ratio-apply]').click();
  await page.waitForFunction(()=>App.getRatioDefinitions().length === 1 && App.project.sections.every(s=>{
    const p=App.panels.get(s.id);return p.activeMsiKey?.startsWith('MSI_RATIO_') && p.isMsiLayerReady(p.activeMsiKey);
  }));
  await dialog.locator('[data-ratio-results] tbody tr').first().waitFor();
  return page.evaluate(()=>MsiRatioModel.displayKey(App.getRatioDefinitions()[0].id));
}
async function ratioSnapshot(page,key) {
  return page.evaluate(async key=>{
    const out=[];for (const section of App.project.sections) {
      const r=await App.resolveRatio(section,key);out.push({statistics:r.statistics,roi:r.roiStats.map(row=>({status:row.status,statistics:row.statistics})),
        values:Array.from(r.values),raster:Array.from(r.raster.values),joinMethod:r.joinMethod});
    }return out;
  },key);
}
function assertKnownRatios(results) {
  results.forEach((result,index)=>{
    const factor=index+1,s=result.statistics,roi=result.roi[0].statistics;
    assert.equal(s.nCandidate,512);assert.equal(s.nValid,256);assert.equal(s.validFraction,.5);
    assert.equal(s.totalRatio,2*factor);assert.equal(s.mean,3.75*factor);assert.equal(s.median,2.5*factor);
    assert.equal(roi.nCandidate,8);assert.equal(roi.nValid,4);assert.equal(roi.sumX,32*factor);assert.equal(roi.sumY,16);
    assert.equal(roi.totalRatio,2*factor);assert.equal(roi.mean,3.75*factor);assert.equal(roi.median,2.5*factor);
    assert.equal(result.joinMethod,'source-row-id');assert.equal(result.values[2],0);assert.ok(Number.isNaN(result.values[3]));
  });
}
async function capture(page,name) {
  if (!process.env.MSI_RATIO_SCREENSHOT_DIR) return;
  await fs.mkdir(process.env.MSI_RATIO_SCREENSHOT_DIR,{recursive:true});
  await page.screenshot({path:path.join(process.env.MSI_RATIO_SCREENSHOT_DIR,name+'.png'),fullPage:false});
}
async function downloadCsv(page,kind) {
  const download = page.waitForEvent('download');
  await page.locator('[data-ratio-csv="'+kind+'"]').click();
  const file = await download;
  const text = await fs.readFile(await file.path(),'utf8');
  return text.replace(/^\uFEFF/,'').trimEnd().split(/\r?\n/).map(line=>line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
    .map(cell=>cell.replace(/^"|"$/g,'').replace(/""/g,'"')));
}
async function exercise(page,shared) {
  const original=await sourceSnapshot(page),meta=await page.evaluate(()=>JSON.stringify(App.project.meta));
  await page.evaluate(()=>_roiRawGridCache.clear()); // Exercise the real cold two-column parser, then compare ordinary ROI parity.
  const key=await createRatio(page),before=await ratioSnapshot(page,key);assertKnownRatios(before);
  assert.equal(await page.evaluate(()=>App.project.sections.some(s=>Object.keys(s.msiSeries).some(k=>k.startsWith('MSI_RATIO_')))),false);
  assert.equal(await page.evaluate(()=>{
    const section=App.project.sections[0],key='MSI_RATIO_ordinary-compound',entry={kind:'txt',v:'ordinary'};
    section.msiSeries[key]=entry;
    try{return !isRatioDisplayKey(key)&&displayMsiEntry(section,key)===entry;}finally{delete section.msiSeries[key];}
  }),true,'A measured compound with a ratio-like name is not a derived ratio');
  await capture(page,shared?'ratio-shared-dialog':'ratio-local-dialog');
  const summary=await downloadCsv(page,'summary'),values=await downloadCsv(page,'values');
  assert.equal(summary.length,3);assert.equal(values.length,1025);
  const summaryCol=name=>summary[0].indexOf(name),valueCol=name=>values[0].indexOf(name);
  assert.deepEqual(summary.slice(1).map(row=>Number(row[summaryCol('total_ratio')])),[2,4]);
  assert.deepEqual(summary.slice(1).map(row=>Number(row[summaryCol('n_valid')])),[4,4]);
  assert.equal(values[3][valueCol('ratio_value')],'0','Valid zero is exported numerically');
  assert.equal(values[4][valueCol('ratio_value')],'','Invalid values are blank, not zero');
  assert.match(values[4][valueCol('invalid_reason')],/denominator-zero/);
  for(const table of [summary,values]) {
    for(const name of ['project_id','project','numerator_name','denominator_name','numerator_ref_sha256','denominator_ref_sha256','input_revision'])
      assert.ok(table[0].includes(name),'Ratio CSV contains '+name);
    assert.match(table[1][table[0].indexOf('numerator_ref_sha256')],/^[a-f0-9]{64}$/);
    assert.notEqual(table[1][table[0].indexOf('numerator_ref_sha256')],table[1][table[0].indexOf('denominator_ref_sha256')]);
    assert.equal(table[1][table[0].indexOf('numerator_name')],'Molecule X');
    assert.equal(table[1][table[0].indexOf('denominator_name')],'Molecule Y');
  }
  // Mutate at a real asynchronous boundary inside export. The complete output
  // must abort rather than combine an old definition with newly computed rows.
  for (const change of ['roi','definition']) {
    const failure=await page.evaluate(async({key,change})=>{
      const roi=App.project.rois[0],def=App.getRatioDefinitions()[0],oldName=roi.name,oldMin=def.denominatorMin;
      const digest=crypto.subtle.digest;let changed=false;
      crypto.subtle.digest=function(...args){if(!changed){changed=true;if(change==='roi')roi.name+=' changed';else def.denominatorMin=oldMin+1;}return digest.apply(this,args);};
      try{await MsiRatioRuntime.exportCsv(key,'values');return 'unexpected-download';}
      catch(error){return error.code;}
      finally{crypto.subtle.digest=digest;roi.name=oldName;def.denominatorMin=oldMin;}
    },{key,change});
    assert.equal(failure,'RATIO_SOURCE_CHANGED','CSV rejects mid-export '+change+' changes');
  }
  await page.locator('#msi-ratio-dialog').getByRole('button',{name:'閉じる',exact:true}).click();
  const images=new Set();
  for (const mode of ['linear','median']) {
    await page.locator('#tb-smoothing').selectOption(mode);
    for (const value of ['1','10']) {
      await page.locator('#tb-smoothing-strength').fill(value);await page.locator('#tb-smoothing-strength').dispatchEvent('change');
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      images.add(await page.evaluate(()=>App.panels.get(App.project.sections[0].id).dom.cdisp.toDataURL()));
      assert.deepEqual(await ratioSnapshot(page,key),before,'Display smoothing leaves ratio quantification intact');
    }
  }
  assert.ok(images.size>1,'Display smoothing changes real rendered pixels');
  await page.locator('#roi-clip-toggle').check();
  await page.evaluate(async key=>{await Promise.all(App.project.sections.map(s=>App.ensureRoiDisplayRange(s,key)));},key);
  assert.deepEqual(await ratioSnapshot(page,key),before,'ROI-only Range does not filter ratio quantification');
  await capture(page,shared?'ratio-shared-image':'ratio-local-image');
  await page.locator('#roi-clip-toggle').uncheck();
  await page.locator('#ratio-display-select').selectOption('');
  await page.waitForFunction(()=>App.focusCompoundKey === 'MSI_X');
  assert.deepEqual(await sourceSnapshot(page),original,'Original data and ordinary molecule ROI values are unchanged');
  await page.locator('#ratio-display-select').selectOption(key);
  await page.waitForFunction(key=>App.focusCompoundKey===key,key);
  assertKnownRatios(await ratioSnapshot(page,key));
  await page.evaluate(()=>{App.setViewMode('free');App.setActiveSection(App.project.sections[0].id);});
  await page.locator('#ratio-display-select').selectOption('');
  assert.deepEqual(await page.evaluate(()=>App.project.sections.map(s=>App.panels.get(s.id).activeMsiKey)),['MSI_X',key],
    'Free mode restores the ordinary molecule only on the selected section');
  const ordinaryImage=await page.evaluate(()=>App.panels.get(App.project.sections[0].id).dom.cdisp.toDataURL());
  await page.evaluate(()=>App.setActiveSection(App.project.sections[1].id));
  await page.locator('#tb-colormap').selectOption('viridis');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(()=>App.panels.get(App.project.sections[0].id).dom.cdisp.toDataURL()),ordinaryImage,
    'A Free-mode measured panel keeps its own image when a ratio panel changes style');
  await page.evaluate(()=>App.setActiveSection(App.project.sections[0].id));
  await page.locator('#ratio-display-select').selectOption(key);
  await page.waitForFunction(key=>App.panels.get(App.project.sections[0].id).activeMsiKey===key,key);
  await page.evaluate(()=>App.setViewMode('compound'));
  await page.evaluate(key=>{
    App.msiUserWindow.MSI_X={min:3,max:123};App.msiRoiUserWindow.MSI_X={min:4,max:55};
    App.updateRatioRange(key,App.project.sections[0],'max',7);
  },key);
  await page.locator('#tb-msi-style').selectOption('hdi');
  assert.deepEqual(await page.evaluate(key=>({whole:App.msiUserWindow.MSI_X,roi:App.msiRoiUserWindow.MSI_X,
    ratio:App.getRatioManualRange(key,App.project.sections[0])}),key),{whole:{min:3,max:123},roi:{min:4,max:55},ratio:null},
    'A ratio display preset only resets that ratio window, preserving ordinary molecule windows');
  await page.locator('#btn-share-preview').click();
  await page.waitForFunction(()=>SharePreview.isOpen()&&document.querySelectorAll('[data-cell-img]').length===2
    &&Array.from(document.querySelectorAll('[data-cell-img]')).every(img=>img.complete&&img.naturalWidth>0));
  assert.equal(await page.locator('[data-preview-range-max]').isEnabled(),true,'Preview exposes the ratio Range');
  assert.doesNotMatch(await page.locator('[data-stats-body]').innerText(),/Max Intensity|Avg Intensity/,'Preview labels ratio statistics as ratios');
  await capture(page,shared?'ratio-shared-preview':'ratio-local-preview');
  await page.locator('[data-preview-close]').click();
  assertKnownRatios(await ratioSnapshot(page,key));
  if (shared) {
    assert.equal(await page.evaluate(()=>JSON.stringify(App.project.meta)),meta,'Personal ratio never mutates the shared project metadata');
    await page.evaluate(async key=>{
      const def=structuredClone(App.getRatioDefinitions()[0]);def.name='Lipid CE 20 CV 30 / Reference CE 10 CV 5';
      MsiRatioRuntime.store(def,def.id);await App.activateRatio(key);App.openRatioDialog(key);
    },key);
    const visible=await page.evaluate(key=>({name:document.querySelector('[data-ratio-name]').value,
      saved:document.querySelector('[data-ratio-saved]').textContent,select:document.querySelector('#ratio-display-select').textContent,
      entry:App.ratioEntry(App.project.sections[0],key).compoundMeta}),key);
    assert.doesNotMatch(JSON.stringify(visible),/\b(?:CE|CV)\s*\d/,'Shared Viewer ratio labels hide CE/CV conditions');
    await page.locator('#msi-ratio-dialog').getByRole('button',{name:'閉じる',exact:true}).click();
  }
  else {
    await page.evaluate(()=>App._flushSave());
    assert.equal(await page.evaluate(async()=> (await ProjectStorage.getProject(App.project.id)).meta.msiRatios.definitions.length),1);
  }
  return {key,original,before};
}
async function main() {
  const state=await startServer(),external=[],errors=[];let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
    const context=await browser.newContext({viewport:{width:1920,height:1080},acceptDownloads:true});
    const configure=async context=>{
      await context.route('**/*',route=>{if(route.request().url().startsWith(state.origin+'/')||/^(blob|data):/.test(route.request().url()))return route.continue();external.push(route.request().url());return route.abort();});
      const page=await context.newPage();page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(60000);
      page.on('pageerror',error=>{errors.push(error.message);console.error('BROWSER ERROR:',error.message);});
      page.on('dialog',dialog=>{if(/Init failed/i.test(dialog.message()))errors.push(dialog.message());return dialog.accept();});return page;
    };
    const local=await configure(context);
    await local.goto(state.origin+'/viewer/?project=ratio-empty',{waitUntil:'domcontentloaded'});
    await local.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
    await local.locator('#hidden-import-input').setInputFiles({name:'synthetic-ratio.zip',mimeType:'application/zip',buffer:await archive(state.data)});
    await local.getByRole('button',{name:'復元 / Restore',exact:true}).click();await prepare(local);
    const saved=await exercise(local,false);
    const localId=await local.evaluate(()=>App.project.id);
    await local.goto(state.origin+'/viewer/?project='+encodeURIComponent(localId),{waitUntil:'domcontentloaded'});await prepare(local);
    assert.equal(await local.evaluate(()=>App.getRatioDefinitions().length),1);
    await local.evaluate(key=>App.activateRatio(key),saved.key);
    assertKnownRatios(await ratioSnapshot(local,saved.key));
    assert.deepEqual(await sourceSnapshot(local),saved.original);
    await context.close();console.log('Ratio browser local: UI, raw/ROI preservation, display, CSV, save/reopen PASS.');

    state.online=true;
    const shared=await browser.newContext({viewport:{width:1920,height:1080},acceptDownloads:true});
    await shared.addInitScript(slug=>{const key='desi:share:'+slug;if(!sessionStorage.getItem(key))sessionStorage.setItem(key,
      JSON.stringify({slug,role:'viewer',token:'synthetic-ratio-viewer',expiresAt:new Date(Date.now()+3600000).toISOString(),isPublic:false}));},slug);
    const viewer=await configure(shared);
    await viewer.goto(state.origin+'/viewer/#share='+slug,{waitUntil:'domcontentloaded'});await prepare(viewer,true);
    const personal=await exercise(viewer,true);
    await viewer.reload({waitUntil:'domcontentloaded'});await prepare(viewer,true);
    assert.equal(await viewer.evaluate(()=>App.getRatioDefinitions().length),1,'Tab-only ratio survives a reload');
    await viewer.evaluate(key=>App.activateRatio(key),personal.key);assertKnownRatios(await ratioSnapshot(viewer,personal.key));
    assert.deepEqual(await sourceSnapshot(viewer),personal.original);
    assert.deepEqual(state.writes,[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    await shared.close();console.log('Ratio browser shared Viewer: personal session, reload, no metadata/server writes PASS.');
  } finally {if(browser)await browser.close();await state.close();}
}
module.exports={fixture,archive,startServer,prepare,sourceSnapshot,createRatio,ratioSnapshot,capture,slug};
if(require.main===module)main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
