'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {createServer}=require('node:http'),{chromium}=require('playwright');
const JSZip=require('../vendor/jszip.min.js');
const {renderOfflineConfig}=require('../offline/config.cjs');
const root=path.resolve(__dirname,'..'),slug='synthetic-display-preferences';

function fixture() {
  const sources={};
  const sections=[1,2].map((factor,index)=>{
    const sourcePath='synthetic/display-'+index+'.csv',rows=['x,y,signal'];
    for(let y=0;y<32;y++)for(let x=0;x<64;x++) {
      const n=y*64+x+1;rows.push([x,y,(n===2048?10000:n)*factor].join(','));
    }
    sources[sourcePath]=rows.join('\n')+'\n';
    return {id:'server-'+index,client_id:'display-section-'+index,ordinal:index+1,display_name:'Synthetic '+index,
      meta:{displayTransform:{version:2,baseOrientation:'native-raster'},world_coords:{msi_um_per_px:{x:30,y:60}}},
      storage_paths:{images:{},msiSeries:{MSI_A:{path:sourcePath,mime:'text/csv',filename:'display-'+index+'.csv',
        kind:'txt',sourceFileId:'source-'+index,sourceReference:'source-revision-'+index,
        x:'x',y:'y',v:'signal',sep:',',bakeMode:'robust',compoundMeta:{base:'Synthetic',precursor:89,product:43}}}}};
  });
  return {sources,doc:{id:'shared-display-settings',slug,meta:{display_name:'Display settings fixture',
    project_meta:{colormap:'viridis',msiSmoothing:'none'}},sections,anatomy_palette:{}}};
}
async function sourceSnapshot(page) {
  return page.evaluate(async()=>{
    const sources=[];
    for(const section of App.project.sections)for(const [key,entry] of Object.entries(section.msiSeries||{})) {
      const panel=App.panels.get(section.id);await panel.ensureMsiLayerLoaded(key);
      const raster=panel.msiValueRasters.get(key),record=await ProjectStorage.getBlob(entry.blobId);
      const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await record.blob.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('');
      sources.push({id:section.id,key,hash,values:Array.from(raster.values),geometry:JSON.stringify(raster.sourceGeometry),
        pitch:section.meta.world_coords&&section.meta.world_coords.msi_um_per_px});
    }
    return {sources,rois:JSON.stringify(App.project.rois)};
  });
}
async function style(page,name) {
  await page.locator('#tb-msi-style').selectOption(name);
  await page.waitForFunction(expected=>!document.getElementById('tb-msi-style').disabled
    && App.getMsiDisplaySettings().preset===expected,name);
}
async function prepare(page) {
  await page.waitForFunction(()=>typeof App!=='undefined'&&App.project&&App.panels.size>0);
  await page.evaluate(async()=>{
    for(const section of App.project.sections)for(const key of Object.keys(section.msiSeries||{}))
      if(!await App.panels.get(section.id).ensureMsiLayerLoaded(key))throw new Error('Synthetic source failed');
    const section=App.project.sections[0],key=Object.keys(section.msiSeries)[0];
    App.setActiveSection(section.id);App.setFocusCompoundKey(key);App.recomputeMsiAbsScale();
  });
}
async function sharedReady(page,role) {
  await page.waitForFunction(expected=>typeof App!=='undefined'&&App.shareMode&&App.shareMode.role===expected&&App.panels.size===2,role);
  await page.waitForFunction(()=>typeof SharePreview!=='undefined'&&SharePreview.isOpen());
  await page.locator('[data-preview-close]').click();await prepare(page);
}
async function main() {
  const data=fixture(),writes=[],external=[],errors=[];let online=false;
  const server=createServer(async(req,res)=>{
    try {
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(pathname==='/runtime-config.js') {res.setHeader('Content-Type','text/javascript');res.end(online
        ? "Object.defineProperty(window,'DESI_BUILD_CONFIG',{value:Object.freeze({mode:'online',cloud:{url:"
          +JSON.stringify('http://'+req.headers.host)+",anonKey:'synthetic-display-key'}}),writable:false,configurable:false});"
        :renderOfflineConfig());return;}
      if(req.method==='POST'&&pathname.startsWith('/rest/v1/rpc/')) {
        const rpc=pathname.slice('/rest/v1/rpc/'.length);
        if(!['get_project_doc','list_rois','list_share_overlays','list_share_alignments','list_share_images'].includes(rpc)) {
          writes.push(pathname);res.writeHead(403);res.end('Unexpected write');return;
        }
        res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rpc==='get_project_doc'?data.doc:[]));return;
      }
      if(!['GET','HEAD'].includes(req.method)){writes.push(pathname);res.writeHead(405);res.end();return;}
      const prefix='/storage/v1/object/public/atlases/',source=data.sources[pathname.slice(prefix.length)];
      if(pathname.startsWith(prefix)&&source){res.setHeader('Content-Type','text/csv');res.end(source);return;}
      const file=path.resolve(root,'.'+pathname+(pathname.endsWith('/')?'index.html':''));
      if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
      res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html; charset=utf-8','.css':'text/css'})[path.extname(file)]||'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch(_){res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
    const context=await browser.newContext({viewport:{width:1920,height:1080}});
    await context.route('**/*',route=>{if(route.request().url().startsWith(origin+'/')||/^(blob|data):/.test(route.request().url()))return route.continue();external.push(route.request().url());return route.abort();});
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    await page.goto(origin+'/viewer/?project=display-test-empty');
    await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
    await page.locator('#hidden-import-input').setInputFiles(path.join(root,'tests/fixtures/browser/offline-smoke-project.zip'));
    await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();await prepare(page);
    await page.waitForFunction(()=>App.project.sections.every(section=>App._otsuIsFresh(section)&&Array.isArray(section.meta.visibleLayers)));
    const before=await sourceSnapshot(page),oldId=await page.evaluate(()=>App.project.id);
    const initial=await page.evaluate(async()=>({settings:App.getMsiDisplaySettings(),meta:App.project.meta,
      savedMeta:(await ProjectStorage.getProject(App.project.id)).meta}));
    assert.equal(initial.settings.aspectMode,'legacy');assert.equal(initial.settings.explicit,false);
    assert.equal(initial.meta.msiDisplay,undefined);assert.equal(initial.savedMeta.msiDisplay,undefined,
      'Opening an old ZIP does not persist an automatic style migration');
    await style(page,'hdi');
    assert.equal(await page.locator('#tb-msi-physical').isChecked(),true);
    assert.equal(await page.locator('#tb-colormap').inputValue(),'hotmetal');
    assert.equal(await page.locator('#tb-smoothing').inputValue(),'none');
    await page.evaluate(async()=>{if(await App._flushSave()===false)throw new Error('Save failed');});
    await page.reload();await prepare(page);
    assert.deepEqual(await page.evaluate(()=>App.project.meta.msiDisplay),
      {version:1,preset:'hdi',aspectMode:'physical',rangePolicy:'maximum'},'Saved style survives a real IndexedDB reload');
    assert.deepEqual(await sourceSnapshot(page),before,'Style save/reload preserves original bytes, raster values, calibration and ROI');
    const downloadReady=page.waitForEvent('download',{timeout:60000});
    await page.locator('#btn-export-zip').click();
    const archiveBytes=await fs.readFile(await (await downloadReady).path()),archive=await JSZip.loadAsync(archiveBytes);
    let manifest;
    for(const file of Object.keys(archive.files).filter(name=>name.endsWith('.json'))) {
      const candidate=JSON.parse(await archive.file(file).async('string'));
      if(candidate.format==='desi_data_share_v2'){manifest=candidate;break;}
    }
    assert.ok(manifest,'The actual Export ZIP contains its portable project manifest');
    assert.deepEqual(manifest.offlineSettings.meta.msiDisplay,
      {version:1,preset:'hdi',aspectMode:'physical',rangePolicy:'maximum'});
    assert.equal(manifest.offlineSettings.meta.colormap,'hotmetal');
    assert.equal(manifest.offlineSettings.meta.msiSmoothing,'none');
    await page.locator('#hidden-import-input').setInputFiles({name:'synthetic-hdi-roundtrip.zip',mimeType:'application/zip',buffer:archiveBytes});
    await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();
    await page.waitForFunction(id=>App.project&&App.project.id!==id,oldId);await prepare(page);
    assert.deepEqual(await page.evaluate(()=>App.project.meta.msiDisplay),manifest.offlineSettings.meta.msiDisplay,
      'Real ZIP import restores HDI metadata without changing measurements');
    const roundtrip=await sourceSnapshot(page);
    assert.deepEqual(roundtrip.sources.map(({hash,values,pitch})=>({hash,values,pitch})),
      before.sources.map(({hash,values,pitch})=>({hash,values,pitch})),'ZIP roundtrip preserves source bytes, values and calibration');
    await page.locator('#tb-msi-physical').uncheck();
    assert.equal(await page.evaluate(()=>App.getMsiDisplaySettings().aspectMode),'legacy');
    await style(page,'current');assert.equal(await page.locator('#tb-colormap').inputValue(),'plasma');
    await page.locator('#btn-new-project').click();
    await page.locator('input[name="name"]').fill('Synthetic new HDI project');
    await page.locator('input[name="experiment_date"]').fill('2026-11-04');
    await page.locator('input[name="sample_types"]').fill('synthetic');
    await page.locator('[data-modal-ok]').click();
    await page.waitForFunction(id=>App.project&&App.project.id!==id&&App.project.displayName==='Synthetic new HDI project',oldId);
    assert.deepEqual(await page.evaluate(()=>App.project.meta),
      {msiDisplay:{version:1,preset:'hdi',aspectMode:'physical',rangePolicy:'maximum'},colormap:'hotmetal',msiSmoothing:'none'},
      'The real New Project UI starts with HDI physical display preferences');
    await context.close();console.log('Local settings: old ZIP untouched, presets, physical toggle, save/reopen, ZIP roundtrip and New Project defaults PASS.');

    online=true;
    const shared=await browser.newContext({viewport:{width:1920,height:1080}});
    await shared.route('**/*',route=>{if(route.request().url().startsWith(origin+'/')||/^(blob|data):/.test(route.request().url()))return route.continue();external.push(route.request().url());return route.abort();});
    await shared.addInitScript(slug=>{const key='desi:share:'+slug;if(!sessionStorage.getItem(key))sessionStorage.setItem(key,
      JSON.stringify({slug,role:'viewer',token:'synthetic-viewer-token',expiresAt:new Date(Date.now()+3600000).toISOString(),isPublic:false}));},slug);
    const viewer=await shared.newPage();viewer.on('pageerror',error=>errors.push(error.message));viewer.on('dialog',dialog=>dialog.accept());
    await viewer.goto(origin+'/viewer/#share='+slug);await sharedReady(viewer,'viewer');
    const sharedSource=await sourceSnapshot(viewer),sharedMeta=await viewer.evaluate(()=>JSON.stringify(App.project.meta));
    assert.equal(await viewer.evaluate(()=>App.getMsiDisplaySettings().preset),'current');
    const windows=()=>viewer.evaluate(()=>App.project.sections.map(section=>{const key='MSI_A',entry=section.msiSeries[key];
      return App.getMsiWindow(key,entry.rawRange,entry.rawDispMax,entry.rawTrueMax);}));
    const legacy=await windows();
    assert.ok(legacy.every(value=>value.max<20000),'Old Same range retains percentile clipping: '+JSON.stringify(await viewer.evaluate(()=>({
      settings:App.getMsiDisplaySettings(),ranges:App.project.sections.map(section=>({window:App.getMsiWindow('MSI_A',section.msiSeries.MSI_A.rawRange,
        section.msiSeries.MSI_A.rawDispMax,section.msiSeries.MSI_A.rawTrueMax),range:section.msiSeries.MSI_A.rawRange,
        disp:section.msiSeries.MSI_A.rawDispMax,maximum:section.msiSeries.MSI_A.rawTrueMax,bakeMode:section.msiSeries.MSI_A.bakeMode}))}))));
    await style(viewer,'hdi');assert.deepEqual((await windows()).map(value=>value.max),[20000,20000]);
    await viewer.locator('#msi-scale-mode').selectOption('individual');
    assert.deepEqual((await windows()).map(value=>value.max),[10000,20000],'Individual uses each measured maximum');
    await viewer.locator('#tb-range-max').fill('333');await viewer.locator('#tb-range-max').blur();
    assert.deepEqual((await windows()).map(value=>value.max),[333,333],'Manual raw intensity overrides the auto policy');
    await style(viewer,'hdi');assert.deepEqual((await windows()).map(value=>value.max),[20000,20000],'Applying the preset resets manual windows');
    await viewer.locator('#tb-smoothing').selectOption('linear');
    assert.equal(await viewer.evaluate(()=>App.getMsiDisplaySettings().interpolation),'linear');
    assert.equal(await viewer.evaluate(()=>JSON.stringify(App.project.meta)),sharedMeta,'Viewer preferences never mutate shared metadata');
    await viewer.reload();await sharedReady(viewer,'viewer');
    assert.equal(await viewer.evaluate(()=>App.getMsiDisplaySettings().preset),'custom','Viewer custom style restores after reload');
    assert.equal(await viewer.evaluate(()=>App.msiSmoothing),'linear','The restored preference reaches the actual renderer');
    assert.equal(await viewer.locator('#tb-smoothing').inputValue(),'linear');
    await viewer.evaluate(slug=>{const key='desi:share:'+slug,session=JSON.parse(sessionStorage.getItem(key));session.role='admin';session.token='synthetic-admin-token';sessionStorage.setItem(key,JSON.stringify(session));},slug);
    await viewer.reload();await sharedReady(viewer,'admin');
    assert.equal(await viewer.evaluate(()=>App.getMsiDisplaySettings().preset),'current','Admin has independent preferences');
    assert.equal(await viewer.evaluate(()=>App.msiSmoothing),'none','Viewer interpolation does not leak into the admin role');
    await viewer.evaluate(slug=>{const key='desi:share:'+slug,session=JSON.parse(sessionStorage.getItem(key));session.role='viewer';session.token='synthetic-viewer-token';sessionStorage.setItem(key,JSON.stringify(session));},slug);
    await viewer.reload();await sharedReady(viewer,'viewer');
    assert.equal(await viewer.evaluate(()=>App.getMsiDisplaySettings().preset),'custom');
    assert.equal(await viewer.evaluate(()=>App.msiSmoothing),'linear');
    assert.equal(await viewer.locator('#tb-colormap').inputValue(),'hotmetal');
    assert.deepEqual(await sourceSnapshot(viewer),sharedSource,'Shared style/ranges/role changes preserve original bytes and source geometry');
    assert.equal(await viewer.evaluate(()=>JSON.stringify(App.project.meta)),sharedMeta);
    assert.deepEqual(writes,[],'Shared display preferences perform no server mutation');
    assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    await shared.close();console.log('Shared settings: maximum vs percentile, Same/Individual, manual range, role isolation and source preservation PASS.');
  } finally {if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
