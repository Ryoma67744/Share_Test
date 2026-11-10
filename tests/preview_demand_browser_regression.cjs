'use strict';
// Actual viewer/IndexedDB/worker/canvas; a clipped Preview models a narrow
// viewport without changing scientific section selection or Same Range.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
const {fixture,startServer}=require('./msi_ratio_browser_regression.cjs');
// Reuse the existing synthetic source/gate fixture without running its suite.
const source=fs.readFileSync(path.join(__dirname,'fast_display_browser_regression.cjs'),'utf8');
const installFixture=new Function('return ('+source.slice(source.indexOf('async function installFixture('),source.indexOf('\nasync function frames('))+')')();
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

(async()=>{
  const server=await startServer(fixture()),browser=await chromium.launch({headless:true});
  const errors=[],external=[];
  try {
    const page=await browser.newPage({viewport:{width:1200,height:850}});page.setDefaultTimeout(20000);
    await page.route('**/*',route=>{
      const url=route.request().url();
      if(url.startsWith(server.origin+'/') || /^(blob|data):/.test(url))return route.continue();
      external.push(url);return route.abort();
    });
    page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    await page.goto(server.origin+'/viewer/?project=preview-demand-empty');
    await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
    await installFixture(page);
    const ids=await page.evaluate(async()=>{
      const ids=await __fast.seed({id:'preview-demand',sections:Array.from({length:12},(_,i)=>({factor:i+1,layers:3,hiddenHe:true})),
        selected:[0,1,2,3,4,5,6,7,8,9,11]});
      __fast.open('preview-demand');await __fast.openPromise;return ids;
    });
    await page.waitForFunction(id=>__fast.painted(id),ids[0]);
    await page.addStyleTag({content:'#share-preview-overlay [data-image-grid]{display:flex!important;overflow-x:auto!important}#share-preview-overlay .preview-image-cell{flex:0 0 260px!important}#share-preview-overlay .preview-main{overflow:hidden!important}'});
    await page.evaluate(()=>SharePreview.open(App.project,'viewer'));
    await page.waitForFunction(id=>SharePreview.isSectionWanted(id)&&App.panels.get(id).isImageLayerReady('HE_STAIN_HIDDEN'),ids[0]);
    await settle(page);
    const initial=await page.evaluate(ids=>({
      wanted:ids.map(id=>SharePreview.isSectionWanted(id)),reads:__fast.reads,
      selected:[...App.sectionVisibility().ensure()],
      max:App.getMsiWindow('MSI_A',[0,64],64,64,App.project.sections[0]).max
    }),ids);
    assert.equal(initial.wanted[0],true);assert.equal(initial.wanted[11],false);
    assert.equal(initial.reads[ids[11]+'-MSI_A']||0,0,'An off-screen selected section has no automatic source read');
    assert.equal(initial.reads[ids[11]+'-HE_STAIN_HIDDEN']||0,0,'An off-screen optical source is not forced on');
    assert.equal(initial.reads[ids[10]+'-MSI_A']||0,0,'An excluded section is not fetched');
    assert.equal(initial.selected.length,11);assert.equal(initial.max,768,'Same still covers all selected sections');

    await page.waitForFunction(()=>SharePreview._demandLoads.size===0);
    const reuse=await page.evaluate(async id=>{
      const preview=SharePreview,panel=App.panels.get(id),grid=preview.overlay.querySelector('[data-image-grid]');
      const wrap=grid.querySelector('.cell-img-wrap'),stage=wrap.querySelector('[data-cell-stage]');
      const transforms=preview._cellTransforms[id];transforms.scale=1.7;transforms.tx=11;transforms.ty=-4;
      preview._applyCellTransform(0);
      const viewport=JSON.stringify(transforms.viewport),nativeBake=preview._bakeRotatedCanvas,nativeRefresh=preview.refresh;
      let bakes=0,refreshes=0;
      preview._bakeRotatedCanvas=function(...args){bakes++;return nativeBake.apply(this,args);};
      preview.refresh=function(...args){refreshes++;return nativeRefresh.apply(this,args);};
      try {
        preview._snapshotCache.clear();preview._snapshotBytes=0;
        const first=preview._cellSnapshot(App.project,panel,-90),second=preview._cellSnapshot(App.project,panel,-90);
        const exactReuse=first===second,firstBakes=bakes;
        // Warm every visible cell once, then duplicate refresh requests must
        // neither replace its DOM nor encode identical canvases again.
        preview._rebakeCellImages(App.project,App.focusCompoundKey);bakes=0;
        preview.requestDisplayRefresh(App.project);preview.requestDisplayRefresh(App.project);preview.requestDisplayRefresh(App.project);
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        const coalesced={refreshes,bakes,sameWrap:grid.querySelector('.cell-img-wrap')===wrap,
          sameStage:wrap.querySelector('[data-cell-stage]')===stage,viewport:JSON.stringify(transforms.viewport)===viewport};
        bakes=0;panel.renderComposite();preview._rebakeCellImages(App.project,App.focusCompoundKey);
        const changedBakes=bakes,img=stage.querySelector('[data-cell-img]');
        const pixelsCurrent=img.src===nativeBake.call(preview,panel.dom.cdisp,-90).toDataURL('image/png');
        const cap=preview._snapshotMaxBytes;preview._snapshotMaxBytes=1;
        preview._snapshotCache.clear();preview._snapshotBytes=0;
        const uncached=preview._cellSnapshot(App.project,panel,-90);
        const bounded=preview._snapshotCache.size===0&&preview._snapshotBytes===0&&!!uncached.url;
        preview._snapshotMaxBytes=cap;
        return {exactReuse,firstBakes,coalesced,changedBakes,pixelsCurrent,bounded};
      } finally {preview._bakeRotatedCanvas=nativeBake;preview.refresh=nativeRefresh;}
    },ids[0]);
    assert.equal(reuse.exactReuse,true);assert.equal(reuse.firstBakes,1);
    assert.deepEqual(reuse.coalesced,{refreshes:1,bakes:0,sameWrap:true,sameStage:true,viewport:true});
    assert.equal(reuse.changedBakes,1,'A new completed panel revision replaces its PNG exactly once');
    assert.equal(reuse.pixelsCurrent,true,'Cached encoding preserves the same rotated output pixels');
    assert.equal(reuse.bounded,true,'An oversized PNG is returned without entering the bounded cache');

    // Explicit complete consumers (PPT/export) remain independent of demand.
    await page.evaluate(async id=>{await App.panels.get(id).loadAllLayers({all:true});},ids[10]);
    assert.equal(await page.evaluate(id=>App.panels.get(id).isMsiLayerReady('MSI_C')&&App.panels.get(id).isImageLayerReady('HE_STAIN_HIDDEN'),ids[10]),true);
    assert.equal(await page.evaluate(id=>SharePreview.isSectionWanted(id),ids[10]),false);

    await page.evaluate(()=>{const grid=SharePreview.overlay.querySelector('[data-image-grid]');grid.scrollLeft=grid.scrollWidth;});
    await page.waitForFunction(id=>SharePreview.isSectionWanted(id)&&App.panels.get(id).isMsiLayerReady('MSI_A')&&App.panels.get(id).isImageLayerReady('HE_STAIN_HIDDEN'),ids[11]);
    await page.waitForFunction(()=>SharePreview.overlay.querySelector('.cell-img-wrap[data-cell-idx="10"] [data-cell-img]'));

    // A superseded compound can finish its cache load, but cannot replace C.
    await page.evaluate(id=>{
      __fast.hold(id+'-MSI_B');void SharePreview._selectCompound('MSI_B');
    },ids[11]);
    await page.waitForFunction(id=>(__fast.reads[id+'-MSI_B']||0)>0,ids[11]);
    await page.evaluate(()=>{void SharePreview._selectCompound('MSI_C');});
    await page.evaluate(id=>__fast.release(id+'-MSI_B'),ids[11]);
    await page.waitForFunction(id=>App.focusCompoundKey==='MSI_C'&&App.panels.get(id).isMsiLayerReady('MSI_C'),ids[11]);
    await settle(page);
    assert.equal(await page.evaluate(id=>{
      const panel=App.panels.get(id),img=SharePreview.overlay.querySelector('.cell-img-wrap[data-cell-idx="10"] [data-cell-img]');
      return !!img&&img.src===SharePreview._bakeRotatedCanvas(panel.dom.cdisp,-90).toDataURL('image/png');
    },ids[11]),true,'The visible snapshot belongs to the current compound');

    await page.evaluate(()=>{SharePreview.requestDisplayRefresh(App.project);SharePreview.close();});
    await settle(page);
    assert.equal(await page.evaluate(()=>SharePreview._snapshotCache.size===0&&SharePreview._snapshotBytes===0
      &&SharePreview._displayRefreshRaf===0&&SharePreview._displayRefreshRequest===null),true,
      'Closing Preview releases its encoded image cache');
    const restore=await page.evaluate(()=>App.project.sections.map(sec=>({live:[...App.panels.get(sec.id).visibleLayers],saved:sec.meta.visibleLayers})));
    for(const state of restore){assert.ok(!state.live.includes('HE_STAIN_HIDDEN'));assert.ok(!state.saved.includes('HE_STAIN_HIDDEN'));}
    const late=await page.evaluate(async()=>{
      const ids=await __fast.seed({id:'preview-late-close',sections:[{hiddenHe:true},{hiddenHe:true}]});
      __fast.open('preview-late-close');await __fast.openPromise;__fast.hold(ids[0]+'-HE_STAIN_HIDDEN');
      SharePreview.open(App.project,'viewer');return ids;
    });
    await page.waitForFunction(id=>(__fast.reads[id+'-HE_STAIN_HIDDEN']||0)>0,late[0]);
    await page.evaluate(id=>{SharePreview.close();__fast.release(id+'-HE_STAIN_HIDDEN');},late[0]);
    await page.waitForFunction(id=>!App.panels.get(id)._imageLoadInFlight?.has('HE_STAIN_HIDDEN'),late[0]);
    assert.equal(await page.evaluate(id=>!SharePreview.isOpen()&&!App.panels.get(id).visibleLayers.has('HE_STAIN_HIDDEN'),late[0]),true);
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
    console.log('Preview demand browser regression: PASS (viewport/scroll, excluded originals, Same, explicit complete load, stale focus, close)');
  } finally {await browser.close();await server.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
