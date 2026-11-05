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
      const geometry=raster.sourceGeometry,half=Math.max(1,Math.floor(raster.W/2));
      const polygon=[[-.5,-.5],[half-.5,-.5],[half-.5,raster.H-.5],[-.5,raster.H-.5]];
      const roi={geometryBySection:{[section.id]:{version:'msi-source-v1',sourceRef:geometry.sourceRef,
        displayGeometry:geometry.displayGeometry}}};
      const quant=await extractRoiRawFromSection(panel,key,polygon,roi);
      if(quant.unavailable||!quant.values.length)throw new Error('Synthetic ROI must quantify original source rows');
      sources.push({id:section.id,key,hash,values:Array.from(raster.values),geometry:JSON.stringify(raster.sourceGeometry),
        pitch:section.meta.world_coords&&section.meta.world_coords.msi_um_per_px,
        statistics:{mean:msiQuantMean(entry),max:msiMaxIntensity(entry).value},
        roi:{stats:calcStats(quant.values),rowIds:quant.rowIds,n:quant.values.length}});
    }
    return {sources,rois:JSON.stringify(App.project.rois)};
  });
}
async function style(page,name) {
  await page.locator('#tb-msi-style').selectOption(name);
  await page.waitForFunction(expected=>!document.getElementById('tb-msi-style').disabled
    && App.getMsiDisplaySettings().preset===expected,name);
}
async function strength(page,value) {
  const slider=page.locator('#tb-smoothing-strength');
  await slider.fill(String(value));
  await slider.dispatchEvent('change');
  await page.waitForFunction(expected=>App.msiSmoothing==='linear'
    ? App.msiLinearStrength===expected && App.getMsiDisplaySettings().linearStrength===expected
    : App.msiSmoothing==='median' && App.msiSmoothingStrength===expected && App.getMsiDisplaySettings().smoothingStrength===expected,value);
  assert.match(await page.locator('#tb-smoothing-strength-value').innerText(),new RegExp('\\b'+value+'\\b'));
}
async function displayedImage(page) {
  return page.evaluate(async()=>{
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const panel=App.panels.get(App.project.sections[0].id),canvas=panel.dom.cdisp;
    const pixels=panel.displayCtx.getImageData(0,0,canvas.width,canvas.height).data;
    if(!pixels.some((value,index)=>index%4!==3&&value>0))throw new Error('MSI display must contain visible colour');
    return canvas.toDataURL('image/png');
  });
}
async function alignmentSample(page,level) {
  await page.locator('#tb-smoothing').selectOption('linear');await strength(page,level);
  const key=await page.evaluate(()=>{
    const panel=App.panels.get(App.project.sections[0].id);
    void Wizards.openAlignmentModal(panel);
    return App.focusCompoundKey;
  });
  await page.locator('[data-align-msi]').selectOption(key);
  await page.waitForFunction(()=>{
    const msi=document.querySelector('[data-msi-img]'),he=document.querySelector('[data-he-img]');
    return msi&&he&&msi.dataset.ready==='true'&&he.dataset.ready==='true';
  });
  const card=page.locator('.alignment-card'),image=card.locator('[data-msi-img]');
  await card.locator('[data-pick="msi"]').click();
  const rect=await image.boundingBox();assert.ok(rect&&rect.width>0&&rect.height>0);
  await image.click({position:{x:rect.width*0.25,y:rect.height*0.625}});
  await page.waitForFunction(()=>document.querySelector('[data-msi-svg] circle'));
  const geometry=await card.evaluate(element=>{
    const img=element.querySelector('[data-msi-img]'),marker=element.querySelector('[data-msi-svg] circle');
    const rect=img.getBoundingClientRect();
    return {ss:Number(img.dataset.ss),width:img.naturalWidth/Number(img.dataset.ss),height:img.naturalHeight/Number(img.dataset.ss),
      point:element.querySelector('[data-lm-table] tbody tr').children[2].textContent,
      markerX:Number(marker.getAttribute('cx'))/rect.width,markerY:Number(marker.getAttribute('cy'))/rect.height};
  });
  assert.ok(Math.abs(geometry.markerX-.25)<.005&&Math.abs(geometry.markerY-.625)<.005,
    'Align marker remains on its clicked display pixel at Linear '+level);
  await card.getByRole('button',{name:'重ね合わせ',exact:true}).click();
  await card.getByRole('slider',{name:'MSI の濃さ',exact:true}).fill('1');
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const composite=await card.evaluate(element=>{
    const output=element.querySelector('.msi-align-composite canvas'),msi=element.querySelector('[data-msi-img]'),he=element.querySelector('[data-he-img]');
    const pixels=output.getContext('2d').getImageData(0,0,output.width,output.height).data;
    const hw=he.naturalWidth/Number(he.dataset.ss),hh=he.naturalHeight/Number(he.dataset.ss);
    const mw=msi.naturalWidth/Number(msi.dataset.ss),mh=msi.naturalHeight/Number(msi.dataset.ss);
    const scale=Math.min(output.width/Math.max(hw,mw),output.height/Math.max(hh,mh));
    const matches=linear=>{
      const canvas=document.createElement('canvas');canvas.width=output.width;canvas.height=output.height;
      const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=true;
      ctx.drawImage(he,(canvas.width-hw*scale)/2,(canvas.height-hh*scale)/2,hw*scale,hh*scale);
      ctx.imageSmoothingEnabled=linear;
      ctx.drawImage(msi,(canvas.width-mw*scale)/2,(canvas.height-mh*scale)/2,mw*scale,mh*scale);
      return ctx.getImageData(0,0,canvas.width,canvas.height).data.every((value,index)=>value===pixels[index]);
    };
    return {linear:matches(true),nearest:matches(false),width:output.width,height:output.height};
  });
  assert.ok(composite.width>0&&composite.height>0);
  if(level===10) {assert.equal(composite.linear,true,'Align composite retains full Linear at 10');assert.equal(composite.nearest,false);}
  else {assert.equal(composite.nearest,true,'Align composite does not reapply Linear over a baked partial blend');assert.equal(composite.linear,false);}
  await card.locator('[data-modal-cancel]').click();await card.waitFor({state:'detached'});
  return geometry;
}
async function displayRanges(page) {
  return page.evaluate(()=>App.project.sections.flatMap(section=>Object.entries(section.msiSeries||{}).map(([key,entry])=>({
    id:section.id,key,window:App.getMsiWindow(key,entry.rawRange,entry.rawDispMax,entry.rawTrueMax)}))));
}
async function screenshot(page,name) {
  const directory=process.env.MSI_DISPLAY_SCREENSHOT_DIR;
  if(!directory)return;
  await fs.mkdir(directory,{recursive:true});
  await page.screenshot({path:path.join(directory,name+'.png'),fullPage:false});
}
async function prepare(page) {
  await page.waitForFunction(()=>typeof App!=='undefined'&&App.project&&App.panels.size>0);
  await page.evaluate(async()=>{
    for(const section of App.project.sections)for(const key of Object.keys(section.msiSeries||{}))
      if(!await App.panels.get(section.id).ensureMsiLayerLoaded(key))throw new Error('Synthetic source failed');
    const section=App.project.sections[0],key=Object.keys(section.msiSeries)[0];
    App.setActiveSection(section.id);App.setViewMode('compound');App.setFocusCompoundKey(key);App.recomputeMsiAbsScale();
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
    // Keep the old-format archive and its optional HE image, but use a larger
    // noisy MSI source so all ten median neighbourhoods are observably distinct.
    // The original 8x8 source cannot distinguish kernels larger than the image.
    const oldArchive=await JSZip.loadAsync(await fs.readFile(path.join(root,'tests/fixtures/browser/offline-smoke-project.zip')));
    const noisyRows=['x,y,signal'];
    for(let y=0;y<32;y++)for(let x=0;x<32;x++)noisyRows.push([x,y,1+(x*17+y*31+(x*y)%13)%257].join(','));
    oldArchive.file('Source/smoke.csv',noisyRows.join('\n')+'\n');
    await page.locator('#hidden-import-input').setInputFiles({name:'old-noisy-msi.zip',mimeType:'application/zip',
      buffer:await oldArchive.generateAsync({type:'nodebuffer'})});
    await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();await prepare(page);
    await page.waitForFunction(()=>App.project.sections.every(section=>App._otsuIsFresh(section)&&Array.isArray(section.meta.visibleLayers)));
    const before=await sourceSnapshot(page),oldId=await page.evaluate(()=>App.project.id);
    const initial=await page.evaluate(async()=>({settings:App.getMsiDisplaySettings(),meta:App.project.meta,
      savedMeta:(await ProjectStorage.getProject(App.project.id)).meta}));
    assert.equal(initial.settings.aspectMode,'legacy');assert.equal(initial.settings.explicit,false);
    assert.equal(initial.meta.msiDisplay,undefined);assert.equal(initial.savedMeta.msiDisplay,undefined,
      'Opening an old ZIP does not persist an automatic style migration');
    assert.equal(initial.settings.smoothingStrength,1);assert.equal(initial.settings.linearStrength,10,'Old archives retain the unchanged Linear interpolation amount');
    const slider=page.locator('#tb-smoothing-strength');
    assert.equal(await slider.getAttribute('min'),'1');assert.equal(await slider.getAttribute('max'),'10');
    assert.equal(await slider.getAttribute('step'),'1');
    await style(page,'hdi');
    assert.equal(await page.locator('#tb-msi-physical').isChecked(),true);
    assert.equal(await page.locator('#tb-colormap').inputValue(),'hotmetal');
    assert.equal(await page.locator('#tb-smoothing').inputValue(),'none');
    assert.equal(await slider.isDisabled(),true,'None disables the strength slider');
    const originalNone=await displayedImage(page),originalRanges=await displayRanges(page);
    await page.locator('#tb-smoothing').selectOption('linear');
    assert.equal(await slider.isEnabled(),true);assert.equal(await slider.inputValue(),'10');
    const originalLinear=await displayedImage(page);
    assert.equal(await page.evaluate(()=>App.deferMsiSmoothingDrag()),false,'The small synthetic source uses live updates');
    await slider.evaluate(element=>{element.value='4';element.dispatchEvent(new Event('input',{bubbles:true}));});
    assert.equal(await page.evaluate(()=>App.msiLinearStrength),4,'Small images respond to input without waiting for change');
    assert.notEqual(await displayedImage(page),originalLinear);
    const linearImages=new Set();
    for(let level=1;level<=10;level++) {
      await strength(page,level);linearImages.add(await displayedImage(page));
    }
    assert.equal(linearImages.size,10,'All ten Linear levels yield distinct rendered pixels');
    assert.equal(await displayedImage(page),originalLinear,'Linear-10 is exactly the original full interpolation');
    assert.deepEqual(await sourceSnapshot(page),before,'All ten Linear levels preserve source bytes and ROI statistics');
    const fullAlign=await alignmentSample(page,10),partialAlign=await alignmentSample(page,4);
    assert.equal(fullAlign.ss,1);assert.ok(partialAlign.ss>1,'Partial Linear is baked at enlarged resolution in Align');
    assert.equal(partialAlign.width,fullAlign.width);assert.equal(partialAlign.height,fullAlign.height);
    assert.equal(partialAlign.point,fullAlign.point,'Supersampling never changes the raw MSI landmark coordinate');
    assert.deepEqual(await sourceSnapshot(page),before,'Opening and cancelling Align leaves source values, geometry and ROI statistics unchanged');
    await strength(page,10);
    await page.locator('#tb-smoothing').selectOption('median');
    assert.equal(await slider.inputValue(),'1','Median starts at its own weakest level');
    const weakestMedian=await displayedImage(page);
    // Exercise the large-image event path without allocating a giant test image.
    // Only the workload predicate is replaced; the real input/change handlers,
    // state/persistence path and canvas renderer remain in use.
    await page.evaluate(()=>{
      window.__originalSmoothingDragPredicate=App.deferMsiSmoothingDrag;
      App.deferMsiSmoothingDrag=()=>true;
    });
    try {
      await slider.evaluate(element=>{element.value='9';element.dispatchEvent(new Event('input',{bubbles:true}));});
      assert.match(await page.locator('#tb-smoothing-strength-value').innerText(),/\b9\b/,'Dragging a large image updates the displayed value');
      assert.equal(await page.evaluate(()=>App.msiSmoothingStrength),1,'Large-image input does not commit strength');
      assert.equal(await page.evaluate(()=>App.project.meta.msiDisplay.smoothingStrength),1,'Large-image input does not change saved preferences');
      assert.equal(await displayedImage(page),weakestMedian,'Large-image input leaves rendered pixels unchanged until release');
      await slider.dispatchEvent('change');
      await page.waitForFunction(()=>App.msiSmoothingStrength===9);
      assert.equal(await page.evaluate(()=>App.project.meta.msiDisplay.smoothingStrength),9,'Release commits the final strength');
      assert.notEqual(await displayedImage(page),weakestMedian,'Release redraws the large-image path');
      assert.deepEqual(await sourceSnapshot(page),before,'Deferred smoothing preserves source data and ROI quantification');
    } finally {
      await page.evaluate(()=>{App.deferMsiSmoothingDrag=window.__originalSmoothingDragPredicate;delete window.__originalSmoothingDragPredicate;});
    }
    const medianImages=new Set();
    for(let level=1;level<=10;level++) {
      await strength(page,level);medianImages.add(await displayedImage(page));
    }
    assert.equal(medianImages.size,10,'All ten Median levels change the noisy synthetic image');
    assert.deepEqual(await sourceSnapshot(page),before,'Smoothing leaves source bytes, values, ROI quantification and geometry intact');
    assert.deepEqual(await displayRanges(page),originalRanges,'Strength changes do not adjust intensity windows');
    await page.locator('#tb-smoothing').selectOption('none');
    assert.equal(await slider.isDisabled(),true);
    assert.equal(await displayedImage(page),originalNone,'None ignores the remembered strength and restores original pixels');
    await page.locator('#tb-smoothing').selectOption('linear');
    assert.equal(await slider.inputValue(),'10','Returning to Linear preserves its independent chosen strength');
    assert.equal(await displayedImage(page),originalLinear,'Linear-10 restores the original Linear pixels exactly');
    await strength(page,3);
    await page.locator('#tb-smoothing').selectOption('median');
    assert.equal(await slider.inputValue(),'10','Returning to Median preserves its independent chosen strength');
    await strength(page,6);
    await screenshot(page,'smoothing-local-median-6');
    await page.evaluate(async()=>{if(await App._flushSave()===false)throw new Error('Save failed');});
    await page.reload();await prepare(page);
    assert.deepEqual(await page.evaluate(()=>App.project.meta.msiDisplay),
      {version:2,preset:'custom',aspectMode:'physical',rangePolicy:'maximum',smoothingStrength:6,linearStrength:3},'Saved style and both strengths survive a real IndexedDB reload');
    assert.equal(await slider.inputValue(),'6');
    assert.equal(await page.evaluate(()=>App.msiSmoothing),'median');
    assert.equal(await page.evaluate(()=>App.msiSmoothingStrength),6);assert.equal(await page.evaluate(()=>App.msiLinearStrength),3);
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
      {version:2,preset:'custom',aspectMode:'physical',rangePolicy:'maximum',smoothingStrength:6,linearStrength:3});
    assert.equal(manifest.offlineSettings.meta.colormap,'hotmetal');
    assert.equal(manifest.offlineSettings.meta.msiSmoothing,'median');
    await page.locator('#hidden-import-input').setInputFiles({name:'synthetic-hdi-roundtrip.zip',mimeType:'application/zip',buffer:archiveBytes});
    await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();
    await page.waitForFunction(id=>App.project&&App.project.id!==id,oldId);await prepare(page);
    assert.deepEqual(await page.evaluate(()=>App.project.meta.msiDisplay),manifest.offlineSettings.meta.msiDisplay,
      'Real ZIP import restores display strength without changing measurements');
    assert.equal(await slider.inputValue(),'6');
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
      {msiDisplay:{version:2,preset:'hdi',aspectMode:'physical',rangePolicy:'maximum',smoothingStrength:1,linearStrength:10},colormap:'hotmetal',msiSmoothing:'none'},
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
    assert.equal(await viewer.locator('#tb-smoothing-strength').inputValue(),'10');
    const sharedLinear=await displayedImage(viewer);
    await strength(viewer,4);
    assert.notEqual(await displayedImage(viewer),sharedLinear,'Shared viewer strength reaches the real MSI canvas');
    await viewer.locator('#tb-smoothing').selectOption('median');await strength(viewer,8);
    await screenshot(viewer,'smoothing-shared-median-8');
    assert.equal(await viewer.evaluate(()=>JSON.stringify(App.project.meta)),sharedMeta,'Viewer preferences never mutate shared metadata');
    await viewer.reload();await sharedReady(viewer,'viewer');
    assert.equal(await viewer.evaluate(()=>App.getMsiDisplaySettings().preset),'custom','Viewer custom style restores after reload');
    assert.equal(await viewer.evaluate(()=>App.msiSmoothing),'median','The restored preference reaches the actual renderer');
    assert.equal(await viewer.locator('#tb-smoothing').inputValue(),'median');
    assert.equal(await viewer.evaluate(()=>App.msiSmoothingStrength),8);assert.equal(await viewer.evaluate(()=>App.msiLinearStrength),4);
    assert.equal(await viewer.locator('#tb-smoothing-strength').inputValue(),'8');
    await viewer.evaluate(slug=>{const key='desi:share:'+slug,session=JSON.parse(sessionStorage.getItem(key));session.role='admin';session.token='synthetic-admin-token';sessionStorage.setItem(key,JSON.stringify(session));},slug);
    await viewer.reload();await sharedReady(viewer,'admin');
    assert.equal(await viewer.evaluate(()=>App.getMsiDisplaySettings().preset),'current','Admin has independent preferences');
    assert.equal(await viewer.evaluate(()=>App.msiSmoothing),'none','Viewer interpolation does not leak into the admin role');
    assert.equal(await viewer.evaluate(()=>App.msiSmoothingStrength),1,'Viewer Median strength does not leak into the admin role');
    assert.equal(await viewer.evaluate(()=>App.msiLinearStrength),10,'Viewer Linear strength does not leak into the admin role');
    assert.equal(await viewer.locator('#tb-smoothing-strength').isDisabled(),true);
    await viewer.evaluate(slug=>{const key='desi:share:'+slug,session=JSON.parse(sessionStorage.getItem(key));session.role='viewer';session.token='synthetic-viewer-token';sessionStorage.setItem(key,JSON.stringify(session));},slug);
    await viewer.reload();await sharedReady(viewer,'viewer');
    assert.equal(await viewer.evaluate(()=>App.getMsiDisplaySettings().preset),'custom');
    assert.equal(await viewer.evaluate(()=>App.msiSmoothing),'median');
    assert.equal(await viewer.evaluate(()=>App.msiSmoothingStrength),8,'Returning to viewer restores its Median strength');
    await viewer.locator('#tb-smoothing').selectOption('linear');
    assert.equal(await viewer.locator('#tb-smoothing-strength').inputValue(),'4','Returning to Linear restores the viewer interpolation amount');
    assert.equal(await viewer.locator('#tb-colormap').inputValue(),'hotmetal');
    assert.deepEqual(await sourceSnapshot(viewer),sharedSource,'Shared style/ranges/role changes preserve original bytes and source geometry');
    assert.equal(await viewer.evaluate(()=>JSON.stringify(App.project.meta)),sharedMeta);
    assert.deepEqual(writes,[],'Shared display preferences perform no server mutation');
    assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    await shared.close();console.log('Shared settings: maximum vs percentile, Same/Individual, manual range, role isolation and source preservation PASS.');
  } finally {if(browser)await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
