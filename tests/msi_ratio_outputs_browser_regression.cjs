'use strict';
// Exercise real App.resolveRatio outputs through the report/photo bridges and
// per-source HE/IF resolver. The fixture contains synthetic signals only.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {archive,startServer,prepare,createRatio,sourceSnapshot}=require('./msi_ratio_browser_regression.cjs');

(async()=>{
  const state=await startServer(),errors=[],external=[];let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
    const context=await browser.newContext({viewport:{width:1500,height:1000},acceptDownloads:true});
    await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(state.origin+'/')||/^(blob|data):/.test(url))return route.continue();external.push(url);return route.abort();});
    const page=await context.newPage();page.setDefaultTimeout(20000);
    page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
    await page.goto(state.origin+'/viewer/?project=ratio-output-empty',{waitUntil:'domcontentloaded',timeout:60000});
    await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
    await page.locator('#hidden-import-input').setInputFiles({name:'ratio-output.zip',mimeType:'application/zip',buffer:await archive(state.data)});
    await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();await prepare(page);
    const original=await sourceSnapshot(page);
    await page.evaluate(()=>{App.project.sections[1].msiSeries.MSI_X.compoundMeta.base='Alternate X';});
    const key=await createRatio(page);
    await page.locator('#msi-ratio-dialog button[aria-label="閉じる"]').click();
    const output=await page.evaluate(async key=>{
      for(const name of ['jszip','pptxgen','projectReportData','projectReportDeck'])await loadScript(LAZY_LIBS[name]);
      const sections=App.project.sections,roi=App.project.rois[0],ids=sections.map(MsiRatioModel.canonicalSectionId);
      const ranges={version:1,whole:{same:{min:0,max:7},[ids[0]]:{min:0,max:6},[ids[1]]:{min:0,max:12}},
        roi:{same:{min:50,max:60},[ids[0]]:{min:50,max:60},[ids[1]]:{min:50,max:60}}};
      MsiRatioRuntime.saveStyle(key,{scaleMode:'individual',interpolation:'none',ranges});
      App.msiUserWindow[key]={min:90,max:100}; // Stale legacy UI cache must not win.
      const hooks={getApp:()=>App,transform:section=>sectionLayerViewLinear(section,'msi'),
        displayStyle:()=>App.getRatioDisplayStyle(key)};
      const input=ProjectReportApp.createAdapter(hooks,{includeRatios:true,useDisplayStyle:true});
      const job=input.molecules.find(m=>m.kind==='ratio'),entries=await job.loadEntries();
      const prepared=await ProjectReportData.prepare({...input,molecules:[job]},{nearestUpscale:false});
      const deck=await ProjectReportDeck.create(prepared,{type:'blob'}),zip=await JSZip.loadAsync(deck);
      const xml=(await Promise.all(Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name))
        .map(name=>zip.file(name).async('string')))).join('\n');
      const photo=RoiMediaApp.createAdapter(App.project,roi),frames=[];
      for(const section of sections) {
        const frame=await photo.loadMsi(App.project,roi,section.id,key);
        const pixels=frame.canvas.getContext('2d').getImageData(0,0,8,1).data;
        frames.push({status:frame.status,polygon:frame.polygon,pitch:frame.pixelPitch,
          zero:Array.from(pixels.slice(8,12)),missing:Array.from(pixels.slice(12,16))});
      }
      MsiRatioRuntime.saveStyle(key,{scaleMode:'same'});
      const sameJob=ProjectReportApp.createAdapter(hooks,{includeRatios:true,useDisplayStyle:true}).molecules.find(m=>m.kind==='ratio');
      const sameEntries=await sameJob.loadEntries();
      const samePhoto=RoiMediaApp.createAdapter(App.project,roi),sameFrame=await samePhoto.loadMsi(App.project,roi,sections[0].id,key);
      return {entries:entries.map(e=>({window:e.displayWindow,statistics:e.ratioStatistics,rois:e.ratioRois})),
        sameWindows:sameEntries.map(e=>e.displayWindow),sameStatus:sameFrame.status,frames,xml,
        paletteZero:App.getRatioDisplayStyle(key).lut[0],background:App.getRatioDisplayStyle(key).background};
    },key);
    assert.deepEqual(output.entries.map(e=>e.window),[{min:0,max:6},{min:0,max:12}]);
    assert.deepEqual(output.sameWindows,[{min:0,max:7},{min:0,max:7}]);
    assert.match(output.sameStatus,/比 0–7/);
    output.entries.forEach((e,i)=>{assert.equal(e.statistics.totalRatio,2*(i+1));assert.equal(e.statistics.mean,3.75*(i+1));
      assert.equal(e.rois[0].statistics.nValid,4);assert.equal(e.rois[0].statistics.totalRatio,2*(i+1));});
    output.frames.forEach((frame,i)=>{assert.match(frame.status,new RegExp('比 0–'+(i?12:6)));
      assert.equal(frame.polygon.length,4);assert.deepEqual(frame.pitch,{x:30,y:30});
      assert.deepEqual(frame.zero,[...output.paletteZero,255]);assert.deepEqual(frame.missing,[...output.background,255]);});
    assert.match(output.xml,/Total signal ratio/);assert.match(output.xml,/Mean point ratio/);assert.match(output.xml,/Median point ratio/);
    const pptText=[...output.xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map(m=>m[1]).join('');
    assert.ok(pptText.includes('Section-specific X / Y'),'Different section bindings do not share a misleading formula subtitle');
    assert.ok(pptText.includes('Alternate X / Molecule Y'),'Each image identifies its own input formula');
    assert.ok(pptText.includes(output.entries[0].rois[0].name),'PPT preserves the ROI name across wrapped text runs');
    assert.ok(/4 \/ 8/.test(output.xml),'PPT contains original paired ROI counts');
    assert.deepEqual(await sourceSnapshot(page),original,'Real output adapters preserve original rows, source bytes and ROI statistics');

    const summaries=await page.evaluate(async key=>{
      App.openRatioDialog(key);
      const dialog=document.getElementById('msi-ratio-dialog'),host=dialog.querySelector('[data-ratio-results]'),
        summary=dialog.querySelector('[data-ratio-summary]'),apply=dialog.querySelector('[data-ratio-apply]');
      let tableWrites=0;const visibleCounts=[];
      const observer=new MutationObserver(records=>{for(const record of records)for(const node of record.addedNodes)
        if(node.nodeType===1&&node.classList.contains('ratio-table-wrap')){
          tableWrites++;visibleCounts.push([...node.querySelectorAll('tbody tr')].map(row=>row.children[4]?.textContent));
        }});
      observer.observe(host,{childList:true});
      const first=summary.onclick(),latest=summary.onclick();await Promise.all([first,latest]);await Promise.resolve();
      const writesForConcurrent=tableWrites;
      tableWrites=0;visibleCounts.length=0;
      const old=summary.onclick();await Promise.resolve();
      dialog.querySelector('[data-ratio-threshold]').value='5';
      await Promise.all([old,apply.onclick()]);await Promise.resolve();
      const afterThreshold=visibleCounts.slice();
      tableWrites=0;visibleCounts.length=0;
      const pending=summary.onclick();await Promise.resolve();
      const roi=App.project.rois[0],name=roi.name;roi.name=name+' changed';
      await pending;const changedMessage=host.textContent;roi.name=name;
      observer.disconnect();dialog.querySelector('[data-ratio-threshold]').value='0';await apply.onclick();
      dialog.close();
      return {writesForConcurrent,afterThreshold,changedMessage};
    },key);
    assert.equal(summaries.writesForConcurrent,1,'Only the newest summary request renders a table');
    assert.deepEqual(summaries.afterThreshold,[['1 / 8','1 / 8']],'A repeated Save never displays mixed threshold statistics');
    assert.match(summaries.changedMessage,/集計中に比・入力・ROIが変わりました.*再実行/);

    await page.evaluate(()=>{
      // Keep the browser-side task reachable until CDP serializes its result.
      // Every production load/decoder is awaited within the task itself.
      window.__ratioAlignmentTest=(async()=>{
      const section=App.project.sections[0],panel=App.panels.get(section.id),clone=v=>JSON.parse(JSON.stringify(v));
      const x=section.msiSeries.MSI_X,y=section.msiSeries.MSI_Y;
      section.msiSeries.MSI_Y_OTHER={...clone(y),sourceFileId:'other-original-file',sourceReference:'other-original-source',
        sourceGeometry:clone(panel.msiValueRasters.get('MSI_Y').sourceGeometry)};
      section.msiSeries.MSI_Y_OTHER.sourceGeometry.sourceRef='other-original-source';
      const definition={...clone(App.getRatioDefinitions()[0]),id:'cross-source-alignment',revision:1,bindings:{
        [MsiRatioModel.canonicalSectionId(section)]:{numerator:MsiRatioModel.makeInputRef(x,'MSI_X'),
          denominator:MsiRatioModel.makeInputRef(section.msiSeries.MSI_Y_OTHER,'MSI_Y_OTHER'),
          coordinateConfirmed:true,coordinateEvidence:'synthetic exact coordinates'}}};
      MsiRatioRuntime.store(definition);const key=MsiRatioModel.displayKey(definition.id);
      const numeric=await App.resolveRatio(section,key),I=[[1,0,0],[0,1,0],[0,0,1]],T=[[1,0,9],[0,1,0],[0,0,1]];
      section.images.HE_STAIN={blobId:'synthetic-he'};section.images.IF_STAIN={blobId:'synthetic-if'};
      section.meta.perSourceAlign=true;section.meta.world_coords.T_he_to_msi=I;
      section.meta.world_coords.T_he_to_msi_by_source={[x.sourceFileId]:I,'other-original-file':T};
      const mismatch=resolveHeMsiAlignment(section,'HE_STAIN',key,panel);
      await App.activateRatio(key);
      const image=new Image();image.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"><rect width="32" height="16" fill="lime"/></svg>');
      await image.decode();panel.imageSources.HE_STAIN=image;panel.imageSettings.HE_STAIN={opacity:1};panel.visibleLayers.add('HE_STAIN');
      panel.renderComposite();
      const legacyHidden=panel.dom.alignmentStatus && !panel.dom.alignmentStatus.hidden,
        legacyStatus=panel.dom.alignmentStatus && panel.dom.alignmentStatus.textContent;
      section.meta.world_coords.T_he_to_msi_by_source['other-original-file']=I;
      const equal=resolveHeMsiAlignment(section,'HE_STAIN',key,panel);
      panel.renderComposite();const equalShown=panel.dom.alignmentStatus && panel.dom.alignmentStatus.hidden;
      const xf=alignmentFrameDescriptor(section,'MSI_X',panel),yf=alignmentFrameDescriptor(section,'MSI_Y_OTHER',panel);
      const record=(frame,T,image)=>({frame,T_he_to_msi:T,alignment_raster_basis:'legacy-msi-pixel-edges-v1',imageIdentity:alignmentImageIdentity(section.images[image])});
      section.meta.alignment={HE_STAIN:{byFrame:{[xf.key]:record(xf,I,'HE_STAIN'),[yf.key]:record(yf,T,'HE_STAIN')}},
        IF_STAIN:{byFrame:{[xf.key]:record(xf,I,'IF_STAIN'),[yf.key]:record(yf,I,'IF_STAIN')}}};
      const managedMismatch=resolveHeMsiAlignment(section,'HE_STAIN',key,panel),ifEqual=resolveHeMsiAlignment(section,'IF_STAIN',key,panel);
      section.msiSeries.MSI_Y_OTHER.sourceGeometry.legacy.x=section.msiSeries.MSI_Y_OTHER.sourceGeometry.legacy.x.map(p=>[p[0]+100,p[1]]);
      const coordinates=resolveHeMsiAlignment(section,'HE_STAIN',key,panel);
      return {numeric:{status:numeric.status,join:numeric.joinMethod,total:numeric.statistics.totalRatio},
        legacyHidden,legacyStatus,equalShown,
        mismatch:{status:mismatch.status,reason:mismatch.reason,T:mismatch.T},equal:equal.status,
        managedMismatch:{status:managedMismatch.status,reason:managedMismatch.reason,T:managedMismatch.T},ifEqual:ifEqual.status,
        coordinates:{status:coordinates.status,reason:coordinates.reason}};
      })();window.__ratioAlignmentTest.then(value=>{window.__ratioAlignmentResult=value;},
        error=>{window.__ratioAlignmentError=String(error.stack||error);});
    });
    await page.waitForFunction(()=>window.__ratioAlignmentResult||window.__ratioAlignmentError);
    assert.equal(await page.evaluate(()=>window.__ratioAlignmentError),undefined);
    const alignment=await page.evaluate(()=>window.__ratioAlignmentResult);
    assert.equal(alignment.numeric.status,'ready');assert.equal(alignment.numeric.total,2);
    assert.equal(alignment.legacyHidden,true);assert.match(alignment.legacyStatus,/HE\/IF を非表示/);
    assert.match(alignment.legacyStatus,/位置合わせが一致/);assert.equal(alignment.equalShown,true);
    assert.match(alignment.numeric.join,/coordinate/);
    assert.deepEqual(alignment.mismatch,{status:'unavailable',reason:'ratio-transform-mismatch',T:null});
    assert.deepEqual(alignment.managedMismatch,alignment.mismatch);
    assert.equal(alignment.equal,'ready');assert.equal(alignment.ifEqual,'ready');
    assert.deepEqual(alignment.coordinates,{status:'unavailable',reason:'ratio-coordinate-mismatch'});
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(state.writes,[]);
    console.log('Ratio browser outputs: actual resolver → PPT/ROI/photo, saved Same/Individual ranges, immutable sources and cross-source HE/IF guards PASS.');
  } finally {if(browser)await browser.close();await state.close();}
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
