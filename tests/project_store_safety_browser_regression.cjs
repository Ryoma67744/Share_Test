'use strict';
// Real IndexedDB, separate tabs, production manager/viewer storage wrappers.
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const moduleCode=fs.readFileSync(path.join(root,'project-store-safety.js'),'utf8');
function wrapper(file){const html=fs.readFileSync(path.join(root,file),'utf8'),start=html.indexOf('const ProjectStorage = (() => {');return html.slice(start,html.indexOf('\n})();',start)+6);}
const harness=kind=>`<!doctype html><meta charset="utf-8"><body><script src="/safety.js"></script><script>
const uid=prefix=>prefix+'_'+crypto.randomUUID();
${wrapper(kind==='manager'?'index.html':'viewer/index.html')}
window.storage=ProjectStorage;
window.recoveryUi=ProjectStoreSafety.mountRecoveryUi(storage);
window.addEventListener('project-storage-conflict',()=>recoveryUi.notify());
</script>`;
async function main(){
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/safety.js'?'text/javascript':'text/html; charset=utf-8');res.end(req.url==='/safety.js'?moduleCode:harness(req.url==='/manager'?'manager':'viewer'));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;let browser;
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH||undefined});
  const context=await browser.newContext(),a=await context.newPage(),b=await context.newPage(),errors=[];
  for(const p of [a,b])p.on('pageerror',e=>errors.push(e.message));
  // Seed DB4 before the real wrappers first open their connection.
  await a.route('**/seed',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>legacy</title>'}));await a.goto(origin+'/seed');
  await a.evaluate(()=>new Promise((resolve,reject)=>{const r=indexedDB.open('desi-projects',4);r.onupgradeneeded=()=>{for(const n of ['projects','project_index','blobs','pq_index'])r.result.createObjectStore(n,{keyPath:'id'});};r.onsuccess=()=>{const db=r.result,t=db.transaction(['projects','blobs'],'readwrite');t.objectStore('projects').put({id:'legacy',displayName:'Legacy project',sections:[{id:'s',images:{HE:{blobId:'original'}}}],rois:[]});t.objectStore('blobs').put({id:'original',blob:new Blob(['original bytes'])});t.oncomplete=()=>{db.close();resolve();};};r.onerror=()=>reject(r.error);}));
  await a.goto(origin+'/manager');await b.goto(origin+'/viewer');
  const initial=await a.evaluate(async()=>{window.edit=await storage.getProject('legacy');return {revision:edit.storageRevision,version:(await storage.open()).version};});
  assert.deepEqual(initial,{revision:0,version:5});
  assert.equal(await b.evaluate(()=>new Promise(resolve=>{const r=indexedDB.open('desi-projects',4);r.onerror=()=>resolve(r.error.name);r.onsuccess=()=>{r.result.close();resolve('opened');};})),'VersionError','old fixed-version writers fenced');
  await b.evaluate(async()=>{window.edit=await storage.getProject('legacy');edit.displayName='B with NEG';edit.sections.push({id:'neg',msiFiles:{N:{blobId:'negative'}}});await storage.putBlob({id:'negative',blob:new Blob(['negative bytes'])});});
  await a.evaluate(async()=>{edit.displayName='A POS';await storage.putProject(edit);});
  const conflict=await b.evaluate(async()=>{try{await storage.putProject(edit);return null;}catch(e){return {code:e.code,recovered:e.recovered};}});assert.deepEqual(conflict,{code:'LOCAL_PROJECT_CONFLICT',recovered:true});
  assert.equal(await a.evaluate(async()=>(await storage.getProject('legacy')).displayName),'A POS');
  assert.equal(await b.evaluate(()=>storage.deleteBlob('negative')),false);
  // Closing a conflicted tab does not discard the editing branch or its sources.
  await b.close();const c=await context.newPage();await c.goto(origin+'/viewer');await c.locator('#local-recovery-button').waitFor({state:'visible'});await c.locator('#local-recovery-button').click();
  await c.getByRole('button',{name:'別コピーとして復元'}).click();await c.getByRole('button',{name:'閉じる',exact:true}).click();
  const copies=await c.evaluate(()=>storage.listProjects());assert.equal(copies.length,2);const recovered=copies.find(p=>p.id!=='legacy');
  assert.equal(await c.evaluate(async id=>(await storage.getProject(id)).sections.length,recovered.id),2);assert.equal(await c.evaluate(async()=>(await storage.getBlob('negative')).blob.text()),'negative bytes');
  // A deleted project cannot be recreated by another open tab.
  await a.evaluate(async()=>{window.stale=await storage.getProject('legacy');});await c.evaluate(()=>storage.deleteProject('legacy',{expectedRevision:1}));
  assert.equal(await a.evaluate(async()=>{try{await storage.putProject(stale);}catch(e){return e.code;}}),'LOCAL_PROJECT_CONFLICT');assert.equal(await c.evaluate(()=>storage.getProject('legacy')),null);
  // Live job pins remain until explicit release, including across a fresh tab.
  await c.evaluate(async()=>{await storage.putBlob({id:'job-only',blob:new Blob(['pinned'])});await storage.pinBlobs('export-job',['job-only'],{kind:'zip-export'});await storage.pruneShareOrphans();});
  assert.equal(await c.evaluate(async()=>(await storage.getBlob('job-only')).blob.text()),'pinned');
  await c.evaluate(()=>storage.releaseBlobPins('export-job'));assert.equal(await c.evaluate(()=>storage.deleteBlob('job-only')),true);
  // One tab deletes a project while another still edits it: originals remain
  // pinned before the stale save has had a chance to create a recovery draft.
  await c.evaluate(async()=>{await storage.putBlob({id:'active-original',blob:new Blob(['only original'])});await storage.putProject({id:'active-project',displayName:'Active',sections:[{images:{HE:{blobId:'active-original'}}}]},{createOnly:true});});
  await a.evaluate(async()=>{window.active=await storage.getProject('active-project',{activate:true});});
  await c.evaluate(()=>storage.deleteProject('active-project',{expectedRevision:1}));
  assert.equal(await c.evaluate(async()=>(await storage.getBlob('active-original')).blob.text()),'only original');
  assert.equal(await c.evaluate(async()=>(await storage.listRecoveries()).filter(r=>r.kind==='editing-session').length),0,'live editing locks hide sessions from recovery/discard UI');
  await a.evaluate(async()=>{active.displayName='Stale edit survives';try{await storage.putProject(active);}catch(e){if(e.code!=='LOCAL_PROJECT_CONFLICT')throw e;}});
  const draft=await c.evaluate(async()=>(await storage.listRecoveries()).find(r=>r.projectId==='active-project'));
  const restored=await c.evaluate(id=>storage.restoreRecovery(id),draft.id);assert.equal(restored.displayName,'Stale edit survives (recovered)');
  assert.equal(await c.evaluate(async()=>(await storage.getBlob('active-original')).blob.text()),'only original');
  // No timer releases a crashed tab's pin. A new tab can explicitly recover or discard it.
  await a.close();await c.waitForFunction(async()=> (await storage.listRecoveries()).some(r=>r.kind==='editing-session'));const sessions=await c.evaluate(()=>storage.listRecoveries());const session=sessions.find(r=>r.kind==='editing-session');assert.ok(session);
  await c.evaluate(id=>storage.discardRecovery(id),session.id);assert.equal(await c.evaluate(async()=>(await storage.getBlob('active-original')).blob.text()),'only original','discard retains the restored copy original');
  assert.deepEqual(errors,[]);
  console.log('Project store safety browser regression: PASS (DB4 upgrade, two tabs, durable recovery UI, deletion fence, pins)');
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
