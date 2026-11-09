'use strict';
// Real viewer, IndexedDB, workers and canvas. All data is synthetic and all
// network access is restricted to this local server. Gates model a slow source
// deterministically; elapsed times are reported, never used as pass thresholds.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createServer} = require('node:http');
const {chromium} = require('playwright');
const JSZip = require('../vendor/jszip.min.js');
const {renderOfflineConfig} = require('../offline/config.cjs');
const root = path.resolve(__dirname, '..');

async function installFixture(page) {
  await page.evaluate(() => {
    const state = window.__fast = {events:[], reads:{}, readStacks:{}, parses:{}, gates:new Map(), parseGates:new Map(), openDone:false};
    state.note = (type, detail) => state.events.push({type, detail, at:performance.now()});
    const paintedSections=new Set(),render=SectionPanel.prototype.renderComposite;
    SectionPanel.prototype.renderComposite=function() {
      const result=render.apply(this,arguments),id=this.section&&this.section.id,canvas=this.dom&&this.dom.cdisp;
      if(!paintedSections.has(id)&&this.isMsiLayerReady('MSI_A')&&canvas?.width&&canvas?.height) {
        const pixels=this.displayCtx.getImageData(0,0,canvas.width,canvas.height).data;
        if(pixels.some((value,i)=>i%4!==3&&value>0)){paintedSections.add(id);state.note('first-msi-paint',id);}
      }
      return result;
    };
    state.hold = id => { let release;const promise=new Promise(resolve=>{release=resolve;});state.gates.set(id,{promise,release}); };
    state.release = id => { const gate=state.gates.get(id);if(gate){state.gates.delete(id);gate.release();} };
    state.holdParse = op => {let release;const promise=new Promise(resolve=>{release=resolve;});state.parseGates.set(op,{promise,release});};
    state.releaseParse = op => {const gate=state.parseGates.get(op);if(gate){state.parseGates.delete(op);gate.release();}};
    const getBlob = ProjectStorage.getBlob;
    ProjectStorage.getBlob = async function(id) {
      state.reads[id]=(state.reads[id]||0)+1;state.note('read',id);
      state.readStacks[id]=new Error().stack;
      const gate=state.gates.get(id);if(gate)await gate.promise;
      return getBlob.apply(this,arguments);
    };
    const parse = callParseWorker;
    callParseWorker = function(op,payload,timeout) {
      state.parses[op]=(state.parses[op]||0)+1;state.note('parse',op);
      const gate=state.parseGates.get(op);
      return gate?gate.promise.then(()=>parse(op,payload,timeout)):parse(op,payload,timeout);
    };
    state.seed = async ({id,sections,selected}) => {
      const project={id,displayName:id,meta:{colormap:'hotmetal',msiSmoothing:'none',
        msiDisplay:{version:2,preset:'hdi',aspectMode:'physical',rangePolicy:'maximum',smoothingStrength:1,linearStrength:10}},
        sections:[],rois:[],roiHidden:{},memo:{},anatomyPalette:{}};
      for(let index=0;index<sections.length;index++) {
        const config=sections[index],sid=id+'-s'+index,factor=config.factor||1;
        const section={id:sid,displayName:'Synthetic '+index,images:{},msiSeries:{},meta:{
          visibleLayers:['MSI_A',...(config.visibleHe?['HE_STAIN_VISIBLE']:[]),...(config.tic?['HE_STAIN_TIC']:[])],
          world_coords:{msi_um_per_px:{x:30,y:60}},displayTransform:{version:2,baseOrientation:'native-raster'}}};
        for(let layer=0;layer<(config.layers||1);layer++) {
          const key='MSI_'+String.fromCharCode(65+layer),bid=sid+'-'+key,lines=['x,y,signal'];
          for(let y=0;y<8;y++)for(let x=0;x<8;x++)lines.push([x,y,(1+x+y*8)*factor*(layer+1)].join(','));
          // Real zeros, missing measurements and duplicate coordinates remain
          // distinguishable from the cache's display-only grayscale pixels.
          lines.push([0,0,0].join(','));
          const blob=new Blob([lines.join('\n')+'\n'],{type:'text/csv'});
          await ProjectStorage.putBlob({id:bid,filename:bid+'.csv',mime:'text/csv',blob});
          section.msiSeries[key]={blobId:bid,kind:'txt',filename:bid+'.csv',mime:'text/csv',
            sourceFileId:bid,sourceRevision:'fixture-v1',x:'x',y:'y',v:'signal',sep:',',bakeMode:'full',
            rasterW:8,rasterH:8,rawRange:[0,64*factor*(layer+1)],rawDispMax:64*factor*(layer+1),
            rawTrueMax:64*factor*(layer+1),compoundMeta:{base:key,name:key}};
        }
        for(const kind of ['visibleHe','hiddenHe'])if(config[kind]) {
          const key=kind==='visibleHe'?'HE_STAIN_VISIBLE':'HE_STAIN_HIDDEN',bid=sid+'-'+key;
          const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;
          const ctx=canvas.getContext('2d');ctx.fillStyle=kind==='visibleHe'?'#dd3355':'#22bb66';ctx.fillRect(0,0,16,16);
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
          await ProjectStorage.putBlob({id:bid,filename:bid+'.png',mime:'image/png',blob});
          section.images[key]={blobId:bid,filename:bid+'.png',mime:'image/png'};
        }
        project.sections.push(section);
      }
      await ProjectStorage.putProject(project,{createOnly:true});
      if(selected)sessionStorage.setItem(SectionVisibility.contextKey(project,null),JSON.stringify({
        known:project.sections.map(s=>s.id),selected:selected.map(index=>project.sections[index].id)}));
      return project.sections.map(s=>s.id);
    };
    state.open = (id,viewMode='compound') => {
      state.openDone=false;state.note('open',id);App.focusCompoundKey='MSI_A';App.viewMode=viewMode;
      state.openPromise=App.openProject(id).then(()=>{state.openDone=true;state.note('open-done',id);});
    };
    state.painted = sid => {
      const panel=App.panels.get(sid),canvas=panel&&panel.dom&&panel.dom.cdisp;
      if(!panel||!panel.isMsiLayerReady('MSI_A')||!canvas||!canvas.width||!canvas.height)return false;
      const pixels=panel.displayCtx.getImageData(0,0,canvas.width,canvas.height).data;
      return pixels.some((value,i)=>i%4!==3&&value>0);
    };
    state.snapshot = () => App.project.sections.map(section=>{
      const panel=App.panels.get(section.id),ent=section.msiSeries.MSI_A;
      const raster=panel&&panel.msiValueRasters.get('MSI_A');
      const lut=panel?._msiLutCache?.get('MSI_A')?.canvas;
      return {id:section.id,values:raster?Array.from(raster.values):null,
        pixels:lut?Array.from(lut.getContext('2d').getImageData(0,0,lut.width,lut.height).data):null,
        stats:ent.sourceStats||null,window:App.getMsiWindow('MSI_A',ent.rawRange,ent.rawDispMax,ent.rawTrueMax,section)};
    });
  });
}

async function frames(page) {
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function foreground(page) {
  await page.evaluate(async()=>{
    await window.__fast.openPromise;
    if(App.whenForegroundIdle)await App.whenForegroundIdle();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
  });
}
async function testPriority(page) {
  const ids=await page.evaluate(()=>__fast.seed({id:'fast-priority',sections:[
    {factor:1,visibleHe:true,hiddenHe:true},{factor:3,hiddenHe:true},{factor:7,hiddenHe:true}],selected:[0,1]}));
  const slow=ids[0]+'-HE_STAIN_VISIBLE';
  await page.evaluate(({slow})=>{__fast.hold(slow);__fast.open('fast-priority');},{slow});
  await page.waitForFunction(id=>__fast.painted(id),ids[1]);
  assert.equal(await page.evaluate(id=>__fast.gates.has(id),slow),true,'Fast second section paints while the first HE is held');
  assert.equal(await page.evaluate(id=>__fast.reads[id]||0,ids[1]+'-HE_STAIN_HIDDEN'),0,'Unselected HE is not decoded to display MSI');
  assert.equal(await page.evaluate(id=>__fast.reads[id]||0,ids[2]+'-MSI_A'),0,'Unselected section is not parsed at initial display');
  const before=await page.evaluate(()=>__fast.snapshot());
  assert.equal(before[1].window.max,192,'Same scale includes both selected sections even while one is waiting');
  await page.evaluate(id=>__fast.release(id),slow);await foreground(page);
  const after=await page.evaluate(()=>__fast.snapshot());
  assert.deepEqual(after[1].values,before[1].values,'Late HE cannot change original MSI values');
  assert.deepEqual(after[1].stats,before[1].stats,'Late HE cannot change source-row statistics');
  assert.deepEqual(after[1].window,before[1].window,'Late HE cannot change Same scope');
  assert.deepEqual(after[1].pixels,before[1].pixels,'Late HE cannot change MSI colormap bytes');
  await page.evaluate(id=>App.sectionVisibility().change([id],true),ids[2]);
  await page.waitForFunction(id=>__fast.painted(id),ids[2]);await frames(page);
  assert.equal((await page.evaluate(()=>__fast.snapshot()))[1].window.max,448,'Explicit selection adds the new section to Same scope');
  console.log('PASS first useful MSI before slow first HE; hidden HE/section remain unloaded; Same range preserved');
}

async function testPreviewPending(page) {
  const ids=await page.evaluate(async()=>{
    const ids=await __fast.seed({id:'fast-preview',sections:[{factor:1,hiddenHe:true},{factor:3,hiddenHe:true},{factor:7,hiddenHe:true}],selected:[0,1]});
    const project=await ProjectStorage.getProject('fast-preview'),entry=project.sections[1].msiSeries.MSI_A;
    for(const key of ['rawRange','rawDispMax','rawTrueMax','sourceStats'])delete entry[key];
    await ProjectStorage.putProject(project);return ids;
  });
  const missing=ids[1]+'-MSI_A';
  await page.evaluate(id=>{__fast.hold(id);__fast.open('fast-preview');},missing);
  await page.waitForFunction(id=>__fast.openDone&&App.panels.get(id)?.isMsiLayerReady('MSI_A'),ids[0]);
  assert.equal(await page.evaluate(()=>App.getCommonScaleStatus('MSI_A')),'pending');
  assert.equal(await page.evaluate(id=>__fast.painted(id),ids[0]),false,'Same scale cannot draw a misleading partial range');
  await page.evaluate(()=>SharePreview.open(App.project,'admin'));await frames(page);
  assert.equal(await page.locator('[data-preview-range-max]').isDisabled(),true,'Preview range stays disabled while a selected summary is missing');
  assert.equal(await page.locator('[data-cell-img]').count(),0,'Preview does not snapshot a partial Same scale');
  assert.equal(await page.evaluate(id=>__fast.reads[id]||0,ids[2]+'-MSI_A'),0,'Preview respects unselected section scope');
  await page.evaluate(id=>__fast.release(id),missing);await foreground(page);
  await page.waitForFunction(()=>SharePreview.overlay?.querySelectorAll('[data-cell-img]').length===2);
  await page.waitForFunction(()=>!SharePreview.overlay?.querySelector('[data-preview-range-max]')?.disabled);
  assert.equal((await page.evaluate(()=>__fast.snapshot()))[0].window.max,192);
  await page.waitForFunction(ids=>ids.every(id=>App.panels.get(id)?.imageSources.HE_STAIN_HIDDEN),ids.slice(0,2));
  assert.equal(await page.evaluate(id=>__fast.reads[id]||0,ids[2]+'-HE_STAIN_HIDDEN'),0,'Preview requests optical backdrops only for selected sections');
  await page.evaluate(()=>SharePreview.close());await frames(page);
  assert.equal(await page.evaluate(id=>App.panels.get(id).visibleLayers.has('HE_STAIN_HIDDEN'),ids[0]),false,'Closing Preview restores hidden optical visibility');
  console.log('PASS pending Same range masks Preview until complete; selected optical backdrops load on demand');
}

async function testReportReferences(page) {
  const ids=await page.evaluate(()=>__fast.seed({id:'fast-report',sections:[{factor:1,hiddenHe:true}]}));
  await page.evaluate(()=>__fast.open('fast-report'));await foreground(page);
  const imageId=ids[0]+'-HE_STAIN_HIDDEN';
  assert.equal(await page.evaluate(id=>__fast.reads[id]||0,imageId),0,
    'Report optical image begins unloaded: '+await page.evaluate(id=>__fast.readStacks[id]||'',imageId));
  const downloadPromise=page.waitForEvent('download',{timeout:90000});
  await page.locator('#btn-export-ppt').click();await page.locator('[data-report-create]').click();
  const download=await downloadPromise;
  const zip=await JSZip.loadAsync(await fs.readFile(await download.path()));
  const slidePaths=Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name));
  const xml=(await Promise.all(slidePaths.map(name=>zip.file(name).async('string')))).join('\n');
  assert.match(xml,/Optical/,'PPT explicitly obtains the registered optical reference even when its layer was hidden');
  assert.ok(await page.evaluate(id=>__fast.reads[id]>0,imageId),'Export reads the hidden optical original on demand');
  console.log('PASS PPT loads an initially hidden optical reference');
}

async function testTic(page,origin) {
  const ids=await page.evaluate(()=>__fast.seed({id:'fast-tic',sections:[{factor:1,layers:3,tic:true}]}));
  await page.evaluate(()=>{__fast.holdParse('tic-step');__fast.open('fast-tic');});
  await page.waitForFunction(id=>__fast.painted(id),ids[0]);
  await foreground(page);
  await page.waitForFunction(()=>(__fast.parses['tic-step']||0)>0);
  assert.equal(await page.evaluate(id=>!!App.panels.get(id).imageSources.HE_STAIN_TIC,ids[0]),false,
    'First useful MSI and foreground-ready state do not await automatic TIC');
  // Settle ordinary thumbnail-derived statistics before isolating TIC's writes.
  await page.evaluate(async id=>{
    const panel=App.panels.get(id);
    for(const key of Object.keys(panel.section.msiSeries))await panel.ensureMsiLayerLoaded(key);
    await App._flushSave();
    __fast.ticBaseline={project:JSON.stringify(App.project),revision:(await ProjectStorage.getProject(App.project.id)).storageRevision,
      snapshots:__fast.snapshot()};
    __fast.ticWrites={save:0,publish:0};
    const queueSave=App.queueSave,schedulePublish=App._scheduleAutoPublish;
    App.queueSave=function(){__fast.ticWrites.save++;return queueSave.apply(this,arguments);};
    App._scheduleAutoPublish=function(){__fast.ticWrites.publish++;return schedulePublish.apply(this,arguments);};
  },ids[0]);
  await page.evaluate(()=>__fast.releaseParse('tic-step'));
  await page.waitForFunction(id=>App.panels.get(id)._ticJob?.state==='ready',ids[0]);
  const original=await page.evaluate(async id=>{
    const panel=App.panels.get(id);await App._flushSave();
    return {dataUrl:panel.imageDataUrls.HE_STAIN_TIC,steps:__fast.parses['tic-step']||0,
      project:JSON.stringify(App.project),revision:(await ProjectStorage.getProject(App.project.id)).storageRevision,
      snapshots:__fast.snapshot(),baseline:__fast.ticBaseline,writes:__fast.ticWrites};
  },ids[0]);
  assert.equal(original.steps,3,'TIC visits each registered source once');
  assert.ok(original.dataUrl?.startsWith('data:image/png'),'Complete TIC is displayed');
  assert.equal(original.project,original.baseline.project,'TIC completion does not mutate the project document');
  assert.equal(original.revision,original.baseline.revision,'TIC cache writes do not save the project or create a publish revision');
  assert.deepEqual(original.writes,{save:0,publish:0},'TIC completion does not schedule save or automatic publication');
  assert.deepEqual(original.snapshots,original.baseline.snapshots,'TIC preserves values, source statistics and display windows');
  // Recreate the page/runtime so this tests IndexedDB rather than the small
  // in-memory cache; use the same source bytes and durable blob identities.
  await page.goto(origin+'/viewer/?project=fast-display-empty');
  await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline&&!App.project);
  await installFixture(page);await page.evaluate(()=>__fast.open('fast-tic'));await foreground(page);
  await page.waitForFunction(id=>App.panels.get(id)._ticJob?.state==='ready',ids[0]);
  const repeat=await page.evaluate(id=>({dataUrl:App.panels.get(id).imageDataUrls.HE_STAIN_TIC,
    cacheHit:App.panels.get(id)._ticJob.cacheHit,steps:__fast.parses['tic-step']||0}),ids[0]);
  assert.equal(repeat.steps,0,'Reloaded durable TIC cache requires zero TIC source parses');
  assert.equal(repeat.cacheHit,true);assert.equal(repeat.dataUrl,original.dataUrl,'Warm TIC pixels exactly match the cold result');
  for(const corruption of ['invalid-bytes','wrong-dimensions']) {
    await page.evaluate(async ({id,corruption})=>{
      const panel=App.panels.get(id),canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const blob=corruption==='invalid-bytes'?new Blob(['invalid image'],{type:'image/png'})
        :await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      await TicCache.create().put(panel._ticSignature,blob,8,8);
    },{id:ids[0],corruption});
    await page.goto(origin+'/viewer/?project=fast-display-empty');
    await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline&&!App.project);
    await installFixture(page);await page.evaluate(()=>__fast.open('fast-tic'));await foreground(page);
    await page.waitForFunction(id=>App.panels.get(id)._ticJob?.state==='ready',ids[0]);
    assert.equal(await page.evaluate(()=>__fast.parses['tic-step']||0),3,'Cached PNG '+corruption+' regenerates from originals');
    assert.equal(await page.evaluate(id=>App.panels.get(id).imageDataUrls.HE_STAIN_TIC,ids[0]),original.dataUrl);
  }
  console.log('PASS first MSI before TIC; complete TIC caches across reload without project writes or numeric changes');
}

async function testTicOnly(page) {
  const style=await page.addStyleTag({content:'.sec-thumbs-cell { display:none !important; }'});
  const ids=await page.evaluate(async()=>{
    const ids=await __fast.seed({id:'fast-tic-only',sections:[{factor:1,layers:2,tic:true}]});
    const project=await ProjectStorage.getProject('fast-tic-only');project.sections[0].meta.visibleLayers=['HE_STAIN_TIC'];
    for(const entry of Object.values(project.sections[0].msiSeries)){delete entry.rasterW;delete entry.rasterH;}
    await ProjectStorage.putProject(project);__fast.open('fast-tic-only','free');return ids;
  });
  await foreground(page);
  await page.waitForFunction(id=>App.panels.get(id)._ticJob?.state==='ready',ids[0]);
  const state=await page.evaluate(id=>{
    const panel=App.panels.get(id),canvas=panel.dom.cdisp;
    return {loaded:Object.keys(panel.imageSources),probes:__fast.parses['tic-probe']||0,
      size:[panel.imageSources.HE_STAIN_TIC.naturalWidth,panel.imageSources.HE_STAIN_TIC.naturalHeight],
      drawn:panel.displayCtx.getImageData(0,0,canvas.width,canvas.height).data.some((v,i)=>i%4!==3&&v>0)};
  },ids[0]);
  assert.deepEqual(state.loaded,['HE_STAIN_TIC'],'TIC-only display creates no hidden MSI layer images');
  assert.equal(state.probes,1);assert.deepEqual(state.size,[8,8]);assert.equal(state.drawn,true);
  await style.evaluate(el=>el.remove());
  console.log('PASS TIC-only visibility discovers geometry without loading hidden MSI images');
}

async function testCacheLimits(page) {
  const result=await page.evaluate(async()=>{
    let tick=1000;const cache=TicCache.create({maxBytes:8,maxEntries:2,now:()=>++tick});
    const blob=n=>new Blob([new Uint8Array(n)],{type:'image/png'});
    const a='test-old-version:a',b='test-current:b',c='test-current:c',d='test-current:d';
    await cache.put(a,blob(3),1,1);await cache.put(b,blob(3),1,1);await cache.put(c,blob(3),1,1);
    const firstEvicted=await cache.get(a)===null;
    await cache.get(b);await cache.put(c,blob(4),1,1);await cache.put(d,blob(4),1,1);
    const rows=await Promise.all([b,c,d].map(key=>cache.get(key)));
    const oversized=await cache.put('too-large',blob(9),1,1);
    for(const key of [a,b,c,d])await cache.remove(key);
    return {firstEvicted,remaining:rows.map(row=>row&&row.byteSize),oversized};
  });
  assert.equal(result.firstEvicted,true,'IndexedDB entry cap evicts least recently used row');
  assert.deepEqual(result.remaining,[null,4,4],'Overwrite accounting and byte cap preserve the two newest fitting rows');
  assert.equal(result.oversized,false,'An oversized derivative is skipped');
  console.log('PASS real IndexedDB TIC limits and overwrite accounting');
}

async function testCancellation(page) {
  const ids=await page.evaluate(async()=>{
    const first=await __fast.seed({id:'fast-cancel-a',sections:[{factor:2,layers:2,tic:true}]});
    await __fast.seed({id:'fast-cancel-b',sections:[{factor:5}]});return first;
  });
  const previousSteps=await page.evaluate(()=>{
    const count=__fast.parses['tic-step']||0;__fast.holdParse('tic-step');__fast.open('fast-cancel-a');return count;
  });
  await foreground(page);await page.waitForFunction(count=>(__fast.parses['tic-step']||0)>count,previousSteps);
  await page.evaluate(id=>{__fast.abandonedPanel=App.panels.get(id);__fast.open('fast-cancel-b');},ids[0]);
  await page.waitForFunction(()=>App.project?.id==='fast-cancel-b');
  await page.evaluate(()=>__fast.releaseParse('tic-step'));await foreground(page);await frames(page);
  const state=await page.evaluate(()=>({current:App.project.id,oldState:__fast.abandonedPanel._ticJob?.state,
    oldTic:!!__fast.abandonedPanel.imageSources.HE_STAIN_TIC,newTic:!!App.panels.values().next().value.imageSources.HE_STAIN_TIC}));
  assert.equal(state.current,'fast-cancel-b');assert.equal(state.oldTic,false);assert.equal(state.newTic,false);
  assert.equal(state.oldState,'cancelled','An obsolete TIC job cannot commit after a project switch');
  console.log('PASS project switching cancels late TIC results');
}

async function main() {
  const external=[],writes=[],errors=[];
  const server=createServer(async(req,res)=>{
    try {
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(!['GET','HEAD'].includes(req.method)){writes.push(req.url);res.writeHead(405);res.end();return;}
      if(pathname==='/runtime-config.js'){res.setHeader('Content-Type','text/javascript');res.end(renderOfflineConfig());return;}
      const file=path.resolve(root,'.'+pathname+(pathname.endsWith('/')?'index.html':''));
      if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
      res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');
      res.end(await fs.readFile(file));
    }catch(_){res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin='http://127.0.0.1:'+server.address().port;let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
    const context=await browser.newContext({viewport:{width:1600,height:1000}});
    await context.route('**/*',route=>{
      const url=route.request().url();
      if(url.startsWith(origin+'/')||/^(blob|data):/.test(url))return route.continue();
      external.push(url);return route.abort();
    });
    const page=await context.newPage();page.setDefaultTimeout(20000);
    page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    await page.goto(origin+'/viewer/?project=fast-display-empty');
    await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
    await installFixture(page);
    const requested=new Set((process.env.FAST_DISPLAY_TESTS||'priority,preview,tic,tic-only,cancel,report,cache').split(','));
    if(requested.has('priority'))await testPriority(page);
    if(requested.has('preview'))await testPreviewPending(page);
    if(requested.has('tic'))await testTic(page,origin);
    if(requested.has('tic-only'))await testTicOnly(page);

    if(requested.has('cancel'))await testCancellation(page);
    if(requested.has('report'))await testReportReferences(page);
    if(requested.has('cache'))await testCacheLimits(page);
    console.log('Fast display timing events (synthetic gates, not production latency): '
      +JSON.stringify(await page.evaluate(()=>__fast.events.filter(e=>/open|paint/.test(e.type)))));
    assert.deepEqual(external,[],'All test traffic is local');assert.deepEqual(writes,[],'Fixture performs no server writes');
    assert.deepEqual(errors,[],'No uncaught browser errors');
    await context.close();
  } finally {
    if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
  }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
