'use strict';
// Production import, numeric parser, report adapter and PPT download. Every
// source is synthetic and this isolated browser can only contact localhost.
const assert=require('node:assert/strict'),fs=require('node:fs/promises');
const {chromium}=require('playwright');
const JSZip=require('../vendor/jszip.min.js');
const {fixture,archive,startServer,prepare}=require('./msi_ratio_browser_regression.cjs');
async function main(){
 const data=fixture(),rows=['x,y,X,Y'];
 for(let y=0;y<16;y++)for(let x=0;x<32;x++)rows.push([x,y,0,1].join(','));
 data.sources['synthetic/ratio-0.csv']=rows.join('\n')+'\n';
 const server=await startServer(data);let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const context=await browser.newContext({viewport:{width:1920,height:1080},acceptDownloads:true}),page=await context.newPage(),errors=[],external=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());
  await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(server.origin+'/')||/^(blob|data):/.test(url))return route.continue();external.push(url);return route.abort();});
  await page.goto(server.origin+'/viewer/?project=report-sparse-empty');await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
  await page.locator('#hidden-import-input').setInputFiles({name:'SyntheticSparseReport.zip',mimeType:'application/zip',buffer:await archive(data)});
  await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();await prepare(page);
  const before=await page.evaluate(async()=>{
   const sections=App.project.sections;sections[0].displayName='Registered A';sections[1].displayName='Registered B';
   delete sections[1].msiSeries.MSI_X;
   sections.push({id:'broken-section',ordinal:3,displayName:'Registered unreadable C',meta:{},images:{},msiFiles:{},
    msiSeries:{MSI_BROKEN:{kind:'txt',blobId:'synthetic-original-does-not-exist',sourceFileId:'synthetic-broken-source',
     sourceReference:'synthetic-broken-source',sourceRevision:'revision-1',filename:'missing-original.csv',
     compoundMeta:{base:'Registered unreadable molecule'}}}});
   sections.push({id:'empty-section',ordinal:4,displayName:'Unregistered empty D',meta:{},images:{},msiFiles:{},msiSeries:{}});
   await App.rebuildSectionPanels();await App._flushSave();
   for(const name of ['jszip','pptxgen','projectReportData','projectReportDeck'])await loadScript(LAZY_LIBS[name]);
   const original=ProjectReportData;
   window.ProjectReportData={...original,async prepare(...args){
    const report=await original.prepare(...args);
    window.sparsePrepared=report.molecules.map(m=>({name:m.name,sections:m.sections.map(e=>({sectionId:e.sectionId,name:e.name,
     image:!!e.image,missingReason:e.missingReason,mean:e.mean,max:e.max,n:e.n}))}));return report;
   }};
   window.sparseSnapshot=async()=>{
    const original=App.project.sections[0],entry=original.msiSeries.MSI_X,panel=App.panels.get(original.id);
    const blob=(await ProjectStorage.getBlob(entry.blobId)).blob;
    return {sections:JSON.stringify(App.project.sections),rois:JSON.stringify(App.project.rois),
     source:await blob.text(),values:Array.from(panel.msiValueRasters.get('MSI_X').values),mean:entry.rawMean,max:entry.rawTrueMax};
   };
   return sparseSnapshot();
  });
  await page.locator('#btn-export-ppt').click();await page.locator('[data-report-create]').waitFor();
  const downloading=page.waitForEvent('download',{timeout:60000});await page.locator('[data-report-create]').click();
  const download=await downloading,zip=await JSZip.loadAsync(await fs.readFile(await download.path()));
  const files=Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  const slides=await Promise.all(files.map(name=>zip.file(name).async('string')));
  const text=slides.map(xml=>[...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map(m=>m[1]).join(' ')),all=text.join('\n');
  const prepared=await page.evaluate(()=>sparsePrepared),byName=new Map(prepared.map(m=>[m.name,m]));
  assert.equal(prepared.length,3);
  const zero=byName.get('Molecule X').sections;
  assert.equal(zero.length,1);assert.equal(zero[0].name,'Registered A');assert.equal(zero[0].image,true);
  assert.deepEqual({mean:zero[0].mean,max:zero[0].max,n:zero[0].n},{mean:0,max:0,n:512},'all measured zeros remain valid quantitative data');
  assert.equal(byName.get('Molecule Y').sections.length,2);
  const unreadable=byName.get('Registered unreadable molecule').sections;
  assert.equal(unreadable.length,1);assert.equal(unreadable[0].name,'Registered unreadable C');assert.equal(unreadable[0].image,false);
  assert.match(unreadable[0].missingReason,/元の数値データを読み込めませんでした/);
  assert.equal(slides.length,4,'one matrix and one detail slide for each registered molecular group');
  assert.doesNotMatch(all,/この分子・測定条件は切片に登録されていません|No registered MSI layer|Unregistered empty D/);
  assert.equal((all.match(/No image/g)||[]).length,2,'only the real read failure remains in the matrix and its detail');
  const xDetail=text.find(value=>value.includes('Molecule X')&&value.includes('Max Intensity'));
  assert.ok(xDetail.includes('Registered A'));assert.doesNotMatch(xDetail,/Registered B|Registered unreadable C/);
  assert.ok(text.some(value=>value.includes('Registered unreadable molecule')&&value.includes('元の数値データを読み込めませんでした')));
  assert.deepEqual(await page.evaluate(()=>sparseSnapshot()),before,'export preserves registered metadata, ROI, original bytes and zero signals');

  // Ratios are definitions across sections, not acquired molecular groups.
  // An unbound section retains its explicit unavailable status in this change.
  const ratio=await page.evaluate(async()=>{
   const section=App.project.sections[0],def={id:'sparse-ratio',name:'Synthetic X / Y',revision:1,operation:'divide',
    calculationVersion:'msi-ratio-v1',denominatorMin:0,numeratorPolicy:'nonnegative',invalidPolicy:'exclude',bindings:{
     [MsiRatioModel.canonicalSectionId(section)]:{numerator:MsiRatioModel.makeInputRef(section.msiSeries.MSI_X,'MSI_X'),
      denominator:MsiRatioModel.makeInputRef(section.msiSeries.MSI_Y,'MSI_Y'),coordinateConfirmed:false}}};
   MsiRatioRuntime.store(def);
   const hooks={getApp:()=>App,transform:section=>sectionLayerViewLinear(section,'msi'),mean:msiQuantMean,max:msiMaxIntensity};
   const input=ProjectReportApp.createAdapter(hooks,{includeRatios:true}),source=input.molecules.find(m=>m.kind==='ratio');
   const entries=await source.loadEntries(),prepared=await ProjectReportData.prepare({...input,molecules:[source]},{nearestUpscale:false});
   const bytes=await ProjectReportDeck.create(prepared,{type:'blob'}),zip=await JSZip.loadAsync(bytes);
   const xml=(await Promise.all(Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name)).map(name=>zip.file(name).async('string')))).join('\n');
   return {entries:entries.map(e=>({name:e.name,missingReason:e.missingReason,raster:!!e.raster})),
    prepared:prepared.molecules[0].sections.map(e=>({name:e.name,image:!!e.image,stats:e.ratioStatistics})),xml};
  });
  assert.equal(ratio.entries.length,4);assert.equal(ratio.entries.filter(e=>e.raster).length,1);assert.equal(ratio.entries.filter(e=>e.missingReason).length,3);
  assert.equal(ratio.prepared[0].image,true);assert.equal(ratio.prepared[0].stats.nValid,512);assert.equal(ratio.prepared[0].stats.totalRatio,0);
  assert.match(ratio.xml,/Unregistered empty D/,'unbound ratio sections retain their existing explicit diagnostic');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(server.writes,[]);
  console.log('Sparse report browser regression: PASS (unregistered cells/pages omitted, unreadable original warning retained, valid zeros preserved, ratio availability unchanged, source/ROI invariance)');
 }finally{await browser?.close();await server.close();}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
