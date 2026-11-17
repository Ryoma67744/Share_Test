'use strict';
// Synthetic local data only: language changes must preserve open forms and scientific state.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {fixture,archive,startServer}=require('./msi_ratio_browser_regression.cjs');
async function main(){
 const server=await startServer(fixture()), browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
 try{
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>{errors.push(e.message);console.error('PAGE',e.message);});page.on('dialog',dialog=>{console.log('DIALOG',dialog.message());dialog.accept();});
  await context.route('**/*',route=>route.request().url().startsWith(server.origin+'/')||/^(blob|data):/.test(route.request().url())?route.continue():route.abort());
  await page.goto(server.origin+'/viewer/?project=i18n-synthetic-empty');
  await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline&&globalThis.AppI18n);
  await page.locator('#hidden-import-input').setInputFiles({name:'SyntheticI18n.zip',mimeType:'application/zip',buffer:await archive(fixture())});
  await page.getByRole('button',{name:'復元 / Restore',exact:true}).waitFor();
  await page.evaluate(()=>AppI18n.setLocale('en'));
  await page.getByRole('button',{name:'Restore',exact:true}).waitFor();
  assert.match(await page.locator('.modal-card').innerText(),/ZIP: registered originals 0/);
  assert.doesNotMatch(await page.locator('.modal-card').innerText(),/[\u3040-\u30ff\u3400-\u9fff]/);
  await page.evaluate(()=>AppI18n.setLocale('ja'));
  await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();
  await page.waitForFunction(()=>App.project?.sections.length===2&&App.panels.size===2);
  await page.evaluate(async()=>{
   for(const section of App.project.sections)for(const key of Object.keys(section.msiSeries))await App.panels.get(section.id).ensureMsiLayerLoaded(key);
   App.setActiveSection(App.project.sections[0].id);App.setViewMode('compound');App.setFocusCompoundKey('MSI_X');await App.setOtsuBgRemove(false);
   window.i18nOriginal=JSON.stringify({rois:App.project.rois,series:App.project.sections.map(s=>s.msiSeries)});
  });
  await page.locator('#btn-msi-ratio').click();
  const ratio=page.locator('#msi-ratio-dialog');
  await ratio.locator('[data-ratio-name]').fill('未保存の名前 / user value');
  await ratio.locator('[data-ratio-x]').first().selectOption('MSI_X');await ratio.locator('[data-ratio-y]').first().selectOption('MSI_Y');
  await ratio.locator('[data-ratio-threshold]').fill('3');
  await page.evaluate(()=>{window.i18nDraft=document.querySelector('[data-ratio-name]');AppI18n.setLocale('en');});
  await page.getByRole('button',{name:'Save and display',exact:true}).waitFor();
  assert.equal(await ratio.locator('[data-ratio-name]').inputValue(),'未保存の名前 / user value');
  assert.equal(await ratio.locator('[data-ratio-threshold]').inputValue(),'3');
  assert.equal(await ratio.locator('[data-ratio-x]').first().inputValue(),'MSI_X');
  assert.equal(await page.evaluate(()=>window.i18nDraft===document.querySelector('[data-ratio-name]')),true);
  assert.match(await ratio.locator('[data-ratio-x]').first().getAttribute('aria-label'),/numerator X/);
  assert.doesNotMatch(await ratio.innerText(),/[\u3040-\u30ff\u3400-\u9fff]/);
  await ratio.locator('[data-ratio-apply]').click();await ratio.locator('[data-ratio-results] table').waitFor();
  await page.evaluate(()=>{window.i18nSummary=document.querySelector('[data-ratio-results] table');AppI18n.setLocale('ja');});
  assert.equal(await page.evaluate(()=>window.i18nSummary===document.querySelector('[data-ratio-results] table')),true,'locale changes retain the completed summary table');
  await page.evaluate(()=>AppI18n.setLocale('en'));await ratio.getByRole('button',{name:'Close',exact:true}).waitFor();
  assert.equal(await ratio.locator('[data-ratio-results] table').count(),1);
  await page.evaluate(()=>{window.i18nOriginal=JSON.stringify({rois:App.project.rois,series:App.project.sections.map(s=>s.msiSeries)});});
  await ratio.getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('#btn-export-ppt').click();await page.locator('[data-report-create]').waitFor();
  await page.locator('[data-report-add-group]').click();await page.locator('[data-report-group-name]').fill('比較 group user name');
  await page.evaluate(()=>{window.i18nGroup=document.querySelector('[data-report-group-name]');AppI18n.setLocale('ja');});
  await page.getByRole('button',{name:'比較グループを追加',exact:true}).waitFor();
  assert.equal(await page.locator('[data-report-group-name]').inputValue(),'比較 group user name');
  assert.equal(await page.evaluate(()=>window.i18nGroup===document.querySelector('[data-report-group-name]')),true);
  await page.evaluate(()=>AppI18n.setLocale('en'));
  await page.getByRole('button',{name:'Add comparison group',exact:true}).waitFor();
  assert.equal(await page.locator('[data-report-group-name]').inputValue(),'比較 group user name');
  assert.match(await page.locator('.project-report-options thead').innerText(),/Comparison \/ independent/);
  await page.locator('[data-report-cancel]').click();
  await page.locator('[data-section-visibility]').first().click();
  const visibility=page.locator('.section-visibility-panel');await visibility.waitFor();
  await visibility.locator('[data-search]').fill('Synthetic');
  await page.evaluate(()=>{
   const controller=App.sectionVisibility(), originalSave=controller.save;
   window.i18nVisibility={controller,state:controller.state,scope:App.activeSectionScope,saves:0,originalSave};
   controller.save=function(){window.i18nVisibility.saves++;return originalSave.apply(this,arguments);};
  });
  await page.evaluate(()=>AppI18n.setLocale('ja'));await page.getByRole('button',{name:'すべて表示',exact:true}).waitFor();
  assert.equal(await visibility.locator('[data-search]').inputValue(),'Synthetic');
  await page.evaluate(()=>AppI18n.setLocale('en'));await page.getByRole('button',{name:'Show all',exact:true}).waitFor();
  assert.equal(await visibility.locator('[data-search]').inputValue(),'Synthetic');
  assert.deepEqual(await page.evaluate(()=>{
   const saved=window.i18nVisibility;
   saved.controller.save=saved.originalSave;
   return {saves:saved.saves,stateSame:saved.state===saved.controller.state,scopeSame:saved.scope===App.activeSectionScope};
  }),{saves:0,stateSame:true,scopeSame:true},'locale changes redraw section labels without saving or reapplying the scope');
  await visibility.locator('[data-close]').click();
  await page.evaluate(()=>{
   const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;canvas.getContext('2d').fillRect(0,0,16,16);
   const item={id:'photo-i18n',filename:'synthetic.png',title:'写真 user name',kind:'IF',magnification:'40×',revision:1};
   RoiMediaViewer.open({project:{id:'ui-photo-only'},roi:{id:'ui-roi-only',name:'ROI user'},adapter:{
    editable:()=>true,validateContext:()=>true,sections:()=>[{id:'S1',name:'Section user'}],
    list:()=>[item],loadPhoto:()=>({image:canvas,width:16,height:16,status:AppI18n.t('原解像度の画像'),statusI18n:['原解像度の画像']}),
    loadThumbnail:()=>({image:canvas,width:16,height:16}),compounds:()=>({items:[]}),add:async()=>[item]
   }});
  });
  const photo=page.locator('.roi-media-window');await photo.locator('input[name=title]').waitFor({state:'attached'});
  await photo.locator('details').evaluate(e=>e.open=true);
  await photo.locator('input[name=title]').fill('未保存 photo title');await photo.locator('textarea[name=note]').fill('未保存 note');
  await page.evaluate(()=>{window.i18nPhoto=document.querySelector('.roi-media-window input[name=title]');AppI18n.setLocale('ja');});
  await photo.getByRole('button',{name:'情報を保存',exact:true}).waitFor();
  assert.equal(await photo.locator('input[name=title]').inputValue(),'未保存 photo title');
  assert.equal(await photo.locator('.roi-media-form select').inputValue(),'IF');
  await page.evaluate(()=>AppI18n.setLocale('en'));await photo.getByRole('button',{name:'Save information',exact:true}).waitFor();
  assert.equal(await photo.locator('textarea[name=note]').inputValue(),'未保存 note');
  assert.equal(await page.evaluate(()=>window.i18nPhoto===document.querySelector('.roi-media-window input[name=title]')),true);
  assert.match(await photo.locator('.roi-media-form select').innerText(),/Fluorescence \/ IF/);
  await page.evaluate(()=>AppI18n.setLocale('ja'));
  await photo.locator('input[type=file][multiple]').setInputFiles({name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from('adapter fixture')});
  await page.waitForFunction(()=>document.querySelector('.roi-media-status')?.textContent==='画像を登録しました。');
  assert.equal(await photo.locator('.roi-media-resolution').innerText(),'原解像度の画像');
  await page.evaluate(()=>AppI18n.setLocale('en'));
  assert.equal(await photo.locator('.roi-media-status').innerText(),'Images registered.');
  assert.equal(await photo.locator('.roi-media-resolution').innerText(),'Original-resolution image');
  await page.evaluate(()=>RoiMediaViewer.close());
  await page.evaluate(()=>{
   AppI18n.setLocale('ja');
   const anchor=document.createElement('button');anchor.id='i18n-color-anchor';document.body.appendChild(anchor);
   openRoiFixedColorPicker(anchor,App.project,App.project.rois[0]);
  });
  assert.equal(await page.locator('#fixed-colors-title').innerText(),'ROI の色');
  await page.evaluate(()=>AppI18n.setLocale('en'));
  assert.equal(await page.locator('#fixed-colors-title').innerText(),'ROI color');
  await page.evaluate(()=>{FixedColors.close();document.querySelector('#i18n-color-anchor').remove();});
  await page.evaluate(async()=>{
   AppI18n.setLocale('ja');App.setFocusCompoundKey('MSI_X');await App.setRoiOnlyMode(true);
   await App.refreshRoiDisplayRanges();
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   Toolbar.refreshRange();
  });
  await page.waitForFunction(()=>!App._msiAbsScaleTimer&&!App._roiRangeRepaintTimer&&[...App._roiDisplayRanges.values()].every(entry=>entry.result.status!=='pending'));
  assert.match(await page.locator('#tb-range-min').getAttribute('title'),/ROI内/);
  await page.evaluate(()=>{
   // ensureRoiDisplayRange is also a cache lookup used by normal delayed paints.
   // Measure actual computation and retained summaries, not those harmless reads.
   const service=getMsiAnalysisService(),probe=window.i18nRangeProbe={jobs:0,service,
    request:service&&service.request,raster:MsiRoiRange.summarizeRaster,rows:MsiRoiRange.summarizeRows,
    entries:[...App._roiDisplayRanges].map(([key,entry])=>({key,entry,result:entry.result}))};
   if(service)service.request=function(kind){if(kind==='roi-range')probe.jobs++;return probe.request.apply(this,arguments);};
   MsiRoiRange.summarizeRaster=function(){probe.jobs++;return probe.raster.apply(this,arguments);};
   MsiRoiRange.summarizeRows=function(){probe.jobs++;return probe.rows.apply(this,arguments);};
   AppI18n.setLocale('en');
  });
  assert.doesNotMatch(await page.locator('#tb-range-min').getAttribute('title'),/[\u3040-\u30ff\u3400-\u9fff]/);
  assert.doesNotMatch(await page.locator('#tb-range-max').getAttribute('title'),/[\u3040-\u30ff\u3400-\u9fff]/);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.waitForFunction(()=>!App._msiAbsScaleTimer&&!App._roiRangeRepaintTimer);
  const rangeProbe=await page.evaluate(()=>{
   const probe=window.i18nRangeProbe;
   if(probe.service)probe.service.request=probe.request;
   MsiRoiRange.summarizeRaster=probe.raster;MsiRoiRange.summarizeRows=probe.rows;
   return {jobs:probe.jobs,cacheSame:App._roiDisplayRanges.size===probe.entries.length&&probe.entries.every(({key,entry,result})=>App._roiDisplayRanges.get(key)===entry&&entry.result===result)};
  });
  assert.deepEqual(rangeProbe,{jobs:0,cacheSame:true},'locale refresh preserves cached ROI summaries without restarting range calculations');
  assert.equal(await page.evaluate(()=>JSON.stringify({rois:App.project.rois,series:App.project.sections.map(s=>s.msiSeries)})===window.i18nOriginal),true,'language changes leave scientific data unchanged');
  assert.deepEqual(errors,[]);
  console.log('Viewer i18n browser regression: PASS (ratio, PPT and photo drafts, section search, labels, values and scientific state)');
 } finally {await browser.close();await server.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={main};
