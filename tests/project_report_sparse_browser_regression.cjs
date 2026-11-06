'use strict';
// Production import, numeric parser, report adapter and PPT download. Every
// source is synthetic and this isolated browser can only contact localhost.
const assert=require('node:assert/strict'),fs=require('node:fs/promises');
const {chromium}=require('playwright');
const JSZip=require('../vendor/jszip.min.js');
const {fixture,archive,startServer,prepare}=require('./msi_ratio_browser_regression.cjs');
// Three independent acquisition sets, each shared by two sections. Keeping
// the source columns distinct lets the assertions check every registration
// and its original statistics rather than only the final page count.
function mixedAcquisitions(){
 const data=fixture(),template=data.doc.sections[0],roi=data.rois[0];
 data.sources={};data.doc.sections=[];data.rois=[];
 const expected=[];
 for(const [group,count] of [16,17,15].entries())for(let replicate=0;replicate<2;replicate++){
  const index=group*2+replicate,letter=String.fromCharCode(65+group),factor=index+1;
  const section=structuredClone(template),sourcePath='synthetic/acquisition-'+index+'.csv';
  section.id='mixed-server-'+index;section.meta.client_id='mixed-section-'+index;section.ordinal=index+1;
  section.display_name='Sample '+letter+(replicate+1);
  const columns=Array.from({length:count},(_,i)=>'C'+String(i+1).padStart(2,'0'));
  const rows=[['x','y',...columns].join(',')];
  for(let y=0;y<16;y++)for(let x=0;x<32;x++)rows.push([x,y,...columns.map((_,i)=>
   group===0&&i===0?0:factor*(i+1)*(y*32+x+1))].join(','));
  data.sources[sourcePath]=rows.join('\n')+'\n';
  section.storage_paths={images:{},msiSeries:{}};
  columns.forEach((column,i)=>{
   const name='Set '+letter+' MRM '+String(i+1).padStart(2,'0'),zero=group===0&&i===0;
   section.storage_paths.msiSeries['MSI_'+letter+'_'+column]={kind:'txt',path:sourcePath,mime:'text/csv',
    filename:'acquisition-'+index+'.csv',sourceFileId:'ratio-file-'+index,sourceReference:'ratio-source-'+index,
    sourceRevision:'revision-1',x:'x',y:'y',v:column,sep:',',bakeMode:'full',
    compoundMeta:{base:name,precursor:100+i,product:50+i,ce:10,cv:20,polarity:'+',dwell:[.011625,.010706,.012667][group]}};
   expected.push({name,section:section.display_name,mean:zero?0:factor*(i+1)*256.5,max:zero?0:factor*(i+1)*512,n:512});
  });
  data.doc.sections.push(section);
  const sectionRoi=structuredClone(roi);sectionRoi.id='mixed-roi-'+index;sectionRoi.section_id=section.id;
  sectionRoi.poly_msi.geometry.sourceRef='ratio-source-'+index;data.rois.push(sectionRoi);
 }
 return {data,expected};
}
async function readDownloadedDeck(download){
 const zip=await JSZip.loadAsync(await fs.readFile(await download.path()));
 const files=Object.keys(zip.files).filter(name=>/^ppt\/slides\/slide\d+\.xml$/.test(name))
  .sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
 return Promise.all(files.map(name=>zip.file(name).async('string')));
}
async function mixedAcquisitionReport(browser,server){
 const {data,expected}=mixedAcquisitions(),errors=[],external=[];
 const context=await browser.newContext({viewport:{width:1920,height:1080},acceptDownloads:true});
 try{
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(server.origin+'/')||/^(blob|data):/.test(url))return route.continue();external.push(url);return route.abort();});
  await page.goto(server.origin+'/viewer/?project=mixed-report-empty');await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
  await page.locator('#hidden-import-input').setInputFiles({name:'SyntheticMixedAcquisitions.zip',mimeType:'application/zip',buffer:await archive(data)});
  await page.getByRole('button',{name:'復元 / Restore',exact:true}).click();
  await page.waitForFunction(()=>App.project?.sections.length===6&&App.panels.size===6);
  const before=await page.evaluate(async()=>{
   // Warm numeric/statistical caches before taking the invariant snapshot;
   // export must preserve both source bytes and already derived values.
   for(const section of App.project.sections)for(const key of Object.keys(section.msiSeries)){
    if(!await App.panels.get(section.id).ensureMsiLayerLoaded(key))throw new Error('Mixed source failed: '+key);
   }
   await App._flushSave();
   for(const name of ['jszip','pptxgen','projectReportData','projectReportDeck'])await loadScript(LAZY_LIBS[name]);
   const original=ProjectReportData;
   window.ProjectReportData={...original,async prepare(...args){
    const report=await original.prepare(...args);
    window.mixedPrepared=report.molecules.map(m=>({name:m.name,sections:m.sections.map(e=>({name:e.name,
     image:!!e.image,missingReason:e.missingReason,mean:e.mean,max:e.max,n:e.n}))}));return report;
   }};
   window.mixedSnapshot=async()=>{
    const sources=[],rasters=[],seen=new Set();
    for(const section of App.project.sections)for(const [key,entry] of Object.entries(section.msiSeries)){
     if(!seen.has(entry.blobId)){
      seen.add(entry.blobId);const {blob}=await ProjectStorage.getBlob(entry.blobId);
      const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
      sources.push({id:entry.blobId,sha256:Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('')});
     }
     // The production cache is bounded; earlier channels may have been
     // evicted while warming the other acquisitions. Read each immediately.
     const panel=App.panels.get(section.id);
     if(!await panel.ensureMsiLayerLoaded(key))throw new Error('Snapshot source failed: '+key);
     rasters.push({section:section.id,key,values:Array.from(panel.msiValueRasters.get(key).values)});
    }
    return {sections:JSON.stringify(App.project.sections),rois:JSON.stringify(App.project.rois),sources,rasters};
   };
   return mixedSnapshot();
  });
  await page.locator('#btn-export-ppt').click();await page.locator('[data-report-create]').waitFor();
  const downloading=page.waitForEvent('download',{timeout:120000});await page.locator('[data-report-create]').click();
  const slides=await readDownloadedDeck(await downloading),prepared=await page.evaluate(()=>mixedPrepared);
  const summaries=slides.filter(xml=>xml.includes('MSI matrix ')),details=slides.filter(xml=>xml.includes('Max Intensity'));
  assert.equal(slides.length,51,'three acquisition matrices and 48 registered molecular details');
  assert.equal(summaries.length,3);assert.equal(details.length,48);assert.equal(prepared.length,48);
  const actual=prepared.flatMap(m=>m.sections.map(e=>({name:m.name,section:e.name,mean:e.mean,max:e.max,n:e.n})));
  const ordered=rows=>rows.slice().sort((a,b)=>JSON.stringify([a.name,a.section]).localeCompare(JSON.stringify([b.name,b.section])));
  assert.deepEqual(ordered(actual),ordered(expected),'all 96 registered pairs retain their source-row statistics');
  assert.ok(prepared.every(m=>m.sections.length===2&&m.sections.every(e=>e.image&&!e.missingReason)));
  const names=[...new Set(expected.map(e=>e.name))],sections=data.doc.sections.map(s=>s.display_name);
  const expectedPairs=expected.map(e=>JSON.stringify([e.name,e.section])).sort();
  const tokens=xml=>new Set([...xml.matchAll(/<a:t>(.*?)<\/a:t>/g)].map(match=>match[1]));
  const pairsOnPages=pages=>pages.flatMap(xml=>{
   const text=tokens(xml),molecules=names.filter(name=>text.has(name)),columns=sections.filter(name=>text.has(name));
   assert.equal(columns.length,2,'each matrix/detail names only its two acquired sections');
   return molecules.flatMap(name=>columns.map(section=>JSON.stringify([name,section])));
  }).sort();
  assert.deepEqual(pairsOnPages(summaries),expectedPairs,'matrix row/column combinations exactly match registration, without missing or duplicate cells');
  assert.deepEqual(pairsOnPages(details),expectedPairs,'detail titles and columns exactly match registration, without missing or duplicate pages');
  assert.doesNotMatch(slides.join('\n'),/No image|No registered MSI|この分子・測定条件は切片に登録されていません/);
  assert.deepEqual(await page.evaluate(()=>mixedSnapshot()),before,'mixed export preserves source hashes, numeric rasters, metadata and ROI');
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 }finally{await context.close();}
}
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
  const slides=await readDownloadedDeck(await downloading);
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
  assert.equal(slides.length,6,'three distinct registration matrices and one detail per molecular group');
  assert.doesNotMatch(all,/この分子・測定条件は切片に登録されていません|No registered MSI layer|Unregistered empty D/);
  assert.equal((all.match(/No image/g)||[]).length,2,'only the real read failure remains in the matrix and its detail');
  const xMatrix=text.find(value=>value.includes('Molecule X')&&value.includes('MSI matrix '));
  assert.ok(xMatrix.includes('Registered A'));assert.doesNotMatch(xMatrix,/Registered B|Registered unreadable C|Molecule Y/);
  const yMatrix=text.find(value=>value.includes('Molecule Y')&&value.includes('MSI matrix '));
  assert.ok(yMatrix.includes('Registered A')&&yMatrix.includes('Registered B'));assert.doesNotMatch(yMatrix,/Registered unreadable C|Molecule X/);
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
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  await context.close();await mixedAcquisitionReport(browser,server);
  assert.deepEqual(server.writes,[]);
  console.log('Sparse report browser regression: PASS (six-section mixed import/export: 51 slides, all 96 registered pairs exactly once per view; unreadable original warning, valid zeros, ratio availability and source/ROI invariance retained)');
 }finally{await browser?.close();await server.close();}
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
