'use strict';
// Real IndexedDB + Web Locks, running the production cloud import/load methods.
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'viewer/index.html'),'utf8').replace(/\r\n/g,'\n');
const moduleCode=fs.readFileSync(path.join(root,'project-store-safety.js'),'utf8');
const refreshCode=fs.readFileSync(path.join(root,'viewer/share-refresh.js'),'utf8');
const start=html.indexOf('const ProjectStorage = (() => {'),wrapper=html.slice(start,html.indexOf('\n})();',start)+6);
function method(name){const at=html.indexOf('    async '+name+'(');assert.ok(at>=0,name);return html.slice(at,html.indexOf('\n    },',at)+6);}
function helper(name){let at=html.indexOf('function '+name+'(');assert.ok(at>=0,name);if(html.slice(at-6,at)==='async ')at-=6;return html.slice(at,html.indexOf('\n}',at)+2);}
const harness=`<!doctype html><meta charset="utf-8"><title>Cloud load lease fixture</title><script src="/safety.js"></script><script src="/share-refresh.js"></script><script>
const uid=p=>p+'_'+crypto.randomUUID(),nowIso=()=>new Date().toISOString();
${wrapper}
window.storage=ProjectStorage;
const _shareAlignBySection=new Map(),captureSectionAlignment=()=>({}),loadShareOverlays=()=>[],_overlaysFromSections=()=>[];
const ensureMemoShape=x=>x||{},roiMediaRegistryFromDoc=()=>({version:1,items:[]}),groupRoiRowsByColor=()=>[],remapRoiGeometry=x=>x;
let _shareTokenExpired=false;const _isExpiredTokenError=e=>e.code==='28000',_noteShareTokenExpired=()=>{_shareTokenExpired=true;};
${helper('fetchAllShareRois')}
${fs.readFileSync(path.join(root,'viewer/msi-ratio-model.js'),'utf8')}
${helper('ratioRegistryFromDoc')}
window.alerts=[];const roiMediaForTransport=()=>({items:[]}),showToast=()=>{},alert=message=>alerts.push(message);
const doc={publish_revision:7,meta:{display_name:'Synthetic cloud',project_meta:{}},sections:[{id:'server-s',meta:{client_id:'local-s'},storage_paths:{
images:{HE:{path:'fixture/he',filename:'HE.tif'}},msiSeries:{MSI_A:{path:'fixture/raw',filename:'raw.txt',kind:'txt',sourceFileId:'raw',archiveProvenance:{version:1,basis:'registered-source'}}},
msiFiles:{raw:{path:'fixture/raw',filename:'raw.txt',kind:'txt',registeredAt:'2026-11-04T00:00:00Z'}}}}]};
const SupabaseClient={configured:()=>true,fetchProjectDoc:async()=>structuredClone(doc),publicUrl:(_bucket,p)=>'/'+p,
listRois:async()=>{if(window.roiReadFailure)throw new Error('synthetic ROI read failure');return [];}};
const App={_openImportSession:async slug=>({slug,token:'synthetic-read-token'}),
${method('_importProjectFromServer')},
${method('_buildLocalProjectFromDoc')},
${method('_loadSharedProject')},
};
window.app=App;window.ready=true;window.pageShows=[];addEventListener('pageshow',e=>pageShows.push(e.persisted));
const originalPut=storage.putBlob;storage.putBlob=async(...args)=>{const result=await originalPut(...args);if(window.pauseNextWrite){window.pauseNextWrite=false;window.pausedBlob=result;await new Promise(r=>window.resumeWrite=r);}return result;};
window.loadShared=async()=>{window.shared=await app._loadSharedProject({slug:'fixture',token:'synthetic-read-token'});return [...Object.values(shared.sections[0].images),...Object.values(shared.sections[0].msiSeries)].map(x=>x.blobId);};
</script>`;
async function main(){
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://fixture');if(url.pathname==='/safety.js'||url.pathname==='/share-refresh.js'){res.setHeader('Content-Type','text/javascript');res.end(url.pathname==='/safety.js'?moduleCode:refreshCode);}else if(url.pathname.startsWith('/fixture/')){res.setHeader('Content-Type','text/plain');res.end('original '+url.pathname);}else if(url.pathname==='/away'){res.end('<!doctype html><title>Away</title>');}else{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(harness);}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{
  // Full Chromium's headless mode reports renderer crashes reliably on Windows;
  // the separate chromium-headless-shell executable may not emit that event.
  browser=await chromium.launch({headless:true,channel:'chromium',executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage(),errors=[];
  for(const p of [a,b]){p.on('pageerror',e=>{errors.push(e.message);console.error('fixture page error:',e.message);});await p.goto(origin+'/viewer');await p.waitForFunction(()=>window.ready);}
  await a.evaluate(()=>{window.pauseNextWrite=true;window.importJob=app._importProjectFromServer('fixture');});
  await a.waitForFunction(()=>window.pausedBlob);const first=await a.evaluate(()=>pausedBlob);
  await b.evaluate(()=>loadShared());
  assert.equal(await b.evaluate(async id=>(await storage.getBlob(id)).blob.text(),first),'original /fixture/he','other shared tab prune retains suspended import');
  await a.evaluate(()=>resumeWrite());const imported=await a.evaluate(()=>importJob);
  assert.equal(await b.evaluate(async id=>(await storage.getProject(id)).shareInfo.serverRevision,imported),7);
  assert.equal(await b.evaluate(async id=>(await storage.getProject(id)).__importFailures,imported),undefined);
  assert.equal(await b.evaluate(async id=>(await storage.getProject(id)).sections[0].msiSeries.MSI_A.archiveProvenance.basis,imported),'registered-source');
  await b.evaluate(()=>storage.pruneShareOrphans());assert.ok(await b.evaluate(id=>storage.getBlob(id),first),'project owns committed bytes after lease removal');
  // A failed ROI read can produce a separate inspectable copy, but never an
  // apparently complete publish baseline. The marker must survive the actual
  // createOnly IDB commit, another tab's read, and reloading the importing tab.
  const partialId=await a.evaluate(async()=>{window.roiReadFailure=true;try{return await app._importProjectFromServer('fixture');}finally{window.roiReadFailure=false;}});
  assert.ok(partialId);assert.notEqual(partialId,imported);
  const partial=await b.evaluate(id=>storage.getProject(id),partialId);
  assert.equal(partial.__importFailures,1);assert.equal(partial.shareInfo.serverRevision,null);
  assert.deepEqual(partial.rois,[]);assert.ok(partial.sections[0].msiSeries.MSI_A.blobId);
  assert.match(await a.evaluate(()=>alerts.at(-1)),/別コピー.*1 件/);
  await a.reload();await a.waitForFunction(()=>window.ready);
  assert.equal(await a.evaluate(async id=>(await storage.getProject(id)).__importFailures,partialId),1,'Reload retains incomplete-import protection');
  assert.equal(await a.evaluate(async id=>(await storage.getProject(id)).shareInfo.serverRevision,partialId),null);
  assert.equal(await b.evaluate(async id=>(await storage.getProject(id)).shareInfo.serverRevision,imported),7,'Original complete local copy remains unchanged');
  await b.evaluate(id=>storage.deleteProject(id),partialId);
  const aIds=await a.evaluate(()=>loadShared()),bIds=await b.evaluate(()=>loadShared());
  for(const id of aIds)assert.ok(await b.evaluate(id=>storage.getBlob(id),id),'second shared tab must not delete first shared cache');
  const aLeaseId=await a.evaluate(()=>shared.__blobLease.id);
  assert.equal(await b.evaluate(async id=>{try{await storage.finishBlobLease({id});}catch(e){return e.code;}},aLeaseId),'BLOB_LEASE_OWNER');
  assert.equal(await b.evaluate(async id=>{try{await storage.releaseBlobPins(id);}catch(e){return e.code;}},aLeaseId),'BLOB_LEASE_OWNER');
  await a.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
  await b.evaluate(()=>storage.pruneShareOrphans());for(const id of aIds)assert.ok(await b.evaluate(id=>storage.getBlob(id),id),'BFCache pagehide retains its lifetime lease');
  // Abort before createOnly commit: only this import's own bytes are reclaimed.
  const aborted=await a.evaluate(async()=>{const build=app._buildLocalProjectFromDoc;let ids=[];app._buildLocalProjectFromDoc=async(...args)=>{const p=await build.apply(app,args);ids=Object.values(p.sections[0].images).map(x=>x.blobId);throw new Error('synthetic abort before commit');};try{await app._importProjectFromServer('fixture');}catch(e){if(!/synthetic abort/.test(e.message))throw e;}finally{app._buildLocalProjectFromDoc=build;}return ids;});
  for(const id of aborted)assert.equal(await b.evaluate(id=>storage.getBlob(id),id),null);
  for(const id of aIds)assert.ok(await b.evaluate(id=>storage.getBlob(id),id));
  assert.equal((await b.evaluate(()=>storage.listProjects())).length,1);
  // Abort actual IndexedDB transactions, after add() was queued: neither the
  // blob nor its pin may commit, and a failed project commit keeps no new copy.
  const writeFailure=await a.evaluate(async()=>{
   const lease=await storage.beginBlobLease({kind:'cloud-import'}),original=IDBObjectStore.prototype.add;
   let message='';
   IDBObjectStore.prototype.add=function(...args){const result=original.apply(this,args);if(this.name==='blobs')this.transaction.abort();return result;};
   try{await storage.putBlob({id:'synthetic-aborted-idb-write',blob:new Blob(['must roll back'])},{lease});}catch(e){message=e.name;}
   finally{IDBObjectStore.prototype.add=original;}
   const db=await storage.open(),row=await new Promise((resolve,reject)=>{const req=db.transaction('blob_pins','readonly').objectStore('blob_pins').get(lease.id);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
   await storage.finishBlobLease(lease);return {message,pinned:row.blobIds};
  });
  assert.ok(writeFailure.message);assert.deepEqual(writeFailure.pinned,[]);assert.equal(await b.evaluate(()=>storage.getBlob('synthetic-aborted-idb-write')),null);
  const commitFailure=await a.evaluate(async()=>{
   const originalAdd=IDBObjectStore.prototype.add,originalPut=storage.putBlob,ids=[];let message='',result;
   storage.putBlob=async(...args)=>{const id=await originalPut(...args);ids.push(id);return id;};
   IDBObjectStore.prototype.add=function(...args){const result=originalAdd.apply(this,args);if(this.name==='projects')this.transaction.abort();return result;};
   try{result=await app._importProjectFromServer('fixture');}catch(e){message=e.name;}
   finally{IDBObjectStore.prototype.add=originalAdd;storage.putBlob=originalPut;}
   return {message,ids,result,alert:alerts.at(-1)};
  });
  assert.equal(commitFailure.result,null);assert.match(commitFailure.alert,/IDB 保存失敗/);assert.ok(commitFailure.ids.length>0);
  for(const id of commitFailure.ids)assert.equal(await b.evaluate(id=>storage.getBlob(id),id),null,'failed createOnly commit releases only this load originals');
  assert.equal((await b.evaluate(()=>storage.listProjects())).length,1);assert.ok(await b.evaluate(id=>storage.getBlob(id),first));
  // Closing a tab halfway through an import releases its Web Lock, with no
  // partial project ever committed and no effect on another live shared view.
  const closing=await context.newPage();await closing.goto(origin+'/viewer');await closing.waitForFunction(()=>window.ready);
  await closing.evaluate(()=>{window.pauseNextWrite=true;window.importJob=app._importProjectFromServer('fixture');});await closing.waitForFunction(()=>window.pausedBlob);
  const closingBlob=await closing.evaluate(()=>pausedBlob);await b.evaluate(()=>storage.pruneShareOrphans());assert.ok(await b.evaluate(id=>storage.getBlob(id),closingBlob));
  await closing.close();await b.waitForFunction(async id=>{await storage.pruneShareOrphans();return !(await storage.getBlob(id));},closingBlob);
  assert.equal((await b.evaluate(()=>storage.listProjects())).length,1);
  // Browser-driven back/forward: if retained, bytes must remain; if ineligible,
  // the page reloads and obtains a new lease. Never release on pagehide.
  await a.goto(origin+'/away');await b.evaluate(()=>storage.pruneShareOrphans());await a.goBack();await a.waitForFunction(()=>window.ready);
  const restored=await a.evaluate(()=>!!window.shared);
  if(restored){for(const id of aIds)assert.ok(await b.evaluate(id=>storage.getBlob(id),id),'restored BFCache page retains its originals');}
  else await a.evaluate(()=>loadShared());
  // Reload destroys the previous realm/lock; stale caches can then be reclaimed.
  const reloadIds=await a.evaluate(()=>Object.values(shared.sections[0].images).map(x=>x.blobId));await a.reload();await a.waitForFunction(()=>window.ready);
  await b.evaluate(()=>storage.pruneShareOrphans());for(const id of reloadIds)assert.equal(await b.evaluate(id=>storage.getBlob(id),id),null);
  const crashIds=await a.evaluate(()=>loadShared());await a.bringToFront();const cdp=await context.newCDPSession(a),crash=a.waitForEvent('crash');cdp.send('Page.crash').catch(()=>{});await crash;
  await b.waitForFunction(async()=>await storage.reclaimInactiveBlobLeases()>0);
  for(const id of crashIds)assert.equal(await b.evaluate(id=>storage.getBlob(id),id),null,'only crashed owner cache is reclaimed');
  for(const id of bIds)assert.ok(await b.evaluate(id=>storage.getBlob(id),id),'surviving tab retains its cache');
  assert.ok(await b.evaluate(id=>storage.getBlob(id),first),'persisted import survives all cleanup');
  assert.deepEqual(errors,[]);
  console.log('Blob load lease browser regression: PASS (suspended import vs share, incomplete ROI import survives IDB/reload, two shared tabs, real IDB write/commit abort, owner checks, BFCache '+(restored?'restored':'reload fallback')+', reload and renderer crash)');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
