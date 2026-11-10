'use strict';
// Actual viewer and generated numerical Worker, using synthetic originals only.
// Timing is reported, not asserted against a machine-dependent millisecond cap.
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs/promises');
const syncFs=require('node:fs');
const {chromium}=require('playwright');
const {fixture,archive,startServer}=require('./msi_ratio_browser_regression.cjs');
const {renderOfflineConfig}=require('../offline/config.cjs');
function dataFor(count){
  const data=fixture();data.doc.sections=data.doc.sections.slice(0,1);data.rois=data.rois.slice(0,1);
  const lines=['x,y,X,Y'];
  for(let i=0;i<count;i++){
    const at=i&&i%101===0?i-1:i;
    const x=i%59===0?'':i%71===0?-2:i%17,y=i%47===0?0:i%13+1;
    lines.push([at%1000,Math.floor(at/1000),x,y].join(','));
  }
  data.sources['synthetic/ratio-0.csv']=lines.join('\n')+'\n';return data;
}
async function measure(count,{overrides={}}={}){
  const data=dataFor(count),server=await startServer(data),browser=await chromium.launch({headless:true});
  const errors=[],external=[];
  try{
    // Numerical timing excludes static startup. Serve identical repository
    // bytes from RAM so unrelated Windows filesystem/server stalls do not mask
    // a real Worker parity/responsiveness failure before analysis even starts.
    const repo=path.resolve(__dirname,'..'),assets=new Map();
    const html=overrides['/viewer/index.html']||syncFs.readFileSync(path.join(repo,'viewer/index.html'),'utf8');
    const paths=new Set(['/viewer/index.html','/viewer/msi-ratio-worker.js',
      '/vendor/xlsx.full.min.js','/vendor/pako.min.js','/vendor/UTIF.js']);
    for(const match of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)){
      const url=new URL(match[1],server.origin+'/viewer/');if(url.origin===server.origin)paths.add(url.pathname);
    }
    for(const name of paths)assets.set(name,name==='/runtime-config.js'?renderOfflineConfig():overrides[name]||syncFs.readFileSync(path.join(repo,name.slice(1))));
    const page=await browser.newPage({viewport:{width:1200,height:850}});page.setDefaultTimeout(30000);
    const pendingRequests=new Set();
    page.on('request',request=>pendingRequests.add(request.url()));
    page.on('requestfinished',request=>pendingRequests.delete(request.url()));
    page.on('requestfailed',request=>pendingRequests.delete(request.url()));
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===server.origin){
        const key=url.pathname==='/viewer/'?'/viewer/index.html':url.pathname;
        if(assets.has(key))return route.fulfill({status:200,body:assets.get(key),contentType:key.endsWith('.html')?'text/html':key.endsWith('.css')?'text/css':'text/javascript'});
        return route.continue();
      }
      if(/^(blob|data):/.test(url.href))return route.continue();external.push(url.href);return route.abort();
    });
    try{await page.goto(server.origin+'/viewer/?project=ratio-analysis-fixture');}
    catch(error){console.error('Ratio fixture startup diagnostics:',JSON.stringify({pendingRequests:[...pendingRequests],errors}));throw error;}
    await page.waitForFunction(()=>typeof App!=='undefined'&&App.offline);
    const bytes=await archive(data);
    await page.evaluate(async encoded=>{await importZipFile(new Blob([Uint8Array.from(atob(encoded),c=>c.charCodeAt(0))]),{review:()=>true});},bytes.toString('base64'));
    const result=await page.evaluate(async()=>{
      const section=App.project.sections[0],panel=App.panels.get(section.id);
      for(const key of ['MSI_X','MSI_Y'])if(!await panel.ensureMsiLayerLoaded(key))throw new Error('Fixture raster failed: '+key);
      await App.setOtsuBgRemove(false);
      const definition={id:'analysis',name:'X / Y',revision:1,operation:'divide',calculationVersion:'msi-ratio-v1',
        denominatorMin:0,numeratorPolicy:'nonnegative',invalidPolicy:'exclude',bindings:{[MsiRatioModel.canonicalSectionId(section)]:{
          numerator:MsiRatioModel.makeInputRef(section.msiSeries.MSI_X,'MSI_X'),denominator:MsiRatioModel.makeInputRef(section.msiSeries.MSI_Y,'MSI_Y'),coordinateConfirmed:false}}};
      MsiRatioRuntime.store(definition);const key=MsiRatioModel.displayKey(definition.id),operations=[],operationTimes=[];
      const service=typeof getMsiAnalysisService==='function'?getMsiAnalysisService():null;
      if(service){const original=service.request;service.request=function(op,...args){
        operations.push(op);const row={op,startMs:Math.round(performance.now()),elapsedMs:null};operationTimes.push(row);
        return original.call(this,op,...args).finally(()=>{row.elapsedMs=Math.round(performance.now()-row.startMs);});
      };}
      const originals=async()=>{
        const files=[];
        for(const id of new Set(Object.values(section.msiSeries).map(entry=>entry.blobId))){
          const record=await ProjectStorage.getBlob(id);
          files.push([id,Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await record.blob.arrayBuffer())))]);
        }
        return JSON.stringify({files,registry:App.project.meta.msiRatios,
          inputs:Object.entries(section.msiSeries).map(([key,entry])=>[key,MsiRatioModel.makeInputRef(entry,key)])});
      };
      const before=await originals();let previous=performance.now(),maxGap=0,ticks=0,pending=true,pendingTicks=0;
      const timer=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;ticks++;if(pending)pendingTicks++;},16);
      const start=performance.now(),value=await App.resolveRatio(section,key,{roiStats:false}),elapsed=performance.now()-start;pending=false;
      await new Promise(resolve=>setTimeout(resolve,20));clearInterval(timer);
      const warm=performance.now();await App.resolveRatio(section,key,{roiStats:false});const cached=performance.now()-warm;
      const arrays={values:value.values,valid:value.valid,reasons:value.reasons,denominatorOrder:value.denominatorOrder,
        rowIds:value.rowIds,raster:value.raster.values,numerator:value.numerator.values,denominator:value.denominator.values};
      const hashes={};
      for(const [key,array] of Object.entries(arrays)){
        const typed=ArrayBuffer.isView(array)?array:Float64Array.from(array);
        hashes[key]=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(typed.buffer,typed.byteOffset,typed.byteLength))),n=>n.toString(16).padStart(2,'0')).join('');
      }
      return {scientific:{count:value.values.length,hashes,statistics:value.statistics,robustMax:value.robustMax,
          displayAuto:value.displayAuto,joinMethod:value.joinMethod,sourceGeometry:value.sourceGeometry},
        elapsedMs:Math.round(elapsed),cachedMs:Math.round(cached),maxHeartbeatGapMs:Math.round(maxGap),heartbeatTicks:ticks,pendingTicks,operations,operationTimes,
        originalsUnchanged:before===await originals(),lazyPositions:!Array.isArray(value.positions)};
    });
    assert.deepEqual(errors,[]);assert.deepEqual(external,[]);return result;
  }finally{await browser.close();await server.close();}
}
async function main(){
  const actual=await measure(100000);
  const expected=JSON.parse(await fs.readFile(path.join(__dirname,'fixtures/msi-ratio-analysis-phase1-100000.json'),'utf8'));
  assert.deepEqual(actual.scientific,expected.scientific,'Numeric arrays, original row order, reasons and statistics equal the saved phase-1 implementation exactly');
  assert.equal(actual.originalsUnchanged,true);assert.equal(actual.lazyPositions,true);
  assert.ok(actual.operations.includes('source-open'));assert.ok(actual.operations.includes('ratio'));
  assert.ok(actual.pendingTicks>0,'The page event loop runs while numerical analysis is pending');
  console.log('Ratio numerical Worker browser: PASS '+JSON.stringify({elapsedMs:actual.elapsedMs,cachedMs:actual.cachedMs,maxHeartbeatGapMs:actual.maxHeartbeatGapMs,pendingTicks:actual.pendingTicks}));
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={measure,dataFor};
