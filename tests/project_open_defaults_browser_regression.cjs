'use strict';
// Real viewer, IndexedDB, ZIP import, canvas, and share hydration. All sources
// are synthetic and requests are restricted to the local fixture server.
const assert = require('node:assert/strict');
const {chromium} = require('playwright');
const {createCanvas} = require('@napi-rs/canvas');
const JSZip = require('../vendor/jszip.min.js');
const {fixture, archive, startServer} = require('./msi_ratio_browser_regression.cjs');

function dataFixture() {
  const data = fixture();
  data.doc.meta.project_meta = {colormap:'viridis',msiSmoothing:'linear',
    msiDisplay:{version:2,preset:'custom',rangePolicy:'legacy',aspectMode:'physical',smoothingStrength:2,linearStrength:3}};
  const image = createCanvas(32,16),ctx = image.getContext('2d');
  ctx.fillStyle='#eebbbb';ctx.fillRect(0,0,32,16);
  ctx.fillStyle='#443377';ctx.fillRect(0,0,8,4);ctx.fillStyle='#33aa66';ctx.fillRect(24,12,8,4);
  const png = image.toBuffer('image/png');
  for (const [index,section] of data.doc.sections.entries()) {
    const source = section.storage_paths.msiSeries.MSI_X, rows=['x,y,X,Y'];
    for(let y=0;y<16;y++)for(let x=0;x<32;x++) {
      const n=y*32+x+1;rows.push([x,y,(n===512?10000:n)*(index+1),n*2].join(','));
    }
    data.sources[source.path]=rows.join('\n')+'\n';
    section.storage_paths.msiSeries={MSI_Z:{...source,v:'Y',compoundMeta:{base:'Zulu',name:'Z'}},
      MSI_A:{...source,v:'X',compoundMeta:{base:'Alpha',name:'A'}}};
    const hePath='synthetic/open-he-'+index+'.png';data.sources[hePath]=png;
    section.storage_paths.images={HE_STAIN:{path:hePath,mime:'image/png',filename:'open-he.png'}};
    Object.assign(section.meta,{visibleLayers:['MSI_Z','HE_STAIN'],
      viewerTransform:{tx:90,ty:-35,scale:3,rot:25,rotHE:-15,rotMSI:35},
      flip:{lr:true,ud:false},shareDefaultRotation:40});
    Object.assign(section.meta.world_coords,{msi_um_per_px:{x:30,y:60},he_um_per_px:{x:30,y:60},
      T_he_to_msi:[[1,0,0],[0,1,0],[0,0,1]]});
  }
  return data;
}
async function importBytes(data) {
  const zip=await JSZip.loadAsync(await archive(data));
  const manifest=JSON.parse(await zip.file('SyntheticRatio.json').async('string'));
  manifest.offlineSettings={version:1,meta:data.doc.meta.project_meta};
  for(const [index,section] of manifest.sections.entries()) {
    const image=data.doc.sections[index].storage_paths.images.HE_STAIN;
    section.images={HE_STAIN:{fullPath:image.path,mime:image.mime,filename:image.filename}};
    zip.file(image.path,data.sources[image.path]);
  }
  zip.file('SyntheticRatio.json',JSON.stringify(manifest));
  return zip.generateAsync({type:'nodebuffer'});
}
const frames=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function ready(page,shared=false) {
  await page.waitForFunction(()=>typeof App!=='undefined'&&App.project&&App.panels.size===2);
  if(shared)await page.waitForFunction(()=>SharePreview.isOpen());
  await page.evaluate(async()=>{
    if(App.shareMode)App._stopShareRoiPoll();
    for(const panel of App.panels.values()) {
      if(!await panel.ensureMsiLayerLoaded(App.focusCompoundKey))throw new Error('Initial MRM unavailable');
      if(!await panel.ensureLayerLoaded('HE_STAIN'))throw new Error('HE unavailable');
      panel.setupCanvasSize();
    }
    if(SharePreview.isOpen())SharePreview.refresh(App.project);
    App.recomputeMsiAbsScale();
  });
  await frames(page);
}
async function assertOpening(page,{preview=false,focus='MSI_A',color='viridis',interpolation='linear'}={}) {
  if(preview)await page.waitForFunction(()=>[...document.querySelectorAll('[data-cell-img]')].length===2
    &&[...document.querySelectorAll('[data-cell-img]')].every(img=>img.complete&&img.naturalWidth));
  const value=await page.evaluate(preview=>{
    const all=[...App.panels.values()];
    const boxes=all.map(panel=>{
      const host=panel.dom.host.getBoundingClientRect(),image=panel.dom.cdisp.getBoundingClientRect();
      const t=panel._ensureViewerTransform();
      return {id:panel.section.id,tx:t.tx,ty:t.ty,scale:t.scale,rot:t.rot,rotHE:t.rotHE,rotMSI:t.rotMSI,
        drawable:[...(panel._drawableMsiKeys || [])],
        fits:image.left>=host.left-2&&image.top>=host.top-2&&image.right<=host.right+2&&image.bottom<=host.bottom+2,
        width:image.width,height:image.height,hostWidth:host.width,hostHeight:host.height,
        hasHe:panel.isImageLayerReady('HE_STAIN'),
        visible:panel.displayCtx.getImageData(0,0,panel.dom.cdisp.width,panel.dom.cdisp.height).data.some((v,i)=>i%4!==3&&v>0)};
    });
    const previewBoxes=preview?[...document.querySelectorAll('.cell-img-wrap')].map(wrap=>{
      const image=wrap.querySelector('[data-cell-img]'),a=wrap.getBoundingClientRect(),b=image.getBoundingClientRect();
      return {fits:b.left>=a.left-2&&b.top>=a.top-2&&b.right<=a.right+2&&b.bottom<=a.bottom+2,
        width:b.width,height:b.height,hostWidth:a.width,hostHeight:a.height};
    }):[];
    return {focus:App.focusCompoundKey,settings:App.getMsiDisplaySettings(),mode:App.msiScaleMode,
      roiOnly:App.roiOnlyMode,roiChecked:document.getElementById('roi-clip-toggle').checked,
      ratioSelection:document.getElementById('ratio-display-select').value,
      windows:Object.keys(App.msiUserWindow),roiWindows:Object.keys(App.msiRoiUserWindow),
      methodFirst:preview?SharePreview.compoundKeys[0]:methodVisibleKeys(App.panels.get(App.activeSectionId),App.project).keys[0],
      range:all.map(panel=>{const e=panel.section.msiSeries[App.focusCompoundKey];
        return App.getMsiWindow(App.focusCompoundKey,e.rawRange,e.rawDispMax,e.rawTrueMax,panel.section);}),boxes,previewBoxes};
  },preview);
  assert.equal(value.focus,focus);if(focus==='MSI_A')assert.equal(value.methodFirst,focus);
  assert.equal(value.settings.rangePolicy,'maximum');assert.equal(value.mode,'same');
  assert.equal(value.settings.colormap,color);assert.equal(value.settings.interpolation,interpolation);
  assert.equal(value.roiOnly,false);assert.equal(value.roiChecked,false,'ROI-only checkbox agrees with the new whole-image display');
  assert.equal(value.ratioSelection,'','The display selector returns to an ordinary MRM');
  assert.deepEqual(value.windows,[]);assert.deepEqual(value.roiWindows,[]);
  assert.ok(value.range.every(r=>r.min===0&&r.max===(focus==='MSI_A'?20000:1024)),JSON.stringify(value.range));
  for(const box of value.boxes) {
    assert.equal(box.scale,1);assert.equal(box.tx,0);assert.equal(box.ty,0);
    assert.equal(box.rot,25);assert.equal(box.rotHE,-15);assert.equal(box.rotMSI,35);
    assert.ok(box.drawable.includes(focus),'The selected first MRM is drawable');
    assert.ok(box.hasHe&&box.visible,'Both the HE and MSI canvas are actually loaded');
    assert.ok(box.width>0&&box.height>0&&box.fits,'Rotated physical HE/MSI frame fits: '+JSON.stringify(box));
  }
  for(const box of value.previewBoxes)assert.ok(box.width>0&&box.height>0&&box.fits,'Preview image fits: '+JSON.stringify(box));
}
async function scienceSnapshot(page) {
  return page.evaluate(async()=>{
    const sections=[];
    for(const section of App.project.sections) {
      const panel=App.panels.get(section.id),hashes=[];
      for(const [key,entry] of Object.entries({...section.images,...section.msiSeries})) {
        if(/^MSI_/.test(key))await panel.ensureMsiLayerLoaded(key);else await panel.ensureLayerLoaded(key);
        const record=await ProjectStorage.getBlob(entry.blobId);
        const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await record.blob.arrayBuffer()))).join(',');
        hashes.push([key,hash]);
      }
      const meta=section.meta;
      sections.push({id:section.id,hashes,viewerTransform:meta.viewerTransform,flip:meta.flip,
        world_coords:meta.world_coords,displayTransform:meta.displayTransform,alignment:meta.alignment,spatialGroups:meta.spatialGroups});
    }
    return {sections,rois:JSON.stringify(App.project.rois),meta:JSON.stringify(App.project.meta)};
  });
}
async function editDisplay(page,preview=false) {
  if(preview)await page.locator('[data-preview-close]').click();
  await page.locator('#msi-scale-mode').selectOption('individual');
  await page.locator('#tb-range-max').fill('333');await page.locator('#tb-range-max').blur();
  await page.evaluate(()=>{
    const p=App.panels.get(App.activeSectionId);
    p.dom.host.dispatchEvent(new WheelEvent('wheel',{deltaY:-650,bubbles:true,cancelable:true}));
    p.dom.host.dispatchEvent(new PointerEvent('pointerdown',{pointerId:77,pointerType:'mouse',button:0,clientX:100,clientY:100,bubbles:true}));
    p.dom.host.dispatchEvent(new PointerEvent('pointermove',{pointerId:77,pointerType:'mouse',clientX:117,clientY:109,bubbles:true}));
    p.dom.host.dispatchEvent(new PointerEvent('pointerup',{pointerId:77,pointerType:'mouse',button:0,bubbles:true}));
  });
  await frames(page);
  return page.evaluate(()=>{
    const p=App.panels.get(App.activeSectionId),t=p._ensureViewerTransform();
    return {scale:t.scale,pixelScale:t.scale*p._viewerFit.nativeFit,tx:t.tx,ty:t.ty};
  });
}
async function main() {
  const data=dataFixture(),server=await startServer(data),errors=[],external=[];
  let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
    const context=await browser.newContext({viewport:{width:1600,height:1000}});
    await context.route('**/*',route=>{const url=route.request().url();
      if(url.startsWith(server.origin+'/')||/^(blob|data):/.test(url))return route.continue();external.push(url);return route.abort();});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto(server.origin+'/viewer/?project=open-default-empty');
    await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
    await page.evaluate(()=>{localStorage.setItem('desi:focusCompoundKey','MSI_Z');App.focusCompoundKey='MSI_Z';App.viewMode='free';});
    await page.locator('#hidden-import-input').setInputFiles({name:'opening-defaults.zip',mimeType:'application/zip',buffer:await importBytes(data)});
    await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();
    await ready(page);await assertOpening(page);
    const localId=await page.evaluate(()=>App.project.id),before=await scienceSnapshot(page);
    await page.locator('#btn-share-preview').click();await frames(page);await assertOpening(page,{preview:true});
    await page.evaluate(()=>{
      const wrap=SharePreview.overlay.querySelector('.cell-img-wrap');
      wrap.dispatchEvent(new WheelEvent('wheel',{deltaY:-500,bubbles:true,cancelable:true}));
    });
    const previewScale=await page.evaluate(()=>SharePreview._cellTransforms[SharePreview._gridSectionIds[0]].scale);
    assert.ok(previewScale>1);
    await page.locator('[data-preview-close]').click();await page.locator('#btn-share-preview').click();
    assert.ok(await page.evaluate(()=>SharePreview._cellTransforms[SharePreview._gridSectionIds[0]].scale>1),
      'Preview reopening within one project session preserves an intentional zoom');
    const edited=await editDisplay(page,true);assert.ok(edited.scale>1);assert.equal(edited.tx,17);assert.equal(edited.ty,9);
    await page.setViewportSize({width:1300,height:850});await frames(page);
    const resized=await page.evaluate(()=>{
      const p=App.panels.get(App.activeSectionId),t=p._ensureViewerTransform();
      return {pixelScale:t.scale*p._viewerFit.nativeFit,tx:t.tx,ty:t.ty,range:App.msiUserWindow.MSI_A.max};
    });
    assert.ok(Math.abs(resized.pixelScale-edited.pixelScale)<1e-6,'Resize preserves a user-adjusted absolute magnification');
    assert.equal(resized.tx,17);assert.equal(resized.ty,9);assert.equal(resized.range,333);
    await page.locator('#roi-clip-toggle').check();
    assert.equal(await page.evaluate(()=>App.roiOnlyMode),true);
    await page.evaluate(async()=>{
      App.setFocusCompoundKey('MSI_Z');App.msiRoiUserWindow.MSI_A={max:5};
      // KMD selects project-specific molecule keys. B has B/A in source order,
      // so carrying A's Z-only selection into its initial Method sort hides all.
      App.setMethodKeySet(['MSI_Z']);
      const second=await ProjectStorage.getProject(App.project.id);second.id='open-default-second';second.displayName='Second';
      for(const section of second.sections) {
        const {MSI_Z,MSI_A}=section.msiSeries;
        section.msiSeries={MSI_B:{...MSI_Z,compoundMeta:{base:'Beta',name:'B'}},MSI_A};
      }
      await ProjectStorage.putProject(second,{createOnly:true});await App.openProject(second.id);
    });
    await ready(page);await assertOpening(page);
    assert.equal(await page.evaluate(()=>App.methodKeySet),null,'A new project clears the previous KMD molecule selection before choosing its first MRM');
    await page.evaluate(id=>App.openProject(id),localId);await ready(page);await assertOpening(page);
    assert.deepEqual(await scienceSnapshot(page),before,'Opening defaults preserve source bytes, ROI, calibration, alignment, saved orientation and display metadata');
    await page.evaluate(async()=>{await App._flushSave();});
    const saved=await page.evaluate(()=>ProjectStorage.getProject(App.project.id));
    assert.equal(saved.meta.msiDisplay.rangePolicy,'legacy');assert.equal(saved.sections[0].meta.viewerTransform.scale,3);

    // Delay the actual HE decode behind a ready MSI, then exercise the real
    // wheel handler. Late pixels must not restart the opening defaults.
    await page.evaluate(async id=>{
      const original=ProjectStorage.getBlob,he=(await ProjectStorage.getProject(id)).sections[0].images.HE_STAIN.blobId;
      let release;const gate=new Promise(resolve=>{release=resolve;});
      window.__releaseOpenHe=()=>{ProjectStorage.getBlob=original;release();};
      ProjectStorage.getBlob=async function(blobId){if(blobId===he)await gate;return original.apply(this,arguments);};
      await App.openProject(id);
    },localId);
    await page.waitForFunction(()=>App.panels.get(App.activeSectionId)?.isMsiLayerReady('MSI_A'));
    await page.evaluate(()=>App.panels.get(App.activeSectionId).dom.host.dispatchEvent(new WheelEvent('wheel',{deltaY:-650,bubbles:true,cancelable:true})));
    await page.evaluate(()=>__releaseOpenHe());await ready(page);
    assert.ok(await page.evaluate(()=>App.panels.get(App.activeSectionId)._ensureViewerTransform().scale>1),'Delayed HE load retains the user zoom');
    await page.reload();await ready(page);await assertOpening(page);

    // A copied project has the same ratio ID. Opening it while that ratio is
    // active must initialize the ordinary display context before applying the
    // opening range policy, without overwriting either saved display style.
    await page.locator('#btn-msi-ratio').click();
    const ratioDialog=page.locator('#msi-ratio-dialog');await ratioDialog.waitFor();
    await ratioDialog.locator('[data-ratio-name]').fill('Opening A / Z');
    for(let index=0;index<2;index++) {
      await ratioDialog.locator('[data-ratio-x]').nth(index).selectOption('MSI_A');
      await ratioDialog.locator('[data-ratio-y]').nth(index).selectOption('MSI_Z');
    }
    await ratioDialog.locator('[data-ratio-apply]').click();
    await page.waitForFunction(()=>App.getRatioDefinitions().length===1&&App.focusCompoundKey?.startsWith('MSI_RATIO_')
      &&[...App.panels.values()].every(p=>p.isMsiLayerReady(App.focusCompoundKey)));
    await ratioDialog.locator('[data-ratio-results] tbody tr').first().waitFor();
    await ratioDialog.getByRole('button',{name:'閉じる',exact:true}).click();
    await page.evaluate(()=>App._flushSave());
    const withRatio=await scienceSnapshot(page);
    await page.evaluate(async()=>{
      const copy=await ProjectStorage.getProject(App.project.id);copy.id='open-ratio-copy';copy.displayName='Ratio copy';
      if(copy.meta.msiDisplay.rangePolicy!=='legacy')throw new Error('Expected the saved ordinary legacy range');
      await ProjectStorage.putProject(copy,{createOnly:true});await App.openProject(copy.id);
    });
    await ready(page);await assertOpening(page);
    assert.equal(await page.evaluate(()=>App._msiOpenRangePolicy),'maximum');
    assert.deepEqual(await scienceSnapshot(page),withRatio,'Opening a ratio copy preserves its ratio definition and ordinary saved display policy');
    await context.close();

    // Shared viewer/admin use the same new-opening rules, including the
    // automatically opened Preview and existing sessionStorage viewports.
    server.online=true;
    for(const role of ['viewer','admin']) {
      const shared=await browser.newContext({viewport:{width:1600,height:1000}});
      await shared.route('**/*',route=>{const url=route.request().url();
        if(url.startsWith(server.origin+'/')||/^(blob|data):/.test(url))return route.continue();external.push(url);return route.abort();});
      await shared.addInitScript(({slug,role,projectId,sectionIds})=>{
        sessionStorage.setItem('desi:share:'+slug,JSON.stringify({slug,role,token:'synthetic-'+role,
          expiresAt:new Date(Date.now()+3600000).toISOString()}));
        if(!sessionStorage.getItem('opening-seeded')) {
          localStorage.setItem('desi:focusCompoundKey','MSI_Z');
          for(const id of sectionIds)sessionStorage.setItem('desi:msi-viewport:v2:'+JSON.stringify([projectId,slug,id]),
            JSON.stringify({tx:140,ty:-80,scale:4,fit:{key:'stale',fit:5,nativeFit:5}}));
          sessionStorage.setItem('desi:section-view:v1:'+JSON.stringify([projectId,slug,role]),JSON.stringify({
            known:sectionIds,selected:sectionIds,previewTransforms:Object.fromEntries(sectionIds.map(id=>[id,
              {tx:80,ty:-60,scale:3,viewport:{centerX:.2,centerY:.3,pixelScale:8}}]))}));
          sessionStorage.setItem('opening-seeded','1');
        }
      },{slug:data.doc.slug,role,projectId:data.doc.id,sectionIds:data.doc.sections.map(s=>s.id)});
      const view=await shared.newPage();view.on('pageerror',e=>errors.push(e.message));view.on('dialog',d=>d.accept());
      await view.goto(server.origin+'/viewer/#share='+data.doc.slug);await ready(view,true);await assertOpening(view,{preview:true});
      const sharedBefore=await scienceSnapshot(view);
      await editDisplay(view,true);
      await view.evaluate(()=>App.setFocusCompoundKey('MSI_Z'));
      await view.reload();await ready(view,true);await assertOpening(view,{preview:true});
      assert.deepEqual(await scienceSnapshot(view),sharedBefore,'Shared '+role+' opening leaves scientific and published state intact');
      await view.goto(server.origin+'/viewer/?explicit=1#share='+data.doc.slug+'&focus=Z');
      await ready(view,true);await assertOpening(view,{preview:true,focus:'MSI_Z'});
      await shared.close();
    }
    assert.deepEqual(server.writes,[]);assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
    console.log('Project opening browser regression: PASS (local ZIP, same-project reopen, A/B/A, KMD selection, page reload, ratio-to-copy, ROI checkbox, shared viewer/admin, fitted HE/MSI/Preview, Range, Method order, deep link, delayed HE, scientific state)');
  } finally {await browser?.close();await server.close();}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
