'use strict';
// Actual viewer, source readers, canvas, IndexedDB and export snapshots. All
// original files are synthetic localhost responses. Gates express dependency
// ordering; no elapsed-time threshold or sleep makes a test pass.
const assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {createServer}=require('node:http'),{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(prefix){
 const sources={};
 const sections=[1,9].map((factor,index)=>{
  const sid=prefix+'-s'+index,sourcePath=prefix+'/source-'+index+'.csv',rows=['x,y,A,B'];
  for(let y=0;y<8;y++)for(let x=0;x<8;x++){const value=(1+x+y*8)*factor;rows.push([x,y,value,value*3].join(','));}
  sources[sourcePath]={type:'text/csv',bytes:Buffer.from(rows.join('\n')+'\n')};
  const base={path:sourcePath,filename:'source-'+index+'.csv',mime:'text/csv',kind:'txt',
   sourceFileId:sid+'-file',sourceRevision:'fixture-v1',sourceReference:sid+'-frame',
   x:'x',y:'y',sep:',',bakeMode:'full',rasterW:8,rasterH:8};
  const msiSeries={};
  for(const [key,column,multiplier] of [['MSI_A','A',1],['MSI_B','B',3]])msiSeries[key]={...base,v:column,
   rawRange:[0,64*factor*multiplier],rawTrueMax:64*factor*multiplier,rawDispMax:64*factor*multiplier,
   compoundMeta:{base:key,name:key,precursor:101,product:column==='A'?50:51,ce:10,cv:20,polarity:'+'}};
  const images={};
  if(index===1){
   const imagePath=prefix+'/hidden.png';
   sources[imagePath]={type:'image/png',bytes:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a32sAAAAASUVORK5CYII=','base64')};
   images.HE_STAIN={path:imagePath,filename:'hidden.png',mime:'image/png'};
  }
  const msiFiles={[base.sourceFileId]:{...base,id:base.sourceFileId}};
  if(index===1){const unused=prefix+'/unused.txt';sources[unused]={type:'text/plain',bytes:Buffer.from('registered unused original\r\n')};
   msiFiles.unused={id:'unused',path:unused,filename:'unused.txt',mime:'text/plain',kind:'txt'};}
  return {id:sid,ordinal:index,display_name:'Synthetic section '+index,
   meta:{visibleLayers:['MSI_A'],world_coords:{msi_um_per_px:{x:30,y:60}},
    displayTransform:{version:2,baseOrientation:'native-raster'}},
   storage_paths:{images,msiSeries,msiFiles}};
 });
 return {sources,doc:{id:prefix,publish_revision:7,meta:{display_name:prefix,project_meta:{colormap:'hotmetal',
  msiSmoothing:'none',msiDisplay:{version:2,preset:'hdi',aspectMode:'physical',rangePolicy:'maximum',smoothingStrength:1,linearStrength:10}}},
  sections,anatomy_palette:{}}};
}

async function install(page,doc){
 await page.evaluate(input=>{
  const state=window.__demand={doc:input,errors:[],hydrateDone:false};
  SupabaseClient.fetchProjectDoc=async()=>structuredClone(state.doc);
  for(const name of ['listRois','listShareOverlays','listShareAlignments','listShareImages'])SupabaseClient[name]=async()=>[];
  SupabaseClient.publicUrl=(_bucket,key)=>location.origin+'/original/'+key;
  state.session=project=>({slug:project.id,role:'viewer',token:'synthetic-read-token',expiresAt:Date.now()+3600000});
  state.selectFirst=project=>sessionStorage.setItem(SectionVisibility.contextKey(project,state.session(project)),JSON.stringify({
   known:project.sections.map(section=>section.id),selected:[project.sections[0].id]}));
  state.hydrate=project=>{
   state.doc=project;state.selectFirst(project);App.shareMode=state.session(project);
   App.focusCompoundKey='MSI_A';App.viewMode='compound';state.hydrateDone=false;
   const promise=App._hydrateSharedProject(App.shareMode).then(()=>{App._stopShareRoiPoll();state.hydrateDone=true;});
   state.hydration=promise;promise.catch(error=>state.errors.push(error.message));return promise;
  };
  state.painted=id=>{
   const panel=App.panels.get(id),canvas=panel?.dom?.cdisp;
   if(!panel?.isMsiLayerReady('MSI_A')||!canvas?.width||!canvas?.height)return false;
   return panel.displayCtx.getImageData(0,0,canvas.width,canvas.height).data.some((value,index)=>index%4!==3&&value>0);
  };
 },doc);
}

async function testRoiReadiness(makePage,data){
 const {page,context}=await makePage();await install(page,data.doc);
 await page.evaluate(()=>{
  const state=__demand;state.roiCalls=[];state.failRois=true;state.roiRows=[];
  state.roiGate=new Promise(resolve=>state.releaseRois=resolve);
  SupabaseClient.listRois=async(_token,sectionId)=>{
   state.roiCalls.push(sectionId);await state.roiGate;
   if(state.failRois)throw new Error('synthetic ROI download failed');
   return state.roiRows.filter(row=>row.section_id===sectionId);
  };
  void state.hydrate(state.doc);
 });
 await page.waitForFunction(()=>__demand.hydrateDone&&__demand.painted('roi-demand-s0'));
 const pending=await page.evaluate(()=>({state:App.project.__shareRoiState.status,
  range:App.getRoiDisplayRange(App.project.sections[0],'MSI_A').status,text:document.getElementById('roi-list').textContent}));
 assert.equal(pending.state,'pending');assert.equal(pending.range,'pending');assert.match(pending.text,/読み込み中/);assert.doesNotMatch(pending.text,/No ROI yet/);
 if(await page.locator('[data-preview-close]').isVisible())await page.locator('[data-preview-close]').click();
 await page.evaluate(()=>{
  const state=__demand,section=App.project.sections[0],raster=App.panels.get(section.id).msiValueRasters.get('MSI_A');
  state.roiRows=[{id:'roi-delayed',section_id:section.id,color_key:'Red',name:'Delayed left half',version:1,
   poly_msi:{version:'msi-roi-polygon-v1',vertices:[[-.5,-.5],[3.5,-.5],[3.5,7.5],[-.5,7.5]],
    geometry:{version:'msi-source-v1',sourceRef:raster.sourceGeometry.sourceRef,displayGeometry:raster.sourceGeometry.displayGeometry}}}];
  state.roiModeTask=App.setRoiOnlyMode(true);state.roiModeTask.catch(error=>state.errors.push(error.message));
 });
 assert.equal(await page.evaluate(()=>App.getCommonScaleStatus('MSI_A')),'pending','Same ROI range remains pending while the roster is unknown');
 await page.evaluate(()=>__demand.releaseRois());
 await page.waitForFunction(()=>App.project.__shareRoiState.status==='error'&&document.querySelector('#roi-list button'));
 const failed=await page.evaluate(async()=>{
  await __demand.roiModeTask;
  let rejected=false;try{await ensureSharedRoisReady(App.project);}catch(error){rejected=/synthetic ROI/.test(error.message);}
  return {rejected,state:App.project.__shareRoiState.status,
   range:App.getRoiDisplayRange(App.project.sections[0],'MSI_A').status,common:App.getCommonScaleStatus('MSI_A'),
   text:document.getElementById('roi-list').textContent};
 });
 assert.equal(failed.rejected,true,'explicit ROI consumers cannot treat failure as an empty roster');
 assert.equal(failed.state,'error');assert.equal(failed.range,'unavailable');assert.equal(failed.common,'failed');assert.doesNotMatch(failed.text,/No ROI yet/);
 await page.evaluate(()=>{__demand.failRois=false;});
 await page.locator('#roi-list button').click();
 await page.waitForFunction(()=>App.project.__shareRoiState.status==='ready');
 const recovered=await page.evaluate(async()=>{
  await ensureSharedRoisReady(App.project);const section=App.project.sections[0];
  await App.ensureRoiDisplayRange(section,'MSI_A');
  const range=App.getRoiDisplayRange(section,'MSI_A');
  return {ids:App.project.rois.map(roi=>roi.id),status:range.status,source:range.source,
   common:App.getCommonScaleStatus('MSI_A'),rawMax:section.msiSeries.MSI_A.rawTrueMax};
 });
 assert.deepEqual(recovered.ids,['roi-delayed']);assert.equal(recovered.status,'ready');assert.equal(recovered.source.max,60);
 assert.equal(recovered.common,'ready');assert.equal(recovered.rawMax,64,'ROI display never changes original source maxima');
 assert.deepEqual(await page.evaluate(()=>__demand.errors),[]);await context.close();
}

async function testLateMetadata(makePage,old,next,count){
 const {page,context}=await makePage();await install(page,old.doc);
 await page.evaluate(()=>{
  const state=__demand;state.docGate=new Promise(resolve=>state.releaseDoc=resolve);
  SupabaseClient.fetchProjectDoc=async()=>{
   const response=structuredClone(state.doc);
   if(response.id==='doc-old-demand'){state.oldDocRequested=true;await state.docGate;}
   return response; // Deliberately ignore AbortSignal: the generation guard must still reject this response.
  };
  state.oldHydration=state.hydrate(state.doc);
 });
 await page.waitForFunction(()=>__demand.oldDocRequested);
 await page.evaluate(doc=>{void __demand.hydrate(doc);},next.doc);
 await page.waitForFunction(()=>App.project?.id==='doc-new-demand'&&__demand.painted('doc-new-demand-s0'));
 await page.evaluate(async()=>{__demand.releaseDoc();await Promise.all([__demand.oldHydration,__demand.hydration]);});
 const result=await page.evaluate(()=>({id:App.project.id,panels:[...App.panels.keys()],errors:__demand.errors}));
 assert.equal(result.id,'doc-new-demand');assert.ok(result.panels.every(id=>id.startsWith('doc-new-demand-')));assert.deepEqual(result.errors,[]);
 assert.equal(count('doc-old-demand/source-0.csv'),0,'a rejected old document never starts original downloads');await context.close();
}

async function testLateRoiExpiry(makePage,old,next){
 const {page,context}=await makePage();await install(page,old.doc);
 await page.evaluate(()=>{
  const state=__demand;state.newRoiCalls=0;state.expiredGate=new Promise(resolve=>state.releaseExpired=resolve);
  SupabaseClient.listRois=async(_token,sectionId)=>{
   if(sectionId.startsWith('roi-old-demand-')){
    await state.expiredGate;throw Object.assign(new Error('invalid or expired token'),{code:'28000'});
   }
   state.newRoiCalls++;return [];
  };
  void state.hydrate(state.doc);
 });
 await page.waitForFunction(()=>App.project?.id==='roi-old-demand'&&__demand.painted('roi-old-demand-s0'));
 await page.evaluate(doc=>{__demand.oldRoiTask=App.project.__shareRoiState.promise;void __demand.hydrate(doc);},next.doc);
 await page.waitForFunction(()=>App.project?.id==='roi-new-demand'&&__demand.painted('roi-new-demand-s0')&&App.project.__shareRoiState.status==='ready');
 const result=await page.evaluate(async()=>{
  __demand.releaseExpired();await __demand.oldRoiTask;await __demand.hydration;
  const before=__demand.newRoiCalls;await App._refreshShareRois();
  return {id:App.project.id,expired:_shareTokenExpired,status:App.project.__shareRoiState.status,calls:__demand.newRoiCalls-before};
 });
 assert.equal(result.id,'roi-new-demand');assert.equal(result.expired,false,'old-session 28000 never expires the newly opened session');
 assert.equal(result.status,'ready');assert.equal(result.calls,next.doc.sections.length,'new project ROI polling remains usable');await context.close();
}

async function main(){
 const data=fixture('demand'),old=fixture('old-demand'),next=fixture('new-demand');
 const roi=fixture('roi-demand'),docOld=fixture('doc-old-demand'),docNext=fixture('doc-new-demand'),roiOld=fixture('roi-old-demand'),roiNext=fixture('roi-new-demand');
 const sources=Object.assign({},...[data,old,next,roi,docOld,docNext,roiOld,roiNext].map(value=>value.sources)),requests=[],writes=[],external=[],pageErrors=[];
 const gates=new Map();
 const hold=key=>{let release;const promise=new Promise(resolve=>release=resolve);gates.set(key,{promise,release});};
 const release=key=>{const gate=gates.get(key);if(gate){gates.delete(key);gate.release();}};
 const count=key=>requests.filter(item=>item===key).length;
 const server=createServer(async(req,res)=>{
  try{
   const pathname=decodeURIComponent(new URL(req.url,'http://fixture').pathname);
   if(!['GET','HEAD'].includes(req.method)){writes.push(pathname);res.writeHead(405);res.end();return;}
   if(pathname==='/runtime-config.js'){
    res.setHeader('Content-Type','text/javascript');res.end("Object.defineProperty(window,'DESI_BUILD_CONFIG',{value:Object.freeze({mode:'online',cloud:{url:location.origin,anonKey:'synthetic-key'}}),writable:false,configurable:false});");return;
   }
   if(pathname.startsWith('/original/')){
    const key=pathname.slice('/original/'.length),entry=sources[key];requests.push(key);
    if(!entry){res.writeHead(404);res.end();return;}
    const gate=gates.get(key);if(gate)await gate.promise;
    if(!res.destroyed){res.setHeader('Content-Type',entry.type);res.end(entry.bytes);}return;
   }
   const file=path.resolve(root,'.'+pathname+(pathname.endsWith('/')?'index.html':''));
   if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
   let bytes=await fs.readFile(file);
   if(pathname==='/viewer/index.html'||pathname==='/viewer/'){
    // Retain the real boot promise so fixtures cannot race pending init work.
    const hook="<script>{const boot=App.init;App.init=function(...args){const promise=boot.apply(this,args);window.__fixtureBoot=promise;promise.then(()=>window.__fixtureBootDone=true,error=>window.__fixtureBootError=error.message);return promise;};}</script>";
    bytes=Buffer.from(bytes.toString('utf8').replace('</body>',hook+'</body>'));
   }
   res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css'})[path.extname(file)]||'application/octet-stream');res.end(bytes);
  }catch(error){res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const makePage=async()=>{
   const context=await browser.newContext({viewport:{width:1600,height:1000}});
   await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(origin+'/')||/^(blob|data):/.test(url))return route.continue();external.push(url);return route.abort();});
   await context.addInitScript(()=>sessionStorage.setItem('desi:masterUnlocked',JSON.stringify({expiresAt:Date.now()+3600000})));
   const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>pageErrors.push(error.message));page.on('dialog',dialog=>dialog.accept());
   await page.goto(origin+'/viewer/?project=empty-demand-fixture');await page.waitForFunction(()=>window.__fixtureBootDone||window.__fixtureBootError);
   assert.equal(await page.evaluate(()=>window.__fixtureBootError),undefined);return {page,context};
  };
  const {page,context}=await makePage();await install(page,data.doc);
  const metadata=await page.evaluate(async()=>{
   const project=await App._loadSharedProject(__demand.session(__demand.doc));
   const entries=project.sections.flatMap(s=>[...Object.values(s.images),...Object.values(s.msiSeries),...Object.values(s.msiFiles)]);
   const result={sections:project.sections.length,ids:entries.map(e=>e.blobId),bytes:(await Promise.all(entries.map(e=>ProjectStorage.getBlob(e.blobId)))).filter(Boolean).length,
    sameSource:project.sections[0].msiSeries.MSI_A.blobId===project.sections[0].msiSeries.MSI_B.blobId};
   await project.__sourceLoader.dispose();await ProjectStorage.finishBlobLease(project.__blobLease);return result;
  });
  assert.equal(metadata.sections,2);assert.ok(metadata.ids.every(Boolean));assert.equal(metadata.bytes,0);assert.equal(metadata.sameSource,true);
  assert.deepEqual(requests,[],'metadata registration downloads no original');
  for(const key of ['demand/source-1.csv','demand/hidden.png','demand/unused.txt'])hold(key);
  await page.evaluate(()=>{void __demand.hydrate(__demand.doc);});
  await page.waitForFunction(()=>__demand.painted('demand-s0'));
  await page.waitForFunction(()=>__demand.hydrateDone&&SharePreview.isOpen());
  assert.equal(count('demand/source-0.csv'),1);
  for(const key of ['demand/source-1.csv','demand/hidden.png','demand/unused.txt'])assert.equal(count(key),0,'non-selected original stays unrequested: '+key);
  const values=await page.evaluate(async()=>{
   const panel=App.panels.get('demand-s0');await Promise.all([panel.ensureMsiLayerLoaded('MSI_A'),panel.ensureMsiLayerLoaded('MSI_B')]);
   return ['MSI_A','MSI_B'].map(key=>Array.from(panel.msiValueRasters.get(key).values));
  });
  assert.equal(count('demand/source-0.csv'),1,'two MRM features of one source fetch only once');
  assert.equal(Math.max(...values[0]),64);assert.equal(Math.max(...values[1]),192);
  for(const key of [...gates.keys()])release(key);
  const exported=await page.evaluate(async()=>{
   const project=App.project;
   const job=await ProjectArchive.beginExport(project,ProjectStorage,{currentProject:()=>App.project,
    ensureEntry:(entry,options)=>{options.assertCurrent();return project.__sourceLoader.ensure(entry,{signal:options.signal});},
    readMedia:async()=>{throw new Error('fixture has no media');}});
   try{
    const records={};for(const section of job.project.sections)for(const collection of ['images','msiSeries','msiFiles'])for(const entry of Object.values(section[collection]||{})){
     const record=await job.storage.getBlob(entry.blobId),digest=await crypto.subtle.digest('SHA-256',await record.blob.arrayBuffer());
     records[entry.storagePath]=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    }job.assertCurrent();return records;
   }finally{await job.close();}
  });
  for(const [key,entry] of Object.entries(data.sources)){assert.equal(exported[key],hash(entry.bytes),'snapshot retains exact original: '+key);assert.equal(count(key),1);}
  assert.deepEqual(await page.evaluate(()=>__demand.errors),[]);await context.close();

  const second=await makePage();await install(second.page,old.doc);hold('old-demand/source-0.csv');
  const oldRequest=second.page.waitForRequest(origin+'/original/old-demand/source-0.csv');
  await second.page.evaluate(()=>{void __demand.hydrate(__demand.doc);});
  await second.page.waitForFunction(()=>App.project?.id==='old-demand'&&App.panels.has('old-demand-s0'));
  await oldRequest;
  await second.page.evaluate(nextDoc=>{__demand.oldProject=App.project;__demand.oldPanel=App.panels.get('old-demand-s0');__demand.oldHydration=__demand.hydration;void __demand.hydrate(nextDoc);},next.doc);
  await second.page.waitForFunction(()=>App.project?.id==='new-demand'&&__demand.painted('new-demand-s0'));
  release('old-demand/source-0.csv');
  const switched=await second.page.evaluate(async()=>{
   await Promise.allSettled([__demand.oldHydration,__demand.hydration]);
   await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
   return {id:App.project.id,panels:[...App.panels.keys()],oldReady:__demand.oldPanel.isMsiLayerReady('MSI_A')};
  });
  assert.equal(switched.id,'new-demand');assert.ok(switched.panels.every(id=>id.startsWith('new-demand-')));assert.equal(switched.oldReady,false,'late old source never installs an obsolete raster');
  await second.context.close();
  await testRoiReadiness(makePage,roi);
  await testLateMetadata(makePage,docOld,docNext,count);
  await testLateRoiExpiry(makePage,roiOld,roiNext);
  assert.deepEqual(writes,[],'shared reads and export snapshots never write to the server');assert.deepEqual(external,[]);assert.deepEqual(pageErrors,[]);
  console.log('Shared source demand browser: metadata GET zero, selected-first Preview, source dedupe, exact export originals, stale source/document rejection, ROI pending/failure/retry and stale-session expiry guards PASS.');
 }finally{
  for(const key of [...gates.keys()])release(key);if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));
 }
}
main().catch(error=>{console.error(error.stack||error);process.exitCode=1;});
