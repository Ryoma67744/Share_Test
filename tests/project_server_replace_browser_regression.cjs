'use strict';
// Production storage boundary, real IndexedDB/Web Locks, two independent tabs.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {chromium}=require('playwright');
const moduleCode=fs.readFileSync(path.join(__dirname,'../project-store-safety.js'),'utf8');
const pageHtml=`<!doctype html><meta charset="utf-8"><script src="/store.js"></script><script>
window.ready=(async()=>{
 const opening=indexedDB.open('replace-fixture',ProjectStoreSafety.VERSION);
 opening.onupgradeneeded=()=>ProjectStoreSafety.upgrade(opening.result);
 const db=await new Promise((resolve,reject)=>{opening.onsuccess=()=>resolve(opening.result);opening.onerror=()=>reject(opening.error);});
 window.store=ProjectStoreSafety.create({locks:navigator.locks,transaction:(names,mode)=>{
  const tx=db.transaction(names,mode);
  if((window.abortAtLeaseRemoval||window.editAtLeaseRemoval)&&mode==='readwrite'){
   const edit=window.editAtLeaseRemoval;window.abortAtLeaseRemoval=false;window.editAtLeaseRemoval=false;const original=tx.objectStore.bind(tx);let aborted=false;
   tx.objectStore=name=>{const object=original(name);if(name==='blob_pins'){
    const remove=object.delete.bind(object);object.delete=id=>{const request=remove(id);if(String(id).startsWith('load:'))request.addEventListener('success',()=>{if(!aborted){aborted=true;if(edit)window.liveEditChanged=true;else tx.abort();}});return request;};
   }return object;};
  }return tx;
 },indexRowFor:p=>({id:p.id,displayName:p.displayName,storageRevision:p.storageRevision,shared:!!p.shareInfo})});
 window.readAll=async()=>{
  const names=['projects','project_index','project_recovery','blob_pins','blobs'];
  const rows=await new Promise((resolve,reject)=>{const tx=db.transaction(names,'readonly'),out={};for(const name of names){const r=tx.objectStore(name).getAll();r.onsuccess=()=>out[name]=r.result;}tx.oncomplete=()=>resolve(out);tx.onabort=()=>reject(tx.error);});
  rows.blobs=await Promise.all(rows.blobs.map(async row=>({id:row.id,text:await row.blob.text()})));return rows;
 };
 window.seed=async id=>{await store.putBlob({id:id+'-old',blob:new Blob(['original '+id])});
  await store.putProject({id,displayName:'Before '+id,sections:[{id:'old-section',images:{HE:{blobId:id+'-old'}}}],rois:[{id:'roi'}],meta:{},shareInfo:{slug:id,serverRevision:3}},{createOnly:true});
 };
 window.prepare=async(id,label)=>{const lease=await store.beginBlobLease({kind:'cloud-import',projectId:id});
  await store.putBlob({id:id+'-'+label,blob:new Blob(['server '+label])},{lease});
  window.job={id,lease,incoming:{id:'download-'+label,displayName:'Server '+label,sections:[{images:{HE:{blobId:id+'-'+label}}}],rois:[],meta:{},shareInfo:{slug:id,serverRevision:4}}};
 };
 window.apply=async()=>{try{const result=await store.replaceProjectFromServer(job.id,job.incoming,{expectedRevision:1,expectedServerRevision:4,lease:job.lease});return {ok:true,result};}catch(error){return {ok:false,code:error.code,name:error.name};}};
})();</script>`;
async function main(){
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/store.js'?'text/javascript':'text/html; charset=utf-8');res.end(req.url==='/store.js'?moduleCode:pageHtml);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage(),errors=[];
  for(const page of [a,b]){page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port);await page.evaluate(()=>ready);}
  await a.evaluate(async()=>{await store.setRecoveryEnabled(false);await seed('race');await prepare('race','A');});
  await b.evaluate(()=>prepare('race','B'));
  const results=await Promise.all([a.evaluate(()=>apply()),b.evaluate(()=>apply())]);
  assert.equal(results.filter(r=>r.ok).length,1,'exactly one transaction may accept expected revision 1');
  assert.equal(results.find(r=>!r.ok).code,'LOCAL_PROJECT_CONFLICT');
  const winner=results.find(r=>r.ok).result,rows=await a.evaluate(()=>readAll());
  assert.equal(rows.projects.length,2);assert.equal(rows.project_index.length,2);
  const backup=rows.projects.find(p=>p.id===winner.backupProject.id),current=rows.projects.find(p=>p.id==='race');
  assert.equal(current.storageRevision,2);assert.equal(backup.shareInfo,undefined);assert.equal(backup.sections[0].images.HE.blobId,'race-old');
  assert.equal(rows.project_recovery.length,0);assert.equal(rows.blobs.find(row=>row.id==='race-old').text,'original race');
  assert.equal(await a.evaluate(()=>store.finishBlobLease(job.lease)),!results[0].ok);
  assert.equal(await b.evaluate(()=>store.finishBlobLease(job.lease)),!results[1].ok);
  const finalRows=await a.evaluate(()=>readAll());assert.equal(finalRows.blob_pins.length,0);assert.equal(finalRows.blobs.length,2,'only accepted server original and backup original survive');

  // Abort after backup and replacement writes, when the download lease is removed.
  await a.evaluate(async()=>{await seed('abort');await prepare('abort','download');});
  const before=await a.evaluate(()=>readAll());
  await a.evaluate(()=>{window.abortAtLeaseRemoval=true;});
  const failed=await a.evaluate(()=>apply());assert.equal(failed.ok,false);
  assert.deepEqual(await a.evaluate(()=>readAll()),before,'real transaction abort must restore old record, backup/index absence, lease and bytes');
  const retry=await a.evaluate(()=>apply());assert.equal(retry.ok,true,'the owned lease remains usable after aborted commit');
  assert.equal(retry.result.project.id,'abort');assert.equal(retry.result.project.storageRevision,2);
  assert.equal(await a.evaluate(()=>store.finishBlobLease(job.lease)),false);
  await a.evaluate(async()=>{await seed('memory-edit');await prepare('memory-edit','download');});
  const beforeEdit=await a.evaluate(()=>readAll());
  const guarded=await a.evaluate(async()=>{
   window.editAtLeaseRemoval=true;window.liveEditChanged=false;
   try{await store.replaceProjectFromServer(job.id,job.incoming,{expectedRevision:1,expectedServerRevision:4,lease:job.lease,
    assertCurrent(){if(window.liveEditChanged)throw new Error('Unsaved edit changed during commit');}});return false;}
   catch(error){return /Unsaved edit/.test(error.message);}
  });
  assert.equal(guarded,true,'a live unsaved edit invalidates an in-progress replacement');
  assert.deepEqual(await a.evaluate(()=>readAll()),beforeEdit,'the late UI guard rolls back backup, project, index and lease together');
  await a.evaluate(()=>store.finishBlobLease(job.lease));
  await a.reload();await a.evaluate(()=>ready);
  assert.equal((await a.evaluate(()=>store.getProject('abort'))).displayName,'Server download','committed replacement survives reload');
  assert.equal((await a.evaluate(id=>store.getProject(id),retry.result.backupProject.id)).displayName.startsWith('Before abort'),true,'independent backup survives reload with recovery OFF');
  assert.deepEqual(errors,[]);
  console.log('Project server replace browser regression: PASS (real two-tab CAS, recovery-OFF backup, late transaction abort, lease reuse/cleanup, reload)');
 }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
