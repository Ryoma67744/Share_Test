'use strict';
// Real ZIP writer/importer and shared hydration, using synthetic measured rows.
const assert=require('node:assert/strict'),fs=require('node:fs/promises');
const {chromium}=require('playwright'),JSZip=require('../vendor/jszip.min.js');
const {fixture,archive,startServer,prepare,createRatio}=require('./msi_ratio_browser_regression.cjs');
async function importBytes(page,buffer){
  await page.evaluate(async bytes=>{
    const data=Uint8Array.from(atob(bytes),c=>c.charCodeAt(0));
    await importZipFile(new Blob([data]),{review:()=>true});
  },buffer.toString('base64'));
}
async function exportBytes(page,personal){
  const download=page.waitForEvent('download');
  const exporting=page.evaluate(()=>exportProjectAsZip());
  if(personal!==undefined){
    const box=page.locator('[data-ratio-zip-personal]');await box.waitFor();
    await box.setChecked(personal);await page.locator('#modal-host [data-modal-ok]').last().click();
  }
  const result=await download;await exporting;
  return fs.readFile(await result.path());
}
async function manifest(buffer){
  const zip=await JSZip.loadAsync(buffer),files=Object.keys(zip.files).filter(p=>/^[^/]+\.json$/.test(p));
  for(const p of files){const doc=JSON.parse(await zip.file(p).async('string'));if(doc.format==='desi_data_share_v2')return {zip,doc};}
  throw new Error('Project manifest missing');
}
async function values(page){return page.evaluate(async()=>{
  const def=App.getRatioDefinitions().at(-1),key=MsiRatioModel.displayKey(def.id),out=[];
  for(const sec of App.project.sections){const r=await App.resolveRatio(sec,key);out.push({values:Array.from(r.values),stats:r.statistics,roi:r.roiStats.map(x=>x.statistics)});}
  return out;
});}
async function main(){
  const data=fixture(),server=await startServer(data),browser=await chromium.launch({headless:true});
  const errors=[];
  try{
    const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}}),page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.dismiss());
    await page.goto(server.origin+'/viewer/?project=ratio-empty');await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
    await importBytes(page,await archive(data));await prepare(page);await createRatio(page);
    await page.locator('#msi-ratio-dialog').evaluate(el=>el.close());
    await page.locator('#msi-scale-mode').selectOption('individual');
    await page.locator('#tb-range-max').fill('4');await page.locator('#tb-range-max').dispatchEvent('change');
    await page.evaluate(()=>App.setActiveSection(App.project.sections[1].id));
    await page.locator('#tb-range-max').fill('6');await page.locator('#tb-range-max').dispatchEvent('change');
    const windows=()=>page.evaluate(()=>{const key=MsiRatioModel.displayKey(App.getRatioDefinitions()[0].id);return App.project.sections.map(s=>App.getRatioManualRange(key,s)?.max);});
    assert.deepEqual(await windows(),[4,6],'Individual ratio windows are independent per section');
    const before=await values(page),saved=await page.evaluate(()=>JSON.parse(JSON.stringify(App.project.meta.msiRatios)));
    const bytes=await exportBytes(page),packed=await manifest(bytes);
    assert.deepEqual(packed.doc.offlineSettings.meta.msiRatios,saved);
    assert.ok(packed.doc.sections.every(s=>!Object.keys(s.originalSeries).some(k=>k.startsWith('MSI_RATIO_'))));
    for(const s of packed.doc.sections)for(const e of Object.values(s.originalSeries)){
      assert.equal(await packed.zip.file(e.sourcePath).async('string'),data.sources['synthetic/'+e.filename]);
    }
    await importBytes(page,bytes);
    assert.equal(await page.evaluate(()=>App.project.sections.every(section=>{
      const id=MsiRatioModel.canonicalSectionId(section);
      return section.meta.spatialGroups && id===section.id && App.getRatioDefinitions().every(def=>
        def.bindings[id] && def.display.ranges.whole[id]);
    })),true,'grouped imported sections use fresh IDs for ratio bindings and individual ranges');
    assert.deepEqual(await values(page),before,'ZIP regenerates the same ratios and ROI values from exact sources');
    assert.deepEqual(await windows(),[4,6],'Ratio manual windows survive ZIP restoration');
    assert.equal(await page.evaluate(()=>MsiRatioModel.validateProjectReferences(App.project).valid),true);
    // Archive without canonical aliases must remap old local IDs to fresh IDs.
    const noAlias=await manifest(bytes),ids={};
    for(const s of noAlias.doc.sections){ids[s.meta.client_id]=s.id;delete s.meta.client_id;}
    for(const d of noAlias.doc.offlineSettings.meta.msiRatios.definitions)d.bindings=Object.fromEntries(Object.entries(d.bindings).map(([id,b])=>[ids[id]||id,b]));
    for(const d of noAlias.doc.offlineSettings.meta.msiRatios.definitions)for(const group of ['whole','roi'])if(d.display?.ranges?.[group])d.display.ranges[group]=Object.fromEntries(Object.entries(d.display.ranges[group]).map(([id,value])=>[ids[id]||id,value]));
    const docPath=Object.keys(noAlias.zip.files).find(p=>/^[^/]+\.json$/.test(p));noAlias.zip.file(docPath,JSON.stringify(noAlias.doc));
    await importBytes(page,await noAlias.zip.generateAsync({type:'nodebuffer'}));
    assert.deepEqual(await values(page),before,'fresh section IDs remap definitions');
    assert.deepEqual(await windows(),[4,6],'Individual ratio window IDs remap with the section bindings');
    assert.equal(await page.evaluate(()=>MsiRatioModel.validateProjectReferences(App.project).valid),true);
    // Simulate a server returning legacy server UUID bindings; hydrate resolves canonical IDs.
    const published=JSON.parse(JSON.stringify(saved));
    for(const d of published.definitions)d.bindings=Object.fromEntries(Object.entries(d.bindings).map(([id,b])=>[data.doc.sections.find(s=>s.meta.client_id===id)?.id||id,b]));
    data.doc.meta.project_meta.msiRatios=published;server.online=true;
    await context.addInitScript(()=>sessionStorage.setItem('desi:share:synthetic-ratio-help',JSON.stringify({slug:'synthetic-ratio-help',role:'viewer',token:'synthetic-ratio-viewer',expiresAt:new Date(Date.now()+3600000).toISOString(),isPublic:false})));
    const shared=await context.newPage();shared.on('pageerror',e=>errors.push(e.message));shared.on('dialog',d=>d.dismiss());
    await shared.goto(server.origin+'/viewer/index.html#share=synthetic-ratio-help');await prepare(shared,true);
    assert.deepEqual(await values(shared),before,'shared published ratio survives server UUID aliases');
    await shared.evaluate(()=>{const def=JSON.parse(JSON.stringify(App.getRatioDefinitions()[0]));def.name='Personal ratio';def.denominatorMin=2;def.revision++;MsiRatioRuntime.store(def,def.id);});
    assert.equal(await shared.evaluate(()=>App.getRatioDefinitions().length),2);
    const withPersonal=await manifest(await exportBytes(shared,true));
    const publicOnly=await manifest(await exportBytes(shared,false));
    assert.equal(withPersonal.doc.offlineSettings.meta.msiRatios.definitions.length,2);
    assert.equal(publicOnly.doc.offlineSettings.meta.msiRatios.definitions.length,1);
    assert.equal(publicOnly.doc.offlineSettings.meta.msiRatios.definitions[0].denominatorMin,0);
    assert.deepEqual(data.doc.meta.project_meta.msiRatios,published,'published metadata is unchanged');
    assert.deepEqual(server.writes,[],'shared ratios require no server mutation');
    assert.deepEqual(errors,[]);
    console.log('MSI ratio archive browser: exact-source ZIP roundtrip, ID remap, shared aliases, personal opt-in/out passed');
  }finally{await browser.close();await server.close();}
}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
